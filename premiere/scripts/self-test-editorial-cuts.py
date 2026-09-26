#!/usr/bin/env python3
"""Offline self-test for scripts/editorial_cuts.py (synthetic audio, no Premiere, no models)."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import editorial_cuts as ec  # noqa: E402

SR = 16000
FPS = 30
SPF = 1 / FPS
passed = 0


def check(name, condition, detail=""):
    global passed
    if not condition:
        raise SystemExit(f"FAIL {name} {detail}")
    passed += 1
    print(f"ok {passed} - {name}")


def synth(words, duration):
    """Room tone at about -70 dB with a -30 dB tone burst per word."""
    rng = np.random.default_rng(7)
    audio = (rng.standard_normal(int(duration * SR)) * 10 ** (-70 / 20)).astype(np.float32)
    for start, end in words:
        t = np.arange(int((end - start) * SR)) / SR
        audio[int(start * SR):int(start * SR) + len(t)] += (np.sin(2 * np.pi * 220 * t) * 10 ** (-27 / 20)).astype(np.float32)
    return audio


# w1 is spoken straight after w0? no: 0.5s pause before w1; w2 is glued to w1 (20 ms gap).
TIMES = [(0.50, 0.90), (1.40, 1.80), (1.82, 2.20), (2.80, 3.20), (3.60, 4.00)]
WORDS = {g: {"g": g, "text": f"w{g}", "start": s, "end": e} for g, (s, e) in enumerate(TIMES)}
env = ec.Envelope(synth(TIMES, 5.0), SR)

cut = ec.plan_cuts(WORDS, [[1, 2, "restart"]], env, FPS)[0]
s, e = cut["startFrame"] * SPF, cut["endFrame"] * SPF
check("cut start sits in the pause before the removed word", 0.90 + ec.EDGE - 1e-9 <= s <= 1.40 - ec.EDGE + 1e-9, cut)
check("cut end sits in the pause before the next kept word", 2.20 + ec.EDGE - 1e-9 <= e <= 2.80 - ec.EDGE + 1e-9, cut)
check("both edges are silent", max(cut["startEdgeDb"], cut["endEdgeDb"]) < ec.SILENCE_DB, cut)
check("join keeps the original pause length", abs(cut["joinPause"] - 0.5) <= SPF + 0.02, cut["joinPause"])
check("clean cut has no flags", cut["flags"] == [], cut["flags"])

glued = ec.plan_cuts(WORDS, [[2, 2, "stutter"]], env, FPS)[0]
check("a word glued to the previous one is flagged S:no-gap", "S:no-gap" in glued["flags"], glued["flags"])

tail = ec.plan_cuts(WORDS, [[4, 4, "last word"]], env, FPS)[0]
check("removing the last word cuts to the end of the audio", tail["endFrame"] == round(5.0 * FPS), tail)

merged = ec.combine_cuts(
    [{"startFrame": 10, "endFrame": 20, "why": "a"}, {"startFrame": 50, "endFrame": 50, "why": "empty"}],
    [{"startFrame": 18, "endFrame": 25, "airTier": "t"}, {"startFrame": 30, "endFrame": 40}],
)
check("editorial and waveform ranges union, empty ranges drop",
      [(m["startFrame"], m["endFrame"]) for m in merged] == [(10, 25), (30, 40)], merged)
check("merged range keeps both sources", merged[0]["sources"] == ["editorial", "waveform"], merged[0])

parts = ec.split_at_clips([{"startFrame": 5, "endFrame": 15, "sources": ["editorial"], "reasons": []}], [(0, 10), (10, 20)])
check("cuts split at existing clip boundaries", [(p["startFrame"], p["endFrame"]) for p in parts] == [(5, 10), (10, 15)], parts)


def track(clips, media):
    return {"clips": [{"name": "c.mp4", "startSeconds": a * SPF, "endSeconds": b * SPF,
                       "inPointSeconds": src * SPF, "outPointSeconds": (src + b - a) * SPF, "mediaType": media}
                      for a, b, src in clips]}


before = {"name": "seq", "id": "seq-1", "durationSeconds": 20 * SPF,
          "videoTracks": [track([(0, 10, 100), (10, 20, 300)], "Video")],
          "audioTracks": [track([(0, 10, 100), (10, 20, 300)], "Audio")]}
plan = {"cuts": [{"startFrame": 5, "endFrame": 15, "sources": ["editorial"], "reasons": ["restart"]}], "flagged": []}
manifest = ec.build_manifest(before, plan, "p.prproj", FPS)
check("manifest splits the cut per clip", [(c["startFrame"], c["endFrame"]) for c in manifest["cuts"]] == [(5, 10), (10, 15)])
check("manifest expects the shortened duration", manifest["summary"]["expectedDurationAfterFrames"] == 10)
check("manifest carries 30 fps ticks", manifest["timing"]["ticksPerFrame"] == "8467200000")

after = {"name": "seq", "id": "seq-1", "durationSeconds": 10 * SPF,
         "videoTracks": [track([(0, 5, 100), (5, 10, 305)], "Video")],
         "audioTracks": [track([(0, 5, 100), (5, 10, 305)], "Audio")]}
check("verify passes when live source ranges match the plan", ec.verify(before, after, manifest)["ok"])
bad = {**after, "audioTracks": [track([(0, 5, 100), (5, 10, 306)], "Audio")]}
check("verify fails on a one-frame source shift", not ec.verify(before, bad, manifest)["ok"])
gap = {**after, "videoTracks": [track([(0, 5, 100), (6, 11, 305)], "Video")]}
check("verify fails on a timeline gap", not ec.verify(before, gap, manifest)["ok"])

audio = synth(TIMES, 5.0)
preview_plan = {"fps": FPS, "cuts": [{"startFrame": cut["startFrame"], "endFrame": cut["endFrame"], "sources": ["editorial"]}],
                "editorialCuts": [cut]}
edited, joins = ec.preview(preview_plan, audio, SR, WORDS)
removed = (cut["endFrame"] - cut["startFrame"]) * SPF
check("preview removes exactly the planned span", abs(len(edited) / SR - (5.0 - removed)) < 2 / SR)
check("preview join context skips removed words", joins[0]["left"] == "w0" and joins[0]["right"].startswith("w3"), joins)

tmp = Path(__file__).resolve().parent.parent / "tmp"
tmp.mkdir(exist_ok=True)
words_json = tmp / "self-test-editorial-words.json"
ec.save_json(words_json, {"words": [{"text": "a", "startSeconds": 0.0, "endSeconds": 0.4},
                                    {"text": "b", "startSeconds": 0.5, "endSeconds": 0.9},
                                    {"text": "c", "startSeconds": 2.0, "endSeconds": 2.3}]})
chunks = ec.chunks_from_words(words_json)
words_json.unlink()
check("timeline words group into chunks at long gaps", [c["text"] for c in chunks] == ["a b", "c"], chunks)

check("short phrases merge into one ASR chunk up to the span limit", ec.speech_chunks(env) == [[0.25, 4.5]])
spans = ec.speech_chunks(env, min_split_gap=0.4, max_span=1.5)
check("a tight span limit splits ASR chunks inside the pauses",
      len(spans) == 4 and all(env.edge_db(b) < ec.SILENCE_DB for _, b in spans[:-1]), spans)

print(f"1..{passed}")
