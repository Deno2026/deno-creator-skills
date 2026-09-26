// Recipe basis: stage-recipes.md § T2; board _scratch/reference/2026-09-11_stage-recipes/boards/T02.jpg. Timing and empty-side stacking only; reference color, type, logo, and copy are excluded.
import {Interactive, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {SignalRule, StageCanvas} from './StagePrimitives';
import {PLUM_NOIR, STAGE_SAFE_AREA} from './tokens';
import {enterOpacity, exitOpacity, msToFrames, stageEasing} from './timing';
import type {CalloutAnchor, StageEasing} from './types';

export type PresenterCalloutStackProps = {
  items: string[];
  anchor?: CalloutAnchor;
  enterMode?: 'typewriter' | 'pop' | 'fade';
  enterMs?: number;
  staggerMs?: number;
  holdMs?: number;
  exitMode?: 'cut' | 'fade';
  exitMs?: number;
  easing?: StageEasing;
};

export const computePresenterCalloutHoldMs = (items: string[]) => {
  const characterCount = items.reduce((total, item) => total + item.trim().length, 0);
  return Math.max(1500, 900 + items.length * 420 + characterCount * 28);
};

export const PresenterCalloutStack = ({
  items,
  anchor = 'right',
  enterMode = 'typewriter',
  enterMs = 250,
  staggerMs = 560,
  holdMs,
  exitMode = 'cut',
  exitMs = 250,
  easing = 'ease-out',
}: PresenterCalloutStackProps) => {
  const frame = useCurrentFrame();
  const {durationInFrames, fps} = useVideoConfig();
  const resolvedItems = items.filter((item) => item.trim().length > 0);
  const resolvedHoldMs = holdMs ?? computePresenterCalloutHoldMs(resolvedItems);
  const finalItemReadyMs = Math.max(0, resolvedItems.length - 1) * staggerMs + enterMs;
  const stackWidth = anchor === 'lower' ? 1320 : 720;

  return (
    <StageCanvas
      name="Presenter callout stack"
      style={{
        alignItems: anchor === 'lower' ? 'center' : 'flex-start',
        display: 'flex',
        justifyContent:
          anchor === 'left' ? 'flex-start' : anchor === 'right' ? 'flex-end' : 'center',
        opacity: exitOpacity({
          durationInFrames,
          easing,
          exitCut: exitMode === 'cut',
          exitMs,
          exitStartMs: finalItemReadyMs + resolvedHoldMs,
          fps,
          frame,
        }),
        padding: `${STAGE_SAFE_AREA.vertical}px ${STAGE_SAFE_AREA.horizontal}px`,
      }}
    >
      <div
        style={{
          alignSelf: anchor === 'lower' ? 'flex-end' : 'center',
          display: 'flex',
          flexDirection: anchor === 'lower' ? 'row' : 'column',
          flexWrap: anchor === 'lower' ? 'wrap' : 'nowrap',
          gap: anchor === 'lower' ? 18 : 22,
          justifyContent: anchor === 'lower' ? 'center' : 'flex-start',
          width: stackWidth,
        }}
      >
        {resolvedItems.map((item, index) => {
          const localFrame = frame - msToFrames(index * staggerMs, fps);
          const progress = enterOpacity({
            easing,
            enterCut: false,
            enterMs,
            fps,
            frame: localFrame,
          });
          const visibleCharacters = Math.ceil(item.length * progress);
          return (
            <Interactive.Div
              key={`${item}-${index}`}
              name={`Callout ${index + 1}`}
              style={{
                alignItems: 'center',
                backgroundColor: PLUM_NOIR.primarySurface,
                border: `2px solid ${
                  index === 0 ? PLUM_NOIR.signalAccent : PLUM_NOIR.plumDetail
                }`,
                display: 'flex',
                gap: 18,
                minHeight: 92,
                opacity: enterMode === 'typewriter' ? (localFrame > 0 ? 1 : 0) : progress,
                padding: '18px 28px',
                scale:
                  enterMode === 'pop'
                    ? `${interpolate(progress, [0, 1], [0.88, 1], {
                        easing: stageEasing(easing),
                        extrapolateLeft: 'clamp',
                        extrapolateRight: 'clamp',
                      })}`
                    : '1',
                translate:
                  enterMode === 'fade'
                    ? `${interpolate(progress, [0, 1], [22, 0], {
                        easing: stageEasing(easing),
                        extrapolateLeft: 'clamp',
                        extrapolateRight: 'clamp',
                      })}px 0px`
                    : '0px 0px',
              }}
            >
              <div
                style={{
                  color: PLUM_NOIR.secondaryText,
                  fontSize: 28,
                  fontVariantNumeric: 'tabular-nums',
                  fontWeight: 700,
                  minWidth: 44,
                }}
              >
                {String(index + 1).padStart(2, '0')}
              </div>
              <div
                style={{
                  color: PLUM_NOIR.warmText,
                  fontSize: 46,
                  fontWeight: 760,
                  letterSpacing: -1.4,
                  lineHeight: 1.12,
                }}
              >
                {enterMode === 'typewriter' ? item.slice(0, visibleCharacters) : item}
              </div>
            </Interactive.Div>
          );
        })}
        <SignalRule width={anchor === 'lower' ? 168 : 112} />
      </div>
    </StageCanvas>
  );
};
