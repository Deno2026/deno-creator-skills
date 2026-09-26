const { BridgeError } = require("./errors.js");
const {
  findProjectItem,
  getActiveProject,
  ppro,
  projectItemId,
  readValue
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

function validateImportArgs(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["file_paths", "target_bin", "suppress_ui"]);

  if (!Array.isArray(args.file_paths) || args.file_paths.length === 0) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "file_paths는 하나 이상의 경로가 든 배열이어야 합니다."
    );
  }
  const filePaths = args.file_paths.map((value, index) =>
    nonEmptyString(value, `file_paths[${index}]`)
  );

  if (args.suppress_ui !== undefined && typeof args.suppress_ui !== "boolean") {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "suppress_ui는 boolean이어야 합니다."
    );
  }

  const normalized = {
    file_paths: filePaths,
    suppress_ui: args.suppress_ui !== false
  };
  if (args.target_bin !== undefined) {
    normalized.target_bin = nonEmptyString(args.target_bin, "target_bin");
  }
  return normalized;
}

function validateFindArgs(args) {
  if (!isPlainObject(args)) {
    throw new BridgeError("INVALID_ARGUMENTS", "args는 JSON object여야 합니다.");
  }
  rejectUnknown(args, ["name"]);
  return { name: nonEmptyString(args.name, "name") };
}

async function importMedia(args) {
  const project = await getActiveProject();
  let targetBin;
  if (args.target_bin) {
    const selected = await findProjectItem(project, args.target_bin);
    if (!selected) {
      throw new BridgeError(
        "PROJECT_ITEM_NOT_FOUND",
        `Bin not found: ${args.target_bin}`
      );
    }
    try {
      targetBin = ppro().FolderItem.cast(selected);
    } catch (_error) {
      targetBin = null;
    }
    if (!targetBin) {
      throw new BridgeError("NOT_A_BIN", `Bin required: ${args.target_bin}`);
    }
  } else {
    targetBin = await project.getRootItem();
  }

  // Premiere 26.3 d.ts exposes importFiles() only as a direct Promise API.
  // There is no import Action to add to executeTransaction, so this command
  // cannot offer the one-step Undo contract used by the timeline/marker writes.
  const imported = await project.importFiles(
    args.file_paths,
    args.suppress_ui,
    targetBin,
    false
  );
  if (!imported) {
    throw new BridgeError("IMPORT_FAILED", "Import failed");
  }

  return {
    imported: args.file_paths.length,
    files: args.file_paths
  };
}

async function sequenceProjectItemIds(project) {
  const ids = new Set();
  const sequences = await project.getSequences();
  for (const sequence of Array.from(sequences || [])) {
    try {
      const item = await sequence.getProjectItem();
      const id = await projectItemId(item);
      if (id) ids.add(id);
    } catch (_error) {
      // A stale sequence must not prevent discovery of ordinary project items.
    }
  }
  return ids;
}

async function projectItemType(project, item, id) {
  const itemTypes = ppro().ProjectItem || {};
  const type = await readValue(item, "type");
  const sequenceIds = await sequenceProjectItemIds(project);
  if (sequenceIds.has(id)) return "sequence";
  if (type === itemTypes.TYPE_BIN || type === itemTypes.TYPE_ROOT) return "bin";
  if (
    type === itemTypes.TYPE_CLIP ||
    type === itemTypes.TYPE_FILE ||
    type === itemTypes.TYPE_COMPOUND
  ) {
    return "clip";
  }
  return "unknown";
}

async function mediaPathOf(item) {
  try {
    const clipItem = ppro().ClipProjectItem.cast(item);
    if (clipItem && typeof clipItem.getMediaFilePath === "function") {
      return String((await clipItem.getMediaFilePath()) || "");
    }
  } catch (_error) {
    // Bins and sequence project items do not expose a media file path.
  }
  return "";
}

async function findProjectItemByName(args) {
  const project = await getActiveProject();
  const item = await findProjectItem(project, args.name);
  if (!item) {
    throw new BridgeError(
      "PROJECT_ITEM_NOT_FOUND",
      `Project item not found: ${args.name}`
    );
  }

  const nodeId = await projectItemId(item);
  return {
    nodeId,
    name: String(item.name || ""),
    // UXP uses TYPE_* constants rather than CEP's numeric 1/2/3 mapping.
    // Sequence identity is therefore resolved through Sequence.getProjectItem().
    type: await projectItemType(project, item, nodeId),
    mediaPath: await mediaPathOf(item)
  };
}

module.exports = {
  category: "project",
  handlers: [
    {
      name: "import_media",
      writes: true,
      validate: validateImportArgs,
      execute: importMedia
    },
    {
      name: "find_project_item_by_name",
      writes: false,
      validate: validateFindArgs,
      execute: findProjectItemByName
    }
  ]
};
