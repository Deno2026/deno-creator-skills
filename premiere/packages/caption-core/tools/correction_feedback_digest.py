from __future__ import annotations

import argparse
import os
from datetime import datetime
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REFERENCE_ROOT = PACKAGE_ROOT / "references"


def production_root() -> Path:
    configured = os.environ.get("DENO_PRODUCTION_ROOT", "").strip()
    if configured:
        root = Path(configured)
        if not root.is_absolute():
            raise ValueError("DENO_PRODUCTION_ROOT must be an absolute path")
        return root.resolve()
    return Path(__file__).resolve().parents[3]


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").strip()


def build_digest(slug: str) -> str:
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    patterns_path = REFERENCE_ROOT / "CORRECTION_PATTERNS.md"
    glossary_path = REFERENCE_ROOT / "GLOSSARY.md"

    if not patterns_path.is_file():
        raise FileNotFoundError("Missing references/CORRECTION_PATTERNS.md")
    if not glossary_path.is_file():
        raise FileNotFoundError("Missing references/GLOSSARY.md")

    lines = [
        f"# Correction Preflight Digest - {slug}",
        "",
        f"- generatedAt: {now}",
        "- source: current normalized correction rules and glossary only",
        "",
        "## Current correction rules",
        "",
        read_text(patterns_path),
        "",
        "## Current glossary",
        "",
        read_text(glossary_path),
        "",
        "## This job",
        "",
        "### Rules to apply",
        "",
        "- ",
        "",
        "### Terms to verify in context",
        "",
        "- ",
        "",
        "### Rules not applicable to this video",
        "",
        "- ",
        "",
        "### English translation and review handoff",
        "",
        "- ",
    ]
    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build a current-only correction preflight digest."
    )
    parser.add_argument("--slug", required=True, help="Current project slug.")
    parser.add_argument("--out", help="Output markdown path. Defaults to stdout.")
    args = parser.parse_args()

    digest = build_digest(args.slug)
    if args.out:
        out_path = Path(args.out)
        if not out_path.is_absolute():
            out_path = production_root() / out_path
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(digest, encoding="utf-8", newline="\n")
    else:
        print(digest, end="")


if __name__ == "__main__":
    main()
