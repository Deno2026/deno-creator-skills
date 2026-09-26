#!/usr/bin/env node

const path = require("node:path");
const { readFile, rename, writeFile } = require("node:fs/promises");
const { getUploadRuntimePaths } = require("@deno/runtime-paths");
const { validateStudioPublicationGate } = require("./lib/youtube_publication_gate.cjs");

function parseArgs(argv) {
  const args = {
    requestId: "",
    videoId: "",
    durationSeconds: 0,
    monetizationEnabled: false,
    midrollEnabled: false,
    paidPromotionChecked: false,
    saved: false,
    userPublicApproval: false,
    audiencePromisesFulfilled: false,
    audiencePromiseLocations: [],
  };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--request-id") args.requestId = argv[++index] ?? "";
    else if (token === "--video-id") args.videoId = argv[++index] ?? "";
    else if (token === "--duration-seconds") args.durationSeconds = Number(argv[++index]);
    else if (token === "--monetization-enabled") args.monetizationEnabled = true;
    else if (token === "--midroll-enabled") args.midrollEnabled = true;
    else if (token === "--paid-promotion-checked") args.paidPromotionChecked = true;
    else if (token === "--saved") args.saved = true;
    else if (token === "--user-public-approval") args.userPublicApproval = true;
    else if (token === "--audience-promises-fulfilled") args.audiencePromisesFulfilled = true;
    else if (token === "--audience-promise-location") {
      args.audiencePromiseLocations.push(argv[++index] ?? "");
    }
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!args.requestId) throw new Error("--request-id is required");
  if (!args.videoId) throw new Error("--video-id is required");
  if (!Number.isFinite(args.durationSeconds) || args.durationSeconds <= 0) {
    throw new Error("--duration-seconds must be positive");
  }
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

async function main() {
  const args = parseArgs(process.argv);
  const runtimePaths = getUploadRuntimePaths();
  const { metadataConsistencyWarnings } = require("./lib/helper_ready_gate.cjs");
  const requestDir = path.join(runtimePaths.uploadRequestsRoot, args.requestId);
  const manifest = await readJson(path.join(requestDir, "upload_request.json"));
  const cleanKoreanPath = path.resolve(
    requestDir,
    manifest.captionAuthority?.cleanKorean?.requestPath ?? "subtitles/ko/ko.srt",
  );
  const cleanKoreanRaw = manifest.captionPolicy?.mode === "none"
    ? ""
    : await readFile(cleanKoreanPath, "utf8");
  const audiencePromiseWarnings = metadataConsistencyWarnings(
    manifest.metadata?.description,
    cleanKoreanRaw,
  ).filter((warning) => warning.code === "AUDIENCE_PROMISE_FULFILLMENT_REQUIRED");
  const gate = {
    schemaVersion: 1,
    source: "youtube_studio_live_read",
    observedAt: new Date().toISOString(),
    requestId: args.requestId,
    sourceFingerprint: manifest.sourceOfTruth?.sourceFingerprint ?? null,
    videoId: args.videoId,
    durationSeconds: args.durationSeconds,
    saveState: args.saved ? "saved" : "unsaved",
    monetization: {
      enabled: args.monetizationEnabled,
      midrollEnabled: args.midrollEnabled,
    },
    paidPromotion: {
      checked: args.paidPromotionChecked,
    },
    audiencePromises: {
      required: audiencePromiseWarnings.length > 0,
      fulfilled: args.audiencePromisesFulfilled,
      verifiedLocations: args.audiencePromiseLocations.filter(Boolean),
      detectedCommitments: audiencePromiseWarnings.flatMap(
        (warning) => warning.commitments ?? [],
      ),
    },
    publicApproval: {
      approved: args.userPublicApproval,
      authority: args.userPublicApproval ? "user_explicit_chat_confirmation" : null,
    },
  };
  const validation = validateStudioPublicationGate({
    gate,
    manifest,
    videoId: args.videoId,
    durationSeconds: args.durationSeconds,
    audiencePromiseRequired: audiencePromiseWarnings.length > 0,
  });
  const outputPath = path.join(requestDir, "youtube_studio_publication_gate.json");
  await writeJsonAtomic(outputPath, { ...gate, validation });
  process.stdout.write(`YOUTUBE_STUDIO_PUBLICATION_GATE_READY ${outputPath}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs };
