"use strict";

const { fs, path, execFileAsync, fail, writeJson } = require("./common.cjs");
const { SAFE_RUN_ID } = require("./publish_run.cjs");
function ps(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function batch(value) {
  if (typeof value !== "string" || /["\r\n\x00]/u.test(value) || !path.isAbsolute(value)) throw fail("SCHEDULER_PATH_INVALID");
  return value.replace(/%/g, "%%");
}
function taskIdentity(runId, lane = "instagram") {
  if (!SAFE_RUN_ID.test(runId) || !["instagram", "threads", "x"].includes(lane)) throw fail("PUBLISH_FILE_INVALID");
  const name = lane === "instagram" ? runId : `${runId}-${lane}`;
  return { name, taskPath: "\\DENO\\social-publishing\\", fullName: `DENO\\social-publishing\\${name}` };
}
function buildCmd({ nodePath = process.execPath, toolPath, socialRoot, uploadRoot, productionRoot, runId, logPath }) {
  taskIdentity(runId);
  return ["@echo off", "setlocal DisableDelayedExpansion", "chcp 65001 >nul",
    `set "DENO_SOCIAL_PUBLISHING_RUNTIME_ROOT=${batch(socialRoot)}"`,
    `set "DENO_UPLOAD_HELPER_RUNTIME_ROOT=${batch(uploadRoot)}"`,
    `set "DENO_PRODUCTION_ROOT=${batch(productionRoot)}"`,
    `"${batch(nodePath)}" "${batch(toolPath)}" --run-id ${runId} --scheduled >> "${batch(logPath)}" 2>&1`,
    "exit /b %errorlevel%", "",
  ].join("\r\n");
}
function vbsPathFor(cmdPath) {
  batch(cmdPath);
  if (!/\.cmd$/iu.test(cmdPath)) throw fail("SCHEDULER_PATH_INVALID");
  return cmdPath.replace(/\.cmd$/iu, ".vbs");
}
// wscript //B runs this launcher without any console; Run(..., 0, True) starts cmd hidden from the first frame.
// The former hidden-PowerShell action created a console and then hid it, which flashed a terminal window twice per post (2026-09-16).
function buildVbs(cmdPath) {
  batch(cmdPath);
  return [
    "Option Explicit",
    "Dim shell, cmdExe, exitCode",
    'Set shell = CreateObject("WScript.Shell")',
    'cmdExe = shell.ExpandEnvironmentStrings("%SystemRoot%\\System32\\cmd.exe")',
    "' Window style 0 never shows a console; waiting keeps Task Scheduler ownership and returns the batch exit code.",
    `exitCode = shell.Run(Chr(34) & cmdExe & Chr(34) & " /d /s /c " & Chr(34) & Chr(34) & "${cmdPath}" & Chr(34) & Chr(34), 0, True)`,
    "WScript.Quit exitCode", "",
  ].join("\r\n");
}
function buildActionArguments(cmdPath) {
  return `//B //NoLogo "${vbsPathFor(cmdPath)}"`;
}
function buildRegisterScript({ runId, publishAt, leadMinutes, cmdPath, lane = "instagram" }) {
  const task = taskIdentity(runId, lane);
  const at = new Date(Date.parse(publishAt) - leadMinutes * 60000).toISOString();
  const launchArgs = buildActionArguments(cmdPath);
  return [
    "$ErrorActionPreference = 'Stop'",
    "$scheduler = New-Object -ComObject 'Schedule.Service'", "$scheduler.Connect()",
    "$folder = $scheduler.GetFolder('\\')",
    "foreach ($part in @('DENO', 'social-publishing')) { try { $folder = $folder.GetFolder($part) } catch { $folder = $folder.CreateFolder($part) } }",
    `$triggerAt = [DateTimeOffset]::Parse(${ps(at)}, [Globalization.CultureInfo]::InvariantCulture).LocalDateTime`,
    "$trigger = New-ScheduledTaskTrigger -Once -At $triggerAt",
    "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew",
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited",
    `$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\\wscript.exe') -Argument ${ps(launchArgs)}`,
    `$existing = Get-ScheduledTask -TaskPath ${ps(task.taskPath)} -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -eq ${ps(task.name)} }`,
    "if ($null -ne $existing -and ($existing.Actions.Count -ne 1 -or $existing.Actions[0].Execute -ne $action.Execute -or $existing.Actions[0].Arguments -ne $action.Arguments)) { throw 'SCHEDULER_CONFLICT' }",
    `Register-ScheduledTask -TaskName ${ps(task.name)} -TaskPath ${ps(task.taskPath)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null`,
  ].join("\n");
}
async function powershell(script) {
  if (process.platform !== "win32") throw fail("WINDOWS_REQUIRED");
  try {
    return await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  } catch (error) { throw fail(String(error.stderr ?? "").includes("SCHEDULER_CONFLICT") ? "SCHEDULER_CONFLICT" : "SCHEDULER_FAILED"); }
}
async function query(runId, run = powershell, lane = "instagram") {
  const task = taskIdentity(runId, lane);
  const { stdout } = await run([
    "$ErrorActionPreference = 'Stop'",
    "$service = New-Object -ComObject 'Schedule.Service'", "$service.Connect()",
    `$task = $null; $missing = $false; try { $null = $service.GetFolder(${ps(task.taskPath.slice(0, -1))}).GetTask(${ps(task.name)}) } catch { $exception = $_.Exception; while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }; if ($exception.HResult -in @(-2147024894, -2147024893)) { $missing = $true } else { throw } }`,
    `if (-not $missing) { $task = Get-ScheduledTask -TaskPath ${ps(task.taskPath)} -TaskName ${ps(task.name)} -ErrorAction Stop }`,
    "if ($null -eq $task) { Write-Output '{\"exists\":false}'; exit 0 }",
    "$info = $task | Get-ScheduledTaskInfo",
    "@{ exists = $true; state = [string]$task.State; lastTaskResult = $info.LastTaskResult; lastRunTime = $info.LastRunTime.ToUniversalTime().ToString('o'); nextRunTime = $info.NextRunTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress",
  ].join("\n"));
  try { return { taskName: task.fullName, ...JSON.parse(stdout.trim()) }; }
  catch { throw fail("SCHEDULER_READBACK_FAILED"); }
}
async function register(options, run = powershell) {
  const lane = options.lane ?? "instagram";
  taskIdentity(options.runId, lane);
  const folder = path.join(options.runDir, lane);
  const cmdPath = path.join(folder, `${lane}-scheduled.cmd`);
  const logPath = path.join(options.runDir, "logs", `${lane}-scheduled.log`);
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(cmdPath, buildCmd({ ...options, logPath }), "utf8");
  await fs.writeFile(vbsPathFor(cmdPath), buildVbs(cmdPath), "utf8");
  const record = { taskName: taskIdentity(options.runId, lane).fullName, triggerAt: new Date(Date.parse(options.publishAt) - options.leadMinutes * 60000).toISOString(), publishAt: options.publishAt, cmdPath, state: "registering" };
  const recordPath = path.join(folder, "scheduled-task.json");
  await writeJson(recordPath, record);
  await run(buildRegisterScript({ ...options, cmdPath }));
  const observed = await query(options.runId, run, lane);
  if (!observed.exists) throw fail("SCHEDULER_READBACK_FAILED");
  Object.assign(record, { state: "registered", registeredAt: new Date().toISOString(), observed });
  await writeJson(recordPath, record);
  return record;
}
async function remove(runId, run = powershell, expectedCmdPath = null, lane = "instagram") {
  const task = taskIdentity(runId, lane);
  let guard = "";
  if (expectedCmdPath) {
    guard = `if ($null -ne $task -and ($task.Actions.Count -ne 1 -or $task.Actions[0].Arguments -ne ${ps(buildActionArguments(expectedCmdPath))})) { throw 'SCHEDULER_CONFLICT' }`;
  }
  await run([
    "$ErrorActionPreference = 'Stop'",
    "$service = New-Object -ComObject 'Schedule.Service'", "$service.Connect()",
    `$task = $null; $missing = $false; try { $null = $service.GetFolder(${ps(task.taskPath.slice(0, -1))}).GetTask(${ps(task.name)}) } catch { $exception = $_.Exception; while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }; if ($exception.HResult -in @(-2147024894, -2147024893)) { $missing = $true } else { throw } }`,
    `if (-not $missing) { $task = Get-ScheduledTask -TaskPath ${ps(task.taskPath)} -TaskName ${ps(task.name)} -ErrorAction Stop }`,
    guard,
    "if ($null -ne $task) { $task | Unregister-ScheduledTask -Confirm:$false }",
  ].join("\n"));
  const result = await query(runId, run, lane);
  if (result.exists) throw fail("SCHEDULER_REMOVE_UNVERIFIED");
  return result;
}
module.exports = { ps, batch, taskIdentity, buildCmd, buildVbs, vbsPathFor, buildActionArguments, buildRegisterScript, powershell, register, query, remove };
