import { NextResponse } from "next/server";

import { listCaptionMaintenanceRuns } from "@/lib/caption-maintenance-store";

export const runtime = "nodejs";

export async function GET() {
  const runs = await listCaptionMaintenanceRuns(20);
  return NextResponse.json({ ok: true, runs });
}
