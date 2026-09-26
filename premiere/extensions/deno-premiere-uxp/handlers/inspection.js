const { BridgeError } = require("./errors.js");
const {
  booleanArg,
  collectProjectItems,
  collectTrackItems,
  enumArg,
  findSequence,
  getActiveProject,
  guidText,
  numberArg,
  ppro,
  rejectUnknown,
  requireProjectItem,
  requireTrackItem,
  secondsOf,
  stringArg,
  validateNoArgs,
  validateSequenceArgs
} = require("./shared.js");
const {
  readProjectItemSnapshot,
  readSequenceBasicSnapshot,
  readSequenceSettingsSnapshot,
  readTrackItemSnapshot
} = require("./inspection-helpers.js");

function validateBinContents(args) {
  rejectUnknown(args, ["bin_id", "recursive"]);
  return {
    bin_id: stringArg(args.bin_id, "bin_id"),
    recursive: booleanArg(args.recursive, "recursive", {
      optional: true,
      fallback: true
    })
  };
}

function validateNodeId(args) {
  rejectUnknown(args, ["node_id"]);
  return { node_id: stringArg(args.node_id, "node_id") };
}

function validateItemId(args) {
  rejectUnknown(args, ["item_id"]);
  return { item_id: stringArg(args.item_id, "item_id") };
}

function validateSearch(args) {
  rejectUnknown(args, [
    "query",
    "extension",
    "offline_only",
    "color_label",
    "item_type",
    "max_results"
  ]);
  return {
    query: stringArg(args.query, "query", {
      optional: true,
      fallback: "",
      allowEmpty: true
    }),
    extension: stringArg(args.extension, "extension", {
      optional: true,
      fallback: "",
      allowEmpty: true
    }),
    offline_only: booleanArg(args.offline_only, "offline_only", {
      optional: true,
      fallback: false
    }),
    color_label:
      args.color_label === undefined
        ? undefined
        : numberArg(args.color_label, "color_label", {
            integer: true,
            min: 0,
            max: 15
          }),
    item_type: enumArg(args.item_type, "item_type", ["clip", "bin", "all"], {
      optional: true,
      fallback: "all"
    }),
    max_results: numberArg(args.max_results, "max_results", {
      optional: true,
      fallback: 100,
      integer: true,
      min: 1,
      max: 10000
    })
  };
}

function validateGaps(args) {
  rejectUnknown(args, ["sequence_id", "track_type", "min_gap_seconds"]);
  return {
    sequence_id: stringArg(args.sequence_id, "sequence_id", {
      optional: true,
      fallback: undefined
    }),
    track_type: enumArg(args.track_type, "track_type", ["video", "audio", "both"], {
      optional: true,
      fallback: "both"
    }),
    min_gap_seconds: numberArg(args.min_gap_seconds, "min_gap_seconds", {
      optional: true,
      fallback: 0.04,
      min: 0
    })
  };
}

async function serializeMarkers(sequence) {
  try {
    const collection = await ppro().Markers.getMarkers(sequence);
    return Array.from(collection.getMarkers() || []).map((marker) => {
      const start = secondsOf(marker.getStart());
      const duration = secondsOf(marker.getDuration());
      return {
        id: guidText(marker.guid),
        name: String(marker.getName() || ""),
        comments: String(marker.getComments() || ""),
        type: String(marker.getType() || ""),
        colorIndex: Number(marker.getColorIndex()),
        startSeconds: start,
        endSeconds: start + duration,
        durationSeconds: duration
      };
    });
  } catch (_error) {
    return [];
  }
}

async function getFullProjectOverview() {
  const project = await getActiveProject();
  const entries = await collectProjectItems(project);
  const items = [];
  const offlineItems = [];
  const counts = { bins: 0, clips: 0, sequences: 0, other: 0 };
  for (const entry of entries) {
    const snapshot = await readProjectItemSnapshot(entry.item, {
      path: entry.path
    });
    items.push(snapshot);
    if (snapshot.type === "bin") counts.bins += 1;
    else if (snapshot.type === "sequence") counts.sequences += 1;
    else if (["clip", "file", "compound"].includes(snapshot.type)) counts.clips += 1;
    else counts.other += 1;
    if (snapshot.offline) offlineItems.push(snapshot);
  }

  const sequences = [];
  for (const sequence of Array.from((await project.getSequences()) || [])) {
    sequences.push({
      ...(await readSequenceBasicSnapshot(sequence)),
      settings: await readSequenceSettingsSnapshot(sequence)
    });
  }
  return {
    project: {
      name: String(project.name || ""),
      path: String(project.path || ""),
      id: guidText(project.guid)
    },
    counts,
    itemCount: items.length,
    offlineCount: offlineItems.length,
    items,
    offlineItems,
    sequences
  };
}

async function getBinContents(args) {
  const project = await getActiveProject();
  const root = await project.getRootItem();
  const rootSnapshot = await readProjectItemSnapshot(root);
  const projectId = guidText(project.guid);
  const projectName = String(project.name || "");
  const projectPath = String(project.path || "");

  // Premiere 26.3 can expose the project root through getRootItem() without
  // the ID/name values that the same root reports through getInsertionBin().
  // Keep root selection stable by treating the active project's own identity
  // as authoritative fallbacks for this virtual FolderItem.
  rootSnapshot.nodeId = rootSnapshot.nodeId || projectId;
  rootSnapshot.id = rootSnapshot.id || projectId;
  rootSnapshot.name = rootSnapshot.name || projectName;
  if (rootSnapshot.type === "unknown") rootSnapshot.type = "root";
  const selector = args.bin_id.toLocaleLowerCase();
  const rootSelectors = [
    rootSnapshot.nodeId,
    rootSnapshot.id,
    rootSnapshot.name,
    projectId,
    projectName,
    projectPath
  ]
    .filter(Boolean)
    .map((value) => String(value).toLocaleLowerCase());
  const selected = rootSelectors.includes(selector)
    ? root
    : await requireProjectItem(project, args.bin_id, "Bin");
  let folder = null;
  try {
    folder = ppro().FolderItem.cast(selected);
  } catch (_error) {
    folder = null;
  }
  if (!folder) throw new BridgeError("NOT_A_BIN", `Bin required: ${args.bin_id}`);
  const entries = args.recursive
    ? await collectProjectItems(project, { root: folder })
    : Array.from((await folder.getItems()) || []).map((item) => ({
        item,
        path: String(item.name || "")
      }));
  const items = [];
  for (const entry of entries) {
    items.push(await readProjectItemSnapshot(entry.item, { path: entry.path }));
  }
  return {
    bin:
      selected === root
        ? rootSnapshot
        : await readProjectItemSnapshot(selected),
    recursive: args.recursive,
    itemCount: items.length,
    items
  };
}

async function trackRecords(sequence, trackType) {
  const matches = await collectTrackItems(sequence, { trackType });
  const grouped = new Map();
  for (const match of matches) {
    const key = `${match.trackType}:${match.trackIndex}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        type: match.trackType,
        index: match.trackIndex,
        name: String(match.track.name || ""),
        muted: Boolean(await match.track.isMuted()),
        locked: null,
        targeted: null,
        clips: []
      });
    }
    grouped.get(key).clips.push(await readTrackItemSnapshot(match, {
      includeEffects: true,
      includeKeyframes: true
    }));
  }

  const counts =
    trackType === "video"
      ? await sequence.getVideoTrackCount()
      : await sequence.getAudioTrackCount();
  for (let index = 0; index < counts; index += 1) {
    const key = `${trackType}:${index}`;
    if (!grouped.has(key)) {
      const track =
        trackType === "video"
          ? await sequence.getVideoTrack(index)
          : await sequence.getAudioTrack(index);
      grouped.set(key, {
        type: trackType,
        index,
        name: String(track.name || ""),
        muted: Boolean(await track.isMuted()),
        locked: null,
        targeted: null,
        clips: []
      });
    }
  }
  return Array.from(grouped.values()).sort((left, right) => left.index - right.index);
}

async function getFullSequenceInfo(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  return {
    ...(await readSequenceBasicSnapshot(sequence)),
    settings: await readSequenceSettingsSnapshot(sequence),
    videoTracks: await trackRecords(sequence, "video"),
    audioTracks: await trackRecords(sequence, "audio"),
    markers: await serializeMarkers(sequence),
    unsupportedFields: ["track.locked", "track.targeted"]
  };
}

async function getFullClipInfo(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await requireTrackItem(sequence, args.node_id);
  return readTrackItemSnapshot(match, {
    includeEffects: true,
    includeKeyframes: true
  });
}

async function getProjectItemInfo(args) {
  const project = await getActiveProject();
  const item = await requireProjectItem(project, args.item_id);
  const result = await readProjectItemSnapshot(item);
  result.unsupportedFields = ["codec", "explicitColorSpace"];
  return result;
}

async function searchProjectItems(args) {
  const project = await getActiveProject();
  const entries = await collectProjectItems(project);
  const query = args.query.toLocaleLowerCase();
  const extension = args.extension.replace(/^\./, "").toLocaleLowerCase();
  const matches = [];
  for (const entry of entries) {
    const snapshot = await readProjectItemSnapshot(entry.item, { path: entry.path });
    if (query && !snapshot.name.toLocaleLowerCase().includes(query)) continue;
    if (args.item_type !== "all") {
      if (args.item_type === "bin" && snapshot.type !== "bin") continue;
      if (
        args.item_type === "clip" &&
        !["clip", "file", "compound"].includes(snapshot.type)
      ) {
        continue;
      }
    }
    if (args.offline_only && !snapshot.offline) continue;
    if (
      args.color_label !== undefined &&
      snapshot.colorLabel !== args.color_label
    ) {
      continue;
    }
    if (extension) {
      const pathOrName = String(snapshot.mediaPath || snapshot.name).toLocaleLowerCase();
      if (!pathOrName.endsWith(`.${extension}`)) continue;
    }
    matches.push(snapshot);
    if (matches.length >= args.max_results) break;
  }
  return { count: matches.length, items: matches };
}

async function getTimelineGaps(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  const sequenceEnd = secondsOf(await sequence.getEndTime());
  const matches = await collectTrackItems(sequence, { trackType: args.track_type });
  const grouped = new Map();
  const requestedTypes =
    args.track_type === "both" ? ["video", "audio"] : [args.track_type];
  for (const trackType of requestedTypes) {
    const count =
      trackType === "video"
        ? await sequence.getVideoTrackCount()
        : await sequence.getAudioTrackCount();
    for (let trackIndex = 0; trackIndex < count; trackIndex += 1) {
      grouped.set(`${trackType}:${trackIndex}`, []);
    }
  }
  for (const match of matches) {
    const key = `${match.trackType}:${match.trackIndex}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(await readTrackItemSnapshot(match));
  }
  const gaps = [];
  for (const [key, clips] of grouped) {
    clips.sort((left, right) => left.startSeconds - right.startSeconds);
    const [trackType, indexText] = key.split(":");
    let cursor = 0;
    for (const clip of clips) {
      if (clip.startSeconds - cursor >= args.min_gap_seconds && clip.startSeconds > cursor) {
        gaps.push({
          trackType,
          trackIndex: Number(indexText),
          startSeconds: cursor,
          endSeconds: clip.startSeconds,
          durationSeconds: clip.startSeconds - cursor
        });
      }
      cursor = Math.max(cursor, clip.endSeconds);
    }
    if (sequenceEnd - cursor >= args.min_gap_seconds && sequenceEnd > cursor) {
      gaps.push({
        trackType,
        trackIndex: Number(indexText),
        startSeconds: cursor,
        endSeconds: sequenceEnd,
        durationSeconds: sequenceEnd - cursor
      });
    }
  }
  return { sequence: String(sequence.name || ""), gapCount: gaps.length, gaps };
}

async function offlineMedia() {
  const project = await getActiveProject();
  const entries = await collectProjectItems(project);
  const items = [];
  for (const entry of entries) {
    const snapshot = await readProjectItemSnapshot(entry.item, { path: entry.path });
    if (snapshot.offline) items.push(snapshot);
  }
  return { count: items.length, items };
}

async function getUsedMediaReport(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  const matches = await collectTrackItems(sequence, { trackType: "both" });
  const byId = new Map();
  for (const match of matches) {
    let snapshot;
    try {
      snapshot = await readProjectItemSnapshot(await match.item.getProjectItem());
    } catch (_error) {
      continue;
    }
    const key = snapshot.id || snapshot.mediaPath || snapshot.name;
    if (!byId.has(key)) {
      byId.set(key, { ...snapshot, useCount: 0, uses: [] });
    }
    const record = byId.get(key);
    record.useCount += 1;
    record.uses.push({
      nodeId: match.nodeId,
      trackType: match.trackType,
      trackIndex: match.trackIndex
    });
  }
  return {
    sequence: String(sequence.name || ""),
    uniqueMediaCount: byId.size,
    items: Array.from(byId.values())
  };
}

async function getAllProjectPaths() {
  const project = await getActiveProject();
  const entries = await collectProjectItems(project);
  const paths = new Set();
  for (const entry of entries) {
    const snapshot = await readProjectItemSnapshot(entry.item);
    if (snapshot.mediaPath) paths.add(snapshot.mediaPath);
  }
  return Array.from(paths).sort();
}

async function usedProjectItemIds(project) {
  const used = new Set();
  for (const sequence of Array.from((await project.getSequences()) || [])) {
    for (const match of await collectTrackItems(sequence, { trackType: "both" })) {
      try {
        const item = await match.item.getProjectItem();
        used.add(String((await item.getId()) || ""));
      } catch (_error) {
        // Generated items without project items are outside cleanup reports.
      }
    }
  }
  return used;
}

async function getUnusedMedia() {
  const project = await getActiveProject();
  const used = await usedProjectItemIds(project);
  const entries = await collectProjectItems(project);
  const items = [];
  for (const entry of entries) {
    const snapshot = await readProjectItemSnapshot(entry.item, { path: entry.path });
    if (
      ["clip", "file", "compound"].includes(snapshot.type) &&
      snapshot.id &&
      !used.has(snapshot.id)
    ) {
      items.push(snapshot);
    }
  }
  return { count: items.length, items };
}

async function getDuplicateMedia() {
  const project = await getActiveProject();
  const entries = await collectProjectItems(project);
  const grouped = new Map();
  for (const entry of entries) {
    const snapshot = await readProjectItemSnapshot(entry.item, { path: entry.path });
    const key = String(snapshot.mediaPath || "").toLocaleLowerCase();
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(snapshot);
  }
  const groups = Array.from(grouped.entries())
    .filter(([, items]) => items.length > 1)
    .map(([mediaPath, items]) => ({ mediaPath, count: items.length, items }));
  return { duplicatePathCount: groups.length, groups };
}

module.exports = {
  category: "inspection",
  handlers: [
    { name: "get_full_project_overview", writes: false, validate: validateNoArgs, execute: getFullProjectOverview },
    { name: "get_bin_contents", writes: false, validate: validateBinContents, execute: getBinContents },
    { name: "get_full_sequence_info", writes: false, validate: validateSequenceArgs, execute: getFullSequenceInfo },
    { name: "get_full_clip_info", writes: false, validate: validateNodeId, execute: getFullClipInfo },
    { name: "get_project_item_info", writes: false, validate: validateItemId, execute: getProjectItemInfo },
    { name: "search_project_items", writes: false, validate: validateSearch, execute: searchProjectItems },
    { name: "get_timeline_gaps", writes: false, validate: validateGaps, execute: getTimelineGaps },
    { name: "get_offline_media", writes: false, validate: validateNoArgs, execute: offlineMedia },
    { name: "check_offline_media", writes: false, validate: validateNoArgs, execute: offlineMedia },
    { name: "get_used_media_report", writes: false, validate: validateSequenceArgs, execute: getUsedMediaReport },
    { name: "get_all_project_paths", writes: false, validate: validateNoArgs, execute: getAllProjectPaths },
    { name: "get_unused_media", writes: false, validate: validateNoArgs, execute: getUnusedMedia },
    { name: "get_duplicate_media", writes: false, validate: validateNoArgs, execute: getDuplicateMedia }
  ]
};
