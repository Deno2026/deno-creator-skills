"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const tls = require("node:tls");
const { authorizeUrl, validateAuthSettings, certificate } = require("../tools/connect_instagram.cjs");
const { fixture } = require("./fixtures.cjs");
test("authorization URL requests only the required scopes and no secret", () => {
  const settings = { appId: "123", appSecret: "secret-value", redirectUri: "http://localhost:3400/oauth/instagram/callback" };
  const url = new URL(authorizeUrl(settings, "nonce"));
  assert.equal(url.origin, "https://www.instagram.com");
  assert.equal(url.searchParams.get("scope"), "instagram_business_basic,instagram_business_content_publish");
  assert.equal(url.searchParams.get("state"), "nonce"); assert.ok(!url.href.includes("secret-value"));
  assert.equal(validateAuthSettings(settings).hostname, "localhost");
  for (const redirectUri of ["http://0.0.0.0:3400/oauth/instagram/callback", "https://external.example/oauth/instagram/callback", "http://localhost:3400/other"]) {
    assert.throws(() => validateAuthSettings({ ...settings, redirectUri }), { code: "INSTAGRAM_SETTINGS_INVALID" });
  }
});
test("HTTPS fallback creates a usable file-only PFX in an isolated runtime", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t, ["instagram"]);
  const pfx = await certificate(f.ctx.runtime);
  assert.ok(pfx.length > 1000);
  assert.doesNotThrow(() => tls.createSecureContext({ pfx, passphrase: "" }));
  assert.deepEqual(await certificate(f.ctx.runtime), pfx);
});
