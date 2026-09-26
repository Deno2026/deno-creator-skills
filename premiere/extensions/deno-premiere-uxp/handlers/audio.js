const { BridgeError } = require("./errors.js");
const {
  addAction,
  arrayArg,
  booleanArg,
  createSetParamValueAction,
  displayNamesMatch,
  executeUndoableTransaction,
  findSequence,
  getActiveProject,
  listComponents,
  listParams,
  numberArg,
  ppro,
  rejectUnknown,
  requireTrackItem,
  stringArg,
  tickTimeFromSeconds,
  validateNoArgs
} = require("./shared.js");

function validateApplyAudioEffectArgs(args) {
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

function validateAudioLevelArgs(args, field) {
  rejectUnknown(args, ["node_id", field]);
  return {
    node_id: stringArg(args.node_id, "node_id"),
    [field]: numberArg(args[field], field)
  };
}

function validatePanArgs(args) {
  rejectUnknown(args, ["node_id", "pan"]);
  return {
    node_id: stringArg(args.node_id, "node_id"),
    pan: numberArg(args.pan, "pan", { min: -100, max: 100 })
  };
}

function validateAudioKeyframesArgs(args) {
  rejectUnknown(args, ["node_id", "keyframes"]);
  const keyframes = arrayArg(args.keyframes, "keyframes", { nonEmpty: true }).map(
    (entry, index) => {
      rejectUnknown(entry, ["time_seconds", "level_db"]);
      return {
        time_seconds: numberArg(
          entry.time_seconds,
          `keyframes[${index}].time_seconds`,
          { min: 0 }
        ),
        level_db: numberArg(
          entry.level_db,
          `keyframes[${index}].level_db`
        )
      };
    }
  );
  return {
    node_id: stringArg(args.node_id, "node_id"),
    keyframes
  };
}

function validateMuteTrackArgs(args) {
  rejectUnknown(args, ["track_index", "muted"]);
  return {
    track_index: numberArg(args.track_index, "track_index", {
      integer: true,
      min: 0
    }),
    muted: booleanArg(args.muted, "muted")
  };
}

async function requireAudioClip(nodeId) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await requireTrackItem(sequence, nodeId);
  if (match.trackType !== "audio") {
    throw new BridgeError(
      "AUDIO_CLIP_REQUIRED",
      "공식 UXP audio component API에는 audio track item node_id가 필요합니다."
    );
  }
  return { project, sequence, match };
}

function requireAudioFactory(methodName) {
  const factory = ppro().AudioFilterFactory;
  if (!factory || typeof factory[methodName] !== "function") {
    throw new BridgeError(
      "AUDIO_EFFECT_FACTORY_UNAVAILABLE",
      `Premiere UXP AudioFilterFactory.${methodName} API를 사용할 수 없습니다.`
    );
  }
  return factory;
}

async function listAvailableAudioEffects() {
  const factory = requireAudioFactory("getDisplayNames");
  const effects = Array.from((await factory.getDisplayNames()) || []).map(String);
  return { effects, count: effects.length };
}

function audioInsertionPlan(chain, componentCount, insertIndex) {
  if (!chain || !Number.isInteger(componentCount) || componentCount < 0) {
    throw new BridgeError(
      "COMPONENT_CHAIN_UNAVAILABLE",
      "apply_audio_effect component chain을 읽을 수 없습니다."
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
  if (typeof chain[methodName] !== "function") {
    throw new BridgeError(
      "COMPONENT_ACTION_UNAVAILABLE",
      `Premiere UXP ${methodName} API를 사용할 수 없습니다.`
    );
  }
  return {
    methodName,
    insertedIndex: insertIndex === undefined ? componentCount : insertIndex,
    componentCount
  };
}

function createAudioComponentAction(chain, component, plan) {
  if (plan.methodName === "createInsertComponentAction") {
    // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- caller runs synchronously inside executeUndoableTransaction
    return chain.createInsertComponentAction(component, plan.insertedIndex);
  }
  // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- caller runs synchronously inside executeUndoableTransaction
  return chain.createAppendComponentAction(component);
}

async function applyAudioEffect(args) {
  const { project, match } = await requireAudioClip(args.node_id);
  const factory = requireAudioFactory("createComponentByDisplayName");
  const available = Array.from((await factory.getDisplayNames()) || []).map(
    String
  );
  const displayName = available.find((name) =>
    displayNamesMatch(name, args.effect_name)
  );
  if (!displayName) {
    throw new BridgeError(
      "EFFECT_NOT_FOUND",
      `Audio effect not found: ${args.effect_name}`
    );
  }
  const listedBefore = await listComponents(match.item);
  const plan = audioInsertionPlan(
    listedBefore.chain,
    listedBefore.components.length,
    args.insert_index
  );
  const component = await factory.createComponentByDisplayName(
    displayName,
    match.item
  );
  if (!component) {
    throw new BridgeError(
      "EFFECT_CREATE_FAILED",
      `Audio effect를 만들 수 없습니다: ${displayName}`
    );
  }
  executeUndoableTransaction(project, "apply_audio_effect", (compoundAction) => {
    addAction(
      compoundAction,
      createAudioComponentAction(listedBefore.chain, component, plan),
      "apply_audio_effect"
    );
  });

  const listedAfter = await listComponents(match.item);
  const inserted = listedAfter.components.find(
    (entry) => entry.index === plan.insertedIndex
  );
  if (
    listedAfter.components.length !== plan.componentCount + 1 ||
    !inserted ||
    !displayNamesMatch(inserted.displayName, displayName)
  ) {
    throw new BridgeError(
      "EFFECT_READBACK_MISMATCH",
      "Audio effect 적용 후 component chain read-back이 예상과 다릅니다.",
      {
        insertedIndex: plan.insertedIndex,
        expectedDisplayName: displayName,
        actualDisplayName: inserted ? inserted.displayName : null,
        expectedComponentCount: plan.componentCount + 1,
        actualComponentCount: listedAfter.components.length
      }
    );
  }
  return {
    applied: true,
    nodeId: args.node_id,
    effectName: displayName,
    identifierType: "displayName",
    insertedIndex: plan.insertedIndex,
    insertionMode: args.insert_index === undefined ? "append" : "insert",
    duplicatePolicy: "allow-new-instance",
    intrinsicComponentPolicy: "preserve-and-count-for-index",
    indexBasis: "full-component-chain-including-intrinsic",
    component: {
      index: inserted.index,
      displayName: inserted.displayName,
      matchName: inserted.matchName,
      beforeComponentCount: plan.componentCount,
      afterComponentCount: listedAfter.components.length
    },
    undoable: true
  };
}

async function requireAudioParam(item, componentNames, propertyNames) {
  const listed = await listComponents(item);
  for (const component of listed.components) {
    if (
      componentNames.length > 0 &&
      !componentNames.some(
        (name) =>
          displayNamesMatch(component.displayName, name) ||
          displayNamesMatch(component.matchName, name)
      )
    ) {
      continue;
    }
    const params = await listParams(component.component);
    const property = params.find((entry) =>
      propertyNames.some((name) => displayNamesMatch(entry.displayName, name))
    );
    if (property) return { component, property };
  }
  throw new BridgeError(
    "PROPERTY_NOT_FOUND",
    `Audio property not found: ${propertyNames.join(" / ")}`
  );
}

function displayDbToRaw(db) {
  return 10 ** ((db - 15) / 20);
}

async function setAudioValue(
  args,
  commandName,
  rawValue,
  componentNames,
  propertyNames,
  displayValue
) {
  const { project, match } = await requireAudioClip(args.node_id);
  const target = await requireAudioParam(
    match.item,
    componentNames,
    propertyNames
  );
  executeUndoableTransaction(project, commandName, (compoundAction) => {
    addAction(
      compoundAction,
      createSetParamValueAction(target.property.param, rawValue),
      commandName
    );
  });
  return {
    updated: true,
    nodeId: args.node_id,
    componentName: target.component.displayName,
    propertyName: target.property.displayName,
    value: displayValue === undefined ? rawValue : displayValue,
    rawValue
  };
}

async function setClipVolume(args) {
  return setAudioValue(
    args,
    "set_clip_volume",
    displayDbToRaw(args.volume_db),
    ["Volume"],
    ["Level"],
    args.volume_db
  );
}

async function adjustAudioLevels(args) {
  return setAudioValue(
    args,
    "adjust_audio_levels",
    displayDbToRaw(args.level_db),
    ["Volume"],
    ["Level"],
    args.level_db
  );
}

async function setClipPan(args) {
  return setAudioValue(
    args,
    "set_clip_pan",
    args.pan,
    ["Panner", "Pan"],
    ["Pan", "Balance"]
  );
}

async function addAudioKeyframes(args) {
  const { project, match } = await requireAudioClip(args.node_id);
  const target = await requireAudioParam(match.item, ["Volume"], ["Level"]);
  const supported = await target.property.param.areKeyframesSupported();
  if (!supported) {
    throw new BridgeError(
      "KEYFRAMES_UNSUPPORTED",
      "Audio level property가 keyframe을 지원하지 않습니다."
    );
  }
  const wasTimeVarying = Boolean(target.property.param.isTimeVarying());
  const normalizedKeyframes = args.keyframes.map((entry) => ({
    ...entry,
    rawValue: displayDbToRaw(entry.level_db)
  }));
  const keyframes = normalizedKeyframes.map((entry) => {
    const keyframe = target.property.param.createKeyframe(entry.rawValue);
    keyframe.position = tickTimeFromSeconds(entry.time_seconds);
    return keyframe;
  });

  executeUndoableTransaction(
    project,
    "add_audio_keyframes",
    (compoundAction) => {
      if (!wasTimeVarying) {
        addAction(
          compoundAction,
          // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
          target.property.param.createSetTimeVaryingAction(true),
          "add_audio_keyframes"
        );
      }
      for (const keyframe of keyframes) {
        addAction(
          compoundAction,
          // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
          target.property.param.createAddKeyframeAction(keyframe),
          "add_audio_keyframes"
        );
      }
    }
  );
  return {
    added: true,
    nodeId: args.node_id,
    keyframeCount: keyframes.length,
    keyframes: normalizedKeyframes.map((entry) => ({
      timeSeconds: entry.time_seconds,
      levelDb: entry.level_db,
      rawValue: entry.rawValue
    }))
  };
}

async function muteTrack(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const trackCount = await sequence.getAudioTrackCount();
  if (args.track_index >= trackCount) {
    throw new BridgeError(
      "TRACK_NOT_FOUND",
      `Audio track not found: ${args.track_index}`
    );
  }
  const track = await sequence.getAudioTrack(args.track_index);
  if (!track || typeof track.setMute !== "function") {
    throw new BridgeError(
      "AUDIO_TRACK_MUTE_UNAVAILABLE",
      "Premiere UXP AudioTrack.setMute API를 사용할 수 없습니다."
    );
  }
  const accepted = await track.setMute(args.muted);
  if (!accepted) {
    throw new BridgeError(
      "AUDIO_TRACK_MUTE_FAILED",
      `Audio track mute 변경에 실패했습니다: ${args.track_index}`
    );
  }
  return {
    updated: true,
    trackIndex: args.track_index,
    muted: args.muted,
    undoable: false
  };
}

module.exports = {
  category: "audio",
  handlers: [
    {
      name: "list_available_audio_effects",
      writes: false,
      validate: validateNoArgs,
      execute: listAvailableAudioEffects
    },
    {
      name: "apply_audio_effect",
      writes: true,
      validate: validateApplyAudioEffectArgs,
      execute: applyAudioEffect
    },
    {
      name: "set_clip_volume",
      writes: true,
      validate(args) {
        return validateAudioLevelArgs(args, "volume_db");
      },
      execute: setClipVolume
    },
    {
      name: "adjust_audio_levels",
      writes: true,
      validate(args) {
        return validateAudioLevelArgs(args, "level_db");
      },
      execute: adjustAudioLevels
    },
    {
      name: "set_clip_pan",
      writes: true,
      validate: validatePanArgs,
      execute: setClipPan
    },
    {
      name: "add_audio_keyframes",
      writes: true,
      validate: validateAudioKeyframesArgs,
      execute: addAudioKeyframes
    },
    {
      name: "mute_track",
      writes: true,
      undoable: false,
      validate: validateMuteTrackArgs,
      execute: muteTrack
    }
  ]
};
