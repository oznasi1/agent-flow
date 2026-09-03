# E2E coverage of every documented behaviour — design

**Date:** 2026-09-03 · **Status:** approved for planning · **Branch:** `test/e2e-doc-coverage`

## Goal

Every capability the docs claim (README, `docs/*.md`) is either proven by a real-host
E2E journey, proven at a lower layer with a stated reason, or marked untestable in the
harness with a stated reason — and that mapping is a checked artifact, not a wiki page.
The lane stays a required PR check without its wall-clock growing with the test count.

Today: 44 E2E tests over 24 spec files prove the happy paths of take, batch, seed,
providers, sign-in, status write-back, Address PR, Deck PR facts (gh + glab), Deck
lifecycle, workflows attach/arm/detach, review launch, Marketplace basics, Notepad
basics, and the sidebar writes. The inventory of documented claims is ~230 items
(sidebar, Notepad, Deck, review strip, Marketplace, Doctor/Setup, Orchestrator,
connectors, forges, providers × surfaces, settings, telemetry/privacy). Roughly 100 of
those are provable in the existing harness and are not proven today.

## Non-goals

- Telemetry delivery (no network sink in the lane; unit tests own the catalog).
- Live Jira / GitLab / Bitbucket API behaviour, live `glab`/`atlassian-cli` merges.
- Real Cursor app automation (unreachable over CDP; the patched-host gate stands in).
- Windows shell for the command node.
- Native OS dialogs (Attach image file picker, Reveal in Finder), OS dictation,
  `openExternal` into a browser.
- Rewriting existing journeys. They pass unmodified; the coverage matrix cites them.

## Design

### 1. The coverage matrix is a tested file

`test-e2e/COVERAGE.md` — one table per doc area, one row per documented claim:

| id | doc | claim | proof |
|----|-----|-------|-------|
| `task-pool-filter-lenses` | GUIDE § What it does | Five lenses render by `caps.supportedFilters` | `e2e: only the lenses the connector declares render` |
| `forge-gitlab-merge-unverified` | FORGES § GitLab merge is untested | Merge path never run live | `untestable: live glab` |

`proof` is one of `e2e: <title substring>`, `ct: <spec>`, `unit: <file>`,
`untestable: <reason>`. `test/unit/e2eCoverage.test.ts` enforces two directions:

1. every `e2e:` proof matches exactly one `test("…")` title across `test-e2e/*.e2e.ts`
   (substring, the same contract `sabotage/*.expect` uses);
2. every `test("…")` title in `test-e2e/` is cited by at least one row — a journey with
   no documented claim behind it is either undocumented behaviour or a test that should
   say what it proves.

Plus: every `agentFlow.*` setting id in `package.json` appears in at least one row's
`claim` or `id` column. A setting with no documented, proven behaviour is the exact
drift this program exists to stop. `unit:`/`ct:` paths must exist on disk.

### 2. The fixture connector grows a configuration file

`src/tasks/fixture/connector.ts` reads an optional `<fixtureDir>/config.json` at each
call (it already re-reads `tasks.json` per call). Absent file ⇒ today's behaviour,
byte-for-byte, so the 44 existing journeys are untouched.

```jsonc
{
  "supportedFilters": ["mine", "all"],          // default ["mine","all","mysprint"]
  "sizes": true,                                // default false
  "caps": { "sprints": false, "labels": false, "components": false, "children": false },
  "me": { "id": "", "displayName": "Fixture User" },   // id "" = name-only identity
  "statusTargets": [ { "id": "done", "toName": "Done", "toCategory": "done",
                       "fields": [ { "id": "resolution", "kind": "pick", "label": "Resolution",
                                     "required": true, "options": ["Fixed", "Won't fix"] } ] } ],
  "reject": { "moveTo": { "message": "Resolution is required", "retryWith": ["resolution"] } },
  "failDetail": ["E2E-2"]                       // detail() throws for these keys
}
```

Each knob maps to one documented edge: lenses gated by caps, size lens by `sizes`,
add-to-sprint/remove/reorder by `sprints`, provenance stamping a silent no-op without
`labels`, chips lose classification without `components`, "Couldn't resolve your
account" on `id: ""`, "No status transitions available" on `[]`, field prompts and
`retryWith` re-prompting, and the detail-fetch toast on a throw. `Task` records gain an
optional `estimateSeconds` in `tasks.json` (already on the type) for the size lens.

### 3. Forge shims answer more verbs; a Bitbucket shim joins them

`test-e2e/_helpers/forgeShim.ts`:

- `gh` answers for `pr merge`, `pr review`, `api graphql` (review search with an
  `isArchived` repo, a `changes requested` decision, unresolved threads), `auth status`
  with two accounts, `pr view` with failing check runs, `run view` links. A shim entry
  may declare `exit: 1` + `stderr` to drive the `⚠ PR unread` and refusal paths.
- `glab` answers for the MR list, the single-MR read (`head_pipeline`), `changes_count:
  "20+"`, and the merge PUT (asserted on argv only).
- `atlassian-cli` shim: `bb api --help` exit 0 (passthrough) or a clap
  "unrecognized subcommand" on stderr (projected); `bb pr list/get/merge` answers.
- `calls.jsonl` stays the assertion of record for every write verb; `unknown.jsonl`
  stays the vacuity guard and `expectNoUnknownForgeCalls` remains mandatory.

### 4. Claude Code state is seeded on disk

`test-e2e/_helpers/claudeState.ts`:

- `seedSession(sb, { pid, cwd })` writes `~/.claude/sessions/<id>.json`. The pid is
  the launched Electron's own (`app.process().pid`), so `pidAlive` is true for the life
  of the test and false the moment the host closes.
- `seedTranscript(sb, cwd, sessionId, shape)` writes
  `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl` for shapes `working`,
  `ended-turn`, `idle`, `pending-tool`, with timestamps relative to now. This is what
  drives Live signal, the Action required column, `notifyOnActionRequired`, the
  activity-bar badge, `local` cards, and Track it.

### 5. New journeys, grouped by surface

Shared-host (`describeWithHost`) wherever actions are local or append-only; per-test
boot for anything that opens a window, creates a worktree, or writes a run record.
Estimated counts are targets, not quotas — a claim the harness cannot honestly prove
becomes an `untestable:` row, never a weakened test.

| Spec file | Boot | Claims (≈ tests) |
|---|---|---|
| `pool-lenses.e2e.ts` | shared ×3 configs | lenses by caps (no Unassigned/Sprint/Backlog for fixture; only Mine/All when `mysprint` dropped), `defaultFilter` opens lens, size lens present iff `sizes`, `filters.status/repo/size:false` hide, title search narrows, repo filter narrows, unlisted tab never renders (≈8) |
| `pool-writes-edges.e2e.ts` | shared ×3 configs | no sprints ⇒ no add/remove/reorder; no labels ⇒ moveTo with no `addLabel` line; `stampLabelOnWrite:false`; custom `provenanceLabel`; `me.id:""` ⇒ refused toast; `statusTargets:[]` ⇒ info toast; field prompt then `moveTo.values`; `retryWith` re-prompts one field; `failDetail` ⇒ toast; assigned-to-other card has no Add-to-sprint; Remove from sprint → Undo restores (≈11) |
| `take-prompts.e2e.ts` | per test | prompt-mode picker lists the six built-ins; `promptModes` overrides a label, `hidden:true` drops one, custom mode appears and lands in the brief; `worktree:"ask"` picker; worktree path `.claude/worktrees/<KEY>` and git-excluded; `.pick-task` excluded; `openIn:"ask"` destination picker lists new/this/pick-existing; `this-window` in an unnamed window opens a new one; `pick-existing` adds only after approval and skips same-name folders; multiroot writes `<KEY>.code-workspace` into `workspaceDir` (≈10) |
| `explore-modes.e2e.ts` | shared | picker shows the six actions; `Verify on an environment` asks env from `environments` + `Custom…` and seeds a read-only prompt; `explorePrompts.*` override lands in the plan (≈4) |
| `remote-control.e2e.ts` | per test | copilot + `on` refuses with toast before any worktree; `on` under terminal surface for a multi-repo per-window take ⇒ "skipped" toast; `on` + Claude panel prefilled `/remote-control KEY` + clipboard (macOS only) (≈3) |
| `surface-edges.e2e.ts` | per test | terminal surface with no `claude` on PATH ⇒ `command not found` and prompt still present; `agentProvider:"ask"` picker per launch; batch under `ask` asks once; copilot `extension` batch writes briefs, seeds no panel, notifies; batch > threshold confirms; task matching no filtered repo launches in all; shared-window layout (≈7) |
| `address-pr-edges.e2e.ts` | per test | button gated on `prReviewStatus` case-insensitively and absent otherwise; `prReviewAutoFix:false` prompt assesses only; custom `prReviewPrompt` (≈3) |
| `deck-signal.e2e.ts` | per test | `working · Ns ago` from a transcript; `ended turn` lands in Action required; `parked` when no transcript; `notifyOnActionRequired` fires once and coalesces; activity-bar badge counts waiting runs with the setting off; copilot run has no session on its card (≈6) |
| `deck-open-agents.e2e.ts` | per test | live session in an untracked dir ⇒ `local` card; branch `PROJ-5641-x` ⇒ `~inferred` key only when `jira.project` set; Track it pins it; `openAgents:false` removes it live; local card gone when session dies (≈5) |
| `deck-board.e2e.ts` | per test | closed run in Recently closed strip; `inflightShowAll`; grouping control sticks across reopen; Open focuses, never duplicates; Diff opens the diff; ⋯ menu contents; header count tiles match columns; refresh "synced Ns ago" (≈8) |
| `deck-merge.e2e.ts` | per test + gh shim | `mergeWrites` off ⇒ no button; on + ready ⇒ Merge; dialog names repo/#/strategy; confirm ⇒ `gh pr merge --squash` in `calls.jsonl`; cancel ⇒ no call; two ready PRs ⇒ no button; `mergeMethod` in dialog; output channel line; glab + `rebase` refused naming the setting (≈8) |
| `deck-pr-work.e2e.ts` | per test + gh shim | failing check ⇒ `fixes needed` lane while session working; Fix CI / Resolve conflict / Address review seed a plan with absolute brief path; `prWorkOpenIn:"its-window"` asks nothing; Deck Address PR re-seeds in place (no new worktree); `⚠ PR unread` on a failing read with footer count; `prFacts:false` drops the PR block and darkens the strip live (≈7) |
| `review-strip.e2e.ts` | per test + gh shim | sort oldest/smallest; archived repo omitted; row without checkout greyed + title; in-flight row cannot launch twice; every row visible in a scrollable list; expand fetches checks + threads; `reviewRequestModes` custom ⇒ picker; `reviewOpenIn:"this-window"` seeds by absolute path; `reviewRequests:false` hides (≈9) |
| `review-writes.e2e.ts` | per test + gh shim | off ⇒ no buttons; Approve/Comment/Request changes each confirm naming verb/repo/#; cancel sends nothing; body from `.pick-task/REVIEW-<n>.md` loads into the box; session-drafted line appended unless `stampLabelOnWrite:false`; glab request-changes dialog says approval is withdrawn (≈7) |
| `review-batch-edges.e2e.ts` | per test + gh shim | read-only mode offered by batch only, creates no worktree; shift-click range; batch > threshold names the session cost; not-checked-out repo named once and skipped; shared-window layout (≈5) |
| `forge-bitbucket.e2e.ts` | per test + `atlassian-cli` shim | passthrough vs projected detection from `--help`; Doctor row names the mode; strip hidden in both; projected `rebase` refused before any call; projected card shows branch CI and little else (≈5) |
| `forge-gitlab-queue.e2e.ts` | per test + glab shim | `20+` renders as `20 files`; CI `none` until expanded; additions/deletions 0; `changes-requested` rule named unfirable on arm (≈4) |
| `orchestrator-drawer.e2e.ts` | shared, `orchestrator:true` | Workflows/Templates header buttons and badge text; second click switches to Active; Canvas explains when empty; Active row opens the card; List view builds a rule by keyboard; close-Deck-with-armed-flow warning; hold on reopen (≈7) |
| `orchestrator-nodes.e2e.ts` | per test | notify fires once and pops a VS Code notification + receipt; gate asks once, Approve fires the downstream rule, Reset re-asks; command node asks consent, `act` runs `/bin/sh` and records output, `disarm` disarms; `neverAutoRun` glob outranks approval; `command succeeded` chains a second command; output opens in an editor tab; toast when nothing journaled; **Save to settings writes the real `settings.json`** (≈10) |
| `orchestrator-journal.e2e.ts` | per test | `<id>.log.jsonl` gains `armed`/`fired`/`consent-asked`/`consented`/`reset`; deleting the flow leaves the log; a corrupted line is skipped (≈3) |
| `orchestrator-templates.e2e.ts` | shared | save-as-template names the row; edit; delete confirms; built-ins marked; dry run words waiting gates (≈5) |
| `marketplace-filters.e2e.ts` | shared, richer `.claude/` seed | type pills with counts; scope pills; Plugins picker multi-select + Clear N; marketplace tag filter; filters AND; chips row disappears when empty; category grouping Yours first / Uncategorized last; disabled struck through; not-downloaded rows carry `/plugin install` (≈9) |
| `marketplace-detail.e2e.ts` | shared | ↑/↓ + Enter opens file; Open file opens a tab; hooks.json as JSON block; 262,144-char truncation with Open file; `javascript:` link not clickable, `https:` is; Rescan sees a new file; + Add a marketplace copies the command; empty `plugins/` missing ⇒ not-set-up state (≈8) |
| `setup-wizard.e2e.ts` | per test, `setupComplete` unset | welcome offer → Set up; boxes titled `(n/total)`; Esc at a connector step writes nothing and re-offers next launch; Esc at reposRoot writes nothing; completion writes settings + `setupComplete`; Later leaves everything unset; Run Setup… re-run cancel leaves config untouched (≈6) |
| `doctor.e2e.ts` | per test | fixture probe rows read `skip`; row labels from `SourceInfo`; provider rows for every tool under `ask`; picking a `setting` row opens Settings; copy report fills clipboard (macOS) and writes nothing else; `PR reads` row beside a green CLI row (≈6) |
| `notepad-edges.e2e.ts` | shared | All/Active/Done opens on Active and filters; Reset order only after a drag; Clear completed only with a done note; edit saves; delete removes; re-run replaces the run record; synthetic image drop renders a thumbnail and > 10 MB is refused (≈7) |
| `providers-labels.e2e.ts` | per test | review button reads "Review with Claude Code" / "…Cursor" on the cursor host / "…Copilot"; brief-naming gap for a single take under `ask` (documented, pinned as `test.fail` if it reproduces) (≈3) |

≈ 180 new tests is the ceiling of the table; expect 120–150 once untestable rows are
settled. Each new spec file ships with its `sabotage/<file>.patch` + `.expect` pair in
the same commit (CONTRIBUTING rule), aimed at the file's highest-value test.

### 6. CI: shard the lane, merge the evidence

`.github/workflows/e2e.yml` becomes a matrix of `N` shards (`npx playwright test
--shard=i/N`, still `workers: 1` each), each uploading a blob report; a final `e2e`
job runs `playwright merge-reports --reporter json,html` and `npm run e2e:report`, posts
the sticky comment, and is the one job the branch protection requires. `N` is chosen so
the wall-clock stays near today's 4–10 minutes (start at 4; the merge job prints per-shard
durations so it can be retuned). Locally `npm run test:e2e` is unchanged.

`scripts/verify-report.mjs` gains nothing: the merged JSON has the same shape.

### 7. Worktree hygiene for parallel authoring

Each implementer works in its own worktree with `.vscode-test` and `node_modules`
symlinked to the root checkout (read-only use; the cursor-host patch marker already
exists). At most one Playwright E2E run per machine at a time — Electron boots
contend and the drag gestures are timing-sensitive; runs are serialized through a
lockfile in the scratchpad, not left to chance.

## Testing the tests

- Every new test is mutation-checked before it lands: break the product path by hand,
  see the test fail, restore. The sabotage pair captures one such mutation per file.
- Existing 44 journeys must pass unmodified. A journey that needed editing is the
  signal to stop and look (page-object repairs excepted: those are one-file fixes).
- `npm run typecheck`, `npm test`, `npm run test:ct`, `npm run build`, and the full
  `npm run test:e2e` are the gates — all five, per phase, before a phase merges.

## Phasing

1. Infrastructure: coverage matrix + test, fixture `config.json`, shim verbs,
   `claudeState.ts`, CI sharding. The matrix ships listing every claim, with today's 44
   journeys cited and every other row temporarily `todo:` — the test accepts `todo:`
   only while `COVERAGE.md` carries a `## Backfill in progress` heading, removed in the
   last phase.
2. Sidebar and launch edges (`pool-*`, `take-prompts`, `explore-modes`,
   `remote-control`, `surface-edges`, `address-pr-edges`).
3. Deck (`deck-*`).
4. Review strip and forges (`review-*`, `forge-*`).
5. Orchestrator (`orchestrator-*`).
6. Marketplace, Setup/Doctor, Notepad, providers.
7. Close-out: remove `todo:` allowance, CHANGELOG, CONTRIBUTING pointer to the matrix.

## Open risks

- Some documented claims may turn out false when driven in a real host (the doc itself
  lists "never run in an editor" for the command node and Save to settings). A failing
  test there is a product defect: pin it with `test.fail()` so the report shows
  `PINNED`, file the fix separately, and never weaken the assertion.
- The lane's total runtime is the one number to watch; sharding is the lever.
