import * as vscode from "vscode";
import { TaskConnector } from "./tasks/provider";
import { track } from "./telemetry/telemetry";

/** globalState flag marking that first-run setup has been handled. */
export const SETUP_COMPLETE_KEY = "agentFlow.setupComplete";

type Log = (m: string) => void;
type Refresh = () => void | Promise<void>;

async function updateGlobal(key: string, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration("agentFlow")
    .update(key, value, vscode.ConfigurationTarget.Global);
}

function abort(log: Log, reason: string): false {
  log(`setup: ${reason}`);
  return false;
}

/**
 * Guided first-run setup. Delegates the source-specific settings to the
 * connector's own `configure()` — which owns their input boxes and validation —
 * then collects the one setting every source needs (where repo checkouts live),
 * then delegates credential collection to the existing sign-in flow (which
 * stores to SecretStorage).
 *
 * Returns true only if setup ran to completion (config saved AND signed in).
 * Cancelling any step aborts without marking setup complete, so it can re-run.
 *
 * Every setting is written in ONE block after the last cancellable step, which is
 * the whole reason `configure()` returns a commit thunk instead of writing: an
 * already-configured user who re-runs the wizard and presses Esc at the last box
 * must be left with their previous settings intact. A connector that wrote inside
 * `configure()` would already have overwritten their site URL and project key by
 * then — no undo, no toast, and the log line still saying nothing happened.
 */
/** The wizard currently on screen, if any. `runSetup` is reachable from the
 * palette command and from the lingering first-run welcome toast at the same
 * time; without this latch the two invocations interleave — two wizards
 * fighting over focus, duplicate credential prompts. A second caller joins the
 * in-flight run and gets its result. */
let setupInFlight: Promise<boolean> | undefined;

export async function runSetup(
  context: vscode.ExtensionContext,
  connector: TaskConnector,
  log: Log,
  refresh?: Refresh,
  source: "offer" | "command" = "command",
): Promise<boolean> {
  if (setupInFlight) {
    log("setup: already running — joining the in-flight wizard");
    return setupInFlight;
  }
  setupInFlight = doRunSetup(context, connector, log, refresh, source).finally(() => {
    setupInFlight = undefined;
  });
  return setupInFlight;
}

async function doRunSetup(
  context: vscode.ExtensionContext,
  connector: TaskConnector,
  log: Log,
  refresh?: Refresh,
  source: "offer" | "command" = "command",
): Promise<boolean> {
  log("setup: started");

  const total = connector.setupSteps + 1; // + the repos root, which is ours not theirs
  track({ name: "setup_started", source, connector_steps: connector.setupSteps });
  // Collected, not yet written: `null` means the user cancelled inside the
  // connector's own steps, anything else is the write to perform below.
  const commitSource = await connector.configure(1, total);
  if (!commitSource) {
    track({ name: "setup_completed", outcome: "cancelled-source", signed_in: false });
    return abort(log, "cancelled at source configuration");
  }

  const reposRoot = await vscode.window.showInputBox({
    title: `Agent Flow Deck Setup (${total}/${total})`,
    prompt: "Directory where your repo checkouts live",
    ignoreFocusOut: true,
    value: "~/projects",
    validateInput: (v) => (v.trim() ? undefined : "Enter a directory path"),
  });
  if (reposRoot === undefined) {
    track({ name: "setup_completed", outcome: "cancelled-root", signed_in: false });
    return abort(log, "cancelled at repos root");
  }

  // Persist config (global) before credentials — the connector's settings and ours
  // together, past the last point the user can back out. workspaceDir is derived
  // from reposRoot to keep the wizard short; it remains overridable. Per-task
  // worktrees live inside each repo (.claude/worktrees/<KEY>), so there's no root
  // to configure.
  const cleanRoot = reposRoot.trim().replace(/\/+$/, "");
  // The one block that writes. It can still fail after the last cancellable step
  // — a read-only settings.json rejects `update()` — and letting that escape
  // would leave a half-written config with SETUP_COMPLETE_KEY unset, no message,
  // and an unhandled rejection. Failing the wizard loudly keeps the promise the
  // comment above makes: setup either completes or is safely re-runnable.
  try {
    await commitSource();
    await updateGlobal("reposRoot", cleanRoot);
    await updateGlobal("workspaceDir", cleanRoot);
  } catch (e) {
    vscode.window.showWarningMessage(
      `Agent Flow Deck: saving settings failed (${e instanceof Error ? e.message : e}). ` +
        "Check that your settings.json is writable, then re-run setup.",
    );
    return abort(log, `settings write failed: ${e}`);
  }
  // `info()` re-reads settings, so this sees the scope the commit above just wrote
  // (e.g. the Jira project key) — which is also why the commit runs first, not last:
  // generic wording since this file no longer knows the source, but the value itself
  // must survive the rename off `project`.
  const info = connector.info();
  log(`setup: config saved (${info.scopeNoun} ${info.scopeValue}, root ${cleanRoot})`);

  const label = info.label;
  if (!(await connector.signIn())) {
    vscode.window.showWarningMessage(
      `Agent Flow Deck: settings saved, but ${label} sign-in was cancelled. Use "Sign in to ${label}" to finish.`,
    );
    track({ name: "setup_completed", outcome: "signin-skipped", signed_in: false });
    return abort(log, "sign-in skipped (config saved)");
  }

  await context.globalState.update(SETUP_COMPLETE_KEY, true);
  log("setup: complete");
  track({ name: "setup_completed", outcome: "complete", signed_in: true });
  vscode.window.showInformationMessage("Agent Flow Deck is set up. Loading your tasks…");
  await refresh?.();
  return true;
}

/**
 * On activation, offer setup once if the extension has never been configured.
 * Non-nagging: skips silently when already configured (e.g. via settings.json),
 * and only offers — never forces — the wizard.
 */
export async function maybeRunSetup(
  context: vscode.ExtensionContext,
  connector: TaskConnector,
  log: Log,
  refresh?: Refresh,
): Promise<void> {
  if (context.globalState.get<boolean>(SETUP_COMPLETE_KEY)) return;

  if (connector.isConfigured()) {
    // Already set up outside the wizard — remember and stay quiet.
    await context.globalState.update(SETUP_COMPLETE_KEY, true);
    return;
  }

  const label = connector.info().label;
  const choice = await vscode.window.showInformationMessage(
    `Welcome to Agent Flow Deck — let's connect it to your ${label}.`,
    "Set up",
    "Later",
  );
  if (choice === "Set up") {
    await runSetup(context, connector, log, refresh, "offer");
  } else {
    log("setup: deferred by user");
    track({ name: "setup_completed", outcome: "deferred", signed_in: false });
    // Leave the flag unset so setup is offered again next activation.
  }
}
