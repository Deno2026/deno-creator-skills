#!/usr/bin/env node
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BridgeCommandError,
  PremiereUxpBridgeClient,
} from "./bridge-client.mjs";
import { loadMcpSdk } from "./sdk-loader.mjs";
import { loadToolCatalog } from "./tool-catalog.mjs";
import { loadCapabilityRegistry } from "./capability-registry.mjs";
import {
  blockedDangerousMessage,
  blockedWriteMessage,
  isDangerousTool,
  isWriteTool,
} from "./write-policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--bridge-dir" || value === "--temp-dir") {
      const directory = argv[++index];
      if (!directory) throw new Error(`${value} requires a path.`);
      options.bridgeDirectory = directory;
    } else if (value === "--allow-write") {
      options.allowWrite = true;
    } else if (value === "--allow-dangerous") {
      options.allowDangerous = true;
    } else if (value === "--allow-experimental") {
      options.allowExperimental = true;
    } else if (value !== "--help" && value !== "-h") {
      throw new Error(`Unknown option: ${value}`);
    }
  }
  return options;
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      "deno-premiere-uxp-mcp — native UXP bridge for Premiere Pro",
      "",
      "Options:",
      "  --bridge-dir <path>          Override auto-discovered PluginData/bridge",
      "  --allow-write                Permit the declared UXP write tools",
      "  --allow-dangerous            Permit dangerous tools (requires --allow-write)",
      "  --allow-experimental         Permit local-unverified UXP handlers",
      "",
      "Environment:",
      "  PREMIERE_UXP_BRIDGE_DIR      Override bridge directory",
      "  PREMIERE_UXP_TIMEOUT_MS      Inactivity timeout (default 30000)",
      "  PREMIERE_UXP_MAX_RUNTIME_MS  Hard runtime limit (default 6 hours)",
      "  PREMIERE_MCP_ROOT            Upstream package used for SDK resolution",
    ].join("\n"),
  );
  process.exit(0);
}

const cliOptions = parseArgs(args);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPathInside(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function captureFrameContent(result, bridgeDirectory) {
  if (!isPlainObject(result) || result.temporary !== true) {
    throw new Error("capture_frame did not return a temporary capture descriptor.");
  }
  const capturePath = path.resolve(String(result.capturePath || ""));
  const captureRoot = path.resolve(path.dirname(bridgeDirectory), "captures");
  const basename = path.basename(capturePath);
  if (
    !isPathInside(capturePath, captureRoot) ||
    !/^deno_capture_[0-9]+_[0-9a-f]+\.jpe?g$/i.test(basename)
  ) {
    throw new Error(`Refusing an unsafe capture_frame result path: ${capturePath}`);
  }

  let data;
  try {
    data = await readFile(capturePath);
  } finally {
    await rm(capturePath, { force: true });
  }
  const metadata = { ...result };
  delete metadata.capturePath;
  delete metadata.temporary;
  return {
    content: [
      { type: "text", text: JSON.stringify(metadata, null, 2) },
      {
        type: "image",
        data: data.toString("base64"),
        mimeType: String(result.mimeType || "image/jpeg"),
      },
    ],
  };
}

const [toolCatalog, capabilityRegistry, sdk] = await Promise.all([
  loadToolCatalog(HERE),
  loadCapabilityRegistry(HERE),
  loadMcpSdk(),
]);
const { enabledSet, serverToolSet } = toolCatalog;
const UNAVAILABLE_UXP_STATUSES = new Set([
  "blocked-uxp",
  "deferred",
  "runtime-failed",
]);

function uxpVerificationLabel(capability) {
  const status = capability?.uxp?.status;
  if (status === "ported") return "UXP live-verified";
  if (status === "local-live-verified") return "UXP local live-verified";
  if (status === "live-read-caveat") {
    return "UXP live-read verified; response-parity caveat";
  }
  if (status === "ported-caveat") {
    return "UXP registered port; offline-verified, live-depth caveat";
  }
  if (status === "local-unverified") {
    return "UXP local handler; live roundtrip pending";
  }
  if (status === "diagnostic") return "UXP diagnostic";
  if (UNAVAILABLE_UXP_STATUSES.has(status)) return `UXP unavailable: ${status}`;
  return `UXP verification depth unknown: ${status || "unclassified"}`;
}

function uxpExecutionPolicy(capability) {
  const status = capability?.uxp?.status;
  if (UNAVAILABLE_UXP_STATUSES.has(status)) {
    return { available: false, requiresExperimental: false };
  }
  if (status === "local-unverified") {
    return {
      available: capability?.uxp?.registered === true,
      requiresExperimental: true,
    };
  }
  return {
    available:
      capability?.uxp?.registered === true &&
      [
        "ported",
        "ported-caveat",
        "local-live-verified",
        "live-read-caveat",
        "diagnostic",
      ].includes(status),
    requiresExperimental: false,
  };
}

const enabledTools = toolCatalog.enabledTools.map((tool) => {
  if (serverToolSet.has(tool.name)) {
    return tool;
  }
  const capability = capabilityRegistry.byName.get(tool.name);
  if (!capability) {
    throw new Error(`Enabled Premiere tool lacks capability metadata: ${tool.name}`);
  }
  return {
    ...tool,
    description: `[${uxpVerificationLabel(capability)}] ${tool.description}`,
  };
});

const bridge = new PremiereUxpBridgeClient({
  directory: cliOptions.bridgeDirectory,
});

const server = new sdk.Server(
  { name: "deno-premiere-uxp-mcp", version: "0.6.2" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({
  tools: enabledTools,
}));

server.setRequestHandler(sdk.CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const toolArgs = request.params.arguments || {};

  if (!enabledSet.has(name)) {
    return {
      content: [{ type: "text", text: `Error: Unknown tool: ${name}` }],
      isError: true,
    };
  }
  if (!isPlainObject(toolArgs)) {
    return {
      content: [
        { type: "text", text: "Error: Tool arguments must be a JSON object." },
      ],
      isError: true,
    };
  }
  if (serverToolSet.has(name)) {
    try {
      const result = capabilityRegistry.execute(name, toolArgs);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${String(error && (error.message || error))}`,
          },
        ],
        isError: true,
      };
    }
  }
  const capability = capabilityRegistry.byName.get(name);
  const uxpStatus = capability?.uxp?.status;
  const executionPolicy = uxpExecutionPolicy(capability);
  if (!executionPolicy.available) {
    return {
      content: [
        {
          type: "text",
          text:
            `Error: UXP tool '${name}' is unavailable (${uxpStatus || "unclassified"}). ` +
            "Use resolve_premiere_tool to find an available code route.",
        },
      ],
      isError: true,
    };
  }
  if (executionPolicy.requiresExperimental && !cliOptions.allowExperimental) {
    return {
      content: [
        {
          type: "text",
          text:
            `Error: UXP tool '${name}' is a local handler without a live roundtrip. ` +
            "Use --allow-experimental only when the current requested scope includes bounded verification.",
        },
      ],
      isError: true,
    };
  }
  if (isDangerousTool(name) && !cliOptions.allowDangerous) {
    return {
      content: [
        { type: "text", text: `Error: ${blockedDangerousMessage(name)}` },
      ],
      isError: true,
    };
  }
  if (isWriteTool(name) && !cliOptions.allowWrite) {
    return {
      content: [{ type: "text", text: `Error: ${blockedWriteMessage(name)}` }],
      isError: true,
    };
  }

  try {
    const result = await bridge.call(name, toolArgs, {
      timeoutMs: name === "ping" ? 5_000 : undefined,
    });
    if (name === "capture_frame") {
      return await captureFrameContent(result, bridge.directory);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const isBridgeError = error instanceof BridgeCommandError;
    const details = isBridgeError ? error.details : null;
    const message = isBridgeError
      ? `${error.code}: ${error.message}${
          details === null || details === undefined
            ? ""
            : `\nDetails: ${JSON.stringify(details, null, 2)}`
        }`
      : String(error && (error.message || error));
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

const transport = new sdk.StdioServerTransport();
await server.connect(transport);
console.error(
  `[deno-premiere-uxp-mcp] Registered ${enabledTools.length}/${toolCatalog.totalToolCount} tools ` +
    `(${toolCatalog.upstreamToolCount} upstream + ${toolCatalog.localToolCount} local + ` +
    `${toolCatalog.serverToolCount} server-only)`,
);
console.error("[deno-premiere-uxp-mcp] Bridge discovery is lazy until the first UXP command.");
