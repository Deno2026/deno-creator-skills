import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { getOwnChannel } from "@/lib/youtube-auth";
import { getMissingEnvKeys, getResolvedYouTubeEnv } from "@/lib/youtube-config";
import {
  ensureStorageRoot,
  getStorageRoot,
  loadToken,
  resolveChannel,
} from "@/lib/youtube-storage";

export const runtime = "nodejs";

type PreflightItem = {
  id: string;
  label: string;
  status: "ok" | "warn" | "error";
  detail: string;
  actionHref?: string;
};

export async function GET(request: Request) {
  const items: PreflightItem[] = [];
  const requestUrl = new URL(request.url);

  const currentPort = requestUrl.port || (requestUrl.protocol === "https:" ? "443" : "80");
  if (currentPort === "8765") {
    items.push({
      id: "reserved-port",
      label: "예약 포트",
      status: "error",
      detail: "8765는 Session Mirror Bridge 전용입니다. 이 앱 서버가 쓰면 안 됩니다.",
    });
  } else {
    items.push({
      id: "reserved-port",
      label: "예약 포트",
      status: "ok",
      detail: `현재 포트 ${currentPort}. 8765 보호 규칙을 침범하지 않습니다.`,
    });
  }

  try {
    await ensureStorageRoot();
    const probePath = path.join(getStorageRoot(), ".preflight-write-test");
    await writeFile(probePath, new Date().toISOString(), "utf8");
    await rm(probePath, { force: true });
    items.push({
      id: "storage",
      label: "저장 위치",
      status: "ok",
      detail: getStorageRoot(),
    });
  } catch (error) {
    items.push({
      id: "storage",
      label: "저장 위치",
      status: "error",
      detail:
        error instanceof Error
          ? error.message
          : "설정/실행기록 저장 위치에 쓸 수 없습니다.",
    });
  }

  const missing = await getMissingEnvKeys();
  const resolved = await getResolvedYouTubeEnv();
  // 연결 점검은 화면에서 고른 채널 기준이다.
  const uploadChannel = await resolveChannel();
  const token = await loadToken(uploadChannel.id);

  if (missing.length > 0 || !resolved) {
    items.push({
      id: "youtube-config",
      label: "YouTube 설정",
      status: "error",
      detail: `Google OAuth 설정이 비어 있습니다: ${missing.join(", ") || "settings"}`,
      actionHref: "/settings",
    });
  } else if (!token) {
    items.push({
      id: "youtube-config",
      label: "YouTube 연결",
      status: "warn",
      detail: `Google 설정은 있지만 ${uploadChannel.title}(${uploadChannel.handle}) 채널 연결 토큰이 없습니다.`,
      actionHref: "/settings",
    });
  } else {
    try {
      const channel = await getOwnChannel(uploadChannel.id);
      const channelMismatch = channel?.id !== uploadChannel.youtubeChannelId;
      items.push({
        id: "youtube-config",
        label: "YouTube 연결",
        status: channelMismatch ? "error" : "ok",
        detail: channelMismatch
          ? `저장된 토큰이 ${uploadChannel.title}(${uploadChannel.handle})가 아니라 ${channel?.snippet?.title ?? "채널 없음"}의 것입니다. 다시 연결해 주세요.`
          : channel?.snippet?.title
            ? `채널 연결됨: ${channel.snippet.title}`
            : `OAuth 설정 ${resolved.source}. 채널 조회 가능.`,
        ...(channelMismatch ? { actionHref: "/settings" } : {}),
      });
    } catch (error) {
      items.push({
        id: "youtube-config",
        label: "YouTube 연결",
        status: "error",
        detail:
          error instanceof Error
            ? `채널 조회 실패: ${error.message}`
            : "채널 조회 실패. YouTube 연결을 다시 승인해야 합니다.",
        actionHref: "/settings",
      });
    }
  }

  if (resolved?.redirectUri) {
    try {
      const redirect = new URL(resolved.redirectUri);
      const redirectPort =
        redirect.port || (redirect.protocol === "https:" ? "443" : "80");
      items.push({
        id: "oauth-port",
        label: "OAuth 포트",
        status: redirectPort === currentPort ? "ok" : "warn",
        detail:
          redirectPort === currentPort
            ? `콜백 포트 ${redirectPort} 일치.`
            : `현재 앱 포트 ${currentPort}, 콜백 포트 ${redirectPort}. 데스크톱 실행 시 콜백 포트가 기준입니다.`,
        actionHref: redirectPort === currentPort ? undefined : "/settings",
      });
    } catch {
      items.push({
        id: "oauth-port",
        label: "OAuth 포트",
        status: "error",
        detail: "Google Redirect URI를 URL로 해석하지 못했습니다.",
        actionHref: "/settings",
      });
    }
  }

  const errorCount = items.filter((item) => item.status === "error").length;
  const warnCount = items.filter((item) => item.status === "warn").length;

  return NextResponse.json({
    ok: errorCount === 0,
    status: errorCount > 0 ? "error" : warnCount > 0 ? "warn" : "ok",
    checkedAt: new Date().toISOString(),
    items,
  });
}
