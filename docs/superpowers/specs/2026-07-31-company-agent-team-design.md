# Design: An agent team that runs Agent Flow

**Date:** 2026-07-31
**Status:** Approved, ready to plan

## Summary

Agent Flow is twelve days old, at 0.1.41, with two stars, no issues and no landing
page. Everything it has shipped came from one person driving Claude Code sessions
by hand through the [orchestration protocol](../../../.claude/orchestrator/PROTOCOL.md).

This design adds a **standing agent team** that runs the company between those
sessions. Seven roles — chief of staff, product, architect, feature engineer,
designer, growth, customer — wake on a schedule, read a shared company state,
and produce real artifacts: backlog entries, specs, worktree branches with green
tests, HTML mockups, landing-page copy, drafted replies. Work that is mechanically
safe lands on its own. Everything irreversible becomes a card on a **local approval
board** where it waits for Approve, Reject, or Revise-with-a-note.

The engine is Claude Code itself. No second framework, no new billing, no glue
layer: roles are subagent definitions, code work goes through the existing
worktree protocol, and cycles are headless `claude -p` runs.

## Why this, and why now

Two things are true at once. The product side has a working machine — the
orchestrator protocol, superpowers specs and plans, a coverage bar, worktrees —
and it is bottlenecked only on someone deciding what to build next. The company
side has no machine at all: no positioning written down, no landing page, no
launch, no answer ready for the first person who opens an issue.

A team of agents is the right shape for exactly that asymmetry. The product side
gets a dispatcher and specialists feeding a pipeline that already works. The
company side gets its first artifacts written at all. And because a young public
project can be damaged far more by one bad release or one bad post than it can be
helped by a good one, the whole thing is built around a gate rather than around
throughput.

## Decisions

Settled during brainstorming, recorded so the plan does not relitigate them:

| Question | Decision |
|---|---|
| What does the team optimize? | **Product and go-to-market as one loop.** Every cycle can produce both shipped product and outward motion. |
| Build on an existing multi-agent framework? | **No.** Claude Code is the engine. CrewAI/AutoGen would need their own keys and could not use the worktree protocol, superpowers skills, or the MCP connections; MetaGPT/ChatDev generate greenfield projects, not incremental PRs on a shipping codebase. |
| How is the team organized? | **A chief of staff dispatches, with a guaranteed floor.** Roles run when there is work for them; once a day every role gets one slot to raise a single thing regardless of the agenda. |
| Where does the approval UI live? | **A local web app** in `src/company/`, loopback-bound, reading and writing a file-based queue. Not a view inside the shipped extension, not GitHub issues. |
| What layout? | **Split master–detail** — list of pending items on the left, the artifact rendered full-size on the right, verdict controls in a fixed position. |
| How much autonomy? | **Mechanically-safe work auto-lands; everything irreversible is gated.** |
| How many verdicts? | **Three: Approve, Reject, Revise-with-a-note.** The note returns to the owning role next cycle and persists in `decisions.jsonl`. |
| When does approved work execute? | **On the next cycle**, or immediately via *Apply now*, which spawns one batched run rather than a session per click. |
| What drives the loop? | **Scheduled cycles at 09:00 and 17:00, plus on-demand** via `/company` or the board's *Run now*. |
| Are the role prompts versioned? | **Yes.** `.gitignore` is amended to un-ignore `.claude/agents/`, `.claude/skills/` and `.claude/commands/`. Prompts are the team's DNA and must have history. Strategy stays in the private charter. |
| Is company data versioned? | **No.** `.claude/company/` stays ignored and out of the `.vsix`. `decisions.jsonl` is the audit trail. |
| Is `customer` one role or two? | **One**, covering customer-facing and customer success. With zero users the job is being ready for the first one. Split it when it is busy. |
| Is there a QA role? | **No.** `feature-engineer` must pass typecheck, tests and coverage to be done, and `/code-review` plus stance-review-squad already exist. |

## Scope

**In:** the seven role definitions; the shared company state and its file formats;
the cycle procedure and its dry-run mode; the auto-land gate; the board app
(queue module, server, UI) and its tests; the scheduler; the `/company` command;
the ignore-rule amendments.

**Out:** publishing through APIs (X, LinkedIn, HN, Reddit) — drafts land on the
board and the human posts them; landing-page hosting or deploy; automated reading
of marketplace reviews (no public API exists); pricing and monetization work;
splitting `customer` in two; access to the board from a phone; any change to the
shipped extension's behavior.

## The roster

Seven definitions at `.claude/agents/company-<role>.md`. Flat filenames, not a
subdirectory, so discovery cannot be a variable. Each role reads `CHARTER.md`
first, then the state files relevant to it.

| Role | Owns | Produces | Can auto-land? |
|---|---|---|---|
| `company-chief-of-staff` | The agenda | Cycle plan, cycle report, dispatch decisions | n/a — writes only to private state |
| `company-product` | What to build and why | Backlog entries with rationale, PRD-lite specs | No — specs become gated cards |
| `company-architect` | Structural health | Refactor proposals, feasibility review on specs before they become work | Only a behaviour-preserving refactor that clears the gate |
| `company-feature-engineer` | Shipping code | A worktree branch and PR following `PROTOCOL.md` end to end | Only when the gate clears |
| `company-designer` | How it looks and feels | Self-contained HTML mockups in `docs/mockups/` (git-ignored), UI review against the project's webview conventions | No |
| `company-growth` | Getting known | Positioning, landing-page copy, README and marketplace copy, launch-post drafts, a weekly metrics read | No |
| `company-customer` | The person on the other end | Drafted replies to issues, discussions and reviews; FAQ and docs upkeep; first-run friction reports | No |

Roles never merge, tag, package, publish, or post. That restriction is stated in
each definition and enforced by the cycle, not left to the prompt alone.

## Company state

Private, at `.claude/company/` — matched by the existing `.claude/*` ignore rule
and by `.vscodeignore`'s `.claude/**`, so nothing here reaches the public repo or
the published package.

```
.claude/company/
  CHARTER.md          what Agent Flow is, who it is for, positioning, non-goals
  backlog.md          prioritized, owned by company-product
  metrics.md          installs, stars, npm downloads, issue count — refreshed per cycle
  decisions.jsonl     append-only: every verdict and note you ever gave, each
                      line self-describing (see "Queue item format" below)
  queue/<id>.json     pending approval items, one file each
  archive/<id>.json   decided items, moved here on verdict
  landed/<id>.json    auto-landed items awaiting acknowledgement, with revert SHA
  cycles/<ts>.md      one report per run
  PAUSED              presence of this file stops every cycle immediately
```

`CHARTER.md` is written by hand with the user before the first non-dry cycle.
Seven agents reading a vague charter produce seven different companies.

## Queue item format

One JSON object per pending decision. It must carry everything needed to decide
without opening a terminal.

```json
{
  "id": "2026-07-31-1709-growth-landing-hero",
  "cycle": "2026-07-31T17:09",
  "role": "company-growth",
  "kind": "copy",
  "title": "Landing page hero: lead with the setup pain, not the feature list",
  "why": "Two or three sentences: the reasoning, and what this is betting on.",
  "artifact": {
    "type": "diff | markdown | html | text",
    "path": ".claude/company/drafts/landing-hero.md",
    "inline": "…used when there is no file…"
  },
  "risk": "gated",
  "on_approve": "Write docs/landing/index.html on the next cycle",
  "branch": "company/growth-landing-hero",
  "checks": { "typecheck": "pass", "test": "142 passed", "coverage": "94.1%" }
}
```

`kind` is one of `code`, `spec`, `copy`, `mockup`, `reply`, `release`. A `release`
card is proposed only by the chief of staff, never by a role, and carries the
accumulated changelog for the version it is asking to cut. Unknown kinds render as
plain text rather than failing. A malformed item is quarantined
with a visible error card, never silently dropped and never able to crash the
board.

A verdict appends one line to `decisions.jsonl`:

```json
{"id":"…","verdict":"approve|reject|revise","note":"…","at":"2026-07-31T18:02:11Z",
 "cycle":"2026-07-31T17:09","role":"company-growth","title":"Landing page hero: …",
 "artifactSha256":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"}
```

**Widened after the phase A review.** The line originally carried only `id`,
`verdict`, `note` and `at`, on the assumption that `archive/<id>.json` held the
body and a join would recover the rest. Two things break that assumption. Ids are
not unique across cycles — `ID_RE` constrains the characters, not the history —
so a reused id produces two log lines nothing can tell apart. And the archive is
a single file per id: the original `fs.renameSync` would have replaced an
existing entry outright, destroying the only copy of what was decided. A record
of human judgement has to be readable on its own, without a join to a file that
can be lost or silently replaced.

So a line now also carries the `cycle`, the `role` and the `title` it decided,
plus `artifactSha256` — a sha256 of the resolved artifact content as the reviewer
saw it, truncation included. The digest ties the verdict to the exact bytes that
were on screen, which no path or filename can. It is absent when the artifact
could not be resolved at all; that is a state the reviewer can legitimately
decide on, so the verdict is still recorded.

`recordVerdict` refuses outright when `archive/<id>.json` already exists: it
returns an error naming the collision, and writes nothing — no log line, no
rename, the pending item left in place to be re-filed under a fresh id. The
check runs before the append, so a refused verdict leaves no trace.

The four original fields stay required and the widened ones are optional, because
the log is append-only: lines written before this change are history, and
`readDecisions` keeps parsing them rather than rejecting them for what they lack.

## The cycle

Driven by `scripts/company-cycle.sh`, which wraps `claude -p "/company"`. The
procedure itself lives at `.claude/skills/company-cycle/SKILL.md` so it is
versioned, readable, and identical whether a cron job or a human starts it.

1. **Preflight.** If `.claude/company/PAUSED` exists, exit immediately with a log
   line. Otherwise refresh `metrics.md` — stars and issue counts via `gh repo view`
   and `gh issue list`, npm downloads via `npm view`. Marketplace install counts
   have no API and are pasted in by hand; the file records when each number was
   last touched so a stale figure cannot be mistaken for a fresh one. No separate
   script: these are commands in the cycle skill.
2. **Agenda.** The chief of staff reads the charter, backlog, recent
   `decisions.jsonl` entries, `git log` since the last cycle, open PRs and GitHub
   issues, then writes the cycle plan: which roles wake and what each chases. The
   morning cycle also runs the floor — one slot per role.
3. **Work.** Roles run as subagents, parallel where independent, each capped. Code
   work happens in a worktree under `.claude/worktrees/` and follows `PROTOCOL.md`:
   implement, typecheck, test, coverage, rebase on current `main`.
4. **Integrate.** Each proposal is classified `safe` or `gated`. Safe ones land and
   write a `landed/` record. Gated ones are written to `queue/`.
5. **Apply verdicts.** Approved items from the previous cycle execute here.
   Revised items return to their owning role with the note attached. Rejected
   items are dropped, their reasoning already recorded.
6. **Report.** A cycle report in `cycles/`, including token spend, plus a
   notification that the board has something.

`--dry-run` runs steps 1–3 and writes proposals to `queue/`, but never merges,
pushes, publishes, or executes a verdict. The first week runs dry.

## The gates

A proposal auto-lands only when **every** condition below is mechanically true.
The integrator fails closed: anything it cannot prove becomes a gated card.

- `npm run typecheck` clean, `npm test` all passing, `npm run test:cov` at or above
  the project bar for changed files — with the real output captured in the record
- rebased on current `main`, no conflicts
- zero diff to `package.json` version, `package-lock.json`, or `CHANGELOG.md`
- no change to any exported signature, contributed setting key, command ID, or
  webview markup
- at most **three** auto-lands per cycle

Every auto-land writes a `landed/` record with its commit SHA, surfaced on the
board as a notification with a one-click Undo that runs `git revert` behind a
confirm.

**Always gated, without exception:** cutting a version or publishing to either
registry; anything posted publicly; any reply to a real person; pricing; and any
change a user would notice.

## The board app

`src/company/`, versioned in the public repo, bundled by the existing esbuild step
to `dist/company-board.js` and excluded from the `.vsix`. Zero runtime
dependencies — Node built-ins only — but it is TypeScript built by `npm run build`
rather than hand-written JS. That is a deliberate change from the first draft of
this design: `tsconfig.json` compiles `test/**` as CommonJS, so a TS test
importing a plain `.js`/`.mjs` module breaks `npm run typecheck`. Following the
repo's own idiom costs one esbuild entry point and buys full type checking and
normal vitest coverage.

- **`queue.ts`** — the only module that touches company data: read and validate
  items, append verdicts, move decided items to `archive/`, quarantine malformed
  files, resolve artifact paths inside the repository only.
- **`server.ts`** — `route()` holds every HTTP behaviour and is tested without
  binding a port; `createBoardServer()` adapts it to `node:http` on `127.0.0.1`
  with a session token in the URL, because this server can trigger merges and
  reverts. Routes: `GET /api/queue`, `GET /api/artifact`, `POST /api/decision`,
  `POST /api/pause`, `POST /api/cycle`, `POST /api/undo`.
- **`boardHtml.ts`** — the split layout as one self-contained page, vanilla JS.
- **`boardMain.ts`** — the entry point: token, real side-effect runners, listen.
  Spawning a cycle and running `git revert` are injected here, which is the single
  place Phase B has to touch.
- **`gate.ts`** — the auto-land decision as a pure, unit-tested function, so
  "fails closed" is enforced by code rather than by a prompt's good intentions.

Artifacts render by type: unified diffs parsed and colored, markdown rendered,
HTML mockups in a sandboxed iframe, drafted posts in a post-shaped frame so a
tweet reads like a tweet before it is approved. Keyboard: `j`/`k` to move, `a`
to approve, `v` to revise, `r` to reject, `⌘↵` to submit a note.

Visual conventions follow the extension's webviews: red reserved for genuine
failures, no persistent hint lines under cards, monospace only for identifiers,
and both light and dark.

## Scheduling

A `launchd` job runs `scripts/company-cycle.sh` at 09:00 and 17:00 local and logs
to `.claude/company/cycles/`. On-demand entry points are `/company` in a session
and *Run now* on the board. Each cycle caps its subagent count and records token
spend in its report, so a runaway week is visible in the reports rather than a
surprise on a bill.

## Failure handling

| Failure | Behaviour |
|---|---|
| A role subagent dies mid-cycle | Its slot is recorded as failed in the report; other roles are unaffected; nothing partial lands. |
| A worktree is left dirty | The item is gated regardless of checks, with the dirty state named in the card. |
| Rebase conflicts on `main` | Auto-land is refused; the item becomes a gated card carrying the conflict. |
| A malformed queue item | Quarantined and shown as an error card; the board still loads. |
| The board cannot reach the company dir | It serves a clear empty state, not a stack trace. |
| Two cycles overlap | A lock file makes the second exit immediately. |
| `main` moved during a cycle | Verified again immediately before any auto-land; stale means gated. |

## Testing

Vitest, alongside the existing suite:

- `queue.js`: schema validation, append-only verdict log, archive moves, refusal
  to archive over an existing entry, tolerance of pre-widening log lines,
  quarantine of malformed files, rejection of artifact paths that escape the
  company directory.
- `server.js` routes against a temp-directory fixture: decision writes land in
  both `decisions.jsonl` and `archive/`, pause toggling, token rejection, path
  traversal rejection, undo requiring a known SHA.
- The role prompts are not unit-testable. `--dry-run` is the safety mechanism:
  run the loop, read what the team proposes, and enable auto-land only once the
  proposals look sane.

## File map

```
.claude/agents/company-chief-of-staff.md      new, versioned
.claude/agents/company-product.md             new, versioned
.claude/agents/company-architect.md           new, versioned
.claude/agents/company-feature-engineer.md    new, versioned
.claude/agents/company-designer.md            new, versioned
.claude/agents/company-growth.md              new, versioned
.claude/agents/company-customer.md            new, versioned
.claude/skills/company-cycle/SKILL.md         new, versioned — the cycle procedure
.claude/commands/company.md                   new, versioned — thin /company entry
.claude/company/**                            new, private (ignored)
src/company/types.ts                          new, versioned
src/company/paths.ts                          new, versioned, tested
src/company/queue.ts                          new, versioned, tested
src/company/server.ts                         new, versioned, tested
src/company/gate.ts                           new, versioned, tested
src/company/boardHtml.ts                      new, versioned
src/company/boardMain.ts                      new, versioned
scripts/company-cycle.sh                      new, versioned
scripts/com.agentflow.company.plist           new, versioned
test/unit/company/*.test.ts                   new
esbuild.js                                    amended: one bundle for the board
vitest.config.ts                              amended: three coverage exclusions
package.json                                  amended: one script (`board`) — never `version`
.gitignore                                    amended: un-ignore the three .claude dirs
.vscodeignore                                 amended: exclude dist/company-board.js
```

## Implementation order

Two phases, because the first is fully testable without a single agent running and
the second is worthless without it.

**Phase A — the substrate.** The state directory and its formats, `queue.js`,
`server.js`, `index.html`, the tests, and the ignore-rule amendments. Verified by
hand-writing a few queue items covering every `kind` and deciding them on the
board. At the end of Phase A the board works and nothing produces cards yet.

**Phase B — the team.** The seven role definitions, the cycle skill, the `/company`
command, `scripts/company-cycle.sh`, and the `launchd` job. Verified by dry-run
cycles filling the board that Phase A already proved.

## What this design does not solve

The team can write a launch post but cannot launch. It can draft a reply but
cannot answer anyone. It can prepare a release but cannot publish one. Those are
the gates working as intended — but it means the company still moves at the speed
of one human's attention on the board. If that becomes the bottleneck rather than
the safety valve, the honest next step is to loosen specific gates with evidence
from `decisions.jsonl` about which kinds of proposals were approved unchanged.
