import assert from "node:assert/strict";

import {
  diffSequenceStructures,
  normalizeSequenceStructure,
  normalizeSequenceStructureStrict,
  normalizeTargetTracks,
  resolveFrameTiming,
} from "./lib/sequence-structure-diff.mjs";
import {normalizePremiereSequenceFingerprint} from "./lib/premiere-sequence-fingerprint.mjs";

const FPS = 30;
const TIMING = resolveFrameTiming({fps: FPS});

function seconds(frames) {
  return frames / FPS;
}

function clip(name, startFrame, endFrame, inPointFrame, outPointFrame, mediaType) {
  const result = {
    name,
    startSeconds: seconds(startFrame),
    endSeconds: seconds(endFrame),
    durationSeconds: seconds(endFrame - startFrame),
    inPointSeconds: seconds(inPointFrame),
    outPointSeconds: seconds(outPointFrame),
    mediaType,
  };
  if (mediaType === "Video") {
    result.enabled = true;
    result.speed = 1;
  }
  return result;
}

function track(index, name, clips) {
  return {
    index,
    name,
    clipCount: clips.length,
    clips,
    isMuted: false,
    isLocked: false,
  };
}

function snapshot(durationFrame, videoTracks, audioTracks) {
  return {
    id: "sequence-1",
    name: "P0 cut fixture",
    durationSeconds: seconds(durationFrame),
    videoTrackCount: videoTracks.length,
    audioTrackCount: audioTracks.length,
    videoTracks,
    audioTracks,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function failureKinds(result) {
  return new Set(result.failures.map((failure) => failure.kind));
}

const before = snapshot(
  300,
  [
    track(0, "Video 1", [
      clip("A.mp4", 0, 150, 0, 150, "Video"),
      clip("B.mp4", 150, 300, 300, 450, "Video"),
    ]),
    track(1, "Video 2", [clip("logo.mov", 0, 30, 0, 30, "Video")]),
  ],
  [
    track(0, "Audio 1", [
      clip("A.mp4", 0, 150, 0, 150, "Audio"),
      clip("B.mp4", 150, 300, 300, 450, "Audio"),
    ]),
    track(1, "Audio 2", [clip("sting.wav", 0, 30, 0, 30, "Audio")]),
  ],
);

const after = snapshot(
  240,
  [
    track(0, "Video 1", [
      clip("A.mp4", 0, 90, 0, 90, "Video"),
      clip("A.mp4", 90, 120, 120, 150, "Video"),
      clip("B.mp4", 120, 180, 300, 360, "Video"),
      clip("B.mp4", 180, 240, 390, 450, "Video"),
    ]),
    track(1, "Video 2", [clip("logo.mov", 0, 30, 0, 30, "Video")]),
  ],
  [
    track(0, "Audio 1", [
      clip("A.mp4", 0, 90, 0, 90, "Audio"),
      clip("A.mp4", 90, 120, 120, 150, "Audio"),
      clip("B.mp4", 120, 180, 300, 360, "Audio"),
      clip("B.mp4", 180, 240, 390, 450, "Audio"),
    ]),
    track(1, "Audio 2", [clip("sting.wav", 0, 30, 0, 30, "Audio")]),
  ],
);

const contract = {
  timing: TIMING,
  targetTracks: ["V1", "A1"],
  cuts: [
    {startFrame: 90, endFrame: 120},
    {startFrame: 210, endFrame: 240},
  ],
  expectedDurationDeltaFrames: -60,
};

const normalCut = diffSequenceStructures(before, after, contract);
assert.equal(normalCut.ok, true, JSON.stringify(normalCut.failures, null, 2));
assert.deepEqual(normalCut.changedTracks, ["audio:0", "video:0"]);
assert.equal(normalCut.observedDurationDeltaFrames, -60);

const nonTargetChanged = clone(after);
nonTargetChanged.videoTracks[1].clips[0] = clip("logo.mov", 1, 31, 0, 30, "Video");
nonTargetChanged.audioTracks[1].clips[0] = clip("sting.wav", 1, 31, 0, 30, "Audio");
const nonTargetResult = diffSequenceStructures(before, nonTargetChanged, contract);
assert.equal(nonTargetResult.ok, false);
assert.equal(
  nonTargetResult.failures.filter((failure) => failure.kind === "non_target_track_changed").length,
  2,
);

const retimedNonTarget = clone(before);
retimedNonTarget.videoTracks[1].clips[0].inPointSeconds = 4.769417475725938;
retimedNonTarget.videoTracks[1].clips[0].outPointSeconds = 5.769417475725938;
retimedNonTarget.videoTracks[1].clips[0].speed = 0.7862595419847328;
const retimedNormalized = normalizeSequenceStructure(retimedNonTarget, TIMING);
assert.equal(retimedNormalized.tracks.find((track) => track.key === "video:1").clips[0].inPointFrame, 143.082524);

const durationMismatch = clone(after);
durationMismatch.durationSeconds = seconds(241);
const durationResult = diffSequenceStructures(before, durationMismatch, contract);
assert.equal(durationResult.ok, false);
assert(failureKinds(durationResult).has("duration_delta_mismatch"));
assert.equal(durationResult.observedDurationDeltaFrames, -59);

const clipTimingMismatch = clone(after);
clipTimingMismatch.videoTracks[0].clips[2] = clip("B.mp4", 121, 180, 300, 360, "Video");
const clipTimingResult = diffSequenceStructures(before, clipTimingMismatch, contract);
assert.equal(clipTimingResult.ok, false);
assert(failureKinds(clipTimingResult).has("target_track_mismatch"));

assert.deepEqual(normalizeTargetTracks("V1,A1,video:0"), ["audio:0", "video:0"]);
assert.equal(normalizeSequenceStructure(before, TIMING).durationFrames, 300);

function withStrictClipIdentity(value) {
  const result = clone(value);
  for (const [kind, tracks] of [
    ["video", result.videoTracks],
    ["audio", result.audioTracks],
  ]) {
    for (let trackPosition = 0; trackPosition < tracks.length; trackPosition += 1) {
      for (let clipPosition = 0; clipPosition < tracks[trackPosition].clips.length; clipPosition += 1) {
        const item = tracks[trackPosition].clips[clipPosition];
        item.index = clipPosition;
        item.nodeId = `${kind}-${trackPosition}-${clipPosition}`;
      }
    }
  }
  return result;
}

const strictBeforeSnapshot = withStrictClipIdentity(before);
const strictAfterSnapshot = clone(strictBeforeSnapshot);
strictAfterSnapshot.audioTracks[0].clips[0].nodeId = "audio-0-replaced";
const strictBefore = normalizeSequenceStructureStrict(strictBeforeSnapshot, TIMING);
const strictAfter = normalizeSequenceStructureStrict(strictAfterSnapshot, TIMING);
assert.notDeepEqual(strictAfter, strictBefore);
assert.equal(strictBefore.tracks.find((item) => item.key === "audio:0").clips[0].index, 0);

// 2026-09-27: a sequence that ends on a sample-accurate BGM tail has an off-grid duration. Both structure libraries accept it only
// when an audio clip ends exactly there (the Level applier, caption apply, and overlay placement all normalize the live structure).
const bgmTail = clone(before);
const tailEndFrames = 300.44;
bgmTail.audioTracks[1].clips.push({
  name: "bgm.mp3",
  startSeconds: seconds(200),
  endSeconds: tailEndFrames / FPS,
  durationSeconds: (tailEndFrames - 200) / FPS,
  inPointSeconds: 0,
  outPointSeconds: (tailEndFrames - 200) / FPS,
  mediaType: "Audio",
});
bgmTail.audioTracks[1].clipCount = 2;
bgmTail.durationSeconds = tailEndFrames / FPS;
assert.equal(normalizeSequenceStructure(bgmTail, TIMING).durationFrames, 300.44);
const bgmTailStrictA = normalizeSequenceStructureStrict(withStrictClipIdentity(bgmTail), TIMING);
const bgmTailStrictB = normalizeSequenceStructureStrict(withStrictClipIdentity(clone(bgmTail)), TIMING);
assert.deepEqual(bgmTailStrictB, bgmTailStrictA);
assert.equal(normalizePremiereSequenceFingerprint(bgmTail, FPS).durationFrames, 300.44);

const strayDuration = clone(before);
strayDuration.durationSeconds = tailEndFrames / FPS;
assert.throws(() => normalizeSequenceStructure(strayDuration, TIMING), /not frame-aligned/);
assert.throws(() => normalizePremiereSequenceFingerprint(strayDuration, FPS), /not frame-aligned/);
assert.equal(normalizePremiereSequenceFingerprint(before, FPS).durationFrames, 300);

console.log(JSON.stringify({
  ok: true,
  fixtureCount: 7,
  checks: {
    normalCut: normalCut.ok,
    nonTargetAudioVideoChangeRejected: !nonTargetResult.ok,
    oneFrameDurationMismatchRejected: !durationResult.ok,
    clipTimingMismatchRejected: !clipTimingResult.ok,
    strictNodeIdMutationDetected: JSON.stringify(strictBefore) !== JSON.stringify(strictAfter),
    bgmTailDurationAccepted: true,
    offGridDurationWithoutAudioEndRejected: true,
  },
}, null, 2));
