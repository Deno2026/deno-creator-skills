"use client";

import { useEffect } from "react";

export function OAuthCompletionAutoClose({ connected }: { connected: boolean }) {
  useEffect(() => {
    if (!connected) return;

    const closeTimer = window.setTimeout(() => {
      window.close();
    }, 700);
    const fallbackTimer = window.setTimeout(() => {
      window.location.replace("/settings?oauth=connected");
    }, 1400);

    return () => {
      window.clearTimeout(closeTimer);
      window.clearTimeout(fallbackTimer);
    };
  }, [connected]);

  if (!connected) return null;

  return (
    <p className="mt-3 text-sm leading-6 text-slate-500" aria-live="polite">
      인증 완료 탭을 자동으로 닫는 중입니다. 브라우저가 닫기를 막으면 설정 화면으로
      자동 복귀합니다.
    </p>
  );
}
