import * as vscode from "vscode";
import { JiraAuth } from "./jira/auth";

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
 * Guided first-run setup. Collects the org-specific Jira + repo settings, writes
 * them to the user's global settings, then delegates credential collection to the
 * existing sign-in flow (which stores to SecretStorage).
 *
 * Returns true only if setup ran to completion (config saved AND signed in).
 * Cancelling any step aborts without marking setup complete, so it can re-run.
 */
export async function runSetup(
  context: vscode.ExtensionContext,
  auth: JiraAuth,
  log: Log,
  refresh?: Refresh,
): Promise<boolean> {
  log("setup: started");

  const baseUrl = await vscode.window.showInputBox({
    title: "Agent Flow Setup (1/4)",
    prompt: "Your Atlassian Jira Cloud site URL",
    ignoreFocusOut: true,
    placeHolder: "https://your-org.atlassian.net",
    validateInput: (v) => {
      const t = v.trim();
      if (!t) return "Enter your Jira site URL";
      try {
        return new URL(t).protocol === "https:" ? undefined : "URL must start with https://";
      } catch {
        return "Enter a valid URL (e.g. https://your-org.atlassian.net)";
      }
    },
  });
  if (baseUrl === undefined) return abort(log, "cancelled at site URL");

  const project = await vscode.window.showInputBox({
    title: "Agent Flow Setup (2/4)",
    prompt: "Jira project key to pull tasks from",
    ignoreFocusOut: true,
    placeHolder: "ABC",
    validateInput: (v) => (v.trim() ? undefined : "Enter a project key"),
  });
  if (project === undefined) return abort(log, "cancelled at project key");

  const reposRoot = await vscode.window.showInputBox({
    title: "Agent Flow Setup (3/4)",
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
  await updateGlobal("jira.baseUrl", baseUrl.trim().replace(/\/+$/, ""));
  await updateGlobal("jira.project", project.trim().toUpperCase());
  await updateGlobal("reposRoot", cleanRoot);
  await updateGlobal("workspaceDir", cleanRoot);
  log(`setup: config saved (project ${project.trim().toUpperCase()}, root ${cleanRoot})`);

  // Step 4/4: credentials, via the existing two-step sign-in.
  if (!(await auth.signIn())) {
    vscode.window.showWarningMessage(
      'Agent Flow: settings saved, but Jira sign-in was cancelled. Use "Agent Flow: Sign in to Jira" to finish.',
    );
    return abort(log, "sign-in skipped (config saved)");
  }

  await context.globalState.update(SETUP_COMPLETE_KEY, true);
  log("setup: complete");
  vscode.window.showInformationMessage("Agent Flow is set up. Loading your tasks…");
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
  auth: JiraAuth,
  log: Log,
  refresh?: Refresh,
): Promise<void> {
  if (context.globalState.get<boolean>(SETUP_COMPLETE_KEY)) return;

  const c = vscode.workspace.getConfiguration("agentFlow");
  const configured =
    !!(c.get<string>("jira.baseUrl") || "").trim() && !!(c.get<string>("jira.project") || "").trim();
  if (configured) {
    // Already set up outside the wizard — remember and stay quiet.
    await context.globalState.update(SETUP_COMPLETE_KEY, true);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    "Welcome to Agent Flow — let's connect it to your Jira.",
    "Set up",
    "Later",
  );
  if (choice === "Set up") {
    await runSetup(context, auth, log, refresh);
  } else {
    log("setup: deferred by user");
    // Leave the flag unset so setup is offered again next activation.
  }
}
