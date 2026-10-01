// The spreadsheet editor (Phase C): .xlsx with full formatting, CSV / TSV as plain data.
//
// Layout: six panes around one real scroller. Frozen rows sit in the top band, frozen columns at
// the left or right edge; the body pane scrolls and the others follow it (top band sideways, side
// panes up and down). Only the rows and columns in view are drawn.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { useSignalEffect } from '@preact/signals';
import type { DocMeta } from '../../state/app';
import { docs } from '../../state/app';
import { settings, updateSettings, isDark, systemDark } from '../../state/settings';
import { openContextMenu, showToast, type MenuItem } from '../../state/ui';
import {
  usedSize, displayText, editText, parseInput, setValue, clearValues, pasteBlock, patchStyle, clearFormatting,
  insertRows, deleteRows, insertCols, deleteCols, moveRows, moveCols, sortRows, toggleFreezeRows, freezeCols,
  colName, normRect, inRect, keyOf, dataRows, mapCells,
  type Rect, type XStyle, type SortKey,
} from '../../sheet/model';
import { colPx, rowPx, pxToWidth, pxToHeight, fitColumn, fitRow, lookOf, indexAt } from '../../sheet/layout';
import { shownColours, argbToHex, hexToArgb, type ColourMode } from '../../sheet/colors';
import { rowMatches, suggestions, parseFilter, filterLabel, headings } from '../../sheet/filter';
import { parseCsv } from '../../lib/csv';
import { sessions, sheetTick, openXlsx, openCsv, csvTextChanged, apply, undo, redo, updatePrefs, dropSession, type SheetSession, type Pos } from './session';
import * as I from '../icons';
import './sheet.css';

const ROWHDR = 48;
const COLHDR = 24;
const FONTS = ['Arial', 'Calibri', 'Carlito', 'Segoe UI', 'Consolas', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana'];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36];
const SWATCHES = ['#000000', '#5f6368', '#ffffff', '#d93025', '#e37400', '#f9ab00', '#188038', '#254c3c', '#1a73e8', '#9334e6', '#d01884', '#007b83', '#f4f8ef', '#eff5ed', '#fce5df', '#e2eedb'];

type Pop = null | 'font' | 'fill' | 'sort' | 'freeze' | 'fit' | 'insert' | 'wrap';
type Dialog = null | { kind: 'bands'; odd: string; even: string } | { kind: 'sort'; keys: SortKey[] } | { kind: 'text'; text: string; title: string };

export function SheetEditor({ doc, text, mode, fallback }: { doc: DocMeta; text: string; mode: 'xlsx' | 'csv'; fallback?: JSX.Element }) {
  sheetTick.value;
  systemDark.value;
  const s = sessions.get(doc.id);
  const [, bump] = useState(0);

  // Load (and reload when the file changed on disk).
  useEffect(() => {
    const cur = sessions.get(doc.id);
    if (mode === 'xlsx') {
      if (!cur || cur.rev !== doc.rev) void openXlsx(doc.id, doc.path!, doc.rev);
    } else if (!cur) void openCsv(doc.id, doc.path, text);
  }, [doc.id, doc.rev, mode]);
  useEffect(() => {
    const cur = sessions.get(doc.id);
    if (mode === 'csv' && cur) csvTextChanged(cur, text, doc.path);
  }, [text]);
  // Closed tab: forget its session.
  useSignalEffect(() => {
    const id = doc.id;
    if (!docs.value[id]) dropSession(id);
  });

  if (!s) return <div class="viewer-loading">Reading workbook…</div>;
  // A workbook ExcelJS can't read still opens, read-only, in the plain viewer.
  if (s.error) return fallback ?? <div class="viewer-notice"><p>Couldn't open this workbook for editing.</p><p class="set-desc">{s.error}</p></div>;
  return <Editor s={s} doc={doc} bump={() => bump((n) => n + 1)} />;
}

function Editor({ s, doc }: { s: SheetSession; doc: DocMeta; bump: () => void }) {
  const sheet = s.hist.present[s.active];
  const csv = s.mode === 'csv';
  const readonly = doc.readonly && csv;
  const colourMode = (settings.value.sheetColours ?? 'adapted') as ColourMode;
  const dark = isDark();
  const picked = useMemo(() => new Set(s.prefs.picked.map((x) => x.toLowerCase())), [s.prefs.picked]);

  const body = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [vp, setVp] = useState({ w: 800, h: 500 });
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridH, setGridH] = useState(600);
  const [topScroll, setTopScroll] = useState(0);
  const [editing, setEditingState] = useState<null | { r: number; c: number; value: string }>(null);
  // Keys typed before the edit box has mounted still belong to the edit.
  const editRef = useRef<null | { r: number; c: number; value: string }>(null);
  const setEditing = (v: null | { r: number; c: number; value: string }) => {
    editRef.current = v;
    setEditingState(v);
  };
  const [pop, setPop] = useState<Pop>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [filterText, setFilterText] = useState('');
  const [sugIdx, setSugIdx] = useState(0);
  const [find, setFind] = useState<null | { q: string; rep: string; replace: boolean; at: number }>(null);
  const [resize, setResize] = useState<null | { kind: 'c' | 'r'; idx: number; px: number }>(null);
  const [moveMark, setMoveMark] = useState<null | { kind: 'c' | 'r'; at: number; after: boolean }>(null);
  const [, force] = useState(0);
  const sel = s.sel;
  const setSel = (next: typeof sel) => {
    s.sel = next;
    force((n) => n + 1);
  };

  // ------------------------------------------------------------ geometry
  const used = usedSize(sheet);
  const nRows = Math.max(used.rows + 30, 60);
  const nCols = Math.max(used.cols + 4, 12);
  const widthPx = (c: number) => (resize?.kind === 'c' && (resize.idx === c || (selCols().includes(c) && selCols().includes(resize.idx))) ? resize.px : colPx(sheet.widths[c]));
  // Merges: every covered cell → its merge.
  const mergeAt = useMemo(() => {
    const m = new Map<string, Rect>();
    for (const x of sheet.merges) for (let r = x.r1; r <= x.r2; r++) for (let c = x.c1; c <= x.c2; c++) m.set(keyOf(r, c), x);
    return m;
  }, [sheet.merges]);
  /** Width a cell's text has: a merge's whole width; null for covered cells or merges over rows. */
  const fitWidth = (sh: typeof sheet) => (r: number, c: number): number | null => {
    const m = mergeAt.get(keyOf(r, c));
    if (!m) return colPx(sh.widths[c]);
    if (m.r1 !== m.r2 || m.r1 !== r || m.c1 !== c) return null;
    let w = 0;
    for (let k = m.c1; k <= m.c2; k++) w += colPx(sh.widths[k]);
    return w;
  };
  const inWideMerge = (r: number, c: number) => {
    const m = mergeAt.get(keyOf(r, c));
    return !!m && m.c1 !== m.c2;
  };
  const autoH = useMemo(() => new Map<number, number>(), [sheet, settings.value.uiScale]);
  const heightPx = (r: number) => {
    if (resize?.kind === 'r' && resize.idx === r) return resize.px;
    const h = sheet.heights[r];
    if (h != null) return rowPx(h);
    const row = sheet.rows[r];
    if (!row || !row.some((c) => c?.xs?.alignment?.wrapText && c.v != null)) return rowPx(undefined);
    let a = autoH.get(r);
    if (a == null) {
      a = fitRow(sheet, r, (c) => fitWidth(sheet)(r, c));
      autoH.set(r, a);
    }
    return a;
  };

  function selCols(): number[] {
    if (sel.mode !== 'cols') return [];
    const out: number[] = [];
    for (const x of [...sel.extra, normRect(sel.a, sel.b)]) for (let c = x.c1; c <= x.c2; c++) out.push(c);
    return out;
  }
  function selRowsList(): number[] {
    const out = new Set<number>();
    for (const x of rects()) for (let r = x.r1; r <= x.r2; r++) out.add(r);
    return [...out].sort((a, b) => a - b);
  }
  function selColsList(): number[] {
    const out = new Set<number>();
    for (const x of rects()) for (let c = x.c1; c <= Math.min(x.c2, nCols - 1); c++) out.add(c);
    return [...out].sort((a, b) => a - b);
  }
  /** Selected ranges (whole rows / columns clipped to the used area for formatting). */
  function rects(clip = false): Rect[] {
    const lastR = clip ? Math.max(used.rows - 1, 0) : nRows - 1;
    const lastC = clip ? Math.max(used.cols - 1, 0) : nCols - 1;
    return [...sel.extra, normRect(sel.a, sel.b)].map((x) =>
      sel.mode === 'rows' ? { ...x, c1: 0, c2: lastC } : sel.mode === 'cols' ? { ...x, r1: 0, r2: lastR } : x,
    );
  }
  const inSel = (r: number, c: number) => rects().some((x) => inRect(x, r, c));

  const frozenRows = sheet.freeze.rows.filter((r) => r < nRows);
  const leftCols = sheet.freeze.left.filter((c) => c < nCols);
  const rightCols = sheet.freeze.right.filter((c) => c < nCols);
  const fzRowSet = new Set(frozenRows);
  const fzColSet = new Set([...leftCols, ...rightCols]);
  const filtering = s.filters.length > 0;
  const { to: lastData } = dataRows(sheet);
  const bodyRows = useMemo(() => {
    const out: number[] = [];
    for (let r = 0; r < nRows; r++) {
      if (fzRowSet.has(r)) continue;
      if (filtering && r > sheet.header && (r > lastData || !rowMatches(sheet, r, s.filters))) continue;
      out.push(r);
    }
    return out;
  }, [sheet, nRows, s.filters, frozenRows.join(',')]);
  const bodyCols = useMemo(() => Array.from({ length: nCols }, (_, c) => c).filter((c) => !fzColSet.has(c)), [nCols, leftCols.join(','), rightCols.join(',')]);
  const rowTops = cumulative(bodyRows, heightPx);
  const colLefts = cumulative(bodyCols, widthPx);
  const topH = frozenRows.reduce((a, r) => a + heightPx(r), 0);
  const leftW = leftCols.reduce((a, c) => a + widthPx(c), 0);
  const rightW = rightCols.reduce((a, c) => a + widthPx(c), 0);
  const totalH = rowTops[rowTops.length - 1];
  const totalW = colLefts[colLefts.length - 1];

  useLayoutEffect(() => {
    const el = body.current;
    const g = gridRef.current;
    if (!el || !g) return;
    const ro = new ResizeObserver(() => {
      setVp({ w: el.clientWidth, h: el.clientHeight });
      setGridH(g.clientHeight);
    });
    ro.observe(el);
    ro.observe(g);
    return () => ro.disconnect();
  }, []);
  // Frozen rows never take more than 60% of the grid; if they're taller, the band scrolls on its own.
  const topShown = Math.min(topH, Math.max(0, Math.round((gridH - COLHDR) * 0.6)));
  const topMax = Math.max(0, topH - topShown);
  const tScroll = Math.min(topScroll, topMax);
  const topWheel = (e: WheelEvent) => {
    if (topMax > 0 && e.deltaY && !e.shiftKey) {
      e.preventDefault();
      setTopScroll(Math.max(0, Math.min(topMax, tScroll + e.deltaY)));
      return;
    }
    forwardWheel(e);
  };
  const frame = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = body.current;
      if (el) setScroll({ top: el.scrollTop, left: el.scrollLeft });
    });
  };
  const forwardWheel = (e: WheelEvent) => {
    const el = body.current;
    if (!el) return;
    el.scrollTop += e.deltaY;
    el.scrollLeft += e.shiftKey ? e.deltaY : e.deltaX;
    e.preventDefault();
  };

  const i0 = Math.max(0, indexAt(rowTops, scroll.top) - 2);
  const i1 = Math.min(bodyRows.length, indexAt(rowTops, scroll.top + vp.h) + 3);
  const j0 = Math.max(0, indexAt(colLefts, scroll.left) - 1);
  const j1 = Math.min(bodyCols.length, indexAt(colLefts, scroll.left + vp.w) + 2);
  const winRows = bodyRows.slice(i0, i1);
  const winCols = bodyCols.slice(j0, j1);


  const textRuleHits = (r: number, c: number, t: string) => {
    for (const rule of sheet.textRules) if (inRect(rule.ref, r, c) && rule.text && t.toLowerCase().includes(rule.text.toLowerCase())) return rule;
    return null;
  };
  const bandAt = (r: number, c: number) => sheet.bands.find((b) => inRect(b.ref, r, c)) ?? (dialog?.kind === 'bands' ? previewBand(r, c) : undefined);
  function previewBand(r: number, c: number) {
    if (dialog?.kind !== 'bands') return undefined;
    const x = rects(true)[rects().length - 1];
    return inRect(x, r, c) ? { ref: x, odd: hexToArgb(dialog.odd), even: hexToArgb(dialog.even) } : undefined;
  }

  // ------------------------------------------------------------ drawing
  const findHits = useMemo(() => {
    if (!find?.q) return [] as Pos[];
    const q = find.q.toLowerCase();
    const out: Pos[] = [];
    const order = [...frozenRows, ...bodyRows].sort((a, b) => a - b);
    for (const r of order) {
      const row = sheet.rows[r] ?? [];
      for (let c = 0; c < row.length; c++) if (row[c] && displayText(row[c]!.v).toLowerCase().includes(q)) out.push({ r, c });
    }
    return out;
  }, [find?.q, sheet, bodyRows]);
  const hitSet = new Set(findHits.map((h) => keyOf(h.r, h.c)));

  function cellDiv(r: number, c: number, x: number, y: number, w: number, h: number, frozen: boolean): JSX.Element | null {
    const m = mergeAt.get(keyOf(r, c));
    if (m && (m.r1 !== r || m.c1 !== c)) return null;
    let cw = w;
    let ch = h;
    if (m) {
      cw = 0;
      for (let k = m.c1; k <= m.c2; k++) cw += widthPx(k);
      ch = 0;
      for (let k = m.r1; k <= m.r2; k++) if (!filtering || bodyRows.includes(k) || fzRowSet.has(k)) ch += heightPx(k);
    }
    const cell = sheet.rows[r]?.[c] ?? null;
    const look = lookOf(cell?.xs);
    const t = cell ? displayText(cell.v) : '';
    let fill = look.fill;
    let color = look.color;
    const band = bandAt(r, c);
    if (band) fill = argbToHex((r + 1) % 2 === 1 ? band.odd : band.even);
    const rule = t ? textRuleHits(r, c, t) : null;
    if (rule) {
      if (rule.fill) fill = argbToHex(rule.fill);
      if (rule.color) color = argbToHex(rule.color);
    }
    const shown = csv ? { bg: null, fg: null } : shownColours(fill, color, colourMode, dark, picked);
    const act = sel.a.r === r && sel.a.c === c;
    const cls = `sc${inSel(r, c) ? ' sel' : ''}${act ? ' act' : ''}${frozen ? ' fz' : ''}${hitSet.has(keyOf(r, c)) ? ' hit' : ''}${look.wrap ? ' wrap' : ''}`;
    const st: Record<string, string> = {
      left: `${x}px`, top: `${y}px`, width: `${cw}px`, height: `${ch}px`, font: look.font,
      'justify-content': look.v === 'top' ? 'flex-start' : look.v === 'middle' ? 'center' : 'flex-end',
    };
    if (shown.bg) st.background = shown.bg;
    if (shown.fg) st.color = shown.fg;
    const numeric = typeof cell?.v === 'number' || (cell?.v && typeof cell.v === 'object' && 'result' in (cell.v as object) && typeof (cell.v as { result?: unknown }).result === 'number');
    const align = look.h || (numeric ? 'right' : 'left');
    const deco = [look.underline ? 'underline' : '', look.strike ? 'line-through' : ''].filter(Boolean).join(' ');
    return (
      <div key={`${r}:${c}`} class={cls} style={st} data-r={r} data-c={c} title={t.length > 60 && !look.wrap ? t.slice(0, 1000) : undefined}>
        <span class="sct" style={{ 'text-align': align, ...(deco ? { 'text-decoration': deco } : {}) }}>{t}</span>
      </div>
    );
  }

  function cellsBlock(rowsList: number[], tops: number[], colsList: number[], lefts: number[], frozenFlag: (r: number, c: number) => boolean, y0 = 0) {
    const out: JSX.Element[] = [];
    const drawn = new Set<string>();
    rowsList.forEach((r, i) => {
      colsList.forEach((c, j) => {
        let rr = r;
        let cc = c;
        const m = mergeAt.get(keyOf(r, c));
        if (m && (m.r1 !== r || m.c1 !== c)) {
          // The merge's first cell is out of view: draw it here once, at its own place.
          const mk = keyOf(m.r1, m.c1);
          if (drawn.has(mk)) return;
          const ri = rowsList.indexOf(m.r1);
          const ci = colsList.indexOf(m.c1);
          if (ri >= 0 && ci >= 0) return; // it's in view and will be drawn
          rr = m.r1;
          cc = m.c1;
          const y = ri >= 0 ? tops[ri] : tops[i] - sumH(m.r1, r);
          const x = ci >= 0 ? lefts[ci] : lefts[j] - sumW(m.c1, c);
          drawn.add(mk);
          const el = cellDiv(rr, cc, x, y + y0, widthPx(cc), heightPx(rr), frozenFlag(rr, cc));
          if (el) out.push(el);
          return;
        }
        const k = keyOf(r, c);
        if (drawn.has(k)) return;
        drawn.add(k);
        const el = cellDiv(r, c, lefts[j], tops[i] + y0, widthPx(c), heightPx(r), frozenFlag(r, c));
        if (el) out.push(el);
      });
    });
    return out;
  }
  const sumH = (a: number, b: number) => {
    let t = 0;
    for (let r = a; r < b; r++) if (!filtering || bodyRows.includes(r)) t += heightPx(r);
    return t;
  };
  const sumW = (a: number, b: number) => {
    let t = 0;
    for (let c = a; c < b; c++) t += widthPx(c);
    return t;
  };

  const winTops = winRows.map((_, i) => rowTops[i0 + i]);
  const winLefts = winCols.map((_, j) => colLefts[j0 + j]);
  const fzTops = cumulative(frozenRows, heightPx);
  const leftLefts = cumulative(leftCols, widthPx);
  const rightLefts = cumulative(rightCols, widthPx);

  function colHeaders(cols: number[], lefts: number[], frozen: boolean) {
    return cols.map((c, j) => {
      const on = sel.mode === 'cols' ? selCols().includes(c) : rects().some((x) => c >= x.c1 && c <= x.c2);
      return (
        <div key={`h${c}`} class={`sh-ch${on ? ' on' : ''}${frozen ? ' fz' : ''}${moveMark?.kind === 'c' && moveMark.at === c ? (moveMark.after ? ' mv-after' : ' mv-before') : ''}`} style={{ left: `${lefts[j]}px`, width: `${widthPx(c)}px` }} data-ch={c}>
          {colName(c)}
          <span class="sh-rz-c" data-rzc={c} title="Drag to resize. Double-click: fit to data." />
        </div>
      );
    });
  }
  function rowHeaders(rowsList: number[], tops: number[], frozen: boolean, y0 = 0) {
    return rowsList.map((r, i) => {
      const on = sel.mode === 'rows' ? rects().some((x) => r >= x.r1 && r <= x.r2) : rects().some((x) => r >= x.r1 && r <= x.r2);
      return (
        <div
          key={`r${r}`}
          class={`sh-rh${on ? ' on' : ''}${frozen ? ' fz' : ''}${r === sheet.header ? ' hdr' : ''}${moveMark?.kind === 'r' && moveMark.at === r ? (moveMark.after ? ' mv-after' : ' mv-before') : ''}`}
          style={{ top: `${tops[i] + y0}px`, height: `${heightPx(r)}px` }}
          data-rh={r}
          title={r === sheet.header ? 'Header row: sort and filter only move the rows below it' : undefined}
        >
          {r + 1}
          <span class="sh-rz-r" data-rzr={r} title="Drag to resize. Double-click: fit to data." />
        </div>
      );
    });
  }

  // ------------------------------------------------------------ actions
  const active = sel.a;
  const activeCell = sheet.rows[active.r]?.[active.c] ?? null;
  const activeLook = lookOf(activeCell?.xs);

  const fmt = (patch: (xs: XStyle) => XStyle) => {
    if (csv || readonly) return;
    apply(s, (sh) => patchStyle(sh, rects(true), patch));
  };
  const setFont = (f: Partial<NonNullable<XStyle['font']>>) => fmt((xs) => ({ ...xs, font: { ...(xs.font ?? {}), ...f } }));
  const setAlign = (a: Partial<NonNullable<XStyle['alignment']>>) => fmt((xs) => ({ ...xs, alignment: { ...(xs.alignment ?? {}), ...a } }));
  const remember = (hex: string) => {
    const h = hex.toLowerCase();
    if (!s.prefs.picked.includes(h)) updatePrefs(s, { picked: [...s.prefs.picked, h].slice(-64) });
  };
  const setFill = (hex: string | null) => {
    if (hex) remember(hex);
    fmt((xs) => ({ ...xs, fill: hex ? { type: 'pattern', pattern: 'solid', fgColor: { argb: hexToArgb(hex) } } : { type: 'pattern', pattern: 'none' } }));
  };
  const setColor = (hex: string | null) => {
    if (hex) remember(hex);
    fmt((xs) => ({ ...xs, font: { ...(xs.font ?? {}), color: hex ? { argb: hexToArgb(hex) } : undefined } }));
  };
  const toggleWrapSel = () => {
    const allOn = rects(true).every((x) => {
      for (let r = x.r1; r <= x.r2; r++) for (let c = x.c1; c <= x.c2; c++) if (!sheet.rows[r]?.[c]?.xs?.alignment?.wrapText) return false;
      return true;
    });
    setAlign({ wrapText: !allOn });
  };
  const sheetWrapped = useMemo(() => {
    let n = 0;
    let w = 0;
    for (const row of sheet.rows) for (const c of row) if (c && c.v != null) {
      n++;
      if (c.xs?.alignment?.wrapText) w++;
    }
    return n > 0 && w / n > 0.5;
  }, [sheet]);
  const wrapSheet = (on: boolean) => {
    if (csv) return;
    apply(s, (sh) => mapCells(sh, [{ r1: 0, c1: 0, r2: Math.max(0, used.rows - 1), c2: Math.max(0, used.cols - 1) }], (cell) => (cell && cell.v != null ? { v: cell.v, xs: { ...(cell.xs ?? {}), alignment: { ...(cell.xs?.alignment ?? {}), wrapText: on } } } : undefined)));
  };

  const commitEdit = (value: string, move: 'down' | 'right' | 'none' = 'down') => {
    const ed = editRef.current;
    if (!ed) return;
    const { r, c } = ed;
    const prev = sheet.rows[r]?.[c]?.v;
    if (value !== editText(prev ?? null)) apply(s, (sh) => setValue(sh, r, c, parseInput(value, prev)));
    setEditing(null);
    if (move === 'down') moveActive(1, 0, false);
    if (move === 'right') moveActive(0, 1, false);
    wrap.current?.focus();
  };
  const startEdit = (initial?: string) => {
    if (readonly) return;
    ensureVisible(active.r, active.c);
    setEditing({ r: active.r, c: active.c, value: initial ?? editText(activeCell?.v ?? null) });
  };

  const navRows = useMemo(() => [...frozenRows, ...bodyRows].sort((a, b) => a - b), [bodyRows, frozenRows.join(',')]);
  function moveActive(dr: number, dc: number, extend: boolean) {
    const ri = Math.max(0, navRows.indexOf(sel.b.r === undefined ? active.r : extend ? sel.b.r : active.r));
    const base = extend ? sel.b : active;
    const nri = Math.min(navRows.length - 1, Math.max(0, navRows.indexOf(base.r) + dr));
    void ri;
    const r = navRows[nri] ?? base.r;
    const c = Math.min(nCols - 1, Math.max(0, base.c + dc));
    if (extend) setSel({ ...sel, b: { r, c }, mode: 'cells' });
    else setSel({ a: { r, c }, b: { r, c }, extra: [], mode: 'cells' });
    ensureVisible(r, c);
  }
  function ensureVisible(r: number, c: number) {
    const el = body.current;
    if (!el) return;
    const bi = bodyRows.indexOf(r);
    if (bi >= 0) {
      const y = rowTops[bi];
      const h = heightPx(r);
      if (y < el.scrollTop) el.scrollTop = y;
      else if (y + h > el.scrollTop + el.clientHeight) el.scrollTop = y + h - el.clientHeight;
    }
    const bj = bodyCols.indexOf(c);
    if (bj >= 0) {
      const x = colLefts[bj];
      const w = widthPx(c);
      if (x < el.scrollLeft) el.scrollLeft = x;
      else if (x + w > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.min(x, x + w - el.clientWidth);
    }
  }

  const copy = async (cut = false) => {
    const x = rects()[rects().length - 1];
    const r2 = Math.min(x.r2, Math.max(used.rows - 1, x.r1));
    const c2 = Math.min(x.c2, Math.max(used.cols - 1, x.c1));
    const lines: string[] = [];
    for (let r = x.r1; r <= r2; r++) {
      if (filtering && !navRows.includes(r)) continue;
      const vals: string[] = [];
      for (let c = x.c1; c <= c2; c++) {
        const t = displayText(sheet.rows[r]?.[c]?.v ?? null);
        vals.push(/[\t\n"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
      }
      lines.push(vals.join('\t'));
    }
    await navigator.clipboard.writeText(lines.join('\r\n')).catch(() => {});
    if (cut && !readonly) apply(s, (sh) => clearValues(sh, [{ ...x, r2, c2 }]));
  };
  const paste = async () => {
    if (readonly) return;
    const t = await navigator.clipboard.readText().catch(() => '');
    if (!t) return;
    const block = parseCsv(t.replace(/\r?\n$/, ''), '\t').rows;
    const x = rects()[rects().length - 1];
    apply(s, (sh) => pasteBlock(sh, x.r1, x.c1, block));
  };

  const sortBy = (keys: SortKey[]) => {
    if (readonly) return;
    const before = sheet;
    apply(s, (sh) => sortRows(sh, keys));
    if (s.hist.present[s.active] === before) showToast(sheet.merges.some((m) => m.r2 > sheet.header && m.r1 !== m.r2) ? 'Merged cells below the header row stop sorting. Unmerge them first.' : 'Nothing to sort below the header row.');
  };

  const freezeRowsSel = (on: boolean) => apply(s, (sh) => toggleFreezeRows(sh, selRowsList().filter((r) => r <= Math.max(used.rows, sel.a.r)), on));
  const freezeColsSel = (side: 'left' | 'right' | null) => apply(s, (sh) => freezeCols(sh, selColsList(), side));
  const unfreezeAll = () => apply(s, (sh) => ({ ...sh, freeze: { rows: [], left: [], right: [] } }));

  const fitCols = (cols = selColsList()) => {
    apply(s, (sh) => {
      const widths = sh.widths.slice();
      for (const c of cols) widths[c] = pxToWidth(fitColumn(sh, c, filtering ? navRows : undefined, inWideMerge));
      return { ...sh, widths };
    });
  };
  const fitRows = (rowsList = selRowsList()) => {
    apply(s, (sh) => {
      const heights = sh.heights.slice();
      for (const r of rowsList) if (r < used.rows) heights[r] = pxToHeight(fitRow(sh, r, (c) => fitWidth(sh)(r, c)));
      return { ...sh, heights };
    });
  };

  const insertRowAt = (below: boolean) => {
    const rs = selRowsList();
    const at = below ? rs[rs.length - 1] + 1 : rs[0];
    apply(s, (sh) => insertRows(sh, at, sel.mode === 'rows' ? rs.length : 1));
  };
  const insertColAt = (right: boolean) => {
    const cs = selColsList();
    const at = right ? cs[cs.length - 1] + 1 : cs[0];
    apply(s, (sh) => insertCols(sh, at, sel.mode === 'cols' ? cs.length : 1));
  };
  const deleteRowsSel = () => {
    const rs = selRowsList();
    apply(s, (sh) => deleteRows(sh, rs[0], rs[rs.length - 1]));
  };
  const deleteColsSel = () => {
    const cs = selColsList();
    apply(s, (sh) => deleteCols(sh, cs[0], cs[cs.length - 1]));
  };

  const addFilter = (input: string) => {
    const f = parseFilter(sheet, input);
    if (!f || !f.text) return;
    s.filters = [...s.filters, f];
    setFilterText('');
    sheetTick.value++;
    body.current && (body.current.scrollTop = 0);
  };
  const removeFilter = (i: number) => {
    s.filters = s.filters.filter((_, k) => k !== i);
    sheetTick.value++;
  };
  const sug = filterText ? suggestions(sheet, filterText) : [];

  const findGo = (dir: 1 | -1) => {
    if (!find || !findHits.length) return;
    const at = (find.at + dir + findHits.length) % findHits.length;
    const h = findHits[at];
    setFind({ ...find, at });
    setSel({ a: h, b: h, extra: [], mode: 'cells' });
    ensureVisible(h.r, h.c);
  };
  const replaceOne = (all: boolean) => {
    if (!find?.q || readonly) return;
    const re = new RegExp(find.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const targets = all ? findHits : findHits.slice(Math.max(0, find.at), Math.max(0, find.at) + 1);
    if (!targets.length) return;
    apply(s, (sh) => {
      let out = sh;
      for (const h of targets) {
        const cur = out.rows[h.r]?.[h.c]?.v ?? null;
        if (typeof cur !== 'string') continue;
        out = setValue(out, h.r, h.c, cur.replace(re, find.rep));
      }
      return out;
    });
    showToast(all ? `Replaced in ${targets.length} cell${targets.length === 1 ? '' : 's'}` : 'Replaced');
  };

  // ------------------------------------------------------------ pointer: select, edit, resize, move
  const hit = (x: number, y: number): Pos | null => {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('[data-r]') as HTMLElement | null;
    return el ? { r: Number(el.dataset.r), c: Number(el.dataset.c) } : null;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.button !== 2) return;
    const t = e.target as HTMLElement;
    if (t.closest('.sh-editor, .sh-dd')) return;
    wrap.current?.focus();
    if (editing) commitEdit(editing.value, 'none');
    const rzc = t.closest('[data-rzc]') as HTMLElement | null;
    const rzr = t.closest('[data-rzr]') as HTMLElement | null;
    if (rzc || rzr) return startResize(e, rzc ? 'c' : 'r', Number((rzc ?? rzr)!.dataset[rzc ? 'rzc' : 'rzr']));
    const chEl = t.closest('[data-ch]') as HTMLElement | null;
    const rhEl = t.closest('[data-rh]') as HTMLElement | null;
    if (e.button === 2) {
      // Right-click inside the selection keeps it; elsewhere selects what was clicked.
      const p = chEl ? { r: 0, c: Number(chEl.dataset.ch) } : rhEl ? { r: Number(rhEl.dataset.rh), c: 0 } : hit(e.clientX, e.clientY);
      if (!p) return;
      const inside = chEl ? selColsList().includes(p.c) && sel.mode === 'cols' : rhEl ? selRowsList().includes(p.r) && sel.mode === 'rows' : inSel(p.r, p.c);
      if (!inside) setSel({ a: p, b: p, extra: [], mode: chEl ? 'cols' : rhEl ? 'rows' : 'cells' });
      return;
    }
    if (t.closest('.sh-corner')) return setSel({ a: { r: 0, c: 0 }, b: { r: nRows - 1, c: nCols - 1 }, extra: [], mode: 'cells' });
    if (chEl || rhEl) {
      const kind = chEl ? 'c' : 'r';
      const idx = Number(chEl ? chEl.dataset.ch : rhEl!.dataset.rh);
      const already = kind === 'c' ? sel.mode === 'cols' && selColsList().includes(idx) : sel.mode === 'rows' && selRowsList().includes(idx);
      if (already && !e.shiftKey && !e.ctrlKey) return startMove(e, kind, idx);
      const p = kind === 'c' ? { r: 0, c: idx } : { r: idx, c: 0 };
      const mode = kind === 'c' ? 'cols' : 'rows';
      if (e.shiftKey) setSel({ ...sel, b: p, mode });
      else if (e.ctrlKey && sel.mode === mode) setSel({ a: p, b: p, extra: [...sel.extra, normRect(sel.a, sel.b)], mode });
      else setSel({ a: p, b: p, extra: [], mode });
      dragSelect(e, mode);
      return;
    }
    const p = hit(e.clientX, e.clientY);
    if (!p) return;
    if (e.shiftKey) setSel({ ...sel, b: p, mode: 'cells' });
    else if (e.ctrlKey) setSel({ a: p, b: p, extra: [...sel.extra, normRect(sel.a, sel.b)], mode: 'cells' });
    else setSel({ a: p, b: p, extra: [], mode: 'cells' });
    dragSelect(e, 'cells');
  };

  function dragSelect(e: PointerEvent, mode: 'cells' | 'rows' | 'cols') {
    const move = (ev: PointerEvent) => {
      const el = body.current;
      if (el) {
        const r = el.getBoundingClientRect();
        if (ev.clientY > r.bottom - 10) el.scrollTop += 20;
        if (ev.clientY < r.top + 10 && mode !== 'cols') el.scrollTop -= 20;
        if (ev.clientX > r.right - 10) el.scrollLeft += 20;
        if (ev.clientX < r.left + 10 && mode !== 'rows') el.scrollLeft -= 20;
      }
      const target = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      let p: Pos | null = null;
      if (mode === 'cols') {
        const h = target?.closest('[data-ch]') as HTMLElement | null;
        const cc = h ? Number(h.dataset.ch) : hit(ev.clientX, ev.clientY)?.c;
        if (cc != null) p = { r: 0, c: cc };
      } else if (mode === 'rows') {
        const h = target?.closest('[data-rh]') as HTMLElement | null;
        const rr = h ? Number(h.dataset.rh) : hit(ev.clientX, ev.clientY)?.r;
        if (rr != null) p = { r: rr, c: 0 };
      } else p = hit(ev.clientX, ev.clientY);
      if (p && (p.r !== s.sel.b.r || p.c !== s.sel.b.c)) setSel({ ...s.sel, b: p });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    void e;
  }

  function startResize(e: PointerEvent, kind: 'c' | 'r', idx: number) {
    e.preventDefault();
    e.stopPropagation();
    const start = kind === 'c' ? e.clientX : e.clientY;
    const zoom = (wrap.current?.getBoundingClientRect().width ?? 1) / (wrap.current?.offsetWidth || 1);
    const startPx = kind === 'c' ? widthPx(idx) : heightPx(idx);
    let px = startPx;
    const move = (ev: PointerEvent) => {
      px = Math.max(kind === 'c' ? 16 : 14, Math.round(startPx + ((kind === 'c' ? ev.clientX : ev.clientY) - start) / (zoom || 1)));
      setResize({ kind, idx, px });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setResize(null);
      if (px === startPx) return;
      if (kind === 'c') {
        const cols = selCols().includes(idx) ? selCols() : [idx];
        apply(s, (sh) => {
          const widths = sh.widths.slice();
          for (const c of cols) widths[c] = pxToWidth(px);
          return { ...sh, widths };
        });
      } else {
        const rowsSel = sel.mode === 'rows' && selRowsList().includes(idx) ? selRowsList() : [idx];
        apply(s, (sh) => {
          const heights = sh.heights.slice();
          for (const r of rowsSel) heights[r] = pxToHeight(px);
          return { ...sh, heights };
        });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function startMove(e: PointerEvent, kind: 'c' | 'r', idx: number) {
    const sx = e.clientX;
    const sy = e.clientY;
    let active2 = false;
    let at: number | null = null;
    const list = kind === 'c' ? selColsList() : selRowsList();
    const a = list[0];
    const b = list[list.length - 1];
    const move = (ev: PointerEvent) => {
      if (!active2 && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      active2 = true;
      const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest(kind === 'c' ? '[data-ch]' : '[data-rh]') as HTMLElement | null;
      if (!el) return;
      const i = Number(kind === 'c' ? el.dataset.ch : el.dataset.rh);
      const r = el.getBoundingClientRect();
      const after = kind === 'c' ? ev.clientX > r.left + r.width / 2 : ev.clientY > r.top + r.height / 2;
      at = after ? i + 1 : i;
      setMoveMark({ kind, at: i, after });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setMoveMark(null);
      if (!active2 || at == null) {
        // A plain click on a selected header: select just that one.
        const p = kind === 'c' ? { r: 0, c: idx } : { r: idx, c: 0 };
        setSel({ a: p, b: p, extra: [], mode: kind === 'c' ? 'cols' : 'rows' });
        return;
      }
      if (at >= a && at <= b + 1) return;
      const n = b - a + 1;
      const dest = at > b ? at - n : at;
      if (kind === 'c') {
        apply(s, (sh) => moveCols(sh, a, b, at!));
        setSel({ a: { r: 0, c: dest }, b: { r: 0, c: dest + n - 1 }, extra: [], mode: 'cols' });
      } else {
        apply(s, (sh) => moveRows(sh, a, b, at!));
        setSel({ a: { r: dest, c: 0 }, b: { r: dest + n - 1, c: 0 }, extra: [], mode: 'rows' });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const onDblClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    const rzc = t.closest('[data-rzc]') as HTMLElement | null;
    const rzr = t.closest('[data-rzr]') as HTMLElement | null;
    if (rzc) return fitCols(selCols().includes(Number(rzc.dataset.rzc)) ? selCols() : [Number(rzc.dataset.rzc)]);
    if (rzr) return fitRows([Number(rzr.dataset.rzr)]);
    if (t.closest('[data-r]')) startEdit();
  };

  // ------------------------------------------------------------ keyboard
  const onKeyDown = (e: KeyboardEvent) => {
    if (dialog) return;
    const pending = editRef.current;
    if (pending && !(e.target as HTMLElement).closest('textarea, select')) {
      // The edit box isn't there yet: keep the typing.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setEditing({ ...pending, value: pending.value + e.key });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        commitEdit(pending.value, 'down');
      } else if (e.key === 'Escape') setEditing(null);
      return;
    }
    if (editing) return;
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (mod && !e.altKey) {
      if (k === 'z') return stop(), e.shiftKey ? redo(s) : undo(s);
      if (k === 'y') return stop(), redo(s);
      if (k === 'c') return stop(), void copy();
      if (k === 'x') return stop(), void copy(true);
      if (k === 'v') return stop(), void paste();
      if (k === 'a') return stop(), setSel({ a: { r: 0, c: 0 }, b: { r: nRows - 1, c: nCols - 1 }, extra: [], mode: 'cells' });
      if (k === 'f') return stop(), setFind({ q: find?.q ?? '', rep: find?.rep ?? '', replace: false, at: -1 });
      if (k === 'h') return stop(), setFind({ q: find?.q ?? '', rep: find?.rep ?? '', replace: true, at: -1 });
      if (k === 'b') return stop(), setFont({ bold: !activeLook.bold });
      if (k === 'i') return stop(), setFont({ italic: !activeLook.italic });
      if (k === 'u') return stop(), setFont({ underline: !activeLook.underline });
      return;
    }
    const nav: Record<string, [number, number]> = { arrowdown: [1, 0], arrowup: [-1, 0], arrowleft: [0, -1], arrowright: [0, 1] };
    if (nav[k]) return stop(), moveActive(nav[k][0], nav[k][1], e.shiftKey);
    if (k === 'pagedown' || k === 'pageup') return stop(), moveActive(k === 'pagedown' ? 20 : -20, 0, e.shiftKey);
    if (k === 'home') return stop(), moveActive(0, -active.c, e.shiftKey);
    if (k === 'tab') return stop(), moveActive(0, e.shiftKey ? -1 : 1, false);
    if (k === 'enter') return stop(), e.shiftKey ? moveActive(-1, 0, false) : startEdit();
    if (k === 'f2') return stop(), startEdit();
    if (k === 'delete' || k === 'backspace') {
      stop();
      if (!readonly) apply(s, (sh) => clearValues(sh, rects(true)));
      return;
    }
    if (k === 'escape') {
      if (s.filters.length && !find) return;
      return;
    }
    if (e.key.length === 1 && !e.altKey && !readonly) {
      stop();
      startEdit(e.key);
    }
  };

  // ------------------------------------------------------------ menus
  const menuFor = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    const onCol = !!t.closest('[data-ch]');
    const onRow = !!t.closest('[data-rh]');
    const cell = sheet.rows[sel.a.r]?.[sel.a.c] ?? null;
    const full = cell ? displayText(cell.v) : '';
    const sortItems: MenuItem[] = [
      { label: `Sort A → Z by ${headName(sel.a.c)}`, action: () => sortBy([{ col: sel.a.c, desc: false }]), disabled: readonly },
      { label: `Sort Z → A by ${headName(sel.a.c)}`, action: () => sortBy([{ col: sel.a.c, desc: true }]), disabled: readonly },
    ];
    const freezeItems: MenuItem[] = [
      { label: 'Freeze rows', action: () => freezeRowsSel(true) },
      { label: 'Unfreeze rows', action: () => freezeRowsSel(false), disabled: !selRowsList().some((r) => fzRowSet.has(r)) },
      { label: 'Freeze columns to the left', action: () => freezeColsSel('left') },
      { label: 'Freeze columns to the right', action: () => freezeColsSel('right') },
      { label: 'Unfreeze columns', action: () => freezeColsSel(null), disabled: !selColsList().some((c) => fzColSet.has(c)) },
    ];
    let items: MenuItem[];
    if (onCol) {
      items = [
        ...sortItems,
        { separator: true },
        { label: 'Fit to data width', action: () => fitCols() },
        { label: 'Freeze to the left', action: () => freezeColsSel('left') },
        { label: 'Freeze to the right', action: () => freezeColsSel('right') },
        { label: 'Unfreeze', action: () => freezeColsSel(null), disabled: !selColsList().some((c) => fzColSet.has(c)) },
        { separator: true },
        { label: 'Wrap text on / off', action: toggleWrapSel, disabled: csv },
        { label: 'Insert column left', action: () => insertColAt(false), disabled: readonly },
        { label: 'Insert column right', action: () => insertColAt(true), disabled: readonly },
        { label: selColsList().length > 1 ? `Delete ${selColsList().length} columns` : 'Delete column', action: deleteColsSel, danger: true, disabled: readonly },
      ];
    } else if (onRow) {
      items = [
        { label: 'Freeze rows', action: () => freezeRowsSel(true) },
        { label: 'Unfreeze rows', action: () => freezeRowsSel(false), disabled: !selRowsList().some((r) => fzRowSet.has(r)) },
        { label: 'Use as header row', checked: sheet.header === sel.a.r, action: () => apply(s, (sh) => ({ ...sh, header: sheet.header === sel.a.r ? -1 : sel.a.r }), { view: true }) },
        { separator: true },
        { label: 'Fit to data height', action: () => fitRows() },
        { label: 'Wrap text on / off', action: toggleWrapSel, disabled: csv },
        { separator: true },
        { label: 'Insert row above', action: () => insertRowAt(false), disabled: readonly },
        { label: 'Insert row below', action: () => insertRowAt(true), disabled: readonly },
        { label: selRowsList().length > 1 ? `Delete ${selRowsList().length} rows` : 'Delete row', action: deleteRowsSel, danger: true, disabled: readonly },
      ];
    } else {
      items = [
        { label: 'Cut', shortcut: 'Ctrl+X', action: () => void copy(true), disabled: readonly },
        { label: 'Copy', shortcut: 'Ctrl+C', action: () => void copy() },
        { label: 'Paste', shortcut: 'Ctrl+V', action: () => void paste(), disabled: readonly },
        { separator: true },
        { label: 'Copy cell text', action: () => void navigator.clipboard.writeText(full), disabled: !full },
        { label: 'View full text…', action: () => setDialog({ kind: 'text', text: full, title: `${colName(sel.a.c)}${sel.a.r + 1}` }), disabled: !full },
        { separator: true },
        ...sortItems,
        { label: 'Freeze', submenu: freezeItems },
        { label: 'Wrap text on / off', action: toggleWrapSel, disabled: csv },
        { separator: true },
        { label: 'Insert row above', action: () => insertRowAt(false), disabled: readonly },
        { label: 'Insert column left', action: () => insertColAt(false), disabled: readonly },
        { label: 'Delete row', action: deleteRowsSel, disabled: readonly },
        { label: 'Delete column', action: deleteColsSel, disabled: readonly },
        { separator: true },
        { label: 'Clear contents', shortcut: 'Del', action: () => apply(s, (sh) => clearValues(sh, rects(true))), disabled: readonly },
        { label: 'Clear formatting', action: () => apply(s, (sh) => clearFormatting(sh, rects(true))), disabled: csv },
      ];
    }
    openContextMenu(e, items);
  };
  const headName = (c: number) => {
    const h = sheet.header >= 0 ? displayText(sheet.rows[sheet.header]?.[c]?.v ?? null) : '';
    return h ? `"${h.length > 24 ? h.slice(0, 24) + '…' : h}"` : `column ${colName(c)}`;
  };

  // Close pop-ups on outside click.
  useEffect(() => {
    if (!pop) return;
    const close = (e: PointerEvent) => !(e.target as HTMLElement).closest('.sh-pop-anchor') && setPop(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [pop]);

  // ------------------------------------------------------------ editor box position
  const [edBox, setEdBox] = useState<null | { x: number; y: number; w: number; h: number }>(null);
  useLayoutEffect(() => {
    if (!editing) return void setEdBox(null);
    const el = wrap.current?.querySelector(`.sh-grid [data-r="${editing.r}"][data-c="${editing.c}"]`) as HTMLElement | null;
    const host = wrap.current?.getBoundingClientRect();
    if (!el || !host) return;
    const r = el.getBoundingClientRect();
    const z = host.width / (wrap.current!.offsetWidth || 1) || 1;
    setEdBox({ x: (r.left - host.left) / z, y: (r.top - host.top) / z, w: r.width / z, h: r.height / z });
  }, [editing?.r, editing?.c, scroll]);

  const list = editing ? sheet.lists[keyOf(editing.r, editing.c)] : undefined;
  const shownRows = filtering ? bodyRows.filter((r) => r > sheet.header && r <= lastData).length : 0;
  const totalData = Math.max(0, lastData - sheet.header);

  // ------------------------------------------------------------ render
  const B = ({ on, title, onClick, children, disabled }: { on?: boolean; title: string; onClick: () => void; children: JSX.Element | string; disabled?: boolean }) => (
    <button class={`fb-btn${on ? ' on' : ''}`} title={title} aria-label={title} aria-pressed={!!on} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {children}
    </button>
  );
  const noFmt = csv || readonly;
  const sizes = SIZES.includes(activeCell?.xs?.font?.size ?? 11) ? SIZES : [...SIZES, activeCell!.xs!.font!.size!].sort((a, b) => a - b);
  const fontName = activeCell?.xs?.font?.name ?? 'Calibri';
  const fonts = FONTS.includes(fontName) ? FONTS : [fontName, ...FONTS];

  return (
    <div class="sh" ref={wrap} tabIndex={0} onKeyDown={(e) => onKeyDown(e as KeyboardEvent)}>
      {/* Formatting for the selected cells (like the text toolbar) */}
      <div class="formatbar sh-fmt" role="toolbar" aria-label="Cell formatting">
        <select class="fb-select" style={{ width: '130px' }} disabled={noFmt} value={fontName} title="Font" onChange={(e) => setFont({ name: (e.target as HTMLSelectElement).value })}>
          {fonts.map((f) => <option value={f}>{f}</option>)}
        </select>
        <select class="fb-select fb-narrow" disabled={noFmt} value={String(activeCell?.xs?.font?.size ?? 11)} title="Font size" onChange={(e) => setFont({ size: Number((e.target as HTMLSelectElement).value) })}>
          {sizes.map((n) => <option value={String(n)}>{n}</option>)}
        </select>
        <span class="fb-sep" />
        <B on={activeLook.bold} title="Bold (Ctrl+B)" disabled={noFmt} onClick={() => setFont({ bold: !activeLook.bold })}><I.IcBold /></B>
        <B on={activeLook.italic} title="Italic (Ctrl+I)" disabled={noFmt} onClick={() => setFont({ italic: !activeLook.italic })}><I.IcItalic /></B>
        <B on={activeLook.underline} title="Underline (Ctrl+U)" disabled={noFmt} onClick={() => setFont({ underline: !activeLook.underline })}><I.IcUnderline /></B>
        <B on={activeLook.strike} title="Strikethrough" disabled={noFmt} onClick={() => setFont({ strike: !activeLook.strike })}><I.IcStrike /></B>
        <ColourButton kind="font" open={pop === 'font'} disabled={noFmt} onOpen={() => setPop(pop === 'font' ? null : 'font')} onPick={(h) => (setColor(h), setPop(null))} />
        <ColourButton kind="fill" open={pop === 'fill'} disabled={noFmt} onOpen={() => setPop(pop === 'fill' ? null : 'fill')} onPick={(h) => (setFill(h), setPop(null))} />
        <span class="fb-sep" />
        <B on={activeLook.h === 'left'} title="Align left" disabled={noFmt} onClick={() => setAlign({ horizontal: 'left' })}><I.IcAlignLeft /></B>
        <B on={activeLook.h === 'center'} title="Centre" disabled={noFmt} onClick={() => setAlign({ horizontal: 'center' })}><I.IcAlignCenter /></B>
        <B on={activeLook.h === 'right'} title="Align right" disabled={noFmt} onClick={() => setAlign({ horizontal: 'right' })}><I.IcAlignRight /></B>
        <span class="fb-sep" />
        <B on={activeLook.v === 'top'} title="Align to top" disabled={noFmt} onClick={() => setAlign({ vertical: 'top' })}><IcVTop /></B>
        <B on={activeLook.v === 'middle'} title="Align to middle" disabled={noFmt} onClick={() => setAlign({ vertical: 'middle' })}><IcVMid /></B>
        <B on={activeLook.v === 'bottom'} title="Align to bottom" disabled={noFmt} onClick={() => setAlign({ vertical: 'bottom' })}><IcVBot /></B>
        <span class="fb-sep" />
        <B on={activeLook.wrap} title="Wrap text in the selected cells" disabled={noFmt} onClick={toggleWrapSel}><I.IcWrap /></B>
        <B title="Clear formatting" disabled={noFmt} onClick={() => apply(s, (sh) => clearFormatting(sh, rects(true)))}><IcClearFmt /></B>
        {csv && <span class="sh-note">CSV files store text only: formatting is off.</span>}
      </div>

      {/* Sheet tools */}
      <div class="sh-tools" role="toolbar" aria-label="Sheet tools">
        <button class="sh-tbtn" title="Undo (Ctrl+Z)" disabled={!s.hist.past.length} onClick={() => undo(s)}><IcUndo /></button>
        <button class="sh-tbtn" title="Redo (Ctrl+Y)" disabled={!s.hist.future.length} onClick={() => redo(s)}><IcRedo /></button>
        <span class="fb-sep" />
        <div class="sh-filter sh-pop-anchor">
          <I.IcSearch size={14} />
          {s.filters.map((f, i) => (
            <span class="sh-chip" key={i}>
              {filterLabel(sheet, f)}
              <button title="Remove this filter" onClick={() => removeFilter(i)}><I.IcClose size={10} /></button>
            </span>
          ))}
          <input
            placeholder={s.filters.length ? 'Add another filter…' : sheet.header >= 0 ? 'Filter rows… (e.g. Phase: 4)' : 'Filter rows…'}
            value={filterText}
            onInput={(e) => (setFilterText((e.target as HTMLInputElement).value), setSugIdx(0))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') return e.preventDefault(), setSugIdx(Math.min(sug.length - 1, sugIdx + 1));
              if (e.key === 'ArrowUp') return e.preventDefault(), setSugIdx(Math.max(0, sugIdx - 1));
              if (e.key === 'Tab' && sug[sugIdx]) return e.preventDefault(), setFilterText(sug[sugIdx]);
              if (e.key === 'Enter') return e.preventDefault(), addFilter(sug[sugIdx] && !filterText.includes(':') && sug[sugIdx].toLowerCase().startsWith(filterText.toLowerCase()) ? sug[sugIdx] : filterText);
              if (e.key === 'Escape') return e.preventDefault(), filterText ? setFilterText('') : s.filters.length && ((s.filters = []), sheetTick.value++);
              if (e.key === 'Backspace' && !filterText && s.filters.length) removeFilter(s.filters.length - 1);
            }}
          />
          {sug.length > 0 && (
            <div class="sh-sug" role="listbox">
              {sug.map((x, i) => (
                <div class={`sh-sug-item${i === sugIdx ? ' on' : ''}`} role="option" onMouseDown={(e) => (e.preventDefault(), x.endsWith(': ') ? setFilterText(x) : addFilter(x))}>
                  {x}
                </div>
              ))}
              <div class="sh-sug-hint">Enter filters · Tab completes · "Heading: value" filters one column</div>
            </div>
          )}
        </div>
        <Drop label="Sort" open={pop === 'sort'} onOpen={() => setPop(pop === 'sort' ? null : 'sort')}>
          <MenuBtn onClick={() => (sortBy([{ col: sel.a.c, desc: false }]), setPop(null))} disabled={readonly}>Sort A → Z by {headName(sel.a.c)}</MenuBtn>
          <MenuBtn onClick={() => (sortBy([{ col: sel.a.c, desc: true }]), setPop(null))} disabled={readonly}>Sort Z → A by {headName(sel.a.c)}</MenuBtn>
          <MenuBtn onClick={() => (setDialog({ kind: 'sort', keys: [{ col: sel.a.c, desc: false }] }), setPop(null))} disabled={readonly}>Custom sort…</MenuBtn>
          <div class="sh-menu-note">Rows above the header row ({sheet.header >= 0 ? sheet.header + 1 : 'none'}) never move.</div>
        </Drop>
        <Drop label="Freeze" open={pop === 'freeze'} onOpen={() => setPop(pop === 'freeze' ? null : 'freeze')}>
          <MenuBtn onClick={() => (freezeRowsSel(true), setPop(null))}>Freeze selected rows</MenuBtn>
          <MenuBtn onClick={() => (freezeColsSel('left'), setPop(null))}>Freeze selected columns to the left</MenuBtn>
          <MenuBtn onClick={() => (freezeColsSel('right'), setPop(null))}>Freeze selected columns to the right</MenuBtn>
          <MenuBtn onClick={() => (freezeRowsSel(false), freezeColsSel(null), setPop(null))}>Unfreeze selection</MenuBtn>
          <MenuBtn onClick={() => (unfreezeAll(), setPop(null))} disabled={!frozenRows.length && !leftCols.length && !rightCols.length}>Unfreeze all</MenuBtn>
        </Drop>
        <Drop label="Fit" open={pop === 'fit'} onOpen={() => setPop(pop === 'fit' ? null : 'fit')}>
          <MenuBtn onClick={() => (fitCols(sel.mode === 'cells' && rects().length === 1 && normRect(sel.a, sel.b).c1 === normRect(sel.a, sel.b).c2 && normRect(sel.a, sel.b).r1 === normRect(sel.a, sel.b).r2 ? Array.from({ length: used.cols }, (_, i) => i) : selColsList()), setPop(null))}>Fit columns to data width</MenuBtn>
          <MenuBtn onClick={() => (fitRows(sel.mode === 'rows' ? selRowsList() : Array.from({ length: used.rows }, (_, i) => i)), setPop(null))}>Fit rows to data height</MenuBtn>
          <div class="sh-menu-note">With one cell selected, columns fit the whole sheet.</div>
        </Drop>
        <Drop label={`Wrap: ${sheetWrapped ? 'on' : 'off'}`} open={pop === 'wrap'} onOpen={() => setPop(pop === 'wrap' ? null : 'wrap')} disabled={csv}>
          <MenuBtn onClick={() => (wrapSheet(true), setPop(null))}>Wrap text in the whole sheet</MenuBtn>
          <MenuBtn onClick={() => (wrapSheet(false), setPop(null))}>No wrapping in the whole sheet</MenuBtn>
          <div class="sh-menu-note">For some cells only: select them and use the wrap button above.</div>
        </Drop>
        <button class="sh-tbtn sh-wide" title="Alternating colours for the selected cells" disabled={noFmt} onClick={() => setDialog({ kind: 'bands', odd: lastPair(s).odd, even: lastPair(s).even })}>
          <IcBands /> Alternating colours…
        </button>
        <Drop label="Insert / delete" open={pop === 'insert'} onOpen={() => setPop(pop === 'insert' ? null : 'insert')} disabled={readonly}>
          <MenuBtn onClick={() => (insertRowAt(false), setPop(null))}>Insert row above</MenuBtn>
          <MenuBtn onClick={() => (insertRowAt(true), setPop(null))}>Insert row below</MenuBtn>
          <MenuBtn onClick={() => (insertColAt(false), setPop(null))}>Insert column left</MenuBtn>
          <MenuBtn onClick={() => (insertColAt(true), setPop(null))}>Insert column right</MenuBtn>
          <MenuBtn onClick={() => (deleteRowsSel(), setPop(null))}>Delete selected rows</MenuBtn>
          <MenuBtn onClick={() => (deleteColsSel(), setPop(null))}>Delete selected columns</MenuBtn>
        </Drop>
        {!csv && (
          <div class="seg sh-colours" role="radiogroup" aria-label="File colours" title="How the file's own colours show (the file always keeps them)">
            {(['original', 'adapted', 'none'] as ColourMode[]).map((m) => (
              <button class={colourMode === m ? 'on' : ''} role="radio" aria-checked={colourMode === m} onClick={() => updateSettings({ sheetColours: m })}>
                {m === 'original' ? 'Original' : m === 'adapted' ? 'Adapted' : 'None'}
              </button>
            ))}
          </div>
        )}
        <button class="sh-tbtn" title="Find and replace (Ctrl+F, Ctrl+H)" onClick={() => setFind(find ? null : { q: '', rep: '', replace: false, at: -1 })}>
          <I.IcSearch />
        </button>
        <span class="sh-status">
          {colName(sel.a.c)}{sel.a.r + 1}
          {filtering ? ` · ${shownRows} of ${totalData} rows` : ''}
        </span>
      </div>

      {find && (
        <div class="sh-find">
          <input autoFocus placeholder="Find" value={find.q} onInput={(e) => setFind({ ...find, q: (e.target as HTMLInputElement).value, at: -1 })} onKeyDown={(e) => {
            if (e.key === 'Enter') findGo(e.shiftKey ? -1 : 1);
            if (e.key === 'Escape') setFind(null), wrap.current?.focus();
          }} />
          <span class="sh-find-count">{find.q ? `${findHits.length ? Math.max(0, find.at) + 1 : 0} of ${findHits.length}` : ''}</span>
          <button class="btn small" onClick={() => findGo(-1)} disabled={!findHits.length}>Previous</button>
          <button class="btn small" onClick={() => findGo(1)} disabled={!findHits.length}>Next</button>
          <button class="btn small" onClick={() => setFind({ ...find, replace: !find.replace })}>{find.replace ? 'Hide replace' : 'Replace…'}</button>
          {find.replace && (
            <>
              <input placeholder="Replace with" value={find.rep} onInput={(e) => setFind({ ...find, rep: (e.target as HTMLInputElement).value })} />
              <button class="btn small" disabled={!findHits.length || readonly} onClick={() => replaceOne(false)}>Replace</button>
              <button class="btn small" disabled={!findHits.length || readonly} onClick={() => replaceOne(true)}>Replace all</button>
            </>
          )}
          <button class="sh-tbtn" title="Close (Esc)" onClick={() => (setFind(null), wrap.current?.focus())}><I.IcClose size={12} /></button>
        </div>
      )}

      {/* The grid */}
      <div
        class={`sh-grid${frozenRows.length ? ' has-top' : ''}${leftCols.length ? ' has-left' : ''}${rightCols.length ? ' has-right' : ''}`}
        ref={gridRef}
        style={{ '--rowhdr': `${ROWHDR}px`, '--colhdr': `${COLHDR}px`, '--top': `${topShown}px`, '--left': `${leftW}px`, '--right': `${rightW}px` } as any}
        onPointerDown={(e) => onPointerDown(e as PointerEvent)}
        onDblClick={(e) => onDblClick(e as MouseEvent)}
        onContextMenu={(e) => menuFor(e as MouseEvent)}
      >
        {/* top-left: corner, left frozen column headers, frozen rows' headers × left cells */}
        <div class="sh-pane sh-tl" onWheel={(e) => topWheel(e as WheelEvent)}>
          <div class="sh-corner" title="Select all (Ctrl+A)" />
          <div class="sh-layer" style={{ left: `${ROWHDR}px` }}>{colHeaders(leftCols, leftLefts, true)}</div>
          <div class="sh-band" style={{ height: `${topShown}px` }}>
            <div class="sh-layer" style={{ transform: `translateY(${-tScroll}px)` }}>
              {rowHeaders(frozenRows, fzTops, true)}
              <div class="sh-layer" style={{ left: `${ROWHDR}px` }}>{cellsBlock(frozenRows, fzTops, leftCols, leftLefts, () => true)}</div>
            </div>
          </div>
        </div>
        {/* top: column headers + frozen rows (scroll sideways with the body) */}
        <div class="sh-pane sh-tm" onWheel={(e) => topWheel(e as WheelEvent)}>
          <div class="sh-layer" style={{ transform: `translateX(${-scroll.left}px)` }}>{colHeaders(winCols, winLefts, false)}</div>
          <div class="sh-band" style={{ height: `${topShown}px` }}>
            <div class="sh-layer" style={{ transform: `translate(${-scroll.left}px, ${-tScroll}px)` }}>{cellsBlock(frozenRows, fzTops, winCols, winLefts, () => true)}</div>
          </div>
        </div>
        <div class="sh-pane sh-tr" onWheel={(e) => topWheel(e as WheelEvent)}>
          {colHeaders(rightCols, rightLefts, true)}
          <div class="sh-band" style={{ height: `${topShown}px` }}>
            <div class="sh-layer" style={{ transform: `translateY(${-tScroll}px)` }}>{cellsBlock(frozenRows, fzTops, rightCols, rightLefts, () => true)}</div>
          </div>
        </div>
        {/* left: row headers + left frozen columns (scroll up/down with the body) */}
        <div class="sh-pane sh-ml" onWheel={(e) => forwardWheel(e as WheelEvent)}>
          <div class="sh-layer" style={{ transform: `translateY(${-scroll.top}px)` }}>
            {rowHeaders(winRows, winTops, false)}
            <div class="sh-layer" style={{ left: `${ROWHDR}px` }}>{cellsBlock(winRows, winTops, leftCols, leftLefts, () => true)}</div>
          </div>
        </div>
        {/* the body: the one real scroller */}
        <div class="sh-pane sh-mm" ref={body} onScroll={onScroll}>
          <div class="sh-size" style={{ width: `${totalW}px`, height: `${totalH}px` }} />
          {cellsBlock(winRows, winTops, winCols, winLefts, () => false)}
        </div>
        <div class="sh-pane sh-mr" onWheel={(e) => forwardWheel(e as WheelEvent)}>
          <div class="sh-layer" style={{ transform: `translateY(${-scroll.top}px)` }}>{cellsBlock(winRows, winTops, rightCols, rightLefts, () => true)}</div>
        </div>
      </div>

      {/* Cell editor */}
      {editing && (list ? (
        <select
          class="sh-dd"
          autoFocus
          style={edBox ? { left: `${edBox.x}px`, top: `${edBox.y}px`, width: `${Math.max(edBox.w, 140)}px` } : { left: '-9999px', top: '0' }}
          value={editing.value}
          onChange={(e) => commitEdit((e.target as HTMLSelectElement).value)}
          onKeyDown={(e) => e.key === 'Escape' && (setEditing(null), wrap.current?.focus())}
          onBlur={() => setEditing(null)}
        >
          {!list.includes(editing.value) && <option value={editing.value}>{editing.value || '—'}</option>}
          {list.map((o) => <option value={o}>{o}</option>)}
        </select>
      ) : (
        <textarea
          class="sh-editor"
          autoFocus
          spellcheck={false}
          style={edBox ? { left: `${edBox.x}px`, top: `${edBox.y}px`, width: `${Math.max(edBox.w, editing.value.length > 40 ? 340 : edBox.w)}px`, minHeight: `${edBox.h}px`, font: lookOf(sheet.rows[editing.r]?.[editing.c]?.xs).font } : { left: '-9999px', top: '0' }}
          value={editing.value}
          ref={(el) => {
            if (el && editing.value.length > 40) autoGrow(el);
          }}
          onInput={(e) => (setEditing({ ...editRef.current!, value: (e.target as HTMLTextAreaElement).value }), autoGrow(e.target as HTMLTextAreaElement))}
          onFocus={(e) => {
            const el = e.target as HTMLTextAreaElement;
            el.selectionStart = el.selectionEnd = el.value.length;
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            const v = (e.target as HTMLTextAreaElement).value;
            if (e.key === 'Enter' && !e.altKey && !e.shiftKey) return e.preventDefault(), commitEdit(v, 'down');
            if (e.key === 'Enter' && e.altKey) {
              e.preventDefault();
              const el = e.target as HTMLTextAreaElement;
              const a = el.selectionStart;
              const next = v.slice(0, a) + '\n' + v.slice(el.selectionEnd);
              setEditing({ ...editing, value: next });
              requestAnimationFrame(() => (el.selectionStart = el.selectionEnd = a + 1));
              return;
            }
            if (e.key === 'Tab') return e.preventDefault(), commitEdit(v, 'right');
            if (e.key === 'Escape') return e.preventDefault(), setEditing(null), wrap.current?.focus();
          }}
          onBlur={(e) => editRef.current && commitEdit((e.target as HTMLTextAreaElement).value, 'none')}
        />
      ))}

      {/* Sheet tabs */}
      {s.hist.present.length > 1 && (
        <div class="sheet-tabs" role="tablist">
          {s.hist.present.map((sh, i) => (
            <button key={sh.name} role="tab" aria-selected={i === s.active} class={`sheet-tab${i === s.active ? ' on' : ''}`} onClick={() => {
              s.active = i;
              s.filters = [];
              s.sel = { a: { r: 0, c: 0 }, b: { r: 0, c: 0 }, extra: [], mode: 'cells' };
              setScroll({ top: 0, left: 0 });
              if (body.current) body.current.scrollTop = body.current.scrollLeft = 0;
              sheetTick.value++;
            }}>
              {sh.name}
            </button>
          ))}
        </div>
      )}

      {dialog?.kind === 'bands' && (
        <Modal title="Alternating colours" onClose={() => setDialog(null)}>
          <p class="set-desc">Odd and even rows of the selected range get these two colours. It's saved as a rule, so the colours stay in order when you sort or add rows.</p>
          <div class="sh-band-pick">
            <label>Odd rows <input type="color" value={dialog.odd} onInput={(e) => setDialog({ ...dialog, odd: (e.target as HTMLInputElement).value })} /></label>
            <label>Even rows <input type="color" value={dialog.even} onInput={(e) => setDialog({ ...dialog, even: (e.target as HTMLInputElement).value })} /></label>
          </div>
          {s.prefs.pairs.length > 0 && (
            <>
              <div class="set-desc">Saved colour pairs in this workbook:</div>
              <div class="sh-pairs">
                {s.prefs.pairs.map((p, i) => (
                  <button class="sh-pair" key={i} title="Use this pair" onClick={() => setDialog({ ...dialog, odd: argbToHex(p.odd) ?? '#ffffff', even: argbToHex(p.even) ?? '#ffffff' })}>
                    <span style={{ background: argbToHex(p.odd) ?? '' }} />
                    <span style={{ background: argbToHex(p.even) ?? '' }} />
                  </button>
                ))}
              </div>
            </>
          )}
          <div class="modal-buttons sh-modal-buttons">
            <button class="btn" onClick={() => {
              const x = rects(true)[rects().length - 1];
              apply(s, (sh) => ({ ...sh, bands: sh.bands.filter((b) => !(b.ref.r2 >= x.r1 && b.ref.r1 <= x.r2 && b.ref.c2 >= x.c1 && b.ref.c1 <= x.c2)) }));
              setDialog(null);
            }}>Remove alternating colours</button>
            <span style={{ flex: 1 }} />
            <button class="btn" onClick={() => setDialog(null)}>Cancel</button>
            <button class="btn primary" onClick={() => {
              const x = rects(true)[rects().length - 1];
              const pair = { odd: hexToArgb(dialog.odd), even: hexToArgb(dialog.even) };
              apply(s, (sh) => ({ ...sh, bands: [...sh.bands.filter((b) => !(b.ref.r1 === x.r1 && b.ref.c1 === x.c1 && b.ref.r2 === x.r2 && b.ref.c2 === x.c2)), { ref: x, ...pair }] }));
              const pairs = [pair, ...s.prefs.pairs.filter((p) => p.odd !== pair.odd || p.even !== pair.even)].slice(0, 8);
              updatePrefs(s, { pairs, picked: [...new Set([...s.prefs.picked, dialog.odd.toLowerCase(), dialog.even.toLowerCase()])] });
              setDialog(null);
            }}>Apply</button>
          </div>
        </Modal>
      )}

      {dialog?.kind === 'sort' && (
        <Modal title="Custom sort" onClose={() => setDialog(null)}>
          <p class="set-desc">Sorts the rows below the header row (row {sheet.header + 1}). Later levels break ties.</p>
          {dialog.keys.map((k, i) => (
            <div class="sh-sort-row" key={i}>
              <span>{i === 0 ? 'Sort by' : 'Then by'}</span>
              <select class="select" value={String(k.col)} onChange={(e) => setDialog({ ...dialog, keys: dialog.keys.map((x, j) => (j === i ? { ...x, col: Number((e.target as HTMLSelectElement).value) } : x)) })}>
                {Array.from({ length: used.cols }, (_, c) => <option value={String(c)}>{headings(sheet).find((h) => h.col === c)?.name ?? `Column ${colName(c)}`}</option>)}
              </select>
              <select class="select" value={k.desc ? 'desc' : 'asc'} onChange={(e) => setDialog({ ...dialog, keys: dialog.keys.map((x, j) => (j === i ? { ...x, desc: (e.target as HTMLSelectElement).value === 'desc' } : x)) })}>
                <option value="asc">A → Z (smallest first)</option>
                <option value="desc">Z → A (largest first)</option>
              </select>
              {i > 0 && <button class="sh-tbtn" title="Remove this level" onClick={() => setDialog({ ...dialog, keys: dialog.keys.filter((_, j) => j !== i) })}><I.IcClose size={12} /></button>}
            </div>
          ))}
          {dialog.keys.length < 3 && <button class="btn small" onClick={() => setDialog({ ...dialog, keys: [...dialog.keys, { col: 0, desc: false }] })}>Add level</button>}
          <div class="modal-buttons sh-modal-buttons">
            <span style={{ flex: 1 }} />
            <button class="btn" onClick={() => setDialog(null)}>Cancel</button>
            <button class="btn primary" onClick={() => (sortBy(dialog.keys), setDialog(null))}>Sort</button>
          </div>
        </Modal>
      )}

      {dialog?.kind === 'text' && (
        <Modal title={`Cell ${dialog.title}`} onClose={() => setDialog(null)}>
          <textarea class="sh-fulltext" readOnly value={dialog.text} />
          <div class="modal-buttons sh-modal-buttons">
            <span style={{ flex: 1 }} />
            <button class="btn" onClick={() => void navigator.clipboard.writeText(dialog.text).then(() => showToast('Copied'))}>Copy</button>
            <button class="btn primary" onClick={() => setDialog(null)}>Close</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------ small parts

function cumulative(list: number[], size: (i: number) => number): number[] {
  const out = new Array(list.length + 1);
  out[0] = 0;
  for (let i = 0; i < list.length; i++) out[i + 1] = out[i] + size(list[i]);
  return out;
}

function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(320, el.scrollHeight + 2)}px`;
}

function lastPair(s: SheetSession) {
  const p = s.prefs.pairs[0];
  return { odd: argbToHex(p?.odd) ?? '#eff5ed', even: argbToHex(p?.even) ?? '#ffffff' };
}

function Drop({ label, open, onOpen, children, disabled }: { label: string; open: boolean; onOpen: () => void; children: any; disabled?: boolean }) {
  return (
    <div class="sh-pop-anchor">
      <button class={`sh-tbtn sh-drop${open ? ' on' : ''}`} disabled={disabled} aria-haspopup="menu" onMouseDown={(e) => e.preventDefault()} onClick={onOpen}>
        {label} <I.IcChevronDown size={10} />
      </button>
      {open && <div class="fb-pop fb-menu sh-menu" role="menu">{children}</div>}
    </div>
  );
}

function MenuBtn({ onClick, children, disabled }: { onClick: () => void; children: any; disabled?: boolean }) {
  return (
    <button class="fb-menu-item" role="menuitem" disabled={disabled} onClick={onClick}>
      <span>{children}</span>
    </button>
  );
}

function ColourButton({ kind, open, disabled, onOpen, onPick }: { kind: 'font' | 'fill'; open: boolean; disabled?: boolean; onOpen: () => void; onPick: (hex: string | null) => void }) {
  return (
    <div class="fb-pop-anchor sh-pop-anchor">
      <button class={`fb-btn${open ? ' on' : ''}`} disabled={disabled} title={kind === 'font' ? 'Text colour' : 'Fill colour'} onMouseDown={(e) => e.preventDefault()} onClick={onOpen}>
        {kind === 'font' ? <I.IcColor /> : <IcFill />}
      </button>
      {open && (
        <div class="fb-pop fb-colors" onMouseDown={(e) => e.preventDefault()}>
          {SWATCHES.map((c) => <button class="fb-swatch" style={{ background: c }} title={c} onClick={() => onPick(c)} />)}
          <button class="fb-swatch fb-nocolor" title={kind === 'font' ? 'Automatic' : 'No fill'} onClick={() => onPick(null)}>✕</button>
          <label class="fb-custom" title="Custom colour">
            Custom…
            <input type="color" onChange={(e) => onPick((e.target as HTMLInputElement).value)} />
          </label>
        </div>
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: any }) {
  return (
    <div class="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal sh-modal" role="dialog" aria-label={title} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div class="modal-title">{title}</div>
        <div class="sh-modal-body">{children}</div>
      </div>
    </div>
  );
}

const S = (d: JSX.Element) => (
  <svg class="ic" width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {d}
  </svg>
);
const IcVTop = () => S(<path d="M3 2.5h10M8 13.5V5M5.5 7.5 8 5l2.5 2.5" />);
const IcVMid = () => S(<path d="M3 8h10M8 2v3.5M8 14v-3.5M6 4l2 1.5L10 4M6 12l2-1.5 2 1.5" />);
const IcVBot = () => S(<path d="M3 13.5h10M8 2.5V11M5.5 8.5 8 11l2.5-2.5" />);
const IcClearFmt = () => S(<path d="M4 3h8M8 3l-2.5 10M2.5 13.5l11-11" />);
const IcUndo = () => S(<path d="M5.5 4 2.5 7l3 3M2.5 7h7a3.5 3.5 0 0 1 0 7H8" />);
const IcRedo = () => S(<path d="M10.5 4l3 3-3 3M13.5 7h-7a3.5 3.5 0 0 0 0 7H8" />);
const IcFill = () => S(<><path d="M3 9l5-5 4 4-5 5z" /><path d="M13.5 10.5s-1.2 1.5-1.2 2.3a1.2 1.2 0 0 0 2.4 0c0-.8-1.2-2.3-1.2-2.3z" fill="currentColor" /><path d="M2 14.5h8" stroke="var(--fb-fill, #f9ab00)" stroke-width="2" /></>);
const IcBands = () => S(<><rect x="2" y="3" width="12" height="10" rx="1" /><path d="M2 6.3h12M2 9.6h12" /><path d="M2.5 6.8h11v2.3h-11z" fill="currentColor" opacity=".35" stroke="none" /></>);
