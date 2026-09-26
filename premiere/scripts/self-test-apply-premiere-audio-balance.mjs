import assert from "node:assert/strict";

import {
  AUDIO_BALANCE_DEFAULT_BATCH_SIZE,
  AUDIO_BALANCE_PROPOSAL_SCHEMA_VERSION,
  buildLevelWriteCode,
  parseArgs,
  runAudioBalanceLiveOperation,
  runAudioBalanceMicroBatchOperation,
  runAudioBalanceOperation,
} from "./apply-premiere-audio-balance.mjs";
import { createPremiereCepSession } from "./lib/premiere-cep-session.mjs";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function adjustment(nodeId, clipIndex, startSeconds, endSeconds, currentRaw, newRaw) {
  return {
    nodeId,
    trackIndex: 0,
    clipIndex,
    name: `narration-${clipIndex + 1}`,
    startSeconds,
    endSeconds,
    currentRaw,
    newRaw,
    gainDb: 3,
    finalDisplayDb: 0,
    shouldApply: true,
    sourceGroupKey: "source:narration.wav",
    sourceGroupClipCount: 2,
  };
}

function makeProposal() {
  const adjustments = [
    adjustment("node-a", 0, 0, 2, 0.177827941, 0.251188643),
    adjustment("node-b", 1, 3, 5, 0.125892541, 0.251188643),
  ];
  return {
    schemaVersion: AUDIO_BALANCE_PROPOSAL_SCHEMA_VERSION,
    complete: true,
    writeEligible: true,
    writeIneligibleReasons: [],
    projectName: "fixture.prproj",
    projectPath: "C:\\fixtures\\fixture.prproj",
    sequenceName: "fixture-sequence",
    sequenceId: "sequence-1",
    options: { groupBy: "source", limit: 0 },
    scope: {
      inputAudioClipCount: 2,
      matchedClipCountBeforeLimit: 2,
      analyzedTrackIndex: 0,
      limited: false,
      sourceGroupsCompleteAcrossAudioMap: true,
    },
    summary: {
      analyzedCount: 2,
      applyCount: 2,
    },
    adjustments,
    sourceGroups: [
      {
        sourceGroupKey: "source:narration.wav",
        clipCount: 2,
        audioMapClipCount: 2,
        scopeComplete: true,
        shouldApply: true,
      },
    ],
    failures: [],
  };
}

function makeSizedProposal(count) {
  const proposal = makeProposal();
  proposal.adjustments = Array.from({ length: count }, (_, index) => {
    const item = adjustment(
      `node-${String(index + 1).padStart(2, "0")}`,
      index,
      index * 3,
      index * 3 + 2,
      0.177827941,
      0.251188643,
    );
    item.sourceGroupClipCount = count;
    return item;
  });
  proposal.scope.inputAudioClipCount = count;
  proposal.scope.matchedClipCountBeforeLimit = count;
  proposal.summary.analyzedCount = count;
  proposal.summary.applyCount = count;
  proposal.sourceGroups[0].clipCount = count;
  proposal.sourceGroups[0].audioMapClipCount = count;
  return proposal;
}

function makeSnapshot(proposal) {
  return {
    projectName: proposal.projectName,
    projectPath: proposal.projectPath,
    sequenceName: proposal.sequenceName,
    sequenceId: proposal.sequenceId,
    normalized: {
      id: proposal.sequenceId,
      name: proposal.sequenceName,
      durationFrames: 300,
      timing: { fps: 30, secondsPerFrame: 1 / 30, ticksPerFrame: null, gridToleranceFrames: 0.05 },
      tracks: [
        {
          key: "audio:0",
          kind: "audio",
          index: 0,
          position: 0,
          name: "Audio 1",
          isMuted: false,
          isLocked: false,
          clips: proposal.adjustments.map((item, index) => ({
            nodeId: item.nodeId,
            index,
            position: index,
            name: item.name,
            startFrame: Math.round(item.startSeconds * 30),
            endFrame: Math.round(item.endSeconds * 30),
            durationFrames: Math.round((item.endSeconds - item.startSeconds) * 30),
            inPointFrame: 0,
            outPointFrame: Math.round((item.endSeconds - item.startSeconds) * 30),
            mediaType: "Audio",
            enabled: null,
            speed: null,
          })),
        },
      ],
    },
  };
}

function makeIo(proposal, options = {}) {
  const snapshot = makeSnapshot(proposal);
  const levels = new Map(proposal.adjustments.map((item) => [item.nodeId, item.currentRaw]));
  let captureCount = 0;
  let readCount = 0;
  let writeCount = 0;

  return {
    stats() {
      return { captureCount, readCount, writeCount };
    },
    captureStructure() {
      captureCount += 1;
      if (captureCount === 2 && options.postStructureError) {
        throw new Error("fixture post structure read failed");
      }
      const value = clone(snapshot);
      if (captureCount === 2 && options.mutatePostStructure) {
        options.mutatePostStructure(value);
      }
      if (captureCount === 1 && options.mutateInitialIdentity) {
        options.mutateInitialIdentity(value);
      }
      return value;
    },
    readLevels(changes) {
      readCount += 1;
      if (readCount === 2 && options.postLevelError) {
        throw new Error("fixture post Level read failed");
      }
      if (readCount === options.driftLevelAtReadCount) {
        const nodeId = options.driftLevelNodeId || changes[0]?.nodeId;
        levels.set(nodeId, Number(levels.get(nodeId)) + 0.01);
      }
      const targets = changes.map((item) => ({
        nodeId: item.nodeId,
        trackIndex: item.trackIndex,
        clipIndex: item.clipIndex,
        name: item.name,
        startSeconds: item.startSeconds,
        endSeconds: item.endSeconds,
        currentRaw: levels.get(item.nodeId),
      }));
      if (readCount === 1 && options.mutatePreflightTarget) {
        options.mutatePreflightTarget(targets);
      }
      return {
        phase: "level-read",
        identity: {
          projectName: proposal.projectName,
          projectPath: proposal.projectPath,
          sequenceName: proposal.sequenceName,
          sequenceId: readCount === options.identityDriftAtReadCount
            ? "different-sequence"
            : proposal.sequenceId,
        },
        requested: changes.length,
        targets,
        failed: [],
      };
    },
    writeLevels(changes) {
      writeCount += 1;
      if (options.applyWrite !== false) {
        for (const item of changes) levels.set(item.nodeId, item.newRaw);
      }
      if (options.writeErrorAfterApply) {
        const error = new Error("fixture write response timed out");
        error.code = "ETIMEDOUT";
        throw error;
      }
      return {
        phase: "written",
        requested: changes.length,
        backpressureObserved: options.backpressureObserved === true,
        recommendedUiYieldMs: options.recommendedUiYieldMs,
        updated: changes.map((item) => ({
          nodeId: item.nodeId,
          target: item.newRaw,
          after: levels.get(item.nodeId),
          matched: levels.get(item.nodeId) === item.newRaw,
        })),
        failed: [],
      };
    },
  };
}

function executeGeneratedWrite(proposal, options = {}) {
  const levels = new Map(proposal.adjustments.map((item) => [item.nodeId, item.currentRaw]));
  const lookups = new Map();
  const setterCalls = new Map();
  const clips = new Map();
  for (const item of proposal.adjustments) {
    const levelProperty = {
      displayName: "Level",
      getValue() {
        return levels.get(item.nodeId);
      },
      setValue(value) {
        setterCalls.set(item.nodeId, (setterCalls.get(item.nodeId) || 0) + 1);
        levels.set(item.nodeId, Number(value));
      },
    };
    clips.set(item.nodeId, {
      nodeId: item.nodeId,
      name: item.name,
      start: { ticks: item.startSeconds * 1000 },
      end: { ticks: item.endSeconds * 1000 },
      components: {
        numItems: 1,
        0: {
          displayName: "Volume",
          matchName: "Volume",
          properties: { numItems: 1, 0: levelProperty },
        },
      },
    });
  }
  if (options.initialRawDriftNodeId) {
    const key = options.initialRawDriftNodeId;
    levels.set(key, levels.get(key) + 0.01);
  }
  const activeSequence = {
    name: proposal.sequenceName,
    sequenceID: proposal.sequenceId,
  };
  const app = {
    project: {
      name: proposal.projectName,
      path: proposal.projectPath,
      activeSequence,
    },
  };
  const findClip = (nodeId) => {
    const count = (lookups.get(nodeId) || 0) + 1;
    lookups.set(nodeId, count);
    if (options.driftBeforeSecondLookupNodeId === nodeId && count === 2) {
      levels.set(nodeId, levels.get(nodeId) + 0.01);
    }
    const item = proposal.adjustments.find((candidate) => candidate.nodeId === nodeId);
    return {
      clip: clips.get(nodeId),
      trackType: "audio",
      trackIndex: item.trackIndex,
      clipIndex: item.clipIndex,
    };
  };
  const execute = new Function(
    "app",
    "__findClip",
    "__ticksToSeconds",
    "__result",
    "__error",
    `return (function () {${buildLevelWriteCode(proposal.adjustments, proposal)}})();`,
  );
  const response = execute(
    app,
    findClip,
    (ticks) => Number(ticks) / 1000,
    (value) => value,
    (message) => ({ error: message }),
  );
  return { response, levels, lookups, setterCalls };
}

function run(proposal, io, options = {}) {
  return runAudioBalanceOperation({
    proposal,
    proposalPath: "fixture-proposal.json",
    dryRun: options.dryRun ?? false,
    maxItems: options.maxItems ?? 0,
    io,
  });
}

const validProposal = makeProposal();

assert.equal(parseArgs([]).batchSize, 20);
assert.equal(parseArgs(["--chunk-size", "7"]).batchSize, 7);
assert.equal(parseArgs(["--batch-size", "20"]).batchSize, 20);
assert.throws(() => parseArgs(["--chunk-size", "21"]), /1 to 20/);

for (const mutation of [
  (proposal) => { delete proposal.schemaVersion; },
  (proposal) => { proposal.schemaVersion = 1; },
  (proposal) => { delete proposal.complete; },
  (proposal) => { proposal.complete = false; },
  (proposal) => { delete proposal.projectPath; },
  (proposal) => { delete proposal.sequenceId; },
]) {
  const proposal = clone(validProposal);
  mutation(proposal);
  const io = makeIo(validProposal);
  const result = run(proposal, io, { dryRun: true });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "proposal-rejected");
  assert.deepEqual(io.stats(), { captureCount: 0, readCount: 0, writeCount: 0 });
}

{
  const proposal = clone(validProposal);
  proposal.adjustments[1].nodeId = proposal.adjustments[0].nodeId;
  const io = makeIo(validProposal);
  const result = run(proposal, io, { dryRun: true });
  assert.equal(result.outcome, "proposal-rejected");
  assert.match(result.validationError.message, /Duplicate adjustment nodeId/);
  assert.equal(io.stats().writeCount, 0);
}

{
  const io = makeIo(validProposal);
  const result = run(validProposal, io, { maxItems: 1 });
  assert.equal(result.outcome, "proposal-rejected");
  assert.match(result.validationError.message, /max-items is dry-run only/i);
  assert.deepEqual(io.stats(), { captureCount: 0, readCount: 0, writeCount: 0 });
}

{
  const proposal = clone(validProposal);
  proposal.adjustments[1].shouldApply = false;
  proposal.summary.applyCount = 1;
  const io = makeIo(validProposal);
  const result = run(proposal, io);
  assert.equal(result.outcome, "proposal-rejected");
  assert.match(result.validationError.message, /partial source-group writes are forbidden/i);
  assert.equal(io.stats().writeCount, 0);
}

{
  const proposal = clone(validProposal);
  proposal.writeEligible = false;
  proposal.writeIneligibleReasons = ["fixture scope is limited"];
  const io = makeIo(validProposal);
  const result = run(proposal, io);
  assert.equal(result.outcome, "proposal-rejected");
  assert.match(result.validationError.message, /not eligible for a real write/i);
  assert.equal(io.stats().writeCount, 0);
}

{
  const proposal = clone(validProposal);
  proposal.options.limit = 1;
  proposal.scope.limited = true;
  proposal.writeIneligibleReasons = ["fixture scope is limited"];
  // Simulate a tampered document that flips only the top-level convenience flag.
  proposal.writeEligible = true;
  const io = makeIo(validProposal);
  const result = run(proposal, io);
  assert.equal(result.outcome, "proposal-rejected");
  assert.match(result.validationError.message, /contradicts its options, scope/i);
  assert.equal(io.stats().writeCount, 0);
}

{
  const proposal = clone(validProposal);
  for (const item of proposal.adjustments) item.shouldApply = false;
  proposal.sourceGroups[0].shouldApply = false;
  proposal.summary.applyCount = 0;
  const wrongProjectIo = makeIo(proposal, {
    mutateInitialIdentity(snapshot) {
      snapshot.sequenceId = "different-sequence";
    },
  });
  const rejected = run(proposal, wrongProjectIo);
  assert.equal(rejected.outcome, "identity-preflight-rejected");
  assert.deepEqual(wrongProjectIo.stats(), { captureCount: 1, readCount: 0, writeCount: 0 });

  const correctProjectIo = makeIo(proposal);
  const verified = run(proposal, correctProjectIo);
  assert.equal(verified.ok, true);
  assert.equal(verified.outcome, "verified-noop");
  assert.deepEqual(correctProjectIo.stats(), { captureCount: 1, readCount: 0, writeCount: 0 });
}

{
  const io = makeIo(validProposal, {
    mutateInitialIdentity(snapshot) {
      snapshot.projectPath = "C:\\fixtures\\different.prproj";
    },
  });
  const result = run(validProposal, io);
  assert.equal(result.outcome, "identity-preflight-rejected");
  assert.equal(io.stats().writeCount, 0);
}

const targetDriftFixtures = [
  ["nodeId", (targets) => { targets[0].nodeId = "unexpected-node"; }],
  ["trackIndex", (targets) => { targets[0].trackIndex = 1; }],
  ["clipIndex", (targets) => { targets[0].clipIndex = 9; }],
  ["name", (targets) => { targets[0].name = "renamed"; }],
  ["startSeconds", (targets) => { targets[0].startSeconds += 1 / 30; }],
  ["endSeconds", (targets) => { targets[0].endSeconds += 1 / 30; }],
  ["currentRaw", (targets) => { targets[0].currentRaw += 0.01; }],
];
for (const [label, mutatePreflightTarget] of targetDriftFixtures) {
  const io = makeIo(validProposal, { mutatePreflightTarget });
  const result = run(validProposal, io);
  assert.equal(result.outcome, "target-preflight-rejected", label);
  assert.equal(io.stats().writeCount, 0, label);
  assert.equal(result.writeAttemptCount, 0, label);
}

{
  const io = makeIo(validProposal);
  const result = run(validProposal, io);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.outcome, "verified");
  assert.equal(result.writeAttemptCount, 1);
  assert.equal(result.writeResent, false);
  assert.equal(result.levelReadback.rawField, "newRaw");
  assert.deepEqual(io.stats(), { captureCount: 2, readCount: 2, writeCount: 1 });
}

{
  const io = makeIo(validProposal, { applyWrite: false });
  const result = run(validProposal, io);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "verification-failed");
  assert.equal(result.levelReadbackComplete, false);
  assert.equal(io.stats().writeCount, 1);
}

{
  const io = makeIo(validProposal, {
    mutatePostStructure(snapshot) {
      snapshot.normalized.tracks[0].clips[0].nodeId = "replacement-node";
    },
  });
  const result = run(validProposal, io);
  assert.equal(result.ok, false);
  assert.equal(result.invariant.identitySame, true);
  assert.equal(result.invariant.structureSame, false);
  assert.equal(io.stats().writeCount, 1);
}

{
  const io = makeIo(validProposal, { writeErrorAfterApply: true });
  const result = run(validProposal, io);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.outcome, "verified-by-post-read-after-uncertain-write-response");
  assert.equal(result.writeAttemptCount, 1);
  assert.equal(result.writeResent, false);
  assert.equal(io.stats().writeCount, 1);
}

for (const failureOptions of [
  { postLevelError: true },
  { postStructureError: true },
  { postLevelError: true, writeErrorAfterApply: true },
]) {
  const io = makeIo(validProposal, failureOptions);
  const result = run(validProposal, io);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "uncertain-post-read-failed-no-retry");
  assert.equal(result.writeAttemptCount, 1);
  assert.equal(result.writeResent, false);
  assert.equal(result.mutationPossible, true);
  assert.equal(io.stats().writeCount, 1);
}

{
  const io = makeIo(validProposal);
  const result = run(validProposal, io, { dryRun: true, maxItems: 1 });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.requested, 1);
  assert.equal(result.writeAttemptCount, 0);
  assert.equal(result.writeResent, false);
  assert.equal(io.stats().writeCount, 0);
}

{
  const code = buildLevelWriteCode(validProposal.adjustments, validProposal);
  assert.match(code, /Phase 1: every target must match/);
  assert.match(code, /immediate = inspectChange\(change, change\.currentRaw\)/);
  assert.ok(code.indexOf("Phase 1: every target") < code.indexOf("immediate.prop.setValue"));
  assert.match(code, /expectedProjectPath/);
  assert.match(code, /expectedSequenceId/);
}

{
  const fixture = executeGeneratedWrite(validProposal, { initialRawDriftNodeId: "node-b" });
  assert.equal(fixture.response.phase, "write-preflight-rejected");
  assert.equal(fixture.setterCalls.size, 0);
}

{
  const fixture = executeGeneratedWrite(validProposal, {
    driftBeforeSecondLookupNodeId: "node-b",
  });
  assert.equal(fixture.response.phase, "set-preflight-rejected");
  assert.equal(fixture.response.rollback.complete, true);
  assert.equal(fixture.levels.get("node-a"), validProposal.adjustments[0].currentRaw);
  assert.equal(fixture.setterCalls.get("node-a"), 2);
  assert.equal(fixture.setterCalls.has("node-b"), false);
}

{
  const proposal = makeSizedProposal(25);
  const io = makeIo(proposal);
  const pauses = [];
  const result = await runAudioBalanceMicroBatchOperation({
    proposal,
    proposalPath: "fixture-25.json",
    batchSize: AUDIO_BALANCE_DEFAULT_BATCH_SIZE,
    io,
    waitForUi(milliseconds) {
      pauses.push(milliseconds);
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.outcome, "verified");
  assert.deepEqual(result.batches.map((batch) => batch.itemCount), [20, 5]);
  assert.equal(result.writeAttemptCount, 2);
  assert.equal(result.verifiedCompletedBatchCount, 2);
  assert.equal(result.verifiedCompletedItemCount, 25);
  assert.equal(result.remainingItemCount, 0);
  assert.deepEqual(pauses, []);
  assert.equal(result.initialFullSnapshotCaptured, true);
  assert.equal(result.finalFullSnapshotAttempted, true);
  assert.equal(result.finalVerification.structureExact, true);
  assert.equal(result.finalVerification.levelsExact, true);
  assert.deepEqual(io.stats(), { captureCount: 2, readCount: 5, writeCount: 2 });
}

{
  const proposal = makeSizedProposal(25);
  const io = makeIo(proposal, { writeErrorAfterApply: true });
  const pauses = [];
  const result = await runAudioBalanceMicroBatchOperation({
    proposal,
    proposalPath: "fixture-25-write-timeout.json",
    io,
    waitForUi(milliseconds) {
      pauses.push(milliseconds);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "stopped-before-next-batch");
  assert.equal(result.stopReason, "write-timeout-or-response-loss");
  assert.equal(result.stoppedAtBatchNumber, 1);
  assert.equal(result.writeAttemptCount, 1);
  assert.equal(result.verifiedCompletedBatchCount, 1);
  assert.equal(result.verifiedCompletedItemCount, 20);
  assert.equal(result.remainingItemCount, 5);
  assert.deepEqual(pauses, []);
  assert.equal(result.finalVerification.scope, "verified-batches-only");
  assert.deepEqual(io.stats(), { captureCount: 2, readCount: 3, writeCount: 1 });
}

{
  const proposal = makeSizedProposal(25);
  const io = makeIo(proposal, {
    backpressureObserved: true,
    recommendedUiYieldMs: 375,
  });
  const pauses = [];
  const progress = [];
  const result = await runAudioBalanceMicroBatchOperation({
    proposal,
    proposalPath: "fixture-25-backpressure.json",
    io,
    waitForUi(milliseconds) {
      pauses.push(milliseconds);
    },
    onProgress(event) {
      progress.push(event);
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.deepEqual(pauses, [375]);
  assert.equal(result.uiYieldCount, 1);
  assert.equal(result.uiYieldMs, 375);
  assert.ok(progress.some((event) => event.phase === "observed-backpressure-yield"));
  assert.equal(progress.at(-1).phase, "final-full-verification");
}

for (const fixture of [
  {
    name: "identity-drift",
    options: { identityDriftAtReadCount: 3 },
    stopReason: "identity-drift",
  },
  {
    name: "current-level-drift",
    options: { driftLevelAtReadCount: 3, driftLevelNodeId: "node-21" },
    stopReason: "level-preflight-mismatch",
  },
]) {
  const proposal = makeSizedProposal(25);
  const io = makeIo(proposal, fixture.options);
  const result = await runAudioBalanceMicroBatchOperation({
    proposal,
    proposalPath: `fixture-25-${fixture.name}.json`,
    io,
  });
  assert.equal(result.ok, false, fixture.name);
  assert.equal(result.stoppedAtBatchNumber, 2, fixture.name);
  assert.equal(result.stopReason, fixture.stopReason, fixture.name);
  assert.equal(result.writeAttemptCount, 1, fixture.name);
  assert.equal(result.verifiedCompletedItemCount, 20, fixture.name);
  assert.equal(result.remainingItemCount, 5, fixture.name);
  assert.deepEqual(io.stats(), { captureCount: 2, readCount: 4, writeCount: 1 }, fixture.name);
}

{
  const proposal = makeSizedProposal(25);
  const io = makeIo(proposal);
  const pauses = [];
  const result = await runAudioBalanceMicroBatchOperation({
    proposal,
    proposalPath: "fixture-25-dry-run.json",
    dryRun: true,
    io,
    waitForUi(milliseconds) {
      pauses.push(milliseconds);
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.outcome, "verified-dry-run");
  assert.equal(result.plannedBatchCount, 2);
  assert.deepEqual(result.batches.map((batch) => batch.itemCount), [20, 5]);
  assert.equal(result.writeAttemptCount, 0);
  assert.equal(result.verifiedCompletedBatchCount, 0);
  assert.equal(result.verifiedCompletedItemCount, 0);
  assert.equal(result.verifiedDryRunBatchCount, 2);
  assert.equal(result.verifiedDryRunItemCount, 25);
  assert.equal(result.remainingItemCount, 25);
  assert.equal(result.remainingDryRunItemCount, 0);
  assert.deepEqual(pauses, []);
  assert.deepEqual(io.stats(), { captureCount: 2, readCount: 3, writeCount: 0 });
}

{
  const proposal = makeSizedProposal(25);
  const io = makeIo(proposal, { postLevelError: true });
  const pauses = [];
  const result = await runAudioBalanceMicroBatchOperation({
    proposal,
    proposalPath: "fixture-25-dry-run-read-failure.json",
    dryRun: true,
    io,
    waitForUi(milliseconds) {
      pauses.push(milliseconds);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "dry-run-stopped-before-next-batch");
  assert.equal(result.stopReason, "preflight-read-failed");
  assert.equal(result.stoppedAtBatchNumber, 2);
  assert.equal(result.batches.length, 2);
  assert.equal(result.writeAttemptCount, 0);
  assert.equal(result.verifiedDryRunBatchCount, 1);
  assert.equal(result.verifiedDryRunItemCount, 20);
  assert.equal(result.remainingDryRunItemCount, 5);
  assert.deepEqual(pauses, []);
  assert.deepEqual(io.stats(), { captureCount: 2, readCount: 3, writeCount: 0 });
}

{
  const proposal = makeSizedProposal(25);
  const io = makeIo(proposal);
  const result = await runAudioBalanceMicroBatchOperation({
    proposal,
    batchSize: 21,
    io,
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "batch-size-rejected");
  assert.match(result.validationError.message, /1 to 20/);
  assert.deepEqual(io.stats(), { captureCount: 0, readCount: 0, writeCount: 0 });
}

function makeSessionFixture(proposal, options = {}) {
  const io = makeIo(proposal, options);
  const stats = { loads: 0, locks: 0, connects: 0, calls: 0, closes: 0, releases: 0, maxInFlight: 0 };
  let lockHeld = false;
  let inFlight = 0;
  const requests = [];
  const session = createPremiereCepSession({ name: "fixture-audio-session" }, {
    async loadSdk() {
      stats.loads += 1;
      return {
        Client: class {
          async connect() {
            stats.connects += 1;
            if (options.connectError) throw new Error("fixture connect failed");
          }
          async callTool(request) {
            assert.equal(lockHeld, true, "one operation lock must cover every host call");
            stats.calls += 1;
            requests.push(request.name);
            inFlight += 1;
            stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
            try {
              await Promise.resolve();
              let payload;
              if (request.name === "get_premiere_state") {
                payload = { project: { name: proposal.projectName, path: proposal.projectPath } };
              } else if (request.name === "get_timeline_summary") {
                payload = { name: proposal.sequenceName, id: proposal.sequenceId, frameRate: { seconds: 1 / 30 } };
              } else if (request.name === "get_sequence_structure") {
                const { normalized } = io.captureStructure();
                payload = {
                  id: normalized.id,
                  name: normalized.name,
                  durationSeconds: normalized.durationFrames / 30,
                  videoTracks: [],
                  audioTracks: normalized.tracks.map((track) => ({
                    ...track,
                    clips: track.clips.map((clip) => ({
                      ...clip,
                      startSeconds: clip.startFrame / 30,
                      endSeconds: clip.endFrame / 30,
                      durationSeconds: clip.durationFrames / 30,
                      inPointSeconds: clip.inPointFrame / 30,
                      outPointSeconds: clip.outPointFrame / 30,
                    })),
                  })),
                };
              } else if (request.name === "execute_extendscript") {
                const code = request.arguments.code;
                const changes = JSON.parse(code.match(/var changes = (.+);/)[1]);
                payload = code.includes("var expectedRawField")
                  ? io.readLevels(changes)
                  : io.writeLevels(changes);
              } else {
                payload = { ok: true };
              }
              return { content: [{ type: "text", text: JSON.stringify(payload) }] };
            } finally {
              inFlight -= 1;
            }
          }
        },
        StdioClientTransport: class { pid = null; },
      };
    },
    async acquireLock() {
      stats.locks += 1;
      if (options.lockBusy) throw new Error("fixture Premiere lane is busy");
      lockHeld = true;
      return {
        lockPath: "fixture.lock",
        async release() {
          assert.equal(inFlight, 0);
          lockHeld = false;
          stats.releases += 1;
          return { reason: "released" };
        },
      };
    },
    async closeChild() {
      assert.equal(inFlight, 0);
      stats.closes += 1;
      return { confirmedExited: true };
    },
    installSignalHandlers() { return () => {}; },
  });
  return { session, stats, io, requests };
}

{
  const proposal = makeSizedProposal(122);
  const fixture = makeSessionFixture(proposal);
  const result = await runAudioBalanceLiveOperation({ proposal }, fixture);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.writeAttemptCount, 7);
  assert.deepEqual(fixture.stats, { loads: 1, locks: 1, connects: 1, calls: 28, closes: 1, releases: 1, maxInFlight: 1 });
  assert.deepEqual(fixture.io.stats(), { captureCount: 2, readCount: 15, writeCount: 7 });
  await assert.rejects(fixture.session.call("ping"), /closing/);
}

{
  const proposal = makeSizedProposal(25);
  const fixture = makeSessionFixture(proposal, { writeErrorAfterApply: true });
  const result = await runAudioBalanceLiveOperation({ proposal }, fixture);
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "write-timeout-or-response-loss");
  assert.equal(result.writeAttemptCount, 1);
  assert.equal(result.verifiedCompletedItemCount, 20);
  assert.equal(fixture.stats.connects, 1);
  assert.equal(fixture.stats.closes, 1);
  assert.equal(fixture.stats.releases, 1);
  assert.deepEqual(fixture.io.stats(), { captureCount: 2, readCount: 3, writeCount: 1 });
}

{
  const proposal = makeProposal();
  proposal.complete = false;
  const fixture = makeSessionFixture(proposal);
  const result = await runAudioBalanceLiveOperation({ proposal }, fixture);
  assert.equal(result.outcome, "proposal-rejected");
  assert.deepEqual(fixture.stats, { loads: 0, locks: 0, connects: 0, calls: 0, closes: 0, releases: 0, maxInFlight: 0 });
}

{
  const proposal = makeProposal();
  proposal.adjustments.forEach((item) => { item.shouldApply = false; });
  proposal.sourceGroups[0].shouldApply = false;
  proposal.summary.applyCount = 0;
  const fixture = makeSessionFixture(proposal);
  const result = await runAudioBalanceLiveOperation({ proposal }, fixture);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.outcome, "verified-noop");
  assert.equal(fixture.stats.calls, 3);
  assert.equal(fixture.stats.connects, 1);
  assert.equal(fixture.stats.closes, 1);
  assert.deepEqual(fixture.io.stats(), { captureCount: 1, readCount: 0, writeCount: 0 });
}

{
  const proposal = makeProposal();
  const fixture = makeSessionFixture(proposal, { connectError: true });
  const result = await runAudioBalanceLiveOperation({ proposal }, fixture);
  assert.equal(result.outcome, "preflight-read-failed");
  assert.equal(fixture.stats.connects, 1);
  assert.equal(fixture.stats.calls, 0);
  assert.equal(fixture.stats.closes, 1);
  assert.equal(fixture.stats.releases, 1);
}

{
  const proposal = makeProposal();
  const fixture = makeSessionFixture(proposal, { lockBusy: true });
  const result = await runAudioBalanceLiveOperation({ proposal }, fixture);
  assert.equal(result.outcome, "preflight-read-failed");
  assert.equal(fixture.stats.locks, 1);
  assert.equal(fixture.stats.connects, 0);
  assert.equal(fixture.stats.calls, 0);
  assert.equal(fixture.stats.releases, 0);
}

{
  const fixture = makeSessionFixture(makeProposal());
  await Promise.all([fixture.session.call("ping"), fixture.session.call("ping"), fixture.session.call("ping")]);
  await fixture.session.close();
  await fixture.session.close();
  assert.equal(fixture.stats.connects, 1);
  assert.equal(fixture.stats.calls, 3);
  assert.equal(fixture.stats.maxInFlight, 1);
  assert.equal(fixture.stats.closes, 1);
  assert.equal(fixture.stats.releases, 1);
}

console.log(JSON.stringify({
  ok: true,
  fixtureCount: 44,
  checks: {
    schemaAndCompleteRequired: true,
    projectPathAndSequenceIdRequired: true,
    duplicateNodeIdRejected: true,
    allTargetFieldsPreflighted: true,
    realWriteMaxItemsRejected: true,
    partialSourceGroupRejected: true,
    crossScopeEligibilityContradictionRejected: true,
    noOpStillChecksIdentity: true,
    setImmediateRecheckPresent: true,
    independentLevelPostRead: true,
    strictNodeIdMutationRejected: true,
    timeoutNeverResent: true,
    postReadFailureStructuredUncertain: true,
    microBatchesDefaultTwenty: true,
    fullStructureOnlyInitialAndFinal: true,
    noRoutineUiYieldBetweenHealthyBatches: true,
    observedBackpressureYieldsConditionally: true,
    identityAndCurrentRawRecheckedPerBatch: true,
    failedBatchStopsBeforeNextWrite: true,
    dryRunUsesBoundedReadBatches: true,
    dryRunProgressIsSeparateFromAppliedProgress: true,
    dryRunFailureStopsBeforeNextReadBatch: true,
    levelBatchHardMaximumTwenty: true,
    asyncLiveIoPreservesExistingChecks: true,
    oneConnectionForTwentyEightCalls: true,
    oneOperationLockAndSingleInFlight: true,
    asyncTimeoutPostReadWithoutResend: true,
    malformedProposalNeverConnects: true,
    successfulAndFailedOperationsClose: true,
  },
}, null, 2));
