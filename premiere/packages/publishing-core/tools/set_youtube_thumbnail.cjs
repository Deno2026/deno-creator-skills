#!/usr/bin/env node
// Apply the user-selected thumbnail to an already uploaded video (docs/agent/workflows/thumbnail-production.md
// 「업로드 뒤 적용」). The exact file must match the selection recorded in productions/<slug>/thumbnail/package.json and
// the video must belong to the connected channel. Preflight by default; --execute calls thumbnails.set, then re-reads
// the live thumbnail and compares it with the local file at 320x180 (mean absolute difference per channel, 0-255).
//   node packages/publishing-core/tools/set_youtube_thumbnail.cjs --package <package.json> [--video-id <id>] [--channel <id>] [--execute] [--log <json>]
// Channel: --channel or package youtubeApplication.channel (they must agree), default denoise. The token must belong to it.
// Needs DENO_UPLOAD_HELPER_RUNTIME_ROOT (OAuth settings and token, never printed).
const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const { mkdir, readFile, rename, stat, writeFile } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { google } = require("googleapis");
const { getUploadRuntimePaths, resolveUploadChannel } = require("../../runtime-paths/index.cjs");

const MAX_BYTES = 2 * 1024 * 1024;
const MATCH_MAD = 10; // 2026-09-18 premiere-pro-agent: the applied candidate read 0.83, the other candidates 37-52

function parseArgs(argv) {
  const args = { packagePath: "", videoId: "", execute: false, logPath: "", channel: null };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--package") args.packagePath = argv[++index] ?? "";
    else if (token === "--video-id") args.videoId = argv[++index] ?? "";
    else if (token === "--log") args.logPath = argv[++index] ?? "";
    else if (token === "--execute") args.execute = true;
    else if (token === "--channel") args.channel = argv[++index] ?? "";
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!args.packagePath) throw new Error("--package is required");
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

async function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

// 320x180 RGB pixels of an image file or an in-memory image, through ffmpeg.
function rgb320(input) {
  return new Promise((resolve, reject) => {
    const fromBuffer = Buffer.isBuffer(input);
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", fromBuffer ? "pipe:0" : input,
      "-vf", "scale=320:180", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { windowsHide: true });
    const chunks = [];
    let errorText = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { errorText += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg failed: ${errorText.trim()}`))));
    if (fromBuffer) child.stdin.end(input);
  });
}

function meanAbsDiff(a, b) {
  if (a.length !== b.length) return Infinity;
  let total = 0;
  for (let index = 0; index < a.length; index += 1) total += Math.abs(a[index] - b[index]);
  return total / a.length;
}

function liveThumbnailUrl(snippet) {
  const t = snippet?.thumbnails ?? {};
  return (t.maxres ?? t.standard ?? t.high ?? t.medium ?? t.default)?.url ?? "";
}

async function main() {
  const args = parseArgs(process.argv);
  const pkg = await readJson(args.packagePath);
  const selection = pkg.selection ?? {};
  if (selection.status !== "selected" || !selection.candidateId || !selection.candidateSha256) {
    throw new Error("The thumbnail package has no user selection");
  }
  const candidate = (pkg.candidates ?? []).find((item) => item.id === selection.candidateId);
  if (!candidate?.path) throw new Error(`Selected candidate ${selection.candidateId} has no path`);
  const file = await readFile(candidate.path);
  const fileSha = await sha256(file);
  if (fileSha !== String(selection.candidateSha256).toLowerCase()) {
    throw new Error(`Selected file changed after the selection (${fileSha.slice(0, 12)} != ${String(selection.candidateSha256).slice(0, 12)})`);
  }
  if (file.length > MAX_BYTES) throw new Error(`Thumbnail is over 2 MiB (${file.length} bytes); export a smaller file and re-select`);
  const videoId = args.videoId || pkg.youtubeApplication?.videoId || "";
  if (!videoId) throw new Error("--video-id is required (or youtubeApplication.videoId in the package)");
  if (pkg.youtubeApplication?.videoId && pkg.youtubeApplication.videoId !== videoId) {
    throw new Error(`Video ID ${videoId} differs from the package (${pkg.youtubeApplication.videoId})`);
  }

  const packageChannel = pkg.youtubeApplication?.channel ?? null;
  if (args.channel !== null && packageChannel && args.channel !== packageChannel) {
    throw new Error(`--channel ${args.channel} conflicts with the package channel ${packageChannel}`);
  }
  const uploadChannel = resolveUploadChannel(args.channel ?? packageChannel);
  const runtime = getUploadRuntimePaths({ channel: uploadChannel.id });
  const [settings, token] = await Promise.all([readJson(runtime.settingsPath), readJson(runtime.oauthTokenPath)]);
  const oauth = new google.auth.OAuth2(settings.clientId, settings.clientSecret, settings.redirectUri);
  oauth.setCredentials(token);
  oauth.on("tokens", (refreshed) => {
    void readJson(runtime.oauthTokenPath)
      .then((existing) => writeJsonAtomic(runtime.oauthTokenPath, { ...existing, ...refreshed, refresh_token: refreshed.refresh_token ?? existing.refresh_token }))
      .catch((error) => process.stderr.write(`TOKEN_SAVE_WARNING ${error.message}\n`));
  });
  const youtube = google.youtube({ version: "v3", auth: oauth });

  const channel = (await youtube.channels.list({ part: ["id", "snippet"], mine: true })).data.items?.[0];
  if (!channel?.id) throw new Error("No YouTube channel is connected");
  if (channel.id !== uploadChannel.youtubeChannelId) {
    throw new Error(
      `YOUTUBE_CHANNEL_MISMATCH: expected ${uploadChannel.title} (${uploadChannel.youtubeChannelId}), token belongs to ${channel.snippet?.title ?? ""} (${channel.id})`,
    );
  }
  const video = (await youtube.videos.list({ part: ["snippet", "status"], id: [videoId] })).data.items?.[0];
  if (!video) throw new Error(`Video ${videoId} was not found`);
  if (video.snippet?.channelId !== channel.id) throw new Error(`Video ${videoId} belongs to another channel`);
  const before = liveThumbnailUrl(video.snippet);
  const log = {
    videoId, channelId: channel.id, channelTitle: channel.snippet?.title ?? "", privacyStatus: video.status?.privacyStatus,
    candidateId: candidate.id, file: candidate.path, sha256: fileSha, bytes: file.length, mimeType: mimeType(candidate.path),
    liveThumbnailBefore: before, executed: false,
  };
  process.stdout.write(`PREFLIGHT_OK channel=${channel.snippet?.title ?? channel.id} video=${videoId} privacy=${log.privacyStatus} candidate=${candidate.id} bytes=${file.length}\n`);
  if (!args.execute) {
    if (args.logPath) await writeJsonAtomic(args.logPath, log);
    return;
  }

  await youtube.thumbnails.set({ videoId, media: { mimeType: log.mimeType, body: createReadStream(candidate.path) } });
  log.executed = true;
  log.appliedAt = new Date().toISOString();
  process.stdout.write("THUMBNAIL_SET_COMPLETE\n");

  // Read back: the live thumbnail must match the local file (the CDN can lag a few seconds behind the write).
  const local = await rgb320(candidate.path);
  const attempts = [];
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const live = (await youtube.videos.list({ part: ["snippet"], id: [videoId] })).data.items?.[0];
    const url = liveThumbnailUrl(live?.snippet);
    let mad = null;
    if (url) {
      const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}nocache=${Date.now()}`);
      if (response.ok) mad = meanAbsDiff(local, await rgb320(Buffer.from(await response.arrayBuffer())));
    }
    attempts.push({ attempt, url, mad: mad === null ? null : Number(mad.toFixed(2)) });
    if (mad !== null && mad < MATCH_MAD) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  const last = attempts.at(-1);
  log.readBack = attempts;
  log.verified = last.mad !== null && last.mad < MATCH_MAD;
  if (args.logPath) await writeJsonAtomic(args.logPath, log);
  process.stdout.write(`${log.verified ? "THUMBNAIL_VERIFIED" : "THUMBNAIL_UNVERIFIED"} mad=${last.mad} url=${last.url}\n`);
  if (!log.verified) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`THUMBNAIL_SET_FAILED ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
