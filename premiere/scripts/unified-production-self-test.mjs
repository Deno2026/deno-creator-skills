import {spawnSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath || path.resolve(
  path.dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);
if (!fs.existsSync(npmCli)) throw new Error(`npm CLI was not found: ${npmCli}`);
const npmTest = (name, scopes) => ({name, scopes});
const tests = [
  npmTest("workspace:doctor", ["premiere", "captions", "publishing"]),
  npmTest("typecheck", ["premiere"]),
  npmTest("premiere:quality:self-test", ["premiere"]),
  npmTest("caption-core:self-test", ["captions"]),
  npmTest("caption:mfa:self-test", ["captions"]),
  npmTest("caption:mfa:regroup-context:self-test", ["captions"]),
  npmTest("caption:mfa:review-layout:self-test", ["captions"]),
  {name: "caption-cues", scopes: ["captions"], script: "scripts/self-test-premiere-caption-cues.mjs", coveredByCore: true},
  {name: "caption-audio", scopes: ["captions"], script: "scripts/self-test-build-premiere-transcription-audio.mjs"},
  {name: "caption-transcription", scopes: ["captions"], script: "scripts/self-test-transcribe-premiere-timeline.mjs"},
  {name: "caption-apply", scopes: ["captions"], script: "scripts/self-test-apply-premiere-caption-track.mjs"},
  {name: "caption-srt", scopes: ["captions"], script: "scripts/self-test-validate-srt.mjs", coveredByCore: true},
  npmTest("runtime-paths:self-test", ["captions", "publishing"]),
  npmTest("publishing-core:self-test", ["publishing"]),
  npmTest("upload-helper:typecheck", ["publishing"]),
  npmTest("upload-helper:lint", ["publishing"]),
  npmTest("upload-helper:artifact:self-test", ["publishing"]),
  npmTest("upload-helper:handoff:self-test", ["publishing"]),
];

let scope = "all";
let listOnly = false;
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--scope") scope = argv[++index];
  else if (argv[index] === "--list") listOnly = true;
  else if (argv[index] === "--help" || argv[index] === "-h") {
    console.log("Usage: npm run unified:offline:self-test -- [--scope all|premiere|captions|publishing] [--list]");
    process.exit(0);
  } else throw new Error(`Unknown argument: ${argv[index]}`);
}
if (!["all", "premiere", "captions", "publishing"].includes(scope)) {
  throw new Error("--scope must be all, premiere, captions, or publishing");
}
const selectedTests = tests.filter((test) => scope === "all"
  ? !test.coveredByCore
  : test.scopes.includes(scope));
if (listOnly) {
  console.log(JSON.stringify({scope, tests: selectedTests.map((test) => test.name)}, null, 2));
  process.exit(0);
}

const results = [];
for (const test of selectedTests) {
  const command = process.execPath;
  const args = test.script ? [test.script] : [npmCli, "run", test.name];
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const record = {
    command: test.script ? `node ${test.script}` : `npm run ${test.name}`,
    durationSeconds: Math.round((Date.now() - startedAt) / 10) / 100,
    exitCode: result.status,
  };
  results.push(record);
  if (result.error || result.status !== 0) {
    console.error(JSON.stringify({ok: false, failed: record, error: result.error?.message ?? null, stdout: result.stdout?.slice(-8000), stderr: result.stderr?.slice(-8000), results}, null, 2));
    process.exit(1);
  }
  console.log(`[PASS] ${record.command} (${record.durationSeconds}s)`);
}

console.log(JSON.stringify({ok: true, scope, passed: results.length}));
