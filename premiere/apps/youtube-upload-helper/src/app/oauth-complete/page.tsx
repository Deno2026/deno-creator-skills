import Link from "next/link";
import { UPLOAD_CHANNELS } from "@deno/runtime-paths";

import { OAuthCompletionAutoClose } from "./oauth-completion-auto-close";

type OAuthCompletePageProps = {
  searchParams?: Promise<{
    status?: string;
    reason?: string;
    channel?: string;
    expected?: string;
    actual?: string;
  }>;
};

const CHANNEL_LABELS: Record<string, string> = Object.fromEntries(
  UPLOAD_CHANNELS.map((channel) => [channel.id, channel.handle ? `${channel.title} (${channel.handle})` : channel.title]),
);

function normalizeReason(reason?: string, expected?: string, actual?: string) {
  if (!reason) {
    return "알 수 없는 문제입니다.";
  }

  if (reason === "channel_mismatch") {
    return `Google 화면에서 ${actual ?? "다른 채널"}을(를) 골랐습니다. 연결하려는 채널은 ${expected ?? "선택한 채널"}입니다. 다시 연결하면서 계정 선택 화면에서 ${expected ?? "해당 채널"}을(를) 골라 주세요. 토큰은 저장하지 않았습니다.`;
  }

  if (reason === "oauth_state_mismatch") {
    return "연결 요청이 만료됐거나 다른 창에서 시작됐습니다. 앱에서 연결 버튼을 다시 눌러 주세요.";
  }

  if (reason === "access_denied") {
    return "Google 승인 화면에서 접근 허용이 취소되었습니다. 테스트 사용자 등록 여부를 먼저 확인해 주세요.";
  }

  if (reason === "missing_code") {
    return "인증 코드가 전달되지 않았습니다. 다시 시도해 주세요.";
  }

  return reason;
}

export default async function OAuthCompletePage({
  searchParams,
}: OAuthCompletePageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const connected = resolvedSearchParams?.status === "connected";
  const reason = normalizeReason(
    resolvedSearchParams?.reason,
    resolvedSearchParams?.expected,
    resolvedSearchParams?.actual,
  );
  const channelLabel = resolvedSearchParams?.channel
    ? CHANNEL_LABELS[resolvedSearchParams.channel]
    : undefined;

  return (
    <main className="min-h-screen bg-slate-100 px-6 py-10 text-slate-950">
      <div className="mx-auto max-w-[720px] rounded-[28px] border border-slate-200 bg-white px-7 py-8 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
        <p className="text-xs font-semibold uppercase tracking-normal text-slate-500">
          Deno YouTube Upload Helper
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-normal text-slate-950">
          {connected
            ? `${channelLabel ?? "Google"} 연결이 완료되었습니다`
            : `${channelLabel ?? "Google"} 연결을 마치지 못했습니다`}
        </h1>
        <p className="mt-4 text-base leading-7 text-slate-600">
          {connected
            ? "Deno YouTube Upload Helper가 연결 상태를 자동으로 다시 확인합니다."
            : "이 창을 닫고 Deno YouTube Upload Helper 앱으로 돌아가 설정을 다시 확인한 뒤, 다시 연결해 주세요."}
        </p>
        <OAuthCompletionAutoClose connected={connected} />

        {connected ? (
          <div className="mt-6 rounded-[22px] border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm leading-6 text-emerald-900">
            연결 정보가 정상적으로 저장되면 앱 화면에서 자동으로 다음 단계로 넘어가거나,
            연결 완료 안내가 표시됩니다.
          </div>
        ) : (
          <div className="mt-6 rounded-[22px] border border-rose-200 bg-rose-50 px-4 py-4 text-sm leading-6 text-rose-900">
            실패 이유: {reason}
          </div>
        )}

        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/"
            className="inline-flex min-h-[48px] items-center justify-center rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white"
          >
            앱 홈 화면 열기
          </Link>
        </div>
      </div>
    </main>
  );
}
