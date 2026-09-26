import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.join(os.tmpdir(), `deno-premiere-audio-proposal-${randomUUID()}`);
const resolvedTemp = `${path.resolve(os.tmpdir())}${path.sep}`.toLowerCase();
assert.ok(`${path.resolve(root)}${path.sep}`.toLowerCase().startsWith(resolvedTemp));
fs.mkdirSync(root, { recursive: true });

try {
  const mediaPath = path.join(root, "narration.wav");
  const fixtureResult = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=700:sample_rate=48000:duration=6",
      "-filter:a",
      "volume=0.08",
      "-c:a",
      "pcm_s24le",
      mediaPath,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(fixtureResult.status, 0, fixtureResult.stderr || "fixture generation failed");

  const inputPath = path.join(root, "audio-map.json");
  const outPath = path.join(root, "proposal.json");
  const reportPath = path.join(root, "proposal.md");
  fs.writeFileSync(
    inputPath,
    `${JSON.stringify(
      {
        projectName: "fixture.prproj",
        projectPath: "C:\\fixtures\\fixture.prproj",
        sequenceName: "DENO_AUDIO_SOURCE_GROUP_TEST",
        sequenceId: "sequence-source-group",
        audioTimeline: [
          {
            trackIndex: 0,
            clipIndex: 0,
            nodeId: "a",
            name: "narration-a",
            startSeconds: 0,
            endSeconds: 2,
            inPointSeconds: 0,
            outPointSeconds: 2,
            mediaPath,
            projectItemNodeId: "project-item-a",
            volumeLevelRaw: 0.177827941,
          },
          {
            trackIndex: 0,
            clipIndex: 1,
            nodeId: "b",
            name: "narration-b",
            startSeconds: 3,
            endSeconds: 5,
            inPointSeconds: 3,
            outPointSeconds: 5,
            mediaPath,
            projectItemNodeId: "project-item-a",
            volumeLevelRaw: 0.125892541,
          },
          {
            trackIndex: 0,
            clipIndex: 2,
            nodeId: "short",
            name: "narration-short",
            startSeconds: 5.8,
            endSeconds: 5.9,
            inPointSeconds: 5.8,
            outPointSeconds: 5.9,
            mediaPath,
            projectItemNodeId: "project-item-a",
            volumeLevelRaw: 0.177827941,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const proposalResult = spawnSync(
    process.execPath,
    [
      path.resolve("scripts/propose-premiere-audio-balance.mjs"),
      "--input",
      inputPath,
      "--out",
      outPath,
      "--report",
      reportPath,
      "--target-lufs",
      "-23",
    ],
    { cwd: path.resolve("."), encoding: "utf8", windowsHide: true },
  );
  assert.equal(proposalResult.status, 0, proposalResult.stderr || proposalResult.stdout);
  const proposal = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(proposal.schemaVersion, 2);
  assert.equal(proposal.complete, true);
  assert.equal(proposal.writeEligible, true);
  assert.equal(proposal.scope.sourceGroupsCompleteAcrossAudioMap, true);
  assert.equal(proposal.projectPath, "C:\\fixtures\\fixture.prproj");
  assert.equal(proposal.sequenceId, "sequence-source-group");
  assert.equal(proposal.summary.sourceGroupCount, 1);
  assert.equal(proposal.sourceGroups.length, 1);
  assert.equal(proposal.adjustments.length, 3);
  assert.equal(proposal.adjustments[0].sourceGroupKey, proposal.adjustments[1].sourceGroupKey);
  assert.equal(proposal.adjustments[1].sourceGroupKey, proposal.adjustments[2].sourceGroupKey);
  assert.equal(proposal.adjustments[0].finalDisplayDb, proposal.adjustments[1].finalDisplayDb);
  assert.equal(proposal.adjustments[1].finalDisplayDb, proposal.adjustments[2].finalDisplayDb);
  assert.equal(proposal.adjustments[0].newRaw, proposal.adjustments[1].newRaw);
  assert.equal(proposal.adjustments[1].newRaw, proposal.adjustments[2].newRaw);
  assert.equal(proposal.adjustments[0].shouldApply, true);
  assert.equal(proposal.adjustments[1].shouldApply, true);
  assert.equal(proposal.adjustments[2].shouldApply, true);
  assert.equal(proposal.sourceGroups[0].audioMapClipCount, 3);
  assert.equal(proposal.sourceGroups[0].scopeComplete, true);
  assert.ok(fs.existsSync(reportPath));

  const crossTrackMap = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  crossTrackMap.audioTimeline.push({
    ...crossTrackMap.audioTimeline[0],
    trackIndex: 1,
    clipIndex: 0,
    nodeId: "same-source-on-a2",
    name: "narration-on-a2",
  });
  const crossTrackInput = path.join(root, "audio-map-cross-track.json");
  const crossTrackOut = path.join(root, "proposal-cross-track.json");
  fs.writeFileSync(crossTrackInput, `${JSON.stringify(crossTrackMap, null, 2)}\n`, "utf8");
  const crossTrackResult = spawnSync(
    process.execPath,
    [
      path.resolve("scripts/propose-premiere-audio-balance.mjs"),
      "--input",
      crossTrackInput,
      "--out",
      crossTrackOut,
      "--report",
      path.join(root, "proposal-cross-track.md"),
    ],
    { cwd: path.resolve("."), encoding: "utf8", windowsHide: true },
  );
  assert.equal(crossTrackResult.status, 0, crossTrackResult.stderr || crossTrackResult.stdout);
  const crossTrackProposal = JSON.parse(fs.readFileSync(crossTrackOut, "utf8"));
  assert.equal(crossTrackProposal.complete, true);
  assert.equal(crossTrackProposal.writeEligible, false);
  assert.equal(crossTrackProposal.scope.sourceGroupsCompleteAcrossAudioMap, false);
  assert.equal(crossTrackProposal.sourceGroups[0].audioMapClipCount, 4);
  assert.equal(crossTrackProposal.sourceGroups[0].scopeComplete, false);
  assert.match(crossTrackProposal.writeIneligibleReasons.join(" "), /audio map but this proposal covers/i);

  const idempotentMap = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  for (const clip of idempotentMap.audioTimeline) {
    const adjustment = proposal.adjustments.find((item) => item.nodeId === clip.nodeId);
    clip.volumeLevelRaw = adjustment.newRaw;
  }
  const idempotentInput = path.join(root, "audio-map-idempotent.json");
  const idempotentOut = path.join(root, "proposal-idempotent.json");
  const idempotentReport = path.join(root, "proposal-idempotent.md");
  fs.writeFileSync(idempotentInput, `${JSON.stringify(idempotentMap, null, 2)}\n`, "utf8");
  const idempotentResult = spawnSync(
    process.execPath,
    [
      path.resolve("scripts/propose-premiere-audio-balance.mjs"),
      "--input",
      idempotentInput,
      "--out",
      idempotentOut,
      "--report",
      idempotentReport,
    ],
    { cwd: path.resolve("."), encoding: "utf8", windowsHide: true },
  );
  assert.equal(idempotentResult.status, 0, idempotentResult.stderr || idempotentResult.stdout);
  const idempotentProposal = JSON.parse(fs.readFileSync(idempotentOut, "utf8"));
  assert.equal(idempotentProposal.summary.applyCount, 0);

  const limitedOut = path.join(root, "proposal-limited.json");
  const limitedResult = spawnSync(
    process.execPath,
    [
      path.resolve("scripts/propose-premiere-audio-balance.mjs"),
      "--input",
      inputPath,
      "--out",
      limitedOut,
      "--report",
      path.join(root, "proposal-limited.md"),
      "--limit",
      "1",
    ],
    { cwd: path.resolve("."), encoding: "utf8", windowsHide: true },
  );
  assert.equal(limitedResult.status, 0, limitedResult.stderr || limitedResult.stdout);
  const limitedProposal = JSON.parse(fs.readFileSync(limitedOut, "utf8"));
  assert.equal(limitedProposal.complete, true);
  assert.equal(limitedProposal.writeEligible, false);
  assert.equal(limitedProposal.scope.limited, true);
  assert.match(limitedProposal.writeIneligibleReasons.join(" "), /--limit/);

  const incompleteMap = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  incompleteMap.audioTimeline.push({
    ...incompleteMap.audioTimeline[0],
    clipIndex: 3,
    nodeId: "missing",
    name: "missing-media",
    startSeconds: 6,
    endSeconds: 8,
    mediaPath: path.join(root, "missing.wav"),
  });
  const incompleteInput = path.join(root, "audio-map-incomplete.json");
  const incompleteOut = path.join(root, "proposal-incomplete.json");
  fs.writeFileSync(incompleteInput, `${JSON.stringify(incompleteMap, null, 2)}\n`, "utf8");
  const incompleteResult = spawnSync(
    process.execPath,
    [
      path.resolve("scripts/propose-premiere-audio-balance.mjs"),
      "--input",
      incompleteInput,
      "--out",
      incompleteOut,
      "--report",
      path.join(root, "proposal-incomplete.md"),
    ],
    { cwd: path.resolve("."), encoding: "utf8", windowsHide: true },
  );
  assert.notEqual(incompleteResult.status, 0);
  assert.match(incompleteResult.stderr, /proposal is incomplete/i);
  assert.equal(fs.existsSync(incompleteOut), false);

  const noMatchOut = path.join(root, "proposal-no-match.json");
  const noMatchResult = spawnSync(
    process.execPath,
    [
      path.resolve("scripts/propose-premiere-audio-balance.mjs"),
      "--input",
      inputPath,
      "--out",
      noMatchOut,
      "--report",
      path.join(root, "proposal-no-match.md"),
      "--include-pattern",
      "does-not-match-anything",
    ],
    { cwd: path.resolve("."), encoding: "utf8", windowsHide: true },
  );
  assert.notEqual(noMatchResult.status, 0);
  assert.match(noMatchResult.stderr, /No audio clips matched/);
  assert.equal(fs.existsSync(noMatchOut), false);

  const missingIdentityMap = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  delete missingIdentityMap.sequenceId;
  const missingIdentityInput = path.join(root, "audio-map-missing-identity.json");
  const missingIdentityOut = path.join(root, "proposal-missing-identity.json");
  fs.writeFileSync(
    missingIdentityInput,
    `${JSON.stringify(missingIdentityMap, null, 2)}\n`,
    "utf8",
  );
  const missingIdentityResult = spawnSync(
    process.execPath,
    [
      path.resolve("scripts/propose-premiere-audio-balance.mjs"),
      "--input",
      missingIdentityInput,
      "--out",
      missingIdentityOut,
      "--report",
      path.join(root, "proposal-missing-identity.md"),
    ],
    { cwd: path.resolve("."), encoding: "utf8", windowsHide: true },
  );
  assert.notEqual(missingIdentityResult.status, 0);
  assert.match(missingIdentityResult.stderr, /sequenceId is required/i);
  assert.equal(fs.existsSync(missingIdentityOut), false);

  const duplicateNodeMap = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  duplicateNodeMap.audioTimeline[1].nodeId = duplicateNodeMap.audioTimeline[0].nodeId;
  const duplicateNodeInput = path.join(root, "audio-map-duplicate-node.json");
  const duplicateNodeOut = path.join(root, "proposal-duplicate-node.json");
  fs.writeFileSync(
    duplicateNodeInput,
    `${JSON.stringify(duplicateNodeMap, null, 2)}\n`,
    "utf8",
  );
  const duplicateNodeResult = spawnSync(
    process.execPath,
    [
      path.resolve("scripts/propose-premiere-audio-balance.mjs"),
      "--input",
      duplicateNodeInput,
      "--out",
      duplicateNodeOut,
      "--report",
      path.join(root, "proposal-duplicate-node.md"),
    ],
    { cwd: path.resolve("."), encoding: "utf8", windowsHide: true },
  );
  assert.notEqual(duplicateNodeResult.status, 0);
  assert.match(duplicateNodeResult.stderr, /duplicate clip nodeId/i);
  assert.equal(fs.existsSync(duplicateNodeOut), false);

  const hotMediaPath = path.join(root, "hot-float.wav");
  const hotFixtureResult = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc=4*sin(2*PI*1000*t):s=48000:d=2",
      "-c:a",
      "pcm_f32le",
      hotMediaPath,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(hotFixtureResult.status, 0, hotFixtureResult.stderr || "hot fixture failed");
  const hotInput = path.join(root, "audio-map-hot.json");
  const hotOut = path.join(root, "proposal-hot.json");
  fs.writeFileSync(
    hotInput,
    `${JSON.stringify(
      {
        projectName: "fixture.prproj",
        projectPath: "C:\\fixtures\\fixture.prproj",
        sequenceName: "DENO_AUDIO_PEAK_GATE_TEST",
        sequenceId: "sequence-peak-gate",
        audioTimeline: [
          {
            trackIndex: 0,
            clipIndex: 0,
            nodeId: "hot",
            name: "hot-float",
            startSeconds: 0,
            endSeconds: 2,
            inPointSeconds: 0,
            outPointSeconds: 2,
            mediaPath: hotMediaPath,
            projectItemNodeId: "hot-item",
            volumeLevelRaw: 0.177827941,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const hotResult = spawnSync(
    process.execPath,
    [
      path.resolve("scripts/propose-premiere-audio-balance.mjs"),
      "--input",
      hotInput,
      "--out",
      hotOut,
      "--report",
      path.join(root, "proposal-hot.md"),
      "--max-cut-db",
      "10",
    ],
    { cwd: path.resolve("."), encoding: "utf8", windowsHide: true },
  );
  assert.notEqual(hotResult.status, 0);
  assert.match(hotResult.stderr, /True-peak safety requires/);
  assert.equal(fs.existsSync(hotOut), false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("Premiere audio source-group proposal self-test passed.");
