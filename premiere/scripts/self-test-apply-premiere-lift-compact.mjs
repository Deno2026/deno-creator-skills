import assert from "node:assert/strict";

import {buildCompactScript, buildLiftScript, parseArgs, planBatches} from "./apply-premiere-lift-compact.mjs";
import {buildDuplicateScript, parseArgs as parseDuplicateArgs} from "./duplicate-premiere-sequence.mjs";
import {validateDirectRazorManifest} from "./lib/premiere-direct-razor-cuts.mjs";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const contract = validateDirectRazorManifest({
  schemaVersion: 1, mode: "semantic-editorial", writeReady: true,
  projectName: "p.prproj", sequenceName: "seq", sequenceId: "seq-1", sequenceDurationSeconds: 10,
  timing: {fps: 30, ticksPerFrame: "8467200000"}, timecodeDisplay: {nominalFps: 30, dropFrame: false},
  targetTracks: ["V1", "A1"], targetClipNames: ["c.mp4"],
  candidatePeakAudit: {energyMode: "rms-10ms", bridgeSilenceGapSeconds: 0, suspiciousCutCount: 0},
  waveformSnapEvidence: {integerFrameBoundaries: true, allBoundariesSnapped: true},
  cutCount: 3,
  cuts: [{index: 0, startFrame: 30, endFrame: 60}, {index: 1, startFrame: 90, endFrame: 100}, {index: 2, startFrame: 100, endFrame: 120}],
});

test("write mode needs an explicit flag and one mode only", () => {
  assert.throws(() => parseArgs(["--cuts", "m.json"]), /exactly one/);
  assert.throws(() => parseArgs(["--cuts", "m.json", "--dry-run", "--allow-write"]), /exactly one/);
  assert.equal(parseArgs(["--cuts", "m.json", "--allow-write"]).allowWrite, true);
});

test("batches run back to front with display timecodes", () => {
  const batches = planBatches(contract, 2);
  assert.deepEqual(batches.map((b) => b.map((c) => c[0])), [[100, 90], [30]]);
  assert.deepEqual(batches[0][0].slice(2), ["00:00:03:10", "00:00:04:00"]);
});

test("lift script guards identity and removes without ripple", () => {
  const script = buildLiftScript(contract, planBatches(contract, 25)[0]);
  assert.match(script, /Active sequence ID changed/);
  assert.match(script, /app\.project\.name!=="p\.prproj"/);
  assert.match(script, /remove\(false,false\)/);
  assert.doesNotMatch(script, /remove\(true/);
  assert.match(script, /is not covered by exactly one clip per track/);
  assert.match(script, /already\.push/);
});

test("compact script moves the video clip and its audio pair together", () => {
  const script = buildCompactScript(contract, 50);
  assert.match(script, /v\.move\(off\); a\.move\(off\)/);
  assert.match(script, /pair mismatch/);
  assert.match(script, /moved>=50/);
});

test("duplicate script refuses a wrong source or an existing copy name", () => {
  assert.throws(() => parseDuplicateArgs(["--name", "x", "--allow-write"]), /required/);
  const script = buildDuplicateScript("seq", "seq 컷편집");
  assert.match(script, /not the expected one/);
  assert.match(script, /copy name already exists/);
  assert.match(script, /seq\.clone\(\)/);
  assert.match(script, /openSequence\(copy\.sequenceID\)/);
});

console.log(`1..${passed}`);
