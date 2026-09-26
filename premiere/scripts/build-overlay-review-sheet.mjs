import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const fail = (message) => {
  throw new Error(message);
};

const readJson = (filePath, label) => {
  let source;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch (error) {
    fail(`${label} 파일을 읽을 수 없습니다: ${filePath}\n${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`${label} JSON 형식이 잘못되었습니다: ${filePath}\n${error.message}`);
  }
};

const parseArgs = (argv) => {
  const allowed = new Set([
    '--plan',
    '--specs',
    '--audio-map',
    '--chrome',
    '--chrome-window',
    '--sheet',
    '--out-suffix',
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equalsAt = arg.indexOf('=');
    const name = equalsAt >= 0 ? arg.slice(0, equalsAt) : arg;
    const inlineValue = equalsAt >= 0 ? arg.slice(equalsAt + 1) : null;
    if (!allowed.has(name)) {
      fail(`알 수 없는 인자입니다: ${arg}`);
    }
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value === '') {
      fail(`${name} 뒤에 값이 필요합니다.`);
    }
    options[name.slice(2)] = value;
  }

  const missing = ['plan', 'audio-map', 'sheet'].filter(
    (name) => options[name] === undefined,
  );
  if (missing.length > 0) {
    fail(`필수 인자가 없습니다: ${missing.map((name) => `--${name}`).join(', ')}`);
  }
  if (Boolean(options.chrome) !== Boolean(options['chrome-window'])) {
    fail('--chrome과 --chrome-window는 함께 지정하거나 둘 다 생략해야 합니다.');
  }
  return options;
};

const deriveSpecsDirectory = (planPath) => {
  const extension = path.extname(planPath);
  const baseName = path.basename(planPath, extension);
  const stem = baseName.replace(/-v3-segments$/i, '').replace(/-segments$/i, '');
  if (stem === baseName) {
    fail(
      `--specs를 생략하려면 plan 파일명이 "<작업>-v3-segments.json" 또는 "<작업>-segments.json"이어야 합니다: ${planPath}`,
    );
  }
  return path.join(path.dirname(planPath), `${stem}-specs`);
};

const validatePlan = (plan, planPath) => {
  if (typeof plan?.outputRoot !== 'string' || plan.outputRoot.length === 0) {
    fail(`plan.outputRoot가 비어 있거나 문자열이 아닙니다: ${planPath}`);
  }
  if (!Array.isArray(plan.segments) || plan.segments.length === 0) {
    fail(`plan.segments가 비어 있거나 배열이 아닙니다: ${planPath}`);
  }
  if (plan.fps !== undefined && (!Number.isFinite(plan.fps) || plan.fps <= 0)) {
    fail(`plan.fps는 양수여야 합니다: ${plan.fps}`);
  }

  const seen = new Set();
  for (const [index, segment] of plan.segments.entries()) {
    if (!segment || typeof segment.id !== 'string' || segment.id.trim() === '') {
      fail(`plan.segments[${index}].id가 올바른 문자열이 아닙니다.`);
    }
    if (!Number.isInteger(segment.anchorFrame) || segment.anchorFrame < 0) {
      fail(`${segment.id}: anchorFrame은 0 이상의 정수여야 합니다.`);
    }
    if (seen.has(segment.id)) {
      fail(`plan에 중복 세그먼트 id가 있습니다: ${segment.id}`);
    }
    seen.add(segment.id);
  }
};

const parseChromeWindow = (value) => {
  const match = value.match(/^(\d+)x(\d+)\+(\d+)\+(\d+)$/);
  if (!match) {
    fail(`--chrome-window는 <w>x<h>+<x>+<y> 형식이어야 합니다: ${value}`);
  }
  const [, width, height, x, y] = match.map(Number);
  if (width <= 0 || height <= 0) {
    fail(`--chrome-window의 폭과 높이는 양수여야 합니다: ${value}`);
  }
  return {width, height, x, y};
};

const readPngDimensions = (filePath) => {
  const buffer = readFileSync(filePath);
  const signature = '89504e470d0a1a0a';
  if (
    buffer.length < 24 ||
    buffer.subarray(0, 8).toString('hex') !== signature ||
    buffer.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    fail(`PNG 크기를 읽을 수 없습니다: ${filePath}`);
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
};

const runFfmpeg = (args, label) => {
  const result = spawnSync('ffmpeg', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    fail(`${label}: ffmpeg를 실행할 수 없습니다.\n${result.error.message}`);
  }
  if (result.status !== 0) {
    const tail = (result.stderr || result.stdout || '')
      .trim()
      .split(/\r?\n/)
      .slice(-8)
      .join('\n');
    fail(`${label}: ffmpeg 종료코드 ${result.status}\n${tail}`);
  }
};

const segmentIdCompare = (left, right) =>
  left.localeCompare(right, 'en', {numeric: true, sensitivity: 'base'});

const buildComposite = ({
  sourcePath,
  sourceTime,
  stillPath,
  outputPath,
  chromePath,
  chromeWindow,
  canvas,
}) => {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(sourceTime), '-i', sourcePath];
  let filter;

  if (chromePath) {
    args.push('-i', chromePath, '-i', stillPath);
    filter =
      `[0:v]scale=${chromeWindow.width}:${chromeWindow.height},setsar=1[cap];` +
      `color=c=black:s=${canvas.width}x${canvas.height}:d=1[bg];` +
      `[bg][cap]overlay=${chromeWindow.x}:${chromeWindow.y}[base];` +
      `[1:v]scale=${canvas.width}:${canvas.height}[chrome];` +
      `[base][chrome]overlay=0:0:format=auto[framed];` +
      `[2:v]scale=${canvas.width}:${canvas.height}[overlay];` +
      `[framed][overlay]overlay=0:0:format=auto,scale=640:-2[out]`;
  } else {
    args.push('-i', stillPath);
    filter =
      `[0:v]scale=${canvas.width}:${canvas.height},setsar=1[base];` +
      `[1:v]scale=${canvas.width}:${canvas.height}[overlay];` +
      `[base][overlay]overlay=0:0:format=auto,scale=640:-2[out]`;
  }

  args.push(
    '-filter_complex',
    filter,
    '-map',
    '[out]',
    '-frames:v',
    '1',
    '-q:v',
    '4',
    outputPath,
  );
  runFfmpeg(args, `${path.basename(outputPath)} 합성`);
};

const buildContactSheet = (images, outputPath) => {
  const count = images.length;
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const tileWidth = 640;
  const tileHeight = 360;
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const image of images) {
    args.push('-i', image);
  }

  const filters = images.map(
    (_image, index) =>
      `[${index}:v]scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=decrease,` +
      `pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2:color=black[t${index}]`,
  );
  const layout = images
    .map((_image, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      return `${column * tileWidth}_${row * tileHeight}`;
    })
    .join('|');
  const inputs = images.map((_image, index) => `[t${index}]`).join('');
  filters.push(`${inputs}xstack=inputs=${count}:layout=${layout}:fill=black[out]`);

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[out]',
    '-frames:v',
    '1',
    outputPath,
  );
  runFfmpeg(args, `${path.basename(outputPath)} 콘택트시트`);
  return {columns, rows};
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const planPath = path.resolve(options.plan);
  const specsDirectory = path.resolve(options.specs ?? deriveSpecsDirectory(planPath));
  const audioMapPath = path.resolve(options['audio-map']);
  const sheetPath = path.resolve(options.sheet);
  const outputDirectory = path.dirname(sheetPath);
  const plan = readJson(planPath, 'plan');
  validatePlan(plan, planPath);

  const outSuffix = options['out-suffix'] ?? '';
  if (outSuffix && !/^-[a-z0-9-]+$/.test(outSuffix)) {
    fail(`--out-suffix는 "-r2" 같은 형식이어야 합니다: ${outSuffix}`);
  }
  const fps = plan.fps ?? 30;
  const stillsDirectory = path.resolve(plan.outputRoot, `stills-v3${outSuffix}`);

  const audioMap = readJson(audioMapPath, 'audio map');
  if (!Array.isArray(audioMap.audioTimeline)) {
    fail(`audio map의 audioTimeline이 배열이 아닙니다: ${audioMapPath}`);
  }
  const audioTimeline = audioMap.audioTimeline.filter(
    (clip) =>
      Number.isFinite(clip?.startSeconds) &&
      Number.isFinite(clip?.endSeconds) &&
      clip.endSeconds > clip.startSeconds &&
      typeof clip.mediaPath === 'string' &&
      Number.isFinite(clip.inPointSeconds),
  );
  if (audioTimeline.length === 0) {
    fail(`audioTimeline에 원본 미디어를 찾을 수 있는 유효 클립이 없습니다: ${audioMapPath}`);
  }

  const chromePath = options.chrome ? path.resolve(options.chrome) : null;
  const chromeWindow = options['chrome-window']
    ? parseChromeWindow(options['chrome-window'])
    : null;
  if (chromePath && !existsSync(chromePath)) {
    fail(`프레임 크롬 PNG가 없습니다: ${chromePath}`);
  }
  // --chrome-window 검증은 캔버스(오버레이 스틸 규격) 좌표계에서 한다.
  // 크롬 PNG는 4K 원본일 수 있어 그 픽셀 크기로 재면 안 된다.
  let chromeWindowChecked = false;
  const checkChromeWindow = (canvas) => {
    if (chromeWindowChecked || !chromeWindow) return;
    chromeWindowChecked = true;
    if (
      chromeWindow.x + chromeWindow.width > canvas.width ||
      chromeWindow.y + chromeWindow.height > canvas.height
    ) {
      fail(
        `--chrome-window가 캔버스를 벗어납니다: ` +
          `${options['chrome-window']} vs ${canvas.width}x${canvas.height} ` +
          `(창 좌표는 크롬 PNG 픽셀이 아니라 컴포지션 규격으로 잰다)`,
      );
    }
  };

  const jobs = [];
  const preflightErrors = [];
  for (const segment of plan.segments) {
    const specPath = path.join(specsDirectory, `${segment.id}.json`);
    let spec;
    try {
      spec = readJson(specPath, `${segment.id} 스펙`);
    } catch (error) {
      preflightErrors.push(error.message);
      continue;
    }
    if (!Number.isFinite(spec.start) || spec.start < 0) {
      preflightErrors.push(`${segment.id}: spec.start는 0 이상의 숫자여야 합니다.`);
      continue;
    }

    const timelineTime = spec.start + segment.anchorFrame / fps;
    const clip = audioTimeline.find(
      (candidate) =>
        timelineTime >= candidate.startSeconds - 0.05 &&
        timelineTime < candidate.endSeconds,
    );
    if (!clip) {
      preflightErrors.push(
        `${segment.id}: 앵커 ${timelineTime.toFixed(3)}s가 어떤 오디오 클립에도 속하지 않습니다.`,
      );
      continue;
    }
    if (!existsSync(clip.mediaPath)) {
      preflightErrors.push(`${segment.id}: 원본 미디어가 없습니다: ${clip.mediaPath}`);
      continue;
    }

    const stillPath = path.join(
      stillsDirectory,
      `${segment.id}-f${String(segment.anchorFrame).padStart(4, '0')}-anchor.png`,
    );
    if (!existsSync(stillPath)) {
      preflightErrors.push(`${segment.id}: 오버레이 스틸이 없습니다: ${stillPath}`);
      continue;
    }
    let stillDimensions;
    try {
      stillDimensions = readPngDimensions(stillPath);
    } catch (error) {
      preflightErrors.push(`${segment.id}: ${error.message}`);
      continue;
    }
    // 캔버스는 항상 오버레이 스틸(=컴포지션/시퀀스 규격) 기준이다.
    // 크롬 PNG는 4K 원본이라도 캔버스에 맞춰 축소해 덮는다.
    // --chrome-window도 캔버스 좌표계로 재서 넘긴다(크롬 PNG 픽셀이 아님).
    const canvas = stillDimensions;
    checkChromeWindow(canvas);
    const sourceTime = clip.inPointSeconds + (timelineTime - clip.startSeconds);
    jobs.push({
      id: segment.id,
      sourcePath: clip.mediaPath,
      sourceTime,
      stillPath,
      canvas,
      outputPath: path.join(outputDirectory, `${segment.id}.jpg`),
    });
  }

  if (preflightErrors.length > 0) {
    fail(`합성 사전 점검 ${preflightErrors.length}건 실패:\n- ${preflightErrors.join('\n- ')}`);
  }

  mkdirSync(outputDirectory, {recursive: true});
  for (const [index, job] of jobs.entries()) {
    buildComposite({...job, chromePath, chromeWindow});
    console.log(`합성 ${index + 1}/${jobs.length}: ${job.id}`);
  }

  const sortedImages = [...jobs]
    .sort((left, right) => segmentIdCompare(left.id, right.id))
    .map((job) => job.outputPath);
  const grid = buildContactSheet(sortedImages, sheetPath);
  console.log(
    `검수 합성 ${jobs.length}/${plan.segments.length}장 + 콘택트시트 ${grid.columns}x${grid.rows}: ${sheetPath}`,
  );
};

try {
  main();
} catch (error) {
  console.error(`오버레이 검수 이미지 생성 실패: ${error.message}`);
  process.exitCode = 1;
}
