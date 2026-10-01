// One editing session per open spreadsheet tab, kept outside the component so switching tabs
// keeps edits, undo history, selection and filters. Saving goes through state/app's
// binarySavers (Ctrl+S, the close prompt, "Save" in menus).
import { signal } from '@preact/signals';
import { platform } from '../../platform';
import { binarySavers, setBinaryDirty, replaceDocText, docs } from '../../state/app';
import { loadXlsx, saveXlsx, type LoadedBook } from '../../sheet/xlsx-io';
import { loadPrefs, savePrefs, type SheetPrefs } from '../../sheet/prefs';
import { commit, undoH, redoH, newSheet, detectHeader, type History, type SheetState, type Rect } from '../../sheet/model';
import { parseCsv, detectDelimiter, toDelimited } from '../../lib/csv';
import type { Filter } from '../../sheet/filter';

export interface Pos {
  r: number;
  c: number;
}

export interface Sel {
  a: Pos;
  b: Pos;
  /** Ctrl+click adds ranges. */
  extra: Rect[];
  mode: 'cells' | 'rows' | 'cols';
}

export interface SheetSession {
  id: string;
  mode: 'xlsx' | 'csv';
  book: LoadedBook | null;
  hist: History<SheetState[]>;
  /** The state last written to disk (undoing back to it makes the tab clean again). */
  saved: SheetState[];
  active: number;
  prefs: SheetPrefs;
  filters: Filter[];
  sel: Sel;
  delim: string;
  /** The CSV text this grid last wrote or read (so its own writes don't reload it). */
  lastText: string;
  original: Uint8Array | null;
  backedUp: boolean;
  rev: number | undefined;
  error: string | null;
}

export const sessions = new Map<string, SheetSession>();
// For the browser checks (e2e/sheet-check.mjs).
if (typeof window !== 'undefined') (window as any).__np2Sheets = sessions;
/** Bumps whenever a session changes, so the editor re-renders. */
export const sheetTick = signal(0);

const startSel = (): Sel => ({ a: { r: 0, c: 0 }, b: { r: 0, c: 0 }, extra: [], mode: 'cells' });

function applyPrefs(sheets: SheetState[], prefs: SheetPrefs): SheetState[] {
  return sheets.map((s) => {
    const p = prefs.sheets[s.name];
    if (!p) return s;
    return {
      ...s,
      freeze: p.freeze ?? s.freeze,
      header: p.header ?? s.header,
      widths: p.widths ? p.widths.map((w, i) => w ?? s.widths[i]) : s.widths,
    };
  });
}

export async function openXlsx(id: string, path: string, rev: number | undefined): Promise<SheetSession> {
  const s: SheetSession = {
    id, mode: 'xlsx', book: null, hist: { past: [], present: [], future: [] }, saved: [], active: 0, prefs: await loadPrefs(path),
    filters: [], sel: startSel(), delim: ',', lastText: '', original: null, backedUp: false, rev, error: null,
  };
  try {
    const f = await platform.readFile(path);
    s.original = f.bytes;
    s.book = await loadXlsx(f.bytes);
    const sheets = applyPrefs(s.book.sheets, s.prefs);
    s.hist = { past: [], present: sheets, future: [] };
    s.saved = sheets;
  } catch (e) {
    s.error = String(e);
  }
  sessions.set(id, s);
  if (s.book) binarySavers.set(id, () => saveSession(id));
  sheetTick.value++;
  return s;
}

export function csvSheet(text: string, path: string | null, name = 'Sheet1'): { sheet: SheetState; delim: string } {
  const delim = detectDelimiter(text, path);
  const { rows } = parseCsv(text, delim);
  const sheet = newSheet(name, 0, 0);
  sheet.rows = rows.map((r) => r.map((v) => (v === '' ? null : { v })));
  sheet.widths = Array.from({ length: rows[0]?.length ?? 0 }, () => undefined);
  sheet.header = rows.length > 1 ? 0 : -1;
  void detectHeader;
  return { sheet, delim };
}

export async function openCsv(id: string, path: string | null, text: string): Promise<SheetSession> {
  const prefs = await loadPrefs(path);
  const { sheet, delim } = csvSheet(text, path);
  const sheets = applyPrefs([sheet], prefs);
  const s: SheetSession = {
    id, mode: 'csv', book: null, hist: { past: [], present: sheets, future: [] }, saved: sheets, active: 0, prefs,
    filters: [], sel: startSel(), delim, lastText: text, original: null, backedUp: false, rev: undefined, error: null,
  };
  sessions.set(id, s);
  sheetTick.value++;
  return s;
}

/** The Source text changed (typing in Source, reload): rebuild the grid from it. */
export function csvTextChanged(s: SheetSession, text: string, path: string | null) {
  if (text === s.lastText) return;
  const { sheet, delim } = csvSheet(text, path, s.hist.present[0]?.name);
  const prev = s.hist.present[0];
  const next: SheetState = prev ? { ...sheet, freeze: prev.freeze, header: prev.header < sheet.rows.length ? prev.header : sheet.header, widths: prev.widths } : sheet;
  s.hist = { past: [], present: [next], future: [] };
  s.saved = s.hist.present;
  s.delim = delim;
  s.lastText = text;
  sheetTick.value++;
}

function rowsAsText(sheet: SheetState): string[][] {
  let width = 0;
  for (const r of sheet.rows) width = Math.max(width, r.length);
  let last = sheet.rows.length - 1;
  while (last >= 0 && !(sheet.rows[last] ?? []).some((c) => c && c.v != null && String(c.v) !== '')) last--;
  return sheet.rows.slice(0, last + 1).map((r) => Array.from({ length: width }, (_, i) => (r[i]?.v == null ? '' : String(r[i]!.v))));
}

/** Every edit goes through here: one undo step, the tab's saved/unsaved state, CSV text. */
export function apply(s: SheetSession, fn: (sheet: SheetState) => SheetState, opts: { view?: boolean } = {}) {
  const cur = s.hist.present;
  const sheet = cur[s.active];
  if (!sheet) return;
  const next = fn(sheet);
  if (next === sheet) return;
  const sheets = cur.slice();
  sheets[s.active] = next;
  s.hist = commit(s.hist, sheets);
  afterChange(s, opts.view ? next : null);
}

function afterChange(s: SheetSession, viewOnly: SheetState | null) {
  const sheet = s.hist.present[s.active];
  // Things a file can't store (freeze beyond Excel's, the header row, CSV widths) live in prefs.
  const name = sheet.name;
  const before = s.prefs.sheets[name];
  const keep = { freeze: sheet.freeze, header: sheet.header, ...(s.mode === 'csv' ? { widths: sheet.widths } : {}) };
  if (JSON.stringify(before) !== JSON.stringify(keep)) {
    s.prefs = { ...s.prefs, sheets: { ...s.prefs.sheets, [name]: keep } };
    void savePrefs(docs.value[s.id]?.path ?? null, s.prefs);
  }
  if (s.mode === 'csv') {
    const text = toDelimited(rowsAsText(sheet), s.delim);
    if (text !== s.lastText) {
      s.lastText = text;
      replaceDocText(s.id, text);
    }
  } else if (!viewOnly) setBinaryDirty(s.id, s.hist.present !== s.saved);
  sheetTick.value++;
}

export function undo(s: SheetSession) {
  s.hist = undoH(s.hist);
  afterChange(s, null);
}
export function redo(s: SheetSession) {
  s.hist = redoH(s.hist);
  afterChange(s, null);
}

export function updatePrefs(s: SheetSession, p: Partial<SheetPrefs>) {
  s.prefs = { ...s.prefs, ...p };
  void savePrefs(docs.value[s.id]?.path ?? null, s.prefs);
  sheetTick.value++;
}

async function saveSession(id: string): Promise<number | null> {
  const s = sessions.get(id);
  const d = docs.value[id];
  if (!s?.book || !d?.path) return null;
  if (!s.backedUp && s.original) {
    // One copy of the file as it was, before the first save over it this session.
    await platform.writeFile(`${d.path}.bak`, s.original);
    s.backedUp = true;
  }
  const bytes = await saveXlsx(s.book, s.hist.present);
  const mtime = await platform.writeFile(d.path, bytes);
  s.saved = s.hist.present;
  await savePrefs(d.path, s.prefs);
  sheetTick.value++;
  return mtime;
}

/** Forget a closed tab's session. */
export function dropSession(id: string) {
  sessions.delete(id);
  binarySavers.delete(id);
}
