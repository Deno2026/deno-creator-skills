import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

import {
  buildPremierePlacementInputs,
  loadPremierePlacementInputs,
  validatePremierePlacementInputs,
  writePremierePlacementInputsAtomically,
} from "./lib/premiere-placement-inputs.mjs";
import {
  parseArgs,
  PLACEMENT_CAPTURE_TOOL_NAMES,
} from "./capture-premiere-placement-inputs.mjs";
import { DEFAULT_MCP_ROOT, DEFAULT_TEMP_DIR } from "../servers/premiere-uxp-mcp/paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(HERE, "capture-premiere-placement-inputs.mjs");
const TICKS_PER_SECOND = 254_016_000_000;
const TPF_30 = 8_467_200_000;
const TPF_2997 = 8_475_667_200;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function secondsAtFrame(frame, ticksPerFrame) {
  return frame * ticksPerFrame / TICKS_PER_SECOND;
}

function clip({index, nodeId, name, startFrame, endFrame, ticksPerFrame}) {
  const startSeconds = secondsAtFrame(startFrame, ticksPerFrame);
  const endSeconds = secondsAtFrame(endFrame, ticksPerFrame);
  return {
    index,
    nodeId,
    name,
    startSeconds,
    endSeconds,
    durationSeconds: endSeconds - startSeconds,
    inPointSeconds: 0,
    outPointSeconds: endSeconds - startSeconds,
    enabled: true,
    speed: 1,
    mediaType: "clip",
  };
}

function track(index, name, clips, extra = {}) {
  return {index, name, clipCount: clips.length, clips, isMuted: false, isLocked: null, ...extra};
}

function baseCapture({
  fps = 30,
  ticksPerFrame = TPF_30,
  videoDisplayFormat = 4,
  durationFrames = 360,
} = {}) {
  const makeClip = (values) => clip({...values, ticksPerFrame});
  const fragments = [
    makeClip({index: 0, nodeId: "recording-v-1", name: "recording.mp4", startFrame: 60, endFrame: 126}),
    makeClip({index: 1, nodeId: "recording-v-2", name: "recording.mp4", startFrame: 126, endFrame: 184}),
    makeClip({index: 2, nodeId: "recording-v-3", name: "recording.mp4", startFrame: 184, endFrame: 247}),
    makeClip({index: 3, nodeId: "recording-v-4", name: "recording.mp4", startFrame: 247, endFrame: 330}),
  ];
  const audioFragments = fragments.map((entry, index) => ({
    ...entry,
    index,
    nodeId: `recording-a-${index + 1}`,
  }));
  const sequenceName = fps === 30 ? "30fps cut timeline" : "29.97 DF cut timeline";
  const sequenceId = fps === 30 ? "sequence-30" : "sequence-2997";
  const structure = {
    name: sequenceName,
    id: sequenceId,
    durationSeconds: secondsAtFrame(durationFrames, ticksPerFrame),
    videoTrackCount: 3,
    audioTrackCount: 3,
    videoTracks: [
      track(0, "Intro V", [
        makeClip({index: 0, nodeId: "intro-v", name: "intro.mov", startFrame: 0, endFrame: 60}),
      ]),
      track(1, "Cut recording V", fragments),
      track(3, "B-roll V", [
        makeClip({index: 0, nodeId: "broll-v", name: "browser.png", startFrame: 200, endFrame: 280}),
      ]),
    ],
    audioTracks: [
      track(0, "Intro A", [
        makeClip({index: 0, nodeId: "intro-a", name: "intro.wav", startFrame: 0, endFrame: 60}),
      ]),
      track(1, "Cut recording A", audioFragments),
      track(4, "Music A", [
        makeClip({index: 0, nodeId: "music-a", name: "music.wav", startFrame: 0, endFrame: durationFrames}),
      ], {isMuted: true}),
    ],
    markers: [
      {name: "motion: browser", startSeconds: secondsAtFrame(200, ticksPerFrame)},
    ],
  };
  return {
    project: {
      name: "episode.prproj",
      path: "E:\\Projects\\episode.prproj",
      id: "project-1",
      activeSequence: {name: sequenceName, id: sequenceId},
    },
    settings: {
      name: sequenceName,
      id: sequenceId,
      frameRate: fps,
      ticksPerFrame,
      timebase: String(ticksPerFrame),
      videoDisplayFormat,
    },
    structure,
  };
}

function build(capture) {
  return buildPremierePlacementInputs({
    firstCapture: clone(capture),
    secondCapture: clone(capture),
    generatedAt: "2026-08-28T12:00:00.000Z",
  });
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function testMultiFragmentTimelineIsAccepted() {
  const capture = baseCapture();
  const bundle = build(capture);
  assert.equal(bundle.live.source, "premiere-uxp-read-only-placement-capture");
  assert.equal(bundle.live.schemaVersion, 1);
  assert.equal(bundle.live.projectName, "episode.prproj");
  assert.equal(bundle.live.projectPath, "E:\\Projects\\episode.prproj");
  assert.equal(bundle.live.projectId, "project-1");
  assert.equal(bundle.live.sequenceName, "30fps cut timeline");
  assert.equal(bundle.live.sequenceId, "sequence-30");
  assert.equal(bundle.live.sequenceDurationFrames, 360);
  assert.equal(bundle.live.fps, 30);
  assert.equal(bundle.live.ticksPerFrame, String(TPF_30));
  assert.deepEqual(bundle.live.timecodeDisplay, {
    code: 4,
    label: "30 Timecode",
    nominalFps: 30,
    dropFrame: false,
  });
  assert.deepEqual(bundle.live.videoTrackIndexes, [0, 1, 3]);
  assert.deepEqual(bundle.live.audioTrackIndexes, [0, 1, 4]);
  assert.equal(bundle.live.timelineWrites, 0);
  assert.equal(bundle.live.projectSaved, false);
  assert.equal("target" in bundle.live, false);
  assert.equal("targetBindingSha256" in bundle.live, false);
  assert.equal(bundle.structure.structure.videoTracks[1].clips.length, 4);
  assert.equal(bundle.structure.structure.audioTracks[1].clips.length, 4);
  assert.deepEqual(bundle.rawStructure, capture.structure);
  assert.match(bundle.captureSha256, /^[0-9A-F]{64}$/);
  assert.match(bundle.structureSha256, /^[0-9A-F]{64}$/);
  assert.match(bundle.bundleSha256, /^[0-9A-F]{64}$/);
  assert.equal(bundle.live.bundleSha256, bundle.structure.bundleSha256);

  const validated = validatePremierePlacementInputs({
    live: clone(bundle.live),
    structure: clone(bundle.structure),
  });
  assert.equal(validated.identity.sequenceDurationFrames, 360);
  assert.deepEqual(validated.identity.videoTrackIndexes, [0, 1, 3]);
  assert.equal(validated.rawStructure.videoTracks[1].clips.length, 4);
}

function testDropFrameTimingIsExact() {
  const bundle = build(baseCapture({
    fps: 30_000 / 1_001,
    ticksPerFrame: TPF_2997,
    videoDisplayFormat: 2,
    durationFrames: 300,
  }));
  assert.ok(Math.abs(bundle.live.fps - 30_000 / 1_001) < 1e-9);
  assert.equal(bundle.live.ticksPerFrame, String(TPF_2997));
  assert.equal(bundle.live.sequenceDurationFrames, 300);
  assert.deepEqual(bundle.live.timecodeDisplay, {
    code: 2,
    label: "29.97 Drop-frame",
    nominalFps: 30,
    dropFrame: true,
  });
  validatePremierePlacementInputs({live: bundle.live, structure: bundle.structure});
}

function testUxpDisplayEnumIsCanonicalized() {
  const bundle = build(baseCapture({videoDisplayFormat: 104}));
  assert.deepEqual(bundle.live.timecodeDisplay, {
    code: 4,
    label: "30 Timecode",
    nominalFps: 30,
    dropFrame: false,
  });
}

function testDoubleCaptureDriftIsRejected() {
  const capture = baseCapture();
  const cases = [
    ["project", (second) => { second.project.path = "E:\\Projects\\changed.prproj"; }],
    ["sequence", (second) => {
      second.project.activeSequence = {name: "Other sequence", id: "sequence-2"};
      second.settings.name = "Other sequence";
      second.settings.id = "sequence-2";
      second.structure.name = "Other sequence";
      second.structure.id = "sequence-2";
    }],
    ["settings", (second) => { second.settings.frameRate = 29.9995; }],
    ["full structure", (second) => {
      second.structure.videoTracks[2].clips[0].name = "changed-browser.png";
    }],
  ];
  for (const [label, mutate] of cases) {
    const first = clone(capture);
    const second = clone(capture);
    mutate(second);
    expectCode(
      () => buildPremierePlacementInputs({firstCapture: first, secondCapture: second}),
      "PREMIERE_PLACEMENT_CAPTURE_CHANGED",
    );
    assert.ok(label);
  }
}

function testBundleCorruptionIsRejected(tempRoot) {
  const bundle = build(baseCapture());
  const changedLive = clone(bundle.live);
  changedLive.projectName = "different.prproj";
  expectCode(
    () => validatePremierePlacementInputs({live: changedLive, structure: clone(bundle.structure)}),
    "PREMIERE_PLACEMENT_BUNDLE_CHANGED",
  );

  const changedStructure = clone(bundle.structure);
  changedStructure.structure.audioTracks[2].isMuted = false;
  expectCode(
    () => validatePremierePlacementInputs({live: clone(bundle.live), structure: changedStructure}),
    "PREMIERE_PLACEMENT_BUNDLE_CHANGED",
  );

  const outDir = path.join(tempRoot, "tamper-capture");
  writePremierePlacementInputsAtomically({outDir, bundle});
  const structurePath = path.join(outDir, "structure.json");
  const diskStructure = JSON.parse(fs.readFileSync(structurePath, "utf8"));
  diskStructure.structure.markers[0].name = "changed marker";
  fs.writeFileSync(structurePath, `${JSON.stringify(diskStructure, null, 2)}\n`, "utf8");
  expectCode(
    () => loadPremierePlacementInputs({captureDir: outDir}),
    "PREMIERE_PLACEMENT_BUNDLE_CHANGED",
  );

  const corruptDir = path.join(tempRoot, "corrupt-capture");
  fs.mkdirSync(corruptDir);
  fs.writeFileSync(path.join(corruptDir, "live.json"), "{", "utf8");
  fs.writeFileSync(path.join(corruptDir, "structure.json"), "{}", "utf8");
  expectCode(
    () => loadPremierePlacementInputs({captureDir: corruptDir}),
    "PREMIERE_PLACEMENT_BUNDLE_UNREADABLE",
  );
}

function testAtomicOutputAndNoOverwrite(tempRoot) {
  const bundle = build(baseCapture());
  const outDir = path.join(tempRoot, "placement-capture");
  const written = writePremierePlacementInputsAtomically({outDir, bundle});
  assert.equal(fs.existsSync(written.livePath), true);
  assert.equal(fs.existsSync(written.structurePath), true);
  assert.match(written.liveSha256, /^[0-9A-F]{64}$/);
  assert.match(written.structureFileSha256, /^[0-9A-F]{64}$/);
  const loaded = loadPremierePlacementInputs({captureDir: outDir});
  assert.equal(loaded.bundleSha256, bundle.bundleSha256);
  assert.equal(loaded.captureSha256, bundle.captureSha256);
  assert.equal(loaded.structureSha256, bundle.structureSha256);
  assert.equal(loaded.rawStructure.videoTracks[1].clips.length, 4);
  expectCode(
    () => writePremierePlacementInputsAtomically({outDir, bundle}),
    "PREMIERE_PLACEMENT_OUTPUT_EXISTS",
  );
  assert.deepEqual(
    fs.readdirSync(tempRoot).filter((name) => name.includes(".tmp-")),
    [],
  );
}

function testCliIsReadOnlyAndHelpNeedsNoPremiere() {
  assert.deepEqual(PLACEMENT_CAPTURE_TOOL_NAMES, [
    "get_project_info",
    "get_sequence_settings",
    "get_sequence_structure",
  ]);
  assert.equal(
    PLACEMENT_CAPTURE_TOOL_NAMES.some((name) => /^(?:save|set|remove|delete|razor|execute|insert|overwrite)_/i.test(name)),
    false,
  );
  assert.deepEqual(parseArgs(["--out-dir", "tmp/placement-capture"]), {
    outDir: "tmp/placement-capture",
    timeoutMs: 180_000,
    mcpRoot: process.env.PREMIERE_MCP_ROOT || DEFAULT_MCP_ROOT,
    tempDir: process.env.PREMIERE_TEMP_DIR || DEFAULT_TEMP_DIR,
  });
  const help = spawnSync(process.execPath, [CLI_PATH, "--help"], {
    cwd: path.resolve(HERE, ".."),
    encoding: "utf8",
    env: {...process.env, PREMIERE_MCP_ROOT: "Z:\\missing-premiere-runtime"},
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /full sequence/);
  assert.match(help.stdout, /live\.json \+ structure\.json/);
  assert.match(help.stdout, /never changes the timeline/);
  assert.match(help.stdout, /never binds one media clip/);
}

// 2026-09-27: the user's BGM tail ends between video frames and the sequence ends with it. The capture accepts that length
// only when an audio clip ends exactly there, records the last whole frame (floor) and marks sequenceDurationAudioTail.
function testAudioTailDurationIsAcceptedAsFloor() {
  const capture = baseCapture();
  const tailSeconds = secondsAtFrame(360.44, TPF_30);
  const music = capture.structure.audioTracks[2].clips[0];
  music.endSeconds = tailSeconds;
  music.durationSeconds = tailSeconds - music.startSeconds;
  music.outPointSeconds = music.durationSeconds;
  capture.structure.durationSeconds = tailSeconds;
  const bundle = build(capture);
  assert.equal(bundle.live.sequenceDurationFrames, 360);
  assert.equal(bundle.live.sequenceDurationAudioTail, true);
  const validated = validatePremierePlacementInputs({live: clone(bundle.live), structure: clone(bundle.structure)});
  assert.equal(validated.identity.sequenceDurationFrames, 360);

  const onGrid = build(baseCapture());
  assert.equal("sequenceDurationAudioTail" in onGrid.live, false);

  const stray = baseCapture();
  stray.structure.durationSeconds = tailSeconds; // no audio clip ends there
  expectCode(() => build(stray), "PREMIERE_PLACEMENT_DURATION_NOT_FRAME_ALIGNED");
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-placement-inputs-test-"));
try {
  testMultiFragmentTimelineIsAccepted();
  testAudioTailDurationIsAcceptedAsFloor();
  testDropFrameTimingIsExact();
  testUxpDisplayEnumIsCanonicalized();
  testDoubleCaptureDriftIsRejected();
  testBundleCorruptionIsRejected(tempRoot);
  testAtomicOutputAndNoOverwrite(tempRoot);
  testCliIsReadOnlyAndHelpNeedsNoPremiere();

  console.log(JSON.stringify({
    ok: true,
    testCount: 7,
    livePremiereCalled: false,
    covered: [
      "already-cut multi-fragment full structure capture without target binding",
      "sequence ending on an off-grid audio tail: floor length + sequenceDurationAudioTail; other off-grid lengths rejected",
      "30fps and 29.97 drop-frame exact timing",
      "project, sequence, settings, and full-structure double-capture drift rejection",
      "changed and corrupt bundle rejection",
      "atomic new-directory output with overwrite refusal",
      "read-only UXP tool surface with zero timeline writes and no project save",
    ],
  }, null, 2));
} finally {
  fs.rmSync(tempRoot, {recursive: true, force: true});
}
