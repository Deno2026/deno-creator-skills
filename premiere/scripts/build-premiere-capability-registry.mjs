import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DANGEROUS_TOOLS,
  WRITE_TOOLS,
} from "../servers/premiere-uxp-mcp/write-policy.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const COVERAGE_PATH = path.join(
  REPO_ROOT,
  "docs",
  "premiere",
  "premiere-uxp-tool-coverage.md",
);
const CEP_MATRIX_PATH = path.join(
  REPO_ROOT,
  "docs",
  "premiere",
  "premiere-mcp-tool-matrix.md",
);
const UPSTREAM_SCHEMA_PATH = path.join(
  REPO_ROOT,
  "servers",
  "premiere-uxp-mcp",
  "schemas",
  "upstream-tools.json",
);
const LOCAL_SCHEMA_PATH = path.join(
  REPO_ROOT,
  "servers",
  "premiere-uxp-mcp",
  "schemas",
  "local-tools.json",
);
const ENABLED_PATH = path.join(
  REPO_ROOT,
  "servers",
  "premiere-uxp-mcp",
  "enabled-tools.json",
);
const LIVE_OVERRIDES_PATH = path.join(
  REPO_ROOT,
  "servers",
  "premiere-uxp-mcp",
  "live-verification-overrides.json",
);
const OUTPUT_PATH = path.join(
  REPO_ROOT,
  "servers",
  "premiere-uxp-mcp",
  "capabilities.json",
);

const COVERAGE_STATUSES = new Set([
  "ported",
  "ported-caveat",
  "blocked-uxp",
  "deferred",
]);
const CHECK_ONLY = process.argv.includes("--check");
const CEP_SECTION_TO_STATUS = new Map([
  ["Verified", "live-verified"],
  ["Bounded", "caution"],
  ["Alternate", "blocked"],
]);
const EXTERNAL_FALLBACKS = new Map([
  [
    "add_text_overlay",
    [
      {
        route: "remotion-alpha-mov",
        status: "available",
        note: "Render a no-audio alpha MOV and place it through the verified import/timeline path.",
      },
    ],
  ],
]);
const READ_ONLY_OPERATIONAL_TOOLS = new Set([
  "subscribe_premiere_events",
  "unsubscribe_premiere_events",
]);

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function parseCoverage(markdown) {
  const rows = new Map();
  const pattern =
    /^\| `([^`]+)` \| `([^`]+)` \| `(ported|ported-caveat|blocked-uxp|deferred)` \| ([^|]+) \| ([^|]+) \|$/gm;

  for (const match of markdown.matchAll(pattern)) {
    const [, name, category, status, evidence, note] = match;
    invariant(!rows.has(name), `Duplicate UXP coverage row: ${name}`);
    rows.set(name, {
      category,
      status,
      evidence: evidence.trim(),
      note: note.trim(),
    });
  }

  return rows;
}

function parseCepMatrix(markdown) {
  const statuses = new Map();
  let activeStatus = null;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^## (Verified|Bounded|Alternate)\s*$/);
    if (heading) {
      activeStatus = CEP_SECTION_TO_STATUS.get(heading[1]);
      continue;
    }
    if (/^## /.test(line)) {
      activeStatus = null;
      continue;
    }
    if (!activeStatus) {
      continue;
    }

    const toolCell = line.match(/^\| ((?:`[^`]+`(?:\s*\/\s*)?)+) \|/);
    if (!toolCell) {
      continue;
    }
    for (const match of toolCell[1].matchAll(/`([^`]+)`/g)) {
      statuses.set(match[1], activeStatus);
    }
  }

  return statuses;
}

function inferAccess(name) {
  if (name === "capture_frame") {
    return { access: "read", risk: "read-only-temporary-capture" };
  }
  if (name === "create_caption_track") {
    return { access: "write", risk: "write" };
  }
  if (READ_ONLY_OPERATIONAL_TOOLS.has(name)) {
    return { access: "read", risk: "read-only-operational" };
  }
  if (DANGEROUS_TOOLS.has(name)) {
    return { access: "write", risk: "dangerous" };
  }
  if (WRITE_TOOLS.has(name)) {
    return { access: "write", risk: "write" };
  }
  if (
    /^(?:get|list|find|search|check|has|is|probe|inspect|match)_/.test(name) ||
    name === "ping"
  ) {
    return { access: "read", risk: "read-only" };
  }
  if (
    /^(?:delete_(?:bin|project_item|multiple_project_items|sequence)|export|encode|save|start_batch|launch_media_encoder|relink|set_offline|set_app_preference|set_project_scratch_disk)_/.test(
      name,
    )
  ) {
    return { access: "write", risk: "dangerous" };
  }
  return { access: "write", risk: "write-unverified" };
}

function chooseAvailability({
  uxpStatus,
  cepStatus,
  externalFallbacks,
  preferredRouteOverride,
}) {
  if (preferredRouteOverride) {
    const routeIsLive =
      (preferredRouteOverride === "uxp" &&
        ["ported", "live-read-caveat"].includes(uxpStatus)) ||
      (preferredRouteOverride === "cep" && cepStatus === "live-verified");
    const routeIsImplementedUxp =
      preferredRouteOverride === "uxp" && uxpStatus === "ported-caveat";
    return {
      availability: routeIsImplementedUxp
        ? "implemented-live-check"
        : routeIsLive
        ? preferredRouteOverride === "cep"
          ? "live-verified-fallback"
          : uxpStatus === "live-read-caveat"
            ? "live-verified-read-caveat"
            : "live-verified"
        : "experimental",
      preferredRoute: preferredRouteOverride,
      requiresDisposableVerification: !(routeIsLive || routeIsImplementedUxp),
    };
  }
  if (uxpStatus === "ported" || uxpStatus === "live-read-caveat") {
    return {
      availability:
        uxpStatus === "live-read-caveat"
          ? "live-verified-read-caveat"
          : "live-verified",
      preferredRoute: "uxp",
      requiresDisposableVerification: false,
    };
  }
  if (cepStatus === "live-verified") {
    return {
      availability: "live-verified-fallback",
      preferredRoute: "cep",
      requiresDisposableVerification: false,
    };
  }
  if (uxpStatus === "ported-caveat") {
    return {
      availability: "implemented-live-check",
      preferredRoute: "uxp",
      requiresDisposableVerification: false,
    };
  }
  if (cepStatus === "caution") {
    return {
      availability: "caution",
      preferredRoute: "cep",
      requiresDisposableVerification: true,
    };
  }
  if (cepStatus === "registered-unverified") {
    return {
      availability: "experimental-fallback",
      preferredRoute: "cep-test-first",
      requiresDisposableVerification: true,
    };
  }
  if (externalFallbacks.length > 0) {
    return {
      availability: "external-code-fallback",
      preferredRoute: externalFallbacks[0].route,
      requiresDisposableVerification: false,
    };
  }
  return {
    availability: "unavailable",
    preferredRoute: null,
    requiresDisposableVerification: false,
  };
}

function practicalCapabilityNote(note, risk) {
  let value = String(note || "");
  const permissionNote =
    risk === "dangerous"
      ? "Use --allow-write --allow-dangerous."
      : "Use --allow-write.";
  return value.replace(
    "Write permissions follow `servers/premiere-uxp-mcp/write-policy.mjs`.",
    permissionNote,
  );
}

function currentUpstreamNote({ name, uxpStatus, coverageNote, risk }) {
  if (name === "get_work_area") {
    return "Unavailable: the registered UXP and CEP routes have a reproducible runtime failure that requires a code fix.";
  }
  if (name === "undo") {
    return "Unavailable: Premiere Pro 26.3 provides no supported UXP or CEP undo command.";
  }
  if (uxpStatus === "ported") {
    return "Live UXP route verified. Execute the registered handler and read back the requested result.";
  }
  if (uxpStatus === "live-read-caveat") {
    return "Live UXP read route verified. Use the registered response schema and read the current project value.";
  }
  return practicalCapabilityNote(coverageNote, risk);
}

function currentLocalNote(name, diagnostic, liveVerified) {
  if (name === "get_caption_tracks") {
    return "Live local UXP timing/track read verified. Official UXP caption text is unavailable, so each item returns text:null and textAvailable:false.";
  }
  if (name === "remove_transition") {
    return "Live local UXP write verified. Public schema supports position=end only; use --allow-write and read back the transition edge.";
  }
  if (diagnostic) {
    return "Use this command for diagnostics.";
  }
  if (liveVerified) {
    return "Live local UXP route verified. Execute the registered command and read back the result.";
  }
  return "Run this local UXP command in the bounded diagnostic project and read back the result.";
}

function buildUpstreamCapability({
  tool,
  coverage,
  cepStatus,
  uxpEnabled,
  liveOverride,
}) {
  const externalFallbacks = EXTERNAL_FALLBACKS.get(tool.name) || [];
  const effectiveUxpStatus = liveOverride?.uxpStatus || coverage.status;
  const effectiveCepStatus = liveOverride?.cepStatus || cepStatus;
  const routeDecision = chooseAvailability({
    uxpStatus: effectiveUxpStatus,
    cepStatus: effectiveCepStatus,
    externalFallbacks,
    preferredRouteOverride: liveOverride?.preferredRoute,
  });
  const accessDecision = inferAccess(tool.name);

  return {
    name: tool.name,
    category: tool.category,
    description: tool.description,
    ...accessDecision,
    ...routeDecision,
    uxp: {
      status: effectiveUxpStatus,
      catalogStatus: coverage.status,
      registered: uxpEnabled,
      evidence: liveOverride
        ? `${coverage.evidence} Runtime evidence: ${
            liveOverride.evidence ||
            "servers/premiere-uxp-mcp/live-verification-overrides.json"
          }.`
        : coverage.evidence,
      note: currentUpstreamNote({
        name: tool.name,
        uxpStatus: effectiveUxpStatus,
        coverageNote: coverage.note,
        risk: accessDecision.risk,
      }),
    },
    cep: {
      status: effectiveCepStatus,
      registered: true,
    },
    externalFallbacks,
    computerUseExcluded: true,
  };
}

function buildLocalCapability(tool, uxpEnabled, liveOverride) {
  const liveRead = new Set(["get_caption_tracks", "get_clip_transcript"]);
  const diagnostic = tool.name === "probe_caption_item";
  const effectiveUxpStatus =
    liveOverride?.uxpStatus ||
    (diagnostic
      ? "diagnostic"
      : liveRead.has(tool.name)
        ? "local-live-verified"
        : "local-unverified");
  const liveVerified = effectiveUxpStatus === "local-live-verified";
  return {
    name: tool.name,
    category: tool.category,
    description: tool.description,
    ...inferAccess(tool.name),
    ...(diagnostic ? { access: "read", risk: "diagnostic" } : {}),
    availability: diagnostic
      ? "diagnostic"
      : liveVerified
        ? "live-verified"
        : "experimental",
    preferredRoute: "uxp",
    requiresDisposableVerification: diagnostic || !liveVerified,
    uxp: {
      status: effectiveUxpStatus,
      registered: uxpEnabled,
      evidence: liveOverride?.evidence
        ? `${tool.declaration} Runtime evidence: ${liveOverride.evidence}.`
        : tool.declaration,
      note: currentLocalNote(tool.name, diagnostic, liveVerified),
    },
    cep: {
      status: "not-applicable",
      registered: false,
    },
    externalFallbacks: [],
    computerUseExcluded: true,
  };
}

function summarize(capabilities) {
  const summary = {
    total: capabilities.length,
    upstream: 0,
    local: 0,
    byAvailability: {},
    byPreferredRoute: {},
    byUxpStatus: {},
    byCepStatus: {},
  };

  for (const capability of capabilities) {
    if (capability.uxp.status.startsWith("local-") || capability.uxp.status === "diagnostic") {
      summary.local += 1;
    } else {
      summary.upstream += 1;
    }
    for (const [target, key] of [
      [summary.byAvailability, capability.availability],
      [summary.byPreferredRoute, capability.preferredRoute || "none"],
      [summary.byUxpStatus, capability.uxp.status],
      [summary.byCepStatus, capability.cep.status],
    ]) {
      target[key] = (target[key] || 0) + 1;
    }
  }

  return summary;
}

async function main() {
  const [
    coverageMarkdown,
    cepMatrixMarkdown,
    upstreamCatalog,
    localCatalog,
    enabledConfig,
    liveOverrides,
  ] = await Promise.all([
    readFile(COVERAGE_PATH, "utf8"),
    readFile(CEP_MATRIX_PATH, "utf8"),
    readJson(UPSTREAM_SCHEMA_PATH),
    readJson(LOCAL_SCHEMA_PATH),
    readJson(ENABLED_PATH),
    readJson(LIVE_OVERRIDES_PATH),
  ]);

  invariant(
    upstreamCatalog.toolCount === upstreamCatalog.tools.length,
    `Upstream toolCount does not match the catalog: ${upstreamCatalog.toolCount} != ${upstreamCatalog.tools.length}.`,
  );
  invariant(
    localCatalog.toolCount === localCatalog.tools.length,
    `Local toolCount does not match the catalog: ${localCatalog.toolCount} != ${localCatalog.tools.length}.`,
  );

  const coverageByName = parseCoverage(coverageMarkdown);
  invariant(
    coverageByName.size === upstreamCatalog.tools.length,
    `Coverage must contain exactly one row per upstream tool: ${coverageByName.size} != ${upstreamCatalog.tools.length}.`,
  );
  const cepStatusByName = parseCepMatrix(cepMatrixMarkdown);
  invariant(
    liveOverrides.schemaVersion === 1 &&
      isPlainObject(liveOverrides.overrides),
    "Invalid live verification overrides.",
  );
  const enabledSet = new Set(enabledConfig.tools || []);
  const upstreamNameSet = new Set(upstreamCatalog.tools.map((tool) => tool.name));

  for (const [name, coverage] of coverageByName) {
    invariant(upstreamNameSet.has(name), `Coverage has unknown upstream tool: ${name}`);
    invariant(
      COVERAGE_STATUSES.has(coverage.status),
      `Unsupported UXP status for ${name}: ${coverage.status}`,
    );
  }

  const upstreamCapabilities = upstreamCatalog.tools.map((tool) => {
    const coverage = coverageByName.get(tool.name);
    invariant(coverage, `Missing coverage row for ${tool.name}`);
    invariant(
      coverage.category === tool.category,
      `Coverage category mismatch for ${tool.name}: ${coverage.category} != ${tool.category}`,
    );
    const cepStatus = cepStatusByName.get(tool.name) || "registered-unverified";
    return buildUpstreamCapability({
      tool,
      coverage,
      cepStatus,
      uxpEnabled: enabledSet.has(tool.name),
      liveOverride: liveOverrides.overrides[tool.name],
    });
  });

  const localCapabilities = localCatalog.tools.map((tool) =>
    buildLocalCapability(
      tool,
      enabledSet.has(tool.name),
      liveOverrides.overrides[tool.name],
    ),
  );
  const capabilities = [...upstreamCapabilities, ...localCapabilities].sort(
    (left, right) => left.name.localeCompare(right.name, "en"),
  );
  const registry = {
    schemaVersion: 1,
    generatedFrom: {
      upstreamSchema: "schemas/upstream-tools.json",
      localSchema: "schemas/local-tools.json",
      uxpCoverage: "docs/premiere/premiere-uxp-tool-coverage.md",
      cepMatrix: "docs/premiere/premiere-mcp-tool-matrix.md",
    },
    policy: {
      codeRoutesOnly: true,
      computerUseExcluded: true,
      implementedHandlersUseBoundedLiveCall: true,
      localUnverifiedUsesDiagnosticProject: true,
      portedCaveatRequiresExperimental: false,
    },
    summary: summarize(capabilities),
    capabilities,
  };

  const serialized = `${JSON.stringify(registry, null, 2)}\n`;
  if (CHECK_ONLY) {
    const existing = await readFile(OUTPUT_PATH, "utf8");
    invariant(
      existing === serialized,
      "capabilities.json is stale. Run npm run premiere:capabilities:build.",
    );
    console.log(`Premiere capability registry is current: ${OUTPUT_PATH}`);
  } else {
    await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(OUTPUT_PATH, serialized, "utf8");
    console.log(`Premiere capability registry: ${OUTPUT_PATH}`);
  }
  console.log(JSON.stringify(registry.summary, null, 2));
}

main().catch((error) => {
  console.error(`Capability registry build failed: ${error.message}`);
  process.exitCode = 1;
});
