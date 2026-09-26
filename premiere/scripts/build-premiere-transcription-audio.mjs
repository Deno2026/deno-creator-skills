import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const SAMPLE_FORMAT = "pcm_s16le";
const DEFAULT_TIMING_TOLERANCE_SECONDS = 0.002;
const MAX_SELECTED_TRACKS = 64;
const MAX_CLIPS = 100_000;
const MAX_MIX_INPUTS = 8;

function fail(message) {
  throw new Error(message);
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`${label} must be a finite number.`);
  return number;
}

function secondsToSamples(seconds) {
  return Math.round(seconds * SAMPLE_RATE);
}

function samplesToSeconds(samples) {
  return samples / SAMPLE_RATE;
}

function formatSeconds(seconds) {
  return Number(seconds).toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}

function normalizeTrackIndexes(trackIndexes) {
  const source = trackIndexes?.length ? trackIndexes : [0];
  const tracks = [...new Set(source.map((value) => Number(value)))];
  if (!tracks.length || tracks.some((value) => !Number.isInteger(value) || value < 0)) {
    fail("--track values must be non-negative integers.");
  }
  if (tracks.length > MAX_SELECTED_TRACKS) {
    fail(`At most ${MAX_SELECTED_TRACKS} tracks can be selected.`);
  }
  return tracks.sort((left, right) => left - right);
}

function clipIsDisabled(clip) {
  return clip.enabled === false || clip.isEnabled === false || clip.disabled === true;
}

function assertNormalPlayback(clip, label) {
  if (clip.reverse === true || clip.isReversed === true || clip.reversed === true) {
    fail(`${label} uses reverse playback, which is unsupported.`);
  }

  const rateFields = ["speedPercent", "speed", "playbackRate", "rate"];
  for (const field of rateFields) {
    if (clip[field] === undefined || clip[field] === null || clip[field] === "") continue;
    const rate = finiteNumber(clip[field], `${label}.${field}`);
    const isNormal = field === "speedPercent"
      ? Math.abs(rate - 100) <= 1e-6
      : Math.abs(rate - 1) <= 1e-6 || Math.abs(rate - 100) <= 1e-6;
    if (!isNormal) fail(`${label} uses unsupported playback speed (${field}=${rate}).`);
  }
}

function resolveMediaPath(mediaPath, baseDirectory) {
  if (typeof mediaPath !== "string" || !mediaPath.trim()) return "";
  return path.isAbsolute(mediaPath)
    ? path.normalize(mediaPath)
    : path.resolve(baseDirectory, mediaPath);
}

/**
 * Validate and normalize the JSON emitted by export-premiere-audio-map.mjs.
 * This function is intentionally filesystem-aware: an offline/missing source is
 * a hard error even for a dry-run, so the plan can never advertise a build that
 * is already known to be impossible.
 */
export function buildTranscriptionAudioPlan(audioMap, {
  tracks = [0],
  outputPath = "premiere-transcription-audio.wav",
  baseDirectory = process.cwd(),
  timingToleranceSeconds = DEFAULT_TIMING_TOLERANCE_SECONDS,
} = {}) {
  if (!audioMap || typeof audioMap !== "object" || Array.isArray(audioMap)) {
    fail("Audio map must be a JSON object.");
  }
  if (!Array.isArray(audioMap.audioTimeline)) {
    fail("Audio map is missing audioTimeline[].");
  }
  if (audioMap.audioTimeline.length > MAX_CLIPS) {
    fail(`Audio map exceeds the ${MAX_CLIPS}-clip safety limit.`);
  }

  const selectedTracks = normalizeTrackIndexes(tracks);
  const audioTrackCount = finiteNumber(audioMap.audioTrackCount, "audioTrackCount");
  if (!Number.isInteger(audioTrackCount) || audioTrackCount < 0) {
    fail("audioTrackCount must be a non-negative integer.");
  }
  for (const trackIndex of selectedTracks) {
    if (trackIndex >= audioTrackCount) {
      fail(`Selected audio track ${trackIndex} does not exist (track count: ${audioTrackCount}).`);
    }
  }

  const sequenceDurationSeconds = finiteNumber(
    audioMap.sequenceDurationSeconds,
    "sequenceDurationSeconds",
  );
  if (!(sequenceDurationSeconds > 0)) fail("Sequence duration must be greater than zero.");
  const sequenceDurationSamples = secondsToSamples(sequenceDurationSeconds);
  if (!(sequenceDurationSamples > 0)) fail("Sequence duration is shorter than one audio sample.");

  const timingTolerance = finiteNumber(timingToleranceSeconds, "timingToleranceSeconds");
  if (timingTolerance < 0 || timingTolerance > 0.1) {
    fail("timingToleranceSeconds must be between 0 and 0.1.");
  }
  const timingToleranceSamples = Math.max(1, secondsToSamples(timingTolerance));
  const selectedSet = new Set(selectedTracks);
  const clipsByTrack = new Map(selectedTracks.map((trackIndex) => [trackIndex, []]));

  for (let mapIndex = 0; mapIndex < audioMap.audioTimeline.length; mapIndex += 1) {
    const clip = audioMap.audioTimeline[mapIndex];
    if (!clip || typeof clip !== "object" || Array.isArray(clip)) continue;
    const trackIndex = Number(clip.trackIndex);
    if (!selectedSet.has(trackIndex) || clipIsDisabled(clip)) continue;
    const label = `audioTimeline[${mapIndex}] (track ${trackIndex}, clip ${clip.clipIndex ?? "?"})`;
    assertNormalPlayback(clip, label);
    if (clip.offline === true || clip.isOffline === true || clip.exists === false) {
      fail(`${label} is offline or unavailable.`);
    }

    const startSeconds = finiteNumber(clip.startSeconds, `${label}.startSeconds`);
    const endSeconds = finiteNumber(clip.endSeconds, `${label}.endSeconds`);
    const inPointSeconds = finiteNumber(clip.inPointSeconds, `${label}.inPointSeconds`);
    const outPointSeconds = finiteNumber(clip.outPointSeconds, `${label}.outPointSeconds`);
    if (startSeconds < 0 || inPointSeconds < 0 || endSeconds <= startSeconds || outPointSeconds <= inPointSeconds) {
      fail(`${label} has invalid start/end or source in/out timing.`);
    }

    const startSample = secondsToSamples(startSeconds);
    const endSample = secondsToSamples(endSeconds);
    const sourceInSample = secondsToSamples(inPointSeconds);
    const sourceOutSample = secondsToSamples(outPointSeconds);
    if (startSample < 0 || endSample <= startSample || sourceOutSample <= sourceInSample) {
      fail(`${label} collapses to an invalid range at ${SAMPLE_RATE} Hz.`);
    }
    if (endSample > sequenceDurationSamples + timingToleranceSamples) {
      fail(`${label} extends past the sequence duration.`);
    }

    const timelineDurationSeconds = endSeconds - startSeconds;
    const sourceDurationSeconds = outPointSeconds - inPointSeconds;
    if (Math.abs(timelineDurationSeconds - sourceDurationSeconds) > timingTolerance) {
      fail(
        `${label} has a source/timeline duration mismatch ` +
        `(${formatSeconds(sourceDurationSeconds)}s vs ${formatSeconds(timelineDurationSeconds)}s); ` +
        "speed changes or time remapping are unsupported.",
      );
    }
    const timelineDurationSamples = endSample - startSample;
    const sourceDurationSamples = sourceOutSample - sourceInSample;
    if (Math.abs(timelineDurationSamples - sourceDurationSamples) > timingToleranceSamples) {
      fail(`${label} has an unsupported sample-accurate speed/timing mismatch.`);
    }

    const mediaPath = resolveMediaPath(clip.mediaPath, baseDirectory);
    if (!mediaPath || !fs.existsSync(mediaPath) || !fs.statSync(mediaPath).isFile()) {
      fail(`${label} media is missing: ${mediaPath || "(empty mediaPath)"}`);
    }

    clipsByTrack.get(trackIndex).push({
      mapIndex,
      trackIndex,
      clipIndex: clip.clipIndex ?? null,
      nodeId: String(clip.nodeId ?? ""),
      name: String(clip.name ?? ""),
      mediaPath,
      startSeconds,
      endSeconds,
      inPointSeconds,
      outPointSeconds,
      startSample,
      endSample: Math.min(endSample, sequenceDurationSamples),
      sourceInSample,
      sourceOutSample,
      durationSamples: endSample - startSample,
    });
  }

  const trackPlans = [];
  let selectedClipCount = 0;
  for (const trackIndex of selectedTracks) {
    const clips = clipsByTrack.get(trackIndex).sort((left, right) =>
      left.startSample - right.startSample || left.endSample - right.endSample || left.mapIndex - right.mapIndex
    );
    let cursorSample = 0;
    const pieces = [];
    for (const clip of clips) {
      if (clip.startSample < cursorSample) {
        const previous = clips.find((candidate) => candidate.endSample === cursorSample);
        fail(
          `Audio track ${trackIndex} contains overlapping clips near ` +
          `${formatSeconds(samplesToSeconds(clip.startSample))}s` +
          `${previous ? ` (${previous.name || previous.clipIndex} / ${clip.name || clip.clipIndex})` : ""}.`,
        );
      }
      if (clip.startSample > cursorSample) {
        pieces.push({ kind: "silence", startSample: cursorSample, endSample: clip.startSample });
      }
      pieces.push({
        kind: "clip",
        mapIndex: clip.mapIndex,
        startSample: clip.startSample,
        endSample: clip.endSample,
        mediaPath: clip.mediaPath,
        sourceInSample: clip.sourceInSample,
        sourceOutSample: clip.sourceOutSample,
      });
      cursorSample = clip.endSample;
    }
    if (cursorSample < sequenceDurationSamples) {
      pieces.push({ kind: "silence", startSample: cursorSample, endSample: sequenceDurationSamples });
    }
    selectedClipCount += clips.length;
    trackPlans.push({ trackIndex, clipCount: clips.length, clips, pieces });
  }

  const absoluteOutputPath = path.resolve(outputPath);
  return {
    schemaVersion: 1,
    purpose: "premiere-transcription-audio",
    projectName: String(audioMap.projectName ?? ""),
    projectPath: String(audioMap.projectPath ?? ""),
    sequenceName: String(audioMap.sequenceName ?? ""),
    sequenceId: String(audioMap.sequenceId ?? ""),
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    codec: SAMPLE_FORMAT,
    selectedTracks,
    selectedClipCount,
    sequenceDurationSeconds: samplesToSeconds(sequenceDurationSamples),
    sequenceDurationSamples,
    timingToleranceSeconds: timingTolerance,
    outputPath: absoluteOutputPath,
    trackPlans,
  };
}

async function runProcess(command, args, {
  cwd,
  timeoutMs = 30 * 60 * 1000,
  label = path.basename(command),
} = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => (current + chunk.toString("utf8")).slice(-65_536);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${label} failed to start: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(
        `${label} failed (${signal ? `signal ${signal}` : `exit ${code}`}): ` +
        `${stderr.trim() || stdout.trim() || "no diagnostic output"}`,
      ));
    });
  });
}

async function probeAudio(filePath, ffprobePath, timeoutMs) {
  const { stdout } = await runProcess(ffprobePath, [
    "-v", "error",
    "-show_entries", "stream=index,codec_type,codec_name,sample_rate,channels,duration,duration_ts,time_base:format=duration",
    "-of", "json",
    filePath,
  ], { timeoutMs, label: `ffprobe ${path.basename(filePath)}` });
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    fail(`ffprobe returned invalid JSON for ${filePath}.`);
  }
  const audioStreams = (payload.streams ?? []).filter((stream) => stream.codec_type === "audio");
  if (!audioStreams.length) fail(`Media has no audio stream: ${filePath}`);
  const stream = audioStreams[0];
  const streamDuration = Number(stream.duration);
  const formatDuration = Number(payload.format?.duration);
  // Prefer the audio-stream boundary.  A video container may be longer than
  // its audio stream; using the container duration would silently turn a
  // truncated requested range into padding.
  const durationSeconds = Number.isFinite(streamDuration) && streamDuration >= 0
    ? streamDuration
    : Number.isFinite(formatDuration) && formatDuration >= 0 ? formatDuration : null;
  return {
    codecName: String(stream.codec_name ?? ""),
    sampleRate: Number(stream.sample_rate),
    channels: Number(stream.channels),
    durationSeconds,
    durationTs: Number(stream.duration_ts),
    timeBase: String(stream.time_base ?? ""),
  };
}

function ffmpegCommonPrefix() {
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "2", "-filter_threads", "1", "-y"];
}

async function renderClipFragment({ clip, gapSamples, outPath, ffmpegPath, timeoutMs }) {
  const durationSeconds = samplesToSeconds(clip.durationSamples);
  const filterParts = [
    `[0:a:0]aresample=${SAMPLE_RATE}:async=0:first_pts=0,` +
    `aformat=sample_fmts=s16:channel_layouts=mono,apad,` +
    `atrim=end_sample=${clip.durationSamples},asetpts=N/SR/TB[clip]`,
  ];
  let outputLabel = "[clip]";
  if (gapSamples > 0) {
    filterParts.push(
      `anullsrc=r=${SAMPLE_RATE}:cl=mono,atrim=end_sample=${gapSamples},asetpts=N/SR/TB[gap]`,
      "[gap][clip]concat=n=2:v=0:a=1[out]",
    );
    outputLabel = "[out]";
  }
  await runProcess(ffmpegPath, [
    ...ffmpegCommonPrefix(),
    "-ss", formatSeconds(clip.inPointSeconds),
    "-t", formatSeconds(durationSeconds + 0.25),
    "-i", clip.mediaPath,
    "-filter_complex", filterParts.join(";"),
    "-map", outputLabel,
    "-ar", String(SAMPLE_RATE),
    "-ac", String(CHANNELS),
    "-c:a", SAMPLE_FORMAT,
    "-rf64", "auto",
    outPath,
  ], { timeoutMs, label: `render clip ${clip.trackIndex}:${clip.clipIndex ?? clip.mapIndex}` });
}

async function renderSilence({ samples, outPath, ffmpegPath, timeoutMs }) {
  if (!(samples > 0)) fail("Internal error: silence length must be positive.");
  await runProcess(ffmpegPath, [
    ...ffmpegCommonPrefix(),
    "-f", "lavfi",
    "-i", `anullsrc=r=${SAMPLE_RATE}:cl=mono`,
    "-af", `atrim=end_sample=${samples},asetpts=N/SR/TB`,
    "-ar", String(SAMPLE_RATE),
    "-ac", String(CHANNELS),
    "-c:a", SAMPLE_FORMAT,
    "-rf64", "auto",
    outPath,
  ], { timeoutMs, label: "render timeline silence" });
}

async function concatFragments({ fragmentNames, manifestPath, outPath, tempDirectory, ffmpegPath, timeoutMs }) {
  fs.writeFileSync(
    manifestPath,
    `${fragmentNames.map((name) => `file '${name}'`).join("\n")}\n`,
    "utf8",
  );
  await runProcess(ffmpegPath, [
    ...ffmpegCommonPrefix(),
    "-f", "concat",
    "-safe", "1",
    "-i", path.basename(manifestPath),
    "-map", "0:a:0",
    "-ar", String(SAMPLE_RATE),
    "-ac", String(CHANNELS),
    "-c:a", SAMPLE_FORMAT,
    "-rf64", "auto",
    path.basename(outPath),
  ], { cwd: tempDirectory, timeoutMs, label: `concat ${path.basename(outPath)}` });
}

async function normalizeOrMixAudio({
  inputPaths,
  outputPath,
  sequenceDurationSamples,
  ffmpegPath,
  timeoutMs,
  label,
}) {
  const args = [...ffmpegCommonPrefix()];
  for (const inputPath of inputPaths) args.push("-i", inputPath);
  const filter = inputPaths.length === 1
    ? `[0:a:0]apad,atrim=end_sample=${sequenceDurationSamples},asetpts=N/SR/TB[out]`
    : `${inputPaths.map((_, index) => `[${index}:a:0]`).join("")}` +
      `amix=inputs=${inputPaths.length}:normalize=0:duration=longest:dropout_transition=0,` +
      `apad,atrim=end_sample=${sequenceDurationSamples},asetpts=N/SR/TB[out]`;
  args.push(
    "-filter_complex", filter,
    "-map", "[out]",
    "-ar", String(SAMPLE_RATE),
    "-ac", String(CHANNELS),
    "-c:a", SAMPLE_FORMAT,
    "-rf64", "auto",
    outputPath,
  );
  await runProcess(ffmpegPath, args, { timeoutMs, label });
}

async function buildStagedMix({ trackPaths, tempDirectory, sequenceDurationSamples, ffmpegPath, timeoutMs }) {
  let inputs = [...trackPaths];
  let stage = 0;
  while (inputs.length > 1) {
    const next = [];
    for (let index = 0; index < inputs.length; index += MAX_MIX_INPUTS) {
      const group = inputs.slice(index, index + MAX_MIX_INPUTS);
      if (group.length === 1) {
        next.push(group[0]);
        continue;
      }
      const outputPath = path.join(tempDirectory, `mix-${stage}-${Math.floor(index / MAX_MIX_INPUTS)}.wav`);
      await normalizeOrMixAudio({
        inputPaths: group,
        outputPath,
        sequenceDurationSamples,
        ffmpegPath,
        timeoutMs,
        label: `mix stage ${stage}`,
      });
      next.push(outputPath);
    }
    inputs = next;
    stage += 1;
  }
  const finalPath = path.join(tempDirectory, "final.wav");
  await normalizeOrMixAudio({
    inputPaths: inputs,
    outputPath: finalPath,
    sequenceDurationSamples,
    ffmpegPath,
    timeoutMs,
    label: "normalize final transcription audio",
  });
  return finalPath;
}

function parseTimeBase(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match || Number(match[2]) === 0) return null;
  return Number(match[1]) / Number(match[2]);
}

async function verifyBuiltWave({ filePath, expectedSamples, ffprobePath, timeoutMs }) {
  const probe = await probeAudio(filePath, ffprobePath, timeoutMs);
  if (probe.codecName !== SAMPLE_FORMAT || probe.sampleRate !== SAMPLE_RATE || probe.channels !== CHANNELS) {
    fail(
      `Built WAV format mismatch: codec=${probe.codecName}, sampleRate=${probe.sampleRate}, ` +
      `channels=${probe.channels}.`,
    );
  }
  const timeBase = parseTimeBase(probe.timeBase);
  const probedSamples = Number.isFinite(probe.durationTs) && timeBase !== null
    ? Math.round(probe.durationTs * timeBase * SAMPLE_RATE)
    : probe.durationSeconds === null ? NaN : Math.round(probe.durationSeconds * SAMPLE_RATE);
  if (!Number.isFinite(probedSamples) || Math.abs(probedSamples - expectedSamples) > 1) {
    fail(`Built WAV duration mismatch: expected ${expectedSamples} samples, got ${probedSamples}.`);
  }
  return { ...probe, durationSamples: probedSamples, durationSeconds: samplesToSeconds(probedSamples) };
}

/** Build a plan into a 16 kHz mono PCM WAV. */
export async function buildPremiereTranscriptionAudio(plan, {
  ffmpegPath = "ffmpeg",
  ffprobePath = "ffprobe",
  timeoutMs = 30 * 60 * 1000,
} = {}) {
  if (!plan || plan.sampleRate !== SAMPLE_RATE || plan.channels !== CHANNELS || !Array.isArray(plan.trackPlans)) {
    fail("Invalid premiere transcription audio plan.");
  }
  const outputPath = path.resolve(plan.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tempParent = path.join(path.dirname(outputPath), "tmp");
  fs.mkdirSync(tempParent, { recursive: true });
  const safeBase = path.basename(outputPath, path.extname(outputPath)).replace(/[^a-zA-Z0-9_-]+/g, "-") || "audio";
  const tempDirectory = fs.mkdtempSync(path.join(tempParent, `${safeBase}-`));
  let completed = false;

  try {
    const uniqueMediaPaths = [...new Set(
      plan.trackPlans.flatMap((trackPlan) => trackPlan.clips.map((clip) => clip.mediaPath)),
    )];
    const mediaProbes = new Map();
    for (const mediaPath of uniqueMediaPaths) {
      if (!fs.existsSync(mediaPath)) fail(`Media disappeared after planning: ${mediaPath}`);
      mediaProbes.set(mediaPath, await probeAudio(mediaPath, ffprobePath, timeoutMs));
    }
    // The explicit --timing-tolerance-ms reaches this check too (it used to stop at the plan): a clip whose out point runs a few
    // ms past its audio stream (a video whose audio ends early) is padded with silence to its exact length by renderClipFragment.
    const mediaTolerance = Number.isFinite(plan.timingToleranceSeconds) ? plan.timingToleranceSeconds : DEFAULT_TIMING_TOLERANCE_SECONDS;
    for (const trackPlan of plan.trackPlans) {
      for (const clip of trackPlan.clips) {
        const duration = mediaProbes.get(clip.mediaPath)?.durationSeconds;
        if (duration === null || duration === undefined) {
          fail(`Cannot prove source duration for ${clip.mediaPath}.`);
        }
        if (clip.outPointSeconds > duration + mediaTolerance) {
          fail(
            `Source out point ${formatSeconds(clip.outPointSeconds)}s exceeds media duration ` +
            `${formatSeconds(duration)}s: ${clip.mediaPath}`,
          );
        }
      }
    }

    const trackPaths = [];
    for (const trackPlan of plan.trackPlans) {
      const fragmentNames = [];
      let cursorSample = 0;
      let fragmentIndex = 0;
      for (const clip of trackPlan.clips) {
        const fragmentName = `track-${trackPlan.trackIndex}-fragment-${String(fragmentIndex).padStart(6, "0")}.wav`;
        await renderClipFragment({
          clip,
          gapSamples: clip.startSample - cursorSample,
          outPath: path.join(tempDirectory, fragmentName),
          ffmpegPath,
          timeoutMs,
        });
        fragmentNames.push(fragmentName);
        cursorSample = clip.endSample;
        fragmentIndex += 1;
      }
      if (cursorSample < plan.sequenceDurationSamples || fragmentNames.length === 0) {
        const fragmentName = `track-${trackPlan.trackIndex}-fragment-${String(fragmentIndex).padStart(6, "0")}.wav`;
        await renderSilence({
          samples: plan.sequenceDurationSamples - cursorSample,
          outPath: path.join(tempDirectory, fragmentName),
          ffmpegPath,
          timeoutMs,
        });
        fragmentNames.push(fragmentName);
      }
      const trackPath = path.join(tempDirectory, `track-${trackPlan.trackIndex}.wav`);
      await concatFragments({
        fragmentNames,
        manifestPath: path.join(tempDirectory, `track-${trackPlan.trackIndex}.ffconcat`),
        outPath: trackPath,
        tempDirectory,
        ffmpegPath,
        timeoutMs,
      });
      trackPaths.push(trackPath);
    }

    const finalTempPath = await buildStagedMix({
      trackPaths,
      tempDirectory,
      sequenceDurationSamples: plan.sequenceDurationSamples,
      ffmpegPath,
      timeoutMs,
    });
    const verified = await verifyBuiltWave({
      filePath: finalTempPath,
      expectedSamples: plan.sequenceDurationSamples,
      ffprobePath,
      timeoutMs,
    });
    fs.copyFileSync(finalTempPath, outputPath);
    const outputVerified = await verifyBuiltWave({
      filePath: outputPath,
      expectedSamples: plan.sequenceDurationSamples,
      ffprobePath,
      timeoutMs,
    });
    completed = true;
    return {
      outputPath,
      selectedTracks: plan.selectedTracks,
      selectedClipCount: plan.selectedClipCount,
      sequenceDurationSeconds: plan.sequenceDurationSeconds,
      durationSamples: outputVerified.durationSamples,
      sampleRate: outputVerified.sampleRate,
      channels: outputVerified.channels,
      codec: outputVerified.codecName,
      tempCleaned: true,
      preCopyDurationSamples: verified.durationSamples,
    };
  } catch (error) {
    error.message = `${error.message}\nTemporary diagnostics retained at: ${tempDirectory}`;
    throw error;
  } finally {
    if (completed) fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

export function parseArgs(argv) {
  const options = {
    tracks: [],
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    timeoutMs: 30 * 60 * 1000,
    timingToleranceSeconds: DEFAULT_TIMING_TOLERANCE_SECONDS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--map") options.mapPath = argv[++index];
    else if (value === "--out") options.outputPath = argv[++index];
    else if (value === "--track") options.tracks.push(argv[++index]);
    else if (value === "--plan-out") options.planOutPath = argv[++index];
    else if (value === "--ffmpeg") options.ffmpegPath = argv[++index];
    else if (value === "--ffprobe") options.ffprobePath = argv[++index];
    else if (value === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (value === "--timing-tolerance-ms") options.timingToleranceSeconds = Number(argv[++index]) / 1000;
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else fail(`Unknown argument: ${value}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/build-premiere-transcription-audio.mjs --map <audio-map.json> --out <audio.wav> [options]",
    "",
    "Options:",
    "  --track <index>             Dialogue track index; repeat to mix tracks (default: 0)",
    "  --dry-run                   Validate sources/timing and write only a JSON plan",
    "  --plan-out <json>           Plan path (dry-run default: <out>.plan.json)",
    "  --timing-tolerance-ms <n>   Source/timeline duration tolerance (default: 2)",
    "  --ffmpeg <path>             FFmpeg executable (default: ffmpeg)",
    "  --ffprobe <path>            ffprobe executable (default: ffprobe)",
    "  --timeout-ms <n>            Per-process timeout (default: 1800000)",
    "",
    "Reconstructs enabled, normal-speed clips as a sample-accurate 16 kHz mono PCM WAV.",
    "Missing/offline media, same-track overlap, invalid timing, and speed changes fail closed.",
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.mapPath) fail("--map is required.");
  if (!options.outputPath) fail("--out is required.");
  if (!(options.timeoutMs > 0)) fail("--timeout-ms must be greater than zero.");

  const mapPath = path.resolve(options.mapPath);
  const audioMap = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  const plan = buildTranscriptionAudioPlan(audioMap, {
    tracks: options.tracks,
    outputPath: options.outputPath,
    baseDirectory: path.dirname(mapPath),
    timingToleranceSeconds: options.timingToleranceSeconds,
  });
  if (options.dryRun || options.planOutPath) {
    const planOutPath = path.resolve(options.planOutPath || `${plan.outputPath}.plan.json`);
    fs.mkdirSync(path.dirname(planOutPath), { recursive: true });
    fs.writeFileSync(planOutPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    if (options.dryRun) {
      console.log(JSON.stringify({
        dryRun: true,
        planOutPath,
        outputPath: plan.outputPath,
        sequenceName: plan.sequenceName,
        selectedTracks: plan.selectedTracks,
        selectedClipCount: plan.selectedClipCount,
        sequenceDurationSeconds: plan.sequenceDurationSeconds,
      }, null, 2));
      return;
    }
  }
  const result = await buildPremiereTranscriptionAudio(plan, {
    ffmpegPath: options.ffmpegPath,
    ffprobePath: options.ffprobePath,
    timeoutMs: options.timeoutMs,
  });
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
