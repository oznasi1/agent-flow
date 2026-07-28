# Design: Review requests on the Deck

**Date:** 2026-07-28
**Status:** Approved, ready to plan

## Summary

The Deck shows everything **you** launched. It cannot show the other half of your
queue: the pull requests your teammates are waiting on **you** to review. Those
PRs belong to no run, live in repos you may not have taken a task in, and are
invisible to every source the Deck reads today.

This design adds a **review-requests strip** above the four columns. One
`gh api graphql` search returns every open PR requesting your review — with its
size, CI rollup, review decision and mergeability — and renders each as a row you
can sort by age or by size. A row can launch a **Review agent** into a worktree,
and (behind an opt-in) submit an approve / comment / request-changes back to
GitHub.

This is the first Agent Flow feature that **writes to GitHub**. It is off by
default and gated behind a confirm.

## Why this, and why now

The [PR & CI observation design](2026-07-27-pr-ci-observation-design.md) named
four veins and shipped the first. This is vein **D — "Reviewer pass as a card
action; later; needs A for the PR path."** Vein A landed the `gh` probe, the
per-repo fetch, the disk cache with a TTL, the refresh queue, and the mappers
that turn `gh`'s varying shapes into our records. All of it is reused here.

It also crosses the observe/act boundary that vein A deliberately did not: "Every
write lands in B2." The write surface here is narrow (one command, three verbs),
default-off, and confirmed per submit — but the README's blanket read-only claim
stops being true and must be amended.

## Decisions

Settled during brainstorming, recorded so the plan does not relitigate them:

| Question | Decision |
|---|---|
| Which direction of "pending review"? | **Reviews I owe** — PRs where I am a requested reviewer. Not my own PRs waiting on others (already visible per-card). |
| Where on the Deck? | **A collapsible strip above the board.** The four columns stay about your own work. |
| What can a row do? | **Open PR · Review with agent · Approve / Comment / Request changes.** |
| Which PRs count? | **Everything requesting your review**, no repo filter. Rows for repos you have not cloned still render; only the agent action is disabled. |
| How much detail per row? | **Rich rows** — one GraphQL call returns size and CI for all of them, so the lean/enrich tradeoff dissolved. Expansion fetches only what the search cannot return. |
| How do the agent's findings reach the review box? | **Via a file** the agent writes into the worktree; the Deck offers to load it. The agent never submits. |

## Scope

**In:** discovery, the strip and its rows, sorting, expansion, the Review agent
launch, the draft handoff, the three write verbs, settings, failure handling,
tests.

**Out:** clone support for repos not on disk; review *threads* (line comments)
from the Deck; notifications or badges when a new request arrives; reviews
requested from a team the extension would have to resolve membership for
(GitHub's `review-requested:@me` already includes them server-side); anything
about your own PRs' reviewers.

## Verification

Every claim below was checked against a real account with `gh` 2.89.0 before the
design was written.

- `gh search prs --review-requested=@me --state=open` returns **9** open
  requests. The REST search's `--json` field list has **no** `additions`,
  `deletions`, `changedFiles`, `reviewDecision` or `statusCheckRollup` — so a
  size sort is impossible from it.
- `gh pr view <n> --repo <owner/name> --json statusCheckRollup,reviewDecision,mergeable,mergeStateStatus`
  works and maps onto the existing `toPrFacts`. One call per PR.
- **One** `gh api graphql` search returns all nine with `additions`, `deletions`,
  `changedFiles`, `reviewDecision`, `mergeable`, `isDraft`, author, repo and
  `commits(last:1){nodes{commit{statusCheckRollup{state}}}}` — in **3.3s**. This
  is what the design uses.
- The rollup exposes only an aggregate `state`, never the failing checks' names
  or URLs. Those remain a per-PR call, which is what expansion is for.
- `mergeable` returns `UNKNOWN` on some PRs (GitHub computes it lazily);
  `mapMergeable` already has that case.
- `review-requested:@me` and `user-review-requested:@me` both returned 9 on this
  account, so the team-vs-direct difference was not observable here. Per GitHub's
  documentation `review-requested:` is the superset, and it is what we use.

## Architecture

Three layers, each degrading to the one below without taking the Deck with it.

### Discovery — one call, whole strip

`GhReviewProvider.search()` runs `gh api graphql` with the query above,
`first: 50`. It returns `{ issueCount, requests }`. Refreshed on Deck open and
whenever the cache is older than `agentFlow.reviewRequestsTtlSeconds`, through
the **existing** `RefreshQueue` so it can never stall a paint — the same
never-awaited enqueue `enqueuePr` uses.

`issueCount > requests.length` surfaces as "showing 50 of N" in the strip header.
Silent truncation would read as "that's all you owe".

### Locality — which rows can run an agent

Each request's short repo name is matched against the checkouts discovered under
`agentFlow.reposRoot` (reusing `engine/repos.ts`). A match sets `localPath` and
enables **Review with agent**; no match leaves it `null` and the button disabled
with the reason on hover. Open PR and the write verbs never need a clone.

### Enrichment — only what the search cannot return

Expanding a row fires one `gh pr view --repo owner/name --json statusCheckRollup`
plus the existing review-threads GraphQL call, producing failing check names,
their URLs, and the unresolved-thread count. Fetched once per row per Deck
session. `GhProvider` today locates a PR by cwd + branch; this needs a
`--repo owner/name` path — a second method on the provider, sharing its injected
`Runner` and `locate`. Because the repo may not be on disk at all, these calls
run with `os.homedir()` as cwd: `--repo` makes them repo-independent, but the
`Runner` signature still requires a directory that exists.

### Modules

| File | Contents |
|---|---|
| `src/engine/review/search.ts` | The GraphQL document, and the **pure** node → `ReviewRequest` mapper. Tolerates missing fields the way `facts.ts` does. |
| `src/engine/review/provider.ts` | `GhReviewProvider`: `search()`, `detail()`, `submit()`. Injected `Runner`, so no test forks a process. |
| `src/engine/review/store.ts` | `~/.agentflow/reviews.json` — one file beside `runs/`, `windows/` and `prfacts/`. Holds `{ fetchedAt, issueCount, requests }`. `localPath`, `runKey` and `draftPath` are recomputed from disk on every refresh and never persisted — a cached path to a worktree that has since been forgotten would render an action that cannot work. |
| `src/engine/review/sort.ts` | `sizeBucket()` and the two comparators. Pure, table-tested. |
| `src/webview/ReviewStrip.tsx` | The strip, its rows, expansion, and the review box. |

### Types

```ts
/** One PR asking for your review. Everything the strip renders without expanding. */
export interface ReviewRequest {
  id: string;          // "owner/repo#number" — stable across refreshes
  repo: string;        // nameWithOwner
  repoName: string;    // short name, for local matching
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  createdAt: number;
  updatedAt: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  ci: "passing" | "failing" | "pending" | "none";
  review: PrFacts["review"];
  mergeable: PrFacts["mergeable"];
  localPath: string | null; // matched checkout; null disables the agent action
  runKey: string | null;    // a review run in flight for this PR
  draftPath: string | null; // .pick-task/REVIEW-<n>.md, once the agent writes it
}

/** What expanding a row adds. */
export interface ReviewDetail {
  failing: PrCheck[];
  unresolved: number | null;
}

export type ReviewSort = "oldest" | "smallest";
export type ReviewVerb = "approve" | "comment" | "request-changes";
```

Rollup `state` maps: `SUCCESS` → passing, `FAILURE`/`ERROR` → failing,
`PENDING`/`EXPECTED` → pending, absent → none.

### Messages

Inbound: `deck:reviewExpand {id}`, `deck:reviewLaunch {id}`,
`deck:reviewLoadDraft {id}`, `deck:reviewSubmit {id, verb, body}`,
`deck:setReviewSort {sort}`.

Outbound: `deck:reviews {requests, issueCount, sort, stale, note}`,
`deck:reviewDetail {id, detail}`.

## The strip

The header's stats row gains a **To review** count, always visible, even at zero.
The strip itself renders only when the count is above zero — an empty rail above
the board is noise.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ In-flight        3 In progress  1 Need you  2 In review  9 To review     │
│                      ⦿ Live signal   ⦿ PR facts   ⟳ synced 4s ago        │
├──────────────────────────────────────────────────────────────────────────┤
│ ▾ 9 PRs waiting on your review                        sort: oldest ·smallest│
│   aws-ops     #8455 SRE eks-demo scaling      S  +106 −0    1f  ✓ @asafli 7d│
│ ▸ aws-ops     #8491 isolate renew queue       M  +350 −4    7f  ✓ @einav  5d│
│   notif-svc   #375  bulk notification rework  L +3923 −1998 50f ✗ @dean   9d│
│   account-svc #404  E2E harness         draft M  +494 −0    4f  ✓ @einav  6d│
├──────────────────┬─────────────────┬────────────────┬────────────────────┤
│ In progress 3    │ Action required 1│ In review 2   │ Done 4             │
```

Expanded:

```
│ ▾ aws-ops #8491  isolate renew queue onto dedicated worker    @einav 5d   │
│     ci ✓ 14 passing    review required    merge clean                     │
│     ┌──────────────────────────────────────────────────────────────┐      │
│     │ Looks good. One thing: the worker's retry budget…            │      │
│     └──────────────────────────────────────────────────────────────┘      │
│     [▶ Review with agent] [Open PR]   [Approve] [Comment] [Request changes]│
```

- **Sort** — `oldest` (default) is what you owe most; `smallest` is the
  fifteen-minutes-before-standup mode, floating a 1-file, 106-line PR above a
  5,900-line one. Ties break on age. Drafts pin last in both orders.
- **Size** renders as `+409 −50 · 8 files` (matching the repo chips on Deck
  cards) and as an **S/M/L** bucket by lines changed — `S ≤ 100`, `M ≤ 500`,
  `L > 500` — reusing the task pool's size vocabulary so one mental model covers
  both panels. The verified spread lands 6 in M and 3 in L.
- **Age** is measured from `createdAt`. GitHub's search does not expose *when the
  review was requested*, so a PR that added you late reads older than it is. An
  accepted inaccuracy; correcting it costs a call per PR.
- **Drafts** stay listed with a badge. If a teammate requested you on a draft,
  they meant to.
- **Collapse state and sort choice** are per-session, and the strip arrives open
  however long the queue is: its rows container is height-capped with its own
  scroller, so the board keeps its share of the window without the queue being
  hidden. An earlier draft auto-collapsed above five rows — rendering it showed
  that a realistic nine-request queue then opened as a bare count, defeating the
  point of the feature.

### What has to be true for the strip to render

Three conditions, and they are not redundant:

1. `agentFlow.reviewRequests` is `true` — the persistent "I want this feature"
   setting, the only one that survives a restart.
2. The Deck's **PR facts** toggle is on. Same `gh` dependency, same session probe;
   a second switch for the same permission would just be a second thing to find
   when nothing shows up.
3. `probeGh()` found a usable `gh`. Otherwise the strip is hidden behind the
   footer note PR facts already shows.

The **To review** stat follows the strip: hidden when the feature is off or `gh`
is unusable, shown (including at zero) when it is on.

## The Review agent

**▶ Review with agent** is Take with a different destination and prompt:

1. `createWorktrees` makes `<repo>/.claude/worktrees/review-<repo>-<number>` —
   already git-excluded, already skipped by tooling.
2. A new `agentFlow.reviewRequestPrompt` seeds Claude Code — named apart from the
   existing `prReviewPrompt`, which addresses review comments on **your own** PR
   and would otherwise be one letter away from its opposite. The default:

   > Review pull request {url} — `{repo}#{number}`, "{summary}", by {author}.
   > Check it out with `gh pr checkout {number} --repo {repo}`, then read the full
   > diff against its base branch. Assess correctness, edge cases, tests, and
   > anything that would break in production. Write your findings to
   > `.pick-task/REVIEW-{number}.md` as a short prioritised list — most serious
   > first, each with the file and line it refers to. Do not post anything to
   > GitHub; the human submits the review.

   Placeholders follow the existing convention (`{key} {summary} {url}`) plus
   `{repo} {number} {author}`. User-overridable like every other prompt.
3. A run is recorded, so the review inherits live agent status, window focus,
   Diff and Forget without new code.

### `Run.kind`

Recording a review as a run forces one structural change. `Run` gains
`kind?: "task" | "explore" | "review"`, absent meaning `"task"` so records
already on disk keep working.

Today `isTicketRun` infers "has a Jira ticket" from a non-empty `url`. A review
run **has** a url — the PR's. Left alone, the Deck would poll Jira for
`review-centaur-850` every 30 seconds and 404 forever, and `gh pr list --head`
would run against a branch that is somebody else's. So:

- Jira polling and branch-based PR fetching gate on `kind`, not on `url`.
- `kind === "review"` runs are filtered **out** of the four columns and surface in
  their strip row, which grows a `reviewing · 4m ago` state and its own
  Open / Diff.

Repos with no local checkout keep the action disabled. There is no clone support
today (`agentFlow.githubOrg` is still documented as reserved), and adding one here
would be a second feature wearing this one's coat.

## The write path

`gh pr review <n> --repo <owner/name> --approve|--comment|--request-changes --body <text>`.

- **Off by default** — `agentFlow.reviewWrites`, default `false`. While off, the
  verbs and the box do not render; the row is read-only, exactly as the README
  promises today. Turning it on is the moment the user opts into GitHub writes.
- **Every submit confirms** through a modal naming verb, repo and number —
  *"Request changes on CyberJackGit/aws-ops#8491?"*. Approve confirms too: a
  teammate is notified either way.
- **Body rules follow GitHub's** — required for comment and request-changes,
  optional for approve.
- **Load agent's review** appears once `.pick-task/REVIEW-<number>.md` exists in
  the worktree, dropping its text into the box. You edit, then choose the verb.
  The agent never calls `gh pr review`.
- **Provenance**, mirroring `stampLabelOnWrite`: a body loaded from an agent file
  gets a short trailing line marking it as drafted with Claude Code. On by
  default, off via `agentFlow.stampLabelOnWrite`. Posting an agent's words as
  unmarked human review is worth being straight about with teammates.
- Every write is logged to the Agent Flow output channel. A successful submit
  optimistically drops the row; approving clears the request server-side anyway.

**The README's Data & privacy section must change.** "All GitHub access is
read-only — Agent Flow never merges, comments, or pushes" becomes accurate only
while `reviewWrites` is off, and the section must say what the setting enables,
that it defaults to off, and that every submit is confirmed.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `agentFlow.reviewRequests` | `true` | Show the review-requests strip on the Deck. |
| `agentFlow.reviewRequestsTtlSeconds` | `300` | Minimum 60. Review requests move on a human timescale, not a CI one. |
| `agentFlow.reviewWrites` | `false` | Enable approve / comment / request-changes from the Deck. |
| `agentFlow.reviewRequestPrompt` | *(the template above)* | The Review-with-agent seeded prompt. |

## Failure modes

| What breaks | What happens |
|---|---|
| `gh` missing or signed out | Strip hidden behind the same probe and footer note PR facts already use. No second diagnosis path. |
| GraphQL search fails | Last cached result renders with a stale marker; the board is untouched; the reason goes to the output channel. |
| A malformed node in the response | That row is dropped, the rest render — the tolerance `facts.ts` already applies to `gh`'s varying shapes. |
| More than 50 requests | "showing 50 of N" in the strip header. |
| Enrichment fails | The row stays at search-level detail; no error surface beyond the log. |
| Worktree creation fails | Toast with the reason. No run recorded, no half-made card. |
| `gh pr review` rejected | Toast carrying GitHub's own message plus an **Open PR** button — the browser is the only place left to resolve it. |
| Repo not cloned | Review disabled with the reason; everything else on the row still works. |

## Testing

Matching the existing split under `test/unit/` and `test/webview/`.

**Pure, table-tested, no process spawned:**
- GraphQL node → `ReviewRequest`, including absent fields, a null rollup, and a
  node that is not a PullRequest.
- `sizeBucket` at both boundaries (100, 500) — exactly-at is the interesting case.
- Both comparators, including drafts pinned last and the age tiebreak.
- Rollup `state` → `ci`, covering `ERROR` and `EXPECTED`.

**Provider, with the injected `Runner`:**
- `search()` parses a recorded payload; a non-array/garbage response degrades,
  never throws.
- `detail()` targets `--repo owner/name` with no cwd.
- `submit()` builds the right argv per verb, and refuses comment/request-changes
  with an empty body before spawning anything.

**Host wiring:**
- `Run.kind` back-compat: a record with no `kind` behaves as a task.
- A review run never reaches Jira polling and never lands in a column.
- Cache staleness drives exactly one search per TTL.

- The confirm modal gates the spawn: declining it must run **no** `gh` command.
  This lives in the host, not the webview — the webview only posts
  `deck:reviewSubmit`, so this is where the write guarantee is actually tested.

**Webview:**
- Strip renders, is hidden at zero while the stat still shows, and reports
  "showing 50 of N".
- Expansion fetches once, not once per render.
- Write verbs absent while `reviewWrites` is off; present and posting
  `deck:reviewSubmit` when on.
- Comment and request-changes are disabled with an empty box; approve is not.
- **Load agent's review** appears only when `draftPath` is set.

## Build order

Three slices, each shippable on its own and each useful without the next:

1. **Discovery + the strip, read-only.** Provider `search()`, the mapper, the
   store, sorting, the strip, expansion. At this point the Deck answers "what am
   I holding up?" and nothing can write anywhere.
2. **The Review agent.** `Run.kind`, the column filter, the worktree launch, the
   prompt, and the draft file appearing on the row. Still no GitHub writes.
3. **The write path.** `reviewWrites`, the three verbs, the confirm modal, the
   provenance line, the README amendment.

Slice 3 is the only one that changes Agent Flow's posture toward other people's
repositories, and it is last on purpose: if it slips, 1 and 2 still ship.

## Risks

- **The write surface is the real risk.** A mis-click posts "request changes" on
  a teammate's PR. Mitigated by default-off, a per-submit modal, and the agent
  never being allowed to submit — but the mitigation is only as good as the modal
  being genuinely modal, which the tests must assert.
- **`review-requested:@me` may include more than you expect** (team requests).
  That is the intended superset, but a user on many teams could see a long strip
  on first open. The 50-cap and the rows container's capped height absorb it.
- **One more `gh` call per Deck session** on a 5-minute TTL, off the paint path.
  The measured 3.3s is well inside the existing 10s `GH_TIMEOUT_MS`.
