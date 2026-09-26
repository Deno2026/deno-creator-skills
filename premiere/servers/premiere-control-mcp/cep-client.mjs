import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_MCP_ROOT, DEFAULT_TEMP_DIR } from "../premiere-uxp-mcp/paths.mjs";

async function importMcpClient(mcpRoot) {
  const requireFromMcp = createRequire(path.join(mcpRoot, "package.json"));
  const clientPath = requireFromMcp.resolve(
    "@modelcontextprotocol/sdk/client/index.js",
  );
  const stdioPath = requireFromMcp.resolve(
    "@modelcontextprotocol/sdk/client/stdio.js",
  );
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(clientPath).href),
    import(pathToFileURL(stdioPath).href),
  ]);
  return { Client, StdioClientTransport };
}

async function closeWithTimeout(client, transport) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, 1_500); });
  try {
    try { await Promise.race([client?.close(), timeout]); } catch {}
    try { await Promise.race([transport?.close(), timeout]); } catch {}
  } finally {
    clearTimeout(timer);
  }
}

export class PremiereCepClient {
  constructor(options = {}) {
    this.mcpRoot =
      options.mcpRoot || process.env.PREMIERE_MCP_ROOT || DEFAULT_MCP_ROOT;
    this.tempDirectory =
      options.tempDirectory ||
      process.env.PREMIERE_TEMP_DIR ||
      DEFAULT_TEMP_DIR;
    this.client = null;
    this.transport = null;
    this.initializing = null;
    this.queue = Promise.resolve();
  }

  async initialize() {
    if (this.client) {
      return;
    }
    if (this.initializing) {
      await this.initializing;
      return;
    }
    this.initializing = this.initializeOnce();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async initializeOnce() {
    const { Client, StdioClientTransport } = await importMcpClient(this.mcpRoot);
    const serverPath = path.join(this.mcpRoot, "dist", "index.js");
    const client = new Client(
      { name: "deno-premiere-control-cep-client", version: "0.1.0" },
      { capabilities: {} },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env: {
        ...process.env,
        PREMIERE_TEMP_DIR: this.tempDirectory,
      },
    });
    try {
      await client.connect(transport);
    } catch (error) {
      await closeWithTimeout(client, transport);
      throw error;
    }
    this.client = client;
    this.transport = transport;
  }

  call(name, args = {}) {
    const operation = this.queue.then(async () => {
      await this.initialize();
      return this.client.callTool({ name, arguments: args });
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async close() {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    await closeWithTimeout(client, transport);
  }
}

export const cepDefaults = Object.freeze({
  DEFAULT_MCP_ROOT,
  DEFAULT_TEMP_DIR,
});
