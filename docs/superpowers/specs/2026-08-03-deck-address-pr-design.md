# Design: Address PR on the Deck card

**Date:** 2026-08-03
**Status:** Approved, implementing

## Summary

Put an **Address PR** button on a Deck card whose Jira status matches
`agentFlow.prReviewStatus` (default **"PR initiated"**) — the same affordance the
sidebar task card has had since
[2026-07-21-pr-review-kickoff-design.md](2026-07-21-pr-review-kickoff-design.md),
which deferred it with *"Not the Deck (v1)."* This is that v2.

It is deliberately **not** the sidebar's flow. The sidebar acts on a *ticket*:
nothing is on disk yet, so it must read the ticket from Jira, ask where to open,
ask which repos, and force a worktree. A Deck card acts on a *run* — it already
has `run.repos` (worktree paths), `run.workspaceFile`, `run.briefPaths` and a
`jiraStatus` pill. Every question the sidebar asks already has an answer on that
card, so the Deck asks none of them: one click writes the PR-review prompt as a
plan file and opens (or focuses) the run's own window.

## Decisions

| Question | Decision |
|----------|----------|
| What does the click do? | Re-seed the run's **existing** workspace. No QuickPicks, no Jira round trip, no new worktree. |
| Via `openWorkspace`? | **No** — see rationale. Call `writePlanFile` + `openInEditor` directly. |
| Which cards show it? | `isPrReviewStatus(r.jiraStatus ?? "", prReviewStatus)` **and** the card is not `local`. |
| Where on the card? | Inline in `.actions`, leading — before **Open**. Not the primary; not in the `⋯` menu. |
| Prompt | The existing `agentFlow.prReviewPrompt` + `prReviewAutoFix` clause. No Deck-specific prompt setting. |
| Run record | **Untouched.** `createdAt`, `kind`, `briefPaths` all survive the click. |
| Briefs | Reused from the launch. Not rewritten. |
| Remote Control | Off for a re-seed. |

## Approach rationale

### Why not `openWorkspace`

`openWorkspace` is the *launch* primitive, and it is load-bearing in ways that
are wrong here. It rewrites the runs-store record with `createdAt: Date.now()`
and re-derives `kind` ([workspace.ts:267-286](../../../src/engine/workspace.ts)),
which would reset the card's "launched 4h ago" to "launched 0s ago" on a run
that was launched yesterday. It also rewrites every brief, which would need a
Jira fetch to do faithfully.

Re-seeding an existing run is a smaller operation than launching one, so it uses
the smaller primitives that `openWorkspace` itself is built from:

```
run    = this.run(key)                                  // existing runs-store lookup
prompt = agentPrompt(ticket, [], template, briefPath)   // exported, workspace.ts:148
writePlanFile({ key, createdAt: now, seedAgent: true, matches })
openInEditor(target)                                    // per match
```

Nothing on disk changes except the transient plan file.

### Why seeding reaches an already-open window

`watchPlansAndSeed` ([workspace.ts:577](../../../src/engine/workspace.ts)) watches
the plan directory, so a window that is already open seeds itself when the plan
lands; `maybeSeedAgent` covers windows that (re)open. `openInEditor` shells out
to `open -a`, which **focuses** an existing window rather than opening a second
one. So the same code path works whether the run's window is open or closed, and
`r.windowOpen` needs no special-casing.

The per-window `seeded:<key>:<createdAt>:<identity>` guard is keyed on the plan's
`createdAt`, so each click writes a plan that is distinct from the launch's and
from any earlier click. Repeated Address PR clicks each seed.

### Why local cards are excluded

A `local` card is a directory with an agent open in it that the Deck never
launched. Its ticket key is *inferred from the branch name* — the card itself
says `~inferred` and warns that the Jira status shown could belong to somebody
else's ticket. Seeding a PR-review agent off that inference on one click is not
a thing to do. Tracked runs only; **Track it** promotes a local card first.

Runs with no Jira status at all (explore, review, untracked) need no extra
guard: `isPrReviewStatus` requires both sides non-empty and so returns `false`
for a `null` status.

## Changes

### `src/types.ts`

```ts
| { type: "deck:addressPr"; key: string }        // InboundMessage
```

and `deck:runs` gains `prReviewStatus: string`. It already carries the other
config-derived fields (`liveSignal`, `prFacts`, `openAgents`, `ghNote`) and
re-posts on every refresh, so the setting stays live without a second message
type.

### `src/engine/prompt.ts`

`prReviewTemplate` moves out of `TasksViewProvider`
([tasksView.ts:1465](../../../src/tasksView.ts)) — private, and now two callers —
into a pure function beside `insertBeforeFiles`, which it already uses:

```ts
export const PR_REVIEW_AUTOFIX_CLAUSE = "If it's ready, go ahead and implement …";

export function prReviewTemplate(prompt: string, autoFix: boolean): string {
  return autoFix ? insertBeforeFiles(prompt, " " + PR_REVIEW_AUTOFIX_CLAUSE) : prompt;
}
```

`PR_REVIEW_AUTOFIX_CLAUSE` moves here from `config.ts` along with it, and this is
not incidental. **No file under `src/engine/` imports `config.ts`** — the engine
takes config as plain values (`launchReview` takes `template`, `workspaceDir`,
`seedAgent` as fields, never a config object). A `prReviewTemplate` in
`engine/prompt.ts` that reached back into `config.ts` for the clause would be the
first edge to break that.

The move is right on its own merits anyway: `SLACK_DM_SENTENCE` — the same kind
of thing, a prompt fragment inserted before `{files}`, paired with its own
`injectSlackDm` helper — already lives in `prompt.ts`. Clause + template function
is that identical pair, and the two belong side by side.

`DEFAULT_PR_REVIEW_PROMPT` stays in `config.ts`: it is a *setting default*, which
is config's job. The clause is not a default — it is a fragment the code appends.

Callers: `tasksView` drops its private method and its `PR_REVIEW_AUTOFIX_CLAUSE`
import from `config`; `test/unit/tasksView.test.ts` imports the clause from
`engine/prompt` instead (lines 6 and 79). Behavior-preserving — it keeps the
auto-fix clause from being assembled two different ways.

### `src/deckView.ts`

A `deck:addressPr` case and an `addressPr(key)` method. Match shape mirrors how
the run was launched, because that is what its windows are:

| `run.mode` | matches | brief |
|-----------|---------|-------|
| `multiroot` | one, on `run.workspaceFile` | `run.briefPaths[0]` (absolute) |
| `per-window` | one per `run.repos[i].path` | omitted — the relative `.agentflow/BRIEF.md` resolves inside each repo window |

This is exactly what `openWorkspace` does for the same `mode`, so a multi-repo
per-window run gets every window seeded, the way its launch did. `mentions` is
`[]` — file hints come from the ticket description, which we are deliberately
not re-fetching; `renderPrompt` renders `{files}` as empty for an empty list.

Failure modes, each a toast: no run record for the key; nothing to open (no
`workspaceFile` and no repos).

### `src/webview/DeckApp.tsx`

`prReviewStatus` threaded from `deck:runs` into `Card`. In `.actions`, before
Open:

```tsx
{canAddressPr && (
  <button className="act" title={`Address the PR for ${r.run.key} — open its workspace and work through the review feedback`}
    onClick={() => send({ type: "deck:addressPr", key: r.run.key })}>
    Address PR
  </button>
)}
```

`isPrReviewStatus` is imported from [helpers.ts](../../../src/webview/helpers.ts),
which imports only `JiraTask` from `types` — no sidebar code reaches the Deck
bundle.

### Presentation

Plain `.act`, no new CSS, no icon (the Deck's action row is text-only, unlike the
sidebar's). Not `.act.primary`: **Open** is the primary on every card on the
board and that consistency is worth more than the extra emphasis here. The
status pill on the same row is `flex: 0 1 auto` and already ellipsizes, so the
narrow 4-column layout degrades on the pill, not the buttons. No new hint line
on the card.

The tooltip says *"open its workspace"*, not the sidebar's *"check it out in a
worktree"* — on the Deck the worktree already exists and no new one is made.

## Known wrinkle, accepted

The default `prReviewPrompt` says *"run `gh pr checkout` to bring its branch into
this worktree."* In the sidebar flow the worktree is fresh and needs that. On a
Deck card the worktree is already **on** the PR's branch, so the checkout is
close to a no-op — and will fail loudly if the tree is dirty, which the agent can
report. Forking a Deck-specific prompt would mean two settings that mean almost
the same thing; one setting with one meaning is the better trade.

## Testing

Against the enforced gates: `npm run typecheck`, `npm test`, `npm run test:cov`
(thresholds enforced), `npm run build`.

**`test/webview/DeckApp.test.tsx`**
- shows the button when `jiraStatus` matches `prReviewStatus`
- hides it for a non-matching status, a `null` status, and a `local` card
- posts `{ type: "deck:addressPr", key }` on click

**`test/unit/deckView.test.ts`**
- `multiroot`: one match on `workspaceFile`, brief = `briefPaths[0]`
- `per-window`, 2 repos: two matches, `openInEditor` called for each
- the runs-store record is unchanged after the click — the `createdAt` assertion
  is the one that matters
- toast when no run record exists for the key

**`test/unit/engine/prompt`**
- `prReviewTemplate` with `autoFix` on and off
- the clause lands before `{files}`, and is appended when there is no `{files}`
  (the two cases `insertBeforeFiles` already distinguishes)

Existing `deck:runs` assertions updated for the new `prReviewStatus` field.

## Out of scope

- Any Deck-side GitHub work. The agent still finds and checks out the PR itself.
- Showing the button off PR-facts signals (`changes_requested`, failing CI)
  rather than the Jira status. The gate is the configured status, as asked.
- Per-click prompt-mode picking (the review strip's `resolveReviewMode` pattern).
  The `prReviewAutoFix` setting decides, as it does in the sidebar.
