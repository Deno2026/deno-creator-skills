import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {parseSrt, validateSrt} from "../validate-srt.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function nonEmptyString(value, label) {
  assert(typeof value === "string" && value.trim(), `${label} must be a non-empty string`);
  return value.trim();
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

export function buildCaptionIdentity(
  srtPath,
  {fps = null, maxDurationSeconds = null, userApprovedSrtSha256 = null} = {},
) {
  const source = fs.readFileSync(srtPath, "utf8");
  const validation = validateSrt(source, {
    fps,
    ...(maxDurationSeconds === null ? {} : {maxDurationSeconds}),
  });
  const sourceSha256 = sha256Buffer(Buffer.from(source, "utf8"));
  const approved = userApprovedSrtSha256 !== null;
  if (approved) {
    assert(/^[a-f0-9]{64}$/iu.test(userApprovedSrtSha256) &&
      sourceSha256 === userApprovedSrtSha256.toLowerCase(), "user-approved SRT hash mismatch");
  }
  const editorialCodes = new Set([
    "CUE_DURATION_TOO_SHORT", "CUE_DURATION_TOO_LONG", "CUE_CPS_EXCEEDED", "CUE_LINE_TOO_LONG",
  ]);
  const advisoryIssues = approved ? validation.issues.filter((item) => editorialCodes.has(item.code)) : [];
  const blockingIssues = approved ? validation.issues.filter((item) => !editorialCodes.has(item.code)) : validation.issues;
  assert(blockingIssues.length === 0, `final Korean SRT failed QC: ${blockingIssues.map((item) => item.code).join(", ")}`);
  const parsed = parseSrt(source);
  assert(parsed.issues.length === 0, "final Korean SRT could not be parsed cleanly");
  const timeline = parsed.cues.map((cue) => [cue.number, cue.startTimecode, cue.endTimecode]);
  return {
    finalKoreanPath: path.resolve(srtPath),
    sha256: sha256Buffer(Buffer.from(source, "utf8")),
    timelineSha256: sha256Buffer(Buffer.from(JSON.stringify(timeline), "utf8")),
    cueCount: parsed.cues.length,
    qc: {
      issueCount: blockingIssues.length,
      ...(approved ? {userApprovedSrtSha256: sourceSha256, advisoryIssues} : {}),
      fps: validation.limits?.fps ?? fps,
      maxDurationSeconds: validation.limits?.maxDurationSeconds ?? maxDurationSeconds,
    },
  };
}

export function buildDeliveryManifest({
  production,
  createdAt = new Date().toISOString(),
  revisions,
  video,
  captions,
} = {}) {
  const slug = nonEmptyString(production, "production");
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug), "production slug is invalid");
  assert(revisions && typeof revisions === "object", "revisions are required");
  const normalizedRevisions = {};
  for (const key of ["edit", "audio", "motion", "captions", "render"]) {
    normalizedRevisions[key] = nonEmptyString(revisions[key], `revisions.${key}`);
  }
  assert(video && typeof video === "object", "video is required");
  assert(captions && typeof captions === "object", "captions are required");
  const resolvedVideoPath = path.resolve(nonEmptyString(video.path, "video.path"));
  const videoStat = fs.statSync(resolvedVideoPath);
  assert(videoStat.isFile() && videoStat.size > 0, "video must be a non-empty file");
  const durationSeconds = Number(video.durationSeconds);
  assert(durationSeconds > 0, "video.durationSeconds must be positive");
  const captionEmbedding = nonEmptyString(video.captionEmbedding, "video.captionEmbedding");
  assert(["none", "burned", "sidecar"].includes(captionEmbedding), "video.captionEmbedding is invalid");

  return {
    schemaVersion: 1,
    production: slug,
    createdAt: nonEmptyString(createdAt, "createdAt"),
    ready: true,
    revisions: normalizedRevisions,
    video: {
      path: resolvedVideoPath,
      sha256: sha256File(resolvedVideoPath),
      bytes: videoStat.size,
      durationSeconds,
      captionEmbedding,
      codec: video.codec ?? null,
      loudnessReport: video.loudnessReport ?? null,
    },
    captions: {
      finalKoreanPath: path.resolve(nonEmptyString(captions.finalKoreanPath, "captions.finalKoreanPath")),
      sha256: nonEmptyString(captions.sha256, "captions.sha256"),
      timelineSha256: nonEmptyString(captions.timelineSha256, "captions.timelineSha256"),
      cueCount: Number(captions.cueCount),
      qc: captions.qc ?? null,
      syncReport: captions.syncReport ?? null,
    },
  };
}
