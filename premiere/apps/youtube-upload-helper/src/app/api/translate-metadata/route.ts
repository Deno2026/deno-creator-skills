import { NextResponse } from "next/server";

import { translateMetadata } from "@/lib/llm/translate-meta";
import type { LlmCallDebug } from "@/lib/llm/types";

export const runtime = "nodejs";
export const maxDuration = 600;

type TranslateMetadataRequestBody = {
  title?: unknown;
  description?: unknown;
  targetLanguage?: unknown;
  includeDebug?: unknown;
};

export async function POST(request: Request) {
  let body: TranslateMetadataRequestBody;

  try {
    body = (await request.json()) as TranslateMetadataRequestBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문을 JSON으로 읽지 못했습니다." },
      { status: 400 },
    );
  }

  if (typeof body.title !== "string" || !body.title.trim()) {
    return NextResponse.json(
      { ok: false, error: "한국어 제목이 필요합니다." },
      { status: 400 },
    );
  }

  if (typeof body.description !== "string" || !body.description.trim()) {
    return NextResponse.json(
      { ok: false, error: "한국어 설명이 필요합니다." },
      { status: 400 },
    );
  }

  if (typeof body.targetLanguage !== "string" || !body.targetLanguage.trim()) {
    return NextResponse.json(
      { ok: false, error: "targetLanguage 코드가 필요합니다." },
      { status: 400 },
    );
  }

  const title = body.title.trim();
  const description = body.description;
  const targetLanguage = body.targetLanguage.trim();
  const includeDebug = body.includeDebug === true;

  const debugLogs: LlmCallDebug[] = [];

  try {
    const translated = await translateMetadata(title, description, targetLanguage, {
      onDebug: includeDebug ? (entry) => debugLogs.push(entry) : undefined,
    });
    return NextResponse.json({
      ok: true,
      targetLanguage,
      title: translated.title,
      description: translated.description,
      ...(includeDebug ? { debugLogs } : {}),
    });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "AI 메타 번역에 실패했습니다.";
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
