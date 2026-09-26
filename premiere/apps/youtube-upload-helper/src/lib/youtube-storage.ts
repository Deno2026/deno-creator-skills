import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_UPLOAD_CHANNEL_ID,
  UPLOAD_CHANNELS,
  getUploadRuntimePaths,
  resolveUploadChannel,
  type UploadChannel,
  type UploadChannelId,
} from "@deno/runtime-paths";

import type { Credentials } from "google-auth-library";

import {
  normalizeUploadPreset,
  type UploadPreset,
} from "@/lib/upload-preset-types";
import {
  defaultChannelProfile,
  normalizeChannelProfile,
  type ChannelProfile,
} from "@/lib/channel-profile-types";

export type DesktopSettings = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

type UploadPresetStore = {
  presets: UploadPreset[];
};

type StoredCredentials = Credentials & {
  refresh_token_expires_in?: number;
  deno_refresh_token_issued_at?: number;
  deno_refresh_token_expires_at?: number;
};

export type OAuthTokenPersistenceStatus = {
  hasToken: boolean;
  hasRefreshToken: boolean;
  refreshTokenTimeLimited: boolean;
  refreshTokenExpiresAt?: string;
};

export type { UploadChannel, UploadChannelId };
export { UPLOAD_CHANNELS };

export function getStorageRoot() {
  return getUploadRuntimePaths().runtimeRoot;
}

/**
 * 화면에서 고른 채널. 채널별 토큰·채널 정보·프리셋 함수는 채널을 받지 않으면 이 값을 쓴다.
 * 파일이 없거나 알 수 없는 값이면 기본 채널(denoise)이다 — 기존 단일 채널 동작과 같다.
 */
export async function getActiveChannelId(): Promise<UploadChannelId> {
  try {
    const raw = await readFile(getUploadRuntimePaths().activeChannelPath, "utf8");
    const parsed = JSON.parse(raw) as { channel?: unknown };
    return resolveUploadChannel(
      typeof parsed.channel === "string" ? parsed.channel : null,
    ).id;
  } catch {
    return DEFAULT_UPLOAD_CHANNEL_ID;
  }
}

export async function setActiveChannelId(channelId: string): Promise<UploadChannel> {
  const channel = resolveUploadChannel(channelId);
  await ensureStorageRoot();
  await writeFile(
    getUploadRuntimePaths().activeChannelPath,
    JSON.stringify({ channel: channel.id, updatedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
  return channel;
}

export async function resolveChannel(channelId?: string | null): Promise<UploadChannel> {
  return resolveUploadChannel(channelId ?? (await getActiveChannelId()));
}

async function channelPaths(channelId?: string | null) {
  const channel = await resolveChannel(channelId);
  return getUploadRuntimePaths({ channel: channel.id });
}

async function ensureChannelRoot(channelId?: string | null) {
  const paths = await channelPaths(channelId);
  await mkdir(paths.channelRoot, { recursive: true });
  return paths;
}

export async function getUploadPresetStorePath(channelId?: string | null) {
  return (await channelPaths(channelId)).presetsPath;
}

export async function getChannelProfilePath(channelId?: string | null) {
  return (await channelPaths(channelId)).channelProfilePath;
}

export async function loadChannelProfile(channelId?: string | null): Promise<ChannelProfile> {
  try {
    const raw = await readFile(await getChannelProfilePath(channelId), "utf8");
    const parsed = JSON.parse(raw) as Partial<ChannelProfile>;
    return normalizeChannelProfile(parsed);
  } catch {
    return defaultChannelProfile;
  }
}

export async function saveChannelProfile(
  profile: ChannelProfile,
  channelId?: string | null,
): Promise<void> {
  const paths = await ensureChannelRoot(channelId);
  await writeFile(
    paths.channelProfilePath,
    JSON.stringify(normalizeChannelProfile(profile), null, 2),
    "utf8",
  );
}

export async function uploadPresetStoreExists(channelId?: string | null) {
  try {
    await access(await getUploadPresetStorePath(channelId));
    return true;
  } catch {
    return false;
  }
}

export async function ensureStorageRoot() {
  await mkdir(getStorageRoot(), { recursive: true });
}

export async function loadToken(channelId?: string | null): Promise<StoredCredentials | null> {
  try {
    const raw = await readFile((await channelPaths(channelId)).oauthTokenPath, "utf8");
    return JSON.parse(raw) as StoredCredentials;
  } catch {
    return null;
  }
}

/** 토큰은 항상 지정한 채널 칸에 저장한다. 호출 측은 토큰을 만든 채널을 명시해야 한다. */
export async function saveToken(token: Credentials, channelId: string) {
  const paths = await ensureChannelRoot(channelId);
  const existing = await loadToken(paths.channelId);
  const incoming = token as StoredCredentials;
  const now = Date.now();
  const receivedRefreshToken = Boolean(incoming.refresh_token);
  const refreshTokenExpiresIn = receivedRefreshToken
    ? incoming.refresh_token_expires_in
    : existing?.refresh_token_expires_in;
  const existingRefreshTokenExpiresAt =
    existing?.deno_refresh_token_expires_at ??
    (existing?.refresh_token_expires_in
      ? await inferRefreshTokenExpiryFromFile(
          paths.oauthTokenPath,
          existing.refresh_token_expires_in,
        )
      : undefined);

  const merged: StoredCredentials = {
    ...existing,
    ...incoming,
    refresh_token: incoming.refresh_token ?? existing?.refresh_token,
    refresh_token_expires_in: refreshTokenExpiresIn,
    deno_refresh_token_issued_at: receivedRefreshToken
      ? now
      : existing?.deno_refresh_token_issued_at,
    deno_refresh_token_expires_at: receivedRefreshToken
      ? refreshTokenExpiresIn
        ? now + refreshTokenExpiresIn * 1000
        : undefined
      : existingRefreshTokenExpiresAt,
  };

  await writeFile(
    paths.oauthTokenPath,
    JSON.stringify(merged, null, 2),
    "utf8",
  );
}

async function inferRefreshTokenExpiryFromFile(tokenPath: string, expiresInSeconds: number) {
  try {
    const file = await stat(tokenPath);
    return file.mtimeMs + expiresInSeconds * 1000;
  } catch {
    return undefined;
  }
}

export async function getOAuthTokenPersistenceStatus(
  channelId?: string | null,
): Promise<OAuthTokenPersistenceStatus> {
  const paths = await channelPaths(channelId);
  const token = await loadToken(paths.channelId);

  if (!token) {
    return {
      hasToken: false,
      hasRefreshToken: false,
      refreshTokenTimeLimited: false,
    };
  }

  const refreshTokenExpiresAt =
    token.deno_refresh_token_expires_at ??
    (token.refresh_token_expires_in
      ? await inferRefreshTokenExpiryFromFile(paths.oauthTokenPath, token.refresh_token_expires_in)
      : undefined);

  return {
    hasToken: true,
    hasRefreshToken: Boolean(token.refresh_token),
    refreshTokenTimeLimited: Boolean(token.refresh_token_expires_in),
    refreshTokenExpiresAt: refreshTokenExpiresAt
      ? new Date(refreshTokenExpiresAt).toISOString()
      : undefined,
  };
}

export async function clearToken(channelId?: string | null) {
  await rm((await channelPaths(channelId)).oauthTokenPath, { force: true });
}

export async function loadDesktopSettings(): Promise<DesktopSettings | null> {
  try {
    const raw = await readFile(
      path.join(getStorageRoot(), "youtube-settings.json"),
      "utf8",
    );
    return JSON.parse(raw) as DesktopSettings;
  } catch {
    return null;
  }
}

export async function saveDesktopSettings(settings: DesktopSettings) {
  await ensureStorageRoot();
  await writeFile(
    path.join(getStorageRoot(), "youtube-settings.json"),
    JSON.stringify(settings, null, 2),
    "utf8",
  );
}

export async function loadUploadPresetStore(channelId?: string | null): Promise<UploadPresetStore> {
  try {
    const raw = await readFile(
      await getUploadPresetStorePath(channelId),
      "utf8",
    );
    const parsed = JSON.parse(raw) as Partial<UploadPresetStore>;

    return {
      presets: Array.isArray(parsed.presets)
        ? parsed.presets.map((preset) => normalizeUploadPreset(preset))
        : [],
    };
  } catch {
    return { presets: [] };
  }
}

export async function saveUploadPresetStore(
  store: UploadPresetStore,
  channelId?: string | null,
) {
  const paths = await ensureChannelRoot(channelId);
  await writeFile(
    paths.presetsPath,
    JSON.stringify(store, null, 2),
    "utf8",
  );
}
