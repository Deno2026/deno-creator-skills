import React from 'react';
import {Easing, interpolate} from 'remotion';
import {C, abs, type Fonts} from './index';
import {PanelGrain, NOTE} from './NotePanel';

// "Type exactly this" card (added 2026-09-28; when to use it: the channel motion profile, type cue row). For the moment the
// narration tells the viewer to type a word — a search term, a setting name, a command. The literal text is shown big in the
// mono face, exactly as it must be typed (case kept), in the accent colour; it types in letter by letter from the spoken word
// (pace it to the on-screen typing when there is one) and a caret blinks while it holds. A small label says what to do.
// It sits in a quiet part of the screen near the input — never over the input box itself or the caption band.

export type TypeCueProps = {
  id: string; // unique in the frame (panel grain filter ids)
  frame: number; // frame inside the composition
  word: string; // the literal text to type
  label?: string; // what to do, short English: 'TYPE', 'SEARCH', …
  mark?: React.ReactNode; // optional small mark before the label (e.g. a service logo)
  cx: number; // horizontal centre of the card (px, 1920×1080)
  top: number; // top edge of the card
  onset: number; // first letter appears here (the spoken word's onset)
  exit: number; // the card is gone by this frame
  charFrames?: number; // frames per letter
  size?: number; // font size of the word
  fonts: Fonts;
};

const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);
const EASE_IN = Easing.bezier(0.7, 0, 0.84, 0);
const IN_FRAMES = 9;
const OUT_FRAMES = 9;
const BLINK_ON = 16;
const BLINK_OFF = 12;

export function TypeCue({id, frame, word, label = 'TYPE', mark, cx, top, onset, exit, charFrames = 2, size = 104, fonts}: TypeCueProps) {
  const pin = interpolate(frame, [onset - IN_FRAMES, onset], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE_OUT});
  const pout = interpolate(frame, [exit - OUT_FRAMES, exit], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE_IN});
  const p = pin * (1 - pout);
  if (p <= 0) return null;
  const typed = Math.max(0, Math.min(word.length, Math.floor((frame - onset) / charFrames) + 1));
  const done = typed >= word.length;
  const doneAt = onset + (word.length - 1) * charFrames;
  const caretOn = !done || (frame - doneAt) % (BLINK_ON + BLINK_OFF) < BLINK_ON;
  const padX = Math.round(size * 0.46);
  const padTop = Math.round(size * 0.3);
  const padBottom = Math.round(size * 0.26);
  const labelSize = Math.round(size * 0.21);
  return <div style={{...abs, left: cx, top: top + (1 - pin) * 14, transform: 'translateX(-50%)', opacity: p}}>
    <div style={{position: 'relative', display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: Math.round(size * 0.12),
      padding: `${padTop}px ${padX}px ${padBottom}px`, borderRadius: Math.round(size * 0.2), overflow: 'hidden', whiteSpace: 'nowrap',
      background: 'radial-gradient(150% 120% at 25% 15%, #2A2033 0%, #211828 55%, #1A1321 100%)',
      border: '1px solid rgba(240,238,232,0.10)', boxShadow: '0 22px 44px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.35)'}}>
      <PanelGrain id={id} />
      <div style={{position: 'relative', display: 'flex', alignItems: 'center', gap: Math.round(labelSize * 0.6)}}>
        {mark}
        <span style={{fontFamily: fonts.text.family, fontWeight: fonts.text.weight, fontSize: labelSize, lineHeight: 1, letterSpacing: '0.22em', color: NOTE.muted}}>{label}</span>
      </div>
      {/* The whole word is laid out from the start (untyped letters transparent), so the card never grows while it types. */}
      <div style={{position: 'relative', fontFamily: fonts.mono.family, fontWeight: fonts.mono.weight, fontSize: size, lineHeight: 1.08, letterSpacing: '-0.01em', color: C.accent}}>
        <span>{word.slice(0, typed)}</span>
        <span style={{display: 'inline-block', width: Math.round(size * 0.07), height: Math.round(size * 0.86), marginLeft: Math.round(size * 0.05), verticalAlign: '-0.1em',
          background: C.cream, opacity: caretOn ? 0.9 : 0, borderRadius: 2}} />
        <span style={{color: 'transparent'}}>{word.slice(typed)}</span>
      </div>
    </div>
  </div>;
}
