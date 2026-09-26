// Conservative, offline-only repeat/restart cut proposal.
//
// This command never connects to Premiere and never applies a timeline write.
// Transcript timing is used to judge repetition. A proposal becomes eligible only
// when its integer-frame endpoints also match caller-provided waveform safety data.

import fs from "node:fs";
import path from "node:path";

import {
  PREMIERE_REPEAT_CUT_INPUT_SCHEMA,
  PREMIERE_REPEAT_CUT_OUTPUT_SCHEMA,
  proposePremiereRepeatCuts,
} from "./lib/premiere-repeat-cuts.mjs";

function parseArgs(argv) {
  const options = {
    input: "",
    out: "",
    fps: null,
    maxImmediateGapSeconds: null,
    maxBoundarySnapFrames: null,
    requireWaveformSafety: false,
    printSchema: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--input") options.input = argv[++index];
    else if (value === "--out") options.out = argv[++index];
    else if (value === "--fps") options.fps = Number(argv[++index]);
    else if (value === "--max-immediate-gap") {
      options.maxImmediateGapSeconds = Number(argv[++index]);
    } else if (value === "--max-boundary-snap-frames") {
      options.maxBoundarySnapFrames = Number(argv[++index]);
    } else if (value === "--require-waveform-safety") {
      options.requireWaveformSafety = true;
    } else if (value === "--print-schema") options.printSchema = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/propose-premiere-repeat-cuts.mjs --input <input.json> --out <proposal.json>",
    "  node scripts/propose-premiere-repeat-cuts.mjs --print-schema",
    "",
    "Input (schemaVersion 1):",
    "  { fps, words:[{text,startSeconds,endSeconds}], waveformSafety? }",
    "  transcript.words and timelineWords.words are accepted aliases for words.",
    "  waveformSafety.boundaryFrames: verified integer razor points.",
    "  waveformSafety.boundaryRanges: verified frame windows used to clamp each endpoint.",
    "  waveformSafety.cutRanges: paired verified {startFrame,endFrame} deletion endpoints.",
    "",
    "Detection scope:",
    "  - exact adjacent repetitions of 1-4 tokens (all-filler repeats are excluded)",
    "  - short immediate restarts only when the first attempt ends with an explicit cutoff",
    "  - similar paraphrases and generic filler removal are intentionally out of scope",
    "",
    "Safety:",
    "  Transcript-only endpoints stay reviewRequired=true.",
    "  This command is dry-run/offline only and performs no Premiere write.",
  ].join("\n");
}

function readJson(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
  return JSON.parse(text);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.printSchema) {
    process.stdout.write(`${JSON.stringify({
      input: PREMIERE_REPEAT_CUT_INPUT_SCHEMA,
      output: PREMIERE_REPEAT_CUT_OUTPUT_SCHEMA,
    }, null, 2)}\n`);
    return;
  }
  if (!options.input || !options.out) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 1;
    return;
  }

  const inputPath = path.resolve(options.input);
  const outPath = path.resolve(options.out);
  const overrides = {};
  if (options.fps !== null) overrides.fps = options.fps;
  if (options.maxImmediateGapSeconds !== null) {
    overrides.maxImmediateGapSeconds = options.maxImmediateGapSeconds;
  }
  if (options.maxBoundarySnapFrames !== null) {
    overrides.maxBoundarySnapFrames = options.maxBoundarySnapFrames;
  }
  if (options.requireWaveformSafety) overrides.requireWaveformSafety = true;

  const proposal = proposePremiereRepeatCuts(readJson(inputPath), overrides);
  const payload = {
    ...proposal,
    inputFile: inputPath,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    out: outPath,
    dryRun: true,
    offlineOnly: true,
    candidateCount: payload.summary.candidateCount,
    proposalEligibleCount: payload.summary.proposalEligibleCount,
    reviewRequiredCount: payload.summary.reviewRequiredCount,
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
}

