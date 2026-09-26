#!/usr/bin/env node

const path = require("node:path");

const {
  RUNTIME_PATHS,
  loadAndValidateLatestReadyRequest,
} = require("./lib/helper_ready_gate.cjs");
const {
  prepareVideoOverlaySamples,
  recordVideoOverlayReview,
} = require("./lib/video_overlay_review.cjs");

function parseArgs(argv) {
  const args = {
    requestId: "",
    decision: "",
    evidenceSampleIndexes: [],
    allSamplesReviewed: false,
    fullSignatureConfirmed: false,
    nonTutorialReason: "",
    userScopeEvidence: "",
  };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--request-id") args.requestId = argv[++index] ?? "";
    else if (token === "--decision") args.decision = argv[++index] ?? "";
    else if (token === "--non-tutorial-reason") args.nonTutorialReason = argv[++index] ?? "";
    else if (token === "--user-scope-evidence") args.userScopeEvidence = argv[++index] ?? "";
    else if (token === "--evidence-sample") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value)) throw new Error("--evidence-sample must be an integer");
      args.evidenceSampleIndexes.push(value);
    } else if (token === "--all-samples-reviewed") {
      args.allSamplesReviewed = true;
    } else if (token === "--full-signature-confirmed") {
      args.fullSignatureConfirmed = true;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (!args.requestId) throw new Error("--request-id is required");
  if (!["applied", "missing", "not_applicable_non_tutorial"].includes(args.decision)) {
    throw new Error("--decision must be applied, missing, or not_applicable_non_tutorial");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const validated = await loadAndValidateLatestReadyRequest({ requestId: args.requestId });
  const prepared = await prepareVideoOverlaySamples({
    requestDir: validated.requestDir,
    manifest: validated.manifest,
    videoPath: validated.videoPath,
    videoStat: validated.videoStat,
    verificationDir: validated.verificationDir,
    policyPath: RUNTIME_PATHS.videoOverlayPolicyPath,
  });
  const result = await recordVideoOverlayReview({
    requestDir: validated.requestDir,
    manifest: validated.manifest,
    videoStat: validated.videoStat,
    prepared,
    decision: args.decision,
    evidenceSampleIndexes: args.evidenceSampleIndexes,
    allSamplesReviewed: args.allSamplesReviewed,
    fullSignatureConfirmed: args.fullSignatureConfirmed,
    nonTutorialReason: args.nonTutorialReason,
    userScopeEvidence: args.userScopeEvidence,
  });
  process.stdout.write(
    `VIDEO_OVERLAY_REVIEW_RECORDED decision=${result.review.decision} ` +
      `evidence=${result.review.evidenceSampleIndexes.join(",") || "none"} ` +
      `review=${result.path}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`VIDEO_OVERLAY_REVIEW_FAILED ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
