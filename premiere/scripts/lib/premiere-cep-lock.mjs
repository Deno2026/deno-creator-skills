import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const PREMIERE_CEP_LOCK_FILENAME = ".deno-premiere-cep.lock.json";

const DEFAULT_CLOSE_TIMEOUT_MS = 2500;
const DEFAULT_EXIT_TIMEOUT_MS = 3000;
const PROCESS_POLL_INTERVAL_MS = 50;

export class PremiereCepLockBusyError extends Error {
  constructor(lockPath, inspection) {
    const owner = inspection?.owner;
    const ownerDescription = owner
      ? `PID ${owner.pid} (${owner.tool || "unknown tool"}, started ${owner.startedAt || "unknown"})`
      : "an unreadable owner";
    super(
      `Premiere live lane is already in use by ${ownerDescription}. ` +
        `Lock: ${lockPath}`,
    );
    this.name = "PremiereCepLockBusyError";
    this.code = "PREMIERE_CEP_LOCK_BUSY";
    this.lockPath = lockPath;
    this.inspection = inspection;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function ownerMatches(left, right) {
  return Boolean(
    left &&
      right &&
      left.token === right.token &&
      Number(left.pid) === Number(right.pid) &&
      left.startedAt === right.startedAt,
  );
}

function lockError(error, message, code) {
  const wrapped = new Error(`${message}: ${error?.message || String(error)}`);
  wrapped.name = "PremiereCepLockError";
  wrapped.code = code;
  wrapped.cause = error;
  return wrapped;
}

export function getPremiereCepLockPath(bridgeDirectory) {
  if (!bridgeDirectory || typeof bridgeDirectory !== "string") {
    throw new TypeError("bridgeDirectory must be a non-empty string.");
  }
  return path.join(path.resolve(bridgeDirectory), PREMIERE_CEP_LOCK_FILENAME);
}

export function isProcessAlive(pid) {
  const normalizedPid = positiveInteger(pid);
  if (!normalizedPid) {
    return false;
  }

  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this process cannot signal it.
    return error?.code === "EPERM";
  }
}

export async function inspectPremiereCepLock({
  bridgeDirectory,
  lockPath = bridgeDirectory
    ? getPremiereCepLockPath(bridgeDirectory)
    : undefined,
} = {}) {
  if (!lockPath) {
    throw new TypeError("bridgeDirectory or lockPath is required.");
  }

  const resolvedLockPath = path.resolve(lockPath);
  let raw;
  try {
    raw = await readFile(resolvedLockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        lockPath: resolvedLockPath,
        exists: false,
        status: "unlocked",
        owner: null,
        ownerAlive: false,
      };
    }
    return {
      lockPath: resolvedLockPath,
      exists: true,
      status: "unreadable",
      owner: null,
      ownerAlive: null,
      error: error?.message || String(error),
    };
  }

  let owner;
  try {
    owner = JSON.parse(raw);
  } catch (error) {
    return {
      lockPath: resolvedLockPath,
      exists: true,
      status: "invalid",
      owner: null,
      ownerAlive: null,
      error: `Invalid lock JSON: ${error.message}`,
    };
  }

  const pid = positiveInteger(owner?.pid);
  if (!owner || typeof owner !== "object" || !pid || !owner.token) {
    return {
      lockPath: resolvedLockPath,
      exists: true,
      status: "invalid",
      owner,
      ownerAlive: null,
      error: "Lock metadata must include a positive pid and owner token.",
    };
  }

  const ownerAlive = isProcessAlive(pid);
  return {
    lockPath: resolvedLockPath,
    exists: true,
    status: ownerAlive ? "live" : "stale",
    owner,
    ownerAlive,
  };
}

async function removeDeadStaleLock(lockPath, expectedOwner) {
  const latest = await inspectPremiereCepLock({ lockPath });
  if (
    latest.status !== "stale" ||
    !ownerMatches(latest.owner, expectedOwner) ||
    isProcessAlive(latest.owner.pid)
  ) {
    return false;
  }

  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw lockError(
      error,
      `Could not reclaim dead Premiere live lock ${lockPath}`,
      "PREMIERE_CEP_STALE_LOCK_RECLAIM_FAILED",
    );
  }
}

export async function releasePremiereCepLock(lock) {
  if (!lock?.lockPath || !lock?.owner) {
    throw new TypeError("A Premiere live lock handle is required.");
  }

  const inspection = await inspectPremiereCepLock({ lockPath: lock.lockPath });
  if (!inspection.exists) {
    return {
      released: false,
      reason: "missing",
      lockPath: lock.lockPath,
    };
  }

  if (!ownerMatches(inspection.owner, lock.owner)) {
    return {
      released: false,
      reason: "not-owner",
      lockPath: lock.lockPath,
      currentOwner: inspection.owner,
    };
  }

  try {
    await unlink(lock.lockPath);
    return {
      released: true,
      reason: "released",
      lockPath: lock.lockPath,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        released: false,
        reason: "missing",
        lockPath: lock.lockPath,
      };
    }
    throw lockError(
      error,
      `Could not release Premiere live lock ${lock.lockPath}`,
      "PREMIERE_CEP_LOCK_RELEASE_FAILED",
    );
  }
}

export async function acquirePremiereCepLock({
  bridgeDirectory,
  lockPath = bridgeDirectory
    ? getPremiereCepLockPath(bridgeDirectory)
    : undefined,
  tool = "unknown",
  metadata = {},
  pid = process.pid,
  startedAt = new Date().toISOString(),
  maxAttempts = 8,
} = {}) {
  if (!lockPath) {
    throw new TypeError("bridgeDirectory or lockPath is required.");
  }

  const resolvedLockPath = path.resolve(lockPath);
  const ownerPid = positiveInteger(pid);
  if (!ownerPid) {
    throw new TypeError("pid must be a positive integer.");
  }

  await mkdir(path.dirname(resolvedLockPath), { recursive: true });

  const token = randomUUID();
  const owner = {
    version: 1,
    token,
    pid: ownerPid,
    startedAt,
    tool: String(tool || "unknown"),
    host: os.hostname(),
    bridgeDirectory: path.dirname(resolvedLockPath),
    ...metadata,
  };

  // Metadata supplied by callers must not be able to replace ownership fields.
  owner.version = 1;
  owner.token = token;
  owner.pid = ownerPid;
  owner.startedAt = startedAt;
  owner.tool = String(tool || "unknown");
  owner.bridgeDirectory = path.dirname(resolvedLockPath);

  let recoveredStaleOwner = null;
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
    let fileHandle;
    try {
      // wx is the cross-process ownership boundary. Only one process can create
      // this file for the shared Premiere live-lane directory.
      fileHandle = await open(resolvedLockPath, "wx", 0o600);
      await fileHandle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, "utf8");
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = null;

      const lock = {
        lockPath: resolvedLockPath,
        bridgeDirectory: path.dirname(resolvedLockPath),
        owner,
        recoveredStaleOwner,
        released: false,
        async release() {
          if (lock.released) {
            return {
              released: false,
              reason: "already-released",
              lockPath: resolvedLockPath,
            };
          }
          const result = await releasePremiereCepLock(lock);
          if (result.released || result.reason === "missing") {
            lock.released = true;
          }
          return result;
        },
      };
      return lock;
    } catch (error) {
      if (fileHandle) {
        try {
          await fileHandle.close();
        } catch {}
      }

      if (error?.code !== "EEXIST") {
        // A failed partial create belongs to this token, so remove only if the
        // on-disk owner still matches it.
        try {
          await releasePremiereCepLock({ lockPath: resolvedLockPath, owner });
        } catch {}
        throw lockError(
          error,
          `Could not acquire Premiere live lock ${resolvedLockPath}`,
          "PREMIERE_CEP_LOCK_ACQUIRE_FAILED",
        );
      }

      const inspection = await inspectPremiereCepLock({
        lockPath: resolvedLockPath,
      });
      if (inspection.status === "live") {
        throw new PremiereCepLockBusyError(resolvedLockPath, inspection);
      }
      if (inspection.status !== "stale") {
        throw new PremiereCepLockBusyError(resolvedLockPath, inspection);
      }

      const removed = await removeDeadStaleLock(
        resolvedLockPath,
        inspection.owner,
      );
      if (removed) {
        recoveredStaleOwner = inspection.owner;
      } else {
        await delay(Math.min(10 * attempt, 50));
      }
    }
  }

  const inspection = await inspectPremiereCepLock({ lockPath: resolvedLockPath });
  throw new PremiereCepLockBusyError(resolvedLockPath, inspection);
}

export async function waitForProcessExit(
  pid,
  {
    timeoutMs = DEFAULT_EXIT_TIMEOUT_MS,
    pollIntervalMs = PROCESS_POLL_INTERVAL_MS,
  } = {},
) {
  const normalizedPid = positiveInteger(pid);
  if (!normalizedPid) {
    return {
      pid: normalizedPid,
      exited: true,
      elapsedMs: 0,
      checks: 0,
    };
  }

  const started = Date.now();
  let checks = 0;
  while (Date.now() - started <= timeoutMs) {
    checks += 1;
    if (!isProcessAlive(normalizedPid)) {
      return {
        pid: normalizedPid,
        exited: true,
        elapsedMs: Date.now() - started,
        checks,
      };
    }
    await delay(Math.max(10, pollIntervalMs));
  }

  return {
    pid: normalizedPid,
    exited: !isProcessAlive(normalizedPid),
    elapsedMs: Date.now() - started,
    checks,
  };
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        () => ({ settled: true, error: null }),
        (error) => ({
          settled: true,
          error: error?.message || String(error),
        }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ settled: false, error: "timeout" }),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function closeMcpChildAndConfirm({
  client,
  transport,
  childPid,
  closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
  exitTimeoutMs = DEFAULT_EXIT_TIMEOUT_MS,
  terminateIfNeeded = true,
} = {}) {
  const pid = positiveInteger(childPid);
  const result = {
    childPid: pid,
    clientClose: null,
    transportClose: null,
    forcedSignal: null,
    confirmedExited: !pid,
    exitCheck: null,
  };

  if (client && typeof client.close === "function") {
    result.clientClose = await settleWithin(
      Promise.resolve().then(() => client.close()),
      closeTimeoutMs,
    );
  }

  if (
    transport &&
    typeof transport.close === "function" &&
    (!pid || isProcessAlive(pid))
  ) {
    result.transportClose = await settleWithin(
      Promise.resolve().then(() => transport.close()),
      closeTimeoutMs,
    );
  }

  if (!pid) {
    return result;
  }

  result.exitCheck = await waitForProcessExit(pid, {
    timeoutMs: exitTimeoutMs,
  });
  result.confirmedExited = result.exitCheck.exited;

  if (!result.confirmedExited && terminateIfNeeded) {
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      if (!isProcessAlive(pid)) {
        break;
      }
      try {
        process.kill(pid, signal);
        result.forcedSignal = signal;
      } catch (error) {
        if (error?.code !== "ESRCH") {
          result.signalError = error?.message || String(error);
        }
      }
      result.exitCheck = await waitForProcessExit(pid, {
        timeoutMs: Math.min(exitTimeoutMs, 1500),
      });
      result.confirmedExited = result.exitCheck.exited;
      if (result.confirmedExited) {
        break;
      }
    }
  }

  return result;
}

function lifecycleError(message, details, code = "PREMIERE_CEP_LIFECYCLE_FAILED") {
  const error = new Error(message);
  error.name = "PremiereCepLifecycleError";
  error.code = code;
  error.details = details;
  return error;
}

export function createPremiereCepLifecycle({
  lock,
  closeChild = closeMcpChildAndConfirm,
} = {}) {
  if (!lock?.lockPath || typeof lock.release !== "function") {
    throw new TypeError("A Premiere live lock handle is required.");
  }
  if (typeof closeChild !== "function") {
    throw new TypeError("closeChild must be a function.");
  }

  const sessions = new Set();
  const shutdownHistory = [];
  let cleanupStarted = false;
  let cleanupPromise = null;

  function registerSession({ client, transport, label = "premiere-mcp-session" } = {}) {
    if (cleanupStarted) {
      throw lifecycleError(
        "Cannot register a Premiere MCP session after lifecycle cleanup has started.",
        { label },
        "PREMIERE_CEP_LIFECYCLE_CLOSING",
      );
    }
    if (!client || !transport) {
      throw new TypeError("client and transport are required.");
    }
    const session = {
      client,
      transport,
      label,
      childPid: null,
      closePromise: null,
      shutdown: null,
    };
    sessions.add(session);
    return session;
  }

  async function closeSession(session) {
    if (!session || !sessions.has(session)) {
      if (session?.shutdown?.confirmedExited) {
        return session.shutdown;
      }
      throw new TypeError("A registered Premiere MCP session is required.");
    }

    if (!session.closePromise) {
      // Capture the PID before client.close() can clear transport.pid.
      session.childPid = session.childPid || session.transport.pid;
      session.closePromise = (async () => {
        const shutdown = await closeChild({
          client: session.client,
          transport: session.transport,
          childPid: session.childPid,
        });
        session.shutdown = shutdown;
        shutdownHistory.push({ label: session.label, ...shutdown });
        if (!shutdown.confirmedExited) {
          throw lifecycleError(
            `Premiere MCP child PID ${shutdown.childPid || "unknown"} for '${session.label}' did not exit within the bounded shutdown window.`,
            { session: session.label, shutdown },
            "PREMIERE_MCP_CHILD_STILL_RUNNING",
          );
        }
        sessions.delete(session);
        return shutdown;
      })();
    }
    return session.closePromise;
  }

  async function connectSession(session) {
    if (cleanupStarted) {
      throw lifecycleError(
        `Cannot connect Premiere MCP session '${session?.label || "unknown"}' after lifecycle cleanup has started.`,
        { session: session?.label || null },
        "PREMIERE_CEP_LIFECYCLE_CLOSING",
      );
    }
    if (!session || !sessions.has(session)) {
      throw new TypeError("A registered Premiere MCP session is required.");
    }
    try {
      await session.client.connect(session.transport);
      session.childPid = session.transport.pid;
      return session;
    } catch (connectError) {
      session.childPid = session.childPid || session.transport.pid;
      try {
        await closeSession(session);
      } catch (shutdownError) {
        throw new AggregateError(
          [connectError, shutdownError],
          `Premiere MCP session '${session.label}' failed to connect and clean up.`,
          { cause: connectError },
        );
      }
      throw connectError;
    }
  }

  function cleanup() {
    if (!cleanupPromise) {
      cleanupStarted = true;
      cleanupPromise = (async () => {
        const failures = [];
        let lockRelease = null;
        let lockReleaseError = null;

        try {
          for (const session of [...sessions]) {
            try {
              await closeSession(session);
            } catch (error) {
              failures.push({
                session: session.label,
                error: error?.message || String(error),
                code: error?.code || null,
                shutdown: session.shutdown,
              });
            }
          }
        } finally {
          // A failed child shutdown must fail the command, but it must not leave
          // a permanent lock that deadlocks all later recovery attempts.
          try {
            lockRelease = await lock.release();
          } catch (error) {
            lockReleaseError = error;
          }
        }

        if (
          lockReleaseError ||
          (lockRelease &&
            !["released", "already-released", "missing"].includes(
              lockRelease.reason,
            ))
        ) {
          failures.push({
            session: "cep-lock",
            error:
              lockReleaseError?.message ||
              `Premiere live lock release failed with reason '${lockRelease?.reason || "unknown"}'.`,
            code: lockReleaseError?.code || "PREMIERE_CEP_LOCK_RELEASE_FAILED",
            lockRelease,
          });
        }

        const result = {
          lockPath: lock.lockPath,
          lockRelease,
          shutdowns: [...shutdownHistory],
          failures,
        };
        if (failures.length > 0) {
          throw lifecycleError(
            `Premiere lifecycle cleanup failed for ${failures.length} item(s).`,
            result,
            failures.some(
              (failure) => failure.code === "PREMIERE_MCP_CHILD_STILL_RUNNING",
            )
              ? "PREMIERE_MCP_CHILD_STILL_RUNNING"
              : "PREMIERE_CEP_LIFECYCLE_FAILED",
          );
        }
        return result;
      })();
    }
    return cleanupPromise;
  }

  return {
    registerSession,
    connectSession,
    closeSession,
    cleanup,
    get activeSessionCount() {
      return sessions.size;
    },
  };
}

export function installPremiereCepSignalHandlers(
  cleanup,
  { timeoutMs = 8000 } = {},
) {
  if (typeof cleanup !== "function") {
    throw new TypeError("cleanup must be a function.");
  }

  let handlingSignal = false;
  const handlers = new Map();
  const signalExitCodes = new Map([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]);

  for (const [signal, exitCode] of signalExitCodes) {
    const handler = () => {
      if (handlingSignal) {
        return;
      }
      handlingSignal = true;
      const forcedExit = setTimeout(() => process.exit(exitCode), timeoutMs);
      forcedExit.unref?.();
      Promise.resolve(cleanup({ signal }))
        .catch(() => {})
        .finally(() => {
          clearTimeout(forcedExit);
          process.exit(exitCode);
        });
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
}
