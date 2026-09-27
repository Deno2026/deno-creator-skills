// 파형만 보고 자르는 컷 제안 도구.
//
// 대본을 쓰지 않는다. 소리가 있느냐 없느냐만 본다.
// 남기는 공기는 원래 침묵이 얼마나 길었는지로 정한다 — 짧게 끊긴 자리는 문장 안,
// 길게 쉰 자리는 화제 전환으로 보고 2026-07-28 확정값(합계 0.15 / 0.22 / 0.37초)을 적용한다.
//
// 사용:
//   node scripts/propose-waveform-only-cuts.mjs --clips <clips.json> --out <cuts.json>
//   node scripts/propose-waveform-only-cuts.mjs --clips <clips.json> --analyze-only

import fs from "node:fs";
import path from "node:path";

import { decodeFfmpegWaveformEnergies } from "./lib/streaming-waveform-energy.mjs";

const AIR_TIERS = [
  { name: "구 중간", maxSilence: 0.7, tail: 0.09, lead: 0.06 },
  { name: "문장 끝", maxSilence: 1.8, tail: 0.15, lead: 0.07 },
  { name: "화제 전환", maxSilence: Infinity, tail: 0.22, lead: 0.15 },
];

function parseArgs(argv) {
  const options = {
    clips: "",
    out: "",
    report: "",
    analyzeOnly: false,
    sampleRate: 16000,
    frameSeconds: 0.01,
    silenceDb: -44,
    minRemoveSeconds: 0.3,
    // 기본 0. 소리를 건너뛰고 침묵을 이어 붙이면 짧은 음절과 클릭이 통째로 삼켜진다.
    bridgeSilenceGapSeconds: 0,
    // 소리 덩어리 자체를 버리는 기준 (2026-07-31 실측 확정).
    // 596조각을 만들어 사용자가 74개만 남긴 편집을 역산했더니, 버려진 522개 중
    // 1초 미만이 349개였고 남긴 것의 하한은 1.167초 / -22.1dB였다.
    // 기준을 더 세게 잡아도(1.0s/-28dB) 24조각밖에 못 줄이므로 마진이 넉넉한 쪽을 쓴다.
    minPieceSeconds: 0.6,
    minPiecePeakDb: -32,
    // 짧아도 이만큼 크면 남긴다. 길이만 보고 버리면 문장 중간에 끊어 말한 한 단어가
    // 통째로 사라진다(2026-07-30 녹화 13:46에서 실제로 -21dB 발화 1.43초를 잃었다).
    // 사용자가 남긴 조각의 음량 하한이 -22dB대이므로 3dB 여유를 둔 값이다.
    keepLoudPeakDb: -25,
    // 모든 소리 앞뒤에 같은 여유(초)를 남긴다. 쉼 길이별 AIR_TIERS 대신 쓴다(2026-09-28)
    // 「오디오 파형 기준으로 앞뒤 0.15초씩 … 기계적으로」(문맥 판단 컷이 오히려 편집을 불편하게 했다).
    fixedAirSeconds: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--clips") options.clips = argv[++index];
    else if (value === "--out") options.out = argv[++index];
    else if (value === "--report") options.report = argv[++index];
    else if (value === "--analyze-only") options.analyzeOnly = true;
    else if (value === "--sample-rate") options.sampleRate = Number(argv[++index]);
    else if (value === "--frame-seconds") options.frameSeconds = Number(argv[++index]);
    else if (value === "--silence-db") options.silenceDb = Number(argv[++index]);
    else if (value === "--min-remove") options.minRemoveSeconds = Number(argv[++index]);
    else if (value === "--bridge-silence-gap") options.bridgeSilenceGapSeconds = Number(argv[++index]);
    else if (value === "--min-piece") options.minPieceSeconds = Number(argv[++index]);
    else if (value === "--min-piece-peak-db") options.minPiecePeakDb = Number(argv[++index]);
    else if (value === "--keep-loud-peak-db") options.keepLoudPeakDb = Number(argv[++index]);
    else if (value === "--fixed-air") options.fixedAirSeconds = Number(argv[++index]);
    else if (value === "--help" || value === "-h") options.help = true;
  }

  return options;
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function captureBinding(spec) {
  const fields = ["captureSha256", "targetBindingSha256", "bundleSha256"];
  const values = Object.fromEntries(
    fields.map((field) => [field, String(spec?.[field] ?? "").trim().toUpperCase()]),
  );
  const supplied = fields.filter((field) => values[field]);
  if (supplied.length === 0) return null;
  if (supplied.length !== fields.length) {
    throw new Error("clips spec capture binding is incomplete");
  }
  for (const field of fields) {
    if (!/^[0-9A-F]{64}$/.test(values[field])) {
      throw new Error(`clips spec ${field} must be a SHA-256 hash`);
    }
  }
  return values;
}

function dbToLinear(db) {
  return 10 ** (db / 20);
}

function linearToDb(value) {
  return value <= 0 ? -Infinity : 20 * Math.log10(value);
}

function maxPeakDbInRange(energies, frameSeconds, startSeconds, endSeconds) {
  const startFrame = Math.max(0, Math.floor(startSeconds / frameSeconds));
  const endFrame = Math.min(energies.length, Math.ceil(endSeconds / frameSeconds));
  let maximum = 0;
  for (let frame = startFrame; frame < endFrame; frame += 1) {
    maximum = Math.max(maximum, energies[frame] ?? 0);
  }
  return linearToDb(maximum);
}

function percentile(sorted, amount) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * amount)));
  return sorted[index];
}

async function decodeEnergies(mediaPath, options) {
  const sampleRate = Math.max(1000, Math.round(options.sampleRate));
  const frameSeconds = Math.max(0.005, options.frameSeconds);
  const decoded = await decodeFfmpegWaveformEnergies({
    mediaPath,
    sampleRate,
    frameSeconds,
    mode: "peak",
    errorLabel: `ffmpeg decode failed for ${mediaPath}`,
  });

  // 평균(RMS)이 아니라 그 구간의 가장 큰 진폭을 쓴다.
  // 마우스 클릭이나 짧은 파열음은 길이가 짧아서 평균을 내면 배경 잡음 수준으로 묻힌다.
  // 실제로 2026-07-30에 RMS로 만든 컷 425개 중 294개가 소리를 밟고 있었고 원인이 이것이었다.
  return {
    energies: Float64Array.from(decoded.energies),
    sampleRate,
    frameSeconds,
    durationSeconds: decoded.totalSamples / sampleRate,
  };
}

function describeDistribution(energies) {
  const sorted = Array.from(energies).sort((a, b) => a - b);
  const marks = [0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 0.95, 0.99];
  const out = {};
  for (const mark of marks) {
    out[`p${Math.round(mark * 100)}`] = round(linearToDb(percentile(sorted, mark)), 2);
  }
  return out;
}

// 임계값 아래가 이어지는 구간을 침묵으로 본다.
// 아주 짧은 소리 하나(입술 소리, 클릭)로 침묵이 두 동강 나지 않도록 bridge 만큼은 이어 붙인다.
function findSilentRuns(energies, frameSeconds, threshold, bridgeSeconds) {
  const bridgeFrames = Math.max(0, Math.round(bridgeSeconds / frameSeconds));
  const runs = [];
  let runStart = null;
  let lastSilentFrame = null;
  let loudStreak = 0;

  for (let frame = 0; frame <= energies.length; frame += 1) {
    const value = frame < energies.length ? energies[frame] : Number.POSITIVE_INFINITY;
    const silent = value < threshold;

    if (silent) {
      if (runStart === null) runStart = frame;
      lastSilentFrame = frame;
      loudStreak = 0;
      continue;
    }

    if (runStart !== null) {
      loudStreak += 1;
      if (loudStreak > bridgeFrames || frame === energies.length) {
        runs.push({
          startSeconds: runStart * frameSeconds,
          endSeconds: ((lastSilentFrame ?? frame) + 1) * frameSeconds,
        });
        runStart = null;
        lastSilentFrame = null;
        loudStreak = 0;
      }
    }
  }

  return runs;
}

function pickAirTier(silenceSeconds) {
  for (const tier of AIR_TIERS) {
    if (silenceSeconds < tier.maxSilence) return tier;
  }
  return AIR_TIERS[AIR_TIERS.length - 1];
}

function airTierFor(silenceSeconds, options) {
  if (options.fixedAirSeconds === null) return pickAirTier(silenceSeconds);
  const air = options.fixedAirSeconds;
  return { name: `고정 ${air}s`, maxSilence: Infinity, tail: air, lead: air };
}

function peakBetween(audio, startSeconds, endSeconds) {
  const from = Math.max(0, Math.floor(startSeconds / audio.frameSeconds));
  const to = Math.min(audio.energies.length, Math.ceil(endSeconds / audio.frameSeconds));
  let peak = 0;
  for (let frame = from; frame < to; frame += 1) {
    if (audio.energies[frame] > peak) peak = audio.energies[frame];
  }
  return peak;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.clips || (!options.out && !options.analyzeOnly)) {
    console.log(
      [
        "Usage:",
        "  node scripts/propose-waveform-only-cuts.mjs --clips <clips.json> --out <cuts.json>",
        "  node scripts/propose-waveform-only-cuts.mjs --clips <clips.json> --analyze-only",
        "",
        "Options (기본값이 확정값이다. 바꿀 이유가 없으면 그대로 쓴다):",
        "  --silence-db <n>          무음 판정 기준, 기본 -44",
        "  --min-piece <n>           진단용 소리 덩어리 길이 기준, 기본 0.6초",
        "  --min-piece-peak-db <n>   진단용 소리 덩어리 peak 기준, 기본 -32",
        "  --keep-loud-peak-db <n>   진단용 짧은 소리 보존 기준, 기본 -25",
        "  --min-remove <n>          이보다 짧게 잘릴 구간은 두고 넘어간다, 기본 0.3초",
        "  --fixed-air <n>           모든 소리 앞뒤에 같은 여유(초)를 남긴다(쉼 길이별 기본 대신), 예 0.15",
      ].join("\n"),
    );
    process.exit(options.help ? 0 : 1);
  }

  if (
    options.fixedAirSeconds !== null &&
    !(Number.isFinite(options.fixedAirSeconds) && options.fixedAirSeconds >= 0 && options.fixedAirSeconds <= 1)
  ) {
    throw new Error("--fixed-air must be a number of seconds between 0 and 1");
  }

  const spec = JSON.parse(fs.readFileSync(options.clips, "utf8"));
  if (!spec || typeof spec !== "object" || !Array.isArray(spec.clips) || spec.clips.length === 0) {
    throw new Error("clips spec must contain at least one clip");
  }
  const fps = Number(spec.fps);
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error("clips spec fps is required and must match the live sequence");
  }
  const ticksPerFrame = String(spec.ticksPerFrame ?? "").trim();
  if (!ticksPerFrame) {
    throw new Error("clips spec ticksPerFrame is required and must match the live sequence");
  }
  const inputCaptureBinding = captureBinding(spec);
  const threshold = dbToLinear(options.silenceDb);
  const cuts = [];
  const clipReports = [];
  const suspiciousCuts = [];
  const remainingMediaUses = new Map();
  const waveformCache = new Map();

  for (const clip of spec.clips) {
    const mediaKey = path.resolve(clip.media).toLowerCase();
    remainingMediaUses.set(mediaKey, (remainingMediaUses.get(mediaKey) || 0) + 1);
  }

  for (const clip of spec.clips) {
    const clipCutStartIndex = cuts.length;
    const mediaKey = path.resolve(clip.media).toLowerCase();
    let audio = waveformCache.get(mediaKey);
    if (!audio) {
      audio = await decodeEnergies(clip.media, options);
      if ((remainingMediaUses.get(mediaKey) || 0) > 1) {
        waveformCache.set(mediaKey, audio);
      }
    }
    const releaseMediaUse = () => {
      const remaining = (remainingMediaUses.get(mediaKey) || 1) - 1;
      remainingMediaUses.set(mediaKey, remaining);
      if (remaining <= 0) waveformCache.delete(mediaKey);
    };
    const distribution = describeDistribution(audio.energies);

    if (options.analyzeOnly) {
      clipReports.push({
        media: path.basename(clip.media),
        durationSeconds: round(audio.durationSeconds),
        frameCount: audio.energies.length,
        percentilesDb: distribution,
      });
      releaseMediaUse();
      continue;
    }

    const sourceIn = Number(clip.sourceIn) || 0;
    const timelineStart = Number(clip.timelineStart) || 0;
    const timelineEnd = Number(clip.timelineEnd);
    const sourceEnd = timelineEnd - timelineStart + sourceIn;
    const runs = findSilentRuns(
      audio.energies,
      audio.frameSeconds,
      threshold,
      options.bridgeSilenceGapSeconds,
    );

    // 모든 침묵이 덩어리의 경계인 것은 아니다. 공기를 남기고 나면 잘라낼 것이 거의 없는
    // 짧은 침묵은 말 안쪽의 숨이므로 경계로 치지 않는다. 이걸 경계로 삼으면 한 단어가
    // 여러 덩어리로 갈라지고, 각각이 짧다는 이유로 통째로 버려진다.
    const boundaries = [];
    for (const run of runs) {
      const runStart = Math.max(run.startSeconds, sourceIn);
      const runEnd = Math.min(run.endSeconds, sourceEnd);
      if (runEnd <= runStart) continue;
      const silenceSeconds = runEnd - runStart;
      const tier = airTierFor(silenceSeconds, options);
      const openEdge = runStart <= sourceIn + 1e-6 || runEnd >= sourceEnd - 1e-6;
      const air = openEdge ? Math.min(tier.tail, tier.lead) : tier.tail + tier.lead;
      if (silenceSeconds - air < options.minRemoveSeconds) continue;
      boundaries.push({ start: runStart, end: runEnd });
    }

    // 그 경계들의 여집합이 소리 덩어리다. 컷을 먼저 만들지 않고
    // "무엇을 남길지"를 정한 다음, 남긴 것 사이를 잘라낸다.
    const pieces = [];
    let scan = sourceIn;
    for (const boundary of boundaries) {
      if (boundary.start > scan) pieces.push({ start: scan, end: boundary.start });
      scan = Math.max(scan, boundary.end);
    }
    if (sourceEnd > scan) pieces.push({ start: scan, end: sourceEnd });

    // 파형 전용 후보에서는 threshold를 넘은 소리를 길이나 음량만으로 버리지 않는다.
    // 짧은 클릭·파열음·말하다 만 토막을 침묵과 합치면 아래 동일-source peak
    // 감사에서 반드시 suspicious가 되고, 더 중요하게는 의미 판단 없이 실제 소리를
    // 삭제하게 된다. 이런 조각은 모두 보존하고, 명백한 실패 테이크 삭제는 별도의
    // transcript + waveform-boundary 의미 단계가 소유한다.
    const dropped = [];
    const keep = pieces;

    // 남길 덩어리 사이가 잘라낼 구간이다. 걸러진 덩어리는 양옆 침묵과 하나로 합쳐진다.
    const gaps = [];
    if (keep.length === 0) {
      gaps.push({ start: sourceIn, end: sourceEnd, headOpen: true, tailOpen: true });
    } else {
      if (keep[0].start > sourceIn) {
        gaps.push({ start: sourceIn, end: keep[0].start, headOpen: true, tailOpen: false });
      }
      for (let index = 1; index < keep.length; index += 1) {
        gaps.push({
          start: keep[index - 1].end,
          end: keep[index].start,
          headOpen: false,
          tailOpen: false,
        });
      }
      const lastPiece = keep[keep.length - 1];
      if (sourceEnd > lastPiece.end) {
        gaps.push({ start: lastPiece.end, end: sourceEnd, headOpen: false, tailOpen: true });
      }
    }

    let clipCutCount = 0;
    let clipRemoveSeconds = 0;
    const tierCounts = {};

    for (const gap of gaps) {
      const silenceSeconds = gap.end - gap.start;
      const tier = airTierFor(silenceSeconds, options);
      // 클립 맨 앞·맨 뒤는 바깥쪽에 소리가 없으므로 그쪽 공기를 남기지 않는다.
      const cutStartSource = gap.headOpen ? gap.start : gap.start + tier.tail;
      const cutEndSource = gap.tailOpen ? gap.end : gap.end - tier.lead;

      if (cutEndSource - cutStartSource < options.minRemoveSeconds) continue;

      const timelineStartSeconds = cutStartSource - sourceIn + timelineStart;
      const timelineEndSeconds = cutEndSource - sourceIn + timelineStart;

      // 프레임 경계에는 안쪽으로 스냅한다. 밖으로 스냅하면 소리를 밟는다.
      const startFrame = Math.ceil(timelineStartSeconds * fps - 1e-6);
      const endFrame = Math.floor(timelineEndSeconds * fps + 1e-6);
      if (endFrame - startFrame < 1) continue;

      const snappedStart = startFrame / fps;
      const snappedEnd = endFrame / fps;
      const removeSeconds = snappedEnd - snappedStart;
      if (removeSeconds < options.minRemoveSeconds) continue;
      if (snappedStart < timelineStart - 1e-6 || snappedEnd > timelineEnd + 1e-6) continue;

      cuts.push({
        index: cuts.length,
        type: "waveform_only",
        confidence: "high",
        startFrame,
        endFrame,
        startSeconds: round(snappedStart, 6),
        endSeconds: round(snappedEnd, 6),
        removeSeconds: round(removeSeconds),
        silenceSeconds: round(silenceSeconds),
        airTier: tier.name,
        airSeconds: round(tier.tail + tier.lead),
        clip: path.basename(clip.media),
        reason: `제거 구간 ${round(silenceSeconds)}s → ${tier.name} 판정, 앞 ${tier.tail}s + 뒤 ${tier.lead}s 남김`,
      });

      clipCutCount += 1;
      clipRemoveSeconds += removeSeconds;
      tierCounts[tier.name] = (tierCounts[tier.name] || 0) + 1;
    }

    const currentClipCuts = cuts.slice(clipCutStartIndex);
    for (const cut of currentClipCuts) {
      const cutSourceStart = cut.startSeconds - timelineStart + sourceIn;
      const cutSourceEnd = cut.endSeconds - timelineStart + sourceIn;
      const peakDb = maxPeakDbInRange(
        audio.energies,
        audio.frameSeconds,
        cutSourceStart,
        cutSourceEnd,
      );
      cut.candidatePeakDb = Number.isFinite(peakDb) ? round(peakDb, 2) : null;
      if (peakDb >= options.silenceDb) {
        suspiciousCuts.push({
          clip: path.basename(clip.media),
          endFrame: cut.endFrame,
          index: cut.index,
          peakDb: cut.candidatePeakDb,
          startFrame: cut.startFrame,
        });
      }
    }

    clipReports.push({
      media: path.basename(clip.media),
      durationSeconds: round(audio.durationSeconds),
      timelineStart: round(timelineStart),
      timelineEnd: round(timelineEnd),
      percentilesDb: distribution,
      silentRunCount: runs.length,
      soundPieceCount: pieces.length,
      keptPieceCount: keep.length,
      droppedPieceCount: dropped.length,
      droppedSeconds: round(dropped.reduce((sum, item) => sum + item.duration, 0)),
      cutCount: clipCutCount,
      removeSeconds: round(clipRemoveSeconds),
      tierCounts,
    });
    releaseMediaUse();
  }

  if (options.analyzeOnly) {
    console.log(JSON.stringify({ silenceDbTested: options.silenceDb, clips: clipReports }, null, 2));
    return;
  }

  cuts.sort((a, b) => a.startFrame - b.startFrame);
  cuts.forEach((cut, index) => {
    cut.index = index;
  });
  for (const suspicious of suspiciousCuts) {
    const matchingCut = cuts.find(
      (cut) =>
        cut.startFrame === suspicious.startFrame &&
        cut.endFrame === suspicious.endFrame &&
        cut.clip === suspicious.clip,
    );
    if (matchingCut) suspicious.index = matchingCut.index;
  }

  // 겹침 검사 — 겹치면 적용 순서가 무너진다.
  const overlaps = [];
  for (let index = 1; index < cuts.length; index += 1) {
    if (cuts[index].startFrame < cuts[index - 1].endFrame) {
      overlaps.push({ a: index - 1, b: index });
    }
  }

  const payload = {
    mode: "waveform-only",
    writeReady: overlaps.length === 0 && suspiciousCuts.length === 0,
    candidatePeakAudit: {
      energyMode: "peak",
      bridgeSilenceGapSeconds: options.bridgeSilenceGapSeconds,
      auditedCutCount: cuts.length,
      suspiciousCutCount: suspiciousCuts.length,
      suspiciousPeakThresholdDb: options.silenceDb,
      suspiciousCuts,
    },
    waveformSnapEvidence: {
      integerFrameBoundaries: true,
      allBoundariesSnapped: true,
      fps,
    },
    ...(inputCaptureBinding ?? {}),
    options: {
      fps,
      ticksPerFrame,
      silenceDb: options.silenceDb,
      minCutSeconds: options.minRemoveSeconds,
      frameSeconds: options.frameSeconds,
      bridgeSilenceGapSeconds: options.bridgeSilenceGapSeconds,
      minPieceSeconds: options.minPieceSeconds,
      minPiecePeakDb: options.minPiecePeakDb,
      keepLoudPeakDb: options.keepLoudPeakDb,
      fixedAirSeconds: options.fixedAirSeconds,
      airTiers: AIR_TIERS.map((tier) => ({
        name: tier.name,
        maxSilence: tier.maxSilence === Infinity ? null : tier.maxSilence,
        tail: tier.tail,
        lead: tier.lead,
      })),
    },
    cutCount: cuts.length,
    totalRemoveSeconds: round(cuts.reduce((sum, cut) => sum + cut.removeSeconds, 0)),
    overlapCount: overlaps.length,
    clips: clipReports,
    cuts,
  };

  fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
  fs.writeFileSync(options.out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        out: path.resolve(options.out),
        cutCount: payload.cutCount,
        totalRemoveSeconds: payload.totalRemoveSeconds,
        overlapCount: payload.overlapCount,
        clips: clipReports.map((clip) => ({
          media: clip.media,
          cutCount: clip.cutCount,
          removeSeconds: clip.removeSeconds,
          tierCounts: clip.tierCounts,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
