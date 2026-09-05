import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { getConfig } from "../config";
import { createIdentity, Identity } from "./identity";
import { createPostHogSender, PostHogSender } from "./posthog";
import { AnalyticsEvent, ErrorEvent, UsageEvent } from "./events";

/** Analytics is ambient infrastructure, like the output channel: a module-level
 * singleton rather than a parameter threaded through ~30 engine signatures.
 * Tests call resetTelemetryForTests() to isolate. */
interface State {
  logger: vscode.TelemetryLogger;
  sender: PostHogSender;
  identity: Identity;
  log: (m: string) => void;
  disposables: vscode.Disposable[];
}

let state: State | undefined;

export interface Flow {
  id: string;
  elapsedMs(): number;
}

/** A correlation id for one multi-step flow, plus its own stopwatch. The id is
 * random — derived from nothing about the user — and is what makes funnel analysis
 * work when two Takes overlap. */
export function startFlow(): Flow {
  // performance.now() is monotonic; Date.now() is not — a clock adjustment
  // mid-flow yielded wrong or negative durations (follow-ups doc, item 4).
  const started = performance.now();
  return { id: randomUUID(), elapsedMs: () => Math.round(performance.now() - started) };
}

function settingEnabled(): boolean {
  try {
    return getConfig().telemetryEnabled;
  } catch {
    return false;
  }
}

export function initTelemetry(context: vscode.ExtensionContext, log: (m: string) => void): void {
  if (state) return;
  const identity = createIdentity(context.globalState);
  const commonProperties = {
    session_id: identity.sessionId,
    env_type: context.extensionMode === vscode.ExtensionMode.Production ? "production" : "development",
    app_name: vscode.env.appName,
    app_host: vscode.env.appHost,
    remote_name: vscode.env.remoteName ?? "local",
    ui_kind: vscode.env.uiKind === vscode.UIKind.Web ? "web" : "desktop",
  };
  // The sender owns both the consent gate and the common properties, because it is
  // the only component every path reaches: VS Code routes unhandled extension-host
  // errors to `sender.sendErrorData` itself, without passing through track() /
  // trackError() or through `additionalCommonProperties`. Handing the sender
  // `settingEnabled` (the function, re-read per event) keeps re-enabling
  // mid-session working — nothing here is captured once and cached.
  const sender = createPostHogSender({
    distinctId: identity.distinctId,
    log,
    isConsented: settingEnabled,
    commonProperties,
  });
  // No `additionalCommonProperties`: it would merge the same keys a second time
  // on the logUsage/logError(name, data) paths only, which is exactly the
  // non-uniformity the sender-side merge above exists to remove.
  const logger = vscode.env.createTelemetryLogger(sender);

  // Consent withdrawn mid-session must discard what is queued, not flush it.
  // Stopping *new* events is the sender's isConsented gate, not this handler's
  // job — deliberately not sender.dispose(), which is a permanent off switch and
  // would break re-enabling the setting later in the same session.
  // We log this ourselves rather than relying solely on PostHogSender.drop()'s
  // own message, which is gated on the queue being non-empty — withdrawing
  // consent between flushes is genuine and worth recording even when there
  // happened to be nothing queued at that moment.
  function withdrawConsent(): void {
    sender.drop();
    log("telemetry: consent withdrawn, discarding any queued events");
  }

  const disposables: vscode.Disposable[] = [
    vscode.env.onDidChangeTelemetryEnabled((on) => { if (!on) withdrawConsent(); }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentFlow.telemetry.enabled") && !settingEnabled()) withdrawConsent();
    }),
  ];

  state = { logger, sender, identity, log, disposables };
  writeHeadlessIdentity(identity.distinctId, log);
}

/** Leave `distinct_id` where `dist/tick.js` can find it.
 *
 * A headless pass has no `vscode.env.machineId` to read and deliberately mints
 * nothing of its own — a tick that invented an id would report as a brand-new
 * user on every cron run, and the reach numbers would be fiction. So the
 * extension writes the id it already sends, once, beside the flows both
 * processes share.
 *
 * Written ONLY while telemetry is consented, which is why an install that has
 * opted out never grows this file at all: with it absent, `sendHeadless`
 * refuses. A user who turns telemetry back on gets the file at the next window's
 * activation — a lag measured in "the next time you open your editor", and the
 * conservative direction to err in.
 *
 * Best-effort in every failure mode. This runs inside `activate()`, and no
 * failure to write an analytics convenience may take the extension down with it
 * — a read-only home directory is a working editor, not a broken one. */
function writeHeadlessIdentity(distinctId: string, log: (m: string) => void): void {
  if (!settingEnabled()) return;
  try {
    const dir = path.join(os.homedir(), ".agentflow");
    const file = path.join(dir, "telemetry.json");
    // Only the id, and only when it is not already the id on disk: this runs on
    // every activation, and rewriting an unchanged file every window open is
    // pointless disk churn.
    const wanted = JSON.stringify({ distinctId }, null, 2) + "\n";
    let current: string | undefined;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch {
      // Absent, which is the case this function exists for.
    }
    if (current === wanted) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, wanted);
  } catch (e) {
    log(`telemetry: could not write the headless identity file: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Every key across the whole event catalog, distributed over the union so
 * union members contribute their own keys instead of collapsing to the keys
 * common to all of them (plain `keyof AnalyticsEvent` would yield only "name"). */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/** Rejects any property not present on some member of AnalyticsEvent by requiring
 * it to be of type `never`. Closes the gap events.ts documents: TypeScript's
 * excess-property check only fires for a fresh object literal assigned directly
 * where the target type is expected, not once a literal has been bound to a
 * variable or spread first. This generic re-applies that check at the call
 * boundary regardless of how the caller built the object. */
type NoExcess<E> = E & Record<Exclude<keyof E, KeysOfUnion<AnalyticsEvent>>, never>;

export function track<E extends UsageEvent>(event: NoExcess<E>): void {
  if (!state || !settingEnabled() || !state.logger.isUsageEnabled) return;
  try {
    // Only the event's own properties: the sender attaches the common ones to
    // every event it queues, so merging them here too would just duplicate them.
    const { name, ...properties } = event as UsageEvent;
    state.logger.logUsage(name, properties);
  } catch (e) {
    state.log(`telemetry: track failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function trackError<E extends ErrorEvent>(event: NoExcess<E>): void {
  if (!state || !settingEnabled() || !state.logger.isErrorsEnabled) return;
  try {
    const { name, ...properties } = event as ErrorEvent;
    state.logger.logError(name, properties);
  } catch (e) {
    state.log(`telemetry: trackError failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Salted, per-install hash. Empty string when uninitialised, so callers can build
 * an event literal unconditionally. */
export function fingerprint(value: string): string {
  return state ? state.identity.fingerprint(value) : "";
}

/** Never throws: matches the no-throw contract every other exported function in
 * this module already honours, and deactivate() relies on it (see extension.ts) —
 * a real dispose failure must not stop window-close cleanup or skip the other
 * disposals. Each disposal is independently guarded so one throwing doesn't skip
 * the rest, and `state` is unconditionally cleared at the end even if every
 * disposal failed — otherwise a stuck `state` would wedge track()/trackError()
 * into believing telemetry is still live. */
export function disposeTelemetry(): void {
  if (!state) return;
  const { disposables, logger, sender, log } = state;
  for (const d of disposables) {
    try {
      d.dispose();
    } catch (e) {
      log(`telemetry: dispose failed for a listener: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Best-effort: deactivate() is synchronous and will not await this.
  try {
    logger.dispose();
  } catch (e) {
    log(`telemetry: logger dispose failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    sender.dispose();
  } catch (e) {
    log(`telemetry: sender dispose failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  state = undefined;
}

/** Identical to disposeTelemetry(): tests call this between cases so a stale
 * initTelemetry() from a previous test never leaves its onDidChangeTelemetryEnabled
 * / onDidChangeConfiguration listeners registered — those would otherwise still
 * fire (alongside the current test's own listeners) against a later test's mocks.
 * Safe to call when uninitialised, and safe to call more than once. Kept as a
 * separate, differently-named export so call sites can say what they mean —
 * "isolate the next test" vs. "the extension is deactivating" — even though
 * the effect is the same. */
export function resetTelemetryForTests(): void {
  disposeTelemetry();
}
