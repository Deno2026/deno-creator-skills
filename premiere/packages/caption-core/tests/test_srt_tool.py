#!/usr/bin/env python3
"""Focused regression tests for current-only SRT guardrails."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import shutil
import tempfile
import sys
import unittest
import uuid
from pathlib import Path

TOOLS_ROOT = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS_ROOT))

import srt_tool

TEST_TMP_ROOT = Path(tempfile.gettempdir()) / "deno-caption-core-tests"
TEST_TMP_ROOT.mkdir(parents=True, exist_ok=True)


@contextlib.contextmanager
def workspace_temp_directory():
    path = TEST_TMP_ROOT / f"case-{uuid.uuid4().hex}"
    path.mkdir(parents=True, exist_ok=False)
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def write_srt(path: Path, first_text: str, second_text: str = "다음 내용입니다.") -> None:
    path.write_text(
        "1\n"
        "00:00:00,200 --> 00:00:05,100\n"
        f"{first_text}\n\n"
        "2\n"
        "00:00:16,000 --> 00:00:18,000\n"
        f"{second_text}\n",
        encoding="utf-8",
    )


class SemanticLintTests(unittest.TestCase):
    def test_rejects_wrong_opening_channel_speaker(self) -> None:
        with workspace_temp_directory() as directory:
            path = Path(directory) / "wrong.srt"
            write_srt(path, "안녕하세요, 진호입니다. 이번 영상은 테스트입니다.")
            payload = srt_tool.semantic_lint_payload(path)

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["issues"][0]["type"], "opening_speaker_mismatch")
        self.assertEqual(payload["issues"][0]["speaker"], "진호")
        self.assertEqual(payload["issues"][0]["expected"], "Deno")

    def test_accepts_deno_opening_channel_speaker(self) -> None:
        with workspace_temp_directory() as directory:
            path = Path(directory) / "correct.srt"
            write_srt(path, "안녕하세요, Deno입니다. 이번 영상은 테스트입니다.")
            payload = srt_tool.semantic_lint_payload(path)

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["opening_self_introductions"][0]["speaker"], "Deno")

    def test_does_not_treat_a_later_quoted_name_as_the_channel_intro(self) -> None:
        with workspace_temp_directory() as directory:
            path = Path(directory) / "later-name.srt"
            write_srt(path, "이번 영상의 주제를 바로 설명하겠습니다.", "안녕하세요, 진호입니다.")
            payload = srt_tool.semantic_lint_payload(path)

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["opening_self_introductions"], [])


class PremiereFormattingTests(unittest.TestCase):
    def test_writes_bom_crlf_and_preserves_every_cue_exactly(self) -> None:
        with workspace_temp_directory() as directory:
            root = Path(directory)
            source = root / "review.srt"
            output = root / "review_premiere.srt"
            report = root / "premiere_report.json"
            source_bytes = (
                "1\r\n"
                "00:00:00,200 --> 00:00:05,100 position:10%\r\n"
                "안녕하세요, Deno입니다.\n"
                "두 번째 줄입니다.\r\n\r\n"
                "2\r"
                "00:00:16,000 --> 00:00:18,000\r"
                "다음 내용입니다.\r\n\r\n"
            ).encode("utf-8")
            source.write_bytes(source_bytes)

            with contextlib.redirect_stdout(io.StringIO()):
                result = srt_tool.main(
                    ["premiere", str(source), str(output), "--report", str(report)]
                )

            payload = json.loads(report.read_text(encoding="utf-8"))
            output_bytes = output.read_bytes()
            expected = (
                b"\xef\xbb\xbf"
                + source_bytes.decode("utf-8")
                .replace("\r\n", "\n")
                .replace("\r", "\n")
                .rstrip("\n")
                .replace("\n", "\r\n")
                .encode("utf-8")
                + b"\r\n"
            )

            self.assertEqual(result, 0)
            self.assertEqual(output_bytes, expected)
            self.assertTrue(output_bytes.startswith(b"\xef\xbb\xbf"))
            self.assertTrue(output_bytes.endswith(b"\r\n"))
            self.assertFalse(output_bytes.endswith(b"\r\n\r\n"))
            self.assertNotIn(b"\r", output_bytes[3:].replace(b"\r\n", b""))
            self.assertNotIn(b"\n", output_bytes[3:].replace(b"\r\n", b""))
            self.assertEqual(srt_tool.parse_srt(source)[0], srt_tool.parse_srt(output)[0])
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["input_sha256"], hashlib.sha256(source_bytes).hexdigest())
            self.assertEqual(payload["output_sha256"], hashlib.sha256(output_bytes).hexdigest())
            self.assertEqual(payload["cue_count"], 2)
            self.assertTrue(payload["utf8Bom"])
            self.assertEqual(payload["lineEnding"], "CRLF")
            self.assertTrue(payload["final_crlf_exactly_one"])
            self.assertTrue(payload["text_preserved"])
            self.assertTrue(payload["structure_preserved"])

    def test_rejects_html_or_style_tags_without_writing_output(self) -> None:
        with workspace_temp_directory() as directory:
            root = Path(directory)
            for filename, caption in (
                ("html.srt", "<i>태그가 있는 자막</i>"),
                ("style.srt", r"{\an8}위치 태그가 있는 자막"),
            ):
                source = root / filename
                output = root / f"{filename}.output.srt"
                write_srt(source, caption)

                payload = srt_tool.premiere_payload(source, output)

                self.assertFalse(payload["ok"])
                self.assertFalse(output.exists())
                self.assertTrue(
                    any("HTML/style tag" in issue for issue in payload["issues"])
                )

    def test_rejects_invalid_srt_without_writing_output(self) -> None:
        with workspace_temp_directory() as directory:
            root = Path(directory)
            source = root / "invalid.srt"
            output = root / "invalid_premiere.srt"
            source.write_text(
                "1\n00:00:05,000 --> 00:00:04,000\n끝이 시작보다 빠릅니다.\n",
                encoding="utf-8",
            )

            payload = srt_tool.premiere_payload(source, output)

            self.assertFalse(payload["ok"])
            self.assertFalse(output.exists())
            self.assertTrue(any("end time" in issue for issue in payload["issues"]))


class ProductionCaptionLockTests(unittest.TestCase):
    def test_source_lock_accepts_only_the_canonical_production_caption_directory(self) -> None:
        with workspace_temp_directory() as directory:
            production_root = Path(directory)
            captions = production_root / "productions" / "demo-video" / "captions"
            captions.mkdir(parents=True)
            final_ko = captions / "final-ko.srt"
            clean_ko = captions / "clean-ko.srt"
            reviewed_en = captions / "reviewed-en.srt"
            review = captions / "english-review.md"
            write_srt(final_ko, "안녕하세요, Deno입니다.")
            write_srt(clean_ko, "안녕하세요, Deno입니다.")
            write_srt(reviewed_en, "Hello, this is Deno.", "This is the next sentence.")
            review.write_text("# English review\n\nPASS\n", encoding="utf-8")

            previous = os.environ.get("DENO_PRODUCTION_ROOT")
            os.environ["DENO_PRODUCTION_ROOT"] = str(production_root)
            try:
                payload = srt_tool.source_lock_payload(
                    final_ko,
                    clean_ko,
                    reviewed_en,
                    "demo-video",
                    review,
                )
            finally:
                if previous is None:
                    os.environ.pop("DENO_PRODUCTION_ROOT", None)
                else:
                    os.environ["DENO_PRODUCTION_ROOT"] = previous

            self.assertTrue(payload["ok"])
            self.assertEqual(
                payload["files"]["final_korean"]["path"],
                "productions/demo-video/captions/final-ko.srt",
            )
            self.assertEqual(
                payload["english_review"]["path"],
                "productions/demo-video/captions/english-review.md",
            )


if __name__ == "__main__":
    unittest.main()
