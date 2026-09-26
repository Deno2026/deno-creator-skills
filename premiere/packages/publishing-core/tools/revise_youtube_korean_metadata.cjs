#!/usr/bin/env node
// Revise the Korean description and/or tags of an already-uploaded Helper video without re-uploading.
// The READY's effectiveExpected is the protected baseline: the live snippet must still equal it before
// the write, and it is advanced to the new values afterwards so later tools (extend/publish) verify
// against the revised metadata. Evidence: <request-dir>/verification/korean_metadata_revision_<n>.json.
//
//   node revise_youtube_korean_metadata.cjs --request-dir <dir> --video-id <id> \
//     --description <file.txt> [--tags <file.json>] --reason "<why>" [--execute]
const path = require("node:path");
const { createHash } = require("node:crypto");
const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const { getUploadRuntimePaths } = require("@deno/runtime-paths");
const { google } = require("googleapis");
const {
  assertYouTubeChannel,
  channelRuntimePaths,
  descriptionLinkRequirements,
  resolveToolChannel,
} = require("./lib/youtube_channel.cjs");

const RUNTIME_PATHS = getUploadRuntimePaths();
const { getDescriptionBlocks } = require("@deno/runtime-paths");
const COMFY_REFERRAL_URL = getDescriptionBlocks().comfyReferral.url;
const DENO_DISCORD_URL = getDescriptionBlocks().discord.url;
const TAG_CHAR_LIMIT = 500;

function parseArgs(argv) {
  const args = { requestDir: "", videoId: "", description: "", tags: "", reason: "", execute: false, channel: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--request-dir") args.requestDir = argv[++i] ?? "";
    else if (a === "--video-id") args.videoId = argv[++i] ?? "";
    else if (a === "--description") args.description = argv[++i] ?? "";
    else if (a === "--tags") args.tags = argv[++i] ?? "";
    else if (a === "--reason") args.reason = argv[++i] ?? "";
    else if (a === "--execute") args.execute = true;
    else if (a === "--channel") args.channel = argv[++i] ?? "";
  }
  if (!args.requestDir || !args.videoId) throw new Error("--request-dir and --video-id are required");
  if (!args.description && !args.tags) throw new Error("--description and/or --tags is required");
  if (!args.reason.trim()) throw new Error("--reason is required");
  return args;
}
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
async function writeJsonAtomic(p, v) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(`${p}.tmp`, `${JSON.stringify(v, null, 2)}\n`, "utf8");
  await rename(`${p}.tmp`, p);
}
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const sortedTags = (t) => [...(t ?? [])].sort((a, b) => a.localeCompare(b));
// YouTube counts a tag containing spaces as quoted, plus one separator per tag.
const tagChars = (tags) => tags.reduce((n, t) => n + t.length + (t.includes(" ") ? 2 : 0), 0) + Math.max(0, tags.length - 1);

function snippetDifferences(expected, video) {
  const d = [];
  if (video.snippet?.title !== expected.title) d.push("title");
  if (video.snippet?.description !== expected.description) d.push("description");
  if (JSON.stringify(sortedTags(video.snippet?.tags)) !== JSON.stringify(sortedTags(expected.tags))) d.push("tags");
  if (video.snippet?.categoryId !== expected.categoryId) d.push("categoryId");
  if (video.snippet?.defaultLanguage !== expected.defaultLanguage) d.push("defaultLanguage");
  return d;
}

async function main() {
  const args = parseArgs(process.argv);
  const requestDir = path.resolve(args.requestDir);
  const manifestPath = path.join(requestDir, "upload_request.json");
  const manifest = await readJson(manifestPath);
  if (manifest.source !== "youtube-upload-helper") throw new Error("Not a Helper request");
  if (manifest.execution?.videoId !== args.videoId) throw new Error(`Manifest video mismatch: ${manifest.execution?.videoId}`);
  const expected = manifest.effectiveExpected ?? manifest.requestedExpected;
  if (!expected) throw new Error("Manifest has no expected Korean metadata");
  // 수정 채널 = READY에 기록된 채널(이전 READY는 DENO). 링크 규칙·토큰·채널 대조가 모두 이 채널 기준이다.
  const uploadChannel = resolveToolChannel({ channelArg: args.channel, manifest });
  const linkRules = descriptionLinkRequirements(uploadChannel, {
    noAffiliateLinks: expected.noAffiliateLinks === true,
  });

  const next = { ...expected };
  if (args.description) next.description = (await readFile(args.description, "utf8")).replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (args.tags) next.tags = await readJson(args.tags);
  if (next.description === expected.description && JSON.stringify(next.tags) === JSON.stringify(expected.tags)) {
    throw new Error("Nothing to revise: description and tags equal the current expected values");
  }
  // Protected-content checks (same invariants the extend/publish tools enforce).
  if (next.description.length > 5000) throw new Error("Description exceeds 5000 characters");
  const hasReferral = COMFY_REFERRAL_URL ? next.description.includes(COMFY_REFERRAL_URL) : false;
  if (COMFY_REFERRAL_URL && (linkRules.affiliateAllowed ? !hasReferral : hasReferral)) {
    throw new Error("Revised description breaks the ComfyUI referral-link rule");
  }
  if (DENO_DISCORD_URL && linkRules.discordRequired && !next.description.includes(DENO_DISCORD_URL)) {
    throw new Error("Revised description is missing the Deno Discord link");
  }
  const firstUrl = expected.description.split("\n")[0].match(/https?:\/\/\S+/)?.[0];
  if (firstUrl && !next.description.split("\n")[0].includes(firstUrl)) throw new Error("Revised description moved the first-line campaign link");
  if (!Array.isArray(next.tags) || next.tags.some((t) => typeof t !== "string" || !t.trim())) throw new Error("Tags must be non-empty strings");
  if (new Set(next.tags).size !== next.tags.length) throw new Error("Duplicate tags");
  if (tagChars(next.tags) > TAG_CHAR_LIMIT) throw new Error(`Tags exceed ${TAG_CHAR_LIMIT} characters (${tagChars(next.tags)})`);

  const tokenPath = channelRuntimePaths(uploadChannel).oauthTokenPath;
  const [settings, token] = await Promise.all([readJson(RUNTIME_PATHS.settingsPath), readJson(tokenPath)]);
  const oauth = new google.auth.OAuth2(settings.clientId, settings.clientSecret, settings.redirectUri);
  oauth.setCredentials(token);
  oauth.on("tokens", (t) => {
    void readJson(tokenPath)
      .then((e) => writeJsonAtomic(tokenPath, { ...e, ...t, refresh_token: t.refresh_token ?? e.refresh_token }))
      .catch(() => {});
  });
  const youtube = google.youtube({ version: "v3", auth: oauth });
  await assertYouTubeChannel(youtube, uploadChannel);
  const getVideo = async () => {
    const r = await youtube.videos.list({ part: ["snippet", "status"], id: [args.videoId] });
    const v = r.data.items?.[0];
    if (!v) throw new Error(`Video not found: ${args.videoId}`);
    return v;
  };
  let video = await getVideo();
  const before = snippetDifferences(expected, video);
  // A previous run may have written the revision but failed read-back (propagation lag): accept the live == next case.
  const alreadyApplied = before.length > 0 && snippetDifferences(next, video).length === 0;
  if (before.length && !alreadyApplied) throw new Error(`Live Korean metadata already differs from the protected baseline: ${before.join(", ")} - inspect before revising`);
  const removedTags = expected.tags.filter((t) => !next.tags.includes(t));
  const addedTags = next.tags.filter((t) => !expected.tags.includes(t));
  process.stdout.write(
    `REVISION_PREFLIGHT_OK video=${args.videoId} privacy=${video.status?.privacyStatus} descriptionChars=${expected.description.length}->${next.description.length} tags=${expected.tags.length}->${next.tags.length} tagChars=${tagChars(next.tags)} added=${JSON.stringify(addedTags)} removed=${JSON.stringify(removedTags)}\n`,
  );
  if (!args.execute) return;

  if (!alreadyApplied) await youtube.videos.update({
    part: ["snippet"],
    requestBody: {
      id: args.videoId,
      snippet: {
        title: next.title,
        description: next.description,
        tags: next.tags,
        categoryId: next.categoryId,
        defaultLanguage: next.defaultLanguage,
        defaultAudioLanguage: next.defaultAudioLanguage,
      },
    },
  });
  // videos.list can lag behind videos.update by a few seconds; retry before declaring a mismatch.
  let after = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt) await new Promise((r) => setTimeout(r, 5000));
    video = await getVideo();
    after = snippetDifferences(next, video);
    if (!after.length) break;
  }
  if (after.length) throw new Error(`Read-back after revision differs: ${after.join(", ")}`);

  const revisions = manifest.execution.koreanMetadataRevisions ?? [];
  const n = revisions.length + 1;
  const evidence = {
    schemaVersion: 1,
    revision: n,
    videoId: args.videoId,
    revisedAt: new Date().toISOString(),
    reason: args.reason,
    before: { descriptionSha256: sha256(expected.description), tagCount: expected.tags.length },
    after: { descriptionSha256: sha256(next.description), tagCount: next.tags.length, tagChars: tagChars(next.tags) },
    addedTags,
    removedTags,
    descriptionSource: args.description ? path.resolve(args.description) : null,
    tagsSource: args.tags ? path.resolve(args.tags) : null,
    readBackVerified: true,
    writeSkippedBecauseAlreadyLive: alreadyApplied,
  };
  const evidencePath = path.join(requestDir, "verification", `korean_metadata_revision_${n}.json`);
  await writeJsonAtomic(evidencePath, evidence);
  manifest.effectiveExpected = { ...expected, description: next.description, tags: next.tags };
  manifest.execution.koreanMetadataRevisions = [...revisions, { revision: n, evidencePath, revisedAt: evidence.revisedAt, reason: args.reason }];
  manifest.execution.metadataVerified = true;
  await writeJsonAtomic(manifestPath, manifest);
  process.stdout.write(`KOREAN_METADATA_REVISED revision=${n} evidence=${evidencePath}\n`);
}
main().catch((e) => {
  process.stderr.write(`ERROR ${e.message}\n`);
  process.exitCode = 1;
});
