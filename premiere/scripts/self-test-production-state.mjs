import assert from "node:assert/strict";

import {
  createInitialProductionState,
  isMasterReady,
  validateProductionState,
} from "./lib/production-state.mjs";

const createdAt = "2026-08-31T00:00:00.000Z";
const state = createInitialProductionState({slug: "sample-video", createdAt});
assert.equal(validateProductionState(state), state);
assert.equal(state.master.status, "pending");
assert.equal(state.packaging.thumbnail.status, "optional_pending");
assert.equal(state.publishing.status, "not_started");
assert.equal(state.schemaVersion, 2);
assert.equal(Object.hasOwn(state, "gates"), false);
assert.equal(Object.hasOwn(state.active, "currentGate"), false);
assert.equal(isMasterReady(state), false);

const ready = structuredClone(state);
ready.master.status = "ready";
for (const key of ["edit", "audio", "motion", "captions", "render"]) {
  ready.master[key].status = "complete";
  ready.master[key].revision = `${key}-revision`;
  ready.master[key].manifest = `${key}/manifest.json`;
}
assert.equal(isMasterReady(ready), true);
assert.equal(ready.packaging.thumbnail.status, "optional_pending");

const legacyState = structuredClone(state);
legacyState.schemaVersion = 1;
legacyState.active.currentGate = "old-note";
legacyState.gates = {publicVisibility: {status: "not_approved", boundRevision: null}};
assert.equal(validateProductionState(legacyState), legacyState);

const leaked = structuredClone(state);
leaked.runtime = {refresh_token: "must-not-be-stored"};
assert.throws(() => validateProductionState(leaked), /refresh_token/);
assert.throws(
  () => createInitialProductionState({slug: "Bad Slug", createdAt}),
  /slug/,
);

console.log("PASS production state: current progress, legacy read compatibility, and secret boundary");
