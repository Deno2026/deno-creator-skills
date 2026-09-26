import {Composition} from 'remotion';
import {makeOverlaySegmentProps} from './lib/overlay';
import {productionRegistry} from './productions/registry';
import {WorkspaceBootstrap} from './templates/WorkspaceBootstrap';

export const Root = () => {
  const registeredIds = new Set<string>(['WorkspaceBootstrap']);

  return (
    <>
      <Composition
        id="WorkspaceBootstrap"
        component={WorkspaceBootstrap}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={90}
      />
      {productionRegistry.flatMap((production) =>
        production.plan.segments.map((segment) => {
          if (registeredIds.has(segment.compositionId)) {
            throw new Error(
              `Duplicate Remotion composition id: ${segment.compositionId}`,
            );
          }
          registeredIds.add(segment.compositionId);
          const ProductionComponent = production.component;
          return (
            <Composition
              key={segment.compositionId}
              id={segment.compositionId}
              component={ProductionComponent}
              width={production.plan.width}
              height={production.plan.height}
              fps={production.plan.fps}
              durationInFrames={segment.durationInFrames}
              defaultProps={makeOverlaySegmentProps(production.plan, segment)}
            />
          );
        }),
      )}
    </>
  );
};
