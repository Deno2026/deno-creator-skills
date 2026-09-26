import { NextResponse } from "next/server";

import {
  normalizeChannelProfile,
  type ChannelProfile,
} from "@/lib/channel-profile-types";
import {
  getActiveChannelId,
  getChannelProfilePath,
  loadChannelProfile,
  saveChannelProfile,
} from "@/lib/youtube-storage";

export const runtime = "nodejs";

/**
 * 채널 기본정보 CRUD.
 * GET  /api/channel-profile           — 현재 저장된 프로필 로드
 * POST /api/channel-profile { ...profile } — 프로필 저장 (전체 교체)
 */

// 채널 정보는 채널별로 저장한다(선택 채널 기준).
export async function GET() {
  const channelId = await getActiveChannelId();
  const profile = await loadChannelProfile(channelId);
  return NextResponse.json({
    channel: channelId,
    profile,
    storagePath: await getChannelProfilePath(channelId),
  });
}

export async function POST(request: Request) {
  let body: Partial<ChannelProfile>;
  try {
    body = (await request.json()) as Partial<ChannelProfile>;
  } catch {
    return NextResponse.json(
      { error: "JSON 파싱 실패" },
      { status: 400 },
    );
  }

  const channelId = await getActiveChannelId();
  const profile = normalizeChannelProfile(body);
  await saveChannelProfile(profile, channelId);

  return NextResponse.json({
    channel: channelId,
    profile,
    storagePath: await getChannelProfilePath(channelId),
  });
}
