import {Audio, Video} from '@remotion/media';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type {OverlaySegmentProps} from './types';

const fallbackAccent = '#D7FF48';

export const OverlaySegmentComposition = ({
  production,
  renderMode,
  segment,
}: OverlaySegmentProps) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const enterEnd = Math.min(8, Math.max(2, Math.floor(durationInFrames / 4)));
  const exitStart = Math.max(
    enterEnd + 1,
    durationInFrames - enterEnd - 1,
  );
  const accent = segment.accentColor ?? fallbackAccent;

  return (
    <AbsoluteFill style={{backgroundColor: 'transparent'}}>
      {renderMode === 'review' ? (
        <AbsoluteFill
          style={{
            background:
              'radial-gradient(circle at 74% 22%, #2B2D24 0%, #151611 44%, #090A08 100%)',
          }}
        >
          {segment.reviewBackground ? (
            <Video
              muted
              objectFit="cover"
              src={staticFile(segment.reviewBackground)}
              style={{height: '100%', width: '100%'}}
            />
          ) : null}
          {segment.reviewAudio ? (
            <Audio src={staticFile(segment.reviewAudio)} />
          ) : null}
        </AbsoluteFill>
      ) : null}

      <AbsoluteFill
        style={{
          backgroundColor: 'rgba(10, 11, 9, 0.94)',
          opacity: interpolate(
            frame,
            [0, enterEnd, exitStart, durationInFrames - 1],
            [0, 1, 1, 0],
            {
              easing: Easing.bezier(0.16, 1, 0.3, 1),
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            },
          ),
        }}
      />

      <AbsoluteFill
        style={{
          alignItems: 'center',
          color: '#F4F1EA',
          display: 'flex',
          fontFamily: 'Arial, sans-serif',
          justifyContent: 'center',
          opacity: interpolate(
            frame,
            [0, enterEnd, exitStart, durationInFrames - 1],
            [0, 1, 1, 0],
            {
              easing: Easing.bezier(0.16, 1, 0.3, 1),
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            },
          ),
          padding: '100px 120px',
          transform: `translateY(${interpolate(frame, [0, enterEnd], [28, 0], {
            easing: Easing.bezier(0.16, 1, 0.3, 1),
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          })}px)`,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 30,
            maxWidth: 1320,
            width: '100%',
          }}
        >
          <div
            style={{
              color: accent,
              fontSize: 32,
              fontWeight: 800,
              letterSpacing: 5,
              textTransform: 'uppercase',
            }}
          >
            {segment.eyebrow ?? production}
          </div>
          <div
            style={{
              fontSize: 112,
              fontWeight: 850,
              letterSpacing: -4,
              lineHeight: 0.98,
              maxWidth: 1260,
            }}
          >
            {segment.title}
          </div>
          <div
            style={{
              backgroundColor: accent,
              height: 8,
              width: interpolate(frame, [enterEnd, enterEnd + 20], [0, 620], {
                easing: Easing.out(Easing.cubic),
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              }),
            }}
          />
          <div
            style={{
              color: '#B9B8AF',
              fontSize: 46,
              fontWeight: 500,
              lineHeight: 1.25,
              maxWidth: 1120,
            }}
          >
            {segment.message}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
