import { extractJson } from "./parse";
import { callLlm } from "./provider";
import { loadLlmSettings } from "./settings";
import type { LlmCallDebug, SubtitleCue } from "./types";
import { buildChannelContextKorean } from "@/lib/channel-profile-types";
import { loadChannelProfile } from "@/lib/youtube-storage";

export type SuggestMetaOptions = {
  onDebug?: (entry: LlmCallDebug) => void;
};

// /no_think: Qwen3 계열에서 thinking 모드 OFF.
// m32: YouTube 공식 가이드 반영 — 설명은 첫 2~3줄이 핵심, 해시태그 3개, 태그는 오타·표기 변형용.
const SUGGEST_SYSTEM_PROMPT = `/no_think

한국어 YouTube 영상 자막을 보고 제목·설명·태그를 작성합니다.

- titleCandidates: 제목 후보 3개. 각각 다른 스타일.
  1) 정보형: 영상 내용 명확히 알려주는 직설형
  2) 호기심형: 클릭하고 싶게 만드는 형태
  3) 검색형: 검색 키워드 풍부
  각 100자 이내.

- descriptionCandidates: 영상 설명 후보 3개. 각각 다른 스타일.
  공통 규칙 (3개 후보 모두 반드시 지킴):
  - 맨 앞 2~3줄에 이 영상의 메인 주제를 명확하게 담는다. 시청자가 '더보기'를 펼치기
    전에 보는 영역이라 가장 중요. "이 영상에서 무엇을 다루는지"가 바로 보여야 한다.
  - 그 아래 줄부터 세부 설명: 다루는 모델·도구, 준비물, 핵심 포인트, 순서.
  - 맨 끝에 해시태그를 정확히 3개. (더도 덜도 말고 딱 3개)
  스타일 차이:
  1) 직설형: 핵심 포인트 나열식. 본문 3~5줄.
  2) 요약형: 짧고 간결. 본문 2~3줄.
  3) SEO형: 검색 키워드를 자연스러운 문장 안에 녹임. 본문 더 길게.
  각 후보 200~1500자.

- tags: 검색 키워드 묶음이 아니라 "오타·표기 변형 보정용" 태그.
  영상에 실제 나오는 핵심 고유명사·기술 용어가 시청자에게 다르게 입력될 수 있는
  변형들을 위주로 넣는다:
  - 한글/영문 표기 차이 (예: ComfyUI / 컴피유아이)
  - 띄어쓰기 차이 (예: Comfy UI)
  - 대소문자·하이픈 변형 (예: comfyui / Z-Image / Z Image)
  영상 내용과 무관한 인기 키워드(예: ChatGPT, Sora 등 영상에 안 나오는 것)는
  절대 넣지 않는다. 8~15개.

JSON으로만 반환. 설명문·코드블록·thinking 본문 X.

출력 형식:
{"titleCandidates":["...","...","..."],"descriptionCandidates":["...","...","..."],"tags":["...",...]}`;

export type MetadataSuggestion = {
  titleCandidates: string[];
  /** 설명 후보 3개 (직설형 / 요약형 / SEO형) — 클라이언트에서 첫 항목을 자동 채움. */
  descriptionCandidates: string[];
  tags: string[];
};

export async function suggestMetadata(
  cues: SubtitleCue[],
  options: SuggestMetaOptions = {},
): Promise<MetadataSuggestion> {
  if (cues.length === 0) {
    return { titleCandidates: [], descriptionCandidates: [], tags: [] };
  }

  const settings = await loadLlmSettings();
  const channelProfile = await loadChannelProfile();
  const channelContext = buildChannelContextKorean(channelProfile);

  // 자막 전체를 한 번에 본다 (사용자 철학: 청크·sample은 품질 떨어진다).
  // 응답 크기는 작아서(~1000 토큰) 입력 토큰만 큰 호출. reasoning 끄면 빠름.
  const fullText = cues
    .map((cue) => cue.text.trim())
    .filter((text) => text.length > 0)
    .join(" ");

  // m30-B: 채널 정보가 있으면 시스템 프롬프트 앞에 박아 인격·용어 일관성 유지.
  const systemPrompt = channelContext
    ? `${channelContext}\n\n${SUGGEST_SYSTEM_PROMPT}`
    : SUGGEST_SYSTEM_PROMPT;

  const userPrompt = `다음 한국어 영상 자막을 보고 제목 후보, 설명 초안, 태그를 추천하세요.\n\n자막 내용:\n${fullText}`;

  const startedAt = Date.now();
  const result = await callLlm(settings, {
    systemPrompt,
    userPrompt,
    // 응답: 제목 3개(150t) + 설명 후보 3개(~1500자 × 3 ≈ 9000~12000t) + 태그 15개(300t) ≈ 약 12K.
    // 여유 두 배.
    maxTokens: 24_576,
    temperature: 0,
  });
  const durationMs = Date.now() - startedAt;

  options.onDebug?.({
    kind: "suggest",
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

  return parseSuggestion(result.text);
}

function parseSuggestion(rawText: string): MetadataSuggestion {
  const parsed = extractJson<
    Partial<MetadataSuggestion> & { description?: unknown }
  >(rawText);

  const titleCandidates = Array.isArray(parsed.titleCandidates)
    ? parsed.titleCandidates
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];

  // 후보 배열 우선, 모델이 옛 형식(description: string)을 돌려준 경우 그것도 단일 후보로 수용.
  let descriptionCandidates: string[] = [];
  if (Array.isArray(parsed.descriptionCandidates)) {
    descriptionCandidates = parsed.descriptionCandidates
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  } else if (typeof parsed.description === "string" && parsed.description.trim()) {
    descriptionCandidates = [parsed.description.trim()];
  }

  const tags = Array.isArray(parsed.tags)
    ? parsed.tags
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];

  return { titleCandidates, descriptionCandidates, tags };
}
