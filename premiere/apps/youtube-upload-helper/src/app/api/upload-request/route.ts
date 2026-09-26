import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { findProductionRoot, getUploadRuntimePaths } from "@deno/runtime-paths";

import { NextResponse } from "next/server";
import { getDescriptionBlocks } from "@deno/runtime-paths";

import {
  defaultUploadDraft,
  defaultUploadInteractionSettings,
} from "@/lib/upload-preset-types";
import { descriptionLinkOptionsForChannel } from "@/lib/channel-policy";
import { configureDescriptionBlocks, ensurePermanentDescriptionLinks } from "@/lib/description-policy";
import { requireLocalBrowserRequest } from "@/lib/local-request-guard";
import { verifyProductionPreparation } from "@/lib/production-handoff";
import { resolveChannel } from "@/lib/youtube-storage";
import {
  VideoStageError,
  getVideoStage,
  materializeStagedVideo,
} from "@/lib/video-upload-staging";

export const runtime = "nodejs";

configureDescriptionBlocks(getDescriptionBlocks());
export const maxDuration = 300;

type SubtitleTrackInput = {
  id: string;
  language: string;
  label: string;
};

type SavedFile = {
  fileName: string;
  originalName: string;
  path: string;
  size: number;
  sha256?: string | null;
};

type UploadRequestErrorCode =
  | "EXPECTED_MULTIPART"
  | "REQUEST_BODY_TOO_LARGE"
  | "VIDEO_MUST_BE_STAGED"
  | "MULTIPART_PARSE_FAILED"
  | "STAGED_VIDEO_INVALID"
  | "VALIDATION_FAILED"
  | "FILE_SAVE_FAILED"
  | "MANIFEST_WRITE_FAILED"
  | "YOUTUBE_CHANNEL_MISMATCH"
  | "INTERNAL_ERROR";

const SAFE_LANGUAGE_CODE = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/;
const SAFE_REQUEST_ID = /^[a-zA-Z0-9._-]{1,180}$/;
const SAFE_PROJECT_SLUG = /^[a-zA-Z0-9._-]{1,180}$/;
const MAX_FINAL_REQUEST_BYTES = 32 * 1024 * 1024;

function failUploadRequest(
  status: number,
  code: UploadRequestErrorCode,
  message: string,
  detail: Record<string, unknown> = {},
) {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code,
        message,
        detail,
        saved: false,
      },
    },
    { status },
  );
}

function summarizeError(error: unknown) {
  const sanitize = (value: string) => {
    let result = value;
    for (const root of [
      process.cwd(),
      findProductionRoot(),
      getUploadRuntimePaths().runtimeRoot,
    ]) {
      result = result.split(root).join("[workspace]");
      result = result.split(root.replaceAll("\\", "/")).join("[workspace]");
    }
    return result;
  };

  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitize(error.message),
      cause:
        error.cause instanceof Error
          ? {
              name: error.cause.name,
              message: sanitize(error.cause.message),
            }
          : error.cause
            ? sanitize(String(error.cause))
            : "",
    };
  }

  return { message: sanitize(String(error)) };
}

function parseTags(raw: FormDataEntryValue | null) {
  if (typeof raw !== "string" || !raw.trim()) return [];

  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseBoolean(raw: FormDataEntryValue | null) {
  return raw === "true";
}

function parseCommentVisibility(raw: FormDataEntryValue | null) {
  return raw === "disabled"
    ? "disabled"
    : defaultUploadInteractionSettings.commentVisibility;
}

function parseCommentModeration(raw: FormDataEntryValue | null) {
  return raw === "basic" || raw === "strict" || raw === "hold_all"
    ? raw
    : defaultUploadInteractionSettings.commentModeration;
}

function parseCommentPermission(raw: FormDataEntryValue | null) {
  return raw === "all"
    ? raw
    : defaultUploadInteractionSettings.commentPermission;
}

function parseCommentSortOrder(raw: FormDataEntryValue | null) {
  return raw === "top"
    ? raw
    : defaultUploadInteractionSettings.commentSortOrder;
}

function parseJsonField<T>(raw: FormDataEntryValue | null, fallback: T): T {
  if (typeof raw !== "string" || !raw.trim()) return fallback;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function cleanLanguageCode(value: string) {
  const code = value.trim();
  if (!SAFE_LANGUAGE_CODE.test(code)) {
    throw new Error(`Invalid subtitle language code: ${value}`);
  }
  return code;
}

function parseSubtitleTracks(raw: FormDataEntryValue | null) {
  const value = parseJsonField<SubtitleTrackInput[]>(raw, []);
  const seen = new Set<string>();

  return value
    .map((track) => ({
      id: track.id?.trim() ?? "",
      language: cleanLanguageCode(track.language),
      label: track.label?.trim() ?? "",
    }))
    .filter((track) => track.id && track.language)
    .filter((track) => {
      const normalized = track.language.toLowerCase();
      if (seen.has(normalized)) {
        throw new Error(`Subtitle language ${track.language} is duplicated.`);
      }
      seen.add(normalized);
      return true;
    });
}

function parseTargetLanguages(raw: FormDataEntryValue | null) {
  const value = parseJsonField<string[]>(raw, []);
  const seen = new Set<string>();

  return value
    .map((language) => cleanLanguageCode(language))
    .filter(Boolean)
    .filter((language) => {
      const normalized = language.toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

function parsePrivacyStatus(raw: FormDataEntryValue | null) {
  const value = typeof raw === "string" ? raw : "unlisted";
  return value === "public" || value === "unlisted" ? value : "private";
}

function parseContentKind(raw: FormDataEntryValue | null) {
  if (raw === "shorts") return "shorts";
  if (raw === "cinematic") return "cinematic";
  return "longform";
}

function parseStringField(raw: FormDataEntryValue | null) {
  return typeof raw === "string" ? raw.trim() : "";
}

function parseAgentProjectSlug(raw: FormDataEntryValue | null) {
  const slug = parseStringField(raw);
  if (!slug || !SAFE_PROJECT_SLUG.test(slug) || path.basename(slug) !== slug) {
    throw new Error("A valid agent project slug is required for longform requests.");
  }
  return slug;
}

function sanitizeFileName(fileName: string, fallback: string) {
  const parsed = path.parse(fileName || fallback);
  const name = (parsed.name || fallback)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  const ext = parsed.ext.replace(/[^a-zA-Z0-9.]/g, "") || path.extname(fallback);
  return `${name || path.parse(fallback).name}${ext}`;
}

function safeSlug(value: string, fallback: string) {
  const slug = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/[. -]+$/g, "");
  return slug || fallback;
}

function buildRequestId(title: string) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(".", "");
  return `${stamp}_${randomUUID().slice(0, 8)}_${safeSlug(title, "youtube-upload-request")}`;
}

function parseSupersedesRequestId(raw: FormDataEntryValue | null) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const requestId = raw.trim();
  if (!SAFE_REQUEST_ID.test(requestId)) {
    throw new Error("Invalid previous upload request ID.");
  }
  return requestId;
}

async function markRequestSuperseded(
  requestsRoot: string,
  previousRequestId: string,
  replacementRequestId: string,
) {
  if (!previousRequestId || previousRequestId === replacementRequestId) return false;

  const previousDir = path.join(requestsRoot, previousRequestId);
  const readyPath = path.join(previousDir, "READY");
  const supersededPath = path.join(previousDir, "SUPERSEDED");

  try {
    await rename(readyPath, supersededPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return true;
}

type ReadyInvalidation = {
  requestId: string;
  marker: "SUPERSEDED" | "STALE_CAPTION_REVISION";
};

async function invalidateOtherReadyRequests(
  requestsRoot: string,
  currentRequestId: string,
  slug: string,
  revisionId: string,
  captionMode: "manual" | "none",
) {
  const invalidated: ReadyInvalidation[] = [];
  const entries = await readdir(requestsRoot, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === currentRequestId) continue;
    const requestDir = path.join(requestsRoot, entry.name);
    let parsed: {
      agentProject?: { slug?: unknown };
      captionAuthority?: { slug?: unknown; revisionId?: unknown };
      captionPolicy?: { mode?: unknown };
    };
    try {
      parsed = JSON.parse(
        await readFile(path.join(requestDir, "upload_request.json"), "utf8"),
      ) as typeof parsed;
    } catch {
      continue;
    }

    const existingSlug =
      typeof parsed.captionAuthority?.slug === "string"
        ? parsed.captionAuthority.slug
        : typeof parsed.agentProject?.slug === "string"
          ? parsed.agentProject.slug
          : "";
    if (existingSlug !== slug) continue;

    const existingRevision =
      typeof parsed.captionAuthority?.revisionId === "string"
        ? parsed.captionAuthority.revisionId
        : "";
    const existingCaptionMode =
      parsed.captionPolicy?.mode === "none" ? "none" : "manual";
    const marker: ReadyInvalidation["marker"] =
      existingCaptionMode === captionMode && existingRevision === revisionId
        ? "SUPERSEDED"
        : "STALE_CAPTION_REVISION";
    const readyPath = path.join(requestDir, "READY");
    const markerPath = path.join(requestDir, marker);

    try {
      await stat(readyPath);
      await unlink(markerPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      await rename(readyPath, markerPath);
      invalidated.push({ requestId: entry.name, marker });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  return invalidated;
}

async function sha256Upload(file: File) {
  return createHash("sha256")
    .update(Buffer.from(await file.arrayBuffer()))
    .digest("hex");
}

function cleanKoreanSrtStyleTags(raw: string) {
  return raw.replace(/<\/?(?:b|i|u|font)(?:\s+[^>]*)?>/gi, "");
}

function toPosixRelative(baseDir: string, filePath: string) {
  return path.relative(baseDir, filePath).split(path.sep).join("/");
}

function relocateSavedFile<T extends SavedFile>(file: T, sourceRoot: string, targetRoot: string): T {
  return {
    ...file,
    path: path.join(targetRoot, path.relative(sourceRoot, file.path)),
  };
}

async function saveFile(file: File, targetDir: string, fallbackName: string): Promise<SavedFile> {
  await mkdir(targetDir, { recursive: true });

  const fileName = sanitizeFileName(file.name, fallbackName);
  const filePath = path.join(targetDir, fileName);
  const readable = Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0]);

  await pipeline(readable, createWriteStream(filePath));
  const saved = await stat(filePath);

  if (saved.size !== file.size) {
    throw new Error(
      `Saved file size mismatch for ${file.name}: expected ${file.size}, got ${saved.size}.`,
    );
  }

  return {
    fileName,
    originalName: file.name,
    path: filePath,
    size: file.size,
  };
}

function pickThumbnail(formData: FormData): File | null {
  const selected = formData.get("thumbnailA");
  return selected instanceof File && selected.size > 0 ? selected : null;
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpPath, filePath);
}

async function writeTextAtomic(filePath: string, value: string) {
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, value, "utf8");
  await rename(tmpPath, filePath);
}

export async function POST(request: Request) {
  const denied = requireLocalBrowserRequest(request);
  if (denied) return denied;

  // 업로드 대상 채널 = 완료 버튼 시점에 화면에서 고른 채널. READY에 기록하고,
  // 실행기는 그 채널의 토큰이 실제 같은 채널인지 대조한 뒤에만 올린다.
  const uploadChannel = await resolveChannel();

  const contentType = request.headers.get("content-type") ?? "";
  const contentLengthRaw = request.headers.get("content-length");
  const contentLength = Number(contentLengthRaw);
  if (
    !contentLengthRaw ||
    !Number.isSafeInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength > MAX_FINAL_REQUEST_BYTES
  ) {
    return failUploadRequest(
      contentLength > MAX_FINAL_REQUEST_BYTES ? 413 : 411,
      "REQUEST_BODY_TOO_LARGE",
      "요청 패키지는 저장되지 않았습니다. 영상은 청크 staging으로 먼저 저장하고 최종 자막·metadata 요청은 32MiB 이하여야 합니다.",
      { maxBytes: MAX_FINAL_REQUEST_BYTES, contentLength: contentLengthRaw },
    );
  }
  if (
    !contentType.toLowerCase().startsWith("multipart/form-data") ||
    !contentType.includes("boundary=")
  ) {
    return failUploadRequest(
      415,
      "EXPECTED_MULTIPART",
      "요청 패키지는 저장되지 않았습니다. 브라우저가 보낸 업로드 요청 형식이 올바르지 않습니다.",
      {
        contentType,
      },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    const detail = {
      contentLength: request.headers.get("content-length"),
      error: summarizeError(error),
    };
    console.error("[upload-request] multipart parse failed", detail);
    return failUploadRequest(
      400,
      "MULTIPART_PARSE_FAILED",
      "요청 패키지는 저장되지 않았습니다. 영상/자막 전송 중 본문이 깨졌거나 중간에 끊겨 upload_request.json을 만들 수 없었습니다.",
      detail,
    );
  }

  const video = formData.get("video");
  const directVideo = video instanceof File && video.size > 0 ? video : null;
  const stagedVideoId = parseStringField(formData.get("stagedVideoId"));
  const screenChannelId = parseStringField(formData.get("uploadChannelId"));
  if (screenChannelId && screenChannelId !== uploadChannel.id) {
    return failUploadRequest(
      409,
      "YOUTUBE_CHANNEL_MISMATCH",
      `저장 안 됨: 화면의 업로드 채널과 현재 선택 채널(${uploadChannel.title})이 다릅니다. 새로고침한 뒤 채널을 확인하고 다시 눌러 주세요.`,
      { screen: screenChannelId, selected: uploadChannel.id },
    );
  }
  const productionPreparationId = parseStringField(
    formData.get("productionPreparationId"),
  );
  const title = formData.get("title");
  const description = formData.get("description");
  const defaultLanguage = formData.get("defaultLanguage");
  const defaultAudioLanguage = formData.get("defaultAudioLanguage");
  const contentKind = parseContentKind(formData.get("contentKind"));
  const noAffiliateLinks = formData.get("noAffiliateLinks") === "true";
  const brandApprovalRequiredBeforePublic =
    formData.get("brandApprovalRequiredBeforePublic") === "true";
  const isMetadataVideo = contentKind !== "shorts";
  const requiresKoreanCaption = contentKind === "longform";
  const noManualCaptions = contentKind === "cinematic";
  const rawTitleText = typeof title === "string" ? title.trim() : "";
  const rawDescriptionText = typeof description === "string" ? description.trim() : "";
  const titleText = contentKind === "shorts" ? "" : rawTitleText;
  const descriptionText =
    contentKind === "shorts"
      ? ""
      : ensurePermanentDescriptionLinks(
          rawDescriptionText,
          descriptionLinkOptionsForChannel(uploadChannel.id, { noAffiliateLinks }),
        );
  const shortsBrief =
    typeof formData.get("shortsBrief") === "string"
      ? (formData.get("shortsBrief") as string).trim()
      : "";

  if (directVideo) {
    return failUploadRequest(
      400,
      "VIDEO_MUST_BE_STAGED",
      "저장 안 됨: 영상 원본을 최종 multipart에 직접 넣을 수 없습니다. 청크 staging을 먼저 완료해 주세요.",
    );
  }

  let stagedVideo: Awaited<ReturnType<typeof getVideoStage>> | null = null;
  if (stagedVideoId) {
    try {
      stagedVideo = await getVideoStage(stagedVideoId);
      if (stagedVideo.status !== "complete") {
        throw new VideoStageError(409, "STAGE_INCOMPLETE", "영상 스테이징이 아직 완료되지 않았습니다.");
      }
    } catch (error) {
      const status = error instanceof VideoStageError ? error.status : 400;
      return failUploadRequest(
        status,
        "STAGED_VIDEO_INVALID",
        error instanceof Error
          ? `저장 안 됨: ${error.message}`
          : "저장 안 됨: 완료된 영상 스테이징을 확인하지 못했습니다.",
      );
    }
  }

  if (!stagedVideo) {
    return failUploadRequest(
      400,
      "STAGED_VIDEO_INVALID",
      "저장 안 됨: 먼저 영상 파일을 로컬 요청 공간에 저장해야 합니다.",
    );
  }

  if (isMetadataVideo && !titleText) {
    return NextResponse.json({ error: "Please enter a title." }, { status: 400 });
  }

  if (isMetadataVideo && !descriptionText) {
    return NextResponse.json({ error: "Please enter a description." }, { status: 400 });
  }

  if (contentKind === "shorts" && !shortsBrief) {
    return NextResponse.json({ error: "Please enter a Shorts memo." }, { status: 400 });
  }

  if (typeof defaultLanguage !== "string" || !defaultLanguage.trim()) {
    return NextResponse.json(
      { error: "Please enter a default language code such as ko or en." },
      { status: 400 },
    );
  }

  let defaultLanguageCode = "";
  let defaultAudioLanguageCode = "";
  let subtitleTracks: SubtitleTrackInput[] = [];
  let targetLanguages: string[] = [];
  let supersedesRequestId = "";
  let agentProjectSlug = "";
  let productionPreparationEvidence: Awaited<
    ReturnType<typeof verifyProductionPreparation>
  > | null = null;

  try {
    defaultLanguageCode = cleanLanguageCode(defaultLanguage);
    defaultAudioLanguageCode =
      typeof defaultAudioLanguage === "string" && defaultAudioLanguage.trim()
        ? cleanLanguageCode(defaultAudioLanguage)
        : "";
    subtitleTracks = parseSubtitleTracks(formData.get("subtitleTracks"));
    targetLanguages =
      contentKind === "shorts" ? [] : parseTargetLanguages(formData.get("targetLanguages"));
    supersedesRequestId = parseSupersedesRequestId(formData.get("supersedesRequestId"));
    agentProjectSlug =
      isMetadataVideo ? parseAgentProjectSlug(formData.get("agentProjectSlug")) : "";
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Subtitle metadata could not be parsed.",
      },
      { status: 400 },
    );
  }

  if (productionPreparationId) {
    if (!agentProjectSlug || contentKind === "shorts") {
      return failUploadRequest(
        400,
        "VALIDATION_FAILED",
        "저장 안 됨: production preparation은 연결된 longform/cinematic production에만 사용할 수 있습니다.",
      );
    }
    try {
      productionPreparationEvidence = await verifyProductionPreparation({
        production: agentProjectSlug,
        preparationId: productionPreparationId,
        uploadId: stagedVideoId,
      });
    } catch {
      return failUploadRequest(
        409,
        "STAGED_VIDEO_INVALID",
        "저장 안 됨: production handoff 또는 master/caption revision이 준비 이후 변경됐습니다.",
      );
    }
    if (productionPreparationEvidence.youtubeChannel !== uploadChannel.id) {
      const expected = await resolveChannel(productionPreparationEvidence.youtubeChannel);
      return failUploadRequest(
        409,
        "YOUTUBE_CHANNEL_MISMATCH",
        `저장 안 됨: 이 작품은 ${expected.title}(${expected.handle}) 채널용입니다. 화면 위 채널을 ${expected.title}로 바꾼 뒤 다시 눌러 주세요.`,
        { expected: expected.id, selected: uploadChannel.id },
      );
    }
  }


  const subtitleFiles = subtitleTracks
    .map((track) => {
      const file = formData.get(`subtitleFile:${track.id}`);
      return file instanceof File && file.size > 0 ? { track, file } : null;
    })
    .filter((item): item is { track: SubtitleTrackInput; file: File } => Boolean(item));

  const submittedKorean = subtitleFiles.find(
    (item) => item.track.language.toLowerCase() === "ko",
  );
  if (
    isMetadataVideo &&
    (defaultLanguageCode.toLowerCase() !== "ko" ||
      (requiresKoreanCaption && defaultAudioLanguageCode.toLowerCase() !== "ko"))
  ) {
    return failUploadRequest(
      400,
      "VALIDATION_FAILED",
      requiresKoreanCaption
        ? "저장 안 됨: 한국어 롱폼은 동영상 언어와 음성 언어가 모두 ko여야 합니다."
        : "저장 안 됨: 한국어 제목·설명의 언어는 ko여야 합니다. 음성 언어는 실제 대사 언어를 유지하세요.",
      {
        required: {
          defaultLanguage: "ko",
          defaultAudioLanguage: requiresKoreanCaption ? "ko" : "actual_audio_language",
        },
        received: {
          defaultLanguage: defaultLanguageCode || null,
          defaultAudioLanguage: defaultAudioLanguageCode || null,
        },
      },
    );
  }
  if (!submittedKorean && requiresKoreanCaption) {
    return NextResponse.json({ error: "A Korean subtitle file is required." }, { status: 400 });
  }
  if (
    requiresKoreanCaption &&
    (subtitleTracks.length !== 1 ||
      subtitleFiles.length !== 1 ||
      subtitleTracks[0]?.language.toLowerCase() !== "ko")
  ) {
    return failUploadRequest(
      400,
      "VALIDATION_FAILED",
      "저장 안 됨: 롱폼 요청 단계에는 사용자가 승인한 최종 한국어 SRT 한 개만 제출해야 합니다.",
    );
  }
  if (noManualCaptions && (subtitleTracks.length !== 0 || subtitleFiles.length !== 0)) {
    return failUploadRequest(
      400,
      "VALIDATION_FAILED",
      "저장 안 됨: 자막 없는 영상 요청에는 SRT 파일이나 수동 자막 track을 포함할 수 없습니다.",
    );
  }

  let koreanRevisionId = "";
  let finalKoreanSha256 = "";
  let submittedKoreanSha256 = "";
  let cleanedKoreanText = "";
  if (requiresKoreanCaption) {
    try {
      const finalKoreanText = await submittedKorean!.file.text();
      cleanedKoreanText = cleanKoreanSrtStyleTags(finalKoreanText);
      finalKoreanSha256 = await sha256Upload(submittedKorean!.file);
      submittedKoreanSha256 = createHash("sha256")
        .update(Buffer.from(cleanedKoreanText, "utf8"))
        .digest("hex");
      koreanRevisionId = `caption-${submittedKoreanSha256.slice(0, 24)}`;
      if (!/^\s*\d+\s*[\r\n]+\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,.]\d{3}/m.test(cleanedKoreanText)) {
        throw new Error("유효한 SRT cue를 찾지 못했습니다.");
      }
      if (/<\/?(?:b|i|u|font)(?:\s+[^>]*)?>/i.test(cleanedKoreanText)) {
        throw new Error("업로드용 한국어 SRT에 스타일 태그가 남아 있습니다.");
      }
    } catch (error) {
      return failUploadRequest(
        400,
        "VALIDATION_FAILED",
        "저장 안 됨: 최종 한국어 SRT를 검증하거나 업로드용 clean KO를 만들지 못했습니다.",
        { error: summarizeError(error) },
      );
    }
  }
  if (
    productionPreparationEvidence &&
    requiresKoreanCaption &&
    finalKoreanSha256 !== productionPreparationEvidence.captionSha256
  ) {
    return failUploadRequest(
      409,
      "VALIDATION_FAILED",
      "저장 안 됨: final 한국어 SRT가 production handoff의 exact caption revision과 다릅니다.",
    );
  }

  const sourceFingerprint = parseStringField(formData.get("sourceFingerprint"));
  const sourceSnapshot = parseJsonField<Record<string, unknown> | null>(
    formData.get("sourceSnapshot"),
    null,
  );
  const videoOriginalName = stagedVideo.originalName;
  const fallbackTitle = videoOriginalName
    ? path.parse(videoOriginalName).name
    : "shorts-upload-request";
  const requestId = buildRequestId(contentKind === "shorts" ? fallbackTitle : titleText || fallbackTitle);
  const requestsRoot = getUploadRuntimePaths().uploadRequestsRoot;
  const requestDir = path.join(requestsRoot, requestId);
  const buildingDir = path.join(requestsRoot, `.building-${requestId}`);
  let videoInfo: SavedFile;
  const subtitleInfos = [];
  let thumbnailInfo: SavedFile | null = null;
  let thumbnailSha256 = "";

  try {
    videoInfo = await materializeStagedVideo(
      stagedVideo.uploadId,
      path.join(buildingDir, "video"),
      "video.mp4",
    );
  } catch (error) {
    await rm(buildingDir, { recursive: true, force: true }).catch(() => undefined);
    return failUploadRequest(
      500,
      "FILE_SAVE_FAILED",
      "요청 패키지는 저장되지 않았습니다. 영상 파일을 로컬 요청 폴더에 저장하지 못했습니다.",
      {
        requestId,
        requestPath: toPosixRelative(requestsRoot, requestDir),
        error: summarizeError(error),
      },
    );
  }

  let packagedFinalKorean: SavedFile | null = null;
  for (const item of subtitleFiles) {
    let saved: SavedFile;
    try {
      if (requiresKoreanCaption && item.track.language.toLowerCase() === "ko") {
        packagedFinalKorean = await saveFile(
          item.file,
          path.join(buildingDir, "caption-authority"),
          "final_korean_original.srt",
        );
        const cleanFile = new File([cleanedKoreanText], "ko.srt", {
          type: "application/x-subrip",
        });
        saved = await saveFile(cleanFile, path.join(buildingDir, "subtitles", "ko"), "ko.srt");
      } else {
        saved = await saveFile(
          item.file,
          path.join(buildingDir, "subtitles", item.track.language),
          `${item.track.language}.srt`,
        );
      }
    } catch (error) {
      await rm(buildingDir, { recursive: true, force: true }).catch(() => undefined);
      return failUploadRequest(
        500,
        "FILE_SAVE_FAILED",
        "요청 패키지는 저장되지 않았습니다. 자막 파일을 로컬 요청 폴더에 저장하지 못했습니다.",
        {
          requestId,
          requestPath: toPosixRelative(requestsRoot, requestDir),
          language: item.track.language,
          error: summarizeError(error),
        },
      );
    }
    subtitleInfos.push({
      ...saved,
      language: item.track.language,
      label: item.track.label || item.track.language,
      trackId: item.track.id,
    });
  }

  const thumbnail = pickThumbnail(formData);
  if (thumbnail) {
    try {
      thumbnailInfo = await saveFile(thumbnail, path.join(buildingDir, "thumbnail"), "thumbnail.png");
      thumbnailSha256 = await sha256Upload(thumbnail);
    } catch (error) {
      await rm(buildingDir, { recursive: true, force: true }).catch(() => undefined);
      return failUploadRequest(
        500,
        "FILE_SAVE_FAILED",
        "요청 패키지는 저장되지 않았습니다. 썸네일 파일을 로컬 요청 폴더에 저장하지 못했습니다.",
        {
          requestId,
          requestPath: toPosixRelative(requestsRoot, requestDir),
          error: summarizeError(error),
        },
      );
    }
  }

  const manifestPath = path.join(requestDir, "upload_request.json");
  const readyMarkerPath = path.join(requestDir, "READY");
  const buildingManifestPath = path.join(buildingDir, "upload_request.json");
  const buildingReadyMarkerPath = path.join(buildingDir, "READY");
  const createdAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 2,
    requestId,
    createdAt,
    status: "ready_for_codex_upload",
    source: "youtube-upload-helper",
    youtubeChannel: {
      id: uploadChannel.id,
      title: uploadChannel.title,
      handle: uploadChannel.handle,
      youtubeChannelId: uploadChannel.youtubeChannelId,
    },
    uploadAuthorization: {
      status: "approved",
      authority: "user_pressed_upload_helper_complete_button",
      trigger: "complete_button",
      approvedAt: createdAt,
      requestId,
      sourceFingerprint,
      initialPrivacyStatus: contentKind === "shorts" ? "private" : "unlisted",
      scope: requiresKoreanCaption
        ? [
            "initial_video_upload",
            "ko_caption_upload",
            "reviewed_en_caption_upload",
            "metadata_localization_write",
          ]
        : noManualCaptions
          ? ["initial_video_upload", "metadata_localization_write"]
          : ["initial_video_upload"],
      publicVisibilityAuthorized: false,
      postUploadExpansionAuthorized: isMetadataVideo,
      executionStrategy: requiresKoreanCaption
        ? "segmented_korean_first_then_english_localizations"
        : noManualCaptions
          ? "video_then_metadata_localizations"
          : "initial_upload_only",
    },
    sourceOfTruth: {
      type: "upload_helper_current_screen_at_request_click",
      note: "완료 버튼 시점의 화면 fingerprint는 exact 업로드 입력 변경 감지용이다. longform 자막 권위는 완료 버튼으로 사용자가 승인한 final KO와 서버가 만든 clean KO의 SHA-256 evidence를 사용한다. longform은 한국어 우선 업로드 검증 뒤 별도 sync 대기 없이 reviewed EN과 metadata localization을 분할 실행하며 public 전환은 포함하지 않는다.",
      sourceFingerprint,
      sourceSnapshot,
    },
    agentProject:
      isMetadataVideo
        ? {
            slug: agentProjectSlug,
          }
        : null,
    captionAuthority:
      requiresKoreanCaption && packagedFinalKorean
        ? {
            schemaVersion: 3,
            authority: "user_approved_final_korean_srt_at_request_click",
            slug: agentProjectSlug,
            revisionId: koreanRevisionId,
            validatedAt: createdAt,
            finalKorean: {
              requestPath: toPosixRelative(buildingDir, packagedFinalKorean.path),
              sha256: finalKoreanSha256,
            },
            cleanKorean: {
              requestPath: toPosixRelative(
                buildingDir,
                subtitleInfos.find((item) => item.language.toLowerCase() === "ko")!.path,
              ),
              lockedSha256: submittedKoreanSha256,
              submittedSha256: submittedKoreanSha256,
              exactMatch: true,
            },
            reviewedEnglish: { status: "pending_after_korean_upload" },
            englishReview: { status: "pending_after_korean_upload" },
            serverEvidence: {
              userApprovedAtRequestClick: true,
              styleTagsRemovedForCleanKorean: true,
              submittedKoreanSha256ComputedServerSide: true,
              cleanKoreanRevisionCreatedServerSide: true,
            },
          }
        : null,
    captionPolicy: requiresKoreanCaption
      ? {
          mode: "manual_ko_then_reviewed_en",
          authority: "user_approved_final_korean_srt_at_request_click",
          confirmedAt: createdAt,
        }
      : noManualCaptions
        ? {
            mode: "none",
            authority: "user_declared_no_manual_captions_at_request_click",
            confirmedAt: createdAt,
          }
        : {
            mode: "optional_shorts",
            authority: "shorts_request_policy",
            confirmedAt: createdAt,
          },
    revision: {
      supersedesRequestId: supersedesRequestId || null,
    },
    readyMarkerPath,
    workflowPolicy: {
      mode: noManualCaptions
        ? "video_only_metadata_wide_upload"
        : "english_bridge_metadata_wide_upload",
      heartbeatAutomation: false,
      thumbnailUploadAuthorization: thumbnailInfo
        ? {
            authorized: true,
            authority: "user_selected_thumbnail_and_saved_upload_request",
            approvedAt: createdAt,
            originalName: thumbnailInfo.originalName,
            sha256: thumbnailSha256,
          }
        : {
            authorized: false,
            authority: "no_thumbnail_selected_at_request_save",
          },
      quotaExceededPolicy: "stop_immediately_checkpoint_remaining_metadata_and_resume_next_quota_window",
      defaultManualCaptionLanguages: noManualCaptions ? [] : ["ko", "en"],
      otherCaptionLanguages: noManualCaptions
        ? "no_manual_captions_requested"
        : "youtube_auto_translate_only_unless_user_explicitly_requests_manual_srt",
      metadataLocalizationTarget: "all_current_youtube_i18n_languages_except_default_ko",
      metadataLanguageDiscovery: "youtube_i18nLanguages_list_at_job_time",
      localizationCompletionRule: "zero_missing_supported_languages_after_youtube_reread",
      stages: noManualCaptions
        ? [
            "unlisted_video_upload",
            "video_metadata_reread_verification",
            "metadata_wide_title_description_localizations",
            "localizations_reread_verification",
          ]
        : [
            "ko_unlisted_upload",
            "ko_caption_upload",
            "ko_caption_verification_required",
            "en_caption_translation",
            "en_caption_reviewer_verification",
            "en_caption_upload",
            "en_caption_verification_required",
            "metadata_wide_title_description_localizations",
            "localizations_reread_verification",
            "youtube_auto_translate_for_non_manual_caption_languages",
          ],
      priorityRule: noManualCaptions
        ? "upload_no_manual_captions_and_fill_every_current_youtube_supported_metadata_localization"
        : "upload_only_ko_en_manual_captions_and_fill_every_current_youtube_supported_metadata_localization",
      legacyOneClickUploadAllowed: false,
    },
    contentKind,
    shortsBrief,
    preparationMode:
      contentKind === "shorts"
        ? "codex_frame_audio_memo_metadata"
        : noManualCaptions
          ? "user_confirmed_metadata_no_manual_captions"
          : "user_confirmed_metadata",
    codexInstruction: "READY가 생성되면 이 exact 요청의 최초 업로드를 시작한다. 별도 채팅 승인은 요구하지 않는다.",
    files: {
      video: relocateSavedFile(videoInfo, buildingDir, requestDir),
      subtitles: subtitleInfos.map((file) => relocateSavedFile(file, buildingDir, requestDir)),
      thumbnail: thumbnailInfo
        ? {
            ...relocateSavedFile(thumbnailInfo, buildingDir, requestDir),
            sha256: thumbnailSha256,
          }
        : null,
    },
    metadata: {
      title: titleText,
      description: descriptionText,
      tags: contentKind === "shorts" ? [] : parseTags(formData.get("tags")),
      noAffiliateLinks,
      brandApprovalRequiredBeforePublic,
      fillBeforeUpload: contentKind === "shorts",
      defaultLanguage: defaultLanguageCode,
      privacyStatus: parsePrivacyStatus(formData.get("privacyStatus")),
      categoryId:
        typeof formData.get("categoryId") === "string"
          ? (formData.get("categoryId") as string).trim() || defaultUploadDraft.categoryId
          : defaultUploadDraft.categoryId,
      defaultAudioLanguage: defaultAudioLanguageCode,
      playlistId:
        typeof formData.get("playlistId") === "string"
          ? (formData.get("playlistId") as string).trim()
          : "",
      publishAt:
        typeof formData.get("publishAt") === "string"
          ? (formData.get("publishAt") as string).trim()
          : "",
      recordingDate:
        typeof formData.get("recordingDate") === "string"
          ? (formData.get("recordingDate") as string).trim()
          : "",
      madeForKids: parseBoolean(formData.get("madeForKids")),
      containsSyntheticMedia: parseBoolean(formData.get("containsSyntheticMedia")),
      embeddable: parseBoolean(formData.get("embeddable")),
      publicStatsViewable: parseBoolean(formData.get("publicStatsViewable")),
      commentSettings: {
        commentVisibility: parseCommentVisibility(formData.get("commentVisibility")),
        commentModeration: parseCommentModeration(formData.get("commentModeration")),
        commentPermission: parseCommentPermission(formData.get("commentPermission")),
        commentSortOrder: parseCommentSortOrder(formData.get("commentSortOrder")),
        publicStatsViewable: parseBoolean(formData.get("publicStatsViewable")),
        note: "YouTube Data API upload does not expose every Studio comment-control field. Keep this package default aligned with the channel upload defaults.",
      },
      notifySubscribers: parseBoolean(formData.get("notifySubscribers")),
      license: formData.get("license") === "creativeCommon" ? "creativeCommon" : "youtube",
      targetLanguages,
    },
  };

  let previousRequestSuperseded = false;
  let invalidatedReadyRequests: ReadyInvalidation[] = [];
  try {
    await writeJsonAtomic(buildingManifestPath, manifest);
    await writeTextAtomic(
      buildingReadyMarkerPath,
      [
        "ready_for_codex_upload",
        `requestId=${requestId}`,
        `createdAt=${createdAt}`,
        ...(agentProjectSlug ? [`slug=${agentProjectSlug}`] : []),
        ...(koreanRevisionId ? [`revisionId=${koreanRevisionId}`] : []),
        ...(noManualCaptions ? ["captionMode=none"] : []),
        `sourceFingerprint=${sourceFingerprint}`,
        "authorization=complete_button",
        "",
      ].join("\n"),
    );
    await rename(buildingDir, requestDir);
  } catch (error) {
    await rm(buildingDir, { recursive: true, force: true }).catch(() => undefined);
    return failUploadRequest(
      500,
      "MANIFEST_WRITE_FAILED",
      "요청 패키지는 저장되지 않았습니다. upload_request.json 또는 READY 표시 파일을 원자적으로 만들지 못했습니다.",
      {
        requestId,
        error: summarizeError(error),
      },
    );
  }

  let lifecycleWarning = "";
  try {
    if (agentProjectSlug) {
      invalidatedReadyRequests = await invalidateOtherReadyRequests(
        requestsRoot,
        requestId,
        agentProjectSlug,
        koreanRevisionId,
        noManualCaptions ? "none" : "manual",
      );
      previousRequestSuperseded = invalidatedReadyRequests.some(
        (item) => item.requestId === supersedesRequestId,
      );
    }
    // Longform lifecycle is derived from the server-validated project slug and
    // caption revision above. Never let a client-supplied request ID deactivate
    // an unrelated project's READY marker.
    if (!agentProjectSlug && !previousRequestSuperseded) {
      previousRequestSuperseded = await markRequestSuperseded(
        requestsRoot,
        supersedesRequestId,
        requestId,
      );
    }
  } catch (error) {
    lifecycleWarning = "새 READY는 저장됐지만 이전 READY marker 정리는 완료되지 않았습니다. 실행기는 같은 slug의 최신 READY만 허용합니다.";
    console.error("[upload-request] previous READY invalidation warning", {
      requestId,
      error: summarizeError(error),
    });
  }

  return NextResponse.json({
    ok: true,
    request: {
      requestId,
      requestDir: toPosixRelative(requestsRoot, requestDir),
      manifestPath: toPosixRelative(requestsRoot, manifestPath),
      readyMarkerPath: toPosixRelative(requestsRoot, readyMarkerPath),
      createdAt,
      targetLanguages,
      sourceFingerprint,
      supersedesRequestId: supersedesRequestId || undefined,
      previousRequestSuperseded,
      invalidatedReadyRequests,
      lifecycleWarning: lifecycleWarning || undefined,
      manifestVerified: true,
      videoFileName: videoInfo.originalName,
      subtitleFileName: subtitleInfos[0]?.originalName,
      thumbnailFileName: thumbnailInfo?.originalName,
      capturedMetadata: {
        title: titleText,
        descriptionLength: descriptionText.length,
        tagCount: contentKind === "shorts" ? 0 : parseTags(formData.get("tags")).length,
        privacyStatus: parsePrivacyStatus(formData.get("privacyStatus")),
        categoryId:
          typeof formData.get("categoryId") === "string"
            ? (formData.get("categoryId") as string).trim() || defaultUploadDraft.categoryId
            : defaultUploadDraft.categoryId,
      },
    },
  });
}
