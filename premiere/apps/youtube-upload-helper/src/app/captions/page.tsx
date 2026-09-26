"use client";

import Link from "next/link";
import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState } from "react";

import type {
  CaptionMaintenanceRunRecord,
  YouTubeCaptionSnapshot,
} from "@/lib/caption-maintenance-store";

type Notice = { tone: "neutral" | "success" | "error"; text: string };

type ExistingVideoInfo = {
  id: string;
  title: string;
  channelTitle: string;
  privacyStatus: string;
  defaultLanguage: string;
  defaultAudioLanguage: string;
  url: string;
  studioUrl: string;
};

type InspectResult = {
  video: ExistingVideoInfo;
  captions: YouTubeCaptionSnapshot[];
  captionAuthority: {
    agentProjectSlug: string;
    revisionId: string;
    allowedManualLanguages: ["ko", "en"];
    lockedSha256: { ko: string; en: string };
  };
};

type MaintenanceLanguageOption = {
  code: "ko" | "en";
  label: string;
  nativeLabel: string;
  shortLabel: string;
  uploadFileName: string;
};

const MAINTENANCE_LANGUAGES: MaintenanceLanguageOption[] = [
  {
    code: "ko",
    label: "Korean",
    nativeLabel: "한국어",
    shortLabel: "KO",
    uploadFileName: "current locked clean Korean SRT",
  },
  {
    code: "en",
    label: "English",
    nativeLabel: "English",
    shortLabel: "EN",
    uploadFileName: "current locked reviewed English SRT",
  },
];

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function formatCaptionStatus(captions: YouTubeCaptionSnapshot[], code: string) {
  const matching = captions.filter(
    (caption) => caption.language.toLowerCase() === code.toLowerCase(),
  );
  const manual = matching.filter((caption) => caption.trackKind.toUpperCase() !== "ASR");
  const asr = matching.filter((caption) => caption.trackKind.toUpperCase() === "ASR");

  if (manual.length > 0) {
    const latest = manual
      .slice()
      .sort((a, b) => (b.lastUpdated ?? "").localeCompare(a.lastUpdated ?? ""))[0];
    return {
      tone: "ok" as const,
      label: manual.length > 1 ? `수동 ${manual.length}개` : "수동 있음",
      detail: `${latest.status}${latest.isDraft ? " · draft" : ""}`,
    };
  }

  if (asr.length > 0) {
    return {
      tone: "warn" as const,
      label: "자동 ASR만 있음",
      detail: "수동 SRT 추가 가능",
    };
  }

  return {
    tone: "empty" as const,
    label: "없음",
    detail: "추가 가능",
  };
}

function actionPreview(params: {
  captions: YouTubeCaptionSnapshot[];
  code: string;
  hasFile: boolean;
}) {
  const status = formatCaptionStatus(params.captions, params.code);
  if (!params.hasFile) return "파일 없음";
  return status.tone === "ok" ? "교체" : "추가";
}

function fileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function CaptionMaintenancePage() {
  const [videoInput, setVideoInput] = useState("");
  const [agentProjectSlug, setAgentProjectSlug] = useState("");
  const [inspectResult, setInspectResult] = useState<InspectResult | null>(null);
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [runs, setRuns] = useState<CaptionMaintenanceRunRecord[]>([]);
  const [lastRun, setLastRun] = useState<CaptionMaintenanceRunRecord | null>(null);

  const selectedFiles = useMemo(
    () => Object.entries(files).filter((entry): entry is [string, File] => Boolean(entry[1])),
    [files],
  );

  async function refreshRuns() {
    const response = await fetch("/api/captions/maintenance-runs", { cache: "no-store" });
    const payload = (await response.json()) as {
      ok: boolean;
      runs?: CaptionMaintenanceRunRecord[];
    };
    if (payload.ok && payload.runs) setRuns(payload.runs);
  }

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const response = await fetch("/api/captions/maintenance-runs", { cache: "no-store" });
      const payload = (await response.json()) as {
        ok: boolean;
        runs?: CaptionMaintenanceRunRecord[];
      };
      if (!cancelled && payload.ok && payload.runs) setRuns(payload.runs);
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  async function inspectVideo() {
    setNotice(null);
    setLastRun(null);

    if (!videoInput.trim() || !agentProjectSlug.trim()) {
      setNotice({
        tone: "error",
        text: "기존 영상 URL 또는 video ID와 해당 agent project slug를 모두 넣어야 합니다.",
      });
      return;
    }

    setInspecting(true);
    try {
      const response = await fetch(
        `/api/captions/maintenance?videoId=${encodeURIComponent(videoInput.trim())}&agentProjectSlug=${encodeURIComponent(agentProjectSlug.trim())}`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as
        | ({ ok: true } & InspectResult)
        | { ok: false; error: string };

      if (!response.ok || !payload.ok) {
        throw new Error("error" in payload ? payload.error : "자막 상태 조회 실패");
      }

      setInspectResult({
        video: payload.video,
        captions: payload.captions,
        captionAuthority: payload.captionAuthority,
      });
      setFiles({});
      setNotice({
        tone: "success",
        text: `기존 자막 ${payload.captions.length}개와 current revision ${payload.captionAuthority.revisionId}을 확인했습니다.`,
      });
    } catch (error) {
      setInspectResult(null);
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "자막 상태 조회 실패",
      });
    } finally {
      setInspecting(false);
    }
  }

  function handleFileChange(code: string, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setFiles((current) => ({ ...current, [code]: file }));
  }

  async function applyCaptions() {
    if (!inspectResult) {
      setNotice({ tone: "error", text: "먼저 기존 영상 자막 상태를 조회해야 합니다." });
      return;
    }

    if (selectedFiles.length === 0) {
      setNotice({
        tone: "error",
        text: "current lock과 일치하는 KO 또는 EN SRT 파일을 하나 이상 선택해야 합니다.",
      });
      return;
    }

    const formData = new FormData();
    formData.set("videoId", inspectResult.video.id);
    formData.set("agentProjectSlug", inspectResult.captionAuthority.agentProjectSlug);
    formData.set("expectedCaptionRevisionId", inspectResult.captionAuthority.revisionId);
    formData.set("mode", "replace_or_add");

    const tracks = selectedFiles.map(([code]) => {
      const option = MAINTENANCE_LANGUAGES.find((language) => language.code === code);
      return {
        id: code,
        language: code,
        label: option?.label ?? code,
      };
    });
    formData.set("captionTracks", JSON.stringify(tracks));

    const preconditions = [];
    for (const [code] of selectedFiles) {
      const manual = inspectResult.captions.filter(
        (caption) =>
          caption.language.toLowerCase() === code.toLowerCase() &&
          caption.trackKind.toUpperCase() !== "ASR",
      );
      if (manual.length > 1) {
        setNotice({
          tone: "error",
          text: `${code}: 수동 자막이 ${manual.length}개라 대상을 안전하게 특정할 수 없습니다.`,
        });
        return;
      }
      const current = manual[0];
      preconditions.push(
        current
          ? {
              language: code,
              expectedAction: "update",
              expectedCaptionId: current.id,
              expectedLastUpdated: current.lastUpdated,
            }
          : { language: code, expectedAction: "insert" },
      );
    }
    formData.set("captionPreconditions", JSON.stringify(preconditions));

    for (const [code, file] of selectedFiles) {
      formData.set(`captionFile:${code}`, file);
    }

    setApplying(true);
    setNotice(null);
    try {
      const response = await fetch("/api/captions/maintenance", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as
        | { ok: true; run: CaptionMaintenanceRunRecord }
        | { ok: false; error: string };

      if (!response.ok || !payload.ok) {
        throw new Error("error" in payload ? payload.error : "자막 적용 실패");
      }

      setLastRun(payload.run);
      setInspectResult((current) =>
        current ? { ...current, captions: payload.run.afterCaptions } : current,
      );
      setNotice({
        tone: payload.run.status === "done" ? "success" : "error",
        text:
          payload.run.status === "done"
            ? "기존 영상 자막 작업이 완료되었습니다. 재다운로드 본문 검증도 통과했습니다."
            : `자막 작업이 완료되지 않았습니다. 재조회 또는 검증이 필요합니다. 상태: ${payload.run.status}`,
      });
      await refreshRuns();
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "자막 적용 실패",
      });
    } finally {
      setApplying(false);
    }
  }

  async function handleMaintenanceRequest() {
    if (!inspectResult) {
      await inspectVideo();
      return;
    }

    await applyCaptions();
  }

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8 text-slate-950 sm:px-6 sm:py-10">
      <div className="mx-auto max-w-[1180px] space-y-6">
        <header className="rounded-3xl border border-slate-200 bg-white px-6 py-5 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-semibold text-emerald-700">
                유튜브 업로드 헬퍼
              </p>
              <h1 className="mt-1 text-2xl font-semibold leading-tight tracking-[-0.04em]">
                기존 영상 자막 관리
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                이미 올라간 영상의 한국어·영어 수동 SRT를 current caption revision 기준으로
                교체하거나 추가합니다. 다른 언어 자막은 YouTube 자동번역에 맡기며 이 화면에서
                쓰지 않습니다. 제목·설명 현지화 작업과는 별개입니다.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href="/"
                className="inline-flex h-10 items-center justify-center rounded-full border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-900 hover:bg-slate-50"
              >
                새 업로드 화면
              </Link>
              <Link
                href="/settings"
                className="inline-flex h-10 items-center justify-center rounded-full border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-900 hover:bg-slate-50"
              >
                설정
              </Link>
            </div>
          </div>
        </header>

        {notice ? (
          <div
            className={classNames(
              "rounded-2xl border px-4 py-3 text-sm font-medium",
              notice.tone === "success" &&
                "border-emerald-200 bg-emerald-50 text-emerald-900",
              notice.tone === "error" && "border-rose-200 bg-rose-50 text-rose-900",
              notice.tone === "neutral" && "border-slate-200 bg-white text-slate-700",
            )}
          >
            {notice.text}
          </div>
        ) : null}

        <section className="rounded-3xl border border-slate-200 bg-white p-6">
          <div className="grid gap-4 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
            <label className="block">
              <span className="text-sm font-semibold text-slate-900">
                기존 영상 URL 또는 video ID
              </span>
              <input
                value={videoInput}
                onChange={(event) => setVideoInput(event.target.value)}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm"
                placeholder="https://www.youtube.com/watch?v=..."
              />
            </label>
            <label className="block">
              <span className="text-sm font-semibold text-slate-900">Agent project slug</span>
              <input
                value={agentProjectSlug}
                onChange={(event) => setAgentProjectSlug(event.target.value)}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm"
                placeholder="higgsfield_app_builder_2026-07-16"
              />
            </label>
            <button
              type="button"
              onClick={() => void inspectVideo()}
              disabled={inspecting}
              className="inline-flex h-12 items-center justify-center rounded-full bg-slate-950 px-7 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {inspecting ? "조회 중..." : "자막 상태 조회"}
            </button>
          </div>

          <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-emerald-950">
                Current locked KO/EN 수동 자막만 교체 또는 추가
              </p>
              <p className="mt-1 text-xs leading-5 text-emerald-900">
                {inspectResult
                  ? `${inspectResult.captionAuthority.revisionId} · 선택된 SRT ${selectedFiles.length}개`
                  : "project slug와 videoId를 함께 확인한 뒤 current lock과 같은 파일만 쓸 수 있습니다."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleMaintenanceRequest()}
              disabled={inspecting || applying}
              className="inline-flex h-12 min-w-[190px] items-center justify-center rounded-full bg-slate-950 px-6 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {inspecting
                  ? "조회 중..."
                  : applying
                  ? "적용 중..."
                  : inspectResult
                    ? "선택한 KO/EN 검증 후 적용"
                    : "자막 상태와 revision 조회"}
            </button>
          </div>
        </section>

        {inspectResult ? (
          <section className="rounded-3xl border border-slate-200 bg-white p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-xs font-semibold text-emerald-700">조회된 영상</p>
                <h2 className="mt-1 text-xl font-semibold tracking-[-0.04em]">
                  {inspectResult.video.title}
                </h2>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-600">
                  <span className="rounded-full bg-slate-100 px-3 py-1">
                    {inspectResult.video.id}
                  </span>
                  <span className="rounded-full bg-slate-100 px-3 py-1">
                    {inspectResult.video.privacyStatus || "privacy unknown"}
                  </span>
                  <span className="rounded-full bg-slate-100 px-3 py-1">
                    자막 {inspectResult.captions.length}개
                  </span>
                </div>
              </div>
              <a
                href={inspectResult.video.studioUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center justify-center rounded-full border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-900 hover:bg-slate-50"
              >
                Studio 자막 탭
              </a>
            </div>

            <div className="mt-5 overflow-x-auto rounded-2xl border border-slate-200">
              <div className="min-w-[820px]">
                <div className="grid grid-cols-[88px_1fr_120px_120px_120px] gap-0 bg-slate-50 px-4 py-3 text-xs font-semibold text-slate-600">
                  <span>언어</span>
                  <span>파일</span>
                  <span>현재 상태</span>
                  <span>처리 예상</span>
                  <span>파일 크기</span>
                </div>
                <div className="divide-y divide-slate-100">
                  {MAINTENANCE_LANGUAGES.map((language) => {
                    const status = formatCaptionStatus(inspectResult.captions, language.code);
                    const file = files[language.code] ?? null;
                    const action = actionPreview({
                      captions: inspectResult.captions,
                      code: language.code,
                      hasFile: Boolean(file),
                    });

                    return (
                      <div
                        key={language.code}
                        className="grid grid-cols-[88px_1fr_120px_120px_120px] items-center gap-0 px-4 py-3 text-sm"
                      >
                        <div>
                          <p className="font-semibold text-slate-950">{language.shortLabel}</p>
                          <p className="text-[11px] leading-4 text-slate-500">
                            {language.code}
                          </p>
                        </div>
                        <div className="min-w-0 pr-4">
                          <label className="inline-flex h-9 cursor-pointer items-center rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-900 hover:bg-slate-50">
                            SRT 선택
                            <input
                              type="file"
                              accept=".srt"
                              className="hidden"
                              onChange={(event) => handleFileChange(language.code, event)}
                            />
                          </label>
                          {file ? (
                            <button
                              type="button"
                              onClick={() =>
                                setFiles((current) => ({ ...current, [language.code]: null }))
                              }
                              className="ml-2 text-xs font-semibold text-rose-700 hover:text-rose-900"
                            >
                              제거
                            </button>
                          ) : null}
                          <p className="mt-1 truncate text-xs text-slate-500">
                            {file ? file.name : language.uploadFileName}
                          </p>
                        </div>
                        <div>
                          <span
                            className={classNames(
                              "inline-flex rounded-full px-2.5 py-1 text-xs font-semibold",
                              status.tone === "ok" && "bg-emerald-100 text-emerald-900",
                              status.tone === "warn" && "bg-amber-100 text-amber-900",
                              status.tone === "empty" && "bg-slate-100 text-slate-600",
                            )}
                          >
                            {status.label}
                          </span>
                          <p className="mt-1 text-[11px] text-slate-500">{status.detail}</p>
                        </div>
                        <div>
                          <span
                            className={classNames(
                              "inline-flex rounded-full px-2.5 py-1 text-xs font-semibold",
                              action === "교체" && "bg-blue-100 text-blue-900",
                              action === "추가" && "bg-emerald-100 text-emerald-900",
                              action === "파일 없음" && "bg-slate-100 text-slate-500",
                            )}
                          >
                            {action}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500">
                          {file ? fileSize(file.size) : "—"}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-950">
                  선택된 SRT {selectedFiles.length}개
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-600">
                  ASR 자동자막과 비대상 수동 트랙은 보존합니다. 서버가 current lock 해시와
                  조회 snapshot을 다시 확인한 뒤에만 씁니다.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void applyCaptions()}
                disabled={applying}
                className="inline-flex h-12 items-center justify-center rounded-full bg-slate-950 px-7 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {applying ? "적용 및 재검증 중..." : "선택한 KO/EN 검증 후 적용"}
              </button>
            </div>
          </section>
        ) : null}

        {lastRun ? (
          <section className="rounded-3xl border border-emerald-200 bg-emerald-50 p-6">
            <p className="text-sm font-semibold text-emerald-950">
              방금 처리 결과
            </p>
            <p className="mt-1 break-all text-xs text-emerald-800">
              실행 ID: {lastRun.id}
            </p>
            <div className="mt-4 grid gap-2 md:grid-cols-2">
              {lastRun.operations.map((operation) => (
                <div key={operation.id} className="rounded-2xl bg-white px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold text-slate-950">
                      {operation.language} · {operation.label}
                    </span>
                    <span
                      className={classNames(
                        "rounded-full px-2.5 py-1 text-xs font-semibold",
                        operation.status === "pending" && "bg-amber-100 text-amber-900",
                        operation.status === "done" && "bg-emerald-100 text-emerald-900",
                        operation.status === "skipped" && "bg-slate-100 text-slate-600",
                        operation.status === "verification_pending" &&
                          "bg-amber-100 text-amber-900",
                        operation.status === "error" && "bg-rose-100 text-rose-900",
                      )}
                    >
                      {operation.action === "request" ? "요청" : operation.action} ·{" "}
                      {operation.status === "pending" ? "대기" : operation.status}
                    </span>
                  </div>
                  {operation.error ? (
                    <p className="mt-2 text-xs leading-5 text-rose-700">{operation.error}</p>
                  ) : null}
                </div>
              ))}
            </div>
            {lastRun.warnings.length > 0 ? (
              <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-900">
                {lastRun.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        <details className="rounded-3xl border border-slate-200 bg-white p-6">
          <summary className="cursor-pointer text-lg font-semibold tracking-[-0.04em] text-slate-950">
            최근 기존 영상 자막 작업
          </summary>
          <div className="mt-4 space-y-3">
            {runs.length === 0 ? (
              <p className="text-sm text-slate-500">아직 기록이 없습니다.</p>
            ) : (
              runs.map((run) => (
                <div
                  key={run.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">
                        {run.videoTitle || run.videoId}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {run.mode === "replace_or_add"
                          ? "KO/EN 교체·추가"
                          : "이전 missing-only 기록"}{" "}
                        · {run.operations.length}개 · {run.status}
                      </p>
                    </div>
                    <a
                      href={run.studioUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-semibold text-emerald-700 hover:text-emerald-900"
                    >
                      Studio 확인
                    </a>
                  </div>
                </div>
              ))
            )}
          </div>
        </details>
      </div>
    </main>
  );
}
