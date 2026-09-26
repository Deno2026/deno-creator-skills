import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PREMIERE_CEP_LOCK_FILENAME,
  PremiereCepLockBusyError,
  acquirePremiereCepLock,
  inspectPremiereCepLock,
  installPremiereCepSignalHandlers,
  isProcessAlive,
  releasePremiereCepLock,
} from "./lib/premiere-cep-lock.mjs";

const scriptPath = fileURLToPath(import.meta.url);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runWorker(bridgeDirectory, holdMs = 500) {
  return runChild(["--worker-acquire", bridgeDirectory, String(holdMs)]);
}

function runChild(args) {
  const child = spawn(
    process.execPath,
    [scriptPath, ...args],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function signalWorkerMain(bridgeDirectory, signal) {
  const lock = await acquirePremiereCepLock({
    bridgeDirectory,
    tool: `self-test-${signal.toLowerCase()}`,
  });
  installPremiereCepSignalHandlers(() => lock.release());
  console.log(JSON.stringify({ event: "acquired", signal, pid: process.pid }));
  setTimeout(() => process.emit(signal), 25);
  await new Promise(() => {});
}

async function workerMain(bridgeDirectory, holdMs) {
  let lock;
  try {
    lock = await acquirePremiereCepLock({
      bridgeDirectory,
      tool: "self-test-worker",
      metadata: { worker: true },
    });
    console.log(
      JSON.stringify({ event: "acquired", pid: process.pid, token: lock.owner.token }),
    );
    await delay(holdMs);
    const released = await lock.release();
    console.log(JSON.stringify({ event: "released", released: released.released }));
  } catch (error) {
    if (error instanceof PremiereCepLockBusyError) {
      console.log(
        JSON.stringify({
          event: "busy",
          ownerPid: error.inspection?.owner?.pid || null,
        }),
      );
      process.exitCode = 23;
      return;
    }
    throw error;
  }
}

async function selfTest() {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "premiere-cep-lock-self-test-"),
  );
  const checks = [];

  try {
    const concurrentDirectory = path.join(fixtureRoot, "concurrent");
    const concurrentResults = await Promise.all([
      runWorker(concurrentDirectory),
      runWorker(concurrentDirectory),
    ]);
    const winner = concurrentResults.filter((result) => result.code === 0);
    const blocked = concurrentResults.filter((result) => result.code === 23);
    assert.equal(winner.length, 1, JSON.stringify(concurrentResults, null, 2));
    assert.equal(blocked.length, 1, JSON.stringify(concurrentResults, null, 2));
    assert.match(winner[0].stdout, /"event":"acquired"/);
    assert.match(blocked[0].stdout, /"event":"busy"/);
    assert.equal(
      (await inspectPremiereCepLock({ bridgeDirectory: concurrentDirectory })).status,
      "unlocked",
    );
    checks.push("concurrent-wx-single-winner");

    const liveOwnerDirectory = path.join(fixtureRoot, "live-owner");
    const liveOwnerLock = await acquirePremiereCepLock({
      bridgeDirectory: liveOwnerDirectory,
      tool: "self-test-live-owner",
    });
    const beforeBlockedAttempt = JSON.parse(
      await readFile(liveOwnerLock.lockPath, "utf8"),
    );
    const liveBlocked = await runWorker(liveOwnerDirectory, 10);
    assert.equal(liveBlocked.code, 23, liveBlocked.stderr || liveBlocked.stdout);
    const afterBlockedAttempt = JSON.parse(
      await readFile(liveOwnerLock.lockPath, "utf8"),
    );
    assert.equal(afterBlockedAttempt.token, beforeBlockedAttempt.token);
    assert.equal(afterBlockedAttempt.pid, process.pid);
    assert.equal(
      (await inspectPremiereCepLock({ bridgeDirectory: liveOwnerDirectory })).status,
      "live",
    );
    await liveOwnerLock.release();
    checks.push("live-owner-preserved");

    const staleDirectory = path.join(fixtureRoot, "dead-stale");
    const staleLockPath = path.join(
      staleDirectory,
      PREMIERE_CEP_LOCK_FILENAME,
    );
    const deadPid = [2147483647, 99999999].find((pid) => !isProcessAlive(pid));
    assert.ok(deadPid, "Could not find a fixture PID known to be dead.");
    await mkdir(staleDirectory, { recursive: true });
    const staleOwner = {
      version: 1,
      token: "dead-stale-fixture",
      pid: deadPid,
      startedAt: "2000-01-01T00:00:00.000Z",
      tool: "dead-fixture",
    };
    await writeFile(staleLockPath, `${JSON.stringify(staleOwner)}\n`, "utf8");
    assert.equal(
      (await inspectPremiereCepLock({ lockPath: staleLockPath })).status,
      "stale",
    );
    const recovered = await acquirePremiereCepLock({
      bridgeDirectory: staleDirectory,
      tool: "self-test-stale-recovery",
    });
    assert.equal(recovered.recoveredStaleOwner?.token, staleOwner.token);
    assert.equal(recovered.owner.pid, process.pid);
    await recovered.release();
    checks.push("dead-pid-stale-recovered");

    const wrongOwnerDirectory = path.join(fixtureRoot, "wrong-owner");
    const realLock = await acquirePremiereCepLock({
      bridgeDirectory: wrongOwnerDirectory,
      tool: "self-test-wrong-owner",
    });
    const wrongRelease = await releasePremiereCepLock({
      lockPath: realLock.lockPath,
      owner: { ...realLock.owner, token: "wrong-owner-token" },
    });
    assert.equal(wrongRelease.released, false);
    assert.equal(wrongRelease.reason, "not-owner");
    const stillOwned = await inspectPremiereCepLock({
      bridgeDirectory: wrongOwnerDirectory,
    });
    assert.equal(stillOwned.status, "live");
    assert.equal(stillOwned.owner.token, realLock.owner.token);
    await realLock.release();
    checks.push("wrong-owner-unlock-blocked");

    for (const signal of ["SIGINT", "SIGTERM"]) {
      const signalDirectory = path.join(
        fixtureRoot,
        `signal-${signal.toLowerCase()}`,
      );
      const signalResult = await runChild([
        "--worker-self-signal",
        signalDirectory,
        signal,
      ]);
      assert.equal(
        signalResult.code,
        signal === "SIGINT" ? 130 : 143,
        signalResult.stderr || signalResult.stdout,
      );
      assert.equal(
        (await inspectPremiereCepLock({ bridgeDirectory: signalDirectory }))
          .status,
        "unlocked",
      );
    }
    checks.push("sigint-sigterm-owner-release");

    const repeatedDirectory = path.join(fixtureRoot, "repeated");
    for (let index = 0; index < 25; index += 1) {
      const lock = await acquirePremiereCepLock({
        bridgeDirectory: repeatedDirectory,
        tool: `self-test-repeat-${index}`,
      });
      assert.equal(
        (await inspectPremiereCepLock({ bridgeDirectory: repeatedDirectory }))
          .owner.token,
        lock.owner.token,
      );
      const release = await lock.release();
      assert.equal(release.released, true);
      assert.equal(
        (await inspectPremiereCepLock({ bridgeDirectory: repeatedDirectory }))
          .status,
        "unlocked",
      );
    }
    checks.push("repeated-acquire-release-25x");

    console.log(
      JSON.stringify(
        {
          ok: true,
          fixtureRoot,
          checks,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

const [mode, bridgeDirectory, holdMs] = process.argv.slice(2);
if (mode === "--worker-acquire") {
  workerMain(bridgeDirectory, Number(holdMs) || 500).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
} else if (mode === "--worker-self-signal") {
  signalWorkerMain(bridgeDirectory, holdMs || "SIGINT").catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
} else {
  selfTest().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
