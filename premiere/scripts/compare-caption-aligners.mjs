import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseFps, parseSrt } from "./validate-srt.mjs";


function normalizeCaptionText(value) {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function parseComparableSrt(source, label) {
  const parsed = parseSrt(source);
  if (parsed.issues.length > 0) {
    const codes = parsed.issues.map((issue) => issue.code).join(", ");
    throw new Error(`${label} SRT parse failed: ${codes}`);
  }
  let previousEnd = -Infinity;
  for (let index = 0; index < parsed.cues.length; index += 1) {
    const cue = parsed.cues[index];
    if (!Number.isFinite(cue.startSeconds) || !Number.isFinite(cue.endSeconds)) {
      throw new Error(`${label} cue ${cue.number} has invalid timing`);
    }
    if (cue.number !== index + 1) throw new Error(`${label} cue numbers are not contiguous`);
    if (cue.endSeconds <= cue.startSeconds) throw new Error(`${label} cue ${cue.number} has non-positive duration`);
    if (cue.startSeconds < previousEnd) throw new Error(`${label} cue ${cue.number} overlaps the previous cue`);
    previousEnd = cue.endSeconds;
  }
  return parsed.cues;
}

export function compareAligners({ mfaSource, qwenSource, fps, reviewThresholdFrames = 2 }) {
  const parsedFps = parseFps(fps);
  if (parsedFps === null) throw new Error(`Invalid fps: ${fps}`);
  if (!Number.isInteger(reviewThresholdFrames) || reviewThresholdFrames < 0) {
    throw new Error("reviewThresholdFrames must be a non-negative integer");
  }

  const mfaCues = parseComparableSrt(mfaSource, "MFA");
  const qwenCues = parseComparableSrt(qwenSource, "Qwen");
  const structureIssues = [];
  if (mfaCues.length !== qwenCues.length) {
    structureIssues.push({
      code: "CUE_COUNT_MISMATCH",
      mfaCueCount: mfaCues.length,
      qwenCueCount: qwenCues.length,
    });
  }

  const cueCount = Math.min(mfaCues.length, qwenCues.length);
  const comparisons = [];
  const absoluteDeltas = [];
  for (let index = 0; index < cueCount; index += 1) {
    const mfa = mfaCues[index];
    const qwen = qwenCues[index];
    const mfaText = normalizeCaptionText(mfa.text);
    const qwenText = normalizeCaptionText(qwen.text);
    if (mfa.number !== qwen.number || mfaText !== qwenText) {
      structureIssues.push({
        code: "CUE_IDENTITY_MISMATCH",
        ordinal: index + 1,
        mfaNumber: mfa.number,
        qwenNumber: qwen.number,
        mfaText: mfa.text,
        qwenText: qwen.text,
      });
      continue;
    }
    const startDeltaFrames = Math.round((qwen.startSeconds - mfa.startSeconds) * parsedFps);
    const endDeltaFrames = Math.round((qwen.endSeconds - mfa.endSeconds) * parsedFps);
    const maxAbsoluteDeltaFrames = Math.max(Math.abs(startDeltaFrames), Math.abs(endDeltaFrames));
    absoluteDeltas.push(Math.abs(startDeltaFrames), Math.abs(endDeltaFrames));
    comparisons.push({
      number: mfa.number,
      text: mfa.text,
      startDeltaFrames,
      endDeltaFrames,
      maxAbsoluteDeltaFrames,
      review: maxAbsoluteDeltaFrames > reviewThresholdFrames,
    });
  }

  const reviewCueNumbers = comparisons.filter((cue) => cue.review).map((cue) => cue.number);
  return {
    schemaVersion: 1,
    operation: "compare-caption-aligners",
    comparable: structureIssues.length === 0,
    contract: {
      primaryBoundaryCandidate: "MFA 3.4.2 korean_mfa",
      secondaryCrossDiagnostic: "Qwen3 ForcedAligner",
      finalTimingAuthority: "exact current-timeline audio waveform and playback",
      automaticWinnerSelection: false,
    },
    settings: { fps: parsedFps, reviewThresholdFrames },
    structureIssues,
    summary: {
      cueCount: comparisons.length,
      reviewCueCount: reviewCueNumbers.length,
      reviewCueNumbers,
      maxAbsoluteDeltaFrames: absoluteDeltas.length ? Math.max(...absoluteDeltas) : 0,
      p50AbsoluteDeltaFrames: percentile(absoluteDeltas, 0.5),
      p90AbsoluteDeltaFrames: percentile(absoluteDeltas, 0.9),
    },
    cues: comparisons,
  };
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function usage() {
  return [
    "Usage:",
    "  node scripts/compare-caption-aligners.mjs --mfa <mfa.srt> --qwen <qwen.srt> --fps <n|fraction> --out <report.json>",
    "",
    "Options:",
    "  --review-threshold-frames <n>  Mark cue for waveform review when either boundary differs by more than n frames (default: 2)",
    "  --fail-above-frames <n>        Optional CI gate; exit 2 when any boundary exceeds n frames",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { mfa: "", qwen: "", fps: "", out: "", reviewThresholdFrames: 2, failAboveFrames: null };
  const keys = new Map([
    ["--mfa", "mfa"],
    ["--qwen", "qwen"],
    ["--fps", "fps"],
    ["--out", "out"],
    ["--review-threshold-frames", "reviewThresholdFrames"],
    ["--fail-above-frames", "failAboveFrames"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = keys.get(argv[index]);
    if (!key || index + 1 >= argv.length) throw new Error(`Unknown or incomplete option: ${argv[index]}`);
    const value = argv[++index];
    options[key] = key.endsWith("Frames") ? Number(value) : value;
  }
  for (const required of ["mfa", "qwen", "fps", "out"]) {
    if (!options[required]) throw new Error(`Missing --${required}`);
  }
  for (const key of ["reviewThresholdFrames", "failAboveFrames"]) {
    if (options[key] !== null && (!Number.isInteger(options[key]) || options[key] < 0)) {
      throw new Error(`${key} must be a non-negative integer`);
    }
  }
  return options;
}

async function runCli() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    const mfaPath = path.resolve(options.mfa);
    const qwenPath = path.resolve(options.qwen);
    const report = compareAligners({
      mfaSource: fs.readFileSync(mfaPath, "utf8"),
      qwenSource: fs.readFileSync(qwenPath, "utf8"),
      fps: options.fps,
      reviewThresholdFrames: options.reviewThresholdFrames,
    });
    report.createdAt = new Date().toISOString();
    report.inputs = {
      mfa: { path: mfaPath, sha256: sha256File(mfaPath) },
      qwen: { path: qwenPath, sha256: sha256File(qwenPath) },
    };
    const outPath = path.resolve(options.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report.summary));
    if (!report.comparable) process.exitCode = 2;
    else if (
      options.failAboveFrames !== null &&
      report.summary.maxAbsoluteDeltaFrames > options.failAboveFrames
    ) process.exitCode = 2;
  } catch (error) {
    console.error(`Caption aligner comparison failed: ${error.message}`);
    console.error(usage());
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await runCli();
