/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MEDIA_EXTENSIONS = new Set([
  ".avi",
  ".m4a",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".srt",
  ".wav",
  ".webm",
]);
const RUNTIME_SEGMENTS = new Set([".local"]);
const SECRET_FILE_PATTERN = /(?:oauth[-_.]?token|client[-_.]?secret|refresh[-_.]?token|credentials?)\.(?:json|txt)$/i;
const SECRET_CONTENT_PATTERNS = [
  /"(?:client_secret|refresh_token|access_token)"\s*:\s*"[^"\r\n]{8,}"/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bya29\.[A-Za-z0-9._-]{20,}\b/,
];
const LEGACY_ROOT_PATTERN = /[A-Za-z]:[\\/]DENO-Repos[\\/]deno-youtube-subtitle-assistant/gi;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /(?:^|["'`\s(])[A-Za-z]:[\\/]+(?:Users|DENO-Repos|DENO-Runtime)[\\/]+[^\r\n"'`]+/im;

function walk(root, ignoredNames = new Set()) {
  const files = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (ignoredNames.has(entry.name)) continue;
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        files.push({ path: target, symbolicLink: true, size: 0 });
      } else if (entry.isDirectory()) {
        queue.push(target);
      } else if (entry.isFile()) {
        files.push({
          path: target,
          symbolicLink: false,
          size: fs.statSync(target).size,
        });
      }
    }
  }
  return files;
}

function scanArtifactTree({ root, mode = "package", budgetBytes }) {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot)) {
    throw new Error(`SCAN_ROOT_MISSING: ${resolvedRoot}`);
  }
  const ignoredNames =
    mode === "source"
      ? new Set([".git", ".next", "desktop-bundle", "dist-desktop", "node_modules"])
      : new Set();
  const files = walk(resolvedRoot, ignoredNames);
  const issues = [];
  let totalBytes = 0;

  for (const file of files) {
    const relative = path.relative(resolvedRoot, file.path);
    const segments = relative.split(path.sep);
    totalBytes += file.size;
    if (file.symbolicLink) {
      issues.push(`${relative}: symbolic links are not allowed in packaged artifacts`);
      continue;
    }
    if (segments.some((segment) => RUNTIME_SEGMENTS.has(segment.toLowerCase()))) {
      issues.push(`${relative}: runtime directory is forbidden`);
    }
    if (mode === "package" && /^\.env(?:\.|$)/i.test(path.basename(file.path))) {
      issues.push(`${relative}: environment files are forbidden`);
    }
    if (mode === "package" && SECRET_FILE_PATTERN.test(path.basename(file.path))) {
      issues.push(`${relative}: credential or token file is forbidden`);
    }
    if (mode === "package" && MEDIA_EXTENSIONS.has(path.extname(file.path).toLowerCase())) {
      issues.push(`${relative}: user media/caption payload is forbidden`);
    }
    if (file.size > 256 * 1024 * 1024) {
      issues.push(`${relative}: individual file exceeds 256 MiB`);
    }

    if (file.size <= 8 * 1024 * 1024) {
      const data = fs.readFileSync(file.path);
      const text = data.includes(0) ? "" : data.toString("utf8");
      if (text) {
        if (LEGACY_ROOT_PATTERN.test(text)) {
          issues.push(`${relative}: legacy absolute repo path is embedded`);
        }
        LEGACY_ROOT_PATTERN.lastIndex = 0;
        for (const pattern of SECRET_CONTENT_PATTERNS) {
          if (pattern.test(text)) {
            issues.push(`${relative}: secret-like credential value is embedded`);
            break;
          }
        }
        if (
          mode === "package" &&
          !segments.includes("node_modules") &&
          WINDOWS_ABSOLUTE_PATH_PATTERN.test(text)
        ) {
          issues.push(`${relative}: Windows absolute path is embedded`);
        }
      }
    }
  }

  if (Number.isFinite(budgetBytes) && totalBytes > budgetBytes) {
    issues.push(
      `package size ${totalBytes} bytes exceeds budget ${budgetBytes} bytes`,
    );
  }

  return { root: resolvedRoot, mode, fileCount: files.length, totalBytes, issues };
}

function parseArgs(argv) {
  const args = { root: "", mode: "package", budgetMb: 1024 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--root") args.root = argv[++index] ?? "";
    else if (value === "--mode") args.mode = argv[++index] ?? "package";
    else if (value === "--budget-mb") args.budgetMb = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.root) throw new Error("--root is required");
  if (!new Set(["source", "package"]).has(args.mode)) {
    throw new Error("--mode must be source or package");
  }
  if (!Number.isFinite(args.budgetMb) || args.budgetMb <= 0) {
    throw new Error("--budget-mb must be positive");
  }
  return args;
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = scanArtifactTree({
      root: args.root,
      mode: args.mode,
      budgetBytes: args.budgetMb * 1024 * 1024,
    });
    if (result.issues.length > 0) {
      console.error(JSON.stringify(result, null, 2));
      process.exit(1);
    }
    console.log(
      `[artifact-safety] PASS ${result.fileCount} files, ${result.totalBytes} bytes`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = { scanArtifactTree };
