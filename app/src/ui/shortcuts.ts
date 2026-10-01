// Notepad's keyboard shortcuts plus ours. Runs on window keydown, after CodeMirror had its turn.
import {
  newNote, openWithDialog, saveDoc, saveDocAs, saveAll, closeDoc, activeId, cmd, hideToTray, cycleMdView, newGroupFrom, getView, toggleSplit,
} from '../state/app';
import { settingsOpen, dialog, paperPopoverOpen } from '../state/ui';
import { platform } from '../platform';
import { settings, updateSettings, clampScale } from '../state/settings';
import { uiScaleStep } from '../lib/scale-keys';
import { toggleReadAloud } from '../speech/commands';
import { startRename } from './menus';

export function installShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (dialog.value) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const id = activeId.value;
    const run = (fn: () => unknown) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };

    // The sheet editor handles its own editing keys (undo, find, copy, bold…, F2 edits a cell).
    const inSheet = !!(e.target as HTMLElement | null)?.closest?.('.sh');
    if (inSheet && (e.key === 'F2' || e.key === 'F3' || (mod && !e.altKey && !e.shiftKey && 'zyafhbiucxv'.includes(k) && k.length === 1) || (mod && e.shiftKey && k === 'z'))) return;
    if (e.key === 'F5' && !mod) return run(cmd.timeDate);
    if (e.key === 'F3') return run(() => cmd.findNext(e.shiftKey));
    if (e.key === 'F2' && !mod && id && !(e.target as HTMLElement | null)?.closest?.('input, textarea')) return run(() => startRename(id));
    if (e.key === 'Escape' && settingsOpen.value) return run(() => (settingsOpen.value = false));
    if (e.key === 'Escape' && paperPopoverOpen.value) return run(() => (paperPopoverOpen.value = false));
    // Interface size: Shift +/- outside the text, Ctrl+Shift +/- anywhere.
    const inText = !!(e.target as HTMLElement | null)?.closest?.('.cm-content, .ProseMirror, input, textarea, select, [contenteditable="true"]');
    const step = uiScaleStep(e, inText);
    if (step) return run(() => updateSettings({ uiScale: clampScale(settings.value.uiScale + step) }));
    if (!mod) return;
    // Split view on/off.
    if (!e.shiftKey && !e.altKey && (e.key === '\\' || e.code === 'Backslash')) return run(toggleSplit);

    if (e.shiftKey && !e.altKey) {
      switch (k) {
        case 's': return run(() => id && saveDocAs(id));
        case 'n': return run(() => platform.showQuickNote());
        case 'w': return run(() => hideToTray());
        case 'v': return run(cycleMdView);
        case 'g': return run(() => id && newGroupFrom([id]));
        case ',': case '<': return run(cmd.toggleTabsMode);
        case 'tab': return run(() => cmd.cycleTab(-1));
      }
      if (e.code === 'Comma') return run(cmd.toggleTabsMode);
      return;
    }
    if (e.altKey) {
      if (k === 's') return run(saveAll);
      if (k === 'n') return run(() => newNote({ language: 'markdown' }));
      if (k === 'r') return run(() => void toggleReadAloud());
      return;
    }
    switch (k) {
      case 'n': case 't': return run(() => newNote({ language: 'plain' }));
      case 'o': return run(openWithDialog);
      case 's': return run(() => id && saveDoc(id));
      case 'w': case 'f4': return run(() => id && closeDoc(id));
      case 'p': return run(cmd.print);
      case 'f': return run(cmd.find);
      case 'h': return run(cmd.replace);
      case 'g': return run(() => cmd.goToLine());
      case '=': case '+': return run(() => cmd.zoom(10));
      case '-': case '_': return run(() => cmd.zoom(-10));
      case '0': return run(() => cmd.zoom('reset'));
      case 'tab': return run(() => cmd.cycleTab(1));
      case ',': return run(() => (settingsOpen.value = !settingsOpen.value));
    }
    if (/^[1-9]$/.test(k)) return run(() => cmd.goToTab(Number(k)));
    // Undo/redo/select all when focus is outside the editor (sidebar, menus).
    // (The Visual editor handles these itself.)
    const v = getView();
    if (v && !v.hasFocus && !(e.target as HTMLElement | null)?.closest?.('.visual-editor')) {
      if (k === 'z') return run(cmd.undo);
      if (k === 'y') return run(cmd.redo);
      if (k === 'a' && !(e.target instanceof HTMLInputElement)) return run(cmd.selectAll);
    }
  }, true);

  // Ctrl + mouse wheel zoom, like Notepad.
  window.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      cmd.zoom(e.deltaY < 0 ? 10 : -10);
    },
    { passive: false },
  );
}
