const { BridgeError } = require("./errors.js");
const {
  MAX_CONCURRENT_READS,
  TICKS_PER_SECOND,
  addAction,
  executeUndoableTransaction,
  findProjectItem,
  findSequence,
  findTrackItemByNodeId,
  getActiveProject,
  guidText,
  mapWithConcurrency,
  ppro,
  readValue,
  secondsOf,
  tickTimeFromSeconds,
  validateSequenceArgs
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

function trackIndex(value, name, fallback) {
  const index = nonNegativeNumber(value, name, fallback);
  if (!Number.isInteger(index)) {
    throw new BridgeError("INVALID_ARGUMENTS", `${name}은 정수여야 합니다.`);
  }
  return index;
}

function validateAddArgs(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, [
    "item_id",
    "track_index",
    "start_seconds",
    "audio_track_index"
  ]);
  return {
    item_id: nonEmptyString(args.item_id, "item_id"),
    track_index: trackIndex(args.track_index, "track_index", 0),
    start_seconds: nonNegativeNumber(args.start_seconds, "start_seconds", 0),
    audio_track_index: trackIndex(
      args.audio_track_index,
      "audio_track_index",
      0
    )
  };
}

function validateRemoveArgs(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["node_id", "ripple"]);
  if (args.ripple !== undefined && typeof args.ripple !== "boolean") {
    throw new BridgeError("INVALID_ARGUMENTS", "ripple은 boolean이어야 합니다.");
  }
  return {
    node_id: nonEmptyString(args.node_id, "node_id"),
    ripple: args.ripple === true
  };
}

function validatePlayheadArgs(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["time_seconds"]);
  return {
    time_seconds: nonNegativeNumber(args.time_seconds, "time_seconds")
  };
}

function getSequenceEditor(sequence) {
  const sequenceEditorApi = ppro().SequenceEditor;
  if (!sequenceEditorApi || typeof sequenceEditorApi.getEditor !== "function") {
    throw new BridgeError(
      "SEQUENCE_EDITOR_UNAVAILABLE",
      "Premiere UXP SequenceEditor API를 사용할 수 없습니다."
    );
  }
  return sequenceEditorApi.getEditor(sequence);
}

function errorText(error) {
  return String((error && (error.message || error)) || "알 수 없는 오류");
}

function runtimeShape(value) {
  let constructorName = null;
  try {
    constructorName =
      value && value.constructor && typeof value.constructor.name === "string"
        ? value.constructor.name
        : null;
  } catch (_error) {
    constructorName = null;
  }
  return {
    type: typeof value,
    constructorName,
    isPromise: Boolean(value && typeof value.then === "function")
  };
}

function recordSelectionShape(meta, selection, item) {
  const selectionShape = runtimeShape(selection);
  const itemShape = runtimeShape(item);
  meta.selectionConstructorName = selectionShape.constructorName;
  meta.itemConstructorName = itemShape.constructorName;
  meta.addItemType = selection ? typeof selection.addItem : "undefined";
}

function recordReturnShape(meta, prefix, value) {
  const shape = runtimeShape(value);
  meta[`${prefix}Type`] = shape.type;
  meta[`${prefix}ConstructorName`] = shape.constructorName;
  meta[`${prefix}IsPromise`] = shape.isPromise;
}

async function readCurrentSelection(sequence, item, meta) {
  const selection = await sequence.getSelection();
  recordSelectionShape(meta, selection, item);
  if (!selection || typeof selection.addItem !== "function") {
    throw new Error("현재 sequence 선택 객체에 addItem()이 없습니다.");
  }

  if (typeof selection.getTrackItems === "function") {
    const selectedItems = Array.from(
      (await Promise.resolve(selection.getTrackItems())) || []
    );
    meta.currentSelectionItemCount = selectedItems.length;
    meta.currentSelectionContainsTarget = selectedItems.includes(item);
    const unrelatedCount = selectedItems.filter((selected) => selected !== item).length;
    meta.currentSelectionUnrelatedItemCount = unrelatedCount;
    if (unrelatedCount > 0) {
      throw new Error(
        "현재 선택에 대상 외 클립이 있어 안전상 이 전략을 실행하지 않았습니다."
      );
    }
  }
  return selection;
}

function createEmptySelectionSync(item, meta) {
  const selectionApi = ppro().TrackItemSelection;
  if (!selectionApi || typeof selectionApi.createEmptySelection !== "function") {
    throw new Error("Premiere UXP TrackItemSelection API를 사용할 수 없습니다.");
  }

  let selection = null;
  const created = selectionApi.createEmptySelection((value) => {
    selection = value;
  });
  recordReturnShape(meta, "createEmptySelectionReturn", created);
  if (created && typeof created.then === "function") {
    throw new Error(
      "lockedAccess 안에서 createEmptySelection()이 Promise를 반환해 동기 Action을 만들 수 없습니다."
    );
  }
  if (!created || !selection) {
    throw new Error("빈 타임라인 선택 객체를 만들 수 없습니다.");
  }
  recordSelectionShape(meta, selection, item);
  return selection;
}

async function createEmptySelectionOutside(item, meta) {
  const selectionApi = ppro().TrackItemSelection;
  if (!selectionApi || typeof selectionApi.createEmptySelection !== "function") {
    throw new Error("Premiere UXP TrackItemSelection API를 사용할 수 없습니다.");
  }

  let selection = null;
  const createdValue = selectionApi.createEmptySelection((value) => {
    selection = value;
  });
  recordReturnShape(meta, "createEmptySelectionReturn", createdValue);
  const created = await Promise.resolve(createdValue);
  if (!created || !selection) {
    throw new Error("빈 타임라인 선택 객체를 만들 수 없습니다.");
  }
  recordSelectionShape(meta, selection, item);
  return selection;
}

function addItemSync(selection, item, addMode, meta) {
  recordSelectionShape(meta, selection, item);
  if (!selection || typeof selection.addItem !== "function") {
    throw new Error("선택 객체에 addItem()이 없습니다.");
  }
  const added =
    addMode === "single"
      ? selection.addItem(item)
      : selection.addItem(item, false);
  recordReturnShape(meta, "addItemReturn", added);
  if (added && typeof added.then === "function") {
    throw new Error(
      "lockedAccess 안에서 addItem()이 Promise를 반환해 동기 Action을 만들 수 없습니다."
    );
  }
  if (!added) {
    throw new Error("TrackItemSelection.addItem()이 false를 반환했습니다.");
  }
}

async function addItemOutside(selection, item, addMode, meta) {
  recordSelectionShape(meta, selection, item);
  if (!selection || typeof selection.addItem !== "function") {
    throw new Error("선택 객체에 addItem()이 없습니다.");
  }
  const addedValue =
    addMode === "single"
      ? selection.addItem(item)
      : selection.addItem(item, false);
  recordReturnShape(meta, "addItemReturn", addedValue);
  const added = await Promise.resolve(addedValue);
  if (!added) {
    throw new Error("TrackItemSelection.addItem()이 false를 반환했습니다.");
  }
}

function setActualSelection(sequence, selection, meta) {
  if (!sequence || typeof sequence.setSelection !== "function") {
    throw new Error("Sequence.setSelection()을 사용할 수 없습니다.");
  }
  const accepted = sequence.setSelection(selection);
  recordReturnShape(meta, "setSelectionReturn", accepted);
  if (accepted && typeof accepted.then === "function") {
    throw new Error(
      "Sequence.setSelection()이 Promise를 반환해 동기 Action을 만들 수 없습니다."
    );
  }
  if (!accepted) {
    throw new Error("Sequence.setSelection()이 false를 반환했습니다.");
  }
}

const REMOVE_SELECTION_STRATEGIES = [
  {
    name: "current_selection_add_false_outside_locked_access",
    source: "current",
    addMode: "false",
    placement: "outside",
    setActual: false
  },
  {
    name: "current_selection_add_false_inside_locked_access",
    source: "current",
    addMode: "false",
    placement: "inside",
    setActual: false
  },
  {
    name: "empty_selection_add_false_outside_locked_access",
    source: "empty",
    addMode: "false",
    placement: "outside",
    setActual: false
  },
  {
    name: "empty_selection_add_false_inside_locked_access",
    source: "empty",
    addMode: "false",
    placement: "inside",
    setActual: false
  },
  {
    name: "empty_selection_add_single_outside_locked_access",
    source: "empty",
    addMode: "single",
    placement: "outside",
    setActual: false
  },
  {
    name: "empty_selection_add_single_inside_locked_access",
    source: "empty",
    addMode: "single",
    placement: "inside",
    setActual: false
  },
  {
    name: "empty_selection_set_sequence_selection_outside_locked_access",
    source: "empty",
    addMode: "false",
    placement: "outside",
    setActual: true
  },
  {
    name: "empty_selection_set_sequence_selection_inside_locked_access",
    source: "empty",
    addMode: "false",
    placement: "inside",
    setActual: true
  }
];

async function tryRemoveStrategy(options) {
  const {
    project,
    sequence,
    editor,
    item,
    mediaType,
    ripple,
    strategy,
    meta
  } = options;
  let selection = null;

  meta.selectionSource = strategy.source;
  meta.selectionPlacement = strategy.placement;
  meta.addItemArgumentCount = strategy.addMode === "single" ? 1 : 2;
  meta.actionPlacement = "inside_locked_access";
  meta.addItemReturnType = null;
  meta.addItemReturnConstructorName = null;
  meta.addItemReturnIsPromise = null;
  recordSelectionShape(meta, null, item);

  if (strategy.placement === "outside") {
    selection =
      strategy.source === "current"
        ? await readCurrentSelection(sequence, item, meta)
        : await createEmptySelectionOutside(item, meta);
    await addItemOutside(selection, item, strategy.addMode, meta);
    if (strategy.setActual) setActualSelection(sequence, selection, meta);
  } else if (strategy.source === "current") {
    // getSelection() is async in premierepro.d.ts, so only addItem/action
    // construction can be moved inside lockedAccess for this strategy.
    selection = await readCurrentSelection(sequence, item, meta);
    meta.selectionAcquisition = "outside_locked_access_async_api";
  }

  executeUndoableTransaction(project, "remove_from_timeline", (compoundAction) => {
    if (strategy.placement === "inside") {
      if (strategy.source === "empty") {
        selection = createEmptySelectionSync(item, meta);
      }
      addItemSync(selection, item, strategy.addMode, meta);
      if (strategy.setActual) setActualSelection(sequence, selection, meta);
    }
    // executeUndoableTransaction invokes this callback synchronously inside
    // Project.lockedAccess() and Project.executeTransaction().
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- custom transaction wrapper preserves Adobe's lock scope
    const action = editor.createRemoveItemsAction(
      selection,
      ripple,
      mediaType,
      ripple
    );
    addAction(compoundAction, action, "remove_from_timeline");
  });
}

async function addToTimeline(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const item = await findProjectItem(project, args.item_id);
  if (!item) {
    throw new BridgeError(
      "PROJECT_ITEM_NOT_FOUND",
      `Project item not found: ${args.item_id}`
    );
  }

  const editor = getSequenceEditor(sequence);
  const time = tickTimeFromSeconds(args.start_seconds);

  executeUndoableTransaction(project, "add_to_timeline", (compoundAction) => {
    // limitShift=true constrains the insert shift to the destination media
    // tracks. Silent alpha overlays still use only video at runtime; linked
    // A/V behavior remains a live-verification item.
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = editor.createInsertProjectItemAction(
      item,
      time,
      args.track_index,
      args.audio_track_index,
      true
    );
    addAction(compoundAction, action, "add_to_timeline");
  });

  return {
    added: true,
    item: String(item.name || ""),
    trackIndex: args.track_index,
    startSeconds: args.start_seconds
  };
}

async function removeFromTimeline(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await findTrackItemByNodeId(sequence, args.node_id);
  if (!match) {
    throw new BridgeError(
      "CLIP_NOT_FOUND",
      `Clip not found: ${args.node_id}`
    );
  }

  const clipName = await match.item.getName();
  const editor = getSequenceEditor(sequence);
  const mediaType =
    match.trackType === "video"
      ? ppro().Constants.MediaType.VIDEO
      : ppro().Constants.MediaType.AUDIO;
  const attempts = [];

  // TODO: 실기기에서 정답이 확정되면 진단 사다리를 단일 경로로 정리한다.
  for (const strategy of REMOVE_SELECTION_STRATEGIES) {
    const meta = {};
    try {
      await tryRemoveStrategy({
        project,
        sequence,
        editor,
        item: match.item,
        mediaType,
        ripple: args.ripple,
        strategy,
        meta
      });
      attempts.push({ strategy: strategy.name, ok: true, meta });
      return {
        removed: true,
        clipName,
        strategyUsed: strategy.name,
        attempts
      };
    } catch (error) {
      attempts.push({
        strategy: strategy.name,
        ok: false,
        error: errorText(error),
        meta
      });
    }
  }

  throw new BridgeError(
    "REMOVE_STRATEGIES_FAILED",
    "모든 remove_from_timeline 선택 전략이 실패했습니다.",
    { attempts, strategyUsed: null }
  );
}

async function setPlayheadPosition(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  // setPlayerPosition() is the only public UXP 26.3 CTI setter and is not an
  // Action, so moving the playhead does not create an Undo history entry.
  const moved = await sequence.setPlayerPosition(
    tickTimeFromSeconds(args.time_seconds)
  );
  if (!moved) {
    throw new BridgeError("PLAYHEAD_MOVE_FAILED", "Failed to set playhead position");
  }
  return { positionSeconds: args.time_seconds };
}

function incrementCount(map, name) {
  const key = String(name || "");
  map.set(key, (map.get(key) || 0) + 1);
}

async function projectItemName(item) {
  try {
    const projectItem = await item.getProjectItem();
    return projectItem ? String(projectItem.name || "") : null;
  } catch (_error) {
    // Generated items may not have a project item.
    return null;
  }
}

async function effectNames(item) {
  const names = [];
  try {
    const chain = await item.getComponentChain();
    const count = Number(chain && chain.getComponentCount());
    for (let index = 0; index < count; index += 1) {
      const component = chain.getComponentAtIndex(index);
      names.push(await component.getDisplayName());
    }
  } catch (_error) {
    // CEP also treats unreadable component chains as optional summary data.
  }
  return names;
}

async function readVideoSummary(sequence, trackIndex, usedMedia, effectUsage) {
  const track = await sequence.getVideoTrack(trackIndex);
  const items = Array.from(
    (await Promise.resolve(
      track.getTrackItems(ppro().Constants.TrackItemType.CLIP, false)
    )) || []
  );
  let filledSeconds = 0;
  let disabledClips = 0;

  const inspectedItems = await mapWithConcurrency(
    items,
    MAX_CONCURRENT_READS,
    async (item) => {
      const [start, end, disabled, sourceName, effects] = await Promise.all([
        item.getStartTime(),
        item.getEndTime(),
        readValue(item, "isDisabled"),
        projectItemName(item),
        effectNames(item)
      ]);
      return { start, end, disabled, sourceName, effects };
    }
  );
  for (const inspected of inspectedItems) {
    filledSeconds += Math.max(
      0,
      secondsOf(inspected.end) - secondsOf(inspected.start)
    );
    if (inspected.disabled === true) disabledClips += 1;
    if (inspected.sourceName !== null) {
      incrementCount(usedMedia, inspected.sourceName);
    }
    for (const name of inspected.effects) incrementCount(effectUsage, name);
  }

  const muted = await track.isMuted();
  return {
    summary: {
      index: trackIndex,
      name: String(track.name || ""),
      clipCount: items.length,
      muted: Boolean(muted),
      // Premiere 26.3's public UXP API exposes no track lock getter.
      locked: null
    },
    clipCount: items.length,
    disabledClips,
    filledSeconds
  };
}

async function readAudioSummary(sequence, trackIndex, usedMedia) {
  const track = await sequence.getAudioTrack(trackIndex);
  const items = Array.from(
    (await Promise.resolve(
      track.getTrackItems(ppro().Constants.TrackItemType.CLIP, false)
    )) || []
  );
  const sourceNames = await mapWithConcurrency(
    items,
    MAX_CONCURRENT_READS,
    projectItemName
  );
  for (const name of sourceNames) {
    if (name !== null) incrementCount(usedMedia, name);
  }

  const muted = await track.isMuted();
  return {
    index: trackIndex,
    name: String(track.name || ""),
    clipCount: items.length,
    muted: Boolean(muted),
    locked: null
  };
}

async function sequenceFrameRate(sequence) {
  try {
    const settings = await sequence.getSettings();
    const frameRate = settings.getVideoFrameRate();
    const ticksPerFrame = Number(frameRate && frameRate.ticksPerFrame);
    return ticksPerFrame > 0
      ? {
          seconds: ticksPerFrame / TICKS_PER_SECOND,
          ticks: String(Math.round(ticksPerFrame))
        }
      : null;
  } catch (_error) {
    return null;
  }
}

async function markerCount(sequence) {
  try {
    const markers = await ppro().Markers.getMarkers(sequence);
    return Array.from(markers.getMarkers() || []).length;
  } catch (_error) {
    return 0;
  }
}

async function getTimelineSummary(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  const [end, frameSize, playerPosition, videoTrackCount, audioTrackCount] =
    await Promise.all([
      sequence.getEndTime(),
      sequence.getFrameSize(),
      sequence.getPlayerPosition(),
      sequence.getVideoTrackCount(),
      sequence.getAudioTrackCount()
    ]);
  const durationSeconds = secondsOf(end);
  const usedMedia = new Map();
  const effectUsage = new Map();
  const videoTracks = [];
  let totalVideoClips = 0;
  let disabledClips = 0;
  let v1FilledSeconds = 0;

  for (let index = 0; index < videoTrackCount; index += 1) {
    const result = await readVideoSummary(
      sequence,
      index,
      usedMedia,
      effectUsage
    );
    videoTracks.push(result.summary);
    totalVideoClips += result.clipCount;
    disabledClips += result.disabledClips;
    if (index === 0) v1FilledSeconds = result.filledSeconds;
  }

  const audioTracks = [];
  let totalAudioClips = 0;
  for (let index = 0; index < audioTrackCount; index += 1) {
    const summary = await readAudioSummary(sequence, index, usedMedia);
    audioTracks.push(summary);
    totalAudioClips += summary.clipCount;
  }

  const result = {
    name: String(sequence.name || ""),
    id: guidText(sequence.guid),
    resolution: `${Number(frameSize.width)}x${Number(frameSize.height)}`,
    durationSeconds,
    playheadSeconds: secondsOf(playerPosition),
    totalVideoClips,
    totalAudioClips,
    totalClips: totalVideoClips + totalAudioClips,
    disabledClips,
    videoTrackCount,
    audioTrackCount,
    videoTracks,
    audioTracks,
    usedMedia: Array.from(usedMedia, ([name, useCount]) => ({ name, useCount })),
    uniqueMediaCount: usedMedia.size,
    effectUsage: Array.from(effectUsage, ([name, count]) => ({ name, count })),
    markerCount: await markerCount(sequence)
  };
  if (durationSeconds > 0) {
    result.v1CoveragePercent =
      Math.round((v1FilledSeconds / durationSeconds) * 10000) / 100;
  }
  const frameRate = await sequenceFrameRate(sequence);
  if (frameRate !== null) result.frameRate = frameRate;
  return result;
}

module.exports = {
  category: "timeline",
  handlers: [
    {
      name: "add_to_timeline",
      writes: true,
      validate: validateAddArgs,
      execute: addToTimeline
    },
    {
      name: "remove_from_timeline",
      writes: true,
      dangerous: true,
      validate: validateRemoveArgs,
      execute: removeFromTimeline
    },
    {
      name: "set_playhead_position",
      writes: true,
      validate: validatePlayheadArgs,
      execute: setPlayheadPosition
    },
    {
      name: "get_timeline_summary",
      writes: false,
      validate: validateSequenceArgs,
      execute: getTimelineSummary
    }
  ]
};
