import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

import {
  buildDirectRazorExtendScript,
  createDirectRazorExecutionPlan,
  frameToDisplayTimecode,
  retryDirectRazorReadOnly,
  runDirectRazorExecution,
  validateDirectRazorManifest,
  verifyDirectRazorSelection,
  verifySelectedClipsReadback,
} from "./lib/premiere-direct-razor-cuts.mjs";
import {
  normalizeSequenceStructure,
  simulateRippleCutsForTrack,
} from "./lib/sequence-structure-diff.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(HERE, "apply-premiere-direct-razor-cuts.mjs");
const FPS = 30;
const SECONDS_PER_FRAME = 1 / FPS;

function baseManifest(overrides = {}) {
  return {
    mode: "waveform-only",
    writeReady: true,
    projectName: "test-project.prproj",
    sequenceName: "test-sequence",
    sequenceId: "seq-1",
    sequenceDurationSeconds: 12,
    timing: {fps: FPS, ticksPerFrame: "8467200000"},
    timecodeDisplay: {nominalFps: 30, dropFrame: false},
    targetTracks: ["V1", "A1"],
    targetClipNames: ["recording.mp4"],
    candidatePeakAudit: {
      energyMode: "peak",
      bridgeSilenceGapSeconds: 0,
      suspiciousCutCount: 0,
    },
    cutCount: 3,
    cuts: [
      {index: 0, startFrame: 90, endFrame: 120},
      {index: 1, startFrame: 240, endFrame: 270},
      {index: 2, startFrame: 300, endFrame: 330},
    ],
    ...overrides,
  };
}

function rawClip(name, startFrame, endFrame, inPointFrame = startFrame, outPointFrame = endFrame) {
  return {
    name,
    startSeconds: startFrame * SECONDS_PER_FRAME,
    endSeconds: endFrame * SECONDS_PER_FRAME,
    durationSeconds: (endFrame - startFrame) * SECONDS_PER_FRAME,
    inPointSeconds: inPointFrame * SECONDS_PER_FRAME,
    outPointSeconds: outPointFrame * SECONDS_PER_FRAME,
    mediaType: "clip",
    enabled: true,
    speed: 1,
  };
}

function baseStructure() {
  return {
    id: "seq-1",
    name: "test-sequence",
    durationSeconds: 12,
    videoTrackCount: 2,
    audioTrackCount: 2,
    videoTracks: [
      {
        index: 0,
        name: "Video 1",
        isMuted: false,
        isLocked: false,
        clipCount: 1,
        clips: [rawClip("recording.mp4", 0, 360)],
      },
      {
        index: 1,
        name: "Video 2 protected",
        isMuted: false,
        isLocked: false,
        clipCount: 1,
        clips: [rawClip("intro-title.mov", 0, 60)],
      },
    ],
    audioTracks: [
      {
        index: 0,
        name: "Audio 1",
        isMuted: false,
        isLocked: false,
        clipCount: 1,
        clips: [rawClip("recording.mp4", 0, 360)],
      },
      {
        index: 1,
        name: "Audio 2 protected",
        isMuted: false,
        isLocked: false,
        clipCount: 1,
        clips: [rawClip("intro-music.wav", 0, 60)],
      },
    ],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rawTrack(track, timing) {
  const clips = track.clips.map((clip) => ({
    name: clip.name,
    startSeconds: clip.startFrame * timing.secondsPerFrame,
    endSeconds: clip.endFrame * timing.secondsPerFrame,
    durationSeconds: clip.durationFrames * timing.secondsPerFrame,
    ...(clip.inPointFrame === null ? {} : {inPointSeconds: clip.inPointFrame * timing.secondsPerFrame}),
    ...(clip.outPointFrame === null ? {} : {outPointSeconds: clip.outPointFrame * timing.secondsPerFrame}),
    mediaType: clip.mediaType,
    enabled: clip.enabled,
    speed: clip.speed,
  }));
  return {
    index: track.index,
    name: track.name,
    isMuted: track.isMuted,
    isLocked: track.isLocked,
    clipCount: clips.length,
    clips,
  };
}

function structureAfterCuts(initial, contract, cuts, mutateNonTarget = false) {
  const normalized = normalizeSequenceStructure(initial, contract.timing);
  const targets = new Set(contract.targetTrackKeys);
  const tracks = normalized.tracks.map((track) =>
    targets.has(track.key) ? simulateRippleCutsForTrack(track, cuts) : track,
  );
  const removedFrames = cuts.reduce((sum, cut) => sum + cut.endFrame - cut.startFrame, 0);
  const videoTracks = tracks
    .filter((track) => track.kind === "video")
    .sort((left, right) => left.index - right.index)
    .map((track) => rawTrack(track, contract.timing));
  const audioTracks = tracks
    .filter((track) => track.kind === "audio")
    .sort((left, right) => left.index - right.index)
    .map((track) => rawTrack(track, contract.timing));
  if (mutateNonTarget) audioTracks[1].clips[0].name = "UNAUTHORIZED-CHANGE.wav";
  return {
    id: normalized.id,
    name: normalized.name,
    durationSeconds: (normalized.durationFrames - removedFrames) * contract.timing.secondsPerFrame,
    videoTrackCount: videoTracks.length,
    audioTrackCount: audioTracks.length,
    videoTracks,
    audioTracks,
  };
}

function selectedPayload(contract, cut, style = "uxp") {
  return contract.targetTracks.map((track) => style === "cep"
    ? {
        type: track.kind,
        trackIndex: track.index,
        name: "recording.mp4",
        start: cut.startFrame * contract.timing.secondsPerFrame,
        end: cut.endFrame * contract.timing.secondsPerFrame,
        isSelected: true,
      }
    : {
        trackType: track.kind,
        trackIndex: track.index,
        name: "recording.mp4",
        startSeconds: cut.startFrame * contract.timing.secondsPerFrame,
        endSeconds: cut.endFrame * contract.timing.secondsPerFrame,
        selected: true,
      });
}

function createFakeAdapter(contract, initial, options = {}) {
  const calls = [];
  const applied = [];
  let current = clone(initial);
  let selected = options.initialSelectedCut
    ? selectedPayload(contract, options.initialSelectedCut, "uxp")
    : [];
  return {
    calls,
    applied,
    async razorAndSelect({cut, script}) {
      calls.push({method: "razor", cut: cut.index, script});
      if (options.timeoutOnRazor && calls.filter((call) => call.method === "razor").length === 1) {
        const error = new Error("Razor response timed out");
        error.code = "ETIMEDOUT";
        throw error;
      }
      selected = selectedPayload(contract, cut, "uxp");
      return {
        cutIndex: cut.index,
        startTimecode: frameToDisplayTimecode(cut.startFrame, contract.timecodeDisplay),
        endTimecode: frameToDisplayTimecode(cut.endFrame, contract.timecodeDisplay),
        selectedCount: 2,
        selected: selectedPayload(contract, cut, "cep"),
      };
    },
    async readSelectedClips({phase}) {
      calls.push({method: "selection", phase});
      return clone(selected);
    },
    async removeSelectedClips({cut, ripple}) {
      calls.push({method: "remove", cut: cut.index});
      assert.equal(ripple, true);
      applied.push(cut);
      current = structureAfterCuts(initial, contract, applied, options.mutateNonTarget === true);
      selected = options.keepSurvivingSelectionAfterRemove === true
        ? [{
            trackType: "video",
            trackIndex: 0,
            name: "recording.mp4",
            startSeconds: 0,
            endSeconds: cut.startFrame * contract.timing.secondsPerFrame,
            selected: true,
          }]
        : [];
      if (options.timeoutOnRemove && calls.filter((call) => call.method === "remove").length === 1) {
        const error = new Error("Remove response timed out after an uncertain mutation");
        error.code = "ETIMEDOUT";
        throw error;
      }
      return {
        removed: true,
        ripple: true,
        count: 2,
        items: contract.targetTracks.map((track) => ({
          trackType: track.kind,
          trackIndex: track.index,
          name: "recording.mp4",
        })),
      };
    },
    async readStructure({phase, diagnostic}) {
      calls.push({method: "structure", phase, diagnostic: diagnostic === true});
      return clone(current);
    },
  };
}

async function testDryRunHasNoAdapterOrPremiereDependency() {
  const manifest = baseManifest();
  const contract = validateDirectRazorManifest(manifest);
  const plan = createDirectRazorExecutionPlan(contract, {
    dryRun: true,
    batchSize: 2,
    batchPauseMs: 0,
  });
  let called = false;
  const adapter = new Proxy({}, {get() { called = true; throw new Error("adapter touched"); }});
  const result = await runDirectRazorExecution({contract, plan, adapter});
  assert.equal(result.outcome, "dry_run");
  assert.equal(result.writeAttemptCount, 0);
  assert.equal(called, false);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "direct-razor-self-test-"));
  const manifestPath = path.join(tempRoot, "cuts.json");
  try {
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const child = spawnSync(
      process.execPath,
      [CLI_PATH, "--cuts", manifestPath, "--dry-run", "--batch-size", "2", "--batch-pause-ms", "0"],
      {
        cwd: path.resolve(HERE, ".."),
        encoding: "utf8",
        env: {...process.env, PREMIERE_MCP_ROOT: "Z:\\definitely-not-a-premiere-runtime"},
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const payload = JSON.parse(child.stdout);
    assert.equal(payload.premiereConnected, false);
    assert.equal(payload.writeAttemptCount, 0);
    assert.deepEqual(payload.executionOrder.map((cut) => cut.index), [2, 1, 0]);
  } finally {
    fs.rmSync(tempRoot, {recursive: true, force: true});
  }
}

function testDisplayTimecodeAndRazorScript() {
  const contract = validateDirectRazorManifest(baseManifest());
  assert.equal(frameToDisplayTimecode(323, contract.timecodeDisplay), "00:00:10:23");
  assert.equal(
    frameToDisplayTimecode(1_800, {nominalFps: 30, dropFrame: true}),
    "00:01:00;02",
  );
  assert.equal(
    frameToDisplayTimecode(17_982, {nominalFps: 30, dropFrame: true}),
    "00:10:00;00",
  );
  assert.equal(
    frameToDisplayTimecode(3_600, {nominalFps: 60, dropFrame: true}),
    "00:01:00;04",
  );
  assert.equal(frameToDisplayTimecode(2_400, {nominalFps: 24, dropFrame: false}), "00:01:40:00");
  assert.equal(frameToDisplayTimecode(3_600, {nominalFps: 60, dropFrame: false}), "00:01:00:00");
  const script = buildDirectRazorExtendScript(contract, contract.cuts[0]);
  assert.match(script, /var startTc = "00:00:03:00"/);
  assert.match(script, /var endTc = "00:00:04:00"/);
  assert.match(script, /qv\.razor\(endTc\)/);
  assert.match(script, /qa\.razor\(startTc\)/);
  assert.doesNotMatch(script, /setInPoint|setOutPoint|\.extract\(/);
  assert.doesNotMatch(script, /razor\([^)]*(?:ticksPerFrame|startTicks|endTicks)/i);
  assert.doesNotMatch(script, /8467200000/);
}

function testExactTwoSelectionGate() {
  const contract = validateDirectRazorManifest(baseManifest());
  const cut = contract.cuts[0];
  const payload = {
    cutIndex: cut.index,
    startTimecode: "00:00:03:00",
    endTimecode: "00:00:04:00",
    selectedCount: 2,
    selected: selectedPayload(contract, cut, "cep"),
  };
  assert.equal(verifyDirectRazorSelection(payload, contract, cut), true);
  assert.equal(verifySelectedClipsReadback(selectedPayload(contract, cut, "uxp"), contract, cut), true);
  assert.throws(
    () => verifySelectedClipsReadback(
      [...selectedPayload(contract, cut, "uxp"), selectedPayload(contract, cut, "uxp")[0]],
      contract,
      cut,
    ),
    /exactly 2/,
  );
}

async function testReverseSerialBatchesAndInvariant() {
  const contract = validateDirectRazorManifest(baseManifest());
  const plan = createDirectRazorExecutionPlan(contract, {
    dryRun: false,
    batchSize: 2,
    batchPauseMs: 1000,
  });
  const initial = baseStructure();
  const adapter = createFakeAdapter(contract, initial);
  const pauses = [];
  const progress = [];
  const result = await runDirectRazorExecution({
    contract,
    plan,
    adapter,
    initialStructure: initial,
    pause: async (milliseconds) => pauses.push(milliseconds),
    onBatchComplete: async (entry) => progress.push(entry),
  });
  assert.equal(result.ok, true);
  assert.equal(result.completedCutCount, 3);
  assert.equal(result.completedBatchCount, 2);
  assert.equal(result.writeAttemptCount, 6);
  assert.deepEqual(adapter.calls.filter((call) => call.method === "razor").map((call) => call.cut), [2, 1, 0]);
  assert.deepEqual(adapter.calls.filter((call) => call.method === "remove").map((call) => call.cut), [2, 1, 0]);
  assert.deepEqual(pauses, [1000]);
  assert.equal(adapter.calls.filter((call) => call.method === "structure").length, 2);
  assert.deepEqual(progress.map((entry) => entry.completedCutCount), [2, 3]);
  assert.equal(result.batchResults.every((batch) => batch.verification.ok), true);
}

async function testSurvivingSelectionAfterRemovalDoesNotStopExecution() {
  const contract = validateDirectRazorManifest(baseManifest());
  const plan = createDirectRazorExecutionPlan(contract, {
    dryRun: false,
    batchSize: 3,
    batchPauseMs: 250,
  });
  const initial = baseStructure();
  const adapter = createFakeAdapter(contract, initial, {keepSurvivingSelectionAfterRemove: true});
  const result = await runDirectRazorExecution({
    contract,
    plan,
    adapter,
    initialStructure: initial,
    pause: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.completedCutCount, 3);
  assert.deepEqual(
    adapter.calls.filter((call) => call.method === "selection").map((call) => call.phase),
    ["before_remove", "before_remove", "before_remove"],
  );
}

async function testResumeSelectedFirstSkipsDuplicateRazorWrite() {
  const contract = validateDirectRazorManifest(baseManifest());
  const plan = createDirectRazorExecutionPlan(contract, {
    dryRun: false,
    batchSize: 3,
    batchPauseMs: 250,
    resumeSelectedFirst: true,
  });
  const initial = baseStructure();
  const adapter = createFakeAdapter(contract, initial, {initialSelectedCut: plan.executionCuts[0]});
  const result = await runDirectRazorExecution({
    contract,
    plan,
    adapter,
    initialStructure: initial,
    pause: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.completedCutCount, 3);
  assert.equal(result.writeAttemptCount, 5);
  assert.deepEqual(adapter.calls.filter((call) => call.method === "razor").map((call) => call.cut), [1, 0]);
  assert.deepEqual(adapter.calls.filter((call) => call.method === "remove").map((call) => call.cut), [2, 1, 0]);
  assert.equal(result.batchResults[0].cuts[0].razorSkippedFromVerifiedSelection, true);

  const missingSelection = createFakeAdapter(contract, initial);
  const stopped = await runDirectRazorExecution({
    contract,
    plan,
    adapter: missingSelection,
    initialStructure: initial,
    pause: async () => {},
  });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.stop.phase, "selection_readback");
  assert.equal(stopped.writeAttemptCount, 0);
  assert.equal(missingSelection.calls.some((call) => call.method === "remove"), false);
}

async function testReadOnlyStructureRetryNeverRepeatsWrites() {
  let reads = 0;
  const pauses = [];
  const payload = await retryDirectRazorReadOnly({
    read: async () => {
      reads += 1;
      if (reads < 3) throw new Error("Unexpected end of JSON input");
      return {durationSeconds: 10};
    },
    attempts: 3,
    retryPauseMs: 25,
    pause: async (milliseconds, attempt) => pauses.push({milliseconds, attempt}),
  });
  assert.deepEqual(payload, {durationSeconds: 10});
  assert.equal(reads, 3);
  assert.deepEqual(pauses, [{milliseconds: 25, attempt: 1}, {milliseconds: 25, attempt: 2}]);

  let persistentReads = 0;
  await assert.rejects(
    () => retryDirectRazorReadOnly({
      read: async () => {
        persistentReads += 1;
        throw new Error("persistent read failure");
      },
      attempts: 2,
      retryPauseMs: 0,
      pause: async () => {},
    }),
    /persistent read failure/,
  );
  assert.equal(persistentReads, 2);
}

async function testProtectedNonTargetStopsAtBatchCheckpoint() {
  const contract = validateDirectRazorManifest(baseManifest());
  const plan = createDirectRazorExecutionPlan(contract, {
    dryRun: false,
    batchSize: 3,
    batchPauseMs: 250,
  });
  const initial = baseStructure();
  const adapter = createFakeAdapter(contract, initial, {mutateNonTarget: true});
  const result = await runDirectRazorExecution({
    contract,
    plan,
    adapter,
    initialStructure: initial,
    pause: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.stop.primaryReason, "ripple_invariant_failed");
  assert.equal(result.confirmedRemovalCount, 3);
  assert.equal(result.outcome, "partially_completed");
  assert.equal(adapter.calls.filter((call) => call.method === "razor").length, 3);
  assert.equal(adapter.calls.filter((call) => call.method === "remove").length, 3);
  assert.equal(adapter.calls.filter((call) => call.method === "structure").length, 1);
}

async function testTimeoutIsNeverRetriedAndStopsBeforeNextCut() {
  const contract = validateDirectRazorManifest(baseManifest());
  const plan = createDirectRazorExecutionPlan(contract, {
    dryRun: false,
    batchSize: 2,
    batchPauseMs: 250,
  });
  const initial = baseStructure();
  const adapter = createFakeAdapter(contract, initial, {timeoutOnRazor: true});
  const result = await runDirectRazorExecution({
    contract,
    plan,
    adapter,
    initialStructure: initial,
    pause: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.stop.primaryReason, "razor_write_timeout");
  assert.equal(result.writeAttemptCount, 1);
  assert.equal(adapter.calls.filter((call) => call.method === "razor").length, 1);
  assert.equal(adapter.calls.filter((call) => call.method === "remove").length, 0);
  assert.equal(result.stop.beforeNextBatch, true);
}

async function testLostRemoveResponseIsReadBackButNeverRetried() {
  const contract = validateDirectRazorManifest(baseManifest());
  const plan = createDirectRazorExecutionPlan(contract, {
    dryRun: false,
    batchSize: 2,
    batchPauseMs: 250,
  });
  const initial = baseStructure();
  const adapter = createFakeAdapter(contract, initial, {timeoutOnRemove: true});
  const result = await runDirectRazorExecution({
    contract,
    plan,
    adapter,
    initialStructure: initial,
    pause: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.stop.primaryReason, "remove_write_timeout");
  assert.equal(result.stop.writeMayHaveApplied, true);
  assert.equal(result.writeAttemptCount, 2);
  assert.equal(adapter.calls.filter((call) => call.method === "razor").length, 1);
  assert.equal(adapter.calls.filter((call) => call.method === "remove").length, 1);
  assert.equal(result.stop.diagnostic.structure.durationSeconds, 11);
}

function testContentGateRejections() {
  assert.throws(
    () => validateDirectRazorManifest(baseManifest({
      candidatePeakAudit: {energyMode: "rms", bridgeSilenceGapSeconds: 0, suspiciousCutCount: 0},
    })),
    /energyMode='peak'/,
  );
  assert.throws(
    () => validateDirectRazorManifest(baseManifest({
      candidatePeakAudit: {energyMode: "peak", bridgeSilenceGapSeconds: 0.1, suspiciousCutCount: 0},
    })),
    /bridgeSilenceGapSeconds=0/,
  );
  assert.throws(
    () => validateDirectRazorManifest(baseManifest({
      candidatePeakAudit: {energyMode: "peak", bridgeSilenceGapSeconds: 0, suspiciousCutCount: 1},
    })),
    /suspiciousCutCount must be 0/,
  );
  const editorial = baseManifest({
    mode: "semantic-editorial",
    writeReady: false,
  });
  assert.throws(() => validateDirectRazorManifest(editorial), /writeReady=true/);
  assert.throws(
    () => validateDirectRazorManifest({...editorial, writeReady: true}),
    /waveform snap evidence/,
  );
  const accepted = validateDirectRazorManifest({
    ...editorial,
    writeReady: true,
    waveformSnapEvidence: {integerFrameBoundaries: true, allBoundariesSnapped: true},
  });
  assert.equal(accepted.writeReady, true);
}

async function main() {
  await testDryRunHasNoAdapterOrPremiereDependency();
  testDisplayTimecodeAndRazorScript();
  testExactTwoSelectionGate();
  await testReverseSerialBatchesAndInvariant();
  await testSurvivingSelectionAfterRemovalDoesNotStopExecution();
  await testResumeSelectedFirstSkipsDuplicateRazorWrite();
  await testReadOnlyStructureRetryNeverRepeatsWrites();
  await testProtectedNonTargetStopsAtBatchCheckpoint();
  await testTimeoutIsNeverRetriedAndStopsBeforeNextCut();
  await testLostRemoveResponseIsReadBackButNeverRetried();
  testContentGateRejections();
  console.log("Premiere direct Razor cut self-test passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
