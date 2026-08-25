# Merge from a Deck card

**Date:** 2026-08-24
**Status:** approved, not yet planned
**Branch:** `feat/deck-merge-button` (off `origin/main` @ `4eca640`)

## The problem

The Deck already sorts a run into a **Merge column, `ready` lane** the moment its
PRs go green. `deriveBucket`'s own comment says why that lane outranks a working
agent:

> The merge you have yet to press outranks a working agent … the merge is the one
> action on this board you can finish in five seconds.

And then the card offers no way to press it. A card that has been promoted for
being one click from done spends that promotion telling you so and nothing else.
The user leaves the Deck, finds the PR in a browser, and clicks merge there.

This adds the verb the lane already implies: a **Merge** button on the card, shown
only when every fact standing between the PR and `main` is green *and readable*.

## What it is not

- Not a second way to do review. Approving stays in the review strip.
- Not an auto-merge. Nothing merges without a modal confirm on a human click.
- Not a merge queue integration. `gh pr merge` handles a queue-protected branch
  its own way; we neither special-case nor fight it.
- Not on the detail drawer or the review strip. One surface, the card.

## Scope of the change

Agent Flow has never merged anything. Today its only write to a forge is
`ReviewProvider.submit`. This adds the second, which is why the ceremony below
(a seam method on both forges, a default-off setting, a docs entry, a host-side
re-check) is proportionate rather than defensive.

## 1. The predicate

### Why `prSignals.ready` is not reused

`prSignals.ready` ([src/engine/bucket.ts](../../../src/engine/bucket.ts)) drives
**column placement**. Tightening it would move existing users' cards between
columns on upgrade — precisely what `test/unit/compat.test.ts` and the
"never break existing users" invariant forbid. It also does not read
`unresolved`, so it cannot answer "no comments open" at all.

`prSignals.ready` is therefore left byte-identical. The button gets its own,
stricter predicate, and the two are allowed to disagree: a card can sit in the
`ready` lane without a Merge button (unreadable review threads, say). That is the
honest state — the lane says "nothing looks wrong", the button says "I can prove
nothing is wrong".

### New export in `src/engine/bucket.ts`

```ts
/** The one PR a card may merge. */
export interface MergeTarget {
  repo: string;    // repo name, the PrEntryMap key
  number: number;
  url: string;     // for the failure toast's "Open PR" action
}

export function mergeTarget(prs: PrEntryMap): MergeTarget | null
```

`bucket.ts` is the right home: it is already the pure PR-facts reducer, it is
already imported by `src/webview/deckCards.ts` and `DeckApp.tsx`, and its own
header comment commits it to staying free of `fs`-touching imports —
`bucket.test.ts` enforces that. No new module is needed.

### Per-PR rules — unknown is not green

A PR qualifies only when every fact is green **and known**:

| `PrFacts` field | Required | Why an unknown fails |
| --- | --- | --- |
| `state` | `"OPEN"` | Nothing else can be merged. |
| `isDraft` | `false` | A draft is not asking. |
| `ci.failing` | `length === 0` | Including when `ciAdvisory` is true: an optional red is still a red the user has not looked at. Stricter than `prSignals.blocked`, which forgives it. |
| `ci.pending` | `0` | A running check has no verdict. |
| `review` | `"approved"` | `"none"` means *no review decision* — on GitHub that covers both "no reviewers required" and "nobody has reviewed yet", and the two are indistinguishable from `PrFacts`. Treating it as approved would put a Merge button on an unreviewed PR. |
| `unresolved` | `0` | `null` means the GraphQL thread call failed or was skipped. That is the exact case where "no comments open" is unproven. |
| `mergeable` | `"clean"` | `"unknown"` is not green — the same rule `branchCi` already states for itself. |

`unresolved === 0` is the only genuinely new fact relative to `prSignals.ready`,
and it is what makes the user's "no comments open on the PR" real.

### Run-level rules

1. The `PrEntry` must not have `error: true`. Stale facts do not authorize a
   write, however green they look.
2. **Exactly one** repo may hold a qualifying PR, and every other PR-bearing repo
   must be `MERGED`. A card with two ready PRs gets **no** button.

Rule 2 is a deliberate limitation, not an oversight. `cardActions` can name a
"lead PR" arbitrarily because its buttons only seed a session; a write cannot.
Merging one half of a coupled pair of PRs on a single click is the specific
mistake worth designing out, and multi-repo runs are the rare case. The
alternative — one Merge row per ready PR — is a larger change to the row model
and is deferred until someone asks.

## 2. The seam

### `PrProvider.merge`

```ts
export type MergeMethod = "squash" | "merge" | "rebase";

export interface PrProvider {
  fetch(repoPath: string, branch: string | null, key: string): Promise<FetchResult>;
  merge(repoPath: string, number: number, method: MergeMethod)
    : Promise<{ ok: true } | { ok: false; message: string }>;
}
```

**Why `PrProvider` and not `Forge` or `ReviewProvider`:**

- `ReviewProvider` is `owner/repo`-scoped and runs every call in `os.homedir()`,
  because a PR awaiting your review may live in a repo you have never cloned. A
  card's PR is a local checkout with a real path. Wrong shape.
- `Forge` directly would work (`branchCi` lives there and is repo-path-scoped),
  but the exec logic would still have to live in `pr/`, and `github.ts` /
  `gitlab.ts` are deliberately thin factories.
- `PrProvider` is already repo-path-scoped, already carries the injected `Runner`
  and `Locate`, and already owns everything about *this repo's PR*. The method
  goes where the knowledge is.

`MergeMethod` is declared in `src/types.ts` beside `ReviewVerb`, so the webview
and the host share one spelling.

### Error handling, copied from `submit`

`GhReviewProvider.submit` already solved this, and its solution is
load-bearing rather than stylistic:

- Prefer `err.stderr` (the CLI's own complaint, attached separately by
  `execRunner`) over `err.message`, which is `Command failed: <full argv>`.
- A `killed` / `ETIMEDOUT` rejection gets its own message: **"Timed out after
  10s — the merge may already have gone through. Open the PR to check."** A
  merge is not idempotent and the 10s clock can expire after the forge
  committed. Claiming "the forge refused" here would be a lie about a write that
  may have landed.
- Validate `method` with `Object.hasOwn` against the flag map before building a
  single argv — not `!MAP[method]`, which a prototype key like `"constructor"`
  sails through as truthy. The one command that merges to `main` does not guess.

Timeout budget: the existing `GH_TIMEOUT_MS` / `GLAB_TIMEOUT_MS` (10s).

### GitHub — `GhProvider.merge`

Verified against the installed `gh` (`gh pr merge --help`):

```
gh pr merge <number> --squash | --merge | --rebase     cwd: repoPath
```

Flags confirmed present: `-s/--squash`, `-m/--merge`, `-r/--rebase`. No
`--repo` — `cwd: repoPath` is the local checkout, matching `GhProvider.fetch`.
No `-d/--delete-branch`: see *Deferred* below.

### GitLab — `GlabProvider.merge`

```
glab mr merge <iid> --yes <method flag>                cwd: repoPath
```

**`glab` is not installed on the authoring machine, so the exact method flags are
unverified.** The implementation must run `glab mr merge --help` against a real
`glab` and map from that, not from memory. If a method has no `glab` equivalent,
it returns `{ ok: false, message }` naming the gap and `docs/FORGES.md` records
it — the forge rule is *degradation is stated, never faked*, and silently
substituting a different merge strategy would be the worst possible fake.

`docs/FORGES.md` gains a merge row either way; `test/unit/docs.test.ts` gates it.

## 3. Settings — ships inert

| Setting | Type | Default |
| --- | --- | --- |
| `agentFlow.mergeWrites` | boolean | **`false`** |
| `agentFlow.mergeMethod` | `"squash" \| "merge" \| "rebase"` | `"squash"` |

`mergeWrites` is the direct sibling of `agentFlow.reviewWrites` — same shape,
same reasoning, same default. The whole feature is invisible until it is turned
on, satisfying "new behavior ships inert".

`mergeMethod` exists because `gh pr merge` requires an explicit strategy
non-interactively. One choice per user rather than a prompt per merge; the
confirm dialog names the method it is about to use, so the setting can never
merge a way the user did not see.

`agentFlow.reviewWrites`' description currently reads *"this is the only setting
that lets Agent Flow Deck write to GitHub"*. That becomes false and must be
reworded in the same change.

Both read through `getConfig()` in `src/config.ts`, per the no-hardcoded-values
invariant. `mergeMethod` falls back to `"squash"` on any unrecognised value.

## 4. Webview

New export in `src/webview/deckSignal.ts`, beside `cardActions`:

```ts
export function cardMerge(r: RunStatus): MergeTarget | null
```

A thin wrapper over `mergeTarget(r.prs)` — the module boundary that keeps
`DeckApp.tsx` reading one vocabulary for both the problem rows and the merge row.

`Card` in `src/webview/DeckApp.tsx` renders a Merge row inside the **existing
`c-rows` block**, so a green card and a red card share one layout:

```
#124   ✓ approved · green · no open threads          [ Merge ]
```

Conditions to render:

- `acts.length === 0` — a problem row always wins; the two can never appear
  together, which is structurally guaranteed since `mergeTarget` requires
  everything `cardActions` reports as wrong to be absent.
- `cardMerge(r) !== null`
- `!local` — the same guard `acts` already carries. A local card's ticket is
  inferred from a branch name that may be someone else's; a one-click merge off
  that inference is exactly what must never ship.
- `mergeWrites` is on — threaded to the webview on the existing deck state
  message, like other gated UI.

**Styling:** reuse the existing `.act` button and the `--c-done` token for the
row's tone. No new `--brand` rule: `tokens.test.ts` asserts set equality per
stylesheet, so a new brand token fails the gate until registered, and a merge-
ready state is a state, not a brand accent.

## 5. Host

New message in `src/types.ts`: `{ type: "deck:mergePr"; key: string; repo: string; number: number }`.

Handler in `src/deckView.ts`, in this order:

1. **`cfg.mergeWrites`** — off means return, logged, silent.
2. **`this.run(key)`** — no record, toast and return.
3. **`runKind(run) !== "local"`** — mirrors `seedPrWork`'s own guard and its
   reasoning.
4. **Re-run `mergeTarget` host-side** against the host's own PR store, and
   require it to name the same `repo` and `number` the webview sent. The
   webview's claim that a PR is green is never the authority for a write; the
   webview is a renderer, and a hand-crafted message must not reach the forge.
5. **In-flight guard** keyed by `${key}:${repo}#${number}`, mirroring
   `reviewSubmitsInFlight` — including its deliberate silence on the duplicate,
   so the real call owns posting the outcome and the button's disable is not
   released mid-flight.
6. **Modal confirm** naming repo, number and method:
   `"Squash and merge owner/repo#124?"`.
7. **`forge.prs.merge(repoPath, number, method)`** where `repoPath` comes from
   the run record's `repos[]` entry matching `repo`.
8. **On failure:** toast the forge's own wording with a neutral prefix and an
   **Open PR** action. Neutral because the timeout message refuses to commit to
   an outcome, and any prefix asserting one would contradict it.
9. **On success:** toast, then **invalidate that repo's `PrEntry`** so the next
   refresh refetches. Without this the card keeps a Merge button for a PR that
   has merged until the TTL (`prFactsTtlSeconds`, default 120s) expires.
10. Post a `deck:mergeDone` outcome so the webview releases the row's disable,
    mirroring `deck:reviewSubmitDone`'s `ok` / `failed` / `cancelled` triple.

One additive telemetry event. No existing wire value changes — `compat.test.ts`
freezes those.

## 6. Testing

| File | What it must cover |
| --- | --- |
| `test/unit/engine/bucket.test.ts` | `mergeTarget`: one case per withholding fact, explicitly including `unresolved: null`, `mergeable: "unknown"`, `ciAdvisory: true` with a failing check, `review: "none"`, `error: true`, and the two-ready-PRs case. Plus the happy path. |
| `test/unit/engine/pr/provider.test.ts` | `GhProvider.merge`: argv per method over the injected `Runner`; non-zero exit returns `stderr`; timeout returns the "may already have gone through" wording; an out-of-union method builds no argv. |
| `test/unit/engine/pr/glab/provider.test.ts` | Same matrix for `GlabProvider.merge`, against flags read off a real `glab --help`. |
| `test/unit/deckView.test.ts` | Setting off; no run record; local card; host-side re-check disagreeing with the message; confirm declined → `cancelled`; double-click → one call; success → toast + cache invalidation; failure → toast with Open PR. |
| Webview render test | Row appears/absent per predicate and per setting; assertions use `waitFor`, never a bare tick. |
| `test/unit/docs.test.ts` | Passes unmodified once `docs/FORGES.md` has the merge row. |
| `test/unit/compat.test.ts` | Passes **unmodified**. |
| `test/unit/vocabulary.test.ts` | Passes unmodified — "merge" is not the contested word. |

Coverage stays above the `vitest.config.ts` thresholds (90% lines/statements,
85% branches/functions). `npm run build` must pass: `bucket.ts` stays
`fs`-free, and `deckSignal.ts` imports only the pure predicate.

`CHANGELOG.md` gains an entry under `## [Unreleased]`.

## Deferred, with reasons

- **`--delete-branch`.** A second irreversible act behind the same click. If it
  ships, it ships as its own setting, default off, and named in the confirm
  dialog.
- **`--match-head-commit <sha>`.** `PrFacts` are up to `prFactsTtlSeconds`
  (default 120s) old, so a commit pushed after the green read could be the one
  that merges. Pinning the SHA would close that, at the cost of a new
  `headSha` field on `PrFacts`, a `headRefOid` in `PR_JSON_FIELDS`, and a
  GitLab equivalent that cannot be verified here. Left out because GitHub
  branch protection re-evaluates approval and required checks server-side at
  merge time — a repo that has not configured protection has chosen not to gate
  — and because the modal confirm is a human at the moment of the write. Worth
  revisiting if a user reports merging a commit they had not seen.
- **The drawer and the review strip.** One surface first.
- **One Merge row per ready PR** on multi-repo cards. See run-level rule 2.

## Open risk

The GitLab path cannot be exercised on the authoring machine (`glab` is not
installed). Agent Flow has shipped an unverified provider path before and it
was the wrong call. The implementation plan must either (a) verify `glab mr
merge` against a real install before merging, or (b) state plainly in
`docs/FORGES.md` and the CHANGELOG that GitLab merge is untested, so a GitLab
user is not surprised by their first click.
