import { LandedRecord, QueueItem, RISKS, Risk } from "./types";

/**
 * An id is also a filename, so it is restricted to characters that cannot
 * escape the queue directory or collide across case-insensitive filesystems.
 */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

export type ValidationResult = { ok: true; item: QueueItem } | { ok: false; error: string };

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateItem(raw: unknown): ValidationResult {
  if (!isRecord(raw)) return { ok: false, error: "item must be an object" };

  for (const field of ["cycle", "role", "kind", "title", "why", "on_approve"]) {
    if (!nonEmptyString(raw[field])) return { ok: false, error: `${field} must be a non-empty string` };
  }

  if (!nonEmptyString(raw.id) || !ID_RE.test(raw.id)) {
    return { ok: false, error: "id must be lowercase letters, digits and dashes, 1–120 chars" };
  }

  if (!RISKS.includes(raw.risk as Risk)) {
    return { ok: false, error: `risk must be one of ${RISKS.join(", ")}` };
  }

  const artifact = raw.artifact;
  if (!isRecord(artifact)) return { ok: false, error: "artifact must be an object" };
  if (!nonEmptyString(artifact.type)) return { ok: false, error: "artifact.type must be a non-empty string" };
  if (!nonEmptyString(artifact.path) && !nonEmptyString(artifact.inline)) {
    return { ok: false, error: "artifact needs a path or inline content" };
  }

  if (raw.branch !== undefined && !nonEmptyString(raw.branch)) {
    return { ok: false, error: "branch must be a non-empty string when present" };
  }

  if (raw.checks !== undefined) {
    if (!isRecord(raw.checks)) return { ok: false, error: "checks must be an object" };
    for (const [key, value] of Object.entries(raw.checks)) {
      if (typeof value !== "string") return { ok: false, error: `checks.${key} must be a string` };
    }
  }

  return { ok: true, item: raw as unknown as QueueItem };
}

export type LandedValidation =
  | { ok: true; record: LandedRecord }
  | { ok: false; error: string };

export function validateLanded(raw: unknown): LandedValidation {
  if (!isRecord(raw)) return { ok: false, error: "record must be an object" };
  for (const field of ["id", "cycle", "role", "title", "landed_at"]) {
    if (!nonEmptyString(raw[field])) return { ok: false, error: `${field} must be a non-empty string` };
  }
  if (!nonEmptyString(raw.sha) || !SHA_RE.test(raw.sha)) {
    return { ok: false, error: "sha must be 7–40 hex characters" };
  }
  return { ok: true, record: raw as unknown as LandedRecord };
}
