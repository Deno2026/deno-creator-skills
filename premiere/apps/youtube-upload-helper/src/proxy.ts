import { NextRequest, NextResponse } from "next/server";

const TRUSTED_FETCH_SITES = new Set(["same-origin", "same-site", "none"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SENSITIVE_GET_PREFIXES = [
  "/api/agent-workspace",
  "/api/auth/status",
  "/api/channels",
  "/api/captions/maintenance",
  "/api/llm-settings",
  "/api/preflight",
  "/api/settings",
];

function defaultPort(protocol: string) {
  return protocol === "https:" ? "443" : "80";
}

function isLocalOrigin(origin: string, request: NextRequest) {
  try {
    const parsed = new URL(origin);
    if (!LOCAL_HOSTS.has(parsed.hostname)) return false;
    if (parsed.protocol !== request.nextUrl.protocol) return false;

    const originPort = parsed.port || defaultPort(parsed.protocol);
    const requestPort = request.nextUrl.port || defaultPort(request.nextUrl.protocol);
    return originPort === requestPort;
  } catch {
    return false;
  }
}

function isSensitiveGet(pathname: string) {
  return SENSITIVE_GET_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function hasAgentWorkspaceToken(request: NextRequest) {
  return (
    Boolean(request.headers.get("x-agent-workspace-token")?.trim()) ||
    request.headers.get("authorization")?.startsWith("Bearer ") === true
  );
}

export function proxy(request: NextRequest) {
  const method = request.method.toUpperCase();
  const isAgentWorkspaceRequest = request.nextUrl.pathname.startsWith("/api/agent-workspace");
  const shouldProtect =
    MUTATING_METHODS.has(method) ||
    (method === "GET" && isSensitiveGet(request.nextUrl.pathname));

  if (!shouldProtect) {
    return NextResponse.next();
  }

  if (isAgentWorkspaceRequest && hasAgentWorkspaceToken(request)) {
    return NextResponse.next();
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  const trustedSite = fetchSite !== null && TRUSTED_FETCH_SITES.has(fetchSite);
  const trustedOrigin = origin !== null && isLocalOrigin(origin, request);

  if (fetchSite !== null && !TRUSTED_FETCH_SITES.has(fetchSite)) {
    return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
  }

  if (origin !== null && !trustedOrigin) {
    return NextResponse.json({ error: "Untrusted request origin." }, { status: 403 });
  }

  if (!trustedSite && !trustedOrigin) {
    return NextResponse.json({ error: "Missing trusted browser request headers." }, { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/((?!upload$|upload-request$).*)"],
};
