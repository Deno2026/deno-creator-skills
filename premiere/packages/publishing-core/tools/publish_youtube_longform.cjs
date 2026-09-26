#!/usr/bin/env node

const { readFile, rename, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { getUploadRuntimePaths } = require("@deno/runtime-paths");
const { google } = require("googleapis");
const {
  isSponsoredRequest,
  validateStudioPublicationGate,
} = require("./lib/youtube_publication_gate.cjs");
const { channelRuntimePaths, resolveToolChannel } = require("./lib/youtube_channel.cjs");

function parseArgs(argv) {
  const args = { requestId: "", videoId: "", execute: false, expectedChannelId: "", channel: null };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--request-id") args.requestId = argv[++index] ?? "";
    else if (token === "--video-id") args.videoId = argv[++index] ?? "";
    else if (token === "--execute") args.execute = true;
    else if (token === "--expected-channel-id") args.expectedChannelId = argv[++index] ?? "";
    else if (token === "--channel") args.channel = argv[++index] ?? "";
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!args.requestId) throw new Error("--request-id is required");
  if (!args.videoId) throw new Error("--video-id is required");
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

function isoDurationSeconds(value) {
  const match = String(value ?? "").match(
    /^P(?:(\d+(?:\.\d+)?)D)?T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/u,
  );
  if (!match) throw new Error(`Unsupported ISO duration: ${value ?? "missing"}`);
  return (
    Number(match[1] ?? 0) * 86400 +
    Number(match[2] ?? 0) * 3600 +
    Number(match[3] ?? 0) * 60 +
    Number(match[4] ?? 0)
  );
}

function sortedTags(tags) {
  return [...(tags ?? [])].sort((left, right) => left.localeCompare(right));
}

function originalMetadataDifferences(expected, video) {
  const differences = [];
  if (video.snippet?.title !== expected.title) differences.push("title");
  if (video.snippet?.description !== expected.description) differences.push("description");
  if (video.snippet?.categoryId !== expected.categoryId) differences.push("categoryId");
  if (video.snippet?.defaultLanguage !== expected.defaultLanguage) differences.push("defaultLanguage");
  if (video.snippet?.defaultAudioLanguage !== expected.defaultAudioLanguage) {
    differences.push("defaultAudioLanguage");
  }
  if (JSON.stringify(sortedTags(video.snippet?.tags)) !== JSON.stringify(sortedTags(expected.tags))) {
    differences.push("tags");
  }
  return differences;
}

async function saveRefreshedToken(tokenPath, refreshed) {
  const existing = await readJson(tokenPath);
  await writeJsonAtomic(tokenPath, {
    ...existing,
    ...refreshed,
    refresh_token: refreshed.refresh_token ?? existing.refresh_token,
  });
}

async function getVideo(youtube, videoId) {
  const response = await youtube.videos.list({
    part: [
      "snippet",
      "status",
      "contentDetails",
      "localizations",
      "paidProductPlacementDetails",
    ],
    id: [videoId],
  });
  const video = response.data.items?.[0];
  if (!video) throw new Error(`Video not found: ${videoId}`);
  return video;
}

async function assertRequiredCaptionTracks(youtube, manifest, videoId) {
  if (manifest.captionPolicy?.mode === "none") return { notApplicable: true };
  const response = await youtube.captions.list({ part: ["id", "snippet"], videoId });
  const manual = (response.data.items ?? []).filter(
    (item) => item.snippet?.trackKind === "standard",
  );
  const korean = manual.filter((item) => item.snippet?.language === "ko");
  const english = manual.filter((item) => item.snippet?.language === "en");
  if (korean.length !== 1 || korean[0].snippet?.status !== "serving") {
    throw new Error("Exactly one serving Korean manual caption is required before public transition");
  }
  if (english.length !== 1 || english[0].snippet?.status !== "serving") {
    throw new Error("Exactly one serving English manual caption is required before public transition");
  }
  if (
    manifest.execution?.englishCaptionBodyVerified !== true ||
    manifest.execution?.localizationsVerified !== true
  ) {
    throw new Error("Reviewed English caption and metadata localization verification must complete first");
  }
  return { koreanCaptionId: korean[0].id, englishCaptionId: english[0].id };
}

async function main() {
  const args = parseArgs(process.argv);
  const runtimePaths = getUploadRuntimePaths();
  const { metadataConsistencyWarnings } = require("./lib/helper_ready_gate.cjs");
  const requestDir = path.join(runtimePaths.uploadRequestsRoot, args.requestId);
  const manifestPath = path.join(requestDir, "upload_request.json");
  const gatePath = path.join(requestDir, "youtube_studio_publication_gate.json");
  const [manifest, gate, settings] = await Promise.all([
    readJson(manifestPath),
    readJson(gatePath),
    readJson(runtimePaths.settingsPath),
  ]);
  // 공개 전환 채널 = READY에 기록된 채널(이전 READY는 DENO). 그 채널 칸의 토큰을 쓴다.
  const uploadChannel = resolveToolChannel({ channelArg: args.channel, manifest });
  const tokenPath = channelRuntimePaths(uploadChannel).oauthTokenPath;
  const token = await readJson(tokenPath);
  if (manifest.requestId !== args.requestId) throw new Error("Request ID mismatch");
  if (manifest.execution?.videoId !== args.videoId) throw new Error("Request video ID mismatch");

  const oauth = new google.auth.OAuth2(
    settings.clientId,
    settings.clientSecret,
    settings.redirectUri,
  );
  oauth.setCredentials(token);
  oauth.on("tokens", (refreshed) => {
    void saveRefreshedToken(tokenPath, refreshed).catch((error) => {
      process.stderr.write(`TOKEN_SAVE_WARNING ${error.message}\n`);
    });
  });
  const youtube = google.youtube({ version: "v3", auth: oauth });
  const channelResponse = await youtube.channels.list({ part: ["id"], mine: true });
  const channelId = channelResponse.data.items?.[0]?.id;
  if (!channelId) throw new Error("No YouTube channel is connected");
  if (args.expectedChannelId && channelId !== args.expectedChannelId) {
    throw new Error(`Connected channel mismatch: ${channelId}`);
  }
  if (channelId !== uploadChannel.youtubeChannelId) {
    throw new Error(
      `YOUTUBE_CHANNEL_MISMATCH: READY targets ${uploadChannel.title} (${uploadChannel.youtubeChannelId}), token belongs to ${channelId}`,
    );
  }

  let video = await getVideo(youtube, args.videoId);
  if (video.snippet?.channelId !== channelId) throw new Error("Video channel mismatch");
  if (!new Set(["unlisted", "public"]).has(video.status?.privacyStatus)) {
    throw new Error(`Unsupported publication baseline: ${video.status?.privacyStatus ?? "missing"}`);
  }
  const expectedOriginal = manifest.effectiveExpected ?? manifest.requestedExpected;
  const metadataDifferences = originalMetadataDifferences(expectedOriginal, video);
  if (metadataDifferences.length > 0) {
    throw new Error(`Protected Korean metadata changed: ${metadataDifferences.join(", ")}`);
  }
  const durationSeconds = isoDurationSeconds(video.contentDetails?.duration);
  const cleanKoreanPath = path.resolve(
    requestDir,
    manifest.captionAuthority?.cleanKorean?.requestPath ?? "subtitles/ko/ko.srt",
  );
  const cleanKoreanRaw = manifest.captionPolicy?.mode === "none"
    ? ""
    : await readFile(cleanKoreanPath, "utf8");
  const audiencePromiseRequired = metadataConsistencyWarnings(
    expectedOriginal.description,
    cleanKoreanRaw,
  ).some((warning) => warning.code === "AUDIENCE_PROMISE_FULFILLMENT_REQUIRED");
  const gateValidation = validateStudioPublicationGate({
    gate,
    manifest,
    videoId: args.videoId,
    durationSeconds,
    audiencePromiseRequired,
  });
  if (audiencePromiseRequired && gateValidation.audiencePromiseFulfilled !== true) {
    process.stderr.write(
      "PUBLICATION_ATTENTION Caption promises a link/file/skill follow-up; remind the user to fulfill it. This is an operational checklist, not a public-write blocker.\n",
    );
  }
  const captionEvidence = await assertRequiredCaptionTracks(youtube, manifest, args.videoId);
  const paidPromotionRequired = isSponsoredRequest(manifest);
  const paidPromotionLive =
    video.paidProductPlacementDetails?.hasPaidProductPlacement === true;
  if (paidPromotionRequired && !paidPromotionLive) {
    throw new Error("Sponsored video paid-promotion disclosure is not live in YouTube API");
  }

  process.stdout.write(
    `PUBLICATION_PREFLIGHT_OK video=${args.videoId} duration=${durationSeconds} ` +
      `monetization=${gate.monetization.enabled} midroll=${gate.monetization.midrollEnabled} ` +
      `paidPromotion=${paidPromotionLive} privacy=${video.status?.privacyStatus}\n`,
  );
  if (!args.execute) return;
  if (video.status?.privacyStatus === "unlisted") {
    const status = {
      privacyStatus: "public",
      embeddable: video.status.embeddable,
      license: video.status.license,
      publicStatsViewable: video.status.publicStatsViewable,
    };
    if (typeof video.status.selfDeclaredMadeForKids === "boolean") {
      status.selfDeclaredMadeForKids = video.status.selfDeclaredMadeForKids;
    }
    if (typeof video.status.containsSyntheticMedia === "boolean") {
      status.containsSyntheticMedia = video.status.containsSyntheticMedia;
    }
    await youtube.videos.update({
      part: ["status"],
      notifySubscribers: expectedOriginal.notifySubscribers !== false,
      requestBody: { id: args.videoId, status },
    });
  }

  video = await getVideo(youtube, args.videoId);
  const finalDifferences = originalMetadataDifferences(expectedOriginal, video);
  if (video.status?.privacyStatus !== "public") throw new Error("Public transition read-back failed");
  if (finalDifferences.length > 0) {
    throw new Error(`Korean metadata changed after public transition: ${finalDifferences.join(", ")}`);
  }
  if (
    paidPromotionRequired &&
    video.paidProductPlacementDetails?.hasPaidProductPlacement !== true
  ) {
    throw new Error("Paid-promotion disclosure disappeared after public transition");
  }

  const result = {
    schemaVersion: 1,
    videoId: args.videoId,
    privacyStatus: "public",
    publishedAt: video.snippet?.publishedAt ?? null,
    verifiedAt: new Date().toISOString(),
    studioGate: gateValidation,
    paidPromotionLive: video.paidProductPlacementDetails?.hasPaidProductPlacement ?? null,
    captions: captionEvidence,
    koreanMetadataDifferences: finalDifferences,
  };
  await writeJsonAtomic(path.join(requestDir, "youtube_publication_result.json"), result);
  manifest.execution = manifest.execution ?? {};
  manifest.execution.publicTransition = result;
  manifest.execution.state = "youtube_publication_verified_complete";
  manifest.status = manifest.execution.state;
  await writeJsonAtomic(manifestPath, manifest);
  process.stdout.write(`YOUTUBE_PUBLICATION_VERIFIED ${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`YOUTUBE_PUBLICATION_FAILED ${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  isoDurationSeconds,
  originalMetadataDifferences,
  parseArgs,
};
