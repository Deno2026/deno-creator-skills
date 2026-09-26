import { readFile } from "node:fs/promises";
import path from "node:path";

async function readJson(baseDirectory, relativePath) {
  return JSON.parse(
    await readFile(path.join(baseDirectory, relativePath), "utf8"),
  );
}

function validateCatalog(catalog, label) {
  if (!catalog || !Array.isArray(catalog.tools)) {
    throw new Error(`${label} schema catalog must contain a tools array.`);
  }
  if (catalog.toolCount !== catalog.tools.length) {
    throw new Error(
      `${label} schema catalog count mismatch: ` +
        `${catalog.toolCount} declared, ${catalog.tools.length} present.`,
    );
  }

  for (const tool of catalog.tools) {
    if (!tool || typeof tool.name !== "string" || !tool.name.trim()) {
      throw new Error(`${label} schema catalog contains a tool without a name.`);
    }
    if (typeof tool.description !== "string" || !tool.description.trim()) {
      throw new Error(`${label} tool needs a description: ${tool.name}`);
    }
    const schema = tool.inputSchema;
    if (
      !schema ||
      schema.type !== "object" ||
      !schema.properties ||
      typeof schema.properties !== "object" ||
      Array.isArray(schema.properties)
    ) {
      throw new Error(`${label} tool has an invalid object schema: ${tool.name}`);
    }
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || new Set(schema.required).size !== schema.required.length) {
        throw new Error(`${label} tool has an invalid required list: ${tool.name}`);
      }
      for (const propertyName of schema.required) {
        if (!Object.hasOwn(schema.properties, propertyName)) {
          throw new Error(
            `${label} tool requires an undeclared property '${propertyName}': ${tool.name}`,
          );
        }
      }
    }
  }
}

export async function loadToolCatalog(baseDirectory) {
  const [upstreamCatalog, localCatalog, serverCatalog, enabledConfig] = await Promise.all([
    readJson(baseDirectory, "schemas/upstream-tools.json"),
    readJson(baseDirectory, "schemas/local-tools.json"),
    readJson(baseDirectory, "server-tools.json"),
    readJson(baseDirectory, "enabled-tools.json"),
  ]);
  validateCatalog(upstreamCatalog, "Upstream");
  validateCatalog(localCatalog, "Local");
  validateCatalog(serverCatalog, "Server");

  const catalogByName = new Map();
  const upstreamNames = new Set();
  for (const tool of upstreamCatalog.tools) {
    upstreamNames.add(tool.name);
  }
  for (const tool of [...upstreamCatalog.tools, ...localCatalog.tools]) {
    if (!tool || typeof tool.name !== "string") {
      throw new Error("Schema catalog contains a tool without a valid name.");
    }
    if (catalogByName.has(tool.name)) {
      throw new Error(`Duplicate tool schema: ${tool.name}`);
    }
    catalogByName.set(tool.name, tool);
  }

  const overrides = Array.from(localCatalog.overrides || []);
  const overrideNames = new Set();
  for (const override of overrides) {
    if (!override || typeof override.name !== "string") {
      throw new Error("Local schema override is missing a valid name.");
    }
    if (!upstreamNames.has(override.name)) {
      throw new Error(
        `Local schema override does not target an upstream tool: ${override.name}`,
      );
    }
    if (overrideNames.has(override.name)) {
      throw new Error(`Duplicate local schema override: ${override.name}`);
    }
    if (typeof override.reason !== "string" || !override.reason.trim()) {
      throw new Error(`Local schema override needs a reason: ${override.name}`);
    }
    overrideNames.add(override.name);
    const existing = catalogByName.get(override.name);
    const merged = { ...existing, ...override };
    delete merged.reason;
    catalogByName.set(override.name, merged);
  }

  const bridgeEnabledNames = Array.from(enabledConfig.tools || []);
  const bridgeEnabledSet = new Set(bridgeEnabledNames);
  if (bridgeEnabledSet.size !== bridgeEnabledNames.length) {
    throw new Error("enabled-tools.json contains duplicate tool names.");
  }

  const bridgeEnabledTools = bridgeEnabledNames.map((name) => {
    const tool = catalogByName.get(name);
    if (!tool) {
      throw new Error(`Enabled tool is missing from schema catalogs: ${name}`);
    }
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
  });

  const serverToolSet = new Set();
  const serverTools = serverCatalog.tools.map((tool) => {
    if (
      !tool ||
      typeof tool.name !== "string" ||
      !tool.name ||
      serverToolSet.has(tool.name) ||
      catalogByName.has(tool.name)
    ) {
      throw new Error(`Invalid or duplicate server tool: ${String(tool?.name)}`);
    }
    serverToolSet.add(tool.name);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
  });
  const enabledTools = [...serverTools, ...bridgeEnabledTools];
  const enabledNames = enabledTools.map((tool) => tool.name);
  const enabledSet = new Set(enabledNames);
  const allBridgeCatalogTools = Array.from(catalogByName.values()).map(
    (tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }),
  );
  const allTools = [...serverTools, ...allBridgeCatalogTools];

  return {
    allBridgeCatalogTools,
    allTools,
    bridgeEnabledNames,
    bridgeEnabledSet,
    bridgeEnabledTools,
    enabledNames,
    enabledSet,
    enabledTools,
    serverToolCount: serverCatalog.toolCount,
    serverToolSet,
    serverTools,
    upstreamNames,
    localNames: new Set(localCatalog.tools.map((tool) => tool.name)),
    upstreamToolCount: upstreamCatalog.toolCount,
    localToolCount: localCatalog.toolCount,
    overrideCount: overrides.length,
    bridgeToolCount: upstreamCatalog.toolCount + localCatalog.toolCount,
    totalToolCount:
      upstreamCatalog.toolCount +
      localCatalog.toolCount +
      serverCatalog.toolCount,
  };
}
