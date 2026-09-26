const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { mkdtempSync } = require("node:fs");
const { mkdir, rename, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "deno-ready-gate-runtime-"));
process.env.DENO_PRODUCTION_ROOT = path.resolve(__dirname, "..", "..", "..");
process.env.DENO_UPLOAD_HELPER_RUNTIME_ROOT = runtimeRoot;
const { writeProfileFixture, COMFY_REFERRAL_URL, DENO_DISCORD_URL } = require("./lib/profile_fixture.cjs");
writeProfileFixture(runtimeRoot);

const {
  REQUESTS_ROOT,
  loadAndValidateLatestReadyRequest,
  metadataConsistencyWarnings,
  metadataWarningsSha256,
  validateDescriptionLinkPolicy,
} = require("../tools/lib/helper_ready_gate.cjs");
const {
  buildExpectedMetadataAudit,
  buildInitialInsertVisibilityEvidence,
  metadataDiff,
} = require("../tools/upload_korean_first_youtube.cjs");
const {
  verifyPlaybackSyncApproval,
} = require("../tools/extend_youtube_english_localizations.cjs");

const withPermanentLinks = (description) =>
  `${description}\n\n${COMFY_REFERRAL_URL}\n\n${DENO_DISCORD_URL}`;
assert.doesNotThrow(() =>
  validateDescriptionLinkPolicy(
    { description: `협찬 설명\n\n${DENO_DISCORD_URL}`, noAffiliateLinks: true },
    false,
  ),
);
assert.throws(
  () =>
    validateDescriptionLinkPolicy(
      { description: withPermanentLinks("협찬 설명"), noAffiliateLinks: true },
      false,
    ),
  /forbids affiliate links/,
);
assert.throws(
  () => validateDescriptionLinkPolicy({ description: DENO_DISCORD_URL }, false),
  /missing the required ComfyUI/,
);
const slug = `ready-gate-smoke-${randomUUID().slice(0, 8)}`;
const noCaptionSlug = `no-caption-ready-gate-smoke-${randomUUID().slice(0, 8)}`;
const createdDirs = [];
const video = Buffer.from("ready-gate-video");
const finalKorean =
  "1\n00:00:00,000 --> 00:00:01,000 position:50%\n<b>최종 자막</b>\n\n2\n00:00:01,000 --> 00:00:02,000\n두 번째\n";
const cleanKorean = finalKorean.replace(/<\/?b>/g, "");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function createRequest(createdAt) {
  const requestId = `${createdAt.replace(/[-:.TZ]/g, "").slice(0, 17)}_${randomUUID().slice(0, 8)}_ready-gate-smoke`;
  const requestDir = path.join(REQUESTS_ROOT, requestId);
  const videoPath = path.join(requestDir, "video", "video.mp4");
  const finalPath = path.join(requestDir, "caption-authority", "final_korean_original.srt");
  const cleanPath = path.join(requestDir, "subtitles", "ko", "ko.srt");
  await Promise.all([
    mkdir(path.dirname(videoPath), { recursive: true }),
    mkdir(path.dirname(finalPath), { recursive: true }),
    mkdir(path.dirname(cleanPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(videoPath, video),
    writeFile(finalPath, finalKorean, "utf8"),
    writeFile(cleanPath, cleanKorean, "utf8"),
  ]);

  const cleanHash = sha256(cleanKorean);
  const fingerprint = `smoke-${randomUUID()}`;
  const manifest = {
    schemaVersion: 2,
    requestId,
    createdAt,
    status: "ready_for_codex_upload",
    source: "youtube-upload-helper",
    uploadAuthorization: {
      status: "approved",
      authority: "user_pressed_upload_helper_complete_button",
      trigger: "complete_button",
      approvedAt: createdAt,
      requestId,
      sourceFingerprint: fingerprint,
      initialPrivacyStatus: "unlisted",
      scope: [
        "initial_video_upload",
        "ko_caption_upload",
        "reviewed_en_caption_upload",
        "metadata_localization_write",
      ],
      publicVisibilityAuthorized: false,
      postUploadExpansionAuthorized: true,
      executionStrategy: "segmented_korean_first_then_english_localizations",
    },
    sourceOfTruth: { sourceFingerprint: fingerprint },
    agentProject: { slug },
    captionAuthority: {
      schemaVersion: 3,
      authority: "user_approved_final_korean_srt_at_request_click",
      slug,
      revisionId: `caption-${cleanHash.slice(0, 24)}`,
      finalKorean: {
        requestPath: "caption-authority/final_korean_original.srt",
        sha256: sha256(finalKorean),
      },
      cleanKorean: {
        requestPath: "subtitles/ko/ko.srt",
        lockedSha256: cleanHash,
        submittedSha256: cleanHash,
        exactMatch: true,
      },
    },
    files: {
      video: { path: videoPath, size: video.length, sha256: sha256(video) },
      subtitles: [{ path: cleanPath, size: Buffer.byteLength(cleanKorean), language: "ko" }],
      thumbnail: null,
    },
    metadata: {
      title: "READY gate smoke",
      description: withPermanentLinks("Helper authority smoke test"),
      tags: ["smoke"],
      defaultLanguage: "ko",
      defaultAudioLanguage: "ko",
      privacyStatus: "private",
      categoryId: "28",
      playlistId: "",
      notifySubscribers: false,
      madeForKids: false,
      containsSyntheticMedia: true,
      embeddable: true,
      publicStatsViewable: true,
      license: "youtube",
    },
  };
  await writeFile(
    path.join(requestDir, "upload_request.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(requestDir, "READY"),
    [
      "ready_for_codex_upload",
      `requestId=${requestId}`,
      `createdAt=${createdAt}`,
      `slug=${slug}`,
      `revisionId=${manifest.captionAuthority.revisionId}`,
      `sourceFingerprint=${fingerprint}`,
      "authorization=complete_button",
      "",
    ].join("\n"),
    "utf8",
  );
  createdDirs.push(requestDir);
  return { requestId, requestDir, videoPath, cleanPath, manifest };
}

async function createNoCaptionRequest(createdAt) {
  const requestId = `${createdAt.replace(/[-:.TZ]/g, "").slice(0, 17)}_${randomUUID().slice(0, 8)}_no-caption-smoke`;
  const requestDir = path.join(REQUESTS_ROOT, requestId);
  const videoPath = path.join(requestDir, "video", "video.mp4");
  await mkdir(path.dirname(videoPath), { recursive: true });
  await writeFile(videoPath, video);

  const fingerprint = `no-caption-smoke-${randomUUID()}`;
  const manifest = {
    schemaVersion: 2,
    requestId,
    createdAt,
    status: "ready_for_codex_upload",
    source: "youtube-upload-helper",
    uploadAuthorization: {
      status: "approved",
      authority: "user_pressed_upload_helper_complete_button",
      trigger: "complete_button",
      approvedAt: createdAt,
      requestId,
      sourceFingerprint: fingerprint,
      initialPrivacyStatus: "unlisted",
      scope: ["initial_video_upload"],
      publicVisibilityAuthorized: false,
      postUploadExpansionAuthorized: false,
      executionStrategy: "initial_upload_only",
    },
    sourceOfTruth: { sourceFingerprint: fingerprint },
    agentProject: { slug: noCaptionSlug },
    captionAuthority: null,
    captionPolicy: {
      mode: "none",
      authority: "user_declared_no_manual_captions_at_request_click",
      confirmedAt: createdAt,
    },
    contentKind: "cinematic",
    files: {
      video: { path: videoPath, size: video.length, sha256: sha256(video) },
      subtitles: [],
      thumbnail: null,
    },
    metadata: {
      title: "No-caption READY gate smoke",
      description: withPermanentLinks("User-approved cinematic video without manual captions"),
      tags: ["smoke"],
      defaultLanguage: "ko",
      defaultAudioLanguage: "ja",
      privacyStatus: "private",
      categoryId: "1",
      playlistId: "",
      notifySubscribers: false,
      madeForKids: false,
      containsSyntheticMedia: true,
      embeddable: true,
      publicStatsViewable: true,
      license: "youtube",
    },
  };
  await writeFile(
    path.join(requestDir, "upload_request.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(requestDir, "READY"),
    [
      "ready_for_codex_upload",
      `requestId=${requestId}`,
      `createdAt=${createdAt}`,
      `slug=${noCaptionSlug}`,
      "captionMode=none",
      `sourceFingerprint=${fingerprint}`,
      "authorization=complete_button",
      "",
    ].join("\n"),
    "utf8",
  );
  createdDirs.push(requestDir);
  return { requestId, requestDir, videoPath, manifest };
}

async function createShortsRequest(createdAt) {
  const requestId = `${createdAt.replace(/[-:.TZ]/g, "").slice(0, 17)}_${randomUUID().slice(0, 8)}_shorts-smoke`;
  const requestDir = path.join(REQUESTS_ROOT, requestId);
  const videoPath = path.join(requestDir, "video", "video.mp4");
  await mkdir(path.dirname(videoPath), { recursive: true });
  await writeFile(videoPath, video);

  const fingerprint = `shorts-smoke-${randomUUID()}`;
  const shortsBrief = "귀여운 세로형 애니메이션 숏츠";
  const metadata = {
    title: "Shorts READY gate smoke #Shorts",
    description: "Codex-completed Shorts metadata",
    tags: ["Shorts", "smoke"],
  };
  const manifest = {
    schemaVersion: 2,
    requestId,
    createdAt,
    status: "ready_for_codex_upload",
    source: "youtube-upload-helper",
    uploadAuthorization: {
      status: "approved",
      authority: "user_pressed_upload_helper_complete_button",
      trigger: "complete_button",
      approvedAt: createdAt,
      requestId,
      sourceFingerprint: fingerprint,
      initialPrivacyStatus: "private",
      scope: ["initial_video_upload"],
      publicVisibilityAuthorized: false,
      postUploadExpansionAuthorized: false,
      executionStrategy: "initial_upload_only",
    },
    sourceOfTruth: { sourceFingerprint: fingerprint },
    agentProject: null,
    captionAuthority: null,
    captionPolicy: {
      mode: "optional_shorts",
      authority: "shorts_request_policy",
      confirmedAt: createdAt,
    },
    contentKind: "shorts",
    shortsBrief,
    shortsPreparation: {
      status: "completed",
      authority: "codex_frame_audio_memo_metadata",
      requestId,
      sourceFingerprint: fingerprint,
      videoSha256: sha256(video),
      shortsBriefSha256: sha256(shortsBrief),
      metadataSha256: sha256(JSON.stringify(metadata)),
    },
    files: {
      video: { path: videoPath, size: video.length, sha256: sha256(video) },
      subtitles: [],
      thumbnail: null,
    },
    metadata: {
      ...metadata,
      fillBeforeUpload: false,
      defaultLanguage: "ko",
      defaultAudioLanguage: "ko",
      privacyStatus: "private",
      categoryId: "1",
      playlistId: "",
      notifySubscribers: false,
      madeForKids: false,
      containsSyntheticMedia: true,
      embeddable: true,
      publicStatsViewable: true,
      license: "youtube",
    },
  };
  await writeFile(
    path.join(requestDir, "upload_request.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(requestDir, "READY"),
    [
      "ready_for_codex_upload",
      `requestId=${requestId}`,
      `createdAt=${createdAt}`,
      `sourceFingerprint=${fingerprint}`,
      "authorization=complete_button",
      "",
    ].join("\n"),
    "utf8",
  );
  createdDirs.push(requestDir);
  return { requestId, requestDir, manifest };
}

async function expectRejected(requestId, pattern) {
  try {
    await loadAndValidateLatestReadyRequest({ requestId });
  } catch (error) {
    if (pattern.test(String(error.message))) return;
    throw new Error(`Unexpected rejection: ${error.message}`);
  }
  throw new Error(`Expected request ${requestId} to be rejected by ${pattern}`);
}

(async () => {
  try {
    const first = await createRequest("2026-07-18T00:00:00.000Z");
    const validated = await loadAndValidateLatestReadyRequest({ requestId: first.requestId });
    if (
      validated.requestId !== first.requestId ||
      validated.captionPath !== first.cleanPath ||
      validated.metadata.defaultLanguage !== "ko" ||
      validated.metadata.defaultAudioLanguage !== "ko" ||
      validated.metadata.privacyStatus !== "unlisted"
    ) {
      throw new Error("Valid Helper READY request did not return its exact locked inputs.");
    }
    const exactUploadAuthorization = first.manifest.uploadAuthorization;
    delete first.manifest.uploadAuthorization;
    await writeFile(
      path.join(first.requestDir, "upload_request.json"),
      `${JSON.stringify(first.manifest, null, 2)}\n`,
      "utf8",
    );
    await expectRejected(first.requestId, /completion-button authorization/i);
    first.manifest.uploadAuthorization = exactUploadAuthorization;
    await writeFile(
      path.join(first.requestDir, "upload_request.json"),
      `${JSON.stringify(first.manifest, null, 2)}\n`,
      "utf8",
    );
    first.manifest.uploadAuthorization.postUploadExpansionAuthorized = false;
    await writeFile(
      path.join(first.requestDir, "upload_request.json"),
      `${JSON.stringify(first.manifest, null, 2)}\n`,
      "utf8",
    );
    await expectRejected(first.requestId, /segmented upload workflow/i);
    first.manifest.uploadAuthorization.postUploadExpansionAuthorized = true;
    first.manifest.execution = {
      videoId: "video-segmented-smoke",
      metadataVerified: true,
      captionBodyVerified: true,
    };
    const segmentedApproval = await verifyPlaybackSyncApproval(
      first.manifest,
      first.requestDir,
      "video-segmented-smoke",
      false,
    );
    if (
      segmentedApproval.approvalType !==
        "helper_upload_ok_segmented_post_upload_expansion" ||
      segmentedApproval.playbackSyncConfirmationRequired !== false ||
      segmentedApproval.publicVisibilityAuthorized !== false
    ) {
      throw new Error("Helper Upload OK did not authorize the exact segmented post-upload expansion.");
    }
    delete first.manifest.execution;
    await writeFile(
      path.join(first.requestDir, "upload_request.json"),
      `${JSON.stringify(first.manifest, null, 2)}\n`,
      "utf8",
    );
    const expectedMetadataAudit = buildExpectedMetadataAudit(
      first.manifest.metadata,
      validated.metadata,
      "",
    );
    if (
      expectedMetadataAudit.requestedExpected.privacyStatus !== "private" ||
      expectedMetadataAudit.effectiveExpected.privacyStatus !== "unlisted" ||
      first.manifest.metadata.privacyStatus !== "private" ||
      validated.metadata.privacyStatus !== "unlisted"
    ) {
      throw new Error(
        "Requested Helper visibility and gate-normalized effective visibility were not audited separately.",
      );
    }
    const initialVisibilityEvidence = buildInitialInsertVisibilityEvidence({
      contentKind: "longform",
      requestBodyPrivacyStatus: validated.metadata.privacyStatus,
      insertResponsePrivacyStatus: "unlisted",
    });
    if (
      initialVisibilityEvidence.verified !== true ||
      initialVisibilityEvidence.expectedInitialPrivacyStatus !== "unlisted" ||
      initialVisibilityEvidence.requestBodyPrivacyStatus !== "unlisted" ||
      initialVisibilityEvidence.insertResponsePrivacyStatus !== "unlisted"
    ) {
      throw new Error("Initial videos.insert unlisted evidence was not verified exactly.");
    }
    const matchingVideo = (privacyStatus) => ({
      snippet: {
        title: validated.metadata.title,
        description: validated.metadata.description,
        categoryId: validated.metadata.categoryId,
        defaultLanguage: validated.metadata.defaultLanguage,
        defaultAudioLanguage: validated.metadata.defaultAudioLanguage,
        tags: validated.metadata.tags,
      },
      status: { privacyStatus },
    });
    for (const livePrivacyStatus of ["private", "public"]) {
      const differences = metadataDiff(
        expectedMetadataAudit.effectiveExpected,
        matchingVideo(livePrivacyStatus),
      );
      if (differences.length !== 0) {
        throw new Error(
          `Post-insert live ${livePrivacyStatus} visibility incorrectly failed final metadata verification: ${differences.join(",")}`,
        );
      }
    }

    const promiseWarnings = metadataConsistencyWarnings(
      first.manifest.metadata.description,
      `${cleanKorean}\n스킬을 정리해서 공유해 드릴 거고 영상 하단의 고정 댓글에서 링크를 확인하세요.`,
    );
    assert.equal(
      promiseWarnings.some(
        (warning) => warning.code === "AUDIENCE_PROMISE_FULFILLMENT_REQUIRED",
      ),
      true,
    );

    first.manifest.metadata.description = withPermanentLinks(
      "00:00 시작\n00:06 최종 영상에 없는 계정 삭제 방법",
    );
    await writeFile(
      path.join(first.requestDir, "upload_request.json"),
      `${JSON.stringify(first.manifest, null, 2)}\n`,
      "utf8",
    );
    await expectRejected(first.requestId, /Metadata consistency reminder required/);
    const warnings = metadataConsistencyWarnings(first.manifest.metadata.description, cleanKorean);
    await writeFile(
      path.join(first.requestDir, "METADATA_CONSISTENCY_APPROVED.json"),
      `${JSON.stringify({
        requestId: first.requestId,
        sourceFingerprint: first.manifest.sourceOfTruth.sourceFingerprint,
        warningsSha256: metadataWarningsSha256(warnings),
        userExplicitApproval: true,
      }, null, 2)}\n`,
      "utf8",
    );
    const warningApproved = await loadAndValidateLatestReadyRequest({ requestId: first.requestId });
    if (warningApproved.metadataConsistencyWarnings.length < 1) {
      throw new Error("Approved metadata warning was not preserved in validated evidence.");
    }
    first.manifest.metadata.description = withPermanentLinks("Helper authority smoke test");
    await writeFile(
      path.join(first.requestDir, "upload_request.json"),
      `${JSON.stringify(first.manifest, null, 2)}\n`,
      "utf8",
    );
    await rm(path.join(first.requestDir, "METADATA_CONSISTENCY_APPROVED.json"), { force: true });

    const thumbnail = Buffer.from("authorized-thumbnail");
    const thumbnailPath = path.join(first.requestDir, "thumbnail", "thumbnail.png");
    await mkdir(path.dirname(thumbnailPath), { recursive: true });
    await writeFile(thumbnailPath, thumbnail);
    first.manifest.files.thumbnail = {
      path: thumbnailPath,
      size: thumbnail.length,
      sha256: sha256(thumbnail),
    };
    first.manifest.workflowPolicy = {
      thumbnailUploadAuthorization: {
        authorized: true,
        authority: "user_selected_thumbnail_and_saved_upload_request",
        sha256: sha256(thumbnail),
      },
    };
    await writeFile(
      path.join(first.requestDir, "upload_request.json"),
      `${JSON.stringify(first.manifest, null, 2)}\n`,
      "utf8",
    );
    const thumbnailApproved = await loadAndValidateLatestReadyRequest({ requestId: first.requestId });
    if (!thumbnailApproved.thumbnailUploadAuthorized || thumbnailApproved.thumbnailPath !== thumbnailPath) {
      throw new Error("Authorized Helper thumbnail was not returned as a locked upload input.");
    }
    // Keep the fixture size unchanged so this assertion specifically exercises
    // the digest lock rather than the preceding size check.
    await writeFile(thumbnailPath, Buffer.from("tampered---thumbnail"));
    await expectRejected(first.requestId, /thumbnail SHA-256 differs/);
    await writeFile(thumbnailPath, thumbnail);

    const tamperedVideo = Buffer.from(video);
    tamperedVideo[0] ^= 0xff;
    await writeFile(first.videoPath, tamperedVideo);
    await expectRejected(first.requestId, /video SHA-256 differs|changed while its SHA-256/i);
    await writeFile(first.videoPath, video);

    await writeFile(first.cleanPath, `${cleanKorean}\n변조`, "utf8");
    await expectRejected(first.requestId, /SHA-256|exactly match/i);
    await writeFile(first.cleanPath, cleanKorean, "utf8");

    await writeFile(path.join(first.requestDir, "SUPERSEDED"), "superseded\n", "utf8");
    await expectRejected(first.requestId, /SUPERSEDED/);
    await rm(path.join(first.requestDir, "SUPERSEDED"), { force: true });

    const second = await createRequest("2026-07-18T00:00:01.000Z");
    await expectRejected(first.requestId, /not the latest READY/i);
    const latest = await loadAndValidateLatestReadyRequest({ requestId: second.requestId });
    if (latest.requestId !== second.requestId) throw new Error("Latest READY request was not selected.");

    second.manifest.source = "user_direct_korean_first_upload_after_helper_large_file_failure";
    await writeFile(
      path.join(second.requestDir, "upload_request.json"),
      `${JSON.stringify(second.manifest, null, 2)}\n`,
      "utf8",
    );
    await expectRejected(second.requestId, /Legacy or manual request source/);

    const noCaption = await createNoCaptionRequest("2026-07-18T00:00:02.000Z");
    const noCaptionValidated = await loadAndValidateLatestReadyRequest({
      requestId: noCaption.requestId,
    });
    if (
      !noCaptionValidated.noManualCaptions ||
      noCaptionValidated.captionMode !== "none" ||
      noCaptionValidated.captionPath !== null ||
      noCaptionValidated.captionStat !== null ||
      noCaptionValidated.metadata.defaultAudioLanguage !== "ja" ||
      noCaptionValidated.cueCount !== 0 ||
      noCaptionValidated.metadata.privacyStatus !== "unlisted"
    ) {
      throw new Error("Valid no-caption Helper READY request did not preserve its policy.");
    }
    noCaption.manifest.uploadAuthorization.scope = ["initial_video_upload", "metadata_localization_write"];
    noCaption.manifest.uploadAuthorization.postUploadExpansionAuthorized = true;
    noCaption.manifest.uploadAuthorization.executionStrategy = "video_then_metadata_localizations";
    await writeFile(path.join(noCaption.requestDir, "upload_request.json"), JSON.stringify(noCaption.manifest), "utf8");
    await loadAndValidateLatestReadyRequest({ requestId: noCaption.requestId });
    noCaption.manifest.files.subtitles = [
      { path: noCaption.videoPath, size: video.length, language: "ko" },
    ];
    await writeFile(
      path.join(noCaption.requestDir, "upload_request.json"),
      `${JSON.stringify(noCaption.manifest, null, 2)}\n`,
      "utf8",
    );
    await expectRejected(noCaption.requestId, /unexpectedly contains subtitle files/i);

    const shorts = await createShortsRequest("2026-07-18T00:00:03.000Z");
    const shortsValidated = await loadAndValidateLatestReadyRequest({
      requestId: shorts.requestId,
    });
    if (
      !shortsValidated.isShorts ||
      !shortsValidated.noManualCaptions ||
      shortsValidated.captionPath !== null ||
      shortsValidated.metadata.fillBeforeUpload !== false ||
      shortsValidated.metadata.privacyStatus !== "private"
    ) {
      throw new Error("Valid completed Shorts request did not preserve its execution policy.");
    }
    shorts.manifest.metadata.title = "Tampered Shorts title";
    await writeFile(
      path.join(shorts.requestDir, "upload_request.json"),
      `${JSON.stringify(shorts.manifest, null, 2)}\n`,
      "utf8",
    );
    await expectRejected(shorts.requestId, /Shorts metadata completion evidence/i);

    await rename(path.join(first.requestDir, "READY"), path.join(first.requestDir, "READY.removed"));
    await expectRejected(first.requestId, /READY marker is missing/);

    console.log(
      JSON.stringify({
        ok: true,
        exactHelperAuthorityAccepted: true,
        completionButtonAuthorizationRequired: true,
        segmentedPostUploadExpansionAuthorized: true,
        helperLongformDefaultUnlisted: true,
        requestedAndEffectiveVisibilityAuditedSeparately: true,
        initialInsertUnlistedEvidenceVerified: true,
        postInsertLiveVisibilityIgnoredByMetadataVerification: true,
        tamperedCleanKoreanRejected: true,
        supersededRejected: true,
        staleReadyRejectedByLatestSelection: true,
        legacyManualSourceRejected: true,
        missingReadyRejected: true,
        metadataMismatchReminderRequiredAndBoundApprovalAccepted: true,
        authorizedThumbnailLockedAndTamperRejected: true,
        cachedVideoHashInvalidatedOnFileChange: true,
        noCaptionAuthorityAccepted: true,
        helperCinematicDefaultUnlisted: true,
        noCaptionSubtitleInjectionRejected: true,
        shortsMetadataAuthorityAccepted: true,
        helperShortsRemainPrivate: true,
        shortsMetadataTamperRejected: true,
      }),
    );
  } finally {
    await Promise.all(createdDirs.map((directory) => rm(directory, { recursive: true, force: true })));
    await rm(runtimeRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
