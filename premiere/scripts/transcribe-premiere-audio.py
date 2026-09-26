"""Offline-first Korean transcription for a Premiere analysis audio file.

The runtime dependency is imported lazily so schema helpers and the companion
self-test can run on machines where faster-whisper is not installed yet.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import tempfile
from collections.abc import Iterable, Mapping, Sequence
from datetime import datetime, timezone
from importlib import metadata as importlib_metadata
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "deno.premiere.transcription.v1"
DEFAULT_MODEL_ID = "Systran/faster-whisper-large-v3"
QUALITY_MODEL_FAMILY = "large-v3"
DEFAULT_PROMPT = (
    "다음은 한국어 YouTube 튜토리얼 녹음입니다. "
    "고유명사: DENO, 디노, ComfyUI, 컴퓨UI, LTX, LoRA, 로라, "
    "AI Studio, 프롬프트, 워크플로우, 모델."
)
COMPUTE_TYPE_CHOICES = (
    "auto",
    "float32",
    "float16",
    "bfloat16",
)
WINDOWS_CUDA_DLL_DISTRIBUTIONS = (
    ("nvidia-cublas-cu12", Path("nvidia/cublas/bin")),
    ("nvidia-cudnn-cu12", Path("nvidia/cudnn/bin")),
)
_DLL_DIRECTORY_HANDLES: list[Any] = []
_DLL_DIRECTORY_PATHS: dict[str, str] = {}


class TranscriptionError(RuntimeError):
    """A concise, user-actionable transcription failure."""


class DependencyError(TranscriptionError):
    """The local faster-whisper runtime is not installed or cannot load."""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def clean_text(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def optional_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def timestamp_to_seconds(value: Any) -> float | None:
    number = optional_float(value)
    return None if number is None else round(number, 6)


def object_value(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, Mapping):
        return value.get(name, default)
    return getattr(value, name, default)


def package_version(distribution_name: str) -> str | None:
    try:
        return importlib_metadata.version(distribution_name)
    except importlib_metadata.PackageNotFoundError:
        return None


def register_windows_cuda_dll_directories() -> list[str]:
    """Register NVIDIA wheel DLL folders before importing CTranslate2.

    ``os.add_dll_directory`` handles must stay alive; otherwise Windows removes
    the directory from the process DLL search path when a handle is collected.
    """

    if os.name != "nt" or not hasattr(os, "add_dll_directory"):
        return []

    for distribution_name, relative_bin in WINDOWS_CUDA_DLL_DISTRIBUTIONS:
        try:
            distribution = importlib_metadata.distribution(distribution_name)
        except importlib_metadata.PackageNotFoundError:
            continue
        bin_directory = Path(distribution.locate_file(relative_bin))
        if not bin_directory.is_dir():
            continue
        resolved = str(bin_directory.resolve())
        normalized = os.path.normcase(resolved)
        if normalized in _DLL_DIRECTORY_PATHS:
            continue
        try:
            handle = os.add_dll_directory(resolved)
        except OSError as exc:
            raise DependencyError(
                f"Could not register CUDA DLL directory '{resolved}': {exc}"
            ) from exc
        _DLL_DIRECTORY_HANDLES.append(handle)
        _DLL_DIRECTORY_PATHS[normalized] = resolved

    registered_paths = list(_DLL_DIRECTORY_PATHS.values())
    # CTranslate2 delay-loads cuBLAS/cuDNN while consuming the segment generator.
    # On Windows its native loader also needs these wheel directories in PATH even
    # though os.add_dll_directory is sufficient for Python's own ctypes loader.
    current_entries = [
        entry for entry in os.environ.get("PATH", "").split(os.pathsep) if entry
    ]
    current_normalized = {
        os.path.normcase(str(Path(entry))) for entry in current_entries
    }
    missing_entries = [
        entry
        for entry in registered_paths
        if os.path.normcase(str(Path(entry))) not in current_normalized
    ]
    if missing_entries:
        os.environ["PATH"] = os.pathsep.join([*missing_entries, *current_entries])

    return registered_paths


def normalize_model_reference(
    model_reference: str | Path,
    *,
    require_local_path: bool = False,
) -> tuple[str, bool]:
    """Return a loader-ready model reference and whether it is a local path."""

    raw = str(model_reference).strip()
    if not raw:
        raise TranscriptionError("--model-id/--model-path cannot be empty.")

    expanded = Path(raw).expanduser()
    path_hint = require_local_path or (
        expanded.is_absolute()
        or raw.startswith((".", "~", "\\\\"))
        or "\\" in raw
        or expanded.exists()
    )
    if not path_hint:
        return raw, False
    if not expanded.exists():
        raise TranscriptionError(f"Local model path does not exist: {expanded}")
    if not expanded.is_dir():
        raise TranscriptionError(
            f"Local model path must be a snapshot directory: {expanded}"
        )
    return str(expanded.resolve()), True


def validate_large_v3_model_reference(
    model_reference: str, *, model_is_local_path: bool
) -> None:
    """Fail closed when a standard transcription tries to downgrade the model."""

    normalized = str(model_reference).replace("\\", "/").lower()
    if any(token in normalized for token in ("turbo", "distil")):
        raise TranscriptionError(
            "The standard Premiere transcription policy requires Whisper large-v3; "
            "turbo and distilled variants are not accepted."
        )
    if not model_is_local_path:
        if normalized != DEFAULT_MODEL_ID.lower():
            raise TranscriptionError(
                "The standard Premiere transcription policy fixes --model-id to "
                f"{DEFAULT_MODEL_ID}. Smaller or alternate model IDs are not accepted."
            )
        return

    if QUALITY_MODEL_FAMILY in normalized:
        return
    model_root = Path(model_reference)
    identity_sources: list[str] = []
    for file_name in ("config.json", "model_index.json", "README.md"):
        candidate = model_root / file_name
        if not candidate.is_file():
            continue
        try:
            identity_sources.append(candidate.read_text(encoding="utf-8")[:131072])
        except (OSError, UnicodeError):
            continue
    identity = " ".join(identity_sources).lower()
    if QUALITY_MODEL_FAMILY not in identity or any(
        token in identity for token in ("large-v3-turbo", "distil-large-v3")
    ):
        raise TranscriptionError(
            "--model-path must identify a Whisper large-v3 CTranslate2 snapshot. "
            "Use a path containing 'large-v3' or model metadata that names large-v3."
        )


def select_compute_type(
    device: str,
    requested: str,
    supported_compute_types: Iterable[str],
) -> str:
    supported = {str(value) for value in supported_compute_types}
    if requested != "auto":
        if supported and requested not in supported:
            available = ", ".join(sorted(supported))
            raise TranscriptionError(
                f"Compute type '{requested}' is not supported on {device}. "
                f"Supported types: {available}"
            )
        return requested

    preferences = ("float16", "bfloat16", "float32") if device == "cuda" else ("float32",)
    for compute_type in preferences:
        if not supported or compute_type in supported:
            return compute_type
    available = ", ".join(sorted(supported)) or "none reported"
    raise TranscriptionError(
        f"No supported automatic compute type was found for {device}. Reported: {available}"
    )


def resolve_runtime(
    requested_device: str,
    requested_compute_type: str,
    ctranslate2_module: Any,
) -> tuple[str, str, list[str]]:
    try:
        cuda_device_count = int(ctranslate2_module.get_cuda_device_count())
    except Exception as exc:  # pragma: no cover - depends on native runtime state
        if requested_device in ("auto", "cuda"):
            raise TranscriptionError(
                f"CUDA availability check failed in CTranslate2: {exc}"
            ) from exc
        cuda_device_count = 0

    if requested_device == "auto":
        device = "cuda"
    else:
        device = requested_device
    if device == "cuda" and cuda_device_count < 1:
        raise TranscriptionError(
            "The quality-first transcription policy requires CUDA, but CTranslate2 found "
            "no CUDA device. Repair the CUDA faster-whisper runtime; automatic CPU or "
            "quantized fallback is disabled."
        )

    try:
        supported = sorted(ctranslate2_module.get_supported_compute_types(device))
    except Exception as exc:  # pragma: no cover - depends on native runtime state
        raise TranscriptionError(
            f"Could not query supported compute types for {device}: {exc}"
        ) from exc
    compute_type = select_compute_type(device, requested_compute_type, supported)
    return device, compute_type, supported


def _require_timed_value(value: Any, label: str) -> float:
    result = timestamp_to_seconds(value)
    if result is None or result < 0:
        raise TranscriptionError(
            f"Missing or invalid word timestamp: {label}={value!r}"
        )
    return result


def materialize_segments(
    raw_segments: Iterable[Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Normalize faster-whisper's lazy segment stream into a stable JSON shape."""

    segments: list[dict[str, Any]] = []
    words: list[dict[str, Any]] = []
    last_segment_start = -1.0
    last_word_start = -1.0

    for segment_index, raw_segment in enumerate(raw_segments):
        source_id = int(object_value(raw_segment, "id", segment_index))
        start = _require_timed_value(
            object_value(raw_segment, "start"), "segment.start"
        )
        end = _require_timed_value(object_value(raw_segment, "end"), "segment.end")
        if end < start:
            raise TranscriptionError(
                f"Segment {segment_index} ends before it starts ({start} > {end})."
            )
        if start < last_segment_start:
            raise TranscriptionError(
                f"Segment {segment_index} is out of chronological order."
            )
        last_segment_start = start

        text = clean_text(object_value(raw_segment, "text", ""))
        segment_words: list[dict[str, Any]] = []
        for raw_word in object_value(raw_segment, "words", None) or []:
            word_text = clean_text(object_value(raw_word, "word", ""))
            if not word_text:
                continue
            word_start = _require_timed_value(
                object_value(raw_word, "start"), "word.start"
            )
            word_end = _require_timed_value(object_value(raw_word, "end"), "word.end")
            if word_end < word_start:
                raise TranscriptionError(
                    f"Word {word_text!r} ends before it starts ({word_start} > {word_end})."
                )
            if word_start < last_word_start:
                raise TranscriptionError(
                    f"Word {word_text!r} is out of chronological order."
                )
            last_word_start = word_start
            word_entry = {
                "index": len(words),
                "segment_index": segment_index,
                "start": word_start,
                "end": word_end,
                "text": word_text,
                "probability": optional_float(object_value(raw_word, "probability")),
            }
            segment_words.append(word_entry.copy())
            words.append(word_entry)

        if text and not segment_words:
            raise TranscriptionError(
                f"Segment {segment_index} contains text but no word timestamps. "
                "The backend must run with word_timestamps=True."
            )

        segments.append(
            {
                "index": segment_index,
                "source_id": source_id,
                "start": start,
                "end": end,
                "text": text,
                "seek": object_value(raw_segment, "seek"),
                "temperature": optional_float(object_value(raw_segment, "temperature")),
                "avg_logprob": optional_float(object_value(raw_segment, "avg_logprob")),
                "compression_ratio": optional_float(
                    object_value(raw_segment, "compression_ratio")
                ),
                "no_speech_probability": optional_float(
                    object_value(raw_segment, "no_speech_prob")
                ),
                "words": segment_words,
            }
        )
    return segments, words


def build_payload(
    *,
    audio_path: Path,
    model_reference: str,
    model_is_local_path: bool,
    allow_download: bool,
    device: str,
    device_index: int,
    compute_type: str,
    supported_compute_types: Sequence[str],
    language: str,
    prompt: str | None,
    beam_size: int,
    vad_filter: bool,
    vad_min_silence_ms: int,
    raw_segments: Iterable[Any],
    transcription_info: Any,
    legacy_options: Mapping[str, Any],
    created_at: str | None = None,
) -> dict[str, Any]:
    segments, words = materialize_segments(raw_segments)
    full_text = clean_text(" ".join(segment["text"] for segment in segments))
    created = created_at or now_iso()
    resolved_audio = audio_path.resolve()
    chunks = [
        {
            "index": segment["index"],
            "start": segment["start"],
            "end": segment["end"],
            "text": segment["text"],
        }
        for segment in segments
    ]

    payload = {
        "schema_version": SCHEMA_VERSION,
        "metadata": {
            "created_at": created,
            "backend": "faster-whisper",
            "audio": {
                "path": str(resolved_audio),
                "size_bytes": resolved_audio.stat().st_size,
            },
            "model": {
                "reference": model_reference,
                "is_local_path": model_is_local_path,
                "local_files_only": not allow_download,
                "download_allowed": allow_download,
                "quality_policy": {
                    "family": QUALITY_MODEL_FAMILY,
                    "automatic_smaller_or_turbo_fallback": False,
                    "automatic_quantized_fallback": False,
                },
            },
            "runtime": {
                "faster_whisper_version": package_version("faster-whisper"),
                "ctranslate2_version": package_version("ctranslate2"),
                "nvidia_cublas_cu12_version": package_version("nvidia-cublas-cu12"),
                "nvidia_cudnn_cu12_version": package_version("nvidia-cudnn-cu12"),
                "cuda_dll_directories": list(_DLL_DIRECTORY_PATHS.values()),
                "device": device,
                "device_index": device_index,
                "compute_type": compute_type,
                "supported_compute_types": list(supported_compute_types),
            },
            "transcription": {
                "task": "transcribe",
                "language_requested": language,
                "language_detected": object_value(transcription_info, "language"),
                "language_probability": optional_float(
                    object_value(transcription_info, "language_probability")
                ),
                "duration": timestamp_to_seconds(
                    object_value(transcription_info, "duration")
                ),
                "duration_after_vad": timestamp_to_seconds(
                    object_value(transcription_info, "duration_after_vad")
                ),
                "initial_prompt": prompt,
                "initial_prompt_used": bool(prompt),
                "word_timestamps": True,
                "beam_size": beam_size,
                "vad_filter": vad_filter,
                "vad_min_silence_ms": vad_min_silence_ms if vad_filter else None,
                "chunk_length": round(float(legacy_options["chunk_length"])),
            },
            "legacy_cli": {
                **dict(legacy_options),
                "note": (
                    "chunk_length is applied to faster-whisper. stride_length and batch_size "
                    "are accepted for CLI compatibility but are not used by this quality-first "
                    "non-batched backend."
                ),
            },
        },
        "full_text": full_text,
        "segments": segments,
        "words": words,
        # Backward-compatible top-level fields from the original Transformers script.
        "created_at": created,
        "audio": str(resolved_audio),
        "model_id": model_reference,
        "local_files_only": not allow_download,
        "device": device,
        "dtype": compute_type,
        "chunk_length": legacy_options.get("chunk_length"),
        "stride_length": legacy_options.get("stride_length"),
        "batch_size": legacy_options.get("batch_size"),
        "text": full_text,
        "chunks": chunks,
    }
    return payload


def load_runtime_dependencies() -> tuple[Any, Any]:
    try:
        import ctranslate2
        from faster_whisper import WhisperModel
    except (ImportError, ModuleNotFoundError, OSError) as exc:
        requirements = Path(__file__).with_name(
            "requirements-premiere-transcription.txt"
        )
        raise DependencyError(
            "faster-whisper is unavailable. Install the local runtime with "
            f'`python -m pip install -r "{requirements}"`. '
            f"Original error: {type(exc).__name__}: {exc}"
        ) from exc
    return WhisperModel, ctranslate2


def load_model(
    whisper_model_class: Any,
    *,
    model_reference: str,
    model_is_local_path: bool,
    allow_download: bool,
    device: str,
    device_index: int,
    compute_type: str,
    cpu_threads: int,
    num_workers: int,
    cache_dir: Path | None,
) -> Any:
    kwargs: dict[str, Any] = {
        "device": device,
        "device_index": device_index,
        "compute_type": compute_type,
        "cpu_threads": cpu_threads,
        "num_workers": num_workers,
        "local_files_only": not allow_download,
    }
    if cache_dir is not None:
        kwargs["download_root"] = str(cache_dir.resolve())
    try:
        return whisper_model_class(model_reference, **kwargs)
    except Exception as exc:
        if not allow_download and not model_is_local_path:
            guidance = (
                "Downloads are disabled. Cache the model first, pass an existing CTranslate2 "
                "snapshot directory with --model-path, or explicitly add --allow-download."
            )
        else:
            guidance = (
                "Verify the CTranslate2 model files and selected device/compute type."
            )
        raise TranscriptionError(
            f"Could not load faster-whisper model '{model_reference}'. {guidance} "
            f"Original error: {type(exc).__name__}: {exc}"
        ) from exc


def transcribe(
    model: Any, audio_path: Path, args: argparse.Namespace, prompt: str | None
) -> tuple[Any, Any]:
    options: dict[str, Any] = {
        "language": args.language,
        "task": "transcribe",
        "beam_size": args.beam_size,
        "temperature": 0.0,
        "condition_on_previous_text": False,
        "word_timestamps": True,
        "initial_prompt": prompt,
        "vad_filter": args.vad_filter,
        "chunk_length": round(args.chunk_length),
    }
    if args.vad_filter:
        options["vad_parameters"] = {
            "min_silence_duration_ms": args.vad_min_silence_ms,
        }
    try:
        return model.transcribe(str(audio_path), **options)
    except Exception as exc:
        raise TranscriptionError(
            f"faster-whisper could not start transcription: {type(exc).__name__}: {exc}"
        ) from exc


def write_json_atomic(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=path.parent,
            delete=False,
        ) as handle:
            temporary_path = Path(handle.name)
            json.dump(payload, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write("\n")
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


def validate_output_path(audio_path: Path, output_path: Path) -> None:
    resolved_audio = audio_path.resolve()
    resolved_output = output_path.resolve()
    if resolved_audio == resolved_output:
        raise TranscriptionError("--out must not overwrite the input audio file.")
    if output_path.exists():
        if output_path.is_dir():
            raise TranscriptionError(f"--out must point to a JSON file: {output_path}")
        try:
            if os.path.samefile(resolved_audio, resolved_output):
                raise TranscriptionError(
                    "--out resolves to the same file as --audio (including a hard link)."
                )
        except FileNotFoundError:
            pass


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Transcribe a local Premiere audio analysis file with the faster-whisper "
            "backend and the fixed Whisper large-v3 quality profile."
        )
    )
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    model_group = parser.add_mutually_exclusive_group()
    model_group.add_argument("--model-id", default=DEFAULT_MODEL_ID)
    model_group.add_argument(
        "--model-path",
        type=Path,
        help="Existing local CTranslate2/Hugging Face snapshot directory.",
    )
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--no-prompt", action="store_true")
    parser.add_argument(
        "--allow-download",
        action="store_true",
        help="Explicitly allow Hugging Face model download. Default is local-files-only.",
    )
    parser.add_argument("--language", default="ko")
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="cuda")
    parser.add_argument("--device-index", type=int, default=0)
    parser.add_argument("--compute-type", choices=COMPUTE_TYPE_CHOICES, default="float16")
    parser.add_argument("--cpu-threads", type=int, default=0)
    parser.add_argument("--num-workers", type=int, default=1)
    parser.add_argument("--beam-size", type=int, default=5)
    vad_group = parser.add_mutually_exclusive_group()
    vad_group.add_argument("--vad-filter", dest="vad_filter", action="store_true")
    vad_group.add_argument("--no-vad-filter", dest="vad_filter", action="store_false")
    parser.set_defaults(vad_filter=True)
    parser.add_argument("--vad-min-silence-ms", type=int, default=500)

    # Kept so existing callers do not break while the backend moves off Transformers.
    parser.add_argument("--chunk-length", type=float, default=30.0)
    parser.add_argument("--stride-length", type=float, default=5.0)
    parser.add_argument("--batch-size", type=int, default=8)
    return parser


def validate_args(args: argparse.Namespace) -> None:
    if not args.audio.exists():
        raise TranscriptionError(f"Audio file does not exist: {args.audio}")
    if not args.audio.is_file():
        raise TranscriptionError(f"--audio must point to a file: {args.audio}")
    if args.audio.stat().st_size < 1:
        raise TranscriptionError(f"Audio file is empty: {args.audio}")
    validate_output_path(args.audio, args.out)
    if args.device_index < 0:
        raise TranscriptionError("--device-index must be zero or greater.")
    if args.cpu_threads < 0:
        raise TranscriptionError("--cpu-threads must be zero or greater.")
    if args.num_workers < 1:
        raise TranscriptionError("--num-workers must be at least 1.")
    if args.beam_size < 1:
        raise TranscriptionError("--beam-size must be at least 1.")
    if args.vad_min_silence_ms < 0:
        raise TranscriptionError("--vad-min-silence-ms must be zero or greater.")
    if args.chunk_length <= 0:
        raise TranscriptionError("--chunk-length must be greater than zero.")
    if args.stride_length < 0:
        raise TranscriptionError("--stride-length must be zero or greater.")
    if args.batch_size < 1:
        raise TranscriptionError("--batch-size must be at least 1.")
    if not str(args.language).strip():
        raise TranscriptionError("--language cannot be empty.")
    if (
        args.cache_dir is not None
        and args.cache_dir.exists()
        and not args.cache_dir.is_dir()
    ):
        raise TranscriptionError(f"--cache-dir must be a directory: {args.cache_dir}")


def run(args: argparse.Namespace) -> dict[str, Any]:
    validate_args(args)
    model_input: str | Path = (
        args.model_path if args.model_path is not None else args.model_id
    )
    model_reference, model_is_local_path = normalize_model_reference(
        model_input,
        require_local_path=args.model_path is not None,
    )
    validate_large_v3_model_reference(
        model_reference, model_is_local_path=model_is_local_path
    )
    prompt = None if args.no_prompt else clean_text(args.prompt)
    if not prompt:
        prompt = None

    if not args.allow_download:
        # WhisperModel honors local_files_only; the environment guard also blocks a
        # tokenizer fallback from reaching Hugging Face for an incomplete snapshot.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

    if args.device != "cpu":
        register_windows_cuda_dll_directories()
    whisper_model_class, ctranslate2_module = load_runtime_dependencies()
    device, compute_type, supported_compute_types = resolve_runtime(
        args.device,
        args.compute_type,
        ctranslate2_module,
    )
    model = load_model(
        whisper_model_class,
        model_reference=model_reference,
        model_is_local_path=model_is_local_path,
        allow_download=args.allow_download,
        device=device,
        device_index=args.device_index,
        compute_type=compute_type,
        cpu_threads=args.cpu_threads,
        num_workers=args.num_workers,
        cache_dir=args.cache_dir,
    )
    raw_segments, info = transcribe(model, args.audio.resolve(), args, prompt)
    try:
        payload = build_payload(
            audio_path=args.audio,
            model_reference=model_reference,
            model_is_local_path=model_is_local_path,
            allow_download=args.allow_download,
            device=device,
            device_index=args.device_index,
            compute_type=compute_type,
            supported_compute_types=supported_compute_types,
            language=args.language,
            prompt=prompt,
            beam_size=args.beam_size,
            vad_filter=args.vad_filter,
            vad_min_silence_ms=args.vad_min_silence_ms,
            raw_segments=raw_segments,
            transcription_info=info,
            legacy_options={
                "chunk_length": args.chunk_length,
                "stride_length": args.stride_length,
                "batch_size": args.batch_size,
            },
        )
    except TranscriptionError:
        raise
    except Exception as exc:
        # faster-whisper performs most work while the lazy segment generator is consumed.
        raise TranscriptionError(
            f"faster-whisper transcription failed: {type(exc).__name__}: {exc}"
        ) from exc
    write_json_atomic(args.out.resolve(), payload)
    return payload


def cli(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        payload = run(args)
    except (TranscriptionError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(
        json.dumps(
            {
                "out": str(args.out.resolve()),
                "segments": len(payload["segments"]),
                "words": len(payload["words"]),
                "textLength": len(payload["full_text"]),
                "device": payload["metadata"]["runtime"]["device"],
                "computeType": payload["metadata"]["runtime"]["compute_type"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(cli())
