# Deck Orchestrator — Phase 2a: the setting, the store's real IO, and a canvas drawer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Orchestrator visible and usable for the first time — a header chip opens a right-side drawer where you create a named flow, drag Deck cards in as nodes, wire them into a graph on a canvas, put a condition on each connection, and have it all persist to disk. Nothing evaluates and nothing fires: arming is Phase 2b.

**Architecture:** Phase 1's five pure modules gain their first callers. A new `engine/orchestrator/flowIo.ts` supplies the real `fs`-backed `FlowIo` and the only flow-id generator. `DeckPanel` (`src/deckView.ts`) owns the flow list the way it already owns runs and PR facts: it reads flows on construction, posts them to the webview in a new `deck:flows` message, and handles four new inbound messages that create, rename, save and delete a flow. The webview gets one new component, `OrchestratorDrawer.tsx`, in the props-in/callbacks-out shape `ReviewStrip.tsx` already uses — `DeckApp` holds only the flow array and an open/closed flag, because it is already 671 lines with about twenty state hooks and must not absorb a canvas as well. All geometry comes from Phase 1's `layout.ts`; all condition wording comes from Phase 1's `describeCond`.

**Tech Stack:** TypeScript, React (classic JSX runtime), VS Code extension API, Vitest, @testing-library/react with jsdom.

## Global Constraints

- Work in the existing worktree `/Users/oznasi/dev/agent-flow/.claude/worktrees/orchestrator-core` on branch `worktree-orchestrator-core`. Never the main checkout — `vsce package` packages the working directory, so a stray file there ships inside the extension.
- **Do not touch** the `version` field in `package.json`, any version field in `package-lock.json`, or `CHANGELOG.md`. The release session owns those. The `contributes.configuration` hunk in `package.json` IS in scope and pre-approved.
- **No arming, no runner, no launching, no seeding in this phase.** The only edge action available is `notify`. The drawer must have no Arm control at all — its footer states the flow is not armed and that arming arrives next. An Arm button that does nothing is worse than no button.
- **Flow ids must match `/^[A-Za-z0-9_-]+$/`.** Phase 1's `store.ts` skips such a record on read and throws in `fileFor` on write. A slug-from-name scheme (spaces, dots, non-ASCII) will throw.
- `npx tsc --noEmit` clean and `npx vitest run` green before each commit. The suite is 2375 tests across 85 files at the start of this phase; it must only grow.
- **≥95% line coverage on every file this plan creates or modifies.** Check with `npx vitest run --coverage`.
- **`orchestratorStyles.ts` must not redeclare any token owned by `tokens.ts`.** `test/webview/tokens.test.ts` enforces this in both directions and will fail if you do. Use `--t-body`, `--r-ctl`, `--brand`, `--dim`, `--hair`, `--edge`, `--mono` and the `--c-*` hues; never re-define them.
- The Deck's four house design rules, which a reviewer will check against:
  1. **Monospace is for identifiers and counts only** — ticket keys, branches, repo names, numbers. Anything that reads as English is set in the UI font.
  2. **Saturated colour is attention debt.** Red (`--c-danger`) appears only for a real failure. A node that needs nothing from you is monochrome.
  3. **No persistent hint lines on cards.** A hint may appear during an interaction (a drag) and must not linger.
  4. **One primary per surface.** The drawer's filled control is reserved for Arm, which does not exist yet — so in this phase the drawer has **no** filled control.
- **The visual reference is the approved mockup**, at the absolute path `/Users/oznasi/dev/agent-flow/docs/mockups/2026-08-05-deck-orchestrator-drawer.html`. It is **git-ignored**, so it is not in this worktree — read it at that path in the primary checkout. Open it with `?v=canvas` for the shape being built. Match its structure and spacing; do not invent a different layout.
- Conventional commits, scoped `orchestrator`.

## File Structure

| File | Responsibility |
|---|---|
| `src/engine/orchestrator/flowIo.ts` | *(new)* The real `fs`-backed `FlowIo`, and `newFlowId()` — the single place a flow id is minted, so the charset contract lives with it. |
| `src/config.ts` | *(modify)* `orchestrator: boolean`, default false. |
| `package.json` | *(modify)* the `agentFlow.orchestrator` configuration property only. |
| `src/telemetry/events.ts` | *(modify)* `orchestrator: boolean` on `SettingsSnapshot`. |
| `src/telemetry/settingsSnapshot.ts` | *(modify)* map the new setting. |
| `docs/TELEMETRY.md` | *(modify)* document the new snapshot field. |
| `src/types.ts` | *(modify)* four inbound message shapes, one outbound, and a `FlowView` wrapper. |
| `src/deckView.ts` | *(modify)* own the flow list: read on construction, post `deck:flows`, handle the four inbound messages. |
| `src/webview/orchestratorStyles.ts` | *(new)* `ORCH_CSS` — the drawer, tray, canvas, node, edge and inspector rules. |
| `src/webview/deck.tsx` | *(modify)* one line: append `ORCH_CSS` to the injected sheet list. |
| `src/webview/OrchestratorDrawer.tsx` | *(new)* the whole drawer: header, tray, canvas, inspector, footer. Props in, callbacks out. |
| `src/webview/DeckApp.tsx` | *(modify)* the header chip, the flow array state, the drawer mount, and making a card draggable. |

Tests: `test/unit/engine/orchestrator/flowIo.test.ts`, additions to `test/unit/config.test.ts`, `test/unit/telemetry/settingsSnapshot.test.ts`, `test/unit/deckView.test.ts`, `test/webview/tokens.test.ts`, and a new `test/webview/OrchestratorDrawer.test.tsx`.

---

## Task 1: The `agentFlow.orchestrator` setting

**Files:**
- Modify: `src/config.ts`
- Modify: `package.json` (`contributes.configuration.properties` only)
- Modify: `src/telemetry/events.ts`
- Modify: `src/telemetry/settingsSnapshot.ts`
- Modify: `docs/TELEMETRY.md`
- Test: `test/unit/config.test.ts`, `test/unit/telemetry/settingsSnapshot.test.ts`

**Interfaces:**
- Produces: `AgentFlowConfig.orchestrator: boolean` (default `false`), read by Task 3's `deckView.ts` and Task 4's chip. `SettingsSnapshot.orchestrator: boolean`.

Every boolean setting in this repo appears in four places — `config.ts`, `package.json`, `events.ts` and `settingsSnapshot.ts` — plus `docs/TELEMETRY.md`. Miss one and the telemetry snapshot silently omits the setting.

- [ ] **Step 1: Write the failing tests**

In `test/unit/config.test.ts`, find the existing `describe` block that covers boolean settings (search for `reviewWrites`) and add alongside it:

```ts
it("defaults orchestrator to off", () => {
  expect(readConfig(cfg({})).orchestrator).toBe(false);
});

it("reads orchestrator when turned on", () => {
  expect(readConfig(cfg({ orchestrator: true })).orchestrator).toBe(true);
});
```

Match the file's existing helper names — it already has a way to build a fake workspace configuration (the `cfg(...)` shape above mirrors how `reviewWrites` is tested; use whatever that file actually calls it).

In `test/unit/telemetry/settingsSnapshot.test.ts`, find the assertion covering booleans (search for `review_writes`) and extend it so the snapshot carries the new field:

```ts
it("carries the orchestrator setting", () => {
  expect(buildSettingsSnapshot({ ...baseCfg, orchestrator: true }).orchestrator).toBe(true);
  expect(buildSettingsSnapshot({ ...baseCfg, orchestrator: false }).orchestrator).toBe(false);
});
```

Again, use that file's real helper and base-config names rather than inventing `baseCfg` if it calls it something else.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts test/unit/telemetry/settingsSnapshot.test.ts`
Expected: FAIL — `orchestrator` is not a property of the config type.

- [ ] **Step 3: Add the setting to `src/config.ts`**

Add to the `AgentFlowConfig` interface, beside `reviewWrites`:

```ts
  /** Show the Deck's Orchestrator chip and drawer. Off by default, like
   * `reviewWrites`: a flow eventually launches agents on a timer, so the whole
   * feature stays invisible until you ask for it. */
  orchestrator: boolean;
```

And in the object the read function returns, beside `reviewWrites`:

```ts
    orchestrator: c.get<boolean>("orchestrator") ?? false,
```

- [ ] **Step 4: Declare it in `package.json`**

Add to `contributes.configuration.properties`, keeping the file's existing key order convention (alphabetical within the block if that is what you find):

```json
    "agentFlow.orchestrator": {
      "type": "boolean",
      "default": false,
      "markdownDescription": "Show the **Orchestrator** on the Deck: a drawer where you wire the agents already on your board into a flow and put a condition on each connection. Off by default — an armed flow eventually starts agents on a timer, so nothing about it appears until you turn it on."
    },
```

- [ ] **Step 5: Add it to the telemetry snapshot**

In `src/telemetry/events.ts`, add to the `SettingsSnapshot` interface beside `review_writes`:

```ts
  orchestrator: boolean;
```

In `src/telemetry/settingsSnapshot.ts`, add beside `review_writes: cfg.reviewWrites,`:

```ts
    orchestrator: cfg.orchestrator,
```

In `docs/TELEMETRY.md`, find the table row for `review_writes` and add one in the same format:

```
| `orchestrator` | boolean | Whether the Deck's Orchestrator drawer is enabled. |
```

Match the surrounding table's exact column layout.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/unit/config.test.ts test/unit/telemetry/settingsSnapshot.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and full suite**

Run: `npx tsc --noEmit`
Run: `npx vitest run`
Expected: clean, and green with a count two higher than 2375.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts package.json src/telemetry/events.ts src/telemetry/settingsSnapshot.ts docs/TELEMETRY.md test/unit/config.test.ts test/unit/telemetry/settingsSnapshot.test.ts
git commit -m "feat(orchestrator): add the agentFlow.orchestrator setting, off by default"
```

---

## Task 2: The real `FlowIo` and the only flow-id generator

**Files:**
- Create: `src/engine/orchestrator/flowIo.ts`
- Test: `test/unit/engine/orchestrator/flowIo.test.ts`

**Interfaces:**
- Consumes: `FlowIo` from `./store` (Phase 1).
- Produces: `nodeFlowIo(): FlowIo` and `newFlowId(nowMs: number, rand?: () => number): string`. Task 3's `deckView.ts` uses both.

This is the one file in the orchestrator directory allowed to import `fs`, because it *is* the fs boundary. Everything Phase 1 built stays pure behind it.

`newFlowId` must satisfy the charset Phase 1's `store.ts` enforces. It takes `nowMs` and an injectable `rand` so the test is deterministic — the repo's `Date.now()`-free test style.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/orchestrator/flowIo.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { nodeFlowIo, newFlowId } from "../../../../src/engine/orchestrator/flowIo";
import { readFlows, writeFlow, removeFlow } from "../../../../src/engine/orchestrator/store";
import { emptyFlow } from "../../../../src/engine/orchestrator/model";

describe("newFlowId", () => {
  it("only ever produces characters the store accepts", () => {
    // store.ts rejects anything outside this set — a violation here is a crash
    // at write time, not a cosmetic problem.
    for (let i = 0; i < 200; i++) {
      const id = newFlowId(1_800_000_000_000 + i, () => i / 200);
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("is stable for the same inputs and differs when the clock moves", () => {
    expect(newFlowId(1_000, () => 0.5)).toBe(newFlowId(1_000, () => 0.5));
    expect(newFlowId(1_000, () => 0.5)).not.toBe(newFlowId(2_000, () => 0.5));
  });

  it("differs when only the random part changes, so two flows made in one millisecond collide never", () => {
    expect(newFlowId(1_000, () => 0.1)).not.toBe(newFlowId(1_000, () => 0.9));
  });
});

describe("nodeFlowIo", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-flowio-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a flow through the real filesystem", () => {
    const io = nodeFlowIo();
    const flow = { ...emptyFlow("f1", "Ship it", 1_000), armed: false };
    writeFlow(io, dir, flow);
    expect(readFlows(io, dir)).toEqual([flow]);
  });

  it("creates the directory on first write", () => {
    const io = nodeFlowIo();
    const nested = path.join(dir, "deep", "flows");
    writeFlow(io, nested, emptyFlow("f1", "n", 1));
    expect(fs.existsSync(path.join(nested, "f1.json"))).toBe(true);
  });

  it("reads an empty list from a directory that does not exist", () => {
    expect(readFlows(nodeFlowIo(), path.join(dir, "nope"))).toEqual([]);
  });

  it("returns null from readFile rather than throwing for a vanished file", () => {
    // The race readFlows is built to survive: removeFlow deletes between the
    // readdir and the read.
    expect(nodeFlowIo().readFile(path.join(dir, "gone.json"))).toBeNull();
  });

  it("returns null from readFile for a directory rather than throwing", () => {
    fs.mkdirSync(path.join(dir, "adir.json"));
    expect(nodeFlowIo().readFile(path.join(dir, "adir.json"))).toBeNull();
  });

  it("removes a flow, and removing a missing one is not an error", () => {
    const io = nodeFlowIo();
    writeFlow(io, dir, emptyFlow("f1", "n", 1));
    removeFlow(io, dir, "f1");
    expect(readFlows(io, dir)).toEqual([]);
    expect(() => removeFlow(io, dir, "f1")).not.toThrow();
  });

  it("lists only what is in the directory", () => {
    const io = nodeFlowIo();
    writeFlow(io, dir, emptyFlow("a", "a", 2));
    writeFlow(io, dir, emptyFlow("b", "b", 1));
    expect(io.readDir(dir).sort()).toEqual(["a.json", "b.json"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/orchestrator/flowIo.test.ts`
Expected: FAIL — cannot resolve `flowIo`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/orchestrator/flowIo.ts`:

```ts
// The fs boundary for flows, and the one place a flow id is minted. Every other
// module in this directory is pure and stays that way; this file exists so that
// `store.ts` can be tested from an in-memory fake and still have a real
// implementation in production.
import * as fs from "fs";
import * as path from "path";
import { FlowIo } from "./store";

/** Mint a flow id. The charset is not cosmetic: `store.ts` builds a filename from
 * an id and rejects anything outside `[A-Za-z0-9_-]`, so a slug-from-name scheme
 * would throw on the first flow called "My flow". Time-ordered prefix plus a
 * random suffix, both base36, so two flows created in the same millisecond cannot
 * collide. `rand` is injectable to keep the test deterministic. */
export function newFlowId(nowMs: number, rand: () => number = Math.random): string {
  const stamp = Math.floor(nowMs).toString(36);
  const salt = Math.floor(rand() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `f${stamp}-${salt}`;
}

/** The real IO. Every read degrades to `null` rather than throwing: a file can
 * vanish between `readDir` and `readFile` because `removeFlow` deletes, and an
 * unreadable entry must cost one flow rather than the whole drawer — the same
 * posture `engine/runs.ts` takes with a corrupt record. */
export function nodeFlowIo(): FlowIo {
  return {
    readDir: (dir) => fs.readdirSync(dir),
    readFile: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    writeFile: (p, text) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    },
    remove: (p) => fs.rmSync(p, { force: true }),
  };
}
```

Note `readDir` deliberately does NOT catch: `readFlows` already wraps it in a try and returns an empty list, which is how "the store has never been written" reads as "no flows".

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/orchestrator/flowIo.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and coverage**

Run: `npx tsc --noEmit`
Run: `npx vitest run --coverage test/unit/engine/orchestrator/flowIo.test.ts`
Expected: `flowIo.ts` at 100% lines.

- [ ] **Step 6: Commit**

```bash
git add src/engine/orchestrator/flowIo.ts test/unit/engine/orchestrator/flowIo.test.ts
git commit -m "feat(orchestrator): add the fs-backed FlowIo and the flow-id generator"
```

---

## Task 3: Host-side flow state and the message contract

**Files:**
- Modify: `src/types.ts`
- Modify: `src/deckView.ts`
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `nodeFlowIo`, `newFlowId` (Task 2); `readFlows`, `writeFlow`, `removeFlow`, `defaultFlowsDir` from `./engine/orchestrator/store`; `Flow`, `emptyFlow` from `./engine/orchestrator/model`.
- Produces, for Task 4's webview: the outbound message `{ type: "deck:flows"; flows: Flow[]; enabled: boolean }` and the inbound messages `{ type: "flow:create" }`, `{ type: "flow:rename"; id: string; name: string }`, `{ type: "flow:save"; flow: Flow }`, `{ type: "flow:delete"; id: string }`.

`flow:save` carries the whole flow rather than a patch. A graph is small, the webview is the only editor, and a whole-document write means no merge logic and no partial-update bugs.

- [ ] **Step 1: Write the failing tests**

`test/unit/deckView.test.ts` isolates the panel from the engine with a hoisted stub object `h` plus one `vi.mock` per engine module — see `vi.mock("../../src/engine/runs", …)` at line 92, which returns `defaultRunsDir: () => "/runs"` and reads `h.runs`. **Follow that exact idiom for flows; do not introduce a temp directory.**

First extend the hoisted `h` object with three fields, beside `runs`:

```ts
  flows: [] as Flow[],
  writeFlow: vi.fn(),
  removeFlow: vi.fn(),
```

Add the import for the type at the top of the file:

```ts
import type { Flow } from "../../src/engine/orchestrator/model";
```

Then add two module mocks beside the existing ones:

```ts
vi.mock("../../src/engine/orchestrator/store", () => ({
  defaultFlowsDir: () => "/flows",
  readFlows: () => h.flows,
  writeFlow: h.writeFlow,
  removeFlow: h.removeFlow,
}));
vi.mock("../../src/engine/orchestrator/flowIo", () => ({
  nodeFlowIo: () => ({ readDir: () => [], readFile: () => null, writeFile: () => {}, remove: () => {} }),
  // A counter, not a constant: deterministic so ids are assertable, but varying so
  // the re-mint-on-collision path is reachable. A constant would make the retry
  // loop indistinguishable from a refusal.
  newFlowId: () => `fTEST-${++h.idSeq}`,
}));
```

Add `idSeq: 0` to the hoisted `h` object too, and reset both `h.flows` and `h.idSeq` in the existing `beforeEach` alongside `h.runs`.

The file already has `lastPanel()` (line 258) and `posts(p)` (line 259) for the panel and its posted messages, and `setConfig({ … })` for configuration. Use those. To deliver an inbound message, call the panel's registered receiver — the fake panel exposes `webview.onDidReceiveMessage`, so grab the handler the same way the file's existing message tests do.

The assertions to add, in a new `describe` block at the end of the file:

```ts
const mkFlow = (id: string, name: string): Flow =>
  ({ id, name, armed: false, createdAt: 1_000, nodes: [], edges: [] });

describe("orchestrator flows", () => {
  /** Open a panel and return it plus a way to deliver an inbound message. */
  const openPanel = async () => {
    DeckPanel.show(fakeContext(), fakeAuth(), () => {});
    await Promise.resolve();
    const p = lastPanel();
    const recv = p.webview.onDidReceiveMessage.mock.calls.at(-1)![0] as (m: unknown) => unknown;
    return { p, send: async (m: unknown) => { await recv(m); } };
  };

  it("posts deck:flows with enabled false when the setting is off", async () => {
    // With the setting off the webview renders no chip at all, but the host still
    // posts: silence is indistinguishable from "not loaded yet".
    setConfig({ orchestrator: false });
    const { p } = await openPanel();
    expect(posts(p).find((m) => m.type === "deck:flows")).toMatchObject({ enabled: false, flows: [] });
  });

  it("posts the flows it read from the store when enabled", async () => {
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "Ship it")];
    const { p } = await openPanel();
    const msg = posts(p).find((m) => m.type === "deck:flows");
    expect(msg).toMatchObject({ enabled: true });
    expect(msg.flows.map((f: Flow) => f.name)).toEqual(["Ship it"]);
  });

  it("flow:create writes a new disarmed flow with a store-safe id", async () => {
    setConfig({ orchestrator: true });
    const { send } = await openPanel();
    await send({ type: "flow:create" });
    expect(h.writeFlow).toHaveBeenCalledTimes(1);
    const written = h.writeFlow.mock.calls[0][2] as Flow;
    expect(written).toMatchObject({ name: "New flow", armed: false, nodes: [], edges: [] });
    expect(written.id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("flow:create re-mints rather than overwriting an id already on disk", async () => {
    // newFlowId is probabilistic. A collision must not clobber the user's flow.
    // The flowIo mock's newFlowId is deterministic, so seed the store with exactly
    // what it will return first and assert the write does not target that id.
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("fTEST-1", "already here")];
    const { send } = await openPanel();
    await send({ type: "flow:create" });
    const written = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    // It must re-mint past the taken id. Overwriting "fTEST-1" is the one outcome
    // that must never happen — that is the user's saved flow.
    expect(written.id).not.toBe("fTEST-1");
    expect(written.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h.flows[0].name).toBe("already here");
  });

  it("flow:rename changes only the name", async () => {
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "old")];
    const { send } = await openPanel();
    await send({ type: "flow:rename", id: "f1", name: "Ship the migration" });
    expect(h.writeFlow.mock.calls.at(-1)![2]).toMatchObject({ id: "f1", name: "Ship the migration" });
  });

  it("flow:rename ignores an id it does not have", async () => {
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "old")];
    const { send } = await openPanel();
    await send({ type: "flow:rename", id: "nope", name: "x" });
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("flow:save persists the whole graph", async () => {
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "n")];
    const { send } = await openPanel();
    const edited: Flow = {
      ...mkFlow("f1", "n"),
      nodes: [{ id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "agent-flow" }],
    };
    await send({ type: "flow:save", flow: edited });
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).nodes).toHaveLength(1);
  });

  it("flow:save refuses a flow whose id is not in the store", async () => {
    // The drawer can only ever edit a flow the host gave it. Anything else is a
    // bug or a hostile message, and writing it would create a file from nothing.
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "n")];
    const { send } = await openPanel();
    await send({ type: "flow:save", flow: mkFlow("intruder", "x") });
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("flow:delete removes it", async () => {
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "n")];
    const { send } = await openPanel();
    await send({ type: "flow:delete", id: "f1" });
    expect(h.removeFlow).toHaveBeenCalledWith(expect.anything(), "/flows", "f1");
  });

  it("ignores every flow message when the setting is off", async () => {
    setConfig({ orchestrator: false });
    const { send } = await openPanel();
    await send({ type: "flow:create" });
    await send({ type: "flow:delete", id: "f1" });
    expect(h.writeFlow).not.toHaveBeenCalled();
    expect(h.removeFlow).not.toHaveBeenCalled();
  });
});
```

`writeFlow`'s third argument is the flow because `store.ts`'s signature is `writeFlow(io, dir, flow)`. If the file's existing panel-opening helper differs from `openPanel` above — check how the neighbouring `describe` blocks obtain a panel and its message receiver — use the file's version rather than adding a second one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: FAIL — `deck:flows` is not a known message type.

- [ ] **Step 3: Add the message shapes to `src/types.ts`**

Add to the `InboundMessage` union:

```ts
  // ── Orchestrator flows ──────────────────────────────────────────────
  // `flow:save` carries the WHOLE flow rather than a patch: a graph is small,
  // the drawer is its only editor, and a whole-document write means no merge
  // logic and no partial-update bugs.
  | { type: "flow:create" }
  | { type: "flow:rename"; id: string; name: string }
  | { type: "flow:save"; flow: Flow }
  | { type: "flow:delete"; id: string }
```

Add to the `OutboundMessage` union:

```ts
  // `enabled: false` still posts, with an empty list: the webview must be able
  // to tell "the setting is off" from "not loaded yet", and silence cannot.
  | { type: "deck:flows"; flows: Flow[]; enabled: boolean }
```

Add the import at the top of `types.ts`:

```ts
import { Flow } from "./engine/orchestrator/model";
```

`model.ts` imports nothing, so this cannot create a cycle.

- [ ] **Step 4: Wire the host in `src/deckView.ts`**

Add the imports:

```ts
import { Flow, emptyFlow } from "./engine/orchestrator/model";
import { defaultFlowsDir, readFlows, writeFlow, removeFlow } from "./engine/orchestrator/store";
import { nodeFlowIo, newFlowId } from "./engine/orchestrator/flowIo";
```

Add a field beside the other caches, and initialise the directory the same way the runs directory is resolved in this file (follow the existing pattern — if the file takes an injectable directory for tests, take one here too):

```ts
  /** The flows store's directory. Injected in tests, `defaultFlowsDir()` in
   * production — the same shape this file already uses for runs. */
  private readonly flowsDir: string;
  private readonly flowIo = nodeFlowIo();
```

Add a method that reads and posts, and call it from wherever the panel does its initial post and at the end of `refresh()`:

```ts
  /** Read the flows store and post it. Cheap — a handful of small JSON files —
   * so it rides the same refresh as everything else rather than owning a cache. */
  private postFlows(): void {
    const enabled = readConfig().orchestrator;
    const flows = enabled ? readFlows(this.flowIo, this.flowsDir) : [];
    this.post({ type: "deck:flows", flows, enabled });
  }
```

Use whatever this file's existing config accessor is rather than calling `readConfig()` directly if it holds one.

Then handle the four messages in `onMessage`, beside the existing cases:

```ts
      case "flow:create": {
        if (!readConfig().orchestrator) return;
        const now = Date.now();
        // `newFlowId` is probabilistic, not unique by construction: its salt space
        // is 36^4, so two flows minted in the same millisecond CAN collide, and a
        // collision here would silently overwrite the user's existing flow, since
        // the store writes by id. Re-mint against what is already on disk. Bounded
        // rather than a while-loop so a pathological `Math.random()` cannot hang
        // the extension host.
        const taken = new Set(readFlows(this.flowIo, this.flowsDir).map((f) => f.id));
        let id = newFlowId(now);
        for (let i = 0; taken.has(id) && i < 8; i++) id = newFlowId(now + i + 1);
        if (taken.has(id)) return; // 9 collisions in a row is broken, not unlucky
        writeFlow(this.flowIo, this.flowsDir, emptyFlow(id, "New flow", now));
        this.postFlows();
        return;
      }
      case "flow:rename": {
        if (!readConfig().orchestrator) return;
        const existing = readFlows(this.flowIo, this.flowsDir).find((f) => f.id === m.id);
        if (!existing) return;
        writeFlow(this.flowIo, this.flowsDir, { ...existing, name: m.name });
        this.postFlows();
        return;
      }
      case "flow:save": {
        if (!readConfig().orchestrator) return;
        // Only a flow the host already has may be saved. The drawer can only ever
        // edit one it was given; anything else would create a file from nothing.
        const known = readFlows(this.flowIo, this.flowsDir).some((f) => f.id === m.flow.id);
        if (!known) return;
        writeFlow(this.flowIo, this.flowsDir, m.flow);
        this.postFlows();
        return;
      }
      case "flow:delete": {
        if (!readConfig().orchestrator) return;
        removeFlow(this.flowIo, this.flowsDir, m.id);
        this.postFlows();
        return;
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck, full suite, coverage**

Run: `npx tsc --noEmit`
Run: `npx vitest run`
Run: `npx vitest run --coverage`
Expected: green; `flowIo.ts` and the new `deckView.ts` lines ≥95%.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat(orchestrator): let the Deck panel own, post and persist flows"
```

---

## Task 4: The header chip, the stylesheet, and the drawer shell

**Files:**
- Create: `src/webview/orchestratorStyles.ts`
- Create: `src/webview/OrchestratorDrawer.tsx`
- Modify: `src/webview/deck.tsx` (one line)
- Modify: `src/webview/DeckApp.tsx`
- Test: `test/webview/OrchestratorDrawer.test.tsx`, `test/webview/tokens.test.ts`

**Interfaces:**
- Consumes: `deck:flows` (Task 3); `Flow` from `engine/orchestrator/model`.
- Produces: `ORCH_CSS`; and the component contract every later task extends:

```ts
export interface OrchestratorDrawerProps {
  flows: Flow[];
  /** Which flow is open. `null` closes the drawer. */
  openId: string | null;
  /** Every card on the board, so the tray and canvas can resolve a node's live state. */
  runs: RunStatus[];
  onClose: () => void;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onSave: (flow: Flow) => void;
  onDelete: (id: string) => void;
}
export function OrchestratorDrawer(p: OrchestratorDrawerProps): JSX.Element | null;
```

Read the mockup at `/Users/oznasi/dev/agent-flow/docs/mockups/2026-08-05-deck-orchestrator-drawer.html` with `?v=canvas` before writing any CSS. Match its structure.

- [ ] **Step 1: Write the failing tests**

Create `test/webview/OrchestratorDrawer.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { OrchestratorDrawer } from "../../src/webview/OrchestratorDrawer";
import type { Flow } from "../../src/engine/orchestrator/model";

const flow = (over: Partial<Flow> = {}): Flow => ({
  id: "f1", name: "Ship the migration", armed: false, createdAt: 1_000, nodes: [], edges: [], ...over,
});

const props = (over: Partial<React.ComponentProps<typeof OrchestratorDrawer>> = {}) => ({
  flows: [flow()], openId: "f1", runs: [],
  onClose: vi.fn(), onCreate: vi.fn(), onOpen: vi.fn(),
  onRename: vi.fn(), onSave: vi.fn(), onDelete: vi.fn(),
  ...over,
});

describe("OrchestratorDrawer", () => {
  it("renders nothing when no flow is open", () => {
    const { container } = render(<OrchestratorDrawer {...props({ openId: null })} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the open flow's name in an editable field", () => {
    render(<OrchestratorDrawer {...props()} />);
    expect(screen.getByLabelText("Flow name")).toHaveValue("Ship the migration");
  });

  it("renames on blur, not on every keystroke", () => {
    const onRename = vi.fn();
    render(<OrchestratorDrawer {...props({ onRename })} />);
    const input = screen.getByLabelText("Flow name");
    fireEvent.change(input, { target: { value: "Ship it" } });
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledWith("f1", "Ship it");
  });

  it("does not fire a rename when the name is unchanged", () => {
    const onRename = vi.fn();
    render(<OrchestratorDrawer {...props({ onRename })} />);
    fireEvent.blur(screen.getByLabelText("Flow name"));
    expect(onRename).not.toHaveBeenCalled();
  });

  it("closes", () => {
    const onClose = vi.fn();
    render(<OrchestratorDrawer {...props({ onClose })} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("states that the flow is not armed and that arming comes later", () => {
    render(<OrchestratorDrawer {...props()} />);
    expect(screen.getByText(/not armed/i)).toBeTruthy();
  });

  it("has no Arm control at all — arming is not built yet", () => {
    render(<OrchestratorDrawer {...props()} />);
    expect(screen.queryByRole("button", { name: /^arm/i })).toBeNull();
  });

  it("offers an empty state that explains the first move", () => {
    render(<OrchestratorDrawer {...props()} />);
    expect(screen.getByText(/drag a card/i)).toBeTruthy();
  });

  it("lets you switch to another flow", () => {
    const onOpen = vi.fn();
    render(<OrchestratorDrawer {...props({ onOpen, flows: [flow(), flow({ id: "f2", name: "Second" })] })} />);
    fireEvent.click(screen.getByRole("button", { name: /flows/i }));
    fireEvent.click(screen.getByRole("button", { name: "Second" }));
    expect(onOpen).toHaveBeenCalledWith("f2");
  });

  it("creates a flow from the switcher", () => {
    const onCreate = vi.fn();
    render(<OrchestratorDrawer {...props({ onCreate })} />);
    fireEvent.click(screen.getByRole("button", { name: /flows/i }));
    fireEvent.click(screen.getByRole("button", { name: "+ New flow" }));
    expect(onCreate).toHaveBeenCalled();
  });
});
```

In `test/webview/tokens.test.ts`, add `ORCH_CSS` to the list of sheets checked for token redeclaration — find the array the file builds from `CSS`, `DECK_CSS` and `MARKETPLACE_CSS` and add the new sheet to it, importing it at the top.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/webview/OrchestratorDrawer.test.tsx`
Expected: FAIL — cannot resolve `OrchestratorDrawer`.

- [ ] **Step 3: Write the stylesheet**

Create `src/webview/orchestratorStyles.ts`. This sheet USES tokens from `tokens.ts` and must declare none of them.

```ts
// The Orchestrator drawer. Read alongside the approved mockup at
// docs/mockups/2026-08-05-deck-orchestrator-drawer.html (?v=canvas) — that file is
// the visual contract and is git-ignored, so it lives only in the primary checkout.
//
// Two things here are deliberate and easy to "fix" wrongly:
//  1. The drawer starts BELOW the Deck header, not at the top of the panel. The
//     header carries the chip you just pressed and the Live-signal / PR-facts
//     toggles the conditions read from; covering them hides the state.
//  2. There is NO scrim. A modal veil would block the drag the drawer exists to
//     receive — the board stays fully live while the drawer is open.
export const ORCH_CSS = `
  .orch-chip { gap: 6px; }
  .orch-chip .ic { font-size: 12px; line-height: 1; }
  .orch-chip .ct { font-family: var(--mono); font-size: var(--t-micro); color: var(--dim); }

  .orch { position: fixed; top: 53px; right: 0; bottom: 0; width: 560px; z-index: 40;
    display: flex; flex-direction: column;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border-left: 1px solid var(--hair); box-shadow: -14px 0 34px -12px rgba(0,0,0,.45); }

  .orch-hd { flex: none; padding: 13px 16px 11px; border-bottom: 1px solid var(--hair); }
  .orch-hd .row { display: flex; align-items: center; gap: 8px; }
  .orch-hd .eyebrow { font-size: var(--t-micro); letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  .orch-hd .sp { flex: 1; }
  .orch-x { width: 24px; height: 24px; border: 0; border-radius: var(--r-ctl); background: transparent;
    color: var(--dim); cursor: pointer; font-size: 14px; line-height: 1; }
  .orch-x:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }

  .orch-name { width: 100%; margin-top: 5px; margin-left: -6px; padding: 3px 6px;
    background: transparent; border: 1px solid transparent; border-radius: var(--r-ctl);
    font: inherit; font-size: 15px; font-weight: 600; letter-spacing: -.012em; color: var(--vscode-foreground); }
  .orch-name:hover { border-color: var(--edge); }
  .orch-name:focus { border-color: var(--vscode-focusBorder); outline: none;
    background: var(--vscode-input-background); }

  .orch-mini { height: 20px; padding: 0 7px; font-size: var(--t-micro); border-radius: var(--r-chip);
    border: 1px solid var(--edge); background: transparent; color: var(--dim); cursor: pointer; }
  .orch-mini:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }

  .orch-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
    padding: 14px 16px 18px; }

  .orch-sect { flex: none; margin-bottom: 12px; }
  .orch-sect-hd { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .orch-sect-hd .t { font-size: var(--t-micro); letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  .orch-sect-hd .rule { flex: 1; height: 1px; background: var(--hair); }

  .orch-empty { border: 1px dashed var(--edge); border-radius: var(--r-card); padding: 22px 14px;
    text-align: center; font-size: var(--t-body); color: var(--dim); line-height: 1.5; }

  .orch-ft { flex: none; padding: 10px 16px; border-top: 1px solid var(--hair);
    display: flex; align-items: center; gap: 10px; font-size: var(--t-micro); color: var(--dim); }
  .orch-ft .sp { flex: 1; }

  .orch-flows { position: absolute; right: 16px; top: 40px; z-index: 5; min-width: 160px;
    border: 1px solid var(--edge); border-radius: var(--r-ctl); padding: 4px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    box-shadow: 0 6px 20px -8px rgba(0,0,0,.5); }
  .orch-flows button { display: block; width: 100%; text-align: left; border: 0; background: transparent;
    color: var(--vscode-foreground); font: inherit; font-size: var(--t-body);
    padding: 5px 8px; border-radius: var(--r-chip); cursor: pointer; }
  .orch-flows button:hover { background: var(--vscode-toolbar-hoverBackground); }
`;
```

- [ ] **Step 4: Inject the sheet**

In `src/webview/deck.tsx`, add the import and extend the array:

```ts
import { ORCH_CSS } from "./orchestratorStyles";
```

```ts
for (const css of [TOKENS_CSS, BASE_CSS, DECK_CSS, ORCH_CSS]) {
```

- [ ] **Step 5: Write the drawer shell**

Create `src/webview/OrchestratorDrawer.tsx`:

```tsx
import * as React from "react";
import { Flow } from "../engine/orchestrator/model";
import { RunStatus } from "../types";

export interface OrchestratorDrawerProps {
  flows: Flow[];
  /** Which flow is open. `null` closes the drawer. */
  openId: string | null;
  /** Every card on the board, so the tray and canvas can resolve a node's live
   * state and the inspector can say what a condition is currently waiting on. */
  runs: RunStatus[];
  onClose: () => void;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onSave: (flow: Flow) => void;
  onDelete: (id: string) => void;
}

export function OrchestratorDrawer(p: OrchestratorDrawerProps): JSX.Element | null {
  const flow = p.flows.find((f) => f.id === p.openId);
  const [picking, setPicking] = React.useState(false);
  if (!flow) return null;

  const places = flow.nodes.filter((n) => n.kind !== "notify").length;

  return (
    <aside className="orch" aria-label="Orchestrator">
      <div className="orch-hd">
        <div className="row">
          <span className="eyebrow">Orchestrator</span>
          <div className="sp" />
          <button type="button" className="orch-mini" onClick={() => setPicking((v) => !v)}>
            Flows · {p.flows.length} ▾
          </button>
          <button type="button" className="orch-x" aria-label="Close" onClick={p.onClose}>✕</button>
        </div>
        {/* Rename on blur, not per keystroke: every keystroke would be a disk
            write and a re-post, and the field would fight the re-render. */}
        <input
          className="orch-name"
          aria-label="Flow name"
          defaultValue={flow.name}
          key={flow.id}
          onBlur={(e) => {
            const next = e.currentTarget.value.trim();
            if (next && next !== flow.name) p.onRename(flow.id, next);
          }}
        />
        {picking && (
          <div className="orch-flows">
            {p.flows.map((f) => (
              <button type="button" key={f.id} onClick={() => { setPicking(false); p.onOpen(f.id); }}>
                {f.name}
              </button>
            ))}
            <button type="button" onClick={() => { setPicking(false); p.onCreate(); }}>+ New flow</button>
          </div>
        )}
      </div>

      <div className="orch-body">
        {flow.nodes.length === 0 ? (
          <div className="orch-empty">
            Drag a card from the board to add it to this flow,<br />
            then connect two nodes to put a condition between them.
          </div>
        ) : null}
      </div>

      <div className="orch-ft">
        <span>
          {places} {places === 1 ? "node" : "nodes"} · {flow.edges.length}{" "}
          {flow.edges.length === 1 ? "rule" : "rules"} · not armed
        </span>
        <div className="sp" />
        <span>arming arrives in the next phase</span>
      </div>
    </aside>
  );
}
```

- [ ] **Step 6: Mount it in `DeckApp.tsx`**

Add the imports:

```tsx
import { OrchestratorDrawer } from "./OrchestratorDrawer";
import type { Flow } from "../engine/orchestrator/model";
```

Add state beside the other hooks:

```tsx
  const [flows, setFlows] = React.useState<Flow[]>([]);
  const [orchEnabled, setOrchEnabled] = React.useState(false);
  const [openFlowId, setOpenFlowId] = React.useState<string | null>(null);
```

Handle the message in the existing `handler`, beside the other `m.type ===` branches:

```tsx
      if (m.type === "deck:flows") {
        setFlows((old) => {
          // A create posts a flow we did not have — open it, since pressing the
          // chip with none is a request for exactly that. A flow deleted
          // elsewhere must not leave the drawer open on nothing.
          setOpenFlowId((cur) => {
            if (cur && m.flows.some((f) => f.id === cur)) return cur;
            const fresh = m.flows.find((f) => !old.some((o) => o.id === f.id));
            return fresh ? fresh.id : null;
          });
          return m.flows;
        });
        setOrchEnabled(m.enabled);
      }
```

Setting `openFlowId` from inside the `setFlows` updater is what lets it compare against the *previous* list without adding `flows` to the effect's dependencies — the handler is registered once and must not close over a stale array.

Add the chip to the header, beside the Live signal / PR facts controls. Not filled — the board's primary verbs live on the cards:

```tsx
        {orchEnabled && (
          <button
            type="button"
            className="ctl orch-chip"
            onClick={() => {
              if (flows.length === 0) send({ type: "flow:create" });
              else setOpenFlowId((cur) => (cur ? null : flows[0].id));
            }}
          >
            <span className="ic">⚡</span>
            <span>Orchestrator</span>
            {flows.length > 0 && <span className="ct">{flows.length}</span>}
          </button>
        )}
```

And mount the drawer at the end of the returned tree, beside the toasts:

```tsx
      {orchEnabled && (
        <OrchestratorDrawer
          flows={flows}
          openId={openFlowId}
          runs={runs}
          onClose={() => setOpenFlowId(null)}
          onCreate={() => send({ type: "flow:create" })}
          onOpen={(id) => setOpenFlowId(id)}
          onRename={(id, name) => send({ type: "flow:rename", id, name })}
          onSave={(flow) => send({ type: "flow:save", flow })}
          onDelete={(id) => send({ type: "flow:delete", id })}
        />
      )}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/webview/OrchestratorDrawer.test.tsx test/webview/tokens.test.ts test/webview/DeckApp.test.tsx`
Expected: PASS. If `DeckApp.test.tsx` fails because the chip appears where a test counts header controls, update that test — the chip is a deliberate new control.

- [ ] **Step 8: Typecheck, full suite, coverage**

Run: `npx tsc --noEmit`
Run: `npx vitest run`
Run: `npx vitest run --coverage`
Expected: green; `OrchestratorDrawer.tsx` ≥95% lines. `orchestratorStyles.ts` is a string constant — add it to the coverage `exclude` list in `vitest.config.ts` beside `deckStyles.ts`, which is excluded for the same reason.

- [ ] **Step 9: Commit**

```bash
git add src/webview/orchestratorStyles.ts src/webview/OrchestratorDrawer.tsx src/webview/deck.tsx src/webview/DeckApp.tsx vitest.config.ts test/webview/OrchestratorDrawer.test.tsx test/webview/tokens.test.ts
git commit -m "feat(orchestrator): add the header chip and the drawer shell"
```

---

## Task 5: The tray, and dragging a board card into a flow

**Files:**
- Modify: `src/webview/OrchestratorDrawer.tsx`
- Modify: `src/webview/orchestratorStyles.ts`
- Modify: `src/webview/DeckApp.tsx` (make a card a drag source)
- Test: `test/webview/OrchestratorDrawer.test.tsx`

**Interfaces:**
- Consumes: the props from Task 4.
- Produces: the drag payload contract — a card sets `text/plain` to `<runKey>\0<repo>`, and the tray parses it into a `place` node. Task 6's canvas reuses the same payload.

A `place` node stores `runKey` and `repo`, never a session id — sessions come and go inside a worktree, and the worktree is what a condition can be about.

- [ ] **Step 1: Write the failing tests**

Add to `test/webview/OrchestratorDrawer.test.tsx`:

```tsx
const drop = (el: Element, payload: string) =>
  fireEvent.drop(el, { dataTransfer: { getData: () => payload, dropEffect: "copy" } });

describe("the tray", () => {
  it("adds a place node when a card is dropped", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave })} />);
    drop(screen.getByTestId("orch-tray"), "ASM-1\0agent-flow");
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.nodes).toEqual([
      expect.objectContaining({ kind: "place", runKey: "ASM-1", repo: "agent-flow", join: "any" }),
    ]);
  });

  it("gives the new node an id that is unique within the flow", () => {
    const onSave = vi.fn();
    const existing = flow({ nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-9", repo: "r" }] });
    render(<OrchestratorDrawer {...props({ onSave, flows: [existing] })} />);
    drop(screen.getByTestId("orch-tray"), "ASM-1\0agent-flow");
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(new Set(saved.nodes.map((n) => n.id)).size).toBe(2);
  });

  it("refuses the same run and repo twice", () => {
    const onSave = vi.fn();
    const existing = flow({ nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow" }] });
    render(<OrchestratorDrawer {...props({ onSave, flows: [existing] })} />);
    drop(screen.getByTestId("orch-tray"), "ASM-1\0agent-flow");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("accepts the same run in a different repo", () => {
    const onSave = vi.fn();
    const existing = flow({ nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow" }] });
    render(<OrchestratorDrawer {...props({ onSave, flows: [existing] })} />);
    drop(screen.getByTestId("orch-tray"), "ASM-1\0bite-me");
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("ignores a malformed payload", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave })} />);
    drop(screen.getByTestId("orch-tray"), "nonsense-with-no-separator");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("lists an attached node as a chip, and removes it", () => {
    const onSave = vi.fn();
    const existing = flow({ nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow" }] });
    render(<OrchestratorDrawer {...props({ onSave, flows: [existing] })} />);
    expect(screen.getByText("ASM-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove ASM-1" }));
    expect((onSave.mock.calls[0][0] as Flow).nodes).toEqual([]);
  });

  it("removing a node also removes every edge touching it", () => {
    const onSave = vi.fn();
    const existing = flow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "r" },
        { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "done" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    });
    render(<OrchestratorDrawer {...props({ onSave, flows: [existing] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove ASM-1" }));
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.edges).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/webview/OrchestratorDrawer.test.tsx`
Expected: FAIL — no element with test id `orch-tray`.

- [ ] **Step 3: Add the tray styles**

Append to `ORCH_CSS`:

```css
  /* The tray sits ABOVE the graph: attaching comes before wiring, and this is
     the primary drop target. It is a view of the same node list the canvas
     draws — never a second store. */
  .orch-tray { display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    padding: 7px; min-height: 46px; border: 1px dashed var(--edge); border-radius: var(--r-card); }
  .orch-tray.over { border-style: solid; border-color: var(--brand);
    background: color-mix(in srgb, var(--brand) 7%, transparent); }
  .orch-tray .hint { font-size: var(--t-body); color: var(--dim); padding: 3px 4px; }
  .orch-tchip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px 4px 8px;
    border: 1px solid var(--hair); border-radius: var(--r-chip);
    background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent); }
  .orch-tchip .k { font-family: var(--mono); font-size: var(--t-data); }
  .orch-tchip .sub { font-size: var(--t-micro); color: var(--dim); }
  .orch-tchip .rm { border: 0; background: transparent; color: var(--dim); cursor: pointer;
    font-size: 9px; padding: 0 1px; }
  .orch-tchip .rm:hover { color: var(--vscode-foreground); }
```

- [ ] **Step 4: Add the tray to the drawer**

Add a helper above the component, and the tray section inside `.orch-body` before the empty state:

```tsx
/** The drag payload a Deck card carries. A NUL separator cannot appear in a
 * ticket key or a repo name, so parsing is unambiguous. */
export const DRAG_SEP = "\0";

function parseDrag(raw: string): { runKey: string; repo: string } | null {
  const i = raw.indexOf(DRAG_SEP);
  if (i <= 0) return null;
  const runKey = raw.slice(0, i);
  const repo = raw.slice(i + 1);
  return runKey && repo ? { runKey, repo } : null;
}

/** An id unique within this flow. Node ids are local to a flow, so a counter
 * over the existing ids is enough and keeps them readable. */
function nextNodeId(flow: Flow): string {
  let n = flow.nodes.length + 1;
  const taken = new Set(flow.nodes.map((x) => x.id));
  while (taken.has(`n${n}`)) n++;
  return `n${n}`;
}
```

Inside the component, above the return:

```tsx
  const [over, setOver] = React.useState(false);

  const attach = (raw: string) => {
    const parsed = parseDrag(raw);
    if (!parsed) return;
    // The same place twice would give two nodes that can never disagree.
    const dup = flow.nodes.some(
      (n) => n.kind === "place" && n.runKey === parsed.runKey && n.repo === parsed.repo,
    );
    if (dup) return;
    p.onSave({
      ...flow,
      nodes: [
        ...flow.nodes,
        { id: nextNodeId(flow), kind: "place", x: 24, y: 24 + flow.nodes.length * 88, join: "any", ...parsed },
      ],
    });
  };

  const removeNode = (id: string) =>
    p.onSave({
      ...flow,
      nodes: flow.nodes.filter((n) => n.id !== id),
      // An edge whose end is gone can never be evaluated, so it goes with it.
      edges: flow.edges.filter((e) => e.from !== id && e.to !== id),
    });
```

And the markup, inside `.orch-body`:

```tsx
        <div className="orch-sect">
          <div className="orch-sect-hd">
            <span className="t">Agents</span>
            <span className="rule" />
          </div>
          <div
            data-testid="orch-tray"
            className={`orch-tray${over ? " over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); attach(e.dataTransfer.getData("text/plain")); }}
          >
            {flow.nodes.filter((n) => n.kind !== "notify").length === 0 ? (
              <span className="hint">Drag a card from the board to attach an agent.</span>
            ) : (
              flow.nodes
                .filter((n) => n.kind !== "notify")
                .map((n) => (
                  <span className="orch-tchip" key={n.id}>
                    <span className="k">{n.kind === "place" ? n.runKey : n.ticketKey}</span>
                    <span className="sub">{n.kind === "place" ? n.repo : "not taken"}</span>
                    <button
                      type="button"
                      className="rm"
                      aria-label={`Remove ${n.kind === "place" ? n.runKey : n.ticketKey}`}
                      onClick={() => removeNode(n.id)}
                    >
                      ✕
                    </button>
                  </span>
                ))
            )}
          </div>
        </div>
```

- [ ] **Step 5: Make a Deck card a drag source**

In `src/webview/DeckApp.tsx`, find the `Card` component (around line 182). Add to its outer `div`:

```tsx
      draggable={cardDragKey !== null}
      onDragStart={(e) => {
        if (cardDragKey) e.dataTransfer.setData("text/plain", cardDragKey);
      }}
```

and compute `cardDragKey` at the top of `Card` — a card is only draggable when it resolves to exactly one run key and repo, which is what a `place` node needs:

```tsx
  // Only a card that names one run and one repo can become a node: a place node
  // resolves to exactly one repo so no condition is ever ambiguous about which
  // repo's git or PR it means.
  const dragRepo = agent?.repo ?? (r.repos.length === 1 ? r.repos[0].name : undefined);
  const cardDragKey = dragRepo ? `${r.run.key}${DRAG_SEP}${dragRepo}` : null;
```

Import `DRAG_SEP` from `./OrchestratorDrawer`. Do **not** add any visible affordance to the card — the house rule forbids a persistent hint line, and a drag cursor is enough.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/webview/OrchestratorDrawer.test.tsx test/webview/DeckApp.test.tsx`
Expected: PASS.

- [ ] **Step 7: Typecheck, full suite, coverage**

Run: `npx tsc --noEmit`
Run: `npx vitest run`
Run: `npx vitest run --coverage`
Expected: green; `OrchestratorDrawer.tsx` ≥95%.

- [ ] **Step 8: Commit**

```bash
git add src/webview/OrchestratorDrawer.tsx src/webview/orchestratorStyles.ts src/webview/DeckApp.tsx test/webview/OrchestratorDrawer.test.tsx
git commit -m "feat(orchestrator): attach a board card to a flow by dragging it into the tray"
```

---

## Task 6: The canvas — nodes, dragging, and Tidy

**Files:**
- Modify: `src/webview/OrchestratorDrawer.tsx`
- Modify: `src/webview/orchestratorStyles.ts`
- Test: `test/webview/OrchestratorDrawer.test.tsx`

**Interfaces:**
- Consumes: `NODE_W`, `NODE_H`, `snap`, `tidy` from `../engine/orchestrator/layout` (Phase 1).
- Produces: the canvas element with test id `orch-canvas`, and a node element per node with test id `orch-node-<id>`. Task 7 adds ports to those nodes.

All geometry comes from `layout.ts`. Do not recompute a position, a grid snap or a layout by hand here — that module is unit-tested and this component must not grow a second copy of it.

- [ ] **Step 1: Write the failing tests**

Add to `test/webview/OrchestratorDrawer.test.tsx`:

```tsx
import { GRID } from "../../src/engine/orchestrator/layout";

const twoPlaces = () =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "agent-flow" },
      { id: "n2", kind: "place", x: 320, y: 24, join: "any", runKey: "ASM-2", repo: "bite-me" },
    ],
  });

describe("the canvas", () => {
  it("renders one node per flow node, positioned from the model", () => {
    render(<OrchestratorDrawer {...props({ flows: [twoPlaces()] })} />);
    const n1 = screen.getByTestId("orch-node-n1");
    expect(n1.style.left).toBe("24px");
    expect(n1.style.top).toBe("24px");
    expect(screen.getByTestId("orch-node-n2").style.left).toBe("320px");
  });

  it("shows a place node's key and repo", () => {
    render(<OrchestratorDrawer {...props({ flows: [twoPlaces()] })} />);
    const n1 = screen.getByTestId("orch-node-n1");
    expect(n1.textContent).toContain("ASM-1");
    expect(n1.textContent).toContain("agent-flow");
  });

  it("saves a snapped position after a node is dragged", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [twoPlaces()] })} />);
    const n1 = screen.getByTestId("orch-node-n1");
    fireEvent.pointerDown(n1, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 131, clientY: 100 });
    fireEvent.pointerUp(window);
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    const moved = saved.nodes.find((n) => n.id === "n1")!;
    // 24 + 31 = 55, snapped to the 8px grid.
    expect(moved.x % GRID).toBe(0);
    expect(moved.x).toBe(56);
  });

  it("does not save while the pointer is still down", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [twoPlaces()] })} />);
    fireEvent.pointerDown(screen.getByTestId("orch-node-n1"), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 0 });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not save when a drag ends where it started", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [twoPlaces()] })} />);
    fireEvent.pointerDown(screen.getByTestId("orch-node-n1"), { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Tidy re-lays-out and saves", () => {
    const onSave = vi.fn();
    const messy = flow({
      nodes: [
        { id: "n1", kind: "place", x: 900, y: 900, join: "any", runKey: "ASM-1", repo: "r" },
        { id: "n2", kind: "notify", x: 950, y: 950, join: "any", message: "done" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    });
    render(<OrchestratorDrawer {...props({ onSave, flows: [messy] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Tidy" }));
    const saved = onSave.mock.calls[0][0] as Flow;
    const a = saved.nodes.find((n) => n.id === "n1")!;
    const b = saved.nodes.find((n) => n.id === "n2")!;
    expect(b.x).toBeGreaterThan(a.x); // the target sits to the right of its source
    expect(a.x).toBeLessThan(900);
  });

  it("adds a notify node", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [twoPlaces()] })} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Notify" }));
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.nodes.filter((n) => n.kind === "notify")).toHaveLength(1);
  });

  it("a card dropped on the canvas lands where it was dropped", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [flow()] })} />);
    const canvas = screen.getByTestId("orch-canvas");
    fireEvent.drop(canvas, {
      dataTransfer: { getData: () => "ASM-7\0centaur", dropEffect: "copy" },
      clientX: 200, clientY: 150,
    });
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.nodes).toHaveLength(1);
    expect(saved.nodes[0].x % GRID).toBe(0);
  });
});
```

Note: jsdom reports zero-size rects, so a dropped position resolves against `clientX/Y` minus a zero origin. The assertions above therefore check grid alignment rather than an exact pixel, which is the property that actually matters.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/webview/OrchestratorDrawer.test.tsx`
Expected: FAIL — no element with test id `orch-canvas`.

- [ ] **Step 3: Add the canvas styles**

Append to `ORCH_CSS`:

```css
  /* The graph takes whatever height the tray and inspector leave. A canvas that
     scrolls the inspector out of view makes you scroll away from the thing you
     are editing to edit it. */
  .orch-graph { flex: 1; min-height: 180px; position: relative; overflow: hidden;
    border: 1px solid var(--hair); border-radius: var(--r-card);
    background: var(--vscode-editor-background);
    background-image: radial-gradient(color-mix(in srgb, var(--vscode-foreground) 13%, transparent) 1px, transparent 0);
    background-size: 16px 16px; }
  .orch-graph.over { border-color: var(--brand); }
  .orch-bar { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
  .orch-bar .sp { flex: 1; }

  /* 168px is enough for a state dot, the key, and the one fact the rules read.
     Narrower and a node degenerates into a bare key. */
  .orch-node { position: absolute; width: 168px; padding: 7px 9px; cursor: grab; user-select: none;
    border: 1px solid var(--hair); border-radius: var(--r-ctl);
    background: color-mix(in srgb, var(--vscode-foreground) 6%, var(--vscode-editor-background)); }
  .orch-node:hover { border-color: color-mix(in srgb, var(--vscode-foreground) 26%, transparent); }
  .orch-node.sel { border-color: var(--brand); box-shadow: 0 0 0 1px var(--brand); }
  /* Not taken yet: dashed, because the place does not exist until something
     launches it. A notify terminal is not a place at all, so it loses a place's
     chrome entirely. */
  .orch-node.plan { border-style: dashed; background: transparent; }
  .orch-node.notify { width: 138px; border-radius: 16px; }
  .orch-node .l1 { display: flex; align-items: center; gap: 6px; }
  .orch-node .l1 .d { width: 6px; height: 6px; border-radius: 50%; flex: none; }
  .orch-node .k { font-family: var(--mono); font-size: var(--t-data); }
  .orch-node .st { margin-top: 3px; font-size: var(--t-micro); color: var(--dim);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
```

- [ ] **Step 4: Add the canvas to the drawer**

Import the geometry:

```tsx
import { NODE_H, NODE_W, snap, tidy } from "../engine/orchestrator/layout";
import { AgentState } from "../types";
import { FlowNode } from "../engine/orchestrator/model";
```

Add a small helper above the component, so a node's dot colour comes from the board's own live state:

```tsx
/** A node's live state, from the card it points at. `undefined` when the node is
 * not a place, or its run is not on the board — the node is still drawn, just
 * without a claim about it. Takes the union directly so no cast is needed. */
function nodeState(node: FlowNode, runs: RunStatus[]): AgentState | undefined {
  if (node.kind !== "place") return undefined;
  return runs.find((r) => r.run.key === node.runKey)?.agent.state;
}

/** A notify node is narrower than a place. This must match `.orch-node.notify`'s
 * width in orchestratorStyles.ts — the anchor maths needs the real box, and the
 * two are the same number in two languages. */
const NOTIFY_W = 138;

const STATE_HUE: Record<AgentState, string> = {
  working: "var(--c-progress)",
  "needs-you": "var(--c-attn)",
  idle: "var(--c-idle)",
  unknown: "var(--dim)",
};
```

Inside the component, the drag machinery. One pointer handler, and a save only on release — a save per pointermove would be a disk write per pixel:

```tsx
  const graphRef = React.useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = React.useState<{ id: string; dx: number; dy: number; x: number; y: number } | null>(null);
  const [sel, setSel] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const box = graphRef.current?.getBoundingClientRect();
      const ox = box?.left ?? 0;
      const oy = box?.top ?? 0;
      setDrag((d) => (d ? { ...d, x: snap(e.clientX - ox - d.dx), y: snap(e.clientY - oy - d.dy) } : d));
    };
    const up = () => {
      setDrag((d) => {
        if (d) {
          const orig = flow.nodes.find((n) => n.id === d.id);
          // Only a move that actually moved is worth a write.
          if (orig && (orig.x !== d.x || orig.y !== d.y)) {
            p.onSave({ ...flow, nodes: flow.nodes.map((n) => (n.id === d.id ? { ...n, x: d.x, y: d.y } : n)) });
          }
        }
        return null;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, flow, p]);

  const startDrag = (id: string, e: React.PointerEvent) => {
    const node = flow.nodes.find((n) => n.id === id);
    if (!node) return;
    const box = graphRef.current?.getBoundingClientRect();
    setSel(id);
    setDrag({
      id,
      dx: e.clientX - (box?.left ?? 0) - node.x,
      dy: e.clientY - (box?.top ?? 0) - node.y,
      x: node.x,
      y: node.y,
    });
  };

  /** Where a node is right now — the in-flight drag position if it is the one
   * being dragged, else the model's. */
  const posOf = (n: { id: string; x: number; y: number }) =>
    drag && drag.id === n.id ? { x: drag.x, y: drag.y } : { x: n.x, y: n.y };

  const addNotify = () =>
    p.onSave({
      ...flow,
      nodes: [...flow.nodes, { id: nextNodeId(flow), kind: "notify", x: 320, y: 24, join: "any", message: "say something" }],
    });

  const onTidy = () => p.onSave({ ...flow, nodes: tidy(flow) });
```

And the markup, after the tray section, replacing the empty-state block:

```tsx
        <div className="orch-bar">
          <span className="t" style={{ fontSize: "var(--t-micro)", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--dim)" }}>
            Graph
          </span>
          <div className="sp" />
          <button type="button" className="orch-mini" onClick={onTidy}>Tidy</button>
          <button type="button" className="orch-mini" onClick={addNotify}>+ Notify</button>
        </div>
        <div
          ref={graphRef}
          data-testid="orch-canvas"
          className={`orch-graph${over ? " over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const box = graphRef.current?.getBoundingClientRect();
            attachAt(
              e.dataTransfer.getData("text/plain"),
              snap(e.clientX - (box?.left ?? 0) - NODE_W / 2),
              snap(e.clientY - (box?.top ?? 0) - NODE_H / 2),
            );
          }}
        >
          {flow.nodes.length === 0 && (
            <div className="orch-empty" style={{ border: 0, position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
              Drag a card from the board to add a node,<br />
              then connect two nodes to put a condition between them.
            </div>
          )}
          {flow.nodes.map((n) => {
            const pos = posOf(n);
            const st = nodeState(n, p.runs);
            return (
              <div
                key={n.id}
                data-testid={`orch-node-${n.id}`}
                className={`orch-node${n.kind === "planned" ? " plan" : ""}${n.kind === "notify" ? " notify" : ""}${sel === n.id ? " sel" : ""}`}
                style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
                onPointerDown={(e) => startDrag(n.id, e)}
              >
                <div className="l1">
                  <span className="d" style={{ background: st ? STATE_HUE[st] : "var(--dim)" }} />
                  <span className="k">
                    {n.kind === "place" ? n.runKey : n.kind === "planned" ? n.ticketKey : "notify"}
                  </span>
                </div>
                <div className="st">
                  {n.kind === "place" ? n.repo : n.kind === "planned" ? "not taken" : n.message}
                </div>
              </div>
            );
          })}
        </div>
```

Refactor `attach` from Task 5 into `attachAt(raw, x, y)` so both the tray and the canvas use one path, and have the tray call `attachAt(raw, 24, 24 + flow.nodes.length * 88)`:

```tsx
  const attachAt = (raw: string, x: number, y: number) => {
    const parsed = parseDrag(raw);
    if (!parsed) return;
    const dup = flow.nodes.some((n) => n.kind === "place" && n.runKey === parsed.runKey && n.repo === parsed.repo);
    if (dup) return;
    p.onSave({
      ...flow,
      nodes: [...flow.nodes, { id: nextNodeId(flow), kind: "place", x, y, join: "any", ...parsed }],
    });
  };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/webview/OrchestratorDrawer.test.tsx`
Expected: PASS, including Task 5's tray tests, which now route through `attachAt`.

- [ ] **Step 6: Typecheck, full suite, coverage**

Run: `npx tsc --noEmit`
Run: `npx vitest run`
Run: `npx vitest run --coverage`
Expected: green; `OrchestratorDrawer.tsx` ≥95%.

- [ ] **Step 7: Commit**

```bash
git add src/webview/OrchestratorDrawer.tsx src/webview/orchestratorStyles.ts test/webview/OrchestratorDrawer.test.tsx
git commit -m "feat(orchestrator): draw the flow on a canvas with draggable nodes and Tidy"
```

---

## Task 7: Wiring — ports, edges, and the connectors between them

**Files:**
- Modify: `src/webview/OrchestratorDrawer.tsx`
- Modify: `src/webview/orchestratorStyles.ts`
- Test: `test/webview/OrchestratorDrawer.test.tsx`

**Interfaces:**
- Consumes: `anchor`, `edgePath`, `labelPoint`, `NODE_W`, `NODE_H` from `../engine/orchestrator/layout`.
- Produces: an SVG path per edge and a clickable label per edge with test id `orch-edge-<id>`. Task 8's inspector edits the selected edge.

Every new edge gets `action: "notify"` and `cond: { kind: "pr-merged" }`. `launch` and `seed` do not exist in this phase, so the inspector must not offer them.

An edge must be drawn with `edgePath` from `layout.ts`, and its label placed with `labelPoint` — but rendered **above** the midpoint, because a label as wide as the gap between two columns hides the connector it labels.

- [ ] **Step 1: Write the failing tests**

Add to `test/webview/OrchestratorDrawer.test.tsx`:

```tsx
const wired = () =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "agent-flow" },
      { id: "n2", kind: "notify", x: 320, y: 24, join: "any", message: "landed" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
  });

describe("wiring", () => {
  it("draws one connector per edge", () => {
    const { container } = render(<OrchestratorDrawer {...props({ flows: [wired()] })} />);
    expect(container.querySelectorAll("svg path")).toHaveLength(1);
  });

  it("labels the connector with the condition, and the label is clickable", () => {
    render(<OrchestratorDrawer {...props({ flows: [wired()] })} />);
    const label = screen.getByTestId("orch-edge-e1");
    expect(label.textContent).toMatch(/merged/i);
  });

  it("creates a notify edge by dragging from a port onto another node", () => {
    const onSave = vi.fn();
    const two = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "r" },
        { id: "n2", kind: "place", x: 320, y: 24, join: "any", runKey: "ASM-2", repo: "r2" },
      ],
    });
    render(<OrchestratorDrawer {...props({ onSave, flows: [two] })} />);
    fireEvent.pointerDown(screen.getByTestId("orch-port-out-n1"));
    fireEvent.pointerUp(screen.getByTestId("orch-node-n2"));
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.edges).toEqual([
      expect.objectContaining({ from: "n1", to: "n2", action: "notify", cond: { kind: "pr-merged" } }),
    ]);
  });

  it("refuses an edge from a node to itself", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [wired()] })} />);
    fireEvent.pointerDown(screen.getByTestId("orch-port-out-n1"));
    fireEvent.pointerUp(screen.getByTestId("orch-node-n1"));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("refuses a duplicate edge between the same two nodes", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [wired()] })} />);
    fireEvent.pointerDown(screen.getByTestId("orch-port-out-n1"));
    fireEvent.pointerUp(screen.getByTestId("orch-node-n2"));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("a notify node has no outgoing port — nothing follows a terminal", () => {
    render(<OrchestratorDrawer {...props({ flows: [wired()] })} />);
    expect(screen.queryByTestId("orch-port-out-n2")).toBeNull();
  });

  it("releasing a wire on empty canvas creates nothing", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [wired()] })} />);
    fireEvent.pointerDown(screen.getByTestId("orch-port-out-n1"));
    fireEvent.pointerUp(screen.getByTestId("orch-canvas"));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("dragging from a port does not also drag the node", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [wired()] })} />);
    fireEvent.pointerDown(screen.getByTestId("orch-port-out-n1"), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 90, clientY: 60 });
    fireEvent.pointerUp(screen.getByTestId("orch-canvas"));
    // No node moved, so nothing was saved.
    expect(onSave).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/webview/OrchestratorDrawer.test.tsx`
Expected: FAIL — no `orch-port-out-n1`.

- [ ] **Step 3: Add the port and edge styles**

Append to `ORCH_CSS`:

```css
  .orch-port { position: absolute; width: 10px; height: 10px; top: 50%; margin-top: -5px;
    border: 1px solid var(--edge); border-radius: 50%; cursor: crosshair;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); }
  .orch-port.out { right: -6px; }
  .orch-port.in { left: -6px; }
  .orch-port:hover { background: var(--brand); border-color: var(--brand); }
  /* While a wire is being drawn, every legal target announces itself. */
  .orch-graph.wiring .orch-node:not(.src) { border-color: color-mix(in srgb, var(--brand) 45%, var(--hair)); }
  .orch-graph.wiring .orch-node:not(.src) .orch-port.in { background: var(--brand); border-color: var(--brand); }

  .orch-graph svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }

  /* Sits ABOVE the midpoint, not on it: centred, a label as wide as the gap
     between two columns hides the whole connector it is labelling. */
  .orch-edge { position: absolute; transform: translate(-50%, -150%); white-space: nowrap; cursor: pointer;
    padding: 1px 6px; border: 1px solid var(--hair); border-radius: var(--r-chip);
    font-size: var(--t-micro); color: var(--dim);
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); }
  .orch-edge:hover { color: var(--vscode-foreground); border-color: var(--edge); }
  .orch-edge.sel { border-color: var(--brand); color: var(--vscode-foreground); }
  /* Danger tint only when the CONDITION is itself a failure — not decoration. */
  .orch-edge.bad { border-color: color-mix(in srgb, var(--c-danger) 40%, var(--hair)); }
`;
```

- [ ] **Step 4: Add wiring to the drawer**

Import the geometry and the condition labels:

```tsx
import { anchor, edgePath, labelPoint } from "../engine/orchestrator/layout";
import { Condition, FlowEdge } from "../engine/orchestrator/model";
```

Add, above the component, the human wording for a condition and the set that reads as a failure:

```tsx
/** The drawer's own wording for a condition. `describeCond` says what a place
 * currently looks like; this says what the rule is. Both are needed and they are
 * not the same sentence. */
export const COND_LABEL: Record<Condition["kind"], string> = {
  "pr-merged": "PR is merged",
  "ci-passed": "CI passed",
  "ci-failed": "CI failed",
  "review-approved": "review approved",
  "changes-requested": "changes requested",
  "threads-resolved": "0 unresolved threads",
  "pr-conflicting": "branch conflicts",
  "agent-ended-turn": "agent ended its turn",
  "agent-idle-over": "agent idle over…",
  "no-agent-left": "no agent left",
  "tree-clean": "tree is clean",
  "has-uncommitted": "has uncommitted work",
  "nothing-to-push": "nothing to push",
  "ticket-done": "ticket reached done",
  "ticket-status-is": "ticket status is…",
};

/** Conditions that describe something being wrong. The only edges allowed a
 * danger tint — colour here is attention debt, not decoration. */
const BAD_CONDS = new Set<Condition["kind"]>(["ci-failed", "changes-requested", "pr-conflicting"]);

/** What the inspector offers. `agent-idle-over` and `ticket-status-is` each carry
 * a parameter (a minute count, a status name) and this phase has no input for
 * one — offering them would create a rule waiting on a fixed 10 minutes or on the
 * empty string, which never matches. They stay in `COND_LABEL` because a flow
 * hand-edited on disk can still hold one and its edge must still render. */
export const OFFERED_CONDS: Condition["kind"][] = (
  Object.keys(COND_LABEL) as Condition["kind"][]
).filter((k) => k !== "agent-idle-over" && k !== "ticket-status-is");
```

Inside the component:

```tsx
  const [wiring, setWiring] = React.useState<string | null>(null);
  const [selEdge, setSelEdge] = React.useState<string | null>(null);

  const boxOf = (n: { id: string; x: number; y: number; kind: string }) => {
    const pos = posOf(n);
    return { x: pos.x, y: pos.y, w: n.kind === "notify" ? NOTIFY_W : NODE_W, h: NODE_H };
  };

  const finishWire = (toId: string) => {
    const from = wiring;
    setWiring(null);
    if (!from || from === toId) return;
    if (flow.edges.some((e) => e.from === from && e.to === toId)) return;
    const id = `e${flow.edges.length + 1}`;
    const edge: FlowEdge = { id, from, to: toId, cond: { kind: "pr-merged" }, action: "notify" };
    setSelEdge(id);
    p.onSave({ ...flow, edges: [...flow.edges, edge] });
  };
```

Add `wiring` to the graph's class list (`${wiring ? " wiring" : ""}`), add `onPointerUp={() => setWiring(null)}` to the graph div so a release on empty canvas cancels, and add `src` to the source node's class list (`${wiring === n.id ? " src" : ""}`).

Add ports inside each node's markup, and stop them starting a node drag:

```tsx
                <span
                  className="orch-port in"
                  data-testid={`orch-port-in-${n.id}`}
                  onPointerDown={(e) => e.stopPropagation()}
                />
                {n.kind !== "notify" && (
                  <span
                    className="orch-port out"
                    data-testid={`orch-port-out-${n.id}`}
                    onPointerDown={(e) => { e.stopPropagation(); setWiring(n.id); }}
                  />
                )}
```

Add `onPointerUp={() => wiring && finishWire(n.id)}` to each node div.

Render the connectors inside the graph, before the nodes so they sit underneath:

```tsx
          <svg>
            {flow.edges.map((e) => {
              const a = flow.nodes.find((n) => n.id === e.from);
              const b = flow.nodes.find((n) => n.id === e.to);
              if (!a || !b) return null;
              const from = anchor(boxOf(a), "out");
              const to = anchor(boxOf(b), "in");
              const bad = BAD_CONDS.has(e.cond.kind);
              const on = selEdge === e.id;
              return (
                <path
                  key={e.id}
                  d={edgePath(from, to)}
                  fill="none"
                  strokeWidth={on ? 1.8 : 1.4}
                  strokeDasharray={bad ? "4 3" : undefined}
                  stroke={bad ? "var(--c-danger)" : on ? "var(--brand)" : "var(--edge)"}
                />
              );
            })}
          </svg>
```

And the labels, after the nodes so they sit on top:

```tsx
          {flow.edges.map((e) => {
            const a = flow.nodes.find((n) => n.id === e.from);
            const b = flow.nodes.find((n) => n.id === e.to);
            if (!a || !b) return null;
            const mid = labelPoint(anchor(boxOf(a), "out"), anchor(boxOf(b), "in"));
            return (
              <button
                type="button"
                key={e.id}
                data-testid={`orch-edge-${e.id}`}
                className={`orch-edge${selEdge === e.id ? " sel" : ""}${BAD_CONDS.has(e.cond.kind) ? " bad" : ""}`}
                style={{ left: `${mid.x}px`, top: `${mid.y}px` }}
                onClick={() => setSelEdge(e.id)}
              >
                {COND_LABEL[e.cond.kind]}
              </button>
            );
          })}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/webview/OrchestratorDrawer.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck, full suite, coverage**

Run: `npx tsc --noEmit`
Run: `npx vitest run`
Run: `npx vitest run --coverage`
Expected: green; `OrchestratorDrawer.tsx` ≥95%.

- [ ] **Step 7: Commit**

```bash
git add src/webview/OrchestratorDrawer.tsx src/webview/orchestratorStyles.ts test/webview/OrchestratorDrawer.test.tsx
git commit -m "feat(orchestrator): wire two nodes together by dragging from a port"
```

---

## Task 8: The inspector — edit the selected edge

**Files:**
- Modify: `src/webview/OrchestratorDrawer.tsx`
- Modify: `src/webview/orchestratorStyles.ts`
- Test: `test/webview/OrchestratorDrawer.test.tsx`

**Interfaces:**
- Consumes: `describeCond`, `CondContext` from `../engine/orchestrator/conditions`; `COND_LABEL` (Task 7).
- Produces: nothing further tasks depend on. This is the last task of the phase.

The inspector is where Phase 1's `describeCond` finally reaches a user: under the condition dropdown it says what the place looks like **right now**, so a flow that is waiting explains itself instead of just sitting there.

`describeCond` needs a `RunStatus` and a repo. Resolve them from `p.runs` and the source node. When the run is not on the board, say so rather than guessing.

- [ ] **Step 1: Write the failing tests**

Add to `test/webview/OrchestratorDrawer.test.tsx`. This needs a `RunStatus` fixture — build a minimal one:

```tsx
import type { PrEntryMap, RunStatus } from "../../src/types";

const runStatus = (key: string, repo: string, over: Partial<RunStatus> = {}): RunStatus => {
  const prs: PrEntryMap = {
    [repo]: {
      facts: {
        number: 118, url: "u", title: "t", state: "OPEN", isDraft: false,
        ci: { passing: 4, pending: 3, failing: [] }, review: "none", unresolved: null,
        mergeable: "clean", ciAdvisory: false,
      },
      fetchedAt: 1,
    },
  };
  return {
    run: { key, summary: "s", url: `https://j/browse/${key}`, createdAt: 1, mode: "multiroot",
      repos: [{ name: repo, path: `/r/${repo}`, isGit: true }], briefPaths: [] },
    column: "progress", jiraStatus: "In Progress", jiraCategory: "indeterminate",
    repos: [{ name: repo, path: `/r/${repo}`, branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 }],
    agent: { state: "working", lastActivityMs: 1, slug: null },
    windowOpen: true, prs, agents: [], ...over,
  };
};

describe("the inspector", () => {
  const open = (onSave = vi.fn(), runs: RunStatus[] = []) => {
    const r = render(<OrchestratorDrawer {...props({ onSave, runs, flows: [wired()] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    return { r, onSave };
  };

  it("says to select an edge when none is selected", () => {
    render(<OrchestratorDrawer {...props({ flows: [wired()] })} />);
    expect(screen.getByText(/select a connection/i)).toBeTruthy();
  });

  it("names the two ends of the selected edge", () => {
    open();
    const insp = screen.getByTestId("orch-inspector");
    expect(insp.textContent).toContain("ASM-1");
  });

  it("changes the condition", () => {
    const { onSave } = open();
    fireEvent.change(screen.getByLabelText("Condition"), { target: { value: "ci-failed" } });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges[0].cond).toEqual({ kind: "ci-failed" });
  });

  it("offers no launch or seed action — those do not exist yet", () => {
    open();
    const insp = screen.getByTestId("orch-inspector");
    expect(insp.textContent).not.toMatch(/launch|seed/i);
  });

  it("does not offer a condition it has no input for", () => {
    // agent-idle-over needs a minute count and ticket-status-is needs a status
    // name; with no field for either, offering them would build a rule that waits
    // on a hardcoded 10 minutes or on the empty string.
    open();
    const values = Array.from(
      screen.getByLabelText("Condition").querySelectorAll("option"),
    ).map((o) => (o as HTMLOptionElement).value);
    expect(values).not.toContain("agent-idle-over");
    expect(values).not.toContain("ticket-status-is");
    expect(values).toContain("pr-merged");
  });

  it("edits the notify message on blur", () => {
    const { onSave } = open();
    const box = screen.getByLabelText("Notify message");
    fireEvent.change(box, { target: { value: "the migration has landed" } });
    fireEvent.blur(box);
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    const target = saved.nodes.find((n) => n.id === "n2")!;
    expect(target).toMatchObject({ kind: "notify", message: "the migration has landed" });
  });

  it("shows what the place currently looks like, from the board", () => {
    open(vi.fn(), [runStatus("ASM-1", "agent-flow")]);
    // 4 of 7 checks reported: describeCond's own wording, reaching a user for
    // the first time.
    expect(screen.getByTestId("orch-inspector").textContent).toContain("CI running, 4 of 7");
  });

  it("says the card is not on the board when the run is absent", () => {
    open(vi.fn(), []);
    expect(screen.getByTestId("orch-inspector").textContent).toMatch(/not on the board/i);
  });

  it("deletes the edge", () => {
    const { onSave } = open();
    fireEvent.click(screen.getByRole("button", { name: "Delete connection" }));
    expect((onSave.mock.calls.at(-1)![0] as Flow).edges).toEqual([]);
  });

  it("stops showing an inspector once the edge is gone", () => {
    const { r } = open();
    r.rerender(<OrchestratorDrawer {...props({ flows: [flow({ nodes: wired().nodes, edges: [] })] })} />);
    expect(screen.getByText(/select a connection/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/webview/OrchestratorDrawer.test.tsx`
Expected: FAIL — no `orch-inspector`.

- [ ] **Step 3: Add the inspector styles**

Append to `ORCH_CSS`:

```css
  .orch-insp { flex: none; margin-top: 10px; padding: 10px 11px;
    border: 1px solid var(--hair); border-radius: var(--r-card);
    background: var(--vscode-editor-background); }
  .orch-insp.none { text-align: center; color: var(--dim); font-size: var(--t-body); padding: 16px 11px; }
  .orch-insp .t { display: flex; align-items: center; gap: 7px; margin-bottom: 8px;
    font-size: var(--t-micro); letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  .orch-insp .t .sp { flex: 1; }
  .orch-clause { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .orch-clause + .orch-clause { margin-top: 6px; }
  /* Three fixed-width keywords, so a rule reads as a sentence and not a form. */
  .orch-kw { width: 40px; flex: none; font-size: var(--t-micro); letter-spacing: .06em; color: var(--dim); }
  .orch-sel { height: 22px; padding: 0 7px; border-radius: var(--r-chip);
    border: 1px solid var(--edge); background: var(--vscode-input-background);
    color: var(--vscode-foreground); font: inherit; font-size: var(--t-body); cursor: pointer; }
  .orch-msg { flex: 1; min-width: 120px; height: 22px; padding: 0 7px; border-radius: var(--r-chip);
    border: 1px solid var(--edge); background: var(--vscode-input-background);
    color: var(--vscode-foreground); font: inherit; font-size: var(--t-body); }
  .orch-obs { margin-top: 8px; padding-top: 7px; border-top: 1px solid var(--hair);
    font-size: var(--t-micro); color: var(--dim); }
```

- [ ] **Step 4: Add the inspector**

Import:

```tsx
import { describeCond } from "../engine/orchestrator/conditions";
```

Inside the component, above the return:

```tsx
  const edge = flow.edges.find((e) => e.id === selEdge) ?? null;

  /** What the source place looks like right now, in `describeCond`'s words. Null
   * when the node's run is not on the board — a claim we cannot make. */
  const observation = (e: FlowEdge): string | null => {
    const from = flow.nodes.find((n) => n.id === e.from);
    if (!from || from.kind !== "place") return null;
    const status = p.runs.find((r) => r.run.key === from.runKey);
    if (!status) return null;
    return describeCond(e.cond, { status, repo: from.repo, nowMs: Date.now() });
  };

  const setCond = (e: FlowEdge, kind: Condition["kind"]) => {
    // Only bare kinds are reachable from the dropdown (see OFFERED_CONDS), so the
    // parameterised arms cannot be constructed here without a value to put in them.
    if (kind === "agent-idle-over" || kind === "ticket-status-is") return;
    const cond: Condition = { kind };
    p.onSave({ ...flow, edges: flow.edges.map((x) => (x.id === e.id ? { ...x, cond } : x)) });
  };

  const setNotifyMessage = (e: FlowEdge, message: string) =>
    p.onSave({
      ...flow,
      nodes: flow.nodes.map((n) => (n.id === e.to && n.kind === "notify" ? { ...n, message } : n)),
    });

  const deleteEdge = (e: FlowEdge) => {
    setSelEdge(null);
    p.onSave({ ...flow, edges: flow.edges.filter((x) => x.id !== e.id) });
  };
```

And the markup, after the graph div:

```tsx
        {!edge ? (
          <div className="orch-insp none" data-testid="orch-inspector">
            Select a connection to set its condition.
          </div>
        ) : (
          <div className="orch-insp" data-testid="orch-inspector">
            <div className="t">
              <span>
                Connection ·{" "}
                <span className="k" style={{ fontFamily: "var(--mono)" }}>{endLabel(flow, edge.from)}</span>
                {" → "}
                <span className="k" style={{ fontFamily: "var(--mono)" }}>{endLabel(flow, edge.to)}</span>
              </span>
              <span className="sp" />
              <button type="button" className="orch-mini" aria-label="Delete connection" onClick={() => deleteEdge(edge)}>
                Delete
              </button>
            </div>
            <div className="orch-clause">
              <span className="orch-kw">WHEN</span>
              <select
                className="orch-sel"
                aria-label="Condition"
                value={edge.cond.kind}
                onChange={(ev) => setCond(edge, ev.currentTarget.value as Condition["kind"])}
              >
                {OFFERED_CONDS.map((k) => (
                  <option key={k} value={k}>{COND_LABEL[k]}</option>
                ))}
              </select>
            </div>
            <div className="orch-clause">
              <span className="orch-kw">THEN</span>
              {/* notify is the only action this phase has. It is stated, not
                  offered as a choice of one. */}
              <span style={{ fontSize: "var(--t-body)" }}>notify me</span>
              <input
                className="orch-msg"
                aria-label="Notify message"
                key={edge.id}
                defaultValue={notifyMessageOf(flow, edge)}
                onBlur={(ev) => setNotifyMessage(edge, ev.currentTarget.value)}
              />
            </div>
            <div className="orch-obs">
              {observation(edge) ?? "this card is not on the board right now"}
            </div>
          </div>
        )}
```

Add the two small helpers above the component:

```tsx
/** How a node's end reads in the inspector's title. */
function endLabel(flow: Flow, id: string): string {
  const n = flow.nodes.find((x) => x.id === id);
  if (!n) return "?";
  return n.kind === "place" ? n.runKey : n.kind === "planned" ? n.ticketKey : "notify";
}

/** The message the edge's notify target carries, or empty when the target is
 * not a notify node. */
function notifyMessageOf(flow: Flow, e: FlowEdge): string {
  const n = flow.nodes.find((x) => x.id === e.to);
  return n && n.kind === "notify" ? n.message : "";
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/webview/OrchestratorDrawer.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck, whole suite, coverage**

Run: `npx tsc --noEmit`
Run: `npx vitest run`
Run: `npx vitest run --coverage`
Expected: green; `OrchestratorDrawer.tsx` ≥95% lines, and every file this phase touched at ≥95%.

- [ ] **Step 7: Update the README — both places**

`README.md` documents settings twice, and both need the new one.

**(a) The settings table**, around line 276, one row per setting with its default. Add a row in the same three-column format, placed to match the table's existing ordering:

```markdown
| `agentFlow.orchestrator` | `false` | Show the Deck's Orchestrator drawer, where you wire in-flight agents into a flow with a condition on each connection. |
```

**(b) The Deck's prose section**, which documents each toggle and strip. Add a paragraph after the PR-facts paragraph, in the same voice — plain prose, no marketing:

```markdown
An **Orchestrator** drawer (off by default, `agentFlow.orchestrator`) lets you wire the
agents already on the board into a *flow*: drag a card in, connect two nodes, and put a
condition on the connection — a merged PR, failing CI, an agent that ended its turn, a
clean tree, a Jira status. Each connection can currently **notify** you, and the drawer
says what each condition is waiting on right now. Nothing runs on its own yet: arming a
flow, and letting it launch the next agent for you, lands in a following release.
```

- [ ] **Step 8: Commit**

```bash
git add src/webview/OrchestratorDrawer.tsx src/webview/orchestratorStyles.ts README.md test/webview/OrchestratorDrawer.test.tsx
git commit -m "feat(orchestrator): add the edge inspector and document the drawer"
```

---

## Done when

- The `agentFlow.orchestrator` setting exists, ships **off**, and appears in `config.ts`, `package.json`, `events.ts`, `settingsSnapshot.ts` and `docs/TELEMETRY.md`.
- With it on, the Deck header shows an `⚡ Orchestrator` chip; pressing it with no flows creates one and opens the drawer.
- You can name a flow, drag a card from the board into the tray or onto the canvas, drag nodes around, press Tidy, add a notify node, wire two nodes by dragging from a port, select a connection, change its condition, edit its message, and delete it — and every one of those survives closing and reopening the panel.
- The inspector shows `describeCond`'s live wording for the selected connection.
- There is **no** Arm control anywhere, and no `launch` or `seed` action is reachable.
- `npx tsc --noEmit` clean, `npx vitest run` green, every touched file ≥95% line coverage.
- `git diff main --stat` touches nothing outside the files this plan names.

## What Phase 2b picks up

`src/orchestratorRunner.ts`, the Arm control and the `armed` flag actually meaning something, the poll change in `deckView.ts` so a hidden Deck keeps evaluating while a flow is armed, the close confirmation, and the toasts. `evaluateFlow`'s `EvalResult` is the seam. Two things Phase 1's review established that 2b must honour: the runner computes "stalled" itself from `flow.edges.some(e => e.error)`, because an errored `all` junction deliberately reports nothing; and a place's agent state must always come from `placeActivity`, never from `RunStatus.agent` directly.
