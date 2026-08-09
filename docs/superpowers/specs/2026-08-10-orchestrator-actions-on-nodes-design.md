# Orchestrator: actions on nodes, and a command node

**Date:** 2026-08-10
**Status:** design, awaiting review
**Phase:** 5 of the Deck Orchestrator

## Why

Manual testing produced a report I could not argue with: "I don't understand the
notify node." The re-explanation that followed described a model very close to
what is built, with one real mismatch — and the mismatch is my design error, not
a misreading.

The user's model: a node is a step; an edge is the condition to advance; the
action happens at the destination node.

What ships today: the action is stored on the **edge** (`FlowEdge.action`) *and*
implied by the destination **node kind**. Two homes for one fact. `launch` only
works against a `planned` node, `seed` only against a `place` node — the drawer
enforces exactly that (`actionMismatch`), which is the tell that the edge's copy
was always redundant.

Two capability gaps came with the report. Of three examples given, only one is
buildable:

| Asked for | Today |
| --- | --- |
| "verify on staging" | Works — `seed` plus the free-text note added last phase. |
| "wait for build to pass on master, deploy to staging" | No action can run anything, and `ci-passed` reads the node's own PR, not a branch. |
| "post a DM message" | Nothing. No Slack, no webhook, no shell. |

A single new node kind — **run a command** — closes both of the latter. A deploy
and a DM stop being two features and become two entries in a settings list.

## Decisions taken

Confirmed with the user before this document was written:

1. **Full collapse.** The node kind is the single home for the action. An edge
   carries only its condition.
2. **A `command` node**, driven by a named list in settings, and a rule may also
   carry a raw free-text command.
3. **Exit code plus captured output.** Exit 0 advances; non-zero latches the edge
   as errored. stdout/stderr go to the Deck's output channel.
4. **A branch-CI condition** is in scope, so "build passed on master" is
   buildable.

On (2) the user explicitly chose to allow free-text commands over a
config-only list. That stands. This design keeps a **once-per-flow confirmation**
before a flow runs its first command, which is not a re-litigation of that
choice: `launch` already has exactly this gate (`Flow.launchConfirmedAt`), and
running arbitrary shell unattended is strictly more dangerous than opening a
window. Extending the existing gate to a more dangerous action is consistency
with what is there. It is one prompt per flow, ever.

## Architecture

### The action is the node kind

```
FlowEdge   { id, from, to, cond, mode?, firedAt?, firedNote?, note?, error? }
                                   ^ no `action`

actionFor(node.kind):
  planned  -> launch   (start a session for work that has not begun)
  place    -> seed     (open another agent where one already exists)
  notify   -> notify   (tell me, in VS Code)
  command  -> run      (execute a configured or free-text command)
```

`isSpendAction` keeps its allowlist shape and gains `run`. That function's
existing comment already warns that a new action defaults to "does not spend"
until someone adds it deliberately — a command node spends, so it goes in.

`mode` stays on the edge. A launch's mode lives on its `planned` node, but a
`place` has no mode field and one place may be seeded differently by two
different rules, so a seed's mode is genuinely per-transition.

### The migration hazard

`store.ts`'s `validEdge` currently requires `typeof e.action === "string"`, and
an edge that fails validation is **dropped on read**. Removing the field
naively would silently delete every edge of every flow file already on disk.
There are thousands of installs; this is the single highest-risk item in the
phase.

Reading must therefore be tolerant in both directions:

- `action` becomes **optional** in `validEdge`. An old file with it and a new
  file without it are both valid.
- The field is **ignored** for behaviour. The action is always derived from the
  target node.
- It is nonetheless **still written**, as a derived mirror of the node's kind.
  This is the direction that is easy to get backwards: an older build's
  `validEdge` *requires* `action`, so a file this build wrote without it would
  have every edge dropped the next time the user opened an older version — a
  downgrade, a second machine on the release channel, or a rollback. Writing the
  derived value keeps old and new builds reading the same file. `writeFlow` is
  the single choke point every save already goes through, so the mirror is
  maintained in exactly one place.
- Unknown fields already ride along untouched (`coerceFlow` spreads the record),
  so a file written by this build and then read by an older one still carries
  whatever that build needs.

### The one case where derivation changes meaning

The collapse is a bijection for `launch` and `seed`, because `actionMismatch`
already refuses every other pairing. It is **not** a bijection for `notify`:
nothing today stops an edge with `action: "notify"` from pointing at a `place`
node. Derivation would silently turn that edge into a **seed** — opening a paid
agent session where the user asked for a toast.

That must never happen unattended. On read, when a stored `action` is present
and disagrees with the action derived from the target node:

- the edge is **kept**, not dropped — the user's wiring is not ours to discard;
- it is stamped `error` with a message naming both readings, which latches it
  (`isSettled`), so an armed flow will not fire it;
- the drawer's existing stalled-rule affordance surfaces it, and Reset is the
  way to accept the new reading.

A latched rule costs one click. A migration that spends money on a guess is not
recoverable.

### The command node

```ts
export type CommandNode = NodeBase & {
  kind: "command";
  /** An id from `agentFlow.commands`, or absent when `run` carries the command. */
  commandId?: string;
  /** A free-text command. Mutually exclusive with `commandId`. */
  run?: string;
  /** Where to run. Resolved against the flow's repos; defaults to the repo of
   *  the node the incoming edge came from. */
  cwdRepo?: string;
};
```

Settings mirror `agentFlow.promptModes` exactly, because that is the list the
rule picker already reads from and the user asked to reuse that pattern:

```jsonc
"agentFlow.commands": [
  {
    "id": "deploy-staging",
    "label": "Deploy to staging",
    "detail": "Triggers deploy.yml against the staging environment",
    "run": "gh workflow run deploy.yml -f env={note}"
  }
]
```

`{note}` substitution reuses `src/engine/prompt.ts`'s `composeAgentPrompt`
placeholder discipline — slice-based, never `String.replace`, because `$&` and
`$1` in user text are interpreted by the replacement argument. A command
template with no `{note}` and a note present appends nothing: unlike a prompt,
appending free text to a shell command changes what runs.

Execution reuses the `Runner` abstraction from `src/engine/pr/provider.ts`
rather than calling `child_process` afresh — it is already the seam every test
in the PR path fakes. A command gets a timeout on the same order as
`GH_TIMEOUT_MS`, and its `LOCK_TTL_MS` interaction matters: a command outliving
the flows lock would have its lock reaped mid-flight, so the command timeout
must stay well under 300 s.

The module is `src/engine/orchestrator/command.ts`: pure decision plus an
injected runner, no `vscode` import, matching `launch.ts`'s posture so it stays
testable without a window.

### New conditions

```ts
| { kind: "command-succeeded" }
| { kind: "branch-ci-passed"; repo: string; branch: string }
```

`command-succeeded` reads the receipt the command node left, so a chain of
`deploy -> verify -> notify` is expressible.

`branch-ci-passed` asks about a branch, not a PR, which no existing condition
can do. It goes through the same `gh` runner the PR facts already use
(`gh api repos/{owner}/{repo}/commits/{branch}/status`, or `gh run list
--branch`), and is cached per poll like `PrEntry` is — one extra call per poll
per distinct repo+branch, not per node.

It must degrade the way every other condition does: unreadable means **not
met**, never "assume green". An armed flow that deploys because an API call
failed is the worst outcome available here.

### Notify

Renamed in the UI to **"Notify me in VS Code"**. No behaviour change. The
current label implies it messages someone, which is exactly the confusion that
started this phase. A DM is now a command node against a webhook.

## Out of scope

- **`tell`** — injecting a prompt into a running session. Still blocked on
  detecting that the agent is at its prompt rather than the shell; typing into a
  live shell would execute the instruction as a command. Unchanged from the
  earlier decision.
- **A Slack client.** A webhook via a command node is the whole story.
- **Collapsing `armability`'s unreachable live-signal branch.** A real change,
  tracked separately, deliberately not folded in here.

## Testing

Beyond the repo's gates, three things carry this phase's risk and get named
tests:

1. **A flow file written by the shipping build reads back with every edge
   intact.** A fixture captured from the current format, not a hand-written
   one — the failure mode is silent edge deletion, and a fixture I author from
   the type would encode my assumption rather than the format.
2. **A `notify`-action edge pointing at a `place` does not become a seed.** It
   latches with an error and fires nothing.
3. **A failed command latches and does not retry.** The `firedAt`/`error`
   latch is what stops a broken deploy from running every poll.

Every new test gets mutation-checked: break the guard, watch that specific test
fail, restore. Plan-authored tests have been this project's dominant defect
source — six in phase 3, two in phase 4, none of them found by reading.

## Global constraints

Restated because a task's implementer sees only its own brief:

- `npm run build` must exit 0. Nothing reachable from `src/webview/` may import
  `fs`, `os`, `path`, or `child_process`, even transitively — `tsc` and the test
  suite both pass regardless, so only the build catches it.
- `npx tsc --noEmit -p .` clean. `lib` is capped at ES2022; `Array.prototype.findLast`
  does not compile.
- The full suite passes **unmodified** except where a test encodes behaviour this
  phase deliberately changes; each such edit is called out in its commit.
- `src/engine/orchestrator/*` imports no `vscode`. The panel does all I/O.
- New `--brand` spends must be added to `tokens.test.ts`'s allowlist deliberately.
