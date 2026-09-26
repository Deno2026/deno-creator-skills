#!/usr/bin/env node
// DenoMCP가 공개 API로 내주는 것을 이 리포에 그대로 받아 적는다 — 노하우 창고 꾸러미 → skills/, 스타터 킷 → kits/starter/.
// 원본은 DenoMCP(denomcp.com)다. 여기 파일을 손으로 고치지 않는다 — 다음 동기화가 되돌린다.
// GitHub Action(.github/workflows/sync-from-denomcp.yml)이 매시 돌리고, 손으로는:
//   node tools/sync-from-denomcp.mjs [--only skills|kit] [--api https://api.denomcp.com] [--dry]
// 시각을 파일에 적지 않는다(같은 내용이면 같은 파일이어야 커밋이 생기지 않는다).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const API = flag("--api", process.env.DENOMCP_API || "https://api.denomcp.com").replace(/\/+$/, "");
const ONLY = flag("--only", "all");
const DRY = args.includes("--dry");
if (!["all", "skills", "kit"].includes(ONLY)) throw new Error("--only skills|kit");

async function getJson(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "deno-creator-skills-sync/1" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const lf = (s) => s.replace(/\r\n/g, "\n");
const text = (s) => (lf(s).endsWith("\n") ? lf(s) : `${lf(s)}\n`);
const json = (o) => `${JSON.stringify(o, null, 2)}\n`;
const cell = (s) => String(s ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();

/** 원하는 파일 상태: 폴더 → (상대경로 → 내용). 다 모은 뒤 디스크와 맞춘다. */
const plan = new Map();
function emit(folder, rel, content) {
  const clean = rel.replace(/\\/g, "/");
  if (path.isAbsolute(clean) || clean.split("/").some((seg) => seg === "" || seg === "..")) throw new Error(`path escapes target: ${rel}`);
  if (!plan.has(folder)) plan.set(folder, new Map());
  plan.get(folder).set(clean, content);
}

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs, base));
    else out.push(path.relative(base, abs).replace(/\\/g, "/"));
  }
  return out;
}

function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== ".git") removeEmptyDirs(path.join(dir, entry.name));
  }
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

/** 폴더를 계획대로 맞춘다: 다른 내용은 다시 쓰고, 계획에 없는 파일은 지운다(keep 제외). */
function reconcile(folder, keep = []) {
  const want = plan.get(folder) ?? new Map();
  const abs = path.join(ROOT, folder);
  const result = { written: [], deleted: [], unchanged: 0 };
  for (const [rel, content] of want) {
    const file = path.join(abs, rel);
    const current = fs.existsSync(file) ? lf(fs.readFileSync(file, "utf8")) : null;
    if (current === content) { result.unchanged++; continue; }
    result.written.push(rel);
    if (!DRY) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, "utf8"); }
  }
  for (const rel of listFiles(abs)) {
    if (want.has(rel) || keep.includes(rel)) continue;
    result.deleted.push(rel);
    if (!DRY) fs.rmSync(path.join(abs, rel));
  }
  if (!DRY) removeEmptyDirs(abs);
  return result;
}

// ---- 노하우 창고 → skills/<slug>.md (머리 블록 + 본문, 창고 원본과 같은 모양)
const KIND_LABEL = { workflow: "워크플로", technique: "기법", prompting: "프롬프팅", recipe: "레시피" };
const KIND_ORDER = Object.keys(KIND_LABEL);

function frontMatter(doc) {
  return [
    "---",
    `slug: ${doc.slug}`,
    `title: ${doc.title}`,
    `kind: ${doc.kind}`,
    `tags: ${doc.tags.join(", ")}`,
    `models: ${doc.models.join(", ")}`,
    `execution: ${doc.execution}`,
    `version: ${doc.version}`,
    `summary: ${doc.summary}`,
    "---",
  ].join("\n");
}

function indexMarkdown(index) {
  const lines = [
    "# 노하우 창고 편 목록",
    "",
    "DenoMCP 노하우 창고(에이전트 도구 `deno_knowhow_search`·`deno_knowhow_get`, 공개 API `GET /v1/knowhow`)에 있는 편을 그대로 옮긴 목록이다.",
    "편 하나가 파일 하나(`<slug>.md`)이며 머리 블록의 `version`이 창고의 판이다. 이 목록과 편 파일은 `tools/sync-from-denomcp.mjs`가 만든다 — 손으로 고치지 않는다.",
    "",
  ];
  for (const kind of KIND_ORDER) {
    const rows = index.filter((p) => p.kind === kind);
    if (rows.length === 0) continue;
    lines.push(`## ${KIND_LABEL[kind]} (${rows.length})`, "", "| 편 | 판 | 제목 | 요약 | 갱신 |", "|---|---|---|---|---|");
    for (const p of rows) {
      lines.push(`| [\`${p.slug}\`](${p.slug}.md) | ${cell(p.version)} | ${cell(p.title)} | ${cell(p.summary)} | ${String(p.updated_at).slice(0, 10)} |`);
    }
    lines.push("");
  }
  const unknown = index.filter((p) => !KIND_ORDER.includes(p.kind));
  if (unknown.length) {
    lines.push(`## 기타 (${unknown.length})`, "", "| 편 | 종류 | 판 | 제목 | 요약 | 갱신 |", "|---|---|---|---|---|---|");
    for (const p of unknown) lines.push(`| [\`${p.slug}\`](${p.slug}.md) | ${cell(p.kind)} | ${cell(p.version)} | ${cell(p.title)} | ${cell(p.summary)} | ${String(p.updated_at).slice(0, 10)} |`);
    lines.push("");
  }
  return lines.join("\n");
}

async function syncSkills() {
  const { results } = await getJson(`${API}/v1/knowhow`);
  const cards = [...results].sort((a, b) => a.slug.localeCompare(b.slug));
  const index = [];
  for (const card of cards) {
    const doc = await getJson(`${API}/v1/knowhow/${encodeURIComponent(card.slug)}`);
    const md = text(`${frontMatter(doc)}\n\n${doc.body_md.trim()}`);
    emit("skills", `${doc.slug}.md`, md);
    index.push({
      slug: doc.slug, title: doc.title, kind: doc.kind, version: doc.version, execution: doc.execution,
      tags: doc.tags, models: doc.models, summary: doc.summary, updated_at: doc.updated_at,
      file: `skills/${doc.slug}.md`, sha256: sha256(md),
    });
  }
  emit("skills", "INDEX.json", json({ source: `${API}/v1/knowhow`, count: index.length, packages: index }));
  emit("skills", "INDEX.md", text(indexMarkdown(index)));
  return index;
}

// ---- 스타터 킷 → kits/starter/ (ko 루트, en/ 아래)
async function syncKit() {
  const ko = await getJson(`${API}/v1/starter-kit?lang=ko`);
  const en = await getJson(`${API}/v1/starter-kit?lang=en`);
  const files = { ko: [], en: [] };
  for (const [lang, prefix, kit] of [["ko", "", ko], ["en", "en/", en]]) {
    for (const file of kit.files) {
      const rel = `${prefix}${file.path}`;
      emit("kits/starter", rel, text(file.content));
      files[lang].push(rel);
    }
  }
  const all = [...files.ko, ...files.en].map((rel) => `${rel}\n${plan.get("kits/starter").get(rel)}`).join("\n");
  emit("kits/starter", "KIT.json", json({
    source: `${API}/v1/starter-kit`, kit_version: ko.kit_version, ko: files.ko, en: files.en,
    how_to_apply: { ko: ko.how_to_apply, en: en.how_to_apply }, sha256: sha256(all),
  }));
  return ko.kit_version;
}

const summary = { api: API, dry: DRY };
const parts = [];
if (ONLY !== "kit") {
  const index = await syncSkills();
  summary.skills = { count: index.length, ...reconcile("skills", ["README.md"]) };
  parts.push(`skills ${index.length}편(갱신 ${summary.skills.written.length}·삭제 ${summary.skills.deleted.length})`);
}
if (ONLY !== "skills") {
  const version = await syncKit();
  summary.kit = { kit_version: version, ...reconcile("kits/starter") };
  parts.push(`kit v${version}(갱신 ${summary.kit.written.length}·삭제 ${summary.kit.deleted.length})`);
}
summary.line = parts.join(" · ");
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `summary=${summary.line}\n`);
console.log(JSON.stringify(summary, null, 2));
