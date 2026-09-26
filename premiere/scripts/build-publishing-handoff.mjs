import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {
  buildPublishingHandoff,
  publishingHandoffDigest,
} from "./lib/publishing-handoff.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {production: "", delivery: "", thumbnail: "", metadata: "", out: "", youtubeChannel: ""};
  const map = new Map([
    ["--production", "production"], ["--delivery", "delivery"],
    ["--thumbnail", "thumbnail"], ["--metadata", "metadata"], ["--out", "out"],
    ["--youtube-channel", "youtubeChannel"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return {...options, help: true};
    if (!map.has(flag) || index + 1 >= argv.length) throw new Error(`Unknown or incomplete option: ${flag}`);
    options[map.get(flag)] = argv[++index];
  }
  if (!options.production) throw new Error("--production is required");
  options.delivery ||= path.join(ROOT, "productions", options.production, "delivery", "master-manifest.json");
  options.out ||= path.join(ROOT, "productions", options.production, "publishing", "handoff.json");
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/build-publishing-handoff.mjs --production <slug> [--delivery <master-manifest.json>] [--thumbnail <thumbnail/package.json>] [--metadata <metadata.json>] [--youtube-channel denoise|denopictures] [--out <handoff.json>]",
    "",
    "Validates exact master/final-KO/optional selected-thumbnail hashes and creates a local Helper handoff.",
    "This command performs no Premiere, OAuth, or YouTube write.",
  ].join("\n");
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else {
    const handoff = buildPublishingHandoff({
      productionRoot: ROOT,
      production: options.production,
      deliveryManifestPath: options.delivery,
      thumbnailPackagePath: options.thumbnail || null,
      metadataPath: options.metadata || null,
      youtubeChannel: options.youtubeChannel || null,
    });
    const out = path.resolve(options.out);
    fs.mkdirSync(path.dirname(out), {recursive: true});
    const temporary = `${out}.building-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, out);
    console.log(JSON.stringify({out, digest: publishingHandoffDigest(handoff), readyForHelper: true}, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

export {parseArgs, usage};
