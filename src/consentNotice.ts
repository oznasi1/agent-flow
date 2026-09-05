// The one-time notice behind the `agentFlow.commandConsent` default flip.
//
// Per-command consent (`consent.ts`) shipped inert with `"flow"` as the default,
// which protected every existing workflow through that upgrade. 0.69 makes
// `"command"` the default — and a user who had approved a workflow's commands
// under `"flow"` will find it asking again, once per distinct command text,
// because the per-flow stamp is not consulted in the new mode. That is the
// intended behaviour, but it must not be a silent surprise: this tells them
// once, says exactly what changes, and puts the old mode one click away.
//
// Same posture as `modesNotice.ts` and `telemetry/notice.ts`: never shown while
// first-run setup is on screen (a fresh install has nothing to be told about),
// never shown twice, never allowed to break activation.
import * as vscode from "vscode";

export const CONSENT_NOTICE_KEY = "agentFlow.commandConsent.defaultNoticeShown";
export const CONSENT_DOCS_URL =
  "https://github.com/oznasi1/agent-flow/blob/main/docs/ORCHESTRATOR_COMMANDS.md#consent-per-command";

export const KEEP = "Keep per-command";
export const PER_WORKFLOW = "Ask once per workflow";
export const DETAILS = "What changed";

interface Inspected<T> {
  key?: string;
  workspaceFolderValue?: T;
  workspaceValue?: T;
  globalValue?: T;
}

/** Has the user set `commandConsent` themselves, at any scope? A user with an
 * explicit value already made this decision — whichever way — and a notice
 * about the default would be telling them about a thing that does not apply to
 * them. */
export function hasExplicitConsentSetting(i: Inspected<unknown> | undefined): boolean {
  return !!i && (i.workspaceFolderValue !== undefined || i.workspaceValue !== undefined || i.globalValue !== undefined);
}

/** Should the notice show for this configuration? Only when the orchestrator is
 * on — the setting means nothing to anyone else — and only when the user has
 * not already chosen a mode. Pure over the two reads so the decision is
 * testable without a memento. */
export function consentNoticeApplies(
  orchestratorOn: unknown,
  inspected: Inspected<unknown> | undefined,
): boolean {
  return orchestratorOn === true && !hasExplicitConsentSetting(inspected);
}

export async function maybeShowConsentNotice(
  context: vscode.ExtensionContext,
  opts: { setupRunning: boolean },
): Promise<void> {
  try {
    if (opts.setupRunning) return;
    if (context.globalState.get<boolean>(CONSENT_NOTICE_KEY)) return;
    const c = vscode.workspace.getConfiguration("agentFlow");
    // Not marked shown when it does not apply: a user who turns the orchestrator
    // on next month should still be told what its consent default is.
    if (!consentNoticeApplies(c.get<unknown>("orchestrator"), c.inspect<unknown>("commandConsent"))) return;
    await context.globalState.update(CONSENT_NOTICE_KEY, true);

    const choice = await vscode.window.showInformationMessage(
      "Agent Flow Deck workflows now ask before each distinct shell command, not once per workflow. " +
        "A workflow whose commands you already approved asks again — once per command text, with " +
        "Run once, Run the next 5, or Always. The previous behaviour is one click away.",
      KEEP,
      PER_WORKFLOW,
      DETAILS,
    );
    if (choice === PER_WORKFLOW) {
      await c.update("commandConsent", "flow", vscode.ConfigurationTarget.Global);
    } else if (choice === DETAILS) {
      await vscode.env.openExternal(vscode.Uri.parse(CONSENT_DOCS_URL));
    }
    // `KEEP` and dismissal both leave the default in place, which is the point.
  } catch {
    // A notice that fails to render must never break activation.
  }
}
