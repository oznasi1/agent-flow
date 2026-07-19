import * as vscode from "vscode";
import { ApiTokenAuth } from "./jira/auth";
import { TasksViewProvider } from "./tasksView";
import { DeckPanel } from "./deckView";
import { maybeSeedAgent, watchPlansAndSeed } from "./engine/workspace";
import { getConfig } from "./config";
import { maybeRunSetup, runSetup } from "./setup";

export function activate(context: vscode.ExtensionContext): void {
  const auth = new ApiTokenAuth(context.secrets);
  const output = vscode.window.createOutputChannel("Agent Flow");
  const log = (m: string) => output.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
  const provider = new TasksViewProvider(context, auth, log);
  log("Agent Flow activated");

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(TasksViewProvider.viewType, provider),

    vscode.commands.registerCommand("agentFlow.refresh", () => provider.refresh()),

    vscode.commands.registerCommand("agentFlow.signIn", async () => {
      const ok = await auth.signIn();
      if (ok) {
        vscode.window.showInformationMessage("Agent Flow: signed in to Jira.");
        await provider.refresh();
      }
      return ok;
    }),

    vscode.commands.registerCommand("agentFlow.signOut", async () => {
      await auth.signOut();
      vscode.window.showInformationMessage("Agent Flow: signed out of Jira.");
    }),

    vscode.commands.registerCommand("agentFlow.takeTask", async () => {
      const exampleKey = `${getConfig().project || "ABC"}-1234`;
      const key = await vscode.window.showInputBox({
        title: "Take a Jira task",
        prompt: `Ticket key (e.g. ${exampleKey})`,
        ignoreFocusOut: true,
      });
      if (key) await provider.takeTask(key.trim().toUpperCase());
    }),

    vscode.commands.registerCommand("agentFlow.openDeck", () => DeckPanel.show(context, auth, log)),

    vscode.commands.registerCommand("agentFlow.setup", () =>
      runSetup(context, auth, log, () => provider.refresh()),
    ),
  );

  // First-run: offer guided setup if the extension has never been configured.
  void maybeRunSetup(context, auth, log, () => provider.refresh());

  // If this window was opened by a recent "take", pre-seed its Claude Code agent…
  void maybeSeedAgent(context, log);
  // …and keep watching so an already-open window seeds when a task is taken later.
  context.subscriptions.push(watchPlansAndSeed(context, log));
}

export function deactivate(): void {
  // nothing to clean up
}
