import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const CHILD_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 32 * 1024;
const MAX_FAILURE_OUTPUT_CHARS = 4_000;

const TESTS = [
  {
    path: "servers/premiere-uxp-mcp/offline-handler-self-test.mjs",
    required: true,
  },
  {
    path: "servers/premiere-uxp-mcp/self-test.mjs",
    required: true,
  },
  {
    path: "servers/premiere-control-mcp/self-test.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-sequence-structure-diff.mjs",
    required: false,
  },
  {
    path: "scripts/self-test-premiere-cep-lock.mjs",
    required: false,
  },
  {
    path: "scripts/self-test-premiere-mcp-resource-policy.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-premiere-micro-batch.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-premiere-cut-batches.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-production-request-router.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-production-state.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-production-task-envelope.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-production-delivery.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-publishing-handoff.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-thumbnail-package.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-propose-waveform-only-cuts.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-premiere-direct-cut-inputs.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-premiere-placement-inputs.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-premiere-repeat-cuts.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-premiere-semantic-waveform-safety.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-premiere-direct-cut-manifest.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-apply-premiere-direct-razor-cuts.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-premiere-av-link-repair.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-production-motion-kernel.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-production-overlay-placement.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-premiere-caption-cues.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-compare-caption-aligners.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-streaming-waveform-energy.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-place-overlays-micro-batches.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-import-active-clips-micro-batches.mjs",
    required: true,
  },
  {
    path: "scripts/self-test-validate-srt.mjs",
    required: false,
  },
  {
    path: "scripts/self-test-audio-source-groups.mjs",
    required: false,
  },
  {
    path: "scripts/self-test-propose-premiere-audio-balance.mjs",
    required: false,
  },
  {
    path: "scripts/self-test-apply-premiere-audio-balance.mjs",
    required: false,
  },
  {
    path: "scripts/self-test-verify-program-loudness.mjs",
    required: false,
  },
];

function appendBounded(capture, chunk) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  capture.totalBytes += bytes.length;

  if (bytes.length >= MAX_CAPTURE_BYTES) {
    capture.buffer = bytes.subarray(bytes.length - MAX_CAPTURE_BYTES);
    return;
  }

  const combined = Buffer.concat([capture.buffer, bytes]);
  capture.buffer =
    combined.length > MAX_CAPTURE_BYTES
      ? combined.subarray(combined.length - MAX_CAPTURE_BYTES)
      : combined;
}

function finishCapture(capture) {
  const omittedBytes = Math.max(0, capture.totalBytes - capture.buffer.length);
  const text = capture.buffer.toString("utf8");
  return omittedBytes > 0
    ? `[... ${omittedBytes} earlier bytes omitted ...]\n${text}`
    : text;
}

function runTest(relativePath) {
  const absolutePath = path.join(REPO_ROOT, relativePath);
  const startedAt = performance.now();
  const stdout = { buffer: Buffer.alloc(0), totalBytes: 0 };
  const stderr = { buffer: Buffer.alloc(0), totalBytes: 0 };

  return new Promise((resolve) => {
    let timedOut = false;
    let spawnError = null;

    const child = spawn(process.execPath, [absolutePath], {
      cwd: REPO_ROOT,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout.on("data", (chunk) => appendBounded(stdout, chunk));
    child.stderr.on("data", (chunk) => appendBounded(stderr, chunk));
    child.on("error", (error) => {
      spawnError = error;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CHILD_TIMEOUT_MS);

    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      const elapsedMs = Math.round(performance.now() - startedAt);
      const capturedStderr = finishCapture(stderr);
      resolve({
        path: relativePath,
        status:
          !timedOut && !spawnError && exitCode === 0 ? "passed" : "failed",
        exitCode,
        signal,
        stdout: finishCapture(stdout),
        stderr: spawnError
          ? `${capturedStderr}${capturedStderr ? "\n" : ""}${spawnError.stack ?? spawnError.message}`
          : capturedStderr,
        elapsedMs,
        timedOut,
      });
    });
  });
}

function formatElapsed(elapsedMs) {
  return `${(elapsedMs / 1_000).toFixed(2)}s`;
}

function failureReason(result) {
  if (result.missing) return "required file missing";
  if (result.timedOut) return `timed out after ${CHILD_TIMEOUT_MS / 1_000}s`;
  if (result.exitCode !== null) return `exit ${result.exitCode}`;
  if (result.signal) return `signal ${result.signal}`;
  return "process error";
}

function printFailureOutput(label, value) {
  const normalized = value.trim();
  if (!normalized) return;
  const clipped =
    normalized.length > MAX_FAILURE_OUTPUT_CHARS
      ? `[... ${normalized.length - MAX_FAILURE_OUTPUT_CHARS} earlier characters omitted ...]\n${normalized.slice(-MAX_FAILURE_OUTPUT_CHARS)}`
      : normalized;
  console.error(`  ${label}:\n${clipped}`);
}

const startedAt = performance.now();
const results = [];

for (const test of TESTS) {
  const absolutePath = path.join(REPO_ROOT, test.path);
  if (!fs.existsSync(absolutePath)) {
    results.push({
      path: test.path,
      status: test.required ? "failed" : "skipped",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: test.required ? `Required self-test is missing: ${test.path}` : "",
      elapsedMs: 0,
      timedOut: false,
      missing: true,
    });
    continue;
  }

  // Deliberately serial: these tests inspect shared generated registries and fixtures.
  results.push(await runTest(test.path));
}

const executed = results.filter((result) => result.status !== "skipped");
const passed = results.filter((result) => result.status === "passed");
const failed = results.filter((result) => result.status === "failed");
const skipped = results.filter((result) => result.status === "skipped");
const elapsedMs = Math.round(performance.now() - startedAt);

for (const result of results) {
  if (result.status === "passed") {
    console.log(`[PASS] ${result.path} (${formatElapsed(result.elapsedMs)})`);
  } else if (result.status === "skipped") {
    console.log(`[SKIP] ${result.path} (optional file absent)`);
  } else {
    console.error(
      `[FAIL] ${result.path} (${failureReason(result)}, ${formatElapsed(result.elapsedMs)})`,
    );
    printFailureOutput("stdout", result.stdout);
    printFailureOutput("stderr", result.stderr);
  }
}

if (failed.length > 0) {
  console.error(
    `Premiere production core offline gate failed: ${passed.length}/${executed.length} passed, ${failed.length} failed, ${skipped.length} skipped (${formatElapsed(elapsedMs)}).`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `Premiere production core offline gate passed: ${passed.length}/${executed.length} passed, ${skipped.length} skipped (${formatElapsed(elapsedMs)}).`,
  );
}
