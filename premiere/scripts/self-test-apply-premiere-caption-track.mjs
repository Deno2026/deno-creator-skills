#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildControlCallArgs,
  parseArgs,
  retiredCaptionTrackName,
  runCaptionTrackApplication,
  usage,
  verifyCaptionAddition,
} from "./apply-premiere-caption-track.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(HERE, "..", "tmp", "caption-wrapper-fixture.srt");
const SRT = [
  "1",
  "00:00:00,000 --> 00:00:01,000",
  "첫 번째 자막",
  "",
  "2",
  "00:00:01,200 --> 00:00:02,400",
  "두 번째 자막",
  "",
].join("\n");
const SRT_FINAL_END_PLUS_ONE_FRAME = SRT.replace(
  "00:00:01,200 --> 00:00:02,400",
  "00:00:01,200 --> 00:00:02,440",
);
const SRT_FINAL_END_PLUS_TWO_FRAMES = SRT.replace(
  "00:00:01,200 --> 00:00:02,400",
  "00:00:01,200 --> 00:00:02,480",
);
const SRT_NEAREST_WOULD_HIDE_FLOOR_MISMATCH = SRT.replace(
  "00:00:00,000 --> 00:00:01,000",
  "00:00:00,000 --> 00:00:00,999",
);
const SRT_GROUP_BRIDGES_LONG_GAP = SRT.replace(
  "00:00:01,200 --> 00:00:02,400",
  "00:00:01,200 --> 00:00:04,000",
);
const SRT_COMPENSATED_END_AT_SEQUENCE_TAIL = SRT.replace(
  "00:00:01,200 --> 00:00:02,400",
  "00:00:01,200 --> 00:00:10,000",
);
const SRT_COMPENSATED_END_OUTSIDE_SEQUENCE_TAIL = SRT.replace(
  "00:00:01,200 --> 00:00:02,400",
  "00:00:01,200 --> 00:00:10,040",
);

function mockFsFor(source) {
  return {
    statSync() {
      return { isFile: () => true };
    },
    readFileSync() {
      return source;
    },
  };
}

const mockFs = mockFsFor(SRT);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function structureFixture() {
  return {
    name: "Sequence 01",
    id: "sequence-guid-1",
    durationSeconds: 10,
    videoTrackCount: 1,
    audioTrackCount: 1,
    videoTracks: [
      {
        index: 0,
        name: "V1",
        isMuted: false,
        isLocked: null,
        clipCount: 1,
        clips: [
          {
            index: 0,
            nodeId: "video-node-1",
            name: "picture.mov",
            startSeconds: 0,
            endSeconds: 10,
            durationSeconds: 10,
            inPointSeconds: 0,
            outPointSeconds: 10,
            mediaType: "video",
            enabled: true,
            speed: 1,
          },
        ],
      },
    ],
    audioTracks: [
      {
        index: 0,
        name: "A1",
        isMuted: false,
        isLocked: null,
        clipCount: 1,
        clips: [
          {
            index: 0,
            nodeId: "audio-node-1",
            name: "dialogue.wav",
            startSeconds: 0,
            endSeconds: 10,
            durationSeconds: 10,
            inPointSeconds: 0,
            outPointSeconds: 10,
            mediaType: "audio",
            enabled: true,
            speed: 1,
          },
        ],
      },
    ],
  };
}

function stateFixture() {
  return {
    project: {
      name: "Caption Test.prproj",
      path: "E:\\Projects\\Caption Test.prproj",
    },
    activeSequence: {
      name: "Sequence 01",
      id: "sequence-guid-1",
      durationSeconds: 10,
      videoTrackCount: 1,
      audioTrackCount: 1,
      totalClipCount: 2,
    },
  };
}

function summaryFixture() {
  return {
    name: "Sequence 01",
    id: "sequence-guid-1",
    durationSeconds: 10,
    videoTrackCount: 1,
    audioTrackCount: 1,
    frameRate: {
      seconds: 0.04,
      ticks: "10160640000",
    },
  };
}

function emptyCaptions() {
  return {
    captionTrackCount: 0,
    captionTextAvailable: false,
    tracks: [],
  };
}

function existingCaptions() {
  return {
    captionTrackCount: 1,
    captionTextAvailable: false,
    tracks: [
      {
        index: 0,
        id: "existing-caption-track",
        name: "Existing captions",
        muted: false,
        itemCount: 1,
        items: [
          { index: 0, startSeconds: 5, endSeconds: 6 },
        ],
      },
    ],
  };
}

function createdCaptions() {
  return {
    captionTrackCount: 1,
    captionTextAvailable: false,
    tracks: [
      {
        index: 0,
        id: "caption-track-new",
        name: "Subtitles 1",
        muted: false,
        itemCount: 2,
        items: [
          { index: 0, startSeconds: 0, endSeconds: 1 },
          { index: 1, startSeconds: 1.2, endSeconds: 2.4 },
        ],
      },
    ],
  };
}

function timingAuthorityCaptions() {
  const captions = createdCaptions();
  captions.tracks[0].id = "existing-caption-authority";
  captions.tracks[0].name = "Existing captions";
  return captions;
}

function authorityTracksWithItems(items) {
  const tracks = clone(timingAuthorityCaptions().tracks);
  tracks[0].items = items.map((item, index) => ({index, ...item}));
  tracks[0].itemCount = items.length;
  return tracks;
}

function srtInfoFixture() {
  return {
    cueCount: 2,
    startSeconds: 0,
    endSeconds: 2.4,
    cues: [
      {startSeconds: 0, endSeconds: 1},
      {startSeconds: 1.2, endSeconds: 2.4},
    ],
  };
}

function scenarioRunner({ existingCaptionCount = 0, uncertainTool = null } = {}) {
  const calls = [];
  let captionReads = 0;

  const runner = async (request) => {
    calls.push(clone(request));
    if (request.tool === uncertainTool) {
      const error = new Error(`${request.tool} transport timed out`);
      error.code = "MOCK_TIMEOUT";
      error.uncertain = true;
      throw error;
    }

    if (request.tool === "ping") {
      return {
        connected: true,
        premiereVersion: "26.3.2",
        projectName: "Caption Test.prproj",
        activeSequence: "Sequence 01",
      };
    }
    if (request.tool === "get_premiere_state") return stateFixture();
    if (request.tool === "get_timeline_summary") return summaryFixture();
    if (request.tool === "get_sequence_structure") return structureFixture();
    if (request.tool === "search_project_items") return { count: 0, items: [] };
    if (request.tool === "find_project_item_by_name") {
      return {
        nodeId: "uxp-caption-item-1",
        name: path.basename(FIXTURE_PATH),
        type: "clip",
        mediaPath: FIXTURE_PATH,
      };
    }
    if (request.tool === "get_caption_tracks") {
      captionReads += 1;
      if (existingCaptionCount === 1) return existingCaptions();
      return captionReads >= 3 ? createdCaptions() : emptyCaptions();
    }
    if (request.tool === "import_media") {
      return { imported: 1, files: [FIXTURE_PATH] };
    }
    if (request.tool === "create_caption_track") {
      return {
        created: true,
        item: path.basename(FIXTURE_PATH),
        startSeconds: 0,
        format: "subtitle",
      };
    }
    throw new Error(`Unexpected mock tool: ${request.tool}`);
  };
  return { calls, runner };
}

function revisionScenarioRunner({
  initialTracks = timingAuthorityCaptions().tracks,
  createdEndDeltaFrames = 0,
} = {}) {
  const calls = [];
  const tracks = clone(initialTracks);
  let createdTrackIndex = null;
  const snapshot = () => ({
    captionTrackCount: tracks.length,
    captionTextAvailable: false,
    tracks: clone(tracks),
  });
  const runner = async (request) => {
    calls.push(clone(request));
    if (request.tool === "ping") {
      return {
        connected: true,
        premiereVersion: "26.3.2",
        projectName: "Caption Test.prproj",
        activeSequence: "Sequence 01",
      };
    }
    if (request.tool === "get_premiere_state") return stateFixture();
    if (request.tool === "get_timeline_summary") return summaryFixture();
    if (request.tool === "get_sequence_structure") return structureFixture();
    if (request.tool === "get_caption_tracks") return snapshot();
    if (request.tool === "search_project_items") return {count: 0, items: []};
    if (request.tool === "find_project_item_by_name") {
      return {
        nodeId: "uxp-caption-item-1",
        name: path.basename(FIXTURE_PATH),
        type: "clip",
        mediaPath: FIXTURE_PATH,
      };
    }
    if (request.tool === "set_caption_track_mute") {
      const track = tracks[request.args.track_index];
      const previousMuted = Boolean(track.muted);
      track.muted = Boolean(request.args.muted);
      return {
        updated: true,
        trackIndex: request.args.track_index,
        previousMuted,
        muted: track.muted,
      };
    }
    if (request.tool === "rename_caption_track") {
      const track = tracks[request.args.track_index];
      const previousName = String(track.name);
      track.name = String(request.args.name);
      return {
        updated: true,
        trackIndex: request.args.track_index,
        previousName,
        name: track.name,
      };
    }
    if (request.tool === "import_media") {
      return {imported: 1, files: [FIXTURE_PATH]};
    }
    if (request.tool === "create_caption_track") {
      tracks.push(clone(createdCaptions().tracks[0]));
      tracks.at(-1).index = tracks.length - 1;
      createdTrackIndex = tracks.length - 1;
      tracks[createdTrackIndex].items.at(-1).endSeconds +=
        createdEndDeltaFrames * summaryFixture().frameRate.seconds;
      return {
        created: true,
        item: path.basename(FIXTURE_PATH),
        startSeconds: 0,
        format: "subtitle",
      };
    }
    throw new Error(`Unexpected mock tool: ${request.tool}`);
  };
  return {calls, runner, snapshot};
}

function testDependencies(scenario, fsApi = mockFs) {
  return {
    fs: fsApi,
    runner: scenario.runner,
    wait: async () => {},
  };
}

function writeOptions(overrides = {}) {
  return {
    srt: FIXTURE_PATH,
    allowWrite: true,
    expectedProject: "Caption Test.prproj",
    expectedSequence: "Sequence 01",
    timeoutMs: 5_000,
    ...overrides,
  };
}

async function testArgumentAndChildArrayContracts() {
  const dry = parseArgs([FIXTURE_PATH]);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.allowWrite, false);

  const write = parseArgs([
    FIXTURE_PATH,
    "--allow-write",
    "--expected-project",
    "Caption Test.prproj",
    "--expected-sequence",
    "Sequence 01",
  ]);
  assert.equal(write.dryRun, false);
  assert.equal(write.allowWrite, true);

  const revision = parseArgs([
    FIXTURE_PATH,
    "--allow-write",
    "--revision-review-mode",
    "--allow-caption-retime",
    "--expected-existing-caption-tracks",
    "1",
    "--new-track-name",
    "[검수본] 소제목 R3",
    "--expected-project",
    "Caption Test.prproj",
    "--expected-sequence",
    "Sequence 01",
  ]);
  assert.equal(revision.revisionReviewMode, true);
  assert.equal(revision.allowCaptionRetime, true);
  assert.equal(revision.expectedExistingCaptionTracks, 1);
  assert.equal(revision.newTrackName, "[검수본] 소제목 R3");
  assert.match(usage(), /--allow-caption-retime/);
  const compensation = parseArgs([
    FIXTURE_PATH,
    "--revision-review-mode",
    "--premiere-final-cue-end-compensation",
    "--expected-existing-caption-tracks",
    "1",
  ]);
  assert.equal(compensation.premiereFinalCueEndCompensation, true);
  assert.match(usage(), /--premiere-final-cue-end-compensation/);
  const grouping = parseArgs([
    FIXTURE_PATH,
    "--revision-review-mode",
    "--allow-context-grouping",
    "--expected-existing-caption-tracks",
    "1",
  ]);
  assert.equal(grouping.allowContextGrouping, true);
  assert.equal(parseArgs([FIXTURE_PATH]).allowContextGrouping, false);
  assert.match(usage(), /--allow-context-grouping/);
  assert.equal(
    retiredCaptionTrackName(
      {index: 1, name: "[검수본] 소제목 R3 · 155cue", itemCount: 155},
      "[폐기]",
    ),
    "[폐기] [검수본] 소제목 R3 · 155cue",
  );

  assert.throws(
    () => parseArgs([FIXTURE_PATH, "--allow-write", "--dry-run"]),
    /mutually exclusive/,
  );

  const childArgs = buildControlCallArgs(
    {
      tool: "create_caption_track",
      args: {
        item_id: "자막 파일.srt",
        start_seconds: 0,
        caption_format: "subtitle",
      },
      route: "cep",
      allowWrite: true,
      allowExperimental: true,
    },
    {
      controlCallPath: "E:\\Repo With Spaces\\call-tool.mjs",
      cepTempDir: "E:\\Temp With Spaces",
    },
  );
  assert.equal(Array.isArray(childArgs), true);
  assert.equal(childArgs[0], "E:\\Repo With Spaces\\call-tool.mjs");
  assert.equal(childArgs[1], "create_caption_track");
  assert.deepEqual(JSON.parse(childArgs[2]), {
    item_id: "자막 파일.srt",
    start_seconds: 0,
    caption_format: "subtitle",
  });
  assert.equal(childArgs.includes("--route"), true);
  assert.equal(childArgs.includes("cep"), true);
  assert.equal(childArgs.includes("--allow-write"), true);
  assert.equal(childArgs.includes("--allow-experimental"), true);
}

async function testWritePermissionGatesRunBeforePremiereCalls() {
  {
    const scenario = scenarioRunner();
    const report = await runCaptionTrackApplication(
      writeOptions({premiereFinalCueEndCompensation: true}),
      testDependencies(scenario),
    );
    assert.equal(report.ok, false);
    assert.equal(
      report.failure.code,
      "FINAL_CUE_COMPENSATION_REQUIRES_REVISION_REVIEW",
    );
    assert.equal(scenario.calls.length, 0);
  }

  {
    const scenario = scenarioRunner();
    const report = await runCaptionTrackApplication(
      writeOptions({
        revisionReviewMode: true,
        allowCaptionRetime: true,
        premiereFinalCueEndCompensation: true,
        expectedExistingCaptionTracks: 1,
        newTrackName: "[검수본] 충돌",
      }),
      testDependencies(scenario),
    );
    assert.equal(report.ok, false);
    assert.equal(
      report.failure.code,
      "FINAL_CUE_COMPENSATION_CONFLICTS_WITH_RETIME",
    );
    assert.equal(scenario.calls.length, 0);
  }

  {
    const scenario = scenarioRunner();
    const report = await runCaptionTrackApplication(
      writeOptions({ expectedExistingCaptionTracks: 1 }),
      testDependencies(scenario),
    );
    assert.equal(report.ok, false);
    assert.equal(report.status, "blocked-before-write");
    assert.equal(report.failure.code, "CAPTION_TRACK_STACKING_FORBIDDEN");
    assert.equal(scenario.calls.length, 0);
  }

  {
    const scenario = scenarioRunner();
    const report = await runCaptionTrackApplication(
      writeOptions({ expectedProject: undefined }),
      testDependencies(scenario),
    );
    assert.equal(report.ok, false);
    assert.equal(report.status, "blocked-before-write");
    assert.equal(scenario.calls.length, 0);
  }

  {
    const scenario = scenarioRunner();
    const report = await runCaptionTrackApplication(
      writeOptions({ expectedSequence: undefined }),
      testDependencies(scenario),
    );
    assert.equal(report.ok, false);
    assert.equal(report.status, "blocked-before-write");
    assert.equal(scenario.calls.length, 0);
  }
}

async function testDefaultDryRunIsReadOnly() {
  const scenario = scenarioRunner();
  const report = await runCaptionTrackApplication(
    { srt: FIXTURE_PATH, timeoutMs: 5_000 },
    testDependencies(scenario),
  );
  assert.equal(report.ok, true);
  assert.equal(report.status, "dry-run-complete");
  assert.equal(report.writeAttempts.length, 0);
  assert.deepEqual(
    scenario.calls.map((call) => call.tool),
    [
      "ping",
      "get_premiere_state",
      "get_timeline_summary",
      "get_sequence_structure",
      "get_caption_tracks",
      "search_project_items",
    ],
  );
  assert.equal(scenario.calls.every((call) => call.route === "uxp"), true);
  assert.equal(scenario.calls.every((call) => !call.mutation), true);
}

async function testRevisionTimingAuthorityExactMatchPassesInDryRun() {
  const tracks = clone(timingAuthorityCaptions().tracks);
  for (const item of tracks[0].items) {
    item.startSeconds += 0.48;
    item.endSeconds += 0.48;
  }
  tracks[0].items[0].endSeconds += 0.009;
  const scenario = revisionScenarioRunner({initialTracks: tracks});
  const report = await runCaptionTrackApplication(
    {
      srt: FIXTURE_PATH,
      revisionReviewMode: true,
      expectedExistingCaptionTracks: 1,
      startSeconds: 0.48,
      timeoutMs: 5_000,
    },
    testDependencies(scenario),
  );
  assert.equal(report.ok, true, JSON.stringify(report.failure));
  assert.equal(report.status, "dry-run-complete");
  assert.equal(
    report.revision.timingAuthority.status,
    "matched-visible-authority",
  );
  assert.equal(report.revision.timingAuthority.checkedCueCount, 2);
  assert.equal(report.writeAttempts.length, 0);
  assert.equal(scenario.calls.some((call) => call.mutation), false);
}

async function testSrtImportFloorMismatchBlocksBeforeWrite() {
  const scenario = revisionScenarioRunner();
  const report = await runCaptionTrackApplication(
    writeOptions({
      revisionReviewMode: true,
      expectedExistingCaptionTracks: 1,
      newTrackName: "[검수본] floor 경계",
    }),
    testDependencies(
      scenario,
      mockFsFor(SRT_NEAREST_WOULD_HIDE_FLOOR_MISMATCH),
    ),
  );
  assert.equal(report.ok, false);
  assert.equal(report.status, "blocked-before-write");
  assert.equal(
    report.failure.code,
    "CAPTION_TIMING_AUTHORITY_BOUNDARY_MISMATCH",
  );
  assert.equal(report.failure.details.comparison, "srt-import-floor-vs-native-nearest-exact");
  assert.equal(report.failure.details.mismatch.cueNumber, 1);
  assert.equal(report.failure.details.mismatch.encodedEndFrame, 24);
  assert.equal(report.failure.details.mismatch.actualEndFrame, 25);
  assert.equal(report.writeAttempts.length, 0);
  assert.equal(scenario.calls.some((call) => call.mutation), false);
}

async function testRevisionTimingAuthorityCueCountMismatchBlocksBeforeWrite() {
  const scenario = revisionScenarioRunner({
    initialTracks: existingCaptions().tracks,
  });
  const report = await runCaptionTrackApplication(
    writeOptions({
      revisionReviewMode: true,
      expectedExistingCaptionTracks: 1,
      newTrackName: "[검수본] 소제목 R3 · 2cue",
    }),
    testDependencies(scenario),
  );
  assert.equal(report.ok, false);
  assert.equal(report.status, "blocked-before-write");
  assert.equal(
    report.failure.code,
    "CAPTION_TIMING_AUTHORITY_CUE_COUNT_MISMATCH",
  );
  assert.equal(report.writeAttempts.length, 0);
  assert.equal(scenario.calls.some((call) => call.mutation), false);
}

async function testRevisionTimingAuthorityOneFrameMismatchBlocksBeforeWrite() {
  const tracks = clone(timingAuthorityCaptions().tracks);
  tracks[0].items[1].endSeconds += summaryFixture().frameRate.seconds;
  const scenario = revisionScenarioRunner({initialTracks: tracks});
  const report = await runCaptionTrackApplication(
    writeOptions({
      revisionReviewMode: true,
      expectedExistingCaptionTracks: 1,
      newTrackName: "[검수본] 소제목 R3 · 2cue",
    }),
    testDependencies(scenario),
  );
  assert.equal(report.ok, false);
  assert.equal(report.status, "blocked-before-write");
  assert.equal(
    report.failure.code,
    "CAPTION_TIMING_AUTHORITY_BOUNDARY_MISMATCH",
  );
  assert.equal(report.failure.details.mismatch.cueNumber, 2);
  assert.equal(report.failure.details.mismatch.endDeltaFrames, 1);
  assert.equal(report.writeAttempts.length, 0);
  assert.equal(scenario.calls.some((call) => call.mutation), false);
}

async function testFinalCueTransportCompensationIsExplicitAndExact() {
  {
    const scenario = revisionScenarioRunner();
    const report = await runCaptionTrackApplication(
      writeOptions({
        revisionReviewMode: true,
        expectedExistingCaptionTracks: 1,
        newTrackName: "[검수본] 무보정",
      }),
      testDependencies(scenario, mockFsFor(SRT_FINAL_END_PLUS_ONE_FRAME)),
    );
    assert.equal(report.ok, false);
    assert.equal(
      report.failure.code,
      "CAPTION_TIMING_AUTHORITY_BOUNDARY_MISMATCH",
    );
    assert.equal(report.failure.details.mismatch.cueNumber, 2);
    assert.equal(report.failure.details.mismatch.endDeltaFrames, -1);
    assert.equal(report.writeAttempts.length, 0);
    assert.equal(scenario.calls.some((call) => call.mutation), false);
  }

  {
    const scenario = revisionScenarioRunner();
    const report = await runCaptionTrackApplication(
      writeOptions({
        revisionReviewMode: true,
        premiereFinalCueEndCompensation: true,
        expectedExistingCaptionTracks: 1,
        newTrackName: "[검수본] 전송 보정",
      }),
      testDependencies(scenario, mockFsFor(SRT_FINAL_END_PLUS_ONE_FRAME)),
    );
    assert.equal(report.ok, true, JSON.stringify(report.failure));
    assert.equal(report.status, "applied-and-verified");
    assert.equal(report.policy.allowCaptionRetime, false);
    assert.equal(report.policy.premiereFinalCueEndCompensation, true);
    assert.equal(report.srt.sourceRange.endSeconds, 2.44);
    assert.equal(
      report.revision.timingAuthority.transportCompensation.enabled,
      true,
    );
    assert.equal(
      report.verification.caption.timingComparison.transportCompensation
        .encodedFinalCueEndFrame,
      61,
    );
    assert.equal(
      report.verification.caption.timingComparison.transportCompensation
        .intendedFinalCueEndFrame,
      60,
    );
    assert.equal(
      report.verification.caption.timingComparison.transportCompensation
        .actualFinalCueEndFrame,
      60,
    );
    assert.equal(
      report.verification.caption.timingComparison.transportCompensation
        .observedEncodedToActualDeltaFrames,
      1,
    );
  }
}

async function testFinalCueTransportCompensationRejectsWrongDelta() {
  const cases = [
    {name: "zero-frame", source: SRT, encodedDeltaFrames: 0},
    {
      name: "two-frames",
      source: SRT_FINAL_END_PLUS_TWO_FRAMES,
      encodedDeltaFrames: 2,
    },
  ];
  for (const testCase of cases) {
    const scenario = revisionScenarioRunner();
    const report = await runCaptionTrackApplication(
      writeOptions({
        revisionReviewMode: true,
        premiereFinalCueEndCompensation: true,
        expectedExistingCaptionTracks: 1,
        newTrackName: "[검수본] 잘못된 보정",
      }),
      testDependencies(scenario, mockFsFor(testCase.source)),
    );
    assert.equal(report.ok, false, testCase.name);
    assert.equal(
      report.failure.code,
      "CAPTION_FINAL_CUE_COMPENSATION_MISMATCH",
      testCase.name,
    );
    assert.equal(
      report.failure.details.mismatch.encodedEndDeltaFromAuthorityFrames,
      testCase.encodedDeltaFrames,
      testCase.name,
    );
    assert.equal(report.writeAttempts.length, 0, testCase.name);
    assert.equal(
      scenario.calls.some((call) => call.mutation),
      false,
      testCase.name,
    );
  }
}

async function testFinalCueCompensationBlocksAtOrOutsideSequenceTail() {
  const cases = [
    {
      name: "at-exclusive-tail",
      source: SRT_COMPENSATED_END_AT_SEQUENCE_TAIL,
      authorityEndSeconds: 9.96,
      encodedFinalCueEndFrame: 250,
    },
    {
      name: "outside-exclusive-tail",
      source: SRT_COMPENSATED_END_OUTSIDE_SEQUENCE_TAIL,
      authorityEndSeconds: 10,
      encodedFinalCueEndFrame: 251,
    },
  ];
  for (const testCase of cases) {
    const tracks = clone(timingAuthorityCaptions().tracks);
    tracks[0].items.at(-1).endSeconds = testCase.authorityEndSeconds;
    const scenario = revisionScenarioRunner({initialTracks: tracks});
    const report = await runCaptionTrackApplication(
      writeOptions({
        revisionReviewMode: true,
        premiereFinalCueEndCompensation: true,
        expectedExistingCaptionTracks: 1,
        newTrackName: "[검수본] tail guard",
      }),
      testDependencies(scenario, mockFsFor(testCase.source)),
    );
    assert.equal(report.ok, false, testCase.name);
    assert.equal(report.status, "blocked-before-write", testCase.name);
    assert.equal(
      report.failure.code,
      "FINAL_CUE_COMPENSATION_SEQUENCE_TAIL_FORBIDDEN",
      testCase.name,
    );
    assert.equal(
      report.failure.details.encodedFinalCueEndFrame,
      testCase.encodedFinalCueEndFrame,
      testCase.name,
    );
    assert.equal(report.failure.details.durationFrameExclusive, 250);
    assert.equal(report.writeAttempts.length, 0, testCase.name);
    assert.equal(
      scenario.calls.some((call) => call.mutation),
      false,
      testCase.name,
    );
  }
}

async function testRevisionTimingAuthorityRequiresExactlyOneVisibleTrack() {
  const visibleA = clone(timingAuthorityCaptions().tracks[0]);
  const visibleB = clone(timingAuthorityCaptions().tracks[0]);
  visibleB.index = 1;
  visibleB.id = "second-visible-caption-track";
  visibleB.name = "Second visible captions";
  const cases = [
    {
      name: "ambiguous",
      tracks: [visibleA, visibleB],
      expectedExistingCaptionTracks: 2,
      expectedVisibleTrackCount: 2,
    },
    {
      name: "none-visible",
      tracks: [{...visibleA, muted: true}],
      expectedExistingCaptionTracks: 1,
      expectedVisibleTrackCount: 0,
    },
  ];

  for (const testCase of cases) {
    const scenario = revisionScenarioRunner({initialTracks: testCase.tracks});
    const report = await runCaptionTrackApplication(
      writeOptions({
        revisionReviewMode: true,
        expectedExistingCaptionTracks: testCase.expectedExistingCaptionTracks,
        newTrackName: "[검수본] 소제목 R3 · 2cue",
      }),
      testDependencies(scenario),
    );
    assert.equal(report.ok, false, testCase.name);
    assert.equal(report.status, "blocked-before-write", testCase.name);
    assert.equal(
      report.failure.code,
      "CAPTION_TIMING_AUTHORITY_AMBIGUOUS",
      testCase.name,
    );
    assert.equal(
      report.failure.details.visibleTrackCount,
      testCase.expectedVisibleTrackCount,
      testCase.name,
    );
    assert.equal(report.writeAttempts.length, 0, testCase.name);
    assert.equal(
      scenario.calls.some((call) => call.mutation),
      false,
      testCase.name,
    );
  }
}

async function testExplicitCaptionRetimeOverridePermitsRevisionWrite() {
  const scenario = revisionScenarioRunner({
    initialTracks: existingCaptions().tracks,
  });
  const report = await runCaptionTrackApplication(
    writeOptions({
      revisionReviewMode: true,
      allowCaptionRetime: true,
      expectedExistingCaptionTracks: 1,
      newTrackName: "[검수본] 승인된 리타임 · 2cue",
    }),
    testDependencies(scenario),
  );
  assert.equal(report.ok, true, JSON.stringify(report.failure));
  assert.equal(report.status, "applied-and-verified");
  assert.equal(
    report.revision.timingAuthority.status,
    "explicit-retime-override",
  );
  assert.equal(report.revision.timingAuthority.overrideAllowed, true);
  assert.ok(report.writeAttempts.length > 0);
}

async function testContextGroupingOptionGates() {
  for (const [overrides, code] of [
    [{allowContextGrouping: true}, "CONTEXT_GROUPING_REQUIRES_REVISION_REVIEW"],
    [
      {
        allowContextGrouping: true,
        allowCaptionRetime: true,
        revisionReviewMode: true,
        expectedExistingCaptionTracks: 1,
        newTrackName: "[검수본] 충돌",
      },
      "CONTEXT_GROUPING_CONFLICTS_WITH_RETIME",
    ],
  ]) {
    const scenario = revisionScenarioRunner();
    const report = await runCaptionTrackApplication(
      writeOptions(overrides),
      testDependencies(scenario),
    );
    assert.equal(report.ok, false);
    assert.equal(report.failure.code, code);
    assert.equal(scenario.calls.length, 0);
  }
}

async function testContextGroupedRevisionMatchesAuthorityAndWrites() {
  // Authority 3 cues; the incoming SRT merges cues 2-3 into one envelope.
  const authority = [
    {startSeconds: 0, endSeconds: 1},
    {startSeconds: 1.2, endSeconds: 2},
    {startSeconds: 2, endSeconds: 2.4},
  ];
  const options = {
    revisionReviewMode: true,
    expectedExistingCaptionTracks: 1,
    newTrackName: "[검수본] 문맥 병합 · 2cue",
  };
  {
    const scenario = revisionScenarioRunner({
      initialTracks: authorityTracksWithItems(authority),
    });
    const report = await runCaptionTrackApplication(
      writeOptions(options),
      testDependencies(scenario),
    );
    assert.equal(report.ok, false);
    assert.equal(
      report.failure.code,
      "CAPTION_TIMING_AUTHORITY_CUE_COUNT_MISMATCH",
    );
    assert.equal(scenario.calls.some((call) => call.mutation), false);
  }
  const scenario = revisionScenarioRunner({
    initialTracks: authorityTracksWithItems(authority),
  });
  const report = await runCaptionTrackApplication(
    writeOptions({...options, allowContextGrouping: true}),
    testDependencies(scenario),
  );
  assert.equal(report.ok, true, JSON.stringify(report.failure));
  assert.equal(report.status, "applied-and-verified");
  assert.equal(report.policy.allowContextGrouping, true);
  assert.equal(report.revision.allowContextGrouping, true);
  const guard = report.revision.timingAuthority;
  assert.equal(guard.status, "matched-visible-authority-grouped");
  assert.equal(guard.authorityCueCount, 3);
  assert.equal(guard.coveredAuthorityCueCount, 3);
  assert.equal(guard.checkedCueCount, 2);
  assert.equal(guard.mergedIncomingCueCount, 1);
  assert.equal(guard.largestGroupSize, 2);
  assert.equal(report.verification.caption.cueCount, 2);
}

async function testContextGroupedRevisionBlocksInvalidGroupings() {
  const cases = [
    {
      reason: "end is not an authority end",
      authority: [
        {startSeconds: 0, endSeconds: 1},
        {startSeconds: 1.2, endSeconds: 2},
        {startSeconds: 2, endSeconds: 2.44},
      ],
    },
    {
      reason: "start is not the next authority start",
      authority: [
        {startSeconds: 0, endSeconds: 1},
        {startSeconds: 1.24, endSeconds: 1.8},
        {startSeconds: 1.8, endSeconds: 2.4},
      ],
    },
    {
      reason: "authority cues left uncovered",
      authority: [
        {startSeconds: 0, endSeconds: 1},
        {startSeconds: 1.2, endSeconds: 2.4},
        {startSeconds: 2.6, endSeconds: 3},
      ],
    },
    {
      reason: "group bridges a long silence",
      srt: SRT_GROUP_BRIDGES_LONG_GAP,
      authority: [
        {startSeconds: 0, endSeconds: 1},
        {startSeconds: 1.2, endSeconds: 1.6},
        {startSeconds: 3.2, endSeconds: 4},
      ],
    },
  ];
  for (const testCase of cases) {
    const scenario = revisionScenarioRunner({
      initialTracks: authorityTracksWithItems(testCase.authority),
    });
    const report = await runCaptionTrackApplication(
      writeOptions({
        revisionReviewMode: true,
        allowContextGrouping: true,
        expectedExistingCaptionTracks: 1,
        newTrackName: "[검수본] 잘못된 병합",
      }),
      testDependencies(scenario, mockFsFor(testCase.srt ?? SRT)),
    );
    assert.equal(report.ok, false, testCase.reason);
    assert.equal(report.status, "blocked-before-write", testCase.reason);
    assert.equal(
      report.failure.code,
      "CAPTION_TIMING_AUTHORITY_BOUNDARY_MISMATCH",
      testCase.reason,
    );
    assert.equal(report.failure.details.mismatch.reason, testCase.reason);
    assert.equal(report.writeAttempts.length, 0, testCase.reason);
    assert.equal(
      scenario.calls.some((call) => call.mutation),
      false,
      testCase.reason,
    );
  }
}

async function testExistingCaptionGuardStopsBeforeAnyWrite() {
  const scenario = scenarioRunner({ existingCaptionCount: 1 });
  const report = await runCaptionTrackApplication(
    writeOptions(),
    testDependencies(scenario),
  );
  assert.equal(report.ok, false);
  assert.equal(report.failure.code, "EXISTING_CAPTION_GUARD_FAILED");
  assert.equal(report.writeAttempts.length, 0);
  assert.equal(
    scenario.calls.some((call) => call.mutation),
    false,
  );
}

async function testSuccessfulWriteIsOneShotAndFullyVerified() {
  const scenario = scenarioRunner();
  const report = await runCaptionTrackApplication(
    writeOptions(),
    testDependencies(scenario),
  );
  assert.equal(report.ok, true, JSON.stringify(report.failure));
  assert.equal(report.status, "applied-and-verified");
  assert.equal(report.verification.caption.ok, true);
  assert.equal(report.verification.caption.timingComparison.checkedCueCount, 2);
  assert.equal(report.verification.caption.timingComparison.mismatchCount, 0);
  assert.equal(report.verification.captionStyle.copiedByApi, false);
  assert.equal(report.verification.captionStyle.verified, false);
  assert.equal(report.verification.sequence.ok, true);
  assert.equal(report.verification.sequence.durationUnchanged, true);
  assert.equal(report.verification.sequence.videoAudioUnchanged, true);

  const imports = scenario.calls.filter((call) => call.tool === "import_media");
  const creates = scenario.calls.filter(
    (call) => call.tool === "create_caption_track",
  );
  assert.equal(imports.length, 1);
  assert.equal(creates.length, 1);
  assert.equal(imports[0].route, "uxp");
  assert.equal(imports[0].allowExperimental, false);
  assert.equal(creates[0].route, "cep");
  assert.equal(creates[0].allowExperimental, true);
  assert.equal(report.writeAttempts.length, 2);
  assert.equal(report.writeAttempts.every((entry) => entry.attempt === 1), true);
  assert.equal(
    scenario.calls.some((call) => call.tool === "save_project"),
    false,
  );
}

async function testPostWriteVerificationRejectsMissingArrayAndCueCount() {
  const timing = {secondsPerFrame: 0.04, fps: 25};
  const options = {startSeconds: 0, newTrackName: null};

  const missingItems = createdCaptions();
  delete missingItems.tracks[0].items;
  const missingResult = verifyCaptionAddition(
    emptyCaptions(),
    missingItems,
    srtInfoFixture(),
    options,
    timing,
  );
  assert.equal(missingResult.ok, false);
  assert.equal(
    missingResult.failures.some(
      (failure) => failure.kind === "caption_item_array_missing",
    ),
    true,
  );

  const wrongCount = createdCaptions();
  wrongCount.tracks[0].itemCount = 1;
  wrongCount.tracks[0].items.length = 1;
  const countResult = verifyCaptionAddition(
    emptyCaptions(),
    wrongCount,
    srtInfoFixture(),
    options,
    timing,
  );
  assert.equal(countResult.ok, false);
  assert.equal(
    countResult.failures.some(
      (failure) =>
        failure.kind === "caption_cue_count" &&
        failure.expected === 2 &&
        failure.actual === 1,
    ),
    true,
  );
}

async function testRevisionReviewModeHidesAndMarksOldTrackBeforeAddingNew() {
  const scenario = revisionScenarioRunner();
  const report = await runCaptionTrackApplication(
    writeOptions({
      revisionReviewMode: true,
      expectedExistingCaptionTracks: 1,
      retiredTrackPrefix: "[폐기]",
      newTrackName: "[검수본] 소제목 R3 · 2cue",
    }),
    testDependencies(scenario),
  );
  assert.equal(report.ok, true, JSON.stringify(report.failure));
  assert.equal(report.revision.retirementVerification.ok, true);
  assert.equal(report.verification.caption.visibleTrackCount, 1);
  assert.equal(report.verification.caption.addedTrackName, "[검수본] 소제목 R3 · 2cue");
  assert.equal(report.post.captionTrackCount, 2);
  assert.equal(report.post.visibleCaptionTrackCount, 1);
  assert.deepEqual(
    report.post.captionTracks.map((track) => ({name: track.name, muted: track.muted})),
    [
      {name: "[폐기] Existing captions · 2cue", muted: true},
      {name: "[검수본] 소제목 R3 · 2cue", muted: false},
    ],
  );
  assert.equal(
    scenario.calls.filter((call) => call.tool === "set_caption_track_mute").length,
    1,
  );
  const renames = scenario.calls.filter((call) => call.tool === "rename_caption_track");
  assert.equal(renames.length, 2);
  assert.notEqual(renames[0].mutationKey, renames[1].mutationKey);
  const firstRetirementWrite = scenario.calls.findIndex(
    (call) => call.tool === "set_caption_track_mute",
  );
  const importWrite = scenario.calls.findIndex((call) => call.tool === "import_media");
  assert.ok(firstRetirementWrite >= 0 && firstRetirementWrite < importWrite);
}

async function testPostCreateReadRejectsLastEndOneFrameShort() {
  const scenario = revisionScenarioRunner({createdEndDeltaFrames: -1});
  const report = await runCaptionTrackApplication(
    writeOptions({
      revisionReviewMode: true,
      expectedExistingCaptionTracks: 1,
      retiredTrackPrefix: "[폐기]",
      newTrackName: "[검수본] 소제목 R3 · 2cue",
    }),
    testDependencies(scenario),
  );
  assert.equal(report.ok, false);
  assert.equal(report.status, "verification-incomplete-or-failed");
  assert.equal(report.failure.code, "POST_WRITE_INVARIANT_FAILED");
  const mismatches = report.failure.details.timingComparison.mismatches;
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].cueNumber, 2);
  assert.equal(mismatches[0].endDeltaFrames, -1);
  assert.equal(
    report.failure.details.failures.some(
      (failure) => failure.kind === "caption_cue_frame_boundary_mismatch",
    ),
    true,
  );
}

async function testLaterRevisionPreservesRetiredHistoryAndReplacesVisibleTrack() {
  const scenario = revisionScenarioRunner({
    initialTracks: [
      {
        ...existingCaptions().tracks[0],
        index: 0,
        id: "caption-track-r2",
        name: "[폐기] Existing captions · 1cue",
        muted: true,
      },
      {
        ...createdCaptions().tracks[0],
        index: 1,
        id: "caption-track-r3",
        name: "[검수본] 소제목 R3 · 2cue",
        muted: false,
      },
    ],
  });
  const report = await runCaptionTrackApplication(
    writeOptions({
      revisionReviewMode: true,
      expectedExistingCaptionTracks: 2,
      retiredTrackPrefix: "[폐기]",
      newTrackName: "[검수본] 소제목 R4 · 2cue",
    }),
    testDependencies(scenario),
  );
  assert.equal(report.ok, true, JSON.stringify(report.failure));
  assert.equal(report.post.captionTrackCount, 3);
  assert.equal(report.post.visibleCaptionTrackCount, 1);
  assert.deepEqual(
    report.post.captionTracks.map((track) => ({name: track.name, muted: track.muted})),
    [
      {name: "[폐기] Existing captions · 1cue", muted: true},
      {name: "[폐기] [검수본] 소제목 R3 · 2cue", muted: true},
      {name: "[검수본] 소제목 R4 · 2cue", muted: false},
    ],
  );
  assert.equal(
    scenario.calls.filter((call) => call.tool === "set_caption_track_mute").length,
    1,
  );
  assert.equal(
    scenario.calls.filter((call) => call.tool === "rename_caption_track").length,
    2,
  );
}

async function testUncertainImportStopsWithoutCreateOrRetry() {
  const scenario = scenarioRunner({ uncertainTool: "import_media" });
  const report = await runCaptionTrackApplication(
    writeOptions(),
    testDependencies(scenario),
  );
  assert.equal(report.ok, false);
  assert.equal(report.status, "write-outcome-uncertain");
  assert.equal(report.writeAttempts.length, 1);
  assert.equal(report.writeAttempts[0].tool, "import_media");
  assert.equal(report.writeAttempts[0].outcome, "uncertain");
  assert.equal(
    scenario.calls.filter((call) => call.tool === "import_media").length,
    1,
  );
  assert.equal(
    scenario.calls.filter((call) => call.tool === "create_caption_track").length,
    0,
  );
  assert.match(report.partialState.nextAction, /Do not resend/);
}

async function testUncertainCaptionCreateStopsWithoutPostCallsOrRetry() {
  const scenario = scenarioRunner({ uncertainTool: "create_caption_track" });
  const report = await runCaptionTrackApplication(
    writeOptions(),
    testDependencies(scenario),
  );
  assert.equal(report.ok, false);
  assert.equal(report.status, "write-outcome-uncertain");
  assert.equal(
    scenario.calls.filter((call) => call.tool === "import_media").length,
    1,
  );
  assert.equal(
    scenario.calls.filter((call) => call.tool === "create_caption_track").length,
    1,
  );
  const createIndex = scenario.calls.findIndex(
    (call) => call.tool === "create_caption_track",
  );
  assert.equal(createIndex, scenario.calls.length - 1);
  assert.equal(report.partialState.srtProjectItemMayRemain, true);
  assert.equal(report.partialState.captionTrackMayExist, true);
}

async function main() {
  const tests = [
    testArgumentAndChildArrayContracts,
    testWritePermissionGatesRunBeforePremiereCalls,
    testDefaultDryRunIsReadOnly,
    testRevisionTimingAuthorityExactMatchPassesInDryRun,
    testSrtImportFloorMismatchBlocksBeforeWrite,
    testRevisionTimingAuthorityCueCountMismatchBlocksBeforeWrite,
    testRevisionTimingAuthorityOneFrameMismatchBlocksBeforeWrite,
    testFinalCueTransportCompensationIsExplicitAndExact,
    testFinalCueTransportCompensationRejectsWrongDelta,
    testFinalCueCompensationBlocksAtOrOutsideSequenceTail,
    testRevisionTimingAuthorityRequiresExactlyOneVisibleTrack,
    testExplicitCaptionRetimeOverridePermitsRevisionWrite,
    testContextGroupingOptionGates,
    testContextGroupedRevisionMatchesAuthorityAndWrites,
    testContextGroupedRevisionBlocksInvalidGroupings,
    testExistingCaptionGuardStopsBeforeAnyWrite,
    testSuccessfulWriteIsOneShotAndFullyVerified,
    testPostWriteVerificationRejectsMissingArrayAndCueCount,
    testRevisionReviewModeHidesAndMarksOldTrackBeforeAddingNew,
    testPostCreateReadRejectsLastEndOneFrameShort,
    testLaterRevisionPreservesRetiredHistoryAndReplacesVisibleTrack,
    testUncertainImportStopsWithoutCreateOrRetry,
    testUncertainCaptionCreateStopsWithoutPostCallsOrRetry,
  ];
  for (const test of tests) await test();
  console.log(
    JSON.stringify(
      {
        ok: true,
        suite: "apply-premiere-caption-track",
        tests: tests.length,
        guarantees: [
          "dry-run submits zero writes",
          "write gates run before Premiere access",
          "existing tracks require explicit revision-review mode",
          "revision-review compares SRT import-floor frames with native nearest frames for every protected boundary",
          "ambiguous or missing timing authority blocks before writes unless an explicit caption-retime override is supplied",
          "--allow-context-grouping accepts only contiguous merges on exact authority frames that cover every authority cue once without bridging a >1.5s gap",
          "Premiere final-cue transport compensation accepts only an explicit +1f encoded final end and verifies the canonical live boundary",
          "compensated final ends must remain strictly before the sequence duration frame exclusive",
          "revision-review mode marks and mutes old tracks before adding one visible revision",
          "import_media and create_caption_track are each one-shot",
          "uncertain writes stop without retry or a later write",
          "post-read verifies every caption cue using SRT import-floor versus native nearest frames plus complete V/A invariants",
          "caption style inheritance is never claimed because the official API cannot copy it",
          "save_project is never called",
        ],
      },
      null,
      2,
    ),
  );
}

await main();
