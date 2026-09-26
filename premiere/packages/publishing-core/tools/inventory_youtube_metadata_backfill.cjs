#!/usr/bin/env node

"use strict";

const path = require("node:path");
const { execFile } = require("node:child_process");
const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");

const { getUploadRuntimePaths } = require("@deno/runtime-paths");

const RUNTIME_PATHS = getUploadRuntimePaths();
const BACKFILL_ROOT = RUNTIME_PATHS.metadataBackfillRoot;
const DEFAULT_OUTPUT = path.join(BACKFILL_ROOT, "candidate_inventory.json");
const CANDIDATE_EXCLUSIONS_PATH = path.join(BACKFILL_ROOT, "candidate_exclusions.json");
const CONTENT_TYPE_OVERRIDES_PATH = path.join(BACKFILL_ROOT, "content_type_overrides.json");
const CURRENT_STATE_PATH = RUNTIME_PATHS.backfillActiveStatePath;
const { google } = require("googleapis");
const { resolveUploadChannel } = require("@deno/runtime-paths");
const { assertYouTubeChannel } = require("./lib/youtube_channel.cjs");
const THREE_MINUTE_SHORTS_START_MS = Date.parse("2024-10-15T00:00:00Z");
const CHANNEL_ID = resolveUploadChannel().youtubeChannelId; // channels.json 기본 채널
const CHANNEL_URL = `https://www.youtube.com/channel/${CHANNEL_ID}`;
const PUBLIC_TAB_TYPES = Object.freeze({ videos: "video", shorts: "short", streams: "live" });
const CONTENT_TYPES = new Set(["video", "short", "live", "unknown"]);
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function parseArgs(argv) {
  const args = { output: DEFAULT_OUTPUT };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--output") args.output = path.resolve(argv[++index] ?? DEFAULT_OUTPUT);
  }
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

function parseCandidateExclusions(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.excludedVideos)) {
    throw new Error("candidate_exclusions.json must use schemaVersion 1 with excludedVideos");
  }
  const exclusions = new Map();
  for (const entry of value.excludedVideos) {
    if (!entry || typeof entry.videoId !== "string" || !VIDEO_ID_PATTERN.test(entry.videoId)
      || typeof entry.reasonCode !== "string" || !entry.reasonCode.trim()
      || typeof entry.reason !== "string" || !entry.reason.trim()
      || entry.authority !== "user_explicit") {
      throw new Error("Invalid user exclusion in candidate_exclusions.json");
    }
    if (exclusions.has(entry.videoId)) throw new Error(`Duplicate user exclusion for ${entry.videoId}`);
    exclusions.set(entry.videoId, {
      reasonCode: entry.reasonCode,
      reason: entry.reason,
      authority: entry.authority,
    });
  }
  return exclusions;
}

function parseContentTypeOverrides(value) {
  if (value?.schemaVersion !== 1 || typeof value.observedAt !== "string"
    || !value.observedAt.trim() || !Array.isArray(value.overrides)) {
    throw new Error("content_type_overrides.json must use schemaVersion 1 with observedAt and overrides");
  }
  const overrides = new Map();
  for (const entry of value.overrides) {
    if (!entry || typeof entry.videoId !== "string" || !VIDEO_ID_PATTERN.test(entry.videoId)
      || !CONTENT_TYPES.has(entry.contentType) || entry.contentType === "unknown"
      || !["private", "unlisted"].includes(entry.expectedPrivacyStatus)
      || entry.authority !== "youtube_studio_live_read"
      || typeof entry.observedAt !== "string" || !entry.observedAt.trim()
      || typeof entry.reason !== "string" || !entry.reason.trim()) {
      throw new Error("Invalid content type override in content_type_overrides.json");
    }
    if (overrides.has(entry.videoId)) throw new Error(`Duplicate content type override for ${entry.videoId}`);
    overrides.set(entry.videoId, {
      contentType: entry.contentType,
      expectedPrivacyStatus: entry.expectedPrivacyStatus,
      authority: entry.authority,
      observedAt: entry.observedAt,
      reason: entry.reason,
    });
  }
  return { observedAt: value.observedAt, overrides };
}

function resolveActiveJobHold(currentState) {
  if (currentState?.active_job == null) return null;
  const activeJob = currentState.active_job;
  if (!activeJob || typeof activeJob !== "object") {
    throw new Error("CURRENT_STATE.json active_job must be an object or null");
  }
  const videoId = activeJob.video_id;
  if (typeof videoId !== "string" || !VIDEO_ID_PATTERN.test(videoId)) {
    throw new Error("CURRENT_STATE.json active_job must include a valid video_id before daily backfill inventory");
  }
  return {
    videoId,
    slug: typeof activeJob.slug === "string" ? activeJob.slug : null,
    stage: typeof activeJob.stage === "string" ? activeJob.stage : null,
    status: typeof currentState.status === "string" ? currentState.status : null,
    reasonCode: "active_job_incomplete",
    reason: "CURRENT_STATE.json의 현재 신규 업로드 작업이 완료되어 active_job에서 제거될 때까지 일일 기존 영상 백필에서 보류",
    authority: "CURRENT_STATE.json",
  };
}

function normalizeLanguage(language) {
  const aliases = {
    iw: "he", he: "he", "zh-CN": "zh-Hans", "zh-Hans": "zh-Hans",
    "zh-TW": "zh-Hant", "zh-Hant": "zh-Hant", pt: "pt-BR", "pt-BR": "pt-BR",
  };
  return aliases[language] ?? language;
}

function parseDurationSeconds(value) {
  if (typeof value !== "string") return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match) return null;
  const total = Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600
    + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
  return Number.isFinite(total) ? total : null;
}

function selectLargestVideoStream(video) {
  const dimensions = (video.fileDetails?.videoStreams ?? [])
    .map((stream) => ({ widthPixels: Number(stream.widthPixels), heightPixels: Number(stream.heightPixels) }))
    .filter((stream) => Number.isFinite(stream.widthPixels) && stream.widthPixels > 0
      && Number.isFinite(stream.heightPixels) && stream.heightPixels > 0);
  dimensions.sort((left, right) => right.widthPixels * right.heightPixels - left.widthPixels * left.heightPixels);
  return dimensions[0] ?? null;
}

function classifyShort(video) {
  const duration = video.contentDetails?.duration ?? null;
  const durationSeconds = parseDurationSeconds(duration);
  const publishedAtMs = Date.parse(video.snippet?.publishedAt ?? "");
  const durationLimitSeconds = Number.isFinite(publishedAtMs) && publishedAtMs < THREE_MINUTE_SHORTS_START_MS ? 60 : 180;
  const dimensions = selectLargestVideoStream(video);
  const base = {
    duration, durationSeconds, durationLimitSeconds,
    widthPixels: dimensions?.widthPixels ?? null,
    heightPixels: dimensions?.heightPixels ?? null,
  };
  if (durationSeconds === null) {
    return { ...base, isShort: null, shortClassification: "unknown_missing_duration", eligibleForBackfill: false };
  }
  if (durationSeconds > durationLimitSeconds) {
    return { ...base, isShort: false, shortClassification: "not_short_over_duration_limit", eligibleForBackfill: true };
  }
  if (!dimensions) {
    return { ...base, isShort: null, shortClassification: "unknown_missing_dimensions", eligibleForBackfill: false };
  }
  const isShort = dimensions.widthPixels <= dimensions.heightPixels;
  return {
    ...base,
    isShort,
    shortClassification: isShort ? "short_vertical_or_square_within_duration_limit" : "not_short_landscape",
    eligibleForBackfill: !isShort,
  };
}

function stableUniqueVideoIds(ids) {
  const seen = new Set();
  const output = [];
  for (const id of ids) {
    if (typeof id !== "string" || !VIDEO_ID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    output.push(id);
  }
  return output;
}

function runYtDlpTab(tabUrl) {
  const command = process.env.YT_DLP_PATH || "yt-dlp";
  const args = ["--flat-playlist", "--dump-single-json", "--skip-download", "--no-warnings", tabUrl];
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0,
        errorCode: error && typeof error.code === "string" ? error.code : null,
        errorMessage: error?.message ?? null,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      });
    });
  });
}

function parseYtDlpTabIds(stdout) {
  const value = JSON.parse(String(stdout ?? "").trim());
  const entries = Array.isArray(value?.entries) ? value.entries : [];
  const ids = stableUniqueVideoIds(entries.map((entry) => entry?.id));
  return { ids, entryCount: entries.length, invalidOrDuplicateEntryCount: entries.length - ids.length };
}

async function discoverPublicTabs({ runner = runYtDlpTab, channelUrl = CHANNEL_URL } = {}) {
  const tabs = {};
  for (const tabName of Object.keys(PUBLIC_TAB_TYPES)) {
    const tabUrl = `${channelUrl}/${tabName}`;
    let result;
    try {
      result = await runner(tabUrl, tabName);
    } catch (error) {
      tabs[tabName] = { status: "failed", url: tabUrl, ids: [], videoCount: 0, reason: `runner_exception: ${error.message}` };
      continue;
    }
    const combinedError = `${result?.stderr ?? ""}\n${result?.errorMessage ?? ""}`;
    if (tabName === "streams" && /does not have a streams tab/i.test(combinedError)) {
      tabs[tabName] = {
        status: "empty_no_streams_tab", url: tabUrl, ids: [], videoCount: 0,
        reason: "yt-dlp confirmed that the public channel has no streams tab",
      };
      continue;
    }
    if (result?.exitCode !== 0) {
      tabs[tabName] = {
        status: "failed", url: tabUrl, ids: [], videoCount: 0,
        reason: result?.errorCode ? `yt-dlp ${result.errorCode}` : `yt-dlp exit ${result?.exitCode ?? "unknown"}`,
      };
      continue;
    }
    try {
      const parsed = parseYtDlpTabIds(result.stdout);
      tabs[tabName] = { status: "ok", url: tabUrl, ...parsed, videoCount: parsed.ids.length };
    } catch (error) {
      tabs[tabName] = { status: "failed", url: tabUrl, ids: [], videoCount: 0, reason: `invalid_json: ${error.message}` };
    }
  }
  const failedTabs = Object.entries(tabs).filter(([, tab]) => tab.status === "failed").map(([name]) => name);
  return {
    tool: process.env.YT_DLP_PATH || "yt-dlp",
    mergeEnabled: failedTabs.length === 0,
    disabledReason: failedTabs.length > 0 ? `required public tab discovery failed: ${failedTabs.join(", ")}` : null,
    tabs,
  };
}

function buildPublicTabMembership(discovery) {
  const memberships = new Map();
  if (!discovery?.mergeEnabled) return memberships;
  for (const [tabName, contentType] of Object.entries(PUBLIC_TAB_TYPES)) {
    for (const id of discovery.tabs?.[tabName]?.ids ?? []) {
      if (!memberships.has(id)) memberships.set(id, new Set());
      memberships.get(id).add(contentType);
    }
  }
  return memberships;
}

function mergeUploadsWithPublicTabs(uploadIds, discovery) {
  const uniqueUploadIds = stableUniqueVideoIds(uploadIds);
  if (!discovery?.mergeEnabled) return { ids: uniqueUploadIds, tabOnlyVideoIds: [] };
  const uploadSet = new Set(uniqueUploadIds);
  const publicIds = stableUniqueVideoIds(
    Object.keys(PUBLIC_TAB_TYPES).flatMap((tabName) => discovery.tabs?.[tabName]?.ids ?? []),
  );
  const tabOnlyVideoIds = publicIds.filter((id) => !uploadSet.has(id));
  return { ids: [...uniqueUploadIds, ...tabOnlyVideoIds], tabOnlyVideoIds };
}

function resolveContentType({ video, physicalShort, tabMembership = [], override = null }) {
  const uniqueTabTypes = [...new Set(tabMembership)].filter((type) => CONTENT_TYPES.has(type));
  const privacyStatus = video.status?.privacyStatus ?? null;
  if (override) {
    if (privacyStatus !== override.expectedPrivacyStatus) {
      return {
        contentType: "unknown",
        contentTypeAuthority: "content_type_override_privacy_mismatch",
        contentTypeReason: `override expected ${override.expectedPrivacyStatus}, live API returned ${privacyStatus ?? "null"}`,
        contentTypeTabMembership: uniqueTabTypes,
      };
    }
    return {
      contentType: override.contentType,
      contentTypeAuthority: override.authority,
      contentTypeReason: override.reason,
      contentTypeTabMembership: uniqueTabTypes,
    };
  }
  if (uniqueTabTypes.length > 1) {
    const sorted = [...uniqueTabTypes].sort();
    return {
      contentType: "unknown", contentTypeAuthority: "public_tab_conflict",
      contentTypeReason: `video appeared in conflicting public tabs: ${sorted.join(", ")}`,
      contentTypeTabMembership: sorted,
    };
  }
  if (uniqueTabTypes.length === 1) {
    return {
      contentType: uniqueTabTypes[0], contentTypeAuthority: "youtube_public_channel_tab",
      contentTypeReason: `video appeared only in the public ${uniqueTabTypes[0]} tab classification`,
      contentTypeTabMembership: uniqueTabTypes,
    };
  }
  if (physicalShort.isShort === true) {
    return { contentType: "short", contentTypeAuthority: "physical_short_heuristic", contentTypeReason: physicalShort.shortClassification, contentTypeTabMembership: [] };
  }
  if (physicalShort.isShort === false) {
    return { contentType: "video", contentTypeAuthority: "physical_non_short_heuristic", contentTypeReason: physicalShort.shortClassification, contentTypeTabMembership: [] };
  }
  return { contentType: "unknown", contentTypeAuthority: "physical_heuristic_inconclusive", contentTypeReason: physicalShort.shortClassification, contentTypeTabMembership: [] };
}

function resolvePolicyBucket({ candidateExclusion, activeJobDeferral, contentType }) {
  if (candidateExclusion !== null) return "excluded_user";
  if (activeJobDeferral !== null) return "deferred_active_job";
  if (contentType === "short") return "excluded_short";
  if (contentType === "live") return "excluded_live";
  if (contentType === "unknown") return "excluded_unknown";
  if (contentType === "video") return "eligible_video";
  throw new Error(`Unsupported content type: ${contentType}`);
}

function compareRowsNewestFirst(left, right) {
  const leftTime = Date.parse(left.publishedAt ?? "");
  const rightTime = Date.parse(right.publishedAt ?? "");
  const safeLeftTime = Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY;
  const safeRightTime = Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY;
  if (safeLeftTime !== safeRightTime) return safeRightTime - safeLeftTime;
  return left.videoId.localeCompare(right.videoId);
}

async function saveRefreshedToken(tokenPath, token) {
  const existing = await readJson(tokenPath);
  await writeJsonAtomic(tokenPath, { ...existing, ...token, refresh_token: token.refresh_token ?? existing.refresh_token });
}

async function main() {
  const args = parseArgs(process.argv);
  const settingsPath = RUNTIME_PATHS.settingsPath;
  const tokenPath = RUNTIME_PATHS.oauthTokenPath;
  const [settings, token, exclusionsRaw, overridesRaw, currentState] = await Promise.all([
    readJson(settingsPath), readJson(tokenPath), readJson(CANDIDATE_EXCLUSIONS_PATH),
    readJson(CONTENT_TYPE_OVERRIDES_PATH), readJson(CURRENT_STATE_PATH),
  ]);
  const candidateExclusions = parseCandidateExclusions(exclusionsRaw);
  const overrideConfig = parseContentTypeOverrides(overridesRaw);
  const activeJobHold = resolveActiveJobHold(currentState);
  const oauth = new google.auth.OAuth2(settings.clientId, settings.clientSecret, settings.redirectUri);
  oauth.setCredentials(token);
  oauth.on("tokens", (refreshed) => void saveRefreshedToken(tokenPath, refreshed)
    .catch((error) => process.stderr.write(`TOKEN_SAVE_WARNING ${error.message}\n`)));
  const youtube = google.youtube({ version: "v3", auth: oauth });
  // 메타데이터 일괄 정리는 DENO 강의 채널 전용이다(설명 규칙이 DENO 형식). 토큰이 그 채널인지 먼저 확인한다.
  await assertYouTubeChannel(youtube, resolveUploadChannel());
  const [channelResponse, languageResponse, publicTabDiscovery] = await Promise.all([
    youtube.channels.list({ part: ["contentDetails"], id: [CHANNEL_ID] }),
    youtube.i18nLanguages.list({ part: ["snippet"], hl: "en" }),
    discoverPublicTabs(),
  ]);
  const uploadsPlaylistId = channelResponse.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) throw new Error(`Uploads playlist not found for ${CHANNEL_ID}`);
  const supportedLanguages = [...new Set((languageResponse.data.items ?? [])
    .map((item) => item.id).filter((language) => language && language !== "ko"))];

  const playlistItems = [];
  let pageToken;
  do {
    const response = await youtube.playlistItems.list({
      part: ["contentDetails", "snippet"], playlistId: uploadsPlaylistId, maxResults: 50, pageToken,
    });
    playlistItems.push(...(response.data.items ?? []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  const rawUploadIds = playlistItems.map((item) => item.contentDetails?.videoId).filter(Boolean);
  const uniqueUploadIds = stableUniqueVideoIds(rawUploadIds);
  const mergedIds = mergeUploadsWithPublicTabs(uniqueUploadIds, publicTabDiscovery);
  const videos = [];
  for (let index = 0; index < mergedIds.ids.length; index += 50) {
    const response = await youtube.videos.list({
      part: ["snippet", "status", "localizations", "contentDetails", "fileDetails"],
      id: mergedIds.ids.slice(index, index + 50),
    });
    videos.push(...(response.data.items ?? []));
  }

  const uploadIdSet = new Set(uniqueUploadIds);
  const returnedIdSet = new Set(videos.map((video) => video.id));
  const rejectedTabOnlyVideos = [];
  const ownedVideos = videos.filter((video) => {
    const owned = video.snippet?.channelId === CHANNEL_ID;
    if (uploadIdSet.has(video.id) && !owned) {
      throw new Error(`Uploads playlist video ${video.id} does not belong to channel ${CHANNEL_ID}`);
    }
    if (!owned) rejectedTabOnlyVideos.push({
      videoId: video.id,
      reason: "snippet.channelId did not match the authoritative channel",
      observedChannelId: video.snippet?.channelId ?? null,
    });
    return owned;
  });
  for (const videoId of mergedIds.tabOnlyVideoIds) {
    if (!returnedIdSet.has(videoId)) rejectedTabOnlyVideos.push({
      videoId, reason: "videos.list did not return the public-tab-only ID", observedChannelId: null,
    });
  }
  const rejectedIds = new Set(rejectedTabOnlyVideos.map((entry) => entry.videoId));
  const mergedOwnedTabOnlyVideoIds = mergedIds.tabOnlyVideoIds
    .filter((id) => returnedIdSet.has(id) && !rejectedIds.has(id));
  const unresolvedUploadsVideoIds = uniqueUploadIds.filter((id) => !returnedIdSet.has(id));
  const tabMembership = buildPublicTabMembership(publicTabDiscovery);

  const rows = ownedVideos.map((video) => {
    const physicalShort = classifyShort(video);
    const candidateExclusion = candidateExclusions.get(video.id) ?? null;
    const activeJobDeferral = candidateExclusion === null && activeJobHold?.videoId === video.id ? activeJobHold : null;
    const resolvedType = resolveContentType({
      video,
      physicalShort,
      tabMembership: [...(tabMembership.get(video.id) ?? [])],
      override: overrideConfig.overrides.get(video.id) ?? null,
    });
    const policyBucket = resolvePolicyBucket({ candidateExclusion, activeJobDeferral, contentType: resolvedType.contentType });
    const rawLocalizations = video.localizations ?? {};
    const covered = new Set(Object.keys(rawLocalizations).map(normalizeLanguage));
    const missingLanguages = supportedLanguages.filter((language) => !covered.has(normalizeLanguage(language)));
    return {
      videoId: video.id,
      videoUrl: `https://www.youtube.com/watch?v=${video.id}`,
      title: video.snippet?.title ?? "",
      publishedAt: video.snippet?.publishedAt ?? null,
      privacyStatus: video.status?.privacyStatus ?? null,
      defaultLanguage: video.snippet?.defaultLanguage ?? null,
      defaultAudioLanguage: video.snippet?.defaultAudioLanguage ?? null,
      duration: physicalShort.duration,
      durationSeconds: physicalShort.durationSeconds,
      durationLimitSeconds: physicalShort.durationLimitSeconds,
      widthPixels: physicalShort.widthPixels,
      heightPixels: physicalShort.heightPixels,
      shortClassification: physicalShort.shortClassification,
      physicalIsShort: physicalShort.isShort,
      ...resolvedType,
      isShort: resolvedType.contentType === "short" ? true : resolvedType.contentType === "unknown" ? null : false,
      eligibleForBackfill: policyBucket === "eligible_video",
      policyBucket,
      candidateExclusion,
      activeJobDeferral,
      rawLocalizationCount: Object.keys(rawLocalizations).length,
      missingLanguageCount: missingLanguages.length,
      missingLanguages,
      complete: missingLanguages.length === 0,
    };
  }).sort(compareRowsNewestFirst);

  const standardVideos = rows.filter((row) => row.contentType === "video");
  const shortContents = rows.filter((row) => row.contentType === "short");
  const liveContents = rows.filter((row) => row.contentType === "live");
  const unknownContents = rows.filter((row) => row.contentType === "unknown");
  if (standardVideos.length + shortContents.length + liveContents.length + unknownContents.length !== rows.length) {
    throw new Error("Content type classification mismatch");
  }
  const eligibleVideos = rows.filter((row) => row.policyBucket === "eligible_video");
  const excludedUserVideos = rows.filter((row) => row.policyBucket === "excluded_user");
  const deferredActiveJobVideos = rows.filter((row) => row.policyBucket === "deferred_active_job");
  const excludedShortVideos = rows.filter((row) => row.policyBucket === "excluded_short");
  const excludedLiveVideos = rows.filter((row) => row.policyBucket === "excluded_live");
  const excludedUnknownShortRiskVideos = rows.filter((row) => row.policyBucket === "excluded_unknown");
  if (eligibleVideos.length + excludedUserVideos.length + deferredActiveJobVideos.length
    + excludedShortVideos.length + excludedLiveVideos.length + excludedUnknownShortRiskVideos.length !== rows.length) {
    throw new Error("Inventory policy classification mismatch");
  }
  const pendingVideos = eligibleVideos.filter((row) => !row.complete);
  const completedVideos = eligibleVideos.filter((row) => row.complete);
  const output = {
    schemaVersion: 5,
    capturedAt: new Date().toISOString(),
    channelId: CHANNEL_ID,
    uploadsPlaylistId,
    playlistItemCount: rawUploadIds.length,
    uniqueUploadsVideoCount: uniqueUploadIds.length,
    duplicateUploadsVideoCount: rawUploadIds.length - uniqueUploadIds.length,
    unresolvedUploadsVideoIds,
    publicTabDiscovery: {
      ...publicTabDiscovery,
      tabOnlyVideoIds: mergedIds.tabOnlyVideoIds,
      mergedOwnedTabOnlyVideoIds,
      rejectedTabOnlyVideos,
    },
    candidateExclusionsPath: path.relative(BACKFILL_ROOT, CANDIDATE_EXCLUSIONS_PATH).replace(/\\/g, "/"),
    contentTypeOverridesPath: path.relative(BACKFILL_ROOT, CONTENT_TYPE_OVERRIDES_PATH).replace(/\\/g, "/"),
    contentTypeOverridesObservedAt: overrideConfig.observedAt,
    supportedLanguages,
    supportedLanguageCount: supportedLanguages.length,
    scannedVideoCount: rows.length,
    standardVideoCount: standardVideos.length,
    shortContentCount: shortContents.length,
    liveContentCount: liveContents.length,
    unknownContentCount: unknownContents.length,
    eligibleNonShortVideoCount: eligibleVideos.length,
    excludedUserVideoCount: excludedUserVideos.length,
    deferredActiveJobVideoCount: deferredActiveJobVideos.length,
    excludedShortVideoCount: excludedShortVideos.length,
    excludedLiveVideoCount: excludedLiveVideos.length,
    excludedUnknownShortRiskVideoCount: excludedUnknownShortRiskVideos.length,
    pendingVideoCount: pendingVideos.length,
    completedVideoCount: completedVideos.length,
    nextCandidate: pendingVideos[0] ?? null,
    pendingVideos,
    completedVideos,
    excludedUserVideos,
    deferredActiveJobVideos,
    excludedShortVideos,
    excludedLiveVideos,
    excludedUnknownShortRiskVideos,
  };
  await writeJsonAtomic(args.output, output);
  process.stdout.write(
    `BACKFILL_INVENTORY_READY scanned=${rows.length} standardVideo=${standardVideos.length} short=${shortContents.length} live=${liveContents.length} unknown=${unknownContents.length} eligibleNonShort=${eligibleVideos.length} excludedUser=${excludedUserVideos.length} deferredActive=${deferredActiveJobVideos.length} excludedShort=${excludedShortVideos.length} excludedLive=${excludedLiveVideos.length} excludedUnknown=${excludedUnknownShortRiskVideos.length} pending=${pendingVideos.length} complete=${completedVideos.length} publicTabMerge=${publicTabDiscovery.mergeEnabled} next=${output.nextCandidate?.videoId ?? "none"}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`BACKFILL_INVENTORY_FAILED ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildPublicTabMembership,
  classifyShort,
  compareRowsNewestFirst,
  discoverPublicTabs,
  mergeUploadsWithPublicTabs,
  parseContentTypeOverrides,
  resolveActiveJobHold,
  resolveContentType,
  resolvePolicyBucket,
  stableUniqueVideoIds,
};
