import React from 'react';
import {measureText} from '@remotion/layout-utils';
import {C, abs, sheet, type Face} from './index';
import {planTyping, typedAt, typedShare} from './hangul-typing';

// Typed instruction card (2026-09-18, user request): the Korean instruction the user actually typed is re-typed key by
// key through a real 두벌식 automaton (hangul-typing.ts), with the English translation revealing on the line below at
// the same pace, so both read at once. No sound: the user speaks over these scenes, and a keyboard sound on top of the
// voice got in the way (user, 2026-09-18). The card is a cream sheet — it covers only itself, never
// the whole screen, so the recording around it stays visible.

const INK_SOFT = '#6F6877';

export type TypingCardProps = {
  frame: number; // same clock as `start`
  start: number; // frame the first keystroke may land on
  typeFrames: number; // typing window; the last keystroke lands at start + typeFrames
  ko: string; // exact Korean text the user typed
  en: string; // English translation
  koFace: Face;
  enFace: Face;
  labelFace: Face;
  cx?: number; // horizontal centre
  y: number; // top
  appear?: number; // 0..1 presence of the card (entry/exit are the caller's)
  koSize?: number;
  enSize?: number;
  label?: string;
  pasted?: string; // a line that was pasted, not typed (e.g. a file path) — appears whole at `pastedAt`
  pastedAt?: number;
};

export function TypingCard({frame, start, typeFrames, ko, en, koFace, enFace, labelFace, cx = 960, y, appear = 1, koSize = 54, enSize = 32, label = 'PROMPT', pasted, pastedAt}: TypingCardProps) {
  if (appear <= 0) return null;
  const plan = planTyping(ko, typeFrames);
  const local = frame - start;
  const shown = typedAt(plan, local);
  const share = typedShare(plan, local);
  const typing = local >= 0 && local < typeFrames;
  // Cursor: solid while keys land, then a steady 1 Hz blink.
  const cursorOn = typing || local < 0 || Math.floor((local - typeFrames) / 15) % 2 === 0;

  // Size is fixed to the finished text (widest line, all lines) so the card never grows while it is being typed.
  const widest = (text: string, face: Face, size: number, ls: string) =>
    Math.max(...text.split('\n').map((line) => measureText({text: line, fontFamily: face.family, fontWeight: face.weight, fontSize: size, letterSpacing: ls}).width));
  const koLines = ko.split('\n').length, enLines = en.split('\n').length;
  const koW = widest(ko, koFace, koSize, '-0.01em'), enW = widest(en, enFace, enSize, '0.01em');
  const pastedSize = Math.round(koSize * 0.52);
  const pastedW = pasted ? measureText({text: pasted, fontFamily: koFace.family, fontWeight: koFace.weight, fontSize: pastedSize, letterSpacing: '0em'}).width : 0;
  const padX = 56, w = Math.ceil(Math.max(koW + koSize * 0.4, enW, pastedW) + padX * 2);
  const pastedH = pasted ? pastedSize * 1.5 + 10 : 0;
  const koH = koSize * 1.35 * koLines, enH = enSize * 1.3 * enLines;
  const h = Math.round(pastedH + koH + enH + 118);
  const pastedOn = pasted !== undefined && frame >= (pastedAt ?? start);
  const koTop = 68 + pastedH;
  const enShown = en.slice(0, Math.round(en.length * share));

  return <div style={{...abs, left: cx - w / 2, top: y + (1 - appear) * 22, width: w, height: h, ...sheet, borderRadius: 12, opacity: appear, overflow: 'hidden'}}>
    <div style={{...abs, left: padX, top: 30, display: 'flex', alignItems: 'center', gap: 12}}>
      <div style={{width: 10, height: 10, borderRadius: 5, background: typing ? C.ink : INK_SOFT, opacity: typing ? 1 : 0.5}} />
      <span style={{fontFamily: labelFace.family, fontWeight: labelFace.weight, fontSize: 22, letterSpacing: '0.12em', color: INK_SOFT}}>{label}</span>
    </div>
    {pasted && pastedOn && <div style={{...abs, left: padX, top: 66, width: w - padX * 2, whiteSpace: 'pre', fontFamily: koFace.family, fontWeight: koFace.weight,
      fontSize: pastedSize, lineHeight: 1.5, color: INK_SOFT, fontSynthesis: 'none'}}>{pasted}</div>}
    <div style={{...abs, left: padX, top: koTop, width: w - padX * 2, whiteSpace: 'pre', fontFamily: koFace.family, fontWeight: koFace.weight, fontSize: koSize,
      lineHeight: 1.35, letterSpacing: '-0.01em', color: C.ink, fontSynthesis: 'none'}}>
      {shown}
      <span style={{display: 'inline-block', width: Math.max(3, koSize * 0.06), height: koSize * 0.95, marginLeft: koSize * 0.06, verticalAlign: '-0.12em',
        background: C.ink, opacity: cursorOn ? 1 : 0}} />
    </div>
    <div style={{...abs, left: padX, top: koTop + koH + 14, width: w - padX * 2, height: 2, background: '#19151D1F'}} />
    <div style={{...abs, left: padX, top: koTop + koH + 30, width: w - padX * 2, whiteSpace: 'pre', fontFamily: enFace.family, fontWeight: enFace.weight,
      fontSize: enSize, lineHeight: 1.3, letterSpacing: '0.01em', color: INK_SOFT, fontSynthesis: 'none'}}>{enShown}</div>
  </div>;
}

/** Card height for layout (matches TypingCard). */
export const typingCardHeight = (ko: string, en: string, koSize = 54, enSize = 32, pasted = false) =>
  Math.round((pasted ? Math.round(koSize * 0.52) * 1.5 + 10 : 0) + koSize * 1.35 * ko.split('\n').length + enSize * 1.3 * en.split('\n').length + 118);
