import * as vscode from "vscode";
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
  /** Mixed into every event's properties ourselves rather than left solely to
   * `additionalCommonProperties`: VS Code's real TelemetryLogger merges that in
   * on the way to the sender, after our own call to logUsage/logError has
   * already happened — too late for anything (like a test double) that only
   * observes the arguments of that call. */
  commonProperties: Record<string, unknown>;
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
  const started = Date.now();
  return { id: randomUUID(), elapsedMs: () => Date.now() - started };
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
  const sender = createPostHogSender({ distinctId: identity.distinctId, log });
  const commonProperties = {
    session_id: identity.sessionId,
    env_type: context.extensionMode === vscode.ExtensionMode.Production ? "production" : "development",
    app_name: vscode.env.appName,
    app_host: vscode.env.appHost,
    remote_name: vscode.env.remoteName ?? "local",
    ui_kind: vscode.env.uiKind === vscode.UIKind.Web ? "web" : "desktop",
  };
  // Passed through too so a real host's own TelemetryLogger mixes these into
  // whatever it additionally forwards (e.g. its own built-in properties);
  // harmless duplication with the manual merge in track()/trackError() below.
  const logger = vscode.env.createTelemetryLogger(sender, { additionalCommonProperties: commonProperties });

  // Consent withdrawn mid-session must discard what is queued, not flush it.
  // We log this ourselves rather than relying solely on PostHogSender.drop()'s
  // own (queue-non-empty-gated) message: until POSTHOG_API_KEY is a real key,
  // the sender no-ops and never queues anything, so that message would never
  // fire even though consent genuinely was withdrawn.
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

  state = { logger, sender, identity, log, disposables, commonProperties };
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
    const { name, ...properties } = event as UsageEvent;
    state.logger.logUsage(name, { ...state.commonProperties, ...properties });
  } catch (e) {
    state.log(`telemetry: track failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function trackError<E extends ErrorEvent>(event: NoExcess<E>): void {
  if (!state || !settingEnabled() || !state.logger.isErrorsEnabled) return;
  try {
    const { name, ...properties } = event as ErrorEvent;
    state.logger.logError(name, { ...state.commonProperties, ...properties });
  } catch (e) {
    state.log(`telemetry: trackError failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Salted, per-install hash. Empty string when uninitialised, so callers can build
 * an event literal unconditionally. */
export function fingerprint(value: string): string {
  return state ? state.identity.fingerprint(value) : "";
}

export function disposeTelemetry(): void {
  if (!state) return;
  for (const d of state.disposables) d.dispose();
  // Best-effort: deactivate() is synchronous and will not await this.
  state.logger.dispose();
  state.sender.dispose();
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
