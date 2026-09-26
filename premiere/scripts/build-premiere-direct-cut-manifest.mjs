import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {buildPremiereDirectCutManifest} from "./lib/premiere-direct-cut-manifest.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/build-premiere-direct-cut-manifest.mjs --identity <live.json> --waveform <cuts.json> --out <manifest.json> [--semantic <proposal.json> ...] [--mode waveform-only|semantic-editorial]",
    "",
    "Offline only. Combines peak-audited waveform cuts and eligible repeat/restart cuts",
    "into the guarded manifest consumed by premiere:apply-direct-razor-cuts.",
  ].join("\n");
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = {semantic: []};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--identity") options.identity = valueAfter(argv, index++, value);
    else if (value === "--waveform") options.waveform = valueAfter(argv, index++, value);
    else if (value === "--semantic") options.semantic.push(valueAfter(argv, index++, value));
    else if (value === "--out") options.out = valueAfter(argv, index++, value);
    else if (value === "--mode") options.mode = valueAfter(argv, index++, value);
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function sourceEvidence(filePath) {
  const resolved = path.resolve(filePath);
  const buffer = fs.readFileSync(resolved);
  return {
    path: resolved,
    sha256: createHash("sha256").update(buffer).digest("hex").toUpperCase(),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.identity || !options.waveform || !options.out) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  const manifest = buildPremiereDirectCutManifest({
    identity: readJson(options.identity),
    waveform: readJson(options.waveform),
    semantic: options.semantic.map(readJson),
    mode: options.mode,
    sources: {
      identity: sourceEvidence(options.identity),
      waveform: sourceEvidence(options.waveform),
      semantic: options.semantic.map(sourceEvidence),
    },
  });
  const outPath = path.resolve(options.out);
  fs.mkdirSync(path.dirname(outPath), {recursive: true});
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    out: outPath,
    mode: manifest.mode,
    cutCount: manifest.cutCount,
    removeFrames: manifest.summary.removeFrames,
    semanticReviewOnlyCount: manifest.summary.semanticReviewOnlyCount,
    writeReady: manifest.writeReady,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}

