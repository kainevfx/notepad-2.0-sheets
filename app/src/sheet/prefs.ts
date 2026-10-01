// Per-file sheet settings kept by the app (things a .xlsx / .csv can't store): frozen rows that
// aren't at the top, columns frozen to the right, the chosen header row, column widths for CSVs,
// the colours you picked (shown as picked in the dark theme) and saved alternating-colour pairs.
import { platform } from '../platform';
import type { Freeze } from './model';

export interface ColourPair {
  odd: string; // ARGB
  even: string;
}

export interface SheetPrefs {
  sheets: Record<string, { freeze?: Freeze; header?: number; widths?: (number | undefined)[] }>;
  picked: string[]; // hex colours you chose
  pairs: ColourPair[];
}

export const emptyPrefs = (): SheetPrefs => ({ sheets: {}, picked: [], pairs: [] });

/** A short, stable store key for a file path. */
export function prefsKey(path: string): string {
  let h = 2166136261;
  for (const ch of path.toLowerCase()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return `sheets/${(h >>> 0).toString(36)}.json`;
}

export async function loadPrefs(path: string | null): Promise<SheetPrefs> {
  if (!path) return emptyPrefs();
  try {
    const t = await platform.storeRead(prefsKey(path));
    return t ? { ...emptyPrefs(), ...JSON.parse(t) } : emptyPrefs();
  } catch {
    return emptyPrefs();
  }
}

export async function savePrefs(path: string | null, p: SheetPrefs) {
  if (!path) return;
  await platform.storeWrite(prefsKey(path), JSON.stringify(p)).catch(() => {});
}
