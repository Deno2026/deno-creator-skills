// Recipe basis: stage-recipes.md § T5; board _scratch/reference/2026-09-11_stage-recipes/boards/T05.jpg. Full-screen result role and cut return only; reference frames and branding are excluded.
import {Interactive, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {StageCanvas} from './StagePrimitives';
import {PLUM_NOIR} from './tokens';
import {enterOpacity, exitOpacity, stageEasing} from './timing';
import type {StageEasing, StageSlot} from './types';

export type FullscreenResultRevealProps = {
  mediaSlot: StageSlot;
  enterCut?: boolean;
  enterMs?: number;
  holdMs?: number;
  exitCut?: boolean;
  exitMs?: number;
  easing?: StageEasing;
};

export const FullscreenResultReveal = ({
  mediaSlot,
  enterCut = true,
  enterMs = 500,
  holdMs = 3000,
  exitCut = true,
  exitMs = 0,
  easing = 'ease-out',
}: FullscreenResultRevealProps) => {
  const frame = useCurrentFrame();
  const {durationInFrames, fps} = useVideoConfig();
  const entryProgress = enterOpacity({
    easing,
    enterCut,
    enterMs: enterCut ? 0 : enterMs,
    fps,
    frame,
  });
  const visibility =
    entryProgress *
    exitOpacity({
      durationInFrames,
      easing,
      exitCut,
      exitMs,
      exitStartMs: (enterCut ? 0 : enterMs) + holdMs,
      fps,
      frame,
    });

  return (
    <StageCanvas name="Full-screen result reveal" style={{opacity: visibility}}>
      <Interactive.Div
        name="Full-screen result slot"
        style={{
          backgroundColor: PLUM_NOIR.deepBackground,
          bottom: 0,
          left: 0,
          overflow: 'hidden',
          position: 'absolute',
          right: 0,
          scale: enterCut
            ? '1'
            : `${interpolate(entryProgress, [0, 1], [1.035, 1], {
                easing: stageEasing(easing),
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              })}`,
          top: 0,
        }}
      >
        {mediaSlot}
      </Interactive.Div>
    </StageCanvas>
  );
};
