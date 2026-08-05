import * as vscode from "vscode";
import { TaskConnector } from "./tasks/provider";

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
 * connector's own `configure()` — which owns their input boxes, validation and
 * writes — then collects the one setting every source needs (where repo
 * checkouts live), then delegates credential collection to the existing
 * sign-in flow (which stores to SecretStorage).
 *
 * Returns true only if setup ran to completion (config saved AND signed in).
 * Cancelling any step aborts without marking setup complete, so it can re-run.
 */
export async function runSetup(
  context: vscode.ExtensionContext,
  connector: TaskConnector,
  log: Log,
  refresh?: Refresh,
): Promise<boolean> {
  log("setup: started");

  const total = connector.setupSteps + 1; // + the repos root, which is ours not theirs
  if (!(await connector.configure(1, total))) {
    return abort(log, "cancelled at source configuration");
  }

  const reposRoot = await vscode.window.showInputBox({
    title: `Agent Flow Deck Setup (${total}/${total})`,
    prompt: "Directory where your repo checkouts live",
    ignoreFocusOut: true,
    value: "~/projects",
    validateInput: (v) => (v.trim() ? undefined : "Enter a directory path"),
  });
  if (reposRoot === undefined) return abort(log, "cancelled at repos root");

  // Persist config (global) before credentials. workspaceDir is derived from
  // reposRoot to keep the wizard short; it remains overridable. Per-task worktrees
  // live inside each repo (.claude/worktrees/<KEY>), so there's no root to configure.
  const cleanRoot = reposRoot.trim().replace(/\/+$/, "");
  await updateGlobal("reposRoot", cleanRoot);
  await updateGlobal("workspaceDir", cleanRoot);
  log(`setup: config saved (root ${cleanRoot})`);

  const label = connector.info().label;
  if (!(await connector.signIn())) {
    vscode.window.showWarningMessage(
      `Agent Flow Deck: settings saved, but ${label} sign-in was cancelled. Use "Sign in to ${label}" to finish.`,
    );
    return abort(log, "sign-in skipped (config saved)");
  }

  await context.globalState.update(SETUP_COMPLETE_KEY, true);
  log("setup: complete");
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
    await runSetup(context, connector, log, refresh);
  } else {
    log("setup: deferred by user");
    // Leave the flag unset so setup is offered again next activation.
  }
}
