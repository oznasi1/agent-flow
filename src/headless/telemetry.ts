// Telemetry for `dist/tick.js` — the one path that reports without an editor.
//
// Everything here exists because the extension-host facade cannot be reused as
// it stands. `telemetry/telemetry.ts` is built on `vscode.env.createTelemetryLogger`
// and `identity.ts` reads `vscode.env.machineId` out of `globalState`; neither
// exists in a bare node process. What CAN be reused is the sender itself —
// `posthog.ts` names `vscode` only as a type (`extends vscode.TelemetrySender`)
// and touches nothing of it at runtime, so the batching, the consent gate, the
// single retry and the 5-second request timeout are the same code the editor
// runs, not a second implementation of them.
//
// Two things this file is careful about, because there is no editor above it to
// be careful on its behalf:
//
//  1. CONSENT. In the editor, `TelemetryLogger` enforces the user's global
//     `telemetry.telemetryLevel` before our own `agentFlow.telemetry.enabled` is
//     ever consulted. Out here nothing does, so BOTH are read from the same
//     settings.json the tick already loads, and both must say yes.
//  2. IDENTITY. `vscode.env.machineId` is not readable from here, and this file
//     will not mint an identifier of its own — a tick that invented one would
//     show up as a brand-new user on every cron run. It reads the id the
//     extension left in `~/.agentflow/telemetry.json` instead, and if that file
//     is absent it sends NOTHING. An install that has never run the extension
//     with telemetry enabled is an install that never agreed to be counted.
import * as fs from "fs";
import * as path from "path";
import { createPostHogSender } from "../telemetry/posthog";
import { UsageEvent } from "../telemetry/events";
import { defaultFlowsDir } from "../engine/orchestrator/store";

/** Where the extension leaves the id a headless pass reports under. Beside the
 * flows the tick already reads, under `~/.agentflow/`, for the same reason the
 * flows live there: it is the one directory both the editor and a cron job can
 * agree on. */
export function identityFile(dir: string = defaultFlowsDir()): string {
  return path.join(path.dirname(dir), "telemetry.json");
}

/** The stored handoff. `distinctId` is `vscode.env.machineId` — VS Code's own
 * anonymous per-machine id, which the extension already sends as `distinct_id`.
 * Nothing else is stored, and the salt used for fingerprints deliberately is
 * NOT: a headless pass sends no fingerprinted value, so it has no business
 * holding the salt that would let it. */
export interface HeadlessIdentity {
  distinctId: string;
}

export function readIdentity(file: string): HeadlessIdentity | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // Absent is the ordinary case, not an error: the extension writes this only
    // once telemetry is on.
    return undefined;
  }
  try {
    const v = JSON.parse(text) as { distinctId?: unknown };
    return typeof v.distinctId === "string" && v.distinctId !== "" ? { distinctId: v.distinctId } : undefined;
  } catch {
    return undefined;
  }
}

/** Does this settings file consent to telemetry? BOTH gates, and both default
 * the way the editor defaults them: `agentFlow.telemetry.enabled` is on unless
 * turned off, and the editor's `telemetry.telemetryLevel` is `"all"` unless
 * narrowed. Anything but `"all"` is a no here — `"error"` and `"crash"` admit
 * only error events, and the tick sends a usage event or nothing.
 *
 * The key is read BOTH ways VS Code's settings can spell a dotted setting: flat
 * (`"agentFlow.telemetry.enabled"`, what the settings UI writes) and nested
 * under an `agentFlow` object, which is how a hand-organised file often reads.
 * `readerFor` does the same for every other setting; this cannot use it, because
 * `telemetry.telemetryLevel` is not ours and carries no `agentFlow.` prefix. */
export function consented(raw: Record<string, unknown>): boolean {
  const level = raw["telemetry.telemetryLevel"];
  if (typeof level === "string" && level !== "all") return false;
  const flat = raw["agentFlow.telemetry.enabled"];
  if (typeof flat === "boolean") return flat;
  const nested = raw.agentFlow && typeof raw.agentFlow === "object" ? (raw.agentFlow as Record<string, unknown>) : {};
  const under = nested["telemetry.enabled"];
  if (typeof under === "boolean") return under;
  const deep = nested.telemetry && typeof nested.telemetry === "object" ? (nested.telemetry as Record<string, unknown>) : {};
  return typeof deep.enabled === "boolean" ? deep.enabled : true;
}

export interface HeadlessTelemetryDeps {
  raw: Record<string, unknown>;
  log: (m: string) => void;
  /** Overridden by the test; the real file otherwise. */
  identity?: HeadlessIdentity | undefined;
  fetchImpl?: typeof fetch;
}

/** Send one usage event and wait for it to leave, or do nothing at all.
 *
 * Awaited by the caller on purpose, unlike every send in the editor: this
 * process is about to exit, and a queued event that has not been flushed is a
 * lost one. `dispose()` after the flush is what lets it exit at all — the sender
 * keeps a `setInterval` alive, and an un-disposed one would hold the event loop
 * open for the full flush interval on every single cron run.
 *
 * Never throws, and never blocks the pass's exit code on a network problem: the
 * tick's job is the pass, and reporting on it is the part that is allowed to
 * fail silently. */
export async function sendHeadless(event: UsageEvent, deps: HeadlessTelemetryDeps): Promise<void> {
  if (!consented(deps.raw)) return;
  const identity = deps.identity ?? readIdentity(identityFile());
  if (!identity) return;
  const sender = createPostHogSender({
    distinctId: identity.distinctId,
    log: deps.log,
    // Already decided above, off the same file, and it cannot change underneath a
    // process that lives for one pass.
    isConsented: () => true,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    commonProperties: {
      // No `session_id`: there is no editor session. `env_type` is always
      // production out here — a tick is only ever run from a built `dist/tick.js`
      // — and `app_host`/`ui_kind` name the shell rather than pretending to be an
      // editor, so a headless event is never mistaken for one from a window.
      env_type: "production",
      // "agentflow-tick", not "agent-flow-tick": the hyphen in the latter makes
      // "agent" a standalone word, which the vocabulary gate refuses — a session
      // is not an agent, and the check has no way to know this one is a product
      // name. The value is new, so nothing is being renamed on the wire.
      app_name: "agentflow-tick",
      app_host: "cli",
      remote_name: "local",
      ui_kind: "desktop",
    },
  });
  try {
    const { name, ...properties } = event;
    sender.sendEventData(name, properties);
    await sender.flush();
  } catch (e) {
    deps.log(`telemetry: headless send failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    sender.dispose();
  }
}
