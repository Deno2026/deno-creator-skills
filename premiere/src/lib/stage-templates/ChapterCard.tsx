// Recipe basis: stage-recipes.md § T15; boards _scratch/reference/2026-09-11_stage-recipes/boards/T15.jpg plus T07.jpg and T08.jpg. T7 part and T8 timejump remain reference-sample variants, not promoted channel rules; all reference color, type, logo, and copy are excluded.
import {Interactive, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {SignalRule, StageCanvas} from './StagePrimitives';
import {PLUM_NOIR, STAGE_SAFE_AREA, withAlpha} from './tokens';
import {enterOpacity, exitOpacity, msToFrames, stageEasing} from './timing';
import type {StageEasing} from './types';

export type ChapterCardVariant = 'level' | 'part' | 'timejump';

export type ChapterCardProps = {
  title: string;
  subtitle?: string;
  variant?: ChapterCardVariant;
  titleAssembleMs?: number;
  subtitleDelayMs?: number;
  subtitleMs?: number;
  holdMs?: number;
  exitCut?: boolean;
  exitMs?: number;
  easing?: StageEasing;
};

export const ChapterCard = ({
  title,
  subtitle,
  variant = 'level',
  titleAssembleMs = 500,
  subtitleDelayMs = 1475,
  subtitleMs = 500,
  holdMs = 3200,
  exitCut = true,
  exitMs = 0,
  easing = 'ease-out',
}: ChapterCardProps) => {
  const frame = useCurrentFrame();
  const {durationInFrames, fps} = useVideoConfig();
  const titleProgress = enterOpacity({
    easing,
    enterCut: false,
    enterMs: titleAssembleMs,
    fps,
    frame,
  });
  const subtitleFrame = frame - msToFrames(subtitleDelayMs, fps);
  const subtitleProgress = subtitle
    ? enterOpacity({
        easing,
        enterCut: false,
        enterMs: subtitleMs,
        fps,
        frame: subtitleFrame,
      })
    : 1;
  const readyMs = subtitle
    ? Math.max(titleAssembleMs, subtitleDelayMs + subtitleMs)
    : titleAssembleMs;
  const variantLabel =
    variant === 'timejump' ? 'TIME' : variant === 'part' ? 'PART' : 'LEVEL';

  return (
    <StageCanvas
      name={`Chapter card ${variant}`}
      style={{
        backgroundColor: PLUM_NOIR.deepBackground,
        opacity: exitOpacity({
          durationInFrames,
          easing,
          exitCut,
          exitMs,
          exitStartMs: readyMs + Math.max(3000, holdMs),
          fps,
          frame,
        }),
      }}
    >
      <div
        style={{
          backgroundColor: PLUM_NOIR.primarySurface,
          bottom: 0,
          clipPath:
            variant === 'timejump'
              ? 'polygon(0 0, 88% 0, 74% 100%, 0 100%)'
              : 'polygon(0 0, 100% 0, 88% 100%, 0 100%)',
          left: 0,
          opacity: titleProgress,
          position: 'absolute',
          top: 0,
          width: variant === 'part' ? '52%' : '44%',
        }}
      />
      <div
        style={{
          backgroundColor: withAlpha(PLUM_NOIR.raisedSurface, 0.72),
          bottom: 0,
          left: variant === 'part' ? '46%' : '38%',
          opacity: titleProgress,
          position: 'absolute',
          top: 0,
          translate: `${interpolate(titleProgress, [0, 1], [-130, 0], {
            easing: stageEasing(easing),
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          })}px 0px`,
          width: '22%',
        }}
      />
      <Interactive.Div
        name="Chapter title"
        style={{
          left: STAGE_SAFE_AREA.horizontal + 50,
          opacity: titleProgress,
          position: 'absolute',
          top: variant === 'timejump' ? 300 : 250,
          translate: `0px ${interpolate(titleProgress, [0, 1], [44, 0], {
            easing: stageEasing(easing),
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          })}px`,
          width: 1480,
        }}
      >
        <div
          style={{
            color: PLUM_NOIR.secondaryText,
            fontSize: 30,
            fontWeight: 740,
            letterSpacing: 6,
            marginBottom: 22,
          }}
        >
          {variantLabel}
        </div>
        <div
          style={{
            color: PLUM_NOIR.warmText,
            fontSize: variant === 'timejump' ? 126 : 138,
            fontVariantNumeric: 'tabular-nums',
            fontWeight: 850,
            letterSpacing: -4,
            lineHeight: 0.98,
            maxWidth: 1540,
          }}
        >
          {title}
        </div>
        <div style={{marginTop: 34}}>
          <SignalRule width={variant === 'timejump' ? 250 : 156} />
        </div>
        {subtitle ? (
          <div
            style={{
              color: PLUM_NOIR.primaryText,
              fontSize: 48,
              fontWeight: 560,
              letterSpacing: -1.2,
              lineHeight: 1.22,
              marginTop: 30,
              opacity: subtitleProgress,
              translate: `${interpolate(subtitleProgress, [0, 1], [36, 0], {
                easing: stageEasing(easing),
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              })}px 0px`,
            }}
          >
            {subtitle}
          </div>
        ) : null}
      </Interactive.Div>
    </StageCanvas>
  );
};
