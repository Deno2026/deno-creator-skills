/**
 * LLM 관련 공통 타입.
 *
 * 자막 편집은 프리미어가 담당하고, 이 앱은 자막 다듬기·번역·메타 추천만
 * LLM으로 자동화한다. 그래서 lib/llm/은 lib/srt에 의존하지 않는다 (단방향).
 * SubtitleCue는 SrtCue에서 클라이언트 식별자(id)만 뺀 모양이다.
 */

export type SubtitleCue = {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
};

export type LlmProvider = "anthropic" | "openai-compat" | "ollama";

export type AnthropicConfig = {
  apiKey: string;
  model: string;
};

export type OpenAiCompatConfig = {
  /** 예: OpenAI, Gemini, LM Studio, OpenRouter 등 OpenAI 호환 Base URL. */
  baseUrl: string;
  /** 로컬 서버는 빈 값 OK. 클라우드 API는 보통 필수. */
  apiKey?: string;
  model: string;
};

/**
 * Ollama native API용 설정.
 *
 * OpenAI 호환 (`/v1/chat/completions`)은 `keep_alive`, `think:false` 같은
 * Ollama 전용 옵션을 못 보내서 reasoning 모델 thinking이 폭발한다. 그래서
 * native `/api/chat`을 쓴다.
 *
 * num_ctx 정책 (m35-c):
 *   - 호출 시 num_ctx는 보내지 않는다. Ollama 전역(OLLAMA_CONTEXT_LENGTH)을 따라간다.
 *   - 아래 numCtx 필드는 청크 분할 계산용 기준값으로만 사용된다.
 *
 * baseUrl: native API 루트 (예: `http://127.0.0.1:11434`). `/v1` suffix는 자동 제거.
 */
export type OllamaConfig = {
  baseUrl: string;
  model: string;
  /**
   * 자막 청크 분할 계산용 기준 컨텍스트 크기 (토큰).
   * Ollama 호출에는 전달되지 않는다 — Ollama 서버 전역(OLLAMA_CONTEXT_LENGTH) 또는
   * 모델 Modelfile 설정을 그대로 따라간다.
   * 사용자가 Ollama 쪽 OLLAMA_CONTEXT_LENGTH와 같은 값으로 입력해두면 청크 분할이
   * 가장 효율적이다 (1청크로 처리되는 비율 최대화).
   */
  numCtx: number;
  /** keep_alive — 모델 VRAM 유지 시간. 예: "30m". */
  keepAlive: string;
  /** temperature. 권장 0.45 (자막 번역도 OK). */
  temperature: number;
};

export type LlmSettings = {
  provider: LlmProvider;
  anthropic: AnthropicConfig;
  openaiCompat: OpenAiCompatConfig;
  ollama: OllamaConfig;
  /** Ollama 호출 전 ComfyUI(127.0.0.1:8188) queue_running 점검 여부. */
  ollamaCheckComfyui: boolean;
  /** 메인 화면에서 자막을 넣으면 메타 추천을 자동으로 받을지 여부. */
  autoSuggestMetadata: boolean;
  /** 다국어 번역 대상 언어 코드. YouTube BCP-47 기준. */
  targetLanguages: string[];
};

export type LlmCallOptions = {
  systemPrompt: string;
  userPrompt: string;
  /** 모델 출력 최대 토큰. 미지정 시 4096. */
  maxTokens?: number;
  /** 0~1. 미지정 시 0.3. */
  temperature?: number;
};

export type LlmCallResult = {
  text: string;
  /**
   * Reasoning 모델 (gemma4, deepseek-r1 등)이 thinking 단계에 출력한 내용.
   * OpenAI 호환 서버 일부가 `message.reasoning` 으로 제공한다.
   * 본 응답(text)이 비어 보일 때 진단 단서가 된다.
   */
  reasoningText?: string;
  inputTokens?: number;
  outputTokens?: number;
};

/**
 * 한 번의 LLM 호출(자막 청크 / 메타 번역 / 메타 추천)의 입출력 기록.
 *
 * 페이지에서 "모델 입출력 보기" 카드에 펼치기 형식으로 표시하기 위해 사용한다.
 * 디스크에 저장하지 않고 메모리(React state)에만 유지. 사용자가 [리셋] 또는 새
 * 자동 처리 시작 시 비워진다.
 */
export type LlmCallDebug = {
  /**
   * "subtitle"=자막 청크, "metadata"=제목·설명 번역, "suggest"=메타 추천,
   * "chapters"=영상 챕터 생성.
   */
  kind: "subtitle" | "metadata" | "suggest" | "chapters";
  /** 대상 언어 코드. suggest는 한국어 기준이라 undefined. */
  language?: string;
  /** 자막 청크 인덱스 (0-based). 자막일 때만 채워짐. */
  chunkIndex?: number;
  /** 청크 시작 cue 번호 (1-based, 전체 자막 기준). 자막일 때만. */
  startCueIdx?: number;
  /** 청크 끝 cue 번호 (1-based, 포함). 자막일 때만. */
  endCueIdx?: number;
  systemPrompt: string;
  userPrompt: string;
  /** 모델 raw 응답 텍스트. parseIndexedResponse 적용 전. */
  rawResponse: string;
  /** thinking 본문이 별도로 왔으면. */
  reasoningText?: string;
  /** 자막 청크: cover된 인덱스 수. */
  foundCount?: number;
  /** 자막 청크: 누락된 인덱스 (원문 한국어로 fallback된 것). */
  missingIndices?: number[];
  inputTokens?: number;
  outputTokens?: number;
  /** 호출 소요 시간 (ms). */
  durationMs: number;
  /** 자막 청크: 재시도 호출이었는지. */
  retried: boolean;
  /** 자막 청크: 재시도까지 완전 실패해 [번역 실패] 마커가 붙은 청크인지. */
  failed: boolean;
};
