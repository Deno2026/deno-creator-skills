const { BridgeError } = require("./errors.js");

// UXP 모듈 로더는 상위 폴더("../") 요구에서 Module not found를 던진다
// (2026-07-22 실측: "../handlers", parent "/bridge"). 핸들러 레지스트리는
// 여기서 직접 요구하지 않고 최상위 index.js가 주입한다 — 모든 require가
// 같은 폴더 또는 아래 방향만 향하게 유지할 것.
async function dispatch(getHandler, command, args, context) {
  const handler = getHandler(command);
  if (typeof handler.execute !== "function") {
    throw new BridgeError(
      "INVALID_HANDLER",
      `실행 함수가 없는 핸들러입니다: ${command}`
    );
  }

  const validatedArgs =
    typeof handler.validate === "function" ? handler.validate(args) : args;
  return await Promise.resolve(handler.execute(validatedArgs, context));
}

module.exports = { dispatch };
