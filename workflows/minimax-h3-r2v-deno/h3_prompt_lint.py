"""MiniMax H3 R2V 공식 6칸 프롬프트를 제출 전에 검사한다."""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from pathlib import Path

# Windows 한글 콘솔(cp949)에서 경고문의 특수문자로 죽지 않도록 출력을 UTF-8로 고정한다.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


FIELDS = (
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
)
TASK_TYPES = {
    "keyframe completion",
    "reference generation",
    "video editing",
    "video continuation",
    "audio reuse",
    "audio reference",
}
FIELD_RE = re.compile(
    rf"(?m)^({'|'.join(map(re.escape, FIELDS))}):[ \t]*$"
)
NEGATIVE_RE = re.compile(
    r"\b(?:no|not|never|without|avoid|exclude|do\s+not|must\s+not|cannot|can't)\b",
    re.IGNORECASE,
)
# 대사(<d>)가 없는 판의 소리 배타 선언(H3 플레이북 「소리 배타 선언」) — 없으면 모델이 엉뚱한 언어의 말을 지어낸다.
EXCLUSIVE_SOUND_RE = re.compile(r"contains only these sounds|no spoken words", re.IGNORECASE)
# 대사 없는 판의 요약·샷 문장에 적힌 말하는 사건 — 배타 선언이 있어도 화면 밖 목소리를 부른다(스위트룸의 덫 결말1, 2026-09-26).
SPEECH_ACT_RE = re.compile(
    r"\b(?:tell|tells|told|telling|say|says|said|saying|ask|asks|asked|asking|reply|replies|replied|"
    r"shout|shouts|shouted|whisper|whispers|whispered|mutter|mutters|muttered|speak|speaks|spoke|speaking|"
    r"yell|yells|yelled|announce|announces|announced|call(?:s|ed)? out)\b",
    re.IGNORECASE,
)


def split_sections(text: str) -> dict[str, str]:
    """정확한 공식 필드 사이의 본문을 이름별로 나눈다."""
    matches = list(FIELD_RE.finditer(text))
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections[match.group(1)] = text[match.end():end].strip()
    return sections


def validate_structure(text: str) -> list[str]:
    """공식 필드의 개수·순서·내용을 검사해 오류 목록을 돌려준다."""
    matches = list(FIELD_RE.finditer(text))
    errors: list[str] = []
    names = [match.group(1) for match in matches]

    if re.search(r"(?m)^integrated_multimodal_description:[ \t]*$", text):
        errors.append(
            "구형 R2V 본문 필드 integrated_multimodal_description 사용 — "
            "detailed_description으로 교체"
        )

    for field in FIELDS:
        count = names.count(field)
        if count != 1:
            errors.append(f"{field}: 필드는 정확히 한 번 필요함 (현재 {count}회)")

    if names != list(FIELDS):
        errors.append("6칸 순서가 공식 순서와 다름: " + " -> ".join(FIELDS))
        return errors

    sections = split_sections(text)
    for match in matches:
        content = sections[match.group(1)]
        if not content:
            errors.append(f"{match.group(1)}: 내용이 비어 있음")

    task_prefix = re.match(r"^\[([^\]]+)\]\s+", sections["summary"])
    if not task_prefix:
        errors.append("summary는 대괄호 과제 선언으로 시작해야 함")
    else:
        task_types = [item.strip() for item in task_prefix.group(1).split("+")]
        unknown = [item for item in task_types if item not in TASK_TYPES]
        if unknown:
            errors.append("summary의 알 수 없는 과제 유형: " + ", ".join(unknown))
        if len(task_types) != len(set(task_types)):
            errors.append("summary의 과제 유형을 중복해서 쓰지 않음")

    detailed = sections["detailed_description"]
    shots = list(re.finditer(r"\[Shot (\d+)\]", detailed))
    numbers = [int(shot.group(1)) for shot in shots]
    if not shots or numbers[0] != 1:
        errors.append("detailed_description은 [Shot 1]로 시작해야 함")
        return errors
    if numbers != list(range(1, len(numbers) + 1)):
        errors.append("Shot 번호는 1부터 빠짐없이 오름차순이어야 함")

    for index, shot in enumerate(shots):
        number = int(shot.group(1))
        end = shots[index + 1].start() if index + 1 < len(shots) else len(detailed)
        body = detailed[shot.end():end]
        has_timestamp = bool(re.match(r"\s*At \d{2}:\d{2}\.\d{3},", body))
        if number == 1 and has_timestamp:
            errors.append("Shot 1에는 시각을 붙이지 않음")
        elif number > 1 and not has_timestamp:
            errors.append(f"Shot {number}에는 At MM:SS.mmm 필요")

    if "<d>" not in detailed.lower() and not EXCLUSIVE_SOUND_RE.search(sections["overall_soundscape"]):
        errors.append(
            "대사(<d>)가 없는 판은 overall_soundscape에 소리 배타 선언 필요 — 'The entire soundtrack contains only "
            "these sounds and nothing else: …' + 'No spoken words in any language, no narration, no voice-over, no "
            "singing.' 없으면 모델이 중국어·영어 말을 지어낸다(H3 플레이북 「소리 배타 선언」)"
        )

    return errors


def quality_warnings(text: str) -> list[str]:
    """필수 금지 여부를 사람이 검토할 중복·부정형·분량 경고를 만든다."""
    warnings: list[str] = []
    instruction_text = re.sub(
        r"<d>.*?</d>", "", text, flags=re.DOTALL | re.IGNORECASE
    )

    for line_number, line in enumerate(instruction_text.splitlines(), start=1):
        terms = [match.group(0) for match in NEGATIVE_RE.finditer(line)]
        if terms:
            warnings.append(
                f"부정형 {line_number}행 ({', '.join(terms)}): "
                "반드시 막아야 하는지 확인"
            )

    sentences = re.split(r"(?<=[.!?])\s+|\n+", instruction_text)
    normalized: list[tuple[str, str]] = []
    for sentence in sentences:
        clean = re.sub(
            r"\[Shot \d+\](?:\s+At\s+\d{2}:\d{2}\.\d{3},)?", "", sentence
        )
        key = re.sub(r"[^a-z0-9가-힣]+", " ", clean.lower()).strip()
        if len(key.split()) >= 5:
            normalized.append((key, clean.strip()))
    counts = Counter(key for key, _ in normalized)
    examples = {key: original for key, original in normalized}
    for key, count in counts.items():
        if count > 1:
            warnings.append(f"반복 문장 {count}회: {examples[key]}")

    sections = split_sections(text)
    detailed = sections.get("detailed_description", "")
    if "<d>" not in detailed.lower():
        spoken = sorted({m.group(0).lower() for field in ("summary", "detailed_description")
                         for m in SPEECH_ACT_RE.finditer(sections.get(field, ""))})
        if spoken:
            warnings.append(
                f"대사(<d>) 없는 판의 요약·샷 문장에 말하는 사건({', '.join(spoken)}): 배타 선언이 있어도 화면 밖 목소리를 "
                "부를 수 있다 — 누가 말했다는 서술 대신 지금 보이는 반응만 쓴다(명세 「소리 두 칸」)"
            )

    english_words = re.findall(r"[A-Za-z]+(?:[-'][A-Za-z]+)*", detailed)
    if detailed and not 350 <= len(english_words) <= 500:
        warnings.append(
            "detailed_description 영어 단어 "
            f"{len(english_words)}개 — 공식 생성형 참고 범위 350~500개"
        )

    return warnings


def main() -> int:
    parser = argparse.ArgumentParser(
        description="MiniMax H3 R2V 공식 6칸 프롬프트 검사"
    )
    parser.add_argument("prompt_file", type=Path, help="UTF-8 프롬프트 파일")
    args = parser.parse_args()

    text = args.prompt_file.read_text(encoding="utf-8")
    errors = validate_structure(text)
    if errors:
        print("FAIL")
        for error in errors:
            print(f"ERROR: {error}")
        return 1

    for warning in quality_warnings(text):
        print(f"WARN: {warning}")
    print("PASS: 공식 R2V 6칸 구조")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
