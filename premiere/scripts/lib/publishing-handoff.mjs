import crypto from "node:crypto";
import fs from "node:fs";
import {createRequire} from "node:module";
import path from "node:path";

import {buildCaptionIdentity, sha256File} from "./production-delivery.mjs";
import {validateThumbnailPackage} from "./thumbnail-package.mjs";

const require = createRequire(import.meta.url);
const {resolveUploadChannel} = require("../../packages/runtime-paths/index.cjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${label}: ${error.message}`);
  }
}

function assertWithin(candidate, parent, label) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(path.resolve(parent), resolved);
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `${label} must stay inside the production folder`);
  return resolved;
}

function assertWithinAny(candidate, parents, label) {
  const resolved = path.resolve(candidate);
  const allowed = parents.some((parent) => {
    const relative = path.relative(path.resolve(parent), resolved);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
  assert(allowed, `${label} must stay inside an authorized production render/delivery folder`);
  return resolved;
}

export function buildPublishingHandoff({
  productionRoot,
  production,
  deliveryManifestPath,
  thumbnailPackagePath = null,
  metadataPath = null,
  youtubeChannel = null,
  createdAt = new Date().toISOString(),
} = {}) {
  const slug = String(production ?? "").trim();
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug), "production slug is invalid");
  const repoRoot = path.resolve(productionRoot);
  const productionDir = path.join(repoRoot, "productions", slug);
  const resolvedDeliveryPath = assertWithin(deliveryManifestPath, productionDir, "delivery manifest");
  const delivery = readJson(resolvedDeliveryPath, "delivery manifest");
  assert(delivery.schemaVersion === 1 && delivery.ready === true, "delivery manifest is not MASTER_READY");
  assert(delivery.production === slug, "delivery manifest production mismatch");

  const videoPath = assertWithinAny(
    delivery.video?.path ?? "",
    [path.join(repoRoot, "renders", slug), path.join(productionDir, "delivery")],
    "master video",
  );
  const videoStat = fs.statSync(videoPath);
  assert(videoStat.isFile() && videoStat.size === delivery.video.bytes, "master video size mismatch");
  assert(sha256File(videoPath).toLowerCase() === String(delivery.video.sha256).toLowerCase(), "master video hash mismatch");

  const finalKoPath = assertWithin(
    delivery.captions?.finalKoreanPath ?? "",
    productionDir,
    "final KO",
  );
  const captionIdentity = buildCaptionIdentity(finalKoPath, {
    fps: delivery.captions?.qc?.fps ?? null,
    maxDurationSeconds: delivery.captions?.qc?.maxDurationSeconds ?? null,
    userApprovedSrtSha256: delivery.captions?.qc?.userApprovedSrtSha256 ?? null,
  });
  assert(captionIdentity.sha256.toLowerCase() === String(delivery.captions.sha256).toLowerCase(), "final KO hash mismatch");
  assert(captionIdentity.timelineSha256.toLowerCase() === String(delivery.captions.timelineSha256).toLowerCase(), "final KO timeline hash mismatch");
  assert(captionIdentity.cueCount === delivery.captions.cueCount, "final KO cue count mismatch");

  let thumbnail = null;
  if (thumbnailPackagePath) {
    const resolvedThumbnailPackage = assertWithin(thumbnailPackagePath, productionDir, "thumbnail package");
    const packageDocument = readJson(resolvedThumbnailPackage, "thumbnail package");
    const validated = validateThumbnailPackage(packageDocument, {
      currentFinalKo: {
        kind: "final-ko-srt",
        path: path.relative(repoRoot, finalKoPath).replaceAll("\\", "/"),
        sha256: captionIdentity.sha256,
        revision: delivery.revisions.captions,
      },
    });
    assert(validated.fresh, "thumbnail package is stale");
    assert(validated.document.selection.status === "selected", "thumbnail has not been selected by the user");
    const selected = validated.document.candidates.find(
      (candidate) => candidate.id === validated.document.selection.candidateId,
    );
    assert(selected, "selected thumbnail candidate is missing");
    const selectedPath = path.resolve(repoRoot, selected.file);
    assert(sha256File(selectedPath).toUpperCase() === selected.sha256, "selected thumbnail hash mismatch");
    thumbnail = {
      packagePath: resolvedThumbnailPackage,
      packageSha256: sha256File(resolvedThumbnailPackage),
      candidateId: selected.id,
      path: selectedPath,
      sha256: selected.sha256,
    };
  }

  let resolvedMetadataPath = null;
  let metadataSha256 = null;
  if (metadataPath) {
    resolvedMetadataPath = assertWithin(metadataPath, productionDir, "metadata");
    JSON.parse(fs.readFileSync(resolvedMetadataPath, "utf8"));
    metadataSha256 = sha256File(resolvedMetadataPath);
  }

  return {
    schemaVersion: 1,
    production: slug,
    createdAt,
    readyForHelper: true,
    deliveryManifest: {
      path: resolvedDeliveryPath,
      sha256: sha256File(resolvedDeliveryPath),
    },
    video: {
      path: videoPath,
      sha256: delivery.video.sha256,
      bytes: delivery.video.bytes,
      durationSeconds: delivery.video.durationSeconds,
    },
    captions: {
      finalKoreanPath: finalKoPath,
      sha256: captionIdentity.sha256,
      timelineSha256: captionIdentity.timelineSha256,
      cueCount: captionIdentity.cueCount,
      revision: delivery.revisions.captions,
    },
    thumbnail,
    metadata: resolvedMetadataPath
      ? {path: resolvedMetadataPath, sha256: metadataSha256}
      : null,
    // 선택: 올릴 YouTube 채널(runtime-paths UPLOAD_CHANNELS). 주면 Helper가 그 채널로 전환하고 다른 채널의 READY를 막는다.
    ...(youtubeChannel ? {youtubeChannel: resolveUploadChannel(youtubeChannel).id} : {}),
    approvals: {
      helperRequestSaved: false,
      youtubeWriteAuthorized: false,
      publicVisibilityAuthorized: false,
    },
  };
}

export function publishingHandoffDigest(handoff) {
  return crypto.createHash("sha256").update(JSON.stringify(handoff)).digest("hex");
}
