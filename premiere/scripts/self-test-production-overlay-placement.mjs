import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {buildProductionSourceBundle} from './render-production-overlays.mjs';
import {
  buildProductionOverlayPlacement,
  sha256File,
} from './lib/production-overlay-placement.mjs';
import {
  buildPremierePlacementInputs,
  writePremierePlacementInputsAtomically,
} from './lib/premiere-placement-inputs.mjs';
import {sha256PremiereSequenceFingerprint} from './lib/premiere-sequence-fingerprint.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));

const json = (filePath, value) => {
  mkdirSync(path.dirname(filePath), {recursive: true});
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const text = (filePath, value) => {
  mkdirSync(path.dirname(filePath), {recursive: true});
  writeFileSync(filePath, value, 'utf8');
};

const buildFileBundle = (repoRoot, files) => {
  const entries = [...files]
    .map((file) => path.resolve(file))
    .sort((left, right) => left.localeCompare(right))
    .map((file) => ({
      path: path.relative(repoRoot, file).split(path.sep).join('/'),
      sha256: sha256File(file),
    }));
  const aggregate = createHash('sha256');
  for (const entry of entries) {
    aggregate.update(entry.path);
    aggregate.update('\0');
    aggregate.update(entry.sha256);
    aggregate.update('\n');
  }
  return {files: entries, sha256: aggregate.digest('hex').toUpperCase()};
};

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'production-overlay-placement-'));
const production = 'placement-test';
const generation = 'approved-r1';
const planPath = path.join(
  fixtureRoot,
  'productions',
  production,
  'plans',
  'overlay-plan.json',
);
const alphaRoot = path.join(fixtureRoot, 'renders', production, generation, 'alpha');
const reviewRoot = path.join(fixtureRoot, 'renders', production, generation, 'review');
const alphaManifestPath = path.join(alphaRoot, 'render-manifest.json');
const reviewManifestPath = path.join(reviewRoot, 'render-manifest.json');
const captureDir = path.join(fixtureRoot, 'tmp', 'capture');
const outputManifestPath = path.join(
  fixtureRoot,
  'productions',
  production,
  'placements',
  `${generation}.json`,
);

const plan = {
  schemaVersion: 1,
  production,
  width: 1920,
  height: 1080,
  fps: 30,
  segments: [
    {
      id: 'segment-01',
      compositionId: `${production}-segment-01`,
      startFrame: 300,
      durationInFrames: 60,
      title: '인트로 뒤 첫 모션',
      message: '원래 절대 타임라인 위치를 유지한다.',
      accentColor: '#D7FF48',
      reviewBackground: 'placement-test/review-bg.png',
      reviewAudio: 'placement-test/review-audio.wav',
    },
    {
      id: 'segment-02',
      compositionId: `${production}-segment-02`,
      startFrame: 450,
      durationInFrames: 30,
      title: '둘째 모션',
      message: '첫 모션과 겹치지 않는다.',
      accentColor: '#66CCFF',
      reviewBackground: 'placement-test/review-bg.png',
      reviewAudio: 'placement-test/review-audio.wav',
    },
  ],
};

const clip = (name, startSeconds, endSeconds, index) => ({
  index,
  nodeId: `${name}-${index}`,
  name,
  startSeconds,
  endSeconds,
  durationSeconds: endSeconds - startSeconds,
  inPointSeconds: 0,
  outPointSeconds: endSeconds - startSeconds,
  mediaType: 'Video',
  enabled: true,
  speed: 1,
});

const captureBase = {
  project: {
    name: 'channel-edit.prproj',
    path: 'E:\\Projects\\channel-edit.prproj',
    id: 'project-1',
    activeSequence: {name: '유튜브 메인 30fps', id: 'sequence-30'},
  },
  settings: {
    name: '유튜브 메인 30fps',
    id: 'sequence-30',
    frameRate: 30,
    ticksPerFrame: 8467200000,
    timebase: '8467200000',
    videoDisplayFormat: 4,
  },
  structure: {
    name: '유튜브 메인 30fps',
    id: 'sequence-30',
    durationSeconds: 20,
    videoTrackCount: 3,
    audioTrackCount: 2,
    videoTracks: [
      {index: 0, name: 'Intro', clipCount: 1, clips: [clip('intro.mov', 0, 2, 0)], isMuted: false, isLocked: null},
      {
        index: 1,
        name: 'Cut recording',
        clipCount: 3,
        clips: [
          clip('recording.mp4', 2, 7, 0),
          clip('recording.mp4', 7, 12, 1),
          clip('recording.mp4', 12, 20, 2),
        ],
        isMuted: false,
        isLocked: null,
      },
      {index: 2, name: 'Overlay', clipCount: 0, clips: [], isMuted: false, isLocked: null},
    ],
    audioTracks: [
      {index: 0, name: 'Intro A', clipCount: 1, clips: [{...clip('intro.wav', 0, 2, 0), mediaType: 'Audio'}], isMuted: false, isLocked: null},
      {
        index: 1,
        name: 'Cut recording A',
        clipCount: 3,
        clips: [
          {...clip('recording.mp4', 2, 7, 0), mediaType: 'Audio'},
          {...clip('recording.mp4', 7, 12, 1), mediaType: 'Audio'},
          {...clip('recording.mp4', 12, 20, 2), mediaType: 'Audio'},
        ],
        isMuted: false,
        isLocked: null,
      },
    ],
  },
};

const writeCapture = (mutate = null) => {
  const capture = clone(captureBase);
  if (mutate) mutate(capture);
  const bundle = buildPremierePlacementInputs({
    firstCapture: clone(capture),
    secondCapture: clone(capture),
    generatedAt: '2026-08-28T10:00:00.000Z',
  });
  rmSync(captureDir, {recursive: true, force: true});
  writePremierePlacementInputsAtomically({outDir: captureDir, bundle});
  return bundle;
};

const writeRenderManifests = ({
  alphaOverrides = {},
  outputOverrides = {},
  planValue = plan,
  reviewOverrides = {},
} = {}) => {
  json(planPath, planValue);
  const planSha256 = sha256File(planPath);
  const sourceBundle = buildProductionSourceBundle({repoRoot: fixtureRoot, production});
  const reviewAssetBundle = buildFileBundle(fixtureRoot, [
    path.join(fixtureRoot, 'assets', production, 'review-audio.wav'),
    path.join(fixtureRoot, 'assets', production, 'review-bg.png'),
  ]);
  const outputFor = (segment) => {
    const filePath = path.join(alphaRoot, `${segment.id}-overlay.mov`);
    return {
      audioStreamCount: 0,
      boundaryAlphaYMax: [256, 256],
      bytes: statSync(filePath).size,
      codec: 'prores',
      compositionId: segment.compositionId,
      durationSeconds: segment.durationInFrames / planValue.fps,
      fps: planValue.fps,
      frames: segment.durationInFrames,
      path: path.relative(fixtureRoot, filePath).split(path.sep).join('/'),
      pixelFormat: 'yuva444p10le',
      profile: '4444',
      segmentId: segment.id,
      sha256: sha256File(filePath),
      startFrame: segment.startFrame,
      ...outputOverrides[segment.id],
    };
  };
  const alphaOutputs = planValue.segments.map(outputFor);
  const reviewOutputs = alphaOutputs.map((output) => ({
    ...output,
    audioStreamCount: 1,
    codec: 'h264',
    path: `renders/${production}/${generation}/review/${output.segmentId}-review.mp4`,
    pixelFormat: 'yuv420p',
    profile: 'High',
  }));
  const common = {
    schemaVersion: 1,
    generatedAt: '2026-08-28T09:00:00.000Z',
    generation,
    plan: `productions/${production}/plans/overlay-plan.json`,
    planSha256,
    production,
    sourceBundle,
  };
  json(reviewManifestPath, {
    ...common,
    mode: 'review',
    outputs: reviewOutputs,
    reviewAssetBundle,
    renderer: {placeholderReview: false},
    ...reviewOverrides,
  });
  json(alphaManifestPath, {
    ...common,
    mode: 'alpha',
    outputs: alphaOutputs,
    reviewAssetBundle: null,
    renderer: {
      reviewParityPolicy: `matched ${generation}/review plan + source bundle`,
      alphaAudioPolicy: 'video-stream-only remux with -an; verified zero audio streams',
    },
    ...alphaOverrides,
  });
};

const probeOverlay = (filePath) => {
  const segment = plan.segments.find(({id}) => filePath.endsWith(`${id}-overlay.mov`));
  assert.ok(segment, `unknown mock overlay ${filePath}`);
  return {
    audioStreamCount: 0,
    bytes: statSync(filePath).size,
    codec: 'prores',
    fps: 30,
    frames: segment.durationInFrames,
    height: 1080,
    pixelFormat: 'yuva444p10le',
    profile: '4444',
    width: 1920,
  };
};

const build = (overrides = {}) => buildProductionOverlayPlacement({
  alphaManifestPath,
  captureDir,
  expectedGeneration: generation,
  expectedProduction: production,
  outputManifestPath,
  probeOverlay,
  repoRoot: fixtureRoot,
  targetVideoTrackIndex: 2,
  ...overrides,
});

try {
  for (const file of [
    'src/index.ts',
    'src/Root.tsx',
    'src/productions/registry.tsx',
    'src/lib/overlay/index.ts',
    `src/productions/${production}/index.tsx`,
  ]) {
    text(path.join(fixtureRoot, file), `// ${file}\n`);
  }
  text(path.join(fixtureRoot, 'assets', production, 'review-bg.png'), 'review-background');
  text(path.join(fixtureRoot, 'assets', production, 'review-audio.wav'), 'review-audio');
  text(path.join(alphaRoot, 'segment-01-overlay.mov'), 'alpha-segment-01');
  text(path.join(alphaRoot, 'segment-02-overlay.mov'), 'alpha-segment-02');
  const baselineCapture = writeCapture();
  writeRenderManifests();

  const result = build();
  assert.deepEqual(Object.keys(result.manifest), [
    'schemaVersion',
    'projectCheck',
    'sequenceCheck',
    'timingCheck',
    'captureCheck',
    'items',
  ]);
  assert.deepEqual(result.manifest.sequenceCheck, {
    name: baselineCapture.live.sequenceName,
    id: baselineCapture.live.sequenceId,
    durationSeconds: baselineCapture.live.sequenceDurationSeconds,
    durationFrames: baselineCapture.live.sequenceDurationSeconds * baselineCapture.live.fps,
    structureSha256: sha256PremiereSequenceFingerprint(
      baselineCapture.rawStructure,
      baselineCapture.live.fps,
    ),
  });
  assert.equal(result.manifest.projectCheck.path, baselineCapture.live.projectPath);
  assert.equal(result.manifest.timingCheck.ticksPerFrame, baselineCapture.live.ticksPerFrame);
  assert.equal(
    result.manifest.captureCheck.bundleSha256,
    JSON.parse(readFileSync(path.join(captureDir, 'live.json'), 'utf8')).bundleSha256,
  );
  assert.equal(result.manifest.items.length, 2);
  assert.equal(result.manifest.items[0].track_index, 2);
  assert.equal(result.manifest.items[1].track_index, 2);
  assert.equal(result.manifest.items[0].start_seconds, 10);
  assert.equal(result.manifest.items[1].start_seconds, 15);
  assert.match(result.manifest.items[0].file, /segment-01-overlay\.mov$/);
  assert.equal(result.identity.fps, 30);
  assert.equal(result.identity.ticksPerFrame, '8467200000');
  assert.equal(result.capture.kind, 'full-sequence-double-capture');
  assert.equal(result.manifest.captureCheck.source, 'premiere-uxp-read-only-placement-capture');
  assert.equal(result.manifest.captureCheck.structureSha256, baselineCapture.structureSha256);

  const baseAlpha = readFileSync(alphaManifestPath, 'utf8');
  const baseReview = readFileSync(reviewManifestPath, 'utf8');
  const basePlan = readFileSync(planPath, 'utf8');

  const restore = () => {
    writeFileSync(alphaManifestPath, baseAlpha, 'utf8');
    writeFileSync(reviewManifestPath, baseReview, 'utf8');
    writeFileSync(planPath, basePlan, 'utf8');
    writeCapture();
  };

  try {
    const staleGeneration = JSON.parse(baseAlpha);
    staleGeneration.generation = 'approved-r2';
    json(alphaManifestPath, staleGeneration);
    assert.throws(() => build(), /mode\/production\/generation/);
  } finally { restore(); }

  try {
    const staleSource = JSON.parse(baseAlpha);
    staleSource.sourceBundle.sha256 = '0'.repeat(64);
    json(alphaManifestPath, staleSource);
    assert.throws(() => build(), /source bundle/);
  } finally { restore(); }

  try {
    const staleHash = JSON.parse(baseAlpha);
    staleHash.outputs[0].sha256 = '0'.repeat(64);
    json(alphaManifestPath, staleHash);
    assert.throws(() => build(), /output hash/);
  } finally { restore(); }

  try {
    const bypass = JSON.parse(baseAlpha);
    bypass.renderer.reviewParityPolicy = 'smoke-only bypass';
    json(alphaManifestPath, bypass);
    assert.throws(() => build(), /review parity bypass/);
  } finally { restore(); }

  try {
    const escaped = JSON.parse(baseAlpha);
    escaped.outputs[0].path = '../outside.mov';
    json(alphaManifestPath, escaped);
    assert.throws(() => build(), /안전한 repo 상대 경로/);
  } finally { restore(); }

  try {
    const overlappingPlan = JSON.parse(basePlan);
    overlappingPlan.segments[1].startFrame = 330;
    writeRenderManifests({planValue: overlappingPlan});
    assert.throws(() => build(), /segment가 겹칩니다/);
  } finally { restore(); }

  try {
    writeCapture();
    const structurePath = path.join(captureDir, 'structure.json');
    const changed = JSON.parse(readFileSync(structurePath, 'utf8'));
    changed.sequenceId = 'different-sequence';
    json(structurePath, changed);
    assert.throws(() => build(), /capture 검증에 실패|bundle/i);
  } finally { restore(); }

  try {
    writeCapture((capture) => {
      capture.structure.durationSeconds = 11;
    });
    assert.throws(() => build(), /live sequence 범위를 벗어납니다/);
  } finally { restore(); }

  try {
    writeCapture((capture) => {
      capture.settings.frameRate = 25;
      capture.settings.ticksPerFrame = 10160640000;
      capture.settings.timebase = '10160640000';
      capture.settings.videoDisplayFormat = 1;
    });
    assert.throws(() => build(), /live sequence fps/);
  } finally { restore(); }

  try {
    assert.throws(
      () => build({expectedIdentity: {sequenceId: 'sequence-changed-after-capture'}}),
      /live identity가 기대값과 달라졌습니다/,
    );
  } finally { restore(); }

  const uxpSpeed = clone(captureBase.structure);
  const cepSpeed = clone(captureBase.structure);
  uxpSpeed.videoTracks[0].clips[0].speed = 0.7862595419847328;
  cepSpeed.videoTracks[0].clips[0].speed = 0.78625954198473;
  assert.equal(
    sha256PremiereSequenceFingerprint(uxpSpeed, 30),
    sha256PremiereSequenceFingerprint(cepSpeed, 30),
    'Bridge serialization precision alone must not invalidate the captured cut.',
  );
  cepSpeed.videoTracks[0].clips[0].speed = 0.78625955;
  assert.notEqual(
    sha256PremiereSequenceFingerprint(uxpSpeed, 30),
    sha256PremiereSequenceFingerprint(cepSpeed, 30),
    'An actual speed change must still invalidate the capture.',
  );

  console.log(
    'PASS production overlay placement bridge: 30fps absolute starts, identity, parity, hashes, overlap, bounds, and path safety',
  );
} finally {
  rmSync(fixtureRoot, {recursive: true, force: true});
}
