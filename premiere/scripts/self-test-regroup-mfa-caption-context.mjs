import assert from "node:assert/strict";

import {contextBoundaryPenalty, regroupMfaCaptionContext} from "./regroup-mfa-caption-context.mjs";

const words = [
  "안녕하세요.", "Deno입니다.",
  "이번", "영상에서는", "ComfyUI를", "처음", "입문하신", "분들과", "뒤늦게", "시작해서",
  "이제", "막", "공부하고", "계신", "형님들한테", "제가", "생각하는", "앞으로의", "방향성에", "대해서",
  "한번", "생각을", "공유해", "드려볼까", "합니다.",
  "반면에", "어떤", "것은", "들어가", "보면", "굉장히", "복잡한", "구조로", "이루어져", "있고",
  "사용하기도", "어려운", "경우도", "있고", "그렇게", "다양한", "경험을", "할", "수가", "있는데요.",
];
const cards = words.map((text, index) => ({
  index: index + 1,
  text,
  start_frame: index * 15,
  end_frame_exclusive: (index + 1) * 15,
  authored_card_indices: [index + 1],
}));
const alignment = {timing_policy: {fps: "30"}, display_cards: cards};
const result = regroupMfaCaptionContext(alignment);

assert.equal(result.report.displayCardCount, cards.length);
assert.equal(result.report.textAndOrderPreserved, true);
assert.equal(result.report.badBoundaryCount, 0);
assert.match(result.srt, /안녕하세요\. Deno입니다\./u);
assert.equal(result.srt.includes("방향성에\r\n대해서"), false);
assert.equal(result.srt.includes("공부하고\r\n계신"), false);
assert.equal(result.srt.includes("복잡한\r\n구조로"), false);
assert.equal(result.srt.includes("할\r\n수가"), false);
assert.equal(result.report.reviewStatus, "automated-candidate");
assert.equal(result.report.directSemanticReviewRequired, true);
assert.ok(result.report.oneLineCueCount > 0);
assert.ok(result.report.cues.every((cue) => cue.textLines.length >= 1 && cue.textLines.length <= 2));
assert.ok(result.report.cues.every((cue) => cue.textLines.every((line) => [...line].length <= 42)));
assert.ok(contextBoundaryPenalty("방향성에", "대해서") >= 1000);
assert.ok(contextBoundaryPenalty("복잡한", "구조로") >= 1000);
assert.ok(contextBoundaryPenalty("서브", "그래프를") >= 1000);
assert.ok(contextBoundaryPenalty("LTX", "2.5") >= 4000);

console.log("PASS MFA context regrouping preserves text with contextual one-or-two-line cues");
