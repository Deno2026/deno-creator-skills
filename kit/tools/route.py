"""Deno Director 키트 라우터 — 작업 유형 표(docs/routes.json)를 읽기 목록으로 바꾼다.

이 도구가 없어도 docs/routes.json 을 손으로 읽으면 같은 결과가 나와야 한다. 외부 의존성 없음.

    python tools/route.py --task generate-video --project projects/2026-09-07_첫-작품 --model minimax-h3-r2v
    python tools/route.py --list
    python tools/route.py --check
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def find_root(start: Path) -> Path:
    for folder in (start, *start.parents):
        if (folder / "docs" / "routes.json").is_file() and (folder / "AGENTS.md").is_file():
            return folder
    raise SystemExit("docs/routes.json 과 AGENTS.md 가 있는 키트 폴더 안에서 실행하세요")


def load(root: Path) -> dict:
    return json.loads((root / "docs" / "routes.json").read_text(encoding="utf-8"))


def expand(entry: dict, project: str | None, model: str | None) -> list[str]:
    docs = []
    for path in entry.get("read_order", []):
        path = path.replace("<project>", project or "<project>").replace("<model>", model or "<model>")
        docs.append(path)
    return docs


def resolve(root: Path, config: dict, task: str, project: str | None, model: str | None) -> tuple[list[dict], list[str]]:
    tasks = config.get("tasks", {})
    entry = tasks.get(task)
    if entry is None:
        raise SystemExit(f"알 수 없는 작업 유형: {task} (가능한 유형: {', '.join(sorted(tasks))})")
    notices: list[str] = []
    for need in entry.get("needs", []):
        if need == "project" and not project:
            notices.append("이 작업 유형은 --project projects/<작품> 이 필요합니다")
        if need == "model" and not model:
            notices.append("이 작업 유형은 --model <모델 가이드 이름> 이 필요합니다 (craft/guides/ 참고)")
    docs = []
    total = 0
    for path in expand(entry, project, model):
        target = root / path
        exists = "<" not in path and target.is_file()
        size = target.stat().st_size if exists else 0
        total += size
        docs.append({"path": path, "exists": exists, "bytes": size})
    limit = int(config.get("limits", {}).get("task_read_max_bytes", 0) or 0)
    if limit and total > limit:
        notices.append(f"읽기 합계 {total} bytes 가 상한 {limit} 을 넘습니다 — 작업을 나누세요")
    gate = config.get("generate_gate")
    if gate and task.startswith("generate") and (not docs or docs[0]["path"] != gate):
        notices.append(f"generate 작업 유형은 {gate} 가 첫 문서여야 합니다")
    return docs, notices


def check(root: Path, config: dict) -> int:
    problems = 0
    agents = root / "AGENTS.md"
    limit_root = int(config.get("limits", {}).get("root_agent_max_bytes", 12288))
    size = agents.stat().st_size
    if size > limit_root:
        print(f"[ERROR] AGENTS.md {size} bytes > {limit_root}")
        problems += 1
    gate = config.get("generate_gate")
    for name, entry in config.get("tasks", {}).items():
        docs, notices = resolve(root, config, name, "projects/_template", "minimax-h3-r2v")
        for doc in docs:
            if not doc["exists"]:
                print(f"[ERROR] {name}: 문서 없음 {doc['path']}")
                problems += 1
        for notice in notices:
            if "필요합니다" in notice:
                continue
            print(f"[ERROR] {name}: {notice}")
            problems += 1
        if gate and name.startswith("generate") and docs and docs[0]["path"] != gate:
            print(f"[ERROR] {name}: 첫 문서가 {gate} 가 아닙니다")
            problems += 1
    print("check:", "PASS" if problems == 0 else f"FAIL ({problems})")
    return 1 if problems else 0


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="키트 작업 유형 → 읽기 목록")
    parser.add_argument("--task", help="docs/routes.json 의 tasks 이름")
    parser.add_argument("--project", help="작품 폴더, 예: projects/2026-09-07_첫-작품")
    parser.add_argument("--model", help="모델 가이드 이름, 예: minimax-h3-r2v")
    parser.add_argument("--list", action="store_true", help="작업 유형 목록")
    parser.add_argument("--check", action="store_true", help="표와 문서의 정합성 검사")
    parser.add_argument("--json", action="store_true", help="JSON 출력")
    args = parser.parse_args(argv)

    root = find_root(Path.cwd())
    config = load(root)

    if args.check:
        return check(root, config)
    if args.list or not args.task:
        for name, entry in config.get("tasks", {}).items():
            needs = f" (필요: {', '.join(entry['needs'])})" if entry.get("needs") else ""
            print(f"{name:16s} {entry.get('description', '')}{needs}")
        return 0

    docs, notices = resolve(root, config, args.task, args.project, args.model)
    if args.json:
        print(json.dumps({"task": args.task, "documents": docs, "notices": notices}, ensure_ascii=False, indent=2))
        return 0
    print(f"작업 유형: {args.task} — {config['tasks'][args.task].get('description', '')}")
    print("먼저: AGENTS.md (이미 읽은 상태여야 한다)")
    for index, doc in enumerate(docs, start=1):
        marker = "OK" if doc["exists"] else ("?" if "<" in doc["path"] else "MISSING")
        print(f"{index:02d}. [{marker}] {doc['path']} ({doc['bytes']} bytes)")
    for notice in notices:
        print(f"[NOTICE] {notice}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
