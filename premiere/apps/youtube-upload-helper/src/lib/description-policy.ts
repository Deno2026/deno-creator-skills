// 설명 고정 블록 정책 — 값(링크·문구)은 channels.json(런타임)에서 오고 이 모듈은 규칙만 안다(2026-09-27 Deno Creator Skills 키트).
// 서버는 @deno/runtime-paths getDescriptionBlocks()로, 화면은 /api/channels 응답으로 configureDescriptionBlocks()를 부른다.
const INFERRED_SUBTITLE_GUIDE_HEADING = /^\s*🌐(?:\s|$)/u;
const DESCRIPTION_BLOCK_BOUNDARY = /^\s*(?:\d{2}:\d{2}(?::\d{2})?\s+|🚀|☁️|💬|💻)/u;

export type DescriptionLinkBlock = { url: string; ko: string; en: string };
export type DescriptionBlocksConfig = {
  comfyReferral: DescriptionLinkBlock;
  discord: DescriptionLinkBlock;
  tutorialBlocks: { hub: string; pcSpec: string };
  pinnedCommentHandle: string;
};

const EMPTY_LINK: DescriptionLinkBlock = { url: "", ko: "", en: "" };
export const EMPTY_DESCRIPTION_BLOCKS: DescriptionBlocksConfig = {
  comfyReferral: EMPTY_LINK,
  discord: EMPTY_LINK,
  tutorialBlocks: { hub: "", pcSpec: "" },
  pinnedCommentHandle: "",
};

let activeBlocks: DescriptionBlocksConfig = EMPTY_DESCRIPTION_BLOCKS;

function normalizeLink(raw: Partial<DescriptionLinkBlock> | null | undefined): DescriptionLinkBlock {
  return {
    url: typeof raw?.url === "string" ? raw.url.trim() : "",
    ko: typeof raw?.ko === "string" ? raw.ko : "",
    en: typeof raw?.en === "string" ? raw.en : "",
  };
}

export function normalizeDescriptionBlocks(raw: unknown): DescriptionBlocksConfig {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tutorial = (value.tutorialBlocks && typeof value.tutorialBlocks === "object" ? value.tutorialBlocks : {}) as Record<string, unknown>;
  return {
    comfyReferral: normalizeLink(value.comfyReferral as Partial<DescriptionLinkBlock>),
    discord: normalizeLink(value.discord as Partial<DescriptionLinkBlock>),
    tutorialBlocks: {
      hub: typeof tutorial.hub === "string" ? tutorial.hub : "",
      pcSpec: typeof tutorial.pcSpec === "string" ? tutorial.pcSpec : "",
    },
    pinnedCommentHandle: typeof value.pinnedCommentHandle === "string" ? value.pinnedCommentHandle : "",
  };
}

export function configureDescriptionBlocks(raw: unknown) {
  activeBlocks = normalizeDescriptionBlocks(raw);
  return activeBlocks;
}

export function getActiveDescriptionBlocks() {
  return activeBlocks;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HASHTAG_LINE = /^\s*#[^\s#]+(?:\s+#[^\s#]+)*\s*$/u;

/** 고정 블록을 붙이되 설명 끝의 해시태그 줄은 맨 끝에 남긴다(게시 문구 기준: 챕터 → HUB → PC Spec → ComfyUI → Discord → 해시태그, 2026-09-27). */
function appendBeforeTrailingHashtags(value: string, block: string) {
  const lines = value.split("\n");
  let start = lines.length;
  while (start > 0 && HASHTAG_LINE.test(lines[start - 1])) start -= 1;
  const body = lines.slice(0, start).join("\n").trim();
  if (start === lines.length || !body) return [value, block].filter(Boolean).join("\n\n");
  return [body, block, lines.slice(start).join("\n").trim()].filter(Boolean).join("\n\n");
}

/** 설정된 URL(스킴·www 무시)을 찾는 패턴. URL이 비어 있으면 null. */
function urlPattern(url: string, anchored = false) {
  const bare = url.replace(/^https?:\/\/(?:www\.)?/iu, "").replace(/\/+$/u, "");
  if (!bare) return null;
  const core = `https?:\\/\\/(?:www\\.)?${escapeRegExp(bare)}\\/?`;
  return anchored ? new RegExp(`^\\s*${core}\\s*$`, "gimu") : new RegExp(core, "iu");
}

export function comfyReferralUrl(blocks: DescriptionBlocksConfig = activeBlocks) {
  return blocks.comfyReferral.url;
}

export function discordUrl(blocks: DescriptionBlocksConfig = activeBlocks) {
  return blocks.discord.url;
}

export function comfyReferralBlock(lang: "ko" | "en" = "ko", blocks: DescriptionBlocksConfig = activeBlocks) {
  if (!blocks.comfyReferral.url) return "";
  return blocks.comfyReferral[lang] || blocks.comfyReferral.ko || blocks.comfyReferral.url;
}

export function discordBlock(lang: "ko" | "en" = "ko", blocks: DescriptionBlocksConfig = activeBlocks) {
  if (!blocks.discord.url) return "";
  return blocks.discord[lang] || blocks.discord.ko || blocks.discord.url;
}

export function tutorialBlock(name: "hub" | "pcSpec", blocks: DescriptionBlocksConfig = activeBlocks) {
  return blocks.tutorialBlocks[name].trim();
}

export function hasComfyReferralUrl(value: string, blocks: DescriptionBlocksConfig = activeBlocks) {
  const pattern = urlPattern(blocks.comfyReferral.url);
  return pattern ? pattern.test(value) : false;
}

export function stripKnownComfyReferralBlocks(value: string, blocks: DescriptionBlocksConfig = activeBlocks) {
  let output = value.replace(/\r\n/g, "\n");
  const anchored = urlPattern(blocks.comfyReferral.url, true);
  if (anchored) {
    // 옛 긴 안내 블록(링크 다음에 설명 문단이 붙은 형태)까지 걷어낸다.
    const legacy = new RegExp(
      `\\n*☁️?\\s*Comfy Cloud 링크\\s*\\n${anchored.source.replace(/^\\^\\\\s\\*|\\\\s\\*\\$$/g, "")}\\s*\\n+[^\\n]*ComfyUI 워크플로우를 실행할 수 있는 공식 클라우드 서비스입니다\\.[\\s\\S]*?다음 콘텐츠 제작에 큰 도움이 됩니다\\.`,
      "giu",
    );
    output = output.replace(legacy, "\n");
  }
  output = output.replace(
    /^\s*☁️?\s*(?:ComfyUI 공식 홈페이지|ComfyUI Official Website)(?:\s*\([^\n]*\))?\s*$/gimu,
    "",
  );
  if (anchored) output = output.replace(anchored, "");
  return output
    .replace(/^[ \t]*(?:※[ \t]*이 링크로 가입하면|Disclosure:[ \t]*If you sign up).*$/gimu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function ensureComfyReferralBlock(
  value: string,
  block?: string | null,
  blocks: DescriptionBlocksConfig = activeBlocks,
) {
  const normalized = stripKnownComfyReferralBlocks(value, blocks);
  if (!blocks.comfyReferral.url) return normalized;
  if (hasComfyReferralUrl(normalized, blocks)) return normalized;
  return appendBeforeTrailingHashtags(normalized, block ?? comfyReferralBlock("ko", blocks));
}

export function hasDenoDiscordUrl(value: string, blocks: DescriptionBlocksConfig = activeBlocks) {
  const pattern = urlPattern(blocks.discord.url);
  return pattern ? pattern.test(value) : false;
}

export function stripKnownDenoDiscordBlocks(value: string, blocks: DescriptionBlocksConfig = activeBlocks) {
  let output = value
    .replace(/\r\n/g, "\n")
    .replace(/^\s*💬?\s*(?:Deno Discord 채널|Deno Discord Community|Discord 채널|Discord Community)(?:\s*\([^\n]*\))?\s*$/gimu, "");
  const anchored = urlPattern(blocks.discord.url, true);
  if (anchored) output = output.replace(anchored, "");
  return output.replace(/\n{3,}/g, "\n\n").trim();
}

export function ensureDenoDiscordBlock(
  value: string,
  block?: string | null,
  blocks: DescriptionBlocksConfig = activeBlocks,
) {
  const normalized = stripKnownDenoDiscordBlocks(value, blocks);
  if (!blocks.discord.url) return normalized;
  if (hasDenoDiscordUrl(normalized, blocks)) return normalized;
  return appendBeforeTrailingHashtags(normalized, block ?? discordBlock("ko", blocks));
}

export function ensurePermanentDescriptionLinks(
  value: string,
  {
    comfyBlock,
    discordBlock: discordBlockText,
    includeComfyReferral = true,
    includeDiscord = true,
    blocks = activeBlocks,
  }: {
    comfyBlock?: string | null;
    discordBlock?: string | null;
    includeComfyReferral?: boolean;
    includeDiscord?: boolean;
    blocks?: DescriptionBlocksConfig;
  } = {},
) {
  const withComfyPolicy = includeComfyReferral
    ? ensureComfyReferralBlock(value, comfyBlock, blocks)
    : stripKnownComfyReferralBlocks(value, blocks);
  return includeDiscord
    ? ensureDenoDiscordBlock(withComfyPolicy, discordBlockText, blocks)
    : stripKnownDenoDiscordBlocks(withComfyPolicy, blocks);
}

/** 설정된 HUB·PC Spec 블록(정확히 같은 문단)과 그 모양의 옛 블록(🚀 줄 + 링크 줄, 💻 PC Spec + 이어지는 줄)을 걷어낸다. */
export function stripTutorialBlocks(value: string, blocks: DescriptionBlocksConfig = activeBlocks) {
  let output = value.replace(/\r\n/g, "\n");
  for (const block of [blocks.tutorialBlocks.hub, blocks.tutorialBlocks.pcSpec]) {
    const text = block.trim();
    if (text) output = output.split(text).join("\n");
  }
  return output
    .replace(/\n*🚀[^\n]*\n(?:https?:\/\/\S+[^\n]*)?/gu, "\n")
    .replace(/\n*💻\s*PC Spec\s*\n(?:(?!\n)[^\n]*\n?){0,6}/giu, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function containsInferredSubtitleGuide(value: string) {
  return value.split(/\r?\n/).some((line) => INFERRED_SUBTITLE_GUIDE_HEADING.test(line));
}

export function stripInferredSubtitleGuide(value: string) {
  const output: string[] = [];
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  let skipping = false;
  let skippedBodyLines = 0;

  for (const line of lines) {
    if (!skipping && INFERRED_SUBTITLE_GUIDE_HEADING.test(line)) {
      skipping = true;
      skippedBodyLines = 0;
      continue;
    }

    if (skipping) {
      if (!line.trim()) {
        skipping = false;
        if (output.length > 0 && output[output.length - 1].trim()) output.push("");
        continue;
      }

      if (DESCRIPTION_BLOCK_BOUNDARY.test(line) || skippedBodyLines >= 3) {
        skipping = false;
        output.push(line);
        continue;
      }

      skippedBodyLines += 1;
      continue;
    }

    output.push(line);
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
