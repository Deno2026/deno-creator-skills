const assert = require("node:assert/strict");

const {
  LONGFORM_MIDROLL_THRESHOLD_SECONDS,
  validateStudioPublicationGate,
} = require("../tools/lib/youtube_publication_gate.cjs");
const {
  isoDurationSeconds,
} = require("../tools/publish_youtube_longform.cjs");

const nowMs = Date.parse("2026-09-02T11:00:00Z");
const manifest = {
  requestId: "request-1",
  sourceOfTruth: { sourceFingerprint: "fingerprint-1" },
  effectiveExpected: { brandApprovalRequired: true },
};
const validGate = {
  schemaVersion: 1,
  source: "youtube_studio_live_read",
  observedAt: "2026-09-02T10:55:00Z",
  requestId: "request-1",
  sourceFingerprint: "fingerprint-1",
  videoId: "video-1",
  durationSeconds: 676,
  saveState: "saved",
  monetization: { enabled: true, midrollEnabled: true },
  paidPromotion: { checked: true },
  audiencePromises: { fulfilled: true, verifiedLocations: ["pinned-comment"] },
  publicApproval: {
    approved: true,
    authority: "user_explicit_chat_confirmation",
  },
};

assert.equal(LONGFORM_MIDROLL_THRESHOLD_SECONDS, 480);
assert.equal(isoDurationSeconds("PT11M16S"), 676);
assert.equal(isoDurationSeconds("PT1H2M3.5S"), 3723.5);
assert.equal(
  validateStudioPublicationGate({
    gate: validGate,
    manifest,
    videoId: "video-1",
    durationSeconds: 676,
    audiencePromiseRequired: true,
    nowMs,
  }).ok,
  true,
);

for (const [name, mutation, pattern] of [
  [
    "monetization",
    { monetization: { enabled: false, midrollEnabled: true } },
    /monetization is not enabled/u,
  ],
  [
    "midroll",
    { monetization: { enabled: true, midrollEnabled: false } },
    /mid-roll ads are not enabled/u,
  ],
  ["paid promotion", { paidPromotion: { checked: false } }, /paid-promotion disclosure/u],
  ["save", { saveState: "unsaved" }, /changes are not saved/u],
  [
    "approval",
    { publicApproval: { approved: false, authority: null } },
    /explicit user approval/u,
  ],
  ["stale", { observedAt: "2026-09-02T10:00:00Z" }, /evidence is stale/u],
]) {
  assert.throws(
    () =>
      validateStudioPublicationGate({
        gate: { ...validGate, ...mutation },
        manifest,
        videoId: "video-1",
        durationSeconds: 676,
        audiencePromiseRequired: true,
        nowMs,
      }),
    pattern,
    name,
  );
}

const unfulfilledPromise = validateStudioPublicationGate({
  gate: {
    ...validGate,
    audiencePromises: { fulfilled: false, verifiedLocations: [] },
  },
  manifest,
  videoId: "video-1",
  durationSeconds: 676,
  audiencePromiseRequired: true,
  nowMs,
});
assert.equal(unfulfilledPromise.ok, true);
assert.equal(unfulfilledPromise.audiencePromiseRequired, true);
assert.equal(unfulfilledPromise.audiencePromiseFulfilled, false);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    eightMinuteThreshold: 480,
    monetizationRequired: true,
    midrollRequired: true,
    sponsoredPaidPromotionRequired: true,
    savedStudioEvidenceRequired: true,
    explicitPublicApprovalRequired: true,
    captionPromiseSurfacedWithoutBlocking: true,
  })}\n`,
);
