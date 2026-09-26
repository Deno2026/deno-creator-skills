import crypto from "node:crypto";

import {validateProductionState} from "./production-state.mjs";

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function readCurrentState(state, domain) {
  if (!isObject(state)) return null;
  if (domain === "master") return state.master?.status ?? null;
  if (domain === "edit") return state.master?.edit?.status ?? null;
  if (domain === "audio") return state.master?.audio?.status ?? null;
  if (domain === "captions") return state.master?.captions?.status ?? null;
  if (domain === "motion") return state.master?.motion?.status ?? null;
  if (domain === "publishing") return state.publishing?.status ?? null;
  if (domain === "thumbnail") return state.packaging?.thumbnail?.status ?? null;
  return state.active?.state ?? null;
}

function collectStateNotes(state, validationError, productionMismatch) {
  const notes = [];
  if (!state) {
    notes.push("Use the user request and current live state.");
    return notes;
  }
  if (validationError) {
    notes.push("Use current live state and artifact pointers for this operation.");
  }
  if (productionMismatch) {
    notes.push("Confirm the requested production identity from the live target before a write.");
  }
  return notes;
}

/**
 * Creates an advisory workflow selection with the current state pointer.
 */
export function buildProductionTaskEnvelope({route, state = null, production = null} = {}) {
  if (!route || typeof route !== "object") throw new Error("route is required");

  let validationError = null;
  if (state) {
    try {
      validateProductionState(state);
    } catch (error) {
      validationError = error instanceof Error ? error : new Error(String(error));
    }
  }

  const stateProduction = typeof state?.production === "string" ? state.production : null;
  const productionMismatch = Boolean(production && stateProduction && production !== stateProduction);
  production ??= stateProduction;

  const updatedAt = typeof state?.updatedAt === "string" ? state.updatedAt : "no-state";
  const seed = `${production ?? "unbound"}\n${route.intent}\n${route.request}\n${updatedAt}`;
  const digest = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);

  return {
    schemaVersion: 2,
    operationId: `${route.intent}-${digest}`,
    production,
    domain: route.domain ?? "unknown",
    action: route.intent,
    currentState: readCurrentState(state, route.domain),
    readOrder: route.workflows ?? [],
    advisoryOnly: true,
    stateNotes: collectStateNotes(state, validationError, productionMismatch),
    guidance: route.guidance ?? [],
  };
}
