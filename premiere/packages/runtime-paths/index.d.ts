export const ENV: Readonly<{
  productionRoot: "DENO_PRODUCTION_ROOT";
  uploadRuntimeRoot: "DENO_UPLOAD_HELPER_RUNTIME_ROOT";
  socialRuntimeRoot: "DENO_SOCIAL_PUBLISHING_RUNTIME_ROOT";
  mfaRuntimeRoot: "DENO_MFA_RUNTIME_ROOT";
}>;

type PathOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type UploadChannelId = string;

export type UploadChannel = Readonly<{
  id: UploadChannelId;
  title: string;
  handle: string;
  youtubeChannelId: string;
  descriptionLinks: Readonly<{ comfyReferral: boolean; discord: boolean; tutorialBlocks: boolean }>;
  /** 채널별 업로드 기본값(설명 틀·태그·카테고리·합성 표시·프리셋 이름). channels.json이 준다. */
  uploadDefaults: Readonly<Record<string, unknown>> | null;
  /** 요청 문장에서 이 채널을 가리키는 별칭(예: 한글 음차). */
  aliases: ReadonlyArray<string>;
}>;

export type DescriptionLinkBlock = Readonly<{ url: string; ko: string; en: string }>;
export type DescriptionBlocks = Readonly<{
  comfyReferral: DescriptionLinkBlock;
  discord: DescriptionLinkBlock;
  tutorialBlocks: Readonly<{ hub: string; pcSpec: string }>;
  pinnedCommentHandle: string;
}>;
export type PublishingProfile = Readonly<{
  schemaVersion: 1;
  source: string;
  defaultChannel: string;
  channels: ReadonlyArray<UploadChannel>;
  descriptionBlocks: DescriptionBlocks;
}>;

export const PUBLISHING_PROFILE_FILE: "channels.json";
export const BUILTIN_PUBLISHING_PROFILE: PublishingProfile;
export function loadPublishingProfile(options?: PathOptions & { reload?: boolean }): PublishingProfile;
export function getDescriptionBlocks(options?: PathOptions & { reload?: boolean }): DescriptionBlocks;
export const UPLOAD_CHANNELS: ReadonlyArray<UploadChannel>;
export const DEFAULT_UPLOAD_CHANNEL_ID: string;
export function resolveUploadChannel(channelId?: string | null, options?: PathOptions): UploadChannel;

export function isSafeSlug(value: unknown): value is string;
export function requireSafeSlug(value: unknown): string;
export function resolveAbsoluteEnvPath(
  name: string,
  env?: NodeJS.ProcessEnv,
  options?: { optional?: boolean },
): string | null;
export function findProductionRoot(options?: PathOptions): string;
export function assertPathWithin(
  candidatePath: string,
  parentPath: string,
  code?: string,
): string;
export function getUploadRuntimePaths(
  options?: PathOptions & { channel?: string | null },
): Readonly<{
  runtimeRoot: string;
  channelId: UploadChannelId;
  channelRoot: string;
  activeChannelPath: string;
  oauthPendingStatePath: string;
  settingsPath: string;
  oauthTokenPath: string;
  llmSettingsPath: string;
  agentWorkspaceTokenPath: string;
  uploadRequestsRoot: string;
  uploadVideoStagingRoot: string;
  productionPreparationsRoot: string;
  runsRoot: string;
  directShortInspectionsRoot: string;
  directShortUploadsRoot: string;
  videoOverlayPolicyPath: string;
  presetsPath: string;
  channelProfilePath: string;
  metadataBackfillRoot: string;
  backfillActiveStatePath: string;
}>;
export function getProductionPaths(slug: string, options?: PathOptions): Readonly<{
  productionRoot: string;
  productionsRoot: string;
  productionDir: string;
  statePath: string;
  captionsDir: string;
  finalKoreanPath: string;
  cleanKoreanPath: string;
  reviewedEnglishPath: string;
  englishReviewPath: string;
  captionSourceLockPath: string;
  deliveryDir: string;
  masterManifestPath: string;
  publishingDir: string;
  publishingHandoffPath: string;
  helperProjectPath: string;
}>;
export function getSocialPublishingRuntimePaths(options?: PathOptions): Readonly<{
  runtimeRoot: string;
  settingsPath: string;
  instagramSettingsPath: string;
  instagramTokenPath: string;
  threadsSettingsPath: string;
  threadsTokenPath: string;
  xSettingsPath: string;
  xTokenPath: string;
  r2SettingsPath: string;
  runsRoot: string;
  logsRoot: string;
}>;
export function readLocalConfig(options?: PathOptions): Readonly<Record<string, unknown>>;
export function resolveUploadRuntimeRootDefault(options?: PathOptions): string;
