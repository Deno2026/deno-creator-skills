const SCHEMA_VERSION = 2;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const MASTER_DOMAIN_KEYS = Object.freeze([
  "edit",
  "audio",
  "motion",
  "captions",
  "render",
]);

const PUBLISHING_DOMAIN_KEYS = Object.freeze([
  "request",
  "video",
  "sync",
  "postUpload",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmptyString(value, label) {
  assert(typeof value === "string" && value.trim(), `${label} must be a non-empty string`);
  return value.trim();
}

export function createInitialProductionState({slug, createdAt = new Date().toISOString()} = {}) {
  const normalizedSlug = nonEmptyString(slug, "slug");
  assert(SLUG_PATTERN.test(normalizedSlug), "slug must use lowercase letters, numbers, and single hyphens");
  const timestamp = nonEmptyString(createdAt, "createdAt");
  assert(!Number.isNaN(Date.parse(timestamp)), "createdAt must be an ISO timestamp");

  return {
    schemaVersion: SCHEMA_VERSION,
    production: normalizedSlug,
    createdAt: timestamp,
    updatedAt: timestamp,
    active: {
      domain: "edit",
      state: "created",
      nextAction: "edit.bind-premiere-source",
    },
    master: {
      status: "pending",
      edit: {status: "pending", revision: null, manifest: null},
      audio: {status: "pending", revision: null, manifest: null},
      motion: {status: "pending", revision: null, manifest: null},
      captions: {status: "pending", revision: null, manifest: null},
      render: {status: "pending", revision: null, manifest: null},
    },
    publishing: {
      status: "not_started",
      request: {status: "not_started", revision: null, manifest: null},
      video: {status: "not_uploaded", revision: null, manifest: null},
      sync: {status: "not_applicable_yet", revision: null, manifest: null},
      postUpload: {status: "pending", revision: null, manifest: null},
    },
    packaging: {
      metadata: {status: "optional_pending", revision: null, manifest: null},
      thumbnail: {status: "optional_pending", revision: null, manifest: null},
    },
  };
}

function validateDomainEntry(entry, label) {
  assert(entry && typeof entry === "object" && !Array.isArray(entry), `${label} must be an object`);
  nonEmptyString(entry.status, `${label}.status`);
  assert(entry.revision === null || typeof entry.revision === "string", `${label}.revision must be null or a string`);
  assert(entry.manifest === null || typeof entry.manifest === "string", `${label}.manifest must be null or a string`);
}

export function validateProductionState(state) {
  assert(state && typeof state === "object" && !Array.isArray(state), "state must be an object");
  assert(
    state.schemaVersion === 1 || state.schemaVersion === SCHEMA_VERSION,
    `schemaVersion must be 1 or ${SCHEMA_VERSION}`,
  );
  assert(SLUG_PATTERN.test(nonEmptyString(state.production, "production")), "production slug is invalid");
  nonEmptyString(state.createdAt, "createdAt");
  nonEmptyString(state.updatedAt, "updatedAt");
  assert(state.active && typeof state.active === "object", "active must be an object");
  nonEmptyString(state.active.domain, "active.domain");
  nonEmptyString(state.active.state, "active.state");
  nonEmptyString(state.active.nextAction, "active.nextAction");

  assert(state.master && typeof state.master === "object", "master must be an object");
  nonEmptyString(state.master.status, "master.status");
  for (const key of MASTER_DOMAIN_KEYS) validateDomainEntry(state.master[key], `master.${key}`);

  assert(state.publishing && typeof state.publishing === "object", "publishing must be an object");
  nonEmptyString(state.publishing.status, "publishing.status");
  for (const key of PUBLISHING_DOMAIN_KEYS) {
    validateDomainEntry(state.publishing[key], `publishing.${key}`);
  }

  assert(state.packaging && typeof state.packaging === "object", "packaging must be an object");
  validateDomainEntry(state.packaging.metadata, "packaging.metadata");
  validateDomainEntry(state.packaging.thumbnail, "packaging.thumbnail");

  const serialized = JSON.stringify(state).toLowerCase();
  for (const forbidden of ["access_token", "refresh_token", "client_secret", "oauth-token", "premiere pid"]) {
    assert(!serialized.includes(forbidden), `state must not contain secret/runtime field '${forbidden}'`);
  }
  return state;
}

export function isMasterReady(state) {
  validateProductionState(state);
  return state.master.status === "ready" && MASTER_DOMAIN_KEYS.every(
    (key) => state.master[key].status === "complete" || state.master[key].status === "not_applicable",
  );
}

export const PRODUCTION_STATE_SCHEMA_VERSION = SCHEMA_VERSION;
