const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const {
  access,
  readFile,
  readdir,
  realpath,
  stat,
} = require("node:fs/promises");
const path = require("node:path");

const {
  findProductionRoot,
  getUploadRuntimePaths,
  resolveUploadChannel, getDescriptionBlocks } = require("@deno/runtime-paths");
const { channelFromManifest, descriptionLinkRequirements } = require("./youtube_channel.cjs");

const PRODUCTION_ROOT = findProductionRoot();
const APP_ROOT = path.join(PRODUCTION_ROOT, "apps", "youtube-upload-helper");
const RUNTIME_PATHS = getUploadRuntimePaths();
const REQUESTS_ROOT = RUNTIME_PATHS.uploadRequestsRoot;
const SAFE_REQUEST_ID = /^[a-zA-Z0-9._-]{1,180}$/;
const SAFE_REVISION_ID = /^caption-[a-f0-9]{24}$/;
// 설명 고정 링크 값은 channels.json(descriptionBlocks)에서 온다. 비어 있으면 그 검사는 건너뛴다.
const DESCRIPTION_BLOCKS = getDescriptionBlocks();
const COMFY_REFERRAL_URL = DESCRIPTION_BLOCKS.comfyReferral.url;
const DENO_DISCORD_URL = DESCRIPTION_BLOCKS.discord.url;
const HELPER_INITIAL_PRIVACY_STATUS = "unlisted";
const INVALID_MARKERS = ["SUPERSEDED", "STALE_CAPTION_REVISION", "EXECUTED"];
const stableFileHashCache = new Map();

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex").toLowerCase();
}

function stableFileVersion(fileStat) {
  return [
    fileStat.size,
    fileStat.mtimeMs,
    fileStat.ctimeMs,
    fileStat.ino ?? "",
  ].join(":");
}

async function sha256StableFile(filePath, initialStat) {
  const initialVersion = stableFileVersion(initialStat);
  const cached = stableFileHashCache.get(filePath);
  if (cached?.version === initialVersion) return cached.sha256;

  const digest = await sha256File(filePath);
  const finalStat = await stat(filePath);
  const finalVersion = stableFileVersion(finalStat);
  if (finalVersion !== initialVersion) {
    stableFileHashCache.delete(filePath);
    throw new Error("Packaged file changed while its SHA-256 was being verified");
  }
  stableFileHashCache.set(filePath, { version: finalVersion, sha256: digest });
  return digest;
}

function parseReadyMarker(raw) {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "ready_for_codex_upload") {
    throw new Error("READY marker is not a current Helper ready_for_codex_upload marker");
  }
  const values = {};
  for (const line of lines.slice(1)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

function normalizeHash(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function parseSrtStructure(raw) {
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
        number: lines[timingIndex - 1].trim(),
        timing: lines[timingIndex].trim().replace(/\./g, ","),
      };
    })
    .filter(Boolean);
}

function sameSrtStructure(finalRaw, cleanRaw) {
  const finalStructure = parseSrtStructure(finalRaw);
  const cleanStructure = parseSrtStructure(cleanRaw);
  return (
    finalStructure.length > 0 &&
    finalStructure.length === cleanStructure.length &&
    finalStructure.every(
      (cue, index) =>
        cue.number === cleanStructure[index].number && cue.timing === cleanStructure[index].timing,
    )
  );
}

function srtClockToSeconds(value) {
  const match = String(value ?? "").match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return null;
  return (
    Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / 1000
  );
}

function finalSubtitleEndSeconds(raw) {
  const cues = parseSrtStructure(raw);
  const finalTiming = cues.at(-1)?.timing ?? "";
  const endClock = finalTiming.split(" --> ")[1]?.split(/\s+/)[0] ?? "";
  return srtClockToSeconds(endClock);
}

function descriptionChapters(description) {
  return String(description ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line, index) => {
      const match = line.match(/^\s*(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)\s+(.+?)\s*$/);
      if (!match) return null;
      const hours = match[1] ? Number(match[1]) : 0;
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);
      return {
        line: index + 1,
        timestamp: match[1]
          ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
          : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
        seconds: hours * 3600 + minutes * 60 + seconds,
        label: match[4].trim(),
      };
    })
    .filter(Boolean);
}

function metadataConsistencyWarnings(description, cleanKoreanRaw) {
  const chapters = descriptionChapters(description);
  const subtitleEndSeconds = finalSubtitleEndSeconds(cleanKoreanRaw);
  const warnings = [];
  if (subtitleEndSeconds !== null) {
    for (const chapter of chapters) {
      if (chapter.seconds > subtitleEndSeconds + 2) {
        warnings.push({
          code: "CHAPTER_AFTER_FINAL_SUBTITLE",
          message: `설명 ${chapter.line}행의 ${chapter.timestamp} ${chapter.label} 챕터가 최종 한국어 자막 종료 ${subtitleEndSeconds.toFixed(3)}초보다 뒤에 있습니다.`,
          chapter,
          subtitleEndSeconds,
        });
      }
    }
  }
  for (let index = 1; index < chapters.length; index += 1) {
    if (chapters[index].seconds < chapters[index - 1].seconds) {
      warnings.push({
        code: "CHAPTER_ORDER_REVERSED",
        message: `설명 챕터 시간이 ${chapters[index - 1].timestamp} 다음에 ${chapters[index].timestamp}로 역행합니다.`,
        previous: chapters[index - 1],
        current: chapters[index],
      });
    }
  }
  const normalizedCaption = String(cleanKoreanRaw ?? "").toLowerCase();
  for (const chapter of chapters) {
    if (
      /계정\s*삭제|delete\s+(?:the\s+)?account|account\s+deletion/i.test(chapter.label) &&
      !/계정\s*삭제|delete\s+(?:the\s+)?account|account\s+deletion/i.test(normalizedCaption)
    ) {
      warnings.push({
        code: "DESTRUCTIVE_CHAPTER_NOT_IN_FINAL_CAPTION",
        message: `설명 챕터 '${chapter.timestamp} ${chapter.label}'의 계정 삭제 내용이 최종 한국어 자막에는 없습니다. 최종 영상에서 삭제된 구간인지 확인해야 합니다.`,
        chapter,
      });
    }
  }
  const captionPlainText = String(cleanKoreanRaw ?? "")
    .replace(/^\uFEFF/u, "")
    .replace(/^\d+\s*$/gmu, " ")
    .replace(/^\d{2}:\d{2}:\d{2},\d{3}\s+-->.*$/gmu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const audiencePromisePatterns = [
    /(?:스킬|파일|자료|워크플로우|링크).{0,80}(?:공유(?:해)?\s*드|올려\s*드|남겨\s*드|배포하|첨부하)/gu,
    /(?:공유(?:해)?\s*드|올려\s*드|남겨\s*드|배포하|첨부하).{0,140}(?:고정\s*댓글|영상\s*하단|설명란)/gu,
    /(?:고정\s*댓글|영상\s*하단|설명란).{0,140}(?:스킬|파일|자료|워크플로우|링크|다운로드)/gu,
  ];
  const commitments = [
    ...new Set(
      audiencePromisePatterns.flatMap((pattern) =>
        [...captionPlainText.matchAll(pattern)].map((match) => match[0].trim()),
      ),
    ),
  ];
  if (commitments.length > 0) {
    warnings.push({
      code: "AUDIENCE_PROMISE_FULFILLMENT_REQUIRED",
      message:
        "최종 자막에 링크·파일·스킬·자료를 고정 댓글/설명란으로 제공한다는 약속이 있습니다. 공개 전에 실제 산출물 URL과 댓글 게시·고정 상태를 직접 확인해야 합니다.",
      commitments,
    });
  }
  return warnings;
}

function metadataWarningsSha256(warnings) {
  return createHash("sha256").update(JSON.stringify(warnings)).digest("hex");
}

// 설명 고정 링크 검사는 READY에 기록된 채널 정책을 따른다(이전 READY는 기본 채널 DENO).
function validateDescriptionLinkPolicy(metadata, isShorts = false, channel = resolveUploadChannel()) {
  if (isShorts) return;
  const description = String(metadata?.description ?? "");
  const noAffiliateLinks = metadata?.noAffiliateLinks === true;
  const { affiliateAllowed, discordRequired } = descriptionLinkRequirements(channel, { noAffiliateLinks });
  if (COMFY_REFERRAL_URL && !affiliateAllowed && description.includes(COMFY_REFERRAL_URL)) {
    throw new Error(
      channel.descriptionLinks.comfyReferral
        ? "Helper campaign forbids affiliate links, but the ComfyUI referral link is present"
        : `${channel.title} descriptions must not contain the ComfyUI Deno referral link`,
    );
  }
  if (COMFY_REFERRAL_URL && affiliateAllowed && !description.includes(COMFY_REFERRAL_URL)) {
    throw new Error("Helper description is missing the required ComfyUI Deno referral link");
  }
  if (DENO_DISCORD_URL && discordRequired && !description.includes(DENO_DISCORD_URL)) {
    throw new Error("Helper description is missing the required Deno Discord link");
  }
}

async function resolvePackagedFile(requestDir, storedPath, label) {
  if (typeof storedPath !== "string" || !storedPath.trim()) {
    throw new Error(`${label} path is missing from the Helper manifest`);
  }
  const requestRoot = await realpath(requestDir);
  const candidate = path.isAbsolute(storedPath)
    ? path.resolve(storedPath)
    : path.resolve(requestDir, storedPath);
  const resolved = await realpath(candidate);
  const relative = path.relative(requestRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} path escapes or aliases the Helper request directory`);
  }
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`${label} is not a regular file`);
  return { path: resolved, stat: info };
}

function requestIdFromConfig(config) {
  const configuredId = typeof config.requestId === "string" ? config.requestId.trim() : "";
  const requestDirValue = typeof config.requestDir === "string" ? config.requestDir.trim() : "";
  const derivedId = requestDirValue ? path.basename(path.resolve(requestDirValue)) : "";
  const requestId = configuredId || derivedId;
  if (!SAFE_REQUEST_ID.test(requestId)) throw new Error("A valid Helper requestId is required");

  const requestDir = path.resolve(REQUESTS_ROOT, requestId);
  if (path.dirname(requestDir) !== path.resolve(REQUESTS_ROOT)) {
    throw new Error("Helper request path is outside the upload-requests root");
  }
  if (requestDirValue && path.resolve(requestDirValue) !== requestDir) {
    throw new Error("config.requestDir does not match the fixed Helper request root and requestId");
  }
  return { requestId, requestDir };
}

async function latestReadyForSlug(slug) {
  const entries = await readdir(REQUESTS_ROOT, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_REQUEST_ID.test(entry.name)) continue;
    const requestDir = path.join(REQUESTS_ROOT, entry.name);
    if (!(await exists(path.join(requestDir, "READY")))) continue;
    if (await Promise.any(INVALID_MARKERS.map((marker) => access(path.join(requestDir, marker))))
      .then(() => true)
      .catch(() => false)) {
      continue;
    }
    try {
      const manifest = await readJson(path.join(requestDir, "upload_request.json"));
      const manifestSlug =
        manifest.captionAuthority?.slug ?? manifest.agentProject?.slug ?? "";
      if (
        manifest.source !== "youtube-upload-helper" ||
        manifestSlug !== slug
      ) {
        continue;
      }
      const createdAt = Date.parse(manifest.createdAt ?? "") || 0;
      candidates.push({ requestId: entry.name, createdAt });
    } catch {
      // Invalid or legacy READY folders are never candidates for a current Helper job.
    }
  }
  return candidates.sort(
    (left, right) => right.createdAt - left.createdAt || right.requestId.localeCompare(left.requestId),
  )[0]?.requestId;
}

function assertOptionalConfigMatches(config, validated) {
  if (config.files?.video && path.resolve(config.files.video) !== validated.videoPath) {
    throw new Error("config.files.video differs from the video locked in the Helper request");
  }
  if (config.files?.caption && path.resolve(config.files.caption) !== validated.captionPath) {
    throw new Error("config.files.caption differs from the clean KO locked in the Helper request");
  }
  if (!config.metadata) return;

  const fields = [
    "title",
    "description",
    "categoryId",
    "playlistId",
    "defaultLanguage",
    "defaultAudioLanguage",
  ];
  for (const field of fields) {
    if (config.metadata[field] !== undefined && config.metadata[field] !== validated.metadata[field]) {
      throw new Error(`config.metadata.${field} differs from the Helper request`);
    }
  }
  if (
    config.metadata.tags !== undefined &&
    JSON.stringify(config.metadata.tags) !== JSON.stringify(validated.metadata.tags)
  ) {
    throw new Error("config.metadata.tags differs from the Helper request");
  }
  if (config.metadata.playlistName && !config.metadata.playlistId) {
    throw new Error("playlistName lookup is obsolete; use the playlistId locked by the Helper request");
  }
}

async function loadAndValidateLatestReadyRequest(config) {
  const { requestId, requestDir } = requestIdFromConfig(config);
  const actualRequestDir = await realpath(requestDir).catch(() => "");
  if (!actualRequestDir || actualRequestDir !== requestDir) {
    throw new Error("Helper request directory is missing or resolves outside its canonical path");
  }

  for (const marker of INVALID_MARKERS) {
    if (await exists(path.join(requestDir, marker))) {
      throw new Error(`Helper request is not executable because ${marker} exists`);
    }
  }

  const readyPath = path.join(requestDir, "READY");
  const manifestPath = path.join(requestDir, "upload_request.json");
  if (!(await exists(readyPath))) throw new Error("Current Helper READY marker is missing");

  const [readyRaw, manifest] = await Promise.all([
    readFile(readyPath, "utf8"),
    readJson(manifestPath),
  ]);
  const ready = parseReadyMarker(readyRaw);
  const authority = manifest.captionAuthority;
  const captionPolicy = manifest.captionPolicy;
  const isShorts = manifest.contentKind === "shorts";
  const shortsWithoutManualCaptions =
    isShorts &&
    captionPolicy?.mode === "optional_shorts" &&
    Array.isArray(manifest.files?.subtitles) &&
    manifest.files.subtitles.length === 0;
  const noManualCaptions = captionPolicy?.mode === "none" || shortsWithoutManualCaptions;
  const isNoCaptionCinematic = manifest.contentKind === "cinematic" && noManualCaptions;
  const sourceFingerprint = manifest.sourceOfTruth?.sourceFingerprint ?? "";
  const uploadAuthorization = manifest.uploadAuthorization;

  if (manifest.schemaVersion !== 2) throw new Error("Unsupported Helper manifest schemaVersion");
  if (manifest.source !== "youtube-upload-helper") throw new Error("Legacy or manual request source is not executable");
  if (manifest.requestId !== requestId) throw new Error("Manifest requestId does not match its request directory");
  if (ready.requestId !== requestId) throw new Error("READY requestId does not match the manifest");
  if (ready.createdAt !== manifest.createdAt) throw new Error("READY createdAt does not match the manifest");
  if (!sourceFingerprint || ready.sourceFingerprint !== sourceFingerprint) {
    throw new Error("READY sourceFingerprint does not match the Helper request snapshot");
  }
  const expectedInitialPrivacyStatus = isShorts ? "private" : HELPER_INITIAL_PRIVACY_STATUS;
  const authorizesSegmentedPostUploadExpansion = !isShorts && !noManualCaptions;
  const authorizesNoCaptionExpansion = isNoCaptionCinematic &&
    uploadAuthorization?.postUploadExpansionAuthorized === true;
  const expectedAuthorizationScope = authorizesSegmentedPostUploadExpansion
    ? [
        "initial_video_upload",
        "ko_caption_upload",
        "reviewed_en_caption_upload",
        "metadata_localization_write",
      ]
    : noManualCaptions
      ? authorizesNoCaptionExpansion
        ? ["initial_video_upload", "metadata_localization_write"]
        : ["initial_video_upload"]
      : ["initial_video_upload", "ko_caption_upload"];
  if (
    uploadAuthorization?.status !== "approved" ||
    uploadAuthorization?.authority !== "user_pressed_upload_helper_complete_button" ||
    uploadAuthorization?.trigger !== "complete_button" ||
    uploadAuthorization?.approvedAt !== manifest.createdAt ||
    uploadAuthorization?.requestId !== requestId ||
    uploadAuthorization?.sourceFingerprint !== sourceFingerprint ||
    uploadAuthorization?.initialPrivacyStatus !== expectedInitialPrivacyStatus ||
    JSON.stringify(uploadAuthorization?.scope) !== JSON.stringify(expectedAuthorizationScope) ||
    uploadAuthorization?.publicVisibilityAuthorized !== false ||
    uploadAuthorization?.postUploadExpansionAuthorized !==
      (authorizesSegmentedPostUploadExpansion || authorizesNoCaptionExpansion) ||
    uploadAuthorization?.executionStrategy !==
      (authorizesSegmentedPostUploadExpansion
        ? "segmented_korean_first_then_english_localizations"
        : authorizesNoCaptionExpansion
          ? "video_then_metadata_localizations"
          : "initial_upload_only") ||
    ready.authorization !== "complete_button"
  ) {
    throw new Error(
      "Helper READY is missing the exact user completion-button authorization for the segmented upload workflow",
    );
  }
  const slug = String(manifest.agentProject?.slug ?? "").trim();
  if (isShorts) {
    if (manifest.agentProject !== null || ready.slug || ready.revisionId || ready.captionMode) {
      throw new Error("Shorts READY must not claim a longform project, caption revision, or caption mode");
    }
  } else if (!slug || path.basename(slug) !== slug || ready.slug !== slug) {
    throw new Error("Agent project slug and READY slug do not match");
  }

  if (shortsWithoutManualCaptions) {
    if (
      captionPolicy.authority !== "shorts_request_policy" ||
      authority !== null ||
      !String(manifest.shortsBrief ?? "").trim()
    ) {
      throw new Error("Helper request does not contain a valid Shorts caption policy and brief");
    }
    const preparation = manifest.shortsPreparation;
    if (
      preparation?.status !== "completed" ||
      preparation?.authority !== "codex_frame_audio_memo_metadata" ||
      preparation?.requestId !== requestId ||
      preparation?.sourceFingerprint !== sourceFingerprint ||
      normalizeHash(preparation?.videoSha256) !== normalizeHash(manifest.files?.video?.sha256) ||
      normalizeHash(preparation?.shortsBriefSha256) !==
        createHash("sha256").update(String(manifest.shortsBrief)).digest("hex") ||
      normalizeHash(preparation?.metadataSha256) !==
        createHash("sha256")
          .update(
            JSON.stringify({
              title: manifest.metadata?.title,
              description: manifest.metadata?.description,
              tags: manifest.metadata?.tags,
            }),
          )
          .digest("hex")
    ) {
      throw new Error("Shorts metadata completion evidence is missing or does not match the locked request");
    }
  } else if (noManualCaptions) {
    if (
      captionPolicy.authority !== "user_declared_no_manual_captions_at_request_click" ||
      authority !== null ||
      ready.captionMode !== "none" ||
      ready.revisionId
    ) {
      throw new Error("Helper request does not contain a valid user-approved no-caption policy");
    }
    if (!Array.isArray(manifest.files?.subtitles) || manifest.files.subtitles.length !== 0) {
      throw new Error("No-caption Helper request unexpectedly contains subtitle files");
    }
  } else {
    if (
      authority?.schemaVersion !== 3 ||
      authority.authority !== "user_approved_final_korean_srt_at_request_click"
    ) {
      throw new Error("Helper request does not contain a current user-approved final KO authority");
    }
    if (authority.slug !== slug) {
      throw new Error("Agent project slug and caption authority slug do not match");
    }
    if (
      !SAFE_REVISION_ID.test(authority.revisionId ?? "") ||
      ready.revisionId !== authority.revisionId
    ) {
      throw new Error("READY revisionId does not match a valid Helper caption revision");
    }
  }

  if (!isShorts) {
    const latestRequestId = await latestReadyForSlug(slug);
    if (latestRequestId !== requestId) {
      throw new Error(`Selected Helper request is not the latest READY for slug ${slug}`);
    }
  }

  const video = await resolvePackagedFile(requestDir, manifest.files?.video?.path, "video");
  let cleanKorean = null;
  let cleanRaw = "";
  if (!noManualCaptions) {
    const [finalKorean, resolvedCleanKorean] = await Promise.all([
      resolvePackagedFile(requestDir, authority.finalKorean?.requestPath, "final Korean SRT"),
      resolvePackagedFile(requestDir, authority.cleanKorean?.requestPath, "clean Korean SRT"),
    ]);
    cleanKorean = resolvedCleanKorean;
    const submittedKorean = (manifest.files?.subtitles ?? []).find(
      (item) => String(item.language ?? "").toLowerCase() === "ko",
    );
    const submitted = await resolvePackagedFile(
      requestDir,
      submittedKorean?.path,
      "submitted Korean SRT",
    );
    if (submitted.path !== cleanKorean.path) {
      throw new Error("Manifest KO subtitle path is not the locked clean Korean SRT");
    }

    const [finalRaw, resolvedCleanRaw, finalSha256, cleanSha256] = await Promise.all([
      readFile(finalKorean.path, "utf8"),
      readFile(cleanKorean.path, "utf8"),
      sha256File(finalKorean.path),
      sha256File(cleanKorean.path),
    ]);
    cleanRaw = resolvedCleanRaw;
    if (finalSha256 !== normalizeHash(authority.finalKorean?.sha256)) {
      throw new Error("Final Korean SRT SHA-256 differs from the Helper authority");
    }
    if (
      cleanSha256 !== normalizeHash(authority.cleanKorean?.lockedSha256) ||
      cleanSha256 !== normalizeHash(authority.cleanKorean?.submittedSha256) ||
      authority.cleanKorean?.exactMatch !== true
    ) {
      throw new Error("Clean Korean SRT does not exactly match both locked Helper hashes");
    }
    if (authority.revisionId !== `caption-${cleanSha256.slice(0, 24)}`) {
      throw new Error("Caption revisionId is not derived from the exact clean Korean SRT");
    }
    if (/<\/?(?:b|i|u|font)(?:\s+[^>]*)?>/i.test(cleanRaw)) {
      throw new Error("Clean Korean SRT still contains style tags");
    }
    if (!sameSrtStructure(finalRaw, cleanRaw)) {
      throw new Error("Final and clean Korean SRT cue number/timeline/settings structure differs");
    }
  }

  if (video.stat.size !== manifest.files.video.size) {
    throw new Error("Packaged video size differs from the Helper manifest");
  }
  if (manifest.files.video.sha256) {
    // A large staged video is validated in full once per process. Later
    // lifecycle checks reuse that digest only while size, mtime, ctime and file
    // identity remain unchanged, avoiding several redundant multi-GB reads.
    const actualVideoSha256 = await sha256StableFile(video.path, video.stat);
    if (actualVideoSha256 !== normalizeHash(manifest.files.video.sha256)) {
      throw new Error("Packaged video SHA-256 differs from the Helper manifest");
    }
  }

  const metadata = manifest.metadata;
  if (!metadata || metadata.defaultLanguage !== "ko" ||
      (isNoCaptionCinematic
        ? !/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(metadata.defaultAudioLanguage ?? "")
        : metadata.defaultAudioLanguage !== "ko")) {
    throw new Error(isNoCaptionCinematic
      ? "No-caption cinematic request must lock defaultLanguage=ko and a valid actual defaultAudioLanguage"
      : "Helper request must explicitly lock defaultLanguage=ko and defaultAudioLanguage=ko");
  }
  if (isShorts && metadata.fillBeforeUpload !== false) {
    throw new Error("Shorts metadata must be completed and locked before upload");
  }
  if (!String(metadata.title ?? "").trim() || String(metadata.title).length > 100) {
    throw new Error("Helper title is missing or exceeds 100 characters");
  }
  if (!String(metadata.description ?? "").trim() || String(metadata.description).length > 5000) {
    throw new Error("Helper description is missing or exceeds 5000 characters");
  }
  const youtubeChannel = channelFromManifest(manifest);
  validateDescriptionLinkPolicy(metadata, isShorts, youtubeChannel);
  if (!Array.isArray(metadata.tags) || metadata.tags.join(",").length > 500) {
    throw new Error("Helper tags are invalid or exceed 500 characters");
  }

  const metadataWarnings = metadataConsistencyWarnings(metadata.description, cleanRaw);
  const metadataWarningsDigest = metadataWarningsSha256(metadataWarnings);
  const blockingMetadataWarnings = metadataWarnings.filter(
    (warning) => warning.code !== "AUDIENCE_PROMISE_FULFILLMENT_REQUIRED",
  );
  if (blockingMetadataWarnings.length > 0) {
    const approvalPath = path.join(requestDir, "METADATA_CONSISTENCY_APPROVED.json");
    const approval = await readJson(approvalPath).catch(() => null);
    if (
      approval?.requestId !== requestId ||
      approval?.sourceFingerprint !== sourceFingerprint ||
      approval?.warningsSha256 !== metadataWarningsDigest ||
      approval?.userExplicitApproval !== true
    ) {
      throw new Error(
        `Metadata consistency reminder required before upload: ${blockingMetadataWarnings
          .map((warning) => warning.message)
          .join(" | ")} Ask the user whether this final-video/description mismatch is intentional. Do not proceed until the metadata is corrected in a new Helper request or the user's explicit approval is bound to this request and warning digest. warningsSha256=${metadataWarningsDigest}`,
      );
    }
  }

  const thumbnailAuthorization = manifest.workflowPolicy?.thumbnailUploadAuthorization;
  const thumbnailUploadAuthorized = thumbnailAuthorization?.authorized === true;
  let thumbnail = null;
  if (thumbnailUploadAuthorized) {
    thumbnail = await resolvePackagedFile(
      requestDir,
      manifest.files?.thumbnail?.path,
      "authorized thumbnail",
    );
    if (thumbnail.stat.size !== manifest.files.thumbnail.size) {
      throw new Error("Packaged thumbnail size differs from the Helper manifest");
    }
    const expectedThumbnailSha256 = normalizeHash(
      thumbnailAuthorization.sha256 ?? manifest.files.thumbnail.sha256,
    );
    if (!expectedThumbnailSha256) {
      throw new Error("Authorized thumbnail SHA-256 is missing from the Helper request");
    }
    const actualThumbnailSha256 = await sha256File(thumbnail.path);
    if (actualThumbnailSha256 !== expectedThumbnailSha256) {
      throw new Error("Packaged thumbnail SHA-256 differs from the Helper authorization");
    }
  }

  const validated = {
    requestId,
    requestDir,
    manifestPath,
    readyPath,
    executedPath: path.join(requestDir, "EXECUTED"),
    verificationDir: path.join(requestDir, "verification"),
    manifest,
    youtubeChannel,
    metadata: {
      ...metadata,
      privacyStatus: isShorts ? "private" : HELPER_INITIAL_PRIVACY_STATUS,
    },
    videoPath: video.path,
    isShorts,
    captionMode: noManualCaptions ? "none" : "manual",
    noManualCaptions,
    captionPath: cleanKorean?.path ?? null,
    videoStat: video.stat,
    captionStat: cleanKorean?.stat ?? null,
    captionRaw: cleanRaw,
    cueCount: parseSrtStructure(cleanRaw).length,
    metadataConsistencyWarnings: metadataWarnings,
    blockingMetadataConsistencyWarnings: blockingMetadataWarnings,
    metadataWarningsSha256: metadataWarningsDigest,
    thumbnailPath: thumbnail?.path ?? null,
    thumbnailStat: thumbnail?.stat ?? null,
    thumbnailUploadAuthorized,
    thumbnailAuthorization: thumbnailAuthorization ?? null,
    revisionId: noManualCaptions ? null : authority.revisionId,
    slug,
  };
  assertOptionalConfigMatches(config, validated);
  return validated;
}

module.exports = {
  APP_ROOT,
  RUNTIME_PATHS,
  HELPER_INITIAL_PRIVACY_STATUS,
  REQUESTS_ROOT,
  loadAndValidateLatestReadyRequest,
  parseReadyMarker,
  metadataConsistencyWarnings,
  metadataWarningsSha256,
  validateDescriptionLinkPolicy,
  sameSrtStructure,
  sha256File,
};
