#!/usr/bin/env node

const path = require("node:path");
const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");

const { getUploadRuntimePaths } = require("@deno/runtime-paths");

const REQUESTS_ROOT = getUploadRuntimePaths().uploadRequestsRoot;
const SAFE_REQUEST_ID = /^[a-zA-Z0-9._-]{1,180}$/;
const METHODS = new Set([
  "user_confirmed_exact_helper_files",
  "user_confirmed_unlisted_youtube_playback",
  "agent_verified_unlisted_youtube_playback",
  // Legacy completed requests remain verifiable after the default changed.
  "user_confirmed_private_youtube_playback",
  "agent_verified_private_youtube_playback",
]);

function parseArgs(argv) {
  const args = { requestId: "", method: "", confirmedAt: "", userExplicitApproval: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--request-id") args.requestId = argv[++index] ?? "";
    else if (arg === "--method") args.method = argv[++index] ?? "";
    else if (arg === "--confirmed-at") args.confirmedAt = argv[++index] ?? "";
    else if (arg === "--user-explicit-approval") args.userExplicitApproval = true;
  }
  if (!SAFE_REQUEST_ID.test(args.requestId)) throw new Error("A valid --request-id is required");
  if (!METHODS.has(args.method)) throw new Error("A supported --method is required");
  if (!args.userExplicitApproval) {
    throw new Error("--user-explicit-approval is required and may be used only after explicit user sync confirmation");
  }
  if (args.confirmedAt && !Number.isFinite(Date.parse(args.confirmedAt))) {
    throw new Error("--confirmed-at must be an ISO-8601 timestamp");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const requestDir = path.resolve(REQUESTS_ROOT, args.requestId);
  if (path.dirname(requestDir) !== path.resolve(REQUESTS_ROOT)) {
    throw new Error("Request path escapes the fixed upload-requests root");
  }
  const manifestPath = path.join(requestDir, "upload_request.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.requestId !== args.requestId || manifest.source !== "youtube-upload-helper") {
    throw new Error("Request manifest identity is invalid");
  }
  const videoSha256 = String(manifest.files?.video?.sha256 ?? "").toLowerCase();
  const captionRevisionId = String(manifest.captionAuthority?.revisionId ?? "");
  const cleanKoreanSha256 = String(
    manifest.captionAuthority?.cleanKorean?.lockedSha256 ?? "",
  ).toLowerCase();
  const sourceFingerprint = String(manifest.sourceOfTruth?.sourceFingerprint ?? "");
  if (!videoSha256 || !captionRevisionId || !cleanKoreanSha256 || !sourceFingerprint) {
    throw new Error("Request is missing exact video/caption/fingerprint authority");
  }
  const videoId = manifest.execution?.videoId ?? null;
  if (args.method !== "user_confirmed_exact_helper_files" && !videoId) {
    throw new Error("YouTube playback approval requires an uploaded videoId");
  }
  const approval = {
    schemaVersion: 1,
    authority: "explicit_user_sync_confirmation_bound_to_exact_helper_files",
    requestId: args.requestId,
    sourceFingerprint,
    videoSha256,
    captionRevisionId,
    cleanKoreanSha256,
    videoId,
    method: args.method,
    userExplicitApproval: true,
    confirmedAt: args.confirmedAt || new Date().toISOString(),
    recordedAt: new Date().toISOString(),
  };
  const outputPath = path.join(requestDir, "playback_sync_approval.json");
  const tempPath = `${outputPath}.tmp`;
  await mkdir(requestDir, { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(approval, null, 2)}\n`, "utf8");
  await rename(tempPath, outputPath);
  process.stdout.write(
    `PLAYBACK_SYNC_APPROVAL_RECORDED request=${args.requestId} method=${args.method} video=${videoId ?? "preupload_exact_files"}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`PLAYBACK_SYNC_APPROVAL_FAILED ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs };
