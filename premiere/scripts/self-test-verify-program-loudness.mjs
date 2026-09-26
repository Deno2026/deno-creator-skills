import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  evaluateLoudness,
  measureProgramLoudness,
  parseEbur128Summary,
} from "./verify-program-loudness.mjs";

const parsed = parseEbur128Summary(`
[Parsed_ebur128_0] Summary:
  Integrated loudness:
    I:         -23.2 LUFS
  Loudness range:
    LRA:         4.1 LU
  True peak:
    Peak:       -3.4 dBFS
`);
assert.deepEqual(parsed, {
  integratedLufs: -23.2,
  loudnessRangeLu: 4.1,
  truePeakDb: -3.4,
});
assert.equal(
  evaluateLoudness(parsed, {
    targetLufs: -23,
    toleranceLu: 0.5,
    maxTruePeakDb: -2,
  }).passed,
  true,
);
assert.equal(
  evaluateLoudness(parsed, {
    targetLufs: -18,
    toleranceLu: 1,
    maxTruePeakDb: -4,
  }).passed,
  false,
);
assert.deepEqual(parseEbur128Summary("no summary here"), {
  integratedLufs: null,
  loudnessRangeLu: null,
  truePeakDb: null,
});

const root = path.join(os.tmpdir(), `deno-premiere-loudness-${randomUUID()}`);
const resolvedTemp = `${path.resolve(os.tmpdir())}${path.sep}`.toLowerCase();
assert.ok(`${path.resolve(root)}${path.sep}`.toLowerCase().startsWith(resolvedTemp));
fs.mkdirSync(root, { recursive: true });
try {
  const fixture = path.join(root, "tone.wav");
  const generated = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:sample_rate=48000:duration=3",
      "-filter:a",
      "volume=0.1",
      "-c:a",
      "pcm_s24le",
      fixture,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(generated.status, 0, generated.stderr || "fixture generation failed");
  const measured = measureProgramLoudness(fixture);
  assert.ok(Number.isFinite(measured.integratedLufs));
  assert.ok(Number.isFinite(measured.truePeakDb));
  assert.ok(measured.truePeakDb < -2);
  assert.equal(
    evaluateLoudness(measured, {
      targetLufs: measured.integratedLufs,
      toleranceLu: 0.05,
      maxTruePeakDb: -2,
    }).passed,
    true,
  );

  const failureReportPath = path.join(root, "loudness-failure.json");
  const strictFailure = spawnSync(
    process.execPath,
    [
      path.resolve("scripts/verify-program-loudness.mjs"),
      "--input",
      fixture,
      "--target-lufs",
      "-5",
      "--tolerance-lu",
      "0.1",
      "--report",
      failureReportPath,
    ],
    { cwd: path.resolve("."), encoding: "utf8", windowsHide: true },
  );
  assert.equal(strictFailure.status, 2, strictFailure.stderr || strictFailure.stdout);
  const failureReport = JSON.parse(fs.readFileSync(failureReportPath, "utf8"));
  assert.equal(failureReport.passed, false);
  assert.equal(failureReport.loudnessPassed, false);
  assert.ok(failureReport.failures.length > 0);

  const reportOnly = spawnSync(
    process.execPath,
    [
      path.resolve("scripts/verify-program-loudness.mjs"),
      "--input",
      fixture,
      "--target-lufs",
      "-5",
      "--tolerance-lu",
      "0.1",
      "--report-only",
    ],
    { cwd: path.resolve("."), encoding: "utf8", windowsHide: true },
  );
  assert.equal(reportOnly.status, 0, reportOnly.stderr || reportOnly.stdout);
  assert.equal(JSON.parse(reportOnly.stdout).passed, false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("Program loudness verifier self-test passed.");
