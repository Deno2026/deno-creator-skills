"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { publishX } = require("../tools/publish_x_post.cjs");
const { loadRun, updateRun } = require("../tools/lib/publish_run.cjs");
const { fail } = require("../tools/lib/common.cjs");
const { fixture } = require("./fixtures.cjs");
function mocked(f, options = {}) {
  let time = Date.parse(f.state.publishAt) - 30000;
  const calls = { initialize: 0, append: 0, publish: 0, slept: 0 };
  const post = () => ({ id: "456", author_id: options.badAuthor ? "99" : "42", text: f.manifest.x.text, created_at: new Date(time).toISOString(), attachments: { media_keys: ["13_123"] } });
  const api = {
    initialize: async () => { calls.initialize++; return { id: "123", media_key: "13_123" }; },
    append: async () => { calls.append++; }, finalize: async () => ({ id: "123" }),
    container: async () => ({ id: "123", processing_info: { state: "succeeded" } }),
    publish: async () => { calls.publish++; if (options.unknown) throw fail("X_REQUEST_UNKNOWN");
      if (options.credit) { const error = fail("X_INSUFFICIENT_CREDIT"); error.definitive = true; throw error; } return { id: "456" }; },
    media: async () => post(), recent: async () => options.reconcile ? [post()] : [],
  };
  return { calls, deps: { credentials: { api, userId: "42", username: "test" }, now: () => time, sleep: async (ms) => { calls.slept += ms; time += ms; } } };
}
test("X waits for approved T, publishes once, verifies attached media and resumes safely", async (t) => {
  const f = await fixture(t, ["x"]); await f.approve(); const m = mocked(f);
  const result = await publishX(f.state.runId, { scheduled: true }, f.ctx, m.deps);
  assert.equal(result.permalink, "https://x.com/test/status/456"); assert.equal(m.calls.slept, 30000);
  assert.equal((await loadRun(f.paths)).state.lanes.x.state, "published");
  await publishX(f.state.runId, { scheduled: true }, f.ctx, m.deps);
  assert.equal(m.calls.publish, 1); assert.equal(m.calls.initialize, 1);
});
test("ambiguous X writes only reconcile across retries and cannot create a duplicate", async (t) => {
  const f = await fixture(t, ["x"]); await f.approve(); const m = mocked(f, { unknown: true });
  await assert.rejects(publishX(f.state.runId, { scheduled: true }, f.ctx, m.deps), { code: "X_PUBLISH_UNKNOWN" });
  await assert.rejects(publishX(f.state.runId, { scheduled: true }, f.ctx, m.deps), { code: "X_PUBLISH_UNKNOWN" });
  assert.equal(m.calls.publish, 1); assert.equal(m.calls.initialize, 1);
  const attempt = (await loadRun(f.paths)).state.lanes.x.publishAttemptAt;
  m.deps.credentials.api.recent = async () => [{ id: "456", author_id: "42", text: f.manifest.x.text, created_at: attempt, attachments: { media_keys: ["13_123"] } }];
  await publishX(f.state.runId, { scheduled: true }, f.ctx, m.deps);
  assert.equal(m.calls.publish, 1);
});
test("X insufficient credit is retryable only through another explicit call", async (t) => {
  const f = await fixture(t, ["x"]); await f.approve(); const m = mocked(f, { credit: true });
  await assert.rejects(publishX(f.state.runId, { scheduled: true }, f.ctx, m.deps), { code: "X_INSUFFICIENT_CREDIT" });
  assert.equal(m.calls.publish, 1); assert.equal((await loadRun(f.paths)).state.lanes.x.publishAttemptAt, null);
});
test("known X post survives readback failure without another upload or post", async (t) => {
  const f = await fixture(t, ["x"]); await f.approve(); const m = mocked(f, { badAuthor: true });
  await assert.rejects(publishX(f.state.runId, { scheduled: true }, f.ctx, m.deps), { code: "X_READBACK_MISMATCH" });
  assert.equal((await loadRun(f.paths)).state.lanes.x.mediaId, "456");
  const retry = mocked(f); await publishX(f.state.runId, { scheduled: true }, f.ctx, retry.deps);
  assert.equal(retry.calls.publish, 0); assert.equal(retry.calls.initialize, 0);
});
test("X unapproved, immediate and cancelled workers cannot publish", async (t) => {
  const f = await fixture(t, ["x"]); const m = mocked(f);
  await assert.rejects(publishX(f.state.runId, { scheduled: true }, f.ctx, m.deps), { code: "PUBLISH_NOT_APPROVED" });
  await f.approve();
  await assert.rejects(publishX(f.state.runId, { now: true }, f.ctx, m.deps), { code: "X_IMMEDIATE_NOT_APPROVED" });
  m.deps.sleep = async () => { await updateRun(f.paths, (s) => { s.state = "cancelled"; s.lanes.x.state = "cancelled"; }); };
  await assert.rejects(publishX(f.state.runId, { scheduled: true }, f.ctx, m.deps), { code: "RUN_CANCELLED" });
  assert.equal(m.calls.publish, 0);
});
test("X account changes after preflight are blocked before upload", async (t) => {
  const f = await fixture(t, ["x"]); await f.approve(); const m = mocked(f);
  await updateRun(f.paths, (s) => { s.preflight.x = { userId: "99", username: "another" }; });
  await assert.rejects(publishX(f.state.runId, { scheduled: true }, f.ctx, m.deps), { code: "X_ACCOUNT_MISMATCH" });
  assert.equal(m.calls.initialize, 0); assert.equal(m.calls.publish, 0);
});
