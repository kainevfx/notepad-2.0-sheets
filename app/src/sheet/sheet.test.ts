import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {
  newSheet, setValue, displayText, parseInput, insertRows, deleteRows, insertCols, deleteCols, moveRows, moveCols, moveOrder,
  sortRows, detectHeader, toggleFreezeRows, freezeCols, excelFreeze, commit, undoH, redoH, patchStyle, pasteBlock, type SheetState,
} from './model';
import { loadXlsx, saveXlsx, normalizePart, parseRef } from './xlsx-io';
import { shownColours, adaptFill, luminance } from './colors';
import { parseFilter, rowMatches, suggestions } from './filter';

function grid(rows: (string | number | null)[][]): SheetState {
  const s = newSheet('S', 0, 0);
  s.rows = rows.map((r) => r.map((v) => (v == null ? null : { v })));
  return s;
}
const col = (s: SheetState, c: number) => s.rows.map((r) => displayText(r[c]?.v ?? null));

describe('values', () => {
  it('typed text becomes numbers, formulas or text', () => {
    expect(parseInput('12')).toBe(12);
    expect(parseInput('-3.5')).toBe(-3.5);
    expect(parseInput('007')).toBe('007');
    expect(parseInput('=SUM(A1:A3)')).toEqual({ formula: 'SUM(A1:A3)' });
    expect(parseInput('')).toBe(null);
    expect(displayText({ formula: 'X', result: 968 })).toBe('968');
  });
});

describe('rows and columns', () => {
  const base = () => grid([['h1', 'h2'], ['a', 1], ['b', 2], ['c', 3]]);
  it('insert and delete rows shift merges, freeze and the header', () => {
    let s: SheetState = { ...base(), header: 0, merges: [{ r1: 2, c1: 0, r2: 2, c2: 1 }], freeze: { rows: [0, 3], left: [], right: [] } };
    s = insertRows(s, 1, 2);
    expect(col(s, 0)).toEqual(['h1', '', '', 'a', 'b', 'c']);
    expect(s.merges[0].r1).toBe(4);
    expect(s.freeze.rows).toEqual([0, 5]);
    s = deleteRows(s, 1, 2);
    expect(col(s, 0)).toEqual(['h1', 'a', 'b', 'c']);
    expect(s.merges[0].r1).toBe(2);
  });
  it('insert and delete columns', () => {
    let s = insertCols(base(), 1);
    expect(s.rows[1].map((c) => displayText(c?.v ?? null))).toEqual(['a', '', '1']);
    s = deleteCols(s, 0, 0);
    expect(s.rows[1].map((c) => displayText(c?.v ?? null))).toEqual(['', '1']);
  });
  it('move rows and columns by dragging', () => {
    expect(moveOrder(5, 1, 2, 5)).toEqual([0, 3, 4, 1, 2]);
    expect(moveOrder(5, 3, 3, 0)).toEqual([3, 0, 1, 2, 4]);
    const s = moveRows(base(), 3, 3, 1);
    expect(col(s, 0)).toEqual(['h1', 'c', 'a', 'b']);
    const t = moveCols(base(), 1, 1, 0);
    expect(t.rows[0].map((c) => displayText(c?.v ?? null))).toEqual(['h2', 'h1']);
  });
});

describe('sort', () => {
  it('reorders rows below the header; numbers as numbers; blanks last', () => {
    const s = { ...grid([['Title', null], ['Name', 'N'], ['b', 10], ['a', 9], ['c', null], ['d', 100]]), header: 1 };
    const up = sortRows(s, [{ col: 1, desc: false }]);
    expect(col(up, 0)).toEqual(['Title', 'Name', 'a', 'b', 'd', 'c']);
    const down = sortRows(s, [{ col: 1, desc: true }]);
    expect(col(down, 0)).toEqual(['Title', 'Name', 'd', 'b', 'a', 'c']);
  });
  it('multi-level, stable', () => {
    const s = { ...grid([['P', 'N'], [2, 'b'], [1, 'z'], [2, 'a'], [1, 'y']]), header: 0 };
    const r = sortRows(s, [{ col: 0, desc: false }, { col: 1, desc: false }]);
    expect(col(r, 1)).toEqual(['N', 'y', 'z', 'a', 'b']);
  });
  it('finds the header row under a title block', () => {
    const s = grid([['BIG TITLE'], ['a note'], [null], ['Order', 'Phase', 'File'], [1, 1, 'x'], [2, 1, 'y']]);
    expect(detectHeader(s)).toBe(3);
  });
});

describe('freeze', () => {
  it('any rows, columns left or right; Excel keeps the top-left part', () => {
    let s = grid([['a']]);
    s = toggleFreezeRows(s, [0, 1, 5], true);
    s = freezeCols(s, [0], 'left');
    s = freezeCols(s, [4], 'right');
    expect(s.freeze).toEqual({ rows: [0, 1, 5], left: [0], right: [4] });
    expect(excelFreeze(s.freeze)).toEqual({ ySplit: 2, xSplit: 1 });
    s = freezeCols(s, [4], null);
    expect(s.freeze.right).toEqual([]);
  });
});

describe('undo', () => {
  it('keeps earlier states', () => {
    let h = { past: [] as number[], present: 1, future: [] as number[] };
    h = commit(h, 2);
    h = commit(h, 3);
    h = undoH(h);
    expect(h.present).toBe(2);
    h = redoH(h);
    expect(h.present).toBe(3);
  });
  it('an edit copies only the row it changes', () => {
    const s = grid([['a'], ['b']]);
    const t = setValue(s, 1, 0, 'x');
    expect(t.rows[0]).toBe(s.rows[0]);
    expect(t.rows[1]).not.toBe(s.rows[1]);
  });
});

describe('xlsx', () => {
  async function sample(): Promise<Uint8Array> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Production');
    ws.getCell('A1').value = 'TITLE';
    ws.mergeCells('A1:C1');
    ws.addRow([]);
    ws.getRow(3).values = ['Order', 'Phase', 'Status'];
    ws.getRow(4).values = [1, 4, 'Planned'];
    ws.getRow(5).values = [2, 7, 'Complete'];
    ws.getCell('A3').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF254C3C' } };
    ws.getCell('A3').font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial', size: 10 };
    ws.getColumn(3).width = 30;
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 3 }];
    ws.getCell('C4').dataValidation = { type: 'list', allowBlank: true, formulae: ['"Planned,Complete"'] };
    ws.addConditionalFormatting({ ref: 'C4:C5', rules: [{ type: 'containsText', operator: 'containsText', text: 'Complete', priority: 1, style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFE2EEDB' } } } } as any] });
    return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  }

  it('reads values, styles, merges, freeze, dropdowns and the header row', async () => {
    const book = await loadXlsx(await sample());
    const s = book.sheets[0];
    expect(displayText(s.rows[0][0]!.v)).toBe('TITLE');
    expect(s.merges).toEqual([{ r1: 0, c1: 0, r2: 0, c2: 2 }]);
    expect(s.freeze.rows).toEqual([0, 1, 2]);
    expect(s.freeze.left).toEqual([0]);
    expect(s.header).toBe(2);
    expect(s.lists['3,2']).toEqual(['Planned', 'Complete']);
    expect(s.textRules[0].text).toBe('Complete');
    expect(s.rows[2][0]!.xs?.fill?.fgColor?.argb).toBe('FF254C3C');
    expect(s.widths[2]).toBe(30);
  });

  it('saves edits, sorting, freeze and alternating colours, and reads them back', async () => {
    const book = await loadXlsx(await sample());
    let s = book.sheets[0];
    s = setValue(s, 3, 2, 'Blocked');
    s = sortRows(s, [{ col: 1, desc: true }]);
    s = patchStyle(s, [{ r1: 3, c1: 0, r2: 3, c2: 0 }], (xs) => ({ ...xs, font: { ...(xs.font ?? {}), italic: true } }));
    s = toggleFreezeRows(s, [3], true);
    s = { ...s, bands: [{ ref: { r1: 3, c1: 0, r2: 4, c2: 2 }, odd: 'FFEEEEEE', even: 'FFFFFFFF' }] };
    const bytes = await saveXlsx(book, [s]);
    const back = (await loadXlsx(bytes)).sheets[0];
    expect(back.rows[3].map((c) => displayText(c?.v ?? null))).toEqual(['2', '7', 'Complete']);
    expect(back.rows[4][2]!.v).toBe('Blocked');
    expect(back.rows[3][0]!.xs?.font?.italic).toBe(true);
    expect(back.freeze.rows).toEqual([0, 1, 2, 3]);
    expect(back.bands).toEqual([{ ref: { r1: 3, c1: 0, r2: 4, c2: 2 }, odd: 'FFEEEEEE', even: 'FFFFFFFF' }]);
    expect(back.textRules[0].text).toBe('Complete');
    expect(back.merges.length).toBe(1);
  });

  it('opens files with prefixed tags and absolute part paths (Open XML SDK style)', async () => {
    const zip = await JSZip.loadAsync(await sample());
    const wbXml = await zip.file('xl/workbook.xml')!.async('string');
    const prefixed = wbXml.replace(/<(\/?)([a-zA-Z])/g, '<$1x:$2').replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"');
    expect(normalizePart('xl/workbook.xml', prefixed)).toContain('<workbook');
    const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/xl/tables/table1.xml" Id="r1"/></Relationships>';
    expect(normalizePart('xl/worksheets/_rels/sheet1.xml.rels', rels)).toContain('Target="../tables/table1.xml"');
    expect(normalizePart('_rels/.rels', rels.replace('/xl/tables/table1.xml', '/xl/workbook.xml'))).toContain('Target="xl/workbook.xml"');
    expect(parseRef('A1:B2 D4')).toEqual([{ r1: 0, c1: 0, r2: 1, c2: 1 }, { r1: 3, c1: 3, r2: 3, c2: 3 }]);
  });
});

describe('colours in the dark theme', () => {
  it('pale fills turn deep, dark fills turn lighter, text stays readable', () => {
    expect(luminance(adaptFill('#f4f8ef'))).toBeLessThan(0.05);
    expect(luminance(adaptFill('#254c3c'))).toBeGreaterThan(luminance('#254c3c'));
    const head = shownColours('#254c3c', '#ffffff', 'adapted', true, new Set());
    expect(luminance(head.fg!)).toBeLessThan(0.25);
    expect(shownColours('#f4f8ef', null, 'original', true, new Set()).bg).toBe('#f4f8ef');
    expect(shownColours('#f4f8ef', null, 'none', true, new Set()).bg).toBe(null);
    expect(shownColours('#ff0000', null, 'adapted', true, new Set(['#ff0000'])).bg).toBe('#ff0000');
    expect(shownColours('#f4f8ef', null, 'adapted', false, new Set()).bg).toBe('#f4f8ef');
  });
});

describe('filter', () => {
  const s = { ...grid([['Phase', 'Character'], [4, 'Squid'], [7, 'Witch'], [4, 'Clown']]), header: 0 };
  it('free text and "Heading: value", combined', () => {
    const f1 = parseFilter(s, 'Phase: 4')!;
    expect(f1.col).toBe(0);
    expect([1, 2, 3].filter((r) => rowMatches(s, r, [f1]))).toEqual([1, 3]);
    const f2 = parseFilter(s, 'squid')!;
    expect([1, 2, 3].filter((r) => rowMatches(s, r, [f1, f2]))).toEqual([1]);
  });
  it('suggests headings and values', () => {
    expect(suggestions(s, 'pha')).toContain('Phase: ');
    expect(suggestions(s, 'Character: wi')).toEqual(['Character: Witch']);
  });
  it('paste fills a block', () => {
    const t = pasteBlock(grid([[]]), 1, 1, [['1', 'x'], ['2', 'y']]);
    expect(t.rows[2][2]!.v).toBe('y');
    expect(t.rows[1][1]!.v).toBe(1);
  });
});
