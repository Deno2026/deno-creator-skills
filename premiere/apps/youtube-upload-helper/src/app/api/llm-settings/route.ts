import { NextResponse } from "next/server";

import { loadLlmSettings, saveLlmSettings } from "@/lib/llm/settings";
import type { LlmSettings } from "@/lib/llm/types";

export const runtime = "nodejs";

function maskApiKey(value: string | undefined) {
  if (!value) return "";
  return value.length <= 8 ? "********" : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function publicLlmSettings(settings: LlmSettings) {
  return {
    ...settings,
    anthropic: {
      ...settings.anthropic,
      apiKey: "",
      hasApiKey: Boolean(settings.anthropic.apiKey),
      apiKeyPreview: maskApiKey(settings.anthropic.apiKey),
    },
    openaiCompat: {
      ...settings.openaiCompat,
      apiKey: "",
      hasApiKey: Boolean(settings.openaiCompat.apiKey),
      apiKeyPreview: maskApiKey(settings.openaiCompat.apiKey),
    },
  };
}

export async function GET() {
  try {
    const settings = await loadLlmSettings();
    return NextResponse.json({ ok: true, settings: publicLlmSettings(settings) });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "LLM 설정을 읽지 못했습니다.";
    return NextResponse.json({ ok: false, error: detail }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: Partial<LlmSettings>;

  try {
    body = (await request.json()) as Partial<LlmSettings>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "요청 본문을 JSON으로 읽지 못했습니다." },
      { status: 400 },
    );
  }

  try {
    const existing = await loadLlmSettings();
    const saved = await saveLlmSettings({
      ...body,
      anthropic: {
        ...existing.anthropic,
        ...body.anthropic,
        apiKey: body.anthropic?.apiKey?.trim()
          ? body.anthropic.apiKey
          : existing.anthropic.apiKey,
      },
      openaiCompat: {
        ...existing.openaiCompat,
        ...body.openaiCompat,
        apiKey: body.openaiCompat?.apiKey?.trim()
          ? body.openaiCompat.apiKey
          : existing.openaiCompat.apiKey,
      },
    });
    return NextResponse.json({ ok: true, settings: publicLlmSettings(saved) });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "LLM 설정을 저장하지 못했습니다.";
    return NextResponse.json({ ok: false, error: detail }, { status: 500 });
  }
}
