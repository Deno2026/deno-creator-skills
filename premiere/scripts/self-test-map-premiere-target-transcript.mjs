import assert from "node:assert/strict";
import {mapPremiereTargetTranscript} from "./map-premiere-target-transcript.mjs";

const clips = {
  fps: 30,
  ticksPerFrame: "8467200000",
  captureSha256: "A".repeat(64),
  targetBindingSha256: "B".repeat(64),
  bundleSha256: "C".repeat(64),
  targetClipNames: ["recording.mp4"],
  clips: [{
    media: "C:\\media\\recording.mp4",
    sourceIn: 5,
    sourceOut: 15,
    timelineStart: 20,
    timelineEnd: 30,
    targetClipName: "recording.mp4",
    videoNodeId: "video-1",
    audioNodeId: "audio-1",
    projectItemNodeId: "item-1",
  }],
};
const transcript = {items: [{
  name: "recording.mp4",
  nodeId: "item-1",
  words: [
    {text: "outside", startSeconds: 1, endSeconds: 2},
    {text: "첫째", startSeconds: 5.2, endSeconds: 5.8},
    {text: "둘째", startSeconds: 8, endSeconds: 9},
    {text: "edge", startSeconds: 14.8, endSeconds: 15.2},
  ],
}]};
const mapped = mapPremiereTargetTranscript({transcript, clips});
assert.equal(mapped.words.length, 2);
assert.equal(mapped.words[0].startSeconds, 20.2);
assert.equal(mapped.words[1].endSeconds, 24);
assert.equal(mapped.words[0].clipNodeId, "video-1");
assert.equal(mapped.words[0].projectItemNodeId, "item-1");
assert.equal(mapped.transcriptEvidence.excludedOutsideTarget, 1);
assert.equal(mapped.transcriptEvidence.excludedClippedAtEdge, 1);
assert.equal(mapped.captureSha256, "A".repeat(64));
assert.throws(
  () => mapPremiereTargetTranscript({
    transcript: {items: [{...transcript.items[0], nodeId: "wrong"}]},
    clips,
  }),
  /does not match/,
);
console.log("Premiere target transcript mapping self-test passed.");
