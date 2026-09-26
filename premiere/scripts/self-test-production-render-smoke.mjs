import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {scaffoldProduction} from './create-production.mjs';
import {renderProductionOverlays} from './render-production-overlays.mjs';
import {
  buildPremierePlacementInputs,
  writePremierePlacementInputsAtomically,
} from './lib/premiere-placement-inputs.mjs';
import {buildProductionOverlayPlacement} from './lib/production-overlay-placement.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = `motion-render-smoke-${process.pid}`;
const registryPath = path.join(repoRoot, 'src', 'productions', 'registry.tsx');
const registryBefore = readFileSync(registryPath, 'utf8');
const placementCaptureRoot = path.join(repoRoot, 'tmp', `${slug}-placement-capture`);
let registryAfter = null;
let scaffolded = false;

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
};

try {
  await scaffoldProduction({repoRoot, slug});
  scaffolded = true;
  registryAfter = readFileSync(registryPath, 'utf8');

  const assetRoot = path.join(repoRoot, 'assets', slug);
  const backgroundPath = path.join(assetRoot, 'review-background.mp4');
  const audioPath = path.join(assetRoot, 'review-audio.wav');
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x24261F:s=640x360:r=30:d=0.4',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', backgroundPath,
  ]);
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=0.4',
    '-c:a', 'pcm_s16le', audioPath,
  ]);

  const planPath = path.join(
    repoRoot,
    'productions',
    slug,
    'plans',
    'overlay-plan.json',
  );
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  // This smoke intentionally promotes the generic fixture after supplying its
  // complete synthetic background/audio contract. Real productions must first
  // replace the scaffold with a director plan and custom source.
  plan.scaffoldOnly = false;
  plan.width = 640;
  plan.height = 360;
  plan.segments[0].durationInFrames = 12;
  plan.segments[0].reviewBackground = `${slug}/review-background.mp4`;
  plan.segments[0].reviewAudio = `${slug}/review-audio.wav`;
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

  const review = renderProductionOverlays({
    generation: 'verified',
    mode: 'review',
    production: slug,
    repoRoot,
  });
  assert.equal(review.manifest.outputs[0].codec, 'h264');
  assert.equal(review.manifest.outputs[0].pixelFormat, 'yuv420p');
  assert.ok(review.manifest.outputs[0].audioStreamCount >= 1);
  assert.ok(review.manifest.reviewAssetBundle.sha256);
  assert.ok(review.manifest.sourceBundle.sha256);

  const alpha = renderProductionOverlays({
    generation: 'verified',
    mode: 'alpha',
    production: slug,
    repoRoot,
  });
  assert.equal(alpha.manifest.outputs[0].codec, 'prores');
  assert.match(alpha.manifest.outputs[0].profile, /4444/);
  assert.equal(alpha.manifest.outputs[0].audioStreamCount, 0);
  assert.deepEqual(alpha.manifest.outputs[0].boundaryAlphaYMax, [256, 256]);
  assert.equal(alpha.manifest.sourceBundle.sha256, review.manifest.sourceBundle.sha256);
  assert.match(alpha.manifest.renderer.reviewParityPolicy, /matched verified\/review/);

  const timelineClip = (name, startSeconds, endSeconds, index, mediaType) => ({
    index,
    nodeId: `${mediaType}-${index}`,
    name,
    startSeconds,
    endSeconds,
    durationSeconds: endSeconds - startSeconds,
    inPointSeconds: 0,
    outPointSeconds: endSeconds - startSeconds,
    mediaType,
    enabled: mediaType === 'Video' ? true : undefined,
    speed: mediaType === 'Video' ? 1 : undefined,
  });
  const structure = {
    name: 'render smoke sequence',
    id: 'render-smoke-sequence-1',
    durationSeconds: 10,
    videoTrackCount: 2,
    audioTrackCount: 1,
    videoTracks: [
      {
        index: 0,
        name: 'Cut recording',
        clipCount: 2,
        clips: [
          timelineClip('recording.mp4', 0, 4, 0, 'Video'),
          timelineClip('recording.mp4', 4, 10, 1, 'Video'),
        ],
        isMuted: false,
        isLocked: null,
      },
      {index: 1, name: 'Overlay', clipCount: 0, clips: [], isMuted: false, isLocked: null},
    ],
    audioTracks: [
      {
        index: 0,
        name: 'Cut recording A',
        clipCount: 2,
        clips: [
          timelineClip('recording.mp4', 0, 4, 0, 'Audio'),
          timelineClip('recording.mp4', 4, 10, 1, 'Audio'),
        ],
        isMuted: false,
        isLocked: null,
      },
    ],
  };
  const capture = {
    project: {
      name: 'render-smoke.prproj',
      path: 'E:\\Projects\\render-smoke.prproj',
      id: 'render-smoke-project-1',
      activeSequence: {name: structure.name, id: structure.id},
    },
    settings: {
      name: structure.name,
      id: structure.id,
      frameRate: 30,
      ticksPerFrame: 8467200000,
      timebase: '8467200000',
      videoDisplayFormat: 4,
    },
    structure,
  };
  const placementCapture = buildPremierePlacementInputs({
    firstCapture: structuredClone(capture),
    secondCapture: structuredClone(capture),
    generatedAt: '2026-08-28T00:00:00.000Z',
  });
  writePremierePlacementInputsAtomically({
    outDir: placementCaptureRoot,
    bundle: placementCapture,
  });
  const placement = buildProductionOverlayPlacement({
    alphaManifestPath: path.join(
      repoRoot,
      'renders',
      slug,
      'verified',
      'alpha',
      'render-manifest.json',
    ),
    captureDir: placementCaptureRoot,
    expectedGeneration: 'verified',
    expectedProduction: slug,
    outputManifestPath: path.join(
      repoRoot,
      'productions',
      slug,
      'placement',
      'verified.json',
    ),
    repoRoot,
    targetVideoTrackIndex: 1,
  });
  assert.equal(placement.manifest.items.length, 1);
  assert.equal(placement.manifest.items[0].track_index, 1);
  assert.equal(placement.manifest.sequenceCheck.structureSha256.length, 64);
  assert.equal(
    placement.manifest.captureCheck.source,
    'premiere-uxp-read-only-placement-capture',
  );

  console.log('PASS actual review + parity-locked ProRes 4444 alpha + placement bridge smoke');
} finally {
  if (existsSync(placementCaptureRoot)) {
    rmSync(placementCaptureRoot, {recursive: true, force: true});
  }
  if (scaffolded) {
    const currentRegistry = readFileSync(registryPath, 'utf8');
    if (currentRegistry === registryAfter) {
      writeFileSync(registryPath, registryBefore, 'utf8');
      for (const target of [
        path.join(repoRoot, 'productions', slug),
        path.join(repoRoot, 'src', 'productions', slug),
        path.join(repoRoot, 'assets', slug),
        path.join(repoRoot, 'renders', slug),
      ]) {
        if (existsSync(target)) rmSync(target, {recursive: true, force: true});
      }
    } else {
      console.error(`cleanup skipped because production registry changed concurrently: ${slug}`);
    }
  }
}
