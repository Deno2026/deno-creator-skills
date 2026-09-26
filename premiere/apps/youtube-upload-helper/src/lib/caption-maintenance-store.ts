import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureStorageRoot, getStorageRoot } from "@/lib/youtube-storage";

export type CaptionMaintenanceMode = "replace_or_add" | "add_missing";
export type CaptionMaintenanceStatus =
  | "draft"
  | "running"
  | "done"
  | "partial"
  | "verification_pending"
  | "error";
export type CaptionMaintenanceOperationStatus =
  | "pending"
  | "done"
  | "skipped"
  | "verification_pending"
  | "error";
export type CaptionMaintenanceAction = "request" | "update" | "insert" | "skip";

export type YouTubeCaptionSnapshot = {
  id: string;
  language: string;
  name: string;
  trackKind: string;
  status: string;
  isDraft: boolean;
  lastUpdated?: string;
  failureReason?: string;
};

export type CaptionMaintenanceOperation = {
  id: string;
  language: string;
  label: string;
  fileName: string;
  artifactPath?: string;
  action: CaptionMaintenanceAction;
  status: CaptionMaintenanceOperationStatus;
  existingCaptionId?: string;
  captionId?: string;
  expectedCaptionId?: string;
  expectedLastUpdated?: string;
  submittedSha256?: string;
  lockedSha256?: string;
  verification?: {
    checkedAt: string;
    downloadedArtifactPath?: string;
    strictValidationPassed: boolean;
    comparison: {
      ok: boolean;
      expectedCueCount: number;
      actualCueCount: number;
      differences: Array<{
        cue: number;
        issue: string;
        expected?: string | number;
        actual?: string | number;
      }>;
    };
  };
  error?: string;
};

export type CaptionMaintenanceRunRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  videoId: string;
  videoTitle?: string;
  agentProjectSlug?: string;
  captionRevisionId?: string;
  url: string;
  studioUrl: string;
  mode: CaptionMaintenanceMode;
  status: CaptionMaintenanceStatus;
  operations: CaptionMaintenanceOperation[];
  beforeCaptions: YouTubeCaptionSnapshot[];
  afterCaptions: YouTubeCaptionSnapshot[];
  warnings: string[];
  protectedTracksVerification?: {
    checkedAt: string;
    ok: boolean;
    beforeCount: number;
    afterCount: number;
  };
  error?: string;
};

export type CreateCaptionMaintenanceRunInput = {
  videoId: string;
  videoTitle?: string;
  agentProjectSlug?: string;
  captionRevisionId?: string;
  mode: CaptionMaintenanceMode;
  beforeCaptions: YouTubeCaptionSnapshot[];
  operations: Array<{
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
    .slice(0, 72);
  return sanitized || "captions";
}

function toStoredRelativePath(relativePath: string) {
  const normalized = path.normalize(relativePath);
  if (path.isAbsolute(normalized) || normalized.startsWith("..")) {
    throw new Error(`Unsafe caption maintenance artifact path: ${relativePath}`);
  }
  return normalized.split(path.sep).join("/");
}

export function getCaptionMaintenanceRunsRoot() {
  return path.join(getStorageRoot(), "caption-maintenance-runs");
}

export function getCaptionMaintenanceRunDir(runId: string) {
  return path.join(getCaptionMaintenanceRunsRoot(), sanitizePathPart(runId));
}

export function getCaptionMaintenanceRunManifestPath(runId: string) {
  return path.join(getCaptionMaintenanceRunDir(runId), "manifest.json");
}

export function resolveCaptionMaintenanceArtifactPath(runId: string, artifactPath: string) {
  const stored = toStoredRelativePath(artifactPath);
  return path.join(getCaptionMaintenanceRunDir(runId), ...stored.split("/"));
}

export async function createCaptionMaintenanceRun(
  input: CreateCaptionMaintenanceRunInput,
): Promise<CaptionMaintenanceRunRecord> {
  await ensureStorageRoot();
  await mkdir(getCaptionMaintenanceRunsRoot(), { recursive: true });

  const now = new Date().toISOString();
  const datePart = now.slice(0, 19).replace(/[-:T]/g, "");
  const id = `${datePart}-${sanitizePathPart(input.videoTitle || input.videoId)}`;
  const record: CaptionMaintenanceRunRecord = {
    id,
    createdAt: now,
    updatedAt: now,
    videoId: input.videoId,
    videoTitle: input.videoTitle,
    agentProjectSlug: input.agentProjectSlug,
    captionRevisionId: input.captionRevisionId,
    url: `https://www.youtube.com/watch?v=${input.videoId}`,
    studioUrl: `https://studio.youtube.com/video/${input.videoId}/translations`,
    mode: input.mode,
    status: "draft",
    operations: input.operations.map((operation) => ({
      ...operation,
      action: "skip",
      status: "pending",
    })),
    beforeCaptions: input.beforeCaptions,
    afterCaptions: [],
    warnings: [],
  };

  await saveCaptionMaintenanceRun(record);
  return record;
}

export async function saveCaptionMaintenanceRun(record: CaptionMaintenanceRunRecord) {
  await mkdir(getCaptionMaintenanceRunDir(record.id), { recursive: true });
  await writeFile(
    getCaptionMaintenanceRunManifestPath(record.id),
    JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
}

export async function loadCaptionMaintenanceRun(
  runId: string,
): Promise<CaptionMaintenanceRunRecord | null> {
  try {
    const raw = await readFile(getCaptionMaintenanceRunManifestPath(runId), "utf8");
    return JSON.parse(raw) as CaptionMaintenanceRunRecord;
  } catch {
    return null;
  }
}

export async function updateCaptionMaintenanceRun(
  runId: string,
  updater: (record: CaptionMaintenanceRunRecord) => CaptionMaintenanceRunRecord,
) {
  const current = await loadCaptionMaintenanceRun(runId);
  if (!current) {
    throw new Error(`Caption maintenance run not found: ${runId}`);
  }

  const next = updater({ ...current, updatedAt: new Date().toISOString() });
  await saveCaptionMaintenanceRun(next);
  return next;
}

export async function copyCaptionMaintenanceArtifact(
  runId: string,
  sourcePath: string,
  relativePath: string,
) {
  const storedPath = toStoredRelativePath(relativePath);
  const target = resolveCaptionMaintenanceArtifactPath(runId, storedPath);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(sourcePath, target);
  return storedPath;
}

export async function listCaptionMaintenanceRuns(limit = 20) {
  try {
    const entries = await readdir(getCaptionMaintenanceRunsRoot(), { withFileTypes: true });
    const records: CaptionMaintenanceRunRecord[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const record = await loadCaptionMaintenanceRun(entry.name);
      if (record) records.push(record);
    }

    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return records.slice(0, limit);
  } catch {
    return [];
  }
}
