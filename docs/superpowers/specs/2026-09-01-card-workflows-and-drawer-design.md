# Card workflows — templates, the drawer, and seeing a flow move

**Date:** 2026-09-01
**Supersedes in part:** [2026-08-26-flow-templates-design.md](2026-08-26-flow-templates-design.md)
**Mockups:** `preview/workflows-ux.html`, `preview/drawer-redesign.html` (both gitignored)

## Why

Two problems, and they turn out to be the same problem.

The card detail drawer has grown into a scroll: six fact sections, then a flat list of up to
fifteen action buttons in four groups, under a header that counts them. Nothing in it is
wrong; nothing in it is prioritised either. A reader looking for "what is happening to this
task" reads five blocks of facts before reaching anything they can act on.

Meanwhile the orchestrator's flows are welded to the work they were drawn for. A
`PlaceNode` stores a `runKey`, a `PlannedNode` stores a `ticketKey`, so the ship-it shape
you drew for PROJ-1 cannot run on PROJ-2. The 26 Aug spec solved the reuse half of that and
named "instantiate from a Deck card" as the path most people would use — but stopped short
of designing that path, and left the flow invisible from the card once attached.

So the drawer has no priorities and the flow engine has no reach. Attaching a reusable shape
to a card, and showing it moving in the card's own drawer, fixes both: the drawer gains the
one block that answers "what is happening", and the engine gains the surface people will
actually use it from.

## What this changes about the 26 Aug spec

That spec's engine decisions all stand — the ticket as the only parameter, templates holding
no places, `stripHostStamps` shared with Reset, consent never travelling, storage as a
sibling directory, `instantiate` as a pure function, the refusals. This document amends only
its UI section and adds what it did not cover.

One factual correction to carry into the extract: that spec describes Reset's deny-list as
`firedAt`, `firedNote`, `error` and `performed`. The live handler
([`deckView.ts` ~4326](../../../src/deckView.ts)) deletes **six** fields — those four plus
`action` and `gateAnswer`, the latter added with gate nodes. `stripHostStamps` must cover all
six, and the whole point of extracting it is that the next host-owned field added to
`FlowEdge` has one function to update instead of two call sites to remember.

| 26 Aug spec | Now |
|---|---|
| §8 "New from template…" beside "+ New flow", with a ticket picker | **Dropped.** One attach entry point: the card. |
| §8 "Instantiate from a Deck card" | **Designed** — §3 below. |
| §8 "No template management in v1" | **Reversed.** A Templates tab with rename, duplicate, delete. |
| Open question: name as a pattern (`Ship {ticket}`) | **Answered: no.** §1. |
| Silent on what the card and its drawer show | **§4–§6.** |

## Decisions

### 1. Two user-facing words, and a fixed name

**Template** is the reusable shape. **Workflow** is a template attached to one card. *Flow*
and *Orchestrator* leave the UI and stay in the code.

The two objects have no verbs in common: a template cannot be armed (no ticket, no PR,
nothing to observe) and a workflow cannot be reused (it is welded to one card). One word
would force the UI to say "the workflow in Templates" and "the workflow on this card", then
offer disjoint buttons for each — a distinction the reader reverse-engineers from the
buttons instead of reading in the noun. The pair also maps 1:1 onto `FlowTemplate` and
`Flow`, so UI and code stop disagreeing about how many things exist.

The verb table is normative:

| Where | Label | Acts on |
|---|---|---|
| A workflow's own controls | `Save as template…` | Workflow → new Template |
| Card drawer, empty block | `Attach workflow…` → picks a template | Template → new Workflow |
| Card drawer, block header | `Arm` · `Disarm` · `Detach` | Workflow |
| Card drawer, a step | `Approve` · `Reject` · `Output` · `Reset` | One rule of a Workflow |
| Templates tab | `Duplicate` · `Rename` · `Delete` · `＋ New template` | Template |

*You attach a workflow by choosing a template* is the whole model, and the only place the
two words meet.

**A template's name is fixed — no `{ticket}` interpolation.** Five workflows from one
template are all called "Ship it", and the Running tab prints the card beside each
(`Ship it · PROJ-142`), which is where telling them apart actually matters. The card drawer
never needs to, because it shows exactly one. This closes the 26 Aug open question: a
templating syntax in a file format that has none will want `{repo}`, `{branch}`, `{date}`
next, each needing validation, escaping and docs, for a problem the Running tab already
solves with a field it already has.

`agentFlow.orchestrator`, every `agentFlow.flow*` command id, the condition keys, the
`SecretStorage` and `globalState` keys and the on-disk run shape keep their released
spelling — `test/unit/compat.test.ts` freezes them and thousands of installs read them.
This is a **label change only**, exactly as the code already says `agents` where the UI says
sessions.

### 2. Attachment is derived, not stored

A workflow is attached to a card when its flow contains a node bound to that run — a
`PlaceNode` with the card's `runKey`, or a `PlannedNode` with its `ticketKey`. That binding
already exists and is already how the engine finds the card.

The alternative, an `attachedTo` field on `Flow`, is rejected:

| | Derived | Stored field |
|---|---|---|
| Can it disagree with the graph? | No — it *is* the graph | Yes: delete the node, the field still claims attachment |
| Migration | None | A new field on every flow file |
| Flows drawn before this ships | Chip lights up on upgrade | Invisible until re-saved |
| "One at a time" | A display rule | Enforceable |

The cost is the last row: nothing stops someone hand-drawing two flows that touch one card.
So the drawer resolves deterministically — **stopped › waiting on you › advancing › done**,
ties broken by `createdAt` — and the block header says `+1 more`, linking to the Workflows
drawer. `Attach workflow…` on a card that already has one offers **Replace**, which detaches
the old workflow's binding and attaches the new. A rule statable in one sentence beats a
field that can lie about the graph it describes.

Attachment is therefore a pure function over the flows already on the wire:
`attachedWorkflow(flows, runKey, ticketKey): Flow | undefined`, plus
`workflowState(flow, runs, branchCi, now): WorkflowState`.

### 3. Attaching is card-only, and does not arm

One entry point. The Workflows drawer never picks a ticket; the Templates tab reports where
a template is in use (`on 2 cards`, derived) and offers no way to place it anywhere.

From a card with no workflow: `Attach workflow…` opens a search-and-tick list of templates —
the same shape as `+ Add command…` — with the ticket already known, so there is no second
step. A trailing row, `＋ Build one from this card…`, opens the Workflows drawer with the
card already placed on the canvas; that builds a *workflow*, and becomes a template only if
the user later presses `Save as template…`.

**Attaching leaves the workflow disarmed.** The block fills in with every rule greyed and a
single `Arm` button. One click that both binds a template the user may have mis-picked and
starts it spending is the wrong default for a feature whose whole value is using it on
dozens of cards. Reading five rules takes four seconds; un-deploying does not.

Consequence accepted deliberately: **a workflow can only reach work that is on the board.**
There is no way to arrange "run Ship it on PROJ-9" for a ticket nobody has taken. A workflow
observes a run's PR, CI, sessions and git state, so it has nothing to watch until the card
exists.

### 4. The live view is webview composition over data already on the wire

This is the load-bearing implementation fact, and it is why the feature is affordable.

- **Per-rule verdicts** come from `previewFlow` (`src/engine/orchestrator/preview.ts`) — pure,
  total, safe to call on every render, and **already imported by a webview**
  (`OrchestratorDrawer.tsx:3`) with exactly the arguments `DeckApp` already holds: `runs` and
  `branchCi`.
- **Receipts** — `launched · claude · worktree`, `ran · exit 0 · 41s`,
  `failed · exit 1 · "3 assertions failed"` — are the edge's own `firedNote` and `error`
  stamps, which ride the existing `deck:flows` post.
- **Rule sentences** come from `orchestratorRule.ts`, which `flowList.tsx` and the canvas
  inspector already share. The Workflow block is a **third presentation of one model**, not a
  second copy of how a rule reads.
- **Liveness** is the Deck's existing 6s pass. No polling, no new channel.

So the block needs **no new host message** and no new engine module. It needs `DeckDetail` to
receive `flows`, `branchCi` and the same `promptModes`/`commands` the Orchestrator gets, all
of which `DeckApp` has in state.

Any new module the block needs must stay a **leaf**: `src/webview/` may not reach `fs`, `os`,
`path` or `child_process` even transitively, or `npm run build` stops resolving while `tsc`
and most of the suite pass regardless (`test/webview/webviewGraph.test.ts` is the near-gate,
and it follows relative imports only).

### 5. Six states, each a different sentence

| State | Read from | Block shows |
|---|---|---|
| none | no flow binds this run | dashed row, `Attach workflow…` |
| disarmed | `flow.armed === false` | steps greyed, `Arm` |
| advancing | `previewFlow` verdict per rule | current step ringed, its reason as the receipt |
| waiting on you | `BlockedNote.reason === "awaiting-answer"` | amber gate step, `Approve` / `Reject` inline |
| stopped | any edge carries `error` | red step, `Output` / `Reset` inline |
| done | no rule left in play | all ticks, `Detach` offered |

`done` is the absence of a pending rule, not a stored flag — same reasoning as attachment.

Both stalls are actionable **from the card drawer**, without opening the canvas. A stalled
workflow latches: it does not retry and does not skip ahead. `Reset` clears the stamp on that
one rule, reusing the existing `flow:resetEdge`.

### 6. The card chip: name and state, no count

One chip in the card's foot, hued by workflow state. `⟳ Ship it` while advancing,
`! Ship it — approve deploy` when waiting, `✕ Ship it — smoke test failed` when stopped,
`✓ Ship it` when done.

No progress pips. A card already carries a kind mark, a key, a status pill and a lane rail;
`2 of 5` is drawer information. And the hue rule the board already obeys is load-bearing here:
**amber means exactly one thing and red means a real failure**, so a workflow that is merely
attached and fine must be neither — it takes the quiet blue, and only the two states that
genuinely want a human borrow attention.

### 7. The drawer: 620px, promote a few, bury the rest

- **Width** 460 → 620px, which is where a rule sentence plus its receipt stops wrapping. It
  gains the **drag and arrow-key resize the Orchestrator drawer already has**
  (`clampOrchWidth`, `DRAG_SEP`, the `OrchPersisted` width) rather than a second hardcoded
  number — and `.board.dd-open`'s reserved padding must track the variable instead of the
  current hardcoded `470px`.
- **A promoted action row** at the top: Open workspace, Open PR, Diff, and Address PR when it
  applies. Real buttons, not list rows.
- **The Workflow block second**, directly under it.
- **Work becomes a one-line fact strip** — its label shares the branch/elapsed row instead of
  heading a block. **Pull request and Sessions keep their shape**, and this is a revision of an
  earlier draft of this section that asked for all three. Pull request's four labelled rows are
  deliberately aligned as a table rather than as sentences (`deckStyles.ts`'s `.pr-block`
  defends it), and compressing them would destroy that alignment; Sessions is expanded by
  default on purpose, because the width this drawer gained was spent precisely on showing
  per-session detail without a second click — the card's fold exists only because the card has
  no room. The goal was that the drawer stop being a 2000px scroll, and that is met by moving
  the spend table, every Copy row and the per-repo diffs behind `More`.
- **Behind `› More`:** every Copy row, the per-repo diffs, the four-row spend table, Forget,
  Track it.
- **The `N actions` counter goes.** It advertised the wrong thing: a drawer is not better for
  having nineteen buttons.

Nothing is removed — every action reachable today stays reachable. `More` is a disclosure, not
a deletion, which is what keeps `test/unit/compat.test.ts` and the existing drawer tests
honest.

### 8. Templates tab, in v1

The Workflows drawer grows two tabs: **Running** (the flows it shows today) and
**Templates**. A template row carries its rule summary, its rule count, and `on N cards` —
derived by counting workflows whose shape came from it, and the only place Templates mentions
cards at all.

Row actions: `Duplicate`, `Rename`, `Delete`, plus `＋ New template`. Deliberately **no
`Attach to…`**. The 26 Aug spec deferred all management on the grounds that the files are
plain JSON in a known directory; a tab makes three of these one line each, and a delete
nothing in the UI can reach means the drawer accumulates junk forever.

`Delete` confirms and does not touch workflows already created from that template — they are
independent flows the moment they are instantiated.

### 9. What this does not solve

A workflow still cannot retry a failed rule on its own. Consent is still keyed to the flow
rather than to the resolved command text — `agentFlow.neverAutoRun` is the brake, and
templates raise the value of finer consent in direct proportion to how many workflows people
run. Repos are still not a parameter (`params: {}` leaves the format room). The journal can
back a History tab in the block later — "what just happened" beside "where am I" — and is not
in v1.

## Not in this build

Three things this document promises that shipped without.

1. **`Output` on a failed step.** §5's table promises "Output / Reset inline"
   for the `stopped` state. Only Reset shipped. Command output goes to the
   Deck's own output channel and nowhere else — reading it back into the
   drawer needs a host round trip that does not exist, and building one is
   deferred alongside the journal-backed History tab §9 already defers. What
   the user gets instead: the failed edge's own `error` stamp surfaces as the
   step's receipt (`WorkflowBlock.tsx`'s `stepText`), so the reason the rule
   failed is on screen — just not the command's stdout/stderr.
2. **One-step Replace.** §2 promises that `Attach workflow…` on a card that
   already carries one "offers Replace". The host supports `flow:attach`'s
   `replace: true` and it is tested, but no UI ever sends it: the picker only
   opens while the block shows `flow === undefined` (nothing attached), and
   deriving `replace` from a `workflow` read at render time created a race —
   another window's poll could attach a workflow to the same card while the
   picker sat open, and a stale-derived `replace: true` would then delete a
   workflow the user never saw. What the user gets instead: Detach, then
   Attach — and on an *advancing* workflow the block's header offers Disarm,
   not Detach (only `done`/`stopped` offer it), so swapping an advancing
   workflow means opening the Workflows drawer and deleting the flow there.
3. **The Templates tab is unreachable with zero workflows.**
   `OrchestratorDrawer.tsx` returns `null` whenever no flow is open
   (`if (!flow) return null`), and the picker holding the Running/Templates
   tabs renders only past that point. A user who deletes their last workflow
   therefore has no way to open the drawer at all, and so cannot rename,
   duplicate, or delete a saved template from any surface until a workflow
   exists again. What the user gets instead: the card's own `Attach
   workflow…` picker still lists every template by name — attaching one still
   works — it is only template *management* (§8) that is unreachable in this
   state.

## File structure

| File | Responsibility |
|---|---|
| `src/engine/orchestrator/templates.ts` | **Create.** Pure leaf: `FlowTemplate`, `toTemplate`, `instantiate`, `validTemplate`. Imports `model.ts` only. |
| `src/engine/orchestrator/attach.ts` | **Create.** Pure leaf: `attachedWorkflow`, `workflowState`, the precedence rule. Imports `model.ts`, `preview.ts`, `evaluate.ts`. |
| `src/engine/orchestrator/model.ts` | Modify. Extract `stripHostStamps(e: FlowEdge): FlowEdge` — all six fields: `firedAt`, `firedNote`, `performed`, `error`, `action`, `gateAnswer` — called from here and `flow:resetEdge`. |
| `src/engine/orchestrator/store.ts` | Modify. `defaultTemplatesDir`, `readTemplates`, `writeTemplate`, `removeTemplate` — same `FlowIo`, same `VALID_FLOW_ID` path guard. |
| `src/deckView.ts` | Modify. `flow:saveTemplate`, `flow:attach`, `flow:detach`, `flow:deleteTemplate`, `flow:renameTemplate`; templates ride along on `deck:flows`. |
| `src/webview/WorkflowBlock.tsx` | **Create.** The block: header, stepper, per-step actions. Leaf-safe. |
| `src/webview/DeckDetail.tsx` | Modify. New anatomy (§7), the block, the `More` disclosure. |
| `src/webview/DeckApp.tsx` | Modify. Pass `flows`/`branchCi`/`commands` to the drawer; the card chip; drawer width plumbing. |
| `src/webview/OrchestratorDrawer.tsx` | Modify. Running/Templates tabs, `Save as template…` dialog, row actions. |
| `src/webview/deckStyles.ts` | Modify. `.dd` width variable, `.board.dd-open` tracking it, block and chip rules. |
| `src/types.ts` | Modify. The new message types and the template shape crossing the wire. |
| `docs/ORCHESTRATOR_COMMANDS.md` | Modify. Authoritative over any spec — the new commands go here. |
| `CHANGELOG.md` | Modify. `## [Unreleased]` entry. |

## Test plan

Engine, pure, no panel:

- `instantiate` binds the chosen ticket to **every** planned node, not just the first
- `instantiate` mints node and edge ids disjoint from the template's
- no edge in an instantiated flow carries `firedAt`, `firedNote`, `error` or `performed`
- an instantiated flow has `armed === false` and **neither** consent stamp
- `instantiate` refuses a template with no planned nodes, and one whose `schema` is unknown
- `toTemplate` demotes every place to planned, preserving `id`, `x`, `y`, `join`, and every
  edge that pointed at it still points at it
- `toTemplate` strips stamps through the shared `stripHostStamps` — asserted against the same
  helper `flow:resetEdge` calls, so the two cannot drift
- `stripHostStamps` drops all six host-owned fields, and **preserves `mode` and `note`** — the
  user's own configuration. An allow-list implementation of this strip once silently dropped
  `note` on every Reset; the test is what stops that returning
- round trip: `toTemplate` → `instantiate` yields the same node and edge counts and the same
  `(from, to)` wiring
- `readFlows` pointed at a templates directory returns nothing — the envelope is not a `Flow`
- `attachedWorkflow` finds a flow by place `runKey` and by planned `ticketKey`
- `attachedWorkflow` applies the precedence rule with two candidates, and breaks a tie by
  `createdAt`
- `workflowState` returns each of the six states from a fixture, including `done` as the
  absence of a pending rule

Webview:

- the block renders each of the six states, asserted with `waitFor`, never a bare tick
  (a `FileReader` can outlive a `setTimeout(0)` and land its post in the *next* test)
- `Approve` / `Reject` / `Reset` send the existing messages with the right edge id
- the `More` disclosure contains every action the current drawer exposes — enumerated, so an
  action cannot be silently dropped
- `templates.ts`, `attach.ts` and `WorkflowBlock.tsx` appear in
  `test/webview/webviewGraph.test.ts` with no Node builtin reachable from them

Gates:

- `test/unit/compat.test.ts` passes **unmodified** — no setting id, command id, storage key,
  telemetry value or run-shape change
- `test/unit/vocabulary.test.ts` extended: a UI string that arms a template, or a Templates
  row offering Detach, fails CI. The allowlist records every place `flow`/`orchestrator` is
  still correct
- `test/unit/docs.test.ts` passes — new commands documented in `docs/ORCHESTRATOR_COMMANDS.md`

## Phasing

One branch, landing once. The orchestrator's rule is that a feature reaches `main` whole —
a half-landed workflow surface is a chip that opens a drawer with no block behind it.

| Phase | Lands | Verifiable by |
|---|---|---|
| 1 | `stripHostStamps` extracted, both call sites on it | existing suite, unmodified |
| 2 | `templates.ts` + store: save, read, instantiate, refusals | engine tests, no UI |
| 3 | `attach.ts`: `attachedWorkflow`, `workflowState`, precedence | engine tests, no UI |
| 4 | `DeckDetail` new anatomy (§7) — no workflow block yet | drawer tests + the `More` enumeration test |
| 5 | `WorkflowBlock` + attach picker + card chip | webview tests over the six states |
| 6 | Templates tab, `Save as template…` dialog, row actions | webview tests |
| 7 | Docs, CHANGELOG, vocabulary allowlist | `docs.test.ts`, `vocabulary.test.ts` |

Phases 1–3 are pure and testable with no panel, which is where the design's own risk sits.
Phase 4 is separable on purpose: the drawer rebuild is worth verifying on its own before a new
block lands in it, and it is the phase most likely to reveal that a promoted action was the
wrong one.

Commit incrementally within each phase. A partial tree is verified with `npm run typecheck`,
never by grep — and mutation-check only committed work, since the checkout that restores a
mutant also reverts an uncommitted fix.

## Repo gates this work must clear

Restated here because a plan is what an implementer reads, not `CONTRIBUTING.md`:

```
npm run typecheck      # tsc --noEmit
npm test               # ~6,000 tests / 161 files, ~1 min — pass timeout: 600000
npm run build          # a REAL gate: esbuild resolves webview imports statically
npm run test:cov       # 90% lines/statements, 85% branches/functions
```

All four of CI's steps must pass (`npm ci`, typecheck, test, build). Never pipe vitest through
`tail`/`head` — it loses the failure list. A single failure under CPU contention is usually
flake: re-run that file alone before believing it, and prefer `-t "name"` over running a large
file whole.

New behaviour ships inert where it can: the Workflow block and chip appear only when
`agentFlow.orchestrator` is enabled, which is already default-off.

`main` moves fast and several sessions land on it a day — re-check `main`'s HEAD before
starting, and work in a git worktree so a parallel session cannot switch the checkout.
