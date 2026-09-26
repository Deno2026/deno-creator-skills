import { NextResponse } from "next/server";

import { createAuthorizationUrl } from "@/lib/youtube-auth";
import { getMissingEnvKeys } from "@/lib/youtube-config";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const missing = await getMissingEnvKeys();

  if (missing.length > 0) {
    const redirectUrl = new URL("/", request.url);
    redirectUrl.searchParams.set("connectError", "setup-required");
    return NextResponse.redirect(redirectUrl);
  }

  // ?channel=<id>가 없으면 화면에서 고른 채널을 연결한다.
  const channel = new URL(request.url).searchParams.get("channel");

  try {
    return NextResponse.redirect(await createAuthorizationUrl(channel));
  } catch {
    const redirectUrl = new URL("/", request.url);
    redirectUrl.searchParams.set("connectError", "connect-failed");
    return NextResponse.redirect(redirectUrl);
  }
}
