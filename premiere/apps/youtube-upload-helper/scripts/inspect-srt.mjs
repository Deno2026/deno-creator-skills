// SRT 파일 통계 — cue 수, 글자 수, 토큰 추정 (한글 1자 ≈ 1.5 토큰).
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node inspect-srt.mjs <path>");
  process.exit(1);
}

const content = readFileSync(path, "utf8");

// SRT cue 블록 매칭. 매우 간단한 휴리스틱.
const blocks = content.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
let cueCount = 0;
let totalChars = 0;
let totalTextChars = 0;
for (const block of blocks) {
  const lines = block.split(/\r?\n/);
  if (lines.length < 3) continue;
  // 1행: 번호, 2행: 타임코드, 3행+: 텍스트
  if (!/^\d+$/.test(lines[0].trim())) continue;
  if (!/-->/.test(lines[1] ?? "")) continue;
  cueCount++;
  const text = lines.slice(2).join(" ").trim();
  totalTextChars += text.length;
}
totalChars = content.length;

const estTokens = Math.ceil(totalTextChars * 1.5);
const overheadIndex = cueCount * 6; // "[N] " 평균
const totalInput = estTokens + overheadIndex + 700; // + 시스템 프롬프트

console.log(JSON.stringify({
  path,
  cueCount,
  totalChars,
  totalTextChars,
  estInputTokens: totalInput,
  estOutputTokens: Math.ceil(estTokens * 1.0), // 영어 응답 비슷한 토큰 수
  totalEstimate: totalInput + Math.ceil(estTokens * 1.0),
  numCtxRequired40k: (totalInput + Math.ceil(estTokens * 1.0)) > 40960 ? "OVER" : "FITS",
}, null, 2));
