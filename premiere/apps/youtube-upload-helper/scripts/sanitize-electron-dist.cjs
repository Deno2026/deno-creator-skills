/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const distRoot = path.join(process.cwd(), "dist-desktop");
for (const file of ["builder-debug.yml", "builder-effective-config.yaml"]) {
  fs.rmSync(path.join(distRoot, file), { force: true });
}

console.log("[sanitize-electron-dist] removed local build diagnostics");
