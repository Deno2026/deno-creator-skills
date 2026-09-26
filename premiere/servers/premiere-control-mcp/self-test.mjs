import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCapabilityRegistry } from "../premiere-uxp-mcp/capability-registry.mjs";
import { loadToolCatalog } from "../premiere-uxp-mcp/tool-catalog.mjs";
import {
  checkCapabilityPermission,
  resolveCodeRoute,
} from "./route-policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UXP_SERVER_ROOT = path.resolve(HERE, "..", "premiere-uxp-mcp");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const [catalog, registry] = await Promise.all([
  loadToolCatalog(UXP_SERVER_ROOT),
  loadCapabilityRegistry(UXP_SERVER_ROOT),
]);

assert(
  catalog.allTools.length === catalog.totalToolCount,
  "Unified tool catalog count does not match its generated catalogs.",
);
assert(
  new Set(catalog.allTools.map((tool) => tool.name)).size ===
    catalog.totalToolCount,
  "Unified tool catalog contains duplicate names.",
);

const marker = registry.byName.get("add_marker");
const markerRoute = resolveCodeRoute(marker);
assert(
  markerRoute.executable && markerRoute.route === "uxp" && !markerRoute.experimental,
  "add_marker should use verified UXP.",
);
assert(
  !checkCapabilityPermission(marker).allowed &&
    checkCapabilityPermission(marker, { allowWrite: true }).allowed,
  "add_marker write gate is inconsistent.",
);

const effect = registry.byName.get("set_effect_property");
const effectRoute = resolveCodeRoute(effect);
assert(
  effectRoute.executable && effectRoute.route === "uxp" && !effectRoute.experimental,
  "set_effect_property should prefer live-verified UXP.",
);

const autoReframe = registry.byName.get("auto_reframe_sequence");
const blockedAutoReframe = resolveCodeRoute(autoReframe);
const enabledAutoReframe = resolveCodeRoute(autoReframe, {
  allowExperimental: true,
});
assert(
  !blockedAutoReframe.executable &&
    blockedAutoReframe.route === "cep" &&
    enabledAutoReframe.executable &&
    enabledAutoReframe.experimental,
  "auto_reframe_sequence experimental CEP route is inconsistent.",
);

const text = registry.byName.get("add_text_overlay");
const textRoute = resolveCodeRoute(text);
assert(
  !textRoute.executable &&
    textRoute.route === "external" &&
    textRoute.fallbacks?.[0]?.route === "remotion-alpha-mov",
  "add_text_overlay should report the code-only Remotion fallback.",
);

const capture = registry.byName.get("capture_frame");
assert(
  capture.access === "read" &&
    capture.risk === "read-only-temporary-capture" &&
    resolveCodeRoute(capture).route === "uxp" &&
    checkCapabilityPermission(capture).allowed,
  "capture_frame should use the live-verified UXP sequence-frame route.",
);

const removeTransition = registry.byName.get("remove_transition");
const removeTransitionRoute = resolveCodeRoute(removeTransition);
assert(
    removeTransitionRoute.executable &&
    removeTransitionRoute.route === "uxp" &&
    !removeTransitionRoute.experimental &&
    removeTransition.risk === "write" &&
    removeTransition.description.includes("end-edge") &&
    removeTransition.uxp?.note?.includes("position=end only") &&
    checkCapabilityPermission(removeTransition, { allowWrite: true }).allowed,
  "remove_transition should use the bounded live-verified UXP write route.",
);

const captionTiming = registry.byName.get("get_caption_tracks");
assert(
  resolveCodeRoute(captionTiming).route === "uxp" &&
    captionTiming.access === "read" &&
    captionTiming.description.includes("text: null") &&
    captionTiming.uxp?.note?.includes("text:null"),
  "get_caption_tracks must advertise timing metadata without caption-text availability.",
);

for (const toolName of [
  "subscribe_premiere_events",
  "unsubscribe_premiere_events",
]) {
  const eventOperation = registry.byName.get(toolName);
  assert(
    eventOperation?.access === "read" &&
      eventOperation.risk === "read-only-operational" &&
      checkCapabilityPermission(eventOperation).allowed,
    `${toolName} should be a non-project-mutating read/operational command.`,
  );
}

const undo = registry.byName.get("undo");
const undoAutoRoute = resolveCodeRoute(undo, { allowExperimental: true });
const undoCepRoute = resolveCodeRoute(undo, {
  requestedRoute: "cep",
  allowExperimental: true,
});
assert(
  !undoAutoRoute.executable &&
    undoAutoRoute.route === null &&
    undoAutoRoute.status === "unavailable" &&
    !undoCepRoute.executable &&
    undoCepRoute.route === "cep" &&
    undoCepRoute.status === "runtime-failed" &&
    !undoCepRoute.experimental,
  "Known-broken undo must stay unavailable even with --allow-experimental.",
);

const unknown = registry.execute("resolve_premiere_tool", {
  tool_name: "not_a_premiere_tool",
});
assert(unknown.found === false, "Unknown capability resolution failed.");

console.log("Unified Premiere control route self-test passed.");
