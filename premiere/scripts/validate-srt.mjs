import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_LIMITS = Object.freeze({
  maxLines: 2,
  maxLineLength: 42,
  minDurationSeconds: 0.8,
  maxDurationSeconds: 7,
  maxCps: 20,
  fps: null,
  frameToleranceFrames: 0.05,
});

const TIMECODE_PATTERN = /^(\d{2,}):(\d{2}):(\d{2}),(\d{3})$/;
const TIMING_LINE_PATTERN = /^\s*(\S+)\s*-->\s*(\S+)(?:\s+.*)?$/;
const EPSILON_SECONDS = 1e-9;

function issue(code, message, context = {}) {
  return { severity: "error", code, message, ...context };
}

function countCharacters(value) {
  return [...value].length;
}

function countReadingCharacters(lines) {
  return [...lines.join("").replace(/\s/gu, "")].length;
}

function round(value, digits = 6) {
  return Number(value.toFixed(digits));
}

function parsePositiveNumber(value, name, { integer = false, allowZero = false } = {}) {
  const parsed = Number(value);
  const validRange = allowZero ? parsed >= 0 : parsed > 0;
  if (!Number.isFinite(parsed) || !validRange || (integer && !Number.isInteger(parsed))) {
    const qualifier = allowZero ? "0 이상" : "0보다 큰";
    throw new Error(`${name}은(는) ${qualifier}${integer ? " 정수" : " 숫자"}여야 합니다: ${value}`);
  }
  return parsed;
}

export function parseFps(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return parsePositiveNumber(value, "fps");

  const text = String(value).trim();
  const fraction = text.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (fraction) {
    const numerator = parsePositiveNumber(fraction[1], "fps 분자");
    const denominator = parsePositiveNumber(fraction[2], "fps 분모");
    return numerator / denominator;
  }
  return parsePositiveNumber(text, "fps");
}

export function parseTimecode(value) {
  const match = TIMECODE_PATTERN.exec(value);
  if (!match) return null;

  const [, hoursText, minutesText, secondsText, millisecondsText] = match;
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  const milliseconds = Number(millisecondsText);
  if (minutes > 59 || seconds > 59) return null;

  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function splitBlocks(source) {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const blocks = [];
  let current = [];
  let startLine = 1;

  const flush = () => {
    if (current.length === 0) return;
    blocks.push({ lines: current, startLine });
    current = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") {
      flush();
      startLine = index + 2;
      continue;
    }
    if (current.length === 0) startLine = index + 1;
    current.push(line);
  }
  flush();
  return blocks;
}

export function parseSrt(source) {
  if (typeof source !== "string") throw new TypeError("SRT source must be a string.");

  const blocks = splitBlocks(source);
  const cues = [];
  const issues = [];

  if (blocks.length === 0) {
    issues.push(issue("SRT_EMPTY", "SRT에 큐가 없습니다."));
    return { cues, issues };
  }

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    const cueOrdinal = blockIndex + 1;
    const numberText = block.lines[0]?.trim() ?? "";
    const timingText = block.lines[1]?.trim() ?? "";
    const number = /^\d+$/.test(numberText) ? Number(numberText) : null;
    const timingMatch = TIMING_LINE_PATTERN.exec(timingText);
    let startSeconds = null;
    let endSeconds = null;
    let startTimecode = null;
    let endTimecode = null;

    if (number === null || number < 1) {
      issues.push(
        issue("CUE_NUMBER_INVALID", "큐 번호는 1 이상의 정수여야 합니다.", {
          cueOrdinal,
          line: block.startLine,
          actual: numberText,
        }),
      );
    }

    if (!timingMatch) {
      issues.push(
        issue("TIMING_LINE_INVALID", "시간줄은 HH:MM:SS,mmm --> HH:MM:SS,mmm 형식이어야 합니다.", {
          cueOrdinal,
          cueNumber: number,
          line: block.startLine + 1,
          actual: timingText,
        }),
      );
    } else {
      startTimecode = timingMatch[1];
      endTimecode = timingMatch[2];
      startSeconds = parseTimecode(startTimecode);
      endSeconds = parseTimecode(endTimecode);
      if (startSeconds === null) {
        issues.push(
          issue("START_TIMECODE_INVALID", "시작 시간코드가 올바른 SRT 형식이 아닙니다.", {
            cueOrdinal,
            cueNumber: number,
            line: block.startLine + 1,
            actual: startTimecode,
          }),
        );
      }
      if (endSeconds === null) {
        issues.push(
          issue("END_TIMECODE_INVALID", "종료 시간코드가 올바른 SRT 형식이 아닙니다.", {
            cueOrdinal,
            cueNumber: number,
            line: block.startLine + 1,
            actual: endTimecode,
          }),
        );
      }
    }

    const textLines = block.lines.slice(2);
    if (textLines.length === 0 || textLines.every((line) => line.trim() === "")) {
      issues.push(
        issue("CUE_TEXT_EMPTY", "큐 본문이 비어 있습니다.", {
          cueOrdinal,
          cueNumber: number,
          line: block.startLine + 2,
        }),
      );
    }

    for (let lineIndex = 0; lineIndex < textLines.length; lineIndex += 1) {
      if (TIMING_LINE_PATTERN.test(textLines[lineIndex].trim())) {
        issues.push(
          issue("CUE_SEPARATOR_MISSING", "다음 큐 앞의 빈 줄이 누락된 것으로 보입니다.", {
            cueOrdinal,
            cueNumber: number,
            line: block.startLine + 2 + lineIndex,
          }),
        );
      }
    }

    cues.push({
      ordinal: cueOrdinal,
      number,
      line: block.startLine,
      startTimecode,
      endTimecode,
      startSeconds,
      endSeconds,
      textLines,
      text: textLines.join("\n"),
    });
  }

  return { cues, issues };
}

function normalizeLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  limits.maxLines = parsePositiveNumber(limits.maxLines, "maxLines", { integer: true });
  limits.maxLineLength = parsePositiveNumber(limits.maxLineLength, "maxLineLength", { integer: true });
  limits.minDurationSeconds = parsePositiveNumber(limits.minDurationSeconds, "minDurationSeconds", {
    allowZero: true,
  });
  limits.maxDurationSeconds = parsePositiveNumber(limits.maxDurationSeconds, "maxDurationSeconds");
  limits.maxCps = parsePositiveNumber(limits.maxCps, "maxCps");
  limits.fps = parseFps(limits.fps);
  limits.frameToleranceFrames = parsePositiveNumber(limits.frameToleranceFrames, "frameToleranceFrames", {
    allowZero: true,
  });

  if (limits.maxDurationSeconds < limits.minDurationSeconds) {
    throw new Error("maxDurationSeconds는 minDurationSeconds 이상이어야 합니다.");
  }
  if (limits.frameToleranceFrames > 0.5) {
    throw new Error("frameToleranceFrames는 0 이상 0.5 이하여야 합니다.");
  }
  if (overrides.frameToleranceFrames !== undefined && limits.fps === null) {
    throw new Error("frameToleranceFrames를 지정하려면 fps도 함께 지정해야 합니다.");
  }
  return limits;
}

function frameDistance(seconds, fps) {
  const frames = seconds * fps;
  return Math.abs(frames - Math.round(frames));
}

function cueContext(cue) {
  return { cueOrdinal: cue.ordinal, cueNumber: cue.number, line: cue.line };
}

export function validateSrt(source, overrides = {}) {
  const limits = normalizeLimits(overrides);
  const parsed = parseSrt(source);
  const issues = [...parsed.issues];
  const cueMetrics = [];
  let previousCue = null;

  for (const cue of parsed.cues) {
    const context = cueContext(cue);
    const expectedNumber = cue.ordinal;
    if (cue.number !== null && cue.number !== expectedNumber) {
      issues.push(
        issue("CUE_NUMBER_SEQUENCE", `큐 번호는 ${expectedNumber}이어야 합니다.`, {
          ...context,
          expected: expectedNumber,
          actual: cue.number,
        }),
      );
    }

    if (
      previousCue &&
      previousCue.startSeconds !== null &&
      cue.startSeconds !== null &&
      cue.startSeconds + EPSILON_SECONDS < previousCue.startSeconds
    ) {
      issues.push(
        issue("CUE_TIME_ORDER", "큐 시작 시각이 이전 큐보다 빠릅니다.", {
          ...context,
          previousCueNumber: previousCue.number,
          previousStartSeconds: previousCue.startSeconds,
          actual: cue.startSeconds,
        }),
      );
    }

    if (
      previousCue &&
      previousCue.endSeconds !== null &&
      cue.startSeconds !== null &&
      cue.startSeconds + EPSILON_SECONDS < previousCue.endSeconds
    ) {
      issues.push(
        issue("CUE_OVERLAP", "이전 큐와 시간이 겹칩니다.", {
          ...context,
          previousCueNumber: previousCue.number,
          previousEndSeconds: previousCue.endSeconds,
          actual: cue.startSeconds,
          overlapSeconds: round(previousCue.endSeconds - cue.startSeconds),
        }),
      );
    }

    const durationSeconds =
      cue.startSeconds !== null && cue.endSeconds !== null ? cue.endSeconds - cue.startSeconds : null;
    const readingCharacters = countReadingCharacters(cue.textLines);
    const cps = durationSeconds !== null && durationSeconds > 0 ? readingCharacters / durationSeconds : null;

    if (durationSeconds !== null) {
      if (durationSeconds < -EPSILON_SECONDS) {
        issues.push(
          issue("CUE_DURATION_NEGATIVE", "큐 종료 시각이 시작 시각보다 빠릅니다.", {
            ...context,
            actual: round(durationSeconds),
          }),
        );
      } else if (Math.abs(durationSeconds) <= EPSILON_SECONDS) {
        issues.push(issue("CUE_DURATION_ZERO", "큐 길이가 0초입니다.", { ...context, actual: 0 }));
      } else {
        if (durationSeconds + EPSILON_SECONDS < limits.minDurationSeconds) {
          issues.push(
            issue("CUE_DURATION_TOO_SHORT", "큐 길이가 최소 기준보다 짧습니다.", {
              ...context,
              actual: round(durationSeconds),
              limit: limits.minDurationSeconds,
            }),
          );
        }
        if (durationSeconds - EPSILON_SECONDS > limits.maxDurationSeconds) {
          issues.push(
            issue("CUE_DURATION_TOO_LONG", "큐 길이가 최대 기준보다 깁니다.", {
              ...context,
              actual: round(durationSeconds),
              limit: limits.maxDurationSeconds,
            }),
          );
        }
        if (cps - EPSILON_SECONDS > limits.maxCps) {
          issues.push(
            issue("CUE_CPS_EXCEEDED", "초당 글자 수가 최대 기준을 넘습니다.", {
              ...context,
              actual: round(cps, 3),
              limit: limits.maxCps,
              readingCharacters,
            }),
          );
        }
      }
    }

    if (cue.textLines.length > limits.maxLines) {
      issues.push(
        issue("CUE_TOO_MANY_LINES", "큐 줄 수가 최대 기준을 넘습니다.", {
          ...context,
          actual: cue.textLines.length,
          limit: limits.maxLines,
        }),
      );
    }

    for (let lineIndex = 0; lineIndex < cue.textLines.length; lineIndex += 1) {
      const lineLength = countCharacters(cue.textLines[lineIndex]);
      if (lineLength > limits.maxLineLength) {
        issues.push(
          issue("CUE_LINE_TOO_LONG", "자막 한 줄의 글자 수가 최대 기준을 넘습니다.", {
            ...context,
            line: cue.line + 2 + lineIndex,
            textLine: lineIndex + 1,
            actual: lineLength,
            limit: limits.maxLineLength,
          }),
        );
      }
    }

    if (limits.fps !== null) {
      for (const [field, seconds] of [
        ["start", cue.startSeconds],
        ["end", cue.endSeconds],
      ]) {
        if (seconds === null) continue;
        const distanceFrames = frameDistance(seconds, limits.fps);
        if (distanceFrames - EPSILON_SECONDS > limits.frameToleranceFrames) {
          issues.push(
            issue("CUE_NOT_FRAME_ALIGNED", `큐 ${field === "start" ? "시작" : "종료"} 시각이 프레임 격자에 맞지 않습니다.`, {
              ...context,
              field,
              actual: round(distanceFrames, 6),
              limit: limits.frameToleranceFrames,
              fps: round(limits.fps, 6),
            }),
          );
        }
      }
    }

    cueMetrics.push({
      ordinal: cue.ordinal,
      number: cue.number,
      startSeconds: cue.startSeconds,
      endSeconds: cue.endSeconds,
      durationSeconds: durationSeconds === null ? null : round(durationSeconds),
      lines: cue.textLines.length,
      maxLineLength: cue.textLines.reduce((maximum, line) => Math.max(maximum, countCharacters(line)), 0),
      readingCharacters,
      cps: cps === null ? null : round(cps, 3),
      text: cue.text,
    });

    previousCue = cue;
  }

  const sortedIssues = issues.sort(
    (left, right) =>
      (left.cueOrdinal ?? 0) - (right.cueOrdinal ?? 0) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.code.localeCompare(right.code),
  );

  return {
    schemaVersion: 1,
    ok: sortedIssues.length === 0,
    format: "srt",
    summary: {
      cueCount: parsed.cues.length,
      errorCount: sortedIssues.length,
    },
    limits: {
      ...limits,
      fps: limits.fps === null ? null : round(limits.fps, 9),
    },
    issues: sortedIssues,
    cues: cueMetrics,
  };
}

export function parseCliArgs(argv) {
  const options = {
    input: "",
    json: false,
    out: "",
    strict: false,
    limits: {},
    help: false,
  };
  const withValue = new Map([
    ["--out", ["out", String]],
    ["--max-lines", ["maxLines", Number]],
    ["--max-line-length", ["maxLineLength", Number]],
    ["--min-duration", ["minDurationSeconds", Number]],
    ["--max-duration", ["maxDurationSeconds", Number]],
    ["--max-cps", ["maxCps", Number]],
    ["--fps", ["fps", String]],
    ["--frame-tolerance", ["frameToleranceFrames", Number]],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") options.help = true;
    else if (value === "--json") options.json = true;
    else if (value === "--strict") options.strict = true;
    else if (withValue.has(value)) {
      if (index + 1 >= argv.length) throw new Error(`${value} 뒤에 값이 필요합니다.`);
      const [key, convert] = withValue.get(value);
      const parsed = convert(argv[++index]);
      if (key === "out") options.out = parsed;
      else options.limits[key] = parsed;
    } else if (value.startsWith("-")) {
      throw new Error(`알 수 없는 옵션입니다: ${value}`);
    } else if (!options.input) {
      options.input = value;
    } else {
      throw new Error(`입력 SRT는 하나만 지정할 수 있습니다: ${value}`);
    }
  }
  return options;
}

export function usage() {
  return [
    "Usage:",
    "  node scripts/validate-srt.mjs <input.srt> [options]",
    "",
    "Output and gate:",
    "  --json                    Print the complete JSON report",
    "  --out <report.json>       Also write the complete JSON report",
    "  --strict                  Exit 2 when any QC error is found",
    "",
    "Quality limits:",
    `  --max-lines <n>           Maximum lines per cue (default: ${DEFAULT_LIMITS.maxLines})`,
    `  --max-line-length <n>     Maximum Unicode characters per line (default: ${DEFAULT_LIMITS.maxLineLength})`,
    `  --min-duration <seconds>  Minimum positive cue duration (default: ${DEFAULT_LIMITS.minDurationSeconds})`,
    `  --max-duration <seconds>  Maximum cue duration (default: ${DEFAULT_LIMITS.maxDurationSeconds})`,
    `  --max-cps <n>             Maximum non-whitespace characters/second (default: ${DEFAULT_LIMITS.maxCps})`,
    "  --fps <n|fraction>        Check cue boundaries against this frame rate, e.g. 25 or 30000/1001",
    `  --frame-tolerance <frames> Maximum distance from a frame boundary, 0..0.5 (default with fps: ${DEFAULT_LIMITS.frameToleranceFrames})`,
  ].join("\n");
}

export function formatHumanReport(report) {
  const lines = [
    `SRT QC ${report.ok ? "통과" : "실패"}`,
    `파일: ${report.file ?? "(메모리)"}`,
    `큐: ${report.summary.cueCount} | 오류: ${report.summary.errorCount}`,
  ];

  if (report.limits.fps !== null) {
    lines.push(
      `프레임 검사: ${report.limits.fps} fps | 허용 오차: ${report.limits.frameToleranceFrames} frame`,
    );
  }
  for (const item of report.issues) {
    const cue = item.cueNumber ?? item.cueOrdinal;
    const location = [cue ? `큐 ${cue}` : "", item.line ? `줄 ${item.line}` : ""].filter(Boolean).join(", ");
    lines.push(`- [${item.code}]${location ? ` ${location}:` : ""} ${item.message}`);
  }
  return lines.join("\n");
}

async function runCli() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  if (options.help || !options.input) {
    console.log(usage());
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  try {
    const inputPath = path.resolve(options.input);
    const source = fs.readFileSync(inputPath, "utf8");
    const report = { ...validateSrt(source, options.limits), file: inputPath };

    if (options.out) {
      const outputPath = path.resolve(options.out);
      report.reportFile = outputPath;
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }

    if (options.json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatHumanReport(report));
    if (options.strict && !report.ok) process.exitCode = 2;
  } catch (error) {
    const failure = { ok: false, code: "SRT_VALIDATION_FAILED", error: error.message };
    if (options?.json) console.error(JSON.stringify(failure, null, 2));
    else console.error(`SRT 검증을 실행하지 못했습니다: ${error.message}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await runCli();
