import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MCP_ROOT, DEFAULT_TEMP_DIR } from "../servers/premiere-uxp-mcp/paths.mjs";

const DEFAULT_CEP_DIR = path.join(
  os.homedir(),
  "AppData",
  "Roaming",
  "Adobe",
  "CEP",
  "extensions",
  "MCPBridgeCEP",
);
const DEFAULT_CODEX_CONFIG = path.join(os.homedir(), ".codex", "config.toml");

function parseArgs(argv) {
  const options = {
    mcpRoot: process.env.PREMIERE_MCP_ROOT || DEFAULT_MCP_ROOT,
    tempDir: process.env.PREMIERE_TEMP_DIR || DEFAULT_TEMP_DIR,
    cepDir: DEFAULT_CEP_DIR,
    codexConfig: DEFAULT_CODEX_CONFIG,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--mcp-root") {
      options.mcpRoot = argv[++index];
    } else if (value === "--temp-dir") {
      options.tempDir = argv[++index];
    } else if (value === "--cep-dir") {
      options.cepDir = argv[++index];
    } else if (value === "--codex-config") {
      options.codexConfig = argv[++index];
    } else if (value === "--json") {
      options.json = true;
    } else if (value === "--help" || value === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }

  return options;
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

function checkContains(name, text, needles) {
  const missing = needles.filter((needle) => !text.includes(needle));
  return {
    name,
    ok: missing.length === 0,
    missing,
  };
}

function readTomlSection(text, sectionName) {
  const header = `[${sectionName}]`;
  const start = text.indexOf(header);
  if (start === -1) return "";
  const bodyStart = start + header.length;
  const nextHeader = text.indexOf("\n[", bodyStart);
  return text.slice(start, nextHeader === -1 ? text.length : nextHeader);
}

function statusIcon(ok) {
  return ok ? "[OK]" : "[!!]";
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(
    [
      "Usage:",
      "  node scripts/premiere-mcp-env-check.mjs [--json]",
      "",
      "Checks local Premiere MCP package, CEP bridge files, Codex config, and temp directory.",
    ].join("\n"),
  );
  process.exit(0);
}

const packageJsonPath = path.join(options.mcpRoot, "package.json");
const manifestPath = path.join(options.cepDir, "CSXS", "manifest.xml");
const mainJsPath = path.join(options.cepDir, "main.js");
const csInterfacePath = path.join(options.cepDir, "CSInterface.js");
const transitionsPath = path.join(options.mcpRoot, "dist", "tools", "transitions.js");
const packageManifestPath = path.join(options.mcpRoot, "cep-plugin", "CSXS", "manifest.xml");
const codexConfig = readText(options.codexConfig);
const premiereProConfig = readTomlSection(
  codexConfig,
  "mcp_servers.premiere_pro",
);
const premiereControlConfig = readTomlSection(
  codexConfig,
  "mcp_servers.premiere_control",
);

const packageJson = readText(packageJsonPath);
let parsedPackage = null;
try {
  parsedPackage = packageJson ? JSON.parse(packageJson) : null;
} catch {}

const checks = [
  {
    name: "premiere-pro-mcp package root",
    ok: exists(packageJsonPath),
    details: options.mcpRoot,
  },
  {
    name: "premiere-pro-mcp version",
    ok: parsedPackage?.name === "premiere-pro-mcp" && parsedPackage?.version === "1.1.1",
    details: parsedPackage ? `${parsedPackage.name}@${parsedPackage.version}` : "missing",
  },
  {
    name: "CEP extension installed",
    ok: exists(manifestPath),
    details: options.cepDir,
  },
  checkContains("installed CEP manifest Node flags", readText(manifestPath), [
    "--enable-nodejs",
    "--mixed-context",
    'Host Name="PPRO" Version="[14.0,99.9]"',
  ]),
  checkContains("package CEP manifest Node flags", readText(packageManifestPath), [
    "--enable-nodejs",
    "--mixed-context",
  ]),
  checkContains("CSInterface callback evalScript patch", readText(csInterfacePath), [
    "evalScript(script, callback || function () {})",
  ]),
  checkContains("CEP main.js temp dir patch", readText(mainJsPath), [
    "mcp_bridge_temp_dir_v2",
    "premiere-mcp-bridge",
    "window.cep_node",
  ]),
  checkContains("transition 26.3 patch", readText(transitionsPath), [
    "getVideoTransitionByName(transitionName)",
    "No clip ending at cut point",
    "defaultAddThenAdjustStartEnd",
    "durationMatched",
  ]),
  checkContains("localized effect/property patch", readText(path.join(options.mcpRoot, "dist", "bridge", "script-builder.js")), [
    "__findComponentOnClip",
    "__findPropertyOnComponent",
    "모션",
    "비율 조정",
    "불투명도",
  ]),
  checkContains("capture_frame window fallback patch", readText(path.join(options.mcpRoot, "dist", "tools", "export.js")), [
    "capturePremiereWindowToPng",
    "PrintWindow",
    "Sequence.exportFramePNG is unavailable",
  ]),
  // Codex에 상시 MCP를 등록해 둔 PC에서만 뜻이 있는 검사. 등록이 없으면(키트 기본) 통과 — 평소 운용은 on-demand CLI다.
  {
    name: "Codex premiere_pro registration (optional)",
    ok:
      premiereProConfig.length === 0 ||
      (premiereProConfig.includes("premiere-pro-mcp") && codexConfig.includes("PREMIERE_TEMP_DIR")),
    details: premiereProConfig.length === 0 ? "no standing registration — on-demand CLI only" : options.codexConfig,
  },
  {
    name: "standing premiere_pro MCP disabled",
    ok:
      premiereProConfig.length === 0 ||
      /^enabled\s*=\s*false\s*$/im.test(premiereProConfig),
    details: "Normal operation uses the repo on-demand CLI and exits after each call.",
  },
  {
    name: "standing premiere_control MCP disabled",
    ok:
      premiereControlConfig.length === 0 ||
      /^enabled\s*=\s*false\s*$/im.test(premiereControlConfig),
    details: "Enable only for a bounded debugging session, never as the default.",
  },
  {
    name: "bridge temp directory exists",
    ok: exists(options.tempDir),
    details: options.tempDir,
  },
];

const report = {
  generatedAt: new Date().toISOString(),
  checks,
  ok: checks.every((check) => check.ok),
};

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const check of checks) {
    console.log(`${statusIcon(check.ok)} ${check.name}`);
    if (check.details) {
      console.log(`     ${check.details}`);
    }
    if (check.missing?.length) {
      console.log(`     missing: ${check.missing.join(", ")}`);
    }
  }
}

if (!report.ok) {
  process.exitCode = 1;
}
