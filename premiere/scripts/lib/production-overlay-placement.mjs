import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

import {
  buildProductionSourceBundle,
  validateProductionPlan,
} from '../render-production-overlays.mjs';
import {loadPremierePlacementInputs} from './premiere-placement-inputs.mjs';
import {sha256PremiereSequenceFingerprint} from './premiere-sequence-fingerprint.mjs';

const TICKS_PER_SECOND = 254_016_000_000;
const FRAME_TOLERANCE = 0.05;
const SHA256_PATTERN = /^[0-9A-F]{64}$/;
const TOKEN_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const PRODUCTION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const DISPLAY_FORMATS = new Map([
  [0, {nominalFps: 24, dropFrame: false, allowedFps: [24, 24_000 / 1_001]}],
  [1, {nominalFps: 25, dropFrame: false, allowedFps: [25]}],
  [2, {nominalFps: 30, dropFrame: true, allowedFps: [30_000 / 1_001]}],
  [3, {nominalFps: 30, dropFrame: false, allowedFps: [30_000 / 1_001]}],
  [4, {nominalFps: 30, dropFrame: false, allowedFps: [30]}],
  [5, {nominalFps: 50, dropFrame: false, allowedFps: [50]}],
  [6, {nominalFps: 60, dropFrame: true, allowedFps: [60_000 / 1_001]}],
  [7, {nominalFps: 60, dropFrame: false, allowedFps: [60_000 / 1_001]}],
  [8, {nominalFps: 60, dropFrame: false, allowedFps: [60]}],
]);

const fail = (message, code = 'PRODUCTION_OVERLAY_PLACEMENT_INVALID') => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const isObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const requiredString = (value, label) => {
  const normalized = String(value ?? '').trim();
  if (!normalized) fail(`${label}이 필요합니다.`);
  return normalized;
};

const finiteNumber = (value, label) => {
  if (value === '' || value === null || value === undefined) {
    fail(`${label}은 유한한 숫자여야 합니다.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`${label}은 유한한 숫자여야 합니다.`);
  return number;
};

const positiveNumber = (value, label) => {
  const number = finiteNumber(value, label);
  if (!(number > 0)) fail(`${label}은 0보다 커야 합니다.`);
  return number;
};

const nonNegativeInteger = (value, label) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    fail(`${label}은 0 이상의 정수여야 합니다.`);
  }
  return number;
};

const normalizeSha256 = (value, label) => {
  const hash = requiredString(value, label).toUpperCase();
  if (!SHA256_PATTERN.test(hash)) fail(`${label}이 SHA-256 형식이 아닙니다.`);
  return hash;
};

export const sha256File = (filePath) =>
  createHash('sha256').update(readFileSync(filePath)).digest('hex').toUpperCase();

const readJson = (filePath, label) => {
  let source;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch (error) {
    fail(`${label}을 읽을 수 없습니다: ${filePath}\n${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`${label} JSON이 올바르지 않습니다: ${filePath}\n${error.message}`);
  }
};

const assertInside = ({root, target, label, allowRoot = false}) => {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (
    (!allowRoot && relative === '') ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail(`${label}이 허용된 경로 밖입니다: ${target}`, 'PRODUCTION_OVERLAY_PATH_ESCAPE');
  }
  return resolvedTarget;
};

const safeRepoRelativePath = ({repoRoot, value, label}) => {
  const relative = requiredString(value, label).replaceAll('\\', '/');
  if (
    relative.startsWith('/') ||
    /^[A-Za-z]:/.test(relative) ||
    relative.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail(`${label}은 안전한 repo 상대 경로여야 합니다: ${value}`, 'PRODUCTION_OVERLAY_PATH_ESCAPE');
  }
  const resolved = path.resolve(repoRoot, ...relative.split('/'));
  assertInside({root: repoRoot, target: resolved, label});
  return {relative, resolved};
};

const parseRate = (value) => {
  const [numerator, denominator] = String(value ?? '').split('/').map(Number);
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
    return numerator / denominator;
  }
  const direct = Number(value);
  return Number.isFinite(direct) ? direct : 0;
};

export const probeOverlayFile = (filePath) => {
  const result = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-count_frames',
      '-show_entries',
      'stream=codec_type,codec_name,profile,pix_fmt,width,height,r_frame_rate,avg_frame_rate,nb_frames,nb_read_frames:format=duration,size',
      '-of',
      'json',
      filePath,
    ],
    {encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024},
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`ffprobe 실패: ${filePath}\n${String(result.stderr || '').trim()}`);
  }
  const payload = JSON.parse(result.stdout);
  const videos = (payload.streams ?? []).filter((stream) => stream.codec_type === 'video');
  const audios = (payload.streams ?? []).filter((stream) => stream.codec_type === 'audio');
  if (videos.length !== 1) fail(`overlay video stream은 정확히 하나여야 합니다: ${filePath}`);
  const video = videos[0];
  const frames = Number(
    video.nb_read_frames === 'N/A'
      ? video.nb_frames
      : video.nb_read_frames ?? video.nb_frames,
  );
  if (!Number.isInteger(frames) || frames <= 0) {
    fail(`overlay frame 수를 확인할 수 없습니다: ${filePath}`);
  }
  return {
    audioStreamCount: audios.length,
    bytes: Number(payload.format?.size ?? statSync(filePath).size),
    codec: String(video.codec_name ?? ''),
    fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate),
    frames,
    height: Number(video.height),
    pixelFormat: String(video.pix_fmt ?? ''),
    profile: String(video.profile ?? ''),
    width: Number(video.width),
  };
};

const validateIdentityCore = (raw, label) => {
  if (!isObject(raw)) fail(`${label}은 JSON object여야 합니다.`);
  if (raw.schemaVersion !== 1) fail(`${label}.schemaVersion은 1이어야 합니다.`);
  const projectName = requiredString(raw.projectName, `${label}.projectName`);
  const projectPath = requiredString(raw.projectPath, `${label}.projectPath`);
  const sequenceName = requiredString(raw.sequenceName, `${label}.sequenceName`);
  const sequenceId = requiredString(raw.sequenceId, `${label}.sequenceId`);
  const sequenceDurationSeconds = positiveNumber(
    raw.sequenceDurationSeconds,
    `${label}.sequenceDurationSeconds`,
  );
  const fps = positiveNumber(raw.fps, `${label}.fps`);
  const ticksNumber = positiveNumber(raw.ticksPerFrame, `${label}.ticksPerFrame`);
  if (!Number.isInteger(ticksNumber)) fail(`${label}.ticksPerFrame은 정수여야 합니다.`);
  const ticksPerFrame = String(raw.ticksPerFrame);
  const derivedFps = TICKS_PER_SECOND / ticksNumber;
  if (Math.abs(derivedFps - fps) > 0.002) {
    fail(`${label}의 fps와 ticksPerFrame이 일치하지 않습니다.`);
  }
  const exactDurationFrames = sequenceDurationSeconds * fps;
  if (Math.abs(exactDurationFrames - Math.round(exactDurationFrames)) > FRAME_TOLERANCE) {
    fail(`${label}.sequenceDurationSeconds가 frame grid에 맞지 않습니다.`);
  }
  const display = raw.timecodeDisplay;
  if (!isObject(display)) fail(`${label}.timecodeDisplay가 필요합니다.`);
  const displayCode = nonNegativeInteger(display.code, `${label}.timecodeDisplay.code`);
  const contract = DISPLAY_FORMATS.get(displayCode);
  if (!contract) fail(`${label}.timecodeDisplay.code를 지원하지 않습니다: ${displayCode}`);
  if (!contract.allowedFps.some((allowed) => Math.abs(allowed - fps) <= 0.002)) {
    fail(`${label}.timecodeDisplay가 ${fps}fps와 일치하지 않습니다.`);
  }
  if (
    Number(display.nominalFps) !== contract.nominalFps ||
    Boolean(display.dropFrame) !== contract.dropFrame
  ) {
    fail(`${label}.timecodeDisplay 계약이 code와 일치하지 않습니다.`);
  }
  return {
    ...raw,
    fps,
    projectName,
    projectPath,
    sequenceDurationFrames: Math.round(exactDurationFrames),
    sequenceDurationSeconds,
    sequenceId,
    sequenceName,
    ticksPerFrame,
    timecodeDisplay: {
      ...display,
      code: displayCode,
      dropFrame: contract.dropFrame,
      nominalFps: contract.nominalFps,
    },
  };
};

export const loadPremierePlacementIdentity = ({captureDir} = {}) => {
  if (!captureDir) fail('--capture-dir이 필요합니다.');
  let loaded;
  try {
    loaded = loadPremierePlacementInputs({captureDir});
  } catch (error) {
    fail(
      `Premiere placement capture 검증에 실패했습니다: ${error.message}`,
      error.code ?? 'PRODUCTION_OVERLAY_IDENTITY_DRIFT',
    );
  }
  return {
    captureKind: 'full-sequence-double-capture',
    capturePath: path.resolve(captureDir),
    identity: validateIdentityCore(loaded.live, 'placement capture live'),
    rawStructure: loaded.rawStructure,
  };
};

const validateBundleShape = ({bundle, label, repoRoot}) => {
  if (!isObject(bundle) || !Array.isArray(bundle.files) || bundle.files.length === 0) {
    fail(`${label}에는 하나 이상의 hash file이 필요합니다.`);
  }
  const sha256 = normalizeSha256(bundle.sha256, `${label}.sha256`);
  const files = bundle.files.map((entry, index) => {
    if (!isObject(entry)) fail(`${label}.files[${index}]가 올바르지 않습니다.`);
    const safe = safeRepoRelativePath({
      repoRoot,
      value: entry.path,
      label: `${label}.files[${index}].path`,
    });
    return {
      path: safe.relative,
      resolved: safe.resolved,
      sha256: normalizeSha256(entry.sha256, `${label}.files[${index}].sha256`),
    };
  });
  const unique = new Set(files.map((entry) => entry.path.toLocaleLowerCase('en-US')));
  if (unique.size !== files.length) fail(`${label}에 중복 path가 있습니다.`);
  return {files, sha256};
};

const comparableBundle = (bundle) => ({
  files: bundle.files
    .map(({path: filePath, sha256}) => ({path: filePath, sha256}))
    .sort((left, right) => left.path.localeCompare(right.path)),
  sha256: bundle.sha256,
});

const verifyReviewAssetBundle = ({reviewManifest, repoRoot}) => {
  if (reviewManifest.renderer?.placeholderReview !== false) {
    fail('placeholder 또는 불명확한 review는 alpha 배치 근거로 사용할 수 없습니다.');
  }
  const bundle = validateBundleShape({
    bundle: reviewManifest.reviewAssetBundle,
    label: 'reviewAssetBundle',
    repoRoot,
  });
  const ordered = [...bundle.files].sort((left, right) => left.resolved.localeCompare(right.resolved));
  const aggregate = createHash('sha256');
  for (const entry of ordered) {
    if (!existsSync(entry.resolved) || !statSync(entry.resolved).isFile()) {
      fail(`review asset가 없습니다: ${entry.resolved}`);
    }
    const currentHash = sha256File(entry.resolved);
    if (currentHash !== entry.sha256) fail(`review asset hash가 변경되었습니다: ${entry.path}`);
    aggregate.update(entry.path);
    aggregate.update('\0');
    aggregate.update(entry.sha256);
    aggregate.update('\n');
  }
  if (aggregate.digest('hex').toUpperCase() !== bundle.sha256) {
    fail('reviewAssetBundle aggregate hash가 일치하지 않습니다.');
  }
};

const manifestLocation = ({alphaManifestPath, repoRoot}) => {
  const resolved = assertInside({
    root: repoRoot,
    target: alphaManifestPath,
    label: 'alpha manifest',
  });
  const relative = path.relative(repoRoot, resolved).split(path.sep).join('/');
  const match = /^renders\/([^/]+)\/([^/]+)\/alpha\/render-manifest\.json$/.exec(relative);
  if (!match) {
    fail(
      `alpha manifest는 renders/<production>/<generation>/alpha/render-manifest.json에 있어야 합니다: ${relative}`,
    );
  }
  const [, production, generation] = match;
  if (!PRODUCTION_PATTERN.test(production) || !TOKEN_PATTERN.test(generation)) {
    fail('alpha manifest 경로의 production/generation 형식이 올바르지 않습니다.');
  }
  return {generation, production, relative, resolved};
};

const requireExactIdentity = (identity, expectedIdentity) => {
  if (!expectedIdentity) return;
  for (const field of [
    'projectName',
    'projectPath',
    'projectId',
    'sequenceName',
    'sequenceId',
    'sequenceDurationSeconds',
    'fps',
    'ticksPerFrame',
  ]) {
    if (
      expectedIdentity[field] !== undefined &&
      String(identity[field] ?? '') !== String(expectedIdentity[field] ?? '')
    ) {
      fail(`live identity가 기대값과 달라졌습니다: ${field}`, 'PRODUCTION_OVERLAY_IDENTITY_DRIFT');
    }
  }
};

const validateRenderOutput = ({
  alphaRoot,
  manifestOutput,
  plan,
  planSegment,
  probeOverlay,
  repoRoot,
}) => {
  if (!isObject(manifestOutput)) fail('alpha output entry가 object가 아닙니다.');
  const segmentId = requiredString(manifestOutput.segmentId, 'output.segmentId');
  if (!planSegment || planSegment.id !== segmentId) {
    fail(`alpha output이 현재 plan segment와 일치하지 않습니다: ${segmentId}`);
  }
  if (requiredString(manifestOutput.compositionId, `${segmentId}.compositionId`) !== planSegment.compositionId) {
    fail(`${segmentId}: compositionId가 plan과 다릅니다.`);
  }
  const startFrame = nonNegativeInteger(manifestOutput.startFrame, `${segmentId}.startFrame`);
  const frames = nonNegativeInteger(manifestOutput.frames, `${segmentId}.frames`);
  if (frames <= 0) fail(`${segmentId}.frames는 0보다 커야 합니다.`);
  if (startFrame !== planSegment.startFrame || frames !== planSegment.durationInFrames) {
    fail(`${segmentId}: startFrame/frames가 현재 plan과 다릅니다.`);
  }
  const file = safeRepoRelativePath({
    repoRoot,
    value: manifestOutput.path,
    label: `${segmentId}.path`,
  });
  assertInside({root: alphaRoot, target: file.resolved, label: `${segmentId}.path`});
  const exactExpected = path.join(alphaRoot, `${segmentId}-overlay.mov`);
  if (path.resolve(file.resolved) !== path.resolve(exactExpected)) {
    fail(`${segmentId}: alpha output 경로가 renderer 계약과 다릅니다.`);
  }
  if (!existsSync(file.resolved) || !statSync(file.resolved).isFile()) {
    fail(`${segmentId}: alpha output 파일이 없습니다: ${file.resolved}`);
  }
  const expectedHash = normalizeSha256(manifestOutput.sha256, `${segmentId}.sha256`);
  if (sha256File(file.resolved) !== expectedHash) {
    fail(`${segmentId}: alpha output hash가 render manifest와 다릅니다.`);
  }
  const bytes = positiveNumber(manifestOutput.bytes, `${segmentId}.bytes`);
  if (statSync(file.resolved).size !== bytes) fail(`${segmentId}: alpha output 크기가 변경되었습니다.`);
  if (Math.abs(positiveNumber(manifestOutput.fps, `${segmentId}.fps`) - plan.fps) > 0.0001) {
    fail(`${segmentId}: alpha output fps가 plan과 다릅니다.`);
  }
  if (
    manifestOutput.audioStreamCount !== 0 ||
    manifestOutput.codec !== 'prores' ||
    !String(manifestOutput.profile ?? '').includes('4444') ||
    !['yuva444p10le', 'yuva444p12le'].includes(manifestOutput.pixelFormat)
  ) {
    fail(`${segmentId}: alpha codec/audio 계약이 올바르지 않습니다.`);
  }
  if (
    !Array.isArray(manifestOutput.boundaryAlphaYMax) ||
    manifestOutput.boundaryAlphaYMax.length !== 2 ||
    manifestOutput.boundaryAlphaYMax.some((value) => !Number.isFinite(Number(value)) || Number(value) > 300)
  ) {
    fail(`${segmentId}: 첫·마지막 alpha 투명성 증거가 올바르지 않습니다.`);
  }
  const probe = probeOverlay(file.resolved);
  if (
    probe.audioStreamCount !== 0 ||
    probe.frames !== frames ||
    Math.abs(probe.fps - plan.fps) > 0.0001 ||
    probe.bytes !== bytes ||
    probe.codec !== 'prores' ||
    !String(probe.profile).includes('4444') ||
    !['yuva444p10le', 'yuva444p12le'].includes(probe.pixelFormat) ||
    probe.width !== plan.width ||
    probe.height !== plan.height
  ) {
    fail(`${segmentId}: alpha file probe가 render manifest/plan과 다릅니다.`);
  }
  return {filePath: file.resolved, frames, segmentId, startFrame};
};

export const buildProductionOverlayPlacement = ({
  alphaManifestPath,
  captureDir,
  currentSourceBundleBuilder = buildProductionSourceBundle,
  expectedGeneration,
  expectedIdentity,
  expectedProduction,
  outputManifestPath,
  probeOverlay = probeOverlayFile,
  repoRoot,
  targetVideoTrackIndex,
} = {}) => {
  const resolvedRepoRoot = path.resolve(requiredString(repoRoot, 'repoRoot'));
  const resolvedOutput = assertInside({
    root: resolvedRepoRoot,
    target: requiredString(outputManifestPath, 'outputManifestPath'),
    label: 'placement manifest output',
  });
  const location = manifestLocation({
    alphaManifestPath: requiredString(alphaManifestPath, 'alphaManifestPath'),
    repoRoot: resolvedRepoRoot,
  });
  if (expectedProduction && location.production !== expectedProduction) {
    fail(`alpha production이 기대값과 다릅니다: ${location.production} != ${expectedProduction}`);
  }
  if (expectedGeneration && location.generation !== expectedGeneration) {
    fail(`alpha generation이 기대값과 다릅니다: ${location.generation} != ${expectedGeneration}`);
  }
  const alpha = readJson(location.resolved, 'alpha render manifest');
  if (
    alpha.schemaVersion !== 1 ||
    alpha.mode !== 'alpha' ||
    alpha.production !== location.production ||
    alpha.generation !== location.generation
  ) {
    fail('alpha render manifest의 mode/production/generation이 경로와 일치하지 않습니다.');
  }
  const requiredParity = `matched ${location.generation}/review plan + source bundle`;
  if (alpha.renderer?.reviewParityPolicy !== requiredParity) {
    fail('review parity bypass 또는 불명확한 alpha manifest는 배치할 수 없습니다.');
  }

  const expectedPlanRelative = `productions/${location.production}/plans/overlay-plan.json`;
  const planReference = safeRepoRelativePath({
    repoRoot: resolvedRepoRoot,
    value: alpha.plan,
    label: 'alpha.plan',
  });
  if (planReference.relative !== expectedPlanRelative) {
    fail(`alpha.plan 경로가 production 계약과 다릅니다: ${planReference.relative}`);
  }
  const planHash = normalizeSha256(alpha.planSha256, 'alpha.planSha256');
  if (!existsSync(planReference.resolved) || sha256File(planReference.resolved) !== planHash) {
    fail('현재 overlay plan hash가 alpha render manifest와 다릅니다.');
  }
  const plan = validateProductionPlan(readJson(planReference.resolved, 'overlay plan'), {
    expectedProduction: location.production,
  });

  const manifestSourceBundle = validateBundleShape({
    bundle: alpha.sourceBundle,
    label: 'alpha.sourceBundle',
    repoRoot: resolvedRepoRoot,
  });
  const currentSourceBundle = validateBundleShape({
    bundle: currentSourceBundleBuilder({
      production: location.production,
      repoRoot: resolvedRepoRoot,
    }),
    label: 'current source bundle',
    repoRoot: resolvedRepoRoot,
  });
  if (
    JSON.stringify(comparableBundle(manifestSourceBundle)) !==
    JSON.stringify(comparableBundle(currentSourceBundle))
  ) {
    fail('현재 motion source bundle이 alpha render 때와 다릅니다.');
  }

  const reviewManifestPath = path.join(
    resolvedRepoRoot,
    'renders',
    location.production,
    location.generation,
    'review',
    'render-manifest.json',
  );
  if (!existsSync(reviewManifestPath)) fail('같은 generation의 review manifest가 없습니다.');
  const review = readJson(reviewManifestPath, 'review render manifest');
  if (
    review.schemaVersion !== 1 ||
    review.mode !== 'review' ||
    review.production !== location.production ||
    review.generation !== location.generation ||
    review.plan !== alpha.plan ||
    normalizeSha256(review.planSha256, 'review.planSha256') !== planHash
  ) {
    fail('review manifest가 alpha와 같은 production/generation/plan이 아닙니다.');
  }
  const reviewSourceBundle = validateBundleShape({
    bundle: review.sourceBundle,
    label: 'review.sourceBundle',
    repoRoot: resolvedRepoRoot,
  });
  if (
    JSON.stringify(comparableBundle(reviewSourceBundle)) !==
    JSON.stringify(comparableBundle(manifestSourceBundle))
  ) {
    fail('review와 alpha의 source bundle이 다릅니다.');
  }
  verifyReviewAssetBundle({reviewManifest: review, repoRoot: resolvedRepoRoot});

  const {captureKind, capturePath, identity, rawStructure} = loadPremierePlacementIdentity({captureDir});
  requireExactIdentity(identity, expectedIdentity);
  if (Math.abs(identity.fps - plan.fps) > 0.0001) {
    fail(`live sequence fps(${identity.fps})와 overlay plan fps(${plan.fps})가 다릅니다.`);
  }
  const trackIndex = nonNegativeInteger(targetVideoTrackIndex, 'targetVideoTrackIndex');
  if (Array.isArray(identity.videoTrackIndexes)) {
    const matches = identity.videoTrackIndexes.filter((value) => Number(value) === trackIndex);
    if (matches.length !== 1) fail('선택한 target video track이 live identity에서 정확히 하나가 아닙니다.');
  }

  if (!Array.isArray(alpha.outputs) || alpha.outputs.length === 0) {
    fail('alpha render manifest outputs가 비어 있습니다.');
  }
  const planById = new Map(plan.segments.map((segment) => [segment.id, segment]));
  const reviewById = new Map((review.outputs ?? []).map((output) => [output.segmentId, output]));
  const seenIds = new Set();
  const seenFiles = new Set();
  const alphaRoot = path.dirname(location.resolved);
  const validated = alpha.outputs.map((output) => {
    const segmentId = requiredString(output?.segmentId, 'alpha output segmentId');
    if (seenIds.has(segmentId)) fail(`alpha outputs에 중복 segment가 있습니다: ${segmentId}`);
    seenIds.add(segmentId);
    const reviewOutput = reviewById.get(segmentId);
    if (
      !reviewOutput ||
      reviewOutput.compositionId !== output.compositionId ||
      Number(reviewOutput.startFrame) !== Number(output.startFrame) ||
      Number(reviewOutput.frames) !== Number(output.frames) ||
      Math.abs(Number(reviewOutput.fps) - Number(output.fps)) > 0.0001
    ) {
      fail(`${segmentId}: 같은 generation review output과 alpha output이 일치하지 않습니다.`);
    }
    const item = validateRenderOutput({
      alphaRoot,
      manifestOutput: output,
      plan,
      planSegment: planById.get(segmentId),
      probeOverlay,
      repoRoot: resolvedRepoRoot,
    });
    const normalizedPath = item.filePath.toLocaleLowerCase('en-US');
    if (seenFiles.has(normalizedPath)) fail(`alpha outputs에 중복 파일이 있습니다: ${item.filePath}`);
    seenFiles.add(normalizedPath);
    return item;
  }).sort((left, right) => left.startFrame - right.startFrame || left.segmentId.localeCompare(right.segmentId));

  for (let index = 0; index < validated.length; index += 1) {
    const item = validated[index];
    const endFrame = item.startFrame + item.frames;
    if (endFrame > identity.sequenceDurationFrames) {
      fail(`${item.segmentId}: overlay가 live sequence 범위를 벗어납니다.`);
    }
    if (index > 0) {
      const previous = validated[index - 1];
      if (item.startFrame < previous.startFrame + previous.frames) {
        fail(`${previous.segmentId}와 ${item.segmentId} overlay가 겹칩니다.`);
      }
    }
  }

  const outputDirectory = path.dirname(resolvedOutput);
  const manifest = {
    schemaVersion: 2,
    projectCheck: {
      name: identity.projectName,
      path: identity.projectPath,
      id: identity.projectId ?? null,
    },
    sequenceCheck: {
      name: identity.sequenceName,
      id: identity.sequenceId,
      durationSeconds: identity.sequenceDurationSeconds,
      durationFrames: identity.sequenceDurationFrames,
      structureSha256: sha256PremiereSequenceFingerprint(rawStructure, identity.fps),
    },
    timingCheck: {
      fps: identity.fps,
      ticksPerFrame: identity.ticksPerFrame,
      timecodeDisplay: identity.timecodeDisplay,
    },
    captureCheck: {
      source: identity.source,
      captureSha256: identity.captureSha256,
      structureSha256: identity.structureSha256,
      bundleSha256: identity.bundleSha256,
    },
    items: validated.map((item) => ({
      file: path.relative(outputDirectory, item.filePath).split(path.sep).join('/'),
      track_index: trackIndex,
      start_seconds: item.startFrame / identity.fps,
    })),
  };
  return {
    capture: {kind: captureKind, path: capturePath},
    identity: {
      fps: identity.fps,
      projectName: identity.projectName,
      projectPath: identity.projectPath,
      sequenceDurationFrames: identity.sequenceDurationFrames,
      sequenceDurationSeconds: identity.sequenceDurationSeconds,
      sequenceId: identity.sequenceId,
      sequenceName: identity.sequenceName,
      ticksPerFrame: identity.ticksPerFrame,
      timecodeDisplay: identity.timecodeDisplay,
    },
    manifest,
    outputManifestPath: resolvedOutput,
    production: location.production,
    generation: location.generation,
    targetVideoTrackIndex: trackIndex,
  };
};
