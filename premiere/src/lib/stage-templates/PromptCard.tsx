// Recipe basis: stage-recipes.md § T12 and phase-B2 PromptCard note; board _scratch/reference/2026-09-11_stage-recipes/boards/T12.jpg. Two-column reading order and measured name typing only; reference copy, media, logo, and palette are excluded.
import {Interactive, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {SignalRule, StageCanvas} from './StagePrimitives';
import {PLUM_NOIR, STAGE_SAFE_AREA, withAlpha} from './tokens';
import {enterOpacity, exitOpacity, msToFrames, stageEasing} from './timing';
import type {StageEasing, StageSlot} from './types';

export type PromptCardProps = {
  promptText: string;
  resultImageSlot?: StageSlot;
  nameLabel: string;
  enterCut?: boolean;
  enterMs?: number;
  nameTypeDelayMs?: number;
  nameTypeMs?: number;
  holdMs?: number;
  exitMs?: number;
  easing?: StageEasing;
};

export const PromptCard = ({
  promptText,
  resultImageSlot,
  nameLabel,
  enterCut = true,
  enterMs = 375,
  nameTypeDelayMs = 400,
  nameTypeMs = 375,
  holdMs = 4250,
  exitMs = 190,
  easing = 'ease-out',
}: PromptCardProps) => {
  const frame = useCurrentFrame();
  const {durationInFrames, fps} = useVideoConfig();
  const entryProgress = enterOpacity({
    easing,
    enterCut,
    enterMs: enterCut ? 0 : enterMs,
    fps,
    frame,
  });
  const nameLocalFrame = frame - msToFrames(nameTypeDelayMs, fps);
  const nameProgress = enterOpacity({
    easing: 'linear',
    enterCut: false,
    enterMs: nameTypeMs,
    fps,
    frame: nameLocalFrame,
  });
  const contentReadyMs = Math.max(enterCut ? 0 : enterMs, nameTypeDelayMs + nameTypeMs);
  const visibleName = nameLabel.slice(0, Math.ceil(nameLabel.length * nameProgress));

  return (
    <StageCanvas
      name="Prompt card"
      style={{
        alignItems: 'center',
        display: 'flex',
        justifyContent: 'center',
        opacity: exitOpacity({
          durationInFrames,
          easing,
          exitCut: false,
          exitMs,
          exitStartMs: contentReadyMs + holdMs,
          fps,
          frame,
        }),
        padding: `${STAGE_SAFE_AREA.vertical}px ${STAGE_SAFE_AREA.horizontal}px`,
      }}
    >
      <Interactive.Div
        name="Prompt reading card"
        style={{
          backgroundColor: PLUM_NOIR.primarySurface,
          border: `2px solid ${PLUM_NOIR.plumDetail}`,
          boxShadow: `0 32px 84px ${withAlpha(PLUM_NOIR.deepBackground, 0.62)}`,
          display: 'grid',
          gridTemplateColumns: resultImageSlot ? '1.2fr 0.8fr' : '1fr',
          height: 820,
          opacity: entryProgress,
          overflow: 'hidden',
          scale: enterCut
            ? '1'
            : `${interpolate(entryProgress, [0, 1], [0.98, 1], {
                easing: stageEasing(easing),
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              })}`,
          width: 1680,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 36,
            justifyContent: 'space-between',
            padding: '72px 68px 64px',
          }}
        >
          <div>
            <div
              style={{
                color: PLUM_NOIR.signalAccent,
                fontSize: 30,
                fontWeight: 760,
                letterSpacing: 3,
                marginBottom: 30,
              }}
            >
              PROMPT
            </div>
            <div
              style={{
                color: PLUM_NOIR.warmText,
                fontSize: resultImageSlot ? 42 : 48,
                fontWeight: 520,
                letterSpacing: -0.8,
                lineHeight: 1.42,
                whiteSpace: 'pre-wrap',
              }}
            >
              {promptText}
            </div>
          </div>
          <div>
            <SignalRule width={132} />
            <div
              style={{
                color: PLUM_NOIR.secondaryText,
                fontSize: 32,
                fontWeight: 700,
                letterSpacing: 1.4,
                marginTop: 20,
                minHeight: 46,
              }}
            >
              {visibleName}
            </div>
          </div>
        </div>
        {resultImageSlot ? (
          <Interactive.Div
            name="Prompt result image slot"
            style={{
              borderLeft: `2px solid ${PLUM_NOIR.neutralControl}`,
              overflow: 'hidden',
            }}
          >
            {resultImageSlot}
          </Interactive.Div>
        ) : null}
      </Interactive.Div>
    </StageCanvas>
  );
};
