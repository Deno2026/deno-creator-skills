#!/usr/bin/env node
"use strict";

const { path, fail, safeError, readJson, writeJson, hashFile, parseArgs, emit, cli, sleep } = require("./lib/common.cjs");
const { context, xSettings } = require("./lib/runtime.cjs");
const { runPaths, acquireLock, loadRun, updateRun, setLane } = require("./lib/publish_run.cjs");
const { ensureToken, uploadVideo, pollContainer, reconcilePublish, requireId, observedText } = require("./lib/x_api.cjs");

async function publishX(runId, { now: immediate = false, scheduled = false } = {}, ctx, deps = {}) {
  if (immediate === scheduled) throw fail("CLI_INVALID");
  const paths = runPaths(runId, ctx.runtime);
  const release = await acquireLock(path.join(paths.runDir, "X.lock"));
  let authorized = false;
  const time = deps.now ?? Date.now, sleepImpl = deps.sleep ?? sleep;
  try {
    let { state, manifest } = await loadRun(paths);
    if (!state.authorization || !state.lanes.x || state.state === "cancelled") throw fail("PUBLISH_NOT_APPROVED");
    if (immediate && !state.authorization.immediateX) throw fail("X_IMMEDIATE_NOT_APPROVED");
    authorized = true;
    if (!immediate && Date.parse(state.publishAt) - time() > 110 * 60000) throw fail("X_STARTED_TOO_EARLY");
    const credentials = deps.credentials ?? await ensureToken(ctx.runtime, await xSettings(ctx.runtime), { forceRefresh: true });
    if ((state.preflight.x?.userId && state.preflight.x.userId !== credentials.userId)
      || (state.preflight.x?.username && state.preflight.x.username.toLowerCase() !== credentials.username.toLowerCase())) throw fail("X_ACCOUNT_MISMATCH");
    const api = credentials.api, lane = state.lanes.x;
    const resultPath = path.join(paths.runDir, "x/result.json");
    const saved = await readJson(resultPath, true);
    if (saved && (saved.runId !== runId || saved.manifestSha256 !== state.manifestSha256)) throw fail("PUBLISH_FILE_INVALID");
    let mediaId = lane.mediaId ?? saved?.mediaId;
    let containerId = lane.containerId ?? saved?.containerId, mediaKey = lane.mediaKey ?? saved?.mediaKey;
    async function assertActive() {
      const current = (await loadRun(paths)).state;
      if (current.state === "cancelled" || current.lanes.x.state === "cancelled") throw fail("RUN_CANCELLED");
    }
    if (!mediaId && lane.publishAttemptAt) {
      mediaId = await reconcilePublish(api, manifest.x.text, lane.publishAttemptAt, mediaKey, credentials.userId, time());
    }
    if (!mediaId) {
      const source = await hashFile(state.source.path);
      if (source.sha256 !== state.source.sha256 || source.size !== state.source.size) throw fail("VIDEO_SHA_MISMATCH");
      // A failed/incomplete upload is harmless to replace before a post attempt; never reuse expired media blindly.
      if (!lane.uploadFinalized || ["failed", "missed"].includes(lane.state)) {
        await updateRun(paths, (s) => setLane(s, "x", "staging", { error: null, uploadFinalized: false }));
        const uploaded = await uploadVideo(api, state.source, { assertActive, onInitialized: async (value) => {
          await updateRun(paths, (s) => { Object.assign(s.lanes.x, value); });
        } });
        containerId = uploaded.containerId; mediaKey = uploaded.mediaKey;
        await updateRun(paths, (s) => setLane(s, "x", "container_processing", { containerId, mediaKey, uploadFinalized: true, error: null }));
      } else {
        await updateRun(paths, (s) => setLane(s, "x", "container_processing", { error: null }));
      }
      await pollContainer(api, containerId, { now: time, sleepImpl, onPoll: async (status) => {
        await assertActive(); await updateRun(paths, (s) => { s.lanes.x.containerStatus = status; });
      } });
      while (!immediate && time() < Date.parse(state.publishAt)) {
        await assertActive(); await sleepImpl(Math.min(30000, Date.parse(state.publishAt) - time()));
      }
      await assertActive();
      const attemptedAt = new Date(time()).toISOString();
      await updateRun(paths, (s) => {
        if (s.state === "cancelled") throw fail("RUN_CANCELLED");
        s.lanes.x.publishAttemptAt = attemptedAt;
      });
      try { mediaId = requireId((await api.publish(containerId, manifest.x.text))?.id); }
      catch (error) {
        if (error.definitive) {
          await updateRun(paths, (s) => { s.lanes.x.publishAttemptAt = null; });
          throw error;
        }
        try { mediaId = await reconcilePublish(api, manifest.x.text, attemptedAt, mediaKey, credentials.userId, time()); }
        catch { throw fail("X_PUBLISH_UNKNOWN"); }
      }
    }
    await updateRun(paths, (s) => { Object.assign(s.lanes.x, { mediaId, containerId, mediaKey }); });
    const observed = await api.media(mediaId);
    if (String(observed?.id) !== mediaId || String(observed.author_id) !== credentials.userId
      || observedText(observed) !== manifest.x.text.trimEnd().normalize("NFC") || !observed.attachments?.media_keys?.includes(mediaKey)
      || !Number.isFinite(Date.parse(observed.created_at))) throw fail("X_READBACK_MISMATCH");
    const result = { runId, manifestSha256: state.manifestSha256, mediaId, containerId, mediaKey,
      permalink: "https://x.com/" + credentials.username + "/status/" + mediaId, publishedAt: observed.created_at, verifiedAt: new Date(time()).toISOString() };
    await writeJson(resultPath, result);
    state = await updateRun(paths, (s) => {
      if (s.state === "cancelled") s.lanes.x = { ...s.lanes.x, ...result, state: "published", error: null, warning: "PUBLISHED_DURING_CANCELLATION" };
      else setLane(s, "x", "published", { ...result, error: null });
    });
    emit("SOCIAL_LANE_STATE", { lane: "x", ...state.lanes.x });
    return result;
  } catch (error) {
    if (authorized) await updateRun(paths, (s) => {
      if (s.state !== "cancelled" && s.lanes.x.state !== "published") setLane(s, "x", "failed", { error: safeError(error) });
    });
    throw error;
  } finally { await release(); }
}
async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ["--now", "--scheduled", "--help"], values: ["--run-id"] });
  if (args["--help"]) { process.stdout.write("publish_x_post --run-id <id> --scheduled|--now\n--now requires an execute --now approval recorded on the run.\n"); return; }
  await publishX(args["--run-id"], { now: !!args["--now"], scheduled: !!args["--scheduled"] }, await context());
}
if (require.main === module) cli(main);
module.exports = { publishX, main };
