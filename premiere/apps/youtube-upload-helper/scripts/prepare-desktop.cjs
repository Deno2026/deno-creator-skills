/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");

const { scanArtifactTree } = require("./artifact-safety.cjs");

const root = process.cwd();
const standaloneRoot = path.join(root, ".next", "standalone");
const nextStaticRoot = path.join(root, ".next", "static");
const publicRoot = path.join(root, "public");
const desktopBundleRoot = path.join(root, "desktop-bundle");
const desktopServerRoot = path.join(desktopBundleRoot, "server");
const standaloneServerCandidates = [
  path.join(standaloneRoot, "server.js"),
  path.join(standaloneRoot, "apps", "youtube-upload-helper", "server.js"),
];
const standaloneServerScript = standaloneServerCandidates.find((candidate) =>
  fs.existsSync(candidate),
);

function resetDir(target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
}

if (!fs.existsSync(standaloneRoot)) {
  throw new Error("Next standalone output not found. Run next build first.");
}

if (!standaloneServerScript) {
  throw new Error(
    "Next standalone server.js not found. The build is incomplete or stale; rerun next build before packaging.",
  );
}

const standaloneScan = scanArtifactTree({
  root: standaloneRoot,
  mode: "package",
  budgetBytes: 900 * 1024 * 1024,
});
if (standaloneScan.issues.length > 0) {
  throw new Error(`Unsafe standalone output:\n${standaloneScan.issues.join("\n")}`);
}

resetDir(desktopBundleRoot);
fs.cpSync(standaloneRoot, desktopServerRoot, { recursive: true, force: true });
const standaloneEntryRelative = path.relative(standaloneRoot, standaloneServerScript);
const desktopAppRoot = path.dirname(
  path.join(desktopServerRoot, standaloneEntryRelative),
);
const desktopNextRoot = path.join(desktopAppRoot, ".next");
fs.writeFileSync(
  path.join(desktopBundleRoot, "server-entry.json"),
  `${JSON.stringify({
    schemaVersion: 1,
    server: path.join("server", standaloneEntryRelative).split(path.sep).join("/"),
  }, null, 2)}\n`,
  "utf8",
);

// Next standalone output does not include static chunks; copy them explicitly
// so packaged Electron builds can load CSS, fonts, and client-side bundles.
if (fs.existsSync(nextStaticRoot)) {
  fs.mkdirSync(desktopNextRoot, { recursive: true });
  fs.cpSync(nextStaticRoot, path.join(desktopNextRoot, "static"), {
    recursive: true,
    force: true,
  });
}

if (fs.existsSync(publicRoot)) {
  fs.cpSync(publicRoot, path.join(desktopAppRoot, "public"), {
    recursive: true,
    force: true,
  });
}

const bundleScan = scanArtifactTree({
  root: desktopBundleRoot,
  mode: "package",
  budgetBytes: 900 * 1024 * 1024,
});
if (bundleScan.issues.length > 0) {
  resetDir(desktopBundleRoot);
  throw new Error(`Unsafe desktop bundle:\n${bundleScan.issues.join("\n")}`);
}

console.log("Desktop bundle assets prepared.");
