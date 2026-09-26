import assert from "node:assert/strict";

import { compareAligners } from "./compare-caption-aligners.mjs";


const mfa = `1
00:00:00,083 --> 00:00:01,000
첫 번째 문장

2
00:00:01,083 --> 00:00:02,000
BF16 테스트
`;

const qwen = `1
00:00:00,125 --> 00:00:01,042
첫 번째 문장

2
00:00:01,250 --> 00:00:02,000
BF16 테스트
`;

const report = compareAligners({ mfaSource: mfa, qwenSource: qwen, fps: "24", reviewThresholdFrames: 2 });
assert.equal(report.comparable, true);
assert.equal(report.summary.cueCount, 2);
assert.deepEqual(report.summary.reviewCueNumbers, [2]);
assert.equal(report.cues[0].startDeltaFrames, 1);
assert.equal(report.cues[1].startDeltaFrames, 4);
assert.equal(report.contract.automaticWinnerSelection, false);

const mismatch = compareAligners({
  mfaSource: mfa,
  qwenSource: qwen.replace("BF16 테스트", "GGUF 테스트"),
  fps: "24",
});
assert.equal(mismatch.comparable, false);
assert.equal(mismatch.structureIssues[0].code, "CUE_IDENTITY_MISMATCH");

assert.throws(
  () => compareAligners({ mfaSource: mfa, qwenSource: qwen, fps: "0" }),
  /0보다 큰 숫자|Invalid fps/,
);

console.log("PASS caption aligner comparison keeps MFA primary and reports Qwen boundary divergence");
