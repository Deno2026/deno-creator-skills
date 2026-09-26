const { BridgeError } = require("./errors.js");
const {
  addAction,
  arrayArg,
  booleanArg,
  collectProjectItems,
  executeUndoableTransaction,
  getActiveProject,
  numberArg,
  ppro,
  projectItemId,
  rejectUnknown,
  requireClipProjectItem,
  requireProjectItem,
  stringArg,
  tickTimeFromSeconds
} = require("./shared.js");
const { readProjectItemSnapshot } = require("./inspection-helpers.js");

function validateCreateBin(args) {
  rejectUnknown(args, ["name", "parent_bin"]);
  return {
    name: stringArg(args.name, "name"),
    parent_bin: stringArg(args.parent_bin, "parent_bin", {
      optional: true,
      fallback: undefined
    })
  };
}

function validateMove(args) {
  rejectUnknown(args, ["item_id", "target_bin"]);
  return {
    item_id: stringArg(args.item_id, "item_id"),
    target_bin: stringArg(args.target_bin, "target_bin")
  };
}

function boundedUniqueItemIds(value) {
  const values = arrayArg(value, "item_ids", { nonEmpty: true });
  if (values.length > 20) {
    throw new BridgeError(
      "TARGET_LIMIT_EXCEEDED",
      "item_ids는 한 번에 최대 20개까지 처리할 수 있습니다."
    );
  }
  const itemIds = values.map((item, index) =>
    stringArg(item, `item_ids[${index}]`)
  );
  const normalized = itemIds.map((item) => item.toLocaleLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    throw new BridgeError(
      "DUPLICATE_TARGET",
      "item_ids에는 중복된 ID 또는 이름을 넣을 수 없습니다."
    );
  }
  return itemIds;
}

function validateMoveItems(args) {
  rejectUnknown(args, ["item_ids", "target_bin"]);
  return {
    item_ids: boundedUniqueItemIds(args.item_ids),
    target_bin: stringArg(args.target_bin, "target_bin")
  };
}

function validateDeleteItems(args) {
  rejectUnknown(args, ["item_ids"]);
  return { item_ids: boundedUniqueItemIds(args.item_ids) };
}

function validateItem(args) {
  rejectUnknown(args, ["item_id"]);
  return { item_id: stringArg(args.item_id, "item_id") };
}

function validateBin(args) {
  rejectUnknown(args, ["bin_id"]);
  return { bin_id: stringArg(args.bin_id, "bin_id") };
}

function validateRenameBin(args) {
  rejectUnknown(args, ["bin_id", "new_name"]);
  return {
    bin_id: stringArg(args.bin_id, "bin_id"),
    new_name: stringArg(args.new_name, "new_name")
  };
}

function validateSmartBin(args) {
  rejectUnknown(args, ["name", "query"]);
  return {
    name: stringArg(args.name, "name"),
    query: stringArg(args.query, "query")
  };
}

function validateFindPath(args) {
  rejectUnknown(args, ["path_search"]);
  return { path_search: stringArg(args.path_search, "path_search") };
}

function validateRenameItem(args) {
  rejectUnknown(args, ["item_id", "new_name"]);
  return {
    item_id: stringArg(args.item_id, "item_id"),
    new_name: stringArg(args.new_name, "new_name")
  };
}

function validateSubclip(args) {
  rejectUnknown(args, [
    "item_id",
    "name",
    "in_seconds",
    "out_seconds",
    "hard_boundaries",
    "take_video",
    "take_audio"
  ]);
  const inSeconds = numberArg(args.in_seconds, "in_seconds", { min: 0 });
  const outSeconds = numberArg(args.out_seconds, "out_seconds", { min: 0 });
  if (outSeconds <= inSeconds) {
    throw new BridgeError("INVALID_ARGUMENTS", "out_seconds는 in_seconds보다 커야 합니다.");
  }
  const hardBoundaries = booleanArg(args.hard_boundaries, "hard_boundaries", {
    optional: true,
    fallback: true
  });
  const takeVideo = booleanArg(args.take_video, "take_video", {
    optional: true,
    fallback: true
  });
  const takeAudio = booleanArg(args.take_audio, "take_audio", {
    optional: true,
    fallback: true
  });
  if (!takeVideo && !takeAudio) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "take_video와 take_audio를 모두 false로 설정할 수 없습니다."
    );
  }
  return {
    item_id: stringArg(args.item_id, "item_id"),
    name: stringArg(args.name, "name"),
    in_seconds: inSeconds,
    out_seconds: outSeconds,
    hard_boundaries: hardBoundaries,
    take_video: takeVideo,
    take_audio: takeAudio
  };
}

async function asFolder(project, selector, fallbackRoot) {
  const item = selector
    ? await requireProjectItem(project, selector, "Bin")
    : fallbackRoot
      ? await project.getRootItem()
      : null;
  let folder = null;
  try {
    folder = ppro().FolderItem.cast(item);
  } catch (_error) {
    folder = null;
  }
  if (!folder) throw new BridgeError("NOT_A_BIN", `Bin required: ${selector || "root"}`);
  return folder;
}

async function exactProjectEntries(project) {
  const root = await project.getRootItem();
  return {
    root,
    entries: [
      {
        item: root,
        id: await projectItemId(root),
        name: String(root.name || ""),
        type: root.type,
        path: String(root.name || "")
      },
      ...(await collectProjectItems(project))
    ]
  };
}

function resolveExactEntry(entries, selector, label) {
  const target = String(selector).toLocaleLowerCase();
  const idMatches = entries.filter(
    (entry) => entry.id && entry.id.toLocaleLowerCase() === target
  );
  if (idMatches.length === 1) return idMatches[0];
  if (idMatches.length > 1) {
    throw new BridgeError(
      "AMBIGUOUS_PROJECT_ITEM",
      `${label} ID가 둘 이상 일치합니다: ${selector}`
    );
  }
  const nameMatches = entries.filter(
    (entry) => entry.name.toLocaleLowerCase() === target
  );
  if (nameMatches.length === 1) return nameMatches[0];
  if (nameMatches.length > 1) {
    throw new BridgeError(
      "AMBIGUOUS_PROJECT_ITEM",
      `${label} 이름이 둘 이상 일치합니다. 고유 ID를 사용하세요: ${selector}`
    );
  }
  throw new BridgeError(
    "PROJECT_ITEM_NOT_FOUND",
    `${label} not found: ${selector}`
  );
}

function castFolderEntry(entry, label) {
  let folder = null;
  try {
    folder = ppro().FolderItem.cast(entry.item);
  } catch (_error) {
    folder = null;
  }
  if (!folder) {
    throw new BridgeError("NOT_A_BIN", `${label}은 bin이어야 합니다: ${entry.name}`);
  }
  return folder;
}

function sameEntry(left, right) {
  if (left.item === right.item) return true;
  return Boolean(left.id && right.id && left.id === right.id);
}

async function parentEntryOf(entries, item) {
  let parent = null;
  try {
    parent = await Promise.resolve(item.getParentBin());
  } catch (_error) {
    parent = null;
  }
  if (!parent) return null;
  const id = await projectItemId(parent);
  return (
    entries.find((entry) => entry.item === parent) ||
    entries.find((entry) => id && entry.id === id) ||
    {
      item: parent,
      id,
      name: String(parent.name || ""),
      type: parent.type,
      path: String(parent.name || "")
    }
  );
}

async function hasAncestor(entries, candidate, possibleAncestor) {
  let cursor = candidate;
  const visited = new Set();
  while (cursor) {
    if (sameEntry(cursor, possibleAncestor)) return true;
    const key = cursor.id ? `id:${cursor.id}` : cursor.item;
    if (visited.has(key)) return false;
    visited.add(key);
    cursor = await parentEntryOf(entries, cursor.item);
  }
  return false;
}

async function rejectNestedSources(entries, sources, commandName) {
  for (let leftIndex = 0; leftIndex < sources.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sources.length; rightIndex += 1) {
      if (
        (await hasAncestor(entries, sources[leftIndex], sources[rightIndex])) ||
        (await hasAncestor(entries, sources[rightIndex], sources[leftIndex]))
      ) {
        throw new BridgeError(
          "NESTED_TARGETS_UNSUPPORTED",
          `${commandName}은 부모 bin과 그 하위 항목을 같은 묶음에서 처리하지 않습니다.`
        );
      }
    }
  }
}

function rejectRootEntry(entry, root, commandName) {
  if (entry.item === root) {
    throw new BridgeError(
      "ROOT_ITEM_PROTECTED",
      `${commandName}으로 project root를 변경할 수 없습니다.`
    );
  }
}

async function createBin(args) {
  const project = await getActiveProject();
  const parent = await asFolder(project, args.parent_bin, true);
  executeUndoableTransaction(project, "create_bin", (compound) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = parent.createBinAction(args.name, true);
    addAction(compound, action, "create_bin");
  });
  return { created: true, name: args.name, parentBin: String(parent.name || ""), undoable: true };
}

async function moveItemToBin(args) {
  const project = await getActiveProject();
  const item = await requireProjectItem(project, args.item_id);
  const target = await asFolder(project, args.target_bin, false);
  const sourceParent = await Promise.resolve(item.getParentBin());
  if (!sourceParent) {
    throw new BridgeError("PARENT_BIN_UNAVAILABLE", "Parent bin unavailable");
  }
  executeUndoableTransaction(project, "move_item_to_bin", (compound) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = sourceParent.createMoveItemAction(item, target);
    addAction(compound, action, "move_item_to_bin");
  });
  return {
    moved: true,
    item: String(item.name || ""),
    targetBin: String(target.name || ""),
    undoable: true
  };
}

async function moveItemsToBin(args) {
  const project = await getActiveProject();
  const { root, entries } = await exactProjectEntries(project);
  const targetEntry = resolveExactEntry(entries, args.target_bin, "Target bin");
  const target = castFolderEntry(targetEntry, "Target");
  const sources = args.item_ids.map((selector) =>
    resolveExactEntry(entries, selector, "Project item")
  );
  if (new Set(sources.map((entry) => entry.id || entry.item)).size !== sources.length) {
    throw new BridgeError(
      "DUPLICATE_TARGET",
      "서로 다른 selector가 같은 project item을 가리킵니다."
    );
  }
  await rejectNestedSources(entries, sources, "move_items_to_bin");

  const prepared = [];
  for (const entry of sources) {
    rejectRootEntry(entry, root, "move_items_to_bin");
    if (sameEntry(entry, targetEntry)) {
      throw new BridgeError(
        "BIN_CYCLE",
        `Bin을 자기 자신 안으로 이동할 수 없습니다: ${entry.name}`
      );
    }
    if (await hasAncestor(entries, targetEntry, entry)) {
      throw new BridgeError(
        "BIN_CYCLE",
        `Bin을 자신의 하위 bin으로 이동할 수 없습니다: ${entry.name}`
      );
    }
    const parentEntry = await parentEntryOf(entries, entry.item);
    if (!parentEntry) {
      throw new BridgeError(
        "PARENT_BIN_UNAVAILABLE",
        `Parent bin unavailable: ${entry.name}`
      );
    }
    if (sameEntry(parentEntry, targetEntry)) {
      throw new BridgeError(
        "ALREADY_IN_TARGET_BIN",
        `이미 target bin에 있는 항목입니다: ${entry.name}`
      );
    }
    const parent = castFolderEntry(parentEntry, "Source parent");
    if (typeof parent.createMoveItemAction !== "function") {
      throw new BridgeError(
        "ACTION_API_UNAVAILABLE",
        `createMoveItemAction()을 사용할 수 없습니다: ${entry.name}`
      );
    }
    prepared.push({ entry, parentEntry, parent });
  }

  executeUndoableTransaction(project, "move_items_to_bin", (compound) => {
    for (const record of prepared) {
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
      const action = record.parent.createMoveItemAction(record.entry.item, target);
      addAction(compound, action, "move_items_to_bin");
    }
  });

  const items = prepared.map((record) => ({
    itemId: record.entry.id,
    name: record.entry.name,
    previousBin: record.parentEntry.name,
    previousBinId: record.parentEntry.id,
    targetBin: targetEntry.name,
    targetBinId: targetEntry.id
  }));
  return { moved: true, count: items.length, items, undoable: true };
}

async function removeItem(project, item, command) {
  let parent = null;
  try {
    parent = await Promise.resolve(item.getParentBin());
  } catch (_error) {
    parent = null;
  }
  if (!parent) throw new BridgeError("PARENT_BIN_UNAVAILABLE", "Parent bin unavailable");
  executeUndoableTransaction(project, command, (compound) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = parent.createRemoveItemAction(item);
    addAction(compound, action, command);
  });
}

async function deleteBin(args) {
  const project = await getActiveProject();
  const item = await requireProjectItem(project, args.bin_id, "Bin");
  await asFolder(project, args.bin_id, false);
  const name = String(item.name || "");
  await removeItem(project, item, "delete_bin");
  return { deleted: true, name, undoable: true };
}

async function renameBin(args) {
  const project = await getActiveProject();
  const folder = await asFolder(project, args.bin_id, false);
  const previousName = String(folder.name || "");
  executeUndoableTransaction(project, "rename_bin", (compound) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = folder.createRenameBinAction(args.new_name);
    addAction(compound, action, "rename_bin");
  });
  return { renamed: true, previousName, name: args.new_name, undoable: true };
}

async function createSmartBin(args) {
  const project = await getActiveProject();
  const root = await project.getRootItem();
  executeUndoableTransaction(project, "create_smart_bin", (compound) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = root.createSmartBinAction(args.name, args.query);
    addAction(compound, action, "create_smart_bin");
  });
  return { created: true, name: args.name, query: args.query, undoable: true };
}

async function findItemsByMediaPath(args) {
  const project = await getActiveProject();
  const entries = await collectProjectItems(project);
  const target = args.path_search.toLocaleLowerCase();
  const items = [];
  for (const entry of entries) {
    const snapshot = await readProjectItemSnapshot(entry.item, { path: entry.path });
    if (String(snapshot.mediaPath || "").toLocaleLowerCase().includes(target)) {
      items.push(snapshot);
    }
  }
  return { count: items.length, items };
}

async function deleteProjectItem(args) {
  const project = await getActiveProject();
  const item = await requireProjectItem(project, args.item_id);
  const name = String(item.name || "");
  await removeItem(project, item, "delete_project_item");
  return { deleted: true, name, undoable: true };
}

async function deleteMultipleProjectItems(args) {
  const project = await getActiveProject();
  const { root, entries } = await exactProjectEntries(project);
  const sources = args.item_ids.map((selector) =>
    resolveExactEntry(entries, selector, "Project item")
  );
  if (new Set(sources.map((entry) => entry.id || entry.item)).size !== sources.length) {
    throw new BridgeError(
      "DUPLICATE_TARGET",
      "서로 다른 selector가 같은 project item을 가리킵니다."
    );
  }
  await rejectNestedSources(entries, sources, "delete_multiple_project_items");

  const prepared = [];
  for (const entry of sources) {
    rejectRootEntry(entry, root, "delete_multiple_project_items");
    const parentEntry = await parentEntryOf(entries, entry.item);
    if (!parentEntry) {
      throw new BridgeError(
        "PARENT_BIN_UNAVAILABLE",
        `Parent bin unavailable: ${entry.name}`
      );
    }
    const parent = castFolderEntry(parentEntry, "Source parent");
    if (typeof parent.createRemoveItemAction !== "function") {
      throw new BridgeError(
        "ACTION_API_UNAVAILABLE",
        `createRemoveItemAction()을 사용할 수 없습니다: ${entry.name}`
      );
    }
    prepared.push({ entry, parentEntry, parent });
  }

  executeUndoableTransaction(
    project,
    "delete_multiple_project_items",
    (compound) => {
      for (const record of prepared) {
        // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
        const action = record.parent.createRemoveItemAction(record.entry.item);
        addAction(compound, action, "delete_multiple_project_items");
      }
    }
  );

  const items = prepared.map((record) => ({
    itemId: record.entry.id,
    name: record.entry.name,
    previousBin: record.parentEntry.name,
    previousBinId: record.parentEntry.id
  }));
  return { deleted: true, count: items.length, items, undoable: true };
}

async function renameProjectItem(args) {
  const project = await getActiveProject();
  const item = await requireProjectItem(project, args.item_id);
  const previousName = String(item.name || "");
  executeUndoableTransaction(project, "rename_project_item", (compound) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = item.createSetNameAction(args.new_name);
    addAction(compound, action, "rename_project_item");
  });
  return { renamed: true, previousName, name: args.new_name, undoable: true };
}

async function createSubclip(args) {
  const project = await getActiveProject();
  const item = await requireClipProjectItem(project, args.item_id);
  executeUndoableTransaction(project, "create_subclip", (compound) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = item.createSubClipAction(
      args.name,
      tickTimeFromSeconds(args.in_seconds),
      tickTimeFromSeconds(args.out_seconds),
      args.hard_boundaries,
      { takeVideo: args.take_video, takeAudio: args.take_audio }
    );
    addAction(compound, action, "create_subclip");
  });
  return {
    created: true,
    name: args.name,
    inSeconds: args.in_seconds,
    outSeconds: args.out_seconds,
    hardBoundaries: args.hard_boundaries,
    takeVideo: args.take_video,
    takeAudio: args.take_audio,
    undoable: true
  };
}

module.exports = {
  category: "project-items",
  handlers: [
    { name: "create_bin", writes: true, validate: validateCreateBin, execute: createBin },
    { name: "move_item_to_bin", writes: true, validate: validateMove, execute: moveItemToBin },
    { name: "move_items_to_bin", writes: true, validate: validateMoveItems, execute: moveItemsToBin },
    { name: "delete_bin", writes: true, dangerous: true, validate: validateBin, execute: deleteBin },
    { name: "rename_bin", writes: true, validate: validateRenameBin, execute: renameBin },
    { name: "create_smart_bin", writes: true, validate: validateSmartBin, execute: createSmartBin },
    { name: "find_items_by_media_path", writes: false, validate: validateFindPath, execute: findItemsByMediaPath },
    { name: "delete_project_item", writes: true, dangerous: true, validate: validateItem, execute: deleteProjectItem },
    { name: "delete_multiple_project_items", writes: true, dangerous: true, validate: validateDeleteItems, execute: deleteMultipleProjectItems },
    { name: "rename_project_item", writes: true, validate: validateRenameItem, execute: renameProjectItem },
    { name: "create_subclip", writes: true, validate: validateSubclip, execute: createSubclip }
  ]
};
