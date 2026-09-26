import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

const colors = {
  ink: '#F4F1EA',
  muted: '#AAA69C',
  surface: '#11120F',
  accent: '#D7FF48',
};

export const WorkspaceBootstrap = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const reveal = spring({
    fps,
    frame,
    config: {damping: 18, mass: 0.7, stiffness: 120},
  });
  const lineWidth = interpolate(frame, [8, 44], [0, 520], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        backgroundColor: colors.surface,
        color: colors.ink,
        display: 'flex',
        fontFamily: 'Arial, sans-serif',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          opacity: reveal,
          transform: `translateY(${(1 - reveal) * 28}px)`,
          width: 760,
        }}
      >
        <div
          style={{
            color: colors.accent,
            fontSize: 22,
            fontWeight: 800,
            letterSpacing: 5,
            marginBottom: 24,
          }}
        >
          DENO VIDEO WORKSPACE
        </div>
        <div style={{fontSize: 76, fontWeight: 800, lineHeight: 1.02}}>
          PremierePro Helper
        </div>
        <div
          style={{
            backgroundColor: colors.accent,
            height: 6,
            marginTop: 32,
            width: lineWidth,
          }}
        />
        <div
          style={{
            color: colors.muted,
            fontSize: 28,
            letterSpacing: 1,
            marginTop: 28,
          }}
        >
          No active production · ready for a new brief
        </div>
      </div>
    </AbsoluteFill>
  );
};
