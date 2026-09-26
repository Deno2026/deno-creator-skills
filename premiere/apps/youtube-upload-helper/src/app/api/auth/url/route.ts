import { NextResponse } from "next/server";

import { createAuthorizationUrl } from "@/lib/youtube-auth";
import { getMissingEnvKeys } from "@/lib/youtube-config";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const missing = await getMissingEnvKeys();

  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: "먼저 Google 연결 정보를 저장해 주세요.",
        missing,
      },
      { status: 400 },
    );
  }

  // ?channel=<id>가 없으면 화면에서 고른 채널을 연결한다.
  const channel = new URL(request.url).searchParams.get("channel");

  try {
    const url = await createAuthorizationUrl(channel);
    return NextResponse.json({ url });
  } catch (error) {
    if (error instanceof Error && error.message === "UNKNOWN_UPLOAD_CHANNEL") {
      return NextResponse.json({ error: "알 수 없는 채널입니다." }, { status: 400 });
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Google 연결 링크를 만들지 못했습니다.",
      },
      { status: 500 },
    );
  }
}
