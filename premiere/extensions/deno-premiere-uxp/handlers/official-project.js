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
  rejectUnknown,
  stringArg,
  validateNoArgs
} = require("./shared.js");

const SCRATCH_FOLDER_TYPES = Object.freeze({
  capture: "CAPTURE",
  audio_preview: "AUDIO_PREVIEW",
  video_preview: "VIDEO_PREVIEW",
  auto_save: "AUTO_SAVE",
  cc_libraries: "CCL_LIBRARIES",
  capsule_media: "CAPSULE_MEDIA"
});

const SCRATCH_LOCATIONS = Object.freeze({
  same_as_project: "SAME_AS_PROJECT",
  my_documents: "MY_DOCUMENTS"
});

function validateProjectPath(args) {
  rejectUnknown(args, ["project_path"]);
  return { project_path: stringArg(args.project_path, "project_path") };
}

function validateOpenSequence(args) {
  rejectUnknown(args, ["sequence_id"]);
  return { sequence_id: stringArg(args.sequence_id, "sequence_id") };
}

function validatePauseGrowingMedia(args) {
  rejectUnknown(args, ["paused"]);
  return { paused: booleanArg(args.paused, "paused") };
}

function validateObjectMask(args) {
  rejectUnknown(args, ["scope", "sequence_id"]);
  const scope = enumArg(args.scope, "scope", ["project", "sequence"]);
  const sequenceId =
    args.sequence_id === undefined
      ? undefined
      : stringArg(args.sequence_id, "sequence_id");
  if (scope === "project" && sequenceId !== undefined) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "scope가 project이면 sequence_id를 함께 보낼 수 없습니다."
    );
  }
  return { scope, sequence_id: sequenceId };
}

function validateIngestEnabled(args) {
  rejectUnknown(args, ["enabled"]);
  return { enabled: booleanArg(args.enabled, "enabled") };
}

function validateScratchDiskMode(args) {
  rejectUnknown(args, ["folder_type", "location"]);
  return {
    folder_type: enumArg(
      args.folder_type,
      "folder_type",
      Object.keys(SCRATCH_FOLDER_TYPES)
    ),
    location: enumArg(
      args.location,
      "location",
      Object.keys(SCRATCH_LOCATIONS)
    )
  };
}

function requireMethod(target, methodName, label) {
  if (!target || typeof target[methodName] !== "function") {
    throw new BridgeError(
      "UXP_API_UNAVAILABLE",
      `Premiere UXP ${label || methodName} API를 사용할 수 없습니다.`
    );
  }
  return target[methodName].bind(target);
}

function projectMetadata(project) {
  return {
    projectId: guidText(project.guid),
    projectName: String(project.name || ""),
    projectPath: String(project.path || "")
  };
}

async function isPremiereProject(args) {
  const projectApi = ppro().Project;
  const isProject = requireMethod(projectApi, "isProject", "Project.isProject");
  let result;
  try {
    result = Boolean(isProject(args.project_path));
  } catch (error) {
    throw new BridgeError(
      "PROJECT_PATH_CHECK_FAILED",
      "Premiere project 경로를 판별하지 못했습니다.",
      String(error && (error.message || error))
    );
  }
  return {
    projectPath: args.project_path,
    isPremiereProject: result
  };
}

async function openSequence(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  const open = requireMethod(project, "openSequence", "Project.openSequence");
  if (!(await open(sequence))) {
    throw new BridgeError(
      "SEQUENCE_OPEN_REJECTED",
      "Premiere가 sequence 열기를 거부했습니다."
    );
  }

  const activeSequence = await project.getActiveSequence();
  const sequenceId = guidText(sequence.guid);
  const activeSequenceId = activeSequence ? guidText(activeSequence.guid) : "";
  return {
    opened: true,
    ...projectMetadata(project),
    sequenceId,
    sequenceName: String(sequence.name || ""),
    activeSequenceId,
    activeSequenceName: activeSequence ? String(activeSequence.name || "") : "",
    isActive: activeSequenceId === sequenceId,
    undoable: false
  };
}

async function pauseGrowingMedia(args) {
  const project = await getActiveProject();
  const pauseGrowing = requireMethod(
    project,
    "pauseGrowing",
    "Project.pauseGrowing"
  );
  if (!(await pauseGrowing(args.paused))) {
    throw new BridgeError(
      "GROWING_MEDIA_PAUSE_REJECTED",
      "Premiere가 growing media 상태 변경을 거부했습니다."
    );
  }
  return {
    updated: true,
    ...projectMetadata(project),
    requestedPaused: args.paused,
    paused: args.paused,
    readbackAvailable: false,
    undoable: false
  };
}

async function hasObjectMask(args) {
  const project = await getActiveProject();
  const objectMaskApi = ppro().ObjectMaskUtils;
  const check = requireMethod(
    objectMaskApi,
    "hasObjectMask",
    "ObjectMaskUtils.hasObjectMask"
  );
  const target =
    args.scope === "project"
      ? project
      : await findSequence(project, args.sequence_id);
  const result = {
    scope: args.scope,
    ...projectMetadata(project),
    hasObjectMask: Boolean(check(target))
  };
  if (args.scope === "sequence") {
    result.sequenceId = guidText(target.guid);
    result.sequenceName = String(target.name || "");
  }
  return result;
}

function projectSettingsApi() {
  const api = ppro().ProjectSettings;
  if (!api) {
    throw new BridgeError(
      "UXP_API_UNAVAILABLE",
      "Premiere UXP ProjectSettings API를 사용할 수 없습니다."
    );
  }
  return api;
}

async function readIngestEnabled(project) {
  const api = projectSettingsApi();
  const getSettings = requireMethod(
    api,
    "getIngestSettings",
    "ProjectSettings.getIngestSettings"
  );
  const settings = await getSettings(project);
  if (!settings) {
    throw new BridgeError(
      "INGEST_SETTINGS_UNAVAILABLE",
      "Project ingest settings를 가져올 수 없습니다."
    );
  }
  const readEnabled = requireMethod(
    settings,
    "getIsIngestEnabled",
    "IngestSettings.getIsIngestEnabled"
  );
  return {
    settings,
    enabled: Boolean(await readEnabled())
  };
}

async function getProjectIngestSettings() {
  const project = await getActiveProject();
  const current = await readIngestEnabled(project);
  return {
    ...projectMetadata(project),
    enabled: current.enabled
  };
}

async function setProjectIngestEnabled(args) {
  const project = await getActiveProject();
  const api = projectSettingsApi();
  const before = await readIngestEnabled(project);
  const setEnabled = requireMethod(
    before.settings,
    "setIngestEnabled",
    "IngestSettings.setIngestEnabled"
  );
  if (!(await setEnabled(args.enabled))) {
    throw new BridgeError(
      "INGEST_SETTINGS_REJECTED",
      "Premiere가 ingest setting 변경을 거부했습니다."
    );
  }

  executeUndoableTransaction(
    project,
    "set_project_ingest_enabled",
    (compoundAction) => {
      const createAction = requireMethod(
        api,
        "createSetIngestSettingsAction",
        "ProjectSettings.createSetIngestSettingsAction"
      );
      addAction(
        compoundAction,
        createAction(project, before.settings),
        "set_project_ingest_enabled"
      );
    }
  );

  const after = await readIngestEnabled(project);
  if (after.enabled !== args.enabled) {
    throw new BridgeError(
      "INGEST_SETTINGS_READBACK_MISMATCH",
      "Project ingest setting read-back이 요청값과 일치하지 않습니다.",
      { requestedEnabled: args.enabled, actualEnabled: after.enabled }
    );
  }
  return {
    updated: true,
    changed: before.enabled !== after.enabled,
    ...projectMetadata(project),
    previousEnabled: before.enabled,
    enabled: after.enabled,
    undoable: true
  };
}

function scratchDiskConstants() {
  const constants = ppro().Constants || {};
  const types = constants.ScratchDiskFolderType;
  const locations = constants.ScratchDiskFolder;
  if (!types || !locations) {
    throw new BridgeError(
      "UXP_API_UNAVAILABLE",
      "Premiere UXP scratch disk constants를 사용할 수 없습니다."
    );
  }
  return { types, locations };
}

function scratchDiskType(name) {
  const { types } = scratchDiskConstants();
  const value = types[SCRATCH_FOLDER_TYPES[name]];
  if (value === undefined) {
    throw new BridgeError(
      "UXP_API_UNAVAILABLE",
      `Scratch disk folder type을 사용할 수 없습니다: ${name}`
    );
  }
  return value;
}

function scratchDiskLocation(name) {
  const { locations } = scratchDiskConstants();
  const value = locations[SCRATCH_LOCATIONS[name]];
  if (value === undefined) {
    throw new BridgeError(
      "UXP_API_UNAVAILABLE",
      `Scratch disk location을 사용할 수 없습니다: ${name}`
    );
  }
  return value;
}

async function getScratchDiskSettings(project) {
  const api = projectSettingsApi();
  const getSettings = requireMethod(
    api,
    "getScratchDiskSettings",
    "ProjectSettings.getScratchDiskSettings"
  );
  const settings = await getSettings(project);
  if (!settings) {
    throw new BridgeError(
      "SCRATCH_DISK_SETTINGS_UNAVAILABLE",
      "Project scratch disk settings를 가져올 수 없습니다."
    );
  }
  return { api, settings };
}

function readScratchDiskPaths(settings) {
  const readPath = requireMethod(
    settings,
    "getScratchDiskPath",
    "ScratchDiskSettings.getScratchDiskPath"
  );
  const paths = {};
  for (const name of Object.keys(SCRATCH_FOLDER_TYPES)) {
    paths[name] = String(readPath(scratchDiskType(name)) || "");
  }
  return paths;
}

async function setProjectScratchDiskMode(args) {
  const project = await getActiveProject();
  const current = await getScratchDiskSettings(project);
  const previousPaths = readScratchDiskPaths(current.settings);
  const setPath = requireMethod(
    current.settings,
    "setScratchDiskPath",
    "ScratchDiskSettings.setScratchDiskPath"
  );
  if (
    !setPath(
      scratchDiskType(args.folder_type),
      scratchDiskLocation(args.location)
    )
  ) {
    throw new BridgeError(
      "SCRATCH_DISK_SETTINGS_REJECTED",
      "Premiere가 scratch disk setting 변경을 거부했습니다."
    );
  }

  executeUndoableTransaction(
    project,
    "set_project_scratch_disk_mode",
    (compoundAction) => {
      const createAction = requireMethod(
        current.api,
        "createSetScratchDiskSettingsAction",
        "ProjectSettings.createSetScratchDiskSettingsAction"
      );
      addAction(
        compoundAction,
        createAction(project, current.settings),
        "set_project_scratch_disk_mode"
      );
    }
  );

  const readback = await getScratchDiskSettings(project);
  const paths = readScratchDiskPaths(readback.settings);
  return {
    updated: true,
    changed: previousPaths[args.folder_type] !== paths[args.folder_type],
    ...projectMetadata(project),
    folderType: args.folder_type,
    location: args.location,
    previousPath: previousPaths[args.folder_type],
    path: paths[args.folder_type],
    paths,
    undoable: true
  };
}

module.exports = {
  category: "official-project",
  handlers: [
    {
      name: "is_premiere_project",
      writes: false,
      validate: validateProjectPath,
      execute: isPremiereProject
    },
    {
      name: "open_sequence",
      writes: true,
      validate: validateOpenSequence,
      execute: openSequence
    },
    {
      name: "pause_growing_media",
      writes: true,
      validate: validatePauseGrowingMedia,
      execute: pauseGrowingMedia
    },
    {
      name: "has_object_mask",
      writes: false,
      validate: validateObjectMask,
      execute: hasObjectMask
    },
    {
      name: "get_project_ingest_settings",
      writes: false,
      validate: validateNoArgs,
      execute: getProjectIngestSettings
    },
    {
      name: "set_project_ingest_enabled",
      writes: true,
      validate: validateIngestEnabled,
      execute: setProjectIngestEnabled
    },
    {
      name: "set_project_scratch_disk_mode",
      writes: true,
      dangerous: true,
      validate: validateScratchDiskMode,
      execute: setProjectScratchDiskMode
    }
  ]
};
