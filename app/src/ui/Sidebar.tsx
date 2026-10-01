// Vertical tabs (screenshots 1 to 3) and the collapsed rail (screenshot 4).
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import type { TreeNode, GroupNode } from '../lib/tree-ops';
import { tree, docs, activeId, activate, closeDoc, newNote, newSheetFile, displayTitle, toggleGroup, newGroupFrom, renameDoc, renameGroupTo, panes, saveState, QUICK_GROUP_ID } from '../state/app';
import { settings, updateSettings } from '../state/settings';
import { PaperButton } from './PaperButton';
import { openContextMenu, railPeek, closedNotesOpen, renamingId, contextMenu, type MenuItem } from '../state/ui';
import { InlineRename } from './InlineRename';
import { IcChevronDown, IcChevronUp, IcClose, IcPlus, IcSearch, IcPanelCollapse, IcPanelExpand } from './icons';
import { startDrag, consumeDragClick, dropClass, drag } from './dnd';
import { noteMenu, notesMenu, groupMenu, ungroupedMenu } from './menus';
import { clickFile, targetsFor, isSelected, selection, visibleOrder, clearSelection } from '../state/selection';
import { groupVars, docColorVars } from './colors';
import { sortNodes, SORT_LABELS, type SortMode, type SortDoc } from '../lib/sort';
import { dayTime, shortWhen, typeLabel } from '../lib/when';

/** Ticks every 30 s so "today 19:38" labels roll over to "yesterday". */
const clock = signal(Date.now());
setInterval(() => (clock.value = Date.now()), 30_000);

function sortDocs(): Record<string, SortDoc> {
  const out: Record<string, SortDoc> = {};
  for (const [id, d] of Object.entries(docs.value)) out[id] = { title: displayTitle(d), created: d.created, modified: d.modified, language: d.language };
  return out;
}

function matches(id: string, q: string): boolean {
  const d = docs.value[id];
  if (!d || !q) return true;
  const s = q.toLowerCase();
  return displayTitle(d).toLowerCase().includes(s) || (d.path ?? '').toLowerCase().includes(s);
}

function anyMatch(n: TreeNode, q: string): boolean {
  if (!q) return true;
  if (n.kind === 'note') return matches(n.id, q);
  return n.name.toLowerCase().includes(q.toLowerCase()) || n.children.some((c) => anyMatch(c, q));
}

/** The sort dropdown's own wording ("Manual sorting", "Sorted by name A–Z"…). */
export const SORT_BUTTON: Record<SortMode, string> = {
  manual: 'Manual sorting',
  modified: 'Sorted by date modified',
  created: 'Sorted by date created',
  name: 'Sorted by name A–Z',
  type: 'Sorted by file type',
};

export const TRAY_TOOLTIP = 'TrayNotes: notes you started from the tray icon (or Win+Alt+N). They save automatically to your save folder. Click to expand or collapse; right-click for options.';

/** Small print under a file name: ".md file · created yesterday 22:09" and, on the right, the save state. */
function NoteMeta({ id }: { id: string }) {
  const d = docs.value[id];
  const now = clock.value;
  const st = saveState(d);
  const created = `${typeLabel(d)} · created ${dayTime(d.created, now)}`;
  const right = !st.saved ? 'Unsaved' : st.at ? `Saved ${shortWhen(st.at, now)}` : 'Empty';
  const where = d.kind === 'file' ? d.path : d.savedPath;
  const tip = [
    `Created ${new Date(d.created).toLocaleString()}`,
    `Modified ${new Date(d.modified).toLocaleString()}`,
    st.at ? `Last saved ${new Date(st.at).toLocaleString()}` : 'Not saved to disk yet',
    where ?? '',
  ].filter(Boolean).join('\n');
  return (
    <span class="side-note-meta" title={tip}>
      <span class="side-note-type">{created}</span>
      <span class={`side-save ${st.saved ? 'saved' : 'unsaved'}`}>
        {right}
        <span class="save-dot" aria-label={st.saved ? 'Saved' : 'Unsaved changes'} />
      </span>
    </span>
  );
}

function NoteRow({ id, depth }: { id: string; depth: number }) {
  const d = docs.value[id];
  if (!d) return null;
  const title = displayTitle(d);
  const active = activeId.value === id;
  const shown = panes.value.on && (panes.value.docs.a === id || panes.value.docs.b === id);
  return (
    <div
      class={`side-note${active ? ' active' : shown ? ' also-shown' : ''}${isSelected(id) ? ' selected' : ''}${d.color ? ' colored' : ''}${dropClass(id)}`}
      style={{ '--depth': depth, ...docColorVars(d.color) } as any}
      data-drop-id={id}
      data-drop-kind="note"
      onPointerDown={(e) => startDrag(e as PointerEvent, id, title)}
      onClick={(e) => {
        if (consumeDragClick()) return;
        if (clickFile(id, e as MouseEvent, activeId.value)) activate(id);
      }}
      onAuxClick={(e) => e.button === 1 && closeDoc(id)}
      onDblClick={() => (renamingId.value = id)}
      onContextMenu={(e) => {
        const ids = targetsFor(id);
        if (ids.length < 2) clearSelection();
        openContextMenu(e as MouseEvent, ids.length > 1 ? notesMenu(ids) : noteMenu(id));
      }}
    >
      <span class="side-note-text">
        {renamingId.value === id ? (
          <InlineRename value={title} onCommit={(v) => void renameDoc(id, v)} />
        ) : (
          <span class="side-note-title" title={d.path ?? d.savedPath ?? title}>{title}</span>
        )}
        <NoteMeta id={id} />
      </span>
      <button
        class="side-close"
        title="Close"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          closeDoc(id);
        }}
      >
        <IcClose size={12} />
      </button>
    </div>
  );
}

function GroupBlock({ g, depth, q }: { g: GroupNode; depth: number; q: string }) {
  const open = !g.collapsed || !!q;
  const count = countNotes(g);
  const tray = g.system === 'quick-notes';
  return (
    <div class={`side-group depth-${depth}${tray ? ' tray-group' : ''}`} style={groupVars(g.color)}>
      <div
        class={`side-group-head${dropClass(g.id)}`}
        data-drop-id={g.id}
        data-drop-kind="group"
        data-collapsed={String(g.collapsed)}
        onPointerDown={(e) => startDrag(e as PointerEvent, g.id, g.name)}
        onClick={(e) => !consumeDragClick() && toggleGroup(g.id, (e as MouseEvent).altKey)}
        onContextMenu={(e) => openContextMenu(e as MouseEvent, groupMenu(g.id))}
        onDblClick={() => !g.system && (renamingId.value = g.id)}
        title={tray ? TRAY_TOOLTIP : 'Click to expand or collapse. Double-click to rename. Right-click for options.'}
      >
        {renamingId.value === g.id ? (
          <InlineRename value={g.name} onCommit={(v) => renameGroupTo(g.id, v)} class="on-group" />
        ) : (
          <span class="side-group-name">{g.name}</span>
        )}
        <span class="side-group-kind">{tray ? 'Tray' : 'Group'}</span>
        {!open && <span class="side-group-count">{count}</span>}
        <span class="side-group-chev">{open ? <IcChevronUp /> : <IcChevronDown />}</span>
      </div>
      {open && (
        <div class="side-group-body">
          {g.children.filter((c) => anyMatch(c, q)).map((c) =>
            c.kind === 'note' ? <NoteRow key={c.id} id={c.id} depth={depth} /> : <GroupBlock key={c.id} g={c} depth={depth + 1} q={q} />,
          )}
          {g.children.length === 0 && <div class="side-empty">{tray ? 'Notes from the tray icon appear here' : 'Drag files here'}</div>}
        </div>
      )}
    </div>
  );
}

function countNotes(g: GroupNode): number {
  return g.children.reduce((a, c) => a + (c.kind === 'note' ? 1 : countNotes(c)), 0);
}

/** Files in the order they're shown (collapsed groups' files are hidden, a search opens them). */
function shownOrder(nodes: TreeNode[], q: string, out: string[] = []): string[] {
  for (const n of nodes) {
    if (!anyMatch(n, q)) continue;
    if (n.kind === 'note') out.push(n.id);
    else if (!n.collapsed || q) shownOrder(n.children, q, out);
  }
  return out;
}

/** The sort dropdown: one outlined button, chevron inside, a menu of orders. */
function SortButton({ mode }: { mode: SortMode }) {
  const ref = useRef<HTMLButtonElement>(null);
  const open = () => {
    const r = ref.current!.getBoundingClientRect();
    const items: MenuItem[] = (Object.keys(SORT_LABELS) as SortMode[]).map((m) => ({
      label: m === 'manual' ? 'Manual (the order you arranged)' : SORT_LABELS[m],
      checked: m === mode,
      action: () => updateSettings({ sidebarSort: m }),
    }));
    contextMenu.value = { x: r.left, y: r.bottom + 4, items };
  };
  return (
    <button ref={ref} class="side-btn side-sort-btn" title="How files are ordered here. Manual keeps the order you arranged." aria-haspopup="menu" onPointerDown={(e) => e.stopPropagation()} onClick={open}>
      <span class="side-btn-label">{SORT_BUTTON[mode]}</span>
      <IcChevronDown size={14} />
    </button>
  );
}

/** "Create new: Markdown | Text | Sheet": one wide outlined button in three parts. */
function CreateNew({ onMeasure }: { onMeasure: (w: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Its natural width decides how narrow the sidebar may get, so it is never cut off.
    const prev = el.style.width;
    el.style.width = 'max-content';
    const w = el.offsetWidth;
    el.style.width = prev;
    onMeasure(w);
  }, [settings.value.uiScale]);
  return (
    <div class="create-new" ref={ref} role="group" aria-label="Create new">
      <span class="cn-label">Create new:</span>
      <button class="cn-part" title="New Markdown file (Ctrl+Alt+N)" onClick={() => newNote({ language: 'markdown', groupId: null })}>
        Markdown
      </button>
      <span class="cn-sep" />
      <button class="cn-part" title="New text file (Ctrl+N)" onClick={() => newNote({ language: 'plain', groupId: null })}>
        Text
      </button>
      <span class="cn-sep" />
      <button class="cn-part" title="New spreadsheet (.xlsx), saved in your save folder" onClick={() => void newSheetFile()}>
        Sheet
      </button>
    </div>
  );
}

/** Narrowest the sidebar may be: the Create new button plus the header's padding. */
const sideMin = signal(300);

export function Sidebar() {
  const [q, setQ] = useState('');
  const s = settings.value;
  const all = sortNodes(tree.value, s.sidebarSort, sortDocs());
  const tray = all.find((n): n is GroupNode => n.kind === 'group' && n.id === QUICK_GROUP_ID);
  const nodes = all.filter((n) => n !== tray);
  visibleOrder.ids = shownOrder(tray ? [...nodes, tray] : nodes, q);
  selection.value; // re-render when the selection changes
  const width = Math.max(sideMin.value, s.sidebarWidth);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && selection.value.length && clearSelection();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);

  const onResize = (e: PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) => updateSettings({ sidebarWidth: Math.max(sideMin.value, Math.min(720, startW + ev.clientX - startX)) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <aside class="sidebar" style={{ width: width + 'px', minWidth: sideMin.value + 'px' }}>
      <div class="side-tools">
        <div class="side-head">
          <div class="side-search">
            <IcSearch size={14} />
            <input placeholder="Search tabs" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          </div>
        </div>
        <div class="side-row">
          <SortButton mode={s.sidebarSort} />
          <PaperButton cls="side-paper" />
        </div>
        <CreateNew onMeasure={(w) => (sideMin.value = Math.max(240, Math.ceil(w) + 18))} />
      </div>
      <div
        class="side-scroll"
        onContextMenu={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest('.side-note, .side-group-head, .side-link, .side-newgroup')) return;
          openContextMenu(e as MouseEvent, ungroupedMenu());
        }}
      >
        {nodes.filter((n) => anyMatch(n, q)).map((n) =>
          n.kind === 'note' ? <NoteRow key={n.id} id={n.id} depth={0} /> : <GroupBlock key={n.id} g={n} depth={1} q={q} />,
        )}
        <div class={`side-root-drop${drag.value ? ' visible' : ''}${dropClass('__root__')}`} data-drop-id="__root__">
          {drag.value ? 'Drop here to take it out of its file group' : ''}
        </div>
        <button class="side-newgroup" title="New file group (Ctrl+Shift+G)" onClick={() => newGroupFrom([], null)}>
          <IcPlus size={14} />
          <span>New group</span>
        </button>
      </div>
      {tray && anyMatch(tray, q) && (
        <div class="side-dock">
          <GroupBlock g={tray} depth={1} q={q} />
        </div>
      )}
      <div class="side-foot">
        <button class="side-link" onClick={() => (closedNotesOpen.value = true)}>
          Closed notes…
        </button>
        <button class="side-btn side-collapse" title="Collapse the sidebar to a narrow rail (View → Tabs to change)" onClick={() => updateSettings({ tabsMode: 'rail' })}>
          <IcPanelCollapse />
          <span>Collapse sidebar</span>
        </button>
      </div>
      <div class="side-resizer" onPointerDown={(e) => onResize(e as PointerEvent)} />
    </aside>
  );
}

/** Collapsed rail: Ungrouped first, then each file group, labels running horizontally. */
export function Rail() {
  const groups = tree.value.filter((n): n is GroupNode => n.kind === 'group');
  const loose = tree.value.filter((n) => n.kind === 'note').length;
  const peek = () => (railPeek.value = !railPeek.value);
  return (
    <aside class="rail">
      <button class="icon-btn rail-open" title="Expand sidebar" onClick={() => updateSettings({ tabsMode: 'left' })}>
        <IcPanelExpand />
      </button>
      <PaperButton label={false} cls="rail-paper" />
      <div class="rail-items">
        {loose > 0 && (
          <button class="rail-item rail-loose" title={`Ungrouped (${loose})`} onClick={peek} onContextMenu={(e) => openContextMenu(e as MouseEvent, ungroupedMenu())}>
            <span class="rail-label">Ungrouped</span>
            <span class="rail-count">{loose}</span>
          </button>
        )}
        {groups.map((g) => (
          <button
            key={g.id}
            class="rail-item"
            style={groupVars(g.color)}
            title={g.name}
            onClick={peek}
            onContextMenu={(e) => openContextMenu(e as MouseEvent, groupMenu(g.id))}
          >
            <span class="rail-label">{g.name}</span>
            <span class="rail-count">{countNotes(g)}</span>
          </button>
        ))}
      </div>
      {railPeek.value && (
        <div class="rail-peek" onMouseLeave={() => !drag.value && !renamingId.value && (railPeek.value = false)}>
          <Sidebar />
        </div>
      )}
    </aside>
  );
}

/** Compact rail: a thin strip, Ungrouped first, each file group's name running vertically. */
export function CompactRail() {
  const groups = tree.value.filter((n): n is GroupNode => n.kind === 'group');
  const loose = tree.value.filter((n) => n.kind === 'note').length;
  const peek = () => (railPeek.value = !railPeek.value);
  return (
    <aside class="crail">
      <button class="icon-btn crail-open" title="Expand sidebar" onClick={() => updateSettings({ tabsMode: 'left' })}>
        <IcPanelExpand />
      </button>
      <PaperButton label={false} cls="crail-paper" />
      <div class="crail-items">
        {loose > 0 && (
          <button class="crail-item crail-loose" title={`Ungrouped (${loose})`} onClick={peek} onContextMenu={(e) => openContextMenu(e as MouseEvent, ungroupedMenu())}>
            <span class="crail-label">Ungrouped</span>
            <span class="crail-count">{loose}</span>
          </button>
        )}
        {groups.map((g) => (
          <button
            key={g.id}
            class="crail-item"
            style={groupVars(g.color)}
            title={`${g.name} (${countNotes(g)})`}
            onClick={peek}
            onContextMenu={(e) => openContextMenu(e as MouseEvent, groupMenu(g.id))}
          >
            <span class="crail-label">{g.name}</span>
            <span class="crail-count">{countNotes(g)}</span>
          </button>
        ))}
      </div>
      {railPeek.value && (
        <div class="rail-peek crail-peek" onMouseLeave={() => !drag.value && !renamingId.value && (railPeek.value = false)}>
          <Sidebar />
        </div>
      )}
    </aside>
  );
}
