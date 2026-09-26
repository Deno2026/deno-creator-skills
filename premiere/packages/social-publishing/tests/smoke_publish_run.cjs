"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { fs, path, writeJson, readJson } = require("../tools/lib/common.cjs");
const { acquireLock, prepareRun, loadRun, updateRun, setLane, authorize, runPaths } = require("../tools/lib/publish_run.cjs");
const { fixture } = require("./fixtures.cjs");
test("one SHA has one run; pre-execution changes allowed; authorized copy immutable", async (t) => {
  const f = await fixture(t);
  const next = structuredClone(f.manifest); next.slug = "changed";
  const updated = await prepareRun({ manifest: next, source: f.source, settings: f.ctx.settings, publishAtLocal: f.state.publishAtLocal, preflight: {} }, f.ctx.runtime);
  assert.equal(updated.state.runId, f.state.runId);
  await f.approve();
  await assert.rejects(prepareRun({ manifest: next, source: f.source }, f.ctx.runtime), { code: "RUN_ALREADY_EXECUTED" });
  await assert.rejects(updateRun(f.paths, (s) => authorize(s)), { code: "RUN_ALREADY_EXECUTED" });
  await writeJson(f.paths.manifestPath, { ...next, slug: "tampered" });
  await assert.rejects(loadRun(f.paths), { code: "PUBLISH_FILE_INVALID" });
});
test("locks reject concurrent owner and recover a stale pid", async (t) => {
  const f = await fixture(t);
  const release = await acquireLock(f.paths.lockPath);
  await assert.rejects(acquireLock(f.paths.lockPath), { code: "RUN_LOCKED" });
  await release();
  await writeJson(f.paths.lockPath, { pid: 2147483647, nonce: "dead" });
  const recovered = await acquireLock(f.paths.lockPath);
  await recovered();
  await fs.writeFile(f.paths.lockPath, "");
  await assert.rejects(acquireLock(f.paths.lockPath), { code: "RUN_LOCKED" });
});
test("state transitions require approval, permit failed lane retry, preserve completed lanes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(updateRun(f.paths, (s) => setLane(s, "instagram", "staging")), { code: "PUBLISH_NOT_APPROVED" });
  await f.approve();
  await updateRun(f.paths, (s) => { setLane(s, "youtube", "verified_public"); setLane(s, "instagram", "failed"); });
  await updateRun(f.paths, (s) => authorize(s, "instagram"));
  await assert.rejects(updateRun(f.paths, (s) => authorize(s, "youtube")), { code: "RUN_ALREADY_EXECUTED" });
  await assert.rejects(updateRun(f.paths, (s) => setLane(s, "youtube", "pending")), { code: "RUN_ALREADY_EXECUTED" });
  assert.equal((await loadRun(f.paths)).state.state, "partial");
  assert.throws(() => runPaths("../unsafe", f.ctx.runtime), { code: "PUBLISH_FILE_INVALID" });
});
test("concurrent lane updates retain both results", async (t) => {
  const f = await fixture(t); await f.approve();
  await Promise.all([
    updateRun(f.paths, (s) => setLane(s, "instagram", "task_registered", { taskName: "test" })),
    updateRun(f.paths, (s) => setLane(s, "tiktok", "handoff_ready", { url: "test" })),
  ]);
  const { lanes } = await readJson(f.paths.statePath);
  assert.equal(lanes.instagram.taskName, "test"); assert.equal(lanes.tiktok.url, "test");
});
