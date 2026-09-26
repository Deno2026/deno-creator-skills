// Recipe basis: stage-recipes.md § T3; board _scratch/reference/2026-09-11_stage-recipes/boards/T03.jpg. Full-screen cut and optional non-obstructing PIP only; reference UI and branding are excluded.
import {Interactive, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {StageCanvas} from './StagePrimitives';
import {PLUM_NOIR, STAGE_SAFE_AREA} from './tokens';
import {enterOpacity, exitOpacity, stageEasing} from './timing';
import type {StageEasing, StageRect, StageSlot} from './types';
import {intersects} from './timing';

export type ScreenRecordingBeatProps = {
  captureSlot: StageSlot;
  pip?: StageSlot;
  criticalInputRect?: StageRect;
  enterCut?: boolean;
  enterMs?: number;
  holdMs?: number;
  exitCut?: boolean;
  exitMs?: number;
  easing?: StageEasing;
};

const pipCandidates: StageRect[] = [
  {x: 1512, y: 744, width: 312, height: 234},
  {x: 96, y: 744, width: 312, height: 234},
  {x: 1512, y: 72, width: 312, height: 234},
  {x: 96, y: 72, width: 312, height: 234},
];

export const choosePipRect = (criticalInputRect?: StageRect) =>
  pipCandidates.find(
    (candidate) => !criticalInputRect || !intersects(candidate, criticalInputRect),
  ) ?? null;

export const ScreenRecordingBeat = ({
  captureSlot,
  pip,
  criticalInputRect,
  enterCut = true,
  enterMs = 0,
  holdMs = 3583,
  exitCut = true,
  exitMs = 0,
  easing = 'linear',
}: ScreenRecordingBeatProps) => {
  const frame = useCurrentFrame();
  const {durationInFrames, fps} = useVideoConfig();
  const pipRect = pip ? choosePipRect(criticalInputRect) : null;
  const visibility =
    enterOpacity({easing, enterCut, enterMs, fps, frame}) *
    exitOpacity({
      durationInFrames,
      easing,
      exitCut,
      exitMs,
      exitStartMs: enterMs + holdMs,
      fps,
      frame,
    });

  return (
    <StageCanvas name="Screen recording beat" style={{opacity: visibility}}>
      <Interactive.Div
        name="Screen capture slot"
        style={{bottom: 0, left: 0, position: 'absolute', right: 0, top: 0}}
      >
        {captureSlot}
      </Interactive.Div>
      {pip && pipRect ? (
        <Interactive.Div
          name="Optional presenter PIP"
          style={{
            backgroundColor: PLUM_NOIR.primarySurface,
            border: `2px solid ${PLUM_NOIR.plumDetail}`,
            height: pipRect.height,
            left: pipRect.x,
            opacity: interpolate(frame, [1, Math.max(2, Math.round(fps * 0.042))], [0, 1], {
              easing: stageEasing('ease-out'),
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
            overflow: 'hidden',
            position: 'absolute',
            top: pipRect.y,
            width: pipRect.width,
          }}
        >
          {pip}
        </Interactive.Div>
      ) : null}
      {criticalInputRect ? (
        <div
          style={{
            border: `2px solid ${PLUM_NOIR.signalAccent}`,
            height: criticalInputRect.height,
            left: criticalInputRect.x,
            pointerEvents: 'none',
            position: 'absolute',
            top: criticalInputRect.y,
            width: criticalInputRect.width,
          }}
        />
      ) : null}
      <div
        style={{
          bottom: STAGE_SAFE_AREA.vertical,
          color: PLUM_NOIR.secondaryText,
          fontSize: 28,
          left: STAGE_SAFE_AREA.horizontal,
          letterSpacing: 1.2,
          position: 'absolute',
        }}
      >
        {pip && !pipRect ? 'PIP hidden · input region protected' : ''}
      </div>
    </StageCanvas>
  );
};
