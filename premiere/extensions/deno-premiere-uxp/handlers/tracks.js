const { BridgeError } = require("./errors.js");
const {
  addAction,
  executeUndoableTransaction,
  findSequence,
  getActiveProject,
  ppro,
  readTrackItemNodeId,
  secondsOf
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

function trackType(value) {
  if (value !== "video" && value !== "audio") {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "track_type은 video 또는 audio여야 합니다."
    );
  }
  return value;
}

function trackIndex(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "track_index는 0 이상의 정수여야 합니다."
    );
  }
  return value;
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

function validateRename(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["track_type", "track_index", "name"]);
  return {
    track_type: trackType(args.track_type),
    track_index: trackIndex(args.track_index),
    name: nonEmptyString(args.name, "name")
  };
}

function validateTrackInfo(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["track_type", "track_index"]);
  return {
    track_type: trackType(args.track_type),
    track_index: trackIndex(args.track_index)
  };
}

function validateVisibility(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["track_index", "visible"]);
  if (typeof args.visible !== "boolean") {
    throw new BridgeError("INVALID_ARGUMENTS", "visible은 boolean이어야 합니다.");
  }
  return { track_index: trackIndex(args.track_index), visible: args.visible };
}

async function getTrack(sequence, type, index) {
  const count =
    type === "video"
      ? await sequence.getVideoTrackCount()
      : await sequence.getAudioTrackCount();
  if (index >= count) {
    throw new BridgeError(
      "TRACK_NOT_FOUND",
      `${type} track ${index} does not exist`
    );
  }
  return type === "video"
    ? sequence.getVideoTrack(index)
    : sequence.getAudioTrack(index);
}

async function renameTrack(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const track = await getTrack(sequence, args.track_type, args.track_index);
  const oldName = String(track.name || "");
  executeUndoableTransaction(project, "rename_track", (compoundAction) => {
    addAction(
      compoundAction,
      // executeUndoableTransaction invokes this callback synchronously inside
      // Project.lockedAccess() and Project.executeTransaction().
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- custom transaction wrapper preserves Adobe's lock scope
      track.createSetNameAction(args.name),
      "rename_track"
    );
  });
  return {
    renamed: true,
    trackType: args.track_type,
    trackIndex: args.track_index,
    oldName,
    name: args.name
  };
}

async function getTrackInfo(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const track = await getTrack(sequence, args.track_type, args.track_index);
  const clipType = ppro().Constants.TrackItemType.CLIP;
  const items = Array.from(
    (await Promise.resolve(track.getTrackItems(clipType, false))) || []
  );
  const clips = [];
  for (let clipIndex = 0; clipIndex < items.length; clipIndex += 1) {
    const item = items[clipIndex];
    const [name, start, end, disabled] = await Promise.all([
      item.getName(),
      item.getStartTime(),
      item.getEndTime(),
      item.isDisabled()
    ]);
    clips.push({
      nodeId: await readTrackItemNodeId(
        item,
        args.track_type,
        args.track_index,
        clipIndex
      ),
      name: String(name || ""),
      startSeconds: secondsOf(start),
      endSeconds: secondsOf(end),
      enabled: !Boolean(disabled)
    });
  }
  return {
    trackType: args.track_type,
    trackIndex: args.track_index,
    id: Number(track.id),
    name: String(track.name || ""),
    muted: Boolean(await track.isMuted()),
    locked: null,
    targeted: null,
    clipCount: clips.length,
    clips,
    caveat: "Official UXP 26.3 exposes no track lock or targeting getter."
  };
}

async function toggleTrackVisibility(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const track = await getTrack(sequence, "video", args.track_index);
  if (!(await track.setMute(!args.visible))) {
    throw new BridgeError(
      "TRACK_VISIBILITY_REJECTED",
      "Premiere가 video track visibility 변경을 거부했습니다."
    );
  }
  return {
    trackIndex: args.track_index,
    visible: args.visible,
    muted: !args.visible,
    undoable: false,
    caveat: "UXP maps video track output visibility through VideoTrack.setMute()."
  };
}

module.exports = {
  category: "tracks",
  handlers: [
    {
      name: "rename_track",
      writes: true,
      validate: validateRename,
      execute: renameTrack
    },
    {
      name: "get_track_info",
      writes: false,
      validate: validateTrackInfo,
      execute: getTrackInfo
    },
    {
      name: "toggle_track_visibility",
      writes: true,
      validate: validateVisibility,
      execute: toggleTrackVisibility
    }
  ]
};
