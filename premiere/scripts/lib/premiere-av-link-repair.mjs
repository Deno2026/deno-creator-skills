const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 100;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmptyString(value, label) {
  assert(typeof value === "string" && value.trim(), `${label} is required`);
  return value.trim();
}

function integer(value, label) {
  const number = Number(value);
  assert(Number.isInteger(number), `${label} must be an integer`);
  return number;
}

export function createPremiereAvLinkRepairPlan(input, options = {}) {
  assert(input && typeof input === "object", "link repair input is required");
  const projectName = nonEmptyString(input.projectName, "projectName");
  const sequenceName = nonEmptyString(input.sequenceName, "sequenceName");
  const targetClipNames = [...new Set((input.targetClipNames || []).map((value) => nonEmptyString(value, "targetClipNames[]")))];
  assert(targetClipNames.length > 0, "targetClipNames must not be empty");
  const videoTrackIndex = integer(input.videoTrackIndex, "videoTrackIndex");
  const audioTrackIndex = integer(input.audioTrackIndex, "audioTrackIndex");
  const expectedPairCount = integer(input.expectedPairCount, "expectedPairCount");
  const batchSize = integer(options.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize");
  assert(videoTrackIndex >= 0 && audioTrackIndex >= 0, "track indexes must be non-negative");
  assert(expectedPairCount > 0, "expectedPairCount must be positive");
  assert(batchSize > 0 && batchSize <= MAX_BATCH_SIZE, `batchSize must be between 1 and ${MAX_BATCH_SIZE}`);
  const batches = [];
  for (let startIndex = 0; startIndex < expectedPairCount; startIndex += batchSize) {
    batches.push(Object.freeze({
      batchNumber: batches.length + 1,
      startIndex,
      endIndex: Math.min(expectedPairCount, startIndex + batchSize),
    }));
  }
  return Object.freeze({
    projectName,
    sequenceName,
    targetClipNames: Object.freeze(targetClipNames),
    videoTrackIndex,
    audioTrackIndex,
    expectedPairCount,
    batchSize,
    batches: Object.freeze(batches),
  });
}

function commonPrelude(plan) {
  return `
var seq = app.project.activeSequence;
if (!seq) return __error("No active sequence");
if (app.project.name !== ${JSON.stringify(plan.projectName)}) return __error("Active project changed");
if (seq.name !== ${JSON.stringify(plan.sequenceName)}) return __error("Active sequence changed");
var videoTrack = seq.videoTracks[${plan.videoTrackIndex}];
var audioTrack = seq.audioTracks[${plan.audioTrackIndex}];
if (!videoTrack || !audioTrack) return __error("Target track is unavailable");
var targetNames = ${JSON.stringify(plan.targetClipNames)};
var expectedPairCount = ${plan.expectedPairCount};
function isTargetName(name) {
  for (var n = 0; n < targetNames.length; n++) if (targetNames[n] === name) return true;
  return false;
}
function sourceId(item) {
  try { return String(item.projectItem.nodeId); } catch(e) { return ""; }
}
function pairKey(item) {
  return String(item.name) + "|" + sourceId(item) + "|" + String(item.start.ticks) + "|" +
    String(item.end.ticks) + "|" + String(item.inPoint.ticks) + "|" + String(item.outPoint.ticks);
}
function exactPairIsLinked(video, audio) {
  var linked = video.getLinkedItems();
  if (!linked || linked.numItems !== 2) return false;
  var foundVideo = false;
  var foundAudio = false;
  for (var x = 0; x < linked.numItems; x++) {
    if (String(linked[x].nodeId) === String(video.nodeId)) foundVideo = true;
    if (String(linked[x].nodeId) === String(audio.nodeId)) foundAudio = true;
  }
  return foundVideo && foundAudio;
}
var videos = [];
var audioByKey = {};
var audioKeyCount = {};
var i;
var clip;
for (i = 0; i < videoTrack.clips.numItems; i++) {
  clip = videoTrack.clips[i];
  if (isTargetName(clip.name)) videos.push(clip);
}
var targetAudioCount = 0;
for (i = 0; i < audioTrack.clips.numItems; i++) {
  clip = audioTrack.clips[i];
  if (isTargetName(clip.name)) {
    var audioKey = pairKey(clip);
    audioKeyCount[audioKey] = (audioKeyCount[audioKey] || 0) + 1;
    audioByKey[audioKey] = clip;
    targetAudioCount++;
  }
}
if (videos.length !== expectedPairCount || targetAudioCount !== expectedPairCount) {
  return __error("Target pair count changed: V=" + videos.length + " A=" + targetAudioCount + " expected=" + expectedPairCount);
}
for (i = 0; i < videos.length; i++) {
  if (audioKeyCount[pairKey(videos[i])] !== 1) {
    return __error("Ambiguous or missing audio pair at video index " + i);
  }
}
`;
}

export function buildPremiereAvLinkBatchExtendScript(plan, batch) {
  assert(plan?.batches?.includes(batch), "batch must belong to the repair plan");
  return `${commonPrelude(plan)}
function clearSelection() {
  var t;
  var c;
  for (t = 0; t < seq.videoTracks.numTracks; t++) {
    for (c = 0; c < seq.videoTracks[t].clips.numItems; c++) seq.videoTracks[t].clips[c].setSelected(0, false);
  }
  for (t = 0; t < seq.audioTracks.numTracks; t++) {
    for (c = 0; c < seq.audioTracks[t].clips.numItems; c++) seq.audioTracks[t].clips[c].setSelected(0, false);
  }
}
clearSelection();
var linkedNow = 0;
var alreadyLinked = 0;
for (i = ${batch.startIndex}; i < ${batch.endIndex}; i++) {
  var video = videos[i];
  var audio = audioByKey[pairKey(video)];
  var videoLinks = video.getLinkedItems();
  var audioLinks = audio.getLinkedItems();
  if (exactPairIsLinked(video, audio)) {
    alreadyLinked++;
    continue;
  }
  if ((videoLinks && videoLinks.numItems > 0) || (audioLinks && audioLinks.numItems > 0)) {
    return __error("Unexpected existing link group at pair index " + i);
  }
  video.setSelected(1, true);
  audio.setSelected(1, true);
  seq.linkSelection();
  if (!exactPairIsLinked(video, audio)) return __error("Link verification failed at pair index " + i);
  linkedNow++;
  video.setSelected(0, false);
  audio.setSelected(0, false);
}
clearSelection();
return __result({
  batchNumber:${batch.batchNumber},
  startIndex:${batch.startIndex},
  endIndex:${batch.endIndex},
  linkedNow:linkedNow,
  alreadyLinked:alreadyLinked,
  processed:${batch.endIndex - batch.startIndex}
});
`;
}

export function buildPremiereAvLinkAuditExtendScript(plan) {
  return `${commonPrelude(plan)}
var verifiedPairs = 0;
var mismatches = [];
for (i = 0; i < videos.length; i++) {
  var video = videos[i];
  var audio = audioByKey[pairKey(video)];
  if (exactPairIsLinked(video, audio)) verifiedPairs++;
  else if (mismatches.length < 20) mismatches.push({index:i,startSeconds:video.start.seconds});
}
return __result({
  targetVideoCount:videos.length,
  targetAudioCount:targetAudioCount,
  verifiedPairs:verifiedPairs,
  mismatchCount:videos.length - verifiedPairs,
  mismatches:mismatches
});
`;
}

export const premiereAvLinkRepairDefaults = Object.freeze({
  batchSize: DEFAULT_BATCH_SIZE,
  maxBatchSize: MAX_BATCH_SIZE,
});
