/**
 * 채널 기본정보 — AI에게 매번 같이 보내는 채널 컨텍스트.
 *
 * 왜 필요한가:
 * - 채널 주인 이름이 외국어로 어떻게 표기되는지 모델은 모른다.
 *   예) "디노" → 모델이 자기 마음대로 "Dino", "Deno", "Dyno", "Dino-kun" 등.
 *   채널 주인이 직접 "Dino"라고 등록해두면 매번 그대로 가게 강제할 수 있다.
 * - 자주 쓰는 용어(노드, ComfyUI, RTX VSR 등)도 매 번역에서 일관되게.
 *
 * 저장 위치: DENO_UPLOAD_HELPER_RUNTIME_ROOT/channel-profile.json (프리셋과는 별도).
 *           프리셋은 영상 시리즈마다 다를 수 있고, 채널 정보는 채널 1개당 1개.
 */

export type ChannelNameLocalizations = {
  /**
   * 키는 BCP-47 언어 코드 (en, ja, zh-CN, zh-TW, ru, es, fr, de 등).
   * 값은 해당 언어 표기. 비어있는 키는 primaryName 그대로 사용 (음역 안 함).
   */
  [language: string]: string;
};

export type GlossaryEntry = {
  /** 원문 한국어 용어. */
  korean: string;
  /** 표준 영문/외국어 표기. 모든 외국어에 동일하게 사용. */
  english: string;
};

export type ChannelProfile = {
  /** 한국어 본명. 예: "디노". 비어있으면 채널 정보 비활성. */
  primaryName: string;
  /** 언어별 표기. 예: { en: "Dino", ja: "デノ" }. */
  nameLocalizations: ChannelNameLocalizations;
  /** 한 줄 채널 설명. 예: "AI/ComfyUI 튜토리얼 채널". */
  channelDescription: string;
  /** 한국어 → 외국어 용어집. 일관성 강제용. */
  glossary: GlossaryEntry[];
};

export const defaultChannelProfile: ChannelProfile = {
  primaryName: "",
  nameLocalizations: {},
  channelDescription: "",
  glossary: [],
};

function normalizeNameLocalizations(value: unknown): ChannelNameLocalizations {
  if (!value || typeof value !== "object") return {};
  const result: ChannelNameLocalizations = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") continue;
    const trimmedKey = key.trim();
    const trimmedValue = raw.trim();
    if (!trimmedKey || !trimmedValue) continue;
    result[trimmedKey] = trimmedValue;
  }
  return result;
}

function normalizeGlossary(value: unknown): GlossaryEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const item = entry as Partial<GlossaryEntry>;
      return {
        korean: typeof item.korean === "string" ? item.korean.trim() : "",
        english: typeof item.english === "string" ? item.english.trim() : "",
      };
    })
    .filter((entry) => entry.korean.length > 0 && entry.english.length > 0);
}

export function normalizeChannelProfile(
  raw: Partial<ChannelProfile> | null | undefined,
): ChannelProfile {
  const value = raw ?? {};
  return {
    primaryName:
      typeof value.primaryName === "string" ? value.primaryName.trim() : "",
    nameLocalizations: normalizeNameLocalizations(value.nameLocalizations),
    channelDescription:
      typeof value.channelDescription === "string"
        ? value.channelDescription.trim()
        : "",
    glossary: normalizeGlossary(value.glossary),
  };
}

/**
 * 채널 프로필을 시스템 프롬프트에 박을 수 있는 한국어 텍스트 블록으로.
 *
 * - 한국어 추천(suggest-meta)에서는 그대로 사용.
 * - 다국어 번역(translate, translate-meta)에서는 추가로 언어별 표기 정보 박음.
 *
 * primaryName이 비어있으면 빈 문자열 반환 (프롬프트에 안 박음).
 */
export function buildChannelContextKorean(profile: ChannelProfile): string {
  if (!profile.primaryName) return "";

  const lines: string[] = ["[채널 정보]", `- 채널명: ${profile.primaryName}`];

  if (profile.channelDescription) {
    lines.push(`- 채널 설명: ${profile.channelDescription}`);
  }

  if (profile.glossary.length > 0) {
    lines.push("- 주요 용어 (한국어 → 영어):");
    for (const entry of profile.glossary) {
      lines.push(`  · ${entry.korean} → ${entry.english}`);
    }
  }

  return lines.join("\n");
}

/**
 * 다국어 번역용 — 채널명 표기 규칙 + 용어집 박음.
 *
 * @param profile 채널 프로필
 * @param targetLanguage 대상 언어 코드 (en, ja, zh-CN, ...)
 */
export function buildChannelContextForTranslation(
  profile: ChannelProfile,
  targetLanguage: string,
): string {
  if (!profile.primaryName) return "";

  const targetName = profile.nameLocalizations[targetLanguage];

  const lines: string[] = [
    "[Channel Context — must follow]",
    `- Korean channel name: ${profile.primaryName}`,
  ];

  if (targetName) {
    lines.push(
      `- In ${targetLanguage}, this channel name MUST be written exactly as: ${targetName}`,
    );
  }

  if (profile.channelDescription) {
    lines.push(`- Channel concept (Korean): ${profile.channelDescription}`);
  }

  if (profile.glossary.length > 0) {
    lines.push("- Glossary (Korean → standard English/foreign):");
    for (const entry of profile.glossary) {
      lines.push(`  · ${entry.korean} → ${entry.english}`);
    }
    lines.push(
      "  → Use these exact forms across all languages. Don't transliterate differently.",
    );
  }

  return lines.join("\n");
}
