import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPremiereCepLock } from "./lib/premiere-cep-lock.mjs";
import { DEFAULT_MCP_ROOT, DEFAULT_TEMP_DIR } from "../servers/premiere-uxp-mcp/paths.mjs";

const PLUGIN_ID = "com.deno.premiere.uxp";
const CEP_PENDING_PATTERN = /^(?:cmd_.+\.jsx|res_.+\.json)$/i;
const UXP_PENDING_PATTERN = /^(?:(?:req|run|res)_.+\.json|\.tmp_.+)$/i;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");

function parseArgs(argv) {
  const userRoot = process.env.USERPROFILE || os.homedir();
  const options = {
    json: false,
    configPath: path.join(userRoot, ".codex", "config.toml"),
    cepTempDir: process.env.PREMIERE_TEMP_DIR || DEFAULT_TEMP_DIR,
    mcpRoot: process.env.PREMIERE_MCP_ROOT || DEFAULT_MCP_ROOT,
    uxpRoot: path.join(
      process.env.APPDATA || path.join(userRoot, "AppData", "Roaming"),
      "Adobe",
      "UXP",
      "PluginsStorage",
      "PPRO",
    ),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") {
      options.json = true;
    } else if (value === "--config") {
      options.configPath = argv[++index];
    } else if (value === "--cep-temp-dir") {
      options.cepTempDir = argv[++index];
    } else if (value === "--mcp-root") {
      options.mcpRoot = argv[++index];
    } else if (value === "--uxp-root") {
      options.uxpRoot = argv[++index];
    } else if (value === "--help" || value === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }

  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/premiere-lifecycle-doctor.mjs [options]",
    "",
    "Read-only lifecycle diagnosis. This command never kills a process or removes a bridge file.",
    "",
    "Options:",
    "  --json                  Print the complete machine-readable report",
    "  --config <path>         Codex global config.toml path",
    "  --cep-temp-dir <path>   CEP bridge directory",
    "  --mcp-root <path>       Installed premiere-pro-mcp package root",
    "  --uxp-root <path>       Adobe PPRO PluginsStorage root",
  ].join("\n");
}

async function inspectGlobalConfig(configPath) {
  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    return {
      path: path.resolve(configPath),
      readable: false,
      error: error?.message || String(error),
      servers: {
        premiere_pro: serverConfigResult(false, null),
        premiere_control: serverConfigResult(false, null),
      },
    };
  }

  const targets = new Map([
    ["mcp_servers.premiere_pro", { present: false, enabled: null }],
    ["mcp_servers.premiere_control", { present: false, enabled: null }],
  ]);
  let currentSection = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const sectionMatch = rawLine.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (targets.has(currentSection)) {
        targets.get(currentSection).present = true;
      }
      continue;
    }

    if (!targets.has(currentSection)) {
      continue;
    }
    const enabledMatch = rawLine.match(/^\s*enabled\s*=\s*(true|false)\b/i);
    if (enabledMatch) {
      targets.get(currentSection).enabled =
        enabledMatch[1].toLowerCase() === "true";
    }
  }

  const premierePro = targets.get("mcp_servers.premiere_pro");
  const premiereControl = targets.get("mcp_servers.premiere_control");
  return {
    path: path.resolve(configPath),
    readable: true,
    error: null,
    servers: {
      premiere_pro: serverConfigResult(
        premierePro.present,
        premierePro.enabled,
      ),
      premiere_control: serverConfigResult(
        premiereControl.present,
        premiereControl.enabled,
      ),
    },
  };
}

function serverConfigResult(present, enabled) {
  return {
    present,
    enabled,
    explicitlyDisabled: present && enabled === false,
    state: !present
      ? "missing"
      : enabled === false
        ? "explicitly-disabled"
        : enabled === true
          ? "enabled"
          : "enabled-not-explicitly-set",
  };
}

function normalizeCommandLine(value) {
  return String(value || "")
    .replaceAll("/", "\\")
    .toLowerCase();
}

function queryWindowsProcesses() {
  if (process.platform !== "win32") {
    return {
      supported: false,
      error: "Exact process diagnosis is implemented for Windows only.",
      processes: [],
    };
  }

  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$items = @(Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine)",
    "$items | ConvertTo-Json -Depth 3 -Compress",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (result.error || result.status !== 0) {
    return {
      supported: true,
      error:
        result.error?.message || result.stderr?.trim() || `PowerShell exited ${result.status}`,
      processes: [],
    };
  }

  let allProcesses;
  try {
    allProcesses = JSON.parse(result.stdout || "[]");
  } catch (error) {
    return {
      supported: true,
      error: `Could not parse PowerShell process JSON: ${error.message}`,
      processes: [],
    };
  }
  if (!Array.isArray(allProcesses)) {
    allProcesses = allProcesses ? [allProcesses] : [];
  }

  return {
    supported: true,
    error: null,
    processes: allProcesses,
  };
}

function relatedProcesses(processQuery, mcpRoot) {
  const markers = [
    {
      role: "cep-mcp-server",
      path: path.join(mcpRoot, "dist", "index.js"),
    },
    {
      role: "premiere-control-server",
      path: path.join(repoRoot, "servers", "premiere-control-mcp", "index.mjs"),
    },
    {
      role: "premiere-uxp-server",
      path: path.join(repoRoot, "servers", "premiere-uxp-mcp", "index.mjs"),
    },
    {
      role: "cep-call-cli",
      path: path.join(repoRoot, "scripts", "premiere-mcp-call.mjs"),
    },
    {
      role: "cep-smoke-cli",
      path: path.join(repoRoot, "scripts", "premiere-mcp-smoke.mjs"),
    },
  ].map((marker) => ({
    ...marker,
    normalizedPath: normalizeCommandLine(marker.path),
  }));

  const matches = [];
  for (const item of processQuery.processes) {
    const name = String(item.Name || "");
    const normalizedLine = normalizeCommandLine(item.CommandLine);
    const normalizedExecutable = normalizeCommandLine(item.ExecutablePath);
    let role = null;
    let matchedPath = null;

    if (
      name.toLowerCase() === "adobe premiere pro.exe" ||
      normalizedExecutable.endsWith("\\adobe premiere pro.exe")
    ) {
      role = "premiere-pro";
    } else {
      const marker = markers.find(({ normalizedPath }) =>
        normalizedLine.includes(normalizedPath),
      );
      if (marker) {
        role = marker.role;
        matchedPath = marker.path;
      }
    }

    if (!role) {
      continue;
    }
    matches.push({
      role,
      pid: Number(item.ProcessId),
      parentPid: Number(item.ParentProcessId),
      name,
      creationDate: item.CreationDate || null,
      executablePath: item.ExecutablePath || null,
      commandLine: item.CommandLine || null,
      matchedPath,
    });
  }

  matches.sort((left, right) => left.pid - right.pid);
  return matches;
}

async function inspectPendingFiles(directory, pattern, kind) {
  const resolvedDirectory = path.resolve(directory);
  let entries;
  try {
    entries = await readdir(resolvedDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        kind,
        directory: resolvedDirectory,
        exists: false,
        error: null,
        pending: [],
      };
    }
    return {
      kind,
      directory: resolvedDirectory,
      exists: true,
      error: error?.message || String(error),
      pending: [],
    };
  }

  const pending = [];
  for (const entry of entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) {
      continue;
    }
    const filePath = path.join(resolvedDirectory, entry.name);
    try {
      const details = await stat(filePath);
      pending.push({
        name: entry.name,
        path: filePath,
        size: details.size,
        modifiedAt: details.mtime.toISOString(),
        ageSeconds: Math.max(0, (Date.now() - details.mtimeMs) / 1000),
      });
    } catch (error) {
      pending.push({
        name: entry.name,
        path: filePath,
        error: error?.message || String(error),
      });
    }
  }
  pending.sort((left, right) => left.name.localeCompare(right.name));
  return {
    kind,
    directory: resolvedDirectory,
    exists: true,
    error: null,
    pending,
  };
}

async function findUxpBridgeDirectories(uxpRoot) {
  const candidates = new Set();
  if (process.env.PREMIERE_UXP_BRIDGE_DIR) {
    candidates.add(path.resolve(process.env.PREMIERE_UXP_BRIDGE_DIR));
  }

  let versions = [];
  try {
    versions = (await readdir(uxpRoot, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory(),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return {
        root: path.resolve(uxpRoot),
        error: error?.message || String(error),
        directories: [...candidates],
      };
    }
  }

  for (const version of versions) {
    for (const channel of ["Developer", "External"]) {
      candidates.add(
        path.join(
          uxpRoot,
          version.name,
          channel,
          PLUGIN_ID,
          "PluginData",
          "bridge",
        ),
      );
    }
  }
  return {
    root: path.resolve(uxpRoot),
    error: null,
    directories: [...candidates],
  };
}

function printHuman(report) {
  const line = (label, value) => console.log(`${label}: ${value}`);
  console.log("Premiere lifecycle doctor (read-only)");
  line("State", report.summary.state);
  line("Global config", report.globalConfig.path);
  for (const [name, server] of Object.entries(report.globalConfig.servers)) {
    line(`  ${name}`, server.state);
  }

  line("Premiere Pro processes", report.summary.premiereProcessCount);
  line("Premiere helper/server processes", report.summary.helperProcessCount);
  for (const item of report.processes.related) {
    console.log(`  PID ${item.pid} ${item.role} (${item.name})`);
  }
  if (report.processes.error) {
    line("Process query error", report.processes.error);
  }

  line("CEP pending bridge files", report.summary.cepPendingCount);
  line("UXP pending bridge files", report.summary.uxpPendingCount);
  line(
    "Premiere live lock",
    report.cep.lock.status === "live"
      ? `live owner PID ${report.cep.lock.owner?.pid || "unknown"} (${report.cep.lock.owner?.tool || "unknown"})`
      : report.cep.lock.status,
  );
  if (report.summary.issues.length > 0) {
    console.log("Issues:");
    for (const issue of report.summary.issues) {
      console.log(`  - ${issue}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const globalConfig = await inspectGlobalConfig(options.configPath);
  const processQuery = queryWindowsProcesses();
  const related = relatedProcesses(processQuery, options.mcpRoot);
  const cepPending = await inspectPendingFiles(
    options.cepTempDir,
    CEP_PENDING_PATTERN,
    "cep",
  );
  const lock = await inspectPremiereCepLock({
    bridgeDirectory: options.cepTempDir,
  });
  const uxpDiscovery = await findUxpBridgeDirectories(options.uxpRoot);
  const uxpBridges = await Promise.all(
    uxpDiscovery.directories.map((directory) =>
      inspectPendingFiles(directory, UXP_PENDING_PATTERN, "uxp"),
    ),
  );

  const helperProcesses = related.filter((item) => item.role !== "premiere-pro");
  const premiereProcesses = related.filter(
    (item) => item.role === "premiere-pro",
  );
  const uxpPendingCount = uxpBridges.reduce(
    (sum, bridge) => sum + bridge.pending.length,
    0,
  );
  const issues = [];
  for (const [name, server] of Object.entries(globalConfig.servers)) {
    if (!server.explicitlyDisabled) {
      issues.push(
        `Global MCP '${name}' is ${server.state}, not explicitly disabled.`,
      );
    }
  }
  if (processQuery.error) {
    issues.push(`Exact process query failed: ${processQuery.error}`);
  }
  if (helperProcesses.length > 0) {
    issues.push(
      `${helperProcesses.length} Premiere helper/server process(es) are running.`,
    );
  }
  if (cepPending.pending.length > 0) {
    issues.push(`${cepPending.pending.length} CEP bridge file(s) are pending.`);
  }
  if (uxpPendingCount > 0) {
    issues.push(`${uxpPendingCount} UXP bridge file(s) are pending.`);
  }
  if (lock.status !== "unlocked") {
    issues.push(`Premiere live lock state is '${lock.status}'.`);
  }
  if (cepPending.error) {
    issues.push(`CEP bridge inspection failed: ${cepPending.error}`);
  }
  if (uxpDiscovery.error) {
    issues.push(`UXP bridge discovery failed: ${uxpDiscovery.error}`);
  }
  for (const bridge of uxpBridges) {
    if (bridge.error) {
      issues.push(
        `UXP bridge inspection failed for ${bridge.directory}: ${bridge.error}`,
      );
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    globalConfig,
    processes: {
      querySupported: processQuery.supported,
      error: processQuery.error,
      related,
    },
    cep: {
      bridge: cepPending,
      lock,
    },
    uxp: {
      discovery: uxpDiscovery,
      bridges: uxpBridges,
    },
    summary: {
      state: issues.length === 0 ? "clean" : "attention-required",
      ready: issues.length === 0,
      premiereProcessCount: premiereProcesses.length,
      helperProcessCount: helperProcesses.length,
      cepPendingCount: cepPending.pending.length,
      uxpPendingCount,
      issues,
    },
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
  if (!report.summary.ready) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
