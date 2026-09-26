#!/usr/bin/env node
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  acquirePremiereCepLock,
  closeMcpChildAndConfirm,
  installPremiereCepSignalHandlers,
} from "../../scripts/lib/premiere-cep-lock.mjs";
import { loadMcpClientSdk } from "./sdk-loader.mjs";
import {
  blockedDangerousMessage,
  blockedWriteMessage,
  isDangerousTool,
  isWriteTool,
} from "./write-policy.mjs";
import { DEFAULT_TEMP_DIR as DEFAULT_PREMIERE_TEMP_DIR } from "./paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--timeout-ms") {
      options.timeoutMs = argv[++index];
      if (!options.timeoutMs) throw new Error("--timeout-ms requires a value.");
    } else if (value === "--bridge-dir" || value === "--temp-dir") {
      options.bridgeDir = argv[++index];
      if (!options.bridgeDir) throw new Error(`${value} requires a path.`);
    } else if (value === "--output-image") {
      options.outputImage = argv[++index];
      if (!options.outputImage) throw new Error("--output-image requires a path.");
    } else if (value === "--output-json") {
      options.outputJson = argv[++index];
      if (!options.outputJson) throw new Error("--output-json requires a path.");
    } else if (value === "--allow-write") {
      options.allowWrite = true;
    } else if (value === "--allow-dangerous") {
      options.allowDangerous = true;
    } else if (value === "--allow-experimental") {
      options.allowExperimental = true;
    } else if (value === "--help" || value === "-h") options.help = true;
    else positional.push(value);
  }
  return { options, positional };
}

function usage() {
  return [
    "Usage: node call-tool.mjs <tool_name> [json_args]",
    "",
    "Examples:",
    "  node call-tool.mjs ping",
    "  node call-tool.mjs get_premiere_state",
    "  node call-tool.mjs get_sequence_structure '{\"sequence_id\":\"시퀀스 01\"}'",
    "  node call-tool.mjs add_marker '{\"time_seconds\":36}' --allow-write",
    "  node call-tool.mjs save_project '{}' --allow-write --allow-dangerous",
    "  node call-tool.mjs ping --bridge-dir 'C:\\\\path\\\\to\\\\PluginData\\\\bridge'",
    "",
    "Options:",
    "  --allow-write       Permit the declared UXP write tools",
    "  --allow-dangerous   Permit dangerous tools (requires --allow-write)",
    "  --allow-experimental Permit a local-unverified handler for a bounded diagnostic call",
    "  --output-image <path> Save the first image result (for example capture_frame)",
    "  --output-json <path>  Save the complete text/JSON result without stdout truncation",
    "",
    "Environment:",
    "  PREMIERE_TEMP_DIR    Shared CEP/UXP process-lock directory",
    `                       (default: ${DEFAULT_PREMIERE_TEMP_DIR})`,
  ].join("\n");
}

const { options, positional } = parseArgs(process.argv.slice(2));
if (options.help || positional.length === 0) {
  console.log(usage());
  process.exit(options.help ? 0 : 1);
}

let toolArgs = {};
if (positional[1]) {
  try {
    toolArgs = JSON.parse(positional[1]);
  } catch (error) {
    console.error(`Invalid JSON args: ${error.message}`);
    process.exit(1);
  }
}

const toolName = positional[0];
if (isDangerousTool(toolName) && !options.allowDangerous) {
  console.error(blockedDangerousMessage(toolName));
  process.exit(3);
}
if (isWriteTool(toolName) && !options.allowWrite) {
  console.error(blockedWriteMessage(toolName));
  process.exit(2);
}

// The UXP request directory is separate from this shared cross-process lock.
// Using the same PREMIERE_TEMP_DIR as CEP prevents either transport from
// starting while the other owns Premiere. A live owner fails immediately.
const lockDirectory =
  process.env.PREMIERE_TEMP_DIR || DEFAULT_PREMIERE_TEMP_DIR;
const lock = await acquirePremiereCepLock({
  bridgeDirectory: lockDirectory,
  tool: toolName,
  metadata: {
    client: "deno-premiere-uxp-call",
    transport: "uxp",
    mode: isDangerousTool(toolName)
      ? "dangerous-write"
      : isWriteTool(toolName)
        ? "write"
        : "read-only",
  },
});

let client = null;
let transport = null;
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
          childPid: childPid || transport?.pid,
        });
      } finally {
        // Release only after the child transport has completed its bounded close.
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
  const { Client, StdioClientTransport } = await loadMcpClientSdk();
  client = new Client(
    { name: "deno-premiere-uxp-call", version: "0.1.0" },
    { capabilities: {} },
  );
  const serverArgs = [path.join(HERE, "index.mjs")];
  if (options.bridgeDir) {
    serverArgs.push("--bridge-dir", path.resolve(options.bridgeDir));
  }
  if (options.allowWrite) serverArgs.push("--allow-write");
  if (options.allowDangerous) serverArgs.push("--allow-dangerous");
  if (options.allowExperimental) serverArgs.push("--allow-experimental");
  transport = new StdioClientTransport({
    command: "node",
    args: serverArgs,
    env: {
      ...process.env,
      ...(options.timeoutMs
        ? { PREMIERE_UXP_TIMEOUT_MS: String(options.timeoutMs) }
        : {}),
    },
  });

  await client.connect(transport);
  childPid = transport.pid;
  // The MCP client applies its own 60s request timeout, which is shorter than
  // anything --timeout-ms can express. Large sequences (400+ clips) blow past it
  // during get_sequence_structure, so forward the same budget to the request.
  const requestTimeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 180_000;
  const result = await client.callTool(
    {
      name: toolName,
      arguments: toolArgs,
    },
    undefined,
    { timeout: requestTimeoutMs },
  );
  const text = result.content?.find((part) => part.type === "text")?.text;
  const image = result.content?.find((part) => part.type === "image");
  if (options.outputImage && image?.data) {
    const outputPath = path.resolve(options.outputImage);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(image.data, "base64"));
    console.error(`[deno-premiere-uxp-call] Saved image: ${outputPath}`);
  }
  const printable = text === undefined ? JSON.stringify(result, null, 2) : text;
  if (options.outputJson) {
    const outputPath = path.resolve(options.outputJson);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${printable.replace(/\s*$/u, "")}\n`, "utf8");
    console.log(JSON.stringify({saved: outputPath, tool: toolName}, null, 2));
  } else {
    console.log(printable);
  }
  if (result.isError || (typeof text === "string" && text.startsWith("Error:"))) {
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
    `Premiere UXP MCP child PID ${shutdown?.childPid || "unknown"} did not exit within the bounded shutdown window.`,
  );
  error.code = "PREMIERE_MCP_CHILD_STILL_RUNNING";
  throw error;
}
