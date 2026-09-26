#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  acquirePremiereCepLock,
  installPremiereCepSignalHandlers,
} from "./lib/premiere-cep-lock.mjs";
import {
  normalizeSequenceStructureStrict,
  resolveFrameTiming,
} from "./lib/sequence-structure-diff.mjs";
import { parseSrt } from "./validate-srt.mjs";
import { DEFAULT_TEMP_DIR } from "../servers/premiere-uxp-mcp/paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CONTROL_CALL = path.join(
  ROOT,
  "servers",
  "premiere-control-mcp",
  "call-tool.mjs",
);
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 900_000;
const POST_WRITE_YIELD_MS = 1_000;
const DEFAULT_RETIRED_TRACK_PREFIX = "[폐기]";
// Stage-2 context grouping never spans a long silence (caption-production.md).
const CONTEXT_GROUP_MAX_INTERNAL_GAP_SECONDS = 1.5;
const CAPTION_FORMATS = new Set([
  "subtitle",
  "608",
  "708",
  "teletext",
  "ebu",
  "op42",
  "op47",
]);

class CaptionApplyFailure extends Error {
  constructor(code, message, details = null, options = {}) {
    super(message);
    this.name = "CaptionApplyFailure";
    this.code = code;
    this.details = details;
    this.phase = options.phase || null;
    this.uncertain = options.uncertain === true;
  }
}

function fail(code, message, details = null, options = {}) {
  throw new CaptionApplyFailure(code, message, details, options);
}

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function nonEmpty(value, flag) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${flag} must be a non-empty string.`);
  }
  return value.trim();
}

function parseNonNegativeInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

function parseNonNegativeNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative number.`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    allowWrite: false,
    allowCaptionRetime: false,
    allowContextGrouping: false,
    premiereFinalCueEndCompensation: false,
    dryRun: true,
    expectedExistingCaptionTracks: 0,
    revisionReviewMode: false,
    retiredTrackPrefix: DEFAULT_RETIRED_TRACK_PREFIX,
    newTrackName: null,
    startSeconds: 0,
    captionFormat: "subtitle",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  let explicitDryRun = false;
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--srt") {
      options.srt = requiredValue(argv, index, value);
      index += 1;
    } else if (value === "--expected-project") {
      options.expectedProject = requiredValue(argv, index, value);
      index += 1;
    } else if (value === "--expected-sequence") {
      options.expectedSequence = requiredValue(argv, index, value);
      index += 1;
    } else if (value === "--expected-existing-caption-tracks") {
      options.expectedExistingCaptionTracks = parseNonNegativeInteger(
        requiredValue(argv, index, value),
        value,
      );
      index += 1;
    } else if (value === "--revision-review-mode") {
      options.revisionReviewMode = true;
    } else if (value === "--allow-caption-retime") {
      options.allowCaptionRetime = true;
    } else if (value === "--allow-context-grouping") {
      options.allowContextGrouping = true;
    } else if (value === "--premiere-final-cue-end-compensation") {
      options.premiereFinalCueEndCompensation = true;
    } else if (value === "--retired-track-prefix") {
      options.retiredTrackPrefix = requiredValue(argv, index, value);
      index += 1;
    } else if (value === "--new-track-name") {
      options.newTrackName = requiredValue(argv, index, value);
      index += 1;
    } else if (value === "--start-seconds") {
      options.startSeconds = parseNonNegativeNumber(
        requiredValue(argv, index, value),
        value,
      );
      index += 1;
    } else if (value === "--caption-format") {
      options.captionFormat = requiredValue(argv, index, value).toLowerCase();
      index += 1;
    } else if (value === "--timeout-ms") {
      options.timeoutMs = parseNonNegativeInteger(
        requiredValue(argv, index, value),
        value,
      );
      index += 1;
    } else if (value === "--uxp-bridge-dir") {
      options.uxpBridgeDir = requiredValue(argv, index, value);
      index += 1;
    } else if (value === "--cep-temp-dir") {
      options.cepTempDir = requiredValue(argv, index, value);
      index += 1;
    } else if (value === "--mcp-root") {
      options.mcpRoot = requiredValue(argv, index, value);
      index += 1;
    } else if (value === "--allow-write") {
      options.allowWrite = true;
      options.dryRun = false;
    } else if (value === "--allow-experimental") {
      // Backward-compatible no-op. The proven caption route no longer asks the
      // caller for a second permission ceremony beyond --allow-write.
    } else if (value === "--dry-run") {
      explicitDryRun = true;
      options.dryRun = true;
    } else if (value === "--help" || value === "-h") {
      options.help = true;
    } else if (value.startsWith("--")) {
      throw new Error(`Unknown option: ${value}`);
    } else {
      positional.push(value);
    }
  }

  if (positional.length > 1 || (positional.length === 1 && options.srt)) {
    throw new Error("Provide exactly one SRT path, either positionally or with --srt.");
  }
  if (!options.srt && positional.length === 1) options.srt = positional[0];
  if (explicitDryRun && options.allowWrite) {
    throw new Error("--dry-run and --allow-write are mutually exclusive.");
  }
  return options;
}

export function usage() {
  return [
    "Usage:",
    "  node scripts/apply-premiere-caption-track.mjs <captions.srt> [options]",
    "",
    "Default mode is read-only dry-run. It parses the SRT, reads Premiere through",
    "the official UXP bridge, verifies identity/structure/caption guards, and submits",
    "zero writes.",
    "",
    "Required for a real application:",
    "  --allow-write                       Permit the bounded one-shot caption application writes",
    "  --expected-project <name|path>      Exact active project name or Windows project path",
    "  --expected-sequence <name|id>       Exact active sequence name or runtime ID",
    "",
    "Safety/options:",
    "  --dry-run                           Explicit read-only mode (the default)",
    "  --expected-existing-caption-tracks <n>  Exact read guard; nonzero writes require revision-review mode",
    "  --revision-review-mode               Mute+mark existing tracks, then add one visible reviewed revision",
    "  --allow-caption-retime                Explicitly bypass the visible-track timing authority guard for an approved retime",
    "  --allow-context-grouping              Accept a stage-2 context-merged SRT: every cue must span contiguous authority cues",
    `                                        on exact authority frames, cover all of them once, and skip no gap over ${CONTEXT_GROUP_MAX_INTERNAL_GAP_SECONDS}s`,
    "  --premiere-final-cue-end-compensation  Declare the SRT final cue end pre-encoded +1 frame for Premiere's observed -1f import transport loss",
    `  --retired-track-prefix <text>         Retired-track marker (default: ${DEFAULT_RETIRED_TRACK_PREFIX})`,
    "  --new-track-name <text>              Required reviewed-track name in revision-review mode",
    "  --start-seconds <n>                 Caption offset (default: 0)",
    "  --caption-format <format>           subtitle|608|708|teletext|ebu|op42|op47",
    `  --timeout-ms <n>                    Per child-call timeout (1000-${MAX_TIMEOUT_MS}; default: ${DEFAULT_TIMEOUT_MS})`,
    "  --uxp-bridge-dir <path>             Forward the UXP bridge override",
    "  --cep-temp-dir <path>               Forward the CEP bridge/lock directory",
    "  --mcp-root <path>                   Forward the local premiere-pro-mcp package root",
    "",
    "The wrapper never saves the project, never retries a write, and never deletes",
    "an imported item or caption track after a partial/uncertain result.",
  ].join("\n");
}

function normalizeOptions(raw = {}) {
  const options = {
    ...raw,
    dryRun: raw.allowWrite === true ? false : raw.dryRun !== false,
    allowWrite: raw.allowWrite === true,
    allowCaptionRetime: raw.allowCaptionRetime === true,
    allowContextGrouping: raw.allowContextGrouping === true,
    premiereFinalCueEndCompensation:
      raw.premiereFinalCueEndCompensation === true,
    revisionReviewMode: raw.revisionReviewMode === true,
    retiredTrackPrefix: String(
      raw.retiredTrackPrefix ?? DEFAULT_RETIRED_TRACK_PREFIX,
    ).trim(),
    newTrackName:
      raw.newTrackName === null || raw.newTrackName === undefined
        ? null
        : String(raw.newTrackName).trim(),
    expectedExistingCaptionTracks: Number(
      raw.expectedExistingCaptionTracks ?? 0,
    ),
    startSeconds: Number(raw.startSeconds ?? 0),
    captionFormat: String(raw.captionFormat || "subtitle").toLowerCase(),
    timeoutMs: Number(raw.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  };

  if (!options.srt) fail("SRT_REQUIRED", "An SRT path is required.");
  options.srt = path.resolve(String(options.srt));
  if (path.extname(options.srt).toLowerCase() !== ".srt") {
    fail("SRT_EXTENSION_REQUIRED", "The caption source must use the .srt extension.");
  }
  if (
    !Number.isInteger(options.expectedExistingCaptionTracks) ||
    options.expectedExistingCaptionTracks < 0
  ) {
    fail(
      "INVALID_EXISTING_CAPTION_GUARD",
      "expectedExistingCaptionTracks must be a non-negative integer.",
    );
  }
  if (!Number.isFinite(options.startSeconds) || options.startSeconds < 0) {
    fail("INVALID_START_SECONDS", "startSeconds must be a non-negative number.");
  }
  if (!CAPTION_FORMATS.has(options.captionFormat)) {
    fail(
      "INVALID_CAPTION_FORMAT",
      `Unsupported caption format: ${options.captionFormat}`,
    );
  }
  if (!options.retiredTrackPrefix) {
    fail(
      "RETIRED_TRACK_PREFIX_REQUIRED",
      "retiredTrackPrefix must be a non-empty string.",
    );
  }
  if (
    options.premiereFinalCueEndCompensation &&
    !options.revisionReviewMode
  ) {
    fail(
      "FINAL_CUE_COMPENSATION_REQUIRES_REVISION_REVIEW",
      "--premiere-final-cue-end-compensation is allowed only in revision-review mode.",
    );
  }
  if (options.allowContextGrouping && !options.revisionReviewMode) {
    fail(
      "CONTEXT_GROUPING_REQUIRES_REVISION_REVIEW",
      "--allow-context-grouping is allowed only in revision-review mode.",
    );
  }
  if (options.allowContextGrouping && options.allowCaptionRetime) {
    fail(
      "CONTEXT_GROUPING_CONFLICTS_WITH_RETIME",
      "--allow-context-grouping keeps the timing-authority guard and cannot be combined with --allow-caption-retime.",
    );
  }
  if (
    options.premiereFinalCueEndCompensation &&
    options.allowCaptionRetime
  ) {
    fail(
      "FINAL_CUE_COMPENSATION_CONFLICTS_WITH_RETIME",
      "Premiere final-cue transport compensation cannot be combined with --allow-caption-retime.",
    );
  }
  if (
    options.premiereFinalCueEndCompensation &&
    options.expectedExistingCaptionTracks < 1
  ) {
    fail(
      "FINAL_CUE_COMPENSATION_AUTHORITY_REQUIRED",
      "Premiere final-cue transport compensation requires an explicitly guarded existing caption track.",
    );
  }
  if (
    options.newTrackName !== null &&
    (!options.newTrackName || options.newTrackName.startsWith(options.retiredTrackPrefix))
  ) {
    fail(
      "NEW_TRACK_NAME_INVALID",
      "newTrackName must be non-empty and must not use the retired-track prefix.",
    );
  }
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1_000 ||
    options.timeoutMs > MAX_TIMEOUT_MS
  ) {
    fail(
      "INVALID_TIMEOUT",
      `timeoutMs must be an integer from 1000 through ${MAX_TIMEOUT_MS}.`,
    );
  }

  if (options.allowWrite) {
    if (
      options.expectedExistingCaptionTracks !== 0 &&
      !options.revisionReviewMode
    ) {
      fail(
        "CAPTION_TRACK_STACKING_FORBIDDEN",
        "Existing caption tracks require the explicit revision-review mode.",
        { expectedExistingCaptionTracks: options.expectedExistingCaptionTracks },
      );
    }
    if (
      options.revisionReviewMode &&
      options.expectedExistingCaptionTracks < 1
    ) {
      fail(
        "REVISION_EXISTING_CAPTION_REQUIRED",
        "Revision-review mode requires at least one explicitly guarded existing caption track.",
      );
    }
    if (options.revisionReviewMode && !options.newTrackName) {
      fail(
        "REVISION_NEW_TRACK_NAME_REQUIRED",
        "Revision-review mode requires --new-track-name so the visible review track is unambiguous.",
      );
    }
    if (!options.expectedProject) {
      fail(
        "EXPECTED_PROJECT_REQUIRED",
        "A real application requires --expected-project.",
      );
    }
    if (!options.expectedSequence) {
      fail(
        "EXPECTED_SEQUENCE_REQUIRED",
        "A real application requires --expected-sequence.",
      );
    }
    options.expectedProject = nonEmpty(options.expectedProject, "--expected-project");
    options.expectedSequence = nonEmpty(options.expectedSequence, "--expected-sequence");
  } else {
    options.expectedProject = options.expectedProject
      ? nonEmpty(options.expectedProject, "--expected-project")
      : null;
    options.expectedSequence = options.expectedSequence
      ? nonEmpty(options.expectedSequence, "--expected-sequence")
      : null;
  }
  return options;
}

function normalizeWindowsPath(value) {
  return String(value || "")
    .trim()
    .replaceAll("/", "\\")
    .replace(/\\+$/u, "")
    .toLocaleLowerCase("en-US");
}

function sameProjectExpectation(expected, project) {
  if (!expected) return { matched: true, matchedBy: null };
  if (String(project?.name || "") === expected) {
    return { matched: true, matchedBy: "name" };
  }
  const expectedPath = normalizeWindowsPath(expected);
  const actualPath = normalizeWindowsPath(project?.path);
  return {
    matched: expectedPath.length > 0 && expectedPath === actualPath,
    matchedBy: expectedPath.length > 0 && expectedPath === actualPath ? "path" : null,
  };
}

function sameSequenceExpectation(expected, sequence) {
  if (!expected) return { matched: true, matchedBy: null };
  if (String(sequence?.name || "") === expected) {
    return { matched: true, matchedBy: "name" };
  }
  if (String(sequence?.id || "") === expected) {
    return { matched: true, matchedBy: "id" };
  }
  return { matched: false, matchedBy: null };
}

function summarizeError(error) {
  return {
    name: String(error?.name || "Error"),
    code: error?.code ? String(error.code) : null,
    message: String(error?.message || error),
    details: error?.details ?? null,
    uncertain: error?.uncertain === true,
  };
}

function parseControlPayload(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return { parsed: false, payload: null };
  try {
    return { parsed: true, payload: JSON.parse(text) };
  } catch {
    return { parsed: false, payload: text };
  }
}

export function buildControlCallArgs(request, runtimeOptions = {}) {
  const args = [
    runtimeOptions.controlCallPath || CONTROL_CALL,
    String(request.tool),
    JSON.stringify(request.args || {}),
    "--route",
    String(request.route),
  ];
  if (request.allowWrite) args.push("--allow-write");
  if (request.allowExperimental) args.push("--allow-experimental");
  if (runtimeOptions.uxpBridgeDir) {
    args.push("--uxp-bridge-dir", path.resolve(runtimeOptions.uxpBridgeDir));
  }
  if (runtimeOptions.cepTempDir) {
    args.push("--cep-temp-dir", path.resolve(runtimeOptions.cepTempDir));
  }
  if (runtimeOptions.mcpRoot) {
    args.push("--mcp-root", path.resolve(runtimeOptions.mcpRoot));
  }
  return args;
}

export function createDefaultRunner(runtimeOptions = {}) {
  return async function runControlCall(request) {
    const childArgs = buildControlCallArgs(request, runtimeOptions);
    const result = spawnSync(process.execPath, childArgs, {
      cwd: ROOT,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 128 * 1024 * 1024,
      timeout: request.timeoutMs || runtimeOptions.timeoutMs || DEFAULT_TIMEOUT_MS,
      windowsHide: true,
    });
    const parsed = parseControlPayload(result.stdout);
    if (result.error || result.signal || result.status !== 0) {
      const missingResponse = !String(result.stdout || "").trim();
      const timedOut = result.error?.code === "ETIMEDOUT";
      const transportUncertain = Boolean(
        timedOut || result.signal || result.status === null || missingResponse,
      );
      const detail = [
        parsed.payload === null ? "" : String(
          parsed.parsed ? JSON.stringify(parsed.payload) : parsed.payload,
        ),
        String(result.stderr || "").trim(),
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 4_000);
      const error = new Error(
        `Premiere control call '${request.tool}' failed${
          detail ? `: ${detail}` : "."
        }`,
      );
      error.code = timedOut
        ? "PREMIERE_CONTROL_TIMEOUT"
        : "PREMIERE_CONTROL_CALL_FAILED";
      error.uncertain = request.mutation === true && transportUncertain;
      error.details = {
        exitStatus: result.status,
        signal: result.signal || null,
        responsePresent: !missingResponse,
      };
      throw error;
    }
    if (!parsed.parsed) {
      const error = new Error(
        `Premiere control call '${request.tool}' returned a non-JSON response.`,
      );
      error.code = "PREMIERE_CONTROL_NON_JSON_RESPONSE";
      error.uncertain = request.mutation === true;
      error.details = { response: String(parsed.payload || "").slice(0, 2_000) };
      throw error;
    }
    return parsed.payload;
  };
}

function validateSrtForApplication(source) {
  const parsed = parseSrt(source);
  if (parsed.issues.length > 0) {
    fail(
      "SRT_PARSE_FAILED",
      "The SRT contains structural parse errors.",
      { issues: parsed.issues },
    );
  }
  if (parsed.cues.length === 0) {
    fail("SRT_EMPTY", "The SRT contains no cues.");
  }

  let previousEnd = null;
  for (let index = 0; index < parsed.cues.length; index += 1) {
    const cue = parsed.cues[index];
    if (cue.number !== index + 1) {
      fail(
        "SRT_CUE_NUMBER_SEQUENCE",
        `Cue ${index + 1} does not use the expected sequential number.`,
        { expected: index + 1, actual: cue.number },
      );
    }
    if (
      !Number.isFinite(cue.startSeconds) ||
      !Number.isFinite(cue.endSeconds) ||
      cue.endSeconds <= cue.startSeconds
    ) {
      fail(
        "SRT_CUE_RANGE_INVALID",
        `Cue ${index + 1} has an invalid time range.`,
        { startSeconds: cue.startSeconds, endSeconds: cue.endSeconds },
      );
    }
    if (previousEnd !== null && cue.startSeconds < previousEnd) {
      fail(
        "SRT_CUE_OVERLAP",
        `Cue ${index + 1} overlaps the preceding cue.`,
        { previousEndSeconds: previousEnd, startSeconds: cue.startSeconds },
      );
    }
    if (!cue.text.trim()) {
      fail("SRT_CUE_TEXT_EMPTY", `Cue ${index + 1} has no text.`);
    }
    previousEnd = cue.endSeconds;
  }

  return {
    cues: parsed.cues,
    cueCount: parsed.cues.length,
    startSeconds: parsed.cues[0].startSeconds,
    endSeconds: parsed.cues.at(-1).endSeconds,
  };
}

function sequenceTiming(summary) {
  const frameRate = summary?.frameRate || {};
  return resolveFrameTiming({
    ticksPerFrame: frameRate.ticks,
    frameDurationSeconds: Number(frameRate.seconds),
  });
}

function nearestFrameIndex(seconds, timing) {
  const value = Number(seconds);
  const secondsPerFrame = Number(timing?.secondsPerFrame);
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(secondsPerFrame) ||
    secondsPerFrame <= 0
  ) {
    return null;
  }
  return Math.round(value / secondsPerFrame);
}

function srtImportFrameIndex(seconds, timing) {
  const value = Number(seconds);
  const secondsPerFrame = Number(timing?.secondsPerFrame);
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(secondsPerFrame) ||
    secondsPerFrame <= 0
  ) {
    return null;
  }
  return Math.floor(value / secondsPerFrame + 1e-9);
}

function expectedCaptionCueFrames(cue, index, cueCount, options, timing) {
  const offsetSeconds = Number(options?.startSeconds || 0);
  const encodedStartSeconds = Number(cue?.startSeconds) + offsetSeconds;
  const encodedEndSeconds = Number(cue?.endSeconds) + offsetSeconds;
  const encodedStartFrame = srtImportFrameIndex(encodedStartSeconds, timing);
  const encodedEndFrame = srtImportFrameIndex(encodedEndSeconds, timing);
  const finalCueCompensationApplied =
    options?.premiereFinalCueEndCompensation === true &&
    index === cueCount - 1;
  return {
    encodedStartSeconds,
    encodedEndSeconds,
    encodedStartFrame,
    encodedEndFrame,
    intendedStartFrame: encodedStartFrame,
    intendedEndFrame:
      encodedEndFrame === null
        ? null
        : encodedEndFrame - (finalCueCompensationApplied ? 1 : 0),
    finalCueCompensationApplied,
  };
}

function evaluateFinalCueCompensationSequenceTail(
  srtInfo,
  options,
  timing,
  durationFrameExclusive,
) {
  const enabled = options?.premiereFinalCueEndCompensation === true;
  if (!enabled) {
    return {
      enabled: false,
      ok: true,
      status: "not-applicable",
      durationFrameExclusive,
    };
  }
  const finalCue = expectedCaptionCueFrames(
    srtInfo.cues.at(-1),
    srtInfo.cues.length - 1,
    srtInfo.cues.length,
    options,
    timing,
  );
  const encodedFinalCueEndFrame = finalCue.encodedEndFrame;
  const ok =
    Number.isInteger(encodedFinalCueEndFrame) &&
    Number.isInteger(durationFrameExclusive) &&
    encodedFinalCueEndFrame >= 0 &&
    encodedFinalCueEndFrame < durationFrameExclusive;
  return {
    enabled: true,
    ok,
    status: ok ? "inside-sequence-tail" : "blocked-at-or-after-sequence-tail",
    comparison: "encodedFinalCueEndFrame < durationFrameExclusive",
    encodedFinalCueEndFrame,
    intendedFinalCueEndFrame: finalCue.intendedEndFrame,
    durationFrameExclusive,
    remainingFramesBeforeExclusiveTail:
      Number.isInteger(encodedFinalCueEndFrame) &&
      Number.isInteger(durationFrameExclusive)
        ? durationFrameExclusive - encodedFinalCueEndFrame
        : null,
  };
}

function countNormalizedClips(normalized) {
  return normalized.tracks.reduce(
    (total, track) => total + track.clips.length,
    0,
  );
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeCaptionSnapshot(snapshot, label) {
  const count = Number(snapshot?.captionTrackCount);
  if (!Number.isInteger(count) || count < 0 || !Array.isArray(snapshot?.tracks)) {
    fail(
      "CAPTION_READ_INVALID",
      `${label} caption read-back has an invalid response shape.`,
      { snapshot },
    );
  }
  if (snapshot.tracks.length !== count) {
    fail(
      "CAPTION_READ_COUNT_MISMATCH",
      `${label} captionTrackCount disagrees with the returned track list.`,
      { captionTrackCount: count, trackArrayLength: snapshot.tracks.length },
    );
  }
  return { count, tracks: snapshot.tracks };
}

function baselineFromReads({ ping, state, summary, structure, captions }, options) {
  if (ping?.connected !== true) {
    fail("UXP_NOT_CONNECTED", "Premiere UXP ping did not report connected=true.");
  }
  if (!state?.project?.name || !state?.activeSequence?.name || !state.activeSequence.id) {
    fail(
      "PREMIERE_STATE_INCOMPLETE",
      "Premiere state is missing the active project or sequence identity.",
      { state },
    );
  }
  if (options.allowWrite && !String(state.project.path || "").trim()) {
    fail(
      "SAVED_PROJECT_PATH_REQUIRED",
      "A real caption application requires an active project with a concrete project path.",
    );
  }

  const projectMatch = sameProjectExpectation(
    options.expectedProject,
    state.project,
  );
  if (!projectMatch.matched) {
    fail(
      "EXPECTED_PROJECT_MISMATCH",
      "The active Premiere project does not match --expected-project.",
      {
        expected: options.expectedProject,
        actualName: state.project.name,
        actualPath: state.project.path,
      },
    );
  }
  const sequenceMatch = sameSequenceExpectation(
    options.expectedSequence,
    state.activeSequence,
  );
  if (!sequenceMatch.matched) {
    fail(
      "EXPECTED_SEQUENCE_MISMATCH",
      "The active Premiere sequence does not match --expected-sequence.",
      {
        expected: options.expectedSequence,
        actualName: state.activeSequence.name,
        actualId: state.activeSequence.id,
      },
    );
  }

  const sequenceId = String(state.activeSequence.id);
  const sequenceName = String(state.activeSequence.name);
  for (const [label, snapshot] of [
    ["timeline summary", summary],
    ["sequence structure", structure],
  ]) {
    if (
      String(snapshot?.id || "") !== sequenceId ||
      String(snapshot?.name || "") !== sequenceName
    ) {
      fail(
        "SEQUENCE_IDENTITY_INCONSISTENT",
        `${label} does not identify the active sequence.`,
        {
          state: { id: sequenceId, name: sequenceName },
          snapshot: { id: snapshot?.id, name: snapshot?.name },
        },
      );
    }
  }

  const timing = sequenceTiming(summary);
  const normalizedStructure = normalizeSequenceStructureStrict(
    structure,
    timing,
  );
  const stateDuration = Number(state.activeSequence.durationSeconds);
  const summaryDuration = Number(summary.durationSeconds);
  const structureDuration = Number(structure.durationSeconds);
  const durationTolerance = Math.max(1e-6, timing.secondsPerFrame * 0.05);
  if (
    !Number.isFinite(stateDuration) ||
    !Number.isFinite(summaryDuration) ||
    !Number.isFinite(structureDuration) ||
    Math.abs(stateDuration - summaryDuration) > durationTolerance ||
    Math.abs(summaryDuration - structureDuration) > durationTolerance
  ) {
    fail(
      "SEQUENCE_DURATION_INCONSISTENT",
      "Premiere state, timeline summary, and full structure disagree on sequence duration.",
      { stateDuration, summaryDuration, structureDuration, durationTolerance },
    );
  }

  const captionSnapshot = normalizeCaptionSnapshot(captions, "Pre-write");
  if (captionSnapshot.count !== options.expectedExistingCaptionTracks) {
    fail(
      "EXISTING_CAPTION_GUARD_FAILED",
      "The existing caption-track count does not match the explicit guard.",
      {
        expected: options.expectedExistingCaptionTracks,
        actual: captionSnapshot.count,
      },
    );
  }

  return {
    project: {
      name: String(state.project.name),
      path: String(state.project.path || ""),
      expectedMatchedBy: projectMatch.matchedBy,
    },
    sequence: {
      name: sequenceName,
      id: sequenceId,
      durationSeconds: structureDuration,
      durationFrames: normalizedStructure.durationFrames,
      expectedMatchedBy: sequenceMatch.matchedBy,
    },
    frameTiming: {
      secondsPerFrame: timing.secondsPerFrame,
      fps: timing.fps,
      ticksPerFrame: timing.ticksPerFrame,
    },
    structure: normalizedStructure,
    structureFingerprint: fingerprint(normalizedStructure.tracks),
    videoAudioTrackCount: normalizedStructure.tracks.length,
    videoAudioClipCount: countNormalizedClips(normalizedStructure),
    captions: captionSnapshot,
  };
}

function assertIdentityStillActive(state, baseline) {
  const projectSame =
    String(state?.project?.name || "") === baseline.project.name &&
    normalizeWindowsPath(state?.project?.path) ===
      normalizeWindowsPath(baseline.project.path);
  const sequenceSame =
    String(state?.activeSequence?.name || "") === baseline.sequence.name &&
    String(state?.activeSequence?.id || "") === baseline.sequence.id;
  if (!projectSame || !sequenceSame) {
    fail(
      "IDENTITY_CHANGED_AFTER_IMPORT",
      "The active project or sequence changed after SRT import; caption creation was not attempted.",
      {
        expected: {
          project: baseline.project,
          sequence: baseline.sequence,
        },
        actual: {
          project: state?.project || null,
          sequence: state?.activeSequence || null,
        },
      },
    );
  }
}

function captionTrackComparable(track) {
  return {
    index: Number(track?.index),
    id: String(track?.id || ""),
    name: String(track?.name || ""),
    muted: Boolean(track?.muted),
    itemCount: Number(track?.itemCount),
    items: Array.isArray(track?.items)
      ? track.items.map((item) => ({
          index: Number(item?.index),
          startSeconds: Number(item?.startSeconds),
          endSeconds: Number(item?.endSeconds),
        }))
      : [],
  };
}

function captionTrackContentComparable(track) {
  const comparable = captionTrackComparable(track);
  return {
    index: comparable.index,
    id: comparable.id,
    itemCount: comparable.itemCount,
    items: comparable.items,
  };
}

// Stage-2 context grouping: each incoming cue must start on one authority cue's
// start frame and end on a later (or the same) authority cue's end frame, the
// groups must consume every authority cue exactly once in order, and no group
// may bridge a silence longer than CONTEXT_GROUP_MAX_INTERNAL_GAP_SECONDS.
function evaluateContextGroupedTimingAuthority(
  base,
  authorityTrack,
  authorityItems,
  srtInfo,
  options,
  timing,
) {
  const authority = authorityItems.map((item) => ({
    startSeconds: Number(item?.startSeconds),
    endSeconds: Number(item?.endSeconds),
    startFrame: nearestFrameIndex(item?.startSeconds, timing),
    endFrame: nearestFrameIndex(item?.endSeconds, timing),
  }));
  const blocked = (cueNumber, reason, mismatch) => ({
    ...base,
    ok: false,
    status: "blocked",
    mode: "context-grouped",
    failureCode: "CAPTION_TIMING_AUTHORITY_BOUNDARY_MISMATCH",
    failureMessage: `Incoming SRT cue ${cueNumber} is not a contiguous grouping of the visible timing-authority cues (${reason}); no caption write was attempted.`,
    authorityTrack,
    authorityCueCount: authority.length,
    checkedCueCount: cueNumber - 1,
    mismatch: {cueNumber, reason, ...mismatch},
  });

  let next = 0;
  let mergedIncomingCueCount = 0;
  let largestGroupSize = 0;
  let largestInternalGapSeconds = 0;
  for (let index = 0; index < srtInfo.cues.length; index += 1) {
    const cueNumber = index + 1;
    const expected = expectedCaptionCueFrames(
      srtInfo.cues[index],
      index,
      srtInfo.cues.length,
      options,
      timing,
    );
    const frames = {
      encodedStartSeconds: expected.encodedStartSeconds,
      encodedEndSeconds: expected.encodedEndSeconds,
      expectedStartFrame: expected.intendedStartFrame,
      expectedEndFrame: expected.intendedEndFrame,
      finalCueCompensationApplied: expected.finalCueCompensationApplied,
    };
    const first = authority[next];
    if (!first) {
      return blocked(cueNumber, "no authority cue left", frames);
    }
    if (
      expected.intendedStartFrame === null ||
      expected.intendedEndFrame === null ||
      authority.slice(next).some(
        (cue) => cue.startFrame === null || cue.endFrame === null,
      )
    ) {
      return blocked(cueNumber, "timing unavailable", frames);
    }
    if (first.startFrame !== expected.intendedStartFrame) {
      return blocked(cueNumber, "start is not the next authority start", {
        ...frames,
        authorityCueNumber: next + 1,
        actualStartFrame: first.startFrame,
        startDeltaFrames: first.startFrame - expected.intendedStartFrame,
      });
    }
    let last = next;
    while (
      last < authority.length &&
      authority[last].endFrame < expected.intendedEndFrame
    ) {
      last += 1;
    }
    if (
      last >= authority.length ||
      authority[last].endFrame !== expected.intendedEndFrame
    ) {
      const nearest = authority[Math.min(last, authority.length - 1)];
      return blocked(cueNumber, "end is not an authority end", {
        ...frames,
        authorityCueNumber: Math.min(last, authority.length - 1) + 1,
        actualEndFrame: nearest.endFrame,
        endDeltaFrames: nearest.endFrame - expected.intendedEndFrame,
      });
    }
    let groupGapSeconds = 0;
    for (let member = next; member < last; member += 1) {
      groupGapSeconds = Math.max(
        groupGapSeconds,
        authority[member + 1].startSeconds - authority[member].endSeconds,
      );
    }
    if (groupGapSeconds > CONTEXT_GROUP_MAX_INTERNAL_GAP_SECONDS + 1e-6) {
      return blocked(cueNumber, "group bridges a long silence", {
        ...frames,
        authorityCueStart: next + 1,
        authorityCueEnd: last + 1,
        largestInternalGapSeconds: groupGapSeconds,
        allowedInternalGapSeconds: CONTEXT_GROUP_MAX_INTERNAL_GAP_SECONDS,
      });
    }
    const groupSize = last - next + 1;
    if (groupSize > 1) mergedIncomingCueCount += 1;
    largestGroupSize = Math.max(largestGroupSize, groupSize);
    largestInternalGapSeconds = Math.max(
      largestInternalGapSeconds,
      groupGapSeconds,
    );
    next = last + 1;
  }
  if (next !== authority.length) {
    return blocked(srtInfo.cues.length, "authority cues left uncovered", {
      firstUncoveredAuthorityCue: next + 1,
      coveredAuthorityCueCount: next,
    });
  }
  return {
    ...base,
    ok: true,
    status: "matched-visible-authority-grouped",
    mode: "context-grouped",
    authorityTrack,
    authorityCueCount: authority.length,
    checkedCueCount: srtInfo.cueCount,
    coveredAuthorityCueCount: next,
    mergedIncomingCueCount,
    largestGroupSize,
    largestInternalGapSeconds,
    allowedInternalGapSeconds: CONTEXT_GROUP_MAX_INTERNAL_GAP_SECONDS,
  };
}

export function evaluateRevisionCaptionTimingAuthority(
  snapshotRaw,
  srtInfo,
  options,
  timing,
) {
  const snapshot = normalizeCaptionSnapshot(snapshotRaw, "Timing-authority");
  const applies = options?.revisionReviewMode === true && snapshot.count > 0;
  const overrideAllowed = options?.allowCaptionRetime === true;
  const secondsPerFrame = Number(timing?.secondsPerFrame);
  const fps = Number(timing?.fps);
  const visibleTracks = snapshot.tracks.filter(
    (track) => Boolean(track?.muted) === false,
  );
  const base = {
    applies,
    overrideAllowed,
    contextGroupingAllowed: options?.allowContextGrouping === true,
    comparison: "srt-import-floor-vs-native-nearest-exact",
    secondsPerFrame,
    fps,
    existingTrackCount: snapshot.count,
    visibleTrackCount: visibleTracks.length,
    requestedOffsetSeconds: Number(options?.startSeconds || 0),
    incomingCueCount: Number(srtInfo?.cueCount),
    transportCompensation: {
      enabled: options?.premiereFinalCueEndCompensation === true,
      scope: "final-cue-end-only",
      encodedDeltaFrames: 1,
      normalizationDeltaFrames: -1,
    },
  };

  if (!applies) {
    return {
      ...base,
      ok: true,
      status: "not-applicable",
      authorityTrack: null,
      checkedCueCount: 0,
    };
  }

  if (overrideAllowed) {
    return {
      ...base,
      ok: true,
      status: "explicit-retime-override",
      authorityTrack: null,
      checkedCueCount: 0,
    };
  }

  if (visibleTracks.length !== 1) {
    return {
      ...base,
      ok: false,
      status: "blocked",
      failureCode: "CAPTION_TIMING_AUTHORITY_AMBIGUOUS",
      failureMessage:
        "Revision-review requires exactly one visible existing caption track as timing authority; use --allow-caption-retime only for an explicitly approved retime.",
      authorityTrack: null,
      checkedCueCount: 0,
      visibleTracks: visibleTracks.map((track) => ({
        index: Number(track?.index),
        id: String(track?.id || ""),
        name: String(track?.name || ""),
        itemCount: Number(track?.itemCount),
      })),
    };
  }

  const authority = visibleTracks[0];
  const authorityItems = Array.isArray(authority?.items) ? authority.items : [];
  const authorityCueCount = Number(authority?.itemCount);
  const authorityTrack = {
    index: Number(authority?.index),
    id: String(authority?.id || ""),
    name: String(authority?.name || ""),
    itemCount: authorityCueCount,
  };

  if (
    !Number.isInteger(authorityCueCount) ||
    authorityCueCount < 0 ||
    authorityItems.length !== authorityCueCount
  ) {
    return {
      ...base,
      ok: false,
      status: "blocked",
      failureCode: "CAPTION_TIMING_AUTHORITY_ITEMS_UNAVAILABLE",
      failureMessage:
        "The visible timing-authority track does not expose a complete cue timing list; no caption write was attempted.",
      authorityTrack,
      authorityItemArrayCount: authorityItems.length,
      checkedCueCount: 0,
    };
  }

  if (authorityCueCount !== srtInfo.cueCount) {
    if (
      base.contextGroupingAllowed &&
      srtInfo.cueCount > 0 &&
      srtInfo.cueCount < authorityCueCount
    ) {
      return evaluateContextGroupedTimingAuthority(
        base,
        authorityTrack,
        authorityItems,
        srtInfo,
        options,
        timing,
      );
    }
    return {
      ...base,
      ok: false,
      status: "blocked",
      failureCode: "CAPTION_TIMING_AUTHORITY_CUE_COUNT_MISMATCH",
      failureMessage:
        "The incoming SRT cue count differs from the visible timing-authority track; no caption write was attempted. A stage-2 context-merged SRT needs --allow-context-grouping.",
      authorityTrack,
      authorityCueCount,
      checkedCueCount: 0,
    };
  }

  for (let index = 0; index < srtInfo.cues.length; index += 1) {
    const incomingCue = srtInfo.cues[index];
    const authorityCue = authorityItems[index];
    const expected = expectedCaptionCueFrames(
      incomingCue,
      index,
      srtInfo.cues.length,
      options,
      timing,
    );
    const actualStartSeconds = Number(authorityCue?.startSeconds);
    const actualEndSeconds = Number(authorityCue?.endSeconds);
    const actualStartFrame = nearestFrameIndex(actualStartSeconds, timing);
    const actualEndFrame = nearestFrameIndex(actualEndSeconds, timing);
    if (
      !Number.isFinite(actualStartSeconds) ||
      !Number.isFinite(actualEndSeconds) ||
      expected.intendedStartFrame === null ||
      expected.intendedEndFrame === null ||
      actualStartFrame === null ||
      actualEndFrame === null ||
      actualStartFrame !== expected.intendedStartFrame ||
      actualEndFrame !== expected.intendedEndFrame
    ) {
      const compensationDeltaFrames =
        expected.finalCueCompensationApplied &&
        expected.encodedEndFrame !== null &&
        actualEndFrame !== null
          ? expected.encodedEndFrame - actualEndFrame
          : null;
      const compensationMisuse =
        expected.finalCueCompensationApplied && compensationDeltaFrames !== 1;
      return {
        ...base,
        ok: false,
        status: "blocked",
        failureCode: compensationMisuse
          ? "CAPTION_FINAL_CUE_COMPENSATION_MISMATCH"
          : "CAPTION_TIMING_AUTHORITY_BOUNDARY_MISMATCH",
        failureMessage:
          compensationMisuse
            ? "The compensated SRT final cue end must be encoded exactly one sequence frame after the visible timing authority; no caption write was attempted."
            : `Incoming SRT cue ${index + 1} changes the visible timing-authority start or end boundary; no caption write was attempted.`,
        authorityTrack,
        checkedCueCount: index,
        mismatch: {
          cueNumber: index + 1,
          encodedStartSeconds: expected.encodedStartSeconds,
          encodedEndSeconds: expected.encodedEndSeconds,
          actualStartSeconds,
          actualEndSeconds,
          encodedStartFrame: expected.encodedStartFrame,
          encodedEndFrame: expected.encodedEndFrame,
          expectedStartFrame: expected.intendedStartFrame,
          expectedEndFrame: expected.intendedEndFrame,
          actualStartFrame,
          actualEndFrame,
          startDeltaFrames:
            actualStartFrame === null || expected.intendedStartFrame === null
              ? null
              : actualStartFrame - expected.intendedStartFrame,
          endDeltaFrames:
            actualEndFrame === null || expected.intendedEndFrame === null
              ? null
              : actualEndFrame - expected.intendedEndFrame,
          encodedEndDeltaFromAuthorityFrames: compensationDeltaFrames,
          finalCueCompensationApplied:
            expected.finalCueCompensationApplied,
        },
      };
    }
  }

  return {
    ...base,
    ok: true,
    status: "matched-visible-authority",
    authorityTrack,
    authorityCueCount,
    checkedCueCount: srtInfo.cueCount,
  };
}

export function retiredCaptionTrackName(
  track,
  prefix = DEFAULT_RETIRED_TRACK_PREFIX,
) {
  const currentName = String(track?.name || `Caption ${Number(track?.index) + 1}`).trim();
  if (currentName.startsWith(prefix)) return currentName;
  const cueCount = Number(track?.itemCount);
  const cueSuffix =
    Number.isInteger(cueCount) && cueCount >= 0 && !/\d+cue\b/u.test(currentName)
      ? ` · ${cueCount}cue`
      : "";
  return `${prefix} ${currentName}${cueSuffix}`;
}

export function buildCaptionRetirementPlan(
  snapshotRaw,
  prefix = DEFAULT_RETIRED_TRACK_PREFIX,
) {
  const snapshot = normalizeCaptionSnapshot(snapshotRaw, "Retirement-plan");
  return snapshot.tracks.map((track) => ({
    index: Number(track?.index),
    id: String(track?.id || ""),
    currentName: String(track?.name || ""),
    desiredName: retiredCaptionTrackName(track, prefix),
    currentMuted: Boolean(track?.muted),
    desiredMuted: true,
    itemCount: Number(track?.itemCount),
    needsMute: !Boolean(track?.muted),
    needsRename:
      String(track?.name || "") !== retiredCaptionTrackName(track, prefix),
  }));
}

export function verifyCaptionRetirement(
  beforeRaw,
  afterRaw,
  prefix = DEFAULT_RETIRED_TRACK_PREFIX,
) {
  const before = normalizeCaptionSnapshot(beforeRaw, "Pre-retirement");
  const after = normalizeCaptionSnapshot(afterRaw, "Post-retirement");
  const failures = [];
  if (after.count !== before.count) {
    failures.push({
      kind: "caption_track_count",
      expected: before.count,
      actual: after.count,
    });
  }
  for (let index = 0; index < Math.min(before.count, after.count); index += 1) {
    const beforeTrack = before.tracks[index];
    const afterTrack = after.tracks[index];
    if (
      JSON.stringify(captionTrackContentComparable(beforeTrack)) !==
      JSON.stringify(captionTrackContentComparable(afterTrack))
    ) {
      failures.push({kind: "retired_caption_content_changed", trackIndex: index});
    }
    const expectedName = retiredCaptionTrackName(beforeTrack, prefix);
    if (String(afterTrack?.name || "") !== expectedName) {
      failures.push({
        kind: "retired_caption_name",
        trackIndex: index,
        expected: expectedName,
        actual: String(afterTrack?.name || ""),
      });
    }
    if (Boolean(afterTrack?.muted) !== true) {
      failures.push({kind: "retired_caption_visible", trackIndex: index});
    }
  }
  return {
    ok: failures.length === 0,
    trackCount: after.count,
    retiredTracks: after.tracks.map((track) => ({
      index: Number(track?.index),
      id: String(track?.id || ""),
      name: String(track?.name || ""),
      muted: Boolean(track?.muted),
      itemCount: Number(track?.itemCount),
    })),
    failures,
  };
}

export function verifyCaptionAddition(
  beforeRaw,
  afterRaw,
  srtInfo,
  options,
  timing,
) {
  const before = normalizeCaptionSnapshot(beforeRaw, "Pre-write");
  const after = normalizeCaptionSnapshot(afterRaw, "Post-write");
  const failures = [];
  if (after.count !== before.count + 1) {
    failures.push({
      kind: "caption_track_count",
      expected: before.count + 1,
      actual: after.count,
    });
  }

  for (let index = 0; index < Math.min(before.count, after.count); index += 1) {
    if (
      JSON.stringify(captionTrackComparable(before.tracks[index])) !==
      JSON.stringify(captionTrackComparable(after.tracks[index]))
    ) {
      failures.push({ kind: "existing_caption_track_changed", trackIndex: index });
    }
  }

  const addedTrack =
    after.count === before.count + 1 ? after.tracks[before.count] : null;
  const itemArrayAvailable = Array.isArray(addedTrack?.items);
  const items = itemArrayAvailable ? addedTrack.items : [];
  const itemCount = Number(addedTrack?.itemCount ?? items.length);
  if (addedTrack && itemCount !== srtInfo.cueCount) {
    failures.push({
      kind: "caption_cue_count",
      expected: srtInfo.cueCount,
      actual: itemCount,
    });
  }
  if (addedTrack && Boolean(addedTrack.muted) !== false) {
    failures.push({kind: "added_caption_track_muted"});
  }
  const visibleTrackCount = after.tracks.filter(
    (track) => Boolean(track?.muted) === false,
  ).length;
  if (visibleTrackCount !== 1) {
    failures.push({
      kind: "visible_caption_track_count",
      expected: 1,
      actual: visibleTrackCount,
    });
  }
  if (
    addedTrack &&
    options.newTrackName &&
    String(addedTrack.name || "") !== options.newTrackName
  ) {
    failures.push({
      kind: "added_caption_track_name",
      expected: options.newTrackName,
      actual: String(addedTrack.name || ""),
    });
  }
  if (addedTrack && items.length !== itemCount) {
    failures.push({
      kind: "caption_item_array_count",
      declared: itemCount,
      actual: items.length,
    });
  }
  if (addedTrack && !itemArrayAvailable) {
    failures.push({kind: "caption_item_array_missing"});
  }

  const expectedStart = srtInfo.startSeconds + options.startSeconds;
  const expectedEnd = srtInfo.endSeconds + options.startSeconds;
  const finiteItems = items.filter(
    (item) =>
      Number.isFinite(Number(item?.startSeconds)) &&
      Number.isFinite(Number(item?.endSeconds)),
  );
  const actualStart = finiteItems.length
    ? Math.min(...finiteItems.map((item) => Number(item.startSeconds)))
    : null;
  const actualEnd = finiteItems.length
    ? Math.max(...finiteItems.map((item) => Number(item.endSeconds)))
    : null;
  if (addedTrack && finiteItems.length !== items.length) {
    failures.push({ kind: "caption_item_timing_unavailable" });
  }

  const timingMismatches = [];
  const comparableCueCount = Math.min(items.length, srtInfo.cues.length);
  for (let index = 0; index < comparableCueCount; index += 1) {
    const expectedCue = srtInfo.cues[index];
    const actualCue = items[index];
    const expected = expectedCaptionCueFrames(
      expectedCue,
      index,
      srtInfo.cues.length,
      options,
      timing,
    );
    const actualStartSeconds = Number(actualCue?.startSeconds);
    const actualEndSeconds = Number(actualCue?.endSeconds);
    const actualStartFrame = nearestFrameIndex(actualStartSeconds, timing);
    const actualEndFrame = nearestFrameIndex(actualEndSeconds, timing);
    if (
      expected.intendedStartFrame === null ||
      expected.intendedEndFrame === null ||
      actualStartFrame === null ||
      actualEndFrame === null ||
      actualStartFrame !== expected.intendedStartFrame ||
      actualEndFrame !== expected.intendedEndFrame
    ) {
      timingMismatches.push({
        cueNumber: index + 1,
        encodedStartSeconds: expected.encodedStartSeconds,
        encodedEndSeconds: expected.encodedEndSeconds,
        actualStartSeconds: Number.isFinite(actualStartSeconds)
          ? actualStartSeconds
          : null,
        actualEndSeconds: Number.isFinite(actualEndSeconds)
          ? actualEndSeconds
          : null,
        encodedStartFrame: expected.encodedStartFrame,
        encodedEndFrame: expected.encodedEndFrame,
        expectedStartFrame: expected.intendedStartFrame,
        expectedEndFrame: expected.intendedEndFrame,
        actualStartFrame,
        actualEndFrame,
        startDeltaFrames:
          actualStartFrame === null || expected.intendedStartFrame === null
            ? null
            : actualStartFrame - expected.intendedStartFrame,
        endDeltaFrames:
          actualEndFrame === null || expected.intendedEndFrame === null
            ? null
            : actualEndFrame - expected.intendedEndFrame,
        encodedEndDeltaFromActualFrames:
          actualEndFrame === null || expected.encodedEndFrame === null
            ? null
            : expected.encodedEndFrame - actualEndFrame,
        finalCueCompensationApplied:
          expected.finalCueCompensationApplied,
      });
    }
  }
  if (addedTrack && timingMismatches.length > 0) {
    failures.push({
      kind: "caption_cue_frame_boundary_mismatch",
      comparison: "srt-import-floor-vs-native-nearest-exact",
      mismatchCount: timingMismatches.length,
      mismatches: timingMismatches,
    });
  }

  const finalExpected = expectedCaptionCueFrames(
    srtInfo.cues.at(-1),
    srtInfo.cues.length - 1,
    srtInfo.cues.length,
    options,
    timing,
  );
  const finalActualEndFrame = nearestFrameIndex(items.at(-1)?.endSeconds, timing);
  const observedFinalCueEndTransportDeltaFrames =
    finalExpected.encodedEndFrame === null || finalActualEndFrame === null
      ? null
      : finalExpected.encodedEndFrame - finalActualEndFrame;

  return {
    ok: failures.length === 0,
    beforeTrackCount: before.count,
    afterTrackCount: after.count,
    addedTrackIndex: addedTrack ? Number(addedTrack.index) : null,
    addedTrackId: addedTrack ? String(addedTrack.id || "") : null,
    cueCount: itemCount,
    addedTrackName: addedTrack ? String(addedTrack.name || "") : null,
    addedTrackMuted: addedTrack ? Boolean(addedTrack.muted) : null,
    visibleTrackCount,
    expectedRange: { startSeconds: expectedStart, endSeconds: expectedEnd },
    actualRange: { startSeconds: actualStart, endSeconds: actualEnd },
    timingComparison: {
      mode: "srt-import-floor-vs-native-nearest-exact",
      secondsPerFrame: Number(timing?.secondsPerFrame),
      fps: Number(timing?.fps),
      expectedCueCount: srtInfo.cueCount,
      actualItemCount: items.length,
      checkedCueCount: comparableCueCount,
      mismatchCount: timingMismatches.length,
      mismatches: timingMismatches,
      transportCompensation: {
        enabled: options?.premiereFinalCueEndCompensation === true,
        scope: "final-cue-end-only",
        encodedDeltaFrames: 1,
        normalizationDeltaFrames: -1,
        encodedFinalCueEndFrame: finalExpected.encodedEndFrame,
        intendedFinalCueEndFrame: finalExpected.intendedEndFrame,
        actualFinalCueEndFrame: finalActualEndFrame,
        observedEncodedToActualDeltaFrames:
          observedFinalCueEndTransportDeltaFrames,
      },
    },
    failures,
  };
}

export function compareSequenceSnapshots(beforeNormalized, afterRaw, timing) {
  let after;
  try {
    after = normalizeSequenceStructureStrict(afterRaw, timing);
  } catch (error) {
    return {
      ok: false,
      durationUnchanged: false,
      videoAudioUnchanged: false,
      failures: [
        {
          kind: "invalid_post_structure",
          message: String(error?.message || error),
        },
      ],
    };
  }

  const failures = [];
  if (after.id !== beforeNormalized.id || after.name !== beforeNormalized.name) {
    failures.push({
      kind: "sequence_identity_changed",
      before: { id: beforeNormalized.id, name: beforeNormalized.name },
      after: { id: after.id, name: after.name },
    });
  }
  const durationUnchanged = after.durationFrames === beforeNormalized.durationFrames;
  if (!durationUnchanged) {
    failures.push({
      kind: "sequence_duration_changed",
      beforeFrames: beforeNormalized.durationFrames,
      afterFrames: after.durationFrames,
    });
  }
  const beforeFingerprint = fingerprint(beforeNormalized.tracks);
  const afterFingerprint = fingerprint(after.tracks);
  const videoAudioUnchanged = beforeFingerprint === afterFingerprint;
  if (!videoAudioUnchanged) {
    failures.push({
      kind: "video_audio_structure_changed",
      beforeFingerprint,
      afterFingerprint,
      beforeTrackCount: beforeNormalized.tracks.length,
      afterTrackCount: after.tracks.length,
      beforeClipCount: countNormalizedClips(beforeNormalized),
      afterClipCount: countNormalizedClips(after),
    });
  }
  return {
    ok: failures.length === 0,
    durationUnchanged,
    videoAudioUnchanged,
    beforeDurationFrames: beforeNormalized.durationFrames,
    afterDurationFrames: after.durationFrames,
    beforeFingerprint,
    afterFingerprint,
    checkedTrackCount: after.tracks.length,
    checkedClipCount: countNormalizedClips(after),
    failures,
  };
}

function initialReport(rawOptions) {
  return {
    schemaVersion: 1,
    operation: "apply-premiere-caption-track",
    ok: false,
    mode: rawOptions?.allowWrite === true ? "write" : "dry-run",
    status: "starting",
    phase: "options",
    policy: {
      computerUse: false,
      projectSave: false,
      writeRetries: 0,
      expectedCaptionTrackDelta: 1,
      officialUxpForReadsAndImport: true,
      legacyCepForCaptionCreation: true,
      revisionReviewMode: rawOptions?.revisionReviewMode === true,
      allowCaptionRetime: rawOptions?.allowCaptionRetime === true,
      allowContextGrouping: rawOptions?.allowContextGrouping === true,
      premiereFinalCueEndCompensation:
        rawOptions?.premiereFinalCueEndCompensation === true,
      visibleCaptionTrackIsTimingAuthority: true,
      onlyOneVisibleCaptionTrackAfterWrite: true,
      captionStyleCopySupported: false,
      visualStyleVerificationRequired: true,
    },
    calls: [],
    writeAttempts: [],
    srt: null,
    baseline: null,
    post: null,
    verification: null,
    revision: null,
    partialState: null,
    failure: null,
    exitCode: 2,
  };
}

function finalizeFailure(report, error) {
  const summarized = summarizeError(error);
  report.ok = false;
  report.failure = summarized;
  report.phase = error?.phase || report.phase;
  const confirmedWrites = report.writeAttempts
    .filter((entry) => entry.outcome === "confirmed")
    .map((entry) => entry.tool);
  const uncertainWrite = report.writeAttempts.find(
    (entry) => entry.outcome === "uncertain",
  );
  const failedWrite = report.writeAttempts.find(
    (entry) => entry.outcome === "failed",
  );

  if (error?.uncertain || uncertainWrite) {
    report.status = "write-outcome-uncertain";
    report.exitCode = 3;
  } else if (
    report.phase === "post-read" ||
    report.phase === "verification" ||
    confirmedWrites.includes("create_caption_track")
  ) {
    report.status = "verification-incomplete-or-failed";
    report.exitCode = 4;
  } else if (confirmedWrites.length > 0 || failedWrite) {
    report.status = "partial-write-stopped";
    report.exitCode = 4;
  } else {
    report.status = "blocked-before-write";
    report.exitCode = 2;
  }

  if (report.writeAttempts.length > 0) {
    report.partialState = {
      confirmedWrites,
      uncertainWrite: uncertainWrite?.tool || null,
      failedWrite: failedWrite?.tool || null,
      srtProjectItemMayRemain:
        confirmedWrites.includes("import_media") ||
        uncertainWrite?.tool === "import_media" ||
        failedWrite?.tool === "import_media",
      captionTrackMayExist:
        confirmedWrites.includes("create_caption_track") ||
        uncertainWrite?.tool === "create_caption_track" ||
        failedWrite?.tool === "create_caption_track",
      existingCaptionTracksMayBeRetired:
        confirmedWrites.includes("set_caption_track_mute") ||
        confirmedWrites.includes("rename_caption_track"),
      nextAction:
        "Do not resend either write. Start a fresh read-only identity/caption/full-structure pass before any later mutation.",
      projectSaved: false,
    };
  }
  return report;
}

function publicBaseline(baseline) {
  return {
    project: baseline.project,
    sequence: baseline.sequence,
    frameTiming: baseline.frameTiming,
    structureFingerprint: baseline.structureFingerprint,
    videoAudioTrackCount: baseline.videoAudioTrackCount,
    videoAudioClipCount: baseline.videoAudioClipCount,
    captionTrackCount: baseline.captions.count,
    captionTracks: baseline.captions.tracks.map((track) => ({
      index: Number(track?.index),
      id: String(track?.id || ""),
      name: String(track?.name || ""),
      muted: Boolean(track?.muted),
      itemCount: Number(track?.itemCount),
    })),
  };
}

export async function runCaptionTrackApplication(rawOptions, dependencies = {}) {
  const report = initialReport(rawOptions);
  let options;
  const fsApi = dependencies.fs || fs;
  const runnerFactoryOptions = {};

  try {
    options = normalizeOptions(rawOptions);
    report.mode = options.allowWrite ? "write" : "dry-run";
    report.phase = "srt";
    const stat = fsApi.statSync(options.srt);
    if (!stat.isFile()) {
      fail("SRT_NOT_FILE", "The SRT path is not a regular file.", {
        path: options.srt,
      });
    }
    const source = fsApi.readFileSync(options.srt, "utf8");
    const srtInfo = validateSrtForApplication(source);
    report.srt = {
      path: options.srt,
      basename: path.basename(options.srt),
      sha256: createHash("sha256").update(source).digest("hex"),
      cueCount: srtInfo.cueCount,
      sourceRange: {
        startSeconds: srtInfo.startSeconds,
        endSeconds: srtInfo.endSeconds,
      },
      requestedOffsetSeconds: options.startSeconds,
      requestedRange: {
        startSeconds: srtInfo.startSeconds + options.startSeconds,
        endSeconds: srtInfo.endSeconds + options.startSeconds,
      },
      captionFormat: options.captionFormat,
      transportCompensation: {
        enabled: options.premiereFinalCueEndCompensation,
        scope: "final-cue-end-only",
        encodedDeltaFrames: 1,
        normalizationDeltaFrames: -1,
      },
    };

    Object.assign(runnerFactoryOptions, {
      timeoutMs: options.timeoutMs,
      uxpBridgeDir: options.uxpBridgeDir,
      cepTempDir: options.cepTempDir,
      mcpRoot: options.mcpRoot,
    });
    const runner =
      dependencies.runner || createDefaultRunner(runnerFactoryOptions);
    const wait =
      dependencies.wait ||
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const attemptedWrites = new Set();

    const invoke = async ({
      phase,
      tool,
      args = {},
      route,
      mutation = false,
      allowExperimental = false,
      mutationKey = null,
    }) => {
      const writeIdentity = mutationKey || tool;
      if (mutation) {
        if (attemptedWrites.has(writeIdentity)) {
          fail(
            "WRITE_RETRY_FORBIDDEN",
            `Refusing a second '${writeIdentity}' write attempt.`,
            null,
            { phase },
          );
        }
        attemptedWrites.add(writeIdentity);
      }
      const call = {
        index: report.calls.length + 1,
        phase,
        tool,
        route,
        mutation,
        mutationKey: mutation ? writeIdentity : null,
        attempt: 1,
        outcome: "started",
      };
      report.calls.push(call);
      if (mutation) report.writeAttempts.push(call);
      try {
        const payload = await runner({
          phase,
          tool,
          args,
          route,
          mutation,
          mutationKey: mutation ? writeIdentity : null,
          allowWrite: mutation,
          allowExperimental,
          timeoutMs: options.timeoutMs,
        });
        call.outcome = "confirmed";
        return payload;
      } catch (error) {
        call.outcome = mutation && error?.uncertain ? "uncertain" : "failed";
        call.error = summarizeError(error);
        throw new CaptionApplyFailure(
          mutation && error?.uncertain
            ? "WRITE_OUTCOME_UNCERTAIN"
            : mutation
              ? "WRITE_CALL_FAILED"
              : "READ_CALL_FAILED",
          String(error?.message || error),
          error?.details ?? null,
          { phase, uncertain: mutation && error?.uncertain },
        );
      }
    };

    report.phase = "pre-read";
    const ping = await invoke({
      phase: "pre-read",
      tool: "ping",
      route: "uxp",
    });
    const state = await invoke({
      phase: "pre-read",
      tool: "get_premiere_state",
      route: "uxp",
    });
    const identityForRead = state?.activeSequence?.id
      ? { sequence_id: String(state.activeSequence.id) }
      : {};
    const summary = await invoke({
      phase: "pre-read",
      tool: "get_timeline_summary",
      args: identityForRead,
      route: "uxp",
    });
    const structure = await invoke({
      phase: "pre-read",
      tool: "get_sequence_structure",
      args: identityForRead,
      route: "uxp",
    });
    const captions = await invoke({
      phase: "pre-read",
      tool: "get_caption_tracks",
      args: identityForRead,
      route: "uxp",
    });
    const matchingProjectItems = await invoke({
      phase: "pre-read",
      tool: "search_project_items",
      args: {
        query: path.basename(options.srt),
        max_results: 10_000,
      },
      route: "uxp",
    });
    const exactCaptionSourceMatches = Array.isArray(matchingProjectItems?.items)
      ? matchingProjectItems.items.filter(
          (item) => String(item?.name || "") === path.basename(options.srt),
        )
      : [];
    if (exactCaptionSourceMatches.length > 0) {
      fail(
        "CAPTION_SOURCE_NAME_COLLISION",
        "A project item with the same SRT basename already exists; rename the source so CEP targeting remains unambiguous.",
        {
          basename: path.basename(options.srt),
          matches: exactCaptionSourceMatches.map((item) => ({
            nodeId: item?.nodeId || item?.id || null,
            name: item?.name || null,
            mediaPath: item?.mediaPath || null,
          })),
        },
        { phase: "pre-read" },
      );
    }
    const baseline = baselineFromReads(
      { ping, state, summary, structure, captions },
      options,
    );
    report.baseline = publicBaseline(baseline);
    const retirementPlan = options.revisionReviewMode
      ? buildCaptionRetirementPlan(captions, options.retiredTrackPrefix)
      : [];
    const timingAuthority = evaluateRevisionCaptionTimingAuthority(
      captions,
      srtInfo,
      options,
      baseline.frameTiming,
    );
    const compensationSequenceTail =
      evaluateFinalCueCompensationSequenceTail(
        srtInfo,
        options,
        baseline.frameTiming,
        baseline.sequence.durationFrames,
      );
    report.revision = {
      enabled: options.revisionReviewMode,
      allowCaptionRetime: options.allowCaptionRetime,
      allowContextGrouping: options.allowContextGrouping,
      premiereFinalCueEndCompensation:
        options.premiereFinalCueEndCompensation,
      retiredTrackPrefix: options.retiredTrackPrefix,
      newTrackName: options.newTrackName,
      timingAuthority,
      compensationSequenceTail,
      retirementPlan,
      retirementVerification: null,
    };
    if (!timingAuthority.ok) {
      fail(
        timingAuthority.failureCode,
        timingAuthority.failureMessage,
        timingAuthority,
        { phase: "pre-read" },
      );
    }
    if (!compensationSequenceTail.ok) {
      fail(
        "FINAL_CUE_COMPENSATION_SEQUENCE_TAIL_FORBIDDEN",
        "The compensated SRT final cue end must remain strictly before the sequence's exclusive duration frame; no caption write was attempted.",
        compensationSequenceTail,
        {phase: "pre-read"},
      );
    }

    const captionEnd = srtInfo.endSeconds + options.startSeconds;
    const rangeTolerance = Math.max(
      0.05,
      baseline.frameTiming.secondsPerFrame * 1.5,
    );
    if (captionEnd > baseline.sequence.durationSeconds + rangeTolerance) {
      fail(
        "SRT_OUTSIDE_SEQUENCE",
        "The requested caption range extends beyond the active sequence.",
        {
          captionEndSeconds: captionEnd,
          sequenceDurationSeconds: baseline.sequence.durationSeconds,
          toleranceSeconds: rangeTolerance,
        },
        { phase: "pre-read" },
      );
    }

    if (!options.allowWrite) {
      report.ok = true;
      report.status = "dry-run-complete";
      report.phase = "complete";
      report.exitCode = 0;
      report.verification = {
        preflightPassed: true,
        writesSubmitted: 0,
        expectedPostCaptionTrackCount: baseline.captions.count + 1,
        expectedVisibleCaptionTrackCount: 1,
        captionStyle: {
          copiedByApi: false,
          verified: false,
          reason: "Adobe stable UXP does not expose caption font/size/track-style copy.",
        },
        projectSaved: false,
      };
      return report;
    }

    let captionBaselineForAddition = captions;
    if (options.revisionReviewMode) {
      report.phase = "retire-existing-caption-tracks";
      for (const track of retirementPlan.filter((entry) => entry.needsMute)) {
        await invoke({
          phase: "retire-existing-caption-tracks",
          tool: "set_caption_track_mute",
          args: {
            sequence_id: baseline.sequence.id,
            track_index: track.index,
            muted: true,
          },
          route: "uxp",
          mutation: true,
          mutationKey: `set_caption_track_mute:${track.index}:true`,
        });
      }
      for (const track of retirementPlan.filter((entry) => entry.needsRename)) {
        await invoke({
          phase: "retire-existing-caption-tracks",
          tool: "rename_caption_track",
          args: {
            sequence_id: baseline.sequence.id,
            track_index: track.index,
            name: track.desiredName,
          },
          route: "uxp",
          mutation: true,
          mutationKey: `rename_caption_track:retired:${track.index}`,
        });
      }
      if (retirementPlan.some((entry) => entry.needsMute || entry.needsRename)) {
        await wait(POST_WRITE_YIELD_MS);
      }
      const retiredCaptions = await invoke({
        phase: "retire-existing-caption-read",
        tool: "get_caption_tracks",
        args: { sequence_id: baseline.sequence.id },
        route: "uxp",
      });
      const retirementVerification = verifyCaptionRetirement(
        captions,
        retiredCaptions,
        options.retiredTrackPrefix,
      );
      report.revision.retirementVerification = retirementVerification;
      if (!retirementVerification.ok) {
        fail(
          "CAPTION_RETIREMENT_VERIFICATION_FAILED",
          "Existing caption tracks were not fully marked and hidden before adding the reviewed revision.",
          retirementVerification,
          { phase: "retire-existing-caption-read" },
        );
      }
      captionBaselineForAddition = retiredCaptions;
    }

    report.phase = "import_media";
    const imported = await invoke({
      phase: "import_media",
      tool: "import_media",
      args: { file_paths: [options.srt], suppress_ui: true },
      route: "uxp",
      mutation: true,
    });
    if (
      Number(imported?.imported) !== 1 ||
      !Array.isArray(imported?.files) ||
      !imported.files.some(
        (file) => normalizeWindowsPath(file) === normalizeWindowsPath(options.srt),
      )
    ) {
      fail(
        "IMPORT_MEDIA_READBACK_MISMATCH",
        "UXP import_media did not confirm exactly the requested SRT path.",
        { imported },
        { phase: "import_media" },
      );
    }
    await wait(POST_WRITE_YIELD_MS);

    report.phase = "pre-caption-create-read";
    const stateAfterImport = await invoke({
      phase: "pre-caption-create-read",
      tool: "get_premiere_state",
      route: "uxp",
    });
    assertIdentityStillActive(stateAfterImport, baseline);
    const captionsAfterImport = await invoke({
      phase: "pre-caption-create-read",
      tool: "get_caption_tracks",
      args: { sequence_id: baseline.sequence.id },
      route: "uxp",
    });
    const afterImportCaptionSnapshot = normalizeCaptionSnapshot(
      captionsAfterImport,
      "After-import",
    );
    const expectedCaptionBaseline = normalizeCaptionSnapshot(
      captionBaselineForAddition,
      "Expected-before-create",
    );
    if (afterImportCaptionSnapshot.count !== expectedCaptionBaseline.count) {
      fail(
        "CAPTION_COUNT_CHANGED_BEFORE_CREATE",
        "Caption tracks changed after SRT import and before caption creation.",
        {
          before: expectedCaptionBaseline.count,
          afterImport: afterImportCaptionSnapshot.count,
        },
        { phase: "pre-caption-create-read" },
      );
    }
    for (let index = 0; index < expectedCaptionBaseline.count; index += 1) {
      if (
        JSON.stringify(captionTrackComparable(expectedCaptionBaseline.tracks[index])) !==
        JSON.stringify(captionTrackComparable(afterImportCaptionSnapshot.tracks[index]))
      ) {
        fail(
          "EXISTING_CAPTION_CHANGED_BEFORE_CREATE",
          "An existing or retired caption track changed after SRT import and before caption creation.",
          { trackIndex: index },
          { phase: "pre-caption-create-read" },
        );
      }
    }
    const importedProjectItem = await invoke({
      phase: "pre-caption-create-read",
      tool: "find_project_item_by_name",
      args: { name: path.basename(options.srt) },
      route: "uxp",
    });
    if (
      String(importedProjectItem?.name || "") !== path.basename(options.srt) ||
      (String(importedProjectItem?.mediaPath || "") &&
        normalizeWindowsPath(importedProjectItem.mediaPath) !==
          normalizeWindowsPath(options.srt))
    ) {
      fail(
        "IMPORTED_CAPTION_ITEM_MISMATCH",
        "The imported Premiere project item does not resolve to the requested SRT.",
        { importedProjectItem, expectedPath: options.srt },
        { phase: "pre-caption-create-read" },
      );
    }

    report.phase = "create_caption_track";
    const created = await invoke({
      phase: "create_caption_track",
      tool: "create_caption_track",
      args: {
        item_id: String(importedProjectItem.name),
        start_seconds: options.startSeconds,
        caption_format: options.captionFormat,
      },
      route: "cep",
      mutation: true,
      allowExperimental: true,
    });
    if (created?.created !== true) {
      fail(
        "CAPTION_CREATE_RESPONSE_MISMATCH",
        "CEP create_caption_track did not return created=true.",
        { created },
        { phase: "create_caption_track" },
      );
    }
    await wait(POST_WRITE_YIELD_MS);

    const timing = {
      secondsPerFrame: baseline.frameTiming.secondsPerFrame,
      fps: baseline.frameTiming.fps,
      ticksPerFrame: baseline.frameTiming.ticksPerFrame,
      gridToleranceFrames: 0.05,
    };
    report.phase = "post-create-read";
    const captionsAfterCreate = await invoke({
      phase: "post-create-read",
      tool: "get_caption_tracks",
      args: { sequence_id: baseline.sequence.id },
      route: "uxp",
    });
    const creationVerification = verifyCaptionAddition(
      captionBaselineForAddition,
      captionsAfterCreate,
      srtInfo,
      {...options, newTrackName: null},
      timing,
    );
    if (!creationVerification.ok) {
      fail(
        "POST_WRITE_INVARIANT_FAILED",
        "The newly created caption track failed count, timing, visibility, or retired-track invariants.",
        creationVerification,
        { phase: "verification" },
      );
    }

    let postCaptions = captionsAfterCreate;
    if (options.newTrackName) {
      report.phase = "rename-new-caption-track";
      await invoke({
        phase: "rename-new-caption-track",
        tool: "rename_caption_track",
        args: {
          sequence_id: baseline.sequence.id,
          track_index: creationVerification.addedTrackIndex,
          name: options.newTrackName,
        },
        route: "uxp",
        mutation: true,
        mutationKey: `rename_caption_track:new:${creationVerification.addedTrackIndex}`,
      });
      await wait(POST_WRITE_YIELD_MS);
      postCaptions = await invoke({
        phase: "post-read",
        tool: "get_caption_tracks",
        args: { sequence_id: baseline.sequence.id },
        route: "uxp",
      });
    }

    report.phase = "post-read";
    const postStructure = await invoke({
      phase: "post-read",
      tool: "get_sequence_structure",
      args: { sequence_id: baseline.sequence.id },
      route: "uxp",
    });

    report.phase = "verification";
    const captionVerification = verifyCaptionAddition(
      captionBaselineForAddition,
      postCaptions,
      srtInfo,
      options,
      timing,
    );
    const sequenceVerification = compareSequenceSnapshots(
      baseline.structure,
      postStructure,
      timing,
    );
    report.post = {
      captionTrackCount: Number(postCaptions?.captionTrackCount),
      visibleCaptionTrackCount: captionVerification.visibleTrackCount,
      captionTracks: normalizeCaptionSnapshot(postCaptions, "Final").tracks.map(
        (track) => ({
          index: Number(track?.index),
          id: String(track?.id || ""),
          name: String(track?.name || ""),
          muted: Boolean(track?.muted),
          itemCount: Number(track?.itemCount),
        }),
      ),
      sequenceDurationSeconds: Number(postStructure?.durationSeconds),
      structureFingerprint: sequenceVerification.afterFingerprint || null,
    };
    report.verification = {
      caption: captionVerification,
      sequence: sequenceVerification,
      captionStyle: {
        copiedByApi: false,
        verified: false,
        reason: "Adobe stable UXP does not expose caption font/size/track-style copy; inspect the styled track separately.",
      },
      projectSaved: false,
    };
    if (!captionVerification.ok || !sequenceVerification.ok) {
      fail(
        "POST_WRITE_INVARIANT_FAILED",
        "Caption or video/audio timeline post-write verification failed.",
        report.verification,
        { phase: "verification" },
      );
    }

    report.ok = true;
    report.status = "applied-and-verified";
    report.phase = "complete";
    report.exitCode = 0;
    report.partialState = null;
    return report;
  } catch (error) {
    return finalizeFailure(report, error);
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }

  const lockDirectory =
    options.cepTempDir || process.env.PREMIERE_TEMP_DIR || DEFAULT_TEMP_DIR;
  let lock = null;
  let removeSignalHandlers = () => {};
  try {
    lock = await acquirePremiereCepLock({
      bridgeDirectory: lockDirectory,
      tool: "apply-premiere-caption-track",
      metadata: {
        client: "apply-premiere-caption-track",
        transport: "uxp-cep-router",
        mode: options.allowWrite ? "bounded-write" : "read-only-dry-run",
      },
    });
    removeSignalHandlers = installPremiereCepSignalHandlers(() => lock.release());
    const report = await runCaptionTrackApplication(options);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.exitCode;
  } catch (error) {
    const report = initialReport(options || {});
    finalizeFailure(report, error);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.exitCode || 1;
  } finally {
    try {
      if (lock) await lock.release();
    } finally {
      removeSignalHandlers();
    }
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) await main();
