// Reading and writing .xlsx for the sheet editor (ExcelJS, chosen in Phase C0: a round trip of
// HalloweenLoops-Production.xlsx kept every value, style, width, height, freeze, merge, table,
// dropdown and rule).
//
// Files made by the .NET Open XML SDK (and some Python tools) use prefixed tags (<x:sheet>) and
// absolute part paths ("/xl/workbook.xml") that ExcelJS can't read, so the package is tidied up
// first (same XML, plain tags, relative paths). ExcelJS also forgets the text of "cell contains"
// rules, so those are read from the XML and put back.
import JSZip from 'jszip';
import type { Workbook as XWorkbook, Worksheet } from 'exceljs';
import {
  newSheet, emptyFreeze, keyOf, detectHeader, excelFreeze,
  type SheetState, type Row, type Rect, type Band, type XStyle, type CellValue,
} from './model';

const STRIP = [
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://schemas.openxmlformats.org/package/2006/relationships',
  'http://schemas.openxmlformats.org/package/2006/content-types',
];

/** Plain tags for the main namespaces; absolute relationship targets made relative. */
export function normalizePart(name: string, xml: string): string {
  let s = xml;
  for (const uri of STRIP) {
    const m = new RegExp(`xmlns:(\\w+)="${uri.replace(/[./]/g, '\\$&')}"`).exec(s);
    if (!m) continue;
    s = s.replace(new RegExp(`<(/?)${m[1]}:`, 'g'), '<$1').replace(m[0], `xmlns="${uri}"`);
  }
  if (name.endsWith('.rels')) {
    const owner = name.replace(/_rels\/[^/]*\.rels$/, '').split('/').filter(Boolean);
    s = s.replace(/Target="\/([^"]*)"/g, (_m, abs: string) => {
      const to = abs.split('/');
      let i = 0;
      while (i < owner.length && i < to.length - 1 && owner[i] === to[i]) i++;
      return `Target="${'../'.repeat(owner.length - i)}${to.slice(i).join('/')}"`;
    });
  }
  return s;
}

/** "B3" → {r: 2, c: 1}. */
export function parseAddr(a: string): { r: number; c: number } | null {
  const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(a.trim());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]) - 1, c: c - 1 };
}

export function parseRef(ref: string): Rect[] {
  return ref
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      const [a, b] = part.split(':');
      const x = parseAddr(a);
      const y = parseAddr(b ?? a);
      return x && y ? { r1: Math.min(x.r, y.r), c1: Math.min(x.c, y.c), r2: Math.max(x.r, y.r), c2: Math.max(x.c, y.c) } : null;
    })
    .filter(Boolean) as Rect[];
}

const addr = (r: number, c: number) => {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return `${s}${r + 1}`;
};
export const refOf = (x: Rect) => `${addr(x.r1, x.c1)}:${addr(x.r2, x.c2)}`;

const BAND_RE = /^MOD\(ROW\(\),2\)=(0|1)$/i;

export interface LoadedBook {
  xwb: XWorkbook;
  sheets: SheetState[];
}

async function excel() {
  const m: any = await import('exceljs');
  return (m.default ?? m) as typeof import('exceljs');
}

export async function loadXlsx(bytes: Uint8Array): Promise<LoadedBook> {
  const zip = await JSZip.loadAsync(bytes);
  // Text of "cell contains" rules, per sheet part, in document order.
  const ruleText = new Map<string, string[]>();
  for (const name of Object.keys(zip.files)) {
    const f = zip.files[name];
    if (f.dir || !/\.(xml|rels)$/i.test(name)) continue;
    const xml = await f.async('string');
    const fixed = normalizePart(name, xml);
    if (/^xl\/worksheets\/[^/]+\.xml$/i.test(name)) {
      // The text is in the rule's text="…", or else in its SEARCH("…", …) formula.
      ruleText.set(
        name.split('/').pop()!,
        [...fixed.matchAll(/<cfRule\b[^>]*\btype="containsText"[^>]*?(?:\/>|>([\s\S]*?)<\/cfRule>)/g)].map(
          (m) => /\btext="([^"]*)"/.exec(m[0])?.[1] ?? /SEARCH\((?:&quot;|")(.*?)(?:&quot;|"),/.exec(m[1] ?? '')?.[1] ?? '',
        ),
      );
    }
    if (fixed !== xml) zip.file(name, fixed);
  }
  const ExcelJS = await excel();
  const xwb = new ExcelJS.Workbook();
  await xwb.xlsx.load(await zip.generateAsync({ type: 'uint8array' }) as any);
  const sheets = xwb.worksheets.map((ws, i) => readSheet(ws, ruleText.get(`sheet${i + 1}.xml`) ?? []));
  return { xwb, sheets };
}

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function readSheet(ws: Worksheet, texts: string[]): SheetState {
  const s = newSheet(ws.name, 0, 0);
  const rows: Row[] = [];
  const heights: (number | undefined)[] = [];
  ws.eachRow({ includeEmpty: true }, (row, rn) => {
    const r = rn - 1;
    const out: Row = [];
    row.eachCell({ includeEmpty: true }, (cell, cn) => {
      const c = cn - 1;
      const merged = cell.isMerged && cell.master !== cell;
      const v = merged ? null : (cell.value as CellValue) ?? null;
      const xs = cell.style && Object.keys(cell.style).length ? (JSON.parse(JSON.stringify(cell.style)) as XStyle) : undefined;
      if (v != null || xs) out[c] = { v, xs };
    });
    rows[r] = out;
    if (row.height) heights[r] = row.height;
  });
  for (let r = 0; r < rows.length; r++) if (!rows[r]) rows[r] = [];
  const widths: (number | undefined)[] = [];
  const cc = ws.columnCount;
  for (let c = 0; c < cc; c++) widths[c] = ws.getColumn(c + 1).width;

  const merges: Rect[] = [];
  for (const m of Object.values((ws as any)._merges ?? {}) as any[]) {
    const mm = m.model ?? m;
    if (mm && mm.top) merges.push({ r1: mm.top - 1, c1: mm.left - 1, r2: mm.bottom - 1, c2: mm.right - 1 });
  }

  const freeze = emptyFreeze();
  const view = (ws.views ?? [])[0] as any;
  if (view?.state === 'frozen') {
    for (let r = 0; r < (view.ySplit ?? 0); r++) freeze.rows.push(r);
    for (let c = 0; c < (view.xSplit ?? 0); c++) freeze.left.push(c);
  }

  const lists: Record<string, string[]> = {};
  for (const [a, dv] of Object.entries(((ws as any).dataValidations?.model ?? {}) as Record<string, any>)) {
    if (dv?.type !== 'list' || !dv.formulae?.[0]) continue;
    const f = String(dv.formulae[0]);
    if (!f.startsWith('"')) continue;
    const items = f.slice(1, -1).split(',').map((x) => x.trim());
    for (const x of parseRef(a.replace(/^range:/, ''))) for (let r = x.r1; r <= x.r2; r++) for (let c = x.c1; c <= x.c2; c++) lists[keyOf(r, c)] = items;
  }

  // Our alternating colours come back as bands; "cell contains" rules are shown; the rest stays in the file.
  const bands: Band[] = [];
  const textRules: SheetState['textRules'] = [];
  const keep: any[] = [];
  let ti = 0;
  for (const cf of ((ws as any).conditionalFormattings ?? []) as any[]) {
    const odd: Record<string, string> = {};
    const others: any[] = [];
    for (const rule of cf.rules ?? []) {
      if (rule.type === 'containsText') {
        rule.text = rule.text || unescape(texts[ti] ?? '');
        ti++;
        for (const ref of parseRef(cf.ref)) textRules.push({ ref, text: rule.text, fill: rule.style?.fill?.bgColor?.argb ?? rule.style?.fill?.fgColor?.argb, color: rule.style?.font?.color?.argb });
        others.push(rule);
        continue;
      }
      const m = rule.type === 'expression' && rule.formulae?.[0] ? BAND_RE.exec(String(rule.formulae[0]).replace(/\s+/g, '')) : null;
      const fill = rule.style?.fill?.bgColor?.argb ?? rule.style?.fill?.fgColor?.argb;
      if (m && fill) odd[m[1] === '1' ? 'odd' : 'even'] = fill;
      else others.push(rule);
    }
    if (odd.odd && odd.even) for (const ref of parseRef(cf.ref)) bands.push({ ref, odd: odd.odd, even: odd.even });
    else if (odd.odd || odd.even) others.push(...(cf.rules ?? []).filter((r: any) => r.type === 'expression'));
    if (others.length) keep.push({ ...cf, rules: others });
  }
  (ws as any).conditionalFormattings = keep;

  const out: SheetState = { ...s, rows, heights, widths, merges, freeze, lists, bands, textRules };
  out.header = detectHeader(out);
  return out;
}

/** A new, empty workbook ("Create new: Sheet"). */
export async function blankXlsx(): Promise<Uint8Array> {
  const ExcelJS = await excel();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.getCell('A1').value = null;
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

/** Write the edited sheets back into the workbook they came from and return the file's bytes. */
export async function saveXlsx(book: LoadedBook, sheets: SheetState[]): Promise<Uint8Array> {
  const { xwb } = book;
  const ExcelJS = await excel();
  void ExcelJS;
  sheets.forEach((s, i) => {
    let ws = xwb.worksheets[i];
    if (!ws) ws = xwb.addWorksheet(s.name);
    writeSheet(ws, s);
  });
  // Formulas keep their last results; Excel works them out again when it opens the file.
  (xwb as any).calcProperties = { ...((xwb as any).calcProperties ?? {}), fullCalcOnLoad: true };
  return new Uint8Array((await xwb.xlsx.writeBuffer()) as ArrayBuffer);
}

function writeSheet(ws: Worksheet, s: SheetState) {
  if (ws.name !== s.name) ws.name = s.name;
  // Unmerge, then write every cell, then merge again (merges may have moved).
  for (const key of Object.keys((ws as any)._merges ?? {})) {
    try {
      ws.unMergeCells(key);
    } catch {
      /* already gone */
    }
  }
  const lastRow = Math.max(ws.rowCount, s.rows.length);
  let lastCol = ws.columnCount;
  for (const r of s.rows) lastCol = Math.max(lastCol, r.length);
  lastCol = Math.max(lastCol, s.widths.length);
  for (let r = 0; r < lastRow; r++) {
    const xr = ws.getRow(r + 1);
    const src = s.rows[r] ?? [];
    for (let c = 0; c < lastCol; c++) {
      const cell = src[c];
      const xc = xr.getCell(c + 1);
      const v = cell?.v ?? null;
      if (xc.value !== v) xc.value = v as any;
      xc.style = (cell?.xs ? JSON.parse(JSON.stringify(cell.xs)) : {}) as any;
    }
    const h = s.heights[r];
    if (xr.height !== h) xr.height = h as any;
  }
  for (let c = 0; c < lastCol; c++) {
    const w = s.widths[c];
    const col = ws.getColumn(c + 1);
    if (col.width !== w) col.width = w as any;
  }
  for (const m of s.merges) if (m.r1 !== m.r2 || m.c1 !== m.c2) ws.mergeCells(m.r1 + 1, m.c1 + 1, m.r2 + 1, m.c2 + 1);

  const { ySplit, xSplit } = excelFreeze(s.freeze);
  const base = ((ws.views ?? [])[0] ?? {}) as any;
  ws.views = [
    ySplit || xSplit
      ? { ...base, state: 'frozen', xSplit, ySplit, topLeftCell: addr(ySplit, xSplit) }
      : { ...base, state: 'normal', xSplit: undefined, ySplit: undefined, topLeftCell: undefined },
  ] as any;

  // Our bands go back as two rules on row parity, after the file's own rules.
  const cfs = ((ws as any).conditionalFormattings ?? []).filter((cf: any) => !(cf.rules ?? []).some((r: any) => r.type === 'expression' && BAND_RE.test(String(r.formulae?.[0] ?? '').replace(/\s+/g, ''))));
  let prio = 1 + cfs.reduce((m: number, cf: any) => Math.max(m, ...(cf.rules ?? []).map((r: any) => r.priority ?? 0)), 0);
  for (const b of s.bands) {
    cfs.push({
      ref: refOf(b.ref),
      rules: [
        { type: 'expression', priority: prio++, formulae: ['MOD(ROW(),2)=1'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: b.odd } } } },
        { type: 'expression', priority: prio++, formulae: ['MOD(ROW(),2)=0'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: b.even } } } },
      ],
    });
  }
  (ws as any).conditionalFormattings = cfs;
}
