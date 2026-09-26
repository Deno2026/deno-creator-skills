import React, {type CSSProperties} from 'react';
import {C, abs, type Fonts} from './index';

// ---- Screen-side note: Dark Matte Paper panel (Deno's choice 2026-09-23) ----
// Replaces the cream SideNote paper ("the white note looks dated and cramped"). Used while the user works on the recording
// (channel-motion-profile.md → 화면을 보며 조작·설명하는 구간): it sits in a quiet margin of the screen, grows as rows arrive,
// and never covers what is being worked on. Rows are two levels — a big title and a small result — so a narrow margin still
// reads. One accent: the newest row's bar (the final row may also take the accent colour on its title).
// Candidates and the choice (A matte panel over B rail and C screen push): productions/higgsfield-after-effects-20260923.

export const NOTE = {cream: C.cream, muted: '#A79BAE', note: '#C2B8C8', noteDone: '#8C8194', rule: 'rgba(240,238,232,0.12)'};

/** Dark Matte Paper grain (DESIGN_AUTHORITY): fibre soft-light 0.20 + fine grain overlay 0.09; no blur, glow or glass. */
export function PanelGrain({id}: {id: string}) {
  return <>
    <svg style={{...abs, inset: 0, width: '100%', height: '100%', opacity: 0.2, mixBlendMode: 'soft-light'}}>
      <filter id={`${id}-fibre`}><feTurbulence type="fractalNoise" baseFrequency="0.35 1.1" numOctaves={3} seed={21} stitchTiles="stitch" /><feColorMatrix type="saturate" values="0" /></filter>
      <rect width="100%" height="100%" filter={`url(#${id}-fibre)`} />
    </svg>
    <svg style={{...abs, inset: 0, width: '100%', height: '100%', opacity: 0.09, mixBlendMode: 'overlay'}}>
      <filter id={`${id}-grain`}><feTurbulence type="fractalNoise" baseFrequency="0.95" numOctaves={1} seed={3} stitchTiles="stitch" /><feColorMatrix type="saturate" values="0" /></filter>
      <rect width="100%" height="100%" filter={`url(#${id}-grain)`} />
    </svg>
  </>;
}

/** The panel. `id` must be unique in the frame (SVG filter ids). `p` fades and slides it in by `dx`/`dy`. */
export function NotePanel({id, x, y, w, h, p = 1, dx = 0, dy = 0, radius = 16, children, style = {}}: {
  id: string; x: number; y: number; w: number; h: number; p?: number; dx?: number; dy?: number; radius?: number; children?: React.ReactNode; style?: CSSProperties;
}) {
  if (p <= 0) return null;
  return <div style={{...abs, left: x + (1 - p) * dx, top: y + (1 - p) * dy, width: w, height: h, opacity: p, borderRadius: radius, overflow: 'hidden',
    background: 'radial-gradient(150% 120% at 25% 15%, #2A2033 0%, #211828 55%, #1A1321 100%)',
    border: '1px solid rgba(240,238,232,0.10)', boxShadow: '0 22px 44px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.35)', ...style}}>
    <PanelGrain id={id} />
    {children}
  </div>;
}

/** Small spaced label with a hairline under it, at the top of a panel. */
export function NoteHeader({fonts, label, x = 28, y = 30, width}: {fonts: Fonts; label: string; x?: number; y?: number; width: number}) {
  return <>
    <div style={{...abs, left: x, top: y, fontFamily: fonts.mono.family, fontWeight: fonts.mono.weight, fontSize: 16, letterSpacing: '0.16em', color: NOTE.muted, whiteSpace: 'nowrap'}}>{label}</div>
    <div style={{...abs, left: x, width: width - 2 * x, top: y + 32, height: 1, background: NOTE.rule}} />
  </>;
}

export type NoteRow = {n?: string; title: string; note?: string; q: number; state: 'plain' | 'done' | 'now' | 'final'; strike?: number};

/** Two-level rows: index · big title, small result under it. `q` is each row's arrival (0..1); one row is `now` or `final`. */
export function NoteRows({fonts, rows, x = 28, top = 88, row = 76, titleSize = 27, noteSize = 16}: {
  fonts: Fonts; rows: NoteRow[]; x?: number; top?: number; row?: number; titleSize?: number; noteSize?: number;
}) {
  return <>
    {rows.map((r, i) => {
      if (r.q <= 0) return null;
      const titleColor = r.state === 'final' ? C.accent : r.state === 'done' ? NOTE.muted : C.cream;
      return <React.Fragment key={i}>
        {(r.state === 'now' || r.state === 'final') && <div style={{...abs, left: 0, top: top + i * row - 4, width: 4, height: row - 20, background: C.accent, opacity: r.q}} />}
        <div style={{...abs, left: x, top: top + i * row + (1 - r.q) * 10, opacity: r.q}}>
          <div style={{display: 'flex', alignItems: 'baseline', gap: 14}}>
            {r.n !== undefined && <span style={{fontFamily: fonts.mono.family, fontWeight: fonts.mono.weight, fontSize: 15, color: NOTE.muted, width: 24, whiteSpace: 'nowrap'}}>{r.n}</span>}
            <span style={{fontFamily: fonts.heavy.family, fontWeight: fonts.heavy.weight, fontSize: titleSize, lineHeight: 1, color: titleColor, whiteSpace: 'nowrap', position: 'relative'}}>{r.title}
              {!!r.strike && <span style={{...abs, left: -3, top: '52%', width: `calc(${100 * r.strike}% + 6px)`, height: 3, background: NOTE.muted}} />}</span>
          </div>
          {r.note && <div style={{fontFamily: fonts.mono.family, fontWeight: fonts.mono.weight, fontSize: noteSize, letterSpacing: '0.1em', whiteSpace: 'nowrap',
            color: r.state === 'done' ? NOTE.noteDone : NOTE.note, marginLeft: r.n !== undefined ? 38 : 0, marginTop: 8}}>{r.note}</div>}
        </div>
      </React.Fragment>;
    })}
  </>;
}
