"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { SCOPES, CHUNK_BYTES, normalizeToken, tokenStatus, createXApi, exchangeCode, refreshToken, ensureToken, uploadVideo, pollContainer, requestJson, observedText } = require("../tools/lib/x_api.cjs");
const { fs, hashFile, writeJson, readJson, fail } = require("../tools/lib/common.cjs");
const { fixture, NOW } = require("./fixtures.cjs");
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const token = (patch = {}) => normalizeToken({ accessToken: "access-secret", refreshToken: "refresh-secret", expiresAt: "2030-01-02T00:00:00Z", scope: SCOPES.join(" "), ...patch }, {}, NOW);

test("X OAuth exchanges PKCE and rotates refresh credentials with optional Basic authentication", async () => {
  const calls = [], settings = { clientId: "client", clientSecret: "secret", tokenEndpointAuthMethod: "client_secret_basic", redirectUri: "http://127.0.0.1:3400/oauth/x/callback" };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 7200, scope: SCOPES.join(" ") });
  };
  const exchanged = await exchangeCode("code-secret", "verifier-secret", settings, { fetchImpl, now: NOW });
  assert.equal(calls[0].url, "https://api.x.com/2/oauth2/token");
  assert.equal(calls[0].options.body.get("code_verifier"), "verifier-secret");
  assert.equal(calls[0].options.headers.Authorization, "Basic " + Buffer.from("client:secret").toString("base64"));
  assert.equal(exchanged.refreshToken, "new-refresh");
  await refreshToken(exchanged, { ...settings, tokenEndpointAuthMethod: "none" }, { fetchImpl, now: NOW });
  assert.equal(calls[1].options.headers.Authorization, undefined); assert.equal(calls[1].options.body.get("refresh_token"), "new-refresh");
});
test("console token import preserves expiry and refuses missing scopes", () => {
  const t = token(); assert.equal(t.expiresAt, "2030-01-02T00:00:00Z"); assert.equal(tokenStatus(t, NOW).canRefresh, true);
  assert.throws(() => token({ scope: "tweet.write" }), { code: "X_SCOPE_MISSING" });
  assert.throws(() => token({ expiresAt: "bad" }), { code: "X_TOKEN_INVALID" });
});
test("X API uses v2 paths and actual multipart chunks with bearer auth", async () => {
  const calls = [], fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return response({ data: { id: "123", media_key: "13_123" } });
  };
  const api = createXApi({ token: token(), userId: "42", fetchImpl });
  await api.initialize(10); await api.append("123", 0, Buffer.from("chunk")); await api.finalize("123"); await api.container("123"); await api.publish("123", "hello");
  assert.deepEqual(calls.map((c) => c.url.pathname), ["/2/media/upload/initialize", "/2/media/upload/123/append", "/2/media/upload/123/finalize", "/2/media/upload", "/2/tweets"]);
  assert.equal(calls[3].url.searchParams.get("command"), "STATUS");
  assert.equal(await calls[1].options.body.get("media").text(), "chunk");
  assert.equal(calls[1].options.headers["Content-Type"], undefined);
  assert.deepEqual(JSON.parse(calls[4].options.body).media.media_ids, ["123"]);
  assert.ok(calls.every((c) => c.options.headers.Authorization === "Bearer access-secret" && c.options.redirect === "error"));
});
test("X credit rejection is definitive and sensitive provider text stays out of errors", async () => {
  await assert.rejects(requestJson("https://api.x.com/2/tweets", {}, async () => response({ title: "CreditsDepleted", detail: "SECRET-DATA" }, 402)),
    (error) => error.code === "X_INSUFFICIENT_CREDIT" && error.definitive && !error.message.includes("SECRET"));
  await assert.rejects(requestJson("https://api.x.com/2/tweets", {}, async () => { throw Error("SECRET"); }), { code: "X_REQUEST_UNKNOWN" });
  await assert.rejects(requestJson("https://api.x.com/2/tweets", {}, async () => response({ errors: [{ title: "error" }] }, 503)), (e) => !e.definitive);
});
test("chunked upload sends exact file bytes in at most 5MB slices", async (t) => {
  const f = await fixture(t, ["x"]);
  const bytes = Buffer.alloc(CHUNK_BYTES + 17, 123); await fs.writeFile(f.source.path, bytes);
  const src = { path: f.source.path, ...await hashFile(f.source.path) };
  const chunks = [], order = [];
  const api = { initialize: async (size) => { assert.equal(size, bytes.length); order.push("init"); return { id: "123", media_key: "13_123" }; },
    append: async (_id, index, chunk) => { chunks.push(Buffer.from(chunk)); assert.equal(index, chunks.length - 1); },
    finalize: async () => { order.push("finalize"); return { id: "123" }; } };
  await uploadVideo(api, src, { onInitialized: async () => { order.push("persist"); } });
  assert.deepEqual(chunks.map((c) => c.length), [CHUNK_BYTES, 17]); assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.deepEqual(order, ["init", "persist", "finalize"]);
});
test("file mutation or cancellation prevents media finalize", async (t) => {
  const f = await fixture(t, ["x"]); let finalized = 0;
  const api = { initialize: async () => ({ id: "123", media_key: "13_123" }), append: async () => { await fs.writeFile(f.source.path, "changed"); }, finalize: async () => { finalized++; } };
  await assert.rejects(uploadVideo(api, f.source), { code: "VIDEO_SHA_MISMATCH" }); assert.equal(finalized, 0);
  await assert.rejects(uploadVideo(api, f.source, { assertActive: async () => { throw fail("RUN_CANCELLED"); } }), { code: "RUN_CANCELLED" });
});
test("expired X access token refreshes and persists rotation before account readback", async (t) => {
  const f = await fixture(t, ["x"]); const old = token({ expiresAt: "2029-12-31T00:00:00Z" });
  await writeJson(f.ctx.runtime.xTokenPath, old);
  const calls = [], fetchImpl = async (url) => { calls.push(String(url)); return String(url).endsWith("/oauth2/token")
    ? response({ access_token: "rotated", refresh_token: "rotated-refresh", expires_in: 7200, scope: SCOPES.join(" ") })
    : response({ data: { id: "42", username: "test" } }); };
  const result = await ensureToken(f.ctx.runtime, { clientId: "client", userId: "42", username: "test" }, { now: NOW, fetchImpl });
  assert.equal(result.userId, "42"); assert.equal(calls.length, 2); assert.equal((await readJson(f.ctx.runtime.xTokenPath)).refreshToken, "rotated-refresh");
  await assert.rejects(ensureToken(f.ctx.runtime, { clientId: "client", userId: "43", username: "test" }, { now: NOW, fetchImpl }), { code: "X_ACCOUNT_MISMATCH" });
});
test("processing polling honors check_after_secs, cancellation and deadline", async () => {
  let time = NOW, polls = 0;
  const api = { container: async () => ({ id: "123", processing_info: { state: ++polls === 2 ? "succeeded" : "in_progress", check_after_secs: 2 } }) };
  await pollContainer(api, "123", { now: () => time, sleepImpl: async (ms) => { time += ms; } });
  assert.equal(time, NOW + 2000);
  const forever = { container: async () => ({ id: "123", processing_info: { state: "pending" } }) };
  await assert.rejects(pollContainer(forever, "123", { now: () => time, timeoutMs: 10, sleepImpl: async (ms) => { time += ms; } }), { code: "X_PROCESSING_TIMEOUT" });
});
test("readback reconstructs shortened links and removes only attached-media entities", () => {
  assert.equal(observedText({ text: "hello https://t.co/link https://t.co/video", attachments: { media_keys: ["13_123"] }, entities: { urls: [
    { url: "https://t.co/link", expanded_url: "https://example.com" }, { url: "https://t.co/video", media_key: "13_123" },
  ] } }), "hello https://example.com");
  assert.equal(observedText({ text: "Cafe\u0301" }), "Café");
  assert.equal(observedText({ id: "456", text: "hello https://t.co/video", entities: { urls: [{ url: "https://t.co/video", expanded_url: "https://x.com/test/status/456/video/1" }] } }), "hello");
});
test("current snake_case runtime token preserves its schema and metadata during forced pre-publish rotation", async (t) => {
  const f = await fixture(t, ["x"]);
  const original = { access_token: "original", refresh_token: "original-refresh", token_type: "bearer",
    obtained_at: new Date(NOW - 10000).toISOString(), refreshed_at: null, expires_at: new Date(NOW + 7200000).toISOString(),
    user_id: "42", username: "test", scope: SCOPES.join(" "), source: "approved_pkce_test", note: "keep this setup note" };
  await writeJson(f.ctx.runtime.xTokenPath, original);
  let refreshes = 0;
  const fetchImpl = async (u, options) => {
    if (String(u).endsWith("/oauth2/token")) {
      refreshes++; assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.body.get("refresh_token"), "original-refresh");
      return response({ access_token: "rotated", refresh_token: "rotated-refresh", expires_in: 7200, scope: SCOPES.join(" ") });
    }
    return response({ data: { id: "42", username: "test" } });
  };
  const result = await ensureToken(f.ctx.runtime, { clientId: "client", clientSecret: "stored-unused", username: "test" }, { now: NOW, fetchImpl, forceRefresh: true });
  assert.equal(result.userId, "42"); assert.equal(refreshes, 1);
  const saved = await readJson(f.ctx.runtime.xTokenPath);
  assert.equal(saved.access_token, "rotated"); assert.equal(saved.refresh_token, "rotated-refresh"); assert.equal(saved.accessToken, undefined);
  assert.equal(saved.obtained_at, original.obtained_at); assert.equal(saved.note, original.note); assert.equal(saved.source, original.source);
  assert.equal(tokenStatus(saved, NOW).remainingSeconds, 7200);
});
test("non-JSON credit failure is definitive and malformed processing response is rejected", async () => {
  await assert.rejects(requestJson("https://api.x.com/2/tweets", {}, async () => new Response("Payment required", { status: 402 })),
    (e) => e.code === "X_INSUFFICIENT_CREDIT" && e.definitive);
  await assert.rejects(pollContainer({ container: async () => ({}) }, "123"), { code: "X_RESPONSE_INVALID" });
});
