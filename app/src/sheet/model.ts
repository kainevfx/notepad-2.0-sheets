// The spreadsheet editor's data model (Phase C, 2026-10-01).
//
// A workbook is a list of sheets; every edit makes a new SheetState (rows are copied only where
// they change), so undo/redo just keeps earlier states. Cells keep the file's own Excel style
// object (`xs`, the ExcelJS shape) untouched unless you format them, so saving writes back
// exactly what was there.

/** ExcelJS-shaped style: font, fill, alignment, border, numFmt, protection. */
export interface XStyle {
  font?: { name?: string; size?: number; bold?: boolean; italic?: boolean; underline?: boolean | string; strike?: boolean; color?: { argb?: string; theme?: number } };
  fill?: { type?: string; pattern?: string; fgColor?: { argb?: string; theme?: number }; bgColor?: { argb?: string } };
  alignment?: { horizontal?: string; vertical?: string; wrapText?: boolean; indent?: number };
  border?: unknown;
  numFmt?: string;
  protection?: unknown;
}

export type Formula = { formula: string; result?: unknown };
export type CellValue = string | number | boolean | Date | null | Formula | { richText: { text: string }[] } | { text: string; hyperlink: string } | { error: string };

export interface Cell {
  v: CellValue;
  xs?: XStyle;
}

export type Row = (Cell | null | undefined)[];

export interface Rect {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** Alternating colours over a range, saved as an Excel rule on row parity (survives sorting). */
export interface Band {
  ref: Rect;
  odd: string; // ARGB
  even: string;
}

export interface Freeze {
  /** Rows shown in the band at the top (any rows). */
  rows: number[];
  /** Columns kept at the left / right edge (any columns). */
  left: number[];
  right: number[];
}

export interface SheetState {
  name: string;
  rows: Row[];
  /** Points (Excel row height); undefined = default. */
  heights: (number | undefined)[];
  /** Excel character widths; undefined = default. */
  widths: (number | undefined)[];
  merges: Rect[];
  bands: Band[];
  freeze: Freeze;
  /** 0-based header row (sort and filter only move rows below it); -1 = none. */
  header: number;
  /** Data validation lists by "r,c" (Status dropdowns). */
  lists: Record<string, string[]>;
  /** Text-matching rules from the file (Excel conditional formats we can show). */
  textRules: { ref: Rect; text: string; fill?: string; color?: string }[];
}

export const DEFAULT_WIDTH = 8.43;
export const DEFAULT_HEIGHT = 15;
export const MAX_FIT_PX = 560;

export const emptyFreeze = (): Freeze => ({ rows: [], left: [], right: [] });

export function newSheet(name: string, rows = 100, cols = 26): SheetState {
  return {
    name,
    rows: Array.from({ length: rows }, () => [] as Row),
    heights: [],
    widths: Array.from({ length: cols }, () => undefined),
    merges: [],
    bands: [],
    freeze: emptyFreeze(),
    header: -1,
    lists: {},
    textRules: [],
  };
}

// ---------------------------------------------------------------- reading values

export function isFormula(v: CellValue): v is Formula {
  return !!v && typeof v === 'object' && 'formula' in (v as object);
}

/** What a cell shows. */
export function displayText(v: CellValue): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e10) / 1e10);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toLocaleDateString();
  if (isFormula(v)) {
    const r = v.result;
    if (r == null) return '';
    if (typeof r === 'object' && r && 'error' in (r as object)) return String((r as { error: string }).error);
    return displayText(r as CellValue);
  }
  if ('richText' in v) return v.richText.map((t) => t.text).join('');
  if ('hyperlink' in v) return v.text;
  if ('error' in v) return v.error;
  return '';
}

/** What the edit box starts with: a formula as "=…", everything else as shown. */
export function editText(v: CellValue): string {
  if (isFormula(v)) return `=${v.formula}`;
  return displayText(v);
}

/** Typed text to a value: "=…" a formula, plain numbers as numbers, the rest as text. */
export function parseInput(text: string, prev?: CellValue): CellValue {
  if (text === '') return null;
  if (text.startsWith('=') && text.length > 1) return { formula: text.slice(1) };
  if (/^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/i.test(text.trim()) && !/^0\d/.test(text.trim())) return Number(text.trim());
  if (/^(true|false)$/i.test(text) && typeof prev === 'boolean') return /^true$/i.test(text);
  return text;
}

export function cellAt(s: SheetState, r: number, c: number): Cell | null {
  return s.rows[r]?.[c] ?? null;
}

export function usedSize(s: SheetState): { rows: number; cols: number } {
  let cols = s.widths.length;
  for (const row of s.rows) if (row.length > cols) cols = row.length;
  return { rows: s.rows.length, cols };
}

export const keyOf = (r: number, c: number) => `${r},${c}`;

export function colName(c: number): string {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function normRect(a: { r: number; c: number }, b: { r: number; c: number }): Rect {
  return { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) };
}

export const inRect = (x: Rect, r: number, c: number) => r >= x.r1 && r <= x.r2 && c >= x.c1 && c <= x.c2;

// ---------------------------------------------------------------- edits (all return a new state)

function withRows(s: SheetState, rows: Row[]): SheetState {
  return { ...s, rows };
}

function ensure<T>(arr: T[], n: number, fill: () => T): T[] {
  const out = arr.slice();
  while (out.length < n) out.push(fill());
  return out;
}

/** Set many cells at once (value and/or style). `fn` returns the new cell, or undefined to keep it. */
export function mapCells(s: SheetState, rects: Rect[], fn: (cell: Cell | null, r: number, c: number) => Cell | null | undefined): SheetState {
  let rows = s.rows;
  const maxR = Math.max(...rects.map((x) => x.r2));
  if (maxR >= rows.length) rows = ensure(rows, maxR + 1, () => []);
  else rows = rows.slice();
  const touched = new Set<number>();
  for (const x of rects) {
    for (let r = x.r1; r <= x.r2; r++) {
      for (let c = x.c1; c <= x.c2; c++) {
        const cur = rows[r]?.[c] ?? null;
        const next = fn(cur, r, c);
        if (next === undefined || next === cur) continue;
        if (!touched.has(r)) {
          rows[r] = (rows[r] ?? []).slice();
          touched.add(r);
        }
        rows[r][c] = next;
      }
    }
  }
  return touched.size ? withRows(s, rows) : s;
}

export function setValue(s: SheetState, r: number, c: number, v: CellValue): SheetState {
  return mapCells(s, [{ r1: r, c1: c, r2: r, c2: c }], (cell) => (v == null && !cell?.xs ? null : { v, xs: cell?.xs }));
}

/** Paste a block of text values with its top-left at (r, c). */
export function pasteBlock(s: SheetState, r: number, c: number, block: string[][]): SheetState {
  if (!block.length) return s;
  const w = Math.max(...block.map((b) => b.length));
  return mapCells(s, [{ r1: r, c1: c, r2: r + block.length - 1, c2: c + w - 1 }], (cell, rr, cc) => {
    const t = block[rr - r]?.[cc - c] ?? '';
    return { v: parseInput(t, cell?.v), xs: cell?.xs };
  });
}

export function clearValues(s: SheetState, rects: Rect[]): SheetState {
  return mapCells(s, rects, (cell) => (cell && cell.v != null ? (cell.xs ? { v: null, xs: cell.xs } : null) : undefined));
}

/** Merge a style patch into every cell of the ranges (`null` in a field removes it). */
export function patchStyle(s: SheetState, rects: Rect[], patch: (xs: XStyle) => XStyle): SheetState {
  return mapCells(s, rects, (cell) => ({ v: cell?.v ?? null, xs: patch({ ...(cell?.xs ?? {}) }) }));
}

export function clearFormatting(s: SheetState, rects: Rect[]): SheetState {
  return mapCells(s, rects, (cell) => (cell?.xs ? (cell.v == null ? null : { v: cell.v }) : undefined));
}

// ---------------------------------------------------------------- rows and columns

/** Where row `r` goes when rows move: shifts merges, bands, frozen rows, the header, lists. */
function remapRows(s: SheetState, map: (r: number) => number | null): Partial<SheetState> {
  const rect = (x: Rect): Rect | null => {
    const a = map(x.r1);
    const b = map(x.r2);
    if (a == null || b == null) return null;
    return { ...x, r1: Math.min(a, b), r2: Math.max(a, b) };
  };
  const lists: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(s.lists)) {
    const [r, c] = k.split(',').map(Number);
    const nr = map(r);
    if (nr != null) lists[keyOf(nr, c)] = v;
  }
  return {
    merges: s.merges.map(rect).filter(Boolean) as Rect[],
    bands: s.bands.map((b) => ({ ...b, ref: rect(b.ref) })).filter((b) => b.ref) as Band[],
    textRules: s.textRules.map((t) => ({ ...t, ref: rect(t.ref) })).filter((t) => t.ref) as SheetState['textRules'],
    freeze: { ...s.freeze, rows: s.freeze.rows.map(map).filter((x): x is number => x != null) },
    header: s.header < 0 ? -1 : map(s.header) ?? -1,
    lists,
  };
}

function remapCols(s: SheetState, map: (c: number) => number | null): Partial<SheetState> {
  const rect = (x: Rect): Rect | null => {
    const a = map(x.c1);
    const b = map(x.c2);
    if (a == null || b == null) return null;
    return { ...x, c1: Math.min(a, b), c2: Math.max(a, b) };
  };
  const lists: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(s.lists)) {
    const [r, c] = k.split(',').map(Number);
    const nc = map(c);
    if (nc != null) lists[keyOf(r, nc)] = v;
  }
  return {
    merges: s.merges.map(rect).filter(Boolean) as Rect[],
    bands: s.bands.map((b) => ({ ...b, ref: rect(b.ref) })).filter((b) => b.ref) as Band[],
    textRules: s.textRules.map((t) => ({ ...t, ref: rect(t.ref) })).filter((t) => t.ref) as SheetState['textRules'],
    freeze: { rows: s.freeze.rows, left: s.freeze.left.map(map).filter((x): x is number => x != null), right: s.freeze.right.map(map).filter((x): x is number => x != null) },
    lists,
  };
}

export function insertRows(s: SheetState, at: number, n = 1): SheetState {
  const rows = s.rows.slice();
  rows.splice(at, 0, ...Array.from({ length: n }, () => [] as Row));
  const heights = s.heights.slice();
  if (heights.length > at) heights.splice(at, 0, ...Array.from({ length: n }, () => undefined));
  return { ...s, ...remapRows(s, (r) => (r >= at ? r + n : r)), rows, heights };
}

export function deleteRows(s: SheetState, r1: number, r2: number): SheetState {
  const n = r2 - r1 + 1;
  const rows = s.rows.slice();
  rows.splice(r1, n);
  const heights = s.heights.slice();
  heights.splice(r1, n);
  return { ...s, ...remapRows(s, (r) => (r < r1 ? r : r > r2 ? r - n : null)), rows, heights };
}

export function insertCols(s: SheetState, at: number, n = 1): SheetState {
  const rows = s.rows.map((row) => {
    if (row.length <= at) return row;
    const x = row.slice();
    x.splice(at, 0, ...Array.from({ length: n }, () => null));
    return x;
  });
  const widths = s.widths.slice();
  while (widths.length < at) widths.push(undefined);
  widths.splice(at, 0, ...Array.from({ length: n }, () => undefined));
  return { ...s, ...remapCols(s, (c) => (c >= at ? c + n : c)), rows, widths };
}

export function deleteCols(s: SheetState, c1: number, c2: number): SheetState {
  const n = c2 - c1 + 1;
  const rows = s.rows.map((row) => {
    if (row.length <= c1) return row;
    const x = row.slice();
    x.splice(c1, n);
    return x;
  });
  const widths = s.widths.slice();
  widths.splice(c1, n);
  return { ...s, ...remapCols(s, (c) => (c < c1 ? c : c > c2 ? c - n : null)), rows, widths };
}

/** Move rows r1..r2 so they start at `to` (an index in the sheet before the move). */
export function moveRows(s: SheetState, r1: number, r2: number, to: number): SheetState {
  const n = r2 - r1 + 1;
  if (to >= r1 && to <= r2 + 1) return s;
  const order = moveOrder(Math.max(s.rows.length, r2 + 1, to), r1, r2, to);
  const pos = new Map(order.map((old, i) => [old, i]));
  const rows = order.map((old) => s.rows[old] ?? []);
  const heights = order.map((old) => s.heights[old]);
  void n;
  return { ...s, ...remapRows(s, (r) => pos.get(r) ?? r), rows, heights };
}

export function moveCols(s: SheetState, c1: number, c2: number, to: number): SheetState {
  if (to >= c1 && to <= c2 + 1) return s;
  const { cols } = usedSize(s);
  const order = moveOrder(Math.max(cols, c2 + 1, to), c1, c2, to);
  const pos = new Map(order.map((old, i) => [old, i]));
  const rows = s.rows.map((row) => order.map((old) => row[old] ?? null));
  const widths = order.map((old) => s.widths[old]);
  return { ...s, ...remapCols(s, (c) => pos.get(c) ?? c), rows, widths };
}

/** The new order of indexes 0..len-1 after moving a..b to before `to`. */
export function moveOrder(len: number, a: number, b: number, to: number): number[] {
  const all = Array.from({ length: len }, (_, i) => i);
  const block = all.slice(a, b + 1);
  const rest = all.filter((i) => i < a || i > b);
  const at = to > b ? to - block.length : to;
  rest.splice(at, 0, ...block);
  return rest;
}

// ---------------------------------------------------------------- sort

export type SortKey = { col: number; desc: boolean };

function sortValue(cell: Cell | null): { kind: number; n: number; s: string } {
  const v = cell?.v ?? null;
  const shown = v == null ? '' : displayText(v);
  const raw = isFormula(v as CellValue) ? (v as Formula).result : v;
  if (shown === '') return { kind: 2, n: 0, s: '' }; // blanks last
  if (typeof raw === 'number') return { kind: 0, n: raw, s: '' };
  if (raw instanceof Date) return { kind: 0, n: raw.getTime(), s: '' };
  const num = Number(shown);
  if (shown.trim() !== '' && !isNaN(num)) return { kind: 0, n: num, s: '' };
  return { kind: 1, n: 0, s: shown };
}

/** The rows sort/filter may move: below the header row, not inside a merge, up to the last used row. */
export function dataRows(s: SheetState): { from: number; to: number } {
  let last = s.rows.length - 1;
  while (last > s.header && !(s.rows[last] ?? []).some((c) => c && c.v != null && displayText(c.v) !== '')) last--;
  return { from: s.header + 1, to: last };
}

/** Really reorders the rows below the header (Excel's Sort). Stable; blanks last either way. */
export function sortRows(s: SheetState, keys: SortKey[]): SheetState {
  const { from, to } = dataRows(s);
  if (to <= from) return s;
  const span = s.merges.some((m) => m.r2 >= from && m.r1 <= to && m.r1 !== m.r2);
  if (span) {
    // Rows tied together by a merge can't be sorted apart; leave the sheet as it is.
    return s;
  }
  const idx = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  idx.sort((a, b) => {
    for (const k of keys) {
      const x = sortValue(s.rows[a]?.[k.col] ?? null);
      const y = sortValue(s.rows[b]?.[k.col] ?? null);
      if (x.kind !== y.kind) return x.kind - y.kind; // numbers, text, blanks (blanks always last)
      let d = x.kind === 0 ? x.n - y.n : x.kind === 1 ? coll.compare(x.s, y.s) : 0;
      if (k.desc && x.kind !== 2) d = -d;
      if (d) return d;
    }
    return a - b;
  });
  const order = Array.from({ length: s.rows.length }, (_, i) => i);
  for (let i = 0; i < idx.length; i++) order[from + i] = idx[i];
  const pos = new Map(order.map((old, i) => [old, i]));
  return {
    ...s,
    ...remapRows({ ...s, bands: [], textRules: [] }, (r) => pos.get(r) ?? r),
    // Bands and text rules stay on their ranges (they colour by position, like Excel).
    bands: s.bands,
    textRules: s.textRules,
    rows: order.map((old) => s.rows[old] ?? []),
    heights: order.map((old) => s.heights[old]),
  };
}

// ---------------------------------------------------------------- header row

/** The first row that looks like column headings: mostly filled with short text, data below it. */
export function detectHeader(s: SheetState): number {
  const { cols } = usedSize(s);
  const filled = (r: number) => (s.rows[r] ?? []).filter((c) => c && displayText(c.v) !== '').length;
  const used = Math.max(1, Math.min(cols, Math.max(...s.rows.slice(0, 40).map((_, r) => filled(r)), 1)));
  for (let r = 0; r < Math.min(s.rows.length - 1, 30); r++) {
    const row = s.rows[r] ?? [];
    const cells = row.filter((c) => c && displayText(c.v) !== '');
    if (cells.length < Math.max(2, used * 0.6)) continue;
    const short = cells.every((c) => typeof c!.v === 'string' && (c!.v as string).length <= 60);
    if (short && filled(r + 1) >= Math.max(1, used * 0.4)) return r;
  }
  return -1;
}

// ---------------------------------------------------------------- freeze

export function toggleFreezeRows(s: SheetState, rows: number[], on: boolean): SheetState {
  const set = new Set(s.freeze.rows);
  for (const r of rows) on ? set.add(r) : set.delete(r);
  return { ...s, freeze: { ...s.freeze, rows: [...set].sort((a, b) => a - b) } };
}

export function freezeCols(s: SheetState, cols: number[], side: 'left' | 'right' | null): SheetState {
  const left = new Set(s.freeze.left);
  const right = new Set(s.freeze.right);
  for (const c of cols) {
    left.delete(c);
    right.delete(c);
    if (side === 'left') left.add(c);
    if (side === 'right') right.add(c);
  }
  return { ...s, freeze: { ...s.freeze, left: [...left].sort((a, b) => a - b), right: [...right].sort((a, b) => a - b) } };
}

/** The part of a freeze Excel can store: top rows 0..k-1 and left columns 0..m-1. */
export function excelFreeze(f: Freeze): { ySplit: number; xSplit: number } {
  let y = 0;
  while (f.rows.includes(y)) y++;
  let x = 0;
  while (f.left.includes(x)) x++;
  return { ySplit: y, xSplit: x };
}

// ---------------------------------------------------------------- undo history

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

export const LIMIT = 100;

export function commit<T>(h: History<T>, next: T): History<T> {
  if (next === h.present) return h;
  return { past: [...h.past.slice(-(LIMIT - 1)), h.present], present: next, future: [] };
}
export function undoH<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
}
export function redoH<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
}
