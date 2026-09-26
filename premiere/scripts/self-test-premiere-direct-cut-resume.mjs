import assert from "node:assert/strict";

import {buildPremiereDirectCutResumeManifest} from "./lib/premiere-direct-cut-resume.mjs";

const FPS = 30;
const SPF = 1 / FPS;

function clip(startFrame, endFrame, inFrame = startFrame, outFrame = endFrame) {
  return {
    name: "recording.mp4",
    startSeconds: startFrame * SPF,
    endSeconds: endFrame * SPF,
    durationSeconds: (endFrame - startFrame) * SPF,
    inPointSeconds: inFrame * SPF,
    outPointSeconds: outFrame * SPF,
    mediaType: "clip",
    enabled: true,
    speed: 1,
  };
}

function manifest() {
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
    candidatePeakAudit: {energyMode: "peak", bridgeSilenceGapSeconds: 0, suspiciousCutCount: 0},
    cutCount: 3,
    cuts: [
      {index: 0, startFrame: 90, endFrame: 120, waveformSnapped: true},
      {index: 1, startFrame: 240, endFrame: 270, waveformSnapped: true},
      {index: 2, startFrame: 300, endFrame: 330, waveformSnapped: true},
    ],
    summary: {combinedCutCount: 3, removeFrames: 90},
  };
}

function rawStructure(durationFrames = 330, targetEndFrame = 330) {
  const fragments = targetEndFrame >= 330
    ? [clip(0, 300, 0, 300), clip(300, 330, 330, 360)]
    : [clip(0, targetEndFrame, 0, targetEndFrame)];
  const track = (kind) => ({
    index: 0,
    name: `${kind} 1`,
    isMuted: false,
    isLocked: false,
    clipCount: fragments.length,
    clips: fragments,
  });
  return {
    id: "seq-1",
    name: "test-sequence",
    durationSeconds: durationFrames * SPF,
    videoTrackCount: 1,
    audioTrackCount: 1,
    videoTracks: [track("Video")],
    audioTracks: [track("Audio")],
  };
}

function placement(durationFrames = 330, targetEndFrame = 330) {
  return {
    identity: {
      source: "premiere-uxp-read-only-placement-capture",
      generatedAt: "2026-08-30T00:00:00.000Z",
      projectName: "test-project.prproj",
      sequenceName: "test-sequence",
      sequenceId: "seq-1",
      sequenceDurationFrames: durationFrames,
      fps: FPS,
      ticksPerFrame: "8467200000",
      timecodeDisplay: {nominalFps: 30, dropFrame: false},
      captureSha256: "A".repeat(64),
      structureSha256: "B".repeat(64),
      bundleSha256: "C".repeat(64),
    },
    rawStructure: rawStructure(durationFrames, targetEndFrame),
    captureSha256: "A".repeat(64),
    structureSha256: "B".repeat(64),
    bundleSha256: "C".repeat(64),
  };
}

function main() {
  const result = buildPremiereDirectCutResumeManifest({
    originalManifest: manifest(),
    placement: placement(),
    expectedCompletedCount: 1,
    originalManifestSha256: "D".repeat(64),
    generatedAt: "2026-08-30T00:01:00.000Z",
  });
  assert.equal(result.manifest.resumeEvidence.completedCutCount, 1);
  assert.equal(result.manifest.resumeEvidence.completedRemoveFrames, 30);
  assert.equal(result.manifest.resumeEvidence.nextOriginalIndex, 1);
  assert.equal(result.manifest.cutCount, 2);
  assert.deepEqual(result.manifest.cuts.map((cut) => cut.originalIndex), [0, 1]);
  assert.deepEqual(result.manifest.cuts.map((cut) => cut.index), [0, 1]);
  assert.equal(result.resumeContract.sequenceDurationFrames, 330);
  assert.equal(result.resumeContract.expectedDurationAfterFrames, 270);
  assert.equal(result.manifest.resumeEvidence.timelineWrites, 0);
  assert.equal(result.manifest.resumeEvidence.projectSaved, false);

  assert.throws(
    () => buildPremiereDirectCutResumeManifest({
      originalManifest: manifest(),
      placement: placement(329),
      expectedCompletedCount: 1,
    }),
    /not an exact completed reverse-cut prefix/,
  );
  assert.throws(
    () => buildPremiereDirectCutResumeManifest({
      originalManifest: manifest(),
      placement: placement(),
      expectedCompletedCount: 2,
    }),
    /live duration proves 1/,
  );
  assert.throws(
    () => buildPremiereDirectCutResumeManifest({
      originalManifest: manifest(),
      placement: placement(330, 200),
      expectedCompletedCount: 1,
    }),
    /not covered by exactly one authorized clip/,
  );
  console.log("Premiere direct cut resume self-test passed.");
}

main();

