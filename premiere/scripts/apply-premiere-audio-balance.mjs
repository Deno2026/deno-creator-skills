import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  normalizeSequenceStructureStrict,
  resolveFrameTiming,
} from "./lib/sequence-structure-diff.mjs";
import {
  partitionPremiereMicroBatches,
  resolvePremiereBatchSize,
  waitForPremiereUi,
} from "./lib/premiere-micro-batch.mjs";
import { createPremiereCepSession } from "./lib/premiere-cep-session.mjs";

export const AUDIO_BALANCE_PROPOSAL_SCHEMA_VERSION = 2;
export const AUDIO_BALANCE_DEFAULT_BATCH_SIZE = 20;
export const AUDIO_BALANCE_MAX_BATCH_SIZE = 20;
// Compatibility field for result consumers. Level-only writes do not sleep
// between healthy batches; a UI yield is used only when the IO response
// explicitly reports observed backpressure.
export const AUDIO_BALANCE_BATCH_PAUSE_MS = 0;
export const AUDIO_BALANCE_BACKPRESSURE_YIELD_MS = 250;

const DEFAULT_PROPOSAL = "tmp/premiere-audio-balance/audio-balance-proposal-target20-max12.json";
const RAW_TOLERANCE = 0.000001;
const TIME_TOLERANCE_SECONDS = 0.0005;

function fail(message) {
  throw new Error(message);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function finitePositive(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function normalizeWindowsPath(value) {
  return String(value ?? "").trim().replaceAll("/", "\\").toLowerCase();
}

function sameProjectPath(left, right) {
  return normalizeWindowsPath(left) === normalizeWindowsPath(right);
}

function serializeError(error) {
  if (!error) return null;
  return {
    name: error.name || "Error",
    message: error.message || String(error),
    code: error.code ?? null,
  };
}

export function parseArgs(argv) {
  const options = {
    proposal: DEFAULT_PROPOSAL,
    dryRun: false,
    maxItems: 0,
    batchSize: AUDIO_BALANCE_DEFAULT_BATCH_SIZE,
  };
  const requestedBatchSizes = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--proposal") options.proposal = argv[++index];
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--max-items") options.maxItems = Number(argv[++index]);
    else if (value === "--chunk-size" || value === "--batch-size") {
      const requested = argv[++index];
      if (requested === undefined) throw new Error(`${value} requires a value.`);
      requestedBatchSizes.push({ flag: value, value: requested });
    }
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }

  if (!Number.isInteger(options.maxItems) || options.maxItems < 0) {
    throw new Error("--max-items must be a non-negative integer.");
  }
  if (requestedBatchSizes.length > 1) {
    const distinct = new Set(requestedBatchSizes.map((entry) => Number(entry.value)));
    if (distinct.size > 1) {
      throw new Error("--batch-size and --chunk-size must not specify different values.");
    }
  }
  options.batchSize = resolvePremiereBatchSize(requestedBatchSizes[0]?.value, {
    defaultSize: AUDIO_BALANCE_DEFAULT_BATCH_SIZE,
    hardMaximum: AUDIO_BALANCE_MAX_BATCH_SIZE,
    label: requestedBatchSizes[0]?.flag || "Level batch size",
  });
  // Compatibility field for callers that still inspect the former option name.
  options.chunkSize = options.batchSize;
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/apply-premiere-audio-balance.mjs --proposal <proposal.json> [--dry-run]",
    "",
    "Applies a complete schemaVersion 2 proposal to the exact project path and sequence ID.",
    "This changes the open project state but does not save the project.",
    "--max-items is dry-run only; a real write always includes every selected source group.",
    "--batch-size controls serial Level micro-batches (default and hard maximum 20).",
    "--chunk-size is a compatibility alias for --batch-size.",
    "The run captures full sequence structure once before writes and once after all writes.",
    "Each real batch gets exact target identity/current-Level preflight, one write, and Level read-back.",
    "Healthy batches continue immediately; UI yield happens only after observed backpressure.",
    "A timeout, missing response, read failure, identity/Level drift, or structural change stops the run.",
    "Writes are never retried or resent. Dry-run submits zero writes.",
  ].join("\n");
}

function hostPayload(changes) {
  return changes.map((item) => ({
    nodeId: String(item.nodeId),
    trackIndex: Number(item.trackIndex),
    clipIndex: Number(item.clipIndex),
    name: String(item.name),
    startSeconds: Number(item.startSeconds),
    endSeconds: Number(item.endSeconds),
    currentRaw: Number(item.currentRaw),
    newRaw: Number(item.newRaw),
    gainDb: Number(item.gainDb),
    finalDisplayDb: Number(item.finalDisplayDb),
  }));
}

function buildHostPrelude(changes, expected) {
  return `
var changes = ${JSON.stringify(hostPayload(changes))};
var expectedProject = ${JSON.stringify(expected.projectName)};
var expectedProjectPath = ${JSON.stringify(expected.projectPath)};
var expectedSequence = ${JSON.stringify(expected.sequenceName)};
var expectedSequenceId = ${JSON.stringify(expected.sequenceId)};
var rawTolerance = ${RAW_TOLERANCE};
var timeTolerance = ${TIME_TOLERANCE_SECONDS};

var seq = app.project.activeSequence;
if (!seq) return __error("No active sequence");

function abs(n) { return n < 0 ? -n : n; }
function normalizedPath(value) {
  return String(value || "").toLowerCase().split("/").join(${JSON.stringify("\\")});
}
function identityPayload() {
  return {
    projectName: String(app.project.name || ""),
    projectPath: String(app.project.path || ""),
    sequenceName: String(seq.name || ""),
    sequenceId: String(seq.sequenceID || "")
  };
}
if (String(app.project.name || "") !== expectedProject ||
    normalizedPath(app.project.path) !== normalizedPath(expectedProjectPath)) {
  return __error("Active project identity changed after audio-balance preflight");
}
if (String(seq.name || "") !== expectedSequence ||
    String(seq.sequenceID || "") !== expectedSequenceId) {
  return __error("Active sequence identity changed after audio-balance preflight");
}

function isVolumeComponent(comp) {
  var name = String(comp.displayName || "");
  var matchName = String(comp.matchName || "");
  return name === "볼륨" || name === "Volume" || matchName.indexOf("Volume") >= 0;
}
function isLevelProperty(prop, index) {
  var name = String(prop.displayName || "");
  return name === "레벨" || name === "Level" || index === 1;
}
function inspectChange(change, expectedRaw) {
  var found = __findClip(change.nodeId);
  if (!found || !found.clip) {
    return { ok: false, nodeId: change.nodeId, reason: "clip not found" };
  }
  if (String(found.trackType) !== "audio") {
    return { ok: false, nodeId: change.nodeId, reason: "not an audio clip" };
  }
  var clip = found.clip;
  var actual = {
    nodeId: String(clip.nodeId || ""),
    trackIndex: Number(found.trackIndex),
    clipIndex: Number(found.clipIndex),
    name: String(clip.name || ""),
    startSeconds: Number(__ticksToSeconds(clip.start.ticks)),
    endSeconds: Number(__ticksToSeconds(clip.end.ticks))
  };
  if (actual.nodeId !== String(change.nodeId)) {
    return { ok: false, nodeId: change.nodeId, reason: "nodeId mismatch", actual: actual };
  }
  if (actual.trackIndex !== Number(change.trackIndex) || actual.clipIndex !== Number(change.clipIndex)) {
    return { ok: false, nodeId: change.nodeId, reason: "track/clip index mismatch", actual: actual };
  }
  if (actual.name !== String(change.name)) {
    return { ok: false, nodeId: change.nodeId, reason: "clip name mismatch", actual: actual };
  }
  if (abs(actual.startSeconds - Number(change.startSeconds)) > timeTolerance ||
      abs(actual.endSeconds - Number(change.endSeconds)) > timeTolerance) {
    return { ok: false, nodeId: change.nodeId, reason: "clip timing mismatch", actual: actual };
  }

  var prop = null;
  var propName = "";
  var compName = "";
  for (var c = 0; c < clip.components.numItems; c++) {
    var comp = clip.components[c];
    if (!isVolumeComponent(comp)) continue;
    compName = String(comp.displayName || "");
    for (var p = 0; p < comp.properties.numItems; p++) {
      var candidate = comp.properties[p];
      if (isLevelProperty(candidate, p)) {
        prop = candidate;
        propName = String(candidate.displayName || "");
        break;
      }
    }
    if (prop) break;
  }
  if (!prop) {
    return { ok: false, nodeId: change.nodeId, reason: "Volume Level property not found", actual: actual };
  }
  actual.currentRaw = Number(prop.getValue());
  actual.component = compName;
  actual.property = propName;
  if (abs(actual.currentRaw - Number(expectedRaw)) >= rawTolerance) {
    return { ok: false, nodeId: change.nodeId, reason: "Level raw mismatch", actual: actual };
  }
  return { ok: true, change: change, clip: clip, prop: prop, actual: actual };
}
function publicTarget(inspected) {
  return {
    nodeId: inspected.actual.nodeId,
    trackIndex: inspected.actual.trackIndex,
    clipIndex: inspected.actual.clipIndex,
    name: inspected.actual.name,
    startSeconds: inspected.actual.startSeconds,
    endSeconds: inspected.actual.endSeconds,
    currentRaw: inspected.actual.currentRaw,
    component: inspected.actual.component,
    property: inspected.actual.property
  };
}
`;
}

export function buildLevelReadCode(changes, expected, rawField = "currentRaw") {
  if (rawField !== "currentRaw" && rawField !== "newRaw") {
    throw new Error(`Unsupported Level read field: ${rawField}`);
  }
  return `${buildHostPrelude(changes, expected)}
var expectedRawField = ${JSON.stringify(rawField)};
var targets = [];
var failed = [];
for (var i = 0; i < changes.length; i++) {
  try {
    var inspected = inspectChange(changes[i], changes[i][expectedRawField]);
    if (!inspected.ok) failed.push(inspected);
    else targets.push(publicTarget(inspected));
  } catch (e) {
    failed.push({ nodeId: changes[i].nodeId, reason: String(e) });
  }
}
return __result({
  phase: "level-read",
  identity: identityPayload(),
  requested: changes.length,
  targets: targets,
  failed: failed
});
`;
}

export function buildLevelWriteCode(changes, expected) {
  return `${buildHostPrelude(changes, expected)}
var resolved = [];
var failed = [];
var updated = [];
var touched = [];

function rollbackTouched() {
  var rollbackItems = [];
  var rollbackComplete = true;
  for (var r = touched.length - 1; r >= 0; r--) {
    var entry = touched[r];
    try {
      entry.prop.setValue(Number(entry.before), true);
      var restored = Number(entry.prop.getValue());
      var matched = abs(restored - Number(entry.before)) < rawTolerance;
      if (!matched) rollbackComplete = false;
      rollbackItems.push({
        nodeId: entry.nodeId,
        target: entry.before,
        actual: restored,
        matched: matched
      });
    } catch (rollbackError) {
      rollbackComplete = false;
      rollbackItems.push({ nodeId: entry.nodeId, reason: String(rollbackError), matched: false });
    }
  }
  return { complete: rollbackComplete, items: rollbackItems };
}

// Phase 1: every target must match the proposal before any setValue call.
for (var i = 0; i < changes.length; i++) {
  try {
    var inspected = inspectChange(changes[i], changes[i].currentRaw);
    if (!inspected.ok) failed.push(inspected);
    else resolved.push(inspected);
  } catch (e) {
    failed.push({ nodeId: changes[i].nodeId, reason: String(e) });
  }
}
if (failed.length > 0 || resolved.length !== changes.length) {
  return __result({
    phase: "write-preflight-rejected",
    identity: identityPayload(),
    requested: changes.length,
    updated: [],
    failed: failed,
    rollback: { complete: true, items: [] }
  });
}

// Phase 2: re-resolve each target immediately before setValue. A rare setter
// failure triggers a best-effort rollback and remains a failed write response;
// the independent post-read still decides the externally observed state.
for (var w = 0; w < changes.length; w++) {
  var change = changes[w];
  var immediate;
  try {
    immediate = inspectChange(change, change.currentRaw);
    if (!immediate.ok) {
      var driftRollback = rollbackTouched();
      return __result({
        phase: "set-preflight-rejected",
        identity: identityPayload(),
        requested: changes.length,
        updated: updated,
        failed: [immediate],
        rollback: driftRollback
      });
    }
    touched.push({ nodeId: change.nodeId, prop: immediate.prop, before: immediate.actual.currentRaw });
    immediate.prop.setValue(Number(change.newRaw), true);
    var after = Number(immediate.prop.getValue());
    var matched = abs(after - Number(change.newRaw)) < rawTolerance;
    updated.push({
      nodeId: change.nodeId,
      name: change.name,
      before: immediate.actual.currentRaw,
      after: after,
      target: change.newRaw,
      matched: matched,
      component: immediate.actual.component,
      property: immediate.actual.property,
      gainDb: change.gainDb,
      finalDisplayDb: change.finalDisplayDb
    });
    if (!matched) throw new Error("immediate Level readback mismatch");
  } catch (writeFailure) {
    var writeRollback = rollbackTouched();
    return __result({
      phase: "write-failed",
      identity: identityPayload(),
      requested: changes.length,
      updated: updated,
      failed: [{ nodeId: change.nodeId, reason: String(writeFailure) }],
      rollback: writeRollback
    });
  }
}

return __result({
  phase: "written",
  identity: identityPayload(),
  requested: changes.length,
  updated: updated,
  failed: [],
  rollback: null
});
`;
}

async function captureStructuralSnapshot(session) {
  const state = await session.call("get_premiere_state");
  const summary = await session.call("get_timeline_summary");
  const structure = await session.call("get_sequence_structure");
  if (
    !state?.project?.name ||
    !state?.project?.path ||
    !summary?.name ||
    !structure?.name ||
    !String(structure?.id ?? "")
  ) {
    throw new Error("Premiere structural pre/post read returned incomplete project or sequence identity.");
  }
  if (
    String(summary.name) !== String(structure.name) ||
    String(summary.id ?? "") !== String(structure.id ?? "")
  ) {
    throw new Error("Premiere timeline summary and structure identify different sequences.");
  }
  const timing = resolveFrameTiming({
    ticksPerFrame: summary.frameRate?.ticks,
    frameDurationSeconds: Number(summary.frameRate?.seconds),
  });
  return {
    projectName: String(state.project.name),
    projectPath: String(state.project.path),
    sequenceName: String(structure.name),
    sequenceId: String(structure.id),
    normalized: normalizeSequenceStructureStrict(structure, timing),
  };
}

export function validateProposalDocument(proposal, options = {}) {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
    fail("Audio-balance proposal must be a JSON object.");
  }
  if (proposal.schemaVersion !== AUDIO_BALANCE_PROPOSAL_SCHEMA_VERSION) {
    fail(
      `Audio-balance proposal schemaVersion must be ${AUDIO_BALANCE_PROPOSAL_SCHEMA_VERSION}; regenerate legacy proposals.`,
    );
  }
  if (proposal.complete !== true) {
    fail("Audio-balance proposal complete must be exactly true.");
  }
  for (const field of ["projectName", "projectPath", "sequenceName", "sequenceId"]) {
    if (!nonEmptyString(proposal[field])) {
      fail(`Audio-balance proposal ${field} is required; identity-incomplete proposals fail closed.`);
    }
  }
  if (typeof proposal.writeEligible !== "boolean") {
    fail("Audio-balance proposal writeEligible must be an explicit boolean.");
  }
  if (!Array.isArray(proposal.writeIneligibleReasons)) {
    fail("Audio-balance proposal writeIneligibleReasons must be an array.");
  }
  if (!proposal.scope || typeof proposal.scope !== "object") {
    fail("Audio-balance proposal scope is required.");
  }
  if (typeof proposal.scope.limited !== "boolean") {
    fail("Audio-balance proposal scope.limited must be a boolean.");
  }
  if (typeof proposal.scope.sourceGroupsCompleteAcrossAudioMap !== "boolean") {
    fail("Audio-balance proposal scope.sourceGroupsCompleteAcrossAudioMap must be a boolean.");
  }
  const internallyWriteEligible =
    proposal.writeIneligibleReasons.length === 0 &&
    proposal.scope.limited === false &&
    proposal.scope.sourceGroupsCompleteAcrossAudioMap === true &&
    Number(proposal.options?.limit ?? 0) === 0 &&
    !(proposal.options?.groupBy === "source" &&
      (proposal.options?.includePattern || proposal.options?.excludePattern));
  if (proposal.writeEligible !== internallyWriteEligible) {
    fail("Proposal writeEligible contradicts its options, scope, or ineligibility reasons.");
  }
  if (!options.dryRun && proposal.writeEligible !== true) {
    const reasons = Array.isArray(proposal.writeIneligibleReasons)
      ? ` (${proposal.writeIneligibleReasons.join("; ")})`
      : "";
    fail(`Proposal scope is not eligible for a real write${reasons}.`);
  }
  if (!options.dryRun && Number(options.maxItems) > 0) {
    fail("--max-items is dry-run only; partial real writes are forbidden.");
  }
  if (!Array.isArray(proposal.adjustments)) {
    fail("Audio-balance proposal adjustments must be an array.");
  }
  if (!Array.isArray(proposal.sourceGroups)) {
    fail("Audio-balance proposal sourceGroups must be an array.");
  }
  if (!Array.isArray(proposal.failures) || proposal.failures.length !== 0) {
    fail("A complete audio-balance proposal must contain an empty failures array.");
  }
  if (!proposal.summary || typeof proposal.summary !== "object") {
    fail("Audio-balance proposal summary is required.");
  }

  const nodeIds = new Set();
  const grouped = new Map();
  for (let index = 0; index < proposal.adjustments.length; index += 1) {
    const item = proposal.adjustments[index];
    const label = `adjustments[${index}]`;
    if (!item || typeof item !== "object") fail(`${label} must be an object.`);
    if (!nonEmptyString(item.nodeId)) fail(`${label}.nodeId must be a non-empty string.`);
    if (nodeIds.has(String(item.nodeId))) {
      fail(`Duplicate adjustment nodeId is forbidden: ${item.nodeId}.`);
    }
    nodeIds.add(String(item.nodeId));
    for (const field of ["trackIndex", "clipIndex"]) {
      if (!Number.isInteger(Number(item[field])) || Number(item[field]) < 0) {
        fail(`${label}.${field} must be a non-negative integer.`);
      }
    }
    if (!nonEmptyString(item.name)) fail(`${label}.name must be a non-empty string.`);
    if (!Number.isFinite(Number(item.startSeconds)) || !Number.isFinite(Number(item.endSeconds))) {
      fail(`${label} startSeconds/endSeconds must be finite.`);
    }
    if (Number(item.endSeconds) <= Number(item.startSeconds)) {
      fail(`${label}.endSeconds must be greater than startSeconds.`);
    }
    if (!finitePositive(item.currentRaw) || !finitePositive(item.newRaw)) {
      fail(`${label} currentRaw/newRaw must be finite and greater than zero.`);
    }
    if (typeof item.shouldApply !== "boolean") {
      fail(`${label}.shouldApply must be a boolean.`);
    }
    if (!nonEmptyString(item.sourceGroupKey)) {
      fail(`${label}.sourceGroupKey must be a non-empty string.`);
    }
    if (!Number.isInteger(Number(item.sourceGroupClipCount)) || Number(item.sourceGroupClipCount) < 1) {
      fail(`${label}.sourceGroupClipCount must be a positive integer.`);
    }
    const key = String(item.sourceGroupKey);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }

  const metadata = new Map();
  for (let index = 0; index < proposal.sourceGroups.length; index += 1) {
    const group = proposal.sourceGroups[index];
    if (!group || !nonEmptyString(group.sourceGroupKey)) {
      fail(`sourceGroups[${index}].sourceGroupKey must be a non-empty string.`);
    }
    const key = String(group.sourceGroupKey);
    if (metadata.has(key)) fail(`Duplicate sourceGroups entry: ${key}.`);
    if (!Number.isInteger(Number(group.clipCount)) || Number(group.clipCount) < 1) {
      fail(`sourceGroups[${index}].clipCount must be a positive integer.`);
    }
    if (typeof group.shouldApply !== "boolean") {
      fail(`sourceGroups[${index}].shouldApply must be a boolean.`);
    }
    if (!Number.isInteger(Number(group.audioMapClipCount)) || Number(group.audioMapClipCount) < 1) {
      fail(`sourceGroups[${index}].audioMapClipCount must be a positive integer.`);
    }
    if (typeof group.scopeComplete !== "boolean") {
      fail(`sourceGroups[${index}].scopeComplete must be a boolean.`);
    }
    metadata.set(key, group);
  }

  for (const [key, items] of grouped) {
    const declaredCounts = new Set(items.map((item) => Number(item.sourceGroupClipCount)));
    if (declaredCounts.size !== 1 || !declaredCounts.has(items.length)) {
      fail(`Source group ${key} is incomplete in adjustments.`);
    }
    const groupMetadata = metadata.get(key);
    if (!groupMetadata || Number(groupMetadata.clipCount) !== items.length) {
      fail(`Source group ${key} metadata does not cover every adjustment.`);
    }
    const applyStates = new Set(items.map((item) => item.shouldApply));
    if (applyStates.size !== 1) {
      fail(`Source group ${key} mixes shouldApply states; partial source-group writes are forbidden.`);
    }
    if (groupMetadata.shouldApply !== items[0].shouldApply) {
      fail(`Source group ${key} metadata shouldApply disagrees with its adjustments.`);
    }
    if (
      groupMetadata.scopeComplete !== (Number(groupMetadata.audioMapClipCount) === items.length)
    ) {
      fail(`Source group ${key} scopeComplete contradicts audioMapClipCount.`);
    }
    if (proposal.writeEligible && !groupMetadata.scopeComplete) {
      fail(`Source group ${key} is incomplete across the exported audio map.`);
    }
  }
  for (const key of metadata.keys()) {
    if (!grouped.has(key)) fail(`Source group ${key} has metadata but no adjustments.`);
  }

  const selected = proposal.adjustments.filter((item) => item.shouldApply === true);
  if (Number(proposal.summary.applyCount) !== selected.length) {
    fail("Proposal summary.applyCount does not match selected adjustments.");
  }
  if (Number(proposal.summary.analyzedCount) !== proposal.adjustments.length) {
    fail("Proposal summary.analyzedCount does not match adjustments.");
  }
  return {
    adjustments: proposal.adjustments,
    selected,
  };
}

export function validateLiveIdentity(proposal, snapshot) {
  const failures = [];
  if (String(proposal.projectName) !== String(snapshot.projectName)) {
    failures.push({ field: "projectName", expected: proposal.projectName, actual: snapshot.projectName });
  }
  if (!sameProjectPath(proposal.projectPath, snapshot.projectPath)) {
    failures.push({ field: "projectPath", expected: proposal.projectPath, actual: snapshot.projectPath });
  }
  if (String(proposal.sequenceName) !== String(snapshot.sequenceName)) {
    failures.push({ field: "sequenceName", expected: proposal.sequenceName, actual: snapshot.sequenceName });
  }
  if (String(proposal.sequenceId) !== String(snapshot.sequenceId)) {
    failures.push({ field: "sequenceId", expected: proposal.sequenceId, actual: snapshot.sequenceId });
  }
  return { ok: failures.length === 0, failures };
}

export function validateTargetRead(changes, readResult, expectedIdentity, rawField = "currentRaw") {
  const failures = [];
  if (!readResult || typeof readResult !== "object") {
    return { ok: false, failures: [{ kind: "invalid_read", reason: "missing Level read result" }] };
  }
  const identity = validateLiveIdentity(expectedIdentity, readResult.identity || {});
  for (const failure of identity.failures) failures.push({ kind: "identity_mismatch", ...failure });
  if (Array.isArray(readResult.failed) && readResult.failed.length > 0) {
    failures.push(...readResult.failed.map((item) => ({ kind: "host_preflight_failed", ...item })));
  }
  const targets = Array.isArray(readResult.targets) ? readResult.targets : [];
  const byNodeId = new Map();
  for (const target of targets) {
    const key = String(target?.nodeId ?? "");
    if (!key || byNodeId.has(key)) {
      failures.push({ kind: "duplicate_or_missing_read_nodeId", nodeId: key });
      continue;
    }
    byNodeId.set(key, target);
  }
  if (targets.length !== changes.length) {
    failures.push({ kind: "target_count_mismatch", expected: changes.length, actual: targets.length });
  }
  for (const change of changes) {
    const target = byNodeId.get(String(change.nodeId));
    if (!target) {
      failures.push({ kind: "target_missing", nodeId: change.nodeId });
      continue;
    }
    for (const field of ["trackIndex", "clipIndex"]) {
      if (Number(target[field]) !== Number(change[field])) {
        failures.push({
          kind: `${field}_mismatch`,
          nodeId: change.nodeId,
          expected: Number(change[field]),
          actual: Number(target[field]),
        });
      }
    }
    if (String(target.name) !== String(change.name)) {
      failures.push({ kind: "name_mismatch", nodeId: change.nodeId, expected: change.name, actual: target.name });
    }
    for (const field of ["startSeconds", "endSeconds"]) {
      if (
        !Number.isFinite(Number(target[field])) ||
        Math.abs(Number(target[field]) - Number(change[field])) > TIME_TOLERANCE_SECONDS
      ) {
        failures.push({
          kind: `${field}_mismatch`,
          nodeId: change.nodeId,
          expected: Number(change[field]),
          actual: Number(target[field]),
        });
      }
    }
    const expectedRaw = Number(change[rawField]);
    if (
      !Number.isFinite(Number(target.currentRaw)) ||
      Math.abs(Number(target.currentRaw) - expectedRaw) >= RAW_TOLERANCE
    ) {
      failures.push({
        kind: "level_mismatch",
        nodeId: change.nodeId,
        expectedField: rawField,
        expected: expectedRaw,
        actual: Number(target.currentRaw),
      });
    }
  }
  return {
    ok: failures.length === 0,
    expectedCount: changes.length,
    observedCount: targets.length,
    rawField,
    failures,
  };
}

export function compareStrictStructuralSnapshots(before, after) {
  const identitySame =
    before.projectName === after.projectName &&
    sameProjectPath(before.projectPath, after.projectPath) &&
    before.sequenceName === after.sequenceName &&
    before.sequenceId === after.sequenceId;
  const structureSame = JSON.stringify(before.normalized) === JSON.stringify(after.normalized);
  return {
    ok: identitySame && structureSame,
    identitySame,
    structureSame,
    beforeDurationFrames: before.normalized?.durationFrames ?? null,
    afterDurationFrames: after.normalized?.durationFrames ?? null,
    beforeTrackCount: before.normalized?.tracks?.length ?? null,
    afterTrackCount: after.normalized?.tracks?.length ?? null,
  };
}

function baseResult(proposalPath, changes, dryRun) {
  return {
    proposal: proposalPath || null,
    schemaVersion: AUDIO_BALANCE_PROPOSAL_SCHEMA_VERSION,
    requested: changes.length,
    dryRun,
    ok: false,
    outcome: "not-started",
    writeAttemptCount: 0,
    writeResent: false,
    mutationPossible: false,
  };
}

export function runAudioBalanceOperation({
  proposal,
  proposalPath = "",
  dryRun = false,
  maxItems = 0,
  io,
}) {
  let selected;
  try {
    ({ selected } = validateProposalDocument(proposal, { dryRun, maxItems }));
  } catch (error) {
    return {
      ...baseResult(proposalPath, [], dryRun),
      outcome: "proposal-rejected",
      validationError: serializeError(error),
    };
  }

  const changes = dryRun && maxItems > 0 ? selected.slice(0, maxItems) : selected;
  return runValidatedAudioBalanceBatch({
    proposal,
    proposalPath,
    changes,
    dryRun,
    io,
  });
}

function runValidatedAudioBalanceBatch({
  proposal,
  proposalPath = "",
  changes,
  dryRun = false,
  io,
}) {
  const result = baseResult(proposalPath, changes, dryRun);
  if (!io || typeof io.captureStructure !== "function") {
    return {
      ...result,
      outcome: "preflight-io-invalid",
      preflightError: { name: "Error", message: "Audio-balance structure IO adapter is missing.", code: null },
    };
  }
  if (changes.length === 0) {
    try {
      const current = io.captureStructure();
      const identity = validateLiveIdentity(proposal, current);
      if (!identity.ok) {
        return { ...result, outcome: "identity-preflight-rejected", identity };
      }
    } catch (error) {
      return {
        ...result,
        outcome: "preflight-read-failed",
        preflightError: serializeError(error),
      };
    }
    return {
      ...result,
      ok: true,
      outcome: "verified-noop",
      levelReadbackComplete: true,
      invariant: null,
    };
  }
  if (typeof io.readLevels !== "function") {
    return {
      ...result,
      outcome: "preflight-io-invalid",
      preflightError: { name: "Error", message: "Audio-balance IO adapter is incomplete.", code: null },
    };
  }
  if (!dryRun && typeof io.writeLevels !== "function") {
    return {
      ...result,
      outcome: "preflight-io-invalid",
      preflightError: { name: "Error", message: "Audio-balance write IO adapter is missing.", code: null },
    };
  }

  let before;
  let preflightRead;
  try {
    before = io.captureStructure();
    const identity = validateLiveIdentity(proposal, before);
    if (!identity.ok) {
      return { ...result, outcome: "identity-preflight-rejected", identity };
    }
    preflightRead = io.readLevels(changes, before, "currentRaw");
  } catch (error) {
    return {
      ...result,
      outcome: "preflight-read-failed",
      preflightError: serializeError(error),
    };
  }
  const preflight = validateTargetRead(changes, preflightRead, proposal, "currentRaw");
  if (!preflight.ok) {
    return {
      ...result,
      outcome: "target-preflight-rejected",
      preflight,
    };
  }

  let writeResponse = null;
  let writeError = null;
  if (!dryRun) {
    result.writeAttemptCount = 1;
    result.mutationPossible = true;
    try {
      // Exactly one write call. Never loop or resend after a timeout/missing response.
      writeResponse = io.writeLevels(changes, before);
    } catch (error) {
      writeError = error;
    }
  }

  let postLevelRead = null;
  let after = null;
  let postLevelError = null;
  let postStructureError = null;
  try {
    postLevelRead = io.readLevels(changes, before, dryRun ? "currentRaw" : "newRaw");
  } catch (error) {
    postLevelError = error;
  }
  try {
    after = io.captureStructure();
  } catch (error) {
    postStructureError = error;
  }

  if (postLevelError || postStructureError) {
    return {
      ...result,
      outcome: "uncertain-post-read-failed-no-retry",
      preflight,
      writeResponse,
      writeError: serializeError(writeError),
      postReadError: {
        level: serializeError(postLevelError),
        structure: serializeError(postStructureError),
      },
      levelReadbackComplete: false,
      invariant: null,
    };
  }

  const levelReadback = validateTargetRead(
    changes,
    postLevelRead,
    proposal,
    dryRun ? "currentRaw" : "newRaw",
  );
  const invariant = compareStrictStructuralSnapshots(before, after);
  const immediateWriteOkay = dryRun || writeError
    ? true
    : writeResponse?.phase === "written" &&
      Array.isArray(writeResponse.updated) &&
      writeResponse.updated.length === changes.length &&
      Array.isArray(writeResponse.failed) &&
      writeResponse.failed.length === 0 &&
      writeResponse.updated.every((item) => item.matched === true);
  const ok = invariant.ok && levelReadback.ok && immediateWriteOkay;
  return {
    ...result,
    ok,
    outcome: ok
      ? writeError
        ? "verified-by-post-read-after-uncertain-write-response"
        : "verified"
      : writeError
        ? "verification-failed-after-uncertain-write-response"
        : "verification-failed",
    preflight,
    writeResponse,
    writeError: serializeError(writeError),
    levelReadbackComplete: levelReadback.ok,
    levelReadback,
    invariant,
    postReadError: null,
  };
}

async function runValidatedLevelOnlyBatch({
  proposal,
  proposalPath = "",
  changes,
  dryRun = false,
  io,
  initialSnapshot,
}) {
  const result = baseResult(proposalPath, changes, dryRun);
  if (!initialSnapshot || typeof initialSnapshot !== "object") {
    return {
      ...result,
      outcome: "preflight-io-invalid",
      preflightError: serializeError(new Error("Initial full sequence snapshot is missing.")),
    };
  }
  if (!io || typeof io.readLevels !== "function") {
    return {
      ...result,
      outcome: "preflight-io-invalid",
      preflightError: serializeError(new Error("Audio-balance Level read IO adapter is missing.")),
    };
  }
  if (!dryRun && typeof io.writeLevels !== "function") {
    return {
      ...result,
      outcome: "preflight-io-invalid",
      preflightError: serializeError(new Error("Audio-balance write IO adapter is missing.")),
    };
  }

  let preflightRead;
  try {
    preflightRead = await io.readLevels(changes, initialSnapshot, "currentRaw");
  } catch (error) {
    return {
      ...result,
      outcome: "preflight-read-failed",
      preflightError: serializeError(error),
    };
  }
  const preflight = validateTargetRead(changes, preflightRead, proposal, "currentRaw");
  if (!preflight.ok) {
    return {
      ...result,
      outcome: "target-preflight-rejected",
      preflight,
    };
  }

  // A dry-run's exact preflight read is already its Level read-back. Avoid a
  // duplicate live call when no mutation was submitted.
  if (dryRun) {
    return {
      ...result,
      ok: true,
      outcome: "verified",
      preflight,
      writeResponse: null,
      writeError: null,
      levelReadbackComplete: true,
      levelReadback: preflight,
      structureVerificationDeferred: true,
      postReadError: null,
    };
  }

  let writeResponse = null;
  let writeError = null;
  result.writeAttemptCount = 1;
  result.mutationPossible = true;
  try {
    // Exactly one write call. Never loop or resend after a timeout/missing response.
    writeResponse = await io.writeLevels(changes, initialSnapshot);
  } catch (error) {
    writeError = error;
  }

  let postLevelRead = null;
  let postLevelError = null;
  try {
    postLevelRead = await io.readLevels(changes, initialSnapshot, "newRaw");
  } catch (error) {
    postLevelError = error;
  }
  if (postLevelError) {
    return {
      ...result,
      outcome: "uncertain-post-read-failed-no-retry",
      preflight,
      writeResponse,
      writeError: serializeError(writeError),
      postReadError: { level: serializeError(postLevelError), structure: null },
      levelReadbackComplete: false,
      structureVerificationDeferred: true,
    };
  }

  const levelReadback = validateTargetRead(changes, postLevelRead, proposal, "newRaw");
  const immediateWriteOkay = writeError
    ? true
    : writeResponse?.phase === "written" &&
      Array.isArray(writeResponse.updated) &&
      writeResponse.updated.length === changes.length &&
      Array.isArray(writeResponse.failed) &&
      writeResponse.failed.length === 0 &&
      writeResponse.updated.every((item) => item.matched === true);
  const ok = levelReadback.ok && immediateWriteOkay;
  return {
    ...result,
    ok,
    outcome: ok
      ? writeError
        ? "verified-by-post-read-after-uncertain-write-response"
        : "verified"
      : writeError
        ? "verification-failed-after-uncertain-write-response"
        : "verification-failed",
    preflight,
    writeResponse,
    writeError: serializeError(writeError),
    levelReadbackComplete: levelReadback.ok,
    levelReadback,
    structureVerificationDeferred: true,
    postReadError: null,
  };
}

async function captureFinalVerification({
  proposal,
  changes,
  dryRun,
  io,
  initialSnapshot,
}) {
  let finalSnapshot = null;
  let finalLevelRead = null;
  let structureError = null;
  let levelError = null;
  try {
    finalSnapshot = await io.captureStructure();
  } catch (error) {
    structureError = error;
  }
  if (changes.length > 0) {
    try {
      finalLevelRead = await io.readLevels(
        changes,
        initialSnapshot,
        dryRun ? "currentRaw" : "newRaw",
      );
    } catch (error) {
      levelError = error;
    }
  }
  const invariant = structureError
    ? null
    : compareStrictStructuralSnapshots(initialSnapshot, finalSnapshot);
  const levelReadback = levelError
    ? null
    : changes.length > 0
      ? validateTargetRead(
        changes,
        finalLevelRead,
        proposal,
        dryRun ? "currentRaw" : "newRaw",
      )
      : { ok: true, expectedCount: 0, observedCount: 0, failures: [] };
  return {
    ok: !structureError && !levelError && invariant.ok && levelReadback.ok,
    structureExact: !structureError && invariant.ok,
    levelsExact: !levelError && levelReadback.ok,
    error: structureError || levelError
      ? {
        structure: serializeError(structureError),
        level: serializeError(levelError),
      }
      : null,
    invariant,
    levelReadback,
  };
}

function observedBackpressureYieldMs(batchResult) {
  const response = batchResult?.writeResponse;
  if (response?.backpressureObserved !== true) return 0;
  const requested = Number(response?.recommendedUiYieldMs);
  if (Number.isInteger(requested) && requested >= 250 && requested <= 60_000) {
    return requested;
  }
  return AUDIO_BALANCE_BACKPRESSURE_YIELD_MS;
}

function emitProgress(result, onProgress, event) {
  result.progressEvents.push(event);
  if (typeof onProgress !== "function") return;
  try {
    onProgress(event);
  } catch (error) {
    result.progressCallbackErrors.push(serializeError(error));
  }
}

function progressItem(item) {
  return {
    nodeId: String(item.nodeId),
    sourceGroupKey: String(item.sourceGroupKey),
    trackIndex: Number(item.trackIndex),
    clipIndex: Number(item.clipIndex),
    name: String(item.name),
  };
}

function classifyBatchStopReason(batchResult) {
  const writeErrorText = [
    batchResult?.writeError?.code,
    batchResult?.writeError?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (batchResult?.writeError) {
    return /timeout|timed out|etimedout/.test(writeErrorText)
      ? "write-timeout-or-response-loss"
      : "write-response-error";
  }
  if (batchResult?.writeAttemptCount > 0 && !batchResult?.writeResponse) {
    return "write-response-loss";
  }
  if (batchResult?.outcome === "preflight-read-failed") return "preflight-read-failed";
  if (batchResult?.outcome === "identity-preflight-rejected") return "identity-drift";
  if (batchResult?.outcome === "target-preflight-rejected") {
    return batchResult?.preflight?.failures?.some((failure) => failure.kind === "identity_mismatch")
      ? "identity-drift"
      : "level-preflight-mismatch";
  }
  if (batchResult?.outcome === "uncertain-post-read-failed-no-retry") {
    return "post-read-failed";
  }
  if (batchResult?.invariant && !batchResult.invariant.identitySame) {
    return "identity-drift";
  }
  if (batchResult?.levelReadback && !batchResult.levelReadback.ok) {
    return "level-post-read-mismatch";
  }
  if (batchResult?.invariant && !batchResult.invariant.structureSame) {
    return "structural-change";
  }
  if (!batchResult?.ok) return batchResult?.outcome || "batch-verification-failed";
  return null;
}

function addBatchProgress(result, allChanges, batch, batchResult, verified, dryRun) {
  result.writeAttemptCount += Number(batchResult.writeAttemptCount || 0);
  result.mutationPossible ||= batchResult.mutationPossible === true;
  result.batches.push({
    batchNumber: batch.batchNumber,
    batchCount: batch.batchCount,
    startIndex: batch.startIndex,
    endIndex: batch.endIndex,
    itemCount: batch.items.length,
    verificationMode: dryRun ? "dry-run" : "applied",
    verified,
    result: batchResult,
  });
  if (verified) {
    const progress = {
      batchNumber: batch.batchNumber,
      startIndex: batch.startIndex,
      endIndex: batch.endIndex,
      itemCount: batch.items.length,
    };
    if (dryRun) {
      result.verifiedDryRunBatchCount += 1;
      result.verifiedDryRunItemCount += batch.items.length;
      result.verifiedDryRunBatches.push(progress);
      result.verifiedDryRunItems.push(...batch.items.map(progressItem));
    } else {
      result.verifiedCompletedBatchCount += 1;
      result.verifiedCompletedItemCount += batch.items.length;
      result.verifiedCompletedBatches.push(progress);
      result.verifiedCompletedItems.push(...batch.items.map(progressItem));
    }
  }
  if (dryRun) {
    result.remainingDryRunItems = allChanges
      .slice(result.verifiedDryRunItemCount)
      .map(progressItem);
    result.remainingDryRunItemCount = result.remainingDryRunItems.length;
  } else {
    result.remainingItems = allChanges
      .slice(result.verifiedCompletedItemCount)
      .map(progressItem);
    result.remainingItemCount = result.remainingItems.length;
  }
}

export async function runAudioBalanceMicroBatchOperation({
  proposal,
  proposalPath = "",
  dryRun = false,
  maxItems = 0,
  batchSize = AUDIO_BALANCE_DEFAULT_BATCH_SIZE,
  io,
  waitForUi = waitForPremiereUi,
  onProgress = null,
}) {
  let selected;
  try {
    ({ selected } = validateProposalDocument(proposal, { dryRun, maxItems }));
  } catch (error) {
    return {
      ...baseResult(proposalPath, [], dryRun),
      outcome: "proposal-rejected",
      validationError: serializeError(error),
      batchSize: null,
      plannedBatchCount: 0,
      verifiedCompletedBatchCount: 0,
      verifiedCompletedItemCount: 0,
      verifiedCompletedBatches: [],
      verifiedCompletedItems: [],
      verifiedDryRunBatchCount: 0,
      verifiedDryRunItemCount: 0,
      verifiedDryRunBatches: [],
      verifiedDryRunItems: [],
      remainingItemCount: 0,
      remainingItems: [],
      remainingDryRunItemCount: 0,
      remainingDryRunItems: [],
      batches: [],
      uiYieldCount: 0,
      progressEvents: [],
      progressCallbackErrors: [],
    };
  }

  let resolvedBatchSize;
  try {
    resolvedBatchSize = resolvePremiereBatchSize(batchSize, {
      defaultSize: AUDIO_BALANCE_DEFAULT_BATCH_SIZE,
      hardMaximum: AUDIO_BALANCE_MAX_BATCH_SIZE,
      label: "Level batch size",
    });
  } catch (error) {
    return {
      ...baseResult(proposalPath, selected, dryRun),
      outcome: "batch-size-rejected",
      validationError: serializeError(error),
      batchSize: null,
      plannedBatchCount: 0,
      verifiedCompletedBatchCount: 0,
      verifiedCompletedItemCount: 0,
      verifiedCompletedBatches: [],
      verifiedCompletedItems: [],
      verifiedDryRunBatchCount: 0,
      verifiedDryRunItemCount: 0,
      verifiedDryRunBatches: [],
      verifiedDryRunItems: [],
      remainingItemCount: selected.length,
      remainingItems: selected.map(progressItem),
      remainingDryRunItemCount: dryRun ? selected.length : 0,
      remainingDryRunItems: dryRun ? selected.map(progressItem) : [],
      batches: [],
      uiYieldCount: 0,
      progressEvents: [],
      progressCallbackErrors: [],
    };
  }

  const changes = dryRun && maxItems > 0 ? selected.slice(0, maxItems) : selected;
  const batches = partitionPremiereMicroBatches(changes, resolvedBatchSize);
  const result = {
    ...baseResult(proposalPath, changes, dryRun),
    batchSize: resolvedBatchSize,
    batchPauseMs: AUDIO_BALANCE_BATCH_PAUSE_MS,
    plannedBatchCount: batches.length,
    verifiedCompletedBatchCount: 0,
    verifiedCompletedItemCount: 0,
    verifiedCompletedBatches: [],
    verifiedCompletedItems: [],
    verifiedDryRunBatchCount: 0,
    verifiedDryRunItemCount: 0,
    verifiedDryRunBatches: [],
    verifiedDryRunItems: [],
    remainingItemCount: changes.length,
    remainingItems: changes.map(progressItem),
    remainingDryRunItemCount: dryRun ? changes.length : 0,
    remainingDryRunItems: dryRun ? changes.map(progressItem) : [],
    batches: [],
    uiYieldCount: 0,
    uiYieldMs: 0,
    stoppedAtBatchNumber: null,
    stopReason: null,
    initialFullSnapshotCaptured: false,
    finalFullSnapshotAttempted: false,
    finalVerification: null,
    progressEvents: [],
    progressCallbackErrors: [],
  };

  if (changes.length === 0) {
    let snapshot;
    if (!io || typeof io.captureStructure !== "function") {
      return {
        ...result,
        outcome: "preflight-io-invalid",
        preflightError: serializeError(new Error("Audio-balance structure IO adapter is missing.")),
      };
    }
    try {
      snapshot = await io.captureStructure();
    } catch (error) {
      return { ...result, outcome: "preflight-read-failed", preflightError: serializeError(error) };
    }
    const singleResult = runValidatedAudioBalanceBatch({
      proposal,
      proposalPath,
      changes,
      dryRun,
      io: { captureStructure: () => snapshot },
    });
    return {
      ...result,
      ...singleResult,
      batchSize: resolvedBatchSize,
      batchPauseMs: AUDIO_BALANCE_BATCH_PAUSE_MS,
      plannedBatchCount: batches.length,
      verifiedCompletedBatchCount: 0,
      verifiedCompletedItemCount: 0,
      verifiedCompletedBatches: [],
      verifiedCompletedItems: [],
      verifiedDryRunBatchCount: 0,
      verifiedDryRunItemCount: 0,
      verifiedDryRunBatches: [],
      verifiedDryRunItems: [],
      remainingItemCount: changes.length,
      remainingItems: changes.map(progressItem),
      remainingDryRunItemCount: 0,
      remainingDryRunItems: [],
      batches: [],
      uiYieldCount: 0,
      uiYieldMs: 0,
      stoppedAtBatchNumber: null,
      stopReason: null,
      initialFullSnapshotCaptured: singleResult.ok === true,
      finalFullSnapshotAttempted: false,
      finalVerification: null,
      progressEvents: [],
      progressCallbackErrors: [],
    };
  }

  if (
    !io ||
    typeof io.captureStructure !== "function" ||
    typeof io.readLevels !== "function" ||
    (!dryRun && typeof io.writeLevels !== "function")
  ) {
    return {
      ...result,
      outcome: "preflight-io-invalid",
      preflightError: serializeError(new Error("Audio-balance Level-only IO adapter is incomplete.")),
    };
  }

  let initialSnapshot;
  try {
    initialSnapshot = await io.captureStructure();
    result.initialFullSnapshotCaptured = true;
  } catch (error) {
    result.outcome = "preflight-read-failed";
    result.preflightError = serializeError(error);
    return result;
  }
  const initialIdentity = validateLiveIdentity(proposal, initialSnapshot);
  if (!initialIdentity.ok) {
    result.outcome = "identity-preflight-rejected";
    result.identity = initialIdentity;
    return result;
  }
  emitProgress(result, onProgress, {
    phase: "initial-full-snapshot-verified",
    requestedItems: changes.length,
    batchSize: resolvedBatchSize,
    plannedBatchCount: batches.length,
  });

  const verifiedChanges = [];
  const attachPartialFinalVerification = async () => {
    if (result.finalFullSnapshotAttempted) return;
    if (!result.mutationPossible && verifiedChanges.length === 0) return;
    result.finalFullSnapshotAttempted = true;
    result.finalVerification = await captureFinalVerification({
      proposal,
      changes: verifiedChanges,
      dryRun,
      io,
      initialSnapshot,
    });
    result.finalVerification.scope = "verified-batches-only";
  };

  for (const batch of batches) {
    emitProgress(result, onProgress, {
      phase: "batch-start",
      batchNumber: batch.batchNumber,
      batchCount: batch.batchCount,
      itemCount: batch.items.length,
      startItem: batch.startIndex + 1,
      endItem: batch.endIndex,
    });
    const batchResult = await runValidatedLevelOnlyBatch({
      proposal,
      proposalPath,
      changes: batch.items,
      dryRun,
      io,
      initialSnapshot,
    });
    const verified =
      batchResult.ok === true &&
      batchResult.levelReadbackComplete === true &&
      batchResult.writeAttemptCount === (dryRun ? 0 : 1);
    addBatchProgress(result, changes, batch, batchResult, verified, dryRun);
    if (verified) verifiedChanges.push(...batch.items);
    emitProgress(result, onProgress, {
      phase: verified ? "batch-level-verified" : "batch-stopped",
      batchNumber: batch.batchNumber,
      batchCount: batch.batchCount,
      itemCount: batch.items.length,
      verifiedItems: dryRun
        ? result.verifiedDryRunItemCount
        : result.verifiedCompletedItemCount,
      remainingItems: dryRun
        ? result.remainingDryRunItemCount
        : result.remainingItemCount,
      writeAttemptCount: batchResult.writeAttemptCount,
      outcome: batchResult.outcome,
    });

    const stopReason = classifyBatchStopReason(batchResult);
    if (stopReason) {
      result.ok = false;
      result.outcome = dryRun
        ? "dry-run-stopped-before-next-batch"
        : "stopped-before-next-batch";
      result.stoppedAtBatchNumber = batch.batchNumber;
      result.stopReason = stopReason;
      await attachPartialFinalVerification();
      return result;
    }

    if (!batch.isLast) {
      const yieldMs = observedBackpressureYieldMs(batchResult);
      if (yieldMs > 0) {
        if (typeof waitForUi !== "function") {
          result.ok = false;
          result.outcome = dryRun
            ? "dry-run-stopped-before-next-batch"
            : "stopped-before-next-batch";
          result.stoppedAtBatchNumber = batch.batchNumber;
          result.stopReason = "backpressure-yield-unavailable";
          await attachPartialFinalVerification();
          return result;
        }
        try {
          await waitForUi(yieldMs);
          result.uiYieldCount += 1;
          result.uiYieldMs += yieldMs;
          emitProgress(result, onProgress, {
            phase: "observed-backpressure-yield",
            batchNumber: batch.batchNumber,
            milliseconds: yieldMs,
          });
        } catch (error) {
          result.ok = false;
          result.outcome = dryRun
            ? "dry-run-stopped-before-next-batch"
            : "stopped-before-next-batch";
          result.stoppedAtBatchNumber = batch.batchNumber;
          result.stopReason = "ui-yield-failed";
          result.uiYieldError = serializeError(error);
          await attachPartialFinalVerification();
          return result;
        }
      }
    }
  }

  result.finalFullSnapshotAttempted = true;
  result.finalVerification = await captureFinalVerification({
    proposal,
    changes,
    dryRun,
    io,
    initialSnapshot,
  });
  result.finalVerification.scope = "all-targets";
  result.invariant = result.finalVerification.invariant;
  result.levelReadbackComplete = result.finalVerification.levelsExact;
  result.finalLevelReadback = result.finalVerification.levelReadback;
  emitProgress(result, onProgress, {
    phase: "final-full-verification",
    structureExact: result.finalVerification.structureExact,
    levelsExact: result.finalVerification.levelsExact,
    verifiedItems: changes.length,
  });
  if (!result.finalVerification.ok) {
    result.ok = false;
    result.outcome = result.finalVerification.error
      ? "uncertain-final-read-failed-no-retry"
      : "final-verification-failed";
    result.stopReason = result.finalVerification.error
      ? "final-read-failed"
      : !result.finalVerification.structureExact
        ? "structural-change"
        : "level-final-read-mismatch";
    return result;
  }
  result.ok = true;
  result.outcome = dryRun ? "verified-dry-run" : "verified";
  return result;
}

export function createAudioBalanceLiveIo(session) {
  return {
    captureStructure: () => captureStructuralSnapshot(session),
    readLevels: (changes, expected, rawField) => session.call("execute_extendscript", {
      code: buildLevelReadCode(changes, expected, rawField),
      timeout_ms: 180000,
    }),
    writeLevels: (changes, expected) => session.call("execute_extendscript", {
      code: buildLevelWriteCode(changes, expected),
      timeout_ms: 180000,
    }),
  };
}

export async function runAudioBalanceLiveOperation(options, { session = createPremiereCepSession({
  name: "deno-premiere-audio-balance",
  tool: "apply-premiere-audio-balance",
}) } = {}) {
  let operation;
  try {
    operation = await runAudioBalanceMicroBatchOperation({
      ...options,
      io: createAudioBalanceLiveIo(session),
    });
  } finally {
    try {
      await session.close();
    } catch (error) {
      if (!operation) throw error;
      operation.ok = false;
      operation.outcome = "session-cleanup-failed";
      operation.cleanupError = serializeError(error);
    }
  }
  return operation;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  let proposal;
  try {
    proposal = JSON.parse(fs.readFileSync(options.proposal, "utf8"));
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      outcome: "proposal-read-failed",
      proposal: options.proposal,
      writeAttemptCount: 0,
      writeResent: false,
      error: serializeError(error),
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const operation = await runAudioBalanceLiveOperation({
    proposal,
    proposalPath: options.proposal,
    dryRun: options.dryRun,
    maxItems: options.maxItems,
    batchSize: options.batchSize,
    onProgress(event) {
      if (event.phase === "batch-start") {
        console.error(
          `[audio-balance] batch ${event.batchNumber}/${event.batchCount} ` +
          `items ${event.startItem}-${event.endItem} (${event.itemCount})`,
        );
      } else if (event.phase === "batch-level-verified") {
        console.error(
          `[audio-balance] batch ${event.batchNumber}/${event.batchCount} verified; ` +
          `${event.verifiedItems} complete, ${event.remainingItems} remaining`,
        );
      } else if (event.phase === "final-full-verification") {
        console.error(
          `[audio-balance] final structure=${event.structureExact ? "exact" : "changed"} ` +
          `levels=${event.levelsExact ? "exact" : "mismatch"}`,
        );
      } else if (event.phase === "observed-backpressure-yield") {
        console.error(
          `[audio-balance] observed backpressure after batch ${event.batchNumber}; ` +
          `yielding ${event.milliseconds}ms`,
        );
      }
    },
  });
  operation.requestedChunkSize = options.batchSize;
  operation.actualWriteCallCount = operation.writeAttemptCount;
  console.log(JSON.stringify(operation, null, 2));
  if (!operation.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.log(JSON.stringify({
      ok: false,
      outcome: "unhandled-failure",
      writeAttemptCount: 0,
      writeResent: false,
      error: serializeError(error),
    }, null, 2));
    process.exit(1);
  });
}
