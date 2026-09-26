import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {
  buildPremiereAvLinkAuditExtendScript,
  buildPremiereAvLinkBatchExtendScript,
  createPremiereAvLinkRepairPlan,
} from "./lib/premiere-av-link-repair.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "repair-premiere-av-links.mjs");

function fixture(options = {}) {
  return createPremiereAvLinkRepairPlan({
    projectName: "lesson.prproj",
    sequenceName: "Main",
    targetClipNames: ["recording.mp4"],
    videoTrackIndex: 0,
    audioTrackIndex: 1,
    expectedPairCount: 121,
  }, options);
}

function testBatchPlanAndGuardedScript() {
  const plan = fixture({batchSize: 50});
  assert.deepEqual(plan.batches.map(({startIndex, endIndex}) => [startIndex, endIndex]), [[0, 50], [50, 100], [100, 121]]);
  const script = buildPremiereAvLinkBatchExtendScript(plan, plan.batches[0]);
  assert.match(script, /app\.project\.name !== "lesson\.prproj"/);
  assert.match(script, /seq\.name !== "Main"/);
  assert.match(script, /seq\.videoTracks\[0\]/);
  assert.match(script, /seq\.audioTracks\[1\]/);
  assert.match(script, /String\(item\.inPoint\.ticks\)/);
  assert.match(script, /String\(item\.outPoint\.ticks\)/);
  assert.match(script, /Unexpected existing link group/);
  assert.match(script, /seq\.linkSelection\(\)/);
  assert.doesNotMatch(script, /unlinkSelection/);
  const audit = buildPremiereAvLinkAuditExtendScript(plan);
  assert.match(audit, /mismatchCount:videos\.length - verifiedPairs/);
}

function testValidation() {
  assert.throws(() => fixture({batchSize: 0}), /batchSize/);
  assert.throws(() => createPremiereAvLinkRepairPlan({
    projectName: "lesson.prproj",
    sequenceName: "Main",
    targetClipNames: [],
    videoTrackIndex: 0,
    audioTrackIndex: 0,
    expectedPairCount: 1,
  }), /targetClipNames/);
}

function testDryRunNeverConnectsToPremiere() {
  const child = spawnSync(process.execPath, [
    CLI,
    "--project", "lesson.prproj",
    "--sequence", "Main",
    "--clip-name", "recording.mp4",
    "--video-track", "0",
    "--audio-track", "1",
    "--expected-pairs", "121",
    "--batch-size", "50",
    "--dry-run",
  ], {
    cwd: path.resolve(HERE, ".."),
    encoding: "utf8",
    env: {...process.env, PREMIERE_MCP_ROOT: "Z:\\missing-premiere-runtime"},
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.premiereConnected, false);
  assert.equal(result.writeAttemptCount, 0);
  assert.equal(result.batches.length, 3);
}

testBatchPlanAndGuardedScript();
testValidation();
testDryRunNeverConnectsToPremiere();
console.log("Premiere A/V link repair self-test passed.");
