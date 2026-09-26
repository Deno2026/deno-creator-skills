import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquirePremiereCepLock,
  closeMcpChildAndConfirm,
  installPremiereCepSignalHandlers,
} from "./lib/premiere-cep-lock.mjs";
import { DEFAULT_MCP_ROOT, DEFAULT_TEMP_DIR } from "../servers/premiere-uxp-mcp/paths.mjs";

const DEFAULT_OVERLAY =
  "E:\\DENO-Repos\\PremierePro Helper\\renders\\preview-1080p\\attention-pulse-1080p.mov";
const PING_TIMEOUT_MS = 5_000;
const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

function parseArgs(argv) {
  const options = {
    mcpRoot: process.env.PREMIERE_MCP_ROOT || DEFAULT_MCP_ROOT,
    tempDir: process.env.PREMIERE_TEMP_DIR || DEFAULT_TEMP_DIR,
    out: "reports/premiere-mcp-smoke-latest.json",
    writeSmoke: false,
    transitionTest: false,
    overlayTest: false,
    allowWrite: false,
    overlayPath: DEFAULT_OVERLAY,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--mcp-root") {
      options.mcpRoot = argv[++index];
    } else if (value === "--temp-dir") {
      options.tempDir = argv[++index];
    } else if (value === "--out") {
      options.out = argv[++index];
    } else if (value === "--write-smoke") {
      options.writeSmoke = true;
    } else if (value === "--transition-test") {
      options.transitionTest = true;
      options.writeSmoke = true;
    } else if (value === "--overlay-test") {
      options.overlayTest = true;
      options.writeSmoke = true;
    } else if (value === "--allow-write") {
      options.allowWrite = true;
    } else if (value === "--overlay-path") {
      options.overlayPath = argv[++index];
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
    "  node scripts/premiere-mcp-smoke.mjs [options]",
    "",
    "Default mode is read-only: ping, state, timeline summary, structure, transitions, frame capture probe.",
    "",
    "Options:",
    "  --write-smoke       Add a temporary marker and round-trip opacity on a selected/nearby clip",
    "  --transition-test   Also add a transition at the next real cut point",
    "  --overlay-test      Also import and place a Remotion alpha MOV overlay",
    "  --allow-write       Required with any write option",
    "  --overlay-path <p>  Overlay MOV path for --overlay-test",
    "  --out <path>        JSON report path",
    "  --mcp-root <path>   Local premiere-pro-mcp package root",
    "  --temp-dir <path>   Bridge temp directory",
  ].join("\n");
}

async function importMcpClient(mcpRoot) {
  const requireFromMcp = createRequire(path.join(mcpRoot, "package.json"));
  const clientPath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/index.js");
  const stdioPath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/stdio.js");
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(clientPath).href),
    import(pathToFileURL(stdioPath).href),
  ]);
  return { Client, StdioClientTransport };
}

function parseToolPayload(result) {
  const image = result.content?.find((part) => part.type === "image");
  if (image) {
    return {
      image: true,
      mimeType: image.mimeType,
      dataLength: image.data?.length || 0,
    };
  }

  const text = result.content?.find((part) => part.type === "text")?.text;
  if (text === undefined) {
    return result;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isErrorPayload(payload) {
  return (
    typeof payload === "string" &&
    (payload.startsWith("Error:") ||
      payload.startsWith("EvalScript Error:") ||
      payload.includes("ReferenceError"))
  );
}

const noProjectPatterns = [
  /\bNO_PROJECT\b/i,
  /no project is open/i,
  /no active project/i,
  /no project loaded/i,
];

function extractStateText(stateCheck) {
  const candidates = [
    stateCheck?.error,
    typeof stateCheck?.payload === "string" ? stateCheck.payload : undefined,
    stateCheck?.payload?.error,
    stateCheck?.payload?.message,
  ].filter(Boolean);

  return candidates
    .map((value) => (typeof value === "string" ? value : ""))
    .join(" ")
    .trim();
}

function hasNoProjectShape(payload) {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  if (typeof payload.hasActiveProject === "boolean") {
    return payload.hasActiveProject === false;
  }

  const projectName = payload.projectName ?? payload.project_name;
  const projectPath = payload.projectPath ?? payload.project_path;
  const activeSequence =
    payload.activeSequence ??
    payload.activeSequenceName ??
    payload.active_sequence_name ??
    payload.activeSequence?.name ??
    payload?.sequenceName ??
    payload?.sequence?.name ??
    payload?.activeSequencePath;

  const hasRecognizedStateField = [
    "projectName",
    "project_name",
    "projectPath",
    "project_path",
    "activeSequence",
    "activeSequenceName",
    "active_sequence_name",
    "sequenceName",
    "sequence",
    "activeSequencePath",
  ].some((field) => Object.hasOwn(payload, field));
  if (!hasRecognizedStateField) {
    return false;
  }

  const hasMeaningfulValue = (value) => {
    if (typeof value !== "string") {
      return Boolean(value);
    }
    const normalized = value.trim();
    return (
      normalized.length > 0 &&
      !/^(?:none|null|no project open|no active project)$/i.test(normalized)
    );
  };

  const hasOpenProject =
    hasMeaningfulValue(projectName) ||
    hasMeaningfulValue(projectPath) ||
    hasMeaningfulValue(activeSequence);

  return !hasOpenProject;
}

export function detectNoProjectState(stateCheck) {
  const errorText = extractStateText(stateCheck);
  if (errorText && noProjectPatterns.some((pattern) => pattern.test(errorText))) {
    return `No project detected from state error text: ${errorText}`;
  }

  if (stateCheck?.ok && hasNoProjectShape(stateCheck.payload)) {
    return "No active project/sequence is reported by get_premiere_state.";
  }

  return null;
}

function skippedCheck(reason) {
  return {
    skipped: true,
    ok: false,
    reason,
  };
}

function runSelfTest() {
  const checks = [
    {
      label: "NO_PROJECT text",
      input: { ok: false, error: "Error: NO_PROJECT: No project is open in Premiere." },
      expected: true,
    },
    {
      label: "successful no-project shape",
      input: {
        ok: true,
        payload: { projectName: "", activeSequenceName: "" },
      },
      expected: true,
    },
    {
      label: "ping no-project placeholders",
      input: {
        ok: true,
        payload: {
          projectName: "No project open",
          activeSequence: "None",
        },
      },
      expected: true,
    },
    {
      label: "normal project state",
      input: {
        ok: true,
        payload: {
          projectName: "Test Project",
          activeSequenceName: "Seq 01",
        },
      },
      expected: false,
    },
    {
      label: "unrelated state failure",
      input: { ok: false, error: "Transport closed" },
      expected: false,
    },
    {
      label: "successful unknown state shape",
      input: { ok: true, payload: { version: "26.3.2" } },
      expected: false,
    },
  ];

  for (const { label, input, expected } of checks) {
    const noProject = detectNoProjectState(input);
    const ok = Boolean(noProject) === expected;
    if (!ok) {
      throw new Error(`premiere-mcp-smoke self-test failed: ${label}`);
    }
  }

  console.log("premiere-mcp-smoke self-test ok");
}

if (process.env.PREMIERE_MCP_SMOKE_SELF_TEST === "1") {
  runSelfTest();
  process.exit(0);
}

function findCandidateClip(state, structure) {
  const selected = state?.selectedClips?.[0]?.nodeId;
  if (selected) {
    return selected;
  }

  const playhead = Number(state?.playheadSeconds || 0);
  for (const track of structure?.videoTracks || []) {
    for (const clip of track.clips || []) {
      if (clip.startSeconds <= playhead && clip.endSeconds >= playhead) {
        return clip.nodeId;
      }
    }
  }

  return structure?.videoTracks?.[0]?.clips?.[0]?.nodeId || null;
}

function findNextCut(state, structure) {
  const playhead = Number(state?.playheadSeconds || 0);
  const track = structure?.videoTracks?.find((item) => item.index === 0);
  const clips = [...(track?.clips || [])].sort(
    (left, right) => left.startSeconds - right.startSeconds,
  );

  for (let index = 0; index < clips.length - 1; index += 1) {
    const left = clips[index];
    const right = clips[index + 1];
    const hasAdjacentCut = Math.abs(left.endSeconds - right.startSeconds) < 0.05;
    if (hasAdjacentCut && left.endSeconds > playhead + 0.2) {
      return left.endSeconds;
    }
  }

  return null;
}

function hasTrackOverlap(structure, trackIndex, startSeconds, endSeconds) {
  const track = structure?.videoTracks?.find((item) => item.index === trackIndex);
  for (const clip of track?.clips || []) {
    if (clip.startSeconds < endSeconds && clip.endSeconds > startSeconds) {
      return true;
    }
  }
  return false;
}

function transitionDurationMatched(action) {
  const adjusted = action?.payload?.adjustedTransitions;
  if (!action?.ok || !Array.isArray(adjusted) || adjusted.length === 0) {
    return false;
  }
  return adjusted.every((item) => item?.durationMatched === true);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.writeSmoke && !options.allowWrite) {
    throw new Error(
      "Write smoke is blocked. Re-run with --allow-write only for a disposable/copy Premiere project.",
    );
  }

  const serverPath = path.join(options.mcpRoot, "dist", "index.js");
  const report = {
    generatedAt: new Date().toISOString(),
    mode: options.writeSmoke ? "write-smoke" : "read-only",
    mcpRoot: options.mcpRoot,
    tempDir: options.tempDir,
    serverPath,
    checks: {},
    warnings: [],
    failures: [],
    writeActions: [],
  };

  const { Client, StdioClientTransport } = await importMcpClient(options.mcpRoot);
  const client = new Client(
    { name: "premiere-mcp-smoke", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: {
      ...process.env,
      PREMIERE_TEMP_DIR: options.tempDir,
    },
  });
  const lock = await acquirePremiereCepLock({
    bridgeDirectory: options.tempDir,
    tool: "premiere-mcp-smoke",
    metadata: {
      client: "premiere-mcp-smoke",
      serverPath,
      mode: options.writeSmoke ? "write-smoke" : "read-only-smoke",
    },
  });

  let childPid = null;
  let cleanupPromise = null;
  const cleanup = () => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        let shutdown;
        let lockRelease;
        try {
          shutdown = await closeMcpChildAndConfirm({
            client,
            transport,
            childPid: childPid || transport.pid,
          });
        } finally {
          lockRelease = await lock.release();
        }
        return { shutdown, lockRelease };
      })();
    }
    return cleanupPromise;
  };
  const removeSignalHandlers = installPremiereCepSignalHandlers(cleanup);

  async function call(
    name,
    args = {},
    timeoutMs = name === "ping" ? PING_TIMEOUT_MS : DEFAULT_TOOL_TIMEOUT_MS,
  ) {
    const startedAt = Date.now();
    try {
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: timeoutMs, maxTotalTimeout: timeoutMs },
      );
      const payload = parseToolPayload(result);
      return {
        ok: !isErrorPayload(payload),
        elapsedMs: Date.now() - startedAt,
        timeoutMs,
        args,
        payload,
      };
    } catch (error) {
      return {
        ok: false,
        elapsedMs: Date.now() - startedAt,
        timeoutMs,
        args,
        error: error?.stack || error?.message || String(error),
      };
    }
  }

  let lifecycle;
  try {
    await client.connect(transport);
    childPid = transport.pid;
    const toolsResult = await client.listTools();
    report.toolCount = toolsResult.tools?.length || 0;
    report.toolNames = (toolsResult.tools || []).map((tool) => tool.name).sort();

    report.checks.ping = await call("ping");
    const pingFailureReason = report.checks.ping.ok
      ? null
      : `Premiere CEP bridge ping failed or timed out after ${report.checks.ping.elapsedMs} ms.`;
    const pingNoProjectReason = pingFailureReason
      ? null
      : detectNoProjectState(report.checks.ping);
    report.checks.state = pingFailureReason
      ? skippedCheck(pingFailureReason)
      : pingNoProjectReason
        ? skippedCheck(`No project detected by ping: ${pingNoProjectReason}`)
        : await call("get_premiere_state");

    const noProjectReason =
      pingNoProjectReason || detectNoProjectState(report.checks.state);
    const projectOpen = pingFailureReason ? null : !noProjectReason;

    if (pingFailureReason || noProjectReason) {
      const skipReason = pingFailureReason
        ? pingFailureReason
        : `No project detected: ${noProjectReason}`;
      report.checks.timelineSummary = skippedCheck(skipReason);
      report.checks.sequenceStructure = skippedCheck(skipReason);
      report.checks.transitions = skippedCheck(skipReason);
      report.checks.captureFrame = skippedCheck(skipReason);
      if (pingFailureReason) {
        report.failures.push({
          check: "ping",
          message: pingFailureReason,
          payload: report.checks.ping,
        });
        report.warnings.push(
          "The CEP bridge did not answer. Remaining Premiere checks were skipped instead of queueing more host requests.",
        );
      } else {
        report.warnings.push(
          "No active Premiere project detected. Project-dependent checks were skipped.",
        );
      }
    } else {
      report.checks.timelineSummary = await call("get_timeline_summary");
      report.checks.sequenceStructure = await call("get_sequence_structure");
      report.checks.transitions = await call("list_available_transitions");
      report.checks.captureFrame = await call("capture_frame");

      const state = report.checks.state.payload;
      const structure = report.checks.sequenceStructure.payload;

      if (!report.checks.captureFrame.ok) {
        report.warnings.push(
          "capture_frame failed. It should normally use the Windows PrintWindow fallback on the patched 26.3 setup.",
        );
      }

      if (options.writeSmoke) {
        const playhead = Number(state?.playheadSeconds || 0);
        const markerTime = Number.isFinite(playhead) ? playhead : 0;
        const markerName = `Codex MCP smoke ${new Date().toISOString()}`;
        report.writeActions.push(
          await call("add_marker", {
            time_seconds: markerTime,
            name: markerName,
            comments: "Temporary Codex MCP smoke marker. Do not save this project.",
            color: 6,
            duration_seconds: 0,
          }),
        );

        const nodeId = findCandidateClip(state, structure);
        if (nodeId) {
          report.writeActions.push(
            await call("set_effect_property", {
              node_id: nodeId,
              effect_name: "불투명도",
              property_name: "불투명도",
              value: 99,
            }),
          );
          report.writeActions.push(
            await call("set_effect_property", {
              node_id: nodeId,
              effect_name: "불투명도",
              property_name: "불투명도",
              value: 100,
            }),
          );
        } else {
          report.warnings.push("No clip found for opacity write smoke.");
        }
      }

      if (options.transitionTest) {
        const cutPoint = findNextCut(state, structure);
        if (cutPoint !== null) {
          const transitionAction = await call("add_transition", {
            transition_name: "교차 디졸브",
            track_index: 0,
            cut_point_seconds: cutPoint,
            duration_seconds: 0.5,
          });
          report.writeActions.push(transitionAction);
          if (!transitionDurationMatched(transitionAction)) {
            report.failures.push({
              check: "transition duration",
              message:
                "add_transition did not report adjustedTransitions[].durationMatched === true",
              payload: transitionAction.payload,
            });
          }
        } else {
          report.warnings.push("No adjacent V1 cut point found for transition smoke.");
        }
      }

      if (options.overlayTest) {
        if (fs.existsSync(options.overlayPath)) {
          const overlayStart = Number(state?.playheadSeconds || 0) + 3;
          const overlayEnd = overlayStart + 1;
          if (hasTrackOverlap(structure, 1, overlayStart, overlayEnd)) {
            report.warnings.push(
              `Skipped overlay test because V2 is occupied from ${overlayStart} to ${overlayEnd}.`,
            );
          } else {
            report.writeActions.push(
              await call("import_media", {
                file_paths: [options.overlayPath],
                suppress_ui: true,
              }),
            );
            report.writeActions.push(
              await call("add_to_timeline", {
                item_id: path.basename(options.overlayPath),
                track_index: 1,
                start_seconds: overlayStart,
                audio_track_index: 2,
              }),
            );
          }
        } else {
          report.warnings.push(`Overlay MOV not found: ${options.overlayPath}`);
        }
      }
    }

    if (projectOpen && report.writeActions.length > 0) {
      report.postWriteChecks = {
        timelineSummary: await call("get_timeline_summary"),
        sequenceStructure: await call("get_sequence_structure"),
      };
    }

    const writeActionsOk = report.writeActions.every((action) => action.ok);
    const writeReady = !options.writeSmoke || (writeActionsOk && report.failures.length === 0);

    report.summary = {
      connected: report.checks.ping.ok,
      projectOpen,
      ready:
        report.checks.ping.ok &&
        projectOpen &&
        report.checks.state.ok &&
        report.checks.timelineSummary.ok &&
        report.checks.sequenceStructure.ok &&
        writeReady,
      premiereVersion: report.checks.ping.payload?.premiereVersion,
      projectName: report.checks.ping.payload?.projectName,
      activeSequence: report.checks.ping.payload?.activeSequence,
      toolCount: report.toolCount,
      writeActionCount: report.writeActions.length,
      writeActionsOk,
      failureCount: report.failures.length,
      warningCount: report.warnings.length,
    };
  } finally {
    try {
      lifecycle = await cleanup();
    } finally {
      removeSignalHandlers();
    }
  }

  report.lifecycle = {
    lockPath: lock.lockPath,
    recoveredStaleOwner: lock.recoveredStaleOwner,
    lockRelease: lifecycle?.lockRelease,
    childShutdown: lifecycle?.shutdown,
  };
  if (!lifecycle?.shutdown?.confirmedExited) {
    report.failures.push({
      check: "MCP child lifecycle",
      message: `MCP child PID ${lifecycle?.shutdown?.childPid || "unknown"} did not exit within the bounded shutdown window.`,
      payload: lifecycle?.shutdown,
    });
    report.summary.ready = false;
    report.summary.failureCount = report.failures.length;
  }

  const outPath = path.resolve(options.out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Report: ${outPath}`);

  if (!report.summary.ready) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
