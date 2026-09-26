import assert from "node:assert/strict";

import {
  assertUniformFinalLevel,
  audioSourceGroupKey,
  groupAudioClips,
} from "./lib/audio-source-groups.mjs";

const clips = [
  {
    trackIndex: 0,
    clipIndex: 1,
    nodeId: "b",
    startSeconds: 10,
    mediaPath: "E:\\Media\\Narration.wav",
    projectItemNodeId: "item-1",
  },
  {
    trackIndex: 0,
    clipIndex: 0,
    nodeId: "a",
    startSeconds: 0,
    mediaPath: "e:\\media\\NARRATION.wav",
    projectItemNodeId: "item-2",
  },
  {
    trackIndex: 1,
    clipIndex: 0,
    nodeId: "music",
    startSeconds: 0,
    mediaPath: "E:\\Media\\music.wav",
  },
];

const groups = groupAudioClips(clips);
assert.equal(groups.length, process.platform === "win32" ? 2 : 3);
if (process.platform === "win32") {
  const narration = groups.find((group) => group.clips.length === 2);
  assert.deepEqual(narration.clips.map((clip) => clip.nodeId), ["a", "b"]);
}

const clipGroups = groupAudioClips(clips, { groupBy: "clip" });
assert.equal(clipGroups.length, 3);
assert.match(audioSourceGroupKey(clips[0], { groupBy: "clip" }), /^clip:0:1:/);

const splitGroups = groupAudioClips([
  { ...clips[0], sourceGroup: "speaker" },
  { ...clips[1], sourceGroup: "tts" },
]);
assert.equal(splitGroups.length, 2);
const sameLabelDifferentFiles = groupAudioClips([
  { ...clips[0], sourceGroup: "narration" },
  { ...clips[2], sourceGroup: "narration" },
]);
assert.equal(sameLabelDifferentFiles.length, 2);

assert.equal(
  assertUniformFinalLevel([
    { sourceGroupKey: "narration", finalDisplayDb: 2.5 },
    { sourceGroupKey: "narration", finalDisplayDb: 2.5 },
  ]),
  true,
);
assert.throws(
  () =>
    assertUniformFinalLevel([
      { sourceGroupKey: "narration", finalDisplayDb: 2.5 },
      { sourceGroupKey: "narration", finalDisplayDb: 1.5 },
    ]),
  /non-uniform/,
);
assert.throws(
  () =>
    assertUniformFinalLevel([
      { sourceGroupKey: "narration", finalDisplayDb: Number.NaN },
    ]),
  /non-finite/,
);

console.log("Audio source grouping self-test passed.");
