import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {contextBoundaryPenalty} from "./regroup-mfa-caption-context.mjs";

const DEFAULTS = Object.freeze({
  maxLineChars: 42,
  maxCueSeconds: 12,
  maxInternalGapSeconds: 1.5,
});

function cleanText(value) {
  return String(value).replace(/\s+([,.!?;:。，、！？；：])/gu, "$1").replace(/\s+/gu, " ").trim();
}

function parseFps(value) {
  const match = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/u.exec(String(value ?? "").trim());
  if (!match) throw new Error(`Invalid fps: ${value}`);
  const fps = Number(match[1]) / Number(match[2] || 1);
  if (!(fps > 0)) throw new Error(`Invalid fps: ${value}`);
  return fps;
}

function frameToSrt(frame, fps) {
  const totalMs = Math.round(frame * 1000 / fps);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function validateCards(cards) {
  if (!Array.isArray(cards) || cards.length === 0) throw new Error("MFA alignment has no display_cards");
  cards.forEach((card, index) => {
    if (card.index !== index + 1) throw new Error(`display_cards[${index}] index is not contiguous`);
    if (!Number.isInteger(card.start_frame) || !Number.isInteger(card.end_frame_exclusive)) {
      throw new Error(`display_cards[${index}] frame bounds must be integers`);
    }
    if (card.end_frame_exclusive <= card.start_frame) throw new Error(`display_cards[${index}] has non-positive duration`);
    if (!cleanText(card.text)) throw new Error(`display_cards[${index}] has empty text`);
  });
}

function cardText(cards, startOneBased, endOneBased) {
  return cleanText(cards.slice(startOneBased - 1, endOneBased).map((card) => card.text).join(" "));
}

function findLineBreakCard(cards, cueStart, cueEnd, lineOne) {
  const expected = cleanText(lineOne);
  for (let end = cueStart; end < cueEnd; end += 1) {
    if (cardText(cards, cueStart, end) === expected) return end;
  }
  throw new Error(`Could not map line one to display cards ${cueStart}-${cueEnd}: ${expected}`);
}

function findBalancedLineBreakCard(cards, cueStart, cueEnd, maxLineChars = DEFAULTS.maxLineChars) {
  let best = null;
  for (let lineBreak = cueStart; lineBreak < cueEnd; lineBreak += 1) {
    const left = cardText(cards, cueStart, lineBreak);
    const right = cardText(cards, lineBreak + 1, cueEnd);
    if ([...left].length > maxLineChars || [...right].length > maxLineChars) continue;
    const penalty = contextBoundaryPenalty(cards[lineBreak - 1].text, cards[lineBreak].text);
    if (penalty >= 4000) continue;
    const score = Math.abs([...left].length - [...right].length) + penalty / 50;
    if (!best || score < best.score) best = {lineBreak, score};
  }
  if (!best) throw new Error(`Could not balance two lines across display cards ${cueStart}-${cueEnd}`);
  return best.lineBreak;
}

export function seedReviewedLayoutManifest(alignment, regroupReport) {
  const cards = alignment?.display_cards;
  validateCards(cards);
  if (!Array.isArray(regroupReport?.cues) || regroupReport.cues.length === 0) {
    throw new Error("Regroup report has no cues");
  }
  let expectedStart = 1;
  const cues = regroupReport.cues.map((cue, index) => {
    const cueStart = Number(cue.displayCardStart);
    const cueEnd = Number(cue.displayCardEnd);
    if (cueStart !== expectedStart || cueEnd < cueStart) throw new Error(`Regroup cue ${index + 1} is not contiguous`);
    if (!Array.isArray(cue.textLines) || cue.textLines.length < 1 || cue.textLines.length > 2) {
      throw new Error(`Regroup cue ${index + 1} is not one or two lines`);
    }
    let lineBreakAfterDisplayCard = null;
    if (cue.textLines.length === 2) {
      try {
        lineBreakAfterDisplayCard = findLineBreakCard(cards, cueStart, cueEnd, cue.textLines[0]);
      } catch {
        lineBreakAfterDisplayCard = findBalancedLineBreakCard(cards, cueStart, cueEnd);
      }
    } else if ([...cardText(cards, cueStart, cueEnd)].length > DEFAULTS.maxLineChars) {
      lineBreakAfterDisplayCard = findBalancedLineBreakCard(cards, cueStart, cueEnd);
    }
    expectedStart = cueEnd + 1;
    return {endDisplayCard: cueEnd, lineBreakAfterDisplayCard};
  });
  if (expectedStart !== cards.length + 1) throw new Error("Regroup report did not consume every display card");
  return {
    schemaVersion: 1,
    operation: "direct-reviewed-mfa-caption-layout",
    displayCardCount: cards.length,
    layoutPolicy: {
      ...DEFAULTS,
      maxOutputLines: 2,
      requireExactlyTwoLines: false,
      lineMode: "max-two-contextual",
      lineLengthRole: "ceiling-not-target",
    },
    directReview: {
      completed: false,
      reviewer: "",
      reviewedCueCount: 0,
      acceptedDependentBoundaryAfterDisplayCards: [],
      checklist: [
        "all cue boundaries",
        "all line breaks",
        "Korean particles and predicates",
        "technical terms and compound names",
        "one-or-two-line contextual presentation",
      ],
    },
    cues,
  };
}

export function reviseReviewedLayoutManifest(alignment, manifest, replacements) {
  const cards = alignment?.display_cards;
  validateCards(cards);
  if (!Array.isArray(manifest?.cues) || manifest.cues.length === 0) throw new Error("Review manifest has no cues");
  if (!Array.isArray(replacements) || replacements.length === 0) throw new Error("Review replacements are empty");
  const revised = structuredClone(manifest);
  let previousReplacementEnd = 0;
  for (const replacement of replacements) {
    const startDisplayCard = Number(replacement.startDisplayCard);
    const endDisplayCard = Number(replacement.endDisplayCard);
    const cueEnds = replacement.cueEnds?.map(Number);
    const explicitLineBreaks = replacement.lineBreaks?.map(Number);
    if (
      !Number.isInteger(startDisplayCard) || !Number.isInteger(endDisplayCard) ||
      startDisplayCard <= previousReplacementEnd || endDisplayCard < startDisplayCard ||
      !Array.isArray(cueEnds) || cueEnds.length === 0 || cueEnds.at(-1) !== endDisplayCard ||
      (explicitLineBreaks && explicitLineBreaks.length !== cueEnds.length)
    ) {
      throw new Error("Review replacements must be ordered, non-overlapping, and end exactly at endDisplayCard");
    }
    let cueStart = 1;
    const firstIndex = revised.cues.findIndex((entry) => {
      const matches = cueStart === startDisplayCard;
      cueStart = Number(entry.endDisplayCard) + 1;
      return matches;
    });
    const lastIndex = revised.cues.findIndex((entry) => Number(entry.endDisplayCard) === endDisplayCard);
    if (firstIndex < 0 || lastIndex < firstIndex) {
      throw new Error(`Replacement ${startDisplayCard}-${endDisplayCard} does not align to current cue boundaries`);
    }
    let replacementStart = startDisplayCard;
    const replacementEntries = cueEnds.map((cueEnd, replacementIndex) => {
      if (!Number.isInteger(cueEnd) || cueEnd < replacementStart || cueEnd > endDisplayCard) {
        throw new Error(`Invalid replacement cue end ${cueEnd} in ${startDisplayCard}-${endDisplayCard}`);
      }
      const maxLineChars = Number(manifest?.layoutPolicy?.maxLineChars || DEFAULTS.maxLineChars);
      const explicitLineBreak = explicitLineBreaks?.[replacementIndex];
      const lineBreakAfterDisplayCard = explicitLineBreak ?? findBalancedLineBreakCard(
        cards,
        replacementStart,
        cueEnd,
        maxLineChars,
      );
      if (explicitLineBreak !== undefined) {
        if (!Number.isInteger(explicitLineBreak) || explicitLineBreak < replacementStart || explicitLineBreak >= cueEnd) {
          throw new Error(`Invalid explicit line break ${explicitLineBreak} in ${replacementStart}-${cueEnd}`);
        }
        const left = cardText(cards, replacementStart, explicitLineBreak);
        const right = cardText(cards, explicitLineBreak + 1, cueEnd);
        if ([...left].length > maxLineChars || [...right].length > maxLineChars) {
          throw new Error(`Explicit line break ${explicitLineBreak} exceeds ${maxLineChars} characters in ${replacementStart}-${cueEnd}`);
        }
        if (contextBoundaryPenalty(cards[explicitLineBreak - 1].text, cards[explicitLineBreak].text) >= 4000) {
          throw new Error(`Explicit line break ${explicitLineBreak} splits a protected term`);
        }
      }
      const entry = {endDisplayCard: cueEnd, lineBreakAfterDisplayCard};
      replacementStart = cueEnd + 1;
      return entry;
    });
    revised.cues.splice(firstIndex, lastIndex - firstIndex + 1, ...replacementEntries);
    previousReplacementEnd = endDisplayCard;
  }
  revised.directReview = {
    ...revised.directReview,
    completed: false,
    reviewer: "",
    reviewedCueCount: 0,
  };
  return revised;
}

export function reflowReviewedLayoutManifest(
  alignment,
  manifest,
  maxLineChars,
) {
  const cards = alignment?.display_cards;
  validateCards(cards);
  if (!Array.isArray(manifest?.cues) || manifest.cues.length === 0) {
    throw new Error("Review manifest has no cues");
  }
  const resolvedMaxLineChars = Number(maxLineChars);
  if (!Number.isInteger(resolvedMaxLineChars) || resolvedMaxLineChars < 8) {
    throw new Error("maxLineChars must be an integer of at least 8");
  }
  const fps = parseFps(alignment?.timing_policy?.fps);
  const maxCueFrames = Math.round(
    Number(manifest?.layoutPolicy?.maxCueSeconds || DEFAULTS.maxCueSeconds) * fps,
  );
  const maxGapFrames = Math.round(
    Number(
      manifest?.layoutPolicy?.maxInternalGapSeconds ||
        DEFAULTS.maxInternalGapSeconds,
    ) * fps,
  );
  const outputCues = [];
  let cueStart = 1;
  for (const sourceCue of manifest.cues) {
    const sourceEnd = Number(sourceCue.endDisplayCard);
    const dp = new Array(sourceEnd + 2).fill(null);
    dp[sourceEnd + 1] = {cost: 0, entries: []};
    for (let position = sourceEnd; position >= cueStart; position -= 1) {
      for (let candidateEnd = position; candidateEnd <= sourceEnd; candidateEnd += 1) {
        const durationFrames =
          cards[candidateEnd - 1].end_frame_exclusive -
          cards[position - 1].start_frame;
        if (durationFrames > maxCueFrames) break;
        let largestGapFrames = 0;
        for (let cardIndex = position; cardIndex < candidateEnd; cardIndex += 1) {
          largestGapFrames = Math.max(
            largestGapFrames,
            cards[cardIndex].start_frame - cards[cardIndex - 1].end_frame_exclusive,
          );
        }
        if (largestGapFrames > maxGapFrames) break;
        let lineBreakAfterDisplayCard = null;
        const candidateText = cardText(cards, position, candidateEnd);
        if ([...candidateText].length > resolvedMaxLineChars) {
          try {
            lineBreakAfterDisplayCard = findBalancedLineBreakCard(
              cards,
              position,
              candidateEnd,
              resolvedMaxLineChars,
            );
          } catch {
            continue;
          }
        }
        const next = dp[candidateEnd + 1];
        if (!next) continue;
        const boundaryPenalty =
          candidateEnd < sourceEnd
            ? contextBoundaryPenalty(
                cards[candidateEnd - 1].text,
                cards[candidateEnd].text,
              )
            : 0;
        if (boundaryPenalty >= 4000) continue;
        const textLength = [...candidateText].length;
        const targetLength = resolvedMaxLineChars * 1.5;
        const candidate = {
          cost:
            10_000 +
            boundaryPenalty * 2 +
            Math.abs(textLength - targetLength) +
            next.cost,
          entries: [
            {endDisplayCard: candidateEnd, lineBreakAfterDisplayCard},
            ...next.entries,
          ],
        };
        if (!dp[position] || candidate.cost < dp[position].cost) {
          dp[position] = candidate;
        }
      }
    }
    if (!dp[cueStart]) {
      throw new Error(
        `Could not reflow reviewed cue ${cueStart}-${sourceEnd} to ${resolvedMaxLineChars} characters`,
      );
    }
    outputCues.push(...dp[cueStart].entries);
    cueStart = sourceEnd + 1;
  }
  if (cueStart !== cards.length + 1) {
    throw new Error("Reflow did not consume every display card exactly once");
  }
  return {
    ...structuredClone(manifest),
    layoutPolicy: {
      ...(manifest.layoutPolicy || {}),
      maxLineChars: resolvedMaxLineChars,
      requireExactlyTwoLines: true,
      visualLineContract: "user-caption-style-locked",
    },
    directReview: {
      ...(manifest.directReview || {}),
      completed: false,
      reviewer: "",
      reviewedCueCount: 0,
      acceptedDependentBoundaryAfterDisplayCards: [],
    },
    cues: outputCues,
  };
}

export function retargetReviewedLayoutManifest(
  alignment,
  manifest,
  maxLineChars,
) {
  const cards = alignment?.display_cards;
  validateCards(cards);
  if (!Array.isArray(manifest?.cues) || manifest.cues.length === 0) {
    throw new Error("Review manifest has no cues");
  }
  const resolvedMaxLineChars = Number(maxLineChars);
  if (!Number.isInteger(resolvedMaxLineChars) || resolvedMaxLineChars < 8) {
    throw new Error("maxLineChars must be an integer of at least 8");
  }
  let cueStart = 1;
  for (let index = 0; index < manifest.cues.length; index += 1) {
    const cue = manifest.cues[index];
    const cueEnd = Number(cue.endDisplayCard);
    const lineBreak = Number(cue.lineBreakAfterDisplayCard);
    if (!Number.isInteger(cueEnd) || cueEnd < cueStart || cueEnd > cards.length) {
      throw new Error(`Review cue ${index + 1} has an invalid end display card`);
    }
    if (!Number.isInteger(lineBreak) || lineBreak < cueStart || lineBreak >= cueEnd) {
      throw new Error(`Review cue ${index + 1} does not define two non-empty lines`);
    }
    const lines = [
      cardText(cards, cueStart, lineBreak),
      cardText(cards, lineBreak + 1, cueEnd),
    ];
    if (lines.some((line) => [...line].length > resolvedMaxLineChars)) {
      throw new Error(
        `Existing reviewed cue ${index + 1} exceeds ${resolvedMaxLineChars} characters; use reflow instead`,
      );
    }
    if (
      contextBoundaryPenalty(
        cards[lineBreak - 1].text,
        cards[lineBreak].text,
      ) >= 4000
    ) {
      throw new Error(`Review cue ${index + 1} splits a protected term`);
    }
    cueStart = cueEnd + 1;
  }
  if (cueStart !== cards.length + 1) {
    throw new Error("Retarget did not consume every display card exactly once");
  }
  return {
    ...structuredClone(manifest),
    layoutPolicy: {
      ...(manifest.layoutPolicy || {}),
      maxLineChars: resolvedMaxLineChars,
      requireExactlyTwoLines: true,
      visualLineContract: "user-caption-style-locked",
    },
    directReview: {
      ...(manifest.directReview || {}),
      completed: false,
      reviewer: "",
      reviewedCueCount: 0,
      acceptedDependentBoundaryAfterDisplayCards: [],
    },
  };
}

export function contextualizeReviewedLayoutManifest(
  alignment,
  manifest,
  maxLineChars = 42,
) {
  const cards = alignment?.display_cards;
  validateCards(cards);
  if (!Array.isArray(manifest?.cues) || manifest.cues.length === 0) {
    throw new Error("Review manifest has no cues");
  }
  const resolvedMaxLineChars = Number(maxLineChars);
  if (!Number.isInteger(resolvedMaxLineChars) || resolvedMaxLineChars < 8) {
    throw new Error("maxLineChars must be an integer of at least 8");
  }
  let cueStart = 1;
  const cues = manifest.cues.map((sourceCue, index) => {
    const cueEnd = Number(sourceCue.endDisplayCard);
    if (!Number.isInteger(cueEnd) || cueEnd < cueStart || cueEnd > cards.length) {
      throw new Error(`Review cue ${index + 1} has an invalid end display card`);
    }
    const fullText = cardText(cards, cueStart, cueEnd);
    let lineBreakAfterDisplayCard = null;
    if ([...fullText].length > resolvedMaxLineChars) {
      const existingBreak =
        sourceCue.lineBreakAfterDisplayCard === null ||
        sourceCue.lineBreakAfterDisplayCard === undefined
          ? null
          : Number(sourceCue.lineBreakAfterDisplayCard);
      const existingLines =
        Number.isInteger(existingBreak) &&
        existingBreak >= cueStart &&
        existingBreak < cueEnd
          ? [
              cardText(cards, cueStart, existingBreak),
              cardText(cards, existingBreak + 1, cueEnd),
            ]
          : null;
      const existingBreakValid = Boolean(
        existingLines &&
          existingLines.every(
            (line) => [...line].length <= resolvedMaxLineChars,
          ) &&
          contextBoundaryPenalty(
            cards[existingBreak - 1].text,
            cards[existingBreak].text,
          ) < 4000,
      );
      lineBreakAfterDisplayCard = existingBreakValid
        ? existingBreak
        : findBalancedLineBreakCard(
            cards,
            cueStart,
            cueEnd,
            resolvedMaxLineChars,
          );
    }
    const entry = {endDisplayCard: cueEnd, lineBreakAfterDisplayCard};
    cueStart = cueEnd + 1;
    return entry;
  });
  if (cueStart !== cards.length + 1) {
    throw new Error("Contextual layout did not consume every display card exactly once");
  }
  return {
    ...structuredClone(manifest),
    layoutPolicy: {
      ...(manifest.layoutPolicy || {}),
      maxLineChars: resolvedMaxLineChars,
      maxOutputLines: 2,
      requireExactlyTwoLines: false,
      lineMode: "max-two-contextual",
      lineLengthRole: "ceiling-not-target",
      visualLineContract: "user-caption-style-locked",
    },
    directReview: {
      ...(manifest.directReview || {}),
      completed: false,
      reviewer: "",
      reviewedCueCount: 0,
      acceptedDependentBoundaryAfterDisplayCards: [],
    },
    cues,
  };
}

export function finalizeReviewedMfaCaptionLayout(alignment, manifest, overrides = {}) {
  const cards = alignment?.display_cards;
  validateCards(cards);
  const fps = parseFps(overrides.fps ?? alignment?.timing_policy?.fps);
  const policy = {...DEFAULTS, ...(manifest?.layoutPolicy || {}), ...overrides};
  const entries = manifest?.cues;
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("Review manifest has no cues");
  if (manifest?.displayCardCount !== cards.length) throw new Error("Review manifest display-card count does not match alignment");
  const directReview = manifest?.directReview || {};
  const reviewRecorded = directReview.completed === true &&
    Boolean(String(directReview.reviewer || "").trim()) &&
    Number(directReview.reviewedCueCount) === entries.length;

  const maxCueFrames = Math.round(Number(policy.maxCueSeconds) * fps);
  const maxGapFrames = Math.round(Number(policy.maxInternalGapSeconds) * fps);
  let cueStart = 1;
  const cues = entries.map((entry, index) => {
    const cueEnd = Number(entry.endDisplayCard);
    const hasLineBreak =
      entry.lineBreakAfterDisplayCard !== null &&
      entry.lineBreakAfterDisplayCard !== undefined;
    const lineBreak = hasLineBreak
      ? Number(entry.lineBreakAfterDisplayCard)
      : null;
    if (!Number.isInteger(cueEnd) || cueEnd < cueStart || cueEnd > cards.length) {
      throw new Error(`Review cue ${index + 1} has an invalid end display card`);
    }
    if (
      policy.requireExactlyTwoLines === true &&
      !hasLineBreak
    ) {
      throw new Error(`Review cue ${index + 1} does not define two non-empty lines`);
    }
    if (
      hasLineBreak &&
      (!Number.isInteger(lineBreak) || lineBreak < cueStart || lineBreak >= cueEnd)
    ) {
      throw new Error(`Review cue ${index + 1} has an invalid line break`);
    }
    const lines = hasLineBreak
      ? [
          cardText(cards, cueStart, lineBreak),
          cardText(cards, lineBreak + 1, cueEnd),
        ]
      : [cardText(cards, cueStart, cueEnd)];
    if (lines.some((line) => [...line].length > Number(policy.maxLineChars))) {
      throw new Error(`Review cue ${index + 1} exceeds ${policy.maxLineChars} characters per line`);
    }
    const startFrame = cards[cueStart - 1].start_frame;
    const endFrameExclusive = cards[cueEnd - 1].end_frame_exclusive;
    const durationFrames = endFrameExclusive - startFrame;
    if (durationFrames > maxCueFrames) throw new Error(`Review cue ${index + 1} exceeds ${policy.maxCueSeconds} seconds`);
    let largestGapFrames = 0;
    for (let cardIndex = cueStart; cardIndex < cueEnd; cardIndex += 1) {
      largestGapFrames = Math.max(
        largestGapFrames,
        cards[cardIndex].start_frame - cards[cardIndex - 1].end_frame_exclusive,
      );
    }
    if (largestGapFrames > maxGapFrames) {
      throw new Error(`Review cue ${index + 1} crosses an internal gap longer than ${policy.maxInternalGapSeconds} seconds`);
    }
    if (hasLineBreak) {
      const lineBoundaryPenalty = contextBoundaryPenalty(
        cards[lineBreak - 1].text,
        cards[lineBreak].text,
      );
      if (lineBoundaryPenalty >= 4000) {
        throw new Error(`Review cue ${index + 1} splits a protected term across lines`);
      }
    }
    const cue = {
      index: index + 1,
      displayCardStart: cueStart,
      displayCardEnd: cueEnd,
      lineBreakAfterDisplayCard: lineBreak,
      lines,
      text: cleanText(lines.join(" ")),
      startFrame,
      endFrameExclusive,
      durationFrames,
      largestGapFrames,
    };
    cueStart = cueEnd + 1;
    return cue;
  });
  if (cueStart !== cards.length + 1) throw new Error("Review manifest did not consume every display card exactly once");

  const protectedBoundaryViolations = [];
  const dependentBoundaryWarnings = [];
  for (let index = 0; index + 1 < cues.length; index += 1) {
    const left = cards[cues[index].displayCardEnd - 1].text;
    const right = cards[cues[index + 1].displayCardStart - 1].text;
    const penalty = contextBoundaryPenalty(left, right);
    if (penalty >= 4000) protectedBoundaryViolations.push({afterCue: index + 1, left, right, penalty});
    else if (penalty >= 1000) dependentBoundaryWarnings.push({afterCue: index + 1, left, right, penalty});
  }
  if (protectedBoundaryViolations.length > 0) {
    throw new Error(`Review layout splits ${protectedBoundaryViolations.length} protected technical terms`);
  }
  const warningDisplayCards = dependentBoundaryWarnings.map(
    (warning) => cues[warning.afterCue - 1].displayCardEnd,
  );
  const acceptedWarningDisplayCards = Array.isArray(directReview.acceptedDependentBoundaryAfterDisplayCards)
    ? directReview.acceptedDependentBoundaryAfterDisplayCards.map(Number)
    : [];
  const acceptedWarningSet = new Set(acceptedWarningDisplayCards);
  const unacknowledgedWarnings = warningDisplayCards.filter((card) => !acceptedWarningSet.has(card));

  const sourceText = cleanText(cards.map((card) => card.text).join(" "));
  const outputText = cleanText(cues.map((cue) => cue.text).join(" "));
  if (sourceText !== outputText) throw new Error("Review layout changed caption text or word order");
  const body = cues.map((cue) => [
    String(cue.index),
    `${frameToSrt(cue.startFrame, fps)} --> ${frameToSrt(cue.endFrameExclusive, fps)}`,
    ...cue.lines,
  ].join("\r\n")).join("\r\n\r\n") + "\r\n";
  const srt = `\uFEFF${body}`;
  return {
    srt,
    report: {
      schemaVersion: 1,
      operation: "finalize-direct-reviewed-mfa-caption-layout",
      reviewStatus: reviewRecorded ? "direct-reviewed-final-candidate" : "validated-candidate",
      reviewer: reviewRecorded ? String(directReview.reviewer).trim() : null,
      reviewedCueCount: reviewRecorded ? cues.length : 0,
      fps,
      policy,
      displayCardCount: cards.length,
      cueCount: cues.length,
      oneLineCueCount: cues.filter((cue) => cue.lines.length === 1).length,
      twoLineCueCount: cues.filter((cue) => cue.lines.length === 2).length,
      textAndOrderPreserved: true,
      protectedBoundaryViolationCount: 0,
      dependentBoundaryWarningCount: dependentBoundaryWarnings.length,
      unresolvedDependentBoundaryCount: unacknowledgedWarnings.length,
      reviewedDependentBoundaries: dependentBoundaryWarnings.map((warning, index) => ({
        ...warning,
        afterDisplayCard: warningDisplayCards[index],
        disposition: acceptedWarningSet.has(warningDisplayCards[index])
          ? "accepted-after-direct-context-review"
          : "context-review-suggestion",
      })),
      maxCueDurationFrames: Math.max(...cues.map((cue) => cue.durationFrames)),
      maxInternalGapFrames: Math.max(...cues.map((cue) => cue.largestGapFrames)),
      manifestSha256: crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
      srtSha256: crypto.createHash("sha256").update(srt).digest("hex"),
      cues,
    },
  };
}

function parseArgs(argv) {
  const parsed = {command: argv[0] || "", allowOverwrite: false};
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--allow-overwrite") parsed.allowOverwrite = true;
    else if (["--alignment", "--regroup-report", "--manifest", "--replacements", "--out", "--report", "--fps", "--max-line-chars"].includes(value)) {
      if (index + 1 >= argv.length) throw new Error(`${value} requires a value`);
      parsed[value.slice(2).replace(/-([a-z])/gu, (_, char) => char.toUpperCase())] = argv[++index];
    } else if (value === "--help" || value === "-h") parsed.help = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  return parsed;
}

function usage() {
  return [
    "node scripts/finalize-reviewed-mfa-caption-layout.mjs seed --alignment <alignment.json> --regroup-report <report.json> --out <review-manifest.json>",
    "node scripts/finalize-reviewed-mfa-caption-layout.mjs revise --alignment <alignment.json> --manifest <review-manifest.json> --replacements <replacements.json> --out <revised-manifest.json>",
    "node scripts/finalize-reviewed-mfa-caption-layout.mjs reflow --alignment <alignment.json> --manifest <reviewed-manifest.json> --max-line-chars <n> --out <reflowed-manifest.json>",
    "node scripts/finalize-reviewed-mfa-caption-layout.mjs retarget --alignment <alignment.json> --manifest <reviewed-manifest.json> --max-line-chars <n> --out <retargeted-manifest.json>",
    "node scripts/finalize-reviewed-mfa-caption-layout.mjs contextualize --alignment <alignment.json> --manifest <reviewed-manifest.json> --max-line-chars <n> --out <contextual-manifest.json>",
    "node scripts/finalize-reviewed-mfa-caption-layout.mjs finalize --alignment <alignment.json> --manifest <review-manifest.json> --out <final.srt> --report <report.json> [--fps 30]",
  ].join("\n");
}

function writeNew(filePath, contents, allowOverwrite) {
  const resolved = path.resolve(filePath);
  if (!allowOverwrite && fs.existsSync(resolved)) throw new Error(`Refusing to overwrite ${resolved}`);
  fs.mkdirSync(path.dirname(resolved), {recursive: true});
  fs.writeFileSync(resolved, contents, "utf8");
  return resolved;
}

async function runCli() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return console.log(usage());
  if (!options.alignment) throw new Error(usage());
  const alignment = JSON.parse(fs.readFileSync(path.resolve(options.alignment), "utf8"));
  if (options.command === "seed") {
    if (!options.regroupReport || !options.out) throw new Error(usage());
    const regroupReport = JSON.parse(fs.readFileSync(path.resolve(options.regroupReport), "utf8"));
    const manifest = seedReviewedLayoutManifest(alignment, regroupReport);
    const outputPath = writeNew(options.out, `${JSON.stringify(manifest, null, 2)}\n`, options.allowOverwrite);
    console.log(JSON.stringify({outputPath, cueCount: manifest.cues.length, reviewCompleted: false}, null, 2));
    return;
  }
  if (options.command === "finalize") {
    if (!options.manifest || !options.out || !options.report) throw new Error(usage());
    const manifest = JSON.parse(fs.readFileSync(path.resolve(options.manifest), "utf8"));
    const result = finalizeReviewedMfaCaptionLayout(alignment, manifest, options.fps ? {fps: options.fps} : {});
    const outputPath = writeNew(options.out, result.srt, options.allowOverwrite);
    const reportPath = writeNew(options.report, `${JSON.stringify(result.report, null, 2)}\n`, options.allowOverwrite);
    console.log(JSON.stringify({outputPath, reportPath, cueCount: result.report.cueCount, reviewStatus: result.report.reviewStatus}, null, 2));
    return;
  }
  if (options.command === "revise") {
    if (!options.manifest || !options.replacements || !options.out) throw new Error(usage());
    const manifest = JSON.parse(fs.readFileSync(path.resolve(options.manifest), "utf8"));
    const replacements = JSON.parse(fs.readFileSync(path.resolve(options.replacements), "utf8"));
    const revised = reviseReviewedLayoutManifest(alignment, manifest, replacements);
    const outputPath = writeNew(options.out, `${JSON.stringify(revised, null, 2)}\n`, options.allowOverwrite);
    console.log(JSON.stringify({outputPath, cueCount: revised.cues.length, reviewCompleted: false}, null, 2));
    return;
  }
  if (options.command === "reflow") {
    if (!options.manifest || !options.maxLineChars || !options.out) {
      throw new Error(usage());
    }
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(options.manifest), "utf8"),
    );
    const reflowed = reflowReviewedLayoutManifest(
      alignment,
      manifest,
      options.maxLineChars,
    );
    const outputPath = writeNew(
      options.out,
      `${JSON.stringify(reflowed, null, 2)}\n`,
      options.allowOverwrite,
    );
    console.log(
      JSON.stringify(
        {outputPath, cueCount: reflowed.cues.length, reviewCompleted: false},
        null,
        2,
      ),
    );
    return;
  }
  if (options.command === "retarget") {
    if (!options.manifest || !options.maxLineChars || !options.out) {
      throw new Error(usage());
    }
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(options.manifest), "utf8"),
    );
    const retargeted = retargetReviewedLayoutManifest(
      alignment,
      manifest,
      options.maxLineChars,
    );
    const outputPath = writeNew(
      options.out,
      `${JSON.stringify(retargeted, null, 2)}\n`,
      options.allowOverwrite,
    );
    console.log(
      JSON.stringify(
        {outputPath, cueCount: retargeted.cues.length, reviewCompleted: false},
        null,
        2,
      ),
    );
    return;
  }
  if (options.command === "contextualize") {
    if (!options.manifest || !options.maxLineChars || !options.out) {
      throw new Error(usage());
    }
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(options.manifest), "utf8"),
    );
    const contextual = contextualizeReviewedLayoutManifest(
      alignment,
      manifest,
      options.maxLineChars,
    );
    const outputPath = writeNew(
      options.out,
      `${JSON.stringify(contextual, null, 2)}\n`,
      options.allowOverwrite,
    );
    console.log(
      JSON.stringify(
        {outputPath, cueCount: contextual.cues.length, reviewCompleted: false},
        null,
        2,
      ),
    );
    return;
  }
  throw new Error(usage());
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) runCli().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
