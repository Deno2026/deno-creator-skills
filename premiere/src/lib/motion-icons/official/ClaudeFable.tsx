import React, {type CSSProperties} from 'react';
import {CLAUDE_BRAND, CLAUDE_FABLE_VIEWBOX, CLAUDE_FABLE_WORDMARK_PATHS, CLAUDE_SPARK_BOX, CLAUDE_SPARK_PATH} from './claude-fable-paths';

// Anthropic's official "Claude Fable" lockup, drawn from the verbatim path data (see claude-fable-paths.ts for source
// and hash). Use the official mark when a scene names the product — the user found generic plum cards with the name
// typed on them cheap ("보라색 판떼기에 글씨 — 촌스러움 포인트", 2026-09-18). Rule: channel-motion-profile.md → 아이콘·마크 소스.
export {CLAUDE_BRAND};

/** The spark alone. `grow` 0→1 scales it up from its centre, `turn` rotates it (degrees). */
export function ClaudeSpark({size, grow = 1, turn = 0, color = CLAUDE_BRAND.orange, style = {}}: {
  size: number; grow?: number; turn?: number; color?: string; style?: CSSProperties;
}) {
  if (grow <= 0) return null;
  const b = CLAUDE_SPARK_BOX;
  return <svg viewBox={`0 0 ${b} ${b}`} width={size} height={size}
    style={{display: 'block', flex: 'none', overflow: 'visible', transform: `rotate(${turn}deg) scale(${grow})`, transformOrigin: '50% 50%', ...style}}>
    <path d={CLAUDE_SPARK_PATH} fill={color} />
  </svg>;
}

/**
 * The full lockup at `height` px (width follows the official 917:125 ratio). The spark and the wordmark animate
 * separately: `grow`/`turn` for the spark, `word` wipes the wordmark in from the left. `on` picks the published text
 * colour for the background it sits on — brand light #FAF9F5 on dark, brand dark #141413 on light. No other recolouring.
 */
export function ClaudeFableLockup({height, grow = 1, turn = 0, word = 1, on = 'dark', style = {}}: {
  height: number; grow?: number; turn?: number; word?: number; on?: 'dark' | 'light'; style?: CSSProperties;
}) {
  const {w, h} = CLAUDE_FABLE_VIEWBOX, b = CLAUDE_SPARK_BOX, k = height / h;
  const fill = on === 'dark' ? CLAUDE_BRAND.light : CLAUDE_BRAND.dark;
  return <div style={{position: 'relative', width: w * k, height, flex: 'none', ...style}}>
    <div style={{position: 'absolute', left: 0, top: 0}}><ClaudeSpark size={b * k} grow={grow} turn={turn} /></div>
    {word > 0 && <svg viewBox={`${b} 0 ${w - b} ${h}`} width={(w - b) * k} height={height}
      style={{position: 'absolute', left: b * k, top: 0, overflow: 'visible', clipPath: `inset(0 ${(1 - Math.min(1, word)) * 100}% 0 0)`}}>
      {CLAUDE_FABLE_WORDMARK_PATHS.map((d, i) => <path key={i} d={d} fill={fill} />)}
    </svg>}
  </div>;
}

/** Width of the lockup at a given height (official ratio). */
export const claudeFableWidth = (height: number) => (height * CLAUDE_FABLE_VIEWBOX.w) / CLAUDE_FABLE_VIEWBOX.h;
