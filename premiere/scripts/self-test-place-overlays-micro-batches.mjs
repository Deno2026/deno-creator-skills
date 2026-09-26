import assert from 'node:assert/strict';

import {
  createPremiereOverlayBatchPlan,
  resolvePremiereOverlayBatchOptions,
  runPremiereOverlayBatchPlan,
} from './lib/premiere-overlay-batches.mjs';
import {
  diffOverlaySequenceStructures,
  validateOverlayPlacementIdentityGuards,
} from './place-overlays-cep.mjs';
import {sha256PremiereSequenceFingerprint} from './lib/premiere-sequence-fingerprint.mjs';

let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const items = (count) => Array.from({length: count}, (_, index) => ({
  name: `overlay-${index + 1}.mov`,
  frame: index * 30,
  track_index: 1,
}));

function clip(name, nodeId, startSeconds, endSeconds) {
  return {
    name,
    nodeId,
    startSeconds,
    endSeconds,
    durationSeconds: endSeconds - startSeconds,
    inPointSeconds: 0,
    outPointSeconds: endSeconds - startSeconds,
    mediaType: 'Video',
    enabled: true,
    speed: 1,
  };
}

function track(index, name, clips) {
  return {index, name, isMuted: false, isLocked: false, clipCount: clips.length, clips};
}

function baselineStructure() {
  return {
    id: 'sequence-1',
    name: 'Main',
    durationSeconds: 10,
    videoTrackCount: 2,
    audioTrackCount: 1,
    videoTracks: [
      track(0, 'Video 1', [clip('base.mov', 'v-base', 0, 10)]),
      track(1, 'Video 2', []),
    ],
    audioTracks: [
      track(0, 'Audio 1', [{
        ...clip('base.wav', 'a-base', 0, 10),
        mediaType: 'Audio',
      }]),
    ],
  };
}

await test('overlay defaults are 4 items, 1000ms, and hard-capped at 20', () => {
  const defaults = resolvePremiereOverlayBatchOptions({dryRun: false});
  assert.equal(defaults.batchSize, 4);
  assert.equal(defaults.batchPauseMs, 1000);
  assert.equal(resolvePremiereOverlayBatchOptions({batchSize: 20}).batchSize, 20);
  assert.throws(
    () => resolvePremiereOverlayBatchOptions({batchSize: 21}),
    /integer from 1 to 20/,
  );
  assert.throws(
    () => resolvePremiereOverlayBatchOptions({batchPauseMs: 249, dryRun: false}),
    /integer from 250/,
  );
  assert.equal(resolvePremiereOverlayBatchOptions({batchPauseMs: 0, dryRun: true}).batchPauseMs, 0);
});

await test('10 overlays partition into 4/4/2 cumulative batches', () => {
  const plan = createPremiereOverlayBatchPlan(items(10), 4);
  assert.equal(plan.batchCount, 3);
  assert.deepEqual(plan.batches.map((batch) => batch.items.length), [4, 4, 2]);
  assert.deepEqual(plan.batches.map((batch) => batch.cumulativeItemCount), [4, 8, 10]);
});

await test('cumulative structure diff permits only exact expected target additions', () => {
  const before = baselineStructure();
  const after = structuredClone(before);
  after.videoTracks[1].clips.push(clip('overlay-1.mov', 'new-1', 1, 2));
  after.videoTracks[1].clips.push(clip('overlay-2.mov', 'new-2', 3, 4));
  after.videoTracks[1].clipCount = 2;
  const expected = [
    {name: 'overlay-1.mov', track_index: 1, frame: 30, endFrame: 60},
    {name: 'overlay-2.mov', track_index: 1, frame: 90, endFrame: 120},
  ];
  const result = diffOverlaySequenceStructures(before, after, expected, 30);
  assert.equal(result.ok, true);
  assert.equal(result.observedPlacementCount, 2);

  const changedNonTarget = structuredClone(after);
  changedNonTarget.audioTracks[0].clips[0].endSeconds -= 1 / 30;
  changedNonTarget.audioTracks[0].clips[0].durationSeconds -= 1 / 30;
  const rejected = diffOverlaySequenceStructures(before, changedNonTarget, expected, 30);
  assert.equal(rejected.ok, false);
  assert.match(rejected.issues.join('\n'), /non-target track changed/);
});

await test('schema 2 placement locks project, sequence, duration, timing, display, and capture evidence', () => {
  const before = baselineStructure();
  const manifest = {
    schemaVersion: 2,
    projectCheck: {name: 'episode.prproj', path: 'E:\\Projects\\episode.prproj'},
    sequenceCheck: {
      name: 'Main',
      id: 'sequence-1',
      durationSeconds: 10,
      durationFrames: 300,
      structureSha256: sha256PremiereSequenceFingerprint(before, 30),
    },
    timingCheck: {
      fps: 30,
      ticksPerFrame: '8467200000',
      timecodeDisplay: {code: 4, nominalFps: 30, dropFrame: false},
    },
    captureCheck: {
      source: 'premiere-uxp-read-only-placement-capture',
      captureSha256: 'A'.repeat(64),
      structureSha256: 'B'.repeat(64),
      bundleSha256: 'C'.repeat(64),
    },
  };
  const liveContext = {
    projectName: 'episode.prproj',
    projectPath: 'E:\\Projects\\episode.prproj',
    sequenceName: 'Main',
    sequenceId: 'sequence-1',
    durationTicks: String(300n * 8467200000n),
    ticksPerFrame: '8467200000',
    videoDisplayFormat: 4,
  };
  assert.equal(
    validateOverlayPlacementIdentityGuards({manifest, before, liveContext}).strict,
    true,
  );
  assert.equal(
    validateOverlayPlacementIdentityGuards({
      manifest: {
        ...manifest,
        projectCheck: {
          ...manifest.projectCheck,
          path: '\\\\?\\E:\\Projects\\episode.prproj',
        },
      },
      before,
      liveContext,
    }).strict,
    true,
  );
  assert.equal(
    validateOverlayPlacementIdentityGuards({
      manifest,
      before,
      liveContext: {...liveContext, videoDisplayFormat: 104},
    }).strict,
    true,
  );
  assert.equal(
    validateOverlayPlacementIdentityGuards({
      manifest,
      before,
      liveContext: {...liveContext, durationTicks: 'undefined'},
    }).strict,
    true,
  );
  assert.throws(
    () => validateOverlayPlacementIdentityGuards({
      manifest,
      before,
      liveContext: {...liveContext, projectPath: 'E:\\Projects\\other.prproj'},
    }),
    /project path/,
  );
  assert.throws(
    () => validateOverlayPlacementIdentityGuards({
      manifest,
      before,
      liveContext: {...liveContext, videoDisplayFormat: 3},
    }),
    /display format/,
  );
  const changedBefore = structuredClone(before);
  changedBefore.videoTracks[0].clips[0].name = 'changed.mov';
  assert.throws(
    () => validateOverlayPlacementIdentityGuards({manifest, before: changedBefore, liveContext}),
    /structure changed/,
  );
});

await test('dry-run performs zero import and placement writes', async () => {
  const plan = createPremiereOverlayBatchPlan(items(10), 4);
  let imports = 0;
  let placements = 0;
  let reads = 0;
  const result = await runPremiereOverlayBatchPlan({
    plan,
    dryRun: true,
    batchPauseMs: 0,
    importBatch: async () => { imports += 1; },
    placeBatch: async () => { placements += 1; },
    readAfterBatch: async () => { reads += 1; },
    verifyBatch: async () => ({ok: true}),
  });
  assert.equal(result.outcome, 'dry_run');
  assert.equal(result.importAttemptCount, 0);
  assert.equal(result.placementWriteAttemptCount, 0);
  assert.equal(imports, 0);
  assert.equal(placements, 0);
  assert.equal(reads, 0);
});

await test('one placement write per batch and pause only between batches', async () => {
  const plan = createPremiereOverlayBatchPlan(items(10), 4);
  const events = [];
  const result = await runPremiereOverlayBatchPlan({
    plan,
    batchPauseMs: 1000,
    importBatch: async (batch) => {
      events.push(`import:${batch.batchNumber}:${batch.items.length}`);
      return {imported: batch.items.length};
    },
    placeBatch: async (batch) => {
      events.push(`place:${batch.batchNumber}:${batch.items.length}`);
      return {results: batch.items.map((item) => ({name: item.name, ok: true}))};
    },
    readAfterBatch: async (batch) => {
      events.push(`read:${batch.batchNumber}`);
      return {sequence: 'same'};
    },
    verifyBatch: async (batch) => {
      events.push(`verify:${batch.batchNumber}`);
      return {ok: true};
    },
    pause: async (milliseconds, batch) => events.push(`pause:${batch.batchNumber}:${milliseconds}`),
  });
  assert.equal(result.ok, true);
  assert.equal(result.importAttemptCount, 3);
  assert.equal(result.placementWriteAttemptCount, 3);
  assert.equal(result.completedBatchCount, 3);
  assert.equal(result.cumulativeAppliedItems.length, 10);
  assert.deepEqual(events, [
    'import:1:4', 'place:1:4', 'read:1', 'verify:1', 'pause:1:1000',
    'import:2:4', 'place:2:4', 'read:2', 'verify:2', 'pause:2:1000',
    'import:3:2', 'place:3:2', 'read:3', 'verify:3',
  ]);
});

await test('placement failure reads back once and stops before the next write', async () => {
  const plan = createPremiereOverlayBatchPlan(items(10), 4);
  let imports = 0;
  let placements = 0;
  let reads = 0;
  const result = await runPremiereOverlayBatchPlan({
    plan,
    batchPauseMs: 1000,
    importBatch: async (batch) => {
      imports += 1;
      return {imported: batch.items.length};
    },
    placeBatch: async () => {
      placements += 1;
      return {results: [{name: 'overlay-1.mov', ok: false}]};
    },
    readAfterBatch: async () => {
      reads += 1;
      return {sequence: 'post'};
    },
    verifyBatch: async () => ({ok: false, stopReason: 'invariant_mismatch'}),
    isPlacementResponseFailure: (response) => response.results.some((item) => !item.ok),
    pause: async () => assert.fail('pause must not run after placement failure'),
  });
  assert.equal(imports, 1);
  assert.equal(placements, 1);
  assert.equal(reads, 1);
  assert.equal(result.importAttemptCount, 1);
  assert.equal(result.placementWriteAttemptCount, 1);
  assert.equal(result.completedBatchCount, 0);
  assert.equal(result.stop.primaryReason, 'placement_response_failed');
});

await test('placement timeout is read back but never resent or followed by another batch', async () => {
  const plan = createPremiereOverlayBatchPlan(items(10), 4);
  let placements = 0;
  let reads = 0;
  const timeout = Object.assign(new Error('placement timeout'), {code: 'ETIMEDOUT'});
  const result = await runPremiereOverlayBatchPlan({
    plan,
    batchPauseMs: 1000,
    importBatch: async (batch) => ({imported: batch.items.length}),
    placeBatch: async () => {
      placements += 1;
      throw timeout;
    },
    readAfterBatch: async () => {
      reads += 1;
      return {sequence: 'post'};
    },
    verifyBatch: async () => ({ok: true}),
    pause: async () => assert.fail('pause must not run after timeout'),
  });
  assert.equal(placements, 1);
  assert.equal(reads, 1);
  assert.equal(result.placementWriteAttemptCount, 1);
  assert.equal(result.completedBatchCount, 1);
  assert.equal(result.cumulativeAppliedItems.length, 4);
  assert.equal(result.stop.primaryReason, 'placement_response_timeout');
});

await test('import failure stops before any placement write', async () => {
  const plan = createPremiereOverlayBatchPlan(items(10), 4);
  let placements = 0;
  const result = await runPremiereOverlayBatchPlan({
    plan,
    batchPauseMs: 1000,
    importBatch: async () => {
      throw new Error('import response lost');
    },
    placeBatch: async () => { placements += 1; },
    readAfterBatch: async () => assert.fail('no timeline write means no batch read is needed'),
    verifyBatch: async () => ({ok: true}),
  });
  assert.equal(placements, 0);
  assert.equal(result.importAttemptCount, 1);
  assert.equal(result.placementWriteAttemptCount, 0);
  assert.equal(result.stop.primaryReason, 'import_response_failed');
});

console.log(`1..${passed}`);
