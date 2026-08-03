import * as vscode from "vscode";

export const NOTICE_KEY = "agentFlow.telemetry.noticeShown";
export const TELEMETRY_DOCS_URL = "https://github.com/oznasi1/agent-flow/blob/main/docs/TELEMETRY.md";

const DETAILS = "What's collected";
const TURN_OFF = "Turn off";

/** Disclose telemetry once, non-modally. Deferred while first-run setup is on
 * screen so it never competes with the wizard for attention — and not marked as
 * shown in that case, so it still appears on a later activation. Never throws. */
export async function maybeShowTelemetryNotice(
  context: vscode.ExtensionContext,
  opts: { setupRunning: boolean },
): Promise<void> {
  try {
    if (opts.setupRunning) return;
    if (context.globalState.get<boolean>(NOTICE_KEY)) return;
    await context.globalState.update(NOTICE_KEY, true);

    const choice = await vscode.window.showInformationMessage(
      "Agent Flow Deck sends anonymous usage and error events to help decide what to build next. No repo names, ticket keys, file paths or prompt text.",
      DETAILS,
      TURN_OFF,
    );
    if (choice === DETAILS) {
      await vscode.env.openExternal(vscode.Uri.parse(TELEMETRY_DOCS_URL));
    } else if (choice === TURN_OFF) {
      await vscode.workspace
        .getConfiguration("agentFlow")
        .update("telemetry.enabled", false, vscode.ConfigurationTarget.Global);
    }
  } catch {
    // A disclosure that fails to render must never break activation.
  }
}
