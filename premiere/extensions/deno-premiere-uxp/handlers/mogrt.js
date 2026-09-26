const {
  addAction,
  collectTrackItems,
  executeUndoableTransaction,
  findSequence,
  getActiveProject,
  numberArg,
  ppro,
  projectItemId,
  secondsOf,
  rejectUnknown,
  stringArg,
  tickTimeFromSeconds,
  validateNoArgs
} = require("./shared.js");

async function trackItemFingerprint(item) {
  let sourceId = "";
  try {
    sourceId = await projectItemId(await item.getProjectItem());
  } catch (_error) {
    // A generated graphics item may not expose a source ProjectItem.
  }
  const start = await item.getStartTime();
  return [
    String((await item.getName()) || ""),
    String((start && start.ticks) || ""),
    sourceId
  ].join("\u0000");
}

function validateImportMogrt(args) {
  rejectUnknown(args, [
    "mogrt_path",
    "track_index",
    "start_seconds",
    "duration_seconds"
  ]);
  return {
    mogrt_path: stringArg(args.mogrt_path, "mogrt_path"),
    track_index: numberArg(args.track_index, "track_index", {
      optional: true,
      fallback: 0,
      integer: true,
      min: 0
    }),
    start_seconds: numberArg(args.start_seconds, "start_seconds", {
      optional: true,
      fallback: 0,
      min: 0
    }),
    duration_seconds: numberArg(args.duration_seconds, "duration_seconds", {
      optional: true,
      fallback: 5,
      min: 0.001
    })
  };
}

function validateImportMogrtFromLibrary(args) {
  rejectUnknown(args, [
    "library_name",
    "element_name",
    "track_index",
    "start_seconds",
    "duration_seconds"
  ]);
  return {
    library_name: stringArg(args.library_name, "library_name"),
    element_name: stringArg(args.element_name, "element_name"),
    track_index: numberArg(args.track_index, "track_index", {
      optional: true,
      fallback: 0,
      integer: true,
      min: 0
    }),
    start_seconds: numberArg(args.start_seconds, "start_seconds", {
      optional: true,
      fallback: 0,
      min: 0
    }),
    duration_seconds: numberArg(args.duration_seconds, "duration_seconds", {
      optional: true,
      fallback: 5,
      min: 0.001
    })
  };
}

async function finalizeMogrtImport(project, sequence, args, inserted, transactionName) {

  if (inserted.length > 0) {
    const endUpdates = [];
    for (const item of inserted) {
      const start = await item.getStartTime();
      endUpdates.push({
        item,
        endTime: tickTimeFromSeconds(
          secondsOf(start) + args.duration_seconds
        )
      });
    }
    executeUndoableTransaction(project, transactionName, (compound) => {
      for (const update of endUpdates) {
        addAction(
          compound,
          // executeUndoableTransaction invokes this callback synchronously
          // inside Project.lockedAccess() and Project.executeTransaction().
          // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- custom transaction wrapper preserves Adobe's lock scope
          update.item.createSetEndAction(update.endTime),
          transactionName
        );
      }
    });
  }

  const readback = await collectTrackItems(sequence, { trackType: "both" });
  const claimed = new Set();
  const items = [];
  for (let index = 0; index < inserted.length; index += 1) {
    const item = inserted[index];
    let match = readback.find(
      (entry, readbackIndex) => !claimed.has(readbackIndex) && entry.item === item
    );
    if (!match) {
      const fingerprint = await trackItemFingerprint(item);
      const candidates = [];
      for (let readbackIndex = 0; readbackIndex < readback.length; readbackIndex += 1) {
        if (claimed.has(readbackIndex)) continue;
        if ((await trackItemFingerprint(readback[readbackIndex].item)) === fingerprint) {
          candidates.push({ entry: readback[readbackIndex], readbackIndex });
        }
      }
      if (candidates.length === 1) {
        match = candidates[0].entry;
        claimed.add(candidates[0].readbackIndex);
      }
    } else {
      claimed.add(readback.indexOf(match));
    }
    items.push({
      nodeId: match ? match.nodeId : null,
      name: String((await item.getName()) || ""),
      trackType: match ? match.trackType : "unknown",
      trackIndex: match ? match.trackIndex : null,
      clipIndex: match ? match.clipIndex : null
    });
  }
  return {
    imported: inserted.length > 0,
    itemCount: inserted.length,
    items,
    trackIndex: args.track_index,
    startSeconds: args.start_seconds,
    durationAdjusted: inserted.length > 0,
    undoable: false,
    nonAtomic: true,
    unresolvedReadbackCount: items.filter((item) => !item.nodeId).length
  };
}

async function importMogrt(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const editor = ppro().SequenceEditor.getEditor(sequence);
  const inserted = Array.from(
    editor.insertMogrtFromPath(
      args.mogrt_path,
      tickTimeFromSeconds(args.start_seconds),
      args.track_index,
      0
    ) || []
  );
  return finalizeMogrtImport(
    project,
    sequence,
    args,
    inserted,
    "import_mogrt"
  );
}

async function importMogrtFromLibrary(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const editor = ppro().SequenceEditor.getEditor(sequence);
  const inserted = Array.from(
    editor.insertMogrtFromLibrary(
      args.library_name,
      args.element_name,
      tickTimeFromSeconds(args.start_seconds),
      args.track_index,
      0
    ) || []
  );
  return finalizeMogrtImport(
    project,
    sequence,
    args,
    inserted,
    "import_mogrt_from_library"
  );
}

async function getInstalledMogrtPath() {
  const installedMogrtPath = await ppro().SequenceEditor.getInstalledMogrtPath();
  return { installedMogrtPath: String(installedMogrtPath || "") };
}

module.exports = {
  category: "mogrt",
  handlers: [
    {
      name: "import_mogrt",
      writes: true,
      validate: validateImportMogrt,
      execute: importMogrt
    },
    {
      name: "import_mogrt_from_library",
      writes: true,
      validate: validateImportMogrtFromLibrary,
      execute: importMogrtFromLibrary
    },
    {
      name: "get_installed_mogrt_path",
      writes: false,
      validate: validateNoArgs,
      execute: getInstalledMogrtPath
    }
  ]
};
