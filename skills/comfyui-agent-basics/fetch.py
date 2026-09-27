"""ComfyUI 결과 회수 — 끝난 작업의 결과물을 창고 작업장(_scratch/renders)으로 내려받는다.

사용 예:
  python fetch.py <작업번호>
  python fetch.py <작업번호> --out "다른\\폴더"

결과물 원본은 ComfyUI 출력 폴더에도 그대로 남는다. 여기 내려받는 것은
검토·비교용 사본이며, _scratch/ 는 커밋되지 않는 작업장이다 (영상 커밋 금지 규칙).
"""
import argparse
import json
import os
import urllib.parse
import urllib.request
import sys

# Windows 한글 콘솔(cp949)에서 도움말·안내문의 특수문자로 죽지 않도록 출력을 UTF-8로 고정한다.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.normpath(os.path.join(HERE, "..", "..", "_scratch", "renders"))
SERVER = "http://127.0.0.1:8188"


def main() -> None:
    ap = argparse.ArgumentParser(description="ComfyUI 결과 회수")
    ap.add_argument("prompt_id", help="작업번호")
    ap.add_argument("--out", default=DEFAULT_OUT, help="저장 폴더 (기본: _scratch/renders)")
    ap.add_argument("--server", default=SERVER)
    args = ap.parse_args()

    with urllib.request.urlopen(f"{args.server}/history/{args.prompt_id}", timeout=15) as resp:
        hist = json.loads(resp.read())
    if args.prompt_id not in hist:
        print("아직 끝나지 않았거나 없는 작업번호다.")
        return

    os.makedirs(args.out, exist_ok=True)
    saved = 0
    for node_id, out in hist[args.prompt_id].get("outputs", {}).items():
        for kind in ("images", "video", "videos", "audio", "gifs"):
            for f in out.get(kind, []):
                params = urllib.parse.urlencode({
                    "filename": f["filename"],
                    "subfolder": f.get("subfolder", ""),
                    "type": f.get("type", "output"),
                })
                dest = os.path.join(args.out, f["filename"])
                with urllib.request.urlopen(f"{args.server}/view?{params}", timeout=300) as r, \
                        open(dest, "wb") as w:
                    w.write(r.read())
                print(f"저장: {dest}")
                saved += 1
    if saved == 0:
        print("내려받을 결과물이 없다 — 오류로 끝났을 수 있다.")


if __name__ == "__main__":
    main()
