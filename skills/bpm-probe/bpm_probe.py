"""영상·오디오의 템포(BPM) 측정 — BGM을 춤·컷 박자에 맞춰 만들기 위한 자.

사용 예:
  python bpm_probe.py "C:/경로/영상.mp4"
  python bpm_probe.py 소리.wav --lo 70 --hi 180

영상을 주면 ffmpeg로 소리만 뽑아서 잰다(임시 wav는 지운다).
두 가지 방법으로 재고 서로 맞는지 확인한다 —
  ① 자기상관: 소리 변화량이 몇 초마다 되풀이되는지
  ② 빗살 정합: 후보 BPM의 박자 격자에 타격음이 얼마나 잘 몰리는지
둘이 같은 값(또는 정확한 배수 관계)으로 수렴하면 신뢰할 만하다.
배수 관계(96과 192처럼)가 나오면 낮은 쪽이 대개 곡의 실제 템포다.

측정한 BPM은 배경음 프롬프트에 「… at 120 BPM」처럼 그대로 적는다(stable-audio-3-bgm 편).
"""
import argparse
import os
import subprocess
import sys
import tempfile

import numpy as np
from scipy.io import wavfile
from scipy.signal import stft

HOP = 256
NFFT = 1024


def to_wav(path: str) -> tuple[str, bool]:
    """오디오 파일이면 그대로, 그 외(영상)는 임시 wav로 뽑는다."""
    if path.lower().endswith(".wav"):
        return path, False
    tmp = os.path.join(tempfile.gettempdir(), "bpm_probe_tmp.wav")
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", path,
           "-vn", "-ac", "1", "-ar", "22050", tmp]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(tmp):
        print("소리를 뽑지 못했다:", r.stderr.strip()[:300])
        sys.exit(1)
    return tmp, True


def onset_envelope(path: str) -> tuple[np.ndarray, float, float]:
    sr, x = wavfile.read(path)
    x = x.astype(np.float64)
    if x.ndim > 1:
        x = x.mean(axis=1)
    if np.issubdtype(np.int16, x.dtype) or abs(x).max() > 1.5:
        x = x / 32768.0
    _, _, Z = stft(x, fs=sr, nperseg=NFFT, noverlap=NFFT - HOP,
                   boundary=None, padded=False)
    S = np.log1p(np.abs(Z) * 100)
    flux = np.diff(S, axis=1)
    flux[flux < 0] = 0
    onset = flux.sum(axis=0)
    onset = np.maximum(onset - onset.mean(), 0)
    return onset, sr / HOP, len(x) / sr


def by_autocorr(onset, fps, lo, hi):
    o = onset - onset.mean()
    ac = np.correlate(o, o, mode="full")[len(o) - 1:]
    ac = ac / ac[0]
    lag_lo, lag_hi = int(fps * 60 / hi), int(fps * 60 / lo)
    lags = np.arange(lag_lo, lag_hi)
    scores = ac[lag_lo:lag_hi]
    out, seen = [], []
    for i in np.argsort(scores)[::-1]:
        bpm = 60 * fps / lags[i]
        if any(abs(bpm - s) < 4 for s in seen):
            continue
        seen.append(bpm)
        out.append((bpm, float(scores[i])))
        if len(out) >= 6:
            break
    return out


def by_comb(onset, fps, lo, hi):
    res = []
    for bpm in np.arange(lo, hi + 0.01, 0.25):
        period = 60.0 / bpm * fps
        best = 0.0
        for ph in np.linspace(0, period, 8, endpoint=False):
            idx = np.round(np.arange(ph, len(onset) - 1, period)).astype(int)
            idx = idx[(idx >= 1) & (idx < len(onset) - 1)]
            if len(idx) < 8:
                continue
            v = np.maximum.reduce([onset[idx - 1], onset[idx], onset[idx + 1]]).mean()
            best = max(best, v)
        res.append((best, bpm))
    res.sort(reverse=True)
    out, seen = [], []
    for score, bpm in res:
        if any(abs(bpm - s) < 4 for s in seen):
            continue
        seen.append(bpm)
        out.append((bpm, float(score)))
        if len(out) >= 6:
            break
    return out


def fold(bpm, lo=85.0, hi=170.0):
    while bpm < lo:
        bpm *= 2
    while bpm > hi:
        bpm /= 2
    return bpm


def main() -> None:
    ap = argparse.ArgumentParser(description="영상·오디오 템포 측정")
    ap.add_argument("path", help="영상 또는 오디오 파일")
    ap.add_argument("--lo", type=float, default=60.0, help="탐색 하한 BPM")
    ap.add_argument("--hi", type=float, default=200.0, help="탐색 상한 BPM")
    ap.add_argument("--profile", action="store_true", help="4초 구간별 세기도 표시")
    args = ap.parse_args()

    wav, temp = to_wav(args.path)
    try:
        onset, fps, dur = onset_envelope(wav)
        print(f"길이 {dur:.1f}초")

        ac = by_autocorr(onset, fps, args.lo, args.hi)
        print("\n[① 자기상관]")
        for bpm, s in ac:
            print(f"   {bpm:7.2f} BPM   {s:.3f}")

        comb = by_comb(onset, fps, args.lo, args.hi)
        print("\n[② 빗살 정합]")
        for bpm, s in comb:
            print(f"   {bpm:7.2f} BPM   {s:.4f}")

        top_ac, top_comb = fold(ac[0][0]), fold(comb[0][0])
        agree = abs(top_ac - top_comb) < 4
        final = top_comb
        print(f"\n[판정] 자기상관 {top_ac:.1f} / 빗살 {top_comb:.1f}"
              f"  →  {'수렴' if agree else '불일치(의심)'}")
        print(f"  최종 {final:.2f} BPM   한 마디(4박) {4 * 60 / final:.2f}초")
        print(f"  프롬프트에 적을 값: {round(final)} BPM")
        if not agree:
            print("  ※ 두 방법이 갈렸다. 배수 관계인지 확인하고,")
            print("    안 맞으면 --lo/--hi 범위를 좁혀 다시 재라.")

        if args.profile:
            sr, x = wavfile.read(wav)
            x = x.astype(np.float64) / 32768.0
            if x.ndim > 1:
                x = x.mean(axis=1)
            print("\n[4초 구간별 세기 — 곡 흐름]")
            seg = sr * 4
            for i in range(0, len(x) - seg + 1, seg):
                db = 20 * np.log10(np.sqrt((x[i:i + seg] ** 2).mean()) + 1e-9)
                print(f"   {i // sr:>3}~{i // sr + 4:>3}초  {db:6.1f}dB  "
                      + "#" * max(0, int((db + 40) * 1.5)))
    finally:
        if temp and os.path.exists(wav):
            os.remove(wav)


if __name__ == "__main__":
    main()
