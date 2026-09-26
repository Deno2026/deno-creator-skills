const { BridgeError } = require("./errors.js");
const {
  addAction,
  booleanArg,
  enumArg,
  executeUndoableTransaction,
  findSequence,
  getActiveProject,
  guidText,
  ppro,
  projectItemId,
  rejectUnknown,
  requireClipProjectItem,
  stringArg,
  validateNoArgs
} = require("./shared.js");

const MAX_TRANSCRIPT_JSON_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_SUMMARY_NODES = 5000;
const MAX_SUMMARY_KEYS = 32;
const MAX_PROJECT_VIEWS = 32;
const MAX_SELECTION_ITEMS_PER_VIEW = 100;
const MAX_SELECTION_ITEMS_TOTAL = 200;
const MAX_PROPERTY_ID_LENGTH = 256;
const MAX_PROPERTY_STRING_LENGTH = 16 * 1024;

const PREFERENCE_KEYS = Object.freeze({
  auto_peak_generation: "AUTO_PEAK_GENERATION",
  import_workspace: "IMPORT_WORKSPACE",
  show_quickstart_dialog: "SHOW_QUICKSTART_DIALOG"
});

const PREFERENCE_PERSISTENCE = Object.freeze({
  persistent: "PERSISTENT",
  session: "NON_PERSISTENT"
});

const SCRATCH_FOLDER_TYPES = Object.freeze({
  capture: "CAPTURE",
  audio_preview: "AUDIO_PREVIEW",
  video_preview: "VIDEO_PREVIEW",
  auto_save: "AUTO_SAVE",
  cc_libraries: "CCL_LIBRARIES",
  capsule_media: "CAPSULE_MEDIA"
});

const PROPERTY_VALUE_GETTERS = Object.freeze({
  string: "getValue",
  integer: "getValueAsInt",
  float: "getValueAsFloat",
  boolean: "getValueAsBool"
});

function requireMethod(target, methodName, label) {
  if (!target || typeof target[methodName] !== "function") {
    throw new BridgeError(
      "UXP_API_UNAVAILABLE",
      `Premiere UXP ${label || methodName} API를 사용할 수 없습니다.`
    );
  }
  return target[methodName].bind(target);
}

function boundedText(value, maximum) {
  const text = String(value === undefined || value === null ? "" : value);
  return {
    value: text.length > maximum ? text.slice(0, maximum) : text,
    truncated: text.length > maximum,
    originalLength: text.length
  };
}

function utf8ByteLength(value) {
  const text = String(value);
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function summarizeParsedJson(parsed, byteLength) {
  let nodeCount = 0;
  let truncated = false;

  function visit(value, depth) {
    if (nodeCount >= MAX_TRANSCRIPT_SUMMARY_NODES || depth > 10) {
      truncated = true;
      return;
    }
    nodeCount += 1;
    if (!value || typeof value !== "object") return;
    const values = Array.isArray(value) ? value : Object.values(value);
    for (const child of values) {
      if (nodeCount >= MAX_TRANSCRIPT_SUMMARY_NODES) {
        truncated = true;
        break;
      }
      visit(child, depth + 1);
    }
  }

  visit(parsed, 0);
  const isArray = Array.isArray(parsed);
  const isObject = Boolean(parsed) && typeof parsed === "object" && !isArray;
  let topLevelKeys = [];
  let topLevelKeyCount = 0;
  if (isObject) {
    const keys = Object.keys(parsed);
    topLevelKeyCount = keys.length;
    topLevelKeys = keys.slice(0, MAX_SUMMARY_KEYS).map((key) =>
      boundedText(key, 128).value
    );
    if (keys.length > topLevelKeys.length) truncated = true;
  }

  return {
    validJson: true,
    byteLength,
    rootType: isArray ? "array" : isObject ? "object" : typeof parsed,
    topLevelKeyCount,
    topLevelKeys,
    arrayLength: isArray ? parsed.length : null,
    inspectedNodeCount: nodeCount,
    truncated
  };
}

function parseAndSummarizeTranscriptJson(rawJson, label) {
  const byteLength = utf8ByteLength(rawJson);
  if (byteLength > MAX_TRANSCRIPT_JSON_BYTES) {
    throw new BridgeError(
      "TRANSCRIPT_JSON_TOO_LARGE",
      `${label}은 UTF-8 기준 ${MAX_TRANSCRIPT_JSON_BYTES} bytes 이하여야 합니다.`,
      { byteLength, maximumBytes: MAX_TRANSCRIPT_JSON_BYTES }
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (_error) {
    throw new BridgeError(
      "INVALID_TRANSCRIPT_JSON",
      `${label}은 유효한 JSON이어야 합니다.`
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new BridgeError(
      "INVALID_TRANSCRIPT_JSON",
      `${label}의 최상위 값은 object 또는 array여야 합니다.`
    );
  }
  return { parsed, summary: summarizeParsedJson(parsed, byteLength) };
}

function validateImportTranscript(args) {
  rejectUnknown(args, ["item_id", "transcript_json", "replace_existing"]);
  const transcriptJson = stringArg(args.transcript_json, "transcript_json", {
    trim: false
  });
  const parsed = parseAndSummarizeTranscriptJson(
    transcriptJson,
    "transcript_json"
  );
  return {
    item_id: stringArg(args.item_id, "item_id"),
    transcript_json: transcriptJson,
    replace_existing: booleanArg(args.replace_existing, "replace_existing", {
      optional: true,
      fallback: false
    }),
    transcript_summary: parsed.summary
  };
}

function validateProjectPanelSelection(args) {
  rejectUnknown(args, ["scope"]);
  return {
    scope: enumArg(args.scope, "scope", ["active_project", "all_views"])
  };
}

function validateGetPreference(args) {
  rejectUnknown(args, ["key"]);
  return {
    key: enumArg(args.key, "key", Object.keys(PREFERENCE_KEYS))
  };
}

function validateSetPreference(args) {
  rejectUnknown(args, ["key", "value", "persistence"]);
  return {
    key: enumArg(args.key, "key", Object.keys(PREFERENCE_KEYS)),
    value: booleanArg(args.value, "value"),
    persistence: enumArg(
      args.persistence,
      "persistence",
      Object.keys(PREFERENCE_PERSISTENCE),
      { optional: true, fallback: "session" }
    )
  };
}

function optionalSequenceId(value) {
  return value === undefined
    ? undefined
    : stringArg(value, "sequence_id");
}

function optionalPropertyId(value) {
  if (value === undefined) return undefined;
  const propertyId = stringArg(value, "property_id");
  if (propertyId.length > MAX_PROPERTY_ID_LENGTH) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `property_id는 ${MAX_PROPERTY_ID_LENGTH}자 이하여야 합니다.`
    );
  }
  return propertyId;
}

function validatePropertyOwner(args, options) {
  const settings = options || {};
  const allowed = ["owner", "sequence_id", "property_id"];
  if (settings.allowValueType) allowed.push("value_type");
  rejectUnknown(args, allowed);

  const owner = enumArg(args.owner, "owner", ["project", "sequence"]);
  const sequenceId = optionalSequenceId(args.sequence_id);
  if (owner === "project" && sequenceId !== undefined) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "owner가 project이면 sequence_id를 함께 보낼 수 없습니다."
    );
  }

  const propertyId = optionalPropertyId(args.property_id);
  const valueType = settings.allowValueType
    ? enumArg(
        args.value_type,
        "value_type",
        Object.keys(PROPERTY_VALUE_GETTERS),
        { optional: true, fallback: "string" }
      )
    : undefined;
  if (settings.requirePropertyId && propertyId === undefined) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "property_id가 필요합니다."
    );
  }
  if (
    settings.allowValueType &&
    propertyId === undefined &&
    args.value_type !== undefined
  ) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "value_type은 property_id와 함께 사용해야 합니다."
    );
  }
  return {
    owner,
    sequence_id: sequenceId,
    property_id: propertyId,
    ...(settings.allowValueType ? { value_type: valueType } : {})
  };
}

function validateGetCustomProperties(args) {
  return validatePropertyOwner(args, { allowValueType: true });
}

function validateClearCustomProperty(args) {
  return validatePropertyOwner(args, { requirePropertyId: true });
}

function projectMetadata(project) {
  return {
    projectId: guidText(project.guid),
    projectName: boundedText(project.name || "", 512).value
  };
}

function transcriptApi() {
  const api = ppro().Transcript;
  requireMethod(api, "importFromJSON", "Transcript.importFromJSON");
  requireMethod(
    api,
    "createImportTextSegmentsAction",
    "Transcript.createImportTextSegmentsAction"
  );
  requireMethod(api, "hasTranscript", "Transcript.hasTranscript");
  return api;
}

async function importClipTranscriptJson(args) {
  const project = await getActiveProject();
  const clipProjectItem = await requireClipProjectItem(project, args.item_id);
  const api = transcriptApi();
  const hadTranscript = Boolean(
    await Promise.resolve(api.hasTranscript(clipProjectItem))
  );
  if (hadTranscript && !args.replace_existing) {
    throw new BridgeError(
      "TRANSCRIPT_ALREADY_EXISTS",
      "대상 clip에 transcript가 이미 있습니다. 교체하려면 replace_existing=true가 필요합니다."
    );
  }

  let textSegments;
  try {
    textSegments = api.importFromJSON(args.transcript_json);
  } catch (_error) {
    throw new BridgeError(
      "TRANSCRIPT_IMPORT_PARSE_FAILED",
      "Premiere가 transcript JSON을 TextSegments로 변환하지 못했습니다."
    );
  }
  if (!textSegments) {
    throw new BridgeError(
      "TRANSCRIPT_IMPORT_PARSE_FAILED",
      "Premiere가 유효한 TextSegments를 반환하지 않았습니다."
    );
  }

  executeUndoableTransaction(
    project,
    "import_clip_transcript_json",
    (compoundAction) => {
      // executeUndoableTransaction invokes this callback synchronously inside
      // Project.lockedAccess() and Project.executeTransaction().
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- custom transaction wrapper preserves Adobe's lock scope
      const action = api.createImportTextSegmentsAction(
        textSegments,
        clipProjectItem
      );
      addAction(compoundAction, action, "import_clip_transcript_json");
    }
  );

  const hasTranscript = Boolean(
    await Promise.resolve(api.hasTranscript(clipProjectItem))
  );
  if (!hasTranscript) {
    throw new BridgeError(
      "TRANSCRIPT_IMPORT_READBACK_MISMATCH",
      "Transcript import 후 대상 clip에서 transcript를 확인하지 못했습니다."
    );
  }

  const warnings = [];
  let readback = {
    available: false,
    hasTranscript: true,
    summary: null
  };
  if (typeof api.exportToJSON === "function") {
    try {
      const exported = await Promise.resolve(api.exportToJSON(clipProjectItem));
      const exportedText = String(exported || "");
      const byteLength = utf8ByteLength(exportedText);
      let summary;
      try {
        summary = summarizeParsedJson(JSON.parse(exportedText), byteLength);
      } catch (_error) {
        summary = {
          validJson: false,
          byteLength,
          rootType: null,
          topLevelKeyCount: 0,
          topLevelKeys: [],
          arrayLength: null,
          inspectedNodeCount: 0,
          truncated: false
        };
      }
      readback = { available: true, hasTranscript: true, summary };
    } catch (_error) {
      warnings.push({
        stage: "Transcript.exportToJSON",
        code: "TRANSCRIPT_EXPORT_READBACK_FAILED",
        message: "Transcript는 존재하지만 JSON read-back summary를 만들지 못했습니다."
      });
    }
  } else {
    warnings.push({
      stage: "Transcript.exportToJSON",
      code: "UXP_API_UNAVAILABLE",
      message: "현재 runtime에는 transcript JSON read-back API가 없습니다."
    });
  }

  return {
    imported: true,
    ...projectMetadata(project),
    itemId: (await projectItemId(clipProjectItem)) || args.item_id,
    itemName: boundedText(clipProjectItem.name || "", 512).value,
    hadTranscript,
    replaceExisting: args.replace_existing,
    hasTranscript,
    inputSummary: args.transcript_summary,
    readback,
    warnings,
    undoable: true
  };
}

async function projectItemSnapshot(item) {
  let parent = null;
  try {
    parent = await Promise.resolve(item.getParentBin());
  } catch (_error) {
    parent = null;
  }
  return {
    itemId: await projectItemId(item),
    name: boundedText(item.name || "", 512).value,
    type:
      typeof item.type === "number" || typeof item.type === "string"
        ? item.type
        : null,
    parentBinId: parent ? await projectItemId(parent) : "",
    parentBinName: parent
      ? boundedText(parent.name || "", 512).value
      : ""
  };
}

function apiWarning(stage, code, message, extra) {
  return {
    stage,
    code,
    message,
    ...(extra || {})
  };
}

async function readProjectViewSelection(
  projectUtils,
  project,
  viewId,
  remaining,
  warnings
) {
  let selection;
  try {
    selection = viewId
      ? await projectUtils.getSelectionFromViewId(viewId)
      : await projectUtils.getSelection(project);
  } catch (_error) {
    warnings.push(
      apiWarning(
        viewId
          ? "ProjectUtils.getSelectionFromViewId"
          : "ProjectUtils.getSelection",
        "PROJECT_SELECTION_READ_FAILED",
        "Project panel selection을 읽지 못했습니다.",
        viewId ? { viewId: guidText(viewId) } : undefined
      )
    );
    return { items: [], selectedCount: 0, returnedCount: 0, truncated: false };
  }

  let rawItems;
  try {
    rawItems = selection ? await selection.getItems() : [];
  } catch (_error) {
    warnings.push(
      apiWarning(
        "ProjectItemSelection.getItems",
        "PROJECT_SELECTION_ITEMS_READ_FAILED",
        "Project panel selection의 item 목록을 읽지 못했습니다.",
        viewId ? { viewId: guidText(viewId) } : undefined
      )
    );
    return { items: [], selectedCount: 0, returnedCount: 0, truncated: false };
  }

  const values = Array.from(rawItems || []);
  const allowedCount = Math.max(
    0,
    Math.min(MAX_SELECTION_ITEMS_PER_VIEW, remaining, values.length)
  );
  const items = [];
  for (const item of values.slice(0, allowedCount)) {
    items.push(await projectItemSnapshot(item));
  }
  return {
    items,
    selectedCount: values.length,
    returnedCount: items.length,
    truncated: items.length < values.length
  };
}

async function getProjectPanelSelection(args) {
  const projectUtils = ppro().ProjectUtils;
  requireMethod(projectUtils, "getSelection", "ProjectUtils.getSelection");
  requireMethod(
    projectUtils,
    "getProjectViewIds",
    "ProjectUtils.getProjectViewIds"
  );
  requireMethod(
    projectUtils,
    "getProjectFromViewId",
    "ProjectUtils.getProjectFromViewId"
  );
  requireMethod(
    projectUtils,
    "getSelectionFromViewId",
    "ProjectUtils.getSelectionFromViewId"
  );

  const warnings = [];
  const views = [];
  let remaining = MAX_SELECTION_ITEMS_TOTAL;

  if (args.scope === "active_project") {
    const project = await getActiveProject();
    const selection = await readProjectViewSelection(
      projectUtils,
      project,
      null,
      remaining,
      warnings
    );
    views.push({
      viewId: null,
      ...projectMetadata(project),
      ...selection
    });
  } else {
    let viewIds;
    try {
      viewIds = Array.from((await projectUtils.getProjectViewIds()) || []);
    } catch (_error) {
      throw new BridgeError(
        "PROJECT_VIEWS_READ_FAILED",
        "Premiere Project panel view ID 목록을 읽지 못했습니다."
      );
    }
    if (viewIds.length > MAX_PROJECT_VIEWS) {
      warnings.push(
        apiWarning(
          "ProjectUtils.getProjectViewIds",
          "PROJECT_VIEW_LIMIT_REACHED",
          `Project panel view는 최대 ${MAX_PROJECT_VIEWS}개까지만 반환합니다.`,
          { discoveredCount: viewIds.length, returnedCount: MAX_PROJECT_VIEWS }
        )
      );
    }

    for (const viewId of viewIds.slice(0, MAX_PROJECT_VIEWS)) {
      if (remaining <= 0) {
        warnings.push(
          apiWarning(
            "ProjectItemSelection.getItems",
            "PROJECT_SELECTION_TOTAL_LIMIT_REACHED",
            `선택 item은 전체 최대 ${MAX_SELECTION_ITEMS_TOTAL}개까지만 반환합니다.`
          )
        );
        break;
      }

      let project;
      try {
        project = await projectUtils.getProjectFromViewId(viewId);
      } catch (_error) {
        warnings.push(
          apiWarning(
            "ProjectUtils.getProjectFromViewId",
            "PROJECT_FROM_VIEW_READ_FAILED",
            "Project panel view가 가리키는 project를 읽지 못했습니다.",
            { viewId: guidText(viewId) }
          )
        );
        continue;
      }
      if (!project) {
        warnings.push(
          apiWarning(
            "ProjectUtils.getProjectFromViewId",
            "PROJECT_FROM_VIEW_UNAVAILABLE",
            "Project panel view가 유효한 project를 반환하지 않았습니다.",
            { viewId: guidText(viewId) }
          )
        );
        continue;
      }

      const selection = await readProjectViewSelection(
        projectUtils,
        project,
        viewId,
        remaining,
        warnings
      );
      remaining -= selection.returnedCount;
      views.push({
        viewId: guidText(viewId),
        ...projectMetadata(project),
        ...selection
      });
    }
  }

  const selectionCount = views.reduce(
    (total, view) => total + view.selectedCount,
    0
  );
  const returnedCount = views.reduce(
    (total, view) => total + view.returnedCount,
    0
  );
  return {
    scope: args.scope,
    viewCount: views.length,
    selectionCount,
    returnedCount,
    truncated:
      views.some((view) => view.truncated) ||
      warnings.some((warning) => /LIMIT_REACHED$/.test(warning.code)),
    limits: {
      views: MAX_PROJECT_VIEWS,
      itemsPerView: MAX_SELECTION_ITEMS_PER_VIEW,
      itemsTotal: MAX_SELECTION_ITEMS_TOTAL
    },
    warnings,
    views
  };
}

function preferenceApi() {
  const api = ppro().AppPreference;
  requireMethod(api, "getValue", "AppPreference.getValue");
  requireMethod(api, "setValue", "AppPreference.setValue");
  return api;
}

function preferenceKey(key) {
  const constants = ppro().Constants;
  const keys = constants && constants.PreferenceKey;
  const value = keys && keys[PREFERENCE_KEYS[key]];
  if (value === undefined) {
    throw new BridgeError(
      "UXP_API_UNAVAILABLE",
      `Premiere UXP PreferenceKey.${PREFERENCE_KEYS[key]} constant를 사용할 수 없습니다.`
    );
  }
  return value;
}

function preferencePersistence(persistence) {
  const constants = ppro().Constants;
  const types = constants && constants.PropertyType;
  const value = types && types[PREFERENCE_PERSISTENCE[persistence]];
  if (value === undefined) {
    throw new BridgeError(
      "UXP_API_UNAVAILABLE",
      `Premiere UXP PropertyType.${PREFERENCE_PERSISTENCE[persistence]} constant를 사용할 수 없습니다.`
    );
  }
  return value;
}

function booleanFromNativePreference(value) {
  const normalized = String(value).trim().toLocaleLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return null;
}

async function readPreference(key) {
  const api = preferenceApi();
  const raw = await Promise.resolve(api.getValue(preferenceKey(key)));
  const bounded = boundedText(raw, 256);
  return {
    key,
    rawValue: bounded.value,
    value: booleanFromNativePreference(raw),
    valueType: booleanFromNativePreference(raw) === null ? "native_string" : "boolean",
    truncated: bounded.truncated
  };
}

async function getAppPreference(args) {
  return readPreference(args.key);
}

async function setAppPreference(args) {
  const api = preferenceApi();
  const before = await readPreference(args.key);
  let accepted = false;
  try {
    accepted = Boolean(
      await Promise.resolve(
        api.setValue(
          preferenceKey(args.key),
          args.value,
          preferencePersistence(args.persistence)
        )
      )
    );
  } catch (_error) {
    throw new BridgeError(
      "APP_PREFERENCE_WRITE_FAILED",
      "Premiere가 application preference 변경을 처리하지 못했습니다."
    );
  }
  if (!accepted) {
    throw new BridgeError(
      "APP_PREFERENCE_WRITE_REJECTED",
      "Premiere가 application preference 변경을 거부했습니다."
    );
  }

  const after = await readPreference(args.key);
  if (after.value !== null && after.value !== args.value) {
    throw new BridgeError(
      "APP_PREFERENCE_READBACK_MISMATCH",
      "Application preference read-back이 요청한 boolean과 일치하지 않습니다.",
      { requestedValue: args.value, actualValue: after.value }
    );
  }
  return {
    updated: true,
    changed: before.rawValue !== after.rawValue,
    key: args.key,
    previousValue: before.value,
    previousRawValue: before.rawValue,
    value: after.value,
    rawValue: after.rawValue,
    persistence: args.persistence,
    readbackVerified: after.value !== null,
    appGlobal: true,
    undoable: false
  };
}

function scratchFolderType(name) {
  const constants = ppro().Constants;
  const types = constants && constants.ScratchDiskFolderType;
  const value = types && types[SCRATCH_FOLDER_TYPES[name]];
  if (value === undefined) {
    throw new BridgeError(
      "UXP_API_UNAVAILABLE",
      `Premiere UXP ScratchDiskFolderType.${SCRATCH_FOLDER_TYPES[name]} constant를 사용할 수 없습니다.`
    );
  }
  return value;
}

async function getActiveProductionScratchDisks() {
  const productionApi = ppro().PRProduction;
  const getActive = requireMethod(
    productionApi,
    "getActiveProduction",
    "PRProduction.getActiveProduction"
  );
  const production = await Promise.resolve(getActive());
  if (!production) {
    return { active: false, scratchDisks: {}, warnings: [] };
  }

  const getSettings = requireMethod(
    production,
    "getScratchDiskSettings",
    "PRProduction.getScratchDiskSettings"
  );
  const settings = await getSettings();
  const getPath = requireMethod(
    settings,
    "getScratchDiskPath",
    "ScratchDiskSettings.getScratchDiskPath"
  );
  const scratchDisks = {};
  const warnings = [];
  for (const name of Object.keys(SCRATCH_FOLDER_TYPES)) {
    try {
      const rawPath = getPath(scratchFolderType(name));
      const bounded = boundedText(rawPath, 2048);
      scratchDisks[name] = {
        path: bounded.value,
        truncated: bounded.truncated
      };
    } catch (_error) {
      scratchDisks[name] = { path: null, truncated: false };
      warnings.push(
        apiWarning(
          "ScratchDiskSettings.getScratchDiskPath",
          "PRODUCTION_SCRATCH_PATH_READ_FAILED",
          `Production scratch disk 경로를 읽지 못했습니다: ${name}`,
          { folderType: name }
        )
      );
    }
  }
  return { active: true, scratchDisks, warnings };
}

async function isAfterEffectsInstalled() {
  const utils = ppro().Utils;
  const check = requireMethod(utils, "isAEInstalled", "Utils.isAEInstalled");
  return {
    installed: Boolean(await check())
  };
}

async function resolvePropertyOwner(args) {
  const project = await getActiveProject();
  if (args.owner === "project") {
    return {
      project,
      target: project,
      metadata: { owner: "project", ...projectMetadata(project) }
    };
  }
  const sequence = await findSequence(project, args.sequence_id);
  return {
    project,
    target: sequence,
    metadata: {
      owner: "sequence",
      ...projectMetadata(project),
      sequenceId: guidText(sequence.guid),
      sequenceName: boundedText(sequence.name || "", 512).value
    }
  };
}

async function getPropertiesForOwner(target) {
  const propertiesApi = ppro().Properties;
  const getProperties = requireMethod(
    propertiesApi,
    "getProperties",
    "Properties.getProperties"
  );
  const properties = await getProperties(target);
  if (!properties) {
    throw new BridgeError(
      "CUSTOM_PROPERTIES_UNAVAILABLE",
      "Premiere가 Properties 객체를 반환하지 않았습니다."
    );
  }
  return properties;
}

function normalizePropertyValue(value, valueType) {
  if (valueType === "string") {
    const bounded = boundedText(value, MAX_PROPERTY_STRING_LENGTH);
    return {
      value: bounded.value,
      truncated: bounded.truncated,
      originalLength: bounded.originalLength
    };
  }
  if (valueType === "boolean") {
    return { value: Boolean(value), truncated: false, originalLength: null };
  }
  const numeric = Number(value);
  return {
    value: Number.isFinite(numeric) ? numeric : null,
    truncated: false,
    originalLength: null
  };
}

async function getCustomProperties(args) {
  const owner = await resolvePropertyOwner(args);
  const properties = await getPropertiesForOwner(owner.target);
  if (args.property_id === undefined) {
    return {
      ...owner.metadata,
      enumerationSupported: false,
      propertyCount: 0,
      properties: [],
      limits: { properties: 1, propertyStringLength: MAX_PROPERTY_STRING_LENGTH },
      warnings: [
        apiWarning(
          "Properties",
          "PROPERTY_ENUMERATION_UNAVAILABLE",
          "Premiere 26.3 stable UXP는 custom property ID 열거 API를 제공하지 않습니다. property_id를 지정하면 해당 값만 읽을 수 있습니다."
        )
      ]
    };
  }

  const hasValue = requireMethod(
    properties,
    "hasValue",
    "Properties.hasValue"
  );
  const exists = Boolean(hasValue(args.property_id));
  if (!exists) {
    return {
      ...owner.metadata,
      enumerationSupported: false,
      propertyCount: 1,
      properties: [
        {
          propertyId: args.property_id,
          exists: false,
          valueType: args.value_type,
          value: null,
          truncated: false
        }
      ],
      limits: { properties: 1, propertyStringLength: MAX_PROPERTY_STRING_LENGTH },
      warnings: []
    };
  }

  const getterName = PROPERTY_VALUE_GETTERS[args.value_type];
  const getter = requireMethod(
    properties,
    getterName,
    `Properties.${getterName}`
  );
  const normalized = normalizePropertyValue(
    await Promise.resolve(getter(args.property_id)),
    args.value_type
  );
  return {
    ...owner.metadata,
    enumerationSupported: false,
    propertyCount: 1,
    properties: [
      {
        propertyId: args.property_id,
        exists: true,
        valueType: args.value_type,
        value: normalized.value,
        truncated: normalized.truncated,
        originalLength: normalized.originalLength
      }
    ],
    limits: { properties: 1, propertyStringLength: MAX_PROPERTY_STRING_LENGTH },
    warnings: []
  };
}

async function clearCustomProperty(args) {
  const owner = await resolvePropertyOwner(args);
  const before = await getPropertiesForOwner(owner.target);
  const hasValue = requireMethod(before, "hasValue", "Properties.hasValue");
  if (!hasValue(args.property_id)) {
    throw new BridgeError(
      "CUSTOM_PROPERTY_NOT_FOUND",
      `Custom property가 없습니다: ${args.property_id}`
    );
  }

  executeUndoableTransaction(owner.project, "clear_custom_property", (compoundAction) => {
    // executeUndoableTransaction invokes this callback synchronously inside
    // Project.lockedAccess() and Project.executeTransaction().
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- custom transaction wrapper preserves Adobe's lock scope
    const action = before.createClearValueAction(args.property_id);
    addAction(compoundAction, action, "clear_custom_property");
  });

  const after = await getPropertiesForOwner(owner.target);
  const stillExists = Boolean(
    requireMethod(after, "hasValue", "Properties.hasValue")(args.property_id)
  );
  if (stillExists) {
    throw new BridgeError(
      "CUSTOM_PROPERTY_READBACK_MISMATCH",
      "Custom property clear 후 값이 여전히 존재합니다.",
      { propertyId: args.property_id }
    );
  }
  return {
    cleared: true,
    changed: true,
    ...owner.metadata,
    propertyId: args.property_id,
    hasValue: false,
    undoable: true
  };
}

module.exports = {
  category: "official-transcript-project",
  handlers: [
    {
      name: "import_clip_transcript_json",
      writes: true,
      dangerous: true,
      validate: validateImportTranscript,
      execute: importClipTranscriptJson
    },
    {
      name: "get_project_panel_selection",
      writes: false,
      validate: validateProjectPanelSelection,
      execute: getProjectPanelSelection
    },
    {
      name: "get_app_preference",
      writes: false,
      validate: validateGetPreference,
      execute: getAppPreference
    },
    {
      name: "set_app_preference",
      writes: true,
      dangerous: true,
      validate: validateSetPreference,
      execute: setAppPreference
    },
    {
      name: "get_active_production_scratch_disks",
      writes: false,
      validate: validateNoArgs,
      execute: getActiveProductionScratchDisks
    },
    {
      name: "is_after_effects_installed",
      writes: false,
      validate: validateNoArgs,
      execute: isAfterEffectsInstalled
    },
    {
      name: "get_custom_properties",
      writes: false,
      validate: validateGetCustomProperties,
      execute: getCustomProperties
    },
    {
      name: "clear_custom_property",
      writes: true,
      dangerous: true,
      validate: validateClearCustomProperty,
      execute: clearCustomProperty
    }
  ]
};
