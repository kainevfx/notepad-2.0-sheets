import { cursorInfo, openContextMenu } from '../state/ui';
import { settings } from '../state/settings';
import { activeDoc, setEol, setEncoding, setLanguage, cmd, tree } from '../state/app';
import { EOL_LABEL, encodingLabel, type Encoding, type Eol } from '../lib/encoding';
import { effectiveAutosave } from '../lib/tree-ops';
import { IcMarkdown, IcDoc } from './icons';
import { ScaleSlider } from './ScaleSlider';
import { isBinaryKind, formatBytes } from '../lib/view-kind';
import { fileBadge } from '../lib/file-badge';

export function StatusBar() {
  const s = settings.value;
  if (!s.statusBar) return null;
  const d = activeDoc.value;
  const c = cursorInfo.value;
  const saveMode = !d
    ? ''
    : d.kind === 'note'
      ? d.savedPath ? `${d.quick ? 'TrayNote' : 'Note'} · saved to ${d.savedPath.replace(/[\\/][^\\/]*$/, '').split(/[\\/]/).slice(-2).join('\\')}` : d.quick ? 'TrayNote · autosaved' : 'Note · autosaved'
      : effectiveAutosave(tree.value, d.id, s.autosaveFiles)
        ? 'File · autosave on'
        : d.dirty ? 'Unsaved changes' : 'Saved';

  const encMenu = (e: MouseEvent) => {
    if (!d) return;
    const opts: [Encoding, boolean, string][] = [
      ['utf-8', false, 'UTF-8'],
      ['utf-8', true, 'UTF-8 with BOM'],
      ['utf-16le', true, 'UTF-16 LE'],
      ['utf-16be', true, 'UTF-16 BE'],
      ['windows-1252', false, 'ANSI'],
    ];
    openContextMenu(e, opts.map(([enc, bom, label]) => ({ label, checked: d.encoding === enc && d.bom === bom, action: () => setEncoding(d.id, enc, bom) })));
  };
  const eolMenu = (e: MouseEvent) => {
    if (!d) return;
    openContextMenu(e, (['crlf', 'lf', 'cr'] as Eol[]).map((k) => ({ label: EOL_LABEL[k], checked: d.eol === k, action: () => setEol(d.id, k) })));
  };
  const langMenu = (e: MouseEvent) => {
    if (!d) return;
    openContextMenu(e, [
      { label: 'Plain text', checked: d.language === 'plain', action: () => setLanguage(d.id, 'plain') },
      { label: 'Markdown', checked: d.language === 'markdown', action: () => setLanguage(d.id, 'markdown') },
    ]);
  };
  const zoomMenu = (e: MouseEvent) =>
    openContextMenu(e, [
      { label: 'Zoom in', shortcut: 'Ctrl+Plus', action: () => cmd.zoom(10) },
      { label: 'Zoom out', shortcut: 'Ctrl+Minus', action: () => cmd.zoom(-10) },
      { label: 'Restore default zoom', shortcut: 'Ctrl+0', action: () => cmd.zoom('reset') },
    ]);

  if (d && isBinaryKind(d.viewer))
    return (
      <footer class="statusbar">
        <span class="sb-item">{fileBadge(d).label} · {d.path && /\.xlsx$/i.test(d.path) ? (d.dirty ? 'unsaved changes (Ctrl+S saves)' : 'saved') : 'read-only'}</span>
        <span class="sb-item">{formatBytes(d.size)}</span>
        <span class="sb-flex" />
        <span class="sb-item sb-scale">
          <ScaleSlider compact />
        </span>
      </footer>
    );

  return (
    <footer class="statusbar">
      <button class="sb-item sb-pos" onClick={() => cmd.goToLine()} title="Go to line (Ctrl+G)">
        Ln {c.line}, Col {c.col}
      </button>
      <span class="sb-item sb-chars">
        {c.selected ? `${c.selected.toLocaleString()} of ` : ''}
        {c.chars.toLocaleString()} characters
      </span>
      <span class="sb-item sb-save">{saveMode}</span>
      <span class="sb-flex" />
      {d?.viewer ? (
        <span class="sb-item" title="File type">
          <IcDoc size={14} />
          {fileBadge(d).label}
        </span>
      ) : (
        <button class="sb-item" onClick={(e) => langMenu(e as MouseEvent)} title="Language mode">
          {d?.language === 'markdown' ? <IcMarkdown size={14} /> : <IcDoc size={14} />}
          {d?.language === 'markdown' ? 'Markdown' : 'Plain text'}
        </button>
      )}
      <span class="sb-item sb-scale">
        <ScaleSlider compact />
      </span>
      <button class="sb-item sb-zoom" title="Text zoom" onClick={(e) => zoomMenu(e as MouseEvent)}>
        {s.zoom}%
      </button>
      <button class="sb-item sb-eol" onClick={(e) => eolMenu(e as MouseEvent)} title="Line ending">
        {d ? EOL_LABEL[d.eol] : ''}
      </button>
      <button class="sb-item sb-enc" onClick={(e) => encMenu(e as MouseEvent)} title="Encoding">
        {d ? encodingLabel(d.encoding, d.bom) : ''}
      </button>
    </footer>
  );
}
