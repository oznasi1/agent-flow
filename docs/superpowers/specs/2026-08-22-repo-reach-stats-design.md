# All-time reach: preserving install and traffic history

**Date:** 2026-08-22 · **Surface:** maintainer tooling (`scripts/reach/`, a scheduled workflow, a
generated dashboard) · **Status:** implemented

GitHub's Insights → Traffic tab shows fourteen days and no more. This design does not widen that
window — nothing can. It starts a durable record beside it, so that fourteen days from now the
project has fifteen days of history, and a year from now it has a year.

The scope is **reach**: how many people find the project and install it. It is the outside-in
counterpart to [the usage-analytics design](2026-07-31-usage-analytics-design.md), which measures
what users *do* once inside. That spec opens by noting "install counts on the Marketplace are the
only signal" — this one keeps that signal from evaporating.

## The problem in one fact

`GET /repos/{owner}/{repo}/traffic/views` and `/traffic/clones` return exactly fourteen daily
buckets. There is no `since` parameter, no pagination, no plan that extends it. GitHub discards
older traffic data permanently. Every day that passes without a collector destroys a day.

Measured on 2026-08-22, the repo (created 2026-07-19) looked like this:

| Signal | Value | History available |
| --- | --- | --- |
| Views | 97 total / 9 unique | **2026-08-08 → 08-21 only** |
| Clones | 290 total / 105 unique | **2026-08-08 → 08-21 only** |
| Referrers | Google 21/3, github.com 16/1, open-vsx.org 10/1 | 14 days, top-10 snapshot |
| Popular paths | `/oznasi1/agent-flow` 34/6, then contributors, forks, pulls | 14 days, top-10 snapshot |
| Stars | 2 (2026-07-23, 2026-07-27) | Full history via `starred_at` |
| Forks | 1 | Full history via `created_at` |
| Open VSX | 18,596 downloads, 4 reviews | **Running total only — no history** |
| VS Marketplace | 1,066 downloads, 11 installs, 4.45 rating | **Running total only — no history** |

Two conclusions drove the design. **Three weeks are already gone**: views and clones for
2026-07-19 → 08-07 are unrecoverable. And **GitHub traffic is the small slice** — Open VSX has
18,596 downloads against 290 clones, yet neither marketplace exposes any history at all. The
metric that matters most is the one with the least memory.

## The window is self-healing

Each traffic call returns fourteen *daily buckets*, not a rolling total. A collector that runs at
least once every fourteen days therefore loses nothing — a missed week backfills on the next run.
The marketplace counters are cumulative, so a skipped day costs resolution, never correctness.

This is load-bearing. It means the design needs **no reliable always-on infrastructure**, no
retries, no alerting, and no worry about a runner outage. A daily cron with a wide tolerance for
failure is sufficient, and even a hand-triggered run twice a month would preserve everything.

## Scope

**In:** a zero-dependency collector at `scripts/reach/`, a durable store on an orphan `reach-data`
branch, a generated self-contained HTML dashboard, and a scheduled workflow at
[.github/workflows/reach.yml](../../../.github/workflows/reach.yml).

**Out, deliberately:**

- **Backfilling lost traffic.** Impossible. Stated here so no one tries.
- **Development activity** — commits, PR throughput, contributors, release cadence. GitHub already
  retains all of it, all-time, for free in Pulse and Contributors. Rebuilding it would buy
  presentation, not preservation.
- **Any change to the extension.** Nothing in `src/` is touched. This ships no user-facing
  behaviour and therefore takes no CHANGELOG entry, which CLAUDE.md scopes to user-facing change.
- **GitHub Releases download counts.** The repo publishes no GitHub releases; the `.vsix` goes to
  the two marketplaces by hand. If that changes, the collector gains a source.
- **A private data store.** Ruled on explicitly: the numbers may be public.

## Architecture

Four pieces, each doing one thing.

### 1. Collector — `scripts/reach/collect.mjs`

Node's native `fetch`, no dependencies, matching the existing `.mjs` precedent in
[scripts/verify-report.mjs](../../../scripts/verify-report.mjs). Seven endpoints across three
services, once per run:

| Source | Endpoint | Shape |
| --- | --- | --- |
| Views | `/repos/{o}/{r}/traffic/views` | 14 daily buckets |
| Clones | `/repos/{o}/{r}/traffic/clones` | 14 daily buckets |
| Referrers | `/traffic/popular/referrers` | top-10 snapshot |
| Paths | `/traffic/popular/paths` | top-10 snapshot |
| Stars | `/stargazers` + `Accept: application/vnd.github.star+json` | full history, paginated |
| Open VSX | `https://open-vsx.org/api/oznasi1/oznasi1-agent-flow` | `downloadCount`, `reviewCount`, `version` |
| VS Marketplace | `POST /_apis/public/gallery/extensionquery`, `flags: 914` | `install`, `downloadCount`, `updateCount`, `weightedRating` |

All GitHub calls together cost well under ten requests against a 5,000/hour authenticated limit.
Rate limiting is not a concern and needs no handling.

### 2. Store — orphan `reach-data` branch

```
traffic/views.json                    { "2026-08-08": { count, uniques }, … }
traffic/clones.json                   same shape
snapshots/referrers/2026-08-22.json   daily top-10
snapshots/paths/2026-08-22.json       daily top-10
marketplace.jsonl                     one JSON line per run
stars.json                            full history, rebuilt each run
meta.json                             { firstCollected, lastRun, schemaVersion }
```

An **orphan branch**, not `main`. CLAUDE.md records that several sessions land on `main` a day; a
daily data commit would put noise in every `git log` and widen every diff for no reader's benefit.
The data branch shares no history with `main` and is never merged.

Views and clones are keyed by date and merged. Referrers and paths cannot be merged — they are
top-10 rankings, not totals, and two snapshots do not compose — so each run writes a dated file
and the dashboard reads the series. `marketplace.jsonl` is append-only: one line per run, because
the value is a cumulative counter whose interest is entirely in how it moves.

### 3. Dashboard — `scripts/reach/render.mjs` → `index.html`

A single self-contained HTML file with inline SVG charts and no CDN, generated from the store and
committed beside it. What ships: latest-snapshot tiles for Open VSX downloads, VS Marketplace
downloads and installs, and total stars; and bar charts of daily views and daily clones. Theme-aware
light and dark.

The referrer series and the star timeline described in earlier drafts of this design did not ship
in the dashboard — see Follow-ups. The underlying data for both **is** being collected (`stars.json`
in full, and a dated snapshot per run under `snapshots/referrers/`), so nothing is lost by deferring
the chart; it can be added later from history already banked. A cumulative install curve across
Open VSX and VS Marketplace on dual axes was also considered and deferred for the same reason —
`marketplace.jsonl` already banks one line per run.

It must print **`recording since <firstCollected>`** prominently. For the first weeks the
history is one or two points; drawing a confident line through them would assert a trend that has
not been observed.

### 4. Workflow — `.github/workflows/reach.yml`

Daily `schedule` plus `workflow_dispatch`, `permissions: contents: write`. Entirely separate from
[ci.yml](../../../.github/workflows/ci.yml) so it can never block a PR — the CI gate stays exactly
`npm ci`, `npm run typecheck`, `npm test`, `npm run build`.

One known unknown: **the traffic API requires push access**, and whether the built-in
`GITHUB_TOKEN` satisfies it has not been verified. The fallback is a repo-scoped PAT in
`secrets.REACH_TOKEN`. This is confirmed on the first `workflow_dispatch` run, not assumed.

GitHub disables scheduled workflows after 60 days of repository inactivity. Given `main`'s pace
this is not a live risk, but the self-healing window means even a disabled cron loses nothing so
long as it is noticed within a fortnight.

## The merge rule

The API is authoritative for every date it returns. So:

- **Overwrite** any date present in the incoming payload.
- **Keep** every date not present in it.
- **Never delete** a date.

That single rule delivers three properties. Re-running on the same day is **idempotent** except
for the current day's partial count. Today's partial is **self-correcting** — tomorrow's fourteen
day window includes today and replaces it with the settled figure. And a gap of up to fourteen
days **backfills completely** with no special-case code.

## Failure posture: never write a zero

A source that fails must leave its file untouched. It must never record `0`. The collector exits
non-zero for the whole process when any source fails — not just for that source — since the
workflow only has one process-level exit code to observe; the per-source detail is in the
`failed: [{ source, error }]` array returned by `collect()` and logged to stderr.

This is the one rule whose violation is silent and expensive: a 403 from an expired token, written
as a zero, draws a cliff on the chart indistinguishable from a real collapse in traffic — and
because the store is append-only and the traffic window has moved on, the false zero can never be
corrected from upstream. A missing day is honest and repairable; a fabricated zero is neither.

A partial run is fine: three sources succeeding and two failing writes three files, and the next
run picks up the rest.

## Testing

`test/unit/reach/merge.test.ts` covers the pure merge function:

- Idempotency — merging the same payload twice equals merging it once.
- Overwrite-on-overlap — a revised count for an existing date wins.
- Old dates survive a payload that no longer mentions them.
- A gap spanning twenty days (an existing date plus a fresh fourteen-day payload with no overlap)
  backfills without loss.

And, with `fetch` stubbed, the collector-level failure posture: a source that returns 403 or times
out leaves its file byte-identical and never writes a zero, while its sibling sources still land.

Coverage thresholds are untouched: [vitest.config.ts](../../../vitest.config.ts) sets
`coverage.include` to `src/**`, so `scripts/**` sits outside the numerator and the denominator
both. The 90% lines / 85% branches gate cannot be moved by this work in either direction.

## Repo invariants respected

- **No new dependencies.** Native `fetch` covers all six sources (views, clones, referrers, paths,
  stars, marketplace), so [.npmrc](../../../.npmrc) and `package-lock.json` are untouched and the
  `E401` private-registry failure mode is not in play.
- **The webview graph is unaffected** — nothing under `src/` changes, so the browser bundles and
  `npm run build` are untouched.
- **No hardcoded organization values in the extension.** The collector is maintainer tooling for
  one known repo, not a shipped feature, so `oznasi1/agent-flow` and the two extension ids are
  constants at the top of the script rather than `agentFlow.*` settings.
- **Never break existing users.** No shipped surface changes; `test/unit/compat.test.ts` is
  untouched and the existing suite must pass unmodified.

## Honest limits

- **2026-07-19 → 08-07 views and clones are permanently lost.** No design recovers them.
- **Open VSX `downloadCount` is downloads, not people.** It counts CI pulls, updates and repeat
  installs. The dashboard labels it *downloads* and never *users*; 18,596 is not 18,596 humans.
- **No per-user or geographic data.** GitHub does not expose it, so nothing here can show it.
- **Referrers and paths are top-10 rankings.** Anything outside the top ten on a given day is
  invisible that day, and no summing across days recovers it.
- **The first run banks the current fourteen days**, so the record starts with a fortnight of
  history rather than zero. That is the one piece of luck available.

## Follow-ups

- Publish the dashboard via GitHub Pages from the `reach-data` branch once the shape settles.
- Add GitHub Releases download counts if the project ever publishes `.vsix` assets there.
- Consider a `reach` summary line in the company cycle report once several weeks of data exist.
- **Add a referrer series chart to the dashboard.** `snapshots/referrers/<date>.json` is already
  banked, one dated top-10 snapshot per run — the chart can be built from history that already
  exists once there's enough of it to be worth showing.
- **Add a star timeline chart to the dashboard.** `stars.json` already holds the full sorted
  `starred_at` history; this is a rendering gap only, not a data gap.
- **Add a cumulative install curve on dual axes.** `marketplace.jsonl` already banks one line per
  run for both Open VSX and VS Marketplace; the chart is deferred, the data is not.
