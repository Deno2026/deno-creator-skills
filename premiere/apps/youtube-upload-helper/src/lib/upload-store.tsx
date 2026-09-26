"use client";

/**
 * 메인 업로드 화면의 작업 상태를 layout 레벨로 끌어올린 store.
 *
 * 왜 store가 필요한가:
 * 페이지 컴포넌트(`/`)의 useState였으면 사용자가 [설정] 갔다가 돌아왔을 때 컴포넌트가
 * 한 번 unmount되면서 영상/자막/메타/번역 결과가 통째로 날아간다. layout 레벨 Provider로
 * 끌어올리면 페이지 전환과 무관하게 같은 브라우저 탭 안에서 유지된다.
 *
 * 한계: File 객체는 브라우저 보안상 직렬화 불가. 탭 새로고침/닫기 시 영상·자막은
 * 다시 drop해야 한다. 페이지 라우팅(메인 ↔ 설정)에는 영향 없다.
 *
 * 진행 중인 fetch도 끊기지 않는다 — Promise는 컴포넌트 unmount와 무관하게 살아 있고,
 * resolve 시 store 업데이트만 한다. 사용자가 메인으로 돌아오면 그 결과가 그대로 보인다.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { LlmCallDebug, SubtitleCue } from "@/lib/llm/types";
import type {
  LicenseType,
  UploadDraft,
  UploadPreset,
} from "@/lib/upload-preset-types";
import { defaultUploadDraft } from "@/lib/upload-preset-types";
import type { ChapterSuggestion } from "@/lib/chapter-types";

export type ChannelMetaPlaylist = {
  id: string;
  title: string;
  itemCount: number;
  privacyStatus: string;
};

export type ChannelMetaCategory = {
  id: string;
  title: string;
};

export type ChannelMetaLanguage = {
  code: string;
  name: string;
};

export type LanguageJobStatus = "idle" | "running" | "done" | "error";

export type SubtitleJob = {
  status: LanguageJobStatus;
  cues?: SubtitleCue[];
  error?: string;
};

export type MetadataJob = {
  status: LanguageJobStatus;
  title?: string;
  description?: string;
  error?: string;
};

export type SuggestStatus = "idle" | "running" | "done" | "error";

export type Suggestion = {
  titleCandidates: string[];
  descriptionCandidates: string[];
  tags: string[];
};

export type ContentKind = "longform" | "cinematic" | "shorts";
export type PrivacyStatus = "private" | "unlisted" | "public";

export type UploadResult = {
  runId?: string;
  videoId: string;
  studioUrl: string;
  url: string;
  partial?: boolean;
  warnings?: string[];
  effectivePrivacyStatus?: string;
};

export type PreparedUploadRequestResult = {
  requestId: string;
  requestDir: string;
  manifestPath: string;
  readyMarkerPath?: string;
  createdAt: string;
  targetLanguages: string[];
  sourceFingerprint?: string;
  supersedesRequestId?: string;
  previousRequestSuperseded?: boolean;
  manifestVerified?: boolean;
  videoFileName: string;
  subtitleFileName?: string;
  thumbnailFileName?: string;
  capturedMetadata?: {
    title: string;
    descriptionLength: number;
    tagCount: number;
    privacyStatus: string;
    categoryId: string;
  };
};

export type PreparedProductionVideo = {
  production: string;
  preparationId: string;
  handoffSha256: string;
  uploadId: string;
  status: "complete";
  name: string;
  type: string;
  size: number;
  lastModified: number;
  sha256: string;
  videoFingerprint: string;
  previewUrl: string;
  materializationMode: "hardlink" | "copy" | "chunked";
};

const PREPARED_REQUEST_SESSION_KEY = "deno-upload-helper:prepared-request";

type UploadStoreValue = {
  // 입력 파일
  videoFile: File | null;
  videoUrl: string | null;
  preparedProductionVideo: PreparedProductionVideo | null;
  srtFile: File | null;
  koreanCues: SubtitleCue[];
  thumbnailFile: File | null;
  thumbnailUrl: string | null;

  setVideo: (file: File) => void;
  setPreparedProductionVideo: (value: PreparedProductionVideo | null) => void;
  setSrt: (file: File, cues: SubtitleCue[]) => void;
  setThumbnail: (file: File | null) => void;

  // 영상 유형
  contentKind: ContentKind;
  setContentKind: (value: ContentKind) => void;
  shortsBrief: string;
  setShortsBrief: (value: string) => void;

  // 한국어 메타 (사용자 편집)
  koreanTitle: string;
  setKoreanTitle: (value: string | ((current: string) => string)) => void;
  koreanDescription: string;
  setKoreanDescription: (value: string | ((current: string) => string)) => void;
  koreanTagsText: string;
  setKoreanTagsText: (value: string | ((current: string) => string)) => void;

  // m28 — 업로드 옵션 (영상 단위 + 프리셋 단위 모두 포함)
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

  // m28 — 채널 메타 (fetch 후 캐시)
  channelPlaylists: ChannelMetaPlaylist[];
  setChannelPlaylists: (value: ChannelMetaPlaylist[]) => void;
  channelCategories: ChannelMetaCategory[];
  setChannelCategories: (value: ChannelMetaCategory[]) => void;
  channelLanguages: ChannelMetaLanguage[];
  setChannelLanguages: (value: ChannelMetaLanguage[]) => void;

  // m28 — 프리셋
  presets: UploadPreset[];
  setPresets: (value: UploadPreset[]) => void;
  activePresetId: string | null;
  setActivePresetId: (value: string | null) => void;
  applyPresetDraft: (draft: UploadDraft) => void;

  // 메타 추천
  suggestStatus: SuggestStatus;
  setSuggestStatus: (status: SuggestStatus) => void;
  suggestion: Suggestion | null;
  setSuggestion: (value: Suggestion | null) => void;
  suggestError: string | null;
  setSuggestError: (value: string | null) => void;

  // 다국어 번역 (자막)
  subtitleJobs: Record<string, SubtitleJob>;
  setSubtitleJobs: (
    value:
      | Record<string, SubtitleJob>
      | ((current: Record<string, SubtitleJob>) => Record<string, SubtitleJob>),
  ) => void;

  // 다국어 번역 (메타)
  metadataJobs: Record<string, MetadataJob>;
  setMetadataJobs: (
    value:
      | Record<string, MetadataJob>
      | ((current: Record<string, MetadataJob>) => Record<string, MetadataJob>),
  ) => void;

  // 모델 입출력 기록 (자동 처리 진행 중 누적). 메모리만, 디스크에 저장 안 함.
  llmDebugLogs: LlmCallDebug[];
  appendLlmDebug: (entries: LlmCallDebug[]) => void;
  clearLlmDebug: () => void;

  // m31 — 챕터 자동 생성
  chapterStatus: SuggestStatus;
  setChapterStatus: (status: SuggestStatus) => void;
  chapterSuggestion: ChapterSuggestion | null;
  setChapterSuggestion: (value: ChapterSuggestion | null) => void;
  chapterError: string | null;
  setChapterError: (value: string | null) => void;

  // 공개 설정
  privacyStatus: PrivacyStatus;
  setPrivacyStatus: (value: PrivacyStatus) => void;

  // 업로드 결과
  uploadResult: UploadResult | null;
  setUploadResult: (value: UploadResult | null) => void;

  preparedUploadRequest: PreparedUploadRequestResult | null;
  setPreparedUploadRequest: (value: PreparedUploadRequestResult | null) => void;

  // 전체 리셋 (다음 영상 시작할 때)
  resetWorkspace: () => void;
};

const UploadStoreContext = createContext<UploadStoreValue | null>(null);

export function UploadStoreProvider({ children }: { children: ReactNode }) {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [preparedProductionVideo, setPreparedProductionVideoState] =
    useState<PreparedProductionVideo | null>(null);
  const [srtFile, setSrtFile] = useState<File | null>(null);
  const [koreanCues, setKoreanCues] = useState<SubtitleCue[]>([]);
  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  const [contentKind, setContentKind] = useState<ContentKind>("longform");
  const [shortsBrief, setShortsBrief] = useState("");

  const [koreanTitle, setKoreanTitle] = useState("");
  const [koreanDescription, setKoreanDescription] = useState("");
  const [koreanTagsText, setKoreanTagsText] = useState("");

  const [suggestStatus, setSuggestStatus] = useState<SuggestStatus>("idle");
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  const [subtitleJobs, setSubtitleJobs] = useState<Record<string, SubtitleJob>>({});
  const [metadataJobs, setMetadataJobs] = useState<Record<string, MetadataJob>>({});

  const [llmDebugLogs, setLlmDebugLogs] = useState<LlmCallDebug[]>([]);

  // m31 — 챕터
  const [chapterStatus, setChapterStatus] = useState<SuggestStatus>("idle");
  const [chapterSuggestion, setChapterSuggestion] =
    useState<ChapterSuggestion | null>(null);
  const [chapterError, setChapterError] = useState<string | null>(null);

  const [privacyStatus, setPrivacyStatus] = useState<PrivacyStatus>("unlisted");
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [preparedUploadRequest, setPreparedUploadRequest] =
    useState<PreparedUploadRequestResult | null>(null);
  const [preparedRequestHydrated, setPreparedRequestHydrated] = useState(false);

  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      try {
        const saved = window.sessionStorage.getItem(PREPARED_REQUEST_SESSION_KEY);
        if (saved) {
          const parsed = JSON.parse(saved) as Partial<PreparedUploadRequestResult>;
          if (
            typeof parsed.requestId === "string" &&
            typeof parsed.requestDir === "string" &&
            typeof parsed.manifestPath === "string" &&
            typeof parsed.createdAt === "string" &&
            typeof parsed.videoFileName === "string" &&
            Array.isArray(parsed.targetLanguages)
          ) {
            setPreparedUploadRequest(parsed as PreparedUploadRequestResult);
          }
        }
      } catch {
        window.sessionStorage.removeItem(PREPARED_REQUEST_SESSION_KEY);
      } finally {
        setPreparedRequestHydrated(true);
      }
    }, 0);

    return () => window.clearTimeout(restoreTimer);
  }, []);

  useEffect(() => {
    if (!preparedRequestHydrated) return;
    try {
      if (preparedUploadRequest) {
        window.sessionStorage.setItem(
          PREPARED_REQUEST_SESSION_KEY,
          JSON.stringify(preparedUploadRequest),
        );
      } else {
        window.sessionStorage.removeItem(PREPARED_REQUEST_SESSION_KEY);
      }
    } catch {
      // Session storage can be unavailable in hardened browser profiles.
    }
  }, [preparedRequestHydrated, preparedUploadRequest]);

  // m28 — 업로드 옵션 (디폴트는 defaultUploadDraft 기반).
  const [categoryId, setCategoryId] = useState<string>(defaultUploadDraft.categoryId);
  const [defaultAudioLanguage, setDefaultAudioLanguage] = useState<string>(
    defaultUploadDraft.defaultAudioLanguage,
  );
  const [playlistId, setPlaylistId] = useState<string>(defaultUploadDraft.playlistId);
  const [publishAt, setPublishAt] = useState<string>("");
  const [recordingDate, setRecordingDate] = useState<string>("");
  const [madeForKids, setMadeForKids] = useState<boolean>(defaultUploadDraft.madeForKids);
  const [containsSyntheticMedia, setContainsSyntheticMedia] = useState<boolean>(
    defaultUploadDraft.containsSyntheticMedia,
  );
  const [embeddable, setEmbeddable] = useState<boolean>(defaultUploadDraft.embeddable);
  const [publicStatsViewable, setPublicStatsViewable] = useState<boolean>(
    defaultUploadDraft.publicStatsViewable,
  );
  const [notifySubscribers, setNotifySubscribers] = useState<boolean>(
    defaultUploadDraft.notifySubscribers,
  );
  const [license, setLicense] = useState<LicenseType>(defaultUploadDraft.license);

  // m28 — 채널 메타 캐시.
  const [channelPlaylists, setChannelPlaylists] = useState<ChannelMetaPlaylist[]>([]);
  const [channelCategories, setChannelCategories] = useState<ChannelMetaCategory[]>([]);
  const [channelLanguages, setChannelLanguages] = useState<ChannelMetaLanguage[]>([]);

  // m28 — 프리셋.
  const [presets, setPresets] = useState<UploadPreset[]>([]);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);

  /**
   * 프리셋의 draft를 store 상태에 적용. 영상별 값(publishAt, recordingDate)은
   * 프리셋에 포함되지 않으므로 건드리지 않는다. 제목/설명/태그도 프리셋에
   * 디폴트로 박혀있긴 하지만 매 영상마다 다르므로 비어있을 때만 채운다.
   */
  const applyPresetDraft = useCallback((draft: UploadDraft) => {
    // 한국어 메타는 사용자가 이미 입력했으면 보존, 비어있으면 프리셋 디폴트 채움.
    setKoreanTitle((current) => current || draft.title);
    setKoreanDescription((current) => current || draft.description);
    setKoreanTagsText((current) => current || draft.tags);

    // 업로드 옵션은 프리셋 값으로 덮어쓰기 (사용자가 프리셋 적용을 선택한 이상 의도된 동작).
    setCategoryId(draft.categoryId);
    setDefaultAudioLanguage(draft.defaultAudioLanguage);
    setPlaylistId(draft.playlistId);
    setMadeForKids(draft.madeForKids);
    setContainsSyntheticMedia(draft.containsSyntheticMedia);
    setEmbeddable(draft.embeddable);
    setPublicStatsViewable(draft.publicStatsViewable);
    setNotifySubscribers(draft.notifySubscribers);
    setLicense(draft.license);
    setPrivacyStatus(draft.privacyStatus);
  }, []);

  const appendLlmDebug = useCallback((entries: LlmCallDebug[]) => {
    if (entries.length === 0) return;
    setLlmDebugLogs((current) => [...current, ...entries]);
  }, []);

  const clearLlmDebug = useCallback(() => {
    setLlmDebugLogs([]);
  }, []);

  const setVideo = useCallback(
    (file: File) => {
      setPreparedProductionVideoState(null);
      setVideoFile((previousFile) => {
        // 이전 ObjectURL 정리 — videoUrl state 변경이 비동기라 직접 참조 안 함.
        // 새 URL 만든 후 setVideoUrl로 교체. 이전 URL은 다음 setState block에서 revoke.
        if (previousFile) {
          // setVideoUrl도 같이 호출돼야 하니 아래 setVideoUrl 호출 직전에 revoke.
        }
        return file;
      });
      setVideoUrl((previousUrl) => {
        if (previousUrl) {
          URL.revokeObjectURL(previousUrl);
        }
        return URL.createObjectURL(file);
      });
      setUploadResult(null);
    },
    [],
  );

  const setPreparedProductionVideo = useCallback(
    (value: PreparedProductionVideo | null) => {
      setVideoFile(null);
      setVideoUrl((previousUrl) => {
        if (previousUrl?.startsWith("blob:")) URL.revokeObjectURL(previousUrl);
        return value?.previewUrl ?? null;
      });
      setPreparedProductionVideoState(value);
      setUploadResult(null);
    },
    [],
  );

  const setSrt = useCallback((file: File, cues: SubtitleCue[]) => {
    setSrtFile(file);
    setKoreanCues(cues);
    setUploadResult(null);
  }, []);

  const setThumbnail = useCallback((file: File | null) => {
    setThumbnailFile(file);
    setThumbnailUrl((previousUrl) => {
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      return file ? URL.createObjectURL(file) : null;
    });
    setUploadResult(null);
  }, []);

  const resetWorkspace = useCallback(() => {
    setVideoFile(null);
    setPreparedProductionVideoState(null);
    setVideoUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
    setSrtFile(null);
    setKoreanCues([]);
    setThumbnailFile(null);
    setThumbnailUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
    setContentKind("longform");
    setShortsBrief("");
    setKoreanTitle("");
    setKoreanDescription("");
    setKoreanTagsText("");
    setSuggestStatus("idle");
    setSuggestion(null);
    setSuggestError(null);
    setSubtitleJobs({});
    setMetadataJobs({});
    setLlmDebugLogs([]);
    setChapterStatus("idle");
    setChapterSuggestion(null);
    setChapterError(null);
    setUploadResult(null);
    setPreparedUploadRequest(null);

    // m28 — 영상 단위 옵션만 클리어. 프리셋 옵션(categoryId, 재생목록 등)은 그대로 유지
    // (사용자가 같은 시리즈 영상을 연속 업로드할 때 자연스러움).
    setPublishAt("");
    setRecordingDate("");
  }, []);

  const value = useMemo<UploadStoreValue>(
    () => ({
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
      suggestStatus,
      setSuggestStatus,
      suggestion,
      setSuggestion,
      suggestError,
      setSuggestError,
      subtitleJobs,
      setSubtitleJobs,
      metadataJobs,
      setMetadataJobs,
      llmDebugLogs,
      appendLlmDebug,
      clearLlmDebug,
      chapterStatus,
      setChapterStatus,
      chapterSuggestion,
      setChapterSuggestion,
      chapterError,
      setChapterError,
      privacyStatus,
      setPrivacyStatus,
      uploadResult,
      setUploadResult,
      preparedUploadRequest,
      setPreparedUploadRequest,
      resetWorkspace,
      // m28
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
    }),
    [
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
      shortsBrief,
      koreanTitle,
      koreanDescription,
      koreanTagsText,
      suggestStatus,
      suggestion,
      suggestError,
      subtitleJobs,
      metadataJobs,
      llmDebugLogs,
      appendLlmDebug,
      clearLlmDebug,
      chapterStatus,
      chapterSuggestion,
      chapterError,
      privacyStatus,
      uploadResult,
      preparedUploadRequest,
      resetWorkspace,
      categoryId,
      defaultAudioLanguage,
      playlistId,
      publishAt,
      recordingDate,
      madeForKids,
      containsSyntheticMedia,
      embeddable,
      publicStatsViewable,
      notifySubscribers,
      license,
      channelPlaylists,
      channelCategories,
      channelLanguages,
      presets,
      activePresetId,
      applyPresetDraft,
    ],
  );

  return (
    <UploadStoreContext.Provider value={value}>{children}</UploadStoreContext.Provider>
  );
}

export function useUploadStore(): UploadStoreValue {
  const ctx = useContext(UploadStoreContext);
  if (!ctx) {
    throw new Error("useUploadStore must be used within UploadStoreProvider");
  }
  return ctx;
}
