const { host } = require("uxp");
const { BridgeError } = require("./errors.js");

// premierepro 모듈은 로드 시점이 아니라 첫 사용 시점에 요구한다.
// 로드 시점 require가 실패하면 require 사슬을 타고 패널 전체가 조용히 죽고,
// 화면은 HTML 기본값에 머물러 원인이 보이지 않는다(2026-07-22 부검).
// 늦은 요구로 바꾸면 실패해도 해당 명령의 오류 응답으로 표면화된다.
let pproCache = null;
function ppro() {
  if (!pproCache) pproCache = require("premierepro");
  return pproCache;
}

// Keep host reads bounded so large timelines do not monopolize Premiere's UI thread.
const MAX_CONCURRENT_READS = 4;
const TICKS_PER_SECOND = 254016000000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknown(args, allowed) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  const allowedSet = new Set(allowed || []);
  const unknown = Object.keys(args).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `지원하지 않는 인자입니다: ${unknown.join(", ")}`
    );
  }
  return args;
}

function stringArg(value, name, options) {
  const settings = options || {};
  if (value === undefined && settings.optional) return settings.fallback;
  if (typeof value !== "string" || (!settings.allowEmpty && value.trim().length === 0)) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `${name}은 ${settings.allowEmpty ? "문자열" : "비어 있지 않은 문자열"}이어야 합니다.`
    );
  }
  return settings.trim === false ? value : value.trim();
}

function numberArg(value, name, options) {
  const settings = options || {};
  if (value === undefined && settings.optional) return settings.fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BridgeError("INVALID_ARGUMENTS", `${name}은 유한한 숫자여야 합니다.`);
  }
  if (settings.integer && !Number.isInteger(value)) {
    throw new BridgeError("INVALID_ARGUMENTS", `${name}은 정수여야 합니다.`);
  }
  if (settings.min !== undefined && value < settings.min) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `${name}은 ${settings.min} 이상이어야 합니다.`
    );
  }
  if (settings.max !== undefined && value > settings.max) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `${name}은 ${settings.max} 이하여야 합니다.`
    );
  }
  return value;
}

function booleanArg(value, name, options) {
  const settings = options || {};
  if (value === undefined && settings.optional) return settings.fallback;
  if (typeof value !== "boolean") {
    throw new BridgeError("INVALID_ARGUMENTS", `${name}은 boolean이어야 합니다.`);
  }
  return value;
}

function arrayArg(value, name, options) {
  const settings = options || {};
  if (value === undefined && settings.optional) return settings.fallback;
  if (!Array.isArray(value) || (settings.nonEmpty && value.length === 0)) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `${name}은 ${settings.nonEmpty ? "하나 이상의 항목이 든 " : ""}배열이어야 합니다.`
    );
  }
  return value;
}

function enumArg(value, name, allowed, options) {
  const settings = options || {};
  if (value === undefined && settings.optional) return settings.fallback;
  if (!allowed.includes(value)) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `${name}은 다음 중 하나여야 합니다: ${allowed.join(", ")}`
    );
  }
  return value;
}

function validateNoArgs(args) {
  if (!isPlainObject(args) || Object.keys(args).length !== 0) {
    throw new BridgeError("INVALID_ARGUMENTS", "이 명령은 인자를 받지 않습니다.");
  }
  return {};
}

function validateSequenceArgs(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }

  const unknown = Object.keys(args).filter((key) => key !== "sequence_id");
  if (unknown.length > 0) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `지원하지 않는 인자입니다: ${unknown.join(", ")}`
    );
  }

  if (
    args.sequence_id !== undefined &&
    (typeof args.sequence_id !== "string" || args.sequence_id.length === 0)
  ) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "sequence_id는 비어 있지 않은 문자열이어야 합니다."
    );
  }

  return args.sequence_id === undefined
    ? {}
    : { sequence_id: args.sequence_id };
}

function guidText(value) {
  if (value === null || value === undefined) return "";
  try {
    return typeof value === "string" ? value : value.toString();
  } catch (_error) {
    return String(value);
  }
}

function secondsOf(tickTime) {
  if (!tickTime) return 0;
  const seconds = Number(tickTime.seconds);
  return Number.isFinite(seconds) ? seconds : 0;
}

function tickTimeFromSeconds(seconds) {
  const numericSeconds = Number(seconds);
  if (!Number.isFinite(numericSeconds)) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "시간 값은 유한한 숫자여야 합니다."
    );
  }

  return ppro().TickTime.createWithTicks(
    String(Math.round(numericSeconds * TICKS_PER_SECOND))
  );
}

function normalizeWindowsPath(value) {
  const text = String(value || "");
  if (text.startsWith("\\\\?\\UNC\\")) return `\\\\${text.slice(8)}`;
  return text.startsWith("\\\\?\\") ? text.slice(4) : text;
}

async function readValue(target, key) {
  if (!target) return undefined;
  try {
    const candidate = target[key];
    if (typeof candidate === "function") {
      return await Promise.resolve(candidate.call(target));
    }
    return await Promise.resolve(candidate);
  } catch (_error) {
    return undefined;
  }
}

async function projectItemId(projectItem) {
  const id = await readValue(projectItem, "getId");
  return id === undefined || id === null ? "" : String(id);
}

async function findProjectItem(project, selector) {
  const target = String(selector || "").toLocaleLowerCase();
  const root = await project.getRootItem();
  const projectItemStatic = ppro().ProjectItem || {};
  const visited = new Set();

  const pathSegments = String(selector || "")
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (pathSegments.length > 1) {
    if (
      String(root.name || "").toLocaleLowerCase() ===
      pathSegments[0].toLocaleLowerCase()
    ) {
      pathSegments.shift();
    }
    let folder = root;
    let pathMatch = null;
    for (let index = 0; index < pathSegments.length; index += 1) {
      const children = Array.from((await folder.getItems()) || []);
      pathMatch = children.find(
        (item) =>
          String(item.name || "").toLocaleLowerCase() ===
          pathSegments[index].toLocaleLowerCase()
      );
      if (!pathMatch) break;
      if (index < pathSegments.length - 1) {
        const type = await readValue(pathMatch, "type");
        if (
          type !== projectItemStatic.TYPE_BIN &&
          type !== projectItemStatic.TYPE_ROOT
        ) {
          pathMatch = null;
          break;
        }
        try {
          folder = ppro().FolderItem.cast(pathMatch);
        } catch (_error) {
          pathMatch = null;
          break;
        }
        if (!folder) {
          pathMatch = null;
          break;
        }
      }
    }
    if (pathMatch) return pathMatch;
  }

  async function visit(folder) {
    const children = await folder.getItems();
    for (const item of Array.from(children || [])) {
      const id = await projectItemId(item);
      const visitKey = id ? `id:${id}` : item;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);

      if (
        id.toLocaleLowerCase() === target ||
        String(item.name || "").toLocaleLowerCase() === target
      ) {
        return item;
      }

      const type = await readValue(item, "type");
      if (
        type !== projectItemStatic.TYPE_BIN &&
        type !== projectItemStatic.TYPE_ROOT
      ) {
        continue;
      }

      try {
        const childFolder = ppro().FolderItem.cast(item);
        if (childFolder) {
          const match = await visit(childFolder);
          if (match) return match;
        }
      } catch (_error) {
        // A stale or virtual bin is skipped; the remaining project tree is valid.
      }
    }
    return null;
  }

  return visit(root);
}

async function requireProjectItem(project, selector, label) {
  const item = await findProjectItem(project, selector);
  if (!item) {
    throw new BridgeError(
      "PROJECT_ITEM_NOT_FOUND",
      `${label || "Project item"} not found: ${selector}`
    );
  }
  return item;
}

async function requireClipProjectItem(project, selector) {
  const item = await requireProjectItem(project, selector);
  let clipItem = null;
  try {
    clipItem = ppro().ClipProjectItem.cast(item);
  } catch (_error) {
    clipItem = null;
  }
  if (!clipItem) {
    throw new BridgeError(
      "NOT_A_CLIP_PROJECT_ITEM",
      `Clip project item required: ${selector}`
    );
  }
  return clipItem;
}

async function collectProjectItems(project, options) {
  const settings = options || {};
  const root = settings.root || (await project.getRootItem());
  const result = [];
  const visited = new Set();
  const itemTypes = ppro().ProjectItem || {};

  async function visit(folder, pathParts) {
    const children = Array.from((await folder.getItems()) || []);
    for (const item of children) {
      const id = await projectItemId(item);
      const visitKey = id ? `id:${id}` : item;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);

      const name = String(item.name || "");
      const type = await readValue(item, "type");
      const isFolder = type === itemTypes.TYPE_BIN || type === itemTypes.TYPE_ROOT;
      const entry = {
        item,
        id,
        name,
        type,
        path: [...pathParts, name].filter(Boolean).join("/")
      };
      result.push(entry);

      if (isFolder) {
        try {
          const childFolder = ppro().FolderItem.cast(item);
          if (childFolder) await visit(childFolder, [...pathParts, name]);
        } catch (_error) {
          // Stale and virtual bins are skipped without hiding their own entry.
        }
      }
    }
  }

  await visit(root, []);
  return result;
}

async function getPremiereVersion() {
  const candidates = [
    await readValue(ppro().Application, "version"),
    await readValue(host, "version")
  ];

  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && String(candidate)) {
      return String(candidate);
    }
  }

  return "";
}

function parseBuildFromVersion(version) {
  const text = String(version || "");
  const buildMatch = /\bbuild\s+(\d+)\b/i.exec(text);
  if (buildMatch) return buildMatch[1];

  const dottedMatch = /^\d+\.\d+\.\d+\.(\d+)$/.exec(text.trim());
  return dottedMatch ? dottedMatch[1] : null;
}

async function getPremiereBuildNumber(version) {
  // Premiere UXP 26.3 exposes only Application.version in premierepro.d.ts.
  // A build can be recovered only when Adobe includes it in that version text.
  return parseBuildFromVersion(version);
}

async function mapWithConcurrency(items, limit, mapper) {
  const values = Array.from(items || []);
  const results = new Array(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }

  const workerCount = Math.min(
    Math.max(1, limit),
    Math.max(1, values.length)
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function getActiveProject() {
  const project = await ppro().Project.getActiveProject();
  if (!project) {
    throw new BridgeError("NO_PROJECT", "No project is open");
  }
  return project;
}

async function findSequence(project, sequenceId) {
  if (!sequenceId) {
    const active = await project.getActiveSequence();
    if (!active) {
      throw new BridgeError("NO_ACTIVE_SEQUENCE", "No active sequence");
    }
    return active;
  }

  const sequences = await project.getSequences();
  const target = String(sequenceId).toLowerCase();
  for (const sequence of Array.from(sequences || [])) {
    if (
      String(sequence.name) === sequenceId ||
      guidText(sequence.guid).toLowerCase() === target
    ) {
      return sequence;
    }
  }

  throw new BridgeError("SEQUENCE_NOT_FOUND", "Sequence not found");
}

async function readTrackItemNodeId(item, trackType, trackIndex, clipIndex) {
  const directKeys = ["nodeId", "nodeID", "id"];
  for (const key of directKeys) {
    const value = await readValue(item, key);
    if (value !== undefined && value !== null && String(value)) {
      return String(value);
    }
  }

  const methodNames = ["getNodeId", "getNodeID", "getId"];
  for (const methodName of methodNames) {
    const value = await readValue(item, methodName);
    if (value !== undefined && value !== null && String(value)) {
      return String(value);
    }
  }

  let projectItemId = "";
  let startTicks = "";
  try {
    const projectItem = await item.getProjectItem();
    if (projectItem && typeof projectItem.getId === "function") {
      projectItemId = String((await projectItem.getId()) || "");
    }
  } catch (_error) {
    // Generated timeline items may not have a project item.
  }
  try {
    const start = await item.getStartTime();
    startTicks = start && start.ticks ? String(start.ticks) : "";
  } catch (_error) {
    // The index fallback below still keeps the response shape stable.
  }

  return ["uxp", trackType, trackIndex, clipIndex, projectItemId, startTicks].join(
    ":"
  );
}

async function findTrackItemByNodeId(sequence, nodeId) {
  const target = String(nodeId || "");
  const trackItemType = ppro().Constants.TrackItemType.CLIP;
  const videoTrackCount = await sequence.getVideoTrackCount();

  for (let trackIndex = 0; trackIndex < videoTrackCount; trackIndex += 1) {
    const track = await sequence.getVideoTrack(trackIndex);
    const items = Array.from(
      (await Promise.resolve(track.getTrackItems(trackItemType, false))) || []
    );
    for (let clipIndex = 0; clipIndex < items.length; clipIndex += 1) {
      const item = items[clipIndex];
      const resolvedNodeId = await readTrackItemNodeId(
        item,
        "video",
        trackIndex,
        clipIndex
      );
      if (resolvedNodeId === target) {
        return {
          item,
          nodeId: resolvedNodeId,
          trackType: "video",
          trackIndex,
          clipIndex
        };
      }
    }
  }

  const audioTrackCount = await sequence.getAudioTrackCount();
  for (let trackIndex = 0; trackIndex < audioTrackCount; trackIndex += 1) {
    const track = await sequence.getAudioTrack(trackIndex);
    const items = Array.from(
      (await Promise.resolve(track.getTrackItems(trackItemType, false))) || []
    );
    for (let clipIndex = 0; clipIndex < items.length; clipIndex += 1) {
      const item = items[clipIndex];
      const resolvedNodeId = await readTrackItemNodeId(
        item,
        "audio",
        trackIndex,
        clipIndex
      );
      if (resolvedNodeId === target) {
        return {
          item,
          nodeId: resolvedNodeId,
          trackType: "audio",
          trackIndex,
          clipIndex
        };
      }
    }
  }

  return null;
}

async function collectTrackItems(sequence, options) {
  const settings = options || {};
  const requested = settings.trackType || "both";
  const trackItemType = ppro().Constants.TrackItemType.CLIP;
  const result = [];

  async function collectKind(kind) {
    const count =
      kind === "video"
        ? await sequence.getVideoTrackCount()
        : await sequence.getAudioTrackCount();
    for (let trackIndex = 0; trackIndex < count; trackIndex += 1) {
      if (
        settings.trackIndex !== undefined &&
        settings.trackIndex !== null &&
        trackIndex !== settings.trackIndex
      ) {
        continue;
      }
      const track =
        kind === "video"
          ? await sequence.getVideoTrack(trackIndex)
          : await sequence.getAudioTrack(trackIndex);
      const items = Array.from(
        (await Promise.resolve(track.getTrackItems(trackItemType, false))) || []
      );
      for (let clipIndex = 0; clipIndex < items.length; clipIndex += 1) {
        const item = items[clipIndex];
        // Premiere can expose a transient null slot while a heavily fragmented
        // track collection settles after an undoable ripple mutation. It is not
        // a clip and must not abort an otherwise valid selected-item operation.
        if (!item) continue;
        result.push({
          item,
          nodeId: await readTrackItemNodeId(
            item,
            kind,
            trackIndex,
            clipIndex
          ),
          track,
          trackType: kind,
          trackIndex,
          clipIndex
        });
      }
    }
  }

  if (requested === "video" || requested === "both") await collectKind("video");
  if (requested === "audio" || requested === "both") await collectKind("audio");
  return result;
}

async function requireTrackItem(sequence, nodeId) {
  const match = await findTrackItemByNodeId(sequence, nodeId);
  if (!match) {
    throw new BridgeError("CLIP_NOT_FOUND", `Clip not found: ${nodeId}`);
  }
  return match;
}

const DISPLAY_NAME_GROUPS = [
  ["motion", "모션", "ae.adbe motion"],
  ["opacity", "불투명도", "ae.adbe opacity"],
  ["position", "위치"],
  ["scale", "비율 조정"],
  ["rotation", "회전"],
  ["anchor point", "anchor", "기준점"],
  ["volume", "볼륨"],
  ["level", "레벨"],
  ["pan", "panner", "팬", "균형"],
  ["blend mode", "혼합 모드"],
  ["uniform scale", "균일 비율 조정"],
  ["scale width", "가로 비율 조정"],
  ["scale height", "세로 비율 조정"],
  ["anti-flicker filter", "깜박임 제거 필터"],
  ["anti-alias", "앤티 앨리어스", "안티 앨리어스"]
];

function normalizedDisplayName(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s_.:-]+/g, " ");
}

function displayNamesMatch(left, right) {
  const a = normalizedDisplayName(left);
  const b = normalizedDisplayName(right);
  if (a === b) return true;
  return DISPLAY_NAME_GROUPS.some((group) => {
    const normalized = group.map(normalizedDisplayName);
    return normalized.includes(a) && normalized.includes(b);
  });
}

async function componentInfo(component) {
  const [displayName, matchName] = await Promise.all([
    readValue(component, "getDisplayName"),
    readValue(component, "getMatchName")
  ]);
  return {
    component,
    displayName: String(displayName || ""),
    matchName: String(matchName || "")
  };
}

async function listComponents(trackItem) {
  const chain = await trackItem.getComponentChain();
  if (!chain) return { chain: null, components: [] };
  const count = Number(chain.getComponentCount());
  const components = [];
  for (let index = 0; index < count; index += 1) {
    const info = await componentInfo(chain.getComponentAtIndex(index));
    components.push({ ...info, index });
  }
  return { chain, components };
}

async function requireComponent(trackItem, selector) {
  const listed = await listComponents(trackItem);
  const match = listed.components.find(
    (entry) =>
      displayNamesMatch(entry.displayName, selector) ||
      displayNamesMatch(entry.matchName, selector)
  );
  if (!match) {
    throw new BridgeError("EFFECT_NOT_FOUND", `Effect not found: ${selector}`);
  }
  return { ...match, chain: listed.chain };
}

async function listParams(component) {
  const count = Number(component.getParamCount());
  const params = [];
  for (let index = 0; index < count; index += 1) {
    const param = component.getParam(index);
    const displayName = await readValue(param, "displayName");
    params.push({ param, index, displayName: String(displayName || "") });
  }
  return params;
}

async function requireParam(component, selector) {
  const params = await listParams(component);
  const match = params.find((entry) =>
    displayNamesMatch(entry.displayName, selector)
  );
  if (!match) {
    throw new BridgeError(
      "PROPERTY_NOT_FOUND",
      `Effect property not found: ${selector}`
    );
  }
  return match;
}

function serializeComponentValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (
    value.value &&
    typeof value.value === "object" &&
    Object.prototype.hasOwnProperty.call(value.value, "value")
  ) {
    return serializeComponentValue(value.value.value);
  }
  if (Object.prototype.hasOwnProperty.call(value, "value")) {
    const nested = value.value;
    if (typeof nested !== "object" || nested === null) return nested;
  }
  if (
    typeof value.x === "number" &&
    typeof value.y === "number"
  ) {
    return { x: value.x, y: value.y };
  }
  if (
    typeof value.red === "number" &&
    typeof value.green === "number" &&
    typeof value.blue === "number"
  ) {
    return {
      red: value.red,
      green: value.green,
      blue: value.blue,
      alpha: typeof value.alpha === "number" ? value.alpha : 1
    };
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return String(value);
  }
}

function componentInputValue(value, kind) {
  if (kind === "point") {
    if (!isPlainObject(value)) {
      throw new BridgeError("INVALID_ARGUMENTS", "점 값은 {x, y}여야 합니다.");
    }
    return new (ppro().PointF)(
      numberArg(value.x, "x"),
      numberArg(value.y, "y")
    );
  }
  if (kind === "color") {
    if (!isPlainObject(value)) {
      throw new BridgeError(
        "INVALID_ARGUMENTS",
        "색상 값은 {red, green, blue, alpha}여야 합니다."
      );
    }
    return new (ppro().Color)(
      numberArg(value.red, "red", { min: 0, max: 1 }),
      numberArg(value.green, "green", { min: 0, max: 1 }),
      numberArg(value.blue, "blue", { min: 0, max: 1 }),
      numberArg(value.alpha, "alpha", { min: 0, max: 1 })
    );
  }
  return value;
}

function createSetParamValueAction(param, value, kind) {
  if (param.isTimeVarying()) {
    throw new BridgeError(
      "TIME_VARYING_PROPERTY",
      "이 property에는 keyframe이 활성화되어 있습니다. 정적 값 쓰기 대신 add_keyframe 또는 기존 keyframe 편집을 사용해야 합니다."
    );
  }
  const input = componentInputValue(value, kind);
  const keyframe = param.createKeyframe(input);
  // Contract: callers invoke this helper synchronously from
  // executeUndoableTransaction(), whose callback runs inside both
  // Project.lockedAccess() and Project.executeTransaction(). The Adobe lint
  // rule cannot follow that wrapper across this helper boundary.
  // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- guarded by the synchronous executeUndoableTransaction callback contract above
  return param.createSetValueAction(keyframe, true);
}

function executeUndoableTransaction(project, commandName, addActions) {
  if (
    !project ||
    typeof project.lockedAccess !== "function" ||
    typeof project.executeTransaction !== "function"
  ) {
    throw new BridgeError(
      "TRANSACTION_API_UNAVAILABLE",
      "Premiere UXP transaction API를 사용할 수 없습니다."
    );
  }

  let transactionAccepted = false;
  let transactionError = null;
  try {
    project.lockedAccess(() => {
      try {
        transactionAccepted = project.executeTransaction((compoundAction) => {
          addActions(compoundAction);
        }, `DENO: ${commandName}`);
      } catch (error) {
        transactionError = error;
      }
    });
  } catch (error) {
    transactionError = transactionError || error;
  }

  if (transactionError) throw transactionError;
  if (!transactionAccepted) {
    throw new BridgeError(
      "TRANSACTION_REJECTED",
      `Premiere가 DENO: ${commandName} transaction을 거부했습니다.`
    );
  }
}

function addAction(compoundAction, action, commandName) {
  if (!action || !compoundAction || typeof compoundAction.addAction !== "function") {
    throw new BridgeError(
      "ACTION_API_UNAVAILABLE",
      `${commandName} action을 만들 수 없습니다.`
    );
  }
  // Contract: this helper is called synchronously only by callbacks passed to
  // executeUndoableTransaction(), so the CompoundAction never escapes the
  // Project.executeTransaction() callback that created it.
  // eslint-disable-next-line @adobe/premierepro/require-execute-transaction -- guarded by the synchronous executeUndoableTransaction callback contract above
  if (!compoundAction.addAction(action)) {
    throw new BridgeError(
      "ACTION_REJECTED",
      `${commandName} action을 transaction에 추가하지 못했습니다.`
    );
  }
}

function createTrackItemSelection(item) {
  const selectionApi = ppro().TrackItemSelection;
  if (!selectionApi || typeof selectionApi.createEmptySelection !== "function") {
    throw new BridgeError(
      "SELECTION_API_UNAVAILABLE",
      "Premiere UXP TrackItemSelection API를 사용할 수 없습니다."
    );
  }

  let selection = null;
  const created = selectionApi.createEmptySelection((value) => {
    selection = value;
  });
  if (!created || !selection || typeof selection.addItem !== "function") {
    throw new BridgeError(
      "SELECTION_CREATE_FAILED",
      "타임라인 항목 선택을 만들 수 없습니다."
    );
  }
  // Although skipDuplicateCheck is optional in premierepro.d.ts, the 26.3
  // native binding returns false when the second argument is omitted.
  if (!selection.addItem(item, false)) {
    throw new BridgeError(
      "SELECTION_ADD_FAILED",
      "타임라인 항목을 삭제 선택에 추가하지 못했습니다."
    );
  }
  return selection;
}

async function getSequenceBasicInfo(sequence) {
  const endTime = await sequence.getEndTime();
  return {
    name: sequence.name,
    id: guidText(sequence.guid),
    duration: secondsOf(endTime)
  };
}

async function countSequenceClips(sequence, videoTrackCount, audioTrackCount) {
  let total = 0;

  for (let index = 0; index < videoTrackCount; index += 1) {
    const track = await sequence.getVideoTrack(index);
    total += Array.from(
      track.getTrackItems(ppro().Constants.TrackItemType.CLIP, false) || []
    ).length;
  }

  for (let index = 0; index < audioTrackCount; index += 1) {
    const track = await sequence.getAudioTrack(index);
    total += Array.from(
      track.getTrackItems(ppro().Constants.TrackItemType.CLIP, false) || []
    ).length;
  }

  return total;
}

async function readVideoClip(item, index, trackIndex) {
  const [name, start, end, duration, inPoint, outPoint, disabled, speed] =
    await Promise.all([
      item.getName(),
      item.getStartTime(),
      item.getEndTime(),
      item.getDuration(),
      item.getInPoint(),
      item.getOutPoint(),
      readValue(item, "isDisabled"),
      readValue(item, "getSpeed")
    ]);

  const result = {
    index,
    nodeId: await readTrackItemNodeId(item, "video", trackIndex, index),
    name,
    startSeconds: secondsOf(start),
    endSeconds: secondsOf(end),
    durationSeconds: secondsOf(duration),
    inPointSeconds: secondsOf(inPoint),
    outPointSeconds: secondsOf(outPoint),
    mediaType: "Video",
    enabled: disabled === undefined ? true : !Boolean(disabled)
  };

  if (speed !== undefined) result.speed = speed;
  return result;
}

async function readAudioClip(item, index, trackIndex) {
  const [name, start, end, duration, inPoint, outPoint] = await Promise.all([
    item.getName(),
    item.getStartTime(),
    item.getEndTime(),
    item.getDuration(),
    item.getInPoint(),
    item.getOutPoint()
  ]);

  return {
    index,
    nodeId: await readTrackItemNodeId(item, "audio", trackIndex, index),
    name,
    startSeconds: secondsOf(start),
    endSeconds: secondsOf(end),
    durationSeconds: secondsOf(duration),
    inPointSeconds: secondsOf(inPoint),
    outPointSeconds: secondsOf(outPoint),
    mediaType: "Audio"
  };
}

async function readVideoTrack(sequence, trackIndex) {
  const track = await sequence.getVideoTrack(trackIndex);
  const items = Array.from(
    track.getTrackItems(ppro().Constants.TrackItemType.CLIP, false) || []
  );
  const [clips, isMuted] = await Promise.all([
    mapWithConcurrency(items, MAX_CONCURRENT_READS, (item, index) =>
      readVideoClip(item, index, trackIndex)
    ),
    track.isMuted()
  ]);

  return {
    index: trackIndex,
    name: track.name,
    clipCount: clips.length,
    clips,
    isMuted,
    // Premiere 26.3's public UXP API exposes no track lock getter.
    isLocked: null
  };
}

async function readAudioTrack(sequence, trackIndex) {
  const track = await sequence.getAudioTrack(trackIndex);
  const items = Array.from(
    track.getTrackItems(ppro().Constants.TrackItemType.CLIP, false) || []
  );
  const [clips, isMuted] = await Promise.all([
    mapWithConcurrency(items, MAX_CONCURRENT_READS, (item, index) =>
      readAudioClip(item, index, trackIndex)
    ),
    track.isMuted()
  ]);

  return {
    index: trackIndex,
    name: track.name,
    clipCount: clips.length,
    clips,
    isMuted,
    // Premiere 26.3's public UXP API exposes no track lock getter.
    isLocked: null
  };
}

module.exports = {
  MAX_CONCURRENT_READS,
  TICKS_PER_SECOND,
  addAction,
  arrayArg,
  booleanArg,
  collectProjectItems,
  collectTrackItems,
  componentInputValue,
  createSetParamValueAction,
  countSequenceClips,
  createTrackItemSelection,
  displayNamesMatch,
  enumArg,
  executeUndoableTransaction,
  findSequence,
  findProjectItem,
  findTrackItemByNodeId,
  getActiveProject,
  getPremiereBuildNumber,
  getPremiereVersion,
  getSequenceBasicInfo,
  guidText,
  isPlainObject,
  listComponents,
  listParams,
  mapWithConcurrency,
  normalizeWindowsPath,
  normalizedDisplayName,
  numberArg,
  ppro,
  projectItemId,
  rejectUnknown,
  requireClipProjectItem,
  requireComponent,
  requireParam,
  requireProjectItem,
  requireTrackItem,
  readValue,
  readAudioTrack,
  readTrackItemNodeId,
  readVideoTrack,
  secondsOf,
  serializeComponentValue,
  stringArg,
  tickTimeFromSeconds,
  validateNoArgs,
  validateSequenceArgs
};
