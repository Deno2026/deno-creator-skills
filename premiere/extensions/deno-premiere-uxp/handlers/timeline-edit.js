const { BridgeError } = require("./errors.js");
const {
  addAction,
  collectTrackItems,
  createTrackItemSelection,
  executeUndoableTransaction,
  findProjectItem,
  findSequence,
  findTrackItemByNodeId,
  getActiveProject,
  ppro,
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

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `${name}은 비어 있지 않은 문자열이어야 합니다.`
    );
  }
  return value.trim();
}

function finiteNumber(value, name, fallback) {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    throw new BridgeError("INVALID_ARGUMENTS", `${name}은 유한한 숫자여야 합니다.`);
  }
  return candidate;
}

function nonNegativeNumber(value, name, fallback) {
  const candidate = finiteNumber(value, name, fallback);
  if (candidate < 0) {
    throw new BridgeError("INVALID_ARGUMENTS", `${name}은 0 이상이어야 합니다.`);
  }
  return candidate;
}

function optionalIndex(value, name, fallback) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isInteger(candidate) || candidate < 0) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `${name}은 0 이상의 정수여야 합니다.`
    );
  }
  return candidate;
}

function validateNodeOnly(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["node_id"]);
  return { node_id: nonEmptyString(args.node_id, "node_id") };
}

function validateSlip(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["node_id", "offset_seconds"]);
  return {
    node_id: nonEmptyString(args.node_id, "node_id"),
    offset_seconds: finiteNumber(args.offset_seconds, "offset_seconds")
  };
}

function validateRename(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["node_id", "new_name"]);
  return {
    node_id: nonEmptyString(args.node_id, "node_id"),
    new_name: nonEmptyString(args.new_name, "new_name")
  };
}

function validateTrim(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["node_id", "new_in_seconds", "new_out_seconds"]);
  if (args.new_in_seconds === undefined && args.new_out_seconds === undefined) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "new_in_seconds 또는 new_out_seconds 중 하나는 필요합니다."
    );
  }
  const result = { node_id: nonEmptyString(args.node_id, "node_id") };
  if (args.new_in_seconds !== undefined) {
    result.new_in_seconds = nonNegativeNumber(
      args.new_in_seconds,
      "new_in_seconds"
    );
  }
  if (args.new_out_seconds !== undefined) {
    result.new_out_seconds = nonNegativeNumber(
      args.new_out_seconds,
      "new_out_seconds"
    );
  }
  return result;
}

function validateEnabled(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["node_id", "enabled"]);
  if (typeof args.enabled !== "boolean") {
    throw new BridgeError("INVALID_ARGUMENTS", "enabled는 boolean이어야 합니다.");
  }
  return {
    node_id: nonEmptyString(args.node_id, "node_id"),
    enabled: args.enabled
  };
}

function validateOverwrite(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, [
    "item_id",
    "start_seconds",
    "track_index",
    "audio_track_index"
  ]);
  const result = {
    item_id: nonEmptyString(args.item_id, "item_id"),
    start_seconds: nonNegativeNumber(args.start_seconds, "start_seconds", 0),
    track_index: optionalIndex(args.track_index, "track_index", 0),
    audio_track_index: optionalIndex(
      args.audio_track_index,
      "audio_track_index",
      0
    )
  };
  return result;
}

function validateMoveClip(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["node_id", "new_start_seconds"]);
  return {
    node_id: nonEmptyString(args.node_id, "node_id"),
    new_start_seconds: nonNegativeNumber(
      args.new_start_seconds,
      "new_start_seconds"
    )
  };
}

function validateRemoveSelected(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["ripple"]);
  if (args.ripple !== undefined && typeof args.ripple !== "boolean") {
    throw new BridgeError("INVALID_ARGUMENTS", "ripple은 boolean이어야 합니다.");
  }
  return { ripple: args.ripple === true };
}

function validateBatchEnableDisable(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["enabled", "target", "track_type", "track_index"]);
  if (typeof args.enabled !== "boolean") {
    throw new BridgeError("INVALID_ARGUMENTS", "enabled는 boolean이어야 합니다.");
  }
  if (!["selected", "track", "all"].includes(args.target)) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "target은 selected, track, all 중 하나여야 합니다."
    );
  }
  if (args.target === "track") {
    if (!["video", "audio"].includes(args.track_type)) {
      throw new BridgeError(
        "INVALID_ARGUMENTS",
        "target=track일 때 track_type은 video 또는 audio여야 합니다."
      );
    }
    if (!Number.isInteger(args.track_index) || args.track_index < 0) {
      throw new BridgeError(
        "INVALID_ARGUMENTS",
        "target=track일 때 track_index는 0 이상의 정수여야 합니다."
      );
    }
  } else if (args.track_type !== undefined || args.track_index !== undefined) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "track_type과 track_index는 target=track일 때만 사용할 수 있습니다."
    );
  }
  return {
    enabled: args.enabled,
    target: args.target,
    track_type: args.target === "track" ? args.track_type : undefined,
    track_index: args.target === "track" ? args.track_index : undefined
  };
}

function validateBatchRename(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, [
    "pattern",
    "track_type",
    "track_index",
    "selected_only",
    "start_number"
  ]);
  if (!["video", "audio"].includes(args.track_type)) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "track_type은 video 또는 audio여야 합니다."
    );
  }
  const trackIndex = optionalIndex(args.track_index, "track_index");
  if (
    args.selected_only !== undefined &&
    typeof args.selected_only !== "boolean"
  ) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "selected_only는 boolean이어야 합니다."
    );
  }
  const startNumber =
    args.start_number === undefined ? 1 : args.start_number;
  if (!Number.isInteger(startNumber) || startNumber < 0) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "start_number는 0 이상의 정수여야 합니다."
    );
  }
  return {
    pattern: nonEmptyString(args.pattern, "pattern"),
    track_type: args.track_type,
    track_index: trackIndex,
    selected_only: args.selected_only === true,
    start_number: startNumber
  };
}

function ensureBoundedTargets(items, commandName) {
  if (items.length === 0) {
    throw new BridgeError(
      "NO_TARGETS",
      `${commandName} 대상 클립이 없습니다.`
    );
  }
  if (items.length > 20) {
    throw new BridgeError(
      "TARGET_LIMIT_EXCEEDED",
      `${commandName}은 한 번에 최대 20개 클립만 처리합니다.`
    );
  }
}

function requireItemMethod(descriptor, methodName, commandName) {
  if (!descriptor.item || typeof descriptor.item[methodName] !== "function") {
    throw new BridgeError(
      "ACTION_API_UNAVAILABLE",
      `${commandName} 대상에 ${methodName}()이 없습니다: ${descriptor.nodeId}`
    );
  }
}

async function ensureTrackExists(sequence, trackType, trackIndex) {
  const count =
    trackType === "video"
      ? await sequence.getVideoTrackCount()
      : await sequence.getAudioTrackCount();
  if (trackIndex >= count) {
    throw new BridgeError(
      "TRACK_NOT_FOUND",
      `${trackType} track ${trackIndex}이 존재하지 않습니다.`
    );
  }
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

async function requireTrackItem(sequence, nodeId) {
  const match = await findTrackItemByNodeId(sequence, nodeId);
  if (!match) {
    throw new BridgeError("CLIP_NOT_FOUND", `Clip not found: ${nodeId}`);
  }
  return match;
}

function mediaTypeFor(match) {
  return match.trackType === "video"
    ? ppro().Constants.MediaType.VIDEO
    : ppro().Constants.MediaType.AUDIO;
}

async function rippleDelete(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await requireTrackItem(sequence, args.node_id);
  const selection = createTrackItemSelection(match.item);
  const editor = getEditor(sequence);
  const clipName = await match.item.getName();
  executeUndoableTransaction(project, "ripple_delete", (compoundAction) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = editor.createRemoveItemsAction(
      selection,
      true,
      mediaTypeFor(match),
      true
    );
    addAction(compoundAction, action, "ripple_delete");
  });
  return { removed: true, ripple: true, clipName: String(clipName || "") };
}

async function slipEdit(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await requireTrackItem(sequence, args.node_id);
  const [inPoint, outPoint] = await Promise.all([
    match.item.getInPoint(),
    match.item.getOutPoint()
  ]);
  const nextIn = secondsOf(inPoint) + args.offset_seconds;
  const nextOut = secondsOf(outPoint) + args.offset_seconds;
  if (nextIn < 0 || nextOut <= nextIn) {
    throw new BridgeError(
      "SOURCE_RANGE_INVALID",
      "Slip 결과가 유효한 source in/out 범위를 벗어납니다."
    );
  }

  try {
    const projectItem = await match.item.getProjectItem();
    const clipItem = ppro().ClipProjectItem.cast(projectItem);
    const media = clipItem ? await clipItem.getMedia() : null;
    const mediaDuration = media ? await Promise.resolve(media.duration) : null;
    const duration = secondsOf(mediaDuration);
    if (duration > 0 && nextOut > duration + 1e-6) {
      throw new BridgeError(
        "SOURCE_RANGE_INVALID",
        "Slip 결과가 source media duration을 벗어납니다."
      );
    }
  } catch (error) {
    if (error && error.name === "BridgeError" && error.code) throw error;
    // Generated items can lack a ClipProjectItem. Premiere validates handles.
  }

  executeUndoableTransaction(project, "slip_edit", (compoundAction) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const inAction = match.item.createSetInPointAction(tickTimeFromSeconds(nextIn));
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const outAction = match.item.createSetOutPointAction(tickTimeFromSeconds(nextOut));
    addAction(compoundAction, inAction, "slip_edit");
    addAction(compoundAction, outAction, "slip_edit");
  });
  return {
    slipped: true,
    nodeId: args.node_id,
    inPointSeconds: nextIn,
    outPointSeconds: nextOut
  };
}

async function renameClip(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await requireTrackItem(sequence, args.node_id);
  const oldName = await match.item.getName();
  executeUndoableTransaction(project, "rename_clip", (compoundAction) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = match.item.createSetNameAction(args.new_name);
    addAction(compoundAction, action, "rename_clip");
  });
  return { renamed: true, oldName: String(oldName || ""), name: args.new_name };
}

async function trimClip(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await requireTrackItem(sequence, args.node_id);
  const [currentIn, currentOut] = await Promise.all([
    match.item.getInPoint(),
    match.item.getOutPoint()
  ]);
  const nextIn =
    args.new_in_seconds === undefined
      ? secondsOf(currentIn)
      : args.new_in_seconds;
  const nextOut =
    args.new_out_seconds === undefined
      ? secondsOf(currentOut)
      : args.new_out_seconds;
  if (nextOut <= nextIn) {
    throw new BridgeError(
      "SOURCE_RANGE_INVALID",
      "new_out_seconds는 new_in_seconds보다 커야 합니다."
    );
  }
  executeUndoableTransaction(project, "trim_clip", (compoundAction) => {
    if (args.new_in_seconds !== undefined) {
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
      const action = match.item.createSetInPointAction(tickTimeFromSeconds(nextIn));
      addAction(compoundAction, action, "trim_clip");
    }
    if (args.new_out_seconds !== undefined) {
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
      const action = match.item.createSetOutPointAction(tickTimeFromSeconds(nextOut));
      addAction(compoundAction, action, "trim_clip");
    }
  });
  return {
    trimmed: true,
    nodeId: args.node_id,
    inPointSeconds: nextIn,
    outPointSeconds: nextOut
  };
}

async function duplicateClip(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await requireTrackItem(sequence, args.node_id);
  const targetTrackIndex = match.trackIndex + 1;
  const trackCount =
    match.trackType === "video"
      ? await sequence.getVideoTrackCount()
      : await sequence.getAudioTrackCount();
  if (targetTrackIndex >= trackCount) {
    throw new BridgeError(
      "NO_DESTINATION_TRACK",
      "다음 트랙이 없습니다. 공식 UXP API로 새 트랙을 만들 수 없어 복제를 중단했습니다."
    );
  }
  const editor = getEditor(sequence);
  const zero = tickTimeFromSeconds(0);
  const videoOffset = match.trackType === "video" ? 1 : 0;
  const audioOffset = match.trackType === "audio" ? 1 : 0;
  executeUndoableTransaction(project, "duplicate_clip", (compoundAction) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = editor.createCloneTrackItemAction(
      match.item,
      zero,
      videoOffset,
      audioOffset,
      true,
      false
    );
    addAction(compoundAction, action, "duplicate_clip");
  });
  return {
    duplicated: true,
    sourceNodeId: args.node_id,
    trackType: match.trackType,
    targetTrackIndex,
    nodeIdCaveat: "The duplicated UXP TrackItem receives a synthetic ID after readback."
  };
}

async function enableDisableClip(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await requireTrackItem(sequence, args.node_id);
  executeUndoableTransaction(project, "enable_disable_clip", (compoundAction) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = match.item.createSetDisabledAction(!args.enabled);
    addAction(compoundAction, action, "enable_disable_clip");
  });
  return { nodeId: args.node_id, enabled: args.enabled };
}

async function overwriteClip(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const item = await findProjectItem(project, args.item_id);
  if (!item) {
    throw new BridgeError(
      "PROJECT_ITEM_NOT_FOUND",
      `Project item not found: ${args.item_id}`
    );
  }
  const startSeconds = args.start_seconds;
  const editor = getEditor(sequence);
  executeUndoableTransaction(project, "overwrite_clip", (compoundAction) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = editor.createOverwriteItemAction(
      item,
      tickTimeFromSeconds(startSeconds),
      args.track_index,
      args.audio_track_index
    );
    addAction(compoundAction, action, "overwrite_clip");
  });
  return {
    overwritten: true,
    item: String(item.name || ""),
    startSeconds,
    videoTrackIndex: args.track_index,
    audioTrackIndex: args.audio_track_index
  };
}

async function removeCurrentSelection(commandName, ripple) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const selection = await sequence.getSelection();
  const items = selection ? Array.from(await selection.getTrackItems()) : [];
  if (items.length === 0) {
    throw new BridgeError(
      "SELECTION_REQUIRED",
      `${commandName}은 현재 선택된 전체 클립만 지원합니다. sequence in/out 부분 삭제는 공식 UXP API로 구현할 수 없습니다.`
    );
  }
  const editor = getEditor(sequence);
  executeUndoableTransaction(project, commandName, (compoundAction) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = editor.createRemoveItemsAction(
      selection,
      ripple,
      ppro().Constants.MediaType.ANY,
      ripple
    );
    addAction(compoundAction, action, commandName);
  });
  return {
    removed: items.length,
    ripple,
    scope: "selected-track-items"
  };
}

async function moveClip(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await requireTrackItem(sequence, args.node_id);
  requireItemMethod(match, "createMoveAction", "move_clip");
  const previousStartSeconds = secondsOf(await match.item.getStartTime());
  const offsetSeconds = args.new_start_seconds - previousStartSeconds;
  const summary = {
    nodeId: match.nodeId,
    trackType: match.trackType,
    trackIndex: match.trackIndex,
    previousStartSeconds,
    startSeconds: args.new_start_seconds,
    offsetSeconds
  };

  executeUndoableTransaction(project, "move_clip", (compoundAction) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = match.item.createMoveAction(tickTimeFromSeconds(offsetSeconds));
    addAction(compoundAction, action, "move_clip");
  });

  return { moved: true, count: 1, items: [summary], undoable: true };
}

function addSelectionItems(selection, descriptors, commandName) {
  for (let index = 1; index < descriptors.length; index += 1) {
    if (!selection.addItem(descriptors[index].item, false)) {
      throw new BridgeError(
        "SELECTION_ADD_FAILED",
        `${commandName} 선택에 추가하지 못했습니다: ${descriptors[index].nodeId}`
      );
    }
  }
  return selection;
}

async function removeSelectedClips(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const all = await collectTrackItems(sequence, {});
  const selected = [];
  for (const descriptor of all) {
    if (await descriptor.item.getIsSelected()) selected.push(descriptor);
  }
  ensureBoundedTargets(selected, "remove_selected_clips");
  const editor = getEditor(sequence);
  if (typeof editor.createRemoveItemsAction !== "function") {
    throw new BridgeError(
      "ACTION_API_UNAVAILABLE",
      "SequenceEditor.createRemoveItemsAction()을 사용할 수 없습니다."
    );
  }
  const items = [];
  for (const descriptor of selected) {
    items.push({
      nodeId: descriptor.nodeId,
      name: String((await descriptor.item.getName()) || ""),
      trackType: descriptor.trackType,
      trackIndex: descriptor.trackIndex
    });
  }

  executeUndoableTransaction(project, "remove_selected_clips", (compoundAction) => {
    const selection = addSelectionItems(
      createTrackItemSelection(selected[0].item),
      selected,
      "remove_selected_clips"
    );
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = editor.createRemoveItemsAction(
      selection,
      args.ripple,
      ppro().Constants.MediaType.ANY,
      args.ripple
    );
    addAction(compoundAction, action, "remove_selected_clips");
  });

  return {
    removed: true,
    ripple: args.ripple,
    count: items.length,
    items,
    undoable: true
  };
}

async function batchTargets(sequence, args) {
  if (args.target === "track") {
    await ensureTrackExists(sequence, args.track_type, args.track_index);
  }
  let descriptors = await collectTrackItems(
    sequence,
    args.target === "track"
      ? { trackType: args.track_type, trackIndex: args.track_index }
      : {}
  );
  if (args.target === "selected") {
    const selected = [];
    for (const descriptor of descriptors) {
      if (await descriptor.item.getIsSelected()) selected.push(descriptor);
    }
    descriptors = selected;
  }
  return descriptors;
}

async function batchEnableDisable(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const descriptors = await batchTargets(sequence, args);
  ensureBoundedTargets(descriptors, "batch_enable_disable");
  const items = [];
  for (const descriptor of descriptors) {
    requireItemMethod(descriptor, "createSetDisabledAction", "batch_enable_disable");
    items.push({
      nodeId: descriptor.nodeId,
      name: String((await descriptor.item.getName()) || ""),
      trackType: descriptor.trackType,
      trackIndex: descriptor.trackIndex,
      enabled: args.enabled
    });
  }

  executeUndoableTransaction(project, "batch_enable_disable", (compoundAction) => {
    for (const descriptor of descriptors) {
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
      const action = descriptor.item.createSetDisabledAction(!args.enabled);
      addAction(compoundAction, action, "batch_enable_disable");
    }
  });

  return {
    updated: true,
    target: args.target,
    count: items.length,
    items,
    undoable: true
  };
}

async function batchRenameClips(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  await ensureTrackExists(sequence, args.track_type, args.track_index);
  let descriptors = await collectTrackItems(sequence, {
    trackType: args.track_type,
    trackIndex: args.track_index
  });
  if (args.selected_only) {
    const selected = [];
    for (const descriptor of descriptors) {
      if (await descriptor.item.getIsSelected()) selected.push(descriptor);
    }
    descriptors = selected;
  }
  ensureBoundedTargets(descriptors, "batch_rename_clips");

  const prepared = [];
  for (const descriptor of descriptors) {
    requireItemMethod(descriptor, "createSetNameAction", "batch_rename_clips");
    prepared.push({
      descriptor,
      previousName: String((await descriptor.item.getName()) || ""),
      startSeconds: secondsOf(await descriptor.item.getStartTime())
    });
  }
  prepared.sort(
    (left, right) =>
      left.startSeconds - right.startSeconds ||
      left.descriptor.clipIndex - right.descriptor.clipIndex ||
      left.descriptor.nodeId.localeCompare(right.descriptor.nodeId)
  );
  const items = prepared.map((entry, index) => {
    const number = args.start_number + index;
    const name = args.pattern
      .replace(/\{n\}/g, String(number))
      .replace(/\{name\}/g, entry.previousName);
    if (name.length === 0) {
      throw new BridgeError(
        "INVALID_ARGUMENTS",
        `pattern이 빈 클립 이름을 만들었습니다: ${entry.descriptor.nodeId}`
      );
    }
    return {
      nodeId: entry.descriptor.nodeId,
      trackType: entry.descriptor.trackType,
      trackIndex: entry.descriptor.trackIndex,
      clipIndex: entry.descriptor.clipIndex,
      startSeconds: entry.startSeconds,
      previousName: entry.previousName,
      name
    };
  });

  executeUndoableTransaction(project, "batch_rename_clips", (compoundAction) => {
    for (let index = 0; index < prepared.length; index += 1) {
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
      const action = prepared[index].descriptor.item.createSetNameAction(
        items[index].name
      );
      addAction(compoundAction, action, "batch_rename_clips");
    }
  });

  return {
    renamed: true,
    selectedOnly: args.selected_only,
    count: items.length,
    items,
    undoable: true
  };
}

module.exports = {
  category: "timeline-edit",
  handlers: [
    {
      name: "ripple_delete",
      writes: true,
      dangerous: true,
      validate: validateNodeOnly,
      execute: rippleDelete
    },
    {
      name: "slip_edit",
      writes: true,
      validate: validateSlip,
      execute: slipEdit
    },
    {
      name: "rename_clip",
      writes: true,
      validate: validateRename,
      execute: renameClip
    },
    {
      name: "overwrite_clip",
      writes: true,
      dangerous: true,
      validate: validateOverwrite,
      execute: overwriteClip
    },
    {
      name: "trim_clip",
      writes: true,
      validate: validateTrim,
      execute: trimClip
    },
    {
      name: "duplicate_clip",
      writes: true,
      validate: validateNodeOnly,
      execute: duplicateClip
    },
    {
      name: "enable_disable_clip",
      writes: true,
      validate: validateEnabled,
      execute: enableDisableClip
    },
    {
      name: "move_clip",
      writes: true,
      validate: validateMoveClip,
      execute: moveClip
    },
    {
      name: "batch_enable_disable",
      writes: true,
      validate: validateBatchEnableDisable,
      execute: batchEnableDisable
    },
    {
      name: "batch_rename_clips",
      writes: true,
      validate: validateBatchRename,
      execute: batchRenameClips
    },
    {
      name: "remove_selected_clips",
      writes: true,
      dangerous: true,
      validate: validateRemoveSelected,
      execute: removeSelectedClips
    },
    {
      name: "lift_selection",
      writes: true,
      dangerous: true,
      validate(args) {
        if (!isPlainObject(args) || Object.keys(args).length !== 0) {
          throw new BridgeError("INVALID_ARGUMENTS", "이 명령은 인자를 받지 않습니다.");
        }
        return {};
      },
      execute() {
        return removeCurrentSelection("lift_selection", false);
      }
    },
    {
      name: "extract_selection",
      writes: true,
      dangerous: true,
      validate(args) {
        if (!isPlainObject(args) || Object.keys(args).length !== 0) {
          throw new BridgeError("INVALID_ARGUMENTS", "이 명령은 인자를 받지 않습니다.");
        }
        return {};
      },
      execute() {
        return removeCurrentSelection("extract_selection", true);
      }
    }
  ]
};
