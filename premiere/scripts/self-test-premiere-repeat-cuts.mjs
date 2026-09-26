import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  PREMIERE_REPEAT_CUT_INPUT_SCHEMA,
  PREMIERE_REPEAT_CUT_OUTPUT_SCHEMA,
  normalizeRepeatCutWords,
  proposePremiereRepeatCuts,
} from "./lib/premiere-repeat-cuts.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(SCRIPT_DIR, "propose-premiere-repeat-cuts.mjs");

function word(text, startSeconds, endSeconds, extra = {}) {
  return { text, startSeconds, endSeconds, ...extra };
}

const exactTwoWords = [
  word("오늘", 0.2, 0.4),
  word("계획을", 0.4, 0.7),
  word("오늘", 0.9, 1.1),
  word("계획을", 1.1, 1.4),
  word("설명합니다.", 1.4, 2),
];

const exactProposal = proposePremiereRepeatCuts({
  schemaVersion: 1,
  fps: 30,
  target: { name: "whole-file.mp4", projectItemNodeId: "whole-item" },
  words: exactTwoWords,
  waveformSafety: {
    required: true,
    maxSnapFrames: 3,
    cutRanges: [{ startFrame: 6, endFrame: 27 }],
  },
});
assert.equal(exactProposal.dryRun, true);
assert.equal(exactProposal.offlineOnly, true);
assert.equal(exactProposal.summary.candidateCount, 1);
assert.equal(exactProposal.summary.proposalEligibleCount, 1);
assert.equal(exactProposal.candidates[0].type, "exact_adjacent_repeat");
assert.equal(exactProposal.candidates[0].reasonCode, "exact_adjacent_repeat_1_to_4_tokens");
assert.equal(exactProposal.candidates[0].confidence, "high");
assert.equal(exactProposal.candidates[0].reviewRequired, false);
assert.equal(exactProposal.candidates[0].startFrame, 6);
assert.equal(exactProposal.candidates[0].endFrame, 27);
assert.equal(exactProposal.candidates[0].waveformSafety.status, "verified_cut_range");
assert.equal(Number.isInteger(exactProposal.candidates[0].startFrame), true);
assert.equal(Number.isInteger(exactProposal.candidates[0].endFrame), true);
assert.match(exactProposal.candidates[0].reason, /첫 번째 발화/u);
assert.deepEqual(exactProposal.target, {
  name: "whole-file.mp4",
  projectItemNodeId: "whole-item",
});

const boundaryProposal = proposePremiereRepeatCuts({
  fps: 30,
  words: exactTwoWords,
  waveformSafety: {
    maxSnapFrames: 2,
    boundaryFrames: [6, { frame: 27 }],
  },
});
assert.equal(boundaryProposal.candidates[0].waveformSafety.status, "verified_boundaries");
assert.equal(boundaryProposal.candidates[0].proposalEligible, true);

const clampedProposal = proposePremiereRepeatCuts({
  fps: 30,
  words: exactTwoWords,
  waveformSafety: {
    maxSnapFrames: 2,
    boundaryRanges: [
      { startFrame: 5, endFrame: 6 },
      { startFrame: 27, endFrame: 28 },
    ],
  },
});
assert.equal(clampedProposal.candidates[0].waveformSafety.status, "verified_boundaries");
assert.equal(clampedProposal.candidates[0].startFrame, 6);
assert.equal(clampedProposal.candidates[0].endFrame, 27);

const transcriptOnly = proposePremiereRepeatCuts({ fps: 30, words: exactTwoWords });
assert.equal(transcriptOnly.summary.candidateCount, 1);
assert.equal(transcriptOnly.candidates[0].confidence, "medium");
assert.equal(transcriptOnly.candidates[0].reviewRequired, true);
assert.equal(transcriptOnly.candidates[0].proposalEligible, false);
assert.equal(transcriptOnly.candidates[0].waveformSafety.status, "not_provided");
assert.deepEqual(transcriptOnly.candidates[0].reviewReasons, [
  "waveform_safe_boundary_not_provided",
]);

const unmatchedSafety = proposePremiereRepeatCuts({
  fps: 30,
  words: exactTwoWords,
  waveformSafety: { required: true, maxSnapFrames: 1, boundaryFrames: [300, 330] },
});
assert.equal(unmatchedSafety.candidates[0].waveformSafety.status, "unverified_no_match");
assert.equal(unmatchedSafety.candidates[0].reviewRequired, true);

const singleToken = proposePremiereRepeatCuts({
  fps: 30,
  words: [
    word("진짜", 0, 0.2),
    word("진짜", 0.3, 0.5),
    word("좋습니다.", 0.5, 1),
  ],
  waveformSafety: { cutRanges: [{ startFrame: 0, endFrame: 9 }] },
});
assert.equal(singleToken.summary.candidateCount, 1);
assert.equal(singleToken.candidates[0].reviewRequired, true);
assert.equal(singleToken.candidates[0].confidence, "low");
assert.match(singleToken.candidates[0].reviewReasons.join(" "), /single_token_repeat/u);

const fillerOnly = proposePremiereRepeatCuts({
  fps: 30,
  words: [
    word("어", 0, 0.2),
    word("음", 0.2, 0.4),
    word("어", 0.5, 0.7),
    word("음", 0.7, 0.9),
    word("시작합니다.", 0.9, 1.4),
  ],
});
assert.equal(fillerOnly.summary.candidateCount, 0);

const similarReExplanation = proposePremiereRepeatCuts({
  fps: 30,
  words: [
    word("이", 0, 0.2),
    word("모델은", 0.2, 0.5),
    word("빠릅니다", 0.5, 0.9),
    word("이", 1, 1.2),
    word("도구는", 1.2, 1.5),
    word("속도가", 1.5, 1.8),
    word("좋습니다.", 1.8, 2.2),
  ],
});
assert.equal(similarReExplanation.summary.candidateCount, 0);

const intentionalTerminalRepeat = proposePremiereRepeatCuts({
  fps: 30,
  words: [
    word("정말", 0, 0.2),
    word("좋습니다.", 0.2, 0.6),
    word("정말", 0.8, 1),
    word("좋습니다.", 1, 1.4),
  ],
});
assert.equal(intentionalTerminalRepeat.summary.candidateCount, 0);

const restartWords = [
  word("오늘", 0, 0.3),
  word("영상에서", 0.3, 0.6),
  word("모델을...", 0.6, 0.9),
  word("오늘", 1.1, 1.4),
  word("영상에서", 1.4, 1.7),
  word("기능을", 1.7, 2),
  word("설명합니다.", 2, 2.5),
];
const restartProposal = proposePremiereRepeatCuts({
  fps: 30,
  words: restartWords,
  waveformSafety: { cutRanges: [{ startFrame: 0, endFrame: 33 }] },
});
assert.equal(restartProposal.summary.candidateCount, 1);
assert.equal(restartProposal.candidates[0].type, "immediate_restart");
assert.equal(restartProposal.candidates[0].evidence.commonPrefixTokenCount, 2);
assert.equal(restartProposal.candidates[0].evidence.removedText, "오늘 영상에서 모델을...");
assert.equal(restartProposal.candidates[0].confidence, "high");
assert.equal(restartProposal.candidates[0].reviewRequired, false);

const noCutoffRestart = proposePremiereRepeatCuts({
  fps: 30,
  words: restartWords.map((item) => ({
    ...item,
    text: item.text === "모델을..." ? "모델을" : item.text,
  })),
});
assert.equal(noCutoffRestart.summary.candidateCount, 0);

const explicitRestartMetadata = proposePremiereRepeatCuts({
  fps: 30,
  words: restartWords.map((item) => ({
    ...item,
    text: item.text === "모델을..." ? "모델을" : item.text,
    restartAfter: item.text === "모델을...",
  })),
  waveformSafety: { cutRanges: [{ startFrame: 0, endFrame: 33 }] },
});
assert.equal(
  explicitRestartMetadata.candidates[0].evidence.cutoffSource,
  "explicit_metadata",
);

const approximateTiming = proposePremiereRepeatCuts({
  fps: 30,
  words: [
    word("오늘 계획", 0.2, 0.8),
    word("오늘 계획", 1, 1.6),
    word("설명합니다.", 1.6, 2),
  ],
  waveformSafety: { cutRanges: [{ startFrame: 6, endFrame: 30 }] },
});
assert.equal(approximateTiming.summary.candidateCount, 1);
assert.equal(approximateTiming.candidates[0].transcriptTiming.approximate, true);
assert.equal(approximateTiming.candidates[0].reviewRequired, true);

const crossClipRepeat = proposePremiereRepeatCuts({
  fps: 30,
  words: [
    word("오늘", 0, 0.2, { timelineClipIndex: 0 }),
    word("계획", 0.2, 0.5, { timelineClipIndex: 0 }),
    word("오늘", 0.6, 0.8, { timelineClipIndex: 1 }),
    word("계획", 0.8, 1.1, { timelineClipIndex: 1 }),
  ],
});
assert.equal(crossClipRepeat.summary.candidateCount, 0);

const delayedRepeat = proposePremiereRepeatCuts({
  fps: 30,
  words: [
    word("오늘", 0, 0.2),
    word("계획", 0.2, 0.5),
    word("오늘", 2, 2.2),
    word("계획", 2.2, 2.5),
  ],
});
assert.equal(delayedRepeat.summary.candidateCount, 0);

const tripleRepeat = proposePremiereRepeatCuts({
  fps: 30,
  words: [
    word("출발", 0, 0.2),
    word("출발", 10 / 30, 0.5),
    word("출발", 20 / 30, 0.9),
  ],
  waveformSafety: {
    maxSnapFrames: 1,
    cutRanges: [
      { startFrame: 0, endFrame: 10 },
      { startFrame: 10, endFrame: 20 },
    ],
  },
});
assert.equal(tripleRepeat.summary.candidateCount, 2);
assert.deepEqual(
  tripleRepeat.candidates.map((candidate) => [candidate.startFrame, candidate.endFrame]),
  [[0, 10], [10, 20]],
);

const quadrupleRepeat = proposePremiereRepeatCuts({
  fps: 30,
  words: [
    word("반복", 0, 0.2),
    word("반복", 10 / 30, 0.5),
    word("반복", 20 / 30, 0.9),
    word("반복", 30 / 30, 1.2),
  ],
});
assert.equal(quadrupleRepeat.summary.candidateCount, 2);
assert.deepEqual(
  quadrupleRepeat.candidates.map((candidate) => [
    candidate.evidence.tokenStartIndex,
    candidate.evidence.keptTokenStartIndex,
  ]),
  [[0, 2], [2, 3]],
);

const transcriptAlias = proposePremiereRepeatCuts({
  fps: 30,
  transcript: { words: exactTwoWords },
});
assert.equal(transcriptAlias.summary.candidateCount, 1);

const normalizedTokens = normalizeRepeatCutWords([
  word("Hello, WORLD!", 0, 1),
]);
assert.deepEqual(normalizedTokens.map((token) => token.normalized), ["hello", "world"]);
assert.equal(normalizedTokens.every((token) => token.approximateTiming), true);

assert.equal(PREMIERE_REPEAT_CUT_INPUT_SCHEMA.schemaVersion, 1);
assert.equal(PREMIERE_REPEAT_CUT_OUTPUT_SCHEMA.dryRun, true);
assert.throws(
  () => proposePremiereRepeatCuts({ schemaVersion: 2, fps: 30, words: exactTwoWords }),
  /Unsupported repeat-cut input schemaVersion/u,
);
assert.throws(
  () => proposePremiereRepeatCuts({ words: exactTwoWords }),
  /fps is required/u,
);
assert.throws(
  () => proposePremiereRepeatCuts({
    fps: 30,
    words: exactTwoWords,
    waveformSafety: { boundaryFrames: [6.5, 27] },
  }),
  /non-negative integer frame/u,
);
assert.throws(
  () => proposePremiereRepeatCuts({
    fps: 30,
    words: exactTwoWords,
    options: { maxPhraseTokens: 5 },
  }),
  /between 1 and 4/u,
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-repeat-cuts-"));
try {
  const inputPath = path.join(tempDir, "input.json");
  const outPath = path.join(tempDir, "proposal.json");
  fs.writeFileSync(inputPath, `${JSON.stringify({ fps: 30, words: exactTwoWords })}\n`, "utf8");
  const cli = spawnSync(process.execPath, [CLI_PATH, "--input", inputPath, "--out", outPath], {
    encoding: "utf8",
  });
  assert.equal(cli.status, 0, cli.stderr);
  const cliPayload = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(cliPayload.dryRun, true);
  assert.equal(cliPayload.offlineOnly, true);
  assert.equal(cliPayload.summary.candidateCount, 1);
  assert.equal(cliPayload.candidates[0].reviewRequired, true);

  const schema = spawnSync(process.execPath, [CLI_PATH, "--print-schema"], { encoding: "utf8" });
  assert.equal(schema.status, 0, schema.stderr);
  assert.equal(JSON.parse(schema.stdout).input.schemaVersion, 1);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
  success: true,
  tests: 70,
  exactCandidateCount: exactProposal.summary.candidateCount,
  restartCandidateCount: restartProposal.summary.candidateCount,
  transcriptOnlyReviewCount: transcriptOnly.summary.reviewRequiredCount,
}, null, 2)}\n`);
