import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function saveBrowserFileToTemp(file: File) {
  const targetDir = path.join(os.tmpdir(), "studio-uploader");
  await mkdir(targetDir, { recursive: true });

  const filePath = path.join(
    targetDir,
    `${Date.now()}-${Math.random().toString(16).slice(2)}-${sanitizeFileName(file.name)}`,
  );

  await pipeline(
    Readable.fromWeb(file.stream() as unknown as NodeReadableStream),
    createWriteStream(filePath),
  );

  return {
    filePath,
    cleanup: async () => {
      await rm(filePath, { force: true });
    },
  };
}
