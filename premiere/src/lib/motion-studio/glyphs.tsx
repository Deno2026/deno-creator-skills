import React from 'react';
import {measureText} from '@remotion/layout-utils';
import type {Fonts} from './index';

// Glyph coverage of the Studio faces, read from the installed files' cmap (2026-09-18):
//   Clother Black (display)  — has ± ≥ ₩ ~ · — “ ; MISSING → ✓ ✗
//   Parabolica Black (heavy) — has → ✓ ✗ ± ≥ ₩ ~ ; MISSING ≈
//   Parabolica Text Bold     — same as heavy
//   Space Grotesk (mono)     — has → ≈ ± ≥ ~ · ; MISSING ✓ ✗
// A missing glyph is silently drawn by a system font, which this repo treats as a failure (motion-typography.md).
// Display copy therefore routes just those characters to the heavy face (Parabolica Black 900): it has them and
// carries the same weight as Clother Black 900, so the swapped character does not read lighter than its sentence.
// Heavy/text copy must not use ≈ at all — write ~ instead.

const DISPLAY_MISSING = new Set(['→', '✓', '✗']);
type Run = {glyph: boolean; s: string};
const glyphRuns = (text: string): Run[] => Array.from(text).reduce<Run[]>((acc, ch) => {
  const glyph = DISPLAY_MISSING.has(ch);
  const last = acc[acc.length - 1];
  if (last && last.glyph === glyph) last.s += ch; else acc.push({glyph, s: ch});
  return acc;
}, []);

/** Display-face copy with the characters Clother Black lacks rendered in the heavy face. */
export function displayGlyphs(text: string, fonts: Fonts): React.ReactNode {
  const runs = glyphRuns(text);
  if (runs.length === 1 && !runs[0].glyph) return text;
  return runs.map((r, i) => r.glyph
    ? <span key={i} style={{fontFamily: fonts.heavy.family, fontWeight: fonts.heavy.weight}}>{r.s}</span>
    : <React.Fragment key={i}>{r.s}</React.Fragment>);
}

/** Measured width of displayGlyphs() output, each run measured in the face it is drawn with. */
export function displayW(text: string, fonts: Fonts, size: number, letterSpacing = `${size > 80 ? -0.035 : -0.01}em`, wordSpacingEm = size > 80 ? 0.14 : 0.05) {
  return glyphRuns(text).reduce((w, r) => w + measureText({
    text: r.s,
    fontFamily: r.glyph ? fonts.heavy.family : fonts.display.family,
    fontWeight: r.glyph ? fonts.heavy.weight : fonts.display.weight,
    fontSize: size, letterSpacing,
  }).width, 0) + (text.split(' ').length - 1) * size * wordSpacingEm;
}

/** Throws if heavy/text copy contains ≈ (none of the Parabolica faces has it). */
export function assertNoApprox(text: string) {
  if (text.includes('≈')) throw new Error(`"${text}": Parabolica has no ≈ — write ~ instead (glyphs.tsx).`);
}
