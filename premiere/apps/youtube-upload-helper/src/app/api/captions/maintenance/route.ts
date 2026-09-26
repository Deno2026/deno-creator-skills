import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getProductionPaths } from "@deno/runtime-paths";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { NextResponse } from "next/server";

import {
  loadCanonicalCaptionAuthority,
  type CanonicalCaptionAuthority,
} from "@/lib/agent-workspace";
import {
  assertLockedArtifactHash,
  assertManualTrackPrecondition,
  compareCanonicalSrt,
  compareProtectedCaptionSnapshots,
  manualTracksForLanguage,
  requireWritableCaptionLanguage,
  type CaptionWritePrecondition,
  type WritableCaptionLanguage,
} from "@/lib/caption-maintenance-safety";
import {
  createCaptionMaintenanceRun,
  getCaptionMaintenanceRunDir,
  saveCaptionMaintenanceRun,
  type CaptionMaintenanceMode,
  type CaptionMaintenanceOperation,
  type CaptionMaintenanceRunRecord,
  type YouTubeCaptionSnapshot,
} from "@/lib/caption-maintenance-store";
import {
  CAPTION_UPLOAD_MIME_TYPE,
  validateSrtUploadFile,
  validateSrtUploadPath,
  validateSrtUploadText,
} from "@/lib/caption-upload-validation";
import { createVerifiedYouTubeClient } from "@/lib/youtube-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

type CaptionTrackInput = {
  id: string;
  language: WritableCaptionLanguage;
  label: string;
};

type ProjectBinding = {
  slug: string;
  videoId: string;
  authority: CanonicalCaptionAuthority;
};

type PreparedCaptionInput = {
  track: CaptionTrackInput;
  file: File;
  precondition: CaptionWritePrecondition;
  submittedSha256: string;
  lockedSha256: string;
  raw: string;
};

function extractVideoId(value: string) {
  const trimmed = value.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed);
    if (url.hostname.includes("youtu.be")) {
      const candidate = url.pathname.split("/").filter(Boolean)[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(candidate) ? candidate : "";
    }
    const fromQuery = url.searchParams.get("v") ?? "";
    if (/^[a-zA-Z0-9_-]{11}$/.test(fromQuery)) return fromQuery;
    const pathMatch = url.pathname.match(/\/(?:shorts|embed)\/([a-zA-Z0-9_-]{11})/);
    if (pathMatch) return pathMatch[1];
  } catch {
    return "";
  }

  return "";
}

function parseMode(value: FormDataEntryValue | null): CaptionMaintenanceMode {
  return value === "add_missing" ? "add_missing" : "replace_or_add";
}

function parseJsonField<T>(raw: FormDataEntryValue | null, fallback: T): T {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseCaptionTracks(raw: FormDataEntryValue | null) {
  const value = parseJsonField<Array<{ id?: string; language?: string; label?: string }>>(raw, []);
  const seen = new Set<string>();

  return value.map((track) => {
    const language = requireWritableCaptionLanguage(track.language ?? "");
    const id = (track.id ?? "").trim().toLowerCase();
    if (id !== language) {
      throw new Error(`INVALID_CAPTION_TRACK_ID: ${language} track id는 언어 코드와 같아야 합니다.`);
    }
    if (seen.has(language)) {
      throw new Error(`DUPLICATE_CAPTION_INPUT: ${language} 입력이 중복되었습니다.`);
    }
    seen.add(language);
    return { id, language, label: (track.label ?? language).trim() || language };
  });
}

function parsePreconditions(raw: FormDataEntryValue | null) {
  const value = parseJsonField<Array<Partial<CaptionWritePrecondition>>>(raw, []);
  const seen = new Set<string>();

  return value.map((item) => {
    const language = requireWritableCaptionLanguage(item.language ?? "");
    if (seen.has(language)) {
      throw new Error(`DUPLICATE_CAPTION_PRECONDITION: ${language} precondition이 중복되었습니다.`);
    }
    seen.add(language);
    if (item.expectedAction !== "update" && item.expectedAction !== "insert") {
      throw new Error(`INVALID_CAPTION_PRECONDITION: ${language} expectedAction이 없습니다.`);
    }
    return {
      language,
      expectedAction: item.expectedAction,
      expectedCaptionId: item.expectedCaptionId?.trim() || undefined,
      expectedLastUpdated: item.expectedLastUpdated?.trim() || undefined,
    } satisfies CaptionWritePrecondition;
  });
}

function safeFileName(fileName: string, fallback: string) {
  const parsed = path.parse(fileName || fallback);
  const name = (parsed.name || fallback)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return `${name || path.parse(fallback).name}.srt`;
}

async function saveFile(file: File, targetDir: string, fallbackName: string) {
  await mkdir(targetDir, { recursive: true });
  const fileName = safeFileName(file.name, fallbackName);
  const filePath = path.join(targetDir, fileName);
  const readable = Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(readable, createWriteStream(filePath));
  return { fileName, filePath };
}

function simplifyCaption(item: {
  id?: string | null;
  snippet?: {
    language?: string | null;
    name?: string | null;
    trackKind?: string | null;
    status?: string | null;
    isDraft?: boolean | null;
    lastUpdated?: string | null;
    failureReason?: string | null;
  } | null;
}): YouTubeCaptionSnapshot | null {
  const id = item.id?.trim();
  const language = item.snippet?.language?.trim();
  if (!id || !language) return null;
  return {
    id,
    language,
    name: item.snippet?.name?.trim() ?? "",
    trackKind: item.snippet?.trackKind?.trim() || "unknown",
    status: item.snippet?.status?.trim() || "unknown",
    isDraft: Boolean(item.snippet?.isDraft),
    lastUpdated: item.snippet?.lastUpdated?.trim() || undefined,
    failureReason: item.snippet?.failureReason?.trim() || undefined,
  };
}

async function listVideoCaptions(videoId: string) {
  const { youtube } = await createVerifiedYouTubeClient();
  const response = await youtube.captions.list({ part: ["id", "snippet"], videoId });
  return (response.data.items ?? [])
    .map(simplifyCaption)
    .filter((item): item is YouTubeCaptionSnapshot => Boolean(item));
}

async function inspectVideo(videoId: string) {
  const { youtube } = await createVerifiedYouTubeClient();
  const videoResponse = await youtube.videos.list({
    part: ["snippet", "status"],
    id: [videoId],
  });
  const video = videoResponse.data.items?.[0];
  if (!video) throw new Error(`YOUTUBE_VIDEO_NOT_FOUND: ${videoId}`);

  return {
    video: {
      id: videoId,
      title: video.snippet?.title ?? "",
      channelTitle: video.snippet?.channelTitle ?? "",
      privacyStatus: video.status?.privacyStatus ?? "",
      defaultLanguage: video.snippet?.defaultLanguage ?? "",
      defaultAudioLanguage: video.snippet?.defaultAudioLanguage ?? "",
      url: `https://www.youtube.com/watch?v=${videoId}`,
      studioUrl: `https://studio.youtube.com/video/${videoId}/translations`,
    },
    captions: await listVideoCaptions(videoId),
  };
}

async function loadProjectBinding(slug: string, requestedVideoId: string): Promise<ProjectBinding> {
  const authorityResult = await loadCanonicalCaptionAuthority(slug);
  if (!authorityResult.valid) {
    throw new Error(`INVALID_CAPTION_AUTHORITY: ${authorityResult.reason}`);
  }

  let stored: { slug?: string; youtubeUpload?: { videoId?: string } };
  try {
    stored = JSON.parse(
      await readFile(
        getProductionPaths(slug).helperProjectPath,
        "utf8",
      ),
    ) as typeof stored;
  } catch {
    throw new Error("INVALID_PROJECT_BINDING: video_project.json을 읽지 못했습니다.");
  }

  const boundVideoId = stored.youtubeUpload?.videoId?.trim() ?? "";
  if (stored.slug !== slug || !boundVideoId) {
    throw new Error("INVALID_PROJECT_BINDING: project slug 또는 YouTube videoId가 없습니다.");
  }
  if (boundVideoId !== requestedVideoId) {
    throw new Error(
      `CROSS_VIDEO_BLOCKED: project videoId ${boundVideoId}와 요청 videoId ${requestedVideoId}가 다릅니다.`,
    );
  }

  return { slug, videoId: boundVideoId, authority: authorityResult.value };
}

function lockedShaForLanguage(authority: CanonicalCaptionAuthority, language: WritableCaptionLanguage) {
  return language === "ko" ? authority.cleanKorean.sha256 : authority.reviewedEnglish.sha256;
}

async function updateCaptionFile(params: {
  captionId: string;
  filePath: string;
  language: WritableCaptionLanguage;
  videoId: string;
}) {
  const { youtube } = await createVerifiedYouTubeClient();
  const validationError = await validateSrtUploadPath(params.filePath, params.language);
  if (validationError) throw new Error(validationError);
  const response = await youtube.captions.update({
    part: ["snippet"],
    requestBody: {
      id: params.captionId,
      snippet: {
        videoId: params.videoId,
        language: params.language,
        name: "",
        isDraft: false,
      },
    },
    media: { mimeType: CAPTION_UPLOAD_MIME_TYPE, body: createReadStream(params.filePath) },
  });
  return response.data.id ?? params.captionId;
}

async function insertCaptionFile(params: {
  videoId: string;
  language: WritableCaptionLanguage;
  filePath: string;
}) {
  const { youtube } = await createVerifiedYouTubeClient();
  const validationError = await validateSrtUploadPath(params.filePath, params.language);
  if (validationError) throw new Error(validationError);
  const response = await youtube.captions.insert({
    part: ["snippet"],
    requestBody: {
      snippet: {
        videoId: params.videoId,
        language: params.language,
        name: "",
        isDraft: false,
      },
    },
    media: { mimeType: CAPTION_UPLOAD_MIME_TYPE, body: createReadStream(params.filePath) },
  });
  return response.data.id ?? "";
}

async function downloadCaption(captionId: string) {
  const { youtube } = await createVerifiedYouTubeClient();
  const response = await youtube.captions.download(
    { id: captionId, tfmt: "srt" },
    { responseType: "arraybuffer" },
  );
  return Buffer.from(response.data as ArrayBuffer).toString("utf8");
}

async function verifyDownloadedCaption(params: {
  captionId: string;
  expectedRaw: string;
  language: WritableCaptionLanguage;
  runId: string;
  artifactName: string;
}) {
  const downloadedRaw = await downloadCaption(params.captionId);
  const validationError = validateSrtUploadText(downloadedRaw, params.language);
  const comparison = compareCanonicalSrt(params.expectedRaw, downloadedRaw);
  const verificationDir = path.join(getCaptionMaintenanceRunDir(params.runId), "verification");
  await mkdir(verificationDir, { recursive: true });
  const fileName = `${params.artifactName}.srt`;
  await writeFile(path.join(verificationDir, fileName), downloadedRaw, "utf8");
  return {
    checkedAt: new Date().toISOString(),
    downloadedArtifactPath: path.posix.join("verification", fileName),
    strictValidationPassed: !validationError,
    comparison,
    validationError,
  };
}

async function assertLiveKoreanMatchesLock(params: {
  videoId: string;
  authority: CanonicalCaptionAuthority;
  runId: string;
}) {
  const fresh = await listVideoCaptions(params.videoId);
  const manualKorean = manualTracksForLanguage(fresh, "ko");
  if (manualKorean.length !== 1) {
    throw new Error(
      `LIVE_KO_AUTHORITY_BLOCKED: en 쓰기 전 manual ko가 정확히 1개여야 하지만 ${manualKorean.length}개입니다.`,
    );
  }
  const lockedRaw = await readFile(params.authority.cleanKorean.path, "utf8");
  const verification = await verifyDownloadedCaption({
    captionId: manualKorean[0].id,
    expectedRaw: lockedRaw,
    language: "ko",
    runId: params.runId,
    artifactName: "ko_before_en_youtube",
  });
  if (!verification.strictValidationPassed || !verification.comparison.ok) {
    throw new Error(
      `LIVE_KO_AUTHORITY_BLOCKED: YouTube manual ko 본문이 current locked clean KO와 다릅니다.`,
    );
  }
}

function runStatusFromOperations(operations: CaptionMaintenanceOperation[]) {
  const active = operations.filter((operation) => operation.status !== "skipped");
  if (active.length === 0) return "done" as const;
  if (active.some((operation) => operation.status === "verification_pending")) {
    return "verification_pending" as const;
  }
  const errors = active.filter((operation) => operation.status === "error").length;
  if (errors === 0) return "done" as const;
  if (errors === active.length) return "error" as const;
  return "partial" as const;
}

function errorStatus(error: unknown) {
  const message = error instanceof Error ? error.message : "Caption maintenance failed.";
  return /(?:STALE_|DUPLICATE_|CROSS_VIDEO_|INVALID_CAPTION_|INVALID_PROJECT_|UNSUPPORTED_)/.test(
    message,
  )
    ? 409
    : 500;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const videoId = extractVideoId(searchParams.get("videoId") ?? "");
  const agentProjectSlug = (searchParams.get("agentProjectSlug") ?? "").trim();
  if (!videoId || !agentProjectSlug) {
    return NextResponse.json(
      { ok: false, error: "YouTube video ID/URL과 agent project slug가 모두 필요합니다." },
      { status: 400 },
    );
  }

  try {
    const binding = await loadProjectBinding(agentProjectSlug, videoId);
    const result = await inspectVideo(videoId);
    return NextResponse.json({
      ok: true,
      ...result,
      captionAuthority: {
        agentProjectSlug: binding.slug,
        revisionId: binding.authority.revisionId,
        allowedManualLanguages: ["ko", "en"],
        lockedSha256: {
          ko: binding.authority.cleanKorean.sha256,
          en: binding.authority.reviewedEnglish.sha256,
        },
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Caption inspection failed." },
      { status: errorStatus(error) },
    );
  }
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const videoId = extractVideoId(String(formData.get("videoId") ?? ""));
  const agentProjectSlug = String(formData.get("agentProjectSlug") ?? "").trim();
  const expectedRevisionId = String(formData.get("expectedCaptionRevisionId") ?? "").trim();
  const mode = parseMode(formData.get("mode"));
  if (!videoId || !agentProjectSlug || !expectedRevisionId) {
    return NextResponse.json(
      { ok: false, error: "videoId, agentProjectSlug, expectedCaptionRevisionId가 필요합니다." },
      { status: 400 },
    );
  }

  let recoveryRun: CaptionMaintenanceRunRecord | null = null;

  try {
    const binding = await loadProjectBinding(agentProjectSlug, videoId);
    if (binding.authority.revisionId !== expectedRevisionId) {
      throw new Error(
        `STALE_CAPTION_REVISION: 조회 revision ${expectedRevisionId}와 current revision ${binding.authority.revisionId}가 다릅니다.`,
      );
    }

    const tracks = parseCaptionTracks(formData.get("captionTracks"));
    const preconditions = parsePreconditions(formData.get("captionPreconditions"));
    if (tracks.length === 0) throw new Error("INVALID_CAPTION_INPUT: SRT 파일이 필요합니다.");
    if (preconditions.length !== tracks.length) {
      throw new Error("INVALID_CAPTION_PRECONDITION: track과 precondition 수가 다릅니다.");
    }

    const prepared: PreparedCaptionInput[] = [];
    for (const track of tracks) {
      const file = formData.get(`captionFile:${track.id}`);
      if (!(file instanceof File) || file.size <= 0) {
        throw new Error(`INVALID_CAPTION_INPUT: ${track.language} SRT 파일이 없습니다.`);
      }
      if (path.extname(file.name).toLowerCase() !== ".srt") {
        throw new Error(`INVALID_CAPTION_INPUT: ${track.language} 파일은 SRT여야 합니다.`);
      }
      const validationError = await validateSrtUploadFile(file, track.language);
      if (validationError) throw new Error(validationError);
      const rawBuffer = Buffer.from(await file.arrayBuffer());
      const submittedSha256 = createHash("sha256").update(rawBuffer).digest("hex");
      const lockedSha256 = lockedShaForLanguage(binding.authority, track.language);
      assertLockedArtifactHash({ language: track.language, submittedSha256, lockedSha256 });
      const precondition = preconditions.find((item) => item.language === track.language);
      if (!precondition) {
        throw new Error(`INVALID_CAPTION_PRECONDITION: ${track.language} precondition이 없습니다.`);
      }
      prepared.push({
        track,
        file,
        precondition,
        submittedSha256,
        lockedSha256,
        raw: rawBuffer.toString("utf8"),
      });
    }

    const inspected = await inspectVideo(videoId);
    for (const item of prepared) assertManualTrackPrecondition(inspected.captions, item.precondition);

    const run = await createCaptionMaintenanceRun({
      videoId,
      videoTitle: inspected.video.title,
      agentProjectSlug,
      captionRevisionId: binding.authority.revisionId,
      mode,
      beforeCaptions: inspected.captions,
      operations: prepared.map((item) => ({
        id: item.track.id,
        language: item.track.language,
        label: item.track.label,
        fileName: item.file.name,
      })),
    });
    let currentRun: CaptionMaintenanceRunRecord = { ...run, status: "running" };
    recoveryRun = currentRun;
    await saveCaptionMaintenanceRun(currentRun);

    const savedInputs = [] as Array<PreparedCaptionInput & { filePath: string; artifactPath: string }>;
    for (const item of prepared.sort((left, right) => left.track.language === "ko" ? -1 : right.track.language === "ko" ? 1 : 0)) {
      const saved = await saveFile(
        item.file,
        path.join(getCaptionMaintenanceRunDir(run.id), "captions", item.track.language),
        `${item.track.language}.srt`,
      );
      savedInputs.push({
        ...item,
        filePath: saved.filePath,
        artifactPath: path.posix.join("captions", item.track.language, saved.fileName),
      });
    }

    for (const item of savedInputs) {
      const existingFromSnapshot = assertManualTrackPrecondition(
        inspected.captions,
        item.precondition,
      );
      if (mode === "add_missing" && existingFromSnapshot) {
        currentRun = {
          ...currentRun,
          operations: currentRun.operations.map((operation) =>
            operation.id === item.track.id
              ? {
                  ...operation,
                  artifactPath: item.artifactPath,
                  action: "skip",
                  status: "skipped",
                  existingCaptionId: existingFromSnapshot.id,
                  expectedCaptionId: item.precondition.expectedCaptionId,
                  expectedLastUpdated: item.precondition.expectedLastUpdated,
                  submittedSha256: item.submittedSha256,
                  lockedSha256: item.lockedSha256,
                }
              : operation,
          ),
        };
        recoveryRun = currentRun;
        await saveCaptionMaintenanceRun(currentRun);
        continue;
      }

      const action = item.precondition.expectedAction;
      try {
        const freshBeforeWrite = await listVideoCaptions(videoId);
        const currentTrack = assertManualTrackPrecondition(freshBeforeWrite, item.precondition);
        if (item.track.language === "en") {
          await assertLiveKoreanMatchesLock({ videoId, authority: binding.authority, runId: run.id });
        }

        const captionId = currentTrack
          ? await updateCaptionFile({
              captionId: currentTrack.id,
              filePath: item.filePath,
              language: item.track.language,
              videoId,
            })
          : await insertCaptionFile({
              videoId,
              language: item.track.language,
              filePath: item.filePath,
            });

        const freshAfterWrite = await listVideoCaptions(videoId);
        const manualAfter = manualTracksForLanguage(freshAfterWrite, item.track.language);
        if (manualAfter.length !== 1 || manualAfter[0].id !== captionId) {
          throw new Error(
            `POST_UPLOAD_VERIFICATION_PENDING: ${item.track.language} 수동 자막 ID를 단일 대상으로 재확인하지 못했습니다.`,
          );
        }

        let verification;
        try {
          verification = await verifyDownloadedCaption({
            captionId,
            expectedRaw: item.raw,
            language: item.track.language,
            runId: run.id,
            artifactName: `${item.track.language}_youtube`,
          });
        } catch (error) {
          throw new Error(
            `POST_UPLOAD_VERIFICATION_PENDING: ${item.track.language} 재다운로드 실패: ${error instanceof Error ? error.message : "unknown"}`,
          );
        }
        if (!verification.strictValidationPassed || !verification.comparison.ok) {
          currentRun = {
            ...currentRun,
            operations: currentRun.operations.map((operation) =>
              operation.id === item.track.id
                ? {
                    ...operation,
                    verification: {
                      checkedAt: verification.checkedAt,
                      downloadedArtifactPath: verification.downloadedArtifactPath,
                      strictValidationPassed: verification.strictValidationPassed,
                      comparison: verification.comparison,
                    },
                  }
                : operation,
            ),
          };
          recoveryRun = currentRun;
          await saveCaptionMaintenanceRun(currentRun);
          throw new Error(
            `POST_UPLOAD_VERIFICATION_PENDING: ${item.track.language} 재다운로드 본문이 요청 SRT와 다릅니다.`,
          );
        }

        currentRun = {
          ...currentRun,
          operations: currentRun.operations.map((operation) =>
            operation.id === item.track.id
              ? {
                  ...operation,
                  artifactPath: item.artifactPath,
                  action,
                  status: "done",
                  existingCaptionId: currentTrack?.id,
                  captionId,
                  expectedCaptionId: item.precondition.expectedCaptionId,
                  expectedLastUpdated: item.precondition.expectedLastUpdated,
                  submittedSha256: item.submittedSha256,
                  lockedSha256: item.lockedSha256,
                  verification: {
                    checkedAt: verification.checkedAt,
                    downloadedArtifactPath: verification.downloadedArtifactPath,
                    strictValidationPassed: verification.strictValidationPassed,
                    comparison: verification.comparison,
                  },
                }
              : operation,
          ),
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : `${item.track.language} write failed.`;
        const verificationPending = detail.startsWith("POST_UPLOAD_VERIFICATION_PENDING:");
        currentRun = {
          ...currentRun,
          operations: currentRun.operations.map((operation) =>
            operation.id === item.track.id
              ? {
                  ...operation,
                  artifactPath: item.artifactPath,
                  action,
                  status: verificationPending ? "verification_pending" : "error",
                  expectedCaptionId: item.precondition.expectedCaptionId,
                  expectedLastUpdated: item.precondition.expectedLastUpdated,
                  submittedSha256: item.submittedSha256,
                  lockedSha256: item.lockedSha256,
                  error: detail,
                }
              : operation,
          ),
          warnings: [...currentRun.warnings, `${item.track.language}: ${detail}`],
        };
        recoveryRun = currentRun;
        await saveCaptionMaintenanceRun(currentRun);
        break;
      }
      recoveryRun = currentRun;
      await saveCaptionMaintenanceRun(currentRun);
    }

    const afterCaptions = await listVideoCaptions(videoId);
    const targetLanguages = savedInputs.map((item) => item.track.language);
    const protectedComparison = compareProtectedCaptionSnapshots(
      inspected.captions,
      afterCaptions,
      targetLanguages,
    );
    if (!protectedComparison.ok) {
      currentRun = {
        ...currentRun,
        warnings: [
          ...currentRun.warnings,
          "PROTECTED_TRACK_MISMATCH: ASR 또는 비대상 수동 트랙 snapshot이 작업 전후 다릅니다.",
        ],
      };
    }
    const computedStatus = runStatusFromOperations(currentRun.operations);
    currentRun = {
      ...currentRun,
      status: !protectedComparison.ok && computedStatus === "done"
        ? "verification_pending"
        : computedStatus,
      afterCaptions,
      protectedTracksVerification: {
        checkedAt: new Date().toISOString(),
        ok: protectedComparison.ok,
        beforeCount: protectedComparison.before.length,
        afterCount: protectedComparison.after.length,
      },
    };
    recoveryRun = currentRun;
    await saveCaptionMaintenanceRun(currentRun);
    return NextResponse.json({ ok: true, run: currentRun });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Caption maintenance failed.";
    if (recoveryRun) {
      const hasAppliedWrite = recoveryRun.operations.some(
        (operation) =>
          operation.status === "done" || operation.status === "verification_pending",
      );
      const recovered: CaptionMaintenanceRunRecord = {
        ...recoveryRun,
        status: hasAppliedWrite ? "verification_pending" : "error",
        error: detail,
        warnings: [...recoveryRun.warnings, `RUN_ABORTED: ${detail}`],
      };
      await saveCaptionMaintenanceRun(recovered).catch(() => undefined);
    }
    return NextResponse.json(
      { ok: false, error: detail },
      { status: errorStatus(error) },
    );
  }
}
