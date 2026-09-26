const { BridgeError } = require("./errors.js");
const {
  addAction,
  booleanArg,
  collectTrackItems,
  createSetParamValueAction,
  displayNamesMatch,
  executeUndoableTransaction,
  findSequence,
  getActiveProject,
  listComponents,
  listParams,
  numberArg,
  ppro,
  readValue,
  rejectUnknown,
  requireComponent,
  requireParam,
  requireTrackItem,
  serializeComponentValue,
  stringArg,
  validateNoArgs
} = require("./shared.js");

function validateApplyEffectArgs(args) {
  rejectUnknown(args, ["node_id", "effect_name", "insert_index"]);
  return {
    node_id: stringArg(args.node_id, "node_id"),
    effect_name: stringArg(args.effect_name, "effect_name"),
    insert_index: numberArg(args.insert_index, "insert_index", {
      optional: true,
      fallback: undefined,
      integer: true,
      min: 0
    })
  };
}

function validateBatchApplyEffectArgs(args) {
  rejectUnknown(args, [
    "media_type",
    "effect_match_name",
    "target",
    "track_index",
    "insert_index"
  ]);
  const mediaType = stringArg(args.media_type, "media_type");
  if (!['video', 'audio'].includes(mediaType)) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "media_type은 video 또는 audio여야 합니다."
    );
  }
  const target = stringArg(args.target, "target");
  if (!["selected", "track", "all"].includes(target)) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "target은 selected, track, all 중 하나여야 합니다."
    );
  }
  const trackIndex = numberArg(args.track_index, "track_index", {
    optional: true,
    fallback: undefined,
    integer: true,
    min: 0
  });
  if (target === "track" && trackIndex === undefined) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "target=track일 때 track_index가 필요합니다."
    );
  }
  if (target !== "track" && trackIndex !== undefined) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "track_index는 target=track일 때만 사용할 수 있습니다."
    );
  }
  return {
    media_type: mediaType,
    effect_match_name: stringArg(
      args.effect_match_name,
      "effect_match_name"
    ),
    target,
    track_index: trackIndex,
    insert_index: numberArg(args.insert_index, "insert_index", {
      optional: true,
      fallback: undefined,
      integer: true,
      min: 0
    })
  };
}

function validateRemoveEffectArgs(args) {
  rejectUnknown(args, ["node_id", "effect_index", "effect_name"]);
  const effectIndex = numberArg(args.effect_index, "effect_index", {
    optional: true,
    integer: true,
    min: 0
  });
  const effectName = stringArg(args.effect_name, "effect_name", {
    optional: true
  });
  if (effectIndex === undefined && effectName === undefined) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "effect_index 또는 effect_name 중 하나가 필요합니다."
    );
  }
  if (effectIndex !== undefined && effectName !== undefined) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "effect_index와 effect_name은 동시에 지정할 수 없습니다."
    );
  }
  return {
    node_id: stringArg(args.node_id, "node_id"),
    effect_index: effectIndex,
    effect_name: effectName
  };
}

function validateNodeArgs(args) {
  rejectUnknown(args, ["node_id"]);
  return { node_id: stringArg(args.node_id, "node_id") };
}

function validateRemoveByNameArgs(args) {
  rejectUnknown(args, ["node_id", "effect_name"]);
  return {
    node_id: stringArg(args.node_id, "node_id"),
    effect_name: stringArg(args.effect_name, "effect_name")
  };
}

function validateNumberPropertyArgs(args, field, options) {
  rejectUnknown(args, ["node_id", field]);
  return {
    node_id: stringArg(args.node_id, "node_id"),
    [field]: numberArg(args[field], field, options)
  };
}

function validatePointPropertyArgs(args) {
  rejectUnknown(args, ["node_id", "x", "y"]);
  return {
    node_id: stringArg(args.node_id, "node_id"),
    x: numberArg(args.x, "x"),
    y: numberArg(args.y, "y")
  };
}

function validateUniformScaleArgs(args) {
  rejectUnknown(args, ["node_id", "uniform"]);
  return {
    node_id: stringArg(args.node_id, "node_id"),
    uniform: booleanArg(args.uniform, "uniform")
  };
}

function validateScaleWidthHeightArgs(args) {
  rejectUnknown(args, ["node_id", "scale_width", "scale_height"]);
  return {
    node_id: stringArg(args.node_id, "node_id"),
    scale_width: numberArg(args.scale_width, "scale_width", { min: 0 }),
    scale_height: numberArg(args.scale_height, "scale_height", { min: 0 })
  };
}

function validateAntiAliasArgs(args) {
  rejectUnknown(args, ["node_id", "enabled"]);
  return {
    node_id: stringArg(args.node_id, "node_id"),
    enabled: booleanArg(args.enabled, "enabled")
  };
}

function normalized(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

async function requireClip(nodeId) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await requireTrackItem(sequence, nodeId);
  return { project, sequence, match };
}

function requireApi(api, methodName, errorCode) {
  if (!api || typeof api[methodName] !== "function") {
    throw new BridgeError(
      errorCode,
      `Premiere UXP ${methodName} API를 사용할 수 없습니다.`
    );
  }
  return api;
}

async function videoEffectCatalog() {
  const factory = requireApi(
    ppro().VideoFilterFactory,
    "getMatchNames",
    "VIDEO_EFFECT_FACTORY_UNAVAILABLE"
  );
  requireApi(factory, "getDisplayNames", "VIDEO_EFFECT_FACTORY_UNAVAILABLE");
  const [displayNames, matchNames] = await Promise.all([
    factory.getDisplayNames(),
    factory.getMatchNames()
  ]);
  const displays = Array.from(displayNames || []).map(String);
  const matches = Array.from(matchNames || []).map(String);
  return {
    factory,
    displayNames: displays,
    matchNames: matches,
    effects: matches.map((matchName) => ({ matchName }))
  };
}

async function audioEffectCatalog() {
  const factory = requireApi(
    ppro().AudioFilterFactory,
    "getDisplayNames",
    "AUDIO_EFFECT_FACTORY_UNAVAILABLE"
  );
  const displayNames = Array.from((await factory.getDisplayNames()) || []).map(
    String
  );
  return { factory, displayNames };
}

async function removableCatalog(trackType) {
  if (trackType === "video") {
    const catalog = await videoEffectCatalog();
    return {
      kind: "matchName",
      values: new Set(catalog.matchNames.map(normalized))
    };
  }
  const catalog = await audioEffectCatalog();
  return {
    kind: "displayName",
    values: new Set(catalog.displayNames.map(normalized))
  };
}

function isRemovableComponent(component, catalog) {
  const candidate =
    catalog.kind === "matchName" ? component.matchName : component.displayName;
  return catalog.values.has(normalized(candidate));
}

async function describeProperty(entry) {
  const [startValue, keyframesSupported, timeVarying] = await Promise.all([
    readValue(entry.param, "getStartValue"),
    readValue(entry.param, "areKeyframesSupported"),
    readValue(entry.param, "isTimeVarying")
  ]);
  let keyframeCount = 0;
  try {
    keyframeCount = Array.from(entry.param.getKeyframeListAsTickTimes() || [])
      .length;
  } catch (_error) {
    keyframeCount = 0;
  }
  return {
    index: entry.index,
    name: entry.displayName,
    value: serializeComponentValue(startValue),
    keyframesSupported: Boolean(keyframesSupported),
    timeVarying: Boolean(timeVarying),
    keyframeCount
  };
}

async function describeComponent(entry, removable) {
  const params = await listParams(entry.component);
  const properties = [];
  for (const param of params) properties.push(await describeProperty(param));
  return {
    index: entry.index,
    name: entry.displayName,
    displayName: entry.displayName,
    matchName: entry.matchName,
    removable,
    properties
  };
}

async function listAvailableEffects() {
  const catalog = await videoEffectCatalog();
  return {
    effects: catalog.effects,
    count: catalog.effects.length,
    displayNames: catalog.displayNames,
    nameType: "matchName",
    displayNamesPairedByIndex: false
  };
}

async function listClipEffects(args) {
  const { match } = await requireClip(args.node_id);
  const listed = await listComponents(match.item);
  const removable = await removableCatalog(match.trackType);
  const effects = [];
  for (const component of listed.components) {
    effects.push(
      await describeComponent(
        component,
        isRemovableComponent(component, removable)
      )
    );
  }
  return {
    nodeId: args.node_id,
    trackType: match.trackType,
    effects
  };
}

async function resolveVideoEffect(effectName) {
  const catalog = await videoEffectCatalog();
  const matchIndex = catalog.matchNames.findIndex(
    (name) => normalized(name) === normalized(effectName)
  );
  if (matchIndex >= 0) {
    return {
      factory: catalog.factory,
      matchName: catalog.matchNames[matchIndex],
      displayName: null,
      resolvedBy: "matchName"
    };
  }

  throw new BridgeError(
    "EFFECT_NOT_FOUND",
    `UXP video effect에는 list_available_effects가 반환한 정확한 matchName이 필요합니다: ${effectName}`
  );
}

async function resolveAudioEffect(effectName) {
  const catalog = await audioEffectCatalog();
  const displayIndex = catalog.displayNames.findIndex(
    (name) => normalized(name) === normalized(effectName)
  );
  if (displayIndex < 0) {
    throw new BridgeError(
      "EFFECT_NOT_FOUND",
      `UXP audio effect에는 list_available_audio_effects가 반환한 정확한 displayName이 필요합니다: ${effectName}`
    );
  }
  requireApi(
    catalog.factory,
    "createComponentByDisplayName",
    "AUDIO_EFFECT_FACTORY_UNAVAILABLE"
  );
  return {
    factory: catalog.factory,
    displayName: catalog.displayNames[displayIndex],
    resolvedBy: "displayName"
  };
}

function insertionPlan(chain, componentCount, insertIndex, commandName) {
  if (!chain || !Number.isInteger(componentCount) || componentCount < 0) {
    throw new BridgeError(
      "COMPONENT_CHAIN_UNAVAILABLE",
      `${commandName} component chain을 읽을 수 없습니다.`
    );
  }
  if (insertIndex !== undefined && insertIndex > componentCount) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `insert_index는 0..${componentCount} 범위여야 합니다.`
    );
  }
  const methodName =
    insertIndex === undefined
      ? "createAppendComponentAction"
      : "createInsertComponentAction";
  requireApi(chain, methodName, "COMPONENT_ACTION_UNAVAILABLE");
  return {
    methodName,
    insertedIndex: insertIndex === undefined ? componentCount : insertIndex,
    componentCount
  };
}

function createComponentAction(chain, component, plan) {
  if (plan.methodName === "createInsertComponentAction") {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- caller runs synchronously inside executeUndoableTransaction
    return chain.createInsertComponentAction(component, plan.insertedIndex);
  }
  // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- caller runs synchronously inside executeUndoableTransaction
  return chain.createAppendComponentAction(component);
}

async function readAppliedComponent(item, plan, expected, mediaType) {
  const listed = await listComponents(item);
  const component = listed.components.find(
    (entry) => entry.index === plan.insertedIndex
  );
  const expectedCount = plan.componentCount + 1;
  const identifier =
    mediaType === "video" ? component && component.matchName : component && component.displayName;
  if (
    listed.components.length !== expectedCount ||
    !component ||
    normalized(identifier) !== normalized(expected)
  ) {
    throw new BridgeError(
      "EFFECT_READBACK_MISMATCH",
      "Effect 적용 후 component chain read-back이 예상과 다릅니다.",
      {
        mediaType,
        insertedIndex: plan.insertedIndex,
        expectedIdentifier: expected,
        actualIdentifier: identifier || null,
        expectedComponentCount: expectedCount,
        actualComponentCount: listed.components.length
      }
    );
  }
  return {
    index: component.index,
    displayName: component.displayName,
    matchName: component.matchName,
    beforeComponentCount: plan.componentCount,
    afterComponentCount: listed.components.length
  };
}

async function applyEffect(args) {
  const { project, match } = await requireClip(args.node_id);
  if (match.trackType !== "video") {
    throw new BridgeError(
      "VIDEO_CLIP_REQUIRED",
      "apply_effect는 video clip만 지원합니다."
    );
  }
  const resolved = await resolveVideoEffect(args.effect_name);
  requireApi(resolved.factory, "createComponent", "VIDEO_EFFECT_FACTORY_UNAVAILABLE");
  const listedBefore = await listComponents(match.item);
  const plan = insertionPlan(
    listedBefore.chain,
    listedBefore.components.length,
    args.insert_index,
    "apply_effect"
  );
  const component = await resolved.factory.createComponent(resolved.matchName);
  if (!component) {
    throw new BridgeError(
      "EFFECT_CREATE_FAILED",
      `Video effect를 만들 수 없습니다: ${resolved.matchName}`
    );
  }
  executeUndoableTransaction(project, "apply_effect", (compoundAction) => {
    addAction(
      compoundAction,
      createComponentAction(listedBefore.chain, component, plan),
      "apply_effect"
    );
  });
  const readback = await readAppliedComponent(
    match.item,
    plan,
    resolved.matchName,
    "video"
  );
  return {
    applied: true,
    nodeId: args.node_id,
    effectName: resolved.displayName || args.effect_name,
    matchName: resolved.matchName,
    resolvedBy: resolved.resolvedBy,
    insertedIndex: plan.insertedIndex,
    insertionMode: args.insert_index === undefined ? "append" : "insert",
    duplicatePolicy: "allow-new-instance",
    intrinsicComponentPolicy: "preserve-and-count-for-index",
    indexBasis: "full-component-chain-including-intrinsic",
    component: readback,
    undoable: true
  };
}

async function batchEffectTargets(sequence, args) {
  if (args.target === "track") {
    const trackCount =
      args.media_type === "video"
        ? await sequence.getVideoTrackCount()
        : await sequence.getAudioTrackCount();
    if (args.track_index >= trackCount) {
      throw new BridgeError(
        "TRACK_NOT_FOUND",
        `${args.media_type} track을 찾을 수 없습니다: ${args.track_index}`
      );
    }
  }

  let descriptors = await collectTrackItems(sequence, {
    trackType: args.media_type,
    ...(args.target === "track" ? { trackIndex: args.track_index } : {})
  });
  if (args.target === "selected") {
    const selected = [];
    for (const descriptor of descriptors) {
      if (await descriptor.item.getIsSelected()) selected.push(descriptor);
    }
    descriptors = selected;
  }
  descriptors.sort(
    (left, right) =>
      left.trackIndex - right.trackIndex ||
      left.clipIndex - right.clipIndex ||
      left.nodeId.localeCompare(right.nodeId)
  );
  if (descriptors.length < 1 || descriptors.length > 20) {
    throw new BridgeError(
      "INVALID_TARGET_COUNT",
      `batch_apply_effect 대상은 1..20개여야 합니다. 현재: ${descriptors.length}`
    );
  }
  return descriptors;
}

async function batchApplyEffect(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const descriptors = await batchEffectTargets(sequence, args);
  const resolved =
    args.media_type === "video"
      ? await resolveVideoEffect(args.effect_match_name)
      : await resolveAudioEffect(args.effect_match_name);
  if (args.media_type === "video") {
    requireApi(
      resolved.factory,
      "createComponent",
      "VIDEO_EFFECT_FACTORY_UNAVAILABLE"
    );
  }

  // Resolve every target, chain, insertion bound, and detached component before
  // opening the one transaction. A later target failure therefore cannot leave
  // an earlier target partially applied.
  const prepared = [];
  for (const descriptor of descriptors) {
    const listed = await listComponents(descriptor.item);
    const plan = insertionPlan(
      listed.chain,
      listed.components.length,
      args.insert_index,
      "batch_apply_effect"
    );
    const component =
      args.media_type === "video"
        ? await resolved.factory.createComponent(resolved.matchName)
        : await resolved.factory.createComponentByDisplayName(
            resolved.displayName,
            descriptor.item
          );
    if (!component) {
      throw new BridgeError(
        "EFFECT_CREATE_FAILED",
        `Effect를 만들 수 없습니다: ${args.effect_match_name}`,
        { nodeId: descriptor.nodeId }
      );
    }
    prepared.push({
      descriptor,
      chain: listed.chain,
      plan,
      component,
      clipName: String((await descriptor.item.getName()) || "")
    });
  }

  executeUndoableTransaction(project, "batch_apply_effect", (compoundAction) => {
    for (const entry of prepared) {
      addAction(
        compoundAction,
        createComponentAction(entry.chain, entry.component, entry.plan),
        "batch_apply_effect"
      );
    }
  });

  const expectedIdentifier =
    args.media_type === "video" ? resolved.matchName : resolved.displayName;
  const items = [];
  for (const entry of prepared) {
    const component = await readAppliedComponent(
      entry.descriptor.item,
      entry.plan,
      expectedIdentifier,
      args.media_type
    );
    items.push({
      nodeId: entry.descriptor.nodeId,
      name: entry.clipName,
      mediaType: entry.descriptor.trackType,
      trackIndex: entry.descriptor.trackIndex,
      clipIndex: entry.descriptor.clipIndex,
      component
    });
  }

  return {
    applied: true,
    target: args.target,
    mediaType: args.media_type,
    effectIdentifier: expectedIdentifier,
    identifierType: args.media_type === "video" ? "matchName" : "displayName",
    count: items.length,
    insertionMode: args.insert_index === undefined ? "append" : "insert",
    insertIndex: args.insert_index,
    duplicatePolicy: "allow-new-instance",
    intrinsicComponentPolicy: "preserve-and-count-for-index",
    indexBasis: "full-component-chain-including-intrinsic",
    atomic: true,
    undoable: true,
    items
  };
}

async function removeComponents(project, chain, components, commandName) {
  if (components.length === 0) return 0;
  executeUndoableTransaction(project, commandName, (compoundAction) => {
    for (const component of components) {
      addAction(
        compoundAction,
        // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
        chain.createRemoveComponentAction(component.component),
        commandName
      );
    }
  });
  return components.length;
}

async function removeEffect(args) {
  const { project, match } = await requireClip(args.node_id);
  const listed = await listComponents(match.item);
  const removable = await removableCatalog(match.trackType);
  let selected = null;
  if (args.effect_index !== undefined) {
    selected = listed.components.find(
      (component) => component.index === args.effect_index
    );
  } else {
    selected = listed.components.find(
      (component) =>
        displayNamesMatch(component.displayName, args.effect_name) ||
        displayNamesMatch(component.matchName, args.effect_name)
    );
  }
  if (!selected) {
    throw new BridgeError("EFFECT_NOT_FOUND", "삭제할 effect를 찾을 수 없습니다.");
  }
  if (!isRemovableComponent(selected, removable)) {
    throw new BridgeError(
      "INTRINSIC_EFFECT_PROTECTED",
      `Intrinsic component는 제거하지 않습니다: ${selected.displayName}`
    );
  }
  await removeComponents(project, listed.chain, [selected], "remove_effect");
  return {
    removed: true,
    index: selected.index,
    effectName: selected.displayName,
    matchName: selected.matchName
  };
}

async function removeEffectByName(args) {
  const { project, match } = await requireClip(args.node_id);
  const listed = await listComponents(match.item);
  const removable = await removableCatalog(match.trackType);
  const selected = listed.components.filter(
    (component) =>
      isRemovableComponent(component, removable) &&
      (displayNamesMatch(component.displayName, args.effect_name) ||
        displayNamesMatch(component.matchName, args.effect_name))
  );
  const removedCount = await removeComponents(
    project,
    listed.chain,
    selected,
    "remove_effect_by_name"
  );
  return { removed: removedCount > 0, removedCount };
}

async function removeAllEffects(args) {
  const { project, match } = await requireClip(args.node_id);
  const listed = await listComponents(match.item);
  const removable = await removableCatalog(match.trackType);
  const selected = listed.components.filter((component) =>
    isRemovableComponent(component, removable)
  );
  const removedCount = await removeComponents(
    project,
    listed.chain,
    selected,
    "remove_all_effects"
  );
  return {
    removed: removedCount > 0,
    removedCount,
    intrinsicComponentsPreserved: listed.components.length - removedCount
  };
}

async function requireFirstParam(component, selectors) {
  let lastError = null;
  for (const selector of selectors) {
    try {
      return await requireParam(component, selector);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function setMotionParam(args, commandName, selectors, value, kind) {
  const { project, match } = await requireClip(args.node_id);
  if (match.trackType !== "video") {
    throw new BridgeError(
      "VIDEO_CLIP_REQUIRED",
      `${commandName}는 video clip만 지원합니다.`
    );
  }
  const motion = await requireComponent(match.item, "Motion");
  const property = await requireFirstParam(motion.component, selectors);
  executeUndoableTransaction(project, commandName, (compoundAction) => {
    addAction(
      compoundAction,
      createSetParamValueAction(property.param, value, kind),
      commandName
    );
  });
  return {
    updated: true,
    nodeId: args.node_id,
    effectName: motion.displayName,
    propertyName: property.displayName,
    value
  };
}

async function setClipOpacity(args) {
  const { project, match } = await requireClip(args.node_id);
  if (match.trackType !== "video") {
    throw new BridgeError("VIDEO_CLIP_REQUIRED", "video clip이 필요합니다.");
  }
  const opacity = await requireComponent(match.item, "Opacity");
  const property = await requireFirstParam(opacity.component, ["Opacity"]);
  executeUndoableTransaction(project, "set_clip_opacity", (compoundAction) => {
    addAction(
      compoundAction,
      createSetParamValueAction(property.param, args.opacity),
      "set_clip_opacity"
    );
  });
  return { updated: true, nodeId: args.node_id, opacity: args.opacity };
}

async function setClipScale(args) {
  return setMotionParam(args, "set_clip_scale", ["Scale"], args.scale);
}

async function setClipPosition(args) {
  return setMotionParam(
    args,
    "set_clip_position",
    ["Position"],
    { x: args.x, y: args.y },
    "point"
  );
}

async function setClipRotation(args) {
  return setMotionParam(
    args,
    "set_clip_rotation",
    ["Rotation"],
    args.degrees
  );
}

async function setClipAnchorPoint(args) {
  return setMotionParam(
    args,
    "set_clip_anchor_point",
    ["Anchor Point", "Anchor"],
    { x: args.x, y: args.y },
    "point"
  );
}

async function setUniformScale(args) {
  return setMotionParam(
    args,
    "set_uniform_scale",
    ["Uniform Scale"],
    args.uniform
  );
}

async function setScaleWidthHeight(args) {
  const { project, match } = await requireClip(args.node_id);
  if (match.trackType !== "video") {
    throw new BridgeError("VIDEO_CLIP_REQUIRED", "video clip이 필요합니다.");
  }
  const motion = await requireComponent(match.item, "Motion");
  const width = await requireFirstParam(motion.component, ["Scale Width"]);
  const height = await requireFirstParam(motion.component, ["Scale Height"]);
  executeUndoableTransaction(
    project,
    "set_scale_width_height",
    (compoundAction) => {
      addAction(
        compoundAction,
        createSetParamValueAction(width.param, args.scale_width),
        "set_scale_width_height"
      );
      addAction(
        compoundAction,
        createSetParamValueAction(height.param, args.scale_height),
        "set_scale_width_height"
      );
    }
  );
  return {
    updated: true,
    nodeId: args.node_id,
    scaleWidth: args.scale_width,
    scaleHeight: args.scale_height
  };
}

async function setAntiAliasQuality(args) {
  return setMotionParam(
    args,
    "set_anti_alias_quality",
    ["Anti-Alias"],
    args.enabled ? 1 : 0
  );
}

module.exports = {
  category: "effects",
  handlers: [
    {
      name: "list_available_effects",
      writes: false,
      validate: validateNoArgs,
      execute: listAvailableEffects
    },
    {
      name: "list_clip_effects",
      writes: false,
      validate: validateNodeArgs,
      execute: listClipEffects
    },
    {
      name: "apply_effect",
      writes: true,
      validate: validateApplyEffectArgs,
      execute: applyEffect
    },
    {
      name: "batch_apply_effect",
      writes: true,
      validate: validateBatchApplyEffectArgs,
      execute: batchApplyEffect
    },
    {
      name: "remove_effect",
      writes: true,
      dangerous: true,
      validate: validateRemoveEffectArgs,
      execute: removeEffect
    },
    {
      name: "remove_effect_by_name",
      writes: true,
      dangerous: true,
      validate: validateRemoveByNameArgs,
      execute: removeEffectByName
    },
    {
      name: "remove_all_effects",
      writes: true,
      dangerous: true,
      validate: validateNodeArgs,
      execute: removeAllEffects
    },
    {
      name: "set_clip_opacity",
      writes: true,
      validate(args) {
        return validateNumberPropertyArgs(args, "opacity", { min: 0, max: 100 });
      },
      execute: setClipOpacity
    },
    {
      name: "set_clip_scale",
      writes: true,
      validate(args) {
        return validateNumberPropertyArgs(args, "scale", { min: 0 });
      },
      execute: setClipScale
    },
    {
      name: "set_clip_position",
      writes: true,
      validate: validatePointPropertyArgs,
      execute: setClipPosition
    },
    {
      name: "set_clip_rotation",
      writes: true,
      validate(args) {
        return validateNumberPropertyArgs(args, "degrees");
      },
      execute: setClipRotation
    },
    {
      name: "set_clip_anchor_point",
      writes: true,
      validate: validatePointPropertyArgs,
      execute: setClipAnchorPoint
    },
    {
      name: "set_uniform_scale",
      writes: true,
      validate: validateUniformScaleArgs,
      execute: setUniformScale
    },
    {
      name: "set_scale_width_height",
      writes: true,
      validate: validateScaleWidthHeightArgs,
      execute: setScaleWidthHeight
    },
    {
      name: "set_anti_alias_quality",
      writes: true,
      validate: validateAntiAliasArgs,
      execute: setAntiAliasQuality
    }
  ]
};
