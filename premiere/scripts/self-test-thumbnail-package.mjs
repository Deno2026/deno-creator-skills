import assert from "node:assert/strict";

import {
  approveThumbnailYoutubeApplication,
  assertThumbnailYoutubeWriteAllowed,
  selectThumbnailCandidate,
  validateThumbnailPackage,
} from "./lib/thumbnail-package.mjs";

const now = "2026-08-31T08:00:00.000Z";
const finalKo = {
  kind: "final-ko-srt",
  path: "productions/demo-video/captions/final-ko.srt",
  sha256: "A".repeat(64),
  revision: "ko-r3",
};

const candidate = (id, hash, status = "accepted") => ({
  id,
  file: `renders/demo-video/thumbnail/candidates/${id}.png`,
  sha256: hash.repeat(64),
  bytes: 204800,
  width: 1536,
  height: 864,
  prompt: `Distinct ${id} concept with exact text`,
  conceptFamily: id === "A" ? "workflow-evidence" : "symbolic-metaphor",
  generatedAt: now,
  status,
  checks: {
    exactText: true,
    smallSize320x180: true,
    safeEdges: true,
    contentMatch: true,
    watermarkFree: true,
    dimensionsVerified: true,
    fileHashVerified: true,
  },
  rejectionReasons: [],
});

const base = {
  schemaVersion: 1,
  kind: "deno-thumbnail-package",
  production: {
    slug: "demo-video",
    workflowRole: "optional-postwork",
    blocksMaster: false,
  },
  contentAuthority: finalKo,
  brief: {
    viewerProblem: "큰 모델을 로컬에서 실행하기 어렵다",
    concreteReward: "검증된 설정으로 로컬 실행한다",
    conclusion: "VRAM에 맞춘 설정으로 완주했다",
    jointPromise: "정확한 모델과 제약 안에서 실행한 결과를 보여준다",
    entryKeywords: ["Qwen3", "96GB VRAM"],
    recommendedTitle: "Qwen3를 96GB VRAM에서 실제로 돌려봤습니다",
    exactThumbnailText: ["Qwen3", "96GB VRAM"],
    requiredEvidence: "실제 실행 결과와 모델 화면",
    prohibitedClaims: ["가짜 속도 수치"],
    referenceAssets: [],
  },
  generation: {
    route: "full-new-generation",
    provider: {
      name: "local-image-runtime",
      model: "local-model",
      billing: "free-local",
      estimatedCost: {amount: 0, currency: "USD"},
    },
    approval: {
      required: false,
      status: "not-required",
      approvedAt: null,
      scope: null,
    },
  },
  candidates: [],
  contactSheet: null,
  selection: {
    status: "pending",
    candidateId: null,
    candidateSha256: null,
    decidedBy: null,
    decidedAt: null,
  },
  youtubeApplication: {
    status: "not-requested",
    mode: "youtube-studio-later",
    approval: {
      status: "not-requested",
      approvedAt: null,
      candidateSha256: null,
    },
    appliedAt: null,
    videoId: null,
  },
};

const readyCandidates = [candidate("A", "B"), candidate("B", "C")];
const candidatesReady = {
  ...base,
  candidates: readyCandidates,
  contactSheet: {
    file: "renders/demo-video/thumbnail/contact-sheet.png",
    sha256: "D".repeat(64),
    bytes: 102400,
    width: 640,
    height: 360,
    candidateIds: ["A", "B"],
    verifiedAt: now,
  },
};

assert.equal(validateThumbnailPackage(base).state, "brief-ready");
assert.equal(validateThumbnailPackage(base).document.production.blocksMaster, false);
assert.equal(validateThumbnailPackage(candidatesReady).state, "candidates-ready");

const selected = selectThumbnailCandidate(candidatesReady, {
  candidateId: "B",
  decidedAt: now,
});
assert.equal(validateThumbnailPackage(selected).state, "selected");
assert.equal(validateThumbnailPackage(selected).youtubeWriteAllowed, false);

const approved = approveThumbnailYoutubeApplication(selected, {
  approvedAt: "2026-08-31T08:05:00.000Z",
  mode: "youtube-studio-later",
});
assert.equal(validateThumbnailPackage(approved).youtubeWriteAllowed, true);
assert.deepEqual(assertThumbnailYoutubeWriteAllowed(approved, {currentFinalKo: finalKo}), {
  productionSlug: "demo-video",
  candidateId: "B",
  candidateSha256: "C".repeat(64),
  mode: "youtube-studio-later",
});

const reselected = selectThumbnailCandidate(approved, {
  candidateId: "A",
  decidedAt: "2026-08-31T08:06:00.000Z",
});
assert.equal(reselected.selection.candidateId, "A");
assert.equal(reselected.youtubeApplication.status, "not-requested");
assert.equal(validateThumbnailPackage(reselected).youtubeWriteAllowed, false);

const stale = validateThumbnailPackage(approved, {
  currentFinalKo: {...finalKo, revision: "ko-r4", sha256: "E".repeat(64)},
});
assert.equal(stale.state, "stale");
assert.equal(stale.youtubeWriteAllowed, false);
assert.throws(
  () => assertThumbnailYoutubeWriteAllowed(approved, {
    currentFinalKo: {...finalKo, revision: "ko-r4", sha256: "E".repeat(64)},
  }),
  /not allowed while state is stale/,
);

assert.throws(
  () => approveThumbnailYoutubeApplication(candidatesReady, {approvedAt: now}),
  /select a candidate/,
);

assert.throws(
  () => validateThumbnailPackage({
    ...candidatesReady,
    candidates: [
      {
        ...readyCandidates[0],
        checks: {...readyCandidates[0].checks, exactText: false},
      },
      readyCandidates[1],
    ],
  }),
  /cannot be accepted with failed checks/,
);

assert.throws(
  () => validateThumbnailPackage({
    ...base,
    generation: {
      ...base.generation,
      provider: {
        name: "paid-provider",
        model: "paid-model",
        billing: "paid",
        estimatedCost: {amount: 2, currency: "USD"},
      },
      approval: {required: true, status: "pending", approvedAt: null, scope: null},
    },
    candidates: [candidate("A", "B")],
    contactSheet: candidatesReady.contactSheet,
  }),
  /before generation approval/,
);

assert.throws(
  () => validateThumbnailPackage({
    ...candidatesReady,
    generation: {
      ...base.generation,
      provider: {
        name: "paid-provider",
        model: "paid-model",
        billing: "paid",
        estimatedCost: {amount: 2, currency: "USD"},
      },
      approval: {
        required: true,
        status: "approved",
        approvedAt: "2026-08-31T09:00:00.000Z",
        scope: "two candidates",
      },
    },
  }),
  /cannot predate its user approval/,
);

assert.throws(
  () => validateThumbnailPackage({
    ...candidatesReady,
    generation: {
      ...base.generation,
      provider: {...base.generation.provider, billing: "unknown"},
    },
  }),
  /billing must be resolved/,
);

assert.throws(
  () => validateThumbnailPackage({
    ...base,
    contentAuthority: {...finalKo, path: "../outside/final-ko.srt"},
  }),
  /safe repo-relative path/,
);

assert.throws(
  () => validateThumbnailPackage({
    ...selected,
    selection: {...selected.selection, decidedBy: "agent"},
  }),
  /explicit user decision/,
);

assert.throws(
  () => validateThumbnailPackage({
    ...candidatesReady,
    youtubeApplication: {
      status: "approved",
      mode: "upload-helper",
      approval: {status: "approved", approvedAt: now},
      appliedAt: null,
      videoId: null,
    },
  }),
  /requires a selected candidate/,
);

const scriptBased = {
  ...candidatesReady,
  contentAuthority: {
    kind: "approved-script",
    path: "productions/demo-video/script.md",
    sha256: "D".repeat(64),
    revision: "script-r1",
  },
};
assert.equal(validateThumbnailPackage(scriptBased).state, "candidates-ready");
const scriptSelected = selectThumbnailCandidate(scriptBased, {candidateId: "A", decidedAt: now});
assert.equal(validateThumbnailPackage(scriptSelected).state, "selected");
const scriptApproved = approveThumbnailYoutubeApplication(scriptSelected, {approvedAt: now});
assert.equal(validateThumbnailPackage(scriptApproved).youtubeWriteAllowed, false);
assert.equal(validateThumbnailPackage(scriptApproved, {currentFinalKo: finalKo}).state, "stale");
assert.throws(() => validateThumbnailPackage({
  ...scriptBased,
  contentAuthority: {...scriptBased.contentAuthority, path: "productions/other-video/script.md"},
}), /must belong/);

console.log(
  "PASS thumbnail package: optional master boundary, final-KO freshness, candidate QC, paid approval, user selection, and separate YouTube write gate",
);
