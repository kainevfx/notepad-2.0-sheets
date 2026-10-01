// CSV / TSV (RFC 4180): quoted fields with doubled quotes, delimiters and line breaks inside
// quotes, CRLF or LF rows. Used by the table viewer and by Save sheet as CSV.

export const MAX_GRID_CELLS = 200_000;

export function parseCsv(text: string, delim: string, maxCells = MAX_GRID_CELLS): { rows: string[][]; truncated: boolean } {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let cells = 0;
  let truncated = false;
  const endRow = () => {
    row.push(field);
    field = '';
    if (cells + row.length > maxCells) {
      truncated = true;
      return false;
    }
    cells += row.length;
    rows.push(row);
    row = [];
    return true;
  };
  let i = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      if (!endRow()) break;
    } else field += c;
  }
  if (!truncated && (field !== '' || row.length)) endRow();
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  for (const r of rows) while (r.length < width) r.push('');
  return { rows, truncated };
}

/**
 * Delimiters counted outside quotes, per record, for the first `max` records. The quote state
 * carries across line breaks, so a quoted cell with a line break stays one record.
 */
function countsPerRecord(text: string, d: string, max = 20): number[] {
  const out: number[] = [];
  let n = 0;
  let q = false;
  let blank = true;
  for (let i = 0; i < text.length && out.length < max; i++) {
    const c = text[i];
    if (c === '"') q = !q;
    if (!q && (c === '\n' || c === '\r')) {
      if (!blank) out.push(n);
      n = 0;
      blank = true;
      continue;
    }
    if (c.trim()) blank = false;
    if (!q && c === d) n++;
  }
  if (!blank && out.length < max) out.push(n);
  return out;
}

export function detectDelimiter(text: string, path: string | null): ',' | ';' | '\t' {
  if (path && /\.tsv$/i.test(path)) return '\t';
  let best: { d: ',' | ';' | '\t'; min: number; spread: number } = { d: ',', min: 0, spread: Infinity };
  for (const d of [',', ';', '\t'] as const) {
    const c = countsPerRecord(text, d);
    if (!c.length) continue;
    const min = Math.min(...c);
    const spread = Math.max(...c) - min;
    if (min > best.min || (min === best.min && min > 0 && spread < best.spread)) best = { d, min, spread };
  }
  return best.min > 0 ? best.d : ',';
}

export function toCsv(rows: string[][]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Rows back to text with the file's own delimiter (comma, semicolon or tab). */
export function toDelimited(rows: string[][], delim: string): string {
  const q = new RegExp(`["\\r\\n${delim === '\t' ? '\\t' : delim}]`);
  const cell = (v: string) => (q.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(cell).join(delim)).join('\r\n') + (rows.length ? '\r\n' : '');
}
