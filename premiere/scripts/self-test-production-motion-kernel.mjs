import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {scaffoldProduction} from './create-production.mjs';
import {
  buildRenderJobs,
  probeAlphaBoundary,
  renderProductionOverlays,
  resolveRenderLayout,
  validateProductionPlan,
} from './render-production-overlays.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoot = path.join(repoRoot, 'tmp');
mkdirSync(tmpRoot, {recursive: true});
const fixtureRoot = mkdtempSync(path.join(tmpRoot, 'production-motion-kernel-test-'));
const slug = 'motion-kernel-test';

const setupFixture = () => {
  mkdirSync(path.join(fixtureRoot, 'productions'), {recursive: true});
  cpSync(
    path.join(repoRoot, 'productions', '_template'),
    path.join(fixtureRoot, 'productions', '_template'),
    {recursive: true},
  );
  mkdirSync(path.join(fixtureRoot, 'src', 'productions'), {recursive: true});
  writeFileSync(
    path.join(fixtureRoot, 'src', 'productions', 'registry.tsx'),
    readFileSync(path.join(repoRoot, 'src', 'productions', 'registry.tsx'), 'utf8'),
    'utf8',
  );
  mkdirSync(path.join(fixtureRoot, 'assets'), {recursive: true});
  mkdirSync(path.join(fixtureRoot, 'renders'), {recursive: true});
};

try {
  setupFixture();
  const result = await scaffoldProduction({repoRoot: fixtureRoot, slug});
  assert.equal(result.slug, slug);
  assert.deepEqual(result.compositionIds, [`${slug}-segment-01`]);

  const productionRoot = path.join(fixtureRoot, 'productions', slug);
  const sourcePath = path.join(fixtureRoot, 'src', 'productions', slug, 'index.tsx');
  const planPath = path.join(productionRoot, 'plans', 'overlay-plan.json');
  const registryPath = path.join(fixtureRoot, 'src', 'productions', 'registry.tsx');
  assert.equal(existsSync(sourcePath), true);
  assert.equal(existsSync(planPath), true);
  for (const directory of [
    'identity', 'edit', 'audio', 'motion', 'captions', 'packaging',
    'thumbnail', 'delivery', 'publishing', 'reports',
  ]) {
    assert.equal(existsSync(path.join(productionRoot, directory)), true, `missing ${directory}`);
  }

  const stateJson = JSON.parse(
    readFileSync(path.join(productionRoot, 'STATE.json'), 'utf8'),
  );
  assert.equal(stateJson.production, slug);
  assert.equal(stateJson.master.status, 'pending');
  assert.equal(stateJson.packaging.thumbnail.status, 'optional_pending');
  assert.equal(stateJson.publishing.status, 'not_started');
  const thumbnailPackage = JSON.parse(
    readFileSync(path.join(productionRoot, 'thumbnail', 'package.json'), 'utf8'),
  );
  assert.equal(thumbnailPackage.production.slug, slug);
  assert.equal(thumbnailPackage.production.blocksMaster, false);
  assert.equal(
    existsSync(path.join(fixtureRoot, 'renders', slug, 'thumbnail', 'candidates')),
    true,
  );

  const plan = validateProductionPlan(
    JSON.parse(readFileSync(planPath, 'utf8')),
    {expectedProduction: slug},
  );
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.scaffoldOnly, true);
  assert.equal(plan.segments[0].compositionId, `${slug}-segment-01`);
  assert.equal(plan.segments[0].durationInFrames, 90);

  const source = readFileSync(sourcePath, 'utf8');
  assert.match(source, /OverlaySegmentComposition/);
  assert.match(source, /motionKernelTestProduction/);
  assert.match(source, /productions\/motion-kernel-test\/plans\/overlay-plan\.json/);

  assert.throws(
    () => renderProductionOverlays({
      allowPlaceholderReview: true,
      generation: 'scaffold-blocked',
      mode: 'review',
      production: slug,
      repoRoot: fixtureRoot,
    }),
    /overlay-plan과 영상별 source/,
  );

  const registry = readFileSync(registryPath, 'utf8');
  assert.match(
    registry,
    /import \{motionKernelTestProduction\} from '\.\/motion-kernel-test\/index';/,
  );
  assert.match(registry, /\s+motionKernelTestProduction,/);

  const state = readFileSync(path.join(productionRoot, 'STATE.md'), 'utf8');
  for (const requiredField of [
    'Premiere 프로젝트·활성 시퀀스:',
    '현재 요청:',
    '확정된 edit/audio/motion/caption/render 결과:',
    'exact source·artifact pointer:',
    '다음 한 작업:',
    '사용자 판정이 필요한 항목:',
  ]) {
    assert.equal(state.includes(requiredField), true, `STATE missing ${requiredField}`);
  }

  const reviewLayout = resolveRenderLayout({
    generation: 'r1',
    mode: 'review',
    production: slug,
    repoRoot: fixtureRoot,
    transactionId: 'self-test',
  });
  const reviewJobs = buildRenderJobs({
    finalModeRoot: reviewLayout.finalModeRoot,
    mode: 'review',
    plan,
    stagingRoot: reviewLayout.stagingRoot,
  });
  assert.equal(reviewJobs.length, 1);
  assert.equal(reviewJobs[0].inputProps.renderMode, 'review');
  assert.equal(reviewJobs[0].outputName, 'segment-01-review.mp4');
  assert.equal(
    reviewJobs[0].publishedPath,
    path.join(
      fixtureRoot,
      'renders',
      slug,
      'r1',
      'review',
      'segment-01-review.mp4',
    ),
  );

  const alphaLayout = resolveRenderLayout({
    generation: 'r1',
    mode: 'alpha',
    production: slug,
    repoRoot: fixtureRoot,
    transactionId: 'self-test',
  });
  const alphaJobs = buildRenderJobs({
    finalModeRoot: alphaLayout.finalModeRoot,
    mode: 'alpha',
    plan,
    selectedIds: ['segment-01'],
    stagingRoot: alphaLayout.stagingRoot,
  });
  assert.equal(alphaJobs[0].inputProps.renderMode, 'alpha');
  assert.equal(alphaJobs[0].outputName, 'segment-01-overlay.mov');
  assert.notEqual(alphaJobs[0].remotionOutputPath, alphaJobs[0].outputPath);

  const dryRun = renderProductionOverlays({
    allowUnreviewedAlpha: true,
    dryRun: true,
    generation: 'r2',
    ids: ['segment-01'],
    mode: 'alpha',
    production: slug,
    repoRoot: fixtureRoot,
  });
  assert.equal(dryRun.dryRun, true);
  assert.deepEqual(dryRun.segments, ['segment-01']);
  assert.equal(existsSync(path.join(fixtureRoot, 'renders', slug, 'r2')), false);

  assert.throws(
    () => renderProductionOverlays({
      dryRun: true,
      generation: 'r3',
      mode: 'review',
      production: slug,
      repoRoot: fixtureRoot,
    }),
    /reviewBackground.*reviewAudio/,
  );
  const placeholderReview = renderProductionOverlays({
    allowPlaceholderReview: true,
    dryRun: true,
    generation: 'r3',
    mode: 'review',
    production: slug,
    repoRoot: fixtureRoot,
  });
  assert.equal(placeholderReview.dryRun, true);

  assert.throws(
    () =>
      buildRenderJobs({
        finalModeRoot: reviewLayout.finalModeRoot,
        mode: 'review',
        plan,
        selectedIds: ['missing-segment'],
        stagingRoot: reviewLayout.stagingRoot,
      }),
    /없는 segment id/,
  );
  assert.throws(
    () =>
      resolveRenderLayout({
        generation: '../escape',
        mode: 'review',
        production: slug,
        repoRoot: fixtureRoot,
      }),
    /generation.*형식/,
  );

  const registryBeforeCollision = readFileSync(registryPath, 'utf8');
  await assert.rejects(
    scaffoldProduction({repoRoot: fixtureRoot, slug}),
    /기존 경로/,
  );
  assert.equal(readFileSync(registryPath, 'utf8'), registryBeforeCollision);

  const transparentPath = path.join(fixtureRoot, 'transparent-alpha.mov');
  const opaquePath = path.join(fixtureRoot, 'opaque-alpha.mov');
  for (const [alpha, output] of [['0.0', transparentPath], ['1.0', opaquePath]]) {
    const ffmpeg = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i',
      `color=c=black@${alpha}:s=64x64:r=30:d=0.4,format=yuva444p10le`,
      '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', output,
    ], {encoding: 'utf8', windowsHide: true});
    assert.equal(ffmpeg.status, 0, ffmpeg.stderr);
  }
  assert.equal(
    probeAlphaBoundary({filePath: transparentPath, frames: 12, segmentId: 'transparent'}).length,
    2,
  );
  assert.throws(
    () => probeAlphaBoundary({filePath: opaquePath, frames: 12, segmentId: 'opaque'}),
    /투명하지 않습니다/,
  );

  console.log('PASS production motion kernel scaffold, registry, plan, and render contract');
} finally {
  rmSync(fixtureRoot, {recursive: true, force: true});
}
