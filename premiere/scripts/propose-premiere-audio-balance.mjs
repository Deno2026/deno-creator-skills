import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  audioSourceGroupKey,
  assertUniformFinalLevel,
  groupAudioClips,
} from "./lib/audio-source-groups.mjs";

const DEFAULT_INPUT = "tmp/premiere-audio-balance/project-audio-map.json";
const DEFAULT_OUT = "tmp/premiere-audio-balance/audio-balance-proposal.json";
const DEFAULT_REPORT = "tmp/premiere-audio-balance/audio-balance-proposal.md";
const AUDIO_BALANCE_PROPOSAL_SCHEMA_VERSION = 2;

function parseArgs(argv) {
  const options = {
    input: DEFAULT_INPUT,
    out: DEFAULT_OUT,
    report: DEFAULT_REPORT,
    targetLufs: -23,
    truePeakLimitDb: -2,
    maxBoostDb: 12,
    maxCutDb: 10,
    maxLevelDb: 12,
    minGainDb: 0.5,
    minDurationSeconds: 0.45,
    trackIndex: 0,
    includePattern: "",
    excludePattern: "",
    limit: 0,
    groupBy: "source",
    allowPartial: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--input") options.input = argv[++index];
    else if (value === "--out") options.out = argv[++index];
    else if (value === "--report") options.report = argv[++index];
    else if (value === "--target-lufs") options.targetLufs = Number(argv[++index]);
    else if (value === "--true-peak-limit-db") options.truePeakLimitDb = Number(argv[++index]);
    else if (value === "--max-boost-db") options.maxBoostDb = Number(argv[++index]);
    else if (value === "--max-cut-db") options.maxCutDb = Number(argv[++index]);
    else if (value === "--max-level-db") options.maxLevelDb = Number(argv[++index]);
    else if (value === "--min-gain-db") options.minGainDb = Number(argv[++index]);
    else if (value === "--min-duration-seconds") options.minDurationSeconds = Number(argv[++index]);
    else if (value === "--track-index") options.trackIndex = Number(argv[++index]);
    else if (value === "--include-pattern") options.includePattern = argv[++index];
    else if (value === "--exclude-pattern") options.excludePattern = argv[++index];
    else if (value === "--limit") options.limit = Number(argv[++index]);
    else if (value === "--group-by") options.groupBy = String(argv[++index] || "").toLowerCase();
    else if (value === "--allow-partial") options.allowPartial = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }

  if (!["source", "clip"].includes(options.groupBy)) {
    throw new Error("--group-by must be source or clip.");
  }
  for (const [label, value] of [
    ["--target-lufs", options.targetLufs],
    ["--true-peak-limit-db", options.truePeakLimitDb],
    ["--max-boost-db", options.maxBoostDb],
    ["--max-cut-db", options.maxCutDb],
    ["--max-level-db", options.maxLevelDb],
    ["--min-gain-db", options.minGainDb],
    ["--min-duration-seconds", options.minDurationSeconds],
  ]) {
    if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  }
  if (options.targetLufs < -70 || options.targetLufs > -5) {
    throw new Error("--target-lufs must be between -70 and -5 for ffmpeg loudnorm.");
  }
  if (options.truePeakLimitDb < -9 || options.truePeakLimitDb > 0) {
    throw new Error("--true-peak-limit-db must be between -9 and 0.");
  }
  if (options.maxBoostDb < 0 || options.maxCutDb < 0 || options.minGainDb < 0) {
    throw new Error("Gain limits must be zero or greater.");
  }
  if (options.maxLevelDb > 15) throw new Error("--max-level-db cannot exceed Premiere's +15 dB ceiling.");
  if (options.maxLevelDb < -options.maxCutDb) {
    throw new Error("--max-level-db cannot require more attenuation than --max-cut-db allows.");
  }
  if (options.minDurationSeconds <= 0) throw new Error("--min-duration-seconds must be positive.");
  if (!Number.isInteger(options.trackIndex) || options.trackIndex < 0) {
    throw new Error("--track-index must be a non-negative integer.");
  }
  if (!Number.isInteger(options.limit) || options.limit < 0) {
    throw new Error("--limit must be a non-negative integer.");
  }

  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/propose-premiere-audio-balance.mjs [options]",
    "",
    "Options:",
    "  --input <json>              project-audio-map JSON from Premiere",
    "  --out <json>                proposal output path",
    "  --report <md>               report output path",
    "  --target-lufs <n>           target integrated loudness, default -23",
    "  --true-peak-limit-db <n>    cap boosted clips below this true peak, default -2",
    "  --max-boost-db <n>          maximum boost, default 12",
    "  --max-cut-db <n>            maximum cut, default 10",
    "  --max-level-db <n>          absolute ceiling for the final clip level, default 12 (Premiere maxes at 15)",
    "  --min-gain-db <n>           skip smaller corrections, default 0.5",
    "  --min-duration-seconds <n>  minimum combined used duration per source group, default 0.45",
    "  --track-index <n>           audio track index, default 0",
    "  --include-pattern <regex>   analyze only matching clip names",
    "  --exclude-pattern <regex>   skip matching clip names",
    "  --limit <n>                 analyze first n clips for testing",
    "  --group-by <source|clip>    measure/apply one level per sound source (default source)",
    "  --allow-partial             write an incomplete proposal when some source analyses fail",
  ].join("\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function rawToDisplayDb(raw) {
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error("Premiere Volume > Level raw value must be finite and greater than zero.");
  }
  return 20 * Math.log10(raw) + 15;
}

function displayDbToRaw(db) {
  return 10 ** ((db - 15) / 20);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseLoudnorm(stderr) {
  const match = stderr.match(/\{\s*"input_i"[\s\S]*?\}/m);
  if (!match) {
    return null;
  }
  const parsed = JSON.parse(match[0]);
  const numberFields = [
    "input_i",
    "input_tp",
    "input_lra",
    "input_thresh",
    "output_i",
    "output_tp",
    "target_offset",
  ];
  for (const field of numberFields) {
    if (parsed[field] !== undefined) {
      parsed[field] = Number(parsed[field]);
    }
  }
  return parsed;
}

function analyzeGroup(group, options) {
  const inputByPath = new Map();
  const args = [
    "-hide_banner",
    "-nostats",
  ];
  for (const clip of group.clips) {
    const resolvedPath = path.resolve(clip.mediaPath);
    if (!inputByPath.has(resolvedPath)) {
      inputByPath.set(resolvedPath, inputByPath.size);
      args.push("-i", resolvedPath);
    }
  }
  const segmentFilters = group.clips.map((clip, index) => {
    const inputIndex = inputByPath.get(path.resolve(clip.mediaPath));
    const start = Math.max(0, Number(clip.inPointSeconds ?? 0));
    const end = Math.max(start, Number(clip.outPointSeconds ?? 0));
    return `[${inputIndex}:a:0]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[seg${index}]`;
  });
  const joinedLabel = group.clips.length === 1 ? "seg0" : "joined";
  if (group.clips.length > 1) {
    segmentFilters.push(
      `${group.clips.map((_, index) => `[seg${index}]`).join("")}concat=n=${group.clips.length}:v=0:a=1[joined]`,
    );
  }
  segmentFilters.push(
    `[${joinedLabel}]loudnorm=I=${options.targetLufs}:TP=${options.truePeakLimitDb}:LRA=11:print_format=json[measured]`,
  );
  args.push(
    "-vn",
    "-filter_complex",
    segmentFilters.join(";"),
    "-map",
    "[measured]",
    "-f",
    "null",
    process.platform === "win32" ? "NUL" : "/dev/null",
  );
  const result = spawnSync("ffmpeg", args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stderr = result.stderr || "";
  const metrics = parseLoudnorm(stderr);
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      error:
        result.error?.message ||
        stderr.split(/\r?\n/).filter(Boolean).slice(-5).join(" | ") ||
        `ffmpeg exited ${result.status}`,
    };
  }
  if (
    !metrics ||
    !Number.isFinite(metrics.input_i) ||
    !Number.isFinite(metrics.input_tp)
  ) {
    return { ok: false, error: "No finite loudness/true-peak measurement" };
  }
  return { ok: true, metrics };
}

function makeAdjustment(clip, group, analysis, options) {
  const currentRaw = Number(clip.volumeLevelRaw);
  const currentDisplayDb = rawToDisplayDb(currentRaw);
  const measuredLufs = analysis.metrics.input_i;
  const measuredTp = analysis.metrics.input_tp;
  const targetGainDb = options.targetLufs - measuredLufs;
  const peakCapGain = options.truePeakLimitDb - measuredTp;
  if (peakCapGain < -options.maxCutDb - 1e-6) {
    throw new Error(
      `True-peak safety requires ${round(peakCapGain, 3)} dB, beyond the -${options.maxCutDb} dB cut limit; source processing is required.`,
    );
  }
  let finalDisplayDb = clamp(targetGainDb, -options.maxCutDb, options.maxBoostDb);
  finalDisplayDb = Math.min(finalDisplayDb, peakCapGain, options.maxLevelDb);
  const predictedTruePeakDb = measuredTp + finalDisplayDb;
  if (predictedTruePeakDb > options.truePeakLimitDb + 1e-6) {
    throw new Error(
      `Predicted true peak ${round(predictedTruePeakDb, 3)} dBTP exceeds ${options.truePeakLimitDb} dBTP.`,
    );
  }
  const gainDb = finalDisplayDb - currentDisplayDb;
  const newRaw = displayDbToRaw(finalDisplayDb);
  return {
    trackIndex: clip.trackIndex,
    clipIndex: clip.clipIndex,
    nodeId: clip.nodeId,
    name: clip.name,
    startSeconds: clip.startSeconds,
    endSeconds: clip.endSeconds,
    durationSeconds: round((clip.endSeconds ?? 0) - (clip.startSeconds ?? 0)),
    inPointSeconds: clip.inPointSeconds,
    outPointSeconds: clip.outPointSeconds,
    mediaPath: clip.mediaPath,
    sourceGroupKey: group.key,
    sourceGroupClipCount: group.clips.length,
    currentRaw: round(currentRaw, 9),
    currentDisplayDb: round(currentDisplayDb, 3),
    measuredLufs: round(measuredLufs, 3),
    measuredTruePeakDb: round(measuredTp, 3),
    peakCapGainDb: round(peakCapGain, 3),
    predictedTruePeakDb: round(predictedTruePeakDb, 3),
    gainDb: round(gainDb, 3),
    finalDisplayDb: round(finalDisplayDb, 3),
    newRaw: round(newRaw, 12),
    shouldApply: Math.abs(gainDb) >= options.minGainDb,
  };
}

function formatSeconds(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${minutes}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function buildReport(proposal) {
  const applied = proposal.adjustments.filter((item) => item.shouldApply);
  const boosts = applied
    .filter((item) => item.gainDb > 0)
    .sort((a, b) => b.gainDb - a.gainDb)
    .slice(0, 12);
  const cuts = applied
    .filter((item) => item.gainDb < 0)
    .sort((a, b) => a.gainDb - b.gainDb)
    .slice(0, 12);
  const skipped = proposal.skipped.slice(0, 20);
  const lines = [
    "# Premiere Audio Balance Proposal",
    "",
    `Generated: ${proposal.generatedAt}`,
    `Project: ${proposal.projectName || "unknown"}`,
    `Project path: ${proposal.projectPath || "missing"}`,
    `Sequence: ${proposal.sequenceName || "active sequence"}`,
    `Sequence ID: ${proposal.sequenceId || "missing"}`,
    "",
    "## Summary",
    "",
    `- Analyzed clips: ${proposal.summary.analyzedCount}`,
    `- Source groups: ${proposal.summary.sourceGroupCount}`,
    `- Complete: ${proposal.complete}`,
    `- Write eligible: ${proposal.writeEligible}`,
    `- Proposed changes: ${proposal.summary.applyCount}`,
    `- Skipped clips: ${proposal.summary.skippedCount}`,
    `- Target: ${proposal.options.targetLufs} LUFS, true peak <= ${proposal.options.truePeakLimitDb} dB`,
    `- Gain clamp: +${proposal.options.maxBoostDb} dB / -${proposal.options.maxCutDb} dB`,
    `- Measured LUFS median: ${proposal.summary.medianLufs}`,
    `- Measured LUFS p10-p90: ${proposal.summary.p10Lufs} to ${proposal.summary.p90Lufs}`,
    "",
    "## Biggest Boosts",
    "",
    "| time | clip | LUFS | peak | gain | final level |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  ];
  for (const item of boosts) {
    lines.push(
      `| ${formatSeconds(item.startSeconds)} | ${item.name} | ${item.measuredLufs} | ${item.measuredTruePeakDb} | +${item.gainDb} dB | ${item.finalDisplayDb} dB |`,
    );
  }
  lines.push("", "## Biggest Cuts", "", "| time | clip | LUFS | peak | gain | final level |", "| --- | --- | ---: | ---: | ---: | ---: |");
  for (const item of cuts) {
    lines.push(
      `| ${formatSeconds(item.startSeconds)} | ${item.name} | ${item.measuredLufs} | ${item.measuredTruePeakDb} | ${item.gainDb} dB | ${item.finalDisplayDb} dB |`,
    );
  }
  if (skipped.length > 0) {
    lines.push("", "## Skipped Examples", "", "| clip | reason |", "| --- | --- |");
    for (const item of skipped) {
      lines.push(`| ${item.name || "(unknown)"} | ${item.reason} |`);
    }
  }
  if (proposal.failures.length > 0) {
    lines.push("", "## Analysis Failures", "", "| clip | reason |", "| --- | --- |");
    for (const item of proposal.failures.slice(0, 20)) {
      lines.push(`| ${item.name || "(unknown)"} | ${item.reason} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const data = readJson(options.input);
  for (const field of ["projectName", "projectPath", "sequenceName", "sequenceId"]) {
    if (typeof data[field] !== "string" || data[field].trim().length === 0) {
      throw new Error(
        `Audio map ${field} is required. Identity-incomplete audio maps fail closed; export a fresh map from the intended project copy and sequence.`,
      );
    }
  }
  if (!Array.isArray(data.audioTimeline)) {
    throw new Error("Audio map audioTimeline must be an array.");
  }
  const inputNodeIds = new Set();
  for (let index = 0; index < data.audioTimeline.length; index += 1) {
    const nodeId = String(data.audioTimeline[index]?.nodeId ?? "");
    if (!nodeId) throw new Error(`audioTimeline[${index}].nodeId is required.`);
    if (inputNodeIds.has(nodeId)) {
      throw new Error(`Audio map contains duplicate clip nodeId: ${nodeId}.`);
    }
    inputNodeIds.add(nodeId);
  }
  const includeRegex = options.includePattern ? new RegExp(options.includePattern, "i") : null;
  const excludeRegex = options.excludePattern ? new RegExp(options.excludePattern, "i") : null;
  let clips = (data.audioTimeline || []).filter((clip) => Number(clip.trackIndex) === options.trackIndex);
  if (includeRegex) clips = clips.filter((clip) => includeRegex.test(clip.name || ""));
  if (excludeRegex) clips = clips.filter((clip) => !excludeRegex.test(clip.name || ""));
  const matchedClipCountBeforeLimit = clips.length;
  if (options.limit > 0) clips = clips.slice(0, options.limit);
  if (clips.length === 0) {
    throw new Error("No audio clips matched the requested track and filters.");
  }

  const adjustments = [];
  const skipped = [];
  const failures = [];
  const analyzedGroups = [];
  const eligibleClips = [];
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    const duration = Number(clip.outPointSeconds ?? 0) - Number(clip.inPointSeconds ?? 0);
    if (!clip.mediaPath || !fs.existsSync(clip.mediaPath)) {
      failures.push({ ...clip, reason: "media path missing" });
      continue;
    }
    const currentRaw = Number(clip.volumeLevelRaw);
    if (!Number.isFinite(currentRaw) || currentRaw <= 0) {
      failures.push({ ...clip, reason: "invalid Premiere Volume > Level raw value" });
      continue;
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      failures.push({ ...clip, reason: `invalid source duration (${round(duration)}s)` });
      continue;
    }
    eligibleClips.push(clip);
  }
  if (eligibleClips.length === 0) {
    throw new Error(
      `No eligible audio clips remain (${failures.length} failure(s), ${skipped.length} policy skip(s)).`,
    );
  }
  const sourceGroups = groupAudioClips(eligibleClips, { groupBy: options.groupBy });
  const audioMapGroupCounts = new Map();
  for (const clip of data.audioTimeline) {
    try {
      const key = audioSourceGroupKey(clip, { groupBy: options.groupBy });
      audioMapGroupCounts.set(key, (audioMapGroupCounts.get(key) || 0) + 1);
    } catch {
      // An ungroupable clip cannot match a successfully analyzed group. Its own
      // eligibility failure is handled separately if it enters the selected scope.
    }
  }
  for (let index = 0; index < sourceGroups.length; index += 1) {
    const group = sourceGroups[index];
    const groupDurationSeconds = group.clips.reduce(
      (sum, clip) =>
        sum + Number(clip.outPointSeconds ?? 0) - Number(clip.inPointSeconds ?? 0),
      0,
    );
    if (groupDurationSeconds < options.minDurationSeconds) {
      for (const clip of group.clips) {
        skipped.push({
          ...clip,
          sourceGroupKey: group.key,
          reason: `source group too short (${round(groupDurationSeconds)}s total)`,
        });
      }
      continue;
    }
    process.stderr.write(
      `Analyzing source group ${index + 1}/${sourceGroups.length}: ${group.clips.length} clip(s)\n`,
    );
    const analysis = analyzeGroup(group, options);
    if (!analysis.ok) {
      for (const clip of group.clips) {
        failures.push({ ...clip, sourceGroupKey: group.key, reason: analysis.error || "analysis failed" });
      }
      continue;
    }
    let groupAdjustments;
    try {
      groupAdjustments = group.clips.map((clip) =>
        makeAdjustment(clip, group, analysis, options),
      );
    } catch (error) {
      for (const clip of group.clips) {
        failures.push({
          ...clip,
          sourceGroupKey: group.key,
          reason: error.message || String(error),
        });
      }
      continue;
    }
    const applyWholeGroup = groupAdjustments.some((item) => item.shouldApply);
    if (applyWholeGroup) {
      for (const item of groupAdjustments) item.shouldApply = true;
    }
    adjustments.push(...groupAdjustments);
    analyzedGroups.push({
      sourceGroupKey: group.key,
      clipCount: group.clips.length,
      audioMapClipCount: audioMapGroupCounts.get(group.key) || group.clips.length,
      scopeComplete: (audioMapGroupCounts.get(group.key) || group.clips.length) === group.clips.length,
      mediaPaths: group.mediaPaths,
      measuredDurationSeconds: round(groupDurationSeconds, 3),
      measuredLufs: round(analysis.metrics.input_i, 3),
      measuredTruePeakDb: round(analysis.metrics.input_tp, 3),
      finalDisplayDb: groupAdjustments[0]?.finalDisplayDb ?? null,
      shouldApply: applyWholeGroup,
    });
  }

  adjustments.sort(
    (left, right) =>
      Number(left.startSeconds || 0) - Number(right.startSeconds || 0) ||
      Number(left.trackIndex || 0) - Number(right.trackIndex || 0) ||
      Number(left.clipIndex || 0) - Number(right.clipIndex || 0),
  );
  assertUniformFinalLevel(adjustments);
  if (failures.length > 0 && !options.allowPartial) {
    const sample = failures
      .slice(0, 3)
      .map((item) => `${item.name || "(unknown)"}: ${item.reason}`)
      .join(" | ");
    throw new Error(
      `Audio proposal is incomplete: ${failures.length} analysis failure(s). ${sample}`,
    );
  }
  if (adjustments.length === 0) {
    throw new Error("No source group produced a usable audio adjustment.");
  }

  const lufs = analyzedGroups.map((item) => item.measuredLufs).filter(Number.isFinite);
  const writeIneligibleReasons = [];
  if (options.limit > 0) {
    writeIneligibleReasons.push("--limit creates a fixture/inspection scope, not a complete write scope");
  }
  if (options.groupBy === "source" && (options.includePattern || options.excludePattern)) {
    writeIneligibleReasons.push(
      "source grouping with include/exclude filters cannot prove the full source group is selected",
    );
  }
  if (failures.length > 0) {
    writeIneligibleReasons.push("one or more source analyses failed");
  }
  for (const group of analyzedGroups) {
    if (!group.scopeComplete) {
      writeIneligibleReasons.push(
        `source group ${group.sourceGroupKey} has ${group.audioMapClipCount} clip(s) in the audio map but this proposal covers ${group.clipCount}`,
      );
    }
  }
  const sourceGroupsCompleteAcrossAudioMap = analyzedGroups.every((group) => group.scopeComplete);
  const proposal = {
    schemaVersion: AUDIO_BALANCE_PROPOSAL_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    complete: failures.length === 0,
    writeEligible: writeIneligibleReasons.length === 0,
    writeIneligibleReasons,
    projectName: data.projectName,
    projectPath: data.projectPath,
    sequenceName: data.sequenceName,
    sequenceId: data.sequenceId,
    scope: {
      inputAudioClipCount: data.audioTimeline.length,
      matchedClipCountBeforeLimit,
      analyzedTrackIndex: options.trackIndex,
      limited: options.limit > 0,
      sourceGroupsCompleteAcrossAudioMap,
    },
    options,
    summary: {
      analyzedCount: adjustments.length,
      sourceGroupCount: new Set(adjustments.map((item) => item.sourceGroupKey)).size,
      applyCount: adjustments.filter((item) => item.shouldApply).length,
      skippedCount: skipped.length,
      failedCount: failures.length,
      medianLufs: round(median(lufs)),
      p10Lufs: round(percentile(lufs, 0.1)),
      p90Lufs: round(percentile(lufs, 0.9)),
      maxBoostDb: round(Math.max(0, ...adjustments.map((item) => item.gainDb))),
      maxCutDb: round(Math.min(0, ...adjustments.map((item) => item.gainDb))),
    },
    adjustments,
    sourceGroups: analyzedGroups,
    skipped,
    failures,
  };

  ensureParent(options.out);
  ensureParent(options.report);
  fs.writeFileSync(options.out, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  fs.writeFileSync(options.report, buildReport(proposal), "utf8");
  console.log(
    JSON.stringify(
      {
        out: options.out,
        report: options.report,
        schemaVersion: proposal.schemaVersion,
        complete: proposal.complete,
        writeEligible: proposal.writeEligible,
        summary: proposal.summary,
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
