import assert from "node:assert/strict";

import {
  DEFAULT_PREMIERE_CUT_BATCH_PAUSE_MS,
  DEFAULT_PREMIERE_CUT_BATCH_SIZE,
  MAX_PREMIERE_CUT_BATCH_SIZE,
  createReversePremiereCutBatchPlan,
  resolvePremiereCutBatchOptions,
  runPremiereCutBatchPlan,
} from "./lib/premiere-cut-batches.mjs";

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function makeCuts(count) {
  return Array.from({length: count}, (_, index) => ({
    index,
    startFrame: index * 10,
    endFrame: index * 10 + 2,
    removeFrames: 2,
  }));
}

test("defaults use the practical throughput checkpoint", () => {
  const options = resolvePremiereCutBatchOptions({dryRun: false});
  assert.equal(options.batchSize, DEFAULT_PREMIERE_CUT_BATCH_SIZE);
  assert.equal(options.batchPauseMs, DEFAULT_PREMIERE_CUT_BATCH_PAUSE_MS);
});

test("default plan uses the practical 20-cut checkpoint size", () => {
  const plan = createReversePremiereCutBatchPlan(
    makeCuts(45),
    DEFAULT_PREMIERE_CUT_BATCH_SIZE,
  );
  assert.deepEqual(plan.batches.map((batch) => batch.cutCount), [20, 20, 5]);
});

test("25 cuts produce reverse 8/8/8/1 execution batches", () => {
  const plan = createReversePremiereCutBatchPlan(makeCuts(25), 8);
  assert.equal(plan.batchCount, 4);
  assert.deepEqual(plan.batches.map((batch) => batch.cutCount), [8, 8, 8, 1]);
  assert.deepEqual(
    plan.batches.map((batch) => batch.cuts.map((cut) => cut.index)),
    [
      [24, 23, 22, 21, 20, 19, 18, 17],
      [16, 15, 14, 13, 12, 11, 10, 9],
      [8, 7, 6, 5, 4, 3, 2, 1],
      [0],
    ],
  );
  assert.deepEqual(
    plan.batches.at(-1).cumulativeCuts.map((cut) => cut.index),
    Array.from({length: 25}, (_, index) => index),
  );
});

test("batch size has a hard maximum", () => {
  assert.equal(
    resolvePremiereCutBatchOptions({batchSize: MAX_PREMIERE_CUT_BATCH_SIZE}).batchSize,
    MAX_PREMIERE_CUT_BATCH_SIZE,
  );
  assert.throws(
    () => resolvePremiereCutBatchOptions({batchSize: MAX_PREMIERE_CUT_BATCH_SIZE + 1}),
    /between 1 and 20/,
  );
  assert.throws(
    () => createReversePremiereCutBatchPlan(makeCuts(25), 21),
    /between 1 and 20/,
  );
});

test("healthy writes do not require a fixed pause", () => {
  assert.equal(
    resolvePremiereCutBatchOptions({dryRun: false, batchPauseMs: 0}).batchPauseMs,
    0,
  );
});

await testAsync("dry-run submits no write or post-read calls", async () => {
  const plan = createReversePremiereCutBatchPlan(makeCuts(25), 8);
  let writes = 0;
  let reads = 0;
  const result = await runPremiereCutBatchPlan({
    plan,
    dryRun: true,
    batchPauseMs: 0,
    writeBatch: async () => { writes += 1; },
    readAfterBatch: async () => { reads += 1; },
    verifyBatch: async () => ({ok: true}),
  });
  assert.equal(result.outcome, "dry_run");
  assert.equal(result.writeAttemptCount, 0);
  assert.equal(writes, 0);
  assert.equal(reads, 0);
});

await testAsync("response failure stops before the next batch and is never resent", async () => {
  const plan = createReversePremiereCutBatchPlan(makeCuts(5), 2);
  let writes = 0;
  let reads = 0;
  const result = await runPremiereCutBatchPlan({
    plan,
    batchPauseMs: 250,
    writeBatch: async () => {
      writes += 1;
      return {failed: true};
    },
    readAfterBatch: async () => {
      reads += 1;
      return {sequence: "post"};
    },
    verifyBatch: async () => ({ok: true}),
    isWriteResponseFailure: (response) => response.failed === true,
    pause: async () => assert.fail("pause must not run after a failed response"),
  });
  assert.equal(writes, 1);
  assert.equal(reads, 1);
  assert.equal(result.writeAttemptCount, 1);
  assert.equal(result.completedBatchCount, 1);
  assert.equal(result.cumulativeAppliedCuts.length, 2);
  assert.equal(result.stop.primaryReason, "write_response_failed");
});

await testAsync("timeout still gets one post-read and never starts another batch", async () => {
  const plan = createReversePremiereCutBatchPlan(makeCuts(5), 2);
  let writes = 0;
  let reads = 0;
  const timeout = Object.assign(new Error("MCP timeout after host submission"), {
    code: "ETIMEDOUT",
  });
  const result = await runPremiereCutBatchPlan({
    plan,
    batchPauseMs: 250,
    writeBatch: async () => {
      writes += 1;
      throw timeout;
    },
    readAfterBatch: async () => {
      reads += 1;
      return {sequence: "post"};
    },
    verifyBatch: async () => ({ok: false, stopReason: "invariant_failed"}),
    pause: async () => assert.fail("pause must not run after timeout"),
  });
  assert.equal(writes, 1);
  assert.equal(reads, 1);
  assert.equal(result.writeAttemptCount, 1);
  assert.equal(result.completedBatchCount, 0);
  assert.equal(result.stop.primaryReason, "write_timeout");
  assert.equal(result.stop.reasons.at(-1).reason, "invariant_failed");
});

await testAsync("post-read failure stops a successful response before another write", async () => {
  const plan = createReversePremiereCutBatchPlan(makeCuts(5), 2);
  let writes = 0;
  let reads = 0;
  const result = await runPremiereCutBatchPlan({
    plan,
    batchPauseMs: 250,
    writeBatch: async () => {
      writes += 1;
      return {failed: false};
    },
    readAfterBatch: async () => {
      reads += 1;
      throw new Error("sequence structure unavailable");
    },
    verifyBatch: async () => assert.fail("verification cannot run without post-read"),
    isWriteResponseFailure: (response) => response.failed === true,
    pause: async () => assert.fail("pause must not run after post-read failure"),
  });
  assert.equal(writes, 1);
  assert.equal(reads, 1);
  assert.equal(result.writeAttemptCount, 1);
  assert.equal(result.completedBatchCount, 0);
  assert.equal(result.stop.primaryReason, "post_read_failed");
});

await testAsync("identity or invariant failure stops before another write", async () => {
  const plan = createReversePremiereCutBatchPlan(makeCuts(5), 2);
  let writes = 0;
  const result = await runPremiereCutBatchPlan({
    plan,
    batchPauseMs: 250,
    writeBatch: async () => {
      writes += 1;
      return {failed: false};
    },
    readAfterBatch: async () => ({sequence: "changed"}),
    verifyBatch: async () => ({ok: false, stopReason: "identity_changed"}),
    isWriteResponseFailure: (response) => response.failed === true,
    pause: async () => assert.fail("pause must not run after identity failure"),
  });
  assert.equal(writes, 1);
  assert.equal(result.writeAttemptCount, 1);
  assert.equal(result.completedBatchCount, 0);
  assert.equal(result.stop.primaryReason, "identity_changed");
});

await testAsync("verified batches pause and complete strictly in sequence", async () => {
  const plan = createReversePremiereCutBatchPlan(makeCuts(5), 2);
  const events = [];
  const result = await runPremiereCutBatchPlan({
    plan,
    batchPauseMs: 250,
    writeBatch: async (batch) => {
      events.push(`write:${batch.batchNumber}`);
      return {failed: false};
    },
    readAfterBatch: async (batch) => {
      events.push(`read:${batch.batchNumber}`);
      return {sequence: "post"};
    },
    verifyBatch: async (batch) => {
      events.push(`verify:${batch.batchNumber}`);
      return {ok: true};
    },
    isWriteResponseFailure: (response) => response.failed === true,
    pause: async (_milliseconds, batch) => events.push(`pause:${batch.batchNumber}`),
  });
  assert.equal(result.ok, true);
  assert.equal(result.completedBatchCount, 3);
  assert.equal(result.writeAttemptCount, 3);
  assert.equal(result.cumulativeAppliedCuts.length, 5);
  assert.deepEqual(events, [
    "write:1", "read:1", "verify:1", "pause:1",
    "write:2", "read:2", "verify:2", "pause:2",
    "write:3", "read:3", "verify:3",
  ]);
});

console.log(`1..${passed}`);
