"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";

type NoticeTone = "neutral" | "success" | "error";
type Notice = { tone: NoticeTone; text: string };

type UploadChannelRow = {
  id: string;
  title: string;
  handle: string;
  youtubeChannelId: string;
  active?: boolean;
};

type AuthStatus = {
  connected: boolean;
  channelTitle?: string;
  channelId?: string;
  error?: string;
  uploadChannel?: UploadChannelRow;
  configured?: boolean;
  redirectUri?: string;
  settings?: {
    clientId?: string;
    redirectUri?: string;
  };
  tokenPersistence?: {
    hasToken: boolean;
    hasRefreshToken: boolean;
    refreshTokenTimeLimited: boolean;
    refreshTokenExpiresAt?: string;
  };
};

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export default function SettingsPage() {
  // auth는 공용 OAuth 설정 확인용(선택 채널 기준), 채널별 연결 상태는 statusByChannel.
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [channels, setChannels] = useState<UploadChannelRow[]>([]);
  const [statusByChannel, setStatusByChannel] = useState<Record<string, AuthStatus>>({});
  const [waitingChannelId, setWaitingChannelId] = useState<string | null>(null);
  const [oauthForm, setOauthForm] = useState({
    clientId: "",
    clientSecret: "",
    redirectUri: "http://localhost:3000/api/oauth/callback",
  });
  const [savingOAuth, setSavingOAuth] = useState(false);
  const [waitingForOAuth, setWaitingForOAuth] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const oauthPollTimerRef = useRef<number | null>(null);
  const oauthPollDeadlineRef = useRef<number | null>(null);
  const oauthPollActiveRef = useRef(false);

  useEffect(() => {
    let active = true;

    void (async () => {
      const data = await refreshAuthStatus();
      if (!active || !data) return;
      setAuth(data);
    })();

    return () => {
      active = false;
      stopOAuthPolling();
    };
  }, []);

  async function refreshChannelStatus(channelId: string) {
    try {
      const response = await fetch(`/api/auth/status?channel=${encodeURIComponent(channelId)}`, {
        cache: "no-store",
      });
      const data = (await response.json()) as AuthStatus;
      setStatusByChannel((current) => ({ ...current, [channelId]: data }));
      return data;
    } catch {
      return null;
    }
  }

  async function refreshAuthStatus() {
    try {
      const response = await fetch("/api/auth/status", { cache: "no-store" });
      const data = (await response.json()) as AuthStatus;
      setAuth(data);
      setOauthForm((current) => ({
        clientId: current.clientId || data.settings?.clientId || "",
        clientSecret: current.clientSecret,
        redirectUri: data.settings?.redirectUri || current.redirectUri,
      }));
      const listResponse = await fetch("/api/channels", { cache: "no-store" });
      const list = (await listResponse.json()) as { channels?: UploadChannelRow[] };
      if (Array.isArray(list.channels)) {
        setChannels(list.channels);
        await Promise.all(list.channels.map((channel) => refreshChannelStatus(channel.id)));
      }
      return data;
    } catch {
      return null;
    }
  }

  function stopOAuthPolling() {
    oauthPollActiveRef.current = false;
    setWaitingForOAuth(false);
    setWaitingChannelId(null);
    if (oauthPollTimerRef.current) {
      window.clearTimeout(oauthPollTimerRef.current);
      oauthPollTimerRef.current = null;
    }
    if (oauthPollDeadlineRef.current) {
      window.clearTimeout(oauthPollDeadlineRef.current);
      oauthPollDeadlineRef.current = null;
    }
  }

  function startOAuthPolling(channel: UploadChannelRow) {
    stopOAuthPolling();
    oauthPollActiveRef.current = true;
    setWaitingForOAuth(true);
    setWaitingChannelId(channel.id);
    setNotice({
      tone: "neutral",
      text: `${channel.title} 승인 완료를 기다리는 중입니다. Google 계정 선택 화면에서 ${channel.title}(${channel.handle})을(를) 골라 주세요.`,
    });

    const poll = async () => {
      if (!oauthPollActiveRef.current) return;

      const data = await refreshChannelStatus(channel.id);
      if (data?.connected) {
        stopOAuthPolling();
        await refreshAuthStatus();
        setNotice({ tone: "success", text: `${channel.title} 연결이 완료되었습니다.` });
        return;
      }

      oauthPollTimerRef.current = window.setTimeout(() => {
        void poll();
      }, 1500);
    };

    oauthPollDeadlineRef.current = window.setTimeout(() => {
      if (!oauthPollActiveRef.current) return;
      stopOAuthPolling();
      setNotice({
        tone: "error",
        text: "승인 완료를 확인하지 못했습니다. Google 승인 창을 확인해 주세요.",
      });
    }, 120_000);

    void poll();
  }

  function handleOAuthFormChange(
    key: "clientId" | "clientSecret" | "redirectUri",
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const value = event.target.value;
    setOauthForm((current) => ({ ...current, [key]: value }));
  }

  async function saveOAuthSettings() {
    setSavingOAuth(true);
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(oauthForm),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || "연결 정보 저장에 실패했습니다.");
      }
      await refreshAuthStatus();
      setNotice({
        tone: "success",
        text: "YouTube 연결 정보를 저장했습니다.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "연결 정보 저장에 실패했습니다.",
      });
    } finally {
      setSavingOAuth(false);
    }
  }

  async function startOAuthConnect(channel: UploadChannelRow) {
    try {
      const response = await fetch(`/api/auth/url?channel=${encodeURIComponent(channel.id)}`, {
        cache: "no-store",
      });
      const data = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !data.url) {
        throw new Error(data.error || "Google 연결 링크를 만들지 못했습니다.");
      }
      const popup = window.open(data.url, "_blank", "noopener,noreferrer");
      if (!popup) {
        throw new Error("브라우저를 열지 못했습니다. 팝업 차단을 확인해 주세요.");
      }
      startOAuthPolling(channel);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Google 연결을 시작하지 못했습니다.",
      });
    }
  }

  async function disconnectOAuth(channel: UploadChannelRow) {
    if (!confirm(`${channel.title}(${channel.handle}) 연결을 해제합니다. 다른 채널 연결은 그대로 둡니다. 진행하시겠습니까?`)) {
      return;
    }
    try {
      const response = await fetch(`/api/auth/disconnect?channel=${encodeURIComponent(channel.id)}`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error("연결 해제에 실패했습니다.");
      }
      await refreshAuthStatus();
      setNotice({ tone: "success", text: `${channel.title} 연결을 해제했습니다.` });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "연결 해제에 실패했습니다.",
      });
    }
  }

  const configured = Boolean(auth?.configured);
  const connectedCount = channels.filter((channel) => statusByChannel[channel.id]?.connected).length;

  return (
    <main className="min-h-screen bg-slate-100 px-6 py-10 text-slate-950">
      <div className="mx-auto max-w-[920px] space-y-6">
        <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <Link
            href="/"
            className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 hover:text-slate-700"
          >
            ← 작업판으로 돌아가기
          </Link>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em]">
            유튜브 업로드 헬퍼 설정
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            이 화면은 에이전트가 같이 보는 작업판의 연결 상태만 관리합니다.
            제목 추천, 번역, 자막 제작은 앱 안의 모델 설정이 아니라 Codex 같은 에이전트가 맡습니다.
          </p>
        </header>

        {notice ? <NoticeBanner notice={notice} /> : null}

        <section className="grid gap-3 md:grid-cols-3">
          <PrincipleCard title="작업판" body="사용자와 에이전트가 같은 입력값과 상태를 봅니다." />
          <PrincipleCard title="에이전트 처리" body="자막, 제목, 설명, 다국어는 대화 세션에서 진행합니다." />
          <PrincipleCard title="YouTube 연결" body="최종 업로드 권한만 이 화면에서 확인합니다." />
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_18px_40px_rgba(15,23,42,0.04)]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold tracking-[-0.04em]">YouTube 연결</h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Codex가 업로드를 실행할 때 사용할 읽기/업로드 권한입니다. 채널마다 따로 승인하며,
                같은 Google 로그인 아래 채널은 승인 화면의 계정 선택에서 고릅니다.
              </p>
            </div>
            <span
              className={classNames(
                "inline-flex h-9 shrink-0 items-center rounded-full px-3 text-xs font-semibold",
                configured && channels.length > 0 && connectedCount === channels.length
                  ? "bg-emerald-100 text-emerald-900"
                  : configured
                    ? "bg-amber-100 text-amber-900"
                    : "bg-rose-100 text-rose-900",
              )}
            >
              {configured ? `${connectedCount}/${channels.length || 1} 채널 연결됨` : "설정 필요"}
            </span>
          </div>

          <div className="mt-5 space-y-3">
            {channels.map((channel) => (
              <ChannelConnectionRow
                key={channel.id}
                channel={channel}
                status={statusByChannel[channel.id]}
                configured={configured}
                waiting={waitingForOAuth && waitingChannelId === channel.id}
                busy={waitingForOAuth}
                onConnect={() => void startOAuthConnect(channel)}
                onDisconnect={() => void disconnectOAuth(channel)}
              />
            ))}
          </div>

          <details className="mt-5 rounded-2xl border border-slate-200 bg-white p-4" open={!configured}>
            <summary className="cursor-pointer text-sm font-semibold text-slate-900">
              Google 연결 정보
              <span className="ml-2 text-xs font-normal text-slate-500">
                보통은 한 번만 설정합니다
              </span>
            </summary>

            <div className="mt-5 space-y-4">
              <FieldRow label="Google Client ID">
                <input
                  name="deno-google-oauth-client-id"
                  autoComplete="off"
                  value={oauthForm.clientId}
                  onChange={(event) => handleOAuthFormChange("clientId", event)}
                  placeholder="Google Cloud에서 발급한 Client ID"
                  className={inputClass}
                />
              </FieldRow>
              <FieldRow label="Google Client Secret">
                <input
                  name="deno-google-oauth-client-secret"
                  autoComplete="new-password"
                  type="password"
                  value={oauthForm.clientSecret}
                  onChange={(event) => handleOAuthFormChange("clientSecret", event)}
                  placeholder="Client ID와 함께 발급되는 비밀값"
                  className={inputClass}
                />
              </FieldRow>
              <FieldRow label="Redirect URI">
                <input
                  name="deno-google-oauth-redirect-uri"
                  autoComplete="off"
                  value={oauthForm.redirectUri}
                  onChange={(event) => handleOAuthFormChange("redirectUri", event)}
                  placeholder="http://localhost:3000/api/oauth/callback"
                  className={inputClass}
                />
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  특별한 이유가 없으면 기본값 그대로 둡니다.
                </p>
              </FieldRow>
            </div>
          </details>

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void saveOAuthSettings()}
              disabled={savingOAuth}
              className={primaryButtonClass}
            >
              {savingOAuth ? "저장 중..." : "연결 정보 저장"}
            </button>
          </div>
        </section>

        <p className="text-center text-xs leading-5 text-slate-500">
          인증 정보와 요청 패키지는 이 PC의 로컬 저장소에만 보관됩니다.
        </p>
      </div>
    </main>
  );
}

function ChannelConnectionRow({
  channel,
  status,
  configured,
  waiting,
  busy,
  onConnect,
  onDisconnect,
}: {
  channel: UploadChannelRow;
  status?: AuthStatus;
  configured: boolean;
  waiting: boolean;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const connected = Boolean(status?.connected);
  const hasToken = Boolean(status?.tokenPersistence?.hasToken);
  const expiresAt = status?.tokenPersistence?.refreshTokenExpiresAt
    ? new Date(status.tokenPersistence.refreshTokenExpiresAt).toLocaleString("ko-KR")
    : null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">
            {channel.title}
            <span className="ml-2 text-xs font-normal text-slate-500">{channel.handle}</span>
            {channel.active ? (
              <span className="ml-2 rounded-full bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-white">
                작업판 선택
              </span>
            ) : null}
          </p>
          <p className="mt-1 text-sm leading-6 text-slate-700">
            {connected
              ? `${status?.channelTitle ?? channel.title}에 연결되어 있습니다 (${status?.channelId ?? channel.youtubeChannelId}).`
              : status?.error
                ? status.error
                : hasToken
                  ? "연결 상태를 확인하는 중입니다."
                  : configured
                    ? "아직 연결되지 않았습니다. Google 승인을 시작해 주세요."
                    : "먼저 아래 Google 연결 정보를 저장해 주세요."}
          </p>
          {status?.tokenPersistence?.refreshTokenTimeLimited ? (
            <p className="mt-2 text-xs leading-5 text-amber-900">
              Google이 7일 제한 토큰으로 발급했습니다{expiresAt ? ` (예상 만료: ${expiresAt})` : ""}. OAuth 앱을
              프로덕션으로 게시한 뒤 다시 승인하면 장기 연결이 됩니다.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={onConnect}
            disabled={busy || !configured}
            className={secondaryButtonClass}
          >
            {waiting ? "승인 대기 중..." : connected ? "다시 승인" : "Google 승인 시작"}
          </button>
          {hasToken ? (
            <button
              type="button"
              onClick={onDisconnect}
              disabled={busy}
              className="inline-flex h-11 items-center justify-center rounded-full border border-rose-200 bg-white px-5 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              연결 해제
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function NoticeBanner({ notice }: { notice: Notice }) {
  return (
    <div
      className={classNames(
        "rounded-2xl border px-4 py-3 text-sm",
        notice.tone === "success" && "border-emerald-200 bg-emerald-50 text-emerald-900",
        notice.tone === "error" && "border-rose-200 bg-rose-50 text-rose-900",
        notice.tone === "neutral" && "border-slate-200 bg-white text-slate-700",
      )}
    >
      {notice.text}
    </div>
  );
}

function PrincipleCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-semibold text-slate-950">{title}</p>
      <p className="mt-1 text-xs leading-5 text-slate-600">{body}</p>
    </div>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-900">{label}</span>
      <div className="mt-2">{children}</div>
    </label>
  );
}

const inputClass =
  "w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-950 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200";

const primaryButtonClass =
  "inline-flex h-11 items-center justify-center rounded-full bg-slate-950 px-5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60";

const secondaryButtonClass =
  "inline-flex h-11 items-center justify-center rounded-full border border-slate-200 bg-white px-5 text-sm font-semibold text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60";
