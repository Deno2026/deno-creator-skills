#!/usr/bin/env node
// 오디오 없는 알파 MOV를 CEP로 작은 직렬 batch 단위 배치한다.
// 프로젝트 저장은 하지 않으며, 매 batch 뒤 최초 baseline 대비 누적 구조를 검증한다.

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

import {
  acquirePremiereCepLock,
  createPremiereCepLifecycle,
  installPremiereCepSignalHandlers,
} from './lib/premiere-cep-lock.mjs';
import {
  PREMIERE_OVERLAY_DEFAULT_BATCH_SIZE,
  createPremiereOverlayBatchPlan,
  resolvePremiereOverlayBatchOptions,
  runPremiereOverlayBatchPlan,
} from './lib/premiere-overlay-batches.mjs';
import {sha256PremiereSequenceFingerprint} from './lib/premiere-sequence-fingerprint.mjs';
import { DEFAULT_MCP_ROOT, DEFAULT_TEMP_DIR } from "../servers/premiere-uxp-mcp/paths.mjs";

const TICKS_PER_SECOND = 254016000000;
const TIME_EPSILON = 0.0005;

function parseArgs(argv) {
  const options = {
    mcpRoot: process.env.PREMIERE_MCP_ROOT || DEFAULT_MCP_ROOT,
    tempDir: process.env.PREMIERE_TEMP_DIR || DEFAULT_TEMP_DIR,
    timeoutMs: 300000,
    dryRun: false,
    batchSize: undefined,
    batchPauseMs: undefined,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--report') options.report = argv[++index];
    else if (value === '--mcp-root') options.mcpRoot = argv[++index];
    else if (value === '--temp-dir') options.tempDir = argv[++index];
    else if (value === '--timeout-ms') options.timeoutMs = Number(argv[++index]);
    else if (value === '--batch-size') options.batchSize = Number(argv[++index]);
    else if (value === '--batch-pause-ms') options.batchPauseMs = Number(argv[++index]);
    else if (value === '--dry-run') options.dryRun = true;
    else if (value === '--help' || value === '-h') options.help = true;
    else positional.push(value);
  }
  return {options, positional};
}

function usage() {
  return [
    'Usage: node scripts/place-overlays-cep.mjs <manifest.json> [options]',
    '',
    'Options:',
    '  --dry-run                 Full preflight only; zero import or placement writes.',
    `  --batch-size <1-20>       Overlays per placement call (default ${PREMIERE_OVERLAY_DEFAULT_BATCH_SIZE}).`,
    '  --batch-pause-ms <ms>     UI yield between verified batches (default 1000; real minimum 250).',
    '  --report <path>           Structured JSON report path.',
    '  --timeout-ms <ms>         Per-call timeout.',
    '',
    'Every real batch imports only its own media, submits one bounded placement call,',
    'then verifies the complete sequence against the original baseline. Writes are never resent.',
  ].join('\n');
}

async function importMcpClient(mcpRoot) {
  const requireFromMcp = createRequire(path.join(mcpRoot, 'package.json'));
  const clientPath = requireFromMcp.resolve('@modelcontextprotocol/sdk/client/index.js');
  const stdioPath = requireFromMcp.resolve('@modelcontextprotocol/sdk/client/stdio.js');
  const [{Client}, {StdioClientTransport}] = await Promise.all([
    import(pathToFileURL(clientPath).href),
    import(pathToFileURL(stdioPath).href),
  ]);
  return {Client, StdioClientTransport};
}

function parsePayload(result) {
  const text = result.content?.find((part) => part.type === 'text')?.text;
  if (text === undefined) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function requireToolPayload(result, name) {
  const payload = parsePayload(result);
  if (
    result?.isError === true ||
    (typeof payload === 'string' && /^(Error|EvalScript Error)/.test(payload))
  ) {
    throw new Error(`${name} failed: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
  }
  return payload;
}

function parseRate(value) {
  const [numerator, denominator] = String(value || '').split('/').map(Number);
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
    return numerator / denominator;
  }
  const direct = Number(value);
  return Number.isFinite(direct) && direct > 0 ? direct : 0;
}

// 오버레이는 무오디오 렌더가 계약이다. 프레임 수와 fps도 배치 전 확정한다.
function probeStreams(file) {
  const result = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries',
      'stream=codec_type,nb_frames,r_frame_rate,avg_frame_rate,duration:format=duration',
      '-of', 'json',
      file,
    ],
    {encoding: 'utf8'},
  );
  if (result.status !== 0) {
    throw new Error(`ffprobe failed for ${file}: ${(result.stderr || '').slice(-200)}`);
  }
  const parsed = JSON.parse(result.stdout);
  const streams = parsed.streams || [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  if (!video) throw new Error(`Overlay has no video stream: ${file}`);
  const frameRate = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate);
  const probedDurationSeconds = Number(video.duration ?? parsed.format?.duration ?? 0);
  let frames = Number(video.nb_frames);
  if (!Number.isInteger(frames) || frames <= 0) {
    frames = Math.round(probedDurationSeconds * frameRate);
  }
  if (!Number.isInteger(frames) || frames <= 0 || !(frameRate > 0)) {
    throw new Error(`Could not determine exact video frames/fps for overlay: ${file}`);
  }
  const durationSeconds = Number.isFinite(probedDurationSeconds) && probedDurationSeconds > 0
    ? probedDurationSeconds
    : frames / frameRate;
  return {
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
    frames,
    frameRate,
    durationSeconds,
  };
}

function secondsToFrame(seconds, fps, label) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  const exact = value * fps;
  const frame = Math.round(exact);
  if (Math.abs(exact - frame) / fps > TIME_EPSILON) {
    throw new Error(`${label} is not frame-aligned at ${fps}fps.`);
  }
  return frame;
}

function stableSeconds(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number.`);
  return Number(parsed.toFixed(9));
}

function optionalStableSeconds(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return stableSeconds(value, label);
}

function normalizeClip(clip, fps, label, frameAlignedTimeline) {
  const timeline = frameAlignedTimeline
    ? (() => {
        const startFrame = secondsToFrame(clip.startSeconds, fps, `${label}.startSeconds`);
        const endFrame = secondsToFrame(clip.endSeconds, fps, `${label}.endSeconds`);
        const durationFrames = secondsToFrame(
          clip.durationSeconds,
          fps,
          `${label}.durationSeconds`,
        );
        if (durationFrames !== endFrame - startFrame) {
          throw new Error(`${label} duration disagrees with start/end.`);
        }
        return {startFrame, endFrame, durationFrames};
      })()
    : {
        startSeconds: stableSeconds(clip.startSeconds, `${label}.startSeconds`),
        endSeconds: stableSeconds(clip.endSeconds, `${label}.endSeconds`),
        durationSeconds: stableSeconds(clip.durationSeconds, `${label}.durationSeconds`),
      };
  return {
    name: String(clip.name ?? ''),
    nodeId: String(clip.nodeId ?? ''),
    ...timeline,
    inPointSeconds: optionalStableSeconds(clip.inPointSeconds, `${label}.inPointSeconds`),
    outPointSeconds: optionalStableSeconds(clip.outPointSeconds, `${label}.outPointSeconds`),
    mediaType: clip.mediaType === undefined ? null : String(clip.mediaType),
    enabled: clip.enabled === undefined ? null : Boolean(clip.enabled),
    speed: clip.speed === undefined || clip.speed === null || clip.speed === ''
      ? null
      : Number.isFinite(Number(clip.speed))
        ? Number(clip.speed)
        : String(clip.speed),
  };
}

function normalizeTrack(track, kind, position, fps) {
  const index = Number(track?.index);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`${kind} track ${position} has an invalid index.`);
  }
  const clips = Array.isArray(track.clips) ? track.clips : [];
  if (track.clipCount !== undefined && Number(track.clipCount) !== clips.length) {
    throw new Error(`${kind}:${index} clipCount mismatch.`);
  }
  return {
    key: `${kind}:${index}`,
    index,
    name: String(track.name ?? ''),
    isMuted: (track.isMuted ?? track.muted) === undefined
      ? null
      : Boolean(track.isMuted ?? track.muted),
    isLocked: (track.isLocked ?? track.locked) === undefined
      ? null
      : Boolean(track.isLocked ?? track.locked),
    clips: clips.map((clip, clipIndex) =>
      normalizeClip(
        clip,
        fps,
        `${kind}:${index}.clips[${clipIndex}]`,
        kind === 'video',
      )),
  };
}

function normalizeStructure(structure, fps) {
  if (!structure || typeof structure !== 'object') throw new Error('Sequence structure is missing.');
  const videoTracks = Array.isArray(structure.videoTracks) ? structure.videoTracks : [];
  const audioTracks = Array.isArray(structure.audioTracks) ? structure.audioTracks : [];
  if (Number(structure.videoTrackCount) !== videoTracks.length) {
    throw new Error('videoTrackCount mismatch.');
  }
  if (Number(structure.audioTrackCount) !== audioTracks.length) {
    throw new Error('audioTrackCount mismatch.');
  }
  return {
    id: String(structure.id ?? ''),
    name: String(structure.name ?? ''),
    durationFrames: secondsToFrame(structure.durationSeconds, fps, 'sequence.durationSeconds'),
    videoTracks: videoTracks.map((track, index) => normalizeTrack(track, 'video', index, fps)),
    audioTracks: audioTracks.map((track, index) => normalizeTrack(track, 'audio', index, fps)),
  };
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizedWindowsPath(value) {
  let normalized = String(value ?? '').trim().replaceAll('/', '\\');
  if (/^\\\\\?\\UNC\\/i.test(normalized)) {
    normalized = `\\\\${normalized.slice(8)}`;
  } else if (/^\\\\\?\\/.test(normalized)) {
    normalized = normalized.slice(4);
  }
  return path.win32.normalize(normalized).toLocaleLowerCase('en-US');
}

function requiredGuardString(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required.`);
  return result;
}

function canonicalVideoDisplayCode(value, label) {
  const rawCode = Number(value);
  if (!Number.isInteger(rawCode) || rawCode < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return rawCode >= 100 && rawCode <= 111 ? rawCode - 100 : rawCode;
}

export function validateOverlayPlacementIdentityGuards({manifest, before, liveContext}) {
  if (manifest?.schemaVersion !== 2) return {strict: false};
  if (!manifest.projectCheck || !manifest.sequenceCheck || !manifest.timingCheck || !manifest.captureCheck) {
    throw new Error('Schema 2 placement requires project/sequence/timing/capture checks.');
  }
  const projectName = requiredGuardString(liveContext?.projectName, 'live project name');
  const projectPath = requiredGuardString(liveContext?.projectPath, 'live project path');
  const sequenceName = requiredGuardString(before?.name, 'live sequence name');
  const sequenceId = requiredGuardString(before?.id, 'live sequence id');
  if (projectName !== requiredGuardString(manifest.projectCheck.name, 'projectCheck.name')) {
    throw new Error('Active project name does not match manifest.projectCheck.name.');
  }
  if (
    normalizedWindowsPath(projectPath) !==
    normalizedWindowsPath(requiredGuardString(manifest.projectCheck.path, 'projectCheck.path'))
  ) {
    throw new Error('Active project path does not match manifest.projectCheck.path.');
  }
  if (
    sequenceName !== requiredGuardString(manifest.sequenceCheck.name, 'sequenceCheck.name') ||
    sequenceId !== requiredGuardString(manifest.sequenceCheck.id, 'sequenceCheck.id')
  ) {
    throw new Error('Active sequence identity does not match the strict placement manifest.');
  }
  if (
    liveContext?.sequenceName !== sequenceName ||
    String(liveContext?.sequenceId ?? '') !== sequenceId
  ) {
    throw new Error('CEP live identity disagrees with the sequence structure read-back.');
  }
  const ticksPerFrame = Number(liveContext?.ticksPerFrame);
  const expectedTicks = Number(manifest.timingCheck.ticksPerFrame);
  if (
    !Number.isInteger(ticksPerFrame) ||
    ticksPerFrame <= 0 ||
    !Number.isInteger(expectedTicks) ||
    expectedTicks !== ticksPerFrame
  ) {
    throw new Error('Live ticksPerFrame does not match manifest.timingCheck.');
  }
  const fps = TICKS_PER_SECOND / ticksPerFrame;
  if (Math.abs(Number(manifest.timingCheck.fps) - fps) > 1e-9) {
    throw new Error('Live fps does not match manifest.timingCheck.');
  }
  if (
    canonicalVideoDisplayCode(liveContext?.videoDisplayFormat, 'live videoDisplayFormat') !==
    canonicalVideoDisplayCode(
      manifest.timingCheck.timecodeDisplay?.code,
      'manifest timingCheck.timecodeDisplay.code',
    )
  ) {
    throw new Error('Live display format does not match manifest.timingCheck.');
  }
  const durationFrames = secondsToFrame(before.durationSeconds, fps, 'sequence.durationSeconds');
  if (
    durationFrames !== Number(manifest.sequenceCheck.durationFrames) ||
    Math.abs(Number(before.durationSeconds) - Number(manifest.sequenceCheck.durationSeconds)) > TIME_EPSILON
  ) {
    throw new Error('Live sequence duration does not match manifest.sequenceCheck.');
  }
  const durationTicksText = String(liveContext?.durationTicks ?? '').trim();
  const hasDurationTicks = /^\d+$/u.test(durationTicksText);
  if (
    durationTicksText &&
    !hasDurationTicks &&
    !/^(?:undefined|null)$/iu.test(durationTicksText)
  ) {
    throw new Error('CEP duration ticks are invalid.');
  }
  if (hasDurationTicks) {
    const durationTicks = BigInt(durationTicksText);
    const ticksPerFrameBigInt = BigInt(ticksPerFrame);
    if (durationTicks % ticksPerFrameBigInt !== 0n) {
      throw new Error('CEP duration ticks are not aligned to the live frame grid.');
    }
    const liveDurationFrames = Number(durationTicks / ticksPerFrameBigInt);
    if (liveDurationFrames !== durationFrames) {
      throw new Error('CEP duration ticks disagree with the sequence structure read-back.');
    }
  }
  const expectedStructureHash = requiredGuardString(
    manifest.sequenceCheck.structureSha256,
    'sequenceCheck.structureSha256',
  );
  if (!/^[0-9A-F]{64}$/u.test(expectedStructureHash)) {
    throw new Error('manifest.sequenceCheck.structureSha256 must be a SHA-256 hash.');
  }
  const liveStructureHash = sha256PremiereSequenceFingerprint(before, fps);
  if (liveStructureHash !== expectedStructureHash) {
    throw new Error('Live sequence structure changed after the placement capture.');
  }
  if (manifest.captureCheck.source !== 'premiere-uxp-read-only-placement-capture') {
    throw new Error('Strict placement requires a read-only full-sequence placement capture.');
  }
  for (const field of ['captureSha256', 'structureSha256', 'bundleSha256']) {
    if (!/^[0-9A-F]{64}$/u.test(String(manifest.captureCheck[field] ?? ''))) {
      throw new Error(`manifest.captureCheck.${field} must be a SHA-256 hash.`);
    }
  }
  return {
    strict: true,
    durationFrames,
    fps,
    projectName,
    projectPath,
    sequenceId,
    sequenceName,
    ticksPerFrame,
    structureSha256: liveStructureHash,
    videoDisplayFormat: Number(liveContext.videoDisplayFormat),
  };
}

function trackMetadata(track) {
  return {
    key: track.key,
    index: track.index,
    name: track.name,
    isMuted: track.isMuted,
    isLocked: track.isLocked,
  };
}

function placementKey(value) {
  return `${value.name}@${value.startFrame}-${value.endFrame}`;
}

function removeOneMatching(values, expected) {
  const index = values.findIndex((value) => same(value, expected));
  if (index < 0) return false;
  values.splice(index, 1);
  return true;
}

// 최초 baseline의 모든 clip을 보존하고, target track에는 누적 expected overlay만 허용한다.
export function diffOverlaySequenceStructures(beforeRaw, afterRaw, expectedItems, fps) {
  const before = normalizeStructure(beforeRaw, fps);
  const after = normalizeStructure(afterRaw, fps);
  const issues = [];
  const added = [];
  if (!before.id || !after.id || before.id !== after.id) {
    issues.push(`sequence identity changed: ${before.id || '<missing>'} -> ${after.id || '<missing>'}`);
  }
  if (!before.name || before.name !== after.name) {
    issues.push(`sequence name changed: ${before.name || '<missing>'} -> ${after.name || '<missing>'}`);
  }
  if (before.durationFrames !== after.durationFrames) {
    issues.push(`sequence duration changed: ${before.durationFrames} -> ${after.durationFrames} frames`);
  }
  if (before.videoTracks.length !== after.videoTracks.length) {
    issues.push(`video track count changed: ${before.videoTracks.length} -> ${after.videoTracks.length}`);
  }
  if (before.audioTracks.length !== after.audioTracks.length) {
    issues.push(`audio track count changed: ${before.audioTracks.length} -> ${after.audioTracks.length}`);
  }

  const targetIndexes = new Set(expectedItems.map((item) => item.track_index));
  const compareUnchangedTracks = (kind, beforeTracks, afterTracks) => {
    const length = Math.max(beforeTracks.length, afterTracks.length);
    for (let index = 0; index < length; index += 1) {
      const beforeTrack = beforeTracks[index];
      const afterTrack = afterTracks[index];
      if (!beforeTrack || !afterTrack) continue;
      const isTarget = kind === 'video' && targetIndexes.has(beforeTrack.index);
      if (!isTarget && !same(beforeTrack, afterTrack)) {
        issues.push(`${kind === 'video' ? 'V' : 'A'}${index + 1}: non-target track changed`);
      }
    }
  };
  compareUnchangedTracks('video', before.videoTracks, after.videoTracks);
  compareUnchangedTracks('audio', before.audioTracks, after.audioTracks);

  for (const trackIndex of [...targetIndexes].sort((left, right) => left - right)) {
    const beforeTrack = before.videoTracks.find((track) => track.index === trackIndex);
    const afterTrack = after.videoTracks.find((track) => track.index === trackIndex);
    if (!beforeTrack || !afterTrack) {
      issues.push(`V${trackIndex + 1}: target track missing after placement`);
      continue;
    }
    if (!same(trackMetadata(beforeTrack), trackMetadata(afterTrack))) {
      issues.push(`V${trackIndex + 1}: target track metadata changed`);
    }

    const remainingAfter = afterTrack.clips.map((clip) => ({...clip}));
    for (const originalClip of beforeTrack.clips) {
      if (!removeOneMatching(remainingAfter, originalClip)) {
        issues.push(`V${trackIndex + 1}: original clip changed or disappeared -> ${placementKey(originalClip)}`);
      }
    }

    const expectedKeys = expectedItems
      .filter((item) => item.track_index === trackIndex)
      .map((item) => placementKey({
        name: item.name,
        startFrame: item.frame,
        endFrame: item.endFrame,
      }));
    for (const actual of remainingAfter) {
      const key = placementKey(actual);
      const expectedIndex = expectedKeys.indexOf(key);
      if (expectedIndex < 0) {
        issues.push(`V${trackIndex + 1}: unexpected clip appeared -> ${key}`);
      } else {
        expectedKeys.splice(expectedIndex, 1);
        added.push(`V${trackIndex + 1}: ${key}`);
      }
    }
    for (const missing of expectedKeys) {
      issues.push(`V${trackIndex + 1}: expected overlay missing -> ${missing}`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    added,
    expectedPlacementCount: expectedItems.length,
    observedPlacementCount: added.length,
    sequenceId: after.id,
    sequenceName: after.name,
    durationFrames: after.durationFrames,
  };
}

export function buildPlacementScript(plan, ticksPerFrame, sequence) {
  for (const step of plan) {
    if (typeof step.file !== 'string' || !path.isAbsolute(step.file)) {
      throw new Error('Placement requires the exact absolute media path for every project item.');
    }
  }
  const durationTolerance = 0.25 * ticksPerFrame / TICKS_PER_SECOND;
  return `
var seq = app.project.activeSequence;
if (!seq) return __error("No active sequence");
var expectedName = ${JSON.stringify(sequence.name)};
var expectedId = ${JSON.stringify(String(sequence.id))};
if (seq.name !== expectedName || String(seq.sequenceID) !== expectedId) {
  return __error("Active sequence identity changed before overlay batch");
}
var durationBefore = __ticksToSeconds(seq.end);
var expectedDuration = ${Number(sequence.durationSeconds)};
if (Math.abs(durationBefore - expectedDuration) > ${durationTolerance}) {
  return __error("Active sequence duration changed before overlay batch");
}
var TPF = ${ticksPerFrame};
var plan = ${JSON.stringify(plan)};

function normalizedMediaPath(value) {
  var normalized = String(value || "").split(String.fromCharCode(92)).join("/").toLowerCase();
  return normalized.indexOf("//?/") === 0 ? normalized.slice(4) : normalized;
}
function findItem(container, name, file, depth) {
  var kids = container.children ? container.children : container;
  for (var i = 0; i < kids.numItems; i++) {
    var it = kids[i];
    if (String(it.name) === name && typeof it.getMediaPath === "function") {
      try {
        if (normalizedMediaPath(it.getMediaPath()) === normalizedMediaPath(file)) return it;
      } catch (mediaPathError) {}
    }
    if (it.type === 2 && depth < 6) {
      var nested = findItem(it, name, file, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

var out = [];
for (var p = 0; p < plan.length; p++) {
  var step = plan[p];
  var track = seq.videoTracks[step.trackIndex];
  if (!track) {
    out.push({name: step.name, ok: false, reason: "video track " + step.trackIndex + " missing"});
    break;
  }
  var item = findItem(app.project.rootItem, step.name, step.file, 0);
  if (!item) {
    out.push({name: step.name, ok: false, reason: "project item with exact media path not found"});
    break;
  }
  var targetStartTicks = Number(step.frame) * TPF;
  var targetEndTicks = Number(step.endFrame) * TPF;
  var occupied = null;
  for (var c = 0; c < track.clips.numItems; c++) {
    var existing = track.clips[c];
    var existingStart = Number(existing.start.ticks);
    var existingEnd = Number(existing.end.ticks);
    if (existingEnd > targetStartTicks && existingStart < targetEndTicks) {
      occupied = String(existing.name);
      break;
    }
  }
  if (occupied) {
    out.push({name: step.name, ok: false, reason: "target range became occupied by " + occupied});
    break;
  }
  var t = new Time();
  t.ticks = String(step.frame * TPF);
  try {
    track.overwriteClip(item, t);
    out.push({name: step.name, mediaPath: String(item.getMediaPath()), ok: true, targetTicks: t.ticks});
  } catch (e) {
    out.push({name: step.name, ok: false, reason: String(e)});
    break;
  }
}
return __result({
  expected: plan.length,
  attempted: out.length,
  results: out,
  seqEnd: __ticksToSeconds(seq.end)
});
`;
}

function validateManifestItems(manifest, manifestDir) {
  const items = (manifest.items || []).map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Manifest item ${index} is invalid.`);
    const file = String(item.file || '').trim();
    if (!file) throw new Error(`Manifest item ${index} has no file.`);
    if (item.track_index === undefined || item.track_index === null || item.track_index === '') {
      throw new Error(`Manifest item ${index} has no track_index.`);
    }
    if (item.start_seconds === undefined || item.start_seconds === null || item.start_seconds === '') {
      throw new Error(`Manifest item ${index} has no start_seconds.`);
    }
    const trackIndex = Number(item.track_index);
    const startSeconds = Number(item.start_seconds);
    if (!Number.isInteger(trackIndex) || trackIndex < 0) {
      throw new Error(`Manifest item ${index} track_index must be a non-negative integer.`);
    }
    if (!Number.isFinite(startSeconds) || startSeconds < 0) {
      throw new Error(`Manifest item ${index} start_seconds must be a non-negative number.`);
    }
    return {
      ...item,
      file,
      track_index: trackIndex,
      start_seconds: startSeconds,
      absFile: path.resolve(manifestDir, file),
      name: path.basename(file),
      manifestIndex: index,
    };
  });
  if (items.length === 0) throw new Error('Manifest has no items.');
  items.sort(
    (left, right) =>
      left.start_seconds - right.start_seconds ||
      left.track_index - right.track_index ||
      left.manifestIndex - right.manifestIndex,
  );

  const pathsByName = new Map();
  for (const item of items) {
    const nameKey = item.name.toLocaleLowerCase('en-US');
    const pathKey = item.absFile.toLocaleLowerCase('en-US');
    const previous = pathsByName.get(nameKey);
    if (previous && previous !== pathKey) {
      throw new Error(`Different overlay files share project item name "${item.name}".`);
    }
    pathsByName.set(nameKey, pathKey);
  }
  return items;
}

function validatePlacementPreflight(items, sourceChecks, before, fps) {
  const beforeDurationFrame = secondsToFrame(before.durationSeconds, fps, 'sequence.durationSeconds');
  for (const item of items) {
    const probe = sourceChecks.get(item.absFile);
    if (!probe) throw new Error(`Missing source probe for ${item.absFile}.`);
    if (Math.abs(probe.frameRate - fps) > 0.02) {
      throw new Error(
        `Overlay fps ${probe.frameRate} does not match sequence fps ${fps}: ${item.absFile}`,
      );
    }
    item.frame = secondsToFrame(item.start_seconds, fps, `${item.name}.start_seconds`);
    item.durationFrames = probe.frames;
    item.endFrame = item.frame + item.durationFrames;
    item.startSeconds = item.frame / fps;
    item.endSeconds = item.endFrame / fps;
    if (item.endFrame > beforeDurationFrame) {
      throw new Error(
        `${item.name} ends beyond the sequence: frame ${item.endFrame} > ${beforeDurationFrame}.`,
      );
    }
    const track = before.videoTracks?.[item.track_index];
    if (!track) throw new Error(`Video track index ${item.track_index} does not exist.`);
    const clash = (track.clips || []).filter(
      (clip) =>
        clip.endSeconds > item.startSeconds + TIME_EPSILON &&
        clip.startSeconds < item.endSeconds - TIME_EPSILON,
    );
    if (clash.length > 0) {
      throw new Error(
        `Target track V${item.track_index + 1} is occupied at ${item.startSeconds}–${item.endSeconds}: ` +
          clash.map((clip) => `${clip.name}@${clip.startSeconds}`).join(', '),
      );
    }
  }

  const byTrack = new Map();
  for (const item of items) {
    const trackItems = byTrack.get(item.track_index) || [];
    trackItems.push(item);
    byTrack.set(item.track_index, trackItems);
  }
  for (const [trackIndex, trackItems] of byTrack) {
    trackItems.sort((left, right) => left.frame - right.frame);
    for (let index = 1; index < trackItems.length; index += 1) {
      if (trackItems[index].frame < trackItems[index - 1].endFrame) {
        throw new Error(
          `Planned overlays overlap on V${trackIndex + 1}: ` +
            `${trackItems[index - 1].name} and ${trackItems[index].name}.`,
        );
      }
    }
  }
}

function serializeReportError(error) {
  if (!error) return null;
  return {
    name: String(error.name || 'Error'),
    message: String(error.message || error),
    code: error.code ?? null,
  };
}

async function main() {
  const {options, positional} = parseArgs(process.argv.slice(2));
  if (options.help || positional.length === 0) {
    console.log(usage());
    process.exit(options.help ? 0 : 1);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number.');
  }
  const batchOptions = resolvePremiereOverlayBatchOptions({
    batchSize: options.batchSize,
    batchPauseMs: options.batchPauseMs,
    dryRun: options.dryRun,
  });

  const manifestPath = path.resolve(positional[0]);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const manifestDir = path.dirname(manifestPath);
  const reportPath = options.report
    ? path.resolve(options.report)
    : /\.json$/i.test(manifestPath)
      ? manifestPath.replace(/\.json$/i, '.cep-report.json')
      : `${manifestPath}.cep-report.json`;
  if (reportPath.toLocaleLowerCase('en-US') === manifestPath.toLocaleLowerCase('en-US')) {
    throw new Error('Report path must not overwrite the overlay manifest.');
  }
  const report = {
    manifest: manifestPath,
    report: reportPath,
    dryRun: options.dryRun,
    stage: 'start',
    batchSize: batchOptions.batchSize,
    batchPauseMs: batchOptions.batchPauseMs,
    batchCount: 0,
    completedBatchCount: 0,
    importAttemptCount: 0,
    placementWriteAttemptCount: 0,
    cumulativePlacedCount: 0,
    remainingItemCount: 0,
    sourceChecks: [],
    plannedPlacements: [],
    placements: [],
    batches: [],
    stop: null,
    diff: null,
    error: null,
    ok: false,
  };

  let lifecycle = null;
  let removeSignalHandlers = () => {};
  try {
    const items = validateManifestItems(manifest, manifestDir);
    report.remainingItemCount = items.length;

    report.stage = 'source_check';
    const sourceChecks = new Map();
    for (const item of items) {
      if (!fs.existsSync(item.absFile)) throw new Error(`Missing overlay file: ${item.absFile}`);
      let probe = sourceChecks.get(item.absFile);
      if (!probe) {
        probe = probeStreams(item.absFile);
        sourceChecks.set(item.absFile, probe);
      }
      report.sourceChecks.push({file: item.absFile, ...probe});
      if (probe.hasAudio) {
        throw new Error(`Overlay has an audio stream (contract requires --muted): ${item.absFile}`);
      }
    }

    const serverPath = path.join(options.mcpRoot, 'dist', 'index.js');
    const {Client, StdioClientTransport} = await importMcpClient(options.mcpRoot);
    const client = new Client({name: 'place-overlays-cep', version: '2.0.0'}, {capabilities: {}});
    const transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath],
      env: {...process.env, PREMIERE_TEMP_DIR: options.tempDir},
    });
    const cepLock = await acquirePremiereCepLock({
      bridgeDirectory: options.tempDir,
      tool: 'place-overlays-cep',
      metadata: {
        mode: options.dryRun ? 'dry-run' : 'verified-microbatch',
        batchSize: batchOptions.batchSize,
        batchPauseMs: batchOptions.batchPauseMs,
      },
    });
    lifecycle = createPremiereCepLifecycle({lock: cepLock});
    const session = lifecycle.registerSession({client, transport, label: 'place-overlays-cep'});
    removeSignalHandlers = installPremiereCepSignalHandlers(() => lifecycle.cleanup());
    await lifecycle.connectSession(session);

    const call = async (name, args) => {
      const result = await client.callTool({name, arguments: args}, undefined, {
        timeout: options.timeoutMs,
      });
      return requireToolPayload(result, name);
    };

    report.stage = 'pre_snapshot';
    const before = await call('get_sequence_structure', {});
    if (!String(before?.id ?? '') || !String(before?.name ?? '')) {
      throw new Error('Pre-snapshot did not return complete sequence identity.');
    }
    report.sequence = {
      id: String(before.id),
      name: String(before.name),
      durationSeconds: Number(before.durationSeconds),
    };
    if (manifest.sequenceCheck?.name && before.name !== manifest.sequenceCheck.name) {
      throw new Error(
        `Active sequence mismatch: expected "${manifest.sequenceCheck.name}", got "${before.name}".`,
      );
    }
    if (
      manifest.sequenceCheck?.id !== undefined &&
      String(before.id) !== String(manifest.sequenceCheck.id)
    ) {
      throw new Error('Active sequence ID does not match manifest.sequenceCheck.id.');
    }

    const settings = await call('evaluate_expression', {
      expression:
        '(function(){var p=app.project;var s=p&&p.activeSequence;if(!p||!s)return JSON.stringify({ok:false});var st=s.getSettings();var durationTicks=s.end&&s.end.ticks!=null?String(s.end.ticks):null;return JSON.stringify({ok:true,projectName:String(p.name||""),projectPath:String(p.path||""),sequenceName:String(s.name||""),sequenceId:String(s.sequenceID||""),durationTicks:durationTicks,ticksPerFrame:String(st.videoFrameRate.ticks),videoDisplayFormat:Number(st.videoDisplayFormat)});})()',
    });
    const liveContext = JSON.parse(settings.value);
    if (liveContext.ok !== true) throw new Error('Could not read strict project/sequence settings.');
    const ticksPerFrame = Number(liveContext.ticksPerFrame);
    if (!(ticksPerFrame > 0)) throw new Error('Could not read sequence frame duration.');
    const fps = TICKS_PER_SECOND / ticksPerFrame;
    report.fps = fps;
    report.ticksPerFrame = ticksPerFrame;
    report.identityGuard = validateOverlayPlacementIdentityGuards({
      manifest,
      before,
      liveContext,
    });

    report.stage = 'placement_preflight';
    validatePlacementPreflight(items, sourceChecks, before, fps);
    report.plannedPlacements = items.map((item) => ({
      manifestIndex: item.manifestIndex,
      name: item.name,
      file: item.absFile,
      trackIndex: item.track_index,
      frame: item.frame,
      startSeconds: item.startSeconds,
      endFrame: item.endFrame,
      endSeconds: item.endSeconds,
    }));

    const batchPlan = createPremiereOverlayBatchPlan(items, batchOptions.batchSize);
    report.batchCount = batchPlan.batchCount;
    report.plannedBatches = batchPlan.batches.map((batch) => ({
      batchNumber: batch.batchNumber,
      itemCount: batch.items.length,
      cumulativeItemCount: batch.cumulativeItemCount,
      names: batch.items.map((item) => item.name),
    }));

    if (options.dryRun) {
      const result = await runPremiereOverlayBatchPlan({
        plan: batchPlan,
        dryRun: true,
        batchPauseMs: batchOptions.batchPauseMs,
      });
      report.stage = 'dry_run_complete';
      report.stop = result.stop;
      report.ok = true;
      return report;
    }

    report.stage = 'microbatch_write';
    const batchResult = await runPremiereOverlayBatchPlan({
      plan: batchPlan,
      dryRun: false,
      batchPauseMs: batchOptions.batchPauseMs,
      importBatch: async (batch) => {
        const filePaths = [...new Set(batch.items.map((item) => item.absFile))];
        return call('import_media', {file_paths: filePaths});
      },
      placeBatch: async (batch) => call('execute_extendscript', {
        code: buildPlacementScript(
          batch.items.map((item) => ({
            name: item.name,
            file: item.absFile,
            trackIndex: item.track_index,
            frame: item.frame,
            endFrame: item.endFrame,
          })),
          ticksPerFrame,
          report.sequence,
        ),
        timeout_ms: options.timeoutMs,
      }),
      readAfterBatch: async () => call('get_sequence_structure', {}),
      verifyBatch: async (batch, after) => {
        const diff = diffOverlaySequenceStructures(before, after, batch.cumulativeItems, fps);
        return {
          ok: diff.ok,
          stopReason: diff.ok
            ? null
            : diff.issues.some((issue) => issue.startsWith('sequence '))
              ? 'sequence_identity_or_duration_changed'
              : 'invariant_mismatch',
          diff,
        };
      },
      isImportResponseFailure: (response, batch) => {
        const expected = new Set(batch.items.map((item) => item.absFile)).size;
        return !response || Number(response.imported) !== expected;
      },
      isPlacementResponseFailure: (response, batch) =>
        !response ||
        !Array.isArray(response.results) ||
        response.results.length !== batch.items.length ||
        response.results.some((item) => item.ok !== true),
    });

    report.completedBatchCount = batchResult.completedBatchCount;
    report.importAttemptCount = batchResult.importAttemptCount;
    report.placementWriteAttemptCount = batchResult.placementWriteAttemptCount;
    report.cumulativePlacedCount = batchResult.cumulativeAppliedItems.length;
    report.remainingItemCount = items.length - report.cumulativePlacedCount;
    report.stop = batchResult.stop;
    report.placements = batchResult.cumulativeAppliedItems.map((item) => ({
      name: item.name,
      trackIndex: item.track_index,
      frame: item.frame,
      startSeconds: item.startSeconds,
      endFrame: item.endFrame,
      endSeconds: item.endSeconds,
    }));
    report.batches = batchResult.batchResults.map((batch) => ({
      batchNumber: batch.batchNumber,
      itemCount: batch.itemCount,
      cumulativeItemCount: batch.cumulativeItemCount,
      importAttempted: batch.importAttempted,
      importResponse: batch.importResponse,
      importError: batch.importError,
      placementWriteAttempted: batch.placementWriteAttempted,
      placementResponse: batch.placementResponse,
      placementError: batch.placementError,
      postReadSucceeded: batch.postReadSucceeded,
      postReadError: batch.postReadError,
      verifiedApplied: batch.verifiedApplied,
      verification: batch.verification,
      verificationError: batch.verificationError,
      stopReasons: batch.stopReasons,
    }));
    report.diff = batchResult.batchResults.at(-1)?.verification?.diff ?? null;
    report.ok = batchResult.ok;
    report.stage = batchResult.ok ? 'complete' : 'stopped';
    return report;
  } catch (error) {
    report.error = serializeReportError(error);
    report.ok = false;
    report.stage = `${report.stage}_failed`;
    return report;
  } finally {
    const finalizationErrors = [];
    if (lifecycle) {
      try {
        await lifecycle.cleanup();
      } catch (error) {
        finalizationErrors.push(error);
      }
    }
    removeSignalHandlers();
    try {
      fs.mkdirSync(path.dirname(reportPath), {recursive: true});
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    } catch (error) {
      finalizationErrors.push(error);
    }
    if (finalizationErrors.length === 1) throw finalizationErrors[0];
    if (finalizationErrors.length > 1) {
      throw new AggregateError(finalizationErrors, 'Overlay cleanup/report finalization failed.');
    }
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main()
    .then((report) => {
      console.log(JSON.stringify({
        ok: report.ok,
        stage: report.stage,
        sequence: report.sequence,
        fps: report.fps,
        batchCount: report.batchCount,
        completedBatchCount: report.completedBatchCount,
        importAttemptCount: report.importAttemptCount,
        placementWriteAttemptCount: report.placementWriteAttemptCount,
        cumulativePlacedCount: report.cumulativePlacedCount,
        remainingItemCount: report.remainingItemCount,
        stop: report.stop,
        issues: report.diff?.issues ?? [],
        error: report.error,
        report: report.report,
      }, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    })
    .catch((error) => {
      console.error(JSON.stringify({ok: false, error: error.message}, null, 2));
      process.exitCode = 1;
    });
}
