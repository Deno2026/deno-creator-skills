import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {buildDeliveryManifest, buildCaptionIdentity} from "./lib/production-delivery.mjs";

import {createRequire} from "node:module";

// 채널 목록은 channels.json에서 오므로 예시 프로필을 먼저 쓰고 그 뒤에 인계 모듈을 적재한다.
const fixtureRuntime = fs.mkdtempSync(path.join(os.tmpdir(), "deno-handoff-profile-"));
createRequire(import.meta.url)("../packages/publishing-core/tests/lib/profile_fixture.cjs").writeProfileFixture(fixtureRuntime);
process.env.DENO_UPLOAD_HELPER_RUNTIME_ROOT = fixtureRuntime;
const {buildPublishingHandoff} = await import("./lib/publishing-handoff.mjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "deno-handoff-test-"));
try {
  const slug = "sample-video";
  const productionDir = path.join(root, "productions", slug);
  const captionDir = path.join(productionDir, "captions");
  const deliveryDir = path.join(productionDir, "delivery");
  fs.mkdirSync(captionDir, {recursive: true});
  fs.mkdirSync(deliveryDir, {recursive: true});
  const videoPath = path.join(root, "renders", slug, "master.mp4");
  fs.mkdirSync(path.dirname(videoPath), {recursive: true});
  const srtPath = path.join(captionDir, "final-ko.srt");
  fs.writeFileSync(videoPath, "exact-master", "utf8");
  fs.writeFileSync(srtPath, "1\n00:00:00,000 --> 00:00:01,000\n안녕하세요.\n", "utf8");
  const captions = buildCaptionIdentity(srtPath);
  const delivery = buildDeliveryManifest({
    production: slug,
    createdAt: "2026-08-31T00:00:00.000Z",
    revisions: {edit: "e1", audio: "a1", motion: "m1", captions: "c1", render: "r1"},
    video: {path: videoPath, durationSeconds: 1, captionEmbedding: "sidecar"},
    captions,
  });
  const deliveryPath = path.join(deliveryDir, "master-manifest.json");
  fs.writeFileSync(deliveryPath, `${JSON.stringify(delivery, null, 2)}\n`, "utf8");
  const handoff = buildPublishingHandoff({
    productionRoot: root,
    production: slug,
    deliveryManifestPath: deliveryPath,
    createdAt: "2026-08-31T01:00:00.000Z",
  });
  assert.equal(handoff.readyForHelper, true);
  assert.equal(handoff.thumbnail, null);
  assert.equal(handoff.approvals.youtubeWriteAuthorized, false);
  assert.equal(handoff.captions.revision, "c1");
  assert.equal("youtubeChannel" in handoff, false);
  const picturesHandoff = buildPublishingHandoff({
    productionRoot: root,
    production: slug,
    deliveryManifestPath: deliveryPath,
    youtubeChannel: "denopictures",
    createdAt: "2026-08-31T01:00:00.000Z",
  });
  assert.equal(picturesHandoff.youtubeChannel, "denopictures");
  assert.throws(
    () => buildPublishingHandoff({productionRoot: root, production: slug, deliveryManifestPath: deliveryPath, youtubeChannel: "other"}),
    /UNKNOWN_UPLOAD_CHANNEL/,
  );
  fs.appendFileSync(videoPath, "tamper", "utf8");
  assert.throws(
    () => buildPublishingHandoff({productionRoot: root, production: slug, deliveryManifestPath: deliveryPath}),
    /size mismatch|hash mismatch/,
  );
  const outside = path.join(root, "outside.json");
  fs.writeFileSync(outside, "{}\n", "utf8");
  assert.throws(
    () => buildPublishingHandoff({productionRoot: root, production: slug, deliveryManifestPath: outside}),
    /production folder/,
  );
  const unauthorizedVideoPath = path.join(root, "unauthorized-master.mp4");
  fs.writeFileSync(unauthorizedVideoPath, "outside-master", "utf8");
  const unauthorizedDelivery = buildDeliveryManifest({
    production: slug,
    createdAt: "2026-08-31T02:00:00.000Z",
    revisions: {edit: "e1", audio: "a1", motion: "m1", captions: "c1", render: "r2"},
    video: {path: unauthorizedVideoPath, durationSeconds: 1, captionEmbedding: "sidecar"},
    captions,
  });
  fs.writeFileSync(deliveryPath, `${JSON.stringify(unauthorizedDelivery, null, 2)}\n`, "utf8");
  assert.throws(
    () => buildPublishingHandoff({productionRoot: root, production: slug, deliveryManifestPath: deliveryPath}),
    /authorized production render\/delivery folder/,
  );
  assert.match(crypto.createHash("sha256").update(JSON.stringify(handoff)).digest("hex"), /^[a-f0-9]{64}$/u);
  console.log("PASS publishing handoff: exact master/final KO, no implicit YouTube approval, tamper and path boundary");
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
