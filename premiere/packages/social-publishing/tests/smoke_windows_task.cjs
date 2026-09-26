"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCmd, buildVbs, vbsPathFor, buildActionArguments, buildRegisterScript, register, remove, query, powershell } = require("../tools/lib/windows_task.cjs");
const { path, readJson, fs } = require("../tools/lib/common.cjs");
const { fixture } = require("./fixtures.cjs");
test("PowerShell uses offset-aware dates, interactive principal, wake, bounded runtime and a windowless wscript action", () => {
  const script = buildRegisterScript({ runId: "pub-0123456789abcdef", publishAt: "2030-01-02T19:00:00+09:00", leadMinutes: 10, cmdPath: "E:\\DENO Runtime\\a'b\\instagram.cmd" });
  for (const text of ["Register-ScheduledTask", "2030-01-02T09:50:00.000Z", "InvariantCulture", "LocalDateTime", "-StartWhenAvailable", "-WakeToRun", "-AllowStartIfOnBatteries", "-Hours 2", "-LogonType Interactive", "System32\\wscript.exe", "//B //NoLogo \"E:\\DENO Runtime\\a''b\\instagram.vbs\""]) assert.ok(script.includes(text), text);
  for (const text of ["-WindowStyle", "-EncodedCommand", "powershell.exe", "schtasks"]) assert.ok(!script.includes(text), `must not contain ${text}`);
});
test("VBS launcher starts cmd hidden with the batch path double-quoted for /s and rejects unsafe paths", () => {
  const vbs = buildVbs("E:\\DENO Runtime\\a'b\\instagram.cmd");
  assert.ok(vbs.includes('CreateObject("WScript.Shell")'));
  assert.ok(vbs.includes('" /d /s /c " & Chr(34) & Chr(34) & "E:\\DENO Runtime\\a\'b\\instagram.cmd" & Chr(34) & Chr(34), 0, True)'));
  assert.ok(vbs.includes("WScript.Quit exitCode"));
  assert.equal(vbsPathFor("E:\\x\\threads-scheduled.cmd"), "E:\\x\\threads-scheduled.vbs");
  assert.equal(buildActionArguments("E:\\x\\threads-scheduled.cmd"), '//B //NoLogo "E:\\x\\threads-scheduled.vbs"');
  assert.throws(() => buildVbs('E:\\unsafe"x.cmd'), { code: "SCHEDULER_PATH_INVALID" });
  assert.throws(() => vbsPathFor("E:\\x\\not-a-batch.txt"), { code: "SCHEDULER_PATH_INVALID" });
});
test("batch preserves space paths, escapes percent, disables delayed expansion", () => {
  const cmd = buildCmd({ runId: "pub-0123456789abcdef", nodePath: "C:\\Program Files\\nodejs\\node.exe", toolPath: "E:\\My & Code\\publish.cjs", socialRoot: "E:\\Social 100% !\\runtime", uploadRoot: "E:\\Upload runtime", productionRoot: "E:\\Code root", logPath: "E:\\Social\\logs\\job.log" });
  assert.match(cmd, /"C:\\Program Files\\nodejs\\node.exe" "E:\\My & Code\\publish.cjs"/);
  assert.ok(cmd.includes("100%% !")); assert.ok(cmd.includes("DisableDelayedExpansion"));
  assert.ok(cmd.includes("--scheduled >>")); assert.ok(cmd.includes("exit /b %errorlevel%"));
  assert.throws(() => buildCmd({ runId: "pub-0123456789abcdef", toolPath: 'E:\\unsafe"x' }), { code: "SCHEDULER_PATH_INVALID" });
});
test("register writes the cmd and vbs pair and remove requires scheduler readback without touching the actual scheduler", async (t) => {
  const f = await fixture(t, ["instagram"]); const scripts = [];
  let exists = false;
  const run = async (script) => { scripts.push(script); if (script.includes("Register-ScheduledTask -TaskName")) exists = true;
    if (script.includes("Unregister-ScheduledTask")) exists = false;
    return { stdout: JSON.stringify({ exists, lastTaskResult: 0 }) }; };
  const result = await register({ runId: f.state.runId, publishAt: f.state.publishAt, leadMinutes: 10, runDir: f.paths.runDir, socialRoot: f.ctx.runtime.runtimeRoot,
    uploadRoot: f.ctx.uploadRuntime.runtimeRoot, productionRoot: f.ctx.productionRoot, toolPath: path.join(f.ctx.productionRoot, "packages/social-publishing/tools/publish_instagram_reel.cjs") }, run);
  assert.equal(result.state, "registered");
  assert.ok((await fs.readFile(result.cmdPath, "utf8")).includes("DENO_SOCIAL_PUBLISHING_RUNTIME_ROOT"));
  assert.ok((await fs.readFile(vbsPathFor(result.cmdPath), "utf8")).includes("WScript.Quit exitCode"));
  assert.equal((await readJson(path.join(f.paths.runDir, "instagram/scheduled-task.json"))).state, "registered");
  assert.equal((await query(f.state.runId, run)).exists, true);
  assert.equal((await remove(f.state.runId, run)).exists, false);
  assert.equal(scripts.length, 5);
});
test("generated wscript action launches the batch without a console and preserves its exit code", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t, ["instagram"]);
  const toolPath = path.join(f.root, "dummy child.cjs");
  const logPath = path.join(f.root, "action.log");
  const cmdPath = path.join(f.root, "action.cmd");
  await fs.writeFile(toolPath, 'process.stdout.write(JSON.stringify({social:process.env.DENO_SOCIAL_PUBLISHING_RUNTIME_ROOT, args:process.argv.slice(2)})); process.exitCode=17;', "utf8");
  await fs.writeFile(cmdPath, buildCmd({ runId: f.state.runId, toolPath, socialRoot: f.ctx.runtime.runtimeRoot, uploadRoot: f.ctx.uploadRuntime.runtimeRoot, productionRoot: f.ctx.productionRoot, logPath }), "utf8");
  await fs.writeFile(vbsPathFor(cmdPath), buildVbs(cmdPath), "utf8");
  // Execute only the isolated dummy action through the same wscript command the task would use, never Register-ScheduledTask or any publishing tool.
  const { execFileAsync } = require("../tools/lib/common.cjs");
  const [execute, ...args] = ["wscript.exe", "//B", "//NoLogo", vbsPathFor(cmdPath)];
  await assert.rejects(execFileAsync(execute, args, { windowsHide: true, timeout: 30000 }), (error) => error.code === 17);
  const observed = JSON.parse(await fs.readFile(logPath, "utf8"));
  assert.equal(observed.social, f.ctx.runtime.runtimeRoot);
  assert.deepEqual(observed.args, ["--run-id", f.state.runId, "--scheduled"]);
});
