export const PREMIERE_DEFAULT_BATCH_SIZE = 8;
export const PREMIERE_MAX_BATCH_SIZE = 20;
export const PREMIERE_DEFAULT_BATCH_PAUSE_MS = 1_000;
export const PREMIERE_MIN_BATCH_PAUSE_MS = 250;
export const PREMIERE_MAX_BATCH_PAUSE_MS = 60_000;

function integerInRange(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

export function resolvePremiereBatchSize(
  value,
  {
    defaultSize = PREMIERE_DEFAULT_BATCH_SIZE,
    hardMaximum = PREMIERE_MAX_BATCH_SIZE,
    label = "batch size",
  } = {},
) {
  const maximum = integerInRange(
    hardMaximum,
    1,
    PREMIERE_MAX_BATCH_SIZE,
    `${label} hard maximum`,
  );
  const fallback = integerInRange(defaultSize, 1, maximum, `${label} default`);
  if (value === undefined || value === null || value === "") return fallback;
  return integerInRange(value, 1, maximum, label);
}

export function resolvePremiereBatchPauseMs(
  value,
  {
    defaultPauseMs = PREMIERE_DEFAULT_BATCH_PAUSE_MS,
    minimumPauseMs = PREMIERE_MIN_BATCH_PAUSE_MS,
    maximumPauseMs = PREMIERE_MAX_BATCH_PAUSE_MS,
    label = "batch pause",
  } = {},
) {
  const minimum = integerInRange(
    minimumPauseMs,
    0,
    PREMIERE_MAX_BATCH_PAUSE_MS,
    `${label} minimum`,
  );
  const maximum = integerInRange(
    maximumPauseMs,
    minimum,
    PREMIERE_MAX_BATCH_PAUSE_MS,
    `${label} maximum`,
  );
  const fallback = integerInRange(
    defaultPauseMs,
    minimum,
    maximum,
    `${label} default`,
  );
  if (value === undefined || value === null || value === "") return fallback;
  return integerInRange(value, minimum, maximum, `${label} milliseconds`);
}

export function partitionPremiereMicroBatches(items, batchSize) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array.");
  const size = resolvePremiereBatchSize(batchSize);
  const batches = [];
  for (let startIndex = 0; startIndex < items.length; startIndex += size) {
    const batchItems = items.slice(startIndex, startIndex + size);
    batches.push({
      batchIndex: batches.length,
      startIndex,
      endIndex: startIndex + batchItems.length,
      items: batchItems,
    });
  }
  return batches.map((batch, batchIndex) => ({
    ...batch,
    batchNumber: batchIndex + 1,
    batchCount: batches.length,
    isLast: batchIndex === batches.length - 1,
  }));
}

export function waitForPremiereUi(milliseconds) {
  const pauseMs = resolvePremiereBatchPauseMs(milliseconds);
  return new Promise((resolve) => setTimeout(resolve, pauseMs));
}
