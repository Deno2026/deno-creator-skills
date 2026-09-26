#!/usr/bin/env node
"use strict";

const { randomBytes } = require("node:crypto");
const { fs, path, fail, readJson, writeJson, parseArgs, emit, cli } = require("./lib/common.cjs");
const { context } = require("./lib/runtime.cjs");
const { acquireLock } = require("./lib/publish_run.cjs");
const { SCOPES, DAY, tokenStatus, exchangeCode, refreshToken, createThreadsApi, requireId } = require("./lib/threads_api.cjs");
const { redirectCode, readRedirectInput } = require("./lib/oauth_callback.cjs");
function validateSettings(settings) {
  let redirect;
  try { redirect = new URL(settings?.redirectUri); } catch { throw fail("THREADS_SETTINGS_INVALID"); }
  if (!/^\d+$/.test(settings.appId) || !settings.appSecret || redirect.protocol !== "https:"
    || ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname) || redirect.search || redirect.hash || redirect.username || redirect.password) throw fail("THREADS_SETTINGS_INVALID");
}
function authorizeUrl(settings, state) {
  validateSettings(settings);
  const url = new URL("https://threads.net/oauth/authorize");
  url.search = new URLSearchParams({ client_id: settings.appId, redirect_uri: settings.redirectUri, scope: SCOPES.join(","), response_type: "code", state }).toString();
  return url.toString();
}
function importedToken(raw, now = Date.now()) {
  const value = typeof raw === "string" ? { access_token: raw } : { ...raw };
  if (typeof value.access_token !== "string" || !value.access_token || /\s/.test(value.access_token)) throw fail("THREADS_TOKEN_INVALID");
  const obtained = value.obtained_at ?? new Date(now).toISOString();
  const expiry = value.expires_at ?? new Date(Date.parse(obtained) + (Number(value.expires_in) > 0 ? Number(value.expires_in) * 1000 : 60 * DAY)).toISOString();
  const token = { ...value, token_type: value.token_type ?? "bearer", obtained_at: obtained, refreshed_at: value.refreshed_at ?? obtained, expires_at: expiry,
    source: value.source ?? "dashboard_long_lived_token", scope: value.scope ?? SCOPES };
  if (!value.expires_at && !value.expires_in) token.note = value.note ?? "Expiry estimated as 60 days from declared issuance; the dashboard token must be long-lived.";
  tokenStatus(token, now);
  return token;
}
async function saveConnection(token, settings, runtime, options = {}) {
  const api = createThreadsApi({ token, threadsUserId: settings.threadsUserId || token.user_id || "0", fetchImpl: options.fetchImpl });
  const me = await api.me();
  requireId(me.id);
  if (!me.username || (settings.threadsUserId && String(settings.threadsUserId) !== String(me.id))
    || (settings.username && settings.username !== me.username) || (token.user_id && String(token.user_id) !== String(me.id))) throw fail("THREADS_ACCOUNT_MISMATCH");
  token.user_id = String(me.id); token.username = me.username;
  await writeJson(runtime.threadsTokenPath, token);
  await writeJson(runtime.threadsSettingsPath, { ...settings, threadsUserId: String(me.id), username: me.username });
  return { username: me.username, expiresAt: token.expires_at };
}
async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ["--init", "--authorize", "--paste-redirect", "--refresh", "--status", "--help"], values: ["--token-file"] });
  if (args["--help"]) { process.stdout.write("connect_threads --init|--status|--refresh|--token-file <long-token-file>|--authorize [--paste-redirect]|--paste-redirect\n"); return; }
  const modes = ["--init", "--authorize", "--refresh", "--status", "--token-file"].filter((k) => args[k]);
  if (modes.length > 1 || (!modes.length && !args["--paste-redirect"]) || (args["--paste-redirect"] && modes.length && !args["--authorize"])) throw fail("CLI_INVALID");
  const { runtime } = await context();
  if (args["--init"]) {
    await fs.mkdir(runtime.runtimeRoot, { recursive: true });
    try { await fs.copyFile(path.join(__dirname, "../templates/threads-settings.example.json"), runtime.threadsSettingsPath, require("node:fs").constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    emit("THREADS_SETTINGS_READY", { path: runtime.threadsSettingsPath }); return;
  }
  if (args["--status"]) { emit("THREADS_TOKEN_STATUS", tokenStatus(await readJson(runtime.threadsTokenPath, true))); return; }
  const release = await acquireLock(path.join(runtime.runtimeRoot, "THREADS_AUTH.lock"));
  try {
    if (args["--refresh"]) {
      const token = await refreshToken(await readJson(runtime.threadsTokenPath));
      await writeJson(runtime.threadsTokenPath, token);
      emit("THREADS_TOKEN_STATUS", tokenStatus(token)); return;
    }
    const settings = await readJson(runtime.threadsSettingsPath);
    let token;
    if (args["--token-file"]) {
      const raw = (await fs.readFile(path.resolve(args["--token-file"]), "utf8")).replace(/^\uFEFF/, "").trim();
      try { token = importedToken(raw.startsWith("{") ? JSON.parse(raw) : raw); } catch { throw fail("THREADS_TOKEN_INVALID"); }
    } else {
      validateSettings(settings);
      const pendingPath = path.join(runtime.runtimeRoot, "threads-oauth-pending.json");
      if (args["--authorize"]) {
        const pending = { state: randomBytes(32).toString("hex"), redirectUri: settings.redirectUri, appId: settings.appId, expiresAt: Date.now() + 10 * 60000 };
        await writeJson(pendingPath, pending);
        emit("THREADS_AUTHORIZE", { url: authorizeUrl(settings, pending.state), next: "--paste-redirect" });
        if (!args["--paste-redirect"]) return;
      }
      const pending = await readJson(pendingPath);
      if (pending.expiresAt <= Date.now() || pending.redirectUri !== settings.redirectUri || pending.appId !== settings.appId) throw fail("OAUTH_STATE_INVALID");
      const pasted = await readRedirectInput();
      if (pending.expiresAt <= Date.now()) throw fail("OAUTH_STATE_INVALID");
      const code = redirectCode(pasted, settings.redirectUri, pending.state);
      await fs.rm(pendingPath);
      token = await exchangeCode(code, settings);
    }
    emit("THREADS_CONNECTED", await saveConnection(token, settings, runtime));
  } finally { await release(); }
}
if (require.main === module) cli(main);
module.exports = { authorizeUrl, validateSettings, importedToken, saveConnection, main };
