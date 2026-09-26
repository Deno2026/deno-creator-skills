"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ENV = Object.freeze({
  productionRoot: "DENO_PRODUCTION_ROOT",
  uploadRuntimeRoot: "DENO_UPLOAD_HELPER_RUNTIME_ROOT",
  socialRuntimeRoot: "DENO_SOCIAL_PUBLISHING_RUNTIME_ROOT",
  mfaRuntimeRoot: "DENO_MFA_RUNTIME_ROOT",
});

function isSafeSlug(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 120 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function requireSafeSlug(value) {
  if (!isSafeSlug(value)) {
    throw new Error("INVALID_PRODUCTION_SLUG");
  }
  return value;
}

function resolveAbsoluteEnvPath(name, env = process.env, options = {}) {
  const raw = env[name]?.trim();
  if (!raw) {
    if (options.optional) return null;
    throw new Error(`${name}_REQUIRED`);
  }
  if (!path.isAbsolute(raw)) {
    throw new Error(`${name}_MUST_BE_ABSOLUTE`);
  }
  return path.resolve(raw);
}

function looksLikeProductionRoot(candidate) {
  return (
    fs.existsSync(path.join(candidate, "AGENTS.md")) &&
    fs.existsSync(path.join(candidate, "productions")) &&
    fs.existsSync(path.join(candidate, "packages"))
  );
}

function findProductionRoot(options = {}) {
  const envRoot = resolveAbsoluteEnvPath(ENV.productionRoot, options.env, {
    optional: true,
  });
  if (envRoot) return envRoot;

  let candidate = path.resolve(options.cwd ?? process.cwd());
  for (;;) {
    if (looksLikeProductionRoot(candidate)) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error(`${ENV.productionRoot}_REQUIRED`);
}

// ── 게시 프로필: 채널 목록·기본 채널·설명 고정 블록 ────────────────────────────────────────────
// <DENO_UPLOAD_HELPER_RUNTIME_ROOT>/channels.json 이 소유한다(개인 채널 ID·링크는 코드에 두지 않는다 — 2026-09-27 Deno Creator Skills 키트).
// 파일이 없으면 링크 없는 채널 하나("default")로 동작한다. 틀은 templates/channels.example.json. 파일을 고치면 앱·도구를 다시 시작한다(적재 때 한 번 읽는다).
const PUBLISHING_PROFILE_FILE = "channels.json";
const CHANNEL_ID_PATTERN = /^[a-z0-9]+$/;
const YOUTUBE_CHANNEL_ID_PATTERN = /^UC[\w-]{22}$/;
const EMPTY_LINK_BLOCK = Object.freeze({ url: "", ko: "", en: "" });
const BUILTIN_PUBLISHING_PROFILE = Object.freeze({
  schemaVersion: 1,
  source: "builtin",
  defaultChannel: "default",
  channels: Object.freeze([
    Object.freeze({
      id: "default",
      title: "My YouTube channel",
      handle: "",
      youtubeChannelId: "",
      descriptionLinks: Object.freeze({ comfyReferral: false, discord: false, tutorialBlocks: false }),
      uploadDefaults: null,
      aliases: Object.freeze([]),
    }),
  ]),
  descriptionBlocks: Object.freeze({
    comfyReferral: EMPTY_LINK_BLOCK,
    discord: EMPTY_LINK_BLOCK,
    tutorialBlocks: Object.freeze({ hub: "", pcSpec: "" }),
    pinnedCommentHandle: "",
  }),
});

function profileError(filePath, detail) {
  return new Error(`PUBLISHING_PROFILE_INVALID: ${detail} (${filePath})`);
}

function stringField(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizeLinkBlock(raw, filePath, name) {
  if (raw === undefined || raw === null) return EMPTY_LINK_BLOCK;
  if (typeof raw !== "object") throw profileError(filePath, `descriptionBlocks.${name} must be an object`);
  const url = stringField(raw.url).trim();
  if (url && !/^https?:\/\//u.test(url)) throw profileError(filePath, `descriptionBlocks.${name}.url must be an http(s) URL`);
  return Object.freeze({ url, ko: stringField(raw.ko), en: stringField(raw.en) });
}

function normalizePublishingProfile(raw, filePath) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw profileError(filePath, "root must be an object");
  if (!Array.isArray(raw.channels) || raw.channels.length === 0) throw profileError(filePath, "channels must be a non-empty array");
  const seen = new Set();
  const channels = raw.channels.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw profileError(filePath, `channels[${index}] must be an object`);
    const id = stringField(entry.id).trim();
    if (!CHANNEL_ID_PATTERN.test(id)) throw profileError(filePath, `channels[${index}].id must be lowercase letters and digits`);
    if (seen.has(id)) throw profileError(filePath, `duplicate channel id ${id}`);
    seen.add(id);
    const title = stringField(entry.title).trim();
    if (!title) throw profileError(filePath, `channels[${index}].title is required`);
    const youtubeChannelId = stringField(entry.youtubeChannelId).trim();
    if (youtubeChannelId && !YOUTUBE_CHANNEL_ID_PATTERN.test(youtubeChannelId)) {
      throw profileError(filePath, `channels[${index}].youtubeChannelId must look like UC…`);
    }
    const links = entry.descriptionLinks && typeof entry.descriptionLinks === "object" ? entry.descriptionLinks : {};
    const uploadDefaults = entry.uploadDefaults && typeof entry.uploadDefaults === "object" ? Object.freeze({ ...entry.uploadDefaults }) : null;
    return Object.freeze({
      id,
      title,
      handle: stringField(entry.handle).trim(),
      youtubeChannelId,
      descriptionLinks: Object.freeze({
        comfyReferral: links.comfyReferral === true,
        discord: links.discord === true,
        tutorialBlocks: links.tutorialBlocks === true,
      }),
      uploadDefaults,
      aliases: Object.freeze(Array.isArray(entry.aliases) ? entry.aliases.filter((alias) => typeof alias === "string" && alias.trim()).map((alias) => alias.trim()) : []),
    });
  });
  const defaultChannel = stringField(raw.defaultChannel, channels[0].id).trim() || channels[0].id;
  if (!seen.has(defaultChannel)) throw profileError(filePath, `defaultChannel ${defaultChannel} is not in channels`);
  const blocks = raw.descriptionBlocks && typeof raw.descriptionBlocks === "object" ? raw.descriptionBlocks : {};
  const tutorial = blocks.tutorialBlocks && typeof blocks.tutorialBlocks === "object" ? blocks.tutorialBlocks : {};
  return Object.freeze({
    schemaVersion: 1,
    source: filePath,
    defaultChannel,
    channels: Object.freeze(channels),
    descriptionBlocks: Object.freeze({
      comfyReferral: normalizeLinkBlock(blocks.comfyReferral, filePath, "comfyReferral"),
      discord: normalizeLinkBlock(blocks.discord, filePath, "discord"),
      tutorialBlocks: Object.freeze({ hub: stringField(tutorial.hub), pcSpec: stringField(tutorial.pcSpec) }),
      pinnedCommentHandle: stringField(blocks.pinnedCommentHandle).trim(),
    }),
  });
}

const profileCache = new Map();

/** 게시 프로필. options.env로 런타임 루트를 정하고, options.reload면 파일을 다시 읽는다. 파일이 없으면 내장 기본값. */
function loadPublishingProfile(options = {}) {
  const runtimeRoot = resolveAbsoluteEnvPath(ENV.uploadRuntimeRoot, options.env, { optional: true });
  const filePath = runtimeRoot ? path.join(runtimeRoot, PUBLISHING_PROFILE_FILE) : null;
  const key = filePath ?? "<builtin>";
  if (!options.reload && profileCache.has(key)) return profileCache.get(key);
  let profile = BUILTIN_PUBLISHING_PROFILE;
  if (filePath && fs.existsSync(filePath)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
    } catch (error) {
      throw profileError(filePath, `not valid JSON: ${error.message}`);
    }
    profile = normalizePublishingProfile(parsed, filePath);
  }
  profileCache.set(key, profile);
  return profile;
}

function getDescriptionBlocks(options = {}) {
  return loadPublishingProfile(options).descriptionBlocks;
}

// 적재 시점의 프로필(process.env 기준). 소비자 대부분은 이 둘만 쓴다.
const LOADED_PROFILE = loadPublishingProfile();
const UPLOAD_CHANNELS = LOADED_PROFILE.channels;
const DEFAULT_UPLOAD_CHANNEL_ID = LOADED_PROFILE.defaultChannel;

function resolveUploadChannel(channelId, options = {}) {
  const profile = options.env ? loadPublishingProfile(options) : LOADED_PROFILE;
  const id = channelId == null || channelId === "" ? profile.defaultChannel : channelId;
  const channel = profile.channels.find((item) => item.id === id);
  if (!channel) throw new Error("UNKNOWN_UPLOAD_CHANNEL");
  return channel;
}

function getUploadRuntimePaths(options = {}) {
  const runtimeRoot = resolveAbsoluteEnvPath(
    ENV.uploadRuntimeRoot,
    options.env,
  );
  const channel = resolveUploadChannel(options.channel, options);
  const defaultChannelId = options.env ? loadPublishingProfile(options).defaultChannel : DEFAULT_UPLOAD_CHANNEL_ID;
  const channelRoot =
    channel.id === defaultChannelId
      ? runtimeRoot
      : path.join(runtimeRoot, "channels", channel.id);
  return Object.freeze({
    runtimeRoot,
    channelId: channel.id,
    channelRoot,
    activeChannelPath: path.join(runtimeRoot, "active-upload-channel.json"),
    oauthPendingStatePath: path.join(runtimeRoot, "oauth-pending-state.json"),
    settingsPath: path.join(runtimeRoot, "youtube-settings.json"),
    oauthTokenPath: path.join(channelRoot, "youtube-oauth-token.json"),
    llmSettingsPath: path.join(runtimeRoot, "llm-settings.json"),
    agentWorkspaceTokenPath: path.join(runtimeRoot, "agent-workspace-token.txt"),
    uploadRequestsRoot: path.join(runtimeRoot, "upload-requests"),
    uploadVideoStagingRoot: path.join(runtimeRoot, "upload-video-staging"),
    productionPreparationsRoot: path.join(runtimeRoot, "production-preparations"),
    runsRoot: path.join(runtimeRoot, "runs"),
    directShortInspectionsRoot: path.join(runtimeRoot, "direct-shorts-inspections"),
    directShortUploadsRoot: path.join(runtimeRoot, "direct-shorts-uploads"),
    videoOverlayPolicyPath: path.join(runtimeRoot, "video-overlay-policy.json"),
    presetsPath: path.join(channelRoot, "upload-presets.json"),
    channelProfilePath: path.join(channelRoot, "channel-profile.json"),
    metadataBackfillRoot: path.join(runtimeRoot, "metadata-backfill"),
    backfillActiveStatePath: path.join(
      runtimeRoot,
      "metadata-backfill",
      "active-job-snapshot.json",
    ),
  });
}

// 리포 루트의 local.config.json(추적하지 않음 — 이 PC의 런타임 폴더들). 환경변수가 없을 때의 기본값.
const LOCAL_CONFIG_FILE = "local.config.json";
function readLocalConfig(options = {}) {
  try {
    const root = findProductionRoot(options);
    const filePath = path.join(root, LOCAL_CONFIG_FILE);
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function defaultRuntimeRoot(name, env = process.env) {
  const base = env.LOCALAPPDATA?.trim() || path.join(env.USERPROFILE ?? env.HOME ?? ".", "AppData", "Local");
  return path.resolve(base, "DenoCreatorSkills", name);
}

/** 업로드 헬퍼 런타임 루트: 환경변수 → local.config.json uploadRuntimeRoot → %LOCALAPPDATA%\DenoCreatorSkills\youtube-upload-helper */
function resolveUploadRuntimeRootDefault(options = {}) {
  const env = options.env ?? process.env;
  return resolveAbsoluteEnvPath(ENV.uploadRuntimeRoot, env, { optional: true })
    ?? (typeof readLocalConfig(options).uploadRuntimeRoot === "string" ? path.resolve(readLocalConfig(options).uploadRuntimeRoot) : null)
    ?? defaultRuntimeRoot("youtube-upload-helper", env);
}

function getSocialPublishingRuntimePaths(options = {}) {
  const env = options.env ?? process.env;
  const local = readLocalConfig(options);
  const runtimeRoot = resolveAbsoluteEnvPath(ENV.socialRuntimeRoot, options.env, { optional: true })
    ?? (typeof local.socialRuntimeRoot === "string" ? path.resolve(local.socialRuntimeRoot) : null)
    ?? defaultRuntimeRoot("social-publishing", env);
  return Object.freeze({
    runtimeRoot,
    settingsPath: path.join(runtimeRoot, "social-settings.json"),
    instagramSettingsPath: path.join(runtimeRoot, "instagram-settings.json"),
    instagramTokenPath: path.join(runtimeRoot, "instagram-oauth-token.json"),
    threadsSettingsPath: path.join(runtimeRoot, "threads-settings.json"),
    threadsTokenPath: path.join(runtimeRoot, "threads-oauth-token.json"),
    xSettingsPath: path.join(runtimeRoot, "x-settings.json"),
    xTokenPath: path.join(runtimeRoot, "x-oauth-token.json"),
    r2SettingsPath: path.join(runtimeRoot, "r2-settings.json"),
    runsRoot: path.join(runtimeRoot, "runs"),
    logsRoot: path.join(runtimeRoot, "logs"),
  });
}

function getMfaRuntimePaths(options = {}) {
  const env = options.env ?? process.env;
  const configured = resolveAbsoluteEnvPath(ENV.mfaRuntimeRoot, env, {
    optional: true,
  });
  const localAppData = env.LOCALAPPDATA?.trim();
  const runtimeRoot = configured ?? (
    localAppData
      ? path.resolve(localAppData, "DENO", "PremiereCaptionMFA")
      : null
  );
  if (!runtimeRoot) throw new Error(`${ENV.mfaRuntimeRoot}_REQUIRED`);
  if (/\s/u.test(runtimeRoot)) {
    throw new Error(`${ENV.mfaRuntimeRoot}_MUST_NOT_CONTAIN_WHITESPACE`);
  }
  return Object.freeze({
    runtimeRoot,
    environmentRoot: path.join(runtimeRoot, "env"),
    mfaRoot: path.join(runtimeRoot, "mfa-root"),
    workRoot: path.join(runtimeRoot, "work"),
  });
}

function getProductionPaths(slug, options = {}) {
  const safeSlug = requireSafeSlug(slug);
  const productionRoot = findProductionRoot(options);
  const productionDir = path.join(productionRoot, "productions", safeSlug);
  const captionsDir = path.join(productionDir, "captions");
  const deliveryDir = path.join(productionDir, "delivery");
  const publishingDir = path.join(productionDir, "publishing");
  return Object.freeze({
    productionRoot,
    productionsRoot: path.join(productionRoot, "productions"),
    productionDir,
    statePath: path.join(productionDir, "STATE.json"),
    captionsDir,
    finalKoreanPath: path.join(captionsDir, "final-ko.srt"),
    cleanKoreanPath: path.join(captionsDir, "clean-ko.srt"),
    reviewedEnglishPath: path.join(captionsDir, "reviewed-en.srt"),
    englishReviewPath: path.join(captionsDir, "english-review.md"),
    captionSourceLockPath: path.join(captionsDir, "caption-source-lock.json"),
    deliveryDir,
    masterManifestPath: path.join(deliveryDir, "master-manifest.json"),
    publishingDir,
    publishingHandoffPath: path.join(publishingDir, "handoff.json"),
    helperProjectPath: path.join(publishingDir, "video-project.json"),
  });
}

function assertPathWithin(candidatePath, parentPath, code = "PATH_OUTSIDE_ROOT") {
  const candidate = path.resolve(candidatePath);
  const parent = path.resolve(parentPath);
  const relative = path.relative(parent, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(code);
  }
  return candidate;
}

module.exports = {
  BUILTIN_PUBLISHING_PROFILE,
  DEFAULT_UPLOAD_CHANNEL_ID,
  ENV,
  PUBLISHING_PROFILE_FILE,
  UPLOAD_CHANNELS,
  getDescriptionBlocks,
  loadPublishingProfile,
  assertPathWithin,
  findProductionRoot,
  getMfaRuntimePaths,
  getProductionPaths,
  getUploadRuntimePaths,
  getSocialPublishingRuntimePaths,
  isSafeSlug,
  readLocalConfig,
  resolveUploadRuntimeRootDefault,
  requireSafeSlug,
  resolveAbsoluteEnvPath,
  resolveUploadChannel,
};
