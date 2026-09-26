import fs from "node:fs";
import path from "node:path";

import {resolveProductionRequest} from "./lib/production-request-router.mjs";
import {buildProductionTaskEnvelope} from "./lib/production-task-envelope.mjs";

function usage() {
  console.error("사용법: npm run production:route -- [--production <slug>] <사용자 요청 문장>");
}

const args = process.argv.slice(2);
const compactIndex = args.indexOf("--compact");
const compact = compactIndex !== -1;
if (compact) args.splice(compactIndex, 1);

const productionIndex = args.indexOf("--production");
let production = null;
let state = null;
if (productionIndex !== -1) {
  production = args[productionIndex + 1]?.trim() || null;
  if (!production) {
    usage();
    process.exit(1);
  }
  args.splice(productionIndex, 2);
  const statePath = path.resolve("productions", production, "STATE.json");
  if (fs.existsSync(statePath)) {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  }
}

const request = args.join(" ").trim();
if (!request) {
  usage();
  process.exit(1);
}

const route = resolveProductionRequest(request);
const result = {
  ...route,
  taskEnvelope: buildProductionTaskEnvelope({route, state, production}),
};
console.log(JSON.stringify(result, null, compact ? 0 : 2));
if (!route.recognized) process.exitCode = 2;
