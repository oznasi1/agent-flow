# Adding a forge

Agent Flow reads pull requests, CI and review requests through a seam, not a
hardwired dependency on GitHub. This guide is for whoever writes forge #3: what
the seam requires, what degrades gracefully when a forge can't answer something,
and where the seam doesn't reach — so you find those here instead of in a bug
report.

This guide is meant to be true, not encouraging.

## What a forge is

One interface, `Forge`, declared in `src/engine/forge/types.ts`: an id, a label, a
CLI to locate and probe, a capability record, and three providers — `prs`
(`PrProvider`), `reviews` (`ReviewProvider`), and `branchCi`.

`agentFlow.forge` selects the active forge by id. Two are registered: `github`,
which is the shipped default, and `gitlab`. `src/engine/forge/registry.ts`'s
`FORGES` map is the full list; `FORGE_IDS` is exported so the manifest, the
telemetry allowlist and the registry test all derive from it instead of a second
hand-written list that can drift.

**Every registered id must appear in this file wrapped in backticks** —
`test/unit/docs.test.ts` asserts it, so a new forge cannot ship undocumented.

## The one hard constraint

`src/engine/forge/*` imports `child_process`. It must never be imported — even
transitively — by `src/webview/*`, `conditions.ts`, `branchCi.ts`, or
`armability.ts`, all of which are bundled into the webview. A violation is caught
**only** by `npm run build`: `npm run typecheck` and the full Vitest suite pass
regardless. `test/webview/webviewGraph.test.ts` pins the boundary.

This is why a forge's capabilities reach `armability.ts` as a plain
`{ changesRequested: boolean }` rather than as an imported `Forge`.

`src/engine/forge/types.ts` looks like the safe exception — it holds only
interfaces, no runtime code — but its safety is entirely owed to writing every
one of its imports as `import type`, which is erased at build time. Drop that
keyword as a "cleanup" on a file that's "just types" and it reaches
`child_process` through `../pr/provider` exactly like every other file in this
directory. Treat it as no safer to import from webview code than `github.ts` or
`gitlab.ts`.

## What GitLab cannot answer

| Question | GitHub | GitLab | What the Deck does |
|---|---|---|---|
| Has a reviewer requested changes? | `reviewDecision` | not exposed | `review` never reads `changes_requested`; arming names the `changes-requested` rule as unfirable |
| Is a review thread outdated? | `isOutdated` | not exposed | the unresolved count is slightly more inclusive |
| Submit "request changes" | one verb | no stable verb | posts a note and withdraws any standing approval, disclosed in the confirmation dialog |
| Diff size in the review queue | in the search | not in the list | filled on row expansion; `additions`/`deletions` stay 0 because GitLab's REST API exposes no aggregate, so only the file count is real |
| How many reviews are waiting in total? | `issueCount` | no total in the body | the count is however many rows came back, so a queue longer than 50 reads as complete rather than truncated |
| Is a skipped required check green? | folded toward `SUCCESS` | `skipped` → `unknown` | GitLab is stricter; a skipped pipeline does not open a deploy gate |

## Conventions a new forge must keep

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
