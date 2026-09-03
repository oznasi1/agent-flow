# Workflows and Templates: Navigation, Authoring, and Starters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a card's workflow reachable and authorable — two header buttons in place of "Orchestrator", a card-centric Active list, directly editable templates, and three built-in starters so the first run is never an empty picker.

**Architecture:** Three built-in `FlowTemplate`s ship inside the extension and are concatenated onto the disk-read list in `postFlows`; they are never written to `~/.agentflow/templates/`. `instantiate` widens with an injected context so a starter can leave `repos` and `mode` unset and have them resolved from the card being attached. The drawer's `openId` widens from a bare flow id to a target that can name a flow *or* a template, letting the existing canvas edit `template.flow` in a mode where every workflow verb is gated off.

**Tech Stack:** TypeScript, React (webview IIFE bundles), esbuild, Vitest (+ jsdom for webview specs), Playwright CT and real-host e2e.

**Spec:** `docs/superpowers/specs/2026-09-02-workflows-templates-navigation-design.md` — read it first; this plan argues from it.

## Global Constraints

These apply to **every** task. They are the repo's rules, not this feature's, and a task is not done until they hold.

- **Work in the worktree.** All work happens in `/Users/oznasi/dev/agent-flow/.worktrees/workflows-nav` on branch `feat/workflows-nav`. Use **absolute paths in every shell command** — parallel sessions share the root checkout and will switch its branch under you.
- **Git identity is `oznasi1 <oznasi1@gmail.com>`.** The global config is a work email that must not land in this public repo. Commit with `git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit …` unless the worktree already has it set locally.
- **The CI gate is exactly four commands, and all four must pass:** `npm ci`, `npm run typecheck`, `npm test`, `npm run build`. `npm run build` is a real gate, not a formality.
- **`npm test` is ~6,400 tests in ~50s.** Always pass `timeout: 600000` when running it through a tool — under CPU contention it exceeds the 120s default and auto-backgrounds.
- **Never pipe vitest through `tail` or `head`.** It discards the failure list you need. Redirect to a file and grep it instead.
- **Prefer a name filter over a whole big file.** `npx vitest run test/unit/deckView.test.ts -t "attaches"` runs in about a second where the whole file can take minutes under contention.
- **Read the real exit code.** `cmd > log 2>&1; echo "EXIT=$?"` — a `${PIPESTATUS}` trick reports the wrong command's status in this shell, and npm can be SIGTERMed and still look green.
- **Coverage thresholds are enforced** by `npm run test:cov`: 90% lines/statements, 85% branches/functions.
- **The webview cannot reach Node.** Nothing reachable from `src/webview/*` may import `fs`, `os`, `path` or `child_process`, even transitively and even if never called — esbuild resolves statically and `npm run build` fails. `src/engine/orchestrator/starters.ts` must be **data only**. `test/webview/webviewGraph.test.ts` is the near-gate but follows *relative* imports only, so only `npm run build` catches a bare specifier that pulls in `fs`.
- **Never break existing users.** `test/unit/compat.test.ts` must pass **unmodified**. If you find yourself editing a test to make it green, stop — that is the signal, not the fix.
- **No hardcoded organization values.** No Jira site, project key, repo name, or label in source. Everything through `getConfig()`. Test fixtures use `PROJ-`-style neutral keys, never a real employer's project prefix.
- **The vocabulary gate is repo-wide and fires on word boundaries.** `test/unit/vocabulary.test.ts` treats "agent" as a standalone word — the hyphen in a github.com/…/agent-flow URL makes it one, so a settings description carrying that link fails CI. A *session* is one run of a coding tool; an *agent* is a worker a session delegates to. Identifiers, setting ids, stored values and condition keys keep their released spelling.
- **Mutation-check every test you write.** After a test passes, break the implementation it covers (invert a comparison, return a constant, delete a line) and confirm *that specific test* fails. A test that stays green is vacuous — rewrite it. Only mutation-check **committed** work: the `git checkout` that restores the mutant also reverts any uncommitted fix.
- **Docs are tested.** `test/unit/docs.test.ts` asserts every registered connector and forge is documented.

---
## File Structure

| File | Responsibility |
| --- | --- |
| `src/engine/orchestrator/starters.ts` | **Create.** Data only: `STARTERS: FlowTemplate[]` and `isBuiltinTemplateId`. Leaf-pure — no imports beyond types. |
| `src/engine/orchestrator/templates.ts` | **Modify.** `instantiate` gains an injected `InstantiateCtx` and resolves `repos` / `mode`. |
| `src/engine/orchestrator/store.ts` | **Modify.** `readTemplates` skips on-disk `builtin-*.json`. |
| `src/deckView.ts` | **Modify.** `postFlows` concatenates starters; the four template write handlers refuse built-in ids; `flow:attach` passes the new context. |
| `src/types.ts` | **Modify.** New/changed webview message types. |
| `src/webview/WorkflowList.tsx` | **Create.** Pure presentational Active list over `CardWorkflow[]`. |
| `src/webview/DeckApp.tsx` | **Modify.** Two header buttons, `OrchTarget` state, one hoisted card-workflow map, draft-template state. |
| `src/webview/OrchestratorDrawer.tsx` | **Modify.** Target addressing, three-view navigation, the template-authoring verb gate, built-in rows. |
| `docs/ORCHESTRATOR_COMMANDS.md` | **Modify.** Document the new commands and the authoring path. |
| `CHANGELOG.md` | **Modify.** One `## [Unreleased]` entry. |

Tasks 1–6 are host/engine and land first: they are independently testable and the webview tasks consume their types. Tasks 7–14 are webview. Task 15 is docs and the gate run.

---

### Task 1: `starters.ts` — three built-in templates

The starters must be *data*, importable by a browser bundle. Ids are prefixed `builtin-` so the host can recognise them without a registry, and the prefix satisfies the existing `/^[A-Za-z0-9_-]+$/` charset that both `VALID_FLOW_ID` and `VALID_TEMPLATE_ID` enforce.

`repos: []` and `mode: ""` are deliberate: a shipped starter cannot know either, and Task 2 resolves them from the card. `dest: "worktree"` is safe to bake — a concept, not an org value.

**Files:**
- Create: `src/engine/orchestrator/starters.ts`
- Test: `test/unit/engine/orchestrator/starters.test.ts`

**Interfaces:**
- Consumes: `FlowTemplate` from `./templates`, `FlowNode` / `FlowEdge` / `Flow` from `./model` (types only).
- Produces: `STARTERS: readonly FlowTemplate[]`, `isBuiltinTemplateId(id: string): boolean`, `BUILTIN_PREFIX: "builtin-"`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/orchestrator/starters.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BUILTIN_PREFIX, STARTERS, isBuiltinTemplateId } from "../../../../src/engine/orchestrator/starters";
import { canBindTicket, validTemplate } from "../../../../src/engine/orchestrator/templates";
import { isPlanned } from "../../../../src/engine/orchestrator/model";

describe("built-in starters", () => {
  it("ships exactly three", () => {
    expect(STARTERS).toHaveLength(3);
  });

  it("gives every starter a builtin- id, and they are unique", () => {
    for (const t of STARTERS) expect(t.id.startsWith(BUILTIN_PREFIX)).toBe(true);
    expect(new Set(STARTERS.map((t) => t.id)).size).toBe(STARTERS.length);
  });

  it("recognises its own ids and rejects a user id", () => {
    for (const t of STARTERS) expect(isBuiltinTemplateId(t.id)).toBe(true);
    // `newFlowId` mints `<base36 time>-<4 char salt>` — never this prefix.
    expect(isBuiltinTemplateId("m7x2k1p9-4f2a")).toBe(false);
  });

  it("is a template this build can read", () => {
    for (const t of STARTERS) expect(validTemplate(t)).not.toBeNull();
  });

  it("can bind a ticket, so no starter dead-ends at attach", () => {
    for (const t of STARTERS) expect(canBindTicket(t.flow)).toBe(true);
  });

  it("leaves repos and mode for the card to fill in", () => {
    for (const t of STARTERS) {
      for (const n of t.flow.nodes.filter(isPlanned)) {
        expect(n.repos).toEqual([]);
        expect(n.mode).toBe("");
      }
    }
  });

  it("names no organization value anywhere in its payload", () => {
    // The no-hardcoded-org-values invariant, asserted on the data rather than
    // trusted: a starter is the one template a user did not write, so a repo or
    // project key baked in here would reach every install.
    const json = JSON.stringify(STARTERS);
    expect(json).not.toMatch(/atlassian\.net|github\.com/i);
  });

  it("points every edge at a node the starter actually has", () => {
    for (const t of STARTERS) {
      const ids = new Set(t.flow.nodes.map((n) => n.id));
      for (const e of t.flow.edges) {
        expect(ids.has(e.from)).toBe(true);
        expect(ids.has(e.to)).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/oznasi/dev/agent-flow/.worktrees/workflows-nav
npx vitest run test/unit/engine/orchestrator/starters.test.ts
```

Expected: FAIL — `Cannot find module '.../starters'`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/orchestrator/starters.ts`:

```ts
import type { Flow, FlowEdge, FlowNode } from "./model";
import type { FlowTemplate } from "./templates";

/** Built-in templates are addressed by an id prefix rather than a flag on the
 * record, because the record shape is `FlowTemplate` — the same one a user's own
 * template has, read from disk by `readTemplates` and written by `writeTemplate`.
 * A prefix needs no schema change, survives the JSON round trip a template makes
 * when it is duplicated into a user template, and is checkable by the host
 * without holding the starter list.
 *
 * It is inside the `/^[A-Za-z0-9_-]+$/` charset both `VALID_FLOW_ID` and
 * `VALID_TEMPLATE_ID` enforce, so a built-in id is a legal filename — which is
 * exactly why `readTemplates` must SKIP files carrying it (Task 4): the id being
 * writable is what makes a shadowing file possible. */
export const BUILTIN_PREFIX = "builtin-";

export function isBuiltinTemplateId(id: string): boolean {
  return id.startsWith(BUILTIN_PREFIX);
}

/** `repos` and `mode` are empty ON PURPOSE, and `instantiate` fills them from the
 * card being attached (see its own `InstantiateCtx`). A starter cannot know a
 * user's checkout names or their configured prompt-mode ids — both are
 * `agentFlow.*` settings — and baking either in would break the
 * no-hardcoded-organization-values invariant for every install at once.
 *
 * `dest` IS baked: "worktree" is a concept this extension owns, not a value read
 * from anyone's configuration. */
const planned = (id: string, x: number, y: number): FlowNode => ({
  id, x, y, join: "any", kind: "planned", ticketKey: "", repos: [], mode: "", dest: "worktree",
});

/** `run` (free text), never `commandId`. A `CommandNode` carries one or the
 * other and the model refuses a node with neither; `commandId` names an entry in
 * `agentFlow.commands`, which is empty for most users since no built-ins ship, so
 * a starter naming one would render as a broken step on a fresh install.
 *
 * `cwdRepo` is left absent deliberately — the model's own comment says absent
 * means "the repo of the place the incoming edge came from", which is exactly
 * what a starter wants and the only answer it could give without knowing the
 * user's checkouts. */
const command = (id: string, x: number, y: number, run: string): FlowNode => ({
  id, x, y, join: "any", kind: "command", run,
});

const gate = (id: string, x: number, y: number, question: string): FlowNode => ({
  id, x, y, join: "any", kind: "gate", question,
});

const notify = (id: string, x: number, y: number, message: string): FlowNode => ({
  id, x, y, join: "any", kind: "notify", message,
});

const edge = (id: string, from: string, to: string, cond: FlowEdge["cond"]): FlowEdge =>
  ({ id, from, to, cond });

const flow = (name: string, nodes: FlowNode[], edges: FlowEdge[]): Flow =>
  ({ id: "builtin", name, armed: false, createdAt: 0, nodes, edges });

const starter = (id: string, name: string, f: Flow): FlowTemplate =>
  ({ schema: 1, id: `${BUILTIN_PREFIX}${id}`, name, params: {}, savedAt: 0, flow: f });

/** Three shapes, chosen to be the three things a first-time user most plausibly
 * wants and to between them exercise every node kind a template can hold. They
 * are deliberately short: a starter is read before it is trusted, and a
 * fifteen-rule graph is not read. */
export const STARTERS: readonly FlowTemplate[] = [
  starter("ship-it", "Ship it", flow("Ship it",
    [planned("n1", 0, 0), command("n2", 200, 0, "npm test"), gate("n3", 400, 0, "Open a PR?")],
    [
      edge("e1", "n1", "n2", { kind: "agent-ended-turn" }),
      edge("e2", "n2", "n3", { kind: "command-succeeded" }),
    ])),
  starter("test-and-merge", "Test & merge", flow("Test & merge",
    [planned("n1", 0, 0), command("n2", 200, 0, "npm test"), notify("n3", 400, 0, "Green — ready to merge")],
    [
      edge("e1", "n1", "n2", { kind: "agent-ended-turn" }),
      edge("e2", "n2", "n3", { kind: "command-succeeded" }),
    ])),
  starter("review-only", "Review only", flow("Review only",
    [planned("n1", 0, 0), notify("n2", 200, 0, "Ready for review")],
    [edge("e1", "n1", "n2", { kind: "agent-ended-turn" })])),
];
```

Both non-obvious shapes above are verified against `model.ts`, not guessed: `command-succeeded` is a real bare `CondKind` (`model.ts:95`) — note it is *succeeded*, not *passed* — and `CommandNode` carries `commandId?` / `run?` / `cwdRepo?` (`model.ts:50`), with **no** `command` or `confirmed` field. `agent-ended-turn` is likewise a real `CondKind` (`model.ts:82`). Do not invent a kind or a field: condition kinds are serialized into flow files and shared across windows, so a wrong one is a template that never advances.

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/unit/engine/orchestrator/starters.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Mutation-check**

Change one starter's `repos: []` to `repos: ["x"]` and confirm the "leaves repos and mode" test fails. Change a `builtin-` id to a bare one and confirm two tests fail. Revert both.

- [ ] **Step 6: Verify the webview can import it**

```bash
npx vitest run test/webview/webviewGraph.test.ts
npm run build > /tmp/b.log 2>&1; echo "EXIT=$?"; tail -4 /tmp/b.log
```

Expected: both pass. If the build fails, `starters.ts` picked up a non-type import — it must be data only.

- [ ] **Step 7: Commit**

```bash
cd /Users/oznasi/dev/agent-flow/.worktrees/workflows-nav
git add src/engine/orchestrator/starters.ts test/unit/engine/orchestrator/starters.test.ts
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "feat(orchestrator): three built-in starter templates

repos and mode are left empty for the card to fill in: a shipped starter
cannot know a user's checkout names or prompt-mode ids, and baking either
in would break the no-hardcoded-organization-values invariant."
```

---
### Task 2: `instantiate` resolves `repos` and `mode` from the card

`instantiate` today substitutes **only** `ticketKey`:

```js
const bound: FlowNode = isPlanned(n) ? { ...n, id, ticketKey } : { ...n, id };
```

`repos` and `mode` ride through from the template verbatim. That is why a starter cannot exist yet, and it is also a latent wrinkle in the shipped code: a template saved against repo A and attached to a card in repo B carries repo A's repos.

The widening is **backward-compatible by construction** — a non-empty `repos`, or a `mode` the user actually has configured, still wins. Every template saved under #63 instantiates identically.

**Files:**
- Modify: `src/engine/orchestrator/templates.ts` (`instantiate`)
- Modify: `src/deckView.ts` (the one call site, in `case "flow:attach"`)
- Test: `test/unit/engine/orchestrator/templates.test.ts` (extend)

**Interfaces:**
- Produces: `export interface InstantiateCtx { repos: string[]; modes: string[] }` and `instantiate(t: FlowTemplate, ticketKey: string, flowId: string, nowMs: number, ctx: InstantiateCtx): Flow`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/orchestrator/templates.test.ts`. Note the existing local `planned()` helper in that file already sets `repos: ["ingest-worker"]` and `mode: "plan"`, so these tests build their own bare nodes rather than reusing it:

```ts
describe("instantiate resolving repos and mode", () => {
  const bare = (id: string): FlowNode => ({
    id, x: 0, y: 0, join: "any", kind: "planned", ticketKey: "", repos: [], mode: "", dest: "worktree",
  });
  const bareTemplate = (): FlowTemplate => template({
    flow: {
      id: "unused", name: "Starter", armed: false, createdAt: 0,
      nodes: [bare("n1"), notify("n2")], edges: [edge("e1", "n1", "n2")],
    },
  });
  const ctx = { repos: ["portal", "worker"], modes: ["plan", "build"] };

  it("fills an empty repos list from the card", () => {
    const f = instantiate(bareTemplate(), "PROJ-1", "f1", 1, ctx);
    const n = f.nodes.find((x) => x.kind === "planned")!;
    expect((n as { repos: string[] }).repos).toEqual(["portal", "worker"]);
  });

  it("fills an empty mode from the first configured prompt mode", () => {
    const f = instantiate(bareTemplate(), "PROJ-1", "f1", 1, ctx);
    const n = f.nodes.find((x) => x.kind === "planned")!;
    expect((n as { mode: string }).mode).toBe("plan");
  });

  it("leaves a populated repos list alone, so a saved template is unchanged", () => {
    // The backward-compatibility guarantee: every template saved before this
    // change must instantiate exactly as it did.
    const t = template(); // its planned nodes carry repos ["ingest-worker"], mode "plan"
    const f = instantiate(t, "PROJ-1", "f1", 1, { repos: ["other"], modes: ["build"] });
    for (const n of f.nodes.filter((x) => x.kind === "planned")) {
      expect((n as { repos: string[] }).repos).toEqual(["ingest-worker"]);
    }
  });

  it("leaves a mode the user has configured alone", () => {
    const t = template(); // mode "plan"
    const f = instantiate(t, "PROJ-1", "f1", 1, { repos: ["x"], modes: ["plan", "build"] });
    const n = f.nodes.find((x) => x.kind === "planned")!;
    expect((n as { mode: string }).mode).toBe("plan");
  });

  it("replaces a mode the user no longer has configured", () => {
    // A template saved against a prompt mode since deleted from settings would
    // otherwise launch with an id nothing resolves.
    const t = template(); // mode "plan"
    const f = instantiate(t, "PROJ-1", "f1", 1, { repos: ["x"], modes: ["build"] });
    const n = f.nodes.find((x) => x.kind === "planned")!;
    expect((n as { mode: string }).mode).toBe("build");
  });

  it("refuses rather than guessing when no prompt mode is configured at all", () => {
    expect(() => instantiate(bareTemplate(), "PROJ-1", "f1", 1, { repos: ["x"], modes: [] }))
      .toThrow(/prompt mode/i);
  });

  it("refuses rather than guessing when the card has no repos", () => {
    expect(() => instantiate(bareTemplate(), "PROJ-1", "f1", 1, { repos: [], modes: ["plan"] }))
      .toThrow(/repo/i);
  });

  it("still refuses a template with no planned step", () => {
    // The pre-existing guard, re-asserted: the new parameter must not have
    // moved the order of the checks.
    const t = template({
      flow: { id: "u", name: "n", armed: false, createdAt: 0, nodes: [notify("n1")], edges: [] },
    });
    expect(() => instantiate(t, "PROJ-1", "f1", 1, ctx)).toThrow(/no planned step/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/oznasi/dev/agent-flow/.worktrees/workflows-nav
npx vitest run test/unit/engine/orchestrator/templates.test.ts -t "instantiate resolving"
```

Expected: FAIL — `instantiate` takes 4 arguments, and TypeScript will also complain at the call.

- [ ] **Step 3: Write the implementation**

In `src/engine/orchestrator/templates.ts`, add the context type above `instantiate` and widen it:

```ts
/** What `instantiate` cannot read off the template, and must be told.
 *
 * `PlannedNode` carries `repos` and `mode` — a `run.repos[].name` list and a
 * `PromptMode` id — and both are `agentFlow.*` settings. A template saved by a
 * user has them because the save dialog asked; a BUILT-IN starter cannot have
 * them at all, because it ships before the user's configuration exists and
 * baking either in would break the no-hardcoded-organization-values invariant.
 *
 * So they arrive here, from the card being attached to and the config the host
 * already holds. Injected rather than imported for the same reason the flow id
 * and clock are: the whole substitution stays table-testable from fixtures, with
 * no filesystem, no panel and no `getConfig()`. */
export interface InstantiateCtx {
  /** `run.repos[].name` for the card being attached to. */
  repos: string[];
  /** Configured prompt-mode ids, in the user's own order. The first is the
   * fallback for a node whose mode is empty or no longer configured. */
  modes: string[];
}

export function instantiate(
  t: FlowTemplate, ticketKey: string, flowId: string, nowMs: number, ctx: InstantiateCtx,
): Flow {
  if (!t.flow.nodes.some(isPlanned)) {
    throw new Error(`template ${JSON.stringify(t.name)} has no planned step: nothing to bind ${ticketKey} to`);
  }
  // ... existing `out` construction unchanged ...

  const remap = new Map<string, string>();
  for (const n of t.flow.nodes) {
    const id = nextNodeId(out);
    remap.set(n.id, id);
    const bound: FlowNode = isPlanned(n) ? { ...n, id, ticketKey, ...boundLaunch(n, ctx) } : { ...n, id };
    out.nodes.push(bound);
  }
  // ... existing edge loop and return unchanged ...
}

/** `repos` and `mode` for one planned node: the template's own values when it has
 * usable ones, the card's and the config's otherwise.
 *
 * Refuses rather than guessing. An empty `repos` with nothing to fall back on
 * means a launch with no checkout; a mode nothing resolves means a launch with no
 * prompt. `DemotionChoice`'s own comment gives the reason this is a throw and not
 * a default: a guessed destination is a session launched into the window you are
 * working in, months later, on someone else's ticket. */
function boundLaunch(n: PlannedNode, ctx: InstantiateCtx): { repos: string[]; mode: string } {
  const repos = n.repos.length > 0 ? n.repos : ctx.repos;
  if (repos.length === 0) {
    throw new Error("this card has no repo to launch in, and the template names none");
  }
  const mode = ctx.modes.includes(n.mode) ? n.mode : ctx.modes[0];
  if (mode === undefined) {
    throw new Error("no prompt mode is configured: set agentFlow.promptModes before attaching a workflow");
  }
  return { repos, mode };
}
```

Import `PlannedNode` as a type if it is not already imported in that file.

- [ ] **Step 4: Update the single call site**

In `src/deckView.ts`, `case "flow:attach"` — the call is currently `instantiate(t, ticketKey, id, now)`. The handler already has `run` in scope from `this.run(m.runKey)`:

```ts
fresh = instantiate(t, ticketKey, id, now, {
  // `run.repos[].name` is the same identifier `PlannedNode.repos` holds — a
  // CHECKOUT name, not a GitHub owner/name. A card the panel has no record of
  // contributes no repos, and `instantiate` refuses rather than launching
  // nowhere.
  repos: run ? run.repos.map((r) => r.name) : [],
  modes: getConfig().promptModes.map((m) => m.id),
});
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run test/unit/engine/orchestrator/templates.test.ts
npm run typecheck
```

Expected: the whole templates file passes (the pre-existing tests included) and typecheck is clean.

- [ ] **Step 6: Mutation-check**

Invert `n.repos.length > 0` to `< 0` and confirm "leaves a populated repos list alone" fails. Change `ctx.modes.includes(n.mode)` to `true` and confirm "replaces a mode the user no longer has configured" fails. Revert both.

- [ ] **Step 7: Commit**

```bash
git add src/engine/orchestrator/templates.ts src/deckView.ts test/unit/engine/orchestrator/templates.test.ts
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "fix(orchestrator): bind a planned node's repos and mode at attach

instantiate substituted only ticketKey, so repos and mode rode through
from the template verbatim -- which is why a built-in starter could not
exist, and why a template saved against one repo carried it onto a card
in another. Backward-compatible: a populated repos list or a configured
mode still wins."
```

---

### Task 3: Every starter actually instantiates

Tasks 1 and 2 are each correct alone and still leave the user's first attach broken if the starters do not survive the real substitution. This task is the seam test, and it is the one that would have caught the `command-passed` / `command-succeeded` slip.

**Files:**
- Test: `test/unit/engine/orchestrator/starters.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
import { instantiate } from "../../../../src/engine/orchestrator/templates";
import { isPlanned } from "../../../../src/engine/orchestrator/model";

describe("every starter survives a real attach", () => {
  const ctx = { repos: ["portal"], modes: ["plan", "build"] };

  it("instantiates each starter against a card", () => {
    for (const t of STARTERS) {
      const f = instantiate(t, "PROJ-42", "f1", 1756200000000, ctx);
      expect(f.nodes).toHaveLength(t.flow.nodes.length);
      expect(f.edges).toHaveLength(t.flow.edges.length);
      expect(f.fromTemplate).toBe(t.id);
      expect(f.armed).toBe(false);
    }
  });

  it("binds the ticket, repos and mode on every planned node", () => {
    for (const t of STARTERS) {
      const f = instantiate(t, "PROJ-42", "f1", 1, ctx);
      const planned = f.nodes.filter(isPlanned);
      expect(planned.length).toBeGreaterThan(0);
      for (const n of planned) {
        expect(n.ticketKey).toBe("PROJ-42");
        expect(n.repos).toEqual(["portal"]);
        expect(n.mode).toBe("plan");
      }
    }
  });

  it("carries no consent stamp into the instance", () => {
    // The rule #63 established: consent never travels with a template, or one
    // approved click becomes twenty machines running a command unattended.
    for (const t of STARTERS) {
      const f = instantiate(t, "PROJ-42", "f1", 1, ctx);
      for (const e of f.edges) {
        expect(e).not.toHaveProperty("launchConfirmedAt");
        expect(e).not.toHaveProperty("commandConfirmedAt");
      }
    }
  });
});
```

- [ ] **Step 2: Run it**

```bash
npx vitest run test/unit/engine/orchestrator/starters.test.ts
```

Expected: PASS. If a starter throws, its graph is wrong — fix `starters.ts`, not the test.

- [ ] **Step 3: Commit**

```bash
git add test/unit/engine/orchestrator/starters.test.ts
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "test(orchestrator): pin that every starter survives a real attach"
```

---

### Task 4: `readTemplates` skips on-disk `builtin-*.json`

A built-in id is a legal filename, which is exactly what makes shadowing possible: drop a `builtin-ship-it.json` into `~/.agentflow/templates/` and the list would carry two templates with that id — the same class of bug #63 already fixed for a copied `k1-backup.json`.

**Files:**
- Modify: `src/engine/orchestrator/store.ts` (`readTemplates`)
- Test: `test/unit/engine/orchestrator/store.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Use that file's existing in-memory `fakeIo`:

```ts
it("skips a file claiming a built-in id, so a copy cannot shadow a starter", () => {
  // `fakeIo` returns `{ io, files }`, not a bare io -- verified against
  // store.test.ts:12. Destructure it.
  const { io } = fakeIo({
    "/t/builtin-ship-it.json": JSON.stringify({
      schema: 1, id: "builtin-ship-it", name: "Not the real one", params: {}, savedAt: 1,
      flow: { id: "u", name: "n", armed: false, createdAt: 0, nodes: [], edges: [] },
    }),
    "/t/m7x2k1p9-4f2a.json": JSON.stringify({
      schema: 1, id: "m7x2k1p9-4f2a", name: "Mine", params: {}, savedAt: 1,
      flow: { id: "u", name: "n", armed: false, createdAt: 0, nodes: [], edges: [] },
    }),
  });
  const out = readTemplates(io, "/t");
  expect(out.map((t) => t.id)).toEqual(["m7x2k1p9-4f2a"]);
});
```

Match `fakeIo`'s real constructor signature in that file — read it first rather than assuming the shape above.

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run test/unit/engine/orchestrator/store.test.ts -t "shadow"
```

Expected: FAIL — two templates returned.

- [ ] **Step 3: Implement**

In `readTemplates`, beside the existing filename-must-match-id check:

```ts
// A built-in ships in `starters.ts` and is never written here, so a file
// claiming one of those ids is a copy, a backup, or a hand-edit — and honouring
// it would put two templates with the same id in the picker, one of which the
// user can never delete. Same failure the filename check above exists to stop.
if (isBuiltinTemplateId(t.id)) continue;
```

Import `isBuiltinTemplateId` from `./starters`. This is safe for the webview graph: `store.ts` is host-only and already imports `path`.

- [ ] **Step 4: Run it to verify it passes**

```bash
npx vitest run test/unit/engine/orchestrator/store.test.ts
```

- [ ] **Step 5: Mutation-check, then commit**

Delete the `continue` and confirm the test fails. Then:

```bash
git add src/engine/orchestrator/store.ts test/unit/engine/orchestrator/store.test.ts
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "fix(orchestrator): ignore a templates file claiming a built-in id"
```

---

### Task 5: `postFlows` serves the starters

**Files:**
- Modify: `src/deckView.ts` (`postFlows`, around line 705)
- Test: `test/unit/deckView.test.ts` (extend)

**Two traps in that test file** — read `deckView.test.ts`'s `getConfig` mock before writing anything. It silently drops new `AgentFlowConfig` fields, and calling the real config builder per field once made the whole suite thirteen times slower. Do not call a real builder in a hot path.

- [ ] **Step 1: Write the failing test**

```ts
it("serves the built-in starters alongside the user's own templates", async () => {
  // orchestrator on, templates dir empty
  const posted = await renderAndCapture({ orchestrator: true });
  const flows = posted.find((m) => m.type === "deck:flows")!;
  expect(flows.templates.map((t: { id: string }) => t.id))
    .toEqual(expect.arrayContaining(["builtin-ship-it", "builtin-test-and-merge", "builtin-review-only"]));
});

it("serves no templates at all when the orchestrator setting is off", async () => {
  // Starters follow `flows` and `pendingResume`: with the setting off there is
  // nothing to attach, and silence must not read as "not loaded yet".
  const posted = await renderAndCapture({ orchestrator: false });
  const flows = posted.find((m) => m.type === "deck:flows")!;
  expect(flows.templates).toEqual([]);
});
```

Replace `renderAndCapture` with whatever harness that file already uses to drive a `postFlows` and read the posted messages — do not invent a new one. Write the second test properly against that harness; the sketch above is the assertion, not the plumbing.

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run test/unit/deckView.test.ts -t "starters"
```

- [ ] **Step 3: Implement**

```ts
// Starters are prepended, not appended: they are the shapes a first-time user
// reads before they have any of their own, and a list that puts three built-ins
// after twenty user templates has hidden them again. Gated on `enabled` with
// `flows` and `pendingResume` for the reason those two are — with the setting
// off there is nothing to attach.
const templates: FlowTemplate[] = enabled
  ? [...STARTERS, ...readTemplates(this.flowIo, this.templatesDir)]
  : [];
```

- [ ] **Step 4: Run, mutation-check, commit**

Flip `enabled ?` to `true ?` and confirm the setting-off test fails.

```bash
git add src/deckView.ts test/unit/deckView.test.ts
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "feat(orchestrator): serve the built-in starters over deck:flows"
```

---

### Task 6: the host refuses to write a built-in

The UI will disable these buttons (Task 14), but a stale webview open from before this shipped can still send the message — the same reasoning `canBindTicket`'s own comment gives for checking on both ends.

**Files:**
- Modify: `src/deckView.ts` (`flow:renameTemplate`, `flow:deleteTemplate`, `flow:saveTemplate`, `flow:duplicateTemplate`)
- Test: `test/unit/deckView.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Against the same harness the existing template-handler tests in that file use:

```ts
it("refuses to rename a built-in starter", () => {
  // assert: no writeTemplate call, and an error toast is posted
});
it("refuses to delete a built-in starter", () => {
  // assert: no remove call, error toast
});
it("refuses to overwrite a built-in starter", () => {
  // flow:saveTemplate carrying a builtin- id
});
it("duplicates a built-in into an ordinary user template", () => {
  // assert: writeTemplate called once, with an id that is NOT builtin-prefixed
  // and a name marking it a copy
});
```

Fill these in against the real harness — find the existing `flow:deleteTemplate` test in that file and mirror its shape exactly.

- [ ] **Step 2: Run to verify failure**, then implement.

In each of the three write handlers, immediately after the `getConfig().orchestrator` guard:

```ts
if (isBuiltinTemplateId(m.templateId)) {
  this.post({
    type: "toast", level: "error",
    message: "That is a built-in template. Duplicate it to make a version you can change.",
  });
  return;
}
```

`flow:duplicateTemplate` must **not** get this guard — duplicating a built-in is the supported path to owning one. Its existing id minting already produces an ordinary id, so verify (do not assume) that its copy is written with a fresh `newFlowId` and not the source id.

- [ ] **Step 3: Run, mutation-check, commit**

Delete one guard and confirm exactly one test fails.

```bash
git add src/deckView.ts test/unit/deckView.test.ts
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "fix(orchestrator): refuse a write that targets a built-in template"
```

---
### Task 7: `WorkflowList.tsx` — the Active list

A new **pure presentational** component. It takes rows already derived and renders them; it calls no engine function itself, which is what keeps it testable without a board and keeps `DeckApp` the single place the derivation happens.

**Files:**
- Create: `src/webview/WorkflowList.tsx`
- Test: `test/webview/workflowList.test.tsx`

**Interfaces:**
- Consumes: `CardWorkflow` (`src/engine/orchestrator/attach.ts`), `WorkflowStatus` from the same module.
- Produces:

```ts
export interface WorkflowRow {
  /** The card's own id, as `DeckApp` keys cards — what `onOpen` hands back. */
  cardId: string;
  /** The ticket key as the board shows it, already resolved by the caller. */
  ticketKey: string;
  title: string;
  workflow: CardWorkflow;
}
export interface WorkflowListProps {
  rows: WorkflowRow[];
  onOpen: (cardId: string) => void;
}
export function WorkflowList(p: WorkflowListProps): JSX.Element;
```

Rows arrive **already sorted** by the caller. This component does not sort: ordering is a board concern that depends on `workflowState`, and a component that both sorts and renders cannot be tested for either alone.

- [ ] **Step 1: Write the failing test**

Create `test/webview/workflowList.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkflowList, type WorkflowRow } from "../../src/webview/WorkflowList";
import type { Flow, FlowNode } from "../../src/engine/orchestrator/model";
import type { CardWorkflow, WorkflowStatus } from "../../src/engine/orchestrator/attach";

const notify = (id: string): FlowNode => ({ id, x: 0, y: 0, join: "any", kind: "notify", message: "" });

const wf = (name: string, status: WorkflowStatus, done = 1, total = 2): CardWorkflow => ({
  flow: { id: `f-${name}`, name, armed: true, createdAt: 0, nodes: [notify("n1")], edges: [] } as Flow,
  state: { status, done, total, steps: [] },
  extraCount: 0,
});

const row = (cardId: string, ticketKey: string, title: string, w: CardWorkflow): WorkflowRow =>
  ({ cardId, ticketKey, title, workflow: w });

describe("WorkflowList", () => {
  it("renders one row per card, in the order given", () => {
    render(<WorkflowList onOpen={() => {}} rows={[
      row("c1", "PROJ-1", "First thing", wf("Ship it", "waiting-on-you")),
      row("c2", "PROJ-2", "Second thing", wf("Test & merge", "stopped")),
    ]} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("PROJ-1");
    expect(items[1]).toHaveTextContent("PROJ-2");
  });

  it("names the workflow each card carries", () => {
    render(<WorkflowList onOpen={() => {}} rows={[
      row("c1", "PROJ-1", "First thing", wf("Ship it", "advancing")),
    ]} />);
    expect(screen.getByText("Ship it")).toBeTruthy();
  });

  it("says how far along a workflow is", () => {
    render(<WorkflowList onOpen={() => {}} rows={[
      row("c1", "PROJ-1", "x", wf("Ship it", "advancing", 2, 5)),
    ]} />);
    expect(screen.getByText(/2 of 5/)).toBeTruthy();
  });

  it("marks a status on each row for the stylesheet to hue", () => {
    // The hue itself is a token and is asserted as COMPUTED COLOUR in a
    // Playwright CT spec (Task 15) -- a class assertion here would stay green
    // with the token pointing at the wrong hue. This only pins that the status
    // reaches the DOM at all.
    render(<WorkflowList onOpen={() => {}} rows={[
      row("c1", "PROJ-1", "x", wf("Ship it", "stopped")),
    ]} />);
    expect(screen.getByRole("listitem").getAttribute("data-status")).toBe("stopped");
  });

  it("opens the card the row belongs to", async () => {
    const onOpen = vi.fn();
    render(<WorkflowList onOpen={onOpen} rows={[
      row("c7", "PROJ-9", "x", wf("Ship it", "done")),
    ]} />);
    await userEvent.click(screen.getByRole("button", { name: /PROJ-9/ }));
    expect(onOpen).toHaveBeenCalledWith("c7");
  });

  it("says so when nothing is attached anywhere", () => {
    render(<WorkflowList onOpen={() => {}} rows={[]} />);
    expect(screen.getByText(/no workflows attached/i)).toBeTruthy();
  });

  it("does not sort -- the caller owns order", () => {
    // Pinning the contract, not the behaviour: a future edit that adds a sort
    // here would make the board and this list disagree about precedence.
    render(<WorkflowList onOpen={() => {}} rows={[
      row("c1", "PROJ-1", "x", wf("A", "done")),
      row("c2", "PROJ-2", "x", wf("B", "stopped")),
    ]} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("PROJ-1");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/oznasi/dev/agent-flow/.worktrees/workflows-nav
npx vitest run test/webview/workflowList.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `src/webview/WorkflowList.tsx`. Use `<ul role="list">` / `<li>` with a `<button>` inside each row whose accessible name includes the ticket key, and `data-status={w.state.status}` on the `<li>`. Read the existing `WorkflowBlock.tsx` for the house idiom on how a step's words are composed — reuse its helpers rather than writing new wording, since the engine's own receipt text must not be paraphrased twice.

Styles go in `deckStyles.ts`, not inline. **`--brand` is an allowlist, not a colour:** `test/webview/tokens.test.ts` asserts set equality per stylesheet, so a new brand rule fails until registered — use `--c-done` / `--c-attn` / `--c-danger` for states rather than inventing a token.

- [ ] **Step 4: Run to verify it passes**, then mutation-check

Delete the `data-status` attribute and confirm exactly one test fails. Reverse the render order and confirm the ordering tests fail.

- [ ] **Step 5: Commit**

```bash
git add src/webview/WorkflowList.tsx src/webview/deckStyles.ts test/webview/workflowList.test.tsx
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "feat(deck): a list of every card carrying a workflow"
```

---

### Task 8: `OrchTarget` — the drawer can be opened on a template

**Files:**
- Modify: `src/webview/OrchestratorDrawer.tsx` (`OrchestratorDrawerProps.openId`, the `openFlow` resolution at line ~392, `useDrawerExit`)
- Modify: `src/webview/DeckApp.tsx` (the `openFlowId` state and its seven call sites: lines ~552, 729, 903, 940, 1189, 1198, 1200, 1234)
- Test: `test/webview/OrchestratorDrawer.test.tsx` (extend)

**Interfaces:**
- Produces:

```ts
export type OrchTarget =
  | { kind: "flow"; id: string }
  | { kind: "template"; id: string };
```

Declare it in `OrchestratorDrawer.tsx` and export it; `DeckApp` imports it. `openId: OrchTarget | null` replaces `openId: string | null`.

- [ ] **Step 1: Write the failing tests**

Mirror the existing tests in `OrchestratorDrawer.test.tsx` that pass `openId="f1"` — find them first and copy their harness exactly.

```tsx
it("opens on a flow when the target names one", () => {
  // openId={{ kind: "flow", id: "f1" }} -> the flow's canvas renders
});
it("opens on a template's own graph when the target names a template", () => {
  // openId={{ kind: "template", id: "builtin-ship-it" }} with that template in
  // `templates` -> the graph rendered is template.flow, and its name shows
});
it("renders nothing for a target naming a template that is not in the list", () => {
  // the same tolerance the flow path already has for a missing id
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

```ts
/** The flow the canvas is editing, whichever kind of thing the target names.
 *
 * A template's payload IS a `Flow` (`FlowTemplate.flow`), which is what makes
 * one editor enough for both: the canvas never learns there are two kinds of
 * target, and only the VERBS around it change (see `editingTemplate`, Task 12). */
const target = p.openId;
const openFlow = target === null
  ? undefined
  : target.kind === "flow"
    ? p.flows.find((f) => f.id === target.id)
    : p.templates.find((t) => t.id === target.id)?.flow;
```

`useDrawerExit` needs a stable string key, so pass `` target && `${target.kind}:${target.id}` `` where it currently receives `p.openId`. Read `Drawer.tsx`'s comment on why the hook needs both the id and the resolved value before changing the call.

- [ ] **Step 4: Run the drawer and DeckApp suites**

```bash
npx vitest run test/webview/OrchestratorDrawer.test.tsx test/webview/DeckApp.test.tsx
npm run typecheck
```

Typecheck is the real gate here — every `openFlowId` site must be updated, and `tsc` finds them all.

- [ ] **Step 5: Commit**

```bash
git add src/webview/OrchestratorDrawer.tsx src/webview/DeckApp.tsx test/webview/OrchestratorDrawer.test.tsx
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "refactor(deck): address the orchestrator drawer by target, not flow id"
```

---

### Task 9: three-view navigation replaces the `Flows · N ▾` disclosure

**Files:**
- Modify: `src/webview/OrchestratorDrawer.tsx` (the `picking` disclosure and `pickTab` state, ~lines 1418–1660)
- Modify: `src/webview/orchestratorStyles.ts`
- Test: `test/webview/OrchestratorDrawer.test.tsx` (extend)
- Modify: `test/unit/vocabulary.test.ts` (drop the allowlist entries for strings this deletes)

- [ ] **Step 1: Write the failing tests**

```tsx
it("offers Active, Templates and Canvas as top-level tabs", () => {
  // role="tablist" with exactly these three role="tab" children
});
it("opens on the view the target implies", () => {
  // a template target lands on Canvas (you are editing it), a flow target on Canvas,
  // and an explicit `view` prop of "active" lands on Active
});
it("no longer offers a Flows disclosure", () => {
  expect(screen.queryByText(/Flows ·/)).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

Add `view: "active" | "templates" | "canvas"` and `onView: (v: ...) => void` to the props — **controlled by `DeckApp`**, not local state, because the two header buttons (Task 11) set it from outside. Delete the `picking` disclosure and the `orch-mini` "Flows · N ▾" button; move the Running list under the Canvas view's flow switcher.

The strings `Flows · `, `+ New flow`, `Delete flow`, `Flow view` and the `Orchestrator` eyebrow are user-facing and go away here. `test/unit/vocabulary.test.ts` allowlists each of them by exact text with a `why`; **its checks are set-equality**, so a removed string whose allowlist entry stays fails the gate. Delete those entries in the same commit.

- [ ] **Step 4: Run the drawer suite and the vocabulary gate**

```bash
npx vitest run test/webview/OrchestratorDrawer.test.tsx test/unit/vocabulary.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/webview/OrchestratorDrawer.tsx src/webview/orchestratorStyles.ts test/webview/OrchestratorDrawer.test.tsx test/unit/vocabulary.test.ts
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "feat(orchestrator): Active, Templates and Canvas as top-level views"
```

---

### Task 10: one card-workflow map, feeding both the board and the list

`DeckApp` computes `chipWorkflow(c)` per card per board render today; its own comment describes the cost. Hoisting it to one memoized map both retires that multiplier and gives Task 11's list its rows from the same derivation the chips use — which is the property the spec is actually buying.

**Files:**
- Modify: `src/webview/DeckApp.tsx` (`chipWorkflow` at ~line 890, `card()` at ~895)
- Test: `test/webview/DeckApp.test.tsx` (extend)

- [ ] **Step 1: Write the failing test**

```tsx
it("shows the same workflow on a card's chip and in the Active list", () => {
  // one board, one card with a workflow attached; assert the chip's text and the
  // Active row's text name the same workflow and the same state. This is the
  // anti-drift test the whole design rests on -- if these can disagree, the
  // derivation was duplicated.
});
```

- [ ] **Step 2: Run to verify failure**, then implement:

```ts
// One pass per board render, not one per card per Card re-render. `now` and
// `branchCi` are the only inputs that move between renders; `runs` and `flows`
// arrive together on `deck:flows`.
const workflowByCard = React.useMemo(() => {
  const m = new Map<string, CardWorkflow>();
  if (!orchEnabled) return m;
  for (const c of cards) {
    const w = cardWorkflow(flows, c.status, runs, now, branchCi);
    if (w) m.set(c.id, w);
  }
  return m;
}, [orchEnabled, cards, flows, runs, now, branchCi]);
```

Then `card()` reads `workflowByCard.get(c.id)` and the Active rows are built from the same map, sorted with the same precedence `rankByState` uses.

- [ ] **Step 3: Run, mutation-check, commit**

Make the list read a second `cardWorkflow` call instead of the map and confirm the anti-drift test still passes — it will, which is the point: then change the list's `now` by an hour and confirm it fails. That is what proves the test has teeth.

```bash
git add src/webview/DeckApp.tsx test/webview/DeckApp.test.tsx
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "perf(deck): derive each card's workflow once per board render"
```

---

### Task 11: the header — two sibling buttons

**Files:**
- Modify: `src/webview/DeckApp.tsx` (~lines 933–948)
- Modify: `src/webview/deckStyles.ts`
- Test: `test/webview/DeckApp.test.tsx` (extend)

- [ ] **Step 1: Write the failing tests**

```tsx
it("offers Workflows and Templates as two header buttons", () => {
  // both present when orchEnabled
});
it("offers neither when the orchestrator setting is off", () => {
  // the existing gate, re-asserted
});
it("opens the Active view from Workflows and the Templates view from Templates", () => {});
it("says how many workflows need you", () => {
  // one waiting-on-you + one advancing -> "1 needs you"
});
it("falls back to the active count when nothing needs you", () => {
  // two advancing -> "2"
});
it("opens a view rather than minting a flow when there are none", () => {
  // THE dead-end fix: with flows: [] the click must NOT send flow:create
  const send = vi.fn();
  // ... click Workflows ...
  expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "flow:create" }));
});
```

That last test is the reason this task exists — pin it explicitly, not as a side effect.

- [ ] **Step 2: Run to verify failure**, then implement. Delete this branch entirely:

```ts
if (flows.length === 0) send({ type: "flow:create" });
else setOpenFlowId((cur) => (cur ? null : flows[0].id));
```

Each button now sets the target and the view. Both keep the `armed`/`attn` styling the current chip has; reuse the existing `ctl orch-chip` classes rather than inventing new ones.

- [ ] **Step 3: Verify in a real editor window**

The header is a flex row that already drops its token tile at narrow widths. Launch the dev host and drag the panel narrow:

```bash
/usr/local/bin/code -n --extensionDevelopmentPath=/Users/oznasi/dev/agent-flow/.worktrees/workflows-nav /Users/oznasi/dev/agent-flow/.worktrees/workflows-nav
```

Only VS Code's own CLI works — the Cursor CLI silently drops `--extensionDevelopmentPath`. Confirm neither button clips and the stats yield first. jsdom cannot see this.

- [ ] **Step 4: Commit**

```bash
git add src/webview/DeckApp.tsx src/webview/deckStyles.ts test/webview/DeckApp.test.tsx
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "feat(deck): Workflows and Templates as two header buttons

Replaces the single Orchestrator button. The zero-flow click used to mint
a blank flow instead of opening anything, which is why a first-time user
could not reach Templates at all."
```

---
### Task 12: the verb gate — a template cannot be armed

**This is the task most likely to ship a defect**, because `OrchestratorDrawer.tsx` is 2,430 lines and the gate has to hold at every one of them. The mitigation is to derive one boolean and test the **absence** of every verb, rather than gating each site by inspection.

**Files:**
- Modify: `src/webview/OrchestratorDrawer.tsx`
- Test: `test/webview/OrchestratorDrawer.test.tsx` (extend)

- [ ] **Step 1: Write the failing test — the whole point of the task**

```tsx
describe("template authoring mode", () => {
  // Enumerated rather than spot-checked: the risk is a verb nobody remembered,
  // so the test names every verb a WORKFLOW has and asserts each is absent when
  // the target is a template. A new workflow verb added later must be added
  // here too -- which is the reminder this list exists to be.
  const WORKFLOW_VERBS = [
    /^arm$/i, /^disarm$/i, /dry run/i, /^approve$/i, /^reject$/i,
    /^detach$/i, /attach workflow/i, /save as template/i,
  ];

  it("offers no workflow verb while editing a template", () => {
    // render with openId={{ kind: "template", id: "builtin-ship-it" }}
    for (const v of WORKFLOW_VERBS) {
      expect(screen.queryByRole("button", { name: v })).toBeNull();
    }
  });

  it("still offers those verbs on a flow, so the gate is not just hiding everything", () => {
    // render with openId={{ kind: "flow", id: "f1" }} on an attachable flow
    // and assert at least Arm and Dry run ARE present. Without this, a gate
    // that returns false for everything passes the test above.
  });

  it("shows no resume banner while editing a template", () => {
    // pendingResume naming the template's inner flow id must not surface
  });

  it("saves to the template store, not the flow store", () => {
    // clicking Save posts flow:saveTemplate with the template's id -- never
    // flow:save
  });
});
```

The second test is not optional. A gate implemented as "hide everything" passes the first test and breaks the product.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

```ts
/** Editing a template, not a workflow — so every WORKFLOW verb is off.
 *
 * The vocabulary rule this file already states, enforced instead of described:
 * a template has no ticket and nothing to watch, so it cannot be armed,
 * disarmed, detached, approved or dry-run. One boolean rather than a check at
 * each site, because the failure mode is a site nobody remembered. */
const editingTemplate = p.openId?.kind === "template";
```

Gate on it at: the Arm/Disarm control, the dry-run panel, the resume banner, the Save-as-template dialog, and any attach affordance. Save routes to `flow:saveTemplate` carrying the template id.

- [ ] **Step 4: Run, and grep for anything missed**

```bash
npx vitest run test/webview/OrchestratorDrawer.test.tsx
grep -n 'onArm\|onResumeApprove\|dryRun\|flow:save\b' src/webview/OrchestratorDrawer.tsx
```

Every hit must sit under `editingTemplate === false` or be unreachable in template mode. Read each one — this is the manual sweep the test cannot replace.

- [ ] **Step 5: Mutation-check**

Set `editingTemplate = false` unconditionally and confirm the first test fails. Set it `true` unconditionally and confirm the *second* test fails. Both directions must break something.

- [ ] **Step 6: Commit**

```bash
git add src/webview/OrchestratorDrawer.tsx test/webview/OrchestratorDrawer.test.tsx
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "feat(orchestrator): edit a template on the canvas, with no workflow verbs"
```

---

### Task 13: `＋ New template…` — a draft that never touches disk

A new template must exist somewhere while it is being drawn. It lives in `DeckApp` state, **not** in `~/.agentflow/templates/` and **not** as a flow — a draft flow on disk is global, shared across windows behind a lock, and an interrupted edit would leave another window looking at a workflow the user never made.

**Files:**
- Modify: `src/webview/DeckApp.tsx` (new `draftTemplate` state)
- Modify: `src/webview/OrchestratorDrawer.tsx` (resolve a target from `templates` **or** the draft; restore the `＋ New template…` button on the Templates view)
- Test: `test/webview/DeckApp.test.tsx`, `test/webview/OrchestratorDrawer.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
it("opens a blank template on the canvas without writing anything", () => {
  const send = vi.fn();
  // click "+ New template..." on the Templates view
  // assert: the canvas opens on a template target, and NOTHING was sent --
  // no flow:create, no flow:saveTemplate. This is the property that made the
  // draft-flow approach wrong.
  expect(send).not.toHaveBeenCalled();
});

it("starts the draft with one planned step so it can be saved", () => {
  // canBindTicket must pass on first save; a template of only command/gate/
  // notify nodes saves fine and then fails at EVERY future attach.
});

it("writes only on save", () => {
  // name it, click Save -> exactly one flow:saveTemplate
});

it("discards the draft on cancel, leaving the list unchanged", () => {});

it("does not offer the draft as something to attach", () => {
  // a card's attach picker must never list an unsaved draft
});
```

- [ ] **Step 2: Run to verify failure**, then implement.

The button the branch removed called `onCreate`, which mints a *workflow* — that is why it was deleted. The restored button must mint a draft **template**, which is a different verb. Keep the deleted button's reasoning comment nearby and update it, rather than silently re-adding what was removed.

- [ ] **Step 3: Run, mutation-check, commit**

Make the draft start with a `notify` node instead of a `planned` one and confirm the "one planned step" test fails.

```bash
git add src/webview/DeckApp.tsx src/webview/OrchestratorDrawer.tsx test/webview/DeckApp.test.tsx test/webview/OrchestratorDrawer.test.tsx
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "feat(orchestrator): author a new template, saved only when you save it"
```

---

### Task 14: built-in rows, and the attach picker's way out

**Files:**
- Modify: `src/webview/OrchestratorDrawer.tsx` (`TemplateRow` at ~line 218, and the empty state at ~line 1650)
- Modify: `src/webview/DeckDetail.tsx` (the attach picker's empty state, line ~140)
- Test: `test/webview/OrchestratorDrawer.test.tsx`, `test/webview/DeckDetail.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
it("marks a built-in row as built-in", () => {});
it("offers Duplicate on a built-in but not Rename or Delete", () => {
  // disabled or absent -- pick one and assert it; do not assert both
});
it("offers all three on a user template", () => {
  // the counterpart, so the gate is not hiding everything
});
it("still counts how many cards a built-in is on", () => {
  // TemplateRow's onCards prop works on a built-in unchanged
});
```

And in `DeckDetail.test.tsx`:

```tsx
it("offers a way to create one when no template matches", () => {
  // With starters shipped, the picker is empty only if the user deleted their
  // own and starters are somehow absent -- but the exit must exist regardless,
  // because "No templates saved yet" with no action was the original dead end.
});
```

- [ ] **Step 2: Run to verify failure**, then implement. `TemplateRow` gains no new prop: it derives built-in-ness from `isBuiltinTemplateId(t.id)` so there is one source of truth, the same one the host checks.

- [ ] **Step 3: Commit**

```bash
git add src/webview/OrchestratorDrawer.tsx src/webview/DeckDetail.tsx test/webview/OrchestratorDrawer.test.tsx test/webview/DeckDetail.test.tsx
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "feat(orchestrator): built-in rows are duplicate-only, and the picker has an exit"
```

---

### Task 15: CT specs, docs, changelog, and the gate run

**Files:**
- Create: `test-ct/WorkflowList.hues.spec.tsx`
- Modify: `docs/ORCHESTRATOR_COMMANDS.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: A CT spec for what jsdom cannot see**

`test-ct/` uses `testMatch: /.*\.spec\.tsx?$/` and runs in real Chromium. Mirror `test-ct/Workflow.hues.spec.tsx` exactly — it already asserts the card chip's five hues as **computed colour**, which is the only assertion that catches a token pointing at the wrong hue.

```tsx
test("an Active row hues its rail to the same token the card chip uses", async ({ mount }) => {
  // assert getComputedStyle(...).backgroundColor on the rail, per status,
  // against the same expected values Workflow.hues.spec.tsx already pins
});
```

Also cover the header at a narrow width — that two buttons do not clip and the stats yield first, which is exactly what jsdom is blind to.

```bash
npx playwright test --config playwright-ct.config.ts
```

- [ ] **Step 2: Document the commands**

`docs/ORCHESTRATOR_COMMANDS.md` is authoritative over the spec — when they disagree, the code wins. Add the authoring path and the built-in rules: a starter cannot be renamed, deleted or overwritten, and Duplicate is how you own one.

- [ ] **Step 3: Changelog**

Add under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
### Added

- **Three starter workflows, built in.** A fresh install now has *Ship it*,
  *Test & merge* and *Review only* ready to attach, so the first card you open
  offers something real instead of an empty picker. They cannot be renamed or
  deleted — Duplicate one to make a version you can change — and a starter
  improved in a later release reaches you on upgrade, because none of them is
  ever copied into your own storage.
- **Author a template directly.** **＋ New template…** opens a blank shape on the
  canvas, and nothing is written until you save it.
- **A Workflows view.** Every card carrying a workflow in one list, what it is
  waiting on, sorted so what needs you is first. Clicking one opens that card.

### Changed

- **The Deck header says Workflows and Templates**, two buttons in place of
  *Orchestrator*. Both open in one click; the old button, with no workflows yet,
  used to make a blank one instead of opening anything.
- **A workflow attached from a template now launches in the card's own repos**,
  with your configured prompt mode, rather than carrying whichever the template
  was saved against.
```

- [ ] **Step 4: Run every gate**

```bash
cd /Users/oznasi/dev/agent-flow/.worktrees/workflows-nav
npm run typecheck > /tmp/tc.log 2>&1; echo "TYPECHECK=$?"
npm test > /tmp/t.log 2>&1; echo "TEST=$?"; grep -E "Test Files|Tests |FAIL" /tmp/t.log
npm run build > /tmp/b.log 2>&1; echo "BUILD=$?"
npm run test:cov > /tmp/c.log 2>&1; echo "COV=$?"; grep -E "^All files" /tmp/c.log
npx playwright test --config playwright-ct.config.ts
```

All must pass. `test/unit/compat.test.ts` must be **unmodified** — check with `git diff --stat origin/main -- test/unit/compat.test.ts` and expect no output.

- [ ] **Step 5: Verify in a real editor window**

Launch the dev host (VS Code's CLI only) and walk the whole first-run path with `~/.agentflow/templates/` empty: open a card → attach a starter → confirm it arrives disarmed → arm it → watch the Active list agree with the chip → duplicate a starter → edit the copy → save. Then confirm rename and delete are refused on a built-in.

- [ ] **Step 6: Commit and open a PR**

```bash
git add docs/ORCHESTRATOR_COMMANDS.md CHANGELOG.md test-ct/WorkflowList.hues.spec.tsx
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "docs(orchestrator): starters, authoring, and the two header buttons"
git push -u origin feat/workflows-nav
gh pr create --base feat/card-workflows \
  --title "Workflows and Templates: navigation, authoring, and starters" \
  --body-file /tmp/pr-body.md
```

Write `/tmp/pr-body.md` first, covering: the first-run dead end this fixes, the four decisions and what was rejected, the `instantiate` widening and why it is backward-compatible, the test counts, and what stayed unverified. End it with the `🤖 Generated with [Claude Code](https://claude.com/claude-code)` line.

**Base the PR on `feat/card-workflows`, not `main`** — this builds on PR #63 and touches `templates.ts`, which #63 introduced. If #63 has already merged to `main` by then, rebase onto `main` and target `main` instead.

`main` is branch-protected; the merge path is a REST `PUT` as `oznasi1`.

---

## Notes for whoever executes this

- **Tasks 1–6 are host and engine** and can be verified entirely by unit tests. **Tasks 7–14 are webview.** Task 15 is docs and gates. The order matters: 2 before 3, 1 before 5, 8 before 9 and 12.
- **Several test harnesses are referenced rather than reproduced** — `deckView.test.ts`'s config mock, `store.test.ts`'s `fakeIo`, `OrchestratorDrawer.test.tsx`'s render helper, `Workflow.hues.spec.tsx`'s colour assertions. Read the real one before writing against it; a harness invented to match a plan is a defect the plan caused. Where a step above sketches an assertion in a comment rather than giving full code, that is deliberate: the assertion is specified, the plumbing must come from the file it lives in.
- **A single failing test under heavy CPU contention is usually flake**, not a regression — re-run that file alone before believing it. Never let two vitest runs overlap.
- **Do not edit an existing test to make it green.** That is the signal to stop and re-read the invariant it encodes.
