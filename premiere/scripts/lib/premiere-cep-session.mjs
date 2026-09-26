import path from "node:path";
import {
  DEFAULT_UPSTREAM_ROOT,
  loadMcpClientSdk,
} from "../../servers/premiere-uxp-mcp/sdk-loader.mjs";
import {
  acquirePremiereCepLock,
  createPremiereCepLifecycle,
  installPremiereCepSignalHandlers,
} from "./premiere-cep-lock.mjs";
import { DEFAULT_TEMP_DIR } from "../../servers/premiere-uxp-mcp/paths.mjs";

function parsePayload(result, tool) {
  const text = result?.content?.find((part) => part.type === "text")?.text;
  if (result?.isError || (typeof text === "string" && /^(?:Error:|EvalScript Error:)/.test(text))) {
    throw new Error(`${tool} failed: ${text || JSON.stringify(result)}`);
  }
  if (text === undefined) return result;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${tool} returned a non-JSON response: ${String(text).slice(0, 2000)}`);
  }
}

/** One lazy CEP connection and one shared Premiere lock for a complete operation. */
export function createPremiereCepSession(options = {}, dependencies = {}) {
  const mcpRoot = options.mcpRoot || process.env.PREMIERE_MCP_ROOT || DEFAULT_UPSTREAM_ROOT;
  const tempDir = options.tempDir || process.env.PREMIERE_TEMP_DIR || DEFAULT_TEMP_DIR;
  const name = options.name || "deno-premiere-operation";
  const timeoutMs = options.timeoutMs || 180_000;
  const loadSdk = dependencies.loadSdk || loadMcpClientSdk;
  const acquireLock = dependencies.acquireLock || acquirePremiereCepLock;
  const installSignals = dependencies.installSignalHandlers || installPremiereCepSignalHandlers;
  let lifecycle = null;
  let client = null;
  let initialization = null;
  let queue = Promise.resolve();
  let closing = false;
  let closePromise = null;
  let cleanupPromise = null;
  let removeSignalHandlers = () => {};

  function cleanup() {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        try {
          return lifecycle ? await lifecycle.cleanup() : null;
        } finally {
          removeSignalHandlers();
        }
      })();
    }
    return cleanupPromise;
  }

  function initialize() {
    if (!initialization) {
      initialization = (async () => {
        const { Client, StdioClientTransport } = await loadSdk(mcpRoot);
        const lock = await acquireLock({
          bridgeDirectory: tempDir,
          tool: options.tool || name,
          metadata: { client: name, transport: "cep", mode: "operation" },
        });
        lifecycle = createPremiereCepLifecycle({ lock, closeChild: dependencies.closeChild });
        try {
          client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
          const transport = new StdioClientTransport({
            command: process.execPath,
            args: [path.join(mcpRoot, "dist", "index.js")],
            env: { ...process.env, PREMIERE_TEMP_DIR: tempDir },
          });
          const session = lifecycle.registerSession({ client, transport, label: name });
          removeSignalHandlers = installSignals(cleanup);
          await lifecycle.connectSession(session);
        } catch (error) {
          await cleanup();
          throw error;
        }
      })();
    }
    return initialization;
  }

  return {
    call(tool, args = {}) {
      if (closing) return Promise.reject(new Error("Premiere operation session is closing."));
      const operation = queue.then(async () => {
        await initialize();
        // One request per call. A failed write is observed by a later read, never resent.
        const result = await client.callTool(
          { name: tool, arguments: args },
          undefined,
          { timeout: timeoutMs },
        );
        return parsePayload(result, tool);
      });
      queue = operation.catch(() => undefined);
      return operation;
    },
    close() {
      closing = true;
      if (!closePromise) closePromise = queue.then(cleanup);
      return closePromise;
    },
  };
}
