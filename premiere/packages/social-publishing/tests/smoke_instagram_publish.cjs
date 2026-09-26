"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { publishInstagram } = require("../tools/publish_instagram_reel.cjs");
const { loadRun, updateRun } = require("../tools/lib/publish_run.cjs");
const { readJson, path, fail } = require("../tools/lib/common.cjs");
const { fixture } = require("./fixtures.cjs");
function mocked(f, options = {}) {
  let time = Date.parse(f.state.publishAt) - 30000;
  const calls = { stage: 0, container: 0, publish: 0, delete: 0, slept: 0 };
  const api = {
    publishingLimit: async () => ({ data: [{ quota_usage: 0 }] }),
    createContainer: async () => { calls.container++; return { id: "123" }; },
    container: async () => ({ status_code: "FINISHED" }),
    publish: async () => { calls.publish++; if (options.unknown) throw fail("INSTAGRAM_REQUEST_UNKNOWN"); return { id: "456" }; },
    recent: async () => ({ data: options.reconcile ? [{ id: "456", caption: f.manifest.instagram.caption, timestamp: new Date(time).toISOString() }] : [] }),
    media: async () => ({ id: "456", media_type: "VIDEO", caption: options.badCaption ? "bad" : f.manifest.instagram.caption, permalink: "https://www.instagram.com/reel/test/", timestamp: new Date(time).toISOString() }),
  };
  const r2 = { stage: async () => { calls.stage++; return { url: "https://signed.secret/DO_NOT_PERSIST", expiresAt: new Date(time + 21600000).toISOString() }; },
    unstage: async () => { calls.delete++; if (options.cleanupFails) throw fail("R2_UNREACHABLE"); } };
  return { calls, deps: { credentials: { api }, r2, now: () => time, sleep: async (ms) => { calls.slept += ms; time += ms; } } };
}
test("scheduled Instagram waits until T, publishes once, reads back and cleans R2", async (t) => {
  const f = await fixture(t, ["instagram"]); await f.approve(); const m = mocked(f);
  const result = await publishInstagram(f.state.runId, { scheduled: true }, f.ctx, m.deps);
  assert.equal(result.r2Deleted, true); assert.equal(m.calls.publish, 1); assert.equal(m.calls.slept, 30000);
  assert.equal((await loadRun(f.paths)).state.lanes.instagram.state, "published");
  assert.ok(!JSON.stringify(await readJson(f.paths.statePath)).includes("DO_NOT_PERSIST"));
  await publishInstagram(f.state.runId, { scheduled: true }, f.ctx, m.deps);
  assert.equal(m.calls.publish, 1); assert.equal(m.calls.stage, 1);
});
test("unknown publication is reconciled or remains blocked across retries", async (t) => {
  const f = await fixture(t, ["instagram"]); await f.approve(); const m = mocked(f, { unknown: true });
  await assert.rejects(publishInstagram(f.state.runId, { scheduled: true }, f.ctx, m.deps), { code: "INSTAGRAM_PUBLISH_UNKNOWN" });
  assert.equal(m.calls.publish, 1);
  await assert.rejects(publishInstagram(f.state.runId, { scheduled: true }, f.ctx, m.deps), { code: "INSTAGRAM_PUBLISH_UNKNOWN" });
  assert.equal(m.calls.publish, 1); assert.equal(m.calls.stage, 1);
  const recovered = mocked(f, { reconcile: true });
  // Keep the reconciliation timestamp at the recorded attempt.
  const attempt = Date.parse((await loadRun(f.paths)).state.lanes.instagram.publishAttemptAt);
  recovered.deps.now = () => attempt;
  recovered.deps.credentials.api.recent = async () => ({ data: [{ id: "456", caption: f.manifest.instagram.caption, timestamp: new Date(attempt).toISOString() }] });
  await publishInstagram(f.state.runId, { scheduled: true }, f.ctx, recovered.deps);
  assert.equal(recovered.calls.publish, 0);
});
test("successful publish survives cleanup failure and resumes only deletion", async (t) => {
  const f = await fixture(t, ["instagram"]); await f.approve(); const m = mocked(f, { cleanupFails: true });
  const result = await publishInstagram(f.state.runId, { scheduled: true }, f.ctx, m.deps);
  assert.equal(result.r2Deleted, false); assert.equal(m.calls.publish, 1);
  const retry = mocked(f);
  const cleaned = await publishInstagram(f.state.runId, { scheduled: true }, f.ctx, retry.deps);
  assert.equal(cleaned.r2Deleted, true); assert.equal(retry.calls.publish, 0); assert.equal(retry.calls.stage, 0);
});
test("readback mismatch retains known media id and never repeats publishing", async (t) => {
  const f = await fixture(t, ["instagram"]); await f.approve(); const m = mocked(f, { badCaption: true });
  await assert.rejects(publishInstagram(f.state.runId, { scheduled: true }, f.ctx, m.deps), { code: "INSTAGRAM_READBACK_MISMATCH" });
  assert.equal((await loadRun(f.paths)).state.lanes.instagram.mediaId, "456");
  const retry = mocked(f); await publishInstagram(f.state.runId, { scheduled: true }, f.ctx, retry.deps);
  assert.equal(retry.calls.publish, 0);
});
test("unapproved, immediate override and cancellation prevent platform writes", async (t) => {
  const f = await fixture(t, ["instagram"]); const m = mocked(f);
  await assert.rejects(publishInstagram(f.state.runId, { scheduled: true }, f.ctx, m.deps), { code: "PUBLISH_NOT_APPROVED" });
  await f.approve();
  await assert.rejects(publishInstagram(f.state.runId, { now: true }, f.ctx, m.deps), { code: "INSTAGRAM_IMMEDIATE_NOT_APPROVED" });
  m.deps.sleep = async () => { await updateRun(f.paths, (s) => { s.state = "cancelled"; s.lanes.instagram.state = "cancelled"; }); };
  await assert.rejects(publishInstagram(f.state.runId, { scheduled: true }, f.ctx, m.deps), { code: "RUN_CANCELLED" });
  assert.equal(m.calls.publish, 0);
});
test("an explicitly retried expired unposted container is replaced safely", async (t) => {
  const f = await fixture(t, ["instagram"]); await f.approve(); const m = mocked(f);
  await updateRun(f.paths, (s) => { Object.assign(s.lanes.instagram, { state: "failed", containerId: "999", error: { code: "INSTAGRAM_CONTAINER_EXPIRED" } }); });
  m.deps.credentials.api.container = async (id) => ({ status_code: id === "999" ? "EXPIRED" : "FINISHED" });
  await publishInstagram(f.state.runId, { scheduled: true }, f.ctx, m.deps);
  assert.equal(m.calls.container, 1); assert.equal(m.calls.publish, 1);
  assert.equal((await loadRun(f.paths)).state.lanes.instagram.retiredContainers[0].id, "999");
});
