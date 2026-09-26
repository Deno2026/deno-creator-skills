// bridge/errors.js의 BridgeError 사본이다. UXP 모듈 로더가 상위 폴더("../")
// require를 거부해(2026-07-22 실측) handlers 폴더에서 bridge/errors.js를 직접
// 요구할 수 없다. 클래스가 둘이 되므로 instanceof 판별은 금지 — 판별이 필요한
// 쪽(bridge/errors.js toProtocolError)은 name/code 덕타이핑을 쓴다.
class BridgeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "BridgeError";
    this.code = code || "BRIDGE_ERROR";
    this.details = details === undefined ? null : details;
  }
}

module.exports = { BridgeError };
