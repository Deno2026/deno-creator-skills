import { NextResponse } from "next/server";

import { parseCuesInput } from "@/lib/llm/cue-input";
import { translateSubtitles } from "@/lib/llm/translate";
import type { LlmCallDebug } from "@/lib/llm/types";

export const runtime = "nodejs";
export const maxDuration = 300;

type TranslateRequestBody = {
  cues?: unknown;
  targetLanguage?: unknown;
  /** true면 응답에 청크별 입출력 로그(`debugLogs`)를 포함한다. */
  includeDebug?: unknown;
};

export async function POST(request: Request) {
  let body: TranslateRequestBody;

  try {
    body = (await request.json()) as TranslateRequestBody;
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
      { ok: false, error: "번역할 자막 줄이 없습니다." },
      { status: 400 },
    );
  }

  if (typeof body.targetLanguage !== "string" || !body.targetLanguage.trim()) {
    return NextResponse.json(
      { ok: false, error: "targetLanguage 코드가 필요합니다." },
      { status: 400 },
    );
  }

  const targetLanguage = body.targetLanguage.trim();
  const includeDebug = body.includeDebug === true;

  const debugLogs: LlmCallDebug[] = [];

  try {
    const translated = await translateSubtitles(cues, targetLanguage, {
      onDebug: includeDebug ? (entry) => debugLogs.push(entry) : undefined,
    });
    return NextResponse.json({
      ok: true,
      targetLanguage,
      cues: translated,
      ...(includeDebug ? { debugLogs } : {}),
    });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "AI 자막 번역에 실패했습니다.";
    return NextResponse.json(
      {
        ok: false,
        targetLanguage,
        error: detail,
        ...(includeDebug && debugLogs.length > 0 ? { debugLogs } : {}),
      },
      { status: 500 },
    );
  }
}
