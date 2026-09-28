import React from 'react';
import {Easing, interpolate} from 'remotion';
import {C, abs, type Fonts} from './index';
import {PanelGrain, NOTE} from './NotePanel';

// "Type exactly this" card (added 2026-09-28; when to use it: the channel motion profile, type cue row). For the moment the
// narration tells the viewer to type a word — a search term, a setting name, a command. The literal text is shown big,
// exactly as it must be typed (case kept); it types in letter by letter from the spoken word (pace it to the on-screen typing
// when there is one) and a caret blinks while it holds. A small label says what to do.
// It sits in a quiet part of the screen near the input — never over the input box itself or the caption band.
// Variants (the job is only that the word reads at once on any screen). Default `field`, chosen 2026-09-28 on the real
// program frames over the others: the plum-tinted panel did not separate from dark app screens, the yellow key blended into
// yellow-heavy pages, the plate-less word fought busy pictures.
//   panel — dark matte paper panel, accent word (first version; plum-tinted plate)
//   key   — Acid Yellow key, ink word (the signal-button material)
//   field — bone-white search field, ink word and caret, service mark or magnifier
//   float — no plate: accent word with a dark outline over a local dark halo
//   plate — near-black plate with an accent edge, accent word

export type TypeCueVariant = 'panel' | 'key' | 'field' | 'float' | 'plate';

export type TypeCueProps = {
  id: string; // unique in the frame (grain filter ids)
  frame: number; // frame inside the composition
  word: string; // the literal text to type
  label?: string; // what to do, short English: 'TYPE', 'SEARCH', …
  mark?: (color: string, size: number) => React.ReactNode; // optional small mark (e.g. a service logo), drawn in the given colour
  cx: number; // horizontal centre of the card (px, 1920×1080)
  top: number; // top edge of the card
  onset: number; // first letter appears here (the spoken word's onset)
  exit: number; // the card is gone by this frame
  charFrames?: number; // frames per letter
  size?: number; // font size of the word
  variant?: TypeCueVariant;
  fonts: Fonts;
};

const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);
const EASE_IN = Easing.bezier(0.7, 0, 0.84, 0);
const IN_FRAMES = 9;
const OUT_FRAMES = 9;
const BLINK_ON = 16;
const BLINK_OFF = 12;
const INK = '#131216';

function SearchGlyph({size, color}: {size: number; color: string}) {
  const s = size, r = s * 0.32, w = Math.max(3, s * 0.11);
  return <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} style={{display: 'block', flex: 'none'}}>
    <circle cx={s * 0.42} cy={s * 0.42} r={r} fill="none" stroke={color} strokeWidth={w} />
    <line x1={s * 0.66} y1={s * 0.66} x2={s * 0.92} y2={s * 0.92} stroke={color} strokeWidth={w} strokeLinecap="round" />
  </svg>;
}

export function TypeCue({id, frame, word, label = 'TYPE', mark, cx, top, onset, exit, charFrames = 2, size, variant = 'field', fonts}: TypeCueProps) {
  const pin = interpolate(frame, [onset - IN_FRAMES, onset], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE_OUT});
  const pout = interpolate(frame, [exit - OUT_FRAMES, exit], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE_IN});
  const p = pin * (1 - pout);
  if (p <= 0) return null;
  const typed = Math.max(0, Math.min(word.length, Math.floor((frame - onset) / charFrames) + 1));
  const done = typed >= word.length;
  const doneAt = onset + (word.length - 1) * charFrames;
  const caretOn = !done || (frame - doneAt) % (BLINK_ON + BLINK_OFF) < BLINK_ON;
  const fs = size ?? (variant === 'panel' ? 104 : variant === 'float' ? 132 : 116);
  const face = variant === 'panel' ? fonts.mono : fonts.heavy;
  const wordColor = variant === 'key' || variant === 'field' ? INK : C.accent;
  const caretColor = variant === 'key' || variant === 'field' ? INK : C.cream;
  const wrap: React.CSSProperties = {...abs, left: cx, top: top + (1 - pin) * 14, transform: 'translateX(-50%)', opacity: p};

  // The whole word is laid out from the start (untyped letters transparent), so the card never grows while it types.
  const Word = ({color = wordColor, stroke}: {color?: string; stroke?: number}) => (
    <div style={{position: 'relative', fontFamily: face.family, fontWeight: face.weight, fontSize: fs, lineHeight: 1.06, letterSpacing: '-0.01em', color,
      whiteSpace: 'nowrap', ...(stroke ? {WebkitTextStroke: `${stroke}px ${C.black}`} : {})}}>
      <span>{word.slice(0, typed)}</span>
      <span style={{display: 'inline-block', width: Math.round(fs * 0.075), height: Math.round(fs * 0.84), marginLeft: Math.round(fs * 0.05), verticalAlign: '-0.1em',
        background: stroke ? 'transparent' : caretColor, opacity: caretOn ? 0.92 : 0, borderRadius: 2}} />
      <span style={{color: 'transparent', WebkitTextStroke: '0px transparent'}}>{word.slice(typed)}</span>
    </div>
  );
  const labelSize = Math.round(fs * 0.19);
  const LabelChip = ({dark = true}: {dark?: boolean}) => (
    <div style={{display: 'inline-flex', alignItems: 'center', gap: Math.round(labelSize * 0.55), alignSelf: 'flex-start', padding: `${Math.round(labelSize * 0.42)}px ${Math.round(labelSize * 0.7)}px`,
      borderRadius: Math.round(labelSize * 0.45), background: dark ? INK : C.accent, boxShadow: '0 6px 16px rgba(0,0,0,0.35)'}}>
      {mark ? mark(dark ? C.cream : INK, Math.round(labelSize * 1.15)) : null}
      <span style={{fontFamily: fonts.text.family, fontWeight: fonts.text.weight, fontSize: labelSize, lineHeight: 1, letterSpacing: '0.22em', color: dark ? C.cream : INK}}>{label}</span>
    </div>
  );

  if (variant === 'key') {
    return <div style={wrap}>
      <div style={{display: 'inline-flex', flexDirection: 'column', gap: Math.round(fs * 0.12)}}>
        <LabelChip />
        <div style={{position: 'relative', display: 'inline-flex', padding: `${Math.round(fs * 0.12)}px ${Math.round(fs * 0.34)}px ${Math.round(fs * 0.14)}px`, borderRadius: Math.round(fs * 0.16),
          background: 'linear-gradient(180deg, #F4FF6E 0%, #EEFB3F 100%)', boxShadow: '0 6px 0 #BCC52F, 0 24px 48px rgba(0,0,0,0.5)'}}>
          <Word />
        </div>
      </div>
    </div>;
  }
  if (variant === 'field') {
    return <div style={wrap}>
      <div style={{display: 'inline-flex', flexDirection: 'column', gap: Math.round(fs * 0.12)}}>
        <LabelChip />
        <div style={{position: 'relative', display: 'inline-flex', alignItems: 'center', gap: Math.round(fs * 0.24), overflow: 'hidden',
          padding: `${Math.round(fs * 0.13)}px ${Math.round(fs * 0.42)}px ${Math.round(fs * 0.15)}px ${Math.round(fs * 0.3)}px`, borderRadius: Math.round(fs * 0.2),
          background: 'linear-gradient(180deg, #F5F3EE 0%, #E8E3DA 100%)', border: '1px solid rgba(19,18,22,0.14)', boxShadow: '0 24px 52px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.25)'}}>
          <PanelGrain id={id} />
          <div style={{position: 'relative'}}>{mark ? mark(INK, Math.round(fs * 0.5)) : <SearchGlyph size={Math.round(fs * 0.5)} color={INK} />}</div>
          <Word />
        </div>
      </div>
    </div>;
  }
  if (variant === 'float') {
    return <div style={wrap}>
      <div style={{position: 'relative', display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: Math.round(fs * 0.08)}}>
        {/* local dark halo: the word reads on bright and busy screens without a plate */}
        <div style={{...abs, left: -fs * 0.9, right: -fs * 0.9, top: -fs * 0.55, bottom: -fs * 0.55,
          background: 'radial-gradient(closest-side, rgba(15,14,18,0.78) 0%, rgba(15,14,18,0.55) 55%, rgba(15,14,18,0) 100%)'}} />
        <div style={{position: 'relative'}}><LabelChip dark={false} /></div>
        <div style={{position: 'relative'}}>
          <div style={{...abs, left: 0, top: 0}}><Word color={C.black} stroke={Math.round(fs * 0.09)} /></div>
          <div style={{position: 'relative', filter: 'drop-shadow(0 8px 18px rgba(0,0,0,0.55))'}}><Word /></div>
        </div>
      </div>
    </div>;
  }
  if (variant === 'plate') {
    return <div style={wrap}>
      <div style={{position: 'relative', display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: Math.round(fs * 0.1), overflow: 'hidden',
        padding: `${Math.round(fs * 0.24)}px ${Math.round(fs * 0.4)}px ${Math.round(fs * 0.2)}px`, borderRadius: Math.round(fs * 0.16),
        background: 'linear-gradient(180deg, #19191C 0%, #0F0E12 100%)', border: `3px solid ${C.accent}`, boxShadow: '0 24px 52px rgba(0,0,0,0.6)'}}>
        <PanelGrain id={id} />
        <div style={{position: 'relative', display: 'flex', alignItems: 'center', gap: Math.round(labelSize * 0.55)}}>
          {mark ? mark(C.cream, Math.round(labelSize * 1.15)) : null}
          <span style={{fontFamily: fonts.text.family, fontWeight: fonts.text.weight, fontSize: labelSize, lineHeight: 1, letterSpacing: '0.22em', color: NOTE.muted}}>{label}</span>
        </div>
        <Word />
      </div>
    </div>;
  }
  // panel (first version)
  const padX = Math.round(fs * 0.46), padTop = Math.round(fs * 0.3), padBottom = Math.round(fs * 0.26);
  return <div style={wrap}>
    <div style={{position: 'relative', display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: Math.round(fs * 0.12),
      padding: `${padTop}px ${padX}px ${padBottom}px`, borderRadius: Math.round(fs * 0.2), overflow: 'hidden', whiteSpace: 'nowrap',
      background: 'radial-gradient(150% 120% at 25% 15%, #2A2033 0%, #211828 55%, #1A1321 100%)',
      border: '1px solid rgba(240,238,232,0.10)', boxShadow: '0 22px 44px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.35)'}}>
      <PanelGrain id={id} />
      <div style={{position: 'relative', display: 'flex', alignItems: 'center', gap: Math.round(labelSize * 0.6)}}>
        {mark ? mark(C.cream, 26) : null}
        <span style={{fontFamily: fonts.text.family, fontWeight: fonts.text.weight, fontSize: labelSize, lineHeight: 1, letterSpacing: '0.22em', color: NOTE.muted}}>{label}</span>
      </div>
      <Word />
    </div>
  </div>;
}
