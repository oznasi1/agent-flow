# Design: Deck fixes — untracked sessions, task diff, responsive Forget

**Date:** 2026-07-27
**Status:** Approved, ready to plan

## Summary

Three independent Deck defects, each with a root cause verified against live data
in `~/.agentflow`:

1. An Explore session — a run with no Jira ticket — attaches to an unrelated pull
   request and polls Jira with a key that cannot exist.
2. **Diff** reports "no changes" for every run whose agent has committed, which is
   every run that got as far as opening a PR.
3. **Forget** leaves the card on screen while a full refresh runs, with no
   indication anything is happening. The Deck has never rendered a loading state
   at all.

Each fix is self-contained; none depends on another.

## Defect 1 — an untracked session must not be tracked

### What was observed

The Deck rendered a card for the Explore session
`explore-export-asset-file-name-per-asset-type` carrying `pr #241`,
`review required` and `merge conflicts`. That PR belongs to nobody:

```json
// ~/.agentflow/prfacts/explore-export-asset-file-name-per-asset-type.json
{ "centaur": { "facts": {
    "number": 241,
    "title": "Align master with redesign-master",
    "state": "CLOSED",
    "mergeable": "conflicting" } } }
```

### Root cause

`explore()` opens the repos the user picks, in place — it creates no branch. The
run record therefore stores the repo's *default* branch:

```json
// ~/.agentflow/runs/explore-export-asset-file-name-per-asset-type.json
{ "key": "explore-export-asset-file-name-per-asset-type",
  "url": "",
  "repos": [ { "name": "centaur", "branch": "master" },
             { "name": "automation_e2e", "branch": "main" } ] }
```

[`GhProvider.fetch`](../../../src/engine/pr/provider.ts) then runs
`gh pr list --head master --state all`, which matches any pull request ever
opened *from* `master` — here a long-closed branch-alignment PR. Because the
lookup asks for `--state all`, a `CLOSED` PR is a perfectly good answer, and
`PrBlock` renders whatever it is handed.

The second selector is the same trap one step further out: the fallback
`gh pr list --search "<key> in:title"` is a full-text search, and
`explore-export-asset-file-name-per-asset-type` tokenizes into words as common as
`export`, `asset`, `file`, `name` and `type`.

Separately, `buildAll` calls `jiraStatus("explore-…")` for every Explore run on
every 30s TTL expiry. The call always 404s, always logs
`deck: jira status explore-… failed`, and always returns null.

### The fix

A run is attached to a ticket iff it has a ticket URL. `explore()` is the only
launcher that passes `url: ""`, so the predicate is honest, needs no new field,
and answers correctly for the records already on disk — no migration.

```ts
// src/types.ts, directly below the Run interface — the one module the extension
// host and the webview both import.

/** Is this run attached to a Jira ticket? An Explore session is launched with a
 * synthetic `explore-<slug>` key, no ticket url, and no branch Agent Flow named:
 * there is no Jira issue to poll and no PR to find, so a search for either can
 * only return something that belongs to another task. Tolerates an older or
 * hand-edited record with no url field at all. */
export function isTicketRun(run: Run): boolean {
  return typeof run.url === "string" && run.url.trim().length > 0;
}
```

**Host** — three guards in `buildAll` ([`deckView.ts`](../../../src/deckView.ts)):

| Today | After |
|---|---|
| `authed ? await this.jiraStatus(run.key) : null` | `authed && tracked ? … : null` |
| `this.prFacts ? readPrEntries(…) : {}` | `this.prFacts && tracked ? … : {}` |
| `if (ghReady)` → `enqueuePr` per repo | `if (ghReady && tracked)` |

With no entries read, `prSignals` gets an empty map and stops voting on the
column; with no Jira lookup, `jiraStatus` is null and `deriveBucket` falls
through to the agent signal alone. Both are the correct behaviour for a session
that has neither a ticket nor a PR.

**Webview** — [`DeckApp.tsx`](../../../src/webview/DeckApp.tsx):

- The key becomes a muted, non-clickable `explore` chip, with the full run key as
  its tooltip. The card title already carries the topic, and the button's current
  `openExternal` with `url: ""` is a silent no-op the host rejects on scheme.
- The `⋯` menu renders "Open in Jira" only for a tracked run, leaving Forget.
- The PR block and the Jira status pill are already conditional on data that will
  now be absent. No change needed.

A `.key.untracked` style — inherits `.key`'s layout, drops the hover colour and
the pointer cursor.

### Explicitly not doing

The two `prfacts/explore-*.json` files already on disk are left in place. Once
unread they are inert, and a one-shot sweep needs a per-session guard to avoid a
write on every tick — more machinery than ~1 KB of dead cache is worth.

## Defect 2 — Diff shows what the task changed

### Root cause

Two independent faults in `DeckPanel.gitDiff` ([`deckView.ts`](../../../src/deckView.ts)):

```ts
execFileSync("git", ["-C", repoPath, "diff", "HEAD"], { stdio: [...] })
```

- **`diff HEAD` is working-tree-only.** It answers "what has the agent not
  committed yet". Every run past its first commit is blank — verified: `centaur`
  is clean, so the command returns nothing and the card's Diff button can only
  ever toast.
- **No `maxBuffer`.** `execFileSync` defaults to 1 MB. A large task diff exceeds
  it, throws `ENOBUFS`, is swallowed by the bare `catch`, and returns `""` — the
  same empty toast for an entirely different reason.

### The fix

The range becomes *merge-base → working tree*: everything the branch changed,
committed work included, plus anything uncommitted, in one document. It lands in
[`git.ts`](../../../src/engine/git.ts) beside `gitState`, so it is testable
against a real temp repo and `execFileSync` leaves `deckView` altogether.

```ts
/** The remote default branch to measure a task against: whatever origin/HEAD
 * points at, else origin/main, else origin/master. "" when the repo has no
 * origin at all (a local-only checkout, a fresh init). */
function defaultRemoteRef(repoPath: string): string

/** Everything a task changed in this repo: from where its branch left the default
 * branch to the current working tree, so committed work counts. The moment an
 * agent commits, a plain `diff HEAD` goes blank and reads as "no work done".
 * Degrades to the uncommitted diff when there is no base to find — and on a run
 * still sitting on the default branch merge-base *is* HEAD, so the two commands
 * are the same thing. */
export function taskDiff(repoPath: string): string {
  const base = defaultRemoteRef(repoPath);
  const from = base ? git(repoPath, ["merge-base", "HEAD", base]) : "";
  return git(repoPath, ["diff", from || "HEAD"]);
}
```

`DeckPanel.inspect` calls `taskDiff(r.path)`; the private `gitDiff` method and the
`execFileSync` import are deleted.

Two supporting changes:

- `maxBuffer: 32 * 1024 * 1024` on the shared `git()` helper. Harmless for the
  small `rev-parse`/`status`/`numstat` calls, and the only way a real diff
  survives the trip.
- The empty-result toast drops its now-incorrect qualifier:
  `No uncommitted changes for ASM-1.` → `No changes to show for ASM-1.`

Multi-repo behaviour is unchanged: each repo contributes a `# <name>` chunk, and
a run with a single repo gets a bare diff.

Deliberately *not* diffing against `@{u}`: a pushed branch is identical to its
upstream, which would put us straight back to an empty document.

## Defect 3 — Forget is instant, and the Deck shows when it is busy

### Root cause

`deck:loading` is posted by the host and **dropped by the webview** — the
`DeckApp` message handler only recognises `deck:runs` and `toast`. The Deck has
no loading indicator of any kind.

`deck:forget` compounds it: the card stays on screen until `refresh()` completes,
and `buildAll` awaits one Jira round trip **per run, serially**, plus four
synchronous git subprocesses per repo.

### The fix

- **Optimistic removal.** Forget filters the run out of the webview's local state
  and *then* sends the message. The next `deck:runs` post is authoritative, so a
  delete that somehow failed brings the card back. The interaction is instant
  whatever the refresh costs.
- **Handle `deck:loading`.** A `busy` flag spins the header's `⟳` and swaps
  `synced 4s ago` for `syncing…`. A `spin` keyframe joins the existing `pulse`
  one in `deckStyles`.
- **One `refreshBusy()` helper** on the host replaces the hand-rolled
  loading posts in `onMessage`, and extends the indicator to `deck:forget`,
  `deck:setLive` and `deck:setPrFacts` — none of which report progress today. It
  posts `loading: false` from a `finally`, so a throwing refresh cannot strand
  the spinner.
- **Parallelize the Jira lookups.** `buildAll`'s `for` loop becomes a
  `Promise.all` over the runs, turning a cold refresh from N round trips into
  one. `jiraStatus` swallows its own errors, so the `Promise.all` cannot reject.
  Run keys are unique, so concurrent calls never duplicate a cache miss.

`gitState`'s synchronous subprocesses are the other half of "a bit slow" and are
left alone: making them async is a wider refactor than these three defects
justify.

## Testing

| Area | Cases |
|---|---|
| `isTicketRun` | url present / empty / whitespace / missing field |
| `taskDiff` | committed-only work is shown; committed + uncommitted together; on the default branch (merge-base == HEAD) equals the uncommitted diff; no origin at all degrades rather than throwing; a diff over 1 MB survives |
| `deckView` | an untracked run fetches no Jira status and no PR facts, and enqueues nothing; a tracked run in the same board still does both; Diff uses the task range; the empty-diff toast wording |
| `DeckApp` | Forget removes the card before any host reply; a subsequent `deck:runs` that still contains the run restores it; `deck:loading` toggles the header; an untracked card renders the `explore` chip, no Jira link, and no "Open in Jira" menu item |

The existing `deckView` test *"inspect diff on a repo with no changes toasts
instead of opening a doc"* asserts the old message and needs updating.

## Scope

In: the three defects above. Out: worktree/branch cleanup on Forget, a Forget
confirmation prompt, notifications, and any change to how Explore picks repos or
seeds its agent.
