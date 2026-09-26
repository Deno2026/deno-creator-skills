"use strict";

const { localTime } = require("./publish_manifest.cjs");
const NAMES = { youtube: "유튜브", instagram: "인스타", threads: "스레드", x: "X", tiktok: "틱톡" };
function cell(value, max = Infinity) { return Array.from(String(value ?? "")).slice(0, max).join("").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " "); }
function approvalTable(manifest, state) {
  const rows = ["| 플랫폼 | 제목·캡션(앞 60자) | 공개 시각 | 방식 | 준비 |", "|---|---|---|---|---|"];
  for (const name of manifest.targets) {
    const text = name === "youtube" ? manifest.youtube.title : manifest[name].caption ?? manifest[name].text;
    const when = name === "youtube" && manifest.youtube.privacy !== "scheduled"
      ? ({ public: "실행 즉시 공개", unlisted: "일부 공개 유지", private: "비공개 유지" })[manifest.youtube.privacy] : state.publishAtLocal;
    const method = { youtube: manifest.youtube?.privacy === "scheduled" ? "API 예약" : "API 업로드", instagram: "API + Windows 예약", threads: "API + Windows 예약", x: "유료 API + Windows 예약", tiktok: "크롬 웹 예약" }[name];
    const ready = name === "youtube" ? "Deno 채널·미디어·메타데이터 검사 통과"
      : ["instagram", "threads"].includes(name) ? `토큰 ${Math.floor(state.preflight[name].remainingDays)}일, R2 OK`
      : name === "x" ? "계정 확인, 크레딧 잔액 미확인" : "예약 창 안, 브라우저 예약 필요";
    rows.push(`| ${NAMES[name]} | ${cell(text, 60)} | ${cell(when)} | ${method} | ${ready} |`);
  }
  return `${rows.join("\n")}\n\nrun: ${state.runId}\n승인 대상 SHA-256: ${state.manifestSha256}\n전체 문구: ${state.manifestPath ?? "runs/<run-id>/publish.json"}\n`;
}
function buildSummary(state, extras = {}) {
  const notices = (state.warnings ?? []).filter((code) => ["X_PAID_API", "X_LINK_COST"].includes(code));
  const warnings = (state.warnings ?? []).filter((code) => !notices.includes(code));
  if (Object.keys(state.cancellationErrors ?? {}).length) warnings.push("SCHEDULER_CANCELLATION_FAILED");
  const check = extras.studio;
  if (check?.checks?.copyright === "claimed") warnings.push("YOUTUBE_COPYRIGHT_CLAIMED");
  if (check?.checks?.ad_suitability === "limited") warnings.push("YOUTUBE_AD_SUITABILITY_LIMITED");
  if (Object.values(state.lanes).some((lane) => lane.state === "missed")) warnings.push("MISSED");
  if (Object.values(state.lanes).some((lane) => lane.cleanupError)) warnings.push("R2_CLEANUP_REQUIRED");
  if (Object.values(extras.schedulers ?? {}).some((scheduler) => scheduler.error)) warnings.push("SCHEDULER_FAILED");
  if (state.state === "cancelled" && state.authorization && (state.lanes.youtube || state.lanes.tiktok)) warnings.push("YOUTUBE_AND_TIKTOK_REQUIRE_MANUAL_CANCELLATION");
  return { schemaVersion: 1, runId: state.runId, state: state.state, publishAt: state.publishAt, publishAtLocal: localTime(state.publishAt, state.settings.schedule.timezone),
    checkedAt: new Date().toISOString(), lanes: state.lanes, scheduler: extras.scheduler ?? null, schedulers: extras.schedulers ?? {}, studio: check ?? null, notices, warnings: [...new Set(warnings)] };
}
function statusTable(summary) {
  const rows = ["| 플랫폼 | 상태 | 링크 |", "|---|---|---|"];
  for (const [name, lane] of Object.entries(summary.lanes)) rows.push(`| ${NAMES[name]} | ${cell(lane.state)}${lane.error ? ` (${cell(lane.error.code)})` : ""} | ${cell(lane.shortsUrl ?? lane.permalink ?? lane.url ?? "—")} |`);
  for (const [name, scheduler] of Object.entries(summary.schedulers ?? {})) rows.push(`\n${NAMES[name]} Windows 예약: ${scheduler.state === "completed_task_absent" ? "실행 완료·작업 소멸" : cell(JSON.stringify(scheduler))}`);
  if (summary.warnings.length) rows.push(`\n확인 필요: ${summary.warnings.join(", ")}`);
  if (summary.notices?.length) rows.push("\n안내: " + summary.notices.join(", "));
  return `${rows.join("\n")}\n`;
}
function tiktokHandoff(manifest, state) {
  return { file: manifest.video.path, sha256: manifest.video.sha256, caption: manifest.tiktok.caption, scheduleAt: manifest.publishAt, scheduleAtLocal: state.publishAtLocal,
    timezone: state.settings.schedule.timezone, ...Object.fromEntries(["privacy", "allowComments", "allowDuet", "allowStitch"].map((key) => [key, manifest.tiktok[key]])),
    uploadUrl: "https://www.tiktok.com/tiktokstudio/upload",
    steps: ["TikTok Studio 업로드 페이지", "파일 선택(확장 용량 제한을 넘으면 사용자가 선택)", "캡션 붙여넣기", "예약 켜고 5분 단위 시각 입력", "게시 예약", "예약 목록에서 확인"] };
}
module.exports = { cell, approvalTable, buildSummary, statusTable, tiktokHandoff };
