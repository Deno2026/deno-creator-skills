"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { createReadStream } = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const ERROR_MESSAGES = Object.freeze({
  PUBLISH_FILE_INVALID: "publish.json의 필드와 미디어 규격을 확인하세요.",
  VIDEO_MISSING: "지정한 영상 파일이 없습니다.",
  VIDEO_SHA_MISMATCH: "영상 바이트가 승인된 파일 해시와 다릅니다.",
  INSTAGRAM_SPEC: "Instagram 미디어 규격을 충족하지 않습니다.",
  TIKTOK_SCHEDULE_WINDOW: "TikTok 예약은 20분 뒤부터 10일 이내의 5분 단위 시각이어야 합니다.",
  THREADS_SPEC: "Threads 영상은 5분·1GB 이하, H.264/HEVC MP4/MOV 규격이어야 합니다.",
  X_SPEC: "X 영상은 140초·512MB 이하의 H.264 MP4 규격이어야 합니다.",
  X_TEXT_INVALID: "X 본문이 비어 있거나 가중 글자 수 280자 한도를 초과했습니다.",
  THREADS_TEXT_INVALID: "Threads 본문의 500자·태그·멘션 한도를 확인하세요.",
  THREADS_TOKEN_MISSING: "Threads 토큰이 없습니다. connect_threads --token-file로 연결하세요.",
  THREADS_TOKEN_EXPIRED: "Threads 토큰이 만료되었습니다. 장기 토큰을 다시 발급받아 연결하세요.",
  THREADS_TOKEN_TOO_YOUNG: "Threads 토큰은 발급·갱신 후 24시간이 지나야 갱신할 수 있습니다.",
  X_TOKEN_MISSING: "X 토큰이 없습니다. connect_x --token-file 또는 --authorize로 연결하세요.",
  X_SCOPE_MISSING: "X 토큰의 게시·미디어·갱신 권한을 확인하세요.",
  X_INSUFFICIENT_CREDIT: "X 선불 크레딧이 부족합니다. 콘솔 잔액을 확인하세요.",
  REPLAN_REMOTE_STATE_UNRESOLVED: "이미 게시되었거나 게시 결과가 불명확한 레인이 있어 재계획할 수 없습니다.",
  PUBLISH_AT_TOO_SOON: "예약 시각까지 준비 시간이 부족합니다.",
  YOUTUBE_CHANNEL_MISMATCH: "연결된 YouTube 채널이 Deno 채널과 다릅니다.",
  INSTAGRAM_TOKEN_MISSING: "Instagram 연결 토큰이 없습니다. connect_instagram으로 연결하세요.",
  INSTAGRAM_TOKEN_EXPIRED: "Instagram 토큰이 만료되어 다시 연결해야 합니다.",
  INSTAGRAM_SETTINGS_INVALID: "runtime의 instagram-settings.json을 확인하세요.",
  R2_UNREACHABLE: "R2 접근 또는 객체 확인에 실패했습니다. runtime 설정과 연결을 확인하세요.",
  RUN_ALREADY_EXECUTED: "이미 실행된 run입니다. 상태 조회 후 실패한 레인만 재개하세요.",
  RUN_LOCKED: "이 run의 다른 실행이 잠금을 보유하고 있습니다.",
  LANE_FAILED: "레인 실행에 실패했습니다. run의 단계와 오류 코드를 확인하세요.",
  INSTAGRAM_PUBLISH_UNKNOWN: "Instagram 게시 결과를 확인할 수 없습니다. 기존 게시 여부를 확인해야 합니다.",
  UPLOAD_OUTCOME_UNKNOWN: "YouTube 업로드 결과가 불명확합니다. 기존 영상 확인 전 재업로드하지 않습니다.",
});

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
// Never log provider exception messages, request URLs, headers, tokens, or stack traces.
function safeError(error, fallback = "LANE_FAILED") {
  const code = /^[A-Z][A-Z0-9_]+$/.test(error?.code ?? "") ? error.code : fallback;
  return { code, message: ERROR_MESSAGES[code] ?? code };
}
async function readJson(file, optional = false) {
  try { return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw fail(error.code === "ENOENT" ? "FILE_MISSING" : "JSON_INVALID");
  }
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function hashFile(file) {
  const before = await fs.stat(file).catch(() => { throw fail("VIDEO_MISSING"); });
  if (!before.isFile()) throw fail("VIDEO_MISSING");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const after = await fs.stat(file);
  if (["size", "mtimeMs", "ctimeMs", "ino"].some((key) => before[key] !== after[key])) {
    throw fail("VIDEO_SHA_MISMATCH");
  }
  return { sha256: hash.digest("hex"), size: after.size };
}
function isoTime(value, code = "PUBLISH_FILE_INVALID") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw fail(code);
  const day = value.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw fail(code);
  return new Date(value).toISOString();
}
function parseArgs(argv, { flags = [], values = [] } = {}) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (Object.hasOwn(result, name)) throw fail("CLI_INVALID");
    if (flags.includes(name)) result[name] = true;
    else if (values.includes(name) && argv[i + 1] && !argv[i + 1].startsWith("--")) result[name] = argv[++i];
    else throw fail("CLI_INVALID");
  }
  return result;
}
function emit(name, value) { process.stdout.write(`${name} ${JSON.stringify(value)}\n`); }
function cli(main) {
  main().catch((error) => {
    const safe = safeError(error);
    process.stderr.write(`SOCIAL_PUBLISH_FAILED ${safe.code} ${safe.message}\n`);
    process.exitCode = 1;
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
module.exports = { fs, path, execFileAsync, fail, safeError, readJson, writeJson, digest, hashFile, isoTime, parseArgs, emit, cli, sleep };
