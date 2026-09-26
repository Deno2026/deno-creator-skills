import { NextResponse } from "next/server";

import { requireAgentWorkspaceAccess } from "@/lib/agent-workspace-auth";
import { loadAgentProject, saveAgentProjectLanguages } from "@/lib/agent-workspace";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const denied = await requireAgentWorkspaceAccess(request);
  if (denied) return denied;

  const { slug } = await context.params;
  const project = await loadAgentProject(decodeURIComponent(slug));
  return NextResponse.json({ ok: true, project });
}

export async function PATCH(request: Request, context: RouteContext) {
  const denied = await requireAgentWorkspaceAccess(request);
  if (denied) return denied;

  const { slug } = await context.params;
  const body = (await request.json().catch(() => ({}))) as {
    selectedLanguages?: string[];
  };

  if (!Array.isArray(body.selectedLanguages)) {
    return NextResponse.json(
      { ok: false, error: "selectedLanguages 배열이 필요합니다." },
      { status: 400 },
    );
  }

  const project = await saveAgentProjectLanguages(
    decodeURIComponent(slug),
    body.selectedLanguages,
  );
  return NextResponse.json({ ok: true, project });
}
