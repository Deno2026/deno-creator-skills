import {
  PREMIERE_DEFAULT_BATCH_PAUSE_MS,
  PREMIERE_MAX_BATCH_SIZE,
  PREMIERE_MIN_BATCH_PAUSE_MS,
  partitionPremiereMicroBatches,
  resolvePremiereBatchPauseMs,
  resolvePremiereBatchSize,
  waitForPremiereUi,
} from './premiere-micro-batch.mjs';

export const PREMIERE_OVERLAY_DEFAULT_BATCH_SIZE = 4;

function serializeError(error) {
  if (!error) return null;
  return {
    name: String(error.name || 'Error'),
    message: String(error.message || error),
    code: error.code ?? null,
  };
}

function classifyError(error, fallback) {
  const code = String(error?.code ?? '').toUpperCase();
  const message = String(error?.message ?? error ?? '');
  if (code === 'ETIMEDOUT' || code === 'TIMEOUT' || /(?:timed?\s*out|timeout)/i.test(message)) {
    return `${fallback}_timeout`;
  }
  return `${fallback}_failed`;
}

export function resolvePremiereOverlayBatchOptions({
  batchSize,
  batchPauseMs,
  dryRun = false,
} = {}) {
  return Object.freeze({
    batchSize: resolvePremiereBatchSize(batchSize, {
      defaultSize: PREMIERE_OVERLAY_DEFAULT_BATCH_SIZE,
      hardMaximum: PREMIERE_MAX_BATCH_SIZE,
      label: 'overlay batch size',
    }),
    batchPauseMs: resolvePremiereBatchPauseMs(batchPauseMs, {
      defaultPauseMs: PREMIERE_DEFAULT_BATCH_PAUSE_MS,
      minimumPauseMs: dryRun ? 0 : PREMIERE_MIN_BATCH_PAUSE_MS,
      label: 'overlay batch pause',
    }),
    dryRun: dryRun === true,
  });
}

export function createPremiereOverlayBatchPlan(items, batchSize) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('At least one overlay is required.');
  }
  const resolvedBatchSize = resolvePremiereBatchSize(batchSize, {
    defaultSize: PREMIERE_OVERLAY_DEFAULT_BATCH_SIZE,
    hardMaximum: PREMIERE_MAX_BATCH_SIZE,
    label: 'overlay batch size',
  });
  const batches = partitionPremiereMicroBatches(items, resolvedBatchSize);
  return Object.freeze({
    batchSize: resolvedBatchSize,
    batchCount: batches.length,
    itemCount: items.length,
    batches: Object.freeze(batches.map((batch) => Object.freeze({
      ...batch,
      items: Object.freeze(batch.items.map((item) => Object.freeze({...item}))),
      cumulativeItems: Object.freeze(
        items.slice(0, batch.endIndex).map((item) => Object.freeze({...item})),
      ),
      cumulativeItemCount: batch.endIndex,
    }))),
  });
}

function stopped(state, batch, reasons) {
  return {
    ...state,
    ok: false,
    outcome: state.completedBatchCount > 0 ? 'partially_completed' : 'stopped',
    stop: {
      stopped: true,
      beforeNextBatch: true,
      batchIndex: batch.batchIndex,
      batchNumber: batch.batchNumber,
      primaryReason: reasons[0]?.reason ?? 'unknown_failure',
      reasons,
    },
  };
}

export async function runPremiereOverlayBatchPlan({
  plan,
  dryRun = false,
  batchPauseMs = PREMIERE_DEFAULT_BATCH_PAUSE_MS,
  importBatch,
  placeBatch,
  readAfterBatch,
  verifyBatch,
  isImportResponseFailure = () => false,
  isPlacementResponseFailure = () => false,
  pause = waitForPremiereUi,
}) {
  if (!plan || !Array.isArray(plan.batches)) throw new Error('A valid overlay batch plan is required.');
  if (dryRun) {
    return {
      ok: true,
      outcome: 'dry_run',
      batchCount: plan.batchCount,
      completedBatchCount: 0,
      importAttemptCount: 0,
      placementWriteAttemptCount: 0,
      cumulativeAppliedItems: [],
      batchResults: [],
      stop: {stopped: false, beforeNextBatch: false, primaryReason: null, reasons: []},
    };
  }
  for (const [label, callback] of [
    ['importBatch', importBatch],
    ['placeBatch', placeBatch],
    ['readAfterBatch', readAfterBatch],
    ['verifyBatch', verifyBatch],
    ['isImportResponseFailure', isImportResponseFailure],
    ['isPlacementResponseFailure', isPlacementResponseFailure],
    ['pause', pause],
  ]) {
    if (typeof callback !== 'function') throw new Error(`${label} callback is required.`);
  }

  const state = {
    batchCount: plan.batchCount,
    completedBatchCount: 0,
    importAttemptCount: 0,
    placementWriteAttemptCount: 0,
    cumulativeAppliedItems: [],
    batchResults: [],
  };

  for (const batch of plan.batches) {
    state.importAttemptCount += 1;
    let importResponse = null;
    let importError = null;
    try {
      importResponse = await importBatch(batch);
    } catch (error) {
      importError = error;
    }
    let importResponseFailed = false;
    let importValidationError = null;
    if (!importError) {
      try {
        importResponseFailed = isImportResponseFailure(importResponse, batch) === true;
      } catch (error) {
        importValidationError = error;
      }
    }
    if (importError || importResponseFailed || importValidationError) {
      const reason = importError
        ? classifyError(importError, 'import_response')
        : importValidationError
          ? 'import_response_validation_failed'
          : 'import_response_failed';
      const reasons = [{
        reason,
        phase: 'import',
        error: serializeError(importError || importValidationError),
      }];
      state.batchResults.push({
        batchIndex: batch.batchIndex,
        batchNumber: batch.batchNumber,
        itemCount: batch.items.length,
        cumulativeItemCount: batch.cumulativeItemCount,
        importAttempted: true,
        importResponse,
        importError: serializeError(importError),
        placementWriteAttempted: false,
        placementResponse: null,
        placementError: null,
        postReadSucceeded: false,
        postReadError: null,
        verification: null,
        verifiedApplied: false,
        stopReasons: reasons,
      });
      return stopped(state, batch, reasons);
    }

    state.placementWriteAttemptCount += 1;
    let placementResponse = null;
    let placementError = null;
    try {
      placementResponse = await placeBatch(batch, importResponse);
    } catch (error) {
      placementError = error;
    }

    let postRead = null;
    let postReadError = null;
    try {
      postRead = await readAfterBatch(batch, {importResponse, placementResponse, placementError});
    } catch (error) {
      postReadError = error;
    }

    let verification = null;
    let verificationError = null;
    if (!postReadError) {
      try {
        verification = await verifyBatch(batch, postRead, {
          importResponse,
          placementResponse,
          placementError,
        });
      } catch (error) {
        verificationError = error;
      }
    }
    if (verification?.ok === true) {
      state.completedBatchCount += 1;
      state.cumulativeAppliedItems = batch.cumulativeItems.map((item) => ({...item}));
    }

    const reasons = [];
    if (placementError) {
      reasons.push({
        reason: classifyError(placementError, 'placement_response'),
        phase: 'placement',
        error: serializeError(placementError),
      });
    } else {
      let placementResponseFailed = false;
      try {
        placementResponseFailed = isPlacementResponseFailure(placementResponse, batch) === true;
      } catch (error) {
        reasons.push({
          reason: 'placement_response_validation_failed',
          phase: 'placement',
          error: serializeError(error),
        });
      }
      if (placementResponseFailed) {
        reasons.push({reason: 'placement_response_failed', phase: 'placement', error: null});
      }
    }
    if (postReadError) {
      reasons.push({
        reason: 'post_read_failed',
        phase: 'post_read',
        error: serializeError(postReadError),
      });
    } else if (verificationError) {
      reasons.push({
        reason: 'invariant_verification_failed',
        phase: 'verification',
        error: serializeError(verificationError),
      });
    } else if (verification?.ok !== true) {
      reasons.push({
        reason: String(verification?.stopReason || 'invariant_mismatch'),
        phase: 'verification',
        error: null,
      });
    }

    state.batchResults.push({
      batchIndex: batch.batchIndex,
      batchNumber: batch.batchNumber,
      itemCount: batch.items.length,
      cumulativeItemCount: batch.cumulativeItemCount,
      importAttempted: true,
      importResponse,
      importError: null,
      placementWriteAttempted: true,
      placementResponse,
      placementError: serializeError(placementError),
      postReadSucceeded: postReadError === null,
      postReadError: serializeError(postReadError),
      verification,
      verificationError: serializeError(verificationError),
      verifiedApplied: verification?.ok === true,
      stopReasons: reasons,
    });

    if (reasons.length > 0) return stopped(state, batch, reasons);
    if (!batch.isLast) {
      try {
        await pause(batchPauseMs, batch);
      } catch (error) {
        return stopped(state, batch, [{
          reason: 'batch_pause_failed',
          phase: 'pause',
          error: serializeError(error),
        }]);
      }
    }
  }

  return {
    ...state,
    ok: true,
    outcome: 'completed',
    stop: {stopped: false, beforeNextBatch: false, primaryReason: null, reasons: []},
  };
}
