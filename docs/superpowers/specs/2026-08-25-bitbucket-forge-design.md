# Bitbucket support alongside GitHub and GitLab

**Date:** 2026-08-25
**Status:** design under review, not yet approved for an implementation plan

Agent Flow reads pull requests, CI, and review requests through the `Forge` seam
in `src/engine/forge/types.ts`. Two forges are registered: `github` (via `gh`)
and `gitlab` (via `glab`). This design adds `bitbucket` as forge #3, via the
`atlassian-cli` CLI, with GitHub still the default so no existing install
changes behavior.

This document is meant to be true rather than encouraging. Where Bitbucket
cannot answer a question the other two answer, it says so and says what the Deck
does instead.

The forge has **two modes**, because the CLI's capability differs by version.
That is the central fact of this design; §3 explains it, and every surface in §7
is specified twice.

## 1. Decisions

| Decision | Choice | Why |
|---|---|---|
| Deployment | Bitbucket **Cloud** only | Both live CLI candidates are Cloud-only. Server/DC gets a clear "not supported" rather than a half-working forge. |
| Transport | `atlassian-cli` | Keeps the seam's story uniform: every forge is a CLI the user installs and signs into, same as `gh` and `glab`. §2 records what was rejected. |
| Two modes | **passthrough** when `bb api` exists, **projected** when it does not | The CLI projects API responses into narrow row structs unless it has a raw passthrough. Without it the forge is nearly empty; with it, parity. §3. |
| Unlocking passthrough | Upstream PR to `omar16100/atlassian-cli` | ~4 lines: the generic `api.rs` already takes any `ApiClient`, and `bitbucket::execute` already has one. Appendix A. |
| Runtime capabilities | New optional `Forge.resolveCaps()` | `caps.changesRequested` differs by mode, and `ForgeCaps` is static data read synchronously. §4. |
| Default | `github`, unchanged | The compatibility guarantee is structural, not a promise backed by tests. |
| Review-requests strip | **Hidden on Bitbucket, in both modes** | Bitbucket Cloud has no cross-repo reviewer query. Not a CLI gap — an API one. New `ForgeCaps.reviewSearch` flag. §7.7. |
| Card CI | One extra call per card | Bitbucket puts CI on neither the PR list nor the PR object. Same trade GitLab makes for `head_pipeline`. |

**Non-goals.** Bitbucket Server / Data Center. Mixed forges in one workspace.
Token-based transport as an alternative to the CLI. Renaming any existing
setting, type, or condition kind. Creating pull requests — no forge does that
today.

## 2. Transport: what was rejected

Recorded because the obvious next question is "why not just hit the REST API",
and because the answer changes if the CLI landscape changes.

| Option | Verdict |
|---|---|
| Atlassian's official `acli` | **Impossible.** Its command groups are `admin`, `feedback`, `jira`, `rovodev`. No Bitbucket support at all (verified against `developer.atlassian.com/cloud/acli/reference/commands/`). |
| `craftamap/bb` | **Rejected.** The tool most people mean by "the Bitbucket CLI", closest in spirit to `gh` — but last release Oct 2023, last commit Jun 2025, 37 stars, and no JSON output of any kind. We would be parsing formatted tables. |
| `swisscom/bitbucket-cli` | **Rejected.** Server/DC only, dead since 2023. |
| REST via `curl` + a stored token | **Rejected by preference**, not by capability. It makes Bitbucket the one forge where `probe()` checks a credential rather than a binary, and where Agent Flow holds a token. The decision was to keep every forge a CLI. |
| `atlassian-cli` | **Chosen.** Actively maintained, `--format json` is a global flag, git-remote detection for `--workspace`, and — with Appendix A — a raw passthrough. |

## 3. The two modes

`atlassian-cli` does not pass Bitbucket's JSON through. Each command
deserializes the API response into a narrow hand-written row struct and
serializes *that*. Verified by reading `crates/cli/src/commands/bitbucket/` at
`omar16100/atlassian-cli@main`:

| Command | Every field `--format json` emits |
|---|---|
| `bb pr list <repo>` | `id`, `title`, `state`, `author` (display name), `source`, `destination` |
| `bb pr get <repo> <id>` | the above plus `description`, `created`, `updated`, `comments` (count), `tasks` (count), `approvals` (count) |
| `bb pr reviewers <repo> <id>` | `name` (display name), `role`, `status`, `participated_on` |
| `bb pr comments <repo> <id>` | `id`, `author`, `content`, `created`, `parent`, `location` |
| `bb pipeline list --branch X` | `build_number`, `state`, `ref_name`, `target_type` |

Absent everywhere: **no PR url**, no draft flag, no mergeable or conflict state,
no CI on a PR, no per-reviewer identity, no comment-resolution state, no diff
size. `bb pr diff` is a stub that prints a web URL and a "use the browser" note.
`--envelope` only wraps the same rows in `{items, count}`.

There is a generic `api` passthrough in the codebase — `bb api` simply is not
wired to it. Appendix A is the patch.

### 3.1 Detecting the mode

```
atlassian-cli bb api --help
```

Exit 0 → **passthrough mode**. A clap "unrecognized subcommand" exit → **projected
mode**. `--help` is handled at parse time, before workspace resolution and before
any HTTP, so this costs no network call, needs no repo, and works signed out.

Probed **once per Deck session**, memoized alongside `probe()` in
`deckView.ts:1658`, and reset with it when settings change (`deckView.ts:2992`).

### 3.2 Why both modes ship

Projected mode is what a user gets today, on the current release. Passthrough
mode is what they get once Appendix A lands and ships. Shipping only the
passthrough path would mean the forge does not work at all until an upstream
maintainer merges and cuts a release — a dependency this project does not
control. Shipping only the projected path forecloses the parity that is four
lines away.

The cost is honest and bounded: two fixture sets, and every surface in §7
specified twice. Neither existing forge is touched.

## 4. Runtime capabilities — a small seam addition

`caps.changesRequested` is `false` in projected mode (no verb to write it, no
uuid to read it) and `true` in passthrough mode (`POST …/request-changes` exists,
and `participants[].state` reads it back). But `ForgeCaps` is static data, read
synchronously at `deckView.ts:2392` and `deckView.ts:3194`.

So `Forge` gains one optional member:

```ts
/** Capabilities that cannot be known until the CLI has been probed — for a CLI
 *  whose command surface differs by version. Resolved once per Deck session,
 *  alongside `probe()`. A forge whose caps are fully static omits this, and the
 *  static `caps` stands. */
resolveCaps?(): Promise<ForgeCaps>;
```

`deckView` gains a `forgeCaps` field resolved in the same memoized block as
`probe()`, and a `private caps(): ForgeCaps { return this.forgeCaps ?? this.forge.caps; }`
used at both read sites.

`github` and `gitlab` omit `resolveCaps` entirely, so their static `caps` stands
and their behavior is byte-identical. `test/unit/compat.test.ts` freezes
settings, commands, telemetry values and the on-disk run shape — not this
interface — and the existing suite must pass **unmodified**.

`ForgeCaps` also gains:

```ts
/** Can this forge answer "which PRs are waiting on MY review"? False for a
 *  forge with no cross-repo reviewer query — the strip hides rather than
 *  reporting a permanent failure every TTL. */
reviewSearch: boolean;
```

Named `reviewSearch`, not `reviewQueue`: `deckView.ts` already has a field
called `this.reviewQueue` (the session's own Review-queue flag), and
`this.reviewQueue && this.caps().reviewQueue` is unreadable. `reviewSearch` maps
exactly onto `reviews.search()`, which is the capability in question.

The gate is `deckView`'s existing `reviewsEnabled()` — it already governs both
the enqueue and the `enabled: false` post, so one added conjunct covers both.

`github`/`gitlab` → `true`; `bitbucket` → `false` in **both** modes. See §7.7.

## 5. Shape

```
src/engine/forge/bitbucket.ts       makeBitbucketForge(run) → Forge
src/engine/pr/bb/provider.ts        BbProvider, probeBb, probeBbApi, BB_TIMEOUT_MS
src/engine/pr/bb/pr.ts              pure: remote parsing, pickPr, state maps
src/engine/pr/bb/projected.ts       pure: row structs → PrFacts (projected mode)
src/engine/pr/bb/rest.ts            pure: REST payloads → PrFacts (passthrough mode)
src/engine/review/bb/provider.ts    BbReviewProvider
```

Splitting the two mappers into their own pure modules is what keeps the dual
mode from becoming a thicket of conditionals: `provider.ts` decides which calls
to spawn, and each mapper only ever sees one wire shape. Same discipline as
`pr/glab/mr.ts` / `pr/glab/provider.ts`, one level further.

The binary is **`atlassian-cli`**. `bb` is a subcommand alias inside it
(`atlassian-cli bb pr list …`), not a second executable, so `resolveBin` looks
for `atlassian-cli` and gets the Homebrew/MacPorts fallbacks that cover the bare
launchd PATH the extension host inherits.

Every invocation carries `--format json` and spawns through the injected
`Runner` with `cwd: repoPath`, so no test forks a process.

### 5.1 The webview bundling constraint applies unchanged

`src/engine/forge/*` and `src/engine/pr/bb/provider.ts` reach `child_process`
and must never be imported — even transitively — from a browser entry point.
`pr.ts`, `projected.ts` and `rest.ts` are pure and safe, but nothing in
`src/webview/` needs them. `test/webview/webviewGraph.test.ts` walks the real
graph; `npm run build` is the only gate that catches a bare-specifier violation.

## 6. Probe and repo resolution

### 6.1 Probe

`bb auth test --bitbucket` — it authenticates against Bitbucket specifically and
carries a real exit code. `auth status` renders a table for all services and
`whoami` is Jira-shaped; neither fails cleanly on a missing Bitbucket credential.

`ForgeGap` is unchanged and shared: `ENOENT` → `missing`, anything else from a
CLI that actually ran → `signed-out`. Doctor's `forgeChecks` is already generic
over `{ label, cli, gap }`.

### 6.2 Repo slug — the one thing neither existing forge needs

`gh` and `glab` both infer the target repo from the git remote. `atlassian-cli`
does too for `--workspace` and for every `pipeline` subcommand — but
**`bb pr list <repo>` takes the slug as a required positional and ignores git
context** (`PrCommands::List { repo: String, .. }`). Passthrough mode needs the
workspace and slug too, to build the REST path.

So the forge resolves it itself, in both modes:

1. `git config --get remote.origin.url`, through the same injected `Runner`,
   `cwd: repoPath`.
2. A pure `parseBitbucketRemote(url): { workspace, slug } | null` in `pr/bb/pr.ts`,
   handling `https://bitbucket.org/ws/slug(.git)`, `git@bitbucket.org:ws/slug(.git)`,
   and `ssh://git@bitbucket.org/ws/slug(.git)`.
3. Both `--workspace <ws>` and the slug are passed **explicitly**, rather than
   relying on the CLI's detection heuristics — one fewer thing that can differ
   between the CLI's idea of the repo and ours.

A remote that does not parse means no PR facts for that checkout: `fetch`
returns `{ ok: false }`, exactly as an unreadable response would. Same
discipline `pr/glab/provider.ts` documents for `:fullpath` — Agent Flow's name
for a *checkout* is never the repo's name.

## 7. Surface by surface, in both modes

### 7.1 Finding the PR — `BbProvider.fetch(repoPath, branch, key)`

**Passthrough.** `bb api '/2.0/repositories/{ws}/{slug}/pullrequests?q=source.branch.name="{branch}"&state=OPEN&pagelen=10'`,
then a fallback `q=title~"{key}"`. Server-side filtering, exactly as `gh --head`
and `glab source_branch=` do.

**Projected.** `bb pr list <slug> --state OPEN --limit 25` has **no branch filter
and no title search**, so both selectors are applied client-side over the
returned rows: an exact match on `source === branch`, then a substring match of
`key` in `title`. A repo with more than 25 open PRs can miss one that `gh` would
have found by direct query. Documented, not hidden.

Both modes: no match → `{ ok: true, facts: null }` (genuinely no PR), never
`{ ok: false }`. Nothing may throw out of `fetch` — an uncaught throw leaves the
caller's cache entry unstamped, which re-arms that repo's fetch on every 6s tick
forever. Every step, mappers included, is inside the try.

### 7.2 The PR url

**Passthrough.** `links.html.href`, straight off the PR object.

**Projected.** Not emitted, and `PrFacts.url` is required — the card links to it.
Synthesized as `https://bitbucket.org/{workspace}/{slug}/pull-requests/{id}`.
This is the one place the forge asserts a wire fact the CLI never returned. It
matches the CLI's own convention — `get_pr_diff` builds the identical string in
its source — and it is a real url for Bitbucket Cloud and a lie for anything
else, which is part of why this design is Cloud-only.

### 7.3 Draft and mergeability

**Passthrough.** `draft` on the PR object. Conflicts from
`/2.0/repositories/{ws}/{slug}/pullrequests/{id}/conflicts` — an empty list is
mergeable.

**Projected.** Neither is emitted. `isDraft: false` and `mergeable: "unknown"`,
asserted explicitly in tests so a later change cannot start inventing them.

### 7.4 Review state

**Passthrough.** `participants[]` carries `role`, `approved` and `state`
(`approved` / `changes_requested` / null), so `PrFacts.review` is fully real and
`caps.changesRequested` resolves to `true`.

No `/2.0/user` call is needed, though an earlier draft of this section claimed
one: `PrFacts.review` is a fact about the **pull request** — the same thing
GitHub's `reviewDecision` reports — not about the viewer. So the mapper grades
the whole `participants[]` array with no notion of "me": changes-requested by
anyone outranks an approval by anyone, and only `REVIEWER` participants count
(a commenter is a participant too, and counting one would leave every
commented-on PR reading `review_required` forever).

**Projected.** `bb pr get` gives an `approvals` **count** — how many, not who.
`bb pr reviewers` gives display names and a status string but **no uuid**, and
Bitbucket display names are neither unique nor stable. `review: "none"`, and
`caps.changesRequested` is `false`.

A display-name match against `bb auth whoami` was considered and rejected: it is
a heuristic on non-unique names, it costs an extra call per card, and `whoami`
prints via `println!` ignoring `--format` — and under Bearer/access-token auth it
prints accessible workspaces instead of a name at all, so the match silently
yields nothing for a whole auth mode.

### 7.5 Unresolved threads

**Passthrough.** `/2.0/…/pullrequests/{id}/comments?pagelen=100`; the
`pullrequest_comment` schema carries `resolution`, so the count is real.

**Projected.** `comment_count` only — a total, with no resolution state. The CLI
has `pr resolve-comment` and `pr reopen-comment` subcommands, so it can *write*
resolution but not *read* it. `unresolved: null`.

### 7.6 CI

Bitbucket puts CI on neither the PR list nor the PR object, in either mode. One
extra call per card, degrading to `ci: none` without discarding the PR.

**Passthrough.** `/2.0/…/pullrequests/{id}/statuses` — the `commitstatus` schema
gives `state`, `key`, `name` per check, so the card gets a real rollup with
failing check names, as GitHub's does.

**Projected.** `bb pipeline list --branch <source> --recent 1` — one pipeline
verdict, no per-check breakdown.

### 7.7 Reviews waiting on me — hidden in both modes

Bitbucket Cloud has **no cross-repo reviewer query**. The only workspace-level
endpoint is `GET /2.0/workspaces/{ws}/pullrequests/{user}`, which is *authored
by* that user (verified against Bitbucket's OpenAPI). This is an API limit, not
a CLI one, so passthrough mode does not fix it.

`reviews.search()` returning `null` would be the wrong answer: the convention is
that `null` means **the attempt failed**, so `enqueueReviews` would set
`reviewStale = true` and log a failure every TTL, forever, for a question that
was never answerable. Hence `caps.reviewSearch: false` (§4), read by `deckView`'s
existing `reviewsEnabled()` gate — which already governs both the enqueue and the
`enabled: false` post, so one added conjunct hides the strip on both paths.

A per-repo fan-out — `q=reviewers.uuid="{uuid}"` against each repo under
`reposRoot` — would work in passthrough mode. It is deliberately out of scope:
N calls per refresh across repos the user may not have open, for a strip that
GitHub and GitLab fill with one.

### 7.8 Review submit and detail

Both are reachable only through the strip: `reviewDetail` and the submit handler
key off `this.reviewCache.requests`, which only `enqueueReviews` populates. With
`reviewSearch: false` the cache stays empty and both return early, so
`BbReviewProvider` is **not reachable in a Bitbucket install today**.

It is implemented rather than stubbed, because the `Forge` interface requires a
`ReviewProvider` and a stub would lie the day the strip is enabled:

- `search()` → `null`. Never called; documented as such.
- `detail()` → passthrough: `diffstat` (`lines_added`/`lines_removed`) plus the
  statuses call, so the row's size and CI chips are real. Projected: `null`
  (`bb pr diff` is a stub, and there is no failing-checks projection).
- `submit()` → passthrough: `approve` and `request-changes` via `bb api -X POST`,
  `comment` via the comments endpoint. Projected: `bb pr approve` and
  `bb pr comment --text`, with `request-changes` refused.

Both modes keep the conventions the GitHub path established: the timeout branch
gets its own wording (a killed process may already have reached Bitbucket), and
**the review body must never reach an error message** — prefer a rejection's
`stderr` over `.message`, which is `Command failed: <file> <argv joined>` and
embeds the body verbatim.

### 7.9 Branch CI

**Passthrough.** `bb api '/2.0/repositories/{ws}/{slug}/pipelines?target.ref_name={branch}&sort=-created_on&pagelen=1'`.

**Projected.** `bb --repo <slug> pipeline list --branch <branch> --recent 1`
(`--recent N` is the CLI's shorthand for `--sort=-created_on --limit=N`).

Both map the newest pipeline for that ref — the same fact `mapGlabBranchStatus`
grades. `mapBbBranchStatus` lives in `pr/bb/pr.ts`, **not** in
`orchestrator/branchCi.ts`: that module is on the webview import graph and must
not gain a forge-specific dependency. `mapGlabBranchStatus` lives there only
because it predates the rule being written down.

`"unknown"` for every unreadable fact — failed call, timeout, unrecognised state,
no pipeline — and `"unknown"` is not green.

### 7.10 Seeded prompts

`config.ts` gains `BITBUCKET_PR_REVIEW_PROMPT` and
`BITBUCKET_REVIEW_REQUEST_PROMPT`: substitution-only rewrites of the GitHub
wording, the same relationship the GitLab pair already has. "pull request"
survives (Bitbucket's own name for it). `gh pr checkout` becomes
`git fetch && git checkout <source branch>` — **not** `bb pr checkout`, which
does not exist; `atlassian-cli` has no checkout subcommand.

`shippedPrReviewPrompt(forge)` and `shippedReviewRequestModes(forge)` become
three-way lookups rather than `forge === "gitlab" ? … : …`. This matters for
telemetry, not cosmetics: comparing a Bitbucket install against the GitHub
default would report `pr_review_prompt_customized` for every stock Bitbucket
install, which is the direction that destroys the metric.
`review/batch.ts`'s `READ_ONLY_*_PROMPT` gets the same treatment.

## 8. Summary: what each mode answers

| Question | GitHub | GitLab | BB passthrough | BB projected |
|---|---|---|---|---|
| Find PR by branch | `--head` | `source_branch=` | `q=source.branch.name` | client-side over 25 rows |
| Find PR by Jira key | `in:title` | `search=&in=title` | `q=title~` | client-side substring |
| PR url | yes | yes | `links.html.href` | **synthesized** |
| Draft | `isDraft` | `draft` | `draft` | **always false** |
| Mergeable | `mergeable` | `detailed_merge_status` | `/conflicts` | **`unknown`** |
| Approved? | `reviewDecision` | approvals call | `participants[].state` | **`none`** |
| Changes requested? | `reviewDecision` | **not exposed** | `participants[].state` | **`none`** |
| Submit request-changes | one verb | note + withdraw | `POST /request-changes` | **refused** |
| Unresolved threads | GraphQL | discussions | `comment.resolution` | **`null`** |
| CI on a card | in the query | single-MR read | `/statuses` | pipeline verdict only |
| Branch CI | rollup | newest pipeline | newest pipeline | newest pipeline |
| Diff size in queue | in the search | file count only | `diffstat` real | n/a |
| Reviews waiting on me | search | `reviews_for_me` | **none** | **none** |

Passthrough mode beats GitLab on two rows — changes-requested and diff size —
and matches it everywhere else except the review queue. Projected mode is a card
with CI and little else.

## 9. Verification gates

### 9.1 Tests

All spawn-free, via the injected `Runner`. **Every provider test runs twice**,
once per mode, from a shared table — the mode is an injected boolean, not a
spawn result, so no test shells out to `bb api --help`.

New files:

- **`test/unit/engine/pr/bb/pr.test.ts`** — pure. `parseBitbucketRemote` across
  https / scp-style / `ssh://`, with and without `.git`, plus a GitHub url and
  garbage → `null`. `pickPr` state precedence. `mapBbBranchStatus` across every
  `state` string both modes produce, plus an unrecognised one → `"unknown"`.
- **`test/unit/engine/pr/bb/projected.test.ts`** — the synthesized url, and every
  degraded field asserted **explicitly** (`isDraft === false`,
  `mergeable === "unknown"`, `review === "none"`, `unresolved === null`) so a
  later change that starts inventing one of them fails.
- **`test/unit/engine/pr/bb/rest.test.ts`** — `draft`, `links.html.href`,
  `participants[].state` → `changes_requested` when it is *our* uuid and not
  when it is someone else's, `resolution` → unresolved counts, `commitstatus`
  rollup including failing check names.
- **`test/unit/engine/pr/bb/provider.test.ts`** — argv assertions on what
  actually reached the `Runner`, never on an exported path helper. Mode
  detection: exit 0 → passthrough, clap error → projected, and the result is
  probed **once**. Branch match vs. key fallback vs. neither. Unparseable remote
  → `{ ok: false }`. Non-array / error-object output → `{ ok: false }`, not an
  empty list. A failing CI call degrades without discarding the PR.
  **`fetch` never throws** — a rejecting runner, malformed JSON, `null`.
  `probeBb`: `ENOENT` → `missing`, non-`ENOENT` → `signed-out`, success → `null`.
- **`test/unit/engine/review/bb/provider.test.ts`** — `approve` and `comment`
  argv in both modes; `request-changes` refused in projected and issued in
  passthrough; empty body refused for `comment`; a prototype-key verb
  (`"constructor"`) fails closed; the timeout branch keeps its distinct wording;
  **a rejection carrying the body in `.message` never returns the body**.

Extended files:

- `test/unit/engine/forge/registry.test.ts` — `bitbucket` resolves; static caps
  are `{ changesRequested: false, reviewSearch: false }`; `resolveCaps()` yields
  `changesRequested: true` in passthrough and `false` in projected; both
  existing forges gain `reviewSearch: true` and **omit `resolveCaps`**;
  `FORGE_IDS` has three entries.
- `test/unit/deckView.test.ts` — `resolveCaps` is awaited once and its result
  used at both read sites; a forge without it falls back to static `caps` with
  no behavior change; `reviewSearch: false` never calls `reviews.search()` and
  posts a hidden strip; the settings-change reset clears `forgeCaps` alongside
  `forgeGap`.
- `test/unit/config.test.ts` — `shippedPrReviewPrompt("bitbucket")` and
  `shippedReviewRequestModes("bitbucket")` return the Bitbucket wording; an
  unknown forge still returns the GitHub baseline.
- `test/unit/telemetry/settingsSnapshot.test.ts` — a stock Bitbucket install
  reports `pr_review_prompt_customized: false`, `review_modes_overridden: 0`.
- `test/unit/engine/doctor.test.ts` — the Bitbucket group renders with its own
  label, between Local and the agent group.
- `test/unit/engine/orchestrator/armability.test.ts` — `changes-requested` is
  unfirable under projected caps and firable under passthrough caps.

`test/unit/docs.test.ts` already fails if `bitbucket` is not backticked in
`docs/FORGES.md`, so the docs entry is enforced, not remembered.

### 9.2 Fixtures

Projected-mode fixtures come from `atlassian-cli`'s **row structs**, read from
`crates/cli/src/commands/bitbucket/`. Passthrough-mode fixtures come from
**Bitbucket's OpenAPI schemas** (`pullrequest`, `participant`,
`pullrequest_comment`, `commitstatus`, `diffstat`, `pipeline`). Every fixture
carries a comment naming its source.

This is exactly the trap `docs/FORGES.md` §3 records GitLab falling into: MR
fixtures were written from the documented response shape, every test agreed, and
every GitLab card silently showed no CI for a release. Here the risk runs both
ways — a projected fixture written from Atlassian's docs would test a mapper
against fields that can never arrive.

### 9.3 The honest gap

**No one on this project has `atlassian-cli` installed, and it is not on the CI
image.** Every wire shape here comes from reading its Rust source and Bitbucket's
OpenAPI spec — better than reading prose docs, and still not a real response.

Before this ships, one manual pass in a dev host against a real Bitbucket Cloud
repo, **in whichever mode is live**: `probe`, mode detection, a card with an open
PR, a card without one, and a branch-CI read. That pass is a release gate, not a
nice-to-have — `copilot-provider-shipped-unverified` is the precedent for what
happens when it is skipped.

### 9.4 CI

`npm run typecheck`, `npm test`, `npm run build` all pass. Coverage thresholds in
`vitest.config.ts` (90% lines/statements, 85% branches/functions) enforced by
`npm run test:cov`. The existing suite must pass **unmodified** — a test edited
to go green is the signal to stop.

## 10. Rollout

0. **Upstream PR** (Appendix A) — independent of everything below, and the
   sooner it is open the sooner passthrough mode is reachable by real users.
1. `ForgeCaps.reviewSearch` + `Forge.resolveCaps?()`; both existing forges declare
   `reviewSearch: true` and omit `resolveCaps`; `deckView`'s `caps()` accessor and
   the `enqueueReviews` gate. Inert on its own, lands with its own tests.
2. `pr/bb/pr.ts`, `projected.ts`, `rest.ts` — pure, fully tested, imported by
   nothing yet.
3. `pr/bb/provider.ts` (both modes + detection) and `review/bb/provider.ts`.
4. `forge/bitbucket.ts` + one line in `registry.ts`.
5. `package.json` enum, `config.ts` prompts, `review/batch.ts` prompt.
6. `docs/FORGES.md` — §8's table and §7's mode split become a new section;
   `docs/SETTINGS.md`; `CHANGELOG.md` under `## [Unreleased]`.
7. Manual dev-host pass (§9.3).

Steps 1–5 are each independently green. The forge is unreachable until step 4
and unselectable until step 5.

## 11. Open question for the reviewer

In **projected mode**, `agentFlow.forge: bitbucket` ships a Deck card with CI and
little else — no review state, no mergeability, no draft flag — and no review
strip. That is worth shipping if the alternative is nothing; it is not worth
shipping if it reads as "Agent Flow supports Bitbucket" to someone who then
finds an empty board.

Two mitigations, both cheap, and I would take both:

- The `enumDescription` in `package.json` says so plainly, rather than matching
  GitHub's and GitLab's one-liners: *"Bitbucket Cloud, through the
  `atlassian-cli` CLI. Full support requires a build with `bb api`; without it,
  cards show branch CI only."*
- Doctor's Bitbucket group reports the **mode**, not just the gap — a row reading
  "passthrough (full)" or "projected (limited — upgrade `atlassian-cli` for full
  support)". Doctor is where a user goes when the board looks wrong, and this is
  the answer they need to find there.

---

## Appendix A — the upstream patch

`crates/cli/src/commands/api.rs` is already generic over `ApiClient`, and
`bitbucket::execute` already receives one. The entire `jira api` feature is two
lines of wiring (`jira/mod.rs:94` and `jira/mod.rs:1403`). The Bitbucket
equivalent is the same two, in `crates/cli/src/commands/bitbucket/mod.rs`:

```rust
// in `enum BitbucketCommands`
/// Raw Bitbucket API access (any endpoint, using the configured profile).
Api(crate::commands::api::ApiArgs),
```

```rust
// in the dispatch match in `execute`
BitbucketCommands::Api(args) => {
    crate::commands::api::run(&client, renderer, args).await
}
```

One caveat to resolve while writing it: the `Whoami` arm returns before
workspace resolution, and `Api` must do the same — a raw call to
`/2.0/workspaces` or `/2.0/user` must not require a workspace it does not use.

Worth adding alongside: a `jira_api_e2e.rs`-shaped test for the Bitbucket route,
and a README line under "Bitbucket - Raw API access" matching the Jira one.
