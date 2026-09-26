#!/usr/bin/env node
"use strict";

const { path, fail, safeError, readJson, writeJson, hashFile, parseArgs, emit, cli, sleep } = require("./lib/common.cjs");
const { context, threadsSettings } = require("./lib/runtime.cjs");
const { runPaths, acquireLock, loadRun, updateRun, setLane } = require("./lib/publish_run.cjs");
const { ensureToken, checkLimit, pollContainer, reconcilePublish, requireId } = require("./lib/threads_api.cjs");
const { createR2Staging, stagingKey } = require("./lib/r2_staging.cjs");

async function publishThreads(runId, { now: immediate = false, scheduled = false } = {}, ctx, deps = {}) {
  if (immediate === scheduled) throw fail("CLI_INVALID");
  const paths = runPaths(runId, ctx.runtime);
  const release = await acquireLock(path.join(paths.runDir, "THREADS.lock"));
  let authorized = false;
  const time = deps.now ?? Date.now;
  const sleepImpl = deps.sleep ?? sleep;
  try {
    let { state, manifest } = await loadRun(paths);
    if (!state.authorization || !state.lanes.threads || state.state === "cancelled") throw fail("PUBLISH_NOT_APPROVED");
    if (immediate && !state.authorization.immediateThreads) throw fail("THREADS_IMMEDIATE_NOT_APPROVED");
    authorized = true;
    const lane = state.lanes.threads;
    if (!immediate && Date.parse(state.publishAt) - time() > 110 * 60000) throw fail("THREADS_STARTED_TOO_EARLY");
    const credentials = deps.credentials ?? await ensureToken(ctx.runtime, await threadsSettings(ctx.runtime, state.settings));
    if (state.preflight.threads?.username && state.preflight.threads.username !== credentials.username) throw fail("THREADS_ACCOUNT_MISMATCH");
    const api = credentials.api;
    const r2 = deps.r2 ?? createR2Staging(await readJson(ctx.runtime.r2SettingsPath));
    const resultPath = path.join(paths.runDir, "threads/result.json");
    const savedResult = await readJson(resultPath, true);
    let mediaId = lane.mediaId ?? savedResult?.mediaId;
    let containerId = lane.containerId ?? savedResult?.containerId;
    let key = lane.r2Key ?? savedResult?.r2Key;
    if (key && key !== stagingKey(runId, state.source.sha256, "threads")) throw fail("R2_KEY_INVALID");
    if (savedResult && (savedResult.runId !== runId || savedResult.manifestSha256 !== state.manifestSha256)) throw fail("PUBLISH_FILE_INVALID");
    async function assertActive() {
      const current = (await loadRun(paths)).state;
      if (current.state === "cancelled" || current.lanes.threads.state === "cancelled") throw fail("RUN_CANCELLED");
    }
    if (!mediaId && lane.publishAttemptAt) {
      // Includes a killed process between media_publish and saving its response. Never publish again here.
      mediaId = await reconcilePublish(api, manifest.threads.text, lane.publishAttemptAt, time());
    }
    if (!mediaId) {
      const source = await hashFile(state.source.path);
      if (source.sha256 !== state.source.sha256 || source.size !== state.source.size) throw fail("VIDEO_SHA_MISMATCH");
      await checkLimit(api);
      if (containerId && ["failed", "missed"].includes(lane.state)) {
        const previous = await api.container(containerId);
        if (["ERROR", "EXPIRED"].includes(previous.status)) {
          const retired = containerId;
          containerId = null;
          await updateRun(paths, (s) => {
            s.lanes.threads.retiredContainers = [...(s.lanes.threads.retiredContainers ?? []), { id: retired, status: previous.status }];
            s.lanes.threads.containerId = null;
          });
        }
      }
      if (!containerId) {
        key = stagingKey(runId, state.source.sha256, "threads");
        await updateRun(paths, (s) => setLane(s, "threads", "staging", { r2Key: key, error: null }));
        await assertActive();
        const staged = await r2.stage(state.source.path, runId, state.source.sha256, "threads");
        await assertActive();
        const container = await api.createContainer(manifest.threads, staged.url);
        containerId = requireId(container.id);
        await updateRun(paths, (s) => setLane(s, "threads", "container_processing", { containerId, r2Key: key, stagedAt: new Date(time()).toISOString(), urlExpiresAt: staged.expiresAt }));
      } else {
        await updateRun(paths, (s) => setLane(s, "threads", "container_processing", { error: null }));
      }
      await pollContainer(api, containerId, { now: time, sleepImpl, onPoll: async (status) => {
        await assertActive();
        await updateRun(paths, (s) => { s.lanes.threads.containerStatus = status; });
      } });
      while (!immediate && time() < Date.parse(state.publishAt)) {
        await assertActive();
        await sleepImpl(Math.min(30000, Date.parse(state.publishAt) - time()));
      }
      await assertActive();
      const attemptedAt = new Date(time()).toISOString();
      // Write intent before the irreversible call; a restart may only reconcile this attempt.
      await updateRun(paths, (s) => {
        if (s.state === "cancelled") throw fail("RUN_CANCELLED");
        s.lanes.threads.publishAttemptAt = attemptedAt;
      });
      try {
        const published = await api.publish(containerId);
        mediaId = requireId(published.id);
      } catch (error) {
        if (error.definitive) {
          await updateRun(paths, (s) => { s.lanes.threads.publishAttemptAt = null; });
          throw error;
        }
        try { mediaId = await reconcilePublish(api, manifest.threads.text, attemptedAt, time()); }
        catch { throw fail("THREADS_PUBLISH_UNKNOWN"); }
      }
    }
    // Retain the known id even if subsequent read-back or deletion fails.
    await updateRun(paths, (s) => { Object.assign(s.lanes.threads, { mediaId, containerId, r2Key: key }); });
    const observed = await api.media(mediaId);
    if (String(observed.id) !== mediaId || observed.text !== manifest.threads.text || observed.media_type !== "VIDEO" || !validThreadsUrl(observed.permalink)
      || !Number.isFinite(Date.parse(observed.timestamp))) throw fail("THREADS_READBACK_MISMATCH");
    const result = { runId, manifestSha256: state.manifestSha256, containerId, mediaId, permalink: observed.permalink, publishedAt: observed.timestamp, r2Key: key, r2Deleted: savedResult?.r2Deleted === true, cleanupError: null, verifiedAt: new Date(time()).toISOString() };
    // Persist success before cleanup: losing the process during DELETE must never lead to another post.
    await writeJson(resultPath, result);
    if (!result.r2Deleted && key) {
      try { await r2.unstage(key); result.r2Deleted = true; }
      catch (error) { result.cleanupError = safeError(error, "R2_UNREACHABLE"); }
    }
    await writeJson(resultPath, result);
    state = await updateRun(paths, (s) => {
      if (s.state === "cancelled") {
        s.lanes.threads = { ...s.lanes.threads, ...result, state: "published", error: null, warning: "PUBLISHED_DURING_CANCELLATION" };
      } else setLane(s, "threads", "published", { ...result, error: null });
    });
    emit("SOCIAL_LANE_STATE", { lane: "threads", ...state.lanes.threads });
    return result;
  } catch (error) {
    if (authorized) await updateRun(paths, (s) => {
      if (s.state !== "cancelled" && s.lanes.threads.state !== "published") setLane(s, "threads", "failed", { error: safeError(error) });
    });
    throw error;
  } finally { await release(); }
}
function validThreadsUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && ["threads.com", "www.threads.com", "threads.net", "www.threads.net"].includes(url.hostname) && !url.username && !url.password && /^\/@[^/]+\/post\/[^/]+\/?$/.test(url.pathname); }
  catch { return false; }
}
async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ["--now", "--scheduled", "--help"], values: ["--run-id"] });
  if (args["--help"]) { process.stdout.write("publish_threads_post --run-id <id> --scheduled|--now\n--now requires an execute --now approval recorded on the run.\n"); return; }
  const result = await publishThreads(args["--run-id"], { now: !!args["--now"], scheduled: !!args["--scheduled"] }, await context());
  if (!result.r2Deleted) process.exitCode = 2;
}
if (require.main === module) cli(main);
module.exports = { publishThreads, validThreadsUrl };
