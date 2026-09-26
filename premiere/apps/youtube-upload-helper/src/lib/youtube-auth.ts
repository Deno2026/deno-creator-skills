import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";

import { DEFAULT_UPLOAD_CHANNEL_ID, getUploadRuntimePaths } from "@deno/runtime-paths";
import type { Credentials } from "google-auth-library";
import { google, youtube_v3 } from "googleapis";

import { getYouTubeEnv, YOUTUBE_SCOPES } from "@/lib/youtube-config";
import {
  ensureStorageRoot,
  getActiveChannelId,
  loadToken,
  resolveChannel,
  saveToken,
  type UploadChannel,
} from "@/lib/youtube-storage";

const OAUTH_STATE_MAX_AGE_MS = 15 * 60 * 1000;

type PendingOAuthState = {
  nonce: string;
  channel: string;
  createdAt: number;
};

export class ChannelMismatchError extends Error {
  constructor(
    readonly expected: UploadChannel,
    readonly actualChannelId: string | null,
    readonly actualTitle: string | null,
  ) {
    super(
      `YOUTUBE_CHANNEL_MISMATCH: ${expected.title}(${expected.youtubeChannelId}) 대신 ` +
        `${actualTitle ?? "채널 없음"}(${actualChannelId ?? "-"})의 권한입니다.`,
    );
  }
}

export async function createOAuthClientAsync() {
  const { clientId, clientSecret, redirectUri } = await getYouTubeEnv();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * 채널별 Google 연결 주소. 같은 Google 로그인 아래 채널이 여럿이므로 계정 선택 화면을 항상 띄워
 * 사용자가 연결할 채널을 고르게 한다. state의 nonce는 runtime에 저장해 callback에서 대조하고,
 * 토큰을 저장할 채널은 URL이 아니라 이 저장값에서 읽는다.
 */
export async function createAuthorizationUrl(channelId?: string | null) {
  const channel = await resolveChannel(channelId);
  const client = await createOAuthClientAsync();
  const nonce = randomBytes(24).toString("hex");
  const pending: PendingOAuthState = { nonce, channel: channel.id, createdAt: Date.now() };
  await ensureStorageRoot();
  await writeFile(
    getUploadRuntimePaths().oauthPendingStatePath,
    JSON.stringify(pending, null, 2),
    "utf8",
  );
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "select_account consent",
    scope: [...YOUTUBE_SCOPES],
    state: nonce,
  });
}

/** callback의 state를 저장된 nonce와 대조하고, 맞으면 연결할 채널을 돌려준다(한 번만 쓸 수 있다). */
export async function consumeOAuthState(state: string | null): Promise<UploadChannel> {
  const pendingPath = getUploadRuntimePaths().oauthPendingStatePath;
  let pending: PendingOAuthState | null = null;
  try {
    pending = JSON.parse(await readFile(pendingPath, "utf8")) as PendingOAuthState;
  } catch {
    pending = null;
  }
  await rm(pendingPath, { force: true });
  if (
    !state ||
    !pending ||
    typeof pending.nonce !== "string" ||
    pending.nonce !== state ||
    typeof pending.createdAt !== "number" ||
    Date.now() - pending.createdAt > OAUTH_STATE_MAX_AGE_MS
  ) {
    throw new Error("oauth_state_mismatch");
  }
  return resolveChannel(pending.channel);
}

async function readAuthorizedChannel(youtube: youtube_v3.Youtube) {
  const response = await youtube.channels.list({
    part: ["snippet"],
    mine: true,
  });
  return response.data.items?.[0] ?? null;
}

/** 새로 받은 토큰이 연결하려는 채널의 것인지 확인한다. 저장 전에 쓴다. */
export async function verifyTokensBelongToChannel(tokens: Credentials, channel: UploadChannel) {
  const client = await createOAuthClientAsync();
  client.setCredentials(tokens);
  const youtube = google.youtube({ version: "v3", auth: client });
  const item = await readAuthorizedChannel(youtube);
  if (item?.id !== channel.youtubeChannelId) {
    throw new ChannelMismatchError(channel, item?.id ?? null, item?.snippet?.title ?? null);
  }
  return item;
}

export async function createAuthorizedOAuthClient(channelId?: string | null) {
  const resolvedChannelId = channelId ?? (await getActiveChannelId());
  const token = await loadToken(resolvedChannelId);

  if (!token) {
    return null;
  }

  const client = await createOAuthClientAsync();
  client.setCredentials({
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    scope: token.scope,
    token_type: token.token_type,
    expiry_date: token.expiry_date,
    id_token: token.id_token,
  });
  // 갱신 토큰은 이 클라이언트를 만든 채널 칸에 저장한다(도중에 선택 채널이 바뀌어도 섞이지 않게).
  client.on("tokens", (refreshedToken) => {
    void saveToken(refreshedToken, resolvedChannelId).catch((error) => {
      console.error("Refreshed Google OAuth token could not be saved.", error);
    });
  });
  return client;
}

export async function createYouTubeClient(channelId?: string | null) {
  const auth = await createAuthorizedOAuthClient(channelId);

  if (!auth) {
    const channel = await resolveChannel(channelId);
    throw new Error(`${channel.title} Google OAuth 연결이 아직 완료되지 않았습니다.`);
  }

  return google.youtube({
    version: "v3",
    auth,
  });
}

/**
 * 채널 목록의 channel ID와 토큰의 실제 채널을 대조한 YouTube 클라이언트.
 * 업로드·수정처럼 채널에 쓰는 작업은 이 함수를 거친다.
 */
export async function createVerifiedYouTubeClient(channelId?: string | null) {
  const channel = await resolveChannel(channelId);
  const youtube = await createYouTubeClient(channel.id);
  const item = await readAuthorizedChannel(youtube);
  if (item?.id !== channel.youtubeChannelId) {
    throw new ChannelMismatchError(channel, item?.id ?? null, item?.snippet?.title ?? null);
  }
  return { youtube, channel, ownChannel: item };
}

/**
 * 카테고리·언어처럼 채널과 무관한 공개 목록. 선택 채널이 아직 연결되지 않았으면 기본 채널 토큰을 쓴다.
 */
async function createYouTubeClientForSharedLists() {
  const active = await getActiveChannelId();
  if (await loadToken(active)) return createYouTubeClient(active);
  return createYouTubeClient(DEFAULT_UPLOAD_CHANNEL_ID);
}

export async function getOwnChannel(channelId?: string | null) {
  const youtube = await createYouTubeClient(channelId);
  return readAuthorizedChannel(youtube);
}

export async function listOwnPlaylists(channelId?: string | null) {
  const youtube = await createYouTubeClient(channelId);
  const response = await youtube.playlists.list({
    part: ["snippet", "contentDetails", "status"],
    mine: true,
    maxResults: 50,
  });

  return response.data.items ?? [];
}

export async function listSupportedLanguages(hl = "ko_KR") {
  const youtube = await createYouTubeClientForSharedLists();
  const response = await youtube.i18nLanguages.list({
    part: ["snippet"],
    hl,
  });

  return response.data.items ?? [];
}

/**
 * 영상 카테고리 목록. regionCode는 디노 채널 기준 KR 디폴트.
 * snippet.assignable=false인 항목(예: 라이브 전용)은 호출 측에서 걸러내야 함.
 */
export async function listVideoCategories(regionCode = "KR", hl = "ko_KR") {
  const youtube = await createYouTubeClientForSharedLists();
  const response = await youtube.videoCategories.list({
    part: ["snippet"],
    regionCode,
    hl,
  });

  return response.data.items ?? [];
}

export async function addVideoToPlaylist(
  youtube: youtube_v3.Youtube,
  playlistId: string,
  videoId: string,
) {
  await youtube.playlistItems.insert({
    part: ["snippet"],
    requestBody: {
      snippet: {
        playlistId,
        resourceId: {
          kind: "youtube#video",
          videoId,
        },
      },
    },
  });
}
