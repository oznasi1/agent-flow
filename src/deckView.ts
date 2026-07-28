import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { getConfig } from "./config";
import { JiraAuth } from "./jira/auth";
import { JiraClient, JiraAuthError } from "./jira/client";
import { readRuns, defaultRunsDir, removeRun } from "./engine/runs";
import { buildRunStatus } from "./engine/status";
import { readLiveWindows, defaultWindowsDir } from "./engine/presence";
import { openInEditor } from "./engine/workspace";
import { taskDiff } from "./engine/git";
import { defaultPrFactsDir, isStale, readPrEntries, removePrEntries, writePrEntry } from "./engine/pr/store";
import { FetchResult, GhGap, GhProvider, PrProvider, probeGh } from "./engine/pr/provider";
import { RefreshQueue } from "./engine/pr/queue";
import { discoverRepos } from "./engine/repos";
import { GhReviewProvider, ReviewProvider } from "./engine/review/provider";
import { ReviewCache, defaultReviewsFile, isReviewCacheStale, readReviewCache, writeReviewCache } from "./engine/review/store";
import { sortRequests } from "./engine/review/sort";
import { InboundMessage, OutboundMessage, PrEntry, PrEntryMap, ReviewRequest, ReviewSort, Run, RunStatus, isTicketRun } from "./types";

const POLL_MS = 6000;
const JIRA_TTL_MS = 30_000;

/** The footer note per reason PR facts are off. Naming the actual gap matters:
 * `gh` living somewhere the extension host's PATH cannot see it is by far the
 * likeliest cause, and reads to a signed-in user as the Deck being broken. */
const GH_NOTES: Record<GhGap["kind"], string> = {
  missing: "gh CLI not found — PR facts off. Run Agent Flow: Doctor",
  "signed-out": "gh is not signed in — PR facts off. Run Agent Flow: Doctor",
};

/** The Deck: a full-window board of every task launched via Agent Flow, opened as a
 * singleton editor-area panel. Reuses the Jira client, runs store, and status engine. */
export class DeckPanel {
  private static current: DeckPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private liveSignal = true;
  private readonly jiraCache = new Map<string, { at: number; status: string | null; category: string | null }>();
  private prFacts: boolean; // seeded from config in the constructor; the only writer after that is deck:setPrFacts
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
      "Agent Flow — In-flight",
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
    void this.panel.webview.postMessage(msg);
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
   * cache file `deck:forget` just deleted. */
  private enqueuePr(key: string, repo: { name: string; path: string }, branch: string | null, previous?: PrEntry): void {
    const epoch = this.prEpoch.get(key) ?? 0;
    this.prQueue.push(repo.path, async () => {
      let res: FetchResult;
      try {
        res = await this.pr.fetch(repo.path, branch, key);
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

  /** Is the review strip live? Three independent conditions: the persistent
   * setting, the session PR-facts toggle (same gh dependency, so the same
   * switch), and a usable gh. */
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
   * every post: a checkout can appear, and a worktree can be forgotten. */
  private decorateReviews(requests: ReviewRequest[]): ReviewRequest[] {
    const cfg = getConfig();
    const byName = new Map(discoverRepos(cfg.reposRoot, cfg.repoBlocklist).map((r) => [r.name, r]));
    return requests.map((r) => {
      const local = byName.get(r.repoName);
      return { ...r, localPath: local?.isGit ? local.path : null };
    });
  }

  private postReviews(): void {
    if (!this.reviewsEnabled() || !this.reviewCache) return;
    this.post({
      type: "deck:reviews",
      requests: sortRequests(this.decorateReviews(this.reviewCache.requests), this.reviewSort),
      issueCount: this.reviewCache.issueCount,
      sort: this.reviewSort,
      stale: this.reviewStale,
    });
  }

  /** Fetch the two facts the search cannot return. Silent on failure: the row
   * keeps its search-level detail, which is still useful, and a toast per
   * expanded row would be worse than the gap. */
  private async reviewDetail(id: string): Promise<void> {
    const req = this.reviewCache?.requests.find((r) => r.id === id);
    if (!req) return;
    const detail = await this.reviewProvider.detail(req.repo, req.number);
    if (!detail) {
      this.log(`deck: review detail ${id} failed`);
      return;
    }
    this.post({ type: "deck:reviewDetail", id, detail });
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
    const runs = readRuns(defaultRunsDir());
    const projectsRoot = path.join(os.homedir(), ".claude", "projects");
    const now = Date.now();
    const authed = await this.auth.isAuthenticated();
    const ghReady = this.ghReady();
    const openIdentities = new Set(readLiveWindows(defaultWindowsDir()).map((w) => w.identity));
    // One round trip per run, all at once. Serially this was the bulk of a cold
    // refresh, and back then every Forget waited on the whole pass before its card
    // left the board — the webview now drops that card optimistically, but the pass
    // is still what the board's next authoritative state waits on. jiraStatus owns
    // its own errors, so this can never reject; run keys are unique, so concurrent
    // calls never duplicate a cache miss.
    const jiras = await Promise.all(
      runs.map((run) => (authed && isTicketRun(run) ? this.jiraStatus(run.key) : null)),
    );
    const out: RunStatus[] = [];
    for (const [i, run] of runs.entries()) {
      // A session with no ticket has nothing to look up. Its key is synthetic, so
      // every Jira call 404s; and it has no branch we named, so `gh pr list
      // --head <default-branch>` matches whatever PR was last opened *from* that
      // branch — somebody else's, rendered on this card as if it were the task's.
      const tracked = isTicketRun(run);
      const jira = jiras[i];
      const stored = this.prFacts && tracked ? readPrEntries(defaultPrFactsDir(), run.key) : {};
      // Drop entries for repos that have left the run — re-taking a task with a
      // different repo selection can leave one behind. It is never re-staled
      // (only repos in run.repos are checked below), yet an orphan would still
      // render as a PrBlock and vote in prSignals, pinning a card in Needs you
      // or out of Done with Forget as the only escape.
      const prs: PrEntryMap = Object.fromEntries(
        run.repos.filter((r) => stored[r.name]).map((r) => [r.name, stored[r.name]]),
      );
      if (ghReady && tracked) {
        const ttlMs = getConfig().prFactsTtlSeconds * 1000;
        for (const repo of run.repos) {
          // A non-git service (worktree.ts can hand one through unchanged) has no
          // PR to fetch — `gh pr list` would just fail there forever, re-arming
          // every TTL and burning a queue slot each cycle.
          if (repo.isGit && isStale(prs[repo.name], ttlMs, now)) {
            this.enqueuePr(run.key, repo, repo.branch ?? null, prs[repo.name]);
          }
        }
      }
      out.push(buildRunStatus(run, jira, projectsRoot, now, this.liveSignal, openIdentities, prs));
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
        ghNote: this.prFacts && this.ghGap ? GH_NOTES[this.ghGap.kind] : null,
      });
      if (this.reviewsEnabled()) this.enqueueReviews(Date.now());
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
      case "deck:inspect":
        await this.inspect(m.key, m.action, m.repo);
        break;
      case "deck:setReviewSort":
        this.reviewSort = m.sort;
        this.postReviews();
        break;
      case "deck:reviewExpand":
        await this.reviewDetail(m.id);
        break;
      case "deck:forget":
        removeRun(defaultRunsDir(), m.key);
        removePrEntries(defaultPrFactsDir(), m.key);
        // Any fetch already in flight for this key belongs to the incarnation we
        // just deleted — bump the epoch so its write is a no-op if it lands late.
        this.prEpoch.set(m.key, (this.prEpoch.get(m.key) ?? 0) + 1);
        await this.refreshBusy();
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

  private run(key: string): Run | undefined {
    return readRuns(defaultRunsDir()).find((r) => r.key === key);
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
