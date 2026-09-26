import assert from "node:assert/strict";

import {
  PREMIERE_DEFAULT_BATCH_PAUSE_MS,
  PREMIERE_DEFAULT_BATCH_SIZE,
  PREMIERE_MAX_BATCH_SIZE,
  partitionPremiereMicroBatches,
  resolvePremiereBatchPauseMs,
  resolvePremiereBatchSize,
} from "./lib/premiere-micro-batch.mjs";

assert.equal(resolvePremiereBatchSize(), PREMIERE_DEFAULT_BATCH_SIZE);
assert.equal(resolvePremiereBatchSize("20"), PREMIERE_MAX_BATCH_SIZE);
assert.throws(() => resolvePremiereBatchSize(0), /1 to 20/);
assert.throws(() => resolvePremiereBatchSize(21), /1 to 20/);
assert.throws(() => resolvePremiereBatchSize(4.5), /integer/);

assert.equal(resolvePremiereBatchPauseMs(), PREMIERE_DEFAULT_BATCH_PAUSE_MS);
assert.equal(resolvePremiereBatchPauseMs("250"), 250);
assert.throws(() => resolvePremiereBatchPauseMs(249), /250 to 60000/);

const batches = partitionPremiereMicroBatches(
  Array.from({ length: 25 }, (_, index) => index),
  8,
);
assert.deepEqual(
  batches.map((batch) => batch.items.length),
  [8, 8, 8, 1],
);
assert.deepEqual(
  batches.map((batch) => [batch.startIndex, batch.endIndex]),
  [
    [0, 8],
    [8, 16],
    [16, 24],
    [24, 25],
  ],
);
assert.equal(batches[0].batchNumber, 1);
assert.equal(batches[0].batchCount, 4);
assert.equal(batches[0].isLast, false);
assert.equal(batches[3].isLast, true);
assert.deepEqual(partitionPremiereMicroBatches([], 8), []);

console.log("Premiere micro-batch self-test passed.");
