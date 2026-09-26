import assert from "node:assert/strict";

import {resolveProductionRequest} from "./lib/production-request-router.mjs";
import {createInitialProductionState} from "./lib/production-state.mjs";
import {buildProductionTaskEnvelope} from "./lib/production-task-envelope.mjs";

const state = createInitialProductionState({
  slug: "sample-video",
  createdAt: "2026-08-31T00:00:00.000Z",
});

const publishing = buildProductionTaskEnvelope({
  route: resolveProductionRequest("마스터는 나중에 넣고 업로드 헬퍼부터 준비해줘"),
  state,
  production: "sample-video",
});
assert.equal(publishing.schemaVersion, 2);
assert.equal(publishing.advisoryOnly, true);
assert.equal("blocked" in publishing, false);
assert.equal("prerequisites" in publishing, false);
assert.equal("allowedWrites" in publishing, false);
assert.equal("forbiddenWrites" in publishing, false);
assert.equal("requiredUserGate" in publishing, false);
assert.equal("stopAt" in publishing, false);
assert.deepEqual(publishing.stateNotes, []);

const thumbnail = buildProductionTaskEnvelope({
  route: resolveProductionRequest("최종 자막 전이지만 썸네일 먼저 만들어줘"),
  state,
});
assert.equal(thumbnail.advisoryOnly, true);
assert.equal(thumbnail.currentState, "optional_pending");
assert.equal("blocked" in thumbnail, false);
assert.deepEqual(thumbnail.stateNotes, []);

const liveApprovedState = structuredClone(state);
liveApprovedState.master.edit.status = "approved_live_timeline";
liveApprovedState.master.audio.status = "approved_live_timeline";
liveApprovedState.updatedAt = "2026-09-04T05:05:55.742Z";
const audio = buildProductionTaskEnvelope({
  route: resolveProductionRequest("현재 타임라인 기준으로 오디오 밸런스 조절해줘"),
  state: liveApprovedState,
});
assert.equal(audio.currentState, "approved_live_timeline");
assert.equal(audio.advisoryOnly, true);
assert.equal("blocked" in audio, false);

const mismatch = buildProductionTaskEnvelope({
  route: resolveProductionRequest("썸네일 만들어줘"),
  state,
  production: "other-video",
});
assert.equal(mismatch.production, "other-video");
assert.match(mismatch.stateNotes.join(" "), /production identity/iu);

const noState = buildProductionTaskEnvelope({
  route: resolveProductionRequest("하던 작업 이어서 해줘"),
  production: "sample-video",
});
assert.equal(noState.currentState, null);
assert.match(noState.stateNotes.join(" "), /live state/iu);

console.log("PASS production task envelope: advisory routing never blocks ordinary work");
