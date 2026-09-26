import { writeUploadRunTextArtifact, type UploadRunRecord } from "@/lib/upload-run-store";

export type PostUploadAudit = {
  generatedAt: string;
  runId: string;
  source: "upload-run-manifest";
  video: {
    id?: string;
    title: string;
    fileName: string;
    url?: string;
    studioUrl?: string;
  };
  privacy: {
    requested: string;
    effective?: string;
    publishAt?: string;
  };
  thumbnail: {
    status: string;
    fileName?: string;
    error?: string;
  };
  captions: Array<{
    language: string;
    label: string;
    fileName: string;
    status: string;
    error?: string;
  }>;
  localizations: string[];
  playlist: {
    playlistId?: string;
    status: string;
    error?: string;
  };
  steps: Array<{
    label: string;
    status: string;
    error?: string;
  }>;
  warnings: string[];
  manualChecks: string[];
};

export function buildPostUploadAudit(record: UploadRunRecord): PostUploadAudit {
  return {
    generatedAt: new Date().toISOString(),
    runId: record.id,
    source: "upload-run-manifest",
    video: {
      id: record.videoId,
      title: record.title,
      fileName: record.videoFileName,
      url: record.url,
      studioUrl: record.studioUrl,
    },
    privacy: {
      requested: record.requestedPrivacyStatus,
      effective: record.effectivePrivacyStatus,
      publishAt: record.publishAt,
    },
    thumbnail: {
      status: record.thumbnail.status,
      fileName: record.thumbnail.fileName,
      error: record.thumbnail.error,
    },
    captions: record.captions.map((caption) => ({
      language: caption.language,
      label: caption.label,
      fileName: caption.fileName,
      status: caption.status,
      error: caption.error,
    })),
    localizations: record.localizations,
    playlist: {
      playlistId: record.playlistId,
      status: record.playlist.status,
      error: record.playlist.error,
    },
    steps: record.steps.map((step) => ({
      label: step.label,
      status: step.status,
      error: step.error,
    })),
    warnings: record.warnings,
    manualChecks: [
      "YouTube Studio의 수익 창출 / 광고 적합성 항목은 업로드 후 Studio에서 직접 확인합니다.",
      "공개 예약, 최종 썸네일 반영, 자막 자동 처리 상태는 Studio 화면에서 한 번 더 확인합니다.",
    ],
  };
}

function statusLabel(status: string) {
  if (status === "done") return "완료";
  if (status === "partial") return "부분 완료";
  if (status === "error") return "실패";
  if (status === "skipped") return "건너뜀";
  if (status === "running") return "진행 중";
  return status;
}

function listLine(label: string, value: string | undefined) {
  return `- ${label}: ${value && value.trim() ? value : "없음"}`;
}

export function formatPostUploadReport(audit: PostUploadAudit) {
  const captionLines =
    audit.captions.length > 0
      ? audit.captions
          .map(
            (caption) =>
              `- ${caption.language} / ${caption.label}: ${statusLabel(caption.status)} (${caption.fileName})${
                caption.error ? ` - ${caption.error}` : ""
              }`,
          )
          .join("\n")
      : "- 자막 없음";

  const stepLines = audit.steps
    .map(
      (step) =>
        `- ${step.label}: ${statusLabel(step.status)}${step.error ? ` - ${step.error}` : ""}`,
    )
    .join("\n");

  return [
    `# Post Upload Report`,
    "",
    `Generated: ${audit.generatedAt}`,
    `Run ID: ${audit.runId}`,
    "",
    "## Video",
    listLine("Title", audit.video.title),
    listLine("Video ID", audit.video.id),
    listLine("YouTube URL", audit.video.url),
    listLine("Studio URL", audit.video.studioUrl),
    listLine("Source file", audit.video.fileName),
    "",
    "## Privacy",
    listLine("Requested", audit.privacy.requested),
    listLine("Effective", audit.privacy.effective),
    listLine("Publish at", audit.privacy.publishAt),
    "",
    "## Thumbnail",
    listLine("Status", statusLabel(audit.thumbnail.status)),
    listLine("File", audit.thumbnail.fileName),
    listLine("Error", audit.thumbnail.error),
    "",
    "## Captions",
    captionLines,
    "",
    "## Localizations",
    audit.localizations.length > 0 ? audit.localizations.map((item) => `- ${item}`).join("\n") : "- 없음",
    "",
    "## Playlist",
    listLine("Playlist ID", audit.playlist.playlistId),
    listLine("Status", statusLabel(audit.playlist.status)),
    listLine("Error", audit.playlist.error),
    "",
    "## Steps",
    stepLines,
    "",
    "## Warnings",
    audit.warnings.length > 0 ? audit.warnings.map((item) => `- ${item}`).join("\n") : "- 없음",
    "",
    "## Manual Studio Checks",
    audit.manualChecks.map((item) => `- ${item}`).join("\n"),
    "",
  ].join("\n");
}

export async function writePostUploadAuditArtifacts(record: UploadRunRecord) {
  const audit = buildPostUploadAudit(record);
  await writeUploadRunTextArtifact(
    record.id,
    "post_upload_audit.json",
    JSON.stringify(audit, null, 2),
  );
  await writeUploadRunTextArtifact(
    record.id,
    "post_upload_report.md",
    formatPostUploadReport(audit),
  );
  return audit;
}
