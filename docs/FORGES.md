# Adding a forge

Agent Flow Deck reads pull requests, CI and review requests through a seam, not a
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
  accounts(): Promise<ForgeAccount[]>;
  switchAccount(login: string): Promise<{ ok: true } | { ok: false; message: string }>;
  readonly prs: PrProvider;
  readonly reviews: ReviewProvider;
  branchCi(repoPath: string, branch: string): Promise<BranchCiStatus>;
}
```

Declared in `src/engine/forge/types.ts`, alongside `ForgeCaps` (what a forge can
answer — `changesRequested`, `reviewSearch` (see §7), `accounts`: whether
its CLI has a multi-account model it can report and change, and `gateRouting`:
whether `gates` can post a routed gate's question on a PR and read the reply), `ForgeAccount` (one
such account: `login`, `active`, `scopes`) and `ForgeGap` (why `probe()` came
back unhappy: `missing` or `signed-out`). `prs` is a `PrProvider`, `reviews` a
`ReviewProvider` — both declared in `src/engine/pr/provider.ts` and
`src/engine/review/provider.ts`, and shared with the pre-seam `gh`-only code
they replaced. `Forge` also carries an optional `resolveCaps()` — see §7 — for a
forge whose true capability cannot be known until its CLI has been probed.

`agentFlow.forge` selects the active forge by id. Three are registered: `github`,
which is the shipped default, `gitlab`, and `bitbucket`.
`src/engine/forge/registry.ts`'s `FORGES` map is the full list; `FORGE_IDS` is
exported so the manifest, the telemetry allowlist and the registry test all
derive from it instead of a second hand-written list that can drift.

**Every registered id must appear in this file wrapped in backticks** —
`test/unit/docs.test.ts` asserts it, so a new forge cannot ship undocumented.

## 2. The one hard constraint

`src/engine/forge/*` imports `child_process` and must never be imported — even
transitively — by anything the webview bundles. `src/engine/pr/bb/provider.ts`
reaches `child_process` the same way `pr/glab/provider.ts` does, through the
injected `Runner`'s `execRunner`, and is subject to the identical rule. Its
siblings `pr/bb/pr.ts`, `pr/bb/projected.ts` and `pr/bb/rest.ts` are pure — no
import of `provider.ts`, `child_process`, or anything else that reaches it — so
splitting the wire-shape mappers out of `provider.ts` is what keeps them safe to
reference from anywhere, even though nothing under `src/webview/` needs them
today.

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

## 3. What GitLab and Bitbucket cannot answer

| Question | GitHub | GitLab | What the Deck does |
|---|---|---|---|
| Has a reviewer requested changes? | `reviewDecision` | not exposed | `review` never reads `changes_requested`; arming names the `changes-requested` rule as unfirable |
| Is a review thread outdated? | `isOutdated` | not exposed | the unresolved count is slightly more inclusive |
| Submit "request changes" | one verb | no stable verb | posts a note and withdraws any standing approval, disclosed in the confirmation dialog |
| Diff size in the review queue | in the search | not in the list | filled on row expansion; `additions`/`deletions` stay 0 because GitLab's REST API exposes no aggregate, so only the file count is real — and GitLab caps `changes_count` at `"20+"`, which `readSize` reads as its FLOOR, so an 80-file MR renders as `20 files` with nothing marking it as approximate |
| CI status in the review queue | in the search | not in the list | the chip reads `none` until the row is expanded, where the single-MR read supplies the verdict — the same trade as the diff size, for the same reason: one call per row the user opens, never 50 per refresh |
| CI status on a card | in the PR query | not in the MR list | `prs.fetch` follows its list call with a single-MR read, because that is the only response carrying `head_pipeline` |
| How many reviews are waiting in total? | `issueCount` | no total in the body | the count is however many rows came back, so a queue longer than 50 reads as complete rather than truncated |
| Is a skipped required check green? | folded toward `SUCCESS` | `skipped` → `unknown` | GitLab is stricter; a skipped pipeline does not open a deploy gate |
| Merge with a named strategy | `--squash` / `--merge` / `--rebase` on `gh pr merge` | `squash=true`/`false` on `PUT …/merge_requests/:iid/merge`, issued through `glab api` — the only per-request override there is; the project's own **Merge method** setting decides whether a merge is rebased or fast-forwarded | `agentFlow.mergeMethod: rebase` is REFUSED with a message naming the setting, never silently merged another way — a substituted merge strategy is the one degradation a user cannot see afterwards. **This whole row is untested against a live `glab`** — see below |
| Post a routed gate's question and read the reply | `gh api repos/{owner}/{repo}/issues/:n/comments` (post and read, `since=`) | `glab api projects/:id/merge_requests/:iid/notes` (post; read oldest-first, system notes dropped) | Both declare `caps.gateRouting`. **Bitbucket does not**: a gate routed on it stamps `routed.error` naming the forge, stays answerable on the node, and the drawer says so. See [Routing a gate to someone](ORCHESTRATOR_COMMANDS.md#routing-a-gate-to-someone). |
| Which account is reading the board, and switching it | `gh auth status --json hosts` / `gh auth switch` | `glab` stores one token per host with no multi-account model and no `auth switch` equivalent | `caps.accounts: false`; the footer legend names no identity and offers no switch — today's behavior, unchanged, rather than a fabricated single-entry list |

**Account enumeration is `github.com`-only.** `accounts()` reads a single fixed
host (`GH_HOST` in `github.ts`) and ignores every other host in the same `gh`
config, including a GitHub Enterprise instance. A user authenticated to both
`github.com` and a GHE host, doing their real work against GHE repos, still gets
a footer naming whichever `github.com` login is active and a switch that changes
an identity that reads none of their repos — the legend and the switch both
answer a question about a host the user may not be working against at all. Agent
Flow has no per-repo or per-host forge concept today, so the real fix (binding an
identity to the host a repo's remote actually points at) is out of scope here;
this is a known limitation, not an oversight.

### Bitbucket has two modes

`bitbucket` (via the `atlassian-cli` CLI) is not one forge with one capability
set — it is two, selected by which build of the CLI is installed. Verified by
reading `crates/cli/src/commands/bitbucket/` at `omar16100/atlassian-cli@main`:
every `bb` subcommand deserializes Bitbucket's API response into a narrow
hand-written row struct and re-serializes *that*, dropping the PR url, the
draft flag, mergeable/conflict state, per-PR CI, per-reviewer identity,
comment-resolution state and diff size along the way. A raw `bb api` passthrough
exists in the CLI's own codebase — it is simply not wired to the Bitbucket
command group yet (see the design spec's Appendix A for the four-line patch).
Until it lands and ships, every install runs **projected** mode; once it does,
an install on the newer build runs **passthrough** mode and gets parity with
GitHub and GitLab on nearly everything below.

Detected with `atlassian-cli bb api --help`: exit 0 means passthrough, a clap
"unrecognized subcommand" error means projected. `--help` is handled at parse
time, before workspace resolution and before any HTTP call, so detection costs
no network round trip, needs no repo, and works signed out. Probed once per
Deck session, memoized for the panel's entire life, and survives settings
changes — a newly installed or upgraded `atlassian-cli` is picked up on a window reload.

`caps.reviewSearch` is `false` in **both** modes — this is not a mode
difference. Bitbucket Cloud has no cross-repo "which PRs are waiting on my
review" endpoint at all; the only workspace-level query,
`GET /2.0/workspaces/{ws}/pullrequests/{user}`, returns PRs *authored by* that
user, not PRs assigned to them as a reviewer. That is an API limit, not a CLI
one, so a future passthrough build does not fix it. The review-requests strip
is hidden on Bitbucket rather than shown empty or stale.

Doctor reports which mode a Bitbucket install is running, not just whether the
CLI is signed in — its Bitbucket group renders a mode row reading
`passthrough (full)` or `projected (limited — upgrade atlassian-cli for full
support)` (`FORGE_MODE_PASSTHROUGH` / `FORGE_MODE_PROJECTED` in
`src/engine/doctor.ts`). Doctor is where a user goes when the board looks
wrong, and "your board is mostly empty because you're on projected mode" is
the answer they need to find there — a Bitbucket card in projected mode shows
branch CI and little else.

### What each mode answers

| Question | GitHub | GitLab | BB passthrough | BB projected |
|---|---|---|---|---|
| Find PR by branch | `--head` | `source_branch=` | `q=source.branch.name` | client-side over 25 rows |
| Find PR by Jira key | `in:title` | `search=&in=title` | `q=title~` | client-side substring |
| PR url | yes | yes | `links.html.href` | **synthesized** |
| Draft | `isDraft` | `draft` | `draft` | **always false** |
| Mergeable | `mergeable` | `detailed_merge_status` | `/conflicts` | **`unknown`** |
| Approved? | `reviewDecision` | approvals call | `participants[].state` | **`none`** |
| Changes requested? | `reviewDecision` | **not exposed** | `participants[].state` | **`none`** |
| Merge with a named strategy | all three | squash/merge only, rebase refused | all three (`merge_strategy` accepts `rebase_merge`) | squash/merge_commit only, rebase refused |
| Unresolved threads | GraphQL | discussions | `comment.resolution` | **`null`** |
| CI on a card | in the query | single-MR read | `/statuses` | pipeline verdict only |
| Branch CI | rollup | newest pipeline | newest pipeline | newest pipeline |
| Diff size in queue | in the search | file count only | **n/a** | **n/a** |
| Reviews waiting on me | search | `reviews_for_me` | **none** | **none** |

Passthrough mode beats GitLab on one row — changes-requested — and on merge
strategy, where GitLab cannot rebase at all but Bitbucket's REST
`merge_strategy` enum accepts `rebase_merge`. It matches GitLab everywhere else
except the review queue, which neither answers. Projected mode is a card with
CI and little else.

Diff size is **n/a in both Bitbucket modes**, and that is a consequence of the
row below it rather than a gap of its own: diff size is a fact about a REVIEW
QUEUE ROW, and Bitbucket has no review queue in either mode. `BbReviewProvider.detail()`
accordingly makes no `/diffstat` call — there is no row for it to fill.
Bitbucket's `/diffstat` route would give real additions and deletions if the
strip were ever reachable here, which is more than GitLab's file-count-only
answer; until it is, this table says n/a rather than claiming a capability the
code does not have. An earlier draft of this table claimed `diffstat` real for
passthrough, which was never true of the shipped code.

### Bitbucket merge is untested — stated, not verified

**The Bitbucket merge path has never been run against a live `atlassian-cli`.**
No one on this project has it installed, and it is not on the CI image — every
wire shape here, merge included, comes from reading the CLI's Rust source and
Bitbucket's OpenAPI spec, not from a real response. That is a genuinely
stronger footing than guessing at undocumented CLI flags, and it is still not
verification. A Bitbucket user's first press of **Merge** is also this code's
first real execution, exactly as GitLab's is below — this project has now
shipped that gap twice, and both are recorded rather than quietly papered over.

Merge is mode-dependent, which is its own source of risk beyond "unverified":

- **Passthrough** issues `bb api '/2.0/repositories/{ws}/{slug}/pullrequests/{id}/merge' -X POST -d '{"merge_strategy":"<strategy>"}'`.
  Bitbucket's OpenAPI `pullrequest_merge_parameters` schema lists `merge_strategy`
  as an enum of `merge_commit`, `squash`, `fast_forward`, `squash_fast_forward`,
  `rebase_fast_forward` and `rebase_merge` — covering all three of Agent Flow's
  merge methods, matching GitHub and beating GitLab. **`rebase_merge` is real in
  that schema and re-verified against it, and like everything else in this
  section it has never been exercised against a live instance** — the enum is a
  documented contract, not a response anyone here has seen come back.
- **Projected** issues `bb pr merge <slug> <id> --strategy <strategy> --format json`.
  `bb pr merge --help` documents only `merge_commit`, `squash` and
  `fast_forward` for `--strategy` — no rebase — so `agentFlow.mergeMethod:
  rebase` is **refused before any CLI call**, with a message naming the setting,
  exactly the same discipline GitLab's refusal below follows. Nothing is quietly
  substituted; the argument is untyped on the CLI side, so silently forwarding
  `rebase_merge` anyway was considered and rejected as a guess this design will
  not make.

If you use Bitbucket and press **Merge**, the output channel records the mode,
the strategy, and whatever `atlassian-cli` came back with — please open an
issue with what you saw either way.

### GitLab merge is untested — stated, not verified

**The GitLab merge path has never been run against a live `glab`.** `glab` was not
installed on any machine this feature was built on. What `GlabProvider.prs.merge`
actually runs is the REST passthrough, not the porcelain:

```
glab api projects/:fullpath/merge_requests/<iid>/merge --method PUT -F squash=<bool>
```

— the same `glab api` mechanism every other call in that provider goes through. The
route was chosen for exactly the reason this section exists: `glab mr merge`'s flags
and output could not be pinned without a live `glab`, whereas GitLab's documented
REST contract for `PUT …/merge` can be. So `merge()` was written against that
contract and is covered by unit tests on the argv it produces — and nothing else. A
GitLab user's first press of **Merge** is also its first real execution.

A documented request contract is a genuinely stronger footing than a CLI's flags,
so this is not quite the mistake the section immediately below records — fixtures
written from the docs rather than from a response. What is unproven here is
everything on the way *back*, and it is recorded rather than quietly shipped. Three
things, in the order they are likely to bite:

- whether the call succeeds at all against a real project, and what `glab api`
  prints on success;
- whether a refusal (an unapproved MR, a failing pipeline, a protected branch) comes
  back as a non-zero exit with GitLab's own message on stderr — which is what the
  failure toast assumes, and `glab api` is the layer that decides it;
- whether the `rebase` refusal — which Agent Flow Deck raises itself, before any CLI
  call — is the right call for a project whose **Merge method** is already
  *fast-forward*.

If you use GitLab and press **Merge**, the output channel records the strategy and
whatever `glab api` came back with — please open an issue with what you saw,
whichever way it went.

### The MR list carries no pipeline data — verified, not assumed

`GET /projects/:id/merge_requests` returns **no pipeline field of any kind**: not
`head_pipeline`, not a substitute. `head_pipeline` appears only on
`GET /projects/:id/merge_requests/:iid`. Checked against gitlab.com's live API,
because the documented list-response shape reads as though it were there — which is
exactly how Agent Flow Deck first shipped GitLab support reading CI off a list row, with
every card silently showing no CI and every test agreeing, since the fixtures were
written from the docs.

Two consequences, both deliberate:

- `GlabProvider.fetch` makes **one extra single-MR read** per card that has an MR.
  That is what makes a GitLab card's CI status possible at all, so it is not a round
  trip to optimise away; `prFactsTtlSeconds` governs how often it happens. If the
  read fails, the provider falls back to the list row — the MR's identity, state,
  title, draft flag and mergeability are all correct there, so a failure costs the CI
  tally and nothing else.
- The review strip's CI chip is filled **on row expansion**, from the single-MR read
  `reviews.detail` already makes, and rides back on the optional `ReviewDetail.ci`.
  Doing that GET per queue row would be 50 calls per refresh — the same cost the diff
  size chip already declined.

If you are writing forge #3: check a real response before typing a wire shape, and
write fixtures from what came back, not from what the docs list.

## 4. Conventions a new forge must keep

- **`null` from `reviews.search()` means the attempt failed**, never "you owe
  nobody a review". An empty array is a success meaning the queue is empty.
- **`{ ok: false }` from `prs.fetch()` means the attempt failed**;
  `{ ok: true, facts: null }` means there is genuinely no PR. Nothing may throw
  out of `fetch` — an uncaught throw leaves the caller's cache entry unstamped,
  which re-arms that repo's fetch on every tick, forever.
- **`branchCi` answers `"unknown"` rather than throwing**, and `"unknown"` is not
  green.
- **`probe()` passing does not promise the reads will work.** It asks a global
  question — is the CLI here, is it signed in — and cannot see a per-repository
  answer, so an account signed in fine but unable to resolve a private repository
  returns `null` from `probe()` and `{ ok: false }` from every `fetch`. That
  combination is surfaced rather than hidden: the entry keeps `error: true`, the
  card leads with `⚠ PR unread`, the board's footer counts the affected runs, and
  Doctor's `PR reads` row sits beside a CLI row that is honestly green. Nothing
  that acts on a pull request — the Merge button, a card's problem rows — may read
  an `error: true` entry's facts, because they are the previous value carried
  forward. Unreadable is not merged, and it is not green.
- **A review body must never reach an error message.** Prefer a rejection's
  `stderr` over its `.message`, which is `Command failed: <file> <argv joined>`
  and embeds the body. Keep the timeout branch's distinct wording: a killed
  process may already have reached the server.
- **Spawn through the injected `Runner`**, so no test forks a process, and locate
  the CLI through `resolveBin`, whose Homebrew/MacPorts fallbacks cover the bare
  launchd PATH the extension host inherits when the editor gives up resolving the
  user's shell environment.
- **A forge whose capability depends on its CLI's version states the weaker
  mode in its static `caps` and the truth from `resolveCaps()`.** `bitbucket`'s
  static `caps.changesRequested` is `false` — the safe answer for a fresh
  install, which is always on projected mode until Appendix A ships — and
  `resolveCaps()` reports `true` once the CLI has actually been probed and
  found to have `bb api`. Anything that reads `caps` synchronously (a pure
  module like `armability.ts`, which must not import this directory) sees only
  the static, conservative value; only `deckView`'s `caps()` accessor, which
  awaits `resolveCaps()` once per session, sees the live one. Getting this
  backwards — a static `caps` that claims the stronger mode — would let
  `armability.ts` promise an orchestrator rule that a projected build can never
  actually fire.
