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

## The blocker Phase 3 must clear before anything can spend money

**Two VS Code windows can fire the same rule twice.** `defaultFlowsDir()` is the global
`~/.agentflow/flows`; `DeckPanel` is per extension host; and advancing a flow is
read → evaluate → write with no lock. Two windows with the Deck open both read an unfired
edge and both fire it. This was proved with a probe: two identical toasts, one window's
`firedAt` overwriting the other's.

Phase 2b **narrowed** it — the write now re-reads the store, drops any edge another window
already stamped, and bases the write on that fresh copy rather than the stale evaluated one.
That last part is load-bearing and was not obvious: writing the stale flow erases the other
window's stamp on the very edge it just claimed, un-latching it, so the rule fires again on
the next pass. The window is now microseconds rather than a poll interval.

It is still read-then-write with no lock, so **it is not closed**. Today the cost is a
duplicate toast. The moment a rule can `launch`, the identical sequence is a **second paid
agent session**. A real fix needs either a lock file beside the flow or a per-workspace flows
directory — the latter changes the storage location and so needs a migration. Whichever is
chosen, **it must land before any action can spend money.** The constraint is also recorded
in a comment at the site in `deckView.ts`.

Two smaller things for the same phase, both inert while `notify` is the only action:

- **A flow disarmed mid-pass still completes that pass.** A pass already in flight stamps
  and toasts once even if the user disarms while it runs; the flow then correctly stays
  disarmed. Harmless for a toast, worth deciding for a launch.
- **`notifyLines` reads `action` from the stale edge while `applyFired` reads it from the
  fresh one.** Identical while every edge is `notify`; a divergence once actions differ.

## Carried forward from Phase 2a's reviews

Three things deliberately left as they are, each with a known consequence. None blocks a
merge; all three are cheap and belong in 2b.

- **The drawer opens unprompted on the first `deck:flows` post that carries any flow.** The
  auto-open rule treats a flow as "fresh" when it was not in the previous list, and on the
  first post the previous list is `[]` — so every saved flow reads as new. Mild today (the
  setting is off by default, the drawer is non-modal), but it means opening the Deck pops the
  drawer for anyone with a saved flow. Fix by seeding the seen-set from the first post, or by
  opening only when a create was actually requested.
- **A `pointerup` can save a one-event-stale node position.** Lifting `onSave` out of the
  `setDrag` updater — which was correct, and fixed a real double-write — means the release
  handler reads the drag position from its effect closure rather than from the updater's
  argument. `pointermove` is InputContinuous priority and `pointerup` is Discrete, so a
  release arriving before React flushes the final move saves the previous position. `snap()`
  hides it unless that move crossed a grid line. Fix with a `dragRef` read in the release
  handler.
- **The webview import-graph guard is narrower than its name.** `test/webview/webviewGraph.test.ts`
  walks relative imports only: it skips bare npm specifiers, so a webview-reachable package
  that requires `fs` passes the test and still fails the build. It also matches `import`
  syntax, not `require()` or dynamic `import()`. Adequate for this ESM/TS repo; worth widening
  if a dependency ever enters the webview graph.

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
   as the default once it works.

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
