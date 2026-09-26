import { NextResponse } from "next/server";

import { publicUploadChannel } from "@/lib/channel-policy";
import { getOwnChannel } from "@/lib/youtube-auth";
import {
  getMissingEnvKeys,
  getResolvedYouTubeEnv,
  YOUTUBE_SCOPES,
} from "@/lib/youtube-config";
import {
  getActiveChannelId,
  getOAuthTokenPersistenceStatus,
  loadDesktopSettings,
  loadToken,
  resolveChannel,
} from "@/lib/youtube-storage";

export const runtime = "nodejs";

/** ?channel=<id>가 없으면 화면에서 고른 채널의 연결 상태를 돌려준다. */
export async function GET(request: Request) {
  let uploadChannel;
  try {
    uploadChannel = await resolveChannel(new URL(request.url).searchParams.get("channel"));
  } catch {
    return NextResponse.json({ error: "알 수 없는 채널입니다." }, { status: 400 });
  }
  const channelInfo = {
    uploadChannel: publicUploadChannel(uploadChannel),
    activeChannelId: await getActiveChannelId(),
  };
  const missing = await getMissingEnvKeys();
  const resolved = await getResolvedYouTubeEnv();
  const settings = await loadDesktopSettings();
  const tokenPersistence = await getOAuthTokenPersistenceStatus(uploadChannel.id);

  if (missing.length > 0) {
    return NextResponse.json({
      ...channelInfo,
      connected: false,
      configured: false,
      missing,
      tokenPersistence,
      settings: settings
        ? {
            clientId: settings.clientId,
            redirectUri: settings.redirectUri,
          }
        : undefined,
    });
  }

  const token = await loadToken(uploadChannel.id);

  if (!token) {
    return NextResponse.json({
      ...channelInfo,
      connected: false,
      configured: true,
      redirectUri: resolved?.redirectUri,
      scopes: [...YOUTUBE_SCOPES],
      configSource: resolved?.source,
      tokenPersistence,
      settings: resolved
        ? {
            clientId: resolved.clientId,
            redirectUri: resolved.redirectUri,
          }
        : undefined,
    });
  }

  try {
    const channel = await getOwnChannel(uploadChannel.id);
    // 토큰이 다른 채널의 것이면 연결되지 않은 것으로 보여 준다(잘못된 채널로 쓰지 않게).
    const channelMismatch = channel?.id !== uploadChannel.youtubeChannelId;

    return NextResponse.json({
      ...channelInfo,
      connected: !channelMismatch,
      configured: true,
      redirectUri: resolved?.redirectUri,
      scopes: [...YOUTUBE_SCOPES],
      configSource: resolved?.source,
      channelId: channel?.id,
      channelTitle: channel?.snippet?.title,
      ...(channelMismatch
        ? {
            error: `저장된 토큰이 ${uploadChannel.title}(${uploadChannel.handle}) 채널의 것이 아닙니다(${channel?.snippet?.title ?? "채널 없음"}). 다시 연결해 주세요.`,
          }
        : {}),
      tokenPersistence,
      settings: resolved
        ? {
            clientId: resolved.clientId,
            redirectUri: resolved.redirectUri,
          }
        : undefined,
    });
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message
        : "Google connection status could not be checked.";

    return NextResponse.json({
      ...channelInfo,
      connected: false,
      configured: true,
      redirectUri: resolved?.redirectUri,
      scopes: [...YOUTUBE_SCOPES],
      error: detail,
      configSource: resolved?.source,
      tokenPersistence,
      settings: resolved
        ? {
            clientId: resolved.clientId,
            redirectUri: resolved.redirectUri,
          }
        : undefined,
    });
  }
}
