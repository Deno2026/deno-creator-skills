import { NextResponse } from "next/server";

import { parseCuesInput } from "@/lib/llm/cue-input";
import { refineSubtitles } from "@/lib/llm/refine";

export const runtime = "nodejs";
export const maxDuration = 300;

type RefineRequestBody = {
  cues?: unknown;
};

export async function POST(request: Request) {
  let body: RefineRequestBody;

  try {
    body = (await request.json()) as RefineRequestBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문을 JSON으로 읽지 못했습니다." },
      { status: 400 },
    );
  }

  const cues = parseCuesInput(body.cues);

  if (!cues) {
    return NextResponse.json(
      { ok: false, error: "cues 배열 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  if (cues.length === 0) {
    return NextResponse.json(
      { ok: false, error: "다듬을 자막 줄이 없습니다." },
      { status: 400 },
    );
  }

  try {
    const refined = await refineSubtitles(cues);
    return NextResponse.json({ ok: true, cues: refined });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "AI 자막 다듬기에 실패했습니다.";
    return NextResponse.json({ ok: false, error: detail }, { status: 500 });
  }
}
