"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_UPLOAD_CHANNEL_ID,
  PUBLISHING_PROFILE_FILE,
  UPLOAD_CHANNELS,
  getDescriptionBlocks,
  loadPublishingProfile,
  assertPathWithin,
  getMfaRuntimePaths,
  getProductionPaths,
  getUploadRuntimePaths,
  getSocialPublishingRuntimePaths,
  requireSafeSlug,
  resolveUploadChannel,
} = require("..");

test("runtime root is mandatory and must be absolute", () => {
  assert.throws(
    () => getUploadRuntimePaths({ env: {} }),
    /DENO_UPLOAD_HELPER_RUNTIME_ROOT_REQUIRED/,
  );
  assert.throws(
    () =>
      getUploadRuntimePaths({
        env: { DENO_UPLOAD_HELPER_RUNTIME_ROOT: ".local" },
      }),
    /DENO_UPLOAD_HELPER_RUNTIME_ROOT_MUST_BE_ABSOLUTE/,
  );
});

test("runtime data stays outside the source tree when configured externally", () => {
  const runtimeRoot = path.resolve("D:/runtime/youtube-upload-helper");
  const paths = getUploadRuntimePaths({
    env: { DENO_UPLOAD_HELPER_RUNTIME_ROOT: runtimeRoot },
  });
  assert.equal(paths.runtimeRoot, runtimeRoot);
  assert.equal(
    paths.uploadRequestsRoot,
    path.join(runtimeRoot, "upload-requests"),
  );
});

test("MFA runtime defaults outside source and rejects whitespace paths", () => {
  const paths = getMfaRuntimePaths({
    env: { LOCALAPPDATA: "C:/Users/someone/AppData/Local" },
  });
  assert.equal(
    paths.runtimeRoot,
    path.resolve("C:/Users/someone/AppData/Local/DENO/PremiereCaptionMFA"),
  );
  assert.equal(paths.environmentRoot, path.join(paths.runtimeRoot, "env"));
  assert.throws(
    () => getMfaRuntimePaths({ env: { DENO_MFA_RUNTIME_ROOT: "E:/DENO Runtime/MFA" } }),
    /MUST_NOT_CONTAIN_WHITESPACE/,
  );
});

test("canonical production handoff paths are stable", () => {
  const productionRoot = path.resolve("D:/work/production-root");
  const paths = getProductionPaths("demo-video", {
    env: { DENO_PRODUCTION_ROOT: productionRoot },
  });
  assert.equal(
    paths.finalKoreanPath,
    path.join(productionRoot, "productions", "demo-video", "captions", "final-ko.srt"),
  );
  assert.equal(
    paths.masterManifestPath,
    path.join(productionRoot, "productions", "demo-video", "delivery", "master-manifest.json"),
  );
  assert.equal(
    paths.publishingHandoffPath,
    path.join(productionRoot, "productions", "demo-video", "publishing", "handoff.json"),
  );
});

test("social publishing runtime has an external default and explicit absolute override", () => {
  const defaults = getSocialPublishingRuntimePaths({ env: { LOCALAPPDATA: "C:/Users/someone/AppData/Local" }, cwd: os.tmpdir() });
  assert.equal(defaults.runtimeRoot, path.resolve("C:/Users/someone/AppData/Local/DenoCreatorSkills/social-publishing"));
  const root = path.resolve("tmp/social runtime");
  const configured = getSocialPublishingRuntimePaths({ env: { DENO_SOCIAL_PUBLISHING_RUNTIME_ROOT: root } });
  assert.equal(configured.runsRoot, path.join(root, "runs"));
  assert.equal(configured.instagramTokenPath, path.join(root, "instagram-oauth-token.json"));
  assert.equal(configured.threadsSettingsPath, path.join(root, "threads-settings.json"));
  assert.equal(configured.threadsTokenPath, path.join(root, "threads-oauth-token.json"));
  assert.equal(configured.xSettingsPath, path.join(root, "x-settings.json"));
  assert.equal(configured.xTokenPath, path.join(root, "x-oauth-token.json"));
  assert.equal(configured.r2SettingsPath, path.join(root, "r2-settings.json"));
  assert.throws(() => getSocialPublishingRuntimePaths({ env: { DENO_SOCIAL_PUBLISHING_RUNTIME_ROOT: "relative" } }), /MUST_BE_ABSOLUTE/);
});

test("slug and path boundary checks reject traversal", () => {
  assert.equal(requireSafeSlug("video-01"), "video-01");
  assert.throws(() => requireSafeSlug("../video"), /INVALID_PRODUCTION_SLUG/);
  assert.throws(
    () => assertPathWithin("E:/outside/file", "E:/inside"),
    /PATH_OUTSIDE_ROOT/,
  );
});

test("without channels.json the publishing profile is one default channel without links", () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-paths-profile-"));
  const env = { DENO_UPLOAD_HELPER_RUNTIME_ROOT: runtimeRoot };
  const profile = loadPublishingProfile({ env, reload: true });
  assert.equal(profile.source, "builtin");
  assert.deepEqual(profile.channels.map((channel) => channel.id), ["default"]);
  assert.equal(profile.defaultChannel, "default");
  assert.equal(getDescriptionBlocks({ env }).comfyReferral.url, "");
  const defaults = getUploadRuntimePaths({ env });
  assert.equal(defaults.channelId, "default");
  assert.equal(defaults.oauthTokenPath, path.join(runtimeRoot, "youtube-oauth-token.json"));
  assert.throws(() => resolveUploadChannel("other", { env }), /UNKNOWN_UPLOAD_CHANNEL/);
});

test("channels.json defines channels, the default channel root and description blocks", () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-paths-profile-"));
  const env = { DENO_UPLOAD_HELPER_RUNTIME_ROOT: runtimeRoot };
  fs.writeFileSync(
    path.join(runtimeRoot, PUBLISHING_PROFILE_FILE),
    JSON.stringify({
      defaultChannel: "main",
      channels: [
        { id: "main", title: "Main", handle: "@main", youtubeChannelId: "UC0123456789abcdefghijkl", descriptionLinks: { comfyReferral: true, discord: true, tutorialBlocks: true } },
        { id: "drama", title: "Drama", handle: "@drama", youtubeChannelId: "UCabcdefghijkl0123456789", descriptionLinks: { discord: false }, uploadDefaults: { categoryId: "1" } },
      ],
      descriptionBlocks: { comfyReferral: { url: "https://example.com/?via=x", ko: "☁️ 링크\nhttps://example.com/?via=x" }, tutorialBlocks: { hub: "🚀 HUB\nhttps://example.com/hub" } },
    }),
  );
  const profile = loadPublishingProfile({ env, reload: true });
  assert.deepEqual(profile.channels.map((channel) => channel.id), ["main", "drama"]);
  assert.deepEqual({ ...resolveUploadChannel(undefined, { env }).descriptionLinks }, { comfyReferral: true, discord: true, tutorialBlocks: true });
  assert.deepEqual({ ...resolveUploadChannel("drama", { env }).descriptionLinks }, { comfyReferral: false, discord: false, tutorialBlocks: false });
  assert.deepEqual(resolveUploadChannel("drama", { env }).uploadDefaults, { categoryId: "1" });
  assert.equal(getDescriptionBlocks({ env }).comfyReferral.url, "https://example.com/?via=x");
  assert.equal(getDescriptionBlocks({ env }).discord.url, "");

  const defaults = getUploadRuntimePaths({ env });
  assert.equal(defaults.channelId, "main");
  assert.equal(defaults.oauthTokenPath, path.join(runtimeRoot, "youtube-oauth-token.json"));
  assert.equal(defaults.presetsPath, path.join(runtimeRoot, "upload-presets.json"));
  assert.deepEqual(getUploadRuntimePaths({ env, channel: "main" }), defaults);
  const drama = getUploadRuntimePaths({ env, channel: "drama" });
  const dramaRoot = path.join(runtimeRoot, "channels", "drama");
  assert.equal(drama.channelRoot, dramaRoot);
  assert.equal(drama.oauthTokenPath, path.join(dramaRoot, "youtube-oauth-token.json"));
  assert.equal(drama.presetsPath, path.join(dramaRoot, "upload-presets.json"));
  assert.equal(drama.channelProfilePath, path.join(dramaRoot, "channel-profile.json"));
  // OAuth client settings, READY requests and run evidence stay shared.
  assert.equal(drama.settingsPath, defaults.settingsPath);
  assert.equal(drama.uploadRequestsRoot, defaults.uploadRequestsRoot);
  assert.equal(drama.activeChannelPath, path.join(runtimeRoot, "active-upload-channel.json"));
  assert.throws(() => getUploadRuntimePaths({ env, channel: "../main" }), /UNKNOWN_UPLOAD_CHANNEL/);

  fs.writeFileSync(path.join(runtimeRoot, PUBLISHING_PROFILE_FILE), JSON.stringify({ channels: [{ id: "Bad Id", title: "x" }] }));
  assert.throws(() => loadPublishingProfile({ env, reload: true }), /PUBLISHING_PROFILE_INVALID/);
});
