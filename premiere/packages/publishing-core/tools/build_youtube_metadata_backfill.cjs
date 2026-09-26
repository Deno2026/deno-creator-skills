#!/usr/bin/env node

const path = require("node:path");
const { readdir, readFile, rename, writeFile } = require("node:fs/promises");
const {
  isValidGeneratedDescription,
} = require("./lib/youtube_metadata_backfill_policy.cjs");

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--package-dir") {
      args.packageDir = argv[++index];
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!args.packageDir) {
    throw new Error("--package-dir is required");
  }
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function matches(value, pattern) {
  return value.match(pattern) ?? [];
}

function sameArray(expected, actual) {
  return JSON.stringify(expected) === JSON.stringify(actual);
}

function assertSameArray(language, label, expected, actual) {
  if (!sameArray(expected, actual)) {
    throw new Error(`${language}: ${label} changed`);
  }
}

function countOccurrences(value, token) {
  return value.split(token).length - 1;
}

function validateLocalization(language, value, source, protectedTokens) {
  if (!value || typeof value.title !== "string" || typeof value.description !== "string") {
    throw new Error(`${language}: title and description are required`);
  }
  if (!value.title.trim() || value.title.length > 100) {
    throw new Error(`${language}: invalid title length ${value.title.length}`);
  }
  if (!isValidGeneratedDescription(source.description, value.description)) {
    throw new Error(`${language}: invalid description length ${value.description.length}`);
  }
  if (/[ᄀ-ᇿ㄰-㆏가-힣]/u.test(`${value.title}\n${value.description}`)) {
    throw new Error(`${language}: untranslated Korean text remains`);
  }

  assertSameArray(
    language,
    "title number sequence",
    matches(source.title, /\d+(?:\.\d+)?/g),
    matches(value.title, /\d+(?:\.\d+)?/g),
  );
  assertSameArray(
    language,
    "title hashtag sequence",
    matches(source.title, /#[^\s]+/g),
    matches(value.title, /#[^\s]+/g),
  );
  assertSameArray(
    language,
    "URL sequence",
    matches(source.description, /https?:\/\/[^\s]+/g),
    matches(value.description, /https?:\/\/[^\s]+/g),
  );
  assertSameArray(
    language,
    "timestamp sequence",
    matches(source.description, /\b\d{2}:\d{2}\b/g),
    matches(value.description, /\b\d{2}:\d{2}\b/g),
  );
  assertSameArray(
    language,
    "number multiset",
    matches(source.description, /\d+(?:\.\d+)?/g).sort(),
    matches(value.description, /\d+(?:\.\d+)?/g).sort(),
  );
  assertSameArray(
    language,
    "percentage sequence",
    matches(source.description, /\d+(?:\.\d+)?%/g),
    matches(value.description, /\d+(?:\.\d+)?%/g),
  );
  const sourceHashtags = matches(source.description, /#[^\s]+/g);
  const translatedHashtags = matches(value.description, /#[^\s]+/g);
  if (sourceHashtags.length !== translatedHashtags.length) {
    throw new Error(
      `${language}: hashtag count changed (${sourceHashtags.length} -> ${translatedHashtags.length})`,
    );
  }

  const sourceLines = source.description.replace(/\r\n/g, "\n").split("\n");
  const translatedLines = value.description.replace(/\r\n/g, "\n").split("\n");
  if (sourceLines.length !== translatedLines.length) {
    throw new Error(`${language}: line count changed (${sourceLines.length} -> ${translatedLines.length})`);
  }
  assertSameArray(
    language,
    "blank-line structure",
    sourceLines.map((line) => line === ""),
    translatedLines.map((line) => line === ""),
  );
  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
    assertSameArray(
      language,
      `number set on description line ${lineIndex + 1}`,
      matches(sourceLines[lineIndex], /\d+(?:\.\d+)?/g).sort(),
      matches(translatedLines[lineIndex], /\d+(?:\.\d+)?/g).sort(),
    );
  }

  for (const token of protectedTokens) {
    const sourceCount = countOccurrences(`${source.title}\n${source.description}`, token);
    const translatedCount = countOccurrences(`${value.title}\n${value.description}`, token);
    if (sourceCount !== translatedCount) {
      throw new Error(`${language}: protected token count changed for ${token}`);
    }
  }

  return {
    titleLength: value.title.length,
    descriptionLength: value.description.length,
    lineCount: translatedLines.length,
  };
}

async function main() {
  const { packageDir } = parseArgs(process.argv);
  const absolutePackageDir = path.resolve(packageDir);
  const source = await readJson(path.join(absolutePackageDir, "source_snapshot.json"));
  const files = await readdir(absolutePackageDir);
  const shardFiles = files.filter((name) => /^translation_shard_.+\.json$/u.test(name)).sort();
  if (shardFiles.length === 0) {
    throw new Error("At least one translation_shard_*.json file is required");
  }

  const protectedTokensPath = path.join(absolutePackageDir, "protected_tokens.json");
  const protectedTokens = files.includes("protected_tokens.json")
    ? await readJson(protectedTokensPath)
    : [];
  if (!Array.isArray(protectedTokens) || protectedTokens.some((token) => typeof token !== "string")) {
    throw new Error("protected_tokens.json must be a string array");
  }

  const generated = {};
  for (const shardFile of shardFiles) {
    const shard = await readJson(path.join(absolutePackageDir, shardFile));
    for (const [language, value] of Object.entries(shard)) {
      if (Object.hasOwn(generated, language)) {
        throw new Error(`Duplicate generated language: ${language}`);
      }
      generated[language] = value;
    }
  }

  const expectedLanguages = source.missingLanguages;
  assertSameArray(
    "all",
    "generated language set",
    [...expectedLanguages].sort(),
    Object.keys(generated).sort(),
  );

  const generatedLocalizations = {};
  const validation = {};
  for (const language of expectedLanguages) {
    validation[language] = validateLocalization(
      language,
      generated[language],
      source.immutable,
      protectedTokens,
    );
    generatedLocalizations[language] = generated[language];
  }

  const reviewFiles = files.filter((name) => /^translation_review_.+\.json$/u.test(name)).sort();
  for (const reviewFile of reviewFiles) {
    const review = await readJson(path.join(absolutePackageDir, reviewFile));
    if (review.status !== "PASS") {
      throw new Error(`${reviewFile}: review status must be PASS`);
    }
  }

  const metadata = {
    schemaVersion: 1,
    videoId: source.videoId,
    videoUrl: source.videoUrl,
    generatedAt: new Date().toISOString(),
    sourceSnapshot: "source_snapshot.json",
    supportedLanguages: source.supportedLanguages,
    supportedLanguageCount: source.supportedLanguageCount,
    generatedLanguageCount: expectedLanguages.length,
    generatedLanguages: expectedLanguages,
    translationShardFiles: shardFiles,
    translationReviewReports: reviewFiles,
    protectedTokens,
    validation,
    generatedLocalizations,
  };

  const outputPath = path.join(absolutePackageDir, "metadata_backfill.json");
  const tempPath = `${outputPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await rename(tempPath, outputPath);
  process.stdout.write(
    `METADATA_BACKFILL_READY video=${source.videoId} generated=${expectedLanguages.length} output=${outputPath}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`METADATA_BACKFILL_BUILD_FAILED ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
