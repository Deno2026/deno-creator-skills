/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");

const { findProductionRoot } = require("../../../packages/runtime-paths");

// 다른 작업공간 사본에서 실행되는 것을 막는 목록. 개인 경로는 두지 않는다(2026-09-27) — 필요하면 DENO_FORBIDDEN_WORKSPACE_ROOTS에 ';'로 이어 적는다.
const forbiddenRoots = String(process.env.DENO_FORBIDDEN_WORKSPACE_ROOTS ?? "")
  .split(";")
  .map((item) => item.trim())
  .filter(Boolean)
  .map((item) => path.normalize(item).toLowerCase());

function realPathOrNormalized(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.normalize(target);
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const packageRoot = realPathOrNormalized(path.resolve(__dirname, ".."));
const currentDir = realPathOrNormalized(process.cwd());
const expectedRoot = path.join(
  findProductionRoot({ cwd: packageRoot }),
  "apps",
  "youtube-upload-helper",
);
const normalizedExpectedRoot = realPathOrNormalized(expectedRoot);
const lowerPackageRoot = path.normalize(packageRoot).toLowerCase();

const forbiddenHit = forbiddenRoots.find(
  (root) => lowerPackageRoot === root || lowerPackageRoot.startsWith(`${root}${path.sep}`),
);

if (forbiddenHit) {
  console.error("[workspace-guard] Blocked: package root is inside a forbidden project.");
  console.error(`[workspace-guard] package root: ${packageRoot}`);
  console.error(`[workspace-guard] forbidden: ${forbiddenHit}`);
  process.exit(1);
}

if (path.normalize(packageRoot).toLowerCase() !== path.normalize(normalizedExpectedRoot).toLowerCase()) {
  console.error("[workspace-guard] Blocked: this package is not the isolated Studio Uploader workspace.");
  console.error(`[workspace-guard] expected: ${normalizedExpectedRoot}`);
  console.error(`[workspace-guard] actual:   ${packageRoot}`);
  process.exit(1);
}

if (!isInside(normalizedExpectedRoot, currentDir)) {
  console.error("[workspace-guard] Blocked: command was launched from outside the isolated workspace.");
  console.error(`[workspace-guard] expected root: ${normalizedExpectedRoot}`);
  console.error(`[workspace-guard] current dir:   ${currentDir}`);
  process.exit(1);
}

console.log(`[workspace-guard] OK: ${normalizedExpectedRoot}`);
