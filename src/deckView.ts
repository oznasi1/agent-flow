import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getConfig, providerLabel, type AgentProvider } from "./config";
import { TaskAuthError, TaskConnector } from "./tasks/provider";
import { readRuns, defaultRunsDir, removeRun, writeRun } from "./engine/runs";
import { Flow, FlowAction, FlowEdge, LaunchDest, PlaceNode, PlannedNode, emptyFlow, findNode, isPlace, isPlanned, isSettled, isSpendAction } from "./engine/orchestrator/model";
import { defaultFlowsDir, readFlows, writeFlow, removeFlow } from "./engine/orchestrator/store";
import { nodeFlowIo, nodeLockIo, newFlowId } from "./engine/orchestrator/flowIo";
import { LOCK_TTL_MS, acquire, release } from "./engine/orchestrator/lock";
import { evaluateFlow } from "./engine/orchestrator/evaluate";
import { unfirableRules } from "./engine/orchestrator/armability";
import { ActOutcome, applyFired, notifyLines } from "./engine/orchestrator/runner";
import { promoteToPlace } from "./engine/orchestrator/promote";
import { LaunchTicketDetail, launchPlanned } from "./engine/orchestrator/launch";
import { buildRunStatus } from "./engine/status";
import { readLiveWindows, defaultWindowsDir } from "./engine/presence";
import { agentPrompt, openInEditor, openWorkspace, writePlanFile, BRIEF_DIR } from "./engine/workspace";
import { createWorktrees } from "./engine/worktree";
import { currentBranch, gitState, prEligible, repoRoot, taskDiff } from "./engine/git";
import { openTaskDiff } from "./engine/diffView";
import { RetireVerdict, retireVerdict } from "./engine/retire";
import { defaultPrFactsDir, isStale, readPrEntries, removePrEntries, writePrEntry } from "./engine/pr/store";
import { FetchResult, GhGap, GhProvider, PrProvider, probeGh } from "./engine/pr/provider";
import { RefreshQueue } from "./engine/pr/queue";
import { discoverRepos } from "./engine/repos";
import { composeAgentPrompt, hasNote, prReviewTemplate } from "./engine/prompt";
import { launchReview, resolveReviewMode, reviewRunKey } from "./engine/review/launch";
import { GhReviewProvider, ReviewProvider } from "./engine/review/provider";
import { ReviewCache, defaultReviewsFile, isReviewCacheStale, readReviewCache, writeReviewCache } from "./engine/review/store";
import { sortRequests } from "./engine/review/sort";
import { inferTicket, localRunFor } from "./engine/localRuns";
import { defaultSessionsDir, groupByPlace, readOpenSessions } from "./engine/sessions";
import { readSessionActivity } from "./engine/transcript";
import { canon } from "./engine/paths";
import { CardAgent, FlowPromptMode, InboundMessage, OpenSession, OutboundMessage, PendingResume, PrEntry, PrEntryMap, PromptMode, RepoGit, ReviewRequest, ReviewSort, ReviewVerb, Run, RunStatus, isTicketRun, runKind, ticketKeyFor } from "./types";

export const POLL_MS = 6000;
const TICKET_TTL_MS = 30_000;

/** The footer note per reason PR facts are off. Naming the actual gap matters:
 * `gh` living somewhere the extension host's PATH cannot see it is by far the
 * likeliest cause, and reads to a signed-in user as the Deck being broken. */
const GH_NOTES: Record<GhGap["kind"], string> = {
  missing: "gh CLI not found — PR facts off. Run Doctor",
  "signed-out": "gh is not signed in — PR facts off. Run Doctor",
};

/** Appended to a review body the agent drafted, when provenance stamping is on.
 * Posting an agent's words as unmarked human review is the kind of thing worth
 * being straight about with teammates — which means naming the agent that actually
 * drafted it. */
export const reviewProvenance = (p: AgentProvider): string =>
  `_Drafted with ${providerLabel(p)} via Agent Flow Deck._`;

const VERB_LABEL: Record<ReviewVerb, string> = {
  approve: "Approve",
  comment: "Comment",
  "request-changes": "Request changes",
};

/** The next unused `n<N>` node id, scanning past whatever is already taken rather
 * than trusting the live count — the same scheme (and the same reasoning)
 * OrchestratorDrawer.tsx's own `nextNodeId` uses for a node the webview mints
 * itself. Kept as a second, host-side copy rather than an import: that file is
 * a webview entry point, built into its own bundle, and importing it here would
 * drag its React/JSX toolchain into the extension host for one four-line
 * function. */
function nextPlannedNodeId(flow: Flow): string {
  const taken = new Set(flow.nodes.map((n) => n.id));
  let i = 1;
  while (taken.has(`n${i}`)) i++;
  return `n${i}`;
}

/** What a performing edge (`launch` or `seed`) is about to spend money on, resolved
 * just far enough for the once-per-flow confirmation to name it. A `launch` has a
 * ticket and a set of repos; a `seed` has no ticket at all — only the place it opens
 * another agent in and the prompt mode it uses. `note` rides along from the edge on
 * both: it is what the agent will actually be told, so it belongs in the same
 * consent gate as the ticket/repos/mode. */
type SpendTarget =
  | { action: "launch"; node: PlannedNode; note?: string }
  | { action: "seed"; node: PlaceNode; mode?: string; note?: string };

/** How much of a rule's note the once-per-flow confirmation shows. The modal is
 * naming what the agent will be told, not reproducing it in full — a pasted
 * paragraph must not grow the dialog unboundedly. */
const NOTE_PREVIEW_MAX = 160;

function notePreview(note: string): string {
  return note.length > NOTE_PREVIEW_MAX ? note.slice(0, NOTE_PREVIEW_MAX) + "…" : note;
}

/** One acting edge, decided. `promote` turns a launched planned node into the place
 * the rest of the chain observes; `receipt` is the toast (an error receipt also
 * escalates to a notification — see the acting loop), which exists only when there
 * is something honest to say. */
interface EdgeDone {
  kind: "done";
  outcome: ActOutcome;
  promote?: { nodeId: string; runKey: string; repo: string };
  receipt?: { level: "success" | "error"; message: string };
}

/** What acting on one edge can answer: it happened (or deterministically cannot), or
 * nothing was decided and the next pass should try again. */
type EdgeResult = EdgeDone | { kind: "defer"; reason: string };

/** The Deck: a full-window board of every task launched via Agent Flow Deck, opened as a
 * singleton editor-area panel. Reuses the Jira client, runs store, and status engine. */
export class DeckPanel {
  private static current: DeckPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly ticketCache = new Map<string, { at: number; status: string | null; category: string | null }>();
  /** The last refresh's synthetic runs for places no tracked run claimed — cleared
   * and repopulated on every rebuild. A local card has no record on disk, so this
   * is the only place `run(key)` can resolve one for Open and Diff. */
  private readonly localRuns = new Map<string, Run>();
  private prFacts: boolean; // seeded from config in the constructor; re-seeded only by onConfigChanged
  private openAgents: boolean; // seeded from config in the constructor; re-seeded only by onConfigChanged
  private reviewQueue: boolean; // seeded from config in the constructor; re-seeded only by onConfigChanged
  private readonly prQueue = new RefreshQueue();
  private readonly pr: PrProvider = new GhProvider();
  private readonly reviewProvider: ReviewProvider = new GhReviewProvider();
  private reviewSort: ReviewSort = "oldest";
  /** Last successful search. Held in memory as well as on disk so a failed fetch
   * can keep rendering it with a stale marker instead of emptying the strip. */
  private reviewCache: ReviewCache | null = null;
  private reviewStale = false;
  /** When the last search attempt was *made*, success or failure — distinct from
   * `reviewCache.fetchedAt`, which is when one last *succeeded*. A failed search
   * deliberately leaves `fetchedAt` alone (the strip's staleness display depends
   * on it), which on its own would make `isReviewCacheStale` re-arm every poll
   * tick forever once `gh` starts failing. This is in-memory only, on purpose: a
   * failed attempt should not survive a window reload and force one more wait. */
  private reviewLastAttemptAt: number | null = null;
  /** Ids with a `submitReview` in flight. `onMessage` dispatches fire-and-forget,
   * and the row is only evicted from `reviewCache` *after* a successful submit —
   * so without this, a second `deck:reviewSubmit` for the same id (a double
   * click; VS Code queues modals rather than dropping one) would clear every
   * gate during the up-to-10s `gh` call and could post the same review twice.
   * GitHub does not deduplicate reviews. */
  private readonly reviewSubmitsInFlight = new Set<string>();
  private ghProbe: Promise<GhGap | null> | null = null;
  /** undefined until the probe resolves; null means gh is usable, and a gap
   * disables PR facts with a footer note. */
  private ghGap: GhGap | null | undefined;
  /** Bumped when a run is forgotten, so a fetch still in flight for the old
   * incarnation cannot recreate the cache file we just deleted. */
  private readonly prEpoch = new Map<string, number>();
  /** How many run records `Clear stale` would take right now — the sweep's own
   * verdict with both time gates ignored. Recomputed on every `buildAll`. */
  private staleCount = 0;
  /** Bumped when a refresh starts, so an older pass that finishes after a newer one
   * began does not post. Its snapshot predates whatever the newer pass read: a poll
   * that listed the runs directory before `deck:forget` removed a file would
   * otherwise put the forgotten card straight back on the board. */
  private refreshSeq = 0;
  /** How many refreshes are in flight. Only the last one out clears the webview's
   * busy indicator — an inner `finally` must not stop the spinner while an
   * overlapping refresh is still working. */
  private busyDepth = 0;
  /** The flows store's directory — `defaultFlowsDir()` in production, the same
   * shape this file already uses for `defaultRunsDir()`. Resolved once, since
   * it never changes for the life of the panel. */
  private readonly flowsDir = defaultFlowsDir();
  private readonly flowIo = nodeFlowIo();
  /** The lock's IO. `this.log` is reached through an arrow rather than passed
   * directly so this initializer cannot depend on whether TypeScript assigns
   * constructor parameter properties before or after field initializers. */
  private readonly lockIo = nodeLockIo((m) => this.log(m));
  /** Is a flows pass running right now? One at a time per panel: a pass releases the
   * flows-directory lock BEFORE it ever asks a spend-confirmation modal (asking
   * performs nothing, so there is nothing left to hold the lock for), which means the
   * lock is genuinely free for the whole time the modal is up. Without this guard,
   * `refresh()` polling every six seconds while that modal sits for minutes would let
   * a second pass for this SAME panel acquire that free lock immediately and run a
   * full, independent evaluate-and-act pass — re-asking the same question, or acting
   * on a flow the first pass is still deciding about — not because any lock or token
   * was mishandled, but simply because nothing else says "I am still mid-pass." Not
   * persisted, and deliberately not a lock: it is about this panel's own re-entrancy,
   * which no file can express. */
  private advanceInFlight = false;
  /** Flow ids whose first post-start evaluation found rules already met, and which
   * are waiting for the user to approve or disarm. Per panel, deliberately not
   * persisted: the gate exists to protect the moment you come back, and asking on
   * every poll would defeat arming. */
  private readonly pendingResume = new Map<string, PendingResume>();
  /** Flow ids that have completed their first evaluation in this panel's life —
   * either because the user approved a hold, or because that first evaluation
   * found nothing ready to hold. Once set, a flow's own passes fire normally. */
  private readonly resumeCleared = new Set<string>();

  static show(context: vscode.ExtensionContext, connector: TaskConnector, log: (m: string) => void): void {
    if (DeckPanel.current) {
      DeckPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "agentFlow.deck",
      "Agent Flow Deck — In-flight",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] },
    );
    DeckPanel.current = new DeckPanel(panel, context, connector, log);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly connector: TaskConnector,
    private readonly log: (m: string) => void,
  ) {
    this.panel = panel;
    // Seed from the persisted setting once; a later refresh must not stomp
    // these by re-reading config on every tick — only onConfigChanged does that,
    // and only for the key that actually changed.
    this.prFacts = getConfig().prFacts;
    this.openAgents = getConfig().openAgents;
    this.reviewQueue = getConfig().reviewRequests;
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((m: InboundMessage) => this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => {
      const wasArmed = this.hasArmedFlow();
      this.dispose();
      if (!wasArmed) return;
      // Closing the panel does stop it advancing — the panel owns the poll and
      // there is no cancellable close to gate that on. The flow stays armed on
      // disk deliberately: the intent survives, and the resume gate (Task 4) is
      // what makes coming back safe.
      const reopen = "Reopen the Deck";
      void vscode.window
        .showWarningMessage(
          "A flow is armed, and closing the Deck stops it advancing.",
          reopen,
          "Leave it closed",
        )
        .then((answer) => {
          if (answer === reopen) void vscode.commands.executeCommand("agentFlow.openDeck");
        });
    }, null, this.disposables);
    this.panel.onDidChangeViewState(
      () => {
        // An armed flow that only advances while you are looking at the board is
        // not armed. Closing the panel does stop it — that is what the close
        // notice above is for.
        if (this.panel.visible || this.hasArmedFlow()) this.startPolling();
        else this.stopPolling();
      },
      null,
      this.disposables,
    );
    vscode.workspace.onDidChangeConfiguration(
      (e) => void this.onConfigChanged(e),
      null,
      this.disposables,
    );
    this.startPolling();
  }

  /** Is any flow armed right now? Read from the store rather than cached: arming
   * is a disk write, and this is asked only on a visibility change or a close.
   * No try/catch here: `readFlows` already degrades a corrupt or unreadable
   * file to "skip it" internally and never throws — every other call site in
   * this file (`postFlows`, `advanceArmedFlows`, the `flow:*` handlers) trusts
   * that the same way. */
  private hasArmedFlow(): boolean {
    if (!getConfig().orchestrator) return false;
    return readFlows(this.flowIo, this.flowsDir).some((f) => f.armed);
  }

  private post(msg: OutboundMessage): void {
    try {
      void this.panel.webview.postMessage(msg);
    } catch {
      // A disposed panel's `postMessage` throws synchronously — a normal race
      // (the user closed the Deck while an async post-write step, a queued
      // fetch, or anything else here was still in flight), not a bug worth
      // logging. Letting it escape used to strand whatever ran after this call
      // in the caller — e.g. submitReview's own cache eviction, which sits right
      // after the success toast this throw could come from.
    }
  }

  private toast(level: "success" | "error" | "info", message: string): void {
    this.post({ type: "toast", level, message });
  }

  /** Read the flows store and post it. Cheap — a handful of small JSON files —
   * so it rides the same refresh as everything else rather than owning a cache. */
  private postFlows(): void {
    const cfg = getConfig();
    const enabled = cfg.orchestrator;
    const flows: Flow[] = enabled ? readFlows(this.flowIo, this.flowsDir) : [];
    // Emptied alongside `flows` when the setting is off, for the same reason:
    // silence must not be mistaken for "not loaded yet", and a stale hold from
    // before the setting was switched off has nothing left to be approved.
    const pendingResume = enabled ? [...this.pendingResume.values()] : [];
    // Sent regardless of `enabled`: this is configuration, not flow data, and
    // the webview cannot read it itself — it has no fs access (see
    // OrchestratorDrawer's own doc comment on why the mode list arrives as a
    // prop instead of an import). Never the whole `PromptMode` — `prompt` can
    // be long and the inspector never displays it.
    const promptModes: FlowPromptMode[] = cfg.promptModes.map((m) => ({ id: m.id, label: m.label }));
    this.post({ type: "deck:flows", flows, enabled, pendingResume, promptModes });
  }

  /** Advance every armed flow against the statuses this pass already built.
   *
   * Deliberately here rather than on its own timer: the statuses are the expensive
   * part and they exist by now, so evaluation is free. Each flow is evaluated,
   * stamped and written independently — one flow that throws must not stop the
   * others, the same posture `readFlows` takes with a corrupt file.
   *
   * Holds the resume gate before any of that: a flow armed last week must not
   * spend anything the moment you reopen the Deck. The FIRST evaluation that
   * finds rules already met is reported on `deck:flows` as `pendingResume`
   * rather than acted on; `flow:resumeApprove` is what lets the next pass fire.
   * A flow whose first evaluation finds nothing ready is never gated at all —
   * that is what keeps a rule met later in the same session firing without
   * ceremony, per `resumeCleared`.
   *
   * The whole pass runs under the flows-directory lock, acquired before the read
   * and released in a `finally`. `defaultFlowsDir()` is the GLOBAL ~/.agentflow/flows
   * and a DeckPanel is per-extension-host, so without it two windows read the same
   * unfired edge and both act on it — measured in the previous phase as two
   * identical toasts, and with a real `launch` that is a second paid session. A
   * window that cannot take the lock does NOTHING — no evaluation, no write, no
   * toast — and tries again on its next poll six seconds later. */
  private async advanceArmedFlows(runs: RunStatus[], nowMs: number): Promise<void> {
    if (!getConfig().orchestrator) return;
    // One pass at a time on this panel. `refresh()` polls every six seconds and a pass
    // can now sit in a modal for minutes — but by then it has already released the
    // lock (see below), so the lock itself is free, not held, for the whole time the
    // modal is up. `advanceInFlight` is what actually stops a second pass for THIS
    // panel from acquiring that free lock and running a redundant evaluate-and-act
    // pass while the first is still waiting on an answer; it has nothing to do with
    // the lock's own token, which is why a lock-level fix could not cover this case.
    if (this.advanceInFlight) return;
    this.advanceInFlight = true;
    try {
      // A token per PASS, not per panel. `release` only removes a lock whose token
      // matches, and that check is worth nothing if every pass presents the same one.
      const token = `deck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      let asks: { flow: Flow; target: SpendTarget }[] = [];
      // Silent rather than logged: with two windows polling every six seconds one of
      // them skips almost every pass, and that is normal operation, not a fault. An
      // unexpected filesystem failure IS logged — by `nodeLockIo`, which is why the
      // panel hands it `this.log`.
      if (!acquire(this.lockIo, this.flowsDir, nowMs, LOCK_TTL_MS, token)) return;
      try {
        asks = await this.advanceUnderLock(runs, nowMs);
      } finally {
        release(this.lockIo, this.flowsDir, token);
      }
      // Asked with the lock RELEASED. A modal is answered on human time and the lock is
      // held on machine time: awaiting one inside the other stalls every other window
      // for as long as the question is up, and past the TTL the lock is reaped and
      // another pass acquires while this one is still inside the modal — which is the
      // read-then-write window the lock exists to close. Nothing needs reordering,
      // because a pass that asks performs nothing anyway.
      //
      // The write that records the answer is therefore unlocked, exactly like every
      // other user-driven flow write in this file (`flow:arm`, `flow:save`,
      // `flow:resetEdge`, `flow:resumeDisarm`): it re-reads immediately before writing,
      // and it touches only flow-level fields, never an edge stamp.
      for (const ask of asks) await this.askFirstSpend(ask.flow, ask.target);
    } finally {
      this.advanceInFlight = false;
    }
  }

  /** The body of a pass, with the lock held. Returns the flows that need the user's
   * consent before they can ever spend anything — the caller asks once the lock is
   * released. Split out so the lock's `try`/`finally` above stays readable, and so
   * "what happens under the lock" is one function with no modal in it. */
  private async advanceUnderLock(
    runs: RunStatus[],
    nowMs: number,
  ): Promise<{ flow: Flow; target: SpendTarget }[]> {
    const asks: { flow: Flow; target: SpendTarget }[] = [];
    for (const flow of readFlows(this.flowIo, this.flowsDir)) {
      if (!flow.armed) {
        // A disarmed flow holds no gate — re-arming starts the cycle over.
        this.pendingResume.delete(flow.id);
        this.resumeCleared.delete(flow.id);
        continue;
      }
      try {
        const result = evaluateFlow({ flow, statuses: runs, nowMs });
        if (result.fired.length === 0) {
          // Nothing ready means nothing to approve: clear the gate so a rule
          // that becomes met later in this session fires without ceremony.
          this.pendingResume.delete(flow.id);
          this.resumeCleared.add(flow.id);
          continue;
        }
        if (!this.resumeCleared.has(flow.id)) {
          // Held, not fired: report what is about to happen and wait.
          const lines = notifyLines(flow, result.fired);
          this.pendingResume.set(flow.id, {
            flowId: flow.id,
            flowName: flow.name,
            lines: lines.length > 0
              ? lines
              : result.fired.filter((f) => f.perform).map(() => `${flow.name}: a rule is ready.`),
          });
          continue;
        }
        // Re-read the store immediately before writing, and drop any fired edge
        // another window has already stamped. `defaultFlowsDir()` is the GLOBAL
        // ~/.agentflow/flows and a DeckPanel is per-extension-host, so two VS Code
        // windows with the Deck open evaluate the same file: both read the same
        // unfired edge, both fire it, and the second write overwrites the first's
        // `firedAt`. That was probe-proved — two identical toasts for one rule.
        //
        // The lock this pass holds is what actually prevents that now, and this
        // guard is kept rather than deleted because the lock's TTL is crash
        // recovery, not mutual exclusion for a holder that HANGS: a pass stuck in
        // `openWorkspace` for longer than the TTL has its lock reaped, and the pass
        // that then acquires must still not restamp an edge the stuck one claimed.
        // Cheap, and the failure it covers is a duplicate paid session.
        //
        // The write is based on `fresh`, not on the `flow` this pass evaluated:
        // writing the stale copy would erase the other window's stamp on the edge
        // we just decided not to claim, un-latching it so it fires all over again.
        const fresh = readFlows(this.flowIo, this.flowsDir).find((f) => f.id === flow.id);
        // Gone from the store between the two reads (another window deleted it).
        // Writing would resurrect a file the user removed. Stated explicitly rather
        // than left to `fresh?.edges ?? []` — that would land in the same place (no
        // fresh edges means nothing survives the filter below, so nothing is
        // written) but only by accident, and the plausible convenience spelling,
        // `fresh ?? flow`, silently recreates the deleted flow.
        if (!fresh) continue;
        const freshById = new Map(fresh.edges.map((e) => [e.id, e]));
        const unclaimed = result.fired
          .filter((f) => {
            const now = freshById.get(f.edge.id);
            return now !== undefined && !isSettled(now);
          })
          // Rebind `.edge` to the fresh copy, once, for everything unclaimed. From
          // here on, every RECORD-level detail of an edge — where it points, which
          // prompt mode, which note — must be about the edge as the store holds it
          // now, not as evaluation saw it a store-read ago: a user can edit an armed
          // flow (retarget an edge, change its mode) in the moments between this
          // pass's evaluation and its acting step. `perform` is untouched: that
          // verdict is evaluation's own, and redeciding it here would mean
          // re-evaluating. INVARIANT: after this line, nothing below ever reads
          // `f.edge` from a `FiredEdge` that predates this map — `firing`, `stamping`,
          // the dedup, the spend gate, the dispatch check and `performEdge` itself
          // all inherit the fresh edge from here. Do not reintroduce a raw
          // `result.fired` reference below this point.
          //
          // `f.action` is DELIBERATELY NOT rebound, and is the one thing here that
          // stays evaluation's vintage. An action is no longer a field a user can
          // edit: it is derived from the TARGET NODE's kind (`edgeAction`), and
          // `evaluateFlow` derived it once, for this pass, onto `FiredEdge.action`.
          // Everything downstream — this dedupe, the spend gate, the dispatch check,
          // `performEdge`, and `applyFired`/`notifyLines` in `runner.ts` — reads that
          // one carried value, so a single vintage decides WHICH VERB this pass is
          // performing and which verb it then stamps and announces. Re-deriving here
          // against `fresh` would create a second vintage and put this pass's own
          // dispatch back in disagreement with the stamp `applyFired` writes for it,
          // which is how a refused launch used to be stamped as a notify success.
          //
          // That is not a hole in the money guarantee, because the verb alone spends
          // nothing: `spendTarget` and `performEdge` resolve the TARGET out of
          // `fresh`, so a target whose kind changed under this pass — the only edit
          // that can change an action at all — resolves to nothing, and the rule is
          // refused with an `error` and no `firedAt`. Concretely: a `launch` decided
          // against a `planned` node the user has since turned into a notify
          // terminal cannot launch it, because there is no planned node left to
          // launch. The decision stands; what it would have spent on is gone.
          .map((f) => ({ ...f, edge: freshById.get(f.edge.id)! }));
        // Nothing left to stamp: the other window did all of it. No write, and no
        // toast — it already announced every one of these.
        if (unclaimed.length === 0) continue;

        // ONE action per TARGET NODE per pass. `evaluate.ts` only collapses an "all"
        // junction to a single performer; for any other target — including a planned
        // node with the DEFAULT `join: "any"` — it marks EVERY met edge as performing.
        // Two rules into one node is the ordinary way to wire "when it lands, start the
        // next ticket" (`pr-merged` and `ci-passed` are both true the moment a PR
        // merges), and acting per edge there opens two worktrees and pays for two
        // sessions on one ticket, then promotes the same node twice with the second
        // runKey orphaning the run the first launch created.
        //
        // The later edges DID fire, so they are stamped — demoted to `perform: false`,
        // exactly what an "all" junction's siblings get, which also keeps `notifyLines`
        // from announcing the same thing twice. Demoting rather than dropping matters:
        // an unstamped met edge is re-evaluated on every pass forever.
        //
        // This is also what makes the perform unit and the defer unit the same thing:
        // `deferredTargets` below is keyed by target, and with one acting edge per
        // target a deferred target can never also have a successful stamp to drop.
        const actedTargets = new Set<string>();
        const firing = unclaimed.map((f) => {
          if (!f.perform || !isSpendAction(f.action)) return f;
          if (actedTargets.has(f.edge.to)) return { ...f, perform: false };
          actedTargets.add(f.edge.to);
          return f;
        });

        // A flow asks ONCE before it ever spends anything, then runs unattended: a
        // mis-wired flow should cost one prompt, not a string of paid sessions. A
        // `seed` starts a paid Claude Code session exactly like a `launch` does, so
        // it gates the same way — the once-per-flow confirmation must see it, or a
        // flow whose only acting rule is a `seed` would spend money with no consent
        // at all. Only a launch or seed we would actually attempt counts — an edge
        // pointing at the wrong kind of node spends nothing and is stamped as an
        // error below, so gating on it would ask about a rule that can never run.
        const wantsSpend = firing
          .filter((f) => f.perform)
          .map((f) => this.spendTarget(fresh, f.edge, f.action))
          .find((t) => t !== undefined);
        if (wantsSpend !== undefined && fresh.launchConfirmedAt === undefined) {
          // Recorded, not asked — the caller asks once the lock is released. Whatever
          // the answer, THIS pass performs nothing: an approval only lets the next pass
          // act, which keeps the acting path identical whether or not a question was
          // ever asked.
          asks.push({ flow: fresh, target: wantsSpend });
          continue;
        }

        // Act first, then record what happened — and record every outcome from
        // this pass in ONE write, so a crash between deciding two edges' outcomes
        // cannot leave one of them looking unlaunched. That is what is guaranteed:
        // NOT that the act and the record are atomic with each other. If
        // `writeFlow` below throws after a launch (or a seed) truly ran, the spend
        // already happened but nothing was stamped, so the next pass sees the same
        // edge still unfired and launches it again. Known and accepted — see the
        // spec's Known limitations, alongside `openWorkspace`'s equally-unrecorded
        // `writeRun` failure.
        const outcomes = new Map<string, ActOutcome>();
        const promotions: { nodeId: string; runKey: string; repo: string }[] = [];
        const receipts: { level: "success" | "error"; message: string }[] = [];
        // The junction targets of rules that could not even be DECIDED this pass.
        const deferredTargets = new Set<string>();
        for (const f of firing) {
          // A stamped-only sibling performs nothing, and a notify's whole action is
          // the toast `notifyLines` produces below.
          if (!f.perform || !isSpendAction(f.action)) continue;
          // Re-read and check `armed` immediately before THIS edge, not once for the
          // whole flow: a launch or seed is its own `await`, and up to three of them
          // can run in one pass (the per-pass cap), each one long enough for
          // `flow:arm` — this window or another — to disarm the flow while an
          // earlier edge in this same loop is still in flight. Harmless for a toast;
          // a launch that goes ahead anyway is a second paid session the user just
          // said stop to. Left pending rather than stamped: a re-arm should get a
          // clean retry, not a permanently latched failure for a rule that never ran.
          const stillArmed = readFlows(this.flowIo, this.flowsDir).find((fl) => fl.id === flow.id)?.armed;
          if (!stillArmed) {
            this.log(`deck: flow ${flow.id} rule ${f.edge.id} skipped — disarmed mid-pass`);
            deferredTargets.add(f.edge.to);
            continue;
          }
          const done = await this.performEdge(fresh, f.edge, runs, f.action);
          if (done.kind === "defer") {
            // The log, and nothing else: a transient read failure on an unattended
            // flow is not worth a notification, but a rule quietly not advancing is
            // invisible without this.
            this.log(`deck: flow ${flow.id} rule ${f.edge.id} deferred — ${done.reason}`);
            deferredTargets.add(f.edge.to);
            continue;
          }
          outcomes.set(f.edge.id, done.outcome);
          if (done.promote) promotions.push(done.promote);
          if (done.receipt) receipts.push(done.receipt);
        }
        // A deferred rule is left exactly as it was, so the next pass retries it —
        // and so is every sibling of its junction, for the reason `evaluate.ts` gives
        // for firing NONE of a capped junction: stamping the siblings of an edge that
        // did not act settles them around a performer that is still pending, and if
        // its condition later stops holding the junction can never close.
        const stamping = firing.filter((f) => !deferredTargets.has(f.edge.to));
        // `promotions` and `receipts` need no filter of their own, and this is the
        // invariant that says why: both are built only from a `done` result, one acting
        // edge decides each target, and a target whose acting edge deferred contributes
        // neither. So nothing can be promoted or announced whose own edge was dropped
        // from `stamping` — which would otherwise leave the drawer showing a rule as
        // still waiting on a node that is already a place, and the next pass latching
        // that edge as "must point at planned work". If the one-per-target rule above
        // ever goes, this comment is wrong and a filter is needed.
        // Nothing was decided at all. Writing an unchanged flow would be a pointless
        // write, and there is nothing to announce.
        if (stamping.length === 0) continue;
        // Re-read ONE MORE TIME, immediately before this write, and build `next`
        // from THAT read, not from `fresh`. `fresh` was read before up to three
        // `performEdge` awaits — a Jira fetch plus `openWorkspace`, real seconds —
        // and in that window a `flow:arm` Disarm, a `flow:rename`, a `flow:resetEdge`
        // on some OTHER edge, a `flow:save` node drag, or the answer this same
        // flow's OWN first-spend ask just recorded (`launchConfirmedAt`) can land
        // on disk. Writing `next` built straight from `fresh` would silently
        // overwrite every one of those with the value this pass started with —
        // resurrecting `armed: true` over a Disarm the user just clicked, in
        // particular, which turns the per-edge `stillArmed` guard above into a
        // one-poll pause instead of a stop: the edges it left pending would
        // relaunch on the very next pass because the flow never actually looks
        // disarmed to that pass either.
        //
        // `applyFired`'s FLOW argument is this read (`atWrite`), not `fresh`: every
        // edge and every flow-level field this pass did NOT just decide about
        // passes through untouched from whatever is on disk right now. Only the
        // STAMPS — `firedAt`/`firedNote`/`error` on the edges named in `stamping` —
        // come from `outcomes`, which is deliberately about `fresh`'s copy of
        // those specific edges: the launch (or seed) actually ran against that
        // copy, and that is what must latch regardless of what else moved. Do not
        // "simplify" this back to `applyFired(fresh, …)` — that is exactly what
        // resurrects a concurrent Disarm, rename, Reset or node edit.
        const atWrite = readFlows(this.flowIo, this.flowsDir).find((f) => f.id === flow.id);
        // Gone from the store between `fresh` and here (deleted mid-pass). Writing
        // would resurrect it, the same reasoning as the `!fresh` check above.
        if (!atWrite) continue;
        let next = applyFired(atWrite, stamping, nowMs, outcomes);
        for (const p of promotions) next = promoteToPlace(next, p.nodeId, p.runKey, p.repo);
        writeFlow(this.flowIo, this.flowsDir, next);
        // `next`, not `fresh`: the message should describe what was actually just
        // written — same reasoning as building `next` from `atWrite` above — and
        // `next` already carries the promotions too.
        //
        // A `notify` rule's whole point is reaching a human who is not looking at
        // the Deck — an unattended flow fired it precisely because nobody is
        // watching. A webview toast is invisible unless the panel happens to be
        // open and focused, so this goes through `showInformationMessage`
        // instead, which persists in the Notifications bell. Non-modal — this is
        // an announcement, not a question, and a modal here would steal focus
        // from whatever the user actually is doing.
        for (const line of notifyLines(next, stamping)) {
          void vscode.window.showInformationMessage(line);
        }
        for (const r of receipts) {
          // A successful launch or seed already announces itself by opening a
          // window; a notification on top of the toast would be noise. A
          // failure has no such announcement — "Couldn't create a git worktree
          // in bite-me — not launching ASM-12" is exactly the message that must
          // not die inside an unfocused panel — so it escalates past the toast.
          //
          // `showErrorMessage`, not `showInformationMessage`: this is the first
          // use of it in this file, chosen deliberately rather than copied.
          // orchestratorStyles.ts's own house rule reserves red "ONLY on a rule
          // that tried and actually failed" — this is that rule's exact case,
          // and an error latches (no retry until the user Resets it), so this
          // is at most one red notification per rule, not a loop that stacks.
          // It also has to read as visibly different from a `notify` firing —
          // otherwise "told you something" and "failed and stopped" collapse
          // into the same information notification, reproducing one layer out
          // the exact ambiguity ("I can see notify, but not who it notifies")
          // this task exists to fix. Still non-modal — no options argument —
          // an unattended flow's failure must not steal focus either.
          this.toast(r.level, r.message);
          if (r.level === "error") void vscode.window.showErrorMessage(r.message);
        }
      } catch (e) {
        this.log(`deck: flow ${flow.id} failed to advance: ${e}`);
      }
    }
    return asks;
  }

  /** The planned node a `launch` edge points at, or `undefined` when it points at
   * anything else. Now that the verb is DERIVED from the target, the two can only
   * disagree when the target's kind changed under this pass — the node was planned
   * work when `evaluateFlow` decided "launch" and is something else in the copy
   * being acted against. That is not a spend: it is the refusal below. */
  private plannedTarget(flow: Flow, edge: FlowEdge): PlannedNode | undefined {
    const target = findNode(flow, edge.to);
    return target && isPlanned(target) ? target : undefined;
  }

  /** The place a `seed` edge points at, or `undefined` when it points at anything
   * else — the mirror of `plannedTarget` for the other spending action. A `seed`
   * opens another agent in a place that already exists, so its target must be a
   * place, never planned work. */
  private placeTarget(flow: Flow, edge: FlowEdge): PlaceNode | undefined {
    const target = findNode(flow, edge.to);
    return target && isPlace(target) ? target : undefined;
  }

  /** What a `launch` or `seed` edge would actually spend money on, resolved just
   * far enough to ask about it — never as far as reading a ticket or touching
   * disk. `undefined` means the edge cannot spend anything (wrong kind of
   * target), so it must not count toward the once-per-flow gate below.
   *
   * `action` is passed IN — the value `evaluateFlow` derived for this pass and
   * carried on the `FiredEdge` — rather than read off `edge.action` or re-derived
   * from `flow` here. Re-deriving is what would let this function answer a
   * different question than the dispatch below and the stamp in `applyFired`;
   * see the vintage note in `advanceUnderLock`. The TARGET is still resolved out
   * of `flow`, which is why a verb whose target has since changed kind resolves
   * to `undefined` and gates nothing.
   *
   * `run` is deliberately unresolved here, and this is a gap, not an oversight:
   * `isSpendAction("run") === true` (model.ts) says a command SHOULD gate the
   * same once-per-flow ask a launch or seed does — it runs shell on the user's
   * machine, unattended — but `SpendTarget` has no `run` member yet to return.
   * Task 6 adds it, resolving a command node the same way `plannedTarget`/
   * `placeTarget` resolve theirs. Until that lands, a `run` edge falls out of
   * `wantsSpend` below with no consent asked — do NOT add command EXECUTION to
   * `performEdge` before this arm exists, or a flow will run a command with no
   * ask ever having been possible. */
  private spendTarget(flow: Flow, edge: FlowEdge, action: FlowAction | undefined): SpendTarget | undefined {
    // `isSpendAction` is the one predicate for "does this rule cost money" — the
    // caller hands every performing edge to this function rather than
    // pre-filtering by action, so this guard is the only place that question is
    // asked on this path. What follows resolves WHAT it spends on, which
    // `isSpendAction` deliberately knows nothing about.
    if (!isSpendAction(action)) return undefined;
    if (action === "launch") {
      const node = this.plannedTarget(flow, edge);
      return node ? { action: "launch", node, note: edge.note } : undefined;
    }
    // See this function's own doc comment: unresolved on purpose until Task 6.
    if (action === "run") return undefined;
    const node = this.placeTarget(flow, edge);
    return node ? { action: "seed", node, mode: edge.mode, note: edge.note } : undefined;
  }

  /** Ask, once per flow, before it ever spends anything — naming what will actually
   * happen, because that is what the money is spent on: a launch names the ticket
   * and the repos it would open, a seed names the place (it has no ticket to name).
   * Both name the prompt mode. Writes the answer (an approval, or a disarm) and
   * nothing else; the pass that asked never acts. Dismissing it writes nothing at
   * all, so the flow stays armed and is asked again later. */
  private async askFirstSpend(flow: Flow, target: SpendTarget): Promise<void> {
    const cfg = getConfig();
    const ACT = target.action === "launch" ? "Launch" : "Seed";
    const DISARM = "Disarm";
    // What the agent will actually be told is material to this consent, so a note
    // rides along in the same sentence as the prompt mode — absent, it contributes
    // nothing, so today's wording (and every existing assertion on it) survives.
    // Gated on `hasNote`, the SAME predicate `composeAgentPrompt` uses to decide
    // whether the note reaches the prompt at all: a whitespace-only note must not
    // show here as if it will be told to the agent when composeAgentPrompt would
    // silently drop it — that would be this consent gate misrepresenting what it
    // is asking the user to approve.
    const noteClause = hasNote(target.note) ? ` and the note "${notePreview(target.note)}"` : "";
    const message = target.action === "launch"
      ? (() => {
          const mode = cfg.promptModes.find((m) => m.id === target.node.mode);
          return `${flow.name} is ready to launch ${target.node.ticketKey} in ${target.node.repos.join(", ")} with the "${
            mode?.label ?? target.node.mode
          }" prompt${noteClause}, unattended. It will keep launching on its own from now on.`;
        })()
      : (() => {
          const mode = cfg.promptModes.find((m) => m.id === target.mode);
          return `${flow.name} is ready to seed another agent into ${target.node.repo} with the "${
            mode?.label ?? target.mode ?? "default"
          }" prompt${noteClause}, unattended. It will keep seeding on its own from now on.`;
        })();
    const answer = await vscode.window.showWarningMessage(message, { modal: true }, ACT, DISARM);
    // Re-read, and this is the ONLY thing standing between two windows here: the caller
    // released the lock before asking, so while this modal was up another window's pass
    // may have stamped an edge, or the user may have deleted the flow. Writing the copy
    // captured before the question would erase the one and resurrect the other. Narrow
    // by construction — read and write are adjacent, and only flow-level fields are
    // touched, never an edge stamp.
    const latest = readFlows(this.flowIo, this.flowsDir).find((f) => f.id === flow.id);
    if (!latest) return;
    if (answer === ACT) writeFlow(this.flowIo, this.flowsDir, { ...latest, launchConfirmedAt: Date.now() });
    else if (answer === DISARM) writeFlow(this.flowIo, this.flowsDir, { ...latest, armed: false });
  }

  /** The configured PromptMode for an id, or a `done` refusal naming what will not
   * happen because of it. Shared by both acting verbs, which resolve the id from
   * different places — a launch from its planned node, a seed from the edge — but must
   * refuse identically: a mode the user has since deleted can never be silently
   * replaced with a default, because that seeds an agent with someone else's prompt,
   * which is worse than not acting at all. Deterministic, so it latches: a later pass
   * would answer this identically, and an armed flow retrying a rule that can never run
   * is worse than one stalled rule the drawer shows and offers Reset for. */
  private modeFor(id: string | undefined, notDoing: string): { mode: PromptMode } | { refusal: EdgeDone } {
    const mode = getConfig().promptModes.find((m) => m.id === id);
    if (mode) return { mode };
    return {
      refusal: {
        kind: "done",
        outcome: { ok: false, error: `the prompt mode "${id}" is no longer configured — ${notDoing}.` },
      },
    };
  }

  /** Perform one acting edge and report what happened.
   *
   * Every SPENDING step is guarded — `launchPlanned` never throws by contract, and the
   * `openWorkspace` a seed calls is wrapped — so nothing here can spend money and then
   * throw instead of reporting it. The pre-flight reads around them (`getConfig`,
   * `discoverRepos`) are NOT wrapped: a throw there escapes to the per-flow `catch` in
   * `advanceUnderLock`, which logs it and leaves the edge pending. That is the honest
   * outcome — those calls spend nothing — but it is not "never throws".
   *
   * A `done` result settles the edge and is never retried: that is what stops a
   * launch failing on every poll from ending in twenty windows, and the drawer shows
   * such a rule as stalled and offers Reset. It covers every DETERMINISTIC refusal
   * (an unwired verb, a target that is not planned work, a prompt mode that no longer
   * exists — none of which a later pass would answer differently) as well as a launch
   * that genuinely tried and failed.
   *
   * A `defer` result is the opposite: a pre-flight READ failed, so nothing was spent
   * and nothing is decided. The edge is left pending and the next pass tries again,
   * because latching there would let one Jira blip permanently kill a rule.
   *
   * `statuses` is the same `RunStatus[]` this poll already built for the board —
   * threaded in rather than re-read, so a `seed` resolves its place against exactly
   * what the rest of this pass saw.
   *
   * `action` is threaded in too, for the same reason `spendTarget`'s is: it is the
   * verb `evaluateFlow` derived for this pass and `applyFired` will stamp against,
   * and re-deriving it here from `flow` — or reading `edge.action`, the record's
   * backward-compatibility mirror — is exactly how this function could come to
   * perform one verb while the stamp claimed another. */
  private async performEdge(
    flow: Flow,
    edge: FlowEdge,
    statuses: RunStatus[],
    action: FlowAction | undefined,
  ): Promise<EdgeResult> {
    // An action the target does not imply cannot be performed. Reached when the
    // target is missing or of a kind this build does not know — the same
    // situation `evaluate.ts` reports as "gone", stamped here so the rule
    // settles instead of being re-evaluated every poll forever.
    if (action === undefined) {
      return {
        kind: "done",
        outcome: { ok: false, error: `this rule points at ${edge.to}, which is not a place, planned work, a notification, or a command.` },
      };
    }
    if (action === "seed") return this.performSeed(flow, edge, statuses);
    // A `run` edge falls through to here today because `isSpendAction("run")`
    // is true and this is the acting loop's only other branch — NOT because
    // running a command is implemented. Without this arm it would fall into
    // the launch resolution below and settle with "a launch rule must point
    // at planned work", which is the wrong words for a command and would say
    // nothing about the real gap: `spendTarget` (above) has no `run` member
    // to resolve yet, so this edge never went through the once-per-flow
    // consent ask either. Settles rather than defers — the same "so the rule
    // doesn't retry every poll forever" reasoning as the `undefined` case
    // above, and correct here too: nothing about the target will change on
    // its own. Task 6 replaces this arm with real execution once `SpendTarget`
    // gains its `run` member and the ask can actually happen first.
    if (action === "run") {
      return {
        kind: "done",
        outcome: { ok: false, error: `this rule points at a command, and running one isn't implemented yet.` },
      };
    }
    const node = this.plannedTarget(flow, edge);
    if (!node) {
      return {
        kind: "done",
        outcome: { ok: false, error: `a launch rule must point at planned work, and ${edge.to} is not.` },
      };
    }
    const cfg = getConfig();
    // A planned node carries its own PromptMode id.
    const found = this.modeFor(node.mode, `not launching ${node.ticketKey}`);
    if ("refusal" in found) return found.refusal;
    // Typed as the launcher's own structural detail rather than left to inference:
    // this is where a connector's `TaskDetail` is checked against the four fields a
    // launch actually needs, and an evolving `any` would check nothing.
    let detail: LaunchTicketDetail;
    try {
      detail = await this.connector.provider().detail(node.ticketKey);
    } catch (e) {
      // A pre-flight READ failed, so nothing was spent and nothing is decided. Leave
      // the edge pending instead of settling it: latching here would let one Jira
      // blip kill a rule permanently, and retrying a read costs nothing. Distinct
      // from a failed launch, which stays latched because it may have spent
      // something — an expired token, a dropped VPN and a 503 are all this case.
      return { kind: "defer", reason: `couldn't read ${node.ticketKey}: ${e}` };
    }
    const res = await launchPlanned(
      {
        node,
        detail,
        repos: discoverRepos(cfg.reposRoot, cfg.repoBlocklist),
        promptTemplate: composeAgentPrompt(found.mode.prompt, edge.note),
        workspaceDir: cfg.workspaceDir,
        seedAgent: cfg.seedAgent,
        // `cfg.workspaceMode` also has "auto" and "ask", and neither is a layout: an
        // unattended launch must never stop to ask. The same non-interactive mapping
        // `takeBatch` makes — one repo means one window, and anything else is one
        // multiroot window for the task rather than a window per repo.
        workspaceMode: node.repos.length === 1 || cfg.workspaceMode === "per-window" ? "per-window" : "multiroot",
        // The brief names the agent that will read it, so a Copilot user's
        // flow-launched run must not be handed a brief that says Claude Code.
        agentName: providerLabel(cfg.agentProvider),
      },
      { createWorktrees, openWorkspace, log: this.log },
    );
    if (!res.ok) {
      // A launch that TRIED and failed latches, however transient the cause looks:
      // it may have created a worktree or opened a window, and retrying every six
      // seconds is how one bad rule becomes twenty windows.
      return {
        kind: "done",
        outcome: { ok: false, error: res.message },
        receipt: { level: "error", message: `${flow.name}: ${res.message}` },
      };
    }
    return {
      kind: "done",
      outcome: { ok: true, note: `launched ${node.ticketKey} in ${res.repo}` },
      promote: { nodeId: node.id, runKey: res.runKey, repo: res.repo },
      receipt: {
        level: "success",
        message: `${flow.name}: launched ${node.ticketKey} in ${res.repo}.${
          cfg.seedAgent ? " Claude Code pre-seeded — press Enter to start." : ""
        }`,
      },
    };
  }

  /** Perform a `seed` edge: open another agent in a place that already exists — a
   * second pair of hands in the same worktree. Unlike `launch`, there is no ticket
   * to fetch (a place is not planned work) and nothing to promote (the place is
   * already there), so this never returns `promote`.
   *
   * Resolving the place to a directory is entirely local — the `run.key`/`repo`
   * lookup below reads only `statuses`, the RunStatus[] this poll already built —
   * so every failure here is deterministic and latches immediately. There is no
   * pre-flight network read to `defer` on, the way a launch defers a ticket fetch. */
  private async performSeed(
    flow: Flow,
    edge: FlowEdge,
    statuses: RunStatus[],
  ): Promise<EdgeDone> {
    const node = this.placeTarget(flow, edge);
    if (!node) {
      return {
        kind: "done",
        outcome: { ok: false, error: `a seed rule must point at a place, and ${edge.to} is not.` },
      };
    }
    // The run this place belongs to is not coming back on its own if it is gone —
    // another window's retire sweep removed it, or the user did — so this latches
    // exactly like a launch whose ticket is gone would, naming what went missing.
    const status = statuses.find((s) => s.run.key === node.runKey);
    if (!status) {
      return {
        kind: "done",
        outcome: { ok: false, error: `the run "${node.runKey}" is no longer on the board — not seeding ${node.repo}.` },
      };
    }
    const repo = status.run.repos.find((r) => r.name === node.repo);
    if (!repo) {
      return {
        kind: "done",
        outcome: {
          ok: false,
          error: `"${node.repo}" is no longer one of ${node.runKey}'s repos — not seeding it.`,
        },
      };
    }
    const cfg = getConfig();
    // A place has no `mode` of its own the way a planned node does, so a seed's prompt
    // id lives on the EDGE (Task 6 is what lets the inspector set it).
    const found = this.modeFor(edge.mode, `not seeding ${node.repo}`);
    if ("refusal" in found) return found.refusal;
    try {
      await openWorkspace({
        // A seed has no ticket: `run.key`/`summary`/`url` are the closest thing —
        // they identify the place, not a new piece of work.
        ticket: { key: status.run.key, summary: status.run.summary, url: status.run.url },
        planMd: "",
        descriptionText: "",
        // The place's OWN repo, as the single service — which is what makes the brief's
        // "Repos in scope" section name it rather than come up empty, on the one path
        // that still writes a brief here (a place that has none yet).
        services: [{ name: repo.name, path: repo.path, isGit: repo.isGit }],
        mode: "per-window",
        promptTemplate: composeAgentPrompt(found.mode.prompt, edge.note),
        workspaceDir: cfg.workspaceDir,
        seedAgent: cfg.seedAgent,
        openIn: "new",
        existingFolder: repo.path,
        // A seed creates no run — the run this place belongs to already exists.
        // Without this, openWorkspace's own writeRun would OVERWRITE that run's
        // record under the same key: `repos` narrowed to just this one service,
        // `createdAt` reset to now, `kind`/`mode`/`workspaceFile` dropped or
        // forced, silently rewriting the card the user is looking at.
        recordRun: false,
        // The same reasoning one file over, for the other thing a seed would otherwise
        // overwrite. This worktree's brief is the one the agent ALREADY working here was
        // given, and the file this seeded prompt's own `{brief}` resolves to. A seed
        // brings a second pair of hands to work that is under way; it is not a new task,
        // and it has no ticket description to write a brief from — with `planMd` and
        // `descriptionText` both empty, rewriting would replace a real brief with an
        // empty one, unattended, with nothing to undo it from.
        keepExistingBrief: true,
      });
    } catch (e) {
      // Tried and may have spent something (a window may already be open, a brief
      // may already be written) — latches exactly like a launch that threw.
      const message = `Couldn't seed ${node.repo}: ${e}`;
      return {
        kind: "done",
        outcome: { ok: false, error: message },
        receipt: { level: "error", message: `${flow.name}: ${message}` },
      };
    }
    return {
      kind: "done",
      outcome: { ok: true, note: `seeded another agent in ${node.repo}` },
      // A seed never promotes anything: the place it targets already exists.
      receipt: {
        level: "success",
        message: `${flow.name}: seeded another agent in ${node.repo}.${
          cfg.seedAgent ? " Claude Code pre-seeded — press Enter to start." : ""
        }`,
      },
    };
  }

  private startPolling(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.prQueue.clear();
  }

  /** Is `gh` usable? Kicks the probe off on first call and returns what we know
   * so far — never awaited, because a 10s `gh auth status` must not sit in front
   * of a paint. An unresolved probe reads as "not yet": queue nothing this tick. */
  private ghReady(): boolean {
    if (!this.prFacts) return false;
    if (this.ghProbe === null) {
      const p = (this.ghProbe = probeGh());
      void p.then((gap) => {
        // A probe orphaned by a settings change (onConfigChanged resets ghProbe
        // and starts a fresh one when prFacts turns back on) must not win if it
        // resolves after the fresh probe already has — that would let a stale
        // gap clobber a fresh pass right after the user ran `gh auth login`,
        // defeating the whole point of re-probing.
        if (this.ghProbe !== p) return;
        this.ghGap = gap;
        // The note names the kind; only the log can say which gh we tried and
        // what it said, which is the difference between a diagnosable report and
        // "PR facts just don't work here".
        if (gap) this.log(`deck: gh unusable (${gap.kind}): ${gap.detail}`);
      });
    }
    return this.ghGap === null;
  }

  /** Queue a stale repo's refresh. Deliberately not awaited by the caller: a
   * hanging `gh` must never stall the git and transcript reads. The epoch is
   * captured at enqueue time so a fetch still in flight when the run is
   * forgotten can detect that and skip its write, rather than recreating the
   * cache file `deck:forget` just deleted.
   *
   * `key` and `searchKey` differ for a local card: `key` is `run.key` — the
   * store's identity, always — while `searchKey` is what the provider's
   * fallback `--search "<searchKey> in:title"` can actually match against. For
   * every run Agent Flow Deck launched the two are the same string; for a local card
   * with an inferred ticket, `key` is the place-hash and `searchKey` is the
   * ticket (see `ticketKeyFor`) — the only one of the two a PR title could ever
   * contain. */
  private enqueuePr(key: string, searchKey: string, repo: { name: string; path: string }, branch: string | null, previous?: PrEntry): void {
    const epoch = this.prEpoch.get(key) ?? 0;
    this.prQueue.push(repo.path, async () => {
      let res: FetchResult;
      try {
        res = await this.pr.fetch(repo.path, branch, searchKey);
      } catch {
        // A provider must never throw, but a thrown error here must still not
        // leave this entry unstamped — an unstamped entry reads as stale on
        // every tick and re-enqueues the same repo forever, since
        // isStale(undefined, …) is always true.
        res = { ok: false };
      }
      if ((this.prEpoch.get(key) ?? 0) !== epoch) return; // forgotten mid-flight
      if (!res.ok) this.log(`deck: pr fetch ${key}/${repo.name} failed`);
      const entry: PrEntry = res.ok
        ? { facts: res.facts, fetchedAt: Date.now() }
        : { facts: previous?.facts ?? null, fetchedAt: Date.now(), error: true };
      writePrEntry(defaultPrFactsDir(), key, repo.name, entry);
    });
  }

  /** Is the review strip live? Two gates, not three: the session's own Review
   * queue flag (seeded from the persistent `reviewRequests` setting, then held
   * until `onConfigChanged` re-seeds it — re-reading config here would stomp
   * the flag on every poll tick), and `ghReady()` — which already folds the
   * session PR-facts flag and a usable gh together, so there is no condition
   * here that varies independently of PR facts. */
  private reviewsEnabled(): boolean {
    return this.reviewQueue && this.ghReady();
  }

  /** Queue a search when the cache has aged out. Never awaited — a hanging `gh`
   * must not stall the board's git and transcript reads. The post that reflects
   * the outcome is fired from here rather than unconditionally from `refresh()`:
   * with a search in flight, an immediate post would either find `reviewCache`
   * still null (nothing to show yet) or show the old entry with `stale` not yet
   * flipped — a premature message a later, correct one would just have to
   * override. Posting once, when the picture is actually settled, is simpler
   * and is what `deck:setReviewSort` also relies on for its own direct post.
   * (When `RefreshQueue.push` dedupes because a search is already in flight for
   * this key, this call posts nothing at all — the in-flight job's own post,
   * from an earlier tick, is what will land.) */
  private enqueueReviews(nowMs: number): void {
    const ttlMs = getConfig().reviewRequestsTtlSeconds * 1000;
    if (this.reviewCache === null) this.reviewCache = readReviewCache(defaultReviewsFile());
    if (!isReviewCacheStale(this.reviewCache, ttlMs, nowMs)) {
      this.postReviews(); // already fresh — nothing to wait on
      return;
    }
    // Gate on the data clock (above) *and* the attempt clock: a failing search
    // never advances `fetchedAt`, so the data clock alone would re-queue `gh api
    // graphql` on every 6s poll tick forever once `gh` starts failing — rate
    // limited, network down, SSO expired. This clock tracks "how recently did we
    // try", independently of "how old is the data we are showing".
    if (this.reviewLastAttemptAt !== null && nowMs - this.reviewLastAttemptAt < ttlMs) return;
    this.prQueue.push("reviews", async () => {
      this.reviewLastAttemptAt = Date.now();
      let res: { issueCount: number; requests: ReviewRequest[] } | null;
      try {
        res = await this.reviewProvider.search();
      } catch {
        // A provider must never throw, but if one does, this must still not
        // leave it unhandled: RefreshQueue swallows a rejected job (the queue
        // owns the slot, not the error), so without this catch the failure would
        // never set `reviewStale` and never post — the strip would just silently
        // stop updating, with nothing in the log to say why. Mirrors `enqueuePr`'s
        // identical guard for the identical failure mode.
        res = null;
      }
      if (res === null) {
        // Keep whatever we had: an empty strip would read as "you owe nobody a
        // review", which is the opposite of what a failed fetch means.
        this.reviewStale = true;
        this.log("deck: review search failed");
      } else {
        this.reviewStale = false;
        this.reviewCache = { fetchedAt: Date.now(), issueCount: res.issueCount, requests: res.requests };
        writeReviewCache(defaultReviewsFile(), this.reviewCache);
      }
      this.postReviews();
    });
  }

  /** Decorate the cached queue with what only this machine can know. Recomputed
   * every post: a checkout can appear, a review run can start or finish, and a
   * worktree can be forgotten — a cached path to any of those would render an
   * action that cannot work. */
  private decorateReviews(requests: ReviewRequest[]): ReviewRequest[] {
    const cfg = getConfig();
    const byName = new Map(discoverRepos(cfg.reposRoot, cfg.repoBlocklist).map((r) => [r.name, r]));
    const reviewRuns = new Map(
      readRuns(defaultRunsDir()).filter((r) => runKind(r) === "review").map((r) => [r.key, r]),
    );
    return requests.map((r) => {
      const local = byName.get(r.repoName);
      const run = reviewRuns.get(reviewRunKey(r.repoName, r.number));
      // The draft lives in the worktree the agent was launched into, not the main
      // checkout — that is the only place the agent could have written it.
      const wt = run?.repos[0]?.path;
      const draft = wt ? path.join(wt, BRIEF_DIR, `REVIEW-${r.number}.md`) : null;
      return {
        ...r,
        localPath: local?.isGit ? local.path : null,
        runKey: run?.key ?? null,
        draftPath: draft && fs.existsSync(draft) ? draft : null,
      };
    });
  }

  /** Post whatever the strip can show *right now*, without waiting on anything.
   * Loads the on-disk cache first if it has not been read yet — the same read
   * `enqueueReviews` does, hoisted so the queue does not sit behind a board
   * build that has nothing to do with it. Never starts a search: the refresh
   * that follows owns that, and its own post supersedes this one. */
  private postCachedReviews(): void {
    if (this.reviewsEnabled() && this.reviewCache === null) {
      this.reviewCache = readReviewCache(defaultReviewsFile());
    }
    this.postReviews();
  }

  private postReviews(): void {
    if (!this.reviewsEnabled()) {
      // The strip just went off (reviewRequests, PR facts, or gh going
      // unusable) — actively say so, rather than merely staying silent. Silence
      // here used to leave the webview's last posted rows on screen exactly as
      // they were: frozen, but with their write buttons still live, so a click
      // could still reach the provider from a strip the user believed they had
      // just switched off. `enabled: false` travels alongside the emptied
      // `requests` for the same reason: it marks this as "off," not "empty,"
      // for whatever downstream reads the flag.
      this.post({
        type: "deck:reviews", requests: [], issueCount: 0, sort: this.reviewSort,
        stale: false, reviewWrites: getConfig().reviewWrites, enabled: false, loading: false,
      });
      return;
    }
    if (!this.reviewCache) {
      // Cold start: no cache on disk, so a first search is either in flight or
      // about to be queued. This used to return silently, which left the webview
      // with nothing to render and no reason to think anything was coming — the
      // strip simply appeared several seconds later and shoved the board down.
      // `stale` is what tells the two null-cache cases apart: a *failed* first
      // search leaves the cache null and sets it, and must read as "couldn't
      // check" rather than shimmer forever waiting for a search that already
      // gave up.
      this.post({
        type: "deck:reviews", requests: [], issueCount: 0, sort: this.reviewSort,
        stale: this.reviewStale, reviewWrites: getConfig().reviewWrites,
        enabled: true, loading: !this.reviewStale,
      });
      return;
    }
    this.post({
      type: "deck:reviews",
      requests: sortRequests(this.decorateReviews(this.reviewCache.requests), this.reviewSort),
      issueCount: this.reviewCache.issueCount,
      sort: this.reviewSort,
      stale: this.reviewStale,
      reviewWrites: getConfig().reviewWrites,
      enabled: true,
      loading: false,
    });
  }

  /** Fetch the two facts the search cannot return. A failure still posts —
   * `detail: null` — rather than staying silent: the row's search-level facts
   * (review decision, mergeability) are still useful and worth showing, but
   * nothing else was ever going to tell the webview to stop rendering
   * "loading…" forever on a fetch that already gave up. */
  private async reviewDetail(id: string): Promise<void> {
    const req = this.reviewCache?.requests.find((r) => r.id === id);
    if (!req) return;
    const detail = await this.reviewProvider.detail(req.repo, req.number);
    if (!detail) {
      this.log(`deck: review detail ${id} failed`);
      this.post({ type: "deck:reviewDetail", id, detail: null });
      return;
    }
    this.post({ type: "deck:reviewDetail", id, detail });
  }

  /** The decorated view of one queued PR — recomputed, never cached, for the same
   * reason decorateReviews itself is: `localPath`, `runKey` and `draftPath` must
   * reflect what is true on disk right now, not at the last search. */
  private reviewById(id: string): ReviewRequest | undefined {
    return this.decorateReviews(this.reviewCache?.requests ?? []).find((r) => r.id === id);
  }

  private async launchReviewFor(id: string): Promise<void> {
    const req = this.reviewById(id);
    if (!req) return; // the queue moved on before the click landed
    const cfg = getConfig();
    // Resolve — or ask — before launchReview runs, because launchReview's first
    // act is createWorktrees. A picker raised any later would leave a worktree
    // and a branch behind every time someone pressed Escape.
    const mode =
      resolveReviewMode(cfg.reviewRequestModes, cfg.reviewRequestMode) ??
      (await vscode.window.showQuickPick(
        cfg.reviewRequestModes.map((m) => ({ label: m.label, detail: m.detail, mode: m })),
        { title: `Review ${req.repoName}#${req.number}`, ignoreFocusOut: true },
      ))?.mode;
    if (!mode) return; // picker cancelled — no worktree, no window, no toast
    const res = await launchReview(
      { req, template: mode.prompt, workspaceDir: cfg.workspaceDir, seedAgent: cfg.seedAgent },
      { createWorktrees, openWorkspace, log: this.log },
    );
    if (!res.ok) {
      this.toast("error", res.message);
      return;
    }
    this.toast(
      "success",
      `Reviewing ${req.repoName}#${req.number} in a worktree.${cfg.seedAgent ? ` ${providerLabel(cfg.agentProvider)} pre-seeded — press Enter to start.` : ""}`,
    );
    await this.refreshBusy(); // picks up the new run so the row shows "reviewing"
  }

  /** Hand the agent's findings to the review box. Read on demand rather than
   * carried on every deck:reviews post — the file is a whole review, and the
   * strip re-posts on every poll tick. */
  private loadReviewDraft(id: string): void {
    const req = this.reviewById(id);
    if (!req?.draftPath) return;
    try {
      this.post({ type: "deck:reviewDraft", id, body: fs.readFileSync(req.draftPath, "utf8").trim() });
    } catch (e) {
      this.log(`deck: review draft ${id} unreadable: ${e}`);
      this.toast("error", `Couldn't read the agent's review for ${req.repoName}#${req.number}.`);
    }
  }

  /** The one write path. Gates before anything reaches GitHub, in order: the
   * setting, the strip actually being on, a `verb` that is actually one of the
   * three GitHub understands, no other submit already in flight for this id,
   * the row still being in the queue, and a modal the user has to accept. */
  private async submitReview(id: string, verb: ReviewVerb, body: string, fromDraft: boolean): Promise<void> {
    const cfg = getConfig();
    // Every gate below that refuses *this* id's own attempt releases the
    // webview's disable the same way a completed submit does — nothing was
    // written, so "cancelled" (not "failed") is the honest outcome, and without
    // it the row would stay disabled until the panel is reloaded (these two
    // races are pre-existing and tested: reviewWrites flipped off after the
    // panel opened, and the row evicted from the queue between the click and
    // this call).
    if (!cfg.reviewWrites) {
      this.post({ type: "deck:reviewSubmitDone", id, outcome: "cancelled" });
      return;
    }
    // The strip itself can go dark (PR facts toggled off, reviewRequests
    // flipped, gh going unusable) without the row's own message queue draining
    // instantly — `reviewById` below still resolves from `reviewCache`, which
    // `postReviews`'s "cleared" post never touches. Without this, a submit that
    // was already in the webview's outbox before the toggle could still reach
    // GitHub from a strip the user just switched off.
    if (!this.reviewsEnabled()) {
      this.post({ type: "deck:reviewSubmitDone", id, outcome: "cancelled" });
      return;
    }
    // `verb` arrives from a webview message, untyped at runtime no matter what
    // `ReviewVerb` claims at compile time. `Object.hasOwn` (not `!VERB_LABEL[verb]`,
    // which a prototype key like "constructor" would sail through as truthy) fails
    // closed before any dialog is shown — the same guard `provider.ts`'s `submit`
    // already applies to the identical value, for the identical reason. Without
    // this, an out-of-union verb reads `label` as `undefined`: the dialog shows
    // "undefined on owner/repo#123?", and `undefined !== undefined` is *false*, so
    // the decline branch below is skipped regardless of what the user answers —
    // `provider.ts` still refuses the write, but the log would claim a submit the
    // user never confirmed, and the user would be told "GitHub refused" about a
    // call that never reached GitHub.
    if (!Object.hasOwn(VERB_LABEL, verb)) {
      this.post({ type: "deck:reviewSubmitDone", id, outcome: "cancelled" });
      return;
    }
    // Deliberately silent: this gate is only reachable while a genuine call for
    // this same id is still in flight, and that call — not this rejected
    // duplicate — owns posting the eventual outcome. Posting "cancelled" here
    // would release the webview's disable while the real submit is still
    // running, re-enabling the buttons mid-flight — the opposite of what the
    // guard exists for.
    if (this.reviewSubmitsInFlight.has(id)) return;
    const req = this.reviewById(id);
    if (!req) {
      this.post({ type: "deck:reviewSubmitDone", id, outcome: "cancelled" });
      return;
    }
    this.reviewSubmitsInFlight.add(id);
    try {
      const label = VERB_LABEL[verb];
      const answer = await vscode.window.showWarningMessage(
        `${label} on ${req.repo}#${req.number}?`,
        { modal: true },
        label,
      );
      if (answer !== label) {
        // Distinct from a failure: nothing was attempted, so there is nothing to
        // warn about — just release the row's disable.
        this.post({ type: "deck:reviewSubmitDone", id, outcome: "cancelled" });
        return;
      }
      const text = fromDraft && cfg.stampLabelOnWrite && body.trim()
        ? `${body.trim()}\n\n${reviewProvenance(cfg.agentProvider)}`
        : body;
      this.log(`deck: submitting ${verb} on ${req.repo}#${req.number}`);
      const res = await this.reviewProvider.submit(req.repo, req.number, verb, text);
      if (!res.ok) {
        this.log(`deck: review submit failed: ${res.message}`);
        // Neutral prefix, on purpose: neither "GitHub refused:" nor "Review not
        // sent:" holds up in front of the timeout wording, which says the write
        // may already have gone through — either prefix would assert an outcome
        // the message itself refuses to commit to.
        this.post({
          type: "toast",
          level: "error",
          message: `Review submit: ${res.message}`,
          action: { label: "Open PR", url: req.url },
        });
        this.post({ type: "deck:reviewSubmitDone", id, outcome: "failed" });
        return;
      }
      this.toast("success", `${label} sent on ${req.repoName}#${req.number}.`);
      // Approving or requesting changes clears the review request server-side; a
      // comment does not — after a comment you are still in requested_reviewers,
      // so the row must stay until the next search proves otherwise. issueCount is
      // decremented alongside the eviction, and the trimmed cache is written to
      // disk immediately: memory-only would let closing and reopening the Deck
      // re-read the untouched file and resurrect the row before the next search runs.
      if ((verb === "approve" || verb === "request-changes") && this.reviewCache) {
        this.reviewCache = {
          ...this.reviewCache,
          issueCount: Math.max(0, this.reviewCache.issueCount - 1),
          requests: this.reviewCache.requests.filter((r) => r.id !== id),
        };
        writeReviewCache(defaultReviewsFile(), this.reviewCache);
      }
      this.postReviews();
      this.post({ type: "deck:reviewSubmitDone", id, outcome: "ok" });
    } catch (e) {
      // Anything unexpected here (writeReviewCache, decorateReviews's fs calls,
      // `post` itself before its own guard was added — a disposed panel used to
      // throw mid-write, landing between the success toast and the cache
      // eviction below it) must still tell the webview this row is no longer
      // waiting on an outcome. Without this, nothing else was ever going to post
      // a deck:reviewSubmitDone for this id, and the row's buttons would stay
      // disabled until the panel reloads — even though the write itself may well
      // have already gone through.
      this.log(`deck: review submit ${id} threw after starting: ${e}`);
      this.post({ type: "deck:reviewSubmitDone", id, outcome: "failed" });
    } finally {
      this.reviewSubmitsInFlight.delete(id);
    }
  }

  private async ticketStatus(key: string): Promise<{ status: string | null; category: string | null } | null> {
    const hit = this.ticketCache.get(key);
    if (hit && Date.now() - hit.at < TICKET_TTL_MS) return { status: hit.status, category: hit.category };
    try {
      const s = await this.connector.provider().status(key);
      this.ticketCache.set(key, { at: Date.now(), ...s });
      return s;
    } catch (e) {
      if (e instanceof TaskAuthError) return null; // git backbone still renders
      this.log(`deck: ticket status ${key} failed: ${e}`);
      return hit ? { status: hit.status, category: hit.category } : null;
    }
  }

  private async buildAll(): Promise<RunStatus[]> {
    // Review runs are work in flight, but not *your ticket's* work: they surface
    // on their strip row, not as a fifth kind of card in In progress.
    const tracked = readRuns(defaultRunsDir()).filter((r) => runKind(r) !== "review");
    const projectsRoot = path.join(os.homedir(), ".claude", "projects");
    const now = Date.now();
    const authed = await this.connector.isAuthenticated();
    const ghReady = this.ghReady();
    const openIdentities = new Set(readLiveWindows(defaultWindowsDir()).map((w) => w.identity));

    // Every Claude Code session open on this machine, grouped by the directory it
    // runs in. A place is claimed by at most one tracked run; Task 11 turns what
    // is left into cards of its own.
    // Read unconditionally: `openAgents` is a *display* toggle, but the retire
    // sweep must never mistake "not showing agents" for "no agent is running" —
    // that would retire a run with somebody actively working in it.
    const allPlaces = groupByPlace(readOpenSessions(defaultSessionsDir()));
    const places = this.openAgents ? allPlaces : new Map<string, OpenSession[]>();
    const livePlaces = new Set(allPlaces.keys());
    const claimed = new Set<string>();
    const agentsByKey = new Map<string, CardAgent[]>();
    for (const run of tracked) {
      const mine: CardAgent[] = [];
      for (const repo of run.repos) {
        const place = canon(repo.path);
        const sessions = places.get(place);
        if (!sessions) continue;
        claimed.add(place);
        for (const s of sessions) {
          mine.push({
            session: s,
            // Addressed by sessionId, so two sessions in one worktree report
            // their own states rather than sharing the newest transcript's.
            activity: readSessionActivity(projectsRoot, s.cwd, s.sessionId, now),
            repo: repo.name,
          });
        }
      }
      agentsByKey.set(run.key, mine);
    }

    // Whatever no tracked run claimed is a place you are working in that the Deck
    // has never heard of. One git call each for the branch — buildRunStatus does
    // the rest of the git work from run.repos, so this does not double it.
    const cfg = getConfig();
    this.localRuns.clear();
    const locals: Run[] = [];
    for (const [place, sessions] of places) {
      if (claimed.has(place)) continue;
      const branch = currentBranch(place);
      const ticket = inferTicket(branch, cfg.project, cfg.baseUrl);
      const run = localRunFor(place, sessions, { isGit: repoRoot(place) !== "", branch }, ticket, now);
      this.localRuns.set(run.key, run);
      agentsByKey.set(
        run.key,
        sessions.map((s) => ({
          session: s,
          activity: readSessionActivity(projectsRoot, s.cwd, s.sessionId, now),
          repo: run.repos[0]?.name,
        })),
      );
      locals.push(run);
    }
    const all = [...tracked, ...locals];
    // One round trip per run, all at once. Serially this was the bulk of a cold
    // refresh, and back then every Forget waited on the whole pass before its card
    // left the board — the webview now drops that card optimistically, but the pass
    // is still what the board's next authoritative state waits on. ticketStatus owns
    // its own errors, so this can never reject; run keys are unique, so concurrent
    // calls never duplicate a cache miss.
    // ticketKeyFor, not run.key: a run saved under its place-hash (Track it, when
    // the inferred key already belonged to another run) carries its ticket only
    // in its url — polling run.key there would 404 forever, every tick.
    const tickets = await Promise.all(
      all.map((run) => (authed && isTicketRun(run) ? this.ticketStatus(ticketKeyFor(run, this.connector)) : null)),
    );
    const out: RunStatus[] = [];
    let stale = 0;
    for (const [i, run] of all.entries()) {
      const ticket = tickets[i];
      const stored = this.prFacts ? readPrEntries(defaultPrFactsDir(), run.key) : {};
      // A repo on its default branch is filtered out here as well as below, so a
      // stale entry written before this rule existed stays inert on disk rather
      // than rendering as this run's pull request. This also drops entries for
      // repos that have left the run — re-taking a task with a different repo
      // selection can leave one behind. It is never re-staled (only repos in
      // run.repos are checked below), yet an orphan would still render as a
      // PrBlock and vote in prSignals, pinning a card in Needs you or out of
      // Done with Forget as the only escape.
      const prs: PrEntryMap = Object.fromEntries(
        run.repos.filter((r) => stored[r.name] && prEligible(r)).map((r) => [r.name, stored[r.name]]),
      );
      if (ghReady) {
        const ttlMs = getConfig().prFactsTtlSeconds * 1000;
        for (const repo of run.repos) {
          if (prEligible(repo) && isStale(prs[repo.name], ttlMs, now)) {
            this.enqueuePr(run.key, ticketKeyFor(run, this.connector), repo, repo.branch ?? null, prs[repo.name]);
          }
        }
      }
      const status = buildRunStatus({
        run, ticket, projectsRoot, nowMs: now,
        openIdentities, prs,
        agents: agentsByKey.get(run.key) ?? [],
      });
      // A local card has no record on disk — `removeRun` would be a no-op but
      // `writeRun` would *create* one, promoting a card the user never tracked.
      if (runKind(run) === "local") {
        // The webview has no connector of its own to parse run.url with, so the
        // inferred key crosses the wire pre-computed — through the same
        // connector and the same ticketKeyFor every other caller here uses,
        // rather than a second parser living in the webview.
        out.push(run.url ? { ...status, inferredTicketKey: ticketKeyFor(run, this.connector) } : status);
        continue;
      }
      if (this.applyVerdict(run, this.verdictFor(status, livePlaces, now))) continue;
      // Counted, not cleared: this is exactly what Clear stale would take. The
      // second call is free of side effects — `verdictFor` is pure, and only
      // `applyVerdict` ever writes.
      if (this.verdictFor(status, livePlaces, now, true).action === "retire") stale++;
      out.push(status);
    }
    this.sweepReviewRuns(livePlaces, now, false, () => stale++);
    this.staleCount = stale;
    return out;
  }

  /** Apply one verdict. Returns true when the run should leave the board. */
  private applyVerdict(run: Run, v: RetireVerdict): boolean {
    const dir = defaultRunsDir();
    switch (v.action) {
      case "retire":
        removeRun(dir, run.key);
        removePrEntries(defaultPrFactsDir(), run.key);
        // Any fetch already in flight belongs to the incarnation just deleted.
        this.prEpoch.set(run.key, (this.prEpoch.get(run.key) ?? 0) + 1);
        this.log(`deck: retired ${run.key} (${v.reason})`);
        return true;
      case "stamp":
        writeRun(dir, { ...run, finishedAt: v.finishedAt });
        return false;
      case "unstamp": {
        const { finishedAt: _dropped, ...rest } = run;
        writeRun(dir, rest);
        return false;
      }
      default:
        return false;
    }
  }

  /**
   * Retire everything that is only waiting out a window. Rules and vetoes are
   * exactly the sweep's — the *only* difference is that both time gates are
   * ignored — so nothing with uncommitted or unpushed work can be cleared here
   * either. Modal-gated, unlike per-card Forget: a bulk delete earns a
   * confirmation.
   */
  private async clearStale(): Promise<void> {
    const n = this.staleCount;
    if (n === 0) return;
    const label = `Clear ${n}`;
    const answer = await vscode.window.showWarningMessage(
      `Retire ${n} stale run record${n === 1 ? "" : "s"}? Worktrees, branches and commits are left untouched.`,
      { modal: true },
      label,
    );
    if (answer !== label) return;
    const nowMs = Date.now();
    const livePlaces = new Set(groupByPlace(readOpenSessions(defaultSessionsDir())).keys());
    for (const status of await this.buildAll()) {
      if (runKind(status.run) === "local") continue;
      this.applyVerdict(status.run, this.verdictFor(status, livePlaces, nowMs, true));
    }
    this.sweepReviewRuns(livePlaces, nowMs, true);
    await this.refreshBusy();
  }

  /** The verdict for one run. `overrideGates` ignores both time windows — that is
   * what Clear stale means, and the counting pass uses it too. */
  private verdictFor(
    s: RunStatus,
    livePlaces: ReadonlySet<string>,
    nowMs: number,
    overrideGates = false,
  ): RetireVerdict {
    const cfg = getConfig();
    return retireVerdict({
      run: s.run,
      repos: s.repos,
      ticketCategory: s.ticketCategory,
      prs: s.prs,
      hasLiveSession: s.run.repos.some((r) => livePlaces.has(canon(r.path))),
      prsAuthoritative: this.prFacts,
      finishedAfterMs: overrideGates ? 0 : cfg.retireFinishedAfterHours * 3_600_000,
      abandonedAfterMs: overrideGates ? 1 : cfg.retireAbandonedAfterDays * 86_400_000,
      nowMs,
      exists: (p) => fs.existsSync(p),
    });
  }

  /**
   * Review runs never render as cards, so they never get a `RunStatus` — but they
   * still pile up in the store. Sweep them with the same rules against a
   * git-only status: no Jira (a review run's url is a PR's) and no PR facts,
   * which are never fetched for them. `prsAuthoritative: true` is honest here in
   * a way it would not be for a tracked run: the map is *structurally* empty for
   * a review run, not merely unfetched, so rule 3's "no PR" test is sound.
   */
  private sweepReviewRuns(
    livePlaces: ReadonlySet<string>,
    nowMs: number,
    overrideGates = false,
    onStale?: () => void,
  ): void {
    for (const run of readRuns(defaultRunsDir()).filter((r) => runKind(r) === "review")) {
      // Computed once and passed in: the counting pass in Clear stale asks for a
      // second verdict on the same run, and git state cannot change between them.
      const repos = run.repos.map((r) => gitState(r.name, r.path));
      if (this.applyVerdict(run, this.reviewVerdictFor(run, repos, livePlaces, nowMs, overrideGates))) continue;
      if (onStale && this.reviewVerdictFor(run, repos, livePlaces, nowMs, true).action === "retire") onStale();
    }
  }

  /** One review run's verdict, against a git-only picture. */
  private reviewVerdictFor(
    run: Run,
    repos: RepoGit[],
    livePlaces: ReadonlySet<string>,
    nowMs: number,
    overrideGates: boolean,
  ): RetireVerdict {
    const cfg = getConfig();
    return retireVerdict({
      run,
      repos,
      ticketCategory: null,
      prs: {},
      hasLiveSession: run.repos.some((r) => livePlaces.has(canon(r.path))),
      prsAuthoritative: true,
      finishedAfterMs: overrideGates ? 0 : cfg.retireFinishedAfterHours * 3_600_000,
      abandonedAfterMs: overrideGates ? 1 : cfg.retireAbandonedAfterDays * 86_400_000,
      nowMs,
      exists: (p) => fs.existsSync(p),
    });
  }

  private async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    try {
      const runs = await this.buildAll();
      if (seq !== this.refreshSeq) return; // a newer pass owns the board
      this.post({
        type: "deck:runs",
        runs,
        ghNote: this.prFacts && this.ghGap ? GH_NOTES[this.ghGap.kind] : null,
        // Read fresh on every post rather than cached in a field: it is a plain
        // string setting a user can edit mid-session, and the board re-posts often
        // enough that this is the whole of "keep it live".
        prReviewStatus: getConfig().prReviewStatus,
        staleCount: this.staleCount,
        sourceLabel: this.connector.info().label,
      });
      // The disabled branch posts its own "cleared" state directly — enqueueReviews
      // only ever posts once a search settles or is already fresh, neither of
      // which happens while the strip is off.
      if (this.reviewsEnabled()) this.enqueueReviews(Date.now());
      else this.postReviews();
      // Awaited: a pass can now open a workspace and ask a question, and postFlows()
      // below must see the write that pass made — the whole reason this work rides
      // the refresh instead of its own timer.
      await this.advanceArmedFlows(runs, Date.now());
      this.postFlows();
    } catch (e) {
      this.log(`deck: refresh failed: ${e}`);
    }
  }

  /** Refresh with the webview's busy indicator on. Every inbound message that
   * awaits a refresh goes through here: Forget in particular waits on a full
   * rebuild, and used to do it with nothing on screen to say so. `finally` so a
   * refresh that ever does throw cannot strand the spinner. */
  private async refreshBusy(): Promise<void> {
    if (this.busyDepth++ === 0) this.post({ type: "deck:loading", loading: true });
    try {
      await this.refresh();
    } finally {
      if (--this.busyDepth === 0) this.post({ type: "deck:loading", loading: false });
    }
  }

  /** The panel seeds these three from config once and then holds them, so a
   * routine refresh cannot stomp them mid-session. With no toggles left on the
   * header, a settings edit is the only way to change them — and without this
   * listener it would do nothing until the panel was closed and reopened. */
  private async onConfigChanged(e: vscode.ConfigurationChangeEvent): Promise<void> {
    const cfg = getConfig();
    let touched = false;
    if (e.affectsConfiguration("agentFlow.prFacts")) {
      this.prFacts = cfg.prFacts;
      // The user may have run `gh auth login` since the last probe; a stale gap
      // would otherwise keep PR facts dark for the rest of the session.
      if (cfg.prFacts) {
        this.ghGap = undefined;
        this.ghProbe = null;
      }
      touched = true;
    }
    if (e.affectsConfiguration("agentFlow.openAgents")) {
      this.openAgents = cfg.openAgents;
      touched = true;
    }
    if (e.affectsConfiguration("agentFlow.reviewRequests")) {
      this.reviewQueue = cfg.reviewRequests;
      // Before the rebuild, not through it: switching off has to empty the strip
      // now, not after a full board build.
      this.postCachedReviews();
      touched = true;
    }
    // Posted, not refreshed: display-only, and this is what keeps a settings-page
    // edit landing now that the lens no longer rides along on every board post.
    if (e.affectsConfiguration("agentFlow.deckGrouping")) {
      this.post({ type: "deck:grouping", grouping: cfg.deckGrouping });
    }
    if (touched) await this.refreshBusy();
  }

  private async onMessage(m: InboundMessage): Promise<void> {
    switch (m.type) {
      case "deck:ready":
        // Before the board build, not after it. `refresh()` only reaches
        // `enqueueReviews` once `buildAll()` has finished — git per repo and Jira
        // per run — so a queue already sitting on disk used to wait out the whole
        // board for no reason. Posting it here costs one file read and puts the
        // strip on screen with the first paint; with no cache to post, the same
        // call posts `loading: true`, so the strip still has something to say
        // while the first search runs.
        this.post({ type: "deck:grouping", grouping: getConfig().deckGrouping });
        this.postCachedReviews();
        await this.refreshBusy();
        break;
      case "deck:refresh":
        await this.refreshBusy();
        break;
      case "deck:clearStale":
        await this.clearStale();
        break;
      case "deck:setGrouping":
        // Persisted, so the lens survives a reload — but not refreshed: the
        // webview derives both lenses from the run list it already holds, so a
        // rebuild here would redraw an identical board at the cost of git per
        // repo and a connector round trip per run.
        await vscode.workspace
          .getConfiguration("agentFlow")
          .update("deckGrouping", m.grouping, vscode.ConfigurationTarget.Global);
        break;
      case "deck:inspect":
        await this.inspect(m.key, m.action, m.repo);
        break;
      case "deck:setReviewSort":
        this.reviewSort = m.sort;
        this.postReviews();
        break;
      case "deck:reviewExpand":
        // Routed through the same queue every other `gh` call uses (concurrency
        // capped at 4, deduped by key) — awaited directly here, expanding rows in
        // quick succession could fork an unbounded number of `gh` processes, one
        // per row, with nothing capping how many run at once.
        this.prQueue.push(`detail:${m.id}`, () => this.reviewDetail(m.id));
        break;
      case "deck:reviewLaunch":
        await this.launchReviewFor(m.id);
        break;
      case "deck:reviewLoadDraft":
        this.loadReviewDraft(m.id);
        break;
      case "deck:reviewSubmit":
        await this.submitReview(m.id, m.verb, m.body, m.fromDraft);
        break;
      case "deck:forget":
        removeRun(defaultRunsDir(), m.key);
        removePrEntries(defaultPrFactsDir(), m.key);
        // Any fetch already in flight for this key belongs to the incarnation we
        // just deleted — bump the epoch so its write is a no-op if it lands late.
        this.prEpoch.set(m.key, (this.prEpoch.get(m.key) ?? 0) + 1);
        await this.refreshBusy();
        break;
      case "deck:track":
        await this.track(m.key);
        break;
      case "deck:addressPr":
        await this.addressPr(m.key);
        break;
      case "flow:create": {
        if (!getConfig().orchestrator) return;
        const now = Date.now();
        // `newFlowId` is probabilistic, not unique by construction: its salt space
        // is 36^4, so two flows minted in the same millisecond CAN collide, and a
        // collision here would silently overwrite the user's existing flow, since
        // the store writes by id. Re-mint against what is already on disk. Bounded
        // rather than a while-loop so a pathological `Math.random()` cannot hang
        // the extension host.
        const taken = new Set(readFlows(this.flowIo, this.flowsDir).map((f) => f.id));
        let id = newFlowId(now);
        for (let i = 0; taken.has(id) && i < 8; i++) id = newFlowId(now + i + 1);
        if (taken.has(id)) return; // 9 collisions in a row is broken, not unlucky
        writeFlow(this.flowIo, this.flowsDir, emptyFlow(id, "New flow", now));
        this.postFlows();
        return;
      }
      case "flow:rename": {
        if (!getConfig().orchestrator) return;
        const existing = readFlows(this.flowIo, this.flowsDir).find((f) => f.id === m.id);
        if (!existing) return;
        writeFlow(this.flowIo, this.flowsDir, { ...existing, name: m.name });
        this.postFlows();
        return;
      }
      case "flow:save": {
        if (!getConfig().orchestrator) return;
        // Only a flow the host already has may be saved. The drawer can only ever
        // edit one it was given; anything else would create a file from nothing.
        const existing = readFlows(this.flowIo, this.flowsDir).find((f) => f.id === m.flow.id);
        if (!existing) return;
        // Preserve the fields the HOST owns. From this phase on the host stamps
        // firedAt/firedNote/error during its poll, and the drawer may be holding a
        // flow from before that stamp — writing its copy verbatim would clear the
        // latch and re-fire a rule that already ran.
        const mine = new Map(existing.edges.map((e) => [e.id, e]));
        writeFlow(this.flowIo, this.flowsDir, {
          ...m.flow,
          // The host owns four FLOW-level fields too, and a graph save has no
          // business carrying any of them. `armed` is written only by `flow:arm`
          // and `flow:resumeDisarm`: a save built from a `flow` prop captured
          // before a `deck:flows` post lands holds a stale value, so pressing
          // Disarm in the resume banner and then flushing a queued save would
          // RE-ARM the flow with the resume gate already cleared — armed, and free
          // to fire immediately. `name` belongs to `flow:rename`, and `createdAt`
          // is the sort key: neither is the drawer's to overwrite on a node drag.
          // `launchConfirmedAt` is written by `askFirstSpend`'s answer, once per
          // flow — a stale save dropping it would silently un-ask a question the
          // user already answered.
          name: existing.name,
          armed: existing.armed,
          createdAt: existing.createdAt,
          launchConfirmedAt: existing.launchConfirmedAt,
          edges: m.flow.edges.map((e) => {
            const host = mine.get(e.id);
            if (!host) return e;
            return { ...e, firedAt: host.firedAt, firedNote: host.firedNote, error: host.error };
          }),
        });
        this.postFlows();
        return;
      }
      case "flow:addPlanned": {
        if (!getConfig().orchestrator) return;
        await this.addPlanned(m.id);
        return;
      }
      case "flow:delete": {
        if (!getConfig().orchestrator) return;
        // The same membership check `flow:save` and `flow:rename` make, for the same
        // reason: the drawer can only ever act on a flow the host handed it, so an id
        // that is not on disk is not a delete to carry out. Without it this arm
        // reaches `fs.rmSync` on a path built from webview-supplied text.
        const existing = readFlows(this.flowIo, this.flowsDir).some((f) => f.id === m.id);
        if (!existing) return;
        removeFlow(this.flowIo, this.flowsDir, m.id);
        this.postFlows();
        return;
      }
      case "flow:arm": {
        if (!getConfig().orchestrator) return;
        const flow = readFlows(this.flowIo, this.flowsDir).find((f) => f.id === m.id);
        if (!flow) return;
        writeFlow(this.flowIo, this.flowsDir, { ...flow, armed: m.armed });
        if (m.armed) {
          // Warn and name, rather than refuse: a flow with one dead rule and three
          // live ones is still worth arming, and silence is how a user ends up
          // waiting forever on something that can never happen.
          // `liveSignal: true` unconditionally: the header toggle for it is gone and
          // the live signal is always on now, so no rule can be unfirable for want of
          // it. `armability` keeps the dimension because it is a pure module and a
          // future toggle would want it back — but its "needs Live signal" branch is
          // unreachable from here today. See the note in the ledger: collapsing that
          // branch is a deliberate follow-up, not something to fold into a merge.
          const dead = unfirableRules(flow, { liveSignal: true, prFacts: this.prFacts });
          if (dead.length > 0) {
            const live = dead.filter((d) => d.needs === "live-signal").length;
            const pr = dead.filter((d) => d.needs === "pr-facts").length;
            const parts: string[] = [];
            if (pr > 0) parts.push(`${pr} need${pr === 1 ? "s" : ""} PR facts`);
            if (live > 0) parts.push(`${live} need${live === 1 ? "s" : ""} the Live signal`);
            this.post({
              type: "toast",
              level: "info",
              message: `${flow.name} armed — but ${parts.join(" and ")}, which ${
                parts.length > 1 ? "are" : "is"
              } off, so ${dead.length === 1 ? "that rule" : "those rules"} can never fire.`,
            });
          }
        } else {
          // A disarmed flow holds no resume gate — re-arming starts the cycle over.
          this.pendingResume.delete(m.id);
          this.resumeCleared.delete(m.id);
        }
        this.postFlows();
        return;
      }
      case "flow:resetEdge": {
        if (!getConfig().orchestrator) return;
        const flow = readFlows(this.flowIo, this.flowsDir).find((f) => f.id === m.id);
        if (!flow) return;
        writeFlow(this.flowIo, this.flowsDir, {
          ...flow,
          // Rebuilt from its non-host fields rather than deleting three keys, so a
          // future host-owned field cannot be silently forgotten here.
          //
          // `action` is deliberately NOT carried over, which makes this the one
          // place a stored action is dropped. It is what makes Reset mean what
          // `latchActionMismatches` promises it means — "Reset the rule to accept
          // that" — for the shape that needs it most: an edge whose stored action
          // disagrees with its target is latched with an error on every read, and
          // carrying the disagreeing value through this write left the next read
          // to stamp the identical error, forever. Dropping it lets `writeFlow`'s
          // `e.action ?? edgeAction(...)` re-derive from the target, so stored and
          // derived agree and there is nothing left to latch.
          //
          // This does NOT leave the field absent on disk — relied on, not
          // defeated: `writeFlow` fills it from the target, which is what keeps an
          // OLDER build's `validEdge` (which still requires `action`) from
          // dropping the edge after a downgrade.
          //
          // Nor is it a silent reinterpretation. Deriving on EVERY write is unsafe
          // and `writeFlow` explains why; deriving here is safe because Reset is
          // the user's explicit consent, and the error they are clearing names both
          // readings ("it was saved as X but where it points now means Y"). `mode`
          // still survives: it is the user's own configuration, not a mirror of
          // anything, and a seed has nowhere else to keep it.
          edges: flow.edges.map((e) =>
            e.id === m.edgeId ? { id: e.id, from: e.from, to: e.to, cond: e.cond, mode: e.mode } : e,
          ),
        });
        this.postFlows();
        return;
      }
      case "flow:resumeApprove": {
        if (!getConfig().orchestrator) return;
        // An id nobody is holding is not this flow's approval to act on — most
        // plausibly a stale click from a banner the store has since moved past.
        // Refusing here, before touching anything, is also what keeps this a
        // no-op rather than an unearned busy-refresh for a click that named
        // nothing this panel is actually holding.
        if (!this.pendingResume.has(m.id)) return;
        this.pendingResume.delete(m.id);
        // Clearing the gate is all approval does — it does not fire anything
        // itself. The refresh that follows is what lets the next pass fire.
        this.resumeCleared.add(m.id);
        await this.refreshBusy();
        return;
      }
      case "flow:resumeDisarm": {
        if (!getConfig().orchestrator) return;
        const flow = readFlows(this.flowIo, this.flowsDir).find((f) => f.id === m.id);
        if (!flow) return;
        this.pendingResume.delete(m.id);
        this.resumeCleared.add(m.id);
        writeFlow(this.flowIo, this.flowsDir, { ...flow, armed: false });
        this.postFlows();
        return;
      }
      case "openExternal": {
        const u = vscode.Uri.parse(m.url);
        // f.url and every failing check's detailsUrl/targetUrl now come from
        // GitHub's API, which a check-run producer controls — unlike our own
        // Jira urls, that is not a trusted source for a scheme handed straight
        // to the OS (e.g. a vscode://<publisher>.<ext>/… reaching another
        // extension's UriHandler).
        if (u.scheme !== "https" && u.scheme !== "http") break;
        await vscode.env.openExternal(u);
        break;
      }
    }
  }

  /**
   * The missing ticket picker (Task 4b): the ONLY way a `planned` node comes into
   * being. The webview cannot build one itself — it has no task connector, and the
   * whole point of building this host-side is that a native `showQuickPick` is
   * fully keyboard-operable for free. Asks four questions in sequence — which
   * ticket, which repos, which prompt mode, which destination — and appends the
   * resolved `PlannedNode` in one write.
   *
   * Cancelling ANY step aborts the whole thing and writes nothing. That is not a
   * courtesy: a node written with an `undefined` field in it would still be a
   * `PlannedNode` as far as `flow:save`'s types are concerned, and Phase 3's
   * launcher (`performEdge` → `launchPlanned`) would then refuse it at spend
   * time with a confusing "no repos" or "mode not configured" message, on an
   * armed rule the user meant to abandon, not to half-build. Each step therefore
   * has its own early return — a single guard after all four would leave three
   * of them able to leak a partial node.
   *
   * Never round-trips a partial node through the webview: `flow:save` already
   * owns "write a whole flow," and sending a half-built node across the wire to
   * be completed later would be a second source of truth for the same graph.
   */
  private async addPlanned(flowId: string): Promise<void> {
    // An unauthenticated source must not produce an empty picker with no
    // explanation — say so and stop before anything is asked.
    if (!(await this.connector.isAuthenticated())) {
      this.toast("error", `Sign in to ${this.connector.info().label} to add planned work.`);
      return;
    }
    // "all" / "any": the fullest candidate list this connector can offer. Unlike
    // the task pool's own fetch, there is no lens the user picked for this — the
    // picker is a one-off lookup, not a persisted view — so nothing here narrows
    // it further on their behalf.
    const tasks = await this.connector.provider().list("all", "any");
    if (tasks.length === 0) {
      this.toast("error", `No tickets available from ${this.connector.info().label}.`);
      return;
    }
    const ticketPick = await vscode.window.showQuickPick(
      tasks.map((t) => ({ label: t.key, description: t.summary, task: t })),
      { title: "Add planned work — which ticket?", placeHolder: "Pick a ticket", ignoreFocusOut: true },
    );
    if (!ticketPick) return;

    const cfg = getConfig();
    const repos = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
    // Same gap as an unauthenticated connector or an empty ticket list: a picker
    // the user can only dismiss, with nothing said about why, is a dead end.
    // Same wording tasksView.ts's `explore()` and `resolveKickoffTarget` already
    // use for the identical cause, so a user who has seen it once there
    // recognises it here rather than parsing a second phrasing of the same fact.
    if (repos.length === 0) {
      this.toast("error", `No repos found under ${cfg.reposRoot}. Check agentFlow.reposRoot.`);
      return;
    }
    const repoPicks = await vscode.window.showQuickPick(
      repos.map((r) => ({ label: r.name, detail: r.isGit ? r.path : `${r.path}  (not a git repo)`, repo: r })),
      {
        canPickMany: true,
        title: "Add planned work — which repos?",
        placeHolder: "Space to toggle · Enter to continue",
        ignoreFocusOut: true,
      },
    );
    // Cancelled (undefined) or nothing toggled on (empty array) are the same
    // refusal here: a launch that fires on no repos is nothing to launch into
    // (see launchPlanned's own identical check on `node.repos.length`).
    if (!repoPicks || repoPicks.length === 0) return;

    const modePick = await vscode.window.showQuickPick(
      cfg.promptModes.map((mode) => ({ label: mode.label, detail: mode.detail, mode })),
      { title: "Add planned work — which prompt mode?", placeHolder: "Pick a prompt mode", ignoreFocusOut: true },
    );
    if (!modePick) return;

    const DEST_OPTIONS: { label: string; dest: LaunchDest }[] = [
      { label: "Worktree", dest: "worktree" },
      { label: "New window", dest: "new-window" },
      { label: "Current window", dest: "current-window" },
    ];
    const destPick = await vscode.window.showQuickPick(DEST_OPTIONS, {
      title: "Add planned work — where does it launch?",
      placeHolder: "Pick a destination",
      ignoreFocusOut: true,
    });
    if (!destPick) return;

    // Re-read, not the caller's stale copy: four modals were just up, in which
    // time the flow could have been renamed, deleted, or edited from another
    // window — the same reasoning every other flow:* handler in this file
    // re-reads for before it writes.
    const flow = readFlows(this.flowIo, this.flowsDir).find((f) => f.id === flowId);
    if (!flow) return;
    const node: PlannedNode = {
      // Same minting scheme as the webview's own `nextNodeId` (OrchestratorDrawer.tsx):
      // the lowest unused "n<N>", scanning past whatever is already taken rather than
      // trusting the live count, which drifts the moment anything is deleted.
      id: nextPlannedNodeId(flow),
      // The same fixed slot the tray's own drop path attaches a place at
      // (`attachAt(raw, 24, 24 + flow.nodes.length * 88)` in OrchestratorDrawer.tsx) —
      // so this node lands in its own spot rather than on top of an existing one.
      x: 24,
      y: 24 + flow.nodes.length * 88,
      join: "any",
      kind: "planned",
      ticketKey: ticketPick.task.key,
      repos: repoPicks.map((p) => p.repo.name),
      mode: modePick.mode.id,
      dest: destPick.dest,
    };
    writeFlow(this.flowIo, this.flowsDir, { ...flow, nodes: [...flow.nodes, node] });
    this.postFlows();
  }

  /**
   * Pin a local card: write the synthetic run we already built to the runs store,
   * so it survives its agents closing and behaves exactly like a Take'd one.
   *
   * The key it lands under is the inferred ticket's when one was inferred *and*
   * no tracked run already owns it — otherwise the local key, which cannot
   * collide with anything. Never overwrite a real launch record.
   */
  private async track(key: string): Promise<void> {
    const local = this.localRuns.get(key);
    if (!local) return; // not a local card — nothing to promote
    const inferredKey = local.url ? ticketKeyFor(local, this.connector) : "";
    const taken = inferredKey ? readRuns(defaultRunsDir()).some((r) => r.key === inferredKey) : true;
    const run: Run = {
      ...local,
      key: inferredKey && !taken ? inferredKey : key,
      // "task" and "explore" are the two kinds the rest of the Deck already
      // understands: a ticket to poll, or a session with none. "local" means
      // "discovered, not recorded" and stops being true the moment this lands.
      kind: local.url ? "task" : "explore",
    };
    writeRun(defaultRunsDir(), run);
    // The facts cached under the local key are orphaned — the new key refetches
    // once rather than inheriting a file nothing will ever re-stale.
    removePrEntries(defaultPrFactsDir(), key);
    this.localRuns.delete(key);
    await this.refreshBusy();
  }

  /** The run a card's action acts on. A local card has no record on disk — it is
   * a place with an agent open in it — so the last refresh's synthetic runs are
   * the only place to look it up. */
  private run(key: string): Run | undefined {
    return readRuns(defaultRunsDir()).find((r) => r.key === key) ?? this.localRuns.get(key);
  }

  private async inspect(key: string, action: "open" | "diff", repoName?: string): Promise<void> {
    const run = this.run(key);
    if (!run) {
      this.toast("error", `No run record for ${key}.`);
      return;
    }
    if (action === "open") {
      const target = run.workspaceFile ?? (repoName ? run.repos.find((r) => r.name === repoName)?.path : run.repos[0]?.path);
      if (!target) {
        this.toast("error", `Nothing to open for ${key}.`);
        return;
      }
      const ok = await openInEditor(target);
      if (!ok) this.toast("error", `Couldn't open ${key}.`);
      return;
    }
    // diff — everything this task changed, committed work included, in the editor's
    // own multi-file diff view.
    const repos = repoName ? run.repos.filter((r) => r.name === repoName) : run.repos;
    const outcome = await openTaskDiff(`Changes in ${run.key}`, repos);
    if (outcome === "opened") return;
    if (outcome === "empty") {
      this.toast("info", `No changes to show for ${key}.`);
      return;
    }
    if (outcome === "binary-only") {
      this.toast("info", `Only binary files changed for ${key}.`);
      return;
    }
    // unsupported — `vscode.changes` is a built-in command rather than a typed API,
    // so an editor that forked VS Code may not have it. The flat patch this used to
    // always produce is a worse read, but it is far better than a dead button.
    const chunks: string[] = [];
    for (const r of repos) {
      const d = taskDiff(r.path);
      if (d.trim()) chunks.push(run.repos.length > 1 ? `# ${r.name}\n${d}` : d);
    }
    if (chunks.length === 0) {
      this.toast("info", `No changes to show for ${key}.`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ content: chunks.join("\n\n"), language: "diff" });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /**
   * Re-seed an in-flight run with the Address PR prompt.
   *
   * The sidebar's kick-off acts on a *ticket*: nothing is on disk yet, so it reads
   * Jira, asks where to open, asks which repos, and makes a worktree. A Deck card acts
   * on a *run* that already has all three, so this asks nothing.
   *
   * Deliberately not openWorkspace, even though that is the function this mirrors:
   * openWorkspace rewrites the runs-store record with a fresh createdAt and re-derives
   * kind, which would reset "launched 4h ago" to "launched 0s ago" on a run taken
   * yesterday. It would rewrite every brief too, which needs a Jira fetch to do
   * faithfully. Re-seeding is the smaller operation, so it uses the smaller primitives
   * openWorkspace is itself built from, and the only thing that hits disk is the
   * transient plan file.
   *
   * Seeding reaches the window whether or not it is already open: watchPlansAndSeed
   * makes a live window seed itself when the plan lands, and openInEditor shells to
   * `open -a`, which focuses an existing window rather than opening a second one.
   */
  private async addressPr(key: string): Promise<void> {
    const run = this.run(key);
    if (!run) {
      this.toast("error", `No run record for ${key}.`);
      return;
    }
    // The webview only ever sends this for a card gated on isPrReviewStatus &&
    // kind !== "local" — but `this.run(key)` falls back to the in-memory
    // localRuns map, so a hand-crafted deck:addressPr naming a local key would
    // still resolve one. A local card's ticket is inferred from a branch name;
    // seeding a PR-review agent against that inference on one click is exactly
    // what this feature must never do. The other two guards below (no record,
    // nothing to open) are enforced host-side rather than trusted to the
    // webview, so this one is too — unreachable today, but cheap insurance
    // against a future caller that isn't as careful.
    if (runKind(run) === "local") {
      this.log(`deck: addressPr ignored for local card ${key}`);
      return;
    }
    const cfg = getConfig();
    const template = prReviewTemplate(cfg.prReviewPrompt, cfg.prReviewAutoFix);
    // ticketKeyFor, not run.key: track() saves a promoted local card under its
    // place-hash key when the inferred Jira key was already owned by another
    // run, and that ticket then lives only in the run's url. Seeding the prompt
    // with run.key there would tell the agent to match a PR title against a
    // hash rather than a Jira key. The plan file's `key` names the same ticket
    // (it is what the on-disk filename and the seeded-session guard key off),
    // so it uses the same derivation rather than a second, disagreeing one.
    const ticketKey = ticketKeyFor(run, this.connector);
    const ticket = { key: ticketKey, summary: run.summary, url: run.url };
    // Mirror the shape this run was launched in — that is what its windows are. A
    // multiroot run is one window on the workspace file, rendered against the absolute
    // brief the launch wrote; a per-window run is one window per repo, where the
    // relative .pick-task/TASK.md resolves inside each. Same split openWorkspace makes,
    // and it keeps every window of a multi-repo run seeded rather than just the first.
    // Keyed on workspaceFile's presence, not mode, the way inspect() already does it.
    // mentions is empty: file hints come from the ticket description, and re-fetching
    // Jira is exactly what this path exists to avoid.
    const matches = run.workspaceFile
      ? [{ matchPath: run.workspaceFile, prompt: agentPrompt(ticket, [], template, run.briefPaths[0]) }]
      : run.repos.map((r) => ({ matchPath: r.path, prompt: agentPrompt(ticket, [], template) }));
    if (matches.length === 0) {
      this.toast("error", `Nothing to open for ${key}.`);
      return;
    }
    // Honor seedAgent the way every other launch does: with it off, nothing seeds
    // anywhere, and writing a plan file no window will act on would just litter.
    if (cfg.seedAgent) {
      writePlanFile({ key: ticketKey, createdAt: Date.now(), seedAgent: true, matches });
    }
    // Collected rather than one toast per failing match: a multi-repo run with
    // two dead windows would otherwise show the identical "Couldn't open ASM-1."
    // twice, telling the user nothing about which repo actually failed.
    const failedRepos: string[] = [];
    for (const m of matches) {
      if (await openInEditor(m.matchPath)) continue;
      failedRepos.push(run.repos.find((r) => r.path === m.matchPath)?.name ?? m.matchPath);
    }
    if (failedRepos.length === 1 && matches.length === 1) {
      // The common case (one repo, or the single multiroot workspace file) keeps
      // the plain message — naming the sole repo would just repeat the key.
      this.toast("error", `Couldn't open ${key}.`);
    } else if (failedRepos.length > 0) {
      this.toast("error", `Couldn't open ${key} (${failedRepos.join(", ")}).`);
    } else if (!cfg.seedAgent) {
      // Address PR with seedAgent off is otherwise silently indistinguishable
      // from plain Open — nothing seeded, no toast, no way to tell the two
      // apart from what actually happened. Only reached when every window did
      // open: a failure already got its own explanation above.
      this.toast("info", `Opened ${key}'s window — nothing seeded, agentFlow.seedAgent is off.`);
    }
  }

  private dispose(): void {
    DeckPanel.current = undefined;
    this.stopPolling();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "deck.js"));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
