// 부팅 실패도 화면에 남긴다: 이 버전 문자열이 패널에 안 보이면 JS가 아예
// 실행되지 않은 것(캐시/로드 문제), 보이는데 "부팅 오류"면 아래 catch가 원인을
// lastError에 그대로 적는다. (2026-07-22 — 조용한 사망 이틀째 근절 장치)
const PANEL_VERSION = "v0.6.2 (2026-08-25 stable official surface)";

function paintBoot(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(text);
}

try {
  paintBoot("panelVersion", PANEL_VERSION);

const { entrypoints } = require("uxp");
const { BRIDGE_DIRECTORY_URL } = require("./bridge/config.js");
const { BridgePoller } = require("./bridge/poller.js");
// 폴더명("./handlers")이 아니라 파일까지 명시한다 — UXP 로더는 폴더 요구 시
// index.js 자동 해석을 지원하지 않을 수 있다(2026-07-22 모듈 해석 실패 부검).
const {
  getHandler,
  listHandlerNames,
  shutdownHandlers
} = require("./handlers/index.js");

const state = {
  status: "미시작",
  processedCount: 0,
  lastCommand: "없음",
  lastError: "없음",
  bridgeDirectoryNative: "확인 중",
  uiBound: false
};

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = String(value);
}

function render() {
  const status = document.getElementById("pollStatus");
  if (status) {
    status.textContent = state.status;
    status.className = `value ${
      state.status === "폴링 중"
        ? "status-running"
        : /오류|지연/.test(state.status)
          ? "status-error"
          : ""
    }`;
  }

  setText("processedCount", state.processedCount);
  setText("lastCommand", state.lastCommand);
  setText("lastError", state.lastError);
  setText("bridgeDirectoryUrl", BRIDGE_DIRECTORY_URL);
  setText("bridgeDirectoryNative", state.bridgeDirectoryNative);
}

function errorMessage(error) {
  return String((error && (error.message || error)) || "알 수 없는 오류");
}

const poller = new BridgePoller({
  getHandler,
  onStatus(status) {
    state.status = status;
    render();
  },
  onCommand(command) {
    state.lastCommand = command || "없음";
    render();
  },
  onSuccess() {
    state.lastError = "없음";
    render();
  },
  onError(error) {
    state.lastError = errorMessage(error);
    render();
  },
  onProcessed() {
    state.processedCount += 1;
    render();
  },
  onBridgeFolder(folder) {
    state.bridgeDirectoryNative =
      (folder && folder.nativePath) || "nativePath를 확인할 수 없음";
    render();
  }
});

function setupUi() {
  if (state.uiBound) return;
  state.uiBound = true;
  render();
}

entrypoints.setup({
  plugin: {
    create() {
      setupUi();
      poller.start();
    },
    destroy() {
      poller.stop();
      shutdownHandlers();
    }
  },
  panels: {
    denoPremiereUxp: {
      show() {
        setupUi();
        poller.start();
      },
      hide() {
        // Docked/background panels keep polling.
      },
      destroy() {
        // The plugin-level lifecycle owns the bridge. Closing or destroying the
        // optional diagnostics panel must not disable background polling.
      }
    }
  }
});

setupUi();

// 패널이 이미 떠 있는 상태에서 Reload하면 show()가 오지 않는다(2026-07-22 확인).
// 폴링 시작을 show 이벤트에만 맡기지 말고 모듈 로드 시점에도 건다.
// start()에는 중복 방지 가드가 있어 show()와 겹쳐도 안전하다.
poller.start();

console.log(`DENO Premiere UXP handlers: ${listHandlerNames().join(", ")}`);
} catch (bootError) {
  paintBoot("panelVersion", `${PANEL_VERSION} — 부팅 실패`);
  paintBoot("pollStatus", "부팅 오류");
  paintBoot(
    "lastError",
    String((bootError && (bootError.stack || bootError.message)) || bootError)
  );
}
