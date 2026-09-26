import { NextResponse } from "next/server";

import { listUploadRuns } from "@/lib/upload-run-store";

export const runtime = "nodejs";

export async function GET() {
  const runs = await listUploadRuns(12);
  return NextResponse.json({ ok: true, runs });
}
