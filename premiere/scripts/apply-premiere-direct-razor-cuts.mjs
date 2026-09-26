import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath, pathToFileURL} from "node:url";

import {
  createDirectRazorExecutionPlan,
  retryDirectRazorReadOnly,
  runDirectRazorExecution,
  validateDirectRazorLivePreflight,
  validateDirectRazorManifest,
} from "./lib/premiere-direct-razor-cuts.mjs";
import {
  DEFAULT_PREMIERE_CUT_BATCH_PAUSE_MS,
  DEFAULT_PREMIERE_CUT_BATCH_SIZE,
  MAX_PREMIERE_CUT_BATCH_SIZE,
} from "./lib/premiere-cut-batches.mjs";
import {
  acquirePremiereCepLock,
  createPremiereCepLifecycle,
  installPremiereCepSignalHandlers,
} from "./lib/premiere-cep-lock.mjs";
import { DEFAULT_MCP_ROOT, DEFAULT_TEMP_DIR } from "../servers/premiere-uxp-mcp/paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const DEFAULT_TIMEOUT_MS = 180_000;

function usage() {
  return [
    "Usage:",
    "  node scripts/apply-premiere-direct-razor-cuts.mjs --cuts <manifest.json> --dry-run",
    "  node scripts/apply-premiere-direct-razor-cuts.mjs --cuts <manifest.json> --allow-write",
    "",
    "Applies frame-aligned cuts by Razor-splitting the exact V/A fragments,",
    "selecting exactly those two fragments, and using UXP ripple removal.",
    "Cuts run serially from back to front. The project is not saved.",
    "",
    "Options:",
    `  --batch-size <1-${MAX_PREMIERE_CUT_BATCH_SIZE}>  default ${DEFAULT_PREMIERE_CUT_BATCH_SIZE}`,
    `  --batch-pause-ms <ms>  default ${DEFAULT_PREMIERE_CUT_BATCH_PAUSE_MS}; use only for observed host backpressure`,
    `  --timeout-ms <ms>      default ${DEFAULT_TIMEOUT_MS}`,
    "  --dry-run              validate and print the plan without connecting to Premiere",
    "  --resume-selected-first  first cut is already Razor-split and exactly selected; verify then remove without re-Razor",
    "  --allow-write           acknowledge the user's requested timeline edit",
    "  --allow-dangerous       deprecated alias for --allow-write",
  ].join("\n");
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = {
    cuts: "",
    dryRun: false,
    allowWrite: false,
    resumeSelectedFirst: false,
    batchSize: DEFAULT_PREMIERE_CUT_BATCH_SIZE,
    batchPauseMs: DEFAULT_PREMIERE_CUT_BATCH_PAUSE_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    mcpRoot: process.env.PREMIERE_MCP_ROOT || DEFAULT_MCP_ROOT,
    tempDir: process.env.PREMIERE_TEMP_DIR || DEFAULT_TEMP_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--cuts") options.cuts = requireValue(argv, index++, value);
    else if (value === "--batch-size") options.batchSize = Number(requireValue(argv, index++, value));
    else if (value === "--batch-pause-ms") options.batchPauseMs = Number(requireValue(argv, index++, value));
    else if (value === "--timeout-ms") options.timeoutMs = Number(requireValue(argv, index++, value));
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--resume-selected-first") options.resumeSelectedFirst = true;
    else if (value === "--allow-write" || value === "--allow-dangerous") options.allowWrite = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function readManifest(filePath) {
  let source;
  try {
    source = fs.readFileSync(path.resolve(filePath), "utf8");
  } catch (error) {
    throw new Error(`Could not read --cuts manifest: ${error.message}`, {cause: error});
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Could not parse --cuts manifest JSON: ${error.message}`, {cause: error});
  }
}

async function importMcpClient(mcpRoot) {
  const requireFromMcp = createRequire(path.join(mcpRoot, "package.json"));
  const clientPath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/index.js");
  const stdioPath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/stdio.js");
  const [{Client}, {StdioClientTransport}] = await Promise.all([
    import(pathToFileURL(clientPath).href),
    import(pathToFileURL(stdioPath).href),
  ]);
  return {Client, StdioClientTransport};
}

function payloadFromResult(result, toolName) {
  const text = result?.content?.find((part) => part.type === "text")?.text;
  if (result?.isError === true) {
    throw new Error(`${toolName} failed: ${text || JSON.stringify(result)}`);
  }
  if (text === undefined) return result;
  if (/^(?:Error:|EvalScript Error:)/.test(text) || text.includes("ReferenceError")) {
    throw new Error(`${toolName} failed: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callJson(client, toolName, args, timeoutMs) {
  const result = await client.callTool(
    {name: toolName, arguments: args},
    undefined,
    {timeout: timeoutMs},
  );
  return payloadFromResult(result, toolName);
}

async function readSequenceStructure(client, timeoutMs) {
  return retryDirectRazorReadOnly({
    read: async () => requireObject(
      await callJson(client, "get_sequence_structure", {}, timeoutMs),
      "get_sequence_structure",
    ),
  });
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid payload: ${JSON.stringify(value)}`);
  }
  return value;
}

function validateLiveIdentity(project, settings, structure, contract) {
  requireObject(project, "get_project_info");
  requireObject(settings, "get_sequence_settings");
  if (project.name !== contract.projectName) {
    throw new Error(`Active project changed: '${project.name}' != '${contract.projectName}'`);
  }
  if (project.activeSequence?.name !== contract.sequenceName) {
    throw new Error("Active sequence name does not match the manifest");
  }
  if (contract.sequenceId) {
    const ids = [project.activeSequence?.id, settings.id, structure.id]
      .filter((value) => value !== undefined && value !== null && value !== "")
      .map(String);
    if (ids.some((value) => value !== contract.sequenceId)) {
      throw new Error("Active sequence ID does not match the manifest");
    }
  }
  if (settings.name !== contract.sequenceName) {
    throw new Error("UXP sequence settings refer to a different sequence");
  }
  const liveFps = Number(settings.frameRate);
  if (!Number.isFinite(liveFps) || Math.abs(liveFps - contract.timing.fps) > 0.001) {
    throw new Error(`Live frame rate ${settings.frameRate} does not match manifest ${contract.timing.fps}`);
  }
  if (contract.timing.ticksPerFrame !== null) {
    const liveTicks = Number(settings.ticksPerFrame);
    if (!Number.isFinite(liveTicks) || BigInt(Math.round(liveTicks)).toString() !== contract.timing.ticksPerFrame) {
      throw new Error("Live ticksPerFrame does not match the manifest");
    }
  }
  return validateDirectRazorLivePreflight(structure, contract);
}

function compactExecutionResult(result, plan) {
  return {
    ok: result.ok,
    outcome: result.outcome,
    projectName: plan.projectName,
    sequenceName: plan.sequenceName,
    sequenceId: plan.sequenceId,
    targetTracks: plan.targetTracks,
    targetClipNames: plan.targetClipNames,
    cutCount: plan.cutCount,
    batchCount: plan.batchCount,
    completedCutCount: result.completedCutCount,
    completedBatchCount: result.completedBatchCount,
    writeAttemptCount: result.writeAttemptCount,
    confirmedRemovalCount: result.confirmedRemovalCount,
    writeResent: false,
    expectedDurationAfterFrames: plan.expectedDurationAfterFrames,
    expectedDurationAfterSeconds: plan.expectedDurationAfterSeconds,
    batches: result.batchResults?.map((batch) => ({
      batchNumber: batch.batchNumber,
      cutIndexes: batch.cuts.map((cut) => cut.index),
      verified: batch.verification?.ok === true,
    })) ?? [],
    stop: result.stop,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.cuts) throw new Error("--cuts <manifest.json> is required");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  if (!options.dryRun && !options.allowWrite) {
    throw new Error("Refusing to edit the timeline without --allow-write");
  }

  const manifestPath = path.resolve(options.cuts);
  const contract = validateDirectRazorManifest(readManifest(manifestPath));
  const plan = createDirectRazorExecutionPlan(contract, {
    dryRun: options.dryRun,
    resumeSelectedFirst: options.resumeSelectedFirst,
    batchSize: options.batchSize,
    batchPauseMs: options.batchPauseMs,
  });

  // This return is intentionally before SDK import, lock acquisition, transport
  // construction, or any Premiere read. Dry-run is an entirely offline gate.
  if (options.dryRun) {
    const result = await runDirectRazorExecution({contract, plan});
    console.log(JSON.stringify({
      ok: result.ok,
      outcome: result.outcome,
      manifestPath,
      mode: contract.mode,
      writeReady: contract.writeReady,
      waveformSnapVerified: contract.waveformSnapVerified,
      projectName: plan.projectName,
      sequenceName: plan.sequenceName,
      sequenceId: plan.sequenceId,
      targetTracks: plan.targetTracks,
      targetClipNames: plan.targetClipNames,
      cutCount: plan.cutCount,
      batchSize: plan.batchSize,
      batchPauseMs: plan.batchPauseMs,
      resumeSelectedFirst: plan.resumeSelectedFirst,
      batchCount: plan.batchCount,
      expectedDurationAfterFrames: plan.expectedDurationAfterFrames,
      executionOrder: plan.executionCuts.map((cut) => ({
        index: cut.index,
        startFrame: cut.startFrame,
        endFrame: cut.endFrame,
      })),
      batches: plan.batches.map((batch) => ({
        batchNumber: batch.batchNumber,
        cutIndexes: batch.cuts.map((cut) => cut.index),
      })),
      premiereConnected: false,
      writeAttemptCount: 0,
    }, null, 2));
    return;
  }

  const {Client, StdioClientTransport} = await importMcpClient(options.mcpRoot);
  const cepServerPath = path.join(options.mcpRoot, "dist", "index.js");
  const uxpServerPath = path.join(REPO_ROOT, "servers", "premiere-uxp-mcp", "index.mjs");
  const cepClient = new Client(
    {name: "deno-premiere-direct-razor-cep", version: "1.0.0"},
    {capabilities: {}},
  );
  const uxpClient = new Client(
    {name: "deno-premiere-direct-razor-uxp", version: "1.0.0"},
    {capabilities: {}},
  );
  const cepTransport = new StdioClientTransport({
    command: "node",
    args: [cepServerPath],
    env: {...process.env, PREMIERE_TEMP_DIR: options.tempDir},
  });
  const uxpTransport = new StdioClientTransport({
    command: "node",
    args: [uxpServerPath, "--allow-write"],
    env: {
      ...process.env,
      PREMIERE_MCP_ROOT: options.mcpRoot,
      PREMIERE_UXP_TIMEOUT_MS: String(options.timeoutMs),
    },
  });

  const lock = await acquirePremiereCepLock({
    bridgeDirectory: options.tempDir,
    tool: "apply-premiere-direct-razor-cuts",
    metadata: {
      mode: "direct-razor-uxp-ripple",
      batchSize: plan.batchSize,
      batchPauseMs: plan.batchPauseMs,
      resumeSelectedFirst: plan.resumeSelectedFirst,
      manifestPath,
    },
  });
  const lifecycle = createPremiereCepLifecycle({lock});
  const cepSession = lifecycle.registerSession({
    client: cepClient,
    transport: cepTransport,
    label: "direct-razor-cep",
  });
  const uxpSession = lifecycle.registerSession({
    client: uxpClient,
    transport: uxpTransport,
    label: "direct-razor-uxp",
  });
  const removeSignalHandlers = installPremiereCepSignalHandlers(() => lifecycle.cleanup());
  let executionResult;
  let cleanupResult;
  try {
    await lifecycle.connectSession(cepSession);
    await lifecycle.connectSession(uxpSession);

    const project = requireObject(
      await callJson(cepClient, "get_project_info", {}, options.timeoutMs),
      "get_project_info",
    );
    const settings = requireObject(
      await callJson(uxpClient, "get_sequence_settings", {}, options.timeoutMs),
      "get_sequence_settings",
    );
    const initialStructure = await readSequenceStructure(cepClient, options.timeoutMs);
    validateLiveIdentity(project, settings, initialStructure, contract);

    const adapter = {
      async razorAndSelect({script}) {
        return callJson(
          cepClient,
          "execute_extendscript",
          {code: script, timeout_ms: options.timeoutMs},
          options.timeoutMs,
        );
      },
      async readSelectedClips() {
        return retryDirectRazorReadOnly({
          read: async () => {
            const selected = await callJson(uxpClient, "get_selected_clips", {}, options.timeoutMs);
            if (!Array.isArray(selected)) throw new Error("get_selected_clips returned a non-array payload");
            return selected;
          },
        });
      },
      async removeSelectedClips({ripple}) {
        return callJson(
          uxpClient,
          "remove_selected_clips",
          {ripple: ripple === true},
          options.timeoutMs,
        );
      },
      async readStructure() {
        return readSequenceStructure(cepClient, options.timeoutMs);
      },
    };

    executionResult = await runDirectRazorExecution({
      contract,
      plan,
      adapter,
      initialStructure,
      onBatchComplete: async (progress) => {
        process.stderr.write(
          `CUT_BATCH_COMPLETE ${progress.batchNumber}/${progress.batchCount} ` +
            `cuts=${progress.completedCutCount}/${progress.totalCutCount}\n`,
        );
      },
    });
  } finally {
    try {
      cleanupResult = await lifecycle.cleanup();
    } finally {
      removeSignalHandlers();
    }
  }

  const shutdowns = cleanupResult?.shutdowns ?? [];
  if (shutdowns.length !== 2 || shutdowns.some((entry) => entry.confirmedExited !== true)) {
    throw new Error("Premiere helper child shutdown was not confirmed for both transports");
  }
  console.log(JSON.stringify({
    ...compactExecutionResult(executionResult, plan),
    manifestPath,
    helpersStopped: shutdowns.map((entry) => ({
      label: entry.label,
      childPid: entry.childPid,
      confirmedExited: entry.confirmedExited,
    })),
    projectSaved: false,
  }, null, 2));
  if (!executionResult.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
