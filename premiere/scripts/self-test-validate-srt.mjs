import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatHumanReport,
  parseFps,
  parseSrt,
  validateSrt,
} from "./validate-srt.mjs";

const VALID_SRT = [
  "\uFEFF1",
  "00:00:00,000 --> 00:00:01,200",
  "첫 번째 문장입니다.",
  "",
  "2",
  "00:00:01,400 --> 00:00:02,800",
  "두 번째 문장입니다.",
  "",
].join("\r\n");

function codesFor(source, limits = {}) {
  return new Set(validateSrt(source, limits).issues.map((item) => item.code));
}

function expectCode(source, code, limits = {}) {
  const codes = codesFor(source, limits);
  assert.equal(codes.has(code), true, `Expected ${code}; received ${[...codes].join(", ")}`);
}

const parsed = parseSrt(VALID_SRT);
assert.equal(parsed.issues.length, 0);
assert.equal(parsed.cues.length, 2);
assert.equal(parsed.cues[1].number, 2);

const validReport = validateSrt(VALID_SRT, { fps: 25 });
assert.equal(validReport.ok, true);
assert.equal(validReport.summary.cueCount, 2);
assert.equal(validReport.cues[0].durationSeconds, 1.2);
assert.match(formatHumanReport(validReport), /SRT QC 통과/);
assert.ok(Math.abs(parseFps("30000/1001") - 30000 / 1001) < 1e-12);

expectCode(
  ["2", "00:00:00,000 --> 00:00:01,000", "번호 오류"].join("\n"),
  "CUE_NUMBER_SEQUENCE",
);
expectCode(
  ["cue-one", "00:00:00,000 --> 00:00:01,000", "번호 형식 오류"].join("\n"),
  "CUE_NUMBER_INVALID",
);
expectCode(
  ["1", "00:00:00,000 -> 00:00:01,000", "화살표 오류"].join("\n"),
  "TIMING_LINE_INVALID",
);
expectCode(
  ["1", "00:61:00,000 --> 00:61:01,000", "시간 오류"].join("\n"),
  "START_TIMECODE_INVALID",
);
expectCode("", "SRT_EMPTY");
expectCode(["1", "00:00:00,000 --> 00:00:01,000"].join("\n"), "CUE_TEXT_EMPTY");
expectCode(
  ["1", "00:00:01,000 --> 00:00:01,000", "제로"].join("\n"),
  "CUE_DURATION_ZERO",
);
expectCode(
  ["1", "00:00:02,000 --> 00:00:01,000", "역방향"].join("\n"),
  "CUE_DURATION_NEGATIVE",
);
expectCode(
  [
    "1",
    "00:00:00,000 --> 00:00:02,000",
    "첫 큐",
    "",
    "2",
    "00:00:01,500 --> 00:00:03,000",
    "겹친 큐",
  ].join("\n"),
  "CUE_OVERLAP",
);
expectCode(
  [
    "1",
    "00:00:02,000 --> 00:00:03,000",
    "뒤 시각",
    "",
    "2",
    "00:00:01,000 --> 00:00:01,800",
    "앞 시각",
  ].join("\n"),
  "CUE_TIME_ORDER",
);
expectCode(
  ["1", "00:00:00,000 --> 00:00:02,000", "한 줄", "두 줄", "세 줄"].join("\n"),
  "CUE_TOO_MANY_LINES",
);
expectCode(
  ["1", "00:00:00,000 --> 00:00:02,000", "123456"].join("\n"),
  "CUE_LINE_TOO_LONG",
  { maxLineLength: 5 },
);
expectCode(
  ["1", "00:00:00,000 --> 00:00:00,500", "짧음"].join("\n"),
  "CUE_DURATION_TOO_SHORT",
);
expectCode(
  ["1", "00:00:00,000 --> 00:00:08,000", "너무 김"].join("\n"),
  "CUE_DURATION_TOO_LONG",
);
expectCode(
  ["1", "00:00:00,000 --> 00:00:01,000", "12345678901"].join("\n"),
  "CUE_CPS_EXCEEDED",
  { maxCps: 10 },
);
expectCode(
  ["1", "00:00:00,010 --> 00:00:01,010", "프레임 불일치"].join("\n"),
  "CUE_NOT_FRAME_ALIGNED",
  { fps: 25, frameToleranceFrames: 0.05 },
);
expectCode(
  [
    "1",
    "00:00:00,000 --> 00:00:01,000",
    "빈 줄이 없음",
    "2",
    "00:00:01,000 --> 00:00:02,000",
    "다음 큐",
  ].join("\n"),
  "CUE_SEPARATOR_MISSING",
);

assert.throws(
  () => validateSrt(VALID_SRT, { frameToleranceFrames: 0.1 }),
  /fps도 함께 지정/,
);

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "deno-srt-qc-"));
const validatorPath = fileURLToPath(new URL("./validate-srt.mjs", import.meta.url));
try {
  const validPath = path.join(tempRoot, "valid.srt");
  const invalidPath = path.join(tempRoot, "invalid.srt");
  const reportPath = path.join(tempRoot, "reports", "valid.json");
  await writeFile(validPath, VALID_SRT, "utf8");
  await writeFile(
    invalidPath,
    ["1", "00:00:00,000 --> 00:00:00,100", "이 문장은 너무 빨리 지나갑니다."].join("\n"),
    "utf8",
  );

  const validCli = spawnSync(
    process.execPath,
    [validatorPath, validPath, "--json", "--strict", "--fps", "25", "--out", reportPath],
    { encoding: "utf8" },
  );
  assert.equal(validCli.status, 0, validCli.stderr);
  assert.equal(JSON.parse(validCli.stdout).ok, true);
  assert.equal(JSON.parse(await readFile(reportPath, "utf8")).reportFile, reportPath);

  const invalidCli = spawnSync(process.execPath, [validatorPath, invalidPath, "--json", "--strict"], {
    encoding: "utf8",
  });
  assert.equal(invalidCli.status, 2, invalidCli.stderr);
  assert.equal(JSON.parse(invalidCli.stdout).ok, false);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

process.stdout.write(
  `${JSON.stringify(
    {
      success: true,
      tests: 22,
      validatedCodes: [
        "CUE_NUMBER_SEQUENCE",
        "CUE_NUMBER_INVALID",
        "TIMING_LINE_INVALID",
        "START_TIMECODE_INVALID",
        "SRT_EMPTY",
        "CUE_TEXT_EMPTY",
        "CUE_DURATION_ZERO",
        "CUE_DURATION_NEGATIVE",
        "CUE_OVERLAP",
        "CUE_TIME_ORDER",
        "CUE_TOO_MANY_LINES",
        "CUE_LINE_TOO_LONG",
        "CUE_DURATION_TOO_SHORT",
        "CUE_DURATION_TOO_LONG",
        "CUE_CPS_EXCEEDED",
        "CUE_NOT_FRAME_ALIGNED",
        "CUE_SEPARATOR_MISSING",
      ],
    },
    null,
    2,
  )}\n`,
);
