import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PremiereCepClient } from "../servers/premiere-control-mcp/cep-client.mjs";
import { PremiereUxpBridgeClient } from "../servers/premiere-uxp-mcp/bridge-client.mjs";
import { loadCapabilityRegistry } from "../servers/premiere-uxp-mcp/capability-registry.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const UXP_SERVER_ROOT = path.join(REPO_ROOT, "servers", "premiere-uxp-mcp");
const UPSTREAM_SCHEMA_PATH = path.join(
  UXP_SERVER_ROOT,
  "schemas",
  "upstream-tools.json",
);
const DEFAULT_REPORT_PATH = path.join(
  REPO_ROOT,
  "tmp",
  "premiere-uxp-read-probe",
  "latest.json",
);
const IMMUTABLE_REPORT_ROOT = path.join(REPO_ROOT, "reports");
const EXCLUDED_TOOLS = new Map([
  [
    "capture_frame",
    "Creates and returns a temporary frame file; covered by its dedicated capture test.",
  ],
  [
    "match_frame",
    "Changes Source Monitor state and is not a state-neutral read probe.",
  ],
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isWithin(basePath, targetPath) {
  const relative = path.relative(path.resolve(basePath), path.resolve(targetPath));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function parseArgs(argv) {
  const options = {
    outputPath: DEFAULT_REPORT_PATH,
    promoteImmutable: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--out") {
      const output = argv[++index];
      if (!output) throw new Error("--out requires a path.");
      options.outputPath = path.resolve(output);
    } else if (value === "--promote-immutable") {
      options.promoteImmutable = true;
    } else if (value === "--help" || value === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (!options.help) {
    const targetsPermanentEvidence = isWithin(
      IMMUTABLE_REPORT_ROOT,
      options.outputPath,
    );
    if (targetsPermanentEvidence && !options.promoteImmutable) {
      throw new Error(
        "Refusing to write under reports/ without --promote-immutable. Routine probes belong in tmp/ or another regenerable location.",
      );
    }
    if (options.promoteImmutable && !targetsPermanentEvidence) {
      throw new Error(
        "--promote-immutable requires --out to target this repo's reports/ directory.",
      );
    }
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/probe-premiere-uxp-read-capabilities.mjs [--out <json>]",
    "  node scripts/probe-premiere-uxp-read-capabilities.mjs --out reports/<new-evidence>.json --promote-immutable",
    "",
    `Default output: ${path.relative(REPO_ROOT, DEFAULT_REPORT_PATH)}`,
    "Routine runs may overwrite the regenerable default latest.json.",
    "Permanent reports require --promote-immutable and are created once; existing evidence is never overwritten.",
  ].join("\n");
}

function topLevelShape(value) {
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      itemKeys:
        value.length > 0 && isPlainObject(value[0])
          ? Object.keys(value[0]).sort()
          : [],
    };
  }
  if (isPlainObject(value)) {
    return { type: "object", keys: Object.keys(value).sort() };
  }
  return { type: value === null ? "null" : typeof value };
}

function parseCepResult(result) {
  const image = result.content?.find((part) => part.type === "image");
  if (image) {
    return {
      ok: !result.isError,
      value: {
        image: true,
        mimeType: image.mimeType,
        dataLength: image.data?.length || 0,
      },
    };
  }
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (result.isError) {
    return { ok: false, error: String(text || "CEP tool failed.") };
  }
  if (text === undefined) {
    return { ok: true, value: result };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    const failed =
      text.startsWith("Error:") ||
      text.startsWith("EvalScript Error:") ||
      text.includes("ReferenceError");
    return failed
      ? { ok: false, error: text }
      : { ok: true, value: text };
  }
}

async function timed(operation) {
  const startedAt = Date.now();
  try {
    const value = await operation();
    return { ok: true, durationMs: Date.now() - startedAt, value };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: String(error && (error.message || error)),
    };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const [registry, upstreamCatalog] = await Promise.all([
    loadCapabilityRegistry(UXP_SERVER_ROOT),
    readFile(UPSTREAM_SCHEMA_PATH, "utf8").then(JSON.parse),
  ]);
  const schemaByName = new Map(
    upstreamCatalog.tools.map((tool) => [tool.name, tool]),
  );
  const candidates = registry.registry.capabilities.filter((capability) => {
    const schema = schemaByName.get(capability.name);
    return (
      capability.uxp.status === "ported-caveat" &&
      capability.uxp.registered === true &&
      capability.access === "read" &&
      !schema?.inputSchema?.required?.length &&
      !EXCLUDED_TOOLS.has(capability.name)
    );
  });

  const uxp = new PremiereUxpBridgeClient({ timeoutMs: 10_000 });
  const cep = new PremiereCepClient();
  const results = [];

  try {
    for (const capability of candidates) {
      const uxpAttempt = await timed(() => uxp.call(capability.name, {}));
      const cepAttempt = await timed(async () => {
        const result = await cep.call(capability.name, {});
        const parsed = parseCepResult(result);
        if (!parsed.ok) {
          throw new Error(parsed.error);
        }
        return parsed.value;
      });
      results.push({
        name: capability.name,
        category: capability.category,
        uxp: uxpAttempt.ok
          ? {
              ok: true,
              durationMs: uxpAttempt.durationMs,
              shape: topLevelShape(uxpAttempt.value),
            }
          : {
              ok: false,
              durationMs: uxpAttempt.durationMs,
              error: uxpAttempt.error,
            },
        cep: cepAttempt.ok
          ? {
              ok: true,
              durationMs: cepAttempt.durationMs,
              shape: topLevelShape(cepAttempt.value),
            }
          : {
              ok: false,
              durationMs: cepAttempt.durationMs,
              error: cepAttempt.error,
            },
      });
    }
  } finally {
    await cep.close();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    premise:
      "Read-only, no-required-argument UXP caveat probes against the currently open Premiere project. No tool is promoted automatically.",
    excluded: Object.fromEntries(EXCLUDED_TOOLS),
    candidateCount: candidates.length,
    uxpSuccessCount: results.filter((result) => result.uxp.ok).length,
    cepSuccessCount: results.filter((result) => result.cep.ok).length,
    dualSuccessCount: results.filter(
      (result) => result.uxp.ok && result.cep.ok,
    ).length,
    results,
  };

  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(
    options.outputPath,
    `${JSON.stringify(report, null, 2)}\n`,
    options.promoteImmutable
      ? { encoding: "utf8", flag: "wx" }
      : "utf8",
  );
  console.log(`Premiere UXP read probe report: ${options.outputPath}`);
  console.log(
    JSON.stringify(
      {
        candidateCount: report.candidateCount,
        uxpSuccessCount: report.uxpSuccessCount,
        cepSuccessCount: report.cepSuccessCount,
        dualSuccessCount: report.dualSuccessCount,
        uxpFailures: results
          .filter((result) => !result.uxp.ok)
          .map((result) => result.name),
        cepFailures: results
          .filter((result) => !result.cep.ok)
          .map((result) => result.name),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(`Premiere UXP read probe failed: ${error.message}`);
  process.exitCode = 1;
});
