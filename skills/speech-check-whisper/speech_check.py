"""대사 없는 판에 말소리가 섞였는지 본다 — Whisper large-v3, 언어 자동 감지(외국어도 그 언어로 적힘).

whisper_check.py(ComfyUI, 한국어 고정)는 원고 대조용이라 중국어·영어 말소리를 한국어로 뭉개 적는다. 이 스크립트는 faster-whisper가 설치된
파이썬(`pip install faster-whisper`)으로 돌리고, 모델 large-v3(약 3GB)는 처음 한 번 --download로 받아 둔 뒤 이후에는 받은 것만 쓴다
(local_files_only). CPU int8 기본, --device cuda면 float16. 전사는 판정이 아니다 — 음성 구간 검출(VAD)을 끄면 잡음 위에 없는 말
(예: 「Teksting av …」)을 지어낼 수 있으므로 기본은 켠다.

    python speech_check.py a.mp4 b.mp4 [--no-vad] [--device cuda] [--download]
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
# 이 폴더의 queue.py가 표준 라이브러리 queue를 가려 huggingface_hub가 죽는다 — 스크립트 폴더를 모듈 경로에서 뺀다.
_HERE = Path(__file__).resolve().parent
sys.path = [p for p in sys.path if Path(p or ".").resolve() != _HERE]


def main() -> int:
    ap = argparse.ArgumentParser(description="대사 없는 판의 말소리 검출(언어 자동 감지)")
    ap.add_argument("media", nargs="+", type=Path)
    ap.add_argument("--no-vad", action="store_true", help="음성 구간 검출을 끄고 전체를 전사(환청 주의)")
    ap.add_argument("--words", action="store_true", help="낱말마다 시각을 찍는다(긴 구간이 실제로 어디서 말하는지 볼 때)")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--download", action="store_true", help="모델 large-v3가 없으면 받는다(처음 한 번)")
    a = ap.parse_args()
    from faster_whisper import WhisperModel

    model = WhisperModel("large-v3", device=a.device, compute_type="int8" if a.device == "cpu" else "float16",
                         local_files_only=not a.download)
    found = 0
    for src in a.media:
        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "a.wav"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-ac", "1", "-ar", "16000", str(wav)], check=True)
            segs, info = model.transcribe(str(wav), language=None, vad_filter=not a.no_vad, beam_size=5,
                                          word_timestamps=a.words)
            segs = list(segs)
        found += bool(segs)
        print(f"== {src.name}  감지 언어 {info.language} ({info.language_probability:.2f}), 말 구간 {len(segs)}개", flush=True)
        for s in segs:
            print(f"   {s.start:5.1f}-{s.end:5.1f}s  {s.text.strip()}", flush=True)
            for w in (s.words or []) if a.words else []:
                print(f"        {w.start:5.2f}-{w.end:5.2f}s  {w.word.strip()}  (p={w.probability:.2f})", flush=True)
    return 1 if found else 0


if __name__ == "__main__":
    raise SystemExit(main())
