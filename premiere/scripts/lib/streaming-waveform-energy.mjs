import { spawn } from "node:child_process";

const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024;
const ENERGY_MODES = new Set(["rms", "peak"]);

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new TypeError("PCM chunks must be Buffer or Uint8Array instances");
}

function appendBoundedTail(current, chunk, limitBytes) {
  if (limitBytes === 0) return Buffer.alloc(0);
  const next = toBuffer(chunk);
  if (next.length >= limitBytes) {
    return Buffer.from(next.subarray(next.length - limitBytes));
  }
  const retainedBytes = Math.min(current.length, limitBytes - next.length);
  return Buffer.concat(
    [current.subarray(current.length - retainedBytes), next],
    retainedBytes + next.length,
  );
}

function decodeSignedInt16(lowByte, highByte) {
  const unsigned = lowByte | (highByte << 8);
  return unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
}

export function createS16leFrameEnergyAccumulator({ samplesPerFrame, mode = "rms" }) {
  if (!Number.isInteger(samplesPerFrame) || samplesPerFrame < 1) {
    throw new RangeError("samplesPerFrame must be a positive integer");
  }
  if (!ENERGY_MODES.has(mode)) {
    throw new RangeError(`Unsupported waveform energy mode: ${mode}`);
  }

  const energies = [];
  let pendingLowByte = null;
  let samplesInFrame = 0;
  let totalSamples = 0;
  let sumSquares = 0;
  let peak = 0;
  let finished = false;
  let finalResult = null;

  const finishFrame = () => {
    if (samplesInFrame === 0) return;
    energies.push(
      mode === "rms"
        ? Math.sqrt(sumSquares / samplesInFrame)
        : peak,
    );
    samplesInFrame = 0;
    sumSquares = 0;
    peak = 0;
  };

  const addSample = (sample) => {
    const normalized = sample / 32768;
    if (mode === "rms") {
      sumSquares += normalized * normalized;
    } else {
      peak = Math.max(peak, Math.abs(normalized));
    }
    samplesInFrame += 1;
    totalSamples += 1;
    if (samplesInFrame === samplesPerFrame) finishFrame();
  };

  return {
    write(chunk) {
      if (finished) throw new Error("Cannot write PCM after accumulator.finish()");
      const buffer = toBuffer(chunk);
      let offset = 0;

      if (pendingLowByte !== null && buffer.length > 0) {
        addSample(decodeSignedInt16(pendingLowByte, buffer[0]));
        pendingLowByte = null;
        offset = 1;
      }

      for (; offset + 1 < buffer.length; offset += 2) {
        addSample(decodeSignedInt16(buffer[offset], buffer[offset + 1]));
      }
      if (offset < buffer.length) pendingLowByte = buffer[offset];
    },

    finish() {
      if (finished) return finalResult;
      finishFrame();
      finished = true;
      finalResult = {
        energies,
        totalSamples,
        ignoredTrailingBytes: pendingLowByte === null ? 0 : 1,
      };
      return finalResult;
    },
  };
}

export function accumulateS16leFrameEnergies(chunks, options) {
  const accumulator = createS16leFrameEnergyAccumulator(options);
  for (const chunk of chunks) accumulator.write(chunk);
  return accumulator.finish();
}

export function buildFfmpegS16leArgs({
  mediaPath,
  sampleRate,
  startSeconds = null,
  durationSeconds = null,
  audioMap = null,
}) {
  if (!mediaPath) throw new Error("mediaPath is required");
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError("sampleRate must be positive");
  }
  if (startSeconds !== null && (!Number.isFinite(startSeconds) || startSeconds < 0)) {
    throw new RangeError("startSeconds must be null or a non-negative finite number");
  }
  if (
    durationSeconds !== null &&
    (!Number.isFinite(durationSeconds) || durationSeconds < 0)
  ) {
    throw new RangeError("durationSeconds must be null or a non-negative finite number");
  }

  return [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-threads",
    "2",
    "-filter_threads",
    "1",
    ...(startSeconds === null ? [] : ["-ss", String(startSeconds)]),
    "-i",
    mediaPath,
    ...(durationSeconds === null ? [] : ["-t", String(durationSeconds)]),
    ...(audioMap ? ["-map", audioMap] : []),
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    "-f",
    "s16le",
    "pipe:1",
  ];
}

export async function decodeFfmpegWaveformEnergies({
  mediaPath,
  sampleRate,
  frameSeconds,
  mode = "rms",
  startSeconds = null,
  durationSeconds = null,
  audioMap = null,
  ffmpegPath = "ffmpeg",
  stderrLimitBytes = DEFAULT_STDERR_LIMIT_BYTES,
  errorLabel = "ffmpeg waveform decode failed",
}) {
  if (!Number.isFinite(frameSeconds) || frameSeconds <= 0) {
    throw new RangeError("frameSeconds must be positive");
  }
  if (!Number.isInteger(stderrLimitBytes) || stderrLimitBytes < 0) {
    throw new RangeError("stderrLimitBytes must be a non-negative integer");
  }

  const normalizedSampleRate = Math.round(sampleRate);
  const samplesPerFrame = Math.max(
    1,
    Math.round(normalizedSampleRate * frameSeconds),
  );
  const accumulator = createS16leFrameEnergyAccumulator({ samplesPerFrame, mode });
  const args = buildFfmpegS16leArgs({
    mediaPath,
    sampleRate: normalizedSampleRate,
    startSeconds,
    durationSeconds,
    audioMap,
  });

  return await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = Buffer.alloc(0);
    let stderrTruncated = false;
    let spawnError = null;
    let streamError = null;

    child.stdout.on("data", (chunk) => {
      if (streamError) return;
      try {
        accumulator.write(chunk);
      } catch (error) {
        streamError = error;
        child.kill();
      }
    });
    child.stdout.on("error", (error) => {
      streamError = error;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length + chunk.length > stderrLimitBytes) stderrTruncated = true;
      stderr = appendBoundedTail(stderr, chunk, stderrLimitBytes);
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code, signal) => {
      const stderrText = stderr.toString("utf8").trim();
      const detail = [
        stderrTruncated ? "[earlier ffmpeg stderr truncated]" : "",
        stderrText,
      ].filter(Boolean).join("\n");
      if (spawnError) {
        reject(new Error(`${errorLabel}: ${spawnError.message}`, { cause: spawnError }));
        return;
      }
      if (streamError) {
        reject(new Error(`${errorLabel}: ${streamError.message}`, { cause: streamError }));
        return;
      }
      if (code !== 0) {
        const exit = signal ? `signal ${signal}` : `exit code ${code}`;
        reject(new Error(`${errorLabel}: ${detail || exit}`));
        return;
      }

      const result = accumulator.finish();
      resolve({
        ...result,
        sampleRate: normalizedSampleRate,
        frameSeconds,
        samplesPerFrame,
      });
    });
  });
}
