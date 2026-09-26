const { BridgeError } = require("./errors.js");
const {
  findSequence,
  findTrackItemByNodeId,
  getActiveProject,
  ppro,
  readTrackItemNodeId,
  secondsOf,
  validateNoArgs
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

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `${name}은 비어 있지 않은 문자열이어야 합니다.`
    );
  }
  return value.trim();
}

function finiteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BridgeError("INVALID_ARGUMENTS", `${name}은 유한한 숫자여야 합니다.`);
  }
  return value;
}

function optionalTrackType(value) {
  if (value === undefined || value === null || value === "" || value === "both") {
    return undefined;
  }
  if (value !== "video" && value !== "audio") {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "track_type은 video, audio 또는 both여야 합니다."
    );
  }
  return value;
}

function optionalTrackIndex(value) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "track_index는 0 이상의 정수여야 합니다."
    );
  }
  return value;
}

function validateByName(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["name", "track_type", "track_index", "add_to_selection"]);
  if (
    args.add_to_selection !== undefined &&
    typeof args.add_to_selection !== "boolean"
  ) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "add_to_selection은 boolean이어야 합니다."
    );
  }
  return {
    name: nonEmptyString(args.name, "name"),
    track_type: optionalTrackType(args.track_type),
    track_index: optionalTrackIndex(args.track_index),
    add_to_selection: args.add_to_selection === true
  };
}

function validateTrackFilter(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["track_type", "track_index"]);
  return {
    track_type: optionalTrackType(args.track_type),
    track_index: optionalTrackIndex(args.track_index)
  };
}

function validateRange(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, [
    "start_seconds",
    "end_seconds",
    "track_type",
    "track_index"
  ]);
  const start = finiteNumber(args.start_seconds, "start_seconds");
  const end = finiteNumber(args.end_seconds, "end_seconds");
  if (start < 0 || end <= start) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "시간 범위는 0 이상이고 end_seconds가 start_seconds보다 커야 합니다."
    );
  }
  return {
    start_seconds: start,
    end_seconds: end,
    track_type: optionalTrackType(args.track_type),
    track_index: optionalTrackIndex(args.track_index)
  };
}

function validateColor(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["color_index"]);
  if (
    !Number.isInteger(args.color_index) ||
    args.color_index < 0 ||
    args.color_index > 15
  ) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "color_index는 0~15 사이의 정수여야 합니다."
    );
  }
  return { color_index: args.color_index };
}

function validateSetClipSelection(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["node_id", "selected"]);
  if (typeof args.selected !== "boolean") {
    throw new BridgeError("INVALID_ARGUMENTS", "selected는 boolean이어야 합니다.");
  }
  return {
    node_id: nonEmptyString(args.node_id, "node_id"),
    selected: args.selected
  };
}

function createSelection(items) {
  const api = ppro().TrackItemSelection;
  if (!api || typeof api.createEmptySelection !== "function") {
    throw new BridgeError(
      "SELECTION_API_UNAVAILABLE",
      "Premiere UXP TrackItemSelection API를 사용할 수 없습니다."
    );
  }
  let selection = null;
  const created = api.createEmptySelection((value) => {
    selection = value;
  });
  if (!created || !selection) {
    throw new BridgeError("SELECTION_CREATE_FAILED", "선택 객체를 만들 수 없습니다.");
  }
  for (const descriptor of items) {
    if (!selection.addItem(descriptor.item, true)) {
      throw new BridgeError(
        "SELECTION_ADD_FAILED",
        `선택에 추가하지 못한 클립이 있습니다: ${descriptor.nodeId}`
      );
    }
  }
  return selection;
}

async function collectTrackItems(sequence, filter) {
  const descriptors = [];
  const clipType = ppro().Constants.TrackItemType.CLIP;
  const includeVideo = !filter.track_type || filter.track_type === "video";
  const includeAudio = !filter.track_type || filter.track_type === "audio";

  if (includeVideo) {
    const count = await sequence.getVideoTrackCount();
    for (let trackIndex = 0; trackIndex < count; trackIndex += 1) {
      if (filter.track_index !== undefined && filter.track_index !== trackIndex) {
        continue;
      }
      const track = await sequence.getVideoTrack(trackIndex);
      const items = Array.from(
        (await Promise.resolve(track.getTrackItems(clipType, false))) || []
      );
      for (let clipIndex = 0; clipIndex < items.length; clipIndex += 1) {
        const item = items[clipIndex];
        descriptors.push({
          item,
          trackType: "video",
          trackIndex,
          clipIndex,
          nodeId: await readTrackItemNodeId(
            item,
            "video",
            trackIndex,
            clipIndex
          )
        });
      }
    }
  }

  if (includeAudio) {
    const count = await sequence.getAudioTrackCount();
    for (let trackIndex = 0; trackIndex < count; trackIndex += 1) {
      if (filter.track_index !== undefined && filter.track_index !== trackIndex) {
        continue;
      }
      const track = await sequence.getAudioTrack(trackIndex);
      const items = Array.from(
        (await Promise.resolve(track.getTrackItems(clipType, false))) || []
      );
      for (let clipIndex = 0; clipIndex < items.length; clipIndex += 1) {
        const item = items[clipIndex];
        descriptors.push({
          item,
          trackType: "audio",
          trackIndex,
          clipIndex,
          nodeId: await readTrackItemNodeId(
            item,
            "audio",
            trackIndex,
            clipIndex
          )
        });
      }
    }
  }
  return descriptors;
}

async function selectedDescriptors(sequence, descriptors) {
  const selected = [];
  for (const descriptor of descriptors) {
    if (await descriptor.item.getIsSelected()) selected.push(descriptor);
  }
  return selected;
}

function selectionResult(items) {
  return {
    selected: items.map((item) => ({
      nodeId: item.nodeId,
      trackType: item.trackType,
      trackIndex: item.trackIndex
    })),
    selectedCount: items.length,
    undoable: false,
    nodeIdCaveat: "UXP TrackItem IDs are synthetic and may change after timeline edits."
  };
}

function applySelection(sequence, items) {
  const accepted = sequence.setSelection(createSelection(items));
  if (!accepted) {
    throw new BridgeError("SELECTION_REJECTED", "Premiere가 선택 변경을 거부했습니다.");
  }
  return selectionResult(items);
}

async function selectClipsByName(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const all = await collectTrackItems(sequence, args);
  const target = args.name.toLocaleLowerCase();
  const matched = [];
  for (const descriptor of all) {
    const name = String((await descriptor.item.getName()) || "");
    if (name.toLocaleLowerCase().includes(target)) matched.push(descriptor);
  }
  if (args.add_to_selection) {
    const current = await selectedDescriptors(sequence, await collectTrackItems(sequence, {}));
    const byId = new Map(current.map((item) => [item.nodeId, item]));
    for (const item of matched) byId.set(item.nodeId, item);
    return applySelection(sequence, Array.from(byId.values()));
  }
  return applySelection(sequence, matched);
}

async function selectAllClips(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  return applySelection(sequence, await collectTrackItems(sequence, args));
}

async function deselectAllClips() {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const cleared = await sequence.clearSelection();
  if (!cleared) {
    throw new BridgeError("SELECTION_REJECTED", "Premiere가 선택 해제를 거부했습니다.");
  }
  return { selected: [], selectedCount: 0, undoable: false };
}

async function selectClipsInRange(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const all = await collectTrackItems(sequence, args);
  const matched = [];
  for (const descriptor of all) {
    const [start, end] = await Promise.all([
      descriptor.item.getStartTime(),
      descriptor.item.getEndTime()
    ]);
    if (
      secondsOf(start) < args.end_seconds &&
      secondsOf(end) > args.start_seconds
    ) {
      matched.push(descriptor);
    }
  }
  return applySelection(sequence, matched);
}

async function selectClipsByColor(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const all = await collectTrackItems(sequence, {});
  const matched = [];
  for (const descriptor of all) {
    try {
      const projectItem = await descriptor.item.getProjectItem();
      if ((await projectItem.getColorLabelIndex()) === args.color_index) {
        matched.push(descriptor);
      }
    } catch (_error) {
      // Generated clips without a project item cannot match a source color.
    }
  }
  return applySelection(sequence, matched);
}

async function invertSelection() {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const all = await collectTrackItems(sequence, {});
  const inverted = [];
  for (const descriptor of all) {
    if (!(await descriptor.item.getIsSelected())) inverted.push(descriptor);
  }
  return applySelection(sequence, inverted);
}

async function selectDisabledClips() {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const all = await collectTrackItems(sequence, {});
  const disabled = [];
  for (const descriptor of all) {
    if (await descriptor.item.isDisabled()) disabled.push(descriptor);
  }
  return applySelection(sequence, disabled);
}

async function setClipSelection(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await findTrackItemByNodeId(sequence, args.node_id);
  if (!match) {
    throw new BridgeError("CLIP_NOT_FOUND", `Clip not found: ${args.node_id}`);
  }
  const all = await collectTrackItems(sequence, {});
  const next = [];
  for (const descriptor of all) {
    const isTarget = descriptor.nodeId === args.node_id;
    const selected = await descriptor.item.getIsSelected();
    if ((isTarget && args.selected) || (!isTarget && selected)) next.push(descriptor);
  }
  return applySelection(sequence, next);
}

module.exports = {
  category: "selection",
  handlers: [
    {
      name: "select_clips_by_name",
      writes: true,
      validate: validateByName,
      execute: selectClipsByName
    },
    {
      name: "select_all_clips",
      writes: true,
      validate: validateTrackFilter,
      execute: selectAllClips
    },
    {
      name: "deselect_all_clips",
      writes: true,
      validate: validateNoArgs,
      execute: deselectAllClips
    },
    {
      name: "select_clips_in_range",
      writes: true,
      validate: validateRange,
      execute: selectClipsInRange
    },
    {
      name: "select_clips_by_color",
      writes: true,
      validate: validateColor,
      execute: selectClipsByColor
    },
    {
      name: "invert_selection",
      writes: true,
      validate: validateNoArgs,
      execute: invertSelection
    },
    {
      name: "select_disabled_clips",
      writes: true,
      validate: validateNoArgs,
      execute: selectDisabledClips
    },
    {
      name: "set_clip_selection",
      writes: true,
      validate: validateSetClipSelection,
      execute: setClipSelection
    }
  ]
};
