# Pluggable Task Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a seam under ticket fetching so a contributor can add a second task source by writing one directory and registering one line, with Jira remaining the default and only shipped connector.

**Architecture:** Two interfaces in `src/tasks/provider.ts` — `TaskConnector` (lifecycle: configure, sign in, probe, describe) and `TaskProvider` (per-operation reads and writes). Everything Jira-idiosyncratic (sprints, components, labels, transition screen fields) is a declared capability held as an *object* on `caps`, so "supported" and "callable" are the same fact. `src/jira/` moves to `src/tasks/jira/`, where a thin `JiraProvider` adapter wraps the untouched `JiraClient`. A registry maps `agentFlow.taskSource` → connector.

**Tech Stack:** TypeScript, VS Code extension API, React webviews, esbuild, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-05-pluggable-task-connectors-design.md`

## Global Constraints

- **THE HARD CONSTRAINT: no existing Jira user may observe any change.** No re-sign-in, no re-run wizard, no settings migration, no lost board. Task 1 pins this before anything moves; every later task must keep Task 1's tests green **without weakening a single assertion**. An assertion you have to relax is a real regression, not a stale test.
- These strings are **frozen** and must appear verbatim in the final code: SecretStorage keys `agentFlow.jira.email` / `agentFlow.jira.token`; settings `agentFlow.jira.baseUrl` / `agentFlow.jira.project`; globalState `agentFlow.setupComplete`; workspaceState `agentFlow.sprintOrder`; the `/browse/` URL marker; command ids `agentFlow.refresh` `setup` `doctor` `signIn` `signOut` `takeTask` `openDeck` `openMarketplace`; setting key `agentFlow.explorePrompts.jiraTicket`.
- These are **transmitted telemetry values** and must not be renamed even though the surrounding code becomes generic: `Op` members `"jira_fetch"` / `"jira_write"` / `"jira_auth"`; the `extension_activated` property `has_jira_auth`. Renaming either breaks an analytics series.
- Every `DEFAULT_*_PROMPT` in `src/config.ts` stays **byte-identical**, including its "Jira {key}" wording. Two parity tests already assert `config.ts` matches `package.json` defaults; do not touch either default.
- Command titles `Sign in to Jira` / `Sign out of Jira` in `package.json` stay literal. `package.json` titles cannot be templated.
- Every error subclass sets `this.name` to a **string literal**, never relying on the class identifier: `esbuild.js` runs `minify: true` without `keepNames`, so identifiers are renamed in production. See `src/jira/client.ts:9-17`.
- `src/telemetry/events.ts` is a leaf module with **no imports from `src/tasks/`** (it must stay importable in isolation — see its own comment at lines 33-38). It checks error `.name` as string literals only.
- Gates, all of which must pass: `npm run typecheck`, `npm test`, `npm run test:cov` (V8 thresholds **statements 90, branches 85, functions 85, lines 90**), `npm run build`. `src/types.ts` is coverage-excluded; `src/tasks/**` is **not** and must carry real tests.
- `vscode` is mocked at `test/_mocks/vscode.ts`. No test may reach a real Jira site, filesystem, or `gh` binary.
- Add a `## [Unreleased]` entry to `CHANGELOG.md` (Task 14) — `agentFlow.taskSource` is user-facing.

---

## File Structure

**Created**
| File | Responsibility |
|---|---|
| `src/tasks/provider.ts` | `TaskProvider`, `TaskConnector`, `Capabilities`, `StatusTarget`, `SourceInfo`, task-level errors. No `vscode` import. |
| `src/tasks/registry.ts` | `CONNECTORS` map, `CONNECTOR_IDS`, `resolveConnector()`. |
| `src/tasks/jira/connector.ts` | `JiraConnector implements TaskConnector` — owns the frozen keys, wizard steps, probe, url parsing. |
| `src/tasks/jira/provider.ts` | `JiraProvider implements TaskProvider` — adapter over `JiraClient`; owns `toJiraValue` and the transition recovery. |
| `test/_helpers/fixtureConnector.ts` | Second complete connector, zero optional capabilities. |
| `docs/CONNECTORS.md` | Contributor guide. |

**Moved** (`git mv`, imports updated, behaviour untouched): `src/jira/{client,auth,jql,errors,transitionFields}.ts` → `src/tasks/jira/`; `test/unit/jira/*` → `test/unit/tasks/jira/*`.

**Modified:** `src/types.ts`, `src/config.ts`, `src/tasksView.ts`, `src/deckView.ts`, `src/doctorView.ts`, `src/setup.ts`, `src/extension.ts`, `src/engine/{doctor,status,retire}.ts`, `src/telemetry/{events,settingsSnapshot}.ts`, `src/webview/{App.tsx,helpers.ts}`, `test/_helpers/factories.ts`, `package.json`, `CONTRIBUTING.md`, `CHANGELOG.md`.

---

## Task 1: Pin the compatibility surface

Nothing moves in this task. It writes the tests that make the rest of the plan safe, **green against today's unmodified code**.

**Files:**
- Create: `test/unit/compat.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. Produces the safety net every later task must keep green.

- [ ] **Step 1: Write the characterization test**

```ts
// test/unit/compat.test.ts
import { describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ApiTokenAuth } from "../../src/jira/auth";
import { SETUP_COMPLETE_KEY } from "../../src/setup";
import { ticketKeyFor } from "../../src/types";
import { makeRun } from "../_helpers/factories";

/** These assertions encode promises made to users who already have Agent Flow
 * installed and configured. Breaking one silently signs them out, re-runs their
 * wizard, or empties their board. If a refactor makes one of these fail, the
 * refactor is wrong — do not update the test. */
describe("compatibility surface (frozen)", () => {
  it("reads and writes exactly the two released SecretStorage keys", async () => {
    const store = new Map<string, string>();
    const secrets = {
      get: vi.fn(async (k: string) => store.get(k)),
      store: vi.fn(async (k: string, v: string) => void store.set(k, v)),
      delete: vi.fn(async (k: string) => void store.delete(k)),
    };
    const auth = new ApiTokenAuth(secrets as never);

    await auth.getAuthHeader();
    expect(secrets.get.mock.calls.map((c) => c[0]).sort()).toEqual([
      "agentFlow.jira.email",
      "agentFlow.jira.token",
    ]);

    await auth.signOut();
    expect(secrets.delete.mock.calls.map((c) => c[0]).sort()).toEqual([
      "agentFlow.jira.email",
      "agentFlow.jira.token",
    ]);
  });

  it("produces Basic auth from the stored email and token", async () => {
    const store = new Map([
      ["agentFlow.jira.email", "you@example.com"],
      ["agentFlow.jira.token", "tok"],
    ]);
    const auth = new ApiTokenAuth({
      get: async (k: string) => store.get(k),
      store: async () => undefined,
      delete: async () => undefined,
    } as never);
    const expected = `Basic ${Buffer.from("you@example.com:tok").toString("base64")}`;
    expect(await auth.getAuthHeader()).toBe(expected);
  });

  it("keeps the released globalState and workspaceState keys", () => {
    expect(SETUP_COMPLETE_KEY).toBe("agentFlow.setupComplete");
    // Read from source: SPRINT_ORDER_KEY is module-private by design.
    const src = fs.readFileSync(path.join(__dirname, "../../src/tasksView.ts"), "utf8");
    expect(src).toContain('"agentFlow.sprintOrder"');
  });

  it("recovers a ticket key from a run url already on disk", () => {
    expect(ticketKeyFor(makeRun({ key: "ABC-1", url: "https://x.atlassian.net/browse/ABC-1" })))
      .toBe("ABC-1");
    // A record whose key is a place-hash still resolves via its url.
    expect(ticketKeyFor(makeRun({ key: "a1b2c3", url: "https://x.atlassian.net/browse/ABC-9" })))
      .toBe("ABC-9");
    // No url marker: fall back to the record key.
    expect(ticketKeyFor(makeRun({ key: "explore-foo", url: "" }))).toBe("explore-foo");
  });

  it("keeps the released settings and command ids in the manifest", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
    ) as {
      contributes: {
        configuration: { properties: Record<string, unknown> };
        commands: { command: string }[];
      };
    };
    const props = Object.keys(pkg.contributes.configuration.properties);
    for (const id of [
      "agentFlow.jira.baseUrl",
      "agentFlow.jira.project",
      "agentFlow.explorePrompts.jiraTicket",
    ]) {
      expect(props).toContain(id);
    }
    expect(pkg.contributes.commands.map((c) => c.command).sort()).toEqual([
      "agentFlow.doctor",
      "agentFlow.openDeck",
      "agentFlow.openMarketplace",
      "agentFlow.refresh",
      "agentFlow.setup",
      "agentFlow.signIn",
      "agentFlow.signOut",
      "agentFlow.takeTask",
    ]);
  });

  it("keeps the transmitted telemetry wire values", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../src/telemetry/events.ts"), "utf8");
    for (const wire of ['"jira_fetch"', '"jira_write"', '"jira_auth"', "has_jira_auth"]) {
      expect(src).toContain(wire);
    }
  });
});
```

- [ ] **Step 2: Check `makeRun` exists in the factories with that signature**

Run: `grep -n "makeRun" test/_helpers/factories.ts`

If it is absent or takes different arguments, adapt the three `ticketKeyFor` calls to build a `Run` literal inline instead — do **not** change `factories.ts` in this task.

- [ ] **Step 3: Run the test — it must PASS against unmodified code**

Run: `npx vitest run test/unit/compat.test.ts`
Expected: **PASS**. This test characterizes existing behaviour, so a failure here means an assertion is wrong about today's code — fix the assertion, not the source.

- [ ] **Step 4: Commit**

```bash
git add test/unit/compat.test.ts
git commit -m "test: pin the compatibility surface before the connector refactor

Characterizes the promises made to already-configured installs — the two
SecretStorage keys, the setup/sprint-order state keys, the /browse/ url
parsing, the released setting and command ids, and the telemetry wire values.
Green against unmodified code; every later commit must keep it that way."
```

---

## Task 2: The seam types

**Files:**
- Create: `src/tasks/provider.ts`
- Test: `test/unit/tasks/provider.test.ts`

**Interfaces:**
- Consumes: `Filter`, `Size`, `Task`, `TaskDetail` from `src/types.ts` (the type renames land in Task 12; until then import `JiraTask as Task` and `JiraDetail as TaskDetail` — Step 1 shows this).
- Produces: `TaskProvider`, `TaskConnector`, `Capabilities`, `SerializedCaps`, `StatusTarget`, `SourceInfo`, `TaskAuthError`, `TaskApiError`, `TaskWriteError`, `markTaskNetworkFailure`, `isTaskNetworkError`, `serializeCaps`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/tasks/provider.test.ts
import { describe, expect, it } from "vitest";
import {
  TaskApiError, TaskAuthError, TaskWriteError,
  isTaskNetworkError, markTaskNetworkFailure, serializeCaps,
} from "../../../src/tasks/provider";

describe("task errors", () => {
  it("carries a minification-proof name on every class", () => {
    expect(new TaskAuthError("x").name).toBe("TaskAuthError");
    expect(new TaskApiError(404, "x", {}, []).name).toBe("TaskApiError");
    expect(new TaskWriteError("x").name).toBe("TaskWriteError");
  });

  it("defaults TaskWriteError.retryWith to empty", () => {
    expect(new TaskWriteError("x").retryWith).toEqual([]);
    const w = new TaskWriteError("x", [{ kind: "text", id: "f", name: "F" }]);
    expect(w.retryWith).toHaveLength(1);
  });

  it("recognises only its own network markers", () => {
    expect(isTaskNetworkError(markTaskNetworkFailure(new Error("x"), "ETIMEDOUT"))).toBe(true);
    expect(isTaskNetworkError(new Error("x"))).toBe(false);
    expect(isTaskNetworkError(null)).toBe(false);
    expect(isTaskNetworkError("nope")).toBe(false);
  });

  it("preserves the code field classifyFailure reads", () => {
    const e = markTaskNetworkFailure(new Error("x"), "ENOTFOUND") as Error & { code?: string };
    expect(e.code).toBe("ENOTFOUND");
  });
});

describe("serializeCaps", () => {
  it("flattens capability objects to booleans for the webview", () => {
    expect(serializeCaps({ supportedFilters: ["mine"], sizes: false })).toEqual({
      supportedFilters: ["mine"], sizes: false, labels: false, sprints: false, components: false,
    });
  });

  it("reports a present capability as true", () => {
    const caps = {
      supportedFilters: ["all"] as const,
      sizes: true,
      labels: { add: async () => undefined },
    };
    expect(serializeCaps(caps).labels).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/tasks/provider.test.ts`
Expected: FAIL — `Cannot find module '../../../src/tasks/provider'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/tasks/provider.ts
// The seam between Agent Flow and wherever its tickets come from. Deliberately
// free of `vscode` imports so it stays testable in isolation; anything needing
// the editor API belongs in a connector.
import { Filter, JiraDetail as TaskDetail, JiraTask as Task, Size } from "../types";
import { FieldPrompt } from "./jira/transitionFields";

export type { FieldPrompt, Task, TaskDetail };

/** Where a task can move to next, and what that move demands. `fields` is already
 * normalized to the generic prompt vocabulary — no source metadata escapes. */
export interface StatusTarget {
  id: string;
  toName: string;
  toCategory: "new" | "indeterminate" | "done" | "";
  /** The source's own name for the move, when it differs from the destination
   * (Jira transitions are named separately from their target status). */
  via?: string;
  fields: FieldPrompt[];
}

/** Optional operations, held as objects rather than booleans so that "supported"
 * and "callable" are the same fact — a caller cannot check one flag and then reach
 * for a differently-named method. */
export interface Capabilities {
  /** Only these filter tabs render. */
  supportedFilters: readonly Filter[];
  /** The size control needs a per-task estimate; sources without one set false. */
  sizes: boolean;
  labels?: { add(key: string, label: string): Promise<void> };
  sprints?: {
    activeId(): Promise<string | null>;
    add(sprintId: string, key: string): Promise<void>;
    remove(key: string): Promise<void>;
  };
  components?: {
    list(): Promise<string[] | null>;
    update(key: string, delta: { add?: string[]; remove?: string[] }): Promise<void>;
  };
}

/** Capabilities as they cross into the webview. The capability objects cannot be
 * structured-cloned, so the wire form is flat booleans. */
export interface SerializedCaps {
  supportedFilters: Filter[];
  sizes: boolean;
  labels: boolean;
  sprints: boolean;
  components: boolean;
}

export function serializeCaps(caps: Capabilities): SerializedCaps {
  return {
    supportedFilters: [...caps.supportedFilters],
    sizes: caps.sizes,
    labels: !!caps.labels,
    sprints: !!caps.sprints,
    components: !!caps.components,
  };
}

export interface TaskProvider {
  list(lens: Filter, size: Size, max?: number): Promise<Task[]>;
  detail(key: string): Promise<TaskDetail>;
  status(key: string): Promise<{ status: string | null; category: string | null }>;
  statusTargets(key: string): Promise<StatusTarget[]>;
  /** `values` are raw prompt answers; the connector maps them to its own wire
   * shape. Throws `TaskWriteError` on a refusal. */
  moveTo(key: string, targetId: string, values: Record<string, string | string[]>): Promise<void>;
  assignToMe(key: string): Promise<void>;
  me(): Promise<{ id: string; displayName: string } | null>;
  readonly caps: Capabilities;
}

/** The display facts every UI string needs, in one call so a connector has one
 * place to answer them rather than five accessors. */
export interface SourceInfo {
  /** User-facing name, e.g. "Jira". Every "Sign in to X" string reads this. */
  label: string;
  /** What this source calls its scope, e.g. "project". Doctor row labels. */
  scopeNoun: string;
  /** The configured scope, e.g. "ABC". Empty when unconfigured. */
  scopeValue: string;
  /** The configured endpoint, e.g. the site URL. Empty when unconfigured. */
  endpoint: string;
  /** A plausible key for a placeholder, e.g. "ABC-1234". */
  exampleKey: string;
  /** Setting ids to name in Doctor when the two above are empty. */
  endpointSetting: string;
  scopeSetting: string;
}

export interface TaskConnector {
  /** The `agentFlow.taskSource` value, e.g. "jira". */
  readonly id: string;
  info(): SourceInfo;

  isConfigured(): boolean;
  /** Collect this connector's own settings. `from`/`total` keep the wizard's
   * "(2/4)" numbering honest across connectors with different step counts. */
  configure(from: number, total: number): Promise<boolean>;
  readonly setupSteps: number;

  isAuthenticated(): Promise<boolean>;
  signIn(): Promise<boolean>;
  signOut(): Promise<void>;

  /** Built from current settings, per operation — exactly as `client()` did. */
  provider(): TaskProvider;

  /** Doctor's source-specific probes, already classified. Typed loosely here to
   * avoid a cycle with engine/doctor.ts; the real shape is
   * `{ auth?: AuthProbe; scope?: ProjectProbe }`. */
  probe(): Promise<{ auth?: unknown; scope?: unknown }>;

  taskUrl(key: string): string;
  /** Recover a task key from a url on an already-persisted run record. Returns
   * null when the url is not this source's, so the caller falls back to the
   * record key. */
  keyFromUrl(url: string): string | null;
}

// ── Errors ───────────────────────────────────────────────────────────────────
// Every class sets `this.name` to a string literal. esbuild.js runs with
// `minify: true` and no `keepNames`, so the class identifier is NOT a stable
// runtime value, and telemetry/events.ts classifies by `.name`.

export class TaskAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskAuthError";
  }
}

/** A non-2xx response. Keeps the envelope intact so a caller can react to failing
 * fields structurally instead of matching on prose. */
export class TaskApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fieldErrors: Record<string, string>,
    readonly messages: string[],
  ) {
    super(message);
    this.name = "TaskApiError";
  }
}

/** A refused write. `retryWith` is the connector saying "ask the user for these,
 * then try again" — the only recovery a view knows how to perform. Empty means
 * there is nothing left to try. */
export class TaskWriteError extends Error {
  constructor(message: string, readonly retryWith: FieldPrompt[] = []) {
    super(message);
    this.name = "TaskWriteError";
  }
}

/** Tag a network-level failure (unreachable host, DNS, timeout) as source-origin.
 * Stays an ordinary Error on purpose: views branch on `instanceof TaskApiError` /
 * `TaskAuthError`, and promoting a network failure into either would be a false
 * positive with real behavioural fallout. `code` is the field
 * classifyFailure (telemetry/events.ts) already reads. */
export function markTaskNetworkFailure(e: Error, code: "ETIMEDOUT" | "ENOTFOUND"): Error {
  return Object.assign(e, { code, taskSourceOrigin: true });
}

export function isTaskNetworkError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { taskSourceOrigin?: unknown }).taskSourceOrigin === true
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/tasks/provider.test.ts && npx vitest run test/unit/compat.test.ts && npm run typecheck`
Expected: both suites PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/tasks/provider.ts test/unit/tasks/provider.test.ts
git commit -m "feat(tasks): add the task-source seam types

TaskConnector for lifecycle, TaskProvider for operations, and capabilities held
as objects rather than booleans so 'supported' and 'callable' are one fact.
Errors mirror the Jira ones and set .name as a string literal, since the
production build minifies without keepNames. No consumers yet."
```

---

## Task 3: Move `src/jira/` to `src/tasks/jira/`

A pure move. No behaviour changes, no logic edits.

**Files:**
- Move: `src/jira/{client,auth,jql,errors,transitionFields}.ts` → `src/tasks/jira/`
- Move: `test/unit/jira/*.test.ts` → `test/unit/tasks/jira/`
- Modify: every importer — `src/tasks/provider.ts`, `src/tasksView.ts`, `src/deckView.ts`, `src/doctorView.ts`, `src/setup.ts`, `src/extension.ts`, `test/unit/compat.test.ts`

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces: the same exports at new paths. No signature changes.

- [ ] **Step 1: Move the files with git so history follows**

```bash
mkdir -p src/tasks/jira test/unit/tasks/jira
git mv src/jira/client.ts src/jira/auth.ts src/jira/jql.ts src/jira/errors.ts \
       src/jira/transitionFields.ts src/tasks/jira/
git mv test/unit/jira/auth.test.ts test/unit/jira/client.test.ts \
       test/unit/jira/errors.test.ts test/unit/jira/jql.test.ts \
       test/unit/jira/transitionFields.test.ts test/unit/tasks/jira/
rmdir src/jira test/unit/jira
```

- [ ] **Step 2: Fix every import path**

Depth changes by one level for sources (`../types` → `../../types`) and by one for tests (`../../src/jira/x` → `../../../src/tasks/jira/x`).

```bash
# Inside the moved sources: they are one directory deeper now.
sed -i '' 's|from "\.\./types"|from "../../types"|g' src/tasks/jira/*.ts
# Consumers at src/ root.
sed -i '' 's|from "\./jira/|from "./tasks/jira/|g' src/*.ts
# provider.ts already points at ./jira/transitionFields — correct, leave it.
# Moved tests are one directory deeper.
sed -i '' 's|from "\.\./\.\./src/jira/|from "../../../src/tasks/jira/|g' test/unit/tasks/jira/*.ts
# The compat test's ApiTokenAuth import.
sed -i '' 's|from "\.\./\.\./src/jira/auth"|from "../../src/tasks/jira/auth"|g' test/unit/compat.test.ts
```

- [ ] **Step 3: Find any import the sed missed**

Run: `grep -rn "src/jira\|\"\./jira/\|\"\.\./jira/" src/ test/ ; npm run typecheck`
Expected: no grep hits; typecheck clean. Fix any straggler by hand — `test/_helpers/factories.ts` and `test/unit/telemetry/*` are the likely ones.

- [ ] **Step 4: Run the whole suite — behaviour must be identical**

Run: `npm test`
Expected: PASS, with the **same test count as the baseline: 72 files, 2121 tests**. A moved test that now fails means an import resolved to the wrong module.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(tasks): move src/jira into src/tasks/jira

Pure move plus import updates — no logic touched. The directory name is where a
contributor looks first, and it should say that Jira is one connector."
```

---

## Task 4: Jira errors extend the task errors

**Files:**
- Modify: `src/tasks/jira/errors.ts` (`JiraApiError`), `src/tasks/jira/client.ts` (`JiraAuthError`, network markers)
- Modify: `src/telemetry/events.ts:47-56` (`classifyFailure`)
- Test: `test/unit/tasks/jira/errors.test.ts`, `test/unit/telemetry/events.test.ts`

**Interfaces:**
- Consumes: `TaskApiError`, `TaskAuthError`, `markTaskNetworkFailure`, `isTaskNetworkError` from `src/tasks/provider.ts`.
- Produces: `JiraApiError extends TaskApiError`, `JiraAuthError extends TaskAuthError`. Both keep their own `.name`. `markJiraNetworkFailure` and `isJiraNetworkError` are **deleted**, and all three of their call sites migrated to the `Task*` equivalents in this task — so Task 8 has no network-marker work left to do.

- [ ] **Step 1: Write the failing tests**

```ts
// append to test/unit/tasks/jira/errors.test.ts
import { TaskApiError, TaskAuthError } from "../../../../src/tasks/provider";
import { JiraApiError } from "../../../../src/tasks/jira/errors";
import { JiraAuthError } from "../../../../src/tasks/jira/client";

describe("jira errors are task errors", () => {
  it("makes JiraApiError catchable as TaskApiError", () => {
    const e = new JiraApiError(404, "gone", { f: "bad" }, ["m"]);
    expect(e).toBeInstanceOf(TaskApiError);
    expect(e.name).toBe("JiraApiError"); // its own name survives
    expect(e.status).toBe(404);
    expect(e.fieldErrors).toEqual({ f: "bad" });
    expect(e.messages).toEqual(["m"]);
  });

  it("makes JiraAuthError catchable as TaskAuthError", () => {
    const e = new JiraAuthError("nope");
    expect(e).toBeInstanceOf(TaskAuthError);
    expect(e.name).toBe("JiraAuthError");
  });
});
```

```ts
// append to test/unit/telemetry/events.test.ts
it("classifies both the task and jira auth error names as auth", () => {
  expect(classifyFailure({ name: "TaskAuthError" })).toBe("auth");
  expect(classifyFailure({ name: "JiraAuthError" })).toBe("auth");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/tasks/jira/errors.test.ts test/unit/telemetry/events.test.ts`
Expected: FAIL — `expect(e).toBeInstanceOf(TaskApiError)` fails; `classifyFailure({name:"TaskAuthError"})` returns `"unknown"`.

- [ ] **Step 3: Implement**

In `src/tasks/jira/errors.ts`, change the declaration only — the constructor body, `parseJiraError`, `describeJiraError` and every helper stay exactly as they are:

```ts
import { TaskApiError } from "../provider";

export class JiraApiError extends TaskApiError {
  constructor(
    status: number,
    message: string,
    fieldErrors: Record<string, string>,
    messages: string[],
  ) {
    super(status, message, fieldErrors, messages);
    this.name = "JiraApiError";
  }
}
```

Note `status` / `fieldErrors` / `messages` lose their `readonly` modifiers here because the base class already declares them as `readonly` properties — re-declaring would shadow them.

In `src/tasks/jira/client.ts`:

```ts
import { isTaskNetworkError, markTaskNetworkFailure, TaskAuthError } from "../provider";

export class JiraAuthError extends TaskAuthError {
  constructor(message: string) {
    super(message);
    // Still explicit, still a literal — the base sets "TaskAuthError" and this
    // must win, and esbuild's minifier makes the class identifier unusable.
    this.name = "JiraAuthError";
  }
}

```

Then **delete** `markJiraNetworkFailure` and `isJiraNetworkError` outright — no aliases. Aliasing them would leave a dead export the moment Task 8 migrates their callers, and there are only three call sites in the whole repo:

- `client.ts:115` and `client.ts:123` call `markJiraNetworkFailure(...)` → call `markTaskNetworkFailure(...)` directly. Move the old function's doc comment onto neither; the explanation now lives on `markTaskNetworkFailure` in `provider.ts`.
- `tasksView.ts` imports `isJiraNetworkError` (line 6) and uses it once (line 88) → change both to `isTaskNetworkError`, importing from `./tasks/provider`.

Verify nothing survives:

```bash
grep -rn "markJiraNetworkFailure\|isJiraNetworkError" src/ test/ || echo "clean"
```

In `src/telemetry/events.ts:50`, widen the name check. **Do not import anything** — this module must stay a leaf:

```ts
  if (name === "TaskAuthError" || name === "JiraAuthError" || code === "401" || code === "403") return "auth";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS. `test/unit/compat.test.ts` must still be green — the telemetry wire values were not touched.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(tasks): make the Jira errors subclasses of the task errors

Views can now catch TaskAuthError/TaskApiError and get Jira's failures through
inheritance. Each subclass still sets its own .name as a literal, and
classifyFailure accepts both names so no telemetry series moves."
```

---

## Task 5: The `JiraProvider` adapter

The transition machinery moves behind the seam. `JiraClient` is **not** modified — that is what keeps `client.test.ts`'s assertions intact.

**Files:**
- Create: `src/tasks/jira/provider.ts`
- Test: `test/unit/tasks/jira/provider.test.ts`

**Interfaces:**
- Consumes: `TaskProvider`, `Capabilities`, `StatusTarget`, `TaskWriteError` (Task 2); `JiraClient`, `JiraApiError` (Task 4); `promptableFields`, `toJiraValue`, `missingFieldIds`, `mentionsResolution`, `fieldDisplayNames` from `./transitionFields`; `describeJiraError` from `./errors`.
- Produces: `class JiraProvider implements TaskProvider`, `constructor(client: JiraClient)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/tasks/jira/provider.test.ts
import { describe, expect, it, vi } from "vitest";
import { JiraProvider } from "../../../../src/tasks/jira/provider";
import { JiraApiError } from "../../../../src/tasks/jira/errors";
import { TaskWriteError } from "../../../../src/tasks/provider";

const client = (over: Record<string, unknown> = {}) =>
  ({
    fetchTasks: vi.fn(async () => []),
    getDetail: vi.fn(async () => ({ key: "A-1" })),
    getStatus: vi.fn(async () => ({ status: "Open", category: "new" })),
    getTransitions: vi.fn(async () => []),
    transition: vi.fn(async () => undefined),
    getMyself: vi.fn(async () => ({ accountId: "acc", displayName: "Me" })),
    assignIssue: vi.fn(async () => undefined),
    listResolutions: vi.fn(async () => []),
    ...over,
  }) as never;

describe("JiraProvider", () => {
  it("declares every optional capability", () => {
    const caps = new JiraProvider(client()).caps;
    expect(caps.labels).toBeDefined();
    expect(caps.sprints).toBeDefined();
    expect(caps.components).toBeDefined();
    expect(caps.sizes).toBe(true);
    expect([...caps.supportedFilters].sort()).toEqual(
      ["all", "backlog", "mine", "mysprint", "sprint", "unassigned"],
    );
  });

  it("normalizes transitions into StatusTargets with generic field prompts", async () => {
    const c = client({
      getTransitions: vi.fn(async () => [
        {
          id: "31", name: "Start", toName: "In Progress", toCategory: "indeterminate",
          fields: { resolution: { required: true, name: "Resolution", allowedValues: [{ id: "1", name: "Done" }] } },
        },
      ]),
    });
    const [t] = await new JiraProvider(c).statusTargets("A-1");
    expect(t).toMatchObject({ id: "31", toName: "In Progress", toCategory: "indeterminate", via: "Start" });
    expect(t.fields).toEqual([
      { kind: "pick", id: "resolution", name: "Resolution", choices: [{ id: "1", name: "Done" }] },
    ]);
  });

  it("omits `via` when the transition name matches the destination", async () => {
    const c = client({
      getTransitions: vi.fn(async () => [
        { id: "1", name: "Done", toName: "Done", toCategory: "done", fields: {} },
      ]),
    });
    expect((await new JiraProvider(c).statusTargets("A-1"))[0].via).toBeUndefined();
  });

  it("maps raw prompt answers to Jira's wire shape", async () => {
    const transition = vi.fn(async () => undefined);
    const c = client({
      transition,
      getTransitions: vi.fn(async () => [
        {
          id: "31", name: "Go", toName: "Go", toCategory: "",
          fields: { resolution: { required: true, name: "Resolution", allowedValues: [{ id: "9", name: "Fixed" }] } },
        },
      ]),
    });
    const p = new JiraProvider(c);
    await p.statusTargets("A-1"); // caches the field metadata
    await p.moveTo("A-1", "31", { resolution: "Fixed" });
    expect(transition).toHaveBeenCalledWith("A-1", "31", { resolution: { id: "9" } });
  });

  it("turns a rejection naming a known field into a TaskWriteError carrying it", async () => {
    const c = client({
      getTransitions: vi.fn(async () => [
        {
          id: "31", name: "Go", toName: "Go", toCategory: "",
          fields: { customfield_1: { required: false, name: "Impact", schema: { type: "string" } } },
        },
      ]),
      transition: vi.fn(async () => {
        throw new JiraApiError(400, "bad", { customfield_1: "required" }, []);
      }),
    });
    const p = new JiraProvider(c);
    await p.statusTargets("A-1");
    const err = await p.moveTo("A-1", "31", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskWriteError);
    expect((err as TaskWriteError).retryWith).toEqual([
      { kind: "text", id: "customfield_1", name: "Impact" },
    ]);
  });

  it("throws an empty-retryWith TaskWriteError when nothing can be re-prompted", async () => {
    const c = client({
      getTransitions: vi.fn(async () => [{ id: "31", name: "Go", toName: "Go", toCategory: "", fields: {} }]),
      transition: vi.fn(async () => {
        throw new JiraApiError(403, "no", {}, ["You lack permission."]);
      }),
    });
    const p = new JiraProvider(c);
    await p.statusTargets("A-1");
    const err = (await p.moveTo("A-1", "31", {}).catch((e: unknown) => e)) as TaskWriteError;
    expect(err).toBeInstanceOf(TaskWriteError);
    expect(err.retryWith).toEqual([]);
    expect(err.message).toContain("You lack permission.");
  });

  it("falls back to the site resolution list when a rejection blames Resolution", async () => {
    const c = client({
      getTransitions: vi.fn(async () => [{ id: "31", name: "Go", toName: "Go", toCategory: "", fields: {} }]),
      transition: vi.fn(async () => {
        throw new JiraApiError(400, "x", {}, ["Resolution is required."]);
      }),
      listResolutions: vi.fn(async () => [{ id: "1", name: "Done" }]),
    });
    const p = new JiraProvider(c);
    await p.statusTargets("A-1");
    const err = (await p.moveTo("A-1", "31", {}).catch((e: unknown) => e)) as TaskWriteError;
    expect(err.retryWith).toEqual([
      { kind: "pick", id: "resolution", name: "Resolution", choices: [{ id: "1", name: "Done" }] },
    ]);
  });

  it("assigns via the resolved account id", async () => {
    const assignIssue = vi.fn(async () => undefined);
    await new JiraProvider(client({ assignIssue })).assignToMe("A-1");
    expect(assignIssue).toHaveBeenCalledWith("A-1", "acc");
  });

  it("refuses to assign when the account cannot be resolved", async () => {
    const assignIssue = vi.fn(async () => undefined);
    const p = new JiraProvider(client({ assignIssue, getMyself: vi.fn(async () => null) }));
    await expect(p.assignToMe("A-1")).rejects.toThrow(/account/i);
    expect(assignIssue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/tasks/jira/provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/tasks/jira/provider.ts
import { Filter, JiraDetail, JiraTask, Size } from "../../types";
import {
  Capabilities, StatusTarget, TaskProvider, TaskWriteError,
} from "../provider";
import { JiraClient, TransitionOption } from "./client";
import { describeJiraError, JiraApiError } from "./errors";
import {
  FieldPrompt, fieldDisplayNames, mentionsResolution, missingFieldIds,
  promptableFields, toJiraValue, TransitionFieldMeta,
} from "./transitionFields";

const ALL_FILTERS: readonly Filter[] = [
  "unassigned", "mine", "mysprint", "sprint", "backlog", "all",
];

/** Adapts JiraClient — the raw REST surface — to the source-agnostic
 * TaskProvider. Everything a view used to know about Jira transitions lives
 * here: which screen fields can be prompted for, how an answer becomes Jira's
 * JSON, and which fields a rejection is really pointing at.
 *
 * JiraClient itself is untouched on purpose, so its own test suite keeps
 * asserting exactly what it asserted before the seam existed. */
export class JiraProvider implements TaskProvider {
  /** Screen-field metadata from the last statusTargets() call, per transition id.
   * moveTo() needs it twice — to map answers to Jira's shape, and to work out
   * what a rejection is complaining about — and re-fetching would cost a second
   * round-trip for data we just had. */
  private fieldsByTarget = new Map<string, Record<string, TransitionFieldMeta>>();

  constructor(private readonly client: JiraClient) {}

  readonly caps: Capabilities = {
    supportedFilters: ALL_FILTERS,
    sizes: true,
    labels: { add: (key, label) => this.client.addLabel(key, label) },
    sprints: {
      activeId: async () => {
        const id = await this.client.getActiveSprintId();
        return id == null ? null : String(id);
      },
      add: (sprintId, key) => this.client.addIssueToSprint(Number(sprintId), key),
      remove: (key) => this.client.removeIssueFromSprint(key),
    },
    components: {
      list: () => this.client.listComponents(),
      update: (key, delta) => this.client.updateComponents(key, delta),
    },
  };

  list(lens: Filter, size: Size, max = 50): Promise<JiraTask[]> {
    return this.client.fetchTasks(lens, size, max);
  }

  detail(key: string): Promise<JiraDetail> {
    return this.client.getDetail(key);
  }

  status(key: string): Promise<{ status: string | null; category: string | null }> {
    return this.client.getStatus(key);
  }

  me(): Promise<{ id: string; displayName: string } | null> {
    return this.client.getMyself().then((m) =>
      m ? { id: m.accountId, displayName: m.displayName } : null,
    );
  }

  async assignToMe(key: string): Promise<void> {
    const me = await this.client.getMyself();
    // Never call assignIssue with a blank id: Jira reads that as "unassign",
    // which is the opposite of what this method promises.
    if (!me) throw new Error("Couldn't resolve your Jira account.");
    await this.client.assignIssue(key, me.id ?? me.accountId);
  }

  async statusTargets(key: string): Promise<StatusTarget[]> {
    const transitions = await this.client.getTransitions(key);
    this.fieldsByTarget.clear();
    return transitions.map((t: TransitionOption) => {
      // `fields` is absent on anything that didn't come from an expanded
      // getTransitions — the metadata is Jira's JSON, not a guarantee.
      const meta = t.fields ?? {};
      this.fieldsByTarget.set(t.id, meta);
      const { prompts } = promptableFields(meta);
      return {
        id: t.id,
        toName: t.toName,
        toCategory: (t.toCategory || "") as StatusTarget["toCategory"],
        ...(t.name !== t.toName ? { via: t.name } : {}),
        fields: prompts,
      };
    });
  }

  async moveTo(
    key: string,
    targetId: string,
    values: Record<string, string | string[]>,
  ): Promise<void> {
    const meta = this.fieldsByTarget.get(targetId) ?? {};
    try {
      await this.client.transition(key, targetId, this.toWire(meta, values));
    } catch (e) {
      if (!(e instanceof JiraApiError)) throw e;
      throw new TaskWriteError(
        describeJiraError(e, fieldDisplayNames(meta)),
        await this.retryPrompts(meta, e),
      );
    }
  }

  /** Turn raw prompt answers into the JSON Jira's transition body expects.
   * An id with no screen metadata is dropped rather than guessed at — Jira
   * would reject the write anyway, and less informatively. */
  private toWire(
    meta: Record<string, TransitionFieldMeta>,
    values: Record<string, string | string[]>,
  ): Record<string, unknown> {
    const byId = new Map(promptableFields(meta, { only: Object.keys(values) }).prompts.map((p) => [p.id, p]));
    const out: Record<string, unknown> = {};
    for (const [id, raw] of Object.entries(values)) {
      const prompt = byId.get(id);
      if (prompt) out[id] = toJiraValue(prompt, raw);
    }
    return out;
  }

  /** What, if anything, is worth asking the user for after a refusal. Screen
   * metadata cannot see custom workflow validators, so the rejection itself is
   * the only place some requirements are ever stated. */
  private async retryPrompts(
    meta: Record<string, TransitionFieldMeta>,
    err: JiraApiError,
  ): Promise<FieldPrompt[]> {
    const ids = missingFieldIds(meta, err);
    if (ids.length) {
      const { prompts } = promptableFields(meta, { only: ids });
      if (prompts.length) return prompts;
    }
    if (mentionsResolution(err)) {
      // Swallowed on purpose: failing to fetch the list only costs us the
      // recovery attempt, and the original refusal is still reported.
      const resolutions = await this.client.listResolutions().catch(() => []);
      if (resolutions.length) {
        return [{ kind: "pick", id: "resolution", name: "Resolution", choices: resolutions }];
      }
    }
    return [];
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/tasks/jira/provider.test.ts && npm run typecheck`
Expected: PASS, typecheck clean. If `me.id ?? me.accountId` fails to typecheck, `getMyself` returns `{accountId, displayName}` — use `me.accountId` alone.

- [ ] **Step 5: Commit**

```bash
git add src/tasks/jira/provider.ts test/unit/tasks/jira/provider.test.ts
git commit -m "feat(tasks): add the JiraProvider adapter

Wraps JiraClient in TaskProvider and absorbs everything a view used to know
about Jira transitions — promptable screen fields, answer-to-JSON mapping, and
which fields a rejection is really pointing at, re-thrown as TaskWriteError.
JiraClient is untouched so its own suite still asserts what it always did."
```

---

## Task 6: The connector, the registry, and `agentFlow.taskSource`

**Files:**
- Create: `src/tasks/jira/connector.ts`, `src/tasks/registry.ts`
- Modify: `src/config.ts` (`AgentFlowConfig.taskSource`, `getConfig`), `package.json` (the setting), `src/telemetry/events.ts` (`SettingsSnapshot.task_source`), `src/telemetry/settingsSnapshot.ts`
- Test: `test/unit/tasks/registry.test.ts`, `test/unit/tasks/jira/connector.test.ts`, `test/unit/telemetry/settingsSnapshot.test.ts`

**Interfaces:**
- Consumes: `TaskConnector`, `SourceInfo` (Task 2); `JiraProvider` (Task 5); `ApiTokenAuth` (Task 3).
- Produces: `makeJiraConnector(ctx: vscode.ExtensionContext): TaskConnector`; `CONNECTORS`, `CONNECTOR_IDS: string[]`, `resolveConnector(ctx, log): TaskConnector`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/tasks/registry.test.ts
import { describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { CONNECTOR_IDS, resolveConnector } from "../../../src/tasks/registry";

vi.mock("../../../src/config", () => ({ getConfig: () => ({ taskSource: mockSource }) }));
let mockSource = "jira";

const ctx = { secrets: { get: async () => undefined } } as never;

describe("resolveConnector", () => {
  it("resolves the shipped default", () => {
    mockSource = "jira";
    expect(resolveConnector(ctx, () => {}).id).toBe("jira");
  });

  it("falls back to jira and logs for an unknown id", () => {
    mockSource = "notARealTracker";
    const log = vi.fn();
    expect(resolveConnector(ctx, log).id).toBe("jira");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("notARealTracker"));
  });

  it("falls back for an empty id rather than rendering an empty board", () => {
    mockSource = "";
    expect(resolveConnector(ctx, () => {}).id).toBe("jira");
  });

  it("does not resolve a prototype key to a connector", () => {
    // settings.json can hold any string; a bare CONNECTORS[id] lookup would
    // return Object.prototype.constructor here and call it as a factory.
    mockSource = "constructor";
    expect(resolveConnector(ctx, () => {}).id).toBe("jira");
  });
});

describe("the manifest and the registry agree", () => {
  it("offers exactly the registered connectors in the taskSource enum", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../package.json"), "utf8"));
    const prop = pkg.contributes.configuration.properties["agentFlow.taskSource"];
    expect(prop.default).toBe("jira");
    expect([...prop.enum].sort()).toEqual([...CONNECTOR_IDS].sort());
    expect(prop.enumDescriptions).toHaveLength(prop.enum.length);
  });
});
```

```ts
// test/unit/tasks/jira/connector.test.ts
import { describe, expect, it, vi } from "vitest";
import { makeJiraConnector } from "../../../../src/tasks/jira/connector";

vi.mock("../../../../src/config", () => ({
  getConfig: () => ({ baseUrl: mockBase, project: mockProject }),
}));
let mockBase = "https://x.atlassian.net";
let mockProject = "ABC";

const ctx = { secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } } as never;

describe("JiraConnector", () => {
  it("describes itself for every UI string", () => {
    const info = makeJiraConnector(ctx).info();
    expect(info.label).toBe("Jira");
    expect(info.scopeNoun).toBe("project");
    expect(info.scopeValue).toBe("ABC");
    expect(info.endpoint).toBe("https://x.atlassian.net");
    expect(info.exampleKey).toBe("ABC-1234");
    expect(info.endpointSetting).toBe("agentFlow.jira.baseUrl");
    expect(info.scopeSetting).toBe("agentFlow.jira.project");
  });

  it("uses a placeholder example key when no project is configured", () => {
    mockProject = "";
    expect(makeJiraConnector(ctx).info().exampleKey).toBe("ABC-1234");
    mockProject = "ABC";
  });

  it("is configured only when both settings are present", () => {
    expect(makeJiraConnector(ctx).isConfigured()).toBe(true);
    mockBase = "";
    expect(makeJiraConnector(ctx).isConfigured()).toBe(false);
    mockBase = "https://x.atlassian.net";
  });

  it("builds a task url on the released /browse/ shape", () => {
    expect(makeJiraConnector(ctx).taskUrl("ABC-7")).toBe("https://x.atlassian.net/browse/ABC-7");
  });

  it("recovers a key from a persisted run url, and declines a foreign one", () => {
    const c = makeJiraConnector(ctx);
    expect(c.keyFromUrl("https://x.atlassian.net/browse/ABC-7")).toBe("ABC-7");
    expect(c.keyFromUrl("https://github.com/o/r/pull/9")).toBeNull();
    expect(c.keyFromUrl("")).toBeNull();
  });

  it("declares one wizard step per collected setting", () => {
    expect(makeJiraConnector(ctx).setupSteps).toBe(2);
  });
});
```

```ts
// append to test/unit/telemetry/settingsSnapshot.test.ts
it("reports the task source, and collapses an unregistered one", () => {
  expect(settingsSnapshot(cfg({ taskSource: "jira" })).task_source).toBe("jira");
  expect(settingsSnapshot(cfg({ taskSource: "acme" })).task_source).toBe("invalid");
});
```

Use whatever `cfg(...)` config-builder helper that file already has; if it has none, build a full `AgentFlowConfig` literal the way its neighbouring tests do.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/tasks/ test/unit/telemetry/settingsSnapshot.test.ts`
Expected: FAIL — modules not found, `task_source` not a property.

- [ ] **Step 3: Implement the connector**

```ts
// src/tasks/jira/connector.ts
import * as vscode from "vscode";
import { getConfig } from "../../config";
import { SourceInfo, TaskConnector, TaskProvider } from "../provider";
import { ApiTokenAuth, JiraAuth } from "./auth";
import { JiraClient, JiraAuthError } from "./client";
import { describeJiraError, JiraApiError } from "./errors";
import { JiraProvider } from "./provider";

/** The url shape every Agent Flow run record written to date carries. Parsing it
 * is a compatibility obligation, not a design choice — see the compat test. */
const BROWSE = "/browse/";

/** The two settings this connector owns. Frozen: they shipped, and renaming them
 * would strand every configured install. */
const ENDPOINT_SETTING = "agentFlow.jira.baseUrl";
const SCOPE_SETTING = "agentFlow.jira.project";

class JiraConnector implements TaskConnector {
  readonly id = "jira";
  readonly setupSteps = 2;

  constructor(private readonly auth: JiraAuth) {}

  info(): SourceInfo {
    const cfg = getConfig();
    return {
      label: "Jira",
      scopeNoun: "project",
      scopeValue: cfg.project,
      endpoint: cfg.baseUrl,
      exampleKey: `${cfg.project || "ABC"}-1234`,
      endpointSetting: ENDPOINT_SETTING,
      scopeSetting: SCOPE_SETTING,
    };
  }

  isConfigured(): boolean {
    const cfg = getConfig();
    return !!cfg.baseUrl.trim() && !!cfg.project.trim();
  }

  /** The site URL and project key, as steps `from` and `from + 1` of `total`.
   * Writes to global settings, exactly as the pre-seam wizard did. */
  async configure(from: number, total: number): Promise<boolean> {
    const baseUrl = await vscode.window.showInputBox({
      title: `Agent Flow Deck Setup (${from}/${total})`,
      prompt: "Your Atlassian Jira Cloud site URL",
      ignoreFocusOut: true,
      placeHolder: "https://your-org.atlassian.net",
      validateInput: (v) => {
        const t = v.trim();
        if (!t) return "Enter your Jira site URL";
        try {
          return new URL(t).protocol === "https:" ? undefined : "URL must start with https://";
        } catch {
          return "Enter a valid URL (e.g. https://your-org.atlassian.net)";
        }
      },
    });
    if (baseUrl === undefined) return false;

    const project = await vscode.window.showInputBox({
      title: `Agent Flow Deck Setup (${from + 1}/${total})`,
      prompt: "Jira project key to pull tasks from",
      ignoreFocusOut: true,
      placeHolder: "ABC",
      validateInput: (v) => (v.trim() ? undefined : "Enter a project key"),
    });
    if (project === undefined) return false;

    const c = vscode.workspace.getConfiguration("agentFlow");
    await c.update("jira.baseUrl", baseUrl.trim().replace(/\/+$/, ""), vscode.ConfigurationTarget.Global);
    await c.update("jira.project", project.trim().toUpperCase(), vscode.ConfigurationTarget.Global);
    return true;
  }

  isAuthenticated(): Promise<boolean> { return this.auth.isAuthenticated(); }
  signIn(): Promise<boolean> { return this.auth.signIn(); }
  signOut(): Promise<void> { return this.auth.signOut(); }

  provider(): TaskProvider {
    const cfg = getConfig();
    return new JiraProvider(new JiraClient(cfg.baseUrl, cfg.project, this.auth));
  }

  /** Ordered on purpose: the scope lookup is skipped when auth failed, because
   * its answer would be meaningless and the call cannot succeed. A signed-out
   * user should see one problem, not a cascade of two. */
  async probe(): Promise<{ auth?: unknown; scope?: unknown }> {
    const cfg = getConfig();
    const client = new JiraClient(cfg.baseUrl, cfg.project, this.auth);
    let auth: unknown;
    try {
      const me = await client.probeMyself();
      auth = { ok: true, displayName: me.displayName || me.accountId };
    } catch (e) {
      auth = e instanceof JiraAuthError
        ? { ok: false, reason: "auth", message: e.message }
        : { ok: false, reason: "network", message: e instanceof Error ? e.message : String(e) };
    }
    if (!cfg.project || !(auth as { ok?: boolean }).ok) return { auth };
    let scope: unknown;
    try {
      const p = await client.getProject(cfg.project);
      scope = { ok: true, name: p.name || p.key };
    } catch (e) {
      const message = e instanceof JiraApiError
        ? describeJiraError(e)
        : e instanceof Error ? e.message : String(e);
      scope = e instanceof JiraApiError && e.status === 404
        ? { ok: false, reason: "not-found", message }
        : { ok: false, reason: "error", message };
    }
    return { auth, scope };
  }

  taskUrl(key: string): string {
    return `${getConfig().baseUrl}${BROWSE}${key}`;
  }

  keyFromUrl(url: string): string | null {
    const i = typeof url === "string" ? url.indexOf(BROWSE) : -1;
    if (i < 0) return null;
    const key = url.slice(i + BROWSE.length).trim();
    return key || null;
  }
}

export function makeJiraConnector(ctx: vscode.ExtensionContext): TaskConnector {
  return new JiraConnector(new ApiTokenAuth(ctx.secrets));
}
```

- [ ] **Step 4: Implement the registry**

```ts
// src/tasks/registry.ts
import * as vscode from "vscode";
import { getConfig } from "../config";
import { makeJiraConnector } from "./jira/connector";
import { TaskConnector } from "./provider";

/** Every task source Agent Flow can read from. Adding one is this line plus a
 * directory — see docs/CONNECTORS.md. */
const CONNECTORS: Record<string, (ctx: vscode.ExtensionContext) => TaskConnector> = {
  jira: makeJiraConnector,
};

/** The registered ids. Exported so the telemetry snapshot's allowlist and the
 * manifest-parity test both derive from the registry instead of a hand-written
 * literal that would report a contributor's connector as "invalid" forever. */
export const CONNECTOR_IDS: string[] = Object.keys(CONNECTORS);

export function resolveConnector(
  ctx: vscode.ExtensionContext,
  log: (m: string) => void,
): TaskConnector {
  const id = getConfig().taskSource;
  // `Object.hasOwn`, not `CONNECTORS[id]`: `taskSource` comes from settings.json
  // and can be any string, including a prototype key like "constructor" — which a
  // bare index resolves to a truthy non-factory that would then be called.
  if (!Object.hasOwn(CONNECTORS, id)) {
    log(`taskSource "${id}" is not a known connector — falling back to jira`);
    return CONNECTORS.jira(ctx);
  }
  return CONNECTORS[id](ctx);
}
```

- [ ] **Step 5: Add the setting and the telemetry property**

`package.json`, in `contributes.configuration.properties`, immediately before `agentFlow.jira.baseUrl`:

```json
"agentFlow.taskSource": {
  "type": "string",
  "enum": ["jira"],
  "enumDescriptions": ["Atlassian Jira Cloud"],
  "default": "jira",
  "description": "Where Agent Flow reads tasks from. Each source has its own settings under agentFlow.<source>.*."
}
```

`src/config.ts` — add to the `AgentFlowConfig` interface, above `baseUrl`:

```ts
  // Which task source to read from — an id in src/tasks/registry.ts. An
  // unregistered value resolves to Jira with a log line, never an empty board.
  taskSource: string;
```

and in the object `getConfig()` returns, as the first entry:

```ts
    taskSource: c.get<string>("taskSource") || "jira",
```

`src/telemetry/events.ts` — add to `SettingsSnapshot`, beside `explore_mode`:

```ts
  /** A registered connector id, or "invalid". Validated against the registry, so
   * a contributor's connector is never silently reported as invalid. */
  task_source: string;
```

`src/telemetry/settingsSnapshot.ts` — import and use the registry list:

```ts
import { CONNECTOR_IDS } from "../tasks/registry";
// …inside the returned object, beside explore_mode:
    task_source: enumOrInvalid(cfg.taskSource, CONNECTOR_IDS),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS. If `settingsSnapshot.test.ts`'s existing manifest-parity test now fails, it is asserting that every manifest `enum` has a matching hand-written list — extend it to accept `agentFlow.taskSource` as covered by `CONNECTOR_IDS`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(tasks): add the Jira connector, the registry, and agentFlow.taskSource

The connector owns the frozen settings and secret keys, the wizard steps, the
Doctor probes, and the /browse/ url parsing. The registry resolves an unknown or
empty id to Jira with a log line, and uses Object.hasOwn so a prototype key in
settings.json cannot be called as a factory. The telemetry allowlist derives
from the registry, so a contributor's connector is never reported 'invalid'."
```

---

## Task 7: The fixture connector

The second implementation. Its whole job is to declare **nothing optional**, so capability-gating becomes load-bearing.

**Files:**
- Create: `test/_helpers/fixtureConnector.ts`
- Test: `test/unit/tasks/fixtureConnector.test.ts`

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces: `makeFixtureConnector(over?: Partial<FixtureOptions>): TaskConnector`, `FIXTURE_TASKS: Task[]`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/tasks/fixtureConnector.test.ts
import { describe, expect, it } from "vitest";
import { makeFixtureConnector } from "../../_helpers/fixtureConnector";
import { serializeCaps } from "../../../src/tasks/provider";

describe("fixture connector", () => {
  it("declares no optional capability", () => {
    const caps = makeFixtureConnector().provider().caps;
    expect(caps.labels).toBeUndefined();
    expect(caps.sprints).toBeUndefined();
    expect(caps.components).toBeUndefined();
    expect(caps.sizes).toBe(false);
    expect(caps.supportedFilters).toEqual(["mine", "all"]);
  });

  it("serializes to all-false booleans", () => {
    expect(serializeCaps(makeFixtureConnector().provider().caps)).toEqual({
      supportedFilters: ["mine", "all"], sizes: false,
      labels: false, sprints: false, components: false,
    });
  });

  it("returns tasks with no sprint, components or estimate", async () => {
    const [t] = await makeFixtureConnector().provider().list("all", "any");
    expect(t.sprint).toBeNull();
    expect(t.components).toEqual([]);
    expect(t.estimateSeconds).toBeNull();
  });

  it("moves status with no field prompts and no recovery", async () => {
    const p = makeFixtureConnector().provider();
    const targets = await p.statusTargets("FX-1");
    expect(targets.every((t) => t.fields.length === 0)).toBe(true);
    await expect(p.moveTo("FX-1", targets[0].id, {})).resolves.toBeUndefined();
  });

  it("declines to recover a key from any url", () => {
    expect(makeFixtureConnector().keyFromUrl("https://fixture.test/t/FX-1")).toBe("FX-1");
    expect(makeFixtureConnector().keyFromUrl("https://x.atlassian.net/browse/A-1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/tasks/fixtureConnector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// test/_helpers/fixtureConnector.ts
import {
  Capabilities, SourceInfo, StatusTarget, TaskConnector, TaskProvider,
} from "../../src/tasks/provider";
import { Filter, JiraDetail, JiraTask, Size } from "../../src/types";

/** A complete second connector over static data, declaring the bare minimum of
 * the seam. It exists so capability-gating is exercised rather than assumed: a
 * view that reaches for sprints, components, labels, estimates or a filter this
 * source never offers fails a test here instead of shipping.
 *
 * Deliberately NOT registered in src/tasks/registry.ts — it is a test double,
 * not a shipped feature. */
const MARKER = "/t/";

export const FIXTURE_TASKS: JiraTask[] = [
  {
    key: "FX-1", summary: "First fixture task", status: "Open", statusCategory: "new",
    priority: "", assignee: "Unassigned", labels: [], components: [],
    sprint: null, inOpenSprint: false, updated: "2026-01-01T00:00:00.000Z",
    url: "https://fixture.test/t/FX-1", estimateSeconds: null,
  },
  {
    key: "FX-2", summary: "Second fixture task", status: "Doing", statusCategory: "indeterminate",
    priority: "", assignee: "Me", labels: [], components: [],
    sprint: null, inOpenSprint: false, updated: "2026-01-02T00:00:00.000Z",
    url: "https://fixture.test/t/FX-2", estimateSeconds: null,
  },
];

export interface FixtureOptions {
  configured: boolean;
  authed: boolean;
  tasks: JiraTask[];
}

class FixtureProvider implements TaskProvider {
  constructor(private readonly tasks: JiraTask[]) {}

  readonly caps: Capabilities = {
    // No sprint-shaped lens: this source has no sprints at all.
    supportedFilters: ["mine", "all"],
    sizes: false,
    // labels, sprints and components are absent, not false — see Capabilities.
  };

  async list(lens: Filter, _size: Size): Promise<JiraTask[]> {
    return lens === "mine" ? this.tasks.filter((t) => t.assignee === "Me") : this.tasks;
  }

  async detail(key: string): Promise<JiraDetail> {
    const t = this.tasks.find((x) => x.key === key);
    return {
      key, summary: t?.summary ?? "", descriptionText: "A fixture task.",
      labels: [], components: [], url: `https://fixture.test${MARKER}${key}`,
      status: t?.status ?? null, statusCategory: t?.statusCategory ?? null,
    };
  }

  async status(key: string): Promise<{ status: string | null; category: string | null }> {
    const t = this.tasks.find((x) => x.key === key);
    return { status: t?.status ?? null, category: t?.statusCategory ?? null };
  }

  /** Plain statuses: no screen fields, so `fields` is always empty and `moveTo`
   * never needs a recovery round. */
  async statusTargets(_key: string): Promise<StatusTarget[]> {
    return [
      { id: "open", toName: "Open", toCategory: "new", fields: [] },
      { id: "doing", toName: "Doing", toCategory: "indeterminate", fields: [] },
      { id: "done", toName: "Done", toCategory: "done", fields: [] },
    ];
  }

  async moveTo(): Promise<void> { /* accepted */ }
  async assignToMe(): Promise<void> { /* accepted */ }
  async me(): Promise<{ id: string; displayName: string } | null> {
    return { id: "fx-me", displayName: "Me" };
  }
}

export function makeFixtureConnector(over: Partial<FixtureOptions> = {}): TaskConnector {
  const opts: FixtureOptions = { configured: true, authed: true, tasks: FIXTURE_TASKS, ...over };
  return {
    id: "fixture",
    setupSteps: 1,
    info(): SourceInfo {
      return {
        label: "Fixture", scopeNoun: "board", scopeValue: "FX",
        endpoint: "https://fixture.test", exampleKey: "FX-1234",
        endpointSetting: "agentFlow.fixture.endpoint",
        scopeSetting: "agentFlow.fixture.board",
      };
    },
    isConfigured: () => opts.configured,
    configure: async () => true,
    isAuthenticated: async () => opts.authed,
    signIn: async () => true,
    signOut: async () => undefined,
    provider: () => new FixtureProvider(opts.tasks),
    probe: async () => ({ auth: { ok: true, displayName: "Me" }, scope: { ok: true, name: "FX" } }),
    taskUrl: (key) => `https://fixture.test${MARKER}${key}`,
    keyFromUrl: (url) => {
      const i = typeof url === "string" ? url.indexOf(MARKER) : -1;
      return i < 0 ? null : url.slice(i + MARKER.length) || null;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/tasks/ && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add test/_helpers/fixtureConnector.ts test/unit/tasks/fixtureConnector.test.ts
git commit -m "test(tasks): add a capability-free fixture connector

A complete second TaskProvider/TaskConnector over static data that declares no
optional capability, so the views in the next tasks are forced to render a
sprint-less, component-less, label-less, estimate-less source correctly instead
of the seam being an abstraction only one implementation ever tests."
```

---

## Task 8: Move `tasksView` onto the seam

The largest task. `changeStatus` becomes generic; every Jira-only affordance becomes capability-gated.

**Files:**
- Modify: `src/tasksView.ts` — constructor, `client()`, `postState`, `changeStatus`, `collectFields`, `recoverTransition`, `reportWriteFailure`, `addToMySprint`, `removeFromSprint`, `addToSprint`, the component-sync handler, the `onMessage` catch
- Modify: `src/types.ts` — `OutboundMessage`'s `state` and `detail`
- Test: `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `TaskConnector`, `TaskProvider`, `TaskAuthError`, `TaskApiError`, `TaskWriteError`, `isTaskNetworkError`, `serializeCaps` (Task 2); `makeFixtureConnector` (Task 7).
- Produces: `TasksViewProvider` constructor signature `(context, connector: TaskConnector, log?)`. Tasks 9-11 depend on this.

- [ ] **Step 1: Write the failing capability-gating tests**

```ts
// append to test/unit/tasksView.test.ts
import { makeFixtureConnector } from "../_helpers/fixtureConnector";

describe("a source with no optional capabilities", () => {
  it("posts only the filters that source supports", async () => {
    const { posted } = await mountWith(makeFixtureConnector());
    const state = posted.find((m) => m.type === "state");
    expect(state.caps.supportedFilters).toEqual(["mine", "all"]);
    expect(state.caps.sprints).toBe(false);
    expect(state.caps.components).toBe(false);
    expect(state.caps.sizes).toBe(false);
    expect(state.sourceLabel).toBe("Fixture");
  });

  it("refuses a sprint write instead of throwing", async () => {
    const { view, posted } = await mountWith(makeFixtureConnector());
    await view.addToMySprint("FX-1");
    expect(posted.some((m) => m.type === "movedToSprint")).toBe(false);
    const toast = posted.find((m) => m.type === "toast");
    expect(toast.level).toBe("error");
    expect(toast.message).toMatch(/Fixture/);
  });

  it("treats stampLabelOnWrite as a silent no-op, not a crash", async () => {
    // stampLabelOnWrite defaults true; a label-less source must still complete.
    const { view, posted } = await mountWith(makeFixtureConnector());
    await view.changeStatus("FX-1");
    expect(posted.some((m) => m.type === "statusChanged")).toBe(true);
    expect(posted.filter((m) => m.type === "toast").every((t) => t.level !== "error")).toBe(true);
  });

  it("changes status with no field prompts", async () => {
    const { view, posted } = await mountWith(makeFixtureConnector());
    await view.changeStatus("FX-1");
    const changed = posted.find((m) => m.type === "statusChanged");
    expect(changed).toBeDefined();
  });
});

describe("a refused write that names fields to retry", () => {
  it("re-prompts exactly the fields the connector asked for, then retries once", async () => {
    const moveTo = vi.fn()
      .mockRejectedValueOnce(new TaskWriteError("needs Impact", [
        { kind: "text", id: "customfield_1", name: "Impact" },
      ]))
      .mockResolvedValueOnce(undefined);
    const connector = withProvider({ moveTo });
    stubInputBox("high"); // the re-prompt answer
    const { view, posted } = await mountWith(connector);
    await view.changeStatus("A-1");
    expect(moveTo).toHaveBeenCalledTimes(2);
    expect(moveTo.mock.calls[1][2]).toEqual({ customfield_1: "high" });
    expect(posted.some((m) => m.type === "statusChanged")).toBe(true);
  });

  it("reports and stops when retryWith is empty", async () => {
    const moveTo = vi.fn().mockRejectedValue(new TaskWriteError("no permission", []));
    const { view, posted } = await mountWith(withProvider({ moveTo }));
    await view.changeStatus("A-1");
    expect(moveTo).toHaveBeenCalledTimes(1);
    const toast = posted.find((m) => m.type === "toast" && m.level === "error");
    expect(toast.message).toContain("no permission");
    expect(toast.action.label).toMatch(/^Open in /);
  });
});
```

Reuse this file's existing harness rather than inventing one: find how it currently mounts a `TasksViewProvider` and captures `postMessage`, and write `mountWith(connector)`, `withProvider(overrides)` and `stubInputBox(answer)` as thin wrappers over it. If the file has no such harness, add these three helpers at the top of the file.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: FAIL — the constructor still wants a `JiraAuth`, and `state` has no `caps`.

- [ ] **Step 3: Widen the outbound messages**

In `src/types.ts`, add to the `state` variant and rename the detail field:

```ts
  | { type: "state"; authed: boolean; configured: boolean; project: string; me: string | null;
      prReviewStatus: string; filters: FilterVisibility; liveCount?: number;
      /** The task source's user-facing name — every "Sign in to X" string reads
       * this rather than hardcoding a tracker. */
      sourceLabel: string;
      /** Which optional affordances to render. Flat booleans: the capability
       * objects on TaskProvider cannot be structured-cloned. */
      caps: SerializedCaps }
```

and in the `detail` variant, rename `jiraComponents` to `sourceComponents` (same type, same meaning).

Import `SerializedCaps` from `./tasks/provider`.

- [ ] **Step 4: Swap the constructor and the client accessor**

```ts
// src/tasksView.ts — constructor
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connector: TaskConnector,
    private readonly log: (m: string) => void = () => {},
  ) {}

// replacing client()
  private provider(): TaskProvider {
    return this.connector.provider();
  }
```

Then mechanically: `this.auth.isAuthenticated()` → `this.connector.isAuthenticated()`; `!!cfg.baseUrl && !!cfg.project` → `this.connector.isConfigured()`; `this.client()` → `this.provider()`; `client.fetchTasks(f, s)` → `provider.list(f, s)`; `client.getDetail` → `provider.detail`; `client.getMyself` → `provider.me`; `client.getStatus` → `provider.status`.

`postState` gains the two new fields:

```ts
  private postState(authed: boolean, configured: boolean, me: string | null): void {
    const cfg = getConfig();
    const info = this.connector.info();
    this.post({ type: "state", authed, configured, project: info.scopeValue, me,
      prReviewStatus: cfg.prReviewStatus, filters: cfg.filters,
      sourceLabel: info.label, caps: serializeCaps(this.provider().caps),
      liveCount: cfg.trackOpenWindows ? this.liveWindows().length : undefined });
  }
```

- [ ] **Step 5: Rewrite `changeStatus` generically**

Replace `changeStatus`, `recoverTransition` and `reportWriteFailure`. `collectFields` stays as it is except that `toJiraValue(p, raw)` becomes the raw answer — the connector maps it now:

```ts
  /** Change a task's status via a menu of the moves its source allows. */
  public async changeStatus(key: string): Promise<void> {
    this.log(`changeStatus ${key}: start`);
    if (!(await this.connector.isAuthenticated())) {
      this.postState(false, this.connector.isConfigured(), null);
      return;
    }
    const provider = this.provider();
    const targets = await provider.statusTargets(key);
    this.log(`changeStatus ${key}: ${targets.length} targets`);
    if (targets.length === 0) {
      this.toast("info", `No status transitions available for ${key}.`);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      targets.map((t) => ({
        label: `$(arrow-small-right) ${t.toName}`,
        description: t.via ? `via "${t.via}"` : "",
        t,
      })),
      { title: `${key} — change status to…`, placeHolder: "Pick a status", ignoreFocusOut: true },
    );
    this.log(`changeStatus ${key}: picked ${pick ? pick.t.toName : "(cancelled)"}`);
    if (!pick) return;
    const target = pick.t;

    const values = await this.collectFields(key, target.toName, target.fields);
    if (values === undefined) {
      this.log(`changeStatus ${key}: cancelled at a field prompt`);
      return;
    }

    try {
      await provider.moveTo(key, target.id, values);
    } catch (e) {
      if (!(e instanceof TaskWriteError)) throw e;
      // One rescue attempt, and only when the connector named something to ask
      // for. Anything else is reported in place — a refused write leaves the
      // list valid, so it never re-gates the panel.
      if (!e.retryWith.length) {
        this.reportWriteFailure(key, e.message);
        return;
      }
      this.log(`changeStatus ${key}: rejected — re-prompting ${e.retryWith.map((p) => p.name).join(", ")}`);
      const extra = await this.collectFields(key, target.toName, e.retryWith);
      if (extra === undefined) return;
      try {
        await provider.moveTo(key, target.id, { ...values, ...extra });
      } catch (e2) {
        if (!(e2 instanceof TaskWriteError)) throw e2;
        this.reportWriteFailure(key, e2.message);
        return;
      }
    }
    this.log(`changeStatus ${key}: move ok → ${target.toName}`);
    await this.stampProvenance(key);
    const removed = target.toCategory === "done";
    this.post({ type: "statusChanged", key, status: target.toName, category: target.toCategory, removed });
    this.toast("success", `${key} → ${target.toName}`);
  }

  /** Stamp the provenance label, when the source has labels at all and the user
   * wants it. A source without them is a silent no-op, never an error: the write
   * that mattered already succeeded. */
  private async stampProvenance(key: string): Promise<void> {
    const cfg = getConfig();
    const labels = this.provider().caps.labels;
    if (!cfg.stampLabelOnWrite || !labels) return;
    try {
      await labels.add(key, cfg.provenanceLabel);
    } catch (e) {
      this.log(`label stamp failed for ${key}: ${e}`);
    }
  }

  /** A refused write gets a toast — never the gate — with a way out to the task. */
  private reportWriteFailure(key: string, message: string): void {
    const info = this.connector.info();
    const text = `Couldn't update ${key}. ${message}`;
    this.log(`changeStatus ${key}: ${text}`);
    this.toast("error", text, {
      label: `Open in ${info.label}`,
      url: this.connector.taskUrl(key),
    });
  }
```

In `collectFields`, change the three assignment lines from `out[p.id] = toJiraValue(p, …)` to the raw value, and change the return type to `Record<string, string | string[]> | undefined`:

```ts
        out[p.id] = picked.map((i) => i.label);   // multipick
        out[p.id] = picked.label;                 // pick
        out[p.id] = raw;                          // text/number/date/datetime/labels
```

Drop the `toJiraValue` import.

- [ ] **Step 6: Capability-gate the sprint and component writes**

Add a guard helper and use it at the top of `addToMySprint`, `removeFromSprint` and `addToSprint`:

```ts
  /** The sprint operations, or null with the user told why. A source without
   * sprints should never have surfaced the affordance — the webview hides it on
   * `caps.sprints` — so this is the backstop for a stale webview or a command
   * invoked from the palette. */
  private sprints(): NonNullable<TaskProvider["caps"]["sprints"]> | null {
    const ops = this.provider().caps.sprints;
    if (!ops) {
      this.toast("error", `${this.connector.info().label} doesn't have sprints.`);
      return null;
    }
    return ops;
  }
```

`addToMySprint` becomes: guard on `sprints()`, then `provider.me()` (error toast reading `` `Couldn't resolve your ${info.label} account.` ``), then `ops.activeId()` (error toast reading `` `No active sprint on the ${info.scopeValue} board.` ``), then `ops.add(sprintId, key)`, `provider.assignToMe(key)`, `await this.stampProvenance(key)`. `removeFromSprint` uses `ops.remove(key)` and `ops.activeId()`/`ops.add()` for its Undo. `addToSprint` uses `ops.activeId()`/`ops.add()`.

The component-sync handler guards the same way on `this.provider().caps.components`, replacing `client.listComponents()` → `components.list()` and `client.updateComponents(...)` → `components.update(...)`, and posts `componentsChanged` with `ok: false` when the capability is absent.

- [ ] **Step 7: Retarget the error handling**

In the `onMessage` catch and in `resolveOp`, replace `JiraAuthError` → `TaskAuthError` and `JiraApiError` → `TaskApiError`. The network marker was already migrated in Task 4, so `isTaskNetworkError` should already be what this file imports — if you find `isJiraNetworkError` here, Task 4 was left incomplete; fix it rather than re-aliasing. The `Op` values passed to `trackError` (`"jira_fetch"`, `"jira_write"`, `"jira_auth"`) **do not change** — they are transmitted telemetry.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS, including `test/unit/compat.test.ts` untouched. Existing `tasksView` tests will need their construction updated from `new TasksViewProvider(ctx, auth, log)` to a connector — this is mechanical, and **no assertion about behaviour may be weakened** to get there.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(tasksView): drive the panel through TaskProvider

changeStatus is now generic: pick a target, prompt its fields, move, and retry
once if the connector names fields to re-ask for. Sprint, component and label
writes are gated on declared capabilities, with a label-less source completing
a status change as a silent no-op rather than an error. The panel posts the
source label and serialized capabilities so the webview can hide what a source
cannot do."
```

---

## Task 9: Move `deckView` and `ticketKeyFor` onto the seam

**Files:**
- Modify: `src/deckView.ts` (`DeckPanel.show`, constructor, `client()`, the status poll), `src/types.ts` (`ticketKeyFor`)
- Test: `test/unit/deckView.test.ts`, `test/unit/compat.test.ts`

**Interfaces:**
- Consumes: `TaskConnector` (Task 6).
- Produces: `ticketKeyFor(run: Run, connector: Pick<TaskConnector, "keyFromUrl">): string`; `DeckPanel.show(context, connector, log)`.

- [ ] **Step 1: Extend the compat test for the new signature**

```ts
// in test/unit/compat.test.ts, replace the ticketKeyFor block with:
  it("recovers a ticket key from a run url already on disk", () => {
    const jira = { keyFromUrl: (u: string) => {
      const i = u.indexOf("/browse/");
      return i < 0 ? null : u.slice(i + 8) || null;
    } };
    expect(ticketKeyFor(makeRun({ key: "ABC-1", url: "https://x.atlassian.net/browse/ABC-1" }), jira)).toBe("ABC-1");
    expect(ticketKeyFor(makeRun({ key: "a1b2c3", url: "https://x.atlassian.net/browse/ABC-9" }), jira)).toBe("ABC-9");
    expect(ticketKeyFor(makeRun({ key: "explore-foo", url: "" }), jira)).toBe("explore-foo");
    // A record from a different source falls back to the record key.
    expect(ticketKeyFor(makeRun({ key: "FX-1", url: "https://fixture.test/t/FX-1" }), jira)).toBe("FX-1");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/compat.test.ts`
Expected: FAIL — `ticketKeyFor` takes one argument.

- [ ] **Step 3: Implement**

```ts
// src/types.ts
/** The task key to poll for a run. A task run's key IS its ticket, but a local
 * card Track it saved under its place-hash — because a real run already owned
 * the inferred key — carries the ticket only in its url. The connector owns the
 * url shape; a url it does not recognise (a record from another source, or an
 * Explore run with none) falls back to the record key, which is what every run
 * Agent Flow launched already equals. */
export function ticketKeyFor(
  run: Run,
  connector: { keyFromUrl(url: string): string | null },
): string {
  const url = typeof run.url === "string" ? run.url : "";
  return connector.keyFromUrl(url) ?? run.key;
}
```

In `src/deckView.ts`: `DeckPanel.show(context, connector: TaskConnector, log)`, the field `private readonly auth: JiraAuth` → `private readonly connector: TaskConnector`, `client()` → `this.connector.provider()`, `this.client().getStatus(key)` → `provider.status(key)`, `JiraAuthError` → `TaskAuthError`, and every `ticketKeyFor(run)` → `ticketKeyFor(run, this.connector)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(deck): resolve task keys through the connector

ticketKeyFor takes the connector, so the /browse/ parsing that every persisted
run record depends on lives in the Jira connector rather than in types.ts —
and a record from another source falls back to its own key instead of being
mis-parsed."
```

---

## Task 10: Move Doctor onto the seam

**Files:**
- Modify: `src/doctorView.ts` (`DoctorConfig`, `DoctorDeps`, `collectInputs`, `defaultDeps`), `src/engine/doctor.ts` (`DoctorGroup`, `DoctorInputs`, the source rows)
- Test: `test/unit/doctorView.test.ts`, `test/unit/doctorView.deps.test.ts`, `test/unit/engine/doctor.test.ts`

**Interfaces:**
- Consumes: `TaskConnector` (Task 6).
- Produces: `defaultDeps(connector: TaskConnector, log): DoctorDeps`; `DoctorDeps.probe: () => Promise<{auth?: AuthProbe; scope?: ProjectProbe}>` replacing `probeMyself` and `getProject`; `DoctorInputs` gains `sourceLabel`, `scopeNoun`, `endpointSetting`, `scopeSetting` and renames `baseUrl`→`endpoint`, `project`→`scope`.

- [ ] **Step 1: Write the failing test**

```ts
// append to test/unit/engine/doctor.test.ts
it("labels the source rows from the connector, not from Jira", () => {
  const checks = runChecks(inputs({
    sourceLabel: "Fixture", scopeNoun: "board", endpoint: "https://fixture.test", scope: "FX",
    endpointSetting: "agentFlow.fixture.endpoint", scopeSetting: "agentFlow.fixture.board",
  }));
  const group = checks.filter((c) => c.group === "source");
  expect(group.map((c) => c.label)).toContain("Board configured");
  expect(group.some((c) => c.detail?.includes("agentFlow.jira"))).toBe(false);
});

it("names the missing setting when the scope is empty", () => {
  const checks = runChecks(inputs({
    sourceLabel: "Jira", scopeNoun: "project", scope: "",
    scopeSetting: "agentFlow.jira.project",
  }));
  const row = checks.find((c) => c.label === "Project configured");
  expect(row.status).toBe("fail");
  expect(row.detail).toBe("agentFlow.jira.project is empty");
});
```

Use the `inputs(...)` builder that file already has, extended with the new fields.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/engine/doctor.test.ts`
Expected: FAIL — no `sourceLabel` on `DoctorInputs`; groups are still `"Jira"`.

- [ ] **Step 3: Implement**

In `src/engine/doctor.ts`:

```ts
/** `"source"` is a placeholder the renderer swaps for the connector's own label,
 * so a Jira user still reads "Jira" while the pure module stays source-agnostic.
 * The other four are fixed. */
export type DoctorGroup = "source" | "Local" | "GitHub" | "Claude Code" | "State";
```

`DoctorInputs` renames `baseUrl` → `endpoint` and `project` → `scope`, and gains `sourceLabel: string`, `scopeNoun: string`, `endpointSetting: string`, `scopeSetting: string`. Every row that had `group: "Jira"` becomes `group: "source"`. The row labels and details become:

```ts
const Noun = (n: string) => n.charAt(0).toUpperCase() + n.slice(1);
// "Site configured" stays as-is (every source has an endpoint).
detail: i.endpoint ? (…) : `${i.endpointSetting} is empty`,
// scope rows:
label: `${Noun(i.scopeNoun)} configured`,   // "Project configured" for Jira
detail: i.scope || `${i.scopeSetting} is empty`,
label: `${Noun(i.scopeNoun)} resolves`,     // "Project resolves" for Jira
```

In `src/doctorView.ts`, `DoctorDeps` loses `probeMyself` and `getProject` and gains `probe: () => Promise<{ auth?: AuthProbe; scope?: ProjectProbe }>`. `collectInputs` loses its two try/catch blocks entirely — the classification now lives in the connector — and becomes:

```ts
  const { auth, scope } = await (hasCredentials ? d.probe() : Promise.resolve({}));
  const authProbe = auth as AuthProbe | undefined;
  const projectProbe = scope as ProjectProbe | undefined;
```

`defaultDeps(connector: TaskConnector, log)` builds `config()` from `connector.info()` and wires `probe: () => connector.probe()`. Drop the `JiraClient` / `JiraAuthError` / `JiraApiError` / `describeJiraError` imports from `doctorView.ts`.

Where the QuickPick renders group headings, map `"source"` → `cfg().sourceLabel`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS. A Jira user's Doctor output must be textually identical to before — verify by eye against the pre-change strings in the test fixtures.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(doctor): probe the task source through the connector

The Jira-error classification moves into the connector's probe(); Doctor keeps
its already source-agnostic AuthProbe/ProjectProbe shapes and takes the label,
scope noun and setting ids from the connector. A Jira user reads exactly the
same rows as before."
```

---

## Task 11: Move setup and activation onto the seam

**Files:**
- Modify: `src/setup.ts` (`runSetup`, `maybeRunSetup`), `src/extension.ts` (`activate`)
- Test: `test/unit/setup.test.ts`, `test/unit/extension.test.ts`

**Interfaces:**
- Consumes: `TaskConnector` (Task 6), `resolveConnector` (Task 6), the Task 8/9/10 signatures.
- Produces: `runSetup(context, connector, log, refresh?)`, `maybeRunSetup(context, connector, log, refresh?)`.

- [ ] **Step 1: Write the failing test**

```ts
// append to test/unit/setup.test.ts
it("numbers the wizard across the connector's steps plus the repos root", async () => {
  const configure = vi.fn(async () => true);
  const connector = { ...makeFixtureConnector(), setupSteps: 2, configure, signIn: vi.fn(async () => true) };
  stubInputBox("~/projects");
  await runSetup(ctx(), connector as never, () => {});
  // 2 connector steps + 1 repos root = 3 total, connector starts at 1.
  expect(configure).toHaveBeenCalledWith(1, 3);
});

it("does not mark setup complete when the connector's configure is cancelled", async () => {
  const update = vi.fn(async () => undefined);
  const connector = { ...makeFixtureConnector(), configure: vi.fn(async () => false) };
  const context = { ...ctx(), globalState: { get: () => undefined, update } };
  expect(await runSetup(context as never, connector as never, () => {})).toBe(false);
  expect(update).not.toHaveBeenCalledWith("agentFlow.setupComplete", true);
});

it("stays quiet when the connector reports itself already configured", async () => {
  const update = vi.fn(async () => undefined);
  const connector = { ...makeFixtureConnector(), isConfigured: () => true };
  const context = { ...ctx(), globalState: { get: () => undefined, update } };
  await maybeRunSetup(context as never, connector as never, () => {});
  expect(update).toHaveBeenCalledWith("agentFlow.setupComplete", true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/setup.test.ts`
Expected: FAIL — `runSetup` takes a `JiraAuth`.

- [ ] **Step 3: Implement**

`src/setup.ts` — `runSetup(context, connector: TaskConnector, log, refresh?)`:

```ts
  const total = connector.setupSteps + 1; // + the repos root, which is ours not theirs
  if (!(await connector.configure(1, total))) {
    return abort(log, "cancelled at source configuration");
  }

  const reposRoot = await vscode.window.showInputBox({
    title: `Agent Flow Deck Setup (${total}/${total})`,
    prompt: "Directory where your repo checkouts live",
    ignoreFocusOut: true,
    value: "~/projects",
    validateInput: (v) => (v.trim() ? undefined : "Enter a directory path"),
  });
  if (reposRoot === undefined) return abort(log, "cancelled at repos root");

  const cleanRoot = reposRoot.trim().replace(/\/+$/, "");
  await updateGlobal("reposRoot", cleanRoot);
  await updateGlobal("workspaceDir", cleanRoot);
  log(`setup: config saved (root ${cleanRoot})`);

  const label = connector.info().label;
  if (!(await connector.signIn())) {
    vscode.window.showWarningMessage(
      `Agent Flow Deck: settings saved, but ${label} sign-in was cancelled. Use "Sign in to ${label}" to finish.`,
    );
    return abort(log, "sign-in skipped (config saved)");
  }
```

The `baseUrl` / `project` input boxes and their `updateGlobal` calls are **deleted** from `setup.ts` — the connector owns them now (Task 6 already wrote them).

`maybeRunSetup(context, connector, log, refresh?)` replaces its inline config check with `connector.isConfigured()` and its welcome message with `` `Welcome to Agent Flow Deck — let's connect it to your ${label}.` ``.

`src/extension.ts`:

```ts
  const output = vscode.window.createOutputChannel("Agent Flow Deck");
  const log = (m: string) => output.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
  const connector = resolveConnector(context, log);
  const provider = new TasksViewProvider(context, connector, log);
```

Then: `auth.signIn()` → `connector.signIn()`; the two toasts read
`` `Agent Flow Deck: signed in to ${connector.info().label}.` ``; the `takeTask`
title reads `` `Take a ${connector.info().label} task` `` and the example key
`connector.info().exampleKey`; `DeckPanel.show(context, connector, log)`;
`runSetup(context, connector, …)`; `maybeRunSetup(context, connector, …)`;
`showDoctor(defaultDeps(connector, log))`; and in the `extension_activated`
payload, `auth.isAuthenticated()` → `connector.isAuthenticated()` with
`is_configured: connector.isConfigured()`. **`has_jira_auth` keeps its name** —
it is a transmitted property.

The `output` channel must now be created **before** `resolveConnector`, since the
registry's fallback logs. Keep it in `context.subscriptions.push(...)` as before.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS, typecheck clean, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(setup): let the connector own its own wizard steps

runSetup asks the connector to collect its settings and numbers the wizard
across setupSteps + 1, so a connector with a different step count still reads
'(2/4)' correctly. Activation resolves the connector from the registry and
takes every user-facing label from it. has_jira_auth keeps its wire name."
```

---

## Task 12: Rename the domain types

Mechanical, and last among the source changes so every earlier task had a stable name to import.

**Files:**
- Modify: `src/types.ts`, `src/tasks/provider.ts`, `src/tasks/jira/provider.ts`, `src/engine/{status,retire,order,infer}.ts`, `src/webview/helpers.ts`, `src/webview/App.tsx`, `test/_helpers/factories.ts`, plus every importer the typecheck names
- Test: the whole suite

**Interfaces:**
- Consumes: nothing new.
- Produces: `Task` (was `JiraTask`), `TaskDetail` (was `JiraDetail`), `ticketCategory` / `ticketStatus` / `ticket` fields (were `jiraCategory` / `jiraStatus` / `jira`).

- [ ] **Step 1: Rename the two exported types**

In `src/types.ts`: `export interface JiraTask` → `export interface Task`, narrowing `statusCategory: string` to `statusCategory: "new" | "indeterminate" | "done"`. `JiraDetail` lives in `src/tasks/jira/client.ts`; re-export it from `src/tasks/provider.ts` as `TaskDetail` (Task 2 already does this via alias — now make it the real name and drop the alias).

```bash
grep -rl "JiraTask" src/ test/ | xargs sed -i '' 's/\bJiraTask\b/Task/g'
grep -rl "JiraDetail" src/ test/ | xargs sed -i '' 's/\bJiraDetail\b/TaskDetail/g'
```

Then remove the now-redundant `JiraDetail as TaskDetail` / `JiraTask as Task` import aliases in `src/tasks/provider.ts` and `src/tasks/jira/provider.ts`.

- [ ] **Step 2: Rename the status/retire fields — sweep the whole tree, not a file list**

**Do not enumerate files here.** The Deck Orchestrator is being built in parallel and its `src/engine/orchestrator/conditions.ts` reads `status.jiraCategory` and `status.jiraStatus` (see its Phase 1 plan, lines 22-25). If it landed before this task, a hand-written file list silently misses it and the typecheck failure will point somewhere unhelpful. Sweep by content:

```bash
grep -rl "jiraCategory\|jiraStatus\|JiraInfo" src/ test/ \
  | xargs sed -i '' 's/\bjiraCategory\b/ticketCategory/g; s/\bjiraStatus\b/ticketStatus/g; s/\bJiraInfo\b/TicketInfo/g'
```

Then confirm nothing was left behind, including in the parallel work:

```bash
grep -rn "jiraCategory\|jiraStatus\|JiraInfo" src/ test/ || echo "clean"
```

In `src/engine/status.ts`, rename the `jira:` property on its inputs to `ticket:` and update `src/deckView.ts`'s call site. `retire.ts:47`'s `=== "done"` comparison is **unchanged**.

If `src/engine/orchestrator/` exists, two extra things are true and neither is optional:
- its condition **kinds** are already `ticket-done` / `ticket-status-is` and must **not** be touched — they are persisted inside users' saved flow files, and renaming one would need a migration;
- its `conditions.test.ts` fixtures construct a `RunStatus` literal, so the sweep above updates them too. Re-run `npx vitest run test/unit/engine/orchestrator/` and expect PASS.

- [ ] **Step 3: Rename the detail-message component field**

```bash
sed -i '' 's/\bjiraComponents\b/sourceComponents/g' src/types.ts src/tasksView.ts src/webview/App.tsx test/webview/*.ts*
```

In `src/webview/App.tsx`, the local `jira?: string[]` field on the detail state becomes `sourceComponents?: string[]`.

- [ ] **Step 4: Fix what the typecheck names**

Run: `npm run typecheck`
Expected: a list of narrowing errors where `statusCategory` was assigned a plain `string`. Fix each by asserting at the boundary that produced it — in `JiraClient.normalize`, `f.status?.statusCategory?.key ?? "new"` becomes:

```ts
      statusCategory: (f.status?.statusCategory?.key ?? "new") as Task["statusCategory"],
```

That cast is the one place Jira's untyped JSON enters the typed domain, and it is why the union exists.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck && npm run test:cov && npm run build`
Expected: all PASS, coverage thresholds met (statements 90, branches 85, functions 85, lines 90).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: rename the domain types off Jira

JiraTask becomes Task with statusCategory narrowed to the three values the
board actually branches on, JiraDetail becomes TaskDetail, and status/retire's
jiraCategory/jiraStatus become ticketCategory/ticketStatus. Internal only — no
setting, secret, command or telemetry value moves."
```

---

## Task 13: Capability-gate the webview

**Files:**
- Modify: `src/webview/App.tsx`
- Test: `test/webview/helpers.test.ts` (or a new `test/webview/caps.test.tsx`)

**Interfaces:**
- Consumes: `SerializedCaps` and `sourceLabel` on the `state` message (Task 8).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
// test/webview/caps.test.tsx
import { describe, expect, it } from "vitest";
import { visibleFilters, gateCopy } from "../../src/webview/helpers";

describe("visibleFilters", () => {
  it("keeps the shipped tab order, not the connector's array order", () => {
    expect(visibleFilters(["all", "mine"])).toEqual(["mine", "all"]);
  });

  it("drops tabs the source does not support", () => {
    expect(visibleFilters(["mine", "all"])).not.toContain("mysprint");
  });

  it("falls back to every tab when a source declares none", () => {
    // An empty tab bar is a dead end with no in-product way out.
    expect(visibleFilters([]).length).toBeGreaterThan(1);
  });
});

describe("gateCopy", () => {
  it("names the configured source", () => {
    expect(gateCopy("Fixture").connecting).toBe("Connecting to Fixture…");
    expect(gateCopy("Fixture").signIn).toBe("Sign in to Fixture");
  });

  it("reads identically to the pre-seam copy for Jira", () => {
    const c = gateCopy("Jira");
    expect(c.connecting).toBe("Connecting to Jira…");
    expect(c.signIn).toBe("Sign in to Jira");
    expect(c.unconfigured).toBe(
      "Agent Flow Deck isn't connected to Jira yet — add your site URL and project to get started.",
    );
    expect(c.unauthed).toBe("Connect Agent Flow Deck to your Jira to see your task pool.");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/webview/caps.test.tsx`
Expected: FAIL — `visibleFilters` and `gateCopy` are not exported.

- [ ] **Step 3: Implement the two pure helpers**

```ts
// src/webview/helpers.ts
import { Filter } from "../types";

/** The shipped tab order. A connector's `supportedFilters` says *which* tabs
 * exist, never in what order they render. */
const FILTER_ORDER: Filter[] = ["unassigned", "mine", "mysprint", "sprint", "backlog", "all"];

export function visibleFilters(supported: readonly Filter[]): Filter[] {
  const allowed = new Set(supported);
  const shown = FILTER_ORDER.filter((f) => allowed.has(f));
  // An empty tab bar is a dead end with no in-product way out of it — the same
  // reasoning as config.ts's resolveModes falling back to its built-ins.
  return shown.length ? shown : [...FILTER_ORDER];
}

/** Every gate-screen string, with the source named. Pure so the copy is testable
 * without mounting the app. */
export function gateCopy(label: string): {
  connecting: string; unconfigured: string; unauthed: string; signIn: string; openIn: string;
} {
  return {
    connecting: `Connecting to ${label}…`,
    unconfigured: `Agent Flow Deck isn't connected to ${label} yet — add your site URL and project to get started.`,
    unauthed: `Connect Agent Flow Deck to your ${label} to see your task pool.`,
    signIn: `Sign in to ${label}`,
    openIn: `Open in ${label}`,
  };
}
```

- [ ] **Step 4: Wire them into `App.tsx`**

Store `sourceLabel` and `caps` from the `state` message in component state (default `sourceLabel` to `""` and `caps` to every capability on, so a first paint before `state` arrives renders today's UI). Then:

- the four gate strings at lines ~429-446 read `gateCopy(sourceLabel)`;
- the tab bar maps `visibleFilters(caps.supportedFilters)`;
- the size control renders only when `caps.sizes && filters.size`;
- the sprint card actions render only when `caps.sprints`;
- the component chips block renders only when `caps.components`;
- the `title="Open in Jira"` attribute reads `gateCopy(sourceLabel).openIn`;
- `` `Not on ${taskKey} in Jira — ↑ adds it` `` reads
  `` `Not on ${taskKey} in ${sourceLabel} — ↑ adds it` ``.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(webview): render only what the task source supports

Filter tabs come from the connector's supportedFilters in the shipped order,
the size control needs caps.sizes, and sprint actions and component chips need
their capabilities. Gate copy is a pure gateCopy(label) helper, asserted to read
byte-identically to the pre-seam strings for Jira."
```

---

## Task 14: Docs

**Files:**
- Create: `docs/CONNECTORS.md`
- Modify: `CONTRIBUTING.md`, `CHANGELOG.md`
- Test: `test/unit/docs.test.ts`

**Interfaces:**
- Consumes: `CONNECTOR_IDS`.
- Produces: nothing importable.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/docs.test.ts
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { CONNECTOR_IDS } from "../../src/tasks/registry";

const read = (p: string) => fs.readFileSync(path.join(__dirname, "../..", p), "utf8");

describe("connector docs", () => {
  it("documents every registered connector", () => {
    const doc = read("docs/CONNECTORS.md");
    for (const id of CONNECTOR_IDS) expect(doc).toContain(`\`${id}\``);
  });

  it("states the compatibility rules a connector author must not break", () => {
    const doc = read("docs/CONNECTORS.md");
    expect(doc).toMatch(/never rename/i);
    expect(doc).toContain("agentFlow.<id>.*");
  });

  it("is linked from CONTRIBUTING", () => {
    expect(read("CONTRIBUTING.md")).toContain("docs/CONNECTORS.md");
  });

  it("records the new setting under Unreleased", () => {
    const changelog = read("CHANGELOG.md");
    const unreleased = changelog.slice(
      changelog.indexOf("## [Unreleased]"),
      changelog.indexOf("## [0.4.2]"),
    );
    expect(unreleased).toContain("agentFlow.taskSource");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/docs.test.ts`
Expected: FAIL — `docs/CONNECTORS.md` does not exist.

- [ ] **Step 3: Write `docs/CONNECTORS.md`**

It must contain, in this order:
1. **What a connector is** — the two interfaces, and that Jira (`jira`) is the shipped default.
2. **`TaskProvider`, method by method** — signature, what calls it, and what a source that cannot answer should do.
3. **The capability table** — for each of `labels`, `sprints`, `components`, `sizes`, `supportedFilters`: what UI it unlocks, and exactly what degrades when it is absent (label stamping becomes a silent no-op; sprint actions and component chips disappear; the size control disappears; unsupported tabs do not render).
4. **`TaskConnector`, method by method**, including that `info()` feeds every user-facing string and `keyFromUrl` must return `null` for a url belonging to another source.
5. **The checklist:** implement both interfaces → add your directory under `src/tasks/<id>/` → register one line in `src/tasks/registry.ts` → add your settings under `agentFlow.<id>.*` in `package.json` → add your id to the `agentFlow.taskSource` `enum` **and** `enumDescriptions` (a missing entry makes the setting un-pickable even though the registry accepts it; `test/unit/tasks/registry.test.ts` enforces the pair) → add tests.
6. **The compatibility rules:** own your settings namespace `agentFlow.<id>.*`; own your SecretStorage keys; **never rename** either once released, because doing so silently signs every user out or strands their configuration.
7. **The inherited assumption:** `estimateSeconds` is rendered against an 8-hour workday (`src/webview/helpers.ts`), so report it in seconds on that basis.
8. **The minimal example** — a walkthrough of `test/_helpers/fixtureConnector.ts`, the capability-free reference implementation.

- [ ] **Step 4: Update `CONTRIBUTING.md` and `CHANGELOG.md`**

Add under **Conventions** in `CONTRIBUTING.md`, after the "No hardcoded organization values" bullet:

```markdown
- **Task sources are pluggable.** Jira is the default connector, not a hardwired
  dependency. Anything reading or writing tickets goes through `TaskProvider` /
  `TaskConnector` in `src/tasks/provider.ts` — never `src/tasks/jira/` directly.
  To add a source, see [docs/CONNECTORS.md](docs/CONNECTORS.md).
```

Add under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
### Added

- **Pluggable task sources.** Where Agent Flow reads tasks from is now a
  connector behind a `TaskProvider` / `TaskConnector` seam, selected by the new
  `agentFlow.taskSource` setting. Jira remains the default and the only shipped
  source, and every existing install keeps its settings, credentials and board
  untouched — the setting defaults to `jira`. Adding a source is one directory
  and one registry line; see [docs/CONNECTORS.md](docs/CONNECTORS.md)
  (`src/tasks/`, `src/tasksView.ts`, `src/deckView.ts`, `src/doctorView.ts`).
```

- [ ] **Step 5: Run the full gate**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`
Expected: everything PASS, coverage thresholds met, `test/unit/compat.test.ts` green with no assertion weakened since Task 1.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: add the connector authoring guide

Documents both interfaces method by method, what each capability unlocks and
what degrades without it, the six-step checklist for adding a source, and the
compatibility rules — own your settings namespace and secret keys, and never
rename either once released."
```

---

## Manual verification before merge

Automated tests cannot prove the one thing that matters most. Do this by hand:

- [ ] On a machine with a **configured, signed-in** Agent Flow install, build this branch and reload. The task pool must load with **no sign-in prompt, no setup wizard, no toast** — identical to before.
- [ ] Open the Deck. Existing run cards must still show their ticket status.
- [ ] Run **Doctor**. Every row must read exactly as it did before, under a "Jira" heading.
- [ ] Change a ticket's status, including one whose transition demands a required field, and one your workflow refuses — the re-prompt and the refusal toast must behave as before.
- [ ] Take a ticket (sprint + assign + label), and remove one from a sprint with Undo.
- [ ] Toggle a component chip both directions.
- [ ] Set `agentFlow.taskSource` to `"nonsense"`, reload, and confirm the board still loads on Jira with a line in the **Agent Flow Deck** output channel.

---

## Self-review notes

**Spec coverage.** §1 seam → Tasks 2, 5, 6. §2 frozen surface → Task 1 plus the Global Constraints, re-verified in Task 14 Step 5. §3 consumers → Tasks 8 (tasksView), 9 (deckView + `ticketKeyFor`), 10 (Doctor), 11 (setup + activation), 12 (`engine/status`, `engine/retire`, types), 13 (webview). §4 registry/config/fixture/docs → Tasks 6, 7, 14. §5 gates → Global Constraints, enforced at Task 12 Step 5 and Task 14 Step 5. §7 out-of-scope items are respected: no second shipped connector, no default prompt rewritten (no task touches config.ts's DEFAULT_*_PROMPT constants at all, and the existing config/manifest parity tests fail if one moves), command titles untouched, `explorePrompts.jiraTicket` untouched.

**Three landmines found while writing this plan that the spec does not yet mention** — the spec should be amended, and they are already binding here via the Global Constraints:
1. `Op` in `events.ts:60` includes the transmitted values `"jira_fetch" | "jira_write" | "jira_auth"`. Frozen (Task 8 Step 7).
2. `extension_activated` carries the transmitted property `has_jira_auth`. Frozen (Task 11 Step 3).
3. `settingsSnapshot.ts:31-37` documents an **existing manifest-parity test** that asserts each hand-written enum matches `package.json`. Task 6 Step 6 anticipates it failing and Task 6 Step 1 replaces it with a registry-derived assertion — closing both directions, which the spec's one-directional fix did not.

**Type consistency.** `serializeCaps` (Task 2) is used in Tasks 7, 8, 13. `TaskConnector.info(): SourceInfo` (Task 2) is consumed in Tasks 6, 8, 10, 11, 13 — note this replaced the spec's separate `label` / `scopeNoun` accessors with one method, so the spec's §1 snippet is now slightly behind the plan. `keyFromUrl` (Task 2) is implemented in Tasks 6 and 7, consumed in Task 9. `TaskWriteError.retryWith` (Task 2) is thrown in Task 5, handled in Task 8.
