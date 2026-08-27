import { TaskApiError, TaskAuthError } from "../provider";

/** A failed `sf` invocation. Keeps the Salesforce error code and message intact
 *  so a caller can react structurally rather than by matching prose.
 *  status/fieldErrors/messages are NOT re-declared readonly here — the base
 *  class already declares them, and re-declaring would shadow rather than set. */
export class SfApiError extends TaskApiError {
  constructor(status: number, message: string, fieldErrors: Record<string, string>, messages: string[]) {
    super(status, message, fieldErrors, messages);
    this.name = "SfApiError";
  }
}

/** The shape `sf --json` uses for a failure: a top-level `name` carrying the
 *  Salesforce error code, and a human `message`. */
export interface SfErrorEnvelope {
  name?: unknown;
  message?: unknown;
}

/** Codes that mean "we are not usefully authenticated", as distinct from "the
 *  request was wrong". Views branch on TaskAuthError to show the sign-in gate,
 *  so misfiling one of these as an API error strands the user on an error toast
 *  with no way forward. */
const AUTH_CODES = new Set([
  "INVALID_SESSION_ID",
  "INVALID_LOGIN",
  "RefreshTokenAuthError",
  "NoAuthInfoFound",
  "NamedOrgNotFoundError",
  "NoDefaultEnvError",
]);

/** `sf` is not HTTP, so there is no real status. Synthesize one only where the
 *  meaning is unambiguous, and use 0 — not a guess — for everything else. */
export function statusForCode(code: string): number {
  if (code === "NOT_FOUND" || code === "INVALID_CROSS_REFERENCE_KEY") return 404;
  if (code === "REQUEST_LIMIT_EXCEEDED") return 429;
  if (code.startsWith("INVALID_") || code.startsWith("MALFORMED_")) return 400;
  return 0;
}

/** Turn `sf`'s stdout on a failed run into the right seam error. `fallback` is
 *  used verbatim when stdout is not the JSON envelope — an `sf` that died before
 *  it could format anything, a shell "command not found", an empty body. */
export function classifySfFailure(raw: string, fallback: string): Error {
  let code = "";
  let message = "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const env = parsed as SfErrorEnvelope;
      if (typeof env.name === "string") code = env.name.trim();
      if (typeof env.message === "string") message = env.message.trim();
    }
  } catch {
    /* Not JSON. `fallback` also carries the message when the envelope parses
       but names no message of its own — see the `message || fallback` below. */
  }

  const text = message || fallback;
  if (code && AUTH_CODES.has(code)) return new TaskAuthError(text);
  return new SfApiError(statusForCode(code), text, {}, message ? [message] : []);
}
