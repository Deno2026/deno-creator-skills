// Apply direct-razor manifest cuts without ripple: lift every cut range, then close the holes by moving
// V/A clips left. Use this when the sequence has a caption track — caption items that span a cut block
// UXP ripple removal and leave V/A holes (audio-finishing.md, 2026-09-19).
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath, pathToFileURL} from "node:url";

import {
  acquirePremiereCepLock,
  createPremiereCepLifecycle,
  installPremiereCepSignalHandlers,
} from "./lib/premiere-cep-lock.mjs";
import {frameToDisplayTimecode, validateDirectRazorManifest} from "./lib/premiere-direct-razor-cuts.mjs";
import { DEFAULT_MCP_ROOT, DEFAULT_TEMP_DIR } from "../servers/premiere-uxp-mcp/paths.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/apply-premiere-lift-compact.mjs --cuts <manifest.json> --dry-run",
    "  node scripts/apply-premiere-lift-compact.mjs --cuts <manifest.json> --allow-write",
    "",
    "Lifts each manifest cut (Razor V/A at both edges, remove the exact fragments without ripple),",
    "then moves every later V/A clip pair left so the target tracks have no gaps. Caption tracks are",
    "not moved. Re-running is safe: ranges that are already empty on both tracks count as lifted.",
    "The project is not saved.",
    "",
    "Options:",
    "  --batch-size <1-50>   cuts per ExtendScript call (default 25)",
    "  --move-limit <n>      clip moves per compaction call (default 120)",
    "  --timeout-ms <ms>     per call (default 180000)",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {batchSize: 25, moveLimit: 120, timeoutMs: 180000, dryRun: false, allowWrite: false};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      return value;
    };
    if (flag === "--cuts") options.cuts = next();
    else if (flag === "--batch-size") options.batchSize = Number(next());
    else if (flag === "--move-limit") options.moveLimit = Number(next());
    else if (flag === "--timeout-ms") options.timeoutMs = Number(next());
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--allow-write") options.allowWrite = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (options.help) return options;
  if (!options.cuts) throw new Error("--cuts is required");
  if (options.dryRun === options.allowWrite) throw new Error("choose exactly one of --dry-run or --allow-write");
  if (!(options.batchSize >= 1 && options.batchSize <= 50)) throw new Error("--batch-size must be 1-50");
  if (!(options.moveLimit >= 1)) throw new Error("--move-limit must be positive");
  return options;
}

function head(contract) {
  const video = contract.targetTracks.find((t) => t.kind === "video").index;
  const audio = contract.targetTracks.find((t) => t.kind === "audio").index;
  return `var TPF=${Number(contract.timing.ticksPerFrame)};
var seq=app.project.activeSequence;
if(!seq) return __error("No active sequence");
if(app.project.name!==${JSON.stringify(contract.projectName)}) return __error("Active project changed");
if(seq.name!==${JSON.stringify(contract.sequenceName)}) return __error("Active sequence changed");
${contract.sequenceId ? `if(String(seq.sequenceID)!==${JSON.stringify(contract.sequenceId)}) return __error("Active sequence ID changed");` : ""}
var vt=seq.videoTracks[${video}], at=seq.audioTracks[${audio}];
function fo(t){return Math.round(Number(t.ticks)/TPF);}
`;
}

/** ExtendScript that lifts one batch of [startFrame, endFrame, startTc, endTc] cuts. */
export function buildLiftScript(contract, batch) {
  const video = contract.targetTracks.find((t) => t.kind === "video").index;
  const audio = contract.targetTracks.find((t) => t.kind === "audio").index;
  return head(contract) + `app.enableQE(); var q=qe.project.getActiveSequence();
var qv=q.getVideoTrackAt(${video}), qa=q.getAudioTrackAt(${audio});
function touching(tr,S,E){var n=0;for(var i=0;i<tr.clips.numItems;i++){var x=tr.clips[i];if(fo(x.start)<E&&fo(x.end)>S)n++;}return n;}
function cover(tr,S,E){var n=0;for(var i=0;i<tr.clips.numItems;i++){var x=tr.clips[i];if(fo(x.start)<=S&&fo(x.end)>=E)n++;}return n;}
function exact(tr,S,E){var r=[];for(var i=0;i<tr.clips.numItems;i++){var x=tr.clips[i];if(fo(x.start)===S&&fo(x.end)===E)r.push(x);}return r;}
var C=${JSON.stringify(batch)}; var done=[], already=[];
for(var k=0;k<C.length;k++){var c=C[k];
 if(touching(vt,c[0],c[1])===0&&touching(at,c[0],c[1])===0){already.push(c[0]);continue;}
 if(cover(vt,c[0],c[1])!==1||cover(at,c[0],c[1])!==1) return __error("cut "+c[0]+"-"+c[1]+" is not covered by exactly one clip per track; done="+done.join(","));
 qv.razor(c[3]); qa.razor(c[3]); qv.razor(c[2]); qa.razor(c[2]);
 var v=exact(vt,c[0],c[1]), a=exact(at,c[0],c[1]);
 if(v.length!==1||a.length!==1) return __error("exact fragment V="+v.length+" A="+a.length+" at "+c[0]+"-"+c[1]+"; done="+done.join(","));
 v[0].remove(false,false); a[0].remove(false,false);
 if(touching(vt,c[0],c[1])||touching(at,c[0],c[1])) return __error("fragment survived at "+c[0]+"; done="+done.join(","));
 done.push(c[0]);}
return __result({done:done, already:already, videoClips:vt.clips.numItems, audioClips:at.clips.numItems});`;
}

/** ExtendScript that closes up to `limit` holes by moving each V clip and its A pair left. */
export function buildCompactScript(contract, limit) {
  return head(contract) + `var amap={}; for(var i=0;i<at.clips.numItems;i++){amap[fo(at.clips[i].start)]=i;}
if(at.clips.numItems!==vt.clips.numItems) return __error("V/A clip counts differ");
var n=vt.clips.numItems, prevEnd=0, moved=0;
for(var i=0;i<n;i++){var v=vt.clips[i]; var s=fo(v.start), e=fo(v.end);
 if(s<prevEnd) return __error("overlap at "+s+" prevEnd="+prevEnd);
 if(s===prevEnd){prevEnd=e; continue;}
 if(moved>=${Number(limit)}) break;
 var ai=amap[s]; if(ai===undefined) return __error("no audio pair at "+s);
 var a=at.clips[ai]; if(fo(a.end)!==e||fo(a.inPoint)!==fo(v.inPoint)) return __error("pair mismatch at "+s);
 var off=new Time(); off.ticks=String((prevEnd-s)*TPF); v.move(off); a.move(off);
 if(fo(v.start)!==prevEnd||fo(a.start)!==prevEnd) return __error("move landed wrong at "+s);
 moved++; prevEnd=prevEnd+(e-s);}
return __result({moved:moved, clips:n, lastEnd:prevEnd});`;
}

export function planBatches(contract, batchSize) {
  const display = contract.timecodeDisplay;
  const cuts = [...contract.cuts]
    .sort((a, b) => b.startFrame - a.startFrame)
    .map((c) => [c.startFrame, c.endFrame, frameToDisplayTimecode(c.startFrame, display), frameToDisplayTimecode(c.endFrame, display)]);
  const batches = [];
  for (let i = 0; i < cuts.length; i += batchSize) batches.push(cuts.slice(i, i + batchSize));
  return batches;
}

async function importMcpClient(mcpRoot) {
  const req = createRequire(path.join(mcpRoot, "package.json"));
  const {Client} = await import(pathToFileURL(req.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
  const {StdioClientTransport} = await import(pathToFileURL(req.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href);
  return {Client, StdioClientTransport};
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const contract = validateDirectRazorManifest(JSON.parse(fs.readFileSync(options.cuts, "utf8")));
  const batches = planBatches(contract, options.batchSize);
  const summary = {
    sequenceName: contract.sequenceName, sequenceId: contract.sequenceId, cutCount: contract.cuts.length,
    batchCount: batches.length, expectedDurationAfterFrames: contract.expectedDurationAfterFrames,
  };
  if (options.dryRun) {
    console.log(JSON.stringify({mode: "dry-run", ...summary, premiereConnected: false, writeAttemptCount: 0}, null, 2));
    return 0;
  }
  const mcpRoot = process.env.PREMIERE_MCP_ROOT || DEFAULT_MCP_ROOT;
  const tempDir = process.env.PREMIERE_TEMP_DIR || DEFAULT_TEMP_DIR;
  const {Client, StdioClientTransport} = await importMcpClient(mcpRoot);
  const client = new Client({name: "deno-premiere-lift-compact", version: "1.0.0"}, {capabilities: {}});
  const transport = new StdioClientTransport({
    command: "node", args: [path.join(mcpRoot, "dist", "index.js")], env: {...process.env, PREMIERE_TEMP_DIR: tempDir},
  });
  const lock = await acquirePremiereCepLock({bridgeDirectory: tempDir, tool: "apply-premiere-lift-compact", metadata: {manifest: options.cuts}});
  const lifecycle = createPremiereCepLifecycle({lock});
  const session = lifecycle.registerSession({client, transport, label: "lift-compact-cep"});
  const removeHandlers = installPremiereCepSignalHandlers(() => lifecycle.cleanup());
  const run = async (code) => {
    const result = await client.callTool(
      {name: "execute_extendscript", arguments: {code, timeout_ms: options.timeoutMs}}, undefined, {timeout: options.timeoutMs + 10000},
    );
    const text = result?.content?.find((part) => part.type === "text")?.text ?? "";
    if (result?.isError || /^(Error:|EvalScript Error:)/.test(text)) throw new Error(text || JSON.stringify(result));
    return JSON.parse(text);
  };
  const report = {mode: "write", ...summary, lifted: 0, alreadyLifted: 0, moved: 0, lastEnd: null, projectSaved: false};
  let exitCode = 0;
  try {
    await lifecycle.connectSession(session);
    for (const [index, batch] of batches.entries()) {
      const res = await run(buildLiftScript(contract, batch));
      report.lifted += res.done.length;
      report.alreadyLifted += res.already.length;
      console.log(`LIFT_BATCH_COMPLETE ${index + 1}/${batches.length} lifted=${report.lifted} already=${report.alreadyLifted} clips=${res.videoClips}`);
    }
    for (let round = 1; round <= 200; round += 1) {
      const res = await run(buildCompactScript(contract, options.moveLimit));
      report.moved += res.moved;
      report.lastEnd = res.lastEnd;
      console.log(`COMPACT_ROUND ${round} moved=${res.moved} lastEnd=${res.lastEnd}`);
      if (res.moved === 0) break;
    }
    report.ok = report.lastEnd === contract.expectedDurationAfterFrames;
    if (!report.ok) exitCode = 1;
  } catch (error) {
    report.ok = false;
    report.error = error.message;
    exitCode = 1;
  } finally {
    report.cleanup = await lifecycle.cleanup();
    removeHandlers?.();
  }
  console.log(JSON.stringify(report, null, 2));
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error.message);
    process.exit(1);
  });
}
