// Screenshot tour of the browser build (Tauri layer mocked). Usage: npm run build && npm run shots
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const OUT = process.env.SHOTS_DIR || new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = 4174;
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'pipe' });
await new Promise((res, rej) => {
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && res());
  server.on('exit', rej);
  setTimeout(res, 6000);
});

const browser = await chromium.launch();
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const DEFAULTS = { theme: 'dark', tabsMode: 'top', paper: 'none', paperNumbers: false, mdDefaultView: 'split', fontFamily: 'Consolas', fontSize: 11, zoom: 100, wordWrap: true, statusBar: true, firstRunDone: true };

async function setup(patch) {
  await page.evaluate((s) => localStorage.setItem('np2.store:settings.json', JSON.stringify(s)), { ...DEFAULTS, ...patch });
  await page.reload();
  await page.waitForSelector('.cm-editor');
  await page.waitForTimeout(700);
}
async function shot(name) {
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log('shot', name);
}
async function activateByTitle(t) {
  const el = page.locator('.side-note, .tab', { hasText: t }).first();
  await el.click();
  await page.waitForTimeout(400);
}

await page.goto(BASE + '/');
await page.evaluate(() => localStorage.clear());
await setup({});

// 1. Pure Notepad look: top tabs, light, plain text file
await setup({ theme: 'light', tabsMode: 'top' });
await activateByTitle('Meeting Note 1');
await shot('01-top-tabs-light');

// 2. Dark, top tabs, markdown split preview
await setup({ theme: 'dark', tabsMode: 'top' });
await activateByTitle('Business strategy');
await page.waitForTimeout(1500);
await shot('02-top-tabs-dark-md-split');

// 3. Vertical tabs + groups + split preview (mockup 1)
await setup({ theme: 'dark', tabsMode: 'left' });
await activateByTitle('Business strategy');
await page.waitForTimeout(1500);
await shot('03-left-groups-md-split');

// 4. Lines paper + numbers (mockup 2), markdown in edit view
await setup({ theme: 'dark', tabsMode: 'left', paper: 'lines', paperNumbers: true });
await activateByTitle('Business strategy');
await page.locator('.seg button', { hasText: 'Edit' }).click();
await page.waitForTimeout(300);
await shot('04-lines-paper');

// 5. Numbers mode (mockup 3)
await setup({ theme: 'dark', tabsMode: 'left', paper: 'numbers' });
await shot('05-numbers');

// 6. Grid + rail (mockup 4) with the paper popover open
await setup({ theme: 'dark', tabsMode: 'rail', paper: 'grid', paperNumbers: true });
await page.locator('.paper-anchor .icon-btn').click();
await page.waitForTimeout(250);
await shot('06-grid-rail-paper-popover');

// 7. Light grid, preview only
await setup({ theme: 'light', tabsMode: 'left', paper: 'grid' });
await page.locator('.seg button', { hasText: 'Preview' }).click();
await page.waitForTimeout(1800);
await shot('07-light-preview-only');
await page.locator('.seg button', { hasText: 'Split' }).click();

// 8. Group context menu
await setup({ theme: 'dark', tabsMode: 'left' });
await page.locator('.side-group-head', { hasText: 'Development' }).click({ button: 'right' });
await page.waitForTimeout(200);
await page.locator('.menu-item', { hasText: 'Colour' }).hover();
await page.waitForTimeout(200);
await shot('08-group-context-menu');
await page.keyboard.press('Escape');

// 9. Drag Meeting Note 3 into Project Alpha (real pointer drag)
const src = page.locator('.side-note', { hasText: 'Meeting Note 3' });
const dst = page.locator('.side-group-head', { hasText: 'Project Alpha' });
const sb = await src.boundingBox();
const db = await dst.boundingBox();
await page.mouse.move(sb.x + 40, sb.y + sb.height / 2);
await page.mouse.down();
await page.mouse.move(sb.x + 60, sb.y + 10, { steps: 4 });
await page.mouse.move(db.x + 80, db.y + db.height / 2, { steps: 12 });
await page.waitForTimeout(150);
await shot('09-dragging-into-group');
await page.mouse.up();
await page.waitForTimeout(300);
const inAlpha = await page.evaluate(() => {
  const head = [...document.querySelectorAll('.side-group-head')].find((h) => h.textContent.includes('Project Alpha'));
  return head.parentElement.querySelector('.side-group-body').textContent.includes('Meeting Note 3');
});
console.log('drag result: Meeting Note 3 inside Project Alpha =', inAlpha);
await shot('10-after-drop');

// 11. Settings page, Windows integration section
await setup({ theme: 'dark', tabsMode: 'top' });
await page.locator('.icon-btn[title=Settings]').click();
await page.waitForTimeout(300);
await page.locator('h2', { hasText: 'Windows integration' }).scrollIntoViewIfNeeded();
await page.evaluate(() => document.querySelector('.settings-dialog .settings-inner').scrollBy(0, 200));
await shot('11-settings-integration');
await page.keyboard.press('Escape');

// 12. Find bar and save prompt
await activateByTitle('Meeting Note 2');
await page.locator('.cm-content').click();
await page.keyboard.press('Control+f');
await page.keyboard.type('capture');
await page.waitForTimeout(200);
await shot('12-find');
await page.keyboard.press('Escape');
await page.locator('.cm-content').click();
await page.keyboard.press('Control+End');
await page.keyboard.type('\nedited line');
await page.keyboard.press('Control+w');
await page.waitForTimeout(250);
await shot('13-save-prompt');
await page.locator('.modal .btn', { hasText: 'Cancel' }).click();

// 14. TrayNote window
const qn = await ctx.newPage();
qn.on('pageerror', (e) => errors.push('qn: ' + String(e)));
await qn.setViewportSize({ width: 440, height: 560 });
await qn.goto(BASE + '/quicknote.html');
await qn.waitForSelector('.cm-editor');
await qn.waitForTimeout(500);
await qn.keyboard.press('Control+End');
await qn.keyboard.type('\nRemember: spare HDMI + capture card');
await qn.waitForTimeout(700);
await qn.screenshot({ path: `${OUT}14-quick-note.png` });
console.log('shot 14-quick-note');

// Quick note reached the main window's TrayNotes group?
await page.waitForTimeout(400);
await setup({ theme: 'dark', tabsMode: 'left' });
await page.locator('.side-group-head', { hasText: 'TrayNotes' }).click();
await page.waitForTimeout(200);
const qnText = await page.locator('.side-group', { hasText: 'TrayNotes' }).first().textContent();
console.log('quick notes group:', qnText.slice(0, 120));
await shot('15-quick-notes-group');

// Persistence: dirty file edit survives a reload (crash recovery)
const dirtyAfterReload = await page.evaluate(() => [...document.querySelectorAll('.side-close.dirty')].length);
console.log('dirty tabs restored after reload:', dirtyAfterReload);

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
server.kill();
