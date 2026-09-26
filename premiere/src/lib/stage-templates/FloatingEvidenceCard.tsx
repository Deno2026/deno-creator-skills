// Recipe basis: stage-recipes.md § T4; board _scratch/reference/2026-09-11_stage-recipes/boards/T04.jpg. Opposite-half placement and sequential inner beats only; reference imagery, logo, and palette are excluded.
import {Interactive, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {SignalRule, StageCanvas} from './StagePrimitives';
import {PLUM_NOIR, STAGE_SAFE_AREA, withAlpha} from './tokens';
import {enterOpacity, exitOpacity, msToFrames, stageEasing} from './timing';
import type {HorizontalAnchor, StageEasing, StageSlot} from './types';

export type FloatingEvidenceCardProps = {
  mediaSlot: StageSlot;
  anchor?: HorizontalAnchor;
  enterMs?: number;
  innerBeatsMs?: number[];
  holdMs?: number;
  exitMs?: number;
  easing?: StageEasing;
};

export const FloatingEvidenceCard = ({
  mediaSlot,
  anchor = 'right',
  enterMs = 170,
  innerBeatsMs = [0, 750, 1500],
  holdMs = 3200,
  exitMs = 190,
  easing = 'ease-out',
}: FloatingEvidenceCardProps) => {
  const frame = useCurrentFrame();
  const {durationInFrames, fps} = useVideoConfig();
  const readyMs = enterMs + Math.max(0, ...innerBeatsMs);
  const entryProgress = enterOpacity({
    easing,
    enterCut: false,
    enterMs,
    fps,
    frame,
  });

  return (
    <StageCanvas
      name="Floating evidence card"
      style={{
        opacity: exitOpacity({
          durationInFrames,
          easing,
          exitCut: false,
          exitMs,
          exitStartMs: readyMs + holdMs,
          fps,
          frame,
        }),
      }}
    >
      <Interactive.Div
        name="Evidence card"
        style={{
          backgroundColor: PLUM_NOIR.primarySurface,
          border: `2px solid ${PLUM_NOIR.plumDetail}`,
          boxShadow: `0 30px 70px ${withAlpha(PLUM_NOIR.deepBackground, 0.54)}`,
          height: 650,
          left: anchor === 'left' ? STAGE_SAFE_AREA.horizontal : undefined,
          opacity: entryProgress,
          overflow: 'hidden',
          position: 'absolute',
          right: anchor === 'right' ? STAGE_SAFE_AREA.horizontal : undefined,
          scale: `${interpolate(entryProgress, [0, 1], [0.96, 1], {
            easing: stageEasing(easing),
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          })}`,
          top: 190,
          translate: `${interpolate(entryProgress, [0, 1], [anchor === 'left' ? -42 : 42, 0], {
            easing: stageEasing(easing),
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          })}px 0px`,
          width: 780,
        }}
      >
        <div style={{height: 500, overflow: 'hidden'}}>{mediaSlot}</div>
        <div
          style={{
            alignItems: 'center',
            display: 'flex',
            gap: 24,
            height: 150,
            padding: '0 34px',
          }}
        >
          {innerBeatsMs.map((beatMs, index) => {
            const beatFrame = frame - msToFrames(enterMs + beatMs, fps);
            return (
              <div
                key={`${beatMs}-${index}`}
                style={{
                  backgroundColor:
                    index === innerBeatsMs.length - 1
                      ? PLUM_NOIR.signalAccent
                      : PLUM_NOIR.secondaryText,
                  height: index === innerBeatsMs.length - 1 ? 14 : 9,
                  opacity: enterOpacity({
                    easing,
                    enterCut: false,
                    enterMs: 140,
                    fps,
                    frame: beatFrame,
                  }),
                  width: index === innerBeatsMs.length - 1 ? 118 : 76,
                }}
              />
            );
          })}
          <div style={{flex: 1}} />
          <SignalRule width={84} />
        </div>
      </Interactive.Div>
    </StageCanvas>
  );
};
