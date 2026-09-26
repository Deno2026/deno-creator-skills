import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureStorageRoot, getStorageRoot } from "@/lib/youtube-storage";

export type UploadRunStatus = "draft" | "uploading" | "done" | "partial" | "error";
export type UploadRunStepStatus = "pending" | "running" | "done" | "partial" | "error" | "skipped";
export type UploadRunStepKey = "video" | "thumbnail" | "captions" | "playlist";

export type UploadRunStep = {
  key: UploadRunStepKey;
  label: string;
  status: UploadRunStepStatus;
  error?: string;
};

export type UploadRunCaption = {
  id: string;
  language: string;
  label: string;
  fileName: string;
  status: UploadRunStepStatus;
  artifactPath?: string;
  error?: string;
};

export type UploadRunArtifact = {
  status: UploadRunStepStatus;
  fileName?: string;
  artifactPath?: string;
  error?: string;
};

export type UploadRunRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: UploadRunStatus;
  title: string;
  videoFileName: string;
  videoSize: number;
  videoId?: string;
  url?: string;
  studioUrl?: string;
  requestedPrivacyStatus: string;
  effectivePrivacyStatus?: string;
  publishAt?: string;
  playlistId?: string;
  localizations: string[];
  thumbnail: UploadRunArtifact;
  captions: UploadRunCaption[];
  playlist: UploadRunArtifact;
  steps: UploadRunStep[];
  warnings: string[];
  error?: string;
};

export type CreateUploadRunInput = {
  title: string;
  videoFileName: string;
  videoSize: number;
  requestedPrivacyStatus: string;
  publishAt?: string;
  playlistId?: string;
  localizations: string[];
  thumbnailFileName?: string;
  captions: Array<{
    id: string;
    language: string;
    label: string;
    fileName: string;
  }>;
};

function sanitizePathPart(value: string) {
  const sanitized = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return sanitized || "upload";
}

function toStoredRelativePath(relativePath: string) {
  const normalized = path.normalize(relativePath);
  if (path.isAbsolute(normalized) || normalized.startsWith("..")) {
    throw new Error(`Unsafe upload run artifact path: ${relativePath}`);
  }
  return normalized.split(path.sep).join("/");
}

export function getUploadRunsRoot() {
  return path.join(getStorageRoot(), "runs");
}

export function getUploadRunDir(runId: string) {
  return path.join(getUploadRunsRoot(), sanitizePathPart(runId));
}

export function getUploadRunManifestPath(runId: string) {
  return path.join(getUploadRunDir(runId), "manifest.json");
}

export function resolveUploadRunArtifactPath(runId: string, artifactPath: string) {
  const stored = toStoredRelativePath(artifactPath);
  return path.join(getUploadRunDir(runId), ...stored.split("/"));
}

function buildDefaultSteps(input: CreateUploadRunInput): UploadRunStep[] {
  return [
    { key: "video", label: "영상 업로드", status: "pending" },
    {
      key: "thumbnail",
      label: "썸네일 적용",
      status: input.thumbnailFileName ? "pending" : "skipped",
    },
    {
      key: "captions",
      label: "자막 붙이기",
      status: input.captions.length > 0 ? "pending" : "skipped",
    },
    {
      key: "playlist",
      label: "재생목록 추가",
      status: input.playlistId ? "pending" : "skipped",
    },
  ];
}

export async function createUploadRun(input: CreateUploadRunInput): Promise<UploadRunRecord> {
  await ensureStorageRoot();
  await mkdir(getUploadRunsRoot(), { recursive: true });

  const now = new Date().toISOString();
  const datePart = now.slice(0, 19).replace(/[-:T]/g, "");
  const id = `${datePart}-${sanitizePathPart(input.title || input.videoFileName)}`;
  const record: UploadRunRecord = {
    id,
    createdAt: now,
    updatedAt: now,
    status: "draft",
    title: input.title,
    videoFileName: input.videoFileName,
    videoSize: input.videoSize,
    requestedPrivacyStatus: input.requestedPrivacyStatus,
    publishAt: input.publishAt,
    playlistId: input.playlistId,
    localizations: input.localizations,
    thumbnail: input.thumbnailFileName
      ? { status: "pending", fileName: input.thumbnailFileName }
      : { status: "skipped" },
    captions: input.captions.map((caption) => ({
      ...caption,
      status: "pending",
    })),
    playlist: input.playlistId ? { status: "pending" } : { status: "skipped" },
    steps: buildDefaultSteps(input),
    warnings: [],
  };

  await saveUploadRun(record);
  return record;
}

export async function saveUploadRun(record: UploadRunRecord) {
  await mkdir(getUploadRunDir(record.id), { recursive: true });
  await writeFile(
    getUploadRunManifestPath(record.id),
    JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
}

export async function loadUploadRun(runId: string): Promise<UploadRunRecord | null> {
  try {
    const raw = await readFile(getUploadRunManifestPath(runId), "utf8");
    return JSON.parse(raw) as UploadRunRecord;
  } catch {
    return null;
  }
}

export async function updateUploadRun(
  runId: string,
  updater: (record: UploadRunRecord) => UploadRunRecord,
) {
  const current = await loadUploadRun(runId);
  if (!current) {
    throw new Error(`Upload run not found: ${runId}`);
  }

  const next = updater({ ...current, updatedAt: new Date().toISOString() });
  await saveUploadRun(next);
  return next;
}

export async function listUploadRuns(limit = 10): Promise<UploadRunRecord[]> {
  try {
    const entries = await readdir(getUploadRunsRoot(), { withFileTypes: true });
    const records: UploadRunRecord[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const record = await loadUploadRun(entry.name);
      if (record) records.push(record);
    }

    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return records.slice(0, limit);
  } catch {
    return [];
  }
}

export async function writeUploadRunTextArtifact(
  runId: string,
  relativePath: string,
  content: string,
) {
  const storedPath = toStoredRelativePath(relativePath);
  const target = resolveUploadRunArtifactPath(runId, storedPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return storedPath;
}

export async function copyUploadRunArtifact(
  runId: string,
  sourcePath: string,
  relativePath: string,
) {
  const storedPath = toStoredRelativePath(relativePath);
  const target = resolveUploadRunArtifactPath(runId, storedPath);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(sourcePath, target);
  return storedPath;
}

export async function getUploadRunArtifactSize(
  runId: string,
  artifactPath: string | undefined,
) {
  if (!artifactPath) return 0;
  try {
    const info = await stat(resolveUploadRunArtifactPath(runId, artifactPath));
    return info.size;
  } catch {
    return 0;
  }
}

export function updateRunStep(
  record: UploadRunRecord,
  key: UploadRunStepKey,
  status: UploadRunStepStatus,
  error?: string,
): UploadRunRecord {
  return {
    ...record,
    steps: record.steps.map((step) =>
      step.key === key ? { ...step, status, error } : step,
    ),
  };
}
