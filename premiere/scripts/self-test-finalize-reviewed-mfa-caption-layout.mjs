import assert from "node:assert/strict";

import {
  finalizeReviewedMfaCaptionLayout,
  contextualizeReviewedLayoutManifest,
  reflowReviewedLayoutManifest,
  retargetReviewedLayoutManifest,
  reviseReviewedLayoutManifest,
  seedReviewedLayoutManifest,
} from "./finalize-reviewed-mfa-caption-layout.mjs";

const words = ["안녕하세요.", "Deno입니다.", "서브", "그래프를", "열어보고", "결과를", "확인합니다."];
const cards = words.map((text, index) => ({
  index: index + 1,
  text,
  start_frame: index * 15,
  end_frame_exclusive: (index + 1) * 15,
}));
const alignment = {timing_policy: {fps: "30"}, display_cards: cards};
const regroupReport = {
  cues: [
    {displayCardStart: 1, displayCardEnd: 2, textLines: ["안녕하세요.", "Deno입니다."]},
    {displayCardStart: 3, displayCardEnd: 7, textLines: ["서브 그래프를 열어보고", "결과를 확인합니다."]},
  ],
};
const manifest = seedReviewedLayoutManifest(alignment, regroupReport);
assert.equal(manifest.directReview.completed, false);
const candidate = finalizeReviewedMfaCaptionLayout(alignment, manifest);
assert.equal(candidate.report.reviewStatus, "validated-candidate");
assert.equal(candidate.report.reviewer, null);
assert.equal(candidate.report.reviewedCueCount, 0);
assert.equal(candidate.report.textAndOrderPreserved, true);
manifest.directReview = {completed: true, reviewer: "codex-main-agent", reviewedCueCount: 2};
const result = finalizeReviewedMfaCaptionLayout(alignment, manifest);
assert.equal(result.report.reviewStatus, "direct-reviewed-final-candidate");
assert.equal(result.report.cueCount, 2);
assert.equal(result.report.oneLineCueCount, 0);
assert.equal(result.report.twoLineCueCount, 2);
assert.equal(result.report.textAndOrderPreserved, true);
assert.match(result.srt, /서브 그래프를 열어보고\r\n결과를 확인합니다\./u);

const revised = reviseReviewedLayoutManifest(alignment, manifest, [
  {startDisplayCard: 1, endDisplayCard: 7, cueEnds: [3, 7]},
]);
assert.equal(revised.cues.length, 2);
assert.equal(revised.cues[0].endDisplayCard, 3);
assert.equal(revised.directReview.completed, false);

const reflowed = reflowReviewedLayoutManifest(alignment, manifest, 18);
assert.ok(reflowed.cues.length >= manifest.cues.length);
assert.equal(reflowed.layoutPolicy.maxLineChars, 18);
assert.equal(reflowed.layoutPolicy.visualLineContract, "user-caption-style-locked");
assert.equal(reflowed.directReview.completed, false);

const retargeted = retargetReviewedLayoutManifest(alignment, manifest, 42);
assert.deepEqual(retargeted.cues, manifest.cues);
assert.equal(retargeted.layoutPolicy.maxLineChars, 42);
assert.equal(retargeted.layoutPolicy.visualLineContract, "user-caption-style-locked");
assert.equal(retargeted.directReview.completed, false);

const contextual = contextualizeReviewedLayoutManifest(alignment, manifest, 42);
assert.equal(contextual.layoutPolicy.requireExactlyTwoLines, false);
assert.equal(contextual.layoutPolicy.lineMode, "max-two-contextual");
assert.equal(contextual.layoutPolicy.lineLengthRole, "ceiling-not-target");
assert.equal(contextual.cues.every((cue) => cue.lineBreakAfterDisplayCard === null), true);
contextual.directReview = {
  completed: true,
  reviewer: "codex-main-agent",
  reviewedCueCount: contextual.cues.length,
  acceptedDependentBoundaryAfterDisplayCards: [],
};
const contextualResult = finalizeReviewedMfaCaptionLayout(alignment, contextual);
assert.equal(contextualResult.report.oneLineCueCount, 2);
assert.equal(contextualResult.report.twoLineCueCount, 0);

const broken = structuredClone(manifest);
broken.cues = [
  {endDisplayCard: 3, lineBreakAfterDisplayCard: 1},
  {endDisplayCard: 7, lineBreakAfterDisplayCard: 5},
];
assert.throws(() => finalizeReviewedMfaCaptionLayout(alignment, broken), /protected technical terms/u);

const warningCards = ["앞으로의", "방향성에", "대해서", "한번", "말을", "합니다."].map((text, index) => ({
  index: index + 1,
  text,
  start_frame: index * 15,
  end_frame_exclusive: (index + 1) * 15,
}));
const warningAlignment = {timing_policy: {fps: "30"}, display_cards: warningCards};
const warningManifest = {
  displayCardCount: 6,
  layoutPolicy: {maxLineChars: 42, maxCueSeconds: 12, maxInternalGapSeconds: 1.5},
  directReview: {completed: true, reviewer: "codex-main-agent", reviewedCueCount: 2},
  cues: [
    {endDisplayCard: 3, lineBreakAfterDisplayCard: null},
    {endDisplayCard: 6, lineBreakAfterDisplayCard: null},
  ],
};
const warningResult = finalizeReviewedMfaCaptionLayout(warningAlignment, warningManifest);
assert.equal(warningResult.report.dependentBoundaryWarningCount, 1);
assert.equal(warningResult.report.unresolvedDependentBoundaryCount, 1);
assert.equal(warningResult.report.reviewedDependentBoundaries[0].disposition, "context-review-suggestion");
assert.match(warningResult.srt, /앞으로의 방향성에 대해서/u);
warningManifest.directReview.acceptedDependentBoundaryAfterDisplayCards = [3];
assert.equal(finalizeReviewedMfaCaptionLayout(warningAlignment, warningManifest).report.unresolvedDependentBoundaryCount, 0);

console.log("PASS direct-reviewed MFA layout supports contextual one-or-two-line review");
