import assert from 'node:assert/strict';

import {
  createImportMicroBatchPlan,
  runImportMicroBatches,
  verifyImportBatchReadback,
} from './import-audio-active-clips-to-current-sequence.mjs';
import {
  resolvePremiereBatchPauseMs,
  resolvePremiereBatchSize,
} from './lib/premiere-micro-batch.mjs';

function makeItems(count, startIndex = 0) {
  let cursor = 10;
  return Array.from({ length: count }, (_, offset) => {
    const manifestIndex = startIndex + offset;
    const item = {
      manifestIndex,
      name: `active_${String(manifestIndex).padStart(4, '0')}.mp4`,
      file: `C:\\fixtures\\active_${String(manifestIndex).padStart(4, '0')}.mp4`,
      startSeconds: cursor,
      endSeconds: cursor + 1,
      durationSeconds: 1,
    };
    cursor = item.endSeconds;
    return item;
  });
}

function makeClip(name, startSeconds, endSeconds, nodeId, index) {
  return {
    index,
    nodeId,
    name,
    mediaType: 'Video',
    startSeconds,
    endSeconds,
    durationSeconds: endSeconds - startSeconds,
    inPointSeconds: 0,
    outPointSeconds: endSeconds - startSeconds,
    speed: 1,
    enabled: true,
  };
}

function makeTrack(index, name, clips) {
  return {
    index,
    name,
    isMuted: false,
    isLocked: false,
    clipCount: clips.length,
    clips,
  };
}

function makeSnapshot({ durationSeconds, targetItems = [], mutateNonTarget = false }) {
  const videoTargetClips = targetItems.map((item, index) =>
    makeClip(item.name, item.startSeconds, item.endSeconds, `video-${index}`, index)
  );
  const audioTargetClips = targetItems.map((item, index) => ({
    ...makeClip(item.name, item.startSeconds, item.endSeconds, `audio-${index}`, index),
    mediaType: 'Audio',
  }));
  const nonTargetVideo = makeClip(
    'background.mp4',
    0,
    mutateNonTarget ? 9.9 : 10,
    'background-video',
    0,
  );
  const nonTargetAudio = {
    ...makeClip('bed.wav', 0, 10, 'background-audio', 0),
    mediaType: 'Audio',
  };
  const structure = {
    id: 'sequence-1',
    name: 'Sequence 1',
    durationSeconds,
    videoTrackCount: 2,
    audioTrackCount: 2,
    videoTracks: [
      makeTrack(0, 'V1', videoTargetClips),
      makeTrack(1, 'V2', [nonTargetVideo]),
    ],
    audioTracks: [
      makeTrack(0, 'A1', audioTargetClips),
      makeTrack(1, 'A2', [nonTargetAudio]),
    ],
  };
  return {
    state: {
      project: {
        name: 'fixture.prproj',
        path: 'C:\\fixtures\\fixture.prproj',
      },
    },
    summary: {
      id: structure.id,
      name: structure.name,
      durationSeconds,
      totalVideoClips: 1 + targetItems.length,
      totalAudioClips: 1 + targetItems.length,
      frameRate: {
        seconds: 1 / 30,
        ticks: '8467200000',
      },
    },
    structure,
  };
}

assert.equal(resolvePremiereBatchSize(undefined), 8);
assert.equal(resolvePremiereBatchPauseMs(undefined), 1000);
assert.throws(() => resolvePremiereBatchSize(21), /1 to 20/);
assert.throws(() => resolvePremiereBatchPauseMs(249), /250/);

const items = makeItems(25);
const plan = createImportMicroBatchPlan(items, 8);
assert.equal(plan.batchCount, 4);
assert.deepEqual(plan.batches.map((batch) => batch.items.length), [8, 8, 8, 1]);
assert.deepEqual(
  plan.batches.map((batch) => [batch.manifestStartIndex, batch.manifestEndIndex]),
  [[0, 8], [8, 16], [16, 24], [24, 25]],
);

const events = [];
const success = await runImportMicroBatches({
  plan,
  batchPauseMs: 1000,
  importBatch: async (batch) => {
    events.push(`import:${batch.batchNumber}`);
    return { ok: true };
  },
  placeItem: async (item, batch) => {
    events.push(`place:${batch.batchNumber}:${item.manifestIndex}`);
    return { ok: true };
  },
  readAfterBatch: async (batch) => {
    events.push(`read:${batch.batchNumber}`);
    return { batchNumber: batch.batchNumber };
  },
  verifyBatch: async (batch) => {
    events.push(`verify:${batch.batchNumber}`);
    return { ok: true };
  },
  pauseBetweenBatches: async (milliseconds, batch) => {
    events.push(`pause:${batch.batchNumber}:${milliseconds}`);
  },
});
assert.equal(success.ok, true);
assert.equal(success.completedBatchCount, 4);
assert.equal(success.verifiedItemCount, 25);
assert.equal(success.pauseCount, 3);
assert.equal(success.writeAttemptCount, 29);
assert.deepEqual(
  events.filter((event) => event.startsWith('pause:')),
  ['pause:1:1000', 'pause:2:1000', 'pause:3:1000'],
);
for (let batchNumber = 1; batchNumber <= 3; batchNumber += 1) {
  assert.ok(
    events.indexOf(`verify:${batchNumber}`) < events.indexOf(`pause:${batchNumber}:1000`),
  );
  assert.ok(
    events.indexOf(`pause:${batchNumber}:1000`) < events.indexOf(`import:${batchNumber + 1}`),
  );
}
assert.equal(events.some((event) => event.startsWith('pause:4:')), false);

const failedEvents = [];
const failed = await runImportMicroBatches({
  plan,
  batchPauseMs: 1000,
  importBatch: async (batch) => {
    failedEvents.push(`import:${batch.batchNumber}`);
    return { ok: true };
  },
  placeItem: async (item, batch) => {
    failedEvents.push(`place:${batch.batchNumber}:${item.manifestIndex}`);
    return { ok: true };
  },
  readAfterBatch: async (batch) => {
    failedEvents.push(`read:${batch.batchNumber}`);
    return {};
  },
  verifyBatch: async (batch) => {
    failedEvents.push(`verify:${batch.batchNumber}`);
    return batch.batchNumber === 2
      ? { ok: false, failures: [{ kind: 'fixture_failure' }] }
      : { ok: true };
  },
  pauseBetweenBatches: async (milliseconds, batch) => {
    failedEvents.push(`pause:${batch.batchNumber}:${milliseconds}`);
  },
});
assert.equal(failed.ok, false);
assert.equal(failed.stop.reason, 'invariant_failed');
assert.equal(failed.completedBatchCount, 1);
assert.equal(failed.verifiedItemCount, 8);
assert.deepEqual(
  failedEvents.filter((event) => event.startsWith('import:')),
  ['import:1', 'import:2'],
);
assert.equal(failedEvents.some((event) => event.startsWith('import:3')), false);
assert.deepEqual(
  failedEvents.filter((event) => event.startsWith('pause:')),
  ['pause:1:1000'],
);

const timeoutEvents = [];
const timedOut = await runImportMicroBatches({
  plan,
  batchPauseMs: 1000,
  importBatch: async (batch) => {
    timeoutEvents.push(`import:${batch.batchNumber}`);
    return { ok: true };
  },
  placeItem: async (item, batch) => {
    timeoutEvents.push(`place:${batch.batchNumber}:${item.manifestIndex}`);
    throw new Error('add_to_timeline timed out');
  },
  readAfterBatch: async () => {
    throw new Error('read should not run after an uncertain write response');
  },
  verifyBatch: async () => {
    throw new Error('verify should not run after an uncertain write response');
  },
  pauseBetweenBatches: async () => {
    timeoutEvents.push('unexpected-pause');
  },
});
assert.equal(timedOut.ok, false);
assert.equal(timedOut.stop.reason, 'timeout');
assert.equal(timedOut.stop.writeMayHaveApplied, true);
assert.equal(timedOut.completedBatchCount, 0);
assert.deepEqual(timeoutEvents, ['import:1', 'place:1:0']);

const expectedItems = makeItems(2);
const original = makeSnapshot({ durationSeconds: 10 });
const post = makeSnapshot({ durationSeconds: 12, targetItems: expectedItems });
const verification = verifyImportBatchReadback({
  original,
  post,
  cumulativeItems: expectedItems,
  videoTrackIndex: 0,
  audioTrackIndex: 0,
});
assert.equal(verification.ok, true, JSON.stringify(verification.failures));
assert.equal(verification.addedItems.video.length, 2);
assert.equal(verification.addedItems.audio.length, 2);

const changedOutsideTarget = verifyImportBatchReadback({
  original,
  post: makeSnapshot({
    durationSeconds: 12,
    targetItems: expectedItems,
    mutateNonTarget: true,
  }),
  cumulativeItems: expectedItems,
  videoTrackIndex: 0,
  audioTrackIndex: 0,
});
assert.equal(changedOutsideTarget.ok, false);
assert.ok(
  changedOutsideTarget.failures.some((failure) => failure.kind === 'non_target_track_changed'),
);

console.log(JSON.stringify({
  ok: true,
  batchSizes: plan.batches.map((batch) => batch.items.length),
  pauseCount: success.pauseCount,
  verifiedItemCount: success.verifiedItemCount,
  failureStoppedBeforeBatch: 3,
  invariantChecks: 2,
}, null, 2));
