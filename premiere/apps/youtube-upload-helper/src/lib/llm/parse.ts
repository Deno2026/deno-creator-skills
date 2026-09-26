/**
 * LLM 응답에서 JSON 추출.
 *
 * 시스템 프롬프트로 "JSON만 반환" 지시했지만 모델이 ```json … ``` 코드블록을
 * 감싸서 응답하는 경우가 흔하다. 그것까지 벗겨내고 파싱한다.
 */

export function extractJson<T = unknown>(rawText: string): T {
  const trimmed = rawText.trim();

  // deepseek-r1 등 일부 reasoning 모델은 응답 본문에 <think>...</think> 블록을 직접 넣는다.
  // (OpenAI 호환 message.reasoning 필드를 안 쓰는 경우.) 먼저 제거.
  const withoutThink = trimmed.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  const withoutCodeFence = withoutThink
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(withoutCodeFence) as T;
  } catch {
    // 모델이 응답 앞뒤에 짧은 안내문을 붙인 경우 JSON 블록만 따로 시도.
    const jsonBlockMatch = withoutCodeFence.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);

    if (jsonBlockMatch) {
      return JSON.parse(jsonBlockMatch[1]) as T;
    }

    throw new Error("AI 응답을 JSON으로 해석하지 못했습니다.");
  }
}
