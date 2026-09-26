import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "waveform-only-self-test-"));

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

try {
  const mediaPath = path.join(tempRoot, "tone-silence-quiet-click-silence-tone.wav");
  const clipsPath = path.join(tempRoot, "clips.json");
  const cutsPath = path.join(tempRoot, "cuts.json");
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=0.6",
    "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=0.8",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=16000:duration=0.1,volume=0.2",
    "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=0.8",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=16000:duration=0.6",
    "-filter_complex", "[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1[out]",
    "-map", "[out]", "-ar", "16000", "-ac", "1", mediaPath,
  ]);
  fs.writeFileSync(clipsPath, `${JSON.stringify({
    fps: 30,
    ticksPerFrame: "8467200000",
    captureSha256: "A".repeat(64),
    targetBindingSha256: "B".repeat(64),
    bundleSha256: "C".repeat(64),
    clips: [{
      media: mediaPath,
      sourceIn: 0,
      timelineStart: 0,
      timelineEnd: 2.9,
    }],
  }, null, 2)}\n`, "utf8");
  run(process.execPath, [
    path.join(repoRoot, "scripts", "propose-waveform-only-cuts.mjs"),
    "--clips", clipsPath,
    "--out", cutsPath,
  ]);
  const payload = JSON.parse(fs.readFileSync(cutsPath, "utf8"));
  assert.equal(payload.mode, "waveform-only");
  assert.equal(payload.writeReady, true);
  assert.equal(payload.candidatePeakAudit.energyMode, "peak");
  assert.equal(payload.candidatePeakAudit.bridgeSilenceGapSeconds, 0);
  assert.equal(payload.candidatePeakAudit.suspiciousCutCount, 0);
  assert.equal(payload.candidatePeakAudit.auditedCutCount, payload.cutCount);
  assert.equal(payload.waveformSnapEvidence.integerFrameBoundaries, true);
  assert.ok(payload.cutCount >= 1);
  assert.equal(payload.cuts.every((cut) => Number.isInteger(cut.startFrame)), true);
  assert.equal(payload.cuts.every((cut) => Number.isInteger(cut.endFrame)), true);
  assert.equal(payload.candidatePeakAudit.suspiciousPeakThresholdDb, -44);
  assert.equal(payload.captureSha256, "A".repeat(64));
  assert.equal(payload.targetBindingSha256, "B".repeat(64));
  assert.equal(payload.bundleSha256, "C".repeat(64));
  assert.equal(payload.cuts.every((cut) => cut.candidatePeakDb === null || cut.candidatePeakDb < -44), true);
  assert.ok(payload.cutCount >= 2, "quiet active blip must split silence instead of being swallowed");

  const missingFpsPath = path.join(tempRoot, "clips-missing-fps.json");
  fs.writeFileSync(missingFpsPath, JSON.stringify({
    ticksPerFrame: "8467200000",
    clips: [{media: mediaPath, sourceIn: 0, timelineStart: 0, timelineEnd: 2.9}],
  }), "utf8");
  const missingFps = spawnSync(process.execPath, [
    path.join(repoRoot, "scripts", "propose-waveform-only-cuts.mjs"),
    "--clips", missingFpsPath,
    "--out", path.join(tempRoot, "missing-fps.json"),
  ], {cwd: repoRoot, encoding: "utf8", windowsHide: true});
  assert.notEqual(missingFps.status, 0);
  assert.match(missingFps.stderr, /fps is required/);
  console.log("Waveform-only proposer peak-audit self-test passed.");
} finally {
  fs.rmSync(tempRoot, {recursive: true, force: true});
}
