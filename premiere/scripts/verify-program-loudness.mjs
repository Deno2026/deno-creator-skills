import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TARGET_LUFS = -23;
const DEFAULT_TOLERANCE_LU = 1;
const DEFAULT_MAX_TRUE_PEAK_DB = -2;

function finiteNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number.`);
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    input: "",
    report: "",
    targetLufs: DEFAULT_TARGET_LUFS,
    toleranceLu: DEFAULT_TOLERANCE_LU,
    maxTruePeakDb: DEFAULT_MAX_TRUE_PEAK_DB,
    audioStreamIndex: 0,
    strict: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--input") options.input = argv[++index] || "";
    else if (value === "--report") options.report = argv[++index] || "";
    else if (value === "--target-lufs") options.targetLufs = finiteNumber(argv[++index], value);
    else if (value === "--tolerance-lu") options.toleranceLu = finiteNumber(argv[++index], value);
    else if (value === "--max-true-peak-db") options.maxTruePeakDb = finiteNumber(argv[++index], value);
    else if (value === "--audio-stream-index") options.audioStreamIndex = finiteNumber(argv[++index], value);
    else if (value === "--report-only") options.strict = false;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }

  if (options.toleranceLu < 0) throw new Error("--tolerance-lu must be zero or greater.");
  if (!Number.isInteger(options.audioStreamIndex) || options.audioStreamIndex < 0) {
    throw new Error("--audio-stream-index must be a non-negative integer.");
  }
  return options;
}

export function usage() {
  return [
    "Usage:",
    "  node scripts/verify-program-loudness.mjs --input <render> [options]",
    "",
    "Options:",
    "  --target-lufs <n>          integrated loudness target, default -23",
    "  --tolerance-lu <n>         allowed absolute LUFS deviation, default 1",
    "  --max-true-peak-db <n>     maximum true peak, default -2 dBTP",
    "  --audio-stream-index <n>   zero-based audio stream, default 0",
    "  --report <json>            optional structured evidence file",
    "  --report-only              return exit 0 even when thresholds fail",
  ].join("\n");
}

export function parseEbur128Summary(stderr) {
  const output = String(stderr || "");
  const summaryIndex = output.lastIndexOf("Summary:");
  if (summaryIndex < 0) {
    return {
      integratedLufs: null,
      loudnessRangeLu: null,
      truePeakDb: null,
    };
  }
  const summary = output.slice(summaryIndex + "Summary:".length);
  const integratedMatches = [...summary.matchAll(/\bI:\s*(-?(?:\d+(?:\.\d+)?|inf))\s+LUFS/gi)];
  const rangeMatches = [...summary.matchAll(/\bLRA:\s*(-?(?:\d+(?:\.\d+)?|inf))\s+LU/gi)];
  const peakMatches = [...summary.matchAll(/\bPeak:\s*(-?(?:\d+(?:\.\d+)?|inf))\s+dBFS/gi)];
  const toNumber = (match) => {
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  };
  return {
    integratedLufs: toNumber(integratedMatches.at(-1)),
    loudnessRangeLu: toNumber(rangeMatches.at(-1)),
    truePeakDb: toNumber(peakMatches.at(-1)),
  };
}

export function evaluateLoudness(metrics, thresholds) {
  const deviationLu = Number.isFinite(metrics.integratedLufs)
    ? Math.abs(metrics.integratedLufs - thresholds.targetLufs)
    : null;
  const loudnessPassed = deviationLu !== null && deviationLu <= thresholds.toleranceLu;
  const truePeakPassed =
    Number.isFinite(metrics.truePeakDb) && metrics.truePeakDb <= thresholds.maxTruePeakDb;
  const failures = [];
  if (!loudnessPassed) {
    failures.push(
      metrics.integratedLufs === null
        ? "Integrated loudness could not be measured."
        : `Integrated loudness ${metrics.integratedLufs} LUFS is ${deviationLu.toFixed(2)} LU from target ${thresholds.targetLufs} LUFS.`,
    );
  }
  if (!truePeakPassed) {
    failures.push(
      metrics.truePeakDb === null
        ? "True peak could not be measured."
        : `True peak ${metrics.truePeakDb} dBTP exceeds limit ${thresholds.maxTruePeakDb} dBTP.`,
    );
  }
  return {
    passed: loudnessPassed && truePeakPassed,
    loudnessPassed,
    truePeakPassed,
    deviationLu,
    failures,
  };
}

export function measureProgramLoudness(inputPath, { audioStreamIndex = 0 } = {}) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      inputPath,
      "-map",
      `0:a:${audioStreamIndex}`,
      "-vn",
      "-af",
      "ebur128=peak=true",
      "-f",
      "null",
      process.platform === "win32" ? "NUL" : "/dev/null",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const metrics = parseEbur128Summary(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || "").split(/\r?\n/).filter(Boolean).slice(-8).join(" | ");
    throw new Error(`ffmpeg ebur128 failed (${result.status}): ${detail}`);
  }
  if (!Number.isFinite(metrics.integratedLufs) || !Number.isFinite(metrics.truePeakDb)) {
    throw new Error("ffmpeg completed, but the final ebur128 Summary was incomplete.");
  }
  return metrics;
}

export function verifyProgramLoudness(options) {
  if (!options.input) throw new Error("--input is required.");
  const inputPath = path.resolve(options.input);
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    throw new Error(`Input media does not exist: ${inputPath}`);
  }
  const thresholds = {
    targetLufs: options.targetLufs,
    toleranceLu: options.toleranceLu,
    maxTruePeakDb: options.maxTruePeakDb,
  };
  const metrics = measureProgramLoudness(inputPath, options);
  const evaluation = evaluateLoudness(metrics, thresholds);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    input: inputPath,
    audioStreamIndex: options.audioStreamIndex,
    thresholds,
    metrics,
    ...evaluation,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const report = verifyProgramLoudness(options);
  if (options.report) {
    const reportPath = path.resolve(options.report);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
  if (options.strict && !report.passed) process.exitCode = 2;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
