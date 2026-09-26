const { BridgeError } = require("./errors.js");
const {
  MAX_CONCURRENT_READS,
  addAction,
  booleanArg,
  executeUndoableTransaction,
  findSequence,
  getActiveProject,
  guidText,
  mapWithConcurrency,
  numberArg,
  ppro,
  rejectUnknown,
  requireClipProjectItem,
  secondsOf,
  stringArg,
  validateNoArgs,
  validateSequenceArgs
} = require("./shared.js");

const TICKS_PER_SECOND = 254016000000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalSequenceId(value) {
  return value === undefined ? undefined : stringArg(value, "sequence_id");
}

function validateRenameCaptionTrack(args) {
  rejectUnknown(args, ["sequence_id", "track_index", "name"]);
  return {
    sequence_id: optionalSequenceId(args.sequence_id),
    track_index: numberArg(args.track_index, "track_index", {
      integer: true,
      min: 0
    }),
    name: stringArg(args.name, "name")
  };
}

function validateSetCaptionTrackMute(args) {
  rejectUnknown(args, ["sequence_id", "track_index", "muted"]);
  return {
    sequence_id: optionalSequenceId(args.sequence_id),
    track_index: numberArg(args.track_index, "track_index", {
      integer: true,
      min: 0
    }),
    muted: booleanArg(args.muted, "muted")
  };
}

function validateHasTranscript(args) {
  rejectUnknown(args, ["item_id"]);
  return { item_id: stringArg(args.item_id, "item_id") };
}

function validateTranscriptArgs(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }

  const unknown = Object.keys(args).filter((key) => key !== "item_name");
  if (unknown.length > 0) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `지원하지 않는 인자입니다: ${unknown.join(", ")}`
    );
  }

  if (
    args.item_name !== undefined &&
    (typeof args.item_name !== "string" || args.item_name.trim().length === 0)
  ) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "item_name은 비어 있지 않은 문자열이어야 합니다."
    );
  }

  return args.item_name === undefined
    ? {}
    : { item_name: args.item_name.trim() };
}

async function readValue(target, key) {
  if (!target) return undefined;
  try {
    const candidate = target[key];
    return typeof candidate === "function"
      ? await Promise.resolve(candidate.call(target))
      : await Promise.resolve(candidate);
  } catch (_error) {
    return undefined;
  }
}

function stringValue(value, depth) {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined || (depth || 0) > 3) return "";
  if (typeof value !== "object") return "";

  for (const key of ["text", "word", "content", "value"]) {
    const nested = stringValue(value[key], (depth || 0) + 1);
    if (nested) return nested;
  }
  return "";
}

function firstTextLeaf(value, seen) {
  if (!value || typeof value !== "object") return "";

  const visited = seen || new Set();
  if (visited.has(value)) return "";
  visited.add(value);

  for (const key of ["text", "word", "content", "displayText"]) {
    const direct = stringValue(value[key]);
    if (direct) return direct;
  }
  let children;
  try {
    children = Array.isArray(value) ? value : Object.values(value);
  } catch (_error) {
    return "";
  }
  for (const child of children) {
    const nested = firstTextLeaf(child, visited);
    if (nested) return nested;
  }
  return "";
}

function captionSpecificTrackItemTypes() {
  const constants = ppro().Constants || {};
  const containers = [constants.TrackItemType, constants.CaptionTrackItemType];
  const values = [];

  for (const container of containers) {
    if (!container || typeof container !== "object") continue;
    for (const key of Object.keys(container)) {
      if (!/caption|subtitle|text/i.test(key)) continue;
      const value = container[key];
      if (typeof value === "number" && !values.includes(value)) values.push(value);
    }
  }

  return values;
}

async function getCaptionItems(track) {
  const constants = ppro().Constants || {};
  const clipType = constants.TrackItemType && constants.TrackItemType.CLIP;
  const dedicatedTypes = captionSpecificTrackItemTypes().filter(
    (value) => value !== clipType
  );
  let clipItems = null;
  let lastError = null;

  // CLIP is the only caption-compatible value documented in Premiere 26.3.
  // Probe it first, then prefer a caption-specific constant if Adobe adds one.
  if (clipType !== undefined) {
    try {
      clipItems = Array.from(
        (await Promise.resolve(track.getTrackItems(clipType, false))) || []
      );
    } catch (error) {
      lastError = error;
    }
  }

  for (const dedicatedType of dedicatedTypes) {
    try {
      const dedicatedItems = Array.from(
        (await Promise.resolve(track.getTrackItems(dedicatedType, false))) || []
      );
      if (dedicatedItems.length > 0 || !clipItems || clipItems.length === 0) {
        return dedicatedItems;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (clipItems) return clipItems;
  throw new BridgeError(
    "CAPTION_ITEMS_UNAVAILABLE",
    "캡션 트랙 항목을 읽을 수 없습니다.",
    lastError ? String(lastError.message || lastError) : null
  );
}

function secondsFromTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return 0;
  const seconds = Number(value.seconds);
  if (Number.isFinite(seconds)) return seconds;
  const ticks = Number(value.ticks);
  return Number.isFinite(ticks) ? ticks / TICKS_PER_SECOND : 0;
}

async function readCaptionItem(item, index) {
  const [kind, name, matchName, start, end] = await Promise.all([
    readValue(item, "getName"),
    readValue(item, "name"),
    readValue(item, "getMatchName"),
    readValue(item, "getStartTime"),
    readValue(item, "getEndTime")
  ]);

  return {
    index,
    // Premiere 26.3 exposes timing and generic TrackItem identity only. In
    // particular getName() returns the runtime kind "SyntheticCaption", not
    // the user-edited caption copy. Keep that metadata separate and make the
    // unavailable text contract explicit so callers cannot consume a type
    // label as subtitle text.
    text: null,
    textAvailable: false,
    kind: kind === undefined || kind === null ? "" : String(kind),
    name: name === undefined || name === null ? "" : String(name),
    matchName:
      matchName === undefined || matchName === null ? "" : String(matchName),
    startSeconds: start ? secondsFromTime(start) : secondsOf(start),
    endSeconds: end ? secondsFromTime(end) : secondsOf(end)
  };
}

async function getCaptionTracks(args, context) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  const captionTrackCount = await sequence.getCaptionTrackCount();
  const tracks = [];

  for (let trackIndex = 0; trackIndex < captionTrackCount; trackIndex += 1) {
    const track = await sequence.getCaptionTrack(trackIndex);
    const trackItems = await getCaptionItems(track);
    const [id, name, muted, items] = await Promise.all([
      readValue(track, "id"),
      readValue(track, "name"),
      readValue(track, "isMuted"),
      mapWithConcurrency(
        trackItems,
        MAX_CONCURRENT_READS,
        (item, index) => readCaptionItem(item, index)
      )
    ]);

    tracks.push({
      index: trackIndex,
      id: id === undefined || id === null ? "" : guidText(id),
      name: name === undefined || name === null ? "" : String(name),
      muted: Boolean(muted),
      itemCount: items.length,
      items
    });

    if (context && typeof context.reportProgress === "function") {
      await context.reportProgress({
        message: "캡션 트랙을 읽고 있습니다.",
        current: trackIndex + 1,
        total: captionTrackCount,
        percent: Math.round(((trackIndex + 1) / Math.max(1, captionTrackCount)) * 100)
      });
    }
  }

  return { captionTrackCount, captionTextAvailable: false, tracks };
}

async function requireCaptionTrack(sequence, trackIndex) {
  const trackCount = Number(await sequence.getCaptionTrackCount());
  if (trackIndex >= trackCount) {
    throw new BridgeError(
      "CAPTION_TRACK_NOT_FOUND",
      `Caption track ${trackIndex}을 찾을 수 없습니다.`,
      { trackIndex, trackCount }
    );
  }
  const track = await sequence.getCaptionTrack(trackIndex);
  if (!track) {
    throw new BridgeError(
      "CAPTION_TRACK_NOT_FOUND",
      `Caption track ${trackIndex}을 찾을 수 없습니다.`
    );
  }
  return { track, trackCount };
}

async function captionTrackReadback(sequence, trackIndex) {
  const { track } = await requireCaptionTrack(sequence, trackIndex);
  const [id, name, muted] = await Promise.all([
    readValue(track, "id"),
    readValue(track, "name"),
    readValue(track, "isMuted")
  ]);
  return {
    track,
    id: id === undefined || id === null ? "" : String(id),
    name: name === undefined || name === null ? "" : String(name),
    muted: Boolean(muted)
  };
}

async function renameCaptionTrack(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  const before = await captionTrackReadback(sequence, args.track_index);

  executeUndoableTransaction(project, "rename_caption_track", (compoundAction) => {
    addAction(
      compoundAction,
      // executeUndoableTransaction invokes this callback synchronously inside
      // Project.lockedAccess() and Project.executeTransaction().
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- custom transaction wrapper preserves Adobe's lock scope
      before.track.createSetNameAction(args.name),
      "rename_caption_track"
    );
  });

  const after = await captionTrackReadback(sequence, args.track_index);
  if (after.name !== args.name) {
    throw new BridgeError(
      "CAPTION_TRACK_READBACK_MISMATCH",
      "Caption track 이름 read-back이 요청값과 일치하지 않습니다.",
      { requestedName: args.name, actualName: after.name }
    );
  }

  return {
    renamed: true,
    changed: before.name !== after.name,
    sequenceId: guidText(sequence.guid),
    sequenceName: String(sequence.name || ""),
    trackIndex: args.track_index,
    trackId: after.id,
    previousName: before.name,
    name: after.name,
    undoable: true
  };
}

async function setCaptionTrackMute(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  const before = await captionTrackReadback(sequence, args.track_index);
  const changed = before.muted !== args.muted;

  if (changed && !(await before.track.setMute(args.muted))) {
    throw new BridgeError(
      "CAPTION_TRACK_MUTE_REJECTED",
      "Premiere가 Caption track mute 변경을 거부했습니다."
    );
  }

  const after = await captionTrackReadback(sequence, args.track_index);
  if (after.muted !== args.muted) {
    throw new BridgeError(
      "CAPTION_TRACK_READBACK_MISMATCH",
      "Caption track mute read-back이 요청값과 일치하지 않습니다.",
      { requestedMuted: args.muted, actualMuted: after.muted }
    );
  }

  return {
    updated: true,
    changed,
    sequenceId: guidText(sequence.guid),
    sequenceName: String(sequence.name || ""),
    trackIndex: args.track_index,
    trackId: after.id,
    previousMuted: before.muted,
    muted: after.muted,
    undoable: false
  };
}

function requireTranscriptMethod(methodName) {
  const transcriptApi = ppro().Transcript;
  if (!transcriptApi || typeof transcriptApi[methodName] !== "function") {
    throw new BridgeError(
      "TRANSCRIPT_API_UNAVAILABLE",
      `Premiere UXP Transcript.${methodName} API를 사용할 수 없습니다.`
    );
  }
  return transcriptApi;
}

async function listTranscriptionLanguages() {
  const transcriptApi = requireTranscriptMethod("querySupportedLanguages");
  const languages = Array.from(
    (await Promise.resolve(transcriptApi.querySupportedLanguages())) || []
  ).map((entry) => ({
    displayString: String((entry && entry.displayString) || ""),
    languageCode: String((entry && entry.languageCode) || ""),
    locale: String((entry && entry.locale) || "")
  }));
  return { languageCount: languages.length, languages };
}

async function hasTranscript(args) {
  const project = await getActiveProject();
  const clipProjectItem = await requireClipProjectItem(project, args.item_id);
  const transcriptApi = requireTranscriptMethod("hasTranscript");
  return {
    itemId: (await projectItemId(clipProjectItem)) || args.item_id,
    name: String(clipProjectItem.name || ""),
    hasTranscript: Boolean(
      await Promise.resolve(transcriptApi.hasTranscript(clipProjectItem))
    )
  };
}

async function projectItemId(projectItem) {
  const id = await readValue(projectItem, "getId");
  return id === undefined || id === null ? "" : String(id);
}

async function collectProjectItems(folder, output, visited) {
  const children = await folder.getItems();
  const projectItemStatic = ppro().ProjectItem || {};

  for (const projectItem of Array.from(children || [])) {
    const nodeId = await projectItemId(projectItem);
    const visitKey = nodeId ? `id:${nodeId}` : projectItem;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);

    const type = await readValue(projectItem, "type");
    const isFolder =
      type === projectItemStatic.TYPE_BIN || type === projectItemStatic.TYPE_ROOT;

    if (isFolder) {
      try {
        const childFolder = ppro().FolderItem.cast(projectItem);
        if (childFolder) await collectProjectItems(childFolder, output, visited);
      } catch (_error) {
        // A stale or virtual bin is not a transcript-bearing clip candidate.
      }
      continue;
    }

    output.push({
      projectItem,
      nodeId,
      name: String(projectItem.name || "")
    });
  }
}

function parseClockTime(value) {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(value);
  if (!match) return null;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function timeScalar(value, keyHint) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    if (value.seconds !== undefined) return timeScalar(value.seconds, "seconds");
    if (value.ticks !== undefined) return timeScalar(value.ticks, "ticks");
    if (value.value !== undefined) return timeScalar(value.value, keyHint);
    return null;
  }

  if (typeof value === "string") {
    const clock = parseClockTime(value.trim());
    if (clock !== null) return clock;
  }

  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (/tick/i.test(String(keyHint || ""))) return number / TICKS_PER_SECOND;
  if (/millisecond|_ms$|milliseconds/i.test(String(keyHint || ""))) {
    return number / 1000;
  }
  return number;
}

function readTimeField(record, keys) {
  for (const key of keys) {
    if (record[key] === undefined) continue;
    const value = timeScalar(record[key], key);
    if (value !== null) return value;
  }

  const range = record.timeRange || record.range || record.timing;
  if (range && typeof range === "object") {
    for (const key of keys) {
      if (range[key] === undefined) continue;
      const value = timeScalar(range[key], key);
      if (value !== null) return value;
    }
  }
  return null;
}

function transcriptRecordText(record) {
  for (const key of ["text", "word", "content", "displayText", "value"]) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return firstTextLeaf(record);
}

function normalizeTranscriptWords(payload) {
  const words = [];
  const seenObjects = new Set();
  const startKeys = [
    "startSeconds",
    "start_seconds",
    "startTimeSeconds",
    "startTime",
    "start",
    "beginSeconds",
    "beginTime",
    "begin",
    "startTicks",
    "start_ticks"
  ];
  const endKeys = [
    "endSeconds",
    "end_seconds",
    "endTimeSeconds",
    "endTime",
    "end",
    "finishSeconds",
    "finishTime",
    "finish",
    "endTicks",
    "end_ticks"
  ];
  const durationKeys = [
    "durationSeconds",
    "duration_seconds",
    "duration",
    "durationTicks",
    "duration_ticks"
  ];

  function visit(value) {
    if (!value || typeof value !== "object" || seenObjects.has(value)) return;
    seenObjects.add(value);

    const beforeChildren = words.length;
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) visit(child);
    if (Array.isArray(value) || words.length > beforeChildren) return;

    const text = transcriptRecordText(value);
    if (!text) return;

    let startSeconds = readTimeField(value, startKeys);
    let endSeconds = readTimeField(value, endKeys);
    const durationSeconds = readTimeField(value, durationKeys);
    if (startSeconds === null && endSeconds === null) return;
    if (startSeconds === null) startSeconds = endSeconds;
    if (endSeconds === null) {
      endSeconds = durationSeconds === null ? startSeconds : startSeconds + durationSeconds;
    }

    words.push({ text, startSeconds, endSeconds });
  }

  visit(payload);
  words.sort(
    (left, right) =>
      left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds
  );

  const deduplicated = [];
  const keys = new Set();
  for (const word of words) {
    const key = `${word.startSeconds}\u0000${word.endSeconds}\u0000${word.text}`;
    if (keys.has(key)) continue;
    keys.add(key);
    deduplicated.push(word);
  }
  return deduplicated;
}

function parseTranscriptExport(raw) {
  const rawText = typeof raw === "string" ? raw : JSON.stringify(raw);
  try {
    let parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    return { words: normalizeTranscriptWords(parsed), rawPreview: null };
  } catch (_error) {
    return {
      words: [],
      rawPreview: String(rawText === undefined ? raw : rawText).slice(0, 500)
    };
  }
}

async function getClipTranscript(args, context) {
  const project = await getActiveProject();
  const root = await project.getRootItem();
  const projectItems = [];
  await collectProjectItems(root, projectItems, new Set());

  const requestedName = args.item_name && args.item_name.toLocaleLowerCase();
  const candidates = requestedName
    ? projectItems.filter(
        (item) => item.name.toLocaleLowerCase() === requestedName
      )
    : projectItems;
  const transcriptApi = ppro().Transcript;
  if (
    !transcriptApi ||
    typeof transcriptApi.hasTranscript !== "function" ||
    typeof transcriptApi.exportToJSON !== "function"
  ) {
    throw new BridgeError(
      "TRANSCRIPT_API_UNAVAILABLE",
      "Premiere Transcript 읽기 API를 사용할 수 없습니다."
    );
  }

  const items = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (
      context &&
      typeof context.reportProgress === "function" &&
      (index === 0 || index % 25 === 0)
    ) {
      await context.reportProgress({
        message: "클립 대본을 찾고 있습니다.",
        current: index,
        total: candidates.length,
        percent: Math.round((index / Math.max(1, candidates.length)) * 100)
      });
    }

    let clipProjectItem;
    try {
      clipProjectItem = ppro().ClipProjectItem.cast(candidate.projectItem);
    } catch (_error) {
      continue;
    }
    if (!clipProjectItem) continue;

    let hasTranscript = false;
    try {
      hasTranscript = Boolean(
        await Promise.resolve(transcriptApi.hasTranscript(clipProjectItem))
      );
    } catch (_error) {
      continue;
    }
    if (!hasTranscript) continue;

    let raw;
    try {
      raw = await Promise.resolve(transcriptApi.exportToJSON(clipProjectItem));
    } catch (error) {
      throw new BridgeError(
        "TRANSCRIPT_EXPORT_FAILED",
        `대본을 내보낼 수 없습니다: ${candidate.name || candidate.nodeId}`,
        String(error && (error.message || error))
      );
    }

    const parsed = parseTranscriptExport(raw);
    const result = {
      name: candidate.name,
      wordCount: parsed.words.length,
      words: parsed.words
    };
    if (candidate.nodeId) result.nodeId = candidate.nodeId;
    if (parsed.rawPreview !== null) result.rawPreview = parsed.rawPreview;
    items.push(result);
  }

  return { items };
}

// 진단 전용(2026-07-22): 캡션 TrackItem의 실제 API 표면을 해부한다.
// 공식 d.ts에는 캡션 텍스트 getter가 없고, getName()은 항목 종류명
// "SyntheticCaption"만 돌려준다. 런타임 객체의 숨은 메서드를 찾기 위한
// 임시 명령이며, 텍스트 경로가 확정되면 제거한다.
function probeSummarize(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const type = typeof value;
  if (type === "string") return `string(${value.length}): ${value.slice(0, 160)}`;
  if (type === "number" || type === "boolean") return `${type}: ${String(value)}`;
  try {
    const json = JSON.stringify(value);
    if (json && json !== "{}")
      return `${type}/${value.constructor ? value.constructor.name : "?"}: ${json.slice(0, 160)}`;
  } catch (_error) {
    // 순환 참조 등은 아래 기본 표기로 넘어간다.
  }
  return `${type}/${value && value.constructor ? value.constructor.name : "?"}`;
}

async function probeCaptionItem(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  const trackCount = await sequence.getCaptionTrackCount();
  if (!trackCount) {
    throw new BridgeError("NO_CAPTION_TRACK", "캡션 트랙이 없습니다.");
  }

  const track = await sequence.getCaptionTrack(0);
  const items = Array.from(
    track.getTrackItems(ppro().Constants.TrackItemType.CLIP, false) || []
  );
  if (!items.length) {
    throw new BridgeError("NO_CAPTION_ITEMS", "캡션 항목이 없습니다.");
  }
  const item = items[0];

  // 1) 프로토타입 사슬의 속성 이름 전부 수집.
  const propertyNames = new Set();
  let cursor = item;
  for (let hop = 0; cursor && hop < 6; hop += 1) {
    try {
      for (const name of Object.getOwnPropertyNames(cursor)) {
        propertyNames.add(name);
      }
    } catch (_error) {
      break;
    }
    cursor = Object.getPrototypeOf(cursor);
  }

  // 2) 텍스트 후보 getter를 안전 호출해 요약.
  const candidateKeys = [
    "getCaptionText",
    "getText",
    "getSourceText",
    "getData",
    "getCaption",
    "getContents",
    "exportText",
    "data",
    "text",
    "captionText",
    "toString"
  ];
  const probes = {};
  for (const key of candidateKeys) {
    try {
      const candidate = item[key];
      if (candidate === undefined) continue;
      const value =
        typeof candidate === "function"
          ? await Promise.resolve(candidate.call(item))
          : candidate;
      probes[key] = probeSummarize(value);
    } catch (error) {
      probes[key] = `ERR: ${String((error && error.message) || error).slice(0, 100)}`;
    }
  }

  // 3) ComponentChain이 있으면 컴포넌트·파라미터 이름과 문자열 값을 요약.
  let componentChain = null;
  try {
    if (typeof item.getComponentChain === "function") {
      const chain = await Promise.resolve(item.getComponentChain());
      const componentCount = chain
        ? await Promise.resolve(chain.getComponentCount())
        : 0;
      componentChain = { componentCount, components: [] };
      for (let i = 0; i < Math.min(componentCount, 6); i += 1) {
        const component = await Promise.resolve(chain.getComponentAtIndex(i));
        const info = {
          matchName: await readValue(component, "getMatchName"),
          displayName: await readValue(component, "getDisplayName"),
          params: []
        };
        const paramCount =
          (await readValue(component, "getParamCount")) || 0;
        for (let p = 0; p < Math.min(Number(paramCount) || 0, 24); p += 1) {
          try {
            const param = await Promise.resolve(component.getParam(p));
            const paramInfo = {
              displayName: await readValue(param, "getDisplayName"),
              value: probeSummarize(
                await readValue(param, "getValue")
              ).slice(0, 200)
            };
            info.params.push(paramInfo);
          } catch (error) {
            info.params.push({ error: String(error && error.message).slice(0, 80) });
          }
        }
        componentChain.components.push(info);
      }
    }
  } catch (error) {
    componentChain = { error: String((error && error.message) || error).slice(0, 120) };
  }

  return {
    itemCount: items.length,
    constructorName:
      (item && item.constructor && item.constructor.name) || "unknown",
    propertyNames: Array.from(propertyNames).sort(),
    probes,
    componentChain
  };
}

module.exports = {
  category: "captions",
  handlers: [
    {
      name: "get_caption_tracks",
      writes: false,
      validate: validateSequenceArgs,
      execute: getCaptionTracks
    },
    {
      name: "get_clip_transcript",
      writes: false,
      validate: validateTranscriptArgs,
      execute: getClipTranscript
    },
    {
      name: "probe_caption_item",
      writes: false,
      validate: validateSequenceArgs,
      execute: probeCaptionItem
    },
    {
      name: "rename_caption_track",
      writes: true,
      validate: validateRenameCaptionTrack,
      execute: renameCaptionTrack
    },
    {
      name: "set_caption_track_mute",
      writes: true,
      validate: validateSetCaptionTrackMute,
      execute: setCaptionTrackMute
    },
    {
      name: "list_transcription_languages",
      writes: false,
      validate: validateNoArgs,
      execute: listTranscriptionLanguages
    },
    {
      name: "has_transcript",
      writes: false,
      validate: validateHasTranscript,
      execute: hasTranscript
    }
  ]
};
