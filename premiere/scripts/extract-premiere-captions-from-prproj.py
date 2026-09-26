"""저장된 Premiere Pro .prproj에서 caption track의 텍스트와 타이밍을 추출한다.

UXP에 caption 텍스트 읽기 API가 없다(2026-09-17 확인: CaptionTrack은 timing·identity만,
Adobe 공식 "still under construction", FCP XML/OTIO/AAF에도 caption 텍스트 없음).
사용자가 track을 직접 편집한 뒤 "현재 상태가 최종"이라고 확정하면 저장된 .prproj를
직접 파싱해 최종 자막 상태를 UI 없이 읽는 경로다. Premiere 26.5 프로젝트에서 검증됨
(173 cue, 텍스트·타이밍 화면과 1:1 일치, 2026-09-17).

.prproj(26.x)는 gzip으로 압축된 PML 스타일 XML이다. caption item은
CaptionDataClipTrackItem → TrackItem(Start/End ticks) + BlockVector → Block →
FormattedTextData(base64) 구조이고, base64 blob 안에 u32 길이 접두 UTF-8 텍스트가
포함되어 있다(글꼴 이름 같은 포맷 메타데이터 문자열이 섞이므로, 트랙의 모든 item에 공통인 run을 빼고
한글 우선·최장 run으로 판정).

사용법:
  python scripts/extract-premiere-captions-from-prproj.py --project <path.prproj> \
      --track "트랙 이름 또는 부분 일치" [--out <final.srt>] [--json <cues.json>]
"""
import argparse
import base64
import gzip
import hashlib
import json
import re
import struct
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

TICKS_PER_MS = 254_016_000  # 254_016_000_000 ticks/sec / 1000


def tag_of(el):
    # PML 스타일 도트 태그('MZ.TrackName')와 XML namespace('{uri}Name') 둘 다 대응
    return el.tag.split("}")[-1].split(".")[-1]


def load_xml(path: Path) -> str:
    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return raw.decode("utf-8", errors="replace")


def extract_runs(blob: bytes) -> list:
    """blob 내 u32 길이 접두 UTF-8 run을 찾고 중복 겹침을 제거한다(blob 안 순서)."""
    found = []
    n = len(blob)
    for off in range(0, n - 8):
        (length,) = struct.unpack_from("<I", blob, off)
        if length < 2 or length > 4000:
            continue
        start, end = off + 4, off + 4 + length
        if end > n:
            continue
        try:
            text = blob[start:end].decode("utf-8")
        except UnicodeDecodeError:
            continue
        if not all(ch in "\r\n" or 32 <= ord(ch) < 0x10000 for ch in text):
            continue
        found.append((start, length, text))
    cleaned = []
    for start, length, text in found:
        if any(start < s2 + l2 and s2 < start + length for s2, l2, _ in cleaned):
            continue
        cleaned.append((start, length, text))
    return [t for _s, _l, t in sorted(cleaned)]


def pick_texts(runs: list, shared: set) -> list:
    """한 blob의 run 가운데 자막 문구를 고른다.

    포맷 메타데이터 문자열(글꼴 이름 'RixStraightPM'·'LucidaConsole' 등)은 트랙의 모든 item에 똑같이 들어 있으므로
    먼저 뺀다. 그래야 한글이 없는 자막('♪', 짧은 영문)이 더 긴 글꼴 이름에 밀리지 않는다(2026-09-22 실측: '♪' 대신
    'RixStraightPM'이 뽑혔다). 그다음 한글 run이 있으면 그것만 쓰고, 없으면 최장 run을 정본으로 삼는다.
    """
    candidates = [t for t in runs if t not in shared] or runs
    hangul = [t for t in candidates if re.search(r"[\uac00-\ud7a3]", t)]
    if hangul:
        return hangul
    return [max(candidates, key=len)] if candidates else []


def norm(text: str) -> str:
    lines = [ln.strip() for ln in text.replace("\r", "\n").split("\n")]
    return "\n".join(ln for ln in lines if ln)


def fmt_srt_time(ms: float) -> str:
    h, rem = divmod(int(round(ms)), 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, msec = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{msec:03d}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--project", required=True, type=Path)
    ap.add_argument("--track", required=True, help="트랙 이름(정확히) 또는 부분 일치")
    ap.add_argument("--out", type=Path, help="SRT 출력 경로(생략 시 stdout에 SRT)")
    ap.add_argument("--json", type=Path, dest="json_out", help="cue JSON 출력 경로")
    args = ap.parse_args()

    xml_text = load_xml(args.project)
    root = ET.fromstring(xml_text)
    idmap = {}
    for el in root.iter():
        if el.get("ObjectID") and el.get("ObjectID") not in idmap:
            idmap[el.get("ObjectID")] = el

    # 트랙 이름 요소 → 문서 순서상 뒤의 ClipItems가 그 트랙의 item 목록이다
    elements = list(root.iter())
    track_names = [el for el in elements if tag_of(el) == "TrackName" and (el.text or "").strip()]
    wanted = args.track.casefold()
    matches = [el for el in track_names if wanted in (el.text or "").strip().casefold()]
    if not matches:
        print(f"트랙 '{args.track}'을(를) 찾지 못함. 후보: {[ (el.text or '').strip() for el in track_names if '자막' in (el.text or '') or 'KO' in (el.text or '') or 'caption' in (el.text or '').casefold() ]}", file=sys.stderr)
        return 1
    if len(matches) > 1:
        print(f"트랙 이름이 {len(matches)}개 일치해 애매함: {[ (el.text or '').strip() for el in matches ]} — 더 긴 이름으로 지정하세요.", file=sys.stderr)
        return 1
    name_el = matches[0]

    idx = elements.index(name_el)
    clip_items = next((el for el in elements[idx + 1:] if tag_of(el) == "ClipItems"), None)
    if clip_items is None:
        print("트랙 뒤 ClipItems를 찾지 못함 — prproj 포맷 변경 가능성.", file=sys.stderr)
        return 1

    items = sorted(
        (el for el in clip_items.iter() if tag_of(el) == "TrackItem" and el.get("Index") is not None and el.get("ObjectRef")),
        key=lambda el: int(el.get("Index")),
    )

    parsed = []
    for el in items:
        item = idmap.get(el.get("ObjectRef"))
        if item is None:
            print(f"Item ObjectRef {el.get('ObjectRef')}가 객체 저장소에 없음 — 포맷 변경 가능성.", file=sys.stderr)
            return 1
        start_ticks, end_ticks = 0, None
        for sub in item.iter():
            if tag_of(sub) == "TrackItem":
                s, e = sub.findtext("Start"), sub.findtext("End")
                if s is not None:
                    start_ticks = int(s)
                if e is not None:
                    end_ticks = int(e)
        if end_ticks is None:
            print(f"Item {el.get('Index')}에 End ticks 없음.", file=sys.stderr)
            return 1
        blobs = []
        for bv in item.iter():
            if tag_of(bv) != "BlockVectorItem":
                continue
            block = idmap.get(bv.get("ObjectRef"))
            if block is None:
                continue
            for ftd in block.iter():
                if tag_of(ftd) != "FormattedTextData" or (ftd.get("Encoding") or "").lower() != "base64":
                    continue
                blobs.append(extract_runs(base64.b64decode(re.sub(r"\s", "", ftd.text or ""))))
        parsed.append((el, start_ticks, end_ticks, blobs))

    # 모든 item에 똑같이 들어 있는 run = 서식 메타데이터. item이 하나뿐이면 문구와 구분할 수 없어 비워 둔다.
    shared = set.intersection(*({t for runs in blobs for t in runs} for *_rest, blobs in parsed)) if len(parsed) > 1 else set()
    cues = []
    for el, start_ticks, end_ticks, blobs in parsed:
        texts = [t for runs in blobs for t in pick_texts(runs, shared)]
        cues.append({
            "index": int(el.get("Index")) + 1,
            "start_ms": start_ticks / TICKS_PER_MS,
            "end_ms": end_ticks / TICKS_PER_MS,
            "text": norm("\r".join(texts)),
        })

    body = "\n\n".join(
        f"{c['index']}\n{fmt_srt_time(c['start_ms'])} --> {fmt_srt_time(c['end_ms'])}\n{c['text']}"
        for c in cues
    )
    if args.out:
        args.out.write_text(body + "\n", encoding="utf-8")
        print(f"SRT: {args.out} ({len(cues)} cue)")
    else:
        print(body)
    if args.json_out:
        args.json_out.write_text(json.dumps(cues, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"JSON: {args.json_out}")

    empty = sum(1 for c in cues if not c["text"])
    print(f"track: {(name_el.text or '').strip()} | cue {len(cues)}개, 빈 텍스트 {empty}개 | 서식 run 제외 {sorted(shared)}")
    if cues:
        print(f"범위: {fmt_srt_time(cues[0]['start_ms'])} ~ {fmt_srt_time(cues[-1]['end_ms'])}")
    st = args.project.stat()
    print(f"source: {args.project} ({st.st_size} bytes, mtime {st.st_mtime:.0f}, sha256 {hashlib.sha256(args.project.read_bytes()).hexdigest()[:16]}…)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
