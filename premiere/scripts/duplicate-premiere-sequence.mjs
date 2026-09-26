// Duplicate the active Premiere sequence, name the copy, and make it active, so an edit can run on the
// copy while the original stays as the comparison/recovery sequence. Uses the CEP ExtendScript bridge.
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath, pathToFileURL} from "node:url";

import {
  acquirePremiereCepLock,
  createPremiereCepLifecycle,
  installPremiereCepSignalHandlers,
} from "./lib/premiere-cep-lock.mjs";
import { DEFAULT_MCP_ROOT, DEFAULT_TEMP_DIR } from "../servers/premiere-uxp-mcp/paths.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/duplicate-premiere-sequence.mjs --expected-sequence <name|id> --name <copy name> --dry-run",
    "  node scripts/duplicate-premiere-sequence.mjs --expected-sequence <name|id> --name <copy name> --allow-write",
    "",
    "Clones the active sequence (Sequence.clone), renames the new copy and opens it as the active sequence.",
    "Fails without writing when the active sequence does not match or a sequence with the copy name exists.",
    "The project is not saved.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {dryRun: false, allowWrite: false};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      return value;
    };
    if (flag === "--expected-sequence") options.expected = next();
    else if (flag === "--name") options.name = next();
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--allow-write") options.allowWrite = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (options.help) return options;
  if (!options.expected || !options.name) throw new Error("--expected-sequence and --name are required");
  if (options.dryRun === options.allowWrite) throw new Error("choose exactly one of --dry-run or --allow-write");
  return options;
}

export function buildDuplicateScript(expected, name) {
  return `var seq=app.project.activeSequence;
if(!seq) return __error("No active sequence");
var want=${JSON.stringify(expected)};
if(seq.name!==want && String(seq.sequenceID)!==want) return __error("Active sequence is '"+seq.name+"', not the expected one");
for(var i=0;i<app.project.sequences.numSequences;i++){ if(app.project.sequences[i].name===${JSON.stringify(name)}) return __error("A sequence named the copy name already exists"); }
var before={}; for(var j=0;j<app.project.sequences.numSequences;j++) before[app.project.sequences[j].sequenceID]=1;
var original={name:seq.name, id:String(seq.sequenceID)};
seq.clone();
var copy=null; for(var k=0;k<app.project.sequences.numSequences;k++){ var s=app.project.sequences[k]; if(!before[s.sequenceID]) copy=s; }
if(!copy) return __error("Sequence.clone did not create a new sequence");
copy.name=${JSON.stringify(name)};
app.project.openSequence(copy.sequenceID);
var active=app.project.activeSequence;
return __result({original:original, copy:{name:copy.name, id:String(copy.sequenceID)}, active:{name:active.name, id:String(active.sequenceID)},
  videoClips:copy.videoTracks[0].clips.numItems, audioClips:copy.audioTracks[0].clips.numItems});`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.dryRun) {
    console.log(JSON.stringify({mode: "dry-run", expectedSequence: options.expected, copyName: options.name, premiereConnected: false}, null, 2));
    return 0;
  }
  const mcpRoot = process.env.PREMIERE_MCP_ROOT || DEFAULT_MCP_ROOT;
  const tempDir = process.env.PREMIERE_TEMP_DIR || DEFAULT_TEMP_DIR;
  const req = createRequire(path.join(mcpRoot, "package.json"));
  const {Client} = await import(pathToFileURL(req.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
  const {StdioClientTransport} = await import(pathToFileURL(req.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href);
  const client = new Client({name: "deno-premiere-duplicate-sequence", version: "1.0.0"}, {capabilities: {}});
  const transport = new StdioClientTransport({
    command: "node", args: [path.join(mcpRoot, "dist", "index.js")], env: {...process.env, PREMIERE_TEMP_DIR: tempDir},
  });
  const lock = await acquirePremiereCepLock({bridgeDirectory: tempDir, tool: "duplicate-premiere-sequence", metadata: {name: options.name}});
  const lifecycle = createPremiereCepLifecycle({lock});
  const session = lifecycle.registerSession({client, transport, label: "duplicate-sequence-cep"});
  const removeHandlers = installPremiereCepSignalHandlers(() => lifecycle.cleanup());
  let exitCode = 0;
  try {
    await lifecycle.connectSession(session);
    const result = await client.callTool(
      {name: "execute_extendscript", arguments: {code: buildDuplicateScript(options.expected, options.name), timeout_ms: 120000}},
      undefined, {timeout: 130000},
    );
    const text = result?.content?.find((part) => part.type === "text")?.text ?? "";
    if (result?.isError || /^(Error:|EvalScript Error:)/.test(text)) throw new Error(text || JSON.stringify(result));
    console.log(JSON.stringify({mode: "write", ...JSON.parse(text), projectSaved: false}, null, 2));
  } catch (error) {
    console.error(error.message);
    exitCode = 1;
  } finally {
    await lifecycle.cleanup();
    removeHandlers?.();
  }
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error.message);
    process.exit(1);
  });
}
