export const DEFAULT_PREMIERE_CUT_BATCH_SIZE = 20;
export const MAX_PREMIERE_CUT_BATCH_SIZE = 20;
export const DEFAULT_PREMIERE_CUT_BATCH_PAUSE_MS = 0;
export const MIN_PREMIERE_CUT_WRITE_PAUSE_MS = 0;

function fail(message) {
  throw new Error(message);
}

function requireInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) fail(`${label} must be an integer`);
  return parsed;
}

export function resolvePremiereCutBatchOptions(options = {}) {
  const dryRun = options.dryRun === true;
  const batchSize = requireInteger(
    options.batchSize ?? DEFAULT_PREMIERE_CUT_BATCH_SIZE,
    "batchSize",
  );
  if (batchSize < 1 || batchSize > MAX_PREMIERE_CUT_BATCH_SIZE) {
    fail(`batchSize must be between 1 and ${MAX_PREMIERE_CUT_BATCH_SIZE}`);
  }

  const batchPauseMs = requireInteger(
    options.batchPauseMs ?? DEFAULT_PREMIERE_CUT_BATCH_PAUSE_MS,
    "batchPauseMs",
  );
  if (batchPauseMs < 0) fail("batchPauseMs must be at least 0");
  return Object.freeze({dryRun, batchSize, batchPauseMs});
}

function compareCutsAscending(left, right) {
  return (
    left.startFrame - right.startFrame ||
    left.endFrame - right.endFrame ||
    Number(left.index ?? 0) - Number(right.index ?? 0)
  );
}

function compareCutsDescending(left, right) {
  return -compareCutsAscending(left, right);
}

function copyCut(cut) {
  if (!cut || typeof cut !== "object" || Array.isArray(cut)) {
    fail("Every cut must be an object");
  }
  const startFrame = requireInteger(cut.startFrame, "cut.startFrame");
  const endFrame = requireInteger(cut.endFrame, "cut.endFrame");
  if (startFrame < 0) fail("cut.startFrame must be at least 0");
  if (endFrame <= startFrame) fail("cut.endFrame must be greater than cut.startFrame");
  return {...cut, startFrame, endFrame, removeFrames: endFrame - startFrame};
}

export function createReversePremiereCutBatchPlan(cuts, batchSizeValue) {
  if (!Array.isArray(cuts) || cuts.length === 0) {
    fail("At least one cut is required to create a batch plan");
  }
  const batchSize = requireInteger(
    batchSizeValue ?? DEFAULT_PREMIERE_CUT_BATCH_SIZE,
    "batchSize",
  );
  if (batchSize < 1 || batchSize > MAX_PREMIERE_CUT_BATCH_SIZE) {
    fail(`batchSize must be between 1 and ${MAX_PREMIERE_CUT_BATCH_SIZE}`);
  }

  const executionCuts = cuts.map(copyCut).sort(compareCutsDescending);
  const batches = [];
  let cumulativeExecutionCuts = [];
  for (let offset = 0; offset < executionCuts.length; offset += batchSize) {
    const batchCuts = executionCuts.slice(offset, offset + batchSize);
    cumulativeExecutionCuts = [...cumulativeExecutionCuts, ...batchCuts];
    batches.push(Object.freeze({
      batchIndex: batches.length,
      batchNumber: batches.length + 1,
      cuts: Object.freeze(batchCuts.map((cut) => Object.freeze({...cut}))),
      cutCount: batchCuts.length,
      cumulativeCuts: Object.freeze(
        cumulativeExecutionCuts
          .map((cut) => Object.freeze({...cut}))
          .sort(compareCutsAscending),
      ),
      cumulativeCutCount: cumulativeExecutionCuts.length,
    }));
  }

  return Object.freeze({
    batchSize,
    batchCount: batches.length,
    cutCount: executionCuts.length,
    executionCuts: Object.freeze(executionCuts.map((cut) => Object.freeze({...cut}))),
    batches: Object.freeze(batches),
  });
}

export function serializeCutBatchError(error) {
  if (!error) return null;
  return {
    name: String(error.name || "Error"),
    message: String(error.message || error),
    code: error.code ?? null,
  };
}

export function classifyCutBatchWriteError(error) {
  const code = String(error?.code ?? "").toUpperCase();
  const message = String(error?.message ?? error ?? "");
  if (
    code === "ETIMEDOUT" ||
    code === "TIMEOUT" ||
    /(?:timed?\s*out|timeout)/i.test(message)
  ) {
    return "write_timeout";
  }
  return "write_response_failed";
}

function defaultPause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stoppedResult(base, batch, reasons) {
  return {
    ...base,
    ok: false,
    outcome: base.completedBatchCount > 0 ? "partially_completed" : "stopped",
    stop: {
      stopped: true,
      beforeNextBatch: true,
      batchIndex: batch.batchIndex,
      batchNumber: batch.batchNumber,
      primaryReason: reasons[0]?.reason ?? "unknown_failure",
      reasons,
    },
  };
}

/**
 * Runs a pre-built cut plan sequentially. One batch gets at most one call to
 * writeBatch. A read is attempted after every write attempt, including a timed
 * out or failed response, and no later batch starts after any failure signal.
 */
export async function runPremiereCutBatchPlan({
  plan,
  dryRun = false,
  batchPauseMs = DEFAULT_PREMIERE_CUT_BATCH_PAUSE_MS,
  writeBatch,
  readAfterBatch,
  verifyBatch,
  isWriteResponseFailure = () => false,
  pause = defaultPause,
}) {
  if (!plan || !Array.isArray(plan.batches)) fail("A valid cut batch plan is required");
  if (dryRun) {
    return {
      ok: true,
      outcome: "dry_run",
      batchCount: plan.batchCount,
      completedBatchCount: 0,
      writeAttemptCount: 0,
      cumulativeAppliedCuts: [],
      batchResults: [],
      stop: {stopped: false, beforeNextBatch: false, primaryReason: null, reasons: []},
    };
  }
  if (typeof writeBatch !== "function") fail("writeBatch callback is required");
  if (typeof readAfterBatch !== "function") fail("readAfterBatch callback is required");
  if (typeof verifyBatch !== "function") fail("verifyBatch callback is required");
  if (typeof isWriteResponseFailure !== "function") {
    fail("isWriteResponseFailure callback must be a function");
  }
  if (typeof pause !== "function") fail("pause callback must be a function");

  const state = {
    batchCount: plan.batchCount,
    completedBatchCount: 0,
    writeAttemptCount: 0,
    cumulativeAppliedCuts: [],
    batchResults: [],
  };

  for (const batch of plan.batches) {
    state.writeAttemptCount += 1;
    let writeResponse = null;
    let writeError = null;
    try {
      writeResponse = await writeBatch(batch);
    } catch (error) {
      writeError = error;
    }

    let postRead = null;
    let postReadError = null;
    try {
      postRead = await readAfterBatch(batch, {writeResponse, writeError});
    } catch (error) {
      postReadError = error;
    }

    let verification = null;
    let verificationError = null;
    if (!postReadError) {
      try {
        verification = await verifyBatch(batch, postRead, {writeResponse, writeError});
      } catch (error) {
        verificationError = error;
      }
    }

    if (verification?.ok === true) {
      state.completedBatchCount += 1;
      state.cumulativeAppliedCuts = batch.cumulativeCuts.map((cut) => ({...cut}));
    }

    const reasons = [];
    if (writeError) {
      reasons.push({
        reason: classifyCutBatchWriteError(writeError),
        phase: "write_response",
        error: serializeCutBatchError(writeError),
      });
    } else {
      let responseFailed = false;
      try {
        responseFailed = isWriteResponseFailure(writeResponse) === true;
      } catch (error) {
        reasons.push({
          reason: "write_response_validation_failed",
          phase: "write_response",
          error: serializeCutBatchError(error),
        });
      }
      if (responseFailed) {
        reasons.push({reason: "write_response_failed", phase: "write_response"});
      }
    }
    if (postReadError) {
      reasons.push({
        reason: "post_read_failed",
        phase: "post_read",
        error: serializeCutBatchError(postReadError),
      });
    } else if (verificationError) {
      reasons.push({
        reason: "invariant_verification_failed",
        phase: "verification",
        error: serializeCutBatchError(verificationError),
      });
    } else if (verification?.ok !== true) {
      reasons.push({
        reason: String(verification?.stopReason || "invariant_failed"),
        phase: "verification",
      });
    }

    state.batchResults.push({
      batchIndex: batch.batchIndex,
      batchNumber: batch.batchNumber,
      cutCount: batch.cutCount,
      cumulativeCutCount: batch.cumulativeCutCount,
      writeAttempted: true,
      writeResponse,
      writeError: serializeCutBatchError(writeError),
      postReadSucceeded: postReadError === null,
      postReadError: serializeCutBatchError(postReadError),
      verification,
      verificationError: serializeCutBatchError(verificationError),
      verifiedApplied: verification?.ok === true,
      stopReasons: reasons,
    });

    if (reasons.length > 0) {
      return stoppedResult(state, batch, reasons);
    }

    if (batch.batchNumber < plan.batchCount && batchPauseMs > 0) {
      try {
        await pause(batchPauseMs, batch);
      } catch (error) {
        return stoppedResult(state, batch, [{
          reason: "batch_pause_failed",
          phase: "pause",
          error: serializeCutBatchError(error),
        }]);
      }
    }
  }

  return {
    ...state,
    ok: true,
    outcome: "completed",
    stop: {stopped: false, beforeNextBatch: false, primaryReason: null, reasons: []},
  };
}
