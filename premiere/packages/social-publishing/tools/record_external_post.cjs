#!/usr/bin/env node
"use strict";

const { fs, path, fail, hashFile, isoTime, writeJson, parseArgs, emit, cli } = require("./lib/common.cjs");
const { context } = require("./lib/runtime.cjs");
const { createHash } = require("node:crypto");
const { runPaths, withRunLock, loadRun, saveRun, setLane } = require("./lib/publish_run.cjs");
function validTikTokUrl(value) {
  try { const u = new URL(value); return u.protocol === "https:" && ["www.tiktok.com", "tiktok.com"].includes(u.hostname) && !u.username && !u.password && /^\/@[^/]+\/video\/\d+\/?$/.test(u.pathname); }
  catch { return false; }
}
async function recordExternalPost(options, ctx) {
  if (options.platform !== "tiktok" || !["scheduled_by_browser", "published"].includes(options.state)) throw fail("CLI_INVALID");
  if (options.url && !validTikTokUrl(options.url)) throw fail("TIKTOK_URL_INVALID");
  if (options.state === "published" && !options.url) throw fail("TIKTOK_URL_INVALID");
  const note = options.evidenceNote;
  if (note !== undefined && (typeof note !== "string" || !note.trim() || note.length > 20000)) throw fail("EVIDENCE_MISSING");
  if (!options.evidence && !note) throw fail("EVIDENCE_MISSING");
  let evidenceSource, evidence;
  if (options.evidence) {
    if (!path.isAbsolute(options.evidence) || ![".png", ".jpg", ".jpeg", ".webp"].includes(path.extname(options.evidence).toLowerCase())) throw fail("EVIDENCE_MISSING");
    evidenceSource = await fs.realpath(options.evidence).catch(() => { throw fail("EVIDENCE_MISSING"); });
    evidence = await hashFile(evidenceSource);
    if (evidence.size === 0) throw fail("EVIDENCE_MISSING");
  }
  const paths = runPaths(options.runId, ctx.runtime);
  return withRunLock(paths, async () => {
    const { state } = await loadRun(paths);
    if (!state.authorization || !state.lanes.tiktok || state.state === "cancelled") throw fail("PUBLISH_NOT_APPROVED");
    if (options.state === "scheduled_by_browser" && isoTime(options.scheduledAt) !== state.publishAt) throw fail("TIKTOK_SCHEDULE_MISMATCH");
    if (options.scheduledAt && isoTime(options.scheduledAt) !== state.publishAt) throw fail("TIKTOK_SCHEDULE_MISMATCH");
    if (!["handoff_ready", "scheduled_by_browser", "published", "failed"].includes(state.lanes.tiktok.state)) throw fail("RUN_ALREADY_EXECUTED");
    let recordedEvidence;
    if (evidenceSource) {
      const evidencePath = path.join(paths.runDir, "tiktok", `evidence-${evidence.sha256}${path.extname(evidenceSource).toLowerCase()}`);
      await fs.mkdir(path.dirname(evidencePath), { recursive: true });
      if (evidencePath !== evidenceSource) await fs.copyFile(evidenceSource, evidencePath);
      if ((await hashFile(evidencePath)).sha256 !== evidence.sha256) throw fail("EVIDENCE_CHANGED");
      recordedEvidence = { path: evidencePath, sha256: evidence.sha256, size: evidence.size };
    } else recordedEvidence = { kind: "text", note, sha256: createHash("sha256").update(note, "utf8").digest("hex"), size: Buffer.byteLength(note) };
    const result = { runId: state.runId, manifestSha256: state.manifestSha256, state: options.state, url: options.url ?? state.lanes.tiktok.url ?? null, scheduledAt: state.publishAt, recordedAt: new Date().toISOString(), recordedBy: "agent_browser_review",
      evidence: recordedEvidence, ...(note ? { evidenceNote: note } : {}), error: null };
    setLane(state, "tiktok", options.state, result);
    await writeJson(path.join(paths.runDir, "tiktok/result.json"), result);
    await saveRun(paths, state);
    emit("SOCIAL_LANE_STATE", { lane: "tiktok", ...result });
    return result;
  });
}
async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ["--help"], values: ["--run-id", "--platform", "--state", "--scheduled-at", "--url", "--evidence", "--evidence-note"] });
  if (args["--help"]) { process.stdout.write("record_external_post --run-id <id> --platform tiktok --state scheduled_by_browser|published [--scheduled-at <ISO>] [--url <video-url>] [--evidence <screenshot>] [--evidence-note <browser-text>]\n"); return; }
  await recordExternalPost({ runId: args["--run-id"], platform: args["--platform"], state: args["--state"], scheduledAt: args["--scheduled-at"], url: args["--url"], evidence: args["--evidence"], evidenceNote: args["--evidence-note"] }, await context());
}
if (require.main === module) cli(main);
module.exports = { recordExternalPost, validTikTokUrl };
