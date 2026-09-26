import {
  access,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {createInitialProductionState} from './lib/production-state.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), '..');
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const importMarker = '// DENO_PRODUCTION_IMPORTS';
const entryMarker = '  // DENO_PRODUCTION_ENTRIES';

const exists = async (target) => {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

const assertSlug = (slug) => {
  if (!slug || !slugPattern.test(slug)) {
    throw new Error(
      'slug는 소문자 영문·숫자와 단일 하이픈만 사용할 수 있습니다.',
    );
  }
};

const toPascalIdentifier = (slug) => {
  const joined = slug
    .split('-')
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join('');
  return /^\d/.test(joined) ? `Production${joined}` : joined;
};

export const buildRegistryUpdate = ({content, slug, productionIdentifier}) => {
  if (!content.includes(importMarker) || !content.includes(entryMarker)) {
    throw new Error('production registry marker가 없거나 손상됐습니다.');
  }
  const importPath = `./${slug}/index`;
  if (content.includes(importPath) || content.includes(productionIdentifier)) {
    throw new Error(`production registry에 이미 등록돼 있습니다: ${slug}`);
  }
  return content
    .replace(
      importMarker,
      `import {${productionIdentifier}} from '${importPath}';\n${importMarker}`,
    )
    .replace(entryMarker, `  ${productionIdentifier},\n${entryMarker}`);
};

const readTemplate = (templateDirectory, name) =>
  readFile(path.join(templateDirectory, name), 'utf8');

export const scaffoldProduction = async ({repoRoot = defaultRepoRoot, slug}) => {
  assertSlug(slug);

  const templateDirectory = path.join(repoRoot, 'productions', '_template');
  const productionDirectory = path.join(repoRoot, 'productions', slug);
  const sourceDirectory = path.join(repoRoot, 'src', 'productions', slug);
  const assetDirectory = path.join(repoRoot, 'assets', slug);
  const renderDirectory = path.join(repoRoot, 'renders', slug);
  const registryPath = path.join(repoRoot, 'src', 'productions', 'registry.tsx');
  const targets = [
    productionDirectory,
    sourceDirectory,
    assetDirectory,
    renderDirectory,
  ];

  const collisions = [];
  for (const target of targets) {
    if (await exists(target)) collisions.push(path.relative(repoRoot, target));
  }
  if (collisions.length > 0) {
    throw new Error(`기존 경로가 있어 생성하지 않았습니다: ${collisions.join(', ')}`);
  }

  await access(registryPath);
  const [
    styleBriefTemplate,
    routeSheetTemplate,
    stateTemplate,
    planTemplate,
    sourceTemplate,
    thumbnailTemplate,
    registryBefore,
  ] = await Promise.all([
    readTemplate(templateDirectory, 'STYLE_BRIEF.md'),
    readTemplate(templateDirectory, 'ROUTE_SHEET.md'),
    readTemplate(templateDirectory, 'STATE.md'),
    readTemplate(templateDirectory, 'overlay-plan.json'),
    readTemplate(templateDirectory, 'production.tsx.template'),
    readTemplate(path.join(templateDirectory, 'thumbnail'), 'package.json'),
    readFile(registryPath, 'utf8'),
  ]);

  const pascal = toPascalIdentifier(slug);
  const componentIdentifier = `${pascal}Overlay`;
  const productionIdentifier = `${pascal[0].toLowerCase()}${pascal.slice(1)}Production`;
  const registryAfter = buildRegistryUpdate({
    content: registryBefore,
    productionIdentifier,
    slug,
  });
  const planText = planTemplate.replaceAll('__PRODUCTION_SLUG__', slug);
  JSON.parse(planText);
  const thumbnailPackageText = thumbnailTemplate.replaceAll('__PRODUCTION_SLUG__', slug);
  JSON.parse(thumbnailPackageText);
  const sourceText = sourceTemplate
    .replaceAll('__PRODUCTION_SLUG__', slug)
    .replaceAll('__COMPONENT_IDENTIFIER__', componentIdentifier)
    .replaceAll('__PRODUCTION_IDENTIFIER__', productionIdentifier);
  const createdAt = new Date().toISOString();
  const createdTargets = [];

  try {
    for (const target of targets) {
      await mkdir(target, {recursive: false});
      createdTargets.push(target);
    }
    await Promise.all([
      mkdir(path.join(productionDirectory, 'identity')),
      mkdir(path.join(productionDirectory, 'edit')),
      mkdir(path.join(productionDirectory, 'audio')),
      mkdir(path.join(productionDirectory, 'motion')),
      mkdir(path.join(productionDirectory, 'captions')),
      mkdir(path.join(productionDirectory, 'packaging')),
      mkdir(path.join(productionDirectory, 'thumbnail')),
      mkdir(path.join(productionDirectory, 'delivery')),
      mkdir(path.join(productionDirectory, 'publishing')),
      mkdir(path.join(productionDirectory, 'plans')),
      mkdir(path.join(productionDirectory, 'placement')),
      mkdir(path.join(productionDirectory, 'reports')),
      mkdir(path.join(assetDirectory, 'thumbnail')),
      mkdir(path.join(renderDirectory, 'thumbnail', 'candidates'), {recursive: true}),
    ]);

    await Promise.all([
      writeFile(
        path.join(productionDirectory, 'STYLE_BRIEF.md'),
        styleBriefTemplate.replace('- 영상/slug:', `- 영상/slug: ${slug}`),
        'utf8',
      ),
      writeFile(
        path.join(productionDirectory, 'ROUTE_SHEET.md'),
        routeSheetTemplate,
        'utf8',
      ),
      writeFile(
        path.join(productionDirectory, 'STATE.md'),
        stateTemplate.replace(
          '- 마지막 live 확인 시각:',
          `- 마지막 live 확인 시각: ${createdAt}`,
        ),
        'utf8',
      ),
      writeFile(
        path.join(productionDirectory, 'STATE.json'),
        `${JSON.stringify(createInitialProductionState({slug, createdAt}), null, 2)}\n`,
        'utf8',
      ),
      writeFile(
        path.join(productionDirectory, 'README.md'),
        `# ${slug} Production\n\n영상 마스터 제작과 선택형 게시 후작업의 domain state를 관리한다. 기계 포인터는 \`STATE.json\`, 사람용 재개 메모는 \`STATE.md\`가 소유한다. Remotion source는 \`src/productions/${slug}/\`, 입력 자산은 \`assets/${slug}/\`, 산출물은 \`renders/${slug}/\`에 둔다.\n`,
        'utf8',
      ),
      writeFile(
        path.join(productionDirectory, 'plans', 'overlay-plan.json'),
        planText,
        'utf8',
      ),
      writeFile(
        path.join(productionDirectory, 'thumbnail', 'package.json'),
        thumbnailPackageText,
        'utf8',
      ),
      writeFile(path.join(sourceDirectory, 'index.tsx'), sourceText, 'utf8'),
    ]);

    const registryCurrent = await readFile(registryPath, 'utf8');
    if (registryCurrent !== registryBefore) {
      throw new Error(
        'scaffold 중 production registry가 바뀌었습니다. 아무 것도 등록하지 않았습니다.',
      );
    }
    await writeFile(registryPath, registryAfter, 'utf8');
  } catch (error) {
    for (const target of createdTargets.reverse()) {
      await rm(target, {recursive: true, force: true});
    }
    throw error;
  }

  return {
    assets: path.relative(repoRoot, assetDirectory),
    compositionIds: [`${slug}-segment-01`],
    plan: path.relative(
      repoRoot,
      path.join(productionDirectory, 'plans', 'overlay-plan.json'),
    ),
    production: path.relative(repoRoot, productionDirectory),
    registry: path.relative(repoRoot, registryPath),
    renders: path.relative(repoRoot, renderDirectory),
    slug,
    source: path.relative(repoRoot, sourceDirectory),
  };
};

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === scriptPath;

if (isMain) {
  const slug = process.argv[2]?.trim();
  if (!slug || process.argv.length > 3) {
    console.error('사용법: npm run production:new -- <lowercase-video-slug>');
    process.exitCode = 1;
  } else {
    scaffoldProduction({slug})
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
