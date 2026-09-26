/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { scanArtifactTree } = require("./artifact-safety.cjs");

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deno-upload-package-scan-"));
}

test("accepts a sterile package", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "server.js"), "console.log('ok')\n");
  const result = scanArtifactTree({ root, budgetBytes: 1024 });
  assert.deepEqual(result.issues, []);
});

test("rejects runtime, media, secrets, and absolute paths", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".local"));
  fs.writeFileSync(path.join(root, ".local", "youtube-oauth-token.json"), "{}\n");
  fs.writeFileSync(path.join(root, "video.mp4"), "not-a-video");
  fs.writeFileSync(
    path.join(root, "config.js"),
    'const root = "E:\\\\DENO-Repos\\\\private";\n',
  );
  const result = scanArtifactTree({ root, budgetBytes: 1024 * 1024 });
  assert.ok(result.issues.some((issue) => issue.includes("runtime directory")));
  assert.ok(result.issues.some((issue) => issue.includes("media/caption")));
  assert.ok(result.issues.some((issue) => issue.includes("credential or token")));
  assert.ok(result.issues.some((issue) => issue.includes("absolute path")));
});

test("enforces package size budget", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "large.bin"), Buffer.alloc(2048));
  const result = scanArtifactTree({ root, budgetBytes: 1024 });
  assert.ok(result.issues.some((issue) => issue.includes("exceeds budget")));
});
