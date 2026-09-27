#!/usr/bin/env node

const path = require("node:path");
const { readFile, rename, writeFile } = require("node:fs/promises");
const { channelFromManifest, descriptionLinkRequirements } = require("./lib/youtube_channel.cjs");

const { getDescriptionBlocks } = require("@deno/runtime-paths");

// 설명 고정 블록(링크·HUB·PC Spec)은 channels.json(descriptionBlocks)에서 온다. 비어 있으면 넣지도 요구하지도 않는다.
const DESCRIPTION_BLOCKS = getDescriptionBlocks();
const COMFY_REFERRAL_URL = DESCRIPTION_BLOCKS.comfyReferral.url;
const DENO_DISCORD_URL = DESCRIPTION_BLOCKS.discord.url;
const linesOf = (text) => String(text ?? "").split(/\r?\n/u).map((line) => line.trimEnd()).filter((line) => line.trim());
const COMFY_REFERRAL_BLOCK_EN = COMFY_REFERRAL_URL ? linesOf(DESCRIPTION_BLOCKS.comfyReferral.en || DESCRIPTION_BLOCKS.comfyReferral.ko || COMFY_REFERRAL_URL) : [];
const DENO_DISCORD_BLOCK_EN = DENO_DISCORD_URL ? linesOf(DESCRIPTION_BLOCKS.discord.en || DESCRIPTION_BLOCKS.discord.ko || DENO_DISCORD_URL) : [];
const HUB_BLOCK = linesOf(DESCRIPTION_BLOCKS.tutorialBlocks.hub);
const PC_SPEC_BLOCK = linesOf(DESCRIPTION_BLOCKS.tutorialBlocks.pcSpec);

function parseArgs(argv) {
  const args = { requestDir: "", seed: "", output: "", videoId: "" };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--request-dir") args.requestDir = argv[++index] ?? "";
    else if (token === "--seed") args.seed = argv[++index] ?? "";
    else if (token === "--output") args.output = argv[++index] ?? "";
    else if (token === "--video-id") args.videoId = argv[++index] ?? "";
    else throw new Error(`Unknown argument: ${token}`);
  }
  for (const [name, value] of Object.entries(args)) {
    if (!value) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function sameStringSet(left, right) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function parseDescriptionChapters(description) {
  return String(description ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .map((line) => line.match(/^(\d{2}:\d{2})\s+(.+)$/u))
    .filter(Boolean)
    .map((match) => ({ time: match[1], title: match[2].trim() }));
}

function assertExactChapterTimeline(description, chapterTimes, descriptionMode) {
  if (descriptionMode !== "tutorial_with_chapters") return [];
  const sourceChapters = parseDescriptionChapters(description);
  if (sourceChapters.length < 3) {
    throw new Error("Exact Korean Helper description must contain at least three chapter lines");
  }
  const sourceChapterTimes = sourceChapters.map((chapter) => chapter.time);
  if (JSON.stringify(chapterTimes) !== JSON.stringify(sourceChapterTimes)) {
    throw new Error(
      `Localization seed chapter timeline must exactly match the selected Korean Helper description: expected=${sourceChapterTimes.length} actual=${chapterTimes.length}`,
    );
  }
  return sourceChapters;
}

function composeDescription(
  entry,
  chapterTimes,
  descriptionMode,
  {
    includeComfyReferral = true,
    includeDiscord = true,
    tutorialBlocks = true,
    hashtags = [],
  } = {},
) {
  const comfyBlock = includeComfyReferral && COMFY_REFERRAL_BLOCK_EN.length ? ["", ...COMFY_REFERRAL_BLOCK_EN] : [];
  const discordBlock = includeDiscord && DENO_DISCORD_BLOCK_EN.length ? ["", ...DENO_DISCORD_BLOCK_EN] : [];
  const hashtagBlock = hashtags.length > 0 ? ["", ...hashtags] : [];
  if (descriptionMode === "summary_only") {
    return [
      entry.summary.trim(),
      ...comfyBlock,
      ...discordBlock,
      ...hashtagBlock,
    ].join("\n");
  }
  // 강의 채널 블록(HUB·PC Spec)을 쓰지 않는 채널(DENO PICTURES)은 요약·챕터·해시태그만 둔다.
  if (!tutorialBlocks) {
    return [
      entry.summary.trim(),
      ...comfyBlock,
      "",
      ...entry.chapters.map((chapter, index) => `${chapterTimes[index]} ${chapter.trim()}`),
      ...hashtagBlock,
      ...discordBlock,
    ].join("\n");
  }
  // 강의 채널 순서는 한국어 설명과 같다: 요약 → 챕터 → HUB → PC Spec → ComfyUI → Discord → 해시태그
  // (publishing-handoff.md 「게시 문구 기준」, 2026-09-27).
  return [
    entry.summary.trim(),
    ...(entry.chapters.length
      ? ["", ...entry.chapters.map((chapter, index) => `${chapterTimes[index]} ${chapter.trim()}`)]
      : []),
    ...(HUB_BLOCK.length ? ["", ...HUB_BLOCK] : []),
    ...(PC_SPEC_BLOCK.length ? ["", ...PC_SPEC_BLOCK] : []),
    ...comfyBlock,
    ...discordBlock,
    ...hashtagBlock,
  ].join("\n");
}

function extractPreservedHashtagLines(description) {
  return String(description ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("#"));
}

function extractRequiredUrls(description) {
  return [...new Set(String(description ?? "").match(/https?:\/\/[^\s]+/gu) ?? [])];
}

async function main() {
  const args = parseArgs(process.argv);
  const requestDir = path.resolve(args.requestDir);
  const request = await readJson(path.join(requestDir, "upload_request.json"));
  const seed = await readJson(path.resolve(args.seed));
  const targetLanguages = request.metadata?.targetLanguages ?? [];
  const translations = seed.translations ?? {};
  const seedLanguages = Object.keys(translations);
  const chapterTimes = seed.chapterTimes ?? [];
  const noManualCinematic =
    request.contentKind === "cinematic" && request.captionPolicy?.mode === "none";
  const descriptionMode = seed.descriptionMode ??
    (noManualCinematic ? "summary_only" : "tutorial_with_chapters");

  if (!Array.isArray(targetLanguages) || targetLanguages.length === 0) {
    throw new Error("Helper request has no targetLanguages");
  }
  if (!sameStringSet(targetLanguages, seedLanguages)) {
    const missing = targetLanguages.filter((language) => !seedLanguages.includes(language));
    const extra = seedLanguages.filter((language) => !targetLanguages.includes(language));
    throw new Error(
      `Seed language set mismatch missing=${missing.join(",") || "none"} extra=${extra.join(",") || "none"}`,
    );
  }
  if (!new Set(["summary_only", "tutorial_with_chapters"]).has(descriptionMode)) {
    throw new Error(`Unsupported descriptionMode: ${descriptionMode}`);
  }
  if (descriptionMode === "summary_only" && !noManualCinematic) {
    throw new Error("summary_only is reserved for cinematic requests with captionPolicy.mode=none");
  }
  if (!Array.isArray(chapterTimes)) {
    throw new Error("Seed chapterTimes must be an array");
  }
  if (
    descriptionMode === "tutorial_with_chapters" &&
    (chapterTimes.length === 0 ||
      chapterTimes.some((time) => typeof time !== "string" || !/^\d{2}:\d{2}$/.test(time)))
  ) {
    throw new Error("Seed chapterTimes must be a non-empty MM:SS string array");
  }
  if (descriptionMode === "summary_only" && chapterTimes.length !== 0) {
    throw new Error("summary_only seed must not contain chapterTimes");
  }
  const sourceChapters = assertExactChapterTimeline(
    request.metadata?.description,
    chapterTimes,
    descriptionMode,
  );
  const noAffiliateLinks = request.metadata?.noAffiliateLinks === true;
  // 현지화 설명의 고정 블록은 READY에 기록된 채널 정책을 따른다(이전 READY는 DENO).
  const youtubeChannel = channelFromManifest(request);
  const linkRules = descriptionLinkRequirements(youtubeChannel, { noAffiliateLinks });
  const sourceDescription = String(request.metadata?.description ?? "");
  const hashtags = extractPreservedHashtagLines(sourceDescription);
  const requiredSourceUrls = extractRequiredUrls(sourceDescription);

  const localizations = {};
  for (const language of targetLanguages) {
    const entry = translations[language];
    if (
      !entry ||
      typeof entry.title !== "string" ||
      !entry.title.trim() ||
      entry.title.trim().length > 100 ||
      typeof entry.summary !== "string" ||
      !entry.summary.trim() ||
      !Array.isArray(entry.chapters ?? []) ||
      (entry.chapters ?? []).length !== chapterTimes.length ||
      (entry.chapters ?? []).some((chapter) => typeof chapter !== "string" || !chapter.trim())
    ) {
      throw new Error(`Invalid localization seed: ${language}`);
    }
    const normalizedEntry = { ...entry, chapters: entry.chapters ?? [] };
    const description = composeDescription(normalizedEntry, chapterTimes, descriptionMode, {
      includeComfyReferral: linkRules.affiliateAllowed,
      includeDiscord: linkRules.discordRequired,
      tutorialBlocks: linkRules.tutorialBlocks,
      hashtags,
    });
    if (description.length > 5000) {
      throw new Error(`Description too long for ${language}: ${description.length}`);
    }
    const requiredTokens = [
      ...requiredSourceUrls,
      ...(linkRules.discordRequired && DENO_DISCORD_URL ? [DENO_DISCORD_URL] : []),
      ...(descriptionMode === "tutorial_with_chapters" && linkRules.tutorialBlocks ? [...HUB_BLOCK, ...PC_SPEC_BLOCK] : []),
      ...(descriptionMode === "tutorial_with_chapters" ? chapterTimes : []),
    ];
    for (const required of requiredTokens) {
      if (!description.includes(required)) {
        throw new Error(`${language} description lost required token: ${required}`);
      }
    }
    if (COMFY_REFERRAL_URL && !linkRules.affiliateAllowed && description.includes(COMFY_REFERRAL_URL)) {
      throw new Error(`${language} description contains a forbidden affiliate link`);
    }
    for (const hashtagLine of hashtags) {
      if (!description.includes(hashtagLine)) {
        throw new Error(`${language} description lost required hashtag line`);
      }
    }
    localizations[language] = {
      title: entry.title.trim(),
      description,
    };
  }

  const output = {
    schemaVersion: 1,
    videoId: args.videoId,
    defaultLanguage: request.metadata.defaultLanguage ?? "ko",
    descriptionMode,
    generatedAt: new Date().toISOString(),
    supportedLanguages: targetLanguages,
    supportedLanguageCount: targetLanguages.length,
    sourceChapterCount: sourceChapters.length,
    noAffiliateLinks,
    youtubeChannel: youtubeChannel.id,
    preservedHashtagLines: hashtags,
    requiredSourceUrls,
    localizations,
  };
  const outputPath = path.resolve(args.output);
  const tempPath = `${outputPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await rename(tempPath, outputPath);
  process.stdout.write(
    `METADATA_LOCALIZATIONS_READY video=${args.videoId} languages=${targetLanguages.length} output=${outputPath}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`METADATA_LOCALIZATIONS_FAILED ${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  COMFY_REFERRAL_URL,
  DENO_DISCORD_URL,
  assertExactChapterTimeline,
  composeDescription,
  extractPreservedHashtagLines,
  extractRequiredUrls,
  parseDescriptionChapters,
};
