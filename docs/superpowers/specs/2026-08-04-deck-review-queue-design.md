# Deck review queue: toggle, aligned rows, loading state

Date: 2026-08-04
Surface: the Deck's In-flight webview (`src/webview/DeckApp.tsx`, `src/webview/ReviewStrip.tsx`) and its host (`src/deckView.ts`).

Three changes to the review-requests strip, in one pass because they touch the same
three files and the same message.

## 1. A Review queue toggle

The strip's visibility is currently only reachable through the `agentFlow.reviewRequests`
setting — a trip to Settings to silence a rail sitting above the board. It gets a
control in the header, next to Live signal / PR facts / Open agents.

Session-scoped, exactly like its three neighbours: `agentFlow.reviewRequests` remains
the persistent seed read in the constructor, and the pill is the per-session override.
Nothing writes back to the setting.

- `types.ts` — `deck:runs` gains `reviewQueue: boolean`; new inbound
  `deck:setReviewQueue { on: boolean }`.
- `deckView.ts` — a `reviewQueue` field seeded from `getConfig().reviewRequests`;
  `reviewsEnabled()` reads the field rather than the config. That single substitution
  is the whole behavioural change: switching off already stops the `gh api graphql`
  search (`enqueueReviews` is gated on it), clears the rows and the "To review" tile
  (`postReviews` posts `enabled: false`), and refuses an in-flight submit
  (`submitReview` gates on the same method).
- `DeckApp.tsx` — a fourth `.ctl` labelled **Review queue**, titled "Open PRs that ask
  for your review, read with the gh CLI. Off → no query, no queue."

The strip keeps its collapse caret. The two controls mean different things and both
are worth having: the toggle stops the query, the caret folds what is already fetched.

### Interaction with PR facts

`reviewsEnabled()` is `this.reviewQueue && this.ghReady()`, and `ghReady()` already
folds the PR-facts toggle. So PR facts off still means no queue, with Review queue
left reading "on" — the pill shows the user's own choice, not the resolved outcome.
This matches how the surface already behaves and needs no extra affordance.

## 2. Aligned columns

Every field on a row stays. The problem is not what is shown but that the trailing
cluster is ragged: each row's metadata is a different width, so nothing forms a
column and the eye re-parses every line.

- `ReviewStrip.tsx` — `+additions` / `−deletions` get wrapped in one `.rv-diff` span
  so the pair is a single column. Both remain separate elements; `ReviewStrip.test.tsx`
  queries `.add` and `.del` individually and must keep working.
- `deckStyles.ts` — fixed widths: `.rv-size` centred, `.rv-diff` right-aligned,
  `.rv-files` right-aligned, `.rv-ci` centred, `.rv-author` ellipsised, `.rv-age`
  right-aligned.
- `.rv-repo` also takes a fixed width with ellipsis, with the full name in a `title`,
  so every row's title starts at the same x. Repo names run from 7 to 20+ characters,
  which is ~80px of raggedness on the left edge of the one field that gets read;
  truncating the rare long name costs less than that. The number keeps its own narrow
  right-aligned column.

### Narrow panels

The fixed widths total roughly 300px and `.rv-title` is the only element that can
shrink, so a narrow panel would overflow. A width breakpoint releases the fixed
widths back to `auto`, returning the row to exactly today's behaviour. `preview/shoot-narrow.js`
is the harness for checking it.

## 3. Loading state

Today the strip shows nothing for several seconds after the panel opens, then appears
and shoves the board down. Two separate causes, two fixes.

### Post the cache before the board build

`refresh()` only reaches `enqueueReviews` after `await this.buildAll()` — git per repo
and Jira per run — so even a perfectly good on-disk cache waits behind the whole board.
The `deck:ready` handler reads the cache and posts it before starting the refresh. On a
warm machine the queue is present on first paint and no pending state is ever seen.

### A pending state for cold start

For the genuinely-empty case (first run, or a cache that was never written):

- `types.ts` — `deck:reviews` gains `loading: boolean`.
- `deckView.ts` — `postReviews()` stops returning silently when `reviewCache` is null.
  It posts `enabled: true, loading: true` with empty rows instead.
- `ReviewStrip.tsx` — renders when `loading || stale || requests.length > 0` rather
  than only on a non-empty queue. While loading: the header shows a spinner and
  "checking for PRs waiting on your review…", three shimmer skeleton rows stand in for
  the real ones, and the sort control is omitted because there is nothing to sort.
  Collapsed still means collapsed — the header alone, no skeletons.
- `DeckApp.tsx` — the "To review" stat tile shows the spinner glyph in place of its
  number while loading.

Skeleton rows rather than a bare header so the strip reserves its height up front and
the board settles once instead of twice. Three is a guess at the count and will
sometimes be wrong; being wrong by a row or two is cheaper than the full-height jump.

### The failure case

A cold-start search that fails sets `reviewStale` with the cache still null. `loading`
is derived as "no cache **and** not stale", so that combination renders the existing
stale note rather than shimmering forever.

### Motion

The shimmer sits behind the `prefers-reduced-motion` query `BASE_CSS` already declares,
as does the header spinner.

## Testing

Behaviour changes need tests, per CONTRIBUTING.

- `test/webview/ReviewStrip.test.tsx` — renders on `loading` with no rows; skeleton
  count; no sort control while loading; collapsed hides skeletons; stale-with-no-cache
  shows the note, not the shimmer; `.add`/`.del` still individually queryable inside
  `.rv-diff`.
- `test/webview/DeckApp.test.tsx` — the Review queue pill posts `deck:setReviewQueue`
  and reflects `deck:runs`; the "To review" tile spins while loading and shows the
  number after.
- The deckView suite — `reviewsEnabled()` follows the field, not the config;
  `deck:setReviewQueue` off posts `enabled: false`; `deck:ready` posts the cached queue
  before the board build; `postReviews()` posts `loading: true` with a null cache.

## Gates

Every one of these must pass before this lands:

- `npm run typecheck` — clean.
- `npm test` — full Vitest suite green.
- `npm run test:cov` — thresholds enforced: statements 90, branches 85, functions 85,
  lines 90.
- `npm run build` — esbuild bundles the host and both webviews.

Install with the public registry (`npm ci --registry https://registry.npmjs.org`) and
leave `package-lock.json` free of private-registry URLs; the repo pins the registry in
`.npmrc` for this reason.

## Out of scope

- The expanded row detail. The stranded "Open PR" button it used to show was already
  fixed (`deckStyles.ts`, `.rv-actions { margin-left: 0 }`); the layout is fine as it
  stands.
- Moving the queue off the strip — a right rail, a fifth board column, and a drawer
  were all considered and rejected in favour of keeping the strip and fixing the rows.
- Persisting the toggle to settings. It matches its neighbours by staying session-only.
