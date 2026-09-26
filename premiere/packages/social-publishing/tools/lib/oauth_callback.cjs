"use strict";

const http = require("node:http");
const https = require("node:https");
const { timingSafeEqual } = require("node:crypto");
const { fail } = require("./common.cjs");
function sameState(actual, expected) {
  const a = Buffer.from(actual ?? ""), b = Buffer.from(expected ?? "");
  return !!b.length && a.length === b.length && timingSafeEqual(a, b);
}
function redirectCode(value, redirectUri, state) {
  let actual, expected;
  try { actual = new URL(value); expected = new URL(redirectUri); } catch { throw fail("OAUTH_REDIRECT_INVALID"); }
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.username || actual.password
    || actual.searchParams.getAll("state").length !== 1 || !sameState(actual.searchParams.get("state"), state)) throw fail("OAUTH_STATE_INVALID");
  if (actual.searchParams.has("error")) throw fail("OAUTH_DENIED");
  if (actual.searchParams.getAll("code").length !== 1 || !actual.searchParams.get("code")) throw fail("OAUTH_CODE_MISSING");
  return actual.searchParams.get("code");
}
async function receiveRedirect(settings, state, { pfx, timeoutMs = 5 * 60000, onListening = () => {} } = {}) {
  const redirect = new URL(settings.redirectUri);
  if (!["127.0.0.1", "localhost"].includes(redirect.hostname) || !["http:", "https:"].includes(redirect.protocol)
    || redirect.port !== "3400" || redirect.pathname !== "/oauth/x/callback" || redirect.search || redirect.hash
    || redirect.username || redirect.password) throw fail("X_SETTINGS_INVALID");
  if (redirect.protocol === "https:" && !pfx) throw fail("X_CERTIFICATE_MISSING");
  const server = pfx ? https.createServer({ pfx, passphrase: "" }) : http.createServer();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, code) => {
      if (settled) return;
      settled = true; clearTimeout(timer); server.close(); server.closeAllConnections?.();
      if (error) reject(error); else resolve(code);
    };
    const timer = setTimeout(() => finish(fail("OAUTH_TIMEOUT")), timeoutMs);
    server.on("error", () => finish(fail("OAUTH_CALLBACK_FAILED")));
    server.on("request", (req, res) => {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
      if (req.method !== "GET") { res.writeHead(405).end("GET required"); return; }
      try {
        const url = new URL(req.url, settings.redirectUri);
        const code = redirectCode(url.toString(), settings.redirectUri, state);
        res.end("Authorization received. You can close this window.", () => finish(null, code));
      } catch (error) {
        res.writeHead(400).end("Invalid or denied authorization");
        if (error.code === "OAUTH_DENIED") finish(error);
      }
    });
    server.listen(3400, "127.0.0.1", onListening);
  });
}
async function readRedirectInput(input = process.stdin) {
  process.stderr.write("리다이렉트된 전체 주소를 붙여 넣으세요 (저장·출력하지 않음):\n");
  const readline = require("node:readline").createInterface({ input, terminal: false });
  try {
    for await (const line of readline) {
      if (line.length > 16384) throw fail("OAUTH_REDIRECT_INVALID");
      if (line.trim()) return line.trim();
    }
    throw fail("OAUTH_CODE_MISSING");
  } finally { readline.close(); }
}
module.exports = { sameState, redirectCode, receiveRedirect, readRedirectInput };
