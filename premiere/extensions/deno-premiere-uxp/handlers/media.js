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
  tickTimeFromSeconds
} = require("./shared.js");
const { readProjectItemSnapshot } = require("./inspection-helpers.js");

function validateItem(args) {
  rejectUnknown(args, ["item_id"]);
  return { item_id: stringArg(args.item_id, "item_id") };
}

function validateRelink(args) {
  rejectUnknown(args, ["item_id", "new_path"]);
  return {
    item_id: stringArg(args.item_id, "item_id"),
    new_path: stringArg(args.new_path, "new_path")
  };
}

function validateFrameRate(args) {
  rejectUnknown(args, ["item_id", "frame_rate"]);
  return {
    item_id: stringArg(args.item_id, "item_id"),
    frame_rate: numberArg(args.frame_rate, "frame_rate", { min: 0.001 })
  };
}

function validatePixelAspect(args) {
  rejectUnknown(args, ["item_id", "numerator", "denominator"]);
  return {
    item_id: stringArg(args.item_id, "item_id"),
    numerator: numberArg(args.numerator, "numerator", { integer: true, min: 1 }),
    denominator: numberArg(args.denominator, "denominator", {
      integer: true,
      min: 1
    })
  };
}

function validateStart(args) {
  rejectUnknown(args, ["item_id", "start_seconds"]);
  return {
    item_id: stringArg(args.item_id, "item_id"),
    start_seconds: numberArg(args.start_seconds, "start_seconds", { min: 0 })
  };
}

function validateImageSequence(args) {
  rejectUnknown(args, ["first_file_path", "target_bin"]);
  return {
    first_file_path: stringArg(args.first_file_path, "first_file_path"),
    target_bin: stringArg(args.target_bin, "target_bin", {
      optional: true,
      fallback: undefined
    })
  };
}

function validateClearInOut(args) {
  rejectUnknown(args, ["item_id", "clear_in", "clear_out"]);
  const clearIn = booleanArg(args.clear_in, "clear_in", {
    optional: true,
    fallback: true
  });
  const clearOut = booleanArg(args.clear_out, "clear_out", {
    optional: true,
    fallback: true
  });
  if (!clearIn && !clearOut) {
    throw new BridgeError("INVALID_ARGUMENTS", "clear_in 또는 clear_out 중 하나는 true여야 합니다.");
  }
  if (clearIn !== clearOut) {
    throw new BridgeError(
      "PARTIAL_CLEAR_UNAVAILABLE",
      "UXP 26.3 공식 API는 project item in/out을 둘 다 함께 지우는 동작만 제공합니다."
    );
  }
  return { item_id: stringArg(args.item_id, "item_id"), clear_in: true, clear_out: true };
}

function validateSetInOut(args) {
  rejectUnknown(args, ["item_id", "in_seconds", "out_seconds", "media_type"]);
  const inSeconds =
    args.in_seconds === undefined
      ? undefined
      : numberArg(args.in_seconds, "in_seconds", { min: 0 });
  const outSeconds =
    args.out_seconds === undefined
      ? undefined
      : numberArg(args.out_seconds, "out_seconds", { min: 0 });
  if (inSeconds === undefined && outSeconds === undefined) {
    throw new BridgeError("INVALID_ARGUMENTS", "in_seconds 또는 out_seconds가 필요합니다.");
  }
  if (inSeconds !== undefined && outSeconds !== undefined && outSeconds <= inSeconds) {
    throw new BridgeError("INVALID_ARGUMENTS", "out_seconds는 in_seconds보다 커야 합니다.");
  }
  const mediaType = args.media_type === undefined ? 4 : args.media_type;
  if (mediaType !== 4) {
    throw new BridgeError(
      "UNSUPPORTED_MEDIA_TYPE_SCOPE",
      "UXP 26.3 project-item in/out Action은 video/audio 개별 범위를 지원하지 않습니다. media_type은 생략하거나 4(all)를 사용해야 합니다."
    );
  }
  return {
    item_id: stringArg(args.item_id, "item_id"),
    in_seconds: inSeconds,
    out_seconds: outSeconds,
    media_type: mediaType
  };
}

function validateManageProxies(args) {
  rejectUnknown(args, ["item_id", "action", "proxy_path"]);
  const action = stringArg(args.action, "action");
  if (action !== "attach") {
    throw new BridgeError(
      "UNSUPPORTED_PROXY_ACTION",
      "공식 UXP 경로에서는 manage_proxies action=attach만 지원합니다."
    );
  }
  return {
    item_id: stringArg(args.item_id, "item_id"),
    action,
    proxy_path: stringArg(args.proxy_path, "proxy_path")
  };
}

function validateLutId(args) {
  rejectUnknown(args, ["item_id", "input_lut_id"]);
  const inputLutId = stringArg(args.input_lut_id, "input_lut_id", {
    allowEmpty: true
  });
  if (inputLutId.length > 1024 || inputLutId.includes("\0")) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "input_lut_id는 NUL이 없는 1024자 이하 문자열이어야 합니다. 빈 문자열은 LUT 해제 요청으로 허용합니다."
    );
  }
  return {
    item_id: stringArg(args.item_id, "item_id"),
    input_lut_id: inputLutId
  };
}

function normalizedLutId(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^\{([^}]+)\}$/, "$1")
    .toLocaleLowerCase();
  return normalized === "00000000-0000-0000-0000-000000000000"
    ? ""
    : normalized;
}

async function relinkMedia(args) {
  const project = await getActiveProject();
  const item = await requireClipProjectItem(project, args.item_id);
  if (!(await item.canChangeMediaPath())) {
    throw new BridgeError("MEDIA_PATH_LOCKED", "This project item cannot change media path");
  }
  const changed = await item.changeMediaFilePath(args.new_path, false);
  if (!changed) throw new BridgeError("RELINK_FAILED", "Failed to relink media");
  return { relinked: true, path: args.new_path, undoable: false };
}

async function refreshMedia(args) {
  const project = await getActiveProject();
  const item = await requireClipProjectItem(project, args.item_id);
  const refreshed = await item.refreshMedia();
  if (!refreshed) throw new BridgeError("REFRESH_FAILED", "Failed to refresh media");
  return { refreshed: true, undoable: false };
}

async function setOffline(args) {
  const project = await getActiveProject();
  const item = await requireClipProjectItem(project, args.item_id);
  executeUndoableTransaction(project, "set_offline", (compound) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = item.createSetOfflineAction();
    addAction(compound, action, "set_offline");
  });
  return { offline: true, undoable: true };
}

async function hasProxy(args) {
  const project = await getActiveProject();
  const item = await requireClipProjectItem(project, args.item_id);
  const attached = Boolean(await item.hasProxy());
  return {
    hasProxy: attached,
    proxyPath: attached ? String((await item.getProxyPath()) || "") : "",
    canProxy: Boolean(await item.canProxy())
  };
}

async function manageProxies(args) {
  const project = await getActiveProject();
  const item = await requireClipProjectItem(project, args.item_id);
  if (typeof item.canProxy !== "function" || typeof item.attachProxy !== "function") {
    throw new BridgeError(
      "PROXY_API_UNAVAILABLE",
      "ClipProjectItem proxy API를 사용할 수 없습니다."
    );
  }
  if (!(await item.canProxy())) {
    throw new BridgeError(
      "PROXY_NOT_ALLOWED",
      "이 project item에는 공식 UXP API로 proxy를 연결할 수 없습니다."
    );
  }

  const attached = await item.attachProxy(args.proxy_path, false, false);
  if (!attached) {
    throw new BridgeError("PROXY_ATTACH_FAILED", "Premiere가 proxy 연결을 거부했습니다.");
  }
  const hasAttachedProxy = Boolean(await item.hasProxy());
  const proxyPath = hasAttachedProxy
    ? String((await item.getProxyPath()) || "")
    : "";
  if (!hasAttachedProxy || !proxyPath) {
    throw new BridgeError(
      "PROXY_READBACK_FAILED",
      "Proxy 연결 호출은 성공했지만 hasProxy/getProxyPath read-back이 일치하지 않습니다."
    );
  }
  const requestedPath = normalizeWindowsPath(args.proxy_path);
  const resolvedPath = normalizeWindowsPath(proxyPath);
  return {
    attached: true,
    count: 1,
    items: [
      {
        itemId: args.item_id,
        name: String(item.name || ""),
        requestedPath,
        proxyPath: resolvedPath,
        pathMatches:
          requestedPath.toLocaleLowerCase() === resolvedPath.toLocaleLowerCase()
      }
    ],
    undoable: false
  };
}

async function getProjectItemLutInfo(args) {
  const project = await getActiveProject();
  const item = await requireClipProjectItem(project, args.item_id);
  if (
    typeof item.getInputLUTID !== "function" ||
    typeof item.getEmbeddedLUTID !== "function"
  ) {
    throw new BridgeError(
      "LUT_API_UNAVAILABLE",
      "ClipProjectItem LUT API를 사용할 수 없습니다."
    );
  }
  const [inputLutId, embeddedLutId] = await Promise.all([
    item.getInputLUTID(),
    item.getEmbeddedLUTID()
  ]);
  return {
    itemId: (await projectItemId(item)) || args.item_id,
    name: String(item.name || ""),
    inputLutId: String(inputLutId || ""),
    embeddedLutId: String(embeddedLutId || ""),
    hasInputLut: normalizedLutId(inputLutId).length > 0,
    hasEmbeddedLut: normalizedLutId(embeddedLutId).length > 0
  };
}

async function setProjectItemInputLutId(args) {
  const project = await getActiveProject();
  const item = await requireClipProjectItem(project, args.item_id);
  if (
    typeof item.getInputLUTID !== "function" ||
    typeof item.createSetInputLUTIDAction !== "function"
  ) {
    throw new BridgeError(
      "LUT_API_UNAVAILABLE",
      "ClipProjectItem input LUT API를 사용할 수 없습니다."
    );
  }
  const previousInputLutId = String((await item.getInputLUTID()) || "");
  executeUndoableTransaction(
    project,
    "set_project_item_input_lut_id",
    (compound) => {
      addAction(
        compound,
        // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
        item.createSetInputLUTIDAction(args.input_lut_id),
        "set_project_item_input_lut_id"
      );
    }
  );
  const inputLutId = String((await item.getInputLUTID()) || "");
  if (normalizedLutId(inputLutId) !== normalizedLutId(args.input_lut_id)) {
    throw new BridgeError(
      "LUT_READBACK_MISMATCH",
      "Input LUT ID read-back이 요청값과 일치하지 않습니다.",
      {
        requestedInputLutId: args.input_lut_id,
        actualInputLutId: inputLutId,
        previousInputLutId
      }
    );
  }
  return {
    updated: true,
    itemId: (await projectItemId(item)) || args.item_id,
    name: String(item.name || ""),
    previousInputLutId,
    inputLutId,
    cleared: normalizedLutId(inputLutId).length === 0,
    undoable: true
  };
}

async function applyItemAction(args, command, methodName, actionArgs) {
  const project = await getActiveProject();
  const item = await requireClipProjectItem(project, args.item_id);
  if (typeof item[methodName] !== "function") {
    throw new BridgeError(
      "ACTION_API_UNAVAILABLE",
      `${methodName}()을 사용할 수 없습니다.`
    );
  }
  executeUndoableTransaction(project, command, (compound) => {
    const action = item[methodName](...(actionArgs || []));
    addAction(compound, action, command);
  });
  return { updated: true, undoable: true };
}

async function setOverrideFrameRate(args) {
  return applyItemAction(
    args,
    "set_override_frame_rate",
    "createSetOverrideFrameRateAction",
    [args.frame_rate]
  );
}

async function setOverridePixelAspectRatio(args) {
  return applyItemAction(
    args,
    "set_override_pixel_aspect_ratio",
    "createSetOverridePixelAspectRatioAction",
    [args.numerator, args.denominator]
  );
}

async function setScaleToFrameSize(args) {
  return applyItemAction(
    args,
    "set_scale_to_frame_size",
    "createSetScaleToFrameSizeAction"
  );
}

async function getItemInfo(args) {
  const project = await getActiveProject();
  const item = await requireProjectItem(project, args.item_id);
  return readProjectItemSnapshot(item);
}

async function setStartTime(args, command) {
  const project = await getActiveProject();
  const item = await requireClipProjectItem(project, args.item_id);
  const media = await item.getMedia();
  if (!media) throw new BridgeError("MEDIA_UNAVAILABLE", "Media object unavailable");
  executeUndoableTransaction(project, command, (compound) => {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
    const action = media.createSetStartAction(
      tickTimeFromSeconds(args.start_seconds)
    );
    addAction(compound, action, command);
  });
  return { updated: true, startSeconds: args.start_seconds, undoable: true };
}

async function importImageSequence(args) {
  const project = await getActiveProject();
  let target = await project.getRootItem();
  if (args.target_bin) {
    const selected = await requireProjectItem(project, args.target_bin, "Bin");
    try {
      target = ppro().FolderItem.cast(selected);
    } catch (_error) {
      target = null;
    }
    if (!target) throw new BridgeError("NOT_A_BIN", `Bin required: ${args.target_bin}`);
  }
  const imported = await project.importFiles(
    [args.first_file_path],
    true,
    target,
    true
  );
  if (!imported) throw new BridgeError("IMPORT_FAILED", "Image sequence import failed");
  return {
    imported: true,
    firstFilePath: args.first_file_path,
    targetBin: String(target.name || ""),
    undoable: false
  };
}

async function clearItemInOut(args) {
  return applyItemAction(
    args,
    "clear_item_in_out",
    "createClearInOutPointsAction"
  );
}

async function setItemInOut(args) {
  const project = await getActiveProject();
  const item = await requireClipProjectItem(project, args.item_id);
  executeUndoableTransaction(project, "set_item_in_out", (compound) => {
    let action;
    if (args.in_seconds !== undefined && args.out_seconds !== undefined) {
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
      action = item.createSetInOutPointsAction(
        tickTimeFromSeconds(args.in_seconds),
        tickTimeFromSeconds(args.out_seconds)
      );
    } else if (args.in_seconds !== undefined) {
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
      action = item.createSetInPointAction(tickTimeFromSeconds(args.in_seconds));
    } else {
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
      action = item.createSetOutPointAction(tickTimeFromSeconds(args.out_seconds));
    }
    addAction(compound, action, "set_item_in_out");
  });
  return {
    updated: true,
    inSeconds: args.in_seconds,
    outSeconds: args.out_seconds,
    mediaType: 4,
    scope: "all-media",
    undoable: true
  };
}

module.exports = {
  category: "media",
  handlers: [
    { name: "relink_media", writes: true, dangerous: true, validate: validateRelink, execute: relinkMedia },
    { name: "refresh_media", writes: true, validate: validateItem, execute: refreshMedia },
    { name: "set_offline", writes: true, dangerous: true, validate: validateItem, execute: setOffline },
    { name: "has_proxy", writes: false, validate: validateItem, execute: hasProxy },
    { name: "manage_proxies", writes: true, dangerous: true, validate: validateManageProxies, execute: manageProxies },
    { name: "get_project_item_lut_info", writes: false, validate: validateItem, execute: getProjectItemLutInfo },
    { name: "set_project_item_input_lut_id", writes: true, validate: validateLutId, execute: setProjectItemInputLutId },
    { name: "set_override_frame_rate", writes: true, validate: validateFrameRate, execute: setOverrideFrameRate },
    { name: "set_override_pixel_aspect_ratio", writes: true, validate: validatePixelAspect, execute: setOverridePixelAspectRatio },
    { name: "set_scale_to_frame_size", writes: true, validate: validateItem, execute: setScaleToFrameSize },
    { name: "get_item_info", writes: false, validate: validateItem, execute: getItemInfo },
    { name: "set_start_time", writes: true, validate: validateStart, execute: (args) => setStartTime(args, "set_start_time") },
    { name: "set_clip_start_time", writes: true, validate: validateStart, execute: (args) => setStartTime(args, "set_clip_start_time") },
    { name: "import_image_sequence", writes: true, validate: validateImageSequence, execute: importImageSequence },
    { name: "clear_item_in_out", writes: true, validate: validateClearInOut, execute: clearItemInOut },
    { name: "set_item_in_out", writes: true, validate: validateSetInOut, execute: setItemInOut }
  ]
};
