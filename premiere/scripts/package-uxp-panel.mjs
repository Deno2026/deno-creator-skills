import { createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZipArchive } from 'archiver';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PLUGIN_ROOT = path.join(
  REPO_ROOT,
  'extensions',
  'deno-premiere-uxp',
);
const MANIFEST_PATH = path.join(PLUGIN_ROOT, 'manifest.json');
const HANDLERS_ROOT = path.join(PLUGIN_ROOT, 'handlers');
const OUTPUT_DIR = path.join(REPO_ROOT, 'dist', 'premiere-uxp');
const ZIP_ENTRY_DATE = new Date('2000-01-01T00:00:00.000Z');

const REQUIRED_MANIFEST_FIELDS = [
  'manifestVersion',
  'id',
  'name',
  'version',
  'host',
  'entrypoints',
];
const UDT_IGNORED_NAMES = new Set([
  '.DS_Store',
  '.gitignore',
  '.npmignore',
  '.uxprc',
  'manifest.json',
  'package-lock.json',
  'yarn.lock',
]);

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safeFilePart(value) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-');
}

async function readManifest() {
  let source;
  try {
    source = await readFile(MANIFEST_PATH, 'utf8');
  } catch (error) {
    throw new Error(`manifest.json을 읽을 수 없습니다: ${error.message}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    throw new Error(`manifest.json JSON 파싱 실패: ${error.message}`);
  }

  invariant(isPlainObject(manifest), 'manifest.json 최상위 값은 object여야 합니다.');
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    invariant(
      Object.hasOwn(manifest, field),
      `manifest.json 필수 필드가 없습니다: ${field}`,
    );
  }

  invariant(
    Number.isInteger(manifest.manifestVersion) && manifest.manifestVersion >= 5,
    'manifestVersion은 Premiere 패키징에 맞는 5 이상의 정수여야 합니다.',
  );
  for (const field of ['id', 'name', 'version']) {
    invariant(
      typeof manifest[field] === 'string' && manifest[field].trim() !== '',
      `${field}는 비어 있지 않은 문자열이어야 합니다.`,
    );
  }
  invariant(
    /^\d+\.\d+\.\d+$/.test(manifest.version),
    'version은 major.minor.patch 형식이어야 합니다.',
  );
  invariant(
    manifest.name.length >= 3 && manifest.name.length <= 45,
    'name은 UDT 패키징 규칙에 따라 3~45자여야 합니다.',
  );

  invariant(
    isPlainObject(manifest.host),
    '정식 패키지의 host는 배열이 아닌 단일 object여야 합니다.',
  );
  invariant(
    manifest.host.app === 'premierepro',
    'host.app은 premierepro여야 합니다.',
  );
  invariant(
    typeof manifest.host.minVersion === 'string' &&
      /^\d+(?:\.\d+){0,3}$/.test(manifest.host.minVersion),
    'host.minVersion은 숫자 버전 문자열이어야 합니다.',
  );
  invariant(
    isPlainObject(manifest.hostUIContext) &&
      manifest.hostUIContext.hideFromMenu === true,
    '설치형 브리지는 hostUIContext.hideFromMenu=true로 Premiere 시작 시 자동 호출되어야 합니다.',
  );

  invariant(
    Array.isArray(manifest.entrypoints) && manifest.entrypoints.length > 0,
    'entrypoints는 비어 있지 않은 배열이어야 합니다.',
  );
  for (const [index, entrypoint] of manifest.entrypoints.entries()) {
    invariant(
      isPlainObject(entrypoint),
      `entrypoints[${index}]는 object여야 합니다.`,
    );
    invariant(
      entrypoint.type === 'panel' || entrypoint.type === 'command',
      `entrypoints[${index}].type은 panel 또는 command여야 합니다.`,
    );
    invariant(
      typeof entrypoint.id === 'string' && entrypoint.id.trim() !== '',
      `entrypoints[${index}].id가 비어 있습니다.`,
    );
    invariant(
      typeof entrypoint.label === 'string' || isPlainObject(entrypoint.label),
      `entrypoints[${index}].label이 없습니다.`,
    );
  }

  invariant(
    typeof manifest.main === 'string' && manifest.main.trim() !== '',
    'main은 비어 있지 않은 문자열이어야 합니다.',
  );
  const mainPath = path.resolve(PLUGIN_ROOT, manifest.main);
  invariant(
    isPathInside(PLUGIN_ROOT, mainPath),
    'main은 플러그인 폴더 내부 파일을 가리켜야 합니다.',
  );
  let mainStats;
  try {
    mainStats = await stat(mainPath);
  } catch {
    throw new Error(`main이 가리키는 파일이 없습니다: ${manifest.main}`);
  }
  invariant(mainStats.isFile(), `main이 파일이 아닙니다: ${manifest.main}`);
  invariant(
    manifest.requiredPermissions?.localFileSystem === 'plugin' &&
      !manifest.requiredPermissions?.network &&
      !manifest.requiredPermissions?.launchProcess,
    '브리지는 plugin 전용 파일 권한만 사용하고 network/launchProcess를 요청하지 않아야 합니다.',
  );

  return manifest;
}

async function collectFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = path
      .relative(root, absolutePath)
      .split(path.sep)
      .join('/');

    if (
      entry.name.startsWith('.') ||
      UDT_IGNORED_NAMES.has(entry.name) ||
      relativePath.startsWith('uxp-plugin-tests') ||
      relativePath.endsWith('.ccx') ||
      relativePath.endsWith('.xdx')
    ) {
      continue;
    }

    if (entry.isSymbolicLink()) {
      throw new Error(`심볼릭 링크는 패키징하지 않습니다: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, absolutePath)));
    } else if (entry.isFile()) {
      files.push({ absolutePath, relativePath });
    }
  }

  return files;
}

async function validateHandlers() {
  let handlerFiles;
  try {
    handlerFiles = await collectFiles(HANDLERS_ROOT);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('handlers/ 폴더가 없습니다.');
    }
    throw error;
  }

  invariant(handlerFiles.length > 0, 'handlers/ 폴더가 비어 있습니다.');
  return handlerFiles.length;
}

async function createPackage(outputPath, manifest, files) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });

  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath, { flags: 'wx' });
    const archive = new ZipArchive({ zlib: { level: 9 } });
    let settled = false;

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    output.on('close', () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(archive.pointer());
    });
    output.on('error', fail);
    archive.on('error', fail);
    archive.on('warning', fail);
    archive.pipe(output);

    archive.append(JSON.stringify(manifest, null, 2), {
      name: 'manifest.json',
      date: ZIP_ENTRY_DATE,
      mode: 0o100644,
    });
    for (const file of files) {
      archive.append(createReadStream(file.absolutePath), {
        name: file.relativePath,
        date: ZIP_ENTRY_DATE,
        mode: 0o100644,
      });
    }

    archive.finalize().catch(fail);
  });
}

async function main() {
  await access(PLUGIN_ROOT);
  const manifest = await readManifest();
  const handlerCount = await validateHandlers();
  const files = (await collectFiles(PLUGIN_ROOT)).sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath, 'en'),
  );

  const outputName = `${safeFilePart(manifest.id)}-${safeFilePart(
    manifest.version,
  )}_${safeFilePart(manifest.host.app)}.ccx`;
  const outputPath = path.join(OUTPUT_DIR, outputName);
  const bytes = await createPackage(outputPath, manifest, files);

  console.log(`UXP package: ${outputPath}`);
  console.log(
    `Manifest ${manifest.id} ${manifest.version}; ${files.length + 1} files; ` +
      `${handlerCount} handler files; ${bytes} bytes`,
  );
}

main().catch((error) => {
  console.error(`UXP packaging failed: ${error.message}`);
  process.exitCode = 1;
});
