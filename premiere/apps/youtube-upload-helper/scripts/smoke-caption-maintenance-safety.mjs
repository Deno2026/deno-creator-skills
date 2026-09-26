import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  assertLockedArtifactHash,
  assertManualTrackPrecondition,
  compareCanonicalSrt,
  compareProtectedCaptionSnapshots,
  requireWritableCaptionLanguage,
} from "../src/lib/caption-maintenance-safety.ts";

const srtCurrent =
  "1\n00:00:00,000 --> 00:00:01,000\nCurrent\n\n2\n00:00:01,000 --> 00:00:02,000\nRevision\n";
const srtOldSameCueCount =
  "1\n00:00:00,000 --> 00:00:01,000\nOld\n\n2\n00:00:01,000 --> 00:00:02,000\nRevision\n";
const srtWrongTimeline =
  "1\n00:00:00,000 --> 00:00:01,000\nCurrent\n\n2\n00:00:03,000 --> 00:00:04,000\nRevision\n";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function expectThrow(label, callback, pattern) {
  try {
    callback();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) {
      throw new Error(`${label}: wrong error: ${message}`);
    }
    return;
  }
  throw new Error(`${label}: expected an error`);
}

const baseCaptions = [
  {
    id: "manual-ko-current",
    language: "ko",
    name: "",
    trackKind: "standard",
    status: "serving",
    isDraft: false,
    lastUpdated: "2026-07-17T00:00:00Z",
  },
  {
    id: "asr-ko-protected",
    language: "ko",
    name: "",
    trackKind: "ASR",
    status: "serving",
    isDraft: false,
  },
  {
    id: "manual-fr-protected",
    language: "fr",
    name: "",
    trackKind: "standard",
    status: "serving",
    isDraft: false,
  },
];

assertManualTrackPrecondition(baseCaptions, {
  language: "ko",
  expectedAction: "update",
  expectedCaptionId: "manual-ko-current",
  expectedLastUpdated: "2026-07-17T00:00:00Z",
});

expectThrow(
  "stale caption id",
  () =>
    assertManualTrackPrecondition(baseCaptions, {
      language: "ko",
      expectedAction: "update",
      expectedCaptionId: "manual-ko-old",
      expectedLastUpdated: "2026-07-17T00:00:00Z",
    }),
  /STALE_CAPTION_PRECONDITION/,
);
expectThrow(
  "stale lastUpdated",
  () =>
    assertManualTrackPrecondition(baseCaptions, {
      language: "ko",
      expectedAction: "update",
      expectedCaptionId: "manual-ko-current",
      expectedLastUpdated: "2026-07-16T00:00:00Z",
    }),
  /STALE_CAPTION_PRECONDITION/,
);
expectThrow(
  "insert appeared after inspection",
  () =>
    assertManualTrackPrecondition(baseCaptions, {
      language: "ko",
      expectedAction: "insert",
    }),
  /STALE_CAPTION_PRECONDITION/,
);
expectThrow(
  "duplicate manual",
  () =>
    assertManualTrackPrecondition(
      [
        ...baseCaptions,
        {
          ...baseCaptions[0],
          id: "manual-ko-duplicate",
        },
      ],
      {
        language: "ko",
        expectedAction: "update",
        expectedCaptionId: "manual-ko-current",
        expectedLastUpdated: "2026-07-17T00:00:00Z",
      },
    ),
  /DUPLICATE_MANUAL_TRACK/,
);
expectThrow(
  "unsupported manual language",
  () => requireWritableCaptionLanguage("ja"),
  /UNSUPPORTED_MANUAL_CAPTION_LANGUAGE/,
);
expectThrow(
  "old generation hash",
  () =>
    assertLockedArtifactHash({
      language: "en",
      submittedSha256: sha256(srtOldSameCueCount),
      lockedSha256: sha256(srtCurrent),
    }),
  /STALE_CAPTION_REVISION/,
);

assertLockedArtifactHash({
  language: "en",
  submittedSha256: sha256(srtCurrent),
  lockedSha256: sha256(srtCurrent),
});
if (!compareCanonicalSrt(srtCurrent, srtCurrent.replaceAll(",", ".")).ok) {
  throw new Error("Canonical comparison should accept YouTube decimal separator normalization.");
}
const mismatch = compareCanonicalSrt(srtCurrent, srtWrongTimeline);
if (mismatch.ok || !mismatch.differences.some((difference) => difference.issue === "timing")) {
  throw new Error("Post-download timeline mismatch was not detected.");
}

if (!compareProtectedCaptionSnapshots(baseCaptions, baseCaptions, ["ko"]).ok) {
  throw new Error("Unchanged ASR and non-target manual tracks should pass.");
}
const changedProtected = baseCaptions.map((caption) =>
  caption.id === "asr-ko-protected" ? { ...caption, status: "failed" } : caption,
);
if (compareProtectedCaptionSnapshots(baseCaptions, changedProtected, ["ko"]).ok) {
  throw new Error("Changed ASR track was not detected.");
}

const routePath = path.resolve(
  process.cwd(),
  "src",
  "app",
  "api",
  "captions",
  "maintenance",
  "route.ts",
);
const routeSource = await readFile(routePath, "utf8");
const updateCalls = routeSource.match(/youtube\.captions\.update\(/g) ?? [];
for (const required of [
  "loadCanonicalCaptionAuthority",
  "stored.youtubeUpload?.videoId",
  "assertLockedArtifactHash",
  "assertManualTrackPrecondition",
  "youtube.captions.download",
  "compareCanonicalSrt",
  "assertLiveKoreanMatchesLock",
]) {
  if (!routeSource.includes(required)) throw new Error(`Route safety wiring missing: ${required}`);
}
if (updateCalls.length !== 1) {
  throw new Error(`captions.update must have exactly one write call, found ${updateCalls.length}.`);
}

console.log(
  JSON.stringify({
    ok: true,
    stalePreconditionBlocked: true,
    duplicateManualBlocked: true,
    unsupportedLanguageBlocked: true,
    oldGenerationHashBlocked: true,
    postDownloadMismatchDetected: true,
    protectedTracksChecked: true,
    updateWriteCallCount: updateCalls.length,
  }),
);
