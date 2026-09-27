"""MiniMax H3 FL2VA first-frame I2V launcher for VDN pruned 8-step.

The production contract is documented in
``library/workflows/minimax-h3/README.md``.  This script keeps that
contract narrow: one independent start image, 5-15 seconds, native output,
Comfy Kitchen attention (ModelAttentionBackend), VDN pruned at eight steps, sigma shift 12/3, Euler/simple.
The historical filename remains a compatibility entry point.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import random
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

# Windows 한글 콘솔(cp949)에서 도움말·안내문의 특수문자로 죽지 않도록 출력을 UTF-8로 고정한다.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


HERE = Path(__file__).resolve().parent
# ComfyUI 설치 폴더(선택): 환경변수 COMFY_ROOT 또는 --comfy-root. 있으면 로라 파일 존재 확인과 결과의 전체 경로 기록에 쓰고, 없으면 둘 다 건너뛴다.
COMFY_ROOT: Path | None = Path(os.environ["COMFY_ROOT"]) if os.environ.get("COMFY_ROOT") else None
DEFAULT_SERVER = "http://127.0.0.1:8188"
DEFAULT_MODEL = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
DEFAULT_CLIP = "qwen3vl_32b_minimax_h3_int8_convrot.safetensors"
DEFAULT_LORA = r"H3_R2V_AB\minimax_h3_dmd_fl2va_8step_turbo_pruned.safetensors"
DEFAULT_STEPS = 8
VIDEO_VAE = "minimax_h3_video_vae_fp16.safetensors"
AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors"

def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def request_json(
    server: str, path: str, payload: dict[str, Any] | None = None, timeout: int = 60
) -> Any:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {} if body is None else {"Content-Type": "application/json"}
    request = urllib.request.Request(f"{server}{path}", data=body, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def upload_image(server: str, path: Path) -> str:
    filename = path.name
    boundary = uuid.uuid4().hex
    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    header = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode("utf-8")
    body = header + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode("utf-8")
    request = urllib.request.Request(
        f"{server}/upload/image",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        result = json.loads(response.read())
    name = result["name"]
    subfolder = result.get("subfolder", "")
    return f"{subfolder}/{name}" if subfolder else name


def snapped_frames(duration: float) -> int:
    from h3_vdn import frame_grid
    return frame_grid(duration)


def ensure_queue_available(server: str) -> None:
    queue = request_json(server, "/queue", timeout=10)
    running = queue.get("queue_running", [])
    pending = queue.get("queue_pending", [])
    if running or pending:
        raise RuntimeError(
            f"shared ComfyUI queue is busy: running={len(running)} pending={len(pending)}"
        )


def build_workflow(*, prompt, image_name, prefix, seed, width, height, frames,
                   model=DEFAULT_MODEL, clip=DEFAULT_CLIP, lora=DEFAULT_LORA,
                   quality="standard", last_image=None):
    from h3_vdn import build_graph
    if model != DEFAULT_MODEL or lora.replace("/", "\\") != DEFAULT_LORA:
        raise ValueError("Production FL2VA requires the matched INT8 pruned + VDN pair")
    workflow = build_graph(mode="fl2va", quality=quality, prompt=prompt,
        images=[image_name], prefix=prefix, seed=seed, width=width, height=height,
        frames=frames, last_image=last_image)
    workflow["3"]["inputs"]["clip_name"] = clip
    return workflow


def collect_outputs(entry: dict[str, Any]) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for node_id, node_output in entry.get("outputs", {}).items():
        for key in ("images", "video", "videos", "gifs", "audio"):
            for item in node_output.get(key, []) or []:
                value = {"node_id": node_id, "kind": key, **item}
                filename = item.get("filename")
                if filename:
                    relative = Path(item.get("subfolder", "")) / filename
                    if COMFY_ROOT:
                        value["fullpath"] = str((COMFY_ROOT / "output" / relative).resolve())
                found.append(value)
    return found


def wait_for_result(server: str, prompt_id: str, timeout_seconds: int) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        history = request_json(server, f"/history/{prompt_id}", timeout=30)
        if prompt_id in history:
            entry = history[prompt_id]
            status = entry.get("status", {})
            if status.get("status_str") == "error" or status.get("completed") is False:
                messages = status.get("messages", [])
                if any(message and message[0] == "execution_error" for message in messages):
                    raise RuntimeError(f"ComfyUI execution failed: {messages}")
            outputs = collect_outputs(entry)
            if outputs:
                return {"history": entry, "outputs": outputs}
        time.sleep(2)
    raise TimeoutError(f"timed out after {timeout_seconds}s waiting for {prompt_id}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="MiniMax H3 FL2VA VDN pruned 8-step I2V"
    )
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--ref", required=True, help="independent start image")
    parser.add_argument("--duration", required=True, type=float)
    parser.add_argument("--width", type=int, default=None)
    parser.add_argument("--height", type=int, default=None)
    parser.add_argument("--quality", choices=["draft", "standard"], default="standard")
    parser.add_argument("--last-ref", help="independent end anchor for FLF2V")
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--clip", default=DEFAULT_CLIP)
    parser.add_argument("--lora", default=DEFAULT_LORA)
    parser.add_argument("--server", default=DEFAULT_SERVER)
    parser.add_argument("--comfy-root", default=None, help="ComfyUI 설치 폴더(선택, 환경변수 COMFY_ROOT 대신) — 로라 존재 확인·결과 전체 경로 기록에 쓴다")
    parser.add_argument("--record-dir", default=None)
    parser.add_argument("--workflow-dir", default=None)
    parser.add_argument("--timeout", type=int, default=7200)
    args = parser.parse_args()

    prompt_path = Path(args.prompt_file).resolve()
    ref_path = Path(args.ref).resolve()
    if not prompt_path.is_file():
        parser.error(f"prompt file not found: {prompt_path}")
    if not ref_path.is_file():
        parser.error(f"start image not found: {ref_path}")
    if not 5.0 <= args.duration <= 15.1:
        parser.error("--duration must be between 5 and 15.1 seconds")
    from h3_vdn import SIZES
    if args.width is None and args.height is None:
        args.width, args.height = SIZES[args.quality]
    if args.width is None or args.height is None:
        parser.error("width and height must be supplied together")
    if args.width % 32 or args.height % 32:
        parser.error("--width and --height must both be multiples of 32")
    global COMFY_ROOT
    if args.comfy_root:
        COMFY_ROOT = Path(args.comfy_root)
    if COMFY_ROOT and not (COMFY_ROOT / "models" / "loras" / args.lora).is_file():
        parser.error(f"VDN LoRA not found: {COMFY_ROOT / 'models' / 'loras' / args.lora}")

    lint = subprocess.run(
        [sys.executable, str(HERE / "h3_prompt_lint.py"), str(prompt_path)],
        check=False,
    )
    if lint.returncode:
        raise SystemExit(lint.returncode)

    ensure_queue_available(args.server)
    prompt = prompt_path.read_text(encoding="utf-8").strip()
    seed = args.seed if args.seed is not None else random.randint(0, 2**48)
    frames = snapped_frames(args.duration)
    image_name = upload_image(args.server, ref_path)
    workflow = build_workflow(
        prompt=prompt,
        image_name=image_name,
        prefix=args.prefix,
        seed=seed,
        width=args.width,
        height=args.height,
        frames=frames,
        model=args.model,
        clip=args.clip,
        lora=args.lora,
        quality=args.quality,
        last_image=upload_image(args.server, Path(args.last_ref)) if args.last_ref else None,
    )

    classes = [node["class_type"] for node in workflow.values()]
    kitchen_nodes = [n for n in workflow.values() if n["class_type"] == "ModelAttentionBackend" and n["inputs"].get("attention") == "comfy kitchen attention"]
    if "PathchSageAttentionKJ" in classes or len(kitchen_nodes) < 1:
        raise RuntimeError("workflow must use Comfy Kitchen attention (ModelAttentionBackend) and no Sage node (Deno 2026-09-26)")
    if classes.count("LoraLoaderModelOnly") != 1 or "DenoMiniMaxH3AccLoader" in classes:
        raise RuntimeError("workflow has an invalid VDN loader stack")
    if "SolAttnMiniMax" in classes or "BlockSparseAttention" in classes:
        raise RuntimeError("Sol attention is not used (Deno 2026-09-22): 8-step + Kitchen only")

    stem = Path(args.prefix).name
    if args.workflow_dir:
        workflow_path = Path(args.workflow_dir).resolve() / f"{stem}.api.json"
        write_json(workflow_path, workflow)
    else:
        workflow_path = None

    submitted_at = time.time()
    try:
        queued = request_json(args.server, "/prompt", {"prompt": workflow}, timeout=60)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise RuntimeError(f"ComfyUI rejected workflow: {detail}") from error
    prompt_id = queued["prompt_id"]
    print(f"queued prompt_id={prompt_id} seed={seed} frames={frames}", flush=True)
    result = wait_for_result(args.server, prompt_id, args.timeout)
    elapsed = time.time() - submitted_at
    videos = [
        item
        for item in result["outputs"]
        if str(item.get("filename", "")).lower().endswith(".mp4")
    ]
    if len(videos) != 1:
        raise RuntimeError(f"expected one MP4 output, got: {videos}")
    video_path = Path(videos[0]["fullpath"])
    if not video_path.is_file():
        raise FileNotFoundError(video_path)

    record = {
        "status": "success",
        "prompt_id": prompt_id,
        "server": args.server,
        "seed": seed,
        "prompt_file": str(prompt_path),
        "prompt_sha256": sha256_file(prompt_path),
        "start_anchor": str(ref_path),
        "start_anchor_sha256": sha256_file(ref_path),
        "reference_kind": "independent_start_anchor",
        "generated_video_frame_reuse": False,
        "duration_seconds_requested": args.duration,
        "frames": frames,
        "width": args.width,
        "height": args.height,
        "quality": args.quality,
        "start_width": args.width,
        "start_height": args.height,
        "fps": 24,
        "base_model": args.model,
        "clip_model": args.clip,
        "lora": args.lora,
        "lora_sha256": sha256_file(lora_path),
        "steps": DEFAULT_STEPS,
        "sampler": "euler",
        "scheduler": "simple",
        "denoise": 1.0,
        "shift_video": 12.0,
        "shift_audio": 3.0,
        "attention": "Comfy Kitchen (ModelAttentionBackend)",
        "sol_attention": False,
        "submitted_workflow": str(workflow_path) if workflow_path else None,
        "raw_video": str(video_path.resolve()),
        "elapsed_seconds": round(elapsed, 3),
        "outputs": result["outputs"],
    }
    if args.record_dir:
        record_path = Path(args.record_dir).resolve() / f"{stem}.json"
        write_json(record_path, record)
        print(f"record={record_path}", flush=True)
    print(f"video={video_path.resolve()}", flush=True)
    print(json.dumps(record, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
