"use strict";

const { createHash } = require("node:crypto");
const { fs, path, fail, readJson, writeJson, hashFile, sleep } = require("./common.cjs");
const { acquireLock } = require("./publish_run.cjs");
const SCOPES = ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"];
const CHUNK_BYTES = 5 * 1000 * 1000;
function requireId(id) {
  if (!/^\d{1,19}$/.test(String(id))) throw fail("X_RESPONSE_INVALID");
  return String(id);
}
function normalizeToken(data, previous = {}, now = Date.now()) {
  const token = { accessToken: data.accessToken ?? data.access_token,
    refreshToken: data.refreshToken ?? data.refresh_token ?? previous.refreshToken ?? previous.refresh_token,
    expiresAt: data.expiresAt ?? data.expires_at ?? (Number(data.expires_in) > 0 ? new Date(now + Number(data.expires_in) * 1000).toISOString() : null),
    scope: data.scope ?? previous.scope, obtainedAt: data.obtainedAt ?? data.obtained_at ?? previous.obtainedAt ?? previous.obtained_at ?? new Date(now).toISOString(),
    refreshedAt: data.refreshedAt ?? data.refreshed_at ?? new Date(now).toISOString(),
    userId: String(data.userId ?? data.user_id ?? previous.userId ?? previous.user_id ?? ""),
    username: data.username ?? previous.username, source: data.source ?? previous.source, note: data.note ?? previous.note };
  if (!token.accessToken || !token.refreshToken || !Number.isFinite(Date.parse(token.expiresAt))) throw fail("X_TOKEN_INVALID");
  const scopes = Array.isArray(token.scope) ? token.scope : String(token.scope ?? "").split(/[\s,]+/);
  if (SCOPES.some((s) => !scopes.includes(s))) throw fail("X_SCOPE_MISSING");
  token.scope = scopes.join(" ");
  return token;
}
function serializeToken(token, previous = {}) {
  if (previous.access_token !== undefined && previous.accessToken === undefined) {
    return { ...previous, access_token: token.accessToken, refresh_token: token.refreshToken, token_type: previous.token_type ?? "bearer",
      expires_at: token.expiresAt, obtained_at: token.obtainedAt, refreshed_at: token.refreshedAt, user_id: token.userId,
      username: token.username, scope: token.scope, source: token.source, note: token.note };
  }
  return token;
}
function tokenStatus(token, now = Date.now()) {
  if (!token?.accessToken && !token?.access_token) throw fail("X_TOKEN_MISSING");
  const expiresAt = token.expiresAt ?? token.expires_at;
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) throw fail("X_TOKEN_INVALID");
  return { expiresAt, remainingSeconds: Math.max(0, Math.floor((expiry - now) / 1000)),
    expired: expiry <= now, needsRefresh: expiry - now < 10 * 60000, canRefresh: !!(token.refreshToken ?? token.refresh_token) };
}
async function requestJson(url, options = {}, fetchImpl = globalThis.fetch) {
  let response, data;
  try {
    response = await fetchImpl(url, { ...options, signal: options.signal ?? AbortSignal.timeout(60000), redirect: "error" });
    const body = await response.text();
    try { data = body.trim() ? JSON.parse(body) : {}; }
    catch { if (!response.ok) data = {}; else throw fail("X_RESPONSE_INVALID"); }
  } catch { throw fail("X_REQUEST_UNKNOWN"); }
  if (!response.ok || data.error || data.errors?.length) {
    const credit = response.status === 402 || /credits.?depleted|insufficient.?credit/i.test(JSON.stringify(data));
    const error = fail(credit ? "X_INSUFFICIENT_CREDIT" : "X_API_REJECTED");
    error.definitive = response.status >= 400 && response.status < 500 && response.status !== 408;
    throw error;
  }
  return data;
}
async function tokenRequest(params, settings, previous, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  // The configured native app succeeded as a public client. A stored secret alone must not switch auth methods.
  if (settings.tokenEndpointAuthMethod === "client_secret_basic") {
    if (!settings.clientSecret) throw fail("X_SETTINGS_INVALID");
    headers.Authorization = "Basic " + Buffer.from(settings.clientId + ":" + settings.clientSecret).toString("base64");
  } else if (settings.tokenEndpointAuthMethod && settings.tokenEndpointAuthMethod !== "none") throw fail("X_SETTINGS_INVALID");
  return normalizeToken(await requestJson("https://api.x.com/2/oauth2/token", { method: "POST", headers,
    body: new URLSearchParams({ ...params, client_id: settings.clientId }) }, fetchImpl), previous, now);
}
const exchangeCode = (code, verifier, settings, options) => tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: settings.redirectUri }, settings, {}, options);
async function refreshToken(token, settings, options) {
  token = normalizeToken(token, token, options?.now);
  if (!token.refreshToken) throw fail("X_TOKEN_EXPIRED");
  return tokenRequest({ grant_type: "refresh_token", refresh_token: token.refreshToken }, settings, token, options);
}
function createXApi({ token, userId, fetchImpl = globalThis.fetch }) {
  async function call(resource, params = {}, method = "GET", form = null) {
    const url = new URL("https://api.x.com/2/" + resource);
    const options = { method, headers: { Authorization: "Bearer " + token.accessToken } };
    if (method === "GET") url.search = new URLSearchParams(params).toString();
    else if (form) options.body = form;
    else { options.headers["Content-Type"] = "application/json"; options.body = JSON.stringify(params); }
    return requestJson(url, options, fetchImpl);
  }
  return {
    me: async () => (await call("users/me")).data,
    initialize: async (size) => (await call("media/upload/initialize", { media_type: "video/mp4", media_category: "tweet_video", total_bytes: size }, "POST")).data,
    append: async (id, index, bytes) => {
      if (!Buffer.isBuffer(bytes) || bytes.length > CHUNK_BYTES || bytes.length === 0) throw fail("X_CHUNK_INVALID");
      const form = new FormData();
      form.set("segment_index", String(index)); form.set("media", new Blob([bytes], { type: "application/octet-stream" }), "chunk.mp4");
      return call("media/upload/" + requireId(id) + "/append", {}, "POST", form);
    },
    finalize: async (id) => (await call("media/upload/" + requireId(id) + "/finalize", {}, "POST")).data,
    container: async (id) => (await call("media/upload", { command: "STATUS", media_id: requireId(id) })).data,
    publish: async (id, text) => (await call("tweets", { text, media: { media_ids: [requireId(id)] } }, "POST")).data,
    media: async (id) => (await call("tweets/" + requireId(id), { "tweet.fields": "id,text,author_id,created_at,attachments,entities" })).data,
    recent: async () => (await call("users/" + requireId(userId) + "/tweets", { max_results: "5", "tweet.fields": "id,text,author_id,created_at,attachments,entities", exclude: "retweets,replies" })).data ?? [],
  };
}
async function ensureToken(runtime, settings, { now = Date.now(), fetchImpl = globalThis.fetch, forceRefresh = false } = {}) {
  let stored = await readJson(runtime.xTokenPath, true);
  const status = tokenStatus(stored, now);
  let token = normalizeToken(stored, stored, now);
  const originalAccess = token.accessToken;
  if (status.needsRefresh || forceRefresh) {
    const release = await acquireLock(path.join(runtime.runtimeRoot, "X_AUTH.lock"));
    try {
      stored = await readJson(runtime.xTokenPath);
      token = normalizeToken(stored, stored, now);
      if (tokenStatus(token, now).needsRefresh || (forceRefresh && token.accessToken === originalAccess)) {
        token = await refreshToken(token, settings, { now, fetchImpl });
        await writeJson(runtime.xTokenPath, serializeToken(token, stored));
      }
    } finally { await release(); }
  }
  token = normalizeToken(token, token, now);
  const api = createXApi({ token, userId: settings.userId ?? token.userId, fetchImpl });
  const me = await api.me();
  requireId(me?.id);
  if (!me.username || (!settings.userId && !settings.username) || (settings.userId && String(settings.userId) !== String(me.id))
    || (settings.username && settings.username.toLowerCase() !== me.username.toLowerCase()) || (token.userId && token.userId !== String(me.id))) throw fail("X_ACCOUNT_MISMATCH");
  return { token, api: createXApi({ token, userId: me.id, fetchImpl }), username: me.username, userId: String(me.id), status: tokenStatus(token, now) };
}
async function uploadVideo(api, source, { onInitialized = async () => {}, assertActive = async () => {} } = {}) {
  await assertActive();
  const initialized = await api.initialize(source.size);
  const id = requireId(initialized?.id);
  // media_key 접두어는 종류별로 다르다(3_ 이미지, 7_ 영상, 13_ amplify, 16_ gif). id 일치만 검사한다. (클로드 2026-09-08 실전 수정)
  const mediaKey = String(initialized.media_key ?? "");
  if (!/^\d+_\d+$/.test(mediaKey) || !mediaKey.endsWith("_" + id)) throw fail("X_RESPONSE_INVALID");
  await onInitialized({ containerId: id, mediaKey: initialized.media_key });
  const handle = await fs.open(source.path, "r");
  const hash = createHash("sha256");
  try {
    let offset = 0, index = 0;
    while (offset < source.size) {
      await assertActive();
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, source.size - offset));
      let filled = 0;
      while (filled < chunk.length) {
        const { bytesRead } = await handle.read(chunk, filled, chunk.length - filled, offset + filled);
        if (!bytesRead) throw fail("VIDEO_SHA_MISMATCH");
        filled += bytesRead;
      }
      hash.update(chunk);
      await api.append(id, index++, chunk);
      offset += filled;
    }
  } finally { await handle.close(); }
  if (hash.digest("hex") !== source.sha256 || (await hashFile(source.path)).sha256 !== source.sha256) throw fail("VIDEO_SHA_MISMATCH");
  await assertActive();
  return { containerId: id, mediaKey: initialized.media_key, finalized: await api.finalize(id) };
}
async function pollContainer(api, id, { now = Date.now, sleepImpl = sleep, timeoutMs = 15 * 60000, onPoll = async () => {} } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const result = await api.container(id);
    if (!result || String(result.id) !== String(id)) throw fail("X_RESPONSE_INVALID");
    const info = result?.processing_info;
    await onPoll(info?.state ?? "succeeded");
    if (!info || info.state === "succeeded") return result;
    if (info.state === "failed") throw fail("X_PROCESSING_FAILED");
    if (!["pending", "in_progress"].includes(info.state)) throw fail("X_RESPONSE_INVALID");
    if (now() >= deadline) throw fail("X_PROCESSING_TIMEOUT");
    await sleepImpl(Math.min(Math.max(1, Number(info.check_after_secs) || 1) * 1000, 30000, deadline - now()));
  }
}
// X rewrites links to t.co and appends the attached video's URL. Reconstruct only observed URL entities.
function observedText(post) {
  let text = post.text ?? "";
  for (const entity of post.entities?.urls ?? []) {
    let attachedVideo = false;
    try {
      const url = new URL(entity.expanded_url);
      attachedVideo = ["x.com", "twitter.com", "www.x.com", "www.twitter.com"].includes(url.hostname)
        && new RegExp("^/[^/]+/status/" + requireId(post.id) + "/(?:video|photo)/[1-4]$").test(url.pathname);
    } catch { /* An absent expanded URL is normal for media entities. */ }
    if ((entity.media_key && post.attachments?.media_keys?.includes(entity.media_key)) || attachedVideo) text = text.replace(entity.url, "");
    else if (entity.expanded_url) text = text.replace(entity.url, entity.expanded_url);
  }
  return text.trimEnd().normalize("NFC");
}
async function reconcilePublish(api, text, attemptedAt, mediaKey, userId, now = Date.now()) {
  const start = Date.parse(attemptedAt);
  const candidates = (await api.recent()).filter((m) => observedText(m) === text.trimEnd().normalize("NFC")
    && String(m.author_id) === String(userId) && m.attachments?.media_keys?.includes(mediaKey)
    && Date.parse(m.created_at) >= start - 10000 && Date.parse(m.created_at) <= Math.min(now, start + 10 * 60000));
  if (candidates.length !== 1) throw fail("X_PUBLISH_UNKNOWN");
  return requireId(candidates[0].id);
}
module.exports = { SCOPES, CHUNK_BYTES, requireId, normalizeToken, serializeToken, tokenStatus, requestJson, exchangeCode, refreshToken, createXApi, ensureToken, uploadVideo, pollContainer, reconcilePublish, observedText };
