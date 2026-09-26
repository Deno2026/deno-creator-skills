import { callAnthropic } from "./anthropic";
import { checkComfyuiBusy } from "./comfyui-precheck";
import { callOllama } from "./ollama";
import { callOpenAiCompat } from "./openai-compat";
import type { LlmCallOptions, LlmCallResult, LlmSettings } from "./types";

/**
 * 설정의 provider 값에 따라 Anthropic / OpenAI 호환 / Ollama 호출로 라우팅한다.
 * 사용 코드(refine, translate 등)는 항상 callLlm만 호출하면 된다.
 *
 * Ollama provider는 호출 전 ComfyUI 큐 점검도 같이 수행 (사용자 설정에 따라).
 */
export async function callLlm(
  settings: LlmSettings,
  options: LlmCallOptions,
): Promise<LlmCallResult> {
  if (settings.provider === "anthropic") {
    return callAnthropic(settings.anthropic, options);
  }

  if (settings.provider === "openai-compat") {
    return callOpenAiCompat(settings.openaiCompat, options);
  }

  if (settings.provider === "ollama") {
    if (settings.ollamaCheckComfyui) {
      const comfyui = await checkComfyuiBusy();
      if (comfyui.busy) {
        throw new Error(comfyui.reason ?? "ComfyUI가 작업 중입니다. Ollama 호출을 차단했습니다.");
      }
    }
    return callOllama(settings.ollama, options);
  }

  throw new Error(`알 수 없는 AI 공급자: ${settings.provider as string}`);
}
