import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
process.env.DENO_PRODUCTION_ROOT = repoRoot;
process.env.DENO_UPLOAD_HELPER_RUNTIME_ROOT = path.join(
  os.tmpdir(),
  `deno-extension-sync-runtime-${process.pid}`,
);
const extensionModule = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      "packages",
      "publishing-core",
      "tools",
      "extend_youtube_english_localizations.cjs",
    ),
  ).href
);
const {
  localizationUpdateRequestBody,
  verifyCaptionSourceAuthorityBinding,
  verifyPlaybackSyncApproval,
  verifyPrivacyStatusApproval,
} = extensionModule.default;

const requestDir = await mkdtemp(path.join(os.tmpdir(), "deno-sync-gate-smoke-"));
const manifest = {
  requestId: "sync-gate-request",
  sourceOfTruth: { sourceFingerprint: "fingerprint-1" },
  files: { video: { sha256: "AA11" } },
  captionAuthority: {
    slug: "sync-gate-slug",
    revisionId: "caption-1234567890abcdef12345678",
    finalKorean: { sha256: "CC33" },
    cleanKorean: { lockedSha256: "BB22" },
  },
  effectiveExpected: { privacyStatus: "unlisted" },
};
const sourceLockPreflight = {
  current: {
    slug: manifest.captionAuthority.slug,
    revision_id: "caption-source-lock-1234567890ab",
    files: {
      final_korean: { sha256: manifest.captionAuthority.finalKorean.sha256.toLowerCase() },
      clean_korean: {
        sha256: manifest.captionAuthority.cleanKorean.lockedSha256.toLowerCase(),
      },
    },
  },
};

async function writeApproval(value) {
  await writeFile(
    path.join(requestDir, "playback_sync_approval.json"),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

try {
  const readOnly = await verifyPlaybackSyncApproval(manifest, requestDir, "video-1", true);
  assert.equal(readOnly.readOnlyVerificationBypass, true);

  await assert.rejects(
    verifyPlaybackSyncApproval(manifest, requestDir, "video-1", false),
    /approval is missing/i,
  );

  const base = {
    requestId: manifest.requestId,
    sourceFingerprint: manifest.sourceOfTruth.sourceFingerprint,
    videoSha256: manifest.files.video.sha256.toLowerCase(),
    captionRevisionId: manifest.captionAuthority.revisionId,
    cleanKoreanSha256: manifest.captionAuthority.cleanKorean.lockedSha256.toLowerCase(),
    method: "user_confirmed_unlisted_youtube_playback",
    userExplicitApproval: true,
    videoId: "video-1",
  };
  await writeApproval(base);
  const accepted = await verifyPlaybackSyncApproval(manifest, requestDir, "video-1", false);
  assert.equal(accepted.videoId, "video-1");
  const acceptedBinding = verifyCaptionSourceAuthorityBinding(
    manifest,
    sourceLockPreflight,
    accepted,
  );
  assert.equal(acceptedBinding.verified, true);
  assert.equal(
    acceptedBinding.helperCaptionRevisionId,
    manifest.captionAuthority.revisionId,
  );
  assert.equal(
    acceptedBinding.sourceLockRevisionId,
    sourceLockPreflight.current.revision_id,
  );

  await writeApproval({
    ...base,
    method: "user_confirmed_private_youtube_playback",
  });
  const legacyPrivateAccepted = await verifyPlaybackSyncApproval(
    manifest,
    requestDir,
    "video-1",
    false,
  );
  assert.equal(legacyPrivateAccepted.videoId, "video-1");

  const adoptedPrivate = await verifyPrivacyStatusApproval(
    { privacyApproval: "" },
    manifest,
    "private",
  );
  assert.equal(adoptedPrivate.status, "private");
  assert.equal(adoptedPrivate.liveStatusAdoptedReadOnly, true);
  assert.equal(adoptedPrivate.changedSinceInitialUpload, true);

  const adoptedPublic = await verifyPrivacyStatusApproval(
    { privacyApproval: "" },
    manifest,
    "public",
  );
  assert.equal(adoptedPublic.status, "public");
  assert.equal(adoptedPublic.liveStatusAdoptedReadOnly, true);
  assert.equal(adoptedPublic.changedSinceInitialUpload, true);

  const privacyApprovalPath = path.join(requestDir, "legacy_privacy_approval.json");
  await writeFile(
    privacyApprovalPath,
    `${JSON.stringify({
      approvalType: "live_privacy_status",
      requestId: manifest.requestId,
      sourceFingerprint: manifest.sourceOfTruth.sourceFingerprint,
      videoId: "video-1",
      videoSha256: manifest.files.video.sha256.toLowerCase(),
      confirmedStatus: "private",
      userExplicitApproval: true,
      approvedBy: "user_explicit_chat_confirmation",
      approvedAt: "2026-08-31T00:00:00.000Z",
    }, null, 2)}\n`,
    "utf8",
  );
  const publicAfterLegacyPrivateEvidence = await verifyPrivacyStatusApproval(
    { videoId: "video-1", privacyApproval: privacyApprovalPath },
    manifest,
    "public",
  );
  assert.equal(publicAfterLegacyPrivateEvidence.status, "public");
  assert.equal(publicAfterLegacyPrivateEvidence.approvalMatchesCurrentLiveStatus, false);

  const localizationBody = localizationUpdateRequestBody("video-1", {
    en: { title: "English", description: "Description" },
  });
  assert.deepEqual(Object.keys(localizationBody).sort(), ["id", "localizations"]);
  assert.equal(Object.hasOwn(localizationBody, "status"), false);
  assert.equal(Object.hasOwn(localizationBody, "snippet"), false);

  await writeApproval({ ...base, videoId: "wrong-video" });
  await assert.rejects(
    verifyPlaybackSyncApproval(manifest, requestDir, "video-1", false),
    /videoId does not match/i,
  );

  await writeApproval({
    ...base,
    method: "user_confirmed_exact_helper_files",
    videoId: null,
  });
  const preuploadAccepted = await verifyPlaybackSyncApproval(
    manifest,
    requestDir,
    "video-created-later",
    false,
  );
  assert.equal(preuploadAccepted.method, "user_confirmed_exact_helper_files");

  const readOnlyBinding = verifyCaptionSourceAuthorityBinding(
    manifest,
    sourceLockPreflight,
    readOnly,
  );
  assert.equal(readOnlyBinding.playbackApprovalBypassedForReadOnlyVerification, true);

  assert.throws(
    () =>
      verifyCaptionSourceAuthorityBinding(
        manifest,
        {
          current: {
            ...sourceLockPreflight.current,
            slug: "stale-slug",
          },
        },
        accepted,
      ),
    /captionAuthority: slug/,
  );
  assert.throws(
    () =>
      verifyCaptionSourceAuthorityBinding(
        manifest,
        {
          current: {
            ...sourceLockPreflight.current,
            files: {
              ...sourceLockPreflight.current.files,
              final_korean: { sha256: "stale-final" },
            },
          },
        },
        accepted,
      ),
    /finalKoreanSha256/,
  );
  assert.throws(
    () =>
      verifyCaptionSourceAuthorityBinding(
        manifest,
        {
          current: {
            ...sourceLockPreflight.current,
            files: {
              ...sourceLockPreflight.current.files,
              clean_korean: { sha256: "stale-clean" },
            },
          },
        },
        accepted,
      ),
    /cleanKoreanSha256/,
  );
  assert.throws(
    () =>
      verifyCaptionSourceAuthorityBinding(
        manifest,
        sourceLockPreflight,
        { ...accepted, captionRevisionId: "caption-stale-helper" },
      ),
    /Playback sync approval revision/,
  );
  assert.throws(
    () =>
      verifyCaptionSourceAuthorityBinding(
        {
          ...manifest,
          execution: { captionRevisionId: "caption-stale-source-lock" },
        },
        sourceLockPreflight,
        accepted,
      ),
    /revision already bound/,
  );

  await writeApproval({ ...base, captionRevisionId: "caption-stale" });
  await assert.rejects(
    verifyPlaybackSyncApproval(manifest, requestDir, "video-1", false),
    /captionRevisionId/,
  );

  console.log(
    JSON.stringify({
      ok: true,
      writeWithoutSyncApprovalRejected: true,
      exactUnlistedPlaybackApprovalAccepted: true,
      legacyPrivatePlaybackApprovalAccepted: true,
      livePrivateAfterInitialUnlistedAdoptedReadOnly: true,
      livePublicAfterInitialUnlistedAdoptedReadOnly: true,
      staleOptionalPrivacyEvidenceDoesNotOverrideCurrentLiveStatus: true,
      localizationUpdateBodyContainsOnlyIdAndLocalizations: true,
      wrongVideoAndStaleRevisionRejected: true,
      exactHelperFilesFastPathAccepted: true,
      readOnlyVerificationBypassAccepted: true,
      sourceLockHelperAuthorityBindingAccepted: true,
      staleSourceLockAuthorityRejected: true,
    }),
  );
} finally {
  await rm(requestDir, { recursive: true, force: true });
}
