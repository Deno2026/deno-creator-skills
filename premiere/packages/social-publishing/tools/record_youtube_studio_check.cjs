#!/usr/bin/env node
"use strict";

const { path, fail, isoTime, writeJson, parseArgs, emit, cli } = require("./lib/common.cjs");
const { context } = require("./lib/runtime.cjs");
const { runPaths, withRunLock, loadRun, saveRun } = require("./lib/publish_run.cjs");
function parseChecks(input) {
  if (typeof input !== "string") throw fail("STUDIO_CHECK_INVALID");
  const pairs = input.split(",").map((pair) => pair.split("="));
  const result = Object.fromEntries(pairs);
  if (pairs.length !== 2 || pairs.some((p) => p.length !== 2) || !["passed", "pending", "claimed"].includes(result.copyright)
    || !["passed", "pending", "limited"].includes(result.ad_suitability)) throw fail("STUDIO_CHECK_INVALID");
  return result;
}
async function recordStudioCheck(options, ctx, { now = Date.now } = {}) {
  const checks = parseChecks(options.checks);
  if (!["on", "off", "na"].includes(options.monetization)) throw fail("STUDIO_CHECK_INVALID");
  const observedAt = isoTime(options.observedAt, "STUDIO_CHECK_INVALID");
  if (Date.parse(observedAt) > now() + 60000) throw fail("STUDIO_CHECK_INVALID");
  const paths = runPaths(options.runId, ctx.runtime);
  return withRunLock(paths, async () => {
    const { state } = await loadRun(paths);
    if (!state.authorization || !state.lanes.youtube?.videoId) throw fail("YOUTUBE_NOT_UPLOADED");
    if (Date.parse(observedAt) < Date.parse(state.authorization.approvedAt)) throw fail("STUDIO_CHECK_INVALID");
    const record = { schemaVersion: 1, runId: state.runId, videoId: state.lanes.youtube.videoId, checks, monetization: options.monetization,
      scheduledVisible: !!options.scheduledVisible, observedAt, recordedAt: new Date().toISOString(), recordedBy: "agent_browser_review", blocksPublication: false };
    await writeJson(path.join(paths.runDir, "youtube/studio_check.json"), record);
    state.lanes.youtube.studioCheckedAt = observedAt;
    await saveRun(paths, state);
    emit("SOCIAL_STUDIO_CHECK_RECORDED", record);
    return record;
  });
}
async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ["--scheduled-visible", "--help"], values: ["--run-id", "--checks", "--monetization", "--observed-at"] });
  if (args["--help"]) { process.stdout.write("record_youtube_studio_check --run-id <id> --checks copyright=passed,ad_suitability=passed --monetization on|off|na [--scheduled-visible] --observed-at <ISO>\n"); return; }
  await recordStudioCheck({ runId: args["--run-id"], checks: args["--checks"], monetization: args["--monetization"], scheduledVisible: !!args["--scheduled-visible"], observedAt: args["--observed-at"] }, await context());
}
if (require.main === module) cli(main);
module.exports = { parseChecks, recordStudioCheck };
