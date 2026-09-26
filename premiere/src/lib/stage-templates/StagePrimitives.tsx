import type {CSSProperties, ReactNode} from 'react';
import {AbsoluteFill, Interactive} from 'remotion';
import {PLUM_NOIR, STAGE_FONT_FAMILY, withAlpha} from './tokens';

export const StageCanvas = ({
  children,
  name,
  style,
}: {
  children?: ReactNode;
  name: string;
  style?: CSSProperties;
}) => (
  <Interactive.Div
    name={name}
    style={{
      bottom: 0,
      boxSizing: 'border-box',
      color: PLUM_NOIR.primaryText,
      fontFamily: STAGE_FONT_FAMILY,
      left: 0,
      overflow: 'hidden',
      position: 'absolute',
      right: 0,
      top: 0,
      ...style,
    }}
  >
    {children}
  </Interactive.Div>
);

export const SlotFrame = ({
  children,
  label,
  compact = false,
}: {
  children?: ReactNode;
  label: string;
  compact?: boolean;
}) => (
  <div
    style={{
      alignItems: 'center',
      backgroundColor: PLUM_NOIR.primarySurface,
      border: `2px solid ${PLUM_NOIR.plumDetail}`,
      boxShadow: `0 20px 50px ${withAlpha(PLUM_NOIR.deepBackground, 0.46)}`,
      display: 'flex',
      height: '100%',
      justifyContent: 'center',
      overflow: 'hidden',
      position: 'relative',
      width: '100%',
    }}
  >
    {children ?? (
      <>
        <AbsoluteFill style={{display: 'flex', flexDirection: 'row', opacity: 0.34}}>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div
              key={index}
              style={{
                backgroundColor:
                  index % 2 === 0
                    ? PLUM_NOIR.raisedSurface
                    : PLUM_NOIR.primarySurface,
                flex: 1,
              }}
            />
          ))}
        </AbsoluteFill>
        <div
          style={{
            color: PLUM_NOIR.secondaryText,
            fontSize: compact ? 28 : 38,
            fontWeight: 650,
            letterSpacing: compact ? 1 : 2,
            position: 'relative',
          }}
        >
          {label}
        </div>
      </>
    )}
  </div>
);

export const SignalRule = ({width = 96}: {width?: number}) => (
  <div
    style={{
      backgroundColor: PLUM_NOIR.signalAccent,
      height: 5,
      width,
    }}
  />
);
