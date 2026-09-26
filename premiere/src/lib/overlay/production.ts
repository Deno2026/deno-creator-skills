import type {
  OverlayProductionDefinition,
  OverlayProductionPlan,
  OverlaySegmentProps,
} from './types';

export const defineOverlayProduction = (
  plan: OverlayProductionPlan,
  component: OverlayProductionDefinition['component'],
): OverlayProductionDefinition => ({component, plan});

export const makeOverlaySegmentProps = (
  plan: OverlayProductionPlan,
  segment: OverlayProductionPlan['segments'][number],
): OverlaySegmentProps => ({
  production: plan.production,
  renderMode: 'review',
  segment,
});
