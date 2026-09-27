"use client";

/**
 * 메인 업로드 화면 (/).
 *
 * 흐름:
 *   1) 롱폼 / 숏츠를 고른 뒤 최종 영상 / 한국어 SRT / 썸네일을 확인
 *   2) Codex가 준비한 한국어 제목·설명·태그를 검수
 *   3) YouTube 제목·설명에 적용할 전체 지원 언어를 확인
 *   4) Codex가 읽을 업로드 요청 패키지를 준비
 *
 * 이 화면은 Codex 같은 에이전트가 만든 한국어 출고 정보를 확정하고,
 * 실행용 입력값을 묶는 작업대 역할을 한다.
 * 숏츠는 말자막이 없는 경우가 많아서 SRT 없이도 영상 메모 기반 요청 패키지를 만들 수 있다.
 */

import Link from "next/link";
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { parseSrt } from "@/lib/srt";
import type { SubtitleCue } from "@/lib/llm/types";
import type { LicenseType, UploadPreset } from "@/lib/upload-preset-types";
import { defaultUploadInteractionSettings } from "@/lib/upload-preset-types";
import type { UploadRunRecord } from "@/lib/upload-run-store";
import type { ChannelProfile, GlossaryEntry } from "@/lib/channel-profile-types";
import { defaultChannelProfile } from "@/lib/channel-profile-types";
import {
  comfyReferralBlock,
  configureDescriptionBlocks,
  discordBlock,
  ensurePermanentDescriptionLinks,
  stripInferredSubtitleGuide,
  stripKnownComfyReferralBlocks,
  stripKnownDenoDiscordBlocks,
  stripTutorialBlocks,
  tutorialBlock,
} from "@/lib/description-policy";
import {
  useUploadStore,
  type ChannelMetaCategory,
  type ChannelMetaLanguage,
  type ChannelMetaPlaylist,
  type ContentKind,
  type PreparedProductionVideo,
  type PreparedUploadRequestResult,
  type PrivacyStatus,
} from "@/lib/upload-store";

type Notice = { tone: "neutral" | "success" | "error"; text: string };

type ChannelLinkPolicy = { comfyReferral: boolean; discord: boolean; tutorialBlocks: boolean };

type UploadChannelSummary = {
  id: string;
  title: string;
  handle: string;
  youtubeChannelId: string;
  descriptionLinks: ChannelLinkPolicy;
  active?: boolean;
  tokenPersistence?: { hasToken: boolean };
};

type AuthStatus = {
  connected: boolean;
  channelTitle?: string;
  channelId?: string;
  error?: string;
  activeChannelId?: string;
  uploadChannel?: UploadChannelSummary;
};

// 채널 정보를 아직 못 받았을 때의 설명 고정 블록 정책. 채널별 값은 /api/auth/status의 uploadChannel이 준다.
const DEFAULT_LINK_POLICY: ChannelLinkPolicy = {
  comfyReferral: false,
  discord: false,
  tutorialBlocks: false,
};

type PreflightItem = {
  id: string;
  label: string;
  status: "ok" | "warn" | "error";
  detail: string;
  actionHref?: string;
};

type PreflightResponse = {
  ok: boolean;
  status: "ok" | "warn" | "error";
  checkedAt: string;
  items: PreflightItem[];
};

type DraftCheck = {
  id: string;
  label: string;
  status: "ok" | "warn" | "error";
  detail: string;
};

type AgentArtifactStatus = "ready" | "missing" | "partial";

type AgentLanguageState = {
  code: string;
  label: string;
  shortLabel: string;
  selected: boolean;
};

type AgentProjectSummary = {
  slug: string;
  displayName: string;
  stage: string;
  updatedAt?: string;
};

type AgentProjectFileState = {
  status: AgentArtifactStatus;
  path?: string;
  count?: number;
  reason?: string;
};

type AgentProjectDetail = AgentProjectSummary & {
  contentKind: ContentKind;
  selectedLanguages: string[];
  files: {
    koreanUpload: AgentProjectFileState;
    koreanClean: AgentProjectFileState;
    reviewedEnglish: AgentProjectFileState;
    captionSourceLock: AgentProjectFileState;
    metadata: AgentProjectFileState;
    uploadManifest: AgentProjectFileState;
  };
  metadata: AgentUploadMetadata | null;
  languages: AgentLanguageState[];
  nextAction: string;
};

type AgentCampaignMetadata = {
  name?: string;
  submissionDeadline?: string;
  trackingLink?: string;
  noAffiliateLinks?: boolean;
  brandApprovalRequired?: boolean;
  descriptionChecklist: string[];
  manualChecklist: string[];
  pinnedCommentDraft?: string;
};

type AgentUploadMetadata = {
  title?: string;
  description?: string;
  allowSubtitleGuide?: boolean;
  categoryId?: string;
  defaultAudioLanguage?: string;
  containsSyntheticMedia?: boolean;
  tags: string[];
  titleCandidates?: string[];
  descriptionCandidates?: string[];
  chapterCandidates?: string[];
  campaign?: AgentCampaignMetadata;
  sourcePath?: string;
};

type UploadRequestResult = PreparedUploadRequestResult;

type UploadRequestSourceSnapshot = {
  contentKind: ContentKind;
  agentProjectSlug: string | null;
  video: FileSnapshot | null;
  subtitle: FileSnapshot | null;
  thumbnail: FileSnapshot | null;
  korean: {
    title: string;
    description: string;
    tags: string[];
    shortsBrief: string;
  };
  options: {
    privacyStatus: PrivacyStatus;
    categoryId: string;
    defaultAudioLanguage: string;
    playlistId: string;
    publishAt: string;
    recordingDate: string;
    madeForKids: boolean;
    containsSyntheticMedia: boolean;
    embeddable: boolean;
    publicStatsViewable: boolean;
    notifySubscribers: boolean;
    license: LicenseType;
    noAffiliateLinks: boolean;
    brandApprovalRequiredBeforePublic: boolean;
  };
  targetLanguages: string[];
};

type FileSnapshot = {
  name: string;
  size: number;
  type: string;
  lastModified: number;
};

type UploadRequestApiPayload = {
  ok?: boolean;
  request?: UploadRequestResult;
  error?: unknown;
};

type VideoStage = {
  uploadId: string;
  status: "receiving" | "complete";
  createdAt: string;
  updatedAt: string;
  originalName: string;
  type: string;
  size: number;
  lastModified: number;
  videoFingerprint: string;
  receivedBytes: number;
  chunkSize: number;
  sha256?: string | null;
  materializationMode: "hardlink" | "copy" | "chunked";
};

type ProductionPreparePayload = {
  ok?: boolean;
  error?: string;
  prepared?: {
    production: string;
    preparationId: string;
    handoffSha256: string;
    video: {
      stage: VideoStage;
      name: string;
      previewUrl: string;
    };
    caption: {
      name: string;
      type: "application/x-subrip";
      base64: string;
      sha256: string;
      timelineSha256: string;
      cueCount: number;
      revision: string;
    };
    thumbnail: null | {
      name: string;
      type: string;
      base64: string;
      sha256: string;
      candidateId: string;
    };
    metadata: Record<string, unknown> | null;
    youtubeChannel?: string;
  };
};

type VideoStageApiPayload = {
  ok?: boolean;
  stage?: VideoStage;
  alreadyReceived?: boolean;
  error?: string | { code?: string; message?: string; detail?: Record<string, unknown> };
};

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function cuesToObjectUrl(cues: SubtitleCue[]): string {
  // <track src="..."> 는 SRT가 아닌 WebVTT를 요구한다.
  // 미리보기용으로 SRT cues를 WebVTT 헤더만 붙여 변환한다.
  const lines = ["WEBVTT", ""];

  for (const cue of cues) {
    const start = msToVttTimestamp(cue.startMs);
    const end = msToVttTimestamp(cue.endMs);
    lines.push(`${start} --> ${end}`);
    lines.push(cue.text);
    lines.push("");
  }

  const blob = new Blob([lines.join("\n")], { type: "text/vtt" });
  return URL.createObjectURL(blob);
}

function msToVttTimestamp(totalMs: number) {
  const safeMs = Math.max(0, Math.floor(totalMs));
  const hours = Math.floor(safeMs / 3_600_000);
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMs % 60_000) / 1_000);
  const millis = safeMs % 1_000;
  return (
    `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`
  );
}

function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isChapterLine(line: string) {
  return /^\d{2}:\d{2}(?::\d{2})?\s+\S/.test(line.trim());
}

function stripFixedDescriptionBlocks(value: string) {
  return stripTutorialBlocks(stripKnownDenoDiscordBlocks(stripKnownComfyReferralBlocks(value)));
}

function extractChapterBlock(value: string) {
  const lines = value.split(/\r?\n/);
  const start = lines.findIndex(isChapterLine);
  if (start < 0) return "";

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith("☁️") || line.startsWith("🚀") || line.startsWith("💻")) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join("\n").trim();
}

function descriptionBodyOnly(value: string) {
  const fixedRemoved = stripFixedDescriptionBlocks(value);
  const lines = fixedRemoved.split(/\r?\n/);
  const chapterStart = lines.findIndex(isChapterLine);
  return (chapterStart >= 0 ? lines.slice(0, chapterStart) : lines)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const HASHTAG_LINE = /^\s*#[^\s#]+(?:\s+#[^\s#]+)*\s*$/u;

/** 첫 챕터 줄 뒤의 해시태그 줄(캠페인 키워드). descriptionBodyOnly가 버리는 부분이라 따로 챙겨 맨 끝에 다시 붙인다. */
function hashtagLinesAfterChapters(value: string) {
  const lines = value.split(/\r?\n/);
  const chapterStart = lines.findIndex(isChapterLine);
  if (chapterStart < 0) return "";
  return lines
    .slice(chapterStart)
    .filter((line) => HASHTAG_LINE.test(line))
    .map((line) => line.trim())
    .join("\n");
}

function ensureCampaignDescriptionLinks(
  value: string,
  noAffiliateLinks = false,
  links: ChannelLinkPolicy = DEFAULT_LINK_POLICY,
) {
  return ensurePermanentDescriptionLinks(value, {
    includeComfyReferral: links.comfyReferral && !noAffiliateLinks,
    includeDiscord: links.discord,
  });
}

function composeUploadDescription(
  body: string,
  chapters?: string,
  noAffiliateLinks = false,
  links: ChannelLinkPolicy = DEFAULT_LINK_POLICY,
) {
  const hashtags = hashtagLinesAfterChapters(body);
  const chapterText = (chapters ?? "")
    .split(/\r?\n/)
    .filter((line) => !HASHTAG_LINE.test(line))
    .join("\n")
    .trim();
  // DENO PICTURES처럼 강의 채널 블록을 쓰지 않는 채널은 본문과 챕터만 둔다.
  if (!links.tutorialBlocks) {
    return ensureCampaignDescriptionLinks(
      [descriptionBodyOnly(body), chapterText, hashtags].filter(Boolean).join("\n\n"),
      noAffiliateLinks,
      links,
    );
  }
  // 강의 채널 순서: 본문 → 챕터 → HUB → PC Spec → ComfyUI → Discord → 해시태그(publishing-handoff.md 「게시 문구 기준」, 2026-09-27).
  return [
    descriptionBodyOnly(body),
    chapterText,
    tutorialBlock("hub"),
    tutorialBlock("pcSpec"),
    noAffiliateLinks || !links.comfyReferral ? null : comfyReferralBlock("ko"),
    links.discord ? discordBlock("ko") : null,
    hashtags,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseTagText(value: string) {
  const seen = new Set<string>();
  return value
    .split(/[,\n\t]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag) => {
      const key = tag.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function mergeTagLists(...groups: string[][]) {
  return parseTagText(groups.flat().join(", "));
}

function formatTagsText(tags: string[]) {
  return mergeTagLists(tags).join(", ");
}

function formatLanguagePreview(labels: string[]) {
  if (labels.length <= 8) return labels.join(", ");
  return `${labels.slice(0, 8).join(", ")} +${labels.length - 8}`;
}

function formatPreparedAt(value: string | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function fileSnapshot(file: File | null): FileSnapshot | null {
  if (!file) return null;
  return {
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
  };
}

function preparedVideoSnapshot(
  video: PreparedProductionVideo | null,
): FileSnapshot | null {
  if (!video) return null;
  return {
    name: video.name,
    size: video.size,
    type: video.type,
    lastModified: video.lastModified,
  };
}

function fileFromBase64(base64: string, name: string, type: string) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], name, { type, lastModified: Date.now() });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function fingerprintSnapshot(snapshot: UploadRequestSourceSnapshot) {
  return hashString(stableStringify(snapshot));
}

function fingerprintVideoFile(file: File) {
  return hashString(
    stableStringify({
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
    }),
  );
}

function videoStageErrorMessage(payload: VideoStageApiPayload | null, status: number) {
  if (typeof payload?.error === "string" && payload.error.trim()) return payload.error;
  if (payload?.error && typeof payload.error === "object") {
    const code = payload.error.code ? ` · ${payload.error.code}` : "";
    return `${payload.error.message || `영상 저장 실패 (HTTP ${status})`}${code}`;
  }
  return `영상 저장 실패 (HTTP ${status})`;
}

async function readVideoStageResponse(response: Response) {
  const payload = (await response.json().catch(() => null)) as VideoStageApiPayload | null;
  if (!response.ok || !payload?.ok || !payload.stage) {
    throw new Error(videoStageErrorMessage(payload, response.status));
  }
  return payload.stage;
}

async function sendVideoStageCommand(body: Record<string, unknown>) {
  const response = await fetch("/api/upload-request/video-staging", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readVideoStageResponse(response);
}

async function stageVideoForRequest(
  file: File,
  currentStage: VideoStage | null,
  onStage: (stage: VideoStage) => void,
  onProgress: (receivedBytes: number, totalBytes: number) => void,
) {
  const videoFingerprint = fingerprintVideoFile(file);
  let stage: VideoStage | null = null;

  if (currentStage?.videoFingerprint === videoFingerprint) {
    try {
      stage = await sendVideoStageCommand({ action: "status", uploadId: currentStage.uploadId });
    } catch {
      stage = null;
    }
  }

  if (
    !stage ||
    stage.videoFingerprint !== videoFingerprint ||
    stage.size !== file.size ||
    stage.originalName !== file.name
  ) {
    stage = await sendVideoStageCommand({
      action: "init",
      videoFingerprint,
      file: {
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
      },
    });
    onStage(stage);
  }

  let offset = stage.receivedBytes;
  onProgress(offset, file.size);
  while (offset < file.size) {
    const end = Math.min(offset + stage.chunkSize, file.size);
    const chunk = file.slice(offset, end);
    let saved: VideoStage | null = null;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 3 && !saved; attempt += 1) {
      try {
        const response = await fetch("/api/upload-request/video-staging", {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "x-upload-id": stage.uploadId,
            "x-upload-offset": String(offset),
            "x-upload-chunk-size": String(chunk.size),
          },
          body: chunk,
        });
        saved = await readVideoStageResponse(response);
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          await new Promise((resolve) => window.setTimeout(resolve, attempt * 200));
        }
      }
    }

    if (!saved) throw lastError instanceof Error ? lastError : new Error("영상 청크 저장에 실패했습니다.");
    stage = saved;
    offset = stage.receivedBytes;
    onStage(stage);
    onProgress(offset, file.size);
  }

  if (stage.status !== "complete") {
    stage = await sendVideoStageCommand({ action: "finalize", uploadId: stage.uploadId });
    onStage(stage);
  }
  return stage;
}

function uploadRequestErrorMessage(payload: unknown, status: number) {
  if (payload && typeof payload === "object") {
    const record = payload as {
      error?: string | { message?: string; code?: string; saved?: boolean };
    };
    if (typeof record.error === "string" && record.error.trim()) {
      return `저장 안 됨: ${record.error}`;
    }
    if (record.error && typeof record.error === "object") {
      const message = record.error.message || `요청 패키지 준비 실패 (HTTP ${status})`;
      const code = record.error.code ? ` · ${record.error.code}` : "";
      return `저장 안 됨${code}: ${message}`;
    }
  }

  return `저장 안 됨: 서버가 요청 패키지를 만들지 못했습니다. HTTP ${status}`;
}

async function readUploadRequestResponse(response: Response) {
  const text = await response.text();
  let payload: UploadRequestApiPayload | null = null;

  try {
    payload = text ? (JSON.parse(text) as UploadRequestApiPayload) : null;
  } catch {
    throw new Error(
      `저장 안 됨: 서버가 JSON 응답을 돌려주지 않았습니다. HTTP ${response.status}`,
    );
  }

  if (!response.ok || !payload?.ok || !payload.request) {
    throw new Error(uploadRequestErrorMessage(payload, response.status));
  }

  return payload.request;
}

export default function MainUploadPage() {
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const srtInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const stagedVideoRef = useRef<VideoStage | null>(null);
  const selectedAgentSlugRef = useRef<string>("");
  const metadataAutoAppliedSlugRef = useRef<string | null>(null);
  const [metadataMode, setMetadataMode] = useState<"saved" | "agent" | "manual">("manual");

  // 작업 상태는 layout 레벨 store에서 — 페이지 전환(메인 ↔ 설정)에도 유지된다.
  // 진행 중인 fetch도 store setter로 결과를 쓰므로 페이지 unmount와 무관.
  const {
    videoFile,
    videoUrl,
    preparedProductionVideo,
    srtFile,
    koreanCues,
    thumbnailFile,
    thumbnailUrl,
    setVideo,
    setPreparedProductionVideo,
    setSrt,
    setThumbnail,
    contentKind,
    setContentKind,
    shortsBrief,
    setShortsBrief,
    koreanTitle,
    setKoreanTitle,
    koreanDescription,
    setKoreanDescription,
    koreanTagsText,
    setKoreanTagsText,
    privacyStatus,
    setPrivacyStatus,
    preparedUploadRequest: uploadRequestResult,
    setPreparedUploadRequest: setUploadRequestResult,
    resetWorkspace,
    // m28 — 업로드 옵션
    categoryId,
    setCategoryId,
    defaultAudioLanguage,
    setDefaultAudioLanguage,
    playlistId,
    setPlaylistId,
    publishAt,
    setPublishAt,
    recordingDate,
    setRecordingDate,
    madeForKids,
    setMadeForKids,
    containsSyntheticMedia,
    setContainsSyntheticMedia,
    embeddable,
    setEmbeddable,
    publicStatsViewable,
    setPublicStatsViewable,
    notifySubscribers,
    setNotifySubscribers,
    license,
    setLicense,
    channelPlaylists,
    setChannelPlaylists,
    channelCategories,
    setChannelCategories,
    channelLanguages,
    setChannelLanguages,
    presets,
    setPresets,
    activePresetId,
    setActivePresetId,
    applyPresetDraft,
  } = useUploadStore();

  const thumbnailInputRef = useRef<HTMLInputElement | null>(null);

  // 페이지 마운트 시 fetch하는 가벼운 메타데이터는 페이지 local 유지.
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [uploadChannels, setUploadChannels] = useState<UploadChannelSummary[]>([]);
  // 설명 고정 블록(channels.json) 설정을 받은 뒤에만 준비된 설명을 자동 적용한다 — 먼저 적용하면 ComfyUI·Discord 제목 줄만 빠진다(2026-09-27).
  const [descriptionBlocksReady, setDescriptionBlocksReady] = useState(false);
  const [channelEpoch, setChannelEpoch] = useState(0);
  const [channelSwitching, setChannelSwitching] = useState(false);
  const channelLinkPolicy = auth?.uploadChannel?.descriptionLinks ?? DEFAULT_LINK_POLICY;
  // 작품 불러오기 같은 콜백이 선택 채널 때문에 다시 만들어지지 않도록 ref로 읽는다.
  const activeUploadChannelIdRef = useRef<string>("");

  // m30-B: 채널 프로필 (디노/Dino/Deno + 용어집). 한 채널당 1개라 페이지 local.
  const [channelProfile, setChannelProfile] = useState<ChannelProfile>(
    defaultChannelProfile,
  );
  const [channelProfileSaving, setChannelProfileSaving] = useState(false);

  // UI 토글·임시 메시지·요청 패키지 진행 표시는 페이지 local 유지.
  const [previewSubtitlesOn, setPreviewSubtitlesOn] = useState(true);
  const [preparingRequest, setPreparingRequest] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [runs, setRuns] = useState<UploadRunRecord[]>([]);
  const [opsLoading, setOpsLoading] = useState(false);
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);
  const [selectedAgentSlug, setSelectedAgentSlug] = useState<string>("");
  const [agentProject, setAgentProject] = useState<AgentProjectDetail | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentWorkspaceError, setAgentWorkspaceError] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");

  // 업로드 채널 전환: 서버의 선택 채널을 바꾸고 연결 상태·프리셋·채널 정보·재생목록을 다시 읽는다.
  // 재생목록은 채널마다 다르므로 고른 재생목록은 비운다. 의존값이 setter뿐이라 다시 만들어지지 않는다.
  const switchUploadChannel = useCallback(
    async (channelId: string, message?: string) => {
      if (channelId === activeUploadChannelIdRef.current) return true;
      setChannelSwitching(true);
      try {
        const response = await fetch("/api/channels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel: channelId }),
        });
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
          channels?: UploadChannelSummary[];
        };
        if (!response.ok) throw new Error(data.error || "채널을 바꾸지 못했습니다.");
        if (Array.isArray(data.channels)) setUploadChannels(data.channels);
        activeUploadChannelIdRef.current = channelId;
        setChannelPlaylists([]);
        setPlaylistId("");
        setChannelEpoch((value) => value + 1);
        const next = data.channels?.find((channel) => channel.id === channelId);
        setNotice({
          tone: "neutral",
          text:
            message ??
            `업로드 채널을 ${next?.title ?? channelId}(으)로 바꿨습니다. 프리셋·재생목록·설명 고정 블록이 이 채널 기준입니다.`,
        });
        return true;
      } catch (error) {
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "채널을 바꾸지 못했습니다.",
        });
        return false;
      } finally {
        setChannelSwitching(false);
      }
    },
    [setChannelPlaylists, setPlaylistId],
  );
  const currentTags = useMemo(() => parseTagText(koreanTagsText), [koreanTagsText]);
  const campaignNoAffiliateLinks = agentProject?.metadata?.campaign?.noAffiliateLinks === true;
  const campaignBrandApprovalRequired =
    agentProject?.metadata?.campaign?.brandApprovalRequired === true;
  const requestTags = useMemo(
    () => mergeTagLists(currentTags, parseTagText(tagDraft)),
    [currentTags, tagDraft],
  );
  const selectedTargetLanguages = useMemo(
    () => agentProject?.languages.filter((language) => language.selected) ?? [],
    [agentProject],
  );
  const selectedTargetLanguageCodes = useMemo(
    () => selectedTargetLanguages.map((language) => language.code),
    [selectedTargetLanguages],
  );
  const selectedTargetLanguageCount = selectedTargetLanguages.length;
  const uploadRequestSourceSnapshot = useMemo<UploadRequestSourceSnapshot>(
    () => ({
      contentKind,
      agentProjectSlug: contentKind === "shorts" ? null : agentProject?.slug ?? null,
      video: fileSnapshot(videoFile) ?? preparedVideoSnapshot(preparedProductionVideo),
      subtitle: contentKind === "cinematic" ? null : fileSnapshot(srtFile),
      thumbnail: fileSnapshot(thumbnailFile),
      korean: {
        title: contentKind === "shorts" ? "" : koreanTitle.trim(),
        description:
          contentKind === "shorts"
            ? ""
            : ensureCampaignDescriptionLinks(
                koreanDescription,
                campaignNoAffiliateLinks,
                channelLinkPolicy,
              ),
        tags: contentKind === "shorts" ? [] : requestTags,
        shortsBrief: shortsBrief.trim(),
      },
      options: {
        privacyStatus,
        categoryId: categoryId.trim(),
        defaultAudioLanguage: defaultAudioLanguage.trim(),
        playlistId: playlistId.trim(),
        publishAt: publishAt.trim(),
        recordingDate: recordingDate.trim(),
        madeForKids,
        containsSyntheticMedia,
        embeddable,
        publicStatsViewable,
        notifySubscribers,
        license,
        noAffiliateLinks: campaignNoAffiliateLinks,
        brandApprovalRequiredBeforePublic: campaignBrandApprovalRequired,
      },
      targetLanguages: contentKind === "shorts" ? [] : selectedTargetLanguageCodes,
    }),
    [
      categoryId,
      agentProject?.slug,
      campaignNoAffiliateLinks,
      channelLinkPolicy,
      campaignBrandApprovalRequired,
      contentKind,
      containsSyntheticMedia,
      defaultAudioLanguage,
      embeddable,
      koreanDescription,
      koreanTitle,
      license,
      madeForKids,
      notifySubscribers,
      playlistId,
      privacyStatus,
      publicStatsViewable,
      publishAt,
      recordingDate,
      requestTags,
      selectedTargetLanguageCodes,
      shortsBrief,
      srtFile,
      thumbnailFile,
      videoFile,
      preparedProductionVideo,
    ],
  );
  const currentUploadRequestFingerprint = useMemo(
    () => fingerprintSnapshot(uploadRequestSourceSnapshot),
    [uploadRequestSourceSnapshot],
  );
  const uploadRequestIsCurrent = Boolean(
    uploadRequestResult?.sourceFingerprint &&
      uploadRequestResult.sourceFingerprint === currentUploadRequestFingerprint,
  );

  const refreshOperationsStatus = useCallback(async () => {
    setOpsLoading(true);
    try {
      const [preflightResponse, runsResponse] = await Promise.all([
        fetch("/api/preflight", { cache: "no-store" }),
        fetch("/api/runs", { cache: "no-store" }),
      ]);

      if (preflightResponse.ok) {
        const data = (await preflightResponse.json()) as PreflightResponse;
        setPreflight(data);
      }

      if (runsResponse.ok) {
        const data = (await runsResponse.json()) as {
          ok?: boolean;
          runs?: UploadRunRecord[];
        };
        if (Array.isArray(data.runs)) setRuns(data.runs);
      }
    } catch {
      setPreflight({
        ok: false,
        status: "error",
        checkedAt: new Date().toISOString(),
        items: [
          {
            id: "preflight-fetch",
            label: "사전 점검",
            status: "error",
            detail: "현재 앱 상태를 읽지 못했습니다.",
          },
        ],
      });
    } finally {
      setOpsLoading(false);
    }
  }, []);

  const retryRunAttachments = useCallback(async (runId: string) => {
    setRetryingRunId(runId);
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/retry-attachments`, {
        method: "POST",
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        warnings?: string[];
      };

      if (!response.ok || !data.ok) {
        throw new Error(data.error || "부가 작업 재시도에 실패했습니다.");
      }

      setNotice({
        tone: data.warnings && data.warnings.length > 0 ? "neutral" : "success",
        text:
          data.warnings && data.warnings.length > 0
            ? "재시도는 끝났지만 일부 항목이 아직 실패 상태입니다."
            : "실패한 부가 작업을 다시 처리했습니다.",
      });
      await refreshOperationsStatus();
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "부가 작업 재시도에 실패했습니다.",
      });
    } finally {
      setRetryingRunId(null);
    }
  }, [refreshOperationsStatus]);

  const refreshAgentProjects = useCallback(async () => {
    setAgentLoading(true);
    setAgentWorkspaceError(null);
    try {
      const response = await fetch("/api/agent-workspace/projects", {
        cache: "no-store",
      });
      const data = (await response.json()) as {
        ok?: boolean;
        projects?: AgentProjectSummary[];
        activeSlug?: string | null;
        error?: string;
      };

      if (!response.ok || !data.ok || !Array.isArray(data.projects)) {
        throw new Error(data.error || "작업 목록을 읽지 못했습니다.");
      }

      const projects = data.projects;
      const activeSlug =
        typeof data.activeSlug === "string" &&
        projects.some((project) => project.slug === data.activeSlug)
          ? data.activeSlug
          : "";
      if (selectedAgentSlugRef.current !== activeSlug || !activeSlug) {
        resetWorkspace();
        stagedVideoRef.current = null;
        metadataAutoAppliedSlugRef.current = null;
      }
      selectedAgentSlugRef.current = activeSlug;
      setSelectedAgentSlug(activeSlug);
      if (!activeSlug) setAgentProject(null);
    } catch (error) {
      setAgentWorkspaceError(
        error instanceof Error ? error.message : "업로드 패키지 정보를 읽지 못했습니다.",
      );
    } finally {
      setAgentLoading(false);
    }
  }, [resetWorkspace]);

  const loadAgentProject = useCallback(async (slug: string) => {
    if (!slug) {
      setAgentProject(null);
      return;
    }

    setAgentLoading(true);
    setAgentWorkspaceError(null);
    try {
      const response = await fetch(
        `/api/agent-workspace/projects/${encodeURIComponent(slug)}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as {
        ok?: boolean;
        project?: AgentProjectDetail;
        error?: string;
      };

      if (!response.ok || !data.ok || !data.project) {
        throw new Error(data.error || "프로젝트 상태를 읽지 못했습니다.");
      }

      setAgentProject(data.project);
      if (data.project.files.uploadManifest.status !== "ready") return;
      const prepareResponse = await fetch(
        `/api/agent-workspace/projects/${encodeURIComponent(slug)}/prepare`,
        { method: "POST" },
      );
      const prepareData = (await prepareResponse.json()) as ProductionPreparePayload;
      if (!prepareResponse.ok || !prepareData.ok || !prepareData.prepared) {
        throw new Error(
          `master 자동 준비 차단: ${prepareData.error || "PRODUCTION_PREPARE_FAILED"}`,
        );
      }

      const prepared = prepareData.prepared;
      if (prepared.youtubeChannel && prepared.youtubeChannel !== activeUploadChannelIdRef.current) {
        const switched = await switchUploadChannel(
          prepared.youtubeChannel,
          `이 작품(${prepared.production})은 인계 파일에 지정된 채널용이라 업로드 채널을 바꿨습니다. 화면 위 채널을 확인해 주세요.`,
        );
        if (!switched) throw new Error("작품에 지정된 업로드 채널로 바꾸지 못했습니다.");
      }
      const preparedVideo: PreparedProductionVideo = {
        production: prepared.production,
        preparationId: prepared.preparationId,
        handoffSha256: prepared.handoffSha256,
        uploadId: prepared.video.stage.uploadId,
        status: "complete",
        name: prepared.video.name,
        type: prepared.video.stage.type,
        size: prepared.video.stage.size,
        lastModified: prepared.video.stage.lastModified,
        sha256: prepared.video.stage.sha256 ?? "",
        videoFingerprint: prepared.video.stage.videoFingerprint,
        previewUrl: prepared.video.previewUrl,
        materializationMode: prepared.video.stage.materializationMode,
      };
      setPreparedProductionVideo(preparedVideo);
      stagedVideoRef.current = prepared.video.stage;

      const captionFile = fileFromBase64(
        prepared.caption.base64,
        prepared.caption.name,
        prepared.caption.type,
      );
      const parsedCaption = parseSrt(await captionFile.text());
      setSrt(
        captionFile,
        parsedCaption.cues.map((cue) => ({
          index: cue.index,
          startMs: cue.startMs,
          endMs: cue.endMs,
          text: cue.text,
        })),
      );

      if (prepared.thumbnail) {
        setThumbnail(
          fileFromBase64(
            prepared.thumbnail.base64,
            prepared.thumbnail.name,
            prepared.thumbnail.type,
          ),
        );
      } else {
        setThumbnail(null);
      }
    } catch (error) {
      setAgentWorkspaceError(
        error instanceof Error ? error.message : "프로젝트 상태를 읽지 못했습니다.",
      );
    } finally {
      setAgentLoading(false);
    }
  }, [setPreparedProductionVideo, setSrt, setThumbnail, switchUploadChannel]);

  // ───── 초기 로딩 ─────
  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        const response = await fetch("/api/auth/status", { cache: "no-store" });
        const data = (await response.json()) as AuthStatus;
        if (active) {
          setAuth(data);
          if (data.uploadChannel?.id) activeUploadChannelIdRef.current = data.uploadChannel.id;
        }
      } catch {}
      try {
        const response = await fetch("/api/channels", { cache: "no-store" });
        const data = (await response.json()) as { channels?: UploadChannelSummary[]; activeChannelId?: string; descriptionBlocks?: unknown };
        if (data.descriptionBlocks) configureDescriptionBlocks(data.descriptionBlocks);
        if (active && Array.isArray(data.channels)) setUploadChannels(data.channels);
        if (active && data.activeChannelId && !activeUploadChannelIdRef.current) activeUploadChannelIdRef.current = data.activeChannelId;
      } catch {}
      if (active) setDescriptionBlocksReady(true);
    })();

    return () => {
      active = false;
    };
  }, [channelEpoch]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshOperationsStatus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshOperationsStatus]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshAgentProjects();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshAgentProjects]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAgentProject(selectedAgentSlug);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAgentProject, selectedAgentSlug]);

  useEffect(() => {
    if (!agentProject?.contentKind || agentProject.contentKind === contentKind) return;
    setContentKind(agentProject.contentKind);
  }, [agentProject?.contentKind, contentKind, setContentKind]);

  const applyAgentMetadata = useCallback(
    (metadata: AgentUploadMetadata | null | undefined, mode: "empty-only" | "force") => {
      if (!metadata) return false;

      let applied = false;
      if (metadata.title && (mode === "force" || !koreanTitle.trim())) {
        setKoreanTitle(metadata.title);
        applied = true;
      }

      const safeDescription = metadata.description
        ? metadata.allowSubtitleGuide
          ? metadata.description
          : stripInferredSubtitleGuide(metadata.description)
        : "";
      if (safeDescription && (mode === "force" || !koreanDescription.trim())) {
        setKoreanDescription(
          ensureCampaignDescriptionLinks(
            safeDescription,
            metadata.campaign?.noAffiliateLinks === true,
            channelLinkPolicy,
          ),
        );
        applied = true;
      }

      if (metadata.tags.length > 0 && (mode === "force" || !koreanTagsText.trim())) {
        setKoreanTagsText(formatTagsText(metadata.tags));
        applied = true;
      }

      if (metadata.categoryId) {
        setCategoryId(metadata.categoryId);
        applied = true;
      }
      if (metadata.defaultAudioLanguage) {
        setDefaultAudioLanguage(metadata.defaultAudioLanguage);
        applied = true;
      }
      if (typeof metadata.containsSyntheticMedia === "boolean") {
        setContainsSyntheticMedia(metadata.containsSyntheticMedia);
        applied = true;
      }

      if (applied) setMetadataMode("saved");
      return applied;
    },
    [
      channelLinkPolicy,
      koreanDescription,
      koreanTagsText,
      koreanTitle,
      setKoreanDescription,
      setKoreanTagsText,
      setKoreanTitle,
      setCategoryId,
      setContainsSyntheticMedia,
      setDefaultAudioLanguage,
    ],
  );

  useEffect(() => {
    if (!agentProject?.metadata || !descriptionBlocksReady) return;
    if (metadataAutoAppliedSlugRef.current === agentProject.slug) return;

    const timer = window.setTimeout(() => {
      applyAgentMetadata(agentProject.metadata, "empty-only");
      metadataAutoAppliedSlugRef.current = agentProject.slug;
    }, 0);

    return () => window.clearTimeout(timer);
  }, [agentProject, applyAgentMetadata, descriptionBlocksReady]);

  // ───── m28: 채널 메타 + 프리셋 초기 fetch ─────
  // 인증 연결 후에만 채널 메타 fetch (재생목록·카테고리·언어는 YouTube 로그인 필요).
  // 프리셋은 인증과 무관하게 로드.
  const authConnected = auth?.connected ?? false;

  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        const response = await fetch("/api/presets", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { presets?: UploadPreset[] };
        if (active && Array.isArray(data.presets)) {
          setPresets(data.presets);
        }
      } catch {}

      // m30-B: 채널 프로필도 같이 fetch.
      try {
        const response = await fetch("/api/channel-profile", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { profile?: ChannelProfile };
        if (active && data.profile) {
          setChannelProfile(data.profile);
        }
      } catch {}
    })();

    return () => {
      active = false;
    };
  }, [setPresets, channelEpoch]);

  // m30-B: 채널 프로필 저장.
  async function saveChannelProfileNow(next: ChannelProfile): Promise<void> {
    setChannelProfileSaving(true);
    try {
      const response = await fetch("/api/channel-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error || "채널 정보 저장 실패");
      }
      const data = (await response.json()) as { profile: ChannelProfile };
      setChannelProfile(data.profile);
    } finally {
      setChannelProfileSaving(false);
    }
  }

  useEffect(() => {
    if (!authConnected) return;
    let active = true;

    void (async () => {
      // 재생목록
      try {
        const response = await fetch("/api/playlists", { cache: "no-store" });
        if (response.ok) {
          const data = (await response.json()) as {
            playlists?: ChannelMetaPlaylist[];
          };
          if (active && Array.isArray(data.playlists)) {
            setChannelPlaylists(data.playlists);
          }
        }
      } catch {}

      // 카테고리 (디노 채널은 KR. 다른 채널은 추후 setting에서 변경 가능).
      try {
        const response = await fetch("/api/categories?regionCode=KR", {
          cache: "no-store",
        });
        if (response.ok) {
          const data = (await response.json()) as {
            ok: boolean;
            categories?: ChannelMetaCategory[];
          };
          if (active && data.ok && Array.isArray(data.categories)) {
            setChannelCategories(data.categories);
          }
        }
      } catch {}

      // 지원 언어 (음성 언어 드롭다운용).
      try {
        const response = await fetch("/api/languages", { cache: "no-store" });
        if (response.ok) {
          const data = (await response.json()) as {
            languages?: ChannelMetaLanguage[];
          };
          if (active && Array.isArray(data.languages)) {
            setChannelLanguages(data.languages);
          }
        }
      } catch {}
    })();

    return () => {
      active = false;
    };
  }, [authConnected, channelEpoch, setChannelPlaylists, setChannelCategories, setChannelLanguages]);

  // ObjectURL 정리(영상 교체 시 이전 URL revoke)는 store의 setVideo가 책임진다.

  // ───── 파일 입력 ─────
  function loadVideo(file: File) {
    setVideo(file);
  }

  function loadSrt(file: File) {
    void (async () => {
      const text = await file.text();
      const parsed = parseSrt(text);
      const cues: SubtitleCue[] = parsed.cues.map((cue) => ({
        index: cue.index,
        startMs: cue.startMs,
        endMs: cue.endMs,
        text: cue.text,
      }));
      setSrt(file, cues);
      if (parsed.warnings.length > 0) {
        setNotice({
          tone: "neutral",
          text: `자막 파일에서 ${parsed.warnings.length}건 경고가 있었지만 계속 진행할 수 있습니다.`,
        });
      }
    })();
  }

  function handleVideoInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) loadVideo(file);
    event.target.value = "";
  }

  function handleVideoDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const file = Array.from(event.dataTransfer.files).find((item) =>
      item.type.startsWith("video/"),
    );
    if (file) loadVideo(file);
    else setNotice({ tone: "error", text: "영상 파일을 인식하지 못했습니다." });
  }

  function handleSrtInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) loadSrt(file);
    event.target.value = "";
  }

  function handleSrtDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const file = Array.from(event.dataTransfer.files).find((item) =>
      item.name.toLowerCase().endsWith(".srt"),
    );
    if (file) loadSrt(file);
    else setNotice({ tone: "error", text: "SRT 자막 파일을 인식하지 못했습니다." });
  }

  function handleThumbnailInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) setThumbnail(file);
    event.target.value = "";
  }

  function handleThumbnailDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const file = Array.from(event.dataTransfer.files).find((item) =>
      item.type.startsWith("image/"),
    );
    if (file) setThumbnail(file);
    else setNotice({ tone: "error", text: "이미지 파일을 인식하지 못했습니다 (JPG/PNG)." });
  }

  function markManualMetadataEdit() {
    setMetadataMode("manual");
  }

  function applySuggestedTitle(value: string) {
    setKoreanTitle(value);
    setMetadataMode("agent");
  }

  function applySuggestedDescription(value: string) {
    const existingChapters =
      extractChapterBlock(koreanDescription) ||
      agentProject?.metadata?.chapterCandidates?.[0] ||
      "";
    const safeDescription = agentProject?.metadata?.allowSubtitleGuide
      ? value
      : stripInferredSubtitleGuide(value);
    setKoreanDescription(
      contentKind === "cinematic"
        ? ensureCampaignDescriptionLinks(safeDescription, campaignNoAffiliateLinks, channelLinkPolicy)
        : composeUploadDescription(
            safeDescription,
            existingChapters,
            campaignNoAffiliateLinks,
            channelLinkPolicy,
          ),
    );
    setMetadataMode("agent");
  }

  function applySuggestedChapters(value: string) {
    setKoreanDescription((current) => {
      // 원문 전체를 넘긴다: 본문은 composeUploadDescription이 떼고, 챕터 뒤 해시태그 줄은 그대로 보존한다.
      const source = current || agentProject?.metadata?.description || "";
      return composeUploadDescription(source, value, campaignNoAffiliateLinks, channelLinkPolicy);
    });
    setMetadataMode("agent");
  }

  function applySuggestedTags(tags: string[]) {
    setKoreanTagsText(formatTagsText(tags));
    setMetadataMode("agent");
  }

  function commitKoreanTagDraft(raw = tagDraft) {
    const additions = parseTagText(raw);
    if (additions.length === 0) return;
    markManualMetadataEdit();
    setKoreanTagsText(formatTagsText(mergeTagLists(currentTags, additions)));
    setTagDraft("");
  }

  function removeKoreanTag(tag: string) {
    markManualMetadataEdit();
    setKoreanTagsText(formatTagsText(currentTags.filter((currentTag) => currentTag !== tag)));
  }

  function clearKoreanTags() {
    markManualMetadataEdit();
    setKoreanTagsText("");
    setTagDraft("");
  }

  // ───── m28: 프리셋 핸들러 ─────
  function handleApplyPreset(preset: UploadPreset) {
    applyPresetDraft(preset.draft);
    setActivePresetId(preset.id);
    setNotice({
      tone: "success",
      text: `프리셋 "${preset.name}" 적용됨. 영상별 옵션(예약공개·촬영일)은 그대로 둔다.`,
    });
  }

  async function handleSavePreset(name: string, id?: string): Promise<void> {
    // 현재 store 상태를 UploadDraft 형태로 모아 /api/presets에 POST.
    // id가 있으면 그 id로 덮어쓰기(=업데이트), 없으면 새로 생성.
    const draft = {
      title: koreanTitle,
      description: ensureCampaignDescriptionLinks(
        koreanDescription,
        campaignNoAffiliateLinks,
        channelLinkPolicy,
      ),
      tags: koreanTagsText,
      defaultLanguage: "ko",
      defaultAudioLanguage,
      categoryId,
      localizations: [],
      subtitleTracks: [{ id: "subtitle-ko", language: "ko", label: "" }],
      privacyStatus,
      license,
      playlistId,
      thumbnailChoice: "A" as const,
      madeForKids,
      containsSyntheticMedia,
      notifySubscribers,
      embeddable,
      publicStatsViewable,
    };

    const response = await fetch("/api/presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, draft, ...(id ? { id } : {}) }),
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || "프리셋 저장에 실패했습니다.");
    }

    const data = (await response.json()) as {
      preset: UploadPreset;
      presets: UploadPreset[];
    };
    setPresets(data.presets);
    setActivePresetId(data.preset.id);
  }

  async function handleDeletePreset(id: string): Promise<void> {
    const response = await fetch("/api/presets", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || "프리셋 삭제에 실패했습니다.");
    }

    const data = (await response.json()) as { presets: UploadPreset[] };
    setPresets(data.presets);
    if (activePresetId === id) setActivePresetId(null);
  }

  function buildDraftSnapshot(): string {
    // 사용자 보기용 — 어떤 값이 저장될지 확인.
    return JSON.stringify(
      {
        한국어제목: koreanTitle || "(비어 있음)",
        한국어설명: koreanDescription ? "(작성됨)" : "(비어 있음)",
        태그: koreanTagsText || "(비어 있음)",
        카테고리: categoryId,
        음성언어: defaultAudioLanguage,
        재생목록: playlistId || "(없음)",
        공개설정: privacyStatus,
        라이선스: license,
        아동용: madeForKids,
        AI콘텐츠: containsSyntheticMedia,
        임베드: embeddable,
        통계공개: publicStatsViewable,
        댓글: "켬",
        댓글검토: "없음",
        댓글허용: "모든 사용자",
        댓글정렬: "최신순",
        구독자알림: notifySubscribers,
      },
      null,
      2,
    );
  }

  // ───── 사용자 완료 및 exact 업로드 요청 패키지 ─────
  async function prepareUploadRequest() {
    if (!videoFile && !preparedProductionVideo) {
      setNotice({ tone: "error", text: "영상 파일이 없습니다." });
      return;
    }
    if (contentKind === "longform" && (koreanCues.length === 0 || !srtFile)) {
      setNotice({ tone: "error", text: "한국어 자막이 없습니다." });
      return;
    }
    if (contentKind === "shorts" && !shortsBrief.trim()) {
      setNotice({ tone: "error", text: "숏츠 영상 메모를 적어주세요." });
      return;
    }
    if (contentKind !== "shorts" && (!koreanTitle.trim() || !koreanDescription.trim())) {
      setNotice({ tone: "error", text: "한국어 제목·설명을 채워주세요." });
      return;
    }
    if (contentKind !== "shorts" && !agentProject?.slug) {
      setNotice({
        tone: "error",
        text: "현재 영상과 연결된 프로젝트를 선택해 주세요.",
      });
      return;
    }

    const subtitleTracks: Array<{ id: string; language: string; label: string }> =
      contentKind === "longform" && srtFile && koreanCues.length > 0
        ? [{ id: "subtitle-ko", language: "ko", label: "한국어" }]
        : [];
    const subtitleFiles: Array<{ trackId: string; file: File }> =
      contentKind === "longform" && srtFile && koreanCues.length > 0
        ? [{ trackId: "subtitle-ko", file: srtFile }]
        : [];

    const localizations: Array<{
      language: string;
      title: string;
      description: string;
    }> = [];
    const targetLanguages =
      contentKind === "shorts" ? [] : selectedTargetLanguageCodes;
    const requestTagsText = formatTagsText(requestTags);

    const formData = new FormData();
    formData.append("contentKind", contentKind);
    formData.append("title", contentKind === "shorts" ? "" : koreanTitle.trim());
    formData.append(
      "description",
      contentKind === "shorts"
        ? ""
        : ensureCampaignDescriptionLinks(
            koreanDescription,
            campaignNoAffiliateLinks,
            channelLinkPolicy,
          ),
    );
    formData.append("noAffiliateLinks", campaignNoAffiliateLinks ? "true" : "false");
    // 화면이 기준으로 삼은 채널. 서버의 선택 채널과 다르면 저장하지 않는다(다른 창에서 바꾼 경우).
    formData.append("uploadChannelId", auth?.uploadChannel?.id ?? "");
    formData.append(
      "brandApprovalRequiredBeforePublic",
      campaignBrandApprovalRequired ? "true" : "false",
    );
    formData.append("defaultLanguage", "ko");
    formData.append("tags", contentKind === "shorts" ? "" : requestTagsText);
    formData.append("privacyStatus", privacyStatus);
    if (shortsBrief.trim()) formData.append("shortsBrief", shortsBrief.trim());

    // m28 — 사용자 선택값 그대로 전송 (이전 하드코딩 제거).
    formData.append("madeForKids", madeForKids ? "true" : "false");
    formData.append(
      "containsSyntheticMedia",
      containsSyntheticMedia ? "true" : "false",
    );
    formData.append("embeddable", embeddable ? "true" : "false");
    formData.append(
      "publicStatsViewable",
      publicStatsViewable ? "true" : "false",
    );
    formData.append(
      "commentVisibility",
      defaultUploadInteractionSettings.commentVisibility,
    );
    formData.append(
      "commentModeration",
      defaultUploadInteractionSettings.commentModeration,
    );
    formData.append(
      "commentPermission",
      defaultUploadInteractionSettings.commentPermission,
    );
    formData.append(
      "commentSortOrder",
      defaultUploadInteractionSettings.commentSortOrder,
    );
    formData.append("notifySubscribers", notifySubscribers ? "true" : "false");
    formData.append("license", license);

    // m28 — 새 옵션들 (빈 값이면 서버가 무시).
    if (categoryId.trim()) formData.append("categoryId", categoryId.trim());
    if (defaultAudioLanguage.trim()) {
      formData.append("defaultAudioLanguage", defaultAudioLanguage.trim());
    }
    if (playlistId.trim()) formData.append("playlistId", playlistId.trim());
    if (publishAt.trim()) formData.append("publishAt", publishAt.trim());
    if (recordingDate.trim()) {
      formData.append("recordingDate", recordingDate.trim());
    }

    formData.append("subtitleTracks", JSON.stringify(subtitleTracks));
    formData.append("localizations", JSON.stringify(localizations));
    formData.append("targetLanguages", JSON.stringify(targetLanguages));
    formData.append("sourceFingerprint", currentUploadRequestFingerprint);
    formData.append("sourceSnapshot", JSON.stringify(uploadRequestSourceSnapshot));
    if (contentKind !== "shorts" && agentProject?.slug) {
      formData.append("agentProjectSlug", agentProject.slug);
    }
    if (preparedProductionVideo) {
      formData.append(
        "productionPreparationId",
        preparedProductionVideo.preparationId,
      );
    }
    if (uploadRequestResult?.requestId) {
      formData.append("supersedesRequestId", uploadRequestResult.requestId);
    }

    if (thumbnailFile) {
      formData.append("thumbnailA", thumbnailFile);
      formData.append("thumbnailChoice", "A");
    }

    for (const { trackId, file } of subtitleFiles) {
      formData.append(`subtitleFile:${trackId}`, file);
    }

    setPreparingRequest(true);
    if (tagDraft.trim() && contentKind !== "shorts") {
      setKoreanTagsText(requestTagsText);
      setTagDraft("");
    }
    setNotice({
      tone: "neutral",
      text: "영상 파일을 로컬 요청 공간에 안전하게 저장하는 중입니다...",
    });
    try {
      const stagedVideo = preparedProductionVideo
        ? await sendVideoStageCommand({
            action: "status",
            uploadId: preparedProductionVideo.uploadId,
          })
        : await stageVideoForRequest(
            videoFile!,
            stagedVideoRef.current,
            (stage) => {
              stagedVideoRef.current = stage;
            },
            (receivedBytes, totalBytes) => {
              const percent = Math.min(100, Math.floor((receivedBytes / totalBytes) * 100));
              setNotice({
                tone: "neutral",
                text: `영상 저장 중 ${percent}% · ${formatFileSize(receivedBytes)} / ${formatFileSize(totalBytes)}`,
              });
            },
          );
      if (stagedVideo.status !== "complete") {
        throw new Error("영상 파일의 로컬 저장이 완료되지 않았습니다.");
      }
      if (
        preparedProductionVideo &&
        (stagedVideo.sha256 !== preparedProductionVideo.sha256 ||
          stagedVideo.size !== preparedProductionVideo.size)
      ) {
        throw new Error("production master staging evidence가 현재 handoff와 다릅니다.");
      }
      formData.append("stagedVideoId", stagedVideo.uploadId);
      setNotice({
        tone: "neutral",
        text:
          contentKind === "cinematic"
            ? "영상 저장을 확인했습니다. 자막 없음 선언과 현재 화면 값을 요청 패키지로 고정하는 중입니다..."
            : "영상 저장을 확인했습니다. 최종 한국어 자막과 현재 화면 값을 요청 패키지로 고정하는 중입니다...",
      });
      const response = await fetch("/api/upload-request", {
        method: "POST",
        body: formData,
      });
      const requestResult = await readUploadRequestResponse(response);
      if (requestResult.sourceFingerprint !== currentUploadRequestFingerprint) {
        throw new Error(
          "저장 안 됨: 서버가 돌려준 요청값이 현재 화면 입력값과 일치하지 않습니다.",
        );
      }
      setUploadRequestResult(requestResult);
      setNotice({
        tone: "success",
        text: uploadRequestResult
          ? requestResult.previousRequestSuperseded
            ? "수정된 현재 값으로 완료했습니다. 직전 요청은 실행 대상에서 제외했고 새 exact 요청으로 업로드를 시작할 수 있습니다."
            : "수정된 현재 값으로 완료했습니다. 직전 요청은 이미 비활성 상태였고 새 exact 요청으로 업로드를 시작할 수 있습니다."
          : contentKind === "cinematic"
            ? "완료했습니다. 이 exact 영상과 metadata로 최초 업로드를 시작할 수 있습니다."
            : "완료했습니다. 영상·한국어 자막을 먼저 일부 공개로 검증한 뒤, 별도 싱크 대기 없이 영어 자막과 제목·설명 현지화를 이어서 진행합니다. 공개 전환은 포함하지 않습니다.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "저장 안 됨: 요청 패키지 준비에 실패했습니다.",
      });
    } finally {
      setPreparingRequest(false);
    }
  }

  // ───── 파생 상태 ─────
  const effectiveVideoName = videoFile?.name ?? preparedProductionVideo?.name;
  const effectiveVideoSize = videoFile?.size ?? preparedProductionVideo?.size;
  const hasVideo = Boolean(videoUrl && effectiveVideoName && effectiveVideoSize);
  const hasSubtitle = koreanCues.length > 0;
  const isShorts = contentKind === "shorts";
  const isNoCaptionCinematic = contentKind === "cinematic";
  const subtitleReadyForRequest = isShorts || isNoCaptionCinematic || hasSubtitle;
  const shortsBriefReady = !isShorts || Boolean(shortsBrief.trim());
  const metadataReadyForRequest = isShorts
    ? shortsBriefReady
    : Boolean(koreanTitle.trim() && koreanDescription.trim());
  const captionSourceReadyForRequest =
    isShorts ||
    Boolean(
      agentProject?.slug &&
        (isNoCaptionCinematic || (contentKind === "longform" && srtFile)),
    );
  const canPrepareUploadRequest = Boolean(
    hasVideo &&
      subtitleReadyForRequest &&
      metadataReadyForRequest &&
      captionSourceReadyForRequest,
  );
  const uploadRequestActionLabel = preparingRequest
    ? uploadRequestResult
      ? "수정 내용 완료 중..."
      : "완료 처리 중..."
    : uploadRequestResult
      ? uploadRequestIsCurrent
        ? "현재 값으로 다시 완료"
        : "수정 내용으로 완료"
      : "완료 · 업로드 시작";
  const previewSubtitleCues: SubtitleCue[] = useMemo(() => {
    return koreanCues;
  }, [koreanCues]);

  const previewSubtitleUrl = useMemo(() => {
    if (!previewSubtitlesOn || previewSubtitleCues.length === 0) return null;
    return cuesToObjectUrl(previewSubtitleCues);
  }, [previewSubtitlesOn, previewSubtitleCues]);

  useEffect(() => {
    return () => {
      if (previewSubtitleUrl) URL.revokeObjectURL(previewSubtitleUrl);
    };
  }, [previewSubtitleUrl]);

  const draftChecks: DraftCheck[] = [
    {
      id: "video",
      label: "영상",
      status: hasVideo ? "ok" : "error",
      detail:
        effectiveVideoName && effectiveVideoSize
          ? `${effectiveVideoName} · ${formatFileSize(effectiveVideoSize)}`
          : "파일 없음",
    },
    {
      id: "subtitle",
      label: "한국어 자막",
      status: isNoCaptionCinematic ? "ok" : hasSubtitle ? "ok" : isShorts ? "warn" : "error",
      detail: isNoCaptionCinematic
        ? "— 수동 자막 없음"
        : hasSubtitle
        ? `${koreanCues.length}줄 준비`
        : isShorts
          ? "숏츠는 선택 사항"
          : "SRT 없음",
    },
    {
      id: "korean-final-approval",
      label: isNoCaptionCinematic ? "자막 정책" : "최종 한국어 자막 승인",
      status:
        isShorts || (isNoCaptionCinematic && Boolean(agentProject?.slug))
          ? "ok"
          : hasSubtitle && Boolean(agentProject?.slug)
            ? "ok"
            : "error",
      detail: isShorts
        ? "숏츠는 생략"
        : isNoCaptionCinematic && agentProject?.slug
          ? "요청 저장 시 수동 자막 없음으로 고정"
        : hasSubtitle && agentProject?.slug
          ? `${koreanCues.length}줄 · 요청 저장 시 최종 KO로 고정`
          : "최종 한국어 SRT와 프로젝트 연결 필요",
    },
    {
      id: "metadata",
      label: isShorts ? "숏츠 메모" : "제목/설명",
      status: isShorts
        ? shortsBrief.trim()
          ? "ok"
          : "error"
        : koreanTitle.trim() && koreanDescription.trim()
          ? "ok"
          : "error",
      detail: isShorts
        ? shortsBrief.trim()
          ? "Codex가 업로드 전 분석"
          : "메모 필요"
        : koreanTitle.trim() && koreanDescription.trim()
          ? `제목 ${koreanTitle.trim().length}자 · 설명 ${koreanDescription.trim().length}자`
          : "제목과 설명 필요",
    },
    {
      id: "translations",
      label: isShorts ? "다국어" : "제목·설명 언어",
      status: isShorts ? "ok" : selectedTargetLanguageCount > 0 ? "ok" : "warn",
      detail:
        isShorts
          ? "숏츠는 생략"
          : selectedTargetLanguageCount > 0
          ? formatLanguagePreview(selectedTargetLanguages.map((language) => language.shortLabel))
          : "선택 없음",
    },
    {
      id: "auth",
      label: "YouTube 연결",
      status: auth?.connected ? "ok" : "warn",
      detail: auth?.connected
        ? auth.channelTitle ?? "연결됨"
        : "Codex가 실제 업로드할 때 확인",
    },
    {
      id: "thumbnail",
      label: "썸네일",
      status: thumbnailFile ? "ok" : "warn",
      detail: thumbnailFile ? thumbnailFile.name : "선택 사항",
    },
  ];
  const isDraftPreparationStage = Boolean(
    !isNoCaptionCinematic &&
      agentProject &&
      (agentProject.stage.includes("draft") ||
        (agentProject.metadata && agentProject.files.koreanUpload.status !== "ready")),
  );

  // ───── 렌더 ─────
  return (
    <main className="deno-upload-desk min-h-screen px-3 py-3 text-slate-950 sm:px-5 sm:py-5">
      <div className="mx-auto min-w-0 max-w-[1500px] space-y-4">
        <header className="upload-desk-header">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div className="upload-desk-mark" aria-hidden="true">D</div>
            <div className="min-w-0">
              <p className="upload-desk-kicker">DENO CREATOR OPERATIONS</p>
              <h1 className="mt-1 break-words text-xl font-semibold leading-tight [overflow-wrap:anywhere] [word-break:normal]">
                {isShorts
                  ? "숏츠 업로드 데스크"
                  : isNoCaptionCinematic
                    ? "시네마틱 업로드 데스크"
                    : "유튜브 업로드 데스크"}
              </h1>
              <p className="mt-1 text-sm leading-6">
                {isShorts
                  ? "영상과 메모를 확정하고 현재 상태를 요청 패키지로 잠급니다."
                  : isNoCaptionCinematic
                    ? "수동 자막 없이 영상, 제목·설명, 현지화 범위와 업로드 옵션을 확정합니다. 음성 언어는 실제 대사에 맞춰 선택하세요."
                    : "한 화면에서 파일, 최종 메타데이터, 현지화 범위와 출고 옵션을 확정합니다."}
              </p>
            </div>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 md:w-auto md:justify-end">
            <div className="upload-desk-channel-switch" role="group" aria-label="업로드 채널">
              {(uploadChannels.length > 0
                ? uploadChannels
                : auth?.uploadChannel
                  ? [auth.uploadChannel]
                  : []
              ).map((channel) => {
                const selected = channel.id === (auth?.uploadChannel?.id ?? auth?.activeChannelId);
                const hasToken = channel.tokenPersistence?.hasToken ?? (selected && auth?.connected);
                return (
                  <button
                    key={channel.id}
                    type="button"
                    disabled={channelSwitching || selected}
                    aria-pressed={selected}
                    title={`${channel.title} (${channel.handle})${hasToken ? "" : " · 아직 연결 안 됨"}`}
                    onClick={() => void switchUploadChannel(channel.id)}
                    className="upload-desk-channel-button"
                    data-selected={selected}
                  >
                    <span
                      aria-hidden="true"
                      className={classNames(
                        "h-2 w-2 rounded-full",
                        hasToken ? "bg-emerald-400" : "bg-amber-400",
                      )}
                    />
                    {channel.title}
                  </button>
                );
              })}
            </div>
            <span
              className={classNames(
                "inline-flex h-9 shrink-0 items-center rounded-full px-3 text-xs font-semibold",
                auth?.connected
                  ? "bg-emerald-100 text-emerald-900"
                  : "bg-amber-100 text-amber-900",
              )}
              title={auth?.error}
            >
              {auth?.connected
                ? `연결됨 · ${auth.channelTitle ?? ""}`
                : `${auth?.uploadChannel?.title ?? "YouTube"} 미연결`}
            </span>
            {videoFile || preparedProductionVideo || koreanCues.length > 0 || uploadRequestResult ? (
              <button
                type="button"
                onClick={() => {
                  if (confirm("현재 작업(영상·자막·제목·설명·번역 결과)을 모두 비우고 새로 시작합니다. 진행하시겠습니까?")) {
                    resetWorkspace();
                    setUploadRequestResult(null);
                    setNotice({ tone: "neutral", text: "새 업로드 작업을 시작합니다." });
                  }
                }}
                className="inline-flex h-10 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-900 hover:bg-slate-50"
              >
                새 업로드 시작
              </button>
            ) : null}
            <Link
              href="/captions"
              className="inline-flex h-10 shrink-0 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 px-4 text-sm font-semibold text-emerald-900 hover:bg-emerald-100"
            >
              기존 영상 자막 관리
            </Link>
            <button
              type="button"
              onClick={() => void refreshAgentProjects()}
              disabled={agentLoading}
              className="inline-flex h-10 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-900 hover:bg-slate-50"
            >
              {agentLoading ? "확인 중" : "새로고침"}
            </button>
            <Link
              href="/settings"
              className="inline-flex h-10 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-900 hover:bg-slate-50"
            >
              설정
            </Link>
          </div>
          </div>

          <div className="upload-desk-routebar">
          <ContentKindSelector value={contentKind} onChange={setContentKind} />

          {isShorts ? (
            <div className="mt-4 grid grid-cols-3 gap-2">
              <FlowStep
                label="1"
                text="파일"
                active={!hasVideo || !shortsBriefReady}
                done={hasVideo && shortsBriefReady}
              />
              <FlowStep
                label="2"
                text="옵션"
                active={hasVideo && shortsBriefReady}
                done={hasVideo && shortsBriefReady}
              />
              <FlowStep
                label="3"
                text="요청"
                active={canPrepareUploadRequest}
                done={uploadRequestIsCurrent}
              />
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-4 gap-2">
              <FlowStep
                label="1"
                text="파일"
                active={!hasVideo || !subtitleReadyForRequest}
                done={hasVideo && subtitleReadyForRequest}
              />
              <FlowStep
                label="2"
                text="정보"
                active={hasVideo && subtitleReadyForRequest && (!koreanTitle.trim() || !koreanDescription.trim())}
                done={Boolean(koreanTitle.trim() && koreanDescription.trim())}
              />
              <FlowStep
                label="3"
                text="언어"
                active={Boolean(koreanTitle.trim() && koreanDescription.trim())}
                done={selectedTargetLanguageCount > 0}
              />
              <FlowStep
                label="4"
                text="요청"
                active={canPrepareUploadRequest}
                done={uploadRequestIsCurrent}
              />
            </div>
          )}
          </div>
        </header>

        {notice ? <NoticeBanner notice={notice} /> : null}

        <div className="upload-desk-content">
          <div className="upload-desk-editor">

        {isDraftPreparationStage ? (
          <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-950">
              지금은 초안 검수 단계입니다
            </p>
            <p className="mt-2 text-sm leading-6 text-amber-900">
              수정된 말자막을 프리미어에서 확인하는 동안, 제목·설명·태그 후보는
              먼저 채워둔 상태입니다. final 영상과 final 한국어 SRT는 검수 후
              아래 파일 영역에 넣으면 됩니다.
            </p>
          </section>
        ) : null}

        {/* 영상 + 자막 + 썸네일 입력 */}
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <SectionTitle
            step="1"
            title="내가 넣는 파일"
            hint={
              isShorts
                ? "영상은 필수이고, SRT는 있으면 넣습니다."
                : isNoCaptionCinematic
                  ? "최종 영상만 넣습니다. 수동 자막은 만들거나 업로드하지 않습니다."
                  : "영상과 final 한국어 SRT가 필수입니다."
            }
          />
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <DropCard
              title="영상"
              description="최종 렌더본"
              accept="video/*"
              inputRef={videoInputRef}
              onChange={handleVideoInputChange}
              onDrop={handleVideoDrop}
              filename={effectiveVideoName}
              filesize={
                effectiveVideoSize ? formatFileSize(effectiveVideoSize) : undefined
              }
            />
            <DropCard
              title="한국어 SRT"
              description={
                isShorts
                  ? "있으면 선택"
                  : isNoCaptionCinematic
                    ? "사용하지 않음"
                    : "프리미어 검수 완료본"
              }
              accept=".srt"
              inputRef={srtInputRef}
              onChange={handleSrtInputChange}
              onDrop={handleSrtDrop}
              filename={srtFile?.name}
              filesize={
                srtFile
                  ? `${formatFileSize(srtFile.size)} · ${koreanCues.length}줄`
                  : undefined
              }
            />
            <div
              className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 transition hover:border-emerald-400 hover:bg-white"
              onDrop={handleThumbnailDrop}
              onDragOver={(event) => event.preventDefault()}
            >
              <p className="text-sm font-semibold text-slate-900">썸네일</p>
              <p className="mt-1 text-xs leading-5 text-slate-600">
                {campaignBrandApprovalRequired ? "브랜드 최종 검토 필수" : "선택 사항"}
              </p>
              <input
                ref={thumbnailInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={handleThumbnailInputChange}
              />
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => thumbnailInputRef.current?.click()}
                  className="inline-flex h-9 items-center justify-center rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-900 hover:bg-slate-50"
                >
                  {thumbnailFile ? "바꾸기" : "파일 선택"}
                </button>
                {thumbnailFile ? (
                  <button
                    type="button"
                    onClick={() => setThumbnail(null)}
                    className="text-xs text-rose-700 hover:text-rose-900"
                  >
                    제거
                  </button>
                ) : (
                  <p className="text-xs text-slate-500">끌어다 놓기 가능</p>
                )}
              </div>
              {thumbnailUrl ? (
                <div className="mt-4 overflow-hidden rounded-md border border-slate-200">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={thumbnailUrl}
                    alt="썸네일 미리보기"
                    className="aspect-video w-full object-cover"
                  />
                </div>
              ) : null}
              {thumbnailFile ? (
                <p className="mt-2 truncate text-xs text-slate-500">
                  {thumbnailFile.name} · {formatFileSize(thumbnailFile.size)}
                </p>
              ) : null}
            </div>
          </div>
          {isShorts ? (
            <label className="mt-4 block rounded-lg border border-emerald-200 bg-emerald-50 p-4">
              <span className="text-sm font-semibold text-emerald-950">숏츠 영상 메모</span>
              <span className="mt-1 block text-xs leading-5 text-emerald-800">
                Codex가 업로드 직전에 프레임과 오디오를 볼 때 같이 참고할 기준입니다. 주제, 훅, 시청자가 얻는 보상만 짧게 적으면 됩니다.
              </span>
              <textarea
                value={shortsBrief}
                onChange={(event) => setShortsBrief(event.target.value)}
                rows={3}
                className="mt-3 w-full rounded-md border border-emerald-200 bg-white px-4 py-3 text-sm leading-6 text-slate-900"
                placeholder="예: ComfyUI 초보자에게 Codex와 Claude Code로 PC 작업을 맡기는 흐름을 30초 안에 보여주는 숏츠"
              />
            </label>
          ) : null}
        </section>

        {isShorts ? (
          <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <SectionTitle
              step="2"
              title="숏츠 자동 메타데이터"
              hint="추천 후보를 고르는 단계 없이, Codex가 업로드 직전에 분석해서 채웁니다."
            />
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-sm font-semibold text-emerald-950">
                저장 후 Codex가 확인할 것
              </p>
              <div className="mt-3 grid gap-2 text-sm leading-6 text-emerald-900 sm:grid-cols-3">
                <div className="rounded-md bg-white px-3 py-2">메모</div>
                <div className="rounded-md bg-white px-3 py-2">대표 프레임</div>
                <div className="rounded-md bg-white px-3 py-2">오디오 흐름</div>
              </div>
              <p className="mt-3 text-xs leading-5 text-emerald-800">
                제목, 설명, 태그는 요청 패키지에 비워둘 수 있습니다. 실제 업로드 전 Codex가 짧은 숏츠용 문구로 채운 뒤 진행합니다.
              </p>
            </div>
          </section>
        ) : (
          <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <SectionTitle step="2" title="에이전트가 준비한 제목과 설명" />
              </div>
              <span className="inline-flex min-h-9 items-center rounded-full bg-slate-100 px-3 text-xs font-semibold text-slate-700">
                {metadataMode === "saved"
                  ? "준비된 정보 적용됨"
                  : metadataMode === "agent"
                    ? "에이전트 후보 적용됨"
                    : "직접 수정 중"}
              </span>
            </div>

            <details className="mt-4 border-y border-slate-200 py-3">
              <summary className="cursor-pointer text-sm font-semibold text-slate-800">
                추천 후보와 준비값 보기
                <span className="ml-2 text-xs font-normal text-slate-500">
                  현재 입력값은 열지 않아도 유지됩니다
                </span>
              </summary>
              <MetadataSuggestionPanel
                agentMetadata={agentProject?.metadata}
                preparedAt={agentProject?.updatedAt}
                currentTitle={koreanTitle}
                currentDescription={koreanDescription}
                onUseTitle={applySuggestedTitle}
                onUseDescription={applySuggestedDescription}
                onUseChapters={applySuggestedChapters}
                onUseTags={applySuggestedTags}
                onUseAgentMetadata={() => {
                  const applied = applyAgentMetadata(agentProject?.metadata, "force");
                  setNotice({
                    tone: applied ? "success" : "neutral",
                    text: applied
                      ? "준비된 정보를 현재 입력칸에 다시 넣었습니다."
                      : "불러올 준비 정보가 아직 없습니다.",
                  });
                }}
              />
            </details>

            <div className="mt-4 space-y-4">
              <label className="block">
                <span className="text-sm font-medium text-slate-900">제목</span>
                <input
                  ref={titleInputRef}
                  value={koreanTitle}
                  onChange={(event) => {
                    markManualMetadataEdit();
                    setKoreanTitle(event.target.value);
                  }}
                  className="mt-2 w-full rounded-md border border-slate-300 bg-white px-4 py-3 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                  placeholder="영상 제목"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-slate-900">설명</span>
                <textarea
                  value={koreanDescription}
                  onChange={(event) => {
                    markManualMetadataEdit();
                    setKoreanDescription(event.target.value);
                  }}
                  rows={5}
                  className="mt-2 w-full rounded-md border border-slate-300 bg-white px-4 py-3 text-sm leading-6 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                  placeholder="영상 설명. 핵심 요약 + 챕터 + 해시태그."
                />
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  {!channelLinkPolicy.discord && !channelLinkPolicy.comfyReferral
                    ? `${auth?.uploadChannel?.title ?? "이 채널"} 설명에는 강의 채널 링크(ComfyUI 추천·Deno Discord)를 넣지 않습니다. 요청 저장 시 있으면 걷어냅니다.`
                    : campaignNoAffiliateLinks
                      ? "이번 캠페인은 제휴 링크를 제외하고 Deno Discord 채널만 자동으로 유지합니다."
                      : "ComfyUI 공식 홈페이지 Deno 추천 링크와 Deno Discord 채널은 요청 저장 시 자동으로 포함됩니다."}
                </p>
              </label>
              <div className="block">
                <span className="text-sm font-medium text-slate-900">
                  태그 (YouTube 세부정보 &gt; 더보기 태그 칸)
                </span>
                <TagChipEditor
                  tags={currentTags}
                  draft={tagDraft}
                  onDraftChange={setTagDraft}
                  onCommit={commitKoreanTagDraft}
                  onRemove={removeKoreanTag}
                  onClear={clearKoreanTags}
                />
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  쉼표나 Enter로 추가합니다. 모델명, 노드명, 자주 틀릴 수 있는 표기만 넣고 설명란에는 길게 붙이지 않습니다.
                </p>
              </div>
            </div>
          </section>
        )}

        {!isShorts ? (
          <AgentWorkspacePanel
            project={agentProject}
            loading={agentLoading}
            error={agentWorkspaceError}
            captionRequired={!isNoCaptionCinematic}
          />
        ) : null}

        <UploadOptionsCard
          categoryId={categoryId}
          setCategoryId={setCategoryId}
          defaultAudioLanguage={defaultAudioLanguage}
          setDefaultAudioLanguage={setDefaultAudioLanguage}
          playlistId={playlistId}
          setPlaylistId={setPlaylistId}
          publishAt={publishAt}
          setPublishAt={setPublishAt}
          recordingDate={recordingDate}
          setRecordingDate={setRecordingDate}
          madeForKids={madeForKids}
          setMadeForKids={setMadeForKids}
          containsSyntheticMedia={containsSyntheticMedia}
          setContainsSyntheticMedia={setContainsSyntheticMedia}
          embeddable={embeddable}
          setEmbeddable={setEmbeddable}
          publicStatsViewable={publicStatsViewable}
          setPublicStatsViewable={setPublicStatsViewable}
          notifySubscribers={notifySubscribers}
          setNotifySubscribers={setNotifySubscribers}
          license={license}
          setLicense={setLicense}
          channelPlaylists={channelPlaylists}
          channelCategories={channelCategories}
          channelLanguages={channelLanguages}
          authConnected={authConnected}
        />

        <details className="rounded-lg border border-slate-200 bg-white px-5 py-4 shadow-sm">
          <summary className="cursor-pointer text-base font-semibold text-slate-950">
            프리셋·채널 정보
            <span className="ml-2 text-xs font-normal text-slate-500">
              필요할 때만 열기
            </span>
          </summary>
          <div className="mt-5 space-y-4">
            <ChannelProfileCard
              profile={channelProfile}
              onChange={setChannelProfile}
              onSave={() => saveChannelProfileNow(channelProfile)}
              saving={channelProfileSaving}
            />

            <PresetCard
              presets={presets}
              activePresetId={activePresetId}
              onApply={handleApplyPreset}
              onSave={handleSavePreset}
              onDelete={handleDeletePreset}
              currentDraftSnapshot={buildDraftSnapshot}
            />

          </div>
        </details>

        {/* 미리보기 */}
        {hasVideo ? (
          <details className="rounded-lg border border-slate-200 bg-white px-5 py-4 shadow-sm">
            <summary className="cursor-pointer text-base font-semibold">영상·자막 미리보기</summary>
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
              {hasSubtitle ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={previewSubtitlesOn}
                    onChange={(event) => setPreviewSubtitlesOn(event.target.checked)}
                    className="h-4 w-4 accent-emerald-600"
                  />
                  자막 표시
                </label>
              ) : null}
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                {hasSubtitle ? "한국어 자막 미리보기" : "자막 없이 미리보기"}
              </span>
            </div>
            <div className="mt-4 overflow-hidden rounded-md border border-slate-900 bg-black">
              <video
                ref={videoRef}
                src={videoUrl ?? undefined}
                controls
                className="aspect-video w-full bg-black object-contain"
                crossOrigin="anonymous"
                key={previewSubtitleUrl ?? "no-track"}
              >
                {previewSubtitleUrl ? (
                  <track
                    default
                    kind="subtitles"
                    src={previewSubtitleUrl}
                    srcLang="ko"
                    label="한국어"
                  />
                ) : null}
              </video>
            </div>
          </details>
        ) : null}

          </div>

          <aside className="upload-desk-inspector">
        {/* 사용자 완료 및 Codex 업로드 요청 */}
        <section className="upload-desk-request-panel rounded-lg border border-slate-900 bg-slate-950 p-5 text-white shadow-lg">
          <div className="flex flex-col gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">최종 확인 및 완료</h2>
              <p className="mt-1 text-xs leading-5 text-slate-300">
                {isNoCaptionCinematic
                  ? "제목·설명을 최종 확인한 뒤 누르세요. 영상을 일부 공개로 업로드하고, 선택된 언어의 제목·설명을 현지화합니다. 수동 자막 생성과 공개 전환은 포함하지 않습니다."
                  : "제목·설명을 최종 확인한 뒤 누르세요. 롱폼은 영상·한국어 자막을 먼저 일부 공개로 검증하고, 이어서 영어 자막과 제목·설명 현지화를 분할 실행합니다. 공개 전환은 포함하지 않습니다."}
              </p>
            </div>
            {campaignBrandApprovalRequired ? (
              <div className="rounded-md border border-amber-300/40 bg-amber-300/10 px-4 py-3 text-sm text-amber-50">
                <span>
                  <span className="block font-semibold">브랜드 승인 전에는 공개 전환 금지</span>
                  <span className="mt-1 block text-xs leading-5 text-amber-100/80">
                    일부 공개 영상과 한국어 자막을 먼저 올려 검토할 수 있습니다. 제목·설명·썸네일·고정 댓글을 브랜드 담당자에게 보내 승인받은 뒤에만 공개로 전환하세요.
                  </span>
                </span>
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => void prepareUploadRequest()}
              disabled={preparingRequest || !canPrepareUploadRequest}
              data-testid="save-upload-request"
              data-request-state={
                preparingRequest
                  ? "saving"
                  : uploadRequestResult
                    ? uploadRequestIsCurrent
                      ? "saved-current"
                      : "saved-stale"
                    : "not-saved"
              }
              className="inline-flex min-h-11 w-full items-center justify-center rounded-md bg-emerald-400 px-5 text-sm font-semibold text-slate-950 hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {uploadRequestActionLabel}
            </button>
          </div>
          {!auth?.connected ? (
            <p className="mt-3 text-xs text-slate-300">
              YouTube 연결이 없으면 완료 뒤 최초 업로드를 시작하기 전에 한 번 연결해야 합니다.{" "}
              <Link href="/settings" className="font-semibold text-white underline">
                설정
              </Link>
              에서 미리 연결해두면 Codex 업로드가 더 빠릅니다.
            </p>
          ) : null}

          {uploadRequestResult ? (
            <div
              className={classNames(
                "mt-4 rounded-lg border p-4 text-sm leading-6",
                uploadRequestIsCurrent
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : "border-amber-200 bg-amber-50 text-amber-950",
              )}
            >
              <p className="font-semibold">
                {uploadRequestIsCurrent
                  ? "현재 입력값으로 완료 · 분할 업로드 승인됨"
                  : "이전 요청 패키지는 현재 입력값과 다릅니다"}
              </p>
              <p className="mt-1">요청 ID: {uploadRequestResult.requestId}</p>
              {uploadRequestResult.supersedesRequestId ? (
                <p className="mt-1 text-xs">
                  직전 요청 {uploadRequestResult.supersedesRequestId} · {uploadRequestResult.previousRequestSuperseded ? "실행 대상 제외 완료" : "이미 비활성"}
                </p>
              ) : null}
              {uploadRequestResult.capturedMetadata ? (
                <p className="mt-2 text-xs leading-5">
                  저장된 값: 제목 {uploadRequestResult.capturedMetadata.title.length}자 · 설명{" "}
                  {uploadRequestResult.capturedMetadata.descriptionLength}자 · 태그{" "}
                  {uploadRequestResult.capturedMetadata.tagCount}개 · 공개 설정{" "}
                  {uploadRequestResult.capturedMetadata.privacyStatus}
                </p>
              ) : null}
              <p
                className={classNames(
                  "mt-2 text-xs leading-5",
                  uploadRequestIsCurrent ? "text-emerald-800" : "text-amber-900",
                )}
              >
                {uploadRequestIsCurrent
                  ? "이 버튼으로 exact 분할 업로드 승인은 완료됐습니다. 먼저 한국어 우선 업로드를 검증한 뒤 별도 싱크 대기 없이 영어 자막과 제목·설명 현지화를 이어갑니다. 작업이 닫혀 있으면 채팅에 ‘완료’라고 보내 재개만 시켜주세요."
                  : "제목, 설명, 태그, 파일, 언어, 공개 설정 중 하나가 바뀌었습니다. 지금 보이는 값으로 다시 완료해야 최신 값이 업로드 승인이 됩니다."}
              </p>
              <details className="mt-2 border-t border-current/15 pt-2 text-xs">
                <summary className="cursor-pointer font-semibold">저장 경로 보기</summary>
                <p className="mt-2 break-all">요청 폴더: {uploadRequestResult.requestDir}</p>
                <p className="mt-1 break-all">Codex 입력 파일: {uploadRequestResult.manifestPath}</p>
                {uploadRequestResult.readyMarkerPath ? (
                  <p className="mt-1 break-all">확인 파일: {uploadRequestResult.readyMarkerPath}</p>
                ) : null}
              </details>
            </div>
          ) : null}
        </section>

        {/* 요청 패키지 요약 + 공개 설정 */}
        <section className="upload-desk-summary-panel rounded-lg border border-slate-300 bg-white p-5 shadow-sm">
          <SectionTitle step="4" title="요청 전 확인" hint="Codex가 읽을 입력값만 마지막으로 봅니다." />
          <div className="mt-4 grid gap-y-1">
            <SummaryItem
              label="영상 유형"
              value={isShorts ? "숏츠" : isNoCaptionCinematic ? "자막 없는 영상" : "롱폼"}
            />
            <SummaryItem
              label="영상"
              value={effectiveVideoName ? `✓ ${effectiveVideoName}` : "✗ 없음"}
            />
            <SummaryItem
              label="자막 (한국어)"
              value={
                isNoCaptionCinematic
                  ? "— 수동 자막 없음"
                  : koreanCues.length > 0
                  ? `✓ ${koreanCues.length}줄`
                  : isShorts
                    ? "— 숏츠라 생략"
                    : "✗ 없음"
              }
            />
            {isShorts ? (
              <SummaryItem
                label="숏츠 메모"
                value={shortsBrief.trim() ? "✓ 작성됨" : "— 없음"}
              />
            ) : null}
            <SummaryItem
              label="썸네일"
              value={thumbnailFile ? `✓ ${thumbnailFile.name}` : "— 선택 안 함"}
            />
            <SummaryItem
              label={isShorts ? "다국어" : "제목·설명 언어"}
              value={
                isShorts
                  ? "숏츠는 생략"
                  : selectedTargetLanguageCount > 0
                    ? `${selectedTargetLanguageCount}개 선택 · ${formatLanguagePreview(
                        selectedTargetLanguages.map((language) => language.shortLabel),
                      )}`
                    : "선택 없음"
              }
            />
            <SummaryItem
              label="제목 (한국어)"
              value={
                koreanTitle
                  ? `✓ ${koreanTitle.length}자`
                  : isShorts
                    ? "Codex가 업로드 전 작성"
                    : "✗ 비어 있음"
              }
            />
            <SummaryItem
              label="설명 (한국어)"
              value={
                koreanDescription
                  ? `✓ ${koreanDescription.length}자`
                  : isShorts
                    ? "Codex가 업로드 전 작성"
                    : "✗ 비어 있음"
              }
            />
            <SummaryItem
              label="태그"
              value={isShorts ? "— 숏츠라 생략" : `${requestTags.length}개`}
            />
          </div>

          <details className="mt-4 border-t border-slate-200 pt-3">
            <summary className="cursor-pointer text-sm font-semibold text-slate-900">
              Codex 적용 옵션 요약
              <span className="ml-2 text-xs font-normal text-slate-500">
                기본값이면 열지 않아도 됩니다
              </span>
            </summary>
            <div className="mt-3 grid gap-1">
              <SummaryItem
                label="카테고리"
                value={
                  channelCategories.find((c) => c.id === categoryId)?.title
                    ? `${channelCategories.find((c) => c.id === categoryId)?.title} (${categoryId})`
                    : categoryId
                      ? `ID ${categoryId}`
                      : "✗ 미설정"
                }
              />
              <SummaryItem
                label="재생목록"
                value={
                  playlistId
                    ? channelPlaylists.find((p) => p.id === playlistId)?.title ??
                      `ID ${playlistId}`
                    : "— 추가 안 함"
                }
              />
              <SummaryItem
                label="음성 언어"
                value={defaultAudioLanguage || "— 미설정"}
              />
              <SummaryItem
                label="예약 공개"
                value={
                  publishAt
                    ? `${new Date(publishAt).toLocaleString("ko-KR")} (자동 공개 시 비공개 강제)`
                    : "— 예약 없음"
                }
              />
              <SummaryItem
                label="구독자 알림"
                value={notifySubscribers ? "✓ 보냄" : "— 안 보냄"}
              />
              <SummaryItem
                label="AI 콘텐츠 표시"
                value={containsSyntheticMedia ? "✓ 표시함" : "— 표시 안 함"}
              />
              <SummaryItem
                label="아동용 콘텐츠"
                value={madeForKids ? "✓ 아동용" : "— 아동용 아님"}
              />
              <SummaryItem
                label="외부 임베드"
                value={embeddable ? "✓ 허용" : "— 허용 안 함"}
              />
              <SummaryItem
                label="조회수·좋아요 공개"
                value={publicStatsViewable ? "✓ 공개" : "— 비공개"}
              />
              <SummaryItem
                label="라이선스"
                value={license === "youtube" ? "표준 YouTube 라이선스" : "크리에이티브 커먼즈"}
              />
              <SummaryItem
                label="촬영일"
                value={recordingDate || "— 미설정"}
              />
              <SummaryItem label="댓글" value="켬 · 검토 없음" />
              <SummaryItem label="댓글 사용자·정렬" value="모든 사용자 · 최신순" />
            </div>
          </details>

          <div className="mt-6">
            <p className="text-sm font-semibold text-slate-900">공개 설정</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(["private", "unlisted", "public"] as PrivacyStatus[]).map((status) => (
                <label
                  key={status}
                  className={classNames(
                    "flex cursor-pointer items-center gap-2 rounded-md border px-4 py-2 text-sm transition",
                    privacyStatus === status
                      ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-100",
                  )}
                >
                  <input
                    type="radio"
                    name="privacyStatus"
                    checked={privacyStatus === status}
                    onChange={() => setPrivacyStatus(status)}
                    className="h-4 w-4 accent-emerald-600"
                  />
                  {status === "private" ? "비공개" : status === "unlisted" ? "일부 공개" : "공개"}
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Codex가 실제 업로드할 때 적용할 공개 설정입니다. Helper 롱폼·cinematic의 기본은 일부 공개입니다.
            </p>
          </div>
        </section>

        <details className="upload-desk-recovery-panel rounded-lg border border-slate-200 bg-white px-5 py-4 shadow-sm">
          <summary className="cursor-pointer text-base font-semibold text-slate-950">
            업로드 기록 / 문제 해결
            <span className="ml-2 text-xs font-normal text-slate-500">
              필요할 때만 열기
            </span>
          </summary>
          <div className="mt-5">
            <OperationsPanel
              draftChecks={draftChecks}
              preflight={preflight}
              runs={runs}
              loading={opsLoading}
              retryingRunId={retryingRunId}
              onRefresh={() => void refreshOperationsStatus()}
              onRetry={(runId) => void retryRunAttachments(runId)}
            />
          </div>
        </details>

          </aside>
        </div>
      </div>
    </main>
  );
}

function ContentKindSelector({
  value,
  onChange,
}: {
  value: ContentKind;
  onChange: (value: ContentKind) => void;
}) {
  const options: Array<{ value: ContentKind; label: string }> = [
    { value: "longform", label: "롱폼" },
    { value: "cinematic", label: "자막 없는 영상" },
    { value: "shorts", label: "숏츠" },
  ];

  return (
    <div className="upload-desk-mode-switch" role="group" aria-label="영상 유형">
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className="upload-desk-mode-button"
            data-selected={selected}
            aria-pressed={selected}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function FlowStep({
  label,
  text,
  active,
  done,
}: {
  label: string;
  text: string;
  active: boolean;
  done: boolean;
}) {
  return (
    <div
      className="upload-desk-step"
      data-state={done ? "done" : active ? "active" : "idle"}
    >
      <span
        className="upload-desk-step-index"
      >
        {done ? "✓" : label}
      </span>
      <span className="font-semibold">{text}</span>
    </div>
  );
}

function SectionTitle({
  step,
  title,
  hint,
}: {
  step: string;
  title: string;
  hint?: string;
}) {
  return (
    <div className="upload-desk-section-title">
      <span className="upload-desk-section-index">
        {step}
      </span>
      <div className="min-w-0">
        <h2 className="text-lg font-semibold text-slate-950">
          {title}
        </h2>
        {hint ? <p className="mt-1 text-sm leading-6 text-slate-600">{hint}</p> : null}
      </div>
    </div>
  );
}

function TagChipEditor({
  tags,
  draft,
  onDraftChange,
  onCommit,
  onRemove,
  onClear,
}: {
  tags: string[];
  draft: string;
  onDraftChange: (value: string) => void;
  onCommit: (raw?: string) => void;
  onRemove: (tag: string) => void;
  onClear: () => void;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      onCommit();
      return;
    }

    if (event.key === "Backspace" && draft.length === 0 && tags.length > 0) {
      event.preventDefault();
      onRemove(tags[tags.length - 1]);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");
    if (parseTagText(text).length <= 1) return;
    event.preventDefault();
    onCommit(text);
  }

  return (
    <div className="mt-2 rounded-md border border-slate-300 bg-white px-3 py-2">
      <div className="flex min-h-11 flex-wrap items-center gap-2">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex max-w-full items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-800"
          >
            <span className="max-w-[220px] truncate">{tag}</span>
            <button
              type="button"
              onClick={() => onRemove(tag)}
              className="inline-flex size-4 items-center justify-center rounded-full text-slate-400 hover:bg-slate-200 hover:text-slate-900"
              aria-label={`${tag} 태그 제거`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => onCommit()}
          className="min-w-[180px] flex-1 border-0 bg-transparent px-1 py-2 text-sm outline-none placeholder:text-slate-400"
          placeholder={
            tags.length > 0
              ? "태그 입력 후 Enter"
              : "태그 입력 후 Enter 또는 쉼표"
          }
        />
      </div>
      {tags.length > 0 ? (
        <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2 text-xs text-slate-500">
          <span>{tags.length}개 태그</span>
          <button
            type="button"
            onClick={onClear}
            className="font-semibold text-slate-500 hover:text-slate-900"
          >
            전체 비우기
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MetadataSuggestionPanel({
  agentMetadata,
  preparedAt,
  currentTitle,
  currentDescription,
  onUseTitle,
  onUseDescription,
  onUseChapters,
  onUseTags,
  onUseAgentMetadata,
}: {
  agentMetadata?: AgentUploadMetadata | null;
  preparedAt?: string;
  currentTitle: string;
  currentDescription: string;
  onUseTitle: (value: string) => void;
  onUseDescription: (value: string) => void;
  onUseChapters: (value: string) => void;
  onUseTags: (tags: string[]) => void;
  onUseAgentMetadata: () => void;
}) {
  const titleCandidates = agentMetadata?.titleCandidates?.slice(0, 3) ?? [];
  const descriptionCandidates =
    agentMetadata?.descriptionCandidates
      ?.slice(0, 3)
      .map((candidate) =>
        agentMetadata.allowSubtitleGuide
          ? candidate
          : stripInferredSubtitleGuide(candidate),
      )
      .filter(Boolean) ?? [];
  const chapterCandidates = agentMetadata?.chapterCandidates?.slice(0, 3) ?? [];
  const tags = agentMetadata?.tags ?? [];
  const campaign = agentMetadata?.campaign;
  const hasCandidates =
    Boolean(campaign) ||
    titleCandidates.length > 0 ||
    descriptionCandidates.length > 0 ||
    chapterCandidates.length > 0 ||
    tags.length > 0;
  const hasAgentMetadata = Boolean(
    agentMetadata?.title || agentMetadata?.description || agentMetadata?.tags.length,
  );
  const normalizedCurrentTitle = currentTitle.trim();
  const normalizedCurrentDescription = currentDescription.trim();
  const normalizedCurrentBody = descriptionBodyOnly(currentDescription);
  const preparedLabel = formatPreparedAt(preparedAt);

  return (
    <div className="pt-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <p className="mt-1 text-sm font-semibold text-slate-950">에이전트 후보 선택</p>
          {hasCandidates ? (
            <p className="mt-1 text-xs font-semibold text-emerald-700">
              에이전트 후보 준비됨{preparedLabel ? ` · ${preparedLabel}` : ""}
            </p>
          ) : (
            <p className="mt-1 text-xs leading-5 text-slate-500">
              아직 이 작업판에 저장된 후보가 없습니다. Codex가 초안 자막을 처리하면 여기에 들어옵니다.
            </p>
          )}
        </div>
        <div className="flex w-full flex-wrap gap-2 lg:w-auto lg:justify-end">
          <button
            type="button"
            onClick={onUseAgentMetadata}
            disabled={!hasAgentMetadata}
            className="inline-flex h-10 shrink-0 items-center justify-center rounded-full border border-emerald-200 bg-white px-4 text-xs font-semibold text-emerald-900 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            준비된 정보 적용
          </button>
        </div>
      </div>

      {hasCandidates ? (
        <div className="mt-4 space-y-4">
          {campaign ? (
            <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-amber-950">캠페인 필수 확인</p>
                  <p className="mt-1 text-xs leading-5 text-amber-800">
                    {campaign.name ?? "현재 캠페인"}의 설명란·고정 댓글·제출 전 확인 항목입니다.
                  </p>
                </div>
                {campaign.submissionDeadline ? (
                  <span className="rounded-full border border-amber-300 bg-white px-3 py-1 text-xs font-semibold text-amber-900">
                    제출 마감 {campaign.submissionDeadline}
                  </span>
                ) : null}
              </div>

              {campaign.descriptionChecklist.length > 0 ? (
                <div className="mt-4 rounded-xl border border-amber-200 bg-white p-3">
                  <p className="text-xs font-semibold text-amber-950">설명란 필수 항목</p>
                  <ul className="mt-2 space-y-1 text-xs leading-5 text-slate-700">
                    {campaign.descriptionChecklist.map((item) => (
                      <li key={item}>• {item}</li>
                    ))}
                  </ul>
                  {campaign.trackingLink ? (
                    <p className="mt-3 break-all rounded-lg bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-800">
                      {campaign.trackingLink}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {campaign.pinnedCommentDraft ? (
                <div className="mt-3 rounded-xl border border-amber-200 bg-white p-3">
                  <p className="text-xs font-semibold text-amber-950">
                    고정 댓글 초안 · 업로드 후 수동 게시 및 고정
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-slate-700">
                    {campaign.pinnedCommentDraft}
                  </p>
                </div>
              ) : null}

              {campaign.manualChecklist.length > 0 ? (
                <div className="mt-3">
                  <p className="text-xs font-semibold text-amber-950">게시·제출 전 수동 확인</p>
                  <ul className="mt-2 grid gap-1 text-xs leading-5 text-amber-900 lg:grid-cols-2">
                    {campaign.manualChecklist.map((item) => (
                      <li key={item}>□ {item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ) : null}

          {titleCandidates.length > 0 ? (
          <div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-slate-950">제목 추천 3종</p>
              <span className="text-xs text-slate-500">원하는 제목만 적용</span>
            </div>
            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              {titleCandidates.map((title, index) => {
                const selected = normalizedCurrentTitle === title.trim();
                return (
                <button
                  key={`${title}-${index}`}
                  type="button"
                  onClick={() => onUseTitle(title)}
                  className={classNames(
                    "flex min-h-32 flex-col justify-between rounded-2xl border p-4 text-left transition",
                    selected
                      ? "border-emerald-300 bg-emerald-50 shadow-sm"
                      : "border-slate-200 bg-white hover:border-slate-400 hover:bg-slate-50",
                  )}
                >
                  <span>
                    <span className="text-xs font-semibold text-slate-500">
                      후보 {index + 1}
                    </span>
                    <span className="mt-2 block text-sm font-semibold leading-6 text-slate-950">
                      {title}
                    </span>
                  </span>
                  <span
                    className={classNames(
                      "mt-4 inline-flex h-9 w-full items-center justify-center rounded-xl text-xs font-semibold",
                      selected ? "bg-emerald-600 text-white" : "bg-slate-950 text-white",
                    )}
                  >
                    {selected ? "선택됨" : "선택"}
                  </span>
                </button>
                );
              })}
            </div>
          </div>
          ) : null}

          {descriptionCandidates.length > 0 ? (
          <div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-slate-950">영상 설명 추천</p>
              <span className="text-xs text-slate-500">적용 후 아래에서 수정 가능</span>
            </div>
            <div className="mt-3 grid gap-3">
              {descriptionCandidates.map((description, index) => {
                const selected = normalizedCurrentBody === descriptionBodyOnly(description);
                return (
                <button
                  key={`${description.slice(0, 40)}-${index}`}
                  type="button"
                  onClick={() => onUseDescription(description)}
                  className={classNames(
                    "w-full rounded-2xl border p-4 text-left transition",
                    selected
                      ? "border-emerald-300 bg-emerald-50 shadow-sm"
                      : "border-slate-200 bg-white hover:border-slate-400 hover:bg-slate-50",
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-slate-950">
                      설명 후보 {index + 1}
                    </p>
                    <span
                      className={classNames(
                        "inline-flex h-8 items-center justify-center rounded-full px-3 text-xs font-semibold",
                        selected ? "bg-emerald-600 text-white" : "bg-slate-950 text-white",
                      )}
                    >
                      {selected ? "선택됨" : "선택"}
                    </span>
                  </div>
                  <p className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap text-sm leading-6 text-slate-700">
                    {description}
                  </p>
                </button>
                );
              })}
            </div>
          </div>
          ) : null}

          {chapterCandidates.length > 0 ? (
            <div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-slate-950">챕터 구성 추천</p>
                <span className="text-xs text-slate-500">설명란에 붙일 기준 선택</span>
              </div>
              <div className="mt-3 grid gap-3 lg:grid-cols-3">
                {chapterCandidates.map((chapters, index) => {
                  const selected = normalizedCurrentDescription.includes(chapters.trim());
                  return (
                  <button
                    key={`${chapters.slice(0, 40)}-${index}`}
                    type="button"
                    onClick={() => onUseChapters(chapters)}
                    className={classNames(
                      "w-full rounded-2xl border p-4 text-left transition",
                      selected
                        ? "border-emerald-300 bg-emerald-50 shadow-sm"
                        : "border-slate-200 bg-white hover:border-slate-400 hover:bg-slate-50",
                    )}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-slate-950">
                        챕터 후보 {index + 1}
                      </p>
                      <span
                        className={classNames(
                          "inline-flex h-8 items-center justify-center rounded-full px-3 text-xs font-semibold",
                          selected ? "bg-emerald-600 text-white" : "bg-slate-950 text-white",
                        )}
                      >
                        {selected ? "선택됨" : "선택"}
                      </span>
                    </div>
                    <p className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap text-sm leading-6 text-slate-700">
                      {chapters}
                    </p>
                  </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {tags.length > 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-950">추천 태그</p>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    YouTube 공식 기준으로 태그는 오타·다른 표기 보정용입니다.
                    제목·썸네일·설명을 먼저 보고, 태그는 업로드 세부정보 칸에만 넣습니다.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onUseTags(tags)}
                  className="inline-flex h-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white px-4 text-xs font-semibold text-slate-900 hover:bg-slate-50"
                >
                  태그 적용
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function NoticeBanner({ notice }: { notice: Notice }) {
  return (
    <div
      className={classNames(
        "rounded-lg border px-4 py-3 text-sm",
        notice.tone === "success" && "border-emerald-200 bg-emerald-50 text-emerald-900",
        notice.tone === "error" && "border-rose-200 bg-rose-50 text-rose-900",
        notice.tone === "neutral" && "border-slate-200 bg-white text-slate-700",
      )}
    >
      {notice.text}
    </div>
  );
}

function AgentWorkspacePanel({
  project,
  loading,
  error,
  captionRequired,
}: {
  project: AgentProjectDetail | null;
  loading: boolean;
  error: string | null;
  captionRequired: boolean;
}) {
  const selectedLanguages =
    project?.languages.filter((language) => language.selected) ?? [];
  const selectedLanguageCount = selectedLanguages.length;
  const hasCoreFiles = captionRequired
    ? project?.files.koreanUpload.status === "ready" &&
      project.files.reviewedEnglish.status === "ready" &&
      project.files.captionSourceLock.status === "ready" &&
      project.files.metadata.status === "ready"
    : project?.files.metadata.status === "ready";
  const koreanReady = Boolean(project) && hasCoreFiles;
  const selectedLanguageLabels = formatLanguagePreview(
    selectedLanguages.map((language) => language.shortLabel),
  );

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <SectionTitle
            step="3"
            title="제목·설명 언어 선택"
            hint={
              captionRequired
                ? "기본값은 YouTube 현재 지원 전체 언어입니다. 수동 자막은 한국어+영어만 올리고 나머지는 YouTube 자동 번역을 사용합니다."
                : "기본값은 YouTube 현재 지원 전체 언어입니다. 이 영상에는 수동 자막을 만들거나 업로드하지 않습니다."
            }
          />
        </div>
        <span
          className={classNames(
            "inline-flex min-h-9 shrink-0 items-center rounded-full px-3 text-xs font-semibold",
            koreanReady
              ? "bg-emerald-50 text-emerald-900"
              : "bg-amber-50 text-amber-900",
          )}
        >
          {koreanReady ? "준비 정보 확인됨" : "준비 정보 확인 필요"}
        </span>
      </div>

      {error ? (
        <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          {error}
        </div>
      ) : null}

      {!project ? (
        <div className="mt-4 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
          {loading ? "요청 준비 상태를 확인하고 있습니다." : "아직 표시할 작업이 없습니다."}
        </div>
      ) : (
        <>
          <div
            className={classNames(
              "mt-4 rounded-lg border px-4 py-3",
              koreanReady
                ? "border-emerald-200 bg-emerald-50"
                : "border-amber-200 bg-amber-50",
            )}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p
                  className={classNames(
                    "text-base font-semibold",
                    koreanReady ? "text-emerald-950" : "text-amber-950",
                  )}
                >
                  제목·설명 언어 {selectedLanguageCount}개
                </p>
                <p
                  className={classNames(
                    "mt-1 text-sm leading-6",
                    koreanReady ? "text-emerald-900" : "text-amber-900",
                  )}
                >
                  {selectedLanguageLabels || "선택된 언어 없음"}
                </p>
              </div>
            </div>
          </div>

          <p className="mt-3 border-t border-slate-200 pt-3 text-xs leading-5 text-slate-600">
            개별 언어 제외 없이 전체 세트를 사용합니다. 실제 업로드 단계에서 YouTube 지원 언어를 다시 조회하고 빠진 언어가 0개인지 검증합니다.
          </p>

        </>
      )}
    </section>
  );
}

function statusText(status: "ok" | "warn" | "error") {
  if (status === "ok") return "정상";
  if (status === "warn") return "확인";
  return "막힘";
}

function statusPillClass(status: "ok" | "warn" | "error") {
  if (status === "ok") return "border-emerald-200 bg-emerald-50 text-emerald-900";
  if (status === "warn") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-rose-200 bg-rose-50 text-rose-900";
}

function runStatusText(status: UploadRunRecord["status"]) {
  if (status === "done") return "완료";
  if (status === "partial") return "부분 실패";
  if (status === "uploading") return "진행 중";
  if (status === "error") return "실패";
  return "준비";
}

function runStatusClass(status: UploadRunRecord["status"]) {
  if (status === "done") return "bg-emerald-100 text-emerald-900";
  if (status === "partial") return "bg-amber-100 text-amber-900";
  if (status === "error") return "bg-rose-100 text-rose-900";
  return "bg-slate-100 text-slate-700";
}

function hasRetryableAttachments(run: UploadRunRecord) {
  if (!run.videoId) return false;
  if (run.thumbnail.status === "error" && run.thumbnail.artifactPath) return true;
  if (run.playlist.status === "error" && run.playlistId) return true;
  return run.captions.some(
    (caption) => caption.status === "error" && Boolean(caption.artifactPath),
  );
}

function OperationsPanel({
  draftChecks,
  preflight,
  runs,
  loading,
  retryingRunId,
  onRefresh,
  onRetry,
}: {
  draftChecks: DraftCheck[];
  preflight: PreflightResponse | null;
  runs: UploadRunRecord[];
  loading: boolean;
  retryingRunId: string | null;
  onRefresh: () => void;
  onRetry: (runId: string) => void;
}) {
  const allChecks = [
    ...draftChecks,
    ...(preflight?.items ?? []),
  ];
  const errorCount = allChecks.filter((item) => item.status === "error").length;
  const warnCount = allChecks.filter((item) => item.status === "warn").length;
  const panelStatus: "ok" | "warn" | "error" =
    errorCount > 0 ? "error" : warnCount > 0 ? "warn" : "ok";

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">최종 출고 점검</p>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            {errorCount > 0
              ? `${errorCount}개 항목은 요청 패키지에 넣을 수 없습니다.`
              : warnCount > 0
                ? `${warnCount}개 항목은 Codex 실행 전에 확인이 좋습니다.`
                : "요청 패키지 확인이 끝났습니다."}
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          <span
            className={classNames(
              "inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-xs font-semibold",
              statusPillClass(panelStatus),
            )}
          >
            {statusText(panelStatus)}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex h-8 shrink-0 items-center rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-900 hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? "점검 중" : "다시 점검"}
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
              현재 영상
            </p>
            <span className="text-[11px] text-slate-500">
              {draftChecks.filter((item) => item.status === "ok").length}/{draftChecks.length}
            </span>
          </div>
          <div className="mt-3 grid gap-2">
            {draftChecks.map((item) => (
              <div
                key={item.id}
                className="flex items-start justify-between gap-3 rounded-xl bg-white px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900">{item.label}</p>
                  <p className="mt-0.5 truncate text-xs text-slate-500">{item.detail}</p>
                </div>
                <span
                  className={classNames(
                    "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                    statusPillClass(item.status),
                  )}
                >
                  {statusText(item.status)}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
              앱 환경
            </p>
            <span className="text-[11px] text-slate-500">
              {preflight
                ? new Date(preflight.checkedAt).toLocaleTimeString("ko-KR", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "대기"}
            </span>
          </div>
          <div className="mt-3 grid gap-2">
            {(preflight?.items ?? []).map((item) => (
              <div
                key={item.id}
                className="flex items-start justify-between gap-3 rounded-xl bg-white px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900">{item.label}</p>
                  <p className="mt-0.5 truncate text-xs text-slate-500">{item.detail}</p>
                </div>
                <span
                  className={classNames(
                    "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                    statusPillClass(item.status),
                  )}
                >
                  {statusText(item.status)}
                </span>
              </div>
            ))}
            {!preflight ? (
              <p className="rounded-xl bg-white px-3 py-4 text-center text-xs text-slate-500">
                사전 점검을 읽는 중입니다.
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <details className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <summary className="cursor-pointer text-sm font-semibold text-slate-900">
          최근 실행 기록 {runs.length > 0 ? `(${runs.length})` : ""}
        </summary>
        <div className="mt-3 space-y-2">
          {runs.length === 0 ? (
            <p className="rounded-xl bg-white px-3 py-4 text-center text-xs text-slate-500">
              아직 저장된 업로드 실행 기록이 없습니다.
            </p>
          ) : (
            runs.slice(0, 6).map((run) => {
              const retryable = hasRetryableAttachments(run);
              return (
                <div
                  key={run.id}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">
                        {run.title || run.videoFileName}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {new Date(run.createdAt).toLocaleString("ko-KR")} ·{" "}
                        {run.videoId ? `videoId ${run.videoId}` : "videoId 없음"}
                      </p>
                    </div>
                    <span
                      className={classNames(
                        "rounded-full px-2.5 py-1 text-[11px] font-semibold",
                        runStatusClass(run.status),
                      )}
                    >
                      {runStatusText(run.status)}
                    </span>
                  </div>
                  {run.warnings.length > 0 ? (
                    <ul className="mt-2 space-y-1 text-xs text-amber-900">
                      {run.warnings.slice(0, 3).map((warning) => (
                        <li key={warning}>- {warning}</li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Link
                      href={`/runs/${encodeURIComponent(run.id)}`}
                      className="inline-flex h-8 items-center rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-900 hover:bg-slate-50"
                    >
                      결과 확인
                    </Link>
                    {run.studioUrl ? (
                      <a
                        href={run.studioUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-8 items-center rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-900 hover:bg-slate-50"
                      >
                        Studio 열기
                      </a>
                    ) : null}
                    {retryable ? (
                      <button
                        type="button"
                        onClick={() => onRetry(run.id)}
                        disabled={retryingRunId === run.id}
                        className="inline-flex h-8 items-center rounded-full border border-amber-300 bg-amber-50 px-3 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                      >
                        {retryingRunId === run.id ? "재시도 중" : "실패 항목 재시도"}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </details>
    </section>
  );
}

function DropCard({
  title,
  description,
  accept,
  inputRef,
  onChange,
  onDrop,
  filename,
  filesize,
}: {
  title: string;
  description: string;
  accept: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  filename?: string;
  filesize?: string;
}) {
  return (
    <div
      className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 transition hover:border-emerald-400 hover:bg-white"
      onDrop={onDrop}
      onDragOver={(event) => event.preventDefault()}
    >
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      <p className="mt-1 text-xs leading-5 text-slate-600">{description}</p>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={onChange}
      />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="inline-flex h-9 items-center justify-center rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-900 hover:bg-slate-50"
        >
          {filename ? "다른 파일로 바꾸기" : "파일 선택"}
        </button>
        {filename ? (
          <div className="min-w-0 text-xs text-slate-700">
            <p className="truncate font-semibold text-slate-900">{filename}</p>
            {filesize ? <p className="text-slate-500">{filesize}</p> : null}
          </div>
        ) : (
          <p className="text-xs text-slate-500">또는 여기에 끌어다 놓으세요</p>
        )}
      </div>
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-b border-slate-100 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <p className="shrink-0 text-xs font-semibold text-slate-500">{label}</p>
      <p className="min-w-0 break-words text-sm text-slate-900 sm:text-right">{value}</p>
    </div>
  );
}

/**
 * 프리셋 카드 — 칩 그리드로 한눈에 보고 클릭으로 적용.
 *
 * 구조:
 *   1) 프리셋 칩 그리드 — 클릭하면 즉시 적용. 활성 프리셋은 강조.
 *   2) 활성 프리셋 액션 — "지금 설정 덮어쓰기" + "삭제" (활성 있을 때만)
 *   3) [+ 새 프리셋] — 인라인 입력 토글 (디폴트 접힘)
 *   4) 저장될 값 미리보기 (펼치기)
 */
function PresetCard({
  presets,
  activePresetId,
  onApply,
  onSave,
  onDelete,
  currentDraftSnapshot,
}: {
  presets: UploadPreset[];
  activePresetId: string | null;
  onApply: (preset: UploadPreset) => void;
  /** id 있으면 그 id로 덮어쓰기, 없으면 새로 만들기. */
  onSave: (name: string, id?: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  currentDraftSnapshot: () => string;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);

  const activePreset = activePresetId
    ? presets.find((p) => p.id === activePresetId) ?? null
    : null;

  async function handleCreate() {
    const trimmed = newName.trim();
    if (!trimmed) {
      setMessage({ tone: "err", text: "프리셋 이름을 입력해 주세요." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await onSave(trimmed);
      setNewName("");
      setCreating(false);
      setMessage({ tone: "ok", text: `"${trimmed}" 새 프리셋 저장 완료.` });
    } catch (error) {
      setMessage({
        tone: "err",
        text:
          error instanceof Error ? error.message : "저장 중 오류가 발생했습니다.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleOverwrite() {
    if (!activePreset) return;
    setBusy(true);
    setMessage(null);
    try {
      await onSave(activePreset.name, activePreset.id);
      setMessage({
        tone: "ok",
        text: `"${activePreset.name}" 프리셋에 지금 설정 저장 완료.`,
      });
    } catch (error) {
      setMessage({
        tone: "err",
        text:
          error instanceof Error ? error.message : "저장 중 오류가 발생했습니다.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!activePreset) return;
    if (
      !window.confirm(
        `"${activePreset.name}" 프리셋을 삭제할까요? 되돌릴 수 없습니다.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await onDelete(activePreset.id);
      setMessage({
        tone: "ok",
        text: `"${activePreset.name}" 삭제 완료.`,
      });
    } catch (error) {
      setMessage({
        tone: "err",
        text:
          error instanceof Error ? error.message : "삭제 중 오류가 발생했습니다.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">업로드 프리셋</h2>
          <p className="mt-1 text-xs text-slate-600">
            매번 쓰는 옵션 묶음. 클릭 한 번에 카테고리·태그·라이선스 등 일괄 채움.
          </p>
        </div>
      </div>

      {/* 1) 프리셋 칩 그리드 */}
      <div className="mt-4 flex flex-wrap gap-2">
        {presets.length === 0 ? (
          <p className="text-xs text-slate-500">
            저장된 프리셋이 없습니다. 아래 [+ 새 프리셋]으로 만들어 보세요.
          </p>
        ) : (
          presets.map((preset) => {
            const isActive = preset.id === activePresetId;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => onApply(preset)}
                className={classNames(
                  "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition",
                  isActive
                    ? "border-emerald-400 bg-emerald-50 text-emerald-900 shadow-sm"
                    : "border-slate-200 bg-white text-slate-800 hover:bg-slate-50",
                )}
              >
                {isActive ? <span className="text-emerald-600">✓</span> : null}
                <span>{preset.name}</span>
              </button>
            );
          })
        )}

        {/* [+ 새 프리셋] — 칩 라인 끝에 같이 자리. 토글로 입력 폼 노출 */}
        {!creating ? (
          <button
            type="button"
            onClick={() => {
              setCreating(true);
              setMessage(null);
            }}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-slate-400 hover:bg-slate-50"
          >
            <span>＋</span>
            <span>새 프리셋</span>
          </button>
        ) : null}
      </div>

      {/* 1b) 새 프리셋 인라인 입력 폼 (creating 상태일 때만) */}
      {creating ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleCreate();
              else if (event.key === "Escape") {
                setCreating(false);
                setNewName("");
              }
            }}
            placeholder="프리셋 이름 (예: 디노 RTX 시리즈)"
            autoFocus
            className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={busy || !newName.trim()}
            className="inline-flex h-9 items-center rounded-full bg-slate-900 px-4 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
          >
            지금 설정으로 저장
          </button>
          <button
            type="button"
            onClick={() => {
              setCreating(false);
              setNewName("");
            }}
            className="inline-flex h-9 items-center rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            취소
          </button>
        </div>
      ) : null}

      {/* 2) 활성 프리셋 액션 */}
      {activePreset ? (
        <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50/40 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-emerald-800">
                적용 중
              </p>
              <p className="mt-0.5 truncate text-sm font-semibold text-slate-900">
                {activePreset.name}
              </p>
              <p className="text-[11px] text-slate-500">
                마지막 저장: {new Date(activePreset.updatedAt).toLocaleString("ko-KR")}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleOverwrite()}
                disabled={busy}
                className="inline-flex h-9 items-center rounded-full bg-slate-900 px-4 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
              >
                지금 설정으로 덮어쓰기
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={busy}
                className="inline-flex h-9 items-center rounded-full border border-rose-200 bg-white px-3 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 3) 결과 메시지 */}
      {message ? (
        <p
          className={classNames(
            "mt-3 rounded-xl px-3 py-2 text-xs",
            message.tone === "ok"
              ? "bg-emerald-50 text-emerald-900"
              : "bg-rose-50 text-rose-900",
          )}
        >
          {message.text}
        </p>
      ) : null}

      {/* 4) 미리보기 — 저장 시 들어갈 값 (개발자/디버깅용, 디폴트 접힘) */}
      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-900">
          저장될 옵션 값 보기
        </summary>
        <pre className="mt-2 max-h-48 overflow-auto rounded-xl bg-slate-50 px-3 py-2 font-mono text-[11px] leading-5 text-slate-700">
          {currentDraftSnapshot()}
        </pre>
      </details>
    </section>
  );
}

/**
 * 업로드 옵션 카드 — YouTube API의 모든 옵션을 한자리에.
 * 기본 옵션(자주 결정) + 고급 옵션(접힘, 가끔 결정).
 */
function UploadOptionsCard({
  categoryId,
  setCategoryId,
  defaultAudioLanguage,
  setDefaultAudioLanguage,
  playlistId,
  setPlaylistId,
  publishAt,
  setPublishAt,
  recordingDate,
  setRecordingDate,
  madeForKids,
  setMadeForKids,
  containsSyntheticMedia,
  setContainsSyntheticMedia,
  embeddable,
  setEmbeddable,
  publicStatsViewable,
  setPublicStatsViewable,
  notifySubscribers,
  setNotifySubscribers,
  license,
  setLicense,
  channelPlaylists,
  channelCategories,
  channelLanguages,
  authConnected,
}: {
  categoryId: string;
  setCategoryId: (value: string) => void;
  defaultAudioLanguage: string;
  setDefaultAudioLanguage: (value: string) => void;
  playlistId: string;
  setPlaylistId: (value: string) => void;
  publishAt: string;
  setPublishAt: (value: string) => void;
  recordingDate: string;
  setRecordingDate: (value: string) => void;
  madeForKids: boolean;
  setMadeForKids: (value: boolean) => void;
  containsSyntheticMedia: boolean;
  setContainsSyntheticMedia: (value: boolean) => void;
  embeddable: boolean;
  setEmbeddable: (value: boolean) => void;
  publicStatsViewable: boolean;
  setPublicStatsViewable: (value: boolean) => void;
  notifySubscribers: boolean;
  setNotifySubscribers: (value: boolean) => void;
  license: LicenseType;
  setLicense: (value: LicenseType) => void;
  channelPlaylists: ChannelMetaPlaylist[];
  channelCategories: ChannelMetaCategory[];
  channelLanguages: ChannelMetaLanguage[];
  authConnected: boolean;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold">업로드 옵션</h2>
      <p className="mt-1 text-xs text-slate-600">
        카테고리, 재생목록, 음성 언어와 공개 관련 옵션을 확인합니다.
      </p>

      {/* 기본 옵션 */}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {/* 카테고리 */}
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
            카테고리
          </span>
          <select
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
            disabled={!authConnected}
          >
            {channelCategories.length === 0 ? (
              <option value={categoryId}>
                {authConnected ? "로딩 중..." : "YouTube 연결 후 로드"}
              </option>
            ) : (
              channelCategories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.title} ({cat.id})
                </option>
              ))
            )}
          </select>
        </label>

        {/* 재생목록 */}
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
            재생목록 (선택)
          </span>
          <select
            value={playlistId}
            onChange={(event) => setPlaylistId(event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
            disabled={!authConnected}
          >
            <option value="">— 추가 안 함 —</option>
            {channelPlaylists.map((pl) => (
              <option key={pl.id} value={pl.id}>
                {pl.title} ({pl.itemCount}개 · {pl.privacyStatus})
              </option>
            ))}
          </select>
        </label>

        {/* 음성 언어 */}
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
            음성 언어
          </span>
          <select
            value={defaultAudioLanguage}
            onChange={(event) => setDefaultAudioLanguage(event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
          >
            {channelLanguages.length === 0 ? (
              // fallback: 자주 쓰는 언어들 하드코딩
              <>
                <option value="ko">한국어 (ko)</option>
                <option value="en">영어 (en)</option>
                <option value="ja">일본어 (ja)</option>
                <option value="zh-CN">중국어 간체 (zh-CN)</option>
              </>
            ) : (
              channelLanguages.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.name} ({lang.code})
                </option>
              ))
            )}
          </select>
        </label>

        {/* 예약 공개 */}
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
            예약 공개 (선택)
          </span>
          <input
            type="datetime-local"
            value={publishAt}
            onChange={(event) => setPublishAt(event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
          />
          <p className="mt-1 text-[11px] text-slate-500">
            설정 시 비공개로 올라간 후 지정 시각에 자동 공개. (공개 설정 자동으로 비공개 강제)
          </p>
        </label>
      </div>

      <details className="mt-4 border-t border-slate-200 pt-3">
        <summary className="cursor-pointer text-sm font-semibold text-slate-800 hover:text-slate-950">
          기타 옵션 수정
          <span className="ml-2 text-xs font-normal text-slate-500">
            {madeForKids ? "아동용" : "아동용 아님"} · {containsSyntheticMedia ? "AI 표시" : "AI 표시 안 함"} · {notifySubscribers ? "알림 켬" : "알림 끔"}
          </span>
        </summary>

        <div className="mt-3 space-y-3 border-t border-slate-100 pt-4">
          {/* 키즈 / AI / 임베드 / 통계 (체크박스 grid) */}
          <div className="grid gap-3 md:grid-cols-2">
            <ToggleRow
              label="아동용 콘텐츠 (Made for Kids)"
              description="YouTube Kids에 노출. 댓글·알림 등 일부 기능 비활성화됨."
              checked={madeForKids}
              onChange={setMadeForKids}
            />
            <ToggleRow
              label="AI/합성 미디어 포함"
              description="현실적 AI 생성 영상이면 활성화. 디노 채널처럼 AI 콘텐츠 다루면 권장."
              checked={containsSyntheticMedia}
              onChange={setContainsSyntheticMedia}
              accent="amber"
            />
            <ToggleRow
              label="외부 사이트 임베드 허용"
              description="블로그·다른 사이트에 영상 임베드 가능."
              checked={embeddable}
              onChange={setEmbeddable}
            />
            <ToggleRow
              label="조회수·좋아요 공개"
              description="시청자에게 통계 표시. 보통 켬."
              checked={publicStatsViewable}
              onChange={setPublicStatsViewable}
            />
            <ToggleRow
              label="구독자에게 알림"
              description="공개 상태에서는 구독자에게 신영상 알림. 비공개 상태에서는 의미 없음."
              checked={notifySubscribers}
              onChange={setNotifySubscribers}
              accent="emerald"
            />
          </div>

          <div className="grid gap-2 rounded-2xl border border-slate-200 bg-white p-3 text-xs text-slate-700 md:grid-cols-2">
            <div>
              <span className="font-semibold text-slate-500">댓글</span>
              <p>켬</p>
            </div>
            <div>
              <span className="font-semibold text-slate-500">검토</span>
              <p>없음</p>
            </div>
            <div>
              <span className="font-semibold text-slate-500">댓글을 올릴 수 있는 사용자</span>
              <p>모든 사용자</p>
            </div>
            <div>
              <span className="font-semibold text-slate-500">정렬 기준</span>
              <p>최신순</p>
            </div>
          </div>

          {/* 라이선스 + 촬영일 */}
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                라이선스
              </span>
              <select
                value={license}
                onChange={(event) => setLicense(event.target.value as LicenseType)}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
              >
                <option value="youtube">표준 YouTube 라이선스</option>
                <option value="creativeCommon">크리에이티브 커먼즈 (재사용 허용)</option>
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                촬영일 (선택)
              </span>
              <input
                type="date"
                value={recordingDate}
                onChange={(event) => setRecordingDate(event.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
              />
            </label>
          </div>
        </div>
      </details>
    </section>
  );
}

/**
 * 채널 기본정보 카드 — AI에게 매번 같이 보내는 컨텍스트.
 *
 * - 채널명 (예: "디노")과 다국어 표기 (예: en="Dino", ja="デノ")
 * - 채널 한 줄 설명
 * - 용어집 (한국어 → 외국어 표준 표기)
 *
 * stateless — 부모가 channelProfile state 들고 있고 onChange로 즉시 갱신.
 * [저장] 누르면 디스크에 영구화.
 */
function ChannelProfileCard({
  profile,
  onChange,
  onSave,
  saving,
}: {
  profile: ChannelProfile;
  onChange: (next: ChannelProfile) => void;
  onSave: () => Promise<void>;
  saving: boolean;
}) {
  const [message, setMessage] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);

  async function handleSave() {
    setMessage(null);
    try {
      await onSave();
      setMessage({ tone: "ok", text: "채널 정보 저장 완료." });
    } catch (error) {
      setMessage({
        tone: "err",
        text:
          error instanceof Error ? error.message : "저장 중 오류가 발생했습니다.",
      });
    }
  }

  // 다국어 표기 input — 자주 쓰는 언어 6개를 먼저 보여준다.
  const presetLangs = ["en", "ja", "zh-Hans", "ru", "es-419", "id"];
  const presetLangLabels: Record<string, string> = {
    en: "영어 (English)",
    ja: "일본어 (日本語)",
    "zh-CN": "중국어 간체 (简体)",
    "zh-Hans": "중국어 간체 (简体)",
    "zh-TW": "중국어 번체 (繁體)",
    ru: "러시아어 (Русский)",
    es: "스페인어 (Español)",
    "es-419": "스페인어 라틴아메리카",
    id: "인도네시아어 (Indonesia)",
  };

  function updateLocalization(lang: string, value: string) {
    const nextMap = { ...profile.nameLocalizations };
    if (value.trim()) nextMap[lang] = value;
    else delete nextMap[lang];
    onChange({ ...profile, nameLocalizations: nextMap });
  }

  function updateGlossaryEntry(idx: number, patch: Partial<GlossaryEntry>) {
    const next = profile.glossary.map((entry, i) =>
      i === idx ? { ...entry, ...patch } : entry,
    );
    onChange({ ...profile, glossary: next });
  }

  function addGlossaryEntry() {
    onChange({
      ...profile,
      glossary: [...profile.glossary, { korean: "", english: "" }],
    });
  }

  function removeGlossaryEntry(idx: number) {
    onChange({
      ...profile,
      glossary: profile.glossary.filter((_, i) => i !== idx),
    });
  }

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6">
      <details>
        <summary className="cursor-pointer list-none">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">
                채널 기본정보 <span className="text-xs text-slate-500">— AI가 매번 참고</span>
              </h2>
              <p className="mt-1 text-xs text-slate-600">
                채널명 다국어 표기 + 자주 쓰는 용어. 설정해두면 다국어 자료를 만들 때 참고합니다.
              </p>
            </div>
            <p className="text-xs text-slate-500">
              {profile.primaryName
                ? `✓ 설정됨: ${profile.primaryName}${
                    Object.keys(profile.nameLocalizations).length > 0
                      ? ` (${Object.keys(profile.nameLocalizations).length}개 언어 표기)`
                      : ""
                  }`
                : "미설정 (클릭해서 펼치기)"}
            </p>
          </div>
        </summary>

        <div className="mt-5 space-y-5">
          {/* 채널명 + 설명 */}
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                채널명 (한국어)
              </span>
              <input
                value={profile.primaryName}
                onChange={(event) =>
                  onChange({ ...profile, primaryName: event.target.value })
                }
                placeholder="예: 디노"
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                비워두면 채널 정보 비활성 (AI에 채널 컨텍스트 안 보냄).
              </p>
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                채널 한 줄 설명
              </span>
              <input
                value={profile.channelDescription}
                onChange={(event) =>
                  onChange({ ...profile, channelDescription: event.target.value })
                }
                placeholder="예: AI · ComfyUI 튜토리얼 채널"
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
              />
            </label>
          </div>

          {/* 다국어 표기 */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
              채널명 다국어 표기
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              비워두면 모델이 알아서 음역 (덜 일관됨). 정해진 표기가 있으면 꼭 채워주세요.
            </p>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              {presetLangs.map((lang) => (
                <label key={lang} className="flex items-center gap-2">
                  <span className="w-32 shrink-0 text-xs text-slate-700">
                    {presetLangLabels[lang]}
                  </span>
                  <input
                    value={profile.nameLocalizations[lang] ?? ""}
                    onChange={(event) => updateLocalization(lang, event.target.value)}
                    placeholder={
                      lang === "en"
                        ? "예: Dino"
                        : lang === "ja"
                          ? "예: デノ"
                          : ""
                    }
                    className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  />
                </label>
              ))}
            </div>
          </div>

          {/* 용어집 */}
          <div>
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                용어집 (한국어 → 외국어 표준)
              </p>
              <button
                type="button"
                onClick={addGlossaryEntry}
                className="inline-flex h-7 items-center rounded-full border border-slate-200 bg-white px-3 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
              >
                ＋ 용어 추가
              </button>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              일관되게 번역할 단어들. 예: 컴파이UI → ComfyUI, 노드 → node, 업스케일 → upscale.
            </p>
            <div className="mt-2 space-y-2">
              {profile.glossary.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
                  용어집이 비어 있습니다. [＋ 용어 추가]로 시작.
                </p>
              ) : (
                profile.glossary.map((entry, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
                  >
                    <input
                      value={entry.korean}
                      onChange={(event) =>
                        updateGlossaryEntry(idx, { korean: event.target.value })
                      }
                      placeholder="한국어"
                      className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
                    />
                    <span className="text-slate-400">→</span>
                    <input
                      value={entry.english}
                      onChange={(event) =>
                        updateGlossaryEntry(idx, { english: event.target.value })
                      }
                      placeholder="외국어 표준 표기"
                      className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => removeGlossaryEntry(idx)}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-rose-200 bg-white text-xs text-rose-700 hover:bg-rose-50"
                      aria-label="이 용어 삭제"
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* 저장 */}
          <div className="flex items-center gap-3 border-t border-slate-100 pt-4">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="inline-flex h-10 items-center justify-center rounded-full bg-slate-900 px-5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {saving ? "저장 중..." : "채널 정보 저장"}
            </button>
            <p className="text-[11px] text-slate-500">
              저장 후 다음 자막·업로드 정보 작업부터 이 정보를 참고합니다.
            </p>
          </div>

          {message ? (
            <p
              className={classNames(
                "rounded-xl px-3 py-2 text-xs",
                message.tone === "ok"
                  ? "bg-emerald-50 text-emerald-900"
                  : "bg-rose-50 text-rose-900",
              )}
            >
              {message.text}
            </p>
          ) : null}
        </div>
      </details>
    </section>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  accent,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  accent?: "amber" | "emerald";
}) {
  const accentClass =
    accent === "amber"
      ? "accent-amber-600"
      : accent === "emerald"
        ? "accent-emerald-600"
        : "accent-slate-900";
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 hover:bg-slate-50">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className={classNames("mt-0.5 h-4 w-4", accentClass)}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-900">{label}</span>
        <span className="block text-[11px] leading-5 text-slate-600">
          {description}
        </span>
      </span>
    </label>
  );
}
