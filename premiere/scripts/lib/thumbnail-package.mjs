const KIND = "deno-thumbnail-package";
const VERSION = 1;
const SHA256_PATTERN = /^[0-9A-F]{64}$/;
const BILLING = new Set(["free-local", "included", "paid", "unknown"]);
const GENERATION_APPROVAL = new Set(["not-required", "pending", "approved"]);
const YOUTUBE_STATUS = new Set(["not-requested", "approved", "applied"]);
const YOUTUBE_MODE = new Set(["youtube-studio-later", "upload-helper", "api"]);
const REQUIRED_CHECKS = [
  "exactText",
  "smallSize320x180",
  "safeEdges",
  "contentMatch",
  "watermarkFree",
  "dimensionsVerified",
  "fileHashVerified",
];

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, label) {
  const result = String(value ?? "").trim();
  if (!result) fail(`${label} is required`);
  return result;
}

function nullableString(value, label) {
  if (value === null || value === undefined) return null;
  return requiredString(value, label);
}

function sha256(value, label) {
  const result = requiredString(value, label).toUpperCase();
  if (!SHA256_PATTERN.test(result)) fail(`${label} must be a SHA-256 hash`);
  return result;
}

function timestamp(value, label) {
  const result = requiredString(value, label);
  if (Number.isNaN(Date.parse(result))) fail(`${label} must be an ISO timestamp`);
  return result;
}

function nullableTimestamp(value, label) {
  if (value === null || value === undefined) return null;
  return timestamp(value, label);
}

function nonNegativeNumber(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) {
    fail(`${label} must be a non-negative number`);
  }
  return result;
}

function positiveInteger(value, label) {
  const result = Number(value);
  if (!Number.isInteger(result) || result <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return result;
}

function stringList(value, label, {min = 0, max = Number.POSITIVE_INFINITY} = {}) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const result = value.map((item, index) => requiredString(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) fail(`${label} must not contain duplicates`);
  if (result.length < min || result.length > max) {
    fail(`${label} must contain between ${min} and ${max} items`);
  }
  return result;
}

function enumValue(value, allowed, label) {
  const result = requiredString(value, label);
  if (!allowed.has(result)) fail(`${label} has an unsupported value: ${result}`);
  return result;
}

function repoRelativePath(value, label) {
  const result = requiredString(value, label).replaceAll("\\", "/");
  if (
    result.startsWith("/") ||
    /^[A-Za-z]:\//u.test(result) ||
    result.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    fail(`${label} must be a safe repo-relative path`);
  }
  return result;
}

function nullableRepoRelativePath(value, label) {
  if (value === null || value === undefined) return null;
  return repoRelativePath(value, label);
}

function contentContract(value, slug, label = "contentAuthority", {finalOnly = false} = {}) {
  if (!isObject(value)) fail(`${label} must be an object`);
  const allowedKinds = finalOnly ? ["final-ko-srt"] : ["final-ko-srt", "approved-script"];
  if (!allowedKinds.includes(value.kind)) fail(`${label}.kind must be ${allowedKinds.join(" or ")}`);
  const normalized = {
    kind: value.kind,
    path: repoRelativePath(value.path, `${label}.path`),
    sha256: sha256(value.sha256, `${label}.sha256`),
    revision: requiredString(value.revision, `${label}.revision`),
  };
  const expectedPrefix = normalized.kind === "final-ko-srt"
    ? `productions/${slug}/captions/`
    : `productions/${slug}/`;
  if (!normalized.path.startsWith(expectedPrefix)) {
    fail(`${label}.path must belong to ${expectedPrefix}`);
  }
  return normalized;
}

function normalizeBrief(value, slug) {
  if (!isObject(value)) fail("brief must be an object");
  return {
    viewerProblem: requiredString(value.viewerProblem, "brief.viewerProblem"),
    concreteReward: requiredString(value.concreteReward, "brief.concreteReward"),
    conclusion: requiredString(value.conclusion, "brief.conclusion"),
    jointPromise: requiredString(value.jointPromise, "brief.jointPromise"),
    entryKeywords: stringList(value.entryKeywords, "brief.entryKeywords", {min: 1, max: 2}),
    recommendedTitle: requiredString(value.recommendedTitle, "brief.recommendedTitle"),
    exactThumbnailText: stringList(
      value.exactThumbnailText,
      "brief.exactThumbnailText",
      {min: 1, max: 5},
    ),
    requiredEvidence: requiredString(value.requiredEvidence, "brief.requiredEvidence"),
    prohibitedClaims: stringList(value.prohibitedClaims, "brief.prohibitedClaims"),
    referenceAssets: stringList(value.referenceAssets ?? [], "brief.referenceAssets")
      .map((asset, index) => repoRelativePath(asset, `brief.referenceAssets[${index}]`))
      .map((asset) => {
        if (!asset.startsWith(`assets/${slug}/thumbnail/`)) {
          fail(`brief.referenceAssets must belong to assets/${slug}/thumbnail/`);
        }
        return asset;
      }),
  };
}

function normalizeGeneration(value, candidateCount) {
  if (!isObject(value)) fail("generation must be an object");
  if (value.route !== "full-new-generation" && value.route !== "explicit-user-edit") {
    fail("generation.route must be full-new-generation or explicit-user-edit");
  }
  const provider = isObject(value.provider) ? value.provider : {};
  const billing = enumValue(provider.billing, BILLING, "generation.provider.billing");
  const estimatedCost = isObject(provider.estimatedCost) ? provider.estimatedCost : {};
  const cost = {
    amount: nonNegativeNumber(
      estimatedCost.amount,
      "generation.provider.estimatedCost.amount",
    ),
    currency: requiredString(
      estimatedCost.currency,
      "generation.provider.estimatedCost.currency",
    ).toUpperCase(),
  };
  if (!/^[A-Z]{3}$/u.test(cost.currency)) {
    fail("generation.provider.estimatedCost.currency must be a three-letter code");
  }
  if (billing === "paid" && cost.amount <= 0) {
    fail("paid generation must record a positive estimated cost");
  }
  if (new Set(["free-local", "included"]).has(billing) && cost.amount !== 0) {
    fail(`${billing} generation must record zero estimated cost`);
  }
  if (candidateCount > 0 && billing === "unknown") {
    fail("generation billing must be resolved before candidates exist");
  }
  const approval = isObject(value.approval) ? value.approval : {};
  const approvalStatus = enumValue(
    approval.status,
    GENERATION_APPROVAL,
    "generation.approval.status",
  );
  const approvalRequired = approval.required === true;
  if (billing === "paid" && approvalRequired !== true) {
    fail("paid generation must require user approval");
  }
  if (approvalStatus === "approved") {
    timestamp(approval.approvedAt, "generation.approval.approvedAt");
    requiredString(approval.scope, "generation.approval.scope");
  }
  if (candidateCount > 0 && billing === "paid" && approvalStatus !== "approved") {
    fail("paid candidates cannot exist before generation approval");
  }
  if (!approvalRequired && approvalStatus === "pending" && candidateCount > 0) {
    fail("non-required generation approval must be resolved before candidates exist");
  }
  return {
    route: value.route,
    provider: {
      name: requiredString(provider.name, "generation.provider.name"),
      model: requiredString(provider.model, "generation.provider.model"),
      billing,
      estimatedCost: cost,
    },
    approval: {
      required: approvalRequired,
      status: approvalStatus,
      approvedAt: nullableTimestamp(approval.approvedAt, "generation.approval.approvedAt"),
      scope: nullableString(approval.scope, "generation.approval.scope"),
    },
  };
}

function normalizeCandidate(value, index, slug) {
  const label = `candidates[${index}]`;
  if (!isObject(value)) fail(`${label} must be an object`);
  const id = requiredString(value.id, `${label}.id`);
  if (!/^[A-Z][A-Z0-9-]*$/u.test(id)) fail(`${label}.id must be a stable uppercase label`);
  const file = repoRelativePath(value.file, `${label}.file`);
  const expectedPrefix = `renders/${slug}/thumbnail/candidates/`;
  if (!file.startsWith(expectedPrefix) || file.slice(expectedPrefix.length).includes("/")) {
    fail(`${label}.file must be flat inside ${expectedPrefix}`);
  }
  if (!/\.(?:png|jpe?g|webp)$/iu.test(file)) {
    fail(`${label}.file must be a final raster image`);
  }
  const checks = isObject(value.checks) ? value.checks : {};
  for (const check of REQUIRED_CHECKS) {
    if (typeof checks[check] !== "boolean") fail(`${label}.checks.${check} must be boolean`);
  }
  const status = enumValue(value.status, new Set(["accepted", "rejected"]), `${label}.status`);
  const rejectionReasons = stringList(
    value.rejectionReasons ?? [],
    `${label}.rejectionReasons`,
  );
  if (status === "accepted" && REQUIRED_CHECKS.some((check) => checks[check] !== true)) {
    fail(`${label} cannot be accepted with failed checks`);
  }
  if (status === "accepted" && rejectionReasons.length > 0) {
    fail(`${label} cannot be accepted with rejection reasons`);
  }
  if (status === "rejected" && rejectionReasons.length === 0) {
    fail(`${label} must explain why it was rejected`);
  }
  const width = positiveInteger(value.width, `${label}.width`);
  const height = positiveInteger(value.height, `${label}.height`);
  if (Math.abs(width / height - 16 / 9) > 0.01) {
    fail(`${label} must be a final 16:9 thumbnail asset`);
  }
  return {
    id,
    file,
    sha256: sha256(value.sha256, `${label}.sha256`),
    bytes: positiveInteger(value.bytes, `${label}.bytes`),
    width,
    height,
    prompt: requiredString(value.prompt, `${label}.prompt`),
    conceptFamily: requiredString(value.conceptFamily, `${label}.conceptFamily`),
    generatedAt: timestamp(value.generatedAt, `${label}.generatedAt`),
    status,
    checks: Object.fromEntries(REQUIRED_CHECKS.map((check) => [check, checks[check]])),
    rejectionReasons,
  };
}

function normalizeContactSheet(value, slug, acceptedIds) {
  if (value === null || value === undefined) {
    if (acceptedIds.length > 0) fail("contactSheet is required when accepted candidates exist");
    return null;
  }
  if (!isObject(value)) fail("contactSheet must be an object or null");
  const file = repoRelativePath(value.file, "contactSheet.file");
  if (file !== `renders/${slug}/thumbnail/contact-sheet.png`) {
    fail(`contactSheet.file must be renders/${slug}/thumbnail/contact-sheet.png`);
  }
  const candidateIds = stringList(value.candidateIds, "contactSheet.candidateIds", {min: 1});
  if (
    candidateIds.length !== acceptedIds.length ||
    candidateIds.some((id) => !acceptedIds.includes(id))
  ) {
    fail("contactSheet.candidateIds must contain every accepted candidate exactly once");
  }
  return {
    file,
    sha256: sha256(value.sha256, "contactSheet.sha256"),
    bytes: positiveInteger(value.bytes, "contactSheet.bytes"),
    width: positiveInteger(value.width, "contactSheet.width"),
    height: positiveInteger(value.height, "contactSheet.height"),
    candidateIds,
    verifiedAt: timestamp(value.verifiedAt, "contactSheet.verifiedAt"),
  };
}

function normalizeSelection(value, candidates, contactSheet) {
  if (!isObject(value)) fail("selection must be an object");
  const status = enumValue(value.status, new Set(["pending", "selected"]), "selection.status");
  if (status === "pending") {
    for (const field of ["candidateId", "candidateSha256", "decidedBy", "decidedAt"]) {
      if (value[field] !== null && value[field] !== undefined) {
        fail(`selection.${field} must be null while selection is pending`);
      }
    }
    return {
      status,
      candidateId: null,
      candidateSha256: null,
      decidedBy: null,
      decidedAt: null,
    };
  }
  if (!contactSheet) fail("selection requires a verified contact sheet");
  if (value.decidedBy !== "user") fail("only an explicit user decision can select a candidate");
  const candidateId = requiredString(value.candidateId, "selection.candidateId");
  const candidate = candidates.find((item) => item.id === candidateId);
  if (!candidate || candidate.status !== "accepted") {
    fail("selection must reference an accepted candidate");
  }
  const selectedSha256 = sha256(value.candidateSha256, "selection.candidateSha256");
  if (selectedSha256 !== candidate.sha256) fail("selection candidate hash is stale");
  const decidedAt = timestamp(value.decidedAt, "selection.decidedAt");
  if (
    Date.parse(decidedAt) < Date.parse(candidate.generatedAt) ||
    Date.parse(decidedAt) < Date.parse(contactSheet.verifiedAt)
  ) {
    fail("selection cannot predate candidate generation or contact-sheet verification");
  }
  return {
    status,
    candidateId,
    candidateSha256: selectedSha256,
    decidedBy: "user",
    decidedAt,
  };
}

function normalizeYoutubeApplication(value, selection) {
  if (!isObject(value)) fail("youtubeApplication must be an object");
  const status = enumValue(value.status, YOUTUBE_STATUS, "youtubeApplication.status");
  const mode = enumValue(value.mode, YOUTUBE_MODE, "youtubeApplication.mode");
  const approval = isObject(value.approval) ? value.approval : {};
  const approvalStatus = enumValue(
    approval.status,
    new Set(["not-requested", "approved"]),
    "youtubeApplication.approval.status",
  );
  if (status === "not-requested" && approvalStatus !== "not-requested") {
    fail("youtube approval cannot exist while application is not requested");
  }
  const approvedCandidateSha256 = approval.candidateSha256 === null ||
    approval.candidateSha256 === undefined
    ? null
    : sha256(approval.candidateSha256, "youtubeApplication.approval.candidateSha256");
  if (status === "not-requested" && approvedCandidateSha256 !== null) {
    fail("youtube approved candidate hash must be null while application is not requested");
  }
  if (status !== "not-requested") {
    if (selection.status !== "selected") fail("YouTube write requires a selected candidate");
    if (approvalStatus !== "approved") fail("YouTube write requires separate user approval");
    const approvedAt = timestamp(
      approval.approvedAt,
      "youtubeApplication.approval.approvedAt",
    );
    if (Date.parse(approvedAt) < Date.parse(selection.decidedAt)) {
      fail("YouTube approval cannot predate the user selection");
    }
    if (approvedCandidateSha256 !== selection.candidateSha256) {
      fail("YouTube approval must bind the exact selected candidate hash");
    }
  }
  if (status === "applied") {
    const appliedAt = timestamp(value.appliedAt, "youtubeApplication.appliedAt");
    if (Date.parse(appliedAt) < Date.parse(approval.approvedAt)) {
      fail("YouTube application cannot predate its approval");
    }
    requiredString(value.videoId, "youtubeApplication.videoId");
  } else if (value.appliedAt !== null && value.appliedAt !== undefined) {
    fail("youtubeApplication.appliedAt must be null until applied");
  }
  return {
    status,
    mode,
    approval: {
      status: approvalStatus,
      approvedAt: nullableTimestamp(
        approval.approvedAt,
        "youtubeApplication.approval.approvedAt",
      ),
      candidateSha256: approvedCandidateSha256,
    },
    appliedAt: nullableTimestamp(value.appliedAt, "youtubeApplication.appliedAt"),
    videoId: nullableString(value.videoId, "youtubeApplication.videoId"),
  };
}

function sameFinalKo(left, right) {
  return left.kind === right.kind &&
    left.path === right.path &&
    left.sha256 === right.sha256 &&
    left.revision === right.revision;
}

export function validateThumbnailPackage(document, {currentFinalKo = null} = {}) {
  if (!isObject(document)) fail("thumbnail package must be an object");
  if (document.kind !== KIND || Number(document.schemaVersion) !== VERSION) {
    fail(`thumbnail package must be ${KIND} schemaVersion ${VERSION}`);
  }
  if (!isObject(document.production)) fail("production must be an object");
  const slug = requiredString(document.production.slug, "production.slug");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
    fail("production.slug must use lowercase letters, numbers, and single hyphens");
  }
  if (document.production.workflowRole !== "optional-postwork") {
    fail("thumbnail workflowRole must be optional-postwork");
  }
  if (document.production.blocksMaster !== false) {
    fail("thumbnail package must never block master production");
  }
  if (!Array.isArray(document.candidates)) fail("candidates must be an array");
  const contentAuthority = contentContract(document.contentAuthority, slug);
  const brief = normalizeBrief(document.brief, slug);
  const generation = normalizeGeneration(document.generation, document.candidates.length);
  const candidates = document.candidates.map((candidate, index) =>
    normalizeCandidate(candidate, index, slug));
  if (generation.provider.billing === "paid" && candidates.length > 0) {
    const approvedAt = Date.parse(generation.approval.approvedAt);
    if (candidates.some((candidate) => Date.parse(candidate.generatedAt) < approvedAt)) {
      fail("paid candidate generation cannot predate its user approval");
    }
  }
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    fail("candidate ids must be unique");
  }
  if (new Set(candidates.map((candidate) => candidate.sha256)).size !== candidates.length) {
    fail("candidate hashes must be unique");
  }
  const acceptedIds = candidates
    .filter((candidate) => candidate.status === "accepted")
    .map((candidate) => candidate.id);
  const contactSheet = normalizeContactSheet(document.contactSheet, slug, acceptedIds);
  const selection = normalizeSelection(document.selection, candidates, contactSheet);
  const youtubeApplication = normalizeYoutubeApplication(
    document.youtubeApplication,
    selection,
  );
  const current = currentFinalKo === null
    ? contentAuthority
    : contentContract(currentFinalKo, slug, "currentFinalKo", {finalOnly: true});
  const fresh = sameFinalKo(contentAuthority, current);
  const state = !fresh
    ? "stale"
    : youtubeApplication.status === "applied"
      ? "applied"
      : selection.status === "selected"
        ? "selected"
        : acceptedIds.length > 0
          ? "candidates-ready"
          : "brief-ready";
  const youtubeWriteAllowed = contentAuthority.kind === "final-ko-srt" && fresh &&
    selection.status === "selected" &&
    youtubeApplication.approval.status === "approved";
  return {
    document: {
      schemaVersion: VERSION,
      kind: KIND,
      production: {
        slug,
        workflowRole: "optional-postwork",
        blocksMaster: false,
      },
      contentAuthority,
      brief,
      generation,
      candidates,
      contactSheet,
      selection,
      youtubeApplication,
    },
    state,
    fresh,
    youtubeWriteAllowed,
  };
}

export function selectThumbnailCandidate(document, {candidateId, decidedAt}) {
  const validated = validateThumbnailPackage(document);
  const candidate = validated.document.candidates.find(
    (item) => item.id === candidateId && item.status === "accepted",
  );
  if (!candidate) fail("candidateId must reference an accepted candidate");
  return validateThumbnailPackage({
    ...validated.document,
    selection: {
      status: "selected",
      candidateId: candidate.id,
      candidateSha256: candidate.sha256,
      decidedBy: "user",
      decidedAt,
    },
    youtubeApplication: {
      status: "not-requested",
      mode: validated.document.youtubeApplication.mode,
      approval: {
        status: "not-requested",
        approvedAt: null,
        candidateSha256: null,
      },
      appliedAt: null,
      videoId: null,
    },
  }).document;
}

export function approveThumbnailYoutubeApplication(
  document,
  {approvedAt, mode = "youtube-studio-later"},
) {
  const validated = validateThumbnailPackage(document);
  if (validated.document.selection.status !== "selected") {
    fail("select a candidate before approving YouTube application");
  }
  return validateThumbnailPackage({
    ...validated.document,
    youtubeApplication: {
      ...validated.document.youtubeApplication,
      status: "approved",
      mode,
      approval: {
        status: "approved",
        approvedAt,
        candidateSha256: validated.document.selection.candidateSha256,
      },
      appliedAt: null,
      videoId: null,
    },
  }).document;
}

export function assertThumbnailYoutubeWriteAllowed(document, {currentFinalKo}) {
  const validated = validateThumbnailPackage(document, {currentFinalKo});
  if (!validated.youtubeWriteAllowed) {
    fail(`thumbnail YouTube write is not allowed while state is ${validated.state}`);
  }
  return {
    productionSlug: validated.document.production.slug,
    candidateId: validated.document.selection.candidateId,
    candidateSha256: validated.document.selection.candidateSha256,
    mode: validated.document.youtubeApplication.mode,
  };
}

export const thumbnailPackageContract = Object.freeze({
  kind: KIND,
  schemaVersion: VERSION,
  requiredCandidateChecks: [...REQUIRED_CHECKS],
});
