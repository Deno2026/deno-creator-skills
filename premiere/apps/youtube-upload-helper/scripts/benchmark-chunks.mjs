/**
 * Ollama 청크 사이즈 벤치마크.
 *
 * 동일 SRT에 대해 청크 사이즈별로 번역 호출 시간·누락·토큰·VRAM peak을 측정한다.
 * src/lib/llm/translate.ts의 프롬프트·파서를 그대로 재현하여 실제 사용 흐름과 동일.
 *
 * 사용:
 *   node scripts/benchmark-chunks.mjs <srt-path> <chunk-size> [num-ctx]
 *
 * 결과: scripts/benchmark-results/chunk-<N>.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "benchmark-results");
if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

const OLLAMA_BASE = "http://127.0.0.1:11434";
const MODEL = "gemma4:31b-it-q4_K_M";
const KEEP_ALIVE = "30m";

const [srtPath, chunkSizeRaw, numCtxRaw] = process.argv.slice(2);
if (!srtPath || !chunkSizeRaw) {
  console.error(
    "usage: node scripts/benchmark-chunks.mjs <srt-path> <chunk-size> [num-ctx=40960]",
  );
  process.exit(1);
}
const CHUNK_SIZE = parseInt(chunkSizeRaw, 10);
const NUM_CTX = parseInt(numCtxRaw ?? "40960", 10);

// ───── SRT 파싱 ─────
function parseSrt(content) {
  const blocks = content.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    if (lines.length < 3) continue;
    if (!/^\d+$/.test(lines[0].trim())) continue;
    if (!/-->/.test(lines[1] ?? "")) continue;
    cues.push({
      index: parseInt(lines[0].trim(), 10),
      time: lines[1].trim(),
      text: lines.slice(2).join("\n").trim(),
    });
  }
  return cues;
}

// ───── 시스템 프롬프트 (translate.ts와 동일) ─────
function buildSystemPrompt(chunkSize) {
  const label = "영어 (English)";
  return `/no_think

한국어 영상 자막 ${chunkSize}개를 ${label}로 번역합니다.

기본 원칙:
- 가능한 한 한국어 자막 1개 → ${label} 자막 1개 (1:1).
- 한국어 어순 때문에 한 줄만 끊어서 번역하면 의미가 깨지는 경우(예: 한국어가 동사 끝에 오는 절이 두 자막에 나뉜 경우), 인접한 2~3개 자막을 합쳐 한 ${label} 자막으로 번역해도 됩니다.

엄격한 형식:
- 입력은 각 자막 앞에 \`[N]\` 인덱스 prefix가 있고, 자막 사이는 \`---\` 한 줄로 구분.
- 출력도 동일하게 prefix와 \`---\`로 구분.
  - 1:1 번역: \`[N] 번역\`
  - 합쳐서 번역: \`[N-M] 합쳐진 번역\` (N부터 M까지 인접 인덱스, M > N)
- N부터 ${chunkSize}까지 모든 입력 인덱스가 출력에 정확히 한 번씩 cover되어야 합니다.
- 합칠 수 있는 범위는 인접한 자막만. 보통 2~3개. 4개 이상 합치기는 피하세요.
- 번역 텍스트만. 마크다운 금지. 따옴표 감싸기 금지. 안내문 금지.

번역 규칙:
- 자연스럽고 빠르게 읽히는 ${label}.
- 같은 용어는 일관된 번역어.
- 고유명사·인명은 ${label} 표준 표기.`;
}

function joinChunkForPrompt(chunk) {
  return chunk.map((cue, i) => `[${i + 1}] ${cue.text}`).join("\n---\n");
}

// ───── 응답 파싱 (translate.ts와 동일 로직 단순화) ─────
function countMatched(rawResponse, chunkLen) {
  const parts = rawResponse.split(/\r?\n/).reduce(
    (acc, line) => {
      if (/^[-=*_─–—]{3,}.*$/.test(line.trim())) {
        acc.groups.push([]);
      } else {
        acc.groups[acc.groups.length - 1].push(line);
      }
      return acc;
    },
    { groups: [[]] },
  ).groups
    .map((g) => g.join("\n").trim())
    .filter((part) => part.length > 0);

  const covered = new Set();
  for (const part of parts) {
    const m = part.match(
      /^\s*\[\s*(\d+)\s*(?:[-–—~]\s*(\d+))?\s*\]\s*([\s\S]*)$/,
    );
    if (!m) continue;
    const startIdx = parseInt(m[1], 10);
    const endIdx = m[2] ? parseInt(m[2], 10) : startIdx;
    if (startIdx < 1 || endIdx > chunkLen || startIdx > endIdx) continue;
    for (let i = startIdx; i <= endIdx; i++) covered.add(i);
  }
  return { matched: covered.size, missing: chunkLen - covered.size };
}

// ───── VRAM 측정 ─────
function getVramUsedMiB() {
  const r = spawnSync(
    "nvidia-smi",
    ["--query-gpu=memory.used", "--format=csv,noheader,nounits"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return null;
  return parseInt(r.stdout.trim(), 10);
}

// ───── Ollama 호출 ─────
async function callOllama(systemPrompt, userPrompt, numPredict) {
  const body = {
    model: MODEL,
    stream: false,
    think: false,
    keep_alive: KEEP_ALIVE,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    options: {
      num_predict: numPredict,
      num_ctx: NUM_CTX,
      temperature: 0,
    },
  };
  const resp = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

// ───── 메인 ─────
async function main() {
  const srtContent = readFileSync(srtPath, "utf8");
  const cues = parseSrt(srtContent);
  console.log(
    `[bench chunk=${CHUNK_SIZE} num_ctx=${NUM_CTX}] SRT cues=${cues.length}`,
  );

  const vramBaseline = getVramUsedMiB();
  console.log(`[bench] VRAM baseline: ${vramBaseline} MiB`);

  // 청크별 호출 — VRAM peak는 별도 interval로 폴링
  let vramPeak = vramBaseline ?? 0;
  const vramPoller = setInterval(() => {
    const v = getVramUsedMiB();
    if (typeof v === "number" && v > vramPeak) vramPeak = v;
  }, 500);

  const chunkResults = [];
  const totalStart = Date.now();

  for (let start = 0; start < cues.length; start += CHUNK_SIZE) {
    const chunk = cues.slice(start, start + CHUNK_SIZE);
    const systemPrompt = buildSystemPrompt(chunk.length);
    const userPrompt = joinChunkForPrompt(chunk);
    const numPredict = Math.max(2048, chunk.length * 250 + 2048);

    const t0 = Date.now();
    let chunkRecord;
    try {
      const result = await callOllama(systemPrompt, userPrompt, numPredict);
      const elapsedMs = Date.now() - t0;
      const text = result.message?.content ?? "";
      const { matched, missing } = countMatched(text, chunk.length);
      chunkRecord = {
        chunkIndex: Math.floor(start / CHUNK_SIZE),
        startCueIdx: start + 1,
        endCueIdx: start + chunk.length,
        chunkLen: chunk.length,
        elapsedMs,
        elapsedSec: +(elapsedMs / 1000).toFixed(2),
        promptEvalCount: result.prompt_eval_count ?? null,
        evalCount: result.eval_count ?? null,
        matched,
        missing,
        responsePreview: text.slice(0, 200),
        responseLength: text.length,
        doneReason: result.done_reason ?? null,
      };
    } catch (err) {
      chunkRecord = {
        chunkIndex: Math.floor(start / CHUNK_SIZE),
        startCueIdx: start + 1,
        endCueIdx: start + chunk.length,
        chunkLen: chunk.length,
        elapsedMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    chunkResults.push(chunkRecord);
    console.log(
      `[bench] chunk ${chunkRecord.chunkIndex + 1}/${Math.ceil(cues.length / CHUNK_SIZE)}: ` +
        `${chunkRecord.elapsedSec ?? "-"}s, matched=${chunkRecord.matched ?? "-"}/${chunkRecord.chunkLen}, ` +
        `in=${chunkRecord.promptEvalCount ?? "-"}t out=${chunkRecord.evalCount ?? "-"}t`,
    );
  }

  clearInterval(vramPoller);
  const totalElapsedMs = Date.now() - totalStart;

  const totalMatched = chunkResults.reduce((s, c) => s + (c.matched ?? 0), 0);
  const totalMissing = chunkResults.reduce((s, c) => s + (c.missing ?? 0), 0);
  const totalIn = chunkResults.reduce(
    (s, c) => s + (c.promptEvalCount ?? 0),
    0,
  );
  const totalOut = chunkResults.reduce((s, c) => s + (c.evalCount ?? 0), 0);

  const summary = {
    config: {
      chunkSize: CHUNK_SIZE,
      numCtx: NUM_CTX,
      model: MODEL,
      keepAlive: KEEP_ALIVE,
    },
    srt: {
      path: srtPath,
      cueCount: cues.length,
    },
    totals: {
      chunkCount: chunkResults.length,
      elapsedMs: totalElapsedMs,
      elapsedSec: +(totalElapsedMs / 1000).toFixed(1),
      matched: totalMatched,
      missing: totalMissing,
      coverage: +((totalMatched / cues.length) * 100).toFixed(1),
      promptEvalTotal: totalIn,
      evalTotal: totalOut,
      vramBaselineMiB: vramBaseline,
      vramPeakMiB: vramPeak,
      vramDeltaMiB: vramPeak - (vramBaseline ?? 0),
    },
    chunks: chunkResults,
    timestamp: new Date().toISOString(),
  };

  const outPath = join(RESULTS_DIR, `chunk-${CHUNK_SIZE}.json`);
  writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf8");

  console.log(`\n[bench] DONE — chunk=${CHUNK_SIZE}`);
  console.log(`  total: ${summary.totals.elapsedSec}s`);
  console.log(
    `  matched: ${totalMatched}/${cues.length} (${summary.totals.coverage}%), missing: ${totalMissing}`,
  );
  console.log(`  tokens: in=${totalIn} out=${totalOut}`);
  console.log(
    `  VRAM: baseline=${vramBaseline} MiB → peak=${vramPeak} MiB (delta=${vramPeak - (vramBaseline ?? 0)} MiB)`,
  );
  console.log(`  → ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
