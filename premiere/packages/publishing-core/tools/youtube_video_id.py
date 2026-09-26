#!/usr/bin/env python3
"""Extract a YouTube video ID from a URL or raw ID."""

from __future__ import annotations

import argparse
import re
import sys
from urllib.parse import parse_qs, urlparse


VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def extract_video_id(value: str) -> str | None:
    value = value.strip()
    if VIDEO_ID_RE.match(value):
        return value

    parsed = urlparse(value)
    host = parsed.netloc.lower()
    path_parts = [part for part in parsed.path.split("/") if part]

    if host.endswith("youtu.be") and path_parts:
        candidate = path_parts[0]
        return candidate if VIDEO_ID_RE.match(candidate) else None

    if "youtube.com" in host:
        query_id = parse_qs(parsed.query).get("v", [None])[0]
        if query_id and VIDEO_ID_RE.match(query_id):
            return query_id
        if len(path_parts) >= 2 and path_parts[0] in {"shorts", "embed", "live"}:
            candidate = path_parts[1]
            return candidate if VIDEO_ID_RE.match(candidate) else None

    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Extract a YouTube video ID.")
    parser.add_argument("value", help="YouTube URL or raw 11-character video ID")
    args = parser.parse_args(argv)

    video_id = extract_video_id(args.value)
    if not video_id:
        print("error: could not extract a YouTube video ID", file=sys.stderr)
        return 1
    print(video_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
