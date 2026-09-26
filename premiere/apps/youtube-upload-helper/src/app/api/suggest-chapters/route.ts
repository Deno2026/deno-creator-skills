import { NextResponse } from "next/server";

import { parseCuesInput } from "@/lib/llm/cue-input";
import { suggestChapters } from "@/lib/llm/chapters";
import type { LlmCallDebug } from "@/lib/llm/types";

export const runtime = "nodejs";
export const maxDuration = 300;

type SuggestChaptersRequestBody = {
  cues?: unknown;
  includeDebug?: unknown;
};

export async function POST(request: Request) {
  let body: SuggestChaptersRequestBody;
  try {
    body = (await request.json()) as SuggestChaptersRequestBody;
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
      { ok: false, error: "챕터 생성을 위한 자막 줄이 없습니다." },
      { status: 400 },
    );
  }

  const includeDebug = body.includeDebug === true;
  const debugLogs: LlmCallDebug[] = [];

  try {
    const suggestion = await suggestChapters(cues, {
      onDebug: includeDebug ? (entry) => debugLogs.push(entry) : undefined,
    });
    return NextResponse.json({
      ok: true,
      suggestion,
      ...(includeDebug ? { debugLogs } : {}),
    });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "AI 챕터 생성에 실패했습니다.";
    return NextResponse.json(
      {
        ok: false,
        error: detail,
        ...(includeDebug && debugLogs.length > 0 ? { debugLogs } : {}),
      },
      { status: 500 },
    );
  }
}
