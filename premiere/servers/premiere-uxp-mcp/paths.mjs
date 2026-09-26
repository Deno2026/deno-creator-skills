// Premiere 제어 경로 해석 — 한 곳에서만 정한다(2026-09-27, Deno Creator Skills 키트 추출).
// 우선순위: 환경변수 → 리포 안 vendor/premiere-pro-mcp(패치본) → node_modules/premiere-pro-mcp.
// 임시 폴더(CEP 브리지 명령 파일 교환)는 환경변수 → OS 임시 폴더/premiere-mcp-bridge. CEP 패널(main.js)도 같은 규칙으로 잡는다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 리포(또는 키트) 루트 — servers/premiere-uxp-mcp/ 의 두 단계 위. */
export const REPO_ROOT = path.resolve(HERE, "..", "..");

export const BRIDGE_DIR_NAME = "premiere-mcp-bridge";

/** CEP 브리지 임시 폴더 기본값: <OS 임시 폴더>/premiere-mcp-bridge (Windows: %LOCALAPPDATA%\Temp\premiere-mcp-bridge). */
export const DEFAULT_TEMP_DIR = path.join(os.tmpdir(), BRIDGE_DIR_NAME);

function hasPackageJson(dir) {
  try {
    return fs.statSync(path.join(dir, "package.json")).isFile();
  } catch {
    return false;
  }
}

/** premiere-pro-mcp(업스트림 CEP 브리지 패키지) 후보 — 앞이 우선. */
export function mcpRootCandidates() {
  return [
    process.env.PREMIERE_MCP_ROOT,
    path.join(REPO_ROOT, "vendor", "premiere-pro-mcp"),
    path.join(REPO_ROOT, "node_modules", "premiere-pro-mcp"),
  ].filter(Boolean);
}

/** 존재하는 첫 후보. 하나도 없으면 vendor 경로(오류 메시지에 그 경로가 보이도록). */
export function resolveMcpRoot(explicit) {
  if (explicit) return explicit;
  const candidates = mcpRootCandidates();
  return candidates.find(hasPackageJson) || candidates.find((c) => c !== process.env.PREMIERE_MCP_ROOT) || candidates[0];
}

export function resolveTempDir(explicit) {
  return explicit || process.env.PREMIERE_TEMP_DIR || DEFAULT_TEMP_DIR;
}

/** 옛 이름 호환 — 모듈 적재 시점에 한 번 해석한 업스트림 패키지 경로. */
export const DEFAULT_UPSTREAM_ROOT = resolveMcpRoot();
export const DEFAULT_MCP_ROOT = DEFAULT_UPSTREAM_ROOT;
