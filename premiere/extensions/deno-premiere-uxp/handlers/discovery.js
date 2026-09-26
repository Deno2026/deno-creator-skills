const { BridgeError } = require("./errors.js");
const {
  collectTrackItems,
  enumArg,
  findSequence,
  getActiveProject,
  getPremiereBuildNumber,
  getPremiereVersion,
  guidText,
  numberArg,
  ppro,
  rejectUnknown,
  requireTrackItem,
  stringArg,
  validateNoArgs,
  validateSequenceArgs
} = require("./shared.js");
const {
  readComponentSnapshots,
  readProjectItemSnapshot,
  readSequenceBasicSnapshot,
  readSequenceSettingsSnapshot,
  readTrackItemSnapshot
} = require("./inspection-helpers.js");

function validateListProjectItems(args) {
  rejectUnknown(args, ["bin_path"]);
  return {
    bin_path: stringArg(args.bin_path, "bin_path", {
      optional: true,
      fallback: undefined
    })
  };
}

function validateNodeId(args) {
  rejectUnknown(args, ["node_id"]);
  return { node_id: stringArg(args.node_id, "node_id") };
}

function validateClipAtPosition(args) {
  rejectUnknown(args, ["time_seconds", "track_index", "track_type"]);
  return {
    time_seconds: numberArg(args.time_seconds, "time_seconds", { min: 0 }),
    track_index: numberArg(args.track_index, "track_index", {
      integer: true,
      min: 0
    }),
    track_type: enumArg(args.track_type, "track_type", ["video", "audio"])
  };
}

async function getProjectInfo() {
  const project = await getActiveProject();
  const [root, sequences, active] = await Promise.all([
    project.getRootItem(),
    project.getSequences(),
    project.getActiveSequence()
  ]);
  const rootItems = root ? await root.getItems() : [];
  const sequenceCount = Array.from(sequences || []).length;
  const rootItemCount = Array.from(rootItems || []).length;
  let activeSequence = null;
  if (active) {
    const [videoTracks, audioTracks] = await Promise.all([
      active.getVideoTrackCount(),
      active.getAudioTrackCount()
    ]);
    activeSequence = {
      name: String(active.name || ""),
      id: guidText(active.guid),
      videoTracks: Number(videoTracks),
      audioTracks: Number(audioTracks)
    };
  }
  return {
    name: String(project.name || ""),
    path: String(project.path || ""),
    id: guidText(project.guid),
    numSequences: sequenceCount,
    numItems: rootItemCount,
    rootItemCount,
    sequenceCount,
    activeSequence
  };
}

async function listProjectItems(args) {
  const project = await getActiveProject();
  let target = await project.getRootItem();
  if (args.bin_path) {
    const parts = args.bin_path.split("/").filter((part) => part.length > 0);
    for (const part of parts) {
      const children = Array.from((await target.getItems()) || []);
      let next = null;
      for (const child of children) {
        if (String(child.name || "") !== part) continue;
        try {
          next = ppro().FolderItem.cast(child);
        } catch (_error) {
          next = null;
        }
        if (next) break;
      }
      if (!next) {
        throw new BridgeError("BIN_NOT_FOUND", `Bin not found: ${args.bin_path}`);
      }
      target = next;
    }
  }

  const children = Array.from((await target.getItems()) || []);
  const items = [];
  for (const child of children) {
    const snapshot = await readProjectItemSnapshot(child);
    items.push({
      nodeId: snapshot.nodeId,
      name: snapshot.name,
      type:
        snapshot.type === "bin"
          ? "bin"
          : snapshot.type === "sequence"
            ? "sequence"
            : ["clip", "file"].includes(snapshot.type)
              ? "clip"
              : "unknown",
      mediaPath: snapshot.mediaPath || ""
    });
  }
  return items;
}

async function listSequences() {
  const project = await getActiveProject();
  const sequences = Array.from((await project.getSequences()) || []);
  const active = await project.getActiveSequence();
  const activeId = active ? guidText(active.guid) : "";
  const result = [];
  for (const sequence of sequences) {
    const snapshot = await readSequenceBasicSnapshot(sequence);
    snapshot.active = snapshot.id === activeId;
    result.push(snapshot);
  }
  return result;
}

async function getActiveSequence() {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const [basic, frameSize, videoTrackCount, audioTrackCount] = await Promise.all([
    readSequenceBasicSnapshot(sequence),
    sequence.getFrameSize(),
    sequence.getVideoTrackCount(),
    sequence.getAudioTrackCount()
  ]);
  const videoTracks = [];
  for (let index = 0; index < videoTrackCount; index += 1) {
    const track = await sequence.getVideoTrack(index);
    const matches = await collectTrackItems(sequence, {
      trackType: "video",
      trackIndex: index
    });
    const clips = [];
    for (const match of matches) {
      const snapshot = await readTrackItemSnapshot(match);
      clips.push({
        nodeId: snapshot.nodeId,
        name: snapshot.name,
        start: snapshot.startSeconds,
        end: snapshot.endSeconds,
        inPoint: snapshot.inPointSeconds,
        outPoint: snapshot.outPointSeconds,
        duration: snapshot.durationSeconds
      });
    }
    videoTracks.push({
      index,
      name: String(track.name || ""),
      numClips: clips.length,
      clips
    });
  }
  const audioTracks = [];
  for (let index = 0; index < audioTrackCount; index += 1) {
    const track = await sequence.getAudioTrack(index);
    const matches = await collectTrackItems(sequence, {
      trackType: "audio",
      trackIndex: index
    });
    const clips = [];
    for (const match of matches) {
      const snapshot = await readTrackItemSnapshot(match);
      clips.push({
        nodeId: snapshot.nodeId,
        name: snapshot.name,
        start: snapshot.startSeconds,
        end: snapshot.endSeconds,
        duration: snapshot.durationSeconds
      });
    }
    audioTracks.push({
      index,
      name: String(track.name || ""),
      numClips: clips.length,
      clips
    });
  }
  return {
    name: basic.name,
    id: basic.id,
    frameSizeHorizontal: Number(frameSize.width),
    frameSizeVertical: Number(frameSize.height),
    end: basic.durationSeconds,
    videoTracks,
    audioTracks,
    durationSeconds: basic.durationSeconds,
    videoTrackCount: Number(videoTrackCount),
    audioTrackCount: Number(audioTrackCount)
  };
}

async function listSequenceTracks(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  const tracks = [];
  const clipType = ppro().Constants.TrackItemType.CLIP;
  const videoCount = await sequence.getVideoTrackCount();
  for (let index = 0; index < videoCount; index += 1) {
    const track = await sequence.getVideoTrack(index);
    const numClips = Array.from(track.getTrackItems(clipType, false) || []).length;
    const isMuted = Boolean(await track.isMuted());
    tracks.push({
      type: "video",
      index,
      name: String(track.name || ""),
      numClips,
      isMuted,
      isLocked: null,
      id: Number(track.id),
      muted: isMuted,
      clipCount: numClips,
      locked: null,
      targeted: null
    });
  }
  const audioCount = await sequence.getAudioTrackCount();
  for (let index = 0; index < audioCount; index += 1) {
    const track = await sequence.getAudioTrack(index);
    const numClips = Array.from(track.getTrackItems(clipType, false) || []).length;
    const isMuted = Boolean(await track.isMuted());
    tracks.push({
      type: "audio",
      index,
      name: String(track.name || ""),
      numClips,
      isMuted,
      id: Number(track.id),
      muted: isMuted,
      clipCount: numClips,
      locked: null,
      targeted: null
    });
  }
  return tracks;
}

async function getClipProperties(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await requireTrackItem(sequence, args.node_id);
  return readTrackItemSnapshot(match, { includeEffects: false });
}

async function getSequenceSettings(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  const [settings, timebase] = await Promise.all([
    readSequenceSettingsSnapshot(sequence),
    sequence.getTimebase()
  ]);
  return {
    name: String(sequence.name || ""),
    id: guidText(sequence.guid),
    timebase: String(timebase || ""),
    ...settings
  };
}

async function getSelectedClips() {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const matches = await collectTrackItems(sequence, { trackType: "both" });
  const result = [];
  for (const match of matches) {
    if (await match.item.getIsSelected()) {
      result.push(await readTrackItemSnapshot(match));
    }
  }
  return result;
}

async function getClipAtPosition(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const matches = await collectTrackItems(sequence, {
    trackType: args.track_type,
    trackIndex: args.track_index
  });
  for (const match of matches) {
    const snapshot = await readTrackItemSnapshot(match);
    if (
      snapshot.startSeconds <= args.time_seconds &&
      args.time_seconds < snapshot.endSeconds
    ) {
      return snapshot;
    }
  }
  throw new BridgeError(
    "CLIP_NOT_FOUND",
    `No clip found at position ${args.time_seconds} on ${args.track_type} track ${args.track_index}`
  );
}

async function getClipSpeed(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await requireTrackItem(sequence, args.node_id);
  const [clipName, speed, reverse] = await Promise.all([
    match.item.getName(),
    match.item.getSpeed(),
    match.item.isSpeedReversed()
  ]);
  return {
    nodeId: match.nodeId,
    clipName: String(clipName || ""),
    speed: Number(speed),
    speedPercent: Number(speed) * 100,
    reversed: Boolean(reverse),
    reverse: Boolean(reverse)
  };
}

async function getClipAdjustmentLayer(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await requireTrackItem(sequence, args.node_id);
  const [clipName, adjustmentLayer] = await Promise.all([
    match.item.getName(),
    match.item.isAdjustmentLayer()
  ]);
  return {
    nodeId: match.nodeId,
    clipName: String(clipName || ""),
    isAdjustmentLayer: Boolean(adjustmentLayer),
    adjustmentLayer: Boolean(adjustmentLayer)
  };
}

async function getLinkedItems(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const sourceMatch = await requireTrackItem(sequence, args.node_id);
  const sourceItem = await sourceMatch.item.getProjectItem();
  const sourceId = String((await sourceItem.getId()) || "");
  const matches = await collectTrackItems(sequence, { trackType: "both" });
  const linked = [];
  for (const match of matches) {
    try {
      const item = await match.item.getProjectItem();
      if (String((await item.getId()) || "") === sourceId) {
        linked.push(await readTrackItemSnapshot(match));
      }
    } catch (_error) {
      // Generated timeline items without a source are not same-source matches.
    }
  }
  return {
    sourceProjectItemId: sourceId,
    semantic: "same-source-project-item",
    count: linked.length,
    items: linked
  };
}

async function getMogrtComponent(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await requireTrackItem(sequence, args.node_id);
  return {
    nodeId: match.nodeId,
    components: await readComponentSnapshots(match.item, {
      includeKeyframes: true
    }),
    semantic: "generic-component-chain"
  };
}

async function getVersionInfo() {
  const version = await getPremiereVersion();
  return {
    version,
    buildNumber: await getPremiereBuildNumber(version)
  };
}

async function getInsertionBin() {
  const project = await getActiveProject();
  const item = await project.getInsertionBin();
  return readProjectItemSnapshot(item);
}

module.exports = {
  category: "discovery",
  handlers: [
    { name: "get_project_info", writes: false, validate: validateNoArgs, execute: getProjectInfo },
    { name: "list_project_items", writes: false, validate: validateListProjectItems, execute: listProjectItems },
    { name: "list_sequences", writes: false, validate: validateNoArgs, execute: listSequences },
    { name: "get_active_sequence", writes: false, validate: validateNoArgs, execute: getActiveSequence },
    { name: "list_sequence_tracks", writes: false, validate: validateSequenceArgs, execute: listSequenceTracks },
    { name: "get_clip_properties", writes: false, validate: validateNodeId, execute: getClipProperties },
    { name: "get_sequence_settings", writes: false, validate: validateSequenceArgs, execute: getSequenceSettings },
    { name: "get_selected_clips", writes: false, validate: validateNoArgs, execute: getSelectedClips },
    { name: "get_clip_at_position", writes: false, validate: validateClipAtPosition, execute: getClipAtPosition },
    { name: "get_clip_speed", writes: false, validate: validateNodeId, execute: getClipSpeed },
    { name: "get_clip_adjustment_layer", writes: false, validate: validateNodeId, execute: getClipAdjustmentLayer },
    { name: "get_linked_items", writes: false, validate: validateNodeId, execute: getLinkedItems },
    { name: "get_mogrt_component", writes: false, validate: validateNodeId, execute: getMogrtComponent },
    { name: "get_version_info", writes: false, validate: validateNoArgs, execute: getVersionInfo },
    { name: "get_insertion_bin", writes: false, validate: validateNoArgs, execute: getInsertionBin }
  ]
};
