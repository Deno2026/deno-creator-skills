import {
  createReversePremiereCutBatchPlan,
  resolvePremiereCutBatchOptions,
  serializeCutBatchError,
} from "./premiere-cut-batches.mjs";
import {
  normalizeSequenceStructure,
  normalizeTargetTracks,
  resolveFrameTiming,
  verifyRippleCutInvariant,
} from "./sequence-structure-diff.mjs";

function fail(message, code = "DIRECT_RAZOR_VALIDATION_FAILED", details = null) {
  const error = new Error(message);
  error.code = code;
  if (details !== null) error.details = details;
  throw error;
}

function assert(condition, message, code, details) {
  if (!condition) fail(message, code, details);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value, label) {
  assert(
    value !== undefined && value !== null && value !== "" && typeof value !== "boolean",
    `${label} must be a finite number`,
  );
  const parsed = Number(value);
  assert(Number.isFinite(parsed), `${label} must be a finite number`);
  return parsed;
}

function integer(value, label) {
  assert(
    value !== undefined && value !== null && value !== "" && typeof value !== "boolean",
    `${label} must be an integer`,
  );
  const parsed = Number(value);
  assert(Number.isInteger(parsed), `${label} must be an integer`);
  return parsed;
}

function nonEmptyString(value, label) {
  const parsed = String(value ?? "").trim();
  assert(parsed.length > 0, `${label} must be a non-empty string`);
  return parsed;
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function resolveTimingInput(manifest) {
  const timing = isObject(manifest.timing) ? manifest.timing : {};
  const options = isObject(manifest.options) ? manifest.options : {};
  return {
    ticksPerFrame:
      timing.ticksPerFrame ?? manifest.ticksPerFrame ?? options.ticksPerFrame,
    frameDurationSeconds:
      timing.frameDurationSeconds ??
      manifest.frameDurationSeconds ??
      options.frameDurationSeconds,
    fps: timing.fps ?? manifest.fps ?? options.fps,
  };
}

function resolveTargetClipNames(manifest) {
  const values = [];
  if (Array.isArray(manifest.targetClipNames)) values.push(...manifest.targetClipNames);
  if (Array.isArray(manifest.targetClips)) {
    for (const entry of manifest.targetClips) {
      values.push(isObject(entry) ? entry.name : entry);
    }
  }
  values.push(manifest.targetClipName, manifest.clipName);
  return uniqueStrings(values);
}

function resolveManifestMode(manifest) {
  const source = String(
    manifest.mode ?? manifest.kind ?? manifest.cutMode ?? manifest.contentMode ?? "",
  ).toLowerCase();
  if (source.includes("semantic") || source.includes("editorial")) {
    return "semantic-editorial";
  }
  if (source.includes("waveform")) return "waveform-only";
  fail(
    "manifest.mode must identify a waveform-only or semantic/editorial cut manifest",
    "DIRECT_RAZOR_UNSUPPORTED_CONTENT_MODE",
  );
}

function resolveCandidatePeakAudit(manifest) {
  assert(
    isObject(manifest.candidatePeakAudit),
    "manifest.candidatePeakAudit is required",
    "DIRECT_RAZOR_CONTENT_GATE_REJECTED",
  );
  const audit = manifest.candidatePeakAudit;
  const options = isObject(manifest.options) ? manifest.options : {};
  return Object.freeze({
    energyMode: String(audit.energyMode ?? options.energyMode ?? "").toLowerCase(),
    bridgeSilenceGapSeconds: finiteNumber(
      audit.bridgeSilenceGapSeconds ?? options.bridgeSilenceGapSeconds,
      "candidatePeakAudit.bridgeSilenceGapSeconds",
    ),
    suspiciousCutCount: integer(
      audit.suspiciousCutCount,
      "candidatePeakAudit.suspiciousCutCount",
    ),
  });
}

function validateContentGate(manifest, mode, audit, cuts) {
  assert(
    audit.suspiciousCutCount === 0,
    "candidatePeakAudit.suspiciousCutCount must be 0",
    "DIRECT_RAZOR_CONTENT_GATE_REJECTED",
  );

  if (mode === "waveform-only") {
    assert(
      audit.energyMode === "peak",
      "waveform-only manifests require candidatePeakAudit.energyMode='peak'",
      "DIRECT_RAZOR_CONTENT_GATE_REJECTED",
    );
    assert(
      audit.bridgeSilenceGapSeconds === 0,
      "waveform-only manifests require candidatePeakAudit.bridgeSilenceGapSeconds=0",
      "DIRECT_RAZOR_CONTENT_GATE_REJECTED",
    );
    assert(
      manifest.writeReady !== false,
      "waveform-only manifest is explicitly marked writeReady=false",
      "DIRECT_RAZOR_CONTENT_GATE_REJECTED",
    );
    return Object.freeze({writeReady: true, waveformSnapVerified: true});
  }

  assert(
    manifest.writeReady === true,
    "semantic/editorial manifests require writeReady=true",
    "DIRECT_RAZOR_CONTENT_GATE_REJECTED",
  );
  const evidence = isObject(manifest.waveformSnapEvidence)
    ? manifest.waveformSnapEvidence
    : isObject(manifest.candidatePeakAudit.waveformSnapEvidence)
      ? manifest.candidatePeakAudit.waveformSnapEvidence
      : null;
  const manifestEvidence = Boolean(
    evidence &&
      evidence.integerFrameBoundaries === true &&
      (evidence.allBoundariesSnapped === true ||
        evidence.allCutsSnapped === true ||
        evidence.verified === true),
  );
  const perCutEvidence = cuts.every(
    (cut) => cut.waveformSnapped === true || cut.waveformSnapVerified === true,
  );
  assert(
    manifestEvidence || perCutEvidence,
    "semantic/editorial manifests require integer-frame waveform snap evidence",
    "DIRECT_RAZOR_CONTENT_GATE_REJECTED",
  );
  return Object.freeze({writeReady: true, waveformSnapVerified: true});
}

function normalizeCuts(manifest, durationFrames, targetClipNames) {
  assert(Array.isArray(manifest.cuts) && manifest.cuts.length > 0, "manifest.cuts is required");
  const cuts = manifest.cuts.map((source, position) => {
    assert(isObject(source), `cuts[${position}] must be an object`);
    const startFrame = integer(source.startFrame, `cuts[${position}].startFrame`);
    const endFrame = integer(source.endFrame, `cuts[${position}].endFrame`);
    assert(startFrame >= 0, `cuts[${position}].startFrame must be at least 0`);
    assert(endFrame > startFrame, `cuts[${position}].endFrame must be greater than startFrame`);
    assert(endFrame <= durationFrames, `cuts[${position}] exceeds sequenceDurationSeconds`);
    const targetClipName = source.targetClipName ?? source.clipName ?? null;
    if (targetClipName !== null) {
      assert(
        targetClipNames.includes(String(targetClipName)),
        `cuts[${position}] target clip is outside manifest.targetClipNames`,
      );
    }
    return Object.freeze({
      ...source,
      index: Number.isInteger(Number(source.index)) ? Number(source.index) : position,
      startFrame,
      endFrame,
      removeFrames: endFrame - startFrame,
    });
  });

  const ascending = [...cuts].sort(
    (left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame,
  );
  for (let index = 1; index < ascending.length; index += 1) {
    assert(
      ascending[index - 1].endFrame <= ascending[index].startFrame,
      `cuts overlap at frames ${ascending[index - 1].startFrame}-${ascending[index].endFrame}`,
    );
  }
  if (manifest.cutCount !== undefined) {
    assert(integer(manifest.cutCount, "manifest.cutCount") === cuts.length, "manifest.cutCount mismatch");
  }
  assert(
    new Set(cuts.map((cut) => cut.index)).size === cuts.length,
    "manifest cuts must have unique integer indexes",
  );
  return Object.freeze(cuts);
}

function resolveTimecodeDisplay(manifest, timing) {
  const source = isObject(manifest.timecodeDisplay)
    ? manifest.timecodeDisplay
    : isObject(manifest.sequenceTimecodeDisplay)
      ? manifest.sequenceTimecodeDisplay
      : {};
  const nominalFps = integer(source.nominalFps ?? Math.round(timing.fps), "timecodeDisplay.nominalFps");
  assert(nominalFps > 0, "timecodeDisplay.nominalFps must be positive");
  const fractional = Math.abs(timing.fps - nominalFps) > 0.0001;
  if (fractional) {
    assert(
      source.nominalFps !== undefined && typeof source.dropFrame === "boolean",
      "fractional frame rates require timecodeDisplay.nominalFps and dropFrame",
    );
  }
  const dropFrame = source.dropFrame === true;
  if (dropFrame) {
    assert(
      nominalFps === 30 || nominalFps === 60,
      "drop-frame display is supported only for nominal 30 or 60 fps",
    );
  }
  return Object.freeze({nominalFps, dropFrame});
}

export function validateDirectRazorManifest(manifest) {
  assert(isObject(manifest), "Cut manifest must be a JSON object");
  const projectName = nonEmptyString(manifest.projectName, "manifest.projectName");
  const sequenceName = nonEmptyString(manifest.sequenceName, "manifest.sequenceName");
  const sequenceId = manifest.sequenceId === undefined || manifest.sequenceId === null
    ? null
    : nonEmptyString(manifest.sequenceId, "manifest.sequenceId");
  const timing = resolveFrameTiming(resolveTimingInput(manifest));
  const sequenceDurationSeconds = finiteNumber(
    manifest.sequenceDurationSeconds,
    "manifest.sequenceDurationSeconds",
  );
  assert(sequenceDurationSeconds > 0, "manifest.sequenceDurationSeconds must be positive");
  const exactDurationFrames = sequenceDurationSeconds / timing.secondsPerFrame;
  const sequenceDurationFrames = Math.round(exactDurationFrames);
  assert(
    Math.abs(exactDurationFrames - sequenceDurationFrames) <= timing.gridToleranceFrames,
    "manifest.sequenceDurationSeconds must be frame-aligned",
  );

  const normalizedTrackKeys = normalizeTargetTracks(manifest.targetTracks);
  assert(
    normalizedTrackKeys.length === 2,
    "manifest.targetTracks must contain exactly one video and one audio track",
  );
  const targetTracks = normalizedTrackKeys.map((key) => {
    const [kind, indexText] = key.split(":");
    return Object.freeze({kind, index: Number(indexText), key});
  });
  assert(
    targetTracks.filter((track) => track.kind === "video").length === 1 &&
      targetTracks.filter((track) => track.kind === "audio").length === 1,
    "manifest.targetTracks must contain exactly one video and one audio track",
  );

  const targetClipNames = resolveTargetClipNames(manifest);
  assert(targetClipNames.length > 0, "manifest.targetClipNames must contain at least one clip name");
  const cuts = normalizeCuts(manifest, sequenceDurationFrames, targetClipNames);
  const mode = resolveManifestMode(manifest);
  const candidatePeakAudit = resolveCandidatePeakAudit(manifest);
  const gate = validateContentGate(manifest, mode, candidatePeakAudit, cuts);
  const timecodeDisplay = resolveTimecodeDisplay(manifest, timing);
  const removeFrames = cuts.reduce((sum, cut) => sum + cut.removeFrames, 0);

  return Object.freeze({
    projectName,
    sequenceName,
    sequenceId,
    mode,
    writeReady: gate.writeReady,
    waveformSnapVerified: gate.waveformSnapVerified,
    sequenceDurationSeconds,
    sequenceDurationFrames,
    expectedDurationAfterFrames: sequenceDurationFrames - removeFrames,
    expectedDurationAfterSeconds: (sequenceDurationFrames - removeFrames) * timing.secondsPerFrame,
    targetTracks: Object.freeze(targetTracks),
    targetTrackKeys: Object.freeze(normalizedTrackKeys),
    targetClipNames: Object.freeze(targetClipNames),
    candidatePeakAudit,
    timing,
    timecodeDisplay,
    cuts,
  });
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

export function frameToDisplayTimecode(frameValue, display) {
  let frame = integer(frameValue, "frame");
  assert(frame >= 0, "frame must be non-negative");
  const nominalFps = integer(display?.nominalFps, "timecodeDisplay.nominalFps");
  const dropFrame = display?.dropFrame === true;
  if (dropFrame) {
    const droppedPerMinute = nominalFps === 60 ? 4 : 2;
    const framesPer10Minutes = nominalFps * 600 - droppedPerMinute * 9;
    const framesPerMinute = nominalFps * 60 - droppedPerMinute;
    const tenMinuteBlocks = Math.floor(frame / framesPer10Minutes);
    const remainder = frame % framesPer10Minutes;
    frame += droppedPerMinute * 9 * tenMinuteBlocks;
    if (remainder >= droppedPerMinute) {
      frame += droppedPerMinute * Math.floor((remainder - droppedPerMinute) / framesPerMinute);
    }
  }
  const frames = frame % nominalFps;
  const totalSeconds = Math.floor(frame / nominalFps);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60) % 24;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}${dropFrame ? ";" : ":"}${pad2(frames)}`;
}

function targetTrack(contract, kind) {
  return contract.targetTracks.find((track) => track.kind === kind);
}

export function buildDirectRazorExtendScript(contract, cut) {
  const videoTrack = targetTrack(contract, "video");
  const audioTrack = targetTrack(contract, "audio");
  const startTimecode = frameToDisplayTimecode(cut.startFrame, contract.timecodeDisplay);
  const endTimecode = frameToDisplayTimecode(cut.endFrame, contract.timecodeDisplay);
  const secondsPerFrame = contract.timing.secondsPerFrame;
  return `
var seq = app.project.activeSequence;
if (!seq) return __error("No active sequence");
if (app.project.name !== ${JSON.stringify(contract.projectName)}) return __error("Active project changed");
if (seq.name !== ${JSON.stringify(contract.sequenceName)}) return __error("Active sequence changed");
var expectedSequenceId = ${JSON.stringify(contract.sequenceId)};
if (expectedSequenceId && String(seq.sequenceID) !== expectedSequenceId) return __error("Active sequence ID changed");
app.enableQE();
var qseq = qe.project.getActiveSequence();
if (!qseq || qseq.name !== ${JSON.stringify(contract.sequenceName)}) return __error("Active QE sequence changed");
var qv = qseq.getVideoTrackAt(${videoTrack.index});
var qa = qseq.getAudioTrackAt(${audioTrack.index});
if (!qv || !qa) return __error("Target track is unavailable");
var startTc = ${JSON.stringify(startTimecode)};
var endTc = ${JSON.stringify(endTimecode)};
var videoEndReturn = qv.razor(endTc);
var audioEndReturn = qa.razor(endTc);
var videoStartReturn = qv.razor(startTc);
var audioStartReturn = qa.razor(startTc);
$.sleep(120);
var targetNames = ${JSON.stringify(contract.targetClipNames)};
var targetStartFrame = ${cut.startFrame};
var targetEndFrame = ${cut.endFrame};
var secondsPerFrame = ${JSON.stringify(secondsPerFrame)};
var selected = [];
function isTargetName(name) {
  for (var n = 0; n < targetNames.length; n++) if (targetNames[n] === name) return true;
  return false;
}
function frameOf(seconds) { return Math.round(Number(seconds) / secondsPerFrame); }
function clearTracks(tracks) {
  for (var t = 0; t < tracks.numTracks; t++) {
    var track = tracks[t];
    for (var i = 0; i < track.clips.numItems; i++) track.clips[i].setSelected(0, false);
  }
}
function selectExact(track, type, trackIndex) {
  var matched = 0;
  for (var i = 0; i < track.clips.numItems; i++) {
    var clip = track.clips[i];
    if (isTargetName(clip.name) && frameOf(clip.start.seconds) === targetStartFrame && frameOf(clip.end.seconds) === targetEndFrame) {
      clip.setSelected(1, true);
      selected.push({type:type, trackIndex:trackIndex, name:clip.name, start:clip.start.seconds, end:clip.end.seconds, isSelected:clip.isSelected()});
      matched++;
    }
  }
  return matched;
}
clearTracks(seq.videoTracks);
clearTracks(seq.audioTracks);
var videoMatched = selectExact(seq.videoTracks[${videoTrack.index}], "video", ${videoTrack.index});
var audioMatched = selectExact(seq.audioTracks[${audioTrack.index}], "audio", ${audioTrack.index});
if (videoMatched !== 1 || audioMatched !== 1 || selected.length !== 2) {
  return __error("Exact target fragments were not found after Razor: V=" + videoMatched + " A=" + audioMatched);
}
return __result({cutIndex:${cut.index}, startFrame:${cut.startFrame}, endFrame:${cut.endFrame}, startTimecode:startTc, endTimecode:endTc, videoEndReturn:videoEndReturn, audioEndReturn:audioEndReturn, videoStartReturn:videoStartReturn, audioStartReturn:audioStartReturn, selected:selected, selectedCount:selected.length});
`;
}

function frameFromSeconds(value, timing, label) {
  const exact = finiteNumber(value, label) / timing.secondsPerFrame;
  const frame = Math.round(exact);
  assert(
    Math.abs(exact - frame) <= timing.gridToleranceFrames,
    `${label} is not frame-aligned`,
  );
  return frame;
}

function assertExactTargetItems(items, contract, cut, fields, label) {
  assert(Array.isArray(items) && items.length === 2, `${label} must contain exactly 2 items`);
  const expected = new Map(contract.targetTracks.map((track) => [track.key, track]));
  for (const item of items) {
    const kind = String(item[fields.kind] ?? item.type ?? "").toLowerCase();
    const trackIndex = integer(item[fields.trackIndex] ?? item.trackIndex, `${label}.trackIndex`);
    const key = `${kind}:${trackIndex}`;
    assert(expected.has(key), `${label} escaped the authorized V/A tracks`);
    expected.delete(key);
    assert(contract.targetClipNames.includes(String(item.name)), `${label} has an unexpected clip name`);
    if (fields.selected) assert(item[fields.selected] === true, `${label} item is not selected`);
    if (fields.start && fields.end) {
      assert(
        frameFromSeconds(item[fields.start], contract.timing, `${label}.start`) === cut.startFrame &&
          frameFromSeconds(item[fields.end], contract.timing, `${label}.end`) === cut.endFrame,
        `${label} fragment does not match the cut frame range`,
      );
    }
  }
  assert(expected.size === 0, `${label} must contain one video and one audio fragment`);
  return true;
}

export function verifyDirectRazorSelection(payload, contract, cut) {
  assert(isObject(payload), `Cut ${cut.index}: Razor response must be an object`);
  assert(payload.cutIndex === cut.index, `Cut ${cut.index}: Razor response index mismatch`);
  assert(payload.startTimecode === frameToDisplayTimecode(cut.startFrame, contract.timecodeDisplay), `Cut ${cut.index}: start timecode mismatch`);
  assert(payload.endTimecode === frameToDisplayTimecode(cut.endFrame, contract.timecodeDisplay), `Cut ${cut.index}: end timecode mismatch`);
  assert(payload.selectedCount === 2, `Cut ${cut.index}: Razor must select exactly 2 fragments`);
  return assertExactTargetItems(
    payload.selected,
    contract,
    cut,
    {kind: "type", trackIndex: "trackIndex", selected: "isSelected", start: "start", end: "end"},
    `Cut ${cut.index} Razor selection`,
  );
}

export function verifySelectedClipsReadback(payload, contract, cut) {
  return assertExactTargetItems(
    payload,
    contract,
    cut,
    {kind: "trackType", trackIndex: "trackIndex", selected: "selected", start: "startSeconds", end: "endSeconds"},
    `Cut ${cut.index} live selection`,
  );
}

export function verifyDirectRazorRemoval(payload, contract, cut) {
  assert(isObject(payload), `Cut ${cut.index}: removal response must be an object`);
  assert(payload.removed === true, `Cut ${cut.index}: removal did not report removed=true`);
  assert(payload.ripple === true, `Cut ${cut.index}: removal did not report ripple=true`);
  assert(payload.count === 2, `Cut ${cut.index}: removal count must be 2`);
  return assertExactTargetItems(
    payload.items,
    contract,
    cut,
    {kind: "trackType", trackIndex: "trackIndex"},
    `Cut ${cut.index} removal`,
  );
}

export function validateDirectRazorLivePreflight(structure, contract) {
  const normalized = normalizeSequenceStructure(structure, contract.timing);
  assert(normalized.name === contract.sequenceName, "Active sequence name does not match the manifest");
  if (contract.sequenceId) {
    assert(normalized.id === contract.sequenceId, "Active sequence ID does not match the manifest");
  }
  assert(
    normalized.durationFrames === contract.sequenceDurationFrames,
    "Active sequence duration does not match the manifest",
  );
  for (const target of contract.targetTracks) {
    const track = normalized.tracks.find((entry) => entry.key === target.key);
    assert(track, `Target track ${target.key} does not exist`);
    assert(track.isLocked !== true, `Target track ${target.key} is locked`);
    for (const cut of contract.cuts) {
      const matches = track.clips.filter(
        (clip) =>
          contract.targetClipNames.includes(clip.name) &&
          clip.startFrame <= cut.startFrame &&
          clip.endFrame >= cut.endFrame,
      );
      assert(
        matches.length === 1,
        `Cut ${cut.index} is not covered by exactly one authorized clip on ${target.key}`,
      );
    }
  }
  return normalized;
}

export function createDirectRazorExecutionPlan(contract, options = {}) {
  const batchOptions = resolvePremiereCutBatchOptions(options);
  const batchPlan = createReversePremiereCutBatchPlan(contract.cuts, batchOptions.batchSize);
  return Object.freeze({
    dryRun: batchOptions.dryRun,
    resumeSelectedFirst: options.resumeSelectedFirst === true,
    batchSize: batchOptions.batchSize,
    batchPauseMs: batchOptions.batchPauseMs,
    batchCount: batchPlan.batchCount,
    cutCount: batchPlan.cutCount,
    executionCuts: batchPlan.executionCuts,
    batches: batchPlan.batches,
    projectName: contract.projectName,
    sequenceName: contract.sequenceName,
    sequenceId: contract.sequenceId,
    targetTracks: contract.targetTrackKeys,
    targetClipNames: contract.targetClipNames,
    expectedDurationAfterFrames: contract.expectedDurationAfterFrames,
    expectedDurationAfterSeconds: contract.expectedDurationAfterSeconds,
  });
}

function defaultPause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function retryDirectRazorReadOnly({
  read,
  attempts = 3,
  retryPauseMs = 150,
  pause = defaultPause,
} = {}) {
  assert(typeof read === "function", "read must be a function");
  assert(Number.isInteger(attempts) && attempts >= 1, "attempts must be a positive integer");
  assert(Number.isInteger(retryPauseMs) && retryPauseMs >= 0, "retryPauseMs must be a non-negative integer");
  assert(typeof pause === "function", "pause must be a function");
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await read(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await pause(retryPauseMs, attempt);
    }
  }
  throw lastError;
}

function errorReason(error, phase) {
  const code = String(error?.code ?? "").toUpperCase();
  const message = String(error?.message ?? error ?? "");
  if (code === "ETIMEDOUT" || code === "TIMEOUT" || /timed?\s*out|timeout/i.test(message)) {
    return `${phase}_timeout`;
  }
  return `${phase}_failed`;
}

async function diagnosticRead(adapter, context) {
  const diagnostic = {structure: null, structureError: null, selection: null, selectionError: null};
  try {
    diagnostic.structure = await adapter.readStructure({...context, diagnostic: true});
  } catch (error) {
    diagnostic.structureError = serializeCutBatchError(error);
  }
  try {
    diagnostic.selection = await adapter.readSelectedClips({...context, phase: "diagnostic"});
  } catch (error) {
    diagnostic.selectionError = serializeCutBatchError(error);
  }
  return diagnostic;
}

function stopped(state, batch, cut, phase, reason, error = null, diagnostic = null) {
  return {
    ...state,
    ok: false,
    outcome:
      state.completedCutCount > 0 || state.confirmedRemovalCount > 0
        ? "partially_completed"
        : "stopped",
    stop: {
      stopped: true,
      beforeNextWrite: true,
      beforeNextBatch: true,
      batchNumber: batch?.batchNumber ?? null,
      cutIndex: cut?.index ?? null,
      phase,
      primaryReason: reason,
      error: serializeCutBatchError(error),
      diagnostic,
      writeMayHaveApplied: phase !== "pause",
    },
  };
}

export async function runDirectRazorExecution({
  contract,
  plan,
  adapter,
  initialStructure,
  pause = defaultPause,
  onBatchComplete = async () => {},
}) {
  assert(contract && plan, "contract and plan are required");
  if (plan.dryRun) {
    return {
      ok: true,
      outcome: "dry_run",
      completedCutCount: 0,
      completedBatchCount: 0,
      writeAttemptCount: 0,
      confirmedRemovalCount: 0,
      executionCuts: plan.executionCuts,
      batchCount: plan.batchCount,
      stop: {stopped: false},
    };
  }
  assert(isObject(adapter), "adapter is required for real execution");
  for (const method of ["razorAndSelect", "readSelectedClips", "removeSelectedClips", "readStructure"]) {
    assert(typeof adapter[method] === "function", `adapter.${method} is required`);
  }
  assert(typeof pause === "function", "pause must be a function");
  assert(typeof onBatchComplete === "function", "onBatchComplete must be a function");
  validateDirectRazorLivePreflight(initialStructure, contract);

  const state = {
    completedCutCount: 0,
    completedBatchCount: 0,
    writeAttemptCount: 0,
    confirmedRemovalCount: 0,
    completedCuts: [],
    batchResults: [],
    currentStructure: initialStructure,
  };

  for (const batch of plan.batches) {
    const batchResult = {batchNumber: batch.batchNumber, cuts: [], verification: null};
    for (const cut of batch.cuts) {
      const context = {batch, cut};
      const resumeFromVerifiedSelection = plan.resumeSelectedFirst === true && state.completedCutCount === 0;
      if (!resumeFromVerifiedSelection) {
        const script = buildDirectRazorExtendScript(contract, cut);
        let razorPayload;
        state.writeAttemptCount += 1;
        try {
          razorPayload = await adapter.razorAndSelect({...context, script});
          verifyDirectRazorSelection(razorPayload, contract, cut);
        } catch (error) {
          const diagnostic = await diagnosticRead(adapter, context);
          return stopped(state, batch, cut, "razor", errorReason(error, "razor_write"), error, diagnostic);
        }
      }

      try {
        const selected = await adapter.readSelectedClips({...context, phase: "before_remove"});
        verifySelectedClipsReadback(selected, contract, cut);
      } catch (error) {
        const diagnostic = await diagnosticRead(adapter, context);
        return stopped(state, batch, cut, "selection_readback", "selection_readback_failed", error, diagnostic);
      }

      let removalPayload;
      state.writeAttemptCount += 1;
      try {
        removalPayload = await adapter.removeSelectedClips({...context, ripple: true});
        verifyDirectRazorRemoval(removalPayload, contract, cut);
        state.confirmedRemovalCount += 1;
      } catch (error) {
        const diagnostic = await diagnosticRead(adapter, context);
        return stopped(state, batch, cut, "remove", errorReason(error, "remove_write"), error, diagnostic);
      }

      const completedCuts = [...state.completedCuts, cut];
      state.completedCuts = completedCuts;
      state.completedCutCount += 1;
      batchResult.cuts.push({
        index: cut.index,
        startFrame: cut.startFrame,
        endFrame: cut.endFrame,
        verified: false,
        razorSkippedFromVerifiedSelection: resumeFromVerifiedSelection,
      });
    }

    let postStructure;
    try {
      postStructure = await adapter.readStructure({batch, cut: null, phase: "after_batch"});
    } catch (error) {
      const diagnostic = await diagnosticRead(adapter, {batch, cut: null});
      return stopped(
        state,
        batch,
        null,
        "post_batch_readback",
        "post_batch_readback_failed",
        error,
        diagnostic,
      );
    }
    let invariant;
    try {
      invariant = verifyRippleCutInvariant(initialStructure, postStructure, {
        timing: contract.timing,
        cuts: state.completedCuts,
        targetTracks: contract.targetTrackKeys,
      });
    } catch (error) {
      return stopped(state, batch, null, "invariant", "invariant_verification_failed", error);
    }
    if (invariant.ok !== true) {
      const error = new Error(`Batch ${batch.batchNumber}: ripple invariant failed`);
      error.details = invariant;
      return stopped(state, batch, null, "invariant", "ripple_invariant_failed", error);
    }
    state.currentStructure = postStructure;
    batchResult.verification = invariant;
    for (const cutResult of batchResult.cuts) cutResult.verified = true;

    state.completedBatchCount += 1;
    state.batchResults.push(batchResult);
    await onBatchComplete({
      batchNumber: batch.batchNumber,
      batchCount: plan.batchCount,
      batchCutCount: batch.cutCount,
      completedCutCount: state.completedCutCount,
      totalCutCount: plan.cutCount,
      durationFrames: invariant.actualDurationFrames,
    });
    if (batch.batchNumber < plan.batchCount && plan.batchPauseMs > 0) {
      try {
        await pause(plan.batchPauseMs, batch);
      } catch (error) {
        return stopped(state, batch, null, "pause", "batch_pause_failed", error);
      }
    }
  }

  return {
    ...state,
    ok: true,
    outcome: "completed",
    stop: {stopped: false},
  };
}
