"use strict";

const { fs, path, execFileAsync, fail, hashFile, isoTime } = require("./common.cjs");
const TARGETS = Object.freeze(["youtube", "instagram", "threads", "x", "tiktok"]);
const DEFAULT_TARGETS = Object.freeze(["youtube", "instagram"]);
const SCHEDULED_TARGETS = Object.freeze(["instagram", "threads", "x"]);
const { parseTweet, extractUrls } = require("twitter-text");
// 유튜브 레인의 채널은 channels.json 기본 채널이다(개인 채널 ID를 코드에 두지 않는다 — 2026-09-27).
const { resolveUploadChannel } = require("@deno/runtime-paths");
function registryYouTubeChannelId(env = process.env) {
  try {
    return resolveUploadChannel(undefined, { env }).youtubeChannelId || "";
  } catch {
    return "";
  }
}
// 적재 시점의 등록 채널 ID(없으면 빈 문자열). 이전 상수 이름을 그대로 내보낸다.
const EXPECTED_CHANNEL_ID = registryYouTubeChannelId();
const DEFAULT_API_VERSION = "v26.0";
const LIMITS = Object.freeze({ youtubeSeconds: 180, instagramBytes: 300000000, instagramSeconds: 900, captionCharacters: 2200, hashtags: 30, mentions: 20 });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const chars = (value) => Array.from(value).length;

function normalizeSettings(raw = {}, options = {}) {
  if (!object(raw)) throw fail("PUBLISH_FILE_INVALID");
  const registryChannelId = registryYouTubeChannelId(options.env ?? process.env);
  const expectedChannelId = raw.youtube?.expectedChannelId || registryChannelId;
  if (registryChannelId && expectedChannelId !== registryChannelId) throw fail("YOUTUBE_CHANNEL_MISMATCH");
  const leadMinutes = raw.schedule?.leadMinutes ?? 10;
  const timezone = raw.schedule?.timezone ?? "Asia/Seoul";
  const apiVersion = raw.instagram?.apiVersion ?? DEFAULT_API_VERSION;
  if (!Number.isInteger(leadMinutes) || leadMinutes < 1 || leadMinutes > 90 || !/^v\d+\.0$/.test(apiVersion)) throw fail("PUBLISH_FILE_INVALID");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); }
  catch { throw fail("PUBLISH_FILE_INVALID"); }
  return { youtube: { expectedChannelId }, schedule: { leadMinutes, timezone }, instagram: { apiVersion } };
}
function localTime(iso, timezone = "Asia/Seoul") {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short",
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${timezone === "Asia/Seoul" ? "KST" : parts.timeZoneName}`;
}
function bool(value, defaultValue) {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (typeof value !== "boolean") throw fail("PUBLISH_FILE_INVALID");
  return value;
}
function caption(value) {
  if (typeof value !== "string" || !value.trim() || chars(value) > LIMITS.captionCharacters) throw fail("PUBLISH_FILE_INVALID");
  return value;
}
function youtubeMetadata(raw) {
  if (!object(raw)) throw fail("PUBLISH_FILE_INVALID");
  const privacy = raw.privacy ?? "scheduled";
  const descriptionBlocks = raw.descriptionBlocks ?? "default";
  if (!["private", "unlisted", "public", "scheduled"].includes(privacy) || !["default", "none"].includes(descriptionBlocks)) throw fail("PUBLISH_FILE_INVALID");
  if (typeof raw.title !== "string" || !raw.title.trim() || raw.title !== raw.title.trim() || chars(raw.title) > 100 || /[<>]/u.test(raw.title)) throw fail("PUBLISH_FILE_INVALID");
  if (typeof raw.description !== "string" || !raw.description.trim() || Buffer.byteLength(raw.description) > 5000 || /[<>]/u.test(raw.description)) throw fail("PUBLISH_FILE_INVALID");
  if (!/#shorts\b/i.test(`${raw.title}\n${raw.description}`) || !/^\d+$/.test(String(raw.categoryId))) throw fail("PUBLISH_FILE_INVALID");
  if (!Array.isArray(raw.tags) || !raw.tags.length || raw.tags.some((t) => typeof t !== "string" || !t.trim() || /[<>]/u.test(t))) throw fail("PUBLISH_FILE_INVALID");
  if (raw.tags.some((t) => t !== t.trim()) || new Set(raw.tags.map((t) => t.toLowerCase())).size !== raw.tags.length) throw fail("PUBLISH_FILE_INVALID");
  const tagCount = raw.tags.reduce((sum, tag) => sum + chars(tag) + (/\s/u.test(tag) ? 2 : 0), raw.tags.length - 1);
  if (tagCount > 500) throw fail("PUBLISH_FILE_INVALID");
  const a = raw.analysis;
  const indexes = a?.reviewedSampleIndexes;
  if (!object(a) || !a.summary?.trim?.() || !a.metadataRationale?.trim?.()
    || !Array.isArray(indexes) || indexes.length < 5 || indexes.length !== a.sampleCount || new Set(indexes).size !== indexes.length
    || indexes.some((n) => !Number.isInteger(n) || n < 1 || n > 9)
    || !/^[a-f0-9]{64}$/.test(a.reviewedContactSheetSha256 ?? "")
    || !["direct_review", "signal_only", "no_audio"].includes(a.audioAssessmentSource)
    || (a.audioAssessmentSource !== "no_audio" && (!a.audioAssessment?.trim?.() || !/^[a-f0-9]{64}$/.test(a.reviewedAudioSha256 ?? "")))) throw fail("PUBLISH_FILE_INVALID");
  if (a.audioAssessmentSource === "no_audio" && a.reviewedAudioSha256) throw fail("PUBLISH_FILE_INVALID");
  if (raw.notifySubscribers !== undefined) bool(raw.notifySubscribers);
  if (privacy === "private" && raw.notifySubscribers === true) throw fail("PUBLISH_FILE_INVALID");
  for (const key of ["playlistId", "thumbnail", "captionFile", "localizations"]) if (raw[key]) throw fail("PUBLISH_FILE_INVALID");
  return { ...raw, privacy, descriptionBlocks, categoryId: String(raw.categoryId), madeForKids: bool(raw.madeForKids), containsSyntheticMedia: bool(raw.containsSyntheticMedia) };
}
function validateMedia(source, targets) {
  const p = source.probe;
  if (!p || p.videoStreamCount !== 1 || !Number.isFinite(p.durationSeconds) || p.durationSeconds <= 0
    || !Number.isInteger(p.width) || !Number.isInteger(p.height) || p.width <= 0 || p.height <= 0) throw fail("PUBLISH_FILE_INVALID");
  // Reels recommend 9:16 but also accept landscape. Keep other short-form lanes unchanged.
  if (p.width > p.height && (targets.length !== 1 || targets[0] !== "instagram")) throw fail("PUBLISH_FILE_INVALID");
  if (targets.includes("youtube") && p.durationSeconds > LIMITS.youtubeSeconds) throw fail("PUBLISH_FILE_INVALID");
  if (targets.includes("instagram")) {
    if (source.size > LIMITS.instagramBytes || p.durationSeconds < 3 || p.durationSeconds > LIMITS.instagramSeconds || p.width > 1920
      || !Number.isFinite(p.fps) || p.fps < 23 || p.fps > 60 || !["h264", "hevc"].includes(p.videoCodec)
      || p.audioStreamCount < 1 || p.audioCodecs.some((c) => c !== "aac") || p.audioSampleRates.some((r) => !Number.isFinite(r) || r <= 0 || r > 48000)
      || ![".mp4", ".mov"].includes(path.extname(source.path).toLowerCase()) || p.fastStart !== true) throw fail("INSTAGRAM_SPEC");
  }
  if (targets.includes("threads") && (source.size > 1000000000 || p.durationSeconds > 300 || p.width > 1920
    || !Number.isFinite(p.fps) || p.fps < 23 || p.fps > 60 || !["h264", "hevc"].includes(p.videoCodec)
    || ![".mp4", ".mov"].includes(path.extname(source.path).toLowerCase()))) throw fail("THREADS_SPEC");
  if (targets.includes("x") && (source.size > 512 * 1024 * 1024 || p.durationSeconds > 140
    || p.videoCodec !== "h264" || path.extname(source.path).toLowerCase() !== ".mp4"
    || !Number.isFinite(p.fps) || p.fps > 60 || p.audioCodecs.some((c) => c !== "aac"))) throw fail("X_SPEC");
}
function normalizeManifest(raw, { source, settings = normalizeSettings(), now = Date.now(), checkSchedule = true } = {}) {
  if (!object(raw) || raw.schemaVersion !== 1 || typeof raw.slug !== "string" || !raw.slug.trim() || chars(raw.slug) > 160
    || /[\x00-\x1f]/u.test(raw.slug) || !object(raw.video) || typeof raw.video.path !== "string" || !path.isAbsolute(raw.video.path)) throw fail("PUBLISH_FILE_INVALID");
  raw = { ...raw, targets: raw.targets ?? [...DEFAULT_TARGETS] };
  if (!Array.isArray(raw.targets) || !raw.targets.length || raw.targets.some((t) => !TARGETS.includes(t)) || new Set(raw.targets).size !== raw.targets.length) throw fail("PUBLISH_FILE_INVALID");
  if (raw.video.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(raw.video.sha256)) throw fail("PUBLISH_FILE_INVALID");
  if (!source) throw fail("VIDEO_MISSING");
  if (raw.video.sha256 && raw.video.sha256.toLowerCase() !== source.sha256) throw fail("VIDEO_SHA_MISMATCH");
  validateMedia(source, raw.targets);
  const publishAt = isoTime(raw.publishAt);
  const milliseconds = Date.parse(publishAt);
  if (checkSchedule && milliseconds <= now + (settings.schedule.leadMinutes + 5) * 60000) throw fail("PUBLISH_AT_TOO_SOON");
  if (checkSchedule && raw.targets.includes("tiktok") && (milliseconds < now + 20 * 60000 || milliseconds > now + 10 * 86400000)) throw fail("TIKTOK_SCHEDULE_WINDOW");
  // TikTok's web picker accepts five-minute slots. Never round an approved time.
  if (raw.targets.includes("tiktok") && milliseconds % 300000 !== 0) throw fail("TIKTOK_SCHEDULE_WINDOW");
  const result = { schemaVersion: 1, slug: raw.slug, video: { path: source.path, sha256: source.sha256 }, publishAt, targets: [...raw.targets] };
  if (raw.targets.includes("youtube")) result.youtube = youtubeMetadata(raw.youtube);
  if (raw.targets.includes("instagram")) {
    if (!object(raw.instagram)) throw fail("PUBLISH_FILE_INVALID");
    const c = caption(raw.instagram.caption);
    if ((c.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > 30 || (c.match(/@/g) ?? []).length > 20) throw fail("PUBLISH_FILE_INVALID");
    const thumbOffsetMs = raw.instagram.thumbOffsetMs ?? 0;
    if (!Number.isInteger(thumbOffsetMs) || thumbOffsetMs < 0 || thumbOffsetMs >= source.probe.durationSeconds * 1000) throw fail("PUBLISH_FILE_INVALID");
    result.instagram = { caption: c, shareToFeed: bool(raw.instagram.shareToFeed, true), thumbOffsetMs, isAiGenerated: bool(raw.instagram.isAiGenerated, false) };
  }
  if (raw.targets.includes("tiktok")) {
    if (!object(raw.tiktok) || (raw.tiktok.privacy ?? "public") !== "public") throw fail("PUBLISH_FILE_INVALID");
    result.tiktok = { caption: caption(raw.tiktok.caption), privacy: "public", allowComments: bool(raw.tiktok.allowComments, true), allowDuet: bool(raw.tiktok.allowDuet, true), allowStitch: bool(raw.tiktok.allowStitch, true) };
  }
  if (raw.targets.includes("threads")) {
    const text = caption(raw.threads?.text);
    if (chars(text) > 500 || (text.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > 30 || (text.match(/@/g) ?? []).length > 20) throw fail("THREADS_TEXT_INVALID");
    result.threads = { text };
    // One topic tag per post, 50 characters, no periods or ampersands (Threads publishing reference).
    // Written without a leading "#": the API takes the bare topic and renders the tag itself.
    const topicTag = raw.threads?.topicTag;
    if (topicTag !== undefined) {
      if (typeof topicTag !== "string" || !topicTag.trim() || topicTag !== topicTag.trim()
        || chars(topicTag) > 50 || /[.&#]/u.test(topicTag)) throw fail("THREADS_TEXT_INVALID");
      result.threads.topicTag = topicTag;
    }
  }
  if (raw.targets.includes("x")) {
    if (typeof raw.x?.text !== "string" || !raw.x.text.trim() || !parseTweet(raw.x.text).valid) throw fail("X_TEXT_INVALID");
    result.x = { text: raw.x.text };
  }
  const warnings = TARGETS.filter((t) => !raw.targets.includes(t) && raw[t] !== undefined).map((t) => `IGNORED_PLATFORM_BLOCK:${t}`);
  if (result.x) {
    warnings.push("X_PAID_API");
    if (extractUrls(result.x.text).length) warnings.push("X_LINK_COST");
  }
  return { manifest: result, warnings, publishAtLocal: localTime(publishAt, settings.schedule.timezone) };
}
async function fastStart(file) {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    let offset = 0;
    while (offset + 8 <= size) {
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      let boxSize = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      if (type === "moov") return true;
      if (type === "mdat") return false;
      if (boxSize === 1) {
        if (bytesRead < 16) return false;
        boxSize = Number(header.readBigUInt64BE(8));
      }
      if (!Number.isSafeInteger(boxSize) || boxSize < 8 || offset + boxSize > size) return false;
      offset += boxSize;
    }
    return false;
  } finally { await handle.close(); }
}
async function inspectSource(input) {
  if (typeof input !== "string" || !path.isAbsolute(input)) throw fail("PUBLISH_FILE_INVALID");
  const file = await fs.realpath(input).catch(() => { throw fail("VIDEO_MISSING"); });
  const hash = await hashFile(file);
  let raw;
  try {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-of", "json", "-show_streams", "-show_format", file], { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    raw = JSON.parse(stdout);
  } catch { throw fail("PUBLISH_FILE_INVALID"); }
  const videos = (raw.streams ?? []).filter((s) => s.codec_type === "video");
  const audio = (raw.streams ?? []).filter((s) => s.codec_type === "audio");
  const v = videos[0] ?? {};
  const [num, den = "1"] = String(v.avg_frame_rate ?? v.r_frame_rate ?? "0/1").split("/");
  const rotation = ((Number(v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0) % 360) + 360) % 360;
  const swap = rotation === 90 || rotation === 270;
  return { path: file, ...hash, probe: {
    durationSeconds: Number(v.duration ?? raw.format?.duration), width: Number(swap ? v.height : v.width), height: Number(swap ? v.width : v.height),
    codedWidth: v.width, codedHeight: v.height, rotationDegrees: rotation, fps: Number(num) / Number(den), videoCodec: v.codec_name,
    videoStreamCount: videos.length, audioStreamCount: audio.length, audioCodecs: audio.map((s) => s.codec_name), audioSampleRates: audio.map((s) => Number(s.sample_rate)),
    formatName: raw.format?.format_name, fastStart: [".mp4", ".mov"].includes(path.extname(file).toLowerCase()) ? await fastStart(file) : false,
  } };
}
module.exports = { TARGETS, DEFAULT_TARGETS, SCHEDULED_TARGETS, EXPECTED_CHANNEL_ID, DEFAULT_API_VERSION, LIMITS, normalizeSettings, normalizeManifest, validateMedia, inspectSource, fastStart, localTime };
