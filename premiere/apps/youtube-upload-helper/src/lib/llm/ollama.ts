import type { LlmCallOptions, LlmCallResult, OllamaConfig } from "./types";

/**
 * Ollama native `/api/chat` 호출.
 *
 * 왜 OpenAI 호환 (`/v1/chat/completions`)을 안 쓰는가:
 * - OpenAI 호환 모드는 `keep_alive`, `think:false` 같은 Ollama 전용 옵션을 전달할
 *   표준이 없다. 그러면 think=true 기본으로 떨어져 reasoning 모델에서 thinking이
 *   폭발한다.
 * - native API는 이 옵션을 명시 가능 → think OFF로 자막 번역에 적합.
 *
 * num_ctx 정책 (m35-c, 사용자 지침):
 * - num_ctx는 호출에 박지 않는다. Ollama 서버 전역(OLLAMA_CONTEXT_LENGTH 환경변수)
 *   설정을 그대로 따라간다. 그래야 사용자가 KV cache 양자화·context 크기를 Ollama
 *   쪽에서 한 번 바꾸면 우리 앱도 자동으로 동기화된다.
 * - settings.ollama.numCtx는 청크 분할 계산에만 쓰이고, 호출 옵션에는 전달하지
 *   않는다.
 *
 * 그 외 옵션:
 * - think: false                — reasoning 모델의 thinking 끈다.
 * - keep_alive: "30m" (기본)    — 모델 VRAM 유지 시간 (사용자 설정 따라감).
 * - num_predict: -1             — 응답 토큰 무제한 (모델이 stop token까지 자연 종료).
 * - temperature: 0.45 (default) — 자막 번역에 적당.
 */

type OllamaChatResponse = {
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
  };
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  error?: string;
};

function normalizeBaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, "") // trailing slash 제거
    .replace(/\/v1$/, ""); // 사용자가 OpenAI compat용 baseUrl을 실수로 넣어도 native로 보정
}

export async function callOllama(
  config: OllamaConfig,
  options: LlmCallOptions,
): Promise<LlmCallResult> {
  if (!config.baseUrl?.trim()) {
    throw new Error("Ollama 서버 주소가 비어 있습니다.");
  }
  if (!config.model?.trim()) {
    throw new Error("Ollama 모델 이름이 비어 있습니다.");
  }

  const baseUrl = normalizeBaseUrl(config.baseUrl);

  const body = {
    model: config.model,
    stream: false,
    // think: false — reasoning 모델(gemma4, qwen3 등)의 thinking 모드 OFF.
    // 모델이 지원 안 하면 무시됨.
    think: false,
    keep_alive: config.keepAlive || "30m",
    messages: [
      { role: "system", content: options.systemPrompt },
      { role: "user", content: options.userPrompt },
    ],
    options: {
      // num_predict: 로컬 LLM 운영 지침 — 출력 토큰은 기본 -1(무제한)로 둔다.
      // 모델이 stop token / num_ctx 한계까지 자연스럽게 끝내게 두고, 에이전트가
      // 출력 길이를 임의로 제한하지 않는다. 호출자(translate 등)가 넘기는
      // options.maxTokens는 anthropic / openai-compat처럼 max_tokens가 필수인
      // provider 전용이며, Ollama native 호출에는 적용하지 않는다.
      num_predict: -1,
      // num_ctx는 의도적으로 보내지 않는다. Ollama 서버 전역(OLLAMA_CONTEXT_LENGTH)
      // 또는 모델 Modelfile의 PARAMETER 설정을 그대로 따라간다 — 사용자가 KV cache·
      // context 크기를 Ollama 쪽에서 바꾸면 우리 앱도 자동 동기화. 자세한 정책은
      // 파일 상단 헤더 주석 참고.
      temperature: options.temperature ?? config.temperature ?? 0.45,
    },
  };

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(
      `Ollama 서버에 연결하지 못했습니다 (${baseUrl}/api/chat): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Ollama ${response.status} ${response.statusText} — ${text.slice(0, 300)}`,
    );
  }

  const data = (await response.json()) as OllamaChatResponse;

  if (data.error) {
    throw new Error(`Ollama 오류: ${data.error}`);
  }

  const text = data.message?.content ?? "";
  // think:false라도 일부 모델/버전은 thinking 본문을 message.thinking에 채워 보낸다.
  const thinking = typeof data.message?.thinking === "string" ? data.message.thinking : "";

  return {
    text,
    reasoningText: thinking.length > 0 ? thinking : undefined,
    inputTokens: data.prompt_eval_count,
    outputTokens: data.eval_count,
  };
}
