import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { ensureStorageRoot, getStorageRoot } from "@/lib/youtube-storage";

const TOKEN_BYTES = 32;
const AUTH_HEADER_PREFIX = "Bearer ";

function tokenPath() {
  return path.join(getStorageRoot(), "agent-workspace-token.txt");
}

function normalizeToken(value: string | null | undefined) {
  const token = value?.trim() ?? "";
  return token.length >= 32 ? token : "";
}

function tokenFromRequest(request: Request) {
  const direct = normalizeToken(request.headers.get("x-agent-workspace-token"));
  if (direct) return direct;

  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith(AUTH_HEADER_PREFIX)) return "";
  return normalizeToken(authorization.slice(AUTH_HEADER_PREFIX.length));
}

function isTrustedBrowserRequest(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");

  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) {
    return false;
  }

  if (origin) {
    try {
      const parsed = new URL(origin);
      if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return Boolean(fetchSite || origin);
}

function constantTimeEqual(a: string, b: string) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}

async function loadAgentWorkspaceToken() {
  const envToken = normalizeToken(
    process.env.STUDIO_UPLOADER_AGENT_WORKSPACE_TOKEN ||
      process.env.DENO_UPLOAD_HELPER_AGENT_WORKSPACE_TOKEN,
  );

  if (envToken) return envToken;

  try {
    const existing = normalizeToken(await readFile(tokenPath(), "utf8"));
    if (existing) return existing;
  } catch {
    // Missing token files are normal on first run.
  }

  const generated = randomBytes(TOKEN_BYTES).toString("hex");
  await ensureStorageRoot();
  try {
    await writeFile(tokenPath(), `${generated}\n`, { encoding: "utf8", flag: "wx" });
    return generated;
  } catch {
    const existing = normalizeToken(await readFile(tokenPath(), "utf8"));
    if (existing) return existing;
    throw new Error("Agent workspace token could not be created.");
  }
}

export async function requireAgentWorkspaceAccess(request: Request) {
  const provided = tokenFromRequest(request);

  if (!provided) {
    if (isTrustedBrowserRequest(request)) return null;

    return NextResponse.json(
      { ok: false, error: "Agent workspace token is required." },
      { status: 401 },
    );
  }

  const expected = await loadAgentWorkspaceToken();
  if (constantTimeEqual(provided, expected)) return null;

  return NextResponse.json(
    { ok: false, error: "Invalid agent workspace token." },
    { status: 401 },
  );
}
