import { createReadStream } from "node:fs";

import { NextResponse } from "next/server";

import { addVideoToPlaylist, createVerifiedYouTubeClient } from "@/lib/youtube-auth";
import {
  loadUploadRun,
  resolveUploadRunArtifactPath,
  updateRunStep,
  updateUploadRun,
  type UploadRunRecord,
} from "@/lib/upload-run-store";
import { writePostUploadAuditArtifacts } from "@/lib/upload-run-audit";
import {
  CAPTION_UPLOAD_MIME_TYPE,
  validateSrtUploadPath,
} from "@/lib/caption-upload-validation";

export const runtime = "nodejs";
export const maxDuration = 180;

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function summarizeStatus(run: UploadRunRecord) {
  const hasFailedCaption = run.captions.some((caption) => caption.status === "error");
  const hasFailedStep = run.steps.some((step) => step.status === "error");
  return hasFailedCaption || hasFailedStep ? "partial" : "done";
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const run = await loadUploadRun(id);

  if (!run) {
    return NextResponse.json({ ok: false, error: "실행 기록을 찾지 못했습니다." }, { status: 404 });
  }

  if (!run.videoId) {
    return NextResponse.json(
      { ok: false, error: "영상 업로드가 완료되지 않은 기록은 재시도할 수 없습니다." },
      { status: 400 },
    );
  }

  const { youtube } = await createVerifiedYouTubeClient();
  const warnings: string[] = [];
  let currentRun = run;

  if (run.thumbnail.status !== "done" && run.thumbnail.artifactPath) {
    try {
      currentRun = await updateUploadRun(run.id, (record) =>
        updateRunStep(record, "thumbnail", "running"),
      );
      await youtube.thumbnails.set({
        videoId: run.videoId,
        media: {
          body: createReadStream(
            resolveUploadRunArtifactPath(run.id, run.thumbnail.artifactPath),
          ),
        },
      });
      currentRun = await updateUploadRun(run.id, (record) => ({
        ...updateRunStep(record, "thumbnail", "done"),
        thumbnail: { ...record.thumbnail, status: "done", error: undefined },
      }));
    } catch (error) {
      const detail = errorMessage(error, "Thumbnail retry failed.");
      warnings.push(`썸네일 재시도 실패: ${detail}`);
      currentRun = await updateUploadRun(run.id, (record) => ({
        ...updateRunStep(record, "thumbnail", "error", detail),
        thumbnail: { ...record.thumbnail, status: "error", error: detail },
      }));
    }
  }

  const retryCaptions = run.captions.filter(
    (caption) => caption.status !== "done" && caption.artifactPath,
  );

  if (retryCaptions.length > 0) {
    currentRun = await updateUploadRun(run.id, (record) =>
      updateRunStep(record, "captions", "running"),
    );
  }

  let captionErrors = 0;
  for (const caption of retryCaptions) {
    try {
      const filePath = resolveUploadRunArtifactPath(run.id, caption.artifactPath ?? "");
      const validationError = await validateSrtUploadPath(filePath, caption.language);
      if (validationError) throw new Error(validationError);

      await youtube.captions.insert({
        part: ["snippet"],
        requestBody: {
          snippet: {
            videoId: run.videoId,
            language: caption.language,
            // Keep blank so YouTube player menus show the language only,
            // matching captions uploaded manually in Studio.
            name: "",
            isDraft: false,
          },
        },
        media: {
          mimeType: CAPTION_UPLOAD_MIME_TYPE,
          body: createReadStream(filePath),
        },
      });
      currentRun = await updateUploadRun(run.id, (record) => ({
        ...record,
        captions: record.captions.map((item) =>
          item.id === caption.id ? { ...item, status: "done", error: undefined } : item,
        ),
      }));
    } catch (error) {
      captionErrors += 1;
      const detail = errorMessage(error, `${caption.language} caption retry failed.`);
      warnings.push(`${caption.language} 자막 재시도 실패: ${detail}`);
      currentRun = await updateUploadRun(run.id, (record) => ({
        ...record,
        captions: record.captions.map((item) =>
          item.id === caption.id ? { ...item, status: "error", error: detail } : item,
        ),
      }));
    }
  }

  if (retryCaptions.length > 0) {
    const captionStepStatus =
      captionErrors === 0
        ? "done"
        : captionErrors === retryCaptions.length
          ? "error"
          : "partial";
    currentRun = await updateUploadRun(run.id, (record) =>
      updateRunStep(
        record,
        "captions",
        captionStepStatus,
        captionErrors > 0 ? `${captionErrors}개 자막 재시도 실패` : undefined,
      ),
    );
  }

  if (run.playlistId && run.playlist.status !== "done") {
    try {
      currentRun = await updateUploadRun(run.id, (record) =>
        updateRunStep(record, "playlist", "running"),
      );
      await addVideoToPlaylist(youtube, run.playlistId, run.videoId);
      currentRun = await updateUploadRun(run.id, (record) => ({
        ...updateRunStep(record, "playlist", "done"),
        playlist: { ...record.playlist, status: "done", error: undefined },
      }));
    } catch (error) {
      const detail = errorMessage(error, "Playlist retry failed.");
      warnings.push(`재생목록 재시도 실패: ${detail}`);
      currentRun = await updateUploadRun(run.id, (record) => ({
        ...updateRunStep(record, "playlist", "error", detail),
        playlist: { ...record.playlist, status: "error", error: detail },
      }));
    }
  }

  currentRun = await updateUploadRun(run.id, (record) => ({
    ...record,
    status: summarizeStatus(record),
    warnings,
  }));
  await writePostUploadAuditArtifacts(currentRun);

  return NextResponse.json({
    ok: true,
    partial: currentRun.status === "partial",
    warnings,
    run: currentRun,
  });
}
