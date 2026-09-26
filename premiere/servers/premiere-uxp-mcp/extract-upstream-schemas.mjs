import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_UPSTREAM_ROOT } from "./paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = path.join(HERE, "schemas", "upstream-tools.json");

function parseArgs(argv) {
  const options = {
    sourceRoot: process.env.PREMIERE_MCP_ROOT || DEFAULT_UPSTREAM_ROOT,
    output: DEFAULT_OUTPUT,
    check: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--source-root") options.sourceRoot = argv[++index];
    else if (value === "--out") options.output = path.resolve(argv[++index]);
    else if (value === "--check") options.check = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }

  return options;
}

function usage() {
  return [
    "Usage: node extract-upstream-schemas.mjs [options]",
    "",
    "Options:",
    "  --source-root <path>  premiere-pro-mcp package root",
    "  --out <path>          generated catalog path",
    "  --check               verify the generated catalog is current",
  ].join("\n");
}

function declarationToolNames(source) {
  return Array.from(source.matchAll(/^    ([a-z][a-z0-9_]*): \{$/gm), (match) =>
    match[1],
  );
}

function declarationFactoryName(source, filename) {
  const match = /export declare function (\w+)\(/.exec(source);
  if (!match) throw new Error(`No exported factory in ${filename}`);
  return match[1];
}

function normalizeInputSchema(parameters) {
  if (!parameters || Object.keys(parameters).length === 0) {
    return { type: "object", properties: {} };
  }
  return parameters;
}

async function buildCatalog(sourceRoot) {
  const packageJson = JSON.parse(
    await readFile(path.join(sourceRoot, "package.json"), "utf8"),
  );
  const toolsDirectory = path.join(sourceRoot, "dist", "tools");
  const declarationFiles = (await readdir(toolsDirectory))
    .filter((name) => name.endsWith(".d.ts"))
    .sort((left, right) => left.localeCompare(right));

  const tools = [];
  const seen = new Set();

  for (const declarationFile of declarationFiles) {
    const declarationPath = path.join(toolsDirectory, declarationFile);
    const declarationSource = await readFile(declarationPath, "utf8");
    const factoryName = declarationFactoryName(
      declarationSource,
      declarationFile,
    );
    const declaredNames = declarationToolNames(declarationSource);
    const runtimePath = declarationPath.replace(/\.d\.ts$/, ".js");
    const runtimeModule = await import(pathToFileURL(runtimePath).href);
    const factory = runtimeModule[factoryName];

    if (typeof factory !== "function") {
      throw new Error(`Missing runtime factory ${factoryName} for ${declarationFile}`);
    }

    // The .d.ts files are authoritative for which tools exist. The peer compiled
    // module is used only to materialize description/enum/type literals that the
    // declarations widen to plain `string`.
    const runtimeTools = factory({
      tempDir: path.join(sourceRoot, ".schema-extraction-never-used"),
      timeoutMs: 1,
    });

    for (const name of declaredNames) {
      if (seen.has(name)) throw new Error(`Duplicate declared tool: ${name}`);
      const runtimeTool = runtimeTools[name];
      if (!runtimeTool) {
        throw new Error(`Declared tool missing at runtime: ${name}`);
      }
      seen.add(name);
      tools.push({
        name,
        category: declarationFile.replace(/\.d\.ts$/, ""),
        description: runtimeTool.description,
        inputSchema: normalizeInputSchema(runtimeTool.parameters),
        declaration: `dist/tools/${declarationFile}`,
      });
    }
  }

  return {
    schemaVersion: 1,
    sourcePackage: {
      name: packageJson.name,
      version: packageJson.version,
      declarationGlob: "dist/tools/*.d.ts",
    },
    toolCount: tools.length,
    tools,
  };
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage());
  process.exit(0);
}

const catalog = await buildCatalog(path.resolve(options.sourceRoot));
if (catalog.toolCount < 1) {
  throw new Error("Upstream schema extraction returned no declared tools.");
}

const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
if (options.check) {
  const current = await readFile(options.output, "utf8").catch(() => null);
  if (current !== serialized) {
    console.error(`Schema catalog is stale: ${options.output}`);
    process.exit(1);
  }
  console.log(`Schema catalog current: ${catalog.toolCount} tools`);
} else {
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, serialized, "utf8");
  console.log(`Extracted ${catalog.toolCount} tools to ${options.output}`);
}
