const EPSILON = 1e-7;

const DEFAULT_FILLER_TOKENS = Object.freeze([
  "아",
  "어",
  "어어",
  "음",
  "음음",
  "으",
  "흠",
  "그",
  "저",
  "뭐",
  "네",
  "예",
  "자",
  "약간",
  "그러니까",
]);

export const DEFAULT_REPEAT_CUT_OPTIONS = Object.freeze({
  fps: 30,
  maxPhraseTokens: 4,
  maxImmediateGapSeconds: 1.25,
  maxFirstAttemptSeconds: 4,
  maxRestartAttemptTokens: 6,
  maxBoundarySnapFrames: null,
  requireWaveformSafety: false,
  fillerTokens: DEFAULT_FILLER_TOKENS,
});

export const PREMIERE_REPEAT_CUT_INPUT_SCHEMA = Object.freeze({
  schemaVersion: 1,
  required: ["fps", "one of words | transcript.words | timelineWords.words"],
  properties: {
    schemaVersion: "integer; currently 1",
    fps: "positive number",
    words:
      "array of {text,startSeconds,endSeconds}; timelineStartSeconds/timelineEndSeconds are also accepted and take precedence",
    target: "optional source identity copied to the proposal",
    waveformSafety: {
      required: "optional boolean; unmatched or absent safety forces reviewRequired=true",
      maxSnapFrames: "optional non-negative integer",
      boundaryFrames: "optional integer frame[] of waveform-verified razor points",
      boundaryRanges:
        "optional {startFrame,endFrame}[] windows in which a transcript boundary may be clamped",
      cutRanges:
        "optional {startFrame,endFrame}[] paired waveform-verified deletion boundaries",
    },
  },
  notes: [
    "Transcript timing is evidence for repeat/restart judgment, not proof of a safe razor point.",
    "All emitted boundaries are integer frames.",
    "The library is offline proposal-only and performs no Premiere write.",
  ],
});

export const PREMIERE_REPEAT_CUT_OUTPUT_SCHEMA = Object.freeze({
  schemaVersion: 1,
  mode: "premiere_repeat_cut_proposal",
  dryRun: true,
  offlineOnly: true,
  candidateRequiredFields: [
    "type",
    "reasonCode",
    "reason",
    "confidence",
    "reviewRequired",
    "startFrame",
    "endFrame",
    "waveformSafety",
  ],
  confidenceValues: ["high", "medium", "low"],
  waveformSafetyStatuses: [
    "verified_cut_range",
    "verified_boundaries",
    "not_provided",
    "unverified_no_match",
  ],
});

function finiteNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number.`);
  return parsed;
}

function positiveNumber(value, name) {
  const parsed = finiteNumber(value, name);
  if (!(parsed > 0)) throw new Error(`${name} must be greater than zero.`);
  return parsed;
}

function nonNegativeInteger(value, name) {
  const parsed = finiteNumber(value, name);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer frame.`);
  }
  return parsed;
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function normalizeToken(value) {
  return cleanText(value)
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "")
    .trim();
}

function hasTerminalPunctuation(value) {
  return /[.!?。！？][)\]}”’'"]*$/u.test(cleanText(value));
}

function hasCutoffPunctuation(value) {
  return /(?:\.{2,}|…+|[-‐‑‒–—―~～])[)\]}”’'"]*$/u.test(cleanText(value));
}

function round(value, digits = 6) {
  return Number(value.toFixed(digits));
}

function wordTimes(word, index) {
  const startSeconds = finiteNumber(
    word?.timelineStartSeconds ?? word?.startSeconds ?? word?.start,
    `words[${index}].startSeconds`,
  );
  const endSeconds = finiteNumber(
    word?.timelineEndSeconds ?? word?.endSeconds ?? word?.end,
    `words[${index}].endSeconds`,
  );
  if (startSeconds < 0 || endSeconds <= startSeconds) {
    throw new Error(`words[${index}] has an invalid time range.`);
  }
  return { startSeconds, endSeconds };
}

function tokenScope(word) {
  return {
    timelineClipIndex: word?.timelineClipIndex ?? null,
    clipNodeId: cleanText(word?.clipNodeId ?? word?.timelineClipNodeId),
    projectItemNodeId: cleanText(word?.projectItemNodeId),
  };
}

export function normalizeRepeatCutWords(inputWords) {
  if (!Array.isArray(inputWords)) throw new TypeError("words must be an array.");
  const tokens = [];

  for (let wordIndex = 0; wordIndex < inputWords.length; wordIndex += 1) {
    const word = inputWords[wordIndex];
    const text = cleanText(word?.text);
    if (!text) throw new Error(`words[${wordIndex}].text is empty.`);
    const { startSeconds, endSeconds } = wordTimes(word, wordIndex);
    const parts = text.split(/\s+/u).filter(Boolean);
    const duration = endSeconds - startSeconds;
    const scope = tokenScope(word);

    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const tokenText = parts[partIndex];
      const normalized = normalizeToken(tokenText);
      if (!normalized) continue;
      const partStart = startSeconds + duration * (partIndex / parts.length);
      const partEnd = startSeconds + duration * ((partIndex + 1) / parts.length);
      tokens.push({
        index: tokens.length,
        text: tokenText,
        normalized,
        startSeconds: partStart,
        endSeconds: partEnd,
        sourceWordIndex: wordIndex,
        approximateTiming: parts.length > 1,
        terminalAfter: partIndex === parts.length - 1 && hasTerminalPunctuation(text),
        cutoffAfter:
          partIndex === parts.length - 1 &&
          (hasCutoffPunctuation(text) ||
            word?.cutoffAfter === true ||
            word?.restartAfter === true ||
            word?.abandoned === true),
        cutoffSource:
          word?.cutoffAfter === true || word?.restartAfter === true || word?.abandoned === true
            ? "explicit_metadata"
            : (partIndex === parts.length - 1 && hasCutoffPunctuation(text)
                ? "transcript_punctuation"
                : null),
        ...scope,
      });
    }
  }

  tokens.sort((left, right) =>
    left.startSeconds - right.startSeconds ||
    left.endSeconds - right.endSeconds ||
    left.sourceWordIndex - right.sourceWordIndex
  );
  tokens.forEach((token, index) => {
    token.index = index;
  });
  return tokens;
}

function inputWords(input) {
  if (Array.isArray(input?.words)) return input.words;
  if (Array.isArray(input?.transcript?.words)) return input.transcript.words;
  if (Array.isArray(input?.timelineWords?.words)) return input.timelineWords.words;
  throw new Error("Input must contain words, transcript.words, or timelineWords.words.");
}

function sameTokenScope(tokens) {
  const fields = ["timelineClipIndex", "clipNodeId", "projectItemNodeId"];
  for (const field of fields) {
    const values = new Set(
      tokens
        .map((token) => token[field])
        .filter((value) => value !== null && value !== undefined && value !== "")
        .map(String),
    );
    if (values.size > 1) return false;
  }
  return true;
}

function tokenText(tokens) {
  return tokens.map((token) => token.text).join(" ").replace(/\s+/gu, " ").trim();
}

function isAllFiller(tokens, fillerSet) {
  return tokens.length > 0 && tokens.every((token) => fillerSet.has(token.normalized));
}

function sequencesEqual(tokens, leftStart, rightStart, length) {
  for (let offset = 0; offset < length; offset += 1) {
    if (tokens[leftStart + offset]?.normalized !== tokens[rightStart + offset]?.normalized) {
      return false;
    }
  }
  return true;
}

function immediateGap(tokens, firstEndIndex, secondStartIndex) {
  return tokens[secondStartIndex].startSeconds - tokens[firstEndIndex].endSeconds;
}

function isImmediateGap(gapSeconds, options) {
  return gapSeconds >= -0.25 - EPSILON &&
    gapSeconds <= options.maxImmediateGapSeconds + EPSILON;
}

function exactRepeatCandidates(tokens, options, fillerSet) {
  const candidates = [];
  for (let start = 0; start < tokens.length - 1; start += 1) {
    let match = null;
    const maxLength = Math.min(
      options.maxPhraseTokens,
      Math.floor((tokens.length - start) / 2),
    );

    for (let length = maxLength; length >= 1; length -= 1) {
      const secondStart = start + length;
      if (!sequencesEqual(tokens, start, secondStart, length)) continue;
      const first = tokens.slice(start, secondStart);
      const both = tokens.slice(start, secondStart + length);
      if (!sameTokenScope(both)) continue;
      if (isAllFiller(first, fillerSet)) continue;
      if (first.at(-1).terminalAfter && !first.at(-1).cutoffAfter) continue;
      const gapSeconds = immediateGap(tokens, secondStart - 1, secondStart);
      if (!isImmediateGap(gapSeconds, options)) continue;
      const attemptSeconds = first.at(-1).endSeconds - first[0].startSeconds;
      if (attemptSeconds > options.maxFirstAttemptSeconds + EPSILON) continue;
      match = {
        type: "exact_adjacent_repeat",
        reasonCode: "exact_adjacent_repeat_1_to_4_tokens",
        startTokenIndex: start,
        removeEndTokenIndex: secondStart - 1,
        keptStartTokenIndex: secondStart,
        keptEndTokenIndex: secondStart + length - 1,
        phraseTokenCount: length,
        commonPrefixTokenCount: length,
        gapSeconds,
        cutoffSource: first.at(-1).cutoffSource,
      };
      break;
    }

    if (match) candidates.push(match);
  }
  const selected = [];
  for (const candidate of candidates) {
    if (selected.some((other) => tokenRangesOverlap(candidate, other))) continue;
    selected.push(candidate);
  }
  return selected;
}

function commonPrefixLength(tokens, leftStart, rightStart, maximum) {
  let length = 0;
  while (
    length < maximum &&
    rightStart + length < tokens.length &&
    tokens[leftStart + length]?.normalized === tokens[rightStart + length]?.normalized
  ) {
    length += 1;
  }
  return length;
}

function tokenRangesOverlap(left, right) {
  return left.startTokenIndex < right.keptStartTokenIndex &&
    right.startTokenIndex < left.keptStartTokenIndex;
}

function restartCandidates(tokens, exactCandidates, options, fillerSet) {
  const candidates = [];
  for (let start = 0; start < tokens.length - 2; start += 1) {
    let best = null;
    const lastRestartStart = Math.min(
      tokens.length - 2,
      start + options.maxRestartAttemptTokens,
    );

    for (let restartStart = start + 1; restartStart <= lastRestartStart; restartStart += 1) {
      const attempt = tokens.slice(start, restartStart);
      const cutoff = attempt.at(-1);
      if (!cutoff.cutoffAfter) continue;
      if (isAllFiller(attempt, fillerSet)) continue;
      const gapSeconds = immediateGap(tokens, restartStart - 1, restartStart);
      if (!isImmediateGap(gapSeconds, options)) continue;
      const attemptSeconds = cutoff.endSeconds - attempt[0].startSeconds;
      if (attemptSeconds > options.maxFirstAttemptSeconds + EPSILON) continue;

      const prefixLength = commonPrefixLength(
        tokens,
        start,
        restartStart,
        Math.min(options.maxPhraseTokens, attempt.length),
      );
      if (prefixLength < 1 || prefixLength >= attempt.length) continue;
      if (restartStart + prefixLength >= tokens.length) continue;
      const evidenceTokens = tokens.slice(start, restartStart + prefixLength + 1);
      if (!sameTokenScope(evidenceTokens)) continue;

      const candidate = {
        type: "immediate_restart",
        reasonCode: "explicit_cutoff_then_immediate_prefix_restart",
        startTokenIndex: start,
        removeEndTokenIndex: restartStart - 1,
        keptStartTokenIndex: restartStart,
        keptEndTokenIndex: restartStart + prefixLength - 1,
        phraseTokenCount: attempt.length,
        commonPrefixTokenCount: prefixLength,
        gapSeconds,
        cutoffSource: cutoff.cutoffSource,
      };
      if (exactCandidates.some((exact) => tokenRangesOverlap(candidate, exact))) continue;
      if (
        !best ||
        candidate.commonPrefixTokenCount > best.commonPrefixTokenCount ||
        (candidate.commonPrefixTokenCount === best.commonPrefixTokenCount &&
          candidate.phraseTokenCount < best.phraseTokenCount)
      ) {
        best = candidate;
      }
    }

    if (best) candidates.push(best);
  }
  const selected = [];
  for (const candidate of [...candidates].sort((left, right) =>
    right.commonPrefixTokenCount - left.commonPrefixTokenCount ||
    right.phraseTokenCount - left.phraseTokenCount ||
    left.startTokenIndex - right.startTokenIndex
  )) {
    if (selected.some((other) => tokenRangesOverlap(candidate, other))) continue;
    selected.push(candidate);
  }
  return selected.sort((left, right) => left.startTokenIndex - right.startTokenIndex);
}

function rangeFields(value, name, { allowPoint = false } = {}) {
  if (!value || typeof value !== "object") throw new Error(`${name} must be an object.`);
  const startFrame = nonNegativeInteger(value.startFrame, `${name}.startFrame`);
  const endFrame = nonNegativeInteger(value.endFrame, `${name}.endFrame`);
  if (allowPoint ? endFrame < startFrame : endFrame <= startFrame) {
    throw new Error(`${name} has an invalid frame range.`);
  }
  return {
    ...value,
    startFrame,
    endFrame,
  };
}

function normalizeBoundaryFrames(values, name) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new Error(`${name} must be an array.`);
  const frames = values.map((value, index) =>
    nonNegativeInteger(
      value && typeof value === "object" ? value.frame : value,
      `${name}[${index}]`,
    )
  );
  return [...new Set(frames)].sort((left, right) => left - right);
}

function normalizeRanges(values, name, options) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new Error(`${name} must be an array.`);
  return values
    .map((value, index) => rangeFields(value, `${name}[${index}]`, options))
    .sort((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame);
}

function normalizeWaveformSafety(input, options, fps) {
  const raw = input?.waveformSafety ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("waveformSafety must be an object.");
  }
  const maxSnapFrames = raw.maxSnapFrames ?? options.maxBoundarySnapFrames ?? Math.ceil(fps * 0.4);
  const boundaryFrames = normalizeBoundaryFrames(
    raw.boundaryFrames ?? raw.boundaries,
    "waveformSafety.boundaryFrames",
  );
  const boundaryRanges = normalizeRanges(
    raw.boundaryRanges,
    "waveformSafety.boundaryRanges",
    { allowPoint: true },
  );
  const cutRanges = normalizeRanges(
    raw.cutRanges,
    "waveformSafety.cutRanges",
    { allowPoint: false },
  );
  return {
    required: raw.required === true || options.requireWaveformSafety === true,
    maxSnapFrames: nonNegativeInteger(maxSnapFrames, "waveformSafety.maxSnapFrames"),
    boundaryFrames,
    boundaryRanges,
    cutRanges,
    hasEvidence: boundaryFrames.length > 0 || boundaryRanges.length > 0 || cutRanges.length > 0,
  };
}

function frameDistanceToRange(frame, range) {
  if (frame < range.startFrame) return range.startFrame - frame;
  if (frame > range.endFrame) return frame - range.endFrame;
  return 0;
}

function clampFrameToRange(frame, range) {
  return Math.min(range.endFrame, Math.max(range.startFrame, frame));
}

function nearestBoundary(frame, safety) {
  const choices = [];
  for (const boundaryFrame of safety.boundaryFrames) {
    choices.push({
      frame: boundaryFrame,
      distanceFrames: Math.abs(boundaryFrame - frame),
      source: "boundary_frame",
    });
  }
  for (let index = 0; index < safety.boundaryRanges.length; index += 1) {
    const range = safety.boundaryRanges[index];
    choices.push({
      frame: clampFrameToRange(frame, range),
      distanceFrames: frameDistanceToRange(frame, range),
      source: "boundary_range",
      sourceIndex: index,
      range: { startFrame: range.startFrame, endFrame: range.endFrame },
    });
  }
  return choices
    .filter((choice) => choice.distanceFrames <= safety.maxSnapFrames)
    .sort((left, right) =>
      left.distanceFrames - right.distanceFrames || left.frame - right.frame
    )[0] ?? null;
}

function resolveWaveformSafety(transcriptStartFrame, transcriptEndFrame, safety) {
  if (!safety.hasEvidence) {
    return {
      status: "not_provided",
      verified: false,
      required: safety.required,
      maxSnapFrames: safety.maxSnapFrames,
      startFrame: transcriptStartFrame,
      endFrame: transcriptEndFrame,
    };
  }

  const paired = safety.cutRanges
    .map((range, index) => ({
      range,
      index,
      startDistance: Math.abs(range.startFrame - transcriptStartFrame),
      endDistance: Math.abs(range.endFrame - transcriptEndFrame),
    }))
    .filter(
      (item) =>
        item.startDistance <= safety.maxSnapFrames &&
        item.endDistance <= safety.maxSnapFrames,
    )
    .sort((left, right) =>
      left.startDistance + left.endDistance - (right.startDistance + right.endDistance)
    )[0];

  if (paired) {
    return {
      status: "verified_cut_range",
      verified: true,
      required: safety.required,
      maxSnapFrames: safety.maxSnapFrames,
      startFrame: paired.range.startFrame,
      endFrame: paired.range.endFrame,
      startDistanceFrames: paired.startDistance,
      endDistanceFrames: paired.endDistance,
      cutRangeIndex: paired.index,
    };
  }

  const startBoundary = nearestBoundary(transcriptStartFrame, safety);
  const endBoundary = nearestBoundary(transcriptEndFrame, safety);
  if (startBoundary && endBoundary && startBoundary.frame < endBoundary.frame) {
    return {
      status: "verified_boundaries",
      verified: true,
      required: safety.required,
      maxSnapFrames: safety.maxSnapFrames,
      startFrame: startBoundary.frame,
      endFrame: endBoundary.frame,
      startDistanceFrames: startBoundary.distanceFrames,
      endDistanceFrames: endBoundary.distanceFrames,
      startBoundary,
      endBoundary,
    };
  }

  return {
    status: "unverified_no_match",
    verified: false,
    required: safety.required,
    maxSnapFrames: safety.maxSnapFrames,
    startFrame: transcriptStartFrame,
    endFrame: transcriptEndFrame,
  };
}

function candidateReason(candidate, removedText, keptText) {
  if (candidate.type === "exact_adjacent_repeat") {
    return `바로 이어진 동일 ${candidate.phraseTokenCount}토큰 구절 \"${removedText}\"의 첫 번째 발화를 후보화하고 뒤의 \"${keptText}\"를 보존`;
  }
  return `중단 표식 뒤 ${candidate.commonPrefixTokenCount}토큰이 즉시 다시 시작되어 미완료 발화 \"${removedText}\"를 후보화`;
}

function annotateCandidate(candidate, tokens, fps, safety, index) {
  const removed = tokens.slice(candidate.startTokenIndex, candidate.removeEndTokenIndex + 1);
  const kept = tokens.slice(candidate.keptStartTokenIndex, candidate.keptEndTokenIndex + 1);
  const rawStartSeconds = removed[0].startSeconds;
  const rawEndSeconds = tokens[candidate.keptStartTokenIndex].startSeconds;
  const transcriptStartFrame = Math.ceil(rawStartSeconds * fps - EPSILON);
  const transcriptEndFrame = Math.floor(rawEndSeconds * fps + EPSILON);
  if (transcriptEndFrame <= transcriptStartFrame) return null;

  const waveformSafety = resolveWaveformSafety(transcriptStartFrame, transcriptEndFrame, safety);
  if (waveformSafety.endFrame <= waveformSafety.startFrame) return null;
  const hasApproximateTiming = [...removed, ...kept].some((token) => token.approximateTiming);
  const semanticReview =
    candidate.commonPrefixTokenCount < 2 ||
    candidate.phraseTokenCount < 2 ||
    hasApproximateTiming;
  const reviewReasons = [];
  if (candidate.commonPrefixTokenCount < 2 || candidate.phraseTokenCount < 2) {
    reviewReasons.push("single_token_repeat_can_be_intentional_emphasis");
  }
  if (hasApproximateTiming) reviewReasons.push("timing_was_interpolated_from_multi_token_entry");
  if (!waveformSafety.verified) {
    reviewReasons.push(
      waveformSafety.status === "not_provided"
        ? "waveform_safe_boundary_not_provided"
        : "waveform_safe_boundary_not_matched",
    );
  }
  const reviewRequired = semanticReview || !waveformSafety.verified;
  const confidence = reviewRequired
    ? (semanticReview ? "low" : "medium")
    : "high";
  const startFrame = waveformSafety.startFrame;
  const endFrame = waveformSafety.endFrame;
  const removedText = tokenText(removed);
  const keptText = tokenText(kept);

  return {
    index,
    type: candidate.type,
    reasonCode: candidate.reasonCode,
    reason: candidateReason(candidate, removedText, keptText),
    confidence,
    reviewRequired,
    reviewReasons,
    proposalEligible: !reviewRequired,
    removeOccurrence: "first",
    startFrame,
    endFrame,
    removeFrames: endFrame - startFrame,
    startSeconds: round(startFrame / fps),
    endSeconds: round(endFrame / fps),
    removeSeconds: round((endFrame - startFrame) / fps),
    transcriptTiming: {
      startSeconds: round(rawStartSeconds),
      endSeconds: round(rawEndSeconds),
      snappedStartFrame: transcriptStartFrame,
      snappedEndFrame: transcriptEndFrame,
      approximate: hasApproximateTiming,
      role: "semantic_evidence_only",
    },
    waveformSafety,
    evidence: {
      removedText,
      keptText,
      tokenStartIndex: candidate.startTokenIndex,
      tokenRemoveEndIndex: candidate.removeEndTokenIndex,
      keptTokenStartIndex: candidate.keptStartTokenIndex,
      keptTokenEndIndex: candidate.keptEndTokenIndex,
      phraseTokenCount: candidate.phraseTokenCount,
      commonPrefixTokenCount: candidate.commonPrefixTokenCount,
      immediateGapSeconds: round(candidate.gapSeconds),
      cutoffSource: candidate.cutoffSource ?? null,
    },
  };
}

function normalizeOptions(input, overrides) {
  const inputOptions = input?.options && typeof input.options === "object" ? input.options : {};
  const options = {
    ...DEFAULT_REPEAT_CUT_OPTIONS,
    ...inputOptions,
    ...overrides,
  };
  const requestedFps = overrides.fps ?? input.fps ?? inputOptions.fps;
  if (requestedFps === undefined || requestedFps === null) {
    throw new Error("fps is required so cut boundaries can be emitted as integer frames.");
  }
  options.fps = positiveNumber(requestedFps, "fps");
  options.maxPhraseTokens = nonNegativeInteger(options.maxPhraseTokens, "maxPhraseTokens");
  if (options.maxPhraseTokens < 1 || options.maxPhraseTokens > 4) {
    throw new Error("maxPhraseTokens must be between 1 and 4.");
  }
  options.maxRestartAttemptTokens = nonNegativeInteger(
    options.maxRestartAttemptTokens,
    "maxRestartAttemptTokens",
  );
  if (options.maxRestartAttemptTokens < 2) {
    throw new Error("maxRestartAttemptTokens must be at least 2.");
  }
  options.maxImmediateGapSeconds = positiveNumber(
    options.maxImmediateGapSeconds,
    "maxImmediateGapSeconds",
  );
  options.maxFirstAttemptSeconds = positiveNumber(
    options.maxFirstAttemptSeconds,
    "maxFirstAttemptSeconds",
  );
  if (!Array.isArray(options.fillerTokens)) throw new Error("fillerTokens must be an array.");
  return options;
}

export function proposePremiereRepeatCuts(input, overrides = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("input must be an object.");
  }
  if (input.schemaVersion !== undefined && Number(input.schemaVersion) !== 1) {
    throw new Error(`Unsupported repeat-cut input schemaVersion: ${input.schemaVersion}`);
  }
  const options = normalizeOptions(input, overrides);
  const words = inputWords(input);
  const tokens = normalizeRepeatCutWords(words);
  const fillerSet = new Set(options.fillerTokens.map(normalizeToken).filter(Boolean));
  const safety = normalizeWaveformSafety(input, options, options.fps);
  const exact = exactRepeatCandidates(tokens, options, fillerSet);
  const restarts = restartCandidates(tokens, exact, options, fillerSet);
  const semanticCandidates = [...exact, ...restarts]
    .sort((left, right) =>
      left.startTokenIndex - right.startTokenIndex ||
      left.keptStartTokenIndex - right.keptStartTokenIndex ||
      left.type.localeCompare(right.type)
    );
  const candidates = semanticCandidates
    .map((candidate, index) => annotateCandidate(candidate, tokens, options.fps, safety, index))
    .filter(Boolean);
  candidates.forEach((candidate, index) => {
    candidate.index = index;
  });
  const typeCounts = candidates.reduce((counts, candidate) => {
    counts[candidate.type] = (counts[candidate.type] ?? 0) + 1;
    return counts;
  }, {});

  return {
    schemaVersion: 1,
    mode: "premiere_repeat_cut_proposal",
    dryRun: true,
    offlineOnly: true,
    generatedAt: new Date().toISOString(),
    target: input.target ?? null,
    fps: options.fps,
    contract: {
      transcriptTiming: "semantic_evidence_only",
      cutBoundaries: "integer_frames",
      waveformSafety:
        "verified boundaryFrames/boundaryRanges or paired cutRanges are required for proposalEligible=true",
      applyBehavior: "none; this module never reads or writes Premiere",
    },
    options: {
      maxPhraseTokens: options.maxPhraseTokens,
      maxImmediateGapSeconds: options.maxImmediateGapSeconds,
      maxFirstAttemptSeconds: options.maxFirstAttemptSeconds,
      maxRestartAttemptTokens: options.maxRestartAttemptTokens,
      maxBoundarySnapFrames: safety.maxSnapFrames,
      requireWaveformSafety: safety.required,
    },
    inputSummary: {
      wordCount: words.length,
      tokenCount: tokens.length,
      approximateTimingTokenCount: tokens.filter((token) => token.approximateTiming).length,
      waveformBoundaryCount: safety.boundaryFrames.length,
      waveformBoundaryRangeCount: safety.boundaryRanges.length,
      waveformCutRangeCount: safety.cutRanges.length,
    },
    summary: {
      candidateCount: candidates.length,
      proposalEligibleCount: candidates.filter((candidate) => candidate.proposalEligible).length,
      reviewRequiredCount: candidates.filter((candidate) => candidate.reviewRequired).length,
      typeCounts,
    },
    candidates,
  };
}

export const buildPremiereRepeatCutProposal = proposePremiereRepeatCuts;
