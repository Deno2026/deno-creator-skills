import { callLlm } from "./provider";
import { loadLlmSettings } from "./settings";
import type { LlmSettings, SubtitleCue } from "./types";

/**
 * 자막 다듬기 — 청크 + 인덱스 prefix + 부분 성공 허용 (translate.ts와 같은 m24 패턴).
 *
 * 메인 업로드 화면에서는 호출 안 함 — 프리미어 헬퍼 단계에서만 호출.
 */

const CHUNK_SIZE = 30;
const SEPARATOR = "---";
const MAX_CONTEXT_LENGTH = 12000;

export type RefineSubtitlesOptions = {
  settings?: LlmSettings;
  videoContext?: string;
};

function normalizeVideoContext(value: string | undefined): string {
  return (value ?? "").replace(/\0/g, "").trim().slice(0, MAX_CONTEXT_LENGTH);
}

function buildContextBlock(videoContext: string): string {
  if (!videoContext) {
    return `[영상 맥락 / 보정 힌트]
없음.

맥락이 부족하므로 고유명사, 제품명, 인명, 도구명은 확신할 수 있을 때만 고칩니다.
판단이 애매하면 원문을 유지합니다.`;
  }

  return `[영상 맥락 / 보정 힌트]
${videoContext}

위 힌트의 주제, 고유명사, 자주 나는 오타 교정 규칙을 우선 적용합니다.
힌트와 원문 사이에서 판단이 애매하면 원문을 유지합니다.`;
}

function buildSystemPrompt(chunkSize: number, videoContext: string): string {
  return `/no_think

한국어 영상 자막 ${chunkSize}개의 의미를 맥락 기반으로 다듬습니다.
STT가 맥락과 어긋나게 받아 적은 부분(동음이의어, 잘못 들린 단어)을 의미에 맞게 정정합니다.
맥락이 모호하면 원본 유지.

${buildContextBlock(videoContext)}

엄격한 형식:
- 입력은 각 자막 앞에 \`[N]\` 인덱스 prefix가 있고, 자막 사이는 \`---\` 한 줄.
- 출력도 동일: \`[N]\` prefix 그대로 유지, \`---\`로 구분.
- N은 1부터 ${chunkSize}까지 절대 바꾸거나 빠뜨리지 마세요.
- 두 자막을 합치지 마세요. 한 자막을 쪼개지도 마세요.
- 자막 텍스트만. 마크다운(\`<b>\`, \`**...**\`) 금지. 따옴표 감싸기 금지. 안내문 금지.

예시 입력 (2개 자막):
[1] 앞에 보신 게 첫 번째 예입니다
---
[2] 사과 들인다고 했지만 사실은

예시 출력 (정확히 2개, prefix 유지):
[1] 앞에 보신 게 첫 번째 예입니다
---
[2] 사과 드린다고 했지만 사실은

다듬기 규칙:
- 오타·띄어쓰기·종결어 정정.
- STT가 맥락과 어긋나게 받아 적은 단어를 정확한 의미로 교체.
- 영상 맥락에 나온 고유명사·제품명·도구명·채널명은 임의로 일반 단어로 바꾸지 않음.
- 맥락이 모호하면 원문 유지.
- 화자가 안 한 말 추가 금지.`;
}

function joinChunkForPrompt(chunk: SubtitleCue[]): string {
  return chunk
    .map((cue, i) => `[${i + 1}] ${cue.text}`)
    .join(`\n${SEPARATOR}\n`);
}

function splitBySeparator(text: string): string[] {
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
  s = s.replace(/<\/?(?:b|i|strong|em|u|span|mark|small|font)\b[^>]*>/gi, "");
  s = s.replace(/^\*\*([\s\S]+?)\*\*$/m, "$1");
  s = s.replace(/^__([\s\S]+?)__$/m, "$1");
  s = s.replace(/^\*([\s\S]+?)\*$/m, "$1");
  s = s.replace(/^_([\s\S]+?)_$/m, "$1");
  s = s.replace(/^\[([\s\S]+)\]$/, "$1");
  s = s.replace(/^"([\s\S]+)"$/, "$1");
  s = s.replace(/^'([\s\S]+)'$/, "$1");
  return s.trim();
}

function parseIndexedResponse(
  text: string,
  chunk: SubtitleCue[],
): { cues: SubtitleCue[]; foundCount: number; missingIndices: number[] } {
  const parts = splitBySeparator(text);
  const indexMap = new Map<number, string>();

  for (const part of parts) {
    const cleaned = stripWrappers(part);
    const match = cleaned.match(/^\s*\[\s*(\d+)\s*\]\s*([\s\S]*)$/);
    if (!match) continue;
    const idx = Number.parseInt(match[1], 10);
    if (!Number.isFinite(idx) || idx < 1 || idx > chunk.length) continue;
    const body = stripWrappers(match[2]);
    if (body.length === 0) continue;
    indexMap.set(idx, body);
  }

  const missingIndices: number[] = [];
  const cues: SubtitleCue[] = chunk.map((cue, i) => {
    const refined = indexMap.get(i + 1);
    if (!refined) {
      missingIndices.push(i + 1);
      return { index: cue.index, startMs: cue.startMs, endMs: cue.endMs, text: cue.text };
    }
    return { index: cue.index, startMs: cue.startMs, endMs: cue.endMs, text: refined };
  });

  return { cues, foundCount: indexMap.size, missingIndices };
}

async function refineChunk(
  chunk: SubtitleCue[],
  settings: LlmSettings,
  videoContext: string,
): Promise<{
  cues: SubtitleCue[];
  foundCount: number;
  missingIndices: number[];
  rawSample: string;
}> {
  const systemPrompt = buildSystemPrompt(chunk.length, videoContext);
  const userPrompt = joinChunkForPrompt(chunk);
  const maxTokens = Math.max(2048, chunk.length * 250 + 2048);

  const result = await callLlm(settings, {
    systemPrompt,
    userPrompt,
    maxTokens,
    temperature: 0,
  });

  const parsed = parseIndexedResponse(result.text, chunk);
  return {
    cues: parsed.cues,
    foundCount: parsed.foundCount,
    missingIndices: parsed.missingIndices,
    rawSample: result.text.slice(0, 400),
  };
}

export async function refineSubtitles(
  cues: SubtitleCue[],
  options: RefineSubtitlesOptions = {},
): Promise<SubtitleCue[]> {
  if (cues.length === 0) {
    return [];
  }

  const settings = options.settings ?? await loadLlmSettings();
  const videoContext = normalizeVideoContext(options.videoContext);
  const out: SubtitleCue[] = [];

  for (let start = 0; start < cues.length; start += CHUNK_SIZE) {
    const chunk = cues.slice(start, start + CHUNK_SIZE);
    let attempt = await refineChunk(chunk, settings, videoContext);

    if (attempt.foundCount === 0) {
      console.warn(
        `[refine] chunk ${start}~${start + chunk.length}: 0/${chunk.length} indexed parts. retrying. ` +
          `raw first 400: ${attempt.rawSample.replace(/\n/g, "\\n")}`,
      );
      attempt = await refineChunk(chunk, settings, videoContext);
    }

    if (attempt.foundCount === 0) {
      console.error(
        `[refine] chunk ${start}~${start + chunk.length}: STILL 0 after retry. keeping originals.`,
      );
      out.push(...chunk);
      continue;
    }

    if (attempt.missingIndices.length > 0) {
      console.warn(
        `[refine] chunk ${start}~${start + chunk.length}: ${attempt.foundCount}/${chunk.length} matched. ` +
          `missing indices: [${attempt.missingIndices.join(", ")}] kept as original.`,
      );
    }

    out.push(...attempt.cues);
  }

  return out;
}
