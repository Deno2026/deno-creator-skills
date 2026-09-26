import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

import { requireLocalBrowserRequest } from "@/lib/local-request-guard";
import {
  VideoStageError,
  getVideoStageReadSource,
} from "@/lib/video-upload-staging";

export const runtime = "nodejs";

function parseRange(value: string | null, size: number) {
  if (!value) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value.trim());
  if (!match) throw new VideoStageError(416, "INVALID_RANGE", "영상 미리보기 범위가 올바르지 않습니다.");
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  const end = Math.min(requestedEnd, size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
    throw new VideoStageError(416, "INVALID_RANGE", "영상 미리보기 범위가 올바르지 않습니다.");
  }
  return { start, end };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const denied = requireLocalBrowserRequest(request);
  if (denied) return denied;

  try {
    const { id } = await context.params;
    const source = await getVideoStageReadSource(id);
    const range = parseRange(request.headers.get("range"), source.size);
    const start = range?.start ?? 0;
    const end = range?.end ?? source.size - 1;
    const body = Readable.toWeb(
      createReadStream(source.filePath, { start, end }),
    ) as ReadableStream<Uint8Array>;
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Length": String(end - start + 1),
        "Content-Type": source.type,
        ...(range
          ? { "Content-Range": `bytes ${start}-${end}/${source.size}` }
          : {}),
      },
    });
  } catch (error) {
    if (error instanceof VideoStageError) {
      return NextResponse.json(
        { ok: false, error: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { ok: false, error: "VIDEO_PREVIEW_FAILED" },
      { status: 500 },
    );
  }
}
