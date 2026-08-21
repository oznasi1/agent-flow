# Webview Component Tests (Layer A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up Playwright Component Testing so the webview's measured-layout logic — which jsdom physically cannot execute — is covered in real Chromium, starting with the drag-reorder `"before"` branch that is unreachable today.

**Architecture:** A second, independent test runner alongside Vitest. Playwright CT mounts the real React components in headless Chromium, with the webview's `vscodeApi` module swapped for a recording double via a Vite `resolveId` plugin (the CT analogue of the suite's `vi.mock`). Specs live in `test-ct/` with a `.spec.tsx` suffix so they can never be picked up by Vitest's `test/**/*.test.{ts,tsx}` glob. The existing Vitest suite is not modified.

**Tech Stack:** `@playwright/experimental-ct-react` (React 18.2, classic JSX runtime), Vite (CT's bundler), TypeScript 5.4, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-15-automated-verify-cycle-design.html` (Layer A; Layers B and C are out of scope for this increment — see "Out of Scope" at the end).

## Global Constraints

Every task's requirements implicitly include this section. These are the repo's own gates — a task is not done until all of them pass.

- **`npm run typecheck` must stay clean** (`tsc --noEmit`). New directories must be added to `tsconfig.json`'s `include` or they are silently untypechecked.
- **`npm test` must pass unmodified** — 3,769 tests across 108 files. Do **not** edit, delete, or weaken any existing test to make new work fit.
- **`npm run build` must succeed** (esbuild, four bundles). The webview must never import `fs`/`os`/`path`/`child_process`, even transitively — only `npm run build` catches this; `tsc` and the full test suite pass regardless.
- **`npm run test:cov` thresholds must hold**: statements 90, branches 85, functions 85, lines 90.
- **Ship inert.** This extension has thousands of installs. Nothing in this plan changes runtime behavior — it adds a test layer only. No file under `src/` is modified by any task.
- **No hardcoded organization values** (per CONTRIBUTING). Not expected to bite here, but fixtures use neutral keys.
- **The webview uses the classic JSX runtime** (`import * as React from "react"`; `jsxFactory: "React.createElement"`). CT's Vite config must match `vitest.config.ts` or components fail with "React is not defined".
- **`test/_helpers/factories.ts` imports `vi` from `vitest`** and the `vscode` mock. It **must not** be imported from a Playwright spec — CT gets its own factory (Task 1).
- Playwright versions are **pinned exactly** (no `^`) — CT is experimental and minor bumps have broken its API.
- CHANGELOG is **not** required: this is developer tooling, not a user-facing change.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `playwright-ct.config.ts` | CT runner config: testDir, the `vscodeApi` stub plugin, JSX settings, reporters |
| `playwright/index.html` | CT mount page |
| `playwright/index.tsx` | CT entry: injects the real webview CSS so elements have real height |
| `test-ct/_doubles/vscodeApi.ts` | Recording double for `src/webview/vscodeApi.ts`; records into `window.__posted` |
| `test-ct/_helpers/host.ts` | `host()` / `posted()` — the host↔webview bridge helpers |
| `test-ct/_helpers/factories.ts` | Vitest-free task/note factories |
| `test-ct/globals.d.ts` | Types `window.__posted` |
| `test-ct/smoke.spec.tsx` | Proves the harness + double work |
| `test-ct/App.reorder.spec.tsx` | The `"before"` branch, unreachable in jsdom |
| `test-ct/Notepad.reorder.spec.tsx` | Same for notes |

**Modified:** `package.json` (devDeps + scripts), `tsconfig.json` (include), `.gitignore` (artifacts), `.github/workflows/ci.yml` (CT step), `CONTRIBUTING.md` (document the command).

---

### Task 1: CT harness

Stands up the runner and proves the recording double works end to end. Nothing here asserts product behavior — that is Tasks 2 and 3.

**Files:**
- Create: `playwright-ct.config.ts`, `playwright/index.html`, `playwright/index.tsx`, `test-ct/_doubles/vscodeApi.ts`, `test-ct/_helpers/host.ts`, `test-ct/_helpers/factories.ts`, `test-ct/globals.d.ts`, `test-ct/smoke.spec.tsx`
- Modify: `package.json`, `tsconfig.json`, `.gitignore`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `host(page, msg): Promise<void>`, `posted(page): Promise<InboundMessage[]>`, `mkTask(over?: Partial<Task>): Task`, `mkNote(over?: Partial<NotepadItemView>): NotepadItemView`, and the npm script `test:ct`.

- [x] **Step 1: Install pinned Playwright CT**

```bash
npm install -D --save-exact @playwright/experimental-ct-react@1.49.1 @playwright/test@1.49.1
npx playwright install --with-deps chromium
```

Then confirm the lockfile did not get rewritten to a private registry (this repo is public OSS and a polluted lockfile fails CI with E401):

```bash
grep -c "registry.npmjs.org" package-lock.json   # expect a large number
grep -c "codeartifact" package-lock.json          # expect 0
```

If `codeartifact` appears, restore with `git checkout package-lock.json` and re-run the install with `--registry=https://registry.npmjs.org`.

- [x] **Step 2: Add the CT config**

Create `playwright-ct.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/experimental-ct-react";
import * as path from "path";

/**
 * Swap the webview's `vscodeApi` module for a recording double — the CT
 * analogue of `vi.mock("../../src/webview/vscodeApi")` in the Vitest suite.
 *
 * `src/webview/vscodeApi.ts` calls `acquireVsCodeApi()` at module scope, which
 * throws in a plain browser. Resolving the import away is order-independent,
 * unlike defining a global and hoping it lands before the module evaluates.
 */
const stubVscodeApi = {
  name: "agent-flow:stub-vscode-api",
  enforce: "pre" as const,
  resolveId(source: string) {
    if (source === "./vscodeApi" || source.endsWith("/webview/vscodeApi")) {
      return path.resolve(__dirname, "test-ct/_doubles/vscodeApi.ts");
    }
    return null;
  },
};

export default defineConfig({
  testDir: "./test-ct",
  // `.spec.tsx`, never `.test.tsx`: Vitest owns `test/**/*.test.{ts,tsx}` and
  // the two runners must never claim the same file.
  testMatch: /.*\.spec\.tsx?$/,
  timeout: 20_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ctViteConfig: {
      plugins: [stubVscodeApi],
      // Must match vitest.config.ts — the webview uses the classic JSX runtime.
      esbuild: { jsx: "transform", jsxFactory: "React.createElement", jsxFragment: "React.Fragment" },
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
```

- [x] **Step 3: Add the CT mount page and entry**

Create `playwright/index.html`:

```html
<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><title>Agent Flow CT</title></head>
  <body><div id="root"></div><script type="module" src="./index.tsx"></script></body>
</html>
```

Create `playwright/index.tsx`. Injecting the real stylesheet matters: these tests
exist to exercise *measured* layout, so cards must have their real height.

```tsx
import { beforeMount } from "@playwright/experimental-ct-react/hooks";
import { CSS } from "../src/webview/styles";

beforeMount(async () => {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
});
```

- [x] **Step 4: Add the recording double**

Create `test-ct/_doubles/vscodeApi.ts`. It must export the same shape as the real
module (`vscodeApi` and `send`):

```ts
import type { InboundMessage } from "../../src/types";

/** Every message the component posted to the host, in order. Specs read it
 *  through `window.__posted`. */
const posted: InboundMessage[] = [];
window.__posted = posted;

export const vscodeApi = {
  postMessage: (msg: InboundMessage): void => { posted.push(msg); },
  getState: <T,>(): T | undefined => undefined,
  setState: <T,>(_state: T): void => {},
};

export function send(msg: InboundMessage): void {
  posted.push(msg);
}
```

Create `test-ct/globals.d.ts`:

```ts
import type { InboundMessage } from "../src/types";

declare global {
  interface Window {
    __posted: InboundMessage[];
  }
}

export {};
```

- [x] **Step 5: Add the bridge helpers and factories**

Create `test-ct/_helpers/host.ts`:

```ts
import type { Page } from "@playwright/test";
import type { InboundMessage, OutboundMessage } from "../../src/types";

/** Deliver a host→webview message the way the real postMessage bridge does. */
export async function host(page: Page, msg: OutboundMessage): Promise<void> {
  await page.evaluate((m) => {
    window.dispatchEvent(new MessageEvent("message", { data: m }));
  }, msg);
}

/** Every message the webview posted back to the host, in order. */
export async function posted(page: Page): Promise<InboundMessage[]> {
  return page.evaluate(() => window.__posted);
}
```

Create `test-ct/_helpers/factories.ts`. This duplicates a little of
`test/_helpers/factories.ts` on purpose: that file imports `vi` from `vitest`
and the `vscode` mock, neither of which can load in a Playwright browser bundle.

```ts
import type { NotepadItemView, SerializedCaps, Task } from "../../src/types";

export function mkTask(over: Partial<Task> = {}): Task {
  const key = over.key ?? "ASM-1";
  return {
    key, summary: key, status: "", statusCategory: "new", priority: "",
    assignee: "Unassigned", labels: [], components: [], sprint: null,
    inOpenSprint: false, updated: "", url: "", estimateSeconds: null, ...over,
  };
}

export function mkNote(over: Partial<NotepadItemView> = {}): NotepadItemView {
  return { id: "n1", title: "Ship the thing", body: "body", done: false, createdAt: 1, ...over };
}

export const ALL_FILTERS = { size: true, status: true, repo: true, search: true };

/** What the shipped Jira connector reports. `sprints: true` is what gates the
 *  my-sprint reorder affordance the drag specs depend on. */
export const JIRA_CAPS: SerializedCaps = {
  supportedFilters: ["unassigned", "mine", "mysprint", "sprint", "backlog", "all"],
  sizes: true, labels: true, sprints: true, components: true,
};
```

- [x] **Step 6: Wire tsconfig, scripts and gitignore**

In `tsconfig.json`, extend `include` so the new files are typechecked:

```json
"include": ["src", "test", "test-ct", "playwright", "vitest.config.ts", "playwright-ct.config.ts"]
```

In `package.json`, add to `scripts`:

```json
"test:ct": "playwright test -c playwright-ct.config.ts"
```

Append to `.gitignore`:

```
playwright-report/
test-results/
playwright/.cache/
```

- [x] **Step 7: Write the smoke spec**

Create `test-ct/smoke.spec.tsx`. `App` posts `{ type: "ready" }` on mount, so this
proves mounting, the JSX runtime, and the recording double all work together.

```tsx
import { test, expect } from "@playwright/experimental-ct-react";
import * as React from "react";
import { App } from "../src/webview/App";
import { posted } from "./_helpers/host";

test("the harness mounts App and records its outbound messages", async ({ mount, page }) => {
  await mount(<App />);
  await expect.poll(() => posted(page)).toContainEqual({ type: "ready" });
});
```

- [x] **Step 8: Run the smoke spec**

Run: `npm run test:ct`
Expected: PASS, 1 test.

If it fails with `acquireVsCodeApi is not defined`, the stub plugin did not match —
print the resolved id inside `resolveId` and widen the condition. If it fails with
`React is not defined`, the `esbuild` JSX block in `ctViteConfig` is missing.

- [x] **Step 9: Verify the repo gates still pass**

Run each and confirm:

```bash
npm run typecheck   # clean
npm test            # 3769 passed
npm run build       # succeeds
```

- [x] **Step 10: Commit**

```bash
git add playwright-ct.config.ts playwright test-ct package.json package-lock.json tsconfig.json .gitignore
git commit -m "test(ct): stand up Playwright component testing for the webview"
```

---

### Task 2: The drag-reorder `"before"` branch (App)

The headline. `dropPos` in `src/webview/App.tsx:804` reads `getBoundingClientRect()`.
jsdom returns a 0×0 rect, so `e.clientY < r.top + r.height / 2` is `0 < 0` — always
false, always `"after"`. The existing Vitest test says so in its own comment
(`test/webview/App.test.tsx:1095`). The `"before"` outcome has **never** been
executed by any test. Real Chromium is the only way to reach it.

**Files:**
- Create: `test-ct/App.reorder.spec.tsx`
- Read only (do not modify): `src/webview/App.tsx:804`, `src/webview/helpers.ts:102`

**Interfaces:**
- Consumes: `host`, `posted` from `test-ct/_helpers/host.ts`; `mkTask`, `ALL_FILTERS`, `JIRA_CAPS` from `test-ct/_helpers/factories.ts`.
- Produces: nothing consumed by later tasks.

Verified ground truth for the assertion (from `test/webview/helpers.test.ts:121-128`):
`moveKey([A,B,C], from "A", to "C", "before")` → `["B","A","C"]`; with `"after"` → `["B","C","A"]`.

- [x] **Step 1: Write the spec**

Create `test-ct/App.reorder.spec.tsx`:

```tsx
import { test, expect } from "@playwright/experimental-ct-react";
import * as React from "react";
import { App } from "../src/webview/App";
import { host, posted } from "./_helpers/host";
import { ALL_FILTERS, JIRA_CAPS, mkTask } from "./_helpers/factories";

/** Sign the panel in and give it three ordered cards under the my-sprint filter,
 *  which is the only filter that enables drag (App.tsx gates on
 *  `filter === "mysprint" && caps.sprints`). */
async function threeCards(page: import("@playwright/test").Page) {
  await host(page, {
    type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: true, configured: true,
    project: "ASM", me: "Jane", prReviewStatus: "PR initiated", filters: ALL_FILTERS,
  });
  await host(page, {
    type: "tasks", filter: "mysprint",
    tasks: [mkTask({ key: "A" }), mkTask({ key: "B" }), mkTask({ key: "C" })],
  });
}

/** Drag the card by its grip and release over `target` at `ratio` of the target's
 *  height (0 = top edge, 1 = bottom edge). Chromium needs more than one move for
 *  a native HTML5 drag to start, hence the stepped moves. */
async function dragOnto(
  page: import("@playwright/test").Page,
  fromKey: string, toKey: string, ratio: number,
) {
  const from = page.locator(".card", { hasText: fromKey });
  const to = page.locator(".card", { hasText: toKey });
  const grip = from.locator(".grip");

  await grip.hover();
  await page.mouse.down();

  const box = await to.boundingBox();
  if (!box) throw new Error(`no layout box for ${toKey}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height * ratio;

  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.move(x, y + 1, { steps: 5 }); // second move: settle dragover
  await page.mouse.up();
}

test("dropping on the top half reorders BEFORE the target", async ({ mount, page }) => {
  await mount(<App />);
  await threeCards(page);
  // Guard the premise: without real layout this test proves nothing.
  const box = await page.locator(".card", { hasText: "C" }).boundingBox();
  expect(box!.height).toBeGreaterThan(0);

  await dragOnto(page, "A", "C", 0.15);

  await expect
    .poll(async () => (await posted(page)).filter((m) => m.type === "reorder").at(-1))
    .toEqual({ type: "reorder", order: ["B", "A", "C"] });
});

test("dropping on the bottom half reorders AFTER the target", async ({ mount, page }) => {
  await mount(<App />);
  await threeCards(page);

  await dragOnto(page, "A", "C", 0.85);

  await expect
    .poll(async () => (await posted(page)).filter((m) => m.type === "reorder").at(-1))
    .toEqual({ type: "reorder", order: ["B", "C", "A"] });
});
```

- [x] **Step 2: Run the spec**

Run: `npm run test:ct -- test-ct/App.reorder.spec.tsx`
Expected: PASS, 2 tests.

If the native drag does not fire (no `reorder` message at all), fall back to
dispatching the drag events with coordinates computed from the *real* box — this
still exercises the real rect, which is the point of the test. Replace the body of
`dragOnto` with:

```ts
const from = page.locator(".card", { hasText: fromKey });
const to = page.locator(".card", { hasText: toKey });
await from.locator(".grip").dispatchEvent("mousedown");
await from.dispatchEvent("dragstart", { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
const box = await to.boundingBox();
if (!box) throw new Error(`no layout box for ${toKey}`);
const clientY = box.y + box.height * ratio;
await to.dispatchEvent("dragover", { clientY, dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
await to.dispatchEvent("drop", { clientY, dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
```

- [x] **Step 3: Mutation-check the test — prove it is not vacuous**

This tests behavior that already exists, so there is no natural red phase. That
makes a mutation check mandatory, not optional: a test that cannot fail is worse
than no test, because it reads as coverage.

Temporarily invert the comparison in `src/webview/App.tsx:804`:

```ts
return e.clientY > r.top + r.height / 2 ? "before" : "after";   // ← temporary
```

Run: `npm run test:ct -- test-ct/App.reorder.spec.tsx`
Expected: **BOTH tests FAIL.** If either still passes, the test is not really
reading the drop position — fix the test before continuing.

Then revert the source exactly:

```bash
git checkout src/webview/App.tsx
git diff --exit-code src/webview/App.tsx   # must print nothing
```

- [x] **Step 4: Re-run to confirm green after revert**

Run: `npm run test:ct -- test-ct/App.reorder.spec.tsx`
Expected: PASS, 2 tests.

- [x] **Step 5: Commit**

```bash
git add test-ct/App.reorder.spec.tsx
git commit -m "test(ct): cover the drag-reorder before-branch jsdom cannot reach"
```

---

### Task 3: The drag-reorder `"before"` branch (Notepad)

`src/webview/Notepad.tsx:587` has the same measured-layout `dropPos`, with the
same jsdom blind spot, and emits `{ type: "notepad:reorder", order }`.

**Files:**
- Create: `test-ct/Notepad.reorder.spec.tsx`
- Read only (do not modify): `src/webview/Notepad.tsx:587`

**Interfaces:**
- Consumes: `posted` from `test-ct/_helpers/host.ts`; `mkNote` from `test-ct/_helpers/factories.ts`.
- Produces: nothing consumed by later tasks.

`Notepad` takes props directly (`{ notes, ordered, sections }`) rather than
listening for a host message, so no `host()` call is needed.

- [x] **Step 1: Write the spec**

Create `test-ct/Notepad.reorder.spec.tsx`:

```tsx
import { test, expect } from "@playwright/experimental-ct-react";
import * as React from "react";
import { Notepad } from "../src/webview/Notepad";
import { posted } from "./_helpers/host";
import { mkNote } from "./_helpers/factories";

const notes = [
  mkNote({ id: "a", title: "First" }),
  mkNote({ id: "b", title: "Second" }),
  mkNote({ id: "c", title: "Third" }),
];

async function dragOnto(
  page: import("@playwright/test").Page,
  fromTitle: string, toTitle: string, ratio: number,
) {
  const from = page.locator(".np-item", { hasText: fromTitle });
  const to = page.locator(".np-item", { hasText: toTitle });
  await from.locator(".grip").hover();
  await page.mouse.down();
  const box = await to.boundingBox();
  if (!box) throw new Error(`no layout box for ${toTitle}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height * ratio;
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.move(x, y + 1, { steps: 5 });
  await page.mouse.up();
}

test("dropping a note on the top half files it BEFORE the target", async ({ mount, page }) => {
  await mount(<Notepad notes={notes} ordered={true} />);
  await dragOnto(page, "First", "Third", 0.15);

  await expect
    .poll(async () => (await posted(page)).filter((m) => m.type === "notepad:reorder").at(-1))
    .toEqual({ type: "notepad:reorder", order: ["b", "a", "c"] });
});

test("dropping a note on the bottom half files it AFTER the target", async ({ mount, page }) => {
  await mount(<Notepad notes={notes} ordered={true} />);
  await dragOnto(page, "First", "Third", 0.85);

  await expect
    .poll(async () => (await posted(page)).filter((m) => m.type === "notepad:reorder").at(-1))
    .toEqual({ type: "notepad:reorder", order: ["b", "c", "a"] });
});
```

- [x] **Step 2: Run the spec**

Run: `npm run test:ct -- test-ct/Notepad.reorder.spec.tsx`
Expected: PASS, 2 tests.

If the grip selector does not match, open `src/webview/Notepad.tsx` and use the
actual class on the note's drag handle; do not change the component.

- [x] **Step 3: Mutation-check the test**

Temporarily invert `src/webview/Notepad.tsx:587`:

```ts
return e.clientY > r.top + r.height / 2 ? "before" : "after";   // ← temporary
```

Run: `npm run test:ct -- test-ct/Notepad.reorder.spec.tsx`
Expected: **BOTH tests FAIL.**

Revert exactly:

```bash
git checkout src/webview/Notepad.tsx
git diff --exit-code src/webview/Notepad.tsx   # must print nothing
```

- [x] **Step 4: Re-run to confirm green after revert**

Run: `npm run test:ct -- test-ct/Notepad.reorder.spec.tsx`
Expected: PASS, 2 tests.

- [x] **Step 5: Commit**

```bash
git add test-ct/Notepad.reorder.spec.tsx
git commit -m "test(ct): cover the notepad drag-reorder before-branch"
```

---

### Task 4: Wire CT into the CI fast lane

Per the spec's Model B: component tests gate **every PR**; the heavy real-host
lane (Layer B, not in this increment) gates merge and release.

**Files:**
- Modify: `.github/workflows/ci.yml`, `CONTRIBUTING.md`

**Interfaces:**
- Consumes: the `test:ct` script from Task 1.
- Produces: a required PR check.

- [x] **Step 1: Add the CT step to CI**

In `.github/workflows/ci.yml`, after the existing `npm test` step and before
`npm run build`, add:

```yaml
      - name: Cache Playwright browsers
        uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
      - run: npx playwright install --with-deps chromium
      - run: npm run test:ct
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-ct-report
          path: playwright-report/
          retention-days: 7
```

The `if: failure()` upload is what makes a red CT run debuggable — it carries the
trace and the failure screenshot.

- [x] **Step 2: Document the command**

In `CONTRIBUTING.md`, add a row to the "Everyday commands" table:

```markdown
| `npm run test:ct` | Run the Playwright component tests (real Chromium; covers measured-layout behavior jsdom cannot). |
```

- [x] **Step 3: Verify the full gate locally**

Run all four and confirm each passes:

```bash
npm run typecheck
npm test
npm run test:ct
npm run build
```

- [x] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml CONTRIBUTING.md
git commit -m "ci: run the webview component tests on every PR"
```

---

## Out of Scope (next increments)

Named explicitly so nobody assumes they were forgotten:

1. ~~**`OrchestratorDrawer` graph layout**~~ — **done** in `test-ct/OrchestratorDrawer.canvas.spec.tsx`. The gap turned out to be sharper than "untested": all three measured sites correct a coordinate by the canvas origin with a `?? 0` fallback, and jsdom's zero rect makes the correction and the fallback the same number. Deleting the subtraction outright leaves all 226 existing drawer tests green — measured, not assumed. The node-drag sites (`:455`, `:622`) share that origin and remain uncovered; they need a settled-box drag rather than a drop.
2. **`DeckApp` drag surface**, and CT for `MarketplaceApp` / `PluginPicker` / `ReviewStrip`.
3. **Layer B — real-host E2E** (`@vscode/test-electron` + Playwright `_electron`, fake Jira, temp repos) and **Layer C — the verify-feature report on the PR**. These are the larger half of the spec and need their own plan.

## Self-Review

- **Spec coverage:** this plan implements Layer A's harness and its top two priority targets, plus the Model B fast-lane gate from §8. Layer A priority 3 (`OrchestratorDrawer`) and Layers B/C are deferred above, deliberately and visibly.
- **Placeholders:** none — every step carries runnable commands or complete code.
- **Type consistency:** `host`/`posted` signatures in Task 1 match their use in Tasks 2–3; `mkTask`/`mkNote`/`JIRA_CAPS`/`ALL_FILTERS` are defined once in Task 1 and only consumed later. The `reorder` and `notepad:reorder` payloads match `src/types.ts:503` and `:488`.
- **Assertion provenance:** the expected orders (`["B","A","C"]` / `["B","C","A"]`) are derived from `moveKey`'s implementation (`src/webview/helpers.ts:102-114`) and confirmed against its existing unit tests (`test/webview/helpers.test.ts:121-128`) — not assumed.
- **Vacuous-test guard:** because every test here covers pre-existing behavior, each test task carries a mandatory mutation check with an explicit revert-and-verify step.
