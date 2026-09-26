"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeManifest, validateMedia } = require("../tools/lib/publish_manifest.cjs");
const { loadRun, updateRun, acquireLock } = require("../tools/lib/publish_run.cjs");
const { preflight, execute, status, cancel, replan } = require("../tools/publish_short_multi.cjs");
const { recordExternalPost } = require("../tools/record_external_post.cjs");
const { taskIdentity, query } = require("../tools/lib/windows_task.cjs");
const { stagingKey, MANAGED_KEY } = require("../tools/lib/r2_staging.cjs");
const { writeJson, readJson, path, fs, fail, execFileAsync } = require("../tools/lib/common.cjs");
const { fixture, source, manifest, NOW } = require("./fixtures.cjs");

test("defaults exclude TikTok and its five-minute rule only applies when selected", () => {
  const raw = manifest(); delete raw.targets; raw.publishAt = "2030-01-02T01:56:00+09:00";
  assert.deepEqual(normalizeManifest(raw, { source: source(), now: NOW }).manifest.targets, ["youtube", "instagram"]);
  raw.targets = ["tiktok"];
  assert.throws(() => normalizeManifest(raw, { source: source(), now: NOW }), { code: "TIKTOK_SCHEDULE_WINDOW" });
  raw.publishAt = "2030-01-02T02:00:00+09:00";
  assert.equal(normalizeManifest(raw, { source: source(), now: NOW }).manifest.publishAt, "2030-01-01T17:00:00.000Z");
});
test("Threads and X text preserve approved bytes and use platform limits", () => {
  const raw = manifest(); raw.targets = ["threads", "x"];
  raw.threads = { text: "가".repeat(500) }; raw.x = { text: "가".repeat(140) };
  const validate = () => normalizeManifest(raw, { source: source(), now: NOW });
  assert.equal(validate().manifest.threads.text, raw.threads.text);
  raw.x.text += "가"; assert.throws(validate, { code: "X_TEXT_INVALID" });
  raw.x.text = "👨‍👩‍👧‍👦".repeat(140); assert.equal(validate().manifest.x.text, raw.x.text);
  raw.x.text = "link https://example.com/video"; assert.ok(validate().warnings.includes("X_LINK_COST"));
  raw.threads.text += "가"; assert.throws(validate, { code: "THREADS_TEXT_INVALID" });
});
for (const [lane, field, value, code] of [
  ["threads", "durationSeconds", 301, "THREADS_SPEC"], ["threads", "fps", 22, "THREADS_SPEC"],
  ["threads", "videoCodec", "vp9", "THREADS_SPEC"], ["threads", "width", 1921, "THREADS_SPEC"],
  ["x", "durationSeconds", 140.01, "X_SPEC"], ["x", "videoCodec", "hevc", "X_SPEC"],
]) test(lane + " rejects " + field, () => {
  const s = source(); s.probe[field] = value; s.probe.height = 2200;
  assert.throws(() => validateMedia(s, [lane]), { code });
});
test("platform byte and duration boundaries are inclusive", () => {
  const s = source(); s.probe.durationSeconds = 300; s.size = 1000000000;
  assert.doesNotThrow(() => validateMedia(s, ["threads"]));
  s.size++; assert.throws(() => validateMedia(s, ["threads"]), { code: "THREADS_SPEC" });
  s.probe.durationSeconds = 140; s.size = 512 * 1024 * 1024;
  assert.doesNotThrow(() => validateMedia(s, ["x"]));
  s.size++; assert.throws(() => validateMedia(s, ["x"]), { code: "X_SPEC" });
});
test("R2 and task identities isolate lanes and revised runs while retaining original Instagram names", () => {
  const hash = "a".repeat(64), id = "pub-" + hash.slice(0, 16), revision = id + "-r2";
  const ig = stagingKey(id, hash), th = stagingKey(id, hash, "threads"), revised = stagingKey(revision, hash, "threads");
  assert.equal(new Set([ig, th, revised]).size, 3);
  for (const key of [ig, th, revised]) assert.ok(MANAGED_KEY.test(key));
  assert.ok(!MANAGED_KEY.test(revised.replace("/threads/", "/../")));
  assert.equal(taskIdentity(id).name, id);
  assert.equal(taskIdentity(revision, "threads").name, revision + "-threads");
  assert.notEqual(taskIdentity(id, "x").name, taskIdentity(id, "threads").name);
});
test("cancel without a registered task skips scheduler and replan preserves prior evidence", async (t) => {
  const f = await fixture(t, ["instagram"]); let removals = 0;
  const deps = { now: () => NOW, inspectSource: async () => f.source,
    credentials: { username: "test", status: { remainingDays: 41, expiresAt: "2030-03-01T00:00:00Z" } },
    r2: { headBucket: async () => {} }, windowsTask: { remove: async () => { removals++; } } };
  await cancel(f.state.runId, f.ctx, deps); assert.equal(removals, 0);
  const previousManifest = await fs.readFile(f.paths.manifestPath);
  f.raw.publishAt = "2030-01-03T00:00:00Z"; await writeJson(f.input, f.raw);
  const replanned = await replan(f.input, f.state.runId, f.ctx, deps);
  assert.equal(replanned.state.runId, f.state.runId + "-r2"); assert.equal(replanned.state.authorization, null);
  assert.equal((await loadRun(f.paths)).state.state, "cancelled");
  assert.deepEqual(await fs.readFile(f.paths.manifestPath), previousManifest);
  assert.equal((await loadRun(f.paths)).state.replannedTo, replanned.state.runId);
  assert.equal(replanned.state.source.sha256, f.source.sha256);
  await assert.rejects(execute(f.state.runId, {}, f.ctx, deps), { code: "RUN_ALREADY_EXECUTED" });
  const updated = await preflight(f.input, f.ctx, deps, { runId: replanned.state.runId });
  assert.equal(updated.state.replannedFrom, f.state.runId);
});
test("executed but unposted scheduled run can be replanned after cancellation", async (t) => {
  const f = await fixture(t, ["threads"]); let removals = 0;
  const deps = { now: () => NOW, inspectSource: async () => f.source,
    threadsCredentials: { username: "test", status: { remainingDays: 41, expiresAt: "2030-03-01T00:00:00Z" }, api: { publishingLimit: async () => ({ data: [{ quota_usage: 0 }] }) } },
    r2: { headBucket: async () => {} }, windowsTask: { register: async () => ({ taskName: "test" }), remove: async () => { removals++; } } };
  await execute(f.state.runId, {}, f.ctx, deps); await cancel(f.state.runId, f.ctx, deps);
  const result = await replan(f.input, f.state.runId, f.ctx, deps);
  assert.equal(result.state.runId, f.state.runId + "-r2"); assert.equal(removals, 2);
});
test("replan refuses live locks, published IDs and unknown write outcomes", async (t) => {
  const f = await fixture(t, ["threads"]); await f.approve();
  await cancel(f.state.runId, f.ctx);
  const release = await acquireLock(path.join(f.paths.runDir, "THREADS.lock"));
  await assert.rejects(replan(f.input, f.state.runId, f.ctx), { code: "RUN_LOCKED" }); await release();
  await updateRun(f.paths, (s) => { s.lanes.threads.publishAttemptAt = new Date(NOW).toISOString(); });
  await assert.rejects(replan(f.input, f.state.runId, f.ctx), { code: "REPLAN_REMOTE_STATE_UNRESOLVED" });
  await updateRun(f.paths, (s) => { s.lanes.threads.publishAttemptAt = null; s.lanes.threads.mediaId = "123"; });
  await assert.rejects(replan(f.input, f.state.runId, f.ctx), { code: "REPLAN_REMOTE_STATE_UNRESOLVED" });
});
test("all worker lanes register independently and cancellation attempts each task", async (t) => {
  const f = await fixture(t, ["instagram", "threads", "x"]); const registered = [], removed = [];
  const deps = { now: () => NOW, windowsTask: { register: async (o) => {
    registered.push(o); if (o.lane === "threads") throw fail("SCHEDULER_FAILED"); return { taskName: o.lane };
  }, remove: async (_id, _run, _cmd, lane) => { removed.push(lane); } } };
  const result = await execute(f.state.runId, {}, f.ctx, deps);
  assert.deepEqual(registered.map((r) => r.lane), ["instagram", "threads", "x"]);
  assert.equal(result.state.lanes.threads.state, "failed"); assert.equal(result.state.lanes.x.state, "task_registered");
  assert.ok(registered[2].toolPath.endsWith("publish_x_post.cjs"));
  await cancel(f.state.runId, f.ctx, deps);
  assert.deepEqual(removed, ["instagram", "threads", "x"]);
});
test("Threads and X preflight checks shared R2 once and keeps paid API disclosure", async (t) => {
  const f = await fixture(t, ["instagram", "threads", "x"]); let heads = 0;
  const credentials = { username: "test", status: { remainingDays: 41, expiresAt: "2030-03-01T00:00:00Z" },
    api: { publishingLimit: async () => ({ data: [{ quota_usage: 1, config: { quota_total: 250 } }] }) } };
  const deps = { now: () => NOW, inspectSource: async () => f.source, credentials, threadsCredentials: credentials,
    xCredentials: { username: "test", userId: "42", status: { canRefresh: true, expiresAt: "2030-01-01T02:00:00Z" } }, r2: { headBucket: async () => { heads++; } } };
  const result = await preflight(f.input, f.ctx, deps);
  assert.equal(heads, 1); assert.equal(result.state.preflight.x.credit, "not_checked"); assert.ok(result.state.warnings.includes("X_PAID_API"));
  assert.equal(result.state.preflight.x.userId, "42"); assert.equal(result.state.authorization, null);
});
test("cancellation racing registration removes the newly registered task", async (t) => {
  const f = await fixture(t, ["x"]); let removed = 0;
  const deps = { now: () => NOW, windowsTask: { register: async () => {
    await cancel(f.state.runId, f.ctx, { windowsTask: { remove: async () => {} } }); return { taskName: "late" };
  }, remove: async () => { removed++; } } };
  const result = await execute(f.state.runId, {}, f.ctx, deps);
  assert.equal(result.state.state, "cancelled"); assert.equal(result.state.lanes.x.state, "cancelled"); assert.equal(removed, 1);
});
test("published lane with vanished task is complete while real scheduler faults remain visible", async (t) => {
  const f = await fixture(t, ["threads"]); await f.approve();
  await updateRun(f.paths, (s) => { s.lanes.threads.taskName = "test"; });
  await writeJson(path.join(f.paths.runDir, "threads/result.json"), { runId: f.state.runId, manifestSha256: f.state.manifestSha256, mediaId: "123", permalink: "https://www.threads.com/@test/post/abc" });
  const result = await status(f.state.runId, null, f.ctx, { windowsTask: { query: async () => ({ exists: false }) } });
  assert.equal(result.summary.schedulers.threads.state, "completed_task_absent"); assert.equal(result.summary.lanes.threads.state, "published");
  assert.ok(!result.summary.warnings.includes("SCHEDULER_FAILED"));
  const failed = await status(f.state.runId, null, f.ctx, { windowsTask: { query: async () => { throw fail("SCHEDULER_FAILED"); } } });
  assert.ok(failed.summary.warnings.includes("SCHEDULER_FAILED"));
});
test("TikTok text evidence records exact text, URL and manifest without an image", async (t) => {
  const f = await fixture(t, ["tiktok"]);
  await execute(f.state.runId, {}, f.ctx, { now: () => NOW });
  const options = { runId: f.state.runId, platform: "tiktok", state: "scheduled_by_browser", scheduledAt: f.manifest.publishAt, evidenceNote: "예약 목록: 테스트 영상 / 1월 2일 오후 7시 / 공개" };
  const result = await recordExternalPost(options, f.ctx);
  assert.equal(result.evidence.kind, "text"); assert.equal(result.evidence.note, options.evidenceNote);
  assert.match(result.evidence.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await readJson(path.join(f.paths.runDir, "tiktok/result.json"))).manifestSha256, f.state.manifestSha256);
  await assert.rejects(recordExternalPost({ ...options, evidenceNote: " " }, f.ctx), { code: "EVIDENCE_MISSING" });
});
test("real CLI execute stdout contains only protocol records even when TikTok awaits action", async (t) => {
  const f = await fixture(t, ["tiktok"]);
  // The process wall clock is earlier than this fixture; use a current approved future slot.
  const at = new Date(Math.ceil((Date.now() + 60 * 60000) / 300000) * 300000).toISOString();
  f.raw.publishAt = at;
  const normalized = normalizeManifest(f.raw, { source: f.source });
  await require("../tools/lib/publish_run.cjs").prepareRun({ ...normalized, source: f.source, settings: f.ctx.settings, preflight: {} }, f.ctx.runtime);
  const entry = path.join(f.ctx.productionRoot, "packages/social-publishing/tools/publish_short_multi.cjs");
  await assert.rejects(execFileAsync(process.execPath, [entry, "--run-id", f.state.runId, "--execute"], { env: f.ctx.env, windowsHide: true }), (error) => {
    assert.equal(error.code, 2);
    for (const line of error.stdout.trim().split("\n")) {
      assert.match(line, /^SOCIAL_[A-Z_]+ /); JSON.parse(line.slice(line.indexOf(" ") + 1));
    }
    assert.ok(error.stderr.includes("캡션:")); return true;
  });
});
test("paid API notice does not turn a verified X publication into a failed status", async (t) => {
  const f = await fixture(t, ["x"]); await f.approve();
  await updateRun(f.paths, (s) => { s.warnings = ["X_PAID_API"]; });
  await writeJson(path.join(f.paths.runDir, "x/result.json"), { runId: f.state.runId, manifestSha256: f.state.manifestSha256, mediaId: "123", permalink: "https://x.com/test/status/123" });
  const result = await status(f.state.runId, null, f.ctx);
  assert.equal(result.exitCode, 0); assert.deepEqual(result.summary.notices, ["X_PAID_API"]); assert.deepEqual(result.summary.warnings, []);
});

test("Threads topic tag and Instagram AI disclosure normalize and reach the API", async () => {
  const { createThreadsApi } = require("../tools/lib/threads_api.cjs");
  const { createInstagramApi } = require("../tools/lib/instagram_api.cjs");
  const raw = manifest(); raw.targets = ["threads"]; raw.threads = { text: "본문", topicTag: "디노이즈" };
  const validate = () => normalizeManifest(raw, { source: source(), now: NOW });
  assert.equal(validate().manifest.threads.topicTag, "디노이즈");
  for (const bad of ["", " ", " 디노이즈", "가".repeat(51), "a.b", "a&b", "#디노이즈", 5]) {
    raw.threads.topicTag = bad;
    assert.throws(validate, { code: "THREADS_TEXT_INVALID" }, `topicTag ${JSON.stringify(bad)} must be rejected`);
  }
  delete raw.threads.topicTag;
  assert.equal("topicTag" in validate().manifest.threads, false);

  // The API layer stringifies every parameter, so an absent field must not appear at all.
  const bodies = [];
  const api = createThreadsApi({ token: { access_token: "t" }, threadsUserId: "1",
    fetchImpl: async (u, o) => { bodies.push(o.body); return new Response(JSON.stringify({ id: "1" }), { status: 200 }); } });
  await api.createContainer({ text: "본문", topicTag: "디노이즈" }, "https://example.com/v.mp4");
  assert.equal(bodies[0].get("topic_tag"), "디노이즈");
  await api.createContainer({ text: "본문" }, "https://example.com/v.mp4");
  assert.equal(bodies[1].has("topic_tag"), false);

  const ig = manifest();
  assert.equal(normalizeManifest(ig, { source: source(), now: NOW }).manifest.instagram.isAiGenerated, false);
  ig.instagram.isAiGenerated = true;
  assert.equal(normalizeManifest(ig, { source: source(), now: NOW }).manifest.instagram.isAiGenerated, true);
  ig.instagram.isAiGenerated = "true";
  assert.throws(() => normalizeManifest(ig, { source: source(), now: NOW }), { code: "PUBLISH_FILE_INVALID" });

  const igBodies = [];
  const igApi = createInstagramApi({ token: { access_token: "t" }, igUserId: "1", apiVersion: "v21.0",
    fetchImpl: async (u, o) => { igBodies.push(o.body); return new Response(JSON.stringify({ id: "1" }), { status: 200 }); } });
  await igApi.createContainer({ caption: "c", shareToFeed: true, thumbOffsetMs: 0, isAiGenerated: true }, "https://example.com/v.mp4");
  assert.equal(igBodies[0].get("is_ai_generated"), "true");
  await igApi.createContainer({ caption: "c", shareToFeed: true, thumbOffsetMs: 0, isAiGenerated: false }, "https://example.com/v.mp4");
  assert.equal(igBodies[1].has("is_ai_generated"), false);
});
