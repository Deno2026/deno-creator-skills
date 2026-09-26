import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { getUploadRuntimePaths } from "@deno/runtime-paths";

// Keep each raw PUT below Next's proxy request-body ceiling. The proxy remains
// in front of this endpoint so the same-origin guard is not weakened.
export const VIDEO_STAGE_CHUNK_SIZE = 8 * 1024 * 1024;

const MAX_VIDEO_STAGE_SIZE = 256 * 1024 * 1024 * 1024;
const VIDEO_STAGE_TTL_MS = 48 * 60 * 60 * 1000;
const SAFE_STAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type VideoStageStatus = "receiving" | "complete";

type VideoStageState = {
  schemaVersion: 1;
  uploadId: string;
  status: VideoStageStatus;
  createdAt: string;
  updatedAt: string;
  originalName: string;
  storedName: string;
  type: string;
  size: number;
  lastModified: number;
  videoFingerprint: string;
  receivedBytes: number;
  chunkSize: number;
  sha256: string | null;
  materializationMode: "chunked" | "hardlink" | "copy";
};

export type PublicVideoStage = Omit<VideoStageState, "storedName">;

export type CreateVideoStageInput = {
  name: string;
  type?: string;
  size: number;
  lastModified?: number;
  videoFingerprint: string;
};

export type StageVerifiedLocalVideoInput = CreateVideoStageInput & {
  sourcePath: string;
  expectedSha256: string;
};

export class VideoStageError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "VideoStageError";
  }
}

function stagingRoot() {
  return getUploadRuntimePaths().uploadVideoStagingRoot;
}

function stageDir(uploadId: string) {
  if (!SAFE_STAGE_ID.test(uploadId)) {
    throw new VideoStageError(400, "INVALID_STAGE_ID", "영상 스테이징 ID가 올바르지 않습니다.");
  }

  const root = stagingRoot();
  const candidate = path.resolve(root, uploadId);
  if (path.dirname(candidate) !== root) {
    throw new VideoStageError(400, "INVALID_STAGE_ID", "영상 스테이징 경로가 올바르지 않습니다.");
  }
  return candidate;
}

function statePath(uploadId: string) {
  return path.join(stageDir(uploadId), "stage.json");
}

function dataPath(uploadId: string, state?: Pick<VideoStageState, "storedName">) {
  return path.join(stageDir(uploadId), state?.storedName ?? "video.bin");
}

function lockPath(uploadId: string) {
  return path.join(stageDir(uploadId), "WRITE_LOCK");
}

function sanitizeFileName(fileName: string, fallback: string) {
  const parsed = path.parse(fileName || fallback);
  const name = (parsed.name || path.parse(fallback).name)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  const ext = parsed.ext.replace(/[^a-zA-Z0-9.]/g, "").slice(0, 16) || path.extname(fallback);
  return `${name || path.parse(fallback).name}${ext}`;
}

function publicStage(state: VideoStageState): PublicVideoStage {
  return {
    schemaVersion: state.schemaVersion,
    uploadId: state.uploadId,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    originalName: state.originalName,
    type: state.type,
    size: state.size,
    lastModified: state.lastModified,
    videoFingerprint: state.videoFingerprint,
    receivedBytes: state.receivedBytes,
    chunkSize: state.chunkSize,
    sha256: state.sha256,
    materializationMode: state.materializationMode,
  };
}

async function writeStateAtomic(uploadId: string, state: VideoStageState) {
  const target = statePath(uploadId);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function readState(uploadId: string): Promise<VideoStageState> {
  const target = statePath(uploadId);
  let parsed: VideoStageState;
  try {
    parsed = JSON.parse(await readFile(target, "utf8")) as VideoStageState;
  } catch {
    throw new VideoStageError(404, "STAGE_NOT_FOUND", "저장 중인 영상 스테이징을 찾지 못했습니다.");
  }

  if (
    parsed.schemaVersion !== 1 ||
    parsed.uploadId !== uploadId ||
    (parsed.status !== "receiving" && parsed.status !== "complete") ||
    !Number.isSafeInteger(parsed.size) ||
    !Number.isSafeInteger(parsed.receivedBytes) ||
    parsed.size <= 0 ||
    parsed.receivedBytes < 0 ||
    parsed.receivedBytes > parsed.size ||
    parsed.storedName !== "video.bin" ||
    (parsed.sha256 !== null && !/^[a-f0-9]{64}$/.test(parsed.sha256)) ||
    (parsed.status === "complete" && !parsed.sha256) ||
    !["chunked", "hardlink", "copy"].includes(parsed.materializationMode)
  ) {
    throw new VideoStageError(409, "STAGE_CORRUPT", "영상 스테이징 상태 파일이 올바르지 않습니다.");
  }
  return parsed;
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function acquireStageLock(uploadId: string, mayRecover = true): Promise<() => Promise<void>> {
  let handle;
  try {
    handle = await open(lockPath(uploadId), "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      if (mayRecover) {
        const ownerPid = Number.parseInt(
          await readFile(lockPath(uploadId), "utf8").catch(() => ""),
          10,
        );
        if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || !processIsAlive(ownerPid)) {
          await unlink(lockPath(uploadId)).catch(() => undefined);
          return acquireStageLock(uploadId, false);
        }
      }
      throw new VideoStageError(
        409,
        "STAGE_BUSY",
        "같은 영상을 저장하는 작업이 이미 진행 중입니다. 잠시 후 다시 시도해 주세요.",
      );
    }
    throw error;
  }

  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(lockPath(uploadId)).catch(() => undefined);
    throw error;
  }

  return async () => {
    await handle.close().catch(() => undefined);
    await unlink(lockPath(uploadId)).catch(() => undefined);
  };
}

async function cleanupExpiredStages() {
  const root = stagingRoot();
  const now = Date.now();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_STAGE_ID.test(entry.name)) continue;
    const candidate = stageDir(entry.name);
    try {
      await lstat(lockPath(entry.name));
      continue;
    } catch {
      // No active writer lock.
    }

    try {
      const info = await stat(statePath(entry.name)).catch(() => stat(candidate));
      if (now - info.mtimeMs > VIDEO_STAGE_TTL_MS) {
        await rm(candidate, { recursive: true, force: true });
      }
    } catch {
      // A concurrent cleanup or user action may already have removed it.
    }
  }
}

export async function createVideoStage(input: CreateVideoStageInput): Promise<PublicVideoStage> {
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > MAX_VIDEO_STAGE_SIZE) {
    throw new VideoStageError(
      400,
      "INVALID_VIDEO_SIZE",
      "영상 파일 크기가 올바르지 않거나 지원 범위를 넘었습니다.",
      { maxBytes: MAX_VIDEO_STAGE_SIZE },
    );
  }
  if (!input.name?.trim() || input.name.length > 255) {
    throw new VideoStageError(400, "INVALID_VIDEO_NAME", "영상 파일 이름이 올바르지 않습니다.");
  }
  if (!input.videoFingerprint?.trim() || input.videoFingerprint.length > 160) {
    throw new VideoStageError(
      400,
      "INVALID_VIDEO_FINGERPRINT",
      "영상 파일 식별값이 올바르지 않습니다.",
    );
  }

  const root = stagingRoot();
  await mkdir(root, { recursive: true });
  await cleanupExpiredStages();

  try {
    const disk = await statfs(root);
    const availableBytes = Number(disk.bavail) * Number(disk.bsize);
    if (Number.isFinite(availableBytes) && availableBytes < input.size + VIDEO_STAGE_CHUNK_SIZE) {
      throw new VideoStageError(
        507,
        "INSUFFICIENT_STORAGE",
        "영상 요청 패키지를 저장할 로컬 디스크 공간이 부족합니다.",
        { requiredBytes: input.size + VIDEO_STAGE_CHUNK_SIZE, availableBytes },
      );
    }
  } catch (error) {
    if (error instanceof VideoStageError) throw error;
    // statfs support can vary; the exact write-size checks below remain authoritative.
  }

  const uploadId = randomUUID();
  const directory = stageDir(uploadId);
  const now = new Date().toISOString();
  const state: VideoStageState = {
    schemaVersion: 1,
    uploadId,
    status: "receiving",
    createdAt: now,
    updatedAt: now,
    originalName: input.name.trim(),
    storedName: "video.bin",
    type: input.type?.slice(0, 160) ?? "",
    size: input.size,
    lastModified: Number.isSafeInteger(input.lastModified) ? Number(input.lastModified) : 0,
    videoFingerprint: input.videoFingerprint.trim(),
    receivedBytes: 0,
    chunkSize: VIDEO_STAGE_CHUNK_SIZE,
    sha256: null,
    materializationMode: "chunked",
  };

  await mkdir(directory);
  try {
    await writeFile(dataPath(uploadId, state), new Uint8Array(), { flag: "wx" });
    await writeStateAtomic(uploadId, state);
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return publicStage(state);
}

export async function getVideoStage(uploadId: string): Promise<PublicVideoStage> {
  return publicStage(await readState(uploadId));
}

function sameFileVersion(
  left: Awaited<ReturnType<typeof stat>>,
  right: Awaited<ReturnType<typeof stat>>,
) {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

export async function stageVerifiedLocalVideo(
  input: StageVerifiedLocalVideoInput,
): Promise<PublicVideoStage> {
  if (!path.isAbsolute(input.sourcePath)) {
    throw new VideoStageError(400, "SOURCE_PATH_MUST_BE_ABSOLUTE", "master 영상 경로가 절대경로가 아닙니다.");
  }
  const expectedSha256 = input.expectedSha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new VideoStageError(400, "INVALID_SOURCE_SHA256", "master 영상 SHA-256이 올바르지 않습니다.");
  }

  const sourceLstat = await lstat(input.sourcePath);
  if (!sourceLstat.isFile() || sourceLstat.isSymbolicLink()) {
    throw new VideoStageError(400, "SOURCE_NOT_REGULAR_FILE", "master 영상은 일반 파일이어야 합니다.");
  }
  const sourcePath = await realpath(input.sourcePath);
  const before = await stat(sourcePath);
  if (before.size !== input.size) {
    throw new VideoStageError(409, "SOURCE_SIZE_MISMATCH", "master 영상 크기가 handoff와 다릅니다.");
  }

  const stage = await createVideoStage(input);
  const release = await acquireStageLock(stage.uploadId);
  try {
    const state = await readState(stage.uploadId);
    const stagedPath = dataPath(stage.uploadId, state);
    await unlink(stagedPath);
    let materializationMode: "hardlink" | "copy" = "hardlink";
    try {
      await link(sourcePath, stagedPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EXDEV" && code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP") {
        throw error;
      }
      materializationMode = "copy";
      await copyFile(sourcePath, stagedPath);
    }
    const [sourceAfter, staged] = await Promise.all([
      stat(sourcePath),
      stat(dataPath(stage.uploadId, state)),
    ]);
    if (!sameFileVersion(before, sourceAfter)) {
      throw new VideoStageError(409, "SOURCE_CHANGED_DURING_STAGE", "master 영상이 준비 중 변경됐습니다.");
    }
    if (staged.size !== state.size) {
      throw new VideoStageError(409, "STAGE_DATA_MISMATCH", "스테이징된 master 영상 크기가 다릅니다.");
    }
    await writeStateAtomic(stage.uploadId, {
      ...state,
      receivedBytes: staged.size,
      updatedAt: new Date().toISOString(),
      materializationMode,
    });
  } catch (error) {
    await rm(stageDir(stage.uploadId), { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await release();
  }

  const complete = await finalizeVideoStage(stage.uploadId);
  if (complete.sha256 !== expectedSha256) {
    await rm(stageDir(stage.uploadId), { recursive: true, force: true }).catch(() => undefined);
    throw new VideoStageError(409, "SOURCE_SHA256_MISMATCH", "master 영상 SHA-256이 handoff와 다릅니다.");
  }
  return complete;
}

export async function getVideoStageReadSource(uploadId: string) {
  const state = await readState(uploadId);
  if (state.status !== "complete") {
    throw new VideoStageError(409, "STAGE_INCOMPLETE", "영상 스테이징이 아직 완료되지 않았습니다.");
  }
  const filePath = dataPath(uploadId, state);
  const file = await stat(filePath);
  if (!file.isFile() || file.size !== state.size) {
    throw new VideoStageError(409, "STAGE_DATA_MISMATCH", "스테이징 영상이 상태 기록과 다릅니다.");
  }
  const actualSha256 = await sha256Path(filePath);
  if (actualSha256 !== state.sha256) {
    throw new VideoStageError(409, "STAGE_HASH_MISMATCH", "스테이징 영상 SHA-256이 상태 기록과 다릅니다.");
  }
  return {
    filePath,
    size: state.size,
    type: state.type || "application/octet-stream",
    originalName: state.originalName,
    sha256: actualSha256,
    materializationMode: state.materializationMode,
  };
}

export async function appendVideoStageChunk(
  request: Request,
  uploadId: string,
  offset: number,
  declaredLength: number,
) {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new VideoStageError(400, "INVALID_CHUNK_OFFSET", "영상 청크 시작 위치가 올바르지 않습니다.");
  }
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength <= 0 ||
    declaredLength > VIDEO_STAGE_CHUNK_SIZE
  ) {
    throw new VideoStageError(
      400,
      "INVALID_CHUNK_SIZE",
      "영상 청크 크기가 올바르지 않습니다.",
      { maxBytes: VIDEO_STAGE_CHUNK_SIZE },
    );
  }
  if (!request.body) {
    throw new VideoStageError(400, "MISSING_CHUNK_BODY", "영상 청크 본문이 없습니다.");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) !== declaredLength) {
    throw new VideoStageError(
      400,
      "CHUNK_LENGTH_MISMATCH",
      "브라우저가 보낸 영상 청크 크기가 선언값과 다릅니다.",
      { declaredLength, contentLength },
    );
  }

  const release = await acquireStageLock(uploadId);
  try {
    const state = await readState(uploadId);
    if (state.status === "complete") {
      if (offset + declaredLength <= state.receivedBytes) {
        return { stage: publicStage(state), alreadyReceived: true };
      }
      throw new VideoStageError(409, "STAGE_ALREADY_COMPLETE", "영상 스테이징은 이미 완료되었습니다.");
    }

    if (offset < state.receivedBytes && offset + declaredLength <= state.receivedBytes) {
      return { stage: publicStage(state), alreadyReceived: true };
    }
    if (offset !== state.receivedBytes) {
      throw new VideoStageError(
        409,
        "STAGE_OFFSET_MISMATCH",
        "영상 청크 순서가 현재 저장 위치와 다릅니다.",
        { expectedOffset: state.receivedBytes, receivedOffset: offset },
      );
    }
    if (offset + declaredLength > state.size) {
      throw new VideoStageError(
        400,
        "CHUNK_EXCEEDS_VIDEO_SIZE",
        "영상 청크가 선언된 전체 파일 크기를 넘습니다.",
      );
    }

    const filePath = dataPath(uploadId, state);
    const before = await stat(filePath);
    if (before.size > state.receivedBytes) {
      await truncate(filePath, state.receivedBytes);
    } else if (before.size < state.receivedBytes) {
      throw new VideoStageError(
        409,
        "STAGE_DATA_TRUNCATED",
        "저장 중인 영상 파일이 상태 기록보다 짧습니다. 새 요청으로 다시 시작해 주세요.",
      );
    }

    try {
      await pipeline(
        Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(filePath, { flags: "r+", start: offset }),
      );
    } catch (error) {
      await truncate(filePath, offset).catch(() => undefined);
      throw error;
    }

    const after = await stat(filePath);
    if (after.size !== offset + declaredLength) {
      await truncate(filePath, offset).catch(() => undefined);
      throw new VideoStageError(
        400,
        "CHUNK_LENGTH_MISMATCH",
        "실제로 저장된 영상 청크 크기가 선언값과 다릅니다.",
        { expectedSize: offset + declaredLength, savedSize: after.size },
      );
    }

    const next: VideoStageState = {
      ...state,
      receivedBytes: after.size,
      updatedAt: new Date().toISOString(),
    };
    try {
      await writeStateAtomic(uploadId, next);
    } catch (error) {
      await truncate(filePath, offset).catch(() => undefined);
      throw error;
    }
    return { stage: publicStage(next), alreadyReceived: false };
  } finally {
    await release();
  }
}

export async function finalizeVideoStage(uploadId: string): Promise<PublicVideoStage> {
  const release = await acquireStageLock(uploadId);
  try {
    const state = await readState(uploadId);
    if (state.status === "complete") return publicStage(state);

    const file = await stat(dataPath(uploadId, state));
    if (state.receivedBytes !== state.size || file.size !== state.size) {
      throw new VideoStageError(
        409,
        "STAGE_INCOMPLETE",
        "영상 파일이 아직 모두 저장되지 않았습니다.",
        { expectedBytes: state.size, receivedBytes: state.receivedBytes, savedBytes: file.size },
      );
    }

    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(dataPath(uploadId, state));
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    const complete: VideoStageState = {
      ...state,
      status: "complete",
      updatedAt: new Date().toISOString(),
      sha256: hash.digest("hex"),
    };
    await writeStateAtomic(uploadId, complete);
    return publicStage(complete);
  } finally {
    await release();
  }
}

export async function removeVideoStage(uploadId: string) {
  const release = await acquireStageLock(uploadId);
  await release();
  await rm(stageDir(uploadId), { recursive: true, force: true });
}

export async function materializeStagedVideo(
  uploadId: string,
  targetDir: string,
  fallbackName = "video.mp4",
) {
  const state = await readState(uploadId);
  if (state.status !== "complete") {
    throw new VideoStageError(409, "STAGE_INCOMPLETE", "영상 스테이징이 아직 완료되지 않았습니다.");
  }

  const sourcePath = dataPath(uploadId, state);
  const source = await stat(sourcePath);
  if (!source.isFile() || source.size !== state.size) {
    throw new VideoStageError(
      409,
      "STAGE_DATA_MISMATCH",
      "완료된 영상 스테이징 파일의 크기가 상태 기록과 다릅니다.",
    );
  }

  await mkdir(targetDir, { recursive: true });
  const fileName = sanitizeFileName(state.originalName, fallbackName);
  const targetPath = path.join(targetDir, fileName);
  try {
    await link(sourcePath, targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EXDEV" || code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
      await copyFile(sourcePath, targetPath);
    } else {
      throw error;
    }
  }

  const saved = await stat(targetPath);
  if (saved.size !== state.size) {
    await unlink(targetPath).catch(() => undefined);
    throw new VideoStageError(500, "STAGE_MATERIALIZE_FAILED", "요청 폴더의 영상 크기 검증에 실패했습니다.");
  }
  const savedSha256 = await sha256Path(targetPath);
  if (savedSha256 !== state.sha256) {
    await unlink(targetPath).catch(() => undefined);
    throw new VideoStageError(409, "STAGE_HASH_MISMATCH", "요청 영상 SHA-256이 스테이징 잠금과 다릅니다.");
  }

  return {
    fileName,
    originalName: state.originalName,
    path: targetPath,
    size: state.size,
    sha256: state.sha256,
  };
}

async function sha256Path(filePath: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}
