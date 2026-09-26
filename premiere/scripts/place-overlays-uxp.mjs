#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CALL_TOOL = path.join(ROOT, 'servers', 'premiere-uxp-mcp', 'call-tool.mjs');
const MCP_LOG_PREFIX = '[deno-premiere-uxp-mcp]';
const TIME_EPSILON_SECONDS = 0.001;

function usage() {
  return [
    'Usage: node scripts/place-overlays-uxp.mjs <manifest.json> [options]',
    '',
    'Options:',
    '  --report <path>       Save the result JSON at this path',
    '  --bridge-dir <path>   Forward a custom bridge directory to call-tool.mjs',
    '  --timeout-ms <ms>     Per-tool timeout (default: 180000)',
    '  --no-import           Reuse already imported project items by exact name + path',
    '  -h, --help            Show this help',
    '',
    'Manifest paths are resolved relative to the manifest file.',
    'This command performs Premiere writes and always forwards --allow-write.',
  ].join('\n');
}

function requireOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

export function parseCliArgs(argv) {
  const options = {timeoutMs: 180_000};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--report') {
      options.report = requireOptionValue(argv, index, value);
      index += 1;
    } else if (value === '--bridge-dir') {
      options.bridgeDir = requireOptionValue(argv, index, value);
      index += 1;
    } else if (value === '--timeout-ms') {
      options.timeoutMs = Number(requireOptionValue(argv, index, value));
      index += 1;
      if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
        throw new Error('--timeout-ms must be a positive integer.');
      }
    } else if (value === '--no-import') {
      options.noImport = true;
    } else if (value === '--help' || value === '-h') {
      options.help = true;
    } else if (value.startsWith('--')) {
      throw new Error(`Unknown option: ${value}`);
    } else {
      positional.push(value);
    }
  }
  if (positional.length > 1) {
    throw new Error(`Unexpected positional arguments: ${positional.slice(1).join(' ')}`);
  }
  return {manifestPath: positional[0], options};
}

export function stripMcpLogLines(output) {
  return String(output ?? '')
    .split(/\r?\n/u)
    .filter((line) => !line.includes(MCP_LOG_PREFIX))
    .join('\n')
    .trim();
}

export function parseMcpJson(output) {
  const filtered = stripMcpLogLines(output);
  if (!filtered) {
    throw new Error('UXP tool returned no JSON after MCP log filtering.');
  }
  try {
    return JSON.parse(filtered);
  } catch (error) {
    throw new Error(`Could not parse UXP tool JSON: ${error.message}`);
  }
}

function safeErrorText(error) {
  return String(error?.message || error || 'Unknown error').slice(0, 8_000);
}

export function isResponseReadFailure(error) {
  return /EBUSY|INVALID_RESPONSE|Could not parse UXP (?:response|tool JSON)/i.test(
    safeErrorText(error),
  );
}

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = stripMcpLogLines(result.stderr);
    const stdout = stripMcpLogLines(result.stdout);
    const detail = stderr || stdout || `exit ${result.status}`;
    throw new Error(`${command} failed: ${detail.slice(0, 8_000)}`);
  }
  return result.stdout;
}

function sleepMs(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

function callUxpTool(toolName, args, options) {
  const commandArgs = [
    CALL_TOOL,
    toolName,
    JSON.stringify(args),
    '--allow-write',
    '--timeout-ms',
    String(options.timeoutMs),
  ];
  if (options.bridgeDir) {
    commandArgs.push('--bridge-dir', path.resolve(options.bridgeDir));
  }
  // 브리지 응답 파일 읽기가 간헐 EBUSY로 튕긴다(2026-07-22 실측 —
  // 백신 스캔 등 외부 잠금으로 추정, 같은 호출 재시도로 해소됨).
  // **읽기 전용 도구만** 자동 재시도한다. 쓰기 도구는 실행됐는데 응답만
  // 못 읽은 경우 재시도가 이중 배치(리플 사고)를 만들 수 있으므로
  // 즉시 중단하고 사람이 상태 확인 후 재실행한다(§11-A 정신).
  const retryable = /^(get_|find_|list_|ping$)/.test(toolName);
  const maxAttempts = retryable ? 3 : 1;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const stdout = runProcess('node', commandArgs, {
        timeoutMs: options.timeoutMs + 5_000,
      });
      return parseMcpJson(stdout);
    } catch (error) {
      lastError = error;
      const transient = /EBUSY|INVALID_RESPONSE|Could not parse UXP response/i.test(
        String(error?.message || ''),
      );
      if (!transient || attempt === maxAttempts) throw error;
      sleepMs(700 * attempt);
    }
  }
  throw lastError;
}

function readJson(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${safeErrorText(error)}`);
  }
  return parsed;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateManifest(raw, manifestPath) {
  if (!isPlainObject(raw)) throw new Error('Manifest must be a JSON object.');
  const allowedTopLevel = new Set(['sequenceCheck', 'items']);
  const unknownTopLevel = Object.keys(raw).filter((key) => !allowedTopLevel.has(key));
  if (unknownTopLevel.length > 0) {
    throw new Error(`Unknown manifest fields: ${unknownTopLevel.join(', ')}`);
  }
  if (raw.sequenceCheck !== undefined) {
    if (!isPlainObject(raw.sequenceCheck)) {
      throw new Error('sequenceCheck must be an object.');
    }
    const unknownChecks = Object.keys(raw.sequenceCheck).filter((key) => key !== 'name');
    if (unknownChecks.length > 0) {
      throw new Error(`Unknown sequenceCheck fields: ${unknownChecks.join(', ')}`);
    }
    if (
      raw.sequenceCheck.name !== undefined &&
      (typeof raw.sequenceCheck.name !== 'string' || !raw.sequenceCheck.name.trim())
    ) {
      throw new Error('sequenceCheck.name must be a non-empty string.');
    }
  }
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    throw new Error('Manifest items must be a non-empty array.');
  }

  const manifestDir = path.dirname(manifestPath);
  const items = raw.items.map((item, index) => {
    if (!isPlainObject(item)) throw new Error(`items[${index}] must be an object.`);
    const allowed = new Set(['file', 'track_index', 'start_seconds']);
    const unknown = Object.keys(item).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw new Error(`Unknown items[${index}] fields: ${unknown.join(', ')}`);
    }
    if (typeof item.file !== 'string' || !item.file.trim()) {
      throw new Error(`items[${index}].file must be a non-empty string.`);
    }
    if (!Number.isInteger(item.track_index) || item.track_index < 0) {
      throw new Error(`items[${index}].track_index must be a non-negative integer.`);
    }
    if (
      typeof item.start_seconds !== 'number' ||
      !Number.isFinite(item.start_seconds) ||
      item.start_seconds < 0
    ) {
      throw new Error(`items[${index}].start_seconds must be a non-negative number.`);
    }
    return {
      sourceIndex: index,
      file: item.file,
      filePath: path.resolve(manifestDir, item.file),
      trackIndex: item.track_index,
      startSeconds: item.start_seconds,
    };
  });

  return {
    sequenceName: raw.sequenceCheck?.name?.trim() || null,
    items,
  };
}

function normalizeMediaPath(value) {
  return path
    .resolve(String(value || ''))
    .replace(/^\\\\\?\\/u, '')
    .replace(/\//gu, '\\')
    .toLocaleLowerCase();
}

function uniqueSources(items) {
  const byPath = new Map();
  for (const item of items) {
    const key = normalizeMediaPath(item.filePath);
    if (!byPath.has(key)) byPath.set(key, item.filePath);
  }
  return Array.from(byPath.values());
}

function assertUniqueSourceBasenames(sources) {
  const byName = new Map();
  for (const source of sources) {
    const name = path.basename(source);
    const key = name.toLocaleLowerCase();
    if (byName.has(key)) {
      throw new Error(
        `Overlay basenames must be unique for verified name lookup: ` +
          `${byName.get(key)} / ${source}`,
      );
    }
    byName.set(key, source);
  }
}

function probeNoAudio(filePath, timeoutMs) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`Overlay file does not exist: ${filePath}`);
  }
  const stdout = runProcess(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'stream=index,codec_type,codec_name:format=duration',
      '-of',
      'json',
      filePath,
    ],
    {timeoutMs},
  );
  const probe = JSON.parse(stdout);
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const audioStreams = streams.filter((stream) => stream.codec_type === 'audio');
  const videoStreams = streams.filter((stream) => stream.codec_type === 'video');
  if (audioStreams.length !== 0) {
    throw new Error(`Audio stream safety check failed (${audioStreams.length} found): ${filePath}`);
  }
  if (videoStreams.length !== 1) {
    throw new Error(`Video stream safety check failed (${videoStreams.length} found): ${filePath}`);
  }
  const durationSeconds = Number(probe.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Invalid overlay duration (${probe.format?.duration}): ${filePath}`);
  }
  return {
    file: filePath,
    audioStreamCount: 0,
    videoStreamCount: 1,
    durationSeconds,
  };
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), {recursive: true});
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function reportPaths(manifestPath, requestedReportPath) {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const defaultReport = path.join(
    ROOT,
    'reports',
    'premiere-uxp-overlay-placement',
    `${path.basename(manifestPath, path.extname(manifestPath))}-${timestamp}.json`,
  );
  const reportPath = path.resolve(requestedReportPath || defaultReport);
  const parsed = path.parse(reportPath);
  return {
    reportPath,
    preSnapshotPath: path.join(parsed.dir, `${parsed.name}.pre-snapshot.json`),
    postSnapshotPath: path.join(parsed.dir, `${parsed.name}.post-snapshot.json`),
  };
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function clipSummary(clip) {
  return {
    name: String(clip?.name || ''),
    startSeconds: Number(clip?.startSeconds),
    endSeconds: Number(clip?.endSeconds),
  };
}

function sameTime(left, right) {
  return Math.abs(Number(left) - Number(right)) <= TIME_EPSILON_SECONDS;
}

function sameClip(left, right) {
  return (
    String(left?.name || '') === String(right?.name || '') &&
    sameTime(left?.startSeconds, right?.startSeconds) &&
    sameTime(left?.endSeconds, right?.endSeconds)
  );
}

function expectedMatchesClip(expected, clip) {
  if (expected.itemName !== String(clip?.name || '')) return false;
  if (!sameTime(expected.startSeconds, clip?.startSeconds)) return false;
  if (finiteNumber(expected.durationSeconds) && expected.durationSeconds > 0) {
    return sameTime(expected.startSeconds + expected.durationSeconds, clip?.endSeconds);
  }
  return Number(clip?.endSeconds) > Number(clip?.startSeconds);
}

function trackKey(kind, index) {
  return `${kind}:${index}`;
}

function collectTracks(snapshot) {
  const result = new Map();
  for (const kind of ['video', 'audio']) {
    const field = kind === 'video' ? 'videoTracks' : 'audioTracks';
    for (const track of Array.isArray(snapshot?.[field]) ? snapshot[field] : []) {
      result.set(trackKey(kind, Number(track.index)), {kind, ...track});
    }
  }
  return result;
}

export function diffSequenceStructures(before, after, expectedAdditions) {
  const beforeTracks = collectTracks(before);
  const afterTracks = collectTracks(after);
  const expectedByTrack = new Map();
  for (const expected of expectedAdditions) {
    const key = trackKey('video', expected.trackIndex);
    if (!expectedByTrack.has(key)) expectedByTrack.set(key, []);
    expectedByTrack.get(key).push(expected);
  }

  const failures = [];
  const additions = [];
  if (String(before?.id || '') !== String(after?.id || '')) {
    failures.push({kind: 'sequence_identity_changed', before: before?.id, after: after?.id});
  }
  if (String(before?.name || '') !== String(after?.name || '')) {
    failures.push({kind: 'sequence_name_changed', before: before?.name, after: after?.name});
  }
  if (
    !finiteNumber(before?.durationSeconds) ||
    !finiteNumber(after?.durationSeconds) ||
    !sameTime(before.durationSeconds, after.durationSeconds)
  ) {
    failures.push({
      kind: 'sequence_duration_changed',
      before: before?.durationSeconds ?? null,
      after: after?.durationSeconds ?? null,
    });
  }

  const keys = new Set([...beforeTracks.keys(), ...afterTracks.keys(), ...expectedByTrack.keys()]);
  for (const key of Array.from(keys).sort()) {
    const beforeTrack = beforeTracks.get(key);
    const afterTrack = afterTracks.get(key);
    const expected = expectedByTrack.get(key) || [];
    if (!beforeTrack || !afterTrack) {
      failures.push({
        kind: 'track_set_changed',
        track: key,
        existedBefore: Boolean(beforeTrack),
        existsAfter: Boolean(afterTrack),
      });
      continue;
    }
    if (String(beforeTrack.name || '') !== String(afterTrack.name || '')) {
      failures.push({
        kind: 'track_name_changed',
        track: key,
        before: beforeTrack.name,
        after: afterTrack.name,
      });
    }

    const beforeClips = Array.isArray(beforeTrack.clips) ? beforeTrack.clips : [];
    const afterClips = Array.isArray(afterTrack.clips) ? afterTrack.clips : [];
    const unusedAfter = new Set(afterClips.map((_clip, index) => index));

    for (const oldClip of beforeClips) {
      const matchIndex = Array.from(unusedAfter).find((index) =>
        sameClip(oldClip, afterClips[index]),
      );
      if (matchIndex === undefined) {
        failures.push({
          kind: 'existing_clip_changed_or_missing',
          track: key,
          before: clipSummary(oldClip),
        });
      } else {
        unusedAfter.delete(matchIndex);
      }
    }

    const newClips = Array.from(unusedAfter, (index) => afterClips[index]);
    const unusedNew = new Set(newClips.map((_clip, index) => index));
    for (const expectedClip of expected) {
      const matchIndex = Array.from(unusedNew).find((index) =>
        expectedMatchesClip(expectedClip, newClips[index]),
      );
      if (matchIndex === undefined) {
        failures.push({
          kind: 'expected_addition_missing_or_changed',
          track: key,
          expected: {
            name: expectedClip.itemName,
            startSeconds: expectedClip.startSeconds,
            endSeconds: finiteNumber(expectedClip.durationSeconds)
              ? expectedClip.startSeconds + expectedClip.durationSeconds
              : null,
          },
        });
      } else {
        const actual = newClips[matchIndex];
        additions.push({track: key, ...clipSummary(actual)});
        unusedNew.delete(matchIndex);
      }
    }
    for (const index of unusedNew) {
      failures.push({
        kind: 'unexpected_clip_added',
        track: key,
        after: clipSummary(newClips[index]),
      });
    }
  }

  return {
    ok: failures.length === 0 && additions.length === expectedAdditions.length,
    checkedTrackCount: keys.size,
    expectedAdditionCount: expectedAdditions.length,
    verifiedAdditionCount: additions.length,
    additions,
    failures,
  };
}

export function assessPostDiffResponseFailure({
  error,
  failedToolCall,
  requestedPlacementCount,
  intendedTrackIndexes,
  diff,
  preSnapshot,
  postSnapshot,
}) {
  const requestedCount = Number(requestedPlacementCount);
  const intendedTracks = new Set(
    Array.from(intendedTrackIndexes || [], (index) => trackKey('video', Number(index))),
  );
  const additions = Array.isArray(diff?.additions) ? diff.additions : [];
  const failures = Array.isArray(diff?.failures) ? diff.failures : null;
  const checks = {
    responseReadFailure: isResponseReadFailure(error),
    diffOk: diff?.ok === true,
    expectedCountMatchesManifest:
      Number.isInteger(requestedCount) &&
      requestedCount >= 0 &&
      diff?.expectedAdditionCount === requestedCount,
    verifiedCountMatchesManifest:
      Number.isInteger(requestedCount) &&
      requestedCount >= 0 &&
      diff?.verifiedAdditionCount === requestedCount &&
      additions.length === requestedCount,
    diffFailuresEmpty: failures !== null && failures.length === 0,
    onlyIntendedTracksChanged:
      intendedTracks.size > 0 &&
      additions.every((addition) => intendedTracks.has(String(addition?.track || ''))),
    sequenceDurationUnchanged:
      finiteNumber(preSnapshot?.durationSeconds) &&
      finiteNumber(postSnapshot?.durationSeconds) &&
      sameTime(preSnapshot.durationSeconds, postSnapshot.durationSeconds),
  };
  const confirmed = Object.values(checks).every(Boolean);
  return {
    applied: confirmed,
    outcome: confirmed ? 'success' : 'failure',
    reason: confirmed
      ? 'response_read_failed_but_verified_by_full_track_diff'
      : 'post_diff_conditions_not_satisfied',
    message: confirmed
      ? '응답 읽기는 실패했으나 사후 전 트랙 대조로 확인됨.'
      : '응답 읽기 실패 후 사후 전 트랙 대조의 성공 조건을 모두 충족하지 못함.',
    missedToolCall: failedToolCall || null,
    checks,
  };
}

function resolveProjectItemByVerifiedName(found, filePath, durationSeconds) {
  const target = normalizeMediaPath(filePath);
  const expectedName = path.basename(filePath);
  if (String(found?.name || '') !== expectedName) {
    throw new Error(
      `Name lookup mismatch: expected "${expectedName}", got "${String(
        found?.name || '',
      )}".`,
    );
  }
  if (normalizeMediaPath(found?.mediaPath) !== target) {
    throw new Error(
      `Name lookup returned a different media path for "${expectedName}": ` +
        `${String(found?.mediaPath || '')}`,
    );
  }
  if (String(found?.type || '') !== 'clip') {
    throw new Error(
      `Name lookup did not return a clip for "${expectedName}": ${String(
        found?.type || '',
      )}`,
    );
  }
  const itemId = found?.nodeId || found?.id;
  if (!itemId) throw new Error(`Name lookup returned no project item ID: ${filePath}`);
  return {
    itemId: String(itemId),
    itemName: expectedName,
    mediaPath: String(found.mediaPath),
    durationSeconds,
  };
}

function summaryForStdout(report) {
  return {
    ok: report.ok,
    stage: report.stage,
    sequence: report.sequence || null,
    manifest: report.manifest,
    report: report.report,
    preSnapshot: report.preSnapshot,
    postSnapshot: report.postSnapshot || null,
    checkedFileCount: report.checkedFileCount || 0,
    importedSourceCount: report.importedSourceCount || 0,
    reusedImportedSourceCount: report.reusedImportedSourceCount || 0,
    requestedPlacementCount: report.requestedPlacementCount || 0,
    completedPlacementCount: report.completedPlacementCount || 0,
    diff: report.diff || null,
    completionAssessment: report.completionAssessment || null,
    responseReadFailure: report.responseReadFailure || null,
    error: report.error || null,
    recovery: report.recovery || null,
  };
}

async function placeOverlays(manifestPath, options) {
  const resolvedManifest = path.resolve(manifestPath);
  const paths = reportPaths(resolvedManifest, options.report);
  const report = {
    ok: false,
    stage: 'initializing',
    manifest: resolvedManifest,
    report: paths.reportPath,
    preSnapshot: paths.preSnapshotPath,
    postSnapshot: null,
    startedAt: new Date().toISOString(),
    safety: {
      preSnapshotSaved: false,
      audioStreamsRequired: 0,
      projectItemsResolvedByLiveVerifiedNameAndExactPath: true,
      placementOrder: 'start_seconds ascending',
      fullTrackDiff: true,
      perPlacementFullTrackDiff: true,
      importMediaCalled: !options.noImport,
      correctiveEditsOnFailure: false,
      saveProjectCalled: false,
    },
  };
  let timelineWriteAttempted = false;
  let preSnapshot = null;
  let postSnapshot = null;
  let expectedAdditions = [];
  let pendingWriteCall = null;

  try {
    if (!existsSync(resolvedManifest)) throw new Error(`Manifest not found: ${resolvedManifest}`);
    const manifest = validateManifest(readJson(resolvedManifest, 'Manifest'), resolvedManifest);
    report.requestedPlacementCount = manifest.items.length;

    report.stage = 'pre_snapshot';
    preSnapshot = callUxpTool('get_sequence_structure', {}, options);
    writeJson(paths.preSnapshotPath, preSnapshot);
    report.safety.preSnapshotSaved = true;
    report.sequence = {name: preSnapshot.name, id: preSnapshot.id};
    if (manifest.sequenceName && preSnapshot.name !== manifest.sequenceName) {
      throw new Error(
        `Active sequence mismatch: expected "${manifest.sequenceName}", got "${preSnapshot.name}".`,
      );
    }

    report.stage = 'audio_stream_check';
    const sources = uniqueSources(manifest.items);
    assertUniqueSourceBasenames(sources);
    report.audioChecks = sources.map((filePath) => probeNoAudio(filePath, options.timeoutMs));
    report.checkedFileCount = report.audioChecks.length;
    const probeByPath = new Map(
      report.audioChecks.map((check) => [normalizeMediaPath(check.file), check]),
    );

    report.stage = 'import_media';
    report.importedSourceCount = 0;
    report.reusedImportedSourceCount = 0;
    if (options.noImport) {
      // Interrupted runs import every source before placing the first clip.
      // Re-resolve unique basenames and require the returned media path to
      // equal the manifest source exactly; a mismatch fails before timeline
      // writes.
    } else {
      pendingWriteCall = {
        tool: 'import_media',
        sourceCount: sources.length,
      };
      callUxpTool('import_media', {file_paths: sources, suppress_ui: true}, options);
      pendingWriteCall = null;
      report.importedSourceCount = sources.length;
    }

    report.stage = 'resolve_media_by_verified_name';
    const resolvedByPath = new Map();
    for (const source of sources) {
      const found = callUxpTool(
        'find_project_item_by_name',
        {name: path.basename(source)},
        options,
      );
      const probe = probeByPath.get(normalizeMediaPath(source));
      resolvedByPath.set(
        normalizeMediaPath(source),
        resolveProjectItemByVerifiedName(found, source, probe.durationSeconds),
      );
    }
    if (options.noImport) report.reusedImportedSourceCount = sources.length;

    const placements = manifest.items
      .map((item) => ({
        ...item,
        ...resolvedByPath.get(normalizeMediaPath(item.filePath)),
      }))
      .sort((left, right) =>
        left.startSeconds - right.startSeconds || left.sourceIndex - right.sourceIndex,
      );
    expectedAdditions = placements.map((item) => ({
      trackIndex: item.trackIndex,
      startSeconds: item.startSeconds,
      itemName: item.itemName,
      durationSeconds: item.durationSeconds,
      mediaPath: item.mediaPath,
    }));

    report.stage = 'add_to_timeline';
    report.completedPlacementCount = 0;
    report.placements = [];
    report.incrementalDiffs = [];
    for (const [placementIndex, item] of placements.entries()) {
      timelineWriteAttempted = true;
      pendingWriteCall = {
        tool: 'add_to_timeline',
        placementNumber: placementIndex + 1,
        itemName: item.itemName,
        trackIndex: item.trackIndex,
        startSeconds: item.startSeconds,
      };
      const result = callUxpTool(
        'add_to_timeline',
        {
          item_id: item.itemId,
          track_index: item.trackIndex,
          start_seconds: item.startSeconds,
        },
        options,
      );
      pendingWriteCall = null;
      report.completedPlacementCount += 1;
      report.placements.push({
        file: item.filePath,
        itemId: item.itemId,
        itemName: item.itemName,
        trackIndex: item.trackIndex,
        startSeconds: item.startSeconds,
        result,
      });
      report.stage = `verify_placement_${placementIndex + 1}`;
      const incrementalSnapshot = callUxpTool('get_sequence_structure', {}, options);
      const incrementalExpected = expectedAdditions.slice(0, placementIndex + 1);
      const incrementalDiff = diffSequenceStructures(
        preSnapshot,
        incrementalSnapshot,
        incrementalExpected,
      );
      report.incrementalDiffs.push({
        placementNumber: placementIndex + 1,
        ok: incrementalDiff.ok,
        expectedAdditionCount: incrementalDiff.expectedAdditionCount,
        verifiedAdditionCount: incrementalDiff.verifiedAdditionCount,
        failures: incrementalDiff.failures,
      });
      if (!incrementalDiff.ok) {
        postSnapshot = incrementalSnapshot;
        writeJson(paths.postSnapshotPath, postSnapshot);
        report.postSnapshot = paths.postSnapshotPath;
        report.diff = incrementalDiff;
        throw new Error(
          `Full-track diff failed immediately after placement ${placementIndex + 1}.`,
        );
      }
      report.stage = 'add_to_timeline';
    }

    report.stage = 'post_snapshot';
    postSnapshot = callUxpTool('get_sequence_structure', {}, options);
    writeJson(paths.postSnapshotPath, postSnapshot);
    report.postSnapshot = paths.postSnapshotPath;

    report.stage = 'full_track_diff';
    report.diff = diffSequenceStructures(preSnapshot, postSnapshot, expectedAdditions);
    if (!report.diff.ok) {
      throw new Error('Full-track diff found changes outside the intended overlay additions.');
    }

    report.ok = true;
    report.stage = 'complete';
    report.finishedAt = new Date().toISOString();
    writeJson(paths.reportPath, report);
    return report;
  } catch (error) {
    const failedStage = report.stage;
    report.ok = false;
    report.error = {stage: failedStage, message: safeErrorText(error)};
    report.recovery = timelineWriteAttempted
      ? 'No corrective edit or project save was attempted. Inspect the diff; if the project is unsaved, close without saving and reopen before any further write.'
      : 'No timeline correction or project save was attempted.';

    if (timelineWriteAttempted && preSnapshot && !report.postSnapshot) {
      try {
        report.stage = 'failure_post_snapshot';
        postSnapshot = callUxpTool('get_sequence_structure', {}, options);
        writeJson(paths.postSnapshotPath, postSnapshot);
        report.postSnapshot = paths.postSnapshotPath;
        report.diff = diffSequenceStructures(preSnapshot, postSnapshot, expectedAdditions);
      } catch (snapshotError) {
        report.postSnapshotError = safeErrorText(snapshotError);
      }
    }

    if (isResponseReadFailure(error)) {
      const completionAssessment = assessPostDiffResponseFailure({
        error,
        failedToolCall: pendingWriteCall,
        requestedPlacementCount: report.requestedPlacementCount,
        intendedTrackIndexes: expectedAdditions.map((item) => item.trackIndex),
        diff: report.diff,
        preSnapshot,
        postSnapshot,
      });
      report.completionAssessment = completionAssessment;
      if (completionAssessment.applied) {
        report.responseReadFailure = {
          stage: failedStage,
          message: safeErrorText(error),
          missedToolCall: pendingWriteCall,
        };
        report.responseAcknowledgedPlacementCount = report.completedPlacementCount;
        report.completedPlacementCount = report.diff.verifiedAdditionCount;
        delete report.error;
        delete report.recovery;
        report.ok = true;
        report.stage = 'complete';
        report.finishedAt = new Date().toISOString();
        writeJson(paths.reportPath, report);
        return report;
      }
    }

    report.stage = 'failed';
    report.finishedAt = new Date().toISOString();
    writeJson(paths.reportPath, report);
    return report;
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(safeErrorText(error));
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  if (parsed.options.help) {
    console.log(usage());
    return;
  }
  if (!parsed.manifestPath) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const report = await placeOverlays(parsed.manifestPath, parsed.options);
  console.log(JSON.stringify(summaryForStdout(report), null, 2));
  if (!report.ok) process.exitCode = 1;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
