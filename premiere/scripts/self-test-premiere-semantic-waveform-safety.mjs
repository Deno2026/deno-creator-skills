import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { attachPremiereSemanticWaveformSafety } from "./lib/premiere-semantic-waveform-safety.mjs";
import { buildPremiereDirectCutManifest } from "./lib/premiere-direct-cut-manifest.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "scripts", "attach-premiere-semantic-waveform-safety.mjs");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-waveform-safety-"));
const sampleRate = 16000;

function writeMonoWave(filePath, durationSeconds, voicedRanges) {
  const sampleCount = Math.round(durationSeconds * sampleRate);
  const data = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const seconds = index / sampleRate;
    const voiced = voicedRanges.some(([start, end]) => seconds >= start && seconds < end);
    const sample = voiced ? Math.round(Math.sin(2 * Math.PI * 440 * seconds) * 20000) : 0;
    data.writeInt16LE(sample, index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

function scopedWord(text, startSeconds, endSeconds, extra = {}) {
  return {
    text,
    startSeconds,
    endSeconds,
    timelineClipIndex: 0,
    clipNodeId: "target-clip",
    projectItemNodeId: "target-item",
    ...extra,
  };
}

function repeatInput(words, mediaName) {
  return {
    schemaVersion: 1,
    fps: 30,
    target: {
      name: mediaName,
      clipNodeId: "target-clip",
      projectItemNodeId: "target-item",
    },
    words,
  };
}

function clipSpec(media, extra = {}) {
  return {
    fps: 30,
    clips: [{
      media,
      timelineStart: 0,
      timelineEnd: 2.6,
      sourceIn: 0,
      sourceOut: 2.6,
      timelineClipIndex: 0,
      clipNodeId: "target-clip",
      projectItemNodeId: "target-item",
      name: path.basename(media),
      ...extra,
    }],
  };
}

async function bind(input, clips, options = {}) {
  return attachPremiereSemanticWaveformSafety({
    repeatInput: input,
    clipSpec: clips,
    options,
    repoRoot,
  });
}

try {
  const exactMedia = path.join(tempRoot, "exact.wav");
  const restartMedia = path.join(tempRoot, "restart.wav");
  const unsafeMedia = path.join(tempRoot, "unsafe.wav");
  const shortHandleMedia = path.join(tempRoot, "short-handle.wav");
  writeMonoWave(exactMedia, 2.6, [[0.25, 0.85], [1.1, 2.1]]);
  writeMonoWave(restartMedia, 2.6, [[0.25, 0.9], [1.15, 2.2]]);
  writeMonoWave(unsafeMedia, 2.6, [[0, 2.3]]);
  writeMonoWave(shortHandleMedia, 2.6, [[0, 0.23], [0.25, 0.92], [0.94, 2.2]]);

  const exactWords = [
    scopedWord("오늘", 0.25, 0.5),
    scopedWord("계획을", 0.5, 0.85),
    scopedWord("오늘", 1.1, 1.35),
    scopedWord("계획을", 1.35, 1.7),
    scopedWord("설명합니다.", 1.7, 2.1),
  ];
  const exact = await bind(
    repeatInput(exactWords, path.basename(exactMedia)),
    clipSpec(exactMedia),
  );
  assert.equal(exact.mode, "premiere_repeat_cut_proposal");
  assert.equal(exact.summary.candidateCount, 1);
  assert.equal(exact.summary.proposalEligibleCount, 1);
  assert.equal(exact.candidates[0].type, "exact_adjacent_repeat");
  assert.equal(exact.candidates[0].proposalEligible, true);
  assert.equal(exact.candidates[0].waveformSafety.verified, true);
  assert.equal(exact.candidates[0].waveformSafety.thresholdMode, "peak");
  assert.equal(exact.candidates[0].waveformSafety.boundaryFrames.length, 2);
  assert.equal(exact.candidates[0].waveformSafety.cutRanges.length, 1);
  assert.equal(exact.candidates[0].waveformSafety.sourceMapping.clipNodeId, "target-clip");
  assert.match(exact.candidates[0].waveformSafety.interiorPeakAudit, /expected_to_be_voiced/u);
  assert.equal(exact.semanticBoundaryAudit.auditedBoundaryCount, 2);
  assert.equal(exact.semanticBoundaryAudit.verifiedCutCount, 1);
  assert.equal(exact.semanticBoundaryAudit.interiorPeakAuditCutCount, 0);
  assert.deepEqual(exact.waveformSafety.cutRanges.map(({ startFrame, endFrame }) => [
    startFrame,
    endFrame,
  ]), [[exact.candidates[0].startFrame, exact.candidates[0].endFrame]]);
  const manifestCaptureBinding = {
    captureSha256: "A".repeat(64),
    targetBindingSha256: "B".repeat(64),
    bundleSha256: "C".repeat(64),
  };
  const directManifest = buildPremiereDirectCutManifest({
    identity: {
      projectName: "binder-test.prproj",
      sequenceName: "Main 30fps",
      sequenceId: "sequence-binder-test",
      sequenceDurationSeconds: 2.6,
      fps: 30,
      ticksPerFrame: "8467200000",
      timecodeDisplay: { nominalFps: 30, dropFrame: false },
      targetTracks: ["V1", "A1"],
      targetClipNames: [path.basename(exactMedia)],
      ...manifestCaptureBinding,
    },
    waveform: {
      mode: "waveform-only",
      writeReady: true,
      candidatePeakAudit: {
        energyMode: "peak",
        bridgeSilenceGapSeconds: 0,
        suspiciousCutCount: 0,
        auditedCutCount: 1,
        suspiciousPeakThresholdDb: -44,
      },
      waveformSnapEvidence: {
        integerFrameBoundaries: true,
        allBoundariesSnapped: true,
        fps: 30,
      },
      options: { silenceDb: -44, fps: 30, ticksPerFrame: "8467200000" },
      ...manifestCaptureBinding,
      cuts: [{ startFrame: 66, endFrame: 69, reason: "verified trailing silence" }],
    },
    semantic: [{...exact, waveformSafetyBinding: manifestCaptureBinding}],
  });
  assert.equal(directManifest.summary.semanticEligibleCutCount, 1);
  assert.equal(directManifest.mode, "semantic-editorial");

  const exactStat = fs.statSync(exactMedia);
  const directCaptureInput = {
    ...repeatInput(exactWords.map((word) => ({
      ...word,
      clipNodeId: "target-audio-node",
    })), path.basename(exactMedia)),
    captureSha256: "CAPTURE-A",
    targetBindingSha256: "BINDING-A",
    bundleSha256: "BUNDLE-A",
    target: {
      name: path.basename(exactMedia),
      videoNodeId: "target-video-node",
      audioNodeId: "target-audio-node",
      projectItemNodeId: "target-item",
    },
  };
  const directCaptureClips = {
    schemaVersion: 1,
    fps: 30,
    ticksPerFrame: "8467200000",
    captureSha256: "CAPTURE-A",
    targetBindingSha256: "BINDING-A",
    bundleSha256: "BUNDLE-A",
    clips: [{
      media: exactMedia,
      sourceIn: 0,
      sourceOut: 2.6,
      timelineStart: 0,
      timelineEnd: 2.6,
      targetClipName: path.basename(exactMedia),
      videoClipIndex: 0,
      audioClipIndex: 0,
      videoNodeId: "target-video-node",
      audioNodeId: "target-audio-node",
      projectItemNodeId: "target-item",
      mediaEvidence: {
        path: exactMedia,
        sizeBytes: exactStat.size,
        mtimeMs: Math.trunc(exactStat.mtimeMs),
      },
    }],
  };
  const directCaptureBound = await bind(directCaptureInput, directCaptureClips);
  assert.equal(directCaptureBound.summary.proposalEligibleCount, 1);
  assert.deepEqual(
    directCaptureBound.candidates[0].waveformSafety.sourceMapping.clipNodeIds,
    ["target-video-node", "target-audio-node"],
  );
  assert.equal(directCaptureBound.waveformSafetyBinding.bundleSha256, "BUNDLE-A");
  await assert.rejects(
    () => bind(
      { ...directCaptureInput, captureSha256: "DIFFERENT-CAPTURE" },
      directCaptureClips,
    ),
    /captureSha256 mismatch/u,
  );

  const restartWords = [
    scopedWord("오늘", 0.25, 0.48),
    scopedWord("영상에서", 0.48, 0.7),
    scopedWord("모델을...", 0.7, 0.9),
    scopedWord("오늘", 1.15, 1.38),
    scopedWord("영상에서", 1.38, 1.62),
    scopedWord("기능을", 1.62, 1.9),
    scopedWord("설명합니다.", 1.9, 2.2),
  ];
  const restart = await bind(
    repeatInput(restartWords, path.basename(restartMedia)),
    clipSpec(restartMedia),
  );
  assert.equal(restart.summary.proposalEligibleCount, 1);
  assert.equal(restart.candidates[0].type, "immediate_restart");
  assert.equal(restart.candidates[0].waveformSafety.verified, true);

  const similar = await bind(repeatInput([
    scopedWord("이", 0.25, 0.4),
    scopedWord("모델은", 0.4, 0.65),
    scopedWord("빠릅니다", 0.65, 0.85),
    scopedWord("이", 1.1, 1.25),
    scopedWord("도구는", 1.25, 1.5),
    scopedWord("속도가", 1.5, 1.8),
    scopedWord("좋습니다.", 1.8, 2.1),
  ], path.basename(exactMedia)), clipSpec(exactMedia));
  assert.equal(similar.summary.candidateCount, 0);

  const filler = await bind(repeatInput([
    scopedWord("어", 0.25, 0.4),
    scopedWord("음", 0.4, 0.6),
    scopedWord("어", 0.7, 0.85),
    scopedWord("음", 0.85, 1.05),
    scopedWord("시작합니다.", 1.1, 1.5),
  ], path.basename(exactMedia)), clipSpec(exactMedia));
  assert.equal(filler.summary.candidateCount, 0);

  const terminal = await bind(repeatInput([
    scopedWord("정말", 0.25, 0.5),
    scopedWord("좋습니다.", 0.5, 0.85),
    scopedWord("정말", 1.1, 1.35),
    scopedWord("좋습니다.", 1.35, 1.7),
  ], path.basename(exactMedia)), clipSpec(exactMedia));
  assert.equal(terminal.summary.candidateCount, 0);

  const unsafe = await bind(
    repeatInput(exactWords, path.basename(unsafeMedia)),
    clipSpec(unsafeMedia),
  );
  assert.equal(unsafe.summary.candidateCount, 1);
  assert.equal(unsafe.summary.proposalEligibleCount, 0);
  assert.equal(unsafe.candidates[0].reviewRequired, true);
  assert.equal(unsafe.candidates[0].waveformSafety.verified, false);
  assert.equal(unsafe.candidates[0].waveformSafety.failureReason, "low_energy_boundary_handle_not_found");

  const tooLittleHandle = await bind(
    repeatInput(exactWords, path.basename(shortHandleMedia)),
    clipSpec(shortHandleMedia),
    { minHandleFrames: 2 },
  );
  assert.equal(tooLittleHandle.summary.proposalEligibleCount, 0);

  const crossClip = await bind(repeatInput([
    scopedWord("오늘", 0.25, 0.5),
    scopedWord("계획을", 0.5, 0.85),
    scopedWord("오늘", 1.1, 1.35, { timelineClipIndex: 1, clipNodeId: "other-clip" }),
    scopedWord("계획을", 1.35, 1.7, { timelineClipIndex: 1, clipNodeId: "other-clip" }),
  ], path.basename(exactMedia)), clipSpec(exactMedia));
  assert.equal(crossClip.summary.candidateCount, 0);

  const mismatch = await bind(
    repeatInput(exactWords, path.basename(exactMedia)),
    clipSpec(exactMedia, { mediaFileSize: fs.statSync(exactMedia).size + 1 }),
  );
  assert.equal(mismatch.summary.proposalEligibleCount, 0);
  assert.deepEqual(mismatch.candidates[0].waveformSafety.mediaIssues, ["media_size_mismatch"]);

  const inputPath = path.join(tempRoot, "repeat-input.json");
  const clipsPath = path.join(tempRoot, "clips.json");
  const outPath = path.join(tempRoot, "proposal.json");
  fs.writeFileSync(inputPath, `${JSON.stringify(
    repeatInput(exactWords, path.basename(exactMedia)),
    null,
    2,
  )}\n`, "utf8");
  fs.writeFileSync(clipsPath, `${JSON.stringify(clipSpec(exactMedia), null, 2)}\n`, "utf8");
  const runCli = () => spawnSync(process.execPath, [
    cliPath,
    "--input", inputPath,
    "--clips", clipsPath,
    "--out", outPath,
  ], { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  const firstCli = runCli();
  assert.equal(firstCli.status, 0, firstCli.stderr || firstCli.stdout);
  const secondCli = runCli();
  assert.equal(secondCli.status, 0, secondCli.stderr || secondCli.stdout);
  const cliPayload = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(cliPayload.summary.proposalEligibleCount, 1);
  assert.match(cliPayload.sourceFiles.repeatInput.sha256, /^[0-9A-F]{64}$/u);
  assert.match(cliPayload.sourceFiles.clipSpec.sha256, /^[0-9A-F]{64}$/u);
  assert.equal(fs.readdirSync(tempRoot).some((name) => name.endsWith(".tmp")), false);

  process.stdout.write(`${JSON.stringify({
    success: true,
    tests: 46,
    exactEligible: exact.summary.proposalEligibleCount,
    restartEligible: restart.summary.proposalEligibleCount,
    unsafeReviewOnly: unsafe.summary.reviewRequiredCount,
  }, null, 2)}\n`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
