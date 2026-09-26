function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, label) {
  const result = String(value ?? "").trim();
  if (!result) fail(`${label} is required`);
  return result;
}

function finiteNumber(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result)) fail(`${label} must be a finite number`);
  return result;
}

function positiveNumber(value, label) {
  const result = finiteNumber(value, label);
  if (!(result > 0)) fail(`${label} must be greater than zero`);
  return result;
}

function integer(value, label) {
  const result = Number(value);
  if (!Number.isInteger(result)) fail(`${label} must be an integer`);
  return result;
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function sha256(value, label) {
  const result = requiredString(value, label).toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(result)) fail(`${label} must be a SHA-256 hash`);
  return result;
}

function captureBinding(source, label) {
  const nested = isObject(source?.captureBinding) ? source.captureBinding : {};
  return {
    captureSha256: sha256(
      source?.captureSha256 ?? nested.captureSha256,
      `${label}.captureSha256`,
    ),
    targetBindingSha256: sha256(
      source?.targetBindingSha256 ?? nested.targetBindingSha256,
      `${label}.targetBindingSha256`,
    ),
    bundleSha256: sha256(
      source?.bundleSha256 ?? nested.bundleSha256,
      `${label}.bundleSha256`,
    ),
  };
}

function assertSameCapture(expected, actual, label) {
  for (const field of ["captureSha256", "targetBindingSha256", "bundleSha256"]) {
    if (expected[field] !== actual[field]) {
      fail(`${label}.${field} does not match live identity`);
    }
  }
}

function identityContract(identity) {
  if (!isObject(identity)) fail("identity must be a JSON object");
  const project = isObject(identity.project) ? identity.project : {};
  const sequence = isObject(identity.sequence) ? identity.sequence : {};
  const settings = isObject(identity.sequenceSettings) ? identity.sequenceSettings : {};
  const timing = isObject(identity.timing) ? identity.timing : {};
  const projectName = requiredString(identity.projectName ?? project.name, "identity.projectName");
  const sequenceName = requiredString(identity.sequenceName ?? sequence.name ?? settings.name, "identity.sequenceName");
  const sequenceIdValue = identity.sequenceId ?? sequence.id ?? settings.id ?? null;
  const sequenceId = sequenceIdValue === null || sequenceIdValue === undefined
    ? null
    : requiredString(sequenceIdValue, "identity.sequenceId");
  const sequenceDurationSeconds = positiveNumber(
    identity.sequenceDurationSeconds ?? sequence.durationSeconds ?? identity.durationSeconds,
    "identity.sequenceDurationSeconds",
  );
  const fps = positiveNumber(identity.fps ?? timing.fps ?? settings.frameRate, "identity.fps");
  const ticksPerFrameValue = identity.ticksPerFrame ?? timing.ticksPerFrame ?? settings.ticksPerFrame;
  const ticksPerFrame = ticksPerFrameValue === undefined || ticksPerFrameValue === null
    ? null
    : requiredString(ticksPerFrameValue, "identity.ticksPerFrame");
  const targetTracks = Array.isArray(identity.targetTracks) ? identity.targetTracks : [];
  if (targetTracks.length !== 2) fail("identity.targetTracks must contain exactly V/A target tracks");
  const targetClipNames = uniqueStrings([
    ...(Array.isArray(identity.targetClipNames) ? identity.targetClipNames : []),
    identity.targetClipName,
    identity.clipName,
  ]);
  if (targetClipNames.length === 0) fail("identity.targetClipNames is required");
  if (!isObject(identity.timecodeDisplay)) {
    fail("identity.timecodeDisplay is required from the live sequence");
  }
  const nominalFps = integer(
    identity.timecodeDisplay.nominalFps,
    "identity.timecodeDisplay.nominalFps",
  );
  if (nominalFps <= 0 || nominalFps !== Math.round(fps)) {
    fail("identity.timecodeDisplay.nominalFps does not match identity.fps");
  }
  if (typeof identity.timecodeDisplay.dropFrame !== "boolean") {
    fail("identity.timecodeDisplay.dropFrame must be an explicit boolean");
  }
  const timecodeDisplay = {
    nominalFps,
    dropFrame: identity.timecodeDisplay.dropFrame,
  };
  const capture = captureBinding(identity, "identity");
  return {
    projectName,
    sequenceName,
    sequenceId,
    sequenceDurationSeconds,
    timing: {fps, ...(ticksPerFrame === null ? {} : {ticksPerFrame})},
    timecodeDisplay,
    targetTracks,
    targetClipNames,
    ...capture,
  };
}

function normalizeCut(cut, label, sourceType) {
  if (!isObject(cut)) fail(`${label} must be an object`);
  const startFrame = integer(cut.startFrame, `${label}.startFrame`);
  const endFrame = integer(cut.endFrame, `${label}.endFrame`);
  if (startFrame < 0 || endFrame <= startFrame) fail(`${label} has an invalid frame range`);
  return {
    ...cut,
    startFrame,
    endFrame,
    removeFrames: endFrame - startFrame,
    sourceType,
    waveformSnapped: true,
  };
}

function waveformCuts(payload) {
  if (!isObject(payload)) fail("waveform cut payload must be a JSON object");
  if (!String(payload.mode ?? "").toLowerCase().includes("waveform")) {
    fail("waveform cut payload mode must identify waveform cuts");
  }
  if (payload.writeReady !== true) fail("waveform cut payload is not writeReady");
  const audit = payload.candidatePeakAudit;
  if (!isObject(audit)) fail("waveform cut payload is missing candidatePeakAudit");
  if (String(audit.energyMode ?? "").toLowerCase() !== "peak") {
    fail("waveform candidatePeakAudit.energyMode must be peak");
  }
  if (Number(audit.bridgeSilenceGapSeconds) !== 0) {
    fail("waveform candidatePeakAudit.bridgeSilenceGapSeconds must be 0");
  }
  if (integer(audit.suspiciousCutCount, "candidatePeakAudit.suspiciousCutCount") !== 0) {
    fail("waveform candidate peak audit contains suspicious cuts");
  }
  const options = isObject(payload.options) ? payload.options : {};
  const silenceDb = finiteNumber(options.silenceDb, "waveform.options.silenceDb");
  const suspiciousPeakThresholdDb = finiteNumber(
    audit.suspiciousPeakThresholdDb,
    "candidatePeakAudit.suspiciousPeakThresholdDb",
  );
  if (Math.abs(silenceDb - suspiciousPeakThresholdDb) > 1e-9) {
    fail("waveform candidate peak audit threshold must equal waveform silenceDb");
  }
  const snapEvidence = isObject(payload.waveformSnapEvidence)
    ? payload.waveformSnapEvidence
    : {};
  if (
    snapEvidence.integerFrameBoundaries !== true ||
    snapEvidence.allBoundariesSnapped !== true
  ) {
    fail("waveform cut payload is missing integer-frame snap evidence");
  }
  const fps = positiveNumber(
    snapEvidence.fps ?? options.fps,
    "waveform waveformSnapEvidence.fps",
  );
  const optionFps = positiveNumber(options.fps, "waveform.options.fps");
  if (Math.abs(fps - optionFps) > 1e-9) {
    fail("waveform snap evidence fps does not match waveform options fps");
  }
  const ticksPerFrame = requiredString(
    options.ticksPerFrame,
    "waveform.options.ticksPerFrame",
  );
  const capture = captureBinding(payload, "waveform");
  if (!Array.isArray(payload.cuts) || payload.cuts.length === 0) {
    fail("waveform cut payload contains no cuts");
  }
  return {
    audit,
    timing: {fps, ticksPerFrame},
    capture,
    cuts: payload.cuts.map((cut, index) =>
      normalizeCut(cut, `waveform.cuts[${index}]`, "waveform")),
  };
}

function semanticCuts(payload, payloadIndex) {
  if (!isObject(payload)) fail(`semantic payload ${payloadIndex} must be a JSON object`);
  if (!String(payload.mode ?? "").toLowerCase().includes("repeat")) {
    fail(`semantic payload ${payloadIndex} is not a repeat/restart proposal`);
  }
  if (!Array.isArray(payload.candidates)) fail(`semantic payload ${payloadIndex} has no candidates`);
  return payload.candidates
    .filter((candidate) => candidate?.proposalEligible === true)
    .map((candidate, candidateIndex) => {
      if (candidate.reviewRequired === true || candidate.waveformSafety?.verified !== true) {
        fail(`semantic payload ${payloadIndex} candidate ${candidateIndex} is not waveform-safe`);
      }
      if (
        integer(candidate.waveformSafety.startFrame, `semantic[${payloadIndex}].candidates[${candidateIndex}].waveformSafety.startFrame`) !==
          integer(candidate.startFrame, `semantic[${payloadIndex}].candidates[${candidateIndex}].startFrame`) ||
        integer(candidate.waveformSafety.endFrame, `semantic[${payloadIndex}].candidates[${candidateIndex}].waveformSafety.endFrame`) !==
          integer(candidate.endFrame, `semantic[${payloadIndex}].candidates[${candidateIndex}].endFrame`)
      ) {
        fail(`semantic payload ${payloadIndex} candidate ${candidateIndex} boundaries do not match waveform evidence`);
      }
      return normalizeCut(
        candidate,
        `semantic[${payloadIndex}].candidates[${candidateIndex}]`,
        candidate.type ?? "semantic",
      );
    });
}

function semanticCaptureBinding(payload, payloadIndex) {
  const source = isObject(payload?.waveformSafetyBinding)
    ? payload.waveformSafetyBinding
    : payload;
  return captureBinding(source, `semantic[${payloadIndex}].waveformSafetyBinding`);
}

function semanticBoundaryAudit(payload, payloadIndex, eligibleCount) {
  const audit = payload?.semanticBoundaryAudit;
  if (!isObject(audit)) {
    fail(`semantic payload ${payloadIndex} is missing semanticBoundaryAudit`);
  }
  if (String(audit.energyMode ?? "").toLowerCase() !== "peak") {
    fail(`semantic payload ${payloadIndex} boundary audit must use peak energy`);
  }
  const verifiedCutCount = integer(
    audit.verifiedCutCount,
    `semantic[${payloadIndex}].semanticBoundaryAudit.verifiedCutCount`,
  );
  const verifiedBoundaryCount = integer(
    audit.verifiedBoundaryCount,
    `semantic[${payloadIndex}].semanticBoundaryAudit.verifiedBoundaryCount`,
  );
  const interiorPeakAuditCutCount = integer(
    audit.interiorPeakAuditCutCount,
    `semantic[${payloadIndex}].semanticBoundaryAudit.interiorPeakAuditCutCount`,
  );
  if (verifiedCutCount !== eligibleCount || verifiedBoundaryCount < eligibleCount * 2) {
    fail(`semantic payload ${payloadIndex} boundary audit count does not match eligible cuts`);
  }
  if (interiorPeakAuditCutCount !== 0) {
    fail(`semantic payload ${payloadIndex} must not claim interior silence audit for voiced cuts`);
  }
  return {verifiedBoundaryCount, verifiedCutCount};
}

function mergeFrameCuts(cuts, durationFrames) {
  const sorted = [...cuts].sort(
    (left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame,
  );
  const merged = [];
  for (const cut of sorted) {
    if (cut.endFrame > durationFrames) fail(`cut ${cut.startFrame}-${cut.endFrame} exceeds sequence duration`);
    const previous = merged.at(-1);
    if (!previous || cut.startFrame > previous.endFrame) {
      merged.push({
        ...cut,
        sourceTypes: [cut.sourceType],
        reasons: [cut.reason ?? cut.type ?? cut.sourceType],
      });
      continue;
    }
    previous.endFrame = Math.max(previous.endFrame, cut.endFrame);
    previous.removeFrames = previous.endFrame - previous.startFrame;
    previous.sourceTypes = uniqueStrings([...previous.sourceTypes, cut.sourceType]);
    previous.reasons = uniqueStrings([
      ...previous.reasons,
      cut.reason ?? cut.type ?? cut.sourceType,
    ]);
    previous.waveformSnapped = true;
  }
  return merged.map((cut, index) => ({
    index,
    startFrame: cut.startFrame,
    endFrame: cut.endFrame,
    removeFrames: cut.endFrame - cut.startFrame,
    type: cut.sourceTypes.includes("waveform") && cut.sourceTypes.length === 1
      ? "waveform_only"
      : "editorial_merged",
    sourceTypes: cut.sourceTypes,
    reason: cut.reasons.join(" / "),
    waveformSnapped: true,
  }));
}

export function buildPremiereDirectCutManifest({
  identity,
  waveform,
  semantic = [],
  mode,
  sources = {},
}) {
  const live = identityContract(identity);
  const base = waveformCuts(waveform);
  if (Math.abs(base.timing.fps - live.timing.fps) > 1e-9) {
    fail("waveform fps does not match live identity fps");
  }
  const liveTicksPerFrame = requiredString(
    live.timing.ticksPerFrame,
    "identity.ticksPerFrame",
  );
  if (base.timing.ticksPerFrame !== liveTicksPerFrame) {
    fail("waveform ticksPerFrame does not match live identity ticksPerFrame");
  }
  assertSameCapture(live, base.capture, "waveform");
  const semanticPayloads = Array.isArray(semantic) ? semantic : [semantic];
  semanticPayloads.forEach((payload, index) => {
    assertSameCapture(live, semanticCaptureBinding(payload, index), `semantic[${index}]`);
  });
  const semanticCutGroups = semanticPayloads.map((payload, index) =>
    semanticCuts(payload, index));
  const semanticEligibleCuts = semanticCutGroups.flat();
  const semanticAudits = semanticPayloads.map((payload, index) =>
    semanticBoundaryAudit(payload, index, semanticCutGroups[index].length));
  const resolvedMode = mode ?? (semanticPayloads.length > 0
    ? "semantic-editorial"
    : "waveform-only");
  if (!new Set(["waveform-only", "semantic-editorial"]).has(resolvedMode)) {
    fail("mode must be waveform-only or semantic-editorial");
  }
  if (resolvedMode === "waveform-only" && semanticEligibleCuts.length > 0) {
    fail("waveform-only mode cannot include semantic candidates");
  }
  const fps = live.timing.fps;
  const durationFrames = Math.round(live.sequenceDurationSeconds * fps);
  const exactDurationFrames = live.sequenceDurationSeconds * fps;
  if (Math.abs(durationFrames - exactDurationFrames) > 0.01) {
    fail("identity.sequenceDurationSeconds is not aligned to identity.fps");
  }
  const cuts = mergeFrameCuts(
    [...base.cuts, ...(resolvedMode === "semantic-editorial" ? semanticEligibleCuts : [])],
    durationFrames,
  );
  if (cuts.length === 0) fail("combined direct cut manifest contains no cuts");
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: resolvedMode,
    writeReady: true,
    ...live,
    cutCount: cuts.length,
    cuts,
    candidatePeakAudit: {
      ...base.audit,
      energyMode: "peak",
      bridgeSilenceGapSeconds: 0,
      suspiciousCutCount: 0,
      auditedCutCount: base.cuts.length,
      auditedWaveformCutCount: base.cuts.length,
    },
    semanticBoundaryAudit: {
      auditedCutCount: semanticAudits.reduce((sum, audit) => sum + audit.verifiedCutCount, 0),
      auditedBoundaryCount: semanticAudits.reduce(
        (sum, audit) => sum + audit.verifiedBoundaryCount,
        0,
      ),
      allBoundariesWaveformVerified: true,
      interiorPeakAuditClaimed: false,
    },
    waveformSnapEvidence: {
      integerFrameBoundaries: true,
      allBoundariesSnapped: true,
      baseWaveformCutCount: base.cuts.length,
      semanticEligibleCutCount: semanticEligibleCuts.length,
    },
    sources,
    summary: {
      baseWaveformCutCount: base.cuts.length,
      semanticEligibleCutCount: semanticEligibleCuts.length,
      semanticReviewOnlyCount: semanticPayloads.reduce(
        (sum, payload) => sum + payload.candidates.filter((candidate) => candidate.proposalEligible !== true).length,
        0,
      ),
      combinedCutCount: cuts.length,
      removeFrames: cuts.reduce((sum, cut) => sum + cut.removeFrames, 0),
    },
  };
}
