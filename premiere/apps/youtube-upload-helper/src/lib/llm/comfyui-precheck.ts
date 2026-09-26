/**
 * ComfyUI(`http://127.0.0.1:8188`)가 현재 작업 중인지 확인.
 *
 * 사용자 환경에 ComfyUI와 Ollama가 같은 GPU에서 도는 경우, ComfyUI가 작업 중일 때
 * Ollama가 끼면 VRAM 분배가 깨져서 CPU offload로 떨어진다. 그래서 Ollama 호출 전에
 * ComfyUI 큐 상태를 점검한다.
 *
 * 판단 규칙:
 * - 8188 응답 없음(=ComfyUI 꺼짐) → 차단 사유 아님 (false)
 * - 응답 있고 queue_running 비어 있음 → 차단 사유 아님 (false)
 * - queue_running에 항목 있음 → busy (true)
 *
 * (Gemma4가 이미 VRAM에 올라간 것은 정상 재사용 상태이므로 차단 사유가 아니다.
 *  그 판단은 ollama ps로만 정확히 가능하므로 여기서는 안 본다.)
 */

export type ComfyuiCheckResult = {
  /** 호출을 차단해야 하는지. */
  busy: boolean;
  /** 차단 시 사용자에게 보여줄 사유. */
  reason?: string;
};

export async function checkComfyuiBusy(): Promise<ComfyuiCheckResult> {
  try {
    const response = await fetch("http://127.0.0.1:8188/queue", {
      // 빠른 점검 — 2초 안에 응답 없으면 꺼져있는 걸로 본다.
      signal: AbortSignal.timeout(2000),
      cache: "no-store",
    });

    if (!response.ok) {
      // 응답은 왔는데 200 아님 — 비정상이지만 차단 사유로는 보지 않음.
      return { busy: false };
    }

    const data = (await response.json()) as {
      queue_running?: unknown[];
      queue_pending?: unknown[];
    };

    const runningCount = Array.isArray(data.queue_running) ? data.queue_running.length : 0;

    if (runningCount > 0) {
      return {
        busy: true,
        reason: `ComfyUI가 ${runningCount}건 작업 중입니다 (queue_running). Ollama 호출을 차단했습니다. ComfyUI 작업이 끝난 뒤 다시 시도하거나, 설정에서 [ComfyUI 점검]을 꺼서 강제 실행할 수 있습니다.`,
      };
    }

    return { busy: false };
  } catch {
    // ComfyUI 꺼져 있음 / 네트워크 안 됨 — 차단 사유 아님.
    return { busy: false };
  }
}
