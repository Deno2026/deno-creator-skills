"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { preflight, execute, status, cancel, inspect } = require("../tools/publish_short_multi.cjs");
const { recordExternalPost } = require("../tools/record_external_post.cjs");
const { recordStudioCheck } = require("../tools/record_youtube_studio_check.cjs");
const { loadRun, updateRun, setLane } = require("../tools/lib/publish_run.cjs");
const { path, fs, readJson, writeJson, fail, execFileAsync } = require("../tools/lib/common.cjs");
const { metadataArgs, parseProtocol, youtubeChild } = require("../tools/lib/youtube_child.cjs");
const { fixture, NOW } = require("./fixtures.cjs");
function fakeYoutube(f) {
  const calls = [];
  return { calls, child: async (args) => {
    calls.push(args);
    if (args.includes("--inspect")) return { records: [{ type: "SHORTS_INSPECTION_READY", value: { inspectionPath: "fixture" } }] };
    if (args.includes("--preflight")) return { records: [{ type: "PREFLIGHT_COMPLETE", value: { channelId: f.ctx.settings.youtube.expectedChannelId, runId: `private-short-${f.source.sha256}` } }] };
    return { records: [{ type: "FINAL_RESULT", value: { runId: `private-short-${f.source.sha256}`, videoId: "test12345AB", shortsUrl: "https://www.youtube.com/shorts/test12345AB", verified: true, privacyStatus: args.includes("--verify-only") ? "public" : "private", publishAt: f.manifest.publishAt } }] };
  } };
}
test("preflight performs reads only, inspect delegates and emits review paths", async (t) => {
  const f = await fixture(t); const youtube = fakeYoutube(f); let heads = 0;
  const deps = { now: () => NOW, inspectSource: async () => f.source, youtubeChild: youtube.child, credentials: { username: "test", status: { remainingDays: 41, expiresAt: "2030-03-01T00:00:00Z" } }, r2: { headBucket: async () => { heads++; } } };
  await inspect(f.input, f.ctx, deps);
  const result = await preflight(f.input, f.ctx, deps);
  assert.equal(heads, 1); assert.equal(result.state.authorization, null);
  assert.equal(youtube.calls.length, 2); assert.ok(youtube.calls[1].includes("--preflight"));
  assert.equal((await loadRun(f.paths)).state.state, "preflight_ok");
});
test("YouTube failure still registers Instagram and prepares TikTok; retry targets only failed lane", async (t) => {
  const f = await fixture(t); let registered = 0; const youtube = fakeYoutube(f);
  const deps = { now: () => NOW, youtubeChild: async () => { throw fail("YOUTUBE_CHILD_FAILED"); }, recoverYoutubeLink: async () => ({}), windowsTask: { register: async () => { registered++; return { taskName: "test-task" }; } } };
  const result = await execute(f.state.runId, {}, f.ctx, deps);
  assert.equal(result.exitCode, 2); assert.equal(registered, 1);
  assert.equal(result.state.lanes.youtube.state, "failed"); assert.equal(result.state.lanes.instagram.state, "task_registered"); assert.equal(result.state.lanes.tiktok.state, "handoff_ready");
  assert.equal((await readJson(path.join(f.paths.runDir, "tiktok/handoff.json"))).caption, f.manifest.tiktok.caption);
  await assert.rejects(execute(f.state.runId, {}, f.ctx, deps), { code: "RUN_ALREADY_EXECUTED" });
  await assert.rejects(preflight(f.input, f.ctx, { ...deps, inspectSource: async () => f.source }), { code: "RUN_ALREADY_EXECUTED" });
  const retried = await execute(f.state.runId, { lane: "youtube" }, f.ctx, { ...deps, youtubeChild: youtube.child });
  assert.equal(retried.state.lanes.youtube.state, "uploaded_scheduled"); assert.equal(registered, 1);
  assert.equal(youtube.calls.length, 1);
});
test("approved metadata sidecar is regenerated; edited publish.json is blocked", async (t) => {
  const f = await fixture(t, ["youtube"]); const youtube = fakeYoutube(f);
  const metadataPath = path.join(f.paths.runDir, "youtube/metadata.json");
  await writeJson(metadataPath, { title: "tampered" });
  await execute(f.state.runId, {}, f.ctx, { now: () => NOW, youtubeChild: youtube.child });
  assert.equal((await readJson(metadataPath)).title, f.manifest.youtube.title);
  await writeJson(f.paths.manifestPath, { ...f.manifest, publishAt: "2030-01-03T00:00:00Z" });
  await assert.rejects(execute(f.state.runId, { lane: "youtube" }, f.ctx, { now: () => NOW, youtubeChild: youtube.child }), { code: "PUBLISH_FILE_INVALID" });
});
test("browser and studio receipts feed a single status report, no platform writes", async (t) => {
  const f = await fixture(t); const youtube = fakeYoutube(f);
  await execute(f.state.runId, {}, f.ctx, { now: () => NOW, youtubeChild: youtube.child, windowsTask: { register: async () => ({ taskName: "test" }) } });
  const evidence = path.join(f.root, "screenshot.png"); await fs.writeFile(evidence, Buffer.from("89504e470d0a1a0a", "hex"));
  await assert.rejects(recordExternalPost({ runId: f.state.runId, platform: "tiktok", state: "scheduled_by_browser", scheduledAt: "2030-01-03T00:00:00Z", evidence }, f.ctx), { code: "TIKTOK_SCHEDULE_MISMATCH" });
  await recordExternalPost({ runId: f.state.runId, platform: "tiktok", state: "scheduled_by_browser", scheduledAt: f.manifest.publishAt, evidence }, f.ctx);
  await recordExternalPost({ runId: f.state.runId, platform: "tiktok", state: "published", url: "https://www.tiktok.com/@deno/video/12345", evidence }, f.ctx);
  await recordStudioCheck({ runId: f.state.runId, checks: "copyright=claimed,ad_suitability=limited", monetization: "on", scheduledVisible: true, observedAt: new Date(NOW).toISOString() }, f.ctx, { now: () => NOW });
  await writeJson(path.join(f.paths.runDir, "instagram/result.json"), { runId: f.state.runId, manifestSha256: f.state.manifestSha256, mediaId: "456", permalink: "https://www.instagram.com/reel/test/", r2Deleted: true });
  const output = path.join(f.root, "published-result.json");
  const response = await status(f.state.runId, output, f.ctx, { youtubeChild: youtube.child, recoverYoutubeLink: async () => ({ directShortRunId: `private-short-${f.source.sha256}`, videoId: "test12345AB", shortsUrl: "https://www.youtube.com/shorts/test12345AB" }), windowsTask: { query: async () => ({ exists: true, lastTaskResult: 0 }) } });
  assert.equal(response.summary.state, "complete");
  assert.ok(response.summary.warnings.includes("YOUTUBE_COPYRIGHT_CLAIMED")); assert.ok(response.summary.warnings.includes("YOUTUBE_AD_SUITABILITY_LIMITED"));
  assert.equal(response.summary.lanes.tiktok.state, "published");
  assert.equal((await readJson(output)).runId, f.state.runId);
  assert.ok(youtube.calls.at(-1).includes("--verify-only"));
});
test("missing Instagram result becomes MISSED and cancellation only removes its task", async (t) => {
  const f = await fixture(t, ["instagram"]); await f.approve();
  await updateRun(f.paths, (s) => setLane(s, "instagram", "task_registered", { taskName: "test" }));
  let removals = 0;
  const deps = { now: () => Date.parse(f.state.publishAt) + 31 * 60000, windowsTask: { query: async () => ({ exists: false }), remove: async () => { removals++; } } };
  const result = await status(f.state.runId, null, f.ctx, deps);
  assert.equal(result.summary.lanes.instagram.state, "missed"); assert.ok(result.summary.warnings.includes("MISSED"));
  await cancel(f.state.runId, f.ctx, deps);
  assert.equal(removals, 1); assert.equal((await loadRun(f.paths)).state.state, "cancelled");
});
test("child protocol uses actual process output and rejects credential-bearing failures", async (t) => {
  const f = await fixture(t, ["youtube"]);
  assert.equal(parseProtocol('PREFLIGHT_COMPLETE {"runId":"x"}\n')[0].value.runId, "x");
  const args = metadataArgs(f.manifest, "metadata.json", f.ctx);
  assert.ok(args.includes("--publish-at")); assert.ok(args.includes("--expected-channel-id"));
  await assert.rejects(youtubeChild(args, f.ctx, async () => { throw { code: 1, stderr: "https://secret-token.invalid" }; }), (error) => error.code === "YOUTUBE_CHILD_FAILED" && !error.message.includes("secret-token"));
  const pending = await youtubeChild(args, f.ctx, async () => { throw { code: 2, stdout: 'FINAL_RESULT {"verified":false}\n', stderr: "secret" }; });
  assert.equal(pending.exitCode, 2);
});
test("CLI help and invalid modes execute locally without credentials or network", async (t) => {
  const f = await fixture(t);
  const entry = path.join(f.ctx.productionRoot, "packages/social-publishing/tools/publish_short_multi.cjs");
  const help = await execFileAsync(process.execPath, [entry, "--help"], { env: f.ctx.env, windowsHide: true });
  assert.ok(help.stdout.includes("--preflight"));
  await assert.rejects(execFileAsync(process.execPath, [entry, "--execute", "--status"], { env: f.ctx.env, windowsHide: true }), (e) => /SOCIAL_PUBLISH_FAILED CLI_INVALID/.test(e.stderr));
});
