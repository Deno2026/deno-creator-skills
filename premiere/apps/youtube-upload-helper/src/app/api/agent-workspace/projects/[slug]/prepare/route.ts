import { NextResponse } from "next/server";

import { requireAgentWorkspaceAccess } from "@/lib/agent-workspace-auth";
import { prepareProductionHandoff } from "@/lib/production-handoff";

export const runtime = "nodejs";
export const maxDuration = 300;

function safeErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.split(":", 1)[0].trim();
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(code)
    ? code
    : "PRODUCTION_PREPARE_FAILED";
}

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const denied = await requireAgentWorkspaceAccess(request);
  if (denied) return denied;

  try {
    const { slug } = await context.params;
    const prepared = await prepareProductionHandoff(decodeURIComponent(slug));
    return NextResponse.json({ ok: true, prepared });
  } catch (error) {
    const code = safeErrorCode(error);
    console.error("[production-prepare] blocked", { code });
    return NextResponse.json(
      {
        ok: false,
        error: code,
      },
      { status: code.endsWith("_MISSING") ? 404 : 409 },
    );
  }
}
