import { useEffect, useState } from 'preact/hooks';
import type { MenuItem } from '../state/ui';
import { settingsOpen, paperPopoverOpen, closedNotesOpen, openContextMenu } from '../state/ui';
import { settings, updateSettings, isDark } from '../state/settings';
import { newSheetFile,
  activeDoc, activeId, newNote, openWithDialog, saveDoc, saveDocAs, saveAll, closeDoc, cmd, recentFiles, openFiles, hideToTray,
  quitApp, setLanguage, cycleMdView, effectivePaper, refreshView, newGroupFrom, closedNotes, setPaper, saveSheetCsv, panes, toggleSplit, activeView, setPaneView,
} from '../state/app';
import { platform } from '../platform';
import { MenuList } from './MenuList';
import { IcSidebar, IcTabsTop, IcSplit } from './icons';
import { insertMenu, helpMenu } from './insert-actions';
import { TABS_MODES, tabsModeLabel } from '../lib/tabs-modes';
import { resetPaperOwner } from './PaperButton';
import { readAloudItems } from './ReadAloud';

type MenuName = 'File' | 'Edit' | 'Insert' | 'View' | 'Help';

const rectOf = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.bottom + 2 };
};

function fileMenu(): MenuItem[] {
  const d = activeDoc.value;
  const recent = recentFiles.value;
  return [
    { label: 'New text file', shortcut: 'Ctrl+N', action: () => newNote({ language: 'plain' }) },
    { label: 'New Markdown file', shortcut: 'Ctrl+Alt+N', action: () => newNote({ language: 'markdown' }) },
    { label: 'New sheet', action: () => void newSheetFile() },
    { label: 'New TrayNote', shortcut: 'Win+Alt+N', action: () => platform.showQuickNote() },
    { label: 'Open', shortcut: 'Ctrl+O', action: () => openWithDialog() },
    {
      label: 'Recent',
      disabled: !recent.length,
      submenu: recent.length ? recent.map((p) => ({ label: p, action: () => openFiles([p]) })) : [{ label: 'Nothing yet', disabled: true }],
    },
    { label: `Closed notes (${closedNotes.value.length})`, action: () => (closedNotesOpen.value = true) },
    { separator: true },
    { label: 'Save', shortcut: 'Ctrl+S', action: () => d && saveDoc(d.id), disabled: !d },
    { label: 'Save as', shortcut: 'Ctrl+Shift+S', action: () => d && saveDocAs(d.id), disabled: !d },
    { label: 'Save all', shortcut: 'Ctrl+Alt+S', action: () => saveAll() },
    ...(d?.viewer === 'sheet' ? [{ label: 'Save sheet as CSV…', action: () => saveSheetCsv(d.id) }] : []),
    { separator: true },
    { label: 'Print', shortcut: 'Ctrl+P', action: () => cmd.print() },
    { separator: true },
    { label: 'Close tab', shortcut: 'Ctrl+W', action: () => d && closeDoc(d.id) },
    { label: 'Close window (to tray)', shortcut: 'Ctrl+Shift+W', action: () => hideToTray() },
    { label: 'Exit', action: () => quitApp() },
  ];
}

function editMenu(): MenuItem[] {
  return [
    { label: 'Undo', shortcut: 'Ctrl+Z', action: cmd.undo },
    { label: 'Redo', shortcut: 'Ctrl+Y', action: cmd.redo },
    { separator: true },
    { label: 'Cut', shortcut: 'Ctrl+X', action: cmd.cut },
    { label: 'Copy', shortcut: 'Ctrl+C', action: cmd.copy },
    { label: 'Paste', shortcut: 'Ctrl+V', action: cmd.paste },
    { label: 'Delete', shortcut: 'Del', action: cmd.del },
    { separator: true },
    { label: 'Find', shortcut: 'Ctrl+F', action: cmd.find },
    { label: 'Replace', shortcut: 'Ctrl+H', action: cmd.replace },
    { label: 'Go to', shortcut: 'Ctrl+G', action: () => cmd.goToLine() },
    { separator: true },
    { label: 'Select all', shortcut: 'Ctrl+A', action: cmd.selectAll },
    { label: 'Time/Date', shortcut: 'F5', action: cmd.timeDate },
    { separator: true },
    { label: 'Font', action: () => (settingsOpen.value = true) },
  ];
}

function viewMenu(): MenuItem[] {
  const s = settings.value;
  const d = activeDoc.value;
  const paper = effectivePaper(d);
  const setP = (p: typeof paper) => () => setPaper(p);
  return [
    {
      label: 'Zoom',
      submenu: [
        { label: 'Zoom in', shortcut: 'Ctrl+Plus', action: () => cmd.zoom(10) },
        { label: 'Zoom out', shortcut: 'Ctrl+Minus', action: () => cmd.zoom(-10) },
        { label: 'Restore default zoom', shortcut: 'Ctrl+0', action: () => cmd.zoom('reset') },
      ],
    },
    { label: 'Dark mode', checked: isDark(), action: () => updateSettings({ theme: isDark() ? 'light' : 'dark' }) },
    { label: 'Status bar', checked: s.statusBar, action: () => updateSettings({ statusBar: !s.statusBar }) },
    {
      label: 'Word wrap',
      checked: s.wordWrap,
      action: () => {
        updateSettings({ wordWrap: !s.wordWrap });
        refreshView();
      },
    },
    { label: 'Split view', shortcut: 'Ctrl+\\', checked: panes.value.on, action: () => toggleSplit() },
    { separator: true },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Along the top', checked: s.tabsMode === 'top', action: () => updateSettings({ tabsMode: 'top' }) },
        { label: 'Down the left side', checked: s.tabsMode === 'left', action: () => updateSettings({ tabsMode: 'left' }) },
        { label: 'Collapsed rail', checked: s.tabsMode === 'rail', action: () => updateSettings({ tabsMode: 'rail' }) },
        { label: 'Compact (vertical labels)', checked: s.tabsMode === 'compact', action: () => updateSettings({ tabsMode: 'compact' }) },
        { separator: true },
        { label: 'New file group from this file', shortcut: 'Ctrl+Shift+G', action: () => activeId.value && newGroupFrom([activeId.value]) },
      ],
    },
    {
      label: 'Paper',
      submenu: [
        { label: 'Grid', checked: paper === 'grid', action: setP('grid') },
        { label: 'Lines', checked: paper === 'lines', action: setP('lines') },
        { label: 'Code', checked: paper === 'numbers', action: setP('numbers') },
        { label: 'None', checked: paper === 'none', action: setP('none') },
        { separator: true },
        { label: 'Page margin…', action: () => setTimeout(() => (resetPaperOwner(), (paperPopoverOpen.value = true)), 0) },
        { separator: true },
        { label: 'Also show line numbers', checked: s.paperNumbers, action: () => { updateSettings({ paperNumbers: !s.paperNumbers }); refreshView(); } },
      ],
    },
    { label: 'Read aloud', submenu: readAloudItems() },
    {
      label: 'Markdown',
      disabled: !!d?.viewer,
      submenu: [
        { label: 'Visual', checked: d?.language === 'markdown' && activeView(d) === 'visual', action: () => d && setPaneView(panes.value.active, 'visual') },
        { label: 'Source', checked: d?.language === 'markdown' && activeView(d) === 'edit', action: () => d && setPaneView(panes.value.active, 'edit') },
        { label: 'Source and preview', checked: d?.language === 'markdown' && activeView(d) === 'split', action: () => d && setPaneView(panes.value.active, 'split') },
        { label: 'Cycle views', shortcut: 'Ctrl+Shift+V', action: () => cycleMdView() },
        { separator: true },
        { label: 'Treat this tab as plain text', checked: d?.language === 'plain', action: () => d && setLanguage(d.id, d.language === 'plain' ? 'markdown' : 'plain') },
      ],
    },
  ];
}

export function MenuBar() {
  const [open, setOpen] = useState<MenuName | null>(null);
  const [anchor, setAnchor] = useState({ left: 0, top: 0 });
  const s = settings.value;

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', close);
    };
  }, [open]);

  const items =
    open === 'File' ? fileMenu() : open === 'Edit' ? editMenu() : open === 'Insert' ? insertMenu() : open === 'View' ? viewMenu() : open === 'Help' ? helpMenu() : [];
  const btn = (name: MenuName) => (
    <button
      class={`menubar-btn${open === name ? ' open' : ''}`}
      onPointerDown={(e) => {
        e.stopPropagation();
        setAnchor(rectOf(e.currentTarget as HTMLElement));
        setOpen(open === name ? null : name);
      }}
      onMouseEnter={(e) => {
        if (open && open !== name) {
          setAnchor(rectOf(e.currentTarget as HTMLElement));
          setOpen(name);
        }
      }}
    >
      {name}
    </button>
  );


  return (
    <div class="menubar">
      {btn('File')}
      {btn('Edit')}
      {btn('Insert')}
      {btn('View')}
      <button
        class={`menubar-btn${settingsOpen.value ? ' open' : ''}`}
        onPointerDown={(e) => {
          e.stopPropagation();
          setOpen(null);
        }}
        onClick={() => (settingsOpen.value = !settingsOpen.value)}
      >
        Settings
      </button>
      {btn('Help')}
      {open && <MenuList items={items} onDone={() => setOpen(null)} style={{ position: 'fixed', left: `${anchor.left}px`, top: `${anchor.top}px` }} />}
      <div class="menubar-spacer" />
      <button
        class="icon-btn labeled"
        title="Tab layout: top, left, rail or compact (Ctrl+Shift+, cycles)"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) =>
          openContextMenu(
            e as MouseEvent,
            TABS_MODES.map((t) => ({ label: `${t.label} · ${t.hint}`, checked: s.tabsMode === t.mode, action: () => updateSettings({ tabsMode: t.mode }) })),
          )
        }
      >
        {s.tabsMode === 'top' ? <IcTabsTop /> : <IcSidebar />}
        <span>{tabsModeLabel(s.tabsMode)}</span>
      </button>
      <button
        class={`icon-btn labeled${panes.value.on ? ' pressed' : ''}`}
        title="Split view: two documents side by side (Ctrl+\\)"
        aria-pressed={panes.value.on}
        onClick={() => toggleSplit()}
      >
        <IcSplit />
        <span>Split</span>
      </button>
    </div>
  );
}
