import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getConfig } from "./config";
import { JiraAuth } from "./jira/auth";
import { JiraClient, JiraAuthError } from "./jira/client";
import { readRuns, defaultRunsDir, removeRun, writeRun } from "./engine/runs";
import { buildRunStatus } from "./engine/status";
import { readLiveWindows, defaultWindowsDir } from "./engine/presence";
import { agentPrompt, openInEditor, openWorkspace, writePlanFile, BRIEF_DIR } from "./engine/workspace";
import { createWorktrees } from "./engine/worktree";
import { currentBranch, prEligible, repoRoot, taskDiff } from "./engine/git";
import { defaultPrFactsDir, isStale, readPrEntries, removePrEntries, writePrEntry } from "./engine/pr/store";
import { FetchResult, GhGap, GhProvider, PrProvider, probeGh } from "./engine/pr/provider";
import { RefreshQueue } from "./engine/pr/queue";
import { discoverRepos } from "./engine/repos";
import { prReviewTemplate } from "./engine/prompt";
import { launchReview, resolveReviewMode, reviewRunKey } from "./engine/review/launch";
import { GhReviewProvider, ReviewProvider } from "./engine/review/provider";
import { ReviewCache, defaultReviewsFile, isReviewCacheStale, readReviewCache, writeReviewCache } from "./engine/review/store";
import { sortRequests } from "./engine/review/sort";
import { inferTicket, localRunFor } from "./engine/localRuns";
import { defaultSessionsDir, groupByPlace, readOpenSessions } from "./engine/sessions";
import { readSessionActivity, UNKNOWN_ACTIVITY } from "./engine/transcript";
import { canon } from "./engine/paths";
import { CardAgent, InboundMessage, OpenSession, OutboundMessage, PrEntry, PrEntryMap, ReviewRequest, ReviewSort, ReviewVerb, Run, RunStatus, isTicketRun, runKind, ticketKeyFor } from "./types";

const POLL_MS = 6000;
const JIRA_TTL_MS = 30_000;

/** The footer note per reason PR facts are off. Naming the actual gap matters:
 * `gh` living somewhere the extension host's PATH cannot see it is by far the
 * likeliest cause, and reads to a signed-in user as the Deck being broken. */
const GH_NOTES: Record<GhGap["kind"], string> = {
  missing: "gh CLI not found — PR facts off. Run Doctor",
  "signed-out": "gh is not signed in — PR facts off. Run Doctor",
};

/** Appended to a review body the agent drafted, when provenance stamping is on.
 * Posting an agent's words as unmarked human review is the kind of thing worth
 * being straight about with teammates. */
export const REVIEW_PROVENANCE = "_Drafted with Claude Code via Agent Flow Deck._";

const VERB_LABEL: Record<ReviewVerb, string> = {
  approve: "Approve",
  comment: "Comment",
  "request-changes": "Request changes",
};

/** The Deck: a full-window board of every task launched via Agent Flow Deck, opened as a
 * singleton editor-area panel. Reuses the Jira client, runs store, and status engine. */
export class DeckPanel {
  private static current: DeckPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private liveSignal = true;
  private readonly jiraCache = new Map<string, { at: number; status: string | null; category: string | null }>();
  /** The last refresh's synthetic runs for places no tracked run claimed — cleared
   * and repopulated on every rebuild. A local card has no record on disk, so this
   * is the only place `run(key)` can resolve one for Open and Diff. */
  private readonly localRuns = new Map<string, Run>();
  private prFacts: boolean; // seeded from config in the constructor; the only writer after that is deck:setPrFacts
  private openAgents: boolean; // seeded from config in the constructor; the only writer after that is deck:setOpenAgents
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
  /** Bumped when a refresh starts, so an older pass that finishes after a newer one
   * began does not post. Its snapshot predates whatever the newer pass read: a poll
   * that listed the runs directory before `deck:forget` removed a file would
   * otherwise put the forgotten card straight back on the board. */
  private refreshSeq = 0;
  /** How many refreshes are in flight. Only the last one out clears the webview's
   * busy indicator — an inner `finally` must not stop the spinner while an
   * overlapping refresh is still working. */
  private busyDepth = 0;

  static show(context: vscode.ExtensionContext, auth: JiraAuth, log: (m: string) => void): void {
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
    DeckPanel.current = new DeckPanel(panel, context, auth, log);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly auth: JiraAuth,
    private readonly log: (m: string) => void,
  ) {
    this.panel = panel;
    // Seed from the persisted setting; after this, only the webview's
    // deck:setPrFacts toggle changes it — a later refresh must not stomp the
    // user's in-session toggle by re-reading config on every tick.
    this.prFacts = getConfig().prFacts;
    this.openAgents = getConfig().openAgents;
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((m: InboundMessage) => this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState(
      () => (this.panel.visible ? this.startPolling() : this.stopPolling()),
      null,
      this.disposables,
    );
    this.startPolling();
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

  private client(): JiraClient {
    const cfg = getConfig();
    return new JiraClient(cfg.baseUrl, cfg.project, this.auth);
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
        // A probe orphaned by a toggle (deck:setPrFacts resets ghProbe and starts
        // a fresh one) must not win if it resolves after the fresh probe already
        // has — that would let a stale gap clobber a fresh pass right after the
        // user ran `gh auth login`, defeating the whole point of re-probing.
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

  /** Is the review strip live? Two gates, not three: the persistent
   * `reviewRequests` setting, and `ghReady()` — which already folds the session
   * PR-facts toggle and a usable gh together, so there is no condition here
   * that varies independently of PR facts. */
  private reviewsEnabled(): boolean {
    return getConfig().reviewRequests && this.ghReady();
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

  private postReviews(): void {
    if (!this.reviewsEnabled()) {
      // The strip just went off (reviewRequests, PR facts, or gh going
      // unusable) — actively say so, rather than merely staying silent. Silence
      // here used to leave the webview's last posted rows on screen exactly as
      // they were: frozen, but with their write buttons still live, so a click
      // could still reach the provider from a strip the user believed they had
      // just switched off. `enabled: false` also lets the webview drop the "To
      // review" stat tile instead of showing a hollow "0 To review".
      this.post({
        type: "deck:reviews", requests: [], issueCount: 0, sort: this.reviewSort,
        stale: false, reviewWrites: getConfig().reviewWrites, enabled: false,
      });
      return;
    }
    if (!this.reviewCache) return;
    this.post({
      type: "deck:reviews",
      requests: sortRequests(this.decorateReviews(this.reviewCache.requests), this.reviewSort),
      issueCount: this.reviewCache.issueCount,
      sort: this.reviewSort,
      stale: this.reviewStale,
      reviewWrites: getConfig().reviewWrites,
      enabled: true,
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
      `Reviewing ${req.repoName}#${req.number} in a worktree.${cfg.seedAgent ? " Claude Code pre-seeded — press Enter to start." : ""}`,
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
        ? `${body.trim()}\n\n${REVIEW_PROVENANCE}`
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

  private async jiraStatus(key: string): Promise<{ status: string | null; category: string | null } | null> {
    const hit = this.jiraCache.get(key);
    if (hit && Date.now() - hit.at < JIRA_TTL_MS) return { status: hit.status, category: hit.category };
    try {
      const s = await this.client().getStatus(key);
      this.jiraCache.set(key, { at: Date.now(), ...s });
      return s;
    } catch (e) {
      if (e instanceof JiraAuthError) return null; // git backbone still renders
      this.log(`deck: jira status ${key} failed: ${e}`);
      return hit ? { status: hit.status, category: hit.category } : null;
    }
  }

  private async buildAll(): Promise<RunStatus[]> {
    // Review runs are work in flight, but not *your ticket's* work: they surface
    // on their strip row, not as a fifth kind of card in In progress.
    const tracked = readRuns(defaultRunsDir()).filter((r) => runKind(r) !== "review");
    const projectsRoot = path.join(os.homedir(), ".claude", "projects");
    const now = Date.now();
    const authed = await this.auth.isAuthenticated();
    const ghReady = this.ghReady();
    const openIdentities = new Set(readLiveWindows(defaultWindowsDir()).map((w) => w.identity));

    // Every Claude Code session open on this machine, grouped by the directory it
    // runs in. A place is claimed by at most one tracked run; Task 11 turns what
    // is left into cards of its own.
    const places = this.openAgents
      ? groupByPlace(readOpenSessions(defaultSessionsDir()))
      : new Map<string, OpenSession[]>();
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
            activity: this.liveSignal ? readSessionActivity(projectsRoot, s.cwd, s.sessionId, now) : UNKNOWN_ACTIVITY,
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
          activity: this.liveSignal ? readSessionActivity(projectsRoot, s.cwd, s.sessionId, now) : UNKNOWN_ACTIVITY,
        })),
      );
      locals.push(run);
    }
    const all = [...tracked, ...locals];
    // One round trip per run, all at once. Serially this was the bulk of a cold
    // refresh, and back then every Forget waited on the whole pass before its card
    // left the board — the webview now drops that card optimistically, but the pass
    // is still what the board's next authoritative state waits on. jiraStatus owns
    // its own errors, so this can never reject; run keys are unique, so concurrent
    // calls never duplicate a cache miss.
    // ticketKeyFor, not run.key: a run saved under its place-hash (Track it, when
    // the inferred key already belonged to another run) carries its ticket only
    // in its url — polling run.key there would 404 forever, every tick.
    const jiras = await Promise.all(
      all.map((run) => (authed && isTicketRun(run) ? this.jiraStatus(ticketKeyFor(run)) : null)),
    );
    const out: RunStatus[] = [];
    for (const [i, run] of all.entries()) {
      const jira = jiras[i];
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
            this.enqueuePr(run.key, ticketKeyFor(run), repo, repo.branch ?? null, prs[repo.name]);
          }
        }
      }
      out.push(buildRunStatus({
        run, jira, projectsRoot, nowMs: now,
        liveSignal: this.liveSignal, openIdentities, prs,
        agents: agentsByKey.get(run.key) ?? [],
      }));
    }
    return out;
  }

  private async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    try {
      const runs = await this.buildAll();
      if (seq !== this.refreshSeq) return; // a newer pass owns the board
      this.post({
        type: "deck:runs",
        runs,
        liveSignal: this.liveSignal,
        prFacts: this.prFacts,
        openAgents: this.openAgents,
        ghNote: this.prFacts && this.ghGap ? GH_NOTES[this.ghGap.kind] : null,
      });
      // The disabled branch posts its own "cleared" state directly — enqueueReviews
      // only ever posts once a search settles or is already fresh, neither of
      // which happens while the strip is off.
      if (this.reviewsEnabled()) this.enqueueReviews(Date.now());
      else this.postReviews();
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

  private async onMessage(m: InboundMessage): Promise<void> {
    switch (m.type) {
      case "deck:ready":
      case "deck:refresh":
        await this.refreshBusy();
        break;
      case "deck:setLive":
        this.liveSignal = m.on;
        await this.refreshBusy();
        break;
      case "deck:setPrFacts":
        this.prFacts = m.on;
        if (m.on) {
          // Re-probe: the user may have run `gh auth login` since the last check.
          this.ghGap = undefined;
          this.ghProbe = null;
        }
        await this.refreshBusy();
        break;
      case "deck:setOpenAgents":
        this.openAgents = m.on;
        await this.refreshBusy();
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
    const inferredKey = local.url ? ticketKeyFor(local) : "";
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
    // diff — everything this task changed, committed work included, as a read-only
    // diff document.
    const repos = repoName ? run.repos.filter((r) => r.name === repoName) : run.repos;
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
    const cfg = getConfig();
    const template = prReviewTemplate(cfg.prReviewPrompt, cfg.prReviewAutoFix);
    const ticket = { key: run.key, summary: run.summary, url: run.url };
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
      writePlanFile({ key: run.key, createdAt: Date.now(), seedAgent: true, matches });
    }
    for (const m of matches) {
      if (!(await openInEditor(m.matchPath))) this.toast("error", `Couldn't open ${key}.`);
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
