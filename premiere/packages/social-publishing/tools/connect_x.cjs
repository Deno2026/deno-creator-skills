#!/usr/bin/env node
"use strict";

const { randomBytes, createHash } = require("node:crypto");
const { fs, path, fail, readJson, writeJson, parseArgs, emit, cli } = require("./lib/common.cjs");
const { context } = require("./lib/runtime.cjs");
const { acquireLock } = require("./lib/publish_run.cjs");
const { SCOPES, normalizeToken, serializeToken, tokenStatus, exchangeCode, refreshToken, createXApi, requireId } = require("./lib/x_api.cjs");
const { receiveRedirect } = require("./lib/oauth_callback.cjs");
const { certificate } = require("./connect_instagram.cjs");
function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"), state: randomBytes(32).toString("hex") };
}
function validateSettings(settings) {
  if (typeof settings?.clientId !== "string" || !settings.clientId) throw fail("X_SETTINGS_INVALID");
  if (!["http://127.0.0.1:3400/oauth/x/callback", "https://localhost:3400/oauth/x/callback"].includes(settings.redirectUri)) throw fail("X_SETTINGS_INVALID");
}
function authorizeUrl(settings, proof) {
  validateSettings(settings);
  const url = new URL("https://x.com/i/oauth2/authorize");
  url.search = new URLSearchParams({ response_type: "code", client_id: settings.clientId, redirect_uri: settings.redirectUri, scope: SCOPES.join(" "),
    state: proof.state, code_challenge: proof.challenge, code_challenge_method: "S256" }).toString();
  return url.toString();
}
async function saveConnection(token, settings, runtime, options = {}) {
  const api = createXApi({ token, fetchImpl: options.fetchImpl });
  const me = await api.me();
  requireId(me?.id);
  if (!me.username || (settings.userId && String(settings.userId) !== String(me.id))
    || (settings.username && settings.username.toLowerCase() !== me.username.toLowerCase())) throw fail("X_ACCOUNT_MISMATCH");
  token.userId = String(me.id); token.username = me.username;
  await writeJson(runtime.xTokenPath, serializeToken(token, await readJson(runtime.xTokenPath, true) ?? {}));
  await writeJson(runtime.xSettingsPath, { ...settings, userId: String(me.id), username: me.username });
  return { username: me.username, expiresAt: token.expiresAt };
}
async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ["--init", "--authorize", "--https", "--refresh", "--status", "--help"], values: ["--token-file"] });
  if (args["--help"]) { process.stdout.write("connect_x --init|--status|--refresh|--token-file <token.json>|--authorize [--https]\n"); return; }
  if (["--init", "--authorize", "--refresh", "--status", "--token-file"].filter((k) => args[k]).length !== 1 || (args["--https"] && !args["--authorize"])) throw fail("CLI_INVALID");
  const { runtime } = await context();
  if (args["--init"]) {
    await fs.mkdir(runtime.runtimeRoot, { recursive: true });
    try { await fs.copyFile(path.join(__dirname, "../templates/x-settings.example.json"), runtime.xSettingsPath, require("node:fs").constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    emit("X_SETTINGS_READY", { path: runtime.xSettingsPath }); return;
  }
  if (args["--status"]) { emit("X_TOKEN_STATUS", tokenStatus(await readJson(runtime.xTokenPath, true))); return; }
  const release = await acquireLock(path.join(runtime.runtimeRoot, "X_AUTH.lock"));
  try {
    const settings = await readJson(runtime.xSettingsPath);
    if (args["--refresh"]) {
      const previous = await readJson(runtime.xTokenPath);
      const token = await refreshToken(previous, settings);
      await writeJson(runtime.xTokenPath, serializeToken(token, previous)); emit("X_TOKEN_STATUS", tokenStatus(token)); return;
    }
    let token;
    if (args["--token-file"]) {
      token = normalizeToken(await readJson(path.resolve(args["--token-file"])));
      if (tokenStatus(token).expired) token = await refreshToken(token, settings);
    } else {
      const authSettings = { ...settings, redirectUri: args["--https"] ? settings.redirectUriHttps : settings.redirectUri };
      validateSettings(authSettings);
      const proof = pkce();
      const code = await receiveRedirect(authSettings, proof.state, {
        pfx: args["--https"] ? await certificate(runtime, "x") : undefined,
        onListening: () => emit("X_AUTHORIZE", { url: authorizeUrl(authSettings, proof), expiresInSeconds: 300 }),
      });
      token = await exchangeCode(code, proof.verifier, authSettings);
    }
    emit("X_CONNECTED", await saveConnection(token, settings, runtime));
  } finally { await release(); }
}
if (require.main === module) cli(main);
module.exports = { pkce, validateSettings, authorizeUrl, saveConnection, main };
