#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PACKAGE_NAME = "@adobe/premierepro";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex").toUpperCase();
}

const [rootPackage, adobePackage, manifest, installedTypes, vendoredTypes] =
  await Promise.all([
    readFile(path.join(REPO_ROOT, "package.json"), "utf8").then(JSON.parse),
    readFile(
      path.join(REPO_ROOT, "node_modules", "@adobe", "premierepro", "package.json"),
      "utf8",
    ).then(JSON.parse),
    readFile(
      path.join(REPO_ROOT, "extensions", "deno-premiere-uxp", "manifest.json"),
      "utf8",
    ).then(JSON.parse),
    readFile(
      path.join(
        REPO_ROOT,
        "node_modules",
        "@adobe",
        "premierepro",
        "src",
        "premierepro.d.ts",
      ),
    ),
    readFile(path.join(REPO_ROOT, "docs", "reference", "premierepro.d.ts")),
  ]);

const declaredVersion = rootPackage.devDependencies?.[PACKAGE_NAME];
const installedVersion = String(adobePackage.version || "");
const premiereHost = Array.isArray(manifest.host)
  ? manifest.host.find((entry) =>
      ["PPRO", "premierepro"].includes(String(entry?.app || "")),
    )
  : manifest.host;
const minimumVersion = String(premiereHost?.minVersion || "");

invariant(
  declaredVersion === installedVersion,
  `${PACKAGE_NAME} must be pinned exactly: package.json=${declaredVersion}, installed=${installedVersion}.`,
);
invariant(
  minimumVersion && installedVersion === minimumVersion,
  `Official type version must match the UXP manifest minimum: types=${installedVersion}, manifest=${minimumVersion}.`,
);
invariant(
  installedTypes.equals(vendoredTypes),
  "docs/reference/premierepro.d.ts drifted from the pinned official stable package.",
);

console.log(
  `Adobe Premiere UXP types verified: ${installedVersion}, SHA-256 ${sha256(installedTypes)}`,
);
