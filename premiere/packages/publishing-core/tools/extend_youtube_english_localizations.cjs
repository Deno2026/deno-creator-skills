#!/usr/bin/env node

const { createReadStream } = require("node:fs");
const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  findProductionRoot,
  getUploadRuntimePaths,
} = require("@deno/runtime-paths");

const PRODUCTION_ROOT = findProductionRoot();
const RUNTIME_PATHS = getUploadRuntimePaths();
const { google } = require("googleapis");
const {
  assertYouTubeChannel,
  channelRuntimePaths,
  descriptionLinkRequirements,
  resolveToolChannel,
} = require("./lib/youtube_channel.cjs");

// The final cumulative payload already contains every localization, so batches
// of three only add latency and quota cost. Fifteen retains useful resume
// checkpoints while reducing an 82-language run from 28 writes to at most six.
const LOCALIZATION_BATCH_SIZE = 15;
const { getDescriptionBlocks } = require("@deno/runtime-paths");
// 설명 고정 링크 값은 channels.json(descriptionBlocks)에서 온다. 비어 있으면 그 검사는 건너뛴다.
const COMFY_REFERRAL_URL = getDescriptionBlocks().comfyReferral.url;
const DENO_DISCORD_URL = getDescriptionBlocks().discord.url;

function parseArgs(argv) {
  const args = {
    videoId: "",
    caption: "",
    metadata: "",
    requestDir: "",
    captionOnly: false,
    metadataOnly: false,
    verifyOnly: false,
    slug: "",
    sourceLock: "",
    finalKorean: "",
    cleanKorean: "",
    reviewReport: "",
    privacyApproval: "",
    channel: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--video-id") args.videoId = argv[++index] ?? "";
    else if (arg === "--caption") args.caption = argv[++index] ?? "";
    else if (arg === "--metadata") args.metadata = argv[++index] ?? "";
    else if (arg === "--request-dir") args.requestDir = argv[++index] ?? "";
    else if (arg === "--caption-only") args.captionOnly = true;
    else if (arg === "--metadata-only") args.metadataOnly = true;
    else if (arg === "--verify-only") args.verifyOnly = true;
    else if (arg === "--slug") args.slug = argv[++index] ?? "";
    else if (arg === "--source-lock") args.sourceLock = argv[++index] ?? "";
    else if (arg === "--final-korean") args.finalKorean = argv[++index] ?? "";
    else if (arg === "--clean-korean") args.cleanKorean = argv[++index] ?? "";
    else if (arg === "--review-report") args.reviewReport = argv[++index] ?? "";
    else if (arg === "--privacy-approval") args.privacyApproval = argv[++index] ?? "";
    else if (arg === "--channel") args.channel = argv[++index] ?? "";
  }
  if (!args.videoId) throw new Error("--video-id is required");
  if (!args.requestDir) throw new Error("--request-dir is required");
  if (!args.metadataOnly && !args.caption) throw new Error("--caption is required");
  if (!args.captionOnly && !args.metadata) throw new Error("--metadata is required");
  if (args.captionOnly && args.metadataOnly) {
    throw new Error("--caption-only and --metadata-only cannot be combined");
  }
  if (!args.metadataOnly) {
    for (const [name, value] of Object.entries({
      slug: args.slug,
      sourceLock: args.sourceLock,
      finalKorean: args.finalKorean,
      cleanKorean: args.cleanKorean,
      reviewReport: args.reviewReport,
    })) {
      if (!value) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
    }
  }
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function normalizedHash(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function verifyPlaybackSyncApproval(manifest, requestDir, videoId, verifyOnly) {
  const uploadAuthorization = manifest.uploadAuthorization;
  const expansionScopes = new Set(uploadAuthorization?.scope ?? []);
  const helperApprovedSegmentedExpansion =
    uploadAuthorization?.status === "approved" &&
    uploadAuthorization?.authority === "user_pressed_upload_helper_complete_button" &&
    uploadAuthorization?.trigger === "complete_button" &&
    uploadAuthorization?.approvedAt === manifest.createdAt &&
    uploadAuthorization?.requestId === manifest.requestId &&
    uploadAuthorization?.sourceFingerprint === manifest.sourceOfTruth?.sourceFingerprint &&
    uploadAuthorization?.postUploadExpansionAuthorized === true &&
    uploadAuthorization?.executionStrategy ===
      "segmented_korean_first_then_english_localizations" &&
    uploadAuthorization?.publicVisibilityAuthorized === false &&
    expansionScopes.has("reviewed_en_caption_upload") &&
    expansionScopes.has("metadata_localization_write");

  if (helperApprovedSegmentedExpansion) {
    if (
      manifest.execution?.videoId !== videoId ||
      manifest.execution?.metadataVerified !== true ||
      manifest.execution?.captionBodyVerified !== true
    ) {
      throw new Error(
        "Segmented post-upload expansion requires the exact Korean-first upload and live read-back to complete first",
      );
    }
    return {
      approvalType: "helper_upload_ok_segmented_post_upload_expansion",
      authority: "user_pressed_upload_helper_complete_button",
      method: "helper_upload_ok_no_separate_sync_gate",
      userExplicitApproval: true,
      playbackSyncConfirmationRequired: false,
      requestId: manifest.requestId,
      sourceFingerprint: manifest.sourceOfTruth?.sourceFingerprint,
      videoId,
      videoSha256: normalizedHash(manifest.files?.video?.sha256),
      captionRevisionId: manifest.captionAuthority?.revisionId,
      cleanKoreanSha256: normalizedHash(
        manifest.captionAuthority?.cleanKorean?.lockedSha256,
      ),
      publicVisibilityAuthorized: false,
      path: null,
    };
  }

  const approvalPath = path.join(requestDir, "playback_sync_approval.json");
  const approval = await readJson(approvalPath).catch(() => null);
  if (verifyOnly && !approval) {
    return { readOnlyVerificationBypass: true };
  }
  const expected = {
    requestId: manifest.requestId,
    sourceFingerprint: manifest.sourceOfTruth?.sourceFingerprint ?? "",
    videoSha256: normalizedHash(manifest.files?.video?.sha256),
    captionRevisionId: manifest.captionAuthority?.revisionId ?? "",
    cleanKoreanSha256: normalizedHash(manifest.captionAuthority?.cleanKorean?.lockedSha256),
  };
  if (!approval) {
    throw new Error(
      "Playback sync approval is missing. Ask the user to confirm sync for the exact final video and final Korean SRT before any English caption or localization write.",
    );
  }
  for (const [field, value] of Object.entries(expected)) {
    const actual = field.endsWith("Sha256") ? normalizedHash(approval[field]) : approval[field];
    if (!value || actual !== value) {
      throw new Error(`Playback sync approval does not match the current Helper request: ${field}`);
    }
  }
  const allowedMethods = new Set([
    "user_confirmed_exact_helper_files",
    "user_confirmed_unlisted_youtube_playback",
    "agent_verified_unlisted_youtube_playback",
    "user_confirmed_private_youtube_playback",
    "agent_verified_private_youtube_playback",
  ]);
  if (!allowedMethods.has(approval.method) || approval.userExplicitApproval !== true) {
    throw new Error("Playback sync approval method or explicit user evidence is invalid");
  }
  if (
    approval.method !== "user_confirmed_exact_helper_files" &&
    approval.videoId !== videoId
  ) {
    throw new Error("Playback sync approval videoId does not match the current YouTube video");
  }
  return { ...approval, path: approvalPath };
}

async function verifyPrivacyStatusApproval(args, manifest, livePrivacyStatus) {
  const requestedPrivacyStatus =
    manifest.effectiveExpected?.privacyStatus ?? manifest.requestedExpected?.privacyStatus ?? "";
  if (!["private", "unlisted", "public"].includes(livePrivacyStatus)) {
    throw new Error(`Unsupported live privacy status: ${livePrivacyStatus ?? "missing"}`);
  }
  const liveState = {
    status: livePrivacyStatus,
    requestedPrivacyStatus,
    approvalPath: null,
    userConfirmedLiveChange: false,
    liveStatusAdoptedReadOnly: true,
    changedSinceInitialUpload:
      Boolean(requestedPrivacyStatus) && requestedPrivacyStatus !== livePrivacyStatus,
  };
  if (!args.privacyApproval) {
    return liveState;
  }

  const approvalPath = path.resolve(args.privacyApproval);
  const approval = await readJson(approvalPath).catch(() => null);
  if (!approval) {
    throw new Error(`Live privacy-status approval is unreadable: ${approvalPath}`);
  }
  const expected = {
    approvalType: "live_privacy_status",
    requestId: manifest.requestId,
    sourceFingerprint: manifest.sourceOfTruth?.sourceFingerprint ?? "",
    videoId: args.videoId,
    videoSha256: normalizedHash(manifest.files?.video?.sha256),
  };
  for (const [field, value] of Object.entries(expected)) {
    const actual = field.endsWith("Sha256") ? normalizedHash(approval[field]) : approval[field];
    if (!value || actual !== value) {
      throw new Error(`Live privacy-status approval does not match the current video/request: ${field}`);
    }
  }
  if (approval.userExplicitApproval !== true || approval.approvedBy !== "user_explicit_chat_confirmation") {
    throw new Error("Live privacy-status approval lacks explicit user evidence");
  }
  if (!["private", "unlisted", "public"].includes(approval.confirmedStatus)) {
    throw new Error(`Unsupported approved live privacy status: ${approval.confirmedStatus ?? "missing"}`);
  }
  return {
    ...liveState,
    approvalPath,
    userConfirmedLiveChange:
      approval.confirmedStatus === livePrivacyStatus &&
      approval.confirmedStatus !== requestedPrivacyStatus,
    approvalEvidenceStatus: approval.confirmedStatus,
    approvalMatchesCurrentLiveStatus: approval.confirmedStatus === livePrivacyStatus,
    approvedAt: approval.approvedAt ?? null,
  };
}

function parseSrt(raw) {
  return raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n");
      const timingIndex = lines.findIndex((line) => line.includes(" --> "));
      if (timingIndex < 1) return null;
      return {
        number: Number(lines[timingIndex - 1].trim()),
        timing: lines[timingIndex].trim().replace(/\./g, ","),
        text: lines.slice(timingIndex + 1).map((line) => line.trimEnd()).join("\n").trim(),
      };
    })
    .filter(Boolean);
}

function compareSrt(expectedRaw, actualRaw) {
  const expected = parseSrt(expectedRaw);
  const actual = parseSrt(actualRaw);
  const differences = [];
  const max = Math.max(expected.length, actual.length);
  for (let index = 0; index < max; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (!left || !right) {
      differences.push({ cue: index + 1, issue: "missing_cue" });
      continue;
    }
    if (left.number !== right.number) {
      differences.push({ cue: index + 1, issue: "number", expected: left.number, actual: right.number });
    }
    if (left.timing !== right.timing) {
      differences.push({ cue: index + 1, issue: "timing", expected: left.timing, actual: right.timing });
    }
    if (left.text !== right.text) {
      differences.push({ cue: index + 1, issue: "text", expected: left.text, actual: right.text });
    }
    if (differences.length >= 20) break;
  }
  return {
    ok: differences.length === 0 && expected.length === actual.length,
    expectedCueCount: expected.length,
    actualCueCount: actual.length,
    differences,
  };
}

function isQuotaError(error) {
  const text = `${error?.message ?? ""} ${JSON.stringify(error?.response?.data ?? {})}`.toLowerCase();
  return text.includes("quotaexceeded") || text.includes("quota exceeded");
}

function normalizeLanguage(language) {
  const aliases = {
    iw: "he",
    he: "he",
    "zh-CN": "zh-Hans",
    "zh-Hans": "zh-Hans",
    "zh-TW": "zh-Hant",
    "zh-Hant": "zh-Hant",
    pt: "pt-BR",
    "pt-BR": "pt-BR",
  };
  return aliases[language] ?? language;
}

function normalizedLocalizations(localizations) {
  return Object.fromEntries(
    Object.entries(localizations ?? {}).map(([language, value]) => [normalizeLanguage(language), value]),
  );
}

function sortedTags(tags) {
  return [...(tags ?? [])].sort((left, right) => left.localeCompare(right));
}

function originalMetadataDifferences(expected, video) {
  const differences = [];
  if (video.snippet?.title !== expected.title) differences.push("title");
  if (video.snippet?.description !== expected.description) differences.push("description");
  if (video.snippet?.categoryId !== expected.categoryId) differences.push("categoryId");
  if (video.snippet?.defaultLanguage !== expected.defaultLanguage) differences.push("defaultLanguage");
  if (video.snippet?.defaultAudioLanguage !== expected.defaultAudioLanguage) {
    differences.push("defaultAudioLanguage");
  }
  if (JSON.stringify(sortedTags(video.snippet?.tags)) !== JSON.stringify(sortedTags(expected.tags))) {
    differences.push("tags");
  }
  return differences;
}

function localizationUpdateRequestBody(videoId, localizations) {
  return { id: videoId, localizations };
}

async function verifyCaptionSourceLock(args, requestDir) {
  const reportPath = path.join(requestDir, "caption_source_preflight.json");
  const result = spawnSync(
    "python",
    [
      path.join(PRODUCTION_ROOT, "packages", "caption-core", "tools", "srt_tool.py"),
      "verify-lock",
      path.resolve(args.sourceLock),
      path.resolve(args.finalKorean),
      path.resolve(args.cleanKorean),
      path.resolve(args.caption),
      "--slug",
      args.slug,
      "--review-report",
      path.resolve(args.reviewReport),
      "--report",
      reportPath,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(
      `Caption source lock preflight failed: ${result.stderr || result.stdout || `exit ${result.status}`}`,
    );
  }
  const preflight = await readJson(reportPath);
  if (preflight.ok !== true) throw new Error("Caption source lock preflight did not return ok=true");
  const expectedCueCount = preflight.current?.files?.reviewed_english?.cue_count;
  if (!Number.isInteger(expectedCueCount) || expectedCueCount <= 0) {
    throw new Error("Caption source lock preflight has no valid reviewed English cue count");
  }
  return {
    reportPath,
    expectedCueCount,
    revisionId: preflight.current?.revision_id,
    current: preflight.current,
  };
}

function verifyCaptionSourceAuthorityBinding(manifest, captionSourcePreflight, playbackSyncApproval) {
  const authority = manifest.captionAuthority;
  const sourceLock = captionSourcePreflight?.current;
  if (!authority || !sourceLock) {
    throw new Error("Caption source authority binding is missing the Helper authority or source lock");
  }

  const expected = {
    slug: String(authority.slug ?? "").trim(),
    finalKoreanSha256: normalizedHash(authority.finalKorean?.sha256),
    cleanKoreanSha256: normalizedHash(authority.cleanKorean?.lockedSha256),
    helperCaptionRevisionId: String(authority.revisionId ?? "").trim(),
    sourceLockRevisionId: String(sourceLock.revision_id ?? "").trim(),
  };
  const actual = {
    slug: String(sourceLock.slug ?? "").trim(),
    finalKoreanSha256: normalizedHash(sourceLock.files?.final_korean?.sha256),
    cleanKoreanSha256: normalizedHash(sourceLock.files?.clean_korean?.sha256),
  };

  for (const field of ["slug", "finalKoreanSha256", "cleanKoreanSha256"]) {
    if (!expected[field] || actual[field] !== expected[field]) {
      throw new Error(`Caption source lock does not match the current Helper captionAuthority: ${field}`);
    }
  }
  if (!expected.helperCaptionRevisionId || !expected.sourceLockRevisionId) {
    throw new Error("Caption source authority binding has a missing revision ID");
  }

  const previousSourceLockRevisionId = String(manifest.execution?.captionRevisionId ?? "").trim();
  if (
    previousSourceLockRevisionId &&
    previousSourceLockRevisionId !== expected.sourceLockRevisionId
  ) {
    throw new Error(
      "Caption source lock revision differs from the revision already bound to this Helper request",
    );
  }

  if (!playbackSyncApproval?.readOnlyVerificationBypass) {
    if (playbackSyncApproval?.captionRevisionId !== expected.helperCaptionRevisionId) {
      throw new Error(
        "Playback sync approval revision does not match the current Helper captionAuthority",
      );
    }
    if (
      normalizedHash(playbackSyncApproval?.cleanKoreanSha256) !==
      expected.cleanKoreanSha256
    ) {
      throw new Error(
        "Playback sync approval clean Korean hash does not match the current Helper captionAuthority",
      );
    }
  }

  return {
    verified: true,
    slug: expected.slug,
    finalKoreanSha256: expected.finalKoreanSha256,
    cleanKoreanSha256: expected.cleanKoreanSha256,
    helperCaptionRevisionId: expected.helperCaptionRevisionId,
    sourceLockRevisionId: expected.sourceLockRevisionId,
    playbackApprovalBypassedForReadOnlyVerification:
      playbackSyncApproval?.readOnlyVerificationBypass === true,
  };
}

async function saveRefreshedToken(tokenPath, token) {
  const existing = await readJson(tokenPath);
  await writeJsonAtomic(tokenPath, {
    ...existing,
    ...token,
    refresh_token: token.refresh_token ?? existing.refresh_token,
  });
}

async function getVideo(youtube, videoId) {
  const response = await youtube.videos.list({
    part: ["snippet", "status", "localizations", "processingDetails"],
    id: [videoId],
  });
  const video = response.data.items?.[0];
  if (!video) throw new Error(`Video not found: ${videoId}`);
  return video;
}

async function getCaptions(youtube, videoId) {
  const response = await youtube.captions.list({ part: ["id", "snippet"], videoId });
  return response.data.items ?? [];
}

async function main() {
  const args = parseArgs(process.argv);
  const requestDir = path.resolve(args.requestDir);
  const manifestPath = path.join(requestDir, "upload_request.json");
  const verificationDir = path.join(requestDir, "verification");
  const settingsPath = RUNTIME_PATHS.settingsPath;
  await mkdir(verificationDir, { recursive: true });

  const manifest = await readJson(manifestPath);
  // 현지화 채널 = READY에 기록된 채널(이전 READY는 DENO). 링크 규칙·토큰·채널 대조가 모두 이 채널 기준이다.
  const uploadChannel = resolveToolChannel({ channelArg: args.channel, manifest });
  const tokenPath = channelRuntimePaths(uploadChannel).oauthTokenPath;
  const noManualCaptions = manifest.captionPolicy?.mode === "none";
  if (noManualCaptions && !args.metadataOnly) {
    throw new Error("captionPolicy.mode=none only supports --metadata-only extension work");
  }
  if (!noManualCaptions && !args.cleanKorean) {
    throw new Error("--clean-korean is required when manual captions are expected");
  }
  const expectedOriginal = manifest.effectiveExpected ?? manifest.requestedExpected;
  if (!expectedOriginal) throw new Error("Manifest has no expected Korean metadata");
  const noAffiliateLinks = expectedOriginal.noAffiliateLinks === true;
  const linkRules = descriptionLinkRequirements(uploadChannel, { noAffiliateLinks });
  const originalDescription = String(expectedOriginal.description ?? "");
  if (COMFY_REFERRAL_URL && !linkRules.affiliateAllowed && originalDescription.includes(COMFY_REFERRAL_URL)) {
    throw new Error("Protected Korean description contains a forbidden affiliate link");
  }
  if (COMFY_REFERRAL_URL && linkRules.affiliateAllowed && !originalDescription.includes(COMFY_REFERRAL_URL)) {
    throw new Error("Protected Korean description is missing the required ComfyUI Deno referral link");
  }
  if (DENO_DISCORD_URL && linkRules.discordRequired && !originalDescription.includes(DENO_DISCORD_URL)) {
    throw new Error("Protected Korean description is missing the required Deno Discord link");
  }
  if (!["private", "unlisted", "public"].includes(expectedOriginal.privacyStatus)) {
    throw new Error(`Unsupported protected privacy baseline: ${expectedOriginal.privacyStatus ?? "missing"}`);
  }
  if (manifest.execution?.videoId && manifest.execution.videoId !== args.videoId) {
    throw new Error(`Manifest video mismatch: ${manifest.execution.videoId}`);
  }
  if (manifest.slug && manifest.slug !== args.slug && !args.metadataOnly) {
    throw new Error(`Manifest slug mismatch: ${manifest.slug}`);
  }

  const playbackSyncApproval = noManualCaptions
    ? { notApplicable: true, reason: "no_manual_captions" }
    : await verifyPlaybackSyncApproval(
        manifest,
        requestDir,
        args.videoId,
        args.verifyOnly,
      );

  const captionSourcePreflight = args.metadataOnly
    ? null
    : await verifyCaptionSourceLock(args, requestDir);

  const captionSourceAuthorityBinding = args.metadataOnly
    ? null
    : verifyCaptionSourceAuthorityBinding(
        manifest,
        captionSourcePreflight,
        playbackSyncApproval,
      );

  const [settings, token] = await Promise.all([
    readJson(settingsPath),
    readJson(tokenPath),
  ]);

  const oauth = new google.auth.OAuth2(settings.clientId, settings.clientSecret, settings.redirectUri);
  oauth.setCredentials(token);
  oauth.on("tokens", (refreshed) => {
    void saveRefreshedToken(tokenPath, refreshed).catch((error) => {
      process.stderr.write(`TOKEN_SAVE_WARNING ${error.message}\n`);
    });
  });
  const youtube = google.youtube({ version: "v3", auth: oauth });
  await assertYouTubeChannel(youtube, uploadChannel);

  let video = await getVideo(youtube, args.videoId);
  const privacyStatusApproval = await verifyPrivacyStatusApproval(
    args,
    manifest,
    video.status?.privacyStatus,
  );
  const lockedPrivacyStatus = privacyStatusApproval.status;
  let originalDifferences = originalMetadataDifferences(expectedOriginal, video);
  if (originalDifferences.length > 0) {
    throw new Error(`Original Korean metadata changed: ${originalDifferences.join(", ")}`);
  }
  const playlistId = expectedOriginal.playlistId;
  if (playlistId) {
    const playlistResponse = await youtube.playlistItems.list({
      part: ["id"],
      playlistId,
      videoId: args.videoId,
      maxResults: 5,
    });
    if ((playlistResponse.data.items ?? []).length === 0) {
      throw new Error(`Video is no longer in expected playlist: ${playlistId}`);
    }
  }

  let captions = await getCaptions(youtube, args.videoId);
  manifest.verification = manifest.verification ?? {};
  if (noManualCaptions) {
    const standardCaptions = captions.filter((item) => item.snippet?.trackKind === "standard");
    if (standardCaptions.length > 0) {
      throw new Error(`No-caption request unexpectedly has ${standardCaptions.length} manual caption track(s)`);
    }
    manifest.verification.koreanCaptionPreflight = {
      checkedAt: new Date().toISOString(),
      notApplicable: true,
      reason: "caption_policy_none",
      manualCaptionCount: 0,
    };
    process.stdout.write(
      `PREFLIGHT_OK video=${args.videoId} privacy=${lockedPrivacyStatus} manualCaptions=none processing=${video.processingDetails?.processingStatus ?? "unknown"}\n`,
    );
  } else {
    const koreanManualCaptions = captions.filter(
      (item) => item.snippet?.language === "ko" && item.snippet?.trackKind === "standard",
    );
    if (koreanManualCaptions.length !== 1) {
      throw new Error(`Expected exactly one Korean manual caption, found ${koreanManualCaptions.length}`);
    }
    const koreanCaption = koreanManualCaptions[0];
    if (!koreanCaption?.id || koreanCaption.snippet?.status !== "serving") {
      throw new Error("Existing Korean manual caption is missing or not serving");
    }
    const expectedKoreanCaption = manifest.protectedBaseline?.koreanCaption;
    if (
      expectedKoreanCaption &&
      (expectedKoreanCaption.id !== koreanCaption.id ||
        expectedKoreanCaption.lastUpdated !== koreanCaption.snippet?.lastUpdated)
    ) {
      throw new Error("Korean manual caption ID or lastUpdated changed after the protected public baseline");
    }
    const cleanKoreanRaw = await readFile(path.resolve(args.cleanKorean), "utf8");
    const koreanDownloadResponse = await youtube.captions.download(
      { id: koreanCaption.id, tfmt: "srt" },
      { responseType: "arraybuffer" },
    );
    const downloadedKoreanRaw = Buffer.from(koreanDownloadResponse.data).toString("utf8");
    const downloadedKoreanPath = path.join(verificationDir, "youtube_korean_ko_preflight.srt");
    await writeFile(downloadedKoreanPath, downloadedKoreanRaw, "utf8");
    const koreanComparison = compareSrt(cleanKoreanRaw, downloadedKoreanRaw);
    if (!koreanComparison.ok) {
      throw new Error("Current YouTube Korean manual caption differs from the locked clean Korean SRT");
    }
    manifest.verification.koreanCaptionPreflight = {
      checkedAt: new Date().toISOString(),
      captionId: koreanCaption.id,
      lastUpdated: koreanCaption.snippet?.lastUpdated,
      downloadedCaptionPath: downloadedKoreanPath,
      comparison: koreanComparison,
    };
    process.stdout.write(
      `PREFLIGHT_OK video=${args.videoId} privacy=${lockedPrivacyStatus} koreanCaption=${koreanCaption.id} koreanCues=${koreanComparison.actualCueCount} processing=${video.processingDetails?.processingStatus ?? "unknown"}\n`,
    );
  }

  manifest.execution = manifest.execution ?? {};
  manifest.execution.englishAndLocalizationsDeferredUntilUserOk = false;
  manifest.execution.playbackSyncApproval = playbackSyncApproval;
  if (captionSourceAuthorityBinding) {
    manifest.execution.captionSourceAuthorityBinding = captionSourceAuthorityBinding;
  }
  manifest.execution.extensionAuthorizedAt = manifest.execution.extensionAuthorizedAt ?? new Date().toISOString();
  manifest.execution.state = args.verifyOnly ? "extension_verification_running" : "extension_running";
  await writeJsonAtomic(manifestPath, manifest);

  if (!args.metadataOnly) {
    const captionPath = path.resolve(args.caption);
    const englishRaw = await readFile(captionPath, "utf8");
    if (parseSrt(englishRaw).length !== captionSourcePreflight.expectedCueCount) {
      throw new Error(
        `English caption must contain exactly ${captionSourcePreflight.expectedCueCount} locked cues`,
      );
    }
    manifest.execution.captionRevisionId = captionSourcePreflight.revisionId;
    manifest.execution.captionSourcePreflightPath = captionSourcePreflight.reportPath;
    const existingEnglishManualCaptions = captions.filter(
      (item) => item.snippet?.language === "en" && item.snippet?.trackKind === "standard",
    );
    if (existingEnglishManualCaptions.length > 1) {
      throw new Error(`Expected at most one English manual caption, found ${existingEnglishManualCaptions.length}`);
    }
    let englishCaption = existingEnglishManualCaptions[0];
    if (!englishCaption?.id && !args.verifyOnly) {
      const insertResponse = await youtube.captions.insert({
        part: ["snippet"],
        requestBody: {
          snippet: {
            videoId: args.videoId,
            language: "en",
            name: "English",
            isDraft: false,
          },
        },
        media: {
          mimeType: "application/octet-stream",
          body: createReadStream(captionPath),
        },
      });
      englishCaption = insertResponse.data;
      process.stdout.write(`ENGLISH_CAPTION_UPLOAD_COMPLETE ${englishCaption.id ?? "unknown"}\n`);
    } else if (!englishCaption?.id) {
      throw new Error("English caption does not exist in verify-only mode");
    } else {
      process.stdout.write(`ENGLISH_CAPTION_REUSED ${englishCaption.id}\n`);
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      captions = await getCaptions(youtube, args.videoId);
      englishCaption = captions.find(
        (item) => item.snippet?.language === "en" && item.snippet?.trackKind === "standard",
      );
      if (englishCaption?.snippet?.status === "serving") break;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (!englishCaption?.id || englishCaption.snippet?.status !== "serving") {
      throw new Error(`English caption is not serving: ${englishCaption?.snippet?.status ?? "missing"}`);
    }

    const downloadResponse = await youtube.captions.download(
      { id: englishCaption.id, tfmt: "srt" },
      { responseType: "arraybuffer" },
    );
    const downloadedRaw = Buffer.from(downloadResponse.data).toString("utf8");
    const downloadedPath = path.join(verificationDir, "youtube_english_en.srt");
    await writeFile(downloadedPath, downloadedRaw, "utf8");
    const comparison = compareSrt(englishRaw, downloadedRaw);
    manifest.execution.englishCaptionId = englishCaption.id;
    manifest.execution.englishCaptionServing = true;
    manifest.execution.englishCaptionBodyVerified = comparison.ok;
    manifest.verification = manifest.verification ?? {};
    manifest.verification.englishCaption = {
      checkedAt: new Date().toISOString(),
      trackStatus: englishCaption.snippet?.status,
      comparison,
      downloadedCaptionPath: downloadedPath,
    };
    await writeJsonAtomic(manifestPath, manifest);
    if (!comparison.ok) throw new Error("Downloaded English caption differs from the local SRT");
    process.stdout.write(`ENGLISH_CAPTION_VERIFIED cues=${comparison.actualCueCount}\n`);
  }

  if (!args.captionOnly) {
    const metadataPath = path.resolve(args.metadata);
    const metadata = await readJson(metadataPath);
    const expectedLocalizations = metadata.localizations ?? {};
    const languages = Object.keys(expectedLocalizations);
    const supportedResponse = await youtube.i18nLanguages.list({
      part: ["snippet"],
      hl: "en",
    });
    const defaultLanguage = metadata.defaultLanguage ?? "ko";
    const supportedLanguages = (supportedResponse.data.items ?? [])
      .map((item) => item.id)
      .filter((language) => language && language !== defaultLanguage);
    const coveredLanguages = new Set(languages.map(normalizeLanguage));
    const missingSupportedLanguages = supportedLanguages.filter(
      (language) => !coveredLanguages.has(normalizeLanguage(language)),
    );
    if (missingSupportedLanguages.length > 0) {
      throw new Error(
        `Metadata does not cover every current YouTube language: ${missingSupportedLanguages.join(", ")}`,
      );
    }
    for (const [language, localization] of Object.entries(expectedLocalizations)) {
      if (!localization.title || localization.title.length > 100) {
        throw new Error(`Invalid title for ${language}: ${localization.title?.length ?? 0}`);
      }
      if (!localization.description || localization.description.length > 5000) {
        throw new Error(`Invalid description for ${language}: ${localization.description?.length ?? 0}`);
      }
      if (COMFY_REFERRAL_URL && !linkRules.affiliateAllowed && localization.description.includes(COMFY_REFERRAL_URL)) {
        throw new Error(`Forbidden affiliate link is present in ${language} description`);
      }
      if (COMFY_REFERRAL_URL && linkRules.affiliateAllowed && !localization.description.includes(COMFY_REFERRAL_URL)) {
        throw new Error(`ComfyUI Deno referral link is missing from ${language} description`);
      }
      if (DENO_DISCORD_URL && linkRules.discordRequired && !localization.description.includes(DENO_DISCORD_URL)) {
        throw new Error(`Deno Discord link is missing from ${language} description`);
      }
    }

    video = await getVideo(youtube, args.videoId);
    const currentRaw = video.localizations ?? {};
    const currentNormalized = normalizedLocalizations(currentRaw);
    const collisions = [];
    for (const [language, expected] of Object.entries(expectedLocalizations)) {
      const existing = currentNormalized[normalizeLanguage(language)];
      if (existing && (existing.title !== expected.title || existing.description !== expected.description)) {
        collisions.push(language);
      }
    }
    if (collisions.length > 0) {
      throw new Error(`Existing Studio localizations differ and will not be overwritten: ${collisions.join(", ")}`);
    }

    const pending = languages.filter((language) => {
      const existing = currentNormalized[normalizeLanguage(language)];
      const expected = expectedLocalizations[language];
      return !existing || existing.title !== expected.title || existing.description !== expected.description;
    });
    manifest.execution.localizationExpectedCount = languages.length;
    manifest.execution.youtubeSupportedLanguageSnapshot = supportedLanguages;
    manifest.execution.youtubeSupportedLanguageTargetCount = supportedLanguages.length;
    manifest.execution.youtubeSupportedLanguageMissing = [];
    manifest.execution.localizationAppliedLanguages = languages.filter((language) => !pending.includes(language));
    manifest.execution.localizationPendingLanguages = pending;
    await writeJsonAtomic(manifestPath, manifest);

    if (!args.verifyOnly) {
      let cumulative = { ...currentRaw };
      for (let index = 0; index < pending.length; index += LOCALIZATION_BATCH_SIZE) {
        const batch = pending.slice(index, index + LOCALIZATION_BATCH_SIZE);
        for (const language of batch) cumulative[language] = expectedLocalizations[language];
        try {
          await youtube.videos.update({
            part: ["localizations"],
            requestBody: localizationUpdateRequestBody(args.videoId, cumulative),
          });
        } catch (error) {
          manifest.execution.state = isQuotaError(error)
            ? "verification_pending_quota_exceeded"
            : "localization_update_failed";
          manifest.execution.localizationPendingLanguages = pending.slice(index);
          await writeJsonAtomic(manifestPath, manifest);
          throw error;
        }
        manifest.execution.localizationAppliedLanguages = [
          ...new Set([...(manifest.execution.localizationAppliedLanguages ?? []), ...batch]),
        ];
        manifest.execution.localizationPendingLanguages = pending.slice(index + batch.length);
        manifest.execution.lastLocalizationBatch = batch;
        manifest.execution.lastLocalizationBatchAppliedAt = new Date().toISOString();
        await writeJsonAtomic(manifestPath, manifest);
        process.stdout.write(`LOCALIZATION_BATCH_COMPLETE ${batch.join(",")}\n`);
      }
    }

    video = await getVideo(youtube, args.videoId);
    const actual = normalizedLocalizations(video.localizations ?? {});
    const localizationDifferences = [];
    for (const [language, expected] of Object.entries(expectedLocalizations)) {
      const value = actual[normalizeLanguage(language)];
      if (!value) localizationDifferences.push({ language, issue: "missing" });
      else if (value.title !== expected.title) localizationDifferences.push({ language, issue: "title" });
      else if (value.description !== expected.description) {
        localizationDifferences.push({ language, issue: "description" });
      }
    }
    manifest.execution.localizationAppliedLanguages = languages.filter(
      (language) => !localizationDifferences.some((difference) => difference.language === language),
    );
    manifest.execution.localizationPendingLanguages = languages.filter(
      (language) => localizationDifferences.some((difference) => difference.language === language),
    );
    manifest.execution.localizationsVerified = localizationDifferences.length === 0;
    manifest.verification = manifest.verification ?? {};
    manifest.verification.localizations = {
      checkedAt: new Date().toISOString(),
      expectedCount: languages.length,
      actualExpectedLanguageCount: manifest.execution.localizationAppliedLanguages.length,
      differences: localizationDifferences,
      hebrewReturnCode: Object.hasOwn(video.localizations ?? {}, "iw") ? "iw" : "he",
    };
    await writeJsonAtomic(manifestPath, manifest);
    if (localizationDifferences.length > 0) {
      throw new Error(`Localization verification failed: ${JSON.stringify(localizationDifferences)}`);
    }
    process.stdout.write(`LOCALIZATIONS_VERIFIED count=${languages.length}\n`);
  }

  video = await getVideo(youtube, args.videoId);
  originalDifferences = originalMetadataDifferences(expectedOriginal, video);
  captions = await getCaptions(youtube, args.videoId);
  const finalKorean = captions.find(
    (item) => item.snippet?.language === "ko" && item.snippet?.trackKind === "standard",
  );
  const finalEnglish = captions.find(
    (item) => item.snippet?.language === "en" && item.snippet?.trackKind === "standard",
  );
  if (originalDifferences.length > 0) {
    throw new Error(`Final Korean metadata verification failed: ${originalDifferences.join(", ")}`);
  }
  if (!noManualCaptions && (!finalKorean?.id || finalKorean.snippet?.status !== "serving")) {
    throw new Error("Final Korean caption verification failed");
  }
  if (!args.metadataOnly && (!finalEnglish?.id || finalEnglish.snippet?.status !== "serving")) {
    throw new Error("Final English caption verification failed");
  }
  manifest.execution.state = noManualCaptions
    ? args.metadataOnly && manifest.execution.localizationsVerified
      ? "youtube_video_only_localizations_verified_complete"
      : "verification_pending"
    : manifest.execution.englishCaptionBodyVerified &&
        (args.captionOnly || manifest.execution.localizationsVerified)
      ? args.captionOnly
        ? "english_caption_verified_localizations_pending"
        : "youtube_extension_verified_complete"
      : "verification_pending";
  manifest.status = manifest.execution.state;
  manifest.verification.finalRereadAt = new Date().toISOString();
  manifest.verification.finalOriginalMetadataDifferences = originalDifferences;
  manifest.verification.finalPrivacyStatus = video.status?.privacyStatus;
  manifest.verification.privacyStatusApproval = privacyStatusApproval;
  manifest.verification.finalKoreanCaptionStatus = finalKorean?.snippet?.status ?? null;
  manifest.verification.finalEnglishCaptionStatus = finalEnglish?.snippet?.status ?? null;
  manifest.verification.finalManualCaptionsExpected = !noManualCaptions;
  await writeJsonAtomic(manifestPath, manifest);
  const executedMarkerPath = path.join(requestDir, "EXECUTED");
  const executedMarker = await readJson(executedMarkerPath).catch(() => null);
  if (executedMarker) {
    if (
      executedMarker.requestId !== manifest.requestId ||
      executedMarker.videoId !== args.videoId
    ) {
      throw new Error("EXECUTED marker does not match the current request and YouTube video");
    }
    await writeJsonAtomic(executedMarkerPath, {
      ...executedMarker,
      state: manifest.execution.state,
      localizationsVerified: manifest.execution.localizationsVerified ?? false,
      localizationCount: manifest.execution.localizationAppliedLanguages?.length ?? 0,
      verifiedAt: manifest.verification.finalRereadAt,
    });
  }

  process.stdout.write(`FINAL_RESULT ${JSON.stringify({
    videoId: args.videoId,
    state: manifest.execution.state,
    privacyStatus: video.status?.privacyStatus,
    englishCaptionBodyVerified: manifest.execution.englishCaptionBodyVerified ?? false,
    manualCaptionsExpected: !noManualCaptions,
    localizationsVerified: manifest.execution.localizationsVerified ?? false,
    localizationCount: manifest.execution.localizationAppliedLanguages?.length ?? 0,
    koreanMetadataDifferences: originalDifferences,
  })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`EXTENSION_FAILED ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  localizationUpdateRequestBody,
  verifyCaptionSourceAuthorityBinding,
  verifyPlaybackSyncApproval,
  verifyPrivacyStatusApproval,
};
