import * as vscode from "vscode";
import { ApiTokenAuth } from "./jira/auth";
import { TasksViewProvider } from "./tasksView";
import { DeckPanel } from "./deckView";
import { MarketplacePanel } from "./marketplaceView";
import { maybeSeedAgent, watchPlansAndSeed } from "./engine/workspace";
import { windowIdentity, writePresence, removePresence, defaultWindowsDir } from "./engine/presence";
import { getConfig } from "./config";
import { maybeRunSetup, runSetup } from "./setup";
import { showDoctor, defaultDeps } from "./doctorView";
import { disposeTelemetry, initTelemetry, track } from "./telemetry/telemetry";
import { settingsSnapshot } from "./telemetry/settingsSnapshot";
import { maybeShowTelemetryNotice } from "./telemetry/notice";
import { CommandId } from "./telemetry/events";

const INSTALLED_KEY = "agentFlow.telemetry.installReported";

/** Register a command and report its use. The id suffix after "agentFlow." is the
 * CommandId enum member, so a new command is a compile error until it is added to
 * the catalog — which is the point. */
function registerTracked<T>(
  id: `agentFlow.${CommandId}`,
  handler: (...args: any[]) => T,
): vscode.Disposable {
  const command = id.slice("agentFlow.".length) as CommandId;
  return vscode.commands.registerCommand(id, (...args: any[]) => {
    // track() already swallows its own failures, but that guard lives inside a
    // module this file doesn't control — a local try/catch here means a future
    // regression in track() can only ever drop an event, never break the command
    // itself. Silently swallowed: there is no logger threaded into this helper,
    // and track()'s own catch already reports the common failure paths.
    try {
      track({ name: "command_invoked", command });
    } catch {
      // See comment above.
    }
    return handler(...args);
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const auth = new ApiTokenAuth(context.secrets);
  const output = vscode.window.createOutputChannel("Agent Flow");
  const log = (m: string) => output.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
  const provider = new TasksViewProvider(context, auth, log);
  log("Agent Flow activated");

  // Telemetry must come up before the commands below so `command_invoked` can
  // use it. A throw here must NEVER escape activate() — see the comment on the
  // best-effort block further down for why: an uncaught throw disposes every
  // registration that follows it.
  try {
    initTelemetry(context, log);
  } catch (e) {
    log(`telemetry: init failed (extension still active): ${e instanceof Error ? e.message : String(e)}`);
  }

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(TasksViewProvider.viewType, provider),

    registerTracked("agentFlow.refresh", () => provider.refresh()),

    registerTracked("agentFlow.signIn", async () => {
      const ok = await auth.signIn();
      if (ok) {
        vscode.window.showInformationMessage("Agent Flow: signed in to Jira.");
        await provider.refresh();
      }
      return ok;
    }),

    registerTracked("agentFlow.signOut", async () => {
      await auth.signOut();
      vscode.window.showInformationMessage("Agent Flow: signed out of Jira.");
    }),

    registerTracked("agentFlow.takeTask", async () => {
      const exampleKey = `${getConfig().project || "ABC"}-1234`;
      const key = await vscode.window.showInputBox({
        title: "Take a Jira task",
        prompt: `Ticket key (e.g. ${exampleKey})`,
        ignoreFocusOut: true,
      });
      // Palette entry point — the only caller that knows this Take is a command.
      if (key) await provider.takeTask(key.trim().toUpperCase(), "command");
    }),

    registerTracked("agentFlow.openDeck", () => DeckPanel.show(context, auth, log)),

    registerTracked("agentFlow.openMarketplace", () => MarketplacePanel.show(context, log)),

    registerTracked("agentFlow.setup", () =>
      runSetup(context, auth, log, () => provider.refresh()),
    ),

    registerTracked("agentFlow.doctor", () => showDoctor(defaultDeps(auth, log))),
  );

  // Best-effort niceties, all of them optional. A failure here must NEVER propagate out
  // of activate() — an uncaught throw makes VS Code dispose every registration above
  // (commands + the view provider), which surfaces as "command not found" and a dead
  // Tasks panel. Guard them so the extension always comes up.
  try {
    // First-run: offer guided setup if the extension has never been configured.
    void maybeRunSetup(context, auth, log, () => provider.refresh());
    // If this window was opened by a recent "take", pre-seed its Claude Code agent…
    void maybeSeedAgent(context, log);
    // …and keep watching so an already-open window seeds when a task is taken later.
    context.subscriptions.push(watchPlansAndSeed(context, log));
    // Record this window's presence so a later "take" can open a task into it.
    if (getConfig().trackOpenWindows) {
      const stamp = () => {
        const id = windowIdentity();
        if (id) writePresence(defaultWindowsDir(), { ...id, pid: process.pid, updatedAt: Date.now() });
      };
      stamp();
      context.subscriptions.push(vscode.window.onDidChangeWindowState(stamp));
    }

    // Lifecycle analytics. `isFirstEver` is the install signal: globalState is empty
    // on a fresh install and survives updates, so this fires exactly once per machine.
    const isFirstEver = !context.globalState.get<boolean>(INSTALLED_KEY);
    if (isFirstEver) {
      // Guard the update's own rejection too (Thenable, not a real Promise, so no
      // .catch()) — a storage write failure here must not become an unhandled
      // rejection any more than a telemetry failure may break activation.
      void context.globalState.update(INSTALLED_KEY, true).then(undefined, () => undefined);
      track({ name: "extension_installed" });
    }
    // Fires after activate() has already returned — logUsage/getConfig/settingsSnapshot
    // failures here can no longer be caught by the try above, so guard them locally.
    // The rejection branch keeps a rejected isAuthenticated() from becoming an
    // unhandled promise rejection.
    void auth.isAuthenticated().then(
      (authed) => {
        try {
          const cfg = getConfig();
          track({
            name: "extension_activated",
            is_first_ever: isFirstEver,
            has_jira_auth: authed,
            is_configured: !!cfg.baseUrl && !!cfg.project,
            ...settingsSnapshot(cfg),
          });
        } catch (e) {
          log(`telemetry: extension_activated failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      () => undefined,
    );
    void maybeShowTelemetryNotice(context, { setupRunning: isFirstEver });
  } catch (e) {
    log(`activation: optional step failed (extension still active): ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function deactivate(): void {
  // Each teardown step is isolated so neither can prevent the other from running.
  // removePresence never throws by its own contract and disposeTelemetry never
  // throws by its own contract (see telemetry.ts) — the try/catches here are a
  // second line of defense against a regression in either, not a substitute for
  // those contracts.
  try {
    // Best-effort: drop this window's presence record.
    removePresence(defaultWindowsDir(), process.pid);
  } catch {
    // No output channel handle survives past activate() to log to; nothing else
    // to do at shutdown besides still attempting the flush below.
  }
  try {
    // Best-effort flush. deactivate() is synchronous and will not await the POST,
    // so tail events at window close are sometimes lost — by design, which is why
    // retention rides on extension_activated rather than a session_ended event.
    disposeTelemetry();
  } catch {
    // See comment above.
  }
}
