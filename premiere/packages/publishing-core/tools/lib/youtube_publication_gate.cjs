"use strict";

const LONGFORM_MIDROLL_THRESHOLD_SECONDS = 8 * 60;
const DEFAULT_MAX_EVIDENCE_AGE_MS = 15 * 60 * 1000;

function isSponsoredRequest(manifest) {
  const metadata = manifest?.effectiveExpected ?? manifest?.requestedExpected ?? manifest?.metadata ?? {};
  return metadata.brandApprovalRequired === true;
}

function validateStudioPublicationGate({
  gate,
  manifest,
  videoId,
  durationSeconds,
  audiencePromiseRequired = false,
  nowMs = Date.now(),
  maxEvidenceAgeMs = DEFAULT_MAX_EVIDENCE_AGE_MS,
}) {
  const errors = [];
  const expectedRequestId = manifest?.requestId;
  const expectedFingerprint = manifest?.sourceOfTruth?.sourceFingerprint;
  const observedAtMs = Date.parse(gate?.observedAt ?? "");
  const isEightMinuteLongform = Number(durationSeconds) >= LONGFORM_MIDROLL_THRESHOLD_SECONDS;
  const paidPromotionRequired = isSponsoredRequest(manifest);

  if (gate?.schemaVersion !== 1) errors.push("studio gate schemaVersion must be 1");
  if (gate?.source !== "youtube_studio_live_read") {
    errors.push("studio gate source must be youtube_studio_live_read");
  }
  if (gate?.requestId !== expectedRequestId) errors.push("studio gate requestId mismatch");
  if (gate?.sourceFingerprint !== expectedFingerprint) {
    errors.push("studio gate sourceFingerprint mismatch");
  }
  if (gate?.videoId !== videoId) errors.push("studio gate videoId mismatch");
  if (
    !Number.isFinite(Number(gate?.durationSeconds)) ||
    Math.abs(Number(gate.durationSeconds) - Number(durationSeconds)) > 1.1
  ) {
    errors.push("studio gate duration mismatch");
  }
  if (!Number.isFinite(observedAtMs)) {
    errors.push("studio gate observedAt is invalid");
  } else if (observedAtMs > nowMs + 30_000 || nowMs - observedAtMs > maxEvidenceAgeMs) {
    errors.push("studio gate evidence is stale");
  }
  if (gate?.saveState !== "saved") errors.push("YouTube Studio changes are not saved");
  if (
    gate?.publicApproval?.approved !== true ||
    gate?.publicApproval?.authority !== "user_explicit_chat_confirmation"
  ) {
    errors.push("public visibility lacks explicit user approval");
  }
  if (isEightMinuteLongform) {
    if (gate?.monetization?.enabled !== true) {
      errors.push("8-minute longform monetization is not enabled");
    }
    if (gate?.monetization?.midrollEnabled !== true) {
      errors.push("8-minute longform mid-roll ads are not enabled");
    }
  }
  if (paidPromotionRequired && gate?.paidPromotion?.checked !== true) {
    errors.push("sponsored video paid-promotion disclosure is not checked");
  }

  if (errors.length > 0) {
    const error = new Error(`YOUTUBE_PUBLICATION_GATE_BLOCKED: ${errors.join("; ")}`);
    error.code = "YOUTUBE_PUBLICATION_GATE_BLOCKED";
    error.details = errors;
    throw error;
  }

  return {
    ok: true,
    videoId,
    durationSeconds,
    isEightMinuteLongform,
    paidPromotionRequired,
    audiencePromiseRequired,
    audiencePromiseFulfilled: gate?.audiencePromises?.fulfilled === true,
    observedAt: gate.observedAt,
  };
}

module.exports = {
  DEFAULT_MAX_EVIDENCE_AGE_MS,
  LONGFORM_MIDROLL_THRESHOLD_SECONDS,
  isSponsoredRequest,
  validateStudioPublicationGate,
};
