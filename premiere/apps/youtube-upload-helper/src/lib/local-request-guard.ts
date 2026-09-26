import { NextResponse } from "next/server";

const TRUSTED_FETCH_SITES = new Set(["same-origin", "same-site", "none"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function defaultPort(protocol: string) {
  return protocol === "https:" ? "443" : "80";
}

function isLocalOrigin(origin: string, requestUrl: string) {
  try {
    const parsedOrigin = new URL(origin);
    const parsedRequest = new URL(requestUrl);

    if (!LOCAL_HOSTS.has(parsedOrigin.hostname)) return false;
    if (!LOCAL_HOSTS.has(parsedRequest.hostname)) return false;
    if (parsedOrigin.protocol !== parsedRequest.protocol) return false;

    const originPort = parsedOrigin.port || defaultPort(parsedOrigin.protocol);
    const requestPort = parsedRequest.port || defaultPort(parsedRequest.protocol);
    return originPort === requestPort;
  } catch {
    return false;
  }
}

export function requireLocalBrowserRequest(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  const trustedSite = fetchSite !== null && TRUSTED_FETCH_SITES.has(fetchSite);
  const trustedOrigin = origin !== null && isLocalOrigin(origin, request.url);

  if (fetchSite !== null && !TRUSTED_FETCH_SITES.has(fetchSite)) {
    return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
  }

  if (origin !== null && !trustedOrigin) {
    return NextResponse.json({ error: "Untrusted request origin." }, { status: 403 });
  }

  if (!trustedSite && !trustedOrigin) {
    return NextResponse.json({ error: "Missing trusted browser request headers." }, { status: 403 });
  }

  return null;
}
