import OpenAI from "openai";

import type { LlmCallOptions, LlmCallResult, OpenAiCompatConfig } from "./types";

export async function callOpenAiCompat(
  config: OpenAiCompatConfig,
  options: LlmCallOptions,
): Promise<LlmCallResult> {
  if (!config.baseUrl) {
    throw new Error("OpenAI 호환 서버 주소가 설정되어 있지 않습니다.");
  }

  if (!config.model) {
    throw new Error("OpenAI 호환 모델 이름이 설정되어 있지 않습니다.");
  }

  // OpenAI SDK는 apiKey가 빈 문자열이면 에러를 낸다.
  // Ollama 같은 로컬은 인증을 안 보지만 SDK가 보내는 헤더 자체는 필요하므로 더미 값을 채운다.
  const client = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey?.trim() || "local-no-auth",
  });

  const completion = await client.chat.completions.create({
    model: config.model,
    max_tokens: options.maxTokens ?? 4096,
    temperature: options.temperature ?? 0.3,
    messages: [
      { role: "system", content: options.systemPrompt },
      { role: "user", content: options.userPrompt },
    ],
  });

  const message = completion.choices[0]?.message;
  const text = message?.content ?? "";

  // Reasoning 모델(gemma4, deepseek-r1 등)은 `message.reasoning` 으로
  // thinking 본문을 따로 보낸다. OpenAI SDK 공식 타입에는 없어서 unknown 캐스팅.
  const reasoningTextRaw = (message as unknown as { reasoning?: unknown } | undefined)
    ?.reasoning;
  const reasoningText =
    typeof reasoningTextRaw === "string" && reasoningTextRaw.length > 0
      ? reasoningTextRaw
      : undefined;

  return {
    text,
    reasoningText,
    inputTokens: completion.usage?.prompt_tokens,
    outputTokens: completion.usage?.completion_tokens,
  };
}
