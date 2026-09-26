const { BridgeError } = require("./errors.js");

const categories = [
  require("./health.js"),
  require("./official-events.js"),
  require("./official-transcript-project.js"),
  require("./scripting.js"),
  require("./captions.js"),
  require("./project.js"),
  require("./official-project.js"),
  require("./project-items.js"),
  require("./project-lifecycle.js"),
  require("./media.js"),
  require("./metadata.js"),
  require("./discovery.js"),
  require("./inspection.js"),
  require("./timeline.js"),
  require("./timeline-edit.js"),
  require("./selection.js"),
  require("./sequence.js"),
  require("./tracks.js"),
  require("./playhead.js"),
  require("./source-monitor.js"),
  require("./effects.js"),
  require("./keyframes.js"),
  require("./audio.js"),
  require("./transitions.js"),
  require("./markers.js"),
  require("./export.js"),
  require("./mogrt.js")
];

function buildRegistry() {
  const registry = new Map();

  for (const category of categories) {
    for (const handler of category.handlers || []) {
      if (!handler || typeof handler.name !== "string") {
        throw new Error(`잘못된 핸들러 정의: ${category.category || "unknown"}`);
      }
      if (registry.has(handler.name)) {
        throw new Error(`중복 핸들러 이름: ${handler.name}`);
      }
      registry.set(handler.name, {
        ...handler,
        category: category.category
      });
    }
  }

  return registry;
}

const registry = buildRegistry();

function shutdownHandlers() {
  for (const category of categories) {
    if (typeof category.shutdown !== "function") continue;
    try {
      category.shutdown();
    } catch (_error) {
      // Plugin teardown is best-effort; one category must not block the rest.
    }
  }
}

function getHandler(name) {
  const handler = registry.get(name);
  if (!handler) {
    throw new BridgeError("UNKNOWN_COMMAND", `미구현 명령입니다: ${name}`);
  }
  return handler;
}

module.exports = {
  getHandler,
  shutdownHandlers,
  listHandlerNames() {
    return Array.from(registry.keys());
  }
};
