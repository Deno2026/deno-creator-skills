import { NextResponse } from "next/server";

import { DEFAULT_UPLOAD_CHANNEL_ID, getDescriptionBlocks } from "@deno/runtime-paths";

import { publicUploadChannel } from "@/lib/channel-policy";
import { requireLocalBrowserRequest } from "@/lib/local-request-guard";
import {
  UPLOAD_CHANNELS,
  getActiveChannelId,
  getOAuthTokenPersistenceStatus,
  setActiveChannelId,
} from "@/lib/youtube-storage";

export const runtime = "nodejs";

async function channelList() {
  const activeChannelId = await getActiveChannelId();
  const channels = await Promise.all(
    UPLOAD_CHANNELS.map(async (channel) => ({
      ...publicUploadChannel(channel),
      active: channel.id === activeChannelId,
      tokenPersistence: await getOAuthTokenPersistenceStatus(channel.id),
    })),
  );
  return { activeChannelId, defaultChannelId: DEFAULT_UPLOAD_CHANNEL_ID, channels, descriptionBlocks: getDescriptionBlocks() };
}

export async function GET() {
  return NextResponse.json(await channelList());
}

/** 화면에서 고른 채널을 저장한다. 이후 프리셋·채널 정보·재생목록·연결 상태가 이 채널 기준이 된다. */
export async function POST(request: Request) {
  const blocked = requireLocalBrowserRequest(request);
  if (blocked) return blocked;

  let body: { channel?: unknown } = {};
  try {
    body = (await request.json()) as { channel?: unknown };
  } catch {
    return NextResponse.json({ error: "채널 요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  if (typeof body.channel !== "string") {
    return NextResponse.json({ error: "채널을 지정해 주세요." }, { status: 400 });
  }

  try {
    await setActiveChannelId(body.channel);
  } catch {
    return NextResponse.json({ error: "알 수 없는 채널입니다." }, { status: 400 });
  }

  return NextResponse.json(await channelList());
}
