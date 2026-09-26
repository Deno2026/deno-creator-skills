"use strict";

const { path, fail, readJson, writeJson, sleep } = require("./common.cjs");
const { acquireLock } = require("./publish_run.cjs");
const { DEFAULT_API_VERSION } = require("./publish_manifest.cjs");
const DAY = 86400000;
function tokenStatus(token, now = Date.now()) {
  if (!token?.access_token) throw fail("INSTAGRAM_TOKEN_MISSING");
  const expiry = Date.parse(token.expires_at);
  const issued = Date.parse(token.refreshed_at ?? token.obtained_at);
  if (!Number.isFinite(expiry) || expiry <= now) throw fail("INSTAGRAM_TOKEN_EXPIRED");
  if (!Number.isFinite(issued) || issued > now) throw fail("INSTAGRAM_TOKEN_INVALID");
  return { expiresAt: new Date(expiry).toISOString(), remainingDays: (expiry - now) / DAY, canRefresh: now - issued >= DAY, needsRefresh: expiry - now < 10 * DAY };
}
async function requestJson(url, options = {}, fetchImpl = globalThis.fetch) {
  let response, data;
  try {
    response = await fetchImpl(url, { ...options, signal: options.signal ?? AbortSignal.timeout(30000), redirect: "error" });
    data = await response.json();
  } catch {
    throw fail("INSTAGRAM_REQUEST_UNKNOWN");
  }
  if (!response.ok || data.error) {
    const error = fail("INSTAGRAM_API_REJECTED");
    error.httpStatus = response.status;
    error.definitive = response.status >= 400 && response.status < 500 && response.status !== 408;
    throw error;
  }
  return data;
}
function normalizeToken(data, previous = {}, now = Date.now()) {
  if (!data.access_token || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) throw fail("INSTAGRAM_TOKEN_INVALID");
  return {
    access_token: data.access_token, token_type: data.token_type ?? "bearer", user_id: String(data.user_id ?? previous.user_id ?? ""),
    obtained_at: previous.obtained_at ?? new Date(now).toISOString(), refreshed_at: new Date(now).toISOString(), expires_at: new Date(now + Number(data.expires_in) * 1000).toISOString(),
  };
}
async function exchangeLongToken(shortToken, settings, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const url = new URL("https://graph.instagram.com/access_token");
  url.search = new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: settings.appSecret, access_token: shortToken }).toString();
  return normalizeToken(await requestJson(url, {}, fetchImpl), {}, now);
}
async function exchangeCode(code, settings, options = {}) {
  const short = await requestJson("https://api.instagram.com/oauth/access_token", {
    method: "POST", body: new URLSearchParams({ client_id: settings.appId, client_secret: settings.appSecret, grant_type: "authorization_code", redirect_uri: settings.redirectUri, code }),
  }, options.fetchImpl);
  // Instagram Login returns the short-token payload in data[0]; tolerate the documented flat shape too.
  const payload = short.data?.[0] ?? short;
  if (!payload.access_token) throw fail("INSTAGRAM_TOKEN_INVALID");
  const token = await exchangeLongToken(payload.access_token, settings, options);
  token.user_id = String(payload.user_id ?? "");
  return token;
}
async function refreshToken(token, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (!tokenStatus(token, now).canRefresh) throw fail("INSTAGRAM_TOKEN_TOO_YOUNG");
  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.search = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token.access_token }).toString();
  return normalizeToken(await requestJson(url, {}, fetchImpl), token, now);
}
function createInstagramApi({ token, igUserId, apiVersion = DEFAULT_API_VERSION, fetchImpl = globalThis.fetch }) {
  if (!/^\d+$/.test(String(igUserId)) || !/^v\d+\.0$/.test(apiVersion)) throw fail("INSTAGRAM_SETTINGS_INVALID");
  async function call(resource, params = {}, method = "GET") {
    const url = new URL(`https://graph.instagram.com/${apiVersion}/${resource}`);
    const body = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const options = { method, headers: { Authorization: `Bearer ${token.access_token}` } };
    if (method === "GET") url.search = body.toString(); else options.body = body;
    return requestJson(url, options, fetchImpl);
  }
  return {
    me: () => call("me", { fields: "id,username" }),
    publishingLimit: () => call(`${igUserId}/content_publishing_limit`, { fields: "quota_usage,config" }),
    // is_ai_generated is omitted when false: call() stringifies every value, and "false" would
    // still read as a set flag on the wire.
    createContainer: (metadata, videoUrl) => call(`${igUserId}/media`, {
      media_type: "REELS", video_url: videoUrl, caption: metadata.caption,
      share_to_feed: metadata.shareToFeed, thumb_offset: metadata.thumbOffsetMs,
      ...(metadata.isAiGenerated ? { is_ai_generated: true } : {}),
    }, "POST"),
    container: (id) => call(requireId(id), { fields: "status_code,status" }),
    publish: (id) => call(`${igUserId}/media_publish`, { creation_id: requireId(id) }, "POST"),
    media: (id) => call(requireId(id), { fields: "id,permalink,media_type,timestamp,caption" }),
    recent: () => call(`${igUserId}/media`, { fields: "id,timestamp,caption", limit: 5 }),
  };
}
function requireId(id) { if (!/^\d+$/.test(String(id))) throw fail("INSTAGRAM_RESPONSE_INVALID"); return String(id); }
async function ensureToken(runtime, settings, { now = Date.now(), fetchImpl = globalThis.fetch, autoRefresh = true } = {}) {
  let token = await readJson(runtime.instagramTokenPath, true);
  let status = tokenStatus(token, now);
  if (autoRefresh && status.needsRefresh && status.canRefresh) {
    const release = await acquireLock(path.join(runtime.runtimeRoot, "INSTAGRAM_AUTH.lock"));
    try {
      token = await readJson(runtime.instagramTokenPath);
      status = tokenStatus(token, now);
      if (status.needsRefresh && status.canRefresh) {
        token = await refreshToken(token, { now, fetchImpl });
        await writeJson(runtime.instagramTokenPath, token);
      }
    } finally { await release(); }
    status = tokenStatus(token, now);
  }
  const api = createInstagramApi({ token, igUserId: settings.igUserId, apiVersion: settings.apiVersion, fetchImpl });
  const me = await api.me();
  if (String(me.id) !== String(settings.igUserId) || (settings.username && settings.username !== me.username)) throw fail("INSTAGRAM_ACCOUNT_MISMATCH");
  return { token, status, api, username: me.username };
}
async function checkLimit(api) {
  const response = await api.publishingLimit();
  const row = response.data?.[0];
  const usage = Number(row?.quota_usage);
  const total = Number(row?.config?.quota_total ?? 100);
  if (!Number.isFinite(usage) || !Number.isFinite(total) || usage < 0 || total <= 0) throw fail("INSTAGRAM_RESPONSE_INVALID");
  const remaining = total - usage;
  if (remaining <= 0) throw fail("INSTAGRAM_PUBLISHING_LIMIT");
  return remaining;
}
async function pollContainer(api, id, { now = Date.now, sleepImpl = sleep, timeoutMs = 15 * 60000, intervalMs = 10000, onPoll = async () => {} } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const result = await api.container(id);
    await onPoll(result.status_code);
    if (result.status_code === "FINISHED") return result;
    if (["ERROR", "EXPIRED", "PUBLISHED"].includes(result.status_code)) throw fail(`INSTAGRAM_CONTAINER_${result.status_code}`);
    if (result.status_code !== "IN_PROGRESS") throw fail("INSTAGRAM_RESPONSE_INVALID");
    if (now() >= deadline) throw fail("INSTAGRAM_PROCESSING_TIMEOUT");
    await sleepImpl(Math.min(intervalMs, deadline - now()));
  }
}
async function reconcilePublish(api, caption, attemptedAt, now = Date.now()) {
  const result = await api.recent();
  const start = Date.parse(attemptedAt);
  const candidates = (result.data ?? []).filter((m) => m.caption === caption && Date.parse(m.timestamp) >= start - 10000 && Date.parse(m.timestamp) <= Math.min(now, start + 10 * 60000));
  if (candidates.length !== 1) throw fail("INSTAGRAM_PUBLISH_UNKNOWN");
  return requireId(candidates[0].id);
}
module.exports = { DAY, tokenStatus, requestJson, normalizeToken, exchangeLongToken, exchangeCode, refreshToken, createInstagramApi, requireId, ensureToken, checkLimit, pollContainer, reconcilePublish };
