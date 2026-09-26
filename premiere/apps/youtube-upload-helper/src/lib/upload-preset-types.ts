import {
  comfyReferralBlock,
  discordBlock,
  tutorialBlock,
  type DescriptionBlocksConfig,
} from "@/lib/description-policy";

export type PrivacyStatus = "private" | "unlisted" | "public";
export type LicenseType = "youtube" | "creativeCommon";
export type ThumbnailChoice = "A" | "B" | "C";
export type CommentVisibility = "enabled" | "disabled";
export type CommentModeration = "none" | "basic" | "strict" | "hold_all";
export type CommentPermission = "all";
export type CommentSortOrder = "newest" | "top";

export type UploadInteractionSettings = {
  commentVisibility: CommentVisibility;
  commentModeration: CommentModeration;
  commentPermission: CommentPermission;
  commentSortOrder: CommentSortOrder;
  publicStatsViewable: boolean;
};

export type LocalizedMetadataDraft = {
  id: string;
  language: string;
  title: string;
  description: string;
};

export type SubtitleTrackDraft = {
  id: string;
  language: string;
  label: string;
};

export type UploadDraft = {
  title: string;
  description: string;
  tags: string;
  defaultLanguage: string;
  /** 음성 언어 (snippet.defaultAudioLanguage). YouTube 자동 번역·검색 우선순위에 영향. */
  defaultAudioLanguage: string;
  /** 카테고리 ID (snippet.categoryId). 예: "27"=Education, "28"=Science & Tech. */
  categoryId: string;
  localizations: LocalizedMetadataDraft[];
  subtitleTracks: SubtitleTrackDraft[];
  privacyStatus: PrivacyStatus;
  license: LicenseType;
  playlistId: string;
  thumbnailChoice: ThumbnailChoice;
  madeForKids: boolean;
  containsSyntheticMedia: boolean;
  notifySubscribers: boolean;
  embeddable: boolean;
  publicStatsViewable: boolean;
  commentVisibility: CommentVisibility;
  commentModeration: CommentModeration;
  commentPermission: CommentPermission;
  commentSortOrder: CommentSortOrder;
};

export type UploadPreset = {
  id: string;
  name: string;
  draft: UploadDraft;
  updatedAt: string;
};

export const defaultUploadInteractionSettings: UploadInteractionSettings = {
  commentVisibility: "enabled",
  commentModeration: "none",
  commentPermission: "all",
  commentSortOrder: "newest",
  publicStatsViewable: true,
};

export const defaultUploadDraft: UploadDraft = {
  title: "",
  description: `오늘 영상 요약

- 핵심 포인트 1
- 핵심 포인트 2`,
  tags: "",
  defaultLanguage: "ko",
  defaultAudioLanguage: "ko",
  // 27 = "Education". DENO 튜토리얼/가이드 콘텐츠는 과학기술보다 교육 카테고리를 기본값으로 둔다.
  categoryId: "27",
  localizations: [],
  subtitleTracks: [
    {
      id: "subtitle-ko",
      language: "ko",
      label: "",
    },
  ],
  privacyStatus: "unlisted",
  license: "youtube",
  playlistId: "",
  thumbnailChoice: "A",
  madeForKids: false,
  containsSyntheticMedia: false,
  notifySubscribers: true,
  embeddable: true,
  publicStatsViewable: defaultUploadInteractionSettings.publicStatsViewable,
  commentVisibility: defaultUploadInteractionSettings.commentVisibility,
  commentModeration: defaultUploadInteractionSettings.commentModeration,
  commentPermission: defaultUploadInteractionSettings.commentPermission,
  commentSortOrder: defaultUploadInteractionSettings.commentSortOrder,
};

export type UploadChannelDefaults = {
  presetName?: string;
  description?: string;
  tags?: string;
  categoryId?: string;
  containsSyntheticMedia?: boolean;
};

export type UploadChannelForDefaults = {
  id: string;
  descriptionLinks: { comfyReferral: boolean; discord: boolean; tutorialBlocks: boolean };
  uploadDefaults?: UploadChannelDefaults | Record<string, unknown> | null;
};

/**
 * 채널별 기본 업로드 값. channels.json의 uploadDefaults(설명 틀·태그·카테고리·합성 표시)가 있으면 그것을 얹고,
 * 없으면 기본 요약에 채널 정책이 허용하는 고정 블록(HUB → 추천 링크 → Discord → PC Spec)을 붙인다.
 */
export function uploadDraftForChannel(
  channel: UploadChannelForDefaults | null | undefined,
  blocks?: DescriptionBlocksConfig,
): UploadDraft {
  const defaults = (channel?.uploadDefaults ?? {}) as UploadChannelDefaults;
  const links = channel?.descriptionLinks ?? { comfyReferral: false, discord: false, tutorialBlocks: false };
  const description =
    typeof defaults.description === "string" && defaults.description.trim()
      ? defaults.description
      : [
          defaultUploadDraft.description,
          links.tutorialBlocks ? tutorialBlock("hub", blocks) : "",
          links.comfyReferral ? comfyReferralBlock("ko", blocks) : "",
          links.discord ? discordBlock("ko", blocks) : "",
          links.tutorialBlocks ? tutorialBlock("pcSpec", blocks) : "",
        ]
          .filter(Boolean)
          .join("\n\n");
  return {
    ...defaultUploadDraft,
    description,
    tags: typeof defaults.tags === "string" ? defaults.tags : defaultUploadDraft.tags,
    categoryId: typeof defaults.categoryId === "string" && defaults.categoryId ? defaults.categoryId : defaultUploadDraft.categoryId,
    containsSyntheticMedia:
      typeof defaults.containsSyntheticMedia === "boolean" ? defaults.containsSyntheticMedia : defaultUploadDraft.containsSyntheticMedia,
  };
}

function createDraftId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function normalizeUpdatedAt(value: unknown) {
  if (typeof value !== "string") {
    return new Date().toISOString();
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }

  return parsed.toISOString();
}

function normalizeLocalizedMetadataList(value: unknown): LocalizedMetadataDraft[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const entry = item as Partial<LocalizedMetadataDraft>;

      return {
        id:
          typeof entry.id === "string" && entry.id.trim()
            ? entry.id
            : createDraftId("locale"),
        language: typeof entry.language === "string" ? entry.language.trim() : "",
        title: typeof entry.title === "string" ? entry.title : "",
        description: typeof entry.description === "string" ? entry.description : "",
      };
    })
    .filter(
      (entry) => entry.language || entry.title.trim() || entry.description.trim(),
    );
}

function normalizeSubtitleTrackList(
  value: unknown,
  legacySubtitleLanguage?: string,
): SubtitleTrackDraft[] {
  const nextTracks = Array.isArray(value)
    ? value
        .map((item) => {
          const entry = item as Partial<SubtitleTrackDraft>;

          return {
            id:
              typeof entry.id === "string" && entry.id.trim()
                ? entry.id
                : createDraftId("subtitle"),
            language: typeof entry.language === "string" ? entry.language.trim() : "",
            label: typeof entry.label === "string" ? entry.label : "",
          };
        })
        .filter((entry) => entry.language || entry.label.trim())
    : [];

  if (nextTracks.length) {
    return nextTracks;
  }

  if (legacySubtitleLanguage?.trim()) {
    return [
      {
        id: createDraftId("subtitle"),
        language: legacySubtitleLanguage.trim(),
        label: "",
      },
    ];
  }

  return defaultUploadDraft.subtitleTracks;
}

export function normalizeUploadDraft(
  raw:
    | (Partial<UploadDraft> & {
        subtitleLanguage?: string;
      })
    | null
    | undefined,
): UploadDraft {
  const value = raw ?? {};

  return {
    title: typeof value.title === "string" ? value.title : defaultUploadDraft.title,
    description:
      typeof value.description === "string"
        ? value.description
        : defaultUploadDraft.description,
    tags: typeof value.tags === "string" ? value.tags : defaultUploadDraft.tags,
    defaultLanguage:
      typeof value.defaultLanguage === "string" && value.defaultLanguage.trim()
        ? value.defaultLanguage
        : typeof value.subtitleLanguage === "string" && value.subtitleLanguage.trim()
          ? value.subtitleLanguage
          : defaultUploadDraft.defaultLanguage,
    defaultAudioLanguage:
      typeof value.defaultAudioLanguage === "string" && value.defaultAudioLanguage.trim()
        ? value.defaultAudioLanguage
        : defaultUploadDraft.defaultAudioLanguage,
    categoryId:
      typeof value.categoryId === "string" && value.categoryId.trim()
        ? value.categoryId.trim()
        : defaultUploadDraft.categoryId,
    localizations: normalizeLocalizedMetadataList(value.localizations),
    subtitleTracks: normalizeSubtitleTrackList(
      value.subtitleTracks,
      value.subtitleLanguage,
    ),
    privacyStatus:
      value.privacyStatus === "public" || value.privacyStatus === "unlisted"
        ? value.privacyStatus
        : defaultUploadDraft.privacyStatus,
    license:
      value.license === "creativeCommon"
        ? value.license
        : defaultUploadDraft.license,
    playlistId:
      typeof value.playlistId === "string"
        ? value.playlistId
        : defaultUploadDraft.playlistId,
    thumbnailChoice:
      value.thumbnailChoice === "B" || value.thumbnailChoice === "C"
        ? value.thumbnailChoice
        : defaultUploadDraft.thumbnailChoice,
    madeForKids:
      typeof value.madeForKids === "boolean"
        ? value.madeForKids
        : defaultUploadDraft.madeForKids,
    containsSyntheticMedia:
      typeof value.containsSyntheticMedia === "boolean"
        ? value.containsSyntheticMedia
        : defaultUploadDraft.containsSyntheticMedia,
    notifySubscribers:
      typeof value.notifySubscribers === "boolean"
        ? value.notifySubscribers
        : defaultUploadDraft.notifySubscribers,
    embeddable:
      typeof value.embeddable === "boolean"
        ? value.embeddable
        : defaultUploadDraft.embeddable,
    publicStatsViewable:
      typeof value.publicStatsViewable === "boolean"
        ? value.publicStatsViewable
        : defaultUploadDraft.publicStatsViewable,
    commentVisibility:
      value.commentVisibility === "disabled"
        ? value.commentVisibility
        : defaultUploadDraft.commentVisibility,
    commentModeration:
      value.commentModeration === "basic" ||
      value.commentModeration === "strict" ||
      value.commentModeration === "hold_all"
        ? value.commentModeration
        : defaultUploadDraft.commentModeration,
    commentPermission:
      value.commentPermission === "all"
        ? value.commentPermission
        : defaultUploadDraft.commentPermission,
    commentSortOrder:
      value.commentSortOrder === "top"
        ? value.commentSortOrder
        : defaultUploadDraft.commentSortOrder,
  };
}

export function normalizeUploadPreset(
  raw: Partial<UploadPreset> | null | undefined,
): UploadPreset {
  const value = raw ?? {};

  return {
    id:
      typeof value.id === "string" && value.id.trim()
        ? value.id
        : createDraftId("preset"),
    name:
      typeof value.name === "string" && value.name.trim()
        ? value.name.trim()
        : "이름 없는 업로드 프로필",
    draft: normalizeUploadDraft(value.draft),
    updatedAt: normalizeUpdatedAt(value.updatedAt),
  };
}
