const { BridgeError } = require("./errors.js");
const {
  findSequence,
  getActiveProject,
  normalizeWindowsPath,
  ppro,
  projectItemId,
  readTrackItemNodeId,
  secondsOf,
  tickTimeFromSeconds,
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

function trackType(value, fallback) {
  const candidate = value === undefined ? fallback : value;
  if (!["video", "audio", "both"].includes(candidate)) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "track_type은 video, audio 또는 both여야 합니다."
    );
  }
  return candidate;
}

function direction(value) {
  const candidate = value === undefined ? "next" : value;
  if (candidate !== "next" && candidate !== "previous") {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "direction은 next 또는 previous여야 합니다."
    );
  }
  return candidate;
}

function optionalIndex(value) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "track_index는 0 이상의 정수여야 합니다."
    );
  }
  return value;
}

function validateTrackType(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["track_type"]);
  return { track_type: trackType(args.track_type, "both") };
}

function validateEditPoint(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["direction", "track_type"]);
  return {
    direction: direction(args.direction),
    track_type: trackType(args.track_type, "both")
  };
}

function validateMoveToEdit(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["direction"]);
  return { direction: direction(args.direction) };
}

function validateMatchFrame(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["track_type", "track_index"]);
  const type = trackType(args.track_type, "video");
  if (type === "both") {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "match_frame의 track_type은 video 또는 audio여야 합니다."
    );
  }
  return {
    track_type: type,
    track_index:
      args.track_index === undefined ? 0 : optionalIndex(args.track_index)
  };
}

async function collectTrackItems(sequence, type, onlyTrackIndex) {
  const descriptors = [];
  const clipType = ppro().Constants.TrackItemType.CLIP;
  const types = type === "both" ? ["video", "audio"] : [type];
  for (const trackTypeName of types) {
    const count =
      trackTypeName === "video"
        ? await sequence.getVideoTrackCount()
        : await sequence.getAudioTrackCount();
    for (let trackIndex = 0; trackIndex < count; trackIndex += 1) {
      if (onlyTrackIndex !== undefined && onlyTrackIndex !== trackIndex) continue;
      const track =
        trackTypeName === "video"
          ? await sequence.getVideoTrack(trackIndex)
          : await sequence.getAudioTrack(trackIndex);
      const items = Array.from(
        (await Promise.resolve(track.getTrackItems(clipType, false))) || []
      );
      for (let clipIndex = 0; clipIndex < items.length; clipIndex += 1) {
        const item = items[clipIndex];
        const [start, end] = await Promise.all([
          item.getStartTime(),
          item.getEndTime()
        ]);
        descriptors.push({
          item,
          trackType: trackTypeName,
          trackIndex,
          clipIndex,
          startSeconds: secondsOf(start),
          endSeconds: secondsOf(end),
          nodeId: await readTrackItemNodeId(
            item,
            trackTypeName,
            trackIndex,
            clipIndex
          )
        });
      }
    }
  }
  return descriptors;
}

async function getPlayheadPosition() {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const position = await sequence.getPlayerPosition();
  const seconds = secondsOf(position);
  return {
    seconds,
    ticks: String(position.ticks),
    positionSeconds: seconds
  };
}

async function getClipAtPlayhead(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const position = secondsOf(await sequence.getPlayerPosition());
  const descriptors = await collectTrackItems(sequence, args.track_type);
  const matches = descriptors.filter(
    (item) => item.startSeconds <= position && position < item.endSeconds
  );
  const clips = [];
  for (const descriptor of matches) {
    clips.push({
      nodeId: descriptor.nodeId,
      name: String((await descriptor.item.getName()) || ""),
      trackType: descriptor.trackType,
      trackIndex: descriptor.trackIndex,
      startSeconds: descriptor.startSeconds,
      endSeconds: descriptor.endSeconds
    });
  }
  return {
    positionSeconds: position,
    clips,
    nodeIdCaveat: "UXP TrackItem IDs are synthetic and may change after timeline edits."
  };
}

async function findEditPoint(sequence, args) {
  const position = secondsOf(await sequence.getPlayerPosition());
  const descriptors = await collectTrackItems(sequence, args.track_type);
  const points = new Set();
  for (const item of descriptors) {
    points.add(item.startSeconds);
    points.add(item.endSeconds);
  }
  const ordered = Array.from(points).sort((left, right) => left - right);
  const epsilon = 1e-7;
  const timeSeconds =
    args.direction === "previous"
      ? ordered.reverse().find((value) => value < position - epsilon)
      : ordered.find((value) => value > position + epsilon);
  if (timeSeconds === undefined) {
    throw new BridgeError(
      "EDIT_POINT_NOT_FOUND",
      `${args.direction} edit point를 찾지 못했습니다.`
    );
  }
  return { position, timeSeconds };
}

async function getNextEditPoint(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const result = await findEditPoint(sequence, args);
  return {
    direction: args.direction,
    trackType: args.track_type,
    fromSeconds: result.position,
    timeSeconds: result.timeSeconds
  };
}

async function movePlayheadToEdit(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const result = await findEditPoint(sequence, {
    direction: args.direction,
    track_type: "both"
  });
  if (!(await sequence.setPlayerPosition(tickTimeFromSeconds(result.timeSeconds)))) {
    throw new BridgeError("PLAYHEAD_MOVE_FAILED", "Playhead move failed");
  }
  return {
    direction: args.direction,
    positionSeconds: result.timeSeconds,
    undoable: false
  };
}

async function matchFrame(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const position = secondsOf(await sequence.getPlayerPosition());
  const descriptors = await collectTrackItems(
    sequence,
    args.track_type,
    args.track_index
  );
  const match = descriptors.find(
    (item) => item.startSeconds <= position && position < item.endSeconds
  );
  if (!match) {
    throw new BridgeError("CLIP_NOT_FOUND", "Playhead 위치에 clip이 없습니다.");
  }
  const [projectItem, inPoint, outPoint, rawSpeed, rawReversed] =
    await Promise.all([
      match.item.getProjectItem(),
      match.item.getInPoint(),
      match.item.getOutPoint(),
      match.item.getSpeed(),
      match.item.isSpeedReversed()
    ]);
  const speedNumber = Number(rawSpeed);
  const speedRate = Number.isFinite(speedNumber)
    ? Math.abs(speedNumber)
    : 1;
  const elapsed = Math.max(0, position - match.startSeconds);
  const reversed = Boolean(Number(rawReversed));
  const sourceTimeSeconds = reversed
    ? secondsOf(outPoint) - elapsed * speedRate
    : secondsOf(inPoint) + elapsed * speedRate;
  let mediaPath = "";
  try {
    const clipItem = ppro().ClipProjectItem.cast(projectItem);
    mediaPath = normalizeWindowsPath(await clipItem.getMediaFilePath());
  } catch (_error) {
    // Sequence/generated items may not have a media path.
  }
  return {
    nodeId: match.nodeId,
    name: String((await match.item.getName()) || ""),
    trackType: match.trackType,
    trackIndex: match.trackIndex,
    projectItemId: await projectItemId(projectItem),
    projectItemName: String(projectItem.name || ""),
    mediaPath,
    playheadSeconds: position,
    sourceTimeSeconds,
    sourceInSeconds: secondsOf(inPoint),
    sourceOutSeconds: secondsOf(outPoint),
    speed: speedNumber,
    reversed,
    caveat: "This reports the matching source frame; UXP has no command that invokes Premiere's Match Frame UI action."
  };
}

module.exports = {
  category: "playhead",
  handlers: [
    {
      name: "get_playhead_position",
      writes: false,
      validate: validateNoArgs,
      execute: getPlayheadPosition
    },
    {
      name: "get_clip_at_playhead",
      writes: false,
      validate: validateTrackType,
      execute: getClipAtPlayhead
    },
    {
      name: "get_next_edit_point",
      writes: false,
      validate: validateEditPoint,
      execute: getNextEditPoint
    },
    {
      name: "move_playhead_to_edit",
      writes: true,
      validate: validateMoveToEdit,
      execute: movePlayheadToEdit
    },
    {
      name: "match_frame",
      writes: false,
      validate: validateMatchFrame,
      execute: matchFrame
    }
  ]
};
