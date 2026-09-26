import { NextResponse } from "next/server";

import { requireLocalBrowserRequest } from "@/lib/local-request-guard";
import {
  VideoStageError,
  appendVideoStageChunk,
  createVideoStage,
  finalizeVideoStage,
  getVideoStage,
  removeVideoStage,
} from "@/lib/video-upload-staging";

export const runtime = "nodejs";
export const maxDuration = 300;

function stageFailure(error: unknown) {
  if (error instanceof VideoStageError) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          detail: error.detail,
          saved: false,
        },
      },
      { status: error.status },
    );
  }

  console.error("[video-staging] unexpected failure", error);
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "VIDEO_STAGING_FAILED",
        message: "영상을 로컬 요청 공간에 저장하지 못했습니다.",
        saved: false,
      },
    },
    { status: 500 },
  );
}

async function readSmallJson(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
    throw new VideoStageError(413, "STAGE_COMMAND_TOO_LARGE", "영상 스테이징 명령이 너무 큽니다.");
  }
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    throw new VideoStageError(400, "INVALID_STAGE_COMMAND", "영상 스테이징 명령이 올바르지 않습니다.");
  }
}

export async function POST(request: Request) {
  const denied = requireLocalBrowserRequest(request);
  if (denied) return denied;

  try {
    const body = await readSmallJson(request);
    const action = typeof body.action === "string" ? body.action : "";
    if (action === "init") {
      const file = body.file && typeof body.file === "object" ? (body.file as Record<string, unknown>) : {};
      const stage = await createVideoStage({
        name: typeof file.name === "string" ? file.name : "",
        type: typeof file.type === "string" ? file.type : "",
        size: typeof file.size === "number" ? file.size : Number.NaN,
        lastModified: typeof file.lastModified === "number" ? file.lastModified : 0,
        videoFingerprint: typeof body.videoFingerprint === "string" ? body.videoFingerprint : "",
      });
      return NextResponse.json({ ok: true, stage });
    }

    const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
    if (action === "status") {
      return NextResponse.json({ ok: true, stage: await getVideoStage(uploadId) });
    }
    if (action === "finalize") {
      return NextResponse.json({ ok: true, stage: await finalizeVideoStage(uploadId) });
    }
    throw new VideoStageError(400, "INVALID_STAGE_ACTION", "지원하지 않는 영상 스테이징 명령입니다.");
  } catch (error) {
    return stageFailure(error);
  }
}

export async function PUT(request: Request) {
  const denied = requireLocalBrowserRequest(request);
  if (denied) return denied;

  try {
    const uploadId = request.headers.get("x-upload-id") ?? "";
    const offset = Number(request.headers.get("x-upload-offset"));
    const declaredLength = Number(request.headers.get("x-upload-chunk-size"));
    const result = await appendVideoStageChunk(request, uploadId, offset, declaredLength);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return stageFailure(error);
  }
}

export async function DELETE(request: Request) {
  const denied = requireLocalBrowserRequest(request);
  if (denied) return denied;

  try {
    const body = await readSmallJson(request);
    const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
    await removeVideoStage(uploadId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return stageFailure(error);
  }
}
