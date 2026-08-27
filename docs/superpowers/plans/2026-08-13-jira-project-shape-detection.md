# Jira Project Shape Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Jira connector discover whether the configured project actually has a Scrum board — and which one — so a Kanban or board-less project stops rendering three sprint tabs that silently duplicate `all`, and so "Add to my sprint" can no longer land an issue in a different team's sprint.

**Architecture:** One new pure-ish module, `src/tasks/jira/shape.ts`, owns a **site-keyed** cache of everything Agent Flow has learned about a Jira project (board id, whether that board is Scrum) plus the site-keyed Sprint-field cache moved out of `client.ts`. `JiraClient` gains `loadShape()` (one Agile API round trip, cached) and `shapeSnapshot()` (synchronous peek, no I/O). `JiraProvider.caps` becomes a **getter** that reads that snapshot: absent snapshot ⇒ today's optimistic answer, byte for byte; Scrum snapshot ⇒ today's answer; non-Scrum snapshot ⇒ sprint lenses and `caps.sprints` dropped. The seam gains one **optional** method, `TaskProvider.refreshCaps?()`, and the webview gains one **additive** outbound message, `caps`, so the narrowed answer reaches the panel on the same async beat that already re-posts state when `me()` resolves.

**Tech Stack:** TypeScript, VS Code extension API, React (webview), esbuild, Vitest. The `vscode` module is mocked in `test/_mocks/vscode.ts`.

**Spec:** `preview/jira-genericity-audit.html` — items **A1** (Scrum-only lenses), **A6** (board roulette), **A8** (unstrippable `ORDER BY priority`), **C1**/**C2** (caches not keyed by site). Read it before Task 1. Items A2 (story points), A5 (component/repo detection), A3 (`prReviewStatus` default) and A4 (PR-prompt prose) are **deliberately out of scope** and get their own plans — see "Explicitly not in this plan" at the bottom.

## Global Constraints

- **This ships inert for the current user, and the existing test suite must pass unmodified except where this document names the file and says why.** Agent Flow has thousands of installs. The invariant that makes that true: **on a Scrum project every detected value equals today's hardcoded value**, so the observable diff is empty. Two consequences that are load-bearing:
  - `JiraProvider.caps` must return **exactly** today's object when no shape has been probed yet. `test/unit/tasks/jira/provider.test.ts` and `test/unit/tasksView.test.ts`'s `JIRA_CAPS` constant both pin that shape, and neither test ever runs a probe. If either needs editing, the getter is wrong.
  - `fetchTasks` must issue **exactly** the requests it issues today. `test/unit/tasks/jira/client.test.ts` queues fetch responses positionally with `installFetch([...])`, and `installFetch` **rejects** every call past the end of the queue ("fetch called more times than the mocked sequence provides"). Putting the shape probe inside `fetchTasks` would break roughly a dozen tests. **The probe is its own method, called from `refreshCaps()`, never from `fetchTasks()`.**
- **`test/unit/tasksView.test.ts` mocks `src/tasks/jira/client` wholesale** (see its `vi.mock("../../src/tasks/jira/client", …)` block, which re-exports the genuine `JiraApiError` for the same reason). A `JiraProvider` built on that mock has a client with **no `loadShape` and no `shapeSnapshot`**. Both call sites must therefore be written so a missing method degrades to "shape unknown" rather than throwing — and Task 3 adds the two methods to that mock anyway, so the host test exercises the real path.
- **`src/webview/**` must never import `fs`, `os`, `path`, or `child_process`, even transitively.** `tsc` and the full Vitest suite both pass when this rule is broken; only `npm run build` catches it. Run it.
- **Gates, all four, before any task is called done:** `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:cov` (thresholds enforced; changed files ≥95%). `src/tasks/**` is **not** coverage-exempt.
- **No new settings.** This plan is the "auto-detect" answer to the audit; a `agentFlow.jira.boardId` escape hatch is explicitly not part of it. Where detection cannot answer honestly (two Scrum boards on one project), the code makes the choice **stable and logged**, not configurable.
- **Never rename a shipped setting or SecretStorage key.** Nothing in this plan touches either.
- **Comment style:** this codebase's comments explain *why*, at length, and are part of the review bar. Match the density of `src/tasks/jira/client.ts` and `src/tasks/jira/provider.ts`. Do not add narration comments that restate the code.
- **Commit per task**, Conventional Commit style, scope `jira`: `feat(jira): …`, `fix(jira): …`, `test(jira): …`.
- **CHANGELOG:** one entry under `## [Unreleased]` in Task 5, not per task.

---

### Task 1: The site-keyed shape cache

The two module-level caches in `client.ts` are keyed wrongly today: `cachedSprintFieldId` is a bare `let` shared by every site, and `cachedComponents` is keyed by project key alone, so two Jira sites that both define a `PLAT` project share one entry. This task moves both behind one module that cannot be keyed wrongly, and adds the project-shape entry the later tasks fill in. No behaviour changes yet — this is the foundation.

**Files:**
- Create: `src/tasks/jira/shape.ts`
- Create test: `test/unit/tasks/jira/shape.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ProjectShape { boardId: number | null; hasSprints: boolean; boardCount: number }`
  - `SHAPE_TTL_MS = 10 * 60_000`, `FIELD_TTL_MS = 10 * 60_000`
  - `siteKey(baseUrl: string, project: string): string`
  - `peekShape(baseUrl: string, project: string): ProjectShape | null`
  - `putShape(baseUrl: string, project: string, shape: ProjectShape): ProjectShape`
  - `peekSprintField(baseUrl: string): { id: string | null } | null`
  - `putSprintField(baseUrl: string, id: string | null): void`
  - `resetShapeCaches(): void`
  - `pickBoard(boards: unknown): ProjectShape`

- [ ] **Step 1: Write the failing test**

Create `test/unit/tasks/jira/shape.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  peekShape, putShape, peekSprintField, putSprintField, pickBoard, resetShapeCaches,
  SHAPE_TTL_MS, FIELD_TTL_MS,
} from "../../../../src/tasks/jira/shape";

beforeEach(() => resetShapeCaches());
afterEach(() => vi.useRealTimers());

describe("pickBoard", () => {
  it("prefers a scrum board over a kanban one", () => {
    expect(pickBoard({ values: [{ id: 7, type: "kanban" }, { id: 2, type: "scrum" }] }))
      .toEqual({ boardId: 2, hasSprints: true, boardCount: 2 });
  });

  it("picks the LOWEST scrum board id, not Jira's response order", () => {
    // Two scrum boards is genuinely ambiguous — see pickBoard's comment. The only
    // promise made is that the answer does not depend on the order Jira replied in.
    const a = pickBoard({ values: [{ id: 9, type: "scrum" }, { id: 4, type: "scrum" }] });
    const b = pickBoard({ values: [{ id: 4, type: "scrum" }, { id: 9, type: "scrum" }] });
    expect(a.boardId).toBe(4);
    expect(a).toEqual(b);
  });

  it("reports a kanban-only project as having no sprints, but remembers the board", () => {
    expect(pickBoard({ values: [{ id: 5, type: "kanban" }] }))
      .toEqual({ boardId: 5, hasSprints: false, boardCount: 1 });
  });

  it("reports a project with no boards at all", () => {
    expect(pickBoard({ values: [] })).toEqual({ boardId: null, hasSprints: false, boardCount: 0 });
  });

  it("treats a malformed payload as no boards rather than throwing", () => {
    for (const bad of [null, undefined, {}, { values: null }, "nope", 42]) {
      expect(pickBoard(bad)).toEqual({ boardId: null, hasSprints: false, boardCount: 0 });
    }
  });

  it("ignores entries that are not objects or carry no numeric id", () => {
    expect(pickBoard({ values: [null, "x", { type: "scrum" }, { id: "3", type: "scrum" }, { id: 8, type: "scrum" }] }))
      .toEqual({ boardId: 8, hasSprints: true, boardCount: 5 });
  });
});

describe("shape cache keying", () => {
  it("does not answer one site with another site's shape", () => {
    putShape("https://a.test", "PLAT", { boardId: 1, hasSprints: true, boardCount: 1 });
    expect(peekShape("https://b.test", "PLAT")).toBeNull();
  });

  it("does not answer one project with another project's shape on the same site", () => {
    putShape("https://a.test", "PLAT", { boardId: 1, hasSprints: true, boardCount: 1 });
    expect(peekShape("https://a.test", "OTHER")).toBeNull();
  });

  it("returns the stored shape for the same site and project", () => {
    const shape = { boardId: 1, hasSprints: true, boardCount: 1 };
    putShape("https://a.test", "PLAT", shape);
    expect(peekShape("https://a.test", "PLAT")).toEqual(shape);
  });

  it("expires a shape after SHAPE_TTL_MS so a project that gains a board is noticed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    putShape("https://a.test", "PLAT", { boardId: null, hasSprints: false, boardCount: 0 });
    vi.setSystemTime(SHAPE_TTL_MS - 1);
    expect(peekShape("https://a.test", "PLAT")).not.toBeNull();
    vi.setSystemTime(SHAPE_TTL_MS + 1);
    expect(peekShape("https://a.test", "PLAT")).toBeNull();
  });

  it("putShape returns the shape it stored, so a caller can cache-and-return in one line", () => {
    const shape = { boardId: 3, hasSprints: true, boardCount: 1 };
    expect(putShape("https://a.test", "PLAT", shape)).toBe(shape);
  });
});

describe("sprint-field cache keying", () => {
  it("is keyed by site, not shared across sites", () => {
    putSprintField("https://a.test", "customfield_10020");
    expect(peekSprintField("https://b.test")).toBeNull();
    expect(peekSprintField("https://a.test")).toEqual({ id: "customfield_10020" });
  });

  it("remembers a resolved null — a site with no Sprint field is a real answer", () => {
    putSprintField("https://a.test", null);
    expect(peekSprintField("https://a.test")).toEqual({ id: null });
  });

  it("expires after FIELD_TTL_MS rather than remembering null forever", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    putSprintField("https://a.test", null);
    vi.setSystemTime(FIELD_TTL_MS + 1);
    expect(peekSprintField("https://a.test")).toBeNull();
  });

  it("is not confused by a project key that looks like part of another key", () => {
    // siteKey must not be a bare concatenation: ("https://a.test", "AB|C") and
    // ("https://a.test|AB", "C") must not collide.
    putShape("https://a.test", "AB|C", { boardId: 1, hasSprints: true, boardCount: 1 });
    expect(peekShape("https://a.test|AB", "C")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/tasks/jira/shape.test.ts`
Expected: FAIL — `Failed to resolve import ".../src/tasks/jira/shape"`.

- [ ] **Step 3: Write the module**

Create `src/tasks/jira/shape.ts`:

```ts
/** What Agent Flow has learned about one Jira project's board setup, and the two
 * caches that remember it. Separate from `client.ts` for one reason: both caches
 * used to be module-level state in there, keyed by less than identifies them — the
 * Sprint field id by nothing at all, the component list by project key alone — so
 * a `baseUrl` change mid-session, or two sites that both define a `PLAT` project,
 * were answered with the wrong site's data. A module whose only exported writers
 * take `(baseUrl, project)` cannot be keyed wrongly by a future call site. */

/** Everything one Agile API round trip can tell us about a project's board setup.
 * `boardCount` is not used to decide anything — it exists so the one genuinely
 * ambiguous case (several Scrum boards on one project) can be logged rather than
 * silently resolved. */
export interface ProjectShape {
  /** The board every sprint operation on this project will use, or null when the
   *  project has no board at all. */
  boardId: number | null;
  /** True only when the chosen board is one Jira itself types as `scrum`. This is
   *  the fact the sprint-shaped filter lenses and `caps.sprints` hang off. */
  hasSprints: boolean;
  /** How many boards the project has, of any type. Diagnostic only. */
  boardCount: number;
}

/** Board setup changes when someone reconfigures a project — rarely, but a user who
 * creates their first Scrum board should not have to reload the window to get their
 * sprint tabs. Ten minutes is the same order as the component list's own TTL. */
export const SHAPE_TTL_MS = 10 * 60_000;

/** The Sprint custom field id is stable per SITE, not per project — but a resolved
 * `null` (the lookup failed, or the site has no greenhopper field) used to be
 * remembered forever, which turned a transient 500 into "sprints are off until you
 * reload the window." A TTL costs one extra `/field` request every ten minutes on a
 * site that genuinely has no Sprint field, and buys recovery on the far more common
 * case of a request that just failed once. */
export const FIELD_TTL_MS = 10 * 60_000;

/** The one place a cache key is assembled. A NUL separator rather than a printable
 * one because a project key is user input: `siteKey("https://a.test", "AB|C")` and
 * `siteKey("https://a.test|AB", "C")` must not collide, and NUL can appear in
 * neither a URL nor a Jira project key. */
function key(baseUrl: string, project: string): string {
  return `${baseUrl}\u0000${project}`;
}

export function siteKey(baseUrl: string, project: string): string {
  return key(baseUrl, project);
}

const shapes = new Map<string, { shape: ProjectShape; at: number }>();
const sprintFields = new Map<string, { id: string | null; at: number }>();

/** The cached shape, or null when nothing is known — never a guess. Synchronous and
 * I/O-free on purpose: `JiraProvider.caps` is a synchronous getter that reads this,
 * and a `caps` that awaited anything would change the seam for every connector. */
export function peekShape(baseUrl: string, project: string): ProjectShape | null {
  const hit = shapes.get(key(baseUrl, project));
  if (!hit) return null;
  if (Date.now() - hit.at >= SHAPE_TTL_MS) {
    shapes.delete(key(baseUrl, project));
    return null;
  }
  return hit.shape;
}

/** Returns what it stored so a caller can cache-and-return in one expression. */
export function putShape(baseUrl: string, project: string, shape: ProjectShape): ProjectShape {
  shapes.set(key(baseUrl, project), { shape, at: Date.now() });
  return shape;
}

/** `null` means "not known"; `{ id: null }` means "known: this site has no Sprint
 * field." Collapsing those two into one value is what made a failed lookup
 * permanent, so the two-level shape is deliberate. */
export function peekSprintField(baseUrl: string): { id: string | null } | null {
  const hit = sprintFields.get(baseUrl);
  if (!hit) return null;
  if (Date.now() - hit.at >= FIELD_TTL_MS) {
    sprintFields.delete(baseUrl);
    return null;
  }
  return { id: hit.id };
}

export function putSprintField(baseUrl: string, id: string | null): void {
  sprintFields.set(baseUrl, { id, at: Date.now() });
}

/** Test seam. Production never calls this: the TTLs are the production answer to
 * staleness, and a cache a running extension can wipe is a cache whose lifetime
 * nothing can reason about. */
export function resetShapeCaches(): void {
  shapes.clear();
  sprintFields.clear();
}

/** Read Jira's `/rest/agile/1.0/board` payload into a `ProjectShape`.
 *
 * Pure, and total: every malformed shape Jira or a proxy could hand back resolves to
 * "no boards" rather than throwing, because the caller's fallback for "we could not
 * learn the shape" is today's behaviour, and an exception there would instead take
 * out the caps refresh that wraps it.
 *
 * **Scrum wins over Kanban, and the LOWEST id wins among Scrum boards.** The second
 * half is not a claim that the lowest id is the *right* board — with two Scrum boards
 * on one project (a board per team, common) nothing in the API says which one the
 * user means, and this plan deliberately adds no setting to ask. What the ordering
 * buys is that the answer is *stable*: the previous code took `values[0]`, so two
 * operations in one session could disagree if Jira's paging order shifted, and
 * "Add to my sprint" could put an issue in a different sprint from the one the
 * board's own sprint lookup reported. Stable-and-possibly-not-yours is a strictly
 * better failure than arbitrary-and-possibly-not-yours. */
export function pickBoard(payload: unknown): ProjectShape {
  const values =
    typeof payload === "object" && payload !== null && Array.isArray((payload as { values?: unknown }).values)
      ? ((payload as { values: unknown[] }).values)
      : [];
  const boards = values.filter(
    (b): b is { id: number; type?: string } =>
      typeof b === "object" && b !== null && typeof (b as { id?: unknown }).id === "number",
  );
  const scrum = boards.filter((b) => b.type === "scrum").sort((a, b) => a.id - b.id);
  const chosen = scrum[0] ?? [...boards].sort((a, b) => a.id - b.id)[0];
  return {
    boardId: chosen?.id ?? null,
    hasSprints: scrum.length > 0,
    boardCount: values.length,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/tasks/jira/shape.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/tasks/jira/shape.ts test/unit/tasks/jira/shape.test.ts
git commit -m "feat(jira): add a site-keyed project-shape cache"
```

---

### Task 2: `JiraClient` learns the shape, and every sprint call uses it

`getActiveSprintId` currently lists the project's boards on every call and takes `find(type === "scrum") ?? values[0]`. This task routes that through `loadShape()` so the board is chosen once, stably, and remembered — and moves the Sprint-field cache onto the new module.

**Files:**
- Modify: `src/tasks/jira/client.ts:30-37` (delete both module-level caches), `:154-169` (`sprintFieldId`), `:282-296` (`listComponents`), `:313-323` (`getActiveSprintId`); add `loadShape`/`shapeSnapshot`
- Modify test: `test/unit/tasks/jira/client.test.ts` (append two describe blocks; **change no existing assertion** — see Step 1's note)

**Interfaces:**
- Consumes: Task 1's `ProjectShape`, `pickBoard`, `peekShape`, `putShape`, `peekSprintField`, `putSprintField`.
- Produces:
  - `JiraClient.loadShape(): Promise<ProjectShape>`
  - `JiraClient.shapeSnapshot(): ProjectShape | null`
  - `JiraClient.siteId: string` (readonly getter over `siteKey(baseUrl, project)` — a cache key, not a display string)

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/tasks/jira/client.test.ts`. **Do not touch the existing `describe("getActiveSprintId")` block** — its two-call sequence (`board?projectKeyOrId=…` then `/board/2/sprint`) is exactly what the new implementation still issues on a cold cache, and its survival unmodified is the proof this task is inert.

`client.test.ts` already calls `vi.resetModules()` in `beforeEach`, which re-imports `client.ts` — but `shape.ts` is a *separate* module whose map would survive if it were imported elsewhere in the same test file. Import `resetShapeCaches` and call it too, so a test's cache can never be answered by its predecessor:

```ts
// Add to the existing imports at the top of the file:
import { resetShapeCaches } from "../../../../src/tasks/jira/shape";

// Add to the existing beforeEach, after `mod = await import(...)`:
//   resetShapeCaches();
```

Then append:

```ts
describe("loadShape", () => {
  const BOARDS = { values: [{ id: 7, type: "kanban" }, { id: 2, type: "scrum" }] };

  it("reads the project's boards and reports a scrum project", async () => {
    const fetchMock = installFetch([jsonResponse(BOARDS)]);
    expect(await client().loadShape()).toEqual({ boardId: 2, hasSprints: true, boardCount: 2 });
    expect(urlOf(fetchMock, 0)).toContain("/rest/agile/1.0/board?projectKeyOrId=PROJ");
  });

  it("reports a kanban-only project as sprintless", async () => {
    installFetch([jsonResponse({ values: [{ id: 5, type: "kanban" }] })]);
    expect(await client().loadShape()).toEqual({ boardId: 5, hasSprints: false, boardCount: 1 });
  });

  it("caches the shape — a second call makes no request", async () => {
    const fetchMock = installFetch([jsonResponse(BOARDS)]);
    const c = client();
    await c.loadShape();
    await c.loadShape();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares the cache across client instances for the same site and project", async () => {
    const fetchMock = installFetch([jsonResponse(BOARDS)]);
    await client().loadShape();
    // A fresh client per operation is the connector's contract (`provider()`), so a
    // cache that did not survive the instance would be no cache at all.
    expect(await client().loadShape()).toEqual({ boardId: 2, hasSprints: true, boardCount: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not answer one project with another project's shape", async () => {
    const fetchMock = installFetch([
      jsonResponse(BOARDS),
      jsonResponse({ values: [{ id: 5, type: "kanban" }] }),
    ]);
    await new mod.JiraClient(BASE, "PROJ", fakeAuth()).loadShape();
    expect(await new mod.JiraClient(BASE, "OTHER", fakeAuth()).loadShape())
      .toEqual({ boardId: 5, hasSprints: false, boardCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("degrades to the optimistic shape when the board list cannot be read, and does not cache it", async () => {
    // A 403 on the Agile API (common: Jira Software not licensed for this user) must
    // not be remembered as "this project has no sprints" — that would silently strip
    // the sprint tabs off a Scrum project over one failed request. Optimistic here
    // means: claim sprints, exactly as the pre-detection code did.
    const fetchMock = installFetch([textResponse("nope", 403), jsonResponse(BOARDS)]);
    const c = client();
    expect(await c.loadShape()).toEqual({ boardId: null, hasSprints: true, boardCount: 0 });
    expect(c.shapeSnapshot()).toBeNull();
    expect(await c.loadShape()).toEqual({ boardId: 2, hasSprints: true, boardCount: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lets an auth failure through — a dead token is not a project shape", async () => {
    installFetch([textResponse("", 401)]);
    await expect(client().loadShape()).rejects.toBeInstanceOf(mod.JiraAuthError);
  });
});

describe("shapeSnapshot", () => {
  it("is null before any probe and the shape after one, with no request of its own", async () => {
    const fetchMock = installFetch([jsonResponse({ values: [{ id: 2, type: "scrum" }] })]);
    const c = client();
    expect(c.shapeSnapshot()).toBeNull();
    await c.loadShape();
    expect(c.shapeSnapshot()).toEqual({ boardId: 2, hasSprints: true, boardCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getActiveSprintId — board reuse", () => {
  it("reuses an already-probed board instead of listing boards again", async () => {
    const fetchMock = installFetch([
      jsonResponse({ values: [{ id: 7, type: "kanban" }, { id: 2, type: "scrum" }] }),
      jsonResponse({ values: [{ id: 99 }] }),
    ]);
    const c = client();
    await c.loadShape();
    expect(await c.getActiveSprintId()).toBe(99);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(fetchMock, 1)).toContain("/board/2/sprint");
  });

  it("returns null without a sprint request when the project has no board", async () => {
    const fetchMock = installFetch([jsonResponse({ values: [] })]);
    const c = client();
    await c.loadShape();
    expect(await c.getActiveSprintId()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/tasks/jira/client.test.ts`
Expected: FAIL — `c.loadShape is not a function`. The pre-existing tests in the file must all still PASS.

- [ ] **Step 3: Rewrite the caches and the board lookup**

In `src/tasks/jira/client.ts`, **delete** these two blocks (currently lines 30-37):

```ts
// The Sprint field is a custom (greenhopper) field; its id is stable per Jira site.
let cachedSprintFieldId: string | null | undefined;

/** The project's component list, cached per project key. …*/
const COMPONENTS_TTL_MS = 5 * 60_000;
const cachedComponents = new Map<string, { names: string[]; at: number }>();
```

Replace with an import and a correctly-keyed component cache:

```ts
import {
  peekShape, peekSprintField, pickBoard, ProjectShape, putShape, putSprintField, siteKey,
} from "./shape";

/** The project's component list. Short-lived on purpose: a component created in Jira
 * should become syncable without a window reload, and the payload is a handful of
 * names. Keyed by site AND project — a project key alone let two Jira sites that both
 * define a `PLAT` project answer each other's component reads. */
const COMPONENTS_TTL_MS = 5 * 60_000;
const cachedComponents = new Map<string, { names: string[]; at: number }>();
```

Add a `siteId` getter to the class, just after the constructor:

```ts
  /** This client's cache identity, for log lines. Not a URL and not for display. */
  get siteId(): string {
    return siteKey(this.baseUrl, this.project);
  }
```

Replace `sprintFieldId` (currently lines 154-169) with:

```ts
  /** Resolve (once per site, per FIELD_TTL_MS) the id of the Sprint custom field. */
  private async sprintFieldId(): Promise<string | null> {
    const known = peekSprintField(this.baseUrl);
    if (known) return known.id;
    let resolved: string | null = null;
    try {
      const fields = await this.request("/rest/api/3/field");
      const f = Array.isArray(fields)
        ? fields.find((x: any) => x?.schema?.custom === "com.pyxis.greenhopper.jira:gh-sprint")
        : null;
      resolved = f?.id ?? null;
    } catch {
      resolved = null; // give up quietly — sprint detection just stays off
    }
    putSprintField(this.baseUrl, resolved);
    return resolved;
  }
```

Add the two new methods next to it:

```ts
  /** The board setup of the configured project, cached per site+project.
   *
   * On a read failure this answers `{ boardId: null, hasSprints: true, boardCount: 0 }`
   * — **optimistic, and deliberately not cached.** The Agile API 403s for a user
   * without a Jira Software licence and 404s behind some proxies, and treating either
   * as "this project has no sprints" would strip the sprint tabs off a working Scrum
   * project over one bad request. `hasSprints: true` with `boardId: null` is exactly
   * the pre-detection behaviour: claim sprints, and let `getActiveSprintId` do its own
   * board lookup. An auth failure is NOT swallowed — a dead token is a fact about the
   * credentials, and the panel already re-gates on it. */
  async loadShape(): Promise<ProjectShape> {
    const known = peekShape(this.baseUrl, this.project);
    if (known) return known;
    let payload: unknown;
    try {
      payload = await this.request(
        `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(this.project)}&maxResults=50`,
      );
    } catch (e) {
      if (e instanceof JiraAuthError) throw e;
      return { boardId: null, hasSprints: true, boardCount: 0 };
    }
    return putShape(this.baseUrl, this.project, pickBoard(payload));
  }

  /** What `loadShape` last learned, without making a request. `null` means nothing is
   * known yet — the caller must treat that as "behave exactly as before detection
   * existed", never as "no sprints". */
  shapeSnapshot(): ProjectShape | null {
    return peekShape(this.baseUrl, this.project);
  }
```

Replace `getActiveSprintId` (currently lines 313-323) with:

```ts
  /** The active sprint on the project's board, or null if there is none.
   *
   * The board comes from `loadShape()` rather than a fresh list-and-pick, so this and
   * every other sprint operation in a session agree on one board. That agreement is
   * the point: the previous code took `values[0]` from whatever order Jira replied in,
   * so on a project with several boards this lookup and a subsequent write could
   * disagree, and "Add to my sprint" could move an issue into a sprint the user was
   * never shown. */
  async getActiveSprintId(): Promise<number | null> {
    const { boardId } = await this.loadShape();
    if (boardId == null) return null;
    const sprints = await this.request(`/rest/agile/1.0/board/${boardId}/sprint?state=active`);
    return (sprints?.values ?? [])[0]?.id ?? null;
  }
```

Finally, in `listComponents` (currently lines 282-296), change both cache accesses from `this.project` to `this.siteId`:

```ts
    const hit = cachedComponents.get(this.siteId);
    if (hit && Date.now() - hit.at < COMPONENTS_TTL_MS) return hit.names;
```

```ts
    cachedComponents.set(this.siteId, { names, at: Date.now() });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/tasks/jira/client.test.ts`
Expected: PASS — the new blocks and, unmodified, every pre-existing test including `describe("getActiveSprintId")`.

Then run the whole suite: `npm test`. Expected: PASS with no other file edited. If `test/unit/tasks/jira/provider.test.ts` or `test/unit/tasksView.test.ts` fails here, stop — something in this task was not inert.

- [ ] **Step 5: Commit**

```bash
git add src/tasks/jira/client.ts test/unit/tasks/jira/client.test.ts
git commit -m "fix(jira): key the sprint-field and component caches by site, and pick one stable board per session"
```

---

### Task 3: Caps narrow to the detected shape

Today `JiraProvider.caps` is a field initialised once with all six filter lenses and a `sprints` object, whatever the project looks like. This task turns it into a getter over the shape snapshot, adds the optional seam method that triggers the probe, and delivers the narrowed answer to the webview on the beat that already re-posts state.

**Files:**
- Modify: `src/tasks/provider.ts:87-109` (`TaskProvider`, add optional `refreshCaps`)
- Modify: `src/tasks/jira/provider.ts:12-14` (filter constants), `:66-82` (`caps` → getter), add `refreshCaps`
- Modify: `src/types.ts` (add the `caps` outbound message)
- Modify: `src/tasksView.ts:435-452` (`postInitialState`)
- Modify: `src/webview/App.tsx` (handle the `caps` message)
- Modify test: `test/unit/tasks/jira/provider.test.ts` (append a describe block)
- Modify test: `test/unit/tasksView.test.ts` (extend the wholesale `src/tasks/jira/client` mock; append two tests)
- Modify test: `test/webview/App.test.tsx` (append one test)

**Interfaces:**
- Consumes: Task 2's `JiraClient.loadShape()` / `shapeSnapshot()`.
- Produces:
  - `TaskProvider.refreshCaps?(): Promise<void>` — optional
  - `SPRINTLESS_FILTERS: readonly Filter[] = ["unassigned", "mine", "all"]` (module-private to `src/tasks/jira/provider.ts`)
  - Outbound message `{ type: "caps"; caps: SerializedCaps }`

- [ ] **Step 1: Write the failing provider test**

Append to `test/unit/tasks/jira/provider.test.ts`:

```ts
describe("caps — narrowing to the detected project shape", () => {
  it("claims every lens and sprints before any probe has run", () => {
    // The inert case, and the one that matters most: an un-probed provider must be
    // byte-identical to the pre-detection provider, because that is what every other
    // test in the suite (and every first paint) sees.
    const p = new JiraProvider({ shapeSnapshot: () => null } as any);
    expect(p.caps.supportedFilters).toEqual(["unassigned", "mine", "mysprint", "sprint", "backlog", "all"]);
    expect(p.caps.sprints).toBeTruthy();
    expect(p.caps.sizes).toBe(true);
    expect(p.caps.labels).toBeTruthy();
    expect(p.caps.components).toBeTruthy();
  });

  it("keeps every lens and sprints on a scrum project", () => {
    const p = new JiraProvider({ shapeSnapshot: () => ({ boardId: 2, hasSprints: true, boardCount: 1 }) } as any);
    expect(p.caps.supportedFilters).toEqual(["unassigned", "mine", "mysprint", "sprint", "backlog", "all"]);
    expect(p.caps.sprints).toBeTruthy();
  });

  it("drops the sprint-shaped lenses and sprints on a project with no scrum board", () => {
    const p = new JiraProvider({ shapeSnapshot: () => ({ boardId: 5, hasSprints: false, boardCount: 1 }) } as any);
    expect(p.caps.supportedFilters).toEqual(["unassigned", "mine", "all"]);
    expect(p.caps.sprints).toBeUndefined();
  });

  it("keeps `unassigned` on a sprintless project — stripSprint makes it 'all open, nobody on it'", () => {
    const p = new JiraProvider({ shapeSnapshot: () => ({ boardId: null, hasSprints: false, boardCount: 0 }) } as any);
    expect(p.caps.supportedFilters).toContain("unassigned");
  });

  it("keeps sizes, labels and components on a sprintless project — none of them are sprint-shaped", () => {
    const p = new JiraProvider({ shapeSnapshot: () => ({ boardId: null, hasSprints: false, boardCount: 0 }) } as any);
    expect(p.caps.sizes).toBe(true);
    expect(p.caps.labels).toBeTruthy();
    expect(p.caps.components).toBeTruthy();
  });

  it("re-reads the snapshot on every access, so a probe mid-session is picked up", () => {
    let shape: any = null;
    const p = new JiraProvider({ shapeSnapshot: () => shape } as any);
    expect(p.caps.sprints).toBeTruthy();
    shape = { boardId: 5, hasSprints: false, boardCount: 1 };
    expect(p.caps.sprints).toBeUndefined();
  });
});

describe("refreshCaps", () => {
  it("loads the shape", async () => {
    const loadShape = vi.fn().mockResolvedValue({ boardId: 2, hasSprints: true, boardCount: 1 });
    await new JiraProvider({ loadShape, shapeSnapshot: () => null } as any).refreshCaps();
    expect(loadShape).toHaveBeenCalledTimes(1);
  });

  it("swallows a failure — an unreadable board list must not fail the panel's first paint", async () => {
    const loadShape = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      new JiraProvider({ loadShape, shapeSnapshot: () => null } as any).refreshCaps(),
    ).resolves.toBeUndefined();
  });

  it("survives a client that has no loadShape at all (a wholesale test mock)", async () => {
    await expect(new JiraProvider({} as any).refreshCaps()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/tasks/jira/provider.test.ts`
Expected: FAIL — `p.refreshCaps is not a function`, and the narrowing cases fail because `caps` is still a fixed field.

- [ ] **Step 3: Add the optional seam method**

In `src/tasks/provider.ts`, inside `interface TaskProvider`, immediately above `readonly caps: Capabilities;`:

```ts
  /** Resolve whatever `caps` depends on, then resolve. **`caps` may read differently
   * after this settles** — that is the entire purpose. Optional: a source whose
   * capabilities are static (the fixture connector, any source with no server-side
   * configuration to discover) simply omits it, and callers must treat its absence as
   * "caps are already final."
   *
   * Never rejects for an ordinary "couldn't find out" — a connector that cannot learn
   * its own shape must fall back to whatever it already claimed. Callers invoke this
   * as a best-effort side quest alongside the first list(), so a rejection here would
   * surface as a failed first paint for a fact the user never asked about. */
  refreshCaps?(): Promise<void>;
```

- [ ] **Step 4: Make `caps` a getter**

In `src/tasks/jira/provider.ts`, replace the `ALL_FILTERS` constant block (lines 12-14) with:

```ts
const ALL_FILTERS: readonly Filter[] = [
  "unassigned", "mine", "mysprint", "sprint", "backlog", "all",
];

/** What a project with no Scrum board can honestly answer. `mysprint`, `sprint` and
 * `backlog` are gone because all three are *defined* by `sprint in openSprints()` in
 * `buildJql` — without a sprint board the fallback ladder strips that clause and all
 * three degrade into duplicates of `mine`/`all`, which rendered as three tabs showing
 * the same list and explaining nothing.
 *
 * `unassigned` stays: sprint-stripped it reads "every open issue in the project with
 * nobody on it", which is a genuinely distinct and useful lens. `all` stays for the
 * same reason it is in ALL_FILTERS — it is the JQL builder's fallback default and no
 * tab bar has ever rendered it (see FILTER_ORDER in src/webview/helpers.ts). */
const SPRINTLESS_FILTERS: readonly Filter[] = ["unassigned", "mine", "all"];
```

Replace the `readonly caps: Capabilities = { … }` field (lines 66-82) with:

```ts
  /** Read fresh on every access, from a synchronous snapshot the client keeps — NOT a
   * field computed in the constructor. Two reasons, both load-bearing:
   *
   * A provider is built per operation, but the shape probe is one async round trip
   * that lands *after* the provider that started it is already in use. A field would
   * freeze the optimistic answer into the very instance the panel is reading.
   *
   * And a `null` snapshot must mean "behave exactly as this connector did before
   * detection existed" — every lens, sprints on — not "no sprints". Getting that
   * backwards would strip three tabs off every Scrum user's panel for the lifetime of
   * a failed request. `test/unit/tasksView.test.ts`'s `JIRA_CAPS` constant pins the
   * un-probed answer, so that inertness is enforced rather than asserted here. */
  get caps(): Capabilities {
    const hasSprints = this.client.shapeSnapshot?.()?.hasSprints ?? true;
    return {
      supportedFilters: hasSprints ? ALL_FILTERS : SPRINTLESS_FILTERS,
      sizes: true,
      labels: { add: (key, label) => this.client.addLabel(key, label) },
      ...(hasSprints
        ? {
            sprints: {
              activeId: async () => {
                const id = await this.client.getActiveSprintId();
                return id == null ? null : String(id);
              },
              add: (sprintId: string, key: string) =>
                this.client.addIssueToSprint(Number(sprintId), key),
              remove: (key: string) => this.client.removeIssueFromSprint(key),
            },
          }
        : {}),
      components: {
        list: () => this.client.listComponents(),
        update: (key, delta) => this.client.updateComponents(key, delta),
      },
    };
  }

  /** Learn the project's board setup, so `caps` can narrow. Never rejects: a client
   * with no `loadShape` (the wholesale mock in `test/unit/tasksView.test.ts`) and a
   * board list that cannot be read both mean the same thing here — keep claiming what
   * we already claimed. */
  async refreshCaps(): Promise<void> {
    try {
      await this.client.loadShape?.();
    } catch {
      /* an unlearnable shape leaves the optimistic caps in place, on purpose */
    }
  }
```

Note the `?.` on both `shapeSnapshot` and `loadShape`: `JiraClient` declares both, but `test/unit/tasksView.test.ts` replaces the whole module with a hand-written mock, and a `TypeError` inside a `caps` getter would take down `postState` rather than degrade.

- [ ] **Step 5: Run the provider test to verify it passes**

Run: `npx vitest run test/unit/tasks/jira/provider.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 6: Commit the provider half**

```bash
git add src/tasks/provider.ts src/tasks/jira/provider.ts test/unit/tasks/jira/provider.test.ts
git commit -m "feat(jira): narrow caps to the project's detected board setup"
```

- [ ] **Step 7: Write the failing host test**

This file's connector builds the **real** `JiraProvider` over `clientStub`, so these tests exercise the genuine narrowing path rather than a stand-in. First add the two new client methods to `clientStub` (the object the wholesale `vi.mock("../../src/tasks/jira/client", …)` factory hands back), beside its existing `getMyself` / `fetchTasks` members:

```ts
  loadShape: vi.fn().mockResolvedValue({ boardId: 2, hasSprints: true, boardCount: 1 }),
  shapeSnapshot: vi.fn(() => null),
```

`shapeSnapshot` defaulting to `null` is deliberate and load-bearing: it keeps `JIRA_CAPS` — the constant that ~10 `state` assertions in this file compare against — correct without editing a single one of them. A test that wants the narrowed answer overrides it for that test only.

Then append, using this file's own `setup()` / `send()` / `posted()` helpers (`posted()` is a function here; `mountWith()` returns `posted` as a plain array — do not mix them up):

```ts
describe("caps refresh", () => {
  it("posts the narrowed caps once the shape probe resolves", async () => {
    // The tab bar renders from the caps in `state`, which is posted before the shape
    // is known. This message is how a Kanban project's panel loses the three tabs it
    // cannot answer, without a second full state round trip that would clobber `me`.
    clientStub.shapeSnapshot.mockReturnValue({ boardId: 5, hasSprints: false, boardCount: 1 });
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(clientStub.loadShape).toHaveBeenCalledTimes(1);
    expect(posted()).toContainEqual({
      type: "caps",
      caps: { supportedFilters: ["unassigned", "mine", "all"], sizes: true, labels: true, sprints: false, components: true },
    });
  });

  it("still posts caps when the shape changes nothing, so the message is not a narrowing signal", async () => {
    // shapeSnapshot stays null (a scrum project, or an unreadable board list): the
    // posted caps must equal the ones `state` already carried, not a narrowed set.
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual({ type: "caps", caps: JIRA_CAPS });
  });

  it("posts no caps message for a connector that has no refreshCaps", async () => {
    const { posted } = await mountWith(makeFixtureConnector());
    expect(posted.filter((m) => m.type === "caps")).toEqual([]);
  });

  it("does not fail the first paint when the shape probe rejects", async () => {
    // refreshCaps is specified never to reject, but the host must not depend on a
    // connector honouring that — the task list is the real payload.
    clientStub.loadShape.mockRejectedValue(new Error("boom"));
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "tasks" }));
  });
});
```

Note the third test asserts on `posted` as an **array** because `mountWith` returns `s.messages`, while the others call `posted()` because `setup` returns the accessor. Both spellings already appear in this file; match the helper you used.

- [ ] **Step 8: Run it to verify it fails**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: FAIL — no `caps` message is ever posted.

- [ ] **Step 9: Add the message type, post it, and consume it**

In `src/types.ts`, beside the other outbound messages (next to `{ type: "state"; … }`):

```ts
  /** Capabilities that changed after `state` was posted, because the source had to ask
   * its server what it can do (`TaskProvider.refreshCaps`). Its own message rather
   * than a second `state` post for one reason: `state` also carries `me`, and the
   * caps refresh resolves on a different beat from the identity lookup — re-posting
   * `state` from here would clobber a display name that had already arrived with
   * `null`. The webview folds this straight into the same caps state `state` set. */
  | { type: "caps"; caps: SerializedCaps }
```

In `src/tasksView.ts`, add a third entry to `postInitialState`'s `Promise.all` (after the `me()` entry, before the `fetch`):

```ts
      // Best-effort, and its own message on purpose — see the `caps` message in
      // types.ts. A source whose capabilities are static has no refreshCaps and
      // nothing is posted; a source that has one but cannot answer keeps whatever it
      // already claimed, because refreshCaps is specified never to reject.
      (async () => {
        if (!provider.refreshCaps) return;
        await provider.refreshCaps();
        this.post({ type: "caps", caps: serializeCaps(provider.caps) });
      })().catch(() => {
        /* a source that cannot learn its own shape keeps the caps it already posted */
      }),
```

In `src/webview/App.tsx`, in the message switch beside the `state` case:

```ts
        case "caps":
          setCaps(m.caps);
          break;
```

- [ ] **Step 10: Write the failing webview test, then run both**

Append to `test/webview/App.test.tsx`, using this file's existing `host()` bridge, its `authed()` helper and the `[role="group"][aria-label="Task filter"]` query the other tab-bar tests use. **The filter tabs are `role="button"`, not `role="tab"`** — a `getByRole("tab", …)` here finds nothing and the test passes for the wrong reason:

```ts
  it("drops the sprint-shaped tabs when a caps message narrows them", () => {
    render(<App />);
    authed();
    const group = () =>
      within(document.querySelector('[role="group"][aria-label="Task filter"]') as HTMLElement)
        .getAllByRole("button")
        .map((b) => b.textContent);
    expect(group()).toEqual(["My sprint", "Mine", "Sprint", "Backlog", "Unassigned"]);

    host({
      type: "caps",
      caps: { supportedFilters: ["unassigned", "mine", "all"], sizes: true, labels: true, sprints: false, components: true },
    });
    // "all" is a real Filter that no tab bar has ever rendered (FILTER_ORDER in
    // src/webview/helpers.ts), so three supported filters means two tabs.
    expect(group()).toEqual(["Mine", "Unassigned"]);
  });

  it("keeps the size control when caps narrow only the filters", () => {
    // The narrowing is sprint-shaped, not a general downgrade: a Kanban project still
    // has estimates, labels and components.
    render(<App />);
    authed();
    host({
      type: "caps",
      caps: { supportedFilters: ["unassigned", "mine", "all"], sizes: true, labels: true, sprints: false, components: true },
    });
    expect(screen.getByRole("button", { name: "S" })).toBeTruthy();
  });
```

Confirm the first test's expected tab labels against the file's existing tab-bar assertions before running — if the shipped order or wording differs, the *existing* test is right and this one must match it. The size-chip accessible name in the second test likewise comes from the file's own size-control tests; read one and copy it rather than assuming `"S"`.

Run: `npx vitest run test/unit/tasksView.test.ts test/webview/App.test.tsx`
Expected: PASS.

Then `npm test`. Expected: PASS, with **no edit to any pre-existing assertion** in either file.

- [ ] **Step 11: Commit**

```bash
git add src/types.ts src/tasksView.ts src/webview/App.tsx test/unit/tasksView.test.ts test/webview/App.test.tsx
git commit -m "feat(deck): deliver narrowed source capabilities to the panel"
```

---

### Task 4: `ORDER BY priority` joins the fallback ladder

`fetchTasks` degrades a failing query along two axes (sprint clause, size clause) but never touches the sort, so a project where `priority` is hidden or unavailable has no working candidate at all. This is a pure addition: the new candidates are only ever reached after every current candidate has already failed.

**Files:**
- Modify: `src/tasks/jira/jql.ts` (add `stripPriorityOrder`)
- Modify: `src/tasks/jira/client.ts:171-198` (`fetchTasks`)
- Modify test: `test/unit/tasks/jira/jql.test.ts` (append a describe block)
- Modify test: `test/unit/tasks/jira/client.test.ts` (append one test)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `stripPriorityOrder(jql: string): string`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/tasks/jira/jql.test.ts`:

```ts
describe("stripPriorityOrder — no-priority fallback", () => {
  it("drops the priority term and keeps the updated sort", () => {
    expect(stripPriorityOrder(buildJql("PROJ", "mine"))).toBe(
      "project = PROJ AND statusCategory != Done ORDER BY updated DESC",
    );
  });

  it("leaves the WHERE clause untouched", () => {
    const stripped = stripPriorityOrder(buildJql("PROJ", "mysprint", "s"));
    expect(stripped).toContain("sprint in openSprints()");
    expect(stripped).toContain('originalEstimate <= "4h"');
  });

  it("is idempotent", () => {
    const once = stripPriorityOrder(buildJql("PROJ", "mine"));
    expect(stripPriorityOrder(once)).toBe(once);
  });

  it("leaves a query with no priority sort alone", () => {
    const q = "project = PROJ ORDER BY updated DESC";
    expect(stripPriorityOrder(q)).toBe(q);
  });
});
```

Append to `test/unit/tasks/jira/client.test.ts`:

```ts
  it("degrades to a priority-free sort once every other candidate has failed", async () => {
    // A project with priority hidden rejects every candidate that sorts by it. The
    // sort-stripped queries sit LAST in the ladder, so this can only be reached after
    // the sprint- and size-stripped ones have already been refused.
    const fetchMock = installFetch([
      jsonResponse(FIELD_LIST),
      textResponse("Field 'priority' does not exist", 400),
      jsonResponse({ issues: [rawIssue()] }),
    ]);
    const tasks = await client().fetchTasks("mine");
    expect(tasks).toHaveLength(1);
    expect(bodyOf(fetchMock, 1).jql).toContain("ORDER BY priority DESC");
    expect(bodyOf(fetchMock, 2).jql).toBe("project = PROJ AND statusCategory != Done ORDER BY updated DESC");
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/tasks/jira/jql.test.ts test/unit/tasks/jira/client.test.ts`
Expected: FAIL — `stripPriorityOrder is not a function`; the client test's third fetch is never made.

- [ ] **Step 3: Implement**

In `src/tasks/jira/jql.ts`, below `stripSprint`:

```ts
/** Drop the priority term from the sort — fallback for a project where `priority` is
 * hidden, unavailable, or not indexed, which makes Jira reject the whole query rather
 * than ignore the sort. Keeps `updated DESC` so the result is still newest-first
 * rather than arbitrary. Touches only the ORDER BY, never the WHERE. */
export function stripPriorityOrder(jql: string): string {
  return jql.replace(/ORDER BY priority DESC,\s*/i, "ORDER BY ");
}
```

In `src/tasks/jira/client.ts`, inside `fetchTasks`, after the existing `push(...)` calls and before `const sprintField = …`:

```ts
    // Sort-stripped variants go LAST, after every WHERE-stripped candidate: a wrong
    // sort is a cosmetic problem and a wrong filter is a wrong list, so the ladder
    // should exhaust the ones that keep the sort before trading it away.
    for (const q of [...candidates]) push(stripPriorityOrder(q));
```

Extend the import at the top of the file:

```ts
import { buildJql, stripPriorityOrder, stripSprint } from "./jql";
```

- [ ] **Step 4: Run the tests, then the whole suite**

Run: `npx vitest run test/unit/tasks/jira/jql.test.ts test/unit/tasks/jira/client.test.ts`
Expected: PASS.

Run: `npm test`. Expected: PASS. **If any pre-existing `fetchTasks` test now fails with "fetch called more times than the mocked sequence provides", read it before touching it** — that means the test drives every candidate to failure and its queue must grow by the number of added candidates. That is a fixture change, not an assertion change; do not weaken what it asserts.

- [ ] **Step 5: Commit**

```bash
git add src/tasks/jira/jql.ts src/tasks/jira/client.ts test/unit/tasks/jira/jql.test.ts test/unit/tasks/jira/client.test.ts
git commit -m "fix(jira): fall back to a priority-free sort when a project rejects one"
```

---

### Task 5: Investigate `statusCategory != Done`, then document the lot

Audit item **A7** is the one finding this plan does not fix, because it is not yet established as a bug. `buildJql` puts the literal `statusCategory != Done` in every query, and JQL resolves a status category by id, key or *name* — the English name is `Done` and the key is `done`, which are the same string modulo case, so it may already be locale-proof. If it is **not**, the failure mode is bad: the clause is in all four (now six) candidates and none of them strip it, so a localized site gets no working query and a raw API error where it should have degraded.

Establish which it is before changing anything. `test/unit/tasks/jira/jql.test.ts` pins the exact string in six assertions, so a speculative change costs six test edits for a hypothesis.

**Files:**
- Modify: `docs/CONNECTORS.md` (§3 capability table, §7 inherited assumptions)
- Modify: `CHANGELOG.md` (one `## [Unreleased]` entry)
- Possibly modify: `src/tasks/jira/jql.ts` + `test/unit/tasks/jira/jql.test.ts` — **only** if Step 1 confirms the bug

**Interfaces:**
- Consumes: everything above.
- Produces: no code interface.

- [ ] **Step 1: Establish whether the literal is locale-dependent**

Check Atlassian's JQL reference for `statusCategory` (the Context7 MCP server has the Atlassian docs — resolve the library id, then query for `statusCategory` JQL field), and if a non-English Jira Cloud site is reachable, run `statusCategory != Done` against it directly.

Record the finding in the CHANGELOG entry either way. Then:

- **If the English name is required** (a localized site rejects it): change `buildJql`'s three occurrences to `statusCategory != done` — the lowercase **key**, which is locale-invariant — and update the six assertions in `test/unit/tasks/jira/jql.test.ts` that spell `Done`. This is a deliberate wire-format change with its own tests updated, not a weakening; say so in the commit body.
- **If the key already resolves case-insensitively** (most likely): change nothing, and record the finding in `docs/CONNECTORS.md` §7 so the next person does not re-investigate.

- [ ] **Step 2: Document the new capability behaviour**

In `docs/CONNECTORS.md` §3, in the capability table, replace the `supportedFilters` and `sprints` rows' "Unlocks" text so they say the answer can change after `refreshCaps()`, and add a row:

```markdown
| `refreshCaps?()` | A source that must ask its own server what it can do — the Jira connector probes the project's boards and drops `mysprint`/`sprint`/`backlog` and `sprints` when there is no Scrum board. The host calls it once per panel init, alongside the first `list()`, and posts a `caps` message with the result. | Nothing is called and nothing is posted; the `caps` in the initial `state` message are final. A connector whose capabilities are static (the fixture connector) should omit it rather than implement a no-op. |
```

In §7 ("The inherited assumptions"), the "three things" opener is now wrong — the branch-inference and 8h-workday items remain, so re-count, and add the A7 finding from Step 1 plus this note:

```markdown
- **`caps` is read on every access, not once.** The Jira provider's `caps` is a
  getter over a cached project shape, so the same provider instance can answer
  differently before and after `refreshCaps()` resolves. If you implement
  `refreshCaps`, make `caps` a getter too — a field captured in your constructor
  will freeze the pre-probe answer into the instance the panel is already reading.
  And make the un-probed answer your **optimistic** one: a failed probe must leave
  the user with the capabilities you would have claimed before detection existed,
  never with the narrowest set.
```

- [ ] **Step 3: CHANGELOG**

Under `## [Unreleased]`:

```markdown
### Fixed
- Jira projects without a Scrum board no longer show three sprint filter tabs that
  silently returned the same list as **Mine** — the connector now reads the project's
  boards and offers only the lenses it can answer. Scrum projects are unaffected.
- Every sprint operation in a session now uses one stable board, chosen by lowest id
  with Scrum boards preferred. A project with several boards could previously have
  its active sprint read from one board and an issue added to another.
- The Sprint-field and component caches are keyed by Jira site, so changing
  `agentFlow.jira.baseUrl` mid-session no longer answers with the previous site's
  data, and two sites that define the same project key no longer share a cache entry.
  A failed Sprint-field lookup is retried after ten minutes instead of disabling
  sprint detection until the window is reloaded.
- A project that rejects a query sorted by `priority` now falls back to sorting by
  `updated` instead of showing an error.
```

- [ ] **Step 4: Run every gate**

```bash
npm run typecheck && npm test && npm run build && npm run test:cov
```
Expected: all four clean; changed files ≥95% coverage.

- [ ] **Step 5: Commit**

```bash
git add docs/CONNECTORS.md CHANGELOG.md
git commit -m "docs(jira): document capability narrowing and the statusCategory finding"
```

---

## Explicitly not in this plan

Four audit items are left for their own plans, each for a stated reason:

- **A2 — story-point estimates.** The detection is easy (`/rest/agile/1.0/board/{id}/configuration` returns `estimation.field.fieldId`, which is Jira's own authoritative answer), and Task 1's `ProjectShape` is the right home for the result. What makes it a separate plan is the domain change behind it: `Task.estimateSeconds` is seconds, and `fmtEst` in `src/webview/helpers.ts` divides by an 8-hour workday. Points need a unit on the task type and a unit-aware formatter — types, webview, and their tests. Doing it here would have made this plan's inertness claim much harder to hold.
- **A5 — component/repo coupling.** Detectable ("do any component names match a discovered repo?") and it belongs with A2 in the shape probe, but it changes what a repo chip *means* rather than which tabs render. Different review surface.
- **A3 — `prReviewStatus` defaults to `"PR initiated"`.** Not auto-detectable: nothing in Jira says which status means "a PR is open". The safe shape is to keep the default and the exact-match semantics exactly as they are, and add a broadened fallback that fires **only when the configured status does not exist in the project's status set** — which is inert for anyone whose configured value is real, including the current user, and helps everyone whose value is a stranger's convention. That gate needs a status-list read this plan does not add.
- **A4 — the PR-review prompt asserts "all our PRs carry the Jira key in their title and branch".** A prose edit to a default template, unrelated to detection. Bundle it with A3.
