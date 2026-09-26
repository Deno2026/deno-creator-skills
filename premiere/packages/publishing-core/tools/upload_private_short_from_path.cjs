#!/usr/bin/env node

const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { createReadStream } = require("node:fs");
const {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} = require("node:fs/promises");
const path = require("node:path");
const { Transform } = require("node:stream");
const { promisify } = require("node:util");

const { getDescriptionBlocks, getUploadRuntimePaths, resolveUploadChannel } = require("@deno/runtime-paths");

const execFileAsync = promisify(execFile);
const RUNTIME_PATHS = getUploadRuntimePaths();
const INSPECTION_ROOT = RUNTIME_PATHS.directShortInspectionsRoot;
const RUNS_ROOT = RUNTIME_PATHS.directShortUploadsRoot;
const MAX_SHORT_SECONDS = 180;
// 설명 고정 링크·문구는 channels.json(descriptionBlocks)에서 온다. URL이 비어 있으면 붙이지 않는다.
const DESCRIPTION_BLOCKS = getDescriptionBlocks();
const COMFY_REFERRAL_URL = DESCRIPTION_BLOCKS.comfyReferral.url;
const DENO_DISCORD_URL = DESCRIPTION_BLOCKS.discord.url;
const COMFY_REFERRAL_BLOCK_KO = DESCRIPTION_BLOCKS.comfyReferral.ko || COMFY_REFERRAL_URL;
const DENO_DISCORD_BLOCK_KO = DESCRIPTION_BLOCKS.discord.ko || DENO_DISCORD_URL;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bareUrl = (url) => url.replace(/^https?:\/\/(?:www\.)?/iu, "").replace(/\/+$/u, "");
const urlPattern = (url, flags) => (bareUrl(url) ? new RegExp(`https?:\\/\\/(?:www\\.)?${escapeRegExp(bareUrl(url))}\\/?`, flags) : null);
const SAFE_RUN_ID = /^private-short-[a-f0-9]{64}$/;
const METADATA_MUTABLE_STATES = new Set(["prepared", "preflight_ready", "upload_rejected"]);
const VIDEO_MIME_TYPES = new Map([
  [".avi", "video/x-msvideo"],
  [".m4v", "video/mp4"],
  [".mkv", "video/x-matroska"],
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
]);

function parseArgs(argv) {
  const args = {
    inspect: false,
    preflight: false,
    verifyOnly: false,
    video: "",
    metadataFile: "",
    runId: "",
    expectedChannelId: "",
    privacy: "private",
    publishAt: null,
    descriptionBlocks: "default",
    channel: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--inspect") args.inspect = true;
    else if (arg === "--preflight") args.preflight = true;
    else if (arg === "--verify-only") args.verifyOnly = true;
    else if (arg === "--video") {
      args.video = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--metadata-file") {
      args.metadataFile = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--run-id") {
      args.runId = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--expected-channel-id") {
      args.expectedChannelId = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--channel") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("--channel requires a value");
      args.channel = resolveUploadChannel(argv[++index]).id;
    } else if (["--privacy", "--publish-at", "--description-blocks"].includes(arg)) {
      const key = { "--privacy": "privacy", "--publish-at": "publishAt", "--description-blocks": "descriptionBlocks" }[arg];
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`${arg} requires a value`);
      args[key] = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const modes = [args.inspect, args.preflight, args.verifyOnly].filter(Boolean).length;
  // 강의 채널 블록을 쓰지 않는 채널(DENO PICTURES)은 업로드 설명에 ComfyUI·Discord를 붙이지 않는다.
  if (
    args.channel &&
    !args.inspect &&
    !args.verifyOnly &&
    args.descriptionBlocks === "default" &&
    !resolveUploadChannel(args.channel).descriptionLinks.discord
  ) {
    args.descriptionBlocks = "none";
  }
  normalizePublishingOptions(args);
  if ((args.inspect || args.verifyOnly) && (args.privacy !== "private" || args.publishAt || args.descriptionBlocks !== "default")) {
    throw new Error("Inspection and verification do not accept publishing overrides; verification uses saved run values");
  }
  if (modes > 1) throw new Error("Use only one of --inspect, --preflight, or --verify-only");
  if (args.inspect) {
    if (!args.video || args.metadataFile || args.runId) {
      throw new Error("--inspect requires only --video <path>");
    }
  } else if (args.verifyOnly) {
    if (!SAFE_RUN_ID.test(args.runId) || args.video || args.metadataFile) {
      throw new Error("--verify-only requires only --run-id <private-short-id>");
    }
  } else if (!args.video || !args.metadataFile || args.runId) {
    throw new Error("Upload and --preflight require --video <path> and --metadata-file <json>");
  }
  return args;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const text = (await readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
  try { return JSON.parse(text); }
  catch { throw new Error(`Invalid JSON file: ${filePath}`); }
}

async function readJsonIfExists(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256StableFile(filePath) {
  const before = await stat(filePath);
  if (!before.isFile()) throw new Error(`Source is not a regular file: ${filePath}`);
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error("Source video changed while its SHA-256 was being calculated");
  }
  return {
    sha256: hash.digest("hex"),
    stat: after,
    version: `${after.size}:${after.mtimeMs}:${after.ctimeMs}:${after.ino ?? ""}`,
  };
}

async function resolveVideoPath(inputPath) {
  const absolute = path.resolve(String(inputPath ?? ""));
  const resolved = await realpath(absolute).catch(() => "");
  if (!resolved) throw new Error(`Video path is missing: ${absolute}`);
  return resolved;
}

function videoMimeType(videoPath) {
  const extension = path.extname(videoPath).toLowerCase();
  const mimeType = VIDEO_MIME_TYPES.get(extension);
  if (!mimeType) {
    throw new Error(`Unsupported direct Shorts container: ${extension || "no extension"}`);
  }
  return mimeType;
}

async function probeVideo(videoPath) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", videoPath],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    ));
  } catch (error) {
    throw new Error(`ffprobe failed for the source video: ${error.message}`);
  }
  const raw = JSON.parse(stdout);
  const videoStreams = (raw.streams ?? []).filter((stream) => stream.codec_type === "video");
  const videoStream = videoStreams[0];
  const audioStreams = (raw.streams ?? []).filter((stream) => stream.codec_type === "audio");
  if (!videoStream) throw new Error("Source does not contain a video stream");
  const durationSeconds = Number(videoStream.duration ?? raw.format?.duration);
  const sideDataRotation = (videoStream.side_data_list ?? [])
    .map((item) => Number(item.rotation))
    .find(Number.isFinite);
  const tagRotation = Number(videoStream.tags?.rotate);
  const rotationDegrees = normalizeRotationDegrees(
    Number.isFinite(sideDataRotation) ? sideDataRotation : tagRotation,
  );
  const codedWidth = Number(videoStream.width);
  const codedHeight = Number(videoStream.height);
  const swapsDimensions = rotationDegrees === 90 || rotationDegrees === 270;
  const probe = {
    durationSeconds,
    width: swapsDimensions ? codedHeight : codedWidth,
    height: swapsDimensions ? codedWidth : codedHeight,
    codedWidth,
    codedHeight,
    rotationDegrees,
    frameRate: String(videoStream.avg_frame_rate ?? videoStream.r_frame_rate ?? ""),
    videoCodec: String(videoStream.codec_name ?? ""),
    videoStreamCount: videoStreams.length,
    selectedVideoStreamIndex: Number(videoStream.index),
    audioStreamCount: audioStreams.length,
    audioCodecs: audioStreams.map((stream) => String(stream.codec_name ?? "")),
    formatName: String(raw.format?.format_name ?? ""),
  };
  validateShortsProbe(probe);
  return probe;
}

function normalizeRotationDegrees(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const normalized = ((numeric % 360) + 360) % 360;
  const candidate = [0, 90, 180, 270, 360].find(
    (degrees) => Math.abs(normalized - degrees) <= 0.5,
  );
  return candidate === 360 ? 0 : (candidate ?? 0);
}

function validateShortsProbe(probe) {
  if (Number(probe.videoStreamCount ?? 1) !== 1) {
    throw new Error("Path-only Shorts upload requires exactly one unambiguous video stream");
  }
  if (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0) {
    throw new Error("Shorts duration could not be determined");
  }
  if (probe.durationSeconds > MAX_SHORT_SECONDS) {
    throw new Error(`Source exceeds the ${MAX_SHORT_SECONDS}-second Shorts limit`);
  }
  if (!Number.isInteger(probe.width) || !Number.isInteger(probe.height) || probe.width <= 0 || probe.height <= 0) {
    throw new Error("Shorts dimensions could not be determined");
  }
  if (probe.width > probe.height) {
    throw new Error("Path-only Shorts upload requires a square or vertical source");
  }
  return true;
}

function probesMatch(left, right) {
  return (
    Math.abs(Number(left?.durationSeconds) - Number(right?.durationSeconds)) <= 0.001 &&
    Number(left?.width) === Number(right?.width) &&
    Number(left?.height) === Number(right?.height) &&
    Number(left?.codedWidth ?? left?.width) === Number(right?.codedWidth ?? right?.width) &&
    Number(left?.codedHeight ?? left?.height) === Number(right?.codedHeight ?? right?.height) &&
    Number(left?.rotationDegrees ?? 0) === Number(right?.rotationDegrees ?? 0) &&
    String(left?.frameRate ?? "") === String(right?.frameRate ?? "") &&
    String(left?.videoCodec ?? "") === String(right?.videoCodec ?? "") &&
    Number(left?.videoStreamCount ?? 1) === Number(right?.videoStreamCount ?? 1) &&
    Number(left?.selectedVideoStreamIndex ?? 0) === Number(right?.selectedVideoStreamIndex ?? 0) &&
    Number(left?.audioStreamCount) === Number(right?.audioStreamCount) &&
    JSON.stringify(left?.audioCodecs ?? []) === JSON.stringify(right?.audioCodecs ?? []) &&
    String(left?.formatName ?? "") === String(right?.formatName ?? "")
  );
}

async function runFfmpeg(args, maxBuffer = 16 * 1024 * 1024) {
  try {
    return await execFileAsync("ffmpeg", args, { windowsHide: true, maxBuffer });
  } catch (error) {
    throw new Error(`ffmpeg analysis failed: ${error.message}`);
  }
}

async function inspectVideo(videoInput) {
  const videoPath = await resolveVideoPath(videoInput);
  const mimeType = videoMimeType(videoPath);
  const [{ sha256, stat: videoStat, version }, probe] = await Promise.all([
    sha256StableFile(videoPath),
    probeVideo(videoPath),
  ]);
  const inspectionDir = path.join(INSPECTION_ROOT, sha256.slice(0, 16), "inspection");
  const contactSheetPath = path.join(inspectionDir, "contact-sheet-3x3.jpg");
  const inspectionPath = path.join(inspectionDir, "source_inspection.json");
  const existingInspection = await readJsonIfExists(inspectionPath);
  if (
    existingInspection?.authority === "codex_path_only_shorts_source_inspection" &&
    existingInspection.source?.path === videoPath &&
    existingInspection.source?.size === videoStat.size &&
    existingInspection.source?.sha256 === sha256 &&
    existingInspection.source?.version === version &&
    existingInspection.source?.mimeType === mimeType &&
    probesMatch(existingInspection.probe, probe)
  ) {
    const reused = await loadInspection(sha256).catch(() => null);
    if (reused) {
      process.stdout.write(
        `SHORTS_INSPECTION_READY ${JSON.stringify({
          videoSha256: sha256,
          inspectionPath,
          inspectionSha256: reused.inspectionSha256,
          contactSheetPath: existingInspection.sampling.contactSheetPath,
          probe,
          reused: true,
        })}\n`,
      );
      return reused;
    }
  }
  await mkdir(inspectionDir, { recursive: true });
  const samplingRate = 9 / probe.durationSeconds;
  await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    videoPath,
    "-map",
    "0:v:0",
    "-vf",
    `fps=${samplingRate.toFixed(9)},scale=360:-2,tile=3x3`,
    "-frames:v",
    "1",
    contactSheetPath,
  ]);

  let audioLevels = null;
  let audioReview = null;
  if (probe.audioStreamCount > 0) {
    const audioReviewPath = path.join(inspectionDir, "audio-review.wav");
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      videoPath,
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      audioReviewPath,
    ]);
    audioReview = {
      path: audioReviewPath,
      sha256: (await sha256StableFile(audioReviewPath)).sha256,
    };
    const nullTarget = process.platform === "win32" ? "NUL" : "/dev/null";
    const { stderr } = await runFfmpeg([
      "-hide_banner",
      "-nostats",
      "-i",
      videoPath,
      "-map",
      "0:a:0",
      "-af",
      "volumedetect",
      "-f",
      "null",
      nullTarget,
    ]);
    const mean = String(stderr).match(/mean_volume:\s*([^\r\n]+)/)?.[1]?.trim() ?? null;
    const max = String(stderr).match(/max_volume:\s*([^\r\n]+)/)?.[1]?.trim() ?? null;
    audioLevels = { meanVolume: mean, maxVolume: max };
  }

  const afterAnalysis = await sha256StableFile(videoPath);
  if (afterAnalysis.sha256 !== sha256 || afterAnalysis.version !== version) {
    await rm(inspectionDir, { recursive: true, force: true });
    throw new Error("Source video changed while Shorts inspection artifacts were being generated");
  }
  const contactSheetSha256 = (await sha256StableFile(contactSheetPath)).sha256;
  const inspection = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    authority: "codex_path_only_shorts_source_inspection",
    source: {
      path: videoPath,
      originalName: path.basename(videoPath),
      mimeType,
      size: videoStat.size,
      sha256,
      version,
    },
    shortsEligibility: {
      eligible: true,
      rule: "square_or_vertical_and_duration_at_most_180_seconds",
      maxDurationSeconds: MAX_SHORT_SECONDS,
    },
    probe,
    sampling: {
      sampleCount: 9,
      contactSheetPath,
      contactSheetSha256,
    },
    audioLevels,
    audioReview,
  };
  await writeJsonAtomic(inspectionPath, inspection);
  const inspectionSha256 = (await sha256StableFile(inspectionPath)).sha256;
  process.stdout.write(
    `SHORTS_INSPECTION_READY ${JSON.stringify({
      videoSha256: sha256,
      inspectionPath,
      inspectionSha256,
      contactSheetPath,
      probe,
    })}\n`,
  );
  return { inspection, inspectionPath, inspectionSha256 };
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") throw new Error(`metadata.${field} must be an explicit boolean`);
  return value;
}

function youtubeTagCharacterCount(tags) {
  return tags.reduce((total, tag, index) => {
    const separators = index > 0 ? 1 : 0;
    const quotes = /\s/u.test(tag) ? 2 : 0;
    return total + separators + Array.from(tag).length + quotes;
  }, 0);
}

function ensureComfyReferralBlock(value) {
  const normalized = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter(
      (line) =>
        !/^[ \t]*(?:※[ \t]*이 링크로 가입하면|Disclosure:[ \t]*If you sign up)/iu.test(line),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const pattern = urlPattern(COMFY_REFERRAL_URL, "iu");
  if (!pattern || pattern.test(normalized)) {
    return normalized;
  }
  return [normalized, COMFY_REFERRAL_BLOCK_KO].filter(Boolean).join("\n\n");
}

function ensureDenoDiscordBlock(value) {
  const normalized = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/^\s*💬?\s*(?:Deno Discord 채널|Deno Discord Community|Discord 채널|Discord Community)\s*$/gimu, "")
    .replace(urlPattern(DENO_DISCORD_URL, "gimu") ? new RegExp(`^\\s*${urlPattern(DENO_DISCORD_URL, "iu").source}\\s*$`, "gimu") : /$^/u, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const discordPattern = urlPattern(DENO_DISCORD_URL, "iu");
  if (!discordPattern || discordPattern.test(normalized)) {
    return normalized;
  }
  return [normalized, DENO_DISCORD_BLOCK_KO].filter(Boolean).join("\n\n");
}

function ensurePermanentDescriptionLinks(value) {
  return ensureDenoDiscordBlock(ensureComfyReferralBlock(value));
}

function normalizePublishingOptions(options = {}) {
  const privacy = options.privacy ?? "private";
  const descriptionBlocks = options.descriptionBlocks ?? "default";
  if (!["private", "unlisted", "public", "scheduled"].includes(privacy)) throw new Error("Invalid --privacy");
  if (!["default", "none"].includes(descriptionBlocks)) throw new Error("Invalid --description-blocks");
  let publishAt = options.publishAt ?? null;
  if (privacy === "scheduled") {
    if (typeof publishAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(publishAt) || !Number.isFinite(Date.parse(publishAt))) {
      throw new Error("scheduled privacy requires --publish-at with an ISO 8601 offset");
    }
    if (new Date(`${publishAt.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== publishAt.slice(0, 10)) throw new Error("Invalid --publish-at date");
    publishAt = new Date(publishAt).toISOString();
  } else if (publishAt !== null) throw new Error("--publish-at is only allowed with scheduled privacy");
  return { privacy, publishAt, descriptionBlocks };
}

function normalizeMetadata(raw, options = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("A Shorts metadata JSON object is required");
  }
  const title = String(raw.title ?? "").trim();
  const { privacy, publishAt, descriptionBlocks } = normalizePublishingOptions(options);
  const description = descriptionBlocks === "none" ? String(raw.description ?? "") : ensurePermanentDescriptionLinks(raw.description);
  const tags = Array.isArray(raw.tags)
    ? [...new Map(raw.tags.map((tag) => [String(tag).trim().toLowerCase(), String(tag).trim()])).values()]
        .filter(Boolean)
    : [];
  const categoryId = String(raw.categoryId ?? "").trim();
  const analysis = raw.analysis;

  if (!title || Array.from(title).length > 100 || /[<>]/u.test(title)) {
    throw new Error("Shorts title must contain 1-100 characters and cannot contain < or >");
  }
  if (!description || Buffer.byteLength(description, "utf8") > 5000 || /[<>]/u.test(description)) {
    throw new Error("Shorts description must contain 1-5000 UTF-8 bytes and cannot contain < or >");
  }
  if (
    !Array.isArray(raw.tags) ||
    tags.length === 0 ||
    youtubeTagCharacterCount(tags) > 500 ||
    tags.some((tag) => /[<>]/u.test(tag))
  ) {
    throw new Error("Shorts tags must be a non-empty array within YouTube's 500-character limit");
  }
  if (!/^\d+$/.test(categoryId)) throw new Error("metadata.categoryId must be a YouTube category ID");
  if (!/#shorts\b/i.test(`${title}\n${description}`)) {
    throw new Error("Shorts metadata must include #Shorts in the title or description");
  }
  if (raw.privacyStatus !== undefined && raw.privacyStatus !== privacy) {
    throw new Error("metadata.privacyStatus must match the explicit --privacy (default private)");
  }
  if (privacy === "private" && raw.notifySubscribers === true) {
    throw new Error("Path-only private Shorts uploads cannot notify subscribers");
  }
  if (raw.playlistId || raw.thumbnail || raw.captionFile || raw.localizations) {
    throw new Error("Path-only Shorts uploads do not accept playlists, thumbnails, captions, or localizations");
  }
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
    throw new Error("metadata.analysis evidence is required");
  }
  if (!String(analysis.summary ?? "").trim() || Number(analysis.sampleCount) < 5) {
    throw new Error("metadata.analysis must include a summary and at least five reviewed samples");
  }
  if (!String(analysis.metadataRationale ?? "").trim()) {
    throw new Error("metadata.analysis.metadataRationale is required");
  }

  const apiMetadata = {
    title,
    description,
    tags,
    categoryId,
    defaultLanguage: "ko",
    defaultAudioLanguage: "ko",
    privacyStatus: privacy,
    publishAt,
    descriptionBlocks,
    madeForKids: requireBoolean(raw.madeForKids, "madeForKids"),
    containsSyntheticMedia: requireBoolean(raw.containsSyntheticMedia, "containsSyntheticMedia"),
    embeddable: raw.embeddable === undefined ? true : requireBoolean(raw.embeddable, "embeddable"),
    publicStatsViewable:
      raw.publicStatsViewable === undefined
        ? true
        : requireBoolean(raw.publicStatsViewable, "publicStatsViewable"),
    notifySubscribers: raw.notifySubscribers === undefined ? false : requireBoolean(raw.notifySubscribers, "notifySubscribers"),
    license: "youtube",
  };
  if (raw.license !== undefined && raw.license !== "youtube") {
    throw new Error("Path-only Shorts uploads use the standard YouTube license");
  }
  return {
    apiMetadata,
    analysis: {
      summary: String(analysis.summary).trim(),
      sampleCount: Number(analysis.sampleCount),
      onScreenText: Array.isArray(analysis.onScreenText)
        ? analysis.onScreenText.map((value) => String(value).trim()).filter(Boolean)
        : [],
      audioAssessment: String(analysis.audioAssessment ?? "").trim(),
      audioAssessmentSource: String(analysis.audioAssessmentSource ?? "").trim(),
      reviewedAudioSha256: String(analysis.reviewedAudioSha256 ?? "").trim().toLowerCase(),
      reviewedContactSheetSha256: String(analysis.reviewedContactSheetSha256 ?? "").trim().toLowerCase(),
      reviewedSampleIndexes: Array.isArray(analysis.reviewedSampleIndexes)
        ? analysis.reviewedSampleIndexes.map(Number)
        : [],
      metadataRationale: String(analysis.metadataRationale ?? "").trim(),
    },
  };
}

function buildRunId(videoSha256, apiMetadata) {
  const metadataSha256 = sha256Text(JSON.stringify(apiMetadata));
  return {
    runId: `private-short-${videoSha256}`,
    metadataSha256,
  };
}

function normalizedTags(tags) {
  return [...(tags ?? [])]
    .map((tag) => String(tag).normalize("NFC"))
    .sort((left, right) => left.localeCompare(right));
}

function metadataDiff(expected, video, now = Date.now()) {
  const differences = [];
  if (video.snippet?.title !== expected.title) differences.push("title");
  if (video.snippet?.description !== expected.description) differences.push("description");
  if (video.snippet?.categoryId !== expected.categoryId) differences.push("categoryId");
  if (video.snippet?.defaultLanguage !== expected.defaultLanguage) differences.push("defaultLanguage");
  if (video.snippet?.defaultAudioLanguage !== expected.defaultAudioLanguage) {
    differences.push("defaultAudioLanguage");
  }
  if (JSON.stringify(normalizedTags(video.snippet?.tags)) !== JSON.stringify(normalizedTags(expected.tags))) {
    differences.push("tags");
  }
  const scheduled = expected.privacyStatus === "scheduled";
  const beforePublish = scheduled && Number(now) < Date.parse(expected.publishAt);
  const expectedPrivacy = scheduled ? (beforePublish ? "private" : "public") : expected.privacyStatus;
  if (video.status?.privacyStatus !== expectedPrivacy) differences.push("privacyStatus");
  if (scheduled && (beforePublish || video.status?.publishAt !== undefined)
    && Math.floor(Date.parse(video.status?.publishAt) / 1000) !== Math.floor(Date.parse(expected.publishAt) / 1000)) differences.push("publishAt");
  if (!scheduled && video.status?.publishAt) differences.push("publishAt");
  if (video.status?.selfDeclaredMadeForKids !== expected.madeForKids) {
    differences.push("selfDeclaredMadeForKids");
  }
  if (video.status?.embeddable !== expected.embeddable) differences.push("embeddable");
  if (video.status?.publicStatsViewable !== expected.publicStatsViewable) {
    differences.push("publicStatsViewable");
  }
  if (video.status?.license !== expected.license) differences.push("license");
  const effectiveSyntheticMedia = video.status?.containsSyntheticMedia === true;
  if (effectiveSyntheticMedia !== expected.containsSyntheticMedia) {
    differences.push("containsSyntheticMedia");
  }
  return differences;
}

function assertUploadOutcomeIsKnown(state) {
  if (!state.execution?.videoId && state.execution?.state === "uploading_private_short") {
    throw new Error(
      "UPLOAD_OUTCOME_UNKNOWN: a previous upload started without a saved video ID; audit YouTube before any retry",
    );
  }
  return true;
}

function validateUploadedSourceEvidence(state) {
  if (!state.execution?.videoId) {
    throw new Error("Direct Shorts source evidence cannot be verified without a video ID");
  }
  const streamed = state.execution.streamedSource;
  if (!streamed) {
    throw new Error(
      `UPLOADED_SOURCE_EVIDENCE_MISSING: private video ${state.execution.videoId} requires manual audit`,
    );
  }
  if (
    state.execution.state === "uploaded_source_mismatch" ||
    streamed.sha256 !== state.source?.sha256 ||
    streamed.size !== state.source?.size
  ) {
    throw new Error(
      `UPLOADED_SOURCE_MISMATCH: private video ${state.execution.videoId} does not match the authorized source bytes`,
    );
  }
  return true;
}

function progressStream(filePath, totalBytes) {
  let uploaded = 0;
  let lastPercent = -1;
  let lastReportedAt = 0;
  const streamedHash = createHash("sha256");
  let resolveEvidence;
  let rejectEvidence;
  const evidence = new Promise((resolve, reject) => {
    resolveEvidence = resolve;
    rejectEvidence = reject;
  });
  void evidence.catch(() => {});
  const progress = new Transform({
    transform(chunk, encoding, callback) {
      uploaded += chunk.length;
      streamedHash.update(chunk);
      const percent = Math.floor((uploaded / totalBytes) * 100);
      const now = Date.now();
      if (percent >= lastPercent + 5 || now - lastReportedAt >= 30000 || uploaded === totalBytes) {
        lastPercent = percent;
        lastReportedAt = now;
        process.stdout.write(`VIDEO_UPLOAD_PROGRESS ${percent}% ${uploaded}/${totalBytes}\n`);
      }
      callback(null, chunk);
    },
    flush(callback) {
      resolveEvidence({
        size: uploaded,
        sha256: streamedHash.digest("hex"),
      });
      callback();
    },
  });
  const source = createReadStream(filePath);
  source.on("error", rejectEvidence);
  progress.on("error", rejectEvidence);
  return {
    body: source.pipe(progress),
    evidence,
  };
}

function buildInsertRequest(state, mediaBody) {
  return {
    part: ["snippet", "status"],
    notifySubscribers: state.metadata.notifySubscribers,
    requestBody: {
      snippet: {
        title: state.metadata.title,
        description: state.metadata.description,
        tags: state.metadata.tags,
        categoryId: state.metadata.categoryId,
        defaultLanguage: state.metadata.defaultLanguage,
        defaultAudioLanguage: state.metadata.defaultAudioLanguage,
      },
      status: {
        privacyStatus: state.metadata.privacyStatus === "scheduled" ? "private" : state.metadata.privacyStatus,
        ...(state.metadata.privacyStatus === "scheduled" ? { publishAt: state.metadata.publishAt } : {}),
        selfDeclaredMadeForKids: state.metadata.madeForKids,
        containsSyntheticMedia: state.metadata.containsSyntheticMedia,
        embeddable: state.metadata.embeddable,
        publicStatsViewable: state.metadata.publicStatsViewable,
        license: state.metadata.license,
      },
    },
    media: {
      mimeType: state.source.mimeType,
      body: mediaBody,
    },
  };
}

const buildPrivateInsertRequest = buildInsertRequest;

async function saveRefreshedToken(tokenPath, refreshed) {
  const existing = await readJson(tokenPath);
  await writeJsonAtomic(tokenPath, {
    ...existing,
    ...refreshed,
    refresh_token: refreshed.refresh_token ?? existing.refresh_token,
  });
}

async function expectedChannelId(cliExpected = "", uploadChannel = null) {
  // --channel이 있으면 채널 목록의 ID가 기대값이다. 둘 다 주면 같아야 한다.
  const expected = cliExpected.trim() || uploadChannel?.youtubeChannelId || "";
  if (!expected) {
    throw new Error("--expected-channel-id is required for a direct Shorts write");
  }
  if (uploadChannel && expected !== uploadChannel.youtubeChannelId) {
    throw new Error(
      `--expected-channel-id ${expected} does not match --channel ${uploadChannel.id} (${uploadChannel.youtubeChannelId})`,
    );
  }
  return expected;
}

async function connectYoutube(cliExpected = "", channelArg = null) {
  const { google } = require("googleapis");
  const uploadChannel = channelArg ? resolveUploadChannel(channelArg) : null;
  const settingsPath = RUNTIME_PATHS.settingsPath;
  const tokenPath = uploadChannel
    ? getUploadRuntimePaths({ channel: uploadChannel.id }).oauthTokenPath
    : RUNTIME_PATHS.oauthTokenPath;
  const [settings, token, expected] = await Promise.all([
    readJson(settingsPath),
    readJson(tokenPath),
    expectedChannelId(cliExpected, uploadChannel),
  ]);
  const oauth = new google.auth.OAuth2(settings.clientId, settings.clientSecret, settings.redirectUri);
  oauth.setCredentials(token);
  oauth.on("tokens", (refreshed) => {
    void saveRefreshedToken(tokenPath, refreshed).catch((error) => {
      process.stderr.write(`TOKEN_SAVE_WARNING ${error.message}\n`);
    });
  });
  const youtube = google.youtube({ version: "v3", auth: oauth });
  const channelResponse = await youtube.channels.list({ part: ["id", "snippet"], mine: true });
  const channel = channelResponse.data.items?.[0];
  if (!channel?.id) throw new Error("No YouTube channel is connected");
  if (channel.id !== expected) throw new Error(`Connected channel mismatch: ${channel.id}`);
  return { youtube, channel };
}

async function validateAssignableCategory(youtube, categoryId) {
  const response = await youtube.videoCategories.list({
    part: ["snippet"],
    regionCode: "KR",
  });
  const category = (response.data.items ?? []).find((item) => item.id === categoryId);
  if (!category || category.snippet?.assignable !== true) {
    throw new Error(`metadata.categoryId ${categoryId} is not currently assignable in KR`);
  }
  return {
    id: category.id,
    title: category.snippet?.title ?? "",
    assignable: true,
  };
}

function runPaths(runId) {
  if (!SAFE_RUN_ID.test(runId)) throw new Error("Invalid direct Shorts run ID");
  const runDir = path.join(RUNS_ROOT, runId);
  return {
    runDir,
    statePath: path.join(runDir, "direct_short_request.json"),
    verificationPath: path.join(runDir, "verification.json"),
    executedPath: path.join(runDir, "EXECUTED"),
    pendingPath: path.join(runDir, "VERIFICATION_PENDING"),
    runLockPath: path.join(runDir, "DIRECT_SHORT_RUN.lock"),
  };
}

async function acquireRunLock(paths) {
  await mkdir(paths.runDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(paths.runLockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (attempt === 0 && (await recoverStaleRunLock(paths))) continue;
      throw new Error("DIRECT_SHORT_RUN_ALREADY_ACTIVE: inspect the existing run before retrying");
    }
    try {
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(paths.runLockPath, { force: true });
      throw error;
    }
    return async () => {
      await handle.close().catch(() => {});
      await rm(paths.runLockPath, { force: true });
    };
  }
  throw new Error("DIRECT_SHORT_RUN_ALREADY_ACTIVE: inspect the existing run before retrying");
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Direct Shorts run lock has an invalid PID");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

async function recoverStaleRunLock(paths) {
  const lock = await readJson(paths.runLockPath);
  if (processIsAlive(Number(lock.pid))) return false;
  const state = await readJsonIfExists(paths.statePath);
  if (state && !state.execution?.videoId) {
    if (state.execution?.state === "uploading_private_short") {
      throw new Error(
        "UPLOAD_OUTCOME_UNKNOWN: a stale lock belongs to an upload without a saved video ID; audit YouTube before retrying",
      );
    }
    if (!METADATA_MUTABLE_STATES.has(state.execution?.state)) {
      throw new Error("STALE_DIRECT_SHORT_RUN_REQUIRES_AUDIT: refusing to remove its run lock");
    }
  }
  await rm(paths.runLockPath, { force: true });
  return true;
}

async function loadInspection(videoSha256) {
  const inspectionPath = path.join(
    INSPECTION_ROOT,
    videoSha256.slice(0, 16),
    "inspection",
    "source_inspection.json",
  );
  const inspection = await readJsonIfExists(inspectionPath);
  if (
    inspection?.authority !== "codex_path_only_shorts_source_inspection" ||
    inspection?.source?.sha256 !== videoSha256 ||
    inspection?.shortsEligibility?.eligible !== true ||
    !(await exists(inspection.sampling?.contactSheetPath ?? ""))
  ) {
    throw new Error("A matching source inspection is required; run --inspect first");
  }
  validateShortsProbe(inspection.probe);
  const contactSheetSha256 = (await sha256StableFile(inspection.sampling.contactSheetPath)).sha256;
  if (contactSheetSha256 !== inspection.sampling.contactSheetSha256) {
    throw new Error("Shorts contact sheet differs from its inspection evidence");
  }
  if (inspection.probe.audioStreamCount > 0) {
    if (!(await exists(inspection.audioReview?.path ?? ""))) {
      throw new Error("Shorts audio review artifact is missing");
    }
    const audioReviewSha256 = (await sha256StableFile(inspection.audioReview.path)).sha256;
    if (audioReviewSha256 !== inspection.audioReview.sha256) {
      throw new Error("Shorts audio review artifact differs from its inspection evidence");
    }
  }
  return {
    inspection,
    inspectionPath,
    inspectionSha256: (await sha256StableFile(inspectionPath)).sha256,
  };
}

function validateAnalysisEvidence(analysis, inspection) {
  const reviewedSampleIndexes = [...new Set(analysis.reviewedSampleIndexes)];
  if (
    analysis.reviewedContactSheetSha256 !== inspection.sampling.contactSheetSha256 ||
    reviewedSampleIndexes.length < 5 ||
    reviewedSampleIndexes.some((value) => !Number.isInteger(value) || value < 1 || value > 9) ||
    analysis.sampleCount !== reviewedSampleIndexes.length
  ) {
    throw new Error("metadata.analysis does not match the reviewed Shorts contact sheet samples");
  }

  const allowedAudioSources = new Set(["direct_review", "signal_only", "no_audio"]);
  if (!allowedAudioSources.has(analysis.audioAssessmentSource)) {
    throw new Error(
      "metadata.analysis.audioAssessmentSource must be direct_review, signal_only, or no_audio",
    );
  }
  if (inspection.probe.audioStreamCount > 0) {
    if (
      !inspection.audioReview?.sha256 ||
      analysis.reviewedAudioSha256 !== inspection.audioReview.sha256 ||
      analysis.audioAssessmentSource === "no_audio" ||
      !analysis.audioAssessment
    ) {
      throw new Error("metadata.analysis does not match the inspected Shorts audio evidence");
    }
  } else if (analysis.audioAssessmentSource !== "no_audio" || analysis.reviewedAudioSha256) {
    throw new Error("metadata.analysis must record no_audio when the Shorts source has no audio stream");
  }
  return true;
}

function preparedState({
  runId,
  videoPath,
  videoStat,
  videoSha256,
  version,
  mimeType,
  probe,
  inspectionEvidence,
  analysis,
  apiMetadata,
  metadataSha256,
  createdAt,
}) {
  return {
    schemaVersion: 4,
    runId,
    createdAt: createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: {
      path: videoPath,
      originalName: path.basename(videoPath),
      mimeType,
      size: videoStat.size,
      sha256: videoSha256,
      version,
      probe,
    },
    inspection: {
      path: inspectionEvidence.inspectionPath,
      sha256: inspectionEvidence.inspectionSha256,
      contactSheetPath: inspectionEvidence.inspection.sampling.contactSheetPath,
      contactSheetSha256: inspectionEvidence.inspection.sampling.contactSheetSha256,
      audioReviewPath: inspectionEvidence.inspection.audioReview?.path ?? null,
      audioReviewSha256: inspectionEvidence.inspection.audioReview?.sha256 ?? null,
    },
    analysis,
    metadata: apiMetadata,
    metadataSha256,
    authorization: {
      authority: "user_path_only_shorts",
      privacyStatus: apiMetadata.privacyStatus,
      publishAt: apiMetadata.publishAt,
      publicTransitionAuthorized: ["public", "scheduled"].includes(apiMetadata.privacyStatus),
      helperRequired: false,
      manualCaptionsAuthorized: false,
      thumbnailUploadAuthorized: false,
      playlistWriteAuthorized: false,
      localizationsAuthorized: false,
      oneUploadPerSourceSha256: true,
    },
    execution: {
      state: "prepared",
      videoId: null,
      videoUrl: null,
      shortsUrl: null,
    },
  };
}

async function prepareRun(videoInput, metadataFileInput, options = {}) {
  const videoPath = await resolveVideoPath(videoInput);
  const mimeType = videoMimeType(videoPath);
  const metadataPath = await realpath(path.resolve(metadataFileInput)).catch(() => "");
  if (!metadataPath) throw new Error("Shorts metadata file is missing");
  const [{ sha256: videoSha256, stat: videoStat, version }, probe, metadataRaw] = await Promise.all([
    sha256StableFile(videoPath),
    probeVideo(videoPath),
    readJson(metadataPath),
  ]);
  const { apiMetadata, analysis } = normalizeMetadata(metadataRaw, options);
  const inspectionEvidence = await loadInspection(videoSha256);
  validateAnalysisEvidence(analysis, inspectionEvidence.inspection);
  if (
    inspectionEvidence.inspection.source.path !== videoPath ||
    inspectionEvidence.inspection.source.mimeType !== mimeType ||
    inspectionEvidence.inspection.source.size !== videoStat.size ||
    inspectionEvidence.inspection.source.version !== version
  ) {
    throw new Error("Source path or file version differs from the inspected Shorts evidence");
  }
  if (
    inspectionEvidence.inspection.probe.width !== probe.width ||
    inspectionEvidence.inspection.probe.height !== probe.height ||
    !probesMatch(inspectionEvidence.inspection.probe, probe)
  ) {
    throw new Error("Current ffprobe result differs from the inspected Shorts evidence");
  }
  const { runId, metadataSha256 } = buildRunId(videoSha256, apiMetadata);
  const paths = runPaths(runId);
  const snapshot = await readJsonIfExists(paths.statePath);
  if (snapshot) assertUploadOutcomeIsKnown(snapshot);
  const releaseRunLock = await acquireRunLock(paths);
  try {
    const existing = await readJsonIfExists(paths.statePath);
    if (existing) {
      assertUploadOutcomeIsKnown(existing);
      if (
        existing.schemaVersion !== 4 ||
        existing.runId !== runId ||
        sha256Text(JSON.stringify(existing.metadata)) !== existing.metadataSha256 ||
        existing.source?.sha256 !== videoSha256 ||
        existing.source?.path !== videoPath ||
        existing.source?.mimeType !== mimeType ||
        existing.source?.size !== videoStat.size ||
        existing.source?.version !== version ||
        !probesMatch(existing.source?.probe, probe) ||
        existing.inspection?.contactSheetSha256 !==
          inspectionEvidence.inspection.sampling.contactSheetSha256 ||
        existing.inspection?.audioReviewSha256 !==
          (inspectionEvidence.inspection.audioReview?.sha256 ?? null) ||
        existing.authorization?.authority !== "user_path_only_shorts" ||
        existing.authorization?.oneUploadPerSourceSha256 !== true
      ) {
        throw new Error("Existing direct Shorts source run does not match the current exact file");
      }

      if (existing.metadataSha256 !== metadataSha256) {
        if (
          existing.execution?.videoId ||
          !METADATA_MUTABLE_STATES.has(existing.execution?.state)
        ) {
          throw new Error(
            `SOURCE_ALREADY_CLAIMED: ${videoSha256} already has an upload run and cannot create a metadata-variant duplicate`,
          );
        }
        const updated = preparedState({
          runId,
          videoPath,
          videoStat,
          videoSha256,
          version,
          mimeType,
          probe,
          inspectionEvidence,
          analysis,
          apiMetadata,
          metadataSha256,
          createdAt: existing.createdAt,
        });
        await Promise.all([
          rm(paths.executedPath, { force: true }),
          rm(paths.pendingPath, { force: true }),
        ]);
        await writeJsonAtomic(paths.statePath, updated);
        return { state: updated, paths, videoPath };
      }

      if (!existing.execution?.videoId && METADATA_MUTABLE_STATES.has(existing.execution?.state)) {
        existing.analysis = analysis;
        existing.inspection = preparedState({
          runId,
          videoPath,
          videoStat,
          videoSha256,
          version,
          mimeType,
          probe,
          inspectionEvidence,
          analysis,
          apiMetadata,
          metadataSha256,
          createdAt: existing.createdAt,
        }).inspection;
        existing.updatedAt = new Date().toISOString();
        await writeJsonAtomic(paths.statePath, existing);
      }
      return { state: existing, paths, videoPath };
    }

    const state = preparedState({
      runId,
      videoPath,
      videoStat,
      videoSha256,
      version,
      mimeType,
      probe,
      inspectionEvidence,
      analysis,
      apiMetadata,
      metadataSha256,
    });
    await writeJsonAtomic(paths.statePath, state);
    return { state, paths, videoPath };
  } finally {
    await releaseRunLock();
  }
}

async function verifyUploadedVideo(youtube, state, attempts) {
  let finalVideo = null;
  let finalDifferences = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await youtube.videos.list({
      part: ["snippet", "status", "contentDetails", "processingDetails", "fileDetails"],
      id: [state.execution.videoId],
    });
    finalVideo = response.data.items?.[0] ?? null;
    if (!finalVideo) throw new Error("Uploaded Shorts video was not returned by videos.list");
    finalDifferences = metadataDiff(state.metadata, finalVideo);
    const processingStatus = finalVideo.processingDetails?.processingStatus ?? null;
    const uploadStatus = finalVideo.status?.uploadStatus ?? null;
    const stream = finalVideo.fileDetails?.videoStreams?.[0];
    if (
      stream?.widthPixels &&
      Number(stream.widthPixels) !== Number(state.source.probe.codedWidth ?? state.source.probe.width)
    ) {
      finalDifferences.push("sourceWidth");
    }
    if (
      stream?.heightPixels &&
      Number(stream.heightPixels) !== Number(state.source.probe.codedHeight ?? state.source.probe.height)
    ) {
      finalDifferences.push("sourceHeight");
    }
    if (["failed", "rejected", "deleted"].includes(uploadStatus)) {
      throw new Error(`YouTube upload failed: ${uploadStatus}`);
    }
    if (["failed", "terminated"].includes(processingStatus)) {
      throw new Error(`YouTube processing failed: ${processingStatus}`);
    }
    if (processingStatus === "succeeded" && finalDifferences.length === 0) break;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return { video: finalVideo, differences: [...new Set(finalDifferences)] };
}

async function finalizeVerification(youtube, state, paths, attempts) {
  validateUploadedSourceEvidence(state);
  const { video, differences } = await verifyUploadedVideo(youtube, state, attempts);
  const processingStatus = video.processingDetails?.processingStatus ?? null;
  const verified = processingStatus === "succeeded" && differences.length === 0;
  const verification = {
    checkedAt: new Date().toISOString(),
    verified,
    videoId: state.execution.videoId,
    videoUrl: state.execution.videoUrl,
    shortsUrl: state.execution.shortsUrl,
    privacyStatus: video.status?.privacyStatus ?? null,
    publishAt: video.status?.publishAt ?? null,
    uploadStatus: video.status?.uploadStatus ?? null,
    processingStatus,
    metadataDifferences: differences,
    source: {
      duration: video.contentDetails?.duration ?? null,
      width: video.fileDetails?.videoStreams?.[0]?.widthPixels ?? null,
      height: video.fileDetails?.videoStreams?.[0]?.heightPixels ?? null,
      definition: video.contentDetails?.definition ?? null,
    },
    thumbnail: {
      customUploaded: false,
      hasCustomThumbnail: video.contentDetails?.hasCustomThumbnail ?? null,
    },
    captions: {
      manualUploaded: false,
      automaticTracksMayAppearLater: true,
    },
    playlist: { added: false },
    localizations: { added: false },
    notifications: { requested: state.metadata.notifySubscribers },
    syntheticMedia: {
      requestedValue: state.metadata.containsSyntheticMedia,
      actualValue: video.status?.containsSyntheticMedia ?? null,
      effectiveValue: video.status?.containsSyntheticMedia === true,
      readBackAvailable: typeof video.status?.containsSyntheticMedia === "boolean",
    },
  };
  state.execution.state = verified ? "private_short_verified" : "verification_pending";
  state.execution.verifiedAt = verified ? verification.checkedAt : null;
  state.verification = verification;
  await Promise.all([
    writeJsonAtomic(paths.statePath, state),
    writeJsonAtomic(paths.verificationPath, verification),
  ]);
  if (verified) {
    await rm(paths.pendingPath, { force: true });
    await writeJsonAtomic(paths.executedPath, {
      runId: state.runId,
      videoId: state.execution.videoId,
      state: state.execution.state,
    });
  } else {
    await rm(paths.executedPath, { force: true });
    await writeJsonAtomic(paths.pendingPath, {
      runId: state.runId,
      videoId: state.execution.videoId,
      state: state.execution.state,
      differences,
      processingStatus,
    });
  }
  process.stdout.write(
    `FINAL_RESULT ${JSON.stringify({
      runId: state.runId,
      videoId: state.execution.videoId,
      videoUrl: state.execution.videoUrl,
      shortsUrl: state.execution.shortsUrl,
      state: state.execution.state,
      verified,
      privacyStatus: video.status?.privacyStatus ?? null,
      publishAt: video.status?.publishAt ?? null,
      processingStatus,
      metadataDifferences: differences,
    })}\n`,
  );
  if (!verified) process.exitCode = 2;
}

async function executePreparedRun(expectedState, paths, videoPath, args) {
  const releaseRunLock = await acquireRunLock(paths);
  try {
    const state = await readJson(paths.statePath);
    if (
      state.schemaVersion !== 4 ||
      state.runId !== expectedState.runId ||
      state.source?.sha256 !== expectedState.source?.sha256 ||
      state.metadataSha256 !== expectedState.metadataSha256 ||
      sha256Text(JSON.stringify(state.metadata)) !== state.metadataSha256 ||
      state.authorization?.authority !== "user_path_only_shorts" ||
      state.authorization?.oneUploadPerSourceSha256 !== true
    ) {
      throw new Error("Direct Shorts run changed after preparation; refusing a stale execution");
    }
    assertUploadOutcomeIsKnown(state);

    if (state.channel?.id && state.channel.id !== args.expectedChannelId) throw new Error("Connected channel mismatch");

    if (!args.preflight && state.metadata.privacyStatus !== "scheduled" && state.execution?.state === "private_short_verified" && (await exists(paths.executedPath))) {
      validateUploadedSourceEvidence(state);
      const executed = await readJson(paths.executedPath);
      if (
        executed.runId !== state.runId ||
        executed.videoId !== state.execution.videoId ||
        executed.state !== "private_short_verified"
      ) {
        throw new Error("Direct Shorts EXECUTED marker does not match its verified run state");
      }
      process.stdout.write(
        `FINAL_RESULT ${JSON.stringify({
          runId: state.runId,
          videoId: state.execution.videoId,
          videoUrl: state.execution.videoUrl,
          shortsUrl: state.execution.shortsUrl,
          state: state.execution.state,
          verified: true,
          privacyStatus: state.verification?.privacyStatus ?? state.metadata.privacyStatus,
          publishAt: state.verification?.publishAt ?? null,
          reused: true,
          oneUploadPerSourceSha256: true,
        })}\n`,
      );
      return;
    }

    const { youtube, channel } = await connectYoutube(args.expectedChannelId, args.channel);
    if (state.channel?.id && state.channel.id !== channel.id) {
      throw new Error("Direct Shorts run belongs to a different YouTube channel");
    }
    const category = state.execution.videoId
      ? null
      : await validateAssignableCategory(youtube, state.metadata.categoryId);
    state.channel = {
      id: channel.id,
      title: channel.snippet?.title ?? "",
      verifiedAt: new Date().toISOString(),
    };
    if (category) {
      state.category = {
        ...category,
        verifiedAt: new Date().toISOString(),
        regionCode: "KR",
      };
    }
    if (args.preflight) {
      if (!state.execution.videoId && state.metadata.publishAt && Date.parse(state.metadata.publishAt) <= Date.now()) throw new Error("PUBLISH_AT_TOO_SOON");
      if (!state.execution.videoId) state.execution.state = "preflight_ready";
      state.updatedAt = new Date().toISOString();
      await writeJsonAtomic(paths.statePath, state);
      process.stdout.write(
        `PREFLIGHT_COMPLETE ${JSON.stringify({
          runId: state.runId,
          channelId: channel.id,
          videoSha256: state.source.sha256,
          durationSeconds: state.source.probe.durationSeconds,
          width: state.source.probe.width,
          height: state.source.probe.height,
          privacyStatus: state.metadata.privacyStatus,
          publishAt: state.metadata.publishAt,
          manualCaptions: false,
          thumbnail: false,
          playlist: false,
          localizations: false,
          existingVideoId: state.execution.videoId ?? null,
        })}\n`,
      );
      return;
    }

    if (!state.execution.videoId) {
      if (state.metadata.publishAt && Date.parse(state.metadata.publishAt) <= Date.now()) throw new Error("PUBLISH_AT_TOO_SOON");
      const current = await sha256StableFile(videoPath);
      if (current.sha256 !== state.source.sha256 || current.version !== state.source.version) {
        throw new Error("Source video changed after the direct Shorts request was prepared");
      }
      state.execution.state = "uploading_private_short";
      state.execution.uploadStartedAt = new Date().toISOString();
      state.execution.lastUploadError = null;
      state.updatedAt = new Date().toISOString();
      await writeJsonAtomic(paths.statePath, state);
      process.stdout.write(`VIDEO_UPLOAD_START privacy=${state.metadata.privacyStatus} notifySubscribers=${state.metadata.notifySubscribers}\n`);

      const streamedSource = progressStream(videoPath, state.source.size);
      let response;
      try {
        response = await youtube.videos.insert(
          buildInsertRequest(state, streamedSource.body),
          { retry: false },
        );
      } catch (error) {
        const responseStatus = Number(error?.response?.status ?? error?.status ?? error?.code);
        const definitiveRejection = responseStatus >= 400 && responseStatus < 500;
        state.execution.state = definitiveRejection ? "upload_rejected" : "uploading_private_short";
        state.execution.lastUploadError = {
          at: new Date().toISOString(),
          responseStatus: Number.isFinite(responseStatus) ? responseStatus : null,
          definitiveRejection,
          message: "YOUTUBE_UPLOAD_REQUEST_FAILED",
        };
        state.updatedAt = new Date().toISOString();
        await writeJsonAtomic(paths.statePath, state);
        throw error;
      }

      const videoId = response.data.id;
      if (!videoId) throw new Error("YouTube videos.insert returned no video ID");
      state.execution.videoId = videoId;
      state.execution.videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      state.execution.shortsUrl = `https://www.youtube.com/shorts/${videoId}`;
      state.execution.state = "video_uploaded_private";
      state.execution.uploadedAt = new Date().toISOString();
      state.updatedAt = new Date().toISOString();
      await writeJsonAtomic(paths.statePath, state);

      const streamedEvidence = await streamedSource.evidence;
      state.execution.streamedSource = streamedEvidence;
      if (
        streamedEvidence.sha256 !== state.source.sha256 ||
        streamedEvidence.size !== state.source.size
      ) {
        state.execution.state = "uploaded_source_mismatch";
        state.updatedAt = new Date().toISOString();
        await writeJsonAtomic(paths.statePath, state);
        throw new Error(
          `UPLOADED_SOURCE_MISMATCH: private video ${videoId} does not match the authorized source bytes`,
        );
      }
      await writeJsonAtomic(paths.statePath, state);
      process.stdout.write(`VIDEO_UPLOAD_COMPLETE ${videoId}\n`);
    } else {
      process.stdout.write(`VIDEO_UPLOAD_SKIPPED_EXISTING ${state.execution.videoId}\n`);
    }
    await finalizeVerification(youtube, state, paths, 7);
  } finally {
    await releaseRunLock();
  }
}

async function verifyExistingRun(runId, cliExpected, channelArg = null) {
  const paths = runPaths(runId);
  const releaseRunLock = await acquireRunLock(paths);
  try {
    const state = await readJson(paths.statePath);
    assertUploadOutcomeIsKnown(state);
    if (
      state.schemaVersion !== 4 ||
      state.runId !== runId ||
      state.source?.sha256 !== runId.slice("private-short-".length) ||
      sha256Text(JSON.stringify(state.metadata)) !== state.metadataSha256 ||
      !state.execution?.videoId
    ) {
      throw new Error("Direct Shorts run has no valid resumable uploaded video ID");
    }
    const { youtube, channel } = await connectYoutube(cliExpected, channelArg);
    if (state.channel?.id && state.channel.id !== channel.id) {
      throw new Error("Direct Shorts run belongs to a different YouTube channel");
    }
    await finalizeVerification(youtube, state, paths, 1);
  } finally {
    await releaseRunLock();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.inspect) {
    await inspectVideo(args.video);
    return;
  }
  if (args.verifyOnly) {
    await verifyExistingRun(args.runId, args.expectedChannelId, args.channel);
    return;
  }
  const { state, paths, videoPath } = await prepareRun(args.video, args.metadataFile, args);
  await executePreparedRun(state, paths, videoPath, args);
}

if (require.main === module) {
  main().catch((error) => {
    const message = error?.response || error?.config || error?.name === "GaxiosError"
      ? "YOUTUBE_API_REQUEST_FAILED"
      : String(error?.message ?? "DIRECT_SHORT_FAILED").replace(/https?:\/\/\S+/g, "[url omitted]");
    process.stderr.write(`PRIVATE_SHORT_UPLOAD_FAILED ${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  COMFY_REFERRAL_URL,
  DENO_DISCORD_URL,
  MAX_SHORT_SECONDS,
  acquireRunLock,
  assertUploadOutcomeIsKnown,
  buildRunId,
  buildPrivateInsertRequest,
  buildInsertRequest,
  ensureDenoDiscordBlock,
  ensureComfyReferralBlock,
  ensurePermanentDescriptionLinks,
  metadataDiff,
  normalizeRotationDegrees,
  normalizeMetadata,
  normalizePublishingOptions,
  parseArgs,
  validateAssignableCategory,
  validateAnalysisEvidence,
  validateUploadedSourceEvidence,
  validateShortsProbe,
  verifyUploadedVideo,
  videoMimeType,
};
