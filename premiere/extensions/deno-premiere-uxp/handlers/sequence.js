const { BridgeError } = require("./errors.js");
const {
  addAction,
  countSequenceClips,
  executeUndoableTransaction,
  findProjectItem,
  findSequence,
  getActiveProject,
  guidText,
  ppro,
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

function positiveNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new BridgeError("INVALID_ARGUMENTS", `${name}은 0보다 커야 합니다.`);
  }
  return value;
}

function nonNegativeNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new BridgeError("INVALID_ARGUMENTS", `${name}은 0 이상이어야 합니다.`);
  }
  return value;
}

function validateOptionalSequence(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["sequence_id"]);
  return args.sequence_id === undefined
    ? {}
    : { sequence_id: nonEmptyString(args.sequence_id, "sequence_id") };
}

function validateSequenceId(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["sequence_id"]);
  return { sequence_id: nonEmptyString(args.sequence_id, "sequence_id") };
}

function validateCreate(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["name", "preset_path"]);
  const result = { name: nonEmptyString(args.name, "name") };
  if (args.preset_path !== undefined) {
    result.preset_path = nonEmptyString(args.preset_path, "preset_path");
  }
  return result;
}

function validateCreateFromClips(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["name", "item_ids"]);
  if (!Array.isArray(args.item_ids) || args.item_ids.length === 0) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "item_ids는 하나 이상의 project item ID 배열이어야 합니다."
    );
  }
  return {
    name: nonEmptyString(args.name, "name"),
    item_ids: args.item_ids.map((value, index) =>
      nonEmptyString(value, `item_ids[${index}]`)
    )
  };
}

function validateZeroPoint(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["sequence_id", "start_seconds"]);
  const result = {
    start_seconds: nonNegativeNumber(args.start_seconds, "start_seconds")
  };
  if (args.sequence_id !== undefined) {
    result.sequence_id = nonEmptyString(args.sequence_id, "sequence_id");
  }
  return result;
}

function validateInOut(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["in_seconds", "out_seconds"]);
  const inSeconds = nonNegativeNumber(args.in_seconds, "in_seconds");
  const outSeconds = nonNegativeNumber(args.out_seconds, "out_seconds");
  if (outSeconds <= inSeconds) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "out_seconds는 in_seconds보다 커야 합니다."
    );
  }
  return { in_seconds: inSeconds, out_seconds: outSeconds };
}

function validateSettings(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  const settingKeys = [
    "width",
    "height",
    "max_render_quality",
    "maximum_bit_depth",
    "composite_in_linear_color",
    "audio_sample_rate",
    "audio_display_format",
    "preview_width",
    "preview_height",
    "preview_codec",
    "preview_file_format",
    "editing_mode"
  ];
  rejectUnknown(args, ["sequence_id", ...settingKeys]);
  if (!settingKeys.some((key) => args[key] !== undefined)) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "변경할 sequence setting이 하나 이상 필요합니다."
    );
  }
  const result = {};
  if (args.sequence_id !== undefined) {
    result.sequence_id = nonEmptyString(args.sequence_id, "sequence_id");
  }
  if (args.width !== undefined) result.width = positiveNumber(args.width, "width");
  if (args.height !== undefined) {
    result.height = positiveNumber(args.height, "height");
  }
  for (const key of [
    "max_render_quality",
    "maximum_bit_depth",
    "composite_in_linear_color"
  ]) {
    if (args[key] !== undefined) {
      if (typeof args[key] !== "boolean") {
        throw new BridgeError("INVALID_ARGUMENTS", `${key}은 boolean이어야 합니다.`);
      }
      result[key] = args[key];
    }
  }
  if (args.audio_sample_rate !== undefined) {
    result.audio_sample_rate = positiveNumber(
      args.audio_sample_rate,
      "audio_sample_rate"
    );
  }
  if (args.audio_display_format !== undefined) {
    if (![0, 1].includes(args.audio_display_format)) {
      throw new BridgeError(
        "INVALID_ARGUMENTS",
        "audio_display_format은 0(sample rate) 또는 1(milliseconds)이어야 합니다."
      );
    }
    result.audio_display_format = args.audio_display_format;
  }
  if (args.preview_width !== undefined) {
    result.preview_width = positiveNumber(args.preview_width, "preview_width");
  }
  if (args.preview_height !== undefined) {
    result.preview_height = positiveNumber(args.preview_height, "preview_height");
  }
  for (const key of ["preview_codec", "preview_file_format", "editing_mode"]) {
    if (args[key] !== undefined) {
      result[key] = nonEmptyString(args[key], key);
    }
  }
  return result;
}

function validateSubsequence(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["ignore_track_targeting"]);
  if (
    args.ignore_track_targeting !== undefined &&
    typeof args.ignore_track_targeting !== "boolean"
  ) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "ignore_track_targeting은 boolean이어야 합니다."
    );
  }
  return { ignore_track_targeting: args.ignore_track_targeting === true };
}

function validatePreset(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["name", "preset_path"]);
  return {
    name: nonEmptyString(args.name, "name"),
    preset_path: nonEmptyString(args.preset_path, "preset_path")
  };
}

function validateProperty(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["property_id", "property_value"]);
  return {
    property_id: nonEmptyString(args.property_id, "property_id"),
    property_value: nonEmptyString(args.property_value, "property_value")
  };
}

function validateFrameRate(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["frame_rate"]);
  return { frame_rate: positiveNumber(args.frame_rate, "frame_rate") };
}

function validateAudioSettings(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["sample_rate"]);
  return { sample_rate: positiveNumber(args.sample_rate, "sample_rate") };
}

function validateResolution(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["width", "height"]);
  return {
    width: positiveNumber(args.width, "width"),
    height: positiveNumber(args.height, "height")
  };
}

function validateRatio(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["ratio"]);
  return { ratio: positiveNumber(args.ratio, "ratio") };
}

function validateFieldType(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["field_type"]);
  if (![0, 1, 2].includes(args.field_type)) {
    throw new BridgeError("INVALID_ARGUMENTS", "field_type은 0, 1, 2 중 하나여야 합니다.");
  }
  return { field_type: args.field_type };
}

function validateDisplayFormat(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["video_display_format", "audio_display_format"]);
  if (
    args.video_display_format === undefined &&
    args.audio_display_format === undefined
  ) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "video_display_format 또는 audio_display_format 중 하나는 필요합니다."
    );
  }
  const result = {};
  if (args.video_display_format !== undefined) {
    if (
      !Number.isInteger(args.video_display_format) ||
      args.video_display_format < 0 ||
      args.video_display_format > 11
    ) {
      throw new BridgeError(
        "INVALID_ARGUMENTS",
        "video_display_format은 0부터 11까지의 정수여야 합니다."
      );
    }
    result.video_display_format = args.video_display_format;
  }
  if (args.audio_display_format !== undefined) {
    if (
      !Number.isInteger(args.audio_display_format) ||
      args.audio_display_format < 0 ||
      args.audio_display_format > 1
    ) {
      throw new BridgeError(
        "INVALID_ARGUMENTS",
        "audio_display_format은 0 또는 1이어야 합니다."
      );
    }
    result.audio_display_format = args.audio_display_format;
  }
  return result;
}

function validateSceneEditDetection(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["operation"]);
  const operation = args.operation === undefined ? "apply_cuts" : args.operation;
  if (!["apply_cuts", "create_markers", "create_subclips"].includes(operation)) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "operation은 apply_cuts, create_markers, create_subclips 중 하나여야 합니다."
    );
  }
  return { operation };
}

async function createSequence(args) {
  const project = await getActiveProject();
  const sequence = args.preset_path
    ? await project.createSequenceWithPresetPath(args.name, args.preset_path)
    : await project.createSequence(args.name);
  if (!sequence) {
    throw new BridgeError("SEQUENCE_CREATE_FAILED", "Sequence creation failed");
  }
  return {
    created: true,
    name: String(sequence.name || args.name),
    id: guidText(sequence.guid),
    undoable: false
  };
}

async function createSequenceFromClips(args) {
  const project = await getActiveProject();
  const clipItems = [];
  for (const itemId of args.item_ids) {
    const item = await findProjectItem(project, itemId);
    if (!item) {
      throw new BridgeError("PROJECT_ITEM_NOT_FOUND", `Project item not found: ${itemId}`);
    }
    try {
      const clipItem = ppro().ClipProjectItem.cast(item);
      if (!clipItem) throw new Error("cast failed");
      clipItems.push(clipItem);
    } catch (_error) {
      throw new BridgeError(
        "INVALID_PROJECT_ITEM_TYPE",
        `Sequence media item이 아닙니다: ${itemId}`
      );
    }
  }
  const sequence = await project.createSequenceFromMedia(args.name, clipItems);
  if (!sequence) {
    throw new BridgeError("SEQUENCE_CREATE_FAILED", "Sequence creation failed");
  }
  return {
    created: true,
    name: String(sequence.name || args.name),
    id: guidText(sequence.guid),
    itemCount: clipItems.length,
    undoable: false
  };
}

async function closeSequence(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  if (!(await project.closeSequence(sequence))) {
    throw new BridgeError("SEQUENCE_CLOSE_FAILED", "Sequence close failed");
  }
  return { closed: true, name: String(sequence.name || ""), undoable: false };
}

async function setZeroPoint(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  executeUndoableTransaction(project, "set_zero_point", (compoundAction) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = sequence.createSetZeroPointAction(
      tickTimeFromSeconds(args.start_seconds)
    );
    addAction(compoundAction, action, "set_zero_point");
  });
  return { zeroPointSeconds: args.start_seconds };
}

async function getSequenceInOutPoints() {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const [inPoint, outPoint] = await Promise.all([
    sequence.getInPoint(),
    sequence.getOutPoint()
  ]);
  return {
    inSeconds: secondsOf(inPoint),
    outSeconds: secondsOf(outPoint)
  };
}

async function setSequenceInOutPoints(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  executeUndoableTransaction(
    project,
    "set_sequence_in_out_points",
    (compoundAction) => {
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
      const inAction = sequence.createSetInPointAction(
        tickTimeFromSeconds(args.in_seconds)
      );
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
      const outAction = sequence.createSetOutPointAction(
        tickTimeFromSeconds(args.out_seconds)
      );
      addAction(compoundAction, inAction, "set_sequence_in_out_points");
      addAction(compoundAction, outAction, "set_sequence_in_out_points");
    }
  );
  return { inSeconds: args.in_seconds, outSeconds: args.out_seconds };
}

async function setActiveSequence(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  if (!(await project.setActiveSequence(sequence))) {
    throw new BridgeError("SEQUENCE_ACTIVATE_FAILED", "Sequence activation failed");
  }
  return {
    active: true,
    name: String(sequence.name || ""),
    id: guidText(sequence.guid),
    undoable: false
  };
}

async function duplicateSequence(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  executeUndoableTransaction(project, "duplicate_sequence", (compoundAction) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = sequence.createCloneAction();
    addAction(compoundAction, action, "duplicate_sequence");
  });
  return { duplicated: true, sourceId: guidText(sequence.guid) };
}

async function deleteSequence(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  const name = String(sequence.name || "");
  if (!(await project.deleteSequence(sequence))) {
    throw new BridgeError("SEQUENCE_DELETE_FAILED", "Sequence deletion failed");
  }
  return { deleted: true, name, undoable: false };
}

async function commitSettings(project, sequence, commandName, settings) {
  executeUndoableTransaction(project, commandName, (compoundAction) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = sequence.createSetSettingsAction(settings);
    addAction(compoundAction, action, commandName);
  });
}

async function setSequenceSettings(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  const settings = await sequence.getSettings();
  if (typeof sequence.createSetSettingsAction !== "function") {
    throw new BridgeError(
      "SEQUENCE_SETTINGS_UNAVAILABLE",
      "Sequence.createSetSettingsAction()을 사용할 수 없습니다."
    );
  }

  const requiredMethods = [];
  if (args.width !== undefined || args.height !== undefined) {
    requiredMethods.push("getVideoFrameRect", "setVideoFrameRect");
  }
  if (args.max_render_quality !== undefined) {
    requiredMethods.push("getMaxRenderQuality", "setMaxRenderQuality");
  }
  if (args.maximum_bit_depth !== undefined) {
    requiredMethods.push("getMaximumBitDepth", "setMaximumBitDepth");
  }
  if (args.composite_in_linear_color !== undefined) {
    requiredMethods.push(
      "getCompositeInLinearColor",
      "setCompositeInLinearColor"
    );
  }
  if (args.audio_sample_rate !== undefined) {
    requiredMethods.push("getAudioSampleRate", "setAudioSampleRate");
  }
  if (args.audio_display_format !== undefined) {
    requiredMethods.push("getAudioDisplayFormat", "setAudioDisplayFormat");
  }
  if (args.preview_width !== undefined || args.preview_height !== undefined) {
    requiredMethods.push("getPreviewFrameRect", "setPreviewFrameRect");
  }
  if (args.preview_codec !== undefined) {
    requiredMethods.push("getPreviewCodec", "setPreviewCodec");
  }
  if (args.preview_file_format !== undefined) {
    requiredMethods.push("getPreviewFileFormat", "setPreviewFileFormat");
  }
  if (args.editing_mode !== undefined) {
    requiredMethods.push("getEditingMode", "setEditingMode");
  }
  for (const method of new Set(requiredMethods)) {
    if (typeof settings[method] !== "function") {
      throw new BridgeError(
        "SEQUENCE_SETTINGS_UNAVAILABLE",
        `SequenceSettings.${method}()을 사용할 수 없습니다.`
      );
    }
  }
  if (
    args.audio_sample_rate !== undefined &&
    (!ppro().FrameRate || typeof ppro().FrameRate.createWithValue !== "function")
  ) {
    throw new BridgeError(
      "SEQUENCE_SETTINGS_UNAVAILABLE",
      "FrameRate.createWithValue()를 사용할 수 없습니다."
    );
  }

  async function apply(method, values, label) {
    if (!(await settings[method](...values))) {
      throw new BridgeError("SETTINGS_REJECTED", `${label} setting was rejected`);
    }
  }

  if (args.width !== undefined || args.height !== undefined) {
    const rect = await settings.getVideoFrameRect();
    if (args.width !== undefined) rect.width = args.width;
    if (args.height !== undefined) rect.height = args.height;
    await apply("setVideoFrameRect", [rect], "Frame size");
  }
  if (args.max_render_quality !== undefined) {
    await apply(
      "setMaxRenderQuality",
      [args.max_render_quality],
      "Maximum render quality"
    );
  }
  if (args.maximum_bit_depth !== undefined) {
    await apply(
      "setMaximumBitDepth",
      [args.maximum_bit_depth],
      "Maximum bit depth"
    );
  }
  if (args.composite_in_linear_color !== undefined) {
    await apply(
      "setCompositeInLinearColor",
      [args.composite_in_linear_color],
      "Composite in linear color"
    );
  }
  if (args.audio_sample_rate !== undefined) {
    await apply(
      "setAudioSampleRate",
      [ppro().FrameRate.createWithValue(args.audio_sample_rate)],
      "Audio sample rate"
    );
  }
  if (args.audio_display_format !== undefined) {
    const display = await settings.getAudioDisplayFormat();
    display.type = audioDisplayFormatConstant(args.audio_display_format);
    await apply("setAudioDisplayFormat", [display], "Audio display format");
  }
  if (args.preview_width !== undefined || args.preview_height !== undefined) {
    const previewRect = await settings.getPreviewFrameRect();
    if (args.preview_width !== undefined) previewRect.width = args.preview_width;
    if (args.preview_height !== undefined) previewRect.height = args.preview_height;
    await apply("setPreviewFrameRect", [previewRect], "Preview frame size");
  }
  if (args.preview_codec !== undefined) {
    await apply("setPreviewCodec", [args.preview_codec], "Preview codec");
  }
  if (args.preview_file_format !== undefined) {
    await apply(
      "setPreviewFileFormat",
      [args.preview_file_format],
      "Preview file format"
    );
  }
  if (args.editing_mode !== undefined) {
    await apply("setEditingMode", [args.editing_mode], "Editing mode");
  }
  await commitSettings(project, sequence, "set_sequence_settings", settings);

  const readback = await sequence.getSettings();
  const result = { undoable: true };
  if (args.width !== undefined || args.height !== undefined) {
    const rect = await readback.getVideoFrameRect();
    result.width = Number(rect.width);
    result.height = Number(rect.height);
  }
  if (args.max_render_quality !== undefined) {
    result.maxRenderQuality = Boolean(await readback.getMaxRenderQuality());
  }
  if (args.maximum_bit_depth !== undefined) {
    result.maximumBitDepth = Boolean(await readback.getMaximumBitDepth());
  }
  if (args.composite_in_linear_color !== undefined) {
    result.compositeInLinearColor = Boolean(
      await readback.getCompositeInLinearColor()
    );
  }
  if (args.audio_sample_rate !== undefined) {
    const rate = await readback.getAudioSampleRate();
    result.audioSampleRate = Number(rate && rate.value);
  }
  if (args.audio_display_format !== undefined) {
    const display = await readback.getAudioDisplayFormat();
    result.audioDisplayFormat = Number(display && display.type);
  }
  if (args.preview_width !== undefined || args.preview_height !== undefined) {
    const rect = await readback.getPreviewFrameRect();
    result.previewWidth = Number(rect.width);
    result.previewHeight = Number(rect.height);
  }
  if (args.preview_codec !== undefined) {
    result.previewCodec = String(await readback.getPreviewCodec());
  }
  if (args.preview_file_format !== undefined) {
    result.previewFileFormat = String(await readback.getPreviewFileFormat());
  }
  if (args.editing_mode !== undefined) {
    result.editingMode = String(await readback.getEditingMode());
  }
  return result;
}

async function setSequenceAudioSettings(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const settings = await sequence.getSettings();
  if (
    !ppro().FrameRate ||
    typeof ppro().FrameRate.createWithValue !== "function" ||
    typeof settings.setAudioSampleRate !== "function" ||
    typeof sequence.createSetSettingsAction !== "function"
  ) {
    throw new BridgeError(
      "SEQUENCE_AUDIO_SETTINGS_UNAVAILABLE",
      "공식 UXP sequence audio sample-rate API를 사용할 수 없습니다."
    );
  }
  const previousRate = await settings.getAudioSampleRate();
  const frameRate = ppro().FrameRate.createWithValue(args.sample_rate);
  if (!(await settings.setAudioSampleRate(frameRate))) {
    throw new BridgeError(
      "SETTINGS_REJECTED",
      "Premiere가 audio sample rate 변경을 거부했습니다."
    );
  }
  await commitSettings(
    project,
    sequence,
    "set_sequence_audio_settings",
    settings
  );

  const readbackSettings = await sequence.getSettings();
  const readbackRate = await readbackSettings.getAudioSampleRate();
  const readbackValue = Number(readbackRate && readbackRate.value);
  if (
    !Number.isFinite(readbackValue) ||
    Math.abs(readbackValue - args.sample_rate) > 0.0001
  ) {
    throw new BridgeError(
      "SETTINGS_READBACK_MISMATCH",
      `Audio sample rate read-back 불일치: ${readbackValue}`
    );
  }
  const item = {
    sequenceId: guidText(sequence.guid),
    sequenceName: String(sequence.name || ""),
    previousSampleRate: Number(previousRate && previousRate.value),
    sampleRate: readbackValue
  };
  return {
    updated: true,
    count: 1,
    items: [item],
    sampleRate: readbackValue,
    undoable: true
  };
}

async function createSubsequence(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const nested = await sequence.createSubsequence(args.ignore_track_targeting);
  if (!nested) {
    throw new BridgeError("SUBSEQUENCE_CREATE_FAILED", "Subsequence creation failed");
  }
  return {
    created: true,
    name: String(nested.name || ""),
    id: guidText(nested.guid),
    undoable: false,
    caveat: "createSubsequence is a direct UXP mutator and cannot join a DENO transaction."
  };
}

async function createSequenceFromPreset(args) {
  const project = await getActiveProject();
  const sequence = await project.createSequenceWithPresetPath(
    args.name,
    args.preset_path
  );
  if (!sequence) {
    throw new BridgeError("SEQUENCE_CREATE_FAILED", "Sequence creation failed");
  }
  return {
    created: true,
    name: String(sequence.name || args.name),
    id: guidText(sequence.guid),
    undoable: false
  };
}

async function attachCustomProperty(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const properties = await ppro().Properties.getProperties(sequence);
  if (!properties) {
    throw new BridgeError("PROPERTIES_UNAVAILABLE", "Sequence properties unavailable");
  }
  executeUndoableTransaction(project, "attach_custom_property", (compoundAction) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = properties.createSetValueAction(
      args.property_id,
      args.property_value,
      ppro().Constants.PropertyType.PERSISTENT
    );
    addAction(compoundAction, action, "attach_custom_property");
  });
  return {
    propertyId: args.property_id,
    propertyValue: args.property_value
  };
}

async function setSequenceFrameRate(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const settings = await sequence.getSettings();
  const frameRate = ppro().FrameRate.createWithValue(args.frame_rate);
  if (!settings.setVideoFrameRate(frameRate)) {
    throw new BridgeError("SETTINGS_REJECTED", "Frame rate setting was rejected");
  }
  await commitSettings(project, sequence, "set_sequence_frame_rate", settings);
  return { frameRate: args.frame_rate };
}

async function setSequenceResolution(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const settings = await sequence.getSettings();
  const rect = await settings.getVideoFrameRect();
  rect.width = args.width;
  rect.height = args.height;
  if (!(await settings.setVideoFrameRect(rect))) {
    throw new BridgeError("SETTINGS_REJECTED", "Resolution setting was rejected");
  }
  await commitSettings(project, sequence, "set_sequence_resolution", settings);
  return { width: args.width, height: args.height };
}

function closeEnough(left, right) {
  return Math.abs(left - right) <= 0.0002;
}

function pixelAspectConstant(ratio) {
  const api = ppro().SequenceSettings;
  const values = [
    [1, api.PAR_SQUARE],
    [0.9091, api.PAR_DVNTSC],
    [1.2121, api.PAR_DVNTSCWide],
    [1.094, api.PAR_DVPAL],
    [1.4587, api.PAR_DVPALWide],
    [2, api.PAR_Anamorphic],
    [1.333, api.PAR_HDAnamorphic1080],
    [1.5, api.PAR_DVCProHD]
  ];
  const match = values.find(([value]) => closeEnough(ratio, value));
  if (!match || match[1] === undefined) {
    throw new BridgeError(
      "UNSUPPORTED_PIXEL_ASPECT_RATIO",
      "공식 UXP API가 정의한 pixel aspect ratio만 지원합니다."
    );
  }
  return match[1];
}

async function setSequencePixelAspectRatio(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const settings = await sequence.getSettings();
  if (!(await settings.setVideoPixelAspectRatio(pixelAspectConstant(args.ratio)))) {
    throw new BridgeError("SETTINGS_REJECTED", "Pixel aspect ratio was rejected");
  }
  await commitSettings(
    project,
    sequence,
    "set_sequence_pixel_aspect_ratio",
    settings
  );
  return { ratio: args.ratio };
}

async function setSequenceFieldType(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const settings = await sequence.getSettings();
  const constants = ppro().Constants.VideoFieldType;
  const mapped = [
    constants.PROGRESSIVE,
    constants.UPPER_FIRST,
    constants.LOWER_FIRST
  ][args.field_type];
  if (!(await settings.setVideoFieldType(mapped))) {
    throw new BridgeError("SETTINGS_REJECTED", "Field type was rejected");
  }
  await commitSettings(project, sequence, "set_sequence_field_type", settings);
  return { fieldType: args.field_type };
}

function videoDisplayFormatConstant(upstreamCode) {
  const api = ppro().SequenceSettings;
  const mapped = {
    1: api.VIDEO_DISPLAY_FORMAT_25,
    2: api.VIDEO_DISPLAY_FORMAT_2997,
    3: api.VIDEO_DISPLAY_FORMAT_2997_NON_DROP,
    9: api.VIDEO_DISPLAY_FORMAT_FRAMES,
    10: api.VIDEO_DISPLAY_FORMAT_16mm,
    11: api.VIDEO_DISPLAY_FORMAT_35mm
  }[upstreamCode];
  if (mapped === undefined) {
    throw new BridgeError(
      "UNSUPPORTED_VIDEO_DISPLAY_FORMAT",
      `UXP 26.3 공식 API에 upstream video display code ${upstreamCode}의 동등한 상수가 없습니다.`
    );
  }
  return mapped;
}

function audioDisplayFormatConstant(upstreamCode) {
  const api = ppro().SequenceSettings;
  const mapped =
    upstreamCode === 0
      ? api.AUDIO_DISPLAY_FORMAT_SAMPLE_RATE
      : api.AUDIO_DISPLAY_FORMAT_MILISECONDS;
  if (mapped === undefined) {
    throw new BridgeError(
      "UNSUPPORTED_AUDIO_DISPLAY_FORMAT",
      `UXP 26.3 공식 API에 upstream audio display code ${upstreamCode}의 동등한 상수가 없습니다.`
    );
  }
  return mapped;
}

async function setSequenceDisplayFormat(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const settings = await sequence.getSettings();
  if (args.video_display_format !== undefined) {
    const display = await sequence.getSequenceVideoTimeDisplayFormat();
    display.type = videoDisplayFormatConstant(args.video_display_format);
    if (!(await settings.setVideoDisplayFormat(display))) {
      throw new BridgeError("SETTINGS_REJECTED", "Video display format was rejected");
    }
  }
  if (args.audio_display_format !== undefined) {
    const display = await sequence.getSequenceAudioTimeDisplayFormat();
    display.type = audioDisplayFormatConstant(args.audio_display_format);
    if (!(await settings.setAudioDisplayFormat(display))) {
      throw new BridgeError("SETTINGS_REJECTED", "Audio display format was rejected");
    }
  }
  await commitSettings(
    project,
    sequence,
    "set_sequence_display_format",
    settings
  );
  return {
    videoDisplayFormat: args.video_display_format,
    audioDisplayFormat: args.audio_display_format
  };
}

async function getSequenceCount() {
  const project = await getActiveProject();
  return { sequenceCount: Array.from((await project.getSequences()) || []).length };
}

async function getTotalClipCount() {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const [videoTrackCount, audioTrackCount] = await Promise.all([
    sequence.getVideoTrackCount(),
    sequence.getAudioTrackCount()
  ]);
  return {
    totalClipCount: await countSequenceClips(
      sequence,
      videoTrackCount,
      audioTrackCount
    ),
    videoTrackCount,
    audioTrackCount
  };
}

async function isDoneAnalyzingVideoEffects(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  if (typeof sequence.isDoneAnalyzingForVideoEffects !== "function") {
    throw new BridgeError(
      "VIDEO_EFFECT_ANALYSIS_API_UNAVAILABLE",
      "Sequence.isDoneAnalyzingForVideoEffects API를 사용할 수 없습니다."
    );
  }
  return {
    sequenceId: guidText(sequence.guid),
    sequenceName: String(sequence.name || ""),
    doneAnalyzing: Boolean(await sequence.isDoneAnalyzingForVideoEffects())
  };
}

async function sceneEditDetection(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const selection = await sequence.getSelection();
  if (!selection || typeof selection.getTrackItems !== "function") {
    throw new BridgeError(
      "NO_SELECTION",
      "Scene edit detection requires an explicit timeline clip selection."
    );
  }
  const selectedItems = Array.from(
    (await selection.getTrackItems()) || []
  );
  if (selectedItems.length === 0) {
    throw new BridgeError(
      "NO_SELECTION",
      "Scene edit detection requires an explicit timeline clip selection."
    );
  }

  const clipTypeValues = [
    ppro().VideoClipTrackItem && ppro().VideoClipTrackItem.TRACKITEMTYPE_CLIP,
    ppro().AudioClipTrackItem && ppro().AudioClipTrackItem.TRACKITEMTYPE_CLIP
  ].filter((value) => typeof value === "number");
  for (const item of selectedItems) {
    if (typeof item.getType !== "function") {
      throw new BridgeError(
        "INVALID_SELECTION",
        "Scene edit detection selection에 clip이 아닌 항목이 포함되어 있습니다."
      );
    }
    const itemType = await item.getType();
    if (!clipTypeValues.includes(itemType)) {
      throw new BridgeError(
        "INVALID_SELECTION",
        "Scene edit detection selection에는 clip track item만 포함할 수 있습니다."
      );
    }
  }

  const sequenceUtils = ppro().SequenceUtils;
  const operation = {
    apply_cuts: sequenceUtils.SEQUENCE_OPERATION_APPLYCUT,
    create_markers: sequenceUtils.SEQUENCE_OPERATION_CREATEMARKER,
    create_subclips: sequenceUtils.SEQUENCE_OPERATION_CREATESUBCLIP
  }[args.operation];
  if (
    typeof sequenceUtils.performSceneEditDetectionOnSelection !== "function" ||
    typeof operation !== "string" ||
    operation.length === 0
  ) {
    throw new BridgeError(
      "SCENE_EDIT_DETECTION_API_UNAVAILABLE",
      `Premiere UXP scene edit detection operation을 사용할 수 없습니다: ${args.operation}`
    );
  }
  const accepted = await ppro().SequenceUtils.performSceneEditDetectionOnSelection(
    operation,
    selection
  );
  if (!accepted) {
    throw new BridgeError(
      "SCENE_EDIT_DETECTION_FAILED",
      "Premiere rejected scene edit detection."
    );
  }
  return {
    started: true,
    operation: args.operation,
    adobeOperation: operation,
    selectedItemCount: selectedItems.length,
    undoable: false
  };
}

module.exports = {
  category: "sequence",
  handlers: [
    {
      name: "create_sequence_from_clips",
      writes: true,
      validate: validateCreateFromClips,
      execute: createSequenceFromClips
    },
    {
      name: "close_sequence",
      writes: true,
      dangerous: true,
      validate: validateOptionalSequence,
      execute: closeSequence
    },
    {
      name: "set_zero_point",
      writes: true,
      validate: validateZeroPoint,
      execute: setZeroPoint
    },
    {
      name: "get_sequence_in_out_points",
      writes: false,
      validate: validateNoArgs,
      execute: getSequenceInOutPoints
    },
    {
      name: "set_sequence_in_out_points",
      writes: true,
      validate: validateInOut,
      execute: setSequenceInOutPoints
    },
    {
      name: "set_active_sequence",
      writes: true,
      validate: validateSequenceId,
      execute: setActiveSequence
    },
    {
      name: "create_sequence",
      writes: true,
      validate: validateCreate,
      execute: createSequence
    },
    {
      name: "duplicate_sequence",
      writes: true,
      validate: validateSequenceId,
      execute: duplicateSequence
    },
    {
      name: "delete_sequence",
      writes: true,
      dangerous: true,
      validate: validateSequenceId,
      execute: deleteSequence
    },
    {
      name: "set_sequence_settings",
      writes: true,
      validate: validateSettings,
      execute: setSequenceSettings
    },
    {
      name: "set_sequence_audio_settings",
      writes: true,
      validate: validateAudioSettings,
      execute: setSequenceAudioSettings
    },
    {
      name: "create_subsequence",
      writes: true,
      validate: validateSubsequence,
      execute: createSubsequence
    },
    {
      name: "create_sequence_from_preset",
      writes: true,
      validate: validatePreset,
      execute: createSequenceFromPreset
    },
    {
      name: "attach_custom_property",
      writes: true,
      validate: validateProperty,
      execute: attachCustomProperty
    },
    {
      name: "set_sequence_frame_rate",
      writes: true,
      validate: validateFrameRate,
      execute: setSequenceFrameRate
    },
    {
      name: "set_sequence_resolution",
      writes: true,
      validate: validateResolution,
      execute: setSequenceResolution
    },
    {
      name: "set_sequence_pixel_aspect_ratio",
      writes: true,
      validate: validateRatio,
      execute: setSequencePixelAspectRatio
    },
    {
      name: "set_sequence_field_type",
      writes: true,
      validate: validateFieldType,
      execute: setSequenceFieldType
    },
    {
      name: "set_sequence_display_format",
      writes: true,
      validate: validateDisplayFormat,
      execute: setSequenceDisplayFormat
    },
    {
      name: "get_sequence_count",
      writes: false,
      validate: validateNoArgs,
      execute: getSequenceCount
    },
    {
      name: "get_total_clip_count",
      writes: false,
      validate: validateNoArgs,
      execute: getTotalClipCount
    },
    {
      name: "is_done_analyzing_video_effects",
      writes: false,
      validate: validateOptionalSequence,
      execute: isDoneAnalyzingVideoEffects
    },
    {
      name: "scene_edit_detection",
      writes: true,
      dangerous: true,
      validate: validateSceneEditDetection,
      execute: sceneEditDetection
    }
  ]
};
