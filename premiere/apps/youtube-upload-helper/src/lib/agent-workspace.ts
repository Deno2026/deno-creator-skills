import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  findProductionRoot,
  getProductionPaths,
  requireSafeSlug,
} from "@deno/runtime-paths";

import {
  DENO_DEFAULT_METADATA_LANGUAGES,
  DENO_METADATA_LANGUAGE_OPTIONS,
  type DenoMetadataLanguageCode,
  type DenoMetadataLanguageOption,
} from "@/lib/language-pack";
import { stripInferredSubtitleGuide } from "@/lib/description-policy";

export type AgentLanguageCode = DenoMetadataLanguageCode;

export type AgentLanguageOption = DenoMetadataLanguageOption;

export const AGENT_LANGUAGE_OPTIONS: AgentLanguageOption[] = DENO_METADATA_LANGUAGE_OPTIONS;

export const DEFAULT_AGENT_LANGUAGES: AgentLanguageCode[] = DENO_DEFAULT_METADATA_LANGUAGES;

export type AgentArtifactStatus = "ready" | "missing" | "partial";

export type AgentLanguageState = AgentLanguageOption & {
  selected: boolean;
};

export type AgentProjectFileState = {
  status: AgentArtifactStatus;
  path?: string;
  count?: number;
  reason?: string;
};

export type AgentCampaignMetadata = {
  name?: string;
  submissionDeadline?: string;
  trackingLink?: string;
  noAffiliateLinks?: boolean;
  brandApprovalRequired?: boolean;
  descriptionChecklist: string[];
  manualChecklist: string[];
  pinnedCommentDraft?: string;
};

export type AgentUploadMetadata = {
  title?: string;
  description?: string;
  allowSubtitleGuide?: boolean;
  categoryId?: string;
  defaultAudioLanguage?: string;
  containsSyntheticMedia?: boolean;
  tags: string[];
  titleCandidates?: string[];
  descriptionCandidates?: string[];
  chapterCandidates?: string[];
  campaign?: AgentCampaignMetadata;
  sourcePath?: string;
};

export type AgentProject = {
  slug: string;
  displayName: string;
  stage: string;
  contentKind: "longform" | "cinematic" | "shorts";
  updatedAt?: string;
  selectedLanguages: AgentLanguageCode[];
  paths: {
    projectState: string;
    srtDir: string;
    metadataDir: string;
    uploadReadyDir: string;
  };
  files: {
    koreanUpload: AgentProjectFileState;
    koreanClean: AgentProjectFileState;
    reviewedEnglish: AgentProjectFileState;
    captionSourceLock: AgentProjectFileState;
    metadata: AgentProjectFileState;
    uploadManifest: AgentProjectFileState;
  };
  metadata: AgentUploadMetadata | null;
  languages: AgentLanguageState[];
  nextAction: string;
};

type StoredAgentProject = {
  slug?: string;
  stage?: string;
  contentKind?: string;
  selectedLanguages?: string[];
  updatedAt?: string;
  captionSource?: {
    authority?: string;
    revisionId?: string;
    finalKoreanPath?: string;
    cleanKoreanPath?: string;
    reviewedEnglishPath?: string;
    lockPath?: string;
    reviewReportPath?: string;
    sha256?: {
      finalKorean?: string;
      cleanKorean?: string;
      reviewedEnglish?: string;
    };
    reviewReportSha256?: string;
    verified?: boolean;
  };
};

type CaptionSourceLockFile = {
  path?: string;
  sha256?: string;
};

type CaptionSourceLock = {
  schema_version?: number;
  authority?: string;
  slug?: string;
  revision_id?: string;
  ok?: boolean;
  files?: {
    final_korean?: CaptionSourceLockFile;
    clean_korean?: CaptionSourceLockFile;
    reviewed_english?: CaptionSourceLockFile;
  };
  english_review?: CaptionSourceLockFile & { status?: string };
};

export type CanonicalCaptionArtifact = {
  path: string;
  storedPath: string;
  sha256: string;
};

export type CanonicalCaptionAuthority = {
  schemaVersion: 2;
  authority: "latest_user_designated_final_korean_srt";
  slug: string;
  revisionId: string;
  lock: CanonicalCaptionArtifact;
  finalKorean: CanonicalCaptionArtifact;
  cleanKorean: CanonicalCaptionArtifact;
  reviewedEnglish: CanonicalCaptionArtifact;
  englishReview: CanonicalCaptionArtifact & { status: "PASS" };
};

export type CanonicalCaptionAuthorityResult =
  | { valid: true; value: CanonicalCaptionAuthority }
  | { valid: false; lockPath: string; reason: string };

type LoadedCaptionSourceLock = CanonicalCaptionAuthorityResult;

const CAPTION_AUTHORITY = "latest_user_designated_final_korean_srt" as const;
const SAFE_PROJECT_SLUG = /^[a-zA-Z0-9._-]{1,180}$/;

function invalidCaptionAuthority(lockPath: string, reason: string): CanonicalCaptionAuthorityResult {
  return { valid: false, lockPath, reason };
};

function getHqRoot() {
  return findProductionRoot();
}

function getProjectsRoot() {
  return path.join(getHqRoot(), "productions");
}

function getProjectStatePath(slug: string) {
  return getProductionPaths(slug).helperProjectPath;
}

export async function getActiveAgentProjectSlug() {
  const slug = process.env.DENO_ACTIVE_PRODUCTION_SLUG?.trim() ?? "";
  if (!slug || !SAFE_PROJECT_SLUG.test(slug) || path.basename(slug) !== slug) return null;
  return slug;
}

function toStoredPath(filePath: string | undefined) {
  if (!filePath) return undefined;
  return path.relative(getHqRoot(), filePath).split(path.sep).join("/");
}

function fromStoredPath(filePath: string | undefined) {
  if (!filePath?.trim()) return undefined;

  const root = path.resolve(getHqRoot());
  const candidate = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(root, filePath);
  const relative = path.relative(root, candidate);

  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return candidate;
}

function pathIsInside(filePath: string, expectedRoot: string) {
  const relative = path.relative(path.resolve(expectedRoot), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeSelectedLanguages(value: string[] | undefined) {
  void value;
  return [...DEFAULT_AGENT_LANGUAGES];
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath: string) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function samePath(left: string | undefined, right: string) {
  return Boolean(left) && path.relative(path.resolve(left!), path.resolve(right)) === "";
}

async function loadCaptionSourceLock(
  lockPath: string,
  slug: string,
  expectedRevisionId: string | undefined,
): Promise<LoadedCaptionSourceLock> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as CaptionSourceLock;
    if (
      parsed.schema_version !== 2 ||
      parsed.authority !== CAPTION_AUTHORITY ||
      parsed.slug !== slug ||
      !/^caption-[a-f0-9]{24}$/i.test(parsed.revision_id ?? "") ||
      parsed.revision_id !== expectedRevisionId ||
      parsed.english_review?.status !== "PASS" ||
      parsed.ok !== true
    ) {
      return invalidCaptionAuthority(lockPath, "caption source lock 헤더가 유효하지 않습니다.");
    }

    const lockedFiles = parsed.files;
    const finalKoreanPath = fromStoredPath(lockedFiles?.final_korean?.path);
    const cleanKoreanPath = fromStoredPath(lockedFiles?.clean_korean?.path);
    const reviewedEnglishPath = fromStoredPath(lockedFiles?.reviewed_english?.path);
    const reviewReportPath = fromStoredPath(parsed.english_review?.path);
    const captionPaths = getProductionPaths(slug);
    const finalKoreanRoot = captionPaths.captionsDir;
    const subtitleRoot = captionPaths.captionsDir;
    const required = [
      ["final Korean", finalKoreanPath, lockedFiles?.final_korean?.sha256, finalKoreanRoot],
      ["clean Korean", cleanKoreanPath, lockedFiles?.clean_korean?.sha256, subtitleRoot],
      ["reviewed English", reviewedEnglishPath, lockedFiles?.reviewed_english?.sha256, subtitleRoot],
      ["English review", reviewReportPath, parsed.english_review?.sha256, subtitleRoot],
    ] as const;

    for (const [label, filePath, expectedSha256, expectedRoot] of required) {
      if (!filePath || !/^[a-f0-9]{64}$/i.test(expectedSha256 ?? "")) {
        return invalidCaptionAuthority(lockPath, `${label} 잠금 정보가 없습니다.`);
      }
      if (!pathIsInside(filePath, expectedRoot)) {
        return invalidCaptionAuthority(lockPath, `${label} 경로가 현재 slug 밖을 가리킵니다.`);
      }
      if (!(await pathExists(filePath))) {
        return invalidCaptionAuthority(lockPath, `${label} 잠금 파일을 찾을 수 없습니다.`);
      }
      if ((await sha256File(filePath)) !== expectedSha256) {
        return invalidCaptionAuthority(lockPath, `${label} SHA-256이 잠금과 다릅니다.`);
      }
    }

    return {
      valid: true,
      value: {
        schemaVersion: 2,
        authority: CAPTION_AUTHORITY,
        slug,
        revisionId: parsed.revision_id!,
        lock: {
          path: lockPath,
          storedPath: toStoredPath(lockPath)!,
          sha256: await sha256File(lockPath),
        },
        finalKorean: {
          path: finalKoreanPath!,
          storedPath: toStoredPath(finalKoreanPath)!,
          sha256: lockedFiles!.final_korean!.sha256!.toLowerCase(),
        },
        cleanKorean: {
          path: cleanKoreanPath!,
          storedPath: toStoredPath(cleanKoreanPath)!,
          sha256: lockedFiles!.clean_korean!.sha256!.toLowerCase(),
        },
        reviewedEnglish: {
          path: reviewedEnglishPath!,
          storedPath: toStoredPath(reviewedEnglishPath)!,
          sha256: lockedFiles!.reviewed_english!.sha256!.toLowerCase(),
        },
        englishReview: {
          path: reviewReportPath!,
          storedPath: toStoredPath(reviewReportPath)!,
          sha256: parsed.english_review!.sha256!.toLowerCase(),
          status: "PASS",
        },
      },
    };
  } catch {
    return invalidCaptionAuthority(lockPath, "caption source lock을 읽지 못했습니다.");
  }
}

export async function loadCanonicalCaptionAuthority(
  slug: string,
): Promise<CanonicalCaptionAuthorityResult> {
  const safeSlug = slug.trim();
  let lockPath = path.join(getProjectsRoot(), safeSlug, "captions", "caption-source-lock.json");
  if (!SAFE_PROJECT_SLUG.test(safeSlug) || path.basename(safeSlug) !== safeSlug) {
    return invalidCaptionAuthority(lockPath, "agent project slug가 유효하지 않습니다.");
  }
  lockPath = getProductionPaths(safeSlug).captionSourceLockPath;

  const stored = await readStoredProject(safeSlug);
  const captionSource = stored.captionSource;
  if (
    stored.slug !== safeSlug ||
    captionSource?.authority !== CAPTION_AUTHORITY ||
    captionSource.verified !== true ||
    !/^caption-[a-f0-9]{24}$/i.test(captionSource.revisionId ?? "")
  ) {
    return invalidCaptionAuthority(
      lockPath,
      "video_project.json의 current caption revision 포인터가 유효하지 않습니다.",
    );
  }

  if (!(await pathExists(lockPath))) {
    return invalidCaptionAuthority(lockPath, "caption_source_lock.json이 없습니다.");
  }

  const loaded = await loadCaptionSourceLock(lockPath, safeSlug, captionSource.revisionId);
  if (!loaded.valid) return loaded;

  const pointerChecks = [
    [captionSource.lockPath, loaded.value.lock],
    [captionSource.finalKoreanPath, loaded.value.finalKorean],
    [captionSource.cleanKoreanPath, loaded.value.cleanKorean],
    [captionSource.reviewedEnglishPath, loaded.value.reviewedEnglish],
    [captionSource.reviewReportPath, loaded.value.englishReview],
  ] as const;
  for (const [storedPath, artifact] of pointerChecks) {
    const resolved = fromStoredPath(storedPath);
    if (!samePath(resolved, artifact.path)) {
      return invalidCaptionAuthority(
        lockPath,
        "video_project.json의 caption artifact 포인터가 current lock과 다릅니다.",
      );
    }
  }

  const pointerShas = captionSource.sha256;
  if (
    pointerShas?.finalKorean?.toLowerCase() !== loaded.value.finalKorean.sha256 ||
    pointerShas?.cleanKorean?.toLowerCase() !== loaded.value.cleanKorean.sha256 ||
    pointerShas?.reviewedEnglish?.toLowerCase() !== loaded.value.reviewedEnglish.sha256 ||
    captionSource.reviewReportSha256?.toLowerCase() !== loaded.value.englishReview.sha256
  ) {
    return invalidCaptionAuthority(
      lockPath,
      "video_project.json의 caption SHA-256 evidence가 current lock과 다릅니다.",
    );
  }

  return loaded;
}

async function listFiles(dirPath: string) {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(dirPath, entry.name));
  } catch {
    return [];
  }
}

async function listDirectories(dirPath: string) {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function countSrtCues(filePath: string | undefined) {
  if (!filePath) return undefined;
  try {
    const raw = await readFile(filePath, "utf8");
    return (raw.match(/^\d+\s*$/gm) ?? []).length;
  } catch {
    return undefined;
  }
}

async function pickNewestByName(files: string[], patterns: RegExp[]) {
  const matches = files.filter((filePath) => {
    const name = path.basename(filePath);
    return patterns.some((pattern) => pattern.test(name));
  });

  const candidates = await Promise.all(
    matches.map(async (filePath) => {
      const info = await stat(filePath).catch(() => null);
      return { filePath, mtimeMs: info?.mtimeMs ?? 0 };
    }),
  );

  return candidates.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || b.filePath.localeCompare(a.filePath),
  )[0]?.filePath;
}

function scoreMetadataFile(filePath: string) {
  const name = path.basename(filePath).toLowerCase();
  let score = 0;
  if (name.includes("final")) score += 50;
  if (name.includes("_ko")) score += 30;
  if (name.includes("pack")) score += 20;
  if (name.includes("metadata")) score += 10;
  if (name.includes("multilang")) score -= 80;
  return score;
}

function pickBestMetadataFile(files: string[]) {
  const candidates = files.filter((filePath) => {
    const name = path.basename(filePath).toLowerCase();
    return (
      (name.includes("metadata") || name.includes("youtube")) &&
      (name.endsWith(".md") || name.endsWith(".json"))
    );
  });

  return candidates.sort((a, b) => scoreMetadataFile(b) - scoreMetadataFile(a))[0];
}

function stripFence(value: string) {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```[a-zA-Z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n```$/);
  if (fenced) return fenced[1].trim();

  const firstFence = trimmed.match(/```[a-zA-Z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n```/);
  return (firstFence ? firstFence[1] : trimmed).trim();
}

function extractMarkdownSection(raw: string, headings: string[]) {
  const lines = raw.split(/\r?\n/);
  const headingSet = new Set(headings.map((heading) => heading.toLowerCase()));

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{2,4})\s+(.+?)\s*$/);
    if (!match) continue;

    const currentDepth = match[1].length;
    const label = match[2].trim().toLowerCase();
    if (!headingSet.has(label)) continue;

    const section: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const nextHeading = lines[cursor].match(/^(#{1,4})\s+(.+?)\s*$/);
      if (nextHeading && nextHeading[1].length <= currentDepth) break;
      section.push(lines[cursor]);
    }
    return stripFence(section.join("\n"));
  }

  return undefined;
}

function firstMeaningfulLine(value: string | undefined) {
  if (!value) return undefined;
  return stripFence(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("- ") && !line.startsWith("#"));
}

function splitTags(value: string | undefined) {
  if (!value) return [];
  return stripFence(value)
    .split(/,|\r?\n/)
    .map((tag) => tag.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

function splitStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function optionalTrimmedString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function campaignFromJson(value: unknown): AgentCampaignMetadata | undefined {
  if (typeof value !== "object" || !value || Array.isArray(value)) return undefined;

  const campaign = value as Record<string, unknown>;
  const name = optionalTrimmedString(campaign.name);
  const submissionDeadline = optionalTrimmedString(campaign.submissionDeadline);
  const trackingLink = optionalTrimmedString(campaign.trackingLink);
  const noAffiliateLinks = campaign.noAffiliateLinks === true;
  const brandApprovalRequired = campaign.brandApprovalRequired === true;
  const descriptionChecklist = splitStringArray(campaign.descriptionChecklist).map((item) =>
    item.trim(),
  );
  const manualChecklist = splitStringArray(campaign.manualChecklist).map((item) => item.trim());
  const pinnedCommentDraft = optionalTrimmedString(campaign.pinnedCommentDraft);

  if (
    !name &&
    !submissionDeadline &&
    !trackingLink &&
    !noAffiliateLinks &&
    !brandApprovalRequired &&
    descriptionChecklist.length === 0 &&
    manualChecklist.length === 0 &&
    !pinnedCommentDraft
  ) {
    return undefined;
  }

  return {
    name,
    submissionDeadline,
    trackingLink,
    noAffiliateLinks,
    brandApprovalRequired,
    descriptionChecklist,
    manualChecklist,
    pinnedCommentDraft,
  };
}

function metadataFromJson(raw: string): Omit<AgentUploadMetadata, "sourcePath"> | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const metadata =
      typeof parsed.metadata === "object" && parsed.metadata
        ? (parsed.metadata as Record<string, unknown>)
        : parsed;

    const title =
      typeof metadata.title === "string"
        ? metadata.title
        : typeof metadata.koreanTitle === "string"
          ? metadata.koreanTitle
          : undefined;
    const rawDescription =
      typeof metadata.description === "string"
        ? metadata.description
        : typeof metadata.koreanDescription === "string"
          ? metadata.koreanDescription
          : undefined;
    const allowSubtitleGuide = metadata.allowSubtitleGuide === true;
    const categoryId = optionalTrimmedString(metadata.categoryId);
    const defaultAudioLanguage = optionalTrimmedString(metadata.defaultAudioLanguage);
    const containsSyntheticMedia =
      typeof metadata.containsSyntheticMedia === "boolean"
        ? metadata.containsSyntheticMedia
        : undefined;
    const description = rawDescription
      ? allowSubtitleGuide
        ? rawDescription
        : stripInferredSubtitleGuide(rawDescription)
      : undefined;
    const tagsValue = metadata.tags ?? metadata.koreanTags;
    const tags = Array.isArray(tagsValue)
      ? tagsValue.filter((tag): tag is string => typeof tag === "string")
      : typeof tagsValue === "string"
        ? splitTags(tagsValue)
        : [];
    const titleCandidates = splitStringArray(metadata.titleCandidates);
    const descriptionCandidates = splitStringArray(metadata.descriptionCandidates)
      .map((candidate) =>
        allowSubtitleGuide ? candidate : stripInferredSubtitleGuide(candidate),
      )
      .filter(Boolean);
    const chapterCandidates = splitStringArray(metadata.chapterCandidates);
    const campaign = campaignFromJson(metadata.campaign);

    if (
      !title &&
      !description &&
      !categoryId &&
      !defaultAudioLanguage &&
      containsSyntheticMedia === undefined &&
      tags.length === 0 &&
      titleCandidates.length === 0 &&
      descriptionCandidates.length === 0 &&
      chapterCandidates.length === 0 &&
      !campaign
    ) {
      return null;
    }
    return {
      title,
      description,
      allowSubtitleGuide,
      categoryId,
      defaultAudioLanguage,
      containsSyntheticMedia,
      tags,
      titleCandidates,
      descriptionCandidates,
      chapterCandidates,
      campaign,
    };
  } catch {
    return null;
  }
}

function metadataFromMarkdown(raw: string): Omit<AgentUploadMetadata, "sourcePath"> | null {
  const title =
    firstMeaningfulLine(
      extractMarkdownSection(raw, ["최종 제목", "사용자 최종 제목", "제목"]),
    ) ??
    firstMeaningfulLine(extractMarkdownSection(raw, ["제목 후보"]));
  const rawDescription = extractMarkdownSection(raw, [
    "최종 설명란",
    "설명란 (복붙용)",
    "설명란",
    "설명",
  ]);
  const description = rawDescription
    ? stripInferredSubtitleGuide(rawDescription)
    : undefined;
  const tags = splitTags(extractMarkdownSection(raw, ["추천 태그", "태그"]));

  if (!title && !description && tags.length === 0) return null;
  return { title, description, tags };
}

async function readUploadMetadata(filePath: string | undefined): Promise<AgentUploadMetadata | null> {
  if (!filePath) return null;

  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = filePath.toLowerCase().endsWith(".json")
      ? metadataFromJson(raw)
      : metadataFromMarkdown(raw);
    if (!parsed) return null;

    return {
      ...parsed,
      tags: parsed.tags ?? [],
      sourcePath: toStoredPath(filePath),
    };
  } catch {
    return null;
  }
}

async function readPublishingHandoffMetadata(
  handoffPath: string,
  slug: string,
): Promise<AgentUploadMetadata | null> {
  try {
    const handoff = JSON.parse(await readFile(handoffPath, "utf8")) as {
      schemaVersion?: unknown;
      production?: unknown;
      metadata?: null | { path?: unknown; sha256?: unknown };
      readyForHelper?: unknown;
    };
    if (
      handoff.schemaVersion !== 1 ||
      handoff.production !== slug ||
      handoff.readyForHelper !== true ||
      typeof handoff.metadata?.path !== "string"
    ) {
      return null;
    }
    const metadataPath = fromStoredPath(handoff.metadata.path);
    if (
      !metadataPath ||
      !pathIsInside(metadataPath, getProductionPaths(slug).publishingDir) ||
      typeof handoff.metadata.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(handoff.metadata.sha256) ||
      (await sha256File(metadataPath)).toLowerCase() !== handoff.metadata.sha256.toLowerCase()
    ) {
      return null;
    }
    return readUploadMetadata(metadataPath);
  } catch {
    return null;
  }
}

function humanizeSlug(slug: string) {
  return slug
    .replace(/_\d{4}-\d{2}-\d{2}.*$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

async function readStoredProject(slug: string): Promise<StoredAgentProject> {
  try {
    const raw = await readFile(getProjectStatePath(slug), "utf8");
    return JSON.parse(raw) as StoredAgentProject;
  } catch {
    return {};
  }
}

async function inferProjectUpdatedAt(slug: string) {
  const productionPaths = getProductionPaths(slug);
  const candidates = [
    productionPaths.captionsDir,
    productionPaths.deliveryDir,
    productionPaths.publishingDir,
    getProjectStatePath(slug),
  ];

  let latest = 0;
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      latest = Math.max(latest, info.mtimeMs);
    } catch {
      // Missing folders are normal while a project is still being prepared.
    }
  }

  return latest > 0 ? new Date(latest).toISOString() : undefined;
}

export async function listAgentProjects() {
  const roots = [getProjectsRoot()];
  const slugs = new Set<string>();

  for (const root of roots) {
    for (const slug of await listDirectories(root)) {
      if (!slug.startsWith("_") && slug !== "studio-uploader-ui") {
        slugs.add(slug);
      }
    }
  }

  const projects = await Promise.all(
    Array.from(slugs).map(async (slug) => {
      const stored = await readStoredProject(slug);
      const updatedAt = stored.updatedAt ?? (await inferProjectUpdatedAt(slug));
      const metadataDir = getProductionPaths(slug).publishingDir;
      const metadata = await readUploadMetadata(
        pickBestMetadataFile(await listFiles(metadataDir)),
      );
      return {
        slug,
        displayName: metadata?.title ?? humanizeSlug(slug),
        updatedAt,
        stage: stored.stage ?? "agent_workspace",
      };
    }),
  );

  return projects.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export async function loadAgentProject(slug: string): Promise<AgentProject> {
  const safeSlug = requireSafeSlug(slug);
  const stored = await readStoredProject(safeSlug);
  const selectedLanguages = normalizeSelectedLanguages(stored.selectedLanguages);

  const productionPaths = getProductionPaths(safeSlug);
  const srtDir = productionPaths.captionsDir;
  const metadataDir = productionPaths.publishingDir;
  const uploadReadyDir = productionPaths.captionsDir;
  const projectState = getProjectStatePath(safeSlug);

  const uploadReadyFiles = await listFiles(uploadReadyDir);
  const metadataFiles = await listFiles(metadataDir);
  const srtFiles = await listFiles(srtDir);

  const captionSourceLockPath = productionPaths.captionSourceLockPath;
  const captionSourceLockExists = await pathExists(captionSourceLockPath);
  const captionSourceLock = await loadCanonicalCaptionAuthority(safeSlug);
  const fallbackKoreanUpload = (await pathExists(productionPaths.finalKoreanPath))
    ? productionPaths.finalKoreanPath
    : await pickNewestByName(uploadReadyFiles, [
        /final[-_. ]?ko.*\.srt$/i,
        /Korean.*ko.*\.srt$/i,
        /ko.*Korean.*\.srt$/i,
      ]);
  const fallbackKoreanClean = (await pathExists(productionPaths.cleanKoreanPath))
    ? productionPaths.cleanKoreanPath
    : await pickNewestByName([...uploadReadyFiles, ...srtFiles], [
        /clean[-_. ]?ko.*\.srt$/i,
        /korean.*clean.*\.srt$/i,
        /clean.*korean.*\.srt$/i,
      ]);
  const metadataPath = pickBestMetadataFile(metadataFiles);
  const uploadManifestPath = productionPaths.publishingHandoffPath;
  const manifestMetadata = (await pathExists(uploadManifestPath))
    ? await readPublishingHandoffMetadata(uploadManifestPath, safeSlug)
    : null;
  const fileMetadata = await readUploadMetadata(metadataPath);
  const metadata = manifestMetadata ?? fileMetadata;

  const languageStates: AgentLanguageState[] = AGENT_LANGUAGE_OPTIONS.map((language) => ({
    ...language,
    selected: selectedLanguages.includes(language.code),
  }));

  const requiresCanonicalCaptionAuthority = Boolean(stored.captionSource?.revisionId);
  const koreanPath = captionSourceLock.valid
    ? captionSourceLock.value.cleanKorean.path
    : captionSourceLockExists || requiresCanonicalCaptionAuthority
      ? undefined
      : fallbackKoreanUpload;
  const koreanClean = captionSourceLock.valid
    ? captionSourceLock.value.cleanKorean.path
    : captionSourceLockExists || requiresCanonicalCaptionAuthority
      ? undefined
      : fallbackKoreanClean;
  const reviewedEnglish = captionSourceLock.valid
    ? captionSourceLock.value.reviewedEnglish.path
    : undefined;
  const hasMetadata = Boolean(metadata);
  const hasUploadManifest = await pathExists(uploadManifestPath);

  const nextAction =
    (captionSourceLockExists || requiresCanonicalCaptionAuthority) && !captionSourceLock.valid
      ? `caption source lock 검증 실패: ${captionSourceLock.reason ?? "원인을 확인해 주세요."}`
      : !koreanPath
      ? "captions/final-ko.srt를 준비해야 합니다."
      : !captionSourceLock.valid
        ? "final KO, clean KO, reviewed EN의 caption-source-lock.json을 만들어야 합니다."
      : !hasMetadata
        ? "한국어 최종 제목/설명/챕터 메타데이터를 준비해야 합니다."
        : "업로드 전 영상 파일과 썸네일, 공개 설정을 확인하면 됩니다.";

  return {
    slug: safeSlug,
    displayName: metadata?.title ?? humanizeSlug(safeSlug),
    stage: stored.stage ?? "agent_workspace",
    contentKind:
      stored.contentKind === "cinematic" || stored.contentKind === "shorts"
        ? stored.contentKind
        : "longform",
    updatedAt: stored.updatedAt ?? (await inferProjectUpdatedAt(safeSlug)),
    selectedLanguages,
    paths: {
      projectState: toStoredPath(projectState)!,
      srtDir: toStoredPath(srtDir)!,
      metadataDir: toStoredPath(metadataDir)!,
      uploadReadyDir: toStoredPath(uploadReadyDir)!,
    },
    files: {
      koreanUpload: {
        status: koreanPath ? "ready" : "missing",
        path: toStoredPath(koreanPath),
        count: await countSrtCues(koreanPath),
      },
      koreanClean: {
        status: koreanClean ? "ready" : "missing",
        path: toStoredPath(koreanClean),
        count: await countSrtCues(koreanClean),
      },
      reviewedEnglish: {
        status: reviewedEnglish ? "ready" : "missing",
        path: toStoredPath(reviewedEnglish),
        count: await countSrtCues(reviewedEnglish),
      },
      captionSourceLock: {
        status: captionSourceLock.valid
          ? "ready"
          : captionSourceLockExists
            ? "partial"
            : "missing",
        path: captionSourceLockExists ? toStoredPath(captionSourceLockPath) : undefined,
        reason: captionSourceLock.valid ? undefined : captionSourceLock.reason,
      },
      metadata: {
        status: hasMetadata ? "ready" : "missing",
        path: metadata?.sourcePath,
      },
      uploadManifest: {
        status: hasUploadManifest ? "ready" : "missing",
        path: hasUploadManifest ? toStoredPath(uploadManifestPath) : undefined,
      },
    },
    metadata,
    languages: languageStates,
    nextAction,
  };
}

export async function saveAgentProjectLanguages(slug: string, selectedLanguages: string[]) {
  const safeSlug = requireSafeSlug(slug);
  const current = await readStoredProject(safeSlug);
  const next = {
    ...current,
    slug: safeSlug,
    selectedLanguages: normalizeSelectedLanguages(selectedLanguages),
    stage: current.stage ?? "agent_workspace",
    updatedAt: new Date().toISOString(),
  };

  const statePath = getProjectStatePath(safeSlug);
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(next, null, 2), "utf8");

  return loadAgentProject(safeSlug);
}
