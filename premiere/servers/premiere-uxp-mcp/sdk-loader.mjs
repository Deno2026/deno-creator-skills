import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_UPSTREAM_ROOT } from "./paths.mjs";
export { DEFAULT_UPSTREAM_ROOT, resolveMcpRoot, resolveTempDir, DEFAULT_TEMP_DIR } from "./paths.mjs";

export async function loadMcpSdk(upstreamRoot) {
  const root = upstreamRoot || process.env.PREMIERE_MCP_ROOT || DEFAULT_UPSTREAM_ROOT;
  const requireFromUpstream = createRequire(path.join(root, "package.json"));
  const resolveImport = (specifier) =>
    import(pathToFileURL(requireFromUpstream.resolve(specifier)).href);

  const [serverModule, stdioServerModule, typesModule] = await Promise.all([
    resolveImport("@modelcontextprotocol/sdk/server/index.js"),
    resolveImport("@modelcontextprotocol/sdk/server/stdio.js"),
    resolveImport("@modelcontextprotocol/sdk/types.js"),
  ]);

  return {
    Server: serverModule.Server,
    StdioServerTransport: stdioServerModule.StdioServerTransport,
    CallToolRequestSchema: typesModule.CallToolRequestSchema,
    ListToolsRequestSchema: typesModule.ListToolsRequestSchema,
  };
}

export async function loadMcpClientSdk(upstreamRoot) {
  const root = upstreamRoot || process.env.PREMIERE_MCP_ROOT || DEFAULT_UPSTREAM_ROOT;
  const requireFromUpstream = createRequire(path.join(root, "package.json"));
  const resolveImport = (specifier) =>
    import(pathToFileURL(requireFromUpstream.resolve(specifier)).href);
  const [clientModule, stdioModule] = await Promise.all([
    resolveImport("@modelcontextprotocol/sdk/client/index.js"),
    resolveImport("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);

  return {
    Client: clientModule.Client,
    StdioClientTransport: stdioModule.StdioClientTransport,
  };
}
