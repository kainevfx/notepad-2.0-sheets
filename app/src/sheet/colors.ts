// Cell colours on screen. The file keeps its real colours; in the dark theme they're shown
// "adapted": same hue, lightness flipped (pale green rows → deep green, dark green headings →
// lighter green), with the text colour kept readable against the new background. Colours you
// pick in the app are shown exactly as picked.

export type ColourMode = 'adapted' | 'original' | 'none';

/** "FF254C3C" / "254C3C" → "#254c3c" (alpha ignored). */
export function argbToHex(argb?: string): string | null {
  if (!argb) return null;
  const s = argb.replace(/^#/, '');
  const rgb = s.length === 8 ? s.slice(2) : s.length === 6 ? s : null;
  return rgb && /^[0-9a-f]{6}$/i.test(rgb) ? `#${rgb.toLowerCase()}` : null;
}

export function hexToArgb(hex: string): string {
  return `FF${hex.replace(/^#/, '').toUpperCase()}`;
}

function toHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function toHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

/** A file fill colour for the dark theme: hue kept, lightness flipped into a dark-friendly band. */
export function adaptFill(hex: string): string {
  const [h, s, l] = toHsl(hex);
  // Very light fills (most "white-ish" bodies) become a deep tint; dark fills become a mid tone.
  const nl = Math.min(0.62, Math.max(0.1, 1 - l));
  const scaled = l > 0.85 ? 0.1 + (1 - l) * 0.9 : nl; // near-white → nearly the page colour
  return toHex(h, Math.min(1, s * (l > 0.85 ? 0.55 : 0.75)), scaled);
}

/** A text colour readable on `bg` (adapted from the file's own text colour when it has one). */
export function readableText(bg: string, own?: string | null): string {
  const dark = luminance(bg) < 0.3;
  if (own) {
    const [h, s, l] = toHsl(own);
    const flipped = toHex(h, s, 1 - l);
    const target = dark ? luminance(flipped) > 0.35 : luminance(flipped) < 0.25;
    if (target) return flipped;
    return toHex(h, Math.min(s, 0.5), dark ? 0.85 : 0.18);
  }
  return dark ? '#e8e8e8' : '#1b1b1b';
}

export interface ShownColours {
  bg: string | null;
  fg: string | null;
}

/**
 * What a cell shows. `fill`/`text` are the file's colours (hex or null), `picked` the colours you
 * chose in the app (shown as they are), `dark` the app theme.
 */
export function shownColours(fill: string | null, text: string | null, mode: ColourMode, dark: boolean, picked: Set<string>): ShownColours {
  if (mode === 'none') return { bg: null, fg: null };
  if (mode === 'original' || !dark) return { bg: fill, fg: text };
  const keepFill = !fill || picked.has(fill);
  const bg = !fill ? null : keepFill ? fill : adaptFill(fill);
  if (text && picked.has(text)) return { bg, fg: text };
  if (bg) return { bg, fg: readableText(bg, text) };
  // No fill: the page is dark, so a dark file text colour needs lifting.
  if (text && luminance(text) < 0.2) return { bg: null, fg: readableText('#272727', text) };
  return { bg: null, fg: text };
}
