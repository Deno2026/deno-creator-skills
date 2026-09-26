import { NextResponse } from "next/server";

import { requireAgentWorkspaceAccess } from "@/lib/agent-workspace-auth";
import {
  AGENT_LANGUAGE_OPTIONS,
  getActiveAgentProjectSlug,
  listAgentProjects,
} from "@/lib/agent-workspace";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = await requireAgentWorkspaceAccess(request);
  if (denied) return denied;

  const [projects, requestedActiveSlug] = await Promise.all([
    listAgentProjects(),
    getActiveAgentProjectSlug(),
  ]);
  const activeSlug =
    requestedActiveSlug && projects.some((project) => project.slug === requestedActiveSlug)
      ? requestedActiveSlug
      : null;
  return NextResponse.json({
    ok: true,
    projects,
    activeSlug,
    languageOptions: AGENT_LANGUAGE_OPTIONS,
  });
}
