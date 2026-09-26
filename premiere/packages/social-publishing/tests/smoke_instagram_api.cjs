"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { tokenStatus, refreshToken, createInstagramApi, pollContainer, checkLimit, reconcilePublish, requestJson, exchangeCode } = require("../tools/lib/instagram_api.cjs");
const { safeError } = require("../tools/lib/common.cjs");
const { NOW } = require("./fixtures.cjs");
const DAY = 86400000;
function token(days = 41, age = 2) { return { access_token: "secret-never-log", obtained_at: new Date(NOW - age * DAY).toISOString(), expires_at: new Date(NOW + days * DAY).toISOString() }; }
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
test("24-hour minimum, 10-day refresh threshold, expiry", async () => {
  assert.equal(tokenStatus(token(), NOW).needsRefresh, false);
  assert.equal(tokenStatus(token(9), NOW).needsRefresh, true);
  assert.equal(tokenStatus(token(10), NOW).needsRefresh, false);
  assert.equal(tokenStatus(token(9, 0.99), NOW).canRefresh, false);
  assert.equal(tokenStatus(token(9, 1), NOW).canRefresh, true);
  assert.throws(() => tokenStatus(null, NOW), { code: "INSTAGRAM_TOKEN_MISSING" });
  assert.throws(() => tokenStatus(token(0), NOW), { code: "INSTAGRAM_TOKEN_EXPIRED" });
  await assert.rejects(refreshToken(token(9, 0.5), { now: NOW }), { code: "INSTAGRAM_TOKEN_TOO_YOUNG" });
  const refreshed = await refreshToken(token(9), { now: NOW, fetchImpl: async () => response({ access_token: "replacement", expires_in: 60 * 86400 }) });
  assert.equal(tokenStatus(refreshed, NOW).remainingDays, 60);
});
test("Instagram Login exchange uses data payload and long-lived token", async () => {
  const calls = [];
  const result = await exchangeCode("code", { appId: "123", appSecret: "private", redirectUri: "http://localhost:3400/oauth/instagram/callback" }, {
    now: NOW, fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return response(calls.length === 1 ? { data: [{ access_token: "short", user_id: "123" }] } : { access_token: "long", expires_in: 5184000 }); },
  });
  assert.equal(result.access_token, "long"); assert.equal(result.user_id, "123");
  assert.equal(calls[0].options.method, "POST"); assert.match(calls[1].url, /ig_exchange_token/);
});
test("graph uses Instagram host, pinned version, Bearer header and exact caption", async () => {
  const calls = [];
  const api = createInstagramApi({ token: token(), igUserId: "123", fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return response({ id: "456" }); } });
  await api.createContainer({ caption: "  test\n#tag  ", shareToFeed: false, thumbOffsetMs: 20 }, "https://r2.example/secret-url");
  assert.equal(calls[0].url, "https://graph.instagram.com/v26.0/123/media");
  assert.equal(calls[0].options.body.get("caption"), "  test\n#tag  ");
  assert.equal(calls[0].options.body.get("share_to_feed"), "false");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-never-log");
});
test("poll finishes, stops on terminal errors and times out without publication", async () => {
  let count = 0;
  await pollContainer({ container: async () => ({ status_code: ++count === 2 ? "FINISHED" : "IN_PROGRESS" }) }, "1", { sleepImpl: async () => {} });
  assert.equal(count, 2);
  for (const status of ["ERROR", "EXPIRED", "PUBLISHED"]) await assert.rejects(pollContainer({ container: async () => ({ status_code: status }) }, "1"), { code: `INSTAGRAM_CONTAINER_${status}` });
  let time = 0;
  await assert.rejects(pollContainer({ container: async () => ({ status_code: "IN_PROGRESS" }) }, "1", { now: () => time, sleepImpl: async (ms) => { time += ms; }, timeoutMs: 20000 }), { code: "INSTAGRAM_PROCESSING_TIMEOUT" });
});
test("publishing quota must be positive", async () => {
  assert.equal(await checkLimit({ publishingLimit: async () => ({ data: [{ quota_usage: 99, config: { quota_total: 100 } }] }) }), 1);
  await assert.rejects(checkLimit({ publishingLimit: async () => ({ data: [{ quota_usage: 100 }] }) }), { code: "INSTAGRAM_PUBLISHING_LIMIT" });
});
test("unknown publish reconciliation requires exactly one recent exact-caption match", async () => {
  const media = { id: "1", caption: "exact", timestamp: new Date(NOW).toISOString() };
  assert.equal(await reconcilePublish({ recent: async () => ({ data: [media] }) }, "exact", media.timestamp, NOW), "1");
  for (const data of [[], [media, { ...media, id: "2" }], [{ ...media, caption: "changed" }]]) {
    await assert.rejects(reconcilePublish({ recent: async () => ({ data }) }, "exact", media.timestamp, NOW), { code: "INSTAGRAM_PUBLISH_UNKNOWN" });
  }
});
test("network and provider failures cannot leak secrets and writes are not retried", async () => {
  let requests = 0;
  await assert.rejects(requestJson("https://graph.instagram.com", {}, async () => { requests++; throw new Error("secret-token https://signed.example/key"); }), { code: "INSTAGRAM_REQUEST_UNKNOWN" });
  assert.equal(requests, 1);
  const safe = JSON.stringify(safeError(new Error("secret-token")));
  assert.ok(!safe.includes("secret-token"));
  await assert.rejects(requestJson("https://graph.instagram.com", {}, async () => response({ error: { message: "secret-token" } }, 400)), (error) => error.definitive === true && !error.message.includes("secret-token"));
});
