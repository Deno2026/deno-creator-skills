#!/usr/bin/env node
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BridgeCommandError,
  PremiereUxpBridgeClient,
} from "../premiere-uxp-mcp/bridge-client.mjs";
import { loadCapabilityRegistry } from "../premiere-uxp-mcp/capability-registry.mjs";
import { loadMcpSdk } from "../premiere-uxp-mcp/sdk-loader.mjs";
import { loadToolCatalog } from "../premiere-uxp-mcp/tool-catalog.mjs";
import { PremiereCepClient } from "./cep-client.mjs";
import {
  checkCapabilityPermission,
  resolveCodeRoute,
} from "./route-policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UXP_SERVER_ROOT = path.resolve(HERE, "..", "premiere-uxp-mcp");

function parseArgs(argv) {
  const options = { route: "auto" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--uxp-bridge-dir") {
      options.uxpBridgeDirectory = argv[++index];
      if (!options.uxpBridgeDirectory) {
        throw new Error("--uxp-bridge-dir requires a path.");
      }
    } else if (value === "--cep-temp-dir") {
      options.cepTempDirectory = argv[++index];
      if (!options.cepTempDirectory) {
        throw new Error("--cep-temp-dir requires a path.");
      }
    } else if (value === "--mcp-root") {
      options.mcpRoot = argv[++index];
      if (!options.mcpRoot) {
        throw new Error("--mcp-root requires a path.");
      }
    } else if (value === "--route") {
      options.route = String(argv[++index] || "").toLowerCase();
      if (!["auto", "uxp", "cep"].includes(options.route)) {
        throw new Error("--route must be auto, uxp, or cep.");
      }
    } else if (value === "--allow-write") {
      options.allowWrite = true;
    } else if (value === "--allow-dangerous") {
      options.allowDangerous = true;
    } else if (value === "--allow-experimental") {
      options.allowExperimental = true;
    } else if (value === "--help" || value === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }
  return options;
}

function helpText() {
  return [
    "deno-premiere-control-mcp — code-only UXP/CEP router for Premiere Pro",
    "",
    "Options:",
    "  --route <auto|uxp|cep>       Route override (default: auto)",
    "  --uxp-bridge-dir <path>      Override UXP PluginData/bridge",
    "  --cep-temp-dir <path>        Override CEP bridge temp directory",
    "  --mcp-root <path>            Override premiere-pro-mcp package root",
    "  --allow-write                Permit commands classified as writes",
    "  --allow-dangerous            Permit dangerous commands (also needs --allow-write)",
    "  --allow-experimental         Permit routes without live roundtrip evidence",
    "",
    "Computer Use is intentionally excluded.",
  ].join("\n");
}

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

function jsonResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(message, details = null) {
  return {
    content: [
      {
        type: "text",
        text:
          `Error: ${message}` +
          (details === null ? "" : `\nDetails: ${JSON.stringify(details, null, 2)}`),
      },
    ],
    isError: true,
  };
}

function routeDescription(capability) {
  const preferred = capability.preferredRoute || "none";
  return (
    `[code route: ${preferred}; availability: ${capability.availability}; ` +
    `risk: ${capability.risk}] ${capability.description}`
  );
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(helpText());
  process.exit(0);
}

const [toolCatalog, capabilityRegistry, sdk] = await Promise.all([
  loadToolCatalog(UXP_SERVER_ROOT),
  loadCapabilityRegistry(UXP_SERVER_ROOT),
  loadMcpSdk(),
]);
const allTools = toolCatalog.allTools.map((tool) => {
  if (toolCatalog.serverToolSet.has(tool.name)) {
    return tool;
  }
  const capability = capabilityRegistry.byName.get(tool.name);
  if (!capability) {
    throw new Error(`Missing capability metadata: ${tool.name}`);
  }
  return { ...tool, description: routeDescription(capability) };
});
const allToolSet = new Set(allTools.map((tool) => tool.name));

const uxp = new PremiereUxpBridgeClient({
  directory: options.uxpBridgeDirectory,
});
const cep = new PremiereCepClient({
  mcpRoot: options.mcpRoot,
  tempDirectory: options.cepTempDirectory,
});

const server = new sdk.Server(
  { name: "deno-premiere-control-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({
  tools: allTools,
}));

server.setRequestHandler(sdk.CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};
  if (!allToolSet.has(name)) {
    return errorResult(`Unknown Premiere tool: ${name}`);
  }
  if (!isPlainObject(args)) {
    return errorResult("Tool arguments must be a JSON object.");
  }

  if (toolCatalog.serverToolSet.has(name)) {
    try {
      return jsonResult(capabilityRegistry.execute(name, args));
    } catch (error) {
      return errorResult(String(error && (error.message || error)));
    }
  }

  const capability = capabilityRegistry.byName.get(name);
  const permission = checkCapabilityPermission(capability, options);
  if (!permission.allowed) {
    return errorResult(permission.reason);
  }
  const route = resolveCodeRoute(capability, {
    requestedRoute: options.route,
    allowExperimental: options.allowExperimental,
  });
  if (!route.executable) {
    return errorResult(route.reason, {
      command: name,
      route: route.route,
      status: route.status,
      fallbacks: route.fallbacks,
    });
  }

  try {
    if (route.route === "cep") {
      return await cep.call(name, args);
    }
    const result = await uxp.call(name, args, {
      timeoutMs: name === "ping" ? 5_000 : undefined,
    });
    if (name === "capture_frame") {
      return await captureFrameContent(result, uxp.directory);
    }
    return jsonResult(result);
  } catch (error) {
    if (error instanceof BridgeCommandError) {
      return errorResult(`${error.code}: ${error.message}`, error.details);
    }
    return errorResult(String(error && (error.message || error)));
  }
});

const shutdown = async () => {
  await cep.close();
};
process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

const transport = new sdk.StdioServerTransport();
await server.connect(transport);
console.error(
  `[deno-premiere-control-mcp] Registered ${allTools.length} code-only Premiere tools; ` +
    `route=${options.route}; experimental=${Boolean(options.allowExperimental)}.`,
);
