/**
 * 영상 챕터 자동 생성 — 자막을 보고 3가지 상세도의 타임스탬프 목차를 만든다.
 *
 * suggest-meta처럼 자막 전체를 한 번에 본다 (챕터는 영상 흐름 전체를 봐야 함).
 * 응답은 작아서(~1K 토큰) 입력만 큰 호출.
 *
 * YouTube 챕터 규칙 (정규화 단계에서 강제):
 * - 첫 챕터는 00:00.
 * - 최소 3개 이상.
 * - 각 챕터 최소 10초 간격.
 */

import { extractJson } from "./parse";
import { callLlm } from "./provider";
import { loadLlmSettings } from "./settings";
import type { LlmCallDebug, SubtitleCue } from "./types";
import { buildChannelContextKorean } from "@/lib/channel-profile-types";
import { loadChannelProfile } from "@/lib/youtube-storage";
import {
  msToTimestamp,
  timestampToMs,
  type ChapterEntry,
  type ChapterSuggestion,
} from "@/lib/chapter-types";

export type SuggestChaptersOptions = {
  onDebug?: (entry: LlmCallDebug) => void;
};

/** 각 상세도의 최소 챕터 간격 (ms). YouTube 규칙은 10초. */
const MIN_CHAPTER_GAP_MS = 10_000;

// /no_think: Qwen3 계열 thinking OFF.
const CHAPTER_SYSTEM_PROMPT = `/no_think

한국어 영상 자막을 보고 YouTube 영상 챕터(타임스탬프 목차)를 3가지 상세도로 만듭니다.

입력: 각 줄이 \`[mm:ss] 자막 내용\` 형식.

3가지 상세도:
- simple: 큰 흐름만. 챕터 3~5개.
- medium: 적당히. 챕터 6~10개.
- detailed: 세부적으로. 챕터 11~20개.

규칙 (YouTube 챕터 규칙 — 반드시 지킴):
- 첫 챕터는 반드시 00:00.
- 각 챕터는 앞 챕터보다 최소 10초 이후.
- 시각은 오름차순.
- 챕터 시각은 입력 자막에 실제로 나오는 [mm:ss] 중에서 고른다. 없는 시각을 만들지 않는다.
- 챕터 제목은 그 구간 내용을 압축한 한국어 명사구. 6~20자 권장.
- 과장·낚시성 표현 금지. 영상 내용을 정확히 대표하는 담백한 제목.

JSON으로만 반환. 설명문·코드블록·thinking 본문 금지.

출력 형식:
{"simple":[{"time":"00:00","title":"인트로"},{"time":"02:30","title":"모델 설치"}],"medium":[...],"detailed":[...]}`;

function buildChapterInput(cues: SubtitleCue[]): string {
  return cues
    .map((cue) => {
      const text = cue.text.trim().replace(/\s+/g, " ");
      if (!text) return "";
      return `[${msToTimestamp(cue.startMs)}] ${text}`;
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * LLM이 돌려준 챕터 배열을 검증·보정.
 * - time 파싱 실패/제목 없음 → 버림
 * - 오름차순 정렬
 * - 첫 항목 00:00 강제
 * - 10초 미만 간격 항목 제거
 */
function normalizeChapterList(raw: unknown): ChapterEntry[] {
  if (!Array.isArray(raw)) return [];

  const parsed: ChapterEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as { time?: unknown; title?: unknown };
    if (typeof obj.time !== "string" || typeof obj.title !== "string") continue;
    const ms = timestampToMs(obj.time);
    if (ms === null) continue;
    const title = obj.title.trim();
    if (!title) continue;
    parsed.push({ timeMs: ms, title });
  }

  parsed.sort((a, b) => a.timeMs - b.timeMs);

  // 첫 항목 00:00 강제.
  if (parsed.length > 0 && parsed[0].timeMs !== 0) {
    parsed[0] = { ...parsed[0], timeMs: 0 };
  }

  // 10초 미만 간격 항목 제거 (앞 챕터 유지).
  const result: ChapterEntry[] = [];
  for (const entry of parsed) {
    if (result.length === 0) {
      result.push(entry);
      continue;
    }
    const last = result[result.length - 1];
    if (entry.timeMs - last.timeMs >= MIN_CHAPTER_GAP_MS) {
      result.push(entry);
    }
  }
  return result;
}

export async function suggestChapters(
  cues: SubtitleCue[],
  options: SuggestChaptersOptions = {},
): Promise<ChapterSuggestion> {
  if (cues.length === 0) {
    return { simple: [], medium: [], detailed: [] };
  }

  const settings = await loadLlmSettings();
  const channelProfile = await loadChannelProfile();
  const channelContext = buildChannelContextKorean(channelProfile);

  const systemPrompt = channelContext
    ? `${channelContext}\n\n${CHAPTER_SYSTEM_PROMPT}`
    : CHAPTER_SYSTEM_PROMPT;

  const userPrompt = `다음 자막을 보고 챕터를 만들어 주세요.\n\n${buildChapterInput(cues)}`;

  const startedAt = Date.now();
  const result = await callLlm(settings, {
    systemPrompt,
    userPrompt,
    // 응답: 챕터 3세트 (최대 ~35개 항목). 넉넉히.
    maxTokens: 8192,
    temperature: 0,
  });
  const durationMs = Date.now() - startedAt;

  options.onDebug?.({
    kind: "chapters",
    systemPrompt,
    userPrompt,
    rawResponse: result.text,
    reasoningText: result.reasoningText,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs,
    retried: false,
    failed: false,
  });

  const parsed = extractJson<{
    simple?: unknown;
    medium?: unknown;
    detailed?: unknown;
  }>(result.text);

  return {
    simple: normalizeChapterList(parsed.simple),
    medium: normalizeChapterList(parsed.medium),
    detailed: normalizeChapterList(parsed.detailed),
  };
}
