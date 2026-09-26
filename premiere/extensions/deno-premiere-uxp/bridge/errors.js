class BridgeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "BridgeError";
    this.code = code || "BRIDGE_ERROR";
    this.details = details === undefined ? null : details;
  }
}

function toProtocolError(error) {
  // instanceof 대신 덕타이핑: handlers 쪽은 UXP 로더 제약으로 자체 BridgeError
  // 사본(handlers/errors.js)을 쓰므로 클래스 정체성이 다르다.
  if (error && error.name === "BridgeError" && error.code) {
    return {
      code: error.code,
      message: error.message,
      details: error.details
    };
  }

  return {
    code: "PREMIERE_ERROR",
    message: String((error && (error.message || error)) || "알 수 없는 오류"),
    details: null
  };
}

module.exports = { BridgeError, toProtocolError };
