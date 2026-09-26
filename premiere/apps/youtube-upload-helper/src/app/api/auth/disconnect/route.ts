import { NextResponse } from "next/server";

import { requireLocalBrowserRequest } from "@/lib/local-request-guard";
import { clearToken, resolveChannel } from "@/lib/youtube-storage";

export const runtime = "nodejs";

/** 지정 채널(?channel=<id>, 없으면 화면에서 고른 채널)의 토큰만 지운다. 다른 채널 연결은 그대로 둔다. */
export async function POST(request: Request) {
  const blocked = requireLocalBrowserRequest(request);
  if (blocked) return blocked;

  let channelId: string;
  try {
    channelId = (await resolveChannel(new URL(request.url).searchParams.get("channel"))).id;
  } catch {
    return NextResponse.json({ error: "알 수 없는 채널입니다." }, { status: 400 });
  }

  await clearToken(channelId);
  return NextResponse.json({ ok: true, channel: channelId });
}
