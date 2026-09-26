#!/usr/bin/env python3
"""Align semantic caption cues to the current Premiere timeline audio.

The cue map owns text and semantic grouping.  The audio owns time.  Existing
SRT timestamps are intentionally not accepted as an input.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import platform
import sys
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np
import soundfile as sf


ALIGNER_TIMESTAMP_SECONDS = 0.080


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def clean_alignment_text(text: str) -> str:
    """Mirror Qwen3 ForcedAligner's kept-character contract."""

    kept: list[str] = []
    for char in text:
        if char == "'":
            kept.append(char)
            continue
        category = unicodedata.category(char)
        if category.startswith("L") or category.startswith("N"):
            kept.append(char)
    return "".join(kept)


def seconds_to_srt(value: float) -> str:
    total_ms = max(0, int(round(value * 1000)))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"


def frame_time(frame: int, fps: float) -> float:
    return frame / fps


def floor_frame(value: float, fps: float) -> int:
    return int(math.floor((value * fps) + 1e-9))


def ceil_frame(value: float, fps: float) -> int:
    return int(math.ceil((value * fps) - 1e-9))


@dataclass(frozen=True)
class CueInput:
    number: int
    text: str
    display_lines: tuple[str, ...]
    source_word_start: int
    source_word_end: int
    approximate_start: float
    approximate_end: float


@dataclass(frozen=True)
class AlignedToken:
    text: str
    start: float
    end: float


@dataclass
class AlignedCue:
    source: CueInput
    tokens: list[AlignedToken]
    model_start: float
    model_end: float
    chunk_index: int
    start_frame: int = 0
    end_frame: int = 0


@dataclass(frozen=True)
class Chunk:
    index: int
    core_cue_start: int
    core_cue_end: int
    context_cue_start: int
    context_cue_end: int
    audio_start: float
    audio_end: float


@dataclass(frozen=True)
class EnergyEnvelope:
    frame_seconds: float
    rms_db: np.ndarray
    peak_db: np.ndarray
    score_db: np.ndarray
    active: np.ndarray
    rms_threshold_db: float
    peak_threshold_db: float


def load_inputs(
    transcript_path: Path, cue_map_path: Path
) -> tuple[list[dict[str, Any]], list[CueInput]]:
    transcript = read_json(transcript_path)
    cue_map = read_json(cue_map_path)
    words = transcript.get("words")
    cues = cue_map.get("cues")
    if not isinstance(words, list) or not words:
        raise ValueError("Transcript must contain a non-empty words array")
    if not isinstance(cues, list) or not cues:
        raise ValueError("Cue map must contain a non-empty cues array")

    parsed: list[CueInput] = []
    consumed: list[int] = []
    for expected_number, cue in enumerate(cues, start=1):
        number = int(cue.get("number", 0))
        if number != expected_number:
            raise ValueError(
                f"Cue numbers must be contiguous: expected {expected_number}, got {number}"
            )
        position_range = cue.get("sourceWordPositionRange") or {}
        start = int(position_range.get("startInclusive", -1))
        end = int(position_range.get("endInclusive", -1))
        if start < 0 or end < start or end >= len(words):
            raise ValueError(f"Cue {number} has an invalid source word range")
        declared_indices = [int(value) for value in cue.get("sourceWordIndices", [])]
        actual_indices = [int(words[index].get("index", index)) for index in range(start, end + 1)]
        if declared_indices != actual_indices:
            raise ValueError(f"Cue {number} source word provenance does not match transcript")
        text = str(cue.get("text", "")).strip()
        if not clean_alignment_text(text):
            raise ValueError(f"Cue {number} has no alignable text")
        display_lines = tuple(str(line) for line in cue.get("displayLines", []))
        if not display_lines or " ".join(display_lines).strip() != text:
            raise ValueError(f"Cue {number} displayLines do not reproduce cue text")
        parsed.append(
            CueInput(
                number=number,
                text=text,
                display_lines=display_lines,
                source_word_start=start,
                source_word_end=end,
                approximate_start=float(words[start]["start"]),
                approximate_end=float(words[end]["end"]),
            )
        )
        consumed.extend(range(start, end + 1))

    if consumed != list(range(len(words))):
        raise ValueError("Cue map must consume every transcript word exactly once in order")
    return words, parsed


def build_chunks(
    cues: Sequence[CueInput],
    audio_duration: float,
    max_chunk_seconds: float,
    pad_seconds: float,
) -> list[Chunk]:
    if max_chunk_seconds <= 10 or max_chunk_seconds > 270:
        raise ValueError("max_chunk_seconds must be in (10, 270]")
    chunks: list[Chunk] = []
    start = 0
    while start < len(cues):
        end = start
        while end + 1 < len(cues):
            candidate = cues[end + 1]
            if candidate.approximate_end - cues[start].approximate_start > max_chunk_seconds:
                break
            end += 1
        # Include two semantic cues on each side. One cue is the overlap audit
        # target; the outer cue prevents that target itself from sitting on a
        # model-window edge and attaching to similar pre-roll speech.
        context_start = max(0, start - 2)
        context_end = min(len(cues) - 1, end + 2)
        audio_start = max(0.0, cues[context_start].approximate_start - pad_seconds)
        audio_end = min(audio_duration, cues[context_end].approximate_end + pad_seconds)
        if audio_end <= audio_start:
            raise ValueError(f"Chunk {len(chunks) + 1} has an empty audio window")
        if audio_end - audio_start > 295:
            raise ValueError(f"Chunk {len(chunks) + 1} exceeds the aligner five-minute limit")
        chunks.append(
            Chunk(
                index=len(chunks) + 1,
                core_cue_start=start,
                core_cue_end=end,
                context_cue_start=context_start,
                context_cue_end=context_end,
                audio_start=audio_start,
                audio_end=audio_end,
            )
        )
        start = end + 1
    return chunks


def map_chunk_tokens_to_cues(
    chunk: Chunk,
    cues: Sequence[CueInput],
    token_items: Iterable[Any],
) -> list[AlignedCue]:
    chunk_cues = list(cues[chunk.context_cue_start : chunk.context_cue_end + 1])
    expected_parts = [clean_alignment_text(cue.text) for cue in chunk_cues]
    expected = "".join(expected_parts)
    tokens = [
        AlignedToken(
            text=str(item.text),
            start=chunk.audio_start + float(item.start_time),
            end=chunk.audio_start + float(item.end_time),
        )
        for item in token_items
    ]
    actual_parts = [clean_alignment_text(token.text) for token in tokens]
    actual = "".join(actual_parts)
    if actual != expected:
        mismatch = next(
            (index for index, pair in enumerate(zip(actual, expected)) if pair[0] != pair[1]),
            min(len(actual), len(expected)),
        )
        raise ValueError(
            f"Chunk {chunk.index} aligner token text mismatch at clean character {mismatch}: "
            f"expected={len(expected)}, actual={len(actual)}"
        )

    token_spans: list[tuple[int, int, AlignedToken]] = []
    cursor = 0
    for token, part in zip(tokens, actual_parts):
        if not part:
            continue
        token_spans.append((cursor, cursor + len(part), token))
        cursor += len(part)

    aligned: list[AlignedCue] = []
    cue_cursor = 0
    for cue, part in zip(chunk_cues, expected_parts):
        cue_start = cue_cursor
        cue_end = cue_cursor + len(part)
        selected = [
            token
            for token_start, token_end, token in token_spans
            if token_start >= cue_start and token_end <= cue_end
        ]
        crossing = [
            (token_start, token_end, token.text)
            for token_start, token_end, token in token_spans
            if token_start < cue_end and token_end > cue_start
            and not (token_start >= cue_start and token_end <= cue_end)
        ]
        if crossing or not selected:
            raise ValueError(
                f"Chunk {chunk.index} has a token crossing semantic cue {cue.number}: {crossing}"
            )
        if any(token.end < token.start for token in selected):
            raise ValueError(f"Cue {cue.number} has a reversed model token")
        aligned.append(
            AlignedCue(
                source=cue,
                tokens=selected,
                model_start=min(token.start for token in selected),
                model_end=max(token.end for token in selected),
                chunk_index=chunk.index,
            )
        )
        cue_cursor = cue_end
    return aligned


def align_with_qwen(
    audio: np.ndarray,
    sample_rate: int,
    cues: Sequence[CueInput],
    chunks: Sequence[Chunk],
    model_path: Path,
    language: str,
) -> tuple[
    list[AlignedCue],
    list[dict[str, Any]],
    list[dict[str, Any]],
    dict[str, Any],
]:
    import torch
    from qwen_asr import Qwen3ForcedAligner

    if not torch.cuda.is_available():
        raise RuntimeError("Qwen forced alignment requires the configured local CUDA runtime")

    started = time.perf_counter()
    model = Qwen3ForcedAligner.from_pretrained(
        str(model_path),
        dtype=torch.bfloat16,
        device_map="cuda:0",
        local_files_only=True,
    )
    model_load_seconds = time.perf_counter() - started
    torch.cuda.reset_peak_memory_stats()

    all_aligned: list[AlignedCue] = []
    chunk_reports: list[dict[str, Any]] = []
    observations: dict[int, list[dict[str, Any]]] = {}
    for chunk in chunks:
        start_sample = max(0, int(round(chunk.audio_start * sample_rate)))
        end_sample = min(len(audio), int(round(chunk.audio_end * sample_rate)))
        chunk_audio = np.ascontiguousarray(audio[start_sample:end_sample], dtype=np.float32)
        context_cues = cues[chunk.context_cue_start : chunk.context_cue_end + 1]
        core_cues = cues[chunk.core_cue_start : chunk.core_cue_end + 1]
        text = "\n".join(cue.text for cue in context_cues)
        infer_started = time.perf_counter()
        result = model.align(
            audio=(chunk_audio, sample_rate),
            text=text,
            language=language,
        )[0]
        infer_seconds = time.perf_counter() - infer_started
        mapped_with_context = map_chunk_tokens_to_cues(chunk, cues, result)
        core_offset = chunk.core_cue_start - chunk.context_cue_start
        core_length = chunk.core_cue_end - chunk.core_cue_start + 1
        mapped = mapped_with_context[core_offset : core_offset + core_length]
        all_aligned.extend(mapped)
        core_numbers = {cue.number for cue in core_cues}
        for context_index, cue in enumerate(mapped_with_context):
            observations.setdefault(cue.source.number, []).append(
                {
                    "chunkIndex": chunk.index,
                    "role": "core" if cue.source.number in core_numbers else "context",
                    "hasBidirectionalContext": 0 < context_index < len(mapped_with_context) - 1,
                    "modelStartSeconds": round(cue.model_start, 6),
                    "modelEndSeconds": round(cue.model_end, 6),
                }
            )
        zero_duration = sum(
            1 for cue in mapped for token in cue.tokens if token.end <= token.start
        )
        edge_tokens = sum(
            1
            for cue in mapped
            for token in cue.tokens
            if token.start <= chunk.audio_start + ALIGNER_TIMESTAMP_SECONDS
            or token.end >= chunk.audio_end - ALIGNER_TIMESTAMP_SECONDS
        )
        chunk_reports.append(
            {
                "index": chunk.index,
                "cueRange": [core_cues[0].number, core_cues[-1].number],
                "contextCueRange": [context_cues[0].number, context_cues[-1].number],
                "audioStartSeconds": round(chunk.audio_start, 6),
                "audioEndSeconds": round(chunk.audio_end, 6),
                "audioDurationSeconds": round(chunk.audio_end - chunk.audio_start, 6),
                "alignedTokenCount": sum(len(cue.tokens) for cue in mapped),
                "zeroDurationTokenCount": zero_duration,
                "edgeTokenCount": edge_tokens,
                "textCoverage": "exact-clean-character-match",
                "inferenceSeconds": round(infer_seconds, 3),
            }
        )
        del result, chunk_audio
        torch.cuda.empty_cache()

    runtime = {
        "python": platform.python_version(),
        "qwenAsr": importlib.metadata.version("qwen-asr"),
        "torch": torch.__version__,
        "cuda": torch.version.cuda,
        "gpu": torch.cuda.get_device_name(0),
        "modelLoadSeconds": round(model_load_seconds, 3),
        "peakCudaMemoryBytes": int(torch.cuda.max_memory_allocated()),
    }
    overlap_audits: list[dict[str, Any]] = []
    for cue_number, cue_observations in sorted(observations.items()):
        protected_observations = [
            item for item in cue_observations if item["hasBidirectionalContext"]
        ]
        if len(protected_observations) < 2:
            continue
        starts = [item["modelStartSeconds"] for item in protected_observations]
        ends = [item["modelEndSeconds"] for item in protected_observations]
        start_spread = max(starts) - min(starts)
        end_spread = max(ends) - min(ends)
        overlap_audits.append(
            {
                "cueNumber": cue_number,
                "observations": protected_observations,
                "startSpreadSeconds": round(start_spread, 6),
                "endSpreadSeconds": round(end_spread, 6),
                # Two 80 ms model ticks are the maximum accepted disagreement.
                # A small epsilon avoids rejecting an exact 0.160 float spread.
                "pass": start_spread <= 0.161 and end_spread <= 0.161,
            }
        )
    return all_aligned, chunk_reports, overlap_audits, runtime


def _fill_short_boolean_runs(values: np.ndarray, target: bool, max_length: int) -> None:
    index = 0
    while index < len(values):
        if bool(values[index]) != target:
            index += 1
            continue
        end = index + 1
        while end < len(values) and bool(values[end]) == target:
            end += 1
        if end - index <= max_length and index > 0 and end < len(values):
            if bool(values[index - 1]) == bool(values[end]) != target:
                values[index:end] = not target
        index = end


def build_energy_envelope(
    audio: np.ndarray, sample_rate: int, frame_ms: float = 10.0
) -> EnergyEnvelope:
    frame_samples = max(1, int(round(sample_rate * frame_ms / 1000.0)))
    frame_count = int(math.ceil(len(audio) / frame_samples))
    padded = np.zeros(frame_count * frame_samples, dtype=np.float32)
    padded[: len(audio)] = audio
    frames = padded.reshape(frame_count, frame_samples)
    rms = np.sqrt(np.mean(np.square(frames, dtype=np.float64), axis=1))
    peak = np.max(np.abs(frames), axis=1)
    rms_db = 20.0 * np.log10(np.maximum(rms, 1e-8))
    peak_db = 20.0 * np.log10(np.maximum(peak, 1e-8))
    kernel = np.ones(3, dtype=np.float64) / 3.0
    smooth_rms = np.convolve(rms_db, kernel, mode="same")
    smooth_peak = np.convolve(peak_db, kernel, mode="same")
    rms_noise = float(np.percentile(smooth_rms, 15))
    peak_noise = float(np.percentile(smooth_peak, 15))
    rms_threshold = float(np.clip(rms_noise + 15.0, -50.0, -36.0))
    peak_threshold = float(np.clip(peak_noise + 17.0, -43.0, -29.0))
    active = np.logical_or(smooth_rms >= rms_threshold, smooth_peak >= peak_threshold)
    active = active.astype(bool, copy=True)
    _fill_short_boolean_runs(active, False, 2)
    _fill_short_boolean_runs(active, True, 2)
    score_db = np.maximum(
        smooth_rms - rms_threshold,
        smooth_peak - peak_threshold,
    )
    return EnergyEnvelope(
        frame_seconds=frame_samples / sample_rate,
        rms_db=smooth_rms,
        peak_db=smooth_peak,
        score_db=score_db,
        active=active,
        rms_threshold_db=rms_threshold,
        peak_threshold_db=peak_threshold,
    )


def boolean_runs(values: np.ndarray, wanted: bool) -> list[tuple[int, int]]:
    runs: list[tuple[int, int]] = []
    index = 0
    while index < len(values):
        if bool(values[index]) != wanted:
            index += 1
            continue
        end = index + 1
        while end < len(values) and bool(values[end]) == wanted:
            end += 1
        runs.append((index, end))
        index = end
    return runs


def _frame_window(
    envelope: EnergyEnvelope, start: float, end: float
) -> tuple[int, int]:
    left = max(0, int(math.floor(start / envelope.frame_seconds)))
    right = min(len(envelope.active), int(math.ceil(end / envelope.frame_seconds)))
    return left, max(left + 1, right)


def refine_outer_boundary(
    envelope: EnergyEnvelope, model_time: float, kind: str, fps: float
) -> tuple[int, dict[str, Any]]:
    left, right = _frame_window(envelope, model_time - 0.40, model_time + 0.40)
    local = envelope.active[left:right]
    runs = [(left + start, left + end) for start, end in boolean_runs(local, True)]
    if kind == "start":
        reference_frame = model_time / envelope.frame_seconds
        candidates = [run for run in runs if run[0] - 20 <= reference_frame <= run[1] + 8]
        run = min(candidates or runs, key=lambda value: abs(value[0] - reference_frame)) if runs else None
        onset = run[0] * envelope.frame_seconds if run else model_time
        frame = max(0, floor_frame(onset, fps) - 1)
        evidence = "waveform-onset" if run else "forced-aligner-frame-snap"
        waveform_time = onset
    else:
        reference_frame = model_time / envelope.frame_seconds
        candidates = [run for run in runs if run[0] - 8 <= reference_frame <= run[1] + 20]
        run = min(candidates or runs, key=lambda value: abs(value[1] - reference_frame)) if runs else None
        offset = run[1] * envelope.frame_seconds if run else model_time
        frame = ceil_frame(offset, fps) + 1
        evidence = "waveform-offset" if run else "forced-aligner-frame-snap"
        waveform_time = offset
    return frame, {
        "type": evidence,
        "modelTimeSeconds": round(model_time, 6),
        "waveformTimeSeconds": round(waveform_time, 6),
        "finalFrame": frame,
        "adjustmentMilliseconds": int(round((frame_time(frame, fps) - model_time) * 1000)),
    }


def refine_internal_boundary(
    envelope: EnergyEnvelope,
    left_end: float,
    right_start: float,
    fps: float,
) -> tuple[int, int, dict[str, Any]]:
    center = (left_end + right_start) / 2.0
    search_start = min(left_end, right_start) - 0.24
    search_end = max(left_end, right_start) + 0.24
    first, last = _frame_window(envelope, search_start, search_end)
    local_inactive = np.logical_not(envelope.active[first:last])
    silence_runs = [
        (first + start, first + end)
        for start, end in boolean_runs(local_inactive, True)
        if (end - start) * envelope.frame_seconds >= 0.05
    ]
    center_frame = center / envelope.frame_seconds
    if silence_runs:
        run = min(silence_runs, key=lambda value: abs(((value[0] + value[1]) / 2) - center_frame))
        silence_start = run[0] * envelope.frame_seconds
        silence_end = run[1] * envelope.frame_seconds
        left_frame = ceil_frame(silence_start, fps) + 1
        right_frame = floor_frame(silence_end, fps) - 1
        if left_frame > right_frame:
            shared = int(round(((silence_start + silence_end) / 2) * fps))
            left_frame = shared
            right_frame = shared
        evidence = {
            "type": "waveform-silence-gap",
            "modelLeftEndSeconds": round(left_end, 6),
            "modelRightStartSeconds": round(right_start, 6),
            "silenceStartSeconds": round(silence_start, 6),
            "silenceEndSeconds": round(silence_end, 6),
            "leftEndFrame": left_frame,
            "rightStartFrame": right_frame,
        }
        return left_frame, right_frame, evidence

    valley_first, valley_last = _frame_window(envelope, center - 0.14, center + 0.14)
    indices = np.arange(valley_first, valley_last)
    distance = np.abs((indices * envelope.frame_seconds) - center) / 0.14
    local_score = envelope.score_db[valley_first:valley_last]
    normalized_score = (local_score - np.min(local_score)) / max(
        1e-6, float(np.max(local_score) - np.min(local_score))
    )
    best_local = int(np.argmin(normalized_score + (0.45 * distance)))
    valley_index = valley_first + best_local
    valley_time = valley_index * envelope.frame_seconds
    shared_frame = int(round(valley_time * fps))
    return shared_frame, shared_frame, {
        "type": "waveform-local-valley",
        "modelLeftEndSeconds": round(left_end, 6),
        "modelRightStartSeconds": round(right_start, 6),
        "valleySeconds": round(valley_time, 6),
        "valleyScoreDb": round(float(envelope.score_db[valley_index]), 3),
        "sharedFrame": shared_frame,
    }


def refine_all_cues(
    aligned: list[AlignedCue], envelope: EnergyEnvelope, fps: float, audio_duration: float
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not aligned:
        raise ValueError("No aligned cues")
    first_frame, first_evidence = refine_outer_boundary(
        envelope, aligned[0].model_start, "start", fps
    )
    aligned[0].start_frame = first_frame
    boundary_evidence: list[dict[str, Any]] = []
    for index in range(len(aligned) - 1):
        left_frame, right_frame, evidence = refine_internal_boundary(
            envelope,
            aligned[index].model_end,
            aligned[index + 1].model_start,
            fps,
        )
        aligned[index].end_frame = left_frame
        aligned[index + 1].start_frame = right_frame
        evidence["afterCue"] = aligned[index].source.number
        evidence["beforeCue"] = aligned[index + 1].source.number
        boundary_evidence.append(evidence)
    last_frame, last_evidence = refine_outer_boundary(
        envelope, aligned[-1].model_end, "end", fps
    )
    aligned[-1].end_frame = min(ceil_frame(audio_duration, fps), last_frame)

    cue_audits: list[dict[str, Any]] = []
    previous_end = -1
    hard_errors: list[str] = []
    for cue in aligned:
        if cue.start_frame < previous_end:
            hard_errors.append(f"cue {cue.source.number} overlaps the prior cue")
        if cue.end_frame <= cue.start_frame:
            hard_errors.append(f"cue {cue.source.number} has non-positive duration")
        if cue.start_frame < 0 or cue.end_frame > ceil_frame(audio_duration, fps):
            hard_errors.append(f"cue {cue.source.number} is outside the audio duration")
        previous_end = cue.end_frame
        start_seconds = frame_time(cue.start_frame, fps)
        end_seconds = frame_time(cue.end_frame, fps)
        first_token = cue.tokens[0]
        last_token = cue.tokens[-1]
        low_confidence: list[str] = []
        if first_token.end <= first_token.start:
            low_confidence.append("zero-duration-first-token-informational")
        if last_token.end <= last_token.start:
            low_confidence.append("zero-duration-last-token-informational")
        if abs(start_seconds - cue.model_start) > 0.50:
            low_confidence.append("large-start-waveform-adjustment-review")
        if abs(end_seconds - cue.model_end) > 0.50:
            low_confidence.append("large-end-waveform-adjustment-review")
        if end_seconds - start_seconds > 9.05:
            low_confidence.append("long-display-window-review")
        hard_failures: list[str] = []
        if cue.model_end <= cue.model_start:
            hard_failures.append("all-zero-cue-alignment")
        cue_audits.append(
            {
                "number": cue.source.number,
                "text": cue.source.text,
                "chunkIndex": cue.chunk_index,
                "alignedTokenCount": len(cue.tokens),
                "firstAlignedToken": first_token.text,
                "lastAlignedToken": last_token.text,
                "modelStartSeconds": round(cue.model_start, 6),
                "modelEndSeconds": round(cue.model_end, 6),
                "startFrame": cue.start_frame,
                "endFrame": cue.end_frame,
                "start": seconds_to_srt(start_seconds),
                "end": seconds_to_srt(end_seconds),
                "durationSeconds": round(end_seconds - start_seconds, 6),
                "startAdjustmentMilliseconds": int(
                    round((start_seconds - cue.model_start) * 1000)
                ),
                "endAdjustmentMilliseconds": int(
                    round((end_seconds - cue.model_end) * 1000)
                ),
                "forcedAlignerStartCoveredWithinResolution": start_seconds
                <= cue.model_start + ALIGNER_TIMESTAMP_SECONDS,
                "forcedAlignerEndCoveredWithinResolution": end_seconds
                >= cue.model_end - ALIGNER_TIMESTAMP_SECONDS,
                "lowConfidenceReasons": low_confidence,
                "hardFailureReasons": hard_failures,
                "pass": not hard_failures,
            }
        )
    if hard_errors:
        raise ValueError("; ".join(hard_errors))
    return cue_audits, [first_evidence, *boundary_evidence, last_evidence]


def write_srt(path: Path, aligned: Sequence[AlignedCue], fps: float) -> None:
    blocks: list[str] = []
    for cue in aligned:
        start = seconds_to_srt(frame_time(cue.start_frame, fps))
        end = seconds_to_srt(frame_time(cue.end_frame, fps))
        blocks.append(
            f"{cue.source.number}\n{start} --> {end}\n"
            + "\n".join(cue.source.display_lines)
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n\n".join(blocks) + "\n", encoding="utf-8-sig")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Force-align semantic caption text to exact timeline audio, then refine every "
            "cue boundary against the waveform. Existing SRT times are never accepted."
        )
    )
    parser.add_argument("--audio", required=True, type=Path)
    parser.add_argument("--audio-map", type=Path)
    parser.add_argument("--transcript", required=True, type=Path)
    parser.add_argument("--cue-map", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--fps", type=float, required=True)
    parser.add_argument("--language", default="Korean")
    parser.add_argument("--max-chunk-seconds", type=float, default=150.0)
    parser.add_argument("--chunk-pad-seconds", type=float, default=2.0)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    for path in (args.audio, args.transcript, args.cue_map, args.model):
        if not path.exists():
            raise FileNotFoundError(path)
    if args.audio_map and not args.audio_map.exists():
        raise FileNotFoundError(args.audio_map)
    if args.fps <= 0:
        raise ValueError("fps must be positive")

    audio, sample_rate = sf.read(args.audio, dtype="float32", always_2d=False)
    if audio.ndim == 2:
        audio = np.mean(audio, axis=1, dtype=np.float32)
    audio = np.asarray(audio, dtype=np.float32)
    if sample_rate != 16_000:
        raise ValueError(f"Expected 16 kHz audio, got {sample_rate}")
    audio_duration = len(audio) / sample_rate
    _, cues = load_inputs(args.transcript, args.cue_map)
    chunks = build_chunks(
        cues,
        audio_duration,
        args.max_chunk_seconds,
        args.chunk_pad_seconds,
    )

    started = time.perf_counter()
    aligned, chunk_reports, overlap_audits, runtime = align_with_qwen(
        audio,
        sample_rate,
        cues,
        chunks,
        args.model,
        args.language,
    )
    envelope = build_energy_envelope(audio, sample_rate)
    cue_audits, boundary_audits = refine_all_cues(
        aligned, envelope, args.fps, audio_duration
    )
    write_srt(args.output, aligned, args.fps)

    audio_map_payload = read_json(args.audio_map) if args.audio_map else None
    failed_cues = [cue["number"] for cue in cue_audits if not cue["pass"]]
    review_cues = [cue["number"] for cue in cue_audits if cue["lowConfidenceReasons"]]
    zero_duration_tokens = sum(
        chunk["zeroDurationTokenCount"] for chunk in chunk_reports
    )
    edge_tokens = sum(chunk["edgeTokenCount"] for chunk in chunk_reports)
    overlap_failures = [
        audit["cueNumber"] for audit in overlap_audits if not audit["pass"]
    ]
    ok = not failed_cues and edge_tokens == 0 and not overlap_failures
    report = {
        "schemaVersion": 1,
        "operation": "align-premiere-captions-to-waveform",
        "ok": ok,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "contract": {
            "textAuthority": "semantic-cue-map",
            "timingAuthority": "current-timeline-audio-waveform",
            "existingSrtTimingsUsed": False,
            "forcedAlignment": "Qwen3-ForcedAligner-0.6B local",
            "waveformRefinement": "onset-offset-silence-valley",
            "allCueBoundariesAudited": True,
        },
        "audio": {
            "path": str(args.audio.resolve()),
            "sha256": sha256_file(args.audio),
            "sampleRate": sample_rate,
            "channels": 1,
            "durationSeconds": round(audio_duration, 6),
            "sampleCount": len(audio),
        },
        "audioMap": (
            {
                "path": str(args.audio_map.resolve()),
                "sha256": sha256_file(args.audio_map),
                "projectName": audio_map_payload.get("projectName"),
                "projectPath": audio_map_payload.get("projectPath"),
                "sequenceName": audio_map_payload.get("sequenceName"),
                "sequenceId": audio_map_payload.get("sequenceId"),
                "sequenceDurationSeconds": audio_map_payload.get("sequenceDurationSeconds"),
                "audioClipCount": audio_map_payload.get("audioClipCount"),
            }
            if args.audio_map and audio_map_payload
            else None
        ),
        "inputs": {
            "transcript": {
                "path": str(args.transcript.resolve()),
                "sha256": sha256_file(args.transcript),
            },
            "cueMap": {
                "path": str(args.cue_map.resolve()),
                "sha256": sha256_file(args.cue_map),
                "cueCount": len(cues),
            },
            "model": {
                "path": str(args.model.resolve()),
                "weightsSha256": sha256_file(args.model / "model.safetensors"),
                "timestampResolutionSeconds": ALIGNER_TIMESTAMP_SECONDS,
            },
        },
        "output": {
            "path": str(args.output.resolve()),
            "sha256": sha256_file(args.output),
            "cueCount": len(aligned),
            "firstStart": cue_audits[0]["start"],
            "lastEnd": cue_audits[-1]["end"],
        },
        "settings": {
            "fps": args.fps,
            "language": args.language,
            "maxChunkSeconds": args.max_chunk_seconds,
            "chunkPadSeconds": args.chunk_pad_seconds,
            "waveformFrameSeconds": envelope.frame_seconds,
            "rmsThresholdDb": round(envelope.rms_threshold_db, 3),
            "peakThresholdDb": round(envelope.peak_threshold_db, 3),
        },
        "runtime": runtime,
        "summary": {
            "chunkCount": len(chunks),
            "cueCount": len(aligned),
            "boundaryCount": len(boundary_audits),
            "zeroDurationTokenCount": zero_duration_tokens,
            "edgeTokenCount": edge_tokens,
            "failedCueCount": len(failed_cues),
            "failedCueNumbers": failed_cues,
            "reviewRecommendedCueCount": len(review_cues),
            "reviewRecommendedCueNumbers": review_cues,
            "overlapConsistencyFailureCount": len(overlap_failures),
            "overlapConsistencyFailureCueNumbers": overlap_failures,
            "elapsedSeconds": round(time.perf_counter() - started, 3),
        },
        "chunks": chunk_reports,
        "chunkOverlapAudits": overlap_audits,
        "cueAudits": cue_audits,
        "boundaryAudits": boundary_audits,
    }
    write_json(args.report, report)
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
    print(f"output={args.output.resolve()}")
    print(f"report={args.report.resolve()}")
    return 0 if ok else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"caption waveform alignment failed: {error}", file=sys.stderr)
        raise
