// Sizes on screen, text measuring (fit to data), and how a cell looks.
import { DEFAULT_WIDTH, DEFAULT_HEIGHT, MAX_FIT_PX, displayText, type SheetState, type XStyle, type Cell } from './model';

/** Excel character width → pixels (Calibri 11's digit is 7 px, plus padding). */
export const colPx = (w: number | undefined) => Math.max(16, Math.round((w ?? DEFAULT_WIDTH) * 7 + 5));
export const pxToWidth = (px: number) => Math.max(1, Math.round(((px - 5) / 7) * 100) / 100);
/** Points → pixels. */
export const rowPx = (h: number | undefined) => Math.max(16, Math.round((h ?? DEFAULT_HEIGHT) * (4 / 3)));
export const pxToHeight = (px: number) => Math.max(8, Math.round(px * 0.75 * 4) / 4);

export const FONT_FALLBACK = "'Segoe UI', Carlito, Calibri, Arial, sans-serif";

export function fontCss(xs?: XStyle): string {
  const f = xs?.font;
  const size = (f?.size ?? 11) * (4 / 3);
  const fam = f?.name ? `'${f.name.replace(/'/g, '')}', ${FONT_FALLBACK}` : FONT_FALLBACK;
  return `${f?.italic ? 'italic ' : ''}${f?.bold ? '700 ' : '400 '}${size.toFixed(1)}px ${fam}`;
}

let ctx: CanvasRenderingContext2D | null = null;
function measure(text: string, font: string): number {
  if (!ctx) ctx = (typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null) as CanvasRenderingContext2D | null;
  if (!ctx) return text.length * 7;
  ctx.font = font;
  return ctx.measureText(text).width;
}

const PAD_X = 10; // left + right padding inside a cell
const LINE = 1.3;

/** Widest line of each column (px, capped so paragraphs still wrap). Cells merged across several
 * columns don't count (`skip`). */
export function fitColumn(s: SheetState, c: number, rows?: number[], skip?: (r: number, c: number) => boolean): number {
  let w = 0;
  const list = rows ?? s.rows.map((_, i) => i);
  for (const r of list) {
    const cell = s.rows[r]?.[c];
    if (!cell || cell.v == null || skip?.(r, c)) continue;
    const t = displayText(cell.v);
    if (!t) continue;
    const font = fontCss(cell.xs);
    for (const line of t.split('\n')) w = Math.max(w, measure(line, font));
    if (w >= MAX_FIT_PX) return MAX_FIT_PX;
  }
  return Math.min(MAX_FIT_PX, Math.ceil(w + PAD_X + 4));
}

/** Height a row needs for its text at the current widths (wrapped cells grow). `widthPx` gives a
 * cell's width (a merged cell's whole width), or null for cells to leave out (covered by a merge,
 * or merged over several rows). */
export function fitRow(s: SheetState, r: number, widthPx: (c: number) => number | null, wrapAll = false): number {
  const row = s.rows[r] ?? [];
  let h = rowPx(undefined);
  row.forEach((cell: Cell | null | undefined, c) => {
    if (!cell || cell.v == null) return;
    const t = displayText(cell.v);
    if (!t) return;
    const font = fontCss(cell.xs);
    const size = (cell.xs?.font?.size ?? 11) * (4 / 3);
    const wrap = wrapAll || !!cell.xs?.alignment?.wrapText;
    const w = widthPx(c);
    if (w == null) return;
    const avail = Math.max(10, w - PAD_X);
    let lines = 0;
    for (const para of t.split('\n')) lines += wrap ? Math.max(1, Math.ceil(measure(para, font) / avail)) : 1;
    h = Math.max(h, Math.ceil(lines * size * LINE + 6));
  });
  return h;
}

export interface CellLook {
  font: string;
  fill: string | null; // hex from the file (before adapting)
  color: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  h: string; // left / center / right
  v: string; // top / middle / bottom
  wrap: boolean;
}

const looks = new WeakMap<object, CellLook>();
const NONE: CellLook = { font: fontCss(undefined), fill: null, color: null, bold: false, italic: false, underline: false, strike: false, h: '', v: 'bottom', wrap: false };

const hex = (argb?: string) => {
  if (!argb) return null;
  const s = argb.length === 8 ? argb.slice(2) : argb;
  return /^[0-9a-f]{6}$/i.test(s) ? `#${s.toLowerCase()}` : null;
};

export function lookOf(xs?: XStyle): CellLook {
  if (!xs) return NONE;
  const hit = looks.get(xs);
  if (hit) return hit;
  const f = xs.font;
  const fill = xs.fill && xs.fill.type === 'pattern' && xs.fill.pattern && xs.fill.pattern !== 'none' ? hex(xs.fill.fgColor?.argb) : null;
  const a = xs.alignment;
  const look: CellLook = {
    font: fontCss(xs),
    fill,
    color: hex(f?.color?.argb),
    bold: !!f?.bold,
    italic: !!f?.italic,
    underline: !!f?.underline,
    strike: !!f?.strike,
    h: a?.horizontal === 'center' || a?.horizontal === 'centerContinuous' ? 'center' : a?.horizontal === 'right' ? 'right' : a?.horizontal === 'left' ? 'left' : '',
    v: a?.vertical === 'top' ? 'top' : a?.vertical === 'middle' || a?.vertical === 'center' ? 'middle' : 'bottom',
    wrap: !!a?.wrapText,
  };
  looks.set(xs, look);
  return look;
}

/** Binary search: index of the last offset <= y in a sorted list of starts. */
export function indexAt(starts: number[], y: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}
