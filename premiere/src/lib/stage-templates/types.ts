import type {ReactNode} from 'react';

export type StageEasing = 'ease-out' | 'linear';
export type HorizontalAnchor = 'left' | 'right';
export type CalloutAnchor = HorizontalAnchor | 'lower';

export type StageRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type StageSlot = ReactNode;

export type EvidencePanel = {
  title: string;
  value?: string;
  detail?: string;
  mediaSlot?: StageSlot;
};
