// Recipe basis: stage-recipes.md § T19; board _scratch/reference/2026-09-11_stage-recipes/boards/T19.jpg. Result role changes across a cut; reference footage, PIP, copy, logo, and palette are excluded.
import {Interactive, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {StageCanvas} from './StagePrimitives';
import {PLUM_NOIR, withAlpha} from './tokens';
import {exitOpacity, msToFrames, stageEasing} from './timing';
import type {StageEasing, StageRect, StageSlot} from './types';

export type ResultToSidePanelProps = {
  mediaSlot: StageSlot;
  sidePanelRect: StageRect;
  transition?: 'cut' | 'ease-out';
  fullScreenMs?: number;
  transitionMs?: number;
  holdMs?: number;
  easing?: StageEasing;
};

export const ResultToSidePanel = ({
  mediaSlot,
  sidePanelRect,
  transition = 'cut',
  fullScreenMs = 3000,
  transitionMs = 500,
  holdMs = 1300,
  easing = 'ease-out',
}: ResultToSidePanelProps) => {
  const frame = useCurrentFrame();
  const {durationInFrames, fps} = useVideoConfig();
  const transitionStart = msToFrames(fullScreenMs, fps);
  const transitionEnd = transitionStart + msToFrames(transitionMs, fps);
  const transitionProgress =
    transition === 'cut'
      ? frame >= transitionStart
        ? 1
        : 0
      : interpolate(frame, [transitionStart, transitionEnd], [0, 1], {
          easing: stageEasing(easing),
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
  const activeTransitionMs = transition === 'cut' ? 0 : transitionMs;

  return (
    <StageCanvas
      name="Result to side panel"
      style={{
        opacity: exitOpacity({
          durationInFrames,
          easing,
          exitCut: true,
          exitMs: 0,
          exitStartMs: fullScreenMs + activeTransitionMs + holdMs,
          fps,
          frame,
        }),
      }}
    >
      <Interactive.Div
        name="Result media slot"
        style={{
          backgroundColor: PLUM_NOIR.primarySurface,
          border: `${Math.round(interpolate(transitionProgress, [0, 1], [0, 2]))}px solid ${
            PLUM_NOIR.plumDetail
          }`,
          boxShadow:
            transitionProgress > 0
              ? `0 28px 68px ${withAlpha(PLUM_NOIR.deepBackground, 0.56)}`
              : 'none',
          height: interpolate(transitionProgress, [0, 1], [1080, sidePanelRect.height], {
            easing: stageEasing(easing),
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          left: interpolate(transitionProgress, [0, 1], [0, sidePanelRect.x], {
            easing: stageEasing(easing),
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          overflow: 'hidden',
          position: 'absolute',
          top: interpolate(transitionProgress, [0, 1], [0, sidePanelRect.y], {
            easing: stageEasing(easing),
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          width: interpolate(transitionProgress, [0, 1], [1920, sidePanelRect.width], {
            easing: stageEasing(easing),
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      >
        {mediaSlot}
      </Interactive.Div>
    </StageCanvas>
  );
};
