const TICKS_PER_SECOND = 254016000000n;
const DEFAULT_GRID_TOLERANCE_FRAMES = 0.05;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nullableBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function nullableNumber(value) {
  return isFiniteNumber(value) ? value : null;
}

function parsePositiveBigInt(value, label) {
  const text = String(value ?? "");
  assert(/^\d+$/.test(text), `${label} must be a positive integer`);
  const parsed = BigInt(text);
  assert(parsed > 0n, `${label} must be a positive integer`);
  return parsed;
}

export function resolveFrameTiming(options = {}) {
  let secondsPerFrame = null;
  let ticksPerFrame = null;

  if (options.ticksPerFrame !== undefined && options.ticksPerFrame !== null) {
    const parsed = parsePositiveBigInt(options.ticksPerFrame, "ticksPerFrame");
    secondsPerFrame = Number(parsed) / Number(TICKS_PER_SECOND);
    ticksPerFrame = parsed.toString();
  } else if (isFiniteNumber(options.frameDurationSeconds) && options.frameDurationSeconds > 0) {
    secondsPerFrame = options.frameDurationSeconds;
  } else if (isFiniteNumber(options.fps) && options.fps > 0) {
    secondsPerFrame = 1 / options.fps;
  }

  assert(
    isFiniteNumber(secondsPerFrame) && secondsPerFrame > 0,
    "Frame timing requires ticksPerFrame, frameDurationSeconds, or fps",
  );
  const gridToleranceFrames = isFiniteNumber(options.gridToleranceFrames)
    ? options.gridToleranceFrames
    : DEFAULT_GRID_TOLERANCE_FRAMES;
  assert(
    gridToleranceFrames >= 0 && gridToleranceFrames < 0.5,
    "gridToleranceFrames must be at least 0 and less than half a frame",
  );

  return Object.freeze({
    ticksPerFrame,
    secondsPerFrame,
    fps: 1 / secondsPerFrame,
    gridToleranceFrames,
  });
}

function secondsToFrame(value, timing, label) {
  const seconds = Number(value);
  assert(Number.isFinite(seconds), `${label} must be a finite number`);
  const exactFrames = seconds / timing.secondsPerFrame;
  const frame = Math.round(exactFrames);
  assert(
    Math.abs(exactFrames - frame) <= timing.gridToleranceFrames,
    `${label} is not frame-aligned (${seconds}s at ${timing.fps}fps)`,
  );
  return frame;
}

// A sequence that ends on a sample-accurate audio clip (a BGM tail the user placed off the video frame grid) has an off-grid
// duration too (2026-09-27: an A2 BGM ending at 481.8147 s stopped the Level applier's preflight). Keep the grid check for every
// other case and accept an off-grid duration only when an audio clip ends exactly there.
function sequenceDurationFrames(value, timing, tracks) {
  const seconds = Number(value);
  assert(Number.isFinite(seconds), "durationSeconds must be a finite number");
  const exactFrames = seconds / timing.secondsPerFrame;
  const frame = Math.round(exactFrames);
  if (Math.abs(exactFrames - frame) <= timing.gridToleranceFrames) return frame;
  const fractional = Number(exactFrames.toFixed(6));
  const endsOnAudioClip = tracks.some((track) => track.kind === "audio"
    && track.clips.some((clip) => Math.abs(clip.endFrame - fractional) <= 0.001));
  assert(endsOnAudioClip, `durationSeconds is not frame-aligned (${seconds}s at ${timing.fps}fps)`);
  return fractional;
}

function optionalSecondsToFrame(value, timing, label) {
  if (value === undefined || value === null || value === "") return null;
  return secondsToFrame(value, timing, label);
}

function optionalSourceSecondsToFrame(value, timing, label) {
  if (value === undefined || value === null || value === "") return null;
  const seconds = Number(value);
  assert(Number.isFinite(seconds), `${label} must be a finite number`);
  // A retimed Premiere clip can legitimately expose a source in/out between
  // sequence-frame boundaries. Preserve that fractional source-frame position;
  // only timeline start/end/duration must be aligned to the sequence grid.
  return Number((seconds / timing.secondsPerFrame).toFixed(6));
}

function normalizeClip(clip, timing, label, strictIdentity = null, kind = "video") {
  assert(clip && typeof clip === "object", `${label} must be an object`);
  // Audio clips may end off the video frame grid (sample-accurate user edits such as BGM tails).
  // Compare them as fractional frames instead of asserting grid alignment (2026-09-15).
  const toFrames = kind === "audio"
    ? (value, fieldLabel) => {
        const seconds = Number(value);
        assert(Number.isFinite(seconds), `${fieldLabel} must be a finite number`);
        return Number((seconds / timing.secondsPerFrame).toFixed(6));
      }
    : (value, fieldLabel) => secondsToFrame(value, timing, fieldLabel);
  const startFrame = toFrames(clip.startSeconds, `${label}.startSeconds`);
  const endFrame = toFrames(clip.endSeconds, `${label}.endSeconds`);
  const durationFrames = toFrames(clip.durationSeconds, `${label}.durationSeconds`);
  assert(endFrame >= startFrame, `${label} ends before it starts`);
  assert(
    Math.abs(durationFrames - (endFrame - startFrame)) <= (kind === "audio" ? 0.001 : 0),
    `${label}.durationSeconds disagrees with start/end`,
  );

  const normalized = {
    name: String(clip.name ?? ""),
    startFrame,
    endFrame,
    durationFrames,
    inPointFrame: optionalSourceSecondsToFrame(
      clip.inPointSeconds,
      timing,
      `${label}.inPointSeconds`,
    ),
    outPointFrame: optionalSourceSecondsToFrame(
      clip.outPointSeconds,
      timing,
      `${label}.outPointSeconds`,
    ),
    mediaType: clip.mediaType === undefined || clip.mediaType === null
      ? null
      : String(clip.mediaType),
    enabled: nullableBoolean(clip.enabled),
    speed: nullableNumber(clip.speed),
  };
  if (strictIdentity) {
    const index = Number(clip.index);
    const nodeId = String(clip.nodeId ?? "");
    assert(Number.isInteger(index) && index >= 0, `${label}.index must be a non-negative integer`);
    assert(nodeId.length > 0, `${label}.nodeId must be a non-empty string`);
    normalized.position = strictIdentity.position;
    normalized.index = index;
    normalized.nodeId = nodeId;
  }
  return normalized;
}

function trackKey(kind, index) {
  return `${kind}:${index}`;
}

function normalizeTrack(track, kind, position, timing, strict = false) {
  assert(track && typeof track === "object", `${kind} track ${position} must be an object`);
  const index = Number(track.index);
  assert(Number.isInteger(index) && index >= 0, `${kind} track ${position} has invalid index`);
  const clips = Array.isArray(track.clips) ? track.clips : [];
  if (track.clipCount !== undefined && track.clipCount !== null) {
    assert(Number(track.clipCount) === clips.length, `${trackKey(kind, index)} clipCount mismatch`);
  }

  const normalizedClips = clips.map((clip, clipIndex) =>
    normalizeClip(
      clip,
      timing,
      `${trackKey(kind, index)}.clips[${clipIndex}]`,
      strict ? {position: clipIndex} : null,
      kind,
    ),
  );
  if (!strict) {
    normalizedClips.sort(
      (left, right) =>
        left.startFrame - right.startFrame ||
        left.endFrame - right.endFrame ||
        left.name.localeCompare(right.name),
    );
  }

  const normalized = {
    key: trackKey(kind, index),
    kind,
    index,
    name: String(track.name ?? ""),
    isMuted: nullableBoolean(track.isMuted ?? track.muted),
    isLocked: nullableBoolean(track.isLocked ?? track.locked),
    clips: normalizedClips,
  };
  if (strict) normalized.position = position;
  return normalized;
}

function normalizeSequenceStructureInternal(snapshot, timingOptions = {}, strict = false) {
  assert(snapshot && typeof snapshot === "object", "Sequence snapshot must be an object");
  const timing = timingOptions.secondsPerFrame
    ? timingOptions
    : resolveFrameTiming(timingOptions);
  const videoTracks = Array.isArray(snapshot.videoTracks) ? snapshot.videoTracks : [];
  const audioTracks = Array.isArray(snapshot.audioTracks) ? snapshot.audioTracks : [];

  if (snapshot.videoTrackCount !== undefined && snapshot.videoTrackCount !== null) {
    assert(Number(snapshot.videoTrackCount) === videoTracks.length, "videoTrackCount mismatch");
  }
  if (snapshot.audioTrackCount !== undefined && snapshot.audioTrackCount !== null) {
    assert(Number(snapshot.audioTrackCount) === audioTracks.length, "audioTrackCount mismatch");
  }

  const tracks = [
    ...videoTracks.map((track, index) => normalizeTrack(track, "video", index, timing, strict)),
    ...audioTracks.map((track, index) => normalizeTrack(track, "audio", index, timing, strict)),
  ];
  if (!strict) {
    tracks.sort((left, right) => left.kind.localeCompare(right.kind) || left.index - right.index);
  }
  const keys = tracks.map((track) => track.key);
  assert(new Set(keys).size === keys.length, "Sequence snapshot contains duplicate track indexes");
  if (strict) {
    const nodeIds = tracks.flatMap((track) => track.clips.map((clip) => clip.nodeId));
    assert(
      new Set(nodeIds).size === nodeIds.length,
      "Sequence snapshot contains duplicate clip nodeIds",
    );
  }

  return {
    id: String(snapshot.id ?? ""),
    name: String(snapshot.name ?? ""),
    durationFrames: sequenceDurationFrames(snapshot.durationSeconds, timing, tracks),
    tracks,
    timing,
  };
}

export function normalizeSequenceStructure(snapshot, timingOptions = {}) {
  return normalizeSequenceStructureInternal(snapshot, timingOptions, false);
}

// Level-only operations must prove that no clip object was silently replaced or
// reordered. The semantic cut normalizer intentionally omits host-local IDs and
// array positions; this strict form retains nodeId, clip index, and both source
// positions so it is suitable as a no-mutation fingerprint.
export function normalizeSequenceStructureStrict(snapshot, timingOptions = {}) {
  return normalizeSequenceStructureInternal(snapshot, timingOptions, true);
}

function normalizeTrackSpecifier(value) {
  if (value && typeof value === "object") {
    const kind = String(value.kind ?? value.type ?? "").toLowerCase();
    const index = Number(value.index ?? value.trackIndex);
    assert(kind === "video" || kind === "audio", `Invalid track kind: ${kind || value}`);
    assert(Number.isInteger(index) && index >= 0, `Invalid track index: ${index}`);
    return trackKey(kind, index);
  }

  const text = String(value ?? "").trim();
  let match = /^([va])(\d+)$/i.exec(text);
  if (match) {
    const index = Number(match[2]) - 1;
    assert(index >= 0, `Track labels are 1-based: ${text}`);
    return trackKey(match[1].toLowerCase() === "v" ? "video" : "audio", index);
  }
  match = /^(video|audio):(\d+)$/i.exec(text);
  assert(match, `Invalid track specifier: ${text}`);
  return trackKey(match[1].toLowerCase(), Number(match[2]));
}

export function normalizeTargetTracks(targetTracks) {
  const source = typeof targetTracks === "string"
    ? targetTracks.split(",").map((value) => value.trim()).filter(Boolean)
    : targetTracks;
  assert(Array.isArray(source) && source.length > 0, "At least one target track is required");
  return [...new Set(source.map(normalizeTrackSpecifier))].sort();
}

export function normalizeCutRanges(cuts, timingOptions = {}) {
  assert(Array.isArray(cuts) && cuts.length > 0, "At least one cut range is required");
  const timing = timingOptions.secondsPerFrame
    ? timingOptions
    : resolveFrameTiming(timingOptions);
  const normalized = cuts.map((cut, index) => {
    assert(cut && typeof cut === "object", `cuts[${index}] must be an object`);
    const hasStartFrame = Number.isInteger(cut.startFrame);
    const hasEndFrame = Number.isInteger(cut.endFrame);
    assert(hasStartFrame === hasEndFrame, `cuts[${index}] needs both startFrame and endFrame`);
    const startFrame = hasStartFrame
      ? cut.startFrame
      : secondsToFrame(cut.startSeconds, timing, `cuts[${index}].startSeconds`);
    const endFrame = hasEndFrame
      ? cut.endFrame
      : secondsToFrame(cut.endSeconds, timing, `cuts[${index}].endSeconds`);
    assert(Number.isInteger(startFrame) && startFrame >= 0, `cuts[${index}] has invalid startFrame`);
    assert(Number.isInteger(endFrame) && endFrame > startFrame, `cuts[${index}] has invalid endFrame`);

    if (hasStartFrame && cut.startSeconds !== undefined) {
      const fromSeconds = secondsToFrame(cut.startSeconds, timing, `cuts[${index}].startSeconds`);
      assert(fromSeconds === startFrame, `cuts[${index}] startFrame disagrees with startSeconds`);
    }
    if (hasEndFrame && cut.endSeconds !== undefined) {
      const fromSeconds = secondsToFrame(cut.endSeconds, timing, `cuts[${index}].endSeconds`);
      assert(fromSeconds === endFrame, `cuts[${index}] endFrame disagrees with endSeconds`);
    }

    return {index, startFrame, endFrame, removeFrames: endFrame - startFrame};
  });
  normalized.sort((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame);
  for (let index = 1; index < normalized.length; index += 1) {
    assert(
      normalized[index].startFrame >= normalized[index - 1].endFrame,
      `Cut ranges overlap: cuts[${normalized[index - 1].index}] and cuts[${normalized[index].index}]`,
    );
  }
  return normalized;
}

function sourceFrameAt(clip, timelineFrame) {
  if (clip.inPointFrame === null || clip.outPointFrame === null) return null;
  const timelineDuration = clip.endFrame - clip.startFrame;
  if (timelineDuration === 0) return clip.inPointFrame;
  const sourceDuration = clip.outPointFrame - clip.inPointFrame;
  const offset = timelineFrame - clip.startFrame;
  return clip.inPointFrame + Math.round((offset * sourceDuration) / timelineDuration);
}

function sliceClip(clip, sourceStartFrame, sourceEndFrame, timelineStartFrame, timelineEndFrame) {
  return {
    ...clip,
    startFrame: timelineStartFrame,
    endFrame: timelineEndFrame,
    durationFrames: timelineEndFrame - timelineStartFrame,
    inPointFrame: sourceFrameAt(clip, sourceStartFrame),
    outPointFrame: sourceFrameAt(clip, sourceEndFrame),
  };
}

function applyOneRippleCut(clips, cut) {
  const removeFrames = cut.endFrame - cut.startFrame;
  const output = [];
  for (const clip of clips) {
    if (clip.endFrame <= cut.startFrame) {
      output.push({...clip});
      continue;
    }
    if (clip.startFrame >= cut.endFrame) {
      output.push({
        ...clip,
        startFrame: clip.startFrame - removeFrames,
        endFrame: clip.endFrame - removeFrames,
      });
      continue;
    }

    if (clip.startFrame < cut.startFrame) {
      output.push(
        sliceClip(
          clip,
          clip.startFrame,
          cut.startFrame,
          clip.startFrame,
          cut.startFrame,
        ),
      );
    }
    if (clip.endFrame > cut.endFrame) {
      output.push(
        sliceClip(
          clip,
          cut.endFrame,
          clip.endFrame,
          cut.startFrame,
          clip.endFrame - removeFrames,
        ),
      );
    }
  }
  output.sort(
    (left, right) =>
      left.startFrame - right.startFrame ||
      left.endFrame - right.endFrame ||
      left.name.localeCompare(right.name),
  );
  return output;
}

export function simulateRippleCutsForTrack(track, cuts) {
  let clips = track.clips.map((clip) => ({...clip}));
  for (const cut of [...cuts].sort((left, right) => right.startFrame - left.startFrame)) {
    clips = applyOneRippleCut(clips, cut);
  }
  return {...track, clips};
}

function comparableTrack(track) {
  return {
    key: track.key,
    kind: track.kind,
    index: track.index,
    name: track.name,
    isMuted: track.isMuted,
    isLocked: track.isLocked,
    clips: track.clips,
  };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function firstClipDifference(expected, actual) {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    if (!sameValue(expected[index], actual[index])) {
      return {
        index,
        expected: expected[index] ?? null,
        actual: actual[index] ?? null,
      };
    }
  }
  return null;
}

function invalidSnapshotResult(error, stage) {
  return {
    ok: false,
    targetTracks: [],
    expectedDurationDeltaFrames: null,
    observedDurationDeltaFrames: null,
    changedTracks: [],
    failures: [{kind: "invalid_snapshot", stage, message: error.message}],
  };
}

export function diffSequenceStructures(beforeSnapshot, afterSnapshot, contract = {}) {
  let timing;
  let before;
  let after;
  try {
    timing = contract.timing?.secondsPerFrame
      ? contract.timing
      : resolveFrameTiming(contract);
    before = normalizeSequenceStructure(beforeSnapshot, timing);
  } catch (error) {
    return invalidSnapshotResult(error, "before");
  }
  try {
    after = normalizeSequenceStructure(afterSnapshot, timing);
  } catch (error) {
    return invalidSnapshotResult(error, "after");
  }

  let targets;
  let cuts;
  try {
    targets = normalizeTargetTracks(contract.targetTracks);
    cuts = normalizeCutRanges(contract.cuts, timing);
  } catch (error) {
    return {
      ok: false,
      frameTiming: timing,
      targetTracks: [],
      expectedDurationDeltaFrames: null,
      observedDurationDeltaFrames: Number((after.durationFrames - before.durationFrames).toFixed(6)),
      changedTracks: [],
      failures: [{kind: "invalid_contract", message: error.message}],
    };
  }

  const failures = [];
  const beforeTracks = new Map(before.tracks.map((track) => [track.key, track]));
  const afterTracks = new Map(after.tracks.map((track) => [track.key, track]));
  const allTrackKeys = [...new Set([...beforeTracks.keys(), ...afterTracks.keys()])].sort();
  const targetSet = new Set(targets);

  if (before.id !== after.id) {
    failures.push({kind: "sequence_identity_changed", before: before.id, after: after.id});
  }
  if (before.name !== after.name) {
    failures.push({kind: "sequence_name_changed", before: before.name, after: after.name});
  }

  for (const target of targetSet) {
    if (!beforeTracks.has(target) || !afterTracks.has(target)) {
      failures.push({
        kind: "target_track_missing",
        track: target,
        existedBefore: beforeTracks.has(target),
        existsAfter: afterTracks.has(target),
      });
    }
  }

  const cutRemoveFrames = cuts.reduce((sum, cut) => sum + cut.removeFrames, 0);
  let expectedDurationDeltaFrames = -cutRemoveFrames;
  try {
    if (contract.expectedDurationDeltaFrames !== undefined) {
      const declared = Number(contract.expectedDurationDeltaFrames);
      assert(Number.isInteger(declared), "expectedDurationDeltaFrames must be an integer");
      if (declared !== expectedDurationDeltaFrames) {
        failures.push({
          kind: "contract_duration_delta_mismatch",
          fromCuts: expectedDurationDeltaFrames,
          declared,
        });
      }
      expectedDurationDeltaFrames = declared;
    } else if (contract.expectedDurationDeltaSeconds !== undefined) {
      const declared = secondsToFrame(
        contract.expectedDurationDeltaSeconds,
        timing,
        "expectedDurationDeltaSeconds",
      );
      if (declared !== expectedDurationDeltaFrames) {
        failures.push({
          kind: "contract_duration_delta_mismatch",
          fromCuts: expectedDurationDeltaFrames,
          declared,
        });
      }
      expectedDurationDeltaFrames = declared;
    }
  } catch (error) {
    failures.push({kind: "invalid_contract", message: error.message});
  }

  for (const cut of cuts) {
    if (cut.endFrame > before.durationFrames) {
      failures.push({
        kind: "cut_outside_sequence",
        cut,
        sequenceDurationFrames: before.durationFrames,
      });
    }
  }

  // Off-grid (audio-ended) durations are fractional; round the difference so an exact cut still compares equal.
  const observedDurationDeltaFrames = Number((after.durationFrames - before.durationFrames).toFixed(6));
  if (observedDurationDeltaFrames !== expectedDurationDeltaFrames) {
    failures.push({
      kind: "duration_delta_mismatch",
      expected: expectedDurationDeltaFrames,
      actual: observedDurationDeltaFrames,
      before: before.durationFrames,
      after: after.durationFrames,
    });
  }

  const changedTracks = [];
  for (const key of allTrackKeys) {
    const beforeTrack = beforeTracks.get(key);
    const afterTrack = afterTracks.get(key);
    if (!beforeTrack || !afterTrack) {
      failures.push({
        kind: "track_set_changed",
        track: key,
        existedBefore: Boolean(beforeTrack),
        existsAfter: Boolean(afterTrack),
      });
      changedTracks.push(key);
      continue;
    }

    if (!sameValue(comparableTrack(beforeTrack), comparableTrack(afterTrack))) {
      changedTracks.push(key);
    }

    if (!targetSet.has(key)) {
      if (!sameValue(comparableTrack(beforeTrack), comparableTrack(afterTrack))) {
        failures.push({
          kind: "non_target_track_changed",
          track: key,
          clipDifference: firstClipDifference(beforeTrack.clips, afterTrack.clips),
        });
      }
      continue;
    }

    const expectedTrack = simulateRippleCutsForTrack(beforeTrack, cuts);
    if (!sameValue(comparableTrack(expectedTrack), comparableTrack(afterTrack))) {
      failures.push({
        kind: "target_track_mismatch",
        track: key,
        clipDifference: firstClipDifference(expectedTrack.clips, afterTrack.clips),
      });
    }
  }

  return {
    ok: failures.length === 0,
    frameTiming: timing,
    targetTracks: targets,
    cutCount: cuts.length,
    cutRemoveFrames,
    beforeDurationFrames: before.durationFrames,
    expectedAfterDurationFrames: before.durationFrames + expectedDurationDeltaFrames,
    afterDurationFrames: after.durationFrames,
    expectedDurationDeltaFrames,
    observedDurationDeltaFrames,
    changedTracks,
    checkedTrackCount: allTrackKeys.length,
    failures,
  };
}

export const verifyRippleCutInvariant = diffSequenceStructures;
