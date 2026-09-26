#!/usr/bin/env python3
"""Small SRT checks for the Deno YouTube subtitle workflow.

This tool deliberately avoids translation or rewriting. It validates SRT
shape, checks fixed channel identity rules, compares exact cue structure,
verifies context-only grouping inside the original cue envelopes, and removes
HTML tags from user-approved final Korean SRT files.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def production_root() -> Path:
    configured = os.environ.get("DENO_PRODUCTION_ROOT", "").strip()
    if configured:
        root = Path(configured)
        if not root.is_absolute():
            raise ValueError("DENO_PRODUCTION_ROOT must be an absolute path")
        return root.resolve()
    return Path(__file__).resolve().parents[3]


def stored_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(production_root()).as_posix()
    except ValueError:
        return str(resolved)


TIMECODE_RE = re.compile(
    r"^(?P<start>\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*"
    r"(?P<end>\d{2}:\d{2}:\d{2},\d{3})(?P<settings>.*)$"
)
HTML_TAG_RE = re.compile(r"</?[^>\n]+>")
STYLE_TAG_RE = re.compile(r"(?:</?[^>\n]+>|\{\\[^}\n]+\})")
OPENING_SELF_INTRO_RE = re.compile(
    r"안녕하세요(?:\s*[,，.!?]\s*|\s+)(?:저는\s+)?"
    r"(?P<speaker>[A-Za-z가-힣][A-Za-z가-힣0-9._-]{0,31})\s*입니다",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Cue:
    number: int
    start: str
    end: str
    settings: str
    text_lines: list[str]


def read_text(path: Path) -> str:
    data = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "cp949"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise UnicodeDecodeError("utf-8", data, 0, 1, "could not decode as UTF-8 or CP949")


def timestamp_to_ms(value: str) -> int:
    match = re.fullmatch(
        r"(?P<hours>\d{2}):(?P<minutes>\d{2}):(?P<seconds>\d{2}),(?P<milliseconds>\d{3})",
        value,
    )
    if not match:
        raise ValueError(f"invalid timestamp: {value}")

    hours = int(match.group("hours"))
    minutes = int(match.group("minutes"))
    seconds = int(match.group("seconds"))
    milliseconds = int(match.group("milliseconds"))
    if minutes >= 60 or seconds >= 60:
        raise ValueError(f"timestamp component out of range: {value}")
    return (((hours * 60) + minutes) * 60 + seconds) * 1000 + milliseconds


def parse_srt(path: Path) -> tuple[list[Cue], list[str]]:
    text = read_text(path).replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return [], [f"{path}: empty file"]

    cues: list[Cue] = []
    issues: list[str] = []
    blocks = re.split(r"\n{2,}", text)

    for block_number, block in enumerate(blocks, start=1):
        lines = block.split("\n")
        if len(lines) < 2:
            issues.append(f"block {block_number}: expected cue number and timecode")
            continue

        try:
            cue_number = int(lines[0].strip())
        except ValueError:
            issues.append(f"block {block_number}: cue number is not an integer: {lines[0]!r}")
            continue

        time_match = TIMECODE_RE.match(lines[1].strip())
        if not time_match:
            issues.append(f"cue {cue_number}: invalid timecode line: {lines[1]!r}")
            continue

        start = time_match.group("start")
        end = time_match.group("end")
        try:
            start_ms = timestamp_to_ms(start)
            end_ms = timestamp_to_ms(end)
        except ValueError as exc:
            issues.append(f"cue {cue_number}: {exc}")
            continue
        if end_ms <= start_ms:
            issues.append(f"cue {cue_number}: end time must be greater than start time")

        cues.append(
            Cue(
                number=cue_number,
                start=start,
                end=end,
                settings=time_match.group("settings").strip(),
                text_lines=lines[2:],
            )
        )

    expected = 1
    for cue in cues:
        if cue.number != expected:
            issues.append(f"cue sequence: expected {expected}, found {cue.number}")
            expected = cue.number
        expected += 1
        if not any(line.strip() for line in cue.text_lines):
            issues.append(f"cue {cue.number}: empty text")

    for previous, current in zip(cues, cues[1:]):
        if timestamp_to_ms(current.start) < timestamp_to_ms(previous.end):
            issues.append(
                f"cue {current.number}: overlaps cue {previous.number} "
                f"({current.start} < {previous.end})"
            )

    return cues, issues


def cue_signature(cue: Cue) -> tuple[int, str, str, str]:
    return cue.number, cue.start, cue.end, cue.settings


def validation_payload(path: Path) -> dict[str, Any]:
    cues, issues = parse_srt(path)
    return {
        "path": str(path),
        "ok": not issues,
        "cue_count": len(cues),
        "first_cue": cues[0].number if cues else None,
        "last_cue": cues[-1].number if cues else None,
        "issues": issues,
    }


def semantic_lint_payload(
    path: Path,
    expected_speaker: str = "Deno",
    opening_window_ms: int = 15000,
) -> dict[str, Any]:
    """Fail closed when an opening self-introduction names the wrong speaker.

    This is intentionally a narrow deterministic guard. It does not claim to
    replace the agent's full-context correction pass; it prevents a known,
    high-impact channel identity error from being mislabeled as a finished
    correction merely because structural SRT checks pass.
    """

    cues, parse_issues = parse_srt(path)
    issues: list[dict[str, Any]] = []
    introductions: list[dict[str, Any]] = []
    expected_normalized = re.sub(r"\s+", "", expected_speaker).casefold()

    if opening_window_ms <= 0:
        issues.append(
            {
                "type": "invalid_opening_window_ms",
                "value": opening_window_ms,
            }
        )

    for cue in cues:
        if timestamp_to_ms(cue.start) >= opening_window_ms:
            break
        cue_text = re.sub(r"\s+", " ", " ".join(cue.text_lines)).strip()
        for match in OPENING_SELF_INTRO_RE.finditer(cue_text):
            speaker = match.group("speaker")
            speaker_normalized = re.sub(r"\s+", "", speaker).casefold()
            matches_expected = speaker_normalized == expected_normalized
            introduction = {
                "cue": cue.number,
                "start": cue.start,
                "speaker": speaker,
                "expected": expected_speaker,
                "matches_expected": matches_expected,
            }
            introductions.append(introduction)
            if not matches_expected:
                issues.append(
                    {
                        "type": "opening_speaker_mismatch",
                        **introduction,
                    }
                )

    return {
        "path": str(path),
        "ok": not parse_issues and not issues,
        "expected_speaker": expected_speaker,
        "opening_window_ms": opening_window_ms,
        "cue_count": len(cues),
        "opening_self_introductions": introductions,
        "parse_issues": parse_issues,
        "issues": issues,
        "scope": "opening-channel-speaker-identity-only",
        "full_context_review_still_required": True,
    }


def compare_payload(source: Path, candidate: Path) -> dict[str, Any]:
    source_cues, source_issues = parse_srt(source)
    candidate_cues, candidate_issues = parse_srt(candidate)
    differences: list[dict[str, Any]] = []

    if len(source_cues) != len(candidate_cues):
        differences.append(
            {
                "type": "cue_count",
                "source": len(source_cues),
                "candidate": len(candidate_cues),
            }
        )

    for position, (source_cue, candidate_cue) in enumerate(
        zip(source_cues, candidate_cues), start=1
    ):
        if cue_signature(source_cue) != cue_signature(candidate_cue):
            differences.append(
                {
                    "type": "cue_structure",
                    "position": position,
                    "source": {
                        "number": source_cue.number,
                        "start": source_cue.start,
                        "end": source_cue.end,
                        "settings": source_cue.settings,
                    },
                    "candidate": {
                        "number": candidate_cue.number,
                        "start": candidate_cue.start,
                        "end": candidate_cue.end,
                        "settings": candidate_cue.settings,
                    },
                }
            )

    return {
        "source": str(source),
        "candidate": str(candidate),
        "ok": not source_issues and not candidate_issues and not differences,
        "source_cue_count": len(source_cues),
        "candidate_cue_count": len(candidate_cues),
        "source_issues": source_issues,
        "candidate_issues": candidate_issues,
        "differences": differences,
    }


def normalized_cue_text(cues: list[Cue]) -> str:
    return re.sub(
        r"\s+",
        " ",
        " ".join(line for cue in cues for line in cue.text_lines),
    ).strip()


def compare_grouped_payload(
    source: Path,
    candidate: Path,
    max_internal_gap_ms: int = 1500,
    max_line_chars: int = 42,
    max_output_lines: int = 2,
) -> dict[str, Any]:
    """Verify that candidate only merges contiguous source cue envelopes.

    Candidate cue numbers may be regenerated, but every source cue must be
    covered exactly once and in order. Each candidate start/end must equal the
    first/last source boundary in its group, settings must agree, and normalized
    text must be preserved. This proves context grouping without global sync
    movement.
    """

    source_cues, source_issues = parse_srt(source)
    candidate_cues, candidate_issues = parse_srt(candidate)
    differences: list[dict[str, Any]] = []
    groups: list[dict[str, Any]] = []
    source_index = 0

    if max_internal_gap_ms < 0:
        differences.append(
            {
                "type": "invalid_max_internal_gap_ms",
                "value": max_internal_gap_ms,
            }
        )

    for candidate_cue in candidate_cues:
        if max_output_lines > 0 and len(candidate_cue.text_lines) > max_output_lines:
            differences.append(
                {
                    "type": "candidate_line_count_exceeded",
                    "candidate_cue": candidate_cue.number,
                    "actual": len(candidate_cue.text_lines),
                    "allowed": max_output_lines,
                }
            )
        long_lines = [
            {
                "line": position,
                "length": len(line),
            }
            for position, line in enumerate(candidate_cue.text_lines, start=1)
            if max_line_chars > 0 and len(line) > max_line_chars
        ]
        if long_lines:
            differences.append(
                {
                    "type": "candidate_line_length_exceeded",
                    "candidate_cue": candidate_cue.number,
                    "allowed": max_line_chars,
                    "lines": long_lines,
                }
            )

        if source_index >= len(source_cues):
            differences.append(
                {
                    "type": "extra_candidate_cue",
                    "candidate_cue": candidate_cue.number,
                }
            )
            continue

        first_source = source_cues[source_index]
        if candidate_cue.start != first_source.start:
            differences.append(
                {
                    "type": "group_start_mismatch",
                    "candidate_cue": candidate_cue.number,
                    "expected": first_source.start,
                    "actual": candidate_cue.start,
                    "source_cue": first_source.number,
                }
            )
            break

        group_end_index = None
        for index in range(source_index, len(source_cues)):
            if source_cues[index].end == candidate_cue.end:
                group_end_index = index
                break
            if timestamp_to_ms(source_cues[index].end) > timestamp_to_ms(candidate_cue.end):
                break

        if group_end_index is None:
            differences.append(
                {
                    "type": "group_end_not_on_source_boundary",
                    "candidate_cue": candidate_cue.number,
                    "actual": candidate_cue.end,
                    "source_cue_start": first_source.number,
                }
            )
            break

        source_group = source_cues[source_index : group_end_index + 1]
        settings = {cue.settings for cue in source_group}
        if len(settings) != 1 or candidate_cue.settings not in settings:
            differences.append(
                {
                    "type": "group_settings_mismatch",
                    "candidate_cue": candidate_cue.number,
                    "source_cues": [cue.number for cue in source_group],
                    "source_settings": sorted(settings),
                    "candidate_settings": candidate_cue.settings,
                }
            )

        internal_gaps = [
            timestamp_to_ms(current.start) - timestamp_to_ms(previous.end)
            for previous, current in zip(source_group, source_group[1:])
        ]
        largest_gap = max(internal_gaps, default=0)
        if largest_gap > max_internal_gap_ms:
            differences.append(
                {
                    "type": "group_crosses_long_gap",
                    "candidate_cue": candidate_cue.number,
                    "source_cue_start": source_group[0].number,
                    "source_cue_end": source_group[-1].number,
                    "largest_internal_gap_ms": largest_gap,
                    "allowed_ms": max_internal_gap_ms,
                }
            )

        source_text = normalized_cue_text(source_group)
        candidate_text = normalized_cue_text([candidate_cue])
        # Context merging may close a spacing seam that only existed because the
        # transcriber split a particle/compound across cues (e.g. "다가오면서 부터").
        # Words must be identical; whitespace is not part of the preserved body.
        if re.sub(r"\s+", "", source_text) != re.sub(r"\s+", "", candidate_text):
            differences.append(
                {
                    "type": "group_text_mismatch",
                    "candidate_cue": candidate_cue.number,
                    "source_cue_start": source_group[0].number,
                    "source_cue_end": source_group[-1].number,
                    "source_text": source_text,
                    "candidate_text": candidate_text,
                }
            )

        groups.append(
            {
                "candidate_cue": candidate_cue.number,
                "source_cue_start": source_group[0].number,
                "source_cue_end": source_group[-1].number,
                "source_cue_count": len(source_group),
                "start": candidate_cue.start,
                "end": candidate_cue.end,
                "largest_internal_gap_ms": largest_gap,
            }
        )
        source_index = group_end_index + 1

    if source_index != len(source_cues):
        differences.append(
            {
                "type": "source_cues_not_covered",
                "first_uncovered_source_cue": (
                    source_cues[source_index].number
                    if source_index < len(source_cues)
                    else None
                ),
                "covered": source_index,
                "total": len(source_cues),
            }
        )

    return {
        "source": str(source),
        "candidate": str(candidate),
        "mode": "contiguous_context_grouping",
        "ok": not source_issues and not candidate_issues and not differences,
        "source_cue_count": len(source_cues),
        "candidate_cue_count": len(candidate_cues),
        "cue_reduction": len(source_cues) - len(candidate_cues),
        "merged_candidate_cue_count": sum(
            1 for group in groups if group["source_cue_count"] > 1
        ),
        "max_internal_gap_ms": max_internal_gap_ms,
        "max_line_chars": max_line_chars,
        "max_output_lines": max_output_lines,
        "source_issues": source_issues,
        "candidate_issues": candidate_issues,
        "differences": differences,
        "groups": groups,
    }


def wrap_caption_text(text: str, max_chars: int) -> list[str]:
    if max_chars <= 0 or len(text) <= max_chars:
        return [text]

    lines: list[str] = []
    current = ""
    for word in text.split():
        proposed = word if not current else f"{current} {word}"
        if current and len(proposed) > max_chars:
            lines.append(current)
            current = word
        else:
            current = proposed
    if current:
        lines.append(current)
    return lines or [text]


def context_group_payload(
    source: Path,
    manifest: Path,
    output: Path,
    max_line_chars: int = 42,
    max_internal_gap_ms: int = 1500,
    max_output_lines: int = 2,
) -> dict[str, Any]:
    source_cues, source_issues = parse_srt(source)
    manifest_data = json.loads(read_text(manifest))
    manifest_issues: list[str] = []

    max_line_chars = manifest_data.get("maxLineChars", max_line_chars)
    max_output_lines = manifest_data.get("maxOutputLines", max_output_lines)
    max_internal_gap_ms = manifest_data.get(
        "maxInternalGapMs", max_internal_gap_ms
    )
    if not isinstance(max_line_chars, int) or max_line_chars <= 0:
        manifest_issues.append("manifest maxLineChars must be a positive integer")
    if not isinstance(max_output_lines, int) or max_output_lines <= 0:
        manifest_issues.append("manifest maxOutputLines must be a positive integer")
    if not isinstance(max_internal_gap_ms, int) or max_internal_gap_ms < 0:
        manifest_issues.append("manifest maxInternalGapMs must be a non-negative integer")

    expected_count = manifest_data.get("sourceCueCount")
    if expected_count != len(source_cues):
        manifest_issues.append(
            f"manifest sourceCueCount {expected_count!r} does not match {len(source_cues)}"
        )

    raw_ranges = manifest_data.get("mergeRanges")
    if not isinstance(raw_ranges, list):
        raw_ranges = []
        manifest_issues.append("manifest mergeRanges must be a list")

    merge_ends: dict[int, int] = {}
    previous_end = 0
    for position, raw_range in enumerate(raw_ranges, start=1):
        if (
            not isinstance(raw_range, list)
            or len(raw_range) != 2
            or not all(isinstance(value, int) for value in raw_range)
        ):
            manifest_issues.append(f"mergeRanges[{position}] must be [start, end]")
            continue
        start, end = raw_range
        if start < 1 or end > len(source_cues) or start >= end:
            manifest_issues.append(
                f"mergeRanges[{position}] is outside the source or not a merge: {raw_range}"
            )
            continue
        if start <= previous_end:
            manifest_issues.append(
                f"mergeRanges[{position}] overlaps or is out of order: {raw_range}"
            )
            continue
        merge_ends[start] = end
        previous_end = end

    if source_issues or manifest_issues:
        return {
            "source": str(source),
            "manifest": str(manifest),
            "output": str(output),
            "ok": False,
            "source_issues": source_issues,
            "manifest_issues": manifest_issues,
        }

    output_lines: list[str] = []
    source_index = 0
    output_number = 1
    while source_index < len(source_cues):
        first = source_cues[source_index]
        requested_end = merge_ends.get(first.number, first.number)
        group_end_index = source_index
        while source_cues[group_end_index].number < requested_end:
            group_end_index += 1
        source_group = source_cues[source_index : group_end_index + 1]
        settings = {cue.settings for cue in source_group}
        if len(settings) != 1:
            return {
                "source": str(source),
                "manifest": str(manifest),
                "output": str(output),
                "ok": False,
                "source_issues": [],
                "manifest_issues": [
                    f"source cues {first.number}-{requested_end} have different settings"
                ],
            }

        output_lines.append(str(output_number))
        setting = next(iter(settings))
        setting_suffix = f" {setting}" if setting else ""
        output_lines.append(
            f"{source_group[0].start} --> {source_group[-1].end}{setting_suffix}"
        )
        wrapped_lines = wrap_caption_text(
            normalized_cue_text(source_group), max_line_chars
        )
        if len(wrapped_lines) > max_output_lines:
            return {
                "source": str(source),
                "manifest": str(manifest),
                "output": str(output),
                "ok": False,
                "source_issues": [],
                "manifest_issues": [
                    f"source cues {first.number}-{requested_end} require "
                    f"{len(wrapped_lines)} lines; limit is {max_output_lines}"
                ],
            }
        output_lines.extend(wrapped_lines)
        output_lines.append("")
        output_number += 1
        source_index = group_end_index + 1

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(output_lines).rstrip() + "\n", encoding="utf-8")
    comparison = compare_grouped_payload(
        source,
        output,
        max_internal_gap_ms,
        max_line_chars,
        max_output_lines,
    )
    manifest_sha256 = hashlib.sha256(manifest.read_bytes()).hexdigest()
    return {
        "source": str(source),
        "manifest": str(manifest),
        "manifest_sha256": manifest_sha256,
        "output": str(output),
        "ok": comparison["ok"],
        "max_line_chars": max_line_chars,
        "max_output_lines": max_output_lines,
        "source_cue_count": len(source_cues),
        "output_cue_count": len(source_cues) - comparison["cue_reduction"],
        "merge_range_count": len(raw_ranges),
        "comparison": comparison,
    }


def locked_file_payload(path: Path) -> dict[str, Any]:
    cues, issues = parse_srt(path)
    data = path.read_bytes()
    timeline = "\n".join(
        f"{cue.number}|{cue.start}|{cue.end}|{cue.settings}" for cue in cues
    ).encode("utf-8")
    return {
        "path": stored_path(path),
        "sha256": hashlib.sha256(data).hexdigest(),
        "timeline_sha256": hashlib.sha256(timeline).hexdigest(),
        "byte_size": len(data),
        "cue_count": len(cues),
        "first_cue_number": cues[0].number if cues else None,
        "last_cue_number": cues[-1].number if cues else None,
        "first_start": cues[0].start if cues else None,
        "last_end": cues[-1].end if cues else None,
        "issues": issues,
    }


def review_report_payload(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    text = read_text(path)
    upper_text = text.upper()
    has_pass = bool(re.search(r"\bPASS\b", upper_text))
    has_blocking_decision = bool(
        re.search(
            r"\b(?:NOT\s+PASS|FAIL(?:ED|URE)?|REVISE|BLOCK(?:ED)?)\b",
            upper_text,
        )
    ) or any(marker in text for marker in ("불합격", "수정 필요", "업로드 불가"))
    passed = has_pass and not has_blocking_decision
    return {
        "path": stored_path(path),
        "sha256": hashlib.sha256(data).hexdigest(),
        "byte_size": len(data),
        "status": "PASS" if passed else "NOT_PASS",
    }


def valid_slug(slug: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", slug))


def path_is_within(path: Path, expected_parent: Path) -> bool:
    try:
        path.resolve().relative_to(expected_parent.resolve())
        return True
    except ValueError:
        return False


def source_lock_payload(
    final_korean: Path,
    clean_korean: Path,
    reviewed_english: Path,
    slug: str,
    review_report: Path,
    supersedes_revision_id: str | None = None,
) -> dict[str, Any]:
    files = {
        "final_korean": locked_file_payload(final_korean),
        "clean_korean": locked_file_payload(clean_korean),
        "reviewed_english": locked_file_payload(reviewed_english),
    }
    review = review_report_payload(review_report)
    checks = {
        "final_to_clean_structure": compare_payload(final_korean, clean_korean),
        "clean_to_english_structure": compare_payload(clean_korean, reviewed_english),
    }
    issues = [
        f"{role}: {issue}"
        for role, payload in files.items()
        for issue in payload["issues"]
    ]
    if not valid_slug(slug):
        issues.append("slug is empty or unsafe")
    else:
        captions_root = production_root() / "productions" / slug / "captions"
        allowed_paths = {
            "final_korean": captions_root,
            "clean_korean": captions_root,
            "reviewed_english": captions_root,
            "english_review": captions_root,
        }
        actual_paths = {
            "final_korean": final_korean,
            "clean_korean": clean_korean,
            "reviewed_english": reviewed_english,
            "english_review": review_report,
        }
        for role, actual_path in actual_paths.items():
            if not path_is_within(actual_path, allowed_paths[role]):
                issues.append(f"{role}: path is outside the current slug workspace")
    if review["status"] != "PASS":
        issues.append("English review report does not contain a PASS decision")

    revision_seed = json.dumps(
        {
            "slug": slug,
            "final_korean_sha256": files["final_korean"]["sha256"],
            "timeline_sha256": files["final_korean"]["timeline_sha256"],
            "clean_korean_sha256": files["clean_korean"]["sha256"],
            "reviewed_english_sha256": files["reviewed_english"]["sha256"],
            "review_report_sha256": review["sha256"],
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    revision_id = f"caption-{hashlib.sha256(revision_seed).hexdigest()[:24]}"
    ok = not issues and all(check["ok"] for check in checks.values())
    return {
        "schema_version": 2,
        "authority": "latest_user_designated_final_korean_srt",
        "slug": slug,
        "revision_id": revision_id,
        "supersedes_revision_id": supersedes_revision_id,
        "created_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "ok": ok,
        "files": files,
        "english_review": review,
        "checks": checks,
        "issues": issues,
    }


def verify_source_lock_payload(
    lock_path: Path,
    final_korean: Path,
    clean_korean: Path,
    reviewed_english: Path,
    slug: str,
    review_report: Path,
) -> dict[str, Any]:
    locked = json.loads(read_text(lock_path))
    current = source_lock_payload(
        final_korean,
        clean_korean,
        reviewed_english,
        slug,
        review_report,
    )
    differences: list[dict[str, Any]] = []
    lock_issues: list[str] = []

    if locked.get("schema_version") != 2:
        lock_issues.append("caption source lock schema_version must be 2")
    if locked.get("authority") != "latest_user_designated_final_korean_srt":
        lock_issues.append("caption source lock authority is invalid")
    if locked.get("slug") != slug:
        lock_issues.append("caption source lock slug does not match the current project")
    if locked.get("revision_id") != current.get("revision_id"):
        lock_issues.append("caption source lock revision_id does not match the exact files")
    if locked.get("ok") is not True:
        lock_issues.append("caption source lock was not created from a valid caption set")

    locked_files = locked.get("files")
    if not isinstance(locked_files, dict):
        lock_issues.append("caption source lock files are missing")
        locked_files = {}

    fields = (
        "sha256",
        "timeline_sha256",
        "byte_size",
        "cue_count",
        "first_cue_number",
        "last_cue_number",
        "first_start",
        "last_end",
    )
    for role, current_file in current["files"].items():
        locked_file = locked_files.get(role)
        if not isinstance(locked_file, dict):
            differences.append({"role": role, "type": "missing_locked_file"})
            continue
        for field in fields:
            if locked_file.get(field) != current_file.get(field):
                differences.append(
                    {
                        "role": role,
                        "type": "locked_value_mismatch",
                        "field": field,
                        "locked": locked_file.get(field),
                        "current": current_file.get(field),
                    }
                )

    locked_review = locked.get("english_review")
    if not isinstance(locked_review, dict):
        differences.append({"role": "english_review", "type": "missing_locked_file"})
    else:
        for field in ("sha256", "byte_size", "status"):
            if locked_review.get(field) != current["english_review"].get(field):
                differences.append(
                    {
                        "role": "english_review",
                        "type": "locked_value_mismatch",
                        "field": field,
                        "locked": locked_review.get(field),
                        "current": current["english_review"].get(field),
                    }
                )

    return {
        "schema_version": 2,
        "lock_path": str(lock_path.resolve()),
        "ok": current["ok"] and not lock_issues and not differences,
        "lock_issues": lock_issues,
        "differences": differences,
        "current": current,
    }


def clean_payload(input_path: Path, output_path: Path) -> dict[str, Any]:
    cues, issues = parse_srt(input_path)
    if issues:
        return {
            "input": str(input_path),
            "output": str(output_path),
            "ok": False,
            "cue_count": len(cues),
            "issues": issues,
        }

    output_lines: list[str] = []
    changed_lines = 0
    for cue in cues:
        output_lines.append(str(cue.number))
        settings = f" {cue.settings}" if cue.settings else ""
        output_lines.append(f"{cue.start} --> {cue.end}{settings}")
        for line in cue.text_lines:
            cleaned = HTML_TAG_RE.sub("", line)
            if cleaned != line:
                changed_lines += 1
            output_lines.append(cleaned)
        output_lines.append("")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(output_lines).rstrip() + "\n", encoding="utf-8")

    compare = compare_payload(input_path, output_path)
    return {
        "input": str(input_path),
        "output": str(output_path),
        "ok": compare["ok"],
        "cue_count": len(cues),
        "html_tag_lines_changed": changed_lines,
        "structure_check": compare,
    }


def premiere_payload(input_path: Path, output_path: Path) -> dict[str, Any]:
    """Write a validated SRT in Premiere's deterministic text-file format.

    Cue content and structure are never regenerated here. The decoded source is
    retained byte-for-character apart from line-ending normalization and the
    required UTF-8 BOM, then reparsed to prove that every cue stayed identical.
    """

    input_bytes = input_path.read_bytes()
    input_sha256 = hashlib.sha256(input_bytes).hexdigest()
    input_text = read_text(input_path)
    input_cues, parse_issues = parse_srt(input_path)
    style_tag_issues = [
        f"cue {cue.number}: text line {line_number} contains an HTML/style tag"
        for cue in input_cues
        for line_number, line in enumerate(cue.text_lines, start=1)
        if STYLE_TAG_RE.search(line)
    ]
    input_issues = [*parse_issues, *style_tag_issues]

    base_payload: dict[str, Any] = {
        "input": str(input_path),
        "output": str(output_path),
        "input_sha256": input_sha256,
        "output_sha256": None,
        "cue_count": len(input_cues),
        "utf8Bom": False,
        "lineEnding": None,
        "final_crlf_exactly_one": False,
        "text_preserved": False,
        "structure_preserved": False,
        "issues": input_issues,
    }
    if input_issues:
        return {**base_payload, "ok": False}

    normalized_text = re.sub(r"\r\n|\r|\n", "\n", input_text).rstrip("\n") + "\n"
    output_bytes = b"\xef\xbb\xbf" + normalized_text.replace("\n", "\r\n").encode("utf-8")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(output_bytes)

    reparsed_cues, output_issues = parse_srt(output_path)
    text_preserved = [cue.text_lines for cue in input_cues] == [
        cue.text_lines for cue in reparsed_cues
    ]
    structure_preserved = [cue_signature(cue) for cue in input_cues] == [
        cue_signature(cue) for cue in reparsed_cues
    ]
    without_crlf = output_bytes[3:].replace(b"\r\n", b"")
    utf8_bom = output_bytes.startswith(b"\xef\xbb\xbf")
    crlf_only = b"\r" not in without_crlf and b"\n" not in without_crlf
    final_crlf_exactly_one = output_bytes.endswith(b"\r\n") and not output_bytes.endswith(
        b"\r\n\r\n"
    )
    normalized_source_preserved = (
        output_bytes[3:].decode("utf-8").replace("\r\n", "\n") == normalized_text
    )
    issues = [*output_issues]
    if not text_preserved:
        issues.append("cue text changed during Premiere formatting")
    if not structure_preserved:
        issues.append("cue number, timecode, settings, or order changed during Premiere formatting")
    if not normalized_source_preserved:
        issues.append("non-line-ending source content changed during Premiere formatting")
    if not utf8_bom:
        issues.append("output does not start with a UTF-8 BOM")
    if not crlf_only:
        issues.append("output contains a non-CRLF line ending")
    if not final_crlf_exactly_one:
        issues.append("output does not end with exactly one CRLF")

    return {
        **base_payload,
        "ok": not issues,
        "output_sha256": hashlib.sha256(output_bytes).hexdigest(),
        "utf8Bom": utf8_bom,
        "lineEnding": "CRLF" if crlf_only else "MIXED",
        "final_crlf_exactly_one": final_crlf_exactly_one,
        "text_preserved": text_preserved,
        "structure_preserved": structure_preserved,
        "normalized_source_preserved": normalized_source_preserved,
        "issues": issues,
    }


def emit(payload: dict[str, Any], report: Path | None) -> int:
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    print(text)
    if report:
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(text + "\n", encoding="utf-8")
    return 0 if payload.get("ok") else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Validate, semantic-lint, compare, context-group, clean, "
            "Premiere-format, or provenance-lock SRT files."
        )
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate", help="Validate one SRT file.")
    validate.add_argument("srt", type=Path)
    validate.add_argument("--report", type=Path)

    semantic_lint = subparsers.add_parser(
        "semantic-lint",
        help="Check deterministic channel-identity rules before structural PASS can be accepted.",
    )
    semantic_lint.add_argument("srt", type=Path)
    semantic_lint.add_argument("--expected-speaker", default="Deno")
    semantic_lint.add_argument("--opening-window-ms", type=int, default=15000)
    semantic_lint.add_argument("--report", type=Path)

    compare = subparsers.add_parser("compare", help="Compare cue number and timecode structure.")
    compare.add_argument("source", type=Path)
    compare.add_argument("candidate", type=Path)
    compare.add_argument("--report", type=Path)

    compare_grouped = subparsers.add_parser(
        "compare-grouped",
        help="Verify contiguous context grouping without moving source cue envelopes.",
    )
    compare_grouped.add_argument("source", type=Path)
    compare_grouped.add_argument("candidate", type=Path)
    compare_grouped.add_argument("--max-internal-gap-ms", type=int, default=1500)
    compare_grouped.add_argument("--max-line-chars", type=int, default=42)
    compare_grouped.add_argument("--max-output-lines", type=int, default=2)
    compare_grouped.add_argument("--report", type=Path)

    context_group = subparsers.add_parser(
        "context-group",
        help="Merge manifest-selected adjacent source cues and verify their envelopes.",
    )
    context_group.add_argument("source", type=Path)
    context_group.add_argument("manifest", type=Path)
    context_group.add_argument("output", type=Path)
    context_group.add_argument("--max-line-chars", type=int, default=42)
    context_group.add_argument("--max-internal-gap-ms", type=int, default=1500)
    context_group.add_argument("--max-output-lines", type=int, default=2)
    context_group.add_argument("--report", type=Path)

    clean = subparsers.add_parser("clean", help="Remove HTML tags from text lines only.")
    clean.add_argument("input", type=Path)
    clean.add_argument("output", type=Path)
    clean.add_argument("--report", type=Path)

    premiere = subparsers.add_parser(
        "premiere",
        help="Format a validated, tag-free SRT as UTF-8 BOM with CRLF line endings.",
    )
    premiere.add_argument("input", type=Path)
    premiere.add_argument("output", type=Path)
    premiere.add_argument("--report", type=Path)

    source_lock = subparsers.add_parser(
        "source-lock",
        help="Lock the latest final Korean, clean Korean, and reviewed English files by SHA-256 and cue structure.",
    )
    source_lock.add_argument("final_korean", type=Path)
    source_lock.add_argument("clean_korean", type=Path)
    source_lock.add_argument("reviewed_english", type=Path)
    source_lock.add_argument("--slug", required=True)
    source_lock.add_argument("--review-report", type=Path, required=True)
    source_lock.add_argument("--supersedes-revision-id")
    source_lock.add_argument("--report", type=Path, required=True)

    verify_lock = subparsers.add_parser(
        "verify-lock",
        help="Verify exact SRT files against a saved caption source lock before a YouTube write.",
    )
    verify_lock.add_argument("lock", type=Path)
    verify_lock.add_argument("final_korean", type=Path)
    verify_lock.add_argument("clean_korean", type=Path)
    verify_lock.add_argument("reviewed_english", type=Path)
    verify_lock.add_argument("--slug", required=True)
    verify_lock.add_argument("--review-report", type=Path, required=True)
    verify_lock.add_argument("--report", type=Path)

    args = parser.parse_args(argv)

    try:
        if args.command == "validate":
            return emit(validation_payload(args.srt), args.report)
        if args.command == "semantic-lint":
            return emit(
                semantic_lint_payload(
                    args.srt,
                    args.expected_speaker,
                    args.opening_window_ms,
                ),
                args.report,
            )
        if args.command == "compare":
            return emit(compare_payload(args.source, args.candidate), args.report)
        if args.command == "compare-grouped":
            return emit(
                compare_grouped_payload(
                    args.source,
                    args.candidate,
                    args.max_internal_gap_ms,
                    args.max_line_chars,
                    args.max_output_lines,
                ),
                args.report,
            )
        if args.command == "context-group":
            return emit(
                context_group_payload(
                    args.source,
                    args.manifest,
                    args.output,
                    args.max_line_chars,
                    args.max_internal_gap_ms,
                    args.max_output_lines,
                ),
                args.report,
            )
        if args.command == "clean":
            return emit(clean_payload(args.input, args.output), args.report)
        if args.command == "premiere":
            return emit(premiere_payload(args.input, args.output), args.report)
        if args.command == "source-lock":
            return emit(
                source_lock_payload(
                    args.final_korean,
                    args.clean_korean,
                    args.reviewed_english,
                    args.slug,
                    args.review_report,
                    args.supersedes_revision_id,
                ),
                args.report,
            )
        if args.command == "verify-lock":
            return emit(
                verify_source_lock_payload(
                    args.lock,
                    args.final_korean,
                    args.clean_korean,
                    args.reviewed_english,
                    args.slug,
                    args.review_report,
                ),
                args.report,
            )
    except Exception as exc:  # pragma: no cover - CLI guardrail
        print(f"error: {exc}", file=sys.stderr)
        return 2

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
