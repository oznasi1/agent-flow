# Flow templates — draw the shape once, run it on any ticket

**Date:** 2026-08-26
**Branch:** `feat/flow-templates`
**Backlog item:** none — from the orchestrator review against Babysitter (recommendation 09)

## Why

Every flow in the drawer is welded to identifiers that name one piece of work:

1. **A `PlaceNode` stores a `runKey` and a `repo`** — a run that already exists on
   this machine.
2. **A `PlannedNode` stores a `ticketKey`** — one ticket, by name.

So the ship-it shape you drew for ASM-1 cannot run on ASM-2. You redraw it. That
ceiling is why the drawer stays a one-off tool no matter how good the condition
vocabulary gets, and the condition vocabulary is the best thing in it: seventeen
predicates over PR state, CI, review threads, git cleanliness, agent activity and
ticket status, each with a documented fail-closed reading. All of it is currently
trapped in graphs that die with the ticket that prompted them.

What people re-draw is a three-to-five node shape whose only variable is which
ticket it is about. That is the thing to make reusable, and nothing more.

## Decisions

### 1. The ticket is the only parameter

A template fixes everything else: repos, prompt modes, launch destinations,
commands, notes, join modes, and every condition including the parameterised ones.
You pick a ticket at instantiation and nothing else.

Three reasons this is the right cut, not merely the cheap one:

- **The repo set is a property of the shape, not of the ticket.** "When the backend
  PR merges, deploy, then smoke-test" names the same repos every time it runs. A
  template that asked which repos would be asking the user to re-decide something
  the template already encodes.
- **`launchPlanned` already fails loudly on a repo that isn't here.** It resolves
  every named repo against the checkouts on this machine and refuses outright when
  none resolve, naming what is missing. A template naming a repo you don't have
  therefore fails at launch with a sentence, not silently at instantiation — so
  binding repos at instantiation buys no safety that isn't already bought.
- **One parameter needs no parameter UI.** Instantiation is the ticket picker that
  already exists. A general parameter system needs a form, a type per parameter, and
  validation — for a feature whose whole value is that it saves you from a form.

Deferred, not rejected: repos as named slots. The file format below carries a
`params` record that is empty in v1, so adding a second parameter later is an
additive change to a shape that already has room for it, not a migration.

### 2. A template holds no places

This is the load-bearing decision, and the engine has already solved it.

A `PlaceNode` names a run that exists. A template carrying one would either point at
a stale `runKey` — every condition on it reading nothing, forever, which
`evaluate.ts` reports as `blocked: "gone"` — or need a resolution step at
instantiation that no picker can answer, because the run the template wants has not
been created yet.

But `promoteToPlace` already rewrites `planned → place` the moment a launch
succeeds, keeping the node's `id`, `x`, `y` and `join` precisely so every downstream
edge stays pointing at it. The direction a template needs is the direction the
engine already runs. **So a template stores planned nodes only, and instantiation
lets the ordinary promotion path turn them into places as the flow runs.**

The cost lands on the save side: **Save as template** must demote each place back to
planned, and a `PlannedNode` carries four fields a `PlaceNode` does not have.

| Planned field | Recovered from a place how |
|---|---|
| `ticketKey` | Not recovered — this is the parameter. |
| `repos` | `[place.repo]`. A place is exactly one repo, by construction. |
| `mode` | **Not recoverable.** The prompt mode lives on a seed edge or on the planned node that promotion destroyed. |
| `dest` | **Not recoverable.** It lived on the planned node too, and a place created by a Take never had one. |

Do not guess these. The save dialog shows one row per demoted place with a mode and
destination picker, prefilled with the configured default prompt mode and
`worktree`. Two pickers on a dialog the user opened deliberately is a smaller cost
than a template that silently launches into the current window because a default was
invented for them.

### 3. Host stamps are stripped by the deny-list Reset already uses

`flow:resetEdge` deletes `firedAt`, `firedNote`, `error` and `performed`, and it is
**deliberately a deny-list**. It used to be an allow-list that rebuilt the edge from
its known non-host fields, and that allow-list silently dropped `note` — the user's
own configuration — every time anyone pressed Reset.

A template save that re-implemented the strip would reintroduce exactly that bug at
a second call site, and the next host-owned field added to `FlowEdge` would be
forgotten in one of the two places. Extract the strip into `model.ts` as
`stripHostStamps(e: FlowEdge): FlowEdge` and call it from both. A host-owned field
added to `FlowEdge` then has exactly one function to update.

At the flow level the save also drops `id`, `createdAt`, `armed`, and both consent
stamps — see next.

### 4. Consent never travels with a template

`launchConfirmedAt` and `commandConfirmedAt` are per flow, asked once, and then the
flow spends unattended forever. They are separate fields for a good reason already
documented in `model.ts`: approving an agent session is not approving shell
execution.

A template that carried either would multiply that single consent by every instance.
Twenty instantiations of one approved template is twenty flows running `deploy.sh`
unattended on a machine whose owner approved one command, once, for a different
ticket. **Every instance asks for itself.** This is a correctness requirement with a
test, not a preference.

It is also the sequencing argument: templates multiply whatever the consent model
is. Recommendation 05 of the review — consent keyed to the resolved command text
rather than to the flow, plus an `agentFlow.neverAutoRun` glob list — should land
**before** this feature, or templates make the existing coarse consent worse in
direct proportion to how useful they are.

### 5. Storage is a sibling directory with the same IO

`~/.agentflow/templates/<id>.json`, read and written through the same injected
`FlowIo` the flows store uses, with the same rules:

- **The same id charset.** `fileFor` turns an id straight into a path, so
  `VALID_FLOW_ID` (`[A-Za-z0-9_-]+`) is a path-traversal guard, not cosmetics — and
  it is why ids are minted, never slugged from a name. A slug scheme throws on the
  first template called "My flow".
- **The same tolerance.** One corrupt or half-written file costs one template, never
  the whole picker.

The file is a template envelope, not a bare `Flow`:

```jsonc
{
  "schema": 1,
  "id": "k3f9-ship",
  "name": "Ship it",
  "params": {},          // reserved — the ticket is implicit in v1
  "savedAt": 1756200000000,
  "flow": { /* nodes: planned | command | notify only; edges without stamps */ }
}
```

The envelope earns its keep by making a mis-filed file fail to parse. A bare `Flow`
sitting in the templates directory is indistinguishable from a flow someone moved
there, and `readFlows` pointed at either directory would load it into the drawer as
a real, armable flow. Two shapes, two readers, no overlap.

### 6. Instantiation is a pure function

`instantiate(template, ticketKey, mintId): Flow` lives in a new
`src/engine/orchestrator/templates.ts`, pure over injected id minting like every
other module in that directory:

- a fresh flow id, minted by `flowIo` — still the only place an id is minted
- **fresh node and edge ids** via `nextNodeId` / `nextEdgeId`, never the template's.
  Edge ids are the key `outcomes` is keyed by within a pass and the key Reset
  addresses; two instances of one template sharing them is a collision waiting for
  the first cross-flow view.
- every `PlannedNode.ticketKey` set to the chosen ticket
- `armed: false`, `createdAt: now`, no consent stamps, no edge stamps

Purity here buys what it bought `evaluateFlow`: the whole substitution is
table-testable from fixtures, with no filesystem, no panel, and no clock.

**`templates.ts` must stay a leaf.** The drawer imports it, the webview bundles for
a browser target, and esbuild resolves statically — one hop into a module that
reaches `fs`, `os`, `path` or `child_process` and `npm run build` stops resolving
while `tsc` and the tests pass regardless. This is the same constraint
`conditions.ts` documents at the top of the file and `test/webview/webviewGraph.test.ts`
pins.

### 7. Refusals

Both directions refuse rather than produce something that cannot work:

- **Save refuses a flow with no nodes.** Nothing to reuse.
- **Instantiate refuses a template with no planned nodes.** There would be nothing
  to bind the ticket to, and the result is a flow that can never launch anything —
  a graph of commands and notifications rooted at nothing, waiting forever.
- **Instantiate refuses a template whose `schema` this build does not know.** Unlike
  a flow file, where an unknown node kind rides along on purpose so a newer build's
  flow still renders, a template is executed by being *copied* — an unrecognised
  shape would be copied into a live flow wholesale.

Hand-edited oddities carried inside the flow — a `command-succeeded` edge whose
source is not a command node, say — are carried through unchanged. `evaluate.ts`
already guards that case on the read side and a template must not become a second
validator that disagrees with it.

### 8. UI: three affordances, and deliberately no fourth

- **Save as template…** on the flow's own controls. Dialog: a name field, plus one
  row per demoted place with mode and destination pickers (§2).
- **New from template…** beside "+ New flow". A search-and-tick list, matching
  `+ Add command…` and `+ Add place…` — those are lists rather than menus because a
  menu made the feature's headline example two trips, and picking a template and a
  ticket has the same shape.
- **Instantiate from a Deck card.** The card knows its ticket, so this path skips the
  ticket step entirely and is the one most people will use.

No template management in v1 — no rename, no delete, no duplicate in the UI. The
files are plain JSON in a known directory. A management surface is a second feature
and should be judged on whether anyone accumulates enough templates to need it.

### 9. What this does not solve

A template makes a shape reusable. It does not make the shape safer. An instantiated
flow still cannot stop and ask you anything (review recommendation 04 — a gate
node), still latches terminally on any failure with no retry, and still spends under
whatever consent model is current. Templates raise the value of every one of those
gaps by making the flows they apply to more numerous.

## Test plan

All against the pure engine, no panel:

- `instantiate` binds the chosen ticket to **every** planned node, not just the first
- `instantiate` mints node and edge ids disjoint from the template's
- no edge in an instantiated flow carries `firedAt`, `firedNote`, `error` or `performed`
- an instantiated flow has `armed === false` and **neither** consent stamp
- `instantiate` on a template with no planned nodes refuses
- `toTemplate` demotes every place to planned, preserving `id`, `x`, `y` and `join`,
  and every edge that pointed at it still points at it
- `toTemplate` strips stamps through the shared `stripHostStamps` — asserted against
  the same helper `flow:resetEdge` calls, so the two cannot drift
- round trip: `toTemplate(flow)` → `instantiate` yields the same node and edge counts
  and the same `(from, to)` wiring
- `readFlows` pointed at a templates directory returns nothing — the envelope is not
  a `Flow`
- `templates.ts` appears in the webview import graph test with no Node builtin
  reachable from it

## File structure

| File | Responsibility |
|---|---|
| `src/engine/orchestrator/templates.ts` | **Create.** Pure leaf: `FlowTemplate`, `toTemplate`, `instantiate`, `validTemplate`. Imports `model.ts` only. |
| `src/engine/orchestrator/model.ts` | Modify. Extract `stripHostStamps(e: FlowEdge): FlowEdge`. |
| `src/engine/orchestrator/store.ts` | Modify. `defaultTemplatesDir`, `readTemplates`, `writeTemplate`, `removeTemplate` — same `FlowIo`, same id guard. |
| `src/deckView.ts` | Modify. `flow:saveTemplate` and `flow:newFromTemplate` handlers; templates ride along on `deck:flows`. |
| `src/webview/OrchestratorDrawer.tsx` | Modify. Save dialog, tick-list picker. |
| `src/webview/DeckApp.tsx` | Modify. "New from template" on a card's overflow, ticket pre-filled. |
| `src/types.ts` | Modify. The two message types and the template shape crossing the wire. |

## Open question

Whether a template should record the **flow name** as a pattern rather than a fixed
string — "Ship {ticket}" instantiating as "Ship ASM-12". It costs one substitution in
`instantiate` and makes a board of instances readable instead of showing five flows
all called "Ship it". Recommended, but it is the one decision here that adds a
templating syntax to a file format that otherwise has none, and that syntax will want
to grow. Worth deciding before Task 1 rather than during it.
