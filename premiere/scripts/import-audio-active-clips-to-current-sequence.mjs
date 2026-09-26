import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  acquirePremiereCepLock,
  createPremiereCepLifecycle,
  installPremiereCepSignalHandlers,
} from './lib/premiere-cep-lock.mjs';
import {
  PREMIERE_DEFAULT_BATCH_PAUSE_MS,
  PREMIERE_DEFAULT_BATCH_SIZE,
  PREMIERE_MAX_BATCH_SIZE,
  PREMIERE_MIN_BATCH_PAUSE_MS,
  partitionPremiereMicroBatches,
  resolvePremiereBatchPauseMs,
  resolvePremiereBatchSize,
  waitForPremiereUi,
} from './lib/premiere-micro-batch.mjs';
import { DEFAULT_MCP_ROOT, DEFAULT_TEMP_DIR } from "../servers/premiere-uxp-mcp/paths.mjs";

function parseArgs(argv) {
  const args = {
    mcpRoot: process.env.PREMIERE_MCP_ROOT || DEFAULT_MCP_ROOT,
    tempDir: process.env.PREMIERE_TEMP_DIR || DEFAULT_TEMP_DIR,
    trackIndex: 0,
    audioTrackIndex: 0,
    importMedia: true,
    batchSize: PREMIERE_DEFAULT_BATCH_SIZE,
    batchPauseMs: PREMIERE_DEFAULT_BATCH_PAUSE_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[name] = true;
    } else {
      args[name] = next;
      index += 1;
    }
  }

  if (args['no-import']) {
    args.importMedia = false;
  }
  if (args['track-index'] !== undefined) {
    args.trackIndex = Number(args['track-index']);
  }
  if (args['audio-track-index'] !== undefined) {
    args.audioTrackIndex = Number(args['audio-track-index']);
  }
  if (args['target-bin'] !== undefined) {
    args.targetBin = args['target-bin'];
  }
  if (args['start-seconds'] !== undefined) {
    args.startSeconds = Number(args['start-seconds']);
  }
  if (args['start-index'] !== undefined) {
    args.startIndex = Number(args['start-index']);
  }
  if (args['end-index'] !== undefined) {
    args.endIndex = Number(args['end-index']);
  }
  if (args['batch-size'] !== undefined) {
    args.batchSize = Number(args['batch-size']);
  }
  if (args['batch-pause-ms'] !== undefined) {
    args.batchPauseMs = Number(args['batch-pause-ms']);
  }

  return args;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/import-audio-active-clips-to-current-sequence.mjs --manifest <manifest.json>',
    '',
    'Options:',
    '  --start-seconds <n>       Default: current active sequence duration',
    '  --track-index <n>         Default: 0',
    '  --audio-track-index <n>   Default: 0',
    '  --target-bin <name/id>    Import media into this project bin',
    '  --start-index <n>         Start at this manifest clip index',
    '  --end-index <n>           Stop before this manifest clip index',
    `  --batch-size <n>          Default: ${PREMIERE_DEFAULT_BATCH_SIZE}; hard maximum: ${PREMIERE_MAX_BATCH_SIZE}`,
    `  --batch-pause-ms <n>      Default: ${PREMIERE_DEFAULT_BATCH_PAUSE_MS}; minimum: ${PREMIERE_MIN_BATCH_PAUSE_MS}`,
    '  --no-import               Skip import_media and only place existing project items',
    '  --help                    Show this help without connecting to Premiere',
    '',
    'Each verified batch is followed by a UI pause before the next batch.',
    'A timeout, failed response, failed read, or invariant mismatch stops without resending writes.',
    'The script does not save the Premiere project.',
  ].join('\n');
}

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

function parseRate(rateText) {
  const [numerator, denominator] = String(rateText || '0/1')
    .split('/')
    .map((value) => Number(value));
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }
  return numerator / denominator;
}

async function probeMediaFile(filePath) {
  const raw = await runCapture('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=index,codec_type,nb_frames,duration,avg_frame_rate,r_frame_rate',
    '-of',
    'json',
    filePath,
  ]);
  const json = JSON.parse(raw);
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const videoStreams = streams.filter((stream) => stream.codec_type === 'video');
  const audioStreams = streams.filter((stream) => stream.codec_type === 'audio');
  if (videoStreams.length !== 1) {
    throw new Error(`Expected exactly one video stream in ${filePath}; found ${videoStreams.length}`);
  }
  if (audioStreams.length !== 1) {
    throw new Error(`Expected exactly one audio stream in ${filePath}; found ${audioStreams.length}`);
  }

  const video = videoStreams[0];
  const frameRate = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate);
  const frameCount = Number(video.nb_frames);
  let durationSeconds = null;
  if (Number.isFinite(frameCount) && frameCount > 0 && frameRate > 0) {
    durationSeconds = frameCount / frameRate;
  }
  const streamDuration = Number(video.duration);
  if (durationSeconds === null && Number.isFinite(streamDuration) && streamDuration > 0) {
    durationSeconds = streamDuration;
  }
  const formatDuration = Number(json.format?.duration);
  if (durationSeconds === null && Number.isFinite(formatDuration) && formatDuration > 0) {
    durationSeconds = formatDuration;
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Could not read video duration: ${filePath}`);
  }
  return {
    file: filePath,
    durationSeconds,
    frameCount: Number.isFinite(frameCount) && frameCount > 0 ? frameCount : null,
    frameRate: frameRate > 0 ? frameRate : null,
    videoStreamCount: videoStreams.length,
    audioStreamCount: audioStreams.length,
  };
}

async function importMcpClient(mcpRoot) {
  const requireFromMcp = createRequire(path.join(mcpRoot, 'package.json'));
  const clientPath = requireFromMcp.resolve('@modelcontextprotocol/sdk/client/index.js');
  const stdioPath = requireFromMcp.resolve('@modelcontextprotocol/sdk/client/stdio.js');
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(clientPath).href),
    import(pathToFileURL(stdioPath).href),
  ]);
  return { Client, StdioClientTransport };
}

function parseToolPayload(result) {
  const text = result.content?.find((part) => part.type === 'text')?.text;
  if (text === undefined) {
    return result;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isErrorPayload(payload) {
  if (typeof payload === 'string') {
    return (
      /^(Error:|EvalScript Error:)/i.test(payload) ||
      /ReferenceError/i.test(payload) ||
      /timed out|timeout/i.test(payload)
    );
  }
  return Boolean(
    payload &&
    typeof payload === 'object' &&
    (
      payload.success === false ||
      payload.ok === false ||
      Number(payload.failureCount) > 0 ||
      Number(payload.failed) > 0 ||
      (Array.isArray(payload.failures) && payload.failures.length > 0) ||
      (Array.isArray(payload.errors) && payload.errors.length > 0) ||
      String(payload.status ?? '').toLowerCase() === 'error'
    )
  );
}

function describePayload(payload) {
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

async function callToolOnce(client, name, toolArgs = {}) {
  const result = await client.callTool({ name, arguments: toolArgs });
  const payload = parseToolPayload(result);
  if (result?.isError || isErrorPayload(payload)) {
    throw new Error(`${name} failed: ${describePayload(payload)}`);
  }
  return payload;
}

function numeric(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(9)) : null;
}

function sameTime(left, right, tolerance) {
  return (
    Number.isFinite(Number(left)) &&
    Number.isFinite(Number(right)) &&
    Math.abs(Number(left) - Number(right)) <= tolerance
  );
}

function canonicalClip(clip, { includeIndex = true } = {}) {
  const output = {
    name: String(clip?.name ?? ''),
    nodeId: String(clip?.nodeId ?? ''),
    mediaType: String(clip?.mediaType ?? ''),
    startSeconds: numeric(clip?.startSeconds),
    endSeconds: numeric(clip?.endSeconds),
    durationSeconds: numeric(clip?.durationSeconds),
    inPointSeconds: numeric(clip?.inPointSeconds),
    outPointSeconds: numeric(clip?.outPointSeconds),
    speed: numeric(clip?.speed),
    enabled: typeof clip?.enabled === 'boolean' ? clip.enabled : null,
  };
  if (includeIndex) output.index = numeric(clip?.index);
  return output;
}

function canonicalTrackMetadata(track) {
  return {
    index: numeric(track?.index),
    name: String(track?.name ?? ''),
    isMuted: typeof (track?.isMuted ?? track?.muted) === 'boolean'
      ? Boolean(track?.isMuted ?? track?.muted)
      : null,
    isLocked: typeof (track?.isLocked ?? track?.locked) === 'boolean'
      ? Boolean(track?.isLocked ?? track?.locked)
      : null,
  };
}

function canonicalTrack(track) {
  return {
    ...canonicalTrackMetadata(track),
    clipCount: Array.isArray(track?.clips) ? track.clips.length : 0,
    clips: (track?.clips ?? []).map((clip) => canonicalClip(clip)),
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function trackMap(structure, kind, failures, stage) {
  const field = kind === 'video' ? 'videoTracks' : 'audioTracks';
  const tracks = Array.isArray(structure?.[field]) ? structure[field] : [];
  const map = new Map();
  tracks.forEach((track, position) => {
    const index = Number(track?.index);
    if (!Number.isInteger(index) || index < 0) {
      failures.push({ kind: 'invalid_track_index', stage, trackKind: kind, position });
      return;
    }
    if (map.has(index)) {
      failures.push({ kind: 'duplicate_track_index', stage, trackKind: kind, index });
      return;
    }
    map.set(index, track);
  });
  return map;
}

function totalClipCount(structure, kind) {
  const field = kind === 'video' ? 'videoTracks' : 'audioTracks';
  return (structure?.[field] ?? []).reduce(
    (sum, track) => sum + (Array.isArray(track?.clips) ? track.clips.length : 0),
    0,
  );
}

function verifyTargetTrackAdditions({
  beforeTrack,
  afterTrack,
  expectedItems,
  kind,
  tolerance,
  failures,
}) {
  if (!sameJson(canonicalTrackMetadata(beforeTrack), canonicalTrackMetadata(afterTrack))) {
    failures.push({
      kind: 'target_track_metadata_changed',
      trackKind: kind,
      before: canonicalTrackMetadata(beforeTrack),
      after: canonicalTrackMetadata(afterTrack),
    });
  }

  const remaining = (afterTrack?.clips ?? []).map((clip) => ({
    clip,
    fingerprint: JSON.stringify(canonicalClip(clip, { includeIndex: false })),
    used: false,
  }));
  for (const clip of beforeTrack?.clips ?? []) {
    const fingerprint = JSON.stringify(canonicalClip(clip, { includeIndex: false }));
    const match = remaining.find((candidate) => !candidate.used && candidate.fingerprint === fingerprint);
    if (!match) {
      failures.push({
        kind: 'existing_target_clip_changed',
        trackKind: kind,
        clip: canonicalClip(clip, { includeIndex: false }),
      });
      continue;
    }
    match.used = true;
  }

  const additions = remaining.filter((candidate) => !candidate.used);
  if (additions.length !== expectedItems.length) {
    failures.push({
      kind: 'target_addition_count_mismatch',
      trackKind: kind,
      expected: expectedItems.length,
      actual: additions.length,
    });
  }

  const matched = [];
  for (const item of expectedItems) {
    const match = additions.find((candidate) =>
      !candidate.used &&
      String(candidate.clip?.name ?? '') === item.name &&
      sameTime(candidate.clip?.startSeconds, item.startSeconds, tolerance) &&
      sameTime(candidate.clip?.endSeconds, item.endSeconds, tolerance)
    );
    if (!match) {
      failures.push({
        kind: 'expected_target_clip_missing',
        trackKind: kind,
        manifestIndex: item.manifestIndex,
        name: item.name,
        expectedStartSeconds: item.startSeconds,
        expectedEndSeconds: item.endSeconds,
      });
      continue;
    }
    match.used = true;
    matched.push({
      manifestIndex: item.manifestIndex,
      name: item.name,
      startSeconds: numeric(match.clip.startSeconds),
      endSeconds: numeric(match.clip.endSeconds),
    });
  }

  const unexpected = additions.filter((candidate) => !candidate.used);
  if (unexpected.length > 0) {
    failures.push({
      kind: 'unexpected_target_clips',
      trackKind: kind,
      clips: unexpected.map((candidate) => canonicalClip(candidate.clip, { includeIndex: false })),
    });
  }
  return matched;
}

export function verifyImportBatchReadback({
  original,
  post,
  cumulativeItems,
  videoTrackIndex,
  audioTrackIndex,
}) {
  const failures = [];
  const items = Array.isArray(cumulativeItems) ? cumulativeItems : [];
  const originalState = original?.state;
  const originalSummary = original?.summary;
  const originalStructure = original?.structure;
  const postState = post?.state;
  const postSummary = post?.summary;
  const postStructure = post?.structure;

  if (!originalState || !originalSummary || !originalStructure) {
    failures.push({ kind: 'invalid_original_snapshot' });
  }
  if (!postState || !postSummary || !postStructure) {
    failures.push({ kind: 'incomplete_post_read' });
  }
  if (failures.length > 0) return { ok: false, failures };

  const expectedProjectName = String(originalState.project?.name ?? '');
  const expectedProjectPath = String(originalState.project?.path ?? '');
  const actualProjectName = String(postState.project?.name ?? '');
  const actualProjectPath = String(postState.project?.path ?? '');
  if (!expectedProjectName || !actualProjectName || actualProjectName !== expectedProjectName) {
    failures.push({
      kind: 'project_identity_changed',
      expected: expectedProjectName || null,
      actual: actualProjectName || null,
    });
  }
  if (expectedProjectPath && actualProjectPath !== expectedProjectPath) {
    failures.push({
      kind: 'project_path_changed',
      expected: expectedProjectPath,
      actual: actualProjectPath || null,
    });
  }

  const expectedSequenceName = String(originalStructure.name ?? '');
  const expectedSequenceId = String(originalStructure.id ?? '');
  for (const [field, value] of [
    ['summary.name', postSummary.name],
    ['structure.name', postStructure.name],
  ]) {
    if (!expectedSequenceName || String(value ?? '') !== expectedSequenceName) {
      failures.push({ kind: 'sequence_identity_changed', field, expected: expectedSequenceName, actual: value ?? null });
    }
  }
  for (const [field, value] of [
    ['summary.id', postSummary.id],
    ['structure.id', postStructure.id],
  ]) {
    if (!expectedSequenceId || String(value ?? '') !== expectedSequenceId) {
      failures.push({ kind: 'sequence_identity_changed', field, expected: expectedSequenceId, actual: value ?? null });
    }
  }
  if (
    String(postSummary.name ?? '') !== String(postStructure.name ?? '') ||
    String(postSummary.id ?? '') !== String(postStructure.id ?? '')
  ) {
    failures.push({ kind: 'summary_structure_identity_mismatch' });
  }

  const frameSeconds = Number(originalSummary.frameRate?.seconds);
  const tolerance = Math.max(
    0.001,
    Number.isFinite(frameSeconds) && frameSeconds > 0 ? frameSeconds * 0.55 : 0,
  );
  const originalDuration = Number(originalStructure.durationSeconds);
  const lastExpectedEnd = items.length > 0 ? Number(items.at(-1).endSeconds) : originalDuration;
  const expectedDuration = Math.max(originalDuration, lastExpectedEnd);
  for (const [field, value] of [
    ['summary.durationSeconds', postSummary.durationSeconds],
    ['structure.durationSeconds', postStructure.durationSeconds],
  ]) {
    if (!sameTime(value, expectedDuration, tolerance)) {
      failures.push({
        kind: 'duration_mismatch',
        field,
        expected: expectedDuration,
        actual: Number.isFinite(Number(value)) ? Number(value) : null,
        tolerance,
      });
    }
  }
  if (!sameTime(postSummary.durationSeconds, postStructure.durationSeconds, tolerance)) {
    failures.push({ kind: 'summary_structure_duration_mismatch' });
  }

  const expectedVideoClipCount = totalClipCount(originalStructure, 'video') + items.length;
  const expectedAudioClipCount = totalClipCount(originalStructure, 'audio') + items.length;
  const actualVideoClipCount = totalClipCount(postStructure, 'video');
  const actualAudioClipCount = totalClipCount(postStructure, 'audio');
  for (const [kind, expected, actual, summaryActual] of [
    ['video', expectedVideoClipCount, actualVideoClipCount, Number(postSummary.totalVideoClips)],
    ['audio', expectedAudioClipCount, actualAudioClipCount, Number(postSummary.totalAudioClips)],
  ]) {
    if (actual !== expected) {
      failures.push({ kind: 'cumulative_clip_count_mismatch', trackKind: kind, expected, actual });
    }
    if (!Number.isInteger(summaryActual) || summaryActual !== expected) {
      failures.push({
        kind: 'summary_clip_count_mismatch',
        trackKind: kind,
        expected,
        actual: Number.isFinite(summaryActual) ? summaryActual : null,
      });
    }
  }

  const beforeVideo = trackMap(originalStructure, 'video', failures, 'before');
  const beforeAudio = trackMap(originalStructure, 'audio', failures, 'before');
  const afterVideo = trackMap(postStructure, 'video', failures, 'after');
  const afterAudio = trackMap(postStructure, 'audio', failures, 'after');
  const targetKeys = new Set([`video:${videoTrackIndex}`, `audio:${audioTrackIndex}`]);
  const addedItems = { video: [], audio: [] };

  for (const [kind, beforeMap, afterMap] of [
    ['video', beforeVideo, afterVideo],
    ['audio', beforeAudio, afterAudio],
  ]) {
    const beforeKeys = [...beforeMap.keys()].sort((left, right) => left - right);
    const afterKeys = [...afterMap.keys()].sort((left, right) => left - right);
    if (!sameJson(beforeKeys, afterKeys)) {
      failures.push({ kind: 'track_set_changed', trackKind: kind, before: beforeKeys, after: afterKeys });
    }
    for (const index of new Set([...beforeKeys, ...afterKeys])) {
      const beforeTrack = beforeMap.get(index);
      const afterTrack = afterMap.get(index);
      if (!beforeTrack || !afterTrack) continue;
      const key = `${kind}:${index}`;
      if (!targetKeys.has(key)) {
        if (!sameJson(canonicalTrack(beforeTrack), canonicalTrack(afterTrack))) {
          failures.push({ kind: 'non_target_track_changed', trackKind: kind, trackIndex: index });
        }
        continue;
      }
      addedItems[kind] = verifyTargetTrackAdditions({
        beforeTrack,
        afterTrack,
        expectedItems: items,
        kind,
        tolerance,
        failures,
      });
    }
  }

  if (!beforeVideo.has(videoTrackIndex) || !afterVideo.has(videoTrackIndex)) {
    failures.push({ kind: 'target_track_missing', trackKind: 'video', trackIndex: videoTrackIndex });
  }
  if (!beforeAudio.has(audioTrackIndex) || !afterAudio.has(audioTrackIndex)) {
    failures.push({ kind: 'target_track_missing', trackKind: 'audio', trackIndex: audioTrackIndex });
  }

  return {
    ok: failures.length === 0,
    failures,
    toleranceSeconds: tolerance,
    expectedDurationSeconds: expectedDuration,
    observedDurationSeconds: Number(postStructure.durationSeconds),
    expectedVideoClipCount,
    observedVideoClipCount: actualVideoClipCount,
    expectedAudioClipCount,
    observedAudioClipCount: actualAudioClipCount,
    addedItems,
  };
}

export function createImportMicroBatchPlan(items, batchSize) {
  const size = resolvePremiereBatchSize(batchSize);
  const batches = partitionPremiereMicroBatches(items, size).map((batch) => ({
    ...batch,
    cumulativeItems: items.slice(0, batch.endIndex),
    manifestStartIndex: batch.items[0]?.manifestIndex ?? null,
    manifestEndIndex: batch.items.length > 0
      ? batch.items.at(-1).manifestIndex + 1
      : null,
  }));
  return {
    batchSize: size,
    batchCount: batches.length,
    itemCount: items.length,
    batches,
  };
}

function errorDetails(error) {
  return {
    name: String(error?.name ?? 'Error'),
    message: String(error?.message ?? error),
  };
}

function reasonForStage(stage, error) {
  if (/timed out|timeout/i.test(String(error?.message ?? error))) return 'timeout';
  if (stage === 'read') return 'read_failed';
  if (stage === 'verify') return 'verification_failed';
  if (stage === 'pause') return 'pause_failed';
  return 'write_response_failed';
}

export async function runImportMicroBatches({
  plan,
  batchPauseMs,
  importBatch = null,
  placeItem,
  readAfterBatch,
  verifyBatch,
  pauseBetweenBatches = waitForPremiereUi,
}) {
  if (!plan || !Array.isArray(plan.batches)) throw new TypeError('plan.batches is required');
  if (typeof placeItem !== 'function') throw new TypeError('placeItem is required');
  if (typeof readAfterBatch !== 'function') throw new TypeError('readAfterBatch is required');
  if (typeof verifyBatch !== 'function') throw new TypeError('verifyBatch is required');
  const pauseMs = resolvePremiereBatchPauseMs(batchPauseMs);
  const batchResults = [];
  const verifiedBatches = [];
  const verifiedItems = [];
  let writeAttemptCount = 0;
  let pauseCount = 0;
  let stop = null;

  for (let batchIndex = 0; batchIndex < plan.batches.length; batchIndex += 1) {
    const batch = plan.batches[batchIndex];
    const record = {
      batchIndex: batch.batchIndex,
      batchNumber: batch.batchNumber,
      manifestStartIndex: batch.manifestStartIndex,
      manifestEndIndex: batch.manifestEndIndex,
      itemCount: batch.items.length,
      importAttempted: false,
      importSkipped: importBatch === null,
      importResponse: null,
      items: [],
      postReadSucceeded: false,
      verification: null,
      verified: false,
      pauseAfterBatchMs: null,
    };
    batchResults.push(record);
    let stage = 'import';

    try {
      if (importBatch) {
        record.importAttempted = true;
        writeAttemptCount += 1;
        record.importResponse = await importBatch(batch);
      }

      stage = 'place';
      for (const item of batch.items) {
        const itemResult = {
          item,
          writeAttempted: true,
          response: null,
          verified: false,
        };
        record.items.push(itemResult);
        writeAttemptCount += 1;
        itemResult.response = await placeItem(item, batch);
      }

      stage = 'read';
      record.postRead = await readAfterBatch(batch);
      record.postReadSucceeded = true;

      stage = 'verify';
      record.verification = await verifyBatch(batch, record.postRead);
      if (!record.verification?.ok) {
        stop = {
          reason: 'invariant_failed',
          stage,
          batchIndex: batch.batchIndex,
          batchNumber: batch.batchNumber,
          manifestStartIndex: batch.manifestStartIndex,
          manifestEndIndex: batch.manifestEndIndex,
          writeMayHaveApplied: true,
          verification: record.verification ?? null,
        };
        break;
      }

      record.verified = true;
      record.items.forEach((item) => {
        item.verified = true;
      });
      verifiedBatches.push(record);
      verifiedItems.push(...batch.items);
    } catch (error) {
      stop = {
        reason: reasonForStage(stage, error),
        stage,
        batchIndex: batch.batchIndex,
        batchNumber: batch.batchNumber,
        manifestStartIndex: batch.manifestStartIndex,
        manifestEndIndex: batch.manifestEndIndex,
        writeMayHaveApplied: stage !== 'pause',
        error: errorDetails(error),
      };
      break;
    }

    if (batchIndex < plan.batches.length - 1) {
      try {
        await pauseBetweenBatches(pauseMs, batch);
        pauseCount += 1;
        record.pauseAfterBatchMs = pauseMs;
      } catch (error) {
        stop = {
          reason: reasonForStage('pause', error),
          stage: 'pause',
          batchIndex: batch.batchIndex,
          batchNumber: batch.batchNumber,
          manifestStartIndex: batch.manifestEndIndex,
          manifestEndIndex: batch.manifestEndIndex,
          writeMayHaveApplied: false,
          error: errorDetails(error),
        };
        break;
      }
    }
  }

  const ok = stop === null && verifiedBatches.length === plan.batches.length;
  return {
    ok,
    outcome: ok ? 'complete' : 'stopped',
    batchPauseMs: pauseMs,
    completedBatchCount: verifiedBatches.length,
    verifiedItemCount: verifiedItems.length,
    writeAttemptCount,
    writeResent: false,
    pauseCount,
    verifiedBatches,
    verifiedItems,
    batchResults,
    stop,
  };
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function findTrack(structure, kind, index) {
  const field = kind === 'video' ? 'videoTracks' : 'audioTracks';
  return (structure?.[field] ?? []).find((track) => Number(track?.index) === index) ?? null;
}

function buildPlacementItems(entries, startSeconds) {
  let cursor = startSeconds;
  return entries.map((entry) => {
    const item = {
      ...entry,
      startSeconds: cursor,
      endSeconds: cursor + entry.probe.durationSeconds,
      durationSeconds: entry.probe.durationSeconds,
    };
    cursor = item.endSeconds;
    return item;
  });
}

function assertNoTargetOverlap(structure, items, videoTrackIndex, audioTrackIndex, tolerance) {
  for (const [kind, index] of [
    ['video', videoTrackIndex],
    ['audio', audioTrackIndex],
  ]) {
    const track = findTrack(structure, kind, index);
    if (!track) throw new Error(`Target ${kind} track ${index} does not exist`);
    for (const item of items) {
      const overlaps = (track.clips ?? []).filter((clip) =>
        Number(clip.endSeconds) > item.startSeconds + tolerance &&
        Number(clip.startSeconds) < item.endSeconds - tolerance
      );
      if (overlaps.length > 0) {
        throw new Error(
          `Target ${kind} track ${index} is occupied at ${item.startSeconds}-${item.endSeconds}: ` +
          overlaps.map((clip) => `${clip.name}@${clip.startSeconds}`).join(', '),
        );
      }
    }
  }
}

async function readLiveSnapshot(client) {
  const state = await callToolOnce(client, 'get_premiere_state');
  const summary = await callToolOnce(client, 'get_timeline_summary');
  const structure = await callToolOnce(client, 'get_sequence_structure');
  return { state, summary, structure };
}

function publicItem(item) {
  return {
    manifestIndex: item.manifestIndex,
    name: item.name,
    file: item.file,
    startSeconds: numeric(item.startSeconds),
    endSeconds: numeric(item.endSeconds),
    durationSeconds: numeric(item.durationSeconds),
  };
}

function publicBatch(record) {
  return {
    batchIndex: record.batchIndex,
    batchNumber: record.batchNumber,
    manifestStartIndex: record.manifestStartIndex,
    manifestEndIndex: record.manifestEndIndex,
    itemCount: record.itemCount,
    importAttempted: record.importAttempted,
    importSkipped: record.importSkipped,
    importResponseReceived: record.importAttempted ? record.importResponse !== null : null,
    placementAttemptCount: record.items.length,
    items: record.items.map((entry) => ({
      ...publicItem(entry.item),
      responseReceived: entry.response !== null,
      verified: entry.verified,
    })),
    postReadSucceeded: record.postReadSucceeded,
    verified: record.verified,
    pauseAfterBatchMs: record.pauseAfterBatchMs,
    verification: record.verification,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.manifest) throw new Error('Missing --manifest');

  const batchSize = resolvePremiereBatchSize(args.batchSize);
  const batchPauseMs = resolvePremiereBatchPauseMs(args.batchPauseMs);
  requireNonNegativeInteger(args.trackIndex, '--track-index');
  requireNonNegativeInteger(args.audioTrackIndex, '--audio-track-index');

  const manifest = JSON.parse(await fs.readFile(args.manifest, 'utf8'));
  const allClips = Array.isArray(manifest.clips) ? manifest.clips : [];
  const requestedStartIndex = args.startIndex === undefined
    ? 0
    : requireNonNegativeInteger(args.startIndex, '--start-index');
  const requestedEndIndex = args.endIndex === undefined
    ? allClips.length
    : requireNonNegativeInteger(args.endIndex, '--end-index');
  if (requestedStartIndex > allClips.length) {
    throw new Error(`--start-index ${requestedStartIndex} exceeds manifest length ${allClips.length}`);
  }
  const startIndex = requestedStartIndex;
  const endIndex = Math.min(requestedEndIndex, allClips.length);
  if (endIndex <= startIndex) {
    throw new Error(`Manifest selection is empty: [${startIndex}, ${endIndex})`);
  }

  // Finish every local probe before acquiring the CEP lock or connecting to Premiere.
  const entries = [];
  for (let manifestIndex = startIndex; manifestIndex < endIndex; manifestIndex += 1) {
    const clip = allClips[manifestIndex];
    if (!clip?.output) throw new Error(`Manifest clip ${manifestIndex} has no output path`);
    const file = path.resolve(clip.output);
    const probe = await probeMediaFile(file);
    entries.push({
      manifestIndex,
      clip,
      file,
      name: path.basename(file),
      probe,
    });
  }

  const serverPath = path.join(args.mcpRoot, 'dist', 'index.js');
  const { Client, StdioClientTransport } = await importMcpClient(args.mcpRoot);
  const client = new Client(
    { name: 'premiere-audio-active-import', version: '2.0.0' },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: {
      ...process.env,
      PREMIERE_TEMP_DIR: args.tempDir,
    },
  });
  const cepLock = await acquirePremiereCepLock({
    bridgeDirectory: args.tempDir,
    tool: 'import-audio-active-clips',
    metadata: {
      mode: 'verified-microbatch-timeline-write',
      batchSize,
      batchPauseMs,
      manifestStartIndex: startIndex,
      manifestEndIndex: endIndex,
    },
  });
  const lifecycle = createPremiereCepLifecycle({ lock: cepLock });
  const session = lifecycle.registerSession({
    client,
    transport,
    label: 'premiere-audio-active-import',
  });
  const removeSignalHandlers = installPremiereCepSignalHandlers(() =>
    lifecycle.cleanup(),
  );

  let output = null;
  try {
    await lifecycle.connectSession(session);
    const original = await readLiveSnapshot(client);
    const selfCheck = verifyImportBatchReadback({
      original,
      post: original,
      cumulativeItems: [],
      videoTrackIndex: args.trackIndex,
      audioTrackIndex: args.audioTrackIndex,
    });
    if (!selfCheck.ok) {
      throw new Error(`Initial Premiere snapshot is inconsistent: ${JSON.stringify(selfCheck.failures)}`);
    }

    const startSeconds = args.startSeconds === undefined
      ? Number(original.summary.durationSeconds)
      : Number(args.startSeconds);
    if (!Number.isFinite(startSeconds) || startSeconds < 0) {
      throw new Error('--start-seconds must be a non-negative finite number');
    }
    const items = buildPlacementItems(entries, startSeconds);
    assertNoTargetOverlap(
      original.structure,
      items,
      args.trackIndex,
      args.audioTrackIndex,
      selfCheck.toleranceSeconds,
    );
    const plan = createImportMicroBatchPlan(items, batchSize);

    const run = await runImportMicroBatches({
      plan,
      batchPauseMs,
      importBatch: args.importMedia
        ? async (batch) => callToolOnce(client, 'import_media', {
          file_paths: batch.items.map((item) => item.file),
          suppress_ui: true,
          ...(args.targetBin ? { target_bin: args.targetBin } : {}),
        })
        : null,
      placeItem: async (item) => callToolOnce(client, 'add_to_timeline', {
        item_id: item.name,
        track_index: args.trackIndex,
        audio_track_index: args.audioTrackIndex,
        start_seconds: item.startSeconds,
      }),
      readAfterBatch: async () => readLiveSnapshot(client),
      verifyBatch: async (batch, post) => verifyImportBatchReadback({
        original,
        post,
        cumulativeItems: batch.cumulativeItems,
        videoTrackIndex: args.trackIndex,
        audioTrackIndex: args.audioTrackIndex,
      }),
    });

    const remainingItems = items.slice(run.verifiedItemCount);
    const remainingStartIndex = remainingItems[0]?.manifestIndex ?? endIndex;
    const lastVerifiedBatch = run.verifiedBatches.at(-1) ?? null;
    output = {
      ok: run.ok,
      outcome: run.outcome,
      imported: args.importMedia,
      writeResent: false,
      batchSize,
      batchPauseMs,
      batchCount: plan.batchCount,
      completedBatchCount: run.completedBatchCount,
      remainingBatchCount: plan.batchCount - run.completedBatchCount,
      pauseCount: run.pauseCount,
      writeAttemptCount: run.writeAttemptCount,
      projectName: String(original.state.project?.name ?? ''),
      projectPath: String(original.state.project?.path ?? '') || null,
      activeSequence: String(original.structure.name ?? ''),
      activeSequenceId: String(original.structure.id ?? ''),
      groupStart: manifest.groupStart,
      groupEnd: manifest.groupEnd,
      manifestStartIndex: startIndex,
      manifestEndIndex: endIndex,
      selectedItemCount: items.length,
      probedItemCount: entries.length,
      beforeDurationSeconds: Number(original.structure.durationSeconds),
      placementStartSeconds: startSeconds,
      expectedEndSeconds: numeric(items.at(-1)?.endSeconds),
      afterVerifiedDurationSeconds: lastVerifiedBatch
        ? Number(lastVerifiedBatch.postRead.structure.durationSeconds)
        : Number(original.structure.durationSeconds),
      verifiedBatchCount: run.completedBatchCount,
      verifiedItemCount: run.verifiedItemCount,
      verifiedItems: run.verifiedItems.map(publicItem),
      verifiedBatches: run.verifiedBatches.map(publicBatch),
      batches: run.batchResults.map(publicBatch),
      remainingSuffix: {
        startIndex: remainingStartIndex,
        endIndex,
        count: remainingItems.length,
        items: remainingItems.map(publicItem),
        requiresLiveReadBeforeResume: Boolean(run.stop?.writeMayHaveApplied),
      },
      stop: run.stop
        ? {
          ...run.stop,
          resumeStartIndex: remainingStartIndex,
          warning: run.stop.writeMayHaveApplied
            ? 'The failed batch is unverified. Read the live timeline before choosing a resume suffix; do not resend it blindly.'
            : null,
        }
        : null,
    };
  } finally {
    try {
      await lifecycle.cleanup();
    } finally {
      removeSignalHandlers();
    }
  }

  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) process.exitCode = 1;
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      outcome: 'failed_before_verified_output',
      writeResent: false,
      error: errorDetails(error),
    }, null, 2));
    process.exitCode = 1;
  });
}
