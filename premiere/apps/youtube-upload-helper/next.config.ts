import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(appRoot, "..", "..");

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  devIndicators: false,
  output: "standalone",
  outputFileTracingRoot: monorepoRoot,
  outputFileTracingExcludes: {
    "/*": [
      ".local/**/*",
      ".next/cache/**/*",
      "desktop-bundle/**/*",
      "dist-desktop/**/*",
      "**/*.{mp4,mov,mkv,avi,webm,wav,mp3,srt}",
      "**/*token*.json",
      "**/*secret*.json",
      "src/**/*",
      "scripts/**/*",
      "electron/**/*",
      "public/**/*",
      "README.md",
      ".env.example",
      "eslint.config.mjs",
      "next.config.ts",
      "package-lock.json",
      "postcss.config.mjs",
      "tsconfig.json",
      "tsconfig.tsbuildinfo",
    ],
  },
  turbopack: {
    root: monorepoRoot,
  },
};

export default nextConfig;
