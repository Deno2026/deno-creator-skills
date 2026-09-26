#!/usr/bin/env node

import {createRequire} from "node:module";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

import {
  buildPremierePlacementInputs,
  writePremierePlacementInputsAtomically,
} from "./lib/premiere-placement-inputs.mjs";
import {
  acquirePremiereCepLock,
  createPremiereCepLifecycle,
  installPremiereCepSignalHandlers,
} from "./lib/premiere-cep-lock.mjs";
import { DEFAULT_MCP_ROOT, DEFAULT_TEMP_DIR } from "../servers/premiere-uxp-mcp/paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const DEFAULT_TIMEOUT_MS = 180_000;

export const PLACEMENT_CAPTURE_TOOL_NAMES = Object.freeze([
  "get_project_info",
  "get_sequence_settings",
  "get_sequence_structure",
]);

export function usage() {
  return [
    "Usage:",
    "  node scripts/capture-premiere-placement-inputs.mjs --out-dir <new-directory>",
    "",
    "Reads the active Premiere project, exact sequence timing, and full sequence",
    "structure twice through the repo UXP bridge. It supports already-cut timelines",
    "with any number of fragments and atomically creates live.json + structure.json.",
    "It never changes the timeline, never binds one media clip, and never saves the project.",
    "The output directory must not already exist.",
  ].join("\n");
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseArgs(argv) {
  const options = {
    outDir: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    mcpRoot: process.env.PREMIERE_MCP_ROOT || DEFAULT_MCP_ROOT,
    tempDir: process.env.PREMIERE_TEMP_DIR || DEFAULT_TEMP_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--out-dir") options.outDir = valueAfter(argv, index++, value);
    else if (value === "--timeout-ms") options.timeoutMs = Number(valueAfter(argv, index++, value));
    else if (value === "--mcp-root") options.mcpRoot = valueAfter(argv, index++, value);
    else if (value === "--temp-dir") options.tempDir = valueAfter(argv, index++, value);
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

async function importMcpClient(mcpRoot) {
  const requireFromMcp = createRequire(path.join(mcpRoot, "package.json"));
  const clientPath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/index.js");
  const stdioPath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/stdio.js");
  const [{Client}, {StdioClientTransport}] = await Promise.all([
    import(pathToFileURL(clientPath).href),
    import(pathToFileURL(stdioPath).href),
  ]);
  return {Client, StdioClientTransport};
}

function payloadFromResult(result, toolName) {
  const text = result?.content?.find((part) => part.type === "text")?.text;
  if (result?.isError === true) {
    throw new Error(`${toolName} failed: ${text || JSON.stringify(result)}`);
  }
  if (text === undefined) return result;
  if (/^(?:Error:|EvalScript Error:)/.test(text) || text.includes("ReferenceError")) {
    throw new Error(`${toolName} failed: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${toolName} returned non-JSON text: ${text}`);
  }
}

async function callJson(client, toolName, args, timeoutMs) {
  if (!PLACEMENT_CAPTURE_TOOL_NAMES.includes(toolName)) {
    throw new Error(`Placement capture refuses non-read-only tool: ${toolName}`);
  }
  const result = await client.callTool(
    {name: toolName, arguments: args},
    undefined,
    {timeout: timeoutMs},
  );
  return payloadFromResult(result, toolName);
}

async function readCapture(client, timeoutMs) {
  const project = await callJson(client, "get_project_info", {}, timeoutMs);
  const settings = await callJson(client, "get_sequence_settings", {}, timeoutMs);
  const structure = await callJson(client, "get_sequence_structure", {}, timeoutMs);
  return {project, settings, structure};
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return null;
  }
  if (!options.outDir) throw new Error("--out-dir <new-directory> is required");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }

  const {Client, StdioClientTransport} = await importMcpClient(options.mcpRoot);
  const uxpServerPath = path.join(REPO_ROOT, "servers", "premiere-uxp-mcp", "index.mjs");
  const client = new Client(
    {name: "deno-premiere-placement-input-capture", version: "1.0.0"},
    {capabilities: {}},
  );
  const transport = new StdioClientTransport({
    command: "node",
    args: [uxpServerPath],
    env: {
      ...process.env,
      PREMIERE_MCP_ROOT: options.mcpRoot,
      PREMIERE_UXP_TIMEOUT_MS: String(options.timeoutMs),
    },
  });
  const lock = await acquirePremiereCepLock({
    bridgeDirectory: options.tempDir,
    tool: "capture-premiere-placement-inputs",
    metadata: {mode: "uxp-read-only-full-structure-double-capture", outDir: path.resolve(options.outDir)},
  });
  const lifecycle = createPremiereCepLifecycle({lock});
  const session = lifecycle.registerSession({
    client,
    transport,
    label: "placement-input-capture-uxp",
  });
  const removeSignalHandlers = installPremiereCepSignalHandlers(() => lifecycle.cleanup());
  let written;
  let bundle;
  let cleanupResult;
  try {
    await lifecycle.connectSession(session);
    const firstCapture = await readCapture(client, options.timeoutMs);
    const secondCapture = await readCapture(client, options.timeoutMs);
    bundle = buildPremierePlacementInputs({firstCapture, secondCapture});
    written = writePremierePlacementInputsAtomically({outDir: options.outDir, bundle});
  } finally {
    try {
      cleanupResult = await lifecycle.cleanup();
    } finally {
      removeSignalHandlers();
    }
  }

  const shutdown = cleanupResult?.shutdowns?.[0];
  if (!shutdown || shutdown.confirmedExited !== true) {
    throw new Error("Premiere UXP placement capture helper shutdown was not confirmed");
  }
  const result = {
    ok: true,
    outDir: written.outDir,
    livePath: written.livePath,
    structurePath: written.structurePath,
    projectName: bundle.live.projectName,
    projectPath: bundle.live.projectPath,
    projectId: bundle.live.projectId,
    sequenceName: bundle.live.sequenceName,
    sequenceId: bundle.live.sequenceId,
    sequenceDurationSeconds: bundle.live.sequenceDurationSeconds,
    sequenceDurationFrames: bundle.live.sequenceDurationFrames,
    fps: bundle.live.fps,
    ticksPerFrame: bundle.live.ticksPerFrame,
    timecodeDisplay: bundle.live.timecodeDisplay,
    videoTrackIndexes: bundle.live.videoTrackIndexes,
    audioTrackIndexes: bundle.live.audioTrackIndexes,
    captureSha256: bundle.captureSha256,
    structureSha256: bundle.structureSha256,
    bundleSha256: bundle.bundleSha256,
    outputFileSha256: {live: written.liveSha256, structure: written.structureFileSha256},
    premiereReadTools: PLACEMENT_CAPTURE_TOOL_NAMES,
    timelineWrites: 0,
    projectSaved: false,
    helperStopped: {childPid: shutdown.childPid, confirmedExited: shutdown.confirmedExited},
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
