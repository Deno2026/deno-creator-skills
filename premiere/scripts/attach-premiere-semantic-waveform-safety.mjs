// Offline binder for conservative repeat/restart proposals and real media peaks.
// It never connects to Premiere and never performs a timeline write.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  attachPremiereSemanticWaveformSafety,
  PREMIERE_SEMANTIC_WAVEFORM_SAFETY_SCHEMA,
} from "./lib/premiere-semantic-waveform-safety.mjs";

function parseArgs(argv) {
  const options = {
    input: "",
    clips: "",
    out: "",
    silenceDb: null,
    maxSnapFrames: null,
    minHandleFrames: null,
    sampleRate: null,
    frameSeconds: null,
    ffmpegPath: "",
    printSchema: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--input") options.input = argv[++index];
    else if (value === "--clips") options.clips = argv[++index];
    else if (value === "--out") options.out = argv[++index];
    else if (value === "--silence-db") options.silenceDb = Number(argv[++index]);
    else if (value === "--max-snap-frames") options.maxSnapFrames = Number(argv[++index]);
    else if (value === "--min-handle-frames") options.minHandleFrames = Number(argv[++index]);
    else if (value === "--sample-rate") options.sampleRate = Number(argv[++index]);
    else if (value === "--frame-seconds") options.frameSeconds = Number(argv[++index]);
    else if (value === "--ffmpeg") options.ffmpegPath = argv[++index];
    else if (value === "--print-schema") options.printSchema = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/attach-premiere-semantic-waveform-safety.mjs --input <repeat-input.json> --clips <target-clips.json> --out <proposal.json>",
    "  node scripts/attach-premiere-semantic-waveform-safety.mjs --print-schema",
    "",
    "The repeat input supplies target-only word timings. The clip capture supplies the same",
    "media/source/timeline mapping and fps used for the target clip. Only exact repeats and",
    "explicit cutoff restarts with two verified low-energy frame boundaries become eligible.",
    "No Premiere read or write is performed.",
  ].join("\n");
}

function readJsonWithHash(filePath) {
  const bytes = fs.readFileSync(filePath);
  return {
    payload: JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, "")),
    sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(),
  };
}

function atomicWriteJson(filePath, value) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, "wx");
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, resolved);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
  return resolved;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (cli.printSchema) {
    process.stdout.write(`${JSON.stringify(PREMIERE_SEMANTIC_WAVEFORM_SAFETY_SCHEMA, null, 2)}\n`);
    return;
  }
  if (!cli.input || !cli.clips || !cli.out) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 1;
    return;
  }

  const inputPath = path.resolve(cli.input);
  const clipsPath = path.resolve(cli.clips);
  const input = readJsonWithHash(inputPath);
  const clips = readJsonWithHash(clipsPath);
  const options = {};
  if (cli.silenceDb !== null) options.silenceDb = cli.silenceDb;
  if (cli.maxSnapFrames !== null) options.maxSnapFrames = cli.maxSnapFrames;
  if (cli.minHandleFrames !== null) options.minHandleFrames = cli.minHandleFrames;
  if (cli.sampleRate !== null) options.sampleRate = cli.sampleRate;
  if (cli.frameSeconds !== null) options.frameSeconds = cli.frameSeconds;
  if (cli.ffmpegPath) options.ffmpegPath = cli.ffmpegPath;

  const proposal = await attachPremiereSemanticWaveformSafety({
    repeatInput: input.payload,
    clipSpec: clips.payload,
    options,
    repoRoot: path.dirname(clipsPath),
  });
  const payload = {
    ...proposal,
    sourceFiles: {
      repeatInput: { path: inputPath, sha256: input.sha256 },
      clipSpec: { path: clipsPath, sha256: clips.sha256 },
    },
  };
  const outPath = atomicWriteJson(cli.out, payload);
  process.stdout.write(`${JSON.stringify({
    out: outPath,
    offlineOnly: true,
    premiereWrite: false,
    candidateCount: payload.summary.candidateCount,
    proposalEligibleCount: payload.summary.proposalEligibleCount,
    reviewRequiredCount: payload.summary.reviewRequiredCount,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});

