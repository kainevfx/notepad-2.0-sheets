import type { MenuItem } from '../state/ui';
import { renamingId, railPeek } from '../state/ui';
import * as T from '../lib/tree-ops';
import {
  docs, tree, closeDoc, closeOthers, newGroupFrom, setGroupColor, collapseAllInside, ungroup, closeGroup,
  setGroupAutosave, moveNode, moveNodeToRoot, newNote, newSheetFile, activate, saveDoc, saveDocAs, QUICK_GROUP_ID, setDocColor, duplicateDoc, copyDoc, pasteInto, docClipboard,
} from '../state/app';
import { platform } from '../platform';
import { settings } from '../state/settings';
import { GROUP_HEX } from './colors';

function moveToGroupItems(nodeId: string): MenuItem[] {
  const items: MenuItem[] = T.allGroups(tree.value)
    .filter(({ group }) => group.id !== nodeId && T.canMove(tree.value, nodeId, group.id, 'inside'))
    .map(({ group, depth }) => ({
      label: `${'  '.repeat(depth - 1)}${group.name}`,
      swatch: GROUP_HEX[group.color],
      action: () => moveNode(nodeId, group.id, 'inside'),
    }));
  if (T.find(tree.value, nodeId)?.parent) items.push({ separator: true }, { label: 'Out of all file groups', action: () => moveNodeToRoot(nodeId) });
  return items.length ? items : [{ label: 'No file groups yet', disabled: true }];
}

/** Show the inline rename field (opening the rail's panel if the sidebar is collapsed). */
export function startRename(id: string) {
  if (settings.value.tabsMode === 'rail') railPeek.value = true;
  renamingId.value = id;
}

/** Where a tab's text lives on disk: its own file, or a note's copy in the save folder. */
const diskPath = (id: string) => {
  const d = docs.value[id];
  return d ? (d.kind === 'file' ? d.path : d.savedPath) ?? null : null;
};

/** File Explorer at each different folder once (the file itself selected). */
function revealAll(ids: string[]) {
  const seen = new Set<string>();
  for (const id of ids) {
    const p = diskPath(id);
    if (!p) continue;
    const folder = p.replace(/[\\/][^\\/]*$/, '').toLowerCase();
    if (seen.has(folder)) continue;
    seen.add(folder);
    void platform.revealInExplorer(p);
  }
}

export function noteMenu(id: string): MenuItem[] {
  const d = docs.value[id];
  if (!d) return [];
  const inGroup = !!T.find(tree.value, id)?.parent;
  const onDisk = diskPath(id);
  return [
    {
      label: onDisk ? 'Open in File Explorer' : 'Open in File Explorer (type something first)',
      action: () => revealAll([id]),
      disabled: !onDisk || platform.kind !== 'tauri',
    },
    { separator: true },
    { label: 'Rename', shortcut: 'F2', action: () => startRename(id) },
    { label: 'Duplicate', action: () => void duplicateDoc(id) },
    { label: 'Copy', action: () => copyDoc(id) },
    ...(d.quick ? [{ label: 'Show in tray window', action: () => void platform.emit('traynote-show', id).then(() => platform.showQuickNote()) }] : []),
    { separator: true },
    { label: 'Add to new group', action: () => newGroupFrom([id]) },
    { label: 'Move to file group', submenu: moveToGroupItems(id) },
    ...(inGroup ? [{ label: 'Remove from file group', action: () => moveNodeToRoot(id) }] : []),
    {
      label: 'Colour',
      submenu: [
        { label: 'None', checked: !d.color, action: () => setDocColor(id, null) },
        ...T.GROUP_COLORS.map((c) => ({ label: c[0].toUpperCase() + c.slice(1), swatch: GROUP_HEX[c], checked: d.color === c, action: () => setDocColor(id, c) })),
      ],
    },
    { separator: true },
    ...(d.kind === 'note'
      ? [
          { label: 'Save as file…', action: () => saveDocAs(id) },
        ]
      : [
          { label: 'Save', shortcut: 'Ctrl+S', action: () => saveDoc(id), disabled: !d.dirty },
          { label: 'Copy path', action: () => navigator.clipboard.writeText(d.path!) },
        ]),
    { separator: true },
    { label: 'Close tab', shortcut: 'Ctrl+W', action: () => closeDoc(id) },
    { label: 'Close other tabs', action: () => closeOthers(id) },
  ];
}

/** Right-click on several selected files: only what works for all of them. */
export function notesMenu(ids: string[]): MenuItem[] {
  const ds = ids.map((id) => docs.value[id]).filter(Boolean);
  const onDisk = ids.filter((id) => diskPath(id));
  const grouped = ids.filter((id) => T.find(tree.value, id)?.parent);
  const dirty = ds.filter((d) => d.kind === 'file' && d.dirty);
  const paths = onDisk.map(diskPath) as string[];
  const n = ids.length;
  const groups = T.allGroups(tree.value)
    .filter(({ group }) => ids.every((id) => T.canMove(tree.value, id, group.id, 'inside')))
    .map(({ group, depth }) => ({
      label: `${'  '.repeat(depth - 1)}${group.name}`,
      swatch: GROUP_HEX[group.color],
      action: () => ids.forEach((id) => moveNode(id, group.id, 'inside')),
    }));
  return [
    { label: 'Open in File Explorer', action: () => revealAll(ids), disabled: !onDisk.length || platform.kind !== 'tauri' },
    { separator: true },
    { label: `Add ${n} files to new group`, action: () => newGroupFrom(ids) },
    { label: 'Move to file group', submenu: groups.length ? groups : [{ label: 'No file groups yet', disabled: true }] },
    ...(grouped.length ? [{ label: 'Remove from file group', action: () => grouped.forEach((id) => moveNodeToRoot(id)) }] : []),
    {
      label: 'Colour',
      submenu: [
        { label: 'None', action: () => ids.forEach((id) => setDocColor(id, null)) },
        ...T.GROUP_COLORS.map((c) => ({ label: c[0].toUpperCase() + c.slice(1), swatch: GROUP_HEX[c], action: () => ids.forEach((id) => setDocColor(id, c)) })),
      ],
    },
    { separator: true },
    { label: dirty.length ? `Save ${dirty.length} changed file${dirty.length === 1 ? '' : 's'}` : 'Save', action: () => void (async () => { for (const d of dirty) await saveDoc(d.id); })(), disabled: !dirty.length },
    { label: 'Copy paths', action: () => navigator.clipboard.writeText(paths.join('\r\n')), disabled: !paths.length },
    { separator: true },
    { label: `Close ${n} tabs`, action: () => void (async () => { for (const id of ids) if (!(await closeDoc(id))) return; })() },
    { label: 'Close other tabs', action: () => void (async () => { for (const id of Object.keys(docs.value)) if (!ids.includes(id) && !(await closeDoc(id))) return; })() },
  ];
}

/** Right-click on empty sidebar space: the Ungrouped area. */
export function ungroupedMenu(): MenuItem[] {
  return [
    { label: 'Paste into Ungrouped', action: () => void pasteInto(null), disabled: !docClipboard.value },
    { separator: true },
    { label: 'New Markdown file', action: () => newNote({ language: 'markdown', groupId: null }) },
    { label: 'New text file', action: () => newNote({ language: 'plain', groupId: null }) },
    { label: 'New sheet', action: () => void newSheetFile() },
    { label: 'New group', shortcut: 'Ctrl+Shift+G', action: () => newGroupFrom([], null) },
  ];
}

export function groupMenu(id: string): MenuItem[] {
  const loc = T.find(tree.value, id);
  if (!loc || loc.node.kind !== 'group') return [];
  const g = loc.node;
  const system = !!g.system;
  const autosaveLabel = g.autosave === undefined ? `follow setting (${settings.value.autosaveFiles ? 'on' : 'off'})` : g.autosave ? 'on' : 'off';
  return [
    ...(system ? [] : [{ label: 'Rename', action: () => startRename(id) }]),
    { label: 'Paste', action: () => void pasteInto(id), disabled: !docClipboard.value },
    { separator: true },
    { label: 'New Markdown file here', action: () => activate(newNote({ groupId: id, language: 'markdown' })) },
    { label: 'New text file here', action: () => activate(newNote({ groupId: id, language: 'plain' })) },
    { label: 'New sheet here', action: () => void newSheetFile(id) },
    ...(system
      ? []
      : [
          { label: 'Colour', submenu: T.GROUP_COLORS.map((c) => ({ label: c[0].toUpperCase() + c.slice(1), swatch: GROUP_HEX[c], checked: g.color === c, action: () => setGroupColor(id, c) })) },
          { label: 'New file group inside…', action: () => newGroupFrom([], id), disabled: loc.depth + 2 > T.MAX_GROUP_DEPTH },
          { label: 'Move into file group', submenu: moveToGroupItems(id) },
        ]),
    { separator: true },
    { label: g.collapsed ? 'Expand' : 'Collapse', action: () => collapseAllInside(id, !g.collapsed) },
    { label: 'Collapse everything inside', action: () => collapseAllInside(id, true) },
    { label: 'Expand everything inside', action: () => collapseAllInside(id, false) },
    { separator: true },
    {
      label: `Autosave opened files: ${autosaveLabel}`,
      submenu: [
        { label: 'Follow the global setting', checked: g.autosave === undefined, action: () => setGroupAutosave(id, undefined) },
        { label: 'Always autosave files in this file group', checked: g.autosave === true, action: () => setGroupAutosave(id, true) },
        { label: 'Never autosave files in this file group', checked: g.autosave === false, action: () => setGroupAutosave(id, false) },
      ],
    },
    { separator: true },
    ...(system ? [] : [{ label: 'Ungroup', action: () => ungroup(id) }]),
    { label: id === QUICK_GROUP_ID ? 'Close all TrayNotes' : 'Close file group', danger: true, action: () => closeGroup(id) },
  ];
}
