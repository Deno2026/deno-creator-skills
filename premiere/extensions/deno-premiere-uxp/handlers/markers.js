const { BridgeError } = require("./errors.js");
const {
  addAction,
  executeUndoableTransaction,
  findSequence,
  findTrackItemByNodeId,
  getActiveProject,
  guidText,
  ppro,
  requireClipProjectItem,
  secondsOf,
  tickTimeFromSeconds
} = require("./shared.js");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknown(args, allowed) {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `지원하지 않는 인자입니다: ${unknown.join(", ")}`
    );
  }
}

function optionalString(value, name) {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new BridgeError("INVALID_ARGUMENTS", `${name}은 문자열이어야 합니다.`);
  }
  return value;
}

function nonNegativeNumber(value, name, fallback) {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `${name}은 0 이상의 유한한 숫자여야 합니다.`
    );
  }
  return candidate;
}

function validateAddMarkerArgs(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, [
    "time_seconds",
    "name",
    "comments",
    "color",
    "duration_seconds",
    "node_id"
  ]);

  if (
    args.color !== undefined &&
    (!Number.isInteger(args.color) || args.color < 0 || args.color > 7)
  ) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "color는 0부터 7까지의 정수여야 합니다."
    );
  }
  if (
    args.node_id !== undefined &&
    (typeof args.node_id !== "string" || args.node_id.trim().length === 0)
  ) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "node_id는 비어 있지 않은 문자열이어야 합니다."
    );
  }

  return {
    time_seconds: nonNegativeNumber(args.time_seconds, "time_seconds"),
    name: optionalString(args.name, "name"),
    comments: optionalString(args.comments, "comments"),
    color: args.color,
    duration_seconds: nonNegativeNumber(
      args.duration_seconds,
      "duration_seconds",
      0
    ),
    node_id: args.node_id === undefined ? undefined : args.node_id.trim()
  };
}

function validateListMarkerArgs(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["node_id"]);
  if (
    args.node_id !== undefined &&
    (typeof args.node_id !== "string" || args.node_id.trim().length === 0)
  ) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "node_id는 비어 있지 않은 문자열이어야 합니다."
    );
  }
  return args.node_id === undefined
    ? {}
    : { node_id: args.node_id.trim() };
}

function validateDeleteMarkerArgs(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["time_seconds", "node_id"]);
  const normalized = {
    time_seconds: nonNegativeNumber(args.time_seconds, "time_seconds")
  };
  if (args.node_id !== undefined) {
    if (typeof args.node_id !== "string" || args.node_id.trim().length === 0) {
      throw new BridgeError("INVALID_ARGUMENTS", "node_id는 비어 있지 않은 문자열이어야 합니다.");
    }
    normalized.node_id = args.node_id.trim();
  }
  return normalized;
}

function validateUpdateMarkerArgs(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, [
    "time_seconds",
    "name",
    "comments",
    "color",
    "new_time_seconds",
    "duration_seconds",
    "marker_type"
  ]);
  if (
    args.color !== undefined &&
    (!Number.isInteger(args.color) || args.color < 0 || args.color > 7)
  ) {
    throw new BridgeError("INVALID_ARGUMENTS", "color는 0부터 7까지의 정수여야 합니다.");
  }
  const allowedMarkerTypes = [
    "comment",
    "chapter",
    "flv_cue_point",
    "web_link"
  ];
  if (
    args.marker_type !== undefined &&
    !allowedMarkerTypes.includes(args.marker_type)
  ) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `marker_type은 다음 중 하나여야 합니다: ${allowedMarkerTypes.join(", ")}`
    );
  }
  return {
    time_seconds: nonNegativeNumber(args.time_seconds, "time_seconds"),
    name: args.name === undefined ? undefined : optionalString(args.name, "name"),
    comments:
      args.comments === undefined
        ? undefined
        : optionalString(args.comments, "comments"),
    color: args.color,
    new_time_seconds:
      args.new_time_seconds === undefined
        ? undefined
        : nonNegativeNumber(args.new_time_seconds, "new_time_seconds"),
    duration_seconds:
      args.duration_seconds === undefined
        ? undefined
        : nonNegativeNumber(args.duration_seconds, "duration_seconds"),
    marker_type: args.marker_type
  };
}

function validateMarkerTypeArgs(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["marker_type", "sequence_id"]);
  const allowed = ["Comment", "Chapter", "Segmentation", "WebLink", "FlashCuePoint"];
  if (!allowed.includes(args.marker_type)) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `marker_type은 다음 중 하나여야 합니다: ${allowed.join(", ")}`
    );
  }
  const normalized = { marker_type: args.marker_type };
  if (args.sequence_id !== undefined) {
    if (
      typeof args.sequence_id !== "string" ||
      args.sequence_id.trim().length === 0
    ) {
      throw new BridgeError("INVALID_ARGUMENTS", "sequence_id는 비어 있지 않은 문자열이어야 합니다.");
    }
    normalized.sequence_id = args.sequence_id.trim();
  }
  return normalized;
}

function validateItemMarkerArgs(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["item_id"]);
  if (typeof args.item_id !== "string" || args.item_id.trim().length === 0) {
    throw new BridgeError("INVALID_ARGUMENTS", "item_id는 비어 있지 않은 문자열이어야 합니다.");
  }
  return { item_id: args.item_id.trim() };
}

function validateAddItemMarkerArgs(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, [
    "item_id",
    "time_seconds",
    "name",
    "comments",
    "duration_seconds",
    "type",
    "color_index"
  ]);
  if (typeof args.item_id !== "string" || args.item_id.trim().length === 0) {
    throw new BridgeError("INVALID_ARGUMENTS", "item_id는 비어 있지 않은 문자열이어야 합니다.");
  }
  const allowedTypes = ["Comment", "Chapter", "Segmentation", "WebLink"];
  const markerType = args.type === undefined ? "Comment" : args.type;
  if (!allowedTypes.includes(markerType)) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `type은 다음 중 하나여야 합니다: ${allowedTypes.join(", ")}`
    );
  }
  if (
    args.color_index !== undefined &&
    (!Number.isInteger(args.color_index) ||
      args.color_index < 0 ||
      args.color_index > 7)
  ) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "color_index는 0부터 7까지의 정수여야 합니다."
    );
  }
  return {
    item_id: args.item_id.trim(),
    time_seconds: nonNegativeNumber(args.time_seconds, "time_seconds"),
    name: optionalString(args.name, "name"),
    comments: optionalString(args.comments, "comments"),
    duration_seconds: nonNegativeNumber(
      args.duration_seconds,
      "duration_seconds",
      0
    ),
    type: markerType,
    color_index: args.color_index
  };
}

async function markerOwner(sequence, nodeId) {
  if (!nodeId) return sequence;

  const match = await findTrackItemByNodeId(sequence, nodeId);
  if (!match) {
    throw new BridgeError("CLIP_NOT_FOUND", `Clip not found: ${nodeId}`);
  }
  try {
    const projectItem = await match.item.getProjectItem();
    const clipProjectItem = ppro().ClipProjectItem.cast(projectItem);
    if (clipProjectItem) return clipProjectItem;
  } catch (_error) {
    // The public marker owner API accepts ClipProjectItem, not TrackItem.
  }
  throw new BridgeError(
    "CLIP_MARKERS_UNAVAILABLE",
    "이 타임라인 항목의 source clip marker를 열 수 없습니다."
  );
}

async function markerCollection(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const owner = await markerOwner(sequence, args.node_id);
  const markers = await ppro().Markers.getMarkers(owner);
  if (!markers) {
    throw new BridgeError("MARKERS_UNAVAILABLE", "Marker collection unavailable");
  }
  let toleranceSeconds = 1e-6;
  try {
    const settings = await sequence.getSettings();
    const frameRate = Number(settings.getVideoFrameRate().value);
    if (Number.isFinite(frameRate) && frameRate > 0) {
      toleranceSeconds = Math.max(toleranceSeconds, 0.5 / frameRate);
    }
  } catch (_error) {
    // Exact seconds remain the fallback when frame-rate metadata is unavailable.
  }
  return { project, markers, toleranceSeconds };
}

function markerRecord(marker) {
  const startSeconds = secondsOf(marker.getStart());
  const durationSeconds = secondsOf(marker.getDuration());
  return {
    id: guidText(marker.guid),
    name: String(marker.getName() || ""),
    comments: String(marker.getComments() || ""),
    startSeconds,
    endSeconds: startSeconds + durationSeconds,
    durationSeconds,
    type: String(marker.getType() || ""),
    colorIndex: Number(marker.getColorIndex()),
    url: String(marker.getUrl() || ""),
    target: String(marker.getTarget() || "")
  };
}

function normalizedMarkerType(value) {
  return String(value || "")
    .replace(/[^a-z0-9]/giu, "")
    .toLocaleLowerCase();
}

function markerTypeValue(markerType) {
  const markerApi = ppro().Marker || {};
  const values = {
    comment: markerApi.MARKER_TYPE_COMMENT || "Comment",
    chapter: markerApi.MARKER_TYPE_CHAPTER || "Chapter",
    flv_cue_point: markerApi.MARKER_TYPE_FLVCUEPOINT || "FLVCuePoint",
    web_link: markerApi.MARKER_TYPE_WEBLINK || "WebLink"
  };
  return values[markerType];
}

function requireMarkerActionApi(owner, methodName) {
  if (!owner || typeof owner[methodName] !== "function") {
    throw new BridgeError(
      "MARKER_ACTION_UNAVAILABLE",
      `Premiere UXP ${methodName} API를 사용할 수 없습니다.`
    );
  }
}

function findMarkerByGuid(markers, markerGuid) {
  return (
    Array.from(markers.getMarkers() || []).find(
      (candidate) => guidText(candidate.guid) === markerGuid
    ) || null
  );
}

function markerAtTime(markers, timeSeconds, toleranceSeconds) {
  const candidates = Array.from(markers.getMarkers() || [])
    .map((marker) => ({
      marker,
      delta: Math.abs(secondsOf(marker.getStart()) - timeSeconds)
    }))
    .filter((entry) => entry.delta <= toleranceSeconds)
    .sort((left, right) => left.delta - right.delta);
  return candidates.length > 0 ? candidates[0].marker : null;
}

async function addMarker(args) {
  // createAddMarkerAction() does not accept a color. The only color API is
  // Marker.createSetColorByIndexAction(), which requires the Marker object that
  // does not exist until the add transaction has committed. Two transactions
  // would violate the required one-step Undo contract, so reject before any
  // mutation instead of silently applying a default color or leaving two Undos.
  if (args.color !== undefined) {
    throw new BridgeError(
      "MARKER_COLOR_NOT_ATOMIC",
      "UXP 26.3에서는 색상 지정 마커를 Ctrl+Z 한 번으로 원자적으로 추가할 수 없습니다."
    );
  }

  const { project, markers } = await markerCollection(args);
  const start = tickTimeFromSeconds(args.time_seconds);
  const duration = tickTimeFromSeconds(args.duration_seconds);
  const markerType =
    (ppro().Marker && ppro().Marker.MARKER_TYPE_COMMENT) || "Comment";

  executeUndoableTransaction(project, "add_marker", (compoundAction) => {
    // executeUndoableTransaction invokes this callback synchronously inside
    // Project.lockedAccess() and Project.executeTransaction().
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- custom transaction wrapper preserves Adobe's lock scope
    const action = markers.createAddMarkerAction(
      args.name,
      markerType,
      start,
      duration,
      args.comments
    );
    addAction(compoundAction, action, "add_marker");
  });

  return {
    added: true,
    timeSeconds: args.time_seconds,
    name: args.name,
    comments: args.comments
  };
}

async function listMarkers(args) {
  const { markers } = await markerCollection(args);
  return Array.from(markers.getMarkers() || []).map(markerRecord);
}

async function deleteMarker(args) {
  const { project, markers, toleranceSeconds } = await markerCollection(args);
  const marker = markerAtTime(markers, args.time_seconds, toleranceSeconds);
  if (!marker) {
    throw new BridgeError("MARKER_NOT_FOUND", `Marker not found at ${args.time_seconds}s`);
  }
  const removedMarker = markerRecord(marker);
  executeUndoableTransaction(project, "delete_marker", (compoundAction) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = markers.createRemoveMarkerAction(marker);
    addAction(compoundAction, action, "delete_marker");
  });
  return { deleted: true, marker: removedMarker, undoable: true };
}

async function updateMarker(args) {
  const { project, markers, toleranceSeconds } = await markerCollection({});
  const marker = markerAtTime(markers, args.time_seconds, toleranceSeconds);
  if (!marker) {
    throw new BridgeError("MARKER_NOT_FOUND", `Marker not found at ${args.time_seconds}s`);
  }
  if (
    args.name === undefined &&
    args.comments === undefined &&
    args.color === undefined &&
    args.new_time_seconds === undefined &&
    args.duration_seconds === undefined &&
    args.marker_type === undefined
  ) {
    throw new BridgeError("INVALID_ARGUMENTS", "변경할 marker 필드가 없습니다.");
  }

  // Adobe 26.3 exposes URL/target getters, but no corresponding setter
  // Actions. Preserve them and include both values in the before/after
  // snapshots instead of claiming an unsupported write capability.
  const before = markerRecord(marker);
  const markerGuid = before.id;
  if (args.name !== undefined) {
    requireMarkerActionApi(marker, "createSetNameAction");
  }
  if (args.comments !== undefined) {
    requireMarkerActionApi(marker, "createSetCommentsAction");
  }
  if (args.color !== undefined) {
    requireMarkerActionApi(marker, "createSetColorByIndexAction");
  }
  if (args.new_time_seconds !== undefined) {
    requireMarkerActionApi(markers, "createMoveMarkerAction");
  }
  if (args.duration_seconds !== undefined) {
    requireMarkerActionApi(marker, "createSetDurationAction");
  }
  if (args.marker_type !== undefined) {
    requireMarkerActionApi(marker, "createSetTypeAction");
  }

  executeUndoableTransaction(project, "update_marker", (compoundAction) => {
    if (args.name !== undefined) {
      addAction(
        compoundAction,
        // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
        marker.createSetNameAction(args.name),
        "update_marker"
      );
    }
    if (args.comments !== undefined) {
      addAction(
        compoundAction,
        // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
        marker.createSetCommentsAction(args.comments),
        "update_marker"
      );
    }
    if (args.color !== undefined) {
      addAction(
        compoundAction,
        // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
        marker.createSetColorByIndexAction(args.color),
        "update_marker"
      );
    }
    if (args.new_time_seconds !== undefined) {
      addAction(
        compoundAction,
        // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
        markers.createMoveMarkerAction(
          marker,
          tickTimeFromSeconds(args.new_time_seconds)
        ),
        "update_marker"
      );
    }
    if (args.duration_seconds !== undefined) {
      addAction(
        compoundAction,
        // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
        marker.createSetDurationAction(
          tickTimeFromSeconds(args.duration_seconds)
        ),
        "update_marker"
      );
    }
    if (args.marker_type !== undefined) {
      addAction(
        compoundAction,
        // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
        marker.createSetTypeAction(markerTypeValue(args.marker_type)),
        "update_marker"
      );
    }
  });

  const updatedMarker = findMarkerByGuid(markers, markerGuid);
  if (!updatedMarker) {
    throw new BridgeError(
      "MARKER_READBACK_FAILED",
      "업데이트한 marker를 GUID로 다시 읽지 못했습니다.",
      { markerGuid }
    );
  }
  const after = markerRecord(updatedMarker);
  const mismatches = [];
  if (args.name !== undefined && after.name !== args.name) {
    mismatches.push("name");
  }
  if (args.comments !== undefined && after.comments !== args.comments) {
    mismatches.push("comments");
  }
  if (args.color !== undefined && after.colorIndex !== args.color) {
    mismatches.push("color");
  }
  if (
    args.new_time_seconds !== undefined &&
    Math.abs(after.startSeconds - args.new_time_seconds) > toleranceSeconds
  ) {
    mismatches.push("new_time_seconds");
  }
  if (
    args.duration_seconds !== undefined &&
    Math.abs(after.durationSeconds - args.duration_seconds) > toleranceSeconds
  ) {
    mismatches.push("duration_seconds");
  }
  if (
    args.marker_type !== undefined &&
    String(after.type).toLocaleLowerCase() !==
      String(markerTypeValue(args.marker_type)).toLocaleLowerCase()
  ) {
    mismatches.push("marker_type");
  }
  if (after.url !== before.url || after.target !== before.target) {
    mismatches.push("url_or_target_preservation");
  }
  if (mismatches.length > 0) {
    throw new BridgeError(
      "MARKER_READBACK_MISMATCH",
      "Marker 업데이트 후 read-back이 요청과 다릅니다.",
      { mismatches, before, after }
    );
  }
  return {
    updated: true,
    markerGuid,
    lookupTimeSeconds: args.time_seconds,
    before,
    after,
    urlTargetWritable: false,
    undoable: true
  };
}

async function getSequenceMarkersByType(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  const markers = await ppro().Markers.getMarkers(sequence);
  // Premiere Pro 26.3.2 can dereference a null pointer when the official
  // getMarkers(filters) overload is used on an empty collection. Read the
  // bounded sequence collection once and apply the same type filter locally.
  const acceptedTypes =
    args.marker_type === "FlashCuePoint"
      ? new Set(["flashcuepoint", "flvcuepoint"])
      : new Set([normalizedMarkerType(args.marker_type)]);
  return Array.from(markers.getMarkers() || [])
    .map(markerRecord)
    .filter((marker) => acceptedTypes.has(normalizedMarkerType(marker.type)));
}

async function getClipMarkers(args) {
  const project = await getActiveProject();
  const item = await requireClipProjectItem(project, args.item_id);
  const markers = await ppro().Markers.getMarkers(item);
  return Array.from(markers.getMarkers() || []).map(markerRecord);
}

async function addMarkerToProjectItem(args) {
  if (args.color_index !== undefined) {
    throw new BridgeError(
      "MARKER_COLOR_NOT_ATOMIC",
      "UXP 26.3에서는 색상 지정 source marker를 Ctrl+Z 한 번으로 원자적으로 추가할 수 없습니다."
    );
  }
  const project = await getActiveProject();
  const item = await requireClipProjectItem(project, args.item_id);
  const markers = await ppro().Markers.getMarkers(item);
  executeUndoableTransaction(project, "add_marker_to_project_item", (compoundAction) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = markers.createAddMarkerAction(
      args.name,
      args.type,
      tickTimeFromSeconds(args.time_seconds),
      tickTimeFromSeconds(args.duration_seconds),
      args.comments
    );
    addAction(compoundAction, action, "add_marker_to_project_item");
  });
  return {
    added: true,
    itemId: args.item_id,
    timeSeconds: args.time_seconds,
    type: args.type,
    undoable: true
  };
}

module.exports = {
  category: "markers",
  handlers: [
    {
      name: "add_marker",
      writes: true,
      validate: validateAddMarkerArgs,
      execute: addMarker
    },
    {
      name: "list_markers",
      writes: false,
      validate: validateListMarkerArgs,
      execute: listMarkers
    },
    {
      name: "delete_marker",
      writes: true,
      dangerous: true,
      validate: validateDeleteMarkerArgs,
      execute: deleteMarker
    },
    {
      name: "update_marker",
      writes: true,
      validate: validateUpdateMarkerArgs,
      execute: updateMarker
    },
    {
      name: "get_sequence_markers_by_type",
      writes: false,
      validate: validateMarkerTypeArgs,
      execute: getSequenceMarkersByType
    },
    {
      name: "get_clip_markers",
      writes: false,
      validate: validateItemMarkerArgs,
      execute: getClipMarkers
    },
    {
      name: "add_marker_to_project_item",
      writes: true,
      validate: validateAddItemMarkerArgs,
      execute: addMarkerToProjectItem
    }
  ]
};
