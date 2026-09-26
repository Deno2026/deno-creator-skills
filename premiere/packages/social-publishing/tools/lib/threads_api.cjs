"use strict";

const { path, fail, readJson, writeJson, sleep } = require("./common.cjs");
const { acquireLock } = require("./publish_run.cjs");
const DAY = 86400000;
const SCOPES = ["threads_basic", "threads_content_publish"];
function requireId(id) {
  if (!/^\d+$/.test(String(id))) throw fail("THREADS_RESPONSE_INVALID");
  return String(id);
}
function tokenStatus(token, now = Date.now()) {
  if (!token?.access_token) throw fail("THREADS_TOKEN_MISSING");
  const expiry = Date.parse(token.expires_at);
  const issued = Date.parse(token.refreshed_at ?? token.obtained_at);
  if (!Number.isFinite(expiry) || expiry <= now) throw fail("THREADS_TOKEN_EXPIRED");
  if (!Number.isFinite(issued) || issued > now) throw fail("THREADS_TOKEN_INVALID");
  return { expiresAt: token.expires_at, remainingDays: (expiry - now) / DAY, canRefresh: now - issued >= DAY, needsRefresh: expiry - now < 10 * DAY };
}
async function requestJson(url, options = {}, fetchImpl = globalThis.fetch) {
  let response, data;
  try {
    response = await fetchImpl(url, { ...options, signal: options.signal ?? AbortSignal.timeout(30000), redirect: "error" });
    data = await response.json();
  } catch { throw fail("THREADS_REQUEST_UNKNOWN"); }
  if (!response.ok || data.error) {
    const error = fail("THREADS_API_REJECTED");
    error.definitive = response.status >= 400 && response.status < 500 && response.status !== 408;
    throw error;
  }
  return data;
}
function normalizeToken(data, previous = {}, now = Date.now()) {
  if (typeof data.access_token !== "string" || !data.access_token || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) throw fail("THREADS_TOKEN_INVALID");
  return { ...previous, access_token: data.access_token, token_type: data.token_type ?? "bearer",
    user_id: String(data.user_id ?? previous.user_id ?? ""), obtained_at: previous.obtained_at ?? new Date(now).toISOString(),
    refreshed_at: new Date(now).toISOString(), expires_at: new Date(now + Number(data.expires_in) * 1000).toISOString() };
}
async function exchangeCode(code, settings, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const short = await requestJson("https://graph.threads.net/oauth/access_token", { method: "POST",
    body: new URLSearchParams({ client_id: settings.appId, client_secret: settings.appSecret, grant_type: "authorization_code", redirect_uri: settings.redirectUri, code }) }, fetchImpl);
  if (!short.access_token) throw fail("THREADS_TOKEN_INVALID");
  const url = new URL("https://graph.threads.net/access_token");
  url.search = new URLSearchParams({ grant_type: "th_exchange_token", client_secret: settings.appSecret, access_token: short.access_token }).toString();
  return normalizeToken(await requestJson(url, {}, fetchImpl), { user_id: String(short.user_id ?? ""), scope: SCOPES }, now);
}
async function refreshToken(token, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (!tokenStatus(token, now).canRefresh) throw fail("THREADS_TOKEN_TOO_YOUNG");
  const url = new URL("https://graph.threads.net/refresh_access_token");
  url.search = new URLSearchParams({ grant_type: "th_refresh_token", access_token: token.access_token }).toString();
  return normalizeToken(await requestJson(url, {}, fetchImpl), token, now);
}
function createThreadsApi({ token, threadsUserId, fetchImpl = globalThis.fetch }) {
  requireId(threadsUserId);
  async function call(resource, params = {}, method = "GET") {
    const url = new URL("https://graph.threads.net/v1.0/" + resource);
    const body = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const options = { method, headers: { Authorization: "Bearer " + token.access_token } };
    if (method === "GET") url.search = body.toString(); else options.body = body;
    return requestJson(url, options, fetchImpl);
  }
  return {
    me: () => call("me", { fields: "id,username" }),
    publishingLimit: () => call(threadsUserId + "/threads_publishing_limit", { fields: "quota_usage,config" }),
    // topic_tag is omitted entirely when absent: call() stringifies every value, so an undefined
    // would be sent as the literal "undefined".
    createContainer: (metadata, videoUrl) => call(threadsUserId + "/threads", {
      media_type: "VIDEO", video_url: videoUrl, text: metadata.text,
      ...(metadata.topicTag ? { topic_tag: metadata.topicTag } : {}),
    }, "POST"),
    container: (id) => call(requireId(id), { fields: "status" }),
    publish: (id) => call(threadsUserId + "/threads_publish", { creation_id: requireId(id) }, "POST"),
    media: (id) => call(requireId(id), { fields: "id,permalink,media_type,timestamp,text,username" }),
    recent: () => call(threadsUserId + "/threads", { fields: "id,timestamp,text,media_type", limit: 5 }),
  };
}
async function ensureToken(runtime, settings, { now = Date.now(), fetchImpl = globalThis.fetch, autoRefresh = true } = {}) {
  let token = await readJson(runtime.threadsTokenPath, true);
  let status = tokenStatus(token, now);
  if (autoRefresh && status.needsRefresh && status.canRefresh) {
    const release = await acquireLock(path.join(runtime.runtimeRoot, "THREADS_AUTH.lock"));
    try {
      token = await readJson(runtime.threadsTokenPath);
      status = tokenStatus(token, now);
      if (status.needsRefresh && status.canRefresh) {
        token = await refreshToken(token, { now, fetchImpl });
        await writeJson(runtime.threadsTokenPath, token);
      }
    } finally { await release(); }
    status = tokenStatus(token, now);
  }
  const api = createThreadsApi({ token, threadsUserId: settings.threadsUserId, fetchImpl });
  const me = await api.me();
  if (String(me.id) !== String(settings.threadsUserId) || (settings.username && settings.username !== me.username)
    || (token.user_id && String(token.user_id) !== String(me.id))) throw fail("THREADS_ACCOUNT_MISMATCH");
  return { token, status, api, username: me.username };
}
async function checkLimit(api) {
  const row = (await api.publishingLimit()).data?.[0];
  const usage = Number(row?.quota_usage), total = Number(row?.config?.quota_total ?? 250);
  if (!Number.isFinite(usage) || !Number.isFinite(total) || usage < 0 || total <= 0) throw fail("THREADS_RESPONSE_INVALID");
  if (usage >= total) throw fail("THREADS_PUBLISHING_LIMIT");
  return total - usage;
}
async function pollContainer(api, id, { now = Date.now, sleepImpl = sleep, timeoutMs = 15 * 60000, onPoll = async () => {} } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const result = await api.container(id);
    await onPoll(result.status);
    if (result.status === "FINISHED") return result;
    if (["ERROR", "EXPIRED", "PUBLISHED"].includes(result.status)) throw fail("THREADS_CONTAINER_" + result.status);
    if (result.status !== "IN_PROGRESS") throw fail("THREADS_RESPONSE_INVALID");
    if (now() >= deadline) throw fail("THREADS_PROCESSING_TIMEOUT");
    await sleepImpl(Math.min(10000, deadline - now()));
  }
}
async function reconcilePublish(api, text, attemptedAt, now = Date.now()) {
  const start = Date.parse(attemptedAt);
  const candidates = ((await api.recent()).data ?? []).filter((m) => m.text === text && m.media_type === "VIDEO"
    && Date.parse(m.timestamp) >= start - 10000 && Date.parse(m.timestamp) <= Math.min(now, start + 10 * 60000));
  if (candidates.length !== 1) throw fail("THREADS_PUBLISH_UNKNOWN");
  return requireId(candidates[0].id);
}
function validThreadsUrl(value) {
  try { const u = new URL(value); return u.protocol === "https:" && ["www.threads.net", "threads.net", "www.threads.com", "threads.com"].includes(u.hostname)
    && !u.username && !u.password && /^\/@[^/]+\/post\/[^/]+\/?$/.test(u.pathname); }
  catch { return false; }
}
module.exports = { DAY, SCOPES, requireId, tokenStatus, normalizeToken, requestJson, exchangeCode, refreshToken, createThreadsApi, ensureToken, checkLimit, pollContainer, reconcilePublish, validThreadsUrl };
