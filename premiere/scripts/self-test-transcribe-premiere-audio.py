"""Model-free contract tests for transcribe-premiere-audio.py."""

from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace

SCRIPT_PATH = Path(__file__).with_name("transcribe-premiere-audio.py")


def load_subject():
    spec = importlib.util.spec_from_file_location(
        "transcribe_premiere_audio", SCRIPT_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load {SCRIPT_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    subject = load_subject()
    require(subject.clean_text("  안녕\n  하세요 ") == "안녕 하세요", "clean_text")
    require(subject.timestamp_to_seconds(1.23456789) == 1.234568, "timestamp rounding")
    require(
        subject.select_compute_type("cuda", "auto", {"float16", "float32"})
        == "float16",
        "CUDA automatic compute type",
    )
    require(
        subject.select_compute_type("cpu", "auto", {"int8", "float32"}) == "float32",
        "CPU automatic compute type",
    )
    parser_defaults = subject.build_parser().parse_args(
        ["--audio", "fixture.wav", "--out", "fixture.json"]
    )
    require(parser_defaults.device == "cuda", "quality-first CUDA default")
    require(parser_defaults.compute_type == "float16", "quality-first float16 default")
    subject.validate_large_v3_model_reference(
        subject.DEFAULT_MODEL_ID, model_is_local_path=False
    )
    try:
        subject.validate_large_v3_model_reference(
            "Systran/faster-whisper-small", model_is_local_path=False
        )
    except subject.TranscriptionError as exc:
        require("large-v3" in str(exc), "smaller model failure detail")
    else:
        raise AssertionError("smaller Whisper models must fail closed")

    class FakeNoCuda:
        @staticmethod
        def get_cuda_device_count():
            return 0

        @staticmethod
        def get_supported_compute_types(_device):
            return {"float32"}

    try:
        subject.resolve_runtime("auto", "auto", FakeNoCuda)
    except subject.TranscriptionError as exc:
        require("automatic CPU" in str(exc), "no automatic CPU fallback detail")
    else:
        raise AssertionError("automatic device selection must not fall back to CPU")

    test_temp_root = SCRIPT_PATH.parent.parent / "tmp" / "self-tests"
    test_temp_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="deno-transcription-self-test-", dir=test_temp_root
    ) as temp_dir:
        root = Path(temp_dir)
        audio_path = root / "analysis.wav"
        audio_path.write_bytes(b"RIFF-model-free-test")
        try:
            subject.validate_output_path(audio_path, audio_path)
        except subject.TranscriptionError as exc:
            require("must not overwrite" in str(exc), "input overwrite failure detail")
        else:
            raise AssertionError("--out must never overwrite --audio")
        hardlink_path = root / "analysis-hardlink.wav"
        hardlink_path.hardlink_to(audio_path)
        try:
            subject.validate_output_path(audio_path, hardlink_path)
        except subject.TranscriptionError as exc:
            require("hard link" in str(exc), "input hard-link failure detail")
        else:
            raise AssertionError("--out hard link must never overwrite --audio")
        snapshot = root / "snapshot"
        snapshot.mkdir()
        normalized_snapshot, is_local = subject.normalize_model_reference(snapshot)
        require(
            Path(normalized_snapshot) == snapshot.resolve(),
            "local snapshot normalization",
        )
        require(is_local, "local snapshot detection")
        model_id, is_local = subject.normalize_model_reference(
            "Systran/faster-whisper-large-v3"
        )
        require(model_id == "Systran/faster-whisper-large-v3", "Hugging Face model id")
        require(not is_local, "model id is not a local path")
        try:
            subject.normalize_model_reference(
                root / "missing-snapshot",
                require_local_path=True,
            )
        except subject.TranscriptionError as exc:
            require("does not exist" in str(exc), "missing local snapshot detail")
        else:
            raise AssertionError("an explicit missing --model-path must fail closed")

        class FakeModel:
            def transcribe(self, audio, **options):
                self.audio = audio
                self.options = options
                return iter(()), SimpleNamespace(language="ko")

        fake_model = FakeModel()
        fake_args = SimpleNamespace(
            language="ko",
            beam_size=5,
            vad_filter=True,
            vad_min_silence_ms=500,
            chunk_length=30.0,
        )
        subject.transcribe(fake_model, audio_path, fake_args, "한국어 테스트")
        require(
            fake_model.options["word_timestamps"] is True, "required word timestamps"
        )
        require(
            fake_model.options["initial_prompt"] == "한국어 테스트", "initial prompt"
        )
        require(fake_model.options["language"] == "ko", "Korean language")
        require(fake_model.options["chunk_length"] == 30, "chunk length compatibility")

        raw_segments = [
            SimpleNamespace(
                id=0,
                start=0.1,
                end=1.4,
                text=" 안녕하세요",
                seek=0,
                temperature=0.0,
                avg_logprob=-0.1,
                compression_ratio=1.0,
                no_speech_prob=0.01,
                words=[
                    SimpleNamespace(word=" 안녕", start=0.1, end=0.6, probability=0.97),
                    SimpleNamespace(
                        word="하세요", start=0.61, end=1.4, probability=0.96
                    ),
                ],
            ),
            SimpleNamespace(
                id=1,
                start=1.5,
                end=2.0,
                text=" 디노입니다.",
                seek=0,
                temperature=0.0,
                avg_logprob=-0.2,
                compression_ratio=1.1,
                no_speech_prob=0.02,
                words=[
                    SimpleNamespace(
                        word=" 디노입니다.", start=1.5, end=2.0, probability=0.95
                    )
                ],
            ),
        ]
        info = SimpleNamespace(
            language="ko",
            language_probability=0.999,
            duration=2.1,
            duration_after_vad=2.0,
        )
        payload = subject.build_payload(
            audio_path=audio_path,
            model_reference=normalized_snapshot,
            model_is_local_path=True,
            allow_download=False,
            device="cpu",
            device_index=0,
            compute_type="float32",
            supported_compute_types=["float32"],
            language="ko",
            prompt="한국어 테스트",
            beam_size=5,
            vad_filter=True,
            vad_min_silence_ms=500,
            raw_segments=raw_segments,
            transcription_info=info,
            legacy_options={
                "chunk_length": 30.0,
                "stride_length": 5.0,
                "batch_size": 8,
            },
            created_at="2026-08-25T00:00:00+00:00",
        )
        require(payload["schema_version"] == subject.SCHEMA_VERSION, "schema version")
        require(payload["full_text"] == "안녕하세요 디노입니다.", "full text")
        require(payload["text"] == payload["full_text"], "legacy text alias")
        require(len(payload["segments"]) == 2, "segment count")
        require(len(payload["words"]) == 3, "word count")
        require(payload["words"][0]["start"] == 0.1, "word timestamp")
        require(payload["words"][0]["probability"] == 0.97, "word probability")
        require(payload["metadata"]["model"]["local_files_only"], "offline default")
        require(
            payload["metadata"]["transcription"]["word_timestamps"], "word timestamps"
        )

        out_path = root / "nested" / "transcript.json"
        subject.write_json_atomic(out_path, payload)
        round_trip = json.loads(out_path.read_text(encoding="utf-8"))
        require(round_trip == payload, "atomic JSON round trip")
        require(not list(out_path.parent.glob("*.tmp")), "temporary file cleanup")

        missing_words = [
            SimpleNamespace(id=0, start=0.0, end=1.0, text="텍스트", words=[])
        ]
        try:
            subject.materialize_segments(missing_words)
        except subject.TranscriptionError as exc:
            require("no word timestamps" in str(exc), "word timestamp failure detail")
        else:
            raise AssertionError("text without word timestamps must fail closed")

    print(
        json.dumps(
            {
                "ok": True,
                "script": str(SCRIPT_PATH),
                "schema": subject.SCHEMA_VERSION,
                "tests": 35,
                "modelLoaded": False,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
