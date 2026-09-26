// 오버레이 검수용 배경 MP4를 실제 시퀀스 컷 구성대로 재조립한다.
//
// 왜 필요한가: 편집 전 원본 파일이나 스틸 한 장 위에서 검수하면 컷 전환, 고정 프레임
// 액자, 자막이 빠져 실제 타임라인과 전혀 다른 화면이 된다. 2026-07-24 산출물 22개가
// 이 실수로 전제부터 어긋났다.
//
// 원리: 컷 경계가 발화 경계와 일치하므로, 시퀀스 대본과 원본 대본에서 같은 단어 6개
// 연속을 찾아 각 컷의 원본 위치를 역산한다. Premiere가 알려준 실제 in/out과 일치함을
// 검증했다.
//
// 사용법:
//   node scripts/build-overlay-review-bg.mjs <transcript.json> <track.json> <from> <to> <out.mp4> [옵션]
//     --media-root <경로>   원본 녹화 폴더 (기본: DENO_RECORDINGS_ROOT 또는 내 Videos 폴더)
//     --frame <png>         고정 프레임 액자 PNG (생략 시 액자 없이 합성)
//     --sequence <이름>     시퀀스 대본 항목 이름 (생략 시 확장자 없는 항목을 자동 선택)
//
//   transcript.json = get_clip_transcript 결과, track.json = get_track_info(video, 0) 결과

import {readFileSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import os from "node:os";
import {execFileSync} from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));

const [transcriptPath, trackPath, fromRaw, toRaw, outPath] = positional;
if (!outPath) {
  console.error('사용법: node scripts/build-overlay-review-bg.mjs <transcript.json> <track.json> <from> <to> <out.mp4>');
  process.exit(1);
}

const FROM = Number(fromRaw);
const TO = Number(toRaw);
const MEDIA_ROOT = flag('--media-root', process.env.DENO_RECORDINGS_ROOT || path.join(os.homedir(), 'Videos'));
const FRAME = flag('--frame');
const SEQ_NAME = flag('--sequence');

const tmpDir = path.join(path.dirname(outPath), '.review-bg-parts');
rmSync(tmpDir, {recursive: true, force: true});
mkdirSync(tmpDir, {recursive: true});

const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8'));

// 시퀀스 대본 = items 중 이름에 확장자가 없는 항목. 이것만이 편집 후 시간 기준이다.
const seqItem = SEQ_NAME
  ? transcript.items.find((i) => i.name === SEQ_NAME)
  : transcript.items.find((i) => !path.extname(i.name) && i.wordCount > 0);
if (!seqItem) throw new Error('시퀀스 기준 대본을 찾지 못했습니다. --sequence 로 이름을 지정하세요.');

const sourceWords = new Map();
for (const item of transcript.items) {
  if (path.extname(item.name) && item.wordCount > 0) sourceWords.set(item.name, item.words);
}

const seqWords = seqItem.words;
const norm = (s) => s.replace(/[.,?!]/g, '');

// 클립 시작 직후 첫 단어를 원본 대본에서 찾아 시간차(오프셋)를 구한다.
const offsetFor = (clip) => {
  const idx = seqWords.findIndex((w) => w.startSeconds >= clip.startSeconds - 0.05);
  if (idx < 0) return null;
  const words = sourceWords.get(clip.name);
  if (!words) return null;
  for (let len = 6; len >= 3; len--) {
    const run = seqWords.slice(idx, idx + len).map((w) => norm(w.text)).join(' ');
    for (let i = 0; i <= words.length - len; i++) {
      if (words.slice(i, i + len).map((w) => norm(w.text)).join(' ') === run) {
        return words[i].startSeconds - seqWords[idx].startSeconds;
      }
    }
  }
  return null;
};

const clips = JSON.parse(readFileSync(trackPath, 'utf8')).clips.filter(
  (c) => c.endSeconds > FROM + 0.01 && c.startSeconds < TO - 0.01,
);
if (!clips.length) throw new Error(`${FROM}~${TO}s 구간에 클립이 없습니다.`);

const filter = FRAME
  ? '[0:v]scale=1920:1080,fps=30[bg];[1:v]scale=1920:1080[fg];[bg][fg]overlay=0:0[v]'
  : '[0:v]scale=1920:1080,fps=30[v]';

const parts = [];
let carried = null;
clips.forEach((clip, i) => {
  const offset = offsetFor(clip) ?? carried;
  if (offset === null) {
    // 검정 화면·그래픽처럼 대본이 없는 클립은 시간 역산이 불가능하다.
    // 앞선 오프셋도 없으면(구간 맨 앞) 배경에서 건너뛴다 — 어차피 보여줄 내용이 없다.
    console.log(`컷 ${i}: 건너뜀 (대본 없음) — ${clip.name}`);
    return;
  }
  carried = offset;

  const start = Math.max(clip.startSeconds, FROM) + offset;
  const end = Math.min(clip.endSeconds, TO) + offset;
  const out = path.join(tmpDir, `p${String(i).padStart(3, '0')}.mp4`);

  const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-to', String(end),
    '-i', path.join(MEDIA_ROOT, clip.name)];
  if (FRAME) args.push('-i', FRAME);
  args.push('-filter_complex', filter, '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-y', out);

  execFileSync('ffmpeg', args, {stdio: 'inherit'});
  parts.push(out);
  console.log(`컷 ${i}: 시퀀스 ${clip.startSeconds.toFixed(2)}s → 원본 ${start.toFixed(2)}s (오프셋 ${offset.toFixed(2)})`);
});

// concat 목록은 절대 경로로 쓴다. 상대 경로는 list 파일 위치 기준으로 재해석돼 깨진다.
const listFile = path.join(tmpDir, 'list.txt');
writeFileSync(
  listFile,
  parts.map((p) => `file '${path.resolve(p).replace(/\\/g, '/')}'`).join('\n'),
  'utf8',
);
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
  '-i', listFile, '-c', 'copy', '-y', outPath], {stdio: 'inherit'});
rmSync(tmpDir, {recursive: true, force: true});

console.log(`검수 배경 완성: ${outPath} (${clips.length}컷, ${(TO - FROM).toFixed(2)}초${FRAME ? ', 액자 포함' : ''})`);
