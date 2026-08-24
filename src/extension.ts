import * as vscode from "vscode";
import { resolveConnector } from "./tasks/registry";
import { TasksViewProvider } from "./tasksView";
import { DeckPanel, POLL_MS as DECK_POLL_MS } from "./deckView";
import { MarketplacePanel } from "./marketplaceView";
import { runAttentionPass } from "./attentionJob";
import { gatherAttention, defaultAttentionDeps } from "./engine/attentionFs";
import { defaultAttentionFile } from "./engine/attentionStore";
import { maybeSeedAgent, watchPlansAndSeed } from "./engine/workspace";
import { BASE_SCHEME, TaskBaseContentProvider } from "./engine/diffView";
import { windowIdentity, writePresence, removePresence, defaultWindowsDir } from "./engine/presence";
import { getConfig, isVSCodeHost } from "./config";
import { maybeRunSetup, runSetup } from "./setup";
import { showDoctor, defaultDeps } from "./doctorView";
import { disposeTelemetry, initTelemetry, track } from "./telemetry/telemetry";
import { settingsSnapshot } from "./telemetry/settingsSnapshot";
import { maybeShowTelemetryNotice } from "./telemetry/notice";
import { maybeShowModesNotice } from "./modesNotice";
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
  // Created before resolveConnector: the registry's unknown-id fallback logs
  // through it.
  const output = vscode.window.createOutputChannel("Agent Flow Deck");
  const log = (m: string) => output.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
  // Every consumer — the task panel, the Deck, Doctor, setup, and the sign-in
  // commands — reads its source through this one connector now; there is no
  // separate `auth` object left to diverge from it.
  const connector = resolveConnector(context, log);
  const provider = new TasksViewProvider(context, connector, log);
  log("Agent Flow Deck activated");

  // Published for `when` clauses in package.json. Nothing references it right now:
  // agentFlow.agentProvider's `when: agentFlow.host.vscode` gate was dropped when
  // Cursor and `ask` became real choices, since readAgentProviderSetting enforces the
  // host rules at seed time anyway. Kept published rather than deleted because
  // test/unit/extension.test.ts pins this call and its failure handling, and that file
  // is out of scope for the task that dropped the gate — see the task-4 report.
  // Guarded on both a synchronous throw AND an async
  // rejection: executeCommand returns a Thenable in the real host, so a rejection
  // would otherwise escape as an unhandled rejection rather than being logged. A
  // failure here must never escape activate(), because an uncaught throw disposes
  // every registration that follows it. One formatter shared by both arms so there
  // is a single Error-vs-not branch to cover, not two.
  const logSetContextFailure = (e: unknown) =>
    log(`could not set the host context key: ${e instanceof Error ? e.message : String(e)}`);
  try {
    void vscode.commands
      .executeCommand("setContext", "agentFlow.host.vscode", isVSCodeHost())
      .then(undefined, logSetContextFailure);
  } catch (e) {
    logSetContextFailure(e);
  }

  // Telemetry must come up before the commands below so `command_invoked` can
  // use it. A throw here must NEVER escape activate() — see the comment on the
  // best-effort block further down for why: an uncaught throw disposes every
  // registration that follows it.
  try {
    initTelemetry(context, log);
  } catch (e) {
    log(`telemetry: init failed (extension still active): ${e instanceof Error ? e.message : String(e)}`);
  }

  // Notepad image files nothing points at any more — a crash between an unlink and
  // the state write that follows it, or a note deleted by an older version. Once per
  // activate is enough; it is deliberately not on the poll, which could race a
  // half-written state file. Its own try/catch for the reason above: an uncaught
  // throw here would dispose every registration below.
  try {
    provider.sweepNotepadImages();
  } catch (e) {
    log(`notepad: image sweep failed (extension still active): ${e instanceof Error ? e.message : String(e)}`);
  }

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, new TaskBaseContentProvider()),
    output,
    vscode.window.registerWebviewViewProvider(TasksViewProvider.viewType, provider),

    registerTracked("agentFlow.refresh", () => provider.refresh()),

    registerTracked("agentFlow.signIn", async () => {
      const ok = await connector.signIn();
      if (ok) {
        vscode.window.showInformationMessage(`Agent Flow Deck: signed in to ${connector.info().label}.`);
        await provider.refresh();
      }
      return ok;
    }),

    registerTracked("agentFlow.signOut", async () => {
      await connector.signOut();
      vscode.window.showInformationMessage(`Agent Flow Deck: signed out of ${connector.info().label}.`);
    }),

    registerTracked("agentFlow.takeTask", async () => {
      const info = connector.info();
      const key = await vscode.window.showInputBox({
        title: `Take a ${info.label} task`,
        prompt: `Ticket key (e.g. ${info.exampleKey})`,
        ignoreFocusOut: true,
      });
      // Palette entry point — the only caller that knows this Take is a command.
      if (key) await provider.takeTask(key.trim().toUpperCase(), "command");
    }),

    registerTracked("agentFlow.openDeck", () => DeckPanel.show(context, connector, log)),

    registerTracked("agentFlow.openMarketplace", () => MarketplacePanel.show(context, log)),

    registerTracked("agentFlow.setup", () =>
      runSetup(context, connector, log, () => provider.refresh()),
    ),

    registerTracked("agentFlow.doctor", () => showDoctor(defaultDeps(connector, log))),
  );

  // The notepad badge and the attention badge share one timer, deliberately: both
  // must outlive every panel, and a second interval doing the same directory reads
  // would be pure duplication.
  //
  // Attention runs every OTHER tick. Transcript reads are its recurring cost, and
  // nobody needs sub-10-second latency on an activity-bar badge.
  let ticks = 0;
  const poll = setInterval(() => {
    provider.postNotepad();
    if (++ticks % 2 === 0) attentionPass(provider, log);
  }, 6000);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });

  // Best-effort niceties, all of them optional. A failure here must NEVER propagate out
  // of activate() — an uncaught throw makes VS Code dispose every registration above
  // (commands + the view provider), which surfaces as "command not found" and a dead
  // Tasks panel. Guard them so the extension always comes up.
  try {
    // First-run: offer guided setup if the extension has never been configured.
    void maybeRunSetup(context, connector, log, () => provider.refresh());
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
      // `roots` now decides which repos' diff, dirty state and PRs render on this
      // window's card — stale the moment a folder is added or removed from an
      // open multi-root workspace, since that alone does not reload the
      // extension host and restamp on its own. onDidChangeWindowState only fires
      // on focus change, which could be a long wait after an edit like this.
      context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(stamp));
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
    void connector.isAuthenticated().then(
      (authed) => {
        try {
          const cfg = getConfig();
          track({
            name: "extension_activated",
            is_first_ever: isFirstEver,
            has_jira_auth: authed,
            is_configured: connector.isConfigured(),
            ...settingsSnapshot(cfg),
          });
        } catch (e) {
          log(`telemetry: extension_activated failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      () => undefined,
    );
    void maybeShowTelemetryNotice(context, { setupRunning: isFirstEver });
    void maybeShowModesNotice(context, { setupRunning: isFirstEver });
  } catch (e) {
    log(`activation: optional step failed (extension still active): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Build one attention pass's inputs and run it.
 *
 * Prefers the open Deck's own candidates when a panel built some within two of its
 * poll intervals: same reduction, so the badge cannot contradict the column beside
 * it, and while the Deck is open the pass costs no I/O at all. Falls back to its
 * own cheap gather — transcripts always, git and the PR cache only for a run
 * already waiting, and never a forge call.
 *
 * Exported (not module-local) so extension.test.ts can call it directly: the
 * interval callback above is never driven by that file's real timers, and an
 * unexported function's body would otherwise be unreachable from any test. */
export function attentionPass(provider: TasksViewProvider, log: (m: string) => void): void {
  const cfg = getConfig();
  const now = Date.now();
  const fresh = DeckPanel.latestCandidates();
  const usable = fresh && now - fresh.at < 2 * DECK_POLL_MS ? fresh.candidates : null;
  runAttentionPass({
    candidates: () => usable ?? gatherAttention(defaultAttentionDeps({
      nowMs: now, showAll: cfg.inflightShowAll, openAgents: cfg.openAgents, prFacts: cfg.prFacts,
    })),
    setAttention: (keys) => provider.setAttention(keys),
    notify: cfg.notifyOnActionRequired,
    focused: vscode.window.state.focused,
    latchFile: defaultAttentionFile(),
    nowMs: now,
    log,
  });
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
