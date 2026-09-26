import { NextResponse } from "next/server";

import { listOwnPlaylists } from "@/lib/youtube-auth";

export const runtime = "nodejs";

export async function GET() {
  try {
    const playlists = await listOwnPlaylists();

    return NextResponse.json({
      playlists: playlists
        .map((playlist) => ({
          id: playlist.id ?? "",
          title: playlist.snippet?.title?.trim() || "Untitled playlist",
          privacyStatus: playlist.status?.privacyStatus ?? "private",
          itemCount: playlist.contentDetails?.itemCount ?? 0,
        }))
        .filter((playlist) => playlist.id),
    });
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message
        : "Playlists could not be loaded from YouTube.";

    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
