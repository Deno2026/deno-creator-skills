import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { decodeFfmpegWaveformEnergies } from "./streaming-waveform-energy.mjs";
import {
  normalizeRepeatCutWords,
  proposePremiereRepeatCuts,
} from "./premiere-repeat-cuts.mjs";

const EPSILON = 1e-7;

export const DEFAULT_SEMANTIC_WAVEFORM_SAFETY_OPTIONS = Object.freeze({
  sampleRate: 16000,
  frameSeconds: 0.005,
  silenceDb: -44,
  maxSnapFrames: null,
  minHandleFrames: 2,
  ffmpegPath: "ffmpeg",
  audioMap: null,
});

export const PREMIERE_SEMANTIC_WAVEFORM_SAFETY_SCHEMA = Object.freeze({
  schemaVersion: 1,
  input: {
    repeatInput:
      "target-only input accepted by proposePremiereRepeatCuts: fps plus words/transcript.words/timelineWords.words",
    clipSpec:
      "same-capture {fps,clips:[{media,sourceIn,timelineStart,timelineEnd,clipNodeId?,projectItemNodeId?}]}",
  },
  output: {
    mode: "premiere_repeat_cut_proposal",
    waveformSafety:
      "aggregate boundaryFrames, boundaryRanges, and candidate-scoped cutRanges",
    candidates:
      "only candidates with semantic certainty, one verified clip/source mapping, and two low-energy boundaries have proposalEligible=true",
  },
  notes: [
    "The repeated or abandoned speech inside a deletion range is expected to be voiced and is never treated as a suspicious peak.",
    "Only the two edit boundaries and the silent snap corridors are peak-audited.",
    "This module reads media through ffmpeg but never connects to or writes Premiere.",
  ],
});

function fail(message) {
  throw new Error(`Semantic waveform safety: ${message}`);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`${label} must be a finite number`);
  return parsed;
}

function positiveNumber(value, label) {
  const parsed = finiteNumber(value, label);
  if (!(parsed > 0)) fail(`${label} must be greater than zero`);
  return parsed;
}

function nonNegativeInteger(value, label) {
  const parsed = finiteNumber(value, label);
  if (!Number.isInteger(parsed) || parsed < 0) {
    fail(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function clean(value) {
  return String(value ?? "").trim();
}

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function dbToLinear(db) {
  return 10 ** (db / 20);
}

function linearToDb(value) {
  if (!(value > 0)) return -120;
  return Math.max(-120, 20 * Math.log10(value));
}

function normalizeSha256(value) {
  const normalized = clean(value).replace(/^sha256:/iu, "").toUpperCase();
  if (normalized && !/^[0-9A-F]{64}$/u.test(normalized)) {
    fail("media SHA-256 must contain 64 hexadecimal characters");
  }
  return normalized;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex").toUpperCase();
}

function inputWords(input) {
  if (Array.isArray(input?.words)) return input.words;
  if (Array.isArray(input?.transcript?.words)) return input.transcript.words;
  if (Array.isArray(input?.timelineWords?.words)) return input.timelineWords.words;
  fail("repeatInput must contain words, transcript.words, or timelineWords.words");
}

function normalizeOptions(repeatInput, rawOptions = {}) {
  const fps = positiveNumber(repeatInput?.fps, "repeatInput.fps");
  const options = {
    ...DEFAULT_SEMANTIC_WAVEFORM_SAFETY_OPTIONS,
    ...(isObject(rawOptions) ? rawOptions : {}),
  };
  options.sampleRate = Math.round(positiveNumber(options.sampleRate, "options.sampleRate"));
  options.frameSeconds = positiveNumber(options.frameSeconds, "options.frameSeconds");
  options.silenceDb = finiteNumber(options.silenceDb, "options.silenceDb");
  options.maxSnapFrames = options.maxSnapFrames === null || options.maxSnapFrames === undefined
    ? Math.ceil(fps * 0.4)
    : nonNegativeInteger(options.maxSnapFrames, "options.maxSnapFrames");
  options.minHandleFrames = nonNegativeInteger(
    options.minHandleFrames,
    "options.minHandleFrames",
  );
  if (options.minHandleFrames < 1) fail("options.minHandleFrames must be at least 1");
  options.ffmpegPath = clean(options.ffmpegPath) || "ffmpeg";
  options.audioMap = options.audioMap === null || options.audioMap === undefined
    ? null
    : clean(options.audioMap);
  options.fps = fps;
  return options;
}

function normalizedClipIdentity(clip, index) {
  const clipNodeIds = [
    clip.clipNodeId,
    clip.timelineClipNodeId,
    clip.nodeId,
    clip.videoNodeId,
    clip.audioNodeId,
  ].map(clean).filter(Boolean);
  return {
    timelineClipIndex:
      clip.timelineClipIndex ?? clip.clipIndex ?? clip.videoClipIndex ?? clip.audioClipIndex ?? clip.index ?? index,
    clipNodeId: clipNodeIds[0] ?? "",
    clipNodeIds: [...new Set(clipNodeIds)],
    projectItemNodeId: clean(clip.projectItemNodeId ?? clip.projectItemId),
    name: clean(clip.name ?? clip.clipName ?? clip.targetClipName),
  };
}

function expectedFingerprint(clip) {
  const nested = isObject(clip.mediaFingerprint)
    ? clip.mediaFingerprint
    : (isObject(clip.mediaEvidence) ? clip.mediaEvidence : {});
  const sizeValue =
    nested.size ?? nested.sizeBytes ?? nested.fileSize ??
    clip.mediaFileSize ?? clip.mediaSize ?? clip.fileSize;
  const mtimeValue =
    nested.mtimeMs ?? nested.fileMtimeMs ?? clip.mediaMtimeMs ?? clip.fileMtimeMs;
  const shaValue =
    nested.sha256 ?? clip.mediaSha256 ?? clip.sourceSha256 ?? clip.sha256;
  return {
    size: sizeValue === undefined || sizeValue === null ? null : Number(sizeValue),
    mtimeMs: mtimeValue === undefined || mtimeValue === null ? null : Number(mtimeValue),
    sha256: normalizeSha256(shaValue),
  };
}

function normalizeClip(clip, index, repoRoot) {
  if (!isObject(clip)) fail(`clipSpec.clips[${index}] must be an object`);
  const mediaValue = clean(
    clip.media ?? clip.mediaPath ?? clip.path ?? clip.mediaEvidence?.path,
  );
  if (!mediaValue) fail(`clipSpec.clips[${index}].media is required`);
  const media = path.resolve(repoRoot, mediaValue);
  const timelineStart = finiteNumber(
    clip.timelineStart ?? clip.startSeconds,
    `clipSpec.clips[${index}].timelineStart`,
  );
  const timelineEnd = finiteNumber(
    clip.timelineEnd ?? clip.endSeconds,
    `clipSpec.clips[${index}].timelineEnd`,
  );
  const sourceIn = finiteNumber(
    clip.sourceIn ?? clip.inPointSeconds ?? 0,
    `clipSpec.clips[${index}].sourceIn`,
  );
  const inferredSourceOut = sourceIn + (timelineEnd - timelineStart);
  const sourceOut = finiteNumber(
    clip.sourceOut ?? clip.outPointSeconds ?? inferredSourceOut,
    `clipSpec.clips[${index}].sourceOut`,
  );
  if (timelineStart < 0 || timelineEnd <= timelineStart) {
    fail(`clipSpec.clips[${index}] has an invalid timeline range`);
  }
  if (sourceIn < 0 || sourceOut <= sourceIn) {
    fail(`clipSpec.clips[${index}] has an invalid source range`);
  }
  const sourceDuration = sourceOut - sourceIn;
  const timelineDuration = timelineEnd - timelineStart;
  const playbackRate = finiteNumber(
    clip.playbackRate ?? clip.speed ?? sourceDuration / timelineDuration,
    `clipSpec.clips[${index}].playbackRate`,
  );
  const issues = [];
  if (Math.abs(playbackRate - 1) > 1e-6 || Math.abs(sourceDuration - timelineDuration) > 1e-4) {
    issues.push("unsupported_non_unit_playback_rate");
  }
  return {
    index,
    ...normalizedClipIdentity(clip, index),
    media,
    timelineStart,
    timelineEnd,
    sourceIn,
    sourceOut,
    playbackRate,
    expectedFingerprint: expectedFingerprint(clip),
    issues,
  };
}

function identityMatches(expected, actual, { allowNameFromMedia = false, media = "" } = {}) {
  if (!expected) return true;
  const wanted = clean(expected);
  if (!wanted) return true;
  const observed = clean(actual);
  if (observed) return observed === wanted;
  if (allowNameFromMedia && media) return path.basename(media).toLocaleLowerCase() === wanted.toLocaleLowerCase();
  return false;
}

function clipMatchesTarget(clip, target) {
  if (!isObject(target)) return true;
  const targetNodeIds = [
    target.clipNodeId,
    target.timelineClipNodeId,
    target.videoNodeId,
    target.audioNodeId,
  ].map(clean).filter(Boolean);
  if (targetNodeIds.length > 0 && !targetNodeIds.every((value) => clip.clipNodeIds.includes(value))) {
    return false;
  }
  if (!identityMatches(target.projectItemNodeId ?? target.projectItemId, clip.projectItemNodeId)) {
    return false;
  }
  if (!identityMatches(target.name ?? target.clipName ?? target.targetClipName, clip.name, {
    allowNameFromMedia: true,
    media: clip.media,
  })) return false;
  const targetMedia = clean(target.media ?? target.mediaPath ?? target.path);
  if (targetMedia && path.resolve(targetMedia).toLocaleLowerCase() !== clip.media.toLocaleLowerCase()) {
    return false;
  }
  return true;
}

function clipMatchesTokens(clip, tokens) {
  for (const token of tokens) {
    if (
      token.timelineClipIndex !== null &&
      token.timelineClipIndex !== undefined &&
      String(token.timelineClipIndex) !== String(clip.timelineClipIndex)
    ) return false;
    if (token.clipNodeId && !clip.clipNodeIds.includes(token.clipNodeId)) return false;
    if (token.projectItemNodeId && token.projectItemNodeId !== clip.projectItemNodeId) return false;
  }
  return true;
}

function clipContainsCandidate(clip, tokens) {
  const start = tokens[0]?.startSeconds;
  const end = tokens.at(-1)?.endSeconds;
  return Number.isFinite(start) && Number.isFinite(end) &&
    start >= clip.timelineStart - EPSILON && end <= clip.timelineEnd + EPSILON;
}

function sourceSecondsForTimeline(clip, timelineSeconds) {
  return clip.sourceIn + (timelineSeconds - clip.timelineStart);
}

async function inspectMediaFingerprint(clip) {
  const issues = [...clip.issues];
  let stat = null;
  try {
    stat = fs.statSync(clip.media);
  } catch {
    issues.push("media_missing");
  }
  if (stat && !stat.isFile()) issues.push("media_not_a_file");
  const actual = stat
    ? { size: stat.size, mtimeMs: Math.round(stat.mtimeMs), sha256: null }
    : { size: null, mtimeMs: null, sha256: null };
  const expected = clip.expectedFingerprint;
  if (stat && expected.size !== null) {
    if (!Number.isFinite(expected.size) || expected.size !== stat.size) {
      issues.push("media_size_mismatch");
    }
  }
  if (stat && expected.mtimeMs !== null) {
    if (!Number.isFinite(expected.mtimeMs) || Math.abs(expected.mtimeMs - stat.mtimeMs) > 2) {
      issues.push("media_mtime_mismatch");
    }
  }
  if (stat && expected.sha256) {
    actual.sha256 = await sha256File(clip.media);
    if (actual.sha256 !== expected.sha256) issues.push("media_sha256_mismatch");
  }
  return {
    ...clip,
    fingerprint: { expected, actual },
    issues: [...new Set(issues)],
  };
}

function maxPeak(audio, startSeconds, endSeconds) {
  if (!(endSeconds > startSeconds)) return 0;
  const from = Math.max(0, Math.floor(startSeconds / audio.frameSeconds + EPSILON));
  const to = Math.min(audio.energies.length, Math.ceil(endSeconds / audio.frameSeconds - EPSILON));
  let peak = 0;
  for (let index = from; index < to; index += 1) {
    peak = Math.max(peak, audio.energies[index] ?? 0);
  }
  return peak;
}

function candidateKey(candidate) {
  return [
    candidate.type,
    candidate.evidence?.tokenStartIndex,
    candidate.evidence?.tokenRemoveEndIndex,
    candidate.evidence?.keptTokenStartIndex,
    candidate.evidence?.keptTokenEndIndex,
  ].join(":");
}

function boundaryCandidates({
  role,
  transcriptSeconds,
  transcriptFrame,
  clip,
  audio,
  options,
}) {
  const halfHandleSeconds = options.minHandleFrames / options.fps / 2;
  const threshold = dbToLinear(options.silenceDb);
  const lowerFrame = Math.max(
    Math.ceil(clip.timelineStart * options.fps - EPSILON),
    transcriptFrame - options.maxSnapFrames,
  );
  const upperFrame = Math.min(
    transcriptFrame,
    Math.floor(transcriptSeconds * options.fps + EPSILON),
    Math.floor(clip.timelineEnd * options.fps + EPSILON),
  );
  const safe = [];

  for (let frame = upperFrame; frame >= lowerFrame; frame -= 1) {
    const timelineSeconds = frame / options.fps;
    if (timelineSeconds > transcriptSeconds + EPSILON) continue;
    const sourceSeconds = sourceSecondsForTimeline(clip, timelineSeconds);
    const transcriptSourceSeconds = sourceSecondsForTimeline(clip, transcriptSeconds);
    const guardStart = sourceSeconds - halfHandleSeconds;
    const guardEnd = sourceSeconds + halfHandleSeconds;
    if (
      guardStart < clip.sourceIn - EPSILON ||
      guardEnd > clip.sourceOut + EPSILON ||
      guardStart < -EPSILON ||
      guardEnd > audio.durationSeconds + EPSILON
    ) continue;
    const boundaryPeak = maxPeak(audio, Math.max(0, guardStart), guardEnd);
    const corridorPeak = maxPeak(audio, sourceSeconds, transcriptSourceSeconds);
    if (boundaryPeak >= threshold || corridorPeak >= threshold) continue;
    safe.push({
      frame,
      timelineSeconds: round(timelineSeconds),
      sourceSeconds: round(sourceSeconds),
      snapDistanceFrames: Math.abs(transcriptFrame - frame),
      boundaryPeakDb: round(linearToDb(boundaryPeak), 2),
      corridorPeakDb: round(linearToDb(corridorPeak), 2),
    });
  }

  safe.sort((left, right) =>
    left.snapDistanceFrames - right.snapDistanceFrames || right.frame - left.frame
  );
  const selected = safe[0] ?? null;
  return {
    role,
    transcriptSeconds: round(transcriptSeconds),
    transcriptFrame,
    selected,
    verifiedFrameRange: safe.length > 0
      ? {
          startFrame: Math.min(...safe.map((item) => item.frame)),
          endFrame: Math.max(...safe.map((item) => item.frame)),
        }
      : null,
    verifiedFrameCount: safe.length,
  };
}

function candidateTokens(tokens, candidate) {
  const start = candidate.evidence?.tokenStartIndex;
  const end = candidate.evidence?.keptTokenEndIndex;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return [];
  return tokens.slice(start, end + 1);
}

function noSafetyCandidate(candidate, reasonCode, details = {}) {
  const reviewReasons = candidate.reviewReasons
    .filter((reason) => !reason.startsWith("waveform_safe_boundary_"));
  reviewReasons.push(reasonCode);
  return {
    ...candidate,
    confidence: candidate.confidence === "low" ? "low" : "medium",
    reviewRequired: true,
    reviewReasons: [...new Set(reviewReasons)],
    proposalEligible: false,
    waveformSafety: {
      status: "unverified_no_safe_audio_boundary",
      verified: false,
      required: true,
      maxSnapFrames: details.maxSnapFrames ?? candidate.waveformSafety?.maxSnapFrames ?? null,
      startFrame: candidate.transcriptTiming?.snappedStartFrame ?? candidate.startFrame,
      endFrame: candidate.transcriptTiming?.snappedEndFrame ?? candidate.endFrame,
      failureReason: reasonCode,
      ...details,
    },
  };
}

async function decodeClipAudio(clip, options, cache) {
  if (cache.has(clip.media)) return cache.get(clip.media);
  const pending = decodeFfmpegWaveformEnergies({
    mediaPath: clip.media,
    sampleRate: options.sampleRate,
    frameSeconds: options.frameSeconds,
    mode: "peak",
    audioMap: options.audioMap,
    ffmpegPath: options.ffmpegPath,
    errorLabel: `ffmpeg peak decode failed for ${clip.media}`,
  }).then((decoded) => ({
    energies: Float64Array.from(decoded.energies),
    sampleRate: decoded.sampleRate,
    frameSeconds: decoded.frameSeconds,
    durationSeconds: decoded.totalSamples / decoded.sampleRate,
  }));
  cache.set(clip.media, pending);
  return pending;
}

function aggregateRanges(candidateResults) {
  const verified = candidateResults.filter((candidate) => candidate.proposalEligible === true);
  const boundaryFrames = [...new Set(verified.flatMap((candidate) =>
    candidate.waveformSafety.boundaryFrames ?? []
  ))].sort((left, right) => left - right);
  const boundaryRanges = verified.flatMap((candidate) =>
    candidate.waveformSafety.boundaryRanges ?? []
  );
  const cutRanges = verified.flatMap((candidate) =>
    candidate.waveformSafety.cutRanges ?? []
  );
  return { boundaryFrames, boundaryRanges, cutRanges };
}

function summaryFor(candidates) {
  return {
    candidateCount: candidates.length,
    proposalEligibleCount: candidates.filter((candidate) => candidate.proposalEligible).length,
    reviewRequiredCount: candidates.filter((candidate) => candidate.reviewRequired).length,
    typeCounts: candidates.reduce((counts, candidate) => {
      counts[candidate.type] = (counts[candidate.type] ?? 0) + 1;
      return counts;
    }, {}),
  };
}

function semanticBoundaryAuditFor(candidates) {
  const analyses = candidates.flatMap((candidate) => {
    const boundaryAnalysis = candidate.waveformSafety?.boundaryAnalysis;
    if (!isObject(boundaryAnalysis)) return [];
    return [boundaryAnalysis.start, boundaryAnalysis.end].filter(isObject);
  });
  return {
    energyMode: "peak",
    candidateCount: candidates.length,
    auditedCandidateCount: candidates.filter((candidate) =>
      isObject(candidate.waveformSafety?.boundaryAnalysis)
    ).length,
    auditedBoundaryCount: analyses.length,
    verifiedBoundaryCount: analyses.filter((analysis) => analysis.selected).length,
    verifiedCutCount: candidates.filter((candidate) => candidate.proposalEligible).length,
    reviewOnlyCandidateCount: candidates.filter((candidate) => !candidate.proposalEligible).length,
    interiorPeakAuditCutCount: 0,
    interiorPeakAuditReason: "removed repeat/restart speech is expected to be voiced",
  };
}

function verifySharedCapture(repeatInput, clipSpec) {
  for (const field of ["captureSha256", "targetBindingSha256", "bundleSha256"]) {
    const repeatValue = clean(repeatInput[field] ?? repeatInput.capture?.[field]);
    const clipValue = clean(clipSpec[field]);
    if (repeatValue && clipValue && repeatValue !== clipValue) {
      fail(`${field} mismatch between repeatInput and clipSpec`);
    }
  }
  const repeatTicks = clean(repeatInput.ticksPerFrame ?? repeatInput.timing?.ticksPerFrame);
  const clipTicks = clean(clipSpec.ticksPerFrame ?? clipSpec.timing?.ticksPerFrame);
  if (repeatTicks && clipTicks && repeatTicks !== clipTicks) {
    fail("ticksPerFrame mismatch between repeatInput and clipSpec");
  }
}

export async function attachPremiereSemanticWaveformSafety({
  repeatInput,
  clipSpec,
  options: rawOptions = {},
  repoRoot = process.cwd(),
}) {
  if (!isObject(repeatInput)) fail("repeatInput must be an object");
  if (!isObject(clipSpec) || !Array.isArray(clipSpec.clips)) {
    fail("clipSpec must be an object containing clips[]");
  }
  if (repeatInput.schemaVersion !== undefined && Number(repeatInput.schemaVersion) !== 1) {
    fail(`unsupported repeatInput schemaVersion ${repeatInput.schemaVersion}`);
  }
  if (clipSpec.schemaVersion !== undefined && Number(clipSpec.schemaVersion) !== 1) {
    fail(`unsupported clipSpec schemaVersion ${clipSpec.schemaVersion}`);
  }
  verifySharedCapture(repeatInput, clipSpec);
  const options = normalizeOptions(repeatInput, rawOptions);
  const captureFps = positiveNumber(clipSpec.fps, "clipSpec.fps");
  if (Math.abs(captureFps - options.fps) > 1e-6) {
    fail(`fps mismatch: repeatInput=${options.fps}, clipSpec=${captureFps}`);
  }

  const repeatInputWithoutTrustedSafety = {
    ...repeatInput,
    waveformSafety: { required: true, maxSnapFrames: options.maxSnapFrames },
  };
  const baseProposal = proposePremiereRepeatCuts(repeatInputWithoutTrustedSafety, {
    requireWaveformSafety: true,
    maxBoundarySnapFrames: options.maxSnapFrames,
  });
  const words = inputWords(repeatInput);
  const tokens = normalizeRepeatCutWords(words);
  const rawClips = clipSpec.clips.map((clip, index) => normalizeClip(clip, index, repoRoot));
  const clips = await Promise.all(rawClips.map(inspectMediaFingerprint));
  const audioCache = new Map();
  const candidates = [];

  for (const candidate of baseProposal.candidates) {
    if (
      candidate.evidence?.commonPrefixTokenCount < 2 ||
      candidate.evidence?.phraseTokenCount < 2 ||
      candidate.transcriptTiming?.approximate === true
    ) {
      candidates.push(noSafetyCandidate(candidate, "semantic_review_required_before_waveform_binding", {
        maxSnapFrames: options.maxSnapFrames,
      }));
      continue;
    }

    const scopedTokens = candidateTokens(tokens, candidate);
    const matchingClips = clips.filter((clip) =>
      clipContainsCandidate(clip, scopedTokens) &&
      clipMatchesTokens(clip, scopedTokens) &&
      clipMatchesTarget(clip, repeatInput.target)
    );
    if (matchingClips.length !== 1) {
      candidates.push(noSafetyCandidate(
        candidate,
        matchingClips.length === 0
          ? "target_clip_or_source_not_verified"
          : "ambiguous_target_clip_mapping",
        {
          maxSnapFrames: options.maxSnapFrames,
          matchingClipCount: matchingClips.length,
        },
      ));
      continue;
    }
    const clip = matchingClips[0];
    if (clip.issues.length > 0) {
      candidates.push(noSafetyCandidate(candidate, "target_media_fingerprint_or_mapping_mismatch", {
        maxSnapFrames: options.maxSnapFrames,
        mediaIssues: clip.issues,
      }));
      continue;
    }

    let audio;
    try {
      audio = await decodeClipAudio(clip, options, audioCache);
    } catch (error) {
      candidates.push(noSafetyCandidate(candidate, "target_media_audio_decode_failed", {
        maxSnapFrames: options.maxSnapFrames,
        decodeError: clean(error?.message ?? error),
      }));
      continue;
    }

    const startBoundary = boundaryCandidates({
      role: "cut_start_before_removed_attempt",
      transcriptSeconds: candidate.transcriptTiming.startSeconds,
      transcriptFrame: candidate.transcriptTiming.snappedStartFrame,
      clip,
      audio,
      options,
    });
    const endBoundary = boundaryCandidates({
      role: "cut_end_before_kept_restart",
      transcriptSeconds: candidate.transcriptTiming.endSeconds,
      transcriptFrame: candidate.transcriptTiming.snappedEndFrame,
      clip,
      audio,
      options,
    });
    if (!startBoundary.selected || !endBoundary.selected) {
      candidates.push(noSafetyCandidate(candidate, "low_energy_boundary_handle_not_found", {
        maxSnapFrames: options.maxSnapFrames,
        boundaryAnalysis: { start: startBoundary, end: endBoundary },
      }));
      continue;
    }
    if (endBoundary.selected.frame <= startBoundary.selected.frame) {
      candidates.push(noSafetyCandidate(candidate, "verified_boundaries_do_not_form_positive_range", {
        maxSnapFrames: options.maxSnapFrames,
        boundaryAnalysis: { start: startBoundary, end: endBoundary },
      }));
      continue;
    }

    const scopedCutRange = {
      startFrame: startBoundary.selected.frame,
      endFrame: endBoundary.selected.frame,
      candidateKey: candidateKey(candidate),
      candidateIndex: candidate.index,
    };
    const scopedSafety = {
      required: true,
      maxSnapFrames: options.maxSnapFrames,
      boundaryFrames: [scopedCutRange.startFrame, scopedCutRange.endFrame],
      boundaryRanges: [
        { ...startBoundary.verifiedFrameRange, role: "cut_start", candidateIndex: candidate.index },
        { ...endBoundary.verifiedFrameRange, role: "cut_end", candidateIndex: candidate.index },
      ],
      cutRanges: [scopedCutRange],
    };
    const scopedProposal = proposePremiereRepeatCuts({
      ...repeatInput,
      waveformSafety: scopedSafety,
    }, {
      requireWaveformSafety: true,
      maxBoundarySnapFrames: options.maxSnapFrames,
    });
    const verifiedCandidate = scopedProposal.candidates.find(
      (item) => candidateKey(item) === candidateKey(candidate),
    );
    if (!verifiedCandidate?.proposalEligible || verifiedCandidate.waveformSafety?.verified !== true) {
      candidates.push(noSafetyCandidate(candidate, "candidate_scoped_waveform_evidence_not_bound", {
        maxSnapFrames: options.maxSnapFrames,
        boundaryAnalysis: { start: startBoundary, end: endBoundary },
      }));
      continue;
    }

    candidates.push({
      ...verifiedCandidate,
      waveformSafety: {
        ...verifiedCandidate.waveformSafety,
        thresholdMode: "peak",
        silenceThresholdDb: options.silenceDb,
        minHandleFrames: options.minHandleFrames,
        boundaryFrames: scopedSafety.boundaryFrames,
        boundaryRanges: scopedSafety.boundaryRanges,
        cutRanges: scopedSafety.cutRanges,
        boundaryAnalysis: { start: startBoundary, end: endBoundary },
        sourceMapping: {
          timelineClipIndex: clip.timelineClipIndex,
          clipNodeId: clip.clipNodeId || null,
          clipNodeIds: clip.clipNodeIds,
          projectItemNodeId: clip.projectItemNodeId || null,
          clipName: clip.name || path.basename(clip.media),
          media: clip.media,
          timelineStartSeconds: round(clip.timelineStart),
          timelineEndSeconds: round(clip.timelineEnd),
          sourceInSeconds: round(clip.sourceIn),
          sourceOutSeconds: round(clip.sourceOut),
          cutSourceStartSeconds: round(sourceSecondsForTimeline(
            clip,
            scopedCutRange.startFrame / options.fps,
          )),
          cutSourceEndSeconds: round(sourceSecondsForTimeline(
            clip,
            scopedCutRange.endFrame / options.fps,
          )),
          mediaFingerprint: clip.fingerprint,
        },
        interiorPeakAudit: "not_applicable_removed_speech_is_expected_to_be_voiced",
      },
    });
  }

  candidates.sort((left, right) =>
    left.startFrame - right.startFrame || left.endFrame - right.endFrame || left.type.localeCompare(right.type)
  );
  candidates.forEach((candidate, index) => {
    candidate.index = index;
  });
  const aggregate = aggregateRanges(candidates);
  const semanticBoundaryAudit = semanticBoundaryAuditFor(candidates);
  return {
    ...baseProposal,
    generatedAt: new Date().toISOString(),
    candidates,
    summary: summaryFor(candidates),
    contract: {
      ...baseProposal.contract,
      waveformSafety:
        "candidate-scoped paired cutRanges require two low-energy peak-audited boundaries on one verified target clip/source mapping",
      interiorPeakAudit:
        "not applicable; repeated/abandoned speech inside the deletion is intentionally voiced",
    },
    waveformSafety: {
      required: true,
      maxSnapFrames: options.maxSnapFrames,
      ...aggregate,
      scope: "summary; candidate.waveformSafety is the binding authority",
    },
    semanticBoundaryAudit,
    waveformSafetyBinding: {
      schemaVersion: 1,
      offlineOnly: true,
      premiereRead: false,
      premiereWrite: false,
      energyMode: "peak",
      silenceThresholdDb: options.silenceDb,
      sampleRate: options.sampleRate,
      envelopeFrameSeconds: options.frameSeconds,
      minHandleFrames: options.minHandleFrames,
      maxSnapFrames: options.maxSnapFrames,
      clipCaptureFps: captureFps,
      captureSha256: clean(clipSpec.captureSha256) || null,
      targetBindingSha256: clean(clipSpec.targetBindingSha256) || null,
      bundleSha256: clean(clipSpec.bundleSha256) || null,
      clipCount: clips.length,
      decodedMediaCount: audioCache.size,
      verifiedCandidateCount: candidates.filter((candidate) => candidate.proposalEligible).length,
      reviewOnlyCandidateCount: candidates.filter((candidate) => !candidate.proposalEligible).length,
    },
  };
}

export const bindPremiereRepeatCutsToWaveform = attachPremiereSemanticWaveformSafety;
