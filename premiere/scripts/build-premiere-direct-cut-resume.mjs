import {createHash, randomUUID} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {buildPremiereDirectCutResumeManifest} from "./lib/premiere-direct-cut-resume.mjs";
import {loadPremierePlacementInputs} from "./lib/premiere-placement-inputs.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/build-premiere-direct-cut-resume.mjs --cuts <original.json> --capture-dir <placement-capture> --expected-completed <count> --out <resume.json>",
    "",
    "Builds a no-write resume manifest only when the live duration exactly proves",
    "a completed prefix of the original strict reverse cut order.",
  ].join("\n");
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = {cuts: "", captureDir: "", expectedCompleted: null, out: ""};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--cuts") options.cuts = requireValue(argv, index++, value);
    else if (value === "--capture-dir") options.captureDir = requireValue(argv, index++, value);
    else if (value === "--expected-completed") options.expectedCompleted = Number(requireValue(argv, index++, value));
    else if (value === "--out") options.out = requireValue(argv, index++, value);
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function writeJsonAtomically(filePath, value) {
  const resolved = path.resolve(filePath);
  if (fs.existsSync(resolved)) throw new Error(`Output already exists: ${resolved}`);
  fs.mkdirSync(path.dirname(resolved), {recursive: true});
  const temporary = `${resolved}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {encoding: "utf8", flag: "wx"});
    fs.renameSync(temporary, resolved);
  } catch (error) {
    fs.rmSync(temporary, {force: true});
    throw error;
  }
  return resolved;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.cuts || !options.captureDir || !options.out) throw new Error(usage());
  if (!Number.isInteger(options.expectedCompleted) || options.expectedCompleted < 0) {
    throw new Error("--expected-completed must be a non-negative integer");
  }

  const originalManifestPath = path.resolve(options.cuts);
  const originalText = fs.readFileSync(originalManifestPath, "utf8");
  const originalManifest = JSON.parse(originalText);
  const placement = loadPremierePlacementInputs({captureDir: options.captureDir});
  const result = buildPremiereDirectCutResumeManifest({
    originalManifest,
    placement,
    expectedCompletedCount: options.expectedCompleted,
    originalManifestSha256: createHash("sha256").update(originalText, "utf8").digest("hex").toUpperCase(),
  });
  const outputPath = writeJsonAtomically(options.out, result.manifest);
  console.log(JSON.stringify({
    ok: true,
    outputPath,
    projectName: result.resumeContract.projectName,
    sequenceName: result.resumeContract.sequenceName,
    sequenceId: result.resumeContract.sequenceId,
    completedCutCount: result.manifest.resumeEvidence.completedCutCount,
    completedRemoveFrames: result.manifest.resumeEvidence.completedRemoveFrames,
    remainingCutCount: result.resumeContract.cuts.length,
    currentDurationFrames: result.resumeContract.sequenceDurationFrames,
    remainingRemoveFrames: result.manifest.resumeEvidence.remainingRemoveFrames,
    expectedFinalDurationFrames: result.resumeContract.expectedDurationAfterFrames,
    timelineWrites: 0,
    projectSaved: false,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error.message,
    code: error.code ?? null,
    details: error.details ?? null,
  }, null, 2));
  process.exitCode = 1;
}

