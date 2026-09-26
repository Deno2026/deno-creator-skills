#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np


MODULE_PATH = Path(__file__).with_name("align_premiere_captions_to_waveform.py")
SPEC = importlib.util.spec_from_file_location("caption_waveform_sync", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class CaptionWaveformSyncTest(unittest.TestCase):
    def test_clean_alignment_text_matches_qwen_contract(self) -> None:
        self.assertEqual(
            MODULE.clean_alignment_text("8GB VRAM · ComfyUI, 최적화입니다!"),
            "8GBVRAMComfyUI최적화입니다",
        )

    def test_chunk_token_mapping_is_exact_and_rejects_crossing(self) -> None:
        cues = [
            MODULE.CueInput(1, "안녕하세요", ("안녕하세요",), 0, 0, 0.0, 1.0),
            MODULE.CueInput(2, "테스트입니다", ("테스트입니다",), 1, 1, 1.0, 2.0),
        ]
        chunk = MODULE.Chunk(1, 0, 1, 0, 1, 0.0, 3.0)
        tokens = [
            SimpleNamespace(text="안녕", start_time=0.2, end_time=0.4),
            SimpleNamespace(text="하세요", start_time=0.4, end_time=0.8),
            SimpleNamespace(text="테스트", start_time=1.2, end_time=1.6),
            SimpleNamespace(text="입니다", start_time=1.6, end_time=2.0),
        ]
        mapped = MODULE.map_chunk_tokens_to_cues(chunk, cues, tokens)
        self.assertEqual([cue.model_start for cue in mapped], [0.2, 1.2])
        self.assertEqual([cue.model_end for cue in mapped], [0.8, 2.0])

    def test_waveform_finds_real_silence_between_cues(self) -> None:
        sample_rate = 16_000
        audio = np.zeros(sample_rate * 3, dtype=np.float32)
        time_axis = np.arange(sample_rate) / sample_rate
        audio[int(0.3 * sample_rate) : int(1.2 * sample_rate)] = (
            0.15 * np.sin(2 * np.pi * 220 * time_axis[: int(0.9 * sample_rate)])
        )
        audio[int(1.7 * sample_rate) : int(2.6 * sample_rate)] = (
            0.15 * np.sin(2 * np.pi * 180 * time_axis[: int(0.9 * sample_rate)])
        )
        envelope = MODULE.build_energy_envelope(audio, sample_rate)
        left, right, evidence = MODULE.refine_internal_boundary(
            envelope, 1.15, 1.75, 30.0
        )
        self.assertEqual(evidence["type"], "waveform-silence-gap")
        self.assertLessEqual(left, right)
        self.assertGreaterEqual(MODULE.frame_time(left, 30.0), 1.1)
        self.assertLessEqual(MODULE.frame_time(right, 30.0), 1.8)

    def test_continuous_speech_uses_shared_valley(self) -> None:
        sample_rate = 16_000
        audio = np.full(sample_rate * 2, 0.05, dtype=np.float32)
        valley_start = int(0.98 * sample_rate)
        valley_end = int(1.03 * sample_rate)
        audio[valley_start:valley_end] *= 0.05
        envelope = MODULE.build_energy_envelope(audio, sample_rate)
        left, right, evidence = MODULE.refine_internal_boundary(
            envelope, 0.96, 1.04, 30.0
        )
        self.assertEqual(left, right)
        self.assertIn(evidence["type"], {"waveform-local-valley", "waveform-silence-gap"})


if __name__ == "__main__":
    unittest.main()
