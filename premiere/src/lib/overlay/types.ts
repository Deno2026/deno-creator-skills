import type {ComponentType} from 'react';

export type OverlayRenderMode = 'review' | 'alpha';

export type OverlaySegmentPlan = {
  id: string;
  compositionId: string;
  startFrame: number;
  durationInFrames: number;
  eyebrow?: string;
  title: string;
  message: string;
  accentColor?: string;
  reviewBackground?: string | null;
  reviewAudio?: string | null;
};

export type OverlayProductionPlan = {
  schemaVersion: 1;
  production: string;
  scaffoldOnly?: boolean;
  width: number;
  height: number;
  fps: number;
  segments: OverlaySegmentPlan[];
};

export type OverlaySegmentProps = {
  production: string;
  renderMode: OverlayRenderMode;
  segment: OverlaySegmentPlan;
};

export type OverlayProductionDefinition = {
  plan: OverlayProductionPlan;
  component: ComponentType<OverlaySegmentProps>;
};
