import { NextRequest, NextResponse } from "next/server";

import {
  ChannelMismatchError,
  consumeOAuthState,
  createOAuthClientAsync,
  verifyTokensBelongToChannel,
} from "@/lib/youtube-auth";
import { saveToken } from "@/lib/youtube-storage";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const completeUrl = new URL("/oauth-complete", request.url);

  // state는 연결을 시작한 채널과 묶인 일회용 값이다. 맞지 않으면 토큰을 받지 않는다.
  let channel;
  try {
    channel = await consumeOAuthState(searchParams.get("state"));
  } catch {
    completeUrl.searchParams.set("status", "error");
    completeUrl.searchParams.set("reason", error ?? "oauth_state_mismatch");
    return NextResponse.redirect(completeUrl);
  }
  completeUrl.searchParams.set("channel", channel.id);

  if (error) {
    completeUrl.searchParams.set("status", "error");
    completeUrl.searchParams.set("reason", error);
    return NextResponse.redirect(completeUrl);
  }

  if (!code) {
    completeUrl.searchParams.set("status", "error");
    completeUrl.searchParams.set("reason", "missing_code");
    return NextResponse.redirect(completeUrl);
  }

  try {
    const client = await createOAuthClientAsync();
    const { tokens } = await client.getToken(code);
    // 동의 화면에서 고른 채널이 연결하려는 채널과 같을 때만 저장한다.
    // 연결은 화면의 선택 채널을 바꾸지 않는다(업로드 채널은 사용자가 화면 위에서 고른다).
    await verifyTokensBelongToChannel(tokens, channel);
    await saveToken(tokens, channel.id);

    completeUrl.searchParams.set("status", "connected");
    return NextResponse.redirect(completeUrl);
  } catch (callbackError) {
    completeUrl.searchParams.set("status", "error");
    if (callbackError instanceof ChannelMismatchError) {
      completeUrl.searchParams.set("reason", "channel_mismatch");
      completeUrl.searchParams.set("expected", callbackError.expected.title);
      completeUrl.searchParams.set("actual", callbackError.actualTitle ?? "채널 없음");
      return NextResponse.redirect(completeUrl);
    }
    const detail =
      callbackError instanceof Error ? callbackError.message : "oauth_failed";
    completeUrl.searchParams.set("reason", detail.slice(0, 180));
    return NextResponse.redirect(completeUrl);
  }
}
