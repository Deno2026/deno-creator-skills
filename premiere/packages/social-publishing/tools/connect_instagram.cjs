#!/usr/bin/env node
"use strict";

const http = require("node:http");
const https = require("node:https");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { fs, path, fail, readJson, writeJson, parseArgs, emit, cli } = require("./lib/common.cjs");
const { context } = require("./lib/runtime.cjs");
const { exchangeCode, exchangeLongToken, refreshToken, tokenStatus, createInstagramApi } = require("./lib/instagram_api.cjs");
const { acquireLock } = require("./lib/publish_run.cjs");
const { powershell, ps } = require("./lib/windows_task.cjs");

function authorizeUrl(settings, state) {
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.search = new URLSearchParams({ client_id: settings.appId, redirect_uri: settings.redirectUri, response_type: "code", scope: "instagram_business_basic,instagram_business_content_publish", state }).toString();
  return url.toString();
}
function validateAuthSettings(settings) {
  if (!/^\d+$/.test(settings?.appId ?? "") || typeof settings.appSecret !== "string" || !settings.appSecret) throw fail("INSTAGRAM_SETTINGS_INVALID");
  let redirect;
  try { redirect = new URL(settings.redirectUri); } catch { throw fail("INSTAGRAM_SETTINGS_INVALID"); }
  if (!["http:", "https:"].includes(redirect.protocol) || !["localhost", "127.0.0.1"].includes(redirect.hostname) || redirect.port !== "3400"
    || redirect.pathname !== "/oauth/instagram/callback" || redirect.search || redirect.hash || redirect.username || redirect.password) throw fail("INSTAGRAM_SETTINGS_INVALID");
  return redirect;
}
async function certificate(runtime, provider = "instagram") {
  if (!["instagram", "x"].includes(provider)) throw fail("CLI_INVALID");
  const certPath = path.join(runtime.runtimeRoot, provider + "-localhost.pfx");
  try { return await fs.readFile(certPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.mkdir(runtime.runtimeRoot, { recursive: true });
  // File-only certificate generation: no installation into a Windows certificate or trust store.
  await powershell([
    "$ErrorActionPreference = 'Stop'",
    "$rsa = New-Object Security.Cryptography.RSACng(2048)",
    "$request = New-Object Security.Cryptography.X509Certificates.CertificateRequest('CN=localhost', $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)",
    "$san = New-Object Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder",
    "$san.AddDnsName('localhost')", "$san.AddIpAddress([Net.IPAddress]::Loopback)", "$request.CertificateExtensions.Add($san.Build())",
    "$cert = $request.CreateSelfSigned([DateTimeOffset]::Now.AddMinutes(-5), [DateTimeOffset]::Now.AddDays(30))",
    `[IO.File]::WriteAllBytes(${ps(certPath)}, $cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx, ''))`,
    "$cert.Dispose()", "$rsa.Dispose()",
  ].join("\n"));
  return fs.readFile(certPath);
}
async function receiveCode(settings, runtime, timeoutMs = 5 * 60000) {
  const redirect = validateAuthSettings(settings);
  const state = randomBytes(32).toString("hex");
  const server = redirect.protocol === "https:" ? https.createServer({ pfx: await certificate(runtime), passphrase: "" }) : http.createServer();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, code) => {
      if (settled) return;
      settled = true; clearTimeout(timer); server.close(); server.closeAllConnections?.();
      if (error) reject(error); else resolve(code);
    };
    const timer = setTimeout(() => finish(fail("INSTAGRAM_OAUTH_TIMEOUT")), timeoutMs);
    server.on("error", () => finish(fail("INSTAGRAM_CALLBACK_FAILED")));
    server.on("request", (req, res) => {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      let url;
      try { url = new URL(req.url, settings.redirectUri); }
      catch { res.writeHead(400).end("Invalid request"); return; }
      if (req.method !== "GET" || url.pathname !== redirect.pathname) { res.writeHead(404).end("Not found"); return; }
      const received = Buffer.from(url.searchParams.get("state") ?? "");
      const expected = Buffer.from(state);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) { res.writeHead(400).end("Invalid OAuth state"); return; }
      if (url.searchParams.has("error")) { res.writeHead(400).end("Instagram connection denied"); finish(fail("INSTAGRAM_OAUTH_DENIED")); return; }
      const code = url.searchParams.get("code");
      if (!code) { res.writeHead(400).end("Missing authorization code"); return; }
      res.end("Authorization received. You can close this window.", () => finish(null, code));
    });
    server.listen(3400, "127.0.0.1", () => emit("INSTAGRAM_AUTHORIZE", { url: authorizeUrl(settings, state), expiresInSeconds: timeoutMs / 1000 }));
  });
}
async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ["--init", "--authorize", "--refresh", "--status", "--https", "--help"], values: ["--token-file"] });
  if (args["--help"]) { process.stdout.write("connect_instagram --init|--authorize [--https]|--refresh|--status|--token-file <path>\n"); return; }
  if (["--init", "--authorize", "--refresh", "--status", "--token-file"].filter((k) => args[k]).length !== 1 || (args["--https"] && !args["--authorize"])) throw fail("CLI_INVALID");
  const ctx = await context();
  const { runtime } = ctx;
  if (args["--init"]) {
    await fs.mkdir(runtime.runtimeRoot, { recursive: true });
    try { await fs.writeFile(runtime.instagramSettingsPath, `${JSON.stringify({ appId: "", appSecret: "", redirectUri: "http://localhost:3400/oauth/instagram/callback", igUserId: "", username: "" }, null, 2)}\n`, { flag: "wx", encoding: "utf8", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    emit("INSTAGRAM_SETTINGS_READY", { path: runtime.instagramSettingsPath }); return;
  }
  if (args["--status"]) {
    const status = tokenStatus(await readJson(runtime.instagramTokenPath, true));
    emit("INSTAGRAM_TOKEN_STATUS", { remainingDays: Math.floor(status.remainingDays) }); return;
  }
  const release = await acquireLock(path.join(runtime.runtimeRoot, "INSTAGRAM_AUTH.lock"));
  try {
    if (args["--refresh"]) {
      const token = await refreshToken(await readJson(runtime.instagramTokenPath));
      await writeJson(runtime.instagramTokenPath, token);
      emit("INSTAGRAM_TOKEN_STATUS", { remainingDays: Math.floor(tokenStatus(token).remainingDays) }); return;
    }
    const settings = await readJson(runtime.instagramSettingsPath);
    if (args["--https"]) settings.redirectUri = "https://localhost:3400/oauth/instagram/callback";
    validateAuthSettings(settings);
    let token;
    if (args["--token-file"]) {
      const input = path.resolve(args["--token-file"]);
      if ([runtime.instagramTokenPath, runtime.instagramSettingsPath, runtime.r2SettingsPath, runtime.settingsPath].some((p) => path.resolve(p).toLowerCase() === input.toLowerCase())) throw fail("INSTAGRAM_TOKEN_FILE_INVALID");
      const raw = (await fs.readFile(input, "utf8")).replace(/^\uFEFF/, "").trim();
      let shortToken = raw;
      if (raw.startsWith("{")) { try { shortToken = JSON.parse(raw).access_token; } catch { throw fail("INSTAGRAM_TOKEN_FILE_INVALID"); } }
      if (typeof shortToken !== "string" || !shortToken || /\s/.test(shortToken)) throw fail("INSTAGRAM_TOKEN_FILE_INVALID");
      token = await exchangeLongToken(shortToken, settings);
      // Consuming this explicitly supplied one-use token file includes removing that exact file.
      await fs.rm(input);
    } else token = await exchangeCode(await receiveCode(settings, runtime), settings);
    const api = createInstagramApi({ token, igUserId: token.user_id || settings.igUserId || "0", apiVersion: ctx.settings.instagram.apiVersion });
    const me = await api.me();
    if (!/^\d+$/.test(String(me.id)) || !me.username) throw fail("INSTAGRAM_RESPONSE_INVALID");
    if (settings.igUserId && String(settings.igUserId) !== String(me.id)) throw fail("INSTAGRAM_ACCOUNT_MISMATCH");
    settings.igUserId = String(me.id); settings.username = me.username; token.user_id = String(me.id);
    await writeJson(runtime.instagramTokenPath, token);
    await writeJson(runtime.instagramSettingsPath, settings);
    emit("INSTAGRAM_CONNECTED", { username: me.username, expiresAt: token.expires_at });
  } finally { await release(); }
}
if (require.main === module) cli(main);
module.exports = { authorizeUrl, validateAuthSettings, receiveCode, certificate };
