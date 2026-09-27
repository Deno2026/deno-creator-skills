"""ComfyUI 상태 확인 — 대기줄 전체 또는 특정 작업의 진행 상황을 본다.

사용 예:
  python status.py                # 대기줄 전체 (지금 도는 것 + 기다리는 것)
  python status.py <작업번호>      # 그 작업이 끝났는지, 결과가 뭔지
  python status.py --server http://<다른 PC>:8188   # 다른 PC의 ComfyUI 대기줄
"""
import argparse
import json
import urllib.request

SERVER = "http://127.0.0.1:8188"


def get(server: str, path: str):
    with urllib.request.urlopen(f"{server}{path}", timeout=15) as resp:
        return json.loads(resp.read())


def show_queue(server: str) -> None:
    q = get(server, "/queue")
    running = q.get("queue_running", [])
    pending = q.get("queue_pending", [])
    print(f"지금 도는 작업: {len(running)}개 / 기다리는 작업: {len(pending)}개")
    for item in running:
        print(f"  [진행 중] {item[1]}")
    for item in pending:
        print(f"  [대기]   {item[1]}")


def show_job(server: str, prompt_id: str) -> None:
    hist = get(server, f"/history/{prompt_id}")
    if prompt_id not in hist:
        print("아직 끝나지 않았거나 없는 작업번호다. (대기줄은 인자 없이 실행해 확인)")
        return
    entry = hist[prompt_id]
    status = entry.get("status", {})
    print(f"상태: {status.get('status_str', '알 수 없음')}  완료 여부: {status.get('completed')}")
    for node_id, out in entry.get("outputs", {}).items():
        for kind in ("images", "video", "videos", "audio", "gifs"):
            for f in out.get(kind, []):
                sub = f.get("subfolder", "")
                loc = f"{sub}/{f['filename']}" if sub else f["filename"]
                print(f"  결과물({kind}): {loc}  [{f.get('type', '?')} 폴더]")
    if not entry.get("outputs"):
        print("  결과물 없음 — 오류로 끝났을 수 있다. ComfyUI 창 로그 확인.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="ComfyUI 상태 확인")
    ap.add_argument("prompt_id", nargs="?", help="작업번호 (없으면 대기줄 전체)")
    ap.add_argument("--server", default=SERVER)
    args = ap.parse_args()
    if args.prompt_id:
        show_job(args.server, args.prompt_id)
    else:
        show_queue(args.server)
