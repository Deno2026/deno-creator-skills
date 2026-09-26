import {Easing, interpolate} from 'remotion';
import type {StageEasing, StageRect} from './types';

export const msToFrames = (milliseconds: number, fps: number) =>
  Math.max(0, Math.round((milliseconds / 1000) * fps));

export const stageEasing = (easing: StageEasing) =>
  easing === 'linear' ? Easing.linear : Easing.out(Easing.cubic);

export const enterOpacity = ({
  easing,
  enterCut,
  enterMs,
  fps,
  frame,
}: {
  easing: StageEasing;
  enterCut: boolean;
  enterMs: number;
  fps: number;
  frame: number;
}) => {
  if (frame <= 0) return 0;
  if (enterCut || enterMs <= 0) return 1;
  return interpolate(frame, [0, Math.max(1, msToFrames(enterMs, fps))], [0, 1], {
    easing: stageEasing(easing),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
};

export const exitOpacity = ({
  durationInFrames,
  easing,
  exitCut,
  exitMs,
  exitStartMs,
  fps,
  frame,
}: {
  durationInFrames: number;
  easing: StageEasing;
  exitCut: boolean;
  exitMs: number;
  exitStartMs: number;
  fps: number;
  frame: number;
}) => {
  if (frame <= 0 || frame >= durationInFrames - 1) return 0;
  const exitStartFrame = msToFrames(exitStartMs, fps);
  if (frame < exitStartFrame) return 1;
  if (exitCut || exitMs <= 0) return 0;
  return interpolate(
    frame,
    [exitStartFrame, exitStartFrame + Math.max(1, msToFrames(exitMs, fps))],
    [1, 0],
    {
      easing: stageEasing(easing),
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    },
  );
};

export const intersects = (left: StageRect, right: StageRect) =>
  left.x < right.x + right.width &&
  left.x + left.width > right.x &&
  left.y < right.y + right.height &&
  left.y + left.height > right.y;
