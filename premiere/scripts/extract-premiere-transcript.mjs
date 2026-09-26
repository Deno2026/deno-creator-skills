import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { TextDecoder } from "node:util";

const TICKS_PER_SECOND = 254016000000;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function parseArgs(argv) {
  const options = {
    project: "",
    out: "",
    maxGapSeconds: 0.85,
    minSourceSeconds: 0,
    timelineSourceInSeconds: null,
    timelineStartSeconds: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--project") options.project = argv[++index];
    else if (value === "--out") options.out = argv[++index];
    else if (value === "--max-gap") options.maxGapSeconds = Number(argv[++index]);
    else if (value === "--min-source") options.minSourceSeconds = Number(argv[++index]);
    else if (value === "--timeline-source-in") options.timelineSourceInSeconds = Number(argv[++index]);
    else if (value === "--timeline-start") options.timelineStartSeconds = Number(argv[++index]);
    else if (value === "--help" || value === "-h") options.help = true;
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/extract-premiere-transcript.mjs --project <file.prproj> --out <transcript.json>",
    "",
    "Options:",
    "  --min-source <seconds>          Ignore source words before this time",
    "  --timeline-source-in <seconds>  Source in-point of a timeline clip",
    "  --timeline-start <seconds>      Timeline start of that clip",
  ].join("\n");
}

function readProjectXml(projectPath) {
  const raw = fs.readFileSync(projectPath);
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    return zlib.gunzipSync(raw).toString("utf8");
  }
  return raw.toString("utf8");
}

function extractTranscriptData(xml) {
  const matches = [...xml.matchAll(/<TranscriptData[^>]*>([\s\S]*?)<\/TranscriptData>/g)];
  return matches.map((match) => Buffer.from(match[1].trim(), "base64"));
}

function isZeroPadded(buffer, offset, length) {
  const paddedEnd = offset + 4 + Math.ceil(length / 4) * 4;
  for (let index = offset + 4 + length; index < paddedEnd && index < buffer.length; index += 1) {
    if (buffer[index] !== 0) return false;
  }
  return true;
}

function decodeUtf8(buffer, offset, length) {
  try {
    return utf8.decode(buffer.subarray(offset, offset + length));
  } catch {
    return "";
  }
}

function readUInt64Seconds(buffer, offset) {
  if (offset < 0 || offset + 8 > buffer.length) return null;
  return Number(buffer.readBigUInt64LE(offset)) / TICKS_PER_SECOND;
}

function extractWords(buffer, documentIndex, options) {
  const words = [];
  for (let offset = 0; offset + 32 < buffer.length; offset += 1) {
    const length = buffer.readUInt32LE(offset);
    if (length < 1 || length > 160) continue;
    if (offset + 4 + length > buffer.length) continue;
    if (!isZeroPadded(buffer, offset, length)) continue;

    const text = decodeUtf8(buffer, offset + 4, length).trim();
    if (!text || text === "ko-kr") continue;
    if (!/[가-힣A-Za-z0-9]/.test(text)) continue;

    const confidence = offset >= 24 ? buffer.readFloatLE(offset - 24) : null;
    const startSeconds = readUInt64Seconds(buffer, offset - 20);
    const durationSeconds = readUInt64Seconds(buffer, offset - 12);
    if (confidence === null || confidence < 0 || confidence > 1.0001) continue;
    if (startSeconds === null || durationSeconds === null) continue;
    if (startSeconds < options.minSourceSeconds || startSeconds > 24 * 60 * 60) continue;
    if (durationSeconds < 0.03 || durationSeconds > 15) continue;

    words.push({
      documentIndex,
      offset,
      sourceStartSeconds: round(startSeconds),
      sourceEndSeconds: round(startSeconds + durationSeconds),
      durationSeconds: round(durationSeconds),
      confidence: round(confidence, 4),
      text,
    });
  }

  const seen = new Set();
  return words
    .sort((a, b) => a.sourceStartSeconds - b.sourceStartSeconds || a.offset - b.offset)
    .filter((word) => {
      const key = `${word.sourceStartSeconds}:${word.sourceEndSeconds}:${word.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function withTimelineTime(word, options) {
  if (options.timelineSourceInSeconds === null || options.timelineStartSeconds === null) {
    return word;
  }
  const offset = options.timelineStartSeconds - options.timelineSourceInSeconds;
  return {
    ...word,
    timelineStartSeconds: round(word.sourceStartSeconds + offset),
    timelineEndSeconds: round(word.sourceEndSeconds + offset),
  };
}

function groupWords(words, maxGapSeconds) {
  const groups = [];
  let current = null;
  for (const word of words) {
    const start = word.timelineStartSeconds ?? word.sourceStartSeconds;
    const end = word.timelineEndSeconds ?? word.sourceEndSeconds;
    if (
      !current ||
      start - current.endSeconds > maxGapSeconds ||
      /[.!?。？！]$/.test(current.words[current.words.length - 1].text)
    ) {
      current = {
        startSeconds: start,
        endSeconds: end,
        sourceStartSeconds: word.sourceStartSeconds,
        sourceEndSeconds: word.sourceEndSeconds,
        text: "",
        words: [],
      };
      groups.push(current);
    }
    current.words.push(word);
    current.endSeconds = end;
    current.sourceEndSeconds = word.sourceEndSeconds;
    current.text = joinKoreanWords(current.words.map((item) => item.text));
  }
  return groups.map((group, index) => ({
    index,
    startSeconds: round(group.startSeconds),
    endSeconds: round(group.endSeconds),
    durationSeconds: round(group.endSeconds - group.startSeconds),
    sourceStartSeconds: round(group.sourceStartSeconds),
    sourceEndSeconds: round(group.sourceEndSeconds),
    text: group.text,
    wordCount: group.words.length,
  }));
}

function joinKoreanWords(parts) {
  return parts
    .join(" ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

const options = parseArgs(process.argv.slice(2));
if (options.help || !options.project || !options.out) {
  console.log(usage());
  process.exit(options.help ? 0 : 1);
}

const xml = readProjectXml(options.project);
const documents = extractTranscriptData(xml);
const words = documents.flatMap((buffer, index) => extractWords(buffer, index, options)).map((word) =>
  withTimelineTime(word, options),
);
const groups = groupWords(words, options.maxGapSeconds);
const payload = {
  project: path.resolve(options.project),
  documentCount: documents.length,
  wordCount: words.length,
  groupCount: groups.length,
  options: {
    minSourceSeconds: options.minSourceSeconds,
    timelineSourceInSeconds: options.timelineSourceInSeconds,
    timelineStartSeconds: options.timelineStartSeconds,
    maxGapSeconds: options.maxGapSeconds,
  },
  words,
  groups,
};
fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
fs.writeFileSync(options.out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ out: path.resolve(options.out), words: words.length, groups: groups.length }, null, 2));
