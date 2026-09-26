import { callLlm } from "./provider";
import { loadLlmSettings } from "./settings";
import type { LlmCallDebug, LlmSettings, SubtitleCue } from "./types";
import {
  buildChannelContextForTranslation,
  type ChannelProfile,
} from "@/lib/channel-profile-types";
import { loadChannelProfile } from "@/lib/youtube-storage";

export type TranslateOptions = {
  /**
   * 호출 입출력 기록 콜백. 매 청크 호출(재시도 포함)마다 한 번씩 호출됨.
   * UI "모델 입출력 보기"에서 펼치기로 표시하기 위해 사용.
   */
  onDebug?: (entry: LlmCallDebug) => void;
};

/**
 * 자막 번역 — 동적 청크 사이즈 + 인덱스 prefix + 부분 성공 허용.
 *
 * m22까지의 문제:
 * - 모델이 가끔 짧은 자막을 합치거나 빠뜨림 (qwen3.6, gemma4 둘 다 관찰됨).
 * - "응답 cue 수 != 입력 cue 수"면 청크 통째 [번역 실패] 마커. 너무 야박함.
 *
 * m24 fix:
 * - 입력 각 자막 앞에 `[N]` 인덱스 prefix를 박는다. N은 청크 내 1-based.
 * - 모델한테 "prefix 그대로 유지하면서 텍스트만 번역" 시킴.
 * - 응답에서 `[N] text` 매칭으로 정확한 cue index에 매핑.
 * - 빠진 index는 원문 한국어 유지, 나머지는 번역 결과 사용.
 * - 완전 실패(0개 매칭) 시에만 재시도. 부분 매칭은 그대로 사용.
 * - 응답 part에서 HTML 태그(<b> 등), 마크다운 강조, 따옴표 wrapper 자동 제거.
 *
 * m25: 청크 내부에서 [N-M] 머지 허용 (어순 차이 대응).
 *
 * m27: CHUNK_SIZE 고정 30 → 동적 결정.
 *   - scripts/benchmark-chunks.mjs로 측정한 결과:
 *     * 청크 30 (14호출, 109.3s, in 12277t) — 시스템 프롬프트 14번 중복으로 비효율
 *     * 청크 404 전체 1호출 (101.1s, in 7826t) — 가장 빠르고 토큰 최소
 *   - VRAM은 청크 사이즈와 무관 (num_ctx가 KV cache 결정).
 *   - 모델 attention drift도 404 cues 한 호출에서 관측 안 됨 (404/404 매칭).
 *   - 결론: num_ctx의 80% 안에 들어가는 최대 사이즈로. 들어가면 1청크, 안 들어가면
 *     들어가는 최대치로 분할. 최소 MIN_CHUNK_SIZE 보장.
 */

const SEPARATOR = "---";

/**
 * 측정 기반 토큰 추정 상수 (Gemma4 한국어 토크나이저).
 * - 청크 404 실측 (한국어 9516자 → 입력 7826t, 출력 4591t):
 *   * 한국어 1자당 입력 토큰 ≈ 0.55 (시스템·prefix 제외)
 *   * 한국어 1자당 출력 토큰 ≈ 0.50 (영어 응답 + [N-M] overhead 포함)
 * - 시스템 프롬프트 ≈ 700 토큰, [N] prefix ≈ cue당 6 토큰.
 *
 * 다른 모델·다른 언어는 약간 다를 수 있어 SAFETY_RATIO로 보호.
 */
const KOREAN_CHAR_TO_INPUT_TOKEN = 0.55;
const KOREAN_CHAR_TO_OUTPUT_TOKEN = 0.50;
const SYSTEM_PROMPT_TOKENS_ESTIMATE = 700;
const INDEX_PREFIX_TOKENS_PER_CUE = 6;

/** num_ctx의 80%까지만 사용. 토큰 추정 오차(약 18%)보다 큰 마진. */
const CONTEXT_BUDGET_RATIO = 0.80;

/** 최소 청크 사이즈 — 너무 작아지면 시스템 프롬프트 오버헤드가 커서 비효율. */
const MIN_CHUNK_SIZE = 60;

/** ollama가 아닌 provider의 conservative 컨텍스트 추정값 (대부분 32K+). */
const NON_OLLAMA_CONTEXT_FALLBACK = 32768;

/**
 * 자막 분량과 num_ctx에 맞춰 청크 사이즈 동적 결정.
 *
 * - 전체 자막이 num_ctx × 80% 안에 들어가면 → 1청크 (가장 빠른 케이스)
 * - 안 들어가면 → 들어가는 최대 cue 수로 자동 분할
 * - 최소 MIN_CHUNK_SIZE 보장 (너무 작아져도 의미 없음)
 */
function computeChunkSize(cues: SubtitleCue[], contextBudget: number): number {
  if (cues.length === 0) return MIN_CHUNK_SIZE;

  const budget = Math.floor(contextBudget * CONTEXT_BUDGET_RATIO);
  const usableBudget = Math.max(0, budget - SYSTEM_PROMPT_TOKENS_ESTIMATE);

  // cue당 평균 토큰 추정 (입력 + 출력 + index prefix).
  const totalKoreanChars = cues.reduce((sum, cue) => sum + cue.text.length, 0);
  const avgKoreanCharsPerCue = totalKoreanChars / cues.length;
  const tokensPerCue =
    avgKoreanCharsPerCue *
      (KOREAN_CHAR_TO_INPUT_TOKEN + KOREAN_CHAR_TO_OUTPUT_TOKEN) +
    INDEX_PREFIX_TOKENS_PER_CUE;

  if (tokensPerCue <= 0) {
    return Math.min(cues.length, MIN_CHUNK_SIZE);
  }

  const maxCuesPerChunk = Math.floor(usableBudget / tokensPerCue);

  // 전체가 들어가면 1청크. 안 들어가면 들어가는 최대치로. 최소는 MIN_CHUNK_SIZE.
  return Math.max(
    MIN_CHUNK_SIZE,
    Math.min(cues.length, maxCuesPerChunk),
  );
}

/**
 * 청크 분할 계산용 컨텍스트 예산.
 *
 * Ollama provider인 경우 settings.ollama.numCtx를 청크 분할 기준값으로만 사용한다
 * (이 값은 m35-c 이후 Ollama 호출에는 전달되지 않음 — Ollama 전역 OLLAMA_CONTEXT_LENGTH를
 * 따라감). 디노가 둘을 같은 값으로 동기화해두면 청크가 가장 효율적으로 짜진다.
 */
function getContextBudget(settings: LlmSettings): number {
  if (settings.provider === "ollama") {
    return settings.ollama.numCtx;
  }
  return NON_OLLAMA_CONTEXT_FALLBACK;
}

const LANGUAGE_LABELS: Record<string, string> = {
  en: "영어 (English)",
  ja: "일본어 (日本語)",
  "zh-CN": "중국어 간체 (简体)",
  "zh-Hans": "중국어 간체 (简体)",
  "zh-TW": "중국어 번체 (繁體)",
  ru: "러시아어 (Русский)",
  es: "스페인어 (Español)",
  "es-419": "스페인어 라틴아메리카",
  fr: "프랑스어 (Français)",
  de: "독일어 (Deutsch)",
  pt: "포르투갈어 (Português)",
  "pt-BR": "브라질 포르투갈어 (Português Brasil)",
  it: "이탈리아어 (Italiano)",
  vi: "베트남어 (Tiếng Việt)",
  id: "인도네시아어 (Indonesia)",
  th: "태국어 (ไทย)",
  hi: "힌디어 (हिन्दी)",
  ar: "아랍어 (العربية)",
  tr: "튀르키예어 (Türkçe)",
};

function getLanguageLabel(code: string): string {
  return LANGUAGE_LABELS[code] ?? code;
}

function buildSystemPrompt(targetLanguage: string, chunkSize: number): string {
  const label = getLanguageLabel(targetLanguage);
  return `/no_think

한국어 영상 자막 ${chunkSize}개를 ${label}로 번역합니다.

기본 원칙:
- 가능한 한 한국어 자막 1개 → ${label} 자막 1개 (1:1).
- 한국어 어순 때문에 한 줄만 끊어서 번역하면 의미가 깨지는 경우(예: 한국어가 동사 끝에 오는 절이 두 자막에 나뉜 경우), 인접한 2~3개 자막을 합쳐 한 ${label} 자막으로 번역해도 됩니다.

엄격한 형식:
- 입력은 각 자막 앞에 \`[N]\` 인덱스 prefix가 있고, 자막 사이는 \`---\` 한 줄로 구분.
- 출력도 동일하게 prefix와 \`---\`로 구분.
  - 1:1 번역: \`[N] 번역\`
  - 합쳐서 번역: \`[N-M] 합쳐진 번역\` (N부터 M까지 인접 인덱스, M > N)
- N부터 ${chunkSize}까지 모든 입력 인덱스가 출력에 정확히 한 번씩 cover되어야 합니다.
  예: 입력이 [1][2][3][4]이고 [2]와 [3]을 합쳤다면 출력은 [1], [2-3], [4] 세 항목.
- 합칠 수 있는 범위는 인접한 자막만 (비인접 합치기 금지). 보통 2~3개. 4개 이상 합치기는 피하세요.
- 번역 텍스트만. 마크다운(\`<b>\`, \`<i>\`, \`**...**\`) 금지. 따옴표 감싸기 금지. 안내문 금지.

예시 입력 1 (어순 자연스러움 — 1:1):
[1] 첫 번째 자막입니다
---
[2] 두 번째 자막입니다
---
[3] 응

예시 출력 1 (1:1):
[1] This is the first subtitle
---
[2] This is the second subtitle
---
[3] Yes

예시 입력 2 (한국어 어순 때문에 두 자막이 한 문장):
[1] 이런 거는 아무래도 사진작가분들이나 이런 분들이 너무 선명하게 찍힌
---
[2] 사진이 부자연스러울 때 사용하시면 좋겠다 이런 생각이 들었고요
---
[3] 다음 주제로 넘어가겠습니다

예시 출력 2 ([1]과 [2]를 합쳐서 자연스럽게):
[1-2] I think this would be useful for photographers when a photo looks too sharp and unnatural
---
[3] Let's move on to the next topic

번역 규칙:
- 자연스럽고 빠르게 읽히는 ${label}.
- 같은 용어는 일관된 번역어.
- 모호한 표현은 앞뒤 맥락으로 의미 확정.
- 고유명사·인명은 ${label} 표준 표기.
- 자막 안 줄바꿈은 자연스럽게 유지.`;
}

function joinChunkForPrompt(chunk: SubtitleCue[]): string {
  return chunk
    .map((cue, i) => `[${i + 1}] ${cue.text}`)
    .join(`\n${SEPARATOR}\n`);
}

function splitBySeparator(text: string): string[] {
  // separator는 ---, ===, ***, ___, 유니코드 dash 다 인식 (m22).
  const lines = text.split(/\r?\n/);
  const groups: string[][] = [[]];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^[-=*_─–—]{3,}.*$/.test(line)) {
      groups.push([]);
      continue;
    }
    groups[groups.length - 1].push(rawLine);
  }
  return groups
    .map((g) => g.join("\n").trim())
    .filter((part) => part.length > 0);
}

function stripWrappers(text: string): string {
  let s = text.trim();

  // HTML 강조 태그 (b, i, strong, em, u, span, mark, small) 제거.
  s = s.replace(/<\/?(?:b|i|strong|em|u|span|mark|small|font)\b[^>]*>/gi, "");

  // 마크다운 강조 wrapper (시작/끝에 한 쌍만 있을 때).
  // multi-line text 대비 [\s\S]
  s = s.replace(/^\*\*([\s\S]+?)\*\*$/m, "$1");
  s = s.replace(/^__([\s\S]+?)__$/m, "$1");
  s = s.replace(/^\*([\s\S]+?)\*$/m, "$1");
  s = s.replace(/^_([\s\S]+?)_$/m, "$1");

  // 시작·끝에 대괄호 한 쌍만 있는 경우 — 인덱스 prefix 제거 후에도 wrapper 형태로 또 감싸진 경우.
  s = s.replace(/^\[([\s\S]+)\]$/, "$1");

  // 시작·끝 따옴표 한 쌍.
  s = s.replace(/^"([\s\S]+)"$/, "$1");
  s = s.replace(/^'([\s\S]+)'$/, "$1");
  s = s.replace(/^"([\s\S]+)"$/, "$1");
  s = s.replace(/^'([\s\S]+)'$/, "$1");

  return s.trim();
}

type IndexedEntry = {
  startIdx: number;
  endIdx: number;
  text: string;
};

/**
 * m25: [N] 또는 [N-M] 패턴 모두 인식.
 * - [N]: cue N에 1:1 매핑.
 * - [N-M]: cue N부터 cue M까지 합친 번역. 결과 cue는 첫 cue의 startMs와 마지막 cue의 endMs로
 *   시간 확장. 그 사이 cue들은 결과 배열에서 제거됨 (결과 length가 chunk.length보다 작아질 수 있음).
 * - 누락된 인덱스는 원문 한국어 cue 그대로 유지.
 */
function parseIndexedResponse(
  text: string,
  chunk: SubtitleCue[],
): {
  cues: SubtitleCue[];
  foundCount: number;
  missingIndices: number[];
} {
  const parts = splitBySeparator(text);
  const entries: IndexedEntry[] = [];

  for (const part of parts) {
    const cleaned = stripWrappers(part);
    // [N] 또는 [N-M] / [N~M] / 유니코드 dash 등.
    const match = cleaned.match(
      /^\s*\[\s*(\d+)\s*(?:[-–—~]\s*(\d+))?\s*\]\s*([\s\S]*)$/,
    );
    if (!match) continue;

    const startIdx = Number.parseInt(match[1], 10);
    const endIdx = match[2] ? Number.parseInt(match[2], 10) : startIdx;
    if (
      !Number.isFinite(startIdx) ||
      !Number.isFinite(endIdx) ||
      startIdx < 1 ||
      endIdx > chunk.length ||
      startIdx > endIdx
    ) {
      continue;
    }

    const body = stripWrappers(match[3]);
    if (body.length === 0) continue;

    entries.push({ startIdx, endIdx, text: body });
  }

  // 시작 인덱스 기준 정렬. 모델이 응답 순서를 섞었을 수도 있어서.
  entries.sort((a, b) => a.startIdx - b.startIdx);

  const coveredIndices = new Set<number>();
  const resultCues: SubtitleCue[] = [];
  let i = 1; // 1-based 인덱스
  let entryCursor = 0;

  while (i <= chunk.length) {
    // 현재 인덱스 i와 시작이 일치하는 entry를 찾는다. 정렬돼있어서 entryCursor를 앞으로만 이동.
    while (entryCursor < entries.length && entries[entryCursor].startIdx < i) {
      entryCursor++;
    }
    const entry = entries[entryCursor];

    if (entry && entry.startIdx === i) {
      // 단일 [N] 또는 합쳐진 [N-M]
      const firstCue = chunk[entry.startIdx - 1];
      const lastCue = chunk[entry.endIdx - 1];
      resultCues.push({
        index: firstCue.index,
        startMs: firstCue.startMs,
        endMs: lastCue.endMs,
        text: entry.text,
      });
      for (let j = entry.startIdx; j <= entry.endIdx; j++) {
        coveredIndices.add(j);
      }
      i = entry.endIdx + 1;
      entryCursor++;
    } else {
      // entry가 i를 시작점으로 갖지 않음 → 누락. 원문 cue 유지.
      resultCues.push({ ...chunk[i - 1] });
      i++;
    }
  }

  const missingIndices: number[] = [];
  for (let idx = 1; idx <= chunk.length; idx++) {
    if (!coveredIndices.has(idx)) missingIndices.push(idx);
  }

  return { cues: resultCues, foundCount: coveredIndices.size, missingIndices };
}

async function translateChunk(
  chunk: SubtitleCue[],
  targetLanguage: string,
  settings: LlmSettings,
  channelProfile: ChannelProfile,
): Promise<{
  cues: SubtitleCue[];
  foundCount: number;
  missingIndices: number[];
  rawSample: string;
  systemPrompt: string;
  userPrompt: string;
  rawResponse: string;
  reasoningText?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
}> {
  const baseSystemPrompt = buildSystemPrompt(targetLanguage, chunk.length);
  const channelContext = buildChannelContextForTranslation(
    channelProfile,
    targetLanguage,
  );
  // m30-B: 채널 정보 있으면 시스템 프롬프트 앞에 박음. 매 청크에 동일하게 들어가서
  // 다국어 자막에서 채널명 표기·용어 일관성 유지.
  const systemPrompt = channelContext
    ? `${channelContext}\n\n${baseSystemPrompt}`
    : baseSystemPrompt;
  const userPrompt = joinChunkForPrompt(chunk);

  // 한 자막 응답 ~100~150 토큰 + prefix overhead + 여유.
  const maxTokens = Math.max(2048, chunk.length * 250 + 2048);

  const startedAt = Date.now();
  const result = await callLlm(settings, {
    systemPrompt,
    userPrompt,
    maxTokens,
    temperature: 0,
  });
  const durationMs = Date.now() - startedAt;

  const parsed = parseIndexedResponse(result.text, chunk);

  return {
    cues: parsed.cues,
    foundCount: parsed.foundCount,
    missingIndices: parsed.missingIndices,
    rawSample: result.text.slice(0, 400),
    systemPrompt,
    userPrompt,
    rawResponse: result.text,
    reasoningText: result.reasoningText,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs,
  };
}

export async function translateSubtitles(
  cues: SubtitleCue[],
  targetLanguage: string,
  options: TranslateOptions = {},
): Promise<SubtitleCue[]> {
  if (cues.length === 0) {
    return [];
  }

  const settings = await loadLlmSettings();
  const channelProfile = await loadChannelProfile();
  const contextBudget = getContextBudget(settings);
  const chunkSize = computeChunkSize(cues, contextBudget);

  console.log(
    `[translate ${targetLanguage}] cues=${cues.length}, ` +
      `contextBudget=${contextBudget}, chunkSize=${chunkSize}, ` +
      `expectedChunks=${Math.ceil(cues.length / chunkSize)}` +
      (channelProfile.primaryName
        ? `, channel="${channelProfile.primaryName}"`
        : ""),
  );

  const out: SubtitleCue[] = [];

  let chunkIndex = 0;
  for (let start = 0; start < cues.length; start += chunkSize) {
    const chunk = cues.slice(start, start + chunkSize);
    const startCueIdx = start + 1; // 1-based, 전체 자막 기준
    const endCueIdx = start + chunk.length;

    let attempt = await translateChunk(
      chunk,
      targetLanguage,
      settings,
      channelProfile,
    );

    // 첫 시도 기록
    options.onDebug?.({
      kind: "subtitle",
      language: targetLanguage,
      chunkIndex,
      startCueIdx,
      endCueIdx,
      systemPrompt: attempt.systemPrompt,
      userPrompt: attempt.userPrompt,
      rawResponse: attempt.rawResponse,
      reasoningText: attempt.reasoningText,
      foundCount: attempt.foundCount,
      missingIndices: attempt.missingIndices,
      inputTokens: attempt.inputTokens,
      outputTokens: attempt.outputTokens,
      durationMs: attempt.durationMs,
      retried: false,
      failed: false,
    });

    // 완전 실패(0개 매칭)일 때만 재시도. 부분 성공은 그대로 사용.
    if (attempt.foundCount === 0) {
      console.warn(
        `[translate ${targetLanguage}] chunk ${start}~${start + chunk.length}: ` +
          `0/${chunk.length} indexed parts matched. retrying. ` +
          `raw first 400: ${attempt.rawSample.replace(/\n/g, "\\n")}`,
      );
      attempt = await translateChunk(
        chunk,
        targetLanguage,
        settings,
        channelProfile,
      );

      // 재시도 기록
      options.onDebug?.({
        kind: "subtitle",
        language: targetLanguage,
        chunkIndex,
        startCueIdx,
        endCueIdx,
        systemPrompt: attempt.systemPrompt,
        userPrompt: attempt.userPrompt,
        rawResponse: attempt.rawResponse,
        reasoningText: attempt.reasoningText,
        foundCount: attempt.foundCount,
        missingIndices: attempt.missingIndices,
        inputTokens: attempt.inputTokens,
        outputTokens: attempt.outputTokens,
        durationMs: attempt.durationMs,
        retried: true,
        failed: attempt.foundCount === 0,
      });
    }

    if (attempt.foundCount === 0) {
      console.error(
        `[translate ${targetLanguage}] chunk ${start}~${start + chunk.length}: ` +
          `STILL 0/${chunk.length} after retry. marking all as failed. ` +
          `raw first 400: ${attempt.rawSample.replace(/\n/g, "\\n")}`,
      );
      for (const cue of chunk) {
        out.push({ ...cue, text: `[번역 실패] ${cue.text}` });
      }
      chunkIndex++;
      continue;
    }

    if (attempt.missingIndices.length > 0) {
      console.warn(
        `[translate ${targetLanguage}] chunk ${start}~${start + chunk.length}: ` +
          `${attempt.foundCount}/${chunk.length} matched. ` +
          `missing indices: [${attempt.missingIndices.join(", ")}] kept as Korean original.`,
      );
    }

    out.push(...attempt.cues);
    chunkIndex++;
  }

  return out;
}
