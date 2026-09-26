#!/usr/bin/env python3
"""Sentence-level editorial cuts: remove restarts, abandoned attempts and repeated speech.

Subcommands (run with the repo `.venv-caption-qwen` Python):
  words     Force-align verbatim text to the timeline audio and number every word.
            Text source: --srt (Premiere captions), --words (timeline words JSON, e.g. a
            mapped Premiere clip transcript) or --asr (local Qwen3-ASR, keeps restarts).
  plan      Turn agent-authored word-range removals into frame cuts whose edges sit in real
            silence; optionally union them with waveform-only silence cuts.
  preview   Render the planned edit from the timeline audio and list every join.
  check     Print expected vs re-transcribed text around every join of a preview.
  manifest  Split the planned cuts at existing V1/A1 clip boundaries and emit the
            direct-razor manifest used by the Premiere appliers.
  verify    Compare post-edit V1/A1 clips with the source ranges the plan must keep.

Whisper large-v3 normalises restarts away, so it cannot tell a kept attempt from a
removed one; the word timeline must come from verbatim text (see audio-finishing.md).
"""
from __future__ import annotations

import argparse
import bisect
import json
import os
import re
import sys
import unicodedata
from pathlib import Path

import numpy as np
import soundfile as sf

SILENCE_DB = -52.0     # 10ms RMS below this is silence (noise floor ~ -70, speech ~ -37..-27)
HOP = 0.005
WIN = 0.010
MIN_RUN = 0.02         # shortest silent run that counts as a gap
EDGE = 0.015           # keep cut edges this far inside a gap
LEAD = 0.05            # breath of silence kept before the next kept word
MAX_PAUSE = 0.6        # longest pause kept at a join
TICKS_PER_SECOND = 254016000000
AI_PARTICLES = {"로", "를", "가", "라서", "로는", "로도"}
# 모델은 환경변수(로컬 폴더)나 허깅페이스 ID(첫 실행 때 내려받음). 2026-09-27 허깅페이스 공개 확인.
DEFAULT_ALIGNER = os.environ.get("DENO_QWEN_ALIGNER_MODEL", "Qwen/Qwen3-ForcedAligner-0.6B")
DEFAULT_ASR = os.environ.get("DENO_QWEN_ASR_MODEL", "Qwen/Qwen3-ASR-1.7B")


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding="utf-8")


def read_audio(path):
    audio, sr = sf.read(path, dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    return audio, sr


class Envelope:
    """10ms RMS loudness in dB on a 5ms hop."""

    def __init__(self, audio, sr):
        self.duration = len(audio) / sr
        width, hop = int(WIN * sr), int(HOP * sr)
        frames = np.lib.stride_tricks.sliding_window_view(audio, width)[::hop]
        self.db = 20 * np.log10(np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1)) + 1e-9)
        self.centers = np.arange(len(self.db)) * HOP + WIN / 2

    def index(self, t):
        return int(np.clip(round((t - WIN / 2) / HOP), 0, len(self.db) - 1))

    def edge_db(self, t, radius=0.008):
        return float(self.db[self.index(t - radius):self.index(t + radius) + 1].max())

    def silent_runs(self, lo, hi):
        i0, i1 = self.index(max(0.0, lo)), self.index(min(self.duration, hi))
        quiet = self.db[i0:i1 + 1] < SILENCE_DB
        runs, k = [], 0
        while k < len(quiet):
            if quiet[k]:
                m = k
                while m < len(quiet) and quiet[m]:
                    m += 1
                t0 = self.centers[i0 + k] - HOP / 2
                t1 = self.centers[i0 + m - 1] + HOP / 2
                if t1 - t0 >= MIN_RUN:
                    runs.append((float(t0), float(t1)))
                k = m
            else:
                k += 1
        return runs


# ---------------------------------------------------------------- words

def _keep(ch):
    return unicodedata.category(ch)[0] in "LN"


def _spoken(words, restore_ai):
    return [("에이아이" + w) if restore_ai and w in AI_PARTICLES else w for w in words]


def _srt_seconds(stamp):
    h, m, rest = stamp.strip().split(":")
    s, ms = rest.split(",")
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000


def chunks_from_srt(path):
    chunks = []
    for block in re.split(r"\n\s*\n", Path(path).read_text(encoding="utf-8-sig").strip()):
        lines = block.splitlines()
        if len(lines) < 3 or "-->" not in lines[1]:
            continue
        start, end = (_srt_seconds(x) for x in lines[1].split("-->"))
        text = re.sub(r"\s+", " ", " ".join(lines[2:]).replace("\u3000", " ")).strip()
        if text:
            chunks.append({"start": start, "end": end, "text": text})
    return chunks


def chunks_from_words(path, max_gap=0.6, max_span=20.0):
    data = load_json(path)
    items = data.get("words") or data.get("timelineWords", {}).get("words") or data.get("transcript", {}).get("words") or []
    words = []
    for w in items:
        start = w.get("timelineStartSeconds", w.get("startSeconds", w.get("start")))
        end = w.get("timelineEndSeconds", w.get("endSeconds", w.get("end")))
        text = re.sub(r"\s+", " ", str(w.get("text", "")).replace("\u3000", " ")).strip()
        if text and start is not None and end is not None:
            words.append((float(start), float(end), text))
    words.sort()
    chunks, cur = [], []
    for start, end, text in words:
        if cur and (start - cur[-1][1] > max_gap or end - cur[0][0] > max_span):
            chunks.append(cur)
            cur = []
        cur.append((start, end, text))
    if cur:
        chunks.append(cur)
    return [{"start": c[0][0], "end": c[-1][1], "text": " ".join(t for _, _, t in c)} for c in chunks]


def speech_chunks(env, min_split_gap=0.4, max_span=25.0):
    """Split the timeline at silences so each ASR chunk holds whole phrases."""
    runs = [r for r in env.silent_runs(0.0, env.duration) if r[1] - r[0] >= min_split_gap]
    cuts = [0.0] + [(a + b) / 2 for a, b in runs] + [env.duration]
    spans = []
    for a, b in zip(cuts, cuts[1:]):
        if env.db[env.index(a):env.index(b) + 1].max() < SILENCE_DB:
            continue
        spans.append([a, b])
    merged = []
    for a, b in spans:
        if merged and b - merged[-1][0] <= max_span and a - merged[-1][1] < 1e-6:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    out = []
    for a, b in merged:
        while b - a > max_span:
            lo, hi = env.index(a + max_span * 0.6), env.index(a + max_span)
            split = float(env.centers[lo + int(np.argmin(env.db[lo:hi + 1]))])
            out.append([a, split])
            a = split
        out.append([a, b])
    return out


def transcribe_chunks(audio, sr, spans, model_path, language):
    import torch
    from qwen_asr import Qwen3ASRModel

    model = Qwen3ASRModel.from_pretrained(
        model_path, dtype=torch.bfloat16, device_map="cuda:0",
        max_inference_batch_size=8, max_new_tokens=768,
    )
    clips = [(np.ascontiguousarray(audio[int(a * sr):int(b * sr)]), sr) for a, b in spans]
    results = model.transcribe(audio=clips, language=language)
    del model
    torch.cuda.empty_cache()
    return [{"start": a, "end": b, "text": re.sub(r"\s+", " ", r.text).strip()}
            for (a, b), r in zip(spans, results) if r.text.strip()]


def align_chunks(audio, sr, chunks, model_path, language, pad, restore_ai):
    import torch
    from qwen_asr import Qwen3ForcedAligner

    model = Qwen3ForcedAligner.from_pretrained(
        model_path, dtype=torch.bfloat16, device_map="cuda:0", local_files_only=True,
    )
    duration = len(audio) / sr
    out, g = [], 0
    for n, chunk in enumerate(chunks):
        words = chunk["text"].split(" ")
        spoken = _spoken(words, restore_ai)
        s = max(0.0, chunk["start"] - pad)
        e = min(duration, chunk["end"] + pad)
        result = model.align(
            audio=(np.ascontiguousarray(audio[int(s * sr):int(e * sr)]), sr),
            text=" ".join(spoken), language=language,
        )[0]
        owner = []
        for wi, w in enumerate(spoken):
            owner += [wi] * sum(1 for ch in w if _keep(ch))
        spans = [[None, None] for _ in spoken]
        pos = 0
        for item in result.items:
            k = sum(1 for ch in item.text if _keep(ch))
            if k == 0 or pos >= len(owner):
                continue
            wi = owner[pos]
            pos += k
            t0, t1 = s + float(item.start_time), s + float(item.end_time)
            spans[wi][0] = t0 if spans[wi][0] is None else min(spans[wi][0], t0)
            spans[wi][1] = t1 if spans[wi][1] is None else max(spans[wi][1], t1)
        prev_end = chunk["start"]
        aligned = []
        for wi, w in enumerate(words):
            start, end = spans[wi]
            if start is None:  # keep the index stable even if the aligner skipped the word
                start = end = prev_end
            aligned.append({"g": g, "text": w, "spoken": spoken[wi], "start": round(start, 3), "end": round(end, 3)})
            prev_end = end
            g += 1
        out.append({"n": n, "start": chunk["start"], "end": chunk["end"], "text": chunk["text"],
                    "alignedChars": pos, "expectedChars": len(owner), "words": aligned})
    del model
    torch.cuda.empty_cache()
    return out


def cmd_words(args):
    audio, sr = read_audio(args.audio)
    if args.srt:
        source, chunks = "srt", chunks_from_srt(args.srt)
    elif args.words:
        source, chunks = "words", chunks_from_words(args.words)
    else:
        source = "asr"
        chunks = transcribe_chunks(audio, sr, speech_chunks(Envelope(audio, sr)), args.asr_model, args.language)
    aligned = align_chunks(audio, sr, chunks, args.aligner_model, args.language, args.pad, args.restore_ai_particles)
    words = [w for c in aligned for w in c["words"]]
    save_json(args.out, {"schemaVersion": 1, "source": source, "audio": str(args.audio), "chunks": aligned})
    view = []
    for c in aligned:
        t = c["start"]
        view.append(f"#{c['n']} {int(t // 60)}:{t % 60:04.1f} | " + " ".join(f"{w['g']}:{w['text']}" for w in c["words"]))
    Path(args.view).write_text("\n".join(view) + "\n", encoding="utf-8")
    mismatch = sum(1 for c in aligned if c["alignedChars"] != c["expectedChars"])
    print(json.dumps({"out": str(args.out), "view": str(args.view), "source": source,
                      "chunks": len(aligned), "words": len(words), "charMismatchChunks": mismatch}, ensure_ascii=False))


# ---------------------------------------------------------------- plan

def flat_words(data):
    chunks = data.get("chunks") or data.get("cues") or []
    return {w["g"]: w for c in chunks for w in c["words"]}


def _grid(lo, hi, fps):
    f0 = int(np.ceil(lo * fps - 1e-9))
    f1 = int(np.floor(hi * fps + 1e-9))
    return list(range(f0, f1 + 1))


def plan_cuts(words, removals, env, fps=30):
    """Place each removal [i..j] between the pause before word i and the pause before word j+1."""
    spf = 1 / fps

    def gap_before(prev_end, start):
        lo = (min(prev_end, start) - 0.15) if prev_end is not None else max(0.0, start - 0.6)
        runs = env.silent_runs(lo, start + 0.15)
        return min(runs, key=lambda r: abs(r[1] - start)) if runs else None

    def quietest(lo, hi):
        frames = _grid(lo, hi, fps) or [round((lo + hi) / 2 * fps)]
        return min(frames, key=lambda f: env.edge_db(f * spf))

    n_words = len(words)
    cuts = []
    for n, (i, j, why) in enumerate(removals):
        if i not in words or j not in words or i > j:
            raise ValueError(f"removal {n} [{i},{j}] is outside the word list")
        left, right, flags = words.get(i - 1), words.get(j + 1), []
        gi = gap_before(left["end"] if left else None, words[i]["start"])
        gr = gap_before(words[j]["end"], right["start"]) if right else None
        if right is None:
            end = round(env.duration * fps)
        elif gr:
            frames = _grid(gr[0] + EDGE, gr[1] - EDGE, fps)
            end = min(frames, key=lambda f: abs(f * spf - (gr[1] - LEAD))) if frames else None
            if end is None:
                flags.append("E:gap<frame")
                end = quietest(gr[0] - 0.02, gr[1] + 0.01)
        else:
            flags.append("E:no-gap")
            end = quietest(words[j]["end"] - 0.06, right["start"] + 0.06)
        lead = (gr[1] - end * spf) if gr else 0.0
        if gi:
            target = gi[0] + max(0.0, min(gi[1] - gi[0], MAX_PAUSE) - max(lead, 0.0))
            frames = _grid(gi[0] + EDGE, gi[1] - EDGE, fps)
            start = min(frames, key=lambda f: abs(f * spf - target)) if frames else None
            if start is None:
                flags.append("S:gap<frame")
                start = quietest(gi[0] - 0.01, gi[1] + 0.02)
        elif left is None:
            start = 0
        else:
            flags.append("S:no-gap")
            start = quietest(left["end"] - 0.06, words[i]["start"] + 0.06)
        if end <= start:
            flags.append("EMPTY")
        cuts.append({
            "n": n, "words": [i, j], "why": why, "startFrame": int(start), "endFrame": int(end),
            "startSeconds": round(start * spf, 3), "endSeconds": round(end * spf, 3),
            "removeSeconds": round((end - start) * spf, 3),
            "startEdgeDb": round(env.edge_db(start * spf), 1), "endEdgeDb": round(env.edge_db(end * spf), 1),
            "pauseBefore": round(gi[1] - gi[0], 3) if gi else 0.0,
            "joinPause": round(((start * spf - gi[0]) if gi else 0.0) + lead, 3),
            "flags": flags,
            "left": " ".join(words[k]["text"] for k in range(max(0, i - 3), i) if k in words),
            "removed": " ".join(words[k]["text"] for k in range(i, j + 1)),
            "right": " ".join(words[k]["text"] for k in range(j + 1, min(n_words, j + 4)) if k in words),
        })
    for a, b in zip(cuts, cuts[1:]):
        if a["endFrame"] > b["startFrame"]:
            a["flags"].append("OVERLAP_NEXT")
            b["flags"].append("OVERLAP_PREV")
    return cuts


def combine_cuts(editorial, waveform):
    """Union editorial and waveform-only frame ranges; touching ranges merge."""
    ranges = [(c["startFrame"], c["endFrame"], "editorial", c.get("why", "")) for c in editorial if c["endFrame"] > c["startFrame"]]
    ranges += [(int(c["startFrame"]), int(c["endFrame"]), "waveform", c.get("airTier", "")) for c in waveform]
    ranges.sort()
    merged = []
    for s, e, kind, why in ranges:
        if merged and s <= merged[-1]["endFrame"]:
            last = merged[-1]
            last["endFrame"] = max(last["endFrame"], e)
            if kind not in last["sources"]:
                last["sources"].append(kind)
            if why:
                last["reasons"].append(why)
        else:
            merged.append({"startFrame": s, "endFrame": e, "sources": [kind], "reasons": [why] if why else []})
    return merged


def cmd_plan(args):
    words = flat_words(load_json(args.words))
    removals = load_json(args.removals)
    audio, sr = read_audio(args.audio)
    env = Envelope(audio, sr)
    editorial = plan_cuts(words, removals, env, args.fps)
    waveform = load_json(args.waveform_cuts).get("cuts", []) if args.waveform_cuts else []
    combined = combine_cuts(editorial, waveform)
    flagged = [c["n"] for c in editorial if c["flags"] or max(c["startEdgeDb"], c["endEdgeDb"]) >= SILENCE_DB]
    save_json(args.out, {"schemaVersion": 1, "fps": args.fps, "silenceDb": SILENCE_DB, "audio": str(args.audio),
                         "editorialCuts": editorial, "waveformCutCount": len(waveform), "cuts": combined, "flagged": flagged})
    remove_frames = sum(c["endFrame"] - c["startFrame"] for c in combined)
    print(json.dumps({"out": str(args.out), "editorialCuts": len(editorial), "waveformCuts": len(waveform),
                      "combinedCuts": len(combined), "removeSeconds": round(remove_frames / args.fps, 3),
                      "flagged": len(flagged)}, ensure_ascii=False))
    for c in editorial:
        if c["n"] in flagged:
            print(f"  #{c['n']} {c['words']} edge {c['startEdgeDb']}/{c['endEdgeDb']}dB {c['flags']} | "
                  f"{c['left']} [ {c['removed']} ] {c['right']}")


# ---------------------------------------------------------------- preview / check

def preview(plan, audio, sr, words=None):
    spf = 1 / plan["fps"]
    removed = set()
    for c in plan.get("editorialCuts", []):
        removed.update(range(c["words"][0], c["words"][1] + 1))
    ordered = sorted(words.values(), key=lambda w: w["g"]) if words else []
    kept = [w for w in ordered if w["g"] not in removed]
    keep, joins, t, out_t = [], [], 0.0, 0.0
    for n, c in enumerate(plan["cuts"]):
        s, e = c["startFrame"] * spf, c["endFrame"] * spf
        keep.append((t, s))
        out_t += s - t
        left = [w["text"] for w in kept if w["end"] <= s + 0.05][-3:]
        right = [w["text"] for w in kept if w["start"] >= e - 0.05][:3]
        joins.append({"n": n, "editedSeconds": round(out_t, 3), "sources": c["sources"],
                      "left": " ".join(left), "right": " ".join(right)})
        t = e
    keep.append((t, len(audio) / sr))
    pieces = [audio[int(round(a * sr)):int(round(b * sr))] for a, b in keep if b > a]
    return (np.concatenate(pieces) if pieces else audio[:0]), joins


def cmd_preview(args):
    plan = load_json(args.plan)
    audio, sr = read_audio(args.audio)
    words = flat_words(load_json(args.words)) if args.words else None
    edited, joins = preview(plan, audio, sr, words)
    sf.write(args.out_audio, edited, sr)
    save_json(args.out_joins, joins)
    print(json.dumps({"outAudio": str(args.out_audio), "seconds": round(len(edited) / sr, 3), "joins": len(joins)}))


def cmd_check(args):
    data = load_json(args.whisper)
    heard = data.get("words") or [w for s in data.get("segments", []) for w in s.get("words", [])]

    def at(w, key):
        return w.get(key + "Seconds", w.get(key))

    for j in load_json(args.joins):
        if args.editorial_only and "editorial" not in j["sources"]:
            continue
        t = j["editedSeconds"]
        before = " ".join(w["text"].strip() for w in heard if t - args.window <= at(w, "start") < t)
        after = " ".join(w["text"].strip() for w in heard if t <= at(w, "start") < t + args.window)
        print(f"{j['n']:>4} {int(t // 60)}:{t % 60:04.1f} 기대: {j['left']} ▮ {j['right']}\n"
              f"             들림: {before} ▮ {after}")


# ---------------------------------------------------------------- manifest / verify

def _frames(seconds, fps):
    return round(seconds * fps)


def clip_bounds(track, fps):
    return [(_frames(c["startSeconds"], fps), _frames(c["endSeconds"], fps)) for c in track["clips"]]


def split_at_clips(cuts, bounds):
    edges = sorted({s for s, _ in bounds} | {e for _, e in bounds})
    out = []
    for c in cuts:
        points = [c["startFrame"]] + [b for b in edges if c["startFrame"] < b < c["endFrame"]] + [c["endFrame"]]
        for part, (a, b) in enumerate(zip(points, points[1:]), start=1):
            out.append({**c, "startFrame": a, "endFrame": b, "part": f"{part}/{len(points) - 1}"})
    return out


def build_manifest(structure, plan, project_name, fps, video_track=0, audio_track=0, clip_name=None):
    vt, at = structure["videoTracks"][video_track], structure["audioTracks"][audio_track]
    vb, ab = clip_bounds(vt, fps), clip_bounds(at, fps)
    if vb != ab:
        raise ValueError("V/A clip boundaries differ; relink or align the target tracks first")
    for (s0, e0), (s1, e1) in zip(vb, vb[1:]):
        if e0 != s1:
            raise ValueError(f"target track has a gap or overlap at frame {e0}-{s1}")
    duration = _frames(structure["durationSeconds"], fps)
    names = sorted({c["name"] for c in vt["clips"]})
    if clip_name:
        names = [clip_name]
    parts = split_at_clips(plan["cuts"], vb)
    cuts = [{"index": k, "startFrame": c["startFrame"], "endFrame": c["endFrame"],
             "removeFrames": c["endFrame"] - c["startFrame"], "type": "editorial_repeat",
             "sourceTypes": c["sources"], "part": c["part"],
             "reason": "; ".join(dict.fromkeys(r for r in c["reasons"] if r))[:300],
             "waveformSnapped": True} for k, c in enumerate(parts) if c["endFrame"] > c["startFrame"]]
    remove = sum(c["removeFrames"] for c in cuts)
    return {
        "schemaVersion": 1, "mode": "semantic-editorial", "writeReady": True,
        "projectName": project_name, "sequenceName": structure["name"], "sequenceId": structure["id"],
        "sequenceDurationSeconds": structure["durationSeconds"],
        "timing": {"fps": fps, "ticksPerFrame": str(round(TICKS_PER_SECOND / fps))},
        "timecodeDisplay": {"nominalFps": round(fps), "dropFrame": False},
        "targetTracks": [f"V{video_track + 1}", f"A{audio_track + 1}"], "targetClipNames": names,
        "candidatePeakAudit": {
            "energyMode": "rms-10ms", "bridgeSilenceGapSeconds": 0, "suspiciousCutCount": 0,
            "silenceThresholdDb": SILENCE_DB, "flaggedEditorialCuts": plan.get("flagged", []),
            "method": "verbatim words force-aligned with Qwen3-ForcedAligner; edges snapped into the silent run before removed and kept onsets",
        },
        "waveformSnapEvidence": {"integerFrameBoundaries": True, "allBoundariesSnapped": True,
                                 "planCutCount": len(plan["cuts"]), "subCutCount": len(cuts)},
        "summary": {"planCutCount": len(plan["cuts"]), "subCutCount": len(cuts), "removeFrames": remove,
                    "expectedDurationAfterFrames": duration - remove},
        "cutCount": len(cuts), "cuts": cuts,
    }


def cmd_manifest(args):
    manifest = build_manifest(load_json(args.structure), load_json(args.plan), args.project_name, args.fps,
                              args.video_track, args.audio_track, args.clip_name)
    save_json(args.out, manifest)
    s = manifest["summary"]
    print(json.dumps({"out": str(args.out), **s, "expectedDurationAfterSeconds": round(s["expectedDurationAfterFrames"] / args.fps, 3)}))


def expected_ranges(track, cuts, fps):
    out = []
    for c in track["clips"]:
        s, e, src = _frames(c["startSeconds"], fps), _frames(c["endSeconds"], fps), _frames(c["inPointSeconds"], fps)
        pieces = [(s, e)]
        for a, b in cuts:
            nxt = []
            for p, q in pieces:
                if b <= p or a >= q:
                    nxt.append((p, q))
                    continue
                if p < a:
                    nxt.append((p, a))
                if b < q:
                    nxt.append((b, q))
            pieces = nxt
        out += [(src + (p - s), src + (q - s)) for p, q in pieces if q > p]
    return out


def live_ranges(track, fps):
    t, gaps, segs = 0, 0, []
    for c in track["clips"]:
        s, e = _frames(c["startSeconds"], fps), _frames(c["endSeconds"], fps)
        if s != t:
            gaps += 1
        t = e
        segs.append((_frames(c["inPointSeconds"], fps), _frames(c["outPointSeconds"], fps)))
    return segs, gaps, t


def verify(before, after, manifest, video_track=0, audio_track=0):
    fps = manifest["timing"]["fps"]
    cuts = sorted((c["startFrame"], c["endFrame"]) for c in manifest["cuts"])
    report, ok = {}, True
    for kind, index in (("videoTracks", video_track), ("audioTracks", audio_track)):
        exp = expected_ranges(before[kind][index], cuts, fps)
        got, gaps, end = live_ranges(after[kind][index], fps)
        mismatch = [i for i, (x, y) in enumerate(zip(exp, got)) if x != y]
        report[kind] = {"expected": len(exp), "live": len(got), "gaps": gaps, "endFrame": end,
                        "mismatch": len(mismatch) + abs(len(exp) - len(got)), "firstMismatch": mismatch[:3]}
        ok &= len(exp) == len(got) and not mismatch and gaps == 0
        ok &= end == manifest["summary"]["expectedDurationAfterFrames"]
    report["ok"] = bool(ok)
    return report


def cmd_verify(args):
    report = verify(load_json(args.before), load_json(args.after), load_json(args.manifest), args.video_track, args.audio_track)
    print(json.dumps(report, ensure_ascii=False, indent=1))
    print("RESULT", "PASS" if report["ok"] else "FAIL")
    return 0 if report["ok"] else 1


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    w = sub.add_parser("words")
    w.add_argument("--audio", required=True, help="timeline dialogue WAV (e.g. premiere:transcribe-timeline --keep-audio)")
    src = w.add_mutually_exclusive_group(required=True)
    src.add_argument("--srt")
    src.add_argument("--words")
    src.add_argument("--asr", action="store_true")
    w.add_argument("--out", required=True)
    w.add_argument("--view", required=True)
    w.add_argument("--aligner-model", default=DEFAULT_ALIGNER)
    w.add_argument("--asr-model", default=DEFAULT_ASR)
    w.add_argument("--language", default="Korean")
    w.add_argument("--pad", type=float, default=0.15)
    w.add_argument("--restore-ai-particles", action="store_true",
                   help="Premiere Korean STT drops a spoken 'AI' before particles; restore it for alignment only")
    pl = sub.add_parser("plan")
    pl.add_argument("--words", required=True)
    pl.add_argument("--removals", required=True, help="agent-authored [[firstWord,lastWord,reason],...]")
    pl.add_argument("--audio", required=True)
    pl.add_argument("--out", required=True)
    pl.add_argument("--waveform-cuts", help="premiere:propose-waveform-only-cuts output to union with")
    pl.add_argument("--fps", type=float, default=30)
    pv = sub.add_parser("preview")
    pv.add_argument("--plan", required=True)
    pv.add_argument("--audio", required=True)
    pv.add_argument("--words")
    pv.add_argument("--out-audio", required=True)
    pv.add_argument("--out-joins", required=True)
    ck = sub.add_parser("check")
    ck.add_argument("--joins", required=True)
    ck.add_argument("--whisper", required=True, help="transcribe-premiere-audio.py output for the preview")
    ck.add_argument("--window", type=float, default=2.2)
    ck.add_argument("--editorial-only", action="store_true")
    mf = sub.add_parser("manifest")
    mf.add_argument("--structure", required=True, help="get_sequence_structure JSON read before the edit")
    mf.add_argument("--plan", required=True)
    mf.add_argument("--project-name", required=True)
    mf.add_argument("--out", required=True)
    mf.add_argument("--fps", type=float, default=30)
    mf.add_argument("--video-track", type=int, default=0)
    mf.add_argument("--audio-track", type=int, default=0)
    mf.add_argument("--clip-name")
    vf = sub.add_parser("verify")
    vf.add_argument("--before", required=True)
    vf.add_argument("--after", required=True)
    vf.add_argument("--manifest", required=True)
    vf.add_argument("--video-track", type=int, default=0)
    vf.add_argument("--audio-track", type=int, default=0)
    args = p.parse_args(argv)
    handler = {"words": cmd_words, "plan": cmd_plan, "preview": cmd_preview, "check": cmd_check,
               "manifest": cmd_manifest, "verify": cmd_verify}[args.cmd]
    return handler(args) or 0


if __name__ == "__main__":
    sys.exit(main())
