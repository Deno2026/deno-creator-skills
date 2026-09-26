import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";

import {buildPremiereDirectCutManifest} from "./lib/premiere-direct-cut-manifest.mjs";
import {validateDirectRazorManifest} from "./lib/premiere-direct-razor-cuts.mjs";

const identity = {
  projectName: "editorial.prproj",
  sequenceName: "Main 30fps",
  sequenceId: "sequence-1",
  sequenceDurationSeconds: 12,
  fps: 30,
  ticksPerFrame: "8467200000",
  timecodeDisplay: {nominalFps: 30, dropFrame: false},
  targetTracks: ["V1", "A1"],
  targetClipNames: ["recording.mp4"],
  captureSha256: "A".repeat(64),
  targetBindingSha256: "B".repeat(64),
  bundleSha256: "C".repeat(64),
};

const waveform = {
  mode: "waveform-only",
  writeReady: true,
  candidatePeakAudit: {
    energyMode: "peak",
    bridgeSilenceGapSeconds: 0,
    suspiciousCutCount: 0,
    auditedCutCount: 2,
    suspiciousPeakThresholdDb: -44,
  },
  waveformSnapEvidence: {integerFrameBoundaries: true, allBoundariesSnapped: true, fps: 30},
  options: {fps: 30, ticksPerFrame: "8467200000", silenceDb: -44},
  captureSha256: identity.captureSha256,
  targetBindingSha256: identity.targetBindingSha256,
  bundleSha256: identity.bundleSha256,
  cuts: [
    {startFrame: 90, endFrame: 120, reason: "verified silence"},
    {startFrame: 240, endFrame: 270, reason: "verified silence"},
  ],
};

const repeatProposal = {
  mode: "premiere_repeat_cut_proposal",
  waveformSafetyBinding: {
    captureSha256: identity.captureSha256,
    targetBindingSha256: identity.targetBindingSha256,
    bundleSha256: identity.bundleSha256,
  },
  semanticBoundaryAudit: {
    energyMode: "peak",
    verifiedCutCount: 1,
    verifiedBoundaryCount: 2,
    interiorPeakAuditCutCount: 0,
  },
  candidates: [
    {
      type: "exact_adjacent_repeat",
      startFrame: 300,
      endFrame: 330,
      reason: "exact repeated take",
      proposalEligible: true,
      reviewRequired: false,
      waveformSafety: {verified: true, startFrame: 300, endFrame: 330},
    },
    {
      type: "single_token_repeat",
      startFrame: 30,
      endFrame: 45,
      reason: "ambiguous emphasis",
      proposalEligible: false,
      reviewRequired: true,
      waveformSafety: {verified: true, startFrame: 30, endFrame: 45},
    },
  ],
};

const manifest = buildPremiereDirectCutManifest({
  identity,
  waveform,
  semantic: [repeatProposal],
});
assert.equal(manifest.mode, "semantic-editorial");
assert.equal(manifest.cutCount, 3);
assert.equal(manifest.summary.semanticEligibleCutCount, 1);
assert.equal(manifest.summary.semanticReviewOnlyCount, 1);
assert.equal(manifest.candidatePeakAudit.auditedCutCount, 2);
assert.equal(manifest.semanticBoundaryAudit.auditedCutCount, 1);
assert.equal(manifest.semanticBoundaryAudit.interiorPeakAuditClaimed, false);
assert.deepEqual(manifest.cuts.map((cut) => [cut.startFrame, cut.endFrame]), [
  [90, 120],
  [240, 270],
  [300, 330],
]);
assert.equal(manifest.cuts.every((cut) => cut.waveformSnapped === true), true);
assert.equal(validateDirectRazorManifest(manifest).writeReady, true);

const merged = buildPremiereDirectCutManifest({
  identity,
  waveform,
  semantic: [{
    mode: "premiere_repeat_cut_proposal",
    waveformSafetyBinding: repeatProposal.waveformSafetyBinding,
    semanticBoundaryAudit: repeatProposal.semanticBoundaryAudit,
    candidates: [{
      type: "immediate_restart",
      startFrame: 110,
      endFrame: 135,
      reason: "overlapping safe restart",
      proposalEligible: true,
      reviewRequired: false,
      waveformSafety: {verified: true, startFrame: 110, endFrame: 135},
    }],
  }],
});
assert.deepEqual(merged.cuts[0].startFrame, 90);
assert.deepEqual(merged.cuts[0].endFrame, 135);
assert.equal(merged.cutCount, 2);

assert.throws(
  () => buildPremiereDirectCutManifest({
    identity,
    waveform: {
      ...waveform,
      candidatePeakAudit: {...waveform.candidatePeakAudit, suspiciousCutCount: 1},
    },
  }),
  /suspicious cuts/,
);
assert.throws(
  () => buildPremiereDirectCutManifest({
    identity,
    waveform,
    semantic: [repeatProposal],
    mode: "waveform-only",
  }),
  /cannot include semantic/,
);
assert.throws(
  () => buildPremiereDirectCutManifest({
    identity,
    waveform: {...waveform, options: {...waveform.options, fps: 29.97}},
  }),
  /fps does not match/,
);
assert.throws(
  () => buildPremiereDirectCutManifest({
    identity,
    waveform: {...waveform, options: {...waveform.options, ticksPerFrame: "8475667200"}},
  }),
  /ticksPerFrame does not match/,
);
assert.throws(
  () => buildPremiereDirectCutManifest({
    identity,
    waveform: {
      ...waveform,
      candidatePeakAudit: {...waveform.candidatePeakAudit, suspiciousPeakThresholdDb: -25},
    },
  }),
  /threshold must equal/,
);
assert.throws(
  () => buildPremiereDirectCutManifest({
    identity: {...identity, timecodeDisplay: undefined},
    waveform,
  }),
  /timecodeDisplay is required/,
);
assert.throws(
  () => buildPremiereDirectCutManifest({
    identity,
    waveform: {...waveform, bundleSha256: "D".repeat(64)},
  }),
  /does not match live identity/,
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "direct-cut-manifest-test-"));
try {
  const identityPath = path.join(tempRoot, "identity.json");
  const waveformPath = path.join(tempRoot, "waveform.json");
  const semanticPath = path.join(tempRoot, "semantic.json");
  const outPath = path.join(tempRoot, "manifest.json");
  fs.writeFileSync(identityPath, JSON.stringify(identity), "utf8");
  fs.writeFileSync(waveformPath, JSON.stringify(waveform), "utf8");
  fs.writeFileSync(semanticPath, JSON.stringify(repeatProposal), "utf8");
  const result = spawnSync(process.execPath, [
    path.resolve("scripts/build-premiere-direct-cut-manifest.mjs"),
    "--identity", identityPath,
    "--waveform", waveformPath,
    "--semantic", semanticPath,
    "--out", outPath,
  ], {encoding: "utf8"});
  assert.equal(result.status, 0, result.stderr);
  const cliManifest = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(cliManifest.cutCount, 3);
  assert.equal(cliManifest.sources.semantic.length, 1);
  assert.equal(validateDirectRazorManifest(cliManifest).mode, "semantic-editorial");
} finally {
  fs.rmSync(tempRoot, {recursive: true, force: true});
}

console.log("Premiere direct cut manifest self-test passed.");
