# Workflows and Templates: navigation, authoring, and starters

**Date:** 2026-09-02
**Status:** approved design, not yet implemented
**Base:** `feat/card-workflows` (PR #63) — this builds on it, not into it

## The problem

Card workflows shipped in #63 with a first-run path that dead-ends in every
direction:

1. Card → drawer → **Attach workflow…** → `"No templates saved yet"`
   (`DeckDetail.tsx:140`). Flat text, no exit.
2. The Deck header button with zero flows does not open anything — it fires
   `flow:create` and drops the user on a blank canvas.
3. With flows, Templates is three clicks deep (Orchestrator → `Flows · N ▾` →
   Templates) and its empty state reads *"Build a workflow, then use its own
   Save as template…"*, pointing back at the canvas.

There is no path to a first template except: draw a graph on the canvas, then
Save as template. Nothing says so at the place the user hits the wall. A
`＋ New template` button was deliberately removed from the Templates tab because
it called `onCreate`, which mints an ordinary *workflow* — the right instinct
about the wrong verb.

Separately, the header says **Orchestrator** (a machine name) while the card
chip says **Workflow** and the picker inside says **Flows · N** — three names
for closely related things on one screen.

## Decisions

Each of these was decided explicitly; the rationale matters more than the choice.

### 1. Templates become directly authorable

A template is edited as a template, on the canvas, rather than only being
derived from a workflow via `toTemplate`. `FlowTemplate` already wraps a whole
`Flow` (`flow: Flow`), so the canvas needs no new shape — only a mode.

Rejected: a **draft-flow round-trip** (mint a real `Flow`, edit, convert on
save). Flows are global under `~/.agentflow/flows` and shared across windows
behind a lock, so a draft would have to be hidden from the Active list, the
Running tab, arming, the 6-second evaluation pass, and the card-chip
derivation — and a crash mid-edit orphans it, so another window sees a live
workflow the user never made.

Rejected: a **dedicated minimal template editor**. A second graph editor to
maintain forever, weaker the moment a shape branches, and it teaches two
editors for one concept.

### 2. Built-in starters, never written to disk

Three starters ship inside the extension and always appear in the
Templates list, flagged as built-in. They cannot be renamed or deleted;
**Duplicate** makes an editable copy that becomes an ordinary user template.

Nothing is written to `~/.agentflow/templates/`, so there is no migration, no
risk to the never-break-existing-users invariant, and a starter improved in a
later release reaches everyone who upgrades. The cost, accepted: two classes of
row in one list, and rename/delete disabled on built-ins.

Rejected: seeding into the user's storage (writes on upgrade; a deleted starter
is gone for good; a fixed starter never reaches anyone who already ran it).

### 3. The Active view is card-centric

One row per card carrying a workflow, in any state, sorted so what needs the
user floats up. Clicking a row opens that card's drawer.

This makes the global view and the card chip **literally the same derivation at
two scopes**, which is the property that keeps them from drifting. Unattached
and half-drawn canvas flows do not appear here; they stay on the canvas where
they are authored.

Rejected: "only armed and moving" (a freshly attached workflow arrives
disarmed on purpose and so would never appear). Rejected: "every flow that
exists" (mixes things watching a ticket with half-drawn graphs, under a heading
that says *active*).

### 4. Header: two sibling buttons

The single **Orchestrator** button becomes two peers. Both destinations are one
click from the board, always — which is what makes the zero-template dead end
impossible by construction rather than by empty-state copy.

| Button | Badge | Opens |
| --- | --- | --- |
| **Workflows** | `N needs you` if any is waiting or stopped, else the number of rows in the Active list | drawer on **Active** |
| **Templates** | count, starters included | drawer on **Templates** |

Costs roughly 110px of header width. The header already drops its token tile at
narrow widths, so there is precedent for what yields first.

Rejected: one button with an internal segmented control (Templates stays
*behind* Workflows, so with zero of everything the user must still know to open
Workflows first). Rejected: a split button (a caret reads as *overflow*, the
opposite of the promotion Templates needs, and the codebase uses that idiom
nowhere else).

This also retires **Orchestrator** as a user-facing word on the Deck header. The
drawer's interior strings (`Flows · N ▾`, `+ New flow`, `Delete flow`,
`Flow view`) are replaced by the new navigation rather than left to disagree
with it.

## Design

### `starters.ts`

A new pure leaf module, `src/engine/orchestrator/starters.ts`, exporting
`STARTERS: FlowTemplate[]`. Data only — no `fs`, no `path` — because the webview
imports the type. Ids are prefixed `builtin-`, which satisfies the existing
`/^[A-Za-z0-9_-]+$/` charset.

`postFlows` sends `[...STARTERS, ...readTemplates(io, dir)]`, so starters arrive
over the same `deck:flows` post as user templates and `TemplateRow`'s "on N
cards" count works on them unchanged.

Read-only is enforced in the host, not merely greyed out in the UI:

- `readTemplates` skips any on-disk `builtin-*.json`, so a hand-copied file
  cannot shadow a starter. Same discipline as the existing
  filename-must-match-id check.
- The host refuses `flow:renameTemplate`, `flow:deleteTemplate` and
  `flow:saveTemplate` on a `builtin-` id.
- `flow:duplicateTemplate` is allowed and mints an ordinary user id.

### `instantiate` must bind repos and mode

`instantiate` today substitutes **only** `ticketKey`:

```js
const bound = isPlanned(n) ? { ...n, id, ticketKey } : { ...n, id };
```

`PlannedNode` also carries `repos: string[]` and `mode` (a `PromptMode` id), both
of which come from the template verbatim. A shipped starter cannot know either —
and baking them in would violate **"No hardcoded organization values"**, since
repo layout and prompt modes are `agentFlow.*` settings read through
`getConfig()`.

This is also a latent wrinkle in the code as shipped: a template saved against
repo A, attached to a card in repo B, currently carries repo A's repos.

**Change:** starters ship with `repos: []` and no mode. `instantiate` widens with
an injected context so it can resolve those two from the card being attached —
`repos` from the run, `mode` from the user's first configured prompt mode. If the
user has no prompt modes configured at all, the attach fails with that stated as
the reason rather than launching into a guessed destination — the same honesty
`DemotionChoice`'s own comment demands. This
fits how the function is already pure over an injected flow id and clock, and
keeps it table-testable from fixtures.

Strictly backward-compatible: a non-empty `repos` or a mode the user actually has
configured still wins, so every template saved under #63 instantiates
identically. `dest: "worktree"` is safe to bake — a concept, not an org value.

### Addressing the drawer

`openFlowId: string | null` becomes a target:

```ts
type OrchTarget = { kind: "flow"; id: string } | { kind: "template"; id: string } | null;
```

The drawer resolves a flow from `p.flows` and a template from `p.templates`,
then edits `template.flow`. `useDrawerExit` keys on `` `${kind}:${id}` `` so the
slide-out seam is unchanged.

### Drawer navigation

The `Flows · N ▾` disclosure is replaced by `view: "active" | "templates" |
"canvas"`. Active and Templates are the two header destinations; Canvas holds
the existing graph and authoring.

### The Active list

A new pure component, `src/webview/WorkflowList.tsx`. One row per card carrying
a workflow: ticket key, title, template name, the engine's own state line, and a
hue rail. Sorted needs-you → advancing → done.

Its data is `cardWorkflow(flows, status, runs, now, branchCi)` — the same call
the chip makes. `DeckApp` computes `chipWorkflow(c)` per card today; hoist it to
one map consumed by both the board and the list, which also retires the
per-render recompute that file's own comment flags as a cost.

Clicking a row closes the drawer and selects the card, so the workflow is read
where it lives.

### Authoring mode

`editingTemplate = target?.kind === "template"` gates off every workflow verb:
Arm/Disarm, dry-run, the resume banner, Save-as-template, attach. This is
exactly the rule already written down in `OrchestratorDrawer.tsx` — *a template
cannot be armed, disarmed or detached, because it has no ticket and nothing to
watch*. Save routes to `flow:saveTemplate`.

`＋ New template…` builds a draft **in `DeckApp` state, never on disk**, with one
`planned` node so `canBindTicket` passes on first save. The drawer resolves a
template target from `p.templates` *or* that draft. Cancel discards; nothing is
written until Save.

A hand-authored graph has `planned` nodes rather than `place` nodes, so
`placesToDemote` returns empty and the demotion dialog never appears. Authoring
is a simpler path than saving from a live workflow, not a harder one.

### Starter content

Three shapes, using only `planned` / `command` / `gate` / `notify` and existing
conditions:

| Name | Shape |
| --- | --- |
| **Ship it** | planned → *ended turn* → command `test` → *passed* → gate "Open a PR?" |
| **Test & merge** | planned → *ended turn* → command `test` → *passed* → *branch CI passed* → notify |
| **Review only** | planned → *ended turn* → notify "ready for review" |

A starter's command node uses the free-text option that already exists for the
ordinary case of `agentFlow.commands` being empty.

### Errors

`canBindTicket` already guards both ends of save; authoring surfaces it as a
disabled button with an inline reason, not a toast. The host refuses built-in
writes even though the UI disables those buttons — a stale webview can still
send the message, which is the reasoning `canBindTicket`'s own comment gives.

## Testing

- **The verb gate.** One spec asserting no workflow verb (arm, disarm, dry-run,
  resume, attach) renders in template mode. This is the concentrated cost of
  editing templates on the shared canvas, and the thing most likely to regress.
- **Every starter is valid and instantiable.** `validTemplate` plus
  `instantiate` against a fixture card, per starter. A broken built-in must fail
  CI, never the user's first attach.
- `readTemplates` skips on-disk `builtin-*.json`.
- The host refuses rename, delete and save on a built-in id.
- `instantiate` resolves empty `repos` and an unconfigured mode from the injected
  context, and leaves a populated `repos` and a valid mode alone.
- Active list ordering, and that a row click selects the card.
- Header: both buttons render under `orchEnabled`; the zero state opens a view
  instead of minting a flow.
- `starters.ts` stays leaf-pure — `test/webview/webviewGraph.test.ts` plus
  `npm run build`, which is the only real gate for a bare specifier that pulls
  in `fs`.
- `test/unit/compat.test.ts` unmodified.
- Coverage thresholds hold: 90% lines/statements, 85% branches/functions.

## Non-goals

- Renaming `Flow` in the code. The UI stops saying it; identifiers, stored
  values, message wire values and condition keys keep their released spelling.
- One-step Replace on an attached workflow (still Detach then Attach).
- A History tab over the journal.
- Parameterised templates. `FlowTemplate.params` stays `Record<string, never>`.

## Risks

- **The verb gate is a 2,430-line file.** Missing one site ships an armable
  template. Mitigated by deriving one boolean and testing the absence of every
  verb, rather than gating each site by hand.
- **Two classes of row** in the Templates list is a real UI cost, accepted in
  exchange for never writing to the user's storage.
- **`instantiate` gains a parameter** and is #63's code. Backward-compatible by
  construction, but it is the one place this change reaches into a file that
  shipped in another PR.
