// The sheet's filter box: free text matches any column; "Heading: value" matches one column.
// Filters combine (every one must match). Suggestions are column headings and values found
// in the sheet, offered in a small list as you type.
import { displayText, dataRows, type SheetState } from './model';

export interface Filter {
  col: number | null;
  text: string;
}

export function headings(s: SheetState): { col: number; name: string }[] {
  if (s.header < 0) return [];
  return (s.rows[s.header] ?? []).map((c, i) => ({ col: i, name: c ? displayText(c.v).trim() : '' })).filter((h) => h.name);
}

/** "Phase: 4" → {col of Phase, "4"}; anything else → free text. */
export function parseFilter(s: SheetState, input: string): Filter | null {
  const t = input.trim();
  if (!t) return null;
  const m = /^([^:]+):\s*(.*)$/.exec(t);
  if (m) {
    const name = m[1].trim().toLowerCase();
    const h = headings(s).find((x) => x.name.toLowerCase() === name);
    if (h) return { col: h.col, text: m[2] };
  }
  return { col: null, text: t };
}

export function rowMatches(s: SheetState, r: number, filters: Filter[]): boolean {
  if (!filters.length || r <= s.header) return true;
  const row = s.rows[r] ?? [];
  return filters.every((f) => {
    const q = f.text.toLowerCase();
    if (!q) return true;
    if (f.col != null) return displayText(row[f.col]?.v ?? null).toLowerCase().includes(q);
    return row.some((c) => c && displayText(c.v).toLowerCase().includes(q));
  });
}

/** Up to `max` suggestions for what's typed so far. */
export function suggestions(s: SheetState, input: string, max = 8): string[] {
  const t = input.trim().toLowerCase();
  if (!t) return [];
  const hs = headings(s);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (x: string) => {
    if (out.length < max && !seen.has(x.toLowerCase())) {
      seen.add(x.toLowerCase());
      out.push(x);
    }
  };
  const { from, to } = dataRows(s);
  const m = /^([^:]+):\s*(.*)$/.exec(input.trim());
  if (m) {
    const h = hs.find((x) => x.name.toLowerCase() === m[1].trim().toLowerCase());
    if (!h) return [];
    const q = m[2].toLowerCase();
    for (let r = from; r <= to && out.length < max; r++) {
      const v = displayText(s.rows[r]?.[h.col]?.v ?? null).trim();
      if (v && v.length <= 80 && v.toLowerCase().includes(q)) add(`${h.name}: ${v}`);
    }
    return out;
  }
  for (const h of hs) if (h.name.toLowerCase().includes(t)) add(`${h.name}: `);
  for (let r = from; r <= to && out.length < max; r++) {
    const row = s.rows[r] ?? [];
    for (const h of hs) {
      const v = displayText(row[h.col]?.v ?? null).trim();
      if (v && v.length <= 80 && v.toLowerCase().includes(t)) add(`${h.name}: ${v}`);
      if (out.length >= max) break;
    }
  }
  return out;
}

export function filterLabel(s: SheetState, f: Filter): string {
  if (f.col == null) return f.text;
  const h = headings(s).find((x) => x.col === f.col);
  return `${h?.name ?? `Column ${f.col + 1}`}: ${f.text}`;
}
