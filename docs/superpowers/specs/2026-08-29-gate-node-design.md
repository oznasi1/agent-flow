# A gate node — let a flow ask, not just tell

**Date:** 2026-08-29
**Branch:** `feat/gate-node`
**Backlog item:** none — Notepad item [04], "the missing node"
**Mockup:** `docs/mockups/2026-08-29-gate-node.html` (gitignored, local only)

## Why

Once a flow is armed it is fire-and-forget. It can notify you, but it cannot stop
and wait for you. So the shape everyone actually wants —

> deploy to staging → **ask me** → deploy to prod

— is inexpressible, and the workaround is to not arm the flow at all. That
workaround throws away the whole point of the drawer: the condition vocabulary is
its best feature, and a flow you have to babysit is a flow you may as well drive by
hand.

A gate node is the missing primitive. A rule into it poses a question and stops; you
answer Approve or Reject; downstream rules read that answer as an ordinary
condition.

The model already has the shape to copy. `command-succeeded` is a condition whose
verdict lives on the target node's incoming edge and is intercepted in
`evaluate.ts`'s `isMet` before `evalCond` ever sees it. A gate works the same way.

## Decisions

### 1. A new node kind and a fourth, non-spending verb

```ts
export type GateNode = NodeBase & { kind: "gate"; question: string };
```

The same shape as `NotifyNode`, with `question` where `message` is. Nothing else on
it — no timeout, no custom button labels, no assignee.

`actionFor("gate")` returns a new `FlowAction`, `"ask"`. It is deliberately **not**
added to `isSpendAction`'s allowlist, which that function's own comment says is how
a new action should default. Four things follow for free:

- `evaluate.ts`'s `costsSlot` is false, so a gate never consumes a
  `MAX_LAUNCHES_PER_PASS` slot. A question costs nothing and should not compete
  with launches for the cap.
- `deckView.ts`'s dispatch guards on `isSpendAction`, so it never calls
  `performEdge` for an ask. There is no perform path to write.
- No `commandConfirmedAt`-style consent gate. Both existing gates exist because the
  action spends something — a paid session, or shell on your machine. A question
  spends neither.
- `applyFired` stamps it through the final, non-spending branch: `firedAt` plus a
  receipt, no outcome required.

### 2. The answer lives on the performer edge

One new optional field on `FlowEdge`:

```ts
gateAnswer?: "approved" | "rejected";
```

Set on the edge carrying `performed: true` — the same edge `commandSucceeded` names
as its performer, and for the same reason: `firedAt`/`error` alone cannot tell a
real performer from an "all"-junction sibling or a per-target-dedupe sibling that
`applyFired` stamps with an identical shape.

**On the edge, not on the node**, because Reset is per-edge. Putting the answer on
the edge is what makes it inherit the Reset affordance with no new UI: clearing the
ask edge clears the answer, and the next pass re-poses the question.

**No `answeredAt` timestamp.** The drawer shows the verdict; it does not need a
relative time to do so, and every field added here is a field a future Reset must
remember to delete.

`firedAt` cannot itself be the verdict — the distinction that makes this different
from `command-succeeded`. An ask edge fires the moment the question is posed, which
means "asked", not "approved". The verdict needs its own storage.

### 3. Two conditions, not one

`gate-approved` and `gate-rejected`, both bare `CondKind`s, both intercepted in
`isMet` before the place/status lookup:

```ts
if (e.cond.kind === "gate-approved") return gateAnswer(i.flow, e.from) === "approved";
if (e.cond.kind === "gate-rejected") return gateAnswer(i.flow, e.from) === "rejected";
```

Offering both, rather than `gate-approved` alone, is not scope creep. The stamp has
to distinguish "rejected" from "unanswered" regardless — otherwise the drawer cannot
stop asking and cannot show you what you decided — so the data is on disk either
way. Refusing to let a rule read half of it would be an arbitrary limit, not a
simplification, and it would make a rejected gate indistinguishable from an
unanswered one to every downstream rule. With both, "reject → notify the team" is
expressible.

An unanswered gate returns `false`, not `undefined`. Both fail `met(e) !== true` and
the `allMet` check identically, and `false` matches `commandSucceeded`'s existing
convention.

`gateAnswer` carries the same two guards as `commandSucceeded`, for the same
documented reasons:

- the node's `kind` must actually be `"gate"`, because a hand-edited flow file or
  one written by another build never passed through a picker, and without the check
  `incomingEdges` would read some other node's edges;
- the performer is found by `e.performed === true` with a `firedAt`, never inferred
  from the absence of an error, which breaks under per-edge Reset.

### 4. No toast — the drawer is the only surface

The question is **not** posted as a `showInformationMessage`. This was considered
and rejected.

Dropping it deletes the most dangerous part of the design: an unawaited toast
promise can resolve an hour later into a flow that has since been disarmed, deleted,
renamed, Reset, or answered elsewhere, and every one of those needs a guard on the
resolve path. Without it there is one write path — `flow:answerGate` from the
webview — and one set of checks.

The cost is stated plainly: **a gate is only discoverable with the Deck's flow
drawer open.** The blocked note in decision 6 is the only passive signal.

The Deck's attention badge is **not** a cheap substitute and is out of scope here.
`AttentionCandidate` (`engine/attention.ts`) is thoroughly run-shaped —
`agentState`, `prs`, `ticketStatus`, `hasLiveSession`, `hasWorkToLose` — and a gate
is none of those. Feeding it a gate means either faking a run or adding a second,
non-run producer into the badge count. That is its own piece of work.

### 5. Approve / Reject on the node, and the height that follows

The buttons are mounted on the canvas node itself, visible whenever the gate is
waiting. No selection step. This is the only node on the board that carries a
control.

**The drag hazard is handled by the file's own idiom.** `.orch-node` has
`cursor: grab` and an `onPointerDown` that calls `startDrag`. The button row takes
`onPointerDown={(e) => e.stopPropagation()}` — exactly what `.orch-port` does two
lines away in the same `flow.nodes.map`. `startDrag` never sees the pointer, so a
button cannot initiate a drag and a press-then-move cannot become an approve. What
remains is an ordinary mis-aimed click on an ordinary button.

**A gate node is taller than `NODE_H`, and that has to be threaded through.**
`NODE_H` is 44 and it is what edges anchor to, via `boxOf`
(`OrchestratorDrawer.tsx`). A gate carrying a button row is about 70px. Left alone,
the CSS port sits at `top: 50%` of the true height (~y+35) while the SVG path
anchors at `y + 44/2` = y+22, and **the wire visibly misses its own port**.

The fix follows the existing pattern: export `GATE_H` from `layout.ts` and add a
height ternary in `boxOf` beside the width one that already switches on `notify`.
That single line covers edge anchoring, the obstacle list `tidy` routes around, and
the clipped-right check. `anchor`, `edgePath` and `tidy` all take a `Box` and never
read `NODE_H` themselves. The one other `NODE_H` use — drop-centring a newly created
node — stays as it is; a new gate is unasked, and being centred a few pixels off on
creation costs nothing.

`GATE_H` is **constant for the kind, not per-state.** An answered gate keeps the
same height, with the verdict line occupying the row the buttons had. A height that
changed with the answer would make every wire into and out of the gate jump the
moment you clicked.

**The four node states:**

| state | dot | body |
|---|---|---|
| not asked yet | `--dim` | the question |
| asked, waiting | `--c-attn` | the question, then Approve / Reject |
| approved | `--c-done` | `approved — <question>` |
| rejected | `--dim`, grey | `rejected — <question>` |

Rejected is grey, **not** `--c-danger`. Red on a card means something is broken; a
rejection is a decision you made. Approve takes `--c-done` and Reject the neutral
`--edge`, so no new `--brand` rule is introduced and `tokens.test.ts`'s per-stylesheet
allowlist needs no edit.

**One answering surface, rendered twice.** The inspector edits `question` and shows
the verdict with **Reset to ask again**; it does not duplicate Approve / Reject. But
the **List view row does** carry the same two buttons, because List is the drawer's
keyboard path for the same flow and would otherwise be unable to answer a gate at
all. Canvas node and List row are two renderings of one node, not two surfaces.

Both sets of buttons take `aria-label`s naming the question — "Approve" alone is
ambiguous when two gates are open.

**The List view also needs a real arm, not a default.** Its row currently reads
`n.kind === "notify" ? n.message : "runs a command"`, so a gate would render as
"runs a command" — the same lie `endLabel`'s comment describes a command node once
telling when `notify` was the fallthrough. `endLabel` itself gains a `gate` arm
returning `"gate"` for the same reason.

### 6. A blocked note for an unanswered gate

A new `BlockedNote` reason, `"awaiting-answer"`, on the gate node, surfaced in the
drawer's footer as "gate — waiting on your answer".

Emitted **only** when the question has actually been asked — a performer edge with a
`firedAt` — and `gateAnswer` is still undefined. Not when no rule has reached the
gate yet: that is ordinary not-there-yet, and it already reads correctly as silence.
The existing per-node dedupe in `note()` applies unchanged.

With no toast, this is the only signal that a flow is stalled on you rather than on
the world, so it is carrying more weight than the two reasons beside it.

### 7. First answer wins

An answer is final until Reset. If `gateAnswer` is already set, a second answer is
ignored rather than overwriting.

This is not fussiness: a downstream rule may already have fired on the first answer
and latched. Letting a later click flip `approved` to `rejected` would leave the
flow in a state its own record contradicts. Changing your mind means Reset, which
re-poses the question and leaves the already-fired downstream rule latched — correct,
because Reset is per-edge and re-asking should not silently un-deploy anything.

The write path re-reads the flow under the lock immediately before writing, the
discipline every other `flow:*` handler in `deckView.ts` follows, and bails if the
flow is gone, the edge is gone, the edge is no longer the performer, or an answer is
already recorded.

## What changes

**`src/engine/orchestrator/model.ts`** — `GateNode`; `"gate"` in `FlowNode`; `"ask"`
in `FlowAction`; `gate-approved` and `gate-rejected` in `CondKind`; `gateAnswer` on
`FlowEdge`; `actionFor`'s `"gate"` arm; an `isGate` predicate beside its siblings.
`isSpendAction` is untouched by design.

**`src/engine/orchestrator/evaluate.ts`** — `gateAnswer(flow, gateNodeId)`, mirroring
`commandSucceeded`; two interception lines in `isMet`; `"awaiting-answer"` on
`BlockedNote["reason"]` and the note that emits it.

**`src/engine/orchestrator/conditions.ts`** — two throwing arms in `evalCond` and
two unreachable arms in `describeCond`, mirroring `command-succeeded`'s. Both
kinds are intercepted before either function, so a `false` here would be a
silent wrong guess rather than an answer; throwing is the choice its neighbour
already documents.

**`src/engine/orchestrator/runner.ts`** — one arm in `performedNote` returning
`asked you: ${question}` for `action === "ask"`, mirroring the notify arm. The
neutral `"fired"` default that its comment reserves for a future non-spending verb
would work, but the receipt is worth the two lines. Nothing else in this file
changes; `applyFired` already routes a non-spending verb correctly.

**`src/engine/orchestrator/layout.ts`** — `GATE_H`.

**`src/deckView.ts`** — a `flow:answerGate { id, edgeId, answer }` handler with the
guards from decision 7; `delete kept.gateAnswer` added to `flow:resetEdge`'s
deny-list, which that handler's comment already warns is required for any new
host-owned stamp.

**`src/types.ts`** — the `flow:answerGate` message.

**`src/webview/OrchestratorDrawer.tsx`** — the gate node's four states and its button
row; the height ternary in `boxOf`; the List row's arm and its buttons; `gate` in the
`actionNodes` filter and the add-a-node combo; the inspector's question field and
verdict block.

**`src/webview/orchestratorRule.ts`** — `endLabel`'s `gate` arm; `COND_LABEL` entries
for both conditions; `offeredConds` extended so a gate source offers exactly the two
gate conditions and nothing else, and no other source offers them — the same
disjointness `command-succeeded` established; `defaultCondFor`'s gate arm;
`condLine` returning null for both kinds before `describeCond` can reach a throwing
arm.

**`src/webview/orchestratorStyles.ts`** — the button row and the verdict line.

## Compatibility

Checked against the code rather than assumed:

- `validNode` admits `kind: "gate"` — it only requires a string — so an older build
  renders the node instead of dropping it.
- `validEdge` accepts `action: "ask"`; it requires only that `action`, when present,
  is a string.
- `latchActionMismatches` returns early when the derived action is `undefined`, and
  an older build's `actionFor("gate")` is exactly that. So no spurious
  action-mismatch error is stamped on downgrade.
- An older **armed** build will fire the ask edge with `action: undefined`, and
  `applyFired` stamps `error: "this rule points at …, which is not a place, planned
  work, a notification, or a command."` One error, visible, resettable, nothing
  spent. This is the same downgrade shape the `command` node shipped with, so it is
  precedent rather than a new hazard.
- `coerceFlow` already carries unknown fields through untouched, so `gateAnswer`
  survives an older build rewriting the file.

Nothing in `test/unit/compat.test.ts` currently freezes the flow file shape — it
freezes only the `agentFlow.orchestrator` setting id. A frozen gate-flow fixture is
added there.

## Testing

In the existing homes; no new directories.

- **`evaluate.test.ts`** — each `gateAnswer` guard separately: a non-gate node id, no
  performer, a performer with `performed` but no `firedAt`, approved, rejected,
  unanswered. That the two conditions are intercepted before the place lookup (a
  gate source must never produce a "gone" note). That `awaiting-answer` fires only
  after the question was asked, and dedupes per node.
- **`runner.test.ts`** — `performedNote`'s ask arm; an ask edge stamped through the
  non-spending path with no outcome supplied.
- **`model.test.ts`** — `actionFor("gate") === "ask"`; `isSpendAction("ask") === false`;
  `edgeAction` through a gate target.
- **`store.test.ts`** — a gate flow round-trips with node, ask edge and `gateAnswer`
  intact; `latchActionMismatches` stays quiet on it.
- **`deckView.test.ts`** — `flow:answerGate` re-reads under the lock; first-answer-wins;
  bails on a missing flow, a missing edge, and a non-performer edge; `flow:resetEdge`
  clears `gateAnswer`.
- **`OrchestratorDrawer.test.tsx`** — buttons render only while waiting; `boxOf`
  returns `GATE_H` for a gate and `NODE_H` for the rest; the List row says "gate",
  not "runs a command".
- **`compat.test.ts`** — the frozen gate-flow fixture.

**What the suite cannot check.** `stopPropagation` on a `cursor: grab` surface is
precisely the drag/selection class jsdom is blind to. The button-versus-drag
interaction must be verified in a real editor window before merge. It is not a test
that can be written.

Coverage thresholds in `vitest.config.ts` (90% lines/statements, 85%
branches/functions) apply as normal.

## Docs

- The Orchestrator paragraph in `docs/GUIDE.md`, where the command node is
  introduced, gains the gate.
- `docs/ORCHESTRATOR_COMMANDS.md` is command-scoped and is not touched.
- `CHANGELOG.md` under `## [Unreleased]`.

## Out of scope

- **Free-text questions.** A gate answers Approve or Reject. Feeding a typed answer
  into a downstream launch's `note` is a different feature with a different storage
  shape.
- **The Deck attention badge**, for the reason in decision 4.
- **Timeouts and auto-approve.** A gate that answers itself is not a gate.
- **Instructing a running session.** Still impossible, as the orchestrator spec's
  out-of-scope note on `tell` already records.

## Known risks

1. **Discoverability.** With no toast and no badge, a gate is invisible unless the
   drawer is open. This is a deliberate, user-chosen trade; the footer note is the
   mitigation. If it proves too quiet in use, the badge is the follow-up, and it is
   a real piece of work rather than a switch.
2. **The pointer interaction.** Mitigated by the existing `stopPropagation` idiom
   and unverifiable by the suite. Requires a real-window check.
3. **Downgrade.** An older armed build stamps one error on the ask edge. Bounded and
   resettable, and precedented by the command node.
