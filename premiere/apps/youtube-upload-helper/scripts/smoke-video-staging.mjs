import { randomUUID } from "node:crypto";

const baseUrl = process.env.UPLOAD_HELPER_URL || "http://127.0.0.1:3000";
const endpoint = `${baseUrl}/api/upload-request/video-staging`;
const stageIds = [];

async function command(body, expectedStatus = 200) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(`Expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function putChunk(uploadId, offset, bytes, declaredSize = bytes.byteLength, expectedStatus = 200) {
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: {
      Origin: baseUrl,
      "content-type": "application/octet-stream",
      "x-upload-id": uploadId,
      "x-upload-offset": String(offset),
      "x-upload-chunk-size": String(declaredSize),
    },
    body: bytes,
  });
  const payload = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(`Expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function removeStage(uploadId) {
  await fetch(endpoint, {
    method: "DELETE",
    headers: { Origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ uploadId }),
  }).catch(() => undefined);
}

try {
  const source = new TextEncoder().encode("chunked-smoke-video");
  const initialized = await command({
    action: "init",
    videoFingerprint: `smoke-${randomUUID()}`,
    file: {
      name: "대용량 스모크 영상.mp4",
      type: "video/mp4",
      size: source.byteLength,
      lastModified: Date.now(),
    },
  });
  const uploadId = initialized.stage?.uploadId;
  if (!uploadId || initialized.stage.chunkSize !== 8 * 1024 * 1024) {
    throw new Error(`Unexpected init response: ${JSON.stringify(initialized)}`);
  }
  stageIds.push(uploadId);

  const wrongOffset = await putChunk(uploadId, 3, source.slice(0, 4), 4, 409);
  if (
    wrongOffset?.error?.code !== "STAGE_OFFSET_MISMATCH" ||
    wrongOffset?.error?.detail?.expectedOffset !== 0
  ) {
    throw new Error("Out-of-order chunk was not rejected without advancing the stage.");
  }
  const largeOffset = await putChunk(uploadId, 2 ** 31 + 5, new Uint8Array([9]), 1, 409);
  if (largeOffset?.error?.detail?.receivedOffset !== 2 ** 31 + 5) {
    throw new Error("Chunk offsets above the signed 32-bit boundary were not preserved exactly.");
  }

  const incomplete = await command({ action: "finalize", uploadId }, 409);
  if (incomplete?.error?.code !== "STAGE_INCOMPLETE") {
    throw new Error("Incomplete stage was not rejected at finalize.");
  }

  const firstBytes = source.slice(0, 7);
  const first = await putChunk(uploadId, 0, firstBytes);
  if (first.stage?.receivedBytes !== firstBytes.byteLength || first.alreadyReceived) {
    throw new Error("First chunk was not committed exactly once.");
  }

  const duplicate = await putChunk(uploadId, 0, firstBytes);
  if (!duplicate.alreadyReceived || duplicate.stage?.receivedBytes !== firstBytes.byteLength) {
    throw new Error("Duplicate chunk did not receive an idempotent response.");
  }

  const remainder = source.slice(firstBytes.byteLength);
  const second = await putChunk(uploadId, firstBytes.byteLength, remainder);
  if (second.stage?.receivedBytes !== source.byteLength) {
    throw new Error("Final chunk byte count mismatch.");
  }

  const finalized = await command({ action: "finalize", uploadId });
  if (finalized.stage?.status !== "complete" || finalized.stage.receivedBytes !== source.byteLength) {
    throw new Error("Completed stage was not locked at the exact file size.");
  }

  const status = await command({ action: "status", uploadId });
  const serialized = JSON.stringify(status);
  if (/\b[A-Za-z]:[\\/]/.test(serialized) || serialized.includes("upload-video-staging")) {
    throw new Error("Staging API exposed a local filesystem path.");
  }

  const mismatchInit = await command({
    action: "init",
    videoFingerprint: `mismatch-${randomUUID()}`,
    file: { name: "mismatch.mp4", type: "video/mp4", size: 4, lastModified: Date.now() },
  });
  const mismatchId = mismatchInit.stage.uploadId;
  stageIds.push(mismatchId);
  const lengthMismatch = await putChunk(
    mismatchId,
    0,
    new Uint8Array([1, 2, 3, 4]),
    3,
    400,
  );
  if (lengthMismatch?.error?.code !== "CHUNK_LENGTH_MISMATCH") {
    throw new Error("Declared chunk-length mismatch was not rejected.");
  }
  const mismatchStatus = await command({ action: "status", uploadId: mismatchId });
  if (mismatchStatus.stage?.receivedBytes !== 0) {
    throw new Error("Rejected chunk advanced the committed offset.");
  }

  const traversal = await command({ action: "status", uploadId: "../outside" }, 400);
  if (traversal?.error?.code !== "INVALID_STAGE_ID") {
    throw new Error("Unsafe staging ID was not rejected.");
  }

  const proxyBoundaryBytes = new Uint8Array(8 * 1024 * 1024);
  proxyBoundaryBytes[0] = 1;
  proxyBoundaryBytes[proxyBoundaryBytes.length - 1] = 2;
  const proxyBoundaryInit = await command({
    action: "init",
    videoFingerprint: `proxy-boundary-${randomUUID()}`,
    file: {
      name: "proxy-boundary.mp4",
      type: "video/mp4",
      size: proxyBoundaryBytes.byteLength,
      lastModified: Date.now(),
    },
  });
  const proxyBoundaryId = proxyBoundaryInit.stage.uploadId;
  stageIds.push(proxyBoundaryId);
  const proxyBoundary = await putChunk(proxyBoundaryId, 0, proxyBoundaryBytes);
  if (proxyBoundary.stage?.receivedBytes !== proxyBoundaryBytes.byteLength) {
    throw new Error("The full 8MiB chunk did not survive the protected Next proxy path.");
  }
  const proxyBoundaryFinal = await command({ action: "finalize", uploadId: proxyBoundaryId });
  if (proxyBoundaryFinal.stage?.status !== "complete" || !proxyBoundaryFinal.stage?.sha256) {
    throw new Error("The 8MiB proxy-boundary stage did not complete with a SHA-256 lock.");
  }

  console.log(
    JSON.stringify({
      ok: true,
      chunkedRawUpload: true,
      outOfOrderRejected: true,
      incompleteFinalizeRejected: true,
      duplicateChunkIdempotent: true,
      exactLengthVerified: true,
      localPathHidden: true,
      traversalRejected: true,
      signed32BitOffsetBoundarySafe: true,
      protectedProxyAcceptedExact8MiBChunk: true,
      completedVideoSha256Locked: true,
    }),
  );
} finally {
  await Promise.all(stageIds.map(removeStage));
}
