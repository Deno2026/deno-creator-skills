/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");

const appRoot = process.env.STUDIO_UPLOADER_APP_ROOT
  ? path.resolve(process.env.STUDIO_UPLOADER_APP_ROOT)
  : process.cwd();
const port = Number(process.env.PORT || 3000);
const hostname = "127.0.0.1";
const entryManifestPath = path.join(
  appRoot,
  "desktop-bundle",
  "server-entry.json",
);

async function start() {
  if (!fs.existsSync(entryManifestPath)) {
    throw new Error("Sterile standalone server entry manifest not found.");
  }
  const entry = JSON.parse(fs.readFileSync(entryManifestPath, "utf8"));
  if (
    entry?.schemaVersion !== 1 ||
    typeof entry.server !== "string" ||
    path.isAbsolute(entry.server) ||
    entry.server.split(/[\\/]/).includes("..")
  ) {
    throw new Error("Sterile standalone server entry manifest is invalid.");
  }
  const standaloneServer = path.join(
    appRoot,
    "desktop-bundle",
    ...entry.server.split("/"),
  );
  if (!fs.existsSync(standaloneServer)) {
    throw new Error("Sterile standalone server bundle not found.");
  }
  process.env.PORT = String(port);
  process.env.HOSTNAME = hostname;
  process.chdir(path.dirname(standaloneServer));
  require(standaloneServer);
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
