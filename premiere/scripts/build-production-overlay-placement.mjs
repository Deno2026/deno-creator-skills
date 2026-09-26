#!/usr/bin/env node

import {randomUUID} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {buildProductionOverlayPlacement} from './lib/production-overlay-placement.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const fail = (message) => {
  throw new Error(message);
};

const parseArgs = (argv) => {
  const options = {};
  const valueOptions = new Map([
    ['--alpha-manifest', 'alphaManifestPath'],
    ['--capture-dir', 'captureDir'],
    ['--production', 'expectedProduction'],
    ['--generation', 'expectedGeneration'],
    ['--track', 'targetVideoTrackIndex'],
    ['--out', 'outputManifestPath'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    const key = valueOptions.get(argument);
    if (!key) fail(`알 수 없는 인자입니다: ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) fail(`${argument} 뒤에 값이 필요합니다.`);
    if (options[key] !== undefined) fail(`${argument}는 한 번만 지정할 수 있습니다.`);
    options[key] = value;
  }
  return options;
};

const usage = () => [
  'Usage:',
  '  node scripts/build-production-overlay-placement.mjs --alpha-manifest <render-manifest.json> --capture-dir <capture-dir> --production <slug> --generation <id> --track <zero-based-index> --out <placement.json>',
  '',
  'Identity input is the read-only full-sequence double-capture directory containing live.json + structure.json.',
  'The output is the strict project/sequence/timing/capture + items schema accepted by the current CEP placement runner.',
  'This builder is offline: it never opens, writes, or saves Premiere.',
].join('\n');

const writeJsonWithoutOverwrite = (targetPath, value) => {
  const resolved = path.resolve(targetPath);
  if (existsSync(resolved)) fail(`기존 placement manifest를 덮어쓰지 않습니다: ${resolved}`);
  const directory = path.dirname(resolved);
  mkdirSync(directory, {recursive: true});
  const staging = path.join(
    directory,
    `.${path.basename(resolved)}.tmp-${process.pid}-${randomUUID()}`,
  );
  try {
    writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    if (existsSync(resolved)) fail(`publish 직전에 output이 생겨 중단했습니다: ${resolved}`);
    renameSync(staging, resolved);
  } catch (error) {
    rmSync(staging, {force: true});
    throw error;
  }
  return resolved;
};

export const main = (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return null;
  }
  const missing = [
    'alphaManifestPath',
    'captureDir',
    'expectedProduction',
    'expectedGeneration',
    'targetVideoTrackIndex',
    'outputManifestPath',
  ].filter((key) => options[key] === undefined);
  if (missing.length > 0) {
    console.error(usage());
    fail(`필수 인자가 없습니다: ${missing.join(', ')}`);
  }
  const result = buildProductionOverlayPlacement({
    ...options,
    repoRoot,
  });
  const written = writeJsonWithoutOverwrite(result.outputManifestPath, result.manifest);
  console.log(JSON.stringify({
    ok: true,
    offlineOnly: true,
    output: written,
    production: result.production,
    generation: result.generation,
    captureKind: result.capture.kind,
    projectName: result.identity.projectName,
    sequenceName: result.identity.sequenceName,
    sequenceId: result.identity.sequenceId,
    fps: result.identity.fps,
    ticksPerFrame: result.identity.ticksPerFrame,
    targetVideoTrackIndex: result.targetVideoTrackIndex,
    overlayCount: result.manifest.items.length,
    premiereWrites: 0,
    projectSaved: false,
  }, null, 2));
  return result;
};

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`production overlay placement 생성 실패: ${error.message}`);
    process.exitCode = 1;
  }
}
