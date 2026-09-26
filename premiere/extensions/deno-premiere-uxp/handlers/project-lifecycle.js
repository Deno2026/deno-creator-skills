const { BridgeError } = require("./errors.js");
const {
  addAction,
  arrayArg,
  booleanArg,
  executeUndoableTransaction,
  getActiveProject,
  ppro,
  rejectUnknown,
  requireProjectItem,
  stringArg,
  validateNoArgs
} = require("./shared.js");

function validatePath(args) {
  rejectUnknown(args, ["path"]);
  return { path: stringArg(args.path, "path") };
}

function validateClose(args) {
  rejectUnknown(args, ["save_first"]);
  return {
    save_first: booleanArg(args.save_first, "save_first", {
      optional: true,
      fallback: true
    })
  };
}

function validateAeImport(args) {
  rejectUnknown(args, ["ae_project_path", "comp_names", "target_bin"]);
  const names = arrayArg(args.comp_names, "comp_names", {
    optional: true,
    fallback: []
  }).map((value, index) => stringArg(value, `comp_names[${index}]`));
  return {
    ae_project_path: stringArg(args.ae_project_path, "ae_project_path"),
    comp_names: names,
    target_bin: stringArg(args.target_bin, "target_bin", {
      optional: true,
      fallback: undefined
    })
  };
}

function validateImportSequences(args) {
  rejectUnknown(args, ["project_path", "sequence_ids"]);
  const ids = arrayArg(args.sequence_ids, "sequence_ids", {
    optional: true,
    fallback: []
  }).map((value, index) => stringArg(value, `sequence_ids[${index}]`));
  return {
    project_path: stringArg(args.project_path, "project_path"),
    sequence_ids: ids
  };
}

function validateIngest(args) {
  rejectUnknown(args, ["enabled"]);
  return { enabled: booleanArg(args.enabled, "enabled") };
}

async function saveProject() {
  const project = await getActiveProject();
  const saved = await project.save();
  if (!saved) throw new BridgeError("SAVE_FAILED", "Project save failed");
  return { saved: true, path: String(project.path || ""), undoable: false };
}

async function saveProjectAs(args) {
  const project = await getActiveProject();
  const saved = await project.saveAs(args.path);
  if (!saved) throw new BridgeError("SAVE_FAILED", "Project Save As failed");
  return { saved: true, path: args.path, undoable: false };
}

async function openProject(args) {
  const options = new (ppro().OpenProjectOptions)();
  options.setAddToMRUList(true);
  options.setShowConvertProjectDialog(true);
  options.setShowLocateFileDialog(true);
  options.setShowWarningDialog(true);
  const project = await ppro().Project.open(args.path, options);
  if (!project) throw new BridgeError("OPEN_FAILED", "Project open failed");
  return {
    opened: true,
    name: String(project.name || ""),
    path: String(project.path || args.path),
    undoable: false
  };
}

async function createProject(args) {
  const project = await ppro().Project.createProject(args.path);
  if (!project) throw new BridgeError("CREATE_PROJECT_FAILED", "Project creation failed");
  return {
    created: true,
    name: String(project.name || ""),
    path: String(project.path || args.path),
    undoable: false
  };
}

async function closeProject(args) {
  const project = await getActiveProject();
  if (args.save_first && !(await project.save())) {
    throw new BridgeError("SAVE_FAILED", "Project save failed; close was not attempted");
  }
  const options = new (ppro().CloseProjectOptions)();
  options.setPromptIfDirty(!args.save_first);
  options.setShowCancelButton(true);
  options.setSaveWorkspace(true);
  options.setIsAppBeingPreparedToQuit(false);
  const closed = await project.close(options);
  if (!closed) throw new BridgeError("CLOSE_FAILED", "Project close was cancelled or failed");
  return { closed: true, savedFirst: args.save_first, undoable: false };
}

async function optionalTargetBin(project, selector) {
  if (!selector) return undefined;
  const item = await requireProjectItem(project, selector, "Bin");
  let folder = null;
  try {
    folder = ppro().FolderItem.cast(item);
  } catch (_error) {
    folder = null;
  }
  if (!folder) throw new BridgeError("NOT_A_BIN", `Bin required: ${selector}`);
  return folder;
}

async function importAeComps(args) {
  const project = await getActiveProject();
  const target = await optionalTargetBin(project, args.target_bin);
  const imported = args.comp_names.length
    ? await project.importAEComps(args.ae_project_path, args.comp_names, target)
    : await project.importAllAEComps(args.ae_project_path, target);
  if (!imported) throw new BridgeError("AE_IMPORT_FAILED", "After Effects comp import failed");
  return {
    imported: true,
    compNames: args.comp_names,
    targetBin: target ? String(target.name || "") : null,
    undoable: false
  };
}

async function importSequences(args) {
  const project = await getActiveProject();
  const ids = args.sequence_ids.map((value) => ppro().Guid.fromString(value));
  const imported = await project.importSequences(
    args.project_path,
    ids.length ? ids : undefined
  );
  if (!imported) throw new BridgeError("SEQUENCE_IMPORT_FAILED", "Sequence import failed");
  return { imported: true, sequenceIds: args.sequence_ids, undoable: false };
}

async function setTranscodeOnIngest(args) {
  const project = await getActiveProject();
  const settings = await ppro().ProjectSettings.getIngestSettings(project);
  const accepted = await settings.setIngestEnabled(args.enabled);
  if (!accepted) throw new BridgeError("INGEST_SETTING_REJECTED", "Ingest setting rejected");
  executeUndoableTransaction(project, "set_transcode_on_ingest", (compound) => {
    addAction(
      compound,
      // executeUndoableTransaction invokes this callback synchronously inside
      // Project.lockedAccess() and Project.executeTransaction().
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- custom transaction wrapper preserves Adobe's lock scope
      ppro().ProjectSettings.createSetIngestSettingsAction(project, settings),
      "set_transcode_on_ingest"
    );
  });
  return { enabled: args.enabled, undoable: true };
}

async function getProjectScratchDisks() {
  const project = await getActiveProject();
  const settings = await ppro().ProjectSettings.getScratchDiskSettings(project);
  const types = ppro().Constants.ScratchDiskFolderType;
  return {
    captured: settings.getScratchDiskPath(types.CAPTURE),
    audioPreviews: settings.getScratchDiskPath(types.AUDIO_PREVIEW),
    videoPreviews: settings.getScratchDiskPath(types.VIDEO_PREVIEW),
    autoSave: settings.getScratchDiskPath(types.AUTO_SAVE),
    ccLibraries: settings.getScratchDiskPath(types.CCL_LIBRARIES),
    capsuleMedia: settings.getScratchDiskPath(types.CAPSULE_MEDIA)
  };
}

module.exports = {
  category: "project-lifecycle",
  handlers: [
    { name: "save_project", writes: true, dangerous: true, validate: validateNoArgs, execute: saveProject },
    { name: "save_project_as", writes: true, dangerous: true, validate: validatePath, execute: saveProjectAs },
    { name: "open_project", writes: true, dangerous: true, validate: validatePath, execute: openProject },
    { name: "create_project", writes: true, dangerous: true, validate: validatePath, execute: createProject },
    { name: "close_project", writes: true, dangerous: true, validate: validateClose, execute: closeProject },
    { name: "import_ae_comps", writes: true, dangerous: true, validate: validateAeImport, execute: importAeComps },
    { name: "import_sequences", writes: true, dangerous: true, validate: validateImportSequences, execute: importSequences },
    { name: "set_transcode_on_ingest", writes: true, validate: validateIngest, execute: setTranscodeOnIngest },
    { name: "get_project_scratch_disks", writes: false, validate: validateNoArgs, execute: getProjectScratchDisks }
  ]
};
