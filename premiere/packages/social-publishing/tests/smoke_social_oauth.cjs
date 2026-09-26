"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { pkce, authorizeUrl, saveConnection } = require("../tools/connect_x.cjs");
const { redirectCode, sameState, receiveRedirect } = require("../tools/lib/oauth_callback.cjs");
const { SCOPES } = require("../tools/lib/x_api.cjs");
const { fs, path, readJson, writeJson, execFileAsync } = require("../tools/lib/common.cjs");
const { fixture, NOW } = require("./fixtures.cjs");

test("X PKCE uses S256, random state, exact callbacks and no secret in authorize URL", () => {
  const proof = pkce(); assert.equal(proof.challenge, createHash("sha256").update(proof.verifier).digest("base64url"));
  assert.notEqual(proof.state, pkce().state);
  const settings = { clientId: "client", clientSecret: "secret", redirectUri: "http://127.0.0.1:3400/oauth/x/callback" };
  const url = new URL(authorizeUrl(settings, proof));
  assert.equal(url.searchParams.get("scope"), SCOPES.join(" ")); assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(!url.href.includes(proof.verifier) && !url.href.includes("secret"));
  assert.throws(() => authorizeUrl({ ...settings, redirectUri: "http://localhost:3400/oauth/x/callback" }, proof), { code: "X_SETTINGS_INVALID" });
});
test("pasted callbacks bind origin, path and single state; denial never returns a code", () => {
  const redirect = "https://example.com/oauth/threads/callback";
  assert.equal(redirectCode(redirect + "?state=ok&code=secret#_", redirect, "ok"), "secret");
  for (const url of [redirect + "?state=bad&code=secret", redirect + "?state=ok&state=ok&code=secret", redirect.replace("example", "evil") + "?state=ok&code=secret"]) {
    assert.throws(() => redirectCode(url, redirect, "ok"), { code: "OAUTH_STATE_INVALID" });
  }
  assert.throws(() => redirectCode(redirect + "?state=ok&error=access_denied", redirect, "ok"), { code: "OAUTH_DENIED" });
  assert.equal(sameState("", ""), false);
});
test("X imported token connects to verified expected account and never overwrites on mismatch", async (t) => {
  const f = await fixture(t, ["x"]), token = { accessToken: "secret", refreshToken: "refresh", expiresAt: "2030-01-02T00:00:00Z", scope: SCOPES.join(" ") };
  const settings = { clientId: "id", userId: "42", username: "test" };
  await assert.rejects(saveConnection(token, settings, f.ctx.runtime, { fetchImpl: async () => new Response('{"data":{"id":"43","username":"wrong"}}') }), { code: "X_ACCOUNT_MISMATCH" });
  assert.equal(await readJson(f.ctx.runtime.xTokenPath, true), null);
  await saveConnection(token, settings, f.ctx.runtime, { fetchImpl: async () => new Response('{"data":{"id":"42","username":"test"}}') });
  assert.equal((await readJson(f.ctx.runtime.xSettingsPath)).userId, "42");
});
test("connection CLIs use isolated runtime, preserve existing settings and never print tokens", async (t) => {
  const f = await fixture(t, ["threads", "x"]);
  for (const name of ["threads", "x"]) {
    const entry = path.join(f.ctx.productionRoot, "packages/social-publishing/tools/connect_" + name + ".cjs");
    const settingsPath = f.ctx.runtime[name + "SettingsPath"];
    await execFileAsync(process.execPath, [entry, "--init"], { env: f.ctx.env, windowsHide: true });
    const settings = await readJson(settingsPath); settings.preserve = true; await writeJson(settingsPath, settings);
    await execFileAsync(process.execPath, [entry, "--init"], { env: f.ctx.env, windowsHide: true });
    assert.equal((await readJson(settingsPath)).preserve, true);
    const token = name === "threads" ? { access_token: "DO-NOT-PRINT", obtained_at: new Date(Date.now() - 86400000).toISOString(), refreshed_at: null, expires_at: new Date(Date.now() + 86400000).toISOString() }
      : { accessToken: "DO-NOT-PRINT", refreshToken: "SECRET", expiresAt: new Date(Date.now() + 86400000).toISOString(), scope: SCOPES.join(" ") };
    await writeJson(f.ctx.runtime[name + "TokenPath"], token);
    const result = await execFileAsync(process.execPath, [entry, "--status"], { env: f.ctx.env, windowsHide: true });
    assert.match(result.stdout, /TOKEN_STATUS/); assert.ok(!result.stdout.includes("DO-NOT-PRINT") && !result.stderr.includes("SECRET"));
  }
});
test("X loopback callback rejects forged state and accepts the exact authenticated redirect", async () => {
  const settings = { redirectUri: "http://127.0.0.1:3400/oauth/x/callback" };
  let ready;
  const listening = new Promise((resolve) => { ready = resolve; });
  const pending = receiveRedirect(settings, "test-state", { timeoutMs: 3000, onListening: ready });
  // The listener is local, bounded, and sends no request to an account or provider.
  await Promise.race([listening, pending]);
  const invalid = await fetch(settings.redirectUri + "?state=forged&code=bad");
  assert.equal(invalid.status, 400);
  const good = await fetch(settings.redirectUri + "?state=test-state&code=local-code");
  assert.equal(good.status, 200); assert.equal(await pending, "local-code");
});
