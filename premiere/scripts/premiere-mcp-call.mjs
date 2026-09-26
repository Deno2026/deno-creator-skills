import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquirePremiereCepLock,
  closeMcpChildAndConfirm,
  installPremiereCepSignalHandlers,
} from "./lib/premiere-cep-lock.mjs";
import { DEFAULT_MCP_ROOT, DEFAULT_TEMP_DIR } from "../servers/premiere-uxp-mcp/paths.mjs";

export const PREMIERE_MCP_DEFAULT_RETRY_PAUSE_MS = 1_000;
export const PREMIERE_MCP_MIN_RETRY_PAUSE_MS = 250;
export const PREMIERE_MCP_MAX_RETRY_PAUSE_MS = 60_000;

export function parseArgs(argv) {
  const options = {
    mcpRoot: process.env.PREMIERE_MCP_ROOT || DEFAULT_MCP_ROOT,
    tempDir: process.env.PREMIERE_TEMP_DIR || DEFAULT_TEMP_DIR,
    retries: 1,
    retryPauseMs: PREMIERE_MCP_DEFAULT_RETRY_PAUSE_MS,
    allowWrite: false,
    allowDangerous: false,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--mcp-root") {
      options.mcpRoot = argv[++index];
    } else if (value === "--temp-dir") {
      options.tempDir = argv[++index];
    } else if (value === "--save-image") {
      options.saveImage = argv[++index];
    } else if (value === "--retries") {
      const retries = Number(argv[++index]);
      if (!Number.isInteger(retries) || retries < 0) {
        throw new Error("--retries must be a non-negative integer.");
      }
      options.retries = retries;
    } else if (value === "--retry-pause-ms") {
      const retryPauseMs = argv[++index];
      if (retryPauseMs === undefined) {
        throw new Error("--retry-pause-ms requires a value.");
      }
      options.retryPauseMs = resolveRetryPauseMs(retryPauseMs);
    } else if (value === "--allow-write") {
      options.allowWrite = true;
    } else if (value === "--allow-dangerous") {
      options.allowDangerous = true;
      options.allowWrite = true;
    } else if (value === "--help" || value === "-h") {
      options.help = true;
    } else {
      positional.push(value);
    }
  }

  return { options, positional };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/premiere-mcp-call.mjs <tool_name> [json_args]",
    "",
    "Examples:",
    "  node scripts/premiere-mcp-call.mjs ping",
    "  node scripts/premiere-mcp-call.mjs get_premiere_state",
    "  node scripts/premiere-mcp-call.mjs add_marker '{\"time_seconds\":36,\"name\":\"Codex marker\"}' --allow-write",
    "",
    "Options:",
    "  --mcp-root <path>   Local premiere-pro-mcp package root",
    "  --temp-dir <path>   Bridge temp directory",
    "  --retries <n>       Retry timeout responses for read-only tools only (default: 1)",
    "                      Write/dangerous tools always run once (effective retries: 0)",
    "  --retry-pause-ms <n> Wait before each permitted read retry (default: 1000; 250-60000)",
    "  --allow-write       Permit non-read-only tools",
    "  --allow-dangerous   Permit save/delete/export/raw-script style tools",
  ].join("\n");
}

const READ_ONLY_TOOLS = new Set([
  "ping",
  "get_premiere_state",
  "get_timeline_summary",
  "get_sequence_structure",
  "get_full_sequence_info",
  "capture_frame",
  "list_available_transitions",
  "list_available_audio_transitions",
  "list_available_effects",
  "list_available_audio_effects",
  "list_clip_effects",
  "get_clip_info",
  "get_clip_properties",
  "get_effect_properties",
  "get_keyframes",
  "get_markers",
  "get_project_info",
  "get_sequences",
  "get_tracks",
  "get_playhead",
  "get_offline_media",
  "evaluate_expression",
  "inspect_dom_object",
]);

const DANGEROUS_TOOL_PATTERNS = [
  /^save_/,
  /^delete_/,
  /^remove_/,
  /^clear_/,
  /^ripple_/,
  /^batch_/,
  /^export_/,
  /^queue_/,
  /^close_/,
  /^overwrite_/,
  /^execute_extendscript$/,
  /^execute_qe_script$/,
  /^undo$/,
  /^redo$/,
  /consolidate/i,
];

function isDangerousTool(toolName) {
  return DANGEROUS_TOOL_PATTERNS.some((pattern) => pattern.test(toolName));
}

export function classifyToolSafety(toolName) {
  const readOnly = READ_ONLY_TOOLS.has(toolName);
  return {
    readOnly,
    mutation: !readOnly,
    dangerous: isDangerousTool(toolName),
  };
}

export function resolveRetryPolicy(toolName, requestedRetries = 1) {
  if (!Number.isInteger(requestedRetries) || requestedRetries < 0) {
    throw new Error("requestedRetries must be a non-negative integer.");
  }

  const safety = classifyToolSafety(toolName);
  const effectiveRetries = safety.readOnly ? requestedRetries : 0;
  return {
    ...safety,
    requestedRetries,
    effectiveRetries,
    maxAttempts: effectiveRetries + 1,
    retrySuppressed: !safety.readOnly && requestedRetries > 0,
  };
}

export function resolveRetryPauseMs(
  value = PREMIERE_MCP_DEFAULT_RETRY_PAUSE_MS,
) {
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < PREMIERE_MCP_MIN_RETRY_PAUSE_MS ||
    parsed > PREMIERE_MCP_MAX_RETRY_PAUSE_MS
  ) {
    throw new Error(
      `retry pause must be an integer from ${PREMIERE_MCP_MIN_RETRY_PAUSE_MS} to ${PREMIERE_MCP_MAX_RETRY_PAUSE_MS} milliseconds.`,
    );
  }
  return parsed;
}

function waitForRetryPause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function executePremiereMcpCallWithRetry({
  toolName,
  toolArgs = {},
  requestedRetries = 1,
  retryPauseMs = PREMIERE_MCP_DEFAULT_RETRY_PAUSE_MS,
  callTool,
  parseResult = (result) => result,
  isTimeout = isTimeoutPayload,
  wait = waitForRetryPause,
} = {}) {
  if (typeof callTool !== "function") {
    throw new TypeError("callTool must be a function.");
  }
  if (typeof parseResult !== "function") {
    throw new TypeError("parseResult must be a function.");
  }
  if (typeof isTimeout !== "function") {
    throw new TypeError("isTimeout must be a function.");
  }
  if (typeof wait !== "function") {
    throw new TypeError("wait must be a function.");
  }

  const retryPolicy = resolveRetryPolicy(toolName, requestedRetries);
  const resolvedRetryPauseMs = resolveRetryPauseMs(retryPauseMs);
  let payload = null;
  let attemptCount = 0;
  let retryPauseCount = 0;

  while (attemptCount < retryPolicy.maxAttempts) {
    attemptCount += 1;
    const result = await callTool({
      name: toolName,
      arguments: toolArgs,
    });
    payload = parseResult(result);
    if (!isTimeout(payload) || attemptCount >= retryPolicy.maxAttempts) {
      break;
    }
    // Only a classified read can reach this path because mutation tools have
    // maxAttempts=1. Yield resources before every permitted read retry.
    await wait(resolvedRetryPauseMs);
    retryPauseCount += 1;
  }

  return {
    payload,
    attemptCount,
    retryPauseCount,
    retryPauseMs: resolvedRetryPauseMs,
    retryPolicy,
  };
}

async function importMcpClient(mcpRoot) {
  const requireFromMcp = createRequire(path.join(mcpRoot, "package.json"));
  const clientPath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/index.js");
  const stdioPath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/stdio.js");
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(clientPath).href),
    import(pathToFileURL(stdioPath).href),
  ]);
  return { Client, StdioClientTransport };
}

function parseToolPayload(result, saveImagePath) {
  const image = result.content?.find((part) => part.type === "image");
  if (image) {
    const payload = {
      image: true,
      mimeType: image.mimeType,
      dataLength: image.data?.length || 0,
    };
    // capture_frame 등은 이미지를 base64로만 돌려준다. 검수하려면 파일이 필요해서
    // --save-image 를 주면 그 경로로 떨군다.
    if (saveImagePath && image.data) {
      writeFileSync(saveImagePath, Buffer.from(image.data, "base64"));
      payload.savedTo = saveImagePath;
    }
    return payload;
  }

  const text = result.content?.find((part) => part.type === "text")?.text;
  if (text === undefined) {
    return result;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isErrorPayload(payload) {
  return (
    typeof payload === "string" &&
    (payload.startsWith("Error:") ||
      payload.startsWith("EvalScript Error:") ||
      payload.includes("ReferenceError"))
  );
}

function isTimeoutPayload(payload) {
  return typeof payload === "string" && payload.includes("timed out");
}

async function main() {
  const { options, positional } = parseArgs(process.argv.slice(2));
  if (options.help || positional.length === 0) {
    console.log(usage());
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const toolName = positional[0];
  const safety = classifyToolSafety(toolName);
  const retryPolicy = resolveRetryPolicy(toolName, options.retries);
  let toolArgs = {};
  if (positional[1]) {
    try {
      toolArgs = JSON.parse(positional[1]);
    } catch (error) {
      throw new Error(`Invalid JSON args: ${error.message}`);
    }
  }

  if (safety.mutation && !options.allowWrite) {
    const error = new Error(
      `Blocked non-read-only tool '${toolName}'. Re-run with --allow-write only after user approval and project safety confirmation.`,
    );
    error.exitCode = 2;
    throw error;
  }

  if (safety.dangerous && !options.allowDangerous) {
    const error = new Error(
      `Blocked dangerous tool '${toolName}'. Re-run with --allow-dangerous only after explicit user approval.`,
    );
    error.exitCode = 2;
    throw error;
  }

  if (retryPolicy.retrySuppressed) {
    console.error(
      `[premiere-mcp-call] '${toolName}' is not classified read-only; forcing retries from ${retryPolicy.requestedRetries} to 0 so it is never resent after a timeout.`,
    );
  }

  const serverPath = path.join(options.mcpRoot, "dist", "index.js");
  const { Client, StdioClientTransport } = await importMcpClient(options.mcpRoot);
  const client = new Client(
    { name: "premiere-mcp-call", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: {
      ...process.env,
      PREMIERE_TEMP_DIR: options.tempDir,
    },
  });

  const lock = await acquirePremiereCepLock({
    bridgeDirectory: options.tempDir,
    tool: toolName,
    metadata: {
      client: "premiere-mcp-call",
      serverPath,
      mode: options.allowDangerous
        ? "dangerous-write"
        : options.allowWrite
          ? "write"
          : "read-only",
    },
  });

  let childPid = null;
  let cleanupPromise = null;
  const cleanup = () => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        let shutdown;
        try {
          shutdown = await closeMcpChildAndConfirm({
            client,
            transport,
            childPid: childPid || transport.pid,
          });
        } finally {
          await lock.release();
        }
        return shutdown;
      })();
    }
    return cleanupPromise;
  };
  const removeSignalHandlers = installPremiereCepSignalHandlers(cleanup);

  let shutdown;
  try {
    await client.connect(transport);
    childPid = transport.pid;
    const { payload } = await executePremiereMcpCallWithRetry({
      toolName,
      toolArgs,
      requestedRetries: options.retries,
      retryPauseMs: options.retryPauseMs,
      callTool: (request) => client.callTool(request),
      parseResult: (result) => parseToolPayload(result, options.saveImage),
    });

    console.log(JSON.stringify(payload, null, 2));
    if (isErrorPayload(payload)) {
      process.exitCode = 1;
    }
  } finally {
    try {
      shutdown = await cleanup();
    } finally {
      removeSignalHandlers();
    }
  }

  if (!shutdown?.confirmedExited) {
    const error = new Error(
      `Premiere MCP child PID ${shutdown?.childPid || "unknown"} did not exit within the bounded shutdown window.`,
    );
    error.code = "PREMIERE_MCP_CHILD_STILL_RUNNING";
    throw error;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";

if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = error?.exitCode || 1;
  });
}
