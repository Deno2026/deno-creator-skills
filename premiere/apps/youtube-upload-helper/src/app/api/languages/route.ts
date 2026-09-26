import { NextResponse } from "next/server";

import { listSupportedLanguages } from "@/lib/youtube-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const hl = searchParams.get("hl")?.trim() || "ko_KR";

  try {
    const items = await listSupportedLanguages(hl);
    const languages = items
      .map((item) => ({
        code: item.id?.trim() || item.snippet?.hl?.trim() || "",
        name: item.snippet?.name?.trim() || item.id?.trim() || "",
      }))
      .filter((item) => item.code && item.name);

    return NextResponse.json({ languages });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "지원 언어 목록을 불러오지 못했습니다.",
      },
      { status: 500 },
    );
  }
}
