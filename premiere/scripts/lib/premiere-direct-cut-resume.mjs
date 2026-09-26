import {createHash} from "node:crypto";

import {
  createDirectRazorExecutionPlan,
  validateDirectRazorLivePreflight,
  validateDirectRazorManifest,
} from "./premiere-direct-razor-cuts.mjs";

function fail(message, code = "DIRECT_CUT_RESUME_FAILED", details = null) {
  const error = new Error(message);
  error.code = code;
  if (details !== null) error.details = details;
  throw error;
}

function assert(condition, message, code, details) {
  if (!condition) fail(message, code, details);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function integer(value, label) {
  const parsed = Number(value);
  assert(Number.isInteger(parsed), `${label} must be an integer`);
  return parsed;
}

function sumRemoveFrames(cuts) {
  return cuts.reduce((sum, cut) => sum + cut.removeFrames, 0);
}

function sha256Json(value) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex")
    .toUpperCase();
}

function inferCompletedExecutionPrefix(executionCuts, removedFrames) {
  assert(removedFrames >= 0, "Live sequence is longer than the original cut manifest sequence");
  if (removedFrames === 0) return Object.freeze({completedCount: 0, completedFrames: 0});

  let cumulative = 0;
  for (let index = 0; index < executionCuts.length; index += 1) {
    cumulative += executionCuts[index].removeFrames;
    if (cumulative === removedFrames) {
      return Object.freeze({completedCount: index + 1, completedFrames: cumulative});
    }
    if (cumulative > removedFrames) break;
  }
  fail(
    `Live duration delta ${removedFrames} frames is not an exact completed reverse-cut prefix`,
    "DIRECT_CUT_RESUME_DURATION_MISMATCH",
    {removedFrames},
  );
}

function verifyIdentity(originalContract, placement) {
  const identity = placement?.identity;
  assert(identity && typeof identity === "object", "A validated placement capture identity is required");
  assert(placement.rawStructure && typeof placement.rawStructure === "object", "Placement capture structure is required");
  assert(identity.projectName === originalContract.projectName, "Placement capture project does not match the cut manifest");
  assert(identity.sequenceName === originalContract.sequenceName, "Placement capture sequence name does not match the cut manifest");
  if (originalContract.sequenceId) {
    assert(identity.sequenceId === originalContract.sequenceId, "Placement capture sequence ID does not match the cut manifest");
  }
  assert(Math.abs(Number(identity.fps) - originalContract.timing.fps) <= 0.001, "Placement capture fps does not match the cut manifest");
  if (originalContract.timing.ticksPerFrame !== null) {
    assert(String(identity.ticksPerFrame) === originalContract.timing.ticksPerFrame, "Placement capture ticksPerFrame does not match the cut manifest");
  }
  assert(
    Number(identity.timecodeDisplay?.nominalFps) === originalContract.timecodeDisplay.nominalFps &&
      Boolean(identity.timecodeDisplay?.dropFrame) === originalContract.timecodeDisplay.dropFrame,
    "Placement capture timecode display does not match the cut manifest",
  );
  return identity;
}

export function buildPremiereDirectCutResumeManifest({
  originalManifest,
  placement,
  expectedCompletedCount,
  originalManifestSha256 = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const originalContract = validateDirectRazorManifest(originalManifest);
  const originalPlan = createDirectRazorExecutionPlan(originalContract, {
    dryRun: true,
    batchSize: 8,
    batchPauseMs: 0,
  });
  const identity = verifyIdentity(originalContract, placement);
  const currentFrames = integer(identity.sequenceDurationFrames, "placement.identity.sequenceDurationFrames");
  const removedFrames = originalContract.sequenceDurationFrames - currentFrames;
  const inferred = inferCompletedExecutionPrefix(originalPlan.executionCuts, removedFrames);

  if (expectedCompletedCount !== undefined && expectedCompletedCount !== null) {
    const expected = integer(expectedCompletedCount, "expectedCompletedCount");
    assert(
      expected === inferred.completedCount,
      `Expected ${expected} completed cuts, but live duration proves ${inferred.completedCount}`,
      "DIRECT_CUT_RESUME_COMPLETED_COUNT_MISMATCH",
      {expected, inferred: inferred.completedCount},
    );
  }

  const completedExecutionCuts = originalPlan.executionCuts.slice(0, inferred.completedCount);
  const remainingExecutionCuts = originalPlan.executionCuts.slice(inferred.completedCount);
  assert(remainingExecutionCuts.length > 0, "The original cut manifest is already complete; no resume manifest is needed");

  if (completedExecutionCuts.length > 0) {
    const minimumCompletedStart = Math.min(...completedExecutionCuts.map((cut) => cut.startFrame));
    const maximumRemainingEnd = Math.max(...remainingExecutionCuts.map((cut) => cut.endFrame));
    assert(
      maximumRemainingEnd <= minimumCompletedStart,
      "Completed and remaining cuts do not form a strict reverse-execution boundary",
      "DIRECT_CUT_RESUME_ORDER_MISMATCH",
      {minimumCompletedStart, maximumRemainingEnd},
    );
  }

  const remainingCuts = [...remainingExecutionCuts]
    .sort((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame)
    .map((cut, index) => ({
      ...clone(cut),
      originalIndex: cut.index,
      index,
      removeFrames: cut.endFrame - cut.startFrame,
    }));
  const remainingRemoveFrames = sumRemoveFrames(remainingCuts);
  const manifestHash = originalManifestSha256 || sha256Json(originalManifest);
  const resumeManifest = {
    ...clone(originalManifest),
    generatedAt,
    sequenceDurationSeconds: currentFrames * originalContract.timing.secondsPerFrame,
    cutCount: remainingCuts.length,
    cuts: remainingCuts,
    sources: {
      ...(originalManifest.sources && typeof originalManifest.sources === "object"
        ? clone(originalManifest.sources)
        : {}),
      resumeCapture: {
        source: identity.source ?? "premiere-uxp-read-only-placement-capture",
        generatedAt: identity.generatedAt ?? null,
        captureSha256: placement.captureSha256 ?? identity.captureSha256 ?? null,
        structureSha256: placement.structureSha256 ?? identity.structureSha256 ?? null,
        bundleSha256: placement.bundleSha256 ?? identity.bundleSha256 ?? null,
      },
    },
    resumeEvidence: {
      originalManifestSha256: manifestHash,
      originalSequenceDurationFrames: originalContract.sequenceDurationFrames,
      liveSequenceDurationFrames: currentFrames,
      completedCutCount: inferred.completedCount,
      completedRemoveFrames: inferred.completedFrames,
      remainingCutCount: remainingCuts.length,
      remainingRemoveFrames,
      firstCompletedOriginalIndex: completedExecutionCuts[0]?.index ?? null,
      lastCompletedOriginalIndex: completedExecutionCuts.at(-1)?.index ?? null,
      nextOriginalIndex: remainingExecutionCuts[0]?.index ?? null,
      executionOrder: "strict-reverse",
      coordinateBoundaryVerified: true,
      timelineWrites: 0,
      projectSaved: false,
    },
    summary: {
      ...(originalManifest.summary && typeof originalManifest.summary === "object"
        ? clone(originalManifest.summary)
        : {}),
      combinedCutCount: remainingCuts.length,
      removeFrames: remainingRemoveFrames,
      resumeCompletedCutCount: inferred.completedCount,
      resumeCompletedRemoveFrames: inferred.completedFrames,
      resumeRemainingCutCount: remainingCuts.length,
    },
  };

  const resumeContract = validateDirectRazorManifest(resumeManifest);
  validateDirectRazorLivePreflight(placement.rawStructure, resumeContract);
  assert(
    resumeContract.expectedDurationAfterFrames === originalContract.expectedDurationAfterFrames,
    "Resume manifest final duration does not match the original manifest final duration",
    "DIRECT_CUT_RESUME_FINAL_DURATION_MISMATCH",
  );

  return Object.freeze({
    manifest: resumeManifest,
    originalContract,
    resumeContract,
    completedExecutionCuts: Object.freeze(completedExecutionCuts),
    remainingExecutionCuts: Object.freeze(remainingExecutionCuts),
  });
}

