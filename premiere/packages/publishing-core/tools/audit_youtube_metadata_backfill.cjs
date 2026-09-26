#!/usr/bin/env node

const path = require("node:path");
const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");

const { getUploadRuntimePaths } = require("@deno/runtime-paths");

const RUNTIME_PATHS = getUploadRuntimePaths();
const CANDIDATE_INVENTORY_PATH = path.join(
  RUNTIME_PATHS.metadataBackfillRoot,
  "candidate_inventory.json",
);
const { google } = require("googleapis");
const { resolveUploadChannel } = require("@deno/runtime-paths");
const { assertYouTubeChannel } = require("./lib/youtube_channel.cjs");

function parseArgs(argv) {
  const args = { videoId: "", packageDir: "" };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--video-id") args.videoId = argv[++index] ?? "";
    else if (argv[index] === "--package-dir") args.packageDir = argv[++index] ?? "";
  }
  if (!args.videoId) throw new Error("--video-id is required");
  if (!args.packageDir) throw new Error("--package-dir is required");
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function normalizeLanguage(language) {
  const aliases = {
    iw: "he",
    he: "he",
    "zh-CN": "zh-Hans",
    "zh-Hans": "zh-Hans",
    "zh-TW": "zh-Hant",
    "zh-Hant": "zh-Hant",
    pt: "pt-BR",
    "pt-BR": "pt-BR",
  };
  return aliases[language] ?? language;
}

function findInventoryRow(inventory, videoId) {
  const collections = [
    "pendingVideos",
    "completedVideos",
    "excludedUserVideos",
    "deferredActiveJobVideos",
    "excludedShortVideos",
    "excludedLiveVideos",
    "excludedUnknownShortRiskVideos",
  ];
  for (const collection of collections) {
    const row = (inventory?.[collection] ?? []).find((entry) => entry.videoId === videoId);
    if (row) return { collection, row };
  }
  return null;
}

function assertInventoryBackfillEligibility(inventory, videoId) {
  if (inventory?.schemaVersion !== 5) {
    throw new Error("candidate_inventory.json schemaVersion 5 is required before metadata backfill audit");
  }
  const found = findInventoryRow(inventory, videoId);
  if (!found) throw new Error(`Video ${videoId} is absent from candidate_inventory.json`);
  const { collection, row } = found;
  if (
    collection !== "pendingVideos"
    || row.contentType !== "video"
    || row.policyBucket !== "eligible_video"
    || row.isShort !== false
    || row.eligibleForBackfill !== true
  ) {
    throw new Error(
      `Video ${videoId} is not an eligible pending standard video: collection=${collection} contentType=${row.contentType} policyBucket=${row.policyBucket}`,
    );
  }
  return row;
}

async function saveRefreshedToken(tokenPath, token) {
  const existing = await readJson(tokenPath);
  await writeJsonAtomic(tokenPath, {
    ...existing,
    ...token,
    refresh_token: token.refresh_token ?? existing.refresh_token,
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const packageDir = path.resolve(args.packageDir);
  const settingsPath = RUNTIME_PATHS.settingsPath;
  const tokenPath = RUNTIME_PATHS.oauthTokenPath;
  const [settings, token, inventory] = await Promise.all([
    readJson(settingsPath),
    readJson(tokenPath),
    readJson(CANDIDATE_INVENTORY_PATH),
  ]);
  const inventoryRow = assertInventoryBackfillEligibility(inventory, args.videoId);
  const oauth = new google.auth.OAuth2(settings.clientId, settings.clientSecret, settings.redirectUri);
  oauth.setCredentials(token);
  oauth.on("tokens", (refreshed) => {
    void saveRefreshedToken(tokenPath, refreshed).catch((error) => {
      process.stderr.write(`TOKEN_SAVE_WARNING ${error.message}\n`);
    });
  });
  const youtube = google.youtube({ version: "v3", auth: oauth });
  // 메타데이터 일괄 정리는 DENO 강의 채널 전용이다(설명 규칙이 DENO 형식). 토큰이 그 채널인지 먼저 확인한다.
  await assertYouTubeChannel(youtube, resolveUploadChannel());

  const [videoResponse, captionResponse, languageResponse] = await Promise.all([
    youtube.videos.list({
      part: ["snippet", "status", "localizations", "contentDetails", "processingDetails"],
      id: [args.videoId],
    }),
    youtube.captions.list({ part: ["id", "snippet"], videoId: args.videoId }),
    youtube.i18nLanguages.list({ part: ["snippet"], hl: "en" }),
  ]);
  const video = videoResponse.data.items?.[0];
  if (!video) throw new Error(`Video not found: ${args.videoId}`);

  const defaultLanguage = video.snippet?.defaultLanguage ?? "ko";
  const supportedLanguages = (languageResponse.data.items ?? [])
    .map((item) => item.id)
    .filter((language) => language && language !== defaultLanguage);
  const rawLocalizations = video.localizations ?? {};
  const coveredLanguages = new Set(Object.keys(rawLocalizations).map(normalizeLanguage));
  const missingLanguages = supportedLanguages.filter(
    (language) => !coveredLanguages.has(normalizeLanguage(language)),
  );
  const captions = (captionResponse.data.items ?? []).map((item) => ({
    id: item.id,
    language: item.snippet?.language ?? null,
    name: item.snippet?.name ?? "",
    trackKind: item.snippet?.trackKind ?? null,
    status: item.snippet?.status ?? null,
    isDraft: item.snippet?.isDraft ?? null,
  }));

  const snapshot = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    videoId: video.id,
    videoUrl: `https://www.youtube.com/watch?v=${video.id}`,
    backfillEligibility: {
      inventoryPath: path.relative(RUNTIME_PATHS.metadataBackfillRoot, CANDIDATE_INVENTORY_PATH).replace(/\\/g, "/"),
      inventoryCapturedAt: inventory.capturedAt,
      inventorySchemaVersion: inventory.schemaVersion,
      contentType: inventoryRow.contentType,
      contentTypeAuthority: inventoryRow.contentTypeAuthority,
      contentTypeReason: inventoryRow.contentTypeReason,
      policyBucket: inventoryRow.policyBucket,
      isShort: inventoryRow.isShort,
      eligibleForBackfill: inventoryRow.eligibleForBackfill,
    },
    immutable: {
      title: video.snippet?.title ?? "",
      description: video.snippet?.description ?? "",
      tags: video.snippet?.tags ?? [],
      categoryId: video.snippet?.categoryId ?? null,
      defaultLanguage,
      defaultAudioLanguage: video.snippet?.defaultAudioLanguage ?? null,
      privacyStatus: video.status?.privacyStatus ?? null,
      license: video.status?.license ?? null,
      embeddable: video.status?.embeddable ?? null,
      publicStatsViewable: video.status?.publicStatsViewable ?? null,
      madeForKids: video.status?.madeForKids ?? null,
      hasCustomThumbnail: video.contentDetails?.hasCustomThumbnail ?? null,
    },
    processing: {
      uploadStatus: video.status?.uploadStatus ?? null,
      processingStatus: video.processingDetails?.processingStatus ?? null,
      duration: video.contentDetails?.duration ?? null,
      definition: video.contentDetails?.definition ?? null,
    },
    localizations: rawLocalizations,
    captions,
    supportedLanguages,
    supportedLanguageCount: supportedLanguages.length,
    missingLanguages,
    missingLanguageCount: missingLanguages.length,
    normalizedCoveredLanguageCount: supportedLanguages.length - missingLanguages.length,
  };
  await writeJsonAtomic(path.join(packageDir, "source_snapshot.json"), snapshot);
  process.stdout.write(
    `BACKFILL_AUDIT_READY video=${video.id} supported=${supportedLanguages.length} missing=${missingLanguages.length} package=${packageDir}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`BACKFILL_AUDIT_FAILED ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertInventoryBackfillEligibility,
  findInventoryRow,
};
