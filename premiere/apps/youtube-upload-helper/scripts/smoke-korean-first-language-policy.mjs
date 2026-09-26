import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
process.env.DENO_PRODUCTION_ROOT = repoRoot;
process.env.DENO_UPLOAD_HELPER_RUNTIME_ROOT = path.join(
  os.tmpdir(),
  `deno-language-policy-runtime-${process.pid}`,
);
const uploaderModule = await import(
  pathToFileURL(
    path.join(repoRoot, "packages", "publishing-core", "tools", "upload_korean_first_youtube.cjs"),
  ).href
);
const { metadataDiff, normalizeKoreanFirstMetadata } = uploaderModule.default;

const normalizedMetadata = normalizeKoreanFirstMetadata({
  defaultLanguage: "ko",
  defaultAudioLanguage: "ko",
});
assert.equal(normalizedMetadata.defaultLanguage, "ko");
assert.equal(normalizedMetadata.defaultAudioLanguage, "ko");

const cinematicOptions = { contentKind: "cinematic", noManualCaptions: true };
assert.equal(normalizeKoreanFirstMetadata({ defaultLanguage: "ko", defaultAudioLanguage: "ja" }, cinematicOptions).defaultAudioLanguage, "ja");
assert.throws(() => normalizeKoreanFirstMetadata({ defaultLanguage: "ko" }, cinematicOptions));
assert.throws(() => normalizeKoreanFirstMetadata({ defaultLanguage: "en", defaultAudioLanguage: "ja" }, cinematicOptions));
assert.throws(() => normalizeKoreanFirstMetadata({ defaultLanguage: "ko", defaultAudioLanguage: "ja" }, { contentKind: "longform", noManualCaptions: true }));

for (const metadata of [
  { defaultAudioLanguage: "ko" },
  { defaultLanguage: "en", defaultAudioLanguage: "ko" },
  { defaultLanguage: "ko", defaultAudioLanguage: "en" },
  { defaultLanguage: "ko" },
]) {
  assert.throws(
    () => normalizeKoreanFirstMetadata(metadata),
    /defaultLanguage=ko and defaultAudioLanguage=ko/,
  );
}

const expected = {
  title: "Korean-first smoke",
  description: "language policy",
  categoryId: "28",
  defaultLanguage: "ko",
  defaultAudioLanguage: "ko",
  privacyStatus: "unlisted",
  tags: ["smoke"],
};
const item = (defaultLanguage, defaultAudioLanguage) => ({
  snippet: {
    title: expected.title,
    description: expected.description,
    categoryId: expected.categoryId,
    defaultLanguage,
    defaultAudioLanguage,
    tags: expected.tags,
  },
  status: { privacyStatus: expected.privacyStatus },
});

assert.deepEqual(metadataDiff(expected, item("ko", "ko")), []);
assert.deepEqual(metadataDiff(expected, item("en", "ko")), ["defaultLanguage"]);
assert.deepEqual(metadataDiff(expected, item("ko", "en")), ["defaultAudioLanguage"]);
assert.deepEqual(metadataDiff({ ...expected, defaultAudioLanguage: "ja" }, item("ko", "ja")), []);
assert.deepEqual(metadataDiff({ ...expected, defaultAudioLanguage: "ja" }, item("ko", "ko")), ["defaultAudioLanguage"]);

console.log(
  JSON.stringify({
    ok: true,
    missingOrNonKoreanLanguageFieldsRejectedBeforeUpload: true,
    manualKoreanRereadRequiresBothLanguageFieldsKo: true,
    cinematicJapaneseAudioPreservedAndRereadVerified: true,
  }),
);
