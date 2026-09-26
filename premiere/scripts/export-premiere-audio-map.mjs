import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import {
  acquirePremiereCepLock,
  createPremiereCepLifecycle,
  installPremiereCepSignalHandlers,
} from "./lib/premiere-cep-lock.mjs";
import { DEFAULT_MCP_ROOT, DEFAULT_TEMP_DIR } from "../servers/premiere-uxp-mcp/paths.mjs";

function parseArgs(argv) {
  const options = {
    out: "tmp/premiere-audio-balance/project-audio-map-current.json",
    mcpRoot: process.env.PREMIERE_MCP_ROOT || DEFAULT_MCP_ROOT,
    tempDir: process.env.PREMIERE_TEMP_DIR || DEFAULT_TEMP_DIR,
    timeoutMs: 180000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--out") options.out = argv[++index];
    else if (value === "--mcp-root") options.mcpRoot = argv[++index];
    else if (value === "--temp-dir") options.tempDir = argv[++index];
    else if (value === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/export-premiere-audio-map.mjs [--out <json>]",
    "",
    "Exports current active-sequence audio clip timing, media paths, and Volume > Level values.",
    "This is read-only and does not save or change the Premiere project.",
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
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (text === undefined) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildExtendScript() {
  return `
var seq = app.project.activeSequence;
if (!seq) return __error("No active sequence");

function isVolumeComponent(comp) {
  var name = String(comp.displayName || "");
  var matchName = String(comp.matchName || "");
  return name === "볼륨" || name === "Volume" || matchName.indexOf("Volume") >= 0;
}

function isLevelProperty(prop, index) {
  var name = String(prop.displayName || "");
  return name === "레벨" || name === "Level" || index === 1;
}

function getVolumeLevel(clip) {
  for (var c = 0; c < clip.components.numItems; c++) {
    var comp = clip.components[c];
    if (!isVolumeComponent(comp)) continue;
    for (var p = 0; p < comp.properties.numItems; p++) {
      var prop = comp.properties[p];
      if (isLevelProperty(prop, p)) {
        return {
          raw: Number(prop.getValue()),
          component: String(comp.displayName || ""),
          property: String(prop.displayName || "")
        };
      }
    }
  }
  return { raw: null, component: "", property: "" };
}

var audioTimeline = [];
for (var t = 0; t < seq.audioTracks.numTracks; t++) {
  var track = seq.audioTracks[t];
  for (var i = 0; i < track.clips.numItems; i++) {
    var clip = track.clips[i];
    var projectItem = clip.projectItem;
    var mediaPath = "";
    try {
      mediaPath = projectItem ? String(projectItem.getMediaPath() || "") : "";
    } catch (e) {}
    var level = getVolumeLevel(clip);
    audioTimeline.push({
      trackIndex: t,
      clipIndex: i,
      nodeId: String(clip.nodeId || ""),
      name: String(clip.name || ""),
      startSeconds: __ticksToSeconds(clip.start.ticks),
      endSeconds: __ticksToSeconds(clip.end.ticks),
      inPointSeconds: __ticksToSeconds(clip.inPoint.ticks),
      outPointSeconds: __ticksToSeconds(clip.outPoint.ticks),
      mediaPath: mediaPath,
      projectItemNodeId: projectItem ? String(projectItem.nodeId || "") : "",
      volumeLevelRaw: level.raw,
      volumeComponentName: level.component,
      volumePropertyName: level.property
    });
  }
}

return __result({
  projectName: app.project.name,
  projectPath: app.project.path,
  sequenceName: seq.name,
  sequenceId: seq.sequenceID,
  sequenceDurationSeconds: __ticksToSeconds(seq.end),
  audioTrackCount: seq.audioTracks.numTracks,
  audioClipCount: audioTimeline.length,
  audioTimeline: audioTimeline
});
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!(options.timeoutMs > 0)) throw new Error("Invalid --timeout-ms");

  const serverPath = path.join(options.mcpRoot, "dist", "index.js");
  const { Client, StdioClientTransport } = await importMcpClient(options.mcpRoot);
  const client = new Client(
    { name: "premiere-export-audio-map", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: { ...process.env, PREMIERE_TEMP_DIR: options.tempDir },
  });
  const cepLock = await acquirePremiereCepLock({
    bridgeDirectory: options.tempDir,
    tool: "export-premiere-audio-map",
    metadata: { mode: "read" },
  });
  const lifecycle = createPremiereCepLifecycle({ lock: cepLock });
  const session = lifecycle.registerSession({
    client,
    transport,
    label: "premiere-export-audio-map",
  });
  const removeSignalHandlers = installPremiereCepSignalHandlers(() =>
    lifecycle.cleanup(),
  );

  try {
    await lifecycle.connectSession(session);
    const result = await client.callTool(
      {
        name: "execute_extendscript",
        arguments: { code: buildExtendScript(), timeout_ms: options.timeoutMs },
      },
      undefined,
      { timeout: options.timeoutMs },
    );
    const payload = parseToolPayload(result);
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.audioTimeline)) {
      throw new Error(typeof payload === "string" ? payload : "Invalid Premiere audio map response");
    }
    const outPath = path.resolve(options.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const trackCounts = {};
    for (const clip of payload.audioTimeline) {
      trackCounts[clip.trackIndex] = (trackCounts[clip.trackIndex] || 0) + 1;
    }
    console.log(JSON.stringify({
      out: outPath,
      projectName: payload.projectName,
      sequenceName: payload.sequenceName,
      sequenceDurationSeconds: payload.sequenceDurationSeconds,
      audioClipCount: payload.audioClipCount,
      trackCounts,
    }, null, 2));
  } finally {
    try {
      await lifecycle.cleanup();
    } finally {
      removeSignalHandlers();
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
