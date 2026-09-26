const { BridgeError } = require("./errors.js");
const {
  addAction,
  createSetParamValueAction,
  executeUndoableTransaction,
  findSequence,
  getActiveProject,
  listParams,
  numberArg,
  ppro,
  readValue,
  rejectUnknown,
  requireComponent,
  requireParam,
  requireTrackItem,
  secondsOf,
  serializeComponentValue,
  stringArg,
  tickTimeFromSeconds
} = require("./shared.js");

function validateEffectArgs(args) {
  rejectUnknown(args, ["node_id", "effect_name"]);
  return {
    node_id: stringArg(args.node_id, "node_id"),
    effect_name: stringArg(args.effect_name, "effect_name")
  };
}

function validatePropertyArgs(args) {
  rejectUnknown(args, ["node_id", "effect_name", "property_name"]);
  return {
    node_id: stringArg(args.node_id, "node_id"),
    effect_name: stringArg(args.effect_name, "effect_name"),
    property_name: stringArg(args.property_name, "property_name")
  };
}

function validateSetPropertyArgs(args) {
  rejectUnknown(args, ["node_id", "effect_name", "property_name", "value"]);
  return {
    ...validatePropertyArgs({
      node_id: args.node_id,
      effect_name: args.effect_name,
      property_name: args.property_name
    }),
    value: numberArg(args.value, "value")
  };
}

function validateKeyframeArgs(args) {
  rejectUnknown(args, [
    "node_id",
    "effect_name",
    "property_name",
    "time_seconds",
    "value"
  ]);
  return {
    node_id: stringArg(args.node_id, "node_id"),
    effect_name: stringArg(args.effect_name, "effect_name"),
    property_name: stringArg(args.property_name, "property_name"),
    time_seconds: numberArg(args.time_seconds, "time_seconds", { min: 0 }),
    value: numberArg(args.value, "value")
  };
}

function validateTimeArgs(args) {
  rejectUnknown(args, [
    "node_id",
    "effect_name",
    "property_name",
    "time_seconds"
  ]);
  return {
    node_id: stringArg(args.node_id, "node_id"),
    effect_name: stringArg(args.effect_name, "effect_name"),
    property_name: stringArg(args.property_name, "property_name"),
    time_seconds: numberArg(args.time_seconds, "time_seconds", { min: 0 })
  };
}

function validateRangeArgs(args) {
  rejectUnknown(args, [
    "node_id",
    "effect_name",
    "property_name",
    "start_seconds",
    "end_seconds"
  ]);
  const startSeconds = numberArg(args.start_seconds, "start_seconds", {
    min: 0
  });
  const endSeconds = numberArg(args.end_seconds, "end_seconds", { min: 0 });
  if (endSeconds < startSeconds) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "end_seconds는 start_seconds 이상이어야 합니다."
    );
  }
  return {
    node_id: stringArg(args.node_id, "node_id"),
    effect_name: stringArg(args.effect_name, "effect_name"),
    property_name: stringArg(args.property_name, "property_name"),
    start_seconds: startSeconds,
    end_seconds: endSeconds
  };
}

function validateInterpolationArgs(args) {
  rejectUnknown(args, [
    "node_id",
    "effect_name",
    "property_name",
    "time_seconds",
    "interpolation"
  ]);
  const interpolation = stringArg(args.interpolation, "interpolation").toLowerCase();
  if (!["linear", "hold", "bezier"].includes(interpolation)) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "interpolation은 linear, hold, bezier 중 하나여야 합니다."
    );
  }
  return {
    node_id: stringArg(args.node_id, "node_id"),
    effect_name: stringArg(args.effect_name, "effect_name"),
    property_name: stringArg(args.property_name, "property_name"),
    time_seconds: numberArg(args.time_seconds, "time_seconds", { min: 0 }),
    interpolation
  };
}

function validateColorArgs(args) {
  rejectUnknown(args, [
    "node_id",
    "component_name",
    "property_name",
    "alpha",
    "red",
    "green",
    "blue"
  ]);
  return {
    node_id: stringArg(args.node_id, "node_id"),
    component_name: stringArg(args.component_name, "component_name"),
    property_name: stringArg(args.property_name, "property_name"),
    alpha: numberArg(args.alpha, "alpha", { min: 0, max: 255 }),
    red: numberArg(args.red, "red", { min: 0, max: 255 }),
    green: numberArg(args.green, "green", { min: 0, max: 255 }),
    blue: numberArg(args.blue, "blue", { min: 0, max: 255 })
  };
}

async function requirePropertyContext(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await requireTrackItem(sequence, args.node_id);
  const effect = await requireComponent(match.item, args.effect_name);
  const property = await requireParam(effect.component, args.property_name);
  return { project, sequence, match, effect, property };
}

async function describeParam(entry) {
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

async function getEffectProperties(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await requireTrackItem(sequence, args.node_id);
  const effect = await requireComponent(match.item, args.effect_name);
  const params = await listParams(effect.component);
  const properties = [];
  for (const param of params) properties.push(await describeParam(param));
  return {
    nodeId: args.node_id,
    effectName: effect.displayName,
    matchName: effect.matchName,
    effectIndex: effect.index,
    properties
  };
}

async function setEffectProperty(args) {
  const context = await requirePropertyContext(args);
  executeUndoableTransaction(
    context.project,
    "set_effect_property",
    (compoundAction) => {
      addAction(
        compoundAction,
        createSetParamValueAction(context.property.param, args.value),
        "set_effect_property"
      );
    }
  );
  return {
    updated: true,
    nodeId: args.node_id,
    effectName: context.effect.displayName,
    propertyName: context.property.displayName,
    value: args.value
  };
}

async function ensureKeyframesSupported(param) {
  const supported = await param.areKeyframesSupported();
  if (!supported) {
    throw new BridgeError(
      "KEYFRAMES_UNSUPPORTED",
      "이 effect property는 keyframe을 지원하지 않습니다."
    );
  }
}

async function addKeyframe(args) {
  const context = await requirePropertyContext(args);
  await ensureKeyframesSupported(context.property.param);
  const keyframe = context.property.param.createKeyframe(args.value);
  keyframe.position = tickTimeFromSeconds(args.time_seconds);
  const wasTimeVarying = Boolean(context.property.param.isTimeVarying());

  executeUndoableTransaction(context.project, "add_keyframe", (compoundAction) => {
    if (!wasTimeVarying) {
      addAction(
        compoundAction,
        // executeUndoableTransaction invokes this callback synchronously inside
        // Project.lockedAccess() and Project.executeTransaction().
        // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- custom transaction wrapper preserves Adobe's lock scope
        context.property.param.createSetTimeVaryingAction(true),
        "add_keyframe"
      );
    }
    addAction(
      compoundAction,
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
      context.property.param.createAddKeyframeAction(keyframe),
      "add_keyframe"
    );
  });
  return {
    added: true,
    nodeId: args.node_id,
    effectName: context.effect.displayName,
    propertyName: context.property.displayName,
    timeSeconds: args.time_seconds,
    value: args.value
  };
}

async function getKeyframes(args) {
  const context = await requirePropertyContext(args);
  const times = Array.from(
    context.property.param.getKeyframeListAsTickTimes() || []
  );
  const keyframes = [];
  for (const time of times) {
    const keyframe = context.property.param.getKeyframePtr(time);
    keyframes.push({
      timeSeconds: secondsOf(time),
      value: serializeComponentValue(keyframe),
      interpolation: await readValue(keyframe, "getTemporalInterpolationMode")
    });
  }
  return {
    nodeId: args.node_id,
    effectName: context.effect.displayName,
    propertyName: context.property.displayName,
    keyframes
  };
}

async function getValueAtTime(args) {
  const context = await requirePropertyContext(args);
  const value = await context.property.param.getValueAtTime(
    tickTimeFromSeconds(args.time_seconds)
  );
  return {
    nodeId: args.node_id,
    effectName: context.effect.displayName,
    propertyName: context.property.displayName,
    timeSeconds: args.time_seconds,
    value: serializeComponentValue(value)
  };
}

async function removeKeyframe(args) {
  const context = await requirePropertyContext(args);
  await ensureKeyframesSupported(context.property.param);
  executeUndoableTransaction(
    context.project,
    "remove_keyframe",
    (compoundAction) => {
      addAction(
        compoundAction,
        // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
        context.property.param.createRemoveKeyframeAction(
          tickTimeFromSeconds(args.time_seconds),
          true
        ),
        "remove_keyframe"
      );
    }
  );
  return { removed: true, timeSeconds: args.time_seconds };
}

async function removeKeyframeRange(args) {
  const context = await requirePropertyContext(args);
  await ensureKeyframesSupported(context.property.param);
  executeUndoableTransaction(
    context.project,
    "remove_keyframe_range",
    (compoundAction) => {
      addAction(
        compoundAction,
        // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
        context.property.param.createRemoveKeyframeRangeAction(
          tickTimeFromSeconds(args.start_seconds),
          tickTimeFromSeconds(args.end_seconds),
          true
        ),
        "remove_keyframe_range"
      );
    }
  );
  return {
    removed: true,
    startSeconds: args.start_seconds,
    endSeconds: args.end_seconds
  };
}

function interpolationMode(name) {
  const constants = (ppro().Constants && ppro().Constants.InterpolationMode) || {};
  const keyframeApi = ppro().Keyframe || {};
  const values = {
    linear:
      constants.LINEAR !== undefined
        ? constants.LINEAR
        : keyframeApi.INTERPOLATION_MODE_LINEAR,
    hold:
      constants.HOLD !== undefined
        ? constants.HOLD
        : keyframeApi.INTERPOLATION_MODE_HOLD,
    bezier:
      constants.BEZIER !== undefined
        ? constants.BEZIER
        : keyframeApi.INTERPOLATION_MODE_BEZIER
  };
  const value = values[name];
  if (value === undefined) {
    throw new BridgeError(
      "INTERPOLATION_API_UNAVAILABLE",
      `Interpolation mode를 사용할 수 없습니다: ${name}`
    );
  }
  return value;
}

async function setKeyframeInterpolation(args) {
  const context = await requirePropertyContext(args);
  await ensureKeyframesSupported(context.property.param);
  executeUndoableTransaction(
    context.project,
    "set_keyframe_interpolation",
    (compoundAction) => {
      addAction(
        compoundAction,
        // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
        context.property.param.createSetInterpolationAtKeyframeAction(
          tickTimeFromSeconds(args.time_seconds),
          interpolationMode(args.interpolation),
          true
        ),
        "set_keyframe_interpolation"
      );
    }
  );
  return {
    updated: true,
    timeSeconds: args.time_seconds,
    interpolation: args.interpolation
  };
}

async function setColorValue(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await requireTrackItem(sequence, args.node_id);
  const component = await requireComponent(match.item, args.component_name);
  const property = await requireParam(component.component, args.property_name);
  const value = {
    red: args.red / 255,
    green: args.green / 255,
    blue: args.blue / 255,
    alpha: args.alpha / 255
  };
  executeUndoableTransaction(project, "set_color_value", (compoundAction) => {
    addAction(
      compoundAction,
      createSetParamValueAction(property.param, value, "color"),
      "set_color_value"
    );
  });
  return {
    updated: true,
    nodeId: args.node_id,
    componentName: component.displayName,
    propertyName: property.displayName,
    color: {
      alpha: args.alpha,
      red: args.red,
      green: args.green,
      blue: args.blue
    }
  };
}

module.exports = {
  category: "keyframes",
  handlers: [
    {
      name: "get_effect_properties",
      writes: false,
      validate: validateEffectArgs,
      execute: getEffectProperties
    },
    {
      name: "set_effect_property",
      writes: true,
      validate: validateSetPropertyArgs,
      execute: setEffectProperty
    },
    {
      name: "add_keyframe",
      writes: true,
      validate: validateKeyframeArgs,
      execute: addKeyframe
    },
    {
      name: "get_keyframes",
      writes: false,
      validate: validatePropertyArgs,
      execute: getKeyframes
    },
    {
      name: "get_value_at_time",
      writes: false,
      validate: validateTimeArgs,
      execute: getValueAtTime
    },
    {
      name: "remove_keyframe",
      writes: true,
      dangerous: true,
      validate: validateTimeArgs,
      execute: removeKeyframe
    },
    {
      name: "remove_keyframe_range",
      writes: true,
      dangerous: true,
      validate: validateRangeArgs,
      execute: removeKeyframeRange
    },
    {
      name: "set_keyframe_interpolation",
      writes: true,
      validate: validateInterpolationArgs,
      execute: setKeyframeInterpolation
    },
    {
      name: "set_color_value",
      writes: true,
      validate: validateColorArgs,
      execute: setColorValue
    }
  ]
};
