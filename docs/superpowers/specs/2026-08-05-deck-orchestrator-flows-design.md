# Deck Orchestrator — flows Design

**Status:** approved 2026-08-05
**Mockup:** `docs/mockups/2026-08-05-deck-orchestrator-drawer.html` (variant B is the one being built; A and C are kept as the rejected comparisons)

## Goal

Add an **Orchestrator** to the Deck: a right-side drawer where you attach the agents
already on the board, wire them into a graph, and put a condition on each connection.
Arm the graph and Agent Flow advances it for you — launching the next agent when a
condition is met, or telling you when one trips.

Today the Deck observes and you act. A flow lets you record the decision *once*, before
the condition happens, and have it carried out while you are somewhere else.

## The constraint everything is designed around

**Agent Flow cannot type into a running Claude Code session.** It can launch a session
with a prompt pre-filled (`seedClaudeCode`, `src/engine/workspace.ts`) and it can read any
session's state, but there is no channel into an agent that is already running.

So a flow never "instructs" an attached agent. Its actions are only ones the extension can
actually perform: **launch** a new agent, **seed** another agent into an existing place, or
**notify** you. This is a hard boundary, not a v1 simplification.

## Decisions

| Question | Decision |
|---|---|
| What fires? | Both: some edges launch an agent, some only notify. A rule engine in the extension, not a briefed supervising agent. |
| What can be a node? | Cards on the board (dragged in) plus untaken Jira tickets (added from a picker in the drawer — the sidebar and the Deck are separate webviews and cannot share a drag). |
| Condition vocabulary | All four families: PR/CI facts, agent live state, git state, Jira status. Every one reads the snapshot `buildRunStatus` already builds. |
| Autonomy | Arm the whole flow. Inert while you build; once armed, launches fire without asking and a toast reports each one. |
| Drawer shape | **Node canvas** with port-to-port wiring and a docked edge inspector. The rule-list shape was recommended and explicitly not chosen; the canvas cost is accepted. |
| Evaluation lifetime | The Deck's poll keeps running while any flow is armed, even when the panel is hidden. Closing the panel warns first. |
| Ship state | Off by default (`agentFlow.orchestrator`), like `reviewWrites`. |

## Model

Stored per machine, mirroring the runs store: one file per flow under
`~/.agentflow/flows/<id>.json`.

```ts
export interface Flow {
  id: string;
  name: string;            // editable in place; names the header chip
  armed: boolean;
  createdAt: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/** Every node has a box and a join. `join` decides what several incoming edges
 *  mean: "any" fires on the first one met, "all" waits for every one. It lives on
 *  the target rather than the edge because it is a property of the meeting point. */
interface NodeBase { id: string; x: number; y: number; join: "any" | "all" }

/** Where an autonomous launch puts the work. The flow's own vocabulary, not
 *  `WorkspaceMode` — that type is only "multiroot" | "per-window" and cannot
 *  express the worktree choice a Take offers. The runner maps these onto the take
 *  path's arguments. */
export type LaunchDest = "worktree" | "new-window" | "current-window";

export type FlowNode =
  | (NodeBase & { kind: "place";   runKey: string; repo: string })
  | (NodeBase & { kind: "planned"; ticketKey: string; repos: string[];
                  mode: string; dest: LaunchDest })
  | (NodeBase & { kind: "notify";  message: string });

/** Parameterised where it has to be, a bare kind everywhere else. */
export type Condition =
  | { kind: "pr-merged" | "ci-passed" | "ci-failed" | "review-approved"
        | "changes-requested" | "threads-resolved" | "pr-conflicting"
        | "agent-ended-turn" | "no-agent-left" | "tree-clean"
        | "has-uncommitted" | "nothing-to-push" | "ticket-done" }
  | { kind: "agent-idle-over"; minutes: number }
  | { kind: "ticket-status-is"; status: string };

export interface FlowEdge {
  id: string;
  from: string;            // node id
  to: string;              // node id
  cond: Condition;
  action: "launch" | "seed" | "notify";
  mode?: string;           // prompt mode id, for launch and seed
  firedAt?: number;
  firedNote?: string;      // "opened bite-me-3a" — the receipt the drawer shows
  error?: string;          // the action threw; never retried until Reset
}
```

Three properties of this shape matter:

- **A place node never stores a session.** It stores `runKey` + `repo`. Sessions come and
  go inside a worktree; the worktree is what a rule can be about. Dragging an *agent* card
  supplies both (`CardAgent.repo` is already resolved host-side). Dragging a *workspace*
  card with several repos creates one node with a repo selector, defaulting to the first
  repo that has a PR — so a node always resolves to exactly one repo and no condition is
  ever ambiguous about which repo it means.
- **A planned node carries its launch config.** An armed launch cannot stop to ask which
  repo, which prompt mode or which destination, so those are chosen when you wire it.
- **`join` lives on the target, not the edge.** "When *every* attached agent has merged,
  tell me" is drawn as N edges into one node with `join: "all"`. That is how the canvas
  expresses the any/every quantifier the rule-list shape had in a dropdown. It applies to
  any node kind, not just notify — "when both PRs merge, launch the integration ticket" is
  the same shape with a planned node at the end. A node with one incoming edge ignores it.

### A planned node becomes a place once it launches

This is what makes chains work. When a `launch` edge fires successfully, its planned target
is **rewritten in place** to a `place` node bound to the run that was just created — same
`id`, same `x`/`y`, same `join`, so every downstream edge keeps pointing at it and starts
evaluating against the new run's `RunStatus` on the very next pass.

Without this, `ASM-1 merged → launch ASM-12 → ASM-12's CI passes → launch ASM-15` could
never advance past the second step: a planned node has no run to observe.

The rewrite is part of the same store write that stamps `firedAt`, so a crash between the
two cannot leave a launched ticket looking unlaunched.

### Node states

A node whose run has been forgotten or retired renders **gone** — struck through, with a
yellow badge. Not red: nothing failed, the place simply is not there. An armed flow with a
gone node **reports it in the footer** rather than silently waiting on a condition that can
never be met again.

## Conditions

Every predicate is a pure function of one `RunStatus` (plus the node's `repo`), so the whole
vocabulary is table-testable against fixtures with no I/O.

The two ticket conditions are named `ticket-*`, not `jira-*`, even though Jira is the only
source today: a condition kind is persisted inside a saved flow, and the pluggable-connectors
work renames the field they read. Naming them neutrally now costs nothing and avoids
migrating every user's flow files later.

| Condition | Reads |
|---|---|
| `pr-merged` | `prs[repo].facts.state === "MERGED"` |
| `ci-passed` | `ci.failing.length === 0 && ci.pending === 0 && ci.passing > 0` |
| `ci-failed` | `ci.failing.length > 0 && !ciAdvisory` — advisory-only failures do not fire it, because they do not block a merge |
| `review-approved` | `facts.review === "approved"` |
| `changes-requested` | `facts.review === "changes_requested"` |
| `threads-resolved` | `facts.unresolved === 0` |
| `pr-conflicting` | `facts.mergeable === "conflicting"` |
| `agent-ended-turn` | `agent.state === "needs-you"` |
| `agent-idle-over` | `agent.state === "idle" && now - lastActivityMs > minutes` (parameterised) |
| `no-agent-left` | no entry in `agents[]` for this node's repo |
| `tree-clean` | `!repo.dirty` |
| `has-uncommitted` | `repo.dirty` |
| `nothing-to-push` | `repo.ahead === 0` |
| `ticket-done` | `jiraCategory === "done"` — the field the connectors spec renames to `ticketCategory` |
| `ticket-status-is` | `jiraStatus === param` |

Two honest limitations to state in the UI, not hide:

- **`nothing-to-push` cannot distinguish "pushed" from "has no upstream"** — `RepoGit.ahead`
  is 0 in both cases. The condition is labelled *nothing to push* rather than *pushed* for
  exactly this reason.
- **Agent conditions are best-effort and depend on the Live signal toggle.** With Live
  signal off, `agent.state` is `unknown` and no agent condition can ever fire. An armed flow
  that contains one while the toggle is off says so in the footer.

## Actions

| Action | Mechanism it reuses |
|---|---|
| `launch` | The take path that already opens a workspace and seeds an agent, driven from the planned node's stored config rather than from prompts. |
| `seed` | The Address PR re-seed in `deckView.ts` — a new agent in a place that already exists. |
| `notify` | A Deck toast plus the header chip's count. No writes anywhere. |

## The latch

This is the part that decides whether the feature is safe.

- An armed edge is re-checked every poll. It fires when its condition holds **and**
  `firedAt` is unset. Firing stamps `firedAt` and `firedNote`.
- **A failed action stamps `error` and is never retried.** Retrying a launch that threw is
  how you get twenty windows.
- **Reset** clears `firedAt`, `firedNote` and `error` for one edge.
- **At most 3 launches per evaluation pass.** A pass that wants more logs what it deferred;
  the rest fire on the next pass. A cap that silently truncates would read as "nothing else
  was ready".
- Disarming does not clear latches. Re-arming resumes where the flow left off.

## Evaluation lifetime

`DeckViewProvider` starts and stops its poll on `onDidChangeViewState`. That changes in one
place: **the poll keeps running while any flow is armed**, even when the panel is hidden.

Closing the panel still ends evaluation. This originally specified a dialog *before*
closing — **Disarm · Keep it open · Close anyway** — and that turned out to be
unbuildable: VS Code exposes no cancellable close for a webview panel. `onDidDispose`
fires after disposal and there is no `onWillDispose`, so a close cannot be vetoed, and the
user closes the panel with the tab's × or the keyboard rather than through a command that
could be wrapped.

What ships instead: on close, if anything was armed, the extension says so plainly and
offers to reopen the Deck. The flow stays armed on disk, so the intent survives — and the
**resume gate** below is what makes coming back safe, which is the guarantee the dialog was
reaching for anyway.

### Coming back to an armed flow

An armed flow persists across restarts, so the first evaluation after the panel is created
does **not** act. It reports what is ready — "3 rules are ready: …" — and waits for **Go**
or **Disarm**. Every pass after that fires normally. Without this, reopening the Deck after
a week acts on every condition that went true while you were away, and once launching
exists that means paid agent sessions starting before you have read anything.

The gate is per panel and deliberately not persisted: it protects the moment you come back,
and asking on every poll would defeat arming.

Extracting the observation loop host-side so armed flows survive the Deck being closed is
the correct end state and is **explicitly out of scope here** — it is a refactor of
`deckView.ts`'s `buildAll()` at the project's coverage bar, and it is not needed to make the
feature useful. Recorded as the follow-up.

## UI

All configuration lives in the drawer. Nothing about a flow is edited anywhere else.

**Header chip.** `⚡ Orchestrator · 1 armed`. A chip, not a filled button — the board's
primary verbs live on the cards, and a filled control in the header would outrank them. Only
present when `agentFlow.orchestrator` is on.

**Drawer.** Slides from the right, starting **below** the header so the chip you just pressed
and the Live-signal / PR-facts toggles stay visible and reachable. Default 560px, resizable
from its left edge (min 380px), and `⤢` expands it to the full panel for heavy wiring.
**No scrim** — a modal veil would block the drag the drawer exists to receive, so the board
stays fully live while it is open.

Top to bottom: flow name (editable) and **Arm** · **Agents tray** · **Graph** · **edge
inspector** · footer. The tray sits **above** the graph: attaching comes before wiring, and
it matches the order the list shape used. The graph takes the remaining height and the
inspector is docked under it — a canvas that scrolls the inspector out of view makes you
scroll away from the thing you are editing.

**Tray.** A wrapping row of chips, one per place or planned node, and the primary drop
target. It is a view of the same node list, never a second store. Clicking a chip highlights
its node on the canvas.

**Graph.** Nodes are 168px — enough for a state dot, the ticket key, and the one fact the
rules read. Drag a node to move it (snapped to an 8px grid); drag from its right port to
another node to create an edge, and every legal target announces itself while you drag.
Planned nodes are dashed, because the place does not exist until a rule launches it. Notify
nodes are pill-shaped and have no outgoing port. **Tidy** re-runs the auto-layout, and a
card dropped in is auto-placed — a drop never needs hand-positioning to be legible. No
pan/zoom: Tidy and expand cover it.

**Edges.** Bezier, labelled with the condition, the label sitting *above* the midpoint
because a label as wide as the gap between two columns hides the connector it labels. Colour
is state, not decoration: neutral while waiting, brand while selected, green once fired, and
danger-tinted **only** when the condition is itself a failure (`ci-failed`,
`changes-requested`, `pr-conflicting`).

**Inspector.** `WHEN <condition>` / `THEN <action> <target>` / `USING <mode> in a <dest>`,
plus the live state — `waiting · CI running, 4 of 7` or `fired 12:04 · opened bite-me-3a`
with **Reset**. Three fixed-width keywords, so the rule reads as a sentence.

**List view.** A button that renders the same graph as the WHEN/THEN/USING list from
mockup variant A. This is the keyboard path — a canvas built from divs and pointer events
has no usable keyboard story, and shipping the graph as the only way to edit a flow would
make the feature unreachable without a mouse. Same store, no second model.

**On the board.** A card wired into a flow carries one quiet line — `⚡ Ship the migration ·
node 1 of 3` — and only while a flow exists. No persistent hint lines.

**Toast.** `Ship the migration launched ASM-12 in bite-me — CI passed on ASM-2.` Every
autonomous action reports what it did and why, with an **Open** action.

## Concurrency: resolved in Phase 3

**Two VS Code windows can fire the same rule twice.** `defaultFlowsDir()` is the global
`~/.agentflow/flows`; `DeckPanel` is per extension host; and advancing a flow is
read → evaluate → write. Two windows with the Deck open both read an unfired edge and both
fire it. This was proved with a probe: two identical toasts, one window's `firedAt`
overwriting the other's.

Phase 2b **narrowed** it — the write re-reads the store, drops any edge another window
already stamped, and bases the write on that fresh copy rather than the stale evaluated one.
Phase 3 **closes** it with a TTL lock over the flows directory (`src/engine/orchestrator/lock.ts`),
held for the whole of one pass:

- `acquire`/`release` take a **per-pass token**, not a per-panel one — `refresh()` polls every
  six seconds and a pass can now sit inside a spend-confirmation modal for minutes, so two
  passes from the same panel overlapping is the normal case, not a race to reason about. A
  shared token would let the first pass's `release` delete the second pass's live lock.
- A window that cannot take the lock does **nothing** — no evaluation, no write, no toast —
  and tries again on its next poll.
- The lock **reaps rather than steals**: `acquire` on a lock past its TTL (`LOCK_TTL_MS`,
  300s) deletes it and still returns `false`. It does not then re-create and return `true` —
  two windows independently judging the same stale lock dead would otherwise both come away
  believing they hold it, which is the double-launch this exists to prevent. The pass *after*
  the one that reaped a dead holder is the one that actually acquires.
- The TTL is crash recovery, not mutual exclusion for a holder that hangs. 300s must
  comfortably exceed the slowest thing done under the lock — a launch that opens a window —
  so erring long is cheap (nothing here is urgent) and erring short is not (a lock reaped out
  from under a live launch is a second paid session).
- **Consent is asked outside the lock.** A spend-confirmation modal is answered on human time;
  the lock is held on machine time. The pass that finds a flow needs asking performs nothing
  and records the ask; the modal itself runs after `release`, so no other window waits on a
  human, and past the TTL the lock is free for another window's pass to use while the modal is
  still up.

Two smaller races carried from the same phase, both now closed too, in `advanceUnderLock`:

- **A flow disarmed mid-pass no longer completes that pass.** This took two fixes, not one.
  Every acting edge re-reads the store and checks `armed` immediately before it runs, not
  once for the whole flow — a launch or a seed is its own `await`, and up to three can run
  in one pass, each one long enough for a Disarm to land in between. That guard alone was
  not enough: the pass's own write was still built from the copy read *before* those awaits,
  so it silently overwrote a Disarm that landed during them, turning the guard into a
  one-poll pause rather than a stop — the edges it left pending would simply relaunch on the
  very next pass, because the flow never looked disarmed to that pass either. The write now
  re-reads the store one more time, immediately before writing, and takes every edge and
  every flow-level field from THAT read rather than the evaluated one — only the stamps on
  the edges this pass actually decided about come from the earlier read plus their outcomes.
  The same fix incidentally closes the identical hole for a concurrent rename, a
  `flow:resetEdge` on a sibling edge, and a node edit: none of them race the write anymore
  either.
- **`notifyLines` and `applyFired` now read `action` from the same (fresh) copy.** Both decide
  "is this a notify" by indexing the flow that is actually about to be written, by edge id —
  not from the `FiredEdge.edge` reference evaluation captured, which could be a stale object
  if the edge's action changed between evaluation and the write.

## The canvas and the keyboard path: shipped in Phase 4

- **Label placement.** `labelPoint` (`layout.ts`) starts at the chord midpoint and, when that
  point lands inside a node's box, steps along the chord's own **normal**, alternating
  directions and growing the offset one increment at a time, until the point itself clears
  every obstacle's box — a point-in-box test, not a true clearance check, and bounded at 16
  steps, after which it returns the last candidate even if that one still lands inside a box.
  The normal, not a vertical nudge, because a vertical-only offset on a diagonal edge drifts
  off the line and orphans the label from the edge it names. Two
  alternatives were considered and rejected: **hover-only** reveal, because it merely defers
  the collision — selecting the offending edge reproduces it, so the label still has to sit
  somewhere while inspected — and **orthogonal lane routing**, because it needs a real router
  to be worth building, and the widened drawer this phase also ships makes the collision rare
  enough that the router's cost isn't earned.
- **Resize and expand.** The drawer's width is a CSS custom property (`--orch-w`) dragged from
  the left edge or nudged by `ArrowLeft`/`ArrowRight` on the resize grip, clamped between a
  420px floor and a viewport-derived ceiling that keeps one board column visible. The chosen
  width is persisted through the webview's own `setState`/`getState` (`OrchPersisted`,
  `OrchestratorDrawer.tsx`) — no new host protocol — so it survives a remount. **Expand** is
  the escape hatch for a graph big enough to want the whole panel: it renders at
  `window.innerWidth`, deliberately not the resize ceiling's board-reserving clamp, and is
  deliberately **session-only** — plain `useState`, never written to `OrchPersisted` — because
  the resize width is the considered choice and expand is a momentary one; collapsing it must
  restore the width the user actually chose, not silently adopt whatever was last full-screened.
- **The ticket picker.** Before this phase, nothing in the drawer could create a `planned`
  node — the model and the `launch` action existed since Phase 3, but there was no UI path to
  populate one, so `launch` was built and tested yet unreachable end to end. `flow:addPlanned`
  (`deckView.ts`) closes that gap with a chain of native `showQuickPick`s — ticket, then repos
  (multi-select), then prompt mode, then destination — sourced from the same connector and repo
  discovery the rest of the extension already uses. The ticket, repos and destination steps each
  refuse plainly (a toast, no picker) rather than opening an empty one when there is nothing to
  choose from; the prompt-mode step in between asks unconditionally, with no such guard —
  harmless in practice, not by design: `promptModes` (`config.ts`) falls back to the built-in
  defaults whenever the configured list resolves empty, so that picker can never actually be
  empty for a guard to refuse.
- **The list view.** `FlowList` (`flowList.tsx`) renders each rule as its own
  WHEN/THEN/USING row and reads and writes through the exact `Flow` object and the exact
  `onSave`/`onResetEdge` callbacks the canvas already uses — one model, two presentations, not
  a second copy that can drift. A roving-tabindex row list, arrow keys to move, Enter/Space to
  open a row's own `<select>`s, and a keyboard-only "add a node" bar and `NewRuleBar` mean a
  flow can be attached, wired, edited and reset from the keyboard alone. **Arm** itself was
  never canvas-only — it is one ordinary button below the Canvas/List toggle, reachable by Tab
  regardless of which view is open — so arming, not only building, has always had a keyboard
  path; what this phase adds is the ability to reach that point without a pointer at all.

## Known limitations

Decisions, not a bug list — each one was looked at and left as it is, with the reason it is
cheaper to live with than to fix.

- **A launch can report success for a run that was never recorded.** `openWorkspace` treats
  its `writeRun` as best-effort and swallows a failure (`src/engine/workspace.ts`), and
  `OpenResult` carries no signal that it happened. So `launchPlanned` can legitimately return
  `{ ok: true, runKey }` for a run with no record on disk, after which `evaluate.ts`'s
  `byKey.get(runKey)` misses it forever: the node this launch just promoted to a place
  observes nothing, and the chain stalls with no explanation. **Not a Phase 3 regression** —
  an ordinary Take has exactly the same hole, and fails the same way. Changing
  `openWorkspace`'s error posture would touch the Take path too, and that is out of scope
  here.
- **A crashed window stalls other windows' flows for up to five minutes.** `LOCK_TTL_MS` is
  300s because it must exceed the slowest thing done under the lock — a launch that opens a
  window. The TTL is only crash recovery, never mutual exclusion for a live holder: erring
  long is cheap, because flows poll every six seconds and nothing here is urgent, while erring
  short lets a lock be reaped out from under a live launch — a second paid session for the
  window whose lock was just taken.
- **An unanswered spend confirmation stalls its own panel's flows.** The in-flight guard
  (`advanceInFlight`) means that panel runs no further passes until its modal is answered.
  Other windows are unaffected, because the asking happens outside the lock — see above.
- **Two `notify` edges into one node toast twice.** The act-once-per-target rule deliberately
  covers only spending actions (`launch`, `seed`); a duplicate toast is cheap, and collapsing
  it would hide the fact that two distinct rules both became true.
- **A `writeFlow` that throws right after a real launch relaunches it, and pays again.** The
  act-then-record comment at that site in `advanceUnderLock` guarantees atomicity across
  *outcomes* within one pass — a crash between deciding two edges' fates cannot leave one
  looking unlaunched — not atomicity across the act and the record themselves. If the store
  write throws after `performEdge` genuinely launched (or seeded) something, nothing gets
  stamped, so the next pass sees the same edge still unfired and launches it again. The same
  shape as the `writeRun` limitation above, and left the same way: `writeFlow` failing at all
  is rare (a full disk, a permissions change mid-session), and a from-scratch retry-and-toast
  path here would need its own tests to be trusted on the one loop in this file that spends
  money — not a change to make under this task's time budget.

## Carried forward from Phase 2a's reviews

Three things were flagged as deliberately left for 2b. Two are now fixed — recorded here
rather than deleted outright, since a reader hunting for why the drawer used to pop open
unprompted, or why a dragged node used to land one move short, should still find the answer.

- **Fixed in 2b.** The drawer used to open unprompted on the first `deck:flows` post that
  carried any flow, because the auto-open rule's "is this fresh?" check compared against an
  empty previous list on that first post, so every saved flow read as new. `DeckApp.tsx` now
  gates on `seenFlowsRef`: nothing is ever "fresh" against a post that hasn't landed yet, so
  the first post can never auto-open anything.
- **Fixed in 2b.** A `pointerup` used to save a one-event-stale node position: lifting `onSave`
  out of the `setDrag` updater (correct, and it fixed a real double-write) left the release
  handler reading the drag position from its effect closure rather than from the last move.
  `OrchestratorDrawer.tsx` now writes a `dragRef` synchronously on every `pointermove` and
  reads that ref, not the closed-over state, in the `pointerup` handler — the exact fix this
  entry used to ask for.
- **The webview import-graph guard is narrower than its name.** `test/webview/webviewGraph.test.ts`
  walks relative imports only: it skips bare npm specifiers, so a webview-reachable package
  that requires `fs` passes the test and still fails the build. It also matches `import`
  syntax, not `require()` or dynamic `import()`. Adequate for this ESM/TS repo; worth widening
  if a dependency ever enters the webview graph. Still open — nothing in Phase 3 or 4 touched
  this guard.

## What Phase 1 forced into Phase 2's contract

Three requirements the review of the built core surfaced. They are binding on Phase 2, not
optional polish.

- **Flow ids must match `/^[A-Za-z0-9_-]+$/`.** `store.ts` builds a filename from the id, so
  an unvalidated id read back from a hand-edited file was an arbitrary-path write and unlink
  (`"id": "../../../../.zshrc"` resolved to `/.zshrc.json`). The store now rejects such a
  record on read and throws on write. A name-slug id scheme — spaces, dots, non-ASCII —
  therefore breaks; `randomUUID()` and `Date.now().toString(36)` both pass.
- **The runner computes "stalled" itself, from `flow.edges.some(e => e.error)`.** An errored
  `all` junction deliberately returns `fired: []`, `blocked: []`, `deferred: 0` — the
  `blocked` channel is typed for *nodes* whose observation is impossible, and an errored edge
  already carries its own `error` string for the drawer to render per-edge. Nothing else
  explains why an armed flow stopped advancing, so without this the shipped failure mode is a
  flow that quietly stops and says nothing.
- **A place's agent state is never the run's aggregate on a multi-repo run.** `RunStatus.agent`
  is `mostActive()` over every agent in every repo, so falling back to it for a place with no
  agent of its own reported a *different* repo's agent as that place's — which fired a paid
  launch because an unrelated worktree's agent ended its turn. `placeActivity` now falls back
  only when the run has one repo, and returns unknown otherwise. Any new code asking "what is
  this place's agent doing" must call `placeActivity`, never read `status.agent` directly.
  **This rule was broken once already**, in Phase 2a's node badge, which read
  `runs.find(...)?.agent.state` directly and put an amber "needs-you" dot on a node whose own
  repo had no agent — while the inspector, which does go through `placeActivity`, said unknown
  in the same panel. Grep for `.agent.state` before adding any status display.

- **`flow:save` must not let a stale drawer overwrite the host's own writes.** Today the host
  accepts a whole-flow save after checking only that the id exists. From 2b onward the host
  itself stamps `firedAt`, `firedNote` and `error` onto that same file during its poll. A
  drawer holding a `flow` prop from before a stamp would, on its next save, write those fields
  back out as absent — **clearing the latch and re-firing an action that already ran**, which
  for a `launch` means paying for a second agent session. Fix it in 2b by one of: having the
  drawer send only `nodes` and `edges` and letting the host merge them over its own copy; or
  merging host-owned fields per edge id on receipt. Do not leave the whole-document write as
  it stands once anything can arm.

## Build order

This is more than one sitting's work, so the plan stages it. Each phase leaves the
extension shippable.

1. **The pure core** — `model.ts`, `store.ts`, `conditions.ts`, `evaluate.ts`, `layout.ts`.
   No UI, no wiring, nothing user-visible. All of the risk in the condition semantics and
   the latch lands here, where it is cheapest to test.
2. **Notify-only, end to end** — the runner, the `agentFlow.orchestrator` setting, the poll
   change and the close confirmation, and a drawer that can attach nodes and wire
   notify edges. Arming now does something real, and nothing it does can launch anything.
3. **Launch and seed** — the two acting verbs, the planned→place rewrite, the launch cap,
   and the toasts. This is the phase that needs the most care in review.
4. **The canvas proper** — port-to-port wiring, node dragging, Tidy, expand and resize,
   plus the list view. Phase 2's drawer can be the list view first; the canvas replaces it
   as the default once it works. **Shipped** — see "The canvas and the keyboard path:
   shipped in Phase 4" above; the canvas stayed the default view throughout, with List as
   a toggle rather than a first cut later replaced.

## Multiple flows

Several flows may exist and several may be armed at once; the header chip counts the armed
ones. The same run may be a node in more than one flow — the card's wire line names the
first and counts the others (`⚡ Ship the migration +1`).

## Surfaces

| File | Change |
|---|---|
| `src/engine/orchestrator/model.ts` | *(new)* types; no imports |
| `src/engine/orchestrator/store.ts` | *(new)* flow persistence, pure over an injected reader/writer, mirroring `engine/runs.ts` |
| `src/engine/orchestrator/conditions.ts` | *(new)* `evalCond()` + `describe()` |
| `src/engine/orchestrator/evaluate.ts` | *(new)* `(flow, RunStatus[], now) → FiredEdge[]`, owns the latch and the cap |
| `src/engine/orchestrator/layout.ts` | *(new)* `anchors()`, bezier path, `tidy()` — pure, so canvas geometry is testable without a DOM |
| `src/orchestratorRunner.ts` | *(new)* the only impure piece: performs actions, stamps `firedAt`, posts toasts |
| `src/webview/OrchestratorDrawer.tsx` | *(new)* tray, canvas, inspector, list view |
| `src/webview/orchestratorStyles.ts` | *(new)* uses `TOKENS_CSS`; must not redeclare a token |
| `src/deckView.ts` | poll survives hidden panel while armed; close confirmation; flow messages |
| `src/webview/DeckApp.tsx` | header chip, drawer mount, card wire line, card drag source |
| `src/types.ts` | flow message shapes on `InboundMessage` / `OutboundMessage` |
| `src/config.ts` | `agentFlow.orchestrator`, default false |
| `package.json` | the `contributes.configuration` entry only |
| `README.md`, `docs/TELEMETRY.md` | document the drawer and the new events |

## Testing

- **conditions.ts** — table-driven over fixture `RunStatus`, every predicate in both
  polarities, plus `ciAdvisory` not firing `ci-failed`, and `unknown` agent state firing no
  agent condition.
- **evaluate.ts** — fires once and not twice; a gone node reports instead of waiting; a
  disarmed flow yields nothing; the 3-launch cap defers rather than drops; `join: "all"`
  waits for every incoming edge while `"any"` does not; a node with one incoming edge is
  unaffected by its `join`.
- **planned→place rewrite** — a fired launch rewrites its target and leaves `id`, `x`, `y`
  and `join` untouched; a downstream edge from that node evaluates against the new run on
  the next pass; a launch that throws leaves the node planned.
- **store.ts** — round-trip; a corrupt file yields no flows rather than throwing; unknown
  fields survive a write.
- **layout.ts** — anchors against known node boxes; `tidy()` assigns depth-major columns;
  a cycle terminates.
- **runner** — an injected launcher spy asserts the launch arguments; a throwing launcher
  stamps `error` and is not called again on the next pass.
- **deckView** — the poll keeps running when hidden with a flow armed, and stops when none
  is; the close confirmation appears only when armed.

Gates, restated because a plan's workers follow the plan and not `CONTRIBUTING.md`:
`npx tsc --noEmit` clean, `npx vitest run` green, **≥95% coverage on changed files**, and
the work happens in a worktree — never the main checkout, since `vsce package` packages the
working directory. Do not touch the `version` field in `package.json`,
`package-lock.json`, or `CHANGELOG.md`.

## Non-goals

- Prompting or steering a running agent. Impossible; see the constraint above.
- Conditions on anything the Deck does not already observe (test output, coverage, logs).
- Canvas pan and zoom.
- Sharing or syncing a flow between machines or windows.
- Extracting the observation loop host-side so armed flows advance with the Deck closed —
  the recorded follow-up.
- Touching the Take-flow "Orchestrator" *prompt mode* in `DEFAULT_PROMPT_MODES`. It shares
  a word with this feature and nothing else; a flow is a board object, that is a prompt.
