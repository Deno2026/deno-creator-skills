"""음악 생성 큐잉 — Stable Audio 3 Medium(증류판). 정본 그래프는 library/workflows/stable-audio-3-bgm/ (디노 승격 2026-09-27).

사용 예:
  python music_queue.py --prompt "서술형 프롬프트" --seconds 25
  python music_queue.py --prompt-file p.txt --seconds 20 --batch 4 --server http://<다른 PC>:8188

- 기술 설정(8스텝·cfg 1.0·lcm·simple)은 ComfyUI 공식 템플릿 순정값 — 정본 API 파일이 소유하며 여기서 바꾸지 않는다.
- 연주곡(BGM)·앰비언트 전용이다. 가사 있는 노래는 MiniMax Music 3로 간다
  (`.claude/skills/minimax-music/SKILL.md`).
- 프롬프트는 한 문단, 앞에 `TrackType: Music, VocalType: Instrumental.`을 붙인다(공식 가이드). 부정 프롬프트는 cfg 1에서 무효.
- 결과는 ComfyUI output/audio/에 남는다 — fetch.py <작업번호>로 회수한다.
- 정본 그래프는 이 스크립트 옆에 같이 받은 것이 먼저이고, 없으면 디노 리포 배치(library/workflows/stable-audio-3-bgm/)를 찾는다.
"""
import argparse
import json
import random
import sys
import urllib.request
from pathlib import Path

# Windows 한글 콘솔(cp949)에서 도움말·안내문의 특수문자로 죽지 않도록 출력을 UTF-8로 고정한다.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SERVER = "http://127.0.0.1:8188"  # 다른 PC의 ComfyUI는 --server로
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
GRAPH_NAME = "stable_audio3_medium_bgm.api.json"
# 정본 그래프: 이 스크립트 옆(창고 첨부로 같이 받은 경우)이 먼저, 없으면 디노 리포 배치
WORKFLOW = next((p for p in (HERE / GRAPH_NAME, ROOT / "library" / "workflows" / "stable-audio-3-bgm" / GRAPH_NAME) if p.exists()), HERE / GRAPH_NAME)


def build_graph(prompt: str, seconds: float, seed: int, prefix: str, batch: int = 1) -> dict:
    """정본 API 그래프를 읽어 프롬프트·길이·시드·저장 이름·후보 수만 넣는다."""
    wf = json.loads(WORKFLOW.read_text(encoding="utf-8"))
    wf["3"]["inputs"]["text"] = prompt
    wf["5"]["inputs"]["seconds"] = float(seconds)
    wf["5"]["inputs"]["batch_size"] = int(batch)
    wf["6"]["inputs"]["seed"] = int(seed)
    wf["8"]["inputs"]["filename_prefix"] = prefix
    return wf


def queue(wf, server: str = SERVER) -> str:
    payload = json.dumps({"prompt": wf}).encode("utf-8")
    req = urllib.request.Request(f"{server}/prompt", data=payload,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            r = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print("큐잉 실패:", e.read().decode("utf-8", "replace"))
        sys.exit(1)
    print(f"큐잉 완료  작업번호: {r['prompt_id']}")
    return r["prompt_id"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", help="서술형 프롬프트 한 문단")
    ap.add_argument("--prompt-file", help="프롬프트 파일(UTF-8)")
    ap.add_argument("--seconds", type=float, default=25.0, help="길이(초) 1~1000 — 실제 출력은 ±0.05초")
    ap.add_argument("--batch", type=int, default=1, help="한 번에 뽑을 후보 수(1~4 권장)")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--prefix", default=None)
    ap.add_argument("--server", default=SERVER, help="ComfyUI 주소(다른 PC면 http://<주소>:8188)")
    args = ap.parse_args()
    if not args.prompt and not args.prompt_file:
        ap.error("--prompt 또는 --prompt-file이 필요하다")
    prompt = Path(args.prompt_file).read_text(encoding="utf-8").strip() if args.prompt_file else args.prompt
    seed = args.seed if args.seed is not None else random.randint(0, 2**48)
    prefix = args.prefix or "audio/BGM_sa3"
    wf = build_graph(prompt, args.seconds, seed, prefix, args.batch)
    print(f"Stable Audio 3 Medium  길이={args.seconds}초  후보={args.batch}  시드={seed}  정본={WORKFLOW.name}")
    queue(wf, args.server)


if __name__ == "__main__":
    main()
