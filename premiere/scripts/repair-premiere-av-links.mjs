import {createPremiereCepSession} from "./lib/premiere-cep-session.mjs";
import {
  buildPremiereAvLinkAuditExtendScript,
  buildPremiereAvLinkBatchExtendScript,
  createPremiereAvLinkRepairPlan,
  premiereAvLinkRepairDefaults,
} from "./lib/premiere-av-link-repair.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/repair-premiere-av-links.mjs --project <name.prproj> --sequence <name> --clip-name <name> --video-track <index> --audio-track <index> --expected-pairs <count> --dry-run",
    "  node scripts/repair-premiere-av-links.mjs --project <name.prproj> --sequence <name> --clip-name <name> --video-track <index> --audio-track <index> --expected-pairs <count> --allow-write",
    "",
    "Recreates exact one-video/one-audio Premiere link groups without changing clip timing.",
    "The project is not saved.",
  ].join("\n");
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = {
    projectName: "",
    sequenceName: "",
    targetClipNames: [],
    videoTrackIndex: null,
    audioTrackIndex: null,
    expectedPairCount: null,
    batchSize: premiereAvLinkRepairDefaults.batchSize,
    timeoutMs: 180_000,
    dryRun: false,
    allowWrite: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--project") options.projectName = requireValue(argv, index++, value);
    else if (value === "--sequence") options.sequenceName = requireValue(argv, index++, value);
    else if (value === "--clip-name") options.targetClipNames.push(requireValue(argv, index++, value));
    else if (value === "--video-track") options.videoTrackIndex = Number(requireValue(argv, index++, value));
    else if (value === "--audio-track") options.audioTrackIndex = Number(requireValue(argv, index++, value));
    else if (value === "--expected-pairs") options.expectedPairCount = Number(requireValue(argv, index++, value));
    else if (value === "--batch-size") options.batchSize = Number(requireValue(argv, index++, value));
    else if (value === "--timeout-ms") options.timeoutMs = Number(requireValue(argv, index++, value));
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--allow-write") options.allowWrite = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function structureSignature(structure) {
  const tracks = [];
  for (const [kind, source] of [["video", structure.videoTracks], ["audio", structure.audioTracks]]) {
    for (const track of source || []) {
      tracks.push({
        kind,
        index: track.index,
        clips: (track.clips || []).map((clip) => ({
          name: clip.name,
          startSeconds: clip.startSeconds,
          endSeconds: clip.endSeconds,
          inPointSeconds: clip.inPointSeconds,
          outPointSeconds: clip.outPointSeconds,
          speed: clip.speed,
        })),
      });
    }
  }
  return JSON.stringify({id: structure.id, name: structure.name, durationSeconds: structure.durationSeconds, tracks});
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("--timeout-ms must be a positive integer");
  if (!options.dryRun && !options.allowWrite) throw new Error("Refusing to change clip links without --allow-write");
  const plan = createPremiereAvLinkRepairPlan(options, {batchSize: options.batchSize});
  if (options.dryRun) {
    console.log(JSON.stringify({...plan, premiereConnected: false, writeAttemptCount: 0}, null, 2));
    return;
  }

  const session = createPremiereCepSession({
    name: "deno-premiere-av-link-repair",
    tool: "repair-premiere-av-links",
    timeoutMs: options.timeoutMs,
  });
  let writeAttemptCount = 0;
  let linkedNow = 0;
  let alreadyLinked = 0;
  try {
    const beforeStructure = await session.call("get_sequence_structure", {});
    const beforeSignature = structureSignature(beforeStructure);
    const beforeAudit = await session.call("execute_extendscript", {
      code: buildPremiereAvLinkAuditExtendScript(plan),
      timeout_ms: options.timeoutMs,
    });
    if (beforeAudit.targetVideoCount !== plan.expectedPairCount || beforeAudit.targetAudioCount !== plan.expectedPairCount) {
      throw new Error(`Live pair count changed: V=${beforeAudit.targetVideoCount} A=${beforeAudit.targetAudioCount}`);
    }
    for (const batch of plan.batches) {
      writeAttemptCount++;
      const result = await session.call("execute_extendscript", {
        code: buildPremiereAvLinkBatchExtendScript(plan, batch),
        timeout_ms: options.timeoutMs,
      });
      if (result.processed !== batch.endIndex - batch.startIndex) throw new Error(`Batch ${batch.batchNumber} returned an invalid count`);
      linkedNow += result.linkedNow;
      alreadyLinked += result.alreadyLinked;
      process.stderr.write(`LINK_BATCH_COMPLETE ${batch.batchNumber}/${plan.batches.length} pairs=${batch.endIndex}/${plan.expectedPairCount}\n`);
    }
    const afterAudit = await session.call("execute_extendscript", {
      code: buildPremiereAvLinkAuditExtendScript(plan),
      timeout_ms: options.timeoutMs,
    });
    if (afterAudit.verifiedPairs !== plan.expectedPairCount || afterAudit.mismatchCount !== 0) {
      throw new Error(`Final link audit failed: ${JSON.stringify(afterAudit)}`);
    }
    const afterStructure = await session.call("get_sequence_structure", {});
    if (structureSignature(afterStructure) !== beforeSignature) throw new Error("Timeline structure changed during link repair");
    console.log(JSON.stringify({
      ok: true,
      projectName: plan.projectName,
      sequenceName: plan.sequenceName,
      targetClipNames: plan.targetClipNames,
      totalPairs: plan.expectedPairCount,
      linkedNow,
      alreadyLinked,
      verifiedPairs: afterAudit.verifiedPairs,
      mismatchCount: afterAudit.mismatchCount,
      batchCount: plan.batches.length,
      writeAttemptCount,
      projectSaved: false,
    }, null, 2));
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
