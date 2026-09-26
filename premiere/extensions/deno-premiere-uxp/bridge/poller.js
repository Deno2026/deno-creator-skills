const { dispatch } = require("./dispatcher.js");
const { BridgeError, toProtocolError } = require("./errors.js");
const {
  BRIDGE_DIRECTORY_URL,
  POLL_INTERVAL_MS,
  STORAGE_STAGE_WARNING_MS
} = require("./config.js");
const {
  REQUEST_PATTERN,
  claimRequest,
  createEnvelope,
  openBridgeFolder,
  readClaimedRequest,
  writeResponseAtomically
} = require("./protocol.js");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeWithRetry(folder, envelope) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeResponseAtomically(folder, envelope);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await delay(25 * (attempt + 1));
    }
  }
  throw lastError;
}

function errorMessage(error) {
  return String((error && (error.message || error)) || "알 수 없는 오류");
}

function wrapStageError(stage, error) {
  if (error && error.bridgeStage === stage) return error;
  const wrapped = new BridgeError(
    (error && error.code) || "BRIDGE_IO_ERROR",
    `${stage} 실패: ${errorMessage(error)}`,
    error && error.details !== undefined ? error.details : null
  );
  wrapped.bridgeStage = stage;
  return wrapped;
}

class BridgePoller {
  constructor(options) {
    const { getHandler, ...callbacks } = options || {};
    // 핸들러 레지스트리는 index.js가 주입한다(../handlers 직접 require는
    // UXP 로더가 거부 — dispatcher.js 상단 주석 참조).
    this.getHandler = getHandler;
    this.callbacks = callbacks;
    this.running = false;
    this.polling = false;
    this.timer = null;
    this.folder = null;
  }

  notify(name, value) {
    const callback = this.callbacks[name];
    if (typeof callback === "function") callback(value);
  }

  async runStage(stage, operation, options) {
    // quiet: 0.2초마다 도는 일상 단계(목록 조회)는 시작 알림을 생략한다.
    // 매번 알리면 "폴링 중"과 고속 교차해 깜빡임이 된다(2026-07-22 사용자 보고).
    // 지연 경고와 오류 알림은 quiet여도 그대로 나간다.
    if (!options || !options.quiet) this.notify("onStatus", `${stage} 중`);
    const warningTimer = setTimeout(() => {
      if (!this.running) return;
      this.notify("onStatus", `${stage} 지연`);
      this.notify(
        "onError",
        `${stage}: ${STORAGE_STAGE_WARNING_MS}ms 동안 완료되지 않았습니다.`
      );
    }, STORAGE_STAGE_WARNING_MS);

    try {
      return await operation();
    } catch (error) {
      const wrapped = wrapStageError(stage, error);
      wrapped.uiReported = true;
      this.notify("onStatus", `${stage} 오류`);
      this.notify("onError", wrapped);
      throw wrapped;
    } finally {
      clearTimeout(warningTimer);
    }
  }

  async getFolder() {
    if (!this.folder) {
      this.folder = await this.runStage("폴더 열기", () => openBridgeFolder());
      this.notify("onBridgeFolder", {
        url: BRIDGE_DIRECTORY_URL,
        nativePath: this.folder.nativePath || ""
      });
    }
    return this.folder;
  }

  async processRequestEntry(folder, entry) {
    const claimed = await this.runStage("요청 점유", () =>
      claimRequest(folder, entry)
    );
    const startedAt = new Date().toISOString();
    let request = {
      protocolVersion: 1,
      id: claimed.parts.id,
      sequence: claimed.parts.sequence,
      command: "invalid_request",
      args: {},
      createdAt: startedAt
    };
    let finalWritten = false;

    try {
      request = await this.runStage("요청 읽기", () =>
        readClaimedRequest(claimed)
      );
      this.notify("onCommand", request.command);

      await this.runStage("응답 쓰기", () =>
        writeWithRetry(
          folder,
          createEnvelope(request, "running", {
            startedAt,
            progress: { message: "명령을 시작했습니다." }
          })
        )
      );

      const context = {
        reportProgress: async (progress) =>
          this.runStage("응답 쓰기", () =>
            writeWithRetry(
              folder,
              createEnvelope(request, "running", { startedAt, progress })
            )
          )
      };

      this.notify("onStatus", "명령 실행 중");
      const data = await dispatch(
        this.getHandler,
        request.command,
        request.args,
        context
      );
      await this.runStage("응답 쓰기", () =>
        writeWithRetry(
          folder,
          createEnvelope(request, "done", { startedAt, data })
        )
      );
      finalWritten = true;
      this.notify("onSuccess", request.command);
    } catch (error) {
      const protocolError = toProtocolError(error);
      try {
        await this.runStage("오류 응답 쓰기", () =>
          writeWithRetry(
            folder,
            createEnvelope(request, "error", {
              startedAt,
              error: protocolError
            })
          )
        );
        finalWritten = true;
      } catch (responseError) {
        if (!responseError || !responseError.uiReported) {
          this.notify("onStatus", "오류 응답 쓰기 오류");
          this.notify("onError", responseError);
        }
        return;
      }
      this.notify("onCommand", request.command);
      this.notify("onError", protocolError.message);
    } finally {
      if (finalWritten) {
        try {
          await claimed.entry.delete();
        } catch (_deleteError) {
          // A 24-hour stale-file cleanup owns an undeletable run file.
        }
        this.notify("onProcessed", request.command);
      }
    }
  }

  async pollOnce() {
    if (!this.running || this.polling) return;
    this.polling = true;

    try {
      const folder = await this.getFolder();
      const entries = await this.runStage("목록 조회", () => folder.getEntries(), {
        quiet: true
      });
      const requests = Array.from(entries || [])
        .filter((entry) => entry.isFile && REQUEST_PATTERN.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name));

      // Intentionally leave the backlog for later 200ms poll cycles. Processing only
      // one request here gives Premiere's UI loop a yield between bridge commands.
      const entry = requests[0];
      if (entry && this.running) {
        try {
          await this.processRequestEntry(folder, entry);
        } catch (error) {
          if (!error || !error.uiReported) {
            this.notify("onStatus", "요청 처리 오류");
            this.notify("onError", error);
          }
        }
      }
      if (this.running) this.notify("onStatus", "폴링 중");
    } catch (error) {
      this.folder = null;
      if (!error || !error.uiReported) {
        this.notify("onStatus", "폴링 오류");
        this.notify("onError", error);
      }
    } finally {
      this.polling = false;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.notify("onStatus", "시작 중");
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), POLL_INTERVAL_MS);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.folder = null;
    this.notify("onStatus", "중지됨");
  }
}

module.exports = { BridgePoller };
