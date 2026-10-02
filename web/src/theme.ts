import { createTheme, type Theme } from '@aws-amplify/ui-react';
import type { BrandConfig } from '@genome-portal/contract';

/**
 * Theme from `brand.primaryColor` (R1.7, §5.5). Amplify's `createTheme({ primaryColor })` expects the NAME of a
 * built-in palette (`'blue'`, `'teal'`, …); a hex value from config would throw. Hex values therefore become an
 * explicit `colors.primary` palette (10…100) derived from the hue, matching how the default palettes are graded.
 */
const PALETTE_NAMES = new Set([
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'neutral',
]);

const STEPS = [10, 20, 40, 60, 80, 90, 100] as const;
/** lightness per step, from the very light background tint (10) to the darkest text/border shade (100) */
const LIGHTNESS: Record<(typeof STEPS)[number], number> = {
  10: 96,
  20: 90,
  40: 70,
  60: 50,
  80: 36,
  90: 28,
  100: 18,
};

export function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let raw = m[1] as string;
  if (raw.length === 3)
    raw = raw
      .split('')
      .map((c) => c + c)
      .join('');
  const r = parseInt(raw.slice(0, 2), 16) / 255;
  const g = parseInt(raw.slice(2, 4), 16) / 255;
  const b = parseInt(raw.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }
  return { h, s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function paletteFromHex(hex: string): Record<string, string> | null {
  const hsl = hexToHsl(hex);
  if (!hsl) return null;
  const { h, s } = hsl;
  const palette: Record<string, string> = {};
  for (const step of STEPS) {
    // keep the brand colour itself at step 80 (the "primary" button shade)
    const l = step === 80 ? hsl.l : LIGHTNESS[step];
    palette[String(step)] = `hsl(${h}, ${s}%, ${l}%)`;
  }
  return palette;
}

export function buildBrandTheme(brand: BrandConfig): ReturnType<typeof createTheme> {
  const value = brand.primaryColor.trim().toLowerCase();
  const base: Theme = { name: 'genome-portal' };
  if (PALETTE_NAMES.has(value)) {
    return createTheme({ ...base, primaryColor: value });
  }
  const palette = paletteFromHex(value);
  if (!palette) {
    return createTheme(base);
  }
  return createTheme({
    ...base,
    tokens: {
      colors: {
        primary: palette,
      },
    },
  });
}
