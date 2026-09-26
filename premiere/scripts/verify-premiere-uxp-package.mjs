import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PLUGIN_ROOT = path.join(
  REPO_ROOT,
  "extensions",
  "deno-premiere-uxp",
);
const SOURCE_MANIFEST_PATH = path.join(PLUGIN_ROOT, "manifest.json");
const DIST_ROOT = path.join(REPO_ROOT, "dist", "premiere-uxp");
// Keep this exclusion contract aligned with scripts/package-uxp-panel.mjs.
// manifest.json is excluded from the directory walk because the packager emits
// its canonical JSON serialization as a dedicated archive entry.
const PACKAGE_IGNORED_NAMES = new Set([
  ".DS_Store",
  ".gitignore",
  ".npmignore",
  ".uxprc",
  "manifest.json",
  "package-lock.json",
  "yarn.lock",
]);

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runTar(args) {
  const result = spawnSync("tar", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`tar 실행 실패: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `tar ${args[0]} 실패 (${result.status}): ${String(result.stderr || "").trim()}`,
    );
  }
  return result.stdout;
}

function runTarBytes(args) {
  const result = spawnSync("tar", args, {
    cwd: REPO_ROOT,
    encoding: null,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`tar 실행 실패: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `tar ${args[0]} 실패 (${result.status}): ${String(result.stderr || "").trim()}`,
    );
  }
  return result.stdout;
}

function archivePath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function isIntentionallyExcluded(entryName, relativePath) {
  return (
    entryName.startsWith(".") ||
    PACKAGE_IGNORED_NAMES.has(entryName) ||
    relativePath.startsWith("uxp-plugin-tests") ||
    relativePath.endsWith(".ccx") ||
    relativePath.endsWith(".xdx")
  );
}

async function collectPackageSourceFiles(root, current = root) {
  const directoryEntries = await readdir(current, { withFileTypes: true });
  const files = [];

  for (const entry of directoryEntries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = archivePath(root, absolutePath);
    if (isIntentionallyExcluded(entry.name, relativePath)) continue;

    invariant(
      !entry.isSymbolicLink(),
      `Package source contains a symbolic link: ${relativePath}`,
    );
    if (entry.isDirectory()) {
      files.push(...(await collectPackageSourceFiles(root, absolutePath)));
    } else if (entry.isFile()) {
      files.push({ absolutePath, relativePath });
    }
  }

  return files;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function formatEntryList(entries) {
  return entries.length > 0 ? entries.join(", ") : "(none)";
}

function isSafeArchiveEntry(name) {
  return (
    typeof name === "string" &&
    name !== "" &&
    !name.startsWith("/") &&
    !name.startsWith("\\") &&
    !/^[A-Za-z]:/.test(name) &&
    !name.split(/[\\/]/).includes("..")
  );
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--package") {
      options.packagePath = argv[++index];
      if (!options.packagePath) {
        throw new Error("--package requires a path.");
      }
    } else if (value === "--help" || value === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: node scripts/verify-premiere-uxp-package.mjs [--package <path>]",
    );
    return;
  }

  const sourceManifest = JSON.parse(
    await readFile(SOURCE_MANIFEST_PATH, "utf8"),
  );
  const sourceFiles = (await collectPackageSourceFiles(PLUGIN_ROOT)).sort(
    (left, right) => left.relativePath.localeCompare(right.relativePath, "en"),
  );
  const expectedEntries = [
    "manifest.json",
    ...sourceFiles.map((file) => file.relativePath),
  ];
  const defaultName =
    `${sourceManifest.id}-${sourceManifest.version}_${sourceManifest.host.app}.ccx`;
  const packagePath = path.resolve(
    options.packagePath || path.join(DIST_ROOT, defaultName),
  );
  const metadata = await stat(packagePath);
  invariant(metadata.isFile(), `UXP package is not a file: ${packagePath}`);

  const entryOutput = runTar(["-tf", packagePath]);
  const entries = entryOutput.split(/\r?\n/).filter(Boolean);
  invariant(entries.length > 10, "UXP package contains too few files.");
  invariant(
    entries.every(isSafeArchiveEntry),
    "UXP package contains an unsafe archive path.",
  );
  invariant(
    new Set(entries).size === entries.length,
    "UXP package contains duplicate archive paths.",
  );
  const archiveEntrySet = new Set(entries);
  const expectedEntrySet = new Set(expectedEntries);
  const missingEntries = expectedEntries.filter(
    (entry) => !archiveEntrySet.has(entry),
  );
  const unexpectedEntries = entries.filter(
    (entry) => !expectedEntrySet.has(entry),
  );
  invariant(
    missingEntries.length === 0 && unexpectedEntries.length === 0,
    "UXP package entry set does not match package-owned extension source. " +
      `Missing: ${formatEntryList(missingEntries)}. ` +
      `Unexpected: ${formatEntryList(unexpectedEntries)}.`,
  );

  const paritySources = [
    {
      relativePath: "manifest.json",
      bytes: Buffer.from(JSON.stringify(sourceManifest, null, 2), "utf8"),
    },
    ...sourceFiles.map((file) => ({
      relativePath: file.relativePath,
      absolutePath: file.absolutePath,
    })),
  ];
  for (const source of paritySources) {
    const sourceBytes =
      source.bytes || (await readFile(source.absolutePath));
    const packagedBytes = runTarBytes([
      "-xOf",
      packagePath,
      source.relativePath,
    ]);
    const sourceHash = sha256(sourceBytes);
    const packagedHash = sha256(packagedBytes);
    invariant(
      sourceBytes.length === packagedBytes.length &&
        sourceHash === packagedHash &&
        sourceBytes.equals(packagedBytes),
      `Packaged source parity failed for ${source.relativePath}: ` +
        `source=${sourceBytes.length} bytes/${sourceHash}, ` +
        `package=${packagedBytes.length} bytes/${packagedHash}.`,
    );
  }

  const packagedManifest = JSON.parse(
    runTar(["-xOf", packagePath, "manifest.json"]),
  );
  invariant(
    JSON.stringify(packagedManifest) === JSON.stringify(sourceManifest),
    "Packaged manifest does not exactly match the source manifest.",
  );
  invariant(
    packagedManifest.manifestVersion === 5,
    "Packaged manifestVersion must be 5.",
  );
  invariant(
    packagedManifest.host?.app === "premierepro",
    "Package must target Premiere Pro.",
  );
  invariant(
    packagedManifest.hostUIContext?.hideFromMenu === true,
    "Installed bridge must be invisible and launch with Premiere.",
  );
  invariant(
    packagedManifest.requiredPermissions?.localFileSystem === "plugin",
    "Installed bridge must stay within plugin filesystem permission.",
  );
  invariant(
    !packagedManifest.requiredPermissions?.network &&
      !packagedManifest.requiredPermissions?.launchProcess &&
      packagedManifest.requiredPermissions?.localFileSystem !== "fullAccess",
    "Installed bridge requests an unnecessary broad permission.",
  );

  const packagedIndex = runTar(["-xOf", packagePath, "index.js"]);
  invariant(
    packagedIndex.includes("plugin:") &&
      packagedIndex.includes("poller.start()") &&
      packagedIndex.includes("poller.stop()"),
    "Packaged bridge is missing plugin-level startup lifecycle hooks.",
  );

  const packageBytes = await readFile(packagePath);
  const packageSha256 = sha256(packageBytes);
  console.log(`Verified UXP package: ${packagePath}`);
  console.log(
    `Plugin ${packagedManifest.id} ${packagedManifest.version}; ` +
      `${entries.length} files with source byte/hash parity; ` +
      `${metadata.size} bytes; SHA-256 ${packageSha256}`,
  );
  console.log(
    "Autostart contract: hidden from menu, plugin lifecycle polling, plugin-only filesystem access.",
  );
}

main().catch((error) => {
  console.error(`UXP package verification failed: ${error.message}`);
  process.exitCode = 1;
});
