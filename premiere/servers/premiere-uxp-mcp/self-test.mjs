import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverPluginDataBridgeDirectory,
  PremiereUxpBridgeClient,
} from "./bridge-client.mjs";
import { loadCapabilityRegistry } from "./capability-registry.mjs";
import { runOfflineHandlerSelfTest } from "./offline-handler-self-test.mjs";
import { loadMcpClientSdk } from "./sdk-loader.mjs";
import { loadToolCatalog } from "./tool-catalog.mjs";
import { DANGEROUS_TOOLS, WRITE_TOOLS } from "./write-policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function closeWithTimeout(client, transport) {
  const timeout = new Promise((resolve) => setTimeout(resolve, 1_500));
  try {
    await Promise.race([client.close(), timeout]);
  } catch {}
  try {
    await Promise.race([transport.close(), timeout]);
  } catch {}
}

function runNode(argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argumentsList, {
      cwd: HERE,
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function atomicResponse(directory, request, status, data = null) {
  const finalName = `res_${request.sequence}_${request.id}.json`;
  const tempName = `.tmp_res_${request.sequence}_${request.id}_${randomUUID()}`;
  const now = new Date().toISOString();
  const response = {
    protocolVersion: 1,
    id: request.id,
    sequence: request.sequence,
    command: request.command,
    status,
    ok: status === "done" ? true : null,
    progress: status === "running" ? { message: "self-test" } : null,
    data: status === "done" ? data : null,
    error: null,
    createdAt: request.createdAt,
    startedAt: now,
    updatedAt: now,
    completedAt: status === "done" ? now : null,
  };
  await writeFile(path.join(directory, tempName), JSON.stringify(response), "utf8");
  await rename(
    path.join(directory, tempName),
    path.join(directory, finalName),
  );
}

async function fakeUxp(directory, expectedCommand, responseData, options = {}) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const requestName = (await readdir(directory)).find((name) =>
      /^req_.*\.json$/.test(name),
    );
    if (!requestName) {
      await delay(10);
      continue;
    }

    const runningName = requestName.replace(/^req_/, "run_");
    await rename(
      path.join(directory, requestName),
      path.join(directory, runningName),
    );
    const request = JSON.parse(
      await readFile(path.join(directory, runningName), "utf8"),
    );
    if (request.command !== expectedCommand) {
      throw new Error(
        `Fake UXP expected ${expectedCommand}, received ${request.command}.`,
      );
    }
    await atomicResponse(directory, request, "running");
    await delay(25);
    if (options.transientInvalidMs) {
      const responsePath = path.join(
        directory,
        `res_${request.sequence}_${request.id}.json`,
      );
      await writeFile(responsePath, '{"protocolVersion":', "utf8");
      await delay(options.transientInvalidMs);
    }
    await atomicResponse(directory, request, "done", responseData);
    await rm(path.join(directory, runningName), { force: true });
    return;
  }
  throw new Error("Fake UXP did not receive a request.");
}

const root = path.join(os.tmpdir(), `deno-premiere-uxp-self-test-${randomUUID()}`);
const directory = path.join(root, "premiere-uxp-bridge");
const resolvedTemp = `${path.resolve(os.tmpdir())}${path.sep}`.toLowerCase();
if (!`${path.resolve(root)}${path.sep}`.toLowerCase().startsWith(resolvedTemp)) {
  throw new Error(`Unsafe self-test root: ${root}`);
}

await mkdir(directory, { recursive: true });
try {
  const officialTypesCheck = await runNode([
    path.resolve(HERE, "..", "..", "scripts", "check-premiere-uxp-types.mjs"),
  ]);
  if (officialTypesCheck.code !== 0) {
    throw new Error(
      `Official Premiere UXP type check failed: ${officialTypesCheck.stderr || officialTypesCheck.stdout}`,
    );
  }
  const [toolCatalog, capabilityRegistry] = await Promise.all([
    loadToolCatalog(HERE),
    loadCapabilityRegistry(HERE),
  ]);
  const localTools = toolCatalog.localNames;
  const expectedBridgeNames = new Set(
    capabilityRegistry.registry.capabilities
      .filter(
        (capability) =>
          localTools.has(capability.name) ||
          ["ported", "ported-caveat"].includes(capability.uxp?.catalogStatus),
      )
      .map((capability) => capability.name),
  );
  if (
    toolCatalog.bridgeEnabledSet.size !== expectedBridgeNames.size ||
    Array.from(expectedBridgeNames).some(
      (name) => !toolCatalog.bridgeEnabledSet.has(name),
    ) ||
    Array.from(toolCatalog.bridgeEnabledSet).some(
      (name) => !expectedBridgeNames.has(name),
    ) ||
    toolCatalog.enabledNames.length !==
      expectedBridgeNames.size + toolCatalog.serverToolCount ||
    toolCatalog.serverToolCount !== 2 ||
    !toolCatalog.serverToolSet.has("get_premiere_capabilities") ||
    !toolCatalog.serverToolSet.has("resolve_premiere_tool") ||
    toolCatalog.upstreamToolCount < 1 ||
    toolCatalog.localToolCount !== localTools.size ||
    toolCatalog.overrideCount < 1
  ) {
    throw new Error(
      "The enabled UXP tool catalog does not match the current UXP catalog.",
    );
  }
  const enabledSchemaByName = new Map(
    toolCatalog.enabledTools.map((tool) => [tool.name, tool]),
  );
  const markerProperties =
    enabledSchemaByName.get("add_marker")?.inputSchema?.properties || {};
  const displayFormatEnum =
    enabledSchemaByName.get("set_sequence_display_format")?.inputSchema
      ?.properties?.video_display_format?.enum || [];
  const removeTransitionPositions =
    enabledSchemaByName.get("remove_transition")?.inputSchema?.properties
      ?.position?.enum || [];
  const captionDescription =
    enabledSchemaByName.get("get_caption_tracks")?.description || "";
  if (
    Object.hasOwn(markerProperties, "color") ||
    JSON.stringify(displayFormatEnum) !== JSON.stringify([1, 2, 3, 9, 10, 11]) ||
    JSON.stringify(removeTransitionPositions) !== JSON.stringify(["end"]) ||
    !captionDescription.includes("text: null") ||
    !captionDescription.includes("textAvailable: false")
  ) {
    throw new Error("Local UXP schema overrides were not applied.");
  }
  if (
    WRITE_TOOLS.has("capture_frame") ||
    DANGEROUS_TOOLS.has("capture_frame") ||
    !WRITE_TOOLS.has("remove_transition") ||
    DANGEROUS_TOOLS.has("remove_transition") ||
    DANGEROUS_TOOLS.has("remove_from_timeline") ||
    DANGEROUS_TOOLS.has("ripple_delete") ||
    DANGEROUS_TOOLS.has("overwrite_clip") ||
    DANGEROUS_TOOLS.has("remove_effect") ||
    DANGEROUS_TOOLS.has("remove_keyframe") ||
    DANGEROUS_TOOLS.has("delete_marker") ||
    DANGEROUS_TOOLS.has("remove_selected_clips") ||
    !DANGEROUS_TOOLS.has("save_project") ||
    !DANGEROUS_TOOLS.has("delete_project_item") ||
    !DANGEROUS_TOOLS.has("export_sequence") ||
    !DANGEROUS_TOOLS.has("relink_media") ||
    !DANGEROUS_TOOLS.has("set_app_preference") ||
    Array.from(DANGEROUS_TOOLS).some((name) => !WRITE_TOOLS.has(name)) ||
    Array.from(WRITE_TOOLS).some(
      (name) => !toolCatalog.bridgeEnabledSet.has(name),
    )
  ) {
    throw new Error(
      "The server write/dangerous declarations do not match the current UXP catalog.",
    );
  }

  const capabilitySummary = capabilityRegistry.execute(
    "get_premiere_capabilities",
    {},
  );
  const officialUxpCapabilities = capabilityRegistry.execute(
    "get_premiere_capabilities",
    { official_uxp_only: true, limit: 400 },
  );
  const liveOfficialUxpCapabilities = capabilityRegistry.execute(
    "get_premiere_capabilities",
    { official_uxp_only: true, live_only: true, limit: 400 },
  );
  const expectedOfficialUxpCount = capabilityRegistry.registry.capabilities.filter(
    (capability) =>
      capability.uxp?.registered === true &&
      !["blocked-uxp", "deferred", "runtime-failed", "diagnostic"].includes(
        capability.uxp?.status,
      ),
  ).length;
  if (
    officialUxpCapabilities.matchCount !== expectedOfficialUxpCount ||
    officialUxpCapabilities.capabilities?.some(
      (capability) => capability.uxp?.registered !== true,
    ) ||
    liveOfficialUxpCapabilities.capabilities?.some(
      (capability) =>
        capability.uxp?.registered !== true ||
        !["live-verified", "live-verified-read-caveat"].includes(
          capability.availability,
        ),
    )
  ) {
    throw new Error("Official-only Premiere capability filters are inconsistent.");
  }
  const blockedAutoReframe = capabilityRegistry.execute(
    "resolve_premiere_tool",
    { tool_name: "auto_reframe_sequence" },
  );
  const verifiedMarker = capabilityRegistry.execute("resolve_premiere_tool", {
    tool_name: "add_marker",
  });
  const verifiedCaptionTiming = capabilityRegistry.execute(
    "resolve_premiere_tool",
    { tool_name: "get_caption_tracks" },
  );
  const verifiedEndTransitionRemoval = capabilityRegistry.execute(
    "resolve_premiere_tool",
    { tool_name: "remove_transition" },
  );
  const actualUxpStatusCounts = capabilitySummary.summary?.byUxpStatus || {};
  if (
    Object.values(actualUxpStatusCounts).reduce(
      (total, count) => total + Number(count || 0),
      0,
    ) !== toolCatalog.bridgeToolCount
  ) {
    throw new Error(
      `Generated registry UXP status counts do not match the current UXP catalog: ${JSON.stringify(actualUxpStatusCounts)}.`,
    );
  }
  if (
    capabilitySummary.summary?.total !== toolCatalog.bridgeToolCount ||
    capabilitySummary.policy?.computerUseExcluded !== true ||
    capabilitySummary.capabilities !== undefined ||
    blockedAutoReframe.capability?.uxp?.status !== "blocked-uxp" ||
    blockedAutoReframe.capability?.preferredRoute !== "cep-test-first" ||
    verifiedMarker.capability?.availability !== "live-verified" ||
    verifiedMarker.capability?.preferredRoute !== "uxp" ||
    !verifiedCaptionTiming.capability?.description?.includes("text: null") ||
    !verifiedCaptionTiming.capability?.uxp?.note?.includes("text:null") ||
    !verifiedEndTransitionRemoval.capability?.uxp?.note?.includes(
      "position=end only",
    )
  ) {
    throw new Error("The code-only Premiere capability registry is inconsistent.");
  }

  const readProbeScript = path.resolve(
    HERE,
    "..",
    "..",
    "scripts",
    "probe-premiere-uxp-read-capabilities.mjs",
  );
  const readProbeHelp = await runNode([readProbeScript, "--help"]);
  if (
    readProbeHelp.code !== 0 ||
    !readProbeHelp.stdout.includes(
      path.join("tmp", "premiere-uxp-read-probe", "latest.json"),
    )
  ) {
    throw new Error("Read probe help does not advertise the regenerable tmp default.");
  }
  const forbiddenEvidencePath = path.resolve(
    HERE,
    "..",
    "..",
    "reports",
    `read-probe-self-test-${randomUUID()}.json`,
  );
  const blockedEvidenceWrite = await runNode([
    readProbeScript,
    "--out",
    forbiddenEvidencePath,
  ]);
  if (
    blockedEvidenceWrite.code === 0 ||
    !blockedEvidenceWrite.stderr.includes("--promote-immutable") ||
    (await pathExists(forbiddenEvidencePath))
  ) {
    throw new Error("Routine read probe could overwrite permanent evidence.");
  }

  const handlerMetadata = await runOfflineHandlerSelfTest(
    path.resolve(HERE, "..", ".."),
  );
  if (handlerMetadata) {
    const handlerNames = new Set(handlerMetadata.names || []);
    const handlerWrites = new Set(handlerMetadata.writeNames || []);
    const handlerDangerous = new Set(handlerMetadata.dangerousNames || []);
    if (
      handlerNames.size !== toolCatalog.bridgeEnabledSet.size ||
      toolCatalog.bridgeEnabledNames.some((name) => !handlerNames.has(name)) ||
      handlerWrites.size !== WRITE_TOOLS.size ||
      Array.from(WRITE_TOOLS).some((name) => !handlerWrites.has(name)) ||
      Array.from(DANGEROUS_TOOLS).some((name) => !handlerDangerous.has(name))
    ) {
      throw new Error("Handler registry metadata does not match server policy/catalog.");
    }
  }

  const offlineCapabilityDirectory = path.join(
    root,
    "offline-capability-bridge",
  );
  const offlineCapabilityCall = await runNode([
    path.join(HERE, "call-tool.mjs"),
    "resolve_premiere_tool",
    '{"tool_name":"add_text_overlay"}',
    "--bridge-dir",
    offlineCapabilityDirectory,
  ]);
  if (
    offlineCapabilityCall.code !== 0 ||
    !offlineCapabilityCall.stdout.includes('"external-code-fallback"') ||
    !offlineCapabilityCall.stdout.includes('"remotion-alpha-mov"') ||
    (await pathExists(offlineCapabilityDirectory))
  ) {
    throw new Error(
      "Server-only capability resolution touched the bridge or returned the wrong route.",
    );
  }

  const blockedExperimentalDirectory = path.join(
    root,
    "blocked-experimental-bridge",
  );
  const blockedExperimentalCapability =
    capabilityRegistry.registry.capabilities.find(
      (capability) =>
        expectedBridgeNames.has(capability.name) &&
        capability.access === "read" &&
        capability.uxp?.status === "local-unverified",
    );
  if (!blockedExperimentalCapability) {
    throw new Error("No local-unverified read capability is available for the experimental gate test.");
  }
  const blockedExperimentalCall = await runNode([
    path.join(HERE, "call-tool.mjs"),
    blockedExperimentalCapability.name,
    "{}",
    "--bridge-dir",
    blockedExperimentalDirectory,
  ]);
  if (
    blockedExperimentalCall.code !== 1 ||
    !blockedExperimentalCall.stdout.includes(
      "local handler without a live roundtrip",
    ) ||
    (await pathExists(blockedExperimentalDirectory))
  ) {
    throw new Error(
      "Experimental UXP tool was not blocked before bridge access.",
    );
  }

  const blockedCliDirectory = path.join(root, "blocked-cli-bridge");
  const blockedCli = await runNode([
    path.join(HERE, "call-tool.mjs"),
    "add_marker",
    '{"time_seconds":1}',
    "--bridge-dir",
    blockedCliDirectory,
  ]);
  if (
    blockedCli.code !== 2 ||
    !blockedCli.stderr.includes("Blocked write tool 'add_marker'") ||
    (await pathExists(blockedCliDirectory))
  ) {
    throw new Error("call-tool --allow-write gate did not block before bridge access.");
  }

  const blockedDangerousCliDirectory = path.join(
    root,
    "blocked-dangerous-cli-bridge",
  );
  const blockedDangerousCli = await runNode([
    path.join(HERE, "call-tool.mjs"),
    "save_project",
    "{}",
    "--allow-write",
    "--bridge-dir",
    blockedDangerousCliDirectory,
  ]);
  if (
    blockedDangerousCli.code !== 3 ||
    !blockedDangerousCli.stderr.includes(
      "Blocked dangerous tool 'save_project'",
    ) ||
    (await pathExists(blockedDangerousCliDirectory))
  ) {
    throw new Error(
      "call-tool --allow-dangerous gate did not block before bridge access.",
    );
  }

  const dangerousOnlyCliDirectory = path.join(
    root,
    "dangerous-only-cli-bridge",
  );
  const dangerousOnlyCli = await runNode([
    path.join(HERE, "call-tool.mjs"),
    "save_project",
    "{}",
    "--allow-dangerous",
    "--bridge-dir",
    dangerousOnlyCliDirectory,
  ]);
  if (
    dangerousOnlyCli.code !== 2 ||
    !dangerousOnlyCli.stderr.includes(
      "Blocked write tool 'save_project'",
    ) ||
    (await pathExists(dangerousOnlyCliDirectory))
  ) {
    throw new Error(
      "--allow-dangerous incorrectly bypassed the independent write gate.",
    );
  }

  const blockedServerDirectory = path.join(root, "blocked-server-bridge");
  const { Client, StdioClientTransport } = await loadMcpClientSdk();
  const gateClient = new Client(
    { name: "deno-premiere-uxp-gate-test", version: "0.1.0" },
    { capabilities: {} },
  );
  const gateTransport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(HERE, "index.mjs"),
      "--bridge-dir",
      blockedServerDirectory,
    ],
    env: process.env,
  });
  try {
    await gateClient.connect(gateTransport);
    const listedTools = await gateClient.listTools();
    const rippleDescription = listedTools.tools.find(
      (tool) => tool.name === "ripple_delete",
    )?.description;
    const localUnverifiedDescription = listedTools.tools.find(
      (tool) => tool.name === blockedExperimentalCapability.name,
    )?.description;
    if (
      !String(rippleDescription).includes(
        "UXP registered port; offline-verified, live-depth caveat",
      ) ||
      !String(localUnverifiedDescription).includes(
        "UXP local handler; live roundtrip pending",
      )
    ) {
      throw new Error(
        "index.mjs tool labels do not describe verification depth.",
      );
    }
    const blockedResult = await gateClient.callTool({
      name: "add_marker",
      arguments: { time_seconds: 1 },
    });
    const blockedText = blockedResult.content?.find(
      (part) => part.type === "text",
    )?.text;
    if (
      !blockedResult.isError ||
      !String(blockedText).includes("Blocked write tool 'add_marker'")
    ) {
      throw new Error("index.mjs --allow-write gate returned an unexpected result.");
    }
  } finally {
    await closeWithTimeout(gateClient, gateTransport);
  }
  if (
    (await pathExists(blockedServerDirectory)) &&
    (await readdir(blockedServerDirectory)).length !== 0
  ) {
    throw new Error("index.mjs write gate emitted a bridge request before rejection.");
  }

  const blockedDangerousServerDirectory = path.join(
    root,
    "blocked-dangerous-server-bridge",
  );
  const dangerousGateClient = new Client(
    { name: "deno-premiere-uxp-dangerous-gate-test", version: "0.1.0" },
    { capabilities: {} },
  );
  const dangerousGateTransport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(HERE, "index.mjs"),
      "--allow-write",
      "--bridge-dir",
      blockedDangerousServerDirectory,
    ],
    env: process.env,
  });
  try {
    await dangerousGateClient.connect(dangerousGateTransport);
    const blockedResult = await dangerousGateClient.callTool({
      name: "save_project",
      arguments: {},
    });
    const blockedText = blockedResult.content?.find(
      (part) => part.type === "text",
    )?.text;
    if (
      !blockedResult.isError ||
      !String(blockedText).includes(
        "Blocked dangerous tool 'save_project'",
      )
    ) {
      throw new Error(
        "index.mjs --allow-dangerous gate returned an unexpected result.",
      );
    }
  } finally {
    await closeWithTimeout(dangerousGateClient, dangerousGateTransport);
  }
  if (
    (await pathExists(blockedDangerousServerDirectory)) &&
    (await readdir(blockedDangerousServerDirectory)).length !== 0
  ) {
    throw new Error(
      "index.mjs dangerous gate emitted a bridge request before rejection.",
    );
  }

  const allowedWriteDirectory = path.join(root, "allowed-write-bridge");
  await mkdir(allowedWriteDirectory, { recursive: true });
  const allowedWriteData = {
    added: true,
    timeSeconds: 1,
    name: "Offline gate test",
    comments: "",
  };
  const [allowedCli] = await Promise.all([
    runNode([
      path.join(HERE, "call-tool.mjs"),
      "add_marker",
      '{"time_seconds":1,"name":"Offline gate test"}',
      "--allow-write",
      "--bridge-dir",
      allowedWriteDirectory,
    ]),
    fakeUxp(allowedWriteDirectory, "add_marker", allowedWriteData),
  ]);
  if (
    allowedCli.code !== 0 ||
    !allowedCli.stdout.includes('"added": true') ||
    !allowedCli.stdout.includes('"name": "Offline gate test"')
  ) {
    throw new Error("call-tool --allow-write did not pass the isolated mock round trip.");
  }

  const allowedPortedCaveatDirectory = path.join(
    root,
    "allowed-ported-caveat-write-bridge",
  );
  await mkdir(allowedPortedCaveatDirectory, { recursive: true });
  const allowedPortedCaveatData = {
    removed: true,
    clipName: "take-2.mov",
    ripple: true,
  };
  const [allowedPortedCaveatCli] = await Promise.all([
    runNode([
      path.join(HERE, "call-tool.mjs"),
      "ripple_delete",
      '{"node_id":"video-node-1"}',
      "--allow-write",
      "--bridge-dir",
      allowedPortedCaveatDirectory,
    ]),
    fakeUxp(
      allowedPortedCaveatDirectory,
      "ripple_delete",
      allowedPortedCaveatData,
    ),
  ]);
  if (
    allowedPortedCaveatCli.code !== 0 ||
    !allowedPortedCaveatCli.stdout.includes('"removed": true') ||
    !allowedPortedCaveatCli.stdout.includes('"ripple": true')
  ) {
    throw new Error(
      "Registered ported-caveat write did not run with --allow-write alone.",
    );
  }

  const allowedDangerousDirectory = path.join(
    root,
    "allowed-dangerous-bridge",
  );
  await mkdir(allowedDangerousDirectory, { recursive: true });
  const allowedDangerousData = {
    saved: true,
    projectName: "Safety Gate Test.prproj",
  };
  const [allowedDangerousCli] = await Promise.all([
    runNode([
      path.join(HERE, "call-tool.mjs"),
      "save_project",
      "{}",
      "--allow-write",
      "--allow-dangerous",
      "--bridge-dir",
      allowedDangerousDirectory,
    ]),
    fakeUxp(
      allowedDangerousDirectory,
      "save_project",
      allowedDangerousData,
    ),
  ]);
  if (
    allowedDangerousCli.code !== 0 ||
    !allowedDangerousCli.stdout.includes('"saved": true') ||
    !allowedDangerousCli.stdout.includes(
      '"projectName": "Safety Gate Test.prproj"',
    )
  ) {
    throw new Error(
      "call-tool --allow-dangerous did not pass the isolated mock round trip.",
    );
  }

  const captureRoot = path.join(root, "capture-frame-server");
  const captureBridgeDirectory = path.join(captureRoot, "bridge");
  const captureDirectory = path.join(captureRoot, "captures");
  const capturePath = path.join(
    captureDirectory,
    "deno_capture_1720000000000_abc123.jpg",
  );
  const captureBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await mkdir(captureBridgeDirectory, { recursive: true });
  await mkdir(captureDirectory, { recursive: true });
  await writeFile(capturePath, captureBytes);
  const captureClient = new Client(
    { name: "deno-premiere-uxp-capture-test", version: "0.1.0" },
    { capabilities: {} },
  );
  const captureTransport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(HERE, "index.mjs"),
      "--bridge-dir",
      captureBridgeDirectory,
    ],
    env: process.env,
  });
  try {
    await captureClient.connect(captureTransport);
    const [captureResult] = await Promise.all([
      captureClient.callTool({ name: "capture_frame", arguments: {} }),
      fakeUxp(captureBridgeDirectory, "capture_frame", {
        captured: true,
        capturePath,
        mimeType: "image/jpeg",
        width: 1280,
        height: 720,
        timeSeconds: 1,
        temporary: true,
        semantic: "sequence-frame",
      }),
    ]);
    const imagePart = captureResult.content?.find(
      (part) => part.type === "image",
    );
    if (
      captureResult.isError ||
      imagePart?.mimeType !== "image/jpeg" ||
      imagePart?.data !== captureBytes.toString("base64") ||
      (await pathExists(capturePath))
    ) {
      throw new Error(
        "capture_frame did not return and clean up the isolated temporary image.",
      );
    }
  } finally {
    await closeWithTimeout(captureClient, captureTransport);
  }

  const fakePluginData = path.join(
    root,
    "AppData",
    "Adobe",
    "UXP",
    "PluginsStorage",
    "PPRO",
    "26",
    "Developer",
    "com.deno.premiere.uxp",
    "PluginData",
  );
  await mkdir(fakePluginData, { recursive: true });
  const discovered = await discoverPluginDataBridgeDirectory({
    appData: path.join(root, "AppData"),
  });
  if (
    discovered.version !== "26" ||
    discovered.channel !== "Developer" ||
    discovered.directory !== path.join(fakePluginData, "bridge")
  ) {
    throw new Error("PluginData bridge auto-discovery returned the wrong path.");
  }

  const bridge = new PremiereUxpBridgeClient({ directory, timeoutMs: 2_000 });
  let responder = fakeUxp(directory, "ping", {
    connected: true,
    premiereVersion: "26.3.0",
    projectName: "self-test.prproj",
    activeSequence: "Self Test",
  });
  const result = await bridge.call("ping", {});
  await responder;
  if (result.projectName !== "self-test.prproj") {
    throw new Error("Unexpected self-test response.");
  }

  responder = fakeUxp(
    directory,
    "ping",
    {
      connected: true,
      premiereVersion: "26.3.0",
      projectName: "retry-self-test.prproj",
      activeSequence: "Retry Self Test",
    },
    { transientInvalidMs: 150 },
  );
  const retryResult = await bridge.call("ping", {});
  await responder;
  if (retryResult.projectName !== "retry-self-test.prproj") {
    throw new Error("Transient response read retry did not recover.");
  }

  responder = fakeUxp(directory, "get_caption_tracks", {
    captionTrackCount: 1,
    captionTextAvailable: false,
    tracks: [
      {
        index: 0,
        id: "1",
        name: "소제목",
        muted: false,
        itemCount: 1,
        items: [
          {
            index: 0,
            text: null,
            textAvailable: false,
            kind: "SyntheticCaption",
            name: "",
            matchName: "SyntheticCaption",
            startSeconds: 0,
            endSeconds: 0.5,
          },
        ],
      },
    ],
  });
  const captions = await bridge.call("get_caption_tracks", {});
  await responder;
  if (
    captions.captionTextAvailable !== false ||
    captions.tracks?.[0]?.items?.[0]?.text !== null ||
    captions.tracks?.[0]?.items?.[0]?.textAvailable !== false ||
    captions.tracks?.[0]?.items?.[0]?.kind !== "SyntheticCaption"
  ) {
    throw new Error("Caption tool bridge response was not preserved.");
  }

  responder = fakeUxp(directory, "get_clip_transcript", {
    items: [
      {
        name: "clip.mov",
        nodeId: "clip-1",
        wordCount: 1,
        words: [{ text: "오늘", startSeconds: 0, endSeconds: 0.4 }],
      },
    ],
  });
  const transcript = await bridge.call("get_clip_transcript", {
    item_name: "clip.mov",
  });
  await responder;
  if (transcript.items?.[0]?.words?.[0]?.text !== "오늘") {
    throw new Error("Transcript tool bridge response was not preserved.");
  }

  const phaseB3RoundTrips = [
    {
      name: "import_media",
      args: { file_paths: ["E:\\mock\\overlay.mov"], suppress_ui: true },
      data: { imported: 1, files: ["E:\\mock\\overlay.mov"] },
    },
    {
      name: "find_project_item_by_name",
      args: { name: "overlay.mov" },
      data: {
        nodeId: "project-item-1",
        name: "overlay.mov",
        type: "clip",
        mediaPath: "E:\\mock\\overlay.mov",
      },
    },
    {
      name: "add_to_timeline",
      args: {
        item_id: "project-item-1",
        track_index: 1,
        start_seconds: 12,
        audio_track_index: 0,
      },
      data: {
        added: true,
        item: "overlay.mov",
        trackIndex: 1,
        startSeconds: 12,
      },
    },
    {
      name: "remove_from_timeline",
      args: { node_id: "video-node-1", ripple: false },
      data: { removed: true, clipName: "overlay.mov" },
    },
    {
      name: "set_playhead_position",
      args: { time_seconds: 12 },
      data: { positionSeconds: 12 },
    },
    {
      name: "get_timeline_summary",
      args: {},
      data: {
        name: "Mock Sequence",
        totalClips: 2,
        markerCount: 0,
      },
    },
    {
      name: "add_marker",
      args: { time_seconds: 12, name: "Review" },
      data: {
        added: true,
        timeSeconds: 12,
        name: "Review",
        comments: "",
      },
    },
    {
      name: "list_markers",
      args: {},
      data: [
        {
          name: "Review",
          comments: "",
          startSeconds: 12,
          endSeconds: 12,
          type: "Comment",
        },
      ],
    },
    {
      name: "get_project_info",
      args: {},
      data: { name: "Mock Project", sequenceCount: 1, projectItemCount: 1 },
    },
    {
      name: "search_project_items",
      args: { query: "overlay" },
      data: { count: 1, items: [{ name: "overlay.mov" }] },
    },
    {
      name: "get_clip_properties",
      args: { node_id: "video-node-1" },
      data: { name: "overlay.mov", startSeconds: 2, endSeconds: 5 },
    },
    {
      name: "get_sequence_settings",
      args: {},
      data: { width: 1920, height: 1080, frameRate: 30 },
    },
    {
      name: "get_selected_clips",
      args: {},
      data: { count: 1, clips: [{ name: "overlay.mov" }] },
    },
    {
      name: "get_effect_properties",
      args: { node_id: "video-node-1", effect_name: "Opacity" },
      data: { effect: "Opacity", properties: [{ name: "Opacity", value: 100 }] },
    },
    {
      name: "get_keyframes",
      args: {
        node_id: "video-node-1",
        effect_name: "Opacity",
        property_name: "Opacity",
      },
      data: { keyframes: [{ timeSeconds: 0, value: 100 }] },
    },
    {
      name: "list_available_transitions",
      args: {},
      data: { transitions: [{ matchName: "Cross Dissolve" }] },
    },
    {
      name: "get_source_monitor_info",
      args: {},
      data: { open: true, item: { name: "overlay.mov" }, positionSeconds: 1 },
    },
    {
      name: "get_metadata",
      args: { item_id: "project-item-1" },
      data: { fields: { Scene: "Mock" } },
    },
    {
      name: "get_track_info",
      args: { track_type: "video", track_index: 0 },
      data: { name: "V1", itemCount: 1, muted: false },
    },
    {
      name: "get_export_file_extension",
      args: { preset_path: "E:\\mock\\preset.epr" },
      data: { extension: ".mov" },
    },
  ];
  for (const testCase of phaseB3RoundTrips) {
    responder = fakeUxp(directory, testCase.name, testCase.data);
    const roundTrip = await bridge.call(testCase.name, testCase.args);
    await responder;
    if (JSON.stringify(roundTrip) !== JSON.stringify(testCase.data)) {
      throw new Error(`${testCase.name} bridge response was not preserved.`);
    }
  }
  console.log("Bridge self-test passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
