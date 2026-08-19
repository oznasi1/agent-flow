# GitLab support alongside GitHub

**Date:** 2026-08-19
**Status:** approved design, ready for an implementation plan

Agent Flow reads pull requests, CI, and review requests from GitHub through the
`gh` CLI. This design adds GitLab as a second **forge** — merge requests,
pipelines, approvals, and review requests through `glab` — behind one seam, with
GitHub as the default so that no existing install changes behavior.

This document is meant to be true rather than encouraging. Where GitLab cannot
answer a question GitHub answers, it says so and says what the Deck does
instead.

## 1. Decisions

| Decision | Choice | Why |
|---|---|---|
| Forge selection | One global setting, `agentFlow.forge` | A GitLab shop is a GitLab shop. Per-repo detection is a later change, not this one. |
| Scope | Full parity across all five GitHub surfaces | A GitLab user gets the Deck a GitHub user gets. |
| Transport | `glab api <rest-path>` | Reuses every existing seam. `glab` has no native discussions command, so `glab api` would be required regardless. |
| Default | `github` | The compatibility guarantee is structural, not a promise backed by tests. |
| Review-strip size chip | Filled on row expansion | One call per row the user opens, never 50 per refresh. |

**Non-goals.** Mixed GitHub + GitLab in one workspace. Bitbucket or any third
forge (though the seam should not preclude one). Token-based transport as an
alternative to `glab`. Renaming any existing setting, type, or condition kind.
`agentFlow.githubOrg`, which is read into config but effectively unused, is left
exactly as it is.

## 2. Where GitHub is wired in today

| Surface | Code | GitHub mechanism |
|---|---|---|
| PR facts on Deck cards | `src/engine/pr/provider.ts`, `src/engine/pr/facts.ts` | `gh pr list --json` + GraphQL `reviewThreads` |
| Review-requests strip | `src/engine/review/provider.ts`, `src/engine/review/search.ts` | GraphQL `search(review-requested:@me)` |
| Review submit (the only write) | `src/engine/review/provider.ts` `submit()` | `gh pr review --approve/--comment/--request-changes` |
| Orchestrator branch-CI gate | `src/engine/orchestrator/branchCi.ts` (mapper) + `deckView.ts` (spawn) | GraphQL `statusCheckRollup` |
| Doctor + Deck footer note | `src/engine/doctor.ts` `ghChecks`, `deckView.ts` `GH_NOTES` | `gh auth status` |
| Seeded agent prompts | `src/config.ts` | literal `gh pr checkout` text |

`PrFacts`, `ReviewRequest`, and `BranchCiStatus` are already host-neutral. The
webview mentions GitHub only in comments. The seam is already in roughly the
right place; what it lacks is a sibling implementation and a registry.

## 3. The `Forge` seam

New directory `src/engine/forge/`, following `src/tasks/registry.ts`
deliberately — same pattern, same prototype-key care, same property that adding
a forge is one registry line plus a directory.

```ts
export interface Forge {
  readonly id: string;                   // "github" | "gitlab"
  readonly label: string;                // "GitHub" | "GitLab"
  readonly cli: { name: string; installUrl: string };
  probe(): Promise<ForgeGap | null>;     // today's probeGh, generalized
  readonly prs: PrProvider;              // existing interface, UNCHANGED
  readonly reviews: ReviewProvider;      // existing interface, UNCHANGED
  branchCi(repoPath: string, branch: string): Promise<BranchCiStatus>;
}
```

`PrProvider` and `ReviewProvider` do not change. `GhProvider` and
`GhReviewProvider` already implement them and continue to, with their argv,
their parsers, and their tests untouched. The new work is `GlabProvider` and
`GlabReviewProvider` as siblings.

`ForgeGap` is today's `GhGap` renamed, keeping both members (`missing`,
`signed-out`) and their meanings: `missing` means there was no binary to spawn,
`signed-out` means a CLI we did find refused `auth status`.

`resolveForge()` mirrors `resolveConnector()`, including its use of
`Object.hasOwn` rather than a bare index — `agentFlow.forge` comes from
settings.json and can be any string, including a prototype key like
`"constructor"` that a bare index would resolve to a truthy non-factory. An
unknown id logs and falls back to `github`. `FORGE_IDS` is exported so the
manifest-parity test and the telemetry allowlist derive from the registry rather
than a second hand-written list that can drift.

`deckView.ts` holds one `forge` field in place of three separate GitHub things
(`pr`, `reviewProvider`, and `ghRun` + `resolveBin("gh")`).

### 3.1 The webview bundling constraint

`src/engine/forge/*` imports `child_process`. It must therefore **never** be
imported by `src/engine/orchestrator/conditions.ts` or
`src/engine/orchestrator/branchCi.ts`, both of which are bundled into the
webview. One hop into anything holding `child_process`/`fs`/`path`/`os` and
esbuild stops resolving.

This is the sharpest hazard in the change, because **`npm run typecheck` and the
full test suite both pass regardless**. Only `npm run build` catches a
violation. `test/webview/webviewGraph.test.ts` pins the boundary and must be
extended to cover `src/engine/forge/`.

Consequently, branch-CI splits the way it already splits for GitHub: the argv
and the spawn move into each forge implementation, while the webview-safe
mapper (`mapBranchStatus`, `branchCiKey`, and the condition types) stays in
`orchestrator/branchCi.ts` and gains a GitLab state arm.

## 4. Settings

One new setting:

```jsonc
"agentFlow.forge": {
  "type": "string",
  "enum": ["github", "gitlab"],
  "default": "github",
  "description": "Which forge Agent Flow reads pull/merge requests, CI, and review requests from. Requires a window reload."
}
```

The wording mirrors `agentFlow.taskSource`, which is the existing precedent for
a provider-selecting setting.

**Nothing is renamed.** `prFacts`, `prFactsTtlSeconds`, `reviewRequests`,
`reviewRequestsTtlSeconds`, `reviewWrites`, `reviewRequestModes`,
`reviewRequestMode`, `prReviewStatus`, `prReviewAutoFix`, and `prReviewPrompt`
keep their identifiers. So do the orchestrator condition kinds (`pr-merged`,
`ci-passed`, `ci-failed`, `review-approved`, `changes-requested`,
`threads-resolved`, `pr-conflicting`, `branch-ci-passed`) — those are
**persisted in users' flow files** through `orchestrator/store.ts`, so renaming
them would break saved flows for no gain.

Internally, "PR" is the generic word for "PR or MR". Only user-*visible* labels
become forge-aware: Doctor's group and row, the Deck footer note, and the review
submit confirmation.

### 4.1 Seeded prompts

`src/config.ts`'s `prReviewPrompt` and review-request mode prompts hardcode `gh
pr checkout`. These are user-editable settings with manifest defaults.

The GitHub defaults stay **verbatim**. GitLab prompt text is selected at seed
time only when the forge is `gitlab` *and* the user has not customized the
setting — using `explicitConfigValue`, which `config.ts` already uses for
exactly this kind of "do not clobber a customization" decision in the
`reviewRequestModes` migration. A user who customized their prompt keeps it on
either forge.

The GitLab variants differ from the GitHub ones only in the mechanics they
script: `glab mr checkout <iid>` in place of `gh pr checkout <number> --repo
<repo>`, "merge request" in place of "pull request", "GitLab" in place of
"GitHub" where the prompt names the host to the agent, and "target branch" in
place of "base branch" — GitLab's own UI name for the same thing. Everything else about
each prompt — what the agent is asked to assess, where it writes its findings,
and the instruction not to post anything itself — is identical, so the two sets
stay legible as variants of one prompt rather than diverging over time.

## 5. Types: two wire shapes, one normalized shape

`PrFacts`, `ReviewRequest`, and `BranchCiStatus` are untouched. That is why the
webview needs no change beyond label copy. (`ReviewDetail` is the one shared type
that does change, gaining an optional size field — see §6.4.)

`GhPr` stays as `gh`'s wire shape. GitLab gets its own `GlabMr` shape with its
own mapper. **These are deliberately not unified.** The mappers are exactly
where host differences belong: GitHub's `mergeable` + `mergeStateStatus` pair
and GitLab's `has_conflicts` + `detailed_merge_status` pair reach the same
verdict by different routes, and a merged shape would hide that.

Two consequences:

- **`parseRepoFromUrl` is wrong for GitLab.** It takes the first two path
  segments as `owner/repo`. GitLab nests groups, and MR URLs look like
  `https://gitlab.com/group/sub/proj/-/merge_requests/12`. It becomes a
  per-forge `projectFromUrl(url): string | null` returning one **opaque**
  project identity — `owner/repo` for GitHub, everything before `/-/` for
  GitLab. `ReviewRequest.repo` is already an opaque string with `repoName` as
  its last segment, so nested groups need no type change.
- **`iid`, not `id`.** GitLab MRs carry a project-scoped `iid` and a global
  `id`. `iid` is what maps to `number` — it is what the web URL and every
  project-scoped call use. Swapping them produces plausible-looking links to
  the *wrong* MR, so this gets its own named test.

## 6. Surface-by-surface mapping

Every GitLab call is `glab api <path>`. Project identity uses `glab`'s
`:fullpath` placeholder, resolved from the git remote of the directory the call
runs in — the same discipline `branchCi.ts` already documents for `gh`'s
`{owner}`/`{repo}`, and for the same reason: a flow's `repo` is Agent Flow's name
for a *checkout*, not the forge's name for a project. The two routinely differ,
because this product's own worktrees are directories like `bite-me-3a`.

### 6.1 MR facts on cards — `GlabProvider.fetch(repoPath, branch, key)`

| Step | Call | When |
|---|---|---|
| Branch lookup | `merge_requests?source_branch=<b>&state=all&per_page=10` | always (mirrors `--head`) |
| Key fallback | `merge_requests?search=<key>&in=title&state=all&per_page=10` | only when the branch lookup found nothing |
| CI detail | `pipelines/<head_pipeline.id>/jobs` | only when the MR has a pipeline |
| Approvals | `merge_requests/<iid>/approvals` | always for a found MR |
| Threads | `merge_requests/<iid>/discussions` | **skipped when `blocking_discussions_resolved === true`**, which yields 0 directly |

The GitLab mapper normalizes `state` (`opened`/`closed`/`merged`/`locked`) into
the `OPEN`/`MERGED`/`CLOSED` vocabulary `pickPr` and `toPrFacts` already use, so
`pickPr` is reused unchanged. `locked` maps to `OPEN`: it is an open MR with
discussion locked, not a closed one.

Field mappings:

- **`ci`** — from the pipeline's jobs. `success` counts as passing;
  `created`/`pending`/`running`/`waiting_for_resource`/`preparing` as pending;
  `failed` as failing, carrying job `name` and `web_url`. `canceled`,
  `skipped`, and `manual` count as neither, matching `mapRollup`'s existing
  posture that a cancelled run is usually a superseded one and calling it a
  failure would drag cards into Needs you on every force-push.
- **`ciAdvisory`** — GitHub's `UNSTABLE` (a non-required check failing) maps
  onto GitLab's `allow_failure`: advisory when every failing job has
  `allow_failure: true`.
- **`mergeable`** — `has_conflicts: true` → `conflicting`. Otherwise
  `detailed_merge_status`: `mergeable` → `clean`; `need_rebase` → `behind`;
  `not_approved`, `discussions_not_resolved`, `blocked_status` → `blocked`;
  anything else → `unknown`.
- **`review`** — `approved: true` → `approved`; `approvals_required > 0 &&
  !approved` → `review_required`; else `none`.
- **`unresolved`** — the count of unresolved resolvable discussions. A failure
  here degrades to `null`, never discarding facts already obtained, exactly as
  the GitHub path does.

### 6.2 The `changes_requested` gap

`changes_requested` is reachable on GitLab only when
`merge_requests/<iid>/reviewers` reports a reviewer state, which older
instances do not. On such an instance `PrFacts.review` can never hold
`changes_requested`.

This is not cosmetic. The orchestrator has a `changes-requested` condition, so
on those instances **a flow gated on that rule waits forever**. That is exactly
the class of problem `orchestrator/armability.ts` exists to surface: arming
warns and names rules that cannot fire rather than refusing, because silence is
how a user ends up waiting on something that can never happen. `armability.ts`
therefore needs a forge-aware arm so arming says so.

`armability.ts` is reachable from the webview bundle. The forge fact it needs
must arrive as plain data (an id and a capability flag) passed in by the caller,
never as an import of `src/engine/forge/`. See §3.1.

### 6.3 Unresolved threads differ in kind

GitHub's count deliberately excludes outdated threads, because an outdated
thread refers to code the PR has since replaced. GitLab has no equivalent
concept exposed here, so that exclusion has no counterpart and the GitLab count
is slightly more inclusive. This is documented rather than papered over: a wrong
count reads as fact.

### 6.4 Review-requests strip

`GET /merge_requests?scope=reviews_for_me&state=opened&per_page=50` — one call,
like the GraphQL search it replaces. `references.full` (`group/sub/proj!12`)
carries the nested project path, so identifying the project needs no per-MR
call.

`null` from `search()` continues to mean "the attempt failed", never "you owe
nobody a review" — the caller keeps its cached list and flags it stale rather
than emptying the strip. An empty `nodes` array remains a *success* meaning you
owe nobody a review. These are different things and the GitLab parser must keep
them different.

**Size chip.** GitLab's MR list returns no `additions`/`deletions`/
`changedFiles`. `search()` returns zeros for them; `ReviewDetail` gains an
optional size field, filled by the existing `detail()` call that already runs on
row expansion for failing checks and unresolved threads. One extra call per row
the user actually opens, never 50 per refresh.

### 6.5 Review submit

| Verb | GitLab |
|---|---|
| `approve` | `POST merge_requests/<iid>/approve` |
| `comment` | `POST merge_requests/<iid>/notes` with `body` |
| `request-changes` | `POST .../notes` **and** `POST .../unapprove` (swallowing the error when there was no approval to remove) |

**`request-changes` has no stable GitLab REST verb.** It exists only through
`drafts/publish` with a `reviewer_state`, which carries an open HTTP 500 bug
(gitlab-org/gitlab#549078). This design does not build on it.

Because the verb therefore means something materially different per forge, **the
confirmation dialog must say what will happen, in those words**, before the user
clicks — not after.

Two invariants carry over unchanged, both of which exist because of a real past
leak of review text into an error message:

1. The review body must reach `glab` through a field flag that neither
   type-coerces it nor reads a leading `@` as a filename. **The exact
   semantics of `glab api`'s field flags must be verified during
   implementation, not assumed.** `Runner` has no stdin path today; if the
   flags cannot guarantee this, `Runner` grows one rather than the body going
   into argv unsafely.
2. The catch must prefer the rejection's `stderr` over its `.message`, since
   `.message` is `Command failed: <file> <full argv joined>` and embeds the
   body verbatim. The timeout branch must also keep its distinct wording: a
   killed process may well have reached the server, so "the forge refused"
   would be a lie about a write that could have succeeded.

`reviewWrites` already defaults to `false`, so this path stays opt-in exactly as
today.

### 6.6 Branch CI

`GET projects/:fullpath/pipelines?ref=<branch>&per_page=1`, then `[0].status`:

| GitLab status | Verdict |
|---|---|
| `success` | `passed` |
| `failed` | `failed` |
| `created`, `preparing`, `pending`, `running`, `scheduled`, `waiting_for_resource` | `pending` |
| `canceled`, `skipped`, `manual`, anything unrecognised, no pipeline at all | `unknown` |

`unknown` is not green. `branch-ci-passed` is met by `passed` alone.

This arm is **stricter** than the GitHub one, which folds `SKIPPED` toward
`SUCCESS` because that is GitHub's own answer to "is this commit green".
GitLab's per-ref pipeline status is a whole-pipeline verdict, and a `skipped`
pipeline reads `unknown` here. The asymmetry belongs in `branchCi.ts`'s existing
header comment, in that module's voice, so the next reader finds it there rather
than in a bug report.

### 6.7 Doctor

`ghChecks` becomes `forgeChecks`: group label from `forge.label`, row label from
`forge.cli.name`, install URL from `forge.cli.installUrl`, probe via `glab auth
status`. `DoctorInputs.gh` becomes `DoctorInputs.forge`.

Unchanged: the `ENOENT` → `missing` / everything-else → `signed-out` split (a
non-ENOENT failure came from a CLI that ran, so blaming the install would send
the user hunting for a binary they already have); the `agentFlow.prFacts is off`
skip row; and **naming where the binary was found**, which is the most valuable
line in the report — a Homebrew `glab` invisible to the extension host's bare
launchd PATH reads, to a signed-in user, as the Deck simply being broken.

`resolveBin` needs no change: its Homebrew, MacPorts, and `~/.local/bin`
fallbacks already cover `glab`, and it is deliberately uncached so a
`brew install glab` mid-session starts working on the next probe.

## 7. What GitLab cannot answer

| Question | GitHub | GitLab | Deck behavior |
|---|---|---|---|
| Has a reviewer requested changes? | `reviewDecision` | only via `reviewers` state, absent on older instances | `review` never reads `changes_requested`; arming names the `changes-requested` rule as unfirable |
| Is a thread outdated? | `isOutdated` | not exposed | count is slightly more inclusive; documented |
| Submit "request changes" | one verb | no stable verb | note + unapprove, disclosed in the confirmation |
| Diff size in a list | in the search | not in the list | zeros in search, filled on row expansion |
| Is a skipped required check green? | folded toward `SUCCESS` | `skipped` → `unknown` | GitLab is stricter; documented in `branchCi.ts` |

## 8. Verification gates

Restated here because an implementer follows the brief, not `CONTRIBUTING.md`:

- `npm run typecheck` clean.
- `npm test` — **all existing test files pass unmodified.** Editing an existing
  GitHub test is a red flag requiring explicit justification, not a routine fix.
- `npm run test:cov` — thresholds enforced.
- `npm run build` must succeed. This is the **only** gate that catches
  `src/webview/*` reaching `child_process` transitively (§3.1).

New tests:

- Every GitLab mapper: state normalization, jobs → `ci`, `allow_failure` →
  `ciAdvisory`, `detailed_merge_status` → `mergeable`, approvals → `review`,
  discussions → `unresolved`.
- `iid`-not-`id`, named explicitly (§5).
- Nested-group `projectFromUrl`, including a URL with no `/-/`.
- `resolveForge` fallback on an unknown id **and** on a prototype key.
- Forge-labelled Doctor rows for both forges, and both gap kinds.
- Forge-aware armability naming `changes-requested` unfirable.
- `search()` returning `null` on a malformed payload versus an empty list on a
  genuinely empty queue.
- `submit()` never returning the review body in an error message, on the
  GitLab path, for both the timeout and the ordinary-failure branches.
- `webviewGraph.test.ts` extended to cover `src/engine/forge/`.

No test forks a process: the injected `Runner` seam handles that, as today.

## 9. Rollout

`agentFlow.forge` defaults to `github`, so the change is inert for every
existing install until someone opts in. Merging to `main` means a version bump
and a fresh `.vsix`, per repo convention.

New doc `docs/FORGES.md`, mirroring `docs/CONNECTORS.md`'s explicitly honest
tone, carrying §7's table as its centerpiece.
