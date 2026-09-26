import { stat, readFile } from "node:fs/promises";

import { parseSrt } from "@/lib/srt";

export const CAPTION_UPLOAD_MIME_TYPE = "application/octet-stream";

const HTML_TAG_PATTERN = /<[^>]+>/g;
const MAX_SRT_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const STRICT_TIMECODE_PATTERN =
  /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})(?:\s+.*)?$/;

function timestampMs(parts: string[]) {
  const [hours, minutes, seconds, milliseconds] = parts.map(Number);
  if (minutes >= 60 || seconds >= 60) return null;
  return (((hours * 60 + minutes) * 60 + seconds) * 1000) + milliseconds;
}

function validateStrictSrtStructure(text: string, language: string) {
  const normalized = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!normalized) return `${language}: SRT 파일이 비어 있습니다.`;

  const blocks = normalized.split(/\n{2,}/);
  let previousEndMs: number | null = null;

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const lines = blocks[blockIndex].split("\n");
    const expectedCueNumber = blockIndex + 1;
    const cueNumber = Number(lines[0]?.trim());
    if (!Number.isInteger(cueNumber) || cueNumber !== expectedCueNumber) {
      return `${language}: cue 번호가 1부터 연속되지 않습니다. ${expectedCueNumber}번 위치를 확인해 주세요.`;
    }

    const match = lines[1]?.trim().match(STRICT_TIMECODE_PATTERN);
    if (!match) {
      return `${language}: ${cueNumber}번 cue 타임코드 형식이 올바르지 않습니다.`;
    }

    const startMs = timestampMs(match.slice(1, 5));
    const endMs = timestampMs(match.slice(5, 9));
    if (startMs === null || endMs === null) {
      return `${language}: ${cueNumber}번 cue 타임코드 범위가 올바르지 않습니다.`;
    }
    if (endMs <= startMs) {
      return `${language}: ${cueNumber}번 cue 종료 시간이 시작 시간보다 늦어야 합니다.`;
    }
    if (previousEndMs !== null && startMs < previousEndMs) {
      return `${language}: ${cueNumber - 1}번과 ${cueNumber}번 cue가 겹칩니다.`;
    }
    if (!lines.slice(2).some((line) => line.trim().length > 0)) {
      return `${language}: ${cueNumber}번 cue 본문이 비어 있습니다.`;
    }
    previousEndMs = endMs;
  }

  return null;
}

export function validateSrtUploadText(text: string, language: string) {
  const htmlTags = text.match(HTML_TAG_PATTERN) ?? [];
  if (htmlTags.length > 0) {
    return `${language}: SRT 안에 HTML 태그가 남아 있습니다. clean SRT를 만든 뒤 업로드해 주세요.`;
  }

  const strictError = validateStrictSrtStructure(text, language);
  if (strictError) return strictError;

  const parsed = parseSrt(text);
  if (parsed.warnings.length > 0) {
    return `${language}: SRT 파서 경고가 있습니다. ${parsed.warnings[0]}`;
  }
  if (parsed.cues.length === 0) {
    return `${language}: SRT 타임코드를 인식하지 못했습니다.`;
  }

  const emptyCue = parsed.cues.find((cue) => !cue.text.replace(HTML_TAG_PATTERN, "").trim());
  if (emptyCue) {
    return `${language}: ${emptyCue.index}번 cue 본문이 비어 있습니다.`;
  }

  return null;
}

export async function validateSrtUploadFile(file: File, language: string) {
  if (file.size <= 0) {
    return `${language}: SRT 파일이 비어 있습니다.`;
  }

  if (file.size > MAX_SRT_FILE_SIZE_BYTES) {
    return `${language}: SRT 파일이 너무 큽니다. 10MB 이하 파일을 선택해 주세요.`;
  }

  return validateSrtUploadText(await file.text(), language);
}

export async function validateSrtUploadPath(filePath: string, language: string) {
  const info = await stat(filePath);
  if (!info.isFile() || info.size <= 0) {
    return `${language}: SRT 파일이 비어 있습니다.`;
  }

  if (info.size > MAX_SRT_FILE_SIZE_BYTES) {
    return `${language}: SRT 파일이 너무 큽니다. 10MB 이하 파일을 선택해 주세요.`;
  }

  return validateSrtUploadText(await readFile(filePath, "utf8"), language);
}
