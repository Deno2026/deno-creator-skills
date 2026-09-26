// 검수 배경을 "타임라인이 알려준 실제 컷 위치"로 재조립한다.
//
// 기존 build-overlay-review-bg.mjs는 시퀀스 대본과 원본 대본에서 같은 단어 6개가
// 연속하는 자리를 찾아 컷 위치를 역산한다. 그건 get_clip_transcript가 있을 때의 방법이고,
// 이 PC의 실작업 프로젝트에는 대본이 없다. get_sequence_structure는 클립마다
// start/end/inPoint를 그대로 주므로 역산할 이유가 없다 — 그 값을 직접 쓴다.
//
// 사용법:
//   node scripts/build-review-bg-from-timeline.mjs <seq-structure.json> <from> <to> <out.mp4>
//     --media-root <경로>  원본 폴더 (기본 DENO_RECORDINGS_ROOT 또는 내 Videos 폴더)
//     --extra-media <name=경로>  원본 폴더 밖 소재의 실제 경로 (반복 가능)
//     --scale <w:h>        기본 1920:1080
import {readFileSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import os from "node:os";
import {execFileSync as rawExec} from 'node:child_process';
import path from 'node:path';

// ffmpeg 실패는 stderr에 이유가 적혀 있다. 기본 execFileSync는 그걸 바이트 배열로
// 던져서 화면에 숫자만 쏟아지므로, 읽을 수 있는 형태로 바꿔 다시 던진다.
const execFileSync = (cmd, args) => {
  try {
    return rawExec(cmd, args, {maxBuffer: 1024 * 1024 * 64});
  } catch (error) {
    const err = error.stderr ? Buffer.from(error.stderr).toString('utf8') : String(error.message);
    throw new Error(`${cmd} 실패\n  ${args.join(' ')}\n${err.trim().split('\n').slice(-6).join('\n')}`);
  }
};

const argv = process.argv.slice(2);
const flags = (name) => argv.reduce((acc, a, i) => (a === name ? [...acc, argv[i + 1]] : acc), []);
const flag = (name, fallback = null) => flags(name)[0] ?? fallback;
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));

const [structPath, fromRaw, toRaw, outPath] = positional;
if (!outPath) {
  console.error('사용법: node scripts/build-review-bg-from-timeline.mjs <seq.json> <from> <to> <out.mp4>');
  process.exit(1);
}
const FROM = Number(fromRaw);
const TO = Number(toRaw);
const MEDIA_ROOT = flag('--media-root', process.env.DENO_RECORDINGS_ROOT || path.join(os.homedir(), 'Videos'));
const SCALE = flag('--scale', '1920:1080');

const extra = new Map();
for (const pair of flags('--extra-media')) {
  const eq = pair.indexOf('=');
  extra.set(pair.slice(0, eq), pair.slice(eq + 1));
}

// 소재는 OBS 폴더 밖에도 있다(작품 재생 클립). 오디오 지도가 클립마다 실제 경로를
// 주므로 그것을 이름 사전으로 쓴다 — 경계에 작품 클립이 0.1초만 걸쳐도 여기서 막힌다.
const mapPath = flag('--media-map');
if (mapPath) {
  const audioMap = JSON.parse(readFileSync(mapPath, 'utf8'));
  for (const clip of audioMap.audioTimeline ?? []) {
    if (clip.name && clip.mediaPath && !extra.has(clip.name)) extra.set(clip.name, clip.mediaPath);
  }
}

const seq = JSON.parse(readFileSync(structPath, 'utf8'));
const clips = seq.videoTracks[0].clips
  .filter((c) => c.endSeconds > FROM && c.startSeconds < TO)
  .sort((a, b) => a.startSeconds - b.startSeconds);
if (clips.length === 0) throw new Error('그 구간에 V1 클립이 없습니다');

const tmpDir = path.join(path.dirname(outPath), '.review-bg-parts');
rmSync(tmpDir, {recursive: true, force: true});
mkdirSync(tmpDir, {recursive: true});
mkdirSync(path.dirname(outPath), {recursive: true});

const parts = [];
clips.forEach((clip, index) => {
  // 구간 경계에 걸친 클립은 잘라서 쓴다
  const useStart = Math.max(clip.startSeconds, FROM);
  const useEnd = Math.min(clip.endSeconds, TO);
  const srcIn = useStart - clip.startSeconds + clip.inPointSeconds;
  const dur = useEnd - useStart;
  if (dur <= 0.001) return;

  const src = extra.get(clip.name) ?? path.join(MEDIA_ROOT, clip.name);
  const out = path.join(tmpDir, `p${String(index).padStart(3, '0')}.mp4`);
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y',
    '-ss', String(srcIn), '-i', src, '-t', String(dur),
    '-vf', `scale=${SCALE}:force_original_aspect_ratio=decrease,pad=${SCALE.replace(':', ':')}:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p`,
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out]);
  parts.push({file: out, start: useStart, dur});
});

// concat 목록의 경로는 반드시 절대 경로여야 한다. 상대 경로를 쓰면 ffmpeg이
// list.txt의 위치를 기준으로 한 번 더 이어 붙여 경로가 중복된다.
const listPath = path.join(tmpDir, 'list.txt');
writeFileSync(listPath, parts.map((p) => `file '${path.resolve(p.file).replace(/\\/g, '/')}'`).join('\n'), 'utf8');
execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'concat', '-safe', '0',
  '-i', listPath, '-c', 'copy', outPath]);

// 소리를 함께 넣는다 — 무음 검수본은 타이밍 판정이 불가능하다(규칙 39).
const audioSrc = flag('--audio');
if (audioSrc) {
  const withAudio = outPath.replace(/\.mp4$/, '-a.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-i', outPath,
    '-ss', String(FROM), '-t', String(TO - FROM), '-i', audioSrc,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', withAudio]);
  execFileSync('node', ['-e', `require('fs').renameSync(${JSON.stringify(withAudio)}, ${JSON.stringify(outPath)})`]);
}

const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
  '-of', 'csv=p=0', outPath]).toString().trim();
console.log(JSON.stringify({
  out: path.resolve(outPath),
  clips: parts.length,
  expectedSeconds: Number((TO - FROM).toFixed(3)),
  actualSeconds: Number(Number(dur).toFixed(3)),
}, null, 2));
