import assert from "node:assert/strict";

import {
  accumulateS16leFrameEnergies,
  buildFfmpegS16leArgs,
  createS16leFrameEnergyAccumulator,
} from "./lib/streaming-waveform-energy.mjs";

function encodeSamples(samples, trailingByte = null) {
  const buffer = Buffer.alloc(samples.length * 2 + (trailingByte === null ? 0 : 1));
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  if (trailingByte !== null) buffer[buffer.length - 1] = trailingByte;
  return buffer;
}

function referenceEnergies(samples, samplesPerFrame, mode) {
  const energies = [];
  for (let start = 0; start < samples.length; start += samplesPerFrame) {
    const frame = samples.slice(start, start + samplesPerFrame);
    if (mode === "rms") {
      let sumSquares = 0;
      for (const sample of frame) {
        const normalized = sample / 32768;
        sumSquares += normalized * normalized;
      }
      energies.push(Math.sqrt(sumSquares / frame.length));
    } else {
      let peak = 0;
      for (const sample of frame) {
        peak = Math.max(peak, Math.abs(sample) / 32768);
      }
      energies.push(peak);
    }
  }
  return energies;
}

function splitAtSizes(buffer, sizes) {
  const chunks = [];
  let offset = 0;
  let sizeIndex = 0;
  while (offset < buffer.length) {
    const size = sizes[sizeIndex % sizes.length];
    chunks.push(buffer.subarray(offset, Math.min(buffer.length, offset + size)));
    offset += size;
    sizeIndex += 1;
  }
  return chunks;
}

const samples = [
  -32768,
  -30000,
  -23456,
  -1,
  0,
  1,
  2,
  12345,
  32767,
  -7890,
  4567,
  42,
  -42,
];
const samplesPerFrame = 4;
const pcmWithOddTail = encodeSamples(samples, 0xa5);
const chunkings = [
  [pcmWithOddTail],
  splitAtSizes(pcmWithOddTail, [1]),
  splitAtSizes(pcmWithOddTail, [2]),
  splitAtSizes(pcmWithOddTail, [3, 5, 1, 4, 7]),
  splitAtSizes(pcmWithOddTail, [8, 1, 9, 2]),
];

for (const mode of ["rms", "peak"]) {
  const expected = referenceEnergies(samples, samplesPerFrame, mode);
  for (const chunks of chunkings) {
    const actual = accumulateS16leFrameEnergies(chunks, {
      samplesPerFrame,
      mode,
    });
    assert.deepEqual(actual.energies, expected);
    assert.equal(actual.totalSamples, samples.length);
    assert.equal(actual.ignoredTrailingBytes, 1);
  }
}

const partialFrame = accumulateS16leFrameEnergies(
  splitAtSizes(encodeSamples([1000, -2000, 3000]), [1, 2]),
  { samplesPerFrame: 8, mode: "rms" },
);
assert.equal(partialFrame.energies.length, 1);
assert.deepEqual(partialFrame.energies, referenceEnergies([1000, -2000, 3000], 8, "rms"));

const empty = accumulateS16leFrameEnergies([], { samplesPerFrame: 4, mode: "peak" });
assert.deepEqual(empty, { energies: [], totalSamples: 0, ignoredTrailingBytes: 0 });

const accumulator = createS16leFrameEnergyAccumulator({ samplesPerFrame: 2, mode: "peak" });
accumulator.write(encodeSamples([1]));
const finished = accumulator.finish();
assert.equal(accumulator.finish(), finished);
assert.throws(() => accumulator.write(Buffer.alloc(0)), /Cannot write PCM/);
assert.throws(
  () => createS16leFrameEnergyAccumulator({ samplesPerFrame: 0 }),
  /positive integer/,
);
assert.throws(
  () => createS16leFrameEnergyAccumulator({ samplesPerFrame: 1, mode: "mean" }),
  /Unsupported waveform energy mode/,
);

const ffmpegArgs = buildFfmpegS16leArgs({
  mediaPath: "fixture.wav",
  sampleRate: 16000,
  startSeconds: 1.25,
  durationSeconds: 2.5,
  audioMap: "0:a:0",
});
assert.ok(ffmpegArgs.includes("-nostdin"));
assert.deepEqual(
  ffmpegArgs.slice(ffmpegArgs.indexOf("-threads"), ffmpegArgs.indexOf("-threads") + 2),
  ["-threads", "2"],
);
assert.deepEqual(
  ffmpegArgs.slice(
    ffmpegArgs.indexOf("-filter_threads"),
    ffmpegArgs.indexOf("-filter_threads") + 2,
  ),
  ["-filter_threads", "1"],
);
assert.deepEqual(
  ffmpegArgs.slice(ffmpegArgs.indexOf("-ss"), ffmpegArgs.indexOf("-ss") + 2),
  ["-ss", "1.25"],
);
assert.deepEqual(
  ffmpegArgs.slice(ffmpegArgs.indexOf("-t"), ffmpegArgs.indexOf("-t") + 2),
  ["-t", "2.5"],
);

console.log(JSON.stringify({
  ok: true,
  testedModes: ["rms", "peak"],
  chunkings: chunkings.length,
  samples: samples.length,
}, null, 2));
