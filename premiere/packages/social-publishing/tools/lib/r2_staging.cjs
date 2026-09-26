"use strict";

const { createReadStream } = require("node:fs");
const { createHash } = require("node:crypto");
const { Transform } = require("node:stream");
const { fail, hashFile } = require("./common.cjs");
const { SAFE_RUN_ID, sourceRunId } = require("./publish_run.cjs");
const MANAGED_KEY = /^social\/pub-([a-f0-9]{16})(?:-r(?:[2-9]|[1-9]\d{1,5}))?\/(?:threads\/)?\1\.mp4$/;
function stagingKey(runId, sha256, lane = "instagram") {
  if (!SAFE_RUN_ID.test(runId) || !/^[a-f0-9]{64}$/.test(sha256) || sourceRunId(runId) !== `pub-${sha256.slice(0, 16)}`) throw fail("VIDEO_SHA_MISMATCH");
  if (!["instagram", "threads"].includes(lane)) throw fail("R2_KEY_INVALID");
  return `social/${runId}/${lane === "threads" ? "threads/" : ""}${sha256.slice(0, 16)}.mp4`;
}
function expirySeconds(value = 21600) {
  if (!Number.isInteger(value) || value < 900 || value > 604800) throw fail("R2_SETTINGS_INVALID");
  return value;
}
function validateSettings(settings) {
  if (!/^[a-f0-9]{32}$/i.test(settings?.accountId ?? "") || !settings.accessKeyId || !settings.secretAccessKey
    || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(settings.bucket ?? "")) throw fail("R2_SETTINGS_INVALID");
  expirySeconds(settings.presignExpirySeconds);
  return settings;
}
function createR2Staging(settings, dependencies = {}) {
  validateSettings(settings);
  const sdk = dependencies.sdk ?? require("@aws-sdk/client-s3");
  const signer = dependencies.signer ?? require("@aws-sdk/s3-request-presigner").getSignedUrl;
  const client = dependencies.client ?? new sdk.S3Client({ region: "auto", endpoint: `https://${settings.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey }, maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
  const Bucket = settings.bucket;
  async function send(Command, input) {
    try { return await client.send(new Command({ Bucket, ...input })); }
    catch { throw fail("R2_UNREACHABLE"); }
  }
  async function verify(key, size) {
    if (!MANAGED_KEY.test(key)) throw fail("R2_KEY_INVALID");
    const head = await send(sdk.HeadObjectCommand, { Key: key });
    if (Number(head.ContentLength) !== size) throw fail("R2_SIZE_MISMATCH");
    return true;
  }
  async function unstage(key) {
    if (!MANAGED_KEY.test(key)) throw fail("R2_KEY_INVALID");
    await send(sdk.DeleteObjectCommand, { Key: key });
    try { await client.send(new sdk.HeadObjectCommand({ Bucket, Key: key })); }
    catch (error) { if (error.$metadata?.httpStatusCode === 404 || error.name === "NotFound") return true; throw fail("R2_UNREACHABLE"); }
    throw fail("R2_DELETE_UNVERIFIED");
  }
  return {
    headBucket: async () => { await send(sdk.HeadBucketCommand, {}); return true; },
    verify, unstage,
    async stage(filePath, runId, expectedSha256, lane = "instagram") {
      const source = await hashFile(filePath);
      if (expectedSha256 && source.sha256 !== expectedSha256) throw fail("VIDEO_SHA_MISMATCH");
      const key = stagingKey(runId, source.sha256, lane);
      const stream = createReadStream(filePath);
      const streamedHash = createHash("sha256");
      let streamedBytes = 0;
      const body = new Transform({ transform(chunk, _encoding, callback) { streamedHash.update(chunk); streamedBytes += chunk.length; callback(null, chunk); } });
      stream.on("error", (error) => body.destroy(error));
      stream.pipe(body);
      try { await send(sdk.PutObjectCommand, { Key: key, Body: body, ContentLength: source.size, ContentType: "video/mp4", Metadata: { sha256: source.sha256 } }); }
      finally { stream.destroy(); body.destroy(); }
      if (streamedBytes !== source.size || streamedHash.digest("hex") !== source.sha256) throw fail("VIDEO_SHA_MISMATCH");
      if ((await hashFile(filePath)).sha256 !== source.sha256) throw fail("VIDEO_SHA_MISMATCH");
      await verify(key, source.size);
      const expiresIn = expirySeconds(settings.presignExpirySeconds);
      let url;
      try { url = await signer(client, new sdk.GetObjectCommand({ Bucket, Key: key }), { expiresIn }); }
      catch { throw fail("R2_UNREACHABLE"); }
      // This signed URL is held in memory only and must never enter run files or stdout.
      return { key, url, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(), size: source.size };
    },
    async sweep(maxAgeHours = 24) {
      if (!Number.isFinite(maxAgeHours) || maxAgeHours < 24) throw fail("R2_SWEEP_AGE_INVALID");
      let cursor;
      const deleted = [];
      do {
        const result = await send(sdk.ListObjectsV2Command, { Prefix: "social/pub-", ...(cursor ? { ContinuationToken: cursor } : {}) });
        for (const item of result.Contents ?? []) {
          if (MANAGED_KEY.test(item.Key) && new Date(item.LastModified).getTime() < Date.now() - maxAgeHours * 3600000) {
            await unstage(item.Key); deleted.push(item.Key);
          }
        }
        cursor = result.IsTruncated ? result.NextContinuationToken : null;
        if (result.IsTruncated && !cursor) throw fail("R2_RESPONSE_INVALID");
      } while (cursor);
      return deleted;
    },
  };
}
module.exports = { MANAGED_KEY, stagingKey, expirySeconds, validateSettings, createR2Staging };
