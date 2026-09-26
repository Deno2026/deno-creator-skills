import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertLargeV3ModelReference,
  filterAudioMapByTargetItem,
  parseArgs,
} from "./transcribe-premiere-timeline.mjs";

const scriptPath = fileURLToPath(new URL("./transcribe-premiere-timeline.mjs", import.meta.url));
const repoTempRoot = path.resolve(path.dirname(scriptPath), "..", "tmp", "self-tests");
await mkdir(repoTempRoot, {recursive: true});
const tempRoot = await mkdtemp(path.join(repoTempRoot, "premiere-transcription-self-test-"));

try {
  const defaults = parseArgs([]);
  assert.equal(defaults.mode, "whisper");
  assert.equal(defaults.model, "Systran/faster-whisper-large-v3");
  assert.equal(assertLargeV3ModelReference(defaults.model), defaults.model);
  assert.equal(defaults.timingToleranceMs, null);
  assert.equal(defaults.vadFilter, false);
  assert.equal(parseArgs(["--no-vad-filter"]).vadFilter, false);
  assert.equal(parseArgs(["--no-vad-filter", "--vad-filter"]).vadFilter, true);
  assert.equal(parseArgs(["--timing-tolerance-ms", "34"]).timingToleranceMs, 34);
  assert.throws(
    () => parseArgs(["--timing-tolerance-ms", "101"]),
    /between 0 and 100/u,
  );
  assert.throws(
    () => parseArgs(["--model", "Systran/faster-whisper-small"]),
    /fixed Whisper large-v3/u,
  );
  const helpResult = spawnSync(process.execPath, [scriptPath, "--help"], { encoding: "utf8", windowsHide: true });
  assert.equal(helpResult.status, 0, helpResult.stderr);
  assert.match(helpResult.stdout, /--target-item-name <name>/u);

  const baseAudioMap = {
    projectName: "fixture.prproj",
    sequenceName: "fixture-sequence",
    sequenceDurationSeconds: 5,
    audioTimeline: [{
      trackIndex: 0,
      name: "speech.wav",
      startSeconds: 0,
      endSeconds: 5,
      inPointSeconds: 1,
      outPointSeconds: 6,
      mediaPath: "X:\\fixture.wav",
    }],
  };
  assert.deepEqual(
    filterAudioMapByTargetItem(baseAudioMap, [0], ""),
    {
      ...baseAudioMap,
      audioTimeline: baseAudioMap.audioTimeline,
      audioClipCount: 1,
    },
  );
  assert.equal(filterAudioMapByTargetItem(baseAudioMap, [0], "speech.wav").audioClipCount, 1);
  assert.throws(
    () => filterAudioMapByTargetItem(baseAudioMap, [1], "speech.wav"),
    /No audio clip matched target item name/u,
  );
  const statePath = path.join(tempRoot, "state.json");
  const summaryPath = path.join(tempRoot, "summary.json");
  const mapPath = path.join(tempRoot, "map.json");
  const transcriptPath = path.join(tempRoot, "transcript.json");
  const whisperTranscriptPath = path.join(tempRoot, "whisper-transcript.json");
  const targetMapPath = path.join(tempRoot, "target-map.json");
  const targetTranscriptPath = path.join(tempRoot, "target-transcript.json");
  const outDir = path.join(tempRoot, "out");
  await writeFile(statePath, JSON.stringify({
    project: { name: "fixture.prproj" },
    activeSequence: { name: "fixture-sequence", durationSeconds: 5 },
  }), "utf8");
  await writeFile(summaryPath, JSON.stringify({
    name: "fixture-sequence",
    durationSeconds: 5,
    frameRate: { seconds: 1 / 25 },
  }), "utf8");
  await writeFile(mapPath, JSON.stringify({
    projectName: "fixture.prproj",
    sequenceName: "fixture-sequence",
    sequenceDurationSeconds: 5,
    audioTimeline: [{
      trackIndex: 0,
      name: "source.wav",
      startSeconds: 0,
      endSeconds: 5,
      inPointSeconds: 1,
      outPointSeconds: 6,
      mediaPath: "X:\\fixture.wav",
    }],
  }), "utf8");
  await writeFile(transcriptPath, JSON.stringify({
    items: [{
      name: "source.wav",
      words: [
        { text: "테스트", startSeconds: 1.2, endSeconds: 1.8 },
        { text: "문장입니다.", startSeconds: 1.8, endSeconds: 2.8 },
        { text: "두", startSeconds: 3.6, endSeconds: 3.9 },
        { text: "번째", startSeconds: 3.9, endSeconds: 4.4 },
        { text: "문장입니다.", startSeconds: 4.4, endSeconds: 5.2 },
      ],
    }],
  }), "utf8");
  await writeFile(whisperTranscriptPath, JSON.stringify({
    words: [
      { text: "테스트", start: 0.2, end: 0.8 },
      { text: "문장입니다.", start: 0.8, end: 1.8 },
    ],
  }), "utf8");
  await writeFile(targetMapPath, JSON.stringify({
    projectName: "fixture.prproj",
    sequenceName: "fixture-sequence",
    sequenceDurationSeconds: 5,
    audioTimeline: [
      {
        trackIndex: 0,
        name: "bgm.wav",
        startSeconds: 0,
        endSeconds: 5,
        inPointSeconds: 0,
        outPointSeconds: 5,
        mediaPath: "X:\\fixture-bgm.wav",
      },
      {
        trackIndex: 0,
        name: "voice.wav",
        startSeconds: 0,
        endSeconds: 5,
        inPointSeconds: 0,
        outPointSeconds: 5,
        mediaPath: "X:\\fixture-voice.wav",
      },
    ],
  }), "utf8");
  await writeFile(targetTranscriptPath, JSON.stringify({
    items: [
      {
        name: "bgm.wav",
        words: [
          { text: "도입부", startSeconds: 0, endSeconds: 1 },
        ],
      },
      {
        name: "voice.wav",
        words: [
          { text: "안녕하세요", startSeconds: 0.5, endSeconds: 1.5 },
          { text: "타겟", startSeconds: 1.6, endSeconds: 2.0 },
          { text: "문장이에요", startSeconds: 2.1, endSeconds: 3.0 },
        ],
      },
    ],
  }), "utf8");

  const result = spawnSync(process.execPath, [
    scriptPath,
    "--mode", "premiere",
    "--out-dir", outDir,
    "--audio-map", mapPath,
    "--transcript-json", transcriptPath,
    "--state-json", statePath,
    "--summary-json", summaryPath,
    "--expected-project", "fixture.prproj",
    "--expected-sequence", "fixture-sequence",
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(result.stdout);
  assert.equal(manifest.sourceMode, "premiere");
  assert.equal(manifest.transcriptionPolicy.modelFamily, "large-v3");
  assert.equal(manifest.transcriptionPolicy.device, "cuda");
  assert.equal(manifest.transcriptionPolicy.computeType, "float16");
  assert.equal(manifest.transcriptionPolicy.automaticRuntimeDowngrade, false);
  assert.equal(manifest.transcriptionPolicy.audioReconstructionTimingToleranceMs, null);
  assert.equal(manifest.transcriptionPolicy.vadFilter, false);
  assert.equal(manifest.premiereWrites, 0);
  assert.equal(manifest.projectSaved, false);
  assert.equal(manifest.qcPassed, true);
  assert.equal(manifest.cueCount, 2);
  const srt = await readFile(manifest.files.draftSrt, "utf8");
  assert.match(srt, /테스트 문장입니다\./u);
  assert.equal(srt.startsWith("\uFEFF"), true);
  const qc = JSON.parse(await readFile(manifest.files.captionQc, "utf8"));
  assert.equal(qc.ok, true);
  assert.equal(qc.limits.maxLineLength, 42);
  const cueMap = JSON.parse(await readFile(manifest.files.cueMap, "utf8"));
  assert.equal(cueMap.cueCount, 2);
  assert.deepEqual(cueMap.cues[0].sourceWordPositionRange, {
    startInclusive: 0,
    endInclusive: 1,
  });
  assert.equal(cueMap.cues[0].displayLines.join(" "), cueMap.cues[0].text);

  const targetResult = spawnSync(process.execPath, [
    scriptPath,
    "--mode", "premiere",
    "--out-dir", path.join(tempRoot, "target"),
    "--audio-map", targetMapPath,
    "--transcript-json", targetTranscriptPath,
    "--state-json", statePath,
    "--summary-json", summaryPath,
    "--target-item-name", "voice.wav",
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(targetResult.status, 0, targetResult.stderr);
  const targetManifest = JSON.parse(targetResult.stdout);
  assert.equal(targetManifest.sourceMode, "premiere");
  assert.equal(targetManifest.wordCount, 3);
  assert.deepEqual(
    JSON.parse(await readFile(targetManifest.files.audioMap, "utf8")).audioClipCount,
    1,
  );
  const targetSrt = await readFile(targetManifest.files.draftSrt, "utf8");
  assert.match(targetSrt, /안녕하세요 타겟 문장이에요/u);
  assert.ok(!targetSrt.includes("도입부"), "BGM transcript should be excluded by target-item-name");

  const whisperTargetResult = spawnSync(process.execPath, [
    scriptPath,
    "--mode", "whisper",
    "--out-dir", path.join(tempRoot, "whisper-target"),
    "--audio-map", targetMapPath,
    "--transcript-json", whisperTranscriptPath,
    "--state-json", statePath,
    "--summary-json", summaryPath,
    "--target-item-name", "voice.wav",
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(whisperTargetResult.status, 0, whisperTargetResult.stderr);
  const whisperTargetManifest = JSON.parse(whisperTargetResult.stdout);
  assert.equal(whisperTargetManifest.sourceMode, "whisper");
  assert.equal(
    JSON.parse(await readFile(whisperTargetManifest.files.audioMap, "utf8")).audioClipCount,
    1,
  );

  const whisperTargetMiss = spawnSync(process.execPath, [
    scriptPath,
    "--mode", "premiere",
    "--out-dir", path.join(tempRoot, "target-miss"),
    "--audio-map", targetMapPath,
    "--transcript-json", targetTranscriptPath,
    "--state-json", statePath,
    "--summary-json", summaryPath,
    "--target-item-name", "no-such-clip.wav",
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(whisperTargetMiss.status, 1);
  assert.match(whisperTargetMiss.stderr, /No audio clip matched target item name: no-such-clip\.wav/u);

  const whisperReuse = spawnSync(process.execPath, [
    scriptPath,
    "--mode", "whisper",
    "--out-dir", path.join(tempRoot, "whisper-reuse"),
    "--audio-map", mapPath,
    "--transcript-json", whisperTranscriptPath,
    "--state-json", statePath,
    "--summary-json", summaryPath,
    "--no-vad-filter",
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(whisperReuse.status, 0, whisperReuse.stderr);
  const whisperReuseManifest = JSON.parse(whisperReuse.stdout);
  assert.equal(whisperReuseManifest.sourceMode, "whisper");
  assert.equal(whisperReuseManifest.transcriptionPolicy.vadFilter, false);
  assert.equal(whisperReuseManifest.wordCount, 2);
  assert.equal(whisperReuseManifest.files.timelineAudio, null);
  assert.equal(
    JSON.parse(await readFile(whisperReuseManifest.files.cueMap, "utf8")).cues[0].sourceWordIndices.length,
    2,
  );

  const phrase = "오늘은 우리가 만든 여러 기능을 함께 살펴보고 앞으로의 방향성에 대해서 한번 자세히 말씀드려볼까 합니다.";
  const phraseWords = phrase.split(" ").map((text, index) => ({text, start: 0.1 + index * 0.3, end: 0.35 + index * 0.3}));
  await writeFile(whisperTranscriptPath, JSON.stringify({words: phraseWords}), "utf8");
  const naturalReuse = spawnSync(process.execPath, [
    scriptPath, "--mode", "whisper", "--out-dir", path.join(tempRoot, "natural-reuse"),
    "--audio-map", mapPath, "--transcript-json", whisperTranscriptPath,
    "--state-json", statePath, "--summary-json", summaryPath,
  ], {encoding: "utf8", windowsHide: true});
  assert.equal(naturalReuse.status, 0, naturalReuse.stderr);
  const naturalManifest = JSON.parse(naturalReuse.stdout);
  const naturalMap = JSON.parse(await readFile(naturalManifest.files.cueMap, "utf8"));
  assert.equal(naturalMap.cueCount, 1);
  assert.equal(naturalMap.cues[0].text, phrase);
  assert.equal(naturalMap.cues[0].displayLines.length, 2);
  assert.deepEqual(naturalMap.cues[0].sourceWordIndices, phraseWords.map((_, index) => index));

  const drift = spawnSync(process.execPath, [
    scriptPath,
    "--mode", "premiere",
    "--out-dir", path.join(tempRoot, "drift"),
    "--audio-map", mapPath,
    "--transcript-json", transcriptPath,
    "--state-json", statePath,
    "--summary-json", summaryPath,
    "--expected-project", "wrong.prproj",
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /Active project mismatch/u);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ success: true }, null, 2)}\n`);
