import {createHash, randomUUID} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TICKS_PER_SECOND = 254_016_000_000n;
const FRAME_GRID_TOLERANCE = 0.05;
const SHA256_PATTERN = /^[0-9A-F]{64}$/;

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
  // UXP reports the same Premiere display formats as 100-series enum values,
  // whereas CEP reports the upstream zero-based values. Placement manifests
  // must use the shared canonical code because their final live gate is CEP.
  return rawCode >= 100 && rawCode <= 111 ? rawCode - 100 : rawCode;
}

function fail(message, code = "PREMIERE_PLACEMENT_INPUT_VALIDATION_FAILED", details = null) {
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

export function sha256PlacementJson(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex").toUpperCase();
}

function assertSha256(value, label) {
  const result = requiredString(value, label);
  assert(SHA256_PATTERN.test(result), `${label} must be an uppercase SHA-256 hash`);
  return result;
}

function normalizeTracks(structure, kind) {
  const key = kind === "video" ? "videoTracks" : "audioTracks";
  const countKey = kind === "video" ? "videoTrackCount" : "audioTrackCount";
  assert(Array.isArray(structure[key]), `structure.${key} must be an array`);
  if (structure[countKey] !== undefined && structure[countKey] !== null) {
    assert(
      nonNegativeInteger(structure[countKey], `structure.${countKey}`) === structure[key].length,
      `structure.${countKey} does not match structure.${key}.length`,
    );
  }
  const seen = new Set();
  const indexes = structure[key].map((track, position) => {
    assert(isObject(track), `structure.${key}[${position}] must be an object`);
    const index = nonNegativeInteger(track.index ?? position, `structure.${key}[${position}].index`);
    assert(!seen.has(index), `structure.${key} contains duplicate track index ${index}`);
    seen.add(index);
    assert(Array.isArray(track.clips), `structure.${key}[${position}].clips must be an array`);
    if (track.clipCount !== undefined && track.clipCount !== null) {
      assert(
        nonNegativeInteger(track.clipCount, `structure.${key}[${position}].clipCount`) === track.clips.length,
        `structure.${key}[${position}].clipCount does not match clips.length`,
      );
    }
    return index;
  });
  return indexes;
}

function normalizeCapture(capture) {
  assert(isObject(capture), "capture must be an object");
  const {project, settings, structure} = capture;
  assert(isObject(project), "capture.project must be an object");
  assert(isObject(settings), "capture.settings must be an object");
  assert(isObject(structure), "capture.structure must be an object");

  const projectName = requiredString(project.name, "project.name");
  const projectPath = requiredString(project.path, "project.path");
  const projectId = requiredString(project.id, "project.id");
  const sequenceName = requiredString(structure.name, "structure.name");
  const sequenceId = requiredString(structure.id, "structure.id");
  const sequenceDurationSeconds = finiteNumber(structure.durationSeconds, "structure.durationSeconds");
  assert(sequenceDurationSeconds > 0, "structure.durationSeconds must be positive");

  assert(
    requiredString(project.activeSequence?.name, "project.activeSequence.name") === sequenceName,
    "project active sequence name disagrees with structure",
  );
  assert(
    requiredString(project.activeSequence?.id, "project.activeSequence.id") === sequenceId,
    "project active sequence ID disagrees with structure",
  );
  assert(requiredString(settings.name, "settings.name") === sequenceName, "settings name disagrees with structure");
  assert(requiredString(settings.id, "settings.id") === sequenceId, "settings ID disagrees with structure");

  const ticksNumber = finiteNumber(settings.ticksPerFrame, "settings.ticksPerFrame");
  assert(Number.isSafeInteger(ticksNumber) && ticksNumber > 0, "settings.ticksPerFrame must be a positive safe integer");
  let ticksPerFrame = BigInt(ticksNumber).toString();
  if (settings.timebase !== undefined && settings.timebase !== null && String(settings.timebase).trim()) {
    const timebase = requiredString(settings.timebase, "settings.timebase");
    assert(/^\d+$/.test(timebase) && BigInt(timebase) > 0n, "settings.timebase must be a positive integer");
    assert(BigInt(timebase).toString() === ticksPerFrame, "settings.timebase and ticksPerFrame disagree");
    ticksPerFrame = BigInt(timebase).toString();
  }
  const fps = Number(TICKS_PER_SECOND) / ticksNumber;
  const reportedFps = finiteNumber(settings.frameRate, "settings.frameRate");
  assert(Math.abs(reportedFps - fps) <= 0.002, "settings frameRate and ticksPerFrame disagree");

  const displayCode = canonicalVideoDisplayCode(settings.videoDisplayFormat);
  const display = VIDEO_DISPLAY_FORMATS.get(displayCode);
  assert(
    display,
    `Unsupported Premiere video display format: ${displayCode}`,
    "PREMIERE_PLACEMENT_UNSUPPORTED_DISPLAY_FORMAT",
  );
  assert(
    display.allowedFps.some((allowed) => Math.abs(allowed - fps) <= 0.002),
    `Video display format '${display.label}' does not match ${fps} fps`,
    "PREMIERE_PLACEMENT_DISPLAY_FPS_MISMATCH",
  );
  const timecodeDisplay = {
    code: displayCode,
    label: display.label,
    nominalFps: display.nominalFps,
    dropFrame: display.dropFrame,
  };

  const exactDurationFrames = sequenceDurationSeconds * fps;
  const onGrid = Math.abs(exactDurationFrames - Math.round(exactDurationFrames)) <= FRAME_GRID_TOLERANCE;
  // 2026-09-27: a sequence that ends on a sample-accurate audio clip (the user's BGM tail placed off the video grid) has an
  // off-grid duration. Accept it only when an audio clip ends exactly there. Overlays are video, so the usable length is the
  // last whole frame (floor); the capture marks the case with sequenceDurationAudioTail so the placement gate applies the same rule.
  const audioTail = !onGrid && Array.isArray(structure.audioTracks) && structure.audioTracks.some((track) =>
    Array.isArray(track?.clips) && track.clips.some((clip) => Math.abs(Number(clip?.endSeconds) - sequenceDurationSeconds) <= 0.0005));
  assert(
    onGrid || audioTail,
    "structure.durationSeconds is not aligned to the active sequence frame grid",
    "PREMIERE_PLACEMENT_DURATION_NOT_FRAME_ALIGNED",
  );
  const sequenceDurationFrames = onGrid ? Math.round(exactDurationFrames) : Math.floor(exactDurationFrames);
  const videoTrackIndexes = normalizeTracks(structure, "video");
  const audioTrackIndexes = normalizeTracks(structure, "audio");

  const identity = {
    projectName,
    projectPath,
    projectId,
    sequenceName,
    sequenceId,
    sequenceDurationSeconds,
    sequenceDurationFrames,
    ...(audioTail ? {sequenceDurationAudioTail: true} : {}),
    fps,
    ticksPerFrame,
    timing: {
      fps,
      ticksPerFrame,
      frameDurationSeconds: ticksNumber / Number(TICKS_PER_SECOND),
    },
    timecodeDisplay,
    videoTrackIndexes,
    audioTrackIndexes,
  };
  const stableEvidence = {
    project: {
      name: projectName,
      path: projectPath,
      id: projectId,
      activeSequence: {name: sequenceName, id: sequenceId},
    },
    settings: {
      name: sequenceName,
      id: sequenceId,
      frameRate: reportedFps,
      ticksPerFrame,
      timebase: ticksPerFrame,
      videoDisplayFormat: displayCode,
    },
    structure,
  };
  return {identity, stableEvidence, structure};
}

function captureHashBase(identity, structureSha256) {
  return {
    projectName: identity.projectName,
    projectPath: identity.projectPath,
    projectId: identity.projectId,
    sequenceName: identity.sequenceName,
    sequenceId: identity.sequenceId,
    sequenceDurationSeconds: identity.sequenceDurationSeconds,
    sequenceDurationFrames: identity.sequenceDurationFrames,
    fps: identity.fps,
    ticksPerFrame: identity.ticksPerFrame,
    timecodeDisplay: identity.timecodeDisplay,
    videoTrackIndexes: identity.videoTrackIndexes,
    audioTrackIndexes: identity.audioTrackIndexes,
    structureSha256,
  };
}

function sharedOutputBase({identity, generatedAt, captureSha256, structureSha256}) {
  return {
    schemaVersion: 1,
    generatedAt,
    source: "premiere-uxp-read-only-placement-capture",
    projectName: identity.projectName,
    projectPath: identity.projectPath,
    projectId: identity.projectId,
    sequenceName: identity.sequenceName,
    sequenceId: identity.sequenceId,
    sequenceDurationSeconds: identity.sequenceDurationSeconds,
    sequenceDurationFrames: identity.sequenceDurationFrames,
    ...(identity.sequenceDurationAudioTail ? {sequenceDurationAudioTail: true} : {}),
    fps: identity.fps,
    ticksPerFrame: identity.ticksPerFrame,
    timing: identity.timing,
    timecodeDisplay: identity.timecodeDisplay,
    videoTrackIndexes: identity.videoTrackIndexes,
    audioTrackIndexes: identity.audioTrackIndexes,
    structureSha256,
    captureSha256,
    timelineWrites: 0,
    projectSaved: false,
  };
}

function withoutBundleSha256(value) {
  const result = {...value};
  delete result.bundleSha256;
  return result;
}

function compareSharedMetadata(live, structureDocument) {
  const fields = [
    "schemaVersion",
    "generatedAt",
    "source",
    "projectName",
    "projectPath",
    "projectId",
    "sequenceName",
    "sequenceId",
    "sequenceDurationSeconds",
    "sequenceDurationFrames",
    "sequenceDurationAudioTail",
    "fps",
    "ticksPerFrame",
    "structureSha256",
    "captureSha256",
    "timelineWrites",
    "projectSaved",
  ];
  for (const field of fields) {
    assert(
      canonicalJson(live[field]) === canonicalJson(structureDocument[field]),
      `Placement capture files disagree on ${field}`,
      "PREMIERE_PLACEMENT_BUNDLE_CHANGED",
    );
  }
  for (const field of ["timing", "timecodeDisplay", "videoTrackIndexes", "audioTrackIndexes"]) {
    assert(
      canonicalJson(live[field]) === canonicalJson(structureDocument[field]),
      `Placement capture files disagree on ${field}`,
      "PREMIERE_PLACEMENT_BUNDLE_CHANGED",
    );
  }
}

export function buildPremierePlacementInputs({
  firstCapture,
  secondCapture,
  generatedAt = new Date().toISOString(),
} = {}) {
  const first = normalizeCapture(firstCapture);
  const second = normalizeCapture(secondCapture);
  const firstCaptureEvidenceSha256 = sha256PlacementJson(first.stableEvidence);
  const secondCaptureEvidenceSha256 = sha256PlacementJson(second.stableEvidence);
  assert(
    firstCaptureEvidenceSha256 === secondCaptureEvidenceSha256,
    "Premiere project, active sequence, timing, or full sequence structure changed during placement capture",
    "PREMIERE_PLACEMENT_CAPTURE_CHANGED",
    {firstSha256: firstCaptureEvidenceSha256, secondSha256: secondCaptureEvidenceSha256},
  );

  const structureSha256 = sha256PlacementJson(second.structure);
  const captureSha256 = sha256PlacementJson(captureHashBase(second.identity, structureSha256));
  const shared = sharedOutputBase({
    identity: second.identity,
    generatedAt: requiredString(generatedAt, "generatedAt"),
    captureSha256,
    structureSha256,
  });
  const liveBase = {...shared};
  const structureBase = {...shared, structure: second.structure};
  const bundleSha256 = sha256PlacementJson({live: liveBase, structure: structureBase});

  return Object.freeze({
    live: Object.freeze({...liveBase, bundleSha256}),
    structure: Object.freeze({...structureBase, bundleSha256}),
    rawStructure: second.structure,
    captureSha256,
    structureSha256,
    bundleSha256,
  });
}

export function validatePremierePlacementInputs({live, structure: structureDocument} = {}) {
  assert(isObject(live), "live must be an object");
  assert(isObject(structureDocument), "structure document must be an object");
  assert(live.schemaVersion === 1, "live.schemaVersion must be 1");
  assert(structureDocument.schemaVersion === 1, "structure.schemaVersion must be 1");
  assert(live.source === "premiere-uxp-read-only-placement-capture", "Unsupported placement capture source");
  assert(structureDocument.source === live.source, "Placement capture sources disagree");
  assert(live.timelineWrites === 0 && structureDocument.timelineWrites === 0, "Placement capture must be read-only");
  assert(live.projectSaved === false && structureDocument.projectSaved === false, "Placement capture must not save Premiere");
  assert(isObject(structureDocument.structure), "structure.json must contain the raw top-level structure object");
  compareSharedMetadata(live, structureDocument);

  const liveBundleSha256 = assertSha256(live.bundleSha256, "live.bundleSha256");
  const structureBundleSha256 = assertSha256(structureDocument.bundleSha256, "structure.bundleSha256");
  assert(
    liveBundleSha256 === structureBundleSha256,
    "Placement capture bundle hashes disagree",
    "PREMIERE_PLACEMENT_BUNDLE_CHANGED",
  );
  const calculatedBundleSha256 = sha256PlacementJson({
    live: withoutBundleSha256(live),
    structure: withoutBundleSha256(structureDocument),
  });
  assert(
    calculatedBundleSha256 === liveBundleSha256,
    "Placement capture bundle content changed after capture",
    "PREMIERE_PLACEMENT_BUNDLE_CHANGED",
  );

  const structureSha256 = assertSha256(live.structureSha256, "live.structureSha256");
  assert(
    sha256PlacementJson(structureDocument.structure) === structureSha256,
    "Placement capture raw structure changed after capture",
    "PREMIERE_PLACEMENT_BUNDLE_CHANGED",
  );
  const captureSha256 = assertSha256(live.captureSha256, "live.captureSha256");
  const identity = normalizeCapture({
    project: {
      name: live.projectName,
      path: live.projectPath,
      id: live.projectId,
      activeSequence: {name: live.sequenceName, id: live.sequenceId},
    },
    settings: {
      name: live.sequenceName,
      id: live.sequenceId,
      frameRate: live.fps,
      ticksPerFrame: live.ticksPerFrame,
      timebase: live.ticksPerFrame,
      videoDisplayFormat: live.timecodeDisplay?.code,
    },
    structure: structureDocument.structure,
  }).identity;
  const calculatedCaptureSha256 = sha256PlacementJson(captureHashBase(identity, structureSha256));
  assert(
    calculatedCaptureSha256 === captureSha256,
    "Placement capture identity hash changed after capture",
    "PREMIERE_PLACEMENT_BUNDLE_CHANGED",
  );
  assert(
    canonicalJson(live.timecodeDisplay) === canonicalJson(identity.timecodeDisplay) &&
      canonicalJson(live.timing) === canonicalJson(identity.timing) &&
      canonicalJson(live.videoTrackIndexes) === canonicalJson(identity.videoTrackIndexes) &&
      canonicalJson(live.audioTrackIndexes) === canonicalJson(identity.audioTrackIndexes) &&
      Number(live.sequenceDurationFrames) === identity.sequenceDurationFrames,
    "Placement capture normalized identity disagrees with raw structure/timing",
    "PREMIERE_PLACEMENT_BUNDLE_CHANGED",
  );

  return Object.freeze({
    live,
    structure: structureDocument,
    rawStructure: structureDocument.structure,
    identity: Object.freeze({
      ...identity,
      source: live.source,
      generatedAt: live.generatedAt,
      captureSha256,
      structureSha256,
      bundleSha256: liveBundleSha256,
      timelineWrites: 0,
      projectSaved: false,
    }),
    captureSha256,
    structureSha256,
    bundleSha256: liveBundleSha256,
  });
}

export function loadPremierePlacementInputs({captureDir} = {}) {
  const resolvedCaptureDir = path.resolve(requiredString(captureDir, "captureDir"));
  const livePath = path.join(resolvedCaptureDir, "live.json");
  const structurePath = path.join(resolvedCaptureDir, "structure.json");
  let live;
  let structure;
  try {
    live = JSON.parse(fs.readFileSync(livePath, "utf8"));
    structure = JSON.parse(fs.readFileSync(structurePath, "utf8"));
  } catch (error) {
    fail(
      `Unable to load placement capture bundle from ${resolvedCaptureDir}: ${error.message}`,
      "PREMIERE_PLACEMENT_BUNDLE_UNREADABLE",
    );
  }
  return Object.freeze({
    captureDir: resolvedCaptureDir,
    livePath,
    structurePath,
    ...validatePremierePlacementInputs({live, structure}),
  });
}

export function writePremierePlacementInputsAtomically({outDir, bundle} = {}) {
  const resolvedOutDir = path.resolve(requiredString(outDir, "outDir"));
  validatePremierePlacementInputs({live: bundle?.live, structure: bundle?.structure});
  assert(
    !fs.existsSync(resolvedOutDir),
    `Output directory already exists: ${resolvedOutDir}`,
    "PREMIERE_PLACEMENT_OUTPUT_EXISTS",
  );
  const parent = path.dirname(resolvedOutDir);
  fs.mkdirSync(parent, {recursive: true});
  const stagingDir = path.join(parent, `.${path.basename(resolvedOutDir)}.tmp-${process.pid}-${randomUUID()}`);
  const liveText = `${JSON.stringify(bundle.live, null, 2)}\n`;
  const structureText = `${JSON.stringify(bundle.structure, null, 2)}\n`;
  try {
    fs.mkdirSync(stagingDir, {recursive: false});
    fs.writeFileSync(path.join(stagingDir, "live.json"), liveText, {encoding: "utf8", flag: "wx"});
    fs.writeFileSync(path.join(stagingDir, "structure.json"), structureText, {encoding: "utf8", flag: "wx"});
    fs.renameSync(stagingDir, resolvedOutDir);
  } catch (error) {
    fs.rmSync(stagingDir, {recursive: true, force: true});
    throw error;
  }
  return Object.freeze({
    outDir: resolvedOutDir,
    livePath: path.join(resolvedOutDir, "live.json"),
    structurePath: path.join(resolvedOutDir, "structure.json"),
    liveSha256: createHash("sha256").update(liveText, "utf8").digest("hex").toUpperCase(),
    structureFileSha256: createHash("sha256").update(structureText, "utf8").digest("hex").toUpperCase(),
    captureSha256: bundle.captureSha256,
    structureSha256: bundle.structureSha256,
    bundleSha256: bundle.bundleSha256,
  });
}

export const PREMIERE_PLACEMENT_VIDEO_DISPLAY_FORMATS = Object.freeze(
  Object.fromEntries([...VIDEO_DISPLAY_FORMATS].map(([code, value]) => [code, {...value}]))
);
