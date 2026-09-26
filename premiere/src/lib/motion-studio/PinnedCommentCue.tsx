import React from 'react';
import {Img} from 'remotion';
import {C, W, abs, type Face, type Fonts} from './index';
import {NotePanel} from './NotePanel';
import {brandMark} from '../motion-icons/BrandMark';
import channelMark from './brand/deno-w01-solid-signal-256.png';

// ---- "Link in the pinned comment" cue — Deno's fixed asset (2026-09-23) ----
// Whenever the narration says the link is in the pinned comment, show where that is: a small YouTube watch page — the
// video, and under it the comments with the channel's pinned comment on top and the link underlined. Same design in
// every video; only the link label changes. Candidates and the choice (P1 page schematic over P2 comment row):
// productions/higgsfield-after-effects-20260923. Rule owner: channel-motion-profile.md → 고정 댓글 안내.
//
//   const ko = useKoreanFont(pinnedCommentLines(linkLabel));   // load the Korean face first
//   <PinnedCommentCue fonts={fonts} ko={ko} linkLabel="Higgsfield · After Effects 플러그인 링크" p={p} row={row} pin={pin} line={line} />
//
// Progress values (0..1, from the production's easing): p = whole cue in/out, row = pinned row rises, pin = pin drops,
// line = link underline sweeps. Suggested onsets: row at the word '고정', pin +4f, line +12f.

// 채널 핸들은 렌더 환경의 REMOTION_CHANNEL_HANDLE(.env)이나 handle prop으로 준다 — 코드에 개인 채널을 두지 않는다(2026-09-27).
export const CHANNEL_HANDLE = process.env.REMOTION_CHANNEL_HANDLE ?? '@channel';
const YT_RED = '#FF0000';
const MUTED = '#A79BAE', NOTE = '#C2B8C8', RAISED = '#2E1E38';
const COMMENTS = '댓글';
const pinnedBy = (handle: string) => `${handle}님이 고정함`;

/** Korean strings the cue draws; pass them to useKoreanFont before rendering. */
export const pinnedCommentLines = (linkLabel: string, handle = CHANNEL_HANDLE) => [pinnedBy(handle), COMMENTS, linkLabel];

export function YouTubeLogo({size}: {size: number}) {
  const icon = brandMark('youtube');
  return <svg viewBox="0 0 24 24" width={size} height={size} style={{display: 'block', flex: 'none'}}>
    <path d={icon.path} fill={YT_RED} />
    <path d="M9.545 15.568V8.432L15.818 12z" fill="#FFFFFF" />
  </svg>;
}

function PinIcon({size, color}: {size: number; color: string}) {
  return <svg viewBox="0 0 24 24" width={size} height={size} style={{display: 'block', flex: 'none'}}>
    <path d="M8.5 3.5h7 M10 3.5l-.6 6.3L6.5 13.2h11l-2.9-3.4L14 3.5 M12 13.2v7.3" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export function PinnedCommentCue({fonts, ko, linkLabel, handle = CHANNEL_HANDLE, p, row, pin, line, x = 600, y = 206, dimTop = 0, dimBottom = 1080, dim = 0.6}: {
  fonts: Fonts; ko: Face; linkLabel: string; handle?: string; p: number; row: number; pin: number; line: number;
  x?: number; y?: number; dimTop?: number; dimBottom?: number; dim?: number;
}) {
  if (p <= 0) return null;
  const WD = 720, kf = {fontFamily: ko.family, fontWeight: ko.weight};
  return <>
    <div style={{...abs, left: 0, top: dimTop, width: W, height: dimBottom - dimTop, background: C.black, opacity: dim * p}} />
    <NotePanel id="pinned-comment" x={x} y={y} w={WD} h={640} p={p} dy={26}>
      <div style={{...abs, left: 32, top: 26, display: 'flex', alignItems: 'center', gap: 10}}>
        <YouTubeLogo size={40} />
        <span style={{fontFamily: fonts.heavy.family, fontWeight: fonts.heavy.weight, fontSize: 26, color: C.cream, whiteSpace: 'nowrap'}}>YouTube</span>
      </div>
      {/* the video */}
      <div style={{...abs, left: 32, top: 84, width: WD - 64, height: 262, borderRadius: 10, background: '#0B090D', border: '1px solid rgba(240,238,232,0.08)', overflow: 'hidden'}}>
        <svg viewBox="0 0 24 24" width={54} height={54} style={{position: 'absolute', left: (WD - 64) / 2 - 27, top: 104}}><path d="M8 5.5v13l10.5-6.5z" fill="rgba(240,238,232,0.75)" /></svg>
        <div style={{...abs, left: 16, right: 16, bottom: 14, height: 4, borderRadius: 2, background: 'rgba(240,238,232,0.18)'}} />
        <div style={{...abs, left: 16, bottom: 14, width: '38%', height: 4, borderRadius: 2, background: YT_RED}} />
      </div>
      {/* the comments, the pinned one on top */}
      <div style={{...abs, left: 32, top: 366, ...kf, fontSize: 22, color: C.cream}}>{COMMENTS}</div>
      <div style={{...abs, left: 20, top: 406 + (1 - row) * 12, width: WD - 40, height: 140, borderRadius: 12, background: RAISED, opacity: row}}>
        <div style={{...abs, left: 22, top: 14 - (1 - pin) * 12, opacity: pin, display: 'flex', alignItems: 'center', gap: 8}}>
          <PinIcon size={21} color={MUTED} /><span style={{...kf, fontSize: 18, color: NOTE, whiteSpace: 'nowrap'}}>{pinnedBy(handle)}</span>
        </div>
        <div style={{...abs, left: 22, top: 52}}>
          <Img src={channelMark} style={{width: 50, height: 50, borderRadius: 25, objectFit: 'cover', display: 'block'}} />
        </div>
        <div style={{...abs, left: 88, top: 52, fontFamily: fonts.text.family, fontWeight: fonts.text.weight, fontSize: 20, color: C.cream, whiteSpace: 'nowrap'}}>{handle}</div>
        <div style={{...abs, left: 88, top: 84}}>
          <span style={{...kf, fontSize: 26, color: C.cream, whiteSpace: 'nowrap'}}>{linkLabel}</span>
          <div style={{height: 3, marginTop: 4, width: `${100 * line}%`, background: C.accent, borderRadius: 2}} />
        </div>
      </div>
      {/* the rest of the list, faded */}
      <div style={{...abs, left: 42, top: 568, opacity: 0.45 * row, display: 'flex', gap: 16, alignItems: 'center'}}>
        <div style={{width: 36, height: 36, borderRadius: 18, background: 'rgba(240,238,232,0.14)'}} />
        <div>
          <div style={{width: 180, height: 10, borderRadius: 5, background: 'rgba(240,238,232,0.16)'}} />
          <div style={{width: 320, height: 10, marginTop: 10, borderRadius: 5, background: 'rgba(240,238,232,0.10)'}} />
        </div>
      </div>
    </NotePanel>
  </>;
}
