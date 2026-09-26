"use strict";
const os = require("node:os");
const nodeFs = require("node:fs");
const nodePath = require("node:path");
const { writeProfileFixture } = require("../../publishing-core/tests/lib/profile_fixture.cjs");
// 채널 목록(channels.json)은 런타임 파일이므로 테스트는 예시 프로필을 쓴다. 모듈 적재 전에 환경을 잡는다.
const PROFILE_FIXTURE_ROOT = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "social-profile-fixture-"));
writeProfileFixture(PROFILE_FIXTURE_ROOT);
process.env.DENO_UPLOAD_HELPER_RUNTIME_ROOT = PROFILE_FIXTURE_ROOT;
const { fs, path, hashFile, writeJson } = require("../tools/lib/common.cjs");
const { context, PRODUCTION_ROOT } = require("../tools/lib/runtime.cjs");
const { normalizeSettings, normalizeManifest } = require("../tools/lib/publish_manifest.cjs");
const { prepareRun, updateRun, authorize } = require("../tools/lib/publish_run.cjs");
const NOW = Date.parse("2030-01-01T00:00:00Z");
function manifest(videoPath = path.resolve("clip.mp4")) {
  return {
    schemaVersion: 1, slug: "2030-01-01_테스트", video: { path: videoPath }, publishAt: "2030-01-02T19:00:00+09:00", targets: ["youtube", "instagram", "tiktok"],
    youtube: { title: "Test #Shorts", description: "A test. #Shorts", tags: ["Shorts", "Test"], categoryId: "28", madeForKids: false, containsSyntheticMedia: true, descriptionBlocks: "none",
      analysis: { summary: "Review", sampleCount: 9, reviewedSampleIndexes: [1,2,3,4,5,6,7,8,9], onScreenText: [], metadataRationale: "Evidence", audioAssessment: "Reviewed", audioAssessmentSource: "direct_review", reviewedAudioSha256: "b".repeat(64), reviewedContactSheetSha256: "c".repeat(64) } },
    instagram: { caption: "A test #test", shareToFeed: true, thumbOffsetMs: 0 }, tiktok: { caption: "A test #test", privacy: "public", allowComments: true, allowDuet: true, allowStitch: true },
  };
}
function source(file = path.resolve("clip.mp4")) {
  return { path: file, sha256: "a".repeat(64), size: 100, probe: { width: 1080, height: 1920, durationSeconds: 30, videoStreamCount: 1, fps: 30, videoCodec: "h264", audioStreamCount: 1, audioCodecs: ["aac"], audioSampleRates: [48000], fastStart: true } };
}
async function fixture(t, targets = ["youtube", "instagram", "tiktok"]) {
  const scratch = path.join(PRODUCTION_ROOT, "tmp");
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "social-test-"));
  t.after(async () => {
    if (!path.resolve(root).startsWith(path.resolve(scratch) + path.sep) || !path.basename(root).startsWith("social-test-")) throw new Error("Unsafe test cleanup path");
    await fs.rm(root, { recursive: true, force: true });
  });
  writeProfileFixture(path.join(root, "upload runtime"));
  const ctx = await context({ ...process.env, DENO_SOCIAL_PUBLISHING_RUNTIME_ROOT: path.join(root, "social runtime"), DENO_UPLOAD_HELPER_RUNTIME_ROOT: path.join(root, "upload runtime") });
  const video = path.join(root, "video with spaces.mp4");
  await fs.writeFile(video, "test bytes; no real media or network");
  const src = { ...source(video), ...await hashFile(video) };
  const raw = manifest(video); raw.targets = targets;
  if (targets.includes("threads")) raw.threads = { text: "Threads 테스트 #test" };
  if (targets.includes("x")) raw.x = { text: "X 테스트 #test" };
  const normalized = normalizeManifest(raw, { source: src, settings: normalizeSettings(), now: NOW });
  const prepared = await prepareRun({ ...normalized, source: src, settings: ctx.settings, preflight: { instagram: { remainingDays: 41 } } }, ctx.runtime);
  const input = path.join(root, "publish.json"); await writeJson(input, raw);
  return { root, ctx, raw, manifest: normalized.manifest, source: src, ...prepared, input, approve: async (immediate = false) => updateRun(prepared.paths, (s) => { authorize(s, undefined, Date.now()); if (immediate) s.authorization.immediateInstagram = true; }) };
}
module.exports = { NOW, manifest, source, fixture };
