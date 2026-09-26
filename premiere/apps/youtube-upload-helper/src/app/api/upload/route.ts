import { createReadStream } from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";
import { getDescriptionBlocks } from "@deno/runtime-paths";

import { addVideoToPlaylist, createVerifiedYouTubeClient } from "@/lib/youtube-auth";
import { descriptionLinkOptionsForChannel } from "@/lib/channel-policy";
import { getActiveChannelId } from "@/lib/youtube-storage";
import { requireLocalBrowserRequest } from "@/lib/local-request-guard";
import { saveBrowserFileToTemp } from "@/lib/upload-temp-file";
import {
  comfyReferralBlock,
  configureDescriptionBlocks,
  discordBlock,
  ensurePermanentDescriptionLinks,
} from "@/lib/description-policy";
import { defaultUploadInteractionSettings } from "@/lib/upload-preset-types";
import {
  copyUploadRunArtifact,
  createUploadRun,
  updateRunStep,
  updateUploadRun,
  writeUploadRunTextArtifact,
  type UploadRunRecord,
} from "@/lib/upload-run-store";
import { writePostUploadAuditArtifacts } from "@/lib/upload-run-audit";
import {
  CAPTION_UPLOAD_MIME_TYPE,
  validateSrtUploadFile,
} from "@/lib/caption-upload-validation";

export const runtime = "nodejs";

// 설명 고정 블록 값은 channels.json에서(서버 적재 때 한 번).
configureDescriptionBlocks(getDescriptionBlocks());
export const maxDuration = 300;

type LocalizationInput = {
  language: string;
  title: string;
  description: string;
};

type SubtitleTrackInput = {
  id: string;
  language: string;
  label: string;
};

function parseTags(raw: FormDataEntryValue | null) {
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }

  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parsePrivacyStatus(raw: FormDataEntryValue | null) {
  const value = typeof raw === "string" ? raw : "unlisted";
  return value === "public" || value === "unlisted" ? value : "private";
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

/**
 * datetime-local 입력 (예: "2026-05-22T14:00" 또는 "2026-05-22T14:00:00Z") → ISO 8601.
 * 빈 값이면 undefined 반환 (YouTube API에 publishAt 보내지 않음).
 */
function parseIsoDateTime(raw: FormDataEntryValue | null): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const trimmed = raw.trim();
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

/** 카테고리 ID는 숫자 문자열. 빈 값이면 undefined. */
function parseCategoryId(raw: FormDataEntryValue | null): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // YouTube 카테고리 ID는 정수 문자열만 허용. 그 외는 무시.
  if (!/^\d+$/.test(trimmed)) return undefined;
  return trimmed;
}

function cleanLanguageCode(value: string) {
  return value.trim();
}

function parseJsonField<T>(raw: FormDataEntryValue | null, fallback: T): T {
  if (typeof raw !== "string" || !raw.trim()) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseLocalizations(
  raw: FormDataEntryValue | null,
  linkOptions: { includeComfyReferral: boolean; includeDiscord: boolean },
) {
  const value = parseJsonField<LocalizationInput[]>(raw, []);
  const seen = new Set<string>();
  const localizations: Record<string, { title: string; description: string }> = {};

  for (const entry of value) {
    const language = cleanLanguageCode(entry.language);
    const title = entry.title?.trim() ?? "";
    const description = entry.description?.trim() ?? "";

    if (!language || !title || !description) {
      continue;
    }

    const normalized = language.toLowerCase();

    if (seen.has(normalized)) {
      throw new Error(`Localized metadata for ${language} is duplicated.`);
    }

    seen.add(normalized);
    localizations[language] = {
      title,
      description: ensurePermanentDescriptionLinks(description, {
        comfyBlock: comfyReferralBlock("en"),
        discordBlock: discordBlock("en"),
        ...linkOptions,
      }),
    };
  }

  return localizations;
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

function pickThumbnail(formData: FormData, choice: string): File | null {
  const fieldName =
    choice === "B" ? "thumbnailB" : choice === "C" ? "thumbnailC" : "thumbnailA";
  const selected = formData.get(fieldName);

  if (selected instanceof File && selected.size > 0) {
    return selected;
  }

  for (const fallback of ["thumbnailA", "thumbnailB", "thumbnailC"]) {
    const file = formData.get(fallback);
    if (file instanceof File && file.size > 0) {
      return file;
    }
  }

  return null;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

const CAPTION_LOCALIZATION_BATCH_SIZE = 3;

function isQuotaErrorMessage(message: string) {
  return /quota|dailyLimitExceeded|rateLimitExceeded/i.test(message);
}

function safeArtifactName(fileName: string, fallback: string) {
  const parsed = path.parse(fileName || fallback);
  const name = (parsed.name || fallback)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const ext = parsed.ext.replace(/[^a-zA-Z0-9.]/g, "") || path.extname(fallback);
  return `${name || fallback}${ext}`;
}

export async function POST(request: Request) {
  const denied = requireLocalBrowserRequest(request);
  if (denied) return denied;

  if (process.env.ENABLE_LEGACY_ONE_CLICK_UPLOAD !== "true") {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "LEGACY_UPLOAD_DISABLED",
          message:
            "이전 one-click 업로드 경로는 현재 업로드 순서 정책과 맞지 않아 비활성화되어 있습니다. Helper의 업로드 요청 패키지를 저장한 뒤 Codex staged upload 흐름을 사용하세요.",
        },
      },
      { status: 410 },
    );
  }

  const formData = await request.formData();
  const video = formData.get("video");

  if (!(video instanceof File) || video.size === 0) {
    return NextResponse.json({ error: "A video file is required." }, { status: 400 });
  }

  const title = formData.get("title");
  const description = formData.get("description");
  const defaultLanguageRaw = formData.get("defaultLanguage");

  if (typeof title !== "string" || !title.trim()) {
    return NextResponse.json({ error: "Please enter a title." }, { status: 400 });
  }

  if (typeof description !== "string" || !description.trim()) {
    return NextResponse.json(
      { error: "Please enter a description." },
      { status: 400 },
    );
  }

  if (typeof defaultLanguageRaw !== "string" || !defaultLanguageRaw.trim()) {
    return NextResponse.json(
      { error: "Please enter a default language code such as ko or en." },
      { status: 400 },
    );
  }

  const playlistId = formData.get("playlistId");
  const privacyStatus = parsePrivacyStatus(formData.get("privacyStatus"));
  const madeForKids = parseBoolean(formData.get("madeForKids"));
  const containsSyntheticMedia = parseBoolean(formData.get("containsSyntheticMedia"));
  const embeddable = parseBoolean(formData.get("embeddable"));
  const publicStatsViewable = parseBoolean(formData.get("publicStatsViewable"));
  const commentSettings = {
    commentVisibility: parseCommentVisibility(formData.get("commentVisibility")),
    commentModeration: parseCommentModeration(formData.get("commentModeration")),
    commentPermission: parseCommentPermission(formData.get("commentPermission")),
    commentSortOrder: parseCommentSortOrder(formData.get("commentSortOrder")),
    publicStatsViewable,
  };
  const notifySubscribers = parseBoolean(formData.get("notifySubscribers"));
  const license =
    formData.get("license") === "creativeCommon" ? "creativeCommon" : "youtube";
  const tags = parseTags(formData.get("tags"));

  // m28 추가 옵션
  const categoryId = parseCategoryId(formData.get("categoryId"));
  const defaultAudioLanguageRaw = formData.get("defaultAudioLanguage");
  const defaultAudioLanguage =
    typeof defaultAudioLanguageRaw === "string" && defaultAudioLanguageRaw.trim()
      ? cleanLanguageCode(defaultAudioLanguageRaw)
      : undefined;
  const publishAt = parseIsoDateTime(formData.get("publishAt"));
  const recordingDate = parseIsoDateTime(formData.get("recordingDate"));
  const selectedThumbnail = pickThumbnail(
    formData,
    typeof formData.get("thumbnailChoice") === "string"
      ? (formData.get("thumbnailChoice") as string)
      : "A",
  );

  // 한 요청 안에서는 시작 시점의 선택 채널 하나만 쓴다(설명 고정 링크 정책과 업로드 대상).
  const uploadChannelId = await getActiveChannelId();
  const linkOptions = descriptionLinkOptionsForChannel(uploadChannelId);
  let localizations: Record<string, { title: string; description: string }> = {};
  let subtitleTracks: SubtitleTrackInput[] = [];
  let targetLanguages: string[] = [];

  try {
    localizations = parseLocalizations(formData.get("localizations"), linkOptions);
    subtitleTracks = parseSubtitleTracks(formData.get("subtitleTracks"));
    targetLanguages = parseTargetLanguages(formData.get("targetLanguages"));
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Localized metadata could not be parsed.",
      },
      { status: 400 },
    );
  }

  const defaultLanguage = cleanLanguageCode(defaultLanguageRaw);

  if (Object.keys(localizations).some((language) => language.toLowerCase() === defaultLanguage.toLowerCase())) {
    return NextResponse.json(
      { error: "Default language must not be duplicated inside localizations." },
      { status: 400 },
    );
  }

  const playlistIdValue =
    typeof playlistId === "string" && playlistId.trim() ? playlistId.trim() : undefined;
  const subtitleFileInputs = subtitleTracks
    .map((track) => {
      const file = formData.get(`subtitleFile:${track.id}`);
      return file instanceof File && file.size > 0
        ? { track, file, originalName: file.name }
        : null;
    })
    .filter((item): item is {
      track: SubtitleTrackInput;
      file: File;
      originalName: string;
    } => Boolean(item));

  for (const item of subtitleFileInputs) {
    const validationError = await validateSrtUploadFile(item.file, item.track.language);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }
  }
  const descriptionText = ensurePermanentDescriptionLinks(description, linkOptions);

  const run = await createUploadRun({
    title: title.trim(),
    videoFileName: video.name,
    videoSize: video.size,
    requestedPrivacyStatus: privacyStatus,
    publishAt,
    playlistId: playlistIdValue,
    localizations: Object.keys(localizations),
    thumbnailFileName: selectedThumbnail?.name,
    captions: subtitleFileInputs.map((item) => ({
      id: item.track.id,
      language: item.track.language,
      label: item.track.label || item.track.language,
      fileName: item.originalName,
    })),
  });

  let currentRun: UploadRunRecord = run;
  let videoTemp: Awaited<ReturnType<typeof saveBrowserFileToTemp>> | null = null;
  let thumbnailTemp: Awaited<ReturnType<typeof saveBrowserFileToTemp>> | null = null;
  const subtitleTemps: Array<{
    track: SubtitleTrackInput;
    temp: Awaited<ReturnType<typeof saveBrowserFileToTemp>>;
    originalName: string;
  }> = [];

  try {
    currentRun = await updateUploadRun(run.id, (record) => ({
      ...updateRunStep(record, "video", "running"),
      status: "uploading",
    }));

    // 선택 채널의 토큰이 실제 그 채널인지 확인한 뒤에만 올린다.
    const { youtube } = await createVerifiedYouTubeClient(uploadChannelId);

    videoTemp = await saveBrowserFileToTemp(video);
    thumbnailTemp = selectedThumbnail
      ? await saveBrowserFileToTemp(selectedThumbnail)
      : null;

    await writeUploadRunTextArtifact(
      run.id,
      "metadata.json",
      JSON.stringify(
        {
          title: title.trim(),
          description: descriptionText,
          tags,
          defaultLanguage,
          defaultAudioLanguage,
          categoryId,
          requestedPrivacyStatus: privacyStatus,
          publishAt,
          recordingDate,
          targetLanguages,
          localizations,
          commentSettings,
        },
        null,
        2,
      ),
    );

    if (thumbnailTemp && selectedThumbnail) {
      const artifactPath = await copyUploadRunArtifact(
        run.id,
        thumbnailTemp.filePath,
        `thumbnail/${safeArtifactName(selectedThumbnail.name, "thumbnail.jpg")}`,
      );
      currentRun = await updateUploadRun(run.id, (record) => ({
        ...record,
        thumbnail: {
          ...record.thumbnail,
          artifactPath,
        },
      }));
    }

    for (const item of subtitleFileInputs) {
      const temp = await saveBrowserFileToTemp(item.file);
      const artifactPath = await copyUploadRunArtifact(
        run.id,
        temp.filePath,
        `subtitles/${safeArtifactName(item.originalName, `${item.track.language}.srt`)}`,
      );
      subtitleTemps.push({
        track: item.track,
        temp,
        originalName: item.originalName,
      });
      currentRun = await updateUploadRun(run.id, (record) => ({
        ...record,
        captions: record.captions.map((caption) =>
          caption.id === item.track.id ? { ...caption, artifactPath } : caption,
        ),
      }));
    }

    // part는 어떤 필드를 보낼지 결정. recordingDate 보내면 recordingDetails 추가.
    const parts: string[] = ["snippet", "status"];
    if (recordingDate) parts.push("recordingDetails");

    // publishAt이 있으면 privacyStatus는 "private"이어야 함 (YouTube 규칙).
    // 사용자가 public/unlisted + publishAt 동시 설정한 경우 무시(publishAt 우선 → private 강제).
    const effectivePrivacyStatus = publishAt ? "private" : privacyStatus;

    const uploadResponse = await youtube.videos.insert({
      part: parts,
      notifySubscribers,
      requestBody: {
        snippet: {
          title: title.trim(),
          description: descriptionText,
          tags,
          defaultLanguage,
          ...(defaultAudioLanguage ? { defaultAudioLanguage } : {}),
          ...(categoryId ? { categoryId } : {}),
        },
        status: {
          privacyStatus: effectivePrivacyStatus,
          selfDeclaredMadeForKids: madeForKids,
          containsSyntheticMedia,
          embeddable,
          publicStatsViewable,
          license,
          ...(publishAt ? { publishAt } : {}),
        },
        ...(recordingDate
          ? { recordingDetails: { recordingDate } }
          : {}),
      },
      media: {
        body: createReadStream(videoTemp.filePath),
      },
    });

    const videoId = uploadResponse.data.id;

    if (!videoId) {
      throw new Error("The YouTube response did not include a video ID.");
    }

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const studioUrl = `https://studio.youtube.com/video/${videoId}/edit`;
    const warnings: string[] = [];

    currentRun = await updateUploadRun(run.id, (record) => ({
      ...updateRunStep(record, "video", "done"),
      videoId,
      url,
      studioUrl,
      effectivePrivacyStatus,
    }));

    if (thumbnailTemp) {
      try {
        currentRun = await updateUploadRun(run.id, (record) =>
          updateRunStep(record, "thumbnail", "running"),
        );
        await youtube.thumbnails.set({
          videoId,
          media: {
            body: createReadStream(thumbnailTemp.filePath),
          },
        });
        currentRun = await updateUploadRun(run.id, (record) => ({
          ...updateRunStep(record, "thumbnail", "done"),
          thumbnail: { ...record.thumbnail, status: "done" },
        }));
      } catch (error) {
        const detail = errorMessage(error, "Thumbnail upload failed.");
        warnings.push(`썸네일 적용 실패: ${detail}`);
        currentRun = await updateUploadRun(run.id, (record) => ({
          ...updateRunStep(record, "thumbnail", "error", detail),
          thumbnail: { ...record.thumbnail, status: "error", error: detail },
        }));
      }
    }

    let captionErrors = 0;
    let quotaStopped = false;
    let pendingLocalizationChanges = 0;
    const captionBackedLocalizations: Record<string, { title: string; description: string }> = {};

    const publishCaptionBackedLocalizations = async (reason: string) => {
      if (pendingLocalizationChanges === 0) return true;
      if (Object.keys(captionBackedLocalizations).length === 0) return true;

      try {
        await youtube.videos.update({
          part: ["localizations"],
          requestBody: {
            id: videoId,
            localizations: captionBackedLocalizations,
          },
        });
        pendingLocalizationChanges = 0;
        return true;
      } catch (error) {
        const detail = errorMessage(
          error,
          "Localized title/description update failed.",
        );
        warnings.push(`다국어 제목/설명 적용 실패(${reason}): ${detail}`);
        if (isQuotaErrorMessage(detail)) {
          quotaStopped = true;
        }
        return false;
      }
    };

    if (subtitleTemps.length > 0) {
      currentRun = await updateUploadRun(run.id, (record) =>
        updateRunStep(record, "captions", "running"),
      );
    }

    for (const item of subtitleTemps) {
      try {
        await youtube.captions.insert({
          part: ["snippet"],
          requestBody: {
            snippet: {
              videoId,
              language: item.track.language,
              // Keep blank so YouTube player menus show the language only,
              // matching captions uploaded manually in Studio.
              name: "",
              isDraft: false,
            },
          },
          media: {
            mimeType: CAPTION_UPLOAD_MIME_TYPE,
            body: createReadStream(item.temp.filePath),
          },
        });
        currentRun = await updateUploadRun(run.id, (record) => ({
          ...record,
          captions: record.captions.map((caption) =>
            caption.id === item.track.id ? { ...caption, status: "done" } : caption,
          ),
        }));

        const localization = localizations[item.track.language];
        if (localization) {
          captionBackedLocalizations[item.track.language] = localization;
          pendingLocalizationChanges += 1;
        }

        if (pendingLocalizationChanges >= CAPTION_LOCALIZATION_BATCH_SIZE) {
          const published = await publishCaptionBackedLocalizations(
            `caption batch ${Object.keys(captionBackedLocalizations).length}`,
          );
          if (!published && quotaStopped) break;
        }
      } catch (error) {
        captionErrors += 1;
        const detail = errorMessage(error, `${item.track.language} caption upload failed.`);
        warnings.push(`${item.track.language} 자막 추가 실패: ${detail}`);
        currentRun = await updateUploadRun(run.id, (record) => ({
          ...record,
          captions: record.captions.map((caption) =>
            caption.id === item.track.id
              ? { ...caption, status: "error", error: detail }
              : caption,
          ),
        }));
        if (isQuotaErrorMessage(detail)) {
          quotaStopped = true;
          break;
        }
      }
    }

    if (!quotaStopped) {
      await publishCaptionBackedLocalizations("final caption batch");
    } else if (pendingLocalizationChanges > 0) {
      warnings.push(
        "quota 중단으로 마지막 자막 묶음의 제목/설명 현지화는 적용 여부 확인이 필요합니다.",
      );
    }

    if (subtitleTemps.length > 0) {
      const doneCaptionCount = currentRun.captions.filter(
        (caption) => caption.status === "done",
      ).length;
      const captionStepStatus =
        doneCaptionCount === subtitleTemps.length && captionErrors === 0 && !quotaStopped
          ? "done"
          : doneCaptionCount === 0 && captionErrors > 0
            ? "error"
            : "partial";
      currentRun = await updateUploadRun(run.id, (record) =>
        updateRunStep(
          record,
          "captions",
          captionStepStatus,
          captionErrors > 0
            ? `${captionErrors}개 자막 업로드 실패`
            : quotaStopped
              ? "quota로 자막/현지화 작업 중단"
              : undefined,
        ),
      );
    }

    if (playlistIdValue) {
      try {
        currentRun = await updateUploadRun(run.id, (record) =>
          updateRunStep(record, "playlist", "running"),
        );
        await addVideoToPlaylist(youtube, playlistIdValue, videoId);
        currentRun = await updateUploadRun(run.id, (record) => ({
          ...updateRunStep(record, "playlist", "done"),
          playlist: { ...record.playlist, status: "done" },
        }));
      } catch (error) {
        const detail = errorMessage(error, "Playlist add failed.");
        warnings.push(`재생목록 추가 실패: ${detail}`);
        currentRun = await updateUploadRun(run.id, (record) => ({
          ...updateRunStep(record, "playlist", "error", detail),
          playlist: { ...record.playlist, status: "error", error: detail },
        }));
      }
    }

    const partial = warnings.length > 0;
    currentRun = await updateUploadRun(run.id, (record) => ({
      ...record,
      status: partial ? "partial" : "done",
      warnings,
    }));
    await writePostUploadAuditArtifacts(currentRun);

    return NextResponse.json({
      ok: true,
      partial,
      runId: run.id,
      videoId,
      title: title.trim(),
      requestedPrivacyStatus: privacyStatus,
      privacyStatus: effectivePrivacyStatus,
      effectivePrivacyStatus,
      warnings,
      url,
      studioUrl,
    });
  } catch (error) {
    const detail = errorMessage(error, "A YouTube upload error occurred.");

    const failedRun = await updateUploadRun(run.id, (record) => ({
      ...updateRunStep(record, "video", record.videoId ? "done" : "error", detail),
      status: record.videoId ? "partial" : "error",
      error: detail,
      warnings: record.videoId
        ? [...record.warnings, `업로드 후 처리 실패: ${detail}`]
        : record.warnings,
    })).catch(() => currentRun);
    await writePostUploadAuditArtifacts(failedRun).catch(() => undefined);

    return NextResponse.json(
      {
        ok: false,
        runId: run.id,
        videoId: currentRun.videoId,
        error: detail,
        partial: Boolean(currentRun.videoId),
      },
      { status: currentRun.videoId ? 200 : 500 },
    );
  } finally {
    await videoTemp?.cleanup();
    await thumbnailTemp?.cleanup();

    for (const item of subtitleTemps) {
      await item.temp.cleanup();
    }
  }
}
