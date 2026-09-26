import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import {buildPlacementScript} from './place-overlays-cep.mjs';

const target=path.resolve('renders/identity-fixture/live-r2/promise-alpha.mov');
const old=path.resolve('renders/identity-fixture/live-r1/promise-alpha.mov');
const sequence={name:'production',id:'sequence-id',durationSeconds:10};
const plan=[{name:'promise-alpha.mov',file:target,trackIndex:0,frame:30,endFrame:60}];
const script=buildPlacementScript(plan,8467200000,sequence);
const item=(file)=>({name:'promise-alpha.mov',type:1,getMediaPath:()=>file});
const collection=(items)=>Object.assign(items,{numItems:items.length});
function run(items){
  const writes=[];
  const track={clips:collection([]),overwriteClip:(item,time)=>writes.push({file:item.getMediaPath(),ticks:time.ticks})};
  const result=vm.runInNewContext('(function(){'+script+'})()',{
    app:{project:{activeSequence:{name:sequence.name,sequenceID:sequence.id,end:10,videoTracks:[track]},rootItem:{children:collection(items)}}},
    Time:function(){},__ticksToSeconds:(x)=>x,__result:(x)=>x,__error:(message)=>({error:message}),
  });
  return {result,writes};
}
const correct=item(target);const stale=item(old);
let actual=run([stale,{type:2,name:'current generation',children:collection([correct])}]);
assert.equal(actual.writes.length,1);assert.equal(actual.writes[0].file,target);
actual=run([stale]);assert.equal(actual.writes.length,0);assert.equal(actual.result.results[0].ok,false);
const normalized=target.replaceAll('\\','/').toUpperCase();
actual=run([stale,item(normalized)]);assert.equal(actual.writes.length,1);
if(process.platform==='win32'){
  actual=run([item('\\\\?\\'+target)]);assert.equal(actual.writes.length,1);
}
assert.throws(()=>buildPlacementScript([{...plan[0],file:undefined}],8467200000,sequence),/absolute media path/);
assert.throws(()=>buildPlacementScript([{...plan[0],file:'relative.mov'}],8467200000,sequence),/absolute media path/);
console.log('PASS same-name old generation skipped, exact nested media selected, path separators/case normalized, missing identity rejected');
