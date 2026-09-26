"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { SCOPES, DAY, tokenStatus, refreshToken, exchangeCode, createThreadsApi, ensureToken, checkLimit, pollContainer } = require("../tools/lib/threads_api.cjs");
const { importedToken, authorizeUrl, saveConnection } = require("../tools/connect_threads.cjs");
const { writeJson, readJson, fail } = require("../tools/lib/common.cjs");
const { fixture, NOW } = require("./fixtures.cjs");
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const existingToken = () => ({ access_token: "existing-secret", token_type: "bearer", obtained_at: new Date(NOW - 2 * DAY).toISOString(),
  refreshed_at: new Date(NOW - 2 * DAY).toISOString(), expires_at: new Date(NOW + 60 * DAY).toISOString(), user_id: "123",
  username: "test", scope: SCOPES, source: "dashboard", note: "existing setup metadata" });

test("existing Threads dashboard token shape loads unchanged and refresh keeps setup metadata", async () => {
  const old = existingToken(); assert.deepEqual(importedToken(old, NOW), old);
  assert.equal(tokenStatus(old, NOW).canRefresh, true);
  let url;
  const next = await refreshToken(old, { now: NOW, fetchImpl: async (u) => { url = new URL(u); return response({ access_token: "new-secret", expires_in: 60 * 86400 }); } });
  assert.equal(url.pathname, "/refresh_access_token"); assert.equal(url.searchParams.get("grant_type"), "th_refresh_token");
  assert.equal(next.obtained_at, old.obtained_at); assert.equal(next.source, old.source); assert.equal(next.note, old.note); assert.equal(next.user_id, "123");
});
test("Threads first refresh waits 24 hours and expired tokens never refresh", async () => {
  const old = existingToken(); old.refreshed_at = new Date(NOW - DAY + 1).toISOString();
  const options = { now: NOW, fetchImpl: async () => { throw Error("must not call"); } };
  await assert.rejects(refreshToken(old, options), { code: "THREADS_TOKEN_TOO_YOUNG" });
  old.expires_at = new Date(NOW - 1).toISOString();
  await assert.rejects(refreshToken(old, options), { code: "THREADS_TOKEN_EXPIRED" });
});
test("Threads uses public exact redirect and exchanges short token for long token", async () => {
  const settings = { appId: "123", appSecret: "secret", redirectUri: "https://example.com/oauth/threads/callback" };
  const url = new URL(authorizeUrl(settings, "nonce")); assert.equal(url.searchParams.get("redirect_uri"), settings.redirectUri);
  assert.equal(url.searchParams.get("scope"), SCOPES.join(",")); assert.ok(!url.href.includes("secret"));
  assert.throws(() => authorizeUrl({ ...settings, redirectUri: "http://localhost:3400/oauth/threads/callback" }, "nonce"), { code: "THREADS_SETTINGS_INVALID" });
  const calls = [], token = await exchangeCode("secret-code", settings, { now: NOW, fetchImpl: async (u, o) => {
    calls.push({ url: new URL(u), options: o });
    return response(calls.length === 1 ? { access_token: "short", user_id: "123" } : { access_token: "long", expires_in: 60 * 86400 });
  } });
  assert.equal(calls[0].options.body.get("redirect_uri"), settings.redirectUri);
  assert.equal(calls[1].url.searchParams.get("grant_type"), "th_exchange_token");
  assert.equal(token.user_id, "123"); assert.equal(token.access_token, "long");
});
test("Threads API sends video/text, polls status and uses separate publish endpoint", async () => {
  const calls = [], api = createThreadsApi({ token: existingToken(), threadsUserId: "123", fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options }); return response({ id: "456", status: "FINISHED" });
  } });
  await api.createContainer({ text: "본문" }, "https://signed.invalid/video"); await api.container("456"); await api.publish("456"); await api.media("789");
  assert.equal(calls[0].url.pathname, "/v1.0/123/threads"); assert.equal(calls[0].options.body.get("media_type"), "VIDEO"); assert.equal(calls[0].options.body.get("text"), "본문");
  assert.equal(calls[1].url.searchParams.get("fields"), "status");
  assert.equal(calls[2].url.pathname, "/v1.0/123/threads_publish"); assert.equal(calls[2].options.body.get("creation_id"), "456");
  assert.ok(calls.every((c) => c.options.headers.Authorization === "Bearer existing-secret"));
});
test("Threads refreshes within ten days, persists token and binds the expected account", async (t) => {
  const f = await fixture(t, ["threads"]), token = existingToken(); token.expires_at = new Date(NOW + 9 * DAY).toISOString();
  await writeJson(f.ctx.runtime.threadsTokenPath, token);
  const settings = { threadsUserId: "123", username: "test" }, calls = [];
  const fetchImpl = async (u) => { calls.push(String(u)); return String(u).includes("refresh_access_token")
    ? response({ access_token: "fresh", expires_in: 60 * 86400 }) : response({ id: "123", username: "test" }); };
  const result = await ensureToken(f.ctx.runtime, settings, { now: NOW, fetchImpl });
  assert.equal(calls.length, 2); assert.equal(result.username, "test"); assert.equal((await readJson(f.ctx.runtime.threadsTokenPath)).access_token, "fresh");
  await assert.rejects(ensureToken(f.ctx.runtime, { ...settings, threadsUserId: "999" }, { now: NOW, fetchImpl }), { code: "THREADS_ACCOUNT_MISMATCH" });
});
test("Threads imported connection verifies account before overwriting credentials", async (t) => {
  const f = await fixture(t, ["threads"]), token = existingToken();
  const settings = { appId: "123", threadsUserId: "123", username: "test" };
  await assert.rejects(saveConnection(token, settings, f.ctx.runtime, { fetchImpl: async () => response({ id: "999", username: "wrong" }) }), { code: "THREADS_ACCOUNT_MISMATCH" });
  assert.equal(await readJson(f.ctx.runtime.threadsTokenPath, true), null);
  await saveConnection(token, settings, f.ctx.runtime, { fetchImpl: async () => response({ id: "123", username: "test" }) });
  assert.equal((await readJson(f.ctx.runtime.threadsSettingsPath)).threadsUserId, "123");
});
test("Threads quota and processing failures stop before publishing", async () => {
  await assert.rejects(checkLimit({ publishingLimit: async () => ({ data: [{ quota_usage: 250, config: { quota_total: 250 } }] }) }), { code: "THREADS_PUBLISHING_LIMIT" });
  await assert.rejects(pollContainer({ container: async () => ({ status: "ERROR" }) }, "123"), { code: "THREADS_CONTAINER_ERROR" });
  await assert.rejects(pollContainer({ container: async () => ({ status: "IN_PROGRESS" }) }, "123", { onPoll: async () => { throw fail("RUN_CANCELLED"); } }), { code: "RUN_CANCELLED" });
});
