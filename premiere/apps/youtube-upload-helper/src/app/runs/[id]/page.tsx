import Link from "next/link";
import { notFound } from "next/navigation";

import { buildPostUploadAudit } from "@/lib/upload-run-audit";
import { loadUploadRun, type UploadRunRecord } from "@/lib/upload-run-store";

export const runtime = "nodejs";

type PageProps = {
  params: Promise<{ id: string }>;
};

function statusClass(status: string) {
  if (status === "done") return "border-emerald-200 bg-emerald-50 text-emerald-900";
  if (status === "partial") return "border-amber-200 bg-amber-50 text-amber-900";
  if (status === "error") return "border-rose-200 bg-rose-50 text-rose-900";
  if (status === "skipped") return "border-slate-200 bg-slate-50 text-slate-600";
  return "border-slate-200 bg-white text-slate-800";
}

function statusText(status: string) {
  if (status === "done") return "완료";
  if (status === "partial") return "부분 완료";
  if (status === "error") return "실패";
  if (status === "skipped") return "건너뜀";
  if (status === "running") return "진행 중";
  if (status === "pending") return "대기";
  return status;
}

function formatDate(value: string | undefined) {
  if (!value) return "없음";
  return new Date(value).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex h-7 items-center rounded-full border px-2.5 text-xs font-semibold ${statusClass(status)}`}>
      {statusText(status)}
    </span>
  );
}

function InfoRow({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4 border-b border-slate-100 py-2 last:border-b-0">
      <dt className="shrink-0 text-xs font-semibold text-slate-500">{label}</dt>
      <dd className="min-w-0 break-words text-right text-sm font-medium text-slate-900">
        {value && value.trim() ? value : "없음"}
      </dd>
    </div>
  );
}

function StepList({ run }: { run: UploadRunRecord }) {
  return (
    <div className="grid gap-2">
      {run.steps.map((step) => (
        <div
          key={step.key}
          className="flex items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3"
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900">{step.label}</p>
            {step.error ? (
              <p className="mt-1 break-words text-xs text-rose-700">{step.error}</p>
            ) : null}
          </div>
          <StatusPill status={step.status} />
        </div>
      ))}
    </div>
  );
}

export default async function UploadRunResultPage({ params }: PageProps) {
  const { id } = await params;
  const run = await loadUploadRun(decodeURIComponent(id));

  if (!run) notFound();

  const audit = buildPostUploadAudit(run);
  const doneCaptions = run.captions.filter((caption) => caption.status === "done").length;

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8 text-slate-950 sm:px-6 sm:py-10">
      <div className="mx-auto max-w-[1040px] space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-normal text-slate-500">
              Upload Result
            </p>
            <h1 className="mt-1 break-words text-2xl font-semibold leading-tight">
              업로드 결과 확인
            </h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/"
              className="inline-flex h-10 items-center justify-center rounded-full border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-900 hover:bg-slate-50"
            >
              작업대로 돌아가기
            </Link>
            {run.studioUrl ? (
              <a
                href={run.studioUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center justify-center rounded-full border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-900 hover:bg-slate-50"
              >
                Studio 열기
              </a>
            ) : null}
          </div>
        </div>

        <section className="rounded-3xl border border-slate-200 bg-white p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={run.status} />
                <span className="inline-flex h-7 items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 text-xs font-semibold text-slate-700">
                  {run.effectivePrivacyStatus ?? run.requestedPrivacyStatus}
                </span>
              </div>
              <h2 className="mt-3 break-words text-xl font-semibold text-slate-950">
                {run.title || run.videoFileName}
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                앱이 업로드하면서 남긴 실행 기록 기준입니다. 수익 창출과 광고 적합성은
                YouTube Studio에서 직접 확인해야 합니다.
              </p>
            </div>
            <div className="grid min-w-[220px] gap-2 rounded-2xl bg-slate-50 p-4 text-sm">
              <InfoRow label="Run ID" value={run.id} />
              <InfoRow label="Video ID" value={run.videoId} />
              <InfoRow label="생성" value={formatDate(run.createdAt)} />
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            {run.url ? (
              <a
                href={run.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-900 hover:bg-slate-50"
              >
                YouTube 보기
              </a>
            ) : null}
            {run.studioUrl ? (
              <a
                href={run.studioUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-900 hover:bg-slate-50"
              >
                Studio 편집 화면
              </a>
            ) : null}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <p className="text-sm font-semibold text-slate-900">실행 단계</p>
            <div className="mt-4">
              <StepList run={run} />
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <p className="text-sm font-semibold text-slate-900">적용 요약</p>
            <dl className="mt-4 rounded-2xl bg-slate-50 p-4">
              <InfoRow label="영상 파일" value={run.videoFileName} />
              <InfoRow label="요청 공개" value={run.requestedPrivacyStatus} />
              <InfoRow label="실제 공개" value={run.effectivePrivacyStatus} />
              <InfoRow label="예약" value={formatDate(run.publishAt)} />
              <InfoRow label="현지화" value={`${run.localizations.length}개`} />
              <InfoRow label="자막" value={`${doneCaptions}/${run.captions.length}개 완료`} />
              <InfoRow label="재생목록" value={run.playlistId} />
            </dl>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-900">자막 / 다국어 메타</p>
              <p className="mt-1 text-xs text-slate-500">
                자막 파일별 업로드 결과와 제목/설명 현지화 언어입니다.
              </p>
            </div>
            <span className="text-xs font-semibold text-slate-500">
              {audit.generatedAt}
            </span>
          </div>

          <div className="mt-4 grid gap-2">
            {run.captions.length === 0 ? (
              <p className="rounded-2xl bg-slate-50 px-4 py-5 text-center text-sm text-slate-500">
                첨부된 자막이 없습니다.
              </p>
            ) : (
              run.captions.map((caption) => (
                <div
                  key={caption.id}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900">
                      {caption.language} · {caption.label}
                    </p>
                    <p className="mt-1 break-words text-xs text-slate-500">
                      {caption.fileName}
                    </p>
                    {caption.error ? (
                      <p className="mt-1 break-words text-xs text-rose-700">
                        {caption.error}
                      </p>
                    ) : null}
                  </div>
                  <StatusPill status={caption.status} />
                </div>
              ))
            )}
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {run.localizations.length > 0 ? (
              run.localizations.map((language) => (
                <span
                  key={language}
                  className="inline-flex h-8 items-center rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700"
                >
                  {language}
                </span>
              ))
            ) : (
              <span className="text-xs text-slate-500">현지화 메타 없음</span>
            )}
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <p className="text-sm font-semibold text-slate-900">주의 / 실패 항목</p>
            <div className="mt-3 space-y-2">
              {run.warnings.length === 0 && !run.error ? (
                <p className="rounded-2xl bg-emerald-50 px-4 py-4 text-sm text-emerald-900">
                  앱 기록상 실패 경고가 없습니다.
                </p>
              ) : (
                <>
                  {run.error ? (
                    <p className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800">
                      {run.error}
                    </p>
                  ) : null}
                  {run.warnings.map((warning) => (
                    <p
                      key={warning}
                      className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900"
                    >
                      {warning}
                    </p>
                  ))}
                </>
              )}
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <p className="text-sm font-semibold text-slate-900">Studio에서 직접 확인</p>
            <div className="mt-3 space-y-2">
              {audit.manualChecks.map((item) => (
                <p
                  key={item}
                  className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700"
                >
                  {item}
                </p>
              ))}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
