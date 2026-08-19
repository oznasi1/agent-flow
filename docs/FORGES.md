# Adding a forge

Agent Flow reads pull requests, CI and review requests through a seam, not a
hardwired dependency on GitHub. This guide is for whoever writes forge #3: what
the seam requires, what degrades gracefully when a forge can't answer something,
and where the seam doesn't reach — so you find those here instead of in a bug
report.

This guide is meant to be true, not encouraging.

## 1. What a forge is

```ts
export interface Forge {
  readonly id: string;
  readonly label: string;
  readonly cli: { name: string; installUrl: string };
  readonly caps: ForgeCaps;
  probe(): Promise<ForgeGap | null>;
  readonly prs: PrProvider;
  readonly reviews: ReviewProvider;
  branchCi(repoPath: string, branch: string): Promise<BranchCiStatus>;
}
```

Declared in `src/engine/forge/types.ts`, alongside `ForgeCaps` (what a forge can
answer — today, just `changesRequested`) and `ForgeGap` (why `probe()` came back
unhappy: `missing` or `signed-out`). `prs` is a `PrProvider`, `reviews` a
`ReviewProvider` — both declared in `src/engine/pr/provider.ts` and
`src/engine/review/provider.ts`, and shared with the pre-seam `gh`-only code
they replaced.

`agentFlow.forge` selects the active forge by id. Two are registered: `github`,
which is the shipped default, and `gitlab`. `src/engine/forge/registry.ts`'s
`FORGES` map is the full list; `FORGE_IDS` is exported so the manifest, the
telemetry allowlist and the registry test all derive from it instead of a second
hand-written list that can drift.

**Every registered id must appear in this file wrapped in backticks** —
`test/unit/docs.test.ts` asserts it, so a new forge cannot ship undocumented.

## 2. The one hard constraint

`src/engine/forge/*` imports `child_process` and must never be imported — even
transitively — by anything the webview bundles.

Two files this reaches through are on that graph **today**: `conditions.ts` and
`branchCi.ts`. `OrchestratorDrawer.tsx` imports `conditions.ts` directly, and
`conditions.ts` imports `branchCi.ts` — both already compile into `dist/deck.js`,
so a `../forge/` import in either one breaks the real build right now. A
violation there is caught **only** by `npm run build`: `npm run typecheck` and
the full Vitest suite pass regardless, because Vitest runs in Node, where every
Node builtin resolves fine. `test/webview/webviewGraph.test.ts` pins this by
walking the real import graph from every browser entry point.

`armability.ts` is different, and the difference matters: as of this writing it
is **not** reachable from any of the three browser bundles. Its only importer
anywhere is the host-side `src/deckView.ts`, which reduces its result to a
plain toast string before anything reaches the webview — so a `../forge/`
import there would **not** break `npm run build` today, and the paragraph above
does not yet apply to it. It is nonetheless written as a pure module that takes
the forge fact as plain data (`{ changesRequested: boolean }`) rather than an
imported `Forge`, because a later task very plausibly wires `unfirableRules`
directly into `OrchestratorDrawer.tsx` for client-side rendering. The negative
control in `test/webview/webviewGraph.test.ts` pins that promise **ahead of**
the wiring — it walks from `armability.ts` itself rather than from `deck.tsx` —
so today it is future-proofing, not an active net `npm run build` already
provides for this one file. The day something under `src/webview/` imports
`armability.ts`, this paragraph's warning becomes as forceful as the one above
for `conditions.ts` and `branchCi.ts`, and should be rewritten to say so.

`src/engine/forge/types.ts` looks like the safe exception — it holds only
interfaces, no runtime code — but its safety is entirely owed to writing every
one of its imports as `import type`, which is erased at build time. Drop that
keyword as a "cleanup" on a file that's "just types" and it reaches
`child_process` through `../pr/provider` exactly like every other file in this
directory. Treat it as no safer to import from webview code than `github.ts` or
`gitlab.ts`.

## 3. What GitLab cannot answer

| Question | GitHub | GitLab | What the Deck does |
|---|---|---|---|
| Has a reviewer requested changes? | `reviewDecision` | not exposed | `review` never reads `changes_requested`; arming names the `changes-requested` rule as unfirable |
| Is a review thread outdated? | `isOutdated` | not exposed | the unresolved count is slightly more inclusive |
| Submit "request changes" | one verb | no stable verb | posts a note and withdraws any standing approval, disclosed in the confirmation dialog |
| Diff size in the review queue | in the search | not in the list | filled on row expansion; `additions`/`deletions` stay 0 because GitLab's REST API exposes no aggregate, so only the file count is real |
| How many reviews are waiting in total? | `issueCount` | no total in the body | the count is however many rows came back, so a queue longer than 50 reads as complete rather than truncated |
| Is a skipped required check green? | folded toward `SUCCESS` | `skipped` → `unknown` | GitLab is stricter; a skipped pipeline does not open a deploy gate |

## 4. Conventions a new forge must keep

- **`null` from `reviews.search()` means the attempt failed**, never "you owe
  nobody a review". An empty array is a success meaning the queue is empty.
- **`{ ok: false }` from `prs.fetch()` means the attempt failed**;
  `{ ok: true, facts: null }` means there is genuinely no PR. Nothing may throw
  out of `fetch` — an uncaught throw leaves the caller's cache entry unstamped,
  which re-arms that repo's fetch on every tick, forever.
- **`branchCi` answers `"unknown"` rather than throwing**, and `"unknown"` is not
  green.
- **A review body must never reach an error message.** Prefer a rejection's
  `stderr` over its `.message`, which is `Command failed: <file> <argv joined>`
  and embeds the body. Keep the timeout branch's distinct wording: a killed
  process may already have reached the server.
- **Spawn through the injected `Runner`**, so no test forks a process, and locate
  the CLI through `resolveBin`, whose Homebrew/MacPorts fallbacks cover the bare
  launchd PATH the extension host inherits when the editor gives up resolving the
  user's shell environment.
