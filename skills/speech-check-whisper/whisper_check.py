"""Whisper large-v3 발화 검수 — Mel-Band RoFormer로 목소리만 분리한 뒤 전사하고 원고와 대조한다(ComfyUI API).

디노 지시(2026-08-24): Whisper는 항상 large-v3(turbo 금지). 환경음·효과음이 섞이면 전사가 오염돼 변질 판정이 흔들리므로
MelBandRoFormer 노드로 vocals만 분리한 뒤 DenoAudioTranscript(Whisper large-v3, Korean)에 넣는다. 귀로 듣는 판정을 대신한다.

워크플로(클립당 4노드 + 공용 모델 로더 1개):
  LoadAudio -> MelBandRoFormerSampler(vocals = 출력 0) -> DenoAudioTranscript(large-v3, Korean) -> SaveText(whisper_vocal_NN.txt)

준비물:
  - ComfyUI(기본 http://127.0.0.1:8188)에 노드 팩 둘 — kijai/ComfyUI-MelBandRoFormer(MelBandRoFormerModelLoader·Sampler),
    Deno2026/comfyui-deno-custom-nodes(DenoAudioTranscript). SaveText·LoadAudio는 코어.
  - 모델: models/diffusion_models/MelBandRoformer_fp16.safetensors(HF Kijai/MelBandRoFormer_comfy, 약 456MB),
    models/stt/whisper/large-v3.pt(약 3GB — DenoAudioTranscript가 처음 실행 때 받거나 직접 둔다)
  - ffmpeg·ffprobe(PATH)

사용법:
  python whisper_check.py <mp4|wav ...> [--server http://127.0.0.1:8188] [--ref "문장1" "문장2" ...] [--timeout 1500]
  --ref 원고 문장(구두점·띄어쓰기는 있어도 된다 — 대조 때 지운다)을 주면 전사에 있는지(OK/MISS)까지 표시한다.

입력은 ffmpeg로 스테레오 16k wav로 바꿔 ComfyUI 입력함에 올린다(MelBandRoFormer는 스테레오 입력을 요구 — mono는 실패).

판정 기준:
  - Confidence high/medium(avg_logprob -0.35 이상이면 high)
  - 원고 문장 대조: 전사에 없는 문장(MISS)만 의심 구간 → 그 시점 2~3초 슬라이스를 다시 전사해 2차 확인
  - 영상 길이 이후의 segment는 Whisper 환청(발화 끝난 뒤 룸톤 위에 붙는 무관한 문장)으로 표시한다
  - 「얕게→약하게」, 「800m→800미터」 같은 동음·단위 표기 차이는 발화 문제가 아니다(_normalize가 단위를 통합한다)
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_SERVER = "http://127.0.0.1:8188"
MEL_MODEL = "MelBandRoformer_fp16.safetensors"


def prep_audio(src: Path, name: str, workdir: Path) -> Path:
    """MP4·오디오 -> 스테레오 16k wav(임시 폴더). 돌려주는 값은 wav 경로."""
    dst = workdir / f"tt_{name}.wav"
    video_flags = [] if src.suffix.lower() in (".wav", ".mp3", ".flac", ".m4a", ".ogg") else ["-vn"]
    subprocess.run(["ffmpeg", "-v", "quiet", "-y", "-i", str(src), *video_flags, "-ac", "2", "-ar", "16000", str(dst)], check=True)
    return dst


def upload(server: str, path: Path) -> str:
    """파일을 ComfyUI 입력함에 올리고(LoadAudio가 읽는 자리), 워크플로에 쓸 파일명을 돌려준다."""
    boundary = uuid.uuid4().hex
    ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="image"; filename="{path.name}"\r\n'
        f"Content-Type: {ctype}\r\n\r\n"
    ).encode("utf-8") + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode("utf-8")
    req = urllib.request.Request(f"{server}/upload/image", data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read())
    sub = result.get("subfolder", "")
    return f"{sub}/{result['name']}" if sub else result["name"]


def build_prompt(wavs: list[str]) -> dict:
    prompt: dict = {"100": {"class_type": "MelBandRoFormerModelLoader", "inputs": {"model_name": MEL_MODEL}}}
    for i, wav in enumerate(wavs):
        lid, mid, wid, sid = 1 + i * 4, 2 + i * 4, 3 + i * 4, 4 + i * 4
        prompt[str(lid)] = {"class_type": "LoadAudio", "inputs": {"audio": wav}}
        prompt[str(mid)] = {"class_type": "MelBandRoFormerSampler", "inputs": {"model": ["100", 0], "audio": [str(lid), 0]}}
        prompt[str(wid)] = {"class_type": "DenoAudioTranscript",
                            "inputs": {"audio": [str(mid), 0], "model": "large-v3", "language": "Korean", "model_after_run": "Keep loaded"}}
        prompt[str(sid)] = {"class_type": "SaveText",
                            "inputs": {"text": [str(wid), 0], "filename_prefix": f"whisper_vocal_{i:02d}", "format": "txt"}}
    return prompt


def queue(server: str, prompt: dict) -> str:
    body = json.dumps({"prompt": prompt}).encode()
    req = urllib.request.Request(f"{server}/prompt", data=body, headers={"Content-Type": "application/json"})
    resp = json.loads(urllib.request.urlopen(req, timeout=60).read())
    return resp["prompt_id"]


def wait_history(server: str, pid: str, timeout_s: int = 1500) -> dict | None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        time.sleep(10)
        h = json.loads(urllib.request.urlopen(f"{server}/history/{pid}", timeout=30).read())
        st = h.get(pid)
        if st and st.get("status", {}).get("status_str") == "error":
            print("ERROR", json.dumps(st.get("status"), ensure_ascii=False)[:800])
            return None
        if st and st.get("status", {}).get("completed"):
            return st
    print("TIMEOUT")
    return None


def audio_duration(path) -> float:
    r = subprocess.run(["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
                       capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return float("inf")


def extract(ctx_text: str, duration: float | None = None) -> tuple[str, str, list[tuple[float, float, str, bool]]]:
    """SaveText audio_context -> (confidence, transcript, segments[(s,e,text,환청)]). 영상 길이 이후로 뻗은 segment는 환청으로 표시."""
    conf = "unknown"
    m = re.search(r"Confidence: (\w+)", ctx_text)
    if m:
        conf = m.group(1)
    tr = ""
    m = re.search(r'Transcript: "(.*)"', ctx_text)
    if m:
        tr = m.group(1)
    segs = []
    for s in re.finditer(r"\[([\d.]+)-([\d.]+)\] \"(.*)\"", ctx_text):
        a, b = float(s.group(1)), float(s.group(2))
        hallu = duration is not None and b > duration + 0.2
        segs.append((a, b, s.group(3), hallu))
    return conf, tr, segs


def _normalize(s: str) -> str:
    """조사·구두점 제거 + 단위 표기 통합 (미터→m, 킬로미터→km, m/meter 혼용)."""
    s = re.sub(r"[\s,\.!?\-—:;:()\"']", "", s)
    for ko, en in (("킬로미터", "km"), ("미터", "m"), ("센티", "cm"), ("그램", "g"), ("킬로", "k"), ("미터짜리", "m짜리")):
        s = s.replace(ko, en)
    return s.lower()


def diff_ref(transcript: str, refs: list[str]) -> list[str]:
    """원고 문장별: 전사에 포함 여부(정규화 부분열 매칭)."""
    flat = _normalize(transcript)
    out = []
    for ref in refs:
        norm = _normalize(ref)
        probe, probe2 = norm[:12], norm[:20]
        hit = probe in flat and probe2 in flat
        out.append(("OK  " if hit else "MISS") + " " + ref)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Whisper large-v3 발화 검수(목소리 분리 후 전사·원고 대조)")
    ap.add_argument("media", nargs="+", type=Path, help="mp4·wav 등")
    ap.add_argument("--server", default=DEFAULT_SERVER, help="ComfyUI 주소")
    ap.add_argument("--ref", nargs="+", default=[], help="원고 문장들(있으면 OK/MISS 대조)")
    ap.add_argument("--timeout", type=int, default=1500, help="완료 대기 초(기본 1500)")
    args = ap.parse_args()

    names, wavs, durs = [], [], []
    with tempfile.TemporaryDirectory() as td:
        workdir = Path(td)
        for p in args.media:
            name = re.sub(r"[^0-9A-Za-z_]", "_", p.stem)
            names.append(name)
            durs.append(audio_duration(p))
            wavs.append(upload(args.server, prep_audio(p, name, workdir)))

    pid = queue(args.server, build_prompt(wavs))
    print("queued", pid, flush=True)
    st = wait_history(args.server, pid, args.timeout)
    if not st:
        raise SystemExit(1)
    outputs = sorted(st.get("outputs", {}).items(), key=lambda kv: int(kv[0]))
    for i, (nid, node) in enumerate(outputs):
        if not node.get("text"):
            continue
        idx = i % len(names)
        conf, tr, segs = extract(node["text"][0], duration=durs[idx])
        print(f"=== {names[idx]} [{conf}] ===")
        print(f"  {tr}")
        for s, e, t, hallu in segs:
            tag = "  <환청: 영상 길이 이후>" if hallu else ""
            print(f"  [{s:6.2f}-{e:6.2f}] {t}{tag}")
        if args.ref:
            for line in diff_ref(tr, args.ref):
                print("  ref:", line)
        print(flush=True)
    print("DONE")


if __name__ == "__main__":
    main()
