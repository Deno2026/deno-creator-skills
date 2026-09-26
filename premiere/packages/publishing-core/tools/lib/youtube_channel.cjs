"use strict";

// YouTube 채널 선택과 대조 — 게시 도구 공용.
// - 채널 목록·경로는 @deno/runtime-paths가 소유한다(기본 채널 denoise는 기존 runtime 루트 파일 그대로).
// - READY(upload_request.json)에 youtubeChannel이 있으면 그 채널, 없으면(이전 READY) 기본 채널이다.
// - --channel과 READY 채널이 다르면 멈춘다. 쓰기 전에는 토큰의 실제 채널 ID를 목록의 ID와 대조한다.

const {
  DEFAULT_UPLOAD_CHANNEL_ID,
  getUploadRuntimePaths,
  resolveUploadChannel,
} = require("@deno/runtime-paths");

function parseChannelArg(argv = process.argv.slice(2)) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--channel") return argv[index + 1] ?? "";
    if (typeof arg === "string" && arg.startsWith("--channel=")) return arg.slice("--channel=".length);
  }
  return null;
}

function channelFromManifest(manifest) {
  const recorded = manifest?.youtubeChannel;
  if (recorded === undefined || recorded === null) {
    return resolveUploadChannel(DEFAULT_UPLOAD_CHANNEL_ID);
  }
  const channel = resolveUploadChannel(recorded.id);
  if (recorded.youtubeChannelId !== channel.youtubeChannelId) {
    throw new Error(
      `READY youtubeChannel ${recorded.id} does not match the channel registry (${recorded.youtubeChannelId} != ${channel.youtubeChannelId})`,
    );
  }
  return channel;
}

// channelArg: parseChannelArg 결과(null이면 지정 안 함). manifest: READY manifest(없으면 null).
function resolveToolChannel({ channelArg = null, manifest = null } = {}) {
  const fromManifest = manifest ? channelFromManifest(manifest) : null;
  if (channelArg !== null && channelArg !== undefined) {
    const channel = resolveUploadChannel(channelArg);
    if (fromManifest && fromManifest.id !== channel.id) {
      throw new Error(`--channel ${channel.id} conflicts with the READY channel ${fromManifest.id}`);
    }
    return channel;
  }
  return fromManifest ?? resolveUploadChannel(DEFAULT_UPLOAD_CHANNEL_ID);
}

function channelRuntimePaths(channel, options = {}) {
  return getUploadRuntimePaths({ ...options, channel: channel.id });
}

async function assertYouTubeChannel(youtube, channel) {
  const response = await youtube.channels.list({ part: ["snippet"], mine: true });
  const item = response.data.items?.[0] ?? null;
  if (item?.id !== channel.youtubeChannelId) {
    throw new Error(
      `YOUTUBE_CHANNEL_MISMATCH: expected ${channel.title} ${channel.handle} (${channel.youtubeChannelId}), ` +
        `token belongs to ${item?.snippet?.title ?? "no channel"} (${item?.id ?? "-"})`,
    );
  }
  return item;
}

// 설명 고정 링크 요구사항. DENO: ComfyUI 추천(제휴 금지 영상 제외)·Discord 필수. DENO PICTURES: 둘 다 넣지 않는다.
function descriptionLinkRequirements(channel, { noAffiliateLinks = false } = {}) {
  const links = channel.descriptionLinks;
  return {
    affiliateAllowed: links.comfyReferral && !noAffiliateLinks,
    discordRequired: links.discord,
    tutorialBlocks: links.tutorialBlocks,
  };
}

module.exports = {
  assertYouTubeChannel,
  channelFromManifest,
  channelRuntimePaths,
  descriptionLinkRequirements,
  parseChannelArg,
  resolveToolChannel,
};
