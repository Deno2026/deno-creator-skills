#!/usr/bin/env node
"use strict";

const { fs, path, fail, safeError, readJson, writeJson, hashFile, parseArgs, emit, cli } = require("./lib/common.cjs");
const { context, instagramSettings, threadsSettings, xSettings } = require("./lib/runtime.cjs");
const { TARGETS, SCHEDULED_TARGETS, normalizeManifest, inspectSource } = require("./lib/publish_manifest.cjs");
const { runPaths, acquireLock, sourceRunId, loadRun, updateRun, setLane, prepareRun, authorize, assertReplannable } = require("./lib/publish_run.cjs");
const { ensureToken } = require("./lib/instagram_api.cjs");
const { createR2Staging } = require("./lib/r2_staging.cjs");
const windowsTask = require("./lib/windows_task.cjs");
const { metadataArgs, youtubeChild, recoverYoutubeLink } = require("./lib/youtube_child.cjs");
const { approvalTable, buildSummary, statusTable, tiktokHandoff } = require("./lib/summary.cjs");
const { publishInstagram } = require("./publish_instagram_reel.cjs");
const { publishThreads } = require("./publish_threads_post.cjs");
const { publishX } = require("./publish_x_post.cjs");
const threadsApi = require("./lib/threads_api.cjs");
const xApi = require("./lib/x_api.cjs");
const WORKERS = { instagram: publishInstagram, threads: publishThreads, x: publishX };
const WORKER_FILES = { instagram: "publish_instagram_reel.cjs", threads: "publish_threads_post.cjs", x: "publish_x_post.cjs" };
const IMMEDIATE_KEYS = { instagram: "immediateInstagram", threads: "immediateThreads", x: "immediateX" };

async function readManifestFile(file) {
  try { return await readJson(path.resolve(file)); } catch { throw fail("PUBLISH_FILE_INVALID"); }
}
async function inspect(file, ctx, deps = {}) {
  const raw = await readManifestFile(file);
  if (!raw.video?.path || !path.isAbsolute(raw.video.path)) throw fail("PUBLISH_FILE_INVALID");
  const result = await (deps.youtubeChild ?? youtubeChild)(["--inspect", "--video", raw.video.path], ctx);
  const record = result.records.find((r) => r.type === "SHORTS_INSPECTION_READY");
  if (!record) throw fail("YOUTUBE_PROTOCOL_INVALID");
  emit("SOCIAL_INSPECTION_READY", record.value);
  return record.value;
}
async function preflight(file, ctx, deps = {}, options = {}) {
  const raw = await readManifestFile(file);
  const source = await (deps.inspectSource ?? inspectSource)(raw.video?.path);
  const normalized = normalizeManifest(raw, { source, settings: ctx.settings, now: deps.now?.() ?? Date.now() });
  const { manifest } = normalized;
  const paths = runPaths(options.runId ?? ("pub-" + source.sha256.slice(0, 16)), ctx.runtime);
  if (sourceRunId(path.basename(paths.runDir)) !== "pub-" + source.sha256.slice(0, 16)) throw fail("VIDEO_SHA_MISMATCH");
  // This guard precedes any direct-uploader preparation, so another preflight cannot change an executed run.
  const release = await acquireLock(path.join(paths.runDir, "EXECUTE.lock"));
  try {
    const old = await readJson(paths.statePath, true);
    if (old?.authorization || old?.state === "cancelled") throw fail("RUN_ALREADY_EXECUTED");
    if (options.runId?.includes("-r") && !old && !options.replannedFrom) throw fail("REPLAN_REQUIRED");
    const checked = {};
    if (manifest.targets.includes("instagram")) {
      const credentials = deps.credentials ?? await ensureToken(ctx.runtime, await instagramSettings(ctx.runtime, ctx.settings));
      if (Date.parse(credentials.status.expiresAt) <= Date.parse(manifest.publishAt) + 15 * 60000) throw fail("INSTAGRAM_TOKEN_EXPIRES_BEFORE_PUBLISH");
      checked.instagram = { username: credentials.username, remainingDays: credentials.status.remainingDays, expiresAt: credentials.status.expiresAt };
      const r2 = deps.r2 ?? createR2Staging(await readJson(ctx.runtime.r2SettingsPath));
      await r2.headBucket();
      checked.instagram.r2 = "reachable";
    }
    if (manifest.targets.includes("threads")) {
      const credentials = deps.threadsCredentials ?? await threadsApi.ensureToken(ctx.runtime, await threadsSettings(ctx.runtime));
      if (Date.parse(credentials.status.expiresAt) <= Date.parse(manifest.publishAt) + 15 * 60000) throw fail("THREADS_TOKEN_EXPIRES_BEFORE_PUBLISH");
      const r2 = deps.r2 ?? createR2Staging(await readJson(ctx.runtime.r2SettingsPath));
      if (!checked.instagram) await r2.headBucket();
      await threadsApi.checkLimit(credentials.api);
      checked.threads = { username: credentials.username, remainingDays: credentials.status.remainingDays, expiresAt: credentials.status.expiresAt, r2: "reachable" };
    }
    if (manifest.targets.includes("x")) {
      const credentials = deps.xCredentials ?? await xApi.ensureToken(ctx.runtime, await xSettings(ctx.runtime));
      if (!credentials.status.canRefresh) throw fail("X_SCOPE_MISSING");
      checked.x = { username: credentials.username, userId: credentials.userId, expiresAt: credentials.status.expiresAt, refreshAvailable: true, credit: "not_checked", paidApi: true };
    }
    if (manifest.targets.includes("youtube")) {
      const metadataPath = path.join(paths.runDir, "youtube/metadata.json");
      await writeJson(metadataPath, manifest.youtube);
      const result = await (deps.youtubeChild ?? youtubeChild)([...metadataArgs(manifest, metadataPath, ctx), "--preflight"], ctx);
      const record = result.records.find((r) => r.type === "PREFLIGHT_COMPLETE");
      if (!record) throw fail("YOUTUBE_PROTOCOL_INVALID");
      if (!ctx.settings.youtube.expectedChannelId) throw fail("YOUTUBE_CHANNEL_ID_MISSING");
      if (record.value.channelId !== ctx.settings.youtube.expectedChannelId) throw fail("YOUTUBE_CHANNEL_MISMATCH");
      if (record.value.existingVideoId) throw fail("RUN_ALREADY_EXECUTED");
      checked.youtube = record.value;
    }
    if (manifest.targets.includes("tiktok")) checked.tiktok = { scheduleWindow: "valid" };
    const prepared = await prepareRun({ ...normalized, source, settings: ctx.settings, preflight: checked, runId: path.basename(paths.runDir), replannedFrom: options.replannedFrom ?? old?.replannedFrom }, ctx.runtime);
    emit("SOCIAL_RUN_CREATED", { runId: prepared.state.runId, manifestPath: prepared.paths.manifestPath });
    process.stderr.write(approvalTable(manifest, { ...prepared.state, manifestPath: prepared.paths.manifestPath }));
    emit("SOCIAL_PREFLIGHT_OK", { runId: prepared.state.runId, manifestSha256: prepared.state.manifestSha256, publishAt: manifest.publishAt, warnings: normalized.warnings });
    return prepared;
  } finally { await release(); }
}
async function execute(runId, options, ctx, deps = {}) {
  const paths = runPaths(runId, ctx.runtime);
  const release = await acquireLock(path.join(paths.runDir, "EXECUTE.lock"));
  try {
    let { state, manifest } = await loadRun(paths);
    if (options.lane && !TARGETS.includes(options.lane)) throw fail("CLI_INVALID");
    if (options.now && !SCHEDULED_TARGETS.some((name) => manifest.targets.includes(name) && (!options.lane || options.lane === name))) throw fail("CLI_INVALID");
    const source = await hashFile(state.source.path);
    if (source.sha256 !== state.source.sha256 || source.size !== state.source.size) throw fail("VIDEO_SHA_MISMATCH");
    if (!state.authorization) normalizeManifest(manifest, { source: state.source, settings: state.settings, now: deps.now?.() ?? Date.now() });
    ctx = { ...ctx, settings: state.settings };
    state = await updateRun(paths, (current) => {
      authorize(current, options.lane, deps.now?.() ?? Date.now());
      if (options.now) for (const name of SCHEDULED_TARGETS.filter((n) => manifest.targets.includes(n) && (!options.lane || options.lane === n))) current.authorization[IMMEDIATE_KEYS[name]] = true;
    });
    let failed = false;
    for (const name of TARGETS.filter((t) => manifest.targets.includes(t) && (!options.lane || t === options.lane))) {
      try {
        await updateRun(paths, (s) => {
          if (s.state === "cancelled") throw fail("RUN_CANCELLED");
          s.lanes[name].startedAt = new Date().toISOString();
        });
        if (name === "youtube") {
          const metadataPath = path.join(paths.runDir, "youtube/metadata.json");
          // Regenerate only from the approved, digest-checked copy; do not trust a mutable sidecar.
          await writeJson(metadataPath, manifest.youtube);
          const result = await (deps.youtubeChild ?? youtubeChild)(metadataArgs(manifest, metadataPath, ctx), ctx);
          const final = result.records.findLast((r) => r.type === "FINAL_RESULT")?.value;
          if (!final?.videoId || final.runId !== `private-short-${state.source.sha256}`) throw fail("YOUTUBE_PROTOCOL_INVALID");
          const link = { directShortRunId: final.runId, videoId: final.videoId, shortsUrl: final.shortsUrl, publishAt: manifest.youtube.privacy === "scheduled" ? manifest.publishAt : null };
          await writeJson(path.join(paths.runDir, "youtube/link.json"), link);
          state = await updateRun(paths, (s) => setLane(s, "youtube", final.verified && final.privacyStatus === "public" ? "verified_public" : manifest.youtube.privacy === "scheduled" ? "uploaded_scheduled" : "uploaded",
            { ...link, privacy: manifest.youtube.privacy, verified: final.verified, actualPrivacy: final.privacyStatus, error: final.verified ? null : { code: "YOUTUBE_VERIFICATION_PENDING" } }));
        } else if (SCHEDULED_TARGETS.includes(name)) {
          if (options.now) await (deps[IMMEDIATE_KEYS[name].replace("immediate", "publish")] ?? WORKERS[name])(runId, { now: true }, ctx);
          else {
            const task = await (deps.windowsTask ?? windowsTask).register({ runId, lane: name, publishAt: state.publishAt, leadMinutes: state.settings.schedule.leadMinutes,
              runDir: paths.runDir, socialRoot: ctx.runtime.runtimeRoot, uploadRoot: ctx.uploadRuntime.runtimeRoot, productionRoot: ctx.productionRoot,
              toolPath: path.join(ctx.productionRoot, "packages/social-publishing/tools", WORKER_FILES[name]) });
            state = await updateRun(paths, (s) => {
              // A late task can start before Register-ScheduledTask returns. Preserve any worker progress.
              if (s.state !== "cancelled" && ["pending", "failed", "missed"].includes(s.lanes[name].state)) setLane(s, name, "task_registered", { taskName: task.taskName, error: null });
              else s.lanes[name].taskName = task.taskName;
            });
            if (state.state === "cancelled") await (deps.windowsTask ?? windowsTask).remove(runId, undefined, path.join(paths.runDir, name, name + "-scheduled.cmd"), name);
          }
        } else {
          normalizeManifest(manifest, { source: state.source, settings: state.settings, now: deps.now?.() ?? Date.now() });
          const handoff = tiktokHandoff(manifest, state);
          const handoffPath = path.join(paths.runDir, "tiktok/handoff.json");
          await writeJson(handoffPath, handoff);
          state = await updateRun(paths, (s) => setLane(s, "tiktok", "handoff_ready", { handoffPath, error: null }));
          process.stderr.write(`\n틱톡 업로드 파일: ${handoff.file}\n캡션: ${handoff.caption}\n예약 시각: ${handoff.scheduleAtLocal}\n설정: ${JSON.stringify({ privacy: handoff.privacy, allowComments: handoff.allowComments, allowDuet: handoff.allowDuet, allowStitch: handoff.allowStitch })}\n전달 파일: ${handoffPath}\n`);
        }
        state = (await loadRun(paths)).state;
        emit("SOCIAL_LANE_STATE", { lane: name, ...state.lanes[name] });
      } catch (error) {
        failed = true;
        if (name === "youtube") {
          const recovered = await (deps.recoverYoutubeLink ?? recoverYoutubeLink)(state, ctx);
          if (recovered.videoId) await writeJson(path.join(paths.runDir, "youtube/link.json"), recovered);
          await updateRun(paths, (s) => { Object.assign(s.lanes.youtube, recovered); });
        }
        state = await updateRun(paths, (s) => {
          if (s.state !== "cancelled" && !["published", "verified_public"].includes(s.lanes[name].state)) setLane(s, name, "failed", { error: safeError(error) });
        });
        emit("SOCIAL_LANE_STATE", { lane: name, ...state.lanes[name] });
      }
    }
    state = (await loadRun(paths)).state;
    emit("SOCIAL_RUN_STATUS", buildSummary(state));
    return { state, exitCode: failed || state.state !== "complete" ? 2 : 0 };
  } finally { await release(); }
}
async function status(runId, resultOut, ctx, deps = {}) {
  const paths = runPaths(runId, ctx.runtime);
  let { state, manifest } = await loadRun(paths);
  ctx = { ...ctx, settings: state.settings };
  if (state.lanes.youtube && state.authorization) {
    const link = await (deps.recoverYoutubeLink ?? recoverYoutubeLink)(state, ctx);
    if (link.videoId) {
      await writeJson(path.join(paths.runDir, "youtube/link.json"), link);
      try {
        const response = await (deps.youtubeChild ?? youtubeChild)(["--verify-only", "--run-id", link.directShortRunId, "--expected-channel-id", state.settings.youtube.expectedChannelId], ctx);
        const final = response.records.findLast((r) => r.type === "FINAL_RESULT")?.value;
        if (!final || final.videoId !== link.videoId) throw fail("YOUTUBE_PROTOCOL_INVALID");
        state = await updateRun(paths, (s) => {
          const lane = s.lanes.youtube;
          Object.assign(lane, link, { verified: final.verified, actualPrivacy: final.privacyStatus, privacy: manifest.youtube.privacy, error: final.verified ? null : { code: "YOUTUBE_VERIFICATION_PENDING" } });
          lane.state = final.verified && final.privacyStatus === "public" ? "verified_public" : manifest.youtube.privacy === "scheduled" ? "uploaded_scheduled" : "uploaded";
        });
      } catch (error) { state = await updateRun(paths, (s) => { s.lanes.youtube.error = safeError(error); s.lanes.youtube.verified = false; }); }
    } else if (link.unknown) state = await updateRun(paths, (s) => setLane(s, "youtube", "failed", { error: { code: "UPLOAD_OUTCOME_UNKNOWN" } }));
  }
  const schedulers = {};
  for (const name of SCHEDULED_TARGETS.filter((n) => state.lanes[n])) {
    const result = await readJson(path.join(paths.runDir, name, "result.json"), true);
    if (result?.mediaId) {
      if (result.runId !== runId || result.manifestSha256 !== state.manifestSha256) throw fail("PUBLISH_FILE_INVALID");
      state = await updateRun(paths, (s) => { Object.assign(s.lanes[name], result, { state: "published", error: null }); });
    } else if (state.authorization && state.state !== "cancelled" && state.lanes[name].state !== "published" && (deps.now?.() ?? Date.now()) > Date.parse(state.publishAt) + 30 * 60000) {
      state = await updateRun(paths, (s) => setLane(s, name, "missed", { error: { code: "MISSED" } }));
    }
    if (state.lanes[name].taskName || await readJson(path.join(paths.runDir, name, "scheduled-task.json"), true)) {
      try {
        schedulers[name] = await (deps.windowsTask ?? windowsTask).query(runId, undefined, name);
        if (!schedulers[name].exists) schedulers[name].state = state.lanes[name].state === "published" ? "completed_task_absent" : "task_absent";
      } catch (error) { schedulers[name] = { error: safeError(error) }; }
    }
  }
  if (state.lanes.tiktok) {
    const result = await readJson(path.join(paths.runDir, "tiktok/result.json"), true);
    if (result) {
      if (result.runId !== runId || result.manifestSha256 !== state.manifestSha256 || !["published", "scheduled_by_browser"].includes(result.state)) throw fail("PUBLISH_FILE_INVALID");
      state = await updateRun(paths, (s) => { Object.assign(s.lanes.tiktok, result); });
    }
  }
  const studio = await readJson(path.join(paths.runDir, "youtube/studio_check.json"), true);
  const summary = buildSummary((await loadRun(paths)).state, { scheduler: schedulers.instagram ?? null, schedulers, studio });
  await writeJson(paths.resultPath, summary);
  if (resultOut) {
    const target = path.resolve(resultOut);
    const relative = path.relative(paths.runDir, target);
    if (!relative.startsWith("..") && !path.isAbsolute(relative) && target !== paths.resultPath) throw fail("RESULT_OUT_PROTECTED");
    if (target !== paths.resultPath) {
      if (path.extname(target).toLowerCase() !== ".json") throw fail("RESULT_OUT_PROTECTED");
      const existing = await readJson(target, true);
      if (existing && (existing.runId !== runId || !existing.lanes || !existing.checkedAt)) throw fail("RESULT_OUT_PROTECTED");
      await writeJson(target, summary);
    }
  }
  process.stderr.write(statusTable(summary));
  emit("SOCIAL_RUN_STATUS", summary);
  return { summary, exitCode: summary.state === "complete" && !summary.warnings.length ? 0 : 2 };
}
async function cancel(runId, ctx, deps = {}) {
  const paths = runPaths(runId, ctx.runtime);
  // Cancellation is persisted before unregistering so a running worker sees it during polling/waiting.
  await updateRun(paths, (s) => {
    s.state = "cancelled";
    for (const name of SCHEDULED_TARGETS) if (s.lanes[name] && s.lanes[name].state !== "published") s.lanes[name].state = "cancelled";
    s.cancelledAt = new Date().toISOString();
  });
  const { state } = await loadRun(paths);
  const removalErrors = {};
  for (const name of SCHEDULED_TARGETS.filter((n) => state.lanes[n])) {
    const record = await readJson(path.join(paths.runDir, name, "scheduled-task.json"), true);
    if (!state.lanes[name].startedAt && !state.lanes[name].taskName && !record) continue;
    try { await (deps.windowsTask ?? windowsTask).remove(runId, undefined, path.join(paths.runDir, name, name + "-scheduled.cmd"), name); }
    catch (error) { removalErrors[name] = safeError(error); }
  }
  await updateRun(paths, (s) => { s.cancellationErrors = removalErrors; });
  emit("SOCIAL_CANCELLED", { runId, state: "cancelled", manualActions: state.authorization ? [
    ...(state.lanes.youtube ? ["유튜브 예약은 YouTube Studio에서 취소"] : []), ...(state.lanes.tiktok ? ["틱톡 예약은 TikTok 예약 목록에서 취소"] : []),
  ] : [] });
  if (Object.keys(removalErrors).length) throw fail("SCHEDULER_FAILED");
  return (await loadRun(paths)).state;
}
async function replan(file, cancelledRunId, ctx, deps = {}) {
  const oldPaths = runPaths(cancelledRunId, ctx.runtime);
  const releases = [];
  try {
    // A previous worker must have stopped; a cancellation flag alone does not prove its API call ended.
    for (const lock of ["EXECUTE.lock", "INSTAGRAM.lock", "THREADS.lock", "X.lock"]) releases.push(await acquireLock(path.join(oldPaths.runDir, lock)));
    const { state } = await loadRun(oldPaths);
    assertReplannable(state);
    if (state.lanes.youtube?.startedAt) {
      const link = await (deps.recoverYoutubeLink ?? recoverYoutubeLink)(state, ctx);
      if (link.videoId || link.unknown) throw fail("REPLAN_REMOTE_STATE_UNRESOLVED");
    }
    for (const name of SCHEDULED_TARGETS.filter((n) => state.lanes[n])) {
      const result = await readJson(path.join(oldPaths.runDir, name, "result.json"), true);
      if (result?.mediaId) throw fail("REPLAN_REMOTE_STATE_UNRESOLVED");
      if (state.lanes[name].startedAt || state.lanes[name].taskName || await readJson(path.join(oldPaths.runDir, name, "scheduled-task.json"), true)) {
        await (deps.windowsTask ?? windowsTask).remove(cancelledRunId, undefined, path.join(oldPaths.runDir, name, name + "-scheduled.cmd"), name);
      }
    }
    const nextRevision = Number(/-r(\d+)$/.exec(cancelledRunId)?.[1] ?? 1) + 1;
    const runId = state.replannedTo ?? (sourceRunId(cancelledRunId) + "-r" + nextRevision);
    const prepared = await preflight(file, ctx, deps, { runId, replannedFrom: cancelledRunId });
    await updateRun(oldPaths, (s) => { s.replannedTo = prepared.state.runId; });
    emit("SOCIAL_REPLANNED", { previousRunId: cancelledRunId, runId: prepared.state.runId, approvalRequired: true });
    return prepared;
  } finally { for (const release of releases.reverse()) await release(); }
}
async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ["--inspect", "--preflight", "--replan", "--execute", "--status", "--cancel", "--now", "--help"], values: ["--publish-file", "--run-id", "--result-out", "--lane"] });
  if (args["--help"]) { process.stdout.write("publish_short_multi --publish-file <publish.json> --inspect|--preflight\npublish_short_multi --publish-file <publish.json> --replan --run-id <cancelled-id>\npublish_short_multi --run-id <id> --execute [--lane <failed-platform>] [--now]\npublish_short_multi --run-id <id> --status [--result-out <publish_result.json>]|--cancel\n--execute records approval of the exact preflight manifest; use only after the user approves it.\n"); return; }
  if (["--inspect", "--preflight", "--replan", "--execute", "--status", "--cancel"].filter((k) => args[k]).length !== 1
    || ((args["--now"] || args["--lane"]) && !args["--execute"]) || (args["--result-out"] && !args["--status"])) throw fail("CLI_INVALID");
  const preparation = args["--inspect"] || args["--preflight"] || args["--replan"];
  if (preparation ? (!args["--publish-file"] || (args["--inspect"] && args["--run-id"]) || (args["--replan"] && !args["--run-id"])) : (!args["--run-id"] || args["--publish-file"])) throw fail("CLI_INVALID");
  const ctx = await context();
  if (args["--inspect"]) await inspect(args["--publish-file"], ctx);
  else if (args["--preflight"]) await preflight(args["--publish-file"], ctx, {}, { runId: args["--run-id"] });
  else if (args["--replan"]) await replan(args["--publish-file"], args["--run-id"], ctx);
  else if (args["--execute"]) process.exitCode = (await execute(args["--run-id"], { lane: args["--lane"], now: !!args["--now"] }, ctx)).exitCode;
  else if (args["--status"]) process.exitCode = (await status(args["--run-id"], args["--result-out"], ctx)).exitCode;
  else await cancel(args["--run-id"], ctx);
}
if (require.main === module) cli(main);
module.exports = { inspect, preflight, execute, status, cancel, replan, main };
