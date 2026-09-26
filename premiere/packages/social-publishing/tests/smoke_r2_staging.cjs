"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const sdk = require("@aws-sdk/client-s3");
const { stagingKey, expirySeconds, createR2Staging } = require("../tools/lib/r2_staging.cjs");
const { fixture } = require("./fixtures.cjs");
const settings = { accountId: "a".repeat(32), accessKeyId: "access", secretAccessKey: "secret", bucket: "deno-test" };
test("only the source-owned R2 key and 7-day expiry window are allowed", () => {
  assert.equal(stagingKey("pub-0123456789abcdef", "0123456789abcdef" + "a".repeat(48)), "social/pub-0123456789abcdef/0123456789abcdef.mp4");
  assert.throws(() => stagingKey("pub-0123456789abcdef", "b".repeat(64)), { code: "VIDEO_SHA_MISMATCH" });
  assert.equal(expirySeconds(), 21600); assert.equal(expirySeconds(604800), 604800);
  for (const value of [0, 899, 604801, "21600"]) assert.throws(() => expirySeconds(value), { code: "R2_SETTINGS_INVALID" });
});
test("stage validates uploaded size, signs GET, and unstage verifies absence", async (t) => {
  const f = await fixture(t, ["instagram"]); const calls = []; let deleted = false;
  const client = { send: async (command) => {
    calls.push(command);
    if (command instanceof sdk.PutObjectCommand) { for await (const chunk of command.input.Body) assert.ok(chunk.length); }
    if (command instanceof sdk.DeleteObjectCommand) deleted = true;
    if (command instanceof sdk.HeadObjectCommand) { if (deleted) throw Object.assign(new Error(), { $metadata: { httpStatusCode: 404 } }); return { ContentLength: f.source.size }; }
    return {};
  } };
  const r2 = createR2Staging(settings, { client, signer: async (_client, command, options) => { assert.ok(command instanceof sdk.GetObjectCommand); assert.equal(options.expiresIn, 21600); return "https://signed-secret.example"; } });
  await r2.headBucket();
  const staged = await r2.stage(f.source.path, f.state.runId, f.source.sha256);
  assert.equal(staged.url, "https://signed-secret.example");
  assert.equal(calls.find((c) => c instanceof sdk.PutObjectCommand).input.ContentType, "video/mp4");
  assert.equal(await r2.unstage(staged.key), true);
  await assert.rejects(r2.unstage("unrelated/user-object"), { code: "R2_KEY_INVALID" });
});
test("sweep deletes only owned keys at least 24 hours old", async () => {
  const owned = "social/pub-aaaaaaaaaaaaaaaa/aaaaaaaaaaaaaaaa.mp4";
  const deleted = [];
  const r2 = createR2Staging(settings, { client: { send: async (command) => {
    if (command instanceof sdk.ListObjectsV2Command) return { Contents: [
      { Key: owned, LastModified: new Date(0) }, { Key: "user/data.mp4", LastModified: new Date(0) },
      { Key: "social/pub-bbbbbbbbbbbbbbbb/bbbbbbbbbbbbbbbb.mp4", LastModified: new Date() },
    ] };
    if (command instanceof sdk.DeleteObjectCommand) deleted.push(command.input.Key);
    if (command instanceof sdk.HeadObjectCommand) throw Object.assign(new Error(), { name: "NotFound" });
    return {};
  } } });
  assert.deepEqual(await r2.sweep(), [owned]); assert.deepEqual(deleted, [owned]);
  await assert.rejects(r2.sweep(1), { code: "R2_SWEEP_AGE_INVALID" });
});
