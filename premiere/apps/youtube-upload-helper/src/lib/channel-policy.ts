import { resolveUploadChannel, type UploadChannel } from "@deno/runtime-paths";

/** 화면·API 응답에 싣는 채널 정보(토큰·경로 없음). */
export type PublicUploadChannel = {
  id: UploadChannel["id"];
  title: string;
  handle: string;
  youtubeChannelId: string;
  descriptionLinks: { comfyReferral: boolean; discord: boolean; tutorialBlocks: boolean };
};

export function publicUploadChannel(channel: UploadChannel): PublicUploadChannel {
  return {
    id: channel.id,
    title: channel.title,
    handle: channel.handle,
    youtubeChannelId: channel.youtubeChannelId,
    descriptionLinks: { ...channel.descriptionLinks },
  };
}

/**
 * 채널별 설명 고정 링크 옵션. DENO는 ComfyUI 추천(제휴 링크 금지 영상 제외)·Discord를 붙이고,
 * Deno Pictures는 둘 다 넣지 않는다(있으면 걷어낸다).
 */
export function descriptionLinkOptionsForChannel(
  channelId: string,
  { noAffiliateLinks = false }: { noAffiliateLinks?: boolean } = {},
) {
  const links = resolveUploadChannel(channelId).descriptionLinks;
  return {
    includeComfyReferral: links.comfyReferral && !noAffiliateLinks,
    includeDiscord: links.discord,
  };
}
