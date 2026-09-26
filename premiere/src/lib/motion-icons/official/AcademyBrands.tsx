import React, {type CSSProperties} from 'react';
import {HIGGSFIELD_BRAND, HIGGSFIELD_GLYPH_PATH, HIGGSFIELD_GLYPH_VIEWBOX, LTX_PATHS, LTX_VIEWBOX, SEED_SYMBOL_PATHS} from './academy-brand-paths';

// Official marks for scenes that name Higgsfield, Seedance (ByteDance Seed) or LTX — verbatim path data, see
// academy-brand-paths.ts for sources and hashes. Colours follow each site: Higgsfield's header tile (white tile, #1a1a1a
// glyph), Seed and LTX draw their marks in the page text colour (white on their dark headers). No recolouring into the
// Studio palette: these marks stand for the products themselves (channel-motion-profile.md → 아이콘·마크 소스).
export {HIGGSFIELD_BRAND};

/** Higgsfield header logo: rounded white tile with the glyph. `grow` scales it from its centre. */
export function HiggsfieldMark({size, grow = 1, style = {}}: {size: number; grow?: number; style?: CSSProperties}) {
  if (grow <= 0) return null;
  // Site CSS: 32px tile, 8px radius, 26px glyph.
  const r = size * (8 / 32), g = size * (26 / 32);
  return <div style={{position: 'relative', width: size, height: size, flex: 'none', borderRadius: r, background: HIGGSFIELD_BRAND.tile,
    transform: `scale(${grow})`, transformOrigin: '50% 50%', boxShadow: '0 10px 24px #00000055', ...style}}>
    <svg viewBox={`0 0 ${HIGGSFIELD_GLYPH_VIEWBOX} ${HIGGSFIELD_GLYPH_VIEWBOX}`} width={g} height={g}
      style={{position: 'absolute', left: (size - g) / 2, top: (size - g) / 2, display: 'block'}}>
      <path d={HIGGSFIELD_GLYPH_PATH} fill={HIGGSFIELD_BRAND.glyph} />
    </svg>
  </div>;
}

/** The bare Higgsfield glyph (no tile), e.g. the lime glyph the Academy page uses beside its title. */
export function HiggsfieldGlyph({size, color = HIGGSFIELD_BRAND.lime, style = {}}: {size: number; color?: string; style?: CSSProperties}) {
  return <svg viewBox={`0 0 ${HIGGSFIELD_GLYPH_VIEWBOX} ${HIGGSFIELD_GLYPH_VIEWBOX}`} width={size} height={size} style={{display: 'block', flex: 'none', ...style}}>
    <path d={HIGGSFIELD_GLYPH_PATH} fill={color} />
  </svg>;
}

// Bar symbol bounds inside the 220x32 header: x 0–25.31, y 4–26.09.
const SEED_BOX = {x: 0, y: 3.6, w: 25.4, h: 22.9};
/** ByteDance Seed bar symbol (the mark shown beside Seedance). `bars` 0→4 raises the bars one by one. */
export function SeedSymbol({height, color = '#FFFFFF', bars = 4, style = {}}: {height: number; color?: string; bars?: number; style?: CSSProperties}) {
  const k = height / SEED_BOX.h;
  // Path order in the file is bar 1, bar 4, bar 2, bar 3 (left to right: 0, 2, 3, 1).
  const order = [0, 2, 3, 1];
  return <svg viewBox={`${SEED_BOX.x} ${SEED_BOX.y} ${SEED_BOX.w} ${SEED_BOX.h}`} width={SEED_BOX.w * k} height={height} style={{display: 'block', flex: 'none', overflow: 'visible', ...style}}>
    {SEED_SYMBOL_PATHS.map((d, i) => {
      const p = Math.max(0, Math.min(1, bars - order.indexOf(i)));
      if (p <= 0) return null;
      return <path key={i} d={d} fill={color} style={{transform: `scaleY(${p})`, transformOrigin: '50% 100%', transformBox: 'fill-box'}} opacity={p} />;
    })}
  </svg>;
}
export const seedSymbolWidth = (height: number) => (height * SEED_BOX.w) / SEED_BOX.h;

/** LTX logo (ltx.io navbar). `wipe` 0→1 reveals it from the left. */
export function LtxLogo({height, color = '#FFFFFF', wipe = 1, style = {}}: {height: number; color?: string; wipe?: number; style?: CSSProperties}) {
  if (wipe <= 0) return null;
  const k = height / LTX_VIEWBOX.h;
  return <svg viewBox={`0 0 ${LTX_VIEWBOX.w} ${LTX_VIEWBOX.h}`} width={LTX_VIEWBOX.w * k} height={height}
    style={{display: 'block', flex: 'none', clipPath: `inset(0 ${(1 - Math.min(1, wipe)) * 100}% 0 0)`, ...style}}>
    {LTX_PATHS.map((d, i) => <path key={i} d={d} fill={color} />)}
  </svg>;
}
export const ltxLogoWidth = (height: number) => (height * LTX_VIEWBOX.w) / LTX_VIEWBOX.h;
