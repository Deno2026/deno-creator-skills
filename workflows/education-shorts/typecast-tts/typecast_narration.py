# -*- coding: utf-8 -*-
"""교육숏츠 나레이션 — Typecast API 로 문장 단위 호출 → 쉼 편집 → 크기 통일 → 결합.

디노 확정 2026-09-05: 로컬 TTS(Qwen3·Raon) 대신 Typecast 를 채널 표준으로 쓴다.
목소리는 필재, 규칙표는 아래 RULE 이 고정값이다.

원리 (디노 판단): 시드마다 타이밍이 제각각이라 「좋은 판 나올 때까지 뽑기」는 못 한다.
모델이 잘하는 발음·억양은 그대로 두고, 못 믿을 「침묵의 길이」만 우리가 규칙으로
다시 자른다. 뽑기 1회, 검수 1회. 마음에 안 들면 규칙 숫자를 고치지 다시 뽑지 않는다.

흐름
  대본(caption_script_manifest.json 의 beats) → 문장 단위 분할(마침표·물음표)
  → 문장마다 API 1회(시드 고정, 감정 normal, 목소리별 tempo)
  → 문장 안 쉼 편집 / 문장별 -20 LUFS / 문장·질문·구간 사이 규칙 무음으로 결합
  → narration.wav + narration_timing.json (구간 시작 시각, 문장 시각)

  python typecast_narration.py --piece productions/shorts/2026-09-04_잠재공간 --voice piljae
  python typecast_narration.py --piece productions/<작품> --voice-id tc_… --tempo 1.0   # 다른 목소리(타입캐스트 목소리 ID)

키: 환경변수 TYPECAST_API_KEY, 없으면 ~/.deno/typecast_api_key.txt (저장소 밖). 값은 어디에도 찍지 않는다.
무료 API 플랜 음성은 상업 이용 불가·출처 표기 필요(공식 요금표 2026-09-27 확인) — 수익 채널이면 유료 플랜.
크레딧: 1자 = 1크레딧. 무료 월 15,000. 한 편 약 650. 이미 받은 문장은 재사용한다.
"""
import argparse, hashlib, io, json, os, re, subprocess, sys, time, urllib.request, urllib.error, wave
import numpy as np

BASE = 'https://api.typecast.ai'
KEY_PATH = os.path.join(os.path.expanduser('~'), '.deno', 'typecast_api_key.txt')
UA = 'typecast-direct/1 python typecast-integration/1 (source=api-page; generated_by=claude-code)'

# 채널 표준 목소리 (디노 확정 2026-09-05). tempo 는 청취로 잡은 값이다.
VOICES = {
    'piljae': dict(voice_id='tc_68257f68bc6e3c161ab5078d', name='필재', tempo=1.2),  # 메인 (디노 2026-09-07)
}
MAIN_VOICE = 'piljae'
MODEL = 'ssfm-v30'
SEED = 7

# 고정 규칙표 (초). 디노 확정 2026-09-05 — "이게 고정값이야".
RULE = dict(
    IN_PAUSE=0.15,   # 문장 안, 쉼표 없는 자리에서 모델이 멋대로 쉰 것 → 이 길이로
    COMMA=0.25,      # 쉼표 자리 (짧으면 늘리고 길면 자른다)
    SENT=0.35,       # 문장 사이
    SENT_Q=0.55,     # 질문(까요? / ?)으로 끝난 문장 뒤 — 보통 문장 사이보다 길게 둔다
    SEG=0.55,        # 구간(beat) 사이
    HEAD=0.20,       # 맨 앞 — 숏츠는 스크롤 중에 마주치므로 첫 소리가 대뜸 나오면 놀란다
    TAIL=0.50,       # 맨 끝
    LUFS=-20.0,      # 문장별 통합 라우드니스 (API 가 호출마다 13dB 까지 다르게 준다)
)
SR = 24000
MIN_GAP = 0.12       # 이보다 짧은 무음은 쉼으로 보지 않는다
EDGE = 0.04          # 소리 앞뒤 여유. 쉼 목표는 잰 값 기준이라 무음은 목표-2*EDGE 만 넣는다


# ---------------------------------------------------------------- API
def _key():
    k = os.environ.get('TYPECAST_API_KEY', '').strip()   # 환경변수가 먼저, 없으면 파일(2026-09-27 — 창고 첨부용)
    if not k:
        if not os.path.exists(KEY_PATH):
            sys.exit('Typecast 키가 없다 — 환경변수 TYPECAST_API_KEY 또는 파일 ' + KEY_PATH + ' (한 줄)')
        k = io.open(KEY_PATH, encoding='utf-8').read().strip()
    if len(k) < 10:
        sys.exit('키가 너무 짧다')
    return k


def tts(text, voice, out_path, seed=SEED):
    """문장 하나를 WAV 로 받는다. 이미 있으면 건너뛴다(크레딧 절약)."""
    if os.path.exists(out_path) and os.path.getsize(out_path) > 1000:
        return False
    k = _key()
    body = {'text': text, 'voice_id': voice['voice_id'], 'model': MODEL, 'language': 'kor',
            'seed': seed,
            'prompt': {'emotion_type': 'preset', 'emotion_preset': 'normal', 'emotion_intensity': 1.0},
            'output': {'audio_format': 'wav', 'audio_tempo': voice['tempo']}}
    req = urllib.request.Request(BASE + '/v1/text-to-speech', data=json.dumps(body).encode('utf-8'),
                                 method='POST', headers={'X-API-KEY': k, 'User-Agent': UA,
                                                         'Content-Type': 'application/json'})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                open(out_path, 'wb').write(r.read())
            return True
        except urllib.error.HTTPError as e:
            msg = e.read().decode('utf-8', 'replace').replace(k, '<KEY>')
            if (e.code == 429 or e.code >= 500) and attempt < 4:   # 한도·서버 장애는 쉬었다 다시
                time.sleep(4 * (attempt + 1)); continue
            hint = {401: '키 무효', 402: '크레딧 부족', 403: '접근 거부', 404: '목소리·모델 없음',
                    429: '요청 한도'}.get(e.code, '')
            sys.exit('Typecast HTTP %d %s\n%s' % (e.code, hint, msg[:400]))


# ---------------------------------------------------------------- 오디오
def read(p):
    r = subprocess.run(['ffmpeg', '-v', 'error', '-i', p, '-ar', str(SR), '-ac', '1', '-f', 'f32le', '-'],
                       capture_output=True)
    return np.frombuffer(r.stdout, dtype='<f4').astype(np.float64)


def write(p, a):
    w = wave.open(p, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((np.clip(a, -1, 1) * 32767).astype('<i2').tobytes()); w.close()


def chunks(a):
    e = np.convolve(np.abs(a), np.ones(240) / 240, 'same')
    m = e > max(e.max() * 0.02, 1e-4)
    idx = np.flatnonzero(m)
    if len(idx) == 0:
        return []
    out = []; s = idx[0]; prev = idx[0]
    for i in idx[1:]:
        if (i - prev) / SR >= MIN_GAP:
            out.append((s, prev)); s = i
        prev = i
    out.append((s, prev))
    k = int(EDGE * SR)
    return [(max(0, x - k), min(len(a), y + k)) for x, y in out]


def lufs_of(path):
    r = subprocess.run(['ffmpeg', '-v', 'info', '-i', path, '-af', 'ebur128', '-f', 'null', '-'],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    m = re.findall(r'I:\s+(-?[\d.]+) LUFS', r.stderr)
    return float(m[-1]) if m else None


def edit_sentence(a, text, path):
    """안쪽 쉼을 규칙으로 다시 놓고, 문장 크기를 목표 LUFS 로 맞춘다."""
    cs = chunks(a)
    if not cs:
        return a, []
    n_comma = text.count(',')
    parts = [a[cs[0][0]:cs[0][1]]]; log = []
    for i in range(1, len(cs)):
        orig = (cs[i][0] - cs[i - 1][1]) / SR
        target = RULE['COMMA'] if i <= n_comma else RULE['IN_PAUSE']
        parts.append(np.zeros(max(0, int((target - 2 * EDGE) * SR))))
        parts.append(a[cs[i][0]:cs[i][1]])
        log.append((round(orig, 2), target))
    out = np.concatenate(parts)
    L = lufs_of(path)
    if L is not None:
        out = np.clip(out * 10 ** ((RULE['LUFS'] - L) / 20), -0.98, 0.98)
    return out, log


def split_sentences(t):
    return [s.strip() for s in re.split(r'(?<=[.?!])\s+', t.strip()) if s.strip()]


def is_question(t):
    return bool(re.search(r'(까요|\?)\s*[.?!]?\s*$', t))


# ---------------------------------------------------------------- 메인
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--piece', required=True, help='작품 폴더 (post/caption_script_manifest.json 사용)')
    ap.add_argument('--voice', choices=list(VOICES), default=MAIN_VOICE, help='기본 필재(메인)')
    ap.add_argument('--voice-id', default=None, help='다른 타입캐스트 목소리 ID(tc_…) — 주면 --voice 대신 쓴다')
    ap.add_argument('--tempo', type=float, default=None, help='말 빠르기(기본: 목소리 표의 값, --voice-id면 1.0)')
    ap.add_argument('--out', default=None, help='출력 폴더 (기본 renders/tts_typecast_<voice>)')
    ap.add_argument('--dry', action='store_true', help='호출 없이 문장 분할·크레딧만 계산')
    ap.add_argument('--seed', type=int, default=SEED,
                    help='시드. 기본 7 고정이다. 특정 문장이 잘못 나왔을 때만 --redo 와 함께 바꾼다')
    ap.add_argument('--redo', default=None,
                    help='이 문장만 캐시를 지우고 다시 받는다. 예: E05-2 또는 E05(구간 전체). '
                         '표현을 고쳐도 안 되고 TTS 자체가 잘못 읽은 경우에만 --seed 와 함께 쓴다')
    ap.add_argument('--slow', default=None,
                    help='구간별 쉼 배율. 예: E01:1.5,E02:1.5 — 그 구간으로 들어가는 쉼과 그 구간 안의 쉼을 배로 늘린다. 어떤 편에서 초반이 빠르게 들릴 때만 쓴다')
    a = ap.parse_args()

    REDO = set(a.redo.split(',')) if a.redo else set()
    SLOW = dict((k, float(v)) for k, v in
                (x.split(':') for x in a.slow.split(','))) if a.slow else {}
    if a.voice_id:
        voice, label = dict(voice_id=a.voice_id, name=a.voice_id, tempo=a.tempo or 1.0), a.voice_id
    else:
        voice, label = dict(VOICES[a.voice]), a.voice
        if a.tempo:
            voice['tempo'] = a.tempo
    man = json.load(io.open(os.path.join(a.piece, 'post', 'caption_script_manifest.json'), encoding='utf-8'))
    beats = [b for b in man['beats'] if (b.get('spoken_text') or '').strip()]
    out_dir = a.out or os.path.join(a.piece, 'renders', 'tts_typecast_' + label)
    unit_dir = os.path.join(out_dir, 'units'); os.makedirs(unit_dir, exist_ok=True)

    units = []
    for b in beats:
        for j, s in enumerate(split_sentences(b['spoken_text']), 1):
            units.append(dict(seg=b['id'], n=j, text=s))
    chars = sum(len(u['text']) for u in units)
    print('%s · %s(%s) tempo %.1f · 구간 %d · 문장 %d · %d자 (= 크레딧 최대 %d)'
          % (os.path.basename(a.piece.rstrip('/\\')), voice['name'], label, voice['tempo'],
             len(beats), len(units), chars, chars))
    if a.dry:
        for u in units: print('  %s-%d  %s' % (u['seg'], u['n'], u['text']))
        return

    called = 0
    for u in units:
        # 파일명에 문장 해시를 넣는다. 표기를 고치면 새로 받고, 같은 문장은 재사용한다.
        h = hashlib.md5(u['text'].encode('utf-8')).hexdigest()[:8]
        u['path'] = os.path.join(unit_dir, '%s_%d_%s.wav' % (u['seg'], u['n'], h))
        if (u['seg'] in REDO or ('%s-%d' % (u['seg'], u['n'])) in REDO) and os.path.exists(u['path']):
            os.remove(u['path'])   # 캐시는 글자 해시라, 지워야 시드가 반영된다
        if tts(u['text'], voice, u['path'], seed=a.seed):
            called += 1
    print('API 호출 %d회 (재사용 %d)' % (called, len(units) - called))

    out = [np.zeros(int(RULE['HEAD'] * SR))]; t = RULE['HEAD']
    prev = None; prev_text = ''; seg_starts = {}; timeline = []; edited = 0
    for u in units:
        aud, log = edit_sentence(read(u['path']), u['text'], u['path'])
        if prev is not None:
            g = RULE['SEG'] if u['seg'] != prev else (RULE['SENT_Q'] if is_question(prev_text) else RULE['SENT'])
            g *= SLOW.get(u['seg'], 1.0)
            # 소리 덩어리마다 EDGE 만큼 여유가 붙어 있어 무음은 g-2*EDGE 만 넣는다. 장부(t)도
            # 실제로 넣은 길이만큼만 진행한다 (2026-09-05 수정: g 를 더해 경계마다 0.08초씩 밀렸음)
            z = max(0, int((g - 2 * EDGE) * SR))
            out.append(np.zeros(z)); t += z / SR
        if u['seg'] != prev:
            seg_starts[u['seg']] = round(t, 3)
        timeline.append(dict(seg=u['seg'], n=u['n'], text=u['text'], start=round(t, 3),
                             end=round(t + len(aud) / SR, 3), pauses=log))
        edited += sum(1 for o, tg in log if abs(o - tg) >= 0.08)
        out.append(aud); t += len(aud) / SR; prev = u['seg']; prev_text = u['text']
    out.append(np.zeros(int(RULE['TAIL'] * SR)))
    wav = np.concatenate(out)
    wav_path = os.path.join(out_dir, 'narration.wav'); write(wav_path, wav)

    segs = []
    ids = [b['id'] for b in beats]
    for i, sid in enumerate(ids):
        end = seg_starts[ids[i + 1]] - RULE['SEG'] if i + 1 < len(ids) else round(len(wav) / SR - RULE['TAIL'], 3)
        segs.append(dict(id=sid, start=seg_starts[sid], end=round(end, 3), duration=round(end - seg_starts[sid], 3)))
    json.dump(dict(voice=label, voice_id=voice['voice_id'], tempo=voice['tempo'], model=MODEL, seed=SEED,
                   rule=RULE, total_seconds=round(len(wav) / SR, 3), segments=segs, sentences=timeline),
              io.open(os.path.join(out_dir, 'narration_timing.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print('총 %.2f초 · 손댄 쉼 %d곳 · LUFS 목표 %.0f' % (len(wav) / SR, edited, RULE['LUFS']))
    for s in segs:
        print('  %s  %6.2f ~ %6.2f  (%.2f초)' % (s['id'], s['start'], s['end'], s['duration']))
    print('->', wav_path)
    print('->', os.path.join(out_dir, 'narration_timing.json'))


if __name__ == '__main__':
    main()
