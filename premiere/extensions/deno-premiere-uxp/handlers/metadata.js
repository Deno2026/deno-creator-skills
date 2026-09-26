const { BridgeError } = require("./errors.js");
const {
  addAction,
  booleanArg,
  executeUndoableTransaction,
  getActiveProject,
  normalizeWindowsPath,
  numberArg,
  ppro,
  projectItemId,
  rejectUnknown,
  requireClipProjectItem,
  requireProjectItem,
  stringArg,
  validateNoArgs
} = require("./shared.js");

function validateItem(args) {
  rejectUnknown(args, ["item_id"]);
  return { item_id: stringArg(args.item_id, "item_id") };
}

function validateSetMetadata(args) {
  rejectUnknown(args, ["item_id", "field_name", "value"]);
  return {
    item_id: stringArg(args.item_id, "item_id"),
    field_name: stringArg(args.field_name, "field_name"),
    value: stringArg(args.value, "value", { allowEmpty: true, trim: false })
  };
}

function validateColor(args) {
  rejectUnknown(args, ["item_id", "color_index"]);
  return {
    item_id: stringArg(args.item_id, "item_id"),
    color_index: numberArg(args.color_index, "color_index", {
      integer: true,
      min: 0,
      max: 15
    })
  };
}

function validateInterpretation(args) {
  const settingKeys = [
    "frame_rate",
    "pixel_aspect_ratio",
    "field_type",
    "remove_pull_down",
    "alpha_usage",
    "ignore_alpha",
    "invert_alpha",
    "vr_conform",
    "vr_layout",
    "vr_horz_view",
    "vr_vert_view",
    "input_lut_id"
  ];
  rejectUnknown(args, ["item_id", ...settingKeys]);
  const normalized = {
    item_id: stringArg(args.item_id, "item_id"),
    frame_rate:
      args.frame_rate === undefined
        ? undefined
        : numberArg(args.frame_rate, "frame_rate", { min: 0.001 }),
    pixel_aspect_ratio:
      args.pixel_aspect_ratio === undefined
        ? undefined
        : numberArg(args.pixel_aspect_ratio, "pixel_aspect_ratio", { min: 0.001 })
  };
  for (const key of ["field_type", "alpha_usage", "vr_conform", "vr_layout"]) {
    if (args[key] !== undefined) {
      normalized[key] = numberArg(args[key], key, { integer: true });
    }
  }
  for (const key of ["vr_horz_view", "vr_vert_view"]) {
    if (args[key] !== undefined) {
      normalized[key] = numberArg(args[key], key);
    }
  }
  for (const key of [
    "remove_pull_down",
    "ignore_alpha",
    "invert_alpha"
  ]) {
    if (args[key] !== undefined) {
      normalized[key] = booleanArg(args[key], key);
    }
  }
  if (args.input_lut_id !== undefined) {
    normalized.input_lut_id = stringArg(args.input_lut_id, "input_lut_id", {
      allowEmpty: true
    });
    if (
      normalized.input_lut_id.length > 1024 ||
      normalized.input_lut_id.includes("\0")
    ) {
      throw new BridgeError(
        "INVALID_ARGUMENTS",
        "input_lut_id는 NUL이 없는 1024자 이하 문자열이어야 합니다. 빈 문자열은 LUT 해제 요청으로 허용합니다."
      );
    }
  }
  if (!settingKeys.some((key) => normalized[key] !== undefined)) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "변경할 footage interpretation 필드가 하나 이상 필요합니다."
    );
  }
  return normalized;
}

function validateXmp(args) {
  rejectUnknown(args, ["item_id", "xmp_xml"]);
  return {
    item_id: stringArg(args.item_id, "item_id"),
    xmp_xml: stringArg(args.xmp_xml, "xmp_xml", { trim: false })
  };
}

function validateCustomField(args) {
  rejectUnknown(args, ["field_name", "field_label", "field_type"]);
  return {
    field_name: stringArg(args.field_name, "field_name"),
    field_label: stringArg(args.field_label, "field_label"),
    field_type: numberArg(args.field_type, "field_type", {
      integer: true,
      min: 0,
      max: 3
    })
  };
}

function validatePanelMetadata(args) {
  rejectUnknown(args, ["metadata_xml"]);
  return {
    metadata_xml: stringArg(args.metadata_xml, "metadata_xml", { trim: false })
  };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceMetadataField(metadata, fieldName, value) {
  const text = String(metadata || "");
  try {
    const parsed = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.prototype.hasOwnProperty.call(parsed, fieldName)
    ) {
      parsed[fieldName] = value;
      return JSON.stringify(parsed);
    }
  } catch (_error) {
    // Premiere project metadata is usually XML; JSON is only a compatibility path.
  }

  const escapedName = escapeRegExp(fieldName);
  const qualifiedName = String(fieldName).includes(":")
    ? escapedName
    : `(?:[A-Za-z_][\\w.-]*:)?${escapedName}`;
  const pattern = new RegExp(
    `<(${qualifiedName})(\\s[^>]*)?>([\\s\\S]*?)<\\/\\1>`
  );
  if (!pattern.test(text)) {
    throw new BridgeError(
      "METADATA_FIELD_NOT_FOUND",
      `Metadata field not found in the current document: ${fieldName}`
    );
  }
  return text.replace(pattern, (_whole, matchedName, attributes) =>
    `<${matchedName}${attributes || ""}>${escapeXml(value)}</${matchedName}>`
  );
}

async function getMetadata(args) {
  const project = await getActiveProject();
  const item = await requireProjectItem(project, args.item_id);
  const [projectMetadata, columnsMetadata, xmpMetadata, nodeId] = await Promise.all([
    ppro().Metadata.getProjectMetadata(item),
    ppro().Metadata.getProjectColumnsMetadata(item),
    ppro().Metadata.getXMPMetadata(item),
    projectItemId(item)
  ]);
  let mediaPath = "";
  try {
    const clip = ppro().ClipProjectItem.cast(item);
    mediaPath = normalizeWindowsPath(await clip.getMediaFilePath());
  } catch (_error) {
    // Bins and generated project items do not expose a native media path.
  }
  return {
    nodeId,
    itemId: nodeId,
    name: String(item.name || ""),
    mediaPath,
    projectMetadata: String(projectMetadata || ""),
    columnsMetadata: String(columnsMetadata || ""),
    xmpMetadata: String(xmpMetadata || ""),
    format: "raw-xml"
  };
}

async function setMetadata(args) {
  const project = await getActiveProject();
  const item = await requireProjectItem(project, args.item_id);
  const current = await ppro().Metadata.getProjectMetadata(item);
  const updated = replaceMetadataField(current, args.field_name, args.value);
  executeUndoableTransaction(project, "set_metadata", (compound) => {
    addAction(
      compound,
      // executeUndoableTransaction invokes this callback synchronously inside
      // Project.lockedAccess() and Project.executeTransaction().
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- custom transaction wrapper preserves Adobe's lock scope
      ppro().Metadata.createSetProjectMetadataAction(item, updated, [args.field_name]),
      "set_metadata"
    );
  });
  return { updated: true, fieldName: args.field_name, undoable: true };
}

async function setColorLabel(args) {
  const project = await getActiveProject();
  const item = await requireProjectItem(project, args.item_id);
  executeUndoableTransaction(project, "set_color_label", (compound) => {
    addAction(
      compound,
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
      item.createSetColorLabelAction(args.color_index),
      "set_color_label"
    );
  });
  return { updated: true, colorIndex: args.color_index, undoable: true };
}

async function getColorLabel(args) {
  const project = await getActiveProject();
  const item = await requireProjectItem(project, args.item_id);
  return { colorIndex: Number(await item.getColorLabelIndex()) };
}

function interpretationSnapshot(value) {
  return {
    frameRate: value.getFrameRate(),
    pixelAspectRatio: value.getPixelAspectRatio(),
    fieldType: value.getFieldType(),
    alphaUsage: value.getAlphaUsage(),
    ignoreAlpha: value.getIgnoreAlpha(),
    invertAlpha: value.getInvertAlpha(),
    removePullDown: value.getRemovePullDown(),
    inputLutId: value.getInputLUTID(),
    vrConform: value.getVrConform(),
    vrHorizontalView: value.getVrHorzView(),
    vrVerticalView: value.getVrVertView(),
    vrLayout: value.getVrLayout()
  };
}

async function getFootageInterpretation(args) {
  const project = await getActiveProject();
  const item = await requireClipProjectItem(project, args.item_id);
  return interpretationSnapshot(await item.getFootageInterpretation());
}

async function setFootageInterpretation(args) {
  const project = await getActiveProject();
  const item = await requireClipProjectItem(project, args.item_id);
  const interpretation = await item.getFootageInterpretation();

  function requireRuntimeEnum(value, constantNames, fieldName) {
    const constantSources = [interpretation, ppro().FootageInterpretation || {}];
    const allowed = Array.from(
      new Set(
        constantSources.flatMap((source) =>
          constantNames
            .map((name) => source[name])
            .filter((candidate) => typeof candidate === "number")
        )
      )
    );
    if (!allowed.includes(value)) {
      throw new BridgeError(
        "INVALID_ARGUMENTS",
        `${fieldName}은 Premiere가 공개한 값 중 하나여야 합니다: ${allowed.join(", ")}`
      );
    }
  }

  function applySetter(methodName, value, fieldName) {
    if (value === undefined) return;
    if (
      typeof interpretation[methodName] !== "function" ||
      interpretation[methodName](value) !== true
    ) {
      throw new BridgeError(
        "FOOTAGE_UPDATE_FAILED",
        `${fieldName} footage interpretation이 Premiere에 의해 거부되었습니다.`
      );
    }
  }

  if (args.field_type !== undefined) {
    requireRuntimeEnum(
      args.field_type,
      [
        "FIELD_TYPE_DEFAULT",
        "FIELD_TYPE_PROGRESSIVE",
        "FIELD_TYPE_UPPERFIRST",
        "FIELD_TYPE_LOWERFIRST"
      ],
      "field_type"
    );
  }
  if (args.alpha_usage !== undefined) {
    requireRuntimeEnum(
      args.alpha_usage,
      [
        "ALPHACHANNEL_NONE",
        "ALPHACHANNEL_STRAIGHT",
        "ALPHACHANNEL_PREMULTIPLIED",
        "ALPHACHANNEL_IGNORE"
      ],
      "alpha_usage"
    );
  }

  // FootageInterpretation is a detached mutable snapshot. Every requested
  // setter is validated before the single project Action is created.
  applySetter("setFrameRate", args.frame_rate, "frame_rate");
  applySetter(
    "setPixelAspectRatio",
    args.pixel_aspect_ratio,
    "pixel_aspect_ratio"
  );
  applySetter("setFieldType", args.field_type, "field_type");
  applySetter("setRemovePullDown", args.remove_pull_down, "remove_pull_down");
  applySetter("setAlphaUsage", args.alpha_usage, "alpha_usage");
  applySetter("setIgnoreAlpha", args.ignore_alpha, "ignore_alpha");
  applySetter("setInvertAlpha", args.invert_alpha, "invert_alpha");
  applySetter("setVrConform", args.vr_conform, "vr_conform");
  applySetter("setVrLayout", args.vr_layout, "vr_layout");
  applySetter("setVrHorzView", args.vr_horz_view, "vr_horz_view");
  applySetter("setVrVertView", args.vr_vert_view, "vr_vert_view");
  applySetter("setInputLUTID", args.input_lut_id, "input_lut_id");

  executeUndoableTransaction(project, "set_footage_interpretation", (compound) => {
    addAction(
      compound,
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
      item.createSetFootageInterpretationAction(interpretation),
      "set_footage_interpretation"
    );
  });
  const persisted = await item.getFootageInterpretation();
  return {
    updated: true,
    interpretation: interpretationSnapshot(persisted),
    readbackSource: "ClipProjectItem.getFootageInterpretation",
    undoable: true
  };
}

async function getXmpMetadata(args) {
  const project = await getActiveProject();
  const item = await requireProjectItem(project, args.item_id);
  return { xmp: String((await ppro().Metadata.getXMPMetadata(item)) || "") };
}

async function setXmpMetadata(args) {
  const project = await getActiveProject();
  const item = await requireProjectItem(project, args.item_id);
  executeUndoableTransaction(project, "set_xmp_metadata", (compound) => {
    addAction(
      compound,
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
      ppro().Metadata.createSetXMPMetadataAction(item, args.xmp_xml),
      "set_xmp_metadata"
    );
  });
  return { updated: true, undoable: true };
}

async function addCustomMetadataField(args) {
  const metadataApi = ppro().Metadata;
  const fieldTypes = [
    metadataApi.METADATA_TYPE_INTEGER,
    metadataApi.METADATA_TYPE_REAL,
    metadataApi.METADATA_TYPE_TEXT,
    metadataApi.METADATA_TYPE_BOOLEAN
  ];
  const added = await metadataApi.addPropertyToProjectMetadataSchema(
    args.field_name,
    args.field_label,
    fieldTypes[args.field_type]
  );
  if (!added) throw new BridgeError("METADATA_SCHEMA_UPDATE_FAILED", "Metadata field was rejected");
  return { added: true, undoable: false };
}

async function getProjectPanelMetadata() {
  return {
    metadataXml: String((await ppro().Metadata.getProjectPanelMetadata()) || "")
  };
}

async function setProjectPanelMetadata(args) {
  const updated = await ppro().Metadata.setProjectPanelMetadata(args.metadata_xml);
  if (!updated) throw new BridgeError("PANEL_METADATA_UPDATE_FAILED", "Project panel metadata was rejected");
  return { updated: true, undoable: false };
}

async function getGraphicsWhiteLuminance() {
  const project = await getActiveProject();
  const settings = await project.getColorSettings();
  return {
    luminance: Number(await settings.getGraphicsWhiteLuminance()),
    supportedLuminances: Array.from(
      (await settings.getSupportedGraphicsWhiteLuminances()) || []
    ).map(Number)
  };
}

module.exports = {
  category: "metadata",
  handlers: [
    { name: "get_metadata", writes: false, validate: validateItem, execute: getMetadata },
    { name: "set_metadata", writes: true, validate: validateSetMetadata, execute: setMetadata },
    { name: "set_color_label", writes: true, validate: validateColor, execute: setColorLabel },
    { name: "get_color_label", writes: false, validate: validateItem, execute: getColorLabel },
    { name: "get_footage_interpretation", writes: false, validate: validateItem, execute: getFootageInterpretation },
    { name: "set_footage_interpretation", writes: true, validate: validateInterpretation, execute: setFootageInterpretation },
    { name: "get_xmp_metadata", writes: false, validate: validateItem, execute: getXmpMetadata },
    { name: "set_xmp_metadata", writes: true, validate: validateXmp, execute: setXmpMetadata },
    { name: "add_custom_metadata_field", writes: true, validate: validateCustomField, execute: addCustomMetadataField },
    { name: "get_project_panel_metadata", writes: false, validate: validateNoArgs, execute: getProjectPanelMetadata },
    { name: "set_project_panel_metadata", writes: true, validate: validatePanelMetadata, execute: setProjectPanelMetadata },
    { name: "get_graphics_white_luminance", writes: false, validate: validateNoArgs, execute: getGraphicsWhiteLuminance }
  ]
};
