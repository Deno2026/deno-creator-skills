import { NextResponse } from "next/server";

import { callLlm } from "@/lib/llm/provider";
import { loadLlmSettings } from "@/lib/llm/settings";
import type { LlmSettings } from "@/lib/llm/types";

export const runtime = "nodejs";
export const maxDuration = 60;

function activeModelLabel(settings: LlmSettings) {
  if (settings.provider === "anthropic") return settings.anthropic.model;
  if (settings.provider === "ollama") return settings.ollama.model;
  return settings.openaiCompat.model;
}

/**
 * 설정 화면의 [연결 테스트] 버튼이 호출.
 * 짧은 프롬프트 하나만 보내서 모델이 응답하면 OK.
 */
export async function POST() {
  let settings: Awaited<ReturnType<typeof loadLlmSettings>>;

  try {
    settings = await loadLlmSettings();
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "LLM 설정을 읽지 못했습니다.";
    return NextResponse.json(
      { ok: false, stage: "load-settings", error: detail },
      { status: 500 },
    );
  }

  try {
    const result = await callLlm(settings, {
      systemPrompt: "You are a connectivity test. Reply with exactly 'OK'.",
      userPrompt: "ping",
      // 512: reasoning 모델(gemma4, deepseek-r1 등)이 thinking에 토큰을 쓰고도
      // content에 "OK"를 남길 여유. 일반 instruct 모델은 1~5 토큰만 쓰고 끝남.
      maxTokens: 512,
      temperature: 0,
    });

    return NextResponse.json({
      ok: true,
      provider: settings.provider,
      model: activeModelLabel(settings),
      reply: result.text.trim(),
      reasoningText: result.reasoningText,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "AI 모델 호출에 실패했습니다.";
    return NextResponse.json(
      {
        ok: false,
        stage: "llm-call",
        provider: settings.provider,
        error: detail,
      },
      { status: 500 },
    );
  }
}
