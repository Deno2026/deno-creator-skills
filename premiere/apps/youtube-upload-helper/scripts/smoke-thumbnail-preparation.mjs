import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "deno-thumbnail-smoke-"));
process.env.DENO_PRODUCTION_ROOT = repoRoot;
process.env.DENO_UPLOAD_HELPER_RUNTIME_ROOT = path.join(tempRoot, "runtime");
const uploaderModule = await import(
  pathToFileURL(
    path.join(repoRoot, "packages", "publishing-core", "tools", "upload_korean_first_youtube.cjs"),
  ).href
);
const { prepareThumbnailForYouTube } = uploaderModule.default;
try {
  const sourcePath = path.join(tempRoot, "large-thumbnail.ppm");
  const outputDir = path.join(tempRoot, "verification");
  await mkdir(outputDir, { recursive: true });
  const width = 2048;
  const height = 1152;
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < pixels.length; index += 3) {
    const pixel = index / 3;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    pixels[index] = (x * 13 + y * 3) % 256;
    pixels[index + 1] = (x * 5 + y * 11) % 256;
    pixels[index + 2] = (x * 7 + y * 17) % 256;
  }
  await writeFile(sourcePath, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]));
  const sourceStat = await stat(sourcePath);
  assert.ok(sourceStat.size > 2 * 1024 * 1024);

  const prepared = await prepareThumbnailForYouTube(sourcePath, sourceStat, outputDir);
  assert.equal(prepared.converted, true);
  assert.equal(prepared.mimeType, "image/jpeg");
  assert.ok(prepared.size > 0 && prepared.size <= 2 * 1024 * 1024);
  assert.equal((await stat(prepared.path)).size, prepared.size);

  const smallPath = path.join(tempRoot, "small-thumbnail.png");
  await writeFile(smallPath, Buffer.from("small-thumbnail"));
  const smallStat = await stat(smallPath);
  const unchanged = await prepareThumbnailForYouTube(smallPath, smallStat, outputDir);
  assert.equal(unchanged.converted, false);
  assert.equal(unchanged.path, smallPath);
  assert.equal(unchanged.mimeType, "image/png");

  console.log(
    JSON.stringify({
      ok: true,
      oversizedThumbnailConvertedBelowTwoMiB: true,
      smallThumbnailPreserved: true,
      preparedBytes: prepared.size,
    }),
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
