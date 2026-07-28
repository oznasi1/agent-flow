# Two-Way Component Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Repos this task touches" chips on a task card write back to the ticket's Jira Components field, so correcting the inferred repo set fixes the ticket instead of just the session.

**Architecture:** A new pure module resolves local repo names against the Jira project's component names; `JiraClient` gains a cached component-list read and an additive component write. The host reports the repo → component mapping alongside each ticket detail, and the webview — the only place that knows a chip's state — decides whether a toggle is worth a Jira write, applies it optimistically, and undoes it if the host echoes back a failure.

**Tech Stack:** TypeScript, React (webview), VS Code extension API, Vitest + @testing-library/react.

**Spec:** [`docs/superpowers/specs/2026-07-28-jira-component-two-way-sync-design.md`](../specs/2026-07-28-jira-component-two-way-sync-design.md)

## Global Constraints

- **Deltas only, never `set`.** A component write uses Jira's `update` verb with `add` / `remove`. A wholesale `set` would delete the issue's components that have no local checkout (`Infra`, `Docs`).
- **Matching is case-insensitive on the trimmed name** — the rule `inferServices` already uses (`src/engine/infer.ts:34`). The write always sends the *component's* spelling, never the repo's.
- **Writes happen only on an explicit user toggle.** Expanding a card must never write.
- **Every successful write stamps `provenanceLabel`** when `cfg.stampLabelOnWrite` is true, best-effort: a stamp failure is logged and never fails the write. Copy the existing shape at `src/tasksView.ts:302-308` exactly.
- **Chip states** (the vocabulary every task uses):
  - **A** — the repo maps to a project component *and* that component is on the issue. Solid chip. `×` writes a remove.
  - **B** — the repo maps to a project component that is *not* on the issue. Dashed chip. `↑` writes an add; `×` drops it locally with no write.
  - **C** — no project component by that name. Dashed chip, no `↑`. `×` drops it locally with no write.
- **Run `npx vitest run` and `npm run typecheck`** before every commit. Both must be clean.

---

### Task 1: The repo → component resolver

A pure module, no `vscode` and no network import, so it can be tested directly. It lives beside `infer.ts` because it is the same kind of thing (matching Jira strings against local repo names) and because `tasksView.ts` is already 1185 lines — the largest file in the repo — and must not absorb this.

**Files:**
- Create: `src/engine/components.ts`
- Test: `test/unit/engine/components.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `resolveComponent(repoName: string, projectComponents: string[]): string | null`
  - `mapRepoComponents(repoNames: string[], projectComponents: string[]): Record<string, string>`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/engine/components.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mapRepoComponents, resolveComponent } from "../../../src/engine/components";

describe("resolveComponent", () => {
  it("resolves an exact name", () => {
    expect(resolveComponent("billing-service", ["billing-service", "Infra"])).toBe("billing-service");
  });

  it("matches case-insensitively and returns the project's spelling, not the repo's", () => {
    expect(resolveComponent("billing-service", ["Billing-Service"])).toBe("Billing-Service");
  });

  it("tolerates surrounding whitespace on either side", () => {
    expect(resolveComponent("  billing-service ", ["billing-service"])).toBe("billing-service");
    expect(resolveComponent("billing-service", [" billing-service "])).toBe(" billing-service ");
  });

  it("returns null when the project has no such component", () => {
    expect(resolveComponent("scratch-tool", ["billing-service", "Infra"])).toBeNull();
  });

  it("returns null for an empty or whitespace-only repo name", () => {
    expect(resolveComponent("", ["billing-service"])).toBeNull();
    expect(resolveComponent("   ", ["billing-service"])).toBeNull();
  });

  it("returns null against an empty component list", () => {
    expect(resolveComponent("billing-service", [])).toBeNull();
  });

  it("takes the first of two components that fold to the same name", () => {
    // A project misconfiguration the user cannot see from the card. Picking one
    // beats refusing the write.
    expect(resolveComponent("billing", ["Billing", "billing"])).toBe("Billing");
  });
});

describe("mapRepoComponents", () => {
  it("keys by the repo's own spelling and values with the component's", () => {
    expect(mapRepoComponents(["billing-service", "centaur"], ["Billing-Service", "Centaur"])).toEqual({
      "billing-service": "Billing-Service",
      centaur: "Centaur",
    });
  });

  it("omits repos with no component, so a present key means 'syncable'", () => {
    expect(mapRepoComponents(["billing-service", "scratch-tool"], ["billing-service"])).toEqual({
      "billing-service": "billing-service",
    });
  });

  it("returns an empty map when the component list is empty", () => {
    expect(mapRepoComponents(["billing-service"], [])).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/components.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/engine/components"`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/components.ts`:

```ts
/**
 * The bridge between local repo names and a Jira project's Components field.
 *
 * A chip on a task card is a local repo name. Jira only accepts a component the
 * project already defines, spelled the way the project spells it. These two
 * helpers translate between the pair, folding case and surrounding whitespace —
 * the same rule `inferServices` matches with, so a repo that produced a chip from
 * a component can always be written back to that component.
 */

/** The project's canonical name for a repo, or null when it defines no component
 *  by that name — which is also the answer for a blank repo name. Two components
 *  folding to the same key is a project misconfiguration invisible from the card,
 *  so the first one wins rather than the write failing. */
export function resolveComponent(repoName: string, projectComponents: string[]): string | null {
  const want = fold(repoName);
  if (!want) return null;
  for (const component of projectComponents) {
    if (fold(component) === want) return component;
  }
  return null;
}

/** `resolveComponent` across a set of repos, keyed by each repo's own spelling —
 *  the form the webview needs to classify a chip without a round trip. Repos with
 *  no component are absent, so a present key means "this one can be synced". */
export function mapRepoComponents(
  repoNames: string[],
  projectComponents: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of repoNames) {
    const component = resolveComponent(name, projectComponents);
    if (component) out[name] = component;
  }
  return out;
}

function fold(s: string): string {
  return s.trim().toLowerCase();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/components.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/engine/components.ts test/unit/engine/components.test.ts
git commit -m "feat(jira): resolve local repo names against project components"
```

---

### Task 2: `JiraClient.listComponents` and `updateComponents`

The read is cached per project with a 5-minute TTL — components get created far more often than the sprint field id changes, so the module-level forever-cache used for `cachedSprintFieldId` would make a new component un-syncable until a window reload. A failed read resolves to `[]` rather than throwing: not knowing the list disables component writes, and that must not also break expanding a card.

**The cache must be module-level, not a field on `JiraClient`.** `tasksView.client()` returns `new JiraClient(...)` on every call (`src/tasksView.ts:82-85`), so an instance field is discarded after a single use and the cache would never hit — every card expand and every chip toggle would refetch. This is why the existing `cachedSprintFieldId` lives at module scope too.

**Files:**
- Modify: `src/jira/client.ts` — add the TTL constant and cache near `cachedSprintFieldId` (line 20), and the two methods after `addLabel` (ends line 250)
- Test: `test/unit/jira/client.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces, on `JiraClient`:
  - `listComponents(): Promise<string[]>`
  - `updateComponents(key: string, delta: { add?: string[]; remove?: string[] }): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/jira/client.test.ts`. The file already calls `vi.resetModules()` in its `beforeEach`, so the module-level cache cannot leak between cases. `installFetch`, `jsonResponse`, `emptyResponse`, `textResponse`, `bodyOf` and `urlOf` are already in scope at the top of that file.

```ts
describe("listComponents", () => {
  it("GETs the project's components and returns their names", async () => {
    const fetchMock = installFetch([jsonResponse([{ id: "1", name: "billing-service" }, { id: "2", name: "Infra" }])]);
    await expect(client().listComponents()).resolves.toEqual(["billing-service", "Infra"]);
    expect(urlOf(fetchMock, 0)).toBe(`${BASE}/rest/api/3/project/ASM/components`);
  });

  // Two separate cases on purpose. The cache is module-level and keyed by project,
  // so a second listComponents() in the same test would be served from the first
  // one's result — asserting both in one `it` would force the cache to be scoped
  // per client instance, and `tasksView.client()` builds a new client per call, so
  // that scope would never hit in production. The file's beforeEach resets modules,
  // which gives each `it` a clean cache.
  it("drops entries with no usable name", async () => {
    installFetch([jsonResponse([{ id: "1" }, { id: "2", name: "" }, { id: "3", name: "Infra" }])]);
    await expect(client().listComponents()).resolves.toEqual(["Infra"]);
  });

  it("tolerates a non-array body", async () => {
    installFetch([jsonResponse({ not: "an array" })]);
    await expect(client().listComponents()).resolves.toEqual([]);
  });

  it("caches the list — a second call inside the TTL does not fetch again", async () => {
    const fetchMock = installFetch([jsonResponse([{ name: "billing-service" }])]);
    const c = client();
    await c.listComponents();
    await expect(c.listComponents()).resolves.toEqual(["billing-service"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches once the 5-minute TTL has passed", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = installFetch([
        jsonResponse([{ name: "billing-service" }]),
        jsonResponse([{ name: "billing-service" }, { name: "pricing-api" }]),
      ]);
      const c = client();
      await c.listComponents();
      vi.advanceTimersByTime(5 * 60_000 + 1);
      await expect(c.listComponents()).resolves.toEqual(["billing-service", "pricing-api"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves to [] on failure rather than throwing, and does not cache the failure", async () => {
    const fetchMock = installFetch([textResponse("boom", 500), jsonResponse([{ name: "Infra" }])]);
    const c = client();
    await expect(c.listComponents()).resolves.toEqual([]);
    await expect(c.listComponents()).resolves.toEqual(["Infra"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("swallows an auth failure too — the caller reads the issue first, which reports it", async () => {
    installFetch([textResponse("", 401)]);
    await expect(client().listComponents()).resolves.toEqual([]);
  });
});

describe("updateComponents", () => {
  it("PUTs an additive add", async () => {
    const fetchMock = installFetch([emptyResponse()]);
    await client().updateComponents("ASM-1", { add: ["billing-service"] });
    expect(urlOf(fetchMock, 0)).toBe(`${BASE}/rest/api/3/issue/ASM-1`);
    expect(fetchMock.mock.calls[0][1].method).toBe("PUT");
    expect(bodyOf(fetchMock, 0)).toEqual({ update: { components: [{ add: { name: "billing-service" } }] } });
  });

  it("PUTs a remove", async () => {
    const fetchMock = installFetch([emptyResponse()]);
    await client().updateComponents("ASM-1", { remove: ["pricing-api"] });
    expect(bodyOf(fetchMock, 0)).toEqual({ update: { components: [{ remove: { name: "pricing-api" } }] } });
  });

  it("PUTs adds before removes in one call", async () => {
    const fetchMock = installFetch([emptyResponse()]);
    await client().updateComponents("ASM-1", { add: ["a"], remove: ["b"] });
    expect(bodyOf(fetchMock, 0)).toEqual({
      update: { components: [{ add: { name: "a" } }, { remove: { name: "b" } }] },
    });
  });

  it("never uses the destructive set verb (which would drop components with no local repo)", async () => {
    const fetchMock = installFetch([emptyResponse()]);
    await client().updateComponents("ASM-1", { add: ["a"] });
    expect(JSON.stringify(bodyOf(fetchMock, 0))).not.toContain("set");
    expect(bodyOf(fetchMock, 0)).not.toHaveProperty("fields");
  });

  it("makes no request at all when there is nothing to change", async () => {
    const fetchMock = installFetch([]);
    await client().updateComponents("ASM-1", {});
    await client().updateComponents("ASM-1", { add: [], remove: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/jira/client.test.ts -t "listComponents"`
Expected: FAIL — `client(...).listComponents is not a function`.

- [ ] **Step 3: Add the cache next to the sprint-field cache**

In `src/jira/client.ts`, directly below the existing `cachedSprintFieldId` declaration (line 20):

```ts
/** The project's component list, cached per project key. Short-lived on purpose:
 * a component created in Jira should become syncable without a window reload, and
 * the payload is a handful of names. */
const COMPONENTS_TTL_MS = 5 * 60_000;
const cachedComponents = new Map<string, { names: string[]; at: number }>();
```

- [ ] **Step 4: Add the two methods after `addLabel`**

In `src/jira/client.ts`, immediately after the `addLabel` method (which ends at line 250):

```ts
  /** The component names this project defines — the only names a component write
   *  may use. Cached for `COMPONENTS_TTL_MS`. A failure resolves to `[]` and is not
   *  cached: without the list, component writes are simply off, and that must not
   *  also break expanding a card. Callers that need auth failures reported must
   *  read the issue *before* calling this. */
  async listComponents(): Promise<string[]> {
    const hit = cachedComponents.get(this.project);
    if (hit && Date.now() - hit.at < COMPONENTS_TTL_MS) return hit.names;
    let names: string[];
    try {
      const data = await this.request(
        `/rest/api/3/project/${encodeURIComponent(this.project)}/components`,
      );
      names = (Array.isArray(data) ? data : []).map((c: any) => c?.name ?? "").filter((n: string) => !!n);
    } catch {
      return [];
    }
    cachedComponents.set(this.project, { names, at: Date.now() });
    return names;
  }

  /** Add and/or remove components on an issue, leaving every other component in
   *  place (Jira WRITE). Additive verbs only — a `set` would delete the components
   *  that have no local checkout. Names must be spelled as the project spells them. */
  async updateComponents(key: string, delta: { add?: string[]; remove?: string[] }): Promise<void> {
    const ops = [
      ...(delta.add ?? []).map((name) => ({ add: { name } })),
      ...(delta.remove ?? []).map((name) => ({ remove: { name } })),
    ];
    if (ops.length === 0) return;
    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ update: { components: ops } }),
    });
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/jira/client.test.ts`
Expected: PASS — the whole file, including the 11 new cases.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/jira/client.ts test/unit/jira/client.test.ts
git commit -m "feat(jira): read a project's components and write issue component deltas"
```

---

### Task 3: The host reports the mapping with each ticket detail

Two new fields on the `detail` message: the components actually on the issue, and the repo → component map for **every** discovered repo (not only the chipped ones — the user can add any of them from the picker). The `listComponents` call must come *after* `getDetail`, because `listComponents` swallows every failure including a 401; the detail read is what lets a dead token reach `onMessage`'s catch and re-gate the panel.

**Files:**
- Modify: `src/types.ts:281` (the `detail` outbound message)
- Modify: `src/tasksView.ts:177-192` (the `detail` case)
- Test: `test/unit/tasksView.test.ts` — extend the client stub in `makeClient()` (line ~78) and add a describe block
- Test: `test/webview/App.test.tsx:707` — the existing `detail` host message must carry the new required fields or the file will not typecheck

**Interfaces:**
- Consumes: `mapRepoComponents` from Task 1; `JiraClient.listComponents` from Task 2.
- Produces: the outbound message
  `{ type: "detail"; key: string; descriptionText: string; inferred: string[]; repos: string[]; jiraComponents: string[]; mappable: Record<string, string> }`

- [ ] **Step 1: Write the failing test**

In `test/unit/tasksView.test.ts`, first add the two client methods to `makeClient()`, right after the existing `addLabel` line:

```ts
    listComponents: vi.fn(async () => ["account-service", "Infra"]),
    updateComponents: vi.fn(async () => undefined),
```

Then add this describe block (put it just before `describe("addToMySprint"`):

```ts
describe("detail", () => {
  it("reports the issue's components and the repo → component map for every repo", async () => {
    clientStub.getDetail.mockResolvedValue({
      key: "ASM-1",
      summary: "Do the thing",
      descriptionText: "desc",
      labels: ["centaur"],
      components: ["account-service"],
      url: "https://jira/browse/ASM-1",
    });
    const { send, posted } = setup();
    await send({ type: "detail", key: "ASM-1" });
    expect(posted()).toContainEqual({
      type: "detail",
      key: "ASM-1",
      descriptionText: "desc",
      // account-service from the component, centaur from the label
      inferred: ["account-service", "centaur"],
      repos: ["account-service", "centaur"],
      jiraComponents: ["account-service"],
      // "centaur" is a discovered repo but not a component of ASM → absent
      mappable: { "account-service": "account-service" },
    });
  });

  it("reads the issue before the component list, so a dead token still re-gates the panel", async () => {
    clientStub.getDetail.mockRejectedValue(new JiraAuthError("nope"));
    const { send, posted } = setup();
    await send({ type: "detail", key: "ASM-1" });
    expect(clientStub.listComponents).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "state", authed: false }));
  });

  it("still reports the detail when the component list is unavailable — every chip is local-only", async () => {
    clientStub.listComponents.mockResolvedValue([]);
    const { send, posted } = setup();
    await send({ type: "detail", key: "ASM-1" });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "detail", key: "ASM-1", mappable: {} }));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/tasksView.test.ts -t "reports the issue's components"`
Expected: FAIL — the posted `detail` message has no `jiraComponents` or `mappable`.

- [ ] **Step 3: Extend the outbound message type**

In `src/types.ts`, replace the `detail` line (281):

```ts
  | { type: "detail"; key: string; descriptionText: string; inferred: string[]; repos: string[];
      // The components actually on the issue, spelled as Jira spells them, and the
      // repo → component map for every discovered repo. Together with `inferred`
      // these classify each chip: on the issue, pushable, or local-only.
      jiraComponents: string[]; mappable: Record<string, string> }
```

- [ ] **Step 4: Populate them in the detail handler**

In `src/tasksView.ts`, replace the body of the `case "detail":` block (lines 177-192):

```ts
        case "detail": {
          if (!(await this.auth.isAuthenticated())) return;
          const client = this.client();
          const detail = await client.getDetail(m.key);
          const repos = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
          const inferred = inferServices(
            { summary: detail.summary, descriptionText: detail.descriptionText, labels: detail.labels, components: detail.components },
            repos,
          ).map((r) => r.service.name);
          // After the issue read, never before: listComponents swallows every
          // failure including a 401, so the detail read is what lets a dead token
          // reach the catch below and re-gate the panel.
          const projectComponents = await client.listComponents();
          const names = repos.map((r) => r.name);
          this.post({
            type: "detail",
            key: m.key,
            descriptionText: detail.descriptionText,
            inferred,
            repos: names,
            jiraComponents: detail.components,
            mappable: mapRepoComponents(names, projectComponents),
          });
          break;
        }
```

Add the import at the top of `src/tasksView.ts`, beside the existing `inferServices` import (line 18):

```ts
import { mapRepoComponents } from "./engine/components";
```

- [ ] **Step 5: Fix the existing webview test's `detail` message**

`test/webview/App.test.tsx:707` sends a `detail` message that now lacks two required fields. Update that one call:

```ts
    host({ type: "detail", key: "ASM-1", descriptionText: "The full description", inferred: [], repos: ["centaur"], jiraComponents: [], mappable: {} });
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, both. If any other `host({ type: "detail" … })` call fails to typecheck, add `jiraComponents: []` and `mappable: {}` to it.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/tasksView.ts test/unit/tasksView.test.ts test/webview/App.test.tsx
git commit -m "feat(tasks): report a ticket's components and the repo→component map"
```

---

### Task 4: The host's `setComponent` write path

One chip per message, so a failure is attributable to exactly one chip. The handler owns its own error reporting and never throws, which keeps `onMessage`'s generic catch from double-toasting. It echoes `repo`, `on` and `movedChip` back verbatim with an `ok` verdict — that is what lets the webview undo precisely what it applied, without the host having to learn the ticket's pre-write component list (Jira's `PUT` returns `204 No Content`, so that would cost a second round trip on every toggle).

**Files:**
- Modify: `src/types.ts` — one inbound message (after `removeFromSprint`, line 258) and one outbound (after `removedFromSprint`, line 284)
- Modify: `src/tasksView.ts` — a `case` in `onMessage` (beside `removeFromSprint`, line 214) and a new `setComponent` method (place it after `removeFromSprint`)
- Test: `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `resolveComponent` from Task 1; `JiraClient.listComponents` and `updateComponents` from Task 2.
- Produces:
  - inbound `{ type: "setComponent"; key: string; repo: string; on: boolean; movedChip: boolean }`
  - outbound `{ type: "componentsChanged"; key: string; repo: string; on: boolean; movedChip: boolean; ok: boolean }`
  - `TasksViewProvider.setComponent(key: string, repo: string, on: boolean, movedChip: boolean): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/tasksView.test.ts`, after the `describe("detail"` block from Task 3:

```ts
describe("setComponent", () => {
  it("adds the component under the project's spelling and echoes ok", async () => {
    clientStub.listComponents.mockResolvedValue(["Account-Service"]);
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: true });
    expect(clientStub.updateComponents).toHaveBeenCalledWith("ASM-1", { add: ["Account-Service"] });
    expect(posted()).toContainEqual({
      type: "componentsChanged", key: "ASM-1", repo: "account-service", on: true, movedChip: true, ok: true,
    });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "success", message: "Added Account-Service to ASM-1" }));
  });

  it("removes the component and echoes ok", async () => {
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: false, movedChip: true });
    expect(clientStub.updateComponents).toHaveBeenCalledWith("ASM-1", { remove: ["account-service"] });
    expect(posted()).toContainEqual({
      type: "componentsChanged", key: "ASM-1", repo: "account-service", on: false, movedChip: true, ok: true,
    });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "success", message: "Removed account-service from ASM-1" }));
  });

  it("echoes movedChip: false back unchanged (a push leaves the chip where it is)", async () => {
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: false });
    expect(posted()).toContainEqual({
      type: "componentsChanged", key: "ASM-1", repo: "account-service", on: true, movedChip: false, ok: true,
    });
  });

  it("stamps the provenance label", async () => {
    const { send } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: true });
    expect(clientStub.addLabel).toHaveBeenCalledWith("ASM-1", "claude-code");
  });

  it("skips the label stamp when stampLabelOnWrite is off", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, stampLabelOnWrite: false });
    const { send } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: true });
    expect(clientStub.addLabel).not.toHaveBeenCalled();
  });

  it("still succeeds when the label stamp fails", async () => {
    clientStub.addLabel.mockRejectedValue(new Error("label 500"));
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: true });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "componentsChanged", ok: true }));
  });

  // A 400, not a 403: `JiraClient.request` converts every 401 *and* 403 into
  // JiraAuthError, so a permission refusal re-gates the panel and never reaches
  // this branch. The reachable JiraApiError here is a rejected component name —
  // e.g. one that vanished from the project since the cache was filled.
  it("echoes ok: false with an actionable toast when Jira rejects the write", async () => {
    clientStub.updateComponents.mockRejectedValue(parseJiraError(400, JSON.stringify({ errorMessages: ["Component name is not valid"], errors: {} })));
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: true });
    expect(posted()).toContainEqual({
      type: "componentsChanged", key: "ASM-1", repo: "account-service", on: true, movedChip: true, ok: false,
    });
    expect(posted()).toContainEqual(expect.objectContaining({
      type: "toast", level: "error", action: { label: "Open in Jira", url: "https://jira/browse/ASM-1" },
    }));
    expect(clientStub.addLabel).not.toHaveBeenCalled();
  });

  // Covers a permission refusal too: request() converts every 401 and 403 into
  // JiraAuthError, so this is the branch a refused write actually takes.
  it("echoes ok: false and re-gates the panel on an auth failure, posting no toast", async () => {
    clientStub.updateComponents.mockRejectedValue(new JiraAuthError("token dead"));
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: true });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "componentsChanged", ok: false }));
    expect(posted()).toContainEqual(expect.objectContaining({ type: "state", authed: false }));
    // Re-gating to the sign-in screen is itself the indication — a toast on top
    // would be noise, and the panel is already replaced.
    expect(posted().filter((p) => p.type === "toast")).toEqual([]);
  });

  it("writes nothing and echoes ok: false when the project has no such component", async () => {
    clientStub.listComponents.mockResolvedValue(["Infra"]);
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "scratch-tool", on: true, movedChip: true });
    expect(clientStub.updateComponents).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "componentsChanged", ok: false }));
    expect(posted()).toContainEqual(expect.objectContaining({
      type: "toast", level: "error", message: "ASM has no component named “scratch-tool”.",
    }));
  });

  // An unreadable list is not the same claim as "no such component" — listComponents
  // swallows a rejected token and returns [], and blaming the repo name for that
  // sends the user looking in the wrong place.
  it("blames the connection, not the repo, when the component list came back empty", async () => {
    clientStub.listComponents.mockResolvedValue([]);
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: true });
    expect(clientStub.updateComponents).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "componentsChanged", ok: false }));
    expect(posted()).toContainEqual(expect.objectContaining({
      type: "toast", level: "error",
      message: "Couldn't read ASM's components from Jira. Check the connection and try again.",
    }));
  });

  it("echoes ok: false and re-gates when not signed in, without touching Jira", async () => {
    const { send, posted } = setup({ authed: false });
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: true });
    expect(clientStub.updateComponents).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "componentsChanged", ok: false }));
    expect(posted()).toContainEqual(expect.objectContaining({ type: "state", authed: false }));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts -t "setComponent"`
Expected: FAIL — TypeScript rejects the unknown message type, and no `componentsChanged` is posted.

- [ ] **Step 3: Add both message types**

In `src/types.ts`, in `InboundMessage` after the `removeFromSprint` line (258):

```ts
  // One chip on one ticket. `movedChip` says whether the chip's presence in the
  // list changed too — which is what makes a rejected write exactly undoable.
  | { type: "setComponent"; key: string; repo: string; on: boolean; movedChip: boolean }
```

In `OutboundMessage` after the `removedFromSprint` line (284):

```ts
  // The verdict on one `setComponent`: the request echoed back, plus whether it
  // landed. On `ok: false` the webview undoes exactly what it applied optimistically.
  | { type: "componentsChanged"; key: string; repo: string; on: boolean; movedChip: boolean; ok: boolean }
```

- [ ] **Step 4: Route the message**

In `src/tasksView.ts`, in `onMessage`'s switch, after the `removeFromSprint` case (lines 214-217):

```ts
        case "setComponent": {
          await this.setComponent(m.key, m.repo, m.on, m.movedChip);
          break;
        }
```

- [ ] **Step 5: Write the handler**

In `src/tasksView.ts`, after the `removeFromSprint` method. Extend the existing import from Task 3 to `import { mapRepoComponents, resolveComponent } from "./engine/components";`:

```ts
  /** Add or remove one component on a ticket, mirroring one chip in the card (a Jira
   * WRITE). Reports its own failures and never throws, so `onMessage`'s catch cannot
   * double-toast; every call posts exactly one `componentsChanged`, which is the
   * webview's cue to keep or undo its optimistic update. */
  public async setComponent(key: string, repo: string, on: boolean, movedChip: boolean): Promise<void> {
    const cfg = getConfig();
    const echo = (ok: boolean) => this.post({ type: "componentsChanged", key, repo, on, movedChip, ok });
    if (!(await this.auth.isAuthenticated())) {
      this.postState(false, !!cfg.baseUrl && !!cfg.project, null);
      echo(false);
      return;
    }
    const client = this.client();
    const components = await client.listComponents();
    const name = resolveComponent(repo, components);
    if (!name) {
      // The webview only sends repos it believes are components, so this means the
      // list moved under us — or never loaded. An empty list cannot tell those apart
      // (listComponents swallows every failure, a rejected token included), so it
      // must not be reported as "no such component". Nothing was written either way.
      echo(false);
      if (components.length === 0) {
        this.log(`setComponent ${key}: ${cfg.project} component list unavailable`);
        this.toast("error", `Couldn't read ${cfg.project}'s components from Jira. Check the connection and try again.`);
      } else {
        this.log(`setComponent ${key}: no ${cfg.project} component named ${repo}`);
        this.toast("error", `${cfg.project} has no component named “${repo}”.`);
      }
      return;
    }
    try {
      await client.updateComponents(key, on ? { add: [name] } : { remove: [name] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`setComponent ${key}: ${on ? "add" : "remove"} ${name} failed — ${msg}`);
      echo(false);
      if (e instanceof JiraAuthError) {
        this.postState(false, !!cfg.baseUrl && !!cfg.project, null);
        return;
      }
      this.toast("error", msg, { label: "Open in Jira", url: `${cfg.baseUrl}/browse/${key}` });
      return;
    }
    this.log(`setComponent ${key}: ${on ? "add" : "remove"} ${name} ok`);
    if (cfg.stampLabelOnWrite) {
      try {
        await client.addLabel(key, cfg.provenanceLabel);
      } catch (e) {
        this.log(`label stamp failed for ${key}: ${e}`);
      }
    }
    echo(true);
    this.toast("success", on ? `Added ${name} to ${key}` : `Removed ${name} from ${key}`);
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/unit/tasksView.test.ts && npm run typecheck`
Expected: PASS, both.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(tasks): write one component per chip toggle, echoing a verdict"
```

---

### Task 5: Render the three chip states

Presentation only — no messages are sent and no `↑` exists yet. This task's whole deliverable is that a chip **says** whether it's on the ticket: the dashed border carries that with no hint line and no red, per the panel's conventions. The push affordance and every write belong to Task 6, so nothing here is inert.

**Files:**
- Modify: `src/webview/App.tsx` — `DetailState` (24-29), the `detail` case (208-213), `TaskCard`'s collapsed chips (715-717) and its `CardDetail` call (722), and `CardDetail` itself (727-752)
- Modify: `src/webview/App.tsx` — the `TaskCard` render site (487-511) to pass `project`
- Modify: `src/webview/styles.ts` — after the `.chip .x:hover` rule (196)
- Test: `test/webview/App.test.tsx`

**Interfaces:**
- Consumes: the `detail` message fields from Task 3.
- Produces:
  - `DetailState` with `jira?: string[]` and `mappable?: Record<string, string>`
  - `CardDetail` props `{ taskKey: string; project: string; detail?: DetailState; onSelect: (s: string[]) => void }` — Task 6 adds `onPush`
  - `TaskCard` props gain `project: string` — Task 6 adds `onPush`
  - CSS class `chip off-ticket`

- [ ] **Step 1: Write the failing tests**

Add to `test/webview/App.test.tsx`, inside the same `describe` that holds `withTask` (the one containing "shows ticket detail once it arrives"):

```ts
  /** Expand ASM-1 and deliver a detail. `jiraComponents` / `mappable` decide the
   *  chip states: account-service is on the ticket (A), pricing-api maps but is not
   *  on it (B), scratch-tool maps to nothing (C). */
  const withChips = (over: Partial<{ inferred: string[]; jiraComponents: string[]; mappable: Record<string, string> }> = {}) => {
    withTask(mkTask({ key: "ASM-1", summary: "Fix bug" }));
    fireEvent.click(screen.getByText("Fix bug"));
    host({
      type: "detail",
      key: "ASM-1",
      descriptionText: "desc",
      repos: ["account-service", "pricing-api", "scratch-tool", "centaur"],
      inferred: over.inferred ?? ["account-service", "pricing-api", "scratch-tool"],
      jiraComponents: over.jiraComponents ?? ["Account-Service"],
      mappable: over.mappable ?? { "account-service": "Account-Service", "pricing-api": "Pricing-Api", centaur: "Centaur" },
    });
  };

  const chipFor = (name: string): HTMLElement =>
    [...document.querySelectorAll(".chips .chip")].find((c) => c.textContent?.startsWith(name)) as HTMLElement;

  it("renders a chip that is on the ticket as solid, with a Jira-removing × ", () => {
    withChips();
    const chip = chipFor("account-service");
    expect(chip.className).not.toContain("off-ticket");
    expect(chip).not.toHaveAttribute("title");
    expect(within(chip).getByTitle("Remove Account-Service from ASM-1")).toBeInTheDocument();
    expect(within(chip).queryByText("↑")).not.toBeInTheDocument();
  });

  it("renders a mappable chip that is not on the ticket as dashed", () => {
    withChips();
    const chip = chipFor("pricing-api");
    expect(chip.className).toContain("off-ticket");
    expect(chip).toHaveAttribute("title", "Not on ASM-1 in Jira");
    // The × is local-only here: there is no component on the ticket to remove.
    expect(within(chip).getByTitle("Remove")).toBeInTheDocument();
  });

  it("renders an unmappable chip as dashed with no push, and says why", () => {
    withChips();
    const chip = chipFor("scratch-tool");
    expect(chip.className).toContain("off-ticket");
    expect(chip).toHaveAttribute("title", "No ASM component named “scratch-tool” — this selection stays local");
    expect(within(chip).queryByText("↑")).not.toBeInTheDocument();
    expect(within(chip).getByTitle("Remove")).toBeInTheDocument();
  });

  it("collapsed service chips follow the edited list, not the original guess", () => {
    withChips({ inferred: ["pricing-api"] });
    fireEvent.click(screen.getByText("Fix bug")); // collapse
    const meta = document.querySelector(".meta") as HTMLElement;
    expect(within(meta).getByText("pricing-api")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/webview/App.test.tsx -t "chip"`
Expected: FAIL — no `off-ticket` class and no per-state titles.

- [ ] **Step 3: Extend `DetailState` and the `detail` reducer**

In `src/webview/App.tsx`, replace `DetailState` (24-29):

```ts
interface DetailState {
  loading: boolean;
  descriptionText?: string;
  repos?: string[];
  selected?: string[];
  jira?: string[]; // components on the ticket, spelled as Jira spells them
  mappable?: Record<string, string>; // repo name → canonical component name
}
```

Replace the `case "detail":` block (208-213):

```ts
        case "detail":
          setDetails((prev) => ({
            ...prev,
            [m.key]: {
              loading: false,
              descriptionText: m.descriptionText,
              repos: m.repos,
              selected: m.inferred,
              jira: m.jiraComponents,
              mappable: m.mappable,
            },
          }));
          break;
```

- [ ] **Step 4: Pass `project` through `TaskCard`**

In the `TaskCard` render site (487-511), add one prop after `detail={details[t.key]}`:

```tsx
            project={project}
```

In `TaskCard`'s props type (573-584) add `project: string;`, and destructure it in the body (585).

Replace the collapsed service chips (715-717) so they follow the edited list:

```tsx
            {/* The edited list once the card has been opened — the collapsed and
                expanded views must not disagree about what Take will open. */}
            {(detail?.selected ?? task.services ?? []).map((s) => (
              <span key={s} className="svc guess">{s}</span>
            ))}
```

Replace the `CardDetail` call (722):

```tsx
      {open && <CardDetail taskKey={task.key} project={project} detail={detail} onSelect={onSelect} />}
```

- [ ] **Step 5: Classify the chips in `CardDetail`**

Replace `CardDetail` entirely (727-752):

```tsx
function CardDetail(props: {
  taskKey: string;
  project: string;
  detail?: DetailState;
  onSelect: (s: string[]) => void;
}): JSX.Element {
  const { taskKey, project, detail, onSelect } = props;
  if (!detail || detail.loading) return <div className="detail"><div className="detail-loading">Loading ticket…</div></div>;

  const selected = detail.selected ?? [];
  const jira = detail.jira ?? [];
  const mappable = detail.mappable ?? {};
  const available = (detail.repos ?? []).filter((r) => !selected.includes(r));
  const remove = (name: string) => onSelect(selected.filter((s) => s !== name));
  const add = (name: string) => { if (name) onSelect([...selected, name]); };

  return (
    <div className="detail">
      <div className="desc">{detail.descriptionText?.trim() || "No description on the ticket."}</div>
      <div className="sel-label">Repos this task touches</div>
      <div className="chips">
        {selected.length === 0 && <span className="chip-none">none selected</span>}
        {selected.map((s) => {
          // Three states: on the ticket (solid), a component the ticket lacks
          // (dashed — Task 6 gives it a push), or no component at all (dashed,
          // local-only). Only the first can be removed from Jira.
          const component = mappable[s];
          const onTicket = !!component && jira.includes(component);
          return (
            <span
              key={s}
              className={`chip${onTicket ? "" : " off-ticket"}`}
              title={
                onTicket
                  ? undefined
                  : component
                    ? `Not on ${taskKey} in Jira`
                    : `No ${project} component named “${s}” — this selection stays local`
              }
            >
              {s}
              <span
                className="x"
                title={onTicket ? `Remove ${component} from ${taskKey}` : "Remove"}
                onClick={() => remove(s)}
              >×</span>
            </span>
          );
        })}
      </div>
      <RepoPicker available={available} onAdd={add} />
    </div>
  );
}
```

- [ ] **Step 6: Add the CSS**

In `src/webview/styles.ts`, after the `.chip .x:hover` rule (196):

```
  /* Off the ticket — inferred but never recorded on the issue, or no component at
     all. The dashed outline carries that on its own; the padding drops 1px to
     absorb the border so chips don't change size between states. */
  .chip.off-ticket { background: transparent; padding: 1px 4px 1px 7px;
    border: 1px dashed var(--vscode-badge-background); color: var(--vscode-descriptionForeground); }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/webview/App.test.tsx && npm run typecheck`
Expected: PASS, both.

- [ ] **Step 8: Commit**

```bash
git add src/webview/App.tsx src/webview/styles.ts test/webview/App.test.tsx
git commit -m "feat(tasks): show which repo chips are on the ticket and which aren't"
```

---

### Task 6: Wire the three writes and their undos

The webview is the only place that knows a chip's state, so it decides what is worth a message: adding a mappable repo, `↑` on a state-B chip, and `×` on a state-A chip. State-B and state-C removals send nothing — there is no component to remove. Each write updates state optimistically and is undone verbatim if the host echoes `ok: false`.

**Files:**
- Modify: `src/webview/helpers.ts` — add `addOnce`
- Modify: `src/webview/App.tsx` — `setSelected` (283-284), a new `pushComponent` beside it, the `↑` in `CardDetail` plus its `onPush` threading through `TaskCard`, and a `componentsChanged` case in the message reducer (after `removedFromSprint`, 228-230)
- Modify: `src/webview/styles.ts` — the `.chip .up` rules, after the `.chip.off-ticket` rule Task 5 added
- Test: `test/webview/helpers.test.ts`
- Test: `test/webview/App.test.tsx` — new cases, plus the state-B title assertion Task 5 wrote

**Interfaces:**
- Consumes: `DetailState`, `withChips` / `chipFor` test helpers, and the `off-ticket` CSS from Task 5; the `componentsChanged` message from Task 4.
- Produces:
  - `addOnce(xs: string[], x: string): string[]` from `src/webview/helpers.ts`
  - `CardDetail` and `TaskCard` props gain `onPush: (repo: string) => void`

- [ ] **Step 1: Write the failing tests**

In `test/webview/helpers.test.ts`, add:

```ts
describe("addOnce", () => {
  it("appends a value that is absent", () => {
    expect(addOnce(["a"], "b")).toEqual(["a", "b"]);
  });

  it("returns the same array reference when the value is already present", () => {
    const xs = ["a", "b"];
    expect(addOnce(xs, "a")).toBe(xs);
  });
});
```

…and add `addOnce` to that file's existing import from `../../src/webview/helpers`.

In `test/webview/App.test.tsx`, add to the describe holding `withChips`:

```ts
  /** Add a repo the way a user does: open the RepoPicker, filter to one match,
   *  press Enter. Its rows commit on mouseDown rather than click, so filtering and
   *  Enter is both simpler and closer to real use. */
  const pick = (repo: string) => {
    fireEvent.click(screen.getByText(/add repo/i));
    const input = screen.getByPlaceholderText(/Filter repos/i);
    fireEvent.change(input, { target: { value: repo } });
    fireEvent.keyDown(input, { key: "Enter" });
  };

  it("writes an add when a mappable repo is picked, moving the chip too", () => {
    withChips();
    sent.mockClear();
    pick("centaur");
    expect(sent).toHaveBeenCalledWith({ type: "setComponent", key: "ASM-1", repo: "centaur", on: true, movedChip: true });
    // Optimistic: the new chip is already solid, before any verdict.
    expect(chipFor("centaur").className).not.toContain("off-ticket");
  });

  it("sends nothing when an unmappable repo is picked, and marks it local-only", () => {
    withChips({ inferred: [], mappable: { centaur: "Centaur" } });
    sent.mockClear();
    pick("scratch-tool");
    expect(sent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "setComponent" }));
    expect(chipFor("scratch-tool").className).toContain("off-ticket");
  });

  it("pushes a state-B chip without moving it, and shows it solid at once", () => {
    withChips();
    sent.mockClear();
    fireEvent.click(within(chipFor("pricing-api")).getByTitle("Add Pricing-Api to ASM-1"));
    expect(sent).toHaveBeenCalledWith({ type: "setComponent", key: "ASM-1", repo: "pricing-api", on: true, movedChip: false });
    expect(chipFor("pricing-api").className).not.toContain("off-ticket");
  });

  it("writes a remove when a state-A chip is dismissed", () => {
    withChips();
    sent.mockClear();
    fireEvent.click(within(chipFor("account-service")).getByTitle("Remove Account-Service from ASM-1"));
    expect(sent).toHaveBeenCalledWith({ type: "setComponent", key: "ASM-1", repo: "account-service", on: false, movedChip: true });
    expect(chipFor("account-service")).toBeUndefined();
  });

  it("sends nothing when a state-B or state-C chip is dismissed", () => {
    withChips();
    sent.mockClear();
    fireEvent.click(within(chipFor("pricing-api")).getByTitle("Remove"));
    fireEvent.click(within(chipFor("scratch-tool")).getByTitle("Remove"));
    expect(sent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "setComponent" }));
    expect(chipFor("pricing-api")).toBeUndefined();
    expect(chipFor("scratch-tool")).toBeUndefined();
  });

  it("keeps the optimistic state when the host reports ok", () => {
    withChips();
    fireEvent.click(within(chipFor("pricing-api")).getByTitle("Add Pricing-Api to ASM-1"));
    host({ type: "componentsChanged", key: "ASM-1", repo: "pricing-api", on: true, movedChip: false, ok: true });
    expect(chipFor("pricing-api").className).not.toContain("off-ticket");
  });

  it("undoes a rejected push — the chip goes dashed again but stays in the list", () => {
    withChips();
    fireEvent.click(within(chipFor("pricing-api")).getByTitle("Add Pricing-Api to ASM-1"));
    host({ type: "componentsChanged", key: "ASM-1", repo: "pricing-api", on: true, movedChip: false, ok: false });
    expect(chipFor("pricing-api").className).toContain("off-ticket");
  });

  it("undoes a rejected picker add — the chip disappears again", () => {
    withChips();
    pick("centaur");
    host({ type: "componentsChanged", key: "ASM-1", repo: "centaur", on: true, movedChip: true, ok: false });
    expect(chipFor("centaur")).toBeUndefined();
  });

  it("undoes a rejected remove — the chip comes back solid", () => {
    withChips();
    fireEvent.click(within(chipFor("account-service")).getByTitle("Remove Account-Service from ASM-1"));
    host({ type: "componentsChanged", key: "ASM-1", repo: "account-service", on: false, movedChip: true, ok: false });
    expect(chipFor("account-service")).toBeDefined();
    expect(chipFor("account-service").className).not.toContain("off-ticket");
  });

  it("ignores a verdict for a ticket with no loaded detail", () => {
    withChips();
    expect(() =>
      host({ type: "componentsChanged", key: "ASM-99", repo: "centaur", on: true, movedChip: true, ok: false }),
    ).not.toThrow();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/webview/App.test.tsx test/webview/helpers.test.ts`
Expected: FAIL — nothing is sent, and `addOnce` does not exist. (Filtering with
`-t "setComponent"` would match nothing: no test *title* contains that string,
and vitest reports "no tests found" rather than a failure, which proves nothing.)

- [ ] **Step 3: Add `addOnce`**

At the end of `src/webview/helpers.ts`:

```ts
/** Append `x` unless it's already there, returning the original array when it is —
 *  so an unchanged list keeps its reference and React skips the re-render. */
export function addOnce(xs: string[], x: string): string[] {
  return xs.includes(x) ? xs : [...xs, x];
}
```

Add it to the existing `helpers` import in `src/webview/App.tsx` (line 4).

- [ ] **Step 4: Send from `setSelected`**

Replace `setSelected` (283-284) in `src/webview/App.tsx`:

```tsx
  /** Apply a chip-list edit, writing whatever part of it Jira can accept. Adding a
   * repo the project has a component for pushes it; removing a chip only writes when
   * that component is actually on the ticket — a chip inferred from a label or a text
   * mention has nothing to remove. Both changes are optimistic; `componentsChanged`
   * with `ok: false` undoes them. */
  const setSelected = (key: string, selected: string[]) => {
    const d = details[key];
    const mappable = d?.mappable ?? {};
    const before = d?.selected ?? [];
    const added = selected.filter((s) => !before.includes(s));
    const removed = before.filter((s) => !selected.includes(s));
    let jira = d?.jira ?? [];
    for (const repo of added) {
      const component = mappable[repo];
      if (!component) continue;
      send({ type: "setComponent", key, repo, on: true, movedChip: true });
      jira = addOnce(jira, component);
    }
    for (const repo of removed) {
      const component = mappable[repo];
      if (!component || !jira.includes(component)) continue;
      send({ type: "setComponent", key, repo, on: false, movedChip: true });
      jira = jira.filter((c) => c !== component);
    }
    setDetails((prev) => ({ ...prev, [key]: { ...prev[key], selected, jira } }));
  };
```

- [ ] **Step 5: Add `pushComponent`**

Beside `setSelected`:

```tsx
  /** `↑` on a chip whose component the ticket lacks: write it, and show it as
   * on-ticket at once. The chip itself doesn't move, hence `movedChip: false`. */
  const pushComponent = (key: string, repo: string) => {
    const component = details[key]?.mappable?.[repo];
    if (!component) return;
    send({ type: "setComponent", key, repo, on: true, movedChip: false });
    setDetails((prev) => ({
      ...prev,
      [key]: { ...prev[key], jira: addOnce(prev[key]?.jira ?? [], component) },
    }));
  };
```

- [ ] **Step 6: Add the `↑` affordance**

Task 5 left a state-B chip dashed but with nothing to click. Thread the handler down and render it.

At the `TaskCard` render site, beside the `project={project}` prop Task 5 added:

```tsx
            onPush={(repo) => pushComponent(t.key, repo)}
```

In `TaskCard`'s props type add `onPush: (repo: string) => void;`, destructure it, and pass it on:

```tsx
      {open && <CardDetail taskKey={task.key} project={project} detail={detail} onSelect={onSelect} onPush={onPush} />}
```

In `CardDetail`, add `onPush: (repo: string) => void;` to the props type and `onPush` to the destructure, then render the `↑` between the chip's name and its `×`:

```tsx
              {s}
              {!onTicket && component && (
                <span className="up" title={`Add ${component} to ${taskKey}`} onClick={() => onPush(s)}>↑</span>
              )}
```

Extend the state-B title now that the affordance exists — `` `Not on ${taskKey} in Jira` `` becomes:

```tsx
                    ? `Not on ${taskKey} in Jira — ↑ adds it`
```

Update the Task 5 test that asserted the old wording:

```ts
    expect(chip).toHaveAttribute("title", "Not on ASM-1 in Jira — ↑ adds it");
```

And add the affordance's CSS to `src/webview/styles.ts`, after the `.chip.off-ticket` rule:

```
  .chip .up { cursor: pointer; opacity: .65; font-size: 11px; line-height: 1; }
  .chip .up:hover { opacity: 1; }
```

- [ ] **Step 7: Handle the verdict**

In `src/webview/App.tsx`, after the `case "removedFromSprint":` block (228-230):

```tsx
        case "componentsChanged":
          // On success the optimistic update already stands. On failure, undo
          // exactly what was applied: `on` says which direction, `movedChip`
          // whether the chip's own presence changed with it.
          if (m.ok) break;
          setDetails((prev) => {
            const d = prev[m.key];
            if (!d) return prev;
            const component = d.mappable?.[m.repo] ?? m.repo;
            const jira = d.jira ?? [];
            const selected = d.selected ?? [];
            return {
              ...prev,
              [m.key]: {
                ...d,
                jira: m.on ? jira.filter((c) => c !== component) : addOnce(jira, component),
                selected: !m.movedChip
                  ? selected
                  : m.on
                    ? selected.filter((s) => s !== m.repo)
                    : addOnce(selected, m.repo),
              },
            };
          });
          break;
```

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, both.

- [ ] **Step 9: Commit**

```bash
git add src/webview/App.tsx src/webview/helpers.ts src/webview/styles.ts test/webview/App.test.tsx test/webview/helpers.test.ts
git commit -m "feat(tasks): push repo-chip edits to the ticket's components"
```

---

### Task 7: Coverage and a live check

**Files:**
- Modify: whichever files coverage shows are short.

- [ ] **Step 1: Check coverage on the changed files**

Run: `npx vitest run --coverage`
The repo's bar is ≥95% on changed files. Read the report rows for `src/engine/components.ts`, `src/jira/client.ts`, `src/tasksView.ts`, `src/webview/App.tsx` and `src/webview/helpers.ts`.

- [ ] **Step 2: Close any gap with a test, not with a coverage pragma**

Add cases for the specific uncovered lines. Commit them:

```bash
git add -A test
git commit -m "test: cover the remaining component-sync branches"
```

- [ ] **Step 3: Build and exercise it against real Jira**

```bash
npm run build
```

Then load the extension, open the task panel, expand a ticket and confirm each state by hand — no test can stand in for Jira's own validation of a component write:

1. A chip already on the ticket is solid; `×` removes the component in Jira (check the ticket).
2. A chip inferred from a label is dashed; `↑` adds the component in Jira and the chip goes solid.
3. A repo with no matching component is dashed with no `↑`; `×` only drops it locally.
4. The ticket's non-repo components (`Infra`) survive every one of the above.
5. The success toast names the component as Jira spells it.

- [ ] **Step 4: Report what the live check showed**

State plainly which of the five held and which did not. A failure here is a real finding, not a test to adjust.

---

## Self-Review

**Spec coverage.** Every section maps to a task: the sync contract and its A/B/C states → Tasks 1, 5, 6; `listComponents` / `updateComponents` incl. the TTL and the `[]` degradation → Task 2; `src/engine/components.ts` → Task 1; the `detail` additions → Task 3; `setComponent` / `componentsChanged` and the `movedChip` undo table → Tasks 4 and 6; the collapsed-chip agreement → Task 5 Step 4; the UI states, titles and dashed treatment → Task 5, with the `↑` affordance in Task 6 (Task 5 deliberately ships no inert button); the error-handling table → Task 4 (all four rows have a test); the testing section → Tasks 1-6, with Task 7 for the coverage bar and the live check. Out-of-scope items (creating components, labels, the Deck) appear in no task.

**Type consistency.** `resolveComponent` and `mapRepoComponents` keep the same signatures in Tasks 1, 3 and 4. `setComponent` / `componentsChanged` carry the same four fields (`key`, `repo`, `on`, `movedChip`) everywhere they appear, in Tasks 4 and 6. `DetailState.jira` and `.mappable` are introduced in Task 5 and consumed under those names in Task 6. `addOnce` has one signature, used in three places.

**Placeholder scan.** No step defers work. The two places that could have — "handle the error cases" and "add tests for the picker" — are written out: Task 4's handler shows all four failure branches, and Task 6's `pick` helper matches the RepoPicker's real trigger text and its Enter-to-commit path (its rows fire on `mouseDown`, so clicking them would silently do nothing).
