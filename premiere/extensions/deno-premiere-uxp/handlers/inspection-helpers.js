const {
  guidText,
  listComponents,
  listParams,
  ppro,
  projectItemId,
  readValue,
  secondsOf,
  serializeComponentValue
} = require("./shared.js");

async function projectItemKind(item) {
  const itemTypes = ppro().ProjectItem || {};
  const type = await readValue(item, "type");
  if (type === itemTypes.TYPE_ROOT) return "root";
  if (type === itemTypes.TYPE_BIN) return "bin";

  try {
    const clip = ppro().ClipProjectItem.cast(item);
    if (clip && (await clip.isSequence())) return "sequence";
  } catch (_error) {
    // Generic project items may not cast to ClipProjectItem.
  }
  if (type === itemTypes.TYPE_CLIP) return "clip";
  if (type === itemTypes.TYPE_COMPOUND) return "compound";
  if (type === itemTypes.TYPE_FILE) return "file";
  if (type === itemTypes.TYPE_STYLE) return "style";
  return "unknown";
}

async function readProjectItemSnapshot(item, options) {
  const settings = options || {};
  const id = await projectItemId(item);
  const kind = await projectItemKind(item);
  const result = {
    nodeId: id,
    id,
    name: String(item.name || ""),
    type: kind
  };
  if (settings.path) result.binPath = settings.path;

  try {
    const parent = await Promise.resolve(item.getParentBin());
    if (parent) result.parentBin = String(parent.name || "");
  } catch (_error) {
    // Root and virtual entries can omit a parent.
  }

  if (!["clip", "compound", "file", "sequence"].includes(kind)) {
    const label = await readValue(item, "getColorLabelIndex");
    if (label !== undefined) result.colorLabel = Number(label);
    return result;
  }

  let clip = null;
  try {
    clip = ppro().ClipProjectItem.cast(item);
  } catch (_error) {
    clip = null;
  }
  if (!clip) return result;

  const fields = await Promise.all([
    readValue(clip, "getMediaFilePath"),
    readValue(clip, "isOffline"),
    readValue(clip, "hasProxy"),
    readValue(clip, "getProxyPath"),
    readValue(clip, "canProxy"),
    readValue(clip, "isMergedClip"),
    readValue(clip, "isMulticamClip"),
    readValue(clip, "getColorLabelIndex"),
    readValue(clip, "getContentType"),
    readValue(clip, "getOriginatingProjectPath")
  ]);
  const [
    mediaPath,
    offline,
    hasProxy,
    proxyPath,
    canProxy,
    merged,
    multicam,
    colorLabel,
    contentType,
    originatingProjectPath
  ] = fields;
  if (mediaPath !== undefined) result.mediaPath = String(mediaPath || "");
  if (offline !== undefined) result.offline = Boolean(offline);
  if (hasProxy !== undefined) result.hasProxy = Boolean(hasProxy);
  if (proxyPath !== undefined) result.proxyPath = String(proxyPath || "");
  if (canProxy !== undefined) result.canProxy = Boolean(canProxy);
  if (merged !== undefined) result.isMergedClip = Boolean(merged);
  if (multicam !== undefined) result.isMulticamClip = Boolean(multicam);
  if (colorLabel !== undefined) result.colorLabel = Number(colorLabel);
  if (contentType !== undefined) result.contentType = Number(contentType);
  if (originatingProjectPath) {
    result.originatingProjectPath = String(originatingProjectPath);
  }

  try {
    const media = await clip.getMedia();
    if (media) {
      result.mediaStartSeconds = secondsOf(media.start);
      result.durationSeconds = secondsOf(media.duration);
    }
  } catch (_error) {
    // Bins, generators, and stale items can have no Media object.
  }

  try {
    const interpretation = await clip.getFootageInterpretation();
    if (interpretation) {
      result.footageInterpretation = {
        frameRate: interpretation.getFrameRate(),
        pixelAspectRatio: interpretation.getPixelAspectRatio(),
        fieldType: interpretation.getFieldType(),
        alphaUsage: interpretation.getAlphaUsage(),
        ignoreAlpha: interpretation.getIgnoreAlpha(),
        invertAlpha: interpretation.getInvertAlpha(),
        inputLutId: interpretation.getInputLUTID()
      };
    }
  } catch (_error) {
    // Some generated or audio-only items have no footage interpretation.
  }

  return result;
}

async function readParamSnapshot(entry, options) {
  const settings = options || {};
  const param = entry.param;
  const result = {
    index: entry.index,
    name: entry.displayName,
    displayName: entry.displayName,
    timeVarying: Boolean(param.isTimeVarying())
  };
  try {
    result.keyframesSupported = Boolean(await param.areKeyframesSupported());
  } catch (_error) {
    result.keyframesSupported = false;
  }
  try {
    result.value = serializeComponentValue(await param.getStartValue());
  } catch (_error) {
    result.value = null;
  }

  if (settings.includeKeyframes && result.timeVarying) {
    const times = Array.from(param.getKeyframeListAsTickTimes() || []);
    result.keyframes = [];
    for (const time of times) {
      let keyframe = null;
      try {
        keyframe = param.getKeyframePtr(time);
      } catch (_error) {
        keyframe = null;
      }
      const key = {
        timeSeconds: secondsOf(time),
        value: keyframe
          ? serializeComponentValue(keyframe)
          : serializeComponentValue(await param.getValueAtTime(time))
      };
      if (keyframe && typeof keyframe.getTemporalInterpolationMode === "function") {
        try {
          key.interpolation = await keyframe.getTemporalInterpolationMode();
        } catch (_error) {
          // Value and time remain useful without interpolation metadata.
        }
      }
      result.keyframes.push(key);
    }
  }
  return result;
}

async function readComponentSnapshots(trackItem, options) {
  const listed = await listComponents(trackItem);
  const result = [];
  for (const componentEntry of listed.components) {
    const params = await listParams(componentEntry.component);
    const paramSnapshots = [];
    for (const paramEntry of params) {
      paramSnapshots.push(await readParamSnapshot(paramEntry, options));
    }
    result.push({
      index: componentEntry.index,
      displayName: componentEntry.displayName,
      matchName: componentEntry.matchName,
      properties: paramSnapshots
    });
  }
  return result;
}

async function readTrackItemSnapshot(match, options) {
  const item = match.item;
  const [name, start, end, duration, inPoint, outPoint, speed, reversed, disabled,
    selected, adjustment] = await Promise.all([
      readValue(item, "getName"),
      readValue(item, "getStartTime"),
      readValue(item, "getEndTime"),
      readValue(item, "getDuration"),
      readValue(item, "getInPoint"),
      readValue(item, "getOutPoint"),
      readValue(item, "getSpeed"),
      readValue(item, "isSpeedReversed"),
      readValue(item, "isDisabled"),
      readValue(item, "getIsSelected"),
      readValue(item, "isAdjustmentLayer")
    ]);
  const result = {
    nodeId: match.nodeId,
    name: String(name || ""),
    trackType: match.trackType,
    trackIndex: match.trackIndex,
    clipIndex: match.clipIndex,
    startSeconds: secondsOf(start),
    endSeconds: secondsOf(end),
    durationSeconds: secondsOf(duration),
    inPointSeconds: secondsOf(inPoint),
    outPointSeconds: secondsOf(outPoint),
    enabled: disabled === undefined ? true : !Boolean(disabled),
    selected: Boolean(selected),
    adjustmentLayer: Boolean(adjustment)
  };
  if (speed !== undefined) result.speed = Number(speed);
  if (reversed !== undefined) result.reverse = Boolean(reversed);

  try {
    const projectItem = await item.getProjectItem();
    result.projectItem = await readProjectItemSnapshot(projectItem);
    result.projectItemId = result.projectItem.id;
    result.mediaPath = result.projectItem.mediaPath || "";
  } catch (_error) {
    result.projectItem = null;
  }

  if (options && options.includeEffects) {
    result.effects = await readComponentSnapshots(item, {
      includeKeyframes: Boolean(options.includeKeyframes)
    });
  }
  return result;
}

async function readSequenceSettingsSnapshot(sequence) {
  const settings = await sequence.getSettings();
  const frameRate = settings.getVideoFrameRate();
  const [videoRect, previewRect, audioRate, audioChannels, audioType, pixelAspect,
    fieldType, editingMode, maxQuality, maxDepth, linear, videoDisplay, audioDisplay,
    previewCodec, previewFormat] = await Promise.all([
      settings.getVideoFrameRect(),
      settings.getPreviewFrameRect(),
      settings.getAudioSampleRate(),
      settings.getAudioChannelCount(),
      settings.getAudioChannelType(),
      settings.getVideoPixelAspectRatio(),
      settings.getVideoFieldType(),
      settings.getEditingMode(),
      settings.getMaxRenderQuality(),
      settings.getMaximumBitDepth(),
      settings.getCompositeInLinearColor(),
      settings.getVideoDisplayFormat(),
      settings.getAudioDisplayFormat(),
      settings.getPreviewCodec(),
      settings.getPreviewFileFormat()
    ]);
  return {
    width: Number(videoRect.width),
    height: Number(videoRect.height),
    frameRate: Number(frameRate.value),
    ticksPerFrame: Number(frameRate.ticksPerFrame),
    pixelAspectRatio: String(pixelAspect),
    fieldType: Number(fieldType),
    audioSampleRate: Number(audioRate && audioRate.value),
    audioChannelCount: Number(audioChannels),
    audioChannelType: Number(audioType),
    editingMode: String(editingMode || ""),
    maximumRenderQuality: Boolean(maxQuality),
    maximumBitDepth: Boolean(maxDepth),
    compositeInLinearColor: Boolean(linear),
    videoDisplayFormat: Number(videoDisplay && videoDisplay.type),
    audioDisplayFormat: Number(audioDisplay && audioDisplay.type),
    previewCodec: String(previewCodec || ""),
    previewFileFormat: String(previewFormat || ""),
    previewWidth: Number(previewRect && previewRect.width),
    previewHeight: Number(previewRect && previewRect.height)
  };
}

async function readSequenceBasicSnapshot(sequence) {
  const [end, inPoint, outPoint, zeroPoint, playhead, videoTracks, audioTracks] =
    await Promise.all([
      sequence.getEndTime(),
      sequence.getInPoint(),
      sequence.getOutPoint(),
      sequence.getZeroPoint(),
      sequence.getPlayerPosition(),
      sequence.getVideoTrackCount(),
      sequence.getAudioTrackCount()
    ]);
  return {
    name: String(sequence.name || ""),
    id: guidText(sequence.guid),
    durationSeconds: secondsOf(end),
    inPointSeconds: secondsOf(inPoint),
    outPointSeconds: secondsOf(outPoint),
    zeroPointSeconds: secondsOf(zeroPoint),
    playheadSeconds: secondsOf(playhead),
    videoTrackCount: Number(videoTracks),
    audioTrackCount: Number(audioTracks)
  };
}

module.exports = {
  projectItemKind,
  readComponentSnapshots,
  readProjectItemSnapshot,
  readSequenceBasicSnapshot,
  readSequenceSettingsSnapshot,
  readTrackItemSnapshot
};
