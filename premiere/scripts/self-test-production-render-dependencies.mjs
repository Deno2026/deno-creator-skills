import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildProductionSourceBundle,assertProductionSourceUnchanged} from './render-production-overlays.mjs';

const root=mkdtempSync(path.join(os.tmpdir(),'deno-motion-deps-'));
const put=(file,content)=>{const p=path.join(root,file);mkdirSync(path.dirname(p),{recursive:true});writeFileSync(p,content);};
const bundle=()=>buildProductionSourceBundle({repoRoot:root,production:'test-video'});
const manifest=(files)=>put('src/productions/test-video/render-dependencies.json',JSON.stringify({files}));
try {
  for(const file of ['src/index.ts','src/Root.tsx','src/productions/registry.tsx','src/lib/overlay/index.ts','src/productions/test-video/index.tsx'])put(file,'initial');
  const legacy=bundle();assert.ok(legacy.files.length===5);
  put('src/lib/reference-scenes/motion.json','{"pose":1}');
  const withLibrary=bundle();assert.notEqual(withLibrary.sha256,legacy.sha256);
  put('src/lib/reference-scenes/motion.json','{"pose":2}');
  assert.notEqual(bundle().sha256,withLibrary.sha256,'A changed shared trajectory must invalidate reviewed source');
  put('assets/clip.mp4','video revision A');put('assets/font.ttf','font revision A');manifest(['assets/clip.mp4','assets/font.ttf']);
  const reviewed=bundle();put('assets/clip.mp4','video revision B');assert.notEqual(bundle().sha256,reviewed.sha256,'Media swapped after review must be detected');
  assert.throws(()=>assertProductionSourceUnchanged({repoRoot:root,production:'test-video',expected:reviewed}),/render 중 source/,'Reject a generation whose input changed while frames were rendering');
  assert.doesNotThrow(()=>assertProductionSourceUnchanged({repoRoot:root,production:'test-video',expected:bundle()}));
  const mediaChanged=bundle();put('assets/font.ttf','font revision B');assert.notEqual(bundle().sha256,mediaChanged.sha256,'Prepared font changed after review must be detected');
  manifest(['assets/missing.mp4']);assert.throws(bundle,/dependency file/);
  manifest(['../outside.mp4']);assert.throws(bundle,/render dependency/);
  manifest(['C:/outside.mp4']);assert.throws(bundle,/상대 경로/);
  manifest(['assets\\clip.mp4']);assert.throws(bundle,/상대 경로/);
  manifest('wrong');assert.throws(bundle,/배열/);
  console.log('PASS legacy bundles, shared-library drift, media/font drift, missing assets, and dependency path boundaries');
} finally {
  const parent=path.resolve(os.tmpdir());const target=path.resolve(root);
  if(path.dirname(target)!==parent||!path.basename(target).startsWith('deno-motion-deps-'))throw new Error('Unexpected fixture cleanup target');
  rmSync(target,{recursive:true,force:true});
}
