"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeManifest, normalizeSettings, localTime, inspectSource } = require("../tools/lib/publish_manifest.cjs");
const { execFileAsync, path } = require("../tools/lib/common.cjs");
const { NOW, manifest, source, fixture } = require("./fixtures.cjs");
function validate(m = manifest(), s = source()) { return normalizeManifest(m, { source: s, now: NOW }); }
test("normalization preserves captions and converts KST to UTC", () => {
  const raw = manifest(); raw.instagram.caption = "  공백 보존\n#테스트  ";
  const result = validate(raw);
  assert.equal(result.manifest.publishAt, "2030-01-02T10:00:00.000Z");
  assert.equal(result.manifest.instagram.caption, raw.instagram.caption);
  assert.equal(result.manifest.youtube.privacy, "scheduled");
  assert.equal(result.publishAtLocal, "2030-01-02 19:00:00 KST");
  assert.match(localTime("2030-07-01T12:00:00Z", "America/New_York"), /08:00:00/);
});
const invalid = [
  ["schema", (m) => { m.schemaVersion = 2; }, "PUBLISH_FILE_INVALID"],
  ["relative video", (m) => { m.video.path = "clip.mp4"; }, "PUBLISH_FILE_INVALID"],
  ["hash mismatch", (m) => { m.video.sha256 = "d".repeat(64); }, "VIDEO_SHA_MISMATCH"],
  ["hash malformed", (m) => { m.video.sha256 = "invalid"; }, "PUBLISH_FILE_INVALID"],
  ["offset missing", (m) => { m.publishAt = "2030-01-02T10:00:00"; }, "PUBLISH_FILE_INVALID"],
  ["impossible date", (m) => { m.publishAt = "2030-02-30T10:00:00Z"; }, "PUBLISH_FILE_INVALID"],
  ["too soon", (m) => { m.publishAt = "2030-01-01T00:15:00Z"; }, "PUBLISH_AT_TOO_SOON"],
  ["tiktok 19 minutes", (m) => { m.publishAt = "2030-01-01T00:19:00Z"; }, "TIKTOK_SCHEDULE_WINDOW"],
  ["tiktok 11 days", (m) => { m.publishAt = "2030-01-12T00:00:00Z"; }, "TIKTOK_SCHEDULE_WINDOW"],
  ["tiktok seconds", (m) => { m.publishAt = "2030-01-02T00:00:01Z"; }, "TIKTOK_SCHEDULE_WINDOW"],
  ["empty targets", (m) => { m.targets = []; }, "PUBLISH_FILE_INVALID"],
  ["duplicate targets", (m) => { m.targets = ["youtube", "youtube"]; }, "PUBLISH_FILE_INVALID"],
  ["unknown target", (m) => { m.targets = ["facebook"]; }, "PUBLISH_FILE_INVALID"],
  ["title", (m) => { m.youtube.title = "A".repeat(101); }, "PUBLISH_FILE_INVALID"],
  ["title symbols", (m) => { m.youtube.title = "<x> #Shorts"; }, "PUBLISH_FILE_INVALID"],
  ["description UTF8", (m) => { m.youtube.description = "한".repeat(2000); }, "PUBLISH_FILE_INVALID"],
  ["tags", (m) => { m.youtube.tags = ["a".repeat(498) + " b"]; }, "PUBLISH_FILE_INVALID"],
  ["category", (m) => { m.youtube.categoryId = "x"; }, "PUBLISH_FILE_INVALID"],
  ["Shorts", (m) => { m.youtube.title = "x"; m.youtube.description = "x"; }, "PUBLISH_FILE_INVALID"],
  ["review", (m) => { delete m.youtube.analysis; }, "PUBLISH_FILE_INVALID"],
  ["review indexes", (m) => { m.youtube.analysis.reviewedSampleIndexes[8] = 8; }, "PUBLISH_FILE_INVALID"],
  ["privacy", (m) => { m.youtube.privacy = "friends"; }, "PUBLISH_FILE_INVALID"],
  ["description blocks", (m) => { m.youtube.descriptionBlocks = "x"; }, "PUBLISH_FILE_INVALID"],
  ["boolean", (m) => { m.youtube.madeForKids = "false"; }, "PUBLISH_FILE_INVALID"],
  ["instagram missing", (m) => { delete m.instagram; }, "PUBLISH_FILE_INVALID"],
  ["instagram caption", (m) => { m.instagram.caption = "x".repeat(2201); }, "PUBLISH_FILE_INVALID"],
  ["instagram tags", (m) => { m.instagram.caption = "#태그 ".repeat(31); }, "PUBLISH_FILE_INVALID"],
  ["instagram mentions", (m) => { m.instagram.caption = "@a ".repeat(21); }, "PUBLISH_FILE_INVALID"],
  ["instagram thumbnail", (m) => { m.instagram.thumbOffsetMs = 30000; }, "PUBLISH_FILE_INVALID"],
  ["tiktok caption", (m) => { m.tiktok.caption = " "; }, "PUBLISH_FILE_INVALID"],
  ["tiktok privacy", (m) => { m.tiktok.privacy = "private"; }, "PUBLISH_FILE_INVALID"],
];
for (const [name, mutate, code] of invalid) test(`reject ${name}`, () => {
  const raw = manifest(); mutate(raw);
  assert.throws(() => validate(raw), { code });
});
for (const [name, patch, code] of [
  ["streams", { videoStreamCount: 2 }, "PUBLISH_FILE_INVALID"],
  ["horizontal", { width: 1920, height: 1080 }, "PUBLISH_FILE_INVALID"],
  ["short length", { durationSeconds: 181 }, "PUBLISH_FILE_INVALID"],
  ["IG short", { durationSeconds: 2 }, "INSTAGRAM_SPEC"],
  ["IG width", { width: 2000, height: 2100 }, "INSTAGRAM_SPEC"],
  ["IG fps", { fps: 61 }, "INSTAGRAM_SPEC"],
  ["IG codec", { videoCodec: "vp9" }, "INSTAGRAM_SPEC"],
  ["IG audio codec", { audioCodecs: ["mp3"] }, "INSTAGRAM_SPEC"],
  ["IG audio rate", { audioSampleRates: [96000] }, "INSTAGRAM_SPEC"],
  ["IG fast start", { fastStart: false }, "INSTAGRAM_SPEC"],
]) test(`reject media ${name}`, () => { const s = source(); Object.assign(s.probe, patch); assert.throws(() => validate(manifest(), s), { code }); });
test("Instagram-only accepts longer reels and ignores unused blocks with warnings", () => {
  const m = manifest(); m.targets = ["instagram"]; m.youtube = null;
  const s = source(); s.probe.durationSeconds = 900;
  assert.equal(validate(m, s).manifest.youtube, undefined);
  assert.ok(validate(m, s).warnings.includes("IGNORED_PLATFORM_BLOCK:youtube"));
  s.probe.durationSeconds = 901; assert.throws(() => validate(m, s), { code: "INSTAGRAM_SPEC" });
  s.probe.durationSeconds = 10; s.size = 300000001; assert.throws(() => validate(m, s), { code: "INSTAGRAM_SPEC" });
});
test("Instagram-only preserves landscape without relaxing other short-form lanes", () => {
  const m = manifest(); m.targets = ["instagram"];
  const s = source(); Object.assign(s.probe, { width: 1920, height: 1080, durationSeconds: 185 });
  assert.deepEqual(validate(m, s).manifest.targets, ["instagram"]);
  s.probe.width = 1921;
  assert.throws(() => validate(m, s), { code: "INSTAGRAM_SPEC" });
  s.probe.width = 1920; s.probe.durationSeconds = 30;
  for (const targets of [["youtube"], ["youtube", "instagram"], ["threads"], ["x"], ["tiktok"]]) {
    m.targets = targets;
    assert.throws(() => validate(m, s), { code: "PUBLISH_FILE_INVALID" });
  }
});
test("settings reject channel changes and invalid zones", () => {
  assert.throws(() => normalizeSettings({ youtube: { expectedChannelId: "another" } }), { code: "YOUTUBE_CHANNEL_MISMATCH" });
  assert.throws(() => normalizeSettings({ schedule: { timezone: "Invalid/Zone" } }), { code: "PUBLISH_FILE_INVALID" });
  assert.throws(() => normalizeSettings({ schedule: { leadMinutes: -1 } }), { code: "PUBLISH_FILE_INVALID" });
});
test("real ffprobe sees vertical fast-start H264 AAC source", async (t) => {
  const f = await fixture(t, ["instagram"]);
  const video = path.join(f.root, "real fixture.mp4");
  await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=96x160:r=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", video], { windowsHide: true, timeout: 60000 });
  const actual = await inspectSource(video);
  assert.equal(actual.probe.fastStart, true);
  assert.equal(actual.probe.videoCodec, "h264");
  const raw = manifest(video); raw.targets = ["instagram"];
  assert.equal(normalizeManifest(raw, { source: actual, now: NOW }).manifest.video.sha256, actual.sha256);
  await assert.rejects(inspectSource(path.join(f.root, "missing.mp4")), { code: "VIDEO_MISSING" });
});
