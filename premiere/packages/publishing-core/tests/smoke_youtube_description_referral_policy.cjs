#!/usr/bin/env node

const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DENO_UPLOAD_HELPER_RUNTIME_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "deno-description-policy-runtime-"),
);
require("./lib/profile_fixture.cjs").writeProfileFixture(process.env.DENO_UPLOAD_HELPER_RUNTIME_ROOT);

const {
  COMFY_REFERRAL_URL,
  DENO_DISCORD_URL,
  assertExactChapterTimeline,
  composeDescription,
  extractPreservedHashtagLines,
  extractRequiredUrls,
  parseDescriptionChapters,
} = require("../tools/build_youtube_metadata_localizations_from_seed.cjs");
const {
  ensureComfyReferralBlock,
  ensurePermanentDescriptionLinks,
  normalizeMetadata,
} = require("../tools/upload_private_short_from_path.cjs");

function count(value, token) {
  return value.split(token).length - 1;
}

const cinematic = composeDescription(
  { summary: "Localized cinematic summary", chapters: [] },
  [],
  "summary_only",
);
assert.equal(count(cinematic, COMFY_REFERRAL_URL), 1);
assert.equal(count(cinematic, DENO_DISCORD_URL), 1);
assert.doesNotMatch(cinematic, /Disclosure:|commission|additional cost/iu);

const tutorial = composeDescription(
  { summary: "Localized tutorial summary", chapters: ["Start", "Finish"] },
  ["00:00", "01:00"],
  "tutorial_with_chapters",
);
assert.equal(count(tutorial, COMFY_REFERRAL_URL), 1);
assert.equal(count(tutorial, DENO_DISCORD_URL), 1);
assert.match(tutorial, /Creator HUB/u);
assert.match(tutorial, /00:00 Start/u);

const sponsoredTutorial = composeDescription(
  {
    summary: "Sponsored by Pollo AI.\nhttps://bit.ly/example",
    chapters: ["Start", "Middle", "Finish"],
  },
  ["00:00", "01:00", "02:00"],
  "tutorial_with_chapters",
  { includeComfyReferral: false, hashtags: ["#PolloAI #AIVideo"] },
);
const campaignTutorial = composeDescription(
  { summary: "Campaign summary", chapters: ["Start", "Finish"] },
  ["00:00", "01:00"],
  "tutorial_with_chapters",
  { hashtags: ["#Higgsfield #GPT6Astra"] },
);
const orderOf = (token) => {
  const index = campaignTutorial.indexOf(token);
  assert.notEqual(index, -1, `missing ${token}`);
  return index;
};
// 강의 채널 순서: 요약 → 챕터 → HUB → PC Spec → ComfyUI → Discord → 해시태그(publishing-handoff.md 「게시 문구 기준」).
const orderedTokens = ["Campaign summary", "00:00 Start", "01:00 Finish", "Creator HUB", "PC Spec", COMFY_REFERRAL_URL, DENO_DISCORD_URL, "#Higgsfield #GPT6Astra"];
assert.deepEqual(
  orderedTokens.map(orderOf),
  [...orderedTokens.map(orderOf)].sort((left, right) => left - right),
);
assert.ok(campaignTutorial.trimEnd().endsWith("#Higgsfield #GPT6Astra"));

assert.equal(count(sponsoredTutorial, COMFY_REFERRAL_URL), 0);
assert.equal(count(sponsoredTutorial, DENO_DISCORD_URL), 1);
assert.match(sponsoredTutorial, /https:\/\/bit\.ly\/example/u);
assert.match(sponsoredTutorial, /#PolloAI #AIVideo/u);
assert.deepEqual(extractPreservedHashtagLines("text\n#One #Two\n"), ["#One #Two"]);
assert.deepEqual(extractRequiredUrls("https://a.example\nhttps://a.example\nhttps://b.example"), [
  "https://a.example",
  "https://b.example",
]);

const selectedKoreanDescription = [
  "한국어 설명",
  "",
  "00:00 시작",
  "01:00 중간",
  "02:00 마무리",
].join("\n");
assert.deepEqual(parseDescriptionChapters(selectedKoreanDescription), [
  { time: "00:00", title: "시작" },
  { time: "01:00", title: "중간" },
  { time: "02:00", title: "마무리" },
]);
assert.equal(
  assertExactChapterTimeline(
    selectedKoreanDescription,
    ["00:00", "01:00", "02:00"],
    "tutorial_with_chapters",
  ).length,
  3,
);
assert.throws(
  () =>
    assertExactChapterTimeline(
      selectedKoreanDescription,
      ["00:00", "02:00"],
      "tutorial_with_chapters",
    ),
  /must exactly match/iu,
);

const koreanBody = ensureComfyReferralBlock("짧은 영상 설명\n\n#Shorts");
assert.equal(count(koreanBody, COMFY_REFERRAL_URL), 1);
assert.equal(ensureComfyReferralBlock(koreanBody), koreanBody);
assert.doesNotMatch(koreanBody, /수수료|추가 비용/u);
const cleanedLegacyBody = ensureComfyReferralBlock(
  `${koreanBody}\n※ 이 링크로 가입하면 Deno 채널에 수수료가 일부 지급되며, 시청자에게 추가 비용은 없습니다.`,
);
assert.equal(count(cleanedLegacyBody, COMFY_REFERRAL_URL), 1);
assert.doesNotMatch(cleanedLegacyBody, /수수료|추가 비용/u);

const permanentBody = ensurePermanentDescriptionLinks(cleanedLegacyBody);
assert.equal(count(permanentBody, COMFY_REFERRAL_URL), 1);
assert.equal(count(permanentBody, DENO_DISCORD_URL), 1);
assert.equal(ensurePermanentDescriptionLinks(permanentBody), permanentBody);

const shorts = normalizeMetadata({
  title: "짧은 테스트 #Shorts",
  description: "짧은 영상 설명",
  tags: ["Shorts"],
  categoryId: "1",
  madeForKids: false,
  containsSyntheticMedia: false,
  analysis: {
    summary: "세로형 테스트 영상",
    sampleCount: 5,
    metadataRationale: "화면 검토 내용을 짧게 반영",
  },
});
assert.equal(count(shorts.apiMetadata.description, COMFY_REFERRAL_URL), 1);
assert.equal(count(shorts.apiMetadata.description, DENO_DISCORD_URL), 1);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    helperLocalizationReferralBound: true,
    cinematicReferralBound: true,
    shortsReferralBound: true,
    discordChannelBound: true,
    duplicateInsertionPrevented: true,
    exactSelectedChapterTimelineRequired: true,
    sponsoredNoAffiliateLocalizationSupported: true,
  })}\n`,
);
