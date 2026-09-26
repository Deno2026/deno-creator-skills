import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

import {
  buildPremiereDirectCutInputs,
  selectDirectCutTargetDescriptors,
  writePremiereDirectCutInputsAtomically,
} from "./lib/premiere-direct-cut-inputs.mjs";
import {
  DIRECT_CUT_CAPTURE_TOOL_NAMES,
  parseArgs,
} from "./capture-premiere-direct-cut-inputs.mjs";
import {buildPremiereDirectCutManifest} from "./lib/premiere-direct-cut-manifest.mjs";
import {validateDirectRazorManifest} from "./lib/premiere-direct-razor-cuts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(HERE, "capture-premiere-direct-cut-inputs.mjs");
const TPF_30 = 8_467_200_000;
const TPF_2997 = 8_475_667_200;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function structureClip({
  index,
  nodeId,
  name,
  startSeconds,
  endSeconds,
  inPointSeconds = 0,
}) {
  return {
    index,
    nodeId,
    name,
    startSeconds,
    endSeconds,
    durationSeconds: endSeconds - startSeconds,
    inPointSeconds,
    outPointSeconds: inPointSeconds + endSeconds - startSeconds,
    mediaType: "clip",
    enabled: true,
    speed: 1,
  };
}

function propertyFor(descriptor, mediaPath, projectItemId = "item-recording", overrides = {}) {
  return {
    nodeId: descriptor.nodeId,
    name: descriptor.name,
    trackType: descriptor.kind,
    trackIndex: descriptor.trackIndex,
    clipIndex: descriptor.clipIndex,
    startSeconds: descriptor.clip.startSeconds,
    endSeconds: descriptor.clip.endSeconds,
    durationSeconds: descriptor.clip.durationSeconds,
    inPointSeconds: descriptor.clip.inPointSeconds,
    outPointSeconds: descriptor.clip.outPointSeconds,
    enabled: true,
    speed: 1,
    reverse: false,
    projectItemId,
    mediaPath,
    projectItem: {
      id: projectItemId,
      nodeId: projectItemId,
      name: descriptor.name,
      mediaPath,
      offline: false,
    },
    ...overrides,
  };
}

function baseCapture(mediaPath, {
  fps = 30,
  ticksPerFrame = TPF_30,
  videoDisplayFormat = 4,
  durationSeconds = 20,
} = {}) {
  const introVideo = structureClip({
    index: 0,
    nodeId: "intro-v",
    name: "intro.mov",
    startSeconds: 0,
    endSeconds: 2,
  });
  const introAudio = structureClip({
    index: 0,
    nodeId: "intro-a",
    name: "intro.wav",
    startSeconds: 0,
    endSeconds: 2,
  });
  const targetVideo = structureClip({
    index: 0,
    nodeId: "target-v",
    name: "recording.mp4",
    startSeconds: 2,
    endSeconds: durationSeconds,
  });
  const targetAudio = structureClip({
    index: 0,
    nodeId: "target-a",
    name: "recording.mp4",
    startSeconds: 2,
    endSeconds: durationSeconds,
  });
  const structure = {
    name: "30fps edit",
    id: "sequence-1",
    durationSeconds,
    videoTrackCount: 2,
    audioTrackCount: 2,
    videoTracks: [
      {index: 0, name: "Intro V", clipCount: 1, clips: [introVideo], isMuted: false, isLocked: null},
      {index: 1, name: "Target V", clipCount: 1, clips: [targetVideo], isMuted: false, isLocked: null},
    ],
    audioTracks: [
      {index: 0, name: "Intro A", clipCount: 1, clips: [introAudio], isMuted: false, isLocked: null},
      {index: 1, name: "Target A", clipCount: 1, clips: [targetAudio], isMuted: false, isLocked: null},
    ],
  };
  const target = {name: "recording.mp4"};
  const descriptors = selectDirectCutTargetDescriptors(structure, target);
  return {
    project: {
      name: "episode.prproj",
      path: "E:\\Projects\\episode.prproj",
      id: "project-1",
      activeSequence: {name: structure.name, id: structure.id},
    },
    settings: {
      name: structure.name,
      id: structure.id,
      frameRate: fps,
      ticksPerFrame,
      timebase: String(ticksPerFrame),
      videoDisplayFormat,
    },
    structure,
    clipProperties: {
      [descriptors.video.nodeId]: propertyFor(descriptors.video, mediaPath),
      [descriptors.audio.nodeId]: propertyFor(descriptors.audio, mediaPath),
    },
  };
}

function build(capture, target = {name: "recording.mp4"}) {
  return buildPremiereDirectCutInputs({
    firstCapture: clone(capture),
    secondCapture: clone(capture),
    target,
    generatedAt: "2026-08-28T00:00:00.000Z",
  });
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function testIntroIsExcludedAndExactTargetIsBound(mediaPath) {
  const capture = baseCapture(mediaPath);
  const bundle = build(capture);
  assert.equal(bundle.live.projectName, "episode.prproj");
  assert.equal(bundle.live.sequenceName, "30fps edit");
  assert.equal(bundle.live.fps, 30);
  assert.equal(bundle.live.ticksPerFrame, String(TPF_30));
  assert.deepEqual(bundle.live.timecodeDisplay, {
    code: 4,
    label: "30 Timecode",
    nominalFps: 30,
    dropFrame: false,
  });
  assert.deepEqual(bundle.live.targetTracks, ["V2", "A2"]);
  assert.deepEqual(bundle.live.targetClipNames, ["recording.mp4"]);
  assert.equal(bundle.clips.clips.length, 1);
  assert.equal(bundle.clips.clips[0].media, path.resolve(mediaPath));
  assert.equal(bundle.clips.clips[0].timelineStart, 2);
  assert.equal(bundle.clips.clips[0].timelineEnd, 20);
  assert.equal(JSON.stringify(bundle.clips).includes("intro"), false);
  assert.equal(bundle.live.captureSha256, bundle.clips.captureSha256);
  assert.equal(bundle.live.bundleSha256, bundle.clips.bundleSha256);
  assert.match(bundle.bundleSha256, /^[0-9A-F]{64}$/);
  const manifest = buildPremiereDirectCutManifest({
    identity: bundle.live,
    waveform: {
      mode: "waveform-only",
      writeReady: true,
      candidatePeakAudit: {
        energyMode: "peak",
        bridgeSilenceGapSeconds: 0,
        suspiciousCutCount: 0,
        suspiciousPeakThresholdDb: -44,
      },
      options: {fps: 30, ticksPerFrame: String(TPF_30), silenceDb: -44},
      waveformSnapEvidence: {integerFrameBoundaries: true, allBoundariesSnapped: true, fps: 30},
      captureSha256: bundle.live.captureSha256,
      targetBindingSha256: bundle.live.targetBindingSha256,
      bundleSha256: bundle.live.bundleSha256,
      cuts: [{startFrame: 90, endFrame: 120, reason: "fixture silence"}],
    },
  });
  const directContract = validateDirectRazorManifest(manifest);
  assert.equal(directContract.projectName, "episode.prproj");
  assert.deepEqual(directContract.targetTrackKeys, ["audio:1", "video:1"]);
  assert.deepEqual(directContract.timecodeDisplay, {nominalFps: 30, dropFrame: false});

  const byTracks = build(capture, {videoTrackIndex: 1, audioTrackIndex: 1});
  assert.deepEqual(byTracks.live.targetTracks, ["V2", "A2"]);
  assert.deepEqual(byTracks.live.targetClipNames, ["recording.mp4"]);

  const sameTracks = baseCapture(mediaPath);
  const targetVideo = sameTracks.structure.videoTracks[1].clips[0];
  const targetAudio = sameTracks.structure.audioTracks[1].clips[0];
  targetVideo.index = 1;
  targetAudio.index = 1;
  sameTracks.structure.videoTracks[0].clips.push(targetVideo);
  sameTracks.structure.videoTracks[0].clipCount = 2;
  sameTracks.structure.audioTracks[0].clips.push(targetAudio);
  sameTracks.structure.audioTracks[0].clipCount = 2;
  sameTracks.structure.videoTracks.splice(1, 1);
  sameTracks.structure.audioTracks.splice(1, 1);
  sameTracks.structure.videoTrackCount = 1;
  sameTracks.structure.audioTrackCount = 1;
  Object.assign(sameTracks.clipProperties["target-v"], {trackIndex: 0, clipIndex: 1});
  Object.assign(sameTracks.clipProperties["target-a"], {trackIndex: 0, clipIndex: 1});
  const sameTrackBundle = build(sameTracks);
  assert.deepEqual(sameTrackBundle.live.targetTracks, ["V1", "A1"]);
  assert.equal(sameTrackBundle.clips.clips.length, 1);
  assert.equal(JSON.stringify(sameTrackBundle.clips).includes("intro"), false);
  expectCode(
    () => build(sameTracks, {videoTrackIndex: 0, audioTrackIndex: 0}),
    "DIRECT_CUT_TARGET_AMBIGUOUS",
  );
}

function testFractionalDropAndNonDropAreExplicit(mediaPath) {
  const durationSeconds = 300 * (TPF_2997 / 254_016_000_000);
  for (const [videoDisplayFormat, expectedCode, dropFrame] of [
    [2, 2, true],
    [3, 3, false],
    [102, 2, true],
    [103, 3, false],
  ]) {
    const capture = baseCapture(mediaPath, {
      fps: 30_000 / 1_001,
      ticksPerFrame: TPF_2997,
      videoDisplayFormat,
      durationSeconds,
    });
    capture.structure.videoTracks[1].clips[0].startSeconds = 0;
    capture.structure.videoTracks[1].clips[0].durationSeconds = durationSeconds;
    capture.structure.videoTracks[1].clips[0].outPointSeconds = durationSeconds;
    capture.structure.audioTracks[1].clips[0].startSeconds = 0;
    capture.structure.audioTracks[1].clips[0].durationSeconds = durationSeconds;
    capture.structure.audioTracks[1].clips[0].outPointSeconds = durationSeconds;
    for (const nodeId of ["target-v", "target-a"]) {
      Object.assign(capture.clipProperties[nodeId], {
        startSeconds: 0,
        endSeconds: durationSeconds,
        durationSeconds,
        inPointSeconds: 0,
        outPointSeconds: durationSeconds,
      });
    }
    const bundle = build(capture);
    assert.ok(Math.abs(bundle.live.fps - 30_000 / 1_001) < 1e-9);
    assert.equal(bundle.live.ticksPerFrame, String(TPF_2997));
    assert.equal(bundle.live.timecodeDisplay.code, expectedCode);
    assert.equal(bundle.live.timecodeDisplay.nominalFps, 30);
    assert.equal(bundle.live.timecodeDisplay.dropFrame, dropFrame);
    assert.deepEqual(bundle.clips.timecodeDisplay, bundle.live.timecodeDisplay);
    assert.equal(bundle.clips.fps, bundle.live.fps);
    assert.equal(bundle.clips.ticksPerFrame, bundle.live.ticksPerFrame);
  }
}

function testUxpDisplayEnumIsCanonicalized(mediaPath) {
  const bundle = build(baseCapture(mediaPath, {videoDisplayFormat: 104}));
  assert.deepEqual(bundle.live.timecodeDisplay, {
    code: 4,
    label: "30 Timecode",
    nominalFps: 30,
    dropFrame: false,
  });
}

function testAmbiguityFailsClosed(mediaPath) {
  const capture = baseCapture(mediaPath);
  const duplicate = clone(capture.structure.videoTracks[1]);
  duplicate.index = 2;
  duplicate.name = "Duplicate target V";
  duplicate.clips[0].nodeId = "target-v-duplicate";
  capture.structure.videoTracks.push(duplicate);
  capture.structure.videoTrackCount = 3;
  expectCode(
    () => build(capture),
    "DIRECT_CUT_TARGET_AMBIGUOUS",
  );

  duplicate.clips[0].startSeconds = 4;
  duplicate.clips[0].endSeconds = 8;
  duplicate.clips[0].durationSeconds = 4;
  duplicate.clips[0].inPointSeconds = 10;
  duplicate.clips[0].outPointSeconds = 14;
  const selected = selectDirectCutTargetDescriptors(capture.structure, {
    name: "recording.mp4",
    timelineStartSeconds: 2,
  });
  assert.equal(selected.video.nodeId, "target-v");
  assert.equal(selected.audio.nodeId, "target-a");
}

function testLinkedIntervalAndSourceMismatchFail(mediaPath, otherMediaPath) {
  const interval = baseCapture(mediaPath);
  interval.structure.audioTracks[1].clips[0].endSeconds -= 1;
  interval.structure.audioTracks[1].clips[0].durationSeconds -= 1;
  interval.structure.audioTracks[1].clips[0].outPointSeconds -= 1;
  Object.assign(interval.clipProperties["target-a"], {
    endSeconds: 19,
    durationSeconds: 17,
    outPointSeconds: 17,
  });
  expectCode(() => build(interval), "DIRECT_CUT_TARGET_INTERVAL_MISMATCH");

  const source = baseCapture(mediaPath);
  source.clipProperties["target-a"].mediaPath = otherMediaPath;
  source.clipProperties["target-a"].projectItem.mediaPath = otherMediaPath;
  expectCode(() => build(source), "DIRECT_CUT_TARGET_SOURCE_MISMATCH");

  const projectItem = baseCapture(mediaPath);
  projectItem.clipProperties["target-a"].projectItemId = "different-item";
  projectItem.clipProperties["target-a"].projectItem.id = "different-item";
  expectCode(() => build(projectItem), "DIRECT_CUT_TARGET_SOURCE_MISMATCH");
}

function testMissingMediaAndChangingIdentityFail(mediaPath, tempRoot) {
  const missing = baseCapture(path.join(tempRoot, "not-there.mp4"));
  expectCode(() => build(missing), "DIRECT_CUT_TARGET_MEDIA_MISSING");

  const first = baseCapture(mediaPath);
  const second = clone(first);
  second.project.activeSequence.id = "different-sequence";
  second.settings.id = "different-sequence";
  second.structure.id = "different-sequence";
  expectCode(
    () => buildPremiereDirectCutInputs({
      firstCapture: first,
      secondCapture: second,
      target: {name: "recording.mp4"},
    }),
    "DIRECT_CUT_CAPTURE_CHANGED",
  );
}

function testDisplayMismatchFails(mediaPath) {
  const capture = baseCapture(mediaPath, {videoDisplayFormat: 2});
  expectCode(() => build(capture), "DIRECT_CUT_DISPLAY_FPS_MISMATCH");
  capture.settings.videoDisplayFormat = 9;
  expectCode(() => build(capture), "DIRECT_CUT_UNSUPPORTED_DISPLAY_FORMAT");
}

function testAtomicOutputAndNoOverwrite(mediaPath, tempRoot) {
  const bundle = build(baseCapture(mediaPath));
  const outDir = path.join(tempRoot, "captured");
  const written = writePremiereDirectCutInputsAtomically({outDir, bundle});
  assert.equal(fs.existsSync(written.livePath), true);
  assert.equal(fs.existsSync(written.clipsPath), true);
  const live = JSON.parse(fs.readFileSync(written.livePath, "utf8"));
  const clips = JSON.parse(fs.readFileSync(written.clipsPath, "utf8"));
  assert.equal(live.bundleSha256, bundle.bundleSha256);
  assert.equal(clips.bundleSha256, bundle.bundleSha256);
  assert.match(written.liveSha256, /^[0-9A-F]{64}$/);
  assert.match(written.clipsSha256, /^[0-9A-F]{64}$/);
  expectCode(
    () => writePremiereDirectCutInputsAtomically({outDir, bundle}),
    "DIRECT_CUT_OUTPUT_EXISTS",
  );
  const staged = fs.readdirSync(tempRoot).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(staged, []);
}

function testCliSurfaceIsReadOnlyAndHelpNeedsNoPremiere() {
  assert.deepEqual(DIRECT_CUT_CAPTURE_TOOL_NAMES, [
    "get_project_info",
    "get_sequence_settings",
    "get_sequence_structure",
    "get_clip_properties",
  ]);
  assert.equal(
    DIRECT_CUT_CAPTURE_TOOL_NAMES.some((name) => /^(?:save|set|remove|delete|razor|execute)_/i.test(name)),
    false,
  );
  const parsed = parseArgs([
    "--target-name", "recording.mp4",
    "--timeline-start", "2",
    "--video-track", "1",
    "--audio-track", "1",
    "--out-dir", "tmp/capture",
  ]);
  assert.equal(parsed.targetName, "recording.mp4");
  assert.equal(parsed.timelineStartSeconds, 2);
  assert.equal(parsed.videoTrackIndex, 1);
  assert.equal(parsed.audioTrackIndex, 1);
  const help = spawnSync(process.execPath, [CLI_PATH, "--help"], {
    cwd: path.resolve(HERE, ".."),
    encoding: "utf8",
    env: {...process.env, PREMIERE_MCP_ROOT: "Z:\\missing-premiere-runtime"},
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /never changes the timeline/);
  assert.match(help.stdout, /live\.json plus clips\.json/);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-direct-inputs-test-"));
try {
  const mediaPath = path.join(tempRoot, "recording.mp4");
  const otherMediaPath = path.join(tempRoot, "other.mp4");
  fs.writeFileSync(mediaPath, "mock media", "utf8");
  fs.writeFileSync(otherMediaPath, "other mock media", "utf8");

  testIntroIsExcludedAndExactTargetIsBound(mediaPath);
  testFractionalDropAndNonDropAreExplicit(mediaPath);
  testUxpDisplayEnumIsCanonicalized(mediaPath);
  testAmbiguityFailsClosed(mediaPath);
  testLinkedIntervalAndSourceMismatchFail(mediaPath, otherMediaPath);
  testMissingMediaAndChangingIdentityFail(mediaPath, tempRoot);
  testDisplayMismatchFails(mediaPath);
  testAtomicOutputAndNoOverwrite(mediaPath, tempRoot);
  testCliSurfaceIsReadOnlyAndHelpNeedsNoPremiere();

  console.log(JSON.stringify({
    ok: true,
    testCount: 8,
    livePremiereCalled: false,
    covered: [
      "intro excluded and exact full-file V/A target bound",
      "30fps identity and waveform input",
      "29.97 drop-frame and non-drop display contracts",
      "ambiguous target rejected",
      "linked interval and source mismatch rejected",
      "missing media and changing identity rejected",
      "atomic output with overwrite refusal and hashes",
      "read-only CLI tool surface",
    ],
  }, null, 2));
} finally {
  fs.rmSync(tempRoot, {recursive: true, force: true});
}
