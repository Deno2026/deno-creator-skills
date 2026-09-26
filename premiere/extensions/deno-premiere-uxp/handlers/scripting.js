const {
  MAX_CONCURRENT_READS,
  collectTrackItems,
  countSequenceClips,
  findSequence,
  getActiveProject,
  getPremiereBuildNumber,
  getPremiereVersion,
  getSequenceBasicInfo,
  guidText,
  mapWithConcurrency,
  normalizeWindowsPath,
  readAudioTrack,
  readVideoTrack,
  secondsOf,
  validateNoArgs,
  validateSequenceArgs
} = require("./shared.js");

async function getPremiereState() {
  const project = await getActiveProject();
  const [rootItem, sequences, activeSequence, version] = await Promise.all([
    project.getRootItem(),
    project.getSequences(),
    project.getActiveSequence(),
    getPremiereVersion()
  ]);
  const rootItems = rootItem ? await rootItem.getItems() : [];

  const result = {
    project: {
      name: project.name,
      path: normalizeWindowsPath(project.path),
      rootItemCount: Array.from(rootItems || []).length,
      sequenceCount: Array.from(sequences || []).length
    },
    sequences: await mapWithConcurrency(
      sequences,
      MAX_CONCURRENT_READS,
      getSequenceBasicInfo
    ),
    activeSequence: null
  };

  if (activeSequence) {
    const [endTime, videoTrackCount, audioTrackCount, playerPosition, trackItems] =
      await Promise.all([
        activeSequence.getEndTime(),
        activeSequence.getVideoTrackCount(),
        activeSequence.getAudioTrackCount(),
        activeSequence.getPlayerPosition(),
        collectTrackItems(activeSequence, { trackType: "both" })
      ]);

    result.activeSequence = {
      name: activeSequence.name,
      id: guidText(activeSequence.guid),
      durationSeconds: secondsOf(endTime),
      videoTrackCount,
      audioTrackCount,
      totalClipCount: await countSequenceClips(
        activeSequence,
        videoTrackCount,
        audioTrackCount
      )
    };
    result.playheadSeconds = secondsOf(playerPosition);
    const selectionStates = await mapWithConcurrency(
      trackItems,
      MAX_CONCURRENT_READS,
      async (descriptor) => ({
        selected: Boolean(await descriptor.item.getIsSelected()),
        nodeId: descriptor.nodeId,
        name: await descriptor.item.getName()
      })
    );
    result.selectedClips = selectionStates
      .filter((item) => item.selected)
      .map(({ nodeId, name }) => ({ nodeId, name }));
  }

  if (version) result.version = version;
  result.buildNumber = await getPremiereBuildNumber(version);

  return result;
}

async function getSequenceStructure(args, context) {
  const project = await getActiveProject();
  const sequence = await findSequence(project, args.sequence_id);
  const [endTime, videoTrackCount, audioTrackCount] = await Promise.all([
    sequence.getEndTime(),
    sequence.getVideoTrackCount(),
    sequence.getAudioTrackCount()
  ]);

  await context.reportProgress({
    message: "영상 트랙을 읽고 있습니다.",
    current: 0,
    total: videoTrackCount + audioTrackCount,
    percent: 0
  });

  const videoTracks = [];
  for (let trackIndex = 0; trackIndex < videoTrackCount; trackIndex += 1) {
    videoTracks.push(await readVideoTrack(sequence, trackIndex));
    await context.reportProgress({
      message: "영상 트랙을 읽고 있습니다.",
      current: trackIndex + 1,
      total: videoTrackCount + audioTrackCount,
      percent: Math.round(
        ((trackIndex + 1) / Math.max(1, videoTrackCount + audioTrackCount)) * 100
      )
    });
  }

  const audioTracks = [];
  for (let trackIndex = 0; trackIndex < audioTrackCount; trackIndex += 1) {
    audioTracks.push(await readAudioTrack(sequence, trackIndex));
    const current = videoTrackCount + trackIndex + 1;
    await context.reportProgress({
      message: "오디오 트랙을 읽고 있습니다.",
      current,
      total: videoTrackCount + audioTrackCount,
      percent: Math.round(
        (current / Math.max(1, videoTrackCount + audioTrackCount)) * 100
      )
    });
  }

  return {
    name: sequence.name,
    id: guidText(sequence.guid),
    durationSeconds: secondsOf(endTime),
    videoTrackCount: videoTracks.length,
    audioTrackCount: audioTracks.length,
    videoTracks,
    audioTracks
  };
}

module.exports = {
  category: "scripting",
  handlers: [
    {
      name: "get_premiere_state",
      validate: validateNoArgs,
      execute: getPremiereState
    },
    {
      name: "get_sequence_structure",
      validate: validateSequenceArgs,
      execute: getSequenceStructure
    }
  ]
};
