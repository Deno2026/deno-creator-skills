#!/usr/bin/env node

const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { createReadStream } = require("node:fs");
const {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} = require("node:fs/promises");
const path = require("node:path");
const { Transform } = require("node:stream");

const {
  HELPER_INITIAL_PRIVACY_STATUS,
  RUNTIME_PATHS,
  loadAndValidateLatestReadyRequest,
} = require("./lib/helper_ready_gate.cjs");
const {
  prepareVideoOverlaySamples,
  verifyVideoOverlayReview,
} = require("./lib/video_overlay_review.cjs");
const { google } = require("googleapis");
const { channelRuntimePaths, parseChannelArg, resolveToolChannel } = require("./lib/youtube_channel.cjs");

function parseArgs(argv) {
  const args = { config: "", requestId: "", expectedChannelId: "", preflightOnly: false };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--config") {
      args.config = argv[index + 1] ?? "";
      index += 1;
    } else if (argv[index] === "--request-id") {
      args.requestId = argv[index + 1] ?? "";
      index += 1;
    } else if (argv[index] === "--expected-channel-id") {
      args.expectedChannelId = argv[index + 1] ?? "";
      index += 1;
    } else if (argv[index] === "--preflight") {
      args.preflightOnly = true;
    } else if (argv[index] === "--channel" || String(argv[index]).startsWith("--channel=")) {
      // READY에 기록된 채널과 같아야 한다(다르면 youtube_channel.resolveToolChannel이 멈춘다).
      if (argv[index] === "--channel") index += 1;
    }
  }
  if (!args.config && !args.requestId) {
    throw new Error("--request-id is required (legacy --config is accepted only when it names the same Helper request)");
  }
  if (args.config && args.requestId) throw new Error("Use either --request-id or --config, not both");
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

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex").toUpperCase();
}

function countSrtCues(raw) {
  return (raw.replace(/^\uFEFF/, "").match(/^\d+\s*$/gm) ?? []).length;
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
      if (timingIndex < 0) return null;
      const number = Number(lines[timingIndex - 1]?.trim());
      const timing = lines[timingIndex].trim().replace(/\./g, ",");
      const text = lines
        .slice(timingIndex + 1)
        .map((line) => line.trimEnd())
        .join("\n")
        .trim();
      return { number, timing, text };
    })
    .filter(Boolean);
}

function compareSrt(expectedRaw, actualRaw) {
  const expected = parseSrt(expectedRaw);
  const actual = parseSrt(actualRaw);
  const differences = [];
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
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

function progressStream(filePath, totalBytes) {
  let uploaded = 0;
  let lastPercent = -1;
  let lastReportedAt = 0;
  const progress = new Transform({
    transform(chunk, encoding, callback) {
      uploaded += chunk.length;
      const percent = Math.floor((uploaded / totalBytes) * 100);
      const now = Date.now();
      if (percent >= lastPercent + 5 || now - lastReportedAt >= 30000 || uploaded === totalBytes) {
        lastPercent = percent;
        lastReportedAt = now;
        process.stdout.write(`VIDEO_UPLOAD_PROGRESS ${percent}% ${uploaded}/${totalBytes}\n`);
      }
      callback(null, chunk);
    },
  });
  return createReadStream(filePath).pipe(progress);
}

function thumbnailMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

async function runFfmpeg(args) {
  await new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.on("data", (chunk) => {
      if (errorText.length < 8000) errorText += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg thumbnail preparation failed (${code}): ${errorText.trim()}`));
    });
  });
}

async function prepareThumbnailForYouTube(inputPath, inputStat, outputDir) {
  const maxBytes = 2 * 1024 * 1024;
  if (inputStat.size <= maxBytes) {
    return {
      path: inputPath,
      size: inputStat.size,
      mimeType: thumbnailMimeType(inputPath),
      converted: false,
    };
  }
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "thumbnail_youtube_ready.jpg");
  for (const quality of [2, 4, 6, 8, 10]) {
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-vf",
      "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
      "-frames:v",
      "1",
      "-q:v",
      String(quality),
      outputPath,
    ]);
    const outputStat = await stat(outputPath);
    if (outputStat.size <= maxBytes) {
      return {
        path: outputPath,
        size: outputStat.size,
        mimeType: "image/jpeg",
        converted: true,
        sourceSize: inputStat.size,
        ffmpegQuality: quality,
      };
    }
  }
  throw new Error("Prepared YouTube thumbnail still exceeds the 2 MiB API limit");
}

async function saveRefreshedToken(tokenPath, token) {
  const existing = await readJson(tokenPath);
  await writeJsonAtomic(tokenPath, {
    ...existing,
    ...token,
    refresh_token: token.refresh_token ?? existing.refresh_token,
  });
}

function normalizeKoreanFirstMetadata(rawMetadata, { contentKind, noManualCaptions } = {}) {
  if (!rawMetadata || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
    throw new Error("Korean-first upload metadata is required");
  }

  // Korean metadata stays ko. Caption-free cinematic audio keeps its actual
  // language; both fields remain explicit and manual-KO uploads still require ko.
  const defaultLanguage = String(rawMetadata.defaultLanguage ?? "")
    .trim()
    .toLowerCase();
  const defaultAudioLanguage = String(rawMetadata.defaultAudioLanguage ?? "")
    .trim()
    .toLowerCase();

  const isNoCaptionCinematic = contentKind === "cinematic" && noManualCaptions === true;
  if (defaultLanguage !== "ko" || (isNoCaptionCinematic
    ? !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(defaultAudioLanguage)
    : defaultAudioLanguage !== "ko")) {
    throw new Error(
      isNoCaptionCinematic
        ? "No-caption cinematic metadata requires defaultLanguage=ko and a valid actual defaultAudioLanguage"
        : `Korean-first language policy requires defaultLanguage=ko and defaultAudioLanguage=ko; received defaultLanguage=${defaultLanguage || "(missing)"}, defaultAudioLanguage=${defaultAudioLanguage || "(missing)"}`,
    );
  }

  return {
    ...rawMetadata,
    defaultLanguage: "ko",
    defaultAudioLanguage,
  };
}

function cloneExpectedMetadata(metadata) {
  return {
    ...metadata,
    tags: Array.isArray(metadata.tags) ? [...metadata.tags] : metadata.tags,
  };
}

function buildExpectedMetadataAudit(requestedMetadata, effectiveMetadata, playlistId) {
  if (!requestedMetadata || typeof requestedMetadata !== "object" || Array.isArray(requestedMetadata)) {
    throw new Error("Helper request metadata is required for the requested-value audit");
  }
  if (!effectiveMetadata || typeof effectiveMetadata !== "object" || Array.isArray(effectiveMetadata)) {
    throw new Error("Gate-normalized metadata is required for the effective-value audit");
  }

  return {
    // Keep the Helper request exactly as it was saved for audit purposes. In
    // particular, do not replace its requested visibility with the uploader's
    // enforced initial visibility.
    requestedExpected: cloneExpectedMetadata(requestedMetadata),
    // Verification follows the actual values sent to videos.insert. Helper
    // longform/cinematic requests are normalized to unlisted by the READY gate;
    // direct Shorts remain private.
    effectiveExpected: {
      ...cloneExpectedMetadata(effectiveMetadata),
      playlistId,
    },
  };
}

function buildInitialInsertVisibilityEvidence({
  contentKind,
  requestBodyPrivacyStatus,
  insertResponsePrivacyStatus,
}) {
  const expectedInitialPrivacyStatus =
    contentKind === "shorts" ? "private" : HELPER_INITIAL_PRIVACY_STATUS;
  const requested = String(requestBodyPrivacyStatus ?? "").trim();
  const returned = String(insertResponsePrivacyStatus ?? "").trim();
  return {
    source: "youtube.videos.insert",
    expectedInitialPrivacyStatus,
    requestBodyPrivacyStatus: requested || null,
    insertResponsePrivacyStatus: returned || null,
    verified: requested === expectedInitialPrivacyStatus && returned === expectedInitialPrivacyStatus,
  };
}

function metadataDiff(expected, item) {
  const actualTags = item.snippet?.tags ?? [];
  const expectedTags = expected.tags ?? [];
  const differences = [];
  if (item.snippet?.title !== expected.title) differences.push("title");
  if (item.snippet?.description !== expected.description) differences.push("description");
  if (item.snippet?.categoryId !== expected.categoryId) differences.push("categoryId");
  if (expected.defaultLanguage !== "ko" || item.snippet?.defaultLanguage !== "ko") {
    differences.push("defaultLanguage");
  }
  if (
    !expected.defaultAudioLanguage ||
    item.snippet?.defaultAudioLanguage !== expected.defaultAudioLanguage
  ) {
    differences.push("defaultAudioLanguage");
  }
  // Initial visibility is verified once against the videos.insert response.
  // After the video ID exists, live visibility is user-controlled state and is
  // recorded read-only rather than normalized or treated as a metadata failure.
  const normalizedActualTags = [...actualTags].sort((left, right) =>
    left.localeCompare(right),
  );
  const normalizedExpectedTags = [...expectedTags].sort((left, right) =>
    left.localeCompare(right),
  );
  if (JSON.stringify(normalizedActualTags) !== JSON.stringify(normalizedExpectedTags)) {
    differences.push("tags");
  }
  return differences;
}

function isQuotaError(error) {
  const text = `${error?.message ?? ""} ${JSON.stringify(error?.response?.data ?? {})}`.toLowerCase();
  return text.includes("quotaexceeded") || text.includes("quota exceeded");
}

async function main() {
  const args = parseArgs(process.argv);
  const config = args.config
    ? await readJson(path.resolve(args.config))
    : { requestId: args.requestId, expectedChannelId: args.expectedChannelId || undefined };
  let validated = await loadAndValidateLatestReadyRequest(config);
  let {
    requestDir,
    manifestPath,
    readyPath,
    executedPath,
    verificationDir,
    videoPath,
    captionPath,
    videoStat,
    captionStat,
    captionRaw,
    cueCount,
    noManualCaptions,
    thumbnailPath,
    thumbnailStat,
    thumbnailUploadAuthorized,
  } = validated;
  const metadata = normalizeKoreanFirstMetadata(validated.metadata, {
    contentKind: validated.manifest.contentKind,
    noManualCaptions,
  });
  let preparedOverlayReview = null;
  let videoOverlayReview = null;
  if (
    validated.manifest.contentKind === "cinematic" ||
    validated.manifest.contentKind === "shorts"
  ) {
    process.stdout.write(
      `PREFLIGHT_VIDEO_OVERLAY_NOT_APPLICABLE ${validated.manifest.contentKind}_non_tutorial\n`,
    );
  } else {
    preparedOverlayReview = await prepareVideoOverlaySamples({
      requestDir,
      manifest: validated.manifest,
      videoPath,
      videoStat,
      verificationDir,
      policyPath: RUNTIME_PATHS.videoOverlayPolicyPath,
    });
    process.stdout.write(
      `PREFLIGHT_VIDEO_OVERLAY_SAMPLES_READY count=${preparedOverlayReview.manifest.samples.length} ` +
        `reused=${preparedOverlayReview.reused} contactSheet=${preparedOverlayReview.contactSheetPath}\n`,
    );
    videoOverlayReview = await verifyVideoOverlayReview({
      requestDir,
      manifest: validated.manifest,
      videoStat,
      prepared: preparedOverlayReview,
    });
    process.stdout.write(
      `PREFLIGHT_VIDEO_OVERLAY_OK evidence=${videoOverlayReview.review.evidenceSampleIndexes.join(",")} ` +
        `review=${videoOverlayReview.path}\n`,
    );
  }
  // 업로드 채널 = READY에 기록된 채널(이전 READY는 DENO). 그 채널 칸의 토큰을 쓰고 실제 채널 ID를 대조한다.
  const uploadChannel = resolveToolChannel({
    channelArg: parseChannelArg(process.argv.slice(2)),
    manifest: validated.manifest,
  });
  const tokenPath = channelRuntimePaths(uploadChannel).oauthTokenPath;
  const settingsPath = RUNTIME_PATHS.settingsPath;
  const [settings, token] = await Promise.all([readJson(settingsPath), readJson(tokenPath)]);

  const oauth = new google.auth.OAuth2(
    settings.clientId,
    settings.clientSecret,
    settings.redirectUri,
  );
  oauth.setCredentials(token);
  oauth.on("tokens", (refreshed) => {
    void saveRefreshedToken(tokenPath, refreshed).catch((error) => {
      process.stderr.write(`TOKEN_SAVE_WARNING ${error.message}\n`);
    });
  });
  const youtube = google.youtube({ version: "v3", auth: oauth });

  const channelResponse = await youtube.channels.list({
    part: ["id", "snippet"],
    mine: true,
  });
  const channel = channelResponse.data.items?.[0];
  if (!channel?.id) throw new Error("No YouTube channel is connected");
  if (config.expectedChannelId && channel.id !== config.expectedChannelId) {
    throw new Error(`Connected channel mismatch: ${channel.id}`);
  }
  if (channel.id !== uploadChannel.youtubeChannelId) {
    throw new Error(
      `YOUTUBE_CHANNEL_MISMATCH: READY targets ${uploadChannel.title} ${uploadChannel.handle} (${uploadChannel.youtubeChannelId}), ` +
        `token belongs to ${channel.snippet?.title ?? ""} (${channel.id})`,
    );
  }
  const playlistId = String(metadata.playlistId ?? "").trim();

  process.stdout.write(`PREFLIGHT_CHANNEL_OK ${channel.id} ${channel.snippet?.title ?? ""}\n`);
  process.stdout.write(
    playlistId
      ? `PREFLIGHT_PLAYLIST_ID_OK ${playlistId}\n`
      : "PREFLIGHT_PLAYLIST_SKIPPED no_playlist_selected\n",
  );
  process.stdout.write(
    noManualCaptions
      ? `PREFLIGHT_FILES_OK video=${videoStat.size} caption=none cues=0\n`
      : `PREFLIGHT_FILES_OK video=${videoStat.size} caption=${captionStat.size} cues=${cueCount}\n`,
  );
  process.stdout.write(
    thumbnailUploadAuthorized
      ? `PREFLIGHT_THUMBNAIL_AUTHORIZED ${thumbnailPath} ${thumbnailStat.size}\n`
      : "PREFLIGHT_THUMBNAIL_SKIPPED no_authorized_thumbnail\n",
  );

  if (args.preflightOnly) {
    process.stdout.write(`PREFLIGHT_COMPLETE ${manifestPath}\n`);
    return;
  }

  await mkdir(verificationDir, { recursive: true });
  const preparedThumbnail = thumbnailUploadAuthorized
    ? await prepareThumbnailForYouTube(thumbnailPath, thumbnailStat, verificationDir)
    : null;
  let manifest = validated.manifest;
  const expectedMetadataAudit = buildExpectedMetadataAudit(
    manifest.metadata,
    metadata,
    playlistId,
  );
  manifest.requestedExpected = expectedMetadataAudit.requestedExpected;
  manifest.effectiveExpected = expectedMetadataAudit.effectiveExpected;
  manifest.execution = {
    state: "preflight_ready",
    videoId: null,
    videoUrl: null,
    playlistAdded: false,
    captionId: null,
    metadataVerified: false,
    playlistVerified: false,
    captionBodyVerified: noManualCaptions,
    manualCaptionsExpected: !noManualCaptions,
    thumbnailUploadAuthorized,
    thumbnailUploaded: false,
    thumbnailVerified: !thumbnailUploadAuthorized,
    publicTransitionAuthorized: false,
    englishAndLocalizationsDeferredUntilUserOk: !noManualCaptions,
    ...(manifest.execution ?? {}),
  };
  manifest.execution.videoOverlayReview = videoOverlayReview
    ? {
        verified: true,
        decision: videoOverlayReview.review.decision,
        reviewRule: videoOverlayReview.review.reviewRule,
        reviewPath: videoOverlayReview.path,
        sampleManifestPath: preparedOverlayReview.sampleManifestPath,
        sampleManifestSha256: preparedOverlayReview.manifestSha256,
        contactSheetPath: preparedOverlayReview.contactSheetPath,
        evidenceSampleIndexes: videoOverlayReview.review.evidenceSampleIndexes,
      }
    : {
        verified: true,
        decision: "not_applicable_non_tutorial",
        reviewRule:
          validated.manifest.contentKind === "shorts"
            ? "shorts_content_kind"
            : "cinematic_content_kind",
        evidenceSampleIndexes: [],
      };
  await writeJsonAtomic(manifestPath, manifest);

  let videoId = manifest.execution.videoId;
  if (!videoId) {
    validated = await loadAndValidateLatestReadyRequest(config);
    videoPath = validated.videoPath;
    videoStat = validated.videoStat;
    manifest.status = "executing_video_upload";
    manifest.execution.state = "uploading_video";
    await writeJsonAtomic(manifestPath, manifest);
    process.stdout.write("VIDEO_UPLOAD_START\n");
    const response = await youtube.videos.insert({
      part: ["snippet", "status"],
      notifySubscribers: metadata.notifySubscribers,
      requestBody: {
        snippet: {
          title: metadata.title,
          description: metadata.description,
          tags: metadata.tags,
          defaultLanguage: metadata.defaultLanguage,
          defaultAudioLanguage: metadata.defaultAudioLanguage,
          categoryId: metadata.categoryId,
        },
        status: {
          privacyStatus: metadata.privacyStatus,
          selfDeclaredMadeForKids: metadata.madeForKids,
          containsSyntheticMedia: metadata.containsSyntheticMedia,
          embeddable: metadata.embeddable,
          publicStatsViewable: metadata.publicStatsViewable,
          license: metadata.license,
        },
      },
      media: {
        mimeType: "video/mp4",
        body: progressStream(videoPath, videoStat.size),
      },
    });
    videoId = response.data.id;
    if (!videoId) throw new Error("YouTube videos.insert returned no video ID");
    const initialVisibilityEvidence = buildInitialInsertVisibilityEvidence({
      contentKind: manifest.contentKind,
      requestBodyPrivacyStatus: metadata.privacyStatus,
      insertResponsePrivacyStatus: response.data.status?.privacyStatus,
    });
    manifest.execution.videoId = videoId;
    manifest.execution.videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    manifest.execution.initialVisibility = {
      ...initialVisibilityEvidence,
      checkedAt: new Date().toISOString(),
    };
    manifest.execution.state =
      initialVisibilityEvidence.verified
        ? metadata.privacyStatus === HELPER_INITIAL_PRIVACY_STATUS
          ? "video_uploaded_unlisted"
          : "video_uploaded_private"
        : "initial_visibility_verification_failed";
    await writeJsonAtomic(manifestPath, manifest);
    if (!initialVisibilityEvidence.verified) {
      throw new Error(
        `Initial videos.insert visibility mismatch: expected=${initialVisibilityEvidence.expectedInitialPrivacyStatus} request=${initialVisibilityEvidence.requestBodyPrivacyStatus ?? "missing"} response=${initialVisibilityEvidence.insertResponsePrivacyStatus ?? "missing"}`,
      );
    }
    process.stdout.write(`VIDEO_UPLOAD_COMPLETE ${videoId}\n`);
  } else {
    if (manifest.execution.initialVisibility?.verified !== true) {
      throw new Error(
        "Existing uploaded video is missing verified initial videos.insert visibility evidence",
      );
    }
    process.stdout.write(`VIDEO_UPLOAD_SKIPPED_EXISTING ${videoId}\n`);
  }

  if (preparedThumbnail && !manifest.execution.thumbnailUploaded) {
    validated = await loadAndValidateLatestReadyRequest(config);
    manifest = validated.manifest;
    manifest.execution.state = "uploading_thumbnail";
    manifest.execution.thumbnailPrepared = {
      path: preparedThumbnail.path,
      size: preparedThumbnail.size,
      mimeType: preparedThumbnail.mimeType,
      converted: preparedThumbnail.converted,
      sourceSize: preparedThumbnail.sourceSize ?? preparedThumbnail.size,
      ffmpegQuality: preparedThumbnail.ffmpegQuality ?? null,
    };
    await writeJsonAtomic(manifestPath, manifest);
    await youtube.thumbnails.set({
      videoId,
      media: {
        mimeType: preparedThumbnail.mimeType,
        body: createReadStream(preparedThumbnail.path),
      },
    });
    manifest.execution.thumbnailUploaded = true;
    manifest.execution.thumbnailUploadedAt = new Date().toISOString();
    await writeJsonAtomic(manifestPath, manifest);
    process.stdout.write(
      `THUMBNAIL_UPLOAD_COMPLETE bytes=${preparedThumbnail.size} converted=${preparedThumbnail.converted}\n`,
    );
  } else if (!preparedThumbnail) {
    process.stdout.write("THUMBNAIL_UPLOAD_SKIPPED no_authorized_thumbnail\n");
  } else {
    process.stdout.write("THUMBNAIL_UPLOAD_SKIPPED_EXISTING\n");
  }

  if (playlistId && !manifest.execution.playlistAdded) {
    validated = await loadAndValidateLatestReadyRequest(config);
    manifest = validated.manifest;
    await youtube.playlistItems.insert({
      part: ["snippet"],
      requestBody: {
        snippet: {
          playlistId,
          resourceId: { kind: "youtube#video", videoId },
        },
      },
    });
    manifest.execution.playlistAdded = true;
    await writeJsonAtomic(manifestPath, manifest);
    process.stdout.write(`PLAYLIST_ADD_COMPLETE ${playlistId}\n`);
  } else if (!playlistId) {
    process.stdout.write("PLAYLIST_ADD_SKIPPED no_playlist_selected\n");
  }

  if (!noManualCaptions && !manifest.execution.captionId) {
    validated = await loadAndValidateLatestReadyRequest(config);
    manifest = validated.manifest;
    captionPath = validated.captionPath;
    captionRaw = validated.captionRaw;
    const captionResponse = await youtube.captions.insert({
      part: ["snippet"],
      requestBody: {
        snippet: {
          videoId,
          language: "ko",
          name: "",
          isDraft: false,
        },
      },
      media: {
        mimeType: "application/octet-stream",
        body: createReadStream(captionPath),
      },
    });
    manifest.execution.captionId = captionResponse.data.id ?? null;
    manifest.execution.state = "korean_caption_uploaded";
    await writeJsonAtomic(manifestPath, manifest);
    process.stdout.write(`CAPTION_UPLOAD_COMPLETE ${manifest.execution.captionId ?? "unknown"}\n`);
  }

  const videoResponse = await youtube.videos.list({
    part: ["snippet", "status", "contentDetails"],
    id: [videoId],
  });
  const video = videoResponse.data.items?.[0];
  if (!video) throw new Error("Uploaded video was not returned by videos.list");
  const metadataDifferences = metadataDiff(manifest.effectiveExpected, video);
  manifest.execution.liveVisibility = {
    source: "youtube.videos.list",
    observedAt: new Date().toISOString(),
    privacyStatus: String(video.status?.privacyStatus ?? "").trim() || null,
    readOnly: true,
    userControlledAfterInsert: true,
    normalizedOrWrittenByUploader: false,
  };
  manifest.execution.metadataVerified = metadataDifferences.length === 0;
  manifest.execution.thumbnailVerified =
    !thumbnailUploadAuthorized ||
    (manifest.execution.thumbnailUploaded === true && video.contentDetails?.hasCustomThumbnail === true);

  if (playlistId) {
    const playlistItemsResponse = await youtube.playlistItems.list({
      part: ["id"],
      playlistId,
      videoId,
      maxResults: 5,
    });
    manifest.execution.playlistVerified = (playlistItemsResponse.data.items ?? []).length > 0;
  } else {
    manifest.execution.playlistVerified = true;
  }

  let koreanCaption = null;
  let downloadedCaptionPath = null;
  let captionComparison = {
    ok: true,
    skipped: true,
    reason:
      validated.manifest.contentKind === "shorts"
        ? "shorts_request_without_manual_caption_file"
        : "user_declared_no_manual_captions_at_request_click",
  };
  if (!noManualCaptions) {
    const captionsResponse = await youtube.captions.list({
      part: ["id", "snippet"],
      videoId,
    });
    koreanCaption = (captionsResponse.data.items ?? []).find(
      (item) => item.snippet?.language === "ko",
    );
    if (!koreanCaption?.id) {
      throw new Error("Korean caption track was not returned by captions.list");
    }
    manifest.execution.captionId = koreanCaption.id;

    let downloadedCaption = null;
    let lastDownloadError = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        const downloadResponse = await youtube.captions.download(
          { id: koreanCaption.id, tfmt: "srt" },
          { responseType: "arraybuffer" },
        );
        downloadedCaption = Buffer.from(downloadResponse.data).toString("utf8");
        break;
      } catch (error) {
        lastDownloadError = error;
        if (isQuotaError(error)) throw error;
        if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
    if (!downloadedCaption) {
      throw new Error(`Korean caption download failed: ${lastDownloadError?.message ?? "unknown"}`);
    }

    downloadedCaptionPath = path.join(verificationDir, "youtube_korean_ko.srt");
    await writeFile(downloadedCaptionPath, downloadedCaption, "utf8");
    captionComparison = compareSrt(captionRaw, downloadedCaption);
    manifest.execution.captionBodyVerified = captionComparison.ok;
  }
  manifest.execution.state =
    manifest.execution.metadataVerified &&
    manifest.execution.playlistVerified &&
    manifest.execution.captionBodyVerified &&
    manifest.execution.thumbnailVerified
      ? noManualCaptions
        ? validated.manifest.contentKind === "shorts"
          ? "shorts_private_upload_verified"
          : "video_only_upload_verified_ready_for_localizations"
        : "korean_first_upload_verified_waiting_user_ok"
      : "verification_mismatch";
  manifest.status = manifest.execution.state;
  manifest.verification = {
    checkedAt: new Date().toISOString(),
    metadataDifferences,
    visibility: {
      initialInsert: manifest.execution.initialVisibility ?? null,
      currentLiveReadOnly: manifest.execution.liveVisibility,
    },
    playlistVerified: manifest.execution.playlistVerified,
    thumbnail: {
      authorized: thumbnailUploadAuthorized,
      uploaded: manifest.execution.thumbnailUploaded,
      verified: manifest.execution.thumbnailVerified,
      hasCustomThumbnail: video.contentDetails?.hasCustomThumbnail ?? null,
      prepared: manifest.execution.thumbnailPrepared ?? null,
    },
    captionPolicy: noManualCaptions
      ? validated.manifest.contentKind === "shorts"
        ? "optional_shorts_no_manual_track"
        : "none"
      : "manual_ko_then_reviewed_en",
    captionTrackLanguage: koreanCaption?.snippet?.language ?? null,
    captionTrackStatus: koreanCaption?.snippet?.status ?? null,
    captionComparison,
    downloadedCaptionPath,
  };
  await writeJsonAtomic(manifestPath, manifest);
  const verificationPendingPath = path.join(requestDir, "VERIFICATION_PENDING");
  if (manifest.execution.state === "verification_mismatch") {
    await rm(executedPath, { force: true });
    await writeFile(
      verificationPendingPath,
      `${JSON.stringify({ requestId: config.requestId, videoId, state: manifest.execution.state }, null, 2)}\n`,
      "utf8",
    );
  } else {
    await rm(verificationPendingPath, { force: true });
    await rm(readyPath, { force: true });
    await writeFile(
      executedPath,
      `${JSON.stringify({ requestId: config.requestId, videoId, state: manifest.execution.state }, null, 2)}\n`,
      "utf8",
    );
  }

  process.stdout.write(`FINAL_RESULT ${JSON.stringify({
    videoId,
    videoUrl: manifest.execution.videoUrl,
    state: manifest.execution.state,
    metadataVerified: manifest.execution.metadataVerified,
    playlistVerified: manifest.execution.playlistVerified,
    captionBodyVerified: manifest.execution.captionBodyVerified,
    videoOverlayVerified: manifest.execution.videoOverlayReview?.verified === true,
    manualCaptionsExpected: !noManualCaptions,
    thumbnailUploaded: manifest.execution.thumbnailUploaded,
    thumbnailVerified: manifest.execution.thumbnailVerified,
  })}\n`);
}

if (require.main === module) {
  main().catch(async (error) => {
    process.stderr.write(`UPLOAD_FAILED ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildExpectedMetadataAudit,
  buildInitialInsertVisibilityEvidence,
  metadataDiff,
  normalizeKoreanFirstMetadata,
  prepareThumbnailForYouTube,
};
