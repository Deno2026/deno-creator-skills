#!/usr/bin/env node
"use strict";

const { path, fail, safeError, readJson, writeJson, hashFile, parseArgs, emit, cli, sleep } = require("./lib/common.cjs");
const { context, instagramSettings } = require("./lib/runtime.cjs");
const { runPaths, acquireLock, loadRun, updateRun, setLane } = require("./lib/publish_run.cjs");
const { ensureToken, checkLimit, pollContainer, reconcilePublish, requireId } = require("./lib/instagram_api.cjs");
const { createR2Staging, stagingKey } = require("./lib/r2_staging.cjs");

async function publishInstagram(runId, { now: immediate = false, scheduled = false } = {}, ctx, deps = {}) {
  if (immediate === scheduled) throw fail("CLI_INVALID");
  const paths = runPaths(runId, ctx.runtime);
  const release = await acquireLock(path.join(paths.runDir, "INSTAGRAM.lock"));
  let authorized = false;
  const time = deps.now ?? Date.now;
  const sleepImpl = deps.sleep ?? sleep;
  try {
    let { state, manifest } = await loadRun(paths);
    if (!state.authorization || !state.lanes.instagram || state.state === "cancelled") throw fail("PUBLISH_NOT_APPROVED");
    if (immediate && !state.authorization.immediateInstagram) throw fail("INSTAGRAM_IMMEDIATE_NOT_APPROVED");
    authorized = true;
    const lane = state.lanes.instagram;
    if (!immediate && Date.parse(state.publishAt) - time() > 110 * 60000) throw fail("INSTAGRAM_STARTED_TOO_EARLY");
    const credentials = deps.credentials ?? await ensureToken(ctx.runtime, await instagramSettings(ctx.runtime, state.settings));
    const api = credentials.api;
    const r2 = deps.r2 ?? createR2Staging(await readJson(ctx.runtime.r2SettingsPath));
    const resultPath = path.join(paths.runDir, "instagram/result.json");
    const savedResult = await readJson(resultPath, true);
    let mediaId = lane.mediaId ?? savedResult?.mediaId;
    let containerId = lane.containerId ?? savedResult?.containerId;
    let key = lane.r2Key ?? savedResult?.r2Key;
    if (key && key !== stagingKey(runId, state.source.sha256)) throw fail("R2_KEY_INVALID");
    if (savedResult && (savedResult.runId !== runId || savedResult.manifestSha256 !== state.manifestSha256)) throw fail("PUBLISH_FILE_INVALID");
    async function assertActive() {
      const current = (await loadRun(paths)).state;
      if (current.state === "cancelled" || current.lanes.instagram.state === "cancelled") throw fail("RUN_CANCELLED");
    }
    if (!mediaId && lane.publishAttemptAt) {
      // Includes a killed process between media_publish and saving its response. Never publish again here.
      mediaId = await reconcilePublish(api, manifest.instagram.caption, lane.publishAttemptAt, time());
    }
    if (!mediaId) {
      const source = await hashFile(state.source.path);
      if (source.sha256 !== state.source.sha256 || source.size !== state.source.size) throw fail("VIDEO_SHA_MISMATCH");
      await checkLimit(api);
      if (containerId && ["failed", "missed"].includes(lane.state)) {
        const previous = await api.container(containerId);
        if (["ERROR", "EXPIRED"].includes(previous.status_code)) {
          const retired = containerId;
          containerId = null;
          await updateRun(paths, (s) => {
            s.lanes.instagram.retiredContainers = [...(s.lanes.instagram.retiredContainers ?? []), { id: retired, status: previous.status_code }];
            s.lanes.instagram.containerId = null;
          });
        }
      }
      if (!containerId) {
        key = stagingKey(runId, state.source.sha256);
        await updateRun(paths, (s) => setLane(s, "instagram", "staging", { r2Key: key, error: null }));
        await assertActive();
        const staged = await r2.stage(state.source.path, runId, state.source.sha256);
        await assertActive();
        const container = await api.createContainer(manifest.instagram, staged.url);
        containerId = requireId(container.id);
        await updateRun(paths, (s) => setLane(s, "instagram", "container_processing", { containerId, r2Key: key, stagedAt: new Date(time()).toISOString(), urlExpiresAt: staged.expiresAt }));
      } else {
        await updateRun(paths, (s) => setLane(s, "instagram", "container_processing", { error: null }));
      }
      await pollContainer(api, containerId, { now: time, sleepImpl, onPoll: async (status) => {
        await assertActive();
        await updateRun(paths, (s) => { s.lanes.instagram.containerStatus = status; });
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
        s.lanes.instagram.publishAttemptAt = attemptedAt;
      });
      try {
        const published = await api.publish(containerId);
        mediaId = requireId(published.id);
      } catch (error) {
        if (error.definitive) {
          await updateRun(paths, (s) => { s.lanes.instagram.publishAttemptAt = null; });
          throw error;
        }
        try { mediaId = await reconcilePublish(api, manifest.instagram.caption, attemptedAt, time()); }
        catch { throw fail("INSTAGRAM_PUBLISH_UNKNOWN"); }
      }
    }
    // Retain the known id even if subsequent read-back or deletion fails.
    await updateRun(paths, (s) => { Object.assign(s.lanes.instagram, { mediaId, containerId, r2Key: key }); });
    const observed = await api.media(mediaId);
    if (String(observed.id) !== mediaId || observed.caption !== manifest.instagram.caption || observed.media_type !== "VIDEO" || !validInstagramUrl(observed.permalink)
      || !Number.isFinite(Date.parse(observed.timestamp))) throw fail("INSTAGRAM_READBACK_MISMATCH");
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
        s.lanes.instagram = { ...s.lanes.instagram, ...result, state: "published", error: null, warning: "PUBLISHED_DURING_CANCELLATION" };
      } else setLane(s, "instagram", "published", { ...result, error: null });
    });
    emit("SOCIAL_LANE_STATE", { lane: "instagram", ...state.lanes.instagram });
    return result;
  } catch (error) {
    if (authorized) await updateRun(paths, (s) => {
      if (s.state !== "cancelled" && s.lanes.instagram.state !== "published") setLane(s, "instagram", "failed", { error: safeError(error) });
    });
    throw error;
  } finally { await release(); }
}
function validInstagramUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && ["instagram.com", "www.instagram.com"].includes(url.hostname) && !url.username && !url.password && /^\/(?:reel|p)\/[^/]+\/?$/.test(url.pathname); }
  catch { return false; }
}
async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ["--now", "--scheduled", "--help"], values: ["--run-id"] });
  if (args["--help"]) { process.stdout.write("publish_instagram_reel --run-id <id> --scheduled|--now\n--now requires an execute --now approval recorded on the run.\n"); return; }
  const result = await publishInstagram(args["--run-id"], { now: !!args["--now"], scheduled: !!args["--scheduled"] }, await context());
  if (!result.r2Deleted) process.exitCode = 2;
}
if (require.main === module) cli(main);
module.exports = { publishInstagram, validInstagramUrl };
