import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildPremiereTranscriptionAudio,
  buildTranscriptionAudioPlan,
  parseArgs,
} from "./build-premiere-transcription-audio.mjs";

function commandExists(command) {
  const result = spawnSync(command, ["-version"], { windowsHide: true, stdio: "ignore" });
  return result.status === 0;
}

function makeBaseMap(mediaA, mediaB) {
  return {
    projectName: "Synthetic",
    projectPath: "synthetic.prproj",
    sequenceName: "Dialogue",
    sequenceId: "seq-1",
    sequenceDurationSeconds: 3.5,
    audioTrackCount: 3,
    audioClipCount: 4,
    audioTimeline: [
      {
        trackIndex: 0,
        clipIndex: 0,
        nodeId: "a",
        name: "A first",
        startSeconds: 0.5,
        endSeconds: 1.5,
        inPointSeconds: 0.25,
        outPointSeconds: 1.25,
        mediaPath: mediaA,
      },
      {
        trackIndex: 0,
        clipIndex: 1,
        nodeId: "b",
        name: "A second",
        startSeconds: 2,
        endSeconds: 3,
        inPointSeconds: 1.25,
        outPointSeconds: 2.25,
        mediaPath: mediaA,
      },
      {
        trackIndex: 1,
        clipIndex: 0,
        nodeId: "c",
        name: "B",
        startSeconds: 1,
        endSeconds: 2,
        inPointSeconds: 0,
        outPointSeconds: 1,
        mediaPath: mediaB,
      },
      {
        trackIndex: 2,
        clipIndex: 0,
        nodeId: "disabled",
        name: "Disabled",
        enabled: false,
        startSeconds: 0,
        endSeconds: 1,
        inPointSeconds: 0,
        outPointSeconds: 1,
        mediaPath: "definitely-missing.wav",
      },
    ],
  };
}

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-transcription-audio-test-"));
let retainedFailureDirectory = "";
try {
  const mediaA = path.join(testRoot, "media-a.wav");
  const mediaB = path.join(testRoot, "media-b.wav");
  fs.writeFileSync(mediaA, "fixture", "utf8");
  fs.writeFileSync(mediaB, "fixture", "utf8");

  const outputPath = path.join(testRoot, "out", "dialogue.wav");
  const map = makeBaseMap(mediaA, mediaB);
  const plan = buildTranscriptionAudioPlan(map, { tracks: [1, 0, 1], outputPath });
  assert.deepEqual(plan.selectedTracks, [0, 1]);
  assert.equal(plan.selectedClipCount, 3);
  assert.equal(plan.sequenceDurationSamples, 56_000);
  assert.equal(plan.trackPlans[0].pieces[0].kind, "silence");
  assert.equal(plan.trackPlans[0].pieces.at(-1).kind, "silence");
  assert.equal(plan.trackPlans[1].clips.length, 1);
  assert.equal(plan.outputPath, path.resolve(outputPath));

  assert.deepEqual(parseArgs(["--map", "a.json", "--out", "b.wav", "--track", "2", "--track", "3", "--dry-run"]), {
    tracks: ["2", "3"],
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    timeoutMs: 1_800_000,
    timingToleranceSeconds: 0.002,
    mapPath: "a.json",
    outputPath: "b.wav",
    dryRun: true,
  });

  const overlapMap = structuredClone(map);
  overlapMap.audioTimeline[1].startSeconds = 1.4;
  overlapMap.audioTimeline[1].endSeconds = 2.4;
  assert.throws(
    () => buildTranscriptionAudioPlan(overlapMap, { tracks: [0], outputPath }),
    /overlapping clips/,
  );

  const speedMap = structuredClone(map);
  speedMap.audioTimeline[0].speedPercent = 125;
  assert.throws(
    () => buildTranscriptionAudioPlan(speedMap, { tracks: [0], outputPath }),
    /unsupported playback speed/,
  );

  const mismatchMap = structuredClone(map);
  mismatchMap.audioTimeline[0].outPointSeconds = 1.1;
  assert.throws(
    () => buildTranscriptionAudioPlan(mismatchMap, { tracks: [0], outputPath }),
    /duration mismatch/,
  );

  const missingMap = structuredClone(map);
  missingMap.audioTimeline[0].mediaPath = path.join(testRoot, "missing.wav");
  assert.throws(
    () => buildTranscriptionAudioPlan(missingMap, { tracks: [0], outputPath }),
    /media is missing/,
  );

  assert.throws(
    () => buildTranscriptionAudioPlan(map, { tracks: [3], outputPath }),
    /does not exist/,
  );

  if (commandExists("ffmpeg") && commandExists("ffprobe")) {
    const sourceA = path.join(testRoot, "source-a.wav");
    const sourceB = path.join(testRoot, "source-b.wav");
    for (const [sourcePath, frequency] of [[sourceA, 440], [sourceB, 660]]) {
      const generated = spawnSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=3`,
        "-c:a", "pcm_s16le", sourcePath,
      ], { windowsHide: true, encoding: "utf8" });
      assert.equal(generated.status, 0, generated.stderr);
    }

    const actualMap = {
      projectName: "Synthetic FFmpeg",
      sequenceName: "Mixed gaps",
      sequenceId: "seq-ffmpeg",
      sequenceDurationSeconds: 2,
      audioTrackCount: 2,
      audioTimeline: [
        {
          trackIndex: 0,
          clipIndex: 0,
          startSeconds: 0.25,
          endSeconds: 0.75,
          inPointSeconds: 0.1,
          outPointSeconds: 0.6,
          mediaPath: sourceA,
        },
        {
          trackIndex: 0,
          clipIndex: 1,
          startSeconds: 1.25,
          endSeconds: 1.75,
          inPointSeconds: 1,
          outPointSeconds: 1.5,
          mediaPath: sourceA,
        },
        {
          trackIndex: 1,
          clipIndex: 0,
          startSeconds: 0.75,
          endSeconds: 1.25,
          inPointSeconds: 0.5,
          outPointSeconds: 1,
          mediaPath: sourceB,
        },
      ],
    };
    const actualOutput = path.join(testRoot, "actual", "mixed.wav");
    const actualPlan = buildTranscriptionAudioPlan(actualMap, {
      tracks: [0, 1],
      outputPath: actualOutput,
    });
    const result = await buildPremiereTranscriptionAudio(actualPlan);
    assert.equal(result.durationSamples, 32_000);
    assert.equal(result.sampleRate, 16_000);
    assert.equal(result.channels, 1);
    assert.equal(result.codec, "pcm_s16le");
    assert.equal(fs.existsSync(actualOutput), true);
    const tmpParent = path.join(path.dirname(actualOutput), "tmp");
    assert.deepEqual(fs.existsSync(tmpParent) ? fs.readdirSync(tmpParent) : [], []);

    const duration = spawnSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", actualOutput,
    ], { windowsHide: true, encoding: "utf8" });
    assert.equal(duration.status, 0, duration.stderr);
    assert.ok(Math.abs(Number(duration.stdout.trim()) - 2) <= 1 / 16_000);

    const decoded = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-i", actualOutput, "-map", "0:a:0", "-f", "s16le", "-ac", "1", "-ar", "16000", "-",
    ], { windowsHide: true, encoding: null, maxBuffer: 256_000 });
    assert.equal(decoded.status, 0, decoded.stderr?.toString("utf8"));
    const pcm = decoded.stdout;
    assert.equal(pcm.length, 32_000 * 2);
    const windowRms = (centerSeconds, radiusSamples = 400) => {
      const center = Math.round(centerSeconds * 16_000);
      let sumSquares = 0;
      let count = 0;
      for (let sample = center - radiusSamples; sample < center + radiusSamples; sample += 1) {
        const value = pcm.readInt16LE(sample * 2);
        sumSquares += value * value;
        count += 1;
      }
      return Math.sqrt(sumSquares / count);
    };
    assert.ok(windowRms(0.1) < 1, "leading gap must be silence");
    assert.ok(windowRms(0.5) > 100, "first track clip must occupy its timeline position");
    assert.ok(windowRms(1.0) > 100, "second selected track must be mixed at its timeline position");
    assert.ok(windowRms(1.5) > 100, "later same-track clip must survive concat");
    assert.ok(windowRms(1.9) < 1, "trailing gap must be silence");
    console.log("FFmpeg integration: passed");
  } else {
    console.log("FFmpeg integration: skipped (ffmpeg/ffprobe unavailable)");
  }

  console.log("build-premiere-transcription-audio self-test: passed");
} catch (error) {
  const match = /Temporary diagnostics retained at: (.+)$/.exec(error.message ?? "");
  if (match) retainedFailureDirectory = match[1];
  throw error;
} finally {
  if (!retainedFailureDirectory) fs.rmSync(testRoot, { recursive: true, force: true });
}
