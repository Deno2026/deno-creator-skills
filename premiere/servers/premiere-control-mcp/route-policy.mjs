const LIVE_UXP_STATUSES = new Set([
  "ported",
  "local-live-verified",
  "live-read-caveat",
]);
const LIVE_CEP_STATUSES = new Set(["live-verified"]);
const HARD_BLOCKED_STATUSES = new Set(["runtime-failed"]);

function normalizeRequestedRoute(value) {
  const route = String(value || "auto").trim().toLowerCase();
  if (!["auto", "uxp", "cep"].includes(route)) {
    throw new Error(`Unsupported route override: ${route}`);
  }
  return route;
}

function automaticRoute(capability) {
  const preferred = capability.preferredRoute;
  if (preferred === "uxp" || preferred === "uxp-test-first") {
    return "uxp";
  }
  if (preferred === "cep" || preferred === "cep-test-first") {
    return "cep";
  }
  if (preferred) {
    return "external";
  }
  return null;
}

export function resolveCodeRoute(
  capability,
  { requestedRoute = "auto", allowExperimental = false } = {},
) {
  if (!capability) {
    throw new Error("Capability metadata is required.");
  }
  const normalizedRoute = normalizeRequestedRoute(requestedRoute);
  const route =
    normalizedRoute === "auto" ? automaticRoute(capability) : normalizedRoute;

  if (route === "external") {
    return {
      route,
      executable: false,
      experimental: false,
      status: capability.availability,
      reason: "The available code fallback is outside the Premiere MCP bridge.",
      fallbacks: capability.externalFallbacks || [],
    };
  }
  if (!route) {
    return {
      route: null,
      executable: false,
      experimental: false,
      status: capability.availability,
      reason: "No code route is registered for this command.",
      fallbacks: capability.externalFallbacks || [],
    };
  }

  const routeMetadata = capability[route];
  if (!routeMetadata?.registered) {
    return {
      route,
      executable: false,
      experimental: false,
      status: routeMetadata?.status || "unavailable",
      reason: `${route.toUpperCase()} does not register this command.`,
      fallbacks: capability.externalFallbacks || [],
    };
  }

  if (HARD_BLOCKED_STATUSES.has(routeMetadata.status)) {
    return {
      route,
      executable: false,
      experimental: false,
      status: routeMetadata.status,
      reason:
        `${route.toUpperCase()} route is blocked because its current runtime is known to fail. ` +
        "A new verified implementation or explicit capability evidence is required before execution.",
      fallbacks: capability.externalFallbacks || [],
    };
  }

  const live =
    route === "uxp"
      ? LIVE_UXP_STATUSES.has(routeMetadata.status)
      : LIVE_CEP_STATUSES.has(routeMetadata.status);
  const experimental = !live;
  if (experimental && !allowExperimental) {
    return {
      route,
      executable: false,
      experimental: true,
      status: routeMetadata.status,
      reason:
        `${route.toUpperCase()} route is ${routeMetadata.status}, not live-verified. ` +
        "Use --allow-experimental only with a disposable project and bounded verification.",
      fallbacks: capability.externalFallbacks || [],
    };
  }

  return {
    route,
    executable: true,
    experimental,
    status: routeMetadata.status,
    reason: live ? "Live-verified code route." : "Experimental code route explicitly enabled.",
    fallbacks: capability.externalFallbacks || [],
  };
}

export function checkCapabilityPermission(
  capability,
  { allowWrite = false, allowDangerous = false } = {},
) {
  if (capability.access !== "write") {
    return { allowed: true };
  }
  if (capability.risk === "dangerous" && !allowDangerous) {
    return {
      allowed: false,
      reason:
        `Dangerous Premiere command '${capability.name}' is blocked. ` +
        "Explicit user approval and both --allow-write --allow-dangerous are required.",
    };
  }
  if (!allowWrite) {
    return {
      allowed: false,
      reason:
        `Premiere write command '${capability.name}' is blocked. ` +
        "Explicit user approval and --allow-write are required.",
    };
  }
  return { allowed: true };
}
