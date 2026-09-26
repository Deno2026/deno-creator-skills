const { BridgeError } = require("./errors.js");
const {
  addAction,
  executeUndoableTransaction,
  findProjectItem,
  findSequence,
  getActiveProject,
  normalizeWindowsPath,
  ppro,
  projectItemId,
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

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `${name}은 비어 있지 않은 문자열이어야 합니다.`
    );
  }
  return value.trim();
}

function optionalNonNegative(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new BridgeError("INVALID_ARGUMENTS", `${name}은 0 이상이어야 합니다.`);
  }
  return value;
}

function trackIndex(value, name) {
  const candidate = value === undefined ? 0 : value;
  if (!Number.isInteger(candidate) || candidate < 0) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `${name}은 0 이상의 정수여야 합니다.`
    );
  }
  return candidate;
}

function validateOpen(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["item_id"]);
  return { item_id: nonEmptyString(args.item_id, "item_id") };
}

const SOURCE_MEDIA_EXTENSIONS = new Set([
  ".3g2",
  ".3gp",
  ".264",
  ".aac",
  ".ac3",
  ".aif",
  ".aiff",
  ".amr",
  ".ari",
  ".asf",
  ".asx",
  ".avi",
  ".avc",
  ".bmp",
  ".bwf",
  ".caf",
  ".dib",
  ".dng",
  ".dpx",
  ".dv",
  ".exr",
  ".f4v",
  ".flc",
  ".fli",
  ".flv",
  ".flac",
  ".gif",
  ".heic",
  ".heif",
  ".j2c",
  ".j2k",
  ".jfif",
  ".jpe",
  ".jp2",
  ".jpeg",
  ".jpg",
  ".m15",
  ".m1a",
  ".m1s",
  ".m1v",
  ".m2a",
  ".m2t",
  ".m2ts",
  ".m2v",
  ".m4a",
  ".m4v",
  ".m75",
  ".mkv",
  ".mod",
  ".mov",
  ".mp2",
  ".mp3",
  ".mp4",
  ".mp4a",
  ".mpa",
  ".mpe",
  ".mpeg",
  ".mpm",
  ".mpg",
  ".mpv",
  ".mts",
  ".mxf",
  ".oga",
  ".ogg",
  ".png",
  ".psd",
  ".qt",
  ".r3d",
  ".rle",
  ".sct",
  ".tga",
  ".tif",
  ".tiff",
  ".tod",
  ".ts",
  ".v210",
  ".vda",
  ".vob",
  ".vst",
  ".wav",
  ".webm",
  ".webp",
  ".wma",
  ".wmv"
]);

function validateOpenFile(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["file_path"]);
  const filePath = normalizeWindowsPath(
    nonEmptyString(args.file_path, "file_path")
  ).replace(/\//g, "\\");
  if (filePath.length > 32767 || filePath.includes("\0")) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "file_path는 NUL이 없는 32767자 이하 Windows 경로여야 합니다."
    );
  }
  const isDriveAbsolute = /^[A-Za-z]:\\[^\\]/.test(filePath);
  const isUncAbsolute = /^\\\\[^\\]+\\[^\\]+\\[^\\]/.test(filePath);
  if (!isDriveAbsolute && !isUncAbsolute) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "file_path는 드라이브 문자 또는 UNC share로 시작하는 절대 Windows 파일 경로여야 합니다."
    );
  }
  const extensionMatch = /\.[^.\\]+$/.exec(filePath);
  const extension = extensionMatch ? extensionMatch[0].toLocaleLowerCase() : "";
  if (!SOURCE_MEDIA_EXTENSIONS.has(extension)) {
    throw new BridgeError(
      "UNSUPPORTED_MEDIA_EXTENSION",
      `Source Monitor 경로에서 허용하지 않는 미디어 확장자입니다: ${extension || "(없음)"}`
    );
  }
  return { file_path: filePath, extension };
}

function validateSourceInOut(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["in_seconds", "out_seconds"]);
  const inSeconds = optionalNonNegative(args.in_seconds, "in_seconds");
  const outSeconds = optionalNonNegative(args.out_seconds, "out_seconds");
  if (inSeconds === undefined && outSeconds === undefined) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "in_seconds 또는 out_seconds 중 하나는 필요합니다."
    );
  }
  return { in_seconds: inSeconds, out_seconds: outSeconds };
}

function validateEdit(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["video_track_index", "audio_track_index"]);
  return {
    video_track_index: trackIndex(args.video_track_index, "video_track_index"),
    audio_track_index: trackIndex(args.audio_track_index, "audio_track_index")
  };
}

function validatePlay(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["speed"]);
  const speed = args.speed === undefined ? 1 : args.speed;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed === 0) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "speed는 0이 아닌 유한한 숫자여야 합니다."
    );
  }
  return { speed };
}

function validatePosition(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["position_seconds"]);
  const positionSeconds = optionalNonNegative(
    args.position_seconds,
    "position_seconds"
  );
  if (positionSeconds === undefined) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "position_seconds가 필요합니다."
    );
  }
  return { position_seconds: positionSeconds };
}

function sourceMonitor() {
  const monitor = ppro().SourceMonitor;
  if (!monitor) {
    throw new BridgeError(
      "SOURCE_MONITOR_UNAVAILABLE",
      "Premiere UXP SourceMonitor API를 사용할 수 없습니다."
    );
  }
  return monitor;
}

async function requireSourceItem() {
  const item = await sourceMonitor().getProjectItem();
  if (!item) {
    throw new BridgeError(
      "NO_SOURCE_MONITOR_ITEM",
      "Source Monitor에 열린 project item이 없습니다."
    );
  }
  return item;
}

async function requireSourceClipItem() {
  const item = await requireSourceItem();
  try {
    const clipItem = ppro().ClipProjectItem.cast(item);
    if (clipItem) return clipItem;
  } catch (_error) {
    // Fall through to a stable bridge error.
  }
  throw new BridgeError(
    "INVALID_PROJECT_ITEM_TYPE",
    "Source Monitor item은 source in/out을 지원하는 clip이 아닙니다."
  );
}

function getEditor(sequence) {
  const editor = ppro().SequenceEditor.getEditor(sequence);
  if (!editor) {
    throw new BridgeError(
      "SEQUENCE_EDITOR_UNAVAILABLE",
      "Premiere UXP SequenceEditor API를 사용할 수 없습니다."
    );
  }
  return editor;
}

async function openInSource(args) {
  const project = await getActiveProject();
  const item = await findProjectItem(project, args.item_id);
  if (!item) {
    throw new BridgeError(
      "PROJECT_ITEM_NOT_FOUND",
      `Project item not found: ${args.item_id}`
    );
  }
  if (!(await sourceMonitor().openProjectItem(item))) {
    throw new BridgeError("SOURCE_OPEN_FAILED", "Source Monitor open failed");
  }
  return {
    opened: true,
    itemId: await projectItemId(item),
    name: String(item.name || ""),
    undoable: false
  };
}

async function openFileInSourceMonitor(args) {
  const monitor = sourceMonitor();
  if (typeof monitor.openFilePath !== "function") {
    throw new BridgeError(
      "SOURCE_FILE_OPEN_UNAVAILABLE",
      "Premiere UXP SourceMonitor.openFilePath API를 사용할 수 없습니다."
    );
  }
  if (!(await monitor.openFilePath(args.file_path))) {
    throw new BridgeError(
      "SOURCE_FILE_OPEN_FAILED",
      "Premiere가 지정한 파일을 Source Monitor에서 열지 못했습니다.",
      { filePath: args.file_path }
    );
  }

  const result = {
    opened: true,
    filePath: args.file_path,
    extension: args.extension,
    hostAccepted: true,
    filesystemPreflight: {
      performed: false,
      reason:
        "plugin-scoped UXP storage cannot stat an arbitrary absolute path without a picker or persisted token"
    },
    undoable: false
  };
  try {
    const position = await monitor.getPosition();
    if (position) {
      result.positionSeconds = secondsOf(position);
      result.positionTicks = String(position.ticks || "");
    }
  } catch (_error) {
    // openFilePath acceptance is authoritative; immediate monitor read-back is best effort.
  }
  try {
    const item = await monitor.getProjectItem();
    if (item) {
      result.itemId = await projectItemId(item);
      result.itemName = String(item.name || "");
    }
  } catch (_error) {
    // A path-opened source is not required to materialize as a project item.
  }
  return result;
}

async function closeSourceMonitor() {
  if (!(await sourceMonitor().closeClip())) {
    throw new BridgeError("SOURCE_CLOSE_FAILED", "Source Monitor close failed");
  }
  return { closed: true, undoable: false };
}

async function closeAllSourceClips() {
  if (!(await sourceMonitor().closeAllClips())) {
    throw new BridgeError("SOURCE_CLOSE_FAILED", "Source Monitor close-all failed");
  }
  return { closedAll: true, undoable: false };
}

async function setSourceInOut(args) {
  const project = await getActiveProject();
  const clipItem = await requireSourceClipItem();
  const mediaType = ppro().Constants.MediaType.ANY;
  const [currentIn, currentOut] = await Promise.all([
    clipItem.getInPoint(mediaType),
    clipItem.getOutPoint(mediaType)
  ]);
  const nextIn =
    args.in_seconds === undefined ? secondsOf(currentIn) : args.in_seconds;
  const nextOut =
    args.out_seconds === undefined ? secondsOf(currentOut) : args.out_seconds;
  if (nextOut <= nextIn) {
    throw new BridgeError(
      "SOURCE_RANGE_INVALID",
      "out_seconds는 in_seconds보다 커야 합니다."
    );
  }
  executeUndoableTransaction(project, "set_source_in_out", (compoundAction) => {
    if (args.in_seconds !== undefined) {
      addAction(
        compoundAction,
        // executeUndoableTransaction invokes this callback synchronously inside
        // Project.lockedAccess() and Project.executeTransaction().
        // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- custom transaction wrapper preserves Adobe's lock scope
        clipItem.createSetInPointAction(tickTimeFromSeconds(nextIn)),
        "set_source_in_out"
      );
    }
    if (args.out_seconds !== undefined) {
      addAction(
        compoundAction,
        // executeUndoableTransaction invokes this callback synchronously inside
        // Project.lockedAccess() and Project.executeTransaction().
        // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- custom transaction wrapper preserves Adobe's lock scope
        clipItem.createSetOutPointAction(tickTimeFromSeconds(nextOut)),
        "set_source_in_out"
      );
    }
  });
  return { inSeconds: nextIn, outSeconds: nextOut };
}

async function editFromSource(args, overwrite) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const item = await requireSourceItem();
  const position = await sequence.getPlayerPosition();
  const editor = getEditor(sequence);
  const commandName = overwrite ? "overwrite_from_source" : "insert_from_source";
  executeUndoableTransaction(project, commandName, (compoundAction) => {
    const action = overwrite
      // executeUndoableTransaction invokes this callback synchronously inside
      // Project.lockedAccess() and Project.executeTransaction().
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- custom transaction wrapper preserves Adobe's lock scope
      ? editor.createOverwriteItemAction(
          item,
          position,
          args.video_track_index,
          args.audio_track_index
        )
      // executeUndoableTransaction invokes this callback synchronously inside
      // Project.lockedAccess() and Project.executeTransaction().
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- custom transaction wrapper preserves Adobe's lock scope
      : editor.createInsertProjectItemAction(
          item,
          position,
          args.video_track_index,
          args.audio_track_index,
          true
        );
    addAction(compoundAction, action, commandName);
  });
  return {
    inserted: !overwrite,
    overwritten: overwrite,
    itemId: await projectItemId(item),
    itemName: String(item.name || ""),
    startSeconds: secondsOf(position),
    videoTrackIndex: args.video_track_index,
    audioTrackIndex: args.audio_track_index
  };
}

async function getSourceMonitorInfo() {
  const monitor = sourceMonitor();
  const item = await monitor.getProjectItem();
  if (!item) return { loaded: false };
  const nodeId = await projectItemId(item);
  const result = {
    loaded: true,
    nodeId,
    itemId: nodeId,
    name: String(item.name || ""),
    positionSeconds: secondsOf(await monitor.getPosition())
  };
  try {
    const clipItem = ppro().ClipProjectItem.cast(item);
    const mediaType = ppro().Constants.MediaType.ANY;
    const [path, inPoint, outPoint, media] = await Promise.all([
      clipItem.getMediaFilePath(),
      clipItem.getInPoint(mediaType),
      clipItem.getOutPoint(mediaType),
      clipItem.getMedia()
    ]);
    result.mediaPath = normalizeWindowsPath(path);
    result.inPoint = secondsOf(inPoint);
    result.outPoint = secondsOf(outPoint);
    result.inSeconds = result.inPoint;
    result.outSeconds = result.outPoint;
    result.durationSeconds = media ? secondsOf(media.duration) : 0;
  } catch (_error) {
    result.mediaPath = "";
  }
  return result;
}

async function playSourceMonitor(args) {
  if (!(await sourceMonitor().play(args.speed))) {
    throw new BridgeError("SOURCE_PLAY_FAILED", "Source Monitor playback failed");
  }
  return { playing: true, speed: args.speed, undoable: false };
}

async function getSourceMonitorPosition() {
  const position = await sourceMonitor().getPosition();
  if (!position) {
    throw new BridgeError("SOURCE_MONITOR_EMPTY", "No clip open in Source Monitor");
  }
  const seconds = secondsOf(position);
  return {
    seconds,
    ticks: String(position.ticks),
    positionSeconds: seconds
  };
}

async function setSourceMonitorPosition(args) {
  const monitor = sourceMonitor();
  await requireSourceItem();
  const requested = tickTimeFromSeconds(args.position_seconds);
  if (!(await monitor.setPosition(requested))) {
    throw new BridgeError(
      "SOURCE_POSITION_SET_FAILED",
      "Source Monitor position 변경이 거부되었습니다."
    );
  }

  const actual = await monitor.getPosition();
  if (!actual) {
    throw new BridgeError(
      "SOURCE_POSITION_READBACK_FAILED",
      "Source Monitor position을 다시 읽을 수 없습니다."
    );
  }
  const requestedTicks = String(requested.ticks);
  const actualTicks = String(actual.ticks);
  if (actualTicks !== requestedTicks) {
    throw new BridgeError(
      "SOURCE_POSITION_READBACK_MISMATCH",
      "Source Monitor position read-back이 요청값과 일치하지 않습니다.",
      {
        requestedPositionSeconds: args.position_seconds,
        requestedTicks,
        actualPositionSeconds: secondsOf(actual),
        actualTicks
      }
    );
  }

  return {
    requestedPositionSeconds: args.position_seconds,
    positionSeconds: secondsOf(actual),
    ticks: actualTicks,
    undoable: false
  };
}

module.exports = {
  category: "source-monitor",
  handlers: [
    {
      name: "open_in_source",
      writes: true,
      validate: validateOpen,
      execute: openInSource
    },
    {
      name: "open_file_in_source_monitor",
      writes: true,
      validate: validateOpenFile,
      execute: openFileInSourceMonitor
    },
    {
      name: "close_source_monitor",
      writes: true,
      dangerous: true,
      validate: validateNoArgs,
      execute: closeSourceMonitor
    },
    {
      name: "close_all_source_clips",
      writes: true,
      dangerous: true,
      validate: validateNoArgs,
      execute: closeAllSourceClips
    },
    {
      name: "set_source_in_out",
      writes: true,
      validate: validateSourceInOut,
      execute: setSourceInOut
    },
    {
      name: "insert_from_source",
      writes: true,
      validate: validateEdit,
      execute(args) {
        return editFromSource(args, false);
      }
    },
    {
      name: "overwrite_from_source",
      writes: true,
      dangerous: true,
      validate: validateEdit,
      execute(args) {
        return editFromSource(args, true);
      }
    },
    {
      name: "get_source_monitor_info",
      writes: false,
      validate: validateNoArgs,
      execute: getSourceMonitorInfo
    },
    {
      name: "play_source_monitor",
      writes: true,
      validate: validatePlay,
      execute: playSourceMonitor
    },
    {
      name: "get_source_monitor_position",
      writes: false,
      validate: validateNoArgs,
      execute: getSourceMonitorPosition
    },
    {
      name: "set_source_monitor_position",
      writes: true,
      validate: validatePosition,
      execute: setSourceMonitorPosition
    }
  ]
};
