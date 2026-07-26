# Design: PR & CI observation on the Deck

**Date:** 2026-07-27
**Status:** Approved, ready to plan

## Summary

The Deck currently reconciles three sources — git, Jira, and the local Claude
Code transcript — into a card. It cannot answer the question you actually have
when six agents are in flight: **is this PR green?** `BucketInput` even declares
a `prOpen` field ([`status.ts`](../../../src/engine/status.ts)) that nothing ever
populates.

This design gives the extension its own read-only view of GitHub. For each repo
in a run, one `gh pr list` call resolves the pull request and returns its CI
rollup, review decision and mergeability in a single shot. Those facts are
cached on disk, rendered as a labelled block on the card, and fed into
`deriveBucket` so a blocked PR pulls its card into **Needs you**.

Everything here **observes**. No merge, no comment resolution, no agent nudges,
no notifications — those are separate designs (see [Scope](#scope)).

## Why this, and why now

Inspiration: [AgentWrapper/agent-orchestrator](https://github.com/AgentWrapper/agent-orchestrator),
whose daemon polls each session's PR every 30s, stores `pr` / `pr_checks` /
`pr_comment` facts, and derives ~13 display statuses from them. Its
observe → update → derive pipeline is the part worth taking; its daemon, SQLite,
CDC and tmux layers are not — a VS Code extension already has an event loop, a
UI shell, and file watchers.

Four gaps were identified against that project. This design covers the first,
which the other three build on:

| | Vein | Status |
|---|------|--------|
| **A** | **PR & CI observation, and the status ladder** | **this design** |
| B1 | Needs-you notifications (badge, toast) | later; independent of A |
| B2 | PR-driven notifications, nudges, merge-from-card | later; needs A |
| C | Session hygiene — worktree/branch cleanup, reaping | later; independent |
| D | Reviewer pass as a card action | later; needs A for the PR path |

The observe/act split is the boundary: A is read-only, so it cannot damage a
repo or a PR. Every write lands in B2.

### This supersedes a previous non-goal

The [PR-review kick-off design](2026-07-21-pr-review-kickoff-design.md) states as
its first non-goal: *"No extension-side GitHub or Jira-dev-status calls; no PR
URL resolution; no readiness pre-check — all agent-driven."* That was right for
its problem: **Address PR** runs *after* you decide to act, so an agent can do
the discovery itself.

The Deck has the opposite shape. It must show you PR state *before* you decide
anything, and an agent that only runs once you click cannot inform the click.
So this design deliberately reverses that non-goal for the Deck's read path.
**Address PR keeps its agent-driven flow unchanged** — no prompt, setting, or
code path from that design is touched here.

## Decisions

| Question | Decision |
|----------|----------|
| How does the extension reach GitHub? | The **`gh` CLI**, spawned per repo. No credentials in the extension, no new secret, enterprise hosts and SSO inherited from the user's existing `gh auth`. `config.ts` already requires `gh` for the Address PR prompt, so existing users gain no prerequisite. Behind a `PrProvider` interface so a REST/PAT provider can drop in later. |
| How is a repo matched to its PR? | **Live head branch first** (`--head <branch>`, run in the repo dir so `gh` infers the remote) — exact, and correct for Address PR runs since the agent checked out the PR's own head. **Falls back** to `--search "<KEY> in:title"`, which catches a PR opened from a branch Agent Flow didn't name. |
| Multi-repo runs? | **Up to one PR per repo.** Resolution runs per repo directory, so there is nothing to aggregate. Only repos that actually have a PR get a block. |
| Do PR facts move cards between columns? | **Yes.** A blocked PR promotes its card into **Needs you**, which widens from "the agent ended its turn" to "this one is waiting on you, from either side". |
| How much does the card show? | A **full labelled block** — `pr` / `ci` / `review` / `merge` lines, always expanded. Nothing collapsed behind a hover or a click. |
| Refresh cadence? | A **slow tier inside the Deck's existing loop**. The 6s tick keeps reading git and transcripts and always renders *cached* PR facts; a repo's PR is re-fetched only when its cached fact is older than a TTL. Immediate fetch on Deck open and on Refresh. **Zero GitHub calls while the Deck is hidden.** |
| Where do facts live? | On disk, `~/.agentflow/prfacts/<KEY>.json`. Instant render on Deck open, and B2 later needs a *previous* value to know CI *just* broke. |
| What happens when `gh` is absent or unauthenticated? | Nothing visible breaks. No block on the card, a quiet note in the Deck footer, never a thrown error or a toast — the same graceful-degradation contract `readAgentActivity` already honours. |

## Approach rationale

- **`gh` over REST.** The three candidates were `gh`, VS Code's built-in GitHub
  authentication provider, and a PAT in SecretStorage mirroring `jira/auth.ts`.
  `gh` wins on the auth story alone — nothing to store, nothing to rotate,
  enterprise and SSO for free — and it happens to be the cheapest: `gh pr list
  --json` (verified on gh 2.89.0) exposes `number`, `url`, `title`, `state`,
  `isDraft`, `headRefName`, `mergeable`, `mergeStateStatus`, `reviewDecision`,
  `latestReviews` **and** `statusCheckRollup`, so matching and fact-gathering are
  a single call. The REST path needs three or four endpoints and still needs
  GraphQL for review threads.
- **Promotion over a fifth column.** A `Blocked` column would distinguish "the
  agent stopped" from "the PR broke" by position, which is more precise. But it
  splits attention across two act-on-me lanes, and the pill already says which
  kind of stuck a card is. Keeping four columns also means the badge count B1/B2
  will add can be one number that agrees with one column.
- **This inverts an existing precedence, deliberately.** `deriveBucket`'s
  docstring records the rule that the live agent signal outranks the review
  stage — *"an agent actively addressing review feedback reads as In progress,
  not parked in Review"*. Under this design `prBlocked` outranks `working`, so a
  card can sit in **Needs you** with a green `working` dot on it. That is
  correct: an agent cannot know CI failed until something tells it, and until B2
  exists that something is you. The docstring must be updated to say so rather
  than left contradicting the code.
- **A slow tier, not a background poller.** A poller independent of the Deck
  would keep facts warm and would let B2's notifications fire with no rework —
  but Agent Flow loads in *every* window, so it needs leader election (feasible:
  `presence.ts` already tracks live pids) and it spends API calls on facts nobody
  is looking at. Reusing the Deck's own visibility-gated loop adds one knob and
  no new subsystem, and leaves the fact store and render path unchanged for
  whenever B2 does add a background tier.
- **Facts on disk, not in memory.** A cold Deck would otherwise render without
  PR blocks for a beat and then reflow. Disk also makes the previous value
  available, which is the whole basis of B2's "CI *just* broke" detection.
  Placement matches the existing `~/.agentflow/{runs,windows,plans}` layout, and
  facts are derived and disposable, so they stay out of the durable `Run` record.

## Fetching

Per repo with a git branch, run in `repo.path`:

```
gh pr list --head <branch> --state all --limit 10 --json \
  number,url,title,state,isDraft,headRefName,mergeable,\
  mergeStateStatus,reviewDecision,statusCheckRollup
```

`--state all` is required so a merged PR is still found (it is what makes the
`done` column truthful). Because that can return several PRs for one branch,
`--limit 10` is used and the winner is chosen by preference: **OPEN**, then
**MERGED**, then **CLOSED**; ties broken by highest `number`.

If the result is empty, retry once with `--search "<KEY> in:title"` and the same
preference order. If that is also empty, the repo has no PR — not an error.

A second call runs **only** when `reviewDecision` is non-null, so most PRs never
pay for it. `owner` and `repo` are parsed from the PR's own `url`, avoiding
another lookup:

```
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){
  repository(owner:$o,name:$r){pullRequest(number:$n){
    reviewThreads(first:100){nodes{isResolved isOutdated}}}}}' \
  -F o=<owner> -F r=<repo> -F n=<number>
```

`unresolved` = nodes where `!isResolved && !isOutdated`.

**Cost.** With a 120s TTL, six runs across two repos each is ~360 primary calls
per hour, plus the conditional GraphQL call for PRs under review — comfortably
inside the 5,000/hour primary limit, and only while the Deck is open.

### Fetching never blocks a tick

The 6s tick reads the store, renders whatever is cached, and returns. Any repo
whose entry is stale is queued for refresh **out of band**; results land in the
store and show up on a later tick. A tick must never await a `gh` spawn — a slow
or hanging call would otherwise stall the git and transcript refresh that the
Deck's whole live signal depends on.

Two bounds on the queue:

- **In-flight dedupe, keyed by repo path.** A call still running when the next
  tick fires is not re-issued. Without this, a 9s call under a 6s tick issues a
  second and third before the first returns.
- **At most 4 concurrent spawns.** A first-open with a dozen stale repos would
  otherwise fork a dozen `gh` processes at once. The rest queue and drain.

## The fact record

```ts
/** One repo's observed pull-request state. Every field derived, none required. */
export interface PrFacts {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  ci: { passing: number; pending: number; failing: { name: string; url: string }[] };
  review: "approved" | "changes_requested" | "review_required" | "none";
  unresolved: number | null; // null = the GraphQL call was skipped
  mergeable: "clean" | "conflicting" | "behind" | "blocked" | "unknown";
}

/** What the store holds per repo. The wrapper — not `PrFacts` — carries the
 * timestamp, so that "this repo has no PR" is itself a cacheable answer. */
export interface PrEntry {
  facts: PrFacts | null; // null = resolved, and there is no PR for this repo
  fetchedAt: number; // epoch ms
  error?: boolean; // last attempt failed; `facts` is the previous value, if any
}
```

**The timestamp belongs on the wrapper, not the facts.** A repo with no PR has
no `PrFacts` to stamp, so if freshness lived on the facts there would be nothing
to age and every 6s tick would re-shell `gh` for every PR-less repo forever. The
`PrEntry` wrapper makes "no PR" a first-class cached answer that expires on the
same TTL as a positive one.

A failed attempt writes `{ facts: <previous ?? null>, fetchedAt: now, error:
true }`. Stamping the failure is what stops a broken `gh` from being retried
every 6s; carrying the previous facts forward is what stops a transient failure
from blanking a card. `error` drives only the footer note — it never changes what
the card renders.

### Mapping `statusCheckRollup`

Entries are heterogeneous: `CheckRun` carries `status` + `conclusion` +
`detailsUrl`, `StatusContext` carries `state` + `targetUrl`.

| Bucket | `CheckRun` | `StatusContext` |
|--------|-----------|-----------------|
| failing | `conclusion` ∈ {`FAILURE`, `TIMED_OUT`, `ACTION_REQUIRED`} | `state` ∈ {`FAILURE`, `ERROR`} |
| pending | `status` ∈ {`QUEUED`, `IN_PROGRESS`} | `state` = `PENDING` |
| passing | `conclusion` = `SUCCESS` | `state` = `SUCCESS` |
| ignored | `CANCELLED`, `NEUTRAL`, `SKIPPED`, `STALE` | — |

`CANCELLED` is ignored rather than counted as failure: a cancelled run is
usually a superseded one, and treating it as a failure would drag cards into
**Needs you** on every force-push.

### Mapping `mergeable` / `mergeStateStatus`

| Facts value | Source |
|-------------|--------|
| `conflicting` | `mergeable` = `CONFLICTING`, or `mergeStateStatus` = `DIRTY` |
| `behind` | `mergeStateStatus` = `BEHIND` |
| `blocked` | `mergeStateStatus` = `BLOCKED` |
| `clean` | `mergeStateStatus` ∈ {`CLEAN`, `HAS_HOOKS`, `UNSTABLE`} |
| `unknown` | anything else, including `UNKNOWN` and `DRAFT` |

`review` maps `reviewDecision` directly; a null or empty decision is `none`.

## The status ladder

`BucketInput` gains `prBlocked` and `prMerged`; `prOpen` finally gets populated.

```
done      ← prMerged  |  jiraCategory === "done"
needs     ← agentState === "needs-you"
          |  prBlocked
progress  ← agentState === "working"
review    ← prOpen (non-draft)  |  isReviewStatus(jiraStatus)
progress  ← catch-all
```

Each PR-derived input is the worst state across the run's repos:

- **`prBlocked`** — any of: a blocking CI failure, `review === "changes_requested"`,
  or `mergeable === "conflicting"`.
- **`prMerged`** — every repo that has a PR has `state === "MERGED"`. A run whose
  backend merged and whose frontend has not is not done.
- **`prOpen`** — any repo has an `OPEN`, non-draft PR.

### Two judgment calls

**A non-required check failure does not promote.** `gh` exposes no per-check
required-ness, so `mergeStateStatus === "UNSTABLE"` is the proxy: it means every
*required* check passed and something optional did not. When failing checks
coexist with `UNSTABLE`, they render on the card but do not set `prBlocked` —
otherwise one flaky optional job drags cards into **Needs you** all day.

**A draft PR does not satisfy `prOpen`.** A draft reads as still In progress, not
In review.

### A card label becomes truthful

`cardTone` currently derives `merged` from `column === "done"`
([`DeckApp.tsx`](../../../src/webview/DeckApp.tsx)), which is Jira-done — so today
a card can say "merged" about a PR that is not. With real facts, `merged` is
shown only when `prMerged` holds; Jira-done without a merged PR reads `done`.

## The card

Under the existing per-repo diff rows, one block per repo **that has a PR**,
headed by the repo name when more than one does:

```
pr      #4821
ci      ✗ build-backend, lint
review  changes · 3 open
merge   blocked
```

The PR number links to the PR; each failing check name links to its own run
(`detailsUrl` / `targetUrl`). Links open externally, built from parsed values
rather than injected markup — same posture as the Marketplace renderer.

`unresolved === null` renders the review line without a count rather than
implying zero.

## Degradation

Every failure path yields "no facts" and leaves the git + Jira backbone intact:

| Condition | Behaviour |
|-----------|-----------|
| `gh` not on PATH | PR facts off; one quiet line in the Deck footer. |
| `gh` present, not authenticated | Same. |
| Repo has no GitHub remote | No block for that repo. Silent — this is normal, and cached as `facts: null` so it is not retried every tick. |
| Non-zero exit / unparseable JSON | `error: true`, previous facts carried forward, retried after the TTL. |
| Call exceeds a 10s timeout | Same: **keeps the last cached facts** rather than clearing them. |

No modal, no toast, no thrown error on any of these. A stale-but-present fact is
always better than a blank card, so nothing is ever evicted on failure — only
overwritten on success.

## Settings

| Setting | Type | Default | Notes |
|---------|------|---------|-------|
| `agentFlow.prFacts` | boolean | `true` | Read PR/CI state from GitHub via `gh`. Off = the Deck's git + Jira backbone only. Also exposed as a Deck toggle beside **Live signal**. |
| `agentFlow.prFactsTtlSeconds` | number | `120` | How stale a cached PR fact may be before the Deck re-fetches it. |

`AgentFlowConfig` gains `prFacts: boolean` and `prFactsTtlSeconds: number`.

## Surfaces

- **`src/engine/pr/provider.ts`** — `PrProvider` interface (`resolve(repoPath,
  branch, key)` → raw JSON) plus `GhProvider`, the only implementation. Mirrors
  the `JiraAuth` seam so a REST provider drops in without touching consumers.
  Spawning is confined here.
- **`src/engine/pr/facts.ts`** — pure `toPrFacts(json)` and the rollup /
  mergeability mappers. No I/O, no clock beyond an injected `nowMs`.
- **`src/engine/pr/store.ts`** — read/write `~/.agentflow/prfacts/<KEY>.json` (a
  map of repo name → `PrEntry`), `isStale(entry, ttl, nowMs)`, and
  prune-on-Forget. Corrupt files are skipped, matching `readRuns`.
- **`src/engine/pr/queue.ts`** — the out-of-band refresh queue: in-flight dedupe
  by repo path and a concurrency cap of 4. Pure scheduling over an injected
  fetch function, so it is testable without spawning or waiting on real time.
- **`src/engine/status.ts`** — `BucketInput` gains `prBlocked` / `prMerged`;
  `deriveBucket` gains two ladder rungs; `buildRunStatus` threads facts through
  and `RunStatus` carries them per repo. The docstring's precedence note is
  rewritten.
- **`src/deckView.ts`** — the existing 6s loop gains the stale check and enqueues
  refreshes without awaiting them, plus the fetch-on-open / fetch-on-Refresh
  paths. Stopping the loop when the panel hides also drains the queue.
- **`src/types.ts`** — `PrFacts` and `PrEntry`; `RunStatus.repos` entries gain an
  optional entry.
- **`src/webview/DeckApp.tsx`** + **`deckStyles.ts`** — the block, its links, the
  `prFacts` toggle, the footer note, and the `cardTone` fix.
- **`src/config.ts`**, **`package.json`** — the two settings.
- **`README.md`** — the Deck and Data-and-privacy sections. The current claim
  that "nothing is sent to any third-party service" needs restating: Agent Flow
  now also reads *your* GitHub, through *your own* `gh` login, reads only.

## Testing

- **`facts.test.ts`** — table-driven over saved `gh` JSON fixtures: each rollup
  shape (`CheckRun` and `StatusContext`, all conclusions including `CANCELLED`
  and `SKIPPED`), each `reviewDecision`, each `mergeable` / `mergeStateStatus`
  pair, draft, merged, closed-unmerged, and an empty rollup.
- **`status.test.ts`** — the extended ladder as a truth table, including the two
  cases the design turns on: `working` + `prBlocked` → **needs**, and a draft
  open PR → **progress**, not **review**. Plus `prMerged` requiring *every*
  PR-bearing repo to be merged.
- **`store.test.ts`** — `isStale` at the boundary (`age === ttl` and
  `age === ttl + 1`), **a `facts: null` entry ages like any other** so a PR-less
  repo is not re-fetched every tick, a corrupt file skipped rather than fatal,
  prune on Forget.
- **`provider.test.ts`** — asserts the **argv** for the head-branch call and the
  key-search fallback, and the OPEN → MERGED → CLOSED preference, all against a
  fake spawn. Nothing spawns a real process in vitest.
- **`queue.test.ts`** — a repo already in flight is not re-enqueued; a fifth
  request waits for a slot; a rejected fetch frees its slot.
- **`deckView.test.ts`** — a fresh entry is not re-fetched; a stale one is; a tick
  resolves without awaiting the fetch; a hidden Deck fetches nothing; a timeout
  preserves the cached facts and sets `error`.
- **`DeckApp.test.tsx`** — the block renders only for repos with a PR, is
  repo-headed only when more than one has one, omits the count when `unresolved`
  is null, and `cardTone` says `merged` only when `prMerged`.

## Scope

**Out of scope — every write.** No merge, no comment resolution, no branch
update, no Jira transition driven by PR state.

**Out of scope — notifications.** No badge, no toast, no unread history. B1 and
B2.

**Out of scope — nudges.** Nothing is fed back into an agent session. B2.

**Out of scope — polling while the Deck is closed**, and therefore any
leader-election across windows. Deferred to B2, which the fact store and render
path are already shaped to accept.

**Out of scope** — reviewer agents (D), worktree cleanup (C), non-GitHub SCMs,
raw CI logs, and review-comment bodies. Failing check *names* and an unresolved
*count* are the whole surface; anything more belongs in the browser or in an
agent's context, not on a card.
