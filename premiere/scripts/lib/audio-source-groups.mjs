import path from "node:path";

function normalizedMediaPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = path.normalize(raw);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function audioSourceGroupKey(clip, { groupBy = "source" } = {}) {
  if (groupBy === "clip") {
    return `clip:${Number(clip.trackIndex)}:${Number(clip.clipIndex)}:${String(clip.nodeId || "")}`;
  }
  if (groupBy !== "source") throw new Error(`Unsupported audio grouping mode: ${groupBy}`);
  const mediaPath = normalizedMediaPath(clip.mediaPath);
  const projectItemNodeId = String(clip.projectItemNodeId || "").trim();
  const sourceIdentity = mediaPath
    ? `media:${mediaPath}`
    : projectItemNodeId
      ? `project-item:${projectItemNodeId}`
      : "";
  const explicit = String(clip.sourceGroup || "").trim();
  if (sourceIdentity && explicit) return `${sourceIdentity}|group:${explicit}`;
  if (sourceIdentity) return sourceIdentity;
  throw new Error(
    `Cannot determine an audio source group for ${clip.name || "unnamed clip"}; mediaPath, sourceGroup, and projectItemNodeId are empty.`,
  );
}

export function groupAudioClips(clips, options = {}) {
  const groups = new Map();
  for (const clip of clips) {
    const key = audioSourceGroupKey(clip, options);
    const group = groups.get(key) || { key, clips: [], mediaPaths: new Set() };
    group.clips.push(clip);
    const mediaPath = normalizedMediaPath(clip.mediaPath);
    if (mediaPath) group.mediaPaths.add(mediaPath);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    key: group.key,
    clips: [...group.clips].sort(
      (left, right) =>
        Number(left.startSeconds || 0) - Number(right.startSeconds || 0) ||
        Number(left.trackIndex || 0) - Number(right.trackIndex || 0) ||
        Number(left.clipIndex || 0) - Number(right.clipIndex || 0),
    ),
    mediaPaths: [...group.mediaPaths],
  }));
}

export function assertUniformFinalLevel(adjustments, toleranceDb = 0.001) {
  const byGroup = new Map();
  for (const adjustment of adjustments) {
    const key = String(adjustment.sourceGroupKey || "");
    if (!key) throw new Error("Adjustment is missing sourceGroupKey.");
    const level = Number(adjustment.finalDisplayDb);
    if (!Number.isFinite(level)) {
      throw new Error(`Source group ${key} contains a non-finite final level.`);
    }
    const expected = byGroup.get(key);
    if (expected === undefined) byGroup.set(key, level);
    else if (Math.abs(expected - level) > toleranceDb) {
      throw new Error(`Source group ${key} contains non-uniform final levels.`);
    }
  }
  return true;
}
