"use strict";

// 테스트용 게시 프로필(channels.json) — 실제 채널·링크가 아니라 예시 값이다. 도구는 적재 때 읽으므로 require 전에 쓴다.
const fs = require("node:fs");
const path = require("node:path");

const FIXTURE = Object.freeze({
  schemaVersion: 1,
  defaultChannel: "denoise",
  channels: [
    {
      id: "denoise",
      title: "Deno",
      handle: "@denoise",
      youtubeChannelId: "UC0123456789abcdefghijkl",
      descriptionLinks: { comfyReferral: true, discord: true, tutorialBlocks: true },
      uploadDefaults: { presetName: "기본 롱폼", tags: "tutorial" },
    },
    {
      id: "denopictures",
      title: "DENO PICTURES",
      handle: "@denopictures",
      youtubeChannelId: "UCabcdefghijkl0123456789",
      descriptionLinks: { comfyReferral: false, discord: false, tutorialBlocks: false },
      uploadDefaults: { presetName: "드라마", description: "줄거리 한두 줄\n\n#drama", tags: "drama", categoryId: "1", containsSyntheticMedia: true },
    },
  ],
  descriptionBlocks: {
    comfyReferral: {
      url: "https://www.comfy.org/?via=example",
      ko: "☁️ ComfyUI 공식 홈페이지 (추천 링크)\nhttps://www.comfy.org/?via=example",
      en: "☁️ ComfyUI Official Website (referral link)\nhttps://www.comfy.org/?via=example",
    },
    discord: {
      url: "https://discord.com/invite/example",
      ko: "💬 Discord 채널\nhttps://discord.com/invite/example",
      en: "💬 Discord Community\nhttps://discord.com/invite/example",
    },
    tutorialBlocks: { hub: "🚀 Creator HUB (Workflow, Tools)\nhttps://example.com/hub", pcSpec: "💻 PC Spec\nCPU-X\n64GB RAM\nGPU-Y" },
    pinnedCommentHandle: "@denoise",
  },
});

function writeProfileFixture(runtimeRoot) {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "channels.json"), `${JSON.stringify(FIXTURE, null, 2)}\n`, "utf8");
  return FIXTURE;
}

module.exports = {
  FIXTURE,
  writeProfileFixture,
  COMFY_REFERRAL_URL: FIXTURE.descriptionBlocks.comfyReferral.url,
  DENO_DISCORD_URL: FIXTURE.descriptionBlocks.discord.url,
};
