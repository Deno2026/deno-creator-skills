import {createHash, randomUUID} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TICKS_PER_SECOND = 254_016_000_000n;
const GRID_TOLERANCE_FRAMES = 0.05;

const VIDEO_DISPLAY_FORMATS = new Map([
  [0, {label: "24 Timecode", nominalFps: 24, dropFrame: false, allowedFps: [24, 24_000 / 1_001]}],
  [1, {label: "25 Timecode", nominalFps: 25, dropFrame: false, allowedFps: [25]}],
  [2, {label: "29.97 Drop-frame", nominalFps: 30, dropFrame: true, allowedFps: [30_000 / 1_001]}],
  [3, {label: "29.97 Non-drop-frame", nominalFps: 30, dropFrame: false, allowedFps: [30_000 / 1_001]}],
  [4, {label: "30 Timecode", nominalFps: 30, dropFrame: false, allowedFps: [30]}],
  [5, {label: "50 Timecode", nominalFps: 50, dropFrame: false, allowedFps: [50]}],
  [6, {label: "59.94 Drop-frame", nominalFps: 60, dropFrame: true, allowedFps: [60_000 / 1_001]}],
  [7, {label: "59.94 Non-drop-frame", nominalFps: 60, dropFrame: false, allowedFps: [60_000 / 1_001]}],
  [8, {label: "60 Timecode", nominalFps: 60, dropFrame: false, allowedFps: [60]}],
]);

function canonicalVideoDisplayCode(value, label = "settings.videoDisplayFormat") {
  const rawCode = nonNegativeInteger(value, label);
  // Premiere UXP 26.3 returns SequenceSettings display enum values in the
  // 100-series (for example 104 for 30 Timecode), while CEP and the upstream
  // MCP schema use the equivalent zero-based values (4 for 30 Timecode).
  // Normalize at the capture boundary so UXP capture and CEP live read-back
  // share one stable manifest identity.
  return rawCode >= 100 && rawCode <= 111 ? rawCode - 100 : rawCode;
}

function fail(message, code = "DIRECT_CUT_INPUT_VALIDATION_FAILED", details = null) {
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

function requiredString(value, label) {
  const result = String(value ?? "").trim();
  assert(result.length > 0, `${label} is required`);
  return result;
}

function optionalString(value) {
  return String(value ?? "").trim();
}

function finiteNumber(value, label) {
  assert(value !== "" && value !== null && value !== undefined, `${label} must be a finite number`);
  const result = Number(value);
  assert(Number.isFinite(result), `${label} must be a finite number`);
  return result;
}

function nonNegativeInteger(value, label) {
  const result = Number(value);
  assert(Number.isInteger(result) && result >= 0, `${label} must be a non-negative integer`);
  return result;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Json(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex").toUpperCase();
}

function normalizeWindowsPath(value) {
  return path.resolve(String(value ?? "")).replaceAll("/", "\\").toLocaleLowerCase("en-US");
}

function closeSeconds(left, right, toleranceSeconds) {
  return Math.abs(Number(left) - Number(right)) <= toleranceSeconds;
}

function secondsToAlignedFrame(seconds, timing, label) {
  const value = finiteNumber(seconds, label);
  const exact = value * timing.fps;
  const rounded = Math.round(exact);
  assert(
    Math.abs(exact - rounded) <= GRID_TOLERANCE_FRAMES,
    `${label} is not aligned to the active sequence frame grid`,
    "DIRECT_CUT_INPUT_NOT_FRAME_ALIGNED",
    {seconds: value, fps: timing.fps, exactFrame: exact},
  );
  return rounded;
}

function normalizedTargetSpec(target = {}) {
  assert(isObject(target), "target must be an object");
  const name = optionalString(target.name ?? target.targetName ?? target.displayName);
  const timelineStartSeconds = target.timelineStartSeconds === undefined || target.timelineStartSeconds === null
    ? null
    : finiteNumber(target.timelineStartSeconds, "target.timelineStartSeconds");
  const videoTrackIndex = target.videoTrackIndex === undefined || target.videoTrackIndex === null
    ? null
    : nonNegativeInteger(target.videoTrackIndex, "target.videoTrackIndex");
  const audioTrackIndex = target.audioTrackIndex === undefined || target.audioTrackIndex === null
    ? null
    : nonNegativeInteger(target.audioTrackIndex, "target.audioTrackIndex");
  assert(
    Boolean(name) || (videoTrackIndex !== null && audioTrackIndex !== null),
    "Specify an exact target name or both video/audio track indexes",
    "DIRECT_CUT_TARGET_REQUIRED",
  );
  return {name, timelineStartSeconds, videoTrackIndex, audioTrackIndex};
}

function normalizeTrackCollection(structure, kind) {
  const key = kind === "video" ? "videoTracks" : "audioTracks";
  assert(Array.isArray(structure?.[key]), `sequence structure is missing ${key}`);
  return structure[key].map((track, position) => {
    const index = nonNegativeInteger(track?.index ?? position, `${key}[${position}].index`);
    assert(Array.isArray(track?.clips), `${key}[${position}].clips must be an array`);
    if (track.clipCount !== undefined && track.clipCount !== null) {
      assert(Number(track.clipCount) === track.clips.length, `${key}[${position}].clipCount mismatch`);
    }
    return {...track, index};
  });
}

function targetCandidates(structure, kind, target) {
  const tracks = normalizeTrackCollection(structure, kind);
  const requestedIndex = kind === "video" ? target.videoTrackIndex : target.audioTrackIndex;
  const eligibleTracks = requestedIndex === null
    ? tracks
    : tracks.filter((track) => track.index === requestedIndex);
  if (requestedIndex !== null) {
    assert(
      eligibleTracks.length === 1,
      `${kind} track ${requestedIndex} does not exist exactly once`,
      "DIRECT_CUT_TARGET_TRACK_MISSING",
    );
  }

  const candidates = [];
  for (const track of eligibleTracks) {
    for (let position = 0; position < track.clips.length; position += 1) {
      const clip = track.clips[position];
      if (target.name && String(clip?.name ?? "") !== target.name) continue;
      if (
        target.timelineStartSeconds !== null
        && !closeSeconds(clip?.startSeconds, target.timelineStartSeconds, 1e-6)
      ) continue;
      candidates.push({
        kind,
        trackIndex: track.index,
        clipIndex: nonNegativeInteger(clip?.index ?? position, `${kind} clip index`),
        nodeId: requiredString(clip?.nodeId, `${kind} target clip nodeId`),
        name: requiredString(clip?.name, `${kind} target clip name`),
        clip,
      });
    }
  }
  return candidates;
}

export function selectDirectCutTargetDescriptors(structure, targetInput) {
  assert(isObject(structure), "sequence structure must be an object");
  const target = normalizedTargetSpec(targetInput);
  const video = targetCandidates(structure, "video", target);
  const audio = targetCandidates(structure, "audio", target);
  assert(
    video.length === 1,
    `Target must resolve to exactly one video clip; found ${video.length}`,
    "DIRECT_CUT_TARGET_AMBIGUOUS",
    {kind: "video", target, matches: video.map(({trackIndex, clipIndex, nodeId, name}) => ({trackIndex, clipIndex, nodeId, name}))},
  );
  assert(
    audio.length === 1,
    `Target must resolve to exactly one audio clip; found ${audio.length}`,
    "DIRECT_CUT_TARGET_AMBIGUOUS",
    {kind: "audio", target, matches: audio.map(({trackIndex, clipIndex, nodeId, name}) => ({trackIndex, clipIndex, nodeId, name}))},
  );
  return Object.freeze({target: Object.freeze(target), video: Object.freeze(video[0]), audio: Object.freeze(audio[0])});
}

function clipProperty(properties, nodeId, label) {
  const value = properties instanceof Map ? properties.get(nodeId) : properties?.[nodeId];
  assert(isObject(value), `${label} properties are missing for node ${nodeId}`, "DIRECT_CUT_TARGET_PROPERTIES_MISSING");
  return value;
}

function normalizeCapture(capture, targetInput) {
  assert(isObject(capture), "capture must be an object");
  const project = capture.project;
  const settings = capture.settings;
  const structure = capture.structure;
  assert(isObject(project), "capture.project must be an object");
  assert(isObject(settings), "capture.settings must be an object");
  assert(isObject(structure), "capture.structure must be an object");

  const projectName = requiredString(project.name, "project.name");
  const projectPath = optionalString(project.path);
  const projectId = optionalString(project.id);
  const sequenceName = requiredString(structure.name, "structure.name");
  const sequenceId = requiredString(structure.id, "structure.id");
  const sequenceDurationSeconds = finiteNumber(structure.durationSeconds, "structure.durationSeconds");
  assert(sequenceDurationSeconds > 0, "structure.durationSeconds must be positive");
  assert(project.activeSequence?.name === sequenceName, "project active sequence name disagrees with structure");
  assert(String(project.activeSequence?.id ?? "") === sequenceId, "project active sequence ID disagrees with structure");
  assert(settings.name === sequenceName, "sequence settings name disagrees with structure");
  assert(String(settings.id ?? "") === sequenceId, "sequence settings ID disagrees with structure");

  const ticksValue = finiteNumber(settings.ticksPerFrame, "settings.ticksPerFrame");
  assert(Number.isInteger(ticksValue) && ticksValue > 0, "settings.ticksPerFrame must be a positive integer");
  let ticksPerFrame = BigInt(ticksValue).toString();
  const timebase = optionalString(settings.timebase);
  if (timebase) {
    assert(/^\d+$/.test(timebase) && BigInt(timebase) > 0n, "settings.timebase must be a positive integer");
    const exactTimebase = BigInt(timebase).toString();
    assert(exactTimebase === ticksPerFrame, "settings.timebase and ticksPerFrame disagree");
    ticksPerFrame = exactTimebase;
  }
  const fps = Number(TICKS_PER_SECOND) / ticksValue;
  const reportedFps = finiteNumber(settings.frameRate, "settings.frameRate");
  assert(Math.abs(reportedFps - fps) <= 0.002, "settings frameRate and ticksPerFrame disagree");
  const timing = {fps, ticksPerFrame, frameDurationSeconds: ticksValue / Number(TICKS_PER_SECOND)};
  secondsToAlignedFrame(sequenceDurationSeconds, timing, "structure.durationSeconds");

  const displayCode = canonicalVideoDisplayCode(settings.videoDisplayFormat);
  const display = VIDEO_DISPLAY_FORMATS.get(displayCode);
  assert(
    display,
    `Video display format ${displayCode} cannot be used by the direct Razor timecode contract`,
    "DIRECT_CUT_UNSUPPORTED_DISPLAY_FORMAT",
  );
  assert(
    display.allowedFps.some((allowed) => Math.abs(allowed - fps) <= 0.002),
    `Video display format '${display.label}' does not match ${fps} fps`,
    "DIRECT_CUT_DISPLAY_FPS_MISMATCH",
  );
  const timecodeDisplay = {
    code: displayCode,
    label: display.label,
    nominalFps: display.nominalFps,
    dropFrame: display.dropFrame,
  };

  const descriptors = selectDirectCutTargetDescriptors(structure, targetInput);
  const video = {...descriptors.video.clip, ...clipProperty(capture.clipProperties, descriptors.video.nodeId, "video")};
  const audio = {...descriptors.audio.clip, ...clipProperty(capture.clipProperties, descriptors.audio.nodeId, "audio")};
  const descriptorPairs = [[descriptors.video, video, "video"], [descriptors.audio, audio, "audio"]];
  for (const [descriptor, clip, label] of descriptorPairs) {
    assert(String(clip.nodeId ?? "") === descriptor.nodeId, `${label} property nodeId changed`);
    assert(String(clip.name ?? "") === descriptor.name, `${label} property name changed`);
    assert(Number(clip.trackIndex) === descriptor.trackIndex, `${label} property track index changed`);
    assert(Number(clip.clipIndex) === descriptor.clipIndex, `${label} property clip index changed`);
  }

  return {
    project: {name: projectName, path: projectPath, id: projectId, activeSequence: {name: sequenceName, id: sequenceId}},
    settings: {
      name: sequenceName,
      id: sequenceId,
      frameRate: reportedFps,
      ticksPerFrame,
      ...(timebase ? {timebase} : {}),
      videoDisplayFormat: displayCode,
    },
    structure,
    descriptors,
    clips: {video, audio},
    identity: {projectName, projectPath, projectId, sequenceName, sequenceId, sequenceDurationSeconds, timing, timecodeDisplay},
  };
}

function normalizeMediaEvidence(mediaPath, statFunction) {
  const resolved = path.resolve(mediaPath);
  let stat;
  try {
    stat = statFunction(resolved);
  } catch (error) {
    fail(`Target media is missing or unreadable: ${resolved}`, "DIRECT_CUT_TARGET_MEDIA_MISSING", {cause: error.message});
  }
  assert(stat?.isFile?.() === true, `Target media is not a file: ${resolved}`, "DIRECT_CUT_TARGET_MEDIA_MISSING");
  return {
    path: resolved,
    sizeBytes: Number(stat.size),
    mtimeMs: Math.trunc(Number(stat.mtimeMs)),
  };
}

function validateLinkedTarget(normalized, statFunction) {
  const {video, audio} = normalized.clips;
  const {timing} = normalized.identity;
  const toleranceSeconds = timing.frameDurationSeconds * GRID_TOLERANCE_FRAMES;
  assert(video.name === audio.name, "Linked V/A target display names do not match", "DIRECT_CUT_TARGET_LINK_MISMATCH");
  assert(
    !normalized.descriptors.target.name || video.name === normalized.descriptors.target.name,
    "Resolved target display name is not the requested exact name",
    "DIRECT_CUT_TARGET_LINK_MISMATCH",
  );

  for (const [label, clip] of [["video", video], ["audio", audio]]) {
    for (const field of ["startSeconds", "endSeconds", "durationSeconds", "inPointSeconds", "outPointSeconds"]) {
      finiteNumber(clip[field], `${label}.${field}`);
    }
    assert(Number(clip.endSeconds) > Number(clip.startSeconds), `${label} target has an empty interval`);
    assert(
      closeSeconds(Number(clip.endSeconds) - Number(clip.startSeconds), clip.durationSeconds, toleranceSeconds),
      `${label} target duration disagrees with timeline interval`,
      "DIRECT_CUT_TARGET_INTERVAL_MISMATCH",
    );
    assert(
      closeSeconds(Number(clip.outPointSeconds) - Number(clip.inPointSeconds), clip.durationSeconds, toleranceSeconds),
      `${label} target source interval disagrees with timeline duration`,
      "DIRECT_CUT_TARGET_INTERVAL_MISMATCH",
    );
    assert(Number(clip.speed ?? 1) === 1, `${label} target speed must be exactly 1`, "DIRECT_CUT_TARGET_SPEED_UNSUPPORTED");
    assert(clip.reverse !== true, `${label} target cannot be reversed`, "DIRECT_CUT_TARGET_SPEED_UNSUPPORTED");
    secondsToAlignedFrame(clip.startSeconds, timing, `${label}.startSeconds`);
    secondsToAlignedFrame(clip.endSeconds, timing, `${label}.endSeconds`);
  }

  for (const field of ["startSeconds", "endSeconds", "inPointSeconds", "outPointSeconds"]) {
    assert(
      closeSeconds(video[field], audio[field], toleranceSeconds),
      `Linked V/A target ${field} values do not match`,
      "DIRECT_CUT_TARGET_INTERVAL_MISMATCH",
    );
  }

  const videoMediaPath = requiredString(video.mediaPath ?? video.projectItem?.mediaPath, "video.mediaPath");
  const audioMediaPath = requiredString(audio.mediaPath ?? audio.projectItem?.mediaPath, "audio.mediaPath");
  assert(
    video.projectItem?.offline !== true && audio.projectItem?.offline !== true,
    "Linked V/A target is offline in Premiere",
    "DIRECT_CUT_TARGET_MEDIA_MISSING",
  );
  assert(
    normalizeWindowsPath(videoMediaPath) === normalizeWindowsPath(audioMediaPath),
    "Linked V/A target media paths do not match",
    "DIRECT_CUT_TARGET_SOURCE_MISMATCH",
  );
  const videoProjectItemId = requiredString(
    video.projectItemId ?? video.projectItem?.id ?? video.projectItem?.nodeId,
    "video.projectItemId",
  );
  const audioProjectItemId = requiredString(
    audio.projectItemId ?? audio.projectItem?.id ?? audio.projectItem?.nodeId,
    "audio.projectItemId",
  );
  assert(
    videoProjectItemId === audioProjectItemId,
    "Linked V/A target project item IDs do not match",
    "DIRECT_CUT_TARGET_SOURCE_MISMATCH",
  );

  const mediaEvidence = normalizeMediaEvidence(videoMediaPath, statFunction);
  return {
    name: video.name,
    videoTrackIndex: normalized.descriptors.video.trackIndex,
    audioTrackIndex: normalized.descriptors.audio.trackIndex,
    videoClipIndex: normalized.descriptors.video.clipIndex,
    audioClipIndex: normalized.descriptors.audio.clipIndex,
    videoNodeId: normalized.descriptors.video.nodeId,
    audioNodeId: normalized.descriptors.audio.nodeId,
    projectItemNodeId: videoProjectItemId,
    timelineStartSeconds: Number(video.startSeconds),
    timelineEndSeconds: Number(video.endSeconds),
    sourceInSeconds: Number(video.inPointSeconds),
    sourceOutSeconds: Number(video.outPointSeconds),
    mediaEvidence,
  };
}

function stableCaptureEvidence(normalized) {
  return {
    project: normalized.project,
    settings: normalized.settings,
    structure: normalized.structure,
    target: normalized.descriptors.target,
    targetDescriptors: {
      video: normalized.descriptors.video,
      audio: normalized.descriptors.audio,
    },
    targetClipProperties: normalized.clips,
  };
}

export function buildPremiereDirectCutInputs({
  firstCapture,
  secondCapture,
  target,
  generatedAt = new Date().toISOString(),
  statMedia = fs.statSync,
} = {}) {
  assert(typeof statMedia === "function", "statMedia must be a function");
  const first = normalizeCapture(firstCapture, target);
  const second = normalizeCapture(secondCapture, target);
  const firstEvidence = stableCaptureEvidence(first);
  const secondEvidence = stableCaptureEvidence(second);
  const firstHash = sha256Json(firstEvidence);
  const secondHash = sha256Json(secondEvidence);
  assert(
    firstHash === secondHash,
    "Premiere project, active sequence, timing, target, or timeline changed during capture",
    "DIRECT_CUT_CAPTURE_CHANGED",
    {firstSha256: firstHash, secondSha256: secondHash},
  );

  const binding = validateLinkedTarget(second, statMedia);
  const mediaEvidenceAgain = normalizeMediaEvidence(binding.mediaEvidence.path, statMedia);
  assert(
    canonicalJson(binding.mediaEvidence) === canonicalJson(mediaEvidenceAgain),
    "Target media changed while inputs were being captured",
    "DIRECT_CUT_TARGET_MEDIA_CHANGED",
  );
  const captureSha256 = firstHash;
  const targetBindingSha256 = sha256Json(binding);
  const identity = second.identity;
  const targetTracks = [`V${binding.videoTrackIndex + 1}`, `A${binding.audioTrackIndex + 1}`];

  const liveBase = {
    schemaVersion: 1,
    generatedAt,
    source: "premiere-uxp-read-only-double-capture",
    projectName: identity.projectName,
    projectPath: identity.projectPath,
    projectId: identity.projectId || null,
    sequenceName: identity.sequenceName,
    sequenceId: identity.sequenceId,
    sequenceDurationSeconds: identity.sequenceDurationSeconds,
    fps: identity.timing.fps,
    ticksPerFrame: identity.timing.ticksPerFrame,
    timing: identity.timing,
    timecodeDisplay: identity.timecodeDisplay,
    targetTracks,
    targetClipNames: [binding.name],
    target: binding,
    captureSha256,
    targetBindingSha256,
    projectSaved: false,
    timelineWrites: 0,
  };
  const clipsBase = {
    schemaVersion: 1,
    generatedAt,
    source: "premiere-uxp-read-only-double-capture",
    projectName: identity.projectName,
    sequenceName: identity.sequenceName,
    sequenceId: identity.sequenceId,
    fps: identity.timing.fps,
    ticksPerFrame: identity.timing.ticksPerFrame,
    timing: identity.timing,
    timecodeDisplay: identity.timecodeDisplay,
    targetTracks,
    targetClipNames: [binding.name],
    captureSha256,
    targetBindingSha256,
    clips: [{
      media: binding.mediaEvidence.path,
      sourceIn: binding.sourceInSeconds,
      sourceOut: binding.sourceOutSeconds,
      timelineStart: binding.timelineStartSeconds,
      timelineEnd: binding.timelineEndSeconds,
      targetClipName: binding.name,
      videoTrackIndex: binding.videoTrackIndex,
      audioTrackIndex: binding.audioTrackIndex,
      videoNodeId: binding.videoNodeId,
      audioNodeId: binding.audioNodeId,
      projectItemNodeId: binding.projectItemNodeId,
      mediaEvidence: binding.mediaEvidence,
    }],
  };
  const bundleSha256 = sha256Json({live: liveBase, clips: clipsBase});
  return Object.freeze({
    live: Object.freeze({...liveBase, bundleSha256}),
    clips: Object.freeze({...clipsBase, bundleSha256}),
    captureSha256,
    targetBindingSha256,
    bundleSha256,
  });
}

export function writePremiereDirectCutInputsAtomically({outDir, bundle} = {}) {
  const resolvedOutDir = path.resolve(requiredString(outDir, "outDir"));
  assert(isObject(bundle?.live) && isObject(bundle?.clips), "bundle must contain live and clips objects");
  assert(!fs.existsSync(resolvedOutDir), `Output directory already exists: ${resolvedOutDir}`, "DIRECT_CUT_OUTPUT_EXISTS");
  const parent = path.dirname(resolvedOutDir);
  fs.mkdirSync(parent, {recursive: true});
  const stagingDir = path.join(parent, `.${path.basename(resolvedOutDir)}.tmp-${process.pid}-${randomUUID()}`);
  const liveText = `${JSON.stringify(bundle.live, null, 2)}\n`;
  const clipsText = `${JSON.stringify(bundle.clips, null, 2)}\n`;
  try {
    fs.mkdirSync(stagingDir, {recursive: false});
    fs.writeFileSync(path.join(stagingDir, "live.json"), liveText, {encoding: "utf8", flag: "wx"});
    fs.writeFileSync(path.join(stagingDir, "clips.json"), clipsText, {encoding: "utf8", flag: "wx"});
    fs.renameSync(stagingDir, resolvedOutDir);
  } catch (error) {
    fs.rmSync(stagingDir, {recursive: true, force: true});
    throw error;
  }
  return Object.freeze({
    outDir: resolvedOutDir,
    livePath: path.join(resolvedOutDir, "live.json"),
    clipsPath: path.join(resolvedOutDir, "clips.json"),
    liveSha256: createHash("sha256").update(liveText, "utf8").digest("hex").toUpperCase(),
    clipsSha256: createHash("sha256").update(clipsText, "utf8").digest("hex").toUpperCase(),
    bundleSha256: bundle.bundleSha256,
  });
}

export const PREMIERE_VIDEO_DISPLAY_FORMATS = Object.freeze(
  Object.fromEntries([...VIDEO_DISPLAY_FORMATS].map(([code, value]) => [code, {...value}]))
);
