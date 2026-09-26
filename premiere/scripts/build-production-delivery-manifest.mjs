import {spawnSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  buildCaptionIdentity,
  buildDeliveryManifest,
} from "./lib/production-delivery.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/build-production-delivery-manifest.mjs --production <slug> --video <master.mp4> --final-ko <final.srt> --edit-revision <id> --audio-revision <id> --motion-revision <id> --caption-revision <id> --render-revision <id> [options]",
    "",
    "Options:",
    "  --out <json>                 default productions/<slug>/delivery/master-manifest.json",
    "  --caption-embedding <mode>   none|burned|sidecar, default sidecar",
    "  --fps <number>               strict SRT frame-grid check",
    "  --caption-max-duration <n>   explicit final-caption profile limit, default validator value 7",
    "  --loudness-report <path>     existing verified report pointer",
    "  --user-approved-srt-sha256 <hash> Preserve this exact user-final SRT; editorial limits become recorded advisories, structural checks remain blocking",
    "",
    "This is offline-only. It hashes existing master/SRT files and performs no Premiere or YouTube write.",
  ].join("\n");
}

function parseArgs(argv) {
  const values = {};
  const aliases = new Map([
    ["--production", "production"], ["--video", "video"], ["--final-ko", "finalKo"],
    ["--edit-revision", "edit"], ["--audio-revision", "audio"],
    ["--motion-revision", "motion"], ["--caption-revision", "captions"],
    ["--render-revision", "render"], ["--caption-embedding", "captionEmbedding"],
    ["--fps", "fps"], ["--caption-max-duration", "captionMaxDuration"],
    ["--loudness-report", "loudnessReport"], ["--out", "out"],
    ["--user-approved-srt-sha256", "userApprovedSrtSha256"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return {help: true};
    if (!aliases.has(flag) || index + 1 >= argv.length) throw new Error(`Unknown or incomplete option: ${flag}`);
    values[aliases.get(flag)] = argv[++index];
  }
  for (const key of ["production", "video", "finalKo", "edit", "audio", "motion", "captions", "render"]) {
    if (!values[key]) throw new Error(`Missing required option: ${key}`);
  }
  values.captionEmbedding ??= "sidecar";
  if (values.fps !== undefined) values.fps = Number(values.fps);
  if (values.captionMaxDuration !== undefined) {
    values.captionMaxDuration = Number(values.captionMaxDuration);
    if (!(values.captionMaxDuration > 0)) {
      throw new Error("--caption-max-duration must be a positive number");
    }
  }
  values.out ??= path.join("productions", values.production, "delivery", "master-manifest.json");
  return values;
}

function probeVideo(filePath) {
  const result = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "format=duration:stream=codec_name",
    "-of", "json", filePath,
  ], {encoding: "utf8", windowsHide: true});
  if (result.error || result.status !== 0) {
    throw new Error(`ffprobe failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  const payload = JSON.parse(result.stdout);
  const durationSeconds = Number(payload.format?.duration);
  if (!(durationSeconds > 0)) throw new Error("ffprobe did not return a positive duration");
  return {durationSeconds, codec: payload.streams?.[0]?.codec_name ?? null};
}

function writeJsonAtomic(target, payload) {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), {recursive: true});
  const temporary = `${resolved}.building-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, resolved);
  return resolved;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else {
    const video = probeVideo(path.resolve(options.video));
    const captions = buildCaptionIdentity(path.resolve(options.finalKo), {
      fps: options.fps ?? null,
      maxDurationSeconds: options.captionMaxDuration ?? null,
      userApprovedSrtSha256: options.userApprovedSrtSha256 ?? null,
    });
    const manifest = buildDeliveryManifest({
      production: options.production,
      revisions: {
        edit: options.edit,
        audio: options.audio,
        motion: options.motion,
        captions: options.captions,
        render: options.render,
      },
      video: {
        path: options.video,
        durationSeconds: video.durationSeconds,
        codec: video.codec,
        captionEmbedding: options.captionEmbedding,
        loudnessReport: options.loudnessReport ?? null,
      },
      captions,
    });
    const out = writeJsonAtomic(options.out, manifest);
    console.log(JSON.stringify({out, production: manifest.production, videoSha256: manifest.video.sha256, finalKoSha256: manifest.captions.sha256, cueCount: manifest.captions.cueCount}, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

export {parseArgs, probeVideo, usage};
