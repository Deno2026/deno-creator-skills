import React from 'react';
import {Easing, interpolate} from 'remotion';

// Location cue for click/button guidance (added 2026-09-28; when to use it: the channel motion profile, location cue row).
// Default `spotlight`: the camera eases toward the target (about 1.3×, ease-in-out both ways) and everything around the
// target fades by opacity (not blur), so only what is being pointed at keeps full brightness.
// It is not a magnifier: the on-screen text is not blown up to be read.
// `arrow` / `box` were the first sample (A/B); fading the surroundings was chosen instead. They stay available.
// `stops`: several places pointed at in a row on one screen (e.g. three settings in one dialog) — the camera stays zoomed
// and glides from one to the next instead of zooming out and back in (first used 2026-09-28, comfyui-2026-install).

export const LOCATE_SIGNAL = '#F2FF59'; // Acid Yellow, flat (DESIGN_AUTHORITY: signal accent, no glow)
export const LOCATE_INK = '#0F0E12'; // deep background token: keyline for marks, field under the faded screen

export type LocateRect = {x: number; y: number; w: number; h: number; radius?: number};
export type LocateArrowFrom = 'below-left' | 'below-right' | 'above-left' | 'above-right' | 'left' | 'right';
// One place pointed at in a run on the same screen. `at` = frame where the camera starts gliding here from the previous stop
// (ignored for the first stop, which the camera zooms toward). The zoom level stays; only the window and the kept area move.
export type LocateStop = {target: LocateRect; at: number};

export type LocateCueProps = {
  frame: number; // frame inside the cue (0 = first frame of the underlying span)
  target?: LocateRect; // target in screen pixels (1920×1080) before zoom — or `stops` for several places in a row
  stops?: LocateStop[];
  moveFrames?: number; // glide between stops (ease-in-out)
  markStart: number; // spoken anchor: the target is named or pointed at (arrow/box appear here)
  markEnd: number; // the click / the screen changes: the focus leaves and the camera returns
  variant?: 'spotlight' | 'arrow' | 'box';
  zoom?: number; // default 1.3 (1.1 read too small)
  zoomInStart?: number;
  zoomInFrames?: number;
  zoomOutFrames?: number;
  surroundOpacity?: number; // spotlight: opacity of everything outside the target at full focus
  focusPad?: number; // spotlight: kept area around the target (px, before zoom)
  feather?: number; // spotlight: soft edge of the kept area (px)
  arrowFrom?: LocateArrowFrom;
  blinks?: number; // arrow blinks before it holds
  // HARD RULE (2026-09-28): with a full-video overlay on top (tutorial frame), zoom only inside its open window.
  // The camera never leaves this rect, so content the overlay hides (browser bar, taskbar) can never slide into view.
  // Default = the whole frame (no overlay).
  viewport?: LocateRect;
  width?: number;
  height?: number;
  children: React.ReactNode; // the screen recording for this span
};

// Ease-in-out for the camera in both directions.
const EASE = Easing.bezier(0.65, 0, 0.35, 1);
const BLINK_ON = 8;
const BLINK_OFF = 5;
const EXIT_FRAMES = 3;
const EDGE_MARGIN = 12; // keep the camera inside the recording, away from its borders

const clamp01 = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clampTo = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const lerpRect = (a: LocateRect, b: LocateRect, t: number): LocateRect => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  w: lerp(a.w, b.w, t),
  h: lerp(a.h, b.h, t),
  radius: lerp(a.radius ?? 8, b.radius ?? 8, t),
});

// Where the camera and the kept area are at `frame`: the first stop, then each later stop glides in from its `at`.
function currentTarget(frame: number, stops: LocateStop[], moveFrames: number) {
  let cur = stops[0].target;
  for (let i = 1; i < stops.length; i++) {
    const t = interpolate(frame, [stops[i].at, stops[i].at + moveFrames], [0, 1], {...clamp01, easing: EASE});
    if (t <= 0) break;
    cur = lerpRect(cur, stops[i].target, t);
  }
  return cur;
}

function markOpacity(frame: number, markStart: number, markEnd: number) {
  if (frame < markStart || frame >= markEnd) return 0;
  return interpolate(frame, [markEnd - EXIT_FRAMES, markEnd], [1, 0], clamp01);
}

const ARROW_DIR: Record<LocateArrowFrom, [number, number]> = {
  'below-left': [-1, 1],
  'below-right': [1, 1],
  'above-left': [-1, -1],
  'above-right': [1, -1],
  left: [-1, 0],
  right: [1, 0],
};

function Arrow({target, from, frame, markStart, blinks}: {target: LocateRect; from: LocateArrowFrom; frame: number; markStart: number; blinks: number}) {
  const [dx, dy] = ARROW_DIR[from];
  const gap = 8;
  const tipX = dy === 0 ? (dx < 0 ? target.x - gap : target.x + target.w + gap) : dx < 0 ? target.x + target.w * 0.2 : target.x + target.w * 0.8;
  const tipY = dy > 0 ? target.y + target.h + gap : dy < 0 ? target.y - gap : target.y + target.h / 2;
  const length = 72;
  const norm = Math.hypot(dx, dy);
  const tailX = tipX + (dx / norm) * length;
  const tailY = tipY + (dy / norm) * length;
  const angle = (Math.atan2(tipY - tailY, tipX - tailX) * 180) / Math.PI;
  const local = frame - markStart;
  const cycle = BLINK_ON + BLINK_OFF;
  if (!(local >= blinks * cycle || local % cycle < BLINK_ON)) return null;
  const head = 24;
  const half = 4.5;
  const headHalf = 14;
  const d = `M0,${-half} L${length - head},${-half} L${length - head},${-headHalf} L${length},0 L${length - head},${headHalf} L${length - head},${half} L0,${half} Z`;
  return (
    <g transform={`translate(${tailX} ${tailY}) rotate(${angle})`}>
      <path d={d} fill={LOCATE_SIGNAL} stroke={LOCATE_INK} strokeWidth={3} strokeLinejoin="round" paintOrder="stroke" />
    </g>
  );
}

function Box({target, frame, markStart}: {target: LocateRect; frame: number; markStart: number}) {
  const pad = 8;
  const x = target.x - pad;
  const y = target.y - pad;
  const w = target.w + pad * 2;
  const h = target.h + pad * 2;
  const r = Math.min((target.radius ?? 8) + pad, h / 2);
  const perimeter = 2 * (w + h - 4 * r) + 2 * Math.PI * r;
  const drawn = interpolate(frame - markStart, [0, 9], [0, 1], {...clamp01, easing: EASE});
  const dash = {strokeDasharray: perimeter, strokeDashoffset: perimeter * (1 - drawn)};
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={r} ry={r} fill="none" stroke={LOCATE_INK} strokeWidth={7} {...dash} />
      <rect x={x} y={y} width={w} height={h} rx={r} ry={r} fill="none" stroke={LOCATE_SIGNAL} strokeWidth={3.5} {...dash} />
    </g>
  );
}

// Kept area: target + pad stays fully bright; from there the surroundings fade out across `feather` px
// — a wide, gradual edge, so the surroundings dim and brighten back smoothly.
// A rounded rect grown by pad + feather/2 and blurred with σ = feather/4 reaches ≈0.98 at the pad edge and ≈0.02 at pad + feather.
function focusMask(target: LocateRect, pad: number, feather: number, width: number, height: number) {
  const grow = pad + feather / 2;
  const x = target.x - grow;
  const y = target.y - grow;
  const w = target.w + grow * 2;
  const h = target.h + grow * 2;
  const r = Math.min((target.radius ?? 8) + grow, h / 2);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}'>` +
    `<defs><filter id='f' filterUnits='userSpaceOnUse' x='0' y='0' width='${width}' height='${height}'><feGaussianBlur stdDeviation='${feather / 4}'/></filter></defs>` +
    `<rect x='${x}' y='${y}' width='${w}' height='${h}' rx='${r}' ry='${r}' fill='white' filter='url(#f)'/></svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
}

export function LocateCue({
  frame,
  target: singleTarget,
  stops,
  moveFrames = 30,
  markStart,
  markEnd,
  variant = 'spotlight',
  zoom = 1.3,
  zoomInStart = 0,
  // Wide keys: 1.5 s each way (0.7 s in / 0.5 s out read too fast).
  zoomInFrames = 45,
  zoomOutFrames = 45,
  surroundOpacity = 0.55,
  focusPad = 16,
  feather = 90, // 140 read too wide
  arrowFrom = 'below-left',
  blinks = 3,
  viewport,
  width = 1920,
  height = 1080,
  children,
}: LocateCueProps) {
  const path = stops?.length ? stops : singleTarget ? [{target: singleTarget, at: 0}] : null;
  if (!path) throw new Error('LocateCue needs `target` or `stops`');
  const target = currentTarget(frame, path, moveFrames);
  const pin = interpolate(frame, [zoomInStart, zoomInStart + zoomInFrames], [0, 1], {...clamp01, easing: EASE});
  const pout = interpolate(frame, [markEnd, markEnd + zoomOutFrames], [0, 1], {...clamp01, easing: EASE});
  const p = pin * (1 - pout);

  // Camera: inside the viewport, the source window shrinks from the whole viewport to a 1/zoom window around the target
  // and is mapped back onto the viewport. It stays inside the viewport, so only content already visible there is shown.
  const vp = viewport ?? {x: 0, y: 0, w: width, h: height};
  const margin = viewport ? 4 : EDGE_MARGIN; // with an overlay: a few px inside its hard edge (no resampling bleed)
  const tw = vp.w / zoom;
  const th = vp.h / zoom;
  const cx = target.x + target.w / 2;
  const cy = target.y + target.h / 2;
  const tx = clampTo(cx - tw / 2, vp.x + margin, vp.x + vp.w - tw - margin);
  const ty = clampTo(cy - th / 2, vp.y + margin, vp.y + vp.h - th - margin);
  const winW = lerp(vp.w, tw, p);
  const winX = lerp(vp.x, tx, p);
  const winY = lerp(vp.y, ty, p);
  const s = vp.w / winW;
  const camera = `translate(${vp.x - winX * s}px, ${vp.y - winY * s}px) scale(${s})`;

  // Spotlight strength rides the camera in; it leaves just around the click so the new screen is not left faded.
  const focusOut = interpolate(frame, [markEnd - 9, markEnd + 9], [0, 1], {...clamp01, easing: EASE});
  const focus = variant === 'spotlight' ? pin * (1 - focusOut) : 0;
  const mask = variant === 'spotlight' ? focusMask(target, focusPad, feather, width, height) : '';
  const opacity = markOpacity(frame, markStart, markEnd);

  return (
    <div style={{position: 'absolute', inset: 0, overflow: 'hidden', background: LOCATE_INK}}>
      <div style={{position: 'absolute', inset: 0, transformOrigin: '0 0', transform: camera}}>
        {focus > 0 ? (
          <>
            <div style={{position: 'absolute', inset: 0, opacity: 1 - (1 - surroundOpacity) * focus}}>{children}</div>
            <div style={{position: 'absolute', inset: 0, WebkitMaskImage: mask, maskImage: mask, WebkitMaskSize: `${width}px ${height}px`, maskSize: `${width}px ${height}px`, WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat'}}>
              {children}
            </div>
          </>
        ) : (
          children
        )}
        {variant !== 'spotlight' && opacity > 0 ? (
          <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} style={{position: 'absolute', inset: 0, opacity}}>
            {variant === 'box' ? (
              <Box target={target} frame={frame} markStart={markStart} />
            ) : (
              <Arrow target={target} from={arrowFrom} frame={frame} markStart={markStart} blinks={blinks} />
            )}
          </svg>
        ) : null}
      </div>
    </div>
  );
}
