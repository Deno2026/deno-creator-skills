import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CAPTION_OPTIONS,
  buildCaptionCues,
  formatSrt,
  mapPremiereTranscriptToTimeline,
  normalizeTimedWords,
} from "./lib/premiere-caption-cues.mjs";
import { validateSrt } from "./validate-srt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UXP_CALL = path.join(ROOT, "servers", "premiere-uxp-mcp", "call-tool.mjs");
const AUDIO_MAP_SCRIPT = path.join(ROOT, "scripts", "export-premiere-audio-map.mjs");
const AUDIO_BUILD_SCRIPT = path.join(ROOT, "scripts", "build-premiere-transcription-audio.mjs");
const WHISPER_SCRIPT = path.join(ROOT, "scripts", "transcribe-premiere-audio.py");
const DEFAULT_WHISPER_MODEL = "Systran/faster-whisper-large-v3";

function timestampSlug(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function parseArgs(argv) {
  const options = {
    mode: "whisper",
    outDir: "",
    tracks: [],
    targetItemName: "",
    fps: null,
    language: "ko",
    model: DEFAULT_WHISPER_MODEL,
    python: "",
    prompt: "",
    glossary: "",
    keepAudio: false,
    allowDownload: false,
    timingToleranceMs: null,
    vadFilter: false, // 2026-09-15: VAD dropped 23 s of real speech (9:28–9:51); quality-first default is off
    expectedProject: "",
    expectedSequence: "",
    audioMap: "",
    transcriptJson: "",
    stateJson: "",
    summaryJson: "",
    help: false,
  };
  const valueOptions = new Map([
    ["--mode", "mode"],
    ["--out-dir", "outDir"],
    ["--fps", "fps"],
    ["--language", "language"],
    ["--model", "model"],
    ["--python", "python"],
    ["--prompt", "prompt"],
    ["--glossary", "glossary"],
    ["--expected-project", "expectedProject"],
    ["--expected-sequence", "expectedSequence"],
    ["--audio-map", "audioMap"],
    ["--transcript-json", "transcriptJson"],
    ["--state-json", "stateJson"],
    ["--summary-json", "summaryJson"],
    ["--timing-tolerance-ms", "timingToleranceMs"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") options.help = true;
    else if (value === "--keep-audio") options.keepAudio = true;
    else if (value === "--allow-download") options.allowDownload = true;
    else if (value === "--vad-filter") options.vadFilter = true;
    else if (value === "--no-vad-filter") options.vadFilter = false;
    else if (value === "--track") {
      if (index + 1 >= argv.length) throw new Error("--track requires a value.");
      options.tracks.push(Number(argv[++index]));
    } else if (value === "--target-item-name") {
      if (index + 1 >= argv.length) throw new Error("--target-item-name requires a value.");
      options.targetItemName = argv[++index];
    } else if (valueOptions.has(value)) {
      if (index + 1 >= argv.length) throw new Error(`${value} requires a value.`);
      options[valueOptions.get(value)] = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!new Set(["auto", "premiere", "whisper"]).has(options.mode)) {
    throw new Error(`Unsupported --mode: ${options.mode}`);
  }
  if (options.tracks.length === 0) options.tracks.push(0);
  if (options.tracks.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error("--track values must be non-negative integers.");
  }
  if (options.fps !== null) {
    options.fps = Number(options.fps);
    if (!(options.fps > 0)) throw new Error("--fps must be greater than zero.");
  }
  if (options.timingToleranceMs !== null) {
    options.timingToleranceMs = Number(options.timingToleranceMs);
    if (!Number.isFinite(options.timingToleranceMs) || options.timingToleranceMs < 0 || options.timingToleranceMs > 100) {
      throw new Error("--timing-tolerance-ms must be between 0 and 100.");
    }
  }
  assertLargeV3ModelReference(options.model);
  return options;
}

function assertLargeV3ModelReference(value) {
  const reference = String(value || "").trim();
  const normalized = reference.replaceAll("\\", "/").toLowerCase();
  const isLocalPath = fs.existsSync(path.resolve(reference));
  const identifiesLargeV3 = normalized.includes("large-v3");
  const isDowngradedVariant = normalized.includes("turbo") || normalized.includes("distil");
  if (isDowngradedVariant || (!isLocalPath && normalized !== DEFAULT_WHISPER_MODEL.toLowerCase()) || !identifiesLargeV3) {
    throw new Error(
      `--model must be the fixed Whisper large-v3 model (${DEFAULT_WHISPER_MODEL}) or an existing large-v3 snapshot path. `
      + "Smaller, turbo, distilled, and ambiguous model references are not accepted.",
    );
  }
  return reference;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/transcribe-premiere-timeline.mjs [options]",
    "",
    "Source:",
    "  --mode <auto|premiere|whisper>  Source mode (default: whisper; auto/premiere are explicit recovery paths)",
    "  --track <index>                 Dialogue audio track; repeat for multiple tracks (default: 0)",
    "  --target-item-name <name>        Limit Premiere transcript + reconstructed audio to this timeline clip name",
    "  --language <code>               Whisper language (default: ko)",
    "  --model <id-or-path>            Fixed Whisper large-v3 model or existing large-v3 snapshot path",
    "  --python <path>                  Python executable; defaults to repo .venv then PATH python",
    "  --prompt <text>                  Initial Whisper prompt",
    "  --allow-download                 Permit the fixed large-v3 model to download",
    "  --vad-filter / --no-vad-filter   Enable or disable faster-whisper VAD (default: disabled — VAD has dropped real speech)",
    "",
    "Output and safety:",
    "  --out-dir <path>                 Output directory under tmp by default",
    "  --glossary <json>                Exact text replacement object or { replacements: {...} }",
    "  --fps <number>                   Override the active sequence frame rate",
    "  --expected-project <name>        Fail if the active project differs",
    "  --expected-sequence <name>       Fail if the active sequence differs",
    "  --keep-audio                     Keep the temporary 16 kHz timeline WAV",
    "  --timing-tolerance-ms <n>         Explicit source/timeline duration tolerance forwarded to the audio builder (0-100; builder default when omitted)",
    "",
    "Offline fixture inputs:",
    "  --audio-map <json> --transcript-json <json> --state-json <json> --summary-json <json>",
    "",
    "This command is read-only in Premiere. It creates a draft SRT and QC report, but never applies",
    "captions or saves the project. Native caption application is a separate approval-gated command.",
  ].join("\n");
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJson(filePath, value) {
  ensureParent(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch (error) {
    throw new Error(`Failed to read ${label}: ${error.message}`);
  }
}

function commandFailure(command, args, result) {
  const detail = [result.stderr, result.stdout].map((value) => String(value || "").trim()).filter(Boolean).join("\n");
  return new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? "unknown"}.${detail ? `\n${detail}` : ""}`);
}

function run(command, args, { cwd = ROOT, env = process.env, timeoutMs = 300000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw commandFailure(command, args, result);
  return result;
}

function parseJsonOutput(stdout, label) {
  const source = String(stdout || "").trim();
  try {
    return JSON.parse(source);
  } catch (_error) {
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] !== "{" && source[index] !== "[") continue;
      try {
        return JSON.parse(source.slice(index));
      } catch (_nestedError) {
        // Keep searching in case a diagnostic line contains a bracket first.
      }
    }
  }
  throw new Error(`${label} did not return JSON.\n${source.slice(-2000)}`);
}

function callUxp(name, args = {}) {
  const commandArgs = [UXP_CALL, name];
  if (Object.keys(args).length > 0) commandArgs.push(JSON.stringify(args));
  const result = run(process.execPath, commandArgs, { timeoutMs: 180000 });
  return parseJsonOutput(result.stdout, `UXP ${name}`);
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function pythonExecutable(explicit) {
  if (explicit) return path.resolve(explicit);
  const venvPython = path.join(ROOT, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(venvPython)) return venvPython;
  return "python";
}

function wordsFromWhisper(payload) {
  if (Array.isArray(payload?.words) && payload.words.length > 0) return normalizeTimedWords(payload.words);
  const words = [];
  for (const segment of payload?.segments ?? payload?.chunks ?? []) {
    if (Array.isArray(segment.words) && segment.words.length > 0) words.push(...segment.words);
    else if (segment.text && Number.isFinite(Number(segment.start)) && Number.isFinite(Number(segment.end))) {
      words.push({ text: segment.text, startSeconds: Number(segment.start), endSeconds: Number(segment.end) });
    } else if (segment.text && Array.isArray(segment.timestamp)) {
      words.push({ text: segment.text, startSeconds: Number(segment.timestamp[0]), endSeconds: Number(segment.timestamp[1]) });
    }
  }
  return normalizeTimedWords(words);
}

function filterAudioMapByTargetItem(audioMap, tracks, targetItemName) {
  if (!audioMap || typeof audioMap !== "object" || Array.isArray(audioMap)) {
    throw new TypeError("Audio map must be an object.");
  }
  const timeline = Array.isArray(audioMap.audioTimeline) ? [...audioMap.audioTimeline] : [];
  if (!targetItemName) return { ...audioMap, audioTimeline: timeline, audioClipCount: timeline.length };
  const target = String(targetItemName);
  const selectedTracks = new Set(tracks.map((value) => Number(value)));
  const filteredTimeline = timeline.filter((clip) => {
    const trackIndex = Number(clip?.trackIndex);
    return selectedTracks.has(trackIndex) && String(clip?.name) === target;
  });
  if (filteredTimeline.length === 0) {
    throw new Error(`No audio clip matched target item name: ${target}`);
  }
  return {
    ...audioMap,
    audioTimeline: filteredTimeline,
    audioClipCount: filteredTimeline.length,
  };
}

function frameRateFromSummary(summary) {
  const seconds = Number(summary?.frameRate?.seconds);
  if (!(seconds > 0)) throw new Error("The active sequence frame rate is unavailable.");
  return 1 / seconds;
}

function transcriptItems(payload) {
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload)) return payload;
  throw new Error("Premiere transcript response does not contain items.");
}

function glossaryReplacements(filePath) {
  if (!filePath) return {};
  const payload = readJson(filePath, "glossary");
  const replacements = payload?.replacements ?? payload;
  if (!replacements || Array.isArray(replacements) || typeof replacements !== "object") {
    throw new Error("Glossary must be an object or { replacements: object }.");
  }
  return replacements;
}

function loadOrQuery(filePath, label, query) {
  return filePath ? readJson(filePath, label) : query();
}

function assertIdentity(state, options) {
  const projectName = state?.project?.name ?? state?.projectName ?? "";
  const sequenceName = state?.activeSequence?.name ?? state?.activeSequence ?? "";
  if (!projectName || !sequenceName) throw new Error("Premiere has no active project and sequence.");
  if (options.expectedProject && projectName !== options.expectedProject) {
    throw new Error(`Active project mismatch: expected ${options.expectedProject}, received ${projectName}`);
  }
  if (options.expectedSequence && sequenceName !== options.expectedSequence) {
    throw new Error(`Active sequence mismatch: expected ${options.expectedSequence}, received ${sequenceName}`);
  }
  return { projectName, sequenceName };
}

function buildAudioMap(options, outPath) {
  if (options.audioMap) return readJson(options.audioMap, "audio map");
  run(process.execPath, [AUDIO_MAP_SCRIPT, "--out", outPath], { timeoutMs: 240000 });
  return readJson(outPath, "live audio map");
}

function buildTimelineAudio(audioMapPath, wavPath, tracks, timingToleranceMs = null) {
  if (!fs.existsSync(AUDIO_BUILD_SCRIPT)) {
    throw new Error(`Timeline audio builder is not installed: ${AUDIO_BUILD_SCRIPT}`);
  }
  const args = [AUDIO_BUILD_SCRIPT, "--map", audioMapPath, "--out", wavPath];
  for (const track of tracks) args.push("--track", String(track));
  if (timingToleranceMs !== null) args.push("--timing-tolerance-ms", String(timingToleranceMs));
  run(process.execPath, args, { timeoutMs: 30 * 60 * 1000 });
}

function runWhisper(options, wavPath, rawPath) {
  const modelFlag = fs.existsSync(path.resolve(options.model)) ? "--model-path" : "--model-id";
  const args = [
    WHISPER_SCRIPT,
    "--audio", wavPath,
    "--out", rawPath,
    modelFlag, options.model,
    "--language", options.language,
    "--device", "cuda",
    "--compute-type", "float16",
  ];
  if (options.prompt) args.push("--prompt", options.prompt);
  if (options.allowDownload) args.push("--allow-download");
  if (!options.vadFilter) args.push("--no-vad-filter");
  run(pythonExecutable(options.python), args, { timeoutMs: 2 * 60 * 60 * 1000 });
  return readJson(rawPath, "Whisper transcript");
}

export async function runTranscription(options) {
  const outDir = path.resolve(options.outDir || path.join(ROOT, "tmp", "premiere-transcription", timestampSlug()));
  fs.mkdirSync(outDir, { recursive: true });
  const statePath = path.join(outDir, "premiere-state.json");
  const summaryPath = path.join(outDir, "timeline-summary.json");
  const audioMapPath = path.join(outDir, "audio-map.json");
  const transcriptPath = path.join(outDir, "transcript-raw.json");
  const wordsPath = path.join(outDir, "transcript-timeline-words.json");
  const cueMapPath = path.join(outDir, "cue-map.json");
  const srtPath = path.join(outDir, "captions-draft.srt");
  const qcPath = path.join(outDir, "caption-qc.json");
  const manifestPath = path.join(outDir, "manifest.json");
  const wavPath = path.join(outDir, "timeline-dialogue-16k.wav");

  const state = loadOrQuery(options.stateJson, "Premiere state", () => callUxp("get_premiere_state"));
  const summary = loadOrQuery(options.summaryJson, "timeline summary", () => callUxp("get_timeline_summary"));
  const identity = assertIdentity(state, options);
  writeJson(statePath, state);
  writeJson(summaryPath, summary);

  const audioMap = filterAudioMapByTargetItem(
    buildAudioMap(options, audioMapPath),
    options.tracks,
    options.targetItemName,
  );
  writeJson(audioMapPath, audioMap);
  if (audioMap.projectName && audioMap.projectName !== identity.projectName) {
    throw new Error(`Audio map project drifted to ${audioMap.projectName}.`);
  }
  if (audioMap.sequenceName && audioMap.sequenceName !== identity.sequenceName) {
    throw new Error(`Audio map sequence drifted to ${audioMap.sequenceName}.`);
  }

  const fps = options.fps ?? frameRateFromSummary(summary);
  const sequenceDurationSeconds = Number(
    summary?.durationSeconds ?? state?.activeSequence?.durationSeconds ?? audioMap.sequenceDurationSeconds,
  );
  if (!(sequenceDurationSeconds > 0)) throw new Error("Active sequence duration is unavailable.");
  const replacements = glossaryReplacements(options.glossary);

  let sourceMode = options.mode;
  let rawTranscript;
  let words;
  if (sourceMode !== "whisper") {
    try {
      rawTranscript = options.transcriptJson
        ? readJson(options.transcriptJson, "Premiere transcript")
        : callUxp("get_clip_transcript", options.targetItemName ? { item_name: options.targetItemName } : {});
      words = mapPremiereTranscriptToTimeline(
        transcriptItems(rawTranscript),
        audioMap.audioTimeline,
        options.tracks,
        options.targetItemName ? { targetName: options.targetItemName } : {},
      );
      sourceMode = "premiere";
    } catch (error) {
      if (options.mode === "premiere") throw error;
      sourceMode = "whisper";
    }
  }

  if (sourceMode === "whisper") {
    if (options.transcriptJson) {
      rawTranscript = readJson(options.transcriptJson, "Whisper transcript");
    } else {
      buildTimelineAudio(audioMapPath, wavPath, options.tracks, options.timingToleranceMs);
      rawTranscript = runWhisper(options, wavPath, transcriptPath);
    }
    words = wordsFromWhisper(rawTranscript);
    if (!options.transcriptJson && !options.keepAudio) fs.rmSync(wavPath, { force: true });
  }

  writeJson(transcriptPath, rawTranscript);
  writeJson(wordsPath, { sourceMode, wordCount: words.length, words });
  const cues = buildCaptionCues(words, {
    fps,
    sequenceDurationSeconds,
    replacements,
    cutBoundariesSeconds: (audioMap.audioTimeline ?? [])
      .filter((clip) => options.tracks.includes(Number(clip.trackIndex)))
      .flatMap((clip) => [Number(clip.startSeconds), Number(clip.endSeconds)])
      .filter(Number.isFinite),
  });
  writeJson(cueMapPath, {
    schemaVersion: 1,
    sourceMode,
    wordCount: words.length,
    cueCount: cues.length,
    cues: cues.map((cue) => ({
      number: cue.index,
      text: cue.text,
      displayLines: cue.textLines,
      sourceWordPositionRange: {
        startInclusive: cue.wordStartIndex,
        endInclusive: cue.wordEndIndex,
      },
      sourceWordIndices: words
        .slice(cue.wordStartIndex, cue.wordEndIndex + 1)
        .map((word, position) => Number(word.index ?? cue.wordStartIndex + position)),
    })),
  });
  const srt = formatSrt(cues);
  fs.writeFileSync(srtPath, srt, "utf8");
  const qc = {
    ...validateSrt(srt, {
      fps,
      maxLineLength: DEFAULT_CAPTION_OPTIONS.maxLineLength,
      maxDurationSeconds: DEFAULT_CAPTION_OPTIONS.maxCueDurationSeconds +
        DEFAULT_CAPTION_OPTIONS.leadInSeconds + DEFAULT_CAPTION_OPTIONS.tailSeconds + 2 / fps,
    }),
    file: srtPath,
  };
  writeJson(qcPath, qc);

  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    projectName: identity.projectName,
    sequenceName: identity.sequenceName,
    sequenceDurationSeconds,
    fps,
    tracks: options.tracks,
    sourceMode,
    transcriptionPolicy: {
      backend: "faster-whisper",
      modelFamily: "large-v3",
      model: options.model,
      device: "cuda",
      computeType: "float16",
      automaticModelDowngrade: false,
      automaticRuntimeDowngrade: false,
      audioReconstructionTimingToleranceMs: options.timingToleranceMs,
      vadFilter: options.vadFilter,
    },
    wordCount: words.length,
    cueCount: cues.length,
    qcPassed: qc.ok,
    files: {
      state: statePath,
      summary: summaryPath,
      audioMap: audioMapPath,
      rawTranscript: transcriptPath,
      timelineWords: wordsPath,
      cueMap: cueMapPath,
      draftSrt: srtPath,
      captionQc: qcPath,
      timelineAudio: options.keepAudio && fs.existsSync(wavPath) ? wavPath : null,
    },
    hashes: {
      draftSrtSha256: sha256(srtPath),
      rawTranscriptSha256: sha256(transcriptPath),
      cueMapSha256: sha256(cueMapPath),
    },
    premiereWrites: 0,
    projectSaved: false,
  };
  writeJson(manifestPath, manifest);
  if (!qc.ok) {
    const codes = [...new Set(qc.issues.map((issue) => issue.code))].join(", ");
    const error = new Error(`Draft SRT failed strict QC: ${codes}`);
    error.exitCode = 2;
    error.manifest = manifest;
    throw error;
  }
  return { ...manifest, manifest: manifestPath };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const result = await runTranscription(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = error.exitCode || 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await main();

export {
  assertLargeV3ModelReference,
  filterAudioMapByTargetItem,
  parseArgs,
  usage,
  wordsFromWhisper,
};
