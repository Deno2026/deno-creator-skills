#!/usr/bin/env python3
"""Validate multilingual subtitle and metadata artifacts for one video package."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

from srt_tool import compare_payload, validation_payload


HANGUL_RE = re.compile(r"[\uac00-\ud7a3]")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")


def validate_language(source: Path, srt: Path, metadata: Path, lang: str) -> dict[str, Any]:
    item: dict[str, Any] = {
        "language": lang,
        "srt": str(srt),
        "metadata": str(metadata),
        "ok": True,
        "issues": [],
        "warnings": [],
    }

    if not srt.exists():
        item["ok"] = False
        item["issues"].append("missing_srt")
        return item

    srt_validation = validation_payload(srt)
    srt_compare = compare_payload(source, srt)
    item["srt_validation"] = srt_validation
    item["srt_compare"] = srt_compare
    if not srt_validation.get("ok"):
        item["ok"] = False
        item["issues"].append("invalid_srt")
    if not srt_compare.get("ok"):
        item["ok"] = False
        item["issues"].append("srt_structure_mismatch")

    hangul_count = len(HANGUL_RE.findall(read_text(srt)))
    item["srt_hangul_count"] = hangul_count
    if lang not in {"ko"} and hangul_count:
        item["warnings"].append("hangul_present_in_srt")

    if not metadata.exists():
        item["ok"] = False
        item["issues"].append("missing_metadata_json")
        return item

    try:
        data = json.loads(read_text(metadata))
    except json.JSONDecodeError as exc:
        item["ok"] = False
        item["issues"].append(f"metadata_json_decode_error:{exc}")
        return item

    item["metadata_fields"] = sorted(data.keys())
    if data.get("language") != lang:
        item["ok"] = False
        item["issues"].append("metadata_language_mismatch")
    for field in ("title", "description", "tags", "chapterBlock"):
        if field not in data:
            item["ok"] = False
            item["issues"].append(f"metadata_missing_{field}")
    title = str(data.get("title", "")).strip()
    description = str(data.get("description", "")).strip()
    item["metadata_title_length"] = len(title)
    item["metadata_description_length"] = len(description)
    if title and len(title) > 100:
        item["ok"] = False
        item["issues"].append("metadata_title_over_100_chars")
    if description and len(description) > 5000:
        item["ok"] = False
        item["issues"].append("metadata_description_over_5000_chars")
    if isinstance(data.get("tags"), list):
        item["metadata_tag_count"] = len(data["tags"])
    else:
        item["ok"] = False
        item["issues"].append("metadata_tags_not_list")

    chapter_block = str(data.get("chapterBlock", ""))
    chapter_lines = [line for line in chapter_block.splitlines() if line.strip()]
    item["chapter_count"] = len(chapter_lines)
    if len(chapter_lines) < 3:
        item["ok"] = False
        item["issues"].append("chapter_count_below_three")
    if chapter_lines and not chapter_lines[0].startswith(("00:00", "0:00")):
        item["ok"] = False
        item["issues"].append("chapter_does_not_start_at_zero")

    return item


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--subtitles-root", required=True, type=Path)
    parser.add_argument("--metadata-root", required=True, type=Path)
    parser.add_argument("--languages", required=True)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args(argv)

    languages = [part.strip() for part in args.languages.split(",") if part.strip()]
    results = [
        validate_language(
            args.source,
            args.subtitles_root / lang / f"{lang}.srt",
            args.metadata_root / f"{lang}.json",
            lang,
        )
        for lang in languages
    ]

    payload = {
        "ok": all(item["ok"] for item in results),
        "source": str(args.source),
        "languages": languages,
        "results": results,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
