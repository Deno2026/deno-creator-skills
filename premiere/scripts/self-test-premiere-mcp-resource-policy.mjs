import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquirePremiereCepLock } from "./lib/premiere-cep-lock.mjs";
import {
  classifyToolSafety,
  executePremiereMcpCallWithRetry,
  parseArgs,
  PREMIERE_MCP_DEFAULT_RETRY_PAUSE_MS,
  resolveRetryPolicy,
  resolveRetryPauseMs,
} from "./premiere-mcp-call.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");

const readPolicy = resolveRetryPolicy("get_premiere_state", 1);
assert.deepEqual(readPolicy, {
  readOnly: true,
  mutation: false,
  dangerous: false,
  requestedRetries: 1,
  effectiveRetries: 1,
  maxAttempts: 2,
  retrySuppressed: false,
});

const writePolicy = resolveRetryPolicy("add_marker", 7);
assert.equal(writePolicy.mutation, true);
assert.equal(writePolicy.dangerous, false);
assert.equal(writePolicy.effectiveRetries, 0);
assert.equal(writePolicy.maxAttempts, 1);
assert.equal(writePolicy.retrySuppressed, true);

const dangerousPolicy = resolveRetryPolicy("batch_add_transitions", 7);
assert.equal(dangerousPolicy.mutation, true);
assert.equal(dangerousPolicy.dangerous, true);
assert.equal(dangerousPolicy.effectiveRetries, 0);
assert.equal(dangerousPolicy.maxAttempts, 1);

assert.deepEqual(classifyToolSafety("future_mutation_tool"), {
  readOnly: false,
  mutation: true,
  dangerous: false,
});
assert.equal(resolveRetryPolicy("future_mutation_tool", 1).maxAttempts, 1);

const readRetryEvents = [];
let readCallCount = 0;
const readRetryExecution = await executePremiereMcpCallWithRetry({
  toolName: "get_premiere_state",
  requestedRetries: 1,
  retryPauseMs: PREMIERE_MCP_DEFAULT_RETRY_PAUSE_MS,
  callTool() {
    readCallCount += 1;
    readRetryEvents.push(`call:${readCallCount}`);
    return readCallCount === 1 ? "Error: request timed out" : "read-ok";
  },
  wait(milliseconds) {
    readRetryEvents.push(`wait:${milliseconds}`);
  },
});
assert.deepEqual(readRetryEvents, ["call:1", "wait:1000", "call:2"]);
assert.equal(readRetryExecution.payload, "read-ok");
assert.equal(readRetryExecution.attemptCount, 2);
assert.equal(readRetryExecution.retryPauseCount, 1);

for (const toolName of [
  "add_marker",
  "batch_add_transitions",
  "future_mutation_tool",
]) {
  const mutationEvents = [];
  const mutationExecution = await executePremiereMcpCallWithRetry({
    toolName,
    requestedRetries: 7,
    retryPauseMs: PREMIERE_MCP_DEFAULT_RETRY_PAUSE_MS,
    callTool() {
      mutationEvents.push("call");
      return "Error: request timed out";
    },
    wait(milliseconds) {
      mutationEvents.push(`wait:${milliseconds}`);
    },
  });
  assert.deepEqual(mutationEvents, ["call"], toolName);
  assert.equal(mutationExecution.attemptCount, 1, toolName);
  assert.equal(mutationExecution.retryPauseCount, 0, toolName);
}

assert.equal(parseArgs([]).options.retries, 1);
assert.equal(
  parseArgs([]).options.retryPauseMs,
  PREMIERE_MCP_DEFAULT_RETRY_PAUSE_MS,
);
assert.equal(parseArgs(["--retries", "0"]).options.retries, 0);
assert.equal(parseArgs(["--retry-pause-ms", "250"]).options.retryPauseMs, 250);
assert.equal(parseArgs(["--retry-pause-ms", "60000"]).options.retryPauseMs, 60_000);
assert.equal(resolveRetryPauseMs(), 1_000);
assert.throws(() => resolveRetryPauseMs(249), /250 to 60000/);
assert.throws(() => resolveRetryPauseMs(60_001), /250 to 60000/);
assert.throws(
  () => parseArgs(["--retries", "-1"]),
  /non-negative integer/,
);
assert.throws(
  () => parseArgs(["--retries", "not-a-number"]),
  /non-negative integer/,
);

const sharedSource = readFileSync(
  path.join(repoRoot, "extensions", "deno-premiere-uxp", "handlers", "shared.js"),
  "utf8",
);
assert.match(sharedSource, /const MAX_CONCURRENT_READS = 4;/);

const pollerSource = readFileSync(
  path.join(repoRoot, "extensions", "deno-premiere-uxp", "bridge", "poller.js"),
  "utf8",
);
assert.match(pollerSource, /const entry = requests\[0\];/);
assert.doesNotMatch(pollerSource, /for \(const entry of requests\)/);
const pollerConfigSource = readFileSync(
  path.join(repoRoot, "extensions", "deno-premiere-uxp", "bridge", "config.js"),
  "utf8",
);
assert.match(pollerConfigSource, /POLL_INTERVAL_MS: 200,/);

const callToolPath = path.join(
  repoRoot,
  "servers",
  "premiere-uxp-mcp",
  "call-tool.mjs",
);
const lockDirectory = await mkdtemp(
  path.join(os.tmpdir(), "premiere-shared-lock-test-"),
);
const heldLock = await acquirePremiereCepLock({
  bridgeDirectory: lockDirectory,
  tool: "offline-resource-policy-test",
});
try {
  const busyResult = spawnSync(process.execPath, [callToolPath, "ping"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PREMIERE_TEMP_DIR: lockDirectory,
      // A busy-lock failure must happen before the UXP MCP SDK is resolved.
      PREMIERE_MCP_ROOT: path.join(lockDirectory, "missing-sdk"),
    },
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.notEqual(busyResult.status, 0);
  assert.match(busyResult.stderr, /already in use/);
  assert.doesNotMatch(busyResult.stderr, /Cannot find|missing-sdk/);
} finally {
  await heldLock.release();
  await rm(lockDirectory, { recursive: true, force: true });
}

console.log("Premiere MCP and UXP resource policy self-test passed.");
