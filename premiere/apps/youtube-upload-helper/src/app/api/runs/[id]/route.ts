import { NextResponse } from "next/server";

import { loadUploadRun } from "@/lib/upload-run-store";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const run = await loadUploadRun(decodeURIComponent(id));

  if (!run) {
    return NextResponse.json(
      { ok: false, error: "업로드 실행 기록을 찾지 못했습니다." },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, run });
}
