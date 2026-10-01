// Main-window controller: documents, tab/group tree, session restore and the save model.
//
// Save rules (sub-plan 05, save folder 2026-10-01):
//   note (untitled or TrayNote) -> autosaved to the app store 500 ms after typing stops, never dirty,
//                                and copied to a real file in the default save folder
//                                (Settings > Saving; Documents\Notepad 2.0) named after its title
//   file on disk              -> NOT autosaved by default. Dirty dot, Ctrl+S writes. Unsaved edits
//                                are mirrored to recovery/<id>.json so a crash loses nothing.
//   file, autosave on         -> global setting or per-group override, atomic write after the delay
// Opening a file never writes it.

import { signal, computed, batch, effect } from '@preact/signals';
import type { EditorState } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import { openSearchPanel, closeSearchPanel, searchPanelOpen, findNext, findPrevious } from '@codemirror/search';
import { undo, redo, selectAll } from '@codemirror/commands';
import { platform, FILE_TYPES } from '../platform';
import { decodeBytes, encodeText, fitsAnsi, type Encoding, type Eol } from '../lib/encoding';
import { parseLaunchArgs } from '../lib/notepad-args';
import { noteTitle } from '../lib/note-title';
export { noteTitle };
import * as T from '../lib/tree-ops';
import type { TreeNode, GroupNode, GroupColor, DropPosition } from '../lib/tree-ops';
import { isMarkdownPath } from '../markdown/pipeline';
import { settings, updateSettings, loadSettings, applyRemoteSettings, migrateMdView, type MdView, type PaperMode, type Settings } from './settings';
import { createEditorState, reconfigureEffects, setUpdateHandler, type ViewConfig } from '../editor/setup';
import { ask, alertMsg, cursorInfo, showToast, settingsOpen } from './ui';
import { visualApi } from '../editor/visual/sync';
import { copyName } from '../lib/copy-name';
import { sessionKey, windowTitle } from '../lib/transfer';
import { viewKindFor, isBinaryKind, hasViewPane, MAX_PREVIEW_BYTES, type ViewerKind } from '../lib/view-kind';
import type { Extension } from '@codemirror/state';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { codeHighlight, cSyntax } from '../editor/setup';
import { logHighlighter } from '../editor/log-lang';
import { toCsv } from '../lib/csv';
import { nextTabsMode } from '../lib/tabs-modes';
import * as P from '../lib/panes';
import type { PaneId, PaneState } from '../lib/panes';
import { Transaction } from '@codemirror/state';

/** True when the active tab is showing the Visual (WYSIWYG) editor. */
export function inVisual(): boolean {
  const d = activeDoc.value;
  return !!d && !d.viewer && d.language === 'markdown' && activeView(d) === 'visual' && !!visualApi.editor;
}

export type Banner = { kind: 'external' | 'restored' | 'missing' | 'error' | 'mixed-eol' | 'readonly'; text: string };

export interface DocMeta {
  id: string;
  kind: 'note' | 'file';
  quick?: boolean;
  path: string | null;
  customTitle?: string;
  title: string;
  encoding: Encoding;
  bom: boolean;
  eol: Eol;
  language: 'plain' | 'markdown';
  mdView: MdView;
  paper?: PaperMode;
  dirty: boolean;
  mtime: number;
  readonly: boolean;
  created: number;
  modified: number;
  cursor?: number;
  scrollTop?: number;
  banner?: Banner | null;
  /** Tab colour (same palette as groups). */
  color?: GroupColor;
  /** How the file is shown (unset: the text / Markdown editor). */
  viewer?: ViewerKind;
  /** File size in bytes (binary tabs). */
  size?: number;
  /** Bumped when a binary file changes on disk, so its viewer reloads. */
  rev?: number;
  /** When it was last written to disk (a file's save, or a note's copy in the save folder). */
  savedAt?: number;
  /** A note's file in the default save folder (kept up to date as you type). */
  savedPath?: string;
}

export interface ClosedNote {
  id: string;
  title: string;
  modified: number;
  quick?: boolean;
  savedPath?: string;
}

interface SessionFile {
  version: 1;
  tree: TreeNode[];
  activeId: string | null;
  docs: DocMeta[];
  closedNotes: ClosedNote[];
  recentFiles: string[];
  /** Split view: on/off, divider, each pane's document (per window). */
  split?: PaneState;
}

export const QUICK_GROUP_ID = 'grp-quick-notes';
export const TRAY_GROUP_NAME = 'TrayNotes';

export const docs = signal<Record<string, DocMeta>>({});
export const tree = signal<TreeNode[]>([]);
export const activeId = signal<string | null>(null);
export const closedNotes = signal<ClosedNote[]>([]);
export const recentFiles = signal<string[]>([]);
export const ready = signal(false);
/** Bumps on every edit or tab switch; the preview re-renders from it. */
export const editTick = signal(0);

/** Notes with typing not yet written (amber dot). */
export const pendingNotes = signal<ReadonlySet<string>>(new Set());
function markPending(id: string, on: boolean) {
  const cur = pendingNotes.value;
  if (cur.has(id) === on) return;
  const next = new Set(cur);
  if (on) next.add(id);
  else next.delete(id);
  pendingNotes.value = next;
}

/** Green (everything written to disk) or amber (edits not saved yet), and when it was last saved. */
export function saveState(d: DocMeta): { saved: boolean; at: number | null } {
  if (d.kind === 'note') return { saved: !pendingNotes.value.has(d.id) && (!!d.savedPath || !textOf(d.id).trim()), at: d.savedAt ?? null };
  return { saved: !d.dirty, at: d.savedAt ?? (d.mtime || null) };
}

export const activeDoc = computed(() => (activeId.value ? docs.value[activeId.value] ?? null : null));
export const orderedIds = computed(() => T.flattenNotes(tree.value).filter((id) => docs.value[id]));

const states = new Map<string, EditorState>();
/** Highlighting for data files, kept so a reload or tab switch keeps it. */
const syntaxes = new Map<string, Extension>();
let view: EditorView | null = null;

// ---------------------------------------------------------------- split view
// `view` is always the active pane's editor, so every command acts on the active pane. The other
// pane has its own editor that only ever shows text: edits to a document shown on both sides are
// forwarded to it (not added to its undo history).

/** Which document each pane shows, which pane is active, the divider position. */
export const panes = signal<PaneState>(P.SINGLE);
const paneViews: Record<PaneId, EditorView | null> = { a: null, b: null };

/** The view mode the active pane shows for `d` (a pane's own override when both sides show `d`). */
export function activeView(d: DocMeta): MdView {
  const s = panes.value;
  return d.id === s.docs[s.active] ? P.viewFor(s, s.active, d.mdView) : d.mdView;
}

/** The document the inactive pane shows (null when split view is off). */
function otherDoc(): string | null {
  const s = panes.value;
  return s.on ? s.docs[P.other(s.active)] : null;
}

/** Highlighting for a data file's source: logs get level colours, others their language. */
async function syntaxFor(path: string, viewer: ViewerKind | undefined): Promise<Extension> {
  if (!viewer || viewer === 'text' || isBinaryKind(viewer)) return [];
  if (/\.log$/i.test(path)) return logHighlighter();
  const desc = LanguageDescription.matchFilename(languages, basename(path));
  if (!desc) return [];
  try {
    return [await desc.load(), codeHighlight];
  } catch {
    return [];
  }
}

export function uid(prefix = 'n'): string {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}
export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : p;
}

export function textOf(id: string): string {
  if (view && activeId.value === id) return view.state.doc.toString();
  return states.get(id)?.doc.toString() ?? '';
}

export function effectivePaper(d: DocMeta | null): PaperMode {
  const s = settings.value;
  return (s.paperPerTab && d?.paper) || s.paper;
}

function viewConfig(d: DocMeta | null): ViewConfig {
  return { paper: effectivePaper(d), settings: settings.value };
}

function patchDoc(id: string, patch: Partial<DocMeta>) {
  const d = docs.value[id];
  if (!d) return;
  docs.value = { ...docs.value, [id]: { ...d, ...patch } };
}

function addDoc(d: DocMeta, text: string, syntax?: Extension) {
  if (syntax) syntaxes.set(d.id, syntax);
  states.set(d.id, createEditorState(text, d.language === 'markdown', d.readonly, viewConfig(d), syntaxes.get(d.id)));
  docs.value = { ...docs.value, [d.id]: d };
}

// ---------------------------------------------------------------- editor binding

/** A pane's editor mounted (or unmounted, with null). */
export function attachPaneView(pane: PaneId, v: EditorView | null) {
  if (paneViews[pane] && view === paneViews[pane]) view = null;
  paneViews[pane] = v;
  if (pane === panes.value.active) {
    view = v;
    if (v && activeId.value) showInView(activeId.value);
  } else if (v) showInOtherPane();
}

/** The inactive pane shows its document (a separate copy of the text when it is the active one). */
function showInOtherPane() {
  const s = panes.value;
  if (!s.on) return;
  const p = P.other(s.active);
  const v = paneViews[p];
  let id = s.docs[p];
  if (!id || !docs.value[id]) {
    id = activeId.value;
    if (!id) return;
    panes.value = { ...panes.value, docs: { ...panes.value.docs, [p]: id } };
  }
  if (!v) return;
  const d = docs.value[id];
  const live = view && view === paneViews[s.active] ? view.state : null;
  const base = id === activeId.value && live ? live : states.get(id);
  if (!base) return;
  // The same document on both sides: a separate copy (own cursor and undo), kept in step by
  // forwarding edits. A different document: its stored state.
  const st = id === activeId.value ? createEditorState(base.doc.toString(), d.language === 'markdown', d.readonly, viewConfig(d), syntaxes.get(id)) : base;
  v.setState(st);
  v.dispatch({ effects: reconfigureEffects(viewConfig(d), d.language === 'markdown', d.readonly) });
}

/** Make `pane` the active one: commands, the toolbar and tab clicks now go to it. */
export function focusPane(pane: PaneId) {
  const s = panes.value;
  if (!s.on || s.active === pane) return;
  stashActive();
  panes.value = P.focus(s, pane);
  view = paneViews[pane];
  const id = panes.value.docs[pane];
  activeId.value = id && docs.value[id] ? id : null;
  updateCursorInfo();
  editTick.value++;
  updateWindowTitle();
  scheduleSession();
}

/** Split view on or off (Ctrl+\). */
export function toggleSplit() {
  stashActive();
  const next = P.toggle(panes.value, orderedIds.value);
  panes.value = next;
  if (!next.on) {
    view = paneViews.a;
    const id = next.docs.a;
    if (id && docs.value[id]) {
      activeId.value = id;
      showInView(id);
    }
  } else showInOtherPane();
  editTick.value++;
  scheduleSession();
}

export function setSplitRatio(r: number) {
  panes.value = P.setRatio(panes.value, r);
  scheduleSession();
}

/** A view change made from a pane's view switch. */
export function setPaneView(pane: PaneId, v: MdView) {
  focusPane(pane);
  const s = panes.value;
  const id = s.docs[pane] ?? (pane === s.active ? activeId.value : null);
  if (!id) return;
  if (P.setView(s, pane) === 'override') {
    visualApi.flush();
    panes.value = { ...s, override: { ...s.override, [pane]: v } };
    editTick.value++;
    scheduleSession();
  } else setMdView(id, v);
}


export function getView() {
  return view;
}

function stashActive() {
  visualApi.flush();
  const id = activeId.value;
  if (view && id && docs.value[id]) {
    states.set(id, view.state);
    patchDoc(id, { cursor: view.state.selection.main.head, scrollTop: view.scrollDOM.scrollTop });
  }
}

function showInView(id: string) {
  if (!view) return;
  const d = docs.value[id];
  const st = states.get(id);
  if (!d || !st) return;
  view.setState(st);
  view.dispatch({ effects: reconfigureEffects(viewConfig(d), d.language === 'markdown', d.readonly) });
  const top = d.scrollTop ?? 0;
  requestAnimationFrame(() => {
    if (view && activeId.value === id) view.scrollDOM.scrollTop = top;
  });
  updateCursorInfo();
  editTick.value++;
  if (!settingsOpen.value) view.focus();
}

export function refreshView() {
  const d = activeDoc.value;
  if (view && d) view.dispatch({ effects: reconfigureEffects(viewConfig(d), d.language === 'markdown', d.readonly) });
  const s = panes.value;
  const ov = s.on ? paneViews[P.other(s.active)] : null;
  const od = s.on ? docs.value[s.docs[P.other(s.active)] ?? ''] : null;
  if (ov && od) ov.dispatch({ effects: reconfigureEffects(viewConfig(od), od.language === 'markdown', od.readonly) });
}

function updateCursorInfo() {
  if (!view) return;
  const st = view.state;
  const head = st.selection.main.head;
  const line = st.doc.lineAt(head);
  let selected = 0;
  for (const r of st.selection.ranges) selected += r.to - r.from;
  cursorInfo.value = { line: line.number, col: head - line.from + 1, chars: st.doc.length, selected };
}

setUpdateHandler((u: ViewUpdate) => {
  // Only the active pane edits; the other pane's editor just follows.
  if (u.view !== view) return;
  if (u.docChanged) {
    const s = panes.value;
    const ov = s.on ? paneViews[P.other(s.active)] : null;
    if (ov && s.docs[P.other(s.active)] === activeId.value) {
      if (ov.state.doc.length !== u.startState.doc.length) showInOtherPane();
      else for (const tr of u.transactions) if (tr.docChanged) ov.dispatch({ changes: tr.changes, annotations: Transaction.addToHistory.of(false) });
    }
  }
  if (u.selectionSet || u.docChanged) updateCursorInfo();
  if (u.docChanged && activeId.value) {
    onEdited(activeId.value);
    editTick.value++;
  }
});

// ---------------------------------------------------------------- activation

export function activate(id: string) {
  if (!docs.value[id]) return;
  if (activeId.value === id) {
    view?.focus();
    return;
  }
  stashActive();
  // Reveal the tab: expand any collapsed ancestors.
  let t = tree.value;
  for (const g of T.ancestors(t, id)) if (g.collapsed) t = T.update(t, g.id, { collapsed: false });
  batch(() => {
    tree.value = t;
    activeId.value = id;
    panes.value = P.loadInto(panes.value, id);
    settingsOpen.value = false;
  });
  showInView(id);
  const od = otherDoc();
  if (panes.value.on && (!od || !docs.value[od])) showInOtherPane();
  updateWindowTitle();
  scheduleSession();
}

export function updateWindowTitle() {
  const d = activeDoc.value;
  const name = d ? displayTitle(d) : 'Untitled';
  platform.setTitle(windowTitle(`${d?.dirty ? '*' : ''}${name} - Notepad 2.0`, platform.windowLabel, windowCountRef.value)).catch(() => {});
}

/** Set by state/windows.ts (kept here as a plain holder to avoid an import cycle). */
export const windowCountRef = { value: 1 };
/** Set once this window has merged into another: its session must not be written again. */
export const windowClosing = { value: false };

export function displayTitle(d: DocMeta): string {
  return d.customTitle || d.title;
}

// ---------------------------------------------------------------- creating / opening

/** A new file goes to the end of the active file's group, or the end of the ungrouped files. */
function placeNewNode(id: string, near: string | null) {
  const node: TreeNode = { id, kind: 'note' };
  const parent = near ? T.find(tree.value, near)?.parent : null;
  if (parent && parent.system !== 'quick-notes') {
    tree.value = T.insert(tree.value, node, parent.id, parent.children.length);
  } else {
    tree.value = [...tree.value, node]; // normalised to the end of the ungrouped section
  }
}

// Ungrouped files always sit above the groups, whatever changed the tree.
effect(() => {
  const t = tree.value;
  const n = T.normalizeLooseFirst(t);
  if (n !== t) tree.value = n;
});

export function newNote(opts: { text?: string; groupId?: string | null; activate?: boolean; language?: 'plain' | 'markdown' } = {}): string {
  const now = Date.now();
  const language = opts.language ?? (settings.value.mdForTxt ? 'markdown' : 'plain');
  const id = uid('note');
  const text = opts.text ?? '';
  addDoc(
    {
      id, kind: 'note', path: null, title: noteTitle(text), encoding: 'utf-8', bom: false, eol: 'crlf',
      language, mdView: language === 'markdown' ? 'visual' : 'edit', dirty: false, mtime: 0,
      readonly: false, created: now, modified: now,
    },
    text,
  );
  if (opts.groupId) {
    const g = T.find(tree.value, opts.groupId);
    tree.value = T.insert(tree.value, { id, kind: 'note' }, opts.groupId, g && g.node.kind === 'group' ? g.node.children.length : 0);
  } else if (opts.groupId === null) {
    tree.value = [...tree.value, { id, kind: 'note' }]; // explicitly Ungrouped
  } else placeNewNode(id, activeId.value);
  if (text) persistNote(id);
  if (opts.activate !== false) activate(id);
  scheduleSession();
  return id;
}

export function findOpenFile(path: string): string | null {
  const p = path.toLowerCase();
  for (const d of Object.values(docs.value)) if (d.path && d.path.toLowerCase() === p) return d.id;
  return null;
}

function addRecent(path: string) {
  recentFiles.value = [path, ...recentFiles.value.filter((p) => p.toLowerCase() !== path.toLowerCase())].slice(0, 12);
}

/** Open files as tabs; returns the id of the last one opened (or already open). */
export async function openFiles(paths: string[], opts: { groupId?: string } = {}): Promise<string | null> {
  let last: string | null = null;
  for (const path of paths) {
    const existing = findOpenFile(path);
    if (existing) {
      last = existing;
      continue;
    }
    const elsewhere = await platform.windowWithFile(path).catch(() => null);
    if (elsewhere) {
      await platform.emitTo(elsewhere, 'focus-file', path);
      await platform.focusWindow(elsewhere);
      continue;
    }
    try {
      let viewer = viewKindFor(path);
      if (viewer !== 'text') {
        const st = await platform.stat(path);
        if (!st.exists) throw new Error('The system cannot find the file specified.');
        // Too big to parse into a grid / tree / page: open the text itself, highlighted.
        if (hasViewPane(viewer) && st.size > MAX_PREVIEW_BYTES) viewer = 'code';
        // Shown straight from the file (the viewer says when it is too large): no text is read.
        if (isBinaryKind(viewer)) {
          const id = uid('file');
          addDoc(
            {
              id, kind: 'file', path, title: basename(path), encoding: 'utf-8', bom: false, eol: 'crlf', language: 'plain', mdView: 'visual',
              dirty: false, mtime: st.mtime, readonly: true, created: st.created || st.mtime, modified: st.mtime, size: st.size, banner: null, viewer,
            },
            '',
          );
          if (opts.groupId) tree.value = T.insert(tree.value, { id, kind: 'note' }, opts.groupId, 9999);
          else placeNewNode(id, last ?? activeId.value);
          addRecent(path);
          last = id;
          continue;
        }
      }
      const f = await platform.readFile(path);
      const dec = decodeBytes(f.bytes);
      const md = viewer === 'text' && (isMarkdownPath(path) || (settings.value.mdForTxt && /\.txt$/i.test(path)));
      const id = uid('file');
      const now = Date.now();
      const big = f.bytes.length > 5 * 1024 * 1024;
      addDoc(
        {
          id, kind: 'file', path, title: basename(path), encoding: dec.encoding, bom: dec.bom, eol: dec.eol,
          language: md ? 'markdown' : 'plain', mdView: hasViewPane(viewer) ? 'visual' : md && !big ? settings.value.mdDefaultView : 'edit', dirty: false,
          mtime: f.mtime, readonly: f.readonly, created: f.created || now, modified: now, viewer: viewer === 'text' ? undefined : viewer,
          banner: dec.mixedEol
            ? { kind: 'mixed-eol', text: `This file mixes line endings. Saving will use ${dec.eol.toUpperCase()} throughout.` }
            : f.readonly
              ? { kind: 'readonly', text: 'This file is read-only. Use Save as to keep your changes.' }
              : null,
        },
        dec.text,
        await syntaxFor(path, viewer),
      );
      if (opts.groupId) tree.value = T.insert(tree.value, { id, kind: 'note' }, opts.groupId, 9999);
      else placeNewNode(id, last ?? activeId.value);
      addRecent(path);
      last = id;
    } catch (e) {
      await alertMsg('Notepad 2.0', `Couldn't open ${path}\n\n${String(e)}`);
    }
  }
  if (last) activate(last);
  scheduleSession();
  return last;
}

export async function openWithDialog() {
  const paths = await platform.openDialog();
  if (paths.length) await openFiles(paths);
}

// ---------------------------------------------------------------- editing & persistence

const noteTimers = new Map<string, ReturnType<typeof setTimeout>>();
const fileTimers = new Map<string, ReturnType<typeof setTimeout>>();

function onEdited(id: string) {
  const d = docs.value[id];
  if (!d || isBinaryKind(d.viewer)) return;
  const now = Date.now();
  if (d.kind === 'note') {
    const title = noteTitle(view && activeId.value === id ? view.state.doc.sliceString(0, 2000) : textOf(id).slice(0, 2000));
    if (title !== d.title) patchDoc(id, { title, modified: now });
    else patchDoc(id, { modified: now });
    clearTimeout(noteTimers.get(id));
    markPending(id, true);
    noteTimers.set(id, setTimeout(() => persistNote(id), 500));
  } else {
    if (!d.dirty) {
      patchDoc(id, { dirty: true, modified: now });
      updateWindowTitle();
    }
    clearTimeout(fileTimers.get(id));
    const auto = T.effectiveAutosave(tree.value, id, settings.value.autosaveFiles) && !d.readonly;
    fileTimers.set(
      id,
      setTimeout(() => (auto ? saveDoc(id, { silent: true }) : persistRecovery(id)), auto ? settings.value.autosaveDelayMs : 1000),
    );
  }
  scheduleSession();
}

async function persistNote(id: string) {
  noteTimers.delete(id);
  const d = docs.value[id];
  if (!d || d.kind !== 'note') return;
  const text = textOf(id);
  markPending(id, true);
  await platform.storeWrite(`notes/${id}.md`, text);
  if (d.quick) platform.emit('note-updated', { id, text, from: platform.windowLabel }).catch(() => {});
  await mirrorNote(id, text);
  if (!noteTimers.has(id)) markPending(id, false);
}

// ---------------------------------------------------------------- the default save folder

/** Documents\Notepad 2.0 unless Settings > Saving picks another folder. */
export async function saveFolderPath(): Promise<string> {
  const s = settings.value.saveFolder.trim();
  if (s) return s.replace(/[\\/]+$/, '');
  const docsDir = (await platform.documentsDir().catch(() => '')).replace(/[\\/]+$/, '');
  const sep = docsDir.includes('/') && !docsDir.includes('\\') ? '/' : '\\';
  return docsDir ? `${docsDir}${sep}Notepad 2.0` : 'Notepad 2.0';
}

/** A note title as a file name stem: no characters Windows refuses, at most 60 characters. */
export function fileStem(title: string): string {
  let s = title.replace(/[\\/:*?"<>|…\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `_${s}`;
  return s || 'Untitled';
}

const joinPath = (folder: string, name: string) => folder + (folder.includes('/') && !folder.includes('\\') ? '/' : '\\') + name;
const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** `name` in `folder`, or "Name (2).ext" etc. when taken (by a file on disk or another note). */
async function freePath(folder: string, name: string, own: string | null): Promise<string> {
  const claimed = new Set(Object.values(docs.value).map((x) => x.savedPath?.toLowerCase()).filter(Boolean));
  const taken = async (n: string) => {
    const p = joinPath(folder, n);
    if (own && samePath(p, own)) return false;
    return claimed.has(p.toLowerCase()) || (await platform.stat(p)).exists;
  };
  if (!(await taken(name))) return joinPath(folder, name);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const c = `${stem} (${n})${ext}`;
    if (!(await taken(c))) return joinPath(folder, c);
  }
}

const mirrorQueue = new Map<string, Promise<void>>();
/** Write a note's copy in the save folder (one write at a time per note). */
function mirrorNote(id: string, text: string): Promise<void> {
  const job = (mirrorQueue.get(id) ?? Promise.resolve()).then(() => writeMirror(id, text)).catch((e) => {
    patchDoc(id, { banner: { kind: 'error', text: `Couldn't save to the save folder: ${String(e)}` } });
  });
  mirrorQueue.set(id, job);
  return job;
}

async function writeMirror(id: string, text: string) {
  const d = docs.value[id];
  if (!d || d.kind !== 'note') return;
  if (!text.trim() && !d.savedPath) return; // nothing worth a file yet
  const folder = await saveFolderPath();
  const want = `${fileStem(displayTitle(d))}.${d.language === 'markdown' ? 'md' : 'txt'}`;
  let path = d.savedPath && samePath(dirname(d.savedPath), folder) ? d.savedPath : null;
  // The title changed: rename the file to match (never over another file).
  if (path && text.trim() && !samePath(basename(path), want) && !basename(path).toLowerCase().startsWith(want.replace(/\.[^.]+$/, '').toLowerCase() + ' (')) {
    const target = await freePath(folder, want, path);
    if (!samePath(target, path)) {
      try {
        await platform.renameFile(path, target);
        path = target;
      } catch {
        /* keep the old name */
      }
    }
  }
  if (!path) path = await freePath(folder, want, null);
  await platform.writeFile(path, encodeText(text, 'utf-8', false, d.eol));
  const at = Date.now();
  patchDoc(id, { savedPath: path, savedAt: at, ...(d.banner?.kind === 'error' ? { banner: null } : {}) });
  platform.emit('note-saved', { id, path, at }).catch(() => {});
  scheduleSession();
}

/** One-time: notes kept inside the app get their copy in the save folder (the originals stay). */
async function copyNotesToFolder() {
  if (settings.value.notesCopiedToFolder) return;
  let n = 0;
  for (const d of Object.values(docs.value)) {
    if (d.kind !== 'note' || d.savedPath) continue;
    const text = textOf(d.id);
    if (!text.trim()) continue;
    await mirrorNote(d.id, text);
    if (docs.value[d.id]?.savedPath) n++;
  }
  updateSettings({ notesCopiedToFolder: true });
  if (n) showToast(`Copied ${n} note${n === 1 ? '' : 's'} to ${await saveFolderPath()}`);
}

/** The badged file-type icons (TXT / MD / CSV / SHEET) arrived 2026-10-01: if Notepad 2.0 is
 * already registered with Windows, register once more so Explorer picks them up. */
const FILE_ICONS_VERSION = 1;
async function refreshFileIcons() {
  if (platform.kind !== 'tauri' || platform.windowLabel !== 'main' || settings.value.fileIconsVersion >= FILE_ICONS_VERSION) return;
  try {
    const st = await platform.integrationState();
    if (st.supported && st.registered) await platform.registerFileTypes(FILE_TYPES);
    updateSettings({ fileIconsVersion: FILE_ICONS_VERSION });
  } catch {
    /* try again next start */
  }
}

/** Folders your open files live in, with how many files each holds (Settings > Saving). */
export function fileLocations(): { folder: string; count: number }[] {
  const by = new Map<string, { folder: string; count: number }>();
  for (const d of Object.values(docs.value)) {
    const p = d.kind === 'file' ? d.path : d.savedPath;
    if (!p) continue;
    const f = dirname(p);
    const k = f.toLowerCase();
    const e = by.get(k) ?? { folder: f, count: 0 };
    e.count++;
    by.set(k, e);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder));
}

async function persistRecovery(id: string) {
  fileTimers.delete(id);
  const d = docs.value[id];
  if (!d || d.kind !== 'file') return;
  if (!d.dirty) {
    await platform.storeDelete(`recovery/${id}.json`);
    return;
  }
  await platform.storeWrite(
    `recovery/${id}.json`,
    JSON.stringify({ path: d.path, baseMtime: d.mtime, text: textOf(id), encoding: d.encoding, bom: d.bom, eol: d.eol }),
  );
}

/** What the session stores for a tab: binary tabs only their path and view state. */
export function sessionDoc(d: DocMeta): DocMeta {
  if (isBinaryKind(d.viewer)) return { ...d, dirty: false, banner: null };
  return { ...d, banner: d.banner?.kind === 'restored' ? d.banner : null };
}

let sessionTimer: ReturnType<typeof setTimeout> | undefined;
/** Write this window's session now (the receiving side of a move does this before replying). */
export async function saveSessionNow() {
  clearTimeout(sessionTimer);
  await saveSession();
}

export function scheduleSession() {
  if (!ready.value) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(saveSession, 800);
}

async function saveSession() {
  if (windowClosing.value) return;
  stashActiveMetaOnly();
  const s: SessionFile = {
    version: 1,
    tree: tree.value,
    activeId: activeId.value,
    docs: Object.values(docs.value).map(sessionDoc),
    closedNotes: closedNotes.value,
    recentFiles: recentFiles.value,
    split: panes.value,
  };
  await platform.storeWrite(sessionKey(platform.windowLabel), JSON.stringify(s));
}

function stashActiveMetaOnly() {
  const id = activeId.value;
  if (view && id && docs.value[id]) {
    const d = docs.value[id];
    const cursor = view.state.selection.main.head;
    const scrollTop = view.scrollDOM.scrollTop;
    if (d.cursor !== cursor || d.scrollTop !== scrollTop) docs.value = { ...docs.value, [id]: { ...d, cursor, scrollTop } };
  }
}

/** Write everything pending right now (before hide / quit). */
export async function flushAll() {
  visualApi.flush();
  const jobs: Promise<unknown>[] = [];
  for (const [id, t] of noteTimers) {
    clearTimeout(t);
    jobs.push(persistNote(id));
  }
  for (const [id, t] of fileTimers) {
    clearTimeout(t);
    const auto = T.effectiveAutosave(tree.value, id, settings.value.autosaveFiles);
    jobs.push(auto ? saveDoc(id, { silent: true }) : persistRecovery(id));
  }
  clearTimeout(sessionTimer);
  jobs.push(saveSession());
  await Promise.allSettled(jobs);
}

// ---------------------------------------------------------------- saving

export async function saveDoc(id: string, opts: { silent?: boolean } = {}): Promise<boolean> {
  visualApi.flush();
  const d = docs.value[id];
  if (!d) return false;
  const saver = binarySavers.get(id);
  if (saver) {
    try {
      const mtime = await saver();
      if (mtime == null) return false;
      patchDoc(id, { mtime, dirty: false, savedAt: Date.now(), banner: null });
      updateWindowTitle();
      scheduleSession();
      if (!opts.silent && d.path) showToast(`Saved ${basename(d.path)}`);
      return true;
    } catch (e) {
      await alertMsg('Notepad 2.0', `Couldn't save ${d.path}\n\n${String(e)}`);
      return false;
    }
  }
  if (isBinaryKind(d.viewer)) {
    if (!opts.silent) showToast('This file is shown read-only.');
    return false;
  }
  if (d.kind === 'note' || !d.path || d.readonly) return saveDocAs(id);
  fileTimers.delete(id);
  const text = textOf(id);
  if (d.encoding === 'windows-1252' && !fitsAnsi(text) && !opts.silent) {
    const r = await ask({
      title: 'Notepad 2.0',
      body: 'This file contains characters that ANSI can’t store. Save as UTF-8 instead so nothing is lost?',
      buttons: [
        { label: 'Save as UTF-8', value: 'utf8', primary: true },
        { label: 'Save as ANSI anyway', value: 'ansi' },
        { label: 'Cancel', value: 'cancel' },
      ],
    });
    if (r.value === 'cancel' || r.value === null) return false;
    if (r.value === 'utf8') patchDoc(id, { encoding: 'utf-8', bom: false });
  }
  const cur = docs.value[id];
  try {
    const mtime = await platform.writeFile(cur.path!, encodeText(text, cur.encoding, cur.bom, cur.eol));
    // Only clear dirty if nothing was typed while writing.
    const still = textOf(id) === text;
    patchDoc(id, { mtime, dirty: !still, savedAt: Date.now(), banner: cur.banner?.kind === 'readonly' ? cur.banner : null });
    if (still) await platform.storeDelete(`recovery/${id}.json`);
    updateWindowTitle();
    scheduleSession();
    if (!opts.silent) showToast(`Saved ${basename(cur.path!)}`);
    return true;
  } catch (e) {
    if (opts.silent) {
      patchDoc(id, { banner: { kind: 'error', text: `Autosave failed: ${String(e)}` } });
      await persistRecovery(id);
      return false;
    }
    await alertMsg('Notepad 2.0', `Couldn't save ${cur.path}\n\n${String(e)}`);
    return false;
  }
}

/** Editable spreadsheets register how to write their workbook (returns the new mtime, or null). */
export const binarySavers = new Map<string, () => Promise<number | null>>();

/** The sheet editor's edits mark its tab unsaved (amber dot, asks before closing). */
export function setBinaryDirty(id: string, dirty: boolean) {
  const d = docs.value[id];
  if (!d || d.dirty === dirty) return;
  patchDoc(id, { dirty, modified: Date.now() });
  updateWindowTitle();
}

/** Replace a text tab's whole text as one edit (the CSV grid writes its rows back this way). */
export function replaceDocText(id: string, text: string) {
  const d = docs.value[id];
  if (!d || textOf(id) === text) return;
  if (view && activeId.value === id) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    return;
  }
  const st = states.get(id);
  if (!st) return;
  states.set(id, st.update({ changes: { from: 0, to: st.doc.length, insert: text } }).state);
  onEdited(id);
  editTick.value++;
}

/** "Create new: Sheet": a blank workbook in the save folder, opened in the sheet editor. */
export async function newSheetFile(groupId?: string): Promise<string | null> {
  const { blankXlsx } = await import('../sheet/xlsx-io');
  const folder = await saveFolderPath();
  const path = await freePath(folder, 'Untitled sheet.xlsx', null);
  await platform.writeFile(path, await blankXlsx());
  return openFiles([path], groupId ? { groupId } : {});
}

export async function saveDocAs(id: string): Promise<boolean> {
  visualApi.flush();
  const d = docs.value[id];
  if (!d) return false;
  if (isBinaryKind(d.viewer)) {
    showToast('This file is shown read-only.');
    return false;
  }
  const md = d.language === 'markdown';
  const suggested = d.path
    ? md && !isMarkdownPath(d.path) ? basename(d.path).replace(/(\.[^.]*)?$/, '.md') : basename(d.path)
    : `${displayTitle(d).replace(/[\\/:*?"<>|…]/g, '').slice(0, 60) || 'Untitled'}.${md ? 'md' : 'txt'}`;
  const path = await platform.saveDialog(suggested, md);
  if (!path) return false;
  const text = textOf(id);
  try {
    const mtime = await platform.writeFile(path, encodeText(text, d.encoding, d.bom, d.eol));
    const wasNote = d.kind === 'note';
    const becomesMd = isMarkdownPath(path);
    patchDoc(id, {
      kind: 'file', quick: false, path, title: basename(path), customTitle: undefined, mtime, dirty: false, readonly: false,
      banner: null, language: becomesMd ? 'markdown' : d.language, savedAt: Date.now(), savedPath: undefined,
    });
    markPending(id, false);
    if (wasNote) await platform.storeDelete(`notes/${id}.md`);
    await platform.storeDelete(`recovery/${id}.json`);
    addRecent(path);
    refreshView();
    updateWindowTitle();
    scheduleSession();
    showToast(`Saved ${basename(path)}`);
    return true;
  } catch (e) {
    await alertMsg('Notepad 2.0', `Couldn't save ${path}\n\n${String(e)}`);
    return false;
  }
}

export async function saveAll() {
  for (const d of Object.values(docs.value)) if (d.kind === 'file' && d.dirty) await saveDoc(d.id);
}

// ---------------------------------------------------------------- closing

/** Returns false if the user cancelled. */
export async function closeDoc(id: string, opts: { skipPrompt?: boolean } = {}): Promise<boolean> {
  visualApi.flush();
  const d = docs.value[id];
  if (!d) return true;
  if (d.kind === 'file' && d.dirty && !opts.skipPrompt) {
    // Show the file being asked about: its own pane in split view, else load it.
    const s0 = panes.value;
    const shownIn = s0.on ? (['a', 'b'] as const).find((p) => s0.docs[p] === id) : undefined;
    if (shownIn) focusPane(shownIn);
    else activate(id);
    const r = await ask({
      title: 'Notepad 2.0',
      body: `Do you want to save changes to ${d.path ?? displayTitle(d)}?`,
      buttons: [
        { label: 'Save', value: 'save', primary: true },
        { label: "Don't save", value: 'discard' },
        { label: 'Cancel', value: 'cancel' },
      ],
    });
    if (r.value === 'cancel' || r.value === null) return false;
    if (r.value === 'save' && !(await saveDoc(id))) return false;
  }
  const text = textOf(id);
  clearTimeout(fileTimers.get(id));
  fileTimers.delete(id);
  if (d.kind === 'note') {
    clearTimeout(noteTimers.get(id));
    noteTimers.delete(id);
    markPending(id, false);
    if (!text.trim() && settings.value.deleteEmptyNotesOnClose) {
      await platform.storeDelete(`notes/${id}.md`);
      // Its copy in the save folder: emptied, then removed (only ever an empty file is deleted).
      if (d.savedPath) {
        await mirrorQueue.get(id);
        await platform.writeFile(d.savedPath, new Uint8Array()).then(() => platform.deleteIfEmpty(d.savedPath!)).catch(() => {});
      }
    } else {
      await platform.storeWrite(`notes/${id}.md`, text);
      await mirrorNote(id, text);
      const saved = docs.value[id]?.savedPath ?? d.savedPath;
      closedNotes.value = [{ id, title: displayTitle(d), modified: d.modified, quick: d.quick, savedPath: saved }, ...closedNotes.value.filter((c) => c.id !== id)];
    }
  } else {
    await platform.storeDelete(`recovery/${id}.json`);
  }
  // Neighbour to activate: next visible tab, else previous.
  const order = orderedIds.value;
  const idx = order.indexOf(id);
  const next = order[idx + 1] ?? order[idx - 1] ?? null;
  const { [id]: _gone, ...rest } = docs.value;
  batch(() => {
    tree.value = T.remove(tree.value, id).tree;
    docs.value = rest;
    if (activeId.value === id) activeId.value = null;
  });
  states.delete(id);
  syntaxes.delete(id);
  const nextOk = next && rest[next] ? next : null;
  const otherBefore = otherDoc();
  if (panes.value.on) panes.value = P.onRemoved(panes.value, [id], () => nextOk);
  if (activeId.value === null) {
    const want = panes.value.on ? panes.value.docs[panes.value.active] : nextOk;
    if (want && rest[want]) activate(want);
    else newNote();
  }
  if (panes.value.on && otherDoc() !== otherBefore) showInOtherPane();
  scheduleSession();
  return true;
}

export async function closeOthers(id: string) {
  for (const other of orderedIds.value) if (other !== id && !(await closeDoc(other))) return;
}

export async function closeGroup(groupId: string) {
  const loc = T.find(tree.value, groupId);
  if (!loc || loc.node.kind !== 'group') return;
  for (const id of T.flattenNotes([loc.node])) if (!(await closeDoc(id))) return;
  const g = T.find(tree.value, groupId);
  if (g && !(g.node as GroupNode).system) tree.value = T.remove(tree.value, groupId).tree;
  scheduleSession();
}

export async function reopenNote(id: string) {
  const c = closedNotes.value.find((n) => n.id === id);
  const text = (await platform.storeRead(`notes/${id}.md`)) ?? '';
  const now = Date.now();
  addDoc(
    {
      id, kind: 'note', quick: c?.quick, path: null, title: noteTitle(text), customTitle: c?.title !== noteTitle(text) ? c?.title : undefined,
      encoding: 'utf-8', bom: false, eol: 'crlf', language: 'plain', mdView: 'edit', dirty: false, mtime: 0, readonly: false,
      created: now, modified: c?.modified ?? now, savedPath: c?.savedPath, savedAt: c?.savedPath ? c.modified : undefined,
    },
    text,
  );
  if (c?.quick) {
    ensureQuickGroup();
    tree.value = T.insert(tree.value, { id, kind: 'note' }, QUICK_GROUP_ID, 0);
  } else placeNewNode(id, activeId.value);
  closedNotes.value = closedNotes.value.filter((n) => n.id !== id);
  activate(id);
}

export async function deleteClosedNote(id: string) {
  await platform.storeDelete(`notes/${id}.md`);
  closedNotes.value = closedNotes.value.filter((n) => n.id !== id);
  scheduleSession();
}

// ---------------------------------------------------------------- external changes

export async function checkExternalChanges() {
  for (const d of Object.values(docs.value)) {
    if (d.kind !== 'file' || !d.path) continue;
    try {
      const st = await platform.stat(d.path);
      if (!st.exists) {
        if (d.banner?.kind !== 'missing')
          patchDoc(d.id, { banner: { kind: 'missing', text: 'This file was moved or deleted outside Notepad 2.0. Save to recreate it.' } });
        continue;
      }
      if (st.mtime > d.mtime + 1) {
        if (isBinaryKind(d.viewer) && d.dirty) patchDoc(d.id, { banner: { kind: 'external', text: 'This workbook changed on disk. Reload loses your unsaved edits; Keep mine saves over it on the next save.' } });
        else if (isBinaryKind(d.viewer)) patchDoc(d.id, { mtime: st.mtime, size: st.size, rev: (d.rev ?? 0) + 1, banner: null });
        else if (!d.dirty) await reloadDoc(d.id, true);
        else patchDoc(d.id, { banner: { kind: 'external', text: 'This file changed on disk.' } });
      }
    } catch {
      /* ignore */
    }
  }
}

export async function reloadDoc(id: string, silent = false) {
  visualApi.flush();
  const d = docs.value[id];
  if (!d?.path) return;
  if (isBinaryKind(d.viewer)) {
    const s = await platform.stat(d.path);
    patchDoc(id, { mtime: s.mtime, size: s.size, rev: (d.rev ?? 0) + 1, banner: null, dirty: false });
    updateWindowTitle();
    return;
  }
  const f = await platform.readFile(d.path);
  const dec = decodeBytes(f.bytes);
  const st = createEditorState(dec.text, d.language === 'markdown', f.readonly, viewConfig(d), syntaxes.get(id));
  states.set(id, st);
  patchDoc(id, { mtime: f.mtime, dirty: false, encoding: dec.encoding, bom: dec.bom, eol: dec.eol, readonly: f.readonly, banner: null });
  await platform.storeDelete(`recovery/${id}.json`);
  if (activeId.value === id && view) {
    const top = view.scrollDOM.scrollTop;
    view.setState(st);
    view.scrollDOM.scrollTop = top;
    updateCursorInfo();
    editTick.value++;
  }
  if (panes.value.on && panes.value.docs[P.other(panes.value.active)] === id) showInOtherPane();
  updateWindowTitle();
  if (!silent) showToast('Reloaded from disk');
}

export function keepMine(id: string) {
  const d = docs.value[id];
  if (!d) return;
  // Accept the disk version's timestamp so we stop nagging; the next save overwrites it.
  platform.stat(d.path!).then((st) => patchDoc(id, { mtime: st.mtime, banner: null }));
}

export function dismissBanner(id: string) {
  patchDoc(id, { banner: null });
}

export async function discardRestored(id: string) {
  const d = docs.value[id];
  if (d?.kind === 'file') await reloadDoc(id, true);
  else dismissBanner(id);
}

// ---------------------------------------------------------------- per-document settings

export function setEncoding(id: string, encoding: Encoding, bom: boolean) {
  const d = docs.value[id];
  if (!d) return;
  patchDoc(id, { encoding, bom, dirty: d.kind === 'file' ? true : d.dirty });
  updateWindowTitle();
  scheduleSession();
}

export function setEol(id: string, eol: Eol) {
  const d = docs.value[id];
  if (!d) return;
  patchDoc(id, { eol, dirty: d.kind === 'file' ? true : d.dirty, banner: d.banner?.kind === 'mixed-eol' ? null : d.banner });
  updateWindowTitle();
  scheduleSession();
}

export function setLanguage(id: string, language: 'plain' | 'markdown') {
  const d = docs.value[id];
  if (!d) return;
  patchDoc(id, { language, mdView: language === 'plain' ? 'edit' : d.mdView === 'edit' ? settings.value.mdDefaultView : d.mdView });
  if (activeId.value === id) refreshView();
  scheduleSession();
}

export function setDocColor(id: string, color: GroupColor | null) {
  patchDoc(id, { color: color ?? undefined });
  scheduleSession();
}

export async function convertToMarkdown(id: string) {
  const d = docs.value[id];
  if (!d) return;
  setLanguage(id, 'markdown');
  if (d.kind === 'file' && d.path && !isMarkdownPath(d.path)) {
    const r = await ask({
      title: 'Convert to Markdown',
      body: 'Also save a Markdown (.md) copy of this file? The original stays as it is.',
      buttons: [{ label: 'Save as .md…', value: 'save', primary: true }, { label: 'Not now', value: 'no' }],
    });
    if (r.value === 'save') await saveDocAs(id);
  }
}

export function setMdView(id: string, mdView: MdView) {
  const d = docs.value[id];
  if (!d) return;
  // Data files switch View / Source / Split; only text tabs turn into Markdown.
  if (!d.viewer && d.language !== 'markdown') patchDoc(id, { language: 'markdown' });
  patchDoc(id, { mdView });
  if (activeId.value === id) refreshView();
  scheduleSession();
}

export function cycleMdView() {
  const d = activeDoc.value;
  if (!d) return;
  const order: MdView[] = ['visual', 'edit', 'split'];
  const next = order[(order.indexOf(activeView(d)) + 1) % 3];
  if (d.viewer) {
    if (hasViewPane(d.viewer)) setPaneView(panes.value.active, next);
    return;
  }
  if (d.language !== 'markdown') return setMdView(d.id, 'visual');
  setPaneView(panes.value.active, next);
}

/** Set by the sheet viewer: the sheet on screen, for Save sheet as CSV. */
export const sheetExport: { current: null | (() => { name: string; rows: string[][]; truncated?: boolean }) } = { current: null };

/** Save the spreadsheet sheet on screen as a CSV file (UTF-8 with BOM so Excel reads accents). */
export async function saveSheetCsv(id: string) {
  const d = docs.value[id];
  const s = sheetExport.current?.();
  if (!d?.path || !s) return;
  if (s.truncated) {
    const r = await ask({
      title: 'Save sheet as CSV',
      body: 'This sheet has more than 200,000 cells, and only the first 200,000 are shown. Save just those?',
      buttons: [{ label: 'Save the shown part', value: 'save' }, { label: 'Cancel', value: 'cancel', primary: true }],
    });
    if (r.value !== 'save') return;
  }
  const path = await platform.saveDialog(`${basename(d.path).replace(/\.[^.]+$/, '')} - ${s.name}.csv`, false);
  if (!path) return;
  try {
    await platform.writeFile(path, encodeText(toCsv(s.rows), 'utf-8', true, 'crlf'));
    showToast(`Saved ${basename(path)}`);
  } catch (e) {
    await alertMsg('Notepad 2.0', `Couldn't save ${path}\n\n${String(e)}`);
  }
}

export function setPaper(mode: PaperMode) {
  const d = activeDoc.value;
  if (settings.value.paperPerTab && d) {
    patchDoc(d.id, { paper: mode });
    scheduleSession();
  } else updateSettings({ paper: mode });
  refreshView();
}

export function renameNote(id: string, name: string) {
  patchDoc(id, { customTitle: name.trim() || undefined });
  updateWindowTitle();
  scheduleSession();
}

// ---------------------------------------------------------------- groups

const NEXT_COLORS: GroupColor[] = ['blue', 'purple', 'orange', 'green', 'pink', 'cyan', 'red', 'yellow', 'grey'];
function nextColor(): GroupColor {
  const used = T.allGroups(tree.value).map((g) => g.group.color);
  return NEXT_COLORS.find((c) => !used.includes(c)) ?? NEXT_COLORS[used.length % NEXT_COLORS.length];
}

export function commitTree(t: TreeNode[] | null) {
  if (!t) return false;
  tree.value = t;
  scheduleSession();
  return true;
}

export async function newGroupFrom(noteIds: string[], parentId?: string | null): Promise<string | null> {
  const r = await ask({ title: 'New group', buttons: [{ label: 'Create', value: 'ok', primary: true }, { label: 'Cancel', value: 'cancel' }], input: { value: noteIds.length ? '' : 'New group', label: 'Group name', select: true } });
  if (r.value !== 'ok') return null;
  const id = uid('grp');
  const ok = commitTree(T.createGroup(tree.value, { id, name: r.input?.trim() || 'Group', color: nextColor(), collapsed: false }, noteIds, parentId));
  if (!ok) await alertMsg('Notepad 2.0', `Groups can nest up to ${T.MAX_GROUP_DEPTH} levels deep.`);
  return ok ? id : null;
}

/** Characters and names Windows does not allow in file names. */
export function badFileName(name: string): boolean {
  return !name || /[\\/:*?"<>|]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name);
}

/**
 * Rename a tab. Unsaved notes just get a new title; saved files are renamed on disk (never over
 * an existing file). Returns false when nothing changed.
 */
export async function renameDoc(id: string, name: string): Promise<boolean> {
  const d = docs.value[id];
  const clean = name.trim();
  if (!d || !clean) return false;
  if (d.kind !== 'file' || !d.path) {
    renameNote(id, clean);
    return true;
  }
  const oldName = basename(d.path);
  const ext = /\.[^.]+$/.exec(oldName)?.[0] ?? '';
  const newName = /\.[^.\\/]+$/.test(clean) ? clean : clean + ext;
  if (badFileName(newName)) {
    void alertMsg('Rename', `"${newName}" can't be used as a file name.`);
    return false;
  }
  if (newName === oldName) return false;
  const to = dirname(d.path) + (d.path.includes('\\') ? '\\' : '/') + newName;
  try {
    await platform.renameFile(d.path, to);
  } catch (e) {
    void alertMsg('Rename', `Couldn't rename to "${newName}". ${/exist/i.test(String(e)) ? 'A file with that name already exists.' : String(e)}`);
    return false;
  }
  const md = isMarkdownPath(to);
  // Changing the extension between .md and anything else switches how the tab is treated.
  const typeChanged = md !== isMarkdownPath(d.path);
  patchDoc(id, { path: to, title: newName, customTitle: undefined, ...(typeChanged ? { language: md ? 'markdown' : 'plain' } : {}) });
  recentFiles.value = recentFiles.value.map((p) => (p === d.path ? to : p));
  if (activeId.value === id) refreshView();
  updateWindowTitle();
  scheduleSession();
  return true;
}

// ---------------------------------------------------------------- duplicate / copy / paste

/** The file last chosen with "Copy" in a context menu (an in-app clipboard). */
export const docClipboard = signal<string | null>(null);

export function copyDoc(id: string) {
  if (docs.value[id]) docClipboard.value = id;
}

/** Move node `id` right after `afterId`, or to the end of a file group (`null` = Ungrouped). */
function placeCopy(id: string, where: { after: string } | { group: string | null }) {
  const node: TreeNode = { id, kind: 'note' };
  const t = T.remove(tree.value, id).tree;
  if ('after' in where) {
    const loc = T.find(t, where.after);
    tree.value = loc ? T.insert(t, node, loc.parent?.id ?? null, loc.index + 1) : [...t, node];
  } else {
    tree.value = where.group ? T.insert(t, node, where.group, 9999) : [...t, node];
  }
}

/**
 * Duplicate a tab: right below the original, or at the end of `target` (a file group id, or
 * null for Ungrouped). Saved files get a new file next to the original named "Name (2).ext",
 * never over an existing file; notes get a new note titled "Name (2)".
 */
export async function duplicateDoc(id: string, target?: { groupId: string | null }): Promise<string | null> {
  visualApi.flush();
  const d = docs.value[id];
  if (!d) return null;
  const text = textOf(id);
  let copy: string | null;
  if (d.kind === 'file' && d.path) {
    const dir = dirname(d.path);
    const sep = d.path.includes('\\') ? '\\' : '/';
    const used = new Set(
      Object.values(docs.value)
        .filter((x) => x.path && dirname(x.path).toLowerCase() === dir.toLowerCase())
        .map((x) => basename(x.path!).toLowerCase()),
    );
    let name = basename(d.path);
    for (;;) {
      name = copyName(name, (n) => used.has(n.toLowerCase()));
      const st = await platform.stat(dir + sep + name);
      if (!st?.exists) break;
      used.add(name.toLowerCase());
    }
    const path = dir + sep + name;
    try {
      // Spreadsheets, images, PDFs and Word files hold no text here: copy the file's bytes.
      const bytes = isBinaryKind(d.viewer) ? (await platform.readFile(d.path)).bytes : encodeText(text, d.encoding, d.bom, d.eol);
      await platform.writeFile(path, bytes);
    } catch (e) {
      void alertMsg('Duplicate', `Couldn't create ${name}. ${String(e)}`);
      return null;
    }
    copy = await openFiles([path]);
  } else {
    const titles = new Set(Object.values(docs.value).map((x) => displayTitle(x).toLowerCase()));
    copy = newNote({ text, language: d.language, activate: false });
    renameNote(copy, copyName(displayTitle(d), (n) => titles.has(n.toLowerCase())));
  }
  if (!copy) return null;
  placeCopy(copy, target ? { group: target.groupId } : { after: id });
  if (d.color) patchDoc(copy, { color: d.color });
  activate(copy);
  scheduleSession();
  return copy;
}

/** Paste the copied file into a file group (`null` = Ungrouped). */
export async function pasteInto(groupId: string | null): Promise<string | null> {
  const id = docClipboard.value;
  if (!id || !docs.value[id]) return null;
  return duplicateDoc(id, { groupId });
}

/** Rename a file group in place (blank names are ignored). */
export function renameGroupTo(id: string, name: string) {
  const clean = name.trim();
  const loc = T.find(tree.value, id);
  if (!clean || !loc || loc.node.kind !== 'group') return;
  commitTree(T.update(tree.value, id, { name: clean }));
}

export async function renameGroup(id: string) {
  const loc = T.find(tree.value, id);
  if (!loc || loc.node.kind !== 'group') return;
  const r = await ask({ title: 'Rename group', buttons: [{ label: 'Rename', value: 'ok', primary: true }, { label: 'Cancel', value: 'cancel' }], input: { value: loc.node.name, select: true } });
  if (r.value === 'ok' && r.input?.trim()) commitTree(T.update(tree.value, id, { name: r.input.trim() }));
}

export function setGroupColor(id: string, color: GroupColor) {
  commitTree(T.update(tree.value, id, { color }));
}

export function toggleGroup(id: string, allSiblings = false) {
  const loc = T.find(tree.value, id);
  if (!loc || loc.node.kind !== 'group') return;
  const collapsed = !loc.node.collapsed;
  if (allSiblings) {
    const sibs = loc.parent ? loc.parent.children : tree.value;
    let t = tree.value;
    for (const s of sibs) if (s.kind === 'group') t = T.update(t, s.id, { collapsed });
    commitTree(t);
  } else commitTree(T.update(tree.value, id, { collapsed }));
}

export function collapseAllInside(id: string, collapsed = true) {
  commitTree(T.setCollapsedDeep(tree.value, id, collapsed));
}

export function ungroup(id: string) {
  commitTree(T.ungroup(tree.value, id));
}

export function setGroupAutosave(id: string, value: boolean | undefined) {
  commitTree(T.update(tree.value, id, { autosave: value }));
}

export function moveNode(id: string, targetId: string, pos: DropPosition): boolean {
  return commitTree(T.move(tree.value, id, targetId, pos));
}

export function moveNodeToRoot(id: string) {
  return commitTree(T.moveToRoot(tree.value, id));
}

/** Sessions saved before the rename still call the group "Quick Notes". */
function ensureQuickGroupName() {
  if (T.find(tree.value, QUICK_GROUP_ID)) ensureQuickGroup();
}

export function ensureQuickGroup() {
  const loc = T.find(tree.value, QUICK_GROUP_ID);
  if (loc) {
    // Renamed from "Quick Notes" (2026-10-01).
    if (loc.node.kind === 'group' && loc.node.name !== TRAY_GROUP_NAME) tree.value = T.update(tree.value, QUICK_GROUP_ID, { name: TRAY_GROUP_NAME });
    return;
  }
  tree.value = [...tree.value, { id: QUICK_GROUP_ID, kind: 'group', name: TRAY_GROUP_NAME, color: 'yellow', collapsed: false, system: 'quick-notes', children: [] }];
}

// ---------------------------------------------------------------- quick notes (from the bubble window)

export function onQuickNoteUpdated(p: { id: string; text: string; from: string; created?: number }) {
  visualApi.flush();
  if (p.from === platform.windowLabel) return;
  const d = docs.value[p.id];
  const now = Date.now();
  if (!d) {
    if (closedNotes.value.some((c) => c.id === p.id)) closedNotes.value = closedNotes.value.filter((c) => c.id !== p.id);
    addDoc(
      {
        id: p.id, kind: 'note', quick: true, path: null, title: noteTitle(p.text), encoding: 'utf-8', bom: false, eol: 'crlf',
        language: 'markdown', mdView: 'edit', dirty: false, mtime: 0, readonly: false, created: p.created ?? now, modified: now,
      },
      p.text,
    );
    ensureQuickGroup();
    tree.value = T.insert(tree.value, { id: p.id, kind: 'note' }, QUICK_GROUP_ID, 0);
    void mirrorNote(p.id, p.text);
    scheduleSession();
    return;
  }
  if (textOf(p.id) === p.text) {
    if (!docs.value[p.id]?.savedPath) void mirrorNote(p.id, p.text);
    return;
  }
  const st = createEditorState(p.text, d.language === 'markdown', d.readonly, viewConfig(d));
  states.set(p.id, st);
  patchDoc(p.id, { title: noteTitle(p.text), modified: now });
  if (activeId.value === p.id && view) {
    const sel = Math.min(view.state.selection.main.head, p.text.length);
    view.setState(st);
    view.dispatch({ selection: { anchor: sel } });
    editTick.value++;
  }
  if (otherDoc() === p.id) showInOtherPane();
  void mirrorNote(p.id, p.text);
}

// ---------------------------------------------------------------- commands used by menus & keys

export function withView(fn: (v: EditorView) => void) {
  if (view) fn(view);
}

/** The tab shows a viewer, not its text (a data file in View, or a spreadsheet / image / PDF / Word). */
function sourceHidden(): boolean {
  const d = activeDoc.value;
  return !!d && (isBinaryKind(d.viewer) || (hasViewPane(d.viewer) && activeView(d) === 'visual'));
}

/**
 * Find / Replace / Go to work on the source: a Markdown Visual tab switches to Source, a data file
 * in View to Split (so the view stays in sight); files with no text do nothing. Returns true when
 * the command was handled here.
 */
function leaveVisual(then: () => void): boolean {
  const d = activeDoc.value;
  if (d && isBinaryKind(d.viewer)) return true;
  if (d && hasViewPane(d.viewer) && activeView(d) === 'visual') {
    setPaneView(panes.value.active, 'split');
    queueMicrotask(then);
    return true;
  }
  if (!inVisual()) return false;
  visualApi.flush();
  setPaneView(panes.value.active, 'edit');
  queueMicrotask(then);
  return true;
}

/** Paste plain text where the Visual editor's cursor is (the menus' Paste in Visual). */
async function pasteIntoVisual() {
  const ed = visualApi.editor;
  if (!ed) return;
  try {
    const text = await navigator.clipboard.readText();
    ed.view.pasteText(text);
  } catch {
    ed.view.focus();
    document.execCommand('paste');
  }
}

export const cmd = {
  undo: () => (inVisual() ? visualApi.undo() : !sourceHidden() && withView((v) => undo(v))),
  redo: () => (inVisual() ? visualApi.redo() : !sourceHidden() && withView((v) => redo(v))),
  selectAll: () => (inVisual() ? void visualApi.editor!.commands.selectAll() : !sourceHidden() && withView((v) => selectAll(v))),
  find: () => leaveVisual(() => cmd.find()) || withView((v) => {
    openSearchPanel(v);
    setTimeout(() => (v.dom.querySelector('.cm-search input[name=search]') as HTMLInputElement | null)?.select(), 0);
  }),
  replace: () => leaveVisual(() => cmd.replace()) || withView((v) => {
    openSearchPanel(v);
    setTimeout(() => (v.dom.querySelector('.cm-search input[name=replace]') as HTMLInputElement | null)?.focus(), 0);
  }),
  findNext: (back = false) => withView((v) => {
    if (!searchPanelOpen(v.state)) return cmd.find();
    back ? findPrevious(v) : findNext(v);
  }),
  closeFind: () => withView((v) => searchPanelOpen(v.state) && closeSearchPanel(v)),
  cut: () => !sourceHidden() && withView((v) => {
    v.focus();
    document.execCommand('cut');
  }),
  copy: () => !sourceHidden() && withView((v) => {
    v.focus();
    document.execCommand('copy');
  }),
  paste: () => (inVisual() ? pasteIntoVisual() : !sourceHidden() && withView(async (v) => {
    try {
      const text = await navigator.clipboard.readText();
      v.dispatch(v.state.replaceSelection(text));
    } catch {
      v.focus();
      document.execCommand('paste');
    }
  })),
  del: () => !sourceHidden() && withView((v) => {
    v.dispatch(v.state.replaceSelection(''));
  }),
  timeDate: () => !sourceHidden() && withView((v) => {
    const now = new Date();
    const s = `${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${now.toLocaleDateString()}`;
    v.dispatch(v.state.replaceSelection(s));
    v.focus();
  }),
  async goToLine() {
    if (leaveVisual(() => void cmd.goToLine())) return;
    if (!view) return;
    const total = view.state.doc.lines;
    const r = await ask({ title: 'Go to line', buttons: [{ label: 'Go to', value: 'ok', primary: true }, { label: 'Cancel', value: 'cancel' }], input: { value: String(cursorInfo.value.line), label: 'Line number', type: 'number', select: true } });
    if (r.value !== 'ok' || !view) return;
    const n = Number(r.input);
    if (!Number.isInteger(n) || n < 1 || n > total) {
      await alertMsg('Notepad 2.0 - Goto line', 'The line number is beyond the total number of lines');
      return;
    }
    const line = view.state.doc.line(n);
    view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    view.focus();
  },
  zoom(delta: number | 'reset') {
    const z = delta === 'reset' ? 100 : Math.max(10, Math.min(500, settings.value.zoom + delta));
    updateSettings({ zoom: z });
    refreshView();
  },
  cycleTab(dir: 1 | -1) {
    const order = orderedIds.value;
    if (!order.length) return;
    const i = order.indexOf(activeId.value ?? '');
    activate(order[(i + dir + order.length) % order.length]);
  },
  goToTab(n: number) {
    const order = orderedIds.value;
    const id = n === 9 ? order[order.length - 1] : order[n - 1];
    if (id) activate(id);
  },
  print() {
    const d = activeDoc.value;
    if (!d) return;
    printText(textOf(d.id), displayTitle(d), d.language === 'markdown' && activeView(d) !== 'edit');
  },
  toggleTabsMode() {
    updateSettings({ tabsMode: nextTabsMode(settings.value.tabsMode) });
  },
};

/** The rendered page to print: the active pane's (split view has two). */
export function printSourceElement(): Element | null {
  const root = panes.value.on ? document.querySelector('.editor-pane.pane-active') : document;
  return root?.querySelector('.md-preview .markdown-body, .visual-editor .ProseMirror') ?? null;
}

export function printText(text: string, title: string, rendered: boolean) {
  const root = document.createElement('div');
  root.id = 'print-root';
  if (rendered) {
    const src = printSourceElement();
    root.innerHTML = src ? src.innerHTML : '';
    root.className = 'markdown-body';
  } else {
    // A form feed (Insert > Page break) starts a new printed page.
    for (const page of text.split('\f')) {
      const pre = document.createElement('pre');
      pre.className = 'print-page';
      pre.textContent = page;
      root.appendChild(pre);
    }
  }
  root.setAttribute('data-title', title);
  document.body.appendChild(root);
  document.body.classList.add('printing');
  const done = () => {
    document.body.classList.remove('printing');
    root.remove();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  setTimeout(() => {
    window.print();
    setTimeout(done, 500);
  }, 50);
}

// ---------------------------------------------------------------- window / app lifecycle

export async function hideToTray() {
  await flushAll();
  await platform.hide();
}

export async function quitApp() {
  const { flushEveryWindow } = await import('./windows');
  await flushEveryWindow();
  await platform.quit();
}

export async function onWindowCloseRequested() {
  // With other windows open, this window's files move into the last-used one and it closes.
  const { closeIntoOtherWindow } = await import('./windows');
  const r = await closeIntoOtherWindow();
  if (r !== 'alone') return; // merged, or the merge failed and the window stays open
  if (settings.value.closeToTray) await hideToTray();
  else await quitApp();
}

// ---------------------------------------------------------------- moving items between windows

/** Save and copy out docs for another window (notes are written to the store first). */
export async function snapshotDocs(ids: string[]): Promise<{ meta: DocMeta; text: string }[]> {
  visualApi.flush();
  stashActive();
  const out: { meta: DocMeta; text: string }[] = [];
  for (const id of ids) {
    const d = docs.value[id];
    if (!d) continue;
    if (d.kind === 'note') await persistNote(id);
    out.push({ meta: { ...d, banner: null }, text: textOf(id) });
  }
  return out;
}

/** Add docs handed over by another window (their notes are already in the store). */
export function importDocs(entries: { meta: DocMeta; text: string }[]) {
  for (const { meta, text } of entries) {
    if (docs.value[meta.id]) continue;
    if (meta.kind === 'file' && meta.path && findOpenFile(meta.path)) continue;
    addDoc({ ...meta, banner: null }, text);
    if (meta.dirty) onEdited(meta.id);
    if (meta.path && meta.viewer && !isBinaryKind(meta.viewer)) {
      void syntaxFor(meta.path, meta.viewer).then((s) => {
        syntaxes.set(meta.id, s);
        if (activeId.value === meta.id) view?.dispatch({ effects: cSyntax.reconfigure(s) });
      });
    }
  }
}

/** Drop docs that moved to another window: no prompts, their note files stay. */
export function removeDocs(ids: string[]) {
  const drop = new Set(ids);
  if (activeId.value && drop.has(activeId.value)) {
    stashActive();
    activeId.value = null;
  }
  for (const id of ids) {
    states.delete(id);
    syntaxes.delete(id);
    clearTimeout(noteTimers.get(id));
    clearTimeout(fileTimers.get(id));
    noteTimers.delete(id);
    fileTimers.delete(id);
  }
  docs.value = Object.fromEntries(Object.entries(docs.value).filter(([id]) => !drop.has(id)));
  const left = orderedIds.value.find((id) => !drop.has(id)) ?? null;
  if (panes.value.on) {
    const otherBefore = otherDoc();
    panes.value = P.onRemoved(panes.value, ids, () => left);
    if (!activeId.value) {
      const a = panes.value.docs[panes.value.active];
      if (a && docs.value[a]) activate(a);
    }
    if (otherDoc() !== otherBefore) showInOtherPane();
  }
}

/** For the session file and tests: what this window saves about split view. */
export function sessionSnapshot(): { split: PaneState } {
  return { split: panes.value };
}

/** Restore split view from a session (missing documents fall back to `fallback`). */
export function applySessionSplit(raw: unknown, keep: Set<string>, fallback: string | null) {
  panes.value = P.restore(raw, (id) => keep.has(id), fallback);
}

export async function handleLaunch(argv: string[], cwd: string | null) {
  const req = parseLaunchArgs(argv, cwd);
  if (req.quickNote) {
    await platform.showQuickNote();
    return;
  }
  if (req.files.length) await openFiles(req.files);
  if (req.print) cmd.print();
  if (!req.hidden) await platform.show();
}

// ---------------------------------------------------------------- startup

async function restoreSession(): Promise<boolean> {
  const raw = await platform.storeRead(sessionKey(platform.windowLabel));
  if (!raw) return false;
  let s: SessionFile;
  try {
    s = JSON.parse(raw);
  } catch {
    return false;
  }
  closedNotes.value = s.closedNotes ?? [];
  recentFiles.value = s.recentFiles ?? [];
  const keep = new Set<string>();
  for (const stored of s.docs ?? []) {
    const meta: DocMeta = { ...stored, mdView: migrateMdView(stored.mdView) };
    try {
      if (meta.kind === 'note') {
        const text = await platform.storeRead(`notes/${meta.id}.md`);
        addDoc({ ...meta, dirty: false, banner: null }, text ?? '');
        keep.add(meta.id);
        continue;
      }
      if (isBinaryKind(meta.viewer)) {
        const bst = await platform.stat(meta.path!);
        if (bst.exists) {
          addDoc({ ...meta, dirty: false, mtime: bst.mtime, size: bst.size, banner: null }, '');
          keep.add(meta.id);
        }
        continue;
      }
      if (meta.viewer) syntaxes.set(meta.id, await syntaxFor(meta.path!, meta.viewer));
      const recRaw = await platform.storeRead(`recovery/${meta.id}.json`);
      const rec = recRaw ? JSON.parse(recRaw) : null;
      const st = await platform.stat(meta.path!);
      if (!st.exists) {
        if (rec) {
          addDoc({ ...meta, dirty: true, banner: { kind: 'missing', text: 'The file is gone from disk. Your unsaved text was restored; save to recreate it.' } }, rec.text);
          keep.add(meta.id);
        }
        continue;
      }
      const f = await platform.readFile(meta.path!);
      const dec = decodeBytes(f.bytes);
      if (rec && rec.text !== dec.text) {
        addDoc(
          {
            ...meta, dirty: true, mtime: f.mtime, readonly: f.readonly, encoding: rec.encoding ?? dec.encoding, bom: rec.bom ?? dec.bom, eol: rec.eol ?? dec.eol,
            banner: {
              kind: 'restored',
              text: f.mtime > (rec.baseMtime ?? 0) + 1
                ? 'Unsaved changes restored. The file also changed on disk since then.'
                : 'Unsaved changes from your last session were restored.',
            },
          },
          rec.text,
        );
      } else {
        if (rec) await platform.storeDelete(`recovery/${meta.id}.json`);
        addDoc({ ...meta, dirty: false, mtime: f.mtime, readonly: f.readonly, encoding: dec.encoding, bom: dec.bom, eol: dec.eol, banner: null }, dec.text);
      }
      keep.add(meta.id);
    } catch {
      /* unreadable entries are dropped */
    }
  }
  tree.value = T.prune(s.tree ?? [], (id) => keep.has(id));
  // Anything in the tree's docs but missing from the tree (older sessions): append.
  const inTree = new Set(T.flattenNotes(tree.value));
  for (const id of keep) if (!inTree.has(id)) tree.value = [...tree.value, { id, kind: 'note' }];
  let act = s.activeId && keep.has(s.activeId) ? s.activeId : T.flattenNotes(tree.value)[0] ?? null;
  applySessionSplit(s.split, keep, act);
  view = paneViews[panes.value.active];
  act = panes.value.docs[panes.value.active] ?? act;
  activeId.value = null;
  if (act) {
    activeId.value = act;
  }
  return keep.size > 0;
}

/** Quick notes written by the bubble while the main window missed the event. */
async function adoptOrphanNotes() {
  if (platform.windowLabel !== 'main') return;
  const files = await platform.storeList('notes');
  const known = new Set([...Object.keys(docs.value), ...closedNotes.value.map((c) => c.id)]);
  // Notes that belong to other windows are not orphans.
  for (const f of await platform.storeList('sessions').catch(() => [] as string[])) {
    try {
      const other = JSON.parse((await platform.storeRead(`sessions/${f}`)) ?? '{}');
      for (const d of other.docs ?? []) known.add(d.id);
      for (const c of other.closedNotes ?? []) known.add(c.id);
    } catch {
      /* unreadable session: ignore */
    }
  }
  for (const f of files) {
    const id = f.replace(/\.md$/, '');
    if (known.has(id)) continue;
    const text = (await platform.storeRead(`notes/${f}`)) ?? '';
    if (!text.trim()) continue;
    onQuickNoteUpdated({ id, text, from: 'startup' });
  }
}

export async function init() {
  await loadSettings();
  const restored = await restoreSession();
  if (!restored && platform.kind === 'browser') {
    const { seedDemo } = await import('./demo');
    await seedDemo();
  }
  await adoptOrphanNotes();
  ensureQuickGroupName();
  ready.value = true;
  void copyNotesToFolder();
  void refreshFileIcons();
  const { initWindows } = await import('./windows');
  await initWindows();

  const first = platform.windowLabel === 'main';
  // Only the first window takes command-line files; the others just follow --hidden.
  const launch = first ? await platform.launchArgs() : { argv: (await platform.launchHidden()) ? ['--hidden'] : [], cwd: null };
  const req = parseLaunchArgs(launch.argv, launch.cwd);
  if (req.files.length) await openFiles(req.files);
  if (!orderedIds.value.length) newNote();
  if (!activeId.value || !docs.value[activeId.value]) activate(orderedIds.value[0]);
  else {
    const id = activeId.value;
    activeId.value = null;
    activate(id);
  }
  if (req.print) cmd.print();
  // The native window starts hidden so it never flashes empty; show it once the UI is ready.
  // --hidden (start with Windows) and --quicknote keep it in the tray.
  if (req.quickNote) platform.showQuickNote();
  else if (!req.hidden) platform.show();

  platform.onSecondInstance((a) => handleLaunch(a.argv, a.cwd));
  platform.onCloseRequested(() => onWindowCloseRequested());
  platform.onFocus(() => checkExternalChanges());
  platform.listen<{ id: string; text: string; from: string; created?: number }>('note-updated', async (p) => {
    // A window that has the note updates it. Only a note from the Quick Note bubble itself can be
    // new, and then only the last-used window adds it (other windows' edits never create copies).
    if (docs.value[p.id]) onQuickNoteUpdated(p);
    else if (p.from === 'quicknote' && (await platform.lastWindow()) === platform.windowLabel) onQuickNoteUpdated(p);
  });
  platform.listen<string>('open-doc', async (id) => {
    // Quick Note's "open in main window": the window that has it, else the last-used window.
    if (docs.value[id]) activate(id);
    else if ((await platform.lastWindow()) === platform.windowLabel) reopenNote(id);
    else return;
    platform.show();
  });
  platform.listenHere<string>('focus-file', (path) => {
    const id = findOpenFile(path);
    if (id) activate(id);
  });
  platform.listen<{ id: string; path: string }>('quicknote-saved-as', async ({ id, path }) => {
    if (docs.value[id]) {
      stashActive();
      const text = textOf(id);
      patchDoc(id, { kind: 'file', quick: false, path, title: basename(path), mtime: Date.now(), dirty: false, language: isMarkdownPath(path) ? 'markdown' : 'plain' });
      await platform.storeDelete(`notes/${id}.md`);
      if (activeId.value === id) refreshView();
      void text;
      scheduleSession();
    }
  });
  platform.listenHere('quit-requested', () => quitApp());
  platform.listenHere('open-settings', () => {
    settingsOpen.value = true;
    platform.show();
  });
  platform.listen<Settings>('settings-changed', (s) => {
    applyRemoteSettings(s);
    refreshView();
  });
  // Final safety net: flush when the web view is torn down.
  window.addEventListener('beforeunload', () => {
    flushAll();
  });
  scheduleSession();
}
