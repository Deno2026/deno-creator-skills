import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  findProductionRoot,
  getProductionPaths,
  DEFAULT_UPLOAD_CHANNEL_ID,
  getUploadRuntimePaths,
  requireSafeSlug,
  resolveUploadChannel,
} from "@deno/runtime-paths";

import {
  getVideoStageReadSource,
  stageVerifiedLocalVideo,
  type PublicVideoStage,
} from "@/lib/video-upload-staging";

type DeliveryManifest = {
  schemaVersion?: unknown;
  production?: unknown;
  ready?: unknown;
  revisions?: { captions?: unknown };
  video?: {
    path?: unknown;
    sha256?: unknown;
    bytes?: unknown;
    durationSeconds?: unknown;
  };
  captions?: {
    finalKoreanPath?: unknown;
    sha256?: unknown;
    timelineSha256?: unknown;
    cueCount?: unknown;
  };
};

type PublishingHandoff = {
  schemaVersion?: unknown;
  production?: unknown;
  createdAt?: unknown;
  readyForHelper?: unknown;
  deliveryManifest?: { path?: unknown; sha256?: unknown };
  video?: {
    path?: unknown;
    sha256?: unknown;
    bytes?: unknown;
    durationSeconds?: unknown;
  };
  captions?: {
    finalKoreanPath?: unknown;
    sha256?: unknown;
    timelineSha256?: unknown;
    cueCount?: unknown;
    revision?: unknown;
  };
  thumbnail?: null | {
    packagePath?: unknown;
    packageSha256?: unknown;
    candidateId?: unknown;
    path?: unknown;
    sha256?: unknown;
  };
  metadata?: null | { path?: unknown; sha256?: unknown };
  /** 선택: 이 작품을 올릴 YouTube 채널 id(runtime-paths UPLOAD_CHANNELS). 없으면 기본 채널(Deno) 작품이다. */
  youtubeChannel?: unknown;
  approvals?: {
    helperRequestSaved?: unknown;
    youtubeWriteAuthorized?: unknown;
    publicVisibilityAuthorized?: unknown;
  };
};

type ValidatedFile = {
  path: string;
  sha256: string;
  bytes: number;
};

export type ValidatedProductionHandoff = {
  production: string;
  createdAt: string;
  handoffSha256: string;
  deliveryManifest: ValidatedFile;
  video: ValidatedFile & { durationSeconds: number };
  captions: ValidatedFile & {
    timelineSha256: string;
    cueCount: number;
    revision: string;
  };
  thumbnail: null | (ValidatedFile & { packagePath: string; candidateId: string });
  metadata: null | ValidatedFile;
  youtubeChannel: string;
};

export type PreparedProductionInput = {
  production: string;
  preparationId: string;
  handoffSha256: string;
  video: {
    stage: PublicVideoStage;
    name: string;
    previewUrl: string;
  };
  caption: {
    name: string;
    type: "application/x-subrip";
    base64: string;
    sha256: string;
    timelineSha256: string;
    cueCount: number;
    revision: string;
  };
  thumbnail: null | {
    name: string;
    type: string;
    base64: string;
    sha256: string;
    candidateId: string;
  };
  metadata: Record<string, unknown> | null;
  youtubeChannel: string;
};

function fail(code: string, detail = ""): never {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function stringField(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) fail(code);
  return value.trim();
}

function hashField(value: unknown, code: string): string {
  const hash = stringField(value, code).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) fail(code);
  return hash;
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(code);
  return Number(value);
}

function positiveNumber(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(code);
  return value;
}

async function readJson<T>(filePath: string, code: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    fail(code);
  }
}

async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function pathIsInside(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveRegularFile(
  rawPath: unknown,
  productionRoot: string,
  allowedRoots: string[],
  code: string,
) {
  const value = stringField(rawPath, `${code}_PATH_MISSING`);
  const candidate = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(productionRoot, value);
  const lexicalRoot = path.resolve(productionRoot);
  if (!pathIsInside(candidate, lexicalRoot)) fail(`${code}_OUTSIDE_PRODUCTION_ROOT`);

  const info = await lstat(candidate).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) fail(`${code}_NOT_REGULAR_FILE`);
  const [realCandidate, realProductionRoot] = await Promise.all([
    realpath(candidate),
    realpath(lexicalRoot),
  ]);
  if (!pathIsInside(realCandidate, realProductionRoot)) {
    fail(`${code}_OUTSIDE_PRODUCTION_ROOT`);
  }

  const resolvedAllowedRoots = allowedRoots.map((root) => path.resolve(root));
  if (!resolvedAllowedRoots.some((root) => pathIsInside(candidate, root))) {
    fail(`${code}_OUTSIDE_ALLOWED_ROOT`);
  }
  return realCandidate;
}

async function validateFile(
  filePath: string,
  expectedSha256: string,
  expectedBytes: number | null,
  code: string,
): Promise<ValidatedFile> {
  const file = await stat(filePath);
  if (!file.isFile()) fail(`${code}_NOT_REGULAR_FILE`);
  if (expectedBytes !== null && file.size !== expectedBytes) fail(`${code}_SIZE_MISMATCH`);
  const actualSha256 = await sha256File(filePath);
  if (actualSha256 !== expectedSha256) fail(`${code}_SHA256_MISMATCH`);
  return { path: filePath, sha256: actualSha256, bytes: file.size };
}

function sameNumber(left: number, right: number) {
  return Math.abs(left - right) <= 0.001;
}

export async function validateProductionHandoff(
  slug: string,
): Promise<ValidatedProductionHandoff> {
  const production = requireSafeSlug(slug);
  const productionRoot = findProductionRoot();
  const productionPaths = getProductionPaths(production);
  const handoffPath = productionPaths.publishingHandoffPath;
  const handoffBytes = await readFile(handoffPath);
  const handoffSha256 = createHash("sha256").update(handoffBytes).digest("hex");
  const handoff = await readJson<PublishingHandoff>(handoffPath, "HANDOFF_INVALID_JSON");
  const createdAt = stringField(handoff.createdAt, "HANDOFF_CREATED_AT_INVALID");
  if (
    handoff.schemaVersion !== 1 ||
    handoff.production !== production ||
    handoff.readyForHelper !== true ||
    Number.isNaN(Date.parse(createdAt)) ||
    handoff.approvals?.helperRequestSaved !== false ||
    handoff.approvals?.youtubeWriteAuthorized !== false ||
    handoff.approvals?.publicVisibilityAuthorized !== false
  ) {
    fail("HANDOFF_HEADER_INVALID");
  }

  const deliveryPath = await resolveRegularFile(
    handoff.deliveryManifest?.path,
    productionRoot,
    [productionPaths.deliveryDir],
    "DELIVERY_MANIFEST",
  );
  const canonicalDeliveryPath = await realpath(productionPaths.masterManifestPath);
  if (deliveryPath !== canonicalDeliveryPath) fail("DELIVERY_MANIFEST_NOT_CANONICAL");
  const deliveryExpectedSha = hashField(
    handoff.deliveryManifest?.sha256,
    "DELIVERY_MANIFEST_SHA256_INVALID",
  );
  const deliveryFile = await validateFile(
    deliveryPath,
    deliveryExpectedSha,
    null,
    "DELIVERY_MANIFEST",
  );
  const delivery = await readJson<DeliveryManifest>(deliveryPath, "DELIVERY_MANIFEST_INVALID_JSON");
  if (
    delivery.schemaVersion !== 1 ||
    delivery.production !== production ||
    delivery.ready !== true
  ) {
    fail("DELIVERY_MANIFEST_HEADER_INVALID");
  }

  const videoSha256 = hashField(handoff.video?.sha256, "HANDOFF_VIDEO_SHA256_INVALID");
  const videoBytes = positiveInteger(handoff.video?.bytes, "HANDOFF_VIDEO_BYTES_INVALID");
  const durationSeconds = positiveNumber(
    handoff.video?.durationSeconds,
    "HANDOFF_VIDEO_DURATION_INVALID",
  );
  if (
    hashField(delivery.video?.sha256, "DELIVERY_VIDEO_SHA256_INVALID") !== videoSha256 ||
    positiveInteger(delivery.video?.bytes, "DELIVERY_VIDEO_BYTES_INVALID") !== videoBytes ||
    !sameNumber(
      positiveNumber(delivery.video?.durationSeconds, "DELIVERY_VIDEO_DURATION_INVALID"),
      durationSeconds,
    )
  ) {
    fail("HANDOFF_DELIVERY_VIDEO_MISMATCH");
  }
  const videoPath = await resolveRegularFile(
    handoff.video?.path,
    productionRoot,
    [path.join(productionRoot, "renders", production), productionPaths.deliveryDir],
    "MASTER_VIDEO",
  );
  const deliveryVideoPath = await resolveRegularFile(
    delivery.video?.path,
    productionRoot,
    [path.join(productionRoot, "renders", production), productionPaths.deliveryDir],
    "DELIVERY_VIDEO",
  );
  if (videoPath !== deliveryVideoPath) fail("HANDOFF_DELIVERY_VIDEO_PATH_MISMATCH");
  const video = {
    ...(await validateFile(videoPath, videoSha256, videoBytes, "MASTER_VIDEO")),
    durationSeconds,
  };

  const captionSha256 = hashField(
    handoff.captions?.sha256,
    "HANDOFF_CAPTION_SHA256_INVALID",
  );
  const timelineSha256 = hashField(
    handoff.captions?.timelineSha256,
    "HANDOFF_CAPTION_TIMELINE_INVALID",
  );
  const cueCount = positiveInteger(handoff.captions?.cueCount, "HANDOFF_CAPTION_COUNT_INVALID");
  const revision = stringField(handoff.captions?.revision, "HANDOFF_CAPTION_REVISION_INVALID");
  if (
    hashField(delivery.captions?.sha256, "DELIVERY_CAPTION_SHA256_INVALID") !== captionSha256 ||
    hashField(delivery.captions?.timelineSha256, "DELIVERY_CAPTION_TIMELINE_INVALID") !==
      timelineSha256 ||
    positiveInteger(delivery.captions?.cueCount, "DELIVERY_CAPTION_COUNT_INVALID") !== cueCount ||
    stringField(delivery.revisions?.captions, "DELIVERY_CAPTION_REVISION_INVALID") !== revision
  ) {
    fail("HANDOFF_DELIVERY_CAPTION_MISMATCH");
  }
  const captionPath = await resolveRegularFile(
    handoff.captions?.finalKoreanPath,
    productionRoot,
    [productionPaths.captionsDir],
    "FINAL_KOREAN",
  );
  const deliveryCaptionPath = await resolveRegularFile(
    delivery.captions?.finalKoreanPath,
    productionRoot,
    [productionPaths.captionsDir],
    "DELIVERY_FINAL_KOREAN",
  );
  const canonicalCaptionPath = await realpath(productionPaths.finalKoreanPath);
  if (captionPath !== canonicalCaptionPath || deliveryCaptionPath !== canonicalCaptionPath) {
    fail("FINAL_KOREAN_NOT_CANONICAL");
  }
  const captions = {
    ...(await validateFile(captionPath, captionSha256, null, "FINAL_KOREAN")),
    timelineSha256,
    cueCount,
    revision,
  };

  let thumbnail: ValidatedProductionHandoff["thumbnail"] = null;
  if (handoff.thumbnail !== null && handoff.thumbnail !== undefined) {
    const thumbnailPackageRoot = path.join(productionPaths.productionDir, "thumbnail");
    const thumbnailCandidateRoot = path.join(
      productionRoot,
      "renders",
      production,
      "thumbnail",
      "candidates",
    );
    const thumbnailPath = await resolveRegularFile(
      handoff.thumbnail.path,
      productionRoot,
      [thumbnailCandidateRoot],
      "THUMBNAIL",
    );
    const packagePath = await resolveRegularFile(
      handoff.thumbnail.packagePath,
      productionRoot,
      [thumbnailPackageRoot],
      "THUMBNAIL_PACKAGE",
    );
    const candidateId = stringField(handoff.thumbnail.candidateId, "THUMBNAIL_CANDIDATE_INVALID");
    await validateFile(
      packagePath,
      hashField(handoff.thumbnail.packageSha256, "THUMBNAIL_PACKAGE_SHA256_INVALID"),
      null,
      "THUMBNAIL_PACKAGE",
    );
    thumbnail = {
      ...(await validateFile(
        thumbnailPath,
        hashField(handoff.thumbnail.sha256, "THUMBNAIL_SHA256_INVALID"),
        null,
        "THUMBNAIL",
      )),
      packagePath,
      candidateId,
    };
  }

  let metadata: ValidatedFile | null = null;
  if (handoff.metadata !== null && handoff.metadata !== undefined) {
    const metadataPath = await resolveRegularFile(
      handoff.metadata.path,
      productionRoot,
      [productionPaths.publishingDir],
      "METADATA",
    );
    metadata = await validateFile(
      metadataPath,
      hashField(handoff.metadata.sha256, "METADATA_SHA256_INVALID"),
      null,
      "METADATA",
    );
  }

  // 인계에 채널이 없으면 기본 채널(Deno) 작품이다 — 지금까지의 인계는 모두 Deno 강의 영상이다.
  let youtubeChannel: string = DEFAULT_UPLOAD_CHANNEL_ID;
  if (handoff.youtubeChannel !== undefined && handoff.youtubeChannel !== null) {
    if (typeof handoff.youtubeChannel !== "string") fail("HANDOFF_YOUTUBE_CHANNEL_INVALID");
    try {
      youtubeChannel = resolveUploadChannel(handoff.youtubeChannel).id;
    } catch {
      fail("HANDOFF_YOUTUBE_CHANNEL_INVALID");
    }
  }

  return {
    production,
    createdAt,
    handoffSha256,
    deliveryManifest: deliveryFile,
    video,
    captions,
    thumbnail,
    metadata,
    youtubeChannel,
  };
}

function mimeTypeForFile(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".mkv": "video/x-matroska",
      ".webm": "video/webm",
    }[extension] ?? "application/octet-stream"
  );
}

async function writePreparationCache(
  production: string,
  value: Record<string, unknown>,
) {
  const root = path.join(getUploadRuntimePaths().productionPreparationsRoot, production);
  await mkdir(root, { recursive: true });
  const target = path.join(root, "current.json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

function unwrapLegacyAgentMetadata(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!value) return null;
  const nested = value.metadata;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : value;
}

async function loadReusableStage(validated: ValidatedProductionHandoff) {
  const cachePath = path.join(
    getUploadRuntimePaths().productionPreparationsRoot,
    validated.production,
    "current.json",
  );
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as {
      handoffSha256?: string;
      videoSha256?: string;
      uploadId?: string;
      preparationId?: string;
    };
    if (
      cached.handoffSha256 !== validated.handoffSha256 ||
      cached.videoSha256 !== validated.video.sha256 ||
      typeof cached.uploadId !== "string" ||
      typeof cached.preparationId !== "string"
    ) {
      return null;
    }
    const source = await getVideoStageReadSource(cached.uploadId);
    if (source.sha256 !== validated.video.sha256 || source.size !== validated.video.bytes) {
      return null;
    }
    return { uploadId: cached.uploadId, preparationId: cached.preparationId };
  } catch {
    return null;
  }
}

export async function prepareProductionHandoff(
  slug: string,
): Promise<PreparedProductionInput> {
  const validated = await validateProductionHandoff(slug);
  const reusable = await loadReusableStage(validated);
  const sourceStat = await stat(validated.video.path);
  const preparationId = reusable?.preparationId ?? randomUUID();
  const stage = reusable
    ? await (async () => {
        const source = await getVideoStageReadSource(reusable.uploadId);
        return {
          schemaVersion: 1 as const,
          uploadId: reusable.uploadId,
          status: "complete" as const,
          createdAt: validated.createdAt,
          updatedAt: validated.createdAt,
          originalName: path.basename(validated.video.path),
          type: mimeTypeForFile(validated.video.path),
          size: source.size,
          lastModified: sourceStat.mtimeMs,
          videoFingerprint: `production:${validated.production}:${validated.handoffSha256}`,
          receivedBytes: source.size,
          chunkSize: 8 * 1024 * 1024,
          sha256: source.sha256,
          materializationMode: source.materializationMode,
        } satisfies PublicVideoStage;
      })()
    : await stageVerifiedLocalVideo({
        sourcePath: validated.video.path,
        expectedSha256: validated.video.sha256,
        name: path.basename(validated.video.path),
        type: mimeTypeForFile(validated.video.path),
        size: validated.video.bytes,
        lastModified: sourceStat.mtimeMs,
        videoFingerprint: `production:${validated.production}:${validated.handoffSha256}`,
      });

  await writePreparationCache(validated.production, {
    schemaVersion: 1,
    preparationId,
    production: validated.production,
    handoffSha256: validated.handoffSha256,
    videoSha256: validated.video.sha256,
    uploadId: stage.uploadId,
    preparedAt: new Date().toISOString(),
  });

  const [captionBytes, thumbnailBytes, metadataDocument] = await Promise.all([
    readFile(validated.captions.path),
    validated.thumbnail ? readFile(validated.thumbnail.path) : Promise.resolve(null),
    validated.metadata
      ? readJson<Record<string, unknown>>(validated.metadata.path, "METADATA_INVALID_JSON")
      : Promise.resolve(null),
  ]);
  const metadata = unwrapLegacyAgentMetadata(metadataDocument);
  return {
    production: validated.production,
    preparationId,
    handoffSha256: validated.handoffSha256,
    video: {
      stage,
      name: path.basename(validated.video.path),
      previewUrl: `/api/upload-request/video-staging/${stage.uploadId}/content`,
    },
    caption: {
      name: "final-ko.srt",
      type: "application/x-subrip",
      base64: captionBytes.toString("base64"),
      sha256: validated.captions.sha256,
      timelineSha256: validated.captions.timelineSha256,
      cueCount: validated.captions.cueCount,
      revision: validated.captions.revision,
    },
    thumbnail:
      validated.thumbnail && thumbnailBytes
        ? {
            name: path.basename(validated.thumbnail.path),
            type: mimeTypeForFile(validated.thumbnail.path),
            base64: thumbnailBytes.toString("base64"),
            sha256: validated.thumbnail.sha256,
            candidateId: validated.thumbnail.candidateId,
          }
        : null,
    metadata,
    youtubeChannel: validated.youtubeChannel,
  };
}

export async function verifyProductionPreparation(input: {
  production: string;
  preparationId: string;
  uploadId: string;
}) {
  const production = requireSafeSlug(input.production);
  const cachePath = path.join(
    getUploadRuntimePaths().productionPreparationsRoot,
    production,
    "current.json",
  );
  const cached = await readJson<{
    schemaVersion?: unknown;
    preparationId?: unknown;
    production?: unknown;
    handoffSha256?: unknown;
    videoSha256?: unknown;
    uploadId?: unknown;
  }>(cachePath, "PRODUCTION_PREPARATION_MISSING");
  if (
    cached.schemaVersion !== 1 ||
    cached.production !== production ||
    cached.preparationId !== input.preparationId ||
    cached.uploadId !== input.uploadId
  ) {
    fail("PRODUCTION_PREPARATION_STALE");
  }

  const validated = await validateProductionHandoff(production);
  if (
    cached.handoffSha256 !== validated.handoffSha256 ||
    cached.videoSha256 !== validated.video.sha256
  ) {
    fail("PRODUCTION_PREPARATION_STALE");
  }
  const staged = await getVideoStageReadSource(input.uploadId);
  if (staged.sha256 !== validated.video.sha256 || staged.size !== validated.video.bytes) {
    fail("PRODUCTION_PREPARATION_STAGE_MISMATCH");
  }
  return {
    production,
    handoffSha256: validated.handoffSha256,
    videoSha256: validated.video.sha256,
    captionSha256: validated.captions.sha256,
    youtubeChannel: validated.youtubeChannel,
  };
}
