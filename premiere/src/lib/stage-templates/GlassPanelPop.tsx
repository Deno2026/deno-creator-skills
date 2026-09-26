// Recipe basis: stage-recipes.md § T13; board _scratch/reference/2026-09-11_stage-recipes/boards/T13.jpg. Half-frame panel order only; reference glass styling is replaced with matte Plum Noir surfaces and a token-derived soft edge.
import {Interactive, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {StageCanvas} from './StagePrimitives';
import {PLUM_NOIR, STAGE_SAFE_AREA, withAlpha} from './tokens';
import {enterOpacity, exitOpacity, msToFrames, stageEasing} from './timing';
import type {EvidencePanel, HorizontalAnchor, StageEasing} from './types';

export type GlassPanelPopProps = {
  panels: EvidencePanel[];
  anchor?: HorizontalAnchor;
  enterMs?: number;
  staggerMs?: number;
  holdMs?: number;
  easing?: StageEasing;
};

export const GlassPanelPop = ({
  panels,
  anchor = 'right',
  enterMs = 250,
  staggerMs = 500,
  holdMs = 5400,
  easing = 'ease-out',
}: GlassPanelPopProps) => {
  const frame = useCurrentFrame();
  const {durationInFrames, fps} = useVideoConfig();
  const visiblePanels = panels.slice(0, 4);
  const readyMs = enterMs + Math.max(0, visiblePanels.length - 1) * staggerMs;

  return (
    <StageCanvas
      name="Matte evidence panel stack"
      style={{
        opacity: exitOpacity({
          durationInFrames,
          easing,
          exitCut: true,
          exitMs: 0,
          exitStartMs: readyMs + holdMs,
          fps,
          frame,
        }),
        padding: `${STAGE_SAFE_AREA.vertical}px ${STAGE_SAFE_AREA.horizontal}px`,
      }}
    >
      <div
        style={{
          display: 'grid',
          gap: 18,
          gridTemplateColumns: visiblePanels.length > 2 ? '1fr 1fr' : '1fr',
          left: anchor === 'left' ? STAGE_SAFE_AREA.horizontal : undefined,
          position: 'absolute',
          right: anchor === 'right' ? STAGE_SAFE_AREA.horizontal : undefined,
          top: 150,
          width: 820,
        }}
      >
        {visiblePanels.map((panel, index) => {
          const localFrame = frame - msToFrames(index * staggerMs, fps);
          const progress = enterOpacity({
            easing,
            enterCut: false,
            enterMs,
            fps,
            frame: localFrame,
          });
          return (
            <Interactive.Div
              key={`${panel.title}-${index}`}
              name={`Evidence panel ${index + 1}`}
              style={{
                backgroundColor: withAlpha(PLUM_NOIR.primarySurface, 0.94),
                border: `2px solid ${
                  index === 0 ? PLUM_NOIR.plumDetail : PLUM_NOIR.neutralControl
                }`,
                boxShadow: `0 0 44px ${withAlpha(PLUM_NOIR.plumDetail, 0.22)}`,
                minHeight: visiblePanels.length > 2 ? 250 : 330,
                opacity: progress,
                overflow: 'hidden',
                padding: panel.mediaSlot ? 0 : '34px 36px',
                scale: `${interpolate(progress, [0, 1], [0.94, 1], {
                  easing: stageEasing(easing),
                  extrapolateLeft: 'clamp',
                  extrapolateRight: 'clamp',
                })}`,
                translate: `0px ${interpolate(progress, [0, 1], [-24, 0], {
                  easing: stageEasing(easing),
                  extrapolateLeft: 'clamp',
                  extrapolateRight: 'clamp',
                })}px`,
              }}
            >
              {panel.mediaSlot ? (
                panel.mediaSlot
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 18,
                    height: '100%',
                    justifyContent: 'space-between',
                  }}
                >
                  <div
                    style={{
                      color: PLUM_NOIR.secondaryText,
                      fontSize: 28,
                      fontWeight: 680,
                      letterSpacing: 1.1,
                    }}
                  >
                    {panel.title}
                  </div>
                  {panel.value ? (
                    <div
                      style={{
                        color: index === 0 ? PLUM_NOIR.signalAccent : PLUM_NOIR.warmText,
                        fontSize: visiblePanels.length > 2 ? 52 : 72,
                        fontVariantNumeric: 'tabular-nums',
                        fontWeight: 800,
                        lineHeight: 1,
                      }}
                    >
                      {panel.value}
                    </div>
                  ) : null}
                  {panel.detail ? (
                    <div
                      style={{
                        color: PLUM_NOIR.primaryText,
                        fontSize: 30,
                        fontWeight: 500,
                        lineHeight: 1.25,
                      }}
                    >
                      {panel.detail}
                    </div>
                  ) : null}
                </div>
              )}
            </Interactive.Div>
          );
        })}
      </div>
    </StageCanvas>
  );
};
