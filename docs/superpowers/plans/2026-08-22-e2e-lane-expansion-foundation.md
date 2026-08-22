# E2E Lane Expansion — Foundation & Read-Only Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared-host harness, the page-object layer and the repeatable sabotage gate, then land three real-host journeys over the sidebar's actions, the Notepad and the Marketplace — the surfaces that today have zero real-editor coverage.

**Architecture:** Everything rides the existing harness in `test-e2e/_helpers/`. Two new ideas: (1) **one Electron boot per file** for surfaces whose actions are local or append-only, via a `describeWithHost` wrapper that forces serial mode — grouping three surfaces into three boots instead of ten; (2) **page objects** that centralise the CSS selectors nine journeys currently inline, so a class rename is a one-file repair. The fixture connector gains two capabilities so the sidebar's sprint and component lenses render at all.

**Tech Stack:** existing pins only — `@playwright/test@1.49.1`, `@vscode/test-electron@2.4.1`, VS Code 1.96.2, Claude Code 2.1.238. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-22-e2e-lane-expansion-design.html` (§4 harness, §5 fixture, §6.1 journeys, §7.1 sabotage). Sections §6.2, §7.2, §7.3, §8 and §9 are Plan 2 — see "Next increment".

## Global Constraints

Every task's requirements implicitly include this section.

- **`npm run typecheck` clean** · **`npm test` passes UNMODIFIED** (~4,700 tests across 122 files; pass `timeout: 600000`; **never pipe vitest through `tail`/`head`** — it loses the failure list) · **`npm run build` succeeds** (a real gate: esbuild resolves statically, so any module reachable from a browser entry that imports `fs`/`os`/`path`/`child_process` breaks it even if never executed) · **`npm run test:cov` thresholds hold** (90% lines/statements, 85% branches/functions) · **`npm run test:ct` passes** · **`npm run test:e2e` passes** (11 existing + new).
- **A single failure under CPU contention is usually flake, not a regression** — re-run that file alone before believing it. Never let two vitest runs overlap.
- **E2E asserts the built bundle.** `npm run test:e2e` builds first; a bare `npx playwright test -c playwright-e2e.config.ts` does **not**. Always rebuild before a sabotage check.
- **Exactly one `src/` change is authorised in this plan:** Task 3, the fixture connector. Any other journey needing product change is a **stop-and-surface**, not a quiet edit.
- **Never break existing users.** `test/unit/compat.test.ts` freezes the released surface. A test you had to edit to go green is the signal to stop.
- **Vocabulary.** A *session* is one run of a coding tool; an *agent* is a worker a session delegates to. `test/unit/vocabulary.test.ts` enforces this — identifiers keep their released spelling (`agents` in code, "sessions" in UI copy).
- **Screenshots via `shot(page, testInfo, label)`** so `scripts/verify-report.mjs` picks them up into the verify-feature strip.
- **Every new journey ships with a sabotage patch** (Task 7) and must be observed failing under it.
- **Lockfile hygiene:** `grep -c codeartifact package-lock.json` → 0. The public registry is pinned in `.npmrc`; a private-registry global config must never reach `package-lock.json` or CI fails with `E401`.
- **Commit frequently** — one commit per task minimum. Mutation-checking only means anything against committed work: the `git checkout` that restores a mutant also reverts an uncommitted fix.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `test-e2e/_helpers/sharedHost.ts` | `describeWithHost` — one Electron boot per file, serial mode, disposed in `afterAll` |
| `test-e2e/_helpers/po/pool.ts` | Page object for the sidebar (tasks pool + notepad tab) |
| `test-e2e/_helpers/po/marketplace.ts` | Page object for the Marketplace webview |
| `test-e2e/sidebar-actions.e2e.ts` | Detail panel · label add · sprint add/remove · component set · reorder + reset · Explore |
| `test-e2e/notepad.e2e.ts` | Notepad CRUD, sections, real drag-reorder, `notepad:run` |
| `test-e2e/marketplace.e2e.ts` | Agents/commands listing, read, copy toast, open |
| `scripts/sabotage.mjs` | Apply patch → rebuild → run one journey → require failure → revert → prove clean |
| `test-e2e/sabotage/*.patch` | One mutation per journey |

**Modified:** `src/tasks/fixture/connector.ts` (Task 3, the one authorised `src/` change) · `test-e2e/_helpers/sandbox.ts` (child record, sprint/component fixture data, `.claude/` seeding) · `test/unit/tasks/fixtureConnector.test.ts` (capability + gate coverage) · `package.json` (the `sabotage` script) · `CONTRIBUTING.md` (documents the two new commands).

---

### Task 1: `describeWithHost` — one boot per file

**Files:**
- Create: `test-e2e/_helpers/sharedHost.ts`
- Test: proven by first use in Task 5; no unit test (it is harness plumbing whose only consumer is Playwright)

**Interfaces:**
- Consumes: `makeSandbox`, `Sandbox` (`./sandbox`), `launchHost` (`./host`).
- Produces: `describeWithHost(title: string, settings: Record<string, unknown>, fn: (ctx: HostCtx) => void): void` and `interface HostCtx { page(): Page; sb(): Sandbox }`.

- [ ] **Step 1: Write the helper**

Create `test-e2e/_helpers/sharedHost.ts`:

```ts
import { test, type ElectronApplication, type Page } from "@playwright/test";
import { makeSandbox, type Sandbox } from "./sandbox";
import { launchHost } from "./host";

/** What a grouped journey's tests read. Accessors, not values: the host does
 *  not exist yet when `fn` runs (Playwright collects the describe body before
 *  `beforeAll` fires), so a captured value would always be undefined. */
export interface HostCtx {
  page(): Page;
  sb(): Sandbox;
}

/** One Electron boot shared by every `test()` in the block.
 *
 *  Only for surfaces whose actions are LOCAL (the Notepad's globalState, the
 *  Marketplace's reads) or APPEND-ONLY (`writes.jsonl` — each test asserts the
 *  line IT appended, by op and key, never the whole file). Anything that opens
 *  a window, creates a worktree or writes a run record must keep using
 *  `launchHost` per test: those mutate state a sibling test would inherit.
 *
 *  Serial mode is not an optimisation — it is the failure contract. Without it
 *  a failed test leaves a half-mutated host and every sibling reports a
 *  phantom failure; with it, they skip and the report names one real cause. */
export function describeWithHost(
  title: string,
  settings: Record<string, unknown>,
  fn: (ctx: HostCtx) => void,
): void {
  test.describe(title, () => {
    test.describe.configure({ mode: "serial" });

    let sb: Sandbox | undefined;
    let app: ElectronApplication | undefined;
    let page: Page | undefined;

    test.beforeAll(async () => {
      sb = makeSandbox(settings);
      const launched = await launchHost(sb);
      app = launched.app;
      page = launched.page;
    });

    test.afterAll(async () => {
      await app?.close();
      app = undefined;
      page = undefined;
      sb?.dispose();
      sb = undefined;
    });

    fn({
      page: () => {
        if (!page) throw new Error("describeWithHost: page read outside a test body");
        return page;
      },
      sb: () => {
        if (!sb) throw new Error("describeWithHost: sandbox read outside a test body");
        return sb;
      },
    });
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean. (`sharedHost.ts` is under `test-e2e/`, which no browser entry point can reach, so its `child_process`-importing dependencies are fine.)

- [ ] **Step 3: Commit**

```bash
git add test-e2e/_helpers/sharedHost.ts
git commit -m "test(e2e): add describeWithHost for one-boot-per-file groups"
```

---

### Task 2: Page objects for the pool and the Marketplace

**Files:**
- Create: `test-e2e/_helpers/po/pool.ts`, `test-e2e/_helpers/po/marketplace.ts`
- Test: proven by first use in Tasks 4–6

**Interfaces:**
- Consumes: `tasksFrame`, `openTasksView` (`../host`).
- Produces: `class Pool` and `class Marketplace`, constructed from a `Page`.

**Verified selectors** (read from `src/webview/App.tsx` and `src/webview/Notepad.tsx` on 2026-08-22 — do not guess these, they are checked):
`.card` · `.card-check` · `.batch-bar` · `.repo-select-trigger` · `.repo-opt` · the Notepad tab is `button[role="tab"]` with text `Notepad` · `.notepad` · `.np-item` · `.np-title-input` · `.np-body-input` · `.np-add-btn` · `.np-clear` · `.np-section` · `.np-section-add-btn` · `.np-section-input` · `.np-section-name` · `.np-list` · `.grip` · `.cb`.

- [ ] **Step 1: Write the pool page object**

Create `test-e2e/_helpers/po/pool.ts`:

```ts
import { expect, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { openTasksView, tasksFrame } from "../host";

/** The sidebar webview, addressed by intent rather than by CSS class.
 *
 *  Every selector the journeys used to inline lives HERE and nowhere else: a
 *  webview class rename is then a one-file repair instead of a nine-file hunt.
 *  When a locator stops matching, fix it here and read the real class from the
 *  component named in the comment — never work around it in a journey. */
export class Pool {
  readonly frame: FrameLocator;

  constructor(private readonly page: Page) {
    this.frame = tasksFrame(page);
  }

  /** Click the activity-bar item and wait for the pool to render `n` cards. */
  static async open(page: Page, n: number): Promise<Pool> {
    await openTasksView(page);
    const pool = new Pool(page);
    await expect(pool.cards()).toHaveCount(n, { timeout: 30_000 });
    return pool;
  }

  cards(): Locator {
    return this.frame.locator(".card");
  }

  /** One card, addressed by ticket key (the key is rendered inside the card). */
  card(key: string): Locator {
    return this.frame.locator(".card", { hasText: key });
  }

  /** Drive the repo multiselect. Batch mode only surfaces once a repo is
   *  selected (App.tsx) — every batch-shaped journey starts here. */
  async selectRepo(name: string): Promise<void> {
    await this.frame.locator(".repo-select-trigger").click();
    await this.frame.locator(".repo-opt", { hasText: name }).click();
    await this.page.keyboard.press("Escape"); // close the popover; the selection sticks
  }

  /** Switch to the Notepad tab. Role-based, so it survives a class rename. */
  async openNotepad(): Promise<void> {
    await this.frame.getByRole("tab", { name: "Notepad" }).click();
    await expect(this.frame.locator(".notepad")).toBeVisible();
  }

  async openTasksTab(): Promise<void> {
    await this.frame.getByRole("tab", { name: "Tasks" }).click();
  }

  notes(): Locator {
    return this.frame.locator(".np-item");
  }

  note(title: string): Locator {
    return this.frame.locator(".np-item", { hasText: title });
  }

  sections(): Locator {
    return this.frame.locator(".np-section");
  }
}
```

- [ ] **Step 2: Write the Marketplace page object**

Create `test-e2e/_helpers/po/marketplace.ts`:

```ts
import { type FrameLocator, type Locator, type Page } from "@playwright/test";

/** The Marketplace webview. It opens as an editor PANEL, not a sidebar view,
 *  so it is the LAST webview iframe in the workbench — same nesting as
 *  `tasksFrame` (an outer `iframe.webview`, an inner `#active-frame`), which is
 *  workbench-internal and can shift between pinned VS Code versions. That is
 *  why the nesting is expressed here and in `host.ts` only.
 *
 *  Selectors read from src/webview/MarketplaceApp.tsx on 2026-08-22. */
export class Marketplace {
  readonly frame: FrameLocator;

  constructor(page: Page) {
    this.frame = page.frameLocator("iframe.webview").last().frameLocator("#active-frame");
  }

  results(): Locator {
    return this.frame.locator(".results .n");
  }

  /** One result row, addressed by its displayed name. */
  result(name: string): Locator {
    return this.frame.locator(".results").getByText(name, { exact: true });
  }

  detail(): Locator {
    return this.frame.locator(".detail");
  }

  copyButton(): Locator {
    return this.frame.locator(".btn.cp");
  }

  openButton(): Locator {
    return this.frame.locator(".btn.pri");
  }

  search(): Locator {
    return this.frame.locator(".search input");
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add test-e2e/_helpers/po
git commit -m "test(e2e): add pool and marketplace page objects"
```

---

### Task 3: The fixture connector claims sprints, components and children

**Files:**
- Modify: `src/tasks/fixture/connector.ts`
- Modify: `test-e2e/_helpers/sandbox.ts`
- Test: `test/unit/tasks/fixtureConnector.test.ts`

**Interfaces:**
- Consumes: `Capabilities` (`src/tasks/provider.ts`), `ChildRef` (`src/tasks/jira/client.ts`, re-exported from `provider.ts`).
- Produces: `FixtureTaskRecord` gains an optional `parent?: string`; `FIXTURE_CHILD` exported from `sandbox.ts`; `writes.jsonl` gains the ops `addToSprint`, `removeFromSprint`, `setComponents`.

**Why this is the one authorised `src/` change.** The capability record is doing its job: with no `sprints`, `components` or `children` member, the sidebar correctly *hides* those lenses, so `addToMySprint`, `removeFromSprint`, `setComponent` and the child-tree take are not merely untested — they are unreachable from any E2E host. `makeFixtureConnector` resolves only when `agentFlow.taskSource: "fixture"` **and** `AGENT_FLOW_FIXTURE_DIR` are both set, `CONNECTOR_IDS` is untouched, and nothing frozen by `test/unit/compat.test.ts` moves.

- [ ] **Step 1: Write the failing unit tests**

Add to `test/unit/tasks/fixtureConnector.test.ts` (create the file if the repo does not have one; if it exists, append these cases and keep every existing case unchanged):

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { makeFixtureConnector } from "../../../src/tasks/fixture/connector";

let dir: string;

const PARENT = {
  key: "E2E-1", summary: "Fix the rocket telemetry panel", status: "To Do",
  statusCategory: "new", priority: "P2", assignee: "Unassigned", labels: [],
  components: [], sprint: null, inOpenSprint: false,
  updated: "2026-08-21T00:00:00.000Z", url: "https://fixture.invalid/browse/E2E-1",
  estimateSeconds: null, descriptionText: "The rocket panel shows stale numbers.",
};
const CHILD = {
  ...PARENT, key: "E2E-1-a", summary: "Repoint the telemetry feed",
  url: "https://fixture.invalid/browse/E2E-1-a", parent: "E2E-1",
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fixconn-"));
  fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([PARENT, CHILD]));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const writes = (): Record<string, unknown>[] =>
  fs.readFileSync(path.join(dir, "writes.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

describe("fixture connector capabilities", () => {
  it("keeps parented records out of the pool list", async () => {
    const p = makeFixtureConnector(dir).provider();
    expect((await p.list()).map((t) => t.key)).toEqual(["E2E-1"]);
  });

  it("answers children one level down", async () => {
    const p = makeFixtureConnector(dir).provider();
    expect(await p.caps.children!.of("E2E-1")).toEqual([
      { key: "E2E-1-a", summary: "Repoint the telemetry feed", type: "Sub-task", statusCategory: "new" },
    ]);
    expect(await p.caps.children!.of("E2E-1-a")).toEqual([]);
  });

  it("records sprint membership changes", async () => {
    const p = makeFixtureConnector(dir).provider();
    expect(await p.caps.sprints!.activeId()).toBe("fixture-sprint-1");
    await p.caps.sprints!.add("fixture-sprint-1", "E2E-1");
    await p.caps.sprints!.remove("E2E-1");
    expect(writes().map((w) => w.op)).toEqual(["addToSprint", "removeFromSprint"]);
  });

  it("records component updates and lists the fixture's components", async () => {
    const p = makeFixtureConnector(dir).provider();
    expect(await p.caps.components!.list()).toEqual(["landing-gear", "telemetry"]);
    await p.caps.components!.update("E2E-1", { add: ["telemetry"] });
    expect(writes()[0]).toMatchObject({ op: "setComponents", key: "E2E-1", add: ["telemetry"] });
  });

  it("throws for an unknown key rather than silently recording", async () => {
    const p = makeFixtureConnector(dir).provider();
    await expect(p.caps.sprints!.add("fixture-sprint-1", "NOPE-9")).rejects.toThrow(/no task NOPE-9/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/tasks/fixtureConnector.test.ts`
Expected: FAIL — `caps.children`, `caps.sprints` and `caps.components` are `undefined`, and `list()` returns both records.

- [ ] **Step 3: Implement the capabilities**

In `src/tasks/fixture/connector.ts`, extend the record type:

```ts
/** One task in `tasks.json`: everything the pool renders plus the detail body.
 *  A record with `parent` is a CHILD: it is reachable through `caps.children`
 *  and deliberately absent from `list()`, so adding tree fixtures cannot change
 *  the card count any existing journey asserts. */
export type FixtureTaskRecord = Task & { descriptionText: string; parent?: string };
```

Replace the `caps` object with:

```ts
  const caps: Capabilities = {
    supportedFilters: ["mine", "all"],
    sizes: false,
    labels: {
      add: async (key, label) => { find(key); record({ op: "addLabel", key, label }); },
    },
    // Recorded, not written through — matching `moveTo` and `addLabel`. The pool
    // updates optimistically; the assertion of record is `writes.jsonl`.
    sprints: {
      activeId: async () => "fixture-sprint-1",
      add: async (sprintId, key) => { find(key); record({ op: "addToSprint", key, sprintId }); },
      remove: async (key) => { find(key); record({ op: "removeFromSprint", key }); },
    },
    components: {
      list: async () => ["landing-gear", "telemetry"],
      update: async (key, delta) => {
        find(key);
        record({ op: "setComponents", key, add: delta.add ?? [], remove: delta.remove ?? [] });
      },
    },
    children: {
      of: async (key) => {
        find(key); // an unknown parent is a fixture authoring error, not an empty tree
        return read()
          .filter((r) => r.parent === key)
          .map((r): ChildRef => ({
            key: r.key, summary: r.summary, type: "Sub-task", statusCategory: r.statusCategory,
          }));
      },
    },
  };
```

Add `ChildRef` to the existing type import from `../provider`, and make `list()` skip children:

```ts
    list: async () => read().filter((r) => !r.parent).map(({ descriptionText: _d, parent: _p, ...task }) => task),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/tasks/fixtureConnector.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add the fixture data**

In `test-e2e/_helpers/sandbox.ts`, add after `FIXTURE_TASK_2`:

```ts
/** A child of E2E-1. Parented records are excluded from `list()`, so the pool
 *  stays at TWO cards and every existing journey's count assertion holds. */
export const FIXTURE_CHILD = {
  ...FIXTURE_TASK,
  key: "E2E-1-a", summary: "Repoint the telemetry feed",
  url: "https://fixture.invalid/browse/E2E-1-a",
  descriptionText: "The feed points at the retired endpoint.",
  parent: "E2E-1",
};
```

and write all three:

```ts
  fs.writeFileSync(
    path.join(fixtureDir, "tasks.json"),
    JSON.stringify([FIXTURE_TASK, FIXTURE_TASK_2, FIXTURE_CHILD], null, 2),
  );
```

- [ ] **Step 6: Prove the existing suites are untouched**

```bash
npm run typecheck                 # clean
npm test                          # passes UNMODIFIED   (timeout: 600000)
npm run test:cov                  # thresholds hold     (timeout: 600000)
npm run test:e2e                  # 11 existing still pass — the card count is still 2
```

If any existing journey's card count broke, the `list()` filter is wrong — fix the connector, **never** the journey's assertion.

- [ ] **Step 7: Commit**

```bash
git add src/tasks/fixture/connector.ts test/unit/tasks/fixtureConnector.test.ts test-e2e/_helpers/sandbox.ts
git commit -m "feat(fixture): claim sprints, components and children so the E2E lenses render"
```

---

### Task 4: `sidebar-actions.e2e.ts`

**Files:**
- Create: `test-e2e/sidebar-actions.e2e.ts`

**Interfaces:**
- Consumes: `describeWithHost` (Task 1), `Pool` (Task 2), the capabilities from Task 3, `FIXTURE_TASK`, `shot`.
- Produces: nothing later tasks consume.

**What each test asserts, and from where.** Sidebar writes land in `writes.jsonl` as append-only lines; each test asserts **the line it appended**, matched by `op` and `key`, never the file's whole contents — that is what makes sharing one host safe.

- [ ] **Step 1: Write the journey**

Create `test-e2e/sidebar-actions.e2e.ts`:

```ts
import { expect, test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { describeWithHost } from "./_helpers/sharedHost";
import { Pool } from "./_helpers/po/pool";
import { FIXTURE_TASK } from "./_helpers/sandbox";
import { shot } from "./_helpers/shot";

/** Read every write the extension has recorded so far. Append-only, so a test
 *  asserts the line IT caused by op+key and ignores its siblings' lines. */
function writes(fixtureDir: string): Record<string, unknown>[] {
  const f = path.join(fixtureDir, "writes.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describeWithHost("sidebar actions", {}, (ctx) => {
  test("the detail panel renders the task's description", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.card(FIXTURE_TASK.key).click();
    await expect(pool.frame.getByText(FIXTURE_TASK.descriptionText)).toBeVisible({ timeout: 15_000 });
    await shot(ctx.page(), testInfo, "1 · detail panel");
  });

  test("adding a label records addLabel for the card's key", async () => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.card(FIXTURE_TASK.key).getByRole("button", { name: /label/i }).click();
    await ctx.page().keyboard.type("needs-e2e");
    await ctx.page().keyboard.press("Enter");
    await expect
      .poll(() => writes(ctx.sb().fixtureDir).filter((w) => w.op === "addLabel" && w.key === FIXTURE_TASK.key))
      .toHaveLength(1);
  });

  test("add to sprint then remove records both transitions", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.card(FIXTURE_TASK.key).getByRole("button", { name: /sprint/i }).click();
    await expect
      .poll(() => writes(ctx.sb().fixtureDir).filter((w) => w.op === "addToSprint" && w.key === FIXTURE_TASK.key))
      .toHaveLength(1);
    await shot(ctx.page(), testInfo, "2 · added to sprint");

    await pool.card(FIXTURE_TASK.key).getByRole("button", { name: /sprint/i }).click();
    await expect
      .poll(() => writes(ctx.sb().fixtureDir).filter((w) => w.op === "removeFromSprint" && w.key === FIXTURE_TASK.key))
      .toHaveLength(1);
  });

  test("setting a component records the delta the picker produced", async () => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.card(FIXTURE_TASK.key).getByRole("button", { name: /component/i }).click();
    await ctx.page().getByRole("option", { name: "telemetry" }).click();
    await ctx.page().keyboard.press("Enter");
    await expect
      .poll(() => writes(ctx.sb().fixtureDir).find((w) => w.op === "setComponents" && w.key === FIXTURE_TASK.key))
      .toMatchObject({ add: ["telemetry"] });
  });

  test("reordering the pool survives a refresh, and reset restores source order", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    const first = await pool.cards().nth(0).innerText();

    await pool.cards().nth(0).dragTo(pool.cards().nth(1));
    await expect.poll(async () => (await pool.cards().nth(0).innerText()) !== first).toBe(true);
    await shot(ctx.page(), testInfo, "3 · reordered");

    // Persistence is the point: the order lives outside the webview, so it must
    // survive the view being torn down and rebuilt.
    await ctx.page().keyboard.press("Control+Shift+P");
    await ctx.page().keyboard.type("Agent Flow: Refresh Tasks");
    await ctx.page().keyboard.press("Enter");
    const reopened = await Pool.open(ctx.page(), 2);
    await expect.poll(async () => (await reopened.cards().nth(0).innerText()) !== first).toBe(true);

    await reopened.frame.getByRole("button", { name: /reset order/i }).click();
    await expect.poll(() => reopened.cards().nth(0).innerText()).toContain(first.split("\n")[0]);
  });

  test("Explore launches and lands a plan file", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.frame.getByRole("button", { name: /explore/i }).click();
    await ctx.page().keyboard.type("look at the telemetry panel");
    await ctx.page().keyboard.press("Enter");

    const plans = path.join(ctx.sb().home, ".agentflow", "plans");
    await expect.poll(
      () => (fs.existsSync(plans) ? fs.readdirSync(plans).filter((f) => f.includes("explore")) : []),
      { timeout: 60_000 },
    ).not.toHaveLength(0);
    await shot(ctx.page(), testInfo, "4 · explore launched");
  });
});
```

- [ ] **Step 2: Run it and repair only the locators**

Run: `npm run test:e2e -- sidebar-actions` (timeout: 600000)

Some action buttons are addressed by accessible name (`/label/i`, `/sprint/i`, `/component/i`, `/explore/i`, `/reset order/i`) because the exact affordance — inline button, card menu item, or QuickPick — is not the same for all five. **When one does not match, read the real affordance from `src/webview/App.tsx` and fix that one locator here. Never change the flow, and never weaken an assertion to make it pass.** If an action turns out not to be reachable at all, that is a stop-and-surface: the capability may still be hidden, which means Task 3 is incomplete.

- [ ] **Step 3: Full gate**

```bash
npm run typecheck && npm run test:e2e     # 11 existing + 6 new   (timeout: 600000)
```

- [ ] **Step 4: Commit**

```bash
git add test-e2e/sidebar-actions.e2e.ts
git commit -m "test(e2e): cover the sidebar's actions on a shared host"
```

---

### Task 5: `notepad.e2e.ts` — including the gesture jsdom cannot see

**Files:**
- Create: `test-e2e/notepad.e2e.ts`

**Interfaces:**
- Consumes: `describeWithHost`, `Pool` (`openNotepad`, `notes`, `note`, `sections`), `shot`.

**Why the drag test is the highest-value item in this plan.** An element with `draggable` cannot be text-selected in Blink, and `preventDefault` on `dragstart` does not give the gesture back. **jsdom cannot observe either fact** — which is how a known selection bug survives a fully green unit suite. Playwright driving real Electron is the only harness in this repo that can see it. `dragTo` alone is not enough for HTML5 drag in Chromium; the manual mouse sequence below is required.

- [ ] **Step 1: Write the journey**

Create `test-e2e/notepad.e2e.ts`:

```ts
import { expect, test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { describeWithHost } from "./_helpers/sharedHost";
import { Pool } from "./_helpers/po/pool";
import { shot } from "./_helpers/shot";

async function addNote(pool: Pool, title: string, body: string): Promise<void> {
  await pool.frame.locator(".np-title-input").fill(title);
  await pool.frame.locator(".np-body-input").fill(body);
  await pool.frame.locator(".np-add-btn").click();
  await expect(pool.note(title)).toBeVisible();
}

describeWithHost("notepad", {}, (ctx) => {
  test("a note added in one view is still there after the view is rebuilt", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.openNotepad();
    await addNote(pool, "Check the telemetry feed", "It points at the retired endpoint.");
    await shot(ctx.page(), testInfo, "1 · note added");

    // The Notepad lives in globalState, not in the webview — so the proof is
    // that it survives the webview being torn down and rebuilt.
    await pool.openTasksTab();
    await pool.openNotepad();
    await expect(pool.note("Check the telemetry feed")).toBeVisible();
  });

  test("toggling done and clearing completed removes only the done note", async () => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.openNotepad();
    await addNote(pool, "Second note", "stays");

    await pool.note("Check the telemetry feed").locator(".cb").click();
    await pool.frame.locator(".np-clear").click();

    await expect(pool.note("Check the telemetry feed")).toHaveCount(0);
    await expect(pool.note("Second note")).toBeVisible();
  });

  test("sections can be added, renamed and hold a note", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.openNotepad();

    await pool.frame.locator(".np-section-add-btn").click();
    await pool.frame.locator(".np-section-input").fill("Telemetry");
    await pool.page.keyboard.press("Enter");
    await expect(pool.frame.locator(".np-section-name", { hasText: "Telemetry" })).toBeVisible();

    await pool.frame.locator(".np-section-name", { hasText: "Telemetry" }).dblclick();
    await pool.frame.locator(".np-section-name-input").fill("Telemetry feed");
    await pool.page.keyboard.press("Enter");
    await expect(pool.frame.locator(".np-section-name", { hasText: "Telemetry feed" })).toBeVisible();
    await shot(ctx.page(), testInfo, "2 · section renamed");
  });

  test("a note can be dragged to a new position AND its text stays selectable", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.openNotepad();
    await addNote(pool, "Third note", "last");

    const firstBefore = await pool.notes().nth(0).innerText();

    // HTML5 drag needs a real mouse sequence: Playwright's dragTo does not
    // always fire dragstart/dragover/drop in Chromium. Steps matter — a single
    // move is coalesced and the drop lands where it started.
    const grip = pool.notes().nth(0).locator(".grip");
    const target = pool.notes().nth(2);
    const from = await grip.boundingBox();
    const to = await target.boundingBox();
    if (!from || !to) throw new Error("notepad drag: a bounding box was null — the list did not render");
    await pool.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await pool.page.mouse.down();
    await pool.page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await pool.page.mouse.up();

    await expect.poll(async () => (await pool.notes().nth(0).innerText()) !== firstBefore).toBe(true);
    await shot(ctx.page(), testInfo, "3 · dragged");

    // The regression this whole journey exists for: a draggable element cannot
    // be text-selected in Blink, and preventDefault on dragstart does not give
    // the gesture back. jsdom is structurally blind to this.
    const body = pool.notes().nth(0).locator(".np-body");
    const box = await body.boundingBox();
    if (!box) throw new Error("notepad selection: the note body had no box");
    await pool.page.mouse.move(box.x + 4, box.y + box.height / 2);
    await pool.page.mouse.down();
    await pool.page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 8 });
    await pool.page.mouse.up();

    const selected = await pool.page.evaluate(() => {
      const wv = document.querySelector("iframe.webview") as HTMLIFrameElement | null;
      const inner = wv?.contentDocument?.querySelector("#active-frame") as HTMLIFrameElement | null;
      return inner?.contentDocument?.getSelection()?.toString() ?? "";
    });
    expect(selected.trim().length).toBeGreaterThan(0);
  });

  test("running a note seeds a session and lands a plan file", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.openNotepad();
    await pool.notes().nth(0).getByRole("button", { name: /run/i }).click();

    const plans = path.join(ctx.sb().home, ".agentflow", "plans");
    await expect.poll(
      () => (fs.existsSync(plans) ? fs.readdirSync(plans) : []),
      { timeout: 60_000 },
    ).not.toHaveLength(0);
    await shot(ctx.page(), testInfo, "4 · note run");
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm run test:e2e -- notepad` (timeout: 600000)

If the selection assertion fails, **that is a real product bug, not a test bug** — the known Blink drag/selection interaction. Stop and surface it: the journey has done its job and the fix belongs in `src/webview/Notepad.tsx`, which this plan does not authorise.

- [ ] **Step 3: Full gate and commit**

```bash
npm run typecheck && npm run test:e2e     # (timeout: 600000)
git add test-e2e/notepad.e2e.ts
git commit -m "test(e2e): cover the Notepad, including real drag and text selection"
```

---

### Task 6: `marketplace.e2e.ts`

**Files:**
- Create: `test-e2e/marketplace.e2e.ts`
- Modify: `test-e2e/_helpers/sandbox.ts` (seed a `.claude/` tree in the fixture repo)

**Interfaces:**
- Consumes: `describeWithHost`, `Marketplace` (Task 2), `shot`.
- Produces: `seedClaudeAssets(sb)` exported from `sandbox.ts`.

**Clipboard note.** `mkt:copy` calls `vscode.env.clipboard.writeText` (`src/marketplaceView.ts`), which reaches the **real** system clipboard — the sandbox does not contain it. The journey therefore asserts the `"Copied to clipboard."` toast, not the clipboard's contents: reading it back is unreliable headlessly and would make the assertion depend on state the test cannot own.

- [ ] **Step 1: Seed the assets the Marketplace reads**

Add to `test-e2e/_helpers/sandbox.ts` and call it from `makeSandbox` after the git init:

```ts
/** The Marketplace lists agents and commands out of `.claude/`. The real one is
 *  gitignored, so the sandbox writes its own — two files whose names the
 *  journey asserts on. */
export function seedClaudeAssets(repoPath: string): void {
  const agents = path.join(repoPath, ".claude", "agents");
  const commands = path.join(repoPath, ".claude", "commands");
  fs.mkdirSync(agents, { recursive: true });
  fs.mkdirSync(commands, { recursive: true });
  fs.writeFileSync(
    path.join(agents, "telemetry-auditor.md"),
    "---\nname: telemetry-auditor\ndescription: Audits the rocket telemetry panel.\n---\n\nCheck the feed endpoint.\n",
  );
  fs.writeFileSync(
    path.join(commands, "refit.md"),
    "---\ndescription: Refit the landing gear.\n---\n\nRun the refit checklist.\n",
  );
}
```

- [ ] **Step 2: Write the journey**

Create `test-e2e/marketplace.e2e.ts`:

```ts
import { expect, test } from "@playwright/test";
import { describeWithHost } from "./_helpers/sharedHost";
import { Marketplace } from "./_helpers/po/marketplace";
import { shot } from "./_helpers/shot";

/** Open the Marketplace panel through the real command, not a seam. */
async function openMarketplace(page: import("@playwright/test").Page): Promise<Marketplace> {
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("Agent Flow: Open the Marketplace");
  await page.keyboard.press("Enter");
  const mkt = new Marketplace(page);
  await expect(mkt.results().first()).toBeVisible({ timeout: 30_000 });
  return mkt;
}

describeWithHost("marketplace", {}, (ctx) => {
  test("lists the agents and commands found in .claude/", async ({}, testInfo) => {
    const mkt = await openMarketplace(ctx.page());
    await expect(mkt.result("telemetry-auditor")).toBeVisible();
    await expect(mkt.result("refit")).toBeVisible();
    await shot(ctx.page(), testInfo, "1 · assets listed");
  });

  test("selecting an asset shows its body", async ({}, testInfo) => {
    const mkt = await openMarketplace(ctx.page());
    await mkt.result("telemetry-auditor").click();
    await expect(mkt.detail()).toContainText("Check the feed endpoint");
    await shot(ctx.page(), testInfo, "2 · detail");
  });

  test("copy reports success through the workbench toast", async () => {
    const mkt = await openMarketplace(ctx.page());
    await mkt.result("telemetry-auditor").click();
    await mkt.copyButton().click();
    // The toast is workbench chrome, OUTSIDE the webview iframes.
    await expect(ctx.page().locator(".notifications-toasts")).toContainText("Copied to clipboard", { timeout: 15_000 });
  });

  test("search narrows the list to the matching asset", async () => {
    const mkt = await openMarketplace(ctx.page());
    await mkt.search().fill("refit");
    await expect(mkt.result("refit")).toBeVisible();
    await expect(mkt.result("telemetry-auditor")).toHaveCount(0);
  });
});
```

- [ ] **Step 3: Run it, gate, commit**

```bash
npm run test:e2e -- marketplace     # (timeout: 600000)
npm run typecheck && npm run test:e2e
git add test-e2e/marketplace.e2e.ts test-e2e/_helpers/sandbox.ts
git commit -m "test(e2e): cover the Marketplace against a seeded .claude tree"
```

If the command title does not match, read the exact string from `package.json`'s `contributes.commands` — it is `Open the Marketplace` under the `Agent Flow` category.

---

### Task 7: Sabotage becomes a repeatable gate

**Files:**
- Create: `scripts/sabotage.mjs`, `test-e2e/sabotage/sidebar-actions.patch`, `test-e2e/sabotage/notepad.patch`, `test-e2e/sabotage/marketplace.patch`
- Modify: `package.json` (script), `CONTRIBUTING.md`

**Interfaces:**
- Consumes: the three journeys from Tasks 4–6.
- Produces: `npm run sabotage [journey]`; the convention that `test-e2e/sabotage/<journey>.patch` pairs with `test-e2e/<journey>.e2e.ts`.

**Why this exists.** Every journey shipped so far carried a sabotage check performed **once, by hand, during development** — which is exactly how a journey that has since gone vacuous stays green forever. On a prior plan six plan-authored tests turned out to be vacuous or impossible while the implementers' code was correct. A green suite that cannot fail is worse than no suite, because it is believed.

- [ ] **Step 1: Write the runner**

Create `scripts/sabotage.mjs`:

```js
#!/usr/bin/env node
// Apply a mutation, rebuild, run ONE journey, require it to fail, revert, prove
// the tree is clean. A journey that still passes under its mutation is vacuous.
//
// Deliberately not a per-PR gate: it rebuilds and re-runs per patch, far too
// slow for a required check, and "a test stopped being able to fail" is a
// standing-health question, not a merge-blocking one.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "test-e2e/sabotage";
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

function dirty() {
  return execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
}

if (dirty()) {
  console.error("sabotage: working tree is dirty. Commit first — the revert would discard your changes.");
  process.exit(1);
}

const only = process.argv[2];
const patches = readdirSync(DIR).filter((f) => f.endsWith(".patch"))
  .filter((f) => !only || f === `${only}.patch`);
if (patches.length === 0) {
  console.error(`sabotage: no patches matched${only ? ` "${only}"` : ""} in ${DIR}`);
  process.exit(1);
}

let failures = 0;
for (const patch of patches) {
  const journey = patch.replace(/\.patch$/, "");
  const spec = `test-e2e/${journey}.e2e.ts`;
  if (!existsSync(spec)) {
    console.error(`sabotage: ${patch} has no matching ${spec}`);
    failures++;
    continue;
  }
  console.log(`\n=== sabotage: ${journey} ===`);
  run("git", ["apply", join(DIR, patch)]);
  let survived = false;
  try {
    // Rebuild: E2E asserts the BUNDLE, so without this the mutation is not in
    // the code under test and every journey would "survive" every patch.
    run("npm", ["run", "build"]);
    run("npx", ["playwright", "test", "-c", "playwright-e2e.config.ts", spec]);
    survived = true; // exit 0 under the mutation
  } catch {
    console.log(`sabotage: ${journey} correctly FAILED under its mutation`);
  } finally {
    run("git", ["apply", "-R", join(DIR, patch)]);
  }
  if (dirty()) {
    console.error(`sabotage: tree not clean after reverting ${patch} — fix by hand before continuing`);
    process.exit(1);
  }
  if (survived) {
    console.error(`sabotage: ${journey} PASSED under its mutation — the journey is vacuous`);
    failures++;
  }
}

run("npm", ["run", "build"]); // leave dist/ matching the clean tree
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Add the script**

In `package.json`, after `"e2e:report"`:

```json
    "sabotage": "node scripts/sabotage.mjs",
```

- [ ] **Step 3: Author one patch per journey**

Each patch must break the **behaviour the journey asserts**, not merely the code. Generate each by hand-editing `src/`, then `git diff > test-e2e/sabotage/<journey>.patch`, then `git checkout src/`.

| Patch | Mutation | The assertion it must kill |
|---|---|---|
| `sidebar-actions.patch` | In `src/tasks/fixture/connector.ts`, make `components.update` return without calling `record(...)` | the `setComponents` line never appears in `writes.jsonl` |
| `notepad.patch` | In `src/webview/Notepad.tsx`, make the reorder handler a no-op (drop the `notepad:reorder` post) | the dragged note stays first |
| `marketplace.patch` | In `src/marketplaceView.ts`, change the copy toast text to `"Done."` | the `"Copied to clipboard"` toast assertion |

- [ ] **Step 4: Run the gate**

Run: `npm run sabotage` (timeout: 600000)
Expected: each journey reports "correctly FAILED under its mutation"; exit 0; `git status --porcelain` empty.

If a journey **survives** its mutation, the journey is vacuous — fix the journey, not the patch.

- [ ] **Step 5: Document both new commands**

In `CONTRIBUTING.md`'s "Everyday commands" table:

```markdown
| `npm run sabotage [journey]` | Mutation-check the E2E lane: apply `test-e2e/sabotage/<journey>.patch`, rebuild, run that one journey, require it to fail, revert. Requires a clean tree — the revert would discard uncommitted work. Runs weekly in CI, not per-PR. |
```

And a short section after it:

```markdown
## Sabotage patches

Every E2E journey pairs with `test-e2e/sabotage/<journey>.patch`, a mutation
that MUST make it fail. A journey that survives its mutation asserts nothing.
Add the patch in the same commit as the journey; generate it by breaking `src/`
by hand, `git diff > test-e2e/sabotage/<journey>.patch`, then `git checkout src/`.
```

- [ ] **Step 6: Full gate and commit**

```bash
npm run typecheck && npm test && npm run build && npm run test:e2e   # (timeout: 600000)
git add scripts/sabotage.mjs test-e2e/sabotage package.json CONTRIBUTING.md
git commit -m "test(e2e): make sabotage a repeatable gate with one patch per journey"
```

---

## Next increment (Plan 2)

`docs/superpowers/plans/2026-08-22-e2e-lane-expansion-mutating.md` covers spec §6.2, §7.2, §7.3, §8 and §9: the Cursor-as-host CDP spike (runs first, gates only itself), the review rail and `review-launch`, `deck-lifecycle`, `address-pr`, `child-tree-take`, `cursor-provider`, `copilot-panel`, `expectNoUnknownForgeCalls`, retry visibility in the verify report, and the CI wiring (cache key plus the weekly sabotage job).

## Self-Review

- **Spec coverage.** §4.1 → Task 1. §4.2 → Task 2 (the Deck page object moves to Plan 2, where its only consumer lives). §5 → Task 3. §6.1 → Tasks 4–6, **partially**: `sidebar-actions.e2e.ts` shipped as specified, but `notepad.e2e.ts` and `marketplace.e2e.ts` shipped a narrower slice than §6.1 lists. Notepad shipped add · toggle-done + clear-completed · real drag-reorder · the pinned post-drag-selection defect (not in §6.1, added because Task 5 surfaced it) · section add + rename · `notepad:run`. **Not shipped**: edit, delete, section delete, section collapse, and move-note-between-sections. Marketplace shipped list · detail (read a file's body) · copy · search; **not shipped**: reveal (search replaced it — a narrowing filter, not the same affordance as revealing a file in the OS/explorer). §7.1 → Task 7. §4.3, §4.4, §6.2, §7.2, §7.3, §8, §9 → Plan 2, named above.
- **One spec correction, made deliberately.** §6.1 listed "child expansion one level" in the sidebar group. Verified on 2026-08-22: children surface at **Take** time behind `agentFlow.childWorktrees` (`tasksView.ts:2548` `probeTree`), not as a sidebar tree — it opens windows and creates worktrees, so it cannot share a host. The **capability** stays in Task 3 (one file, one change); the **journey** moves to Plan 2 as `child-tree-take.e2e.ts`.
- **Placeholders:** none. Every step carries runnable code or exact commands. The three accessible-name locators in Task 4 are flagged with the component to read and an explicit "fix the locator, never the flow, never the assertion" rule — the same convention the shipped `e2e-critical-flows-expansion` plan used.
- **Type consistency.** `HostCtx.page()/sb()` (Task 1) is what Tasks 4–6 call. `Pool.frame/cards/card/selectRepo/openNotepad/openTasksTab/notes/note/sections` (Task 2) matches every call site. `Marketplace.results/result/detail/copyButton/search` matches Task 6. `FixtureTaskRecord.parent` (Task 3) is what `FIXTURE_CHILD` sets and `children.of` filters on. The write ops `addToSprint` / `removeFromSprint` / `setComponents` are spelled identically in the connector, its unit test and the journey.
- **Vacuous-test guard.** Task 7 is the guard, and it covers all three journeys this plan adds.
- **Inertness.** The only `src/` change is behind a setting **and** an env var; `CONNECTOR_IDS` untouched; no CHANGELOG entry, because nothing user-facing moves.
