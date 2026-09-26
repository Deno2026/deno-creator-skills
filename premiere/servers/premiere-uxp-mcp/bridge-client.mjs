import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const PROTOCOL_VERSION = 1;
const PLUGIN_ID = "com.deno.premiere.uxp";
const BRIDGE_SUBDIRECTORY = "bridge";
const STORAGE_CHANNELS = ["Developer", "External"];
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RUNTIME_MS = 6 * 60 * 60 * 1000;
const STALE_FILE_AGE_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 75;
const RESPONSE_READ_ATTEMPTS = 6;
const KNOWN_FILE_PATTERN = /^(?:(?:req|run|res)_\d{20}_[0-9a-f-]{36}\.json|\.tmp_(?:req|res)_\d{20}_[0-9a-f-]{36}_.+)$/i;

let lastSequence = 0n;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTransientResponseReadError(error) {
  return (
    error instanceof SyntaxError ||
    ["EACCES", "EBUSY", "ENOENT", "EPERM"].includes(String(error?.code || ""))
  );
}

async function readResponseJson(responsePath) {
  let lastError;
  for (let attempt = 1; attempt <= RESPONSE_READ_ATTEMPTS; attempt += 1) {
    try {
      return JSON.parse(await readFile(responsePath, "utf8"));
    } catch (error) {
      lastError = error;
      if (
        !isTransientResponseReadError(error) ||
        attempt === RESPONSE_READ_ATTEMPTS
      ) {
        throw error;
      }
      // UXP replaces running/final response envelopes atomically. On Windows,
      // the final file can still be briefly locked by Premiere or a scanner.
      // Retrying this same response path is safe for write commands because it
      // never creates or re-sends the request.
      await delay(POLL_INTERVAL_MS * attempt);
    }
  }
  throw lastError;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nextSequence() {
  const wallMicros = BigInt(Date.now()) * 1_000_000n;
  const monotonicRemainder = process.hrtime.bigint() % 1_000_000n;
  const candidate = wallMicros + monotonicRemainder;
  lastSequence = candidate > lastSequence ? candidate : lastSequence + 1n;
  return lastSequence.toString().padStart(20, "0");
}

function validateBridgeDirectory(directory) {
  if (typeof directory !== "string" || !directory.trim()) {
    throw new Error("Bridge directory must be a non-empty path.");
  }
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root) {
    throw new Error(
      `Refusing to use a filesystem root as the bridge directory: ${resolved}`,
    );
  }
  return resolved;
}

async function directoryMetadata(directory) {
  try {
    const metadata = await stat(directory);
    return metadata.isDirectory() ? metadata : null;
  } catch {
    return null;
  }
}

function compareStorageCandidates(left, right) {
  if (left.bridgeExists !== right.bridgeExists) {
    return left.bridgeExists ? -1 : 1;
  }
  if (left.activityMtimeMs !== right.activityMtimeMs) {
    return right.activityMtimeMs - left.activityMtimeMs;
  }
  const versionOrder = right.version.localeCompare(left.version, "en", {
    numeric: true,
    sensitivity: "base",
  });
  if (versionOrder !== 0) return versionOrder;
  return STORAGE_CHANNELS.indexOf(left.channel) -
    STORAGE_CHANNELS.indexOf(right.channel);
}

export async function discoverPluginDataBridgeDirectory(options = {}) {
  const appData = options.appData || process.env.APPDATA;
  const pluginId = options.pluginId || PLUGIN_ID;
  if (!appData) {
    throw new Error(
      "APPDATA is not set; pass --bridge-dir or PREMIERE_UXP_BRIDGE_DIR.",
    );
  }

  const storageRoot = path.join(
    appData,
    "Adobe",
    "UXP",
    "PluginsStorage",
    "PPRO",
  );
  let versions;
  try {
    versions = await readdir(storageRoot, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Could not inspect Premiere UXP plugin storage at ${storageRoot}: ${error.message}`,
    );
  }

  const candidates = [];
  for (const versionEntry of versions) {
    if (!versionEntry.isDirectory()) continue;
    for (const channel of STORAGE_CHANNELS) {
      const pluginDataDirectory = path.join(
        storageRoot,
        versionEntry.name,
        channel,
        pluginId,
        "PluginData",
      );
      const pluginDataMetadata = await directoryMetadata(pluginDataDirectory);
      if (!pluginDataMetadata) continue;

      const directory = path.join(pluginDataDirectory, BRIDGE_SUBDIRECTORY);
      const bridgeMetadata = await directoryMetadata(directory);
      candidates.push({
        directory,
        pluginDataDirectory,
        version: versionEntry.name,
        channel,
        bridgeExists: Boolean(bridgeMetadata),
        activityMtimeMs: bridgeMetadata?.mtimeMs ?? pluginDataMetadata.mtimeMs,
      });
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `Could not find ${pluginId} PluginData below ${storageRoot}. ` +
        "Load the UXP plugin once, or pass --bridge-dir / PREMIERE_UXP_BRIDGE_DIR.",
    );
  }

  candidates.sort(compareStorageCandidates);
  const selected = candidates[0];
  return {
    ...selected,
    source: "auto",
    storageRoot,
    candidateCount: candidates.length,
  };
}

export async function resolveBridgeDirectory(options = {}) {
  const explicitDirectory =
    options.directory ||
    process.env.PREMIERE_UXP_BRIDGE_DIR;
  if (explicitDirectory) {
    return {
      directory: validateBridgeDirectory(explicitDirectory),
      source: options.directory
        ? "option"
        : "environment",
      candidateCount: 0,
    };
  }

  const discovered = await discoverPluginDataBridgeDirectory(options);
  return {
    ...discovered,
    directory: validateBridgeDirectory(discovered.directory),
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function removeFileBestEffort(filePath) {
  try {
    await rm(filePath, { force: true });
  } catch {
    // Stale cleanup will retry known bridge files later.
  }
}

export class BridgeCommandError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "BridgeCommandError";
    this.code = code || "BRIDGE_ERROR";
    this.details = details;
  }
}

export class PremiereUxpBridgeClient {
  constructor(options = {}) {
    this.directoryOption = options.directory;
    this.discoveryOptions = {
      appData: options.appData,
      pluginId: options.pluginId,
    };
    this.directory = null;
    this.directoryResolution = null;
    this.timeoutMs = positiveInteger(
      options.timeoutMs || process.env.PREMIERE_UXP_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    );
    this.maxRuntimeMs = positiveInteger(
      options.maxRuntimeMs || process.env.PREMIERE_UXP_MAX_RUNTIME_MS,
      DEFAULT_MAX_RUNTIME_MS,
    );
    this.queue = Promise.resolve();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    this.directoryResolution = await resolveBridgeDirectory({
      ...this.discoveryOptions,
      directory: this.directoryOption,
    });
    this.directory = this.directoryResolution.directory;
    await mkdir(this.directory, { recursive: true });
    await this.cleanupStaleFiles();
    this.initialized = true;
  }

  async cleanupStaleFiles() {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const cutoff = Date.now() - STALE_FILE_AGE_MS;

    for (const entry of entries) {
      if (!entry.isFile() || !KNOWN_FILE_PATTERN.test(entry.name)) continue;
      const filePath = path.join(this.directory, entry.name);
      try {
        const metadata = await stat(filePath);
        if (metadata.mtimeMs < cutoff) await rm(filePath, { force: true });
      } catch {
        // A polling peer may have moved the file between readdir and stat.
      }
    }
  }

  call(command, args = {}, options = {}) {
    const operation = this.queue.then(() =>
      this.executeCall(command, args, options),
    );
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async executeCall(command, args, options) {
    await this.initialize();

    if (!/^[a-z][a-z0-9_]*$/.test(String(command || ""))) {
      throw new BridgeCommandError("INVALID_COMMAND", "Invalid command name.");
    }
    if (!isPlainObject(args)) {
      throw new BridgeCommandError(
        "INVALID_ARGUMENTS",
        "Tool arguments must be a JSON object.",
      );
    }

    const id = randomUUID();
    const sequence = nextSequence();
    const timeoutMs = positiveInteger(options.timeoutMs, this.timeoutMs);
    const maxRuntimeMs = positiveInteger(
      options.maxRuntimeMs,
      this.maxRuntimeMs,
    );
    const createdAt = new Date().toISOString();
    const request = {
      protocolVersion: PROTOCOL_VERSION,
      id,
      sequence,
      status: "pending",
      command,
      args,
      createdAt,
      timeoutMs,
      maxRuntimeMs,
      client: {
        name: "deno-premiere-uxp-mcp",
        version: "0.1.0",
      },
    };

    const requestName = `req_${sequence}_${id}.json`;
    const responseName = `res_${sequence}_${id}.json`;
    const requestPath = path.join(this.directory, requestName);
    const responsePath = path.join(this.directory, responseName);
    const tempPath = path.join(
      this.directory,
      `.tmp_req_${sequence}_${id}_${process.pid}_${randomUUID()}`,
    );

    await writeFile(tempPath, JSON.stringify(request), {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(tempPath, requestPath);

    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    let lastUpdatedAt = "";

    try {
      while (true) {
        if (await exists(responsePath)) {
          let response;
          try {
            response = await readResponseJson(responsePath);
          } catch (error) {
            throw new BridgeCommandError(
              "INVALID_RESPONSE",
              `Could not parse UXP response: ${error.message}`,
            );
          }

          this.validateResponse(response, request);
          if (response.updatedAt !== lastUpdatedAt) {
            lastUpdatedAt = response.updatedAt;
            lastActivityAt = Date.now();
          }

          if (response.status === "done") {
            await removeFileBestEffort(responsePath);
            return response.data;
          }
          if (response.status === "error") {
            await removeFileBestEffort(responsePath);
            throw new BridgeCommandError(
              response.error?.code || "PREMIERE_ERROR",
              response.error?.message || "Premiere UXP command failed.",
              response.error?.details ?? null,
            );
          }
        }

        const now = Date.now();
        if (now - startedAt > maxRuntimeMs) {
          throw new BridgeCommandError(
            "MAX_RUNTIME_EXCEEDED",
            `Command exceeded maximum runtime of ${maxRuntimeMs}ms.`,
          );
        }
        if (now - lastActivityAt > timeoutMs) {
          throw new BridgeCommandError(
            "COMMAND_TIMEOUT",
            `Command timed out after ${timeoutMs}ms without a status update. Is the DENO Premiere UXP panel open?`,
          );
        }

        await delay(POLL_INTERVAL_MS);
      }
    } finally {
      await removeFileBestEffort(requestPath);
    }
  }

  validateResponse(response, request) {
    if (!isPlainObject(response)) {
      throw new BridgeCommandError(
        "INVALID_RESPONSE",
        "UXP response must be a JSON object.",
      );
    }
    if (
      response.protocolVersion !== PROTOCOL_VERSION ||
      response.id !== request.id ||
      response.sequence !== request.sequence ||
      response.command !== request.command
    ) {
      throw new BridgeCommandError(
        "INVALID_RESPONSE",
        "UXP response identity does not match the request.",
      );
    }
    if (!["running", "done", "error"].includes(response.status)) {
      throw new BridgeCommandError(
        "INVALID_RESPONSE",
        `Unknown UXP response status: ${String(response.status)}`,
      );
    }
    if (response.status === "done" && response.ok !== true) {
      throw new BridgeCommandError(
        "INVALID_RESPONSE",
        "A done response must have ok=true.",
      );
    }
    if (response.status === "error" && response.ok !== false) {
      throw new BridgeCommandError(
        "INVALID_RESPONSE",
        "An error response must have ok=false.",
      );
    }
  }
}

export const bridgeDefaults = Object.freeze({
  BRIDGE_SUBDIRECTORY,
  DEFAULT_MAX_RUNTIME_MS,
  DEFAULT_TIMEOUT_MS,
  PLUGIN_ID,
  PROTOCOL_VERSION,
  RESPONSE_READ_ATTEMPTS,
  STALE_FILE_AGE_MS,
});
