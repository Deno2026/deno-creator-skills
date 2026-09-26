import { NextResponse } from "next/server";

import { listVideoCategories } from "@/lib/youtube-auth";

export const runtime = "nodejs";

/**
 * YouTube 영상 카테고리 목록.
 *
 * regionCode 쿼리로 지역별 카테고리 가져옴 (디폴트 KR — 디노 채널 기준).
 * snippet.assignable=false인 항목(영상 분류 불가)은 자동 제외.
 *
 * GET /api/categories?regionCode=KR&hl=ko_KR
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const regionCode = url.searchParams.get("regionCode") ?? "KR";
  const hl = url.searchParams.get("hl") ?? "ko_KR";

  try {
    const items = await listVideoCategories(regionCode, hl);
    const categories = items
      .map((item) => ({
        id: item.id ?? "",
        title: item.snippet?.title ?? "",
        assignable: item.snippet?.assignable !== false,
      }))
      .filter((entry) => entry.id && entry.title && entry.assignable);

    return NextResponse.json({ ok: true, regionCode, categories });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "카테고리 목록을 가져오지 못했습니다.";
    return NextResponse.json({ ok: false, error: detail }, { status: 500 });
  }
}
