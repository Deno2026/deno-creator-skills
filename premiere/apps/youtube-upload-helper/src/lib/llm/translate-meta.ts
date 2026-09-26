import { extractJson } from "./parse";
import { callLlm } from "./provider";
import { loadLlmSettings } from "./settings";
import type { LlmCallDebug } from "./types";
import { buildChannelContextForTranslation } from "@/lib/channel-profile-types";
import { loadChannelProfile } from "@/lib/youtube-storage";

export type TranslateMetaOptions = {
  onDebug?: (entry: LlmCallDebug) => void;
};

const LANGUAGE_LABELS: Record<string, string> = {
  en: "영어 (English)",
  ja: "일본어 (Japanese)",
  "zh-CN": "중국어 간체 (Simplified Chinese)",
  "zh-Hans": "중국어 간체 (Simplified Chinese)",
  "zh-TW": "중국어 번체 (Traditional Chinese)",
  ru: "러시아어 (Russian)",
  es: "스페인어 (Spanish)",
  "es-419": "스페인어 라틴아메리카 (Spanish Latin America)",
  fr: "프랑스어 (French)",
  de: "독일어 (German)",
  pt: "포르투갈어 (Portuguese)",
  "pt-BR": "브라질 포르투갈어 (Portuguese Brazil)",
  it: "이탈리아어 (Italian)",
  vi: "베트남어 (Vietnamese)",
  id: "인도네시아어 (Indonesian)",
  th: "태국어 (Thai)",
  hi: "힌디어 (Hindi)",
  ar: "아랍어 (Arabic)",
  tr: "튀르키예어 (Turkish)",
};

export type TranslatedMetadata = {
  title: string;
  description: string;
};

function getLanguageLabel(code: string): string {
  return LANGUAGE_LABELS[code] ?? code;
}

// /no_think: Qwen3 계열에서 thinking 모드 OFF.
function buildSystemPrompt(targetLanguage: string): string {
  const label = getLanguageLabel(targetLanguage);
  return `/no_think

한국어 YouTube 영상의 제목·설명을 ${label}로 번역합니다.

- 제목: ${label} 시청자가 클릭하고 싶게 자연스럽게. 의역 OK. 100자 이내.
- 설명: 검색 친화적, 자연스럽게. 본문 길이 입력과 비슷.
- 해시태그(#)는 ${label} 권역에 맞게 조정.

JSON으로만 반환. 설명문·코드블록·thinking 본문 X.

출력: {"title":"${label} 제목","description":"${label} 설명"}`;
}

export async function translateMetadata(
  koreanTitle: string,
  koreanDescription: string,
  targetLanguage: string,
  options: TranslateMetaOptions = {},
): Promise<TranslatedMetadata> {
  const settings = await loadLlmSettings();
  const channelProfile = await loadChannelProfile();
  const channelContext = buildChannelContextForTranslation(
    channelProfile,
    targetLanguage,
  );

  const baseSystemPrompt = buildSystemPrompt(targetLanguage);
  // m30-B: 채널 정보가 있으면 시스템 프롬프트 앞에 박아 채널명 표기·용어 일관성 강제.
  const systemPrompt = channelContext
    ? `${channelContext}\n\n${baseSystemPrompt}`
    : baseSystemPrompt;
  const userPrompt = `한국어 제목:\n${koreanTitle}\n\n한국어 설명:\n${koreanDescription}`;

  const startedAt = Date.now();
  const result = await callLlm(settings, {
    systemPrompt,
    userPrompt,
    maxTokens: 4096,
    temperature: 0,
  });
  const durationMs = Date.now() - startedAt;

  options.onDebug?.({
    kind: "metadata",
    language: targetLanguage,
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

  return parseTranslatedMetadata(result.text);
}

function parseTranslatedMetadata(rawText: string): TranslatedMetadata {
  const parsed = extractJson<Partial<TranslatedMetadata>>(rawText);

  return {
    title: typeof parsed.title === "string" ? parsed.title.trim() : "",
    description: typeof parsed.description === "string" ? parsed.description : "",
  };
}
