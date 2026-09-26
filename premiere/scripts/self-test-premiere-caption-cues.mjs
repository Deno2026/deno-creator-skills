import assert from "node:assert/strict";

import { validateSrt } from "./validate-srt.mjs";
import {
  applyCaptionReplacements,
  buildCaptionCues,
  DEFAULT_CAPTION_OPTIONS,
  formatSrt,
  mapPremiereTranscriptToTimeline,
  mapSourceWordsToTimeline,
} from "./lib/premiere-caption-cues.mjs";

const sourceWords = [
  { text: "첫", startSeconds: 1.0, endSeconds: 1.2 },
  { text: "문장입니다.", startSeconds: 1.2, endSeconds: 2.0 },
  { text: "다음", startSeconds: 2.8, endSeconds: 3.1 },
  { text: "문장입니다.", startSeconds: 3.1, endSeconds: 4.0 },
  { text: "잘못된말", startSeconds: 8.0, endSeconds: 8.6 },
  { text: "교정", startSeconds: 8.6, endSeconds: 9.2 },
];

const clips = [
  {
    trackIndex: 0,
    name: "source.mp4",
    projectItemNodeId: "item-1",
    startSeconds: 0,
    endSeconds: 3.5,
    inPointSeconds: 0.5,
    outPointSeconds: 4.0,
  },
  {
    trackIndex: 0,
    name: "source.mp4",
    projectItemNodeId: "item-1",
    startSeconds: 3.5,
    endSeconds: 5.5,
    inPointSeconds: 7.5,
    outPointSeconds: 9.5,
  },
];

const mapped = mapSourceWordsToTimeline(sourceWords, clips);
assert.equal(mapped.length, 6);
assert.equal(mapped[0].text, "첫");
assert.equal(mapped[0].startSeconds, 0.5);
assert.ok(Math.abs(mapped.at(-1).endSeconds - 5.2) < 1e-9);

const mappedFromItems = mapPremiereTranscriptToTimeline(
  [{ name: "source.mp4", nodeId: "item-1", words: sourceWords }],
  clips,
  [0],
);
assert.deepEqual(mappedFromItems, mapped);
assert.throws(
  () => mapPremiereTranscriptToTimeline([], clips, [0]),
  /No Premiere transcript found/,
);

const introClipWithoutTranscript = {
  trackIndex: 0,
  nodeId: "intro-clip",
  projectItemNodeId: "intro-item",
  name: "intro.mp4",
  startSeconds: 0,
  endSeconds: 1,
  inPointSeconds: 0,
  outPointSeconds: 1,
};
const targetClipsAfterIntro = clips.map((clip) => ({
  ...clip,
  nodeId: `target-clip-${clip.startSeconds}`,
  startSeconds: clip.startSeconds + 1,
  endSeconds: clip.endSeconds + 1,
}));
const mappedTargetOnly = mapPremiereTranscriptToTimeline(
  [{ name: "source.mp4", nodeId: "item-1", words: sourceWords }],
  [introClipWithoutTranscript, ...targetClipsAfterIntro],
  [0],
  {
    target: {
      name: "source.mp4",
      projectItemNodeId: "item-1",
    },
  },
);
assert.equal(mappedTargetOnly.length, mapped.length);
assert.equal(mappedTargetOnly[0].startSeconds, mapped[0].startSeconds + 1);
assert.ok(Math.abs(mappedTargetOnly.at(-1).endSeconds - (mapped.at(-1).endSeconds + 1)) < 1e-9);

const mappedTargetByClipNode = mapPremiereTranscriptToTimeline(
  [{ name: "source.mp4", nodeId: "item-1", words: sourceWords }],
  [introClipWithoutTranscript, ...targetClipsAfterIntro],
  {
    trackIndices: [0],
    target: { clipNodeId: "target-clip-0" },
  },
);
assert.equal(mappedTargetByClipNode.length, 4);
assert.equal(mappedTargetByClipNode.every((word) => word.timelineClipIndex === 0), true);

const mappedTargetNodeAlias = mapPremiereTranscriptToTimeline(
  [{ name: "source.mp4", nodeId: "item-1", words: sourceWords }],
  [introClipWithoutTranscript, ...targetClipsAfterIntro],
  { trackIndices: [0], targetNodeId: "item-1" },
);
assert.deepEqual(mappedTargetNodeAlias, mappedTargetOnly);

const mappedAllowMissingNonTarget = mapPremiereTranscriptToTimeline(
  [{ name: "source.mp4", nodeId: "item-1", words: sourceWords }],
  [introClipWithoutTranscript, ...targetClipsAfterIntro],
  [0],
  { allowMissingNonTarget: true },
);
assert.deepEqual(mappedAllowMissingNonTarget, mappedTargetOnly);
assert.throws(
  () => mapPremiereTranscriptToTimeline(
    [{ name: "source.mp4", nodeId: "item-1", words: sourceWords }],
    [introClipWithoutTranscript, ...targetClipsAfterIntro],
    [0],
    { target: { name: "missing-target.mp4" } },
  ),
  /No audio clips matched/u,
);

assert.equal(
  applyCaptionReplacements("잘못된말 교정", { 잘못된말: "올바른 말" }),
  "올바른 말 교정",
);

const cues = buildCaptionCues(mapped, {
  fps: 24,
  sequenceDurationSeconds: 5.5,
  maxLineLength: 24,
  replacements: { 잘못된말: "올바른 말" },
});
assert.equal(cues.length, 3);
assert.equal(cues.some((cue) => cue.text.includes("문장입니다. 잘못된말")), false);
assert.match(cues.at(-1).text, /올바른 말/);
assert.ok(cues.every((cue) => Math.abs(cue.startSeconds * 24 - Math.round(cue.startSeconds * 24)) < 1e-8));
assert.ok(cues.every((cue) => Math.abs(cue.endSeconds * 24 - Math.round(cue.endSeconds * 24)) < 1e-8));

const srt = formatSrt(cues);
assert.equal(srt.startsWith("\uFEFF1\r\n"), true);
assert.equal(/(?<!\r)\n/u.test(srt), false);
const report = validateSrt(srt, {
  fps: 24,
  maxLineLength: 24,
  minDurationSeconds: 0.8,
});
assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));

const shortTerminalCues = buildCaptionCues([
  { text: "앞", startSeconds: 0.1, endSeconds: 0.4, timelineClipIndex: 0 },
  { text: "문장입니다.", startSeconds: 0.4, endSeconds: 0.8, timelineClipIndex: 0 },
  { text: "아닙니다.", startSeconds: 1.45, endSeconds: 1.7, timelineClipIndex: 0 },
  { text: "발상을", startSeconds: 1.85, endSeconds: 2.15, timelineClipIndex: 0 },
  { text: "뒤집었습니다.", startSeconds: 2.15, endSeconds: 3.0, timelineClipIndex: 0 },
], {
  fps: 24,
  sequenceDurationSeconds: 3.5,
});
assert.deepEqual(shortTerminalCues.map((cue) => cue.text), [
  "앞 문장입니다.",
  "아닙니다.",
  "발상을 뒤집었습니다.",
]);
assert.ok(
  shortTerminalCues[1].endSeconds - shortTerminalCues[1].startSeconds >= 0.8 - 1e-8,
);
assert.ok(shortTerminalCues[0].endSeconds <= shortTerminalCues[1].startSeconds);
assert.ok(shortTerminalCues[1].endSeconds <= shortTerminalCues[2].startSeconds);

const clipBoundaryCues = buildCaptionCues([
  { text: "아닙니다.", startSeconds: 0.1, endSeconds: 0.3, timelineClipIndex: 0 },
  { text: "다음입니다.", startSeconds: 0.35, endSeconds: 0.7, timelineClipIndex: 1 },
], {
  fps: 24,
  sequenceDurationSeconds: 1.2,
});
assert.deepEqual(clipBoundaryCues.map((cue) => cue.text), ["아닙니다.", "다음입니다."]);

const insufficientWindowCues = buildCaptionCues([
  { text: "아닙니다.", startSeconds: 0.1, endSeconds: 0.3, timelineClipIndex: 0 },
  { text: "다음입니다.", startSeconds: 0.35, endSeconds: 1.0, timelineClipIndex: 0 },
], {
  fps: 24,
  sequenceDurationSeconds: 1.2,
});
assert.deepEqual(insufficientWindowCues.map((cue) => cue.text), ["아닙니다. 다음입니다."]);

const timedSentence = (text, spacing = 0.5) => text.split(" ").map((word, index) => ({
  text: word,
  startSeconds: index * spacing + 0.1,
  endSeconds: (index + 1) * spacing + 0.05,
  sourceWordId: `word-${index}`,
}));
const assertWordCoverage = (input, output, fps = 30) => {
  let nextWord = 0;
  for (const cue of output) {
    assert.equal(cue.wordStartIndex, nextWord);
    assert.equal(cue.wordCount, cue.wordEndIndex - cue.wordStartIndex + 1);
    const covered = input.slice(cue.wordStartIndex, cue.wordEndIndex + 1);
    assert.equal(cue.text, covered.map((word) => word.text).join(" "));
    assert.ok(cue.startSeconds <= covered[0].startSeconds + 1 / fps);
    assert.ok(cue.endSeconds >= covered.at(-1).endSeconds - 1 / fps);
    assert.ok(cue.textLines.length <= 2);
    assert.ok(cue.textLines.every((line) => [...line].length <= 42));
    nextWord = cue.wordEndIndex + 1;
  }
  assert.equal(nextWord, input.length);
};

const naturalWords = timedSentence(
  "오늘은 우리가 만든 여러 기능을 함께 살펴보고 앞으로의 방향성에 대해서 한번 자세히 말씀드려볼까 합니다.",
);
const originalNaturalWords = structuredClone(naturalWords);
const naturalCues = buildCaptionCues(naturalWords);
assert.equal(naturalCues.length, 1);
assert.equal(naturalCues[0].textLines.length, 2);
assert.ok(naturalCues[0].textLines.some((line) => [...line].length > 24));
assert.ok(naturalCues[0].endSeconds - naturalCues[0].startSeconds > 4.8);
assert.ok(naturalCues[0].wordCount > 12);
assert.equal(naturalCues[0].textLines.some((line) => line.endsWith("방향성에")), false);
assertWordCoverage(naturalWords, naturalCues);
assert.deepEqual(naturalWords, originalNaturalWords);

const termWords = timedSentence(
  "지금부터 새롭게 만든 기능을 살펴보면서 서브 그래프를 열어보고 실제 작업에 어떻게 사용할지 설명하겠습니다.",
);
const termCues = buildCaptionCues(termWords);
assert.equal(termCues.length, 1);
assert.equal(termCues[0].textLines.some((line) => line.endsWith("서브")), false);
assertWordCoverage(termWords, termCues);

const longWords = timedSentence(
  "지금부터 새롭게 만든 기능을 살펴보겠습니다, 실제 예시도 보여드리고 사용자가 원하는 결과를 어떻게 만드는지 천천히 하나씩 설명하면서 작업의 흐름과 다음 단계에서 필요한 도구의 사용 방법까지 함께 알아보려고 합니다",
);
const longCues = buildCaptionCues(longWords);
assert.ok(longCues.length >= 2);
assert.ok(longCues.every((cue) => cue.endSeconds - cue.startSeconds < 12.3));
assertWordCoverage(longWords, longCues);

const separatedWords = [
  {text: "네", startSeconds: 0.1, endSeconds: 0.3},
  {text: "다음", startSeconds: 2.0, endSeconds: 2.2},
  {text: "설명입니다.", startSeconds: 2.2, endSeconds: 3.0},
];
const separatedCues = buildCaptionCues(separatedWords);
assert.equal(separatedCues.length, 2);
assert.ok(separatedCues[0].endSeconds < separatedCues[1].startSeconds);
assertWordCoverage(separatedWords, separatedCues);

const cutWords = [
  {text: "앞부분", startSeconds: 0.1, endSeconds: 1.0},
  {text: "뒷부분입니다.", startSeconds: 1.0, endSeconds: 2.0},
];
const cutCues = buildCaptionCues(cutWords, {cutBoundariesSeconds: [1.0]});
assert.equal(cutCues.length, 2);
assert.equal(cutCues[0].endSeconds, 1.0);
assert.equal(cutCues[1].startSeconds, 1.0);
assertWordCoverage(cutWords, cutCues);
assert.equal(validateSrt(formatSrt(naturalCues), {
  maxLineLength: DEFAULT_CAPTION_OPTIONS.maxLineLength,
  maxDurationSeconds: 12.3,
}).ok, true);

process.stdout.write(`${JSON.stringify({
  success: true,
  contextualFixtures: 5,
  cueCount: cues.length,
  shortTerminalCueCount: shortTerminalCues.length,
  clipBoundaryCueCount: clipBoundaryCues.length,
  insufficientWindowCueCount: insufficientWindowCues.length,
}, null, 2)}\n`);
