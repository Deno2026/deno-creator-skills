#!/usr/bin/env node

const path = require("node:path");
const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const { getUploadRuntimePaths } = require("@deno/runtime-paths");
const {
  isValidGeneratedDescription,
  sameLocalizationDescription,
} = require("./lib/youtube_metadata_backfill_policy.cjs");

const RUNTIME_PATHS = getUploadRuntimePaths();
const CURRENT_STATE_PATH = RUNTIME_PATHS.backfillActiveStatePath;
const CANDIDATE_INVENTORY_PATH = path.join(
  RUNTIME_PATHS.metadataBackfillRoot,
  "candidate_inventory.json",
);
const { google } = require("googleapis");
const { resolveUploadChannel } = require("@deno/runtime-paths");
const { assertYouTubeChannel } = require("./lib/youtube_channel.cjs");

function parseArgs(argv) {
  const args = { packageDir: "", maxUnits: 4000, verifyOnly: false, preflightOnly: false };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--package-dir") args.packageDir = argv[++index] ?? "";
    else if (argv[index] === "--max-units") args.maxUnits = Number(argv[++index] ?? "4000");
    else if (argv[index] === "--verify-only") args.verifyOnly = true;
    else if (argv[index] === "--preflight-only") args.preflightOnly = true;
  }
  if (!args.packageDir) throw new Error("--package-dir is required");
  if (!Number.isFinite(args.maxUnits) || args.maxUnits < 0) throw new Error("Invalid --max-units");
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

function normalizedLocalizations(localizations) {
  return Object.fromEntries(
    Object.entries(localizations ?? {}).map(([language, value]) => [normalizeLanguage(language), value]),
  );
}

function sortedTags(tags) {
  return [...(tags ?? [])].sort((left, right) => left.localeCompare(right));
}

function immutableDifferences(expected, video) {
  const differences = [];
  const checks = [
    ["title", video.snippet?.title, expected.title],
    ["description", video.snippet?.description, expected.description],
    ["categoryId", video.snippet?.categoryId, expected.categoryId],
    ["defaultLanguage", video.snippet?.defaultLanguage, expected.defaultLanguage],
    ["defaultAudioLanguage", video.snippet?.defaultAudioLanguage ?? null, expected.defaultAudioLanguage],
    ["privacyStatus", video.status?.privacyStatus, expected.privacyStatus],
    ["license", video.status?.license, expected.license],
    ["embeddable", video.status?.embeddable, expected.embeddable],
    ["publicStatsViewable", video.status?.publicStatsViewable, expected.publicStatsViewable],
    ["madeForKids", video.status?.madeForKids, expected.madeForKids],
    ["hasCustomThumbnail", video.contentDetails?.hasCustomThumbnail, expected.hasCustomThumbnail],
  ];
  for (const [field, actual, value] of checks) if (actual !== value) differences.push(field);
  if (JSON.stringify(sortedTags(video.snippet?.tags)) !== JSON.stringify(sortedTags(expected.tags))) {
    differences.push("tags");
  }
  return differences;
}

function isQuotaError(error) {
  const text = `${error?.message ?? ""} ${JSON.stringify(error?.response?.data ?? {})}`.toLowerCase();
  return text.includes("quotaexceeded") || text.includes("quota exceeded");
}

function assertTargetIsNotActiveJob(videoId, currentState) {
  if (currentState?.active_job == null) return;
  const activeVideoId = currentState.active_job?.video_id;
  if (typeof activeVideoId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(activeVideoId)) {
    throw new Error("CURRENT_STATE.json active_job must include a valid video_id before daily backfill apply");
  }
  if (activeVideoId === videoId) {
    throw new Error(`Daily existing-video backfill cannot target CURRENT_STATE active_job video ${videoId}`);
  }
}

function assertBackfillEligibleSource(source, inventory) {
  const evidence = source?.backfillEligibility;
  if (
    evidence?.inventorySchemaVersion !== 5
    || evidence?.contentType !== "video"
    || evidence?.policyBucket !== "eligible_video"
    || evidence?.isShort !== false
    || evidence?.eligibleForBackfill !== true
  ) {
    throw new Error("source_snapshot.json lacks eligible non-Short standard-video inventory evidence");
  }
  if (inventory?.schemaVersion !== 5 || inventory.capturedAt !== evidence.inventoryCapturedAt) {
    throw new Error("candidate_inventory.json changed after the protected source snapshot");
  }
  const pending = (inventory.pendingVideos ?? []).find((row) => row.videoId === source.videoId);
  if (
    !pending
    || pending.contentType !== "video"
    || pending.policyBucket !== "eligible_video"
    || pending.isShort !== false
    || pending.eligibleForBackfill !== true
  ) {
    throw new Error(`Backfill target ${source.videoId} is no longer an eligible pending standard video`);
  }
}

async function saveRefreshedToken(tokenPath, token) {
  const existing = await readJson(tokenPath);
  await writeJsonAtomic(tokenPath, {
    ...existing,
    ...token,
    refresh_token: token.refresh_token ?? existing.refresh_token,
  });
}

async function getVideo(youtube, videoId) {
  const response = await youtube.videos.list({
    part: ["snippet", "status", "localizations", "contentDetails", "processingDetails"],
    id: [videoId],
  });
  const video = response.data.items?.[0];
  if (!video) throw new Error(`Video not found: ${videoId}`);
  return video;
}

async function getCaptions(youtube, videoId) {
  const response = await youtube.captions.list({ part: ["id", "snippet"], videoId });
  return (response.data.items ?? []).map((item) => ({
    id: item.id,
    language: item.snippet?.language ?? null,
    name: item.snippet?.name ?? "",
    trackKind: item.snippet?.trackKind ?? null,
    status: item.snippet?.status ?? null,
    isDraft: item.snippet?.isDraft ?? null,
  }));
}

async function main() {
  const args = parseArgs(process.argv);
  const packageDir = path.resolve(args.packageDir);
  const sourcePath = path.join(packageDir, "source_snapshot.json");
  const metadataPath = path.join(packageDir, "metadata_backfill.json");
  const statePath = path.join(packageDir, "backfill_state.json");
  const verificationPath = path.join(packageDir, "verification.json");
  const settingsPath = RUNTIME_PATHS.settingsPath;
  const tokenPath = RUNTIME_PATHS.oauthTokenPath;
  const [source, metadata, settings, token, currentState, candidateInventory] = await Promise.all([
    readJson(sourcePath),
    readJson(metadataPath),
    readJson(settingsPath),
    readJson(tokenPath),
    readJson(CURRENT_STATE_PATH),
    readJson(CANDIDATE_INVENTORY_PATH),
  ]);
  if (metadata.videoId !== source.videoId) throw new Error("Metadata videoId differs from source snapshot");
  assertTargetIsNotActiveJob(source.videoId, currentState);
  assertBackfillEligibleSource(source, candidateInventory);

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

  let video = await getVideo(youtube, source.videoId);
  const beforeDifferences = immutableDifferences(source.immutable, video);
  if (beforeDifferences.length > 0) {
    throw new Error(`Protected video metadata changed after snapshot: ${beforeDifferences.join(", ")}`);
  }
  const liveRawBefore = video.localizations ?? {};
  for (const [language, expected] of Object.entries(source.localizations ?? {})) {
    const actual = liveRawBefore[language];
    if (
      !actual
      || actual.title !== expected.title
      || !sameLocalizationDescription(actual.description, expected.description)
    ) {
      throw new Error(`Existing localization changed after snapshot: ${language}`);
    }
  }

  const supportedResponse = await youtube.i18nLanguages.list({ part: ["snippet"], hl: "en" });
  const supportedLanguages = (supportedResponse.data.items ?? [])
    .map((item) => item.id)
    .filter((language) => language && language !== source.immutable.defaultLanguage);
  if (JSON.stringify(supportedLanguages) !== JSON.stringify(metadata.supportedLanguages)) {
    throw new Error("YouTube supported language list changed after metadata generation");
  }

  const generated = metadata.generatedLocalizations ?? {};
  for (const [language, value] of Object.entries(generated)) {
    if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 100) {
      throw new Error(`Invalid title for ${language}`);
    }
    if (!isValidGeneratedDescription(source.immutable.description, value.description)) {
      throw new Error(`Invalid description for ${language}`);
    }
  }
  const liveNormalizedBefore = normalizedLocalizations(liveRawBefore);
  const availableNormalized = new Set([
    ...Object.keys(liveNormalizedBefore),
    ...Object.keys(generated).map(normalizeLanguage),
  ]);
  const uncovered = supportedLanguages.filter(
    (language) => !availableNormalized.has(normalizeLanguage(language)),
  );
  if (uncovered.length > 0) throw new Error(`Generated metadata leaves languages uncovered: ${uncovered.join(", ")}`);

  const pending = Object.keys(generated).filter(
    (language) => !Object.hasOwn(liveNormalizedBefore, normalizeLanguage(language)),
  );
  const estimatedUpdateUnits = Math.ceil(pending.length / 3) * 50;
  // Normal apply reads the video and language list before writing (2 units),
  // then rereads the video (1) and caption tracks (50) for final verification.
  const estimatedTotalUnits = estimatedUpdateUnits + 53;
  if (!args.verifyOnly && estimatedTotalUnits > args.maxUnits) {
    throw new Error(`Estimated quota ${estimatedTotalUnits} exceeds max ${args.maxUnits}`);
  }

  const state = {
    schemaVersion: 1,
    videoId: source.videoId,
    state: args.verifyOnly ? "verification_running" : "applying",
    startedAt: new Date().toISOString(),
    maxUnits: args.maxUnits,
    estimatedUpdateUnits,
    estimatedTotalUnits,
    supportedLanguageCount: supportedLanguages.length,
    generatedLanguageCount: Object.keys(generated).length,
    appliedLanguages: Object.keys(generated).filter((language) => !pending.includes(language)),
    pendingLanguages: pending,
  };
  await writeJsonAtomic(statePath, state);
  process.stdout.write(
    `BACKFILL_PREFLIGHT_OK video=${source.videoId} pending=${pending.length} estimatedUnits=${estimatedTotalUnits}\n`,
  );
  if (args.preflightOnly) {
    state.state = "preflight_passed";
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(statePath, state);
    return;
  }

  if (!args.verifyOnly) {
    let cumulative = { ...liveRawBefore };
    for (let index = 0; index < pending.length; index += 3) {
      const batch = pending.slice(index, index + 3);
      for (const language of batch) cumulative[language] = generated[language];
      try {
        await youtube.videos.update({
          part: ["localizations"],
          requestBody: { id: source.videoId, localizations: cumulative },
        });
      } catch (error) {
        state.state = isQuotaError(error) ? "quota_checkpoint" : "update_failed";
        state.pendingLanguages = pending.slice(index);
        state.lastError = error.message;
        state.updatedAt = new Date().toISOString();
        await writeJsonAtomic(statePath, state);
        throw error;
      }
      state.appliedLanguages = [...new Set([...state.appliedLanguages, ...batch])];
      state.pendingLanguages = pending.slice(index + batch.length);
      state.lastBatch = batch;
      state.updatedAt = new Date().toISOString();
      await writeJsonAtomic(statePath, state);
      process.stdout.write(`BACKFILL_BATCH_COMPLETE ${batch.join(",")}\n`);
    }
  }

  video = await getVideo(youtube, source.videoId);
  const captions = await getCaptions(youtube, source.videoId);
  const afterDifferences = immutableDifferences(source.immutable, video);
  const actualRaw = video.localizations ?? {};
  const actualNormalized = normalizedLocalizations(actualRaw);
  const missingSupported = supportedLanguages.filter(
    (language) => !Object.hasOwn(actualNormalized, normalizeLanguage(language)),
  );
  const generatedDifferences = [];
  for (const [language, expected] of Object.entries(generated)) {
    const value = actualNormalized[normalizeLanguage(language)];
    if (!value) generatedDifferences.push({ language, issue: "missing" });
    else if (value.title !== expected.title) generatedDifferences.push({ language, issue: "title" });
    else if (!sameLocalizationDescription(value.description, expected.description)) {
      generatedDifferences.push({ language, issue: "description" });
    }
  }
  const existingDifferences = [];
  for (const [language, expected] of Object.entries(source.localizations ?? {})) {
    const value = actualRaw[language];
    if (!value) existingDifferences.push({ language, issue: "missing" });
    else if (value.title !== expected.title) existingDifferences.push({ language, issue: "title" });
    else if (!sameLocalizationDescription(value.description, expected.description)) {
      existingDifferences.push({ language, issue: "description" });
    }
  }
  const captionDifferences = JSON.stringify(captions) === JSON.stringify(source.captions) ? [] : ["captions"];
  const ok =
    afterDifferences.length === 0 &&
    missingSupported.length === 0 &&
    generatedDifferences.length === 0 &&
    existingDifferences.length === 0 &&
    captionDifferences.length === 0;
  const verification = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    videoId: source.videoId,
    ok,
    supportedLanguageCount: supportedLanguages.length,
    rawLocalizationCount: Object.keys(actualRaw).length,
    missingSupported,
    generatedDifferences,
    existingDifferences,
    immutableDifferences: afterDifferences,
    captionDifferences,
    privacyStatus: video.status?.privacyStatus ?? null,
    captions,
  };
  await writeJsonAtomic(verificationPath, verification);
  state.state = ok ? "verified_complete" : "verification_failed";
  state.pendingLanguages = missingSupported;
  state.completedAt = ok ? new Date().toISOString() : null;
  await writeJsonAtomic(statePath, state);
  if (!ok) throw new Error(`Backfill verification failed: ${JSON.stringify(verification)}`);
  process.stdout.write(
    `BACKFILL_VERIFIED_COMPLETE video=${source.videoId} supported=${supportedLanguages.length} raw=${Object.keys(actualRaw).length}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`BACKFILL_APPLY_FAILED ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertBackfillEligibleSource,
  assertTargetIsNotActiveJob,
};
