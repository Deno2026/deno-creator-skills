import {contextBoundaryPenalty} from "../regroup-mfa-caption-context.mjs";

const EPSILON = 1e-7;

export const DEFAULT_CAPTION_OPTIONS = Object.freeze({
  fps: 30,
  sequenceDurationSeconds: null,
  maxCueCharacters: 84,
  maxCueDurationSeconds: 12,
  minCueDurationSeconds: 0.8,
  hardPauseSeconds: 0.65,
  maxWordsPerCue: null,
  leadInSeconds: 0.04,
  tailSeconds: 0.12,
  maxLineLength: 42,
  cutBoundariesSeconds: [],
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

function cleanToken(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function readingLength(value) {
  return [...String(value ?? "").replace(/\s/gu, "")].length;
}

function normalizeWord(word, index) {
  const text = cleanToken(word?.text);
  const startSeconds = finiteNumber(word?.startSeconds ?? word?.start, `words[${index}].startSeconds`);
  const endSeconds = finiteNumber(word?.endSeconds ?? word?.end, `words[${index}].endSeconds`);
  if (!text) throw new Error(`words[${index}].text is empty.`);
  if (startSeconds < 0 || endSeconds <= startSeconds) {
    throw new Error(`words[${index}] has an invalid time range.`);
  }
  return {
    ...word,
    text,
    startSeconds,
    endSeconds,
  };
}

export function normalizeTimedWords(words) {
  if (!Array.isArray(words)) throw new TypeError("words must be an array.");
  const normalized = words.map(normalizeWord).sort(
    (left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds,
  );
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].startSeconds + EPSILON < normalized[index - 1].startSeconds) {
      throw new Error("words must be sortable by start time.");
    }
  }
  return normalized;
}

function clipSourceDuration(clip) {
  return finiteNumber(clip.outPointSeconds, "clip.outPointSeconds") -
    finiteNumber(clip.inPointSeconds, "clip.inPointSeconds");
}

function clipTimelineDuration(clip) {
  return finiteNumber(clip.endSeconds, "clip.endSeconds") -
    finiteNumber(clip.startSeconds, "clip.startSeconds");
}

export function mapSourceWordsToTimeline(words, clips) {
  const sourceWords = normalizeTimedWords(words);
  if (!Array.isArray(clips) || clips.length === 0) return [];
  const orderedClips = [...clips].sort(
    (left, right) => Number(left.startSeconds) - Number(right.startSeconds),
  );
  const mapped = [];

  for (let clipIndex = 0; clipIndex < orderedClips.length; clipIndex += 1) {
    const clip = orderedClips[clipIndex];
    const sourceIn = finiteNumber(clip.inPointSeconds, `clips[${clipIndex}].inPointSeconds`);
    const sourceOut = finiteNumber(clip.outPointSeconds, `clips[${clipIndex}].outPointSeconds`);
    const timelineStart = finiteNumber(clip.startSeconds, `clips[${clipIndex}].startSeconds`);
    const sourceDuration = clipSourceDuration(clip);
    const timelineDuration = clipTimelineDuration(clip);
    if (!(sourceDuration > 0) || !(timelineDuration > 0)) {
      throw new Error(`clips[${clipIndex}] has an invalid source or timeline duration.`);
    }
    const scale = timelineDuration / sourceDuration;

    for (const word of sourceWords) {
      const midpoint = (word.startSeconds + word.endSeconds) / 2;
      const isLastClip = clipIndex === orderedClips.length - 1;
      if (midpoint + EPSILON < sourceIn) continue;
      if (isLastClip ? midpoint - EPSILON > sourceOut : midpoint >= sourceOut - EPSILON) continue;

      const clampedStart = Math.max(sourceIn, word.startSeconds);
      const clampedEnd = Math.min(sourceOut, word.endSeconds);
      if (clampedEnd <= clampedStart + EPSILON) continue;
      mapped.push({
        ...word,
        sourceStartSeconds: word.startSeconds,
        sourceEndSeconds: word.endSeconds,
        startSeconds: timelineStart + (clampedStart - sourceIn) * scale,
        endSeconds: timelineStart + (clampedEnd - sourceIn) * scale,
        timelineClipIndex: clipIndex,
        timelineTrackIndex: clip.trackIndex ?? null,
      });
    }
  }

  return normalizeTimedWords(mapped);
}

function transcriptItemForClip(items, clip) {
  const nodeMatch = items.find(
    (item) =>
      item?.nodeId &&
      clip?.projectItemNodeId &&
      String(item.nodeId) === String(clip.projectItemNodeId),
  );
  if (nodeMatch) return nodeMatch;
  const byName = items.filter((item) => item?.name === clip?.name);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(`Transcript item name is ambiguous: ${clip.name}`);
  }
  return null;
}

function normalizeTranscriptMapOptions(trackIndices, mappingOptions) {
  if (Array.isArray(trackIndices)) {
    return {
      trackIndices,
      ...(mappingOptions ?? {}),
    };
  }
  if (trackIndices && typeof trackIndices === "object") {
    return {
      ...trackIndices,
      trackIndices: Array.isArray(trackIndices.trackIndices) ? trackIndices.trackIndices : [0],
    };
  }
  throw new TypeError("trackIndices must be an array or a mapping options object.");
}

function targetFilterFromOptions(options) {
  const target = options.target && typeof options.target === "object"
    ? options.target
    : (options.targetItem && typeof options.targetItem === "object" ? options.targetItem : {});
  const name = cleanToken(
    options.targetName ?? (typeof options.target === "string" ? options.target : target.name),
  );
  const projectItemNodeId = cleanToken(
    options.targetProjectItemNodeId ??
      options.targetItemNodeId ??
      options.targetNodeId ??
      target.projectItemNodeId ??
      target.itemNodeId ??
      target.nodeId,
  );
  const clipNodeId = cleanToken(options.targetClipNodeId ?? target.clipNodeId);
  if (!name && !projectItemNodeId && !clipNodeId) return null;
  return { name, projectItemNodeId, clipNodeId };
}

function clipMatchesTarget(clip, target) {
  if (target.name && cleanToken(clip?.name) !== target.name) return false;
  if (
    target.projectItemNodeId &&
    cleanToken(clip?.projectItemNodeId) !== target.projectItemNodeId
  ) {
    return false;
  }
  if (target.clipNodeId && cleanToken(clip?.nodeId) !== target.clipNodeId) return false;
  return true;
}

export function mapPremiereTranscriptToTimeline(
  transcriptItems,
  audioTimeline,
  trackIndices = [0],
  mappingOptions = {},
) {
  if (!Array.isArray(transcriptItems)) throw new TypeError("transcriptItems must be an array.");
  if (!Array.isArray(audioTimeline)) throw new TypeError("audioTimeline must be an array.");
  const options = normalizeTranscriptMapOptions(trackIndices, mappingOptions);
  const selectedTracks = new Set(options.trackIndices.map((value) => Number(value)));
  const target = targetFilterFromOptions(options);
  const trackClips = audioTimeline.filter((clip) => selectedTracks.has(Number(clip.trackIndex)));
  const selectedClips = target
    ? trackClips.filter((clip) => clipMatchesTarget(clip, target))
    : trackClips;
  if (selectedClips.length === 0) throw new Error("No audio clips matched the selected dialogue tracks.");

  const clipsByItem = new Map();
  for (const clip of selectedClips) {
    const item = transcriptItemForClip(transcriptItems, clip);
    if (!item) {
      if (options.allowMissingNonTarget === true && !target) continue;
      throw new Error(`No Premiere transcript found for clip: ${clip.name}`);
    }
    if (!Array.isArray(item.words) || item.words.length === 0) {
      if (options.allowMissingNonTarget === true && !target) continue;
      throw new Error(`Premiere transcript is empty for clip: ${clip.name}`);
    }
    const key = item.nodeId || item.name;
    if (!clipsByItem.has(key)) clipsByItem.set(key, { item, clips: [] });
    clipsByItem.get(key).clips.push(clip);
  }

  if (clipsByItem.size === 0) {
    throw new Error("No transcript-backed audio clips matched the requested mapping scope.");
  }

  const result = [];
  for (const { item, clips } of clipsByItem.values()) {
    result.push(...mapSourceWordsToTimeline(item.words, clips));
  }
  return normalizeTimedWords(result);
}

function joinTokens(words) {
  return words.map((word) => cleanToken(word.text)).filter(Boolean).join(" ")
    .replace(/\s+([,.!?;:。，、！？；：])/gu, "$1")
    .replace(/([([{“‘])\s+/gu, "$1")
    .replace(/\s+([)\]}”’])/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function terminalToken(text) {
  return /[.!?。！？][)\]}”’'"]*$/u.test(text);
}

function timelineClipIndexAt(group, position) {
  const word = position === "first" ? group.words[0] : group.words.at(-1);
  return word?.timelineClipIndex;
}

function crossesTimelineClipBoundary(left, right) {
  if (right.words[0]?.hardBoundaryBefore === true) return true;
  const leftClipIndex = timelineClipIndexAt(left, "last");
  const rightClipIndex = timelineClipIndexAt(right, "first");
  return leftClipIndex !== undefined && leftClipIndex !== null &&
    rightClipIndex !== undefined && rightClipIndex !== null &&
    leftClipIndex !== rightClipIndex;
}

function canMergeGroups(left, right, options) {
  if (crossesTimelineClipBoundary(left, right)) return false;
  if (right.words[0].startSeconds - left.words.at(-1).endSeconds >= options.hardPauseSeconds - EPSILON) return false;
  return groupFits([...left.words, ...right.words], options);
}

function groupFits(words, options) {
  const text = applyCaptionReplacements(joinTokens(words), options.replacements);
  const lines = wrapCaptionText(text, options.maxLineLength);
  return readingLength(text) <= options.maxCueCharacters &&
    words.at(-1).endSeconds - words[0].startSeconds <= options.maxCueDurationSeconds + EPSILON &&
    (options.maxWordsPerCue === null || words.length <= options.maxWordsPerCue) &&
    lines.every((line) => [...line].length <= options.maxLineLength);
}

function phraseSplit(words, options) {
  let best = null;
  for (let index = 1; index < words.length; index += 1) {
    if (!groupFits(words.slice(0, index), options) || !groupFits(words.slice(index), options)) continue;
    const left = words[index - 1];
    const right = words[index];
    const gap = Math.max(0, right.startSeconds - left.endSeconds);
    const score = contextBoundaryPenalty(left.text, right.text) / 50 +
      (words.length - index) * 2 - gap * 20;
    if (!best || score < best.score) best = {index, score};
  }
  return best?.index ?? words.length - 1;
}

function canKeepShortTerminalGroup(groups, index, options, sequenceDuration) {
  const group = groups[index];
  if (!terminalToken(group.words.at(-1).text)) return false;

  const first = group.words[0];
  const last = group.words.at(-1);
  const previous = groups[index - 1];
  const next = groups[index + 1];
  const availableStart = previous ? previous.words.at(-1).endSeconds : 0;
  const availableEnd = next
    ? next.words[0].startSeconds
    : (sequenceDuration ?? last.endSeconds + options.minCueDurationSeconds);

  return availableStart <= first.startSeconds + EPSILON &&
    availableEnd + EPSILON >= last.endSeconds &&
    availableEnd - availableStart + EPSILON >= options.minCueDurationSeconds;
}

function mergeShortGroups(groups, options, sequenceDuration) {
  const merged = groups.map((group) => ({ words: [...group.words] }));
  for (let index = 0; index < merged.length; index += 1) {
    const group = merged[index];
    const duration = group.words.at(-1).endSeconds - group.words[0].startSeconds;
    if (duration + EPSILON >= options.minCueDurationSeconds) continue;
    if (canKeepShortTerminalGroup(merged, index, options, sequenceDuration)) continue;
    if (index + 1 < merged.length && canMergeGroups(group, merged[index + 1], options)) {
      merged[index + 1].words.unshift(...group.words);
      merged.splice(index, 1);
      index -= 1;
    } else if (index > 0 && canMergeGroups(merged[index - 1], group, options)) {
      merged[index - 1].words.push(...group.words);
      merged.splice(index, 1);
      index -= 1;
    }
  }
  return merged;
}

function segmentWords(words, options, sequenceDuration) {
  const groups = [];
  let current = [];
  const flush = () => {
    if (current.length > 0) groups.push({ words: current });
    current = [];
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const previous = current.at(-1);
    if (previous) {
      const proposed = [...current, word];
      const gap = word.startSeconds - previous.endSeconds;
      if (
        crossesTimelineClipBoundary({words: current}, {words: [word]}) ||
        gap >= options.hardPauseSeconds - EPSILON
      ) {
        flush();
      } else if (!groupFits(proposed, options)) {
        const split = phraseSplit(proposed, options);
        groups.push({words: current.slice(0, split)});
        current = current.slice(split);
      }
    }

    current.push(word);
    const next = words[index + 1];
    const nextGap = next ? next.startSeconds - word.endSeconds : Infinity;
    if (
      !next ||
      nextGap >= options.hardPauseSeconds - EPSILON ||
      terminalToken(word.text)
    ) {
      flush();
    }
  }
  return mergeShortGroups(groups, options, sequenceDuration);
}

function snapFloor(seconds, fps) {
  return Math.floor(seconds * fps + EPSILON) / fps;
}

function snapCeil(seconds, fps) {
  return Math.ceil(seconds * fps - EPSILON) / fps;
}

function bestTwoLineSplit(words, maxLineLength) {
  const full = joinTokens(words.map((text) => ({ text })));
  if ([...full].length <= maxLineLength) return [full];
  let best = null;
  for (let index = 1; index < words.length; index += 1) {
    const left = joinTokens(words.slice(0, index).map((text) => ({ text })));
    const right = joinTokens(words.slice(index).map((text) => ({ text })));
    const leftLength = [...left].length;
    const rightLength = [...right].length;
    if (leftLength > maxLineLength || rightLength > maxLineLength) continue;
    const score = Math.abs(leftLength - rightLength) + contextBoundaryPenalty(left, right) / 50;
    if (!best || score < best.score) best = { score, lines: [left, right] };
  }
  return best?.lines ?? [full];
}

export function applyCaptionReplacements(text, replacements = {}) {
  let result = String(text ?? "");
  const entries = Array.isArray(replacements)
    ? replacements.map((entry) => [entry?.from, entry?.to])
    : Object.entries(replacements ?? {});
  for (const [from, to] of entries) {
    if (!from || typeof to !== "string") continue;
    result = result.split(String(from)).join(to);
  }
  return result;
}

function wrapCaptionText(text, maxLineLength) {
  const words = String(text).split(/\s+/u).filter(Boolean);
  return bestTwoLineSplit(words, maxLineLength);
}

export function buildCaptionCues(inputWords, overrides = {}) {
  let words = normalizeTimedWords(inputWords);
  if (words.length === 0) return [];
  const options = { ...DEFAULT_CAPTION_OPTIONS, ...overrides };
  options.fps = positiveNumber(options.fps, "fps");
  options.maxCueCharacters = positiveNumber(options.maxCueCharacters, "maxCueCharacters");
  options.maxCueDurationSeconds = positiveNumber(
    options.maxCueDurationSeconds,
    "maxCueDurationSeconds",
  );
  options.minCueDurationSeconds = positiveNumber(
    options.minCueDurationSeconds,
    "minCueDurationSeconds",
  );
  options.hardPauseSeconds = positiveNumber(options.hardPauseSeconds, "hardPauseSeconds");
  options.maxWordsPerCue = options.maxWordsPerCue === null
    ? null
    : positiveNumber(options.maxWordsPerCue, "maxWordsPerCue");
  options.maxLineLength = positiveNumber(options.maxLineLength, "maxLineLength");
  if (!Array.isArray(options.cutBoundariesSeconds)) throw new TypeError("cutBoundariesSeconds must be an array.");
  const cuts = options.cutBoundariesSeconds.map((value) => finiteNumber(value, "cut boundary"));
  words = words.map((word, index) => ({
    ...word,
    hardBoundaryBefore: word.hardBoundaryBefore === true || (index > 0 && cuts.some(
      (cut) => cut > words[index - 1].startSeconds + EPSILON && cut <= word.startSeconds + EPSILON,
    )),
  }));
  const sequenceDuration = options.sequenceDurationSeconds === null
    ? null
    : positiveNumber(options.sequenceDurationSeconds, "sequenceDurationSeconds");

  const groups = segmentWords(words, options, sequenceDuration);
  const rawCues = groups.map((group, index) => {
    const first = group.words[0];
    const last = group.words.at(-1);
    const text = applyCaptionReplacements(joinTokens(group.words), options.replacements);
    const previousSpeechEnd = index > 0 ? groups[index - 1].words.at(-1).endSeconds : 0;
    let startSeconds = snapFloor(Math.max(
      0,
      first.startSeconds - options.leadInSeconds,
      Math.min(first.startSeconds, previousSpeechEnd),
    ), options.fps);
    let endSeconds = snapCeil(last.endSeconds + options.tailSeconds, options.fps);
    const maxEnd = sequenceDuration ?? Infinity;
    endSeconds = Math.min(maxEnd, endSeconds);
    if (endSeconds <= startSeconds) endSeconds = Math.min(maxEnd, startSeconds + 1 / options.fps);
    return {
      index: index + 1,
      startSeconds,
      endSeconds,
      text,
      textLines: wrapCaptionText(text, options.maxLineLength),
      wordStartIndex: words.indexOf(first),
      wordEndIndex: words.indexOf(last),
      wordCount: group.words.length,
    };
  });

  for (let index = 0; index < rawCues.length; index += 1) {
    const cue = rawCues[index];
    const next = rawCues[index + 1];
    if (next && cue.endSeconds > next.startSeconds) cue.endSeconds = next.startSeconds;
    const minimumEnd = cue.startSeconds + options.minCueDurationSeconds;
    if (cue.endSeconds + EPSILON < minimumEnd) {
      const availableEnd = next ? next.startSeconds : (sequenceDuration ?? minimumEnd);
      cue.endSeconds = snapCeil(Math.min(availableEnd, minimumEnd), options.fps);
    }
    if (cue.endSeconds - cue.startSeconds + EPSILON < options.minCueDurationSeconds) {
      const previous = rawCues[index - 1];
      const availableStart = previous ? previous.endSeconds : 0;
      const minimumStart = cue.endSeconds - options.minCueDurationSeconds;
      if (minimumStart + EPSILON >= availableStart) {
        cue.startSeconds = Math.max(
          availableStart,
          snapFloor(minimumStart, options.fps),
        );
      }
    }
    if (cue.endSeconds <= cue.startSeconds + EPSILON) {
      throw new Error(`Cue ${index + 1} collapsed after frame alignment.`);
    }
  }
  return rawCues;
}

export function formatSrtTime(seconds) {
  const totalMilliseconds = Math.max(0, Math.round(finiteNumber(seconds, "seconds") * 1000));
  const milliseconds = totalMilliseconds % 1000;
  const totalSeconds = Math.floor(totalMilliseconds / 1000);
  const secondsPart = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secondsPart).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

export function formatSrt(cues, { bom = true, crlf = true } = {}) {
  if (!Array.isArray(cues)) throw new TypeError("cues must be an array.");
  const newline = crlf ? "\r\n" : "\n";
  const blocks = cues.map((cue, index) => {
    const lines = Array.isArray(cue.textLines) && cue.textLines.length > 0
      ? cue.textLines
      : [String(cue.text ?? "").trim()];
    return [
      String(index + 1),
      `${formatSrtTime(cue.startSeconds)} --> ${formatSrtTime(cue.endSeconds)}`,
      ...lines,
    ].join(newline);
  });
  return `${bom ? "\uFEFF" : ""}${blocks.join(`${newline}${newline}`)}${newline}`;
}
