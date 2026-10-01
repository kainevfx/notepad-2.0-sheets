import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { settings, updateSettings, FONT_CHOICES, type Settings as S } from '../state/settings';
import { settingsOpen, alertMsg, showToast } from '../state/ui';
import { platform, FILE_TYPES, type IntegrationState } from '../platform';
import { IcClose } from './icons';
import { ScaleSlider } from './ScaleSlider';
import { MarginControl } from './MarginControl';
import { ReadAloudSettings } from './ReadAloud';
import { saveFolderPath, fileLocations } from '../state/app';

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={on} disabled={disabled} class={`toggle${on ? ' on' : ''}`} onClick={() => onChange(!on)}>
      <span class="knob" />
      <span class="toggle-label">{on ? 'On' : 'Off'}</span>
    </button>
  );
}

function Row({ title, desc, children }: { title: string; desc?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <div class="set-row">
      <div class="set-text">
        <div class="set-title">{title}</div>
        {desc && <div class="set-desc">{desc}</div>}
      </div>
      <div class="set-control">{children}</div>
    </div>
  );
}

function Select<K extends keyof S>({ k, options }: { k: K; options: [S[K], string][] }) {
  const v = settings.value[k];
  return (
    <select
      class="select"
      value={String(v)}
      onChange={(e) => {
        const raw = (e.target as HTMLSelectElement).value;
        const hit = options.find(([o]) => String(o) === raw);
        if (hit) updateSettings({ [k]: hit[0] } as Partial<S>);
      }}
    >
      {options.map(([o, label]) => (
        <option value={String(o)}>{label}</option>
      ))}
    </select>
  );
}

const bool = (k: keyof S) => (
  <Toggle on={settings.value[k] as boolean} onChange={(v) => updateSettings({ [k]: v } as Partial<S>)} />
);

/** Settings > Saving: the one default save folder, and where your open files are saved. */
function SaveFolder() {
  const [folder, setFolder] = useState('');
  const custom = settings.value.saveFolder;
  useEffect(() => {
    void saveFolderPath().then(setFolder);
  }, [custom]);
  const locations = fileLocations();
  const choose = async () => {
    const p = await platform.pickPath('folder');
    if (p) updateSettings({ saveFolder: p });
  };
  return (
    <>
      <Row
        title="Default save folder"
        desc={
          <>
            New Markdown and text files, notes and TrayNotes are saved here automatically. One folder for every kind of document.
            <div class="set-path" title={folder}>{folder || '…'}</div>
          </>
        }
      >
        <div class="set-buttons">
          <button class="btn" onClick={choose}>Change…</button>
          {custom && (
            <button class="btn" title="Back to Documents\Notepad 2.0" onClick={() => updateSettings({ saveFolder: '' })}>
              Reset
            </button>
          )}
          <button class="btn" disabled={!folder || platform.kind !== 'tauri'} onClick={() => platform.openFolder(folder)}>
            Open
          </button>
        </div>
      </Row>
      <Row title="Where your open files are saved" desc="Files you opened always save back to their own file, in their own folder.">
        <span />
      </Row>
      <div class="set-locations">
        {locations.length === 0 && <div class="set-desc">Nothing saved on disk yet.</div>}
        {locations.map((l) => (
          <div class="set-location" key={l.folder}>
            <span class="set-path" title={l.folder}>{l.folder}</span>
            <span class="set-count">{l.count} file{l.count === 1 ? '' : 's'}</span>
            <button class="btn small" disabled={platform.kind !== 'tauri'} onClick={() => platform.openFolder(l.folder)}>
              Open folder
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function Integration() {
  const [st, setSt] = useState<IntegrationState | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => platform.integrationState().then(setSt).catch(() => setSt(null));
  useEffect(() => {
    refresh();
    const u = platform.onFocus(refresh);
    return () => {
      u.then((f) => f());
    };
  }, []);

  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) showToast(ok);
    } catch (e) {
      await alertMsg('Notepad 2.0', String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (!st) return <div class="set-desc">Reading Windows settings…</div>;
  const allDefault = FILE_TYPES.every((e) => st.defaults[e]);
  const master = st.registered && st.replaceNotepad;

  return (
    <>
      {!st.supported && <div class="set-note">Preview build: these switches only change the real registry in the Windows app.</div>}
      <Row
        title="Use Notepad 2.0 instead of Windows Notepad"
        desc={
          <>
            One reversible switch. On: registers Notepad 2.0 for {FILE_TYPES.join(' ')}, makes anything that runs <code>notepad.exe</code> open
            Notepad 2.0 (one admin prompt), then opens Windows Default apps so you can click <b>Set default</b>. Off: puts Windows Notepad back.
          </>
        }
      >
        <Toggle
          on={master}
          disabled={busy}
          onChange={(on) =>
            run(async () => {
              if (on) {
                await platform.registerFileTypes(FILE_TYPES);
                await platform.setReplaceNotepad(true);
                await platform.openDefaultAppsSettings();
              } else {
                await platform.setReplaceNotepad(false);
                await platform.unregisterFileTypes();
              }
            }, on ? 'Notepad 2.0 is now your Notepad' : 'Windows Notepad restored')
          }
        />
      </Row>

      <div class="set-sub">Details</div>
      <Row
        title="Default app for text files"
        desc={
          <>
            Windows only lets you confirm this yourself, once. The button registers the file types and opens our page in Default apps
            with the <b>Set default</b> button.
            <div class="ext-grid">
              {FILE_TYPES.map((e) => (
                <span class={`ext-pill${st.defaults[e] ? ' yes' : ''}`} title={st.defaults[e] ? 'Opens in Notepad 2.0' : 'Opens in another app'}>
                  {e} {st.defaults[e] ? '✓' : '–'}
                </span>
              ))}
            </div>
          </>
        }
      >
        <button
          class="btn primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await platform.registerFileTypes(FILE_TYPES);
              await platform.openDefaultAppsSettings();
            })
          }
        >
          {allDefault ? 'Open Default apps' : 'Set as default…'}
        </button>
      </Row>
      <Row title="Replace notepad.exe" desc="Run box, scripts, other apps' Edit buttons: anything that starts notepad.exe opens Notepad 2.0 instead. Needs one admin prompt each time you switch it.">
        <Toggle on={st.replaceNotepad} disabled={busy} onChange={(on) => run(() => platform.setReplaceNotepad(on))} />
      </Row>
      <Row title="Windows 11 Notepad app alias" desc="Windows 11 has a second route to the Store Notepad. Turn the Notepad alias off in App execution aliases so every route opens Notepad 2.0.">
        <button class="btn" disabled={busy} onClick={() => run(() => platform.openAliasSettings())}>
          Open App execution aliases
        </button>
      </Row>
      <Row title='"Edit with Notepad 2.0" in the right-click menu' desc="Adds the entry for every file type in File Explorer.">
        <Toggle on={st.contextMenu} disabled={busy} onChange={(on) => run(() => platform.setContextMenu(on))} />
      </Row>
      <Row title="Start with Windows (in the tray)" desc="Keeps the tray icon and the TrayNote hotkey ready after you sign in.">
        <Toggle on={st.startWithWindows} disabled={busy} onChange={(on) => run(() => platform.setStartWithWindows(on))} />
      </Row>
      <Row title="Remove all Windows registrations" desc="Takes Notepad 2.0 out of Default apps, Open with, the right-click menu and notepad.exe. The uninstaller does this too.">
        <button
          class="btn"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await platform.setReplaceNotepad(false);
              await platform.setContextMenu(false);
              await platform.unregisterFileTypes();
            }, 'Registrations removed')
          }
        >
          Remove
        </button>
      </Row>
      {st.exePath && <div class="set-desc mono">Registered program: {st.exePath}</div>}
    </>
  );
}

export function Settings() {
  const s = settings.value;
  return (
    // A dialog over the app (click outside, the X or Esc closes it). The menu bar stays above it,
    // so its menus still open on top.
    <div class="settings-backdrop" onPointerDown={(e) => e.target === e.currentTarget && (settingsOpen.value = false)}>
      <div class="settings-dialog" role="dialog" aria-modal="true" aria-label="Settings">
        <div class="settings-head">
          <h1>Settings</h1>
          <button class="settings-x" title="Close (Esc)" aria-label="Close settings" onClick={() => (settingsOpen.value = false)}>
            <IcClose size={22} />
          </button>
        </div>
        <div class="settings-inner">

        <h2>Appearance</h2>
        <div class="card">
          <Row title="Interface size" desc="Makes the sidebar and the document more compact or roomier. Menus and toolbars stay the same size. Text zoom (Ctrl +/-) is separate.">
            <ScaleSlider />
          </Row>
          <Row title="App theme">
            <div class="seg theme-switch" role="radiogroup" aria-label="App theme">
              {([['light', 'Light'], ['dark', 'Dark'], ['system', 'System']] as const).map(([v, label]) => (
                <button role="radio" aria-checked={s.theme === v} class={s.theme === v ? 'on' : ''} onClick={() => updateSettings({ theme: v })}>
                  {label}
                </button>
              ))}
            </div>
          </Row>
          <Row title="Font" desc={<span style={{ fontFamily: `"${s.fontFamily}"`, fontSize: '13px' }}>The quick brown fox jumps over the lazy dog</span>}>
            <div class="row-controls">
              <select class="select" value={s.fontFamily} onChange={(e) => updateSettings({ fontFamily: (e.target as HTMLSelectElement).value })}>
                {FONT_CHOICES.map((f) => (
                  <option value={f}>{f}</option>
                ))}
              </select>
              <Select k="fontWeight" options={[[300, 'Light'], [400, 'Regular'], [600, 'Semibold'], [700, 'Bold']]} />
              <Select k="fontStyle" options={[['normal', 'Normal'], ['italic', 'Italic']]} />
              <Select k="fontSize" options={[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36].map((n) => [n, `${n}`] as [number, string])} />
            </div>
          </Row>
          <Row title="Word wrap">{bool('wordWrap')}</Row>
          <Row title="Status bar">{bool('statusBar')}</Row>
          <Row title="Spell check">{bool('spellcheck')}</Row>
        </div>

        <h2>Tabs and groups</h2>
        <div class="card">
          <Row title="Tab position" desc="Along the top like Notepad, or down the left with Chrome-style groups. Ctrl+Shift+, switches.">
            <Select k="tabsMode" options={[['top', 'Top'], ['left', 'Left side'], ['rail', 'Left, collapsed rail'], ['compact', 'Left, compact (vertical labels)']]} />
          </Row>
        </div>

        <h2>Paper</h2>
        <div class="card">
          <Row title="Default paper">
            <Select k="paper" options={[['none', 'None'], ['lines', 'Lines'], ['grid', 'Grid'], ['numbers', 'Code']]} />
          </Row>
          <Row title="Page margin" desc="Space between the text and the edges of the page, in every view.">
            <MarginControl />
          </Row>
          <Row title="Also show line numbers on Grid and Lines">{bool('paperNumbers')}</Row>
          <Row title="Red margin rule on Lines">{bool('paperMargin')}</Row>
          <Row title="Remember paper per tab">{bool('paperPerTab')}</Row>
        </div>

        <h2>Markdown</h2>
        <div class="card">
          <Row title="Opening a .md file shows">
            <Select k="mdDefaultView" options={[['visual', 'Visual (WYSIWYG)'], ['edit', 'Source'], ['split', 'Source and preview side by side']]} />
          </Row>
          <Row title="Treat new notes and .txt files as Markdown">{bool('mdForTxt')}</Row>
          <Row title="Block remote images in previews">{bool('blockRemoteImages')}</Row>
        </div>

        <h2>Read aloud</h2>
        <div class="card">
          <ReadAloudSettings Row={Row} />
        </div>

        <h2>Saving</h2>
        <div class="card">
          <SaveFolder />
          <Row title="New notes and TrayNotes" desc="Always saved automatically as you type, as files in the save folder above (named after their first line). Save as puts one somewhere else.">
            <span class="set-fixed">Always on</span>
          </Row>
          <Row title="Autosave files you opened" desc="Off: files only change when you press Ctrl+S, like Notepad. Unsaved edits still survive a crash. Groups can override this (right-click a group).">
            {bool('autosaveFiles')}
          </Row>
          <Row title="Autosave delay">
            <Select k="autosaveDelayMs" options={[[500, '0.5 s'], [1000, '1 s'], [2000, '2 s'], [5000, '5 s'], [10000, '10 s']]} />
          </Row>
          <Row title="Delete empty notes when their tab closes">{bool('deleteEmptyNotesOnClose')}</Row>
        </div>

        <h2>Tray and TrayNote</h2>
        <div class="card">
          <Row title="Close button (X)" desc="Right-click the tray icon and choose Quit to fully exit.">
            <Select k="closeToTray" options={[[true, 'Go to the tray'], [false, 'Quit']]} />
          </Row>
          <Row title="TrayNote size">
            <Select k="quickNoteSize" options={[['eighth', '1/8 of the screen'], ['quarter', '1/4 of the screen']]} />
          </Row>
          <Row title="Hide TrayNote when you click away">{bool('quickNoteHideOnBlur')}</Row>
          <Row title="Keep TrayNote on top">{bool('quickNotePinned')}</Row>
          <Row title="TrayNote shortcut" desc="Works anywhere in Windows.">
            <kbd>Win</kbd> + <kbd>Alt</kbd> + <kbd>N</kbd>
          </Row>
        </div>

        <h2>Windows integration</h2>
        <div class="card">
          <Integration />
        </div>

        <h2>About</h2>
        <div class="card">
          <Row title="Notepad 2.0" desc="Version 0.1.0. Markdown by unified/remark (CommonMark and GitHub Flavored Markdown), editor by CodeMirror.">
            <span />
          </Row>
        </div>
        </div>
      </div>
    </div>
  );
}
