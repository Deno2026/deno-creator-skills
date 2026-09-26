#!/usr/bin/env node

const { createHash } = require("node:crypto");
const { mkdtemp, mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  REVIEW_RULE,
  recordVideoOverlayReview,
  sha256File,
  verifyVideoOverlayReview,
} = require("../tools/lib/video_overlay_review.cjs");

async function expectReject(label, action, pattern) {
  try {
    await action();
  } catch (error) {
    if (!pattern.test(String(error?.message ?? error))) {
      throw new Error(`${label}: unexpected error: ${error?.stack ?? error}`);
    }
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "deno-video-overlay-smoke-"));
  try {
    const requestDir = path.join(root, "request");
    const sampleDir = path.join(requestDir, "verification", "video-overlay", "ABCDEF0123456789");
    await mkdir(sampleDir, { recursive: true });
    const samples = [];
    for (let index = 1; index <= 9; index += 1) {
      const samplePath = path.join(sampleDir, `sample-${String(index).padStart(2, "0")}.png`);
      await writeFile(samplePath, `sample-${index}`, "utf8");
      samples.push({
        index,
        fraction: index / 10,
        timestampSeconds: index,
        path: samplePath,
        sha256: await sha256File(samplePath),
      });
    }
    const contactSheetPath = path.join(sampleDir, "contact-sheet-3x3.png");
    await writeFile(contactSheetPath, "contact-sheet", "utf8");
    const sampleManifestPath = path.join(sampleDir, "sample_manifest.json");
    const sampleManifest = {
      schemaVersion: 1,
      requestId: "request-1",
      slug: "video-slug",
      sourceFingerprint: "fingerprint-1",
      reviewRule: REVIEW_RULE,
      video: {
        path: path.join(requestDir, "video.mp4"),
        byteSize: 1234,
        sha256: "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
      },
      samples,
      contactSheet: {
        path: contactSheetPath,
        sha256: await sha256File(contactSheetPath),
      },
    };
    await writeFile(sampleManifestPath, `${JSON.stringify(sampleManifest, null, 2)}\n`, "utf8");
    const prepared = {
      sampleDir,
      sampleManifestPath,
      contactSheetPath,
      manifest: sampleManifest,
      manifestSha256: await sha256File(sampleManifestPath),
      reused: false,
    };
    const manifest = {
      requestId: "request-1",
      agentProject: { slug: "video-slug" },
      sourceOfTruth: { sourceFingerprint: "fingerprint-1" },
      files: {
        video: {
          size: 1234,
          sha256: "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
        },
      },
    };
    const videoStat = { size: 1234 };

    await expectReject(
      "applied without reviewing all samples",
      () =>
        recordVideoOverlayReview({
          requestDir,
          manifest,
          videoStat,
          prepared,
          decision: "applied",
          evidenceSampleIndexes: [2],
          allSamplesReviewed: false,
          fullSignatureConfirmed: true,
        }),
      /requires all nine samples/,
    );

    await expectReject(
      "applied without complete signature",
      () =>
        recordVideoOverlayReview({
          requestDir,
          manifest,
          videoStat,
          prepared,
          decision: "applied",
          evidenceSampleIndexes: [2],
          allSamplesReviewed: true,
          fullSignatureConfirmed: false,
        }),
      /requires the complete fixed-frame signature/,
    );

    await expectReject(
      "missing review marker",
      () => verifyVideoOverlayReview({ requestDir, manifest, videoStat, prepared }),
      /VIDEO_OVERLAY_REVIEW_REQUIRED/,
    );

    await recordVideoOverlayReview({
      requestDir,
      manifest,
      videoStat,
      prepared,
      decision: "missing",
      evidenceSampleIndexes: [],
      allSamplesReviewed: true,
    });
    await expectReject(
      "explicit missing decision",
      () => verifyVideoOverlayReview({ requestDir, manifest, videoStat, prepared }),
      /VIDEO_OVERLAY_MISSING/,
    );

    await recordVideoOverlayReview({
      requestDir,
      manifest,
      videoStat,
      prepared,
      decision: "applied",
      evidenceSampleIndexes: [2, 7],
      allSamplesReviewed: true,
      fullSignatureConfirmed: true,
    });
    const verified = await verifyVideoOverlayReview({
      requestDir,
      manifest,
      videoStat,
      prepared,
    });
    if (
      verified.review.decision !== "applied" ||
      verified.evidenceSamples.map((sample) => sample.index).join(",") !== "2,7"
    ) {
      throw new Error("applied review evidence was not preserved");
    }

    await expectReject("non-tutorial without user scope", () => recordVideoOverlayReview({
      requestDir, manifest, videoStat, prepared, decision: "not_applicable_non_tutorial",
      evidenceSampleIndexes: [], allSamplesReviewed: true, fullSignatureConfirmed: false,
    }), /explicit user scope evidence/);
    await recordVideoOverlayReview({
      requestDir, manifest, videoStat, prepared, decision: "not_applicable_non_tutorial",
      evidenceSampleIndexes: [], allSamplesReviewed: true, fullSignatureConfirmed: false,
      nonTutorialReason: "User-approved full-screen motion talk; not a screen tutorial.",
      userScopeEvidence: "Production approval record for this exact video.",
    });
    const nonTutorial = await verifyVideoOverlayReview({requestDir, manifest, videoStat, prepared});
    if (nonTutorial.review.decision !== "not_applicable_non_tutorial" || nonTutorial.evidenceSamples.length) {
      throw new Error("non-tutorial applicability was not preserved");
    }
    await expectReject("non-tutorial stale source", () => verifyVideoOverlayReview({
      requestDir, manifest: {...manifest, sourceOfTruth:{sourceFingerprint:"changed"}}, videoStat, prepared,
    }), /VIDEO_OVERLAY_REVIEW_STALE/);

    await writeFile(samples[1].path, "tampered", "utf8");
    await expectReject(
      "tampered evidence",
      () => verifyVideoOverlayReview({ requestDir, manifest, videoStat, prepared }),
      /sample changed after preparation/,
    );

    const reviewRaw = await readFile(path.join(requestDir, "video_overlay_review.json"), "utf8");
    const digest = createHash("sha256").update(reviewRaw).digest("hex");
    process.stdout.write(`VIDEO_OVERLAY_REVIEW_SMOKE_OK reviewSha256=${digest}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`VIDEO_OVERLAY_REVIEW_SMOKE_FAILED ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
