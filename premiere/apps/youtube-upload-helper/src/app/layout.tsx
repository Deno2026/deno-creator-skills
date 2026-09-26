import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

import { UploadStoreProvider } from "@/lib/upload-store";

export const metadata: Metadata = {
  title: "Deno YouTube Upload Helper",
  description: "Local-first YouTube upload helper",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {/* 메인 업로드 화면의 작업 상태(영상·자막·번역 결과·메타)를 layout 레벨에서 보관.
            사용자가 [설정] 다녀와도 페이지 컴포넌트 unmount로 인한 손실 없음. */}
        <UploadStoreProvider>{children}</UploadStoreProvider>
      </body>
    </html>
  );
}
