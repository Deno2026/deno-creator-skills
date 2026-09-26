#!/usr/bin/env node

"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DENO_UPLOAD_HELPER_RUNTIME_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "deno-backfill-policy-runtime-"),
);
const {
  buildPublicTabMembership,
  classifyShort,
  compareRowsNewestFirst,
  discoverPublicTabs,
  mergeUploadsWithPublicTabs,
  parseContentTypeOverrides,
  resolveActiveJobHold,
  resolveContentType,
  resolvePolicyBucket,
  stableUniqueVideoIds,
} = require("../tools/inventory_youtube_metadata_backfill.cjs");
const {
  assertInventoryBackfillEligibility,
  findInventoryRow,
} = require("../tools/audit_youtube_metadata_backfill.cjs");
const {
  assertBackfillEligibleSource,
  assertTargetIsNotActiveJob,
} = require("../tools/apply_youtube_metadata_backfill.cjs");

const VIDEO_A = "AAAAAAAAAAA";
const VIDEO_B = "BBBBBBBBBBB";
const VIDEO_C = "CCCCCCCCCCC";
const VIDEO_D = "DDDDDDDDDDD";

async function run() {
  assert.equal(resolveActiveJobHold({ active_job: null }), null);
  assert.deepEqual(
    resolveActiveJobHold({
      status: "private_korean_verified_awaiting_playback_sync",
      active_job: {
        video_id: "MUsAxbNgM08",
        slug: "ltx25_flux3_release_2026-08-12",
        stage: "private_korean_verified_awaiting_playback_sync",
      },
    }),
    {
      videoId: "MUsAxbNgM08",
      slug: "ltx25_flux3_release_2026-08-12",
      stage: "private_korean_verified_awaiting_playback_sync",
      status: "private_korean_verified_awaiting_playback_sync",
      reasonCode: "active_job_incomplete",
      reason: "CURRENT_STATE.json의 현재 신규 업로드 작업이 완료되어 active_job에서 제거될 때까지 일일 기존 영상 백필에서 보류",
      authority: "CURRENT_STATE.json",
    },
  );
  assert.throws(() => resolveActiveJobHold({ active_job: {} }), /valid video_id/);
  assert.throws(() => resolveActiveJobHold({ active_job: "invalid" }), /object or null/);

  assert.deepEqual(
    stableUniqueVideoIds([VIDEO_A, VIDEO_A, "invalid", VIDEO_B, VIDEO_A]),
    [VIDEO_A, VIDEO_B],
    "uploads IDs must be stable-deduplicated",
  );

  const successfulDiscovery = await discoverPublicTabs({
    channelUrl: "https://example.invalid/channel",
    runner: async (_url, tabName) => {
      if (tabName === "videos") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ entries: [{ id: VIDEO_A }, { id: VIDEO_A }, { id: "bad" }] }),
          stderr: "",
        };
      }
      if (tabName === "shorts") {
        return { exitCode: 0, stdout: JSON.stringify({ entries: [{ id: VIDEO_B }] }), stderr: "" };
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: "ERROR: This channel does not have a streams tab",
      };
    },
  });
  assert.equal(successfulDiscovery.mergeEnabled, true);
  assert.equal(successfulDiscovery.tabs.streams.status, "empty_no_streams_tab");
  assert.deepEqual(successfulDiscovery.tabs.videos.ids, [VIDEO_A]);
  assert.equal(successfulDiscovery.tabs.videos.invalidOrDuplicateEntryCount, 2);
  assert.deepEqual(
    mergeUploadsWithPublicTabs([VIDEO_C, VIDEO_C, VIDEO_A], successfulDiscovery),
    { ids: [VIDEO_C, VIDEO_A, VIDEO_B], tabOnlyVideoIds: [VIDEO_B] },
  );
  const memberships = buildPublicTabMembership(successfulDiscovery);
  assert.deepEqual([...memberships.get(VIDEO_A)], ["video"]);
  assert.deepEqual([...memberships.get(VIDEO_B)], ["short"]);

  const disabledDiscovery = await discoverPublicTabs({
    channelUrl: "https://example.invalid/channel",
    runner: async (_url, tabName) => tabName === "shorts"
      ? { exitCode: 2, stdout: "", stderr: "network unavailable" }
      : { exitCode: 0, stdout: JSON.stringify({ entries: [{ id: VIDEO_D }] }), stderr: "" },
  });
  assert.equal(disabledDiscovery.mergeEnabled, false);
  assert.match(disabledDiscovery.disabledReason, /shorts/);
  assert.deepEqual(
    mergeUploadsWithPublicTabs([VIDEO_A, VIDEO_A], disabledDiscovery),
    { ids: [VIDEO_A], tabOnlyVideoIds: [] },
    "any required discovery failure must disable all public-tab merging",
  );
  assert.equal(buildPublicTabMembership(disabledDiscovery).size, 0);

  const physicalVideo = classifyShort({
    snippet: { publishedAt: "2026-08-31T00:00:00Z" },
    contentDetails: { duration: "PT181S" },
  });
  const physicalShort = classifyShort({
    snippet: { publishedAt: "2026-08-31T00:00:00Z" },
    contentDetails: { duration: "PT20S" },
    fileDetails: { videoStreams: [{ widthPixels: 1080, heightPixels: 1920 }] },
  });
  const physicalUnknown = classifyShort({
    snippet: { publishedAt: "2026-08-31T00:00:00Z" },
    contentDetails: { duration: "PT20S" },
  });
  assert.equal(resolveContentType({ video: { status: { privacyStatus: "public" } }, physicalShort: physicalVideo }).contentType, "video");
  assert.equal(resolveContentType({ video: { status: { privacyStatus: "public" } }, physicalShort }).contentType, "short");
  assert.equal(resolveContentType({ video: { status: { privacyStatus: "public" } }, physicalShort: physicalUnknown }).contentType, "unknown");
  assert.equal(resolveContentType({
    video: { status: { privacyStatus: "public" } }, physicalShort: physicalUnknown, tabMembership: ["video"],
  }).contentType, "video");
  assert.equal(resolveContentType({
    video: { status: { privacyStatus: "public" } }, physicalShort: physicalVideo, tabMembership: ["video", "short"],
  }).contentType, "unknown", "conflicting public tabs must fail closed");

  const override = {
    contentType: "short",
    expectedPrivacyStatus: "private",
    authority: "youtube_studio_live_read",
    observedAt: "2026-08-31",
    reason: "Studio evidence",
  };
  assert.equal(resolveContentType({
    video: { status: { privacyStatus: "private" } }, physicalShort: physicalVideo,
    tabMembership: ["video", "short"], override,
  }).contentType, "short", "an exact private/unlisted Studio override must have highest precedence");
  assert.equal(resolveContentType({
    video: { status: { privacyStatus: "public" } }, physicalShort: physicalVideo, override,
  }).contentType, "unknown", "a stale privacy override must fail closed");

  const parsedOverrides = parseContentTypeOverrides({
    schemaVersion: 1,
    observedAt: "2026-08-31",
    overrides: [{ videoId: VIDEO_A, ...override }],
  });
  assert.equal(parsedOverrides.overrides.get(VIDEO_A).contentType, "short");
  assert.throws(() => parseContentTypeOverrides({ schemaVersion: 1, observedAt: "2026-08-31", overrides: [
    { videoId: VIDEO_A, ...override }, { videoId: VIDEO_A, ...override },
  ] }), /Duplicate/);

  const userExclusion = { reason: "user" };
  const activeDeferral = { reason: "active" };
  assert.equal(resolvePolicyBucket({ candidateExclusion: userExclusion, activeJobDeferral: activeDeferral, contentType: "short" }), "excluded_user");
  assert.equal(resolvePolicyBucket({ candidateExclusion: null, activeJobDeferral: activeDeferral, contentType: "short" }), "deferred_active_job");
  assert.equal(resolvePolicyBucket({ candidateExclusion: null, activeJobDeferral: null, contentType: "short" }), "excluded_short");
  assert.equal(resolvePolicyBucket({ candidateExclusion: null, activeJobDeferral: null, contentType: "live" }), "excluded_live");
  assert.equal(resolvePolicyBucket({ candidateExclusion: null, activeJobDeferral: null, contentType: "unknown" }), "excluded_unknown");
  assert.equal(resolvePolicyBucket({ candidateExclusion: null, activeJobDeferral: null, contentType: "video" }), "eligible_video");

  const sorted = [
    { videoId: VIDEO_C, publishedAt: "2026-01-01T00:00:00Z" },
    { videoId: VIDEO_B, publishedAt: "2026-02-01T00:00:00Z" },
    { videoId: VIDEO_A, publishedAt: "2026-02-01T00:00:00Z" },
  ].sort(compareRowsNewestFirst);
  assert.deepEqual(sorted.map((row) => row.videoId), [VIDEO_A, VIDEO_B, VIDEO_C]);

  assert.doesNotThrow(() => assertTargetIsNotActiveJob("QPBaMODWISM", { active_job: null }));
  assert.doesNotThrow(() => assertTargetIsNotActiveJob("QPBaMODWISM", { active_job: { video_id: "MUsAxbNgM08" } }));
  assert.throws(() => assertTargetIsNotActiveJob("MUsAxbNgM08", { active_job: { video_id: "MUsAxbNgM08" } }), /cannot target CURRENT_STATE active_job video/);

  const capturedAt = "2026-08-31T00:00:00.000Z";
  const eligibleRow = {
    videoId: VIDEO_A,
    contentType: "video",
    policyBucket: "eligible_video",
    isShort: false,
    eligibleForBackfill: true,
  };
  const eligibleInventory = {
    schemaVersion: 5,
    capturedAt,
    pendingVideos: [eligibleRow],
    completedVideos: [], excludedUserVideos: [], deferredActiveJobVideos: [],
    excludedShortVideos: [], excludedLiveVideos: [], excludedUnknownShortRiskVideos: [],
  };
  const eligibleSource = {
    videoId: VIDEO_A,
    backfillEligibility: {
      inventorySchemaVersion: 5,
      inventoryCapturedAt: capturedAt,
      contentType: "video",
      policyBucket: "eligible_video",
      isShort: false,
      eligibleForBackfill: true,
    },
  };
  assert.equal(findInventoryRow(eligibleInventory, VIDEO_A).collection, "pendingVideos");
  assert.equal(assertInventoryBackfillEligibility(eligibleInventory, VIDEO_A), eligibleRow);
  assert.doesNotThrow(() => assertBackfillEligibleSource(eligibleSource, eligibleInventory));

  for (const [contentType, collection, policyBucket] of [
    ["short", "excludedShortVideos", "excluded_short"],
    ["live", "excludedLiveVideos", "excluded_live"],
  ]) {
    const row = { ...eligibleRow, contentType, policyBucket, isShort: contentType === "short", eligibleForBackfill: false };
    const inventory = { ...eligibleInventory, pendingVideos: [], [collection]: [row] };
    assert.throws(
      () => assertInventoryBackfillEligibility(inventory, VIDEO_A),
      /not an eligible pending standard video/,
      `${contentType} must never pass the audit eligibility gate`,
    );
  }
  assert.throws(
    () => assertInventoryBackfillEligibility({ ...eligibleInventory, schemaVersion: 4 }, VIDEO_A),
    /schemaVersion 5/,
  );
  assert.throws(
    () => assertBackfillEligibleSource({
      ...eligibleSource,
      backfillEligibility: { ...eligibleSource.backfillEligibility, inventorySchemaVersion: 4 },
    }, eligibleInventory),
    /lacks eligible non-Short standard-video inventory evidence/,
  );
  assert.throws(
    () => assertBackfillEligibleSource(eligibleSource, { ...eligibleInventory, capturedAt: "stale" }),
    /changed after the protected source snapshot/,
  );

  process.stdout.write("YOUTUBE_METADATA_BACKFILL_INVENTORY_POLICY_OK\n");
}

run().catch((error) => {
  process.stderr.write(`YOUTUBE_METADATA_BACKFILL_INVENTORY_POLICY_FAILED ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
