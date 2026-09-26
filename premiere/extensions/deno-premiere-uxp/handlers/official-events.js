const { BridgeError } = require("./errors.js");
const {
  arrayArg,
  enumArg,
  findSequence,
  getActiveProject,
  guidText,
  numberArg,
  ppro,
  rejectUnknown,
  stringArg
} = require("./shared.js");

const EVENT_LIMIT = 200;
const MAX_TRACKS_PER_MEDIA_TYPE = 64;
const DEBOUNCE_MS = 200;
const EVENT_GROUPS = Object.freeze([
  "project",
  "sequence",
  "operation",
  "video_tracks",
  "audio_tracks",
  "snap"
]);

const eventJournal = [];
const subscriptions = new Map();
const recentEventTimes = new Map();
let eventSequence = 0;
let listenerStartedAt = null;

function validateSubscribe(args) {
  rejectUnknown(args, ["groups", "sequence_id"]);
  const groups = arrayArg(args.groups, "groups", { nonEmpty: true });
  if (groups.length > EVENT_GROUPS.length) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `groups는 최대 ${EVENT_GROUPS.length}개까지 허용됩니다.`
    );
  }
  const normalizedGroups = groups.map((value, index) =>
    enumArg(value, `groups[${index}]`, EVENT_GROUPS)
  );
  if (new Set(normalizedGroups).size !== normalizedGroups.length) {
    throw new BridgeError("INVALID_ARGUMENTS", "groups에 중복 값을 넣을 수 없습니다.");
  }
  const sequenceId =
    args.sequence_id === undefined
      ? undefined
      : stringArg(args.sequence_id, "sequence_id");
  if (
    sequenceId !== undefined &&
    !normalizedGroups.some((group) =>
      ["sequence", "video_tracks", "audio_tracks"].includes(group)
    )
  ) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "sequence_id는 sequence 또는 track 이벤트 구독에만 사용할 수 있습니다."
    );
  }
  return { groups: normalizedGroups, sequence_id: sequenceId };
}

function validateList(args) {
  rejectUnknown(args, ["after_event_id", "event_types", "groups", "limit"]);
  const afterEventId = numberArg(args.after_event_id, "after_event_id", {
    optional: true,
    fallback: 0,
    integer: true,
    min: 0
  });
  const limit = numberArg(args.limit, "limit", {
    optional: true,
    fallback: 100,
    integer: true,
    min: 1,
    max: EVENT_LIMIT
  });
  const eventTypes =
    args.event_types === undefined
      ? []
      : arrayArg(args.event_types, "event_types").map((value, index) =>
          stringArg(value, `event_types[${index}]`)
        );
  const groups =
    args.groups === undefined
      ? []
      : arrayArg(args.groups, "groups").map((value, index) =>
          enumArg(value, `groups[${index}]`, EVENT_GROUPS)
        );
  if (eventTypes.length > 32 || groups.length > EVENT_GROUPS.length) {
    throw new BridgeError("INVALID_ARGUMENTS", "이벤트 필터가 허용 범위를 초과했습니다.");
  }
  return {
    after_event_id: afterEventId,
    event_types: Array.from(new Set(eventTypes)),
    groups: Array.from(new Set(groups)),
    limit
  };
}

function validateUnsubscribe(args) {
  rejectUnknown(args, ["groups"]);
  if (args.groups === undefined) return { groups: [] };
  const groups = arrayArg(args.groups, "groups", { nonEmpty: true }).map(
    (value, index) => enumArg(value, `groups[${index}]`, EVENT_GROUPS)
  );
  if (groups.length > EVENT_GROUPS.length || new Set(groups).size !== groups.length) {
    throw new BridgeError("INVALID_ARGUMENTS", "groups 범위 또는 중복이 잘못됐습니다.");
  }
  return { groups };
}

function requireEventManager() {
  const manager = ppro().EventManager;
  if (
    !manager ||
    typeof manager.addEventListener !== "function" ||
    typeof manager.removeEventListener !== "function" ||
    typeof manager.addGlobalEventListener !== "function" ||
    typeof manager.removeGlobalEventListener !== "function"
  ) {
    throw new BridgeError(
      "EVENT_MANAGER_UNAVAILABLE",
      "Premiere UXP EventManager API를 사용할 수 없습니다."
    );
  }
  return manager;
}

function requireEventConstant(group, eventType, collection, key) {
  const value = ppro().Constants?.[collection]?.[key];
  if (value === undefined || value === null) {
    throw new BridgeError(
      "EVENT_TYPE_UNAVAILABLE",
      `Premiere UXP ${group}/${eventType} 이벤트 상수를 사용할 수 없습니다.`
    );
  }
  return value;
}

function globalEventDefinitions(group) {
  const definitions = {
    project: [
      ["project_opened", "ProjectEvent", "OPENED"],
      ["project_closed", "ProjectEvent", "CLOSED"],
      ["project_dirty_changed", "ProjectEvent", "DIRTY"],
      ["project_activated", "ProjectEvent", "ACTIVATED"],
      [
        "project_item_selection_changed",
        "ProjectEvent",
        "PROJECT_ITEM_SELECTION_CHANGED"
      ]
    ],
    sequence: [
      ["sequence_activated", "SequenceEvent", "ACTIVATED"],
      ["sequence_closed", "SequenceEvent", "CLOSED"],
      ["sequence_selection_changed", "SequenceEvent", "SELECTION_CHANGED"]
    ],
    operation: [
      ["import_media_complete", "OperationCompleteEvent", "IMPORT_MEDIA_COMPLETE"],
      ["export_media_complete", "OperationCompleteEvent", "EXPORT_MEDIA_COMPLETE"],
      ["effect_drop_complete", "OperationCompleteEvent", "EFFECT_DROP_COMPLETE"],
      ["effect_drag_over", "OperationCompleteEvent", "EFFECT_DRAG_OVER"],
      ["clip_extend_reached", "OperationCompleteEvent", "CLIP_EXTEND_REACHED"],
      [
        "generative_extend_complete",
        "OperationCompleteEvent",
        "GENERATIVE_EXTEND_COMPLETE"
      ]
    ],
    snap: [
      ["snap_keyframe", "SnapEvent", "KEYFRAME"],
      ["snap_razor_playhead", "SnapEvent", "RAZOR_PLAYHEAD"],
      ["snap_razor_marker", "SnapEvent", "RAZOR_MARKER"],
      ["snap_track_item", "SnapEvent", "TRACKITEM"],
      ["snap_guides", "SnapEvent", "GUIDES"],
      ["snap_playhead_track_item", "SnapEvent", "PLAYHEAD_TRACKITEM"]
    ]
  };
  return (definitions[group] || []).map(([eventType, collection, key]) => ({
    eventType,
    eventName: requireEventConstant(group, eventType, collection, key)
  }));
}

function trackEventDefinitions(mediaType) {
  const group = mediaType === "video" ? "video_tracks" : "audio_tracks";
  const collection = mediaType === "video" ? "VideoTrackEvent" : "AudioTrackEvent";
  return [
    ["changed", "TRACK_CHANGED"],
    ["info_changed", "INFO_CHANGED"],
    ["lock_changed", "LOCK_CHANGED"]
  ].map(([suffix, key]) => ({
    eventType: `${mediaType}_track_${suffix}`,
    eventName: requireEventConstant(group, suffix, collection, key)
  }));
}

function boundedText(value, maxLength) {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

function normalizeEventPayload(event) {
  const payload = event && typeof event === "object" ? event : {};
  const normalized = {};
  const textKeys = [
    "name",
    "id",
    "guid",
    "projectGuid",
    "sequenceGuid",
    "path",
    "message"
  ];
  const numberKeys = ["state", "trackIndex", "index", "progressAmount"];
  const booleanKeys = ["dirty", "isDirty", "locked", "isLocked"];
  for (const key of textKeys) {
    const value = boundedText(payload[key], key === "path" ? 1024 : 256);
    if (value !== undefined) normalized[key] = value;
  }
  for (const key of numberKeys) {
    const value = Number(payload[key]);
    if (Number.isFinite(value)) normalized[key] = value;
  }
  for (const key of booleanKeys) {
    if (typeof payload[key] === "boolean") normalized[key] = payload[key];
  }
  return normalized;
}

function recordEvent(group, eventType, targetInfo, event) {
  const debounceKey = `${group}:${eventType}:${targetInfo.key || "global"}`;
  const now = Date.now();
  const shouldDebounce = /dirty|selection_changed/.test(eventType);
  if (shouldDebounce && now - (recentEventTimes.get(debounceKey) || 0) < DEBOUNCE_MS) {
    return;
  }
  recentEventTimes.set(debounceKey, now);
  eventJournal.push({
    eventId: ++eventSequence,
    group,
    type: eventType,
    occurredAt: new Date(now).toISOString(),
    target: targetInfo.public,
    payload: normalizeEventPayload(event)
  });
  if (eventJournal.length > EVENT_LIMIT) {
    eventJournal.splice(0, eventJournal.length - EVENT_LIMIT);
  }
}

function registerGlobal(manager, group, definition, addedKeys) {
  const key = `global:${group}:${definition.eventType}`;
  if (subscriptions.has(key)) return;
  const targetInfo = { key: "global", public: { scope: "global" } };
  const handler = (event) => recordEvent(group, definition.eventType, targetInfo, event);
  manager.addGlobalEventListener(definition.eventName, handler);
  subscriptions.set(key, {
    key,
    group,
    scope: "global",
    eventType: definition.eventType,
    eventName: definition.eventName,
    handler
  });
  addedKeys.push(key);
}

function registerTarget(manager, group, definition, target, targetInfo, addedKeys) {
  const key = `${targetInfo.key}:${group}:${definition.eventType}`;
  if (subscriptions.has(key)) return;
  const handler = (event) => recordEvent(group, definition.eventType, targetInfo, event);
  manager.addEventListener(target, definition.eventName, handler);
  subscriptions.set(key, {
    key,
    group,
    scope: "target",
    eventType: definition.eventType,
    eventName: definition.eventName,
    handler,
    target
  });
  addedKeys.push(key);
}

function removeSubscription(manager, entry) {
  if (entry.scope === "global") {
    manager.removeGlobalEventListener(entry.eventName, entry.handler);
  } else {
    manager.removeEventListener(entry.target, entry.eventName, entry.handler);
  }
  subscriptions.delete(entry.key);
}

async function subscribePremiereEvents(args) {
  const manager = requireEventManager();
  const addedKeys = [];
  let sequence = null;
  try {
    for (const group of args.groups) {
      if (["project", "operation", "snap"].includes(group)) {
        for (const definition of globalEventDefinitions(group)) {
          registerGlobal(manager, group, definition, addedKeys);
        }
        continue;
      }

      if (group === "sequence") {
        if (args.sequence_id === undefined) {
          for (const definition of globalEventDefinitions(group)) {
            registerGlobal(manager, group, definition, addedKeys);
          }
          continue;
        }
        if (!sequence) {
          const project = await getActiveProject();
          sequence = await findSequence(project, args.sequence_id);
        }
        const targetInfo = {
          key: `sequence:${guidText(sequence.guid)}`,
          public: {
            scope: "sequence",
            sequenceId: guidText(sequence.guid),
            sequenceName: String(sequence.name || "")
          }
        };
        for (const definition of globalEventDefinitions(group)) {
          registerTarget(manager, group, definition, sequence, targetInfo, addedKeys);
        }
        continue;
      }

      const mediaType = group === "video_tracks" ? "video" : "audio";
      if (!sequence) {
        const project = await getActiveProject();
        sequence = await findSequence(project, args.sequence_id);
      }
      const count =
        mediaType === "video"
          ? await sequence.getVideoTrackCount()
          : await sequence.getAudioTrackCount();
      if (count > MAX_TRACKS_PER_MEDIA_TYPE) {
        throw new BridgeError(
          "TOO_MANY_EVENT_TARGETS",
          `${mediaType} track 이벤트는 최대 ${MAX_TRACKS_PER_MEDIA_TYPE}개 track까지만 구독할 수 있습니다.`
        );
      }
      const definitions = trackEventDefinitions(mediaType);
      for (let index = 0; index < count; index += 1) {
        const track =
          mediaType === "video"
            ? await sequence.getVideoTrack(index)
            : await sequence.getAudioTrack(index);
        const targetInfo = {
          key: `${guidText(sequence.guid)}:${mediaType}:${String(track.id ?? index)}`,
          public: {
            scope: "track",
            sequenceId: guidText(sequence.guid),
            sequenceName: String(sequence.name || ""),
            mediaType,
            trackIndex: index,
            trackId: String(track.id ?? ""),
            trackName: String(track.name || "")
          }
        };
        for (const definition of definitions) {
          registerTarget(manager, group, definition, track, targetInfo, addedKeys);
        }
      }
    }
  } catch (error) {
    for (const key of addedKeys.reverse()) {
      const entry = subscriptions.get(key);
      if (entry) {
        try {
          removeSubscription(manager, entry);
        } catch (_cleanupError) {
          // Preserve the original registration failure.
        }
      }
    }
    throw error;
  }

  if (!listenerStartedAt && subscriptions.size > 0) {
    listenerStartedAt = new Date().toISOString();
  }
  return {
    subscribed: true,
    requestedGroups: args.groups,
    addedListenerCount: addedKeys.length,
    activeListenerCount: subscriptions.size,
    listenerStartedAt,
    capturesPastEvents: false,
    stateSnapshotAvailable: false,
    note:
      "이 journal은 구독 이후 발생한 공식 Premiere 이벤트만 기록하며 현재 상태 snapshot이 아닙니다."
  };
}

async function listPremiereEvents(args) {
  const eventTypeSet = new Set(args.event_types);
  const groupSet = new Set(args.groups);
  const matching = eventJournal.filter(
    (event) =>
      event.eventId > args.after_event_id &&
      (eventTypeSet.size === 0 || eventTypeSet.has(event.type)) &&
      (groupSet.size === 0 || groupSet.has(event.group))
  );
  const events = matching.slice(0, args.limit);
  return {
    listenerStartedAt,
    latestEventId: eventSequence,
    activeListenerCount: subscriptions.size,
    eventCount: events.length,
    truncated: matching.length > events.length,
    capturesPastEvents: false,
    stateSnapshotAvailable: false,
    events
  };
}

async function unsubscribePremiereEvents(args) {
  const manager = requireEventManager();
  const groupSet = new Set(args.groups);
  const entries = Array.from(subscriptions.values()).filter(
    (entry) => groupSet.size === 0 || groupSet.has(entry.group)
  );
  const failures = [];
  let removedCount = 0;
  for (const entry of entries) {
    try {
      removeSubscription(manager, entry);
      removedCount += 1;
    } catch (error) {
      failures.push({
        group: entry.group,
        type: entry.eventType,
        message: String(error && (error.message || error))
      });
    }
  }
  if (failures.length > 0) {
    throw new BridgeError(
      "EVENT_UNSUBSCRIBE_FAILED",
      "일부 Premiere 이벤트 listener를 제거하지 못했습니다.",
      failures
    );
  }
  return {
    unsubscribed: true,
    requestedGroups: args.groups.length > 0 ? args.groups : EVENT_GROUPS,
    removedListenerCount: removedCount,
    activeListenerCount: subscriptions.size
  };
}

function shutdown() {
  if (subscriptions.size === 0) return;
  let manager;
  try {
    manager = requireEventManager();
  } catch (_error) {
    subscriptions.clear();
    return;
  }
  for (const entry of Array.from(subscriptions.values())) {
    try {
      removeSubscription(manager, entry);
    } catch (_error) {
      subscriptions.delete(entry.key);
    }
  }
  listenerStartedAt = null;
}

module.exports = {
  category: "events",
  shutdown,
  handlers: [
    {
      name: "subscribe_premiere_events",
      writes: false,
      validate: validateSubscribe,
      execute: subscribePremiereEvents
    },
    {
      name: "list_premiere_events",
      writes: false,
      validate: validateList,
      execute: listPremiereEvents
    },
    {
      name: "unsubscribe_premiere_events",
      writes: false,
      validate: validateUnsubscribe,
      execute: unsubscribePremiereEvents
    }
  ]
};
