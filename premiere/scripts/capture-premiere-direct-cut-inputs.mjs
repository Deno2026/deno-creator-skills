import {createRequire} from "node:module";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

import {
  buildPremiereDirectCutInputs,
  selectDirectCutTargetDescriptors,
  writePremiereDirectCutInputsAtomically,
} from "./lib/premiere-direct-cut-inputs.mjs";
import {
  acquirePremiereCepLock,
  createPremiereCepLifecycle,
  installPremiereCepSignalHandlers,
} from "./lib/premiere-cep-lock.mjs";
import { DEFAULT_MCP_ROOT, DEFAULT_TEMP_DIR } from "../servers/premiere-uxp-mcp/paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const DEFAULT_TIMEOUT_MS = 180_000;

export const DIRECT_CUT_CAPTURE_TOOL_NAMES = Object.freeze([
  "get_project_info",
  "get_sequence_settings",
  "get_sequence_structure",
  "get_clip_properties",
]);

export function usage() {
  return [
    "Usage:",
    "  node scripts/capture-premiere-direct-cut-inputs.mjs --target-name <exact displayName> --out-dir <new-directory>",
    "  node scripts/capture-premiere-direct-cut-inputs.mjs --target-name <exact displayName> --timeline-start <seconds> --out-dir <new-directory>",
    "  node scripts/capture-premiere-direct-cut-inputs.mjs --video-track <0-based> --audio-track <0-based> --out-dir <new-directory>",
    "  node scripts/capture-premiere-direct-cut-inputs.mjs --target-name <exact displayName> --video-track <0-based> --audio-track <0-based> --out-dir <new-directory>",
    "",
    "Reads the active Premiere project twice through the repo UXP bridge, binds exactly",
    "one linked V/A target, and atomically creates live.json plus clips.json.",
    "It never changes the timeline and never saves the project.",
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
    targetName: "",
    timelineStartSeconds: null,
    videoTrackIndex: null,
    audioTrackIndex: null,
    outDir: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    mcpRoot: process.env.PREMIERE_MCP_ROOT || DEFAULT_MCP_ROOT,
    tempDir: process.env.PREMIERE_TEMP_DIR || DEFAULT_TEMP_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--target-name") options.targetName = valueAfter(argv, index++, value);
    else if (value === "--timeline-start") options.timelineStartSeconds = Number(valueAfter(argv, index++, value));
    else if (value === "--video-track") options.videoTrackIndex = Number(valueAfter(argv, index++, value));
    else if (value === "--audio-track") options.audioTrackIndex = Number(valueAfter(argv, index++, value));
    else if (value === "--out-dir") options.outDir = valueAfter(argv, index++, value);
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
  if (!DIRECT_CUT_CAPTURE_TOOL_NAMES.includes(toolName)) {
    throw new Error(`Capture refuses non-read-only tool: ${toolName}`);
  }
  const result = await client.callTool(
    {name: toolName, arguments: args},
    undefined,
    {timeout: timeoutMs},
  );
  return payloadFromResult(result, toolName);
}

async function readCapture(client, target, timeoutMs) {
  const project = await callJson(client, "get_project_info", {}, timeoutMs);
  const settings = await callJson(client, "get_sequence_settings", {}, timeoutMs);
  const structure = await callJson(client, "get_sequence_structure", {}, timeoutMs);
  const descriptors = selectDirectCutTargetDescriptors(structure, target);
  const clipProperties = {};
  for (const descriptor of [descriptors.video, descriptors.audio]) {
    clipProperties[descriptor.nodeId] = await callJson(
      client,
      "get_clip_properties",
      {node_id: descriptor.nodeId},
      timeoutMs,
    );
  }
  return {project, settings, structure, clipProperties};
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.outDir) throw new Error("--out-dir <new-directory> is required");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  if (options.timelineStartSeconds !== null && !Number.isFinite(options.timelineStartSeconds)) {
    throw new Error("--timeline-start must be a finite number");
  }
  for (const [flag, value] of [["--video-track", options.videoTrackIndex], ["--audio-track", options.audioTrackIndex]]) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`${flag} must be a non-negative integer`);
    }
  }
  const target = {
    name: options.targetName,
    timelineStartSeconds: options.timelineStartSeconds,
    videoTrackIndex: options.videoTrackIndex,
    audioTrackIndex: options.audioTrackIndex,
  };

  const {Client, StdioClientTransport} = await importMcpClient(options.mcpRoot);
  const uxpServerPath = path.join(REPO_ROOT, "servers", "premiere-uxp-mcp", "index.mjs");
  const client = new Client(
    {name: "deno-premiere-direct-cut-input-capture", version: "1.0.0"},
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
    tool: "capture-premiere-direct-cut-inputs",
    metadata: {mode: "uxp-read-only-double-capture", outDir: path.resolve(options.outDir)},
  });
  const lifecycle = createPremiereCepLifecycle({lock});
  const session = lifecycle.registerSession({
    client,
    transport,
    label: "direct-cut-input-capture-uxp",
  });
  const removeSignalHandlers = installPremiereCepSignalHandlers(() => lifecycle.cleanup());
  let written;
  let bundle;
  let cleanupResult;
  try {
    await lifecycle.connectSession(session);
    const firstCapture = await readCapture(client, target, options.timeoutMs);
    const secondCapture = await readCapture(client, target, options.timeoutMs);
    bundle = buildPremiereDirectCutInputs({firstCapture, secondCapture, target});
    written = writePremiereDirectCutInputsAtomically({outDir: options.outDir, bundle});
  } finally {
    try {
      cleanupResult = await lifecycle.cleanup();
    } finally {
      removeSignalHandlers();
    }
  }

  const shutdown = cleanupResult?.shutdowns?.[0];
  if (!shutdown || shutdown.confirmedExited !== true) {
    throw new Error("Premiere UXP capture helper shutdown was not confirmed");
  }
  console.log(JSON.stringify({
    ok: true,
    outDir: written.outDir,
    livePath: written.livePath,
    clipsPath: written.clipsPath,
    projectName: bundle.live.projectName,
    sequenceName: bundle.live.sequenceName,
    sequenceId: bundle.live.sequenceId,
    fps: bundle.live.fps,
    ticksPerFrame: bundle.live.ticksPerFrame,
    timecodeDisplay: bundle.live.timecodeDisplay,
    targetTracks: bundle.live.targetTracks,
    targetClipNames: bundle.live.targetClipNames,
    captureSha256: bundle.captureSha256,
    targetBindingSha256: bundle.targetBindingSha256,
    bundleSha256: bundle.bundleSha256,
    outputFileSha256: {live: written.liveSha256, clips: written.clipsSha256},
    premiereReadTools: DIRECT_CUT_CAPTURE_TOOL_NAMES,
    timelineWrites: 0,
    projectSaved: false,
    helperStopped: {childPid: shutdown.childPid, confirmedExited: shutdown.confirmedExited},
  }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
