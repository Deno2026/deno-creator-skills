import { NextResponse } from "next/server";

import {
  getResolvedYouTubeEnv,
  isLikelyGoogleOAuthClientSecret,
  isValidGoogleOAuthClientId,
} from "@/lib/youtube-config";
import {
  loadDesktopSettings,
  saveDesktopSettings,
} from "@/lib/youtube-storage";

export const runtime = "nodejs";

function isAllowedRedirectUri(value: string, requestUrl: string) {
  try {
    const parsed = new URL(value);
    const current = new URL(requestUrl);
    const parsedPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    const currentPort = current.port || (current.protocol === "https:" ? "443" : "80");

    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      parsedPort === currentPort &&
      parsed.pathname === "/api/oauth/callback"
    );
  } catch {
    return false;
  }
}

export async function GET() {
  const settings = await loadDesktopSettings();
  const resolved = await getResolvedYouTubeEnv();

  return NextResponse.json({
    configured: Boolean(resolved),
    source: resolved?.source ?? null,
    settings: resolved
      ? {
          clientId: resolved.clientId,
          redirectUri: resolved.redirectUri,
        }
      : settings
        ? {
            clientId: settings.clientId,
            redirectUri: settings.redirectUri,
          }
      : null,
  });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  };

  const clientId = body.clientId?.trim() ?? "";
  const clientSecret = body.clientSecret?.trim() ?? "";
  const redirectUri = body.redirectUri?.trim() ?? "";

  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.json(
      { error: "clientId, clientSecret, redirectUri를 모두 입력하세요." },
      { status: 400 },
    );
  }

  if (!isValidGoogleOAuthClientId(clientId)) {
    return NextResponse.json(
      {
        error:
          "Google OAuth Client ID 형식이 아닙니다. 이메일이 아니라 .apps.googleusercontent.com 으로 끝나는 값을 넣어야 합니다.",
      },
      { status: 400 },
    );
  }

  if (!isLikelyGoogleOAuthClientSecret(clientSecret)) {
    return NextResponse.json(
      {
        error:
          "Google OAuth Client Secret 형식이 너무 짧거나 잘못됐습니다. Google Cloud OAuth 클라이언트의 Secret 값을 넣어주세요.",
      },
      { status: 400 },
    );
  }

  if (!isAllowedRedirectUri(redirectUri, request.url)) {
    return NextResponse.json(
      {
        error:
          "Redirect URI는 이 앱의 로컬 OAuth callback 주소만 사용할 수 있습니다. 예: http://localhost:3000/api/oauth/callback",
      },
      { status: 400 },
    );
  }

  await saveDesktopSettings({
    clientId,
    clientSecret,
    redirectUri,
  });

  return NextResponse.json({ ok: true });
}
