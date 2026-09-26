import { readFile } from "node:fs/promises";
import path from "node:path";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function validateRegistry(registry) {
  if (
    !isPlainObject(registry) ||
    registry.schemaVersion !== 1 ||
    !isPlainObject(registry.summary) ||
    !Array.isArray(registry.capabilities)
  ) {
    throw new Error("Invalid Premiere capability registry.");
  }
  if (registry.summary.total !== registry.capabilities.length) {
    throw new Error(
      `Capability registry count mismatch: ${registry.summary.total} != ${registry.capabilities.length}.`,
    );
  }

  const byName = new Map();
  for (const capability of registry.capabilities) {
    if (
      !isPlainObject(capability) ||
      typeof capability.name !== "string" ||
      !capability.name
    ) {
      throw new Error("Capability registry contains an invalid command.");
    }
    if (byName.has(capability.name)) {
      throw new Error(`Duplicate Premiere capability: ${capability.name}`);
    }
    if (capability.computerUseExcluded !== true) {
      throw new Error(
        `Capability does not exclude Computer Use: ${capability.name}`,
      );
    }
    byName.set(capability.name, capability);
  }

  return byName;
}

export async function loadCapabilityRegistry(baseDirectory) {
  const registryPath = path.join(baseDirectory, "capabilities.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const byName = validateRegistry(registry);

  return {
    registryPath,
    registry,
    byName,
    execute(name, args = {}) {
      if (!isPlainObject(args)) {
        throw new Error("Capability tool arguments must be a JSON object.");
      }
      if (name === "resolve_premiere_tool") {
        const toolName = String(args.tool_name || "").trim();
        if (!toolName) {
          throw new Error("tool_name is required.");
        }
        const capability = byName.get(toolName);
        if (!capability) {
          return {
            found: false,
            toolName,
            codeRoutesOnly: true,
            computerUseExcluded: true,
          };
        }
        return {
          found: true,
          capability,
          codeRoutesOnly: true,
          computerUseExcluded: true,
        };
      }

      if (name === "get_premiere_capabilities") {
        const category = String(args.category || "").trim();
        const availability = String(args.availability || "").trim();
        const preferredRoute = String(args.preferred_route || "").trim();
        const uxpStatus = String(args.uxp_status || "").trim();
        const access = String(args.access || "").trim();
        const officialUxpOnly = args.official_uxp_only === true;
        const liveOnly = args.live_only === true;
        const hasFilter = Boolean(
          category ||
            availability ||
            preferredRoute ||
            uxpStatus ||
            access ||
            officialUxpOnly ||
            liveOnly,
        );
        const includeTools =
          typeof args.include_tools === "boolean"
            ? args.include_tools
            : hasFilter;
        const limit = Math.min(400, positiveInteger(args.limit, 100));
        const matches = registry.capabilities.filter(
          (capability) =>
            (!category || capability.category === category) &&
            (!availability || capability.availability === availability) &&
            (!preferredRoute ||
              String(capability.preferredRoute || "") === preferredRoute) &&
            (!uxpStatus || capability.uxp?.status === uxpStatus) &&
            (!access || capability.access === access) &&
            (!officialUxpOnly ||
              (capability.uxp?.registered === true &&
                !["blocked-uxp", "deferred", "runtime-failed", "diagnostic"].includes(
                  capability.uxp?.status,
                ))) &&
            (!liveOnly ||
              ["live-verified", "live-verified-read-caveat"].includes(
                capability.availability,
              )),
        );

        return {
          schemaVersion: registry.schemaVersion,
          policy: registry.policy,
          summary: registry.summary,
          query: {
            category: category || null,
            availability: availability || null,
            preferredRoute: preferredRoute || null,
            uxpStatus: uxpStatus || null,
            access: access || null,
            officialUxpOnly,
            liveOnly,
            includeTools,
            limit,
          },
          matchCount: matches.length,
          truncated: includeTools && matches.length > limit,
          capabilities: includeTools ? matches.slice(0, limit) : undefined,
        };
      }

      throw new Error(`Unknown server capability tool: ${name}`);
    },
  };
}
