import React, {type CSSProperties} from 'react';
import {AbsoluteFill} from 'remotion';
import {useMotionFont} from '../motion-typography/use-motion-font';

// ---- DENO Studio motion kit (shared) ----
// Promoted from productions/faceless-agi-film-20260915 on 2026-09-15 (user: "종이질감은 디자인 공통으로 승격").
// Design authority: DESIGN_AUTHORITY.md (Plum Noir Studio) → channel-motion-profile.md "Studio 디자인 기준".
// Production-specific things stay in the production: fps, SAFE area (tutorial-frame bands), cue helpers, assets.

export const W = 1920, H = 1080;

// Studio palette (approved 2026-09-13; tokens match plum-noir-brand-system.md)
export const C = {black: '#0F0E12', plum: '#1B1320', cream: '#F0EEE8', paper: '#DFDAD2', ink: '#19151D', accent: '#F2FF59', muted: '#A79BAE'};

export const abs: CSSProperties = {position: 'absolute', boxSizing: 'border-box'};

export type Face = {family: string; weight: number};
export type Fonts = {display: Face; heavy: Face; text: Face; mono: Face};

// display: Clother Black 900 (주제·키워드) · heavy: Parabolica Black 900 (큰 숫자·목록) · text: Parabolica Text Bold 700 (라벨·출처) · mono: Space Grotesk Bold 700 (수치·기술 라벨)
export function useStudioFonts(): Fonts | null {
  const display = useMotionFont('clother-black', []);
  const heavy = useMotionFont('parabolica-black', []);
  const text = useMotionFont('parabolica-text-bold', []);
  const mono = useMotionFont('space-grotesk-bold', []);
  return display && heavy && text && mono ? {display, heavy, text, mono} : null;
}

/**
 * Korean face, loaded only where a scene needs Hangul (the file is ~10 MB). Pass every Korean string the scene draws:
 * they are checked against the face's verified coverage before rendering, so nothing falls back to a system font.
 */
export function useKoreanFont(lines: string[]): Face | null {
  return useMotionFont('noto-sans-kr-bold', lines);
}

// ---- Primitives ----
export function Type({children, x, y, size = 100, face, color = C.cream, opacity = 1, width, align = 'left', style = {}}: {
  children: React.ReactNode; x: number; y: number; size?: number; face: Face; color?: string; opacity?: number; width?: number; align?: 'left' | 'center' | 'right'; style?: CSSProperties;
}) {
  // Tight display tracking eats the space glyph on heavy faces (Clother Black): "EDITING WITH AGENTS" read as one word
  // at 138px (measured on premiere-pro-agent-20260917 B01, 2026-09-18). Word spacing gives the tracking back at the
  // word boundary only, so letter rhythm stays tight while words stay separate.
  return <div style={{...abs, left: x, top: y, width, fontFamily: face.family, fontWeight: face.weight, fontSize: size, lineHeight: 1.03,
    letterSpacing: size > 80 ? '-0.035em' : '-0.01em', wordSpacing: size > 80 ? '0.14em' : '0.05em',
    fontSynthesis: 'none', whiteSpace: 'pre-line', color, opacity, textAlign: align, ...style}}>{children}</div>;
}

// Transparent stage: everything composites over the Premiere picture.
export function Stage({children}: {children: React.ReactNode}) {
  return <AbsoluteFill style={{background: 'transparent', overflow: 'hidden', fontSynthesis: 'none'}}>{children}</AbsoluteFill>;
}

// Matte paper sheet (cream) for cards.
export const sheet: CSSProperties = {background: C.cream, boxShadow: '0 14px 28px #00000040'};

// ---- Full-takeover surface: dark matte paper (user's final choice 2026-09-15) ----
// Even light, no strong falloff; fibre grain (soft-light 0.20) + mid-frequency tooth (overlay 0.14) + fine static grain
// (overlay 0.09) + weak vignette. No blur, no glow, no glass. 'matte' (plaster wall) and 'flat' exist for A/B only.
// `top`/`height` bound the surface (e.g. between tutorial-frame bands); default is the full frame.
export type SurfaceVariant = 'paper' | 'matte' | 'flat';
export const SURFACE_VARIANT: SurfaceVariant = 'paper';
export function Surface({opacity, variant = SURFACE_VARIANT, top = 0, height = H, width = W}: {opacity: number; variant?: SurfaceVariant; top?: number; height?: number; width?: number}) {
  const base = variant === 'flat' ? C.plum
    : variant === 'paper'
      ? 'radial-gradient(160% 120% at 40% 30%, #251C2C 0%, #1F1725 45%, #181120 100%)'
      : 'radial-gradient(135% 100% at 26% 16%, #2F2438 0%, #221A29 30%, #1B1320 55%, #100C14 100%)';
  const cx = width / 2, cy = height / 2;
  return <div style={{...abs, left: 0, top, width, height, opacity, overflow: 'hidden'}}>
    <div style={{...abs, inset: 0, background: base}} />
    {variant === 'paper' && <>
      {/* fibres: anisotropic noise, slightly diagonal */}
      <svg style={{...abs, inset: 0, width: '100%', height: '100%', opacity: 0.20, mixBlendMode: 'soft-light'}}>
        <filter id="studio-fibre"><feTurbulence type="fractalNoise" baseFrequency="0.35 1.1" numOctaves="3" seed="21" stitchTiles="stitch" /><feColorMatrix type="saturate" values="0" /><feComponentTransfer><feFuncA type="linear" slope="1.4" /></feComponentTransfer></filter>
        <rect x="-10%" y="-10%" width="120%" height="120%" filter="url(#studio-fibre)" transform={`rotate(-6 ${cx} ${cy})`} />
      </svg>
      {/* tooth: mid-frequency bumps */}
      <svg style={{...abs, inset: 0, width: '100%', height: '100%', opacity: 0.14, mixBlendMode: 'overlay'}}>
        <filter id="studio-tooth"><feTurbulence type="fractalNoise" baseFrequency="0.08" numOctaves="4" seed="5" stitchTiles="stitch" /><feColorMatrix type="saturate" values="0" /></filter>
        <rect width="100%" height="100%" filter="url(#studio-tooth)" />
      </svg>
      {/* fine grain */}
      <svg style={{...abs, inset: 0, width: '100%', height: '100%', opacity: 0.09, mixBlendMode: 'overlay'}}>
        <filter id="studio-pgrain"><feTurbulence type="fractalNoise" baseFrequency="0.95" numOctaves="1" seed="3" stitchTiles="stitch" /><feColorMatrix type="saturate" values="0" /></filter>
        <rect width="100%" height="100%" filter="url(#studio-pgrain)" />
      </svg>
      <div style={{...abs, inset: 0, boxShadow: 'inset 0 0 160px 10px #120D17', opacity: 0.35}} />
    </>}
    {variant === 'matte' && <>
      <svg style={{...abs, inset: 0, width: '100%', height: '100%', opacity: 0.22, mixBlendMode: 'soft-light'}}>
        <filter id="studio-mottle"><feTurbulence type="fractalNoise" baseFrequency="0.004" numOctaves="3" seed="11" stitchTiles="stitch" /><feColorMatrix type="saturate" values="0" /></filter>
        <rect width="100%" height="100%" filter="url(#studio-mottle)" />
      </svg>
      <svg style={{...abs, inset: 0, width: '100%', height: '100%', opacity: 0.11, mixBlendMode: 'overlay'}}>
        <filter id="studio-grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" stitchTiles="stitch" /><feColorMatrix type="saturate" values="0" /></filter>
        <rect width="100%" height="100%" filter="url(#studio-grain)" />
      </svg>
      <div style={{...abs, inset: 0, boxShadow: 'inset 0 0 220px 40px #0B080E', opacity: 0.55}} />
    </>}
  </div>;
}

// Darkens the picture so graphics read. amount 0..1 of black; `plum` swaps in the paper Surface (full takeover).
// Defaults approved 2026-09-15: full takeover 1.0 (plum), process explanation 0.8, faint original 0.35.
export function Dim({amount, plum = false, top = 0, height = H}: {amount: number; plum?: boolean; top?: number; height?: number}) {
  if (plum) return <Surface opacity={amount} top={top} height={height} />;
  return <div style={{...abs, left: 0, top, width: W, height, background: C.black, opacity: amount}} />;
}
