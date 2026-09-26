import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const TICKS_PER_SECOND = 254016000000;

const NEW_OFFICIAL_BEHAVIOR_NAMES = Object.freeze([
  "add_to_render_queue",
  "batch_apply_effect",
  "batch_enable_disable",
  "batch_rename_clips",
  "clear_custom_property",
  "delete_multiple_project_items",
  "export_open_timeline_io",
  "get_active_production_scratch_disks",
  "get_app_preference",
  "get_custom_properties",
  "get_installed_mogrt_path",
  "get_media_encoder_info",
  "get_project_ingest_settings",
  "get_project_item_lut_info",
  "get_project_panel_selection",
  "has_object_mask",
  "has_transcript",
  "import_clip_transcript_json",
  "import_mogrt_from_library",
  "is_after_effects_installed",
  "is_done_analyzing_video_effects",
  "is_premiere_project",
  "launch_media_encoder",
  "list_media_encoder_events",
  "list_premiere_events",
  "list_transcription_languages",
  "manage_proxies",
  "move_clip",
  "move_items_to_bin",
  "open_file_in_source_monitor",
  "open_sequence",
  "pause_growing_media",
  "remove_selected_clips",
  "rename_caption_track",
  "set_app_preference",
  "set_caption_track_mute",
  "set_encoder_xmp_options",
  "set_project_ingest_enabled",
  "set_project_item_input_lut_id",
  "set_project_scratch_disk_mode",
  "set_sequence_audio_settings",
  "set_source_monitor_position",
  "start_batch_encode",
  "subscribe_premiere_events",
  "unsubscribe_premiere_events",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tickTime(seconds) {
  return {
    seconds,
    ticks: String(Math.round(seconds * TICKS_PER_SECOND)),
  };
}

function loadCommonJs(entryPath, injectedModules) {
  const cache = new Map();

  function load(filePath) {
    const resolved = path.resolve(filePath);
    if (cache.has(resolved)) return cache.get(resolved).exports;

    const module = { exports: {} };
    cache.set(resolved, module);
    const source = readFileSync(resolved, "utf8");
    const localRequire = (specifier) => {
      if (Object.hasOwn(injectedModules, specifier)) {
        return injectedModules[specifier];
      }
      if (!specifier.startsWith("./")) {
        throw new Error(`Unexpected offline handler dependency: ${specifier}`);
      }
      const childPath = path.resolve(path.dirname(resolved), specifier);
      return load(path.extname(childPath) ? childPath : `${childPath}.js`);
    };
    const wrapper = vm.runInNewContext(
      `(function(require, module, exports) {\n${source}\n})`,
      { console, setTimeout, clearTimeout },
      { filename: resolved },
    );
    wrapper(localRequire, module, module.exports);
    return module.exports;
  }

  return load(entryPath);
}

export async function runOfflineHandlerSelfTest(repositoryRoot) {
  const transactions = [];
  const editorCalls = [];
  const importedCalls = [];
  const mockCalls = [];
  const exportCalls = [];
  const captureFiles = new Map();
  const selectionAddCalls = [];
  const metadataSchemaCalls = [];
  const markerItems = [];
  const encoderCalls = [];
  const encoderEventListeners = new Map();
  const targetEventListeners = [];
  const globalEventListeners = [];
  const removedTargetEventListeners = [];
  const removedGlobalEventListeners = [];
  const converterCalls = [];
  const sceneEditDetectionCalls = [];
  const aafOptionCalls = [];
  const appPreferenceCalls = [];
  let projectLocked = false;
  let playheadSeconds = 0;
  let sourceMonitorPositionSeconds = 2.25;
  let sourceMonitorOpenedPath = "";
  let videoTrackMuted = false;
  let audioTrackMuted = false;
  let sequenceSelection = [];
  let failFirstEmptySelectionOutside = true;
  let proxyAttached = true;
  let proxyPath = "E:\\mock\\overlay_proxy.mov";
  let projectIngestEnabled = false;
  let growingMediaPaused = false;
  let activeSequenceState = null;
  let projectItemInputLutId = "DENO-INPUT-LUT-INITIAL";
  const projectItemEmbeddedLutId = "DENO-EMBEDDED-LUT";
  const transcriptMockState = {
    hasTranscript: true,
    json: JSON.stringify({ language: "ko-KR", segments: [{ text: "before" }] }),
  };
  const appPreferences = new Map([
    ["auto-peak-generation", "false"],
    ["import-workspace", "true"],
    ["show-quickstart-dialog", "false"],
  ]);
  const projectCustomProperties = new Map([
    ["deno.note", "clear me"],
    ["deno.count", 7],
    ["deno.ratio", 1.25],
    ["deno.enabled", true],
  ]);
  let footageInterpretationState = {
    frameRate: 30,
    pixelAspectRatio: 1,
    fieldType: 0,
    alphaUsage: 10,
    ignoreAlpha: false,
    invertAlpha: false,
    removePullDown: false,
    inputLutId: projectItemInputLutId,
    vrConform: 30,
    vrHorizontalView: 360,
    vrVerticalView: 180,
    vrLayout: 40,
  };
  let projectMetadataXml =
    "<metadata><Title>Overlay</Title><premierePrivateProjectMetaData:Column.Intrinsic.Description>Old description</premierePrivateProjectMetaData:Column.Intrinsic.Description></metadata>";

  function mockAction(kind, apply) {
    return {
      apply() {
        mockCalls.push(kind);
        if (apply) apply();
      },
    };
  }

  function requireProjectLock(operation) {
    if (!projectLocked) {
      throw new Error(`Requires locked access: ${operation}`);
    }
  }

  function mockParam(displayName, startValue, initialKeyframes = []) {
    let value = startValue;
    let timeVarying = initialKeyframes.length > 0;
    const keyframes = initialKeyframes.map((entry) => ({
      value: entry.value,
      position: tickTime(entry.timeSeconds),
      getTemporalInterpolationMode() {
        return entry.interpolation || "linear";
      },
    }));
    return {
      displayName,
      getStartValue() {
        return value;
      },
      areKeyframesSupported() {
        return true;
      },
      isTimeVarying() {
        return timeVarying;
      },
      getKeyframeListAsTickTimes() {
        return keyframes.map((entry) => entry.position);
      },
      getKeyframePtr(time) {
        return keyframes.find((entry) => entry.position.ticks === time.ticks) || null;
      },
      getValueAtTime(time) {
        return this.getKeyframePtr(time)?.value ?? value;
      },
      createKeyframe(nextValue) {
        return {
          value: nextValue,
          position: tickTime(0),
          getTemporalInterpolationMode() {
            return "linear";
          },
        };
      },
      createSetValueAction(keyframe) {
        return mockAction(`param:${displayName}:set`, () => {
          value = keyframe.value;
        });
      },
      createSetTimeVaryingAction(nextValue) {
        return mockAction(`param:${displayName}:time-varying`, () => {
          timeVarying = nextValue;
        });
      },
      createAddKeyframeAction(keyframe) {
        return mockAction(`param:${displayName}:add-keyframe`, () => {
          keyframes.push(keyframe);
          timeVarying = true;
        });
      },
      createRemoveKeyframeAction(time) {
        return mockAction(`param:${displayName}:remove-keyframe`, () => {
          const index = keyframes.findIndex((entry) => entry.position.ticks === time.ticks);
          if (index >= 0) keyframes.splice(index, 1);
        });
      },
      createRemoveKeyframeRangeAction(start, end) {
        return mockAction(`param:${displayName}:remove-keyframe-range`, () => {
          for (let index = keyframes.length - 1; index >= 0; index -= 1) {
            const seconds = keyframes[index].position.seconds;
            if (seconds >= start.seconds && seconds <= end.seconds) keyframes.splice(index, 1);
          }
        });
      },
      createSetInterpolationAtKeyframeAction() {
        return mockAction(`param:${displayName}:interpolation`);
      },
    };
  }

  function mockComponent(displayName, matchName, params) {
    return {
      getDisplayName() {
        return displayName;
      },
      getMatchName() {
        return matchName;
      },
      getParamCount() {
        return params.length;
      },
      getParam(index) {
        return params[index];
      },
    };
  }

  const opacityParam = mockParam("Opacity", 100, [
    { timeSeconds: 1, value: 80, interpolation: "linear" },
  ]);
  const scaleParam = mockParam("Scale", 100);
  const volumeParam = mockParam("Level", -3);
  const panParam = mockParam("Pan", 0);
  const videoComponents = [
    mockComponent("Opacity", "AE.ADBE Opacity", [opacityParam]),
    mockComponent("Motion", "AE.ADBE Motion", [scaleParam]),
  ];
  const audioComponents = [
    mockComponent("Volume", "AE.ADBE Volume", [volumeParam]),
    mockComponent("Panner", "AE.ADBE Panner", [panParam]),
  ];

  function componentChain(components) {
    return {
      getComponentCount() {
        return components.length;
      },
      getComponentAtIndex(index) {
        return components[index];
      },
      createAppendComponentAction(component) {
        return mockAction("component:append", () => components.push(component));
      },
      createInsertComponentAction(component, index) {
        return mockAction("component:insert", () => components.splice(index, 0, component));
      },
      createRemoveComponentAction(component) {
        return mockAction("component:remove", () => {
          const index = components.indexOf(component);
          if (index >= 0) components.splice(index, 1);
        });
      },
    };
  }

  function detachedFootageInterpretation() {
    const state = { ...footageInterpretationState };
    return {
      FIELD_TYPE_DEFAULT: 0,
      FIELD_TYPE_PROGRESSIVE: 1,
      FIELD_TYPE_UPPERFIRST: 2,
      FIELD_TYPE_LOWERFIRST: 3,
      ALPHACHANNEL_NONE: 10,
      ALPHACHANNEL_STRAIGHT: 11,
      ALPHACHANNEL_PREMULTIPLIED: 12,
      ALPHACHANNEL_IGNORE: 13,
      getFrameRate: () => state.frameRate,
      getPixelAspectRatio: () => state.pixelAspectRatio,
      getFieldType: () => state.fieldType,
      getAlphaUsage: () => state.alphaUsage,
      getIgnoreAlpha: () => state.ignoreAlpha,
      getInvertAlpha: () => state.invertAlpha,
      getRemovePullDown: () => state.removePullDown,
      getInputLUTID: () => state.inputLutId,
      getVrConform: () => state.vrConform,
      getVrHorzView: () => state.vrHorizontalView,
      getVrVertView: () => state.vrVerticalView,
      getVrLayout: () => state.vrLayout,
      setFrameRate(value) {
        state.frameRate = value;
        return true;
      },
      setPixelAspectRatio(value) {
        state.pixelAspectRatio = value;
        return true;
      },
      setFieldType(value) {
        state.fieldType = value;
        return true;
      },
      setAlphaUsage(value) {
        state.alphaUsage = value;
        return true;
      },
      setIgnoreAlpha(value) {
        state.ignoreAlpha = value;
        return true;
      },
      setInvertAlpha(value) {
        state.invertAlpha = value;
        return true;
      },
      setRemovePullDown(value) {
        state.removePullDown = value;
        return true;
      },
      setInputLUTID(value) {
        state.inputLutId = value;
        return true;
      },
      setVrConform(value) {
        state.vrConform = value;
        return true;
      },
      setVrHorzView(value) {
        state.vrHorizontalView = value;
        return true;
      },
      setVrVertView(value) {
        state.vrVerticalView = value;
        return true;
      },
      setVrLayout(value) {
        state.vrLayout = value;
        return true;
      },
      snapshot() {
        return { ...state };
      },
    };
  }

  const projectItem = {
    name: "overlay.mov",
    type: 1,
    getId() {
      return "project-item-1";
    },
    async getMediaFilePath() {
      return "E:\\mock\\overlay.mov";
    },
    getParentBin() {
      return rootItem;
    },
    async isSequence() {
      return false;
    },
    async isOffline() {
      return false;
    },
    async hasProxy() {
      return proxyAttached;
    },
    async getProxyPath() {
      return proxyPath;
    },
    async canProxy() {
      return true;
    },
    async attachProxy(nextPath, isHiRes, keepAudioConformed) {
      encoderCalls.push({ kind: "attach-proxy", nextPath, isHiRes, keepAudioConformed });
      proxyAttached = true;
      proxyPath = nextPath;
      return true;
    },
    async isMergedClip() {
      return false;
    },
    async isMulticamClip() {
      return false;
    },
    async getColorLabelIndex() {
      return this.colorLabelIndex ?? 2;
    },
    async getContentType() {
      return 0;
    },
    async getOriginatingProjectPath() {
      return "";
    },
    async getMedia() {
      return {
        start: tickTime(0),
        duration: tickTime(12),
        getStart() {
          return tickTime(0);
        },
        getDuration() {
          return tickTime(12);
        },
        createSetStartAction(value) {
          return mockAction("media:set-start", () => {
            mockCalls.push(`media:start:${value.seconds}`);
          });
        },
      };
    },
    async getInPoint() {
      return tickTime(0.5);
    },
    async getOutPoint() {
      return tickTime(8.5);
    },
    async getInputLUTID() {
      return projectItemInputLutId;
    },
    async getEmbeddedLUTID() {
      return projectItemEmbeddedLutId;
    },
    createSetInputLUTIDAction(value) {
      requireProjectLock("ClipProjectItem.createSetInputLUTIDAction");
      return mockAction("project-item:set-input-lut", () => {
        projectItemInputLutId = value;
        footageInterpretationState.inputLutId = value;
      });
    },
    async getFootageInterpretation() {
      return detachedFootageInterpretation();
    },
    createSetFootageInterpretationAction(interpretation) {
      requireProjectLock("ClipProjectItem.createSetFootageInterpretationAction");
      return mockAction("project-item:set-footage-interpretation", () => {
        footageInterpretationState = interpretation.snapshot();
        projectItemInputLutId = footageInterpretationState.inputLutId;
      });
    },
    createSetColorLabelAction(value) {
      return mockAction("project-item:set-color", () => {
        this.colorLabelIndex = value;
      });
    },
    createSetScaleToFrameSizeAction() {
      return mockAction("project-item:scale-to-frame");
    },
    createSetNameAction(value) {
      return mockAction("project-item:rename", () => {
        this.name = value;
      });
    },
  };
  let sourceMonitorItem = projectItem;
  const videoComponentChain = componentChain(videoComponents);
  const audioComponentChain = componentChain(audioComponents);
  let videoItemName = "overlay.mov";
  let videoItemDisabled = false;
  let videoItemStartSeconds = 2;
  const insertedMogrtItems = [];
  const videoItem = {
    nodeId: "video-node-1",
    async getName() {
      return videoItemName;
    },
    async getStartTime() {
      return tickTime(videoItemStartSeconds);
    },
    async getEndTime() {
      return tickTime(videoItemStartSeconds + 3);
    },
    async getDuration() {
      return tickTime(3);
    },
    async getInPoint() {
      return tickTime(0.5);
    },
    async getOutPoint() {
      return tickTime(3.5);
    },
    async getSpeed() {
      return 1;
    },
    async isSpeedReversed() {
      return false;
    },
    async isDisabled() {
      return videoItemDisabled;
    },
    async getIsSelected() {
      return sequenceSelection.includes(this);
    },
    async isAdjustmentLayer() {
      return false;
    },
    async getProjectItem() {
      return projectItem;
    },
    async getType() {
      return 1;
    },
    async getComponentChain() {
      return videoComponentChain;
    },
    createSetNameAction(value) {
      return mockAction("track-item:rename", () => {
        videoItemName = value;
      });
    },
    createSetDisabledAction(value) {
      return mockAction("track-item:disable", () => {
        videoItemDisabled = value;
      });
    },
    createMoveAction(offset) {
      requireProjectLock("VideoClipTrackItem.createMoveAction");
      return mockAction("track-item:move", () => {
        videoItemStartSeconds += offset.seconds;
      });
    },
    createSetEndAction(value) {
      return mockAction("track-item:set-end", () => {
        mockCalls.push(`video-item:end:${value.seconds}`);
      });
    },
    createAddVideoTransitionAction(transition, options) {
      return mockAction("transition:add", () => {
        mockCalls.push(`transition:${transition.matchName}:${options.duration.seconds}`);
      });
    },
    createRemoveVideoTransitionAction(position) {
      return mockAction("transition:remove", () => {
        mockCalls.push(`transition:remove:${position}`);
      });
    },
  };
  const audioItem = {
    nodeId: "audio-node-1",
    async getName() {
      return "overlay.mov";
    },
    async getProjectItem() {
      return projectItem;
    },
    async getStartTime() {
      return tickTime(2);
    },
    async getEndTime() {
      return tickTime(5);
    },
    async getDuration() {
      return tickTime(3);
    },
    async getInPoint() {
      return tickTime(0.5);
    },
    async getOutPoint() {
      return tickTime(3.5);
    },
    async getSpeed() {
      return 1;
    },
    async isSpeedReversed() {
      return false;
    },
    async isDisabled() {
      return false;
    },
    async getIsSelected() {
      return sequenceSelection.includes(this);
    },
    async isAdjustmentLayer() {
      return false;
    },
    async getType() {
      return 1;
    },
    async getComponentChain() {
      return audioComponentChain;
    },
    createSetEndAction(value) {
      return mockAction("track-item:set-end", () => {
        mockCalls.push(`audio-item:end:${value.seconds}`);
      });
    },
  };
  const extraVideoItems = [];
  function createBatchEffectTrackItem(index) {
    const components = [
      mockComponent("Opacity", "AE.ADBE Opacity", [mockParam("Opacity", 100)]),
    ];
    const chain = componentChain(components);
    return {
      nodeId: `batch-effect-video-${index}`,
      async getName() {
        return `Batch Effect ${index}`;
      },
      async getStartTime() {
        return tickTime(20 + index);
      },
      async getEndTime() {
        return tickTime(20.5 + index);
      },
      async getDuration() {
        return tickTime(0.5);
      },
      async getInPoint() {
        return tickTime(0);
      },
      async getOutPoint() {
        return tickTime(0.5);
      },
      async getSpeed() {
        return 1;
      },
      async isSpeedReversed() {
        return false;
      },
      async isDisabled() {
        return false;
      },
      async getIsSelected() {
        return false;
      },
      async isAdjustmentLayer() {
        return false;
      },
      async getType() {
        return 1;
      },
      async getProjectItem() {
        return projectItem;
      },
      async getComponentChain() {
        return chain;
      },
    };
  }
  const videoTrack = {
    id: 101,
    name: "V1",
    getTrackItems() {
      return [videoItem, ...insertedMogrtItems, ...extraVideoItems];
    },
    async isMuted() {
      return videoTrackMuted;
    },
    async setMute(value) {
      videoTrackMuted = value;
      return true;
    },
    createSetNameAction(value) {
      return mockAction("video-track:rename", () => {
        this.name = value;
      });
    },
  };
  const audioTrack = {
    id: 201,
    name: "A1",
    getTrackItems() {
      return [audioItem];
    },
    async isMuted() {
      return audioTrackMuted;
    },
    async setMute(value) {
      audioTrackMuted = value;
      return true;
    },
    createSetNameAction(value) {
      return mockAction("audio-track:rename", () => {
        this.name = value;
      });
    },
  };
  const captionItem = {
    name: "caption-runtime-name",
    async getName() {
      return "SyntheticCaption";
    },
    async getMatchName() {
      return "SyntheticCaption";
    },
    async getStartTime() {
      return tickTime(1.25);
    },
    async getEndTime() {
      return tickTime(2.75);
    },
  };
  let captionTrackMuted = false;
  const captionTrack = {
    id: 301,
    name: "Subtitles 1",
    getTrackItems() {
      return [captionItem];
    },
    async isMuted() {
      return captionTrackMuted;
    },
    async setMute(value) {
      captionTrackMuted = value;
      return true;
    },
    createSetNameAction(value) {
      requireProjectLock("CaptionTrack.createSetNameAction");
      return mockAction("caption-track:set-name", () => {
        this.name = value;
      });
    },
  };
  let sequenceAudioSampleRate = 48000;
  const sequenceSettings = {
    getVideoFrameRate() {
      return { value: 30, ticksPerFrame: TICKS_PER_SECOND / 30 };
    },
    async getVideoFrameRect() {
      return { width: 1920, height: 1080 };
    },
    async getPreviewFrameRect() {
      return { width: 1280, height: 720 };
    },
    async getAudioSampleRate() {
      return { value: sequenceAudioSampleRate };
    },
    async getAudioChannelCount() {
      return 2;
    },
    async getAudioChannelType() {
      return 2;
    },
    async getVideoPixelAspectRatio() {
      return "1/1";
    },
    async getVideoFieldType() {
      return 0;
    },
    async getEditingMode() {
      return "custom";
    },
    async getMaxRenderQuality() {
      return true;
    },
    async getMaximumBitDepth() {
      return false;
    },
    async getCompositeInLinearColor() {
      return true;
    },
    async getVideoDisplayFormat() {
      return { type: 101 };
    },
    async getAudioDisplayFormat() {
      return { type: 201 };
    },
    async getPreviewCodec() {
      return "ap4h";
    },
    async getPreviewFileFormat() {
      return "QuickTime";
    },
    async setAudioSampleRate(frameRate) {
      sequenceAudioSampleRate = Number(frameRate && frameRate.value);
      return Number.isFinite(sequenceAudioSampleRate);
    },
  };
  const sequence = {
    name: "Mock Sequence",
    guid: "mock-sequence-guid",
    async getEndTime() {
      return tickTime(10);
    },
    async getInPoint() {
      return tickTime(0);
    },
    async getOutPoint() {
      return tickTime(10);
    },
    async getZeroPoint() {
      return tickTime(0);
    },
    async getFrameSize() {
      return { width: 1920, height: 1080 };
    },
    async getPlayerPosition() {
      return tickTime(playheadSeconds);
    },
    async getTimebase() {
      return "8467200000";
    },
    async setPlayerPosition(value) {
      playheadSeconds = value.seconds;
      return true;
    },
    async getVideoTrackCount() {
      return 1;
    },
    async getAudioTrackCount() {
      return 1;
    },
    async getVideoTrack() {
      return videoTrack;
    },
    async getAudioTrack() {
      return audioTrack;
    },
    async getCaptionTrackCount() {
      return 1;
    },
    async getCaptionTrack() {
      return captionTrack;
    },
    async getSelection() {
      return {
        items: sequenceSelection,
        getTrackItems() {
          return sequenceSelection;
        },
        addItem(item, skipDuplicateCheck) {
          selectionAddCalls.push({
            source: "current",
            item,
            skipDuplicateCheck,
            argumentCount: arguments.length,
            insideLockedAccess: projectLocked,
          });
          return false;
        },
      };
    },
    setSelection(selection) {
      sequenceSelection = Array.from(selection.items || []);
      return true;
    },
    async clearSelection() {
      sequenceSelection = [];
      return true;
    },
    async isDoneAnalyzingForVideoEffects() {
      return true;
    },
    async getSettings() {
      return sequenceSettings;
    },
    createSetSettingsAction(settings) {
      requireProjectLock("Sequence.createSetSettingsAction");
      return mockAction("sequence:set-settings", () => {
        assert(settings === sequenceSettings, "Sequence settings object escaped the mock.");
      });
    },
  };
  activeSequenceState = sequence;
  const rootChildren = [projectItem];
  const rootItem = {
    name: "Root",
    type: 0,
    _children: rootChildren,
    getId() {
      return "root-item";
    },
    async getItems() {
      return [...this._children];
    },
    createBinAction(name) {
      return mockAction("root:create-bin", () => mockCalls.push(`bin:${name}`));
    },
    createMoveItemAction(item, target) {
      requireProjectLock("FolderItem.createMoveItemAction");
      return mockAction("project-item:move-batch", () => {
        const index = this._children.indexOf(item);
        if (index >= 0) this._children.splice(index, 1);
        if (!target._children.includes(item)) target._children.push(item);
        item._setParent?.(target);
      });
    },
    createRemoveItemAction(item) {
      requireProjectLock("FolderItem.createRemoveItemAction");
      return mockAction("project-item:remove-batch", () => {
        const index = this._children.indexOf(item);
        if (index >= 0) this._children.splice(index, 1);
        item._setParent?.(null);
      });
    },
  };
  const project = {
    name: "Mock Project",
    path: "E:\\mock\\Mock Project.prproj",
    guid: "mock-project-guid",
    async getActiveSequence() {
      return activeSequenceState;
    },
    async getRootItem() {
      return rootItem;
    },
    async getSequences() {
      return [sequence];
    },
    async getInsertionBin() {
      return rootItem;
    },
    async importFiles(filePaths, suppressUi, targetBin, numberedStills) {
      importedCalls.push({ filePaths, suppressUi, targetBin, numberedStills });
      return true;
    },
    async save() {
      mockCalls.push("project:save");
      return true;
    },
    async openSequence(nextSequence) {
      activeSequenceState = nextSequence;
      mockCalls.push("project:open-sequence");
      return true;
    },
    async pauseGrowing(paused) {
      growingMediaPaused = paused;
      mockCalls.push(`project:pause-growing:${paused}`);
      return true;
    },
    lockedAccess(callback) {
      const previous = projectLocked;
      projectLocked = true;
      try {
        callback();
      } finally {
        projectLocked = previous;
      }
    },
    executeTransaction(callback, undoName) {
      requireProjectLock("executeTransaction");
      const actions = [];
      callback({
        addAction(action) {
          actions.push(action);
          return true;
        },
      });
      for (const action of actions) action.apply?.();
      transactions.push({ undoName, actionCount: actions.length });
      return true;
    },
  };
  function createMockMarker(name, type, start, duration, comments) {
    let markerName = name;
    let markerComments = comments;
    let markerType = type;
    let markerStart = start;
    let markerDuration = duration;
    let colorIndex = 0;
    const markerUrl = "https://example.test/review";
    const markerTarget = "_blank";
    return {
      guid: `mock-marker-${markerItems.length + 1}`,
      getName: () => markerName,
      getType: () => markerType,
      getStart: () => markerStart,
      getDuration: () => markerDuration,
      getComments: () => markerComments,
      getColorIndex: () => colorIndex,
      getUrl: () => markerUrl,
      getTarget: () => markerTarget,
      _setStart(value) {
        markerStart = value;
      },
      createSetNameAction(value) {
        requireProjectLock("Marker.createSetNameAction");
        return mockAction("marker:set-name", () => {
          markerName = value;
        });
      },
      createSetCommentsAction(value) {
        requireProjectLock("Marker.createSetCommentsAction");
        return mockAction("marker:set-comments", () => {
          markerComments = value;
        });
      },
      createSetColorByIndexAction(value) {
        requireProjectLock("Marker.createSetColorByIndexAction");
        return mockAction("marker:set-color", () => {
          colorIndex = value;
        });
      },
      createSetDurationAction(value) {
        requireProjectLock("Marker.createSetDurationAction");
        return mockAction("marker:set-duration", () => {
          markerDuration = value;
        });
      },
      createSetTypeAction(value) {
        requireProjectLock("Marker.createSetTypeAction");
        return mockAction("marker:set-type", () => {
          markerType = value;
        });
      },
    };
  }
  const markers = {
    createAddMarkerAction(name, type, start, duration, comments) {
      requireProjectLock("Markers.createAddMarkerAction");
      return mockAction("marker:add", () => {
        markerItems.push(createMockMarker(name, type, start, duration, comments));
      });
    },
    createRemoveMarkerAction(marker) {
      requireProjectLock("Markers.createRemoveMarkerAction");
      return mockAction("marker:remove", () => {
        const index = markerItems.indexOf(marker);
        if (index >= 0) markerItems.splice(index, 1);
      });
    },
    createMoveMarkerAction(marker, start) {
      requireProjectLock("Markers.createMoveMarkerAction");
      return mockAction("marker:move", () => marker._setStart(start));
    },
    getMarkers(filters) {
      assert(
        filters === undefined,
        "Marker filtering must stay local because Premiere 26.3.2 can crash the filtered overload.",
      );
      return markerItems;
    },
  };
  const editor = {
    createInsertProjectItemAction(item, time, videoTrackIndex, audioTrackIndex, limitShift) {
      editorCalls.push({
        kind: "insert",
        item,
        time,
        videoTrackIndex,
        audioTrackIndex,
        limitShift,
      });
      return {};
    },
    createRemoveItemsAction(selection, ripple, mediaType, shiftOverlapping) {
      requireProjectLock("SequenceEditor.createRemoveItemsAction");
      editorCalls.push({
        kind: "remove",
        selection,
        ripple,
        mediaType,
        shiftOverlapping,
      });
      return {};
    },
    insertMogrtFromPath(mogrtPath, time, trackIndex) {
      editorCalls.push({ kind: "mogrt", mogrtPath, time, trackIndex });
      let endSeconds = time.seconds + 5;
      const item = {
        nodeId: "mogrt-node-1",
        async getName() {
          return "Mock MOGRT";
        },
        async getStartTime() {
          return time;
        },
        async getEndTime() {
          return tickTime(endSeconds);
        },
        async getDuration() {
          return tickTime(endSeconds - time.seconds);
        },
        async getInPoint() {
          return tickTime(0);
        },
        async getOutPoint() {
          return tickTime(5);
        },
        async getSpeed() {
          return 1;
        },
        async isSpeedReversed() {
          return false;
        },
        async isDisabled() {
          return false;
        },
        async getIsSelected() {
          return false;
        },
        async isAdjustmentLayer() {
          return false;
        },
        async getProjectItem() {
          return projectItem;
        },
        async getComponentChain() {
          return videoComponentChain;
        },
        createSetEndAction(value) {
          return mockAction("mogrt:set-end", () => {
            endSeconds = value.seconds;
            mockCalls.push(`mogrt:end:${value.seconds}`);
          });
        },
      };
      insertedMogrtItems.push(item);
      return [item];
    },
    insertMogrtFromLibrary(libraryName, elementName, time, trackIndex) {
      editorCalls.push({
        kind: "mogrt-library",
        libraryName,
        elementName,
        time,
        trackIndex,
      });
      let endSeconds = time.seconds + 5;
      const item = {
        nodeId: "mogrt-library-node-1",
        async getName() {
          return "Library MOGRT";
        },
        async getStartTime() {
          return time;
        },
        async getEndTime() {
          return tickTime(endSeconds);
        },
        async getDuration() {
          return tickTime(endSeconds - time.seconds);
        },
        async getInPoint() {
          return tickTime(0);
        },
        async getOutPoint() {
          return tickTime(5);
        },
        async getSpeed() {
          return 1;
        },
        async isSpeedReversed() {
          return false;
        },
        async isDisabled() {
          return false;
        },
        async getIsSelected() {
          return false;
        },
        async isAdjustmentLayer() {
          return false;
        },
        async getProjectItem() {
          return projectItem;
        },
        async getComponentChain() {
          return videoComponentChain;
        },
        createSetEndAction(value) {
          return mockAction("mogrt-library:set-end", () => {
            endSeconds = value.seconds;
            mockCalls.push(`mogrt-library:end:${value.seconds}`);
          });
        },
      };
      insertedMogrtItems.push(item);
      return [item];
    },
  };

  class AddTransitionOptions {
    setApplyToStart(value) {
      this.applyToStart = value;
    }
    setDuration(value) {
      this.duration = value;
    }
    setForceSingleSided(value) {
      this.forceSingleSided = value;
    }
  }

  class AAFExportOptions {
    constructor() {
      this.mixdownVideo = true;
      this.explodeToMono = false;
      this.sampleRate = 48000;
      this.bitsPerSample = 16;
      this.embedAudio = false;
      this.audioFileFormat = 0;
      this.trimSources = false;
      this.handleFrames = 0;
      this.videoMixdownPresetPath = "";
      this.renderAudioEffects = false;
      this.interleaveWithoutEffects = false;
      this.preserveParentFolder = false;
    }
    setMixdownVideo(value) {
      this.mixdownVideo = value;
      aafOptionCalls.push({ method: "setMixdownVideo", value });
      return this;
    }
    setExplodeToMono(value) {
      this.explodeToMono = value;
      aafOptionCalls.push({ method: "setExplodeToMono", value });
      return this;
    }
    setSampleRate(value) {
      this.sampleRate = value;
      aafOptionCalls.push({ method: "setSampleRate", value });
      return this;
    }
    setBitsPerSample(value) {
      this.bitsPerSample = value;
      aafOptionCalls.push({ method: "setBitsPerSample", value });
      return this;
    }
    setEmbedAudio(value) {
      this.embedAudio = value;
      aafOptionCalls.push({ method: "setEmbedAudio", value });
      return this;
    }
    setAudioFileFormat(value) {
      this.audioFileFormat = value;
      aafOptionCalls.push({ method: "setAudioFileFormat", value });
      return this;
    }
    setTrimSources(value) {
      this.trimSources = value;
      aafOptionCalls.push({ method: "setTrimSources", value });
      return this;
    }
    setHandleFrames(value) {
      this.handleFrames = value;
      aafOptionCalls.push({ method: "setHandleFrames", value });
      return this;
    }
    setVideoMixdownPresetPath(value) {
      this.videoMixdownPresetPath = value;
      aafOptionCalls.push({ method: "setVideoMixdownPresetPath", value });
      return this;
    }
    setRenderAudioEffects(value) {
      this.renderAudioEffects = value;
      aafOptionCalls.push({ method: "setRenderAudioEffects", value });
      return this;
    }
    setInterleaveWithoutEffects(value) {
      this.interleaveWithoutEffects = value;
      aafOptionCalls.push({ method: "setInterleaveWithoutEffects", value });
      return this;
    }
    setPreserveParentFolder(value) {
      this.preserveParentFolder = value;
      aafOptionCalls.push({ method: "setPreserveParentFolder", value });
      return this;
    }
  }

  const scratchPaths = new Map([
    ["capture", "E:\\mock\\scratch\\capture"],
    ["audio-preview", "E:\\mock\\scratch\\audio-preview"],
    ["video-preview", "E:\\mock\\scratch\\video-preview"],
    ["auto-save", "E:\\mock\\scratch\\auto-save"],
    ["cc-libraries", "E:\\mock\\scratch\\cc-libraries"],
    ["capsule-media", "E:\\mock\\scratch\\capsule-media"],
  ]);
  const scratchDiskSettings = {
    getScratchDiskPath(type) {
      return scratchPaths.get(type) || "";
    },
    setScratchDiskPath(type, location) {
      scratchPaths.set(type, `E:\\mock\\${location}\\${type}`);
      return true;
    },
  };
  const ingestSettings = {
    async getIsIngestEnabled() {
      return projectIngestEnabled;
    },
    async setIngestEnabled(value) {
      projectIngestEnabled = value;
      return true;
    },
  };
  function emitEncoderEvent(eventName, payload) {
    for (const listener of encoderEventListeners.get(eventName) || []) {
      listener(payload);
    }
  }
  function emitGlobalEvent(eventName, payload) {
    for (const entry of globalEventListeners) {
      if (entry.eventName === eventName) entry.listener(payload);
    }
  }
  function emitTargetEvent(target, eventName, payload) {
    for (const entry of targetEventListeners) {
      if (entry.target === target && entry.eventName === eventName) {
        entry.listener(payload);
      }
    }
  }
  const encoderManager = {
    isAMEInstalled: true,
    async exportSequence(
      targetSequence,
      exportType,
      outputPath,
      presetPath,
      entireSequence,
    ) {
      encoderCalls.push({
        kind: "export-sequence",
        targetSequence,
        exportType,
        outputPath,
        presetPath,
        entireSequence,
      });
      emitEncoderEvent("render-queue", {
        jobID: "ame-job-1",
        progressAmount: 0,
        outputFiles: outputPath ? [outputPath] : [],
      });
      return true;
    },
    async startBatchEncode() {
      encoderCalls.push({ kind: "start-batch" });
      return true;
    },
    async launchEncoder() {
      encoderCalls.push({ kind: "launch" });
      return true;
    },
    async setEmbeddedXMPEnabled(value) {
      encoderCalls.push({ kind: "embedded-xmp", value });
      return true;
    },
    async setSidecarXMPEnabled(value) {
      encoderCalls.push({ kind: "sidecar-xmp", value });
      return true;
    },
  };

  const premierepro = {
    Constants: {
      TrackItemType: { CLIP: 1 },
      MediaType: { ANY: 1, VIDEO: 2, AUDIO: 3 },
      TransitionPosition: { START: "start", END: "end" },
      ExportType: {
        IMMEDIATELY: "immediate",
        QUEUE_TO_AME: "queue-to-ame",
        QUEUE_TO_APP: "queue-to-app",
      },
      ScratchDiskFolderType: {
        CAPTURE: "capture",
        AUDIO_PREVIEW: "audio-preview",
        VIDEO_PREVIEW: "video-preview",
        AUTO_SAVE: "auto-save",
        CCL_LIBRARIES: "cc-libraries",
        CAPSULE_MEDIA: "capsule-media",
      },
      ScratchDiskFolder: {
        SAME_AS_PROJECT: "same-as-project",
        MY_DOCUMENTS: "my-documents",
      },
      PreferenceKey: {
        AUTO_PEAK_GENERATION: "auto-peak-generation",
        IMPORT_WORKSPACE: "import-workspace",
        SHOW_QUICKSTART_DIALOG: "show-quickstart-dialog",
      },
      PropertyType: {
        PERSISTENT: "persistent",
        NON_PERSISTENT: "session",
      },
      AAFExportAudioFormat: { AIFF: 1, WAV: 2 },
      ProjectEvent: {
        OPENED: "project-opened",
        CLOSED: "project-closed",
        DIRTY: "project-dirty",
        ACTIVATED: "project-activated",
        PROJECT_ITEM_SELECTION_CHANGED: "project-item-selection-changed",
      },
      SequenceEvent: {
        ACTIVATED: "sequence-activated",
        CLOSED: "sequence-closed",
        SELECTION_CHANGED: "sequence-selection-changed",
      },
      OperationCompleteEvent: {
        IMPORT_MEDIA_COMPLETE: "import-media-complete",
        EXPORT_MEDIA_COMPLETE: "export-media-complete",
        EFFECT_DROP_COMPLETE: "effect-drop-complete",
        EFFECT_DRAG_OVER: "effect-drag-over",
        CLIP_EXTEND_REACHED: "clip-extend-reached",
        GENERATIVE_EXTEND_COMPLETE: "generative-extend-complete",
      },
      SnapEvent: {
        KEYFRAME: "snap-keyframe",
        RAZOR_PLAYHEAD: "snap-razor-playhead",
        RAZOR_MARKER: "snap-razor-marker",
        TRACKITEM: "snap-track-item",
        GUIDES: "snap-guides",
        PLAYHEAD_TRACKITEM: "snap-playhead-track-item",
      },
      VideoTrackEvent: {
        TRACK_CHANGED: "video-track-changed",
        INFO_CHANGED: "video-track-info-changed",
        LOCK_CHANGED: "video-track-lock-changed",
      },
      AudioTrackEvent: {
        TRACK_CHANGED: "audio-track-changed",
        INFO_CHANGED: "audio-track-info-changed",
        LOCK_CHANGED: "audio-track-lock-changed",
      },
    },
    Project: {
      async getActiveProject() {
        return project;
      },
      isProject(projectPath) {
        return String(projectPath).toLowerCase().endsWith(".prproj");
      },
    },
    ProjectItem: {
      TYPE_BIN: 2,
      TYPE_ROOT: 0,
      TYPE_CLIP: 1,
      TYPE_FILE: 4,
      TYPE_COMPOUND: 3,
    },
    FolderItem: {
      cast(item) {
        return item && (item.type === 0 || item.type === 2) ? item : null;
      },
    },
    ClipProjectItem: {
      cast(item) {
        return item === projectItem ? item : null;
      },
    },
    VideoClipTrackItem: { TRACKITEMTYPE_CLIP: 1 },
    AudioClipTrackItem: { TRACKITEMTYPE_CLIP: 1 },
    FootageInterpretation: {
      FIELD_TYPE_DEFAULT: 0,
      FIELD_TYPE_PROGRESSIVE: 1,
      FIELD_TYPE_UPPERFIRST: 2,
      FIELD_TYPE_LOWERFIRST: 3,
      ALPHACHANNEL_NONE: 10,
      ALPHACHANNEL_STRAIGHT: 11,
      ALPHACHANNEL_PREMULTIPLIED: 12,
      ALPHACHANNEL_IGNORE: 13,
    },
    TickTime: {
      TIME_ZERO: tickTime(0),
      TIME_MAX: tickTime(Number.MAX_SAFE_INTEGER / TICKS_PER_SECOND),
      createWithTicks(ticks) {
        return tickTime(Number(ticks) / TICKS_PER_SECOND);
      },
    },
    FrameRate: {
      createWithValue(value) {
        return { value };
      },
    },
    SequenceEditor: {
      getEditor() {
        return editor;
      },
      async getInstalledMogrtPath() {
        return "C:\\Program Files\\Adobe\\Common\\Motion Graphics Templates";
      },
    },
    TrackItemSelection: {
      createEmptySelection(callback) {
        callback({
          items: [],
          addItem(item, skipDuplicateCheck) {
            selectionAddCalls.push({
              source: "empty",
              item,
              skipDuplicateCheck,
              argumentCount: arguments.length,
              insideLockedAccess: projectLocked,
            });
            if (
              arguments.length !== 2 ||
              typeof skipDuplicateCheck !== "boolean"
            ) {
              return false;
            }
            if (!projectLocked && failFirstEmptySelectionOutside) {
              failFirstEmptySelectionOutside = false;
              return false;
            }
            this.items.push(item);
            return true;
          },
        });
        return true;
      },
    },
    Markers: {
      async getMarkers() {
        return markers;
      },
    },
    Marker: {
      MARKER_TYPE_COMMENT: "Comment",
      MARKER_TYPE_CHAPTER: "Chapter",
      MARKER_TYPE_FLVCUEPOINT: "FLVCuePoint",
      MARKER_TYPE_WEBLINK: "WebLink",
    },
    Application: { version: "26.3.0" },
    SourceMonitor: {
      async getProjectItem() {
        return sourceMonitorItem;
      },
      async getPosition() {
        return tickTime(sourceMonitorPositionSeconds);
      },
      async setPosition(value) {
        sourceMonitorPositionSeconds = value.seconds;
        return true;
      },
      async openFilePath(filePath) {
        sourceMonitorOpenedPath = filePath;
        return true;
      },
    },
    VideoFilterFactory: {
      async getDisplayNames() {
        return ["Gaussian Blur"];
      },
      async getMatchNames() {
        return ["AE.ADBE Gaussian Blur 2"];
      },
      async createComponent(matchName) {
        return mockComponent("Gaussian Blur", matchName, []);
      },
    },
    AudioFilterFactory: {
      async getDisplayNames() {
        return ["Parametric Equalizer"];
      },
      async createComponentByDisplayName(displayName) {
        return mockComponent(displayName, "AE.ADBE Parametric Equalizer", []);
      },
    },
    TransitionFactory: {
      async getVideoTransitionMatchNames() {
        return ["AE.ADBE Cross Dissolve New"];
      },
      createVideoTransition(matchName) {
        return { matchName };
      },
    },
    AddTransitionOptions,
    AAFExportOptions,
    SequenceUtils: {
      SEQUENCE_OPERATION_APPLYCUT: "apply-cut",
      SEQUENCE_OPERATION_CREATEMARKER: "create-marker",
      SEQUENCE_OPERATION_CREATESUBCLIP: "create-subclip",
      async performSceneEditDetectionOnSelection(operation, selection) {
        sceneEditDetectionCalls.push({ operation, selection });
        return true;
      },
    },
    ProjectUtils: {
      async getSelection(targetProject) {
        assert(targetProject === project, "ProjectUtils.getSelection target mismatch.");
        return {
          async getItems() {
            return [projectItem];
          },
        };
      },
      async getProjectViewIds() {
        return ["project-view-1"];
      },
      async getProjectFromViewId(viewId) {
        return viewId === "project-view-1" ? project : null;
      },
      async getSelectionFromViewId(viewId) {
        return {
          async getItems() {
            return viewId === "project-view-1" ? [projectItem] : [];
          },
        };
      },
    },
    AppPreference: {
      getValue(key) {
        return appPreferences.get(key) ?? "";
      },
      setValue(key, value, persistence) {
        appPreferenceCalls.push({ key, value, persistence });
        appPreferences.set(key, String(value));
        return true;
      },
    },
    PRProduction: {
      getActiveProduction() {
        return {
          async getScratchDiskSettings() {
            return scratchDiskSettings;
          },
        };
      },
    },
    Utils: {
      async isAEInstalled() {
        return true;
      },
    },
    Properties: {
      async getProperties(target) {
        const values = target === project ? projectCustomProperties : new Map();
        return {
          hasValue(propertyId) {
            return values.has(propertyId);
          },
          getValue(propertyId) {
            return String(values.get(propertyId) ?? "");
          },
          getValueAsInt(propertyId) {
            return Number.parseInt(values.get(propertyId), 10);
          },
          getValueAsFloat(propertyId) {
            return Number(values.get(propertyId));
          },
          getValueAsBool(propertyId) {
            return Boolean(values.get(propertyId));
          },
          createClearValueAction(propertyId) {
            requireProjectLock("Properties.createClearValueAction");
            return mockAction("properties:clear", () => values.delete(propertyId));
          },
        };
      },
    },
    ProjectSettings: {
      async getScratchDiskSettings() {
        return scratchDiskSettings;
      },
      async getIngestSettings() {
        return ingestSettings;
      },
      createSetIngestSettingsAction(targetProject, settings) {
        requireProjectLock("ProjectSettings.createSetIngestSettingsAction");
        return mockAction("project-settings:set-ingest", () => {
          assert(targetProject === project, "Wrong project in ingest settings action.");
          assert(settings === ingestSettings, "Wrong ingest settings action payload.");
        });
      },
      createSetScratchDiskSettingsAction(targetProject, settings) {
        requireProjectLock("ProjectSettings.createSetScratchDiskSettingsAction");
        return mockAction("project-settings:set-scratch", () => {
          assert(targetProject === project, "Wrong project in scratch settings action.");
          assert(settings === scratchDiskSettings, "Wrong scratch settings action payload.");
        });
      },
    },
    ObjectMaskUtils: {
      hasObjectMask(target) {
        return target === sequence;
      },
    },
    Transcript: {
      querySupportedLanguages() {
        return [
          { displayString: "English", languageCode: "en", locale: "en-US" },
          { displayString: "한국어", languageCode: "ko", locale: "ko-KR" },
        ];
      },
      hasTranscript(item) {
        return item === projectItem && transcriptMockState.hasTranscript;
      },
      importFromJSON(transcriptJson) {
        JSON.parse(transcriptJson);
        return { transcriptJson };
      },
      createImportTextSegmentsAction(textSegments, item) {
        requireProjectLock("Transcript.createImportTextSegmentsAction");
        return mockAction("transcript:import", () => {
          assert(item === projectItem, "Transcript import item mismatch.");
          transcriptMockState.hasTranscript = true;
          transcriptMockState.json = textSegments.transcriptJson;
        });
      },
      exportToJSON(item) {
        assert(item === projectItem, "Transcript export item mismatch.");
        return transcriptMockState.json;
      },
    },
    EventManager: {
      addEventListener(target, eventName, listener) {
        targetEventListeners.push({ target, eventName, listener });
        if (target === encoderManager) {
          if (!encoderEventListeners.has(eventName)) {
            encoderEventListeners.set(eventName, []);
          }
          encoderEventListeners.get(eventName).push(listener);
        }
      },
      removeEventListener(target, eventName, listener) {
        const index = targetEventListeners.findIndex(
          (entry) =>
            entry.target === target &&
            entry.eventName === eventName &&
            entry.listener === listener,
        );
        if (index >= 0) targetEventListeners.splice(index, 1);
        removedTargetEventListeners.push({ target, eventName, listener });
        if (target === encoderManager && encoderEventListeners.has(eventName)) {
          const listeners = encoderEventListeners.get(eventName);
          const listenerIndex = listeners.indexOf(listener);
          if (listenerIndex >= 0) listeners.splice(listenerIndex, 1);
          if (listeners.length === 0) encoderEventListeners.delete(eventName);
        }
      },
      addGlobalEventListener(eventName, listener) {
        globalEventListeners.push({ eventName, listener });
      },
      removeGlobalEventListener(eventName, listener) {
        const index = globalEventListeners.findIndex(
          (entry) => entry.eventName === eventName && entry.listener === listener,
        );
        if (index >= 0) globalEventListeners.splice(index, 1);
        removedGlobalEventListeners.push({ eventName, listener });
      },
    },
    Metadata: {
      METADATA_TYPE_INTEGER: 101,
      METADATA_TYPE_REAL: 202,
      METADATA_TYPE_TEXT: 303,
      METADATA_TYPE_BOOLEAN: 404,
      async getProjectMetadata() {
        return projectMetadataXml;
      },
      async getProjectColumnsMetadata() {
        return "<columns><Name>overlay.mov</Name></columns>";
      },
      async getXMPMetadata() {
        return "<xmp><dc:title>Overlay XMP</dc:title></xmp>";
      },
      createSetProjectMetadataAction(_item, value, changedFields) {
        return mockAction("metadata:set-project", () => {
          projectMetadataXml = value;
          mockCalls.push(`metadata:fields:${changedFields.join(",")}`);
        });
      },
      async addPropertyToProjectMetadataSchema(name, label, type) {
        metadataSchemaCalls.push({ name, label, type });
        return true;
      },
    },
    Exporter: {
      async exportSequenceFrame(_sequence, time, filename, directory, width, height) {
        const rawFilename = String(filename);
        const rawDirectory = String(directory);
        const normalizedFilename = String(filename).replace(/\\/g, "/");
        const normalizedDirectory = String(directory).replace(/\\/g, "/");
        const slash = normalizedFilename.lastIndexOf("/");
        const signatureValid =
          arguments.length === 6 &&
          slash > 0 &&
          normalizedDirectory === normalizedFilename.slice(0, slash + 1) &&
          normalizedDirectory.endsWith("/") &&
          Number.isFinite(width) &&
          Number.isFinite(height);
        exportCalls.push({
          time,
          filename,
          directory,
          width,
          height,
          argumentCount: arguments.length,
          signatureValid,
        });
        const basename = normalizedFilename.slice(normalizedFilename.lastIndexOf("/") + 1);
        if (basename.startsWith("deno_capture_")) {
          const backslashFullPath =
            rawFilename.includes("\\") &&
            rawDirectory.endsWith("\\") &&
            rawFilename === `${rawDirectory}${basename}`;
          const sequenceSize = width === 1920 && height === 1080;
          if (backslashFullPath && sequenceSize) {
            captureFiles.set(basename, 4096);
            return true;
          }
          return false;
        }
        if (!signatureValid) return false;
        return !normalizedFilename.endsWith("/force-fail.jpg");
      },
    },
    ProjectConverter: {
      async exportAAF(targetSequence, outputPath, options) {
        converterCalls.push({
          kind: "aaf",
          targetSequence,
          outputPath,
          options,
          argumentCount: arguments.length,
        });
        return true;
      },
      async exportAsOpenTimelineIO(targetSequence, outputPath, exportAsTitle) {
        converterCalls.push({
          kind: "otio",
          targetSequence,
          outputPath,
          exportAsTitle,
        });
        return true;
      },
    },
    EncoderManager: {
      EVENT_RENDER_QUEUE: "render-queue",
      EVENT_RENDER_PROGRESS: "render-progress",
      EVENT_RENDER_COMPLETE: "render-complete",
      EVENT_RENDER_ERROR: "render-error",
      EVENT_RENDER_CANCEL: "render-cancel",
      getManager() {
        return encoderManager;
      },
      async getExportFileExtension(_sequence, presetPath) {
        return presetPath.endsWith(".epr") ? "mov" : "";
      },
    },
  };

  const handlerIndex = path.join(
    repositoryRoot,
    "extensions",
    "deno-premiere-uxp",
    "handlers",
    "index.js",
  );
  const capturesFolder = {
    nativePath: "E:\\mock\\PluginData\\captures",
    isFolder: true,
    async getEntry(name) {
      if (!captureFiles.has(name)) throw new Error("Entry not found");
      return {
        name,
        isFile: true,
        async getMetadata() {
          return { size: captureFiles.get(name) };
        },
        async delete() {
          captureFiles.delete(name);
        },
      };
    },
  };
  const registry = loadCommonJs(handlerIndex, {
    uxp: {
      host: { version: "26.3.0" },
      storage: {
        localFileSystem: {
          async getDataFolder() {
            return {
              async getEntry(name) {
                if (name !== "captures") throw new Error("Entry not found");
                return capturesFolder;
              },
            };
          },
        },
      },
    },
    premierepro,
  });
  const names = registry.listHandlerNames();
  assert(names.length > 0, "Offline UXP handler registry is empty.");
  assert(new Set(names).size === names.length, "Offline UXP handler registry contains duplicate names.");
  for (const name of NEW_OFFICIAL_BEHAVIOR_NAMES) {
    assert(names.includes(name), `New official handler is not registered: ${name}`);
  }

  const writeNames = [];
  const dangerousNames = [];
  const categoryCounts = {};
  const behaviorTestedNames = new Set();
  for (const name of names) {
    const handler = registry.getHandler(name);
    assert(
      handler.writes === undefined || typeof handler.writes === "boolean",
      `Handler writes metadata is invalid: ${name}`,
    );
    if (Boolean(handler.writes)) writeNames.push(name);
    if (handler.dangerous) {
      assert(handler.writes, `Dangerous handler must also be a write: ${name}`);
      dangerousNames.push(name);
    }
    categoryCounts[handler.category] = (categoryCounts[handler.category] || 0) + 1;
  }

  async function call(name, args) {
    const handler = registry.getHandler(name);
    const result = await handler.execute(handler.validate(args), {
      async reportProgress() {},
    });
    behaviorTestedNames.add(name);
    return result;
  }

  async function expectCallError(name, args, expectedCode) {
    let failure = null;
    try {
      await call(name, args);
    } catch (error) {
      failure = error;
    }
    assert(
      failure?.code === expectedCode,
      `${name} must reject with ${expectedCode}; got ${failure?.code || "no error"}.`,
    );
    return failure;
  }

  const imported = await call("import_media", {
    file_paths: ["E:\\mock\\overlay.mov"],
    suppress_ui: false,
  });
  assert(imported.imported === 1 && importedCalls[0]?.suppressUi === false, "import_media mock failed.");

  const found = await call("find_project_item_by_name", { name: "overlay.mov" });
  assert(
    found.nodeId === "project-item-1" && found.mediaPath.endsWith("overlay.mov"),
    "find_project_item_by_name mock failed.",
  );

  const premiereState = await call("get_premiere_state", {});
  const versionInfo = await call("get_version_info", {});
  assert(
    premiereState.version === "26.3.0" &&
      Object.hasOwn(premiereState, "buildNumber") &&
      premiereState.buildNumber === null &&
      versionInfo.version === "26.3.0" &&
      versionInfo.buildNumber === null,
    "Premiere version/build-number null contract failed.",
  );
  const captionTracks = await call("get_caption_tracks", {});
  const caption = captionTracks.tracks?.[0]?.items?.[0];
  assert(
    captionTracks.captionTextAvailable === false &&
      caption?.text === null &&
      caption?.textAvailable === false &&
      caption?.kind === "SyntheticCaption" &&
      caption?.name === "caption-runtime-name" &&
      caption?.matchName === "SyntheticCaption" &&
      caption?.startSeconds === 1.25 &&
      caption?.endSeconds === 2.75,
    "get_caption_tracks must keep SyntheticCaption identity separate from unavailable text.",
  );

  const added = await call("add_to_timeline", {
    item_id: "project-item-1",
    track_index: 2,
    start_seconds: 4.5,
    audio_track_index: 1,
  });
  const insertCall = editorCalls.find((entry) => entry.kind === "insert");
  assert(
    added.added === true &&
      insertCall?.videoTrackIndex === 2 &&
      insertCall?.audioTrackIndex === 1 &&
      insertCall?.time.seconds === 4.5 &&
      insertCall?.limitShift === true,
    "add_to_timeline mock failed.",
  );

  const summary = await call("get_timeline_summary", {});
  assert(
    summary.totalClips === 2 &&
      summary.resolution === "1920x1080" &&
      summary.markerCount === 0 &&
      summary.videoTracks[0]?.locked === null &&
      summary.audioTracks[0]?.locked === null &&
      summary.effectUsage[0]?.name === "Opacity",
    "get_timeline_summary mock failed.",
  );

  const directVideoNodeId = videoItem.nodeId;
  delete videoItem.nodeId;
  const syntheticVideoNodeId = [
    "uxp",
    "video",
    0,
    0,
    "project-item-1",
    tickTime(2).ticks,
  ].join(":");
  let removed;
  try {
    removed = await call("remove_from_timeline", {
      node_id: syntheticVideoNodeId,
      ripple: false,
    });
  } finally {
    videoItem.nodeId = directVideoNodeId;
  }
  const removeCall = editorCalls.find((entry) => entry.kind === "remove");
  const removeStrategyOrder = [
    "current_selection_add_false_outside_locked_access",
    "current_selection_add_false_inside_locked_access",
    "empty_selection_add_false_outside_locked_access",
    "empty_selection_add_false_inside_locked_access",
  ];
  assert(
    removed.clipName === "overlay.mov" &&
      removed.removed === true &&
      removed.strategyUsed === removeStrategyOrder[3] &&
      JSON.stringify(removed.attempts.map((attempt) => attempt.strategy)) ===
        JSON.stringify(removeStrategyOrder) &&
      removed.attempts.slice(0, 3).every((attempt) => attempt.ok === false) &&
      removed.attempts[3]?.ok === true &&
      removed.attempts[0]?.meta?.addItemType === "function" &&
      removed.attempts[2]?.meta?.addItemReturnType === "boolean" &&
      removed.attempts[2]?.meta?.addItemReturnIsPromise === false &&
      removeCall?.mediaType === 2 &&
      removeCall?.selection?.items?.[0] === videoItem &&
      selectionAddCalls[0]?.item === videoItem &&
      selectionAddCalls[0]?.argumentCount === 2 &&
      selectionAddCalls[0]?.skipDuplicateCheck === false &&
      selectionAddCalls[2]?.source === "empty" &&
      selectionAddCalls[2]?.insideLockedAccess === false &&
      selectionAddCalls[3]?.source === "empty" &&
      selectionAddCalls[3]?.insideLockedAccess === true,
    "remove_from_timeline synthetic-ID/strategy-ladder mock failed.",
  );

  const playhead = await call("set_playhead_position", { time_seconds: 7.25 });
  assert(
    playhead.positionSeconds === 7.25 && playheadSeconds === 7.25,
    "set_playhead_position mock failed.",
  );

  const addedMarker = await call("add_marker", {
    time_seconds: 3,
    name: "Review",
    comments: "Mock marker",
    duration_seconds: 0.5,
  });
  assert(addedMarker.added === true && markerItems.length === 1, "add_marker mock failed.");
  const listedMarkers = await call("list_markers", {});
  assert(
    listedMarkers.length === 1 && listedMarkers[0].endSeconds === 3.5,
    "list_markers mock failed.",
  );
  const updatedMarker = await call("update_marker", {
    time_seconds: 3,
    name: "Updated Review",
    comments: "Updated mock marker",
    color: 5,
    new_time_seconds: 4.25,
    duration_seconds: 1.25,
    marker_type: "chapter",
  });
  const listedUpdatedMarkers = await call("list_markers", {});
  assert(
    updatedMarker.updated === true &&
      updatedMarker.before.url === "https://example.test/review" &&
      updatedMarker.before.target === "_blank" &&
      updatedMarker.after.startSeconds === 4.25 &&
      updatedMarker.after.durationSeconds === 1.25 &&
      updatedMarker.after.type === "Chapter" &&
      updatedMarker.after.url === updatedMarker.before.url &&
      updatedMarker.after.target === updatedMarker.before.target &&
      updatedMarker.urlTargetWritable === false &&
      listedUpdatedMarkers[0]?.name === "Updated Review" &&
      listedUpdatedMarkers[0]?.comments === "Updated mock marker" &&
      listedUpdatedMarkers[0]?.colorIndex === 5 &&
      listedUpdatedMarkers[0]?.startSeconds === 4.25 &&
      listedUpdatedMarkers[0]?.endSeconds === 5.5 &&
      listedUpdatedMarkers[0]?.type === "Chapter",
    "update_marker lockedAccess regression mock failed.",
  );

  let colorError = null;
  try {
    await call("add_marker", { time_seconds: 1, color: 6 });
  } catch (error) {
    colorError = error;
  }
  assert(
    colorError?.code === "MARKER_COLOR_NOT_ATOMIC" && markerItems.length === 1,
    "Colored marker safety preflight did not reject before mutation.",
  );

  // Discovery and inspection remain read-only and operate entirely on the
  // in-memory project/sequence graph above.
  const projectInfo = await call("get_project_info", {});
  assert(
    projectInfo.name === "Mock Project" &&
      projectInfo.rootItemCount === 1 &&
      projectInfo.sequenceCount === 1 &&
      projectInfo.numItems === 1 &&
      projectInfo.numSequences === 1 &&
      projectInfo.activeSequence?.videoTracks === 1 &&
      projectInfo.activeSequence?.audioTracks === 1,
    "get_project_info CEP parity mock failed.",
  );
  const rootBinContents = await call("get_bin_contents", {
    bin_id: "root-item",
    recursive: false,
  });
  const rootBinContentsByProjectId = await call("get_bin_contents", {
    bin_id: "mock-project-guid",
    recursive: false,
  });
  const rootBinContentsByProjectName = await call("get_bin_contents", {
    bin_id: "Mock Project",
    recursive: false,
  });
  assert(
    rootBinContents.bin?.nodeId === "root-item" &&
      rootBinContents.bin?.type === "root" &&
      rootBinContents.itemCount === 1 &&
      rootBinContents.items[0]?.nodeId === "project-item-1" &&
      rootBinContentsByProjectId.bin?.type === "root" &&
      rootBinContentsByProjectId.itemCount === 1 &&
      rootBinContentsByProjectName.bin?.type === "root" &&
      rootBinContentsByProjectName.itemCount === 1,
    "get_bin_contents root selector mock failed.",
  );
  const sequenceTracks = await call("list_sequence_tracks", {});
  assert(
    Array.isArray(sequenceTracks) &&
      sequenceTracks.length === 2 &&
      sequenceTracks[0]?.type === "video" &&
      sequenceTracks[0]?.numClips === 1 &&
      sequenceTracks[0]?.isMuted === false &&
      sequenceTracks[0]?.isLocked === null &&
      sequenceTracks[1]?.type === "audio",
    "list_sequence_tracks CEP parity mock failed.",
  );
  const listedProjectItems = await call("list_project_items", {});
  assert(
    Array.isArray(listedProjectItems) &&
      listedProjectItems.length === 1 &&
      listedProjectItems[0]?.nodeId === "project-item-1" &&
      listedProjectItems[0]?.type === "clip" &&
      listedProjectItems[0]?.mediaPath.endsWith("overlay.mov"),
    "list_project_items direct-child CEP parity mock failed.",
  );
  const activeSequence = await call("get_active_sequence", {});
  assert(
    activeSequence.name === "Mock Sequence" &&
      activeSequence.frameSizeHorizontal === 1920 &&
      activeSequence.frameSizeVertical === 1080 &&
      activeSequence.end === 10 &&
      activeSequence.videoTracks[0]?.clips[0]?.inPoint === 0.5 &&
      activeSequence.audioTracks[0]?.clips[0]?.duration === 3,
    "get_active_sequence detailed CEP parity mock failed.",
  );
  const clipSpeed = await call("get_clip_speed", { node_id: "video-node-1" });
  assert(
    clipSpeed.clipName === "overlay.mov" &&
      clipSpeed.speed === 1 &&
      clipSpeed.speedPercent === 100 &&
      clipSpeed.reversed === false &&
      clipSpeed.reverse === false,
    "get_clip_speed mock failed.",
  );
  const adjustmentLayer = await call("get_clip_adjustment_layer", {
    node_id: "video-node-1",
  });
  assert(
    adjustmentLayer.clipName === "overlay.mov" &&
      adjustmentLayer.isAdjustmentLayer === false &&
      adjustmentLayer.adjustmentLayer === false,
    "get_clip_adjustment_layer response parity mock failed.",
  );

  const searched = await call("search_project_items", { query: "overlay" });
  assert(
    searched.count === 1 && searched.items[0]?.mediaPath.endsWith("overlay.mov"),
    "search_project_items mock failed.",
  );
  const gaps = await call("get_timeline_gaps", {
    track_type: "both",
    min_gap_seconds: 0.5,
  });
  assert(
    gaps.gapCount === 4 && gaps.gaps.every((entry) => entry.durationSeconds >= 0.5),
    "get_timeline_gaps mock failed.",
  );

  // Project item, lifecycle, media, and metadata categories.
  const createdBin = await call("create_bin", { name: "Generated" });
  assert(
    createdBin.created === true && createdBin.parentBin === "Root",
    "create_bin mock failed.",
  );
  const foundByPath = await call("find_items_by_media_path", { path_search: "mock" });
  assert(
    foundByPath.count === 1 && foundByPath.items[0]?.nodeId === "project-item-1",
    "find_items_by_media_path mock failed.",
  );

  const savedProject = await call("save_project", {});
  assert(
    savedProject.saved === true && savedProject.path.endsWith("Mock Project.prproj"),
    "save_project mock failed.",
  );
  const scratch = await call("get_project_scratch_disks", {});
  assert(
    scratch.captured.endsWith("capture") && scratch.autoSave.endsWith("auto-save"),
    "get_project_scratch_disks mock failed.",
  );

  const proxy = await call("has_proxy", { item_id: "project-item-1" });
  assert(
    proxy.hasProxy === true && proxy.canProxy === true && proxy.proxyPath.endsWith("overlay_proxy.mov"),
    "has_proxy mock failed.",
  );
  const itemInfo = await call("get_item_info", { item_id: "project-item-1" });
  assert(
    itemInfo.id === "project-item-1" &&
      itemInfo.mediaStartSeconds === 0 &&
      itemInfo.durationSeconds === 12,
    "get_item_info stable Media.start/Media.duration mock failed.",
  );
  const scaledItem = await call("set_scale_to_frame_size", { item_id: "project-item-1" });
  assert(
    scaledItem.updated === true && mockCalls.includes("project-item:scale-to-frame"),
    "set_scale_to_frame_size mock failed.",
  );

  const metadata = await call("get_metadata", { item_id: "project-item-1" });
  assert(
    metadata.projectMetadata.includes("Overlay") &&
      metadata.xmpMetadata.includes("Overlay XMP") &&
      metadata.nodeId === "project-item-1" &&
      metadata.name === "overlay.mov" &&
      metadata.mediaPath.endsWith("overlay.mov") &&
      metadata.format === "raw-xml",
    "get_metadata mock failed.",
  );
  const metadataUpdated = await call("set_metadata", {
    item_id: "project-item-1",
    field_name: "Column.Intrinsic.Description",
    value: "Updated & verified",
  });
  assert(
    metadataUpdated.updated === true &&
      projectMetadataXml.includes(
        "<premierePrivateProjectMetaData:Column.Intrinsic.Description>Updated &amp; verified</premierePrivateProjectMetaData:Column.Intrinsic.Description>",
      ) &&
      !projectMetadataXml.includes("<Column.Intrinsic.Description>"),
    "set_metadata namespace-aware XML replacement failed.",
  );
  const colorBefore = await call("get_color_label", { item_id: "project-item-1" });
  assert(colorBefore.colorIndex === 2, "get_color_label mock failed.");
  const colorUpdated = await call("set_color_label", {
    item_id: "project-item-1",
    color_index: 15,
  });
  const colorAfter = await call("get_color_label", { item_id: "project-item-1" });
  assert(
    colorUpdated.updated === true && colorAfter.colorIndex === 15,
    "set_color_label mock failed.",
  );
  const customMetadata = await call("add_custom_metadata_field", {
    field_name: "DENOText",
    field_label: "DENO Text",
    field_type: 2,
  });
  assert(
    customMetadata.added === true && metadataSchemaCalls[0]?.type === 303,
    "add_custom_metadata_field semantic constant mapping failed.",
  );
  const footageBefore = await call("get_footage_interpretation", {
    item_id: "project-item-1",
  });
  const footageUpdated = await call("set_footage_interpretation", {
    item_id: "project-item-1",
    frame_rate: 23.976,
    pixel_aspect_ratio: 1.2,
    field_type: 1,
    remove_pull_down: true,
    alpha_usage: 11,
    ignore_alpha: false,
    invert_alpha: true,
    vr_conform: 31,
    vr_layout: 41,
    vr_horz_view: 180,
    vr_vert_view: 90,
    input_lut_id: "DENO-FOOTAGE-LUT",
  });
  assert(
    footageBefore.frameRate === 30 &&
      footageUpdated.updated === true &&
      footageUpdated.interpretation.frameRate === 23.976 &&
      footageUpdated.interpretation.pixelAspectRatio === 1.2 &&
      footageUpdated.interpretation.fieldType === 1 &&
      footageUpdated.interpretation.alphaUsage === 11 &&
      footageUpdated.interpretation.ignoreAlpha === false &&
      footageUpdated.interpretation.invertAlpha === true &&
      footageUpdated.interpretation.removePullDown === true &&
      footageUpdated.interpretation.vrConform === 31 &&
      footageUpdated.interpretation.vrLayout === 41 &&
      footageUpdated.interpretation.vrHorizontalView === 180 &&
      footageUpdated.interpretation.vrVerticalView === 90 &&
      footageUpdated.interpretation.inputLutId === "DENO-FOOTAGE-LUT",
    "set_footage_interpretation field/alpha/VR/LUT read-back mock failed.",
  );

  const lutInfo = await call("get_project_item_lut_info", {
    item_id: "project-item-1",
  });
  const exactLut = await call("set_project_item_input_lut_id", {
    item_id: "project-item-1",
    input_lut_id: "DENO-LUT-EXACT",
  });
  const clearedLut = await call("set_project_item_input_lut_id", {
    item_id: "project-item-1",
    input_lut_id: "",
  });
  const lutAfterClear = await call("get_project_item_lut_info", {
    item_id: "project-item-1",
  });
  assert(
    lutInfo.inputLutId === "DENO-FOOTAGE-LUT" &&
      lutInfo.embeddedLutId === "DENO-EMBEDDED-LUT" &&
      exactLut.previousInputLutId === "DENO-FOOTAGE-LUT" &&
      exactLut.inputLutId === "DENO-LUT-EXACT" &&
      exactLut.cleared === false &&
      clearedLut.previousInputLutId === "DENO-LUT-EXACT" &&
      clearedLut.inputLutId === "" &&
      clearedLut.cleared === true &&
      lutAfterClear.hasInputLut === false &&
      lutAfterClear.hasEmbeddedLut === true,
    "Project-item LUT exact/clear read-back mocks failed.",
  );

  // Selection, sequence, track, and playhead categories.
  const selectedAll = await call("select_all_clips", {});
  assert(
    selectedAll.selectedCount === 2 && sequenceSelection.length === 2,
    "select_all_clips mock failed.",
  );
  const deselected = await call("deselect_all_clips", {});
  assert(
    deselected.selectedCount === 0 && sequenceSelection.length === 0,
    "deselect_all_clips mock failed.",
  );

  const sequenceCount = await call("get_sequence_count", {});
  const totalClipCount = await call("get_total_clip_count", {});
  assert(
    sequenceCount.sequenceCount === 1 &&
      totalClipCount.totalClipCount === 2 &&
      totalClipCount.videoTrackCount === 1 &&
      totalClipCount.audioTrackCount === 1,
    "sequence count mocks failed.",
  );
  const sequenceSettingsSnapshot = await call("get_sequence_settings", {});
  const videoEffectsAnalysis = await call("is_done_analyzing_video_effects", {});
  assert(
    sequenceSettingsSnapshot.id === "mock-sequence-guid" &&
      sequenceSettingsSnapshot.timebase === "8467200000" &&
      sequenceSettingsSnapshot.frameRate === 30 &&
      sequenceSettingsSnapshot.audioSampleRate === 48000 &&
      sequenceSettingsSnapshot.previewWidth === 1280 &&
      sequenceSettingsSnapshot.previewHeight === 720 &&
      videoEffectsAnalysis.sequenceId === "mock-sequence-guid" &&
      videoEffectsAnalysis.doneAnalyzing === true,
    "Sequence settings timebase/video-analysis official mocks failed.",
  );

  sequenceSelection = [videoItem];
  const sceneCuts = await call("scene_edit_detection", {});
  const sceneMarkers = await call("scene_edit_detection", {
    operation: "create_markers",
  });
  const sceneSubclips = await call("scene_edit_detection", {
    operation: "create_subclips",
  });
  assert(
    sceneCuts.adobeOperation === "apply-cut" &&
      sceneMarkers.adobeOperation === "create-marker" &&
      sceneSubclips.adobeOperation === "create-subclip" &&
      sceneEditDetectionCalls.length === 3 &&
      JSON.stringify(sceneEditDetectionCalls.map((entry) => entry.operation)) ===
        JSON.stringify(["apply-cut", "create-marker", "create-subclip"]) &&
      sceneEditDetectionCalls.every((entry) => entry.selection.items[0] === videoItem),
    "scene_edit_detection official operation constants mock failed.",
  );
  sequenceSelection = [];
  await expectCallError("scene_edit_detection", {}, "NO_SELECTION");

  const trackInfo = await call("get_track_info", {
    track_type: "video",
    track_index: 0,
  });
  assert(
    trackInfo.name === "V1" && trackInfo.clipCount === 1 && trackInfo.clips[0]?.nodeId === "video-node-1",
    "get_track_info mock failed.",
  );
  const hiddenTrack = await call("toggle_track_visibility", {
    track_index: 0,
    visible: false,
  });
  assert(
    hiddenTrack.muted === true && videoTrackMuted === true,
    "toggle_track_visibility mock failed.",
  );

  const readPlayhead = await call("get_playhead_position", {});
  assert(
    readPlayhead.positionSeconds === 7.25 &&
      readPlayhead.seconds === 7.25 &&
      readPlayhead.ticks === String(Math.round(7.25 * TICKS_PER_SECOND)),
    "get_playhead_position CEP parity mock failed.",
  );

  // Source monitor reads, using an isolated in-memory source item.
  const sourceInfo = await call("get_source_monitor_info", {});
  const sourcePosition = await call("get_source_monitor_position", {});
  assert(
    sourceInfo.loaded === true &&
      sourceInfo.nodeId === "project-item-1" &&
      sourceInfo.itemId === "project-item-1" &&
      sourceInfo.inPoint === 0.5 &&
      sourceInfo.outPoint === 8.5 &&
      sourceInfo.durationSeconds === 12 &&
      sourcePosition.positionSeconds === 2.25 &&
      sourcePosition.seconds === 2.25 &&
      sourcePosition.ticks === String(Math.round(2.25 * TICKS_PER_SECOND)),
    "source-monitor mocks failed.",
  );
  sourceMonitorItem = null;
  const emptySourceInfo = await call("get_source_monitor_info", {});
  assert(
    emptySourceInfo.loaded === false && Object.keys(emptySourceInfo).length === 1,
    "get_source_monitor_info empty-state parity mock failed.",
  );
  sourceMonitorItem = projectItem;
  const openedSourceFile = await call("open_file_in_source_monitor", {
    file_path: "E:\\mock\\source clip.mov",
  });
  assert(
    openedSourceFile.opened === true &&
      openedSourceFile.hostAccepted === true &&
      openedSourceFile.filePath === "E:\\mock\\source clip.mov" &&
      openedSourceFile.extension === ".mov" &&
      openedSourceFile.positionSeconds === 2.25 &&
      openedSourceFile.itemId === "project-item-1" &&
      sourceMonitorOpenedPath === "E:\\mock\\source clip.mov",
    "open_file_in_source_monitor official path/read-back mock failed.",
  );
  await expectCallError(
    "open_file_in_source_monitor",
    { file_path: "E:\\mock\\not-media.txt" },
    "UNSUPPORTED_MEDIA_EXTENSION",
  );

  // Video effects and ComponentParam/keyframe behavior.
  const availableEffects = await call("list_available_effects", {});
  assert(
    availableEffects.count === 1 &&
      availableEffects.effects[0]?.matchName === "AE.ADBE Gaussian Blur 2" &&
      availableEffects.displayNames[0] === "Gaussian Blur" &&
      availableEffects.displayNamesPairedByIndex === false,
    "list_available_effects mock failed.",
  );
  const clipEffects = await call("list_clip_effects", { node_id: "video-node-1" });
  assert(
    clipEffects.effects.length === 2 && clipEffects.effects[0]?.name === "Opacity",
    "list_clip_effects mock failed.",
  );
  const appliedVideoEffect = await call("apply_effect", {
    node_id: "video-node-1",
    effect_name: "AE.ADBE Gaussian Blur 2",
    insert_index: 1,
  });
  assert(
    appliedVideoEffect.applied === true &&
      appliedVideoEffect.insertionMode === "insert" &&
      appliedVideoEffect.insertedIndex === 1 &&
      appliedVideoEffect.component.beforeComponentCount === 2 &&
      appliedVideoEffect.component.afterComponentCount === 3 &&
      videoComponents[1]?.getMatchName() === "AE.ADBE Gaussian Blur 2",
    "apply_effect insert_index/read-back mock failed.",
  );
  await expectCallError(
    "apply_effect",
    {
      node_id: "video-node-1",
      effect_name: "AE.ADBE Gaussian Blur 2",
      insert_index: 99,
    },
    "INVALID_ARGUMENTS",
  );
  assert(
    videoComponents.length === 3,
    "Rejected apply_effect insert_index must not mutate the component chain.",
  );

  sequenceSelection = [videoItem];
  const batchEffect = await call("batch_apply_effect", {
    media_type: "video",
    effect_match_name: "AE.ADBE Gaussian Blur 2",
    target: "selected",
    insert_index: 0,
  });
  assert(
    batchEffect.applied === true &&
      batchEffect.atomic === true &&
      batchEffect.count === 1 &&
      batchEffect.insertIndex === 0 &&
      batchEffect.items[0]?.nodeId === "video-node-1" &&
      batchEffect.items[0]?.component.index === 0,
    "batch_apply_effect one-item/insert-index mock failed.",
  );
  const batchEffectTransactionCount = transactions.filter(
    (entry) => entry.undoName === "DENO: batch_apply_effect",
  ).length;
  sequenceSelection = [];
  await expectCallError(
    "batch_apply_effect",
    {
      media_type: "video",
      effect_match_name: "AE.ADBE Gaussian Blur 2",
      target: "selected",
    },
    "INVALID_TARGET_COUNT",
  );
  extraVideoItems.push(
    ...Array.from({ length: 20 }, (_, index) => createBatchEffectTrackItem(index)),
  );
  await expectCallError(
    "batch_apply_effect",
    {
      media_type: "video",
      effect_match_name: "AE.ADBE Gaussian Blur 2",
      target: "track",
      track_index: 0,
    },
    "INVALID_TARGET_COUNT",
  );
  extraVideoItems.length = 0;
  assert(
    transactions.filter(
      (entry) => entry.undoName === "DENO: batch_apply_effect",
    ).length === batchEffectTransactionCount &&
      videoComponents.length === 4,
    "Empty/too-many batch_apply_effect targets must fail closed before mutation.",
  );
  const scale = await call("set_clip_scale", {
    node_id: "video-node-1",
    scale: 65,
  });
  assert(
    scale.updated === true && mockCalls.includes("param:Scale:set"),
    "set_clip_scale mock failed.",
  );
  let animatedStaticWriteError = null;
  try {
    await call("set_clip_opacity", {
      node_id: "video-node-1",
      opacity: 65,
    });
  } catch (error) {
    animatedStaticWriteError = error;
  }
  assert(
    animatedStaticWriteError?.code === "TIME_VARYING_PROPERTY",
    "Animated ComponentParam static-write guard failed.",
  );

  const effectProperties = await call("get_effect_properties", {
    node_id: "video-node-1",
    effect_name: "Opacity",
  });
  assert(
    effectProperties.properties.length === 1 &&
      effectProperties.properties[0]?.name === "Opacity",
    "get_effect_properties mock failed.",
  );
  const keyframesBefore = await call("get_keyframes", {
    node_id: "video-node-1",
    effect_name: "Opacity",
    property_name: "Opacity",
  });
  assert(
    keyframesBefore.keyframes.length === 1 && keyframesBefore.keyframes[0]?.timeSeconds === 1,
    "get_keyframes mock failed.",
  );
  const addedKeyframe = await call("add_keyframe", {
    node_id: "video-node-1",
    effect_name: "Opacity",
    property_name: "Opacity",
    time_seconds: 2,
    value: 50,
  });
  const keyframesAfter = await call("get_keyframes", {
    node_id: "video-node-1",
    effect_name: "Opacity",
    property_name: "Opacity",
  });
  assert(
    addedKeyframe.added === true && keyframesAfter.keyframes.length === 2,
    "add_keyframe mock failed.",
  );

  // Audio effects and track mute.
  const audioEffects = await call("list_available_audio_effects", {});
  assert(
    audioEffects.count === 1 && audioEffects.effects[0] === "Parametric Equalizer",
    "list_available_audio_effects mock failed.",
  );
  const appliedAudioEffect = await call("apply_audio_effect", {
    node_id: "audio-node-1",
    effect_name: "Parametric Equalizer",
    insert_index: 1,
  });
  assert(
    appliedAudioEffect.applied === true &&
      appliedAudioEffect.insertionMode === "insert" &&
      appliedAudioEffect.insertedIndex === 1 &&
      appliedAudioEffect.component.beforeComponentCount === 2 &&
      appliedAudioEffect.component.afterComponentCount === 3 &&
      audioComponents[1]?.getDisplayName() === "Parametric Equalizer",
    "apply_audio_effect insert_index/read-back mock failed.",
  );
  await expectCallError(
    "apply_audio_effect",
    {
      node_id: "audio-node-1",
      effect_name: "Parametric Equalizer",
      insert_index: 99,
    },
    "INVALID_ARGUMENTS",
  );
  assert(
    audioComponents.length === 3,
    "Rejected apply_audio_effect insert_index must not mutate the component chain.",
  );
  const volume = await call("set_clip_volume", {
    node_id: "audio-node-1",
    volume_db: -6,
  });
  assert(
    volume.updated === true &&
      volume.value === -6 &&
      Math.abs(volume.rawValue - 10 ** ((-6 - 15) / 20)) < 1e-12 &&
      mockCalls.includes("param:Level:set"),
    "set_clip_volume mock failed.",
  );
  const audioKeyframes = await call("add_audio_keyframes", {
    node_id: "audio-node-1",
    keyframes: [{ time_seconds: 1.5, level_db: 0 }],
  });
  assert(
    audioKeyframes.added === true &&
      audioKeyframes.keyframeCount === 1 &&
      audioKeyframes.keyframes[0]?.levelDb === 0 &&
      Math.abs(audioKeyframes.keyframes[0]?.rawValue - 10 ** ((0 - 15) / 20)) < 1e-12,
    "add_audio_keyframes dB conversion mock failed.",
  );
  const muted = await call("mute_track", { track_index: 0, muted: true });
  assert(
    muted.updated === true && audioTrackMuted === true,
    "mute_track mock failed.",
  );

  // Transition factory and Action path.
  const transitions = await call("list_available_transitions", {});
  assert(
    transitions.count === 1 && transitions.nameType === "matchName",
    "list_available_transitions mock failed.",
  );
  const transition = await call("add_transition_to_clip", {
    node_id: "video-node-1",
    transition_name: "AE.ADBE Cross Dissolve New",
    position: "end",
    duration_seconds: 0.5,
  });
  assert(
    transition.added === true && mockCalls.includes("transition:add"),
    "add_transition_to_clip mock failed.",
  );
  const removedTransition = await call("remove_transition", {
    node_id: "video-node-1",
    position: "end",
  });
  assert(
    removedTransition.removed === true &&
      mockCalls.includes("transition:remove") &&
      mockCalls.includes("transition:remove:end"),
    "remove_transition mock failed.",
  );
  const removeActionCount = mockCalls.filter(
    (entry) => entry === "transition:remove",
  ).length;
  for (const unverifiedPosition of ["start", "both"]) {
    let scopeError = null;
    try {
      await call("remove_transition", {
        node_id: "video-node-1",
        position: unverifiedPosition,
      });
    } catch (error) {
      scopeError = error;
    }
    assert(
      scopeError?.code === "UNVERIFIED_ARGUMENT_SCOPE",
      `remove_transition ${unverifiedPosition} must fail closed before live promotion.`,
    );
  }
  assert(
    mockCalls.filter((entry) => entry === "transition:remove").length ===
      removeActionCount,
    "Rejected remove_transition positions must not create a transition Action.",
  );

  // Export is mocked. capture_frame creates an in-memory file only for the
  // fifth strategy so path ordering and the sequence-size fallback are tested.
  const extension = await call("get_export_file_extension", {
    preset_path: "E:\\mock\\prores.epr",
  });
  assert(extension.extension === "mov", "get_export_file_extension mock failed.");
  const frame = await call("export_frame", {
    output_path: "E:\\mock\\frame.png",
    time_seconds: 4,
  });
  assert(
    frame.exported === true &&
      exportCalls[0]?.filename === "E:/mock/frame.png" &&
      exportCalls[0]?.directory === "E:/mock/" &&
      exportCalls[0]?.time.seconds === 4 &&
      exportCalls[0]?.signatureValid === true,
    "export_frame full-path signature mock failed.",
  );
  const capturedFrame = await call("capture_frame", { time_seconds: 4 });
  const captureStrategyOrder = [
    "full_path_backslash_trailing_dir_preview_size",
    "full_path_slash_trailing_dir_preview_size",
    "basename_slash_dir_no_trailing_preview_size",
    "basename_slash_dir_trailing_preview_size",
    "full_path_backslash_trailing_dir_sequence_size",
  ];
  assert(
    capturedFrame.captured === true &&
      capturedFrame.capturePath.startsWith("E:\\mock\\PluginData\\captures\\") &&
      capturedFrame.width === 1920 &&
      capturedFrame.height === 1080 &&
      capturedFrame.strategyUsed === captureStrategyOrder[4] &&
      JSON.stringify(capturedFrame.attempts.map((attempt) => attempt.strategy)) ===
        JSON.stringify(captureStrategyOrder) &&
      capturedFrame.attempts.slice(0, 4).every((attempt) => attempt.ok === false) &&
      capturedFrame.attempts[4]?.ok === true &&
      capturedFrame.attempts[0]?.meta?.file?.exists === false &&
      capturedFrame.attempts[4]?.meta?.file?.size === 4096 &&
      capturedFrame.attempts[4]?.meta?.frameSizeSource ===
        "sequence.getSettings().getVideoFrameRect" &&
      exportCalls[1]?.width === 1280 &&
      exportCalls[1]?.height === 720 &&
      exportCalls[5]?.width === 1920 &&
      exportCalls[5]?.height === 1080 &&
      exportCalls[5]?.filename === String(capturedFrame.capturePath) &&
      exportCalls[5]?.directory === "E:\\mock\\PluginData\\captures\\",
    "capture_frame path/dimension strategy-ladder mock failed.",
  );
  let frameFailure = null;
  try {
    await call("export_frame", {
      output_path: "E:\\mock\\force-fail.jpg",
      time_seconds: 4,
    });
  } catch (error) {
    frameFailure = error;
  }
  assert(
    frameFailure?.code === "FRAME_EXPORT_FAILED" &&
      frameFailure?.details?.filename === "E:/mock/force-fail.jpg" &&
      frameFailure?.details?.filepath === "E:/mock/" &&
      frameFailure?.details?.cause ===
        "Exporter.exportSequenceFrame() returned false",
    "Frame-export failure details mock failed.",
  );

  const mogrt = await call("import_mogrt", {
    mogrt_path: "E:\\mock\\overlay.mogrt",
    track_index: 0,
    start_seconds: 6,
  });
  assert(
    mogrt.imported === true &&
      mogrt.items[0]?.nodeId === "mogrt-node-1" &&
      editorCalls.some((entry) => entry.kind === "mogrt"),
    "import_mogrt mock failed.",
  );

  const chapterMarkers = await call("get_sequence_markers_by_type", {
    marker_type: "Chapter",
  });
  assert(chapterMarkers.length === 1, "get_sequence_markers_by_type mock failed.");
  const deletedMarker = await call("delete_marker", { time_seconds: 4.25 });
  assert(
    deletedMarker.deleted === true && markerItems.length === 0,
    "delete_marker lockedAccess regression mock failed.",
  );
  const sourceMarker = await call("add_marker_to_project_item", {
    item_id: "project-item-1",
    time_seconds: 1,
    name: "Source Review",
    comments: "Source marker lock test",
    duration_seconds: 0,
    type: "Comment",
  });
  assert(
    sourceMarker.added === true && markerItems.length === 1,
    "add_marker_to_project_item lockedAccess regression mock failed.",
  );

  // Timeline edit mutations run last so earlier category assertions retain the
  // original clip name/enabled state.
  const renamedClip = await call("rename_clip", {
    node_id: "video-node-1",
    new_name: "Renamed Overlay",
  });
  const disabledClip = await call("enable_disable_clip", {
    node_id: "video-node-1",
    enabled: false,
  });
  assert(
    renamedClip.oldName === "overlay.mov" &&
      videoItemName === "Renamed Overlay" &&
      disabledClip.enabled === false &&
      videoItemDisabled === true,
    "timeline-edit mocks failed.",
  );

  // Newly promoted official 26.3 surface. Every name in
  // NEW_OFFICIAL_BEHAVIOR_NAMES must complete at least one positive handler
  // call; representative bounds and fail-closed contracts are checked before
  // the corresponding mutation.
  await expectCallError(
    "remove_selected_clips",
    { ripple: false },
    "NO_TARGETS",
  );
  await expectCallError(
    "batch_enable_disable",
    { enabled: true, target: "selected" },
    "NO_TARGETS",
  );
  await expectCallError(
    "manage_proxies",
    {
      item_id: "project-item-1",
      action: "detach",
      proxy_path: "E:\\mock\\unsupported.mov",
    },
    "UNSUPPORTED_PROXY_ACTION",
  );
  await expectCallError(
    "set_sequence_audio_settings",
    { sample_rate: 0 },
    "INVALID_ARGUMENTS",
  );
  await expectCallError(
    "set_encoder_xmp_options",
    {},
    "INVALID_ARGUMENTS",
  );
  await expectCallError(
    "move_items_to_bin",
    {
      item_ids: Array.from({ length: 21 }, (_, index) => `overflow-${index}`),
      target_bin: "Batch Target",
    },
    "TARGET_LIMIT_EXCEEDED",
  );
  await expectCallError(
    "delete_multiple_project_items",
    {
      item_ids: Array.from({ length: 21 }, (_, index) => `overflow-${index}`),
    },
    "TARGET_LIMIT_EXCEEDED",
  );

  const attachedProxy = await call("manage_proxies", {
    item_id: "project-item-1",
    action: "attach",
    proxy_path: "E:\\mock\\proxy_v2.mov",
  });
  assert(
    attachedProxy.attached === true &&
      attachedProxy.count === 1 &&
      attachedProxy.items[0]?.pathMatches === true &&
      attachedProxy.items[0]?.proxyPath.endsWith("proxy_v2.mov"),
    "manage_proxies attach/read-back mock failed.",
  );

  const sequenceAudio = await call("set_sequence_audio_settings", {
    sample_rate: 44100,
  });
  assert(
    sequenceAudio.updated === true &&
      sequenceAudio.items[0]?.previousSampleRate === 48000 &&
      sequenceAudio.sampleRate === 44100 &&
      sequenceAudioSampleRate === 44100,
    "set_sequence_audio_settings read-back mock failed.",
  );

  const renamedCaptionTrack = await call("rename_caption_track", {
    sequence_id: "mock-sequence-guid",
    track_index: 0,
    name: "Korean Captions",
  });
  const mutedCaptionTrack = await call("set_caption_track_mute", {
    sequence_id: "mock-sequence-guid",
    track_index: 0,
    muted: true,
  });
  assert(
    renamedCaptionTrack.renamed === true &&
      renamedCaptionTrack.previousName === "Subtitles 1" &&
      renamedCaptionTrack.name === "Korean Captions" &&
      mutedCaptionTrack.updated === true &&
      mutedCaptionTrack.previousMuted === false &&
      mutedCaptionTrack.muted === true &&
      captionTrack.name === "Korean Captions" &&
      captionTrackMuted === true,
    "Caption-track official write/read-back mocks failed.",
  );
  const transcriptionLanguages = await call("list_transcription_languages", {});
  const transcriptState = await call("has_transcript", {
    item_id: "project-item-1",
  });
  assert(
    transcriptionLanguages.languageCount === 2 &&
      transcriptionLanguages.languages[1]?.locale === "ko-KR" &&
      transcriptState.itemId === "project-item-1" &&
      transcriptState.hasTranscript === true,
    "Transcript utility mocks failed.",
  );
  const transcriptMutationCount = mockCalls.filter(
    (entry) => entry === "transcript:import",
  ).length;
  await expectCallError(
    "import_clip_transcript_json",
    {
      item_id: "project-item-1",
      transcript_json: JSON.stringify({ language: "ko-KR", segments: [] }),
      replace_existing: false,
    },
    "TRANSCRIPT_ALREADY_EXISTS",
  );
  assert(
    mockCalls.filter((entry) => entry === "transcript:import").length ===
      transcriptMutationCount,
    "Transcript replacement rejection must fail before mutation.",
  );
  const transcriptJson = JSON.stringify({
    language: "ko-KR",
    segments: [{ start: 0, end: 1.5, text: "교체된 transcript" }],
  });
  const transcriptImported = await call("import_clip_transcript_json", {
    item_id: "project-item-1",
    transcript_json: transcriptJson,
    replace_existing: true,
  });
  assert(
    transcriptImported.imported === true &&
      transcriptImported.hadTranscript === true &&
      transcriptImported.replaceExisting === true &&
      transcriptImported.hasTranscript === true &&
      transcriptImported.readback.available === true &&
      transcriptImported.readback.summary?.validJson === true &&
      transcriptImported.readback.summary?.rootType === "object" &&
      transcriptMockState.json === transcriptJson,
    "import_clip_transcript_json replace/read-back mock failed.",
  );

  const panelSelection = await call("get_project_panel_selection", {
    scope: "active_project",
  });
  assert(
    panelSelection.scope === "active_project" &&
      panelSelection.viewCount === 1 &&
      panelSelection.selectionCount === 1 &&
      panelSelection.returnedCount === 1 &&
      panelSelection.views[0]?.items[0]?.itemId === "project-item-1" &&
      panelSelection.views[0]?.items[0]?.parentBinId === "root-item",
    "get_project_panel_selection official ProjectUtils mock failed.",
  );
  await expectCallError(
    "get_project_panel_selection",
    { scope: "unsupported" },
    "INVALID_ARGUMENTS",
  );

  const peakPreferenceBefore = await call("get_app_preference", {
    key: "auto_peak_generation",
  });
  const peakPreferenceAfter = await call("set_app_preference", {
    key: "auto_peak_generation",
    value: true,
    persistence: "persistent",
  });
  const peakPreferenceReadback = await call("get_app_preference", {
    key: "auto_peak_generation",
  });
  assert(
    peakPreferenceBefore.value === false &&
      peakPreferenceAfter.updated === true &&
      peakPreferenceAfter.previousValue === false &&
      peakPreferenceAfter.value === true &&
      peakPreferenceAfter.rawValue === "true" &&
      peakPreferenceAfter.readbackVerified === true &&
      peakPreferenceReadback.value === true &&
      peakPreferenceReadback.rawValue === "true" &&
      appPreferenceCalls[0]?.key === "auto-peak-generation" &&
      appPreferenceCalls[0]?.persistence === "persistent",
    "Application preference write/read-back mock failed.",
  );
  await expectCallError(
    "get_app_preference",
    { key: "unsupported" },
    "INVALID_ARGUMENTS",
  );

  const productionScratch = await call("get_active_production_scratch_disks", {});
  const afterEffects = await call("is_after_effects_installed", {});
  assert(
    productionScratch.active === true &&
      productionScratch.scratchDisks.capture?.path.endsWith("capture") &&
      productionScratch.scratchDisks.audio_preview?.path.endsWith("audio-preview") &&
      productionScratch.warnings.length === 0 &&
      afterEffects.installed === true,
    "Production scratch disk/After Effects utility mocks failed.",
  );

  const customPropertiesBefore = await call("get_custom_properties", {
    owner: "project",
    property_id: "deno.note",
    value_type: "string",
  });
  const clearedCustomProperty = await call("clear_custom_property", {
    owner: "project",
    property_id: "deno.note",
  });
  const customPropertiesAfter = await call("get_custom_properties", {
    owner: "project",
    property_id: "deno.note",
    value_type: "string",
  });
  assert(
    customPropertiesBefore.properties[0]?.exists === true &&
      customPropertiesBefore.properties[0]?.value === "clear me" &&
      clearedCustomProperty.cleared === true &&
      clearedCustomProperty.hasValue === false &&
      customPropertiesAfter.properties[0]?.exists === false &&
      customPropertiesAfter.properties[0]?.value === null &&
      !projectCustomProperties.has("deno.note"),
    "Custom Properties get/clear/read-back mocks failed.",
  );
  await expectCallError(
    "clear_custom_property",
    { owner: "project", property_id: "deno.note" },
    "CUSTOM_PROPERTY_NOT_FOUND",
  );

  const sourcePositionUpdated = await call("set_source_monitor_position", {
    position_seconds: 5.5,
  });
  assert(
    sourcePositionUpdated.positionSeconds === 5.5 &&
      sourcePositionUpdated.ticks === String(Math.round(5.5 * TICKS_PER_SECOND)) &&
      sourceMonitorPositionSeconds === 5.5,
    "set_source_monitor_position read-back mock failed.",
  );

  const premiereProjectCheck = await call("is_premiere_project", {
    project_path: "E:\\mock\\Mock Project.prproj",
  });
  const openedSequence = await call("open_sequence", {
    sequence_id: "mock-sequence-guid",
  });
  const growingMedia = await call("pause_growing_media", { paused: true });
  const projectObjectMask = await call("has_object_mask", { scope: "project" });
  const sequenceObjectMask = await call("has_object_mask", {
    scope: "sequence",
    sequence_id: "mock-sequence-guid",
  });
  assert(
    premiereProjectCheck.isPremiereProject === true &&
      openedSequence.opened === true &&
      openedSequence.isActive === true &&
      growingMedia.paused === true &&
      growingMediaPaused === true &&
      projectObjectMask.hasObjectMask === false &&
      sequenceObjectMask.hasObjectMask === true &&
      sequenceObjectMask.sequenceId === "mock-sequence-guid",
    "Official project utility mocks failed.",
  );

  const ingestBefore = await call("get_project_ingest_settings", {});
  const ingestAfter = await call("set_project_ingest_enabled", {
    enabled: true,
  });
  const scratchUpdated = await call("set_project_scratch_disk_mode", {
    folder_type: "capture",
    location: "same_as_project",
  });
  assert(
    ingestBefore.enabled === false &&
      ingestAfter.updated === true &&
      ingestAfter.previousEnabled === false &&
      ingestAfter.enabled === true &&
      projectIngestEnabled === true &&
      scratchUpdated.updated === true &&
      scratchUpdated.changed === true &&
      scratchUpdated.path.endsWith("same-as-project\\capture"),
    "Project settings action/read-back mocks failed.",
  );

  const encoderInfo = await call("get_media_encoder_info", {});
  const queued = await call("add_to_render_queue", {
    output_path: "E:\\mock\\queued.mov",
    preset_path: "E:\\mock\\prores.epr",
    work_area_only: true,
  });
  const encoderEvents = await call("list_media_encoder_events", {
    after_event_id: 0,
    job_id: "ame-job-1",
    limit: 1,
  });
  const batchStarted = await call("start_batch_encode", {});
  const encoderLaunched = await call("launch_media_encoder", {});
  const xmpOptions = await call("set_encoder_xmp_options", {
    embedded_enabled: true,
    sidecar_enabled: false,
  });
  const queueCall = encoderCalls.find((entry) => entry.kind === "export-sequence");
  assert(
    encoderInfo.isAMEInstalled === true &&
      encoderEventListeners.size === 5 &&
      queued.queued === true &&
      queued.destination === "ame" &&
      queued.workAreaOnly === true &&
      queueCall?.exportType === "queue-to-ame" &&
      queueCall?.entireSequence === false &&
      encoderEvents.eventCount === 1 &&
      encoderEvents.events[0]?.type === "queued" &&
      encoderEvents.events[0]?.jobId === "ame-job-1" &&
      encoderEvents.queueSnapshotAvailable === false &&
      batchStarted.started === true &&
      encoderLaunched.launched === true &&
      xmpOptions.embeddedEnabled === true &&
      xmpOptions.sidecarEnabled === false &&
      xmpOptions.nonAtomic === true,
    "EncoderManager/EventManager official mocks failed.",
  );

  await expectCallError(
    "subscribe_premiere_events",
    { groups: ["project", "project"] },
    "INVALID_ARGUMENTS",
  );
  await expectCallError(
    "list_premiere_events",
    { limit: 201 },
    "INVALID_ARGUMENTS",
  );
  const eventSubscription = await call("subscribe_premiere_events", {
    groups: ["project", "video_tracks"],
    sequence_id: "mock-sequence-guid",
  });
  for (let index = 1; index <= 205; index += 1) {
    emitGlobalEvent("project-opened", {
      name: `Project ${index}`,
      projectGuid: "mock-project-guid",
      index,
    });
  }
  emitTargetEvent(videoTrack, "video-track-changed", {
    name: "V1",
    trackIndex: 0,
  });
  const eventRing = await call("list_premiere_events", {
    after_event_id: 0,
    limit: 200,
  });
  const targetEvents = await call("list_premiere_events", {
    event_types: ["video_track_changed"],
    groups: ["video_tracks"],
    limit: 10,
  });
  assert(
    eventSubscription.subscribed === true &&
      eventSubscription.addedListenerCount === 8 &&
      eventSubscription.activeListenerCount === 8 &&
      eventRing.latestEventId === 206 &&
      eventRing.eventCount === 200 &&
      eventRing.events[0]?.eventId === 7 &&
      eventRing.events[199]?.eventId === 206 &&
      targetEvents.eventCount === 1 &&
      targetEvents.events[0]?.group === "video_tracks" &&
      targetEvents.events[0]?.type === "video_track_changed" &&
      targetEvents.events[0]?.target?.trackId === "101",
    "Premiere event subscription/ring/filter mocks failed.",
  );
  const projectEventsRemoved = await call("unsubscribe_premiere_events", {
    groups: ["project"],
  });
  const remainingEventsRemoved = await call("unsubscribe_premiere_events", {});
  emitGlobalEvent("project-opened", { name: "Must not be recorded" });
  emitTargetEvent(videoTrack, "video-track-changed", { name: "Must not be recorded" });
  const eventsAfterRemoval = await call("list_premiere_events", {
    after_event_id: 206,
    limit: 10,
  });
  assert(
    projectEventsRemoved.removedListenerCount === 5 &&
      projectEventsRemoved.activeListenerCount === 3 &&
      remainingEventsRemoved.removedListenerCount === 3 &&
      remainingEventsRemoved.activeListenerCount === 0 &&
      removedGlobalEventListeners.length === 5 &&
      removedTargetEventListeners.filter((entry) => entry.target === videoTrack)
        .length === 3 &&
      globalEventListeners.length === 0 &&
      targetEventListeners.filter((entry) => entry.target === videoTrack).length === 0 &&
      encoderEventListeners.size === 5 &&
      eventsAfterRemoval.latestEventId === 206 &&
      eventsAfterRemoval.eventCount === 0,
    "Premiere event listener removal mock failed.",
  );

  const aaf = await call("export_aaf", {
    output_path: "E:\\mock\\timeline.aaf",
    mix_down_video: false,
    explode_to_mono: true,
    sample_rate: 96000,
    bits_per_sample: 24,
    embed_audio: true,
    audio_file_format: "wav",
    trim_sources: true,
    handle_frames: 48,
    video_mixdown_preset_path: "E:\\mock\\video-mixdown.epr",
    render_audio_effects: true,
    interleave_without_effects: true,
    preserve_parent_folder: true,
  });
  const aafCall = converterCalls.find((entry) => entry.kind === "aaf");
  assert(
    aaf.exported === true &&
      aaf.outputPath === "E:\\mock\\timeline.aaf" &&
      aaf.options.mixDownVideo === false &&
      aaf.options.explodeToMono === true &&
      aaf.options.sampleRate === 96000 &&
      aaf.options.bitsPerSample === 24 &&
      aaf.options.embedAudio === true &&
      aaf.options.audioFileFormat === "wav" &&
      aaf.options.audioFileFormatValue === 2 &&
      aaf.options.trimSources === true &&
      aaf.options.handleFrames === 48 &&
      aaf.options.videoMixdownPresetPath === "E:\\mock\\video-mixdown.epr" &&
      aaf.options.renderAudioEffects === true &&
      aaf.options.interleaveWithoutEffects === true &&
      aaf.options.preserveParentFolder === true &&
      aafOptionCalls.length === 12 &&
      JSON.stringify(aafOptionCalls.map((entry) => entry.method)) ===
        JSON.stringify([
          "setMixdownVideo",
          "setExplodeToMono",
          "setSampleRate",
          "setBitsPerSample",
          "setEmbedAudio",
          "setAudioFileFormat",
          "setTrimSources",
          "setHandleFrames",
          "setVideoMixdownPresetPath",
          "setRenderAudioEffects",
          "setInterleaveWithoutEffects",
          "setPreserveParentFolder",
        ]) &&
      aafCall?.targetSequence === sequence &&
      aafCall?.outputPath === "E:\\mock\\timeline.aaf" &&
      aafCall?.argumentCount === 3 &&
      aafCall?.options?.audioFileFormat === 2,
    "export_aaf official options setter/read-back mock failed.",
  );

  const otio = await call("export_open_timeline_io", {
    output_path: "E:\\mock\\timeline.otio",
  });
  const otioCall = converterCalls.find((entry) => entry.kind === "otio");
  assert(
    otio.exported === true &&
      otioCall?.targetSequence === sequence &&
      otioCall?.outputPath.endsWith("timeline.otio") &&
      otioCall?.exportAsTitle === true,
    "export_open_timeline_io mock failed.",
  );

  const installedMogrtPath = await call("get_installed_mogrt_path", {});
  const libraryMogrt = await call("import_mogrt_from_library", {
    library_name: "DENO Library",
    element_name: "Lower Third",
    track_index: 0,
    start_seconds: 7,
    duration_seconds: 2,
  });
  const libraryMogrtCall = editorCalls.find(
    (entry) => entry.kind === "mogrt-library",
  );
  assert(
    installedMogrtPath.installedMogrtPath.includes("Motion Graphics Templates") &&
      libraryMogrt.imported === true &&
      libraryMogrt.items[0]?.nodeId === "mogrt-library-node-1" &&
      libraryMogrt.startSeconds === 7 &&
      libraryMogrt.durationAdjusted === true &&
      mockCalls.includes("mogrt-library:end:9") &&
      libraryMogrtCall?.libraryName === "DENO Library" &&
      libraryMogrtCall?.elementName === "Lower Third",
    "MOGRT library/path official mocks failed.",
  );

  const movedClip = await call("move_clip", {
    node_id: "video-node-1",
    new_start_seconds: 4,
  });
  assert(
    movedClip.moved === true &&
      movedClip.items[0]?.previousStartSeconds === 2 &&
      movedClip.items[0]?.offsetSeconds === 2 &&
      videoItemStartSeconds === 4,
    "move_clip absolute-time/offset mock failed.",
  );

  sequenceSelection = [videoItem];
  const batchEnabled = await call("batch_enable_disable", {
    enabled: true,
    target: "selected",
  });
  const batchRenamed = await call("batch_rename_clips", {
    pattern: "Batch {n} - {name}",
    track_type: "video",
    track_index: 0,
    selected_only: true,
    start_number: 10,
  });
  extraVideoItems.push(null);
  const selectedRemoved = await call("remove_selected_clips", {
    ripple: false,
  });
  extraVideoItems.pop();
  assert(
    batchEnabled.updated === true &&
      batchEnabled.count === 1 &&
      batchEnabled.items[0]?.enabled === true &&
      videoItemDisabled === false &&
      batchRenamed.renamed === true &&
      batchRenamed.items[0]?.name === "Batch 10 - Renamed Overlay" &&
      videoItemName === "Batch 10 - Renamed Overlay" &&
      selectedRemoved.removed === true &&
      selectedRemoved.count === 1 &&
      selectedRemoved.items[0]?.nodeId === "video-node-1",
    "Bounded batch timeline mocks failed.",
  );
  sequenceSelection = [];

  function createBatchProjectItem(id, name) {
    let parent = rootItem;
    return {
      name,
      type: 1,
      getId() {
        return id;
      },
      getParentBin() {
        return parent;
      },
      _setParent(value) {
        parent = value;
      },
    };
  }
  const batchTargetChildren = [];
  const batchTargetBin = {
    name: "Batch Target",
    type: 2,
    _children: batchTargetChildren,
    getId() {
      return "batch-target-bin";
    },
    getParentBin() {
      return rootItem;
    },
    async getItems() {
      return [...this._children];
    },
    createMoveItemAction(item, target) {
      requireProjectLock("FolderItem.createMoveItemAction");
      return mockAction("project-item:move-nested", () => {
        const index = this._children.indexOf(item);
        if (index >= 0) this._children.splice(index, 1);
        if (!target._children.includes(item)) target._children.push(item);
        item._setParent?.(target);
      });
    },
    createRemoveItemAction(item) {
      requireProjectLock("FolderItem.createRemoveItemAction");
      return mockAction("project-item:remove-batch", () => {
        const index = this._children.indexOf(item);
        if (index >= 0) this._children.splice(index, 1);
        item._setParent?.(null);
      });
    },
  };
  const batchProjectItemOne = createBatchProjectItem(
    "batch-project-item-1",
    "Batch Clip 1",
  );
  const batchProjectItemTwo = createBatchProjectItem(
    "batch-project-item-2",
    "Batch Clip 2",
  );
  rootChildren.push(batchTargetBin, batchProjectItemOne, batchProjectItemTwo);

  const movedProjectItems = await call("move_items_to_bin", {
    item_ids: ["batch-project-item-1", "batch-project-item-2"],
    target_bin: "batch-target-bin",
  });
  assert(
    movedProjectItems.moved === true &&
      movedProjectItems.count === 2 &&
      movedProjectItems.items.every((item) => item.targetBinId === "batch-target-bin") &&
      batchTargetChildren.length === 2 &&
      batchProjectItemOne.getParentBin() === batchTargetBin,
    "move_items_to_bin transaction mock failed.",
  );

  const deletedProjectItems = await call("delete_multiple_project_items", {
    item_ids: ["batch-project-item-1", "batch-project-item-2"],
  });
  assert(
    deletedProjectItems.deleted === true &&
      deletedProjectItems.count === 2 &&
      deletedProjectItems.items.every(
        (item) => item.previousBinId === "batch-target-bin",
      ) &&
      batchTargetChildren.length === 0,
    "delete_multiple_project_items transaction mock failed.",
  );

  const undoNames = transactions.map((entry) => entry.undoName);
  for (const command of [
    "add_to_timeline",
    "remove_from_timeline",
    "add_marker",
    "update_marker",
    "delete_marker",
    "add_marker_to_project_item",
    "create_bin",
    "set_scale_to_frame_size",
    "set_color_label",
    "set_footage_interpretation",
    "set_project_item_input_lut_id",
    "apply_effect",
    "batch_apply_effect",
    "apply_audio_effect",
    "set_clip_scale",
    "add_keyframe",
    "set_clip_volume",
    "add_audio_keyframes",
    "add_transition_to_clip",
    "remove_transition",
    "rename_clip",
    "enable_disable_clip",
    "set_sequence_audio_settings",
    "rename_caption_track",
    "import_clip_transcript_json",
    "clear_custom_property",
    "set_project_ingest_enabled",
    "set_project_scratch_disk_mode",
    "import_mogrt_from_library",
    "move_clip",
    "batch_enable_disable",
    "batch_rename_clips",
    "remove_selected_clips",
    "move_items_to_bin",
    "delete_multiple_project_items",
  ]) {
    assert(undoNames.includes(`DENO: ${command}`), `Missing transaction: DENO: ${command}`);
  }

  for (const name of NEW_OFFICIAL_BEHAVIOR_NAMES) {
    assert(
      behaviorTestedNames.has(name),
      `New official handler lacks a positive behavior test: ${name}`,
    );
  }

  return {
    names: [...names].sort(),
    writeNames: [...writeNames].sort(),
    dangerousNames: [...dangerousNames].sort(),
    behaviorTestedNames: [...behaviorTestedNames].sort(),
    categoryCounts,
  };
}
