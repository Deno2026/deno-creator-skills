import { NextResponse } from "next/server";

import { parseCuesInput } from "@/lib/llm/cue-input";
import { suggestMetadata } from "@/lib/llm/suggest-meta";
import type { LlmCallDebug } from "@/lib/llm/types";

export const runtime = "nodejs";
export const maxDuration = 600;

type SuggestMetadataRequestBody = {
  cues?: unknown;
  includeDebug?: unknown;
};

export async function POST(request: Request) {
  let body: SuggestMetadataRequestBody;

  try {
    body = (await request.json()) as SuggestMetadataRequestBody;
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
      { ok: false, error: "메타 추천을 위한 자막 줄이 없습니다." },
      { status: 400 },
    );
  }

  const includeDebug = body.includeDebug === true;
  const debugLogs: LlmCallDebug[] = [];

  try {
    const suggestion = await suggestMetadata(cues, {
      onDebug: includeDebug ? (entry) => debugLogs.push(entry) : undefined,
    });
    return NextResponse.json({
      ok: true,
      titleCandidates: suggestion.titleCandidates,
      descriptionCandidates: suggestion.descriptionCandidates,
      tags: suggestion.tags,
      ...(includeDebug ? { debugLogs } : {}),
    });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "AI 메타 추천에 실패했습니다.";
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
