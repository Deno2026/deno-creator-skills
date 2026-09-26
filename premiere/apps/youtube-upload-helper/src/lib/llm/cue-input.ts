import type { SubtitleCue } from "./types";

/**
 * 자막 텍스트의 HTML/SRT 서식 태그 제거 (<b>, <i>, <u>, <font ...> 등).
 *
 * m33: 프리미어 등에서 export된 SRT에 <b>...</b> 볼드 태그가 들어오는 경우가
 * 있다. 그대로 LLM에 보내면 입력 토큰 낭비 + 모델이 출력에 태그를 흉내내는
 * 혼란이 생긴다. 모든 자막 LLM 입력의 공통 관문인 parseCuesInput에서 한 번
 * 정제한다.
 *
 * 안전성: 여는 태그(`<`)와 닫는 `>`가 모두 있고 태그명이 알파벳으로 시작할
 * 때만 매칭한다. "a < b" 같은 일반 부등호 텍스트는 건드리지 않는다.
 */
function stripCueHtmlTags(text: string): string {
  return text.replace(/<\/?[a-zA-Z][^>]*>/g, "").trim();
}

/**
 * API 요청 body의 unknown 값을 SubtitleCue[]로 파싱.
 * 형식이 어긋나면 null 반환 (호출자가 400 응답 처리).
 *
 * /api/refine, /api/translate, /api/suggest-metadata, /api/suggest-chapters가 공유.
 * 텍스트는 HTML 서식 태그를 제거한 뒤 담는다 (m33).
 */
export function parseCuesInput(value: unknown): SubtitleCue[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const cues: SubtitleCue[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") {
      return null;
    }

    const entry = item as Partial<SubtitleCue>;

    if (
      typeof entry.index !== "number" ||
      typeof entry.startMs !== "number" ||
      typeof entry.endMs !== "number" ||
      typeof entry.text !== "string"
    ) {
      return null;
    }

    cues.push({
      index: entry.index,
      startMs: entry.startMs,
      endMs: entry.endMs,
      text: stripCueHtmlTags(entry.text),
    });
  }

  return cues;
}
