import * as vscode from "vscode";
import { createHash, randomUUID } from "crypto";

/** globalState key holding this install's hashing salt. Never transmitted. */
export const SALT_KEY = "agentFlow.telemetry.salt";

export interface Identity {
  /** VS Code's own anonymous, stable machine id. We never mint an identifier. */
  distinctId: string;
  sessionId: string;
  /** Salted SHA-256, truncated to 16 hex chars. Stable within this install and
   * meaningless outside it — the salt is per-install and never leaves the machine,
   * so cross-user aggregation of hashed values is impossible by construction. */
  fingerprint(value: string): string;
}

export function createIdentity(state: vscode.Memento): Identity {
  let salt: string | undefined;

  // Guard against both synchronous throws and rejected promises. If persisting
  // the salt fails for any reason, fall back to an in-memory session salt so
  // createIdentity never throws into activate().
  try {
    salt = state.get<string>(SALT_KEY);
  } catch {
    // Ignore read errors; proceed with in-memory salt below.
  }

  if (!salt) {
    salt = randomUUID();
    // Fire-and-forget: attempt to persist the salt, but swallow both rejected
    // promises and any synchronous throws so nothing escapes to activate().
    try {
      void Promise.resolve(state.update(SALT_KEY, salt)).then(undefined, () => undefined);
    } catch {
      // Synchronous throw from state.update; salt stays in memory for this session.
    }
  }

  const s = salt;
  return {
    distinctId: vscode.env.machineId,
    sessionId: vscode.env.sessionId,
    fingerprint: (value: string) =>
      createHash("sha256").update(`${s}:${value}`).digest("hex").slice(0, 16),
  };
}
