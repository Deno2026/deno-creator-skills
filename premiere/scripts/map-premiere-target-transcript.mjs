// Map one existing Premiere clip transcript from source time to the exact
// timeline interval captured by premiere:capture-direct-cut-inputs.
// Offline only: no Premiere connection and no timeline write.

import {createHash, randomBytes} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";

function fail(message) {
  throw new Error(`Target transcript map: ${message}`);
}

function clean(value) {
  return String(value ?? "").trim();
}

function finite(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`${label} must be finite`);
  return parsed;
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

export function mapPremiereTargetTranscript({transcript, clips}) {
  if (!Array.isArray(transcript?.items)) fail("transcript.items[] is required");
  if (!Array.isArray(clips?.clips) || clips.clips.length !== 1) {
    fail("clips capture must contain exactly one target clip");
  }
  const clip = clips.clips[0];
  const targetName = clean(clip.targetClipName ?? clips.targetClipNames?.[0]);
  if (!targetName) fail("target clip name is missing");
  const matches = transcript.items.filter((item) => clean(item?.name) === targetName);
  if (matches.length !== 1) fail(`expected one transcript item named '${targetName}', found ${matches.length}`);
  const item = matches[0];
  if (!Array.isArray(item.words) || item.words.length === 0) fail("target transcript is empty");
  const projectItemNodeId = clean(clip.projectItemNodeId);
  const transcriptNodeId = clean(item.nodeId);
  if (projectItemNodeId && transcriptNodeId && projectItemNodeId !== transcriptNodeId) {
    fail("transcript project item does not match the captured target");
  }
  const fps = finite(clips.fps, "clips.fps");
  if (!(fps > 0)) fail("clips.fps must be positive");
  const sourceIn = finite(clip.sourceIn, "clip.sourceIn");
  const sourceOut = finite(clip.sourceOut, "clip.sourceOut");
  const timelineStart = finite(clip.timelineStart, "clip.timelineStart");
  const timelineEnd = finite(clip.timelineEnd, "clip.timelineEnd");
  if (!(sourceOut > sourceIn) || !(timelineEnd > timelineStart)) fail("target interval is invalid");
  if (Math.abs((sourceOut - sourceIn) - (timelineEnd - timelineStart)) > 1e-4) {
    fail("non-unit target playback mapping is unsupported");
  }

  const words = [];
  let excludedOutsideTarget = 0;
  let excludedClippedAtEdge = 0;
  for (let index = 0; index < item.words.length; index += 1) {
    const word = item.words[index];
    const text = clean(word?.text);
    if (!text) fail(`words[${index}].text is empty`);
    const sourceStartSeconds = finite(word.startSeconds ?? word.start, `words[${index}].startSeconds`);
    const sourceEndSeconds = finite(word.endSeconds ?? word.end, `words[${index}].endSeconds`);
    if (!(sourceEndSeconds > sourceStartSeconds) || sourceStartSeconds < 0) {
      fail(`words[${index}] has an invalid source interval`);
    }
    if (sourceEndSeconds <= sourceIn || sourceStartSeconds >= sourceOut) {
      excludedOutsideTarget += 1;
      continue;
    }
    if (sourceStartSeconds < sourceIn || sourceEndSeconds > sourceOut) {
      excludedClippedAtEdge += 1;
      continue;
    }
    words.push({
      text,
      startSeconds: timelineStart + (sourceStartSeconds - sourceIn),
      endSeconds: timelineStart + (sourceEndSeconds - sourceIn),
      sourceStartSeconds,
      sourceEndSeconds,
      clipNodeId: clean(clip.videoNodeId),
      projectItemNodeId: projectItemNodeId || transcriptNodeId,
    });
  }
  if (words.length === 0) fail("no transcript words fall wholly inside the captured target");
  for (let index = 1; index < words.length; index += 1) {
    if (words[index].startSeconds < words[index - 1].startSeconds) {
      fail("transcript words are not ordered by source time");
    }
  }

  return {
    schemaVersion: 1,
    source: "premiere-existing-clip-transcript-target-map",
    fps,
    ticksPerFrame: clean(clips.ticksPerFrame),
    captureSha256: clean(clips.captureSha256),
    targetBindingSha256: clean(clips.targetBindingSha256),
    bundleSha256: clean(clips.bundleSha256),
    target: {
      name: targetName,
      media: path.resolve(clip.media),
      videoNodeId: clean(clip.videoNodeId),
      audioNodeId: clean(clip.audioNodeId),
      projectItemNodeId: projectItemNodeId || transcriptNodeId,
    },
    mapping: {sourceIn, sourceOut, timelineStart, timelineEnd},
    transcriptEvidence: {
      itemName: clean(item.name),
      itemNodeId: transcriptNodeId,
      sourceWordCount: item.words.length,
      mappedWordCount: words.length,
      excludedOutsideTarget,
      excludedClippedAtEdge,
    },
    words,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--transcript") options.transcript = argv[++index];
    else if (value === "--clips") options.clips = argv[++index];
    else if (value === "--out") options.out = argv[++index];
    else if (value === "--help" || value === "-h") options.help = true;
    else fail(`unknown argument: ${value}`);
  }
  return options;
}

function usage() {
  return "Usage: node scripts/map-premiere-target-transcript.mjs --transcript <get_clip_transcript.json> --clips <capture/clips.json> --out <new.json>";
}

function writeNewJson(filePath, payload) {
  const resolved = path.resolve(filePath);
  if (fs.existsSync(resolved)) fail(`output already exists: ${resolved}`);
  fs.mkdirSync(path.dirname(resolved), {recursive: true});
  const temporary = `${resolved}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {encoding: "utf8", flag: "wx"});
    fs.renameSync(temporary, resolved);
  } catch (error) {
    try { fs.rmSync(temporary, {force: true}); } catch {}
    throw error;
  }
  return resolved;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.transcript || !options.clips || !options.out) {
    console.log(usage());
    if (!options.help) process.exitCode = 1;
    return;
  }
  const transcriptPath = path.resolve(options.transcript);
  const clipsPath = path.resolve(options.clips);
  const payload = mapPremiereTargetTranscript({
    transcript: JSON.parse(fs.readFileSync(transcriptPath, "utf8")),
    clips: JSON.parse(fs.readFileSync(clipsPath, "utf8")),
  });
  payload.sourceFiles = {
    transcript: {path: transcriptPath, sha256: sha256File(transcriptPath)},
    clips: {path: clipsPath, sha256: sha256File(clipsPath)},
  };
  const out = writeNewJson(options.out, payload);
  console.log(JSON.stringify({
    out,
    mappedWordCount: payload.words.length,
    target: payload.target.name,
    timelineWrites: 0,
  }, null, 2));
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
