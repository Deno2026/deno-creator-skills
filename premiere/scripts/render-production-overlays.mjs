import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), '..');
const productionPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const generationPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const segmentPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const compositionPattern = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const modes = new Set(['review', 'alpha']);

const fail = (message) => {
  throw new Error(message);
};

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const requireString = (value, label) => {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label}은 비어 있지 않은 문자열이어야 합니다.`);
  }
  return value;
};

const requirePositiveInteger = (value, label) => {
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${label}은 양의 정수여야 합니다.`);
  }
  return value;
};

const normalizeOptionalAsset = (value, label) => {
  if (value === undefined || value === null || value === '') return null;
  const asset = requireString(value, label).replaceAll('\\', '/');
  if (
    asset.startsWith('/') ||
    /^[A-Za-z]:/.test(asset) ||
    asset.split('/').some((part) => part === '..' || part === '.')
  ) {
    fail(`${label}은 assets/ 아래의 안전한 상대 경로여야 합니다.`);
  }
  return asset;
};

const assertToken = (value, pattern, label) => {
  const token = requireString(value, label);
  if (!pattern.test(token)) fail(`${label} 형식이 올바르지 않습니다: ${token}`);
  return token;
};

export const validateProductionPlan = (raw, {expectedProduction} = {}) => {
  if (!isPlainObject(raw)) fail('overlay plan은 JSON object여야 합니다.');
  if (raw.schemaVersion !== 1) {
    fail(`지원하지 않는 overlay plan schemaVersion입니다: ${raw.schemaVersion}`);
  }

  const production = assertToken(
    raw.production,
    productionPattern,
    'plan.production',
  );
  if (expectedProduction && production !== expectedProduction) {
    fail(
      `plan.production이 요청과 다릅니다: ${production} != ${expectedProduction}`,
    );
  }
  const width = requirePositiveInteger(raw.width, 'plan.width');
  const height = requirePositiveInteger(raw.height, 'plan.height');
  if (!Number.isFinite(raw.fps) || raw.fps <= 0) {
    fail('plan.fps는 양수여야 합니다.');
  }
  if (!Array.isArray(raw.segments) || raw.segments.length === 0) {
    fail('plan.segments는 하나 이상의 segment를 포함해야 합니다.');
  }

  const ids = new Set();
  const compositionIds = new Set();
  const segments = raw.segments.map((candidate, index) => {
    if (!isPlainObject(candidate)) {
      fail(`plan.segments[${index}]는 object여야 합니다.`);
    }
    const label = `plan.segments[${index}]`;
    const id = assertToken(candidate.id, segmentPattern, `${label}.id`);
    const compositionId = assertToken(
      candidate.compositionId,
      compositionPattern,
      `${label}.compositionId`,
    );
    if (ids.has(id)) fail(`중복 segment id입니다: ${id}`);
    if (compositionIds.has(compositionId)) {
      fail(`중복 compositionId입니다: ${compositionId}`);
    }
    ids.add(id);
    compositionIds.add(compositionId);
    if (!Number.isInteger(candidate.startFrame) || candidate.startFrame < 0) {
      fail(`${label}.startFrame은 0 이상의 정수여야 합니다.`);
    }
    const durationInFrames = requirePositiveInteger(
      candidate.durationInFrames,
      `${label}.durationInFrames`,
    );
    if (durationInFrames < 12) {
      fail(`${label}.durationInFrames는 안전한 입퇴장을 위해 12 이상이어야 합니다.`);
    }
    const accentColor = candidate.accentColor ?? '#D7FF48';
    if (typeof accentColor !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(accentColor)) {
      fail(`${label}.accentColor는 #RRGGBB 형식이어야 합니다.`);
    }
    return {
      id,
      compositionId,
      startFrame: candidate.startFrame,
      durationInFrames,
      eyebrow:
        candidate.eyebrow === undefined || candidate.eyebrow === null
          ? undefined
          : requireString(candidate.eyebrow, `${label}.eyebrow`),
      title: requireString(candidate.title, `${label}.title`),
      message: requireString(candidate.message, `${label}.message`),
      accentColor,
      reviewBackground: normalizeOptionalAsset(
        candidate.reviewBackground,
        `${label}.reviewBackground`,
      ),
      reviewAudio: normalizeOptionalAsset(
        candidate.reviewAudio,
        `${label}.reviewAudio`,
      ),
    };
  });

  const timelineOrder = [...segments].sort(
    (left, right) => left.startFrame - right.startFrame,
  );
  for (let index = 1; index < timelineOrder.length; index += 1) {
    const previous = timelineOrder[index - 1];
    const current = timelineOrder[index];
    if (current.startFrame < previous.startFrame + previous.durationInFrames) {
      fail(`segment가 겹칩니다: ${previous.id} -> ${current.id}`);
    }
  }

  return {
    schemaVersion: 1,
    production,
    scaffoldOnly: raw.scaffoldOnly === true,
    width,
    height,
    fps: raw.fps,
    segments,
  };
};

export const loadProductionPlan = ({repoRoot = defaultRepoRoot, production}) => {
  assertToken(production, productionPattern, '--production');
  const planPath = path.join(
    repoRoot,
    'productions',
    production,
    'plans',
    'overlay-plan.json',
  );
  if (!existsSync(planPath)) fail(`overlay plan이 없습니다: ${planPath}`);
  const raw = JSON.parse(readFileSync(planPath, 'utf8'));
  return {
    plan: validateProductionPlan(raw, {expectedProduction: production}),
    planPath,
  };
};

const assertInside = ({root, target, label}) => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    if (relative !== '') fail(`${label}이 허용된 root 밖입니다: ${target}`);
  }
};

export const resolveRenderLayout = ({
  repoRoot = defaultRepoRoot,
  production,
  generation,
  mode,
  transactionId = `${Date.now()}-${process.pid}-${randomUUID()}`,
}) => {
  assertToken(production, productionPattern, '--production');
  assertToken(generation, generationPattern, '--generation');
  if (!modes.has(mode)) fail('--mode는 review 또는 alpha여야 합니다.');
  const productionRoot = path.resolve(repoRoot, 'renders', production);
  const generationRoot = path.join(productionRoot, generation);
  const finalModeRoot = path.join(generationRoot, mode);
  const stagingRoot = path.join(generationRoot, `.staging-${mode}-${transactionId}`);
  assertInside({root: productionRoot, target: generationRoot, label: 'generation root'});
  assertInside({root: generationRoot, target: finalModeRoot, label: 'mode output'});
  assertInside({root: generationRoot, target: stagingRoot, label: 'staging output'});
  return {finalModeRoot, generationRoot, productionRoot, stagingRoot};
};

const selectSegments = (plan, selectedIds) => {
  if (!selectedIds || selectedIds.length === 0) return plan.segments;
  const requested = new Set(selectedIds);
  if (requested.size !== selectedIds.length) fail('--ids에 중복 id가 있습니다.');
  const known = new Set(plan.segments.map((segment) => segment.id));
  for (const id of requested) {
    assertToken(id, segmentPattern, '--ids');
    if (!known.has(id)) fail(`plan에 없는 segment id입니다: ${id}`);
  }
  return plan.segments.filter((segment) => requested.has(segment.id));
};

export const buildRenderJobs = ({
  plan,
  mode,
  selectedIds = [],
  stagingRoot,
  finalModeRoot,
  concurrency = 2,
}) => {
  if (!modes.has(mode)) fail('render job mode가 올바르지 않습니다.');
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    fail('--concurrency는 1 이상의 정수여야 합니다.');
  }
  const segments = selectSegments(plan, selectedIds);
  return segments.map((segment) => {
    const outputName =
      mode === 'alpha' ? `${segment.id}-overlay.mov` : `${segment.id}-review.mp4`;
    const propsName = `${segment.id}-${mode}-props.json`;
    return {
      compositionId: segment.compositionId,
      inputProps: {
        production: plan.production,
        renderMode: mode,
        segment,
      },
      mode,
      outputName,
      outputPath: path.join(stagingRoot, outputName),
      propsPath: path.join(stagingRoot, 'render-inputs', propsName),
      publishedPath: path.join(finalModeRoot, outputName),
      remotionOutputPath:
        mode === 'alpha'
          ? path.join(stagingRoot, `${segment.id}-remotion.mov`)
          : path.join(stagingRoot, outputName),
      segment,
      concurrency,
    };
  });
};

const run = (command, args, {capture = false} = {}) => {
  const result = spawnSync(command, args, {
    cwd: defaultRepoRoot,
    encoding: capture ? 'utf8' : undefined,
    maxBuffer: capture ? 32 * 1024 * 1024 : undefined,
    stdio: capture ? 'pipe' : 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture
      ? String(result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-12).join('\n')
      : '';
    fail(`${path.basename(command)} 실패(exit ${result.status})${detail ? `\n${detail}` : ''}`);
  }
  return capture ? String(result.stdout ?? '') : '';
};

const parseRate = (value) => {
  const [numerator, denominator] = String(value ?? '').split('/').map(Number);
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
    return numerator / denominator;
  }
  const direct = Number(value);
  return Number.isFinite(direct) ? direct : 0;
};

const sha256 = (filePath) =>
  createHash('sha256').update(readFileSync(filePath)).digest('hex').toUpperCase();

const collectFiles = (target) => {
  if (!existsSync(target)) fail(`source dependency가 없습니다: ${target}`);
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target, {withFileTypes: true}).flatMap((entry) =>
    collectFiles(path.join(target, entry.name)));
};

const buildFileBundle = ({repoRoot, files}) => {
  const entries = [...new Set(files.map((file) => path.resolve(file)))]
    .sort((left, right) => left.localeCompare(right))
    .map((file) => {
      assertInside({root: repoRoot, target: file, label: 'bundle file'});
      return {
        path: path.relative(repoRoot, file).split(path.sep).join('/'),
        sha256: sha256(file),
      };
    });
  const bundleHash = createHash('sha256');
  for (const entry of entries) {
    bundleHash.update(entry.path);
    bundleHash.update('\0');
    bundleHash.update(entry.sha256);
    bundleHash.update('\n');
  }
  return {files: entries, sha256: bundleHash.digest('hex').toUpperCase()};
};

const productionRenderDependencies = ({repoRoot, production}) => {
  const manifestPath = path.join(repoRoot, 'src', 'productions', production, 'render-dependencies.json');
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.files)) fail('render-dependencies.json.files는 배열이어야 합니다.');
  return manifest.files.map((entry, index) => {
    const relative = requireString(entry, `render-dependencies.files[${index}]`);
    if (path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.includes('\\')) {
      fail('render dependency는 repo 기준 상대 경로와 / 구분자를 사용해야 합니다.');
    }
    const resolved = path.resolve(repoRoot, relative);
    assertInside({root: repoRoot, target: resolved, label: 'render dependency'});
    if (!existsSync(resolved) || !statSync(resolved).isFile()) fail(`render dependency file이 없습니다: ${relative}`);
    return resolved;
  });
};

export const buildProductionSourceBundle = ({repoRoot = defaultRepoRoot, production}) =>
  buildFileBundle({
    repoRoot,
    files: [
      path.join(repoRoot, 'src', 'index.ts'),
      path.join(repoRoot, 'src', 'Root.tsx'),
      path.join(repoRoot, 'src', 'productions', 'registry.tsx'),
      ...collectFiles(path.join(repoRoot, 'src', 'lib')),
      ...collectFiles(path.join(repoRoot, 'src', 'productions', production)),
      ...productionRenderDependencies({repoRoot, production}),
    ],
  });

export const assertProductionSourceUnchanged = ({repoRoot = defaultRepoRoot, production, expected}) => {
  if (buildProductionSourceBundle({repoRoot, production}).sha256 !== expected.sha256) {
    fail('render 중 source 또는 render dependency가 변경되어 publish하지 않았습니다.');
  }
};

export const probeAlphaBoundary = ({filePath, frames, segmentId = path.basename(filePath)}) => {
  const lastFrame = requirePositiveInteger(frames, 'alpha frame count') - 1;
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const metadata = run(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      filePath,
      '-vf',
      `select=eq(n\\,0)+eq(n\\,${lastFrame}),alphaextract,signalstats,metadata=mode=print:file=-`,
      '-fps_mode',
      'passthrough',
      '-f',
      'null',
      nullDevice,
    ],
    {capture: true},
  );
  const yMaximums = [...metadata.matchAll(/lavfi\.signalstats\.YMAX=([0-9.]+)/g)]
    .map((match) => Number(match[1]));
  if (yMaximums.length !== 2 || yMaximums.some((value) => !Number.isFinite(value))) {
    fail(`${segmentId}: 첫·마지막 alpha frame을 판독하지 못했습니다.`);
  }
  // ProRes 4444 alphaextract may expose legal-range transparent black as 256
  // in the 12-bit signalstats scale. Values above this small codec margin are
  // visibly non-transparent and fail the delivery contract.
  if (yMaximums.some((value) => value > 300)) {
    fail(`${segmentId}: 첫·마지막 frame이 투명하지 않습니다: ${yMaximums.join(', ')}`);
  }
  return yMaximums;
};

const probeOutput = ({allowPlaceholderReview = false, filePath, mode, plan, segment}) => {
  const probe = JSON.parse(
    run(
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
      {capture: true},
    ),
  );
  const videos = (probe.streams ?? []).filter(
    (stream) => stream.codec_type === 'video',
  );
  const audios = (probe.streams ?? []).filter(
    (stream) => stream.codec_type === 'audio',
  );
  if (videos.length !== 1) fail(`${segment.id}: video stream은 정확히 1개여야 합니다.`);
  const video = videos[0];
  const frames = Number(
    video.nb_read_frames === 'N/A'
      ? video.nb_frames
      : video.nb_read_frames ?? video.nb_frames,
  );
  const frameRate = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate);
  const errors = [];
  if (video.width !== plan.width || video.height !== plan.height) {
    errors.push(`dimensions=${video.width}x${video.height}`);
  }
  if (Math.abs(frameRate - plan.fps) > 0.0001) {
    errors.push(`fps=${frameRate}`);
  }
  if (frames !== segment.durationInFrames) {
    errors.push(`frames=${frames}, expected=${segment.durationInFrames}`);
  }
  if (mode === 'alpha') {
    if (audios.length !== 0) errors.push(`audioStreams=${audios.length}`);
    if (video.codec_name !== 'prores' || !String(video.profile).includes('4444')) {
      errors.push(`codec/profile=${video.codec_name}/${video.profile}`);
    }
    if (!['yuva444p10le', 'yuva444p12le'].includes(video.pix_fmt)) {
      errors.push(`pixelFormat=${video.pix_fmt}`);
    }
  } else {
    if (video.codec_name !== 'h264' || video.pix_fmt !== 'yuv420p') {
      errors.push(`codec/pixelFormat=${video.codec_name}/${video.pix_fmt}`);
    }
    if (!allowPlaceholderReview && audios.length < 1) {
      errors.push(`audioStreams=${audios.length}`);
    }
  }
  if (errors.length > 0) fail(`${segment.id}: render 검증 실패: ${errors.join(', ')}`);
  const boundaryAlphaYMax = mode === 'alpha'
    ? probeAlphaBoundary({filePath, frames, segmentId: segment.id})
    : null;
  return {
    audioStreamCount: audios.length,
    boundaryAlphaYMax,
    bytes: statSync(filePath).size,
    codec: video.codec_name,
    durationSeconds: Number(probe.format?.duration ?? 0),
    fps: frameRate,
    frames,
    pixelFormat: video.pix_fmt,
    profile: video.profile ?? null,
    sha256: sha256(filePath),
  };
};

const preflightReviewAssets = ({allowPlaceholderReview, repoRoot, jobs}) => {
  const publicRoot = path.join(repoRoot, 'assets');
  const assetFiles = [];
  for (const job of jobs) {
    const missing = ['reviewBackground', 'reviewAudio'].filter(
      (field) => !job.segment[field],
    );
    if (!allowPlaceholderReview && missing.length > 0) {
      fail(
        `${job.segment.id}: production review에는 실제 ${missing.join(' + ')}가 필요합니다. ` +
          '격리 smoke만 --allow-placeholder-review를 사용할 수 있습니다.',
      );
    }
    for (const [field, asset] of [
      ['reviewBackground', job.segment.reviewBackground],
      ['reviewAudio', job.segment.reviewAudio],
    ]) {
      if (!asset) continue;
      const target = path.resolve(publicRoot, ...asset.split('/'));
      assertInside({root: publicRoot, target, label: `${job.segment.id}.${field}`});
      if (!existsSync(target)) fail(`${job.segment.id}.${field}가 없습니다: ${target}`);
      assetFiles.push(target);
    }
  }
  return assetFiles.length > 0
    ? buildFileBundle({repoRoot, files: assetFiles})
    : {files: [], sha256: null};
};

const renderJob = ({job, repoRoot}) => {
  const cliPath = path.join(
    repoRoot,
    'node_modules',
    '@remotion',
    'cli',
    'remotion-cli.js',
  );
  const entryPoint = path.join(repoRoot, 'src', 'index.ts');
  const configPath = path.join(
    repoRoot,
    'scripts',
    job.mode === 'alpha'
      ? 'remotion-alpha-overlay.config.ts'
      : 'remotion-h264-review.config.ts',
  );
  for (const required of [cliPath, entryPoint, configPath]) {
    if (!existsSync(required)) fail(`render dependency가 없습니다: ${required}`);
  }

  mkdirSync(path.dirname(job.propsPath), {recursive: true});
  writeFileSync(job.propsPath, `${JSON.stringify(job.inputProps, null, 2)}\n`, 'utf8');
  const args = [
    cliPath,
    'render',
    entryPoint,
    job.compositionId,
    job.remotionOutputPath,
    `--config=${configPath}`,
    `--props=${job.propsPath}`,
    '--gl=angle',
  ];
  // 2026-09-11 실측(s12-cta 1260프레임, RTX PRO 6000 91% 점유 상태 포함):
  //   CPU swangle 2워커 130s | GPU angle 2워커 113s | GPU angle 4워커 91s
  // ProRes4444 인코딩이 CPU 병목이라 GPU는 +15% 수준, 워커 수가 +24%.
  // 기본 2(안전선) — 높일 때는 --concurrency로 명시.
  args.push(`--concurrency=${job.concurrency}`);
  if (job.mode === 'alpha') args.push('--muted');
  run(process.execPath, args);

  if (job.mode === 'alpha') {
    run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      job.remotionOutputPath,
      '-map',
      '0:v:0',
      '-c:v',
      'copy',
      '-an',
      '-map_metadata',
      '-1',
      '-movflags',
      '+faststart',
      job.outputPath,
    ]);
    rmSync(job.remotionOutputPath, {force: true});
  }
};

const cleanupEmptyGenerationRoot = (generationRoot) => {
  try {
    if (existsSync(generationRoot) && readdirSync(generationRoot).length === 0) {
      rmdirSync(generationRoot);
    }
  } catch {
    // The generation root may be shared with another completed mode.
  }
};

const parseArgs = (argv) => {
  const options = {
    allowPlaceholderReview: false,
    allowUnreviewedAlpha: false,
    dryRun: false,
    ids: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--production') options.production = argv[++index];
    else if (value === '--mode') options.mode = argv[++index];
    else if (value === '--generation') options.generation = argv[++index];
    else if (value === '--ids') {
      options.ids.push(
        ...String(argv[++index] ?? '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      );
    } else if (value === '--dry-run') options.dryRun = true;
 else if (value === '--concurrency') options.concurrency = Number(argv[++index]);
    else if (value === '--allow-placeholder-review') options.allowPlaceholderReview = true;
    else if (value === '--allow-unreviewed-alpha') options.allowUnreviewedAlpha = true;
    else if (value === '--help' || value === '-h') options.help = true;
    else fail(`알 수 없는 인자입니다: ${value}`);
  }
  return options;
};

const usage = () =>
  [
    'Usage:',
    '  node scripts/render-production-overlays.mjs --production <slug> --mode <review|alpha> --generation <id> [--ids <id,id>] [--concurrency <n>] [--dry-run]',
    '',
    'Published output: renders/<production>/<generation>/<mode>/',
    'An existing mode output is never overwritten. All jobs publish together after verification.',
    'Production review requires reviewBackground + reviewAudio. Placeholder review and unreviewed alpha are explicit smoke-only flags.',
    '--concurrency: render workers (default 2, 2026-09-11 measured 1.15x with GPU on ProRes4444 CPU-bound encode).',
  ].join('\n');

export const renderProductionOverlays = ({
  repoRoot = defaultRepoRoot,
  production,
  mode,
  generation,
  ids = [],
  dryRun = false,
  allowPlaceholderReview = false,
  allowUnreviewedAlpha = false,
  concurrency = 2,
}) => {
  assertToken(production, productionPattern, '--production');
  assertToken(generation, generationPattern, '--generation');
  if (!modes.has(mode)) fail('--mode는 review 또는 alpha여야 합니다.');
  if (mode !== 'review' && allowPlaceholderReview) {
    fail('--allow-placeholder-review는 review mode에서만 사용할 수 있습니다.');
  }
  if (mode !== 'alpha' && allowUnreviewedAlpha) {
    fail('--allow-unreviewed-alpha는 alpha mode에서만 사용할 수 있습니다.');
  }
  const {plan, planPath} = loadProductionPlan({repoRoot, production});
  if (plan.scaffoldOnly && !dryRun) {
    fail(
      'overlay-plan과 영상별 source를 현재 Route Sheet의 장면으로 채운 뒤 scaffoldOnly를 false로 바꾸세요.',
    );
  }
  const layout = resolveRenderLayout({repoRoot, production, generation, mode});
  if (existsSync(layout.finalModeRoot)) {
    fail(`기존 output을 덮어쓰지 않습니다: ${layout.finalModeRoot}`);
  }
  const jobs = buildRenderJobs({
    finalModeRoot: layout.finalModeRoot,
    mode,
    plan,
    selectedIds: ids,
    stagingRoot: layout.stagingRoot,
    concurrency,
  });
  const reviewAssetBundle = mode === 'review'
    ? preflightReviewAssets({allowPlaceholderReview, jobs, repoRoot})
    : null;
  const preview = {
    dryRun,
    generation,
    mode,
    output: path.relative(repoRoot, layout.finalModeRoot),
    production,
    segments: jobs.map((job) => job.segment.id),
  };
  if (dryRun) return preview;

  const planHashBefore = sha256(planPath);
  const sourceBundle = buildProductionSourceBundle({production, repoRoot});
  let matchedReviewManifest = null;
  if (mode === 'alpha' && !allowUnreviewedAlpha) {
    const reviewManifestPath = path.join(
      layout.generationRoot,
      'review',
      'render-manifest.json',
    );
    if (!existsSync(reviewManifestPath)) {
      fail(`같은 generation의 합격 review manifest가 없습니다: ${reviewManifestPath}`);
    }
    matchedReviewManifest = JSON.parse(readFileSync(reviewManifestPath, 'utf8'));
    if (
      matchedReviewManifest.production !== production ||
      matchedReviewManifest.generation !== generation ||
      matchedReviewManifest.mode !== 'review' ||
      matchedReviewManifest.renderer?.placeholderReview === true ||
      matchedReviewManifest.planSha256 !== planHashBefore ||
      matchedReviewManifest.sourceBundle?.sha256 !== sourceBundle.sha256
    ) {
      fail('alpha source/plan이 같은 generation의 review와 일치하지 않습니다.');
    }
    const reviewedSegments = new Set(
      (matchedReviewManifest.outputs ?? []).map((output) => output.segmentId),
    );
    for (const job of jobs) {
      if (!reviewedSegments.has(job.segment.id)) {
        fail(`${job.segment.id}: 같은 generation review에서 검수되지 않았습니다.`);
      }
    }
  }

  mkdirSync(layout.generationRoot, {recursive: true});
  if (existsSync(layout.stagingRoot)) fail(`staging 충돌: ${layout.stagingRoot}`);
  mkdirSync(layout.stagingRoot);
  try {
    const outputs = [];
    for (const job of jobs) {
      renderJob({job, repoRoot});
      const verification = probeOutput({
        filePath: job.outputPath,
        allowPlaceholderReview,
        mode,
        plan,
        segment: job.segment,
      });
      outputs.push({
        ...verification,
        compositionId: job.compositionId,
        path: path.relative(repoRoot, job.publishedPath).split(path.sep).join('/'),
        segmentId: job.segment.id,
        startFrame: job.segment.startFrame,
      });
    }
    const planHashAfter = sha256(planPath);
    if (planHashAfter !== planHashBefore) {
      fail('render 중 overlay plan이 변경되어 publish하지 않았습니다.');
    }
    assertProductionSourceUnchanged({repoRoot, production, expected: sourceBundle});
    const remotionVersion = JSON.parse(
      readFileSync(path.join(repoRoot, 'node_modules', 'remotion', 'package.json'), 'utf8'),
    ).version;
    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      generation,
      mode,
      outputs,
      plan: path.relative(repoRoot, planPath).split(path.sep).join('/'),
      planSha256: planHashBefore,
      production,
      reviewAssetBundle,
      sourceBundle,
      renderer: {
        entry: 'src/index.ts',
        remotionVersion,
        alphaAudioPolicy:
          mode === 'alpha'
            ? 'video-stream-only remux with -an; verified zero audio streams'
            : null,
        reviewParityPolicy:
          mode === 'alpha'
            ? (allowUnreviewedAlpha
              ? 'smoke-only bypass'
              : `matched ${generation}/review plan + source bundle`)
            : null,
        placeholderReview: mode === 'review' ? allowPlaceholderReview : null,
      },
    };
    writeFileSync(
      path.join(layout.stagingRoot, 'render-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    if (existsSync(layout.finalModeRoot)) {
      fail(`publish 직전에 output이 생겨 중단했습니다: ${layout.finalModeRoot}`);
    }
    renameSync(layout.stagingRoot, layout.finalModeRoot);
    return {...preview, dryRun: false, manifest};
  } catch (error) {
    rmSync(layout.stagingRoot, {recursive: true, force: true});
    cleanupEmptyGenerationRoot(layout.generationRoot);
    throw error;
  }
};

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === scriptPath;

if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else if (!options.production || !options.mode || !options.generation) {
      console.error(usage());
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(renderProductionOverlays(options), null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
