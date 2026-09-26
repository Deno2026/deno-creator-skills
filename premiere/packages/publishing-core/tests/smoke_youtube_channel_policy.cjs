"use strict";

// 업로드 채널 선택·대조와 채널별 설명 고정 블록 정책(2026-09-24 DENO PICTURES 추가).
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "deno-channel-policy-runtime-"));
process.env.DENO_PRODUCTION_ROOT = path.resolve(__dirname, "..", "..", "..");
process.env.DENO_UPLOAD_HELPER_RUNTIME_ROOT = runtimeRoot;
require("./lib/profile_fixture.cjs").writeProfileFixture(runtimeRoot);

const { resolveUploadChannel } = require("@deno/runtime-paths");
const {
  assertYouTubeChannel,
  channelFromManifest,
  channelRuntimePaths,
  descriptionLinkRequirements,
  parseChannelArg,
  resolveToolChannel,
} = require("../tools/lib/youtube_channel.cjs");
const { validateDescriptionLinkPolicy } = require("../tools/lib/helper_ready_gate.cjs");
const {
  COMFY_REFERRAL_URL,
  DENO_DISCORD_URL,
  composeDescription,
} = require("../tools/build_youtube_metadata_localizations_from_seed.cjs");
const { parseArgs: parseShortArgs } = require("../tools/upload_private_short_from_path.cjs");

const deno = resolveUploadChannel("denoise");
const pictures = resolveUploadChannel("denopictures");
const picturesRecord = {
  id: pictures.id,
  title: pictures.title,
  handle: pictures.handle,
  youtubeChannelId: pictures.youtubeChannelId,
};

// --channel 인자 읽기
assert.equal(parseChannelArg(["--request-id", "x"]), null);
assert.equal(parseChannelArg(["--channel", "denopictures"]), "denopictures");
assert.equal(parseChannelArg(["--channel=denoise"]), "denoise");

// READY 채널: 이전 READY(기록 없음)는 DENO, 기록이 있으면 그 채널, 조작된 ID는 거부
assert.equal(channelFromManifest({}).id, "denoise");
assert.equal(channelFromManifest({ youtubeChannel: picturesRecord }).id, "denopictures");
assert.throws(
  () => channelFromManifest({ youtubeChannel: { ...picturesRecord, youtubeChannelId: deno.youtubeChannelId } }),
  /does not match the channel registry/,
);
assert.throws(() => channelFromManifest({ youtubeChannel: { id: "other" } }), /UNKNOWN_UPLOAD_CHANNEL/);

// 도구 채널: 지정이 없으면 DENO, --channel과 READY 채널이 다르면 멈춘다
assert.equal(resolveToolChannel().id, "denoise");
assert.equal(resolveToolChannel({ channelArg: "denopictures" }).id, "denopictures");
assert.equal(resolveToolChannel({ manifest: { youtubeChannel: picturesRecord } }).id, "denopictures");
assert.throws(
  () => resolveToolChannel({ channelArg: "denoise", manifest: { youtubeChannel: picturesRecord } }),
  /conflicts with the READY channel/,
);

// 채널별 토큰 경로: DENO는 기존 루트 파일, DENO PICTURES는 channels/denopictures/
assert.equal(channelRuntimePaths(deno).oauthTokenPath, path.join(runtimeRoot, "youtube-oauth-token.json"));
assert.equal(
  channelRuntimePaths(pictures).oauthTokenPath,
  path.join(runtimeRoot, "channels", "denopictures", "youtube-oauth-token.json"),
);

// 토큰의 실제 채널 대조
function fakeYouTube(channelId, title) {
  return {
    channels: {
      list: async () => ({ data: { items: channelId ? [{ id: channelId, snippet: { title } }] : [] } }),
    },
  };
}

(async () => {
  const matched = await assertYouTubeChannel(fakeYouTube(pictures.youtubeChannelId, "DENO PICTURES"), pictures);
  assert.equal(matched.id, pictures.youtubeChannelId);
  await assert.rejects(
    assertYouTubeChannel(fakeYouTube(deno.youtubeChannelId, "Deno"), pictures),
    /YOUTUBE_CHANNEL_MISMATCH/,
  );
  await assert.rejects(assertYouTubeChannel(fakeYouTube(null), deno), /YOUTUBE_CHANNEL_MISMATCH/);

  // 설명 고정 링크 요구사항
  assert.deepEqual(descriptionLinkRequirements(deno), {
    affiliateAllowed: true,
    discordRequired: true,
    tutorialBlocks: true,
  });
  assert.deepEqual(descriptionLinkRequirements(deno, { noAffiliateLinks: true }).affiliateAllowed, false);
  assert.deepEqual(descriptionLinkRequirements(pictures), {
    affiliateAllowed: false,
    discordRequired: false,
    tutorialBlocks: false,
  });

  // READY 게이트: DENO는 기존 규칙 그대로, DENO PICTURES는 ComfyUI 추천 금지·Discord 불필요
  const denoDescription = `본문\n\n${COMFY_REFERRAL_URL}\n\n${DENO_DISCORD_URL}`;
  validateDescriptionLinkPolicy({ description: denoDescription });
  assert.throws(
    () => validateDescriptionLinkPolicy({ description: `본문\n\n${COMFY_REFERRAL_URL}` }),
    /required Deno Discord link/,
  );
  const dramaDescription = "줄거리\n“대사”\n\n━━━━━━━━━━━━━━━\nDenoVerse의 AI 창작 드라마입니다.\n\n#작품 #막장드라마 #AI드라마";
  validateDescriptionLinkPolicy({ description: dramaDescription }, false, pictures);
  assert.throws(
    () => validateDescriptionLinkPolicy({ description: `${dramaDescription}\n${COMFY_REFERRAL_URL}` }, false, pictures),
    /must not contain the ComfyUI Deno referral link/,
  );

  // 현지화 설명 조립: DENO 기본값은 그대로, DENO PICTURES는 강의 블록 없이 요약·챕터·해시태그만
  const entry = { summary: "Summary", chapters: ["Intro", "Dinner"] };
  const times = ["00:00", "01:30"];
  const denoDefault = composeDescription(entry, times, "tutorial_with_chapters", { hashtags: ["#Tag"] });
  const denoExplicit = composeDescription(entry, times, "tutorial_with_chapters", {
    includeComfyReferral: true,
    includeDiscord: true,
    tutorialBlocks: true,
    hashtags: ["#Tag"],
  });
  assert.equal(denoExplicit, denoDefault);
  assert.ok(denoDefault.includes("CPU-X") && denoDefault.includes(DENO_DISCORD_URL));
  const drama = composeDescription(entry, times, "tutorial_with_chapters", {
    includeComfyReferral: false,
    includeDiscord: false,
    tutorialBlocks: false,
    hashtags: ["#Tag"],
  });
  assert.equal(drama, "Summary\n\n00:00 Intro\n01:30 Dinner\n\n#Tag");

  // 숏츠 직접 업로드: DENO PICTURES는 설명 블록 기본값이 none, DENO와 검증 모드는 그대로
  const base = ["node", "tool", "--video", "clip.mp4", "--metadata-file", "m.json"];
  assert.equal(parseShortArgs(base).descriptionBlocks, "default");
  assert.equal(parseShortArgs([...base, "--channel", "denoise"]).descriptionBlocks, "default");
  const picturesShort = parseShortArgs([...base, "--channel", "denopictures"]);
  assert.equal(picturesShort.channel, "denopictures");
  assert.equal(picturesShort.descriptionBlocks, "none");
  assert.equal(
    parseShortArgs(["node", "tool", "--verify-only", "--run-id", `private-short-${"a".repeat(64)}`, "--channel", "denopictures"])
      .descriptionBlocks,
    "default",
  );
  assert.throws(() => parseShortArgs([...base, "--channel", "other"]), /UNKNOWN_UPLOAD_CHANNEL/);

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      legacyReadyDefaultsToDeno: true,
      readyChannelConflictBlocked: true,
      tamperedChannelIdRejected: true,
      tokenChannelMismatchBlocked: true,
      picturesDescriptionHasNoTutorialBlocks: true,
      denoDescriptionUnchanged: true,
    })}\n`,
  );
})().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
