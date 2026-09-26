#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadMcpClientSdk } from "../premiere-uxp-mcp/sdk-loader.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const positional = [];
  const serverArgs = [path.join(HERE, "index.mjs")];
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (
      [
        "--uxp-bridge-dir",
        "--cep-temp-dir",
        "--mcp-root",
        "--route",
      ].includes(value)
    ) {
      const argument = argv[++index];
      if (!argument) {
        throw new Error(`${value} requires a value.`);
      }
      serverArgs.push(value, argument);
    } else if (
      ["--allow-write", "--allow-dangerous", "--allow-experimental"].includes(
        value,
      )
    ) {
      serverArgs.push(value);
    } else if (value === "--help" || value === "-h") {
      help = true;
    } else {
      positional.push(value);
    }
  }
  return { help, positional, serverArgs };
}

function usage() {
  return [
    "Usage: node call-tool.mjs <tool_name> [json_args] [server options]",
    "",
    "Examples:",
    "  node call-tool.mjs get_premiere_capabilities",
    "  node call-tool.mjs resolve_premiere_tool '{\"tool_name\":\"auto_reframe_sequence\"}'",
    "  node call-tool.mjs ping",
    "  node call-tool.mjs get_project_info '{}' --route cep --allow-experimental",
  ].join("\n");
}

async function closeWithTimeout(client, transport) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, 1_500); });
  try {
    try { await Promise.race([client.close(), timeout]); } catch {}
    try { await Promise.race([transport.close(), timeout]); } catch {}
  } finally {
    clearTimeout(timer);
  }
}

const { help, positional, serverArgs } = parseArgs(process.argv.slice(2));
if (help || positional.length === 0) {
  console.log(usage());
  process.exit(help ? 0 : 1);
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

const { Client, StdioClientTransport } = await loadMcpClientSdk();
const client = new Client(
  { name: "deno-premiere-control-call", version: "0.1.0" },
  { capabilities: {} },
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: serverArgs,
  env: process.env,
});

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: positional[0],
    arguments: toolArgs,
  });
  const text = result.content?.find((part) => part.type === "text")?.text;
  console.log(text === undefined ? JSON.stringify(result, null, 2) : text);
  if (result.isError) {
    process.exitCode = 1;
  }
} finally {
  await closeWithTimeout(client, transport);
}
