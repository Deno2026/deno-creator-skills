/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const appRoot = process.cwd();
const monorepoRoot = path.resolve(appRoot, "..", "..");
const standaloneRoot = path.join(appRoot, ".next", "standalone");
const standaloneAppCandidates = [
  standaloneRoot,
  path.join(standaloneRoot, "apps", "youtube-upload-helper"),
];
const standaloneAppRoot = standaloneAppCandidates.find((candidate) =>
  fs.existsSync(path.join(candidate, "server.js")),
);

if (!standaloneAppRoot) {
  throw new Error("Next standalone app root was not found.");
}

for (const entry of [
  "src",
  "scripts",
  "electron",
  "public",
  "README.md",
  ".env.example",
  "eslint.config.mjs",
  "next.config.ts",
  "package-lock.json",
  "postcss.config.mjs",
  "tsconfig.json",
  "tsconfig.tsbuildinfo",
]) {
  fs.rmSync(path.join(standaloneAppRoot, entry), { recursive: true, force: true });
}

const sensitiveRoots = [appRoot, monorepoRoot];
  const encodedRoots = sensitiveRoots.flatMap((root) => [
  JSON.stringify(root).slice(1, -1),
  root,
  root.split(path.sep).join("/"),
]);
let replacedBuildRoots = 0;
const queue = [standaloneAppRoot];
while (queue.length > 0) {
  const current = queue.pop();
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) {
      queue.push(target);
      continue;
    }
    if (!entry.isFile() || entry.size > 8 * 1024 * 1024) continue;
    const bytes = fs.readFileSync(target);
    if (bytes.includes(0)) continue;
    let source = bytes.toString("utf8");
    let sanitized = source;
    for (const sensitiveRoot of encodedRoots) {
      if (!sensitiveRoot) continue;
      const pieces = sanitized.split(sensitiveRoot);
      if (pieces.length > 1) {
        replacedBuildRoots += pieces.length - 1;
        sanitized = pieces.join(".");
      }
    }
    if (sanitized !== source) fs.writeFileSync(target, sanitized, "utf8");
  }
}
if (replacedBuildRoots === 0) {
  throw new Error("Next standalone output did not contain the expected build root.");
}

console.log(
  `[sanitize-standalone] removed source-only files and ${replacedBuildRoots} build-root references`,
);
