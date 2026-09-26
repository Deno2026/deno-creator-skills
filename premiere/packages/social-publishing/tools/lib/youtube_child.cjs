"use strict";

const { path, execFileAsync, fail, readJson } = require("./common.cjs");
function metadataArgs(manifest, metadataPath, ctx) {
  const args = ["--video", manifest.video.path, "--metadata-file", metadataPath, "--privacy", manifest.youtube.privacy, "--description-blocks", manifest.youtube.descriptionBlocks,
    "--expected-channel-id", ctx.settings.youtube.expectedChannelId];
  if (manifest.youtube.privacy === "scheduled") args.push("--publish-at", manifest.publishAt);
  return args;
}
function parseProtocol(stdout) {
  const records = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = /^(INSPECTION_COMPLETE|SHORTS_INSPECTION_READY|INSPECTION_READY|PREFLIGHT_COMPLETE|FINAL_RESULT) (\{.*\})$/.exec(line);
    if (match) { try { records.push({ type: match[1], value: JSON.parse(match[2]) }); } catch { throw fail("YOUTUBE_PROTOCOL_INVALID"); } }
  }
  return records;
}
async function youtubeChild(args, ctx, run = execFileAsync) {
  let output;
  try {
    output = await run(process.execPath, [path.join(ctx.productionRoot, "packages/publishing-core/tools/upload_private_short_from_path.cjs"), ...args], {
      env: ctx.env, cwd: ctx.productionRoot, windowsHide: true, timeout: 2 * 3600000, maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    if (error.code === 2 && parseProtocol(error.stdout).some((r) => r.type === "FINAL_RESULT")) output = { stdout: error.stdout, exitCode: 2 };
    else {
      // The uploader owns its recovery state; never forward raw child stderr (provider errors may include credentials).
      const stderr = String(error.stderr ?? "");
      const code = /channel mismatch|different YouTube channel/i.test(stderr) ? "YOUTUBE_CHANNEL_MISMATCH"
        : /UPLOAD_OUTCOME_UNKNOWN/.test(stderr) ? "UPLOAD_OUTCOME_UNKNOWN" : /PUBLISH_AT_TOO_SOON/.test(stderr) ? "PUBLISH_AT_TOO_SOON" : "YOUTUBE_CHILD_FAILED";
      throw fail(code);
    }
  }
  return { records: parseProtocol(output.stdout), exitCode: output.exitCode ?? 0 };
}
async function recoverYoutubeLink(state, ctx) {
  const directShortRunId = `private-short-${state.source.sha256}`;
  const direct = await readJson(path.join(ctx.uploadRuntime.directShortUploadsRoot, directShortRunId, "direct_short_request.json"), true);
  if (!direct || direct.source?.sha256 !== state.source.sha256) return { directShortRunId };
  return { directShortRunId, videoId: direct.execution?.videoId ?? null, shortsUrl: direct.execution?.shortsUrl ?? null, publishAt: direct.metadata?.publishAt ?? null, unknown: direct.execution?.state === "uploading_private_short" && !direct.execution?.videoId };
}
module.exports = { metadataArgs, parseProtocol, youtubeChild, recoverYoutubeLink };
