#!/usr/bin/env python3
"""Frame-exact Korean subtitle alignment from authored text and mixed audio.

The default engine is Montreal Forced Aligner 3.4.2 with the Korean MFA
acoustic, dictionary, and G2P models.  MFA supplies phone-constrained word
boundaries; this module restores authored Korean eojeol and punctuation and
then snaps every caption boundary to the delivery video's frame grid.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from dataclasses import asdict, dataclass
from decimal import Decimal
from fractions import Fraction
from pathlib import Path
from typing import Any, Sequence


SCHEMA_VERSION = 2
EXPECTED_MFA_VERSION = "3.4.2"
PAUSE_THRESHOLD_SECONDS = Decimal("0.120")
SAFE_OUT_DIR_LENGTH = 120
SAFE_MFA_NESTED_UTF8_BYTES = 180
MFA_DEEPEST_KNOWN_SUFFIX = Path(
    "mfa-temp/corpus/dictionary/phones/phones.txt"
)


class CaptionAlignError(RuntimeError):
    """A deterministic pipeline or QC failure."""


class TokenMismatchError(CaptionAlignError):
    """MFA tokens cannot be mapped one-to-one onto the authored eojeol."""


@dataclass(frozen=True)
class AuthoredEojeol:
    index: int
    text: str
    normalized: str


@dataclass(frozen=True)
class MfaToken:
    index: int
    start: float
    end: float
    text: str
    normalized: str


@dataclass(frozen=True)
class EojeolAlignment:
    authored: AuthoredEojeol
    mfa_tokens: tuple[MfaToken, ...]

    @property
    def start(self) -> float:
        return self.mfa_tokens[0].start

    @property
    def end(self) -> float:
        return self.mfa_tokens[-1].end


@dataclass(frozen=True)
class CaptionOverride:
    index: int
    spoken_text: str
    display_text: str
    preserve_suffix: bool
    scope_start_index: int
    scope_end_index_exclusive: int
    expected_matches: int | None = None
    own_card: bool = True


@dataclass(frozen=True)
class ScriptSpec:
    spoken_text: str
    caption_overrides: tuple[CaptionOverride, ...]
    source_format: str


@dataclass(frozen=True)
class DisplaySpan:
    start_index: int
    end_index_exclusive: int
    spoken_text: str
    display_text: str
    override_index: int
    own_card: bool = True


def _read_utf8(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def _parse_caption_override(
    value: Any,
    *,
    index: int,
    scope_start_index: int,
    scope_end_index_exclusive: int,
) -> CaptionOverride:
    if not isinstance(value, dict):
        raise CaptionAlignError("caption_overrides entries must be JSON objects")
    spoken_text = str(value.get("spoken_text", "")).strip()
    display_text = str(value.get("display_text", "")).strip()
    if not spoken_text or not display_text:
        raise CaptionAlignError(
            "caption_overrides entries need non-empty spoken_text and display_text"
        )
    expected_matches = value.get("expected_matches")
    if expected_matches is not None and (
        not isinstance(expected_matches, int) or expected_matches < 1
    ):
        raise CaptionAlignError("caption override expected_matches must be a positive int")
    return CaptionOverride(
        index=index,
        spoken_text=spoken_text,
        display_text=display_text,
        preserve_suffix=bool(value.get("preserve_suffix", True)),
        own_card=bool(value.get("own_card", True)),
        scope_start_index=scope_start_index,
        scope_end_index_exclusive=scope_end_index_exclusive,
        expected_matches=expected_matches,
    )


def extract_script_spec(path: Path) -> ScriptSpec:
    """Read spoken alignment text plus optional caption display overrides."""

    if not path.is_file():
        raise CaptionAlignError(f"Script does not exist: {path}")
    raw = _read_utf8(path)
    if path.suffix.lower() != ".json":
        text = raw.strip()
        if not text:
            raise CaptionAlignError("Script is empty")
        return ScriptSpec(text, (), "plain-text")

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise CaptionAlignError(f"Invalid script JSON: {exc}") from exc

    lines: list[str] = []
    scoped_raw_overrides: list[tuple[Any, int, int]] = []
    source_format = "json"
    if isinstance(data, dict) and isinstance(data.get("beats"), list):
        source_format = "beats"
        cursor = 0
        for item in data["beats"]:
            if not isinstance(item, dict):
                continue
            spoken = str(item.get("spoken_text", item.get("phrase", ""))).strip()
            if not spoken:
                continue
            start = cursor
            cursor += len(tokenize_authored(spoken))
            lines.append(spoken)
            local_overrides = item.get("caption_overrides", [])
            if local_overrides is not None and not isinstance(local_overrides, list):
                raise CaptionAlignError("beats[].caption_overrides must be a list")
            for override in local_overrides or []:
                scoped_raw_overrides.append((override, start, cursor))
    if not lines and isinstance(data, dict) and isinstance(data.get("blocks"), list):
        source_format = "blocks"
        lines = [
            str(item.get("spoken_text", item.get("vo_line", ""))).strip()
            for item in data["blocks"]
            if isinstance(item, dict)
            and str(item.get("spoken_text", item.get("vo_line", ""))).strip()
        ]
    if not lines and isinstance(data, dict) and isinstance(data.get("text"), str):
        source_format = "text"
        lines = [data["text"].strip()]
    elif isinstance(data, str):
        source_format = "string"
        lines = [data.strip()]
    elif isinstance(data, list):
        source_format = "list"
        lines = [str(item).strip() for item in data if str(item).strip()]

    text = "\n".join(line for line in lines if line).strip()
    if not text:
        raise CaptionAlignError(
            "JSON script needs beats[].spoken_text/phrase, "
            "blocks[].spoken_text/vo_line, text, or a string list"
        )

    authored_count = len(tokenize_authored(text))
    top_level_overrides = data.get("caption_overrides", []) if isinstance(data, dict) else []
    if top_level_overrides is not None and not isinstance(top_level_overrides, list):
        raise CaptionAlignError("caption_overrides must be a list")
    for override in top_level_overrides or []:
        scoped_raw_overrides.append((override, 0, authored_count))

    overrides = tuple(
        _parse_caption_override(
            value,
            index=index,
            scope_start_index=start,
            scope_end_index_exclusive=end,
        )
        for index, (value, start, end) in enumerate(scoped_raw_overrides)
    )
    return ScriptSpec(text, overrides, source_format)


def extract_script_text(path: Path) -> str:
    """Backward-compatible spoken text extraction."""

    return extract_script_spec(path).spoken_text


def normalize_token(text: str) -> str:
    """Normalize only for sequence matching; authored display text is untouched."""

    normalized = unicodedata.normalize("NFKC", text).casefold()
    return "".join(
        char
        for char in normalized
        if unicodedata.category(char).startswith(("L", "N"))
    )


def tokenize_authored(text: str) -> list[AuthoredEojeol]:
    """Split on authored whitespace and attach punctuation-only chunks safely."""

    displays: list[str] = []
    pending_prefix = ""
    for chunk in re.findall(r"\S+", text):
        if normalize_token(chunk):
            displays.append(pending_prefix + chunk)
            pending_prefix = ""
        elif displays:
            displays[-1] += chunk
        else:
            pending_prefix += chunk
    if pending_prefix and displays:
        displays[-1] += pending_prefix

    result = [
        AuthoredEojeol(index=i, text=display, normalized=normalize_token(display))
        for i, display in enumerate(displays)
    ]
    if not result or any(not item.normalized for item in result):
        raise CaptionAlignError("Script has no alignable authored eojeol")
    return result


def alignment_lab_text(authored: Sequence[AuthoredEojeol]) -> str:
    """MFA input: exact authored word sequence without display punctuation."""

    return " ".join(item.normalized for item in authored)


def _surface_suffix(authored_text: str, base_normalized: str) -> str:
    """Return particles/punctuation after a normalized spoken base."""

    for index in range(len(authored_text)):
        candidate = normalize_token(authored_text[: index + 1])
        if candidate == base_normalized:
            return authored_text[index + 1 :]
        if not base_normalized.startswith(candidate):
            break
    raise CaptionAlignError(
        f"Cannot preserve display suffix: {authored_text!r} vs {base_normalized!r}"
    )


def compile_display_spans(
    authored: Sequence[AuthoredEojeol],
    overrides: Sequence[CaptionOverride],
) -> tuple[list[DisplaySpan], list[dict[str, Any]]]:
    """Resolve spoken phrases to non-overlapping technical display labels."""

    prepared: list[tuple[CaptionOverride, list[AuthoredEojeol]]] = []
    for override in overrides:
        tokens = tokenize_authored(override.spoken_text)
        if (
            override.scope_start_index < 0
            or override.scope_end_index_exclusive > len(authored)
            or override.scope_start_index >= override.scope_end_index_exclusive
        ):
            raise CaptionAlignError(
                f"Invalid caption override scope for {override.spoken_text!r}"
            )
        prepared.append((override, tokens))

    # Long phrases own their full span before shorter terms can claim a suffix token.
    prepared.sort(key=lambda item: (-len(item[1]), item[0].index))
    occupied = [False] * len(authored)
    spans: list[DisplaySpan] = []
    match_metadata: dict[int, dict[str, Any]] = {}

    for override, tokens in prepared:
        match_count = 0
        cursor = override.scope_start_index
        latest_start = override.scope_end_index_exclusive - len(tokens)
        while cursor <= latest_start:
            end = cursor + len(tokens)
            if any(occupied[cursor:end]):
                cursor += 1
                continue

            matched = True
            for offset, token in enumerate(tokens):
                candidate = authored[cursor + offset].normalized
                is_last = offset == len(tokens) - 1
                if is_last and override.preserve_suffix:
                    if not candidate.startswith(token.normalized):
                        matched = False
                        break
                elif candidate != token.normalized:
                    matched = False
                    break
            if not matched:
                cursor += 1
                continue

            last_authored = authored[end - 1]
            last_token = tokens[-1]
            suffix = _surface_suffix(last_authored.text, last_token.normalized)
            display_text = override.display_text + suffix
            spoken_surface = " ".join(item.text for item in authored[cursor:end])
            spans.append(
                DisplaySpan(
                    start_index=cursor,
                    end_index_exclusive=end,
                    spoken_text=spoken_surface,
                    display_text=display_text,
                    override_index=override.index,
                    own_card=override.own_card,
                )
            )
            for claimed in range(cursor, end):
                occupied[claimed] = True
            match_count += 1
            cursor = end

        if match_count == 0:
            raise CaptionAlignError(
                f"Caption override did not match spoken text: {override.spoken_text!r}"
            )
        if (
            override.expected_matches is not None
            and match_count != override.expected_matches
        ):
            raise CaptionAlignError(
                f"Caption override {override.spoken_text!r} expected "
                f"{override.expected_matches} matches, found {match_count}"
            )
        match_metadata[override.index] = {
            **asdict(override),
            "match_count": match_count,
        }

    spans.sort(key=lambda item: item.start_index)
    for index in range(len(spans) - 1):
        if spans[index].end_index_exclusive > spans[index + 1].start_index:
            raise CaptionAlignError("Caption display overrides overlap")
    return spans, [match_metadata[index] for index in sorted(match_metadata)]


def parse_mfa_words(data: dict[str, Any]) -> list[MfaToken]:
    try:
        entries = data["tiers"]["words"]["entries"]
    except (KeyError, TypeError) as exc:
        raise CaptionAlignError("MFA JSON has no tiers.words.entries") from exc

    tokens: list[MfaToken] = []
    for entry in entries:
        if isinstance(entry, dict):
            start = entry.get("begin", entry.get("start"))
            end = entry.get("end", entry.get("stop"))
            text = entry.get("label", entry.get("text", ""))
        elif isinstance(entry, (list, tuple)) and len(entry) >= 3:
            start, end, text = entry[0], entry[1], entry[2]
        else:
            raise CaptionAlignError(f"Unsupported MFA word entry: {entry!r}")

        label = str(text).strip()
        if not label:
            continue
        normalized = normalize_token(label)
        if not normalized:
            continue
        try:
            start_value = float(start)
            end_value = float(end)
        except (TypeError, ValueError) as exc:
            raise CaptionAlignError(f"Invalid MFA interval: {entry!r}") from exc
        if start_value < 0 or end_value <= start_value:
            raise CaptionAlignError(f"Non-positive MFA interval: {entry!r}")
        tokens.append(
            MfaToken(
                index=len(tokens),
                start=start_value,
                end=end_value,
                text=label,
                normalized=normalized,
            )
        )

    if not tokens:
        raise CaptionAlignError("MFA word tier is empty")
    return tokens


def rejoin_mfa_tokens(
    authored: Sequence[AuthoredEojeol], mfa_tokens: Sequence[MfaToken]
) -> tuple[list[EojeolAlignment], int]:
    """Greedily rejoin Korean morphology into authored whitespace units."""

    aligned: list[EojeolAlignment] = []
    cursor = 0
    for item in authored:
        pieces: list[MfaToken] = []
        assembled = ""
        while assembled != item.normalized:
            if cursor >= len(mfa_tokens):
                raise TokenMismatchError(
                    f"MFA ended while matching authored eojeol {item.index + 1} "
                    f"({item.text!r}); assembled={assembled!r}"
                )
            token = mfa_tokens[cursor]
            candidate = assembled + token.normalized
            if not item.normalized.startswith(candidate):
                context = " + ".join(piece.text for piece in pieces + [token])
                raise TokenMismatchError(
                    f"Cannot map MFA tokens [{context}] to authored eojeol "
                    f"{item.index + 1} ({item.text!r})"
                )
            pieces.append(token)
            assembled = candidate
            cursor += 1
        aligned.append(EojeolAlignment(item, tuple(pieces)))

    return aligned, len(mfa_tokens) - cursor


def _fraction(value: int | float | str | Decimal | Fraction) -> Fraction:
    if isinstance(value, Fraction):
        return value
    if isinstance(value, int):
        return Fraction(value, 1)
    return Fraction(Decimal(str(value)))


def _floor(value: Fraction) -> int:
    return value.numerator // value.denominator


def _ceil(value: Fraction) -> int:
    return -((-value.numerator) // value.denominator)


def parse_fps(value: str) -> Fraction:
    try:
        rate = Fraction(value)
    except (ValueError, ZeroDivisionError) as exc:
        raise argparse.ArgumentTypeError(f"Invalid FPS: {value}") from exc
    if rate <= 0:
        raise argparse.ArgumentTypeError("FPS must be positive")
    return rate


def select_work_dir(
    out_dir: Path,
    explicit_work_dir: Path | None = None,
    *,
    safe_out_dir_length: int = SAFE_OUT_DIR_LENGTH,
) -> tuple[Path, str]:
    """Choose an ASCII, short MFA workspace before Windows OpenFST path failures."""

    resolved_out = out_dir.resolve()
    if explicit_work_dir is not None:
        return explicit_work_dir.resolve(), "explicit"
    local_work = resolved_out / "_work"
    projected_nested = local_work / MFA_DEEPEST_KNOWN_SUFFIX
    projected_text = str(projected_nested)
    windows_openfst_risk = (
        len(str(resolved_out)) >= safe_out_dir_length
        or not projected_text.isascii()
        or len(projected_text.encode("utf-8")) >= SAFE_MFA_NESTED_UTF8_BYTES
    )
    if not windows_openfst_risk:
        return local_work, "out-dir"

    stable_key = os.path.normcase(str(resolved_out)).encode("utf-8")
    digest = hashlib.sha256(stable_key).hexdigest()[:16]
    repo_root = Path(__file__).resolve().parents[2]
    return repo_root / "scratch" / "caption-align-work" / digest, "auto-short"


def work_dir_risk_metadata(out_dir: Path) -> dict[str, Any]:
    resolved_out = out_dir.resolve()
    projected = resolved_out / "_work" / MFA_DEEPEST_KNOWN_SUFFIX
    projected_text = str(projected)
    reasons: list[str] = []
    if len(str(resolved_out)) >= SAFE_OUT_DIR_LENGTH:
        reasons.append("out-dir-length")
    if not projected_text.isascii():
        reasons.append("non-ascii-openfst-path")
    if len(projected_text.encode("utf-8")) >= SAFE_MFA_NESTED_UTF8_BYTES:
        reasons.append("projected-nested-utf8-length")
    return {
        "projected_local_path": projected_text,
        "projected_local_path_characters": len(projected_text),
        "projected_local_path_utf8_bytes": len(projected_text.encode("utf-8")),
        "auto_short_reasons": reasons,
    }


def build_cards(
    aligned: Sequence[EojeolAlignment],
    fps: Fraction,
    *,
    video_first_pts: float = 0.0,
    audio_first_pts: float = 0.0,
    visual_lead_frames: int = 0,
    pause_threshold: Decimal = PAUSE_THRESHOLD_SECONDS,
) -> list[dict[str, Any]]:
    """Create half-open frame intervals; one authored eojeol is one card."""

    if visual_lead_frames not in (0, 1, 2):
        raise CaptionAlignError("visual_lead_frames must be 0, 1, or 2")
    video_origin = _fraction(video_first_pts)
    audio_origin = _fraction(audio_first_pts)
    starts: list[int] = []
    raw_starts: list[int] = []
    for group in aligned:
        source_start = audio_origin + _fraction(group.start)
        raw_frame = _floor((source_start - video_origin) * fps)
        raw_starts.append(raw_frame)
        starts.append(max(0, raw_frame - visual_lead_frames))

    cards: list[dict[str, Any]] = []
    for index, group in enumerate(aligned):
        source_start = audio_origin + _fraction(group.start)
        source_end = audio_origin + _fraction(group.end)
        if index + 1 < len(aligned):
            next_group = aligned[index + 1]
            pause_decimal = max(
                Decimal("0"),
                Decimal(str(next_group.start)) - Decimal(str(group.end)),
            )
            pause_after = float(pause_decimal)
            if pause_decimal <= pause_threshold:
                end_frame = starts[index + 1]
                end_reason = "hard_switch"
                natural_end_frame = None
                end_clamped = False
            else:
                natural_end_frame = _ceil((source_end - video_origin) * fps)
                end_frame = min(natural_end_frame, starts[index + 1])
                end_clamped = end_frame != natural_end_frame
                end_reason = (
                    "pause_blank_clamped_to_next_start"
                    if end_clamped
                    else "pause_blank"
                )
        else:
            pause_after = None
            natural_end_frame = _ceil((source_end - video_origin) * fps)
            end_frame = natural_end_frame
            end_reason = "speech_end"
            end_clamped = False

        cards.append(
            {
                "index": index + 1,
                "text": group.authored.text,
                "normalized": group.authored.normalized,
                "mfa_tokens": [asdict(token) for token in group.mfa_tokens],
                "mfa_start_seconds": group.start,
                "mfa_end_seconds": group.end,
                "source_start_seconds": float(source_start),
                "source_end_seconds": float(source_end),
                "raw_start_frame": raw_starts[index],
                "start_frame": starts[index],
                "end_frame_exclusive": end_frame,
                "natural_end_frame_exclusive": natural_end_frame,
                "end_clamped_to_next_start": end_clamped,
                "start_seconds": float(Fraction(starts[index], 1) / fps),
                "end_seconds": float(Fraction(end_frame, 1) / fps),
                "pause_after_seconds": pause_after,
                "end_reason": end_reason,
            }
        )
    return cards


def build_display_cards(
    cards: Sequence[dict[str, Any]], spans: Sequence[DisplaySpan]
) -> list[dict[str, Any]]:
    """Collapse spoken eojeol spans into the exact labels viewers should read."""

    span_by_start = {span.start_index: span for span in spans}
    display_cards: list[dict[str, Any]] = []
    cursor = 0
    while cursor < len(cards):
        span = span_by_start.get(cursor)
        if span is None:
            source = dict(cards[cursor])
            source["index"] = len(display_cards) + 1
            source["spoken_text"] = source["text"]
            source["authored_card_indices"] = [cards[cursor]["index"]]
            source["display_override"] = None
            display_cards.append(source)
            cursor += 1
            continue

        if span.end_index_exclusive > len(cards):
            raise CaptionAlignError("Caption display span extends past aligned cards")
        grouped = cards[span.start_index : span.end_index_exclusive]
        first = grouped[0]
        last = grouped[-1]
        display_cards.append(
            {
                "index": len(display_cards) + 1,
                "text": span.display_text,
                "normalized": normalize_token(span.display_text),
                "spoken_text": span.spoken_text,
                "authored_card_indices": [card["index"] for card in grouped],
                "display_override": {
                    "index": span.override_index,
                    "start_index": span.start_index,
                    "end_index_exclusive": span.end_index_exclusive,
                    "own_card": span.own_card,
                },
                "mfa_tokens": [
                    token for card in grouped for token in card.get("mfa_tokens", [])
                ],
                "mfa_start_seconds": first["mfa_start_seconds"],
                "mfa_end_seconds": last["mfa_end_seconds"],
                "source_start_seconds": first["source_start_seconds"],
                "source_end_seconds": last["source_end_seconds"],
                "raw_start_frame": first["raw_start_frame"],
                "start_frame": first["start_frame"],
                "end_frame_exclusive": last["end_frame_exclusive"],
                "natural_end_frame_exclusive": last[
                    "natural_end_frame_exclusive"
                ],
                "end_clamped_to_next_start": last["end_clamped_to_next_start"],
                "start_seconds": first["start_seconds"],
                "end_seconds": last["end_seconds"],
                "pause_after_seconds": last["pause_after_seconds"],
                "end_reason": last["end_reason"],
            }
        )
        cursor = span.end_index_exclusive

    covered = [
        authored_index
        for card in display_cards
        for authored_index in card["authored_card_indices"]
    ]
    expected = [card["index"] for card in cards]
    if covered != expected:
        raise CaptionAlignError("Display cards do not cover spoken cards exactly once")
    return display_cards


def _visible_caption_characters(text: str) -> int:
    return len(re.sub(r"[\s,.;:!?…，。！？]", "", text))


def _display_group_card(
    grouped: Sequence[dict[str, Any]], index: int
) -> dict[str, Any]:
    first = grouped[0]
    last = grouped[-1]
    text = " ".join(str(card["text"]) for card in grouped)
    spoken_text = " ".join(
        str(card.get("spoken_text", card["text"])) for card in grouped
    )
    return {
        "index": index,
        "text": text,
        "normalized": normalize_token(text),
        "spoken_text": spoken_text,
        "authored_card_indices": [
            authored_index
            for card in grouped
            for authored_index in card["authored_card_indices"]
        ],
        "display_override": first.get("display_override") if len(grouped) == 1 else None,
        "grouped_display_indices": [card["index"] for card in grouped],
        "mfa_tokens": [
            token for card in grouped for token in card.get("mfa_tokens", [])
        ],
        "mfa_start_seconds": first["mfa_start_seconds"],
        "mfa_end_seconds": last["mfa_end_seconds"],
        "source_start_seconds": first["source_start_seconds"],
        "source_end_seconds": last["source_end_seconds"],
        "raw_start_frame": first["raw_start_frame"],
        "start_frame": first["start_frame"],
        "end_frame_exclusive": last["end_frame_exclusive"],
        "natural_end_frame_exclusive": last["natural_end_frame_exclusive"],
        "end_clamped_to_next_start": last["end_clamped_to_next_start"],
        "start_seconds": first["start_seconds"],
        "end_seconds": last["end_seconds"],
        "pause_after_seconds": last["pause_after_seconds"],
        "end_reason": last["end_reason"],
    }


def _override_owns_card(card: dict[str, Any]) -> bool:
    """A display override isolates its own card unless the script opts out.

    `own_card: false` lets a frequent term (for example 에이아이 -> AI) group with
    its neighbours instead of stuttering once per occurrence.
    """

    override = card.get("display_override")
    return bool(override) and bool(override.get("own_card", True))


def group_display_cards(
    cards: Sequence[dict[str, Any]],
    fps: Fraction,
    *,
    profile: str = "exact",
) -> list[dict[str, Any]]:
    """Group delivery captions into slower natural phrases without changing words."""

    if profile == "exact":
        return [dict(card) for card in cards]
    if profile != "relaxed":
        raise CaptionAlignError(f"Unknown caption grouping profile: {profile}")

    target_min_seconds = 0.9
    hard_max_seconds = 2.0
    max_visible_characters = 10
    max_words = 4
    grouped_cards: list[dict[str, Any]] = []
    cursor = 0
    while cursor < len(cards):
        first = cards[cursor]
        if _override_owns_card(first):
            grouped_cards.append(_display_group_card([first], len(grouped_cards) + 1))
            cursor += 1
            continue

        current = [first]
        cursor += 1
        while cursor < len(cards):
            last = current[-1]
            duration = (
                last["end_frame_exclusive"] - current[0]["start_frame"]
            ) / float(fps)
            hard_pause = str(last.get("end_reason", "")).startswith("pause_blank")
            sentence_end = bool(re.search(r"[.!?…。！？]$", str(last["text"])))
            comma_end = bool(re.search(r"[,，]$", str(last["text"])))
            if hard_pause or sentence_end or (comma_end and duration >= 0.75):
                break

            candidate = cards[cursor]
            if _override_owns_card(candidate):
                break
            candidate_group = [*current, candidate]
            candidate_text = " ".join(str(card["text"]) for card in candidate_group)
            candidate_duration = (
                candidate_group[-1]["end_frame_exclusive"]
                - candidate_group[0]["start_frame"]
            ) / float(fps)
            if (
                candidate_duration > hard_max_seconds
                or _visible_caption_characters(candidate_text) > max_visible_characters
                or len(candidate_group) > max_words
            ):
                break
            current.append(candidate)
            cursor += 1
            if (
                candidate_duration >= target_min_seconds
                and _visible_caption_characters(candidate_text) >= 5
            ):
                break

        grouped_cards.append(_display_group_card(current, len(grouped_cards) + 1))

    # A short phrase before a real pause may remain visible into that pause, but it
    # never crosses the next phrase start. Continuous speech still hard-switches.
    minimum_hold_frames = _ceil(Fraction(9, 10) * fps)
    for index, card in enumerate(grouped_cards[:-1]):
        duration_frames = card["end_frame_exclusive"] - card["start_frame"]
        next_start = grouped_cards[index + 1]["start_frame"]
        if (
            duration_frames < minimum_hold_frames
            and str(card.get("end_reason", "")).startswith("pause_blank")
            and card["end_frame_exclusive"] < next_start
        ):
            card["end_frame_exclusive"] = min(
                card["start_frame"] + minimum_hold_frames, next_start
            )
            card["end_seconds"] = float(
                Fraction(card["end_frame_exclusive"], 1) / fps
            )
            card["end_reason"] = "group_pause_hold"

    covered = [
        authored_index
        for card in grouped_cards
        for authored_index in card["authored_card_indices"]
    ]
    expected = [
        authored_index
        for card in cards
        for authored_index in card["authored_card_indices"]
    ]
    if covered != expected:
        raise CaptionAlignError("Grouped display cards do not preserve authored coverage")
    return grouped_cards


def _rounded_milliseconds(frame: int, fps: Fraction) -> int:
    value = Fraction(frame * 1000, 1) / fps
    return (2 * value.numerator + value.denominator) // (2 * value.denominator)


def _srt_timestamp(frame: int, fps: Fraction) -> str:
    milliseconds = _rounded_milliseconds(frame, fps)
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    seconds, milliseconds = divmod(milliseconds, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"


def render_srt(cards: Sequence[dict[str, Any]], fps: Fraction) -> str:
    blocks: list[str] = []
    for card in cards:
        blocks.append(
            "\n".join(
                [
                    str(card["index"]),
                    f"{_srt_timestamp(card['start_frame'], fps)} --> "
                    f"{_srt_timestamp(card['end_frame_exclusive'], fps)}",
                    str(card["text"]),
                ]
            )
        )
    return "\n\n".join(blocks) + "\n"


def _run_text(
    command: Sequence[str],
    *,
    env: dict[str, str] | None = None,
    log_path: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        list(command),
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if log_path is not None:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(result.stdout or "", encoding="utf-8")
    if result.returncode:
        rendered = subprocess.list2cmdline(list(command))
        raise CaptionAlignError(
            f"Command failed ({result.returncode}): {rendered}\n{result.stdout[-2000:]}"
        )
    return result


def _resolve_runtime_binary(runtime: Path, name: str) -> Path:
    suffix = ".exe" if os.name == "nt" else ""
    candidates = [
        runtime / "Scripts" / f"{name}{suffix}",
        runtime / "Library" / "bin" / f"{name}{suffix}",
        runtime / "bin" / name,
        runtime / f"{name}{suffix}",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    found = shutil.which(name)
    if found:
        return Path(found)
    raise CaptionAlignError(f"Cannot find {name} in runtime or PATH: {runtime}")


def _runtime_env(runtime: Path, mfa_root: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["MFA_ROOT_DIR"] = str(mfa_root)
    prefixes = [runtime / "Library" / "bin", runtime / "Scripts", runtime]
    env["PATH"] = os.pathsep.join(
        [str(path) for path in prefixes if path.exists()] + [env.get("PATH", "")]
    )
    return env


def probe_media(ffprobe: Path, media: Path, env: dict[str, str]) -> dict[str, Any]:
    result = _run_text(
        [
            str(ffprobe),
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            str(media),
        ],
        env=env,
    )
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise CaptionAlignError(f"ffprobe returned invalid JSON: {exc}") from exc

    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if audio is None:
        raise CaptionAlignError("Media has no audio stream")

    format_info = data.get("format", {})

    def number(obj: dict[str, Any] | None, key: str) -> float | None:
        if not obj or obj.get(key) in (None, "N/A"):
            return None
        try:
            return float(obj[key])
        except (TypeError, ValueError):
            return None

    def start_time(obj: dict[str, Any] | None) -> float | None:
        direct = number(obj, "start_time")
        if direct is not None:
            return direct
        if obj and obj.get("start_pts") is not None and obj.get("time_base"):
            try:
                return float(Fraction(int(obj["start_pts"]), 1) * Fraction(obj["time_base"]))
            except (TypeError, ValueError, ZeroDivisionError):
                pass
        return number(format_info, "start_time")

    def duration(obj: dict[str, Any] | None) -> float | None:
        direct = number(obj, "duration")
        if direct is not None:
            return direct
        if obj and obj.get("duration_ts") is not None and obj.get("time_base"):
            try:
                return float(Fraction(int(obj["duration_ts"]), 1) * Fraction(obj["time_base"]))
            except (TypeError, ValueError, ZeroDivisionError):
                pass
        return number(format_info, "duration")

    fps: Fraction | None = None
    if video is not None:
        for key in ("avg_frame_rate", "r_frame_rate"):
            value = video.get(key)
            if value and value != "0/0":
                try:
                    candidate = Fraction(value)
                except (ValueError, ZeroDivisionError):
                    continue
                if candidate > 0:
                    fps = candidate
                    break

    video_first = start_time(video) if video is not None else 0.0
    audio_first = start_time(audio)
    return {
        "video_present": video is not None,
        "video_duration_seconds": duration(video),
        "audio_duration_seconds": duration(audio),
        "format_duration_seconds": number(format_info, "duration"),
        "video_first_pts_seconds": 0.0 if video_first is None else video_first,
        "audio_first_pts_seconds": (
            (0.0 if video_first is None else video_first)
            if audio_first is None
            else audio_first
        ),
        "probed_fps": None if fps is None else str(fps),
        "video_codec": None if video is None else video.get("codec_name"),
        "audio_codec": audio.get("codec_name"),
        "audio_sample_rate": audio.get("sample_rate"),
        "audio_channels": audio.get("channels"),
    }


def extract_mixed_audio(
    ffmpeg: Path, media: Path, wav_path: Path, env: dict[str, str], log_path: Path
) -> None:
    _run_text(
        [
            str(ffmpeg),
            "-y",
            "-v",
            "error",
            "-i",
            str(media),
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(wav_path),
        ],
        env=env,
        log_path=log_path,
    )
    if not wav_path.is_file() or wav_path.stat().st_size <= 44:
        raise CaptionAlignError("ffmpeg did not produce a valid 16 kHz mono PCM WAV")


def run_mfa(
    *,
    mfa: Path,
    runtime_env: dict[str, str],
    mfa_root: Path,
    corpus_dir: Path,
    aligned_dir: Path,
    temporary_dir: Path,
    logs_dir: Path,
) -> tuple[Path, dict[str, Any]]:
    version_result = _run_text([str(mfa), "version"], env=runtime_env)
    mfa_version = (version_result.stdout or "").strip().splitlines()[-1]
    if mfa_version != EXPECTED_MFA_VERSION:
        raise CaptionAlignError(
            f"Expected MFA {EXPECTED_MFA_VERSION}, found {mfa_version or 'unknown'}"
        )

    command = [
        str(mfa),
        "align",
        str(corpus_dir),
        "korean_mfa",
        "korean_mfa",
        str(aligned_dir),
        "--g2p_model_path",
        "korean_mfa",
        "--output_format",
        "json",
        "--include_original_text",
        "--single_speaker",
        "--no_use_mp",
        "--clean",
        "--overwrite",
        "-j",
        "1",
        "-t",
        str(temporary_dir),
    ]
    _run_text(command, env=runtime_env, log_path=logs_dir / "mfa-align.log")

    json_paths = [
        path
        for path in aligned_dir.rglob("*.json")
        if path.name.lower() not in {"alignment.json", "qc.json"}
    ]
    if len(json_paths) != 1:
        raise CaptionAlignError(
            f"Expected exactly one MFA JSON output, found {len(json_paths)}"
        )

    oov_logs = list(temporary_dir.rglob("normalize_oov.log"))
    oov_text = "\n\n".join(_read_utf8(path) for path in oov_logs)
    if not oov_text:
        oov_text = "MFA produced no normalize_oov.log; inspect mfa-align.log.\n"
    g2p_log = logs_dir / "oov-g2p.log"
    g2p_log.write_text(oov_text, encoding="utf-8")
    oov_counts = [int(value) for value in re.findall(r"Found\s+(\d+)\s+OOVs", oov_text)]

    return json_paths[0], {
        "name": "Montreal Forced Aligner",
        "version": mfa_version,
        "alignment_type": "Korean phone alignment",
        "acoustic_model": "korean_mfa",
        "dictionary": "korean_mfa",
        "g2p_model": "korean_mfa",
        "mfa_root": str(mfa_root.resolve()),
        "oov_count": max(oov_counts, default=0),
        "g2p_log": str(g2p_log.resolve()),
        "align_log": str((logs_dir / "mfa-align.log").resolve()),
        "command": command,
    }


def build_qc(
    *,
    authored_count: int,
    mfa_token_count: int,
    unused_mfa_tokens: int,
    cards: Sequence[dict[str, Any]],
    fps: Fraction,
    media_info: dict[str, Any],
    visual_lead_frames: int,
    engine: dict[str, Any],
    display_cards: Sequence[dict[str, Any]] | None = None,
    display_override_count: int = 0,
    matched_display_override_count: int = 0,
    display_override_span_count: int = 0,
) -> dict[str, Any]:
    display_cards = cards if display_cards is None else display_cards
    coverage_count = len(cards)
    coverage = coverage_count / authored_count if authored_count else 0.0
    monotonic = all(
        cards[i]["start_frame"] < cards[i + 1]["start_frame"]
        and cards[i]["mfa_start_seconds"] < cards[i + 1]["mfa_start_seconds"]
        for i in range(len(cards) - 1)
    )
    overlap_count = sum(
        1
        for i in range(len(cards) - 1)
        if cards[i]["end_frame_exclusive"] > cards[i + 1]["start_frame"]
    )
    nonpositive_count = sum(
        1 for card in cards if card["end_frame_exclusive"] <= card["start_frame"]
    )
    off_grid_count = sum(
        1
        for card in cards
        if not isinstance(card["start_frame"], int)
        or not isinstance(card["end_frame_exclusive"], int)
    )
    display_covered_indices = [
        authored_index
        for card in display_cards
        for authored_index in card.get("authored_card_indices", [card["index"]])
    ]
    display_coverage_exact = display_covered_indices == list(
        range(1, authored_count + 1)
    )
    display_monotonic = all(
        display_cards[i]["start_frame"] < display_cards[i + 1]["start_frame"]
        for i in range(len(display_cards) - 1)
    )
    display_overlap_count = sum(
        1
        for i in range(len(display_cards) - 1)
        if display_cards[i]["end_frame_exclusive"]
        > display_cards[i + 1]["start_frame"]
    )
    display_nonpositive_count = sum(
        1
        for card in display_cards
        if card["end_frame_exclusive"] <= card["start_frame"]
    )
    display_off_grid_count = sum(
        1
        for card in display_cards
        if not isinstance(card["start_frame"], int)
        or not isinstance(card["end_frame_exclusive"], int)
    )

    audio_duration = media_info.get("audio_duration_seconds")
    video_duration = media_info.get("video_duration_seconds")
    audio_first = media_info["audio_first_pts_seconds"]
    video_first = media_info["video_first_pts_seconds"]
    last_source_end = max((card["source_end_seconds"] for card in cards), default=0.0)
    last_relative_end = max((card["end_seconds"] for card in cards), default=0.0)
    alignment_within_audio = (
        audio_duration is not None
        and last_source_end <= audio_first + audio_duration + 0.050
    )
    alignment_within_video = (
        video_duration is None or last_relative_end <= video_duration + float(1 / fps)
    )

    checks = {
        "authored_coverage_100_percent": coverage_count == authored_count,
        "unused_mfa_tokens_zero": unused_mfa_tokens == 0,
        "monotonic": monotonic,
        "overlap_zero": overlap_count == 0,
        "off_grid_zero": off_grid_count == 0,
        "positive_card_durations": nonpositive_count == 0,
        "display_authored_coverage_100_percent": display_coverage_exact,
        "display_monotonic": display_monotonic,
        "display_overlap_zero": display_overlap_count == 0,
        "display_positive_card_durations": display_nonpositive_count == 0,
        "display_off_grid_zero": display_off_grid_count == 0,
        "display_overrides_all_matched": (
            matched_display_override_count == display_override_count
        ),
        "audio_duration_available": audio_duration is not None,
        "alignment_within_audio": alignment_within_audio,
        "alignment_within_video": alignment_within_video,
        "fps_valid": fps > 0,
        "first_pts_available": isinstance(video_first, (int, float))
        and isinstance(audio_first, (int, float)),
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "passed": all(checks.values()),
        "checks": checks,
        "metrics": {
            "authored_eojeol_count": authored_count,
            "covered_eojeol_count": coverage_count,
            "authored_coverage": coverage,
            "mfa_token_count": mfa_token_count,
            "unused_mfa_token_count": unused_mfa_tokens,
            "overlap_count": overlap_count,
            "off_grid_count": off_grid_count,
            "nonpositive_duration_count": nonpositive_count,
            "display_card_count": len(display_cards),
            "display_covered_eojeol_count": len(display_covered_indices),
            "display_overlap_count": display_overlap_count,
            "display_off_grid_count": display_off_grid_count,
            "display_nonpositive_duration_count": display_nonpositive_count,
            "display_override_count": display_override_count,
            "matched_display_override_count": matched_display_override_count,
            "display_override_span_count": display_override_span_count,
        },
        "timing": {
            "fps": str(fps),
            "fps_float": float(fps),
            "video_first_pts_seconds": video_first,
            "audio_first_pts_seconds": audio_first,
            "visual_lead_frames": visual_lead_frames,
            "pause_threshold_seconds": float(PAUSE_THRESHOLD_SECONDS),
        },
        "durations": {
            "video_seconds": video_duration,
            "audio_seconds": audio_duration,
            "format_seconds": media_info.get("format_duration_seconds"),
            "last_aligned_source_end_seconds": last_source_end,
            "last_caption_end_seconds": last_relative_end,
        },
        "engine": engine,
    }


def decoded_audio_sha256(ffmpeg: Path, media: Path, env: dict[str, str]) -> str:
    """Hash deterministic decoded PCM, so container metadata cannot mask changes."""

    command = [
        str(ffmpeg),
        "-v",
        "error",
        "-i",
        str(media),
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
    ]
    process = subprocess.Popen(
        command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    digest = hashlib.sha256()
    byte_count = 0
    assert process.stdout is not None
    while True:
        chunk = process.stdout.read(1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
        byte_count += len(chunk)
    stderr = b"" if process.stderr is None else process.stderr.read()
    returncode = process.wait()
    if returncode or byte_count == 0:
        raise CaptionAlignError(
            f"Audio decode hash failed ({returncode}): "
            f"{stderr.decode('utf-8', errors='replace')[-2000:]}"
        )
    return digest.hexdigest()


def run_burner(
    *,
    burner: Path,
    media: Path,
    srt: Path,
    burn_out: Path,
    ffmpeg: Path,
    env: dict[str, str],
    log_path: Path,
    style: str,
    font: Path | None = None,
    fontsize_frac: float | None = None,
    bottom_frac: float | None = None,
    maxw_frac: float | None = None,
    bridge: float | None = None,
    tail: float | None = None,
    gap: float | None = None,
    min_dur: float | None = None,
    no_caps: bool = False,
    single_line: bool = False,
) -> dict[str, Any]:
    if not burner.is_file():
        raise CaptionAlignError(f"Subtitle burner does not exist: {burner}")
    if font is not None and not font.is_file():
        raise CaptionAlignError(f"Subtitle font does not exist: {font}")
    burn_out.parent.mkdir(parents=True, exist_ok=True)
    command = build_burner_command(
        burner=burner,
        media=media,
        srt=srt,
        burn_out=burn_out,
        style=style,
        font=font,
        fontsize_frac=fontsize_frac,
        bottom_frac=bottom_frac,
        maxw_frac=maxw_frac,
        bridge=bridge,
        tail=tail,
        gap=gap,
        min_dur=min_dur,
        no_caps=no_caps,
        single_line=single_line,
    )
    before = decoded_audio_sha256(ffmpeg, media, env)
    _run_text(command, env=env, log_path=log_path)
    if not burn_out.is_file():
        raise CaptionAlignError("Bundled subtitle burner did not create its output")
    after = decoded_audio_sha256(ffmpeg, burn_out, env)
    return {
        "burner": str(burner.resolve()),
        "output": str(burn_out.resolve()),
        "style": style,
        "font": None if font is None else str(font.resolve()),
        "passthrough": {
            "fontsize_frac": fontsize_frac,
            "bottom_frac": bottom_frac,
            "maxw_frac": maxw_frac,
            "bridge": bridge,
            "tail": tail,
            "gap": gap,
            "min_dur": min_dur,
            "no_caps": no_caps,
            "single_line": single_line,
        },
        "decoded_audio_sha256_before": before,
        "decoded_audio_sha256_after": after,
        "decoded_audio_identical": before == after,
        "log": str(log_path.resolve()),
    }


def build_burner_command(
    *,
    burner: Path,
    media: Path,
    srt: Path,
    burn_out: Path,
    style: str,
    font: Path | None = None,
    fontsize_frac: float | None = None,
    bottom_frac: float | None = None,
    maxw_frac: float | None = None,
    bridge: float | None = None,
    tail: float | None = None,
    gap: float | None = None,
    min_dur: float | None = None,
    no_caps: bool = False,
    single_line: bool = False,
) -> list[str]:
    """Build only documented bundled-burner arguments; omit unspecified defaults."""

    command = [
        sys.executable,
        str(burner),
        "--in",
        str(media),
        "--srt",
        str(srt),
        "--out",
        str(burn_out),
        "--style",
        style,
    ]
    if font is not None:
        command.extend(["--font", str(font)])
    if no_caps:
        # bold 스타일은 기본으로 라틴 문자를 대문자로 바꾼다. 브랜드 표기
        # (ComfyUI, Block Swap)를 display_text 그대로 남겨야 할 때 끈다.
        command.append("--no-caps")
    if single_line:
        # 모든 카드를 한 줄로 강제한다. 가장 긴 카드가 maxw 안에 들어가도록
        # 전체 글자 크기가 함께 정해지므로 fontsize-frac 은 상한으로 동작한다.
        command.append("--single-line")
    optional_values = [
        ("--fontsize-frac", fontsize_frac),
        ("--bottom-frac", bottom_frac),
        ("--maxw-frac", maxw_frac),
        ("--bridge", bridge),
        ("--tail", tail),
        ("--gap", gap),
        ("--min-dur", min_dur),
    ]
    for flag, value in optional_values:
        if value is not None:
            command.extend([flag, str(value)])
    return command


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Align exact Korean authored text to mixed media audio with MFA, then "
            "emit frame-snapped delivery captions in readable phrase groups."
        )
    )
    parser.add_argument("--media", type=Path, required=True)
    parser.add_argument("--script", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument(
        "--fps",
        type=parse_fps,
        help="Delivery FPS (for example 24 or 30000/1001); default: ffprobe video FPS",
    )
    parser.add_argument(
        "--mfa-runtime",
        type=Path,
        default=Path(__file__).resolve().parent / ".runtime" / "env",
    )
    parser.add_argument(
        "--mfa-root",
        type=Path,
        default=Path(__file__).resolve().parent / ".runtime" / "mfa-root",
    )
    parser.add_argument(
        "--work-dir",
        type=Path,
        help=(
            "MFA intermediate workspace; long output paths automatically use a "
            "stable short repo scratch path"
        ),
    )
    parser.add_argument(
        "--visual-lead-frames",
        type=int,
        choices=(0, 1, 2),
        default=0,
        help="Optional channel look-ahead; exact audio onset is the default (0)",
    )
    parser.add_argument(
        "--caption-grouping",
        choices=("exact", "relaxed"),
        default="relaxed",
        help=(
            "Display-card grouping profile: relaxed (default) groups short natural "
            "phrases toward 0.9-2.0 seconds; exact keeps one spoken eojeol per card"
        ),
    )
    parser.add_argument("--burner", type=Path)
    parser.add_argument("--burn-out", type=Path)
    parser.add_argument("--burn-style", choices=("paper", "bold"), default="bold")
    parser.add_argument(
        "--burn-font",
        type=Path,
        help="Font file passed to the bundled burner, for example malgunbd.ttf",
    )
    parser.add_argument("--burn-fontsize-frac", type=float)
    parser.add_argument("--burn-bottom-frac", type=float)
    parser.add_argument("--burn-maxw-frac", type=float)
    parser.add_argument("--burn-bridge", type=float)
    parser.add_argument("--burn-tail", type=float)
    parser.add_argument("--burn-gap", type=float)
    parser.add_argument("--burn-min-dur", type=float)
    parser.add_argument(
        "--burn-no-caps",
        action="store_true",
        help="bold 번인의 라틴 문자 대문자 변환을 끈다. display_text의 브랜드 표기"
             "(ComfyUI, Block Swap)를 그대로 화면에 남길 때 쓴다.",
    )
    parser.add_argument(
        "--burn-single-line",
        action="store_true",
        help="모든 자막 카드를 한 줄로 강제한다. 가장 긴 카드가 최대 폭에 맞도록"
             " 전체 글자 크기가 정해지므로 --burn-fontsize-frac 은 상한이 된다.",
    )
    return parser


def run(args: argparse.Namespace) -> dict[str, Any]:
    media = args.media.resolve()
    script_path = args.script.resolve()
    out_dir = args.out_dir.resolve()
    runtime = args.mfa_runtime.resolve()
    mfa_root = args.mfa_root.resolve()
    if not media.is_file():
        raise CaptionAlignError(f"Media does not exist: {media}")
    if bool(args.burner) != bool(args.burn_out):
        raise CaptionAlignError("--burner and --burn-out must be supplied together")

    out_dir.mkdir(parents=True, exist_ok=True)
    logs_dir = out_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    work_dir, work_dir_mode = select_work_dir(out_dir, args.work_dir)
    work_dir_info = {
        "path": str(work_dir.resolve()),
        "mode": work_dir_mode,
        "out_dir_absolute_length": len(str(out_dir)),
        "auto_short_threshold": SAFE_OUT_DIR_LENGTH,
        "nested_utf8_byte_threshold": SAFE_MFA_NESTED_UTF8_BYTES,
        **work_dir_risk_metadata(out_dir),
    }
    _write_json(
        out_dir / "qc.json",
        {
            "schema_version": SCHEMA_VERSION,
            "passed": False,
            "stage": "running",
            "work_dir": work_dir_info,
        },
    )
    corpus_dir = work_dir / "corpus" / "input"
    aligned_dir = work_dir / "aligned"
    temporary_dir = work_dir / "mfa-temp"
    corpus_dir.mkdir(parents=True, exist_ok=True)
    aligned_dir.mkdir(parents=True, exist_ok=True)
    temporary_dir.mkdir(parents=True, exist_ok=True)
    mfa_root.mkdir(parents=True, exist_ok=True)

    env = _runtime_env(runtime, mfa_root)
    mfa = _resolve_runtime_binary(runtime, "mfa")
    ffmpeg = _resolve_runtime_binary(runtime, "ffmpeg")
    ffprobe = _resolve_runtime_binary(runtime, "ffprobe")

    media_info = probe_media(ffprobe, media, env)
    fps = args.fps
    if fps is None:
        if not media_info["probed_fps"]:
            raise CaptionAlignError("No video FPS found; pass --fps explicitly")
        fps = Fraction(media_info["probed_fps"])

    script_spec = extract_script_spec(script_path)
    text = script_spec.spoken_text
    authored = tokenize_authored(text)
    lab_text = alignment_lab_text(authored)
    wav_path = corpus_dir / "input.wav"
    lab_path = corpus_dir / "input.lab"
    lab_path.write_text(lab_text + "\n", encoding="utf-8")
    (out_dir / "authored.lab").write_text(lab_text + "\n", encoding="utf-8")
    extract_mixed_audio(
        ffmpeg, media, wav_path, env, logs_dir / "ffmpeg-extract.log"
    )

    mfa_json_path, engine = run_mfa(
        mfa=mfa,
        runtime_env=env,
        mfa_root=mfa_root,
        corpus_dir=work_dir / "corpus",
        aligned_dir=aligned_dir,
        temporary_dir=temporary_dir,
        logs_dir=logs_dir,
    )
    mfa_data = json.loads(_read_utf8(mfa_json_path))
    mfa_tokens = parse_mfa_words(mfa_data)
    aligned, unused = rejoin_mfa_tokens(authored, mfa_tokens)
    cards = build_cards(
        aligned,
        fps,
        video_first_pts=media_info["video_first_pts_seconds"],
        audio_first_pts=media_info["audio_first_pts_seconds"],
        visual_lead_frames=args.visual_lead_frames,
    )
    display_spans, display_override_matches = compile_display_spans(
        authored, script_spec.caption_overrides
    )
    exact_display_cards = build_display_cards(cards, display_spans)
    display_cards = group_display_cards(
        exact_display_cards, fps, profile=args.caption_grouping
    )

    alignment = {
        "schema_version": SCHEMA_VERSION,
        "work_dir": work_dir_info,
        "engine": engine,
        "media": {"path": str(media), **media_info},
        "script": {
            "path": str(script_path),
            "source_format": script_spec.source_format,
            "text": text,
            "spoken_text": text,
            "mfa_lab_text": lab_text,
            "authored_eojeol_count": len(authored),
            "caption_overrides": display_override_matches,
        },
        "timing_policy": {
            "mode": "spoken-eojeol-with-display-overrides",
            "fps": str(fps),
            "visual_lead_frames": args.visual_lead_frames,
            "caption_grouping": args.caption_grouping,
            "pause_threshold_seconds": float(PAUSE_THRESHOLD_SECONDS),
            "continuous_boundary": "half-open hard switch at next card start",
            "pause_boundary": "ceil current speech end; preserve blank",
            "amplitude_correction": False,
            "silence_correction": False,
        },
        "cards": cards,
        "exact_display_cards": exact_display_cards,
        "display_cards": display_cards,
    }
    alignment_path = out_dir / "alignment.json"
    srt_path = out_dir / "captions.srt"
    qc_path = out_dir / "qc.json"
    _write_json(alignment_path, alignment)
    srt_path.write_text(render_srt(display_cards, fps), encoding="utf-8")

    qc = build_qc(
        authored_count=len(authored),
        mfa_token_count=len(mfa_tokens),
        unused_mfa_tokens=unused,
        cards=cards,
        fps=fps,
        media_info=media_info,
        visual_lead_frames=args.visual_lead_frames,
        engine=engine,
        display_cards=display_cards,
        display_override_count=len(script_spec.caption_overrides),
        matched_display_override_count=len(display_override_matches),
        display_override_span_count=len(display_spans),
    )
    qc["work_dir"] = work_dir_info
    qc["caption_grouping"] = {
        "profile": args.caption_grouping,
        "exact_display_card_count": len(exact_display_cards),
        "delivery_display_card_count": len(display_cards),
    }
    if args.burner and args.burn_out:
        burn = run_burner(
            burner=args.burner.resolve(),
            media=media,
            srt=srt_path,
            burn_out=args.burn_out.resolve(),
            ffmpeg=ffmpeg,
            env=env,
            log_path=logs_dir / "subtitle-burn.log",
            style=args.burn_style,
            font=None if args.burn_font is None else args.burn_font.resolve(),
            fontsize_frac=args.burn_fontsize_frac,
            bottom_frac=args.burn_bottom_frac,
            maxw_frac=args.burn_maxw_frac,
            bridge=args.burn_bridge,
            tail=args.burn_tail,
            gap=args.burn_gap,
            min_dur=args.burn_min_dur,
            no_caps=args.burn_no_caps,
            single_line=args.burn_single_line,
        )
        qc["burn"] = burn
        qc["checks"]["burn_audio_decode_sha256_identical"] = burn[
            "decoded_audio_identical"
        ]
        qc["passed"] = all(qc["checks"].values())
    _write_json(qc_path, qc)
    if not qc["passed"]:
        failed = [name for name, value in qc["checks"].items() if not value]
        raise CaptionAlignError("QC failed: " + ", ".join(failed))
    return {"alignment": alignment_path, "srt": srt_path, "qc": qc_path}


def main(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    qc_path = args.out_dir.resolve() / "qc.json"
    try:
        outputs = run(args)
    except Exception as exc:
        args.out_dir.resolve().mkdir(parents=True, exist_ok=True)
        failure: dict[str, Any]
        try:
            existing = json.loads(_read_utf8(qc_path)) if qc_path.exists() else {}
            failure = existing if isinstance(existing, dict) else {}
        except (OSError, json.JSONDecodeError):
            failure = {}
        failure["schema_version"] = SCHEMA_VERSION
        failure["passed"] = False
        failure["stage"] = "pipeline"
        errors = failure.get("errors")
        if not isinstance(errors, list):
            errors = []
        errors.append(f"{type(exc).__name__}: {exc}")
        failure["errors"] = errors
        _write_json(qc_path, failure)
        print(f"caption-align: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({key: str(value) for key, value in outputs.items()}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
