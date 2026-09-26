import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildCaptionIdentity,
  buildDeliveryManifest,
} from "./lib/production-delivery.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "deno-delivery-test-"));
try {
  const videoPath = path.join(root, "master.mp4");
  const srtPath = path.join(root, "final-ko.srt");
  fs.writeFileSync(videoPath, "fixture-video", "utf8");
  fs.writeFileSync(srtPath, "1\n00:00:00,000 --> 00:00:01,000\n안녕하세요.\n\n2\n00:00:01,200 --> 00:00:02,000\nDeno입니다.\n", "utf8");
  const captions = buildCaptionIdentity(srtPath);
  assert.equal(captions.cueCount, 2);
  assert.match(captions.sha256, /^[a-f0-9]{64}$/u);
  assert.match(captions.timelineSha256, /^[a-f0-9]{64}$/u);
  const contextualSrtPath = path.join(root, "contextual-final-ko.srt");
  fs.writeFileSync(
    contextualSrtPath,
    "1\n00:00:00,000 --> 00:00:09,000\n문맥을 자연스럽게 유지하는 장문 자막입니다.\n",
    "utf8",
  );
  assert.throws(() => buildCaptionIdentity(contextualSrtPath), /CUE_DURATION_TOO_LONG/);
  const contextualCaptions = buildCaptionIdentity(contextualSrtPath, {
    maxDurationSeconds: 12,
  });
  assert.equal(contextualCaptions.qc.maxDurationSeconds, 12);
  const manifest = buildDeliveryManifest({
    production: "sample-video",
    createdAt: "2026-08-31T00:00:00.000Z",
    revisions: {edit: "e1", audio: "a1", motion: "m1", captions: "c1", render: "r1"},
    video: {path: videoPath, durationSeconds: 2, codec: "h264", captionEmbedding: "sidecar"},
    captions,
  });
  assert.equal(manifest.ready, true);
  assert.equal(manifest.video.bytes, 13);
  assert.equal(manifest.captions.cueCount, 2);
  assert.equal(manifest.captions.qc.maxDurationSeconds, 7);
  assert.equal(manifest.video.captionEmbedding, "sidecar");
  assert.throws(
    () => buildDeliveryManifest({...manifest, video: {...manifest.video, captionEmbedding: "unknown"}}),
    /captionEmbedding/,
  );
  console.log("PASS production delivery manifest: exact master, final KO, revisions, and optional packaging boundary");
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
