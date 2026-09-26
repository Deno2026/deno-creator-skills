import type {OverlayProductionDefinition} from '../lib/overlay';

// 영상별 Remotion source 등록부. `npm run production:new -- <slug>`가 아래 표식 자리에 import와 항목을 넣는다.
// 키트에는 작품이 없으므로 비어 있다.
// DENO_PRODUCTION_IMPORTS

export const productionRegistry: readonly OverlayProductionDefinition[] = [
  // DENO_PRODUCTION_ENTRIES
];
