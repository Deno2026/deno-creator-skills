const { BridgeError } = require("./errors.js");
const {
  addAction,
  executeUndoableTransaction,
  findSequence,
  getActiveProject,
  numberArg,
  ppro,
  rejectUnknown,
  requireTrackItem,
  secondsOf,
  stringArg,
  tickTimeFromSeconds,
  validateNoArgs
} = require("./shared.js");

function validateAddTransitionArgs(args) {
  rejectUnknown(args, [
    "transition_name",
    "track_index",
    "cut_point_seconds",
    "duration_seconds"
  ]);
  return {
    transition_name: stringArg(args.transition_name, "transition_name"),
    track_index: numberArg(args.track_index, "track_index", {
      integer: true,
      min: 0
    }),
    cut_point_seconds: numberArg(args.cut_point_seconds, "cut_point_seconds", {
      min: 0
    }),
    duration_seconds: numberArg(args.duration_seconds, "duration_seconds", {
      optional: true,
      fallback: 1,
      min: 0.001
    })
  };
}

function validateAddToClipArgs(args) {
  rejectUnknown(args, [
    "node_id",
    "transition_name",
    "position",
    "duration_seconds"
  ]);
  const position = stringArg(args.position, "position", {
    optional: true,
    fallback: "end"
  }).toLowerCase();
  if (!["start", "end", "both"].includes(position)) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "position은 start, end, both 중 하나여야 합니다."
    );
  }
  return {
    node_id: stringArg(args.node_id, "node_id"),
    transition_name: stringArg(args.transition_name, "transition_name"),
    position,
    duration_seconds: numberArg(args.duration_seconds, "duration_seconds", {
      optional: true,
      fallback: 1,
      min: 0.001
    })
  };
}

function validateRemoveTransitionArgs(args) {
  rejectUnknown(args, ["node_id", "position"]);
  const position = stringArg(args.position, "position", {
    optional: true,
    fallback: "end"
  }).toLowerCase();
  if (position !== "end") {
    throw new BridgeError(
      "UNVERIFIED_ARGUMENT_SCOPE",
      "remove_transition은 live 검증된 position=end만 사용할 수 있습니다. start/both는 별도 disposable-project 검증 전까지 차단됩니다."
    );
  }
  return {
    node_id: stringArg(args.node_id, "node_id"),
    position
  };
}

function transitionFactory(methodName) {
  const factory = ppro().TransitionFactory;
  if (!factory || typeof factory[methodName] !== "function") {
    throw new BridgeError(
      "TRANSITION_FACTORY_UNAVAILABLE",
      `Premiere UXP TransitionFactory.${methodName} API를 사용할 수 없습니다.`
    );
  }
  return factory;
}

async function transitionMatchNames() {
  const factory = transitionFactory("getVideoTransitionMatchNames");
  return Array.from((await factory.getVideoTransitionMatchNames()) || []).map(
    String
  );
}

async function resolveTransitionMatchName(value) {
  const requested = String(value).toLocaleLowerCase();
  const names = await transitionMatchNames();
  const matchName = names.find(
    (name) => name.toLocaleLowerCase() === requested
  );
  if (!matchName) {
    throw new BridgeError(
      "TRANSITION_NOT_FOUND",
      `UXP video transition matchName을 찾을 수 없습니다: ${value}`
    );
  }
  return matchName;
}

async function listAvailableTransitions() {
  const transitions = await transitionMatchNames();
  return { transitions, count: transitions.length, nameType: "matchName" };
}

function createTransition(matchName) {
  const factory = transitionFactory("createVideoTransition");
  const transition = factory.createVideoTransition(matchName);
  if (!transition) {
    throw new BridgeError(
      "TRANSITION_CREATE_FAILED",
      `Video transition을 만들 수 없습니다: ${matchName}`
    );
  }
  return transition;
}

function createOptions(applyToStart, durationSeconds) {
  const Options = ppro().AddTransitionOptions;
  if (typeof Options !== "function") {
    throw new BridgeError(
      "TRANSITION_OPTIONS_UNAVAILABLE",
      "Premiere UXP AddTransitionOptions API를 사용할 수 없습니다."
    );
  }
  const options = new Options();
  options.setApplyToStart(applyToStart);
  options.setDuration(tickTimeFromSeconds(durationSeconds));
  // false requests a normal two-sided transition when neighboring media and
  // handles permit it. UXP falls back according to Premiere's edit state.
  options.setForceSingleSided(false);
  return options;
}

function requireAddTransitionActionApi(item) {
  if (!item || typeof item.createAddVideoTransitionAction !== "function") {
    throw new BridgeError(
      "VIDEO_TRANSITION_API_UNAVAILABLE",
      "Premiere UXP VideoClipTrackItem transition API를 사용할 수 없습니다."
    );
  }
}

function requireRemoveTransitionActionApi(item) {
  if (!item || typeof item.createRemoveVideoTransitionAction !== "function") {
    throw new BridgeError(
      "VIDEO_TRANSITION_REMOVE_API_UNAVAILABLE",
      "Premiere UXP VideoClipTrackItem transition 제거 API를 사용할 수 없습니다."
    );
  }
}

function transitionPositionValue(position) {
  const values = ppro().Constants.TransitionPosition;
  const transitionPosition =
    position === "start" ? values && values.START : values && values.END;
  if (transitionPosition === undefined || transitionPosition === null) {
    throw new BridgeError(
      "TRANSITION_POSITION_UNAVAILABLE",
      `Premiere UXP TransitionPosition.${position.toUpperCase()} 상수를 사용할 수 없습니다.`
    );
  }
  return transitionPosition;
}

async function addTransitionToClip(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await requireTrackItem(sequence, args.node_id);
  if (match.trackType !== "video") {
    throw new BridgeError(
      "VIDEO_CLIP_REQUIRED",
      "Video transition에는 video clip node_id가 필요합니다."
    );
  }
  const matchName = await resolveTransitionMatchName(args.transition_name);
  const positions = args.position === "both" ? ["start", "end"] : [args.position];
  requireAddTransitionActionApi(match.item);

  executeUndoableTransaction(
    project,
    "add_transition_to_clip",
    (compoundAction) => {
      for (const position of positions) {
        const transition = createTransition(matchName);
        const options = createOptions(
          position === "start",
          args.duration_seconds
        );
        addAction(
          compoundAction,
          // executeUndoableTransaction invokes this callback synchronously
          // inside Project.lockedAccess() and Project.executeTransaction().
          // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- custom transaction wrapper preserves Adobe's lock scope
          match.item.createAddVideoTransitionAction(transition, options),
          "add_transition_to_clip"
        );
      }
    }
  );
  return {
    added: true,
    nodeId: args.node_id,
    transitionName: matchName,
    position: args.position,
    durationSeconds: args.duration_seconds
  };
}

async function removeTransition(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const match = await requireTrackItem(sequence, args.node_id);
  if (match.trackType !== "video") {
    throw new BridgeError(
      "VIDEO_CLIP_REQUIRED",
      "Video transition 제거에는 video clip node_id가 필요합니다."
    );
  }
  const positions = args.position === "both" ? ["start", "end"] : [args.position];
  requireRemoveTransitionActionApi(match.item);
  const transitionPositions = positions.map(transitionPositionValue);
  executeUndoableTransaction(project, "remove_transition", (compoundAction) => {
    for (const transitionPosition of transitionPositions) {
      addAction(
        compoundAction,
        // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
        match.item.createRemoveVideoTransitionAction(transitionPosition),
        "remove_transition"
      );
    }
  });
  return {
    removed: true,
    nodeId: args.node_id,
    position: args.position,
    undoable: true
  };
}

async function findClipAtCut(sequence, trackIndex, cutPointSeconds) {
  const trackCount = await sequence.getVideoTrackCount();
  if (trackIndex >= trackCount) {
    throw new BridgeError(
      "TRACK_NOT_FOUND",
      `Video track not found: ${trackIndex}`
    );
  }
  const track = await sequence.getVideoTrack(trackIndex);
  const items = Array.from(
    (await Promise.resolve(
      track.getTrackItems(ppro().Constants.TrackItemType.CLIP, false)
    )) || []
  );
  const toleranceSeconds = 0.001;
  let starting = null;
  for (const item of items) {
    const [start, end] = await Promise.all([
      item.getStartTime(),
      item.getEndTime()
    ]);
    if (Math.abs(secondsOf(end) - cutPointSeconds) <= toleranceSeconds) {
      return { item, applyToStart: false };
    }
    if (Math.abs(secondsOf(start) - cutPointSeconds) <= toleranceSeconds) {
      starting = { item, applyToStart: true };
    }
  }
  if (starting) return starting;
  throw new BridgeError(
    "CUT_POINT_NOT_FOUND",
    `지정한 위치에서 clip 경계를 찾을 수 없습니다: ${cutPointSeconds}`
  );
}

async function addTransition(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const target = await findClipAtCut(
    sequence,
    args.track_index,
    args.cut_point_seconds
  );
  const matchName = await resolveTransitionMatchName(args.transition_name);
  const transition = createTransition(matchName);
  const options = createOptions(target.applyToStart, args.duration_seconds);
  requireAddTransitionActionApi(target.item);
  executeUndoableTransaction(project, "add_transition", (compoundAction) => {
    addAction(
      compoundAction,
      // eslint-disable-next-line @adobe/premierepro/require-action-lock-scope -- synchronous executeUndoableTransaction callback is lock-scoped
      target.item.createAddVideoTransitionAction(transition, options),
      "add_transition"
    );
  });
  return {
    added: true,
    transitionName: matchName,
    trackIndex: args.track_index,
    cutPointSeconds: args.cut_point_seconds,
    durationSeconds: args.duration_seconds
  };
}

module.exports = {
  category: "transitions",
  handlers: [
    {
      name: "list_available_transitions",
      writes: false,
      validate: validateNoArgs,
      execute: listAvailableTransitions
    },
    {
      name: "add_transition_to_clip",
      writes: true,
      validate: validateAddToClipArgs,
      execute: addTransitionToClip
    },
    {
      name: "add_transition",
      writes: true,
      validate: validateAddTransitionArgs,
      execute: addTransition
    },
    {
      name: "remove_transition",
      writes: true,
      dangerous: true,
      validate: validateRemoveTransitionArgs,
      execute: removeTransition
    }
  ]
};
