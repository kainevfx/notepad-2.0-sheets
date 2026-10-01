// Sheet editor check (browser build, Tauri mocked): opens a workbook, freezes, sorts, filters,
// edits and saves, and takes screenshots. Usage: npm run build && SHEET=path/to/file.xlsx node e2e/sheet-check.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./out/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const PORT = 4180;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'pipe', shell: process.platform === 'win32' });
await new Promise((res) => {
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && res());
  setTimeout(res, 8000);
});
const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
const page = await (await browser.newContext({ viewport: { width: 1400, height: 860 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const PATH = 'C:\\Users\\Kaine\\Documents\\HL.xlsx';
const b64 = readFileSync(process.env.SHEET).toString('base64');
const shot = (n) => page.screenshot({ path: `${OUT}sheet-${n}.png` });
try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(2000);
  await page.evaluate(({ PATH, b64 }) => {
    localStorage.setItem('np2.store:settings.json', JSON.stringify({ theme: 'dark', tabsMode: 'left', firstRunDone: true }));
    const fs = JSON.parse(localStorage.getItem('np2.mockfs') || '{}');
    fs[PATH] = { b64, mtime: Date.now() };
    localStorage.setItem('np2.mockfs', JSON.stringify(fs));
  }, { PATH, b64 });
  await page.goto(`http://127.0.0.1:${PORT}/?open=${encodeURIComponent(PATH)}`);
  await page.waitForTimeout(5000);
  if (!(await page.locator('.sh-grid .sc').count())) {
    await shot('0-debug');
    console.log('E', JSON.stringify(errors), await page.evaluate(() => document.querySelector('.main-col')?.innerText?.slice(0, 400)));
  }
  await page.waitForSelector('.sh-grid .sc', { timeout: 20000 });
  await page.waitForTimeout(800);
  await shot('1-open');
  const info = await page.evaluate(() => ({ cells: document.querySelectorAll('.sh-grid .sc').length, frozenTop: getComputedStyle(document.querySelector('.sh-grid')).getPropertyValue('--top'), left: getComputedStyle(document.querySelector('.sh-grid')).getPropertyValue('--left') }));
  console.log('open', JSON.stringify(info));
  // Scroll the body; frozen panes stay.
  await page.evaluate(() => { const b = document.querySelector('.sh-mm'); b.scrollTop = 3000; b.scrollLeft = 600; });
  await page.waitForTimeout(300);
  await shot('2-scrolled');
  // Filter
  await page.locator('.sh-filter input').click();
  await page.keyboard.type('Phase: 4');
  await page.waitForTimeout(200);
  await shot('3-suggest');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  console.log('status', await page.locator('.sh-status').innerText());
  await page.keyboard.type('Squid');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  console.log('status2', await page.locator('.sh-status').innerText());
  await shot('4-filtered');
  // Clear filters
  await page.locator('.sh-chip button').first().click();
  await page.locator('.sh-chip button').first().click();
  // Click a cell, type, enter
  await page.evaluate(() => { const b = document.querySelector('.sh-mm'); b.scrollTop = 0; b.scrollLeft = 0; });
  await page.waitForTimeout(200);
  const cell = page.locator('.sh-mm .sc[data-r="11"][data-c="5"]');
  await cell.click();
  await page.keyboard.type('Complete');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  console.log('F12 now', await page.locator('.sh-mm .sc[data-r="11"][data-c="5"]').innerText().catch(() => '?'));
  // Column header right-click → sort Z→A
  await page.locator('.sh-ch[data-ch="1"]').click({ button: 'right' });
  await page.waitForTimeout(150);
  await page.locator('.menu-item', { hasText: 'Sort Z → A' }).first().click();
  await page.waitForTimeout(300);
  console.log('B11 after sort', await page.locator('.sc[data-r="10"][data-c="1"]').innerText().catch(() => '?'));
  // Undo
  await page.locator('.sh-grid').click({ position: { x: 300, y: 300 } });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  console.log('B11 after undo', await page.locator('.sc[data-r="10"][data-c="1"]').innerText().catch(() => '?'));
  // Freeze column G to the right
  await page.locator('.sh-tm .sh-ch[data-ch="6"]').click();
  await page.locator('.sh-tm .sh-ch[data-ch="6"]').click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Freeze to the right' }).click();
  await page.waitForTimeout(300);
  await shot('5-freeze-right');
  console.log('state', JSON.stringify(await page.evaluate(() => {
    const s = [...window.__np2Sheets.values()][0];
    const sh = s.hist.present[s.active];
    const t = (r) => (sh.rows[r] || []).slice(0, 3).map((c) => (c ? String(c.v) : '.')).join('|');
    const mm = document.querySelector('.sh-mm');
    const cells = [...mm.querySelectorAll('.sc')].filter((e) => e.dataset.c === '3').map((e) => [e.dataset.r, e.style.top, e.style.height, e.innerText.slice(0, 12)]);
    const hdrs = [...document.querySelectorAll('.sh-ml .sh-rh')].map((e) => [e.dataset.rh, e.style.top]);
    return { st: mm.scrollTop, cells, hdrs, past: s.hist.past.length, future: s.hist.future.length, freeze: sh.freeze, filters: s.filters, r10: t(10), r11: t(11), h10: sh.heights[10], h11: sh.heights[11] };
  })));
  // Fit columns
  await page.locator('.sh-drop', { hasText: 'Fit' }).click();
  await page.locator('.fb-menu-item', { hasText: 'Fit rows to data height' }).click();
  await page.waitForTimeout(400);
  await shot('6-fit-rows');
  // Alternating colours on a selection
  await page.evaluate(() => { const b = document.querySelector('.sh-mm'); b.scrollTop = 0; b.scrollLeft = 0; });
  await page.waitForTimeout(300);
  await page.locator('.sh-mm .sc[data-r="10"][data-c="3"]').click();
  for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowRight');
  await page.locator('.sh-tbtn', { hasText: 'Alternating colours' }).click();
  await page.waitForTimeout(200);
  await shot('7-bands-dialog');
  await page.locator('.btn.primary', { hasText: 'Apply' }).click();
  // Edit a long cell
  await page.evaluate(() => { const b = document.querySelector('.sh-mm'); b.scrollLeft = 2600; });
  await page.waitForTimeout(300);
  await page.locator('.sh-mm .sc[data-r="10"][data-c="19"]').dblclick({ timeout: 5000 }).catch((e) => console.log('dbl fail', String(e).slice(0, 80)));
  await page.waitForTimeout(200);
  await shot('8-edit-long');
  await page.keyboard.press('Escape');
  // Save
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(1500);
  const saved = await page.evaluate((PATH) => { const fs = JSON.parse(localStorage.getItem('np2.mockfs')); return { size: fs[PATH] ? atob(fs[PATH].b64).length : 0, bak: !!fs[PATH + '.bak'] }; }, PATH);
  console.log('saved', JSON.stringify(saved));
  await shot('9-after-save');
  // Light theme + Original colours
  console.log('errors', JSON.stringify(errors));
} finally {
  await browser.close();
  server.kill();
}
