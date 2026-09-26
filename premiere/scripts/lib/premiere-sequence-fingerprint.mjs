import {createHash} from 'node:crypto';

const FRAME_EPSILON_SECONDS = 0.0005;

const finite = (value, label) => {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label} must be a finite number.`);
  return result;
};

const frame = (seconds, fps, label) => {
  const value = finite(seconds, label);
  const exact = value * fps;
  const rounded = Math.round(exact);
  if (Math.abs(exact - rounded) / fps > FRAME_EPSILON_SECONDS) {
    throw new Error(`${label} is not frame-aligned at ${fps}fps.`);
  }
  return rounded;
};

const optionalSeconds = (value, label) => {
  if (value === undefined || value === null || value === '') return null;
  return Number(finite(value, label).toFixed(9));
};

const normalizeClip = (clip, fps, label, kind = 'video') => {
  // Audio clips may legitimately end off the video frame grid (sample-accurate WAV/BGM edits made by
  // the user). Fingerprint them by stable seconds instead of asserting frame alignment (2026-09-15).
  const timeline = kind === 'audio'
    ? {
        startSeconds: optionalSeconds(clip?.startSeconds, `${label}.startSeconds`),
        endSeconds: optionalSeconds(clip?.endSeconds, `${label}.endSeconds`),
        durationSeconds: optionalSeconds(clip?.durationSeconds, `${label}.durationSeconds`),
      }
    : (() => {
        const startFrame = frame(clip?.startSeconds, fps, `${label}.startSeconds`);
        const endFrame = frame(clip?.endSeconds, fps, `${label}.endSeconds`);
        const durationFrame = frame(clip?.durationSeconds, fps, `${label}.durationSeconds`);
        if (endFrame <= startFrame || durationFrame !== endFrame - startFrame) {
          throw new Error(`${label} has inconsistent start/end/duration.`);
        }
        return {startFrame, endFrame, durationFrame};
      })();
  const speed = clip?.speed === undefined || clip?.speed === null || clip?.speed === ''
    ? null
    : Number.isFinite(Number(clip.speed))
      // CEP serializes fewer digits than UXP (e.g. .78625954198473).
      // Preserve meaningful speed changes while removing bridge rounding noise.
      ? Number(Number(clip.speed).toPrecision(14))
      : String(clip.speed);
  return {
    name: String(clip?.name ?? ''),
    ...timeline,
    inPointSeconds: optionalSeconds(clip?.inPointSeconds, `${label}.inPointSeconds`),
    outPointSeconds: optionalSeconds(clip?.outPointSeconds, `${label}.outPointSeconds`),
    mediaType: String(clip?.mediaType ?? '').toLocaleLowerCase('en-US'),
    enabled: clip?.enabled === undefined ? null : Boolean(clip.enabled),
    speed,
  };
};

const normalizeTrack = (track, fps, label, kind = 'video') => {
  const index = Number(track?.index);
  if (!Number.isInteger(index) || index < 0) throw new Error(`${label}.index is invalid.`);
  const clips = Array.isArray(track?.clips) ? track.clips : [];
  if (track?.clipCount !== undefined && Number(track.clipCount) !== clips.length) {
    throw new Error(`${label}.clipCount does not match clips.`);
  }
  return {
    index,
    name: String(track?.name ?? ''),
    isMuted: (track?.isMuted ?? track?.muted) === undefined
      ? null
      : Boolean(track.isMuted ?? track.muted),
    clips: clips.map((clip, clipIndex) =>
      normalizeClip(clip, fps, `${label}.clips[${clipIndex}]`, kind)),
  };
};

export const normalizePremiereSequenceFingerprint = (structure, fps) => {
  const exactFps = finite(fps, 'fps');
  if (!(exactFps > 0)) throw new Error('fps must be greater than zero.');
  if (!structure || typeof structure !== 'object' || Array.isArray(structure)) {
    throw new Error('Sequence structure is required.');
  }
  const videoTracks = Array.isArray(structure.videoTracks) ? structure.videoTracks : [];
  const audioTracks = Array.isArray(structure.audioTracks) ? structure.audioTracks : [];
  if (Number(structure.videoTrackCount) !== videoTracks.length) {
    throw new Error('videoTrackCount does not match videoTracks.');
  }
  if (Number(structure.audioTrackCount) !== audioTracks.length) {
    throw new Error('audioTrackCount does not match audioTracks.');
  }
  return {
    id: String(structure.id ?? ''),
    name: String(structure.name ?? ''),
    durationFrames: frame(structure.durationSeconds, exactFps, 'sequence.durationSeconds'),
    videoTracks: videoTracks.map((track, index) =>
      normalizeTrack(track, exactFps, `videoTracks[${index}]`)),
    audioTracks: audioTracks.map((track, index) =>
      normalizeTrack(track, exactFps, `audioTracks[${index}]`, 'audio')),
  };
};

export const sha256PremiereSequenceFingerprint = (structure, fps) =>
  createHash('sha256')
    .update(JSON.stringify(normalizePremiereSequenceFingerprint(structure, fps)), 'utf8')
    .digest('hex')
    .toUpperCase();
