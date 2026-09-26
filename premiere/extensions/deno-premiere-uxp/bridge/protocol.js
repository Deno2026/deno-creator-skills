const { storage } = require("uxp");
const {
  BRIDGE_DIRECTORY_URL,
  BRIDGE_FOLDER_NAME,
  MAX_REQUEST_BYTES,
  PROTOCOL_VERSION
} = require("./config.js");
const { BridgeError } = require("./errors.js");

const REQUEST_PATTERN = /^req_(\d{20})_([0-9a-f-]{36})\.json$/i;

function errorText(error) {
  return String((error && (error.message || error)) || "알 수 없는 오류");
}

async function openBridgeFolder() {
  let dataFolder;
  try {
    dataFolder = await storage.localFileSystem.getDataFolder();
  } catch (error) {
    throw new BridgeError(
      "PLUGIN_DATA_UNAVAILABLE",
      `${BRIDGE_DIRECTORY_URL}의 PluginData 루트를 열 수 없습니다.`,
      errorText(error)
    );
  }

  let bridgeFolder;
  let lookupError = null;
  try {
    bridgeFolder = await dataFolder.getEntry(BRIDGE_FOLDER_NAME);
  } catch (error) {
    lookupError = error;
  }

  if (!bridgeFolder) {
    try {
      bridgeFolder = await dataFolder.createFolder(BRIDGE_FOLDER_NAME);
    } catch (createError) {
      // Reload가 겹쳐 다른 실행이 먼저 만들었을 수 있으므로 한 번 다시 읽는다.
      try {
        bridgeFolder = await dataFolder.getEntry(BRIDGE_FOLDER_NAME);
      } catch (retryError) {
        throw new BridgeError(
          "BRIDGE_DIRECTORY_UNAVAILABLE",
          `${BRIDGE_DIRECTORY_URL} 폴더를 만들거나 열 수 없습니다.`,
          {
            lookup: errorText(lookupError),
            create: errorText(createError),
            retry: errorText(retryError)
          }
        );
      }
    }
  }

  if (!bridgeFolder || bridgeFolder.isFolder === false) {
    throw new BridgeError(
      "BRIDGE_DIRECTORY_INVALID",
      `${BRIDGE_DIRECTORY_URL} 항목이 폴더가 아닙니다.`,
      bridgeFolder && bridgeFolder.nativePath
    );
  }

  return bridgeFolder;
}

function parseRequestFilename(name) {
  const match = REQUEST_PATTERN.exec(String(name || ""));
  if (!match) return null;
  return { sequence: match[1], id: match[2].toLowerCase() };
}

function assertPlainObject(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError(
      "INVALID_REQUEST",
      `${fieldName}은 JSON object여야 합니다.`
    );
  }
}

function validateRequest(request, filenameParts) {
  assertPlainObject(request, "요청");

  if (request.protocolVersion !== PROTOCOL_VERSION) {
    throw new BridgeError(
      "UNSUPPORTED_PROTOCOL",
      `지원하지 않는 protocolVersion입니다: ${String(request.protocolVersion)}`
    );
  }
  if (request.id !== filenameParts.id) {
    throw new BridgeError("INVALID_REQUEST", "파일명과 요청 id가 다릅니다.");
  }
  if (request.sequence !== filenameParts.sequence) {
    throw new BridgeError(
      "INVALID_REQUEST",
      "파일명과 요청 sequence가 다릅니다."
    );
  }
  if (request.status !== "pending") {
    throw new BridgeError("INVALID_REQUEST", "요청 status는 pending이어야 합니다.");
  }
  if (!/^[a-z][a-z0-9_]*$/.test(String(request.command || ""))) {
    throw new BridgeError("INVALID_REQUEST", "command 이름이 올바르지 않습니다.");
  }
  assertPlainObject(request.args, "args");

  return request;
}

async function claimRequest(folder, requestEntry) {
  const parts = parseRequestFilename(requestEntry.name);
  if (!parts) {
    throw new BridgeError("INVALID_REQUEST", "요청 파일명이 올바르지 않습니다.");
  }

  const runningName = `run_${parts.sequence}_${parts.id}.json`;
  await requestEntry.moveTo(folder, {
    newName: runningName,
    overwrite: false
  });

  const runningEntry = await folder.getEntry(runningName);
  return { entry: runningEntry, parts };
}

async function readClaimedRequest(claimed) {
  const source = await claimed.entry.read();
  if (source.length > MAX_REQUEST_BYTES) {
    throw new BridgeError(
      "REQUEST_TOO_LARGE",
      `요청이 ${MAX_REQUEST_BYTES}바이트 제한을 넘었습니다.`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new BridgeError(
      "INVALID_JSON",
      "요청 JSON을 읽을 수 없습니다.",
      String(error && (error.message || error))
    );
  }

  return validateRequest(parsed, claimed.parts);
}

function createEnvelope(request, status, fields) {
  const now = new Date().toISOString();
  const values = fields || {};
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: request.id,
    sequence: request.sequence,
    command: request.command,
    status,
    ok: status === "done" ? true : status === "error" ? false : null,
    progress: values.progress || null,
    data: status === "done" ? values.data : null,
    error: status === "error" ? values.error : null,
    createdAt: request.createdAt,
    startedAt: values.startedAt,
    updatedAt: now,
    completedAt: status === "done" || status === "error" ? now : null
  };
}

async function writeResponseAtomically(folder, envelope) {
  const finalName = `res_${envelope.sequence}_${envelope.id}.json`;
  const nonce = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const tempName = `.tmp_res_${envelope.sequence}_${envelope.id}_${nonce}`;
  const tempEntry = await folder.createFile(tempName, { overwrite: false });

  try {
    await tempEntry.write(JSON.stringify(envelope));
    await tempEntry.moveTo(folder, {
      newName: finalName,
      overwrite: true
    });
  } catch (error) {
    try {
      await tempEntry.delete();
    } catch (_deleteError) {
      // The next stale-file cleanup can remove an abandoned temp file.
    }
    throw error;
  }
}

module.exports = {
  REQUEST_PATTERN,
  claimRequest,
  createEnvelope,
  openBridgeFolder,
  readClaimedRequest,
  writeResponseAtomically
};
