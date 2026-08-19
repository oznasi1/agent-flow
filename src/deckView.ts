import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { exec } from "child_process";
import { DEFAULT_COMMANDS, getConfig, providerLabel, type AgentProvider } from "./config";
import { TaskAuthError, TaskConnector } from "./tasks/provider";
import { readRuns, defaultRunsDir, removeRun, writeRun } from "./engine/runs";
import { CommandNode, Flow, FlowAction, FlowEdge, LaunchDest, PlaceNode, PlannedNode, emptyFlow, findNode, isCommand, isPlace, isPlanned, isSettled, isSpendAction } from "./engine/orchestrator/model";
import { defaultFlowsDir, readFlows, writeFlow, removeFlow } from "./engine/orchestrator/store";
import { nodeFlowIo, nodeLockIo, newFlowId } from "./engine/orchestrator/flowIo";
import { LOCK_TTL_MS, acquire, release, renew } from "./engine/orchestrator/lock";
import { evaluateFlow } from "./engine/orchestrator/evaluate";
import { unfirableRules } from "./engine/orchestrator/armability";
import { ActOutcome, applyFired, notifyLines } from "./engine/orchestrator/runner";
import { promoteToPlace } from "./engine/orchestrator/promote";
import { LaunchTicketDetail, launchPlanned } from "./engine/orchestrator/launch";
import { COMMAND_KILLED_EXIT_CODE, CommandRunner, chainSourcePlace, resolveCommand, runCommand, withSavedCommand } from "./engine/orchestrator/command";
import { buildRunStatus } from "./engine/status";
import { UsageReader } from "./engine/usageFs";
import type { UsageTotals } from "./engine/usage";
import { readLiveWindows, defaultWindowsDir } from "./engine/presence";
import { agentPrompt, openInEditor, openWorkspace, writePlanFile, BRIEF_DIR } from "./engine/workspace";
import { createWorktrees, repoRootOfWorktree } from "./engine/worktree";
import { currentBranch, gitState, prEligible, repoRoot, taskDiff } from "./engine/git";
import { diffTitle, openTaskDiff, workspaceLabel } from "./engine/diffView";
import { RetireVerdict, retireVerdict } from "./engine/retire";
import { BranchCiStatus, branchCiKey } from "./engine/orchestrator/branchCi";
import { defaultPrFactsDir, isStale, readPrEntries, removePrEntries, writePrEntry } from "./engine/pr/store";
import { FetchResult } from "./engine/pr/provider";
import { RefreshQueue } from "./engine/pr/queue";
import { discoverRepos } from "./engine/repos";
import { composeAgentPrompt, hasNote, prReviewTemplate, prWorkClause } from "./engine/prompt";
import { launchReview, resolveReviewMode, reviewRunKey } from "./engine/review/launch";
// The one seam: every PR fetch, review call, and branch-CI probe on this panel
// goes through the `Forge` `resolveForge` returns, in place of the GitHub-only
// providers this file used to construct directly. `Forge`/`ForgeGap` are
// `import type` — erased at build time — for the reason forge/types.ts itself
// documents: this module must add no runtime edge to the forge directory beyond
// the registry call below.
import { resolveForge } from "./engine/forge/registry";
import type { Forge, ForgeGap } from "./engine/forge/types";
import { ReviewCache, defaultReviewsFile, isReviewCacheStale, readReviewCache, writeReviewCache } from "./engine/review/store";
import { sortRequests } from "./engine/review/sort";
import { groupPlacesByWindow, inferTicket, localRunFor } from "./engine/localRuns";
import { defaultSessionsDir, groupByPlace, readOpenSessions } from "./engine/sessions";
import { readSessionActivity } from "./engine/transcript";
import { canon } from "./engine/paths";
import { OwnedRun, resolveOwnership } from "./engine/ownership";
import { shelfFor } from "./engine/visibility";
import { prSignals } from "./engine/bucket";
// The scope picker the modes-notice hide-write already uses: a settings write must
// land where the user's value already lives. Saving a command is the same problem.
import { pickExplicit } from "./modesNotice";
import { CardAgent, FlowPromptMode, InboundMessage, OpenSession, OutboundMessage, PendingResume, PrEntry, PrEntryMap, PromptMode, PrWorkReason, RepoGit, ReviewRequest, ReviewSort, ReviewVerb, Run, RunStatus, ServiceRef, isTicketRun, runKind, ticketKeyFor } from "./types";

export const POLL_MS = 6000;
const TICKET_TTL_MS = 30_000;

/** The usage sweep's own cadence. Deliberately far slower than POLL_MS: parsing
 * transcripts is the one read here that scales with corpus size rather than
 * with board size, and `refresh()` must never block on it. */
export const USAGE_POLL_MS = 60_000;

/** ~/.claude/projects — where Claude Code keeps one directory of transcripts per
 * cwd. Hoisted from the inline const the status build used, so the usage sweep
 * and the activity read cannot drift onto two different roots. A function
 * rather than a module-level const because `os.homedir()` at import time is a
 * needless load-order dependency in a module the extension host loads early. */
function claudeProjectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/** The footer note per reason PR facts are off, named with the configured
 * forge's own CLI (a function rather than a constant, now that the CLI is no
 * longer always `gh`). Naming the actual gap matters: the CLI living somewhere
 * the extension host's PATH cannot see it is by far the likeliest cause, and
 * reads to a signed-in user as the Deck being broken. */
const FORGE_NOTES: Record<ForgeGap["kind"], (cli: string) => string> = {
  missing: (cli) => `${cli} CLI not found — PR facts off. Run Doctor`,
  "signed-out": (cli) => `${cli} is not signed in — PR facts off. Run Doctor`,
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

/** How much of a command's captured output `exec` buffers before it kills the child.
 * `exec`'s own default is 1 MiB; stated here rather than left implicit because it is
 * a real limit on what the output channel can show for a chatty deploy, and because
 * exceeding it is one of the non-numeric failures `shellCommandRunner` has to map to
 * an exit code below. */
const COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;


/** The one place a flow's command actually reaches a shell, and the only place in
 * this feature that holds a process handle.
 *
 * `child_process.exec`, deliberately, not `spawn`: `exec` takes a `timeout` option
 * and Node arms that timer itself, sending `killSignal` to the child when it
 * expires. That is what makes `CommandRunner`'s timeout a real contract instead of
 * a number passed around — `command.ts` awaits this promise unconditionally and adds
 * no `Promise.race` (see its own doc comment on why a caller-side race would trade a
 * hung pass for a silently orphaned process), so a runner that never settled would
 * hold the flows-directory lock for the life of the extension host and stall every
 * other window's Deck refresh. A `spawn` with a hand-rolled timer would have to
 * reimplement exactly this and could get it wrong; `exec` cannot forget.
 *
 * `SIGKILL`, not the default `SIGTERM`: a deploy script that traps or ignores TERM
 * would otherwise keep running past its own deadline while the runner reported it
 * killed.
 *
 * Never rejects. Every failure — a non-zero exit, a timeout kill, a shell that could
 * not even start, more output than `maxBuffer` holds — resolves as a `code`/`stdout`/
 * `stderr` triple, because the caller is a poll loop inside the Deck's refresh and
 * `runCommand`'s "never throws" guarantee is worth more than a distinction between
 * kinds of failure that all end the same way: the rule latches with an error. */
export const shellCommandRunner: CommandRunner = (command, opts) =>
  new Promise((resolve) => {
    exec(
      command,
      {
        cwd: opts.cwd,
        // The contract. Node kills the child here; nothing else in this feature can.
        timeout: opts.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: COMMAND_MAX_OUTPUT_BYTES,
        // Pins the string-typed `exec` overload as well as the decoding: a Buffer
        // pair would satisfy `CommandRunner`'s types only after a cast, and the
        // output is going straight into a log channel and a receipt.
        encoding: "utf8",
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        // A number means the command chose it: an ordinary failing exit, and the
        // most common case by far. Nothing to explain — the code IS the reason.
        if (typeof err.code === "number") return resolve({ code: err.code, stdout, stderr });
        // A STRING code is one of Node's own (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`,
        // `ENOENT` for a shell that isn't there). The command never got to report
        // anything, so the message is the only evidence there is.
        if (typeof err.code === "string") return resolve({ code: 1, stdout, stderr: withReason(stderr, err.message) });
        // No code at all and a signal: this is the timeout kill above (or a kill
        // from outside). Reported as `COMMAND_KILLED_EXIT_CODE`, which `command.ts`
        // owns precisely so it can turn it into a receipt that names the deadline —
        // the reason line below reaches the output channel, but the edge's `error`
        // is built from the code.
        if (err.killed || err.signal) {
          return resolve({
            code: COMMAND_KILLED_EXIT_CODE,
            stdout,
            stderr: withReason(stderr, `killed by ${err.signal ?? "signal"} — it did not finish within ${opts.timeoutMs} ms.`),
          });
        }
        return resolve({ code: 1, stdout, stderr: withReason(stderr, err.message) });
      },
    );
  });

/** Append the runner's own explanation to whatever the command managed to write,
 * on its own line. Joined rather than concatenated for the same reason
 * `runCommand` joins stdout and stderr: a partial last line with no newline would
 * otherwise run straight into the reason ("Deploying…killed by SIGKILL"). */
function withReason(stderr: string, reason: string): string {
  return stderr.length > 0 ? `${stderr}\n${reason}` : reason;
}

/** What a performing edge (`launch`, `seed` or `run`) is about to spend on, resolved
 * just far enough for the once-per-flow confirmation to name it. A `launch` has a
 * ticket and a set of repos; a `seed` has no ticket at all — only the place it opens
 * another agent in and the prompt mode it uses; a `run` has neither, and carries the
 * resolved command TEXT, because for a shell command the text is not a description
 * of what will happen, it IS what will happen — a label like "Deploy" tells the user
 * nothing about `deploy.sh --env=prod`. `note` rides along from the edge on all
 * three: it is what the agent will actually be told, so it belongs in the same
 * consent gate as the ticket/repos/mode. For a `run` it is deliberately not rendered
 * as its own clause — `resolveCommand` has already spliced it into `text` at
 * `{note}`, or dropped it because the template has no `{note}` at all — but it is
 * kept on the member so every spend target says what it carries. */
type SpendTarget =
  | { action: "launch"; node: PlannedNode; note?: string }
  | { action: "seed"; node: PlaceNode; mode?: string; note?: string }
  | { action: "run"; node: CommandNode; text: string; label: string; note?: string };

/** How much of a rule's note the once-per-flow confirmation shows. The modal is
 * naming what the agent will be told, not reproducing it in full — a pasted
 * paragraph must not grow the dialog unboundedly. Prose survives elision: the first
 * 160 characters of a note tell you what it is about. */
const NOTE_PREVIEW_MAX = 160;

function notePreview(note: string): string {
  return note.length > NOTE_PREVIEW_MAX ? note.slice(0, NOTE_PREVIEW_MAX) + "…" : note;
}

/** How much of a COMMAND the confirmation shows, and it is deliberately not
 * `NOTE_PREVIEW_MAX`. A shell command is not prose: the operative part is very
 * often at the END (`&& deploy.sh`, `| sh`, `; rm -rf ~`), and a rule's note is
 * spliced in unquoted, so head-only truncation can hide the exact fragment the user
 * most needs to see behind an "…". This modal is the only place that fragment is
 * ever shown, so the cap is far larger AND the tail is always kept. */
const COMMAND_PREVIEW_MAX = 600;
/** How much of the tail survives elision. Enough for the trailing clause of a
 * pipeline, not so much that head and tail meet in the middle. */
const COMMAND_PREVIEW_TAIL = 200;

function commandPreview(text: string): string {
  if (text.length <= COMMAND_PREVIEW_MAX) return text;
  return `${text.slice(0, COMMAND_PREVIEW_MAX - COMMAND_PREVIEW_TAIL)}…${text.slice(-COMMAND_PREVIEW_TAIL)}`;
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
  private usageTimer: ReturnType<typeof setInterval> | undefined;
  /** Held for the view's lifetime — its per-file offsets and dedup sets are what
   * make each sweep cost only the newly appended bytes. */
  private readonly usage = new UsageReader();
  /** run key → last swept totals. Read by the status build; written only by the
   * sweep, so a refresh never waits on a parse. */
  private usageByRun = new Map<string, UsageTotals>();
  private readonly ticketCache = new Map<string, { at: number; status: string | null; category: string | null }>();
  /** The last refresh's synthetic runs for places no tracked run claimed — cleared
   * and repopulated on every rebuild. A local card has no record on disk, so this
   * is the only place `run(key)` can resolve one for Open and Diff. */
  private readonly localRuns = new Map<string, Run>();
  private prFacts: boolean; // seeded from config in the constructor; re-seeded only by onConfigChanged
  private openAgents: boolean; // seeded from config in the constructor; re-seeded only by onConfigChanged
  private reviewQueue: boolean; // seeded from config in the constructor; re-seeded only by onConfigChanged
  private readonly prQueue = new RefreshQueue();
  /** The configured forge. One object, resolved once per panel: `agentFlow.forge`
   * is documented as needing a window reload, and a panel that swapped providers
   * mid-session would leave a half-GitHub, half-GitLab cache behind.
   *
   * Declared here but assigned in the constructor body, not as this field's own
   * initializer: `resolveForge` can call the `log` callback synchronously (an
   * unrecognised forge id falls back to GitHub and says so), and a class-field
   * initializer runs before the constructor's own parameter properties — `log`
   * among them — are assigned. The same hazard `lockIo`'s own comment names
   * below; assigning `forge` as the constructor's first statement instead
   * guarantees `this.log` already exists by the time it might be called. */
  private readonly forge: Forge;
  /** Branch-CI verdicts, keyed `repo#branch` by `branchCiKey`, with the moment each
   * was fetched.
   *
   * In memory and per panel, deliberately NOT the on-disk `PrEntry` cache: a
   * `PrEntry` is keyed by RUN, and a branch is not a property of any run — a flow
   * can wait on `master` with no card for it on the board at all. Nothing here is
   * worth surviving a window reload either. A verdict is only ever a few seconds
   * old (`POLL_MS`) and the honest cold-start answer is `"unknown"`, which is not
   * green, so a fresh panel simply waits one poll instead of trusting a stamp it
   * inherited.
   *
   * The TTL is `prFactsTtlSeconds`, the same setting the PR fetches age out on: it
   * is the same forge, the same rate limit, and the same "how fresh does a CI fact
   * need to be" question. The whole point of the cache is cost: ten rules naming
   * `main` share ONE entry and therefore one forge call per TTL, not ten per poll. */
  private readonly branchCi = new Map<string, { status: BranchCiStatus; fetchedAt: number }>();
  /** Repo names already reported as ambiguous, so `checkoutFor` says it once per
   * session rather than once per six-second poll. */
  private readonly branchCiAmbiguous = new Set<string>();
  private reviewSort: ReviewSort = "oldest";
  /** Last successful search. Held in memory as well as on disk so a failed fetch
   * can keep rendering it with a stale marker instead of emptying the strip. */
  private reviewCache: ReviewCache | null = null;
  private reviewStale = false;
  /** When the last search attempt was *made*, success or failure — distinct from
   * `reviewCache.fetchedAt`, which is when one last *succeeded*. A failed search
   * deliberately leaves `fetchedAt` alone (the strip's staleness display depends
   * on it), which on its own would make `isReviewCacheStale` re-arm every poll
   * tick forever once the forge CLI starts failing. This is in-memory only, on purpose: a
   * failed attempt should not survive a window reload and force one more wait. */
  private reviewLastAttemptAt: number | null = null;
  /** Ids with a `submitReview` in flight. `onMessage` dispatches fire-and-forget,
   * and the row is only evicted from `reviewCache` *after* a successful submit —
   * so without this, a second `deck:reviewSubmit` for the same id (a double
   * click; VS Code queues modals rather than dropping one) would clear every
   * gate during the up-to-10s forge call and could post the same review twice.
   * Neither shipped forge deduplicates one: GitHub keeps both reviews, and
   * GitLab's own path posts a second note. */
  private readonly reviewSubmitsInFlight = new Set<string>();
  private forgeProbe: Promise<ForgeGap | null> | null = null;
  /** undefined until the probe resolves; null means the forge is usable, and a
   * gap disables PR facts with a footer note. */
  private forgeGap: ForgeGap | null | undefined;
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
    // Resolved once, here, rather than as this field's own initializer — see
    // the `forge` field's own comment for why that ordering matters.
    this.forge = resolveForge(getConfig().forge, (m) => this.log(m));
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
    // The branch-CI verdicts this panel has fetched, so the drawer can say what a
    // `branch-ci-passed` rule is actually waiting on. Without them,
    // `observationOf` builds its context with no `branchCi` at all and every such
    // rule reads "not checked yet" forever — even while this panel knows the
    // branch is PENDING or FAILED, which is a rule whose state is invisible.
    //
    // Gated on `forgeReady()` exactly as `branchCiFor` is, and for its reason: a
    // verdict this panel would not ACT on must not be shown either, or the drawer
    // claims a branch is green while the engine reads it as unknown. Honest about
    // what the gate is worth: `onConfigChanged` already CLEARS the cache when PR
    // facts change, and `branchCiFor` never enqueues while the forge is unready,
    // so no test can distinguish this condition today — it is a mirror of the
    // serve-side rule kept beside it rather than a guard with its own reachable
    // case. Emptied with `flows` when the orchestrator is off, for the reason
    // `pendingResume` is.
    const branchCi: Record<string, BranchCiStatus> = {};
    if (enabled && this.forgeReady()) {
      for (const [key, entry] of this.branchCi) branchCi[key] = entry.status;
    }
    // Same reasoning as `promptModes`: configuration the drawer needs to build a
    // node with, which the webview cannot read for itself. Sent whole rather
    // than narrowed — see the `deck:flows` member's own comment in types.ts.
    this.post({
      type: "deck:flows", flows, enabled, pendingResume, promptModes,
      commands: cfg.commands, branchCi,
    });
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
        asks = await this.advanceUnderLock(runs, nowMs, token);
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
   * "what happens under the lock" is one function with no modal in it.
   *
   * `token` is the caller's lock token, threaded in so this function can RENEW the
   * lock after every spending step and stop when it no longer holds it. That is not
   * housekeeping: one pass loops over every armed flow, and one `run` edge can
   * legitimately take `COMMAND_TIMEOUT_MS` (120 s), so a pass with met command rules
   * in three flows outlives `LOCK_TTL_MS` (300 s). Another window then reaps the
   * lock, starts its own pass, sees the same edge still unstamped — this pass writes
   * its stamps only at the END — and runs the same command again. Renewing bounds
   * the hold to the longest SINGLE step instead of the whole pass, and aborting on a
   * failed renewal is what stops a pass that has already lost the lock from carrying
   * on spending under it. */
  private async advanceUnderLock(
    runs: RunStatus[],
    nowMs: number,
    token: string,
  ): Promise<{ flow: Flow; target: SpendTarget }[]> {
    const asks: { flow: Flow; target: SpendTarget }[] = [];
    /** Set the moment a renewal fails. Nothing further in this pass may act — but
     * whatever already ran still gets written below, because the act happened and
     * an unstamped success is what makes the NEXT pass repeat it. */
    let lostLock = false;
    const flows = readFlows(this.flowIo, this.flowsDir);
    // Read ONCE for the whole pass, before any flow is evaluated: two flows waiting
    // on the same branch must be answered by the same verdict, and a fetch per node
    // would be a forge call per rule.
    const branchCi = this.branchCiFor(flows, runs, nowMs);
    for (const flow of flows) {
      // Stop the whole pass, not just the flow that lost the lock — and this line is
      // LOAD-BEARING, not belt-and-braces. The guard at the top of the edge loop
      // below cannot cover a later flow, because that flow's SPEND GATE is checked
      // before the edge loop is ever reached: without this `break`, a later armed
      // flow with an unconfirmed spend still resolves its target, pushes an ask, and
      // — once the caller releases the lock — puts a consent MODAL in front of the
      // user and writes that flow's consent stamp, from a pass that had already
      // abandoned itself. Pinned by "does not ask the user for consent from a pass
      // that already lost the lock"; removing this line fails it with one call to
      // `showWarningMessage`. It is also the structural guarantee for everything
      // added to this loop later — a write, a promotion, a toast — none of which
      // should run under a lock this window no longer holds.
      if (lostLock) break;
      if (!flow.armed) {
        // A disarmed flow holds no gate — re-arming starts the cycle over.
        this.pendingResume.delete(flow.id);
        this.resumeCleared.delete(flow.id);
        continue;
      }
      try {
        const result = evaluateFlow({ flow, statuses: runs, nowMs, branchCi });
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
        //
        // TWO gates, not one — see `Flow.commandConfirmedAt`. A launch and a seed
        // share `launchConfirmedAt` (both open an agent session); a `run` has its
        // own, because consent to open a session is not consent to execute shell,
        // and every flow an existing user confirmed before commands existed carries
        // only the first. So the question is not "has this flow ever been confirmed"
        // but "is THIS spend confirmed", which is what `unconfirmedSpend` answers.
        const wantsSpend = this.unconfirmedSpend(fresh, firing);
        if (wantsSpend !== undefined) {
          // Recorded, not asked — the caller asks once the lock is released. Whatever
          // the answer, THIS pass performs nothing: an approval only lets the next pass
          // act, which keeps the acting path identical whether or not a question was
          // ever asked.
          //
          // One question per pass, even when a flow has an unconfirmed launch AND an
          // unconfirmed command: the second is asked on a later pass, once the first
          // is answered. A pass that asked performs nothing anyway, so nothing is
          // delayed by more than a poll — and two modals stacked from one pass would
          // be a worse way to meet a flow.
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
          // An earlier step in this pass lost the lock. EVERY remaining edge is left
          // exactly as it was — deferred, not stamped — and this check sits above the
          // spend filter deliberately, so it covers a `notify` too: stamping and
          // announcing one is still a WRITE to this flow's file, and doing that
          // without the lock is the read-then-write race the lock exists to close
          // (measured once as two identical toasts for one rule). Deferring rather
          // than stamping also matters for the spend edges: `applyFired` would write
          // `error: "run was not performed"` on a rule that never ran, latching it
          // out of existence.
          if (lostLock) {
            deferredTargets.add(f.edge.to);
            continue;
          }
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
          // Renewed AFTER the act, against the real clock rather than this pass's
          // `nowMs` — a stamp dated when the poll started would be no renewal at
          // all. `false` means another window reaped this lock while the step above
          // was running and may already be acting on the same flows, so this pass
          // stops spending immediately. It still records what it just did (below):
          // the command really ran, and leaving it unstamped is precisely what would
          // make the next pass run it again.
          if (!renew(this.lockIo, this.flowsDir, token, Date.now())) {
            this.log(
              `deck: flow ${flow.id} rule ${f.edge.id} was the last step of this pass — the flows lock was lost (reaped past its ${LOCK_TTL_MS} ms TTL); another window may be advancing now, so nothing further is performed`,
            );
            lostLock = true;
          }
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
        // `nowMs` — this pass's own clock, the same one `applyFired` stamped with a
        // line above: a promotion settles the rules that pointed at the node as
        // planned work, and those stamps belong to this pass, not to a later read.
        for (const p of promotions) next = promoteToPlace(next, p.nodeId, p.runKey, p.repo, nowMs);
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

  /** The command node a `run` edge points at, or `undefined` when it points at
   * anything else — the third of `plannedTarget`/`placeTarget`, resolved the same
   * way and reachable for the same one reason: the target's kind changed under this
   * pass, between the read `evaluateFlow` derived "run" from and the copy being
   * acted against. */
  private commandTarget(flow: Flow, edge: FlowEdge): CommandNode | undefined {
    const target = findNode(flow, edge.to);
    return target && isCommand(target) ? target : undefined;
  }

  /** What a `launch`, `seed` or `run` edge would actually spend on, resolved just
   * far enough to ask about it — never as far as reading a ticket or touching
   * disk. `undefined` means the edge cannot spend anything (wrong kind of
   * target, or a command that cannot be resolved to any text), so it must not
   * count toward the once-per-flow gate below.
   *
   * `action` is passed IN — the value `evaluateFlow` derived for this pass and
   * carried on the `FiredEdge` — rather than read off `edge.action` or re-derived
   * from `flow` here. Re-deriving is what would let this function answer a
   * different question than the dispatch below and the stamp in `applyFired`;
   * see the vintage note in `advanceUnderLock`. The TARGET is still resolved out
   * of `flow`, which is why a verb whose target has since changed kind resolves
   * to `undefined` and gates nothing.
   *
   * A `run` resolves through `resolveCommand` — the SAME function `performEdge`
   * runs the command with, so the text this gate shows cannot differ from the text
   * that executes. This is what makes `isSpendAction("run") === true` real:
   * without this arm a `run` edge falls out of `wantsSpend` below, the
   * once-per-flow ask never fires for a flow whose only acting rule is a command,
   * and the first shell command runs on the user's machine unattended with no
   * prompt ever having been shown — which `package.json`'s own `agentFlow.commands`
   * copy ("a flow asks before its FIRST command") already promises it does not. Do
   * not collapse this arm back into a `return undefined`.
   *
   * A command that will not resolve returns `undefined` for exactly the reason a
   * wrong-kinded target does: `performEdge` stamps such a rule as an error below
   * and runs nothing, so gating on it would ask the user to approve a rule that
   * can never do anything. `resolveCommand` is called with the edge's note so the
   * resolution decision here is the same one made there — a node whose `run` is
   * blank, or which names an unconfigured `commandId`, or which carries both,
   * refuses identically in both places. */
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
    if (action === "run") {
      const node = this.commandTarget(flow, edge);
      if (!node) return undefined;
      const resolved = resolveCommand(node, getConfig().commands, edge.note);
      if (!resolved.ok) return undefined;
      return { action: "run", node, text: resolved.text, label: resolved.label, note: edge.note };
    }
    const node = this.placeTarget(flow, edge);
    return node ? { action: "seed", node, mode: edge.mode, note: edge.note } : undefined;
  }

  /** Which stored approval authorises this target, or `undefined` when the user has
   * never given it. `run` reads `commandConfirmedAt`; `launch` and `seed` share
   * `launchConfirmedAt` — they spend the same way (an agent session opens) and the
   * modal for either says so. The ONE place this mapping lives: the gate check, the
   * write in `askFirstSpend`, and the "will still ask" clause in its wording all go
   * through it, so a fourth action cannot be added as "already confirmed" by
   * whichever of the three someone forgot. */
  private confirmedAt(flow: Flow, target: SpendTarget): number | undefined {
    return target.action === "run" ? flow.commandConfirmedAt : flow.launchConfirmedAt;
  }

  /** The first spend in this pass that the user has not yet approved FOR ITS OWN
   * GATE, or `undefined` when every spend the pass would attempt is already
   * covered. An edge that can spend nothing (`spendTarget` → `undefined`) is not a
   * spend at all and cannot gate: it is stamped as an error instead, so asking
   * about it would ask about a rule that can never run. */
  private unconfirmedSpend(flow: Flow, firing: { perform: boolean; edge: FlowEdge; action: FlowAction | undefined }[]): SpendTarget | undefined {
    return firing
      .filter((f) => f.perform)
      .map((f) => this.spendTarget(flow, f.edge, f.action))
      .find((t): t is SpendTarget => t !== undefined && this.confirmedAt(flow, t) === undefined);
  }

  /** Ask, once per flow, before it ever spends anything — naming what will actually
   * happen, because that is what the money is spent on: a launch names the ticket
   * and the repos it would open, a seed names the place (it has no ticket to name),
   * a run names the COMMAND TEXT. The first two name the prompt mode; a command has
   * none. Writes the answer (an approval, or a disarm) and nothing else; the pass
   * that asked never acts. Dismissing it writes nothing at all, so the flow stays
   * armed and is asked again later.
   *
   * Each answer approves ONE KIND of spend for this flow, not the flow as a whole:
   * `Launch`/`Seed` writes `launchConfirmedAt`, `Run` writes `commandConfirmedAt`
   * (see `confirmedAt`). So each branch's closing sentence has to say what it is
   * actually authorising, and — while it is still true — that the other kind will
   * be asked about separately. A flow with an approved launch and no command
   * approval is exactly the state every flow an existing user armed before commands
   * shipped is in, and telling that user "it will keep launching on its own" was
   * never consent to run `deploy.sh`. */
  private async askFirstSpend(flow: Flow, target: SpendTarget): Promise<void> {
    const cfg = getConfig();
    const ACT = target.action === "launch" ? "Launch" : target.action === "run" ? "Run" : "Seed";
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
    // What this answer does NOT authorise, stated only while it is still true: a
    // flow that has already confirmed the OTHER kind must not be promised a
    // question it will never be asked. Both halves read off `confirmedAt`, so the
    // sentence and the gate cannot drift apart.
    const alsoAsks = target.action === "run"
      ? (flow.launchConfirmedAt === undefined ? " It will still ask before it starts an agent session." : "")
      : (flow.commandConfirmedAt === undefined ? " It will still ask before it runs a shell command." : "");
    const message = target.action === "launch"
      ? (() => {
          const mode = cfg.promptModes.find((m) => m.id === target.node.mode);
          return `${flow.name} is ready to launch ${target.node.ticketKey} in ${target.node.repos.join(", ")} with the "${
            mode?.label ?? target.node.mode
          }" prompt${noteClause}, unattended. It will keep launching and seeding on its own from now on.${alsoAsks}`;
        })()
      : target.action === "run"
      ? // The resolved TEXT, not `target.label`: a configured command's label can
        // be anything ("Deploy"), and approving "Deploy" is not approving
        // `deploy.sh --env=prod`. Truncated through `commandPreview`, NOT
        // `notePreview` — see that function for why a command needs its tail kept.
        // No `noteClause`: the note is already inside `text` wherever the template
        // asked for it (see `SpendTarget`), so repeating it as its own clause would
        // suggest a second thing was about to be sent somewhere. No prompt mode
        // either — nothing here reads a prompt.
        `${flow.name} is ready to run "${commandPreview(target.text)}" on this machine, unattended. ` +
          `It will keep running commands on its own from now on.${alsoAsks}`
      : (() => {
          const mode = cfg.promptModes.find((m) => m.id === target.mode);
          return `${flow.name} is ready to seed another agent into ${target.node.repo} with the "${
            mode?.label ?? target.mode ?? "default"
          }" prompt${noteClause}, unattended. It will keep seeding and launching on its own from now on.${alsoAsks}`;
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
    // The approval lands on the gate this question was ASKED about, never on both:
    // writing `launchConfirmedAt` here for a command would silently authorise agent
    // sessions the user was never asked about, and vice versa.
    if (answer === ACT) {
      const stamp = target.action === "run"
        ? { commandConfirmedAt: Date.now() }
        : { launchConfirmedAt: Date.now() };
      writeFlow(this.flowIo, this.flowsDir, { ...latest, ...stamp });
    } else if (answer === DISARM) writeFlow(this.flowIo, this.flowsDir, { ...latest, armed: false });
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
   * perform one verb while the stamp claimed another.
   *
   * It is typed as a SPENDING verb, not `FlowAction | undefined`, because that is
   * all the dispatch above ever hands it (`isSpendAction`, now a type predicate,
   * is what narrows it there). This used to accept `undefined` and open with a
   * carefully worded refusal for it — an arm nothing could reach, whose comment
   * claimed to cover the unknown-target case. `applyFired` (runner.ts) is where
   * that case is actually decided, and it says that sentence now. */
  private async performEdge(
    flow: Flow,
    edge: FlowEdge,
    statuses: RunStatus[],
    action: Exclude<FlowAction, "notify">,
  ): Promise<EdgeResult> {
    if (action === "seed") return this.performSeed(flow, edge, statuses);
    if (action === "run") return this.performRun(flow, edge, statuses);
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
    // id lives on the EDGE — which both presentations' USING select writes through
    // `withMode` (orchestratorRule.ts), the canvas inspector's and the list row's
    // alike.
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

  /** Perform a `run` edge: execute a command node's command in a repo checkout.
   * This is the only place in the product that runs a shell command the user is
   * not watching, which is why nothing here guesses:
   *
   * - The command text comes from `resolveCommand` (via `runCommand`), which
   *   refuses a node that names both a configured command and free text, or
   *   neither, rather than picking one.
   * - The directory comes from `commandCwd` below, which refuses or defers rather
   *   than falling back to another checkout. `cd`-ing a deploy into the wrong
   *   worktree is not something a later pass can undo.
   * - The runner is `shellCommandRunner`, the only participant holding a process
   *   handle and therefore the only one that can honour `COMMAND_TIMEOUT_MS`.
   *
   * Both outcomes latch. A failed command is `error` with no `firedAt`, so it is
   * never retried until the user Resets it: a deploy that fails every poll is the
   * command-node version of "one bad rule becomes twenty windows", except each
   * retry is a real side effect on real infrastructure. `runCommand` never throws
   * by contract, so the only way out of here is a decided one. */
  private async performRun(flow: Flow, edge: FlowEdge, statuses: RunStatus[]): Promise<EdgeResult> {
    const node = this.commandTarget(flow, edge);
    if (!node) {
      return {
        kind: "done",
        outcome: { ok: false, error: `a run rule must point at a command, and ${edge.to} is not.` },
      };
    }
    const where = this.commandCwd(flow, edge, node, statuses);
    if ("defer" in where) return { kind: "defer", reason: where.defer };
    if ("refusal" in where) return where.refusal;
    // `this.log` is the Deck's output channel, and it is the ONLY place a
    // command's stdout/stderr ever lands: an unattended deploy that fails is not
    // diagnosable from a toast that says it exited 1.
    const outcome = await runCommand(
      { node, commands: getConfig().commands, note: edge.note, cwd: where.cwd },
      { run: shellCommandRunner, log: this.log },
    );
    if (!outcome.ok) {
      // Points at the channel only when there is actually something in it — a
      // refusal to resolve the command produced no output at all, and sending the
      // user to an empty log to diagnose it would be a small lie.
      const message = `${flow.name}: ${outcome.message}${
        outcome.output && outcome.output.length > 0 ? " The Agent Flow Deck output channel has the output." : ""
      }`;
      return {
        kind: "done",
        outcome: { ok: false, error: outcome.message },
        receipt: { level: "error", message },
      };
    }
    return {
      kind: "done",
      // Names the repo as well as the command: "ran deploy" in a flow touching
      // three checkouts does not say what happened. A command node is not a
      // place, so there is nothing to promote — the same as a seed.
      outcome: { ok: true, note: `ran ${outcome.label} in ${where.repo}` },
      receipt: { level: "success", message: `${flow.name}: ran ${outcome.label} in ${where.repo}.` },
    };
  }

  /** Which directory a command node's command runs in, and the repo name to call it
   * by. Three answers, and the difference between them is the whole safety story of
   * this task: a resolved `cwd`, a `refusal` that latches, or a `defer` that leaves
   * the rule pending for the next pass. There is deliberately no fourth answer that
   * picks some other checkout — running a deploy in the wrong one is not recoverable,
   * so anything unresolved must not run at all.
   *
   * `node.cwdRepo` wins when set, and is resolved against the SOURCE PLACE's run
   * first, falling back to the checkouts on this machine. Order matters: a place's
   * repo path is that run's WORKTREE (`/repos/aws-ops-ASM-12`), while `discoverRepos`
   * only knows the main checkout (`/repos/aws-ops`) — so for a repo that belongs to
   * the chain's own run, the run's copy is the one the user means.
   *
   * A named repo that resolves NOWHERE is a refusal, not a defer, and that is the
   * deliberate choice between the two: the name was typed by the user, it is
   * configuration rather than a snapshot, and it will not start existing on its own.
   * Latching surfaces it in the drawer with a Reset next to it — the same posture
   * `launchPlanned` takes for a planned node naming repos that aren't checked out.
   *
   * With no `cwdRepo`, the directory is inherited from the place the rule came from
   * (what `CommandNode.cwdRepo`'s own doc calls the common case) — and "came from"
   * means through a CHAIN of command nodes, not only directly: `chainSourcePlace`
   * (command.ts) walks back to the nearest place. `place -> deploy.sh -> smoke.sh`
   * ("deploy, then smoke test") is the feature's headline example, and
   * `command-succeeded` is the default and only condition a picker offers off a
   * command node, so it is the shape users are steered into. Before the walk, that
   * second command hit the "not a place" arm below and DEFERRED — every six
   * seconds, forever, stamping nothing, with no `error` and no `BlockedNote` for
   * this kind, while `spendTarget` still resolved and asked the user to approve a
   * command that could never run.
   *
   * WHICH of the two unresolved answers a failure gets is decided by where the
   * rule's source is, and the earlier version of this comment had the reasoning
   * backwards from Task 7 onwards:
   *  - A DIRECT place source keeps the DEFER. There the claim holds: `evaluateFlow`
   *    only fires such an edge when that place has a live status this pass, so a
   *    missing run means the graph changed under the pass, nothing was spent, and
   *    the next pass gets a clean read.
   *  - Everything else REFUSES. For a chained source nothing in this pass verified
   *    any run: `commandSucceeded` reads a receipt off the flow itself, so a
   *    retired run or a chain rooted in planned work is an ordinary durable fact,
   *    not a mid-pass race — and a defer for a durable fact is the invisible
   *    forever-loop above. The refusal names `cwdRepo`, which is what makes such a
   *    chain runnable, and latches so the drawer shows it with a Reset beside it. */
  private commandCwd(
    flow: Flow,
    edge: FlowEdge,
    node: CommandNode,
    statuses: RunStatus[],
  ): { cwd: string; repo: string } | { refusal: EdgeDone } | { defer: string } {
    const source = findNode(flow, edge.from);
    /** The rule's own source, when it IS a place — the only shape whose run this
     * pass has already proven live, and so the only one a defer is honest for. */
    const directPlace = source && isPlace(source) ? source : undefined;
    /** The place the working directory comes from: the source itself, or the
     * nearest one back through a chain of command nodes. */
    const fromPlace = directPlace ?? chainSourcePlace(flow, edge.from);
    // The source run's own repos, which for a worktree run are the worktree paths.
    const runRepos = fromPlace ? statuses.find((s) => s.run.key === fromPlace.runKey)?.run.repos ?? [] : [];
    // Blank or non-string counts as ABSENT, not as a name that resolves to nothing:
    // `config.ts`'s `readCommands` and `command.ts`'s `resolveCommand` both treat a
    // blank string as absent, and a hand-edited flow file can carry `"cwdRepo": ""`
    // or `42`. Refusing such a node outright would strand a rule whose author plainly
    // meant "wherever the rule came from".
    const named = typeof node.cwdRepo === "string" && node.cwdRepo.trim() !== "" ? node.cwdRepo : undefined;
    if (named !== undefined) {
      const inRun = runRepos.find((r) => r.name === named);
      if (inRun) return { cwd: inRun.path, repo: inRun.name };
      const cfg = getConfig();
      const onDisk = discoverRepos(cfg.reposRoot, cfg.repoBlocklist).find((r) => r.name === named);
      if (onDisk) return { cwd: onDisk.path, repo: onDisk.name };
      return {
        refusal: {
          kind: "done",
          outcome: {
            ok: false,
            error: `this command runs in "${named}", which isn't checked out on this machine — not running it somewhere else.`,
          },
        },
      };
    }
    if (!fromPlace) {
      // Nothing upstream is a place, and nothing will become one on its own: a
      // chain rooted in planned work, in a node kind this build does not know, or
      // in nothing at all. Deterministic, so it latches — and it names the one
      // thing that makes such a chain runnable rather than leaving the user to
      // guess (there is no control for it yet, so the flow file is named too).
      return {
        refusal: {
          kind: "done",
          outcome: {
            ok: false,
            error: `nothing upstream of ${edge.from} is a place, so the command at ${edge.to} has no checkout to run in — give the command node a working directory ("cwdRepo" in the flow file).`,
          },
        },
      };
    }
    const repo = runRepos.find((r) => r.name === fromPlace.repo);
    if (!repo) {
      // A DIRECT place source is the mid-pass race a defer is for; a chained one is
      // not — see this function's own doc comment on which answer belongs where.
      if (directPlace) {
        return {
          defer: `${fromPlace.repo} is not among run ${fromPlace.runKey}'s repos on this pass, so the command at ${edge.to} has no directory to run in`,
        };
      }
      return {
        refusal: {
          kind: "done",
          outcome: {
            ok: false,
            error: `the command at ${edge.to} runs where ${fromPlace.runKey} put "${fromPlace.repo}", and that run is not on the board — give the command node a working directory ("cwdRepo" in the flow file).`,
          },
        },
      };
    }
    return { cwd: repo.path, repo: repo.name };
  }

  private startPolling(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
    // The board-wide sweep exists ONLY to feed the header's token total, which is
    // off by default. With it off nothing on screen shows a board-wide figure, so
    // parsing every run's transcripts every minute would be pure cost — the
    // drawer reads its one run on demand instead (see `usageFor`). Read fresh
    // rather than cached in a field so flipping the setting takes effect on the
    // next visibility change without a reload.
    if (getConfig().showTokenTotal) {
      // One sweep now, then on its own slow cadence. Not awaited: a blank spend
      // figure for a few seconds is strictly better than a delayed board.
      void Promise.resolve().then(() => this.sweepUsage(this.sweepTargets()));
      this.usageTimer = setInterval(() => this.sweepUsage(this.sweepTargets()), USAGE_POLL_MS);
    }
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = undefined;
    this.prQueue.clear();
  }

  /**
   * Read one run's usage and post it back. The drawer's own request path, used
   * when the board-wide sweep is off — which is the default.
   *
   * `UsageReader` caches per file, so re-opening the same drawer costs a `stat`
   * per transcript rather than a re-parse. A run whose usage the eager sweep has
   * already computed still gets read here: the reader is incremental, so this is
   * the cheap path either way, and answering unconditionally keeps the drawer's
   * contract simple.
   *
   * Posts `usage: null` on a failed read rather than a zeroed total — the drawer
   * distinguishes "could not read" from "cost nothing", and zero would assert
   * the latter.
   */
  private usageFor(key: string): void {
    const run = this.run(key);
    if (!run) return;
    let usage: UsageTotals | null;
    try {
      usage = this.usage.readRun(claudeProjectsRoot(), run.repos.map((r) => r.path));
    } catch {
      usage = null;
    }
    if (usage) this.usageByRun.set(key, usage);
    this.post({ type: "deck:usage", key, usage });
  }

  /** Re-read usage for every run currently on the board. Board-scoped on
   * purpose: the full corpus is hundreds of files and hundreds of megabytes,
   * while a board is about ten project dirs. Never throws — a failed read
   * leaves the previous total in place. */
  private sweepUsage(runs: Run[]): void {
    const root = claudeProjectsRoot();
    const next = new Map<string, UsageTotals>();
    for (const run of runs) {
      try {
        next.set(run.key, this.usage.readRun(root, run.repos.map((r) => r.path)));
      } catch {
        const prev = this.usageByRun.get(run.key);
        if (prev) next.set(run.key, prev);
      }
    }
    this.usageByRun = next;
  }

  /** The runs the board shows: tracked records on disk plus the in-memory local
   * cards. Same filter as the status build — a review run has no agent and no
   * transcripts, so it has no spend to read. */
  private sweepTargets(): Run[] {
    return [
      ...readRuns(defaultRunsDir()).filter((r) => runKind(r) !== "review"),
      ...this.localRuns.values(),
    ];
  }

  /** Is the configured forge usable? Kicks the probe off on first call and
   * returns what we know so far — never awaited, because a 10s auth-status round
   * trip must not sit in front of a paint. An unresolved probe reads as "not
   * yet": queue nothing this tick. */
  private forgeReady(): boolean {
    if (!this.prFacts) return false;
    if (this.forgeProbe === null) {
      const p = (this.forgeProbe = this.forge.probe());
      void p.then((gap) => {
        // A probe orphaned by a settings change (onConfigChanged resets
        // forgeProbe and starts a fresh one when prFacts turns back on) must not
        // win if it resolves after the fresh probe already has — that would let
        // a stale gap clobber a fresh pass right after the user re-authenticated,
        // defeating the whole point of re-probing.
        if (this.forgeProbe !== p) return;
        this.forgeGap = gap;
        // The note names the kind; only the log can say which CLI we tried and
        // what it said, which is the difference between a diagnosable report and
        // "PR facts just don't work here".
        if (gap) this.log(`deck: ${this.forge.cli.name} unusable (${gap.kind}): ${gap.detail}`);
      });
    }
    return this.forgeGap === null;
  }

  /** Queue a stale repo's refresh. Deliberately not awaited by the caller: a
   * hanging forge call must never stall the git and transcript reads. The epoch is
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
        res = await this.forge.prs.fetch(repo.path, branch, searchKey);
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

  /** Every distinct branch these flows are waiting on, and the checkout to ask from.
   *
   * Keyed by `repo#branch`, so several rules — in one flow or across flows — naming
   * the same branch collapse to ONE entry and therefore one forge call. A disarmed
   * flow and a settled edge are skipped: neither is waiting on anything, and paying
   * a round trip for them would be pure cost.
   *
   * `cwd` is any board checkout of that repo, because the forge CLI resolves the
   * project from that directory's git remote — gh's `{owner}`/`{repo}` (see
   * `BRANCH_CI_QUERY`), glab's `:fullpath` — and every checkout of a repo —
   * worktrees included — shares that remote. A repo NO run on the board has is skipped
   * entirely: there is no directory to ask from, so its verdict stays absent, which
   * reads as `"unknown"`, which is not met. */
  private branchCiWanted(
    flows: Flow[],
    runs: RunStatus[],
  ): Map<string, { repo: string; branch: string; cwd: string }> {
    const out = new Map<string, { repo: string; branch: string; cwd: string }>();
    for (const flow of flows) {
      if (!flow.armed) continue;
      // Defensive about the SHAPE, not just the contents, because this scan runs
      // BEFORE the per-flow `try` in `advanceUnderLock`: a hand-edited or
      // half-migrated flow on disk can be armed with `edges: null` or an edge with
      // no `cond`, and one of those must cost that flow its own pass, not every
      // other flow's. `deckView.test.ts`'s "keeps advancing the other flows when
      // one throws while evaluating" pins exactly that, and caught this.
      for (const e of Array.isArray(flow.edges) ? flow.edges : []) {
        if (!e || e.cond?.kind !== "branch-ci-passed" || isSettled(e)) continue;
        const { repo, branch } = e.cond;
        // A hand-edited flow file can carry either half empty. The forge would
        // answer for the wrong thing (or error), so refuse before spending the call.
        if (!repo || !branch) continue;
        const key = branchCiKey(repo, branch);
        if (out.has(key)) continue;
        const cwd = this.checkoutFor(repo, runs);
        if (!cwd) continue;
        out.set(key, { repo, branch, cwd });
      }
    }
    return out;
  }

  /** The one checkout to ask the forge about `repo`, or null when the board cannot say
   * which repository that name even means.
   *
   * SEVERAL paths for one name is the norm here, not an ambiguity: every task
   * worktree Agent Flow creates is a separate checkout of the same repo
   * (`<repo>/.claude/worktrees/<KEY>`, see `createWorktrees`), carrying the repo's
   * name with the worktree's path, so a board with three tasks on `aws-ops` has
   * three `aws-ops` entries. All three share one remote, and the forge CLI reads
   * the project off that remote (see `BRANCH_CI_QUERY`), so any of them answers
   * the same question correctly. Refusing on "more than one path" would have made
   * this condition unusable in exactly the setup this product creates constantly.
   *
   * What IS ambiguous is two DIFFERENT repositories presenting the same name. A
   * local card's repo name is `path.basename` of whatever folder a session was found
   * in (`localRunFor`), so `~/work/api` and `~/repos/api` both come through as
   * `"api"` — and answering a deploy gate from the wrong remote (a fork's green
   * `main` opening the gate for upstream) is precisely the class of mistake this
   * condition's whole fail-closed posture exists to prevent.
   *
   * `repoRootOfWorktree` separates the two cases exactly, and for free: it unwinds a
   * worktree path to the checkout it was created from by looking at the layout alone
   * — pure string work, no `git` call — so two entries collapse to one root when they
   * are the same repository and stay two when they are not. Two roots means we do not
   * know which repository the user meant, so the verdict stays absent, which reads as
   * `"unknown"`, which is not met. Refusing to guess is the same choice every other
   * arm of this feature makes about a fact it cannot read.
   *
   * Deliberately strict in one direction: two independent clones of the SAME remote,
   * in folders that share a basename, also read as ambiguous, because telling them
   * apart needs the remote itself (`git remote get-url`, a spawn per candidate per
   * poll). Refusing is the safe half of that trade, and renaming one folder resolves
   * it. */
  private checkoutFor(repo: string, runs: RunStatus[]): string | null {
    const paths = runs.flatMap((s) => s.repos).filter((r) => r.name === repo).map((r) => r.path);
    if (paths.length === 0) return null;
    const roots = new Set(paths.map((p) => repoRootOfWorktree(p) ?? p));
    if (roots.size === 1) return paths[0];
    // Once per repo per session, not once per poll: this is a standing condition, and
    // a line every six seconds would bury the log it is trying to be found in. Said
    // at all because a rule that never fires looks like patience — this is the only
    // place that can name the real reason.
    if (!this.branchCiAmbiguous.has(repo)) {
      this.branchCiAmbiguous.add(repo);
      this.log(
        `deck: branch CI "${repo}" is ambiguous — ${roots.size} different repositories on the board carry that name ` +
          `(${[...roots].join(", ")}); rules naming it cannot be answered`,
      );
    }
    return null;
  }

  /** The branch-CI verdicts for this pass, and the refreshes the NEXT pass will
   * read.
   *
   * Synchronous on purpose — it returns what the cache already holds and only
   * ENQUEUES what has aged out, exactly as `enqueuePr` does. Awaiting a forge call
   * here would hold the flows-directory lock across the network for every window on
   * the machine, and a hung CLI would stall the pass; the cost of not awaiting is
   * that a brand-new rule reads `"unknown"` for one poll (six seconds) before its
   * first verdict lands. That trade only works because `"unknown"` is not green: the
   * cold-start answer delays a deploy, it never triggers one.
   *
   * `forgeReady()` gates BOTH the fetch and the read. Serving a cached verdict
   * after PR facts were switched off would leave a stamp from before the switch
   * gating a deploy with nothing left to ever refresh it — and it would make
   * `armability.ts`'s warning ("these rules need PR facts") a lie. Off means no
   * verdicts at all. */
  private branchCiFor(flows: Flow[], runs: RunStatus[], nowMs: number): Record<string, BranchCiStatus> {
    const wanted = this.branchCiWanted(flows, runs);
    // Nothing waiting on a branch: no config read, no queue traffic, and — for
    // every flow that has no such rule, which today is all of them — no cost.
    if (wanted.size === 0) return {};
    if (!this.forgeReady()) return {};
    const ttlMs = getConfig().prFactsTtlSeconds * 1000;
    const out: Record<string, BranchCiStatus> = {};
    for (const [key, want] of wanted) {
      const entry = this.branchCi.get(key);
      if (entry) out[key] = entry.status;
      // The PR path's own staleness rule, not a second copy of it — including
      // "a missing entry is stale", which is what makes the first pass fetch.
      if (isStale(entry, ttlMs, nowMs)) this.enqueueBranchCi(key, want);
    }
    return out;
  }

  /** Fetch one branch's rollup, out of band. Through `prQueue` like every other
   * forge call on this panel, so one in flight is never re-issued by the next
   * tick and a dozen branches cannot fork a dozen processes at once.
   *
   * Always stamps, even on failure: an unstamped entry reads as stale forever
   * and re-enqueues the same call every tick (the same trap `enqueuePr`'s own
   * catch exists for). `"unknown"`, rather than keeping the previous verdict
   * (which is what the PR cache does with `previous?.facts`), is what stops a
   * branch that was green an hour ago from opening a deploy gate on the strength
   * of a call that failed since.
   *
   * The `catch` is defense-in-depth for a THIRD-PARTY forge, not a claim about the
   * shipped two: both already normalize every failure (a non-zero exit, a timeout,
   * a rate limit, unparseable output) to `"unknown"` rather than throwing, exactly
   * as docs/FORGES.md requires. But `Forge` is a documented seam, the contract's
   * strength is identical to the one `enqueuePr` keeps its own catch under, and the
   * unguarded failure mode is strictly worse than a wrong verdict: the refresh
   * queue swallows the rejection, the entry stays unstamped, `isStale(undefined, …)`
   * is always true, and the panel re-enqueues the same spawn every tick forever
   * with nothing in the log. */
  private enqueueBranchCi(key: string, want: { repo: string; branch: string; cwd: string }): void {
    this.prQueue.push(`branch-ci:${key}`, async () => {
      let status: BranchCiStatus;
      try {
        status = await this.forge.branchCi(want.cwd, want.branch);
      } catch {
        status = "unknown";
      }
      // Logged, because "unknown" is invisible in the UI by design (a rule that
      // has not fired looks like patience) and this is the only place that can say
      // which branch could not be read.
      if (status === "unknown") this.log(`deck: branch CI ${key} unreadable`);
      this.branchCi.set(key, { status, fetchedAt: Date.now() });
    });
  }

  /** Is the review strip live? Two gates, not three: the session's own Review
   * queue flag (seeded from the persistent `reviewRequests` setting, then held
   * until `onConfigChanged` re-seeds it — re-reading config here would stomp
   * the flag on every poll tick), and `forgeReady()` — which already folds the
   * session PR-facts flag and a usable forge together, so there is no condition
   * here that varies independently of PR facts. */
  private reviewsEnabled(): boolean {
    return this.reviewQueue && this.forgeReady();
  }

  /** Queue a search when the cache has aged out. Never awaited — a hanging forge
   * call must not stall the board's git and transcript reads. The post that reflects
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
    // never advances `fetchedAt`, so the data clock alone would re-queue the
    // review search on every 6s poll tick forever once the CLI starts failing — rate
    // limited, network down, SSO expired. This clock tracks "how recently did we
    // try", independently of "how old is the data we are showing".
    if (this.reviewLastAttemptAt !== null && nowMs - this.reviewLastAttemptAt < ttlMs) return;
    this.prQueue.push("reviews", async () => {
      this.reviewLastAttemptAt = Date.now();
      let res: { issueCount: number; requests: ReviewRequest[] } | null;
      try {
        res = await this.forge.reviews.search();
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
      // The strip just went off (reviewRequests, PR facts, or the forge CLI going
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
    const detail = await this.forge.reviews.detail(req.repo, req.number);
    if (!detail) {
      this.log(`deck: review detail ${id} failed`);
      this.post({ type: "deck:reviewDetail", id, detail: null });
      return;
    }
    // A forge whose queue call carries no diff stats fills them here instead. Merged
    // into the cached request rather than posted separately, so the strip's existing
    // size chip renders it with no webview change at all.
    //
    // Re-found rather than reusing `req`, and NOT redundant: the `await` above is a
    // detail call on `prQueue`, which runs up to four jobs at once under distinct
    // keys — so a `"reviews"` search can complete mid-flight and replace
    // `this.reviewCache` wholesale. `req` would then belong to the discarded array
    // and the size would be written where nothing reads it. The size is still valid
    // for the fresh row: same repo, same number.
    if (detail.size) {
      const cached = this.reviewCache?.requests.find((r) => r.id === id);
      if (cached) Object.assign(cached, detail.size);
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
    // flipped, the forge CLI going unusable) without the row's own message queue draining
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
      // GitLab has no stable "request changes" verb, so ours is a note plus a
      // withdrawal of any standing approval. That is materially different from
      // GitHub's, and the person clicking deserves to know before they click.
      const detail =
        verb === "request-changes" && !this.forge.caps.changesRequested
          ? `${this.forge.label} has no "request changes" review, so this posts your message as a comment and withdraws your approval if you had one.`
          : undefined;
      const answer = await vscode.window.showWarningMessage(
        `${label} on ${req.repo}#${req.number}?`,
        { modal: true, detail },
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
      const res = await this.forge.reviews.submit(req.repo, req.number, verb, text);
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
    const projectsRoot = claudeProjectsRoot();
    const now = Date.now();
    const authed = await this.connector.isAuthenticated();
    const forgeReady = this.forgeReady();
    const liveWindows = readLiveWindows(defaultWindowsDir());
    const openIdentities = new Set(liveWindows.map((w) => w.identity));

    // Every Claude Code session open on this machine, grouped by the directory it
    // runs in. A place is claimed by at most one tracked run; Task 11 turns what
    // is left into cards of its own.
    // Read unconditionally: `openAgents` is a *display* toggle, but the retire
    // sweep must never mistake "not showing agents" for "no agent is running" —
    // that would retire a run with somebody actively working in it.
    const allPlaces = groupByPlace(readOpenSessions(defaultSessionsDir()));
    const places = this.openAgents ? allPlaces : new Map<string, OpenSession[]>();
    const livePlaces = new Set(allPlaces.keys());
    // Ownership is resolved from `allPlaces`, NOT `places`: `openAgents` is a
    // display toggle, and a run whose agents are merely hidden must not read as
    // a run with nobody working in it. The shelf rule below depends on this.
    const ownedRuns: OwnedRun[] = tracked.map((r) => ({
      key: r.key,
      createdAt: r.createdAt,
      paths: r.repos.map((repo) => canon(repo.path)),
    }));
    const ownership = resolveOwnership({ runs: ownedRuns, sessionsByPlace: allPlaces });
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
          // One session, one card. Several runs can hold the same in-place
          // checkout; only its owner renders it as an agent.
          if (ownership.sessionOwner.get(s.sessionId) !== run.key) continue;
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
    // has never heard of. Each surviving root gets exactly one currentBranch call,
    // right here — buildRunStatus's gitState reuses it (see status.ts) rather
    // than reading it a second time. gitState still spends three more git calls
    // per root (status, rev-list, diff --numstat) to render that root's chip —
    // every surviving root, tracked or local, live session or not, since the
    // chips show every root regardless of who is voting on the card.
    const cfg = getConfig();
    this.localRuns.clear();
    const locals: Run[] = [];
    // Local grouped run key -> the roots that actually have a live session right
    // now (F2). Read by the PR gates below and threaded into buildRunStatus's
    // `activityRoots`, so an idle sibling root's PR or transcript never votes on
    // a card it doesn't belong to. `.get` returning undefined for a tracked run
    // is exactly "no restriction" — every one of its repos still counts, unchanged.
    const localActiveRootsByKey = new Map<string, ReadonlySet<string>>();
    const unclaimed = [...places.keys()].filter((place) => !claimed.has(place));
    // A window holding two repos is one place to work, not two: fold its session
    // directories into a single card that names the workspace and carries both
    // roots. Anything a live multi-root window does not list — including a place
    // whose window predates presence roots — stays the per-place card it was.
    for (const group of groupPlacesByWindow(unclaimed, liveWindows)) {
      // groupPlacesByWindow hands back a window's FULL roots, raw folder paths —
      // it has no notion of git, and no notion of which of them a tracked run
      // already claimed. Normalize each root to the repo root that contains it
      // (so a nested folder like monorepo/packages/api compares equal to a
      // tracked run's own "monorepo" root, or to a sibling workspace's folder
      // naming the same repo) and dedupe the result; only THEN filter against
      // `claimed` — a claimed root's diff and dirty state already renders on
      // that tracked run's own card, and keeping it here too would double-count
      // it. What survives: a root nobody claimed, kept if it is a git repo (a
      // docs/ folder that names no repo of its own is dropped, along with the
      // four extra git calls and the chip that would have inflated "N repos")
      // OR it has a live session in it right now — a session running in a plain
      // directory is a legitimate card today, and dropping it would be a
      // regression, not a cleanup.
      const isGitByRoot = new Map<string, boolean>();
      for (const root of group.roots) {
        const rr = repoRoot(root);
        const norm = canon(rr || root);
        if (!isGitByRoot.has(norm)) isGitByRoot.set(norm, rr !== "");
      }
      const roots = [...isGitByRoot.keys()].filter((root) =>
        !claimed.has(root) && (isGitByRoot.get(root) || livePlaces.has(root)));
      // Every root here either belongs to a tracked run already, or named no
      // repo and had nobody working in it — a window whose only unclaimed
      // folder was a plain docs/ directory, for instance.
      if (roots.length === 0) continue;
      const liveGroup = { ...group, roots };
      const gitByRoot = new Map(roots.map((root) =>
        [root, { isGit: isGitByRoot.get(root) ?? false, branch: currentBranch(root) }] as const));
      const git = (root: string) => gitByRoot.get(root) ?? { isGit: false, branch: null };
      // The session's own root(s) get first say on the ticket (human ruling,
      // F1): a stale sibling repo — the other folder in last month's
      // .code-workspace, still on an old branch — must not out-vote the place
      // the person actually launched Claude Code in. `group.places` is already
      // in first-appearance order; whatever root is not one of them follows, in
      // `roots`' own order, so the whole candidate list stays deterministic.
      const placeSet = new Set(group.places);
      const candidates = [...group.places, ...roots.filter((r) => !placeSet.has(r))];
      const ticket = candidates
        .map((root) => inferTicket(git(root).branch, cfg.project, cfg.baseUrl))
        .find((t) => t !== null) ?? null;
      const sessions = group.places.flatMap((place) => places.get(place) ?? []);
      const run = localRunFor(liveGroup, sessions, git, ticket, now);
      this.localRuns.set(run.key, run);
      localActiveRootsByKey.set(run.key, placeSet);
      agentsByKey.set(
        run.key,
        group.places.flatMap((place) => (places.get(place) ?? []).map((s) => ({
          session: s,
          activity: readSessionActivity(projectsRoot, s.cwd, s.sessionId, now),
          // The root this session runs in — not repos[0], which on a workspace
          // card is a repo the session may never have touched.
          repo: run.repos.find((r) => r.path === place)?.name,
        }))),
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
      // A notepad run owns no pull request. Its repos are wherever the note was
      // launched from — routinely the window that was already open, on whatever
      // branch was already checked out — so a PR found on that branch belongs to
      // that branch's own work, not to a line you jotted into the notepad. This is
      // the defect `prEligible` fixed one level up, in the one shape a branch test
      // cannot catch: there the run sat on `master`, here it sits on a stranger's
      // feature branch, indistinguishable from ours. So a notepad run is treated as
      // structurally PR-less, exactly like a review run (see `sweepReviewRuns`) —
      // nothing is fetched for it, nothing already on disk is read back for it, and
      // its card renders no pr / ci / review row and never lands in Done off a
      // merge that was never its own.
      const prLess = runKind(run) === "notepad";
      const stored = this.prFacts && !prLess ? readPrEntries(defaultPrFactsDir(), run.key) : {};
      // A local grouped run's repos now include sibling roots the session never
      // touched (F2, human ruling): PR facts for a local card come only from
      // roots that have a live session, so a stranger's open or merged PR in an
      // idle sibling repo can neither render on this card nor vote it into Action
      // required or Done through prSignals. `activeRoots` is undefined for every
      // tracked run — `prRepos` then falls back to `run.repos`, every one of
      // which is genuinely this run's own, exactly as before this field existed.
      // Degrades correctly for a single-place local run: its one root IS its live
      // place, so the filter is a no-op there.
      const activeRoots = localActiveRootsByKey.get(run.key);
      const prRepos = activeRoots ? run.repos.filter((r) => activeRoots.has(canon(r.path))) : run.repos;
      // A repo on its default branch is filtered out here as well as below, so a
      // stale entry written before this rule existed stays inert on disk rather
      // than rendering as this run's pull request. This also drops entries for
      // repos that have left the run — re-taking a task with a different repo
      // selection can leave one behind. It is never re-staled (only repos in
      // prRepos are checked below), yet an orphan would still render as a
      // PrBlock and vote in prSignals, pinning a card in Needs you or out of
      // Done with Forget as the only escape.
      const prs: PrEntryMap = Object.fromEntries(
        prRepos.filter((r) => stored[r.name] && prEligible(r)).map((r) => [r.name, stored[r.name]]),
      );
      if (forgeReady && !prLess) {
        const ttlMs = getConfig().prFactsTtlSeconds * 1000;
        for (const repo of prRepos) {
          if (prEligible(repo) && isStale(prs[repo.name], ttlMs, now)) {
            this.enqueuePr(run.key, ticketKeyFor(run, this.connector), repo, repo.branch ?? null, prs[repo.name]);
          }
        }
      }
      const status = buildRunStatus({
        run, ticket, projectsRoot, nowMs: now,
        openIdentities, prs,
        agents: agentsByKey.get(run.key) ?? [],
        activityRoots: activeRoots,
      });
      // A local card has no record on disk — `removeRun` would be a no-op but
      // `writeRun` would *create* one, promoting a card the user never tracked.
      if (runKind(run) === "local") {
        // The webview has no connector of its own to parse run.url with, so the
        // inferred key crosses the wire pre-computed — through the same
        // connector and the same ticketKeyFor every other caller here uses,
        // rather than a second parser living in the webview.
        // A local card exists only because a session is open in it, so it is on
        // the board by construction.
        out.push(run.url
          ? { ...status, shelf: "board" as const, inferredTicketKey: ticketKeyFor(run, this.connector), usage: this.usageByRun.get(run.key) }
          : { ...status, shelf: "board" as const, usage: this.usageByRun.get(run.key) });
        continue;
      }
      // Which shelf this run sits on. `hasLiveSession` comes from `ownership`
      // rather than `status.agents`, because `agents` is gated on the openAgents
      // display toggle and a hidden agent is still an agent.
      // Computed before the sweep, not after: rule 2b reads the shelf off the
      // status it is handed, so the verdict has to see the shelved one.
      const ownsPath = (p: string) => ownership.pathOwner.get(canon(p)) === run.key;
      const shelf = getConfig().inflightShowAll ? "board" : shelfFor({
        hasLiveSession: ownership.runsWithSession.has(run.key),
        prOpen: Object.values(status.prs).some((e) => e.facts?.state === "OPEN"),
        merged: prSignals(status.prs).merged,
        ticketActive: isTicketRun(run) && status.ticketCategory !== "done",
        hasWorkToLose: status.repos.some((r) => ownsPath(r.path) && (r.dirty || r.ahead > 0)),
      });
      const shelved = { ...status, shelf, usage: this.usageByRun.get(run.key) };
      if (this.applyVerdict(run, this.verdictFor(shelved, livePlaces, now))) continue;
      // Counted, not cleared: this is exactly what Clear stale would take. The
      // second call is free of side effects — `verdictFor` is pure, and only
      // `applyVerdict` ever writes.
      if (this.verdictFor(shelved, livePlaces, now, true).action === "retire") stale++;
      out.push(shelved);
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
      case "stampClosed":
        writeRun(dir, { ...run, closedAt: v.closedAt });
        return false;
      case "unstampClosed": {
        const { closedAt: _dropped, ...rest } = run;
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
      // `inflightShowAll` already forces every shelf to "board" in buildAll, so
      // this is belt and braces — and it keeps the setting's promise ("nothing is
      // retired for being closed") true even if a caller hands over a stale status.
      shelf: cfg.inflightShowAll ? "board" : s.shelf,
      finishedAfterMs: overrideGates ? 0 : cfg.retireFinishedAfterHours * 3_600_000,
      abandonedAfterMs: overrideGates ? 1 : cfg.retireAbandonedAfterDays * 86_400_000,
      closedAfterMs: overrideGates ? 0 : cfg.retireClosedAfterHours * 3_600_000,
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
      // A review run never renders a card, so it has no shelf. "board" keeps
      // rule 2b inert and leaves rules 1, 2 and 3 to sweep it as they always have.
      shelf: "board",
      closedAfterMs: 0,
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
        // Wire field name kept as `ghNote` even though the text is now forge-aware:
        // it is a webview message key, and renaming it would need a matching
        // webview change for no user-visible gain.
        ghNote: this.prFacts && this.forgeGap ? FORGE_NOTES[this.forgeGap.kind](this.forge.cli.name) : null,
        // Read fresh on every post rather than cached in a field: it is a plain
        // string setting a user can edit mid-session, and the board re-posts often
        // enough that this is the whole of "keep it live".
        prReviewStatus: getConfig().prReviewStatus,
        // Same reasoning as prReviewStatus above: a plain setting the user can
        // flip mid-session, read fresh on every post.
        showTokenTotal: getConfig().showTokenTotal,
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
      // Dropped either way. Off: the verdicts must not outlive the source they came
      // from — `branchCiFor` already refuses to serve them, and forgetting them means
      // switching back on cannot re-serve a stamp from before the switch either. On:
      // a fresh start is the point, same as re-probing the forge below.
      this.branchCi.clear();
      this.branchCiAmbiguous.clear();
      // The user may have (re-)authenticated the forge's CLI since the last probe;
      // a stale gap would otherwise keep PR facts dark for the rest of the session.
      if (cfg.prFacts) {
        this.forgeGap = undefined;
        this.forgeProbe = null;
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
        // Routed through the same queue every other forge call uses (concurrency
        // capped at 4, deduped by key) — awaited directly here, expanding rows in
        // quick succession could fork an unbounded number of CLI processes, one
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
        // Retained alias: the review reason is exactly what this message meant.
        await this.seedPrWork(m.key, "review");
        break;
      case "deck:seedPrWork":
        await this.seedPrWork(m.key, m.reason, m.detail);
        break;
      case "deck:usageFor":
        this.usageFor(m.key);
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
          // The host owns five FLOW-level fields too, and a graph save has no
          // business carrying any of them. `armed` is written only by `flow:arm`
          // and `flow:resumeDisarm`: a save built from a `flow` prop captured
          // before a `deck:flows` post lands holds a stale value, so pressing
          // Disarm in the resume banner and then flushing a queued save would
          // RE-ARM the flow with the resume gate already cleared — armed, and free
          // to fire immediately. `name` belongs to `flow:rename`, and `createdAt`
          // is the sort key: neither is the drawer's to overwrite on a node drag.
          // `launchConfirmedAt` and `commandConfirmedAt` are written by
          // `askFirstSpend`'s answer, once per flow per KIND of spend — a stale save
          // dropping either would silently un-ask a question the user already
          // answered, and a save CARRYING one the host never recorded would
          // authorise a spend that was never approved in a modal.
          name: existing.name,
          armed: existing.armed,
          createdAt: existing.createdAt,
          launchConfirmedAt: existing.launchConfirmedAt,
          commandConfirmedAt: existing.commandConfirmedAt,
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
          // `forge: this.forge.caps` is what makes the "forge-unsupported" branch
          // reachable at all: with no `forge` passed, `armability` assumes a fully
          // capable one (GitHub, the default), so a `changes-requested` rule only
          // ever reads as unfirable here once the panel actually knows its forge
          // cannot report that.
          const dead = unfirableRules(flow, { liveSignal: true, prFacts: this.prFacts, forge: this.forge.caps });
          if (dead.length > 0) {
            const live = dead.filter((d) => d.needs === "live-signal").length;
            const pr = dead.filter((d) => d.needs === "pr-facts").length;
            const forge = dead.filter((d) => d.needs === "forge-unsupported").length;
            const offParts: string[] = [];
            if (pr > 0) offParts.push(`${pr} need${pr === 1 ? "s" : ""} PR facts`);
            if (live > 0) offParts.push(`${live} need${live === 1 ? "s" : ""} the Live signal`);
            const reasons: string[] = [];
            if (offParts.length > 0) {
              reasons.push(`${offParts.join(" and ")}, which ${offParts.length > 1 ? "are" : "is"} off`);
            }
            // Its own label is not this module's to name — that lives behind the
            // forge boundary — so this names the capability instead. Worded to read
            // naturally alongside the "needs PR facts"/"needs the Live signal"
            // siblings above, rather than as an em-dash aside.
            if (forge > 0) reasons.push(`${forge} rule${forge === 1 ? "'s" : "s'"} forge cannot report this`);
            this.post({
              type: "toast",
              level: "info",
              message: `${flow.name} armed — but ${reasons.join("; ")}, so ${
                dead.length === 1 ? "that rule" : "those rules"
              } can never fire.`,
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
          // The stamps are DELETED from a spread of the edge, not rebuilt from an
          // allow-list of the fields this build happens to know. The allow-list
          // shape read `{ id, from, to, cond, mode }`, and it silently dropped
          // `note` — the user's own configuration, exactly like `mode`, and for a
          // `run` rule the text spliced into the command at `{note}`. Reset on a
          // failed deploy carrying `note: "staging"` therefore rewrote the rule:
          // the next poll ran `deploy.sh --env=` — neither the command that
          // failed nor the one the modal named — under a `commandConfirmedAt`
          // that was already stamped, so with no second ask.
          //
          // `note` alone could have been added to the list, but the shape itself
          // is the defect: `coerceFlow` (store.ts) documents that unknown fields
          // must ride along untouched so a newer build's flow survives an older
          // build rewriting it, and an allow-list here is precisely a rewrite
          // that discards them for one edge. A deny-list keeps that tolerance.
          // The cost is the honest inverse of the old comment's claim: a future
          // HOST-owned stamp must be named below to be cleared. That is the
          // safer direction to forget in — a stamp left behind keeps a rule
          // settled and visibly resettable, where a dropped field silently
          // changes what an armed flow does.
          //
          // `action` is deliberately dropped too, which makes this the one
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
          // and `note` both survive: they are the user's own configuration, not a
          // mirror of anything, and a seed's mode has nowhere else to live.
          edges: flow.edges.map((e) => {
            if (e.id !== m.edgeId) return e;
            const kept: FlowEdge = { ...e };
            delete kept.firedAt;
            delete kept.firedNote;
            delete kept.performed;
            delete kept.error;
            delete kept.action;
            return kept;
          }),
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
      case "flow:saveCommand": {
        if (!getConfig().orchestrator) return;
        await this.saveCommand(m.run, m.label);
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
   * Append one free-text command to `agentFlow.commands` under the name the user
   * typed in the drawer, so the next node can pick it instead of retyping it.
   *
   * Three deliberate decisions:
   *
   * 1. It appends to the array EXACTLY as authored (`inspect`, via `pickExplicit`),
   *    and writes back to the scope that already holds it — never promoting a
   *    workspace override to global, the same rule `modesNotice`'s hide-write
   *    follows. An untouched setting seeds from `DEFAULT_COMMANDS` rather than from
   *    `[]`, because an explicit array REPLACES the default: writing `[mine]` would
   *    silently drop the shipped example out of the picker the user is looking at.
   *    So the invariant is "the list gains an entry", never "the list is replaced".
   *
   * 2. The NODE is left alone. Rewriting it from `{ run }` to `{ commandId }` would
   *    be a second write, on a different store, from one gesture — and
   *    `resolveCommand` refuses a node carrying both, so a half-applied pair is an
   *    errored rule. Saving means "keep this for next time", and the drawer says so
   *    by showing the node as already saved rather than by changing what it is.
   *
   * 3. Nothing about the command reaches telemetry. A `run` string carries
   *    hostnames, paths and sometimes tokens; only `commands_count` is ever
   *    emitted, and `settingsSnapshot` already derives that on its own.
   */
  private async saveCommand(run: string, label: string): Promise<void> {
    const c = vscode.workspace.getConfiguration("agentFlow");
    const explicit = pickExplicit<unknown>(c.inspect<unknown>("commands"));
    // A non-array value under the key (a hand-edited file can hold anything) is
    // not something to append to — but its SCOPE is still where the user's
    // configuration lives, so the replacement lands there rather than in global.
    const authored = explicit && Array.isArray(explicit.value) ? (explicit.value as unknown[]) : undefined;
    const entries = authored ?? [...DEFAULT_COMMANDS];
    const target = explicit?.target ?? vscode.ConfigurationTarget.Global;

    const outcome = withSavedCommand(entries, run, label);
    if (outcome.kind === "invalid") {
      // Unreachable from the drawer, which disables Save without both halves. Kept
      // because this is a message handler: the webview is not the only thing that
      // could ever post one, and a blank id in settings is a command that can
      // never be picked.
      this.post({ type: "toast", level: "info", message: "A saved command needs a name and something to run." });
      return;
    }
    if (outcome.kind === "duplicate") {
      this.post({
        type: "toast",
        level: "info",
        message: `Already saved as “${outcome.duplicateLabel}” — pick it from the command list.`,
      });
      return;
    }
    try {
      await c.update("commands", outcome.entries, target);
    } catch (e) {
      // A settings write can genuinely fail (a read-only settings.json, a
      // Workspace target with no workspace open). Say so: the alternative is a
      // drawer that looks like it saved and a picker that never gains the entry.
      this.post({ type: "toast", level: "error", message: `Couldn't save the command: ${e}` });
      return;
    }
    // The config-change listener re-posts flows on its own, but not synchronously
    // and not from every scope in every host build — posting here means the picker
    // holds the new entry by the time the toast is read.
    this.postFlows();
    this.post({
      type: "toast",
      level: "info",
      message: `Saved “${outcome.command.label}” to agentFlow.commands.`,
    });
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

  /**
   * Which of a run's repos to diff. One repo — because the run has one, or because
   * the card acts on one — is its own answer and asks nothing.
   *
   * Beyond that the multi-diff editor is the wrong place to find out: it lists
   * files flat, so a task spanning repos gives no reliable sign of whose file is
   * on screen. Asking first buys a title that names the answer.
   *
   * `undefined` means dismissed, which is distinct from "no repos".
   */
  private async reposToDiff(run: Run, repoName?: string): Promise<ServiceRef[] | undefined> {
    const scoped = repoName ? run.repos.filter((r) => r.name === repoName) : run.repos;
    if (scoped.length <= 1) return scoped;
    const all = { label: "All repos", detail: workspaceLabel(run.workspaceFile) ?? `${scoped.length} repos`, repos: scoped };
    const picked = await vscode.window.showQuickPick(
      [all, ...scoped.map((r) => ({ label: r.name, detail: r.path, repos: [r] }))],
      { title: `Diff ${run.key} — which repo?`, placeHolder: "Pick a repo to diff", ignoreFocusOut: true },
    );
    return picked?.repos;
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
    const repos = await this.reposToDiff(run, repoName);
    if (!repos) return; // picker dismissed — the same silent refusal as elsewhere
    const outcome = await openTaskDiff(diffTitle(run.key, repos, run.workspaceFile), repos);
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
      // Keyed on what is actually being shown, not on what the run spans: with one
      // repo picked, a header above the only patch there is names nothing useful.
      if (d.trim()) chunks.push(repos.length > 1 ? `# ${r.name}\n${d}` : d);
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
  private async seedPrWork(key: string, reason: PrWorkReason, detail?: string): Promise<void> {
    const run = this.run(key);
    if (!run) {
      this.toast("error", `No run record for ${key}.`);
      return;
    }
    // The webview only ever sends this for a card gated on the review column's
    // waiting lane (with an open PR behind it) && kind !== "local" — but
    // `this.run(key)` falls back to the in-memory
    // localRuns map, so a hand-crafted deck:addressPr naming a local key would
    // still resolve one. A local card's ticket is inferred from a branch name;
    // seeding a PR-review agent against that inference on one click is exactly
    // what this feature must never do. The other two guards below (no record,
    // nothing to open) are enforced host-side rather than trusted to the
    // webview, so this one is too — unreachable today, but cheap insurance
    // against a future caller that isn't as careful.
    if (runKind(run) === "local") {
      this.log(`deck: seedPrWork ignored for local card ${key}`);
      return;
    }
    const cfg = getConfig();
    const clause = prWorkClause(reason, detail);
    // The user's configured review prompt, preceded by what is actually wrong.
    // An empty clause (reason "review") leaves the template byte-identical to
    // what Address PR has always sent.
    const template = clause
      ? `${clause}\n\n${prReviewTemplate(cfg.prReviewPrompt, cfg.prReviewAutoFix)}`
      : prReviewTemplate(cfg.prReviewPrompt, cfg.prReviewAutoFix);
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
