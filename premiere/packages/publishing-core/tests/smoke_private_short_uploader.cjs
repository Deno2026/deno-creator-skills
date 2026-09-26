#!/usr/bin/env node

const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { mkdtempSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "deno-private-short-runtime-"));
process.env.DENO_UPLOAD_HELPER_RUNTIME_ROOT = runtimeRoot;
process.env.DENO_PRODUCTION_ROOT = path.resolve(__dirname, "..", "..", "..");

const {
  COMFY_REFERRAL_URL,
  DENO_DISCORD_URL,
  MAX_SHORT_SECONDS,
  acquireRunLock,
  assertUploadOutcomeIsKnown,
  buildPrivateInsertRequest,
  buildInsertRequest,
  buildRunId,
  metadataDiff,
  normalizeRotationDegrees,
  normalizeMetadata,
  parseArgs,
  validateAssignableCategory,
  validateAnalysisEvidence,
  validateShortsProbe,
  validateUploadedSourceEvidence,
  verifyUploadedVideo,
  videoMimeType,
} = require("../tools/upload_private_short_from_path.cjs");

function expectRejected(action, pattern) {
  try {
    action();
  } catch (error) {
    if (pattern.test(String(error.message))) return;
    throw new Error(`Unexpected rejection: ${error.message}`);
  }
  throw new Error(`Expected rejection by ${pattern}`);
}

async function expectRejectedAsync(action, pattern) {
  try {
    await action();
  } catch (error) {
    if (pattern.test(String(error.message))) return;
    throw new Error(`Unexpected rejection: ${error.message}`);
  }
  throw new Error(`Expected rejection by ${pattern}`);
}

const baseMetadata = {
  title: "귀여운 반전 애니메이션 #Shorts",
  description: "짧고 귀여운 반전 장면입니다.\n\n#Shorts",
  tags: ["Shorts", "AI animation", "귀여운 애니메이션"],
  categoryId: "1",
  madeForKids: false,
  containsSyntheticMedia: false,
  analysis: {
    summary: "세로형 애니메이션의 반전 장면",
    sampleCount: 9,
    onScreenText: ["다음엔 해줄게"],
    audioAssessment: "오디오 트랙 있음",
    audioAssessmentSource: "direct_review",
    reviewedAudioSha256: "b".repeat(64),
    reviewedContactSheetSha256: "c".repeat(64),
    reviewedSampleIndexes: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    metadataRationale: "짧은 대사와 반전 표정을 제목에 반영",
  },
};

const normalized = normalizeMetadata(baseMetadata);
const inspectionEvidence = {
  sampling: { contactSheetSha256: "c".repeat(64) },
  probe: { audioStreamCount: 1 },
  audioReview: { sha256: "b".repeat(64) },
};
validateAnalysisEvidence(normalized.analysis, inspectionEvidence);
expectRejected(
  () =>
    validateAnalysisEvidence(
      normalizeMetadata({
        ...baseMetadata,
        analysis: { ...baseMetadata.analysis, audioAssessmentSource: "transcript" },
      }).analysis,
      inspectionEvidence,
    ),
  /must be direct_review, signal_only, or no_audio/i,
);
expectRejected(
  () =>
    normalizeMetadata({
      ...baseMetadata,
      analysis: { ...baseMetadata.analysis, metadataRationale: "" },
    }),
  /metadataRationale is required/i,
);
if (
  normalized.apiMetadata.privacyStatus !== "private" ||
  normalized.apiMetadata.notifySubscribers !== false ||
  normalized.apiMetadata.defaultLanguage !== "ko" ||
  normalized.apiMetadata.defaultAudioLanguage !== "ko"
) {
  throw new Error("Private Shorts safe defaults were not enforced");
}
if (
  !normalized.apiMetadata.description.includes(COMFY_REFERRAL_URL) ||
  !normalized.apiMetadata.description.includes(DENO_DISCORD_URL) ||
  normalizeMetadata({ ...baseMetadata, description: normalized.apiMetadata.description })
    .apiMetadata.description !== normalized.apiMetadata.description
) {
  throw new Error("Permanent channel links were not appended exactly once to Shorts metadata");
}

validateShortsProbe({ durationSeconds: MAX_SHORT_SECONDS, width: 1080, height: 1080 });
validateShortsProbe({ durationSeconds: 15.7, width: 1080, height: 1920 });
expectRejected(
  () => validateShortsProbe({ durationSeconds: 15.7, width: 1080, height: 1920, videoStreamCount: 2 }),
  /exactly one unambiguous video stream/i,
);
if (normalizeRotationDegrees(-90) !== 270 || normalizeRotationDegrees(450) !== 90) {
  throw new Error("Video rotation normalization failed");
}
expectRejected(
  () => validateShortsProbe({ durationSeconds: MAX_SHORT_SECONDS + 0.1, width: 1080, height: 1920 }),
  /exceeds/i,
);
expectRejected(
  () => validateShortsProbe({ durationSeconds: 30, width: 1920, height: 1080 }),
  /square or vertical/i,
);
if (videoMimeType("clip.MOV") !== "video/quicktime" || videoMimeType("clip.mp4") !== "video/mp4") {
  throw new Error("Direct Shorts MIME detection failed");
}
expectRejected(() => videoMimeType("clip.exe"), /Unsupported direct Shorts container/i);
expectRejected(
  () => normalizeMetadata({ ...baseMetadata, privacyStatus: "public" }),
  /must match the explicit --privacy/i,
);
expectRejected(
  () => normalizeMetadata({ ...baseMetadata, notifySubscribers: true }),
  /cannot notify subscribers/i,
);
expectRejected(
  () => normalizeMetadata({ ...baseMetadata, title: "해시태그 없는 제목", description: "설명" }),
  /include #Shorts/i,
);
expectRejected(
  () => normalizeMetadata({ ...baseMetadata, playlistId: "playlist-id" }),
  /do not accept playlists/i,
);
expectRejected(
  () => normalizeMetadata({ ...baseMetadata, description: "한".repeat(2000) + "\n#Shorts" }),
  /UTF-8 bytes/i,
);
expectRejected(
  () => normalizeMetadata({ ...baseMetadata, title: "금지 <문자> #Shorts" }),
  /cannot contain/i,
);
expectRejected(
  () => normalizeMetadata({ ...baseMetadata, tags: [`${"a".repeat(498)} b`] }),
  /500-character limit/i,
);

const videoSha256 = "a".repeat(64);
const firstRun = buildRunId(videoSha256, normalized.apiMetadata);
const secondRun = buildRunId(videoSha256, normalizeMetadata(baseMetadata).apiMetadata);
if (firstRun.runId !== secondRun.runId || firstRun.metadataSha256 !== secondRun.metadataSha256) {
  throw new Error("Identical Shorts inputs did not produce a stable resumable run ID");
}
const changedRun = buildRunId(
  videoSha256,
  normalizeMetadata({ ...baseMetadata, title: "다른 제목 #Shorts" }).apiMetadata,
);
if (changedRun.runId !== firstRun.runId || changedRun.metadataSha256 === firstRun.metadataSha256) {
  throw new Error("Direct Shorts run ID must be source-wide while retaining a distinct metadata digest");
}

const expected = normalized.apiMetadata;
const actual = {
  snippet: {
    title: expected.title,
    description: expected.description,
    categoryId: expected.categoryId,
    defaultLanguage: expected.defaultLanguage,
    defaultAudioLanguage: expected.defaultAudioLanguage,
    tags: [...expected.tags].reverse(),
  },
  status: {
    privacyStatus: "private",
    selfDeclaredMadeForKids: expected.madeForKids,
    embeddable: expected.embeddable,
    publicStatsViewable: expected.publicStatsViewable,
    license: expected.license,
    containsSyntheticMedia: expected.containsSyntheticMedia,
  },
};
if (metadataDiff(expected, actual).length !== 0) {
  throw new Error("YouTube tag reordering should not fail metadata verification");
}
actual.status.privacyStatus = "public";
if (!metadataDiff(expected, actual).includes("privacyStatus")) {
  throw new Error("Public visibility was not rejected by verification");
}
actual.status.privacyStatus = "private";
actual.status.containsSyntheticMedia = !expected.containsSyntheticMedia;
if (!metadataDiff(expected, actual).includes("containsSyntheticMedia")) {
  throw new Error("Synthetic-media readback mismatch was not rejected");
}
actual.status.containsSyntheticMedia = expected.containsSyntheticMedia;
const scheduleOptions = { privacy: "scheduled", publishAt: "2030-01-02T19:00:00+09:00", descriptionBlocks: "none" };
const scheduled = normalizeMetadata({ ...baseMetadata, notifySubscribers: true }, scheduleOptions).apiMetadata;
if (scheduled.description !== baseMetadata.description || scheduled.publishAt !== "2030-01-02T10:00:00.000Z" || !scheduled.notifySubscribers) throw new Error("Scheduled metadata normalization failed");
expectRejected(() => normalizeMetadata(baseMetadata, { privacy: "scheduled" }), /requires --publish-at/);
expectRejected(() => normalizeMetadata(baseMetadata, { privacy: "public", publishAt: scheduleOptions.publishAt }), /only allowed with scheduled/);
expectRejected(() => normalizeMetadata(baseMetadata, { descriptionBlocks: "invalid" }), /Invalid --description-blocks/);
expectRejected(() => normalizeMetadata(baseMetadata, { privacy: "scheduled", publishAt: "2030-02-30T10:00:00Z" }), /Invalid --publish-at/);
const scheduledActual = { ...actual, snippet: { ...actual.snippet, description: scheduled.description }, status: { ...actual.status, privacyStatus: "private", publishAt: scheduled.publishAt } };
if (metadataDiff(scheduled, scheduledActual, Date.parse(scheduled.publishAt) - 1000).length) throw new Error("Scheduled pre-publication readback failed");
if (!metadataDiff(scheduled, { ...scheduledActual, status: { ...scheduledActual.status, publishAt: "2030-01-02T10:00:01Z" } }, Date.parse(scheduled.publishAt) - 1000).includes("publishAt")) throw new Error("Scheduled time mismatch not detected");
const publishedActual = { ...scheduledActual, status: { ...scheduledActual.status, privacyStatus: "public" } };
delete publishedActual.status.publishAt;
if (metadataDiff(scheduled, publishedActual, Date.parse(scheduled.publishAt)).length) throw new Error("Scheduled post-publication readback failed");
if (!metadataDiff(scheduled, scheduledActual, Date.parse(scheduled.publishAt) + 1000).includes("privacyStatus")) throw new Error("Missed scheduled publication not detected");
for (const privacy of ["public", "unlisted"]) {
  const metadata = normalizeMetadata(baseMetadata, { privacy }).apiMetadata;
  if (buildInsertRequest({ metadata, source: { mimeType: "video/mp4" } }, {}).requestBody.status.privacyStatus !== privacy) throw new Error("Explicit visibility failed");
}
const scheduledRequest = buildInsertRequest({ metadata: scheduled, source: { mimeType: "video/mp4" } }, {});
if (scheduledRequest.requestBody.status.privacyStatus !== "private" || scheduledRequest.requestBody.status.publishAt !== scheduled.publishAt || !scheduledRequest.notifySubscribers) throw new Error("Scheduled insert request failed");
const preserve = `  #Shorts\n${COMFY_REFERRAL_URL}\n  `;
if (normalizeMetadata({ ...baseMetadata, description: preserve }, { descriptionBlocks: "none" }).apiMetadata.description !== preserve) throw new Error("none must preserve exact copy");
const parsedSchedule = parseArgs(["node", "tool", "--video", "clip.mp4", "--metadata-file", "m.json", "--privacy", "scheduled", "--publish-at", scheduleOptions.publishAt, "--description-blocks", "none"]);
if (parsedSchedule.privacy !== "scheduled" || parsedSchedule.descriptionBlocks !== "none") throw new Error("Scheduling CLI failed");
const omittedFalseSynthetic = {
  ...actual,
  status: { ...actual.status },
};
delete omittedFalseSynthetic.status.containsSyntheticMedia;
if (metadataDiff(expected, omittedFalseSynthetic).includes("containsSyntheticMedia")) {
  throw new Error("YouTube's omitted false synthetic-media value should read back as effective false");
}
if (
  !metadataDiff(
    { ...expected, containsSyntheticMedia: true },
    omittedFalseSynthetic,
  ).includes("containsSyntheticMedia")
) {
  throw new Error("A requested true synthetic-media value must be present in readback");
}

expectRejected(
  () =>
    parseArgs([
      "node",
      "tool",
      "--video",
      "video.mp4",
      "--metadata-file",
      "metadata.json",
      "--public",
    ]),
  /Unknown argument: --public/,
);

assertUploadOutcomeIsKnown({ execution: { state: "prepared", videoId: null } });
expectRejected(
  () => assertUploadOutcomeIsKnown({ execution: { state: "uploading_private_short", videoId: null } }),
  /UPLOAD_OUTCOME_UNKNOWN/,
);
validateUploadedSourceEvidence({
  source: { sha256: "a".repeat(64), size: 123 },
  execution: {
    state: "video_uploaded_private",
    videoId: "video12345A",
    streamedSource: { sha256: "a".repeat(64), size: 123 },
  },
});
expectRejected(
  () =>
    validateUploadedSourceEvidence({
      source: { sha256: "a".repeat(64), size: 123 },
      execution: { state: "video_uploaded_private", videoId: "video12345A" },
    }),
  /UPLOADED_SOURCE_EVIDENCE_MISSING/,
);
expectRejected(
  () =>
    validateUploadedSourceEvidence({
      source: { sha256: "a".repeat(64), size: 123 },
      execution: {
        state: "uploaded_source_mismatch",
        videoId: "video12345A",
        streamedSource: { sha256: "b".repeat(64), size: 123 },
      },
    }),
  /UPLOADED_SOURCE_MISMATCH/,
);

void (async () => {
  const mediaBody = { testStream: true };
  const insertRequest = buildPrivateInsertRequest(
    { metadata: expected, source: { mimeType: "video/mp4" } },
    mediaBody,
  );
  if (
    insertRequest.notifySubscribers !== false ||
    insertRequest.requestBody.status.privacyStatus !== "private" ||
    insertRequest.requestBody.status.containsSyntheticMedia !== expected.containsSyntheticMedia ||
    insertRequest.requestBody.snippet.title !== expected.title ||
    insertRequest.requestBody.snippet.description !== expected.description ||
    insertRequest.requestBody.snippet.categoryId !== expected.categoryId ||
    insertRequest.media.body !== mediaBody ||
    Object.prototype.hasOwnProperty.call(insertRequest.requestBody, "localizations")
  ) {
    throw new Error("Private Shorts videos.insert contract drifted");
  }

  const verificationVideo = {
    ...actual,
    processingDetails: { processingStatus: "succeeded" },
    fileDetails: { videoStreams: [{ widthPixels: 1080, heightPixels: 1920 }] },
  };
  const verificationState = {
    metadata: expected,
    source: { probe: { codedWidth: 1080, codedHeight: 1920 } },
    execution: { videoId: "video12345A" },
  };
  const matchingReadback = await verifyUploadedVideo(
    { videos: { list: async () => ({ data: { items: [verificationVideo] } }) } },
    verificationState,
    1,
  );
  if (matchingReadback.differences.length !== 0) {
    throw new Error(`Matching videos.list readback failed: ${matchingReadback.differences.join(",")}`);
  }
  const mismatchedReadback = await verifyUploadedVideo(
    {
      videos: {
        list: async () => ({
          data: {
            items: [
              {
                ...verificationVideo,
                snippet: { ...verificationVideo.snippet, title: "tampered" },
              },
            ],
          },
        }),
      },
    },
    verificationState,
    1,
  );
  if (!mismatchedReadback.differences.includes("title")) {
    throw new Error("videos.list metadata mismatch was not retained as unverified");
  }

  const fakeYoutube = {
    videoCategories: {
      list: async () => ({
        data: {
          items: [
            { id: "1", snippet: { title: "Film & Animation", assignable: true } },
            { id: "99", snippet: { title: "Unavailable", assignable: false } },
          ],
        },
      }),
    },
  };
  const category = await validateAssignableCategory(fakeYoutube, "1");
  if (category.id !== "1" || category.assignable !== true) {
    throw new Error("Live assignable category validation failed");
  }
  await expectRejectedAsync(
    () => validateAssignableCategory(fakeYoutube, "99"),
    /not currently assignable/i,
  );

  const lockRunDir = await mkdtemp(path.join(os.tmpdir(), "direct-shorts-lock-smoke-"));
  const lockPaths = {
    runDir: lockRunDir,
    runLockPath: path.join(lockRunDir, "DIRECT_SHORT_RUN.lock"),
    statePath: path.join(lockRunDir, "direct_short_request.json"),
  };
  try {
    const releaseFirst = await acquireRunLock(lockPaths);
    await expectRejectedAsync(
      () => acquireRunLock(lockPaths),
      /DIRECT_SHORT_RUN_ALREADY_ACTIVE/,
    );
    await releaseFirst();
    const releaseSecond = await acquireRunLock(lockPaths);
    await releaseSecond();
    await writeFile(
      lockPaths.runLockPath,
      `${JSON.stringify({ pid: 2147483647, createdAt: new Date(0).toISOString() })}\n`,
      "utf8",
    );
    const releaseRecovered = await acquireRunLock(lockPaths);
    await releaseRecovered();
    await writeFile(
      lockPaths.statePath,
      `${JSON.stringify({ execution: { state: "uploading_private_short", videoId: null } })}\n`,
      "utf8",
    );
    await writeFile(
      lockPaths.runLockPath,
      `${JSON.stringify({ pid: 2147483647, createdAt: new Date(0).toISOString() })}\n`,
      "utf8",
    );
    await expectRejectedAsync(() => acquireRunLock(lockPaths), /UPLOAD_OUTCOME_UNKNOWN/);
  } finally {
    await rm(lockRunDir, { recursive: true, force: true });
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      privateDefaultAndExplicitVisibilityValidated: true,
      scheduledInsertAndBeforeAfterReadbackValidated: true,
      helperBypassInputsValidated: true,
      shortsEligibilityValidated: true,
      metadataEvidenceRequired: true,
      resumableRunIdStable: true,
      sourceWideOneUploadRunId: true,
      concurrentUploadLockEnforced: true,
      safeStaleRunLockRecovered: true,
      unknownUploadOutcomeBlocked: true,
      uploadedSourceEvidenceRequired: true,
      liveCategoryValidated: true,
      containerMimeValidated: true,
      publicFlagRejected: true,
      youtubeTagReorderingAccepted: true,
      insertAndReadbackContractValidated: true,
    })}\n`,
  );
})().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await rm(runtimeRoot, { recursive: true, force: true });
});
