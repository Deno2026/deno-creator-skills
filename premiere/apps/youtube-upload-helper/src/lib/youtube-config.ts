import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadDesktopSettings } from "@/lib/youtube-storage";

const REQUIRED_ENV_KEYS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
] as const;

export type RequiredEnvKey = (typeof REQUIRED_ENV_KEYS)[number];

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
] as const;

const DEFAULT_REDIRECT_URI = "http://localhost:3000/api/oauth/callback";

type ResolvedYouTubeEnv = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  source: "env" | "settings" | "local-secret";
};

type GoogleOAuthClientFile = {
  installed?: {
    client_id?: string;
    client_secret?: string;
    redirect_uris?: string[];
  };
  web?: {
    client_id?: string;
    client_secret?: string;
    redirect_uris?: string[];
  };
};

export function isValidGoogleOAuthClientId(clientId: string | undefined) {
  return /^[0-9]+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(
    clientId?.trim() ?? "",
  );
}

export function isLikelyGoogleOAuthClientSecret(clientSecret: string | undefined) {
  const value = clientSecret?.trim() ?? "";
  return value.length >= 20 && !/\s|@/.test(value);
}

function isValidOAuthSettings(settings: {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}) {
  return (
    isValidGoogleOAuthClientId(settings.clientId) &&
    isLikelyGoogleOAuthClientSecret(settings.clientSecret) &&
    Boolean(settings.redirectUri?.trim())
  );
}

async function loadLocalOAuthClient(): Promise<ResolvedYouTubeEnv | null> {
  const explicitClientFile = process.env.GOOGLE_OAUTH_CLIENT_FILE?.trim();
  if (!explicitClientFile) return null;
  if (!path.isAbsolute(explicitClientFile)) {
    throw new Error("GOOGLE_OAUTH_CLIENT_FILE must be an absolute path.");
  }

  for (const filePath of [explicitClientFile]) {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as GoogleOAuthClientFile;
      const client = parsed.installed ?? parsed.web;
      const clientId = client?.client_id?.trim() ?? "";
      const clientSecret = client?.client_secret?.trim() ?? "";
      const redirectUri =
        client?.redirect_uris?.find((uri) => uri.includes("localhost:3000")) ??
        DEFAULT_REDIRECT_URI;

      if (isValidOAuthSettings({ clientId, clientSecret, redirectUri })) {
        return {
          clientId,
          clientSecret,
          redirectUri,
          source: "local-secret",
        };
      }
    } catch {
      // Missing local secret files are normal on fresh installs.
    }
  }

  return null;
}

export async function getResolvedYouTubeEnv() {
  const envConfig = {
    clientId: process.env.GOOGLE_CLIENT_ID?.trim() ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "",
    redirectUri: process.env.GOOGLE_REDIRECT_URI?.trim() ?? "",
  };

  if (isValidOAuthSettings(envConfig)) {
    return {
      ...envConfig,
      source: "env" as const,
    };
  }

  const stored = await loadDesktopSettings();

  if (stored && isValidOAuthSettings(stored)) {
    return {
      ...stored,
      source: "settings" as const,
    };
  }

  return loadLocalOAuthClient();
}

export async function getMissingEnvKeys(): Promise<RequiredEnvKey[]> {
  const resolved = await getResolvedYouTubeEnv();

  if (resolved) {
    return [];
  }

  return REQUIRED_ENV_KEYS.filter((key) => !process.env[key]?.trim());
}

export async function getYouTubeEnv() {
  const resolved = await getResolvedYouTubeEnv();

  if (!resolved) {
    const missing = await getMissingEnvKeys();
    throw new Error(`Missing env vars: ${missing.join(", ")}`);
  }

  return resolved;
}
