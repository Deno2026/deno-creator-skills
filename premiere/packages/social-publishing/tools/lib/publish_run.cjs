"use strict";

const { randomUUID } = require("node:crypto");
const { getSocialPublishingRuntimePaths } = require("@deno/runtime-paths");
const { fs, path, fail, readJson, writeJson, digest, sleep } = require("./common.cjs");
const SAFE_RUN_ID = /^pub-[a-f0-9]{16}(?:-r(?:[2-9]|[1-9]\d{1,5}))?$/;
const sourceRunId = (runId) => runId.replace(/-r\d+$/, "");
const STATES = Object.freeze({
  youtube: ["pending", "uploaded_scheduled", "uploaded", "verified_public", "failed"],
  instagram: ["pending", "task_registered", "staging", "container_processing", "published", "missed", "failed", "cancelled"],
  threads: ["pending", "task_registered", "staging", "container_processing", "published", "missed", "failed", "cancelled"],
  x: ["pending", "task_registered", "staging", "container_processing", "published", "missed", "failed", "cancelled"],
  tiktok: ["pending", "handoff_ready", "scheduled_by_browser", "published", "failed"],
});
function runPaths(runId, runtime = getSocialPublishingRuntimePaths()) {
  if (!SAFE_RUN_ID.test(runId)) throw fail("PUBLISH_FILE_INVALID");
  const runDir = path.join(runtime.runsRoot, runId);
  return { runDir, statePath: path.join(runDir, "publish_run.json"), manifestPath: path.join(runDir, "publish.json"), lockPath: path.join(runDir, "RUN.lock"), resultPath: path.join(runDir, "publish_result.json") };
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}
async function acquireLock(lockPath) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const owner = { pid: process.pid, nonce: randomUUID(), createdAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try { handle = await fs.open(lockPath, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = await readJson(lockPath, true).catch(() => null);
      if (!previous || alive(previous.pid)) throw fail("RUN_LOCKED");
      const recoveryPath = `${lockPath}.recover`;
      const recovery = await fs.open(recoveryPath, "wx").catch(() => { throw fail("RUN_LOCKED"); });
      try {
        const latest = await readJson(lockPath, true);
        if (!latest || digest(previous) !== digest(latest)) throw fail("RUN_LOCKED");
        await fs.rm(lockPath);
      } finally { await recovery.close(); await fs.rm(recoveryPath, { force: true }); }
      continue;
    }
    try { await handle.writeFile(JSON.stringify(owner), "utf8"); } finally { await handle.close(); }
    return async () => {
      const latest = await readJson(lockPath, true);
      if (latest?.nonce === owner.nonce) await fs.rm(lockPath, { force: true });
    };
  }
  throw fail("RUN_LOCKED");
}
async function withRunLock(paths, callback) {
  let release;
  for (let attempt = 0; ; attempt++) {
    try { release = await acquireLock(paths.lockPath); break; }
    catch (error) { if (error.code !== "RUN_LOCKED" || attempt >= 40) throw error; await sleep(50); }
  }
  try { return await callback(); } finally { await release(); }
}
function assertManifest(state, manifest) {
  if (state.schemaVersion !== 1 || !SAFE_RUN_ID.test(state.runId) || sourceRunId(state.runId) !== `pub-${state.source?.sha256?.slice(0, 16)}`
    || digest(manifest) !== state.manifestSha256 || manifest.video.sha256 !== state.source.sha256 || manifest.video.path !== state.source.path
    || manifest.publishAt !== state.publishAt || digest(manifest.targets) !== digest(Object.keys(state.lanes))) throw fail("PUBLISH_FILE_INVALID");
  if (state.authorization && state.authorization.manifestSha256 !== state.manifestSha256) throw fail("RUN_ALREADY_EXECUTED");
}
async function loadRun(paths) {
  const state = await readJson(paths.statePath);
  const manifest = await readJson(paths.manifestPath);
  assertManifest(state, manifest);
  return { state, manifest };
}
function overallState(state) {
  if (state.state === "cancelled") return "cancelled";
  const lanes = Object.values(state.lanes);
  if (!state.authorization) return "preflight_ok";
  if (lanes.some((l) => l.error || ["failed", "missed"].includes(l.state))) return "partial";
  const done = Object.entries(state.lanes).every(([name, lane]) => name === "youtube"
    ? (lane.state === "verified_public" || (lane.state === "uploaded" && lane.verified === true && ["private", "unlisted"].includes(lane.privacy)))
    : lane.state === "published");
  return done ? "complete" : "awaiting_publish";
}
async function saveRun(paths, state) {
  state.updatedAt = new Date().toISOString();
  state.state = overallState(state);
  await writeJson(paths.statePath, state);
  return state;
}
async function updateRun(paths, mutate) {
  return withRunLock(paths, async () => {
    const { state, manifest } = await loadRun(paths);
    await mutate(state, manifest);
    return saveRun(paths, state);
  });
}
function setLane(state, name, next, patch = {}) {
  const previous = state.lanes[name];
  if (!previous || !STATES[name]?.includes(next)) throw fail("PUBLISH_FILE_INVALID");
  if (["published", "verified_public", "cancelled"].includes(previous.state) && previous.state !== next) throw fail("RUN_ALREADY_EXECUTED");
  if (state.state === "cancelled" && next !== "cancelled" && next !== previous.state) throw fail("RUN_ALREADY_EXECUTED");
  if (!state.authorization && next !== "pending") throw fail("PUBLISH_NOT_APPROVED");
  state.lanes[name] = { ...previous, ...patch, state: next, updatedAt: new Date().toISOString() };
}
async function prepareRun({ manifest, source, publishAtLocal, settings, preflight, warnings = [], runId = `pub-${source.sha256.slice(0, 16)}`, replannedFrom = null }, runtime) {
  if (sourceRunId(runId) !== `pub-${source.sha256.slice(0, 16)}`) throw fail("VIDEO_SHA_MISMATCH");
  const paths = runPaths(runId, runtime);
  return withRunLock(paths, async () => {
    const existing = await readJson(paths.statePath, true);
    if (existing && (existing.state === "cancelled" || existing.authorization || Object.values(existing.lanes).some((l) => l.state !== "pending"))) throw fail("RUN_ALREADY_EXECUTED");
    if (existing && existing.source.sha256 !== source.sha256) throw fail("VIDEO_SHA_MISMATCH");
    const state = {
      schemaVersion: 1, runId, slug: manifest.slug, createdAt: existing?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(),
      source, publishAt: manifest.publishAt, publishAtLocal, settings, preflight, warnings, manifestSha256: digest(manifest), authorization: null,
      lanes: Object.fromEntries(manifest.targets.map((name) => [name, { state: "pending", error: null }])), state: "preflight_ok",
      ...(replannedFrom ? { replannedFrom } : {}),
    };
    await writeJson(paths.manifestPath, manifest);
    await writeJson(paths.statePath, state);
    return { state, paths };
  });
}
function authorize(state, lane, now = Date.now()) {
  if (state.state === "cancelled") throw fail("RUN_ALREADY_EXECUTED");
  if (state.authorization) {
    if (!lane || !state.lanes[lane] || (!["failed", "missed"].includes(state.lanes[lane].state)
      && !(state.lanes[lane].state === "pending" && state.lanes[lane].startedAt))) throw fail("RUN_ALREADY_EXECUTED");
  } else {
    if (lane) throw fail("RUN_ALREADY_EXECUTED");
    state.authorization = { authority: "user_approved_publish_json", approvedAt: new Date(now).toISOString(), manifestSha256: state.manifestSha256 };
  }
}
function assertReplannable(state) {
  if (state.state !== "cancelled") throw fail("REPLAN_REQUIRES_CANCELLED");
  if (Object.values(state.lanes).some((lane) => lane.mediaId || lane.videoId || lane.publishAttemptAt || lane.unknown
    || ["UPLOAD_OUTCOME_UNKNOWN", "INSTAGRAM_PUBLISH_UNKNOWN", "THREADS_PUBLISH_UNKNOWN", "X_PUBLISH_UNKNOWN"].includes(lane.error?.code)
    || lane.state === "scheduled_by_browser" || lane.state === "published" || lane.state === "verified_public")) throw fail("REPLAN_REMOTE_STATE_UNRESOLVED");
}
module.exports = { SAFE_RUN_ID, sourceRunId, STATES, runPaths, acquireLock, withRunLock, assertManifest, loadRun, saveRun, updateRun, setLane, prepareRun, authorize, overallState, assertReplannable };
