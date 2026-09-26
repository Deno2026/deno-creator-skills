import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key.slice(2)] = true;
    } else {
      args[key.slice(2)] = next;
      i += 1;
    }
  }
  return args;
}

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    if (options.capture) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} exited with ${code}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseSilences(log, windowStart, windowEnd) {
  const events = [];
  for (const match of log.matchAll(/silence_start:\s*([0-9.]+)/g)) {
    events.push({ type: 'start', time: Number(match[1]) });
  }
  for (const match of log.matchAll(/silence_end:\s*([0-9.]+)/g)) {
    events.push({ type: 'end', time: Number(match[1]) });
  }
  events.sort((a, b) => a.time - b.time || (a.type === 'end' ? -1 : 1));
  const silences = [];
  let start = null;
  for (const event of events) {
    if (event.type === 'start') start = event.time;
    if (event.type === 'end' && start !== null) {
      silences.push({
        start: Math.max(windowStart, start),
        end: Math.min(windowEnd, event.time),
      });
      start = null;
    }
  }
  if (start !== null) silences.push({ start: Math.max(windowStart, start), end: windowEnd });
  return silences.filter((silence) => silence.end > silence.start);
}

function buildKeepSegments(silences, windowStart, windowEnd, lead, tail, minKeep, mergeGap) {
  const segments = [];
  let cursor = windowStart;
  for (const silence of silences) {
    const cutStart = Math.max(cursor, silence.start + tail);
    const cutEnd = Math.min(windowEnd, silence.end - lead);
    if (cutEnd > cutStart) {
      if (cutStart - cursor >= minKeep) segments.push({ start: cursor, end: cutStart });
      cursor = cutEnd;
    }
  }
  if (windowEnd - cursor >= minKeep) segments.push({ start: cursor, end: windowEnd });

  const merged = [];
  for (const segment of segments) {
    const last = merged.at(-1);
    if (last && segment.start - last.end <= mergeGap) {
      last.end = segment.end;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged.map((segment, index) => ({
    index,
    start: Number(segment.start.toFixed(3)),
    end: Number(segment.end.toFixed(3)),
    duration: Number((segment.end - segment.start).toFixed(3)),
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input;
  const outDir = args['out-dir'];
  const report = args.report;
  if (!input || !outDir || !report) {
    throw new Error('Usage: --input <file> --out-dir <folder> --report <json> [--start s --end s] [--audio-stream 1] [--threshold -48dB] [--min-silence 0.8] [--lead 0.4] [--tail 0.4] [--min-keep 0.3] [--merge-gap 0.08] [--encoder h264_nvenc|libx264]');
  }
  const windowStart = Number(args.start ?? 0);
  // Clamp the window to the real input length (a bare default of 900s made the last clip report end=900).
  const probe = await run(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', args.input ?? ''],
    { capture: true },
  ).catch(() => ({ stdout: '' }));
  const inputDuration = Number(String(probe.stdout).trim());
  const requestedEnd = Number(args.end ?? (Number.isFinite(inputDuration) && inputDuration > 0 ? inputDuration : 900));
  const windowEnd = Number.isFinite(inputDuration) && inputDuration > 0 ? Math.min(requestedEnd, inputDuration) : requestedEnd;
  const audioStream = Number(args['audio-stream'] ?? 1);
  const threshold = args.threshold ?? '-48dB';
  const minSilence = Number(args['min-silence'] ?? 0.8);
  const lead = Number(args.lead ?? 0.4);
  const tail = Number(args.tail ?? 0.4);
  const minKeep = Number(args['min-keep'] ?? 0.3);
  const mergeGap = Number(args['merge-gap'] ?? 0.08);
  const encoder = args.encoder ?? 'h264_nvenc';

  if (!input || !outDir || !report) {
    throw new Error('Usage: --input <file> --out-dir <folder> --report <json>');
  }
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(path.dirname(report), { recursive: true });

  console.log(`[1/2] Detecting silence from ${windowStart}s to ${windowEnd}s...`);
  const detect = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-ss',
      String(windowStart),
      '-t',
      String(windowEnd - windowStart),
      '-i',
      input,
      '-map',
      `0:${audioStream}`,
      '-af',
      `silencedetect=noise=${threshold}:d=${minSilence}`,
      '-vn',
      '-sn',
      '-dn',
      '-f',
      'null',
      'NUL',
    ],
    { capture: true },
  );
  const relativeSilences = parseSilences(detect.stderr, 0, windowEnd - windowStart);
  const silences = relativeSilences.map((silence) => ({
    start: silence.start + windowStart,
    end: silence.end + windowStart,
  }));
  const segments = buildKeepSegments(
    silences,
    windowStart,
    windowEnd,
    lead,
    tail,
    minKeep,
    mergeGap,
  );

  console.log(`[2/2] Rendering ${segments.length} clips...`);
  const rendered = [];
  for (const segment of segments) {
    const clipName = `active_${String(segment.index).padStart(4, '0')}_${segment.start.toFixed(3).replace('.', 'p')}-${segment.end.toFixed(3).replace('.', 'p')}.mp4`;
    const output = path.join(outDir, clipName);
    const videoArgs =
      encoder === 'h264_nvenc'
        ? ['-c:v', 'h264_nvenc', '-preset', args['nvenc-preset'] ?? 'p4', '-cq', args.cq ?? '21']
        : ['-c:v', 'libx264', '-preset', args.preset ?? 'veryfast', '-crf', args.crf ?? '20'];
    await run('ffmpeg', [
      '-hide_banner',
      '-y',
      '-nostdin',
      '-ss',
      String(segment.start),
      '-t',
      String(segment.duration),
      '-i',
      input,
      '-map',
      '0:v:0',
      '-map',
      `0:${audioStream}`,
      ...videoArgs,
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      output,
    ]);
    rendered.push({ ...segment, output });
    console.log(`  rendered ${rendered.length}/${segments.length}: ${clipName}`);
  }

  const keptSeconds = segments.reduce((sum, segment) => sum + segment.duration, 0);
  const summary = {
    input,
    outDir,
    windowStart,
    windowEnd,
    audioStream,
    threshold,
    minSilence,
    lead,
    tail,
    clipCount: rendered.length,
    keptSeconds: Number(keptSeconds.toFixed(3)),
    removedSeconds: Number((windowEnd - windowStart - keptSeconds).toFixed(3)),
    groupStart: windowStart,
    groupEnd: windowEnd,
    // Import-ready (import-audio-active-clips-to-current-sequence.mjs reads output/startSeconds/endSeconds/name/enabled).
    clips: rendered.map((segment) => ({
      ...segment,
      name: path.basename(segment.output, path.extname(segment.output)),
      startSeconds: segment.start,
      endSeconds: segment.end,
      durationSeconds: segment.duration,
      output: path.resolve(segment.output),
      enabled: true,
    })),
  };
  await fs.writeFile(report, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`Report: ${report}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
