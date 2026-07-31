# Usage Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship anonymous, shape-only usage analytics for the Agent Flow VS Code extension to PostHog, so feature adoption, funnel drop-off, activation/retention and real-world failures become measurable.

**Architecture:** A self-contained `src/telemetry/` module. A discriminated-union event catalog (`events.ts`) is the privacy guarantee — there is no generic `capture(name, props)`, so adding a user string to an event is a compile error. A module-level facade (`telemetry.ts`) wraps `vscode.env.createTelemetryLogger()`, which enforces the host's telemetry level for us, over a hand-rolled `TelemetrySender` (`posthog.ts`) that batches to PostHog's `/batch/` endpoint. Identity is borrowed from `vscode.env.machineId`, never minted.

**Tech Stack:** TypeScript, VS Code Extension API (`^1.90.0`), esbuild bundling, vitest + `@testing-library`, Node `crypto` (`randomUUID`, `createHash`), global `fetch` (Node 18 target). **No new npm dependencies.**

**Spec:** [2026-07-31-usage-analytics-design.md](../specs/2026-07-31-usage-analytics-design.md). Read it before starting; this plan implements Phase 1 of it.

## Global Constraints

Every task's requirements implicitly include all of these.

- **No new npm dependencies.** Not `posthog-node`, not a uuid package, not a hashing package. Node's `crypto` and global `fetch` only.
- **No user strings in event properties, ever.** Every string-typed property is a literal union. The only exceptions, allow-listed by name in `events.ts` and in the guard test: `flow_id` (a random UUID), `task_fp` / `repo_fp` (16-char hex), and `unhandled_error`'s `error_class` + `stack_digest`. Nothing else may be typed as bare `string`.
- **No generic escape hatch.** Never add `track(name: string, props: Record<string, unknown>)` or widen a property to `string`. The guard test in Task 3 exists to fail if someone does.
- **Telemetry must never throw into a caller, never notify the user, and never block a flow.** Its only output channel is the existing "Agent Flow" `OutputChannel`.
- **Two consent gates, both must pass:** VS Code's `telemetry.telemetryLevel` (enforced inside `TelemetryLogger`) and `agentFlow.telemetry.enabled` (default `true`).
- **Coverage thresholds must stay green:** `statements: 90, branches: 85, functions: 85, lines: 90` (see [vitest.config.ts](../../../vitest.config.ts)). Run `npx vitest run --coverage` before the final commit.
- **PostHog ingestion endpoint:** `https://us.i.posthog.com/batch/`. Body: `{ api_key, batch: [{ event, properties: { distinct_id, ... }, timestamp }] }`.
- **The PostHog project API key is a public write-only ingestion key.** It lives as a plain constant in `src/telemetry/posthog.ts`. It is world-readable in this OSS repo and must never be reused as a secret anywhere.
- **Follow existing repo conventions:** tests live in `test/unit/`, `vscode` is aliased to `test/_mocks/vscode.ts`, `globalThis.fetch` is scripted per-test (`test/_setup.ts` restores it), commit messages use Conventional Commits (`feat:`, `test:`, `docs:`, `chore:`).
- **Do not bump the version or build a `.vsix`.** Release happens on merge to main, outside this plan.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/telemetry/events.ts` | The catalog. Every event name + its exact property types. Literal unions only. No logic. |
| `src/telemetry/identity.ts` | `distinct_id` / `session_id` from `vscode.env`; the per-install salt; `fingerprint()`. |
| `src/telemetry/posthog.ts` | The `TelemetrySender`: queue, batch, retry, `POST /batch/`. Injected `fetch` + clock. |
| `src/telemetry/telemetry.ts` | The singleton facade: `initTelemetry`, `track`, `trackError`, `startFlow`, `disposeTelemetry`, `resetTelemetryForTests`. Owns the `agentFlow.telemetry.enabled` gate. |
| `src/telemetry/notice.ts` | The one-time first-run disclosure notification. |
| `src/telemetry/settingsSnapshot.ts` | Reduces `AgentFlowConfig` to the ~27 safe properties on `extension_activated`. Separate from `events.ts` because it is the one place that *reads* config, and it is where a future leak would happen. |
| `docs/TELEMETRY.md` | The public, complete disclosure. Linked from the first-run notice and the README. |
| `test/unit/telemetry/identity.test.ts` | |
| `test/unit/telemetry/events.test.ts` | The privacy guard — runtime walk + `@ts-expect-error`. |
| `test/unit/telemetry/posthog.test.ts` | |
| `test/unit/telemetry/telemetry.test.ts` | |
| `test/unit/telemetry/notice.test.ts` | |
| `test/unit/telemetry/settingsSnapshot.test.ts` | |
| `test/unit/telemetry/docs.test.ts` | The disclosure-drift test. |

**Modified**

| File | Change |
|---|---|
| `package.json` | Add the `agentFlow.telemetry.enabled` setting. |
| `src/config.ts` | Read it into `AgentFlowConfig`. |
| `src/extension.ts` | `initTelemetry` in `activate`, `extension_installed` / `extension_activated`, the notice, `command_invoked` on all 8 commands, flush in `deactivate`. |
| `src/tasksView.ts` | The Take funnel; `operation_failed` in the existing `onMessage` catch. |
| `test/_mocks/vscode.ts` | Add `env.machineId`, `env.sessionId`, `env.isTelemetryEnabled`, `env.onDidChangeTelemetryEnabled`, `env.createTelemetryLogger`, `ExtensionMode`, and a `Memento` factory. |
| `test/unit/config.test.ts` | Assert the new setting's default. |
| `test/unit/extension.test.ts` | Assert lifecycle events + `command_invoked`. |
| `test/unit/tasksView.test.ts` | Assert the Take funnel events. |
| `README.md` | A "Telemetry" section; amend any claim that nothing is sent anywhere. |

**Dependency order:** Task 1 (mock + setting) → Task 2 (identity) → Task 3 (events) → Task 4 (posthog) → Task 5 (telemetry facade) → Task 6 (settings snapshot) → Task 7 (notice) → Task 8 (activate/deactivate) → Task 9 (command_invoked) → Task 10 (Take funnel) → Task 11 (operation_failed) → Task 12 (docs + drift test + README) → Task 13 (manual end-to-end).

---

### Task 1: Test-mock additions + the `agentFlow.telemetry.enabled` setting

Blast-radius-first: `test/_mocks/vscode.ts` is shared by every test file, so it lands before anything depends on it.

**Files:**
- Modify: `test/_mocks/vscode.ts`
- Modify: `package.json` (`contributes.configuration.properties`)
- Modify: `src/config.ts`
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `vscode.env.machineId: string`, `vscode.env.sessionId: string`, `vscode.env.isTelemetryEnabled: boolean`, `vscode.env.onDidChangeTelemetryEnabled(cb)`, `vscode.env.createTelemetryLogger(sender, opts?)`
  - `vscode.ExtensionMode = { Production: 1, Development: 2, Test: 3 }`
  - `makeMemento(): vscode.Memento & { _store: Record<string, unknown> }` exported from the mock
  - `AgentFlowConfig.telemetryEnabled: boolean`

- [ ] **Step 1: Write the failing test for the config default**

Add to `test/unit/config.test.ts`:

```ts
it("telemetryEnabled defaults to true", () => {
  expect(getConfig().telemetryEnabled).toBe(true);
});

it("telemetryEnabled reflects the setting when disabled", () => {
  setConfig({ "telemetry.enabled": false });
  expect(getConfig().telemetryEnabled).toBe(false);
});
```

Check how the existing tests in that file import `setConfig` and mirror it exactly (it comes from `../_mocks/vscode`). Note the config store is keyed by the sub-section string that `getConfig` passes to `.get()`, so confirm against a neighbouring assertion in the same file whether the key is `"telemetry.enabled"` or the full `"agentFlow.telemetry.enabled"`, and use whichever the file already uses.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run test/unit/config.test.ts -t telemetryEnabled
```

Expected: FAIL — `telemetryEnabled` is `undefined`, not `true`.

- [ ] **Step 3: Add the setting to `package.json`**

In `contributes.configuration.properties`, after `agentFlow.provenanceLabel`:

```json
"agentFlow.telemetry.enabled": {
  "type": "boolean",
  "default": true,
  "markdownDescription": "Send anonymous usage events (which features are used, where flows are abandoned, what fails) to help decide what to build next. Never includes repo names, ticket keys, file paths, prompt text or error messages — see [TELEMETRY.md](https://github.com/oznasi1/agent-flow/blob/main/docs/TELEMETRY.md). VS Code's own `#telemetry.telemetryLevel#` setting is honoured regardless of this one."
}
```

- [ ] **Step 4: Read it in `src/config.ts`**

Add to the `AgentFlowConfig` interface and to the object `getConfig()` returns, following the exact style of the neighbouring boolean settings (e.g. `trackOpenWindows`):

```ts
telemetryEnabled: cfg.get<boolean>("telemetry.enabled", true),
```

- [ ] **Step 5: Run the config test to green**

```bash
npx vitest run test/unit/config.test.ts
```

Expected: PASS.

- [ ] **Step 6: Extend the vscode mock**

In `test/_mocks/vscode.ts`, add to the `env` object:

```ts
export const env = {
  appName: "Cursor",
  uriScheme: "cursor",
  machineId: "test-machine-id",
  sessionId: "test-session-id",
  appHost: "desktop",
  remoteName: undefined as string | undefined,
  isTelemetryEnabled: true,
  onDidChangeTelemetryEnabled: vi.fn((cb: (e: boolean) => void) => {
    telemetryEnabledCbs.push(cb);
    return { dispose: vi.fn() };
  }),
  createTelemetryLogger: vi.fn((sender: any, opts?: any) => makeTelemetryLogger(sender, opts)),
  openExternal: vi.fn(async (_uri: unknown): Promise<boolean> => true),
  clipboard: { writeText: vi.fn(async (_t: string): Promise<void> => undefined) },
};
```

Above it, add the logger fake and the enablement-callback registry. The fake must reproduce the two behaviours the facade depends on — the level gate, and common-property mix-in — because tests assert through it:

```ts
let telemetryEnabledCbs: ((e: boolean) => void)[] = [];
/** Drive `env.onDidChangeTelemetryEnabled` from a test. */
export function fireTelemetryEnabled(on: boolean): void {
  env.isTelemetryEnabled = on;
  for (const cb of telemetryEnabledCbs) cb(on);
}

export const UIKind = { Desktop: 1, Web: 2 } as const;
export const ExtensionMode = { Production: 1, Development: 2, Test: 3 } as const;

/** Minimal stand-in for VS Code's TelemetryLogger: gates on `env.isTelemetryEnabled`,
 * mixes `additionalCommonProperties` into every payload, and forwards to the sender.
 * `logError(Error)` goes to `sendErrorData`; `logError(string, data)` to `sendEventData`. */
function makeTelemetryLogger(sender: any, opts?: any) {
  const common = opts?.additionalCommonProperties ?? {};
  return {
    get isUsageEnabled() { return env.isTelemetryEnabled; },
    get isErrorsEnabled() { return env.isTelemetryEnabled; },
    onDidChangeEnableStates: vi.fn(() => ({ dispose: vi.fn() })),
    logUsage: vi.fn((name: string, data?: Record<string, any>) => {
      if (!env.isTelemetryEnabled) return;
      sender.sendEventData(name, { ...common, ...data });
    }),
    logError: vi.fn((nameOrErr: string | Error, data?: Record<string, any>) => {
      if (!env.isTelemetryEnabled) return;
      if (typeof nameOrErr === "string") sender.sendEventData(nameOrErr, { ...common, ...data });
      else sender.sendErrorData(nameOrErr, { ...common, ...data });
    }),
    dispose: vi.fn(() => { void sender.flush?.(); }),
  };
}

/** An in-memory `vscode.Memento` for globalState in tests. */
export function makeMemento() {
  const store: Record<string, unknown> = {};
  return {
    _store: store,
    keys: () => Object.keys(store),
    get: vi.fn((k: string, def?: unknown) => (k in store ? store[k] : def)),
    update: vi.fn(async (k: string, v: unknown) => { store[k] = v; }),
  };
}
```

- [ ] **Step 7: Reset the new state in `resetVscodeMocks`**

Inside `resetVscodeMocks()`, alongside the existing `env` resets:

```ts
  env.machineId = "test-machine-id";
  env.sessionId = "test-session-id";
  env.appHost = "desktop";
  env.remoteName = undefined;
  env.isTelemetryEnabled = true;
  telemetryEnabledCbs = [];
  env.onDidChangeTelemetryEnabled.mockClear();
  env.createTelemetryLogger.mockClear().mockImplementation((sender: any, opts?: any) => makeTelemetryLogger(sender, opts));
```

- [ ] **Step 8: Run the whole suite — the mock change must break nothing**

```bash
npx vitest run
```

Expected: PASS, same test count as before plus the two new config tests.

- [ ] **Step 9: Commit**

```bash
git add package.json src/config.ts test/_mocks/vscode.ts test/unit/config.test.ts
git commit -m "feat(telemetry): add agentFlow.telemetry.enabled setting and mock the VS Code telemetry APIs"
```

---

### Task 2: `identity.ts` — borrowed ids, per-install salt, fingerprints

**Files:**
- Create: `src/telemetry/identity.ts`
- Test: `test/unit/telemetry/identity.test.ts`

**Interfaces:**
- Consumes: `makeMemento()` from Task 1's mock.
- Produces:
  ```ts
  export const SALT_KEY = "agentFlow.telemetry.salt";
  export interface Identity {
    distinctId: string;
    sessionId: string;
    fingerprint(value: string): string;   // 16-char lowercase hex
  }
  export function createIdentity(state: vscode.Memento): Identity;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/unit/telemetry/identity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as vscode from "../../_mocks/vscode";
import { createIdentity, SALT_KEY } from "../../../src/telemetry/identity";

describe("createIdentity", () => {
  it("borrows distinct_id and session_id from vscode.env", () => {
    const id = createIdentity(vscode.makeMemento() as never);
    expect(id.distinctId).toBe("test-machine-id");
    expect(id.sessionId).toBe("test-session-id");
  });

  it("generates a salt once and reuses it across calls", () => {
    const mem = vscode.makeMemento();
    createIdentity(mem as never);
    const salt = mem._store[SALT_KEY];
    expect(typeof salt).toBe("string");
    createIdentity(mem as never);
    expect(mem._store[SALT_KEY]).toBe(salt);
  });

  it("fingerprints to 16 lowercase hex chars, stably", () => {
    const id = createIdentity(vscode.makeMemento() as never);
    const a = id.fingerprint("ABC-123");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(id.fingerprint("ABC-123")).toBe(a);
  });

  it("gives different fingerprints for the same value under different salts", () => {
    const a = createIdentity(vscode.makeMemento() as never).fingerprint("ABC-123");
    const b = createIdentity(vscode.makeMemento() as never).fingerprint("ABC-123");
    expect(a).not.toBe(b);
  });

  it("never returns the salt itself", () => {
    const mem = vscode.makeMemento();
    const id = createIdentity(mem as never);
    const salt = String(mem._store[SALT_KEY]);
    expect(id.fingerprint("ABC-123")).not.toContain(salt.slice(0, 8));
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run test/unit/telemetry/identity.test.ts
```

Expected: FAIL — cannot resolve `src/telemetry/identity`.

- [ ] **Step 3: Implement it**

Create `src/telemetry/identity.ts`:

```ts
import * as vscode from "vscode";
import { createHash, randomUUID } from "crypto";

/** globalState key holding this install's hashing salt. Never transmitted. */
export const SALT_KEY = "agentFlow.telemetry.salt";

export interface Identity {
  /** VS Code's own anonymous, stable machine id. We never mint an identifier. */
  distinctId: string;
  sessionId: string;
  /** Salted SHA-256, truncated to 16 hex chars. Stable within this install and
   * meaningless outside it — the salt is per-install and never leaves the machine,
   * so cross-user aggregation of hashed values is impossible by construction. */
  fingerprint(value: string): string;
}

export function createIdentity(state: vscode.Memento): Identity {
  let salt = state.get<string>(SALT_KEY);
  if (!salt) {
    salt = randomUUID();
    // Fire-and-forget: a failed write only costs us fingerprint stability, and
    // nothing here may throw into activate().
    void Promise.resolve(state.update(SALT_KEY, salt)).then(undefined, () => undefined);
  }
  const s = salt;
  return {
    distinctId: vscode.env.machineId,
    sessionId: vscode.env.sessionId,
    fingerprint: (value: string) =>
      createHash("sha256").update(`${s}:${value}`).digest("hex").slice(0, 16),
  };
}
```

- [ ] **Step 4: Run to green**

```bash
npx vitest run test/unit/telemetry/identity.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/identity.ts test/unit/telemetry/identity.test.ts
git commit -m "feat(telemetry): borrowed identity and per-install salted fingerprints"
```

---

### Task 3: `events.ts` — the catalog and the privacy guard

The load-bearing task. Everything after it is wiring.

**Files:**
- Create: `src/telemetry/events.ts`
- Test: `test/unit/telemetry/events.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces the Phase 1 catalog. Later tasks construct these object literals verbatim:
  ```ts
  export type FailureClass = "auth" | "network" | "not_found" | "permission" | "conflict" | "timeout" | "parse" | "unknown";
  export type Op = "jira_fetch" | "jira_write" | "jira_auth" | "git_worktree" | "repo_inference" | "pr_lookup" | "review_fetch" | "workspace_write" | "agent_seed" | "marketplace_read";
  export type StockPromptMode = "plan" | "implementation" | "tdd" | "investigate" | "orchestrator" | "refine";
  export type PromptModeProp = StockPromptMode | "custom";
  export type TaskModeProp = "ask" | "stock" | "custom";
  export type DestinationProp = "new" | "current" | "existing" | "live-folder";
  export type WorkspaceModeProp = "multiroot" | "per-window";
  export type RepoSource = "preselected" | "destination" | "quickpick";
  export type CommandId = "refresh" | "setup" | "doctor" | "signIn" | "signOut" | "takeTask" | "openDeck" | "openMarketplace";
  export type Outcome = "launched" | "cancelled" | "failed";
  export interface SettingsSnapshot { /* Task 6 */ }
  export type UsageEvent = ...
  export type ErrorEvent = ...
  export type AnalyticsEvent = UsageEvent | ErrorEvent;
  export const OPEN_STRING_PROPS: readonly string[];
  export const STOCK_PROMPT_MODES: readonly StockPromptMode[];
  export function toPromptModeProp(id: string): PromptModeProp;
  ```

- [ ] **Step 1: Write the failing guard test**

Create `test/unit/telemetry/events.test.ts`. The runtime half walks representative literals and asserts no property carries anything but an enum member, a number, a boolean, or an allow-listed opaque value:

```ts
import { describe, expect, it } from "vitest";
import {
  AnalyticsEvent, OPEN_STRING_PROPS, STOCK_PROMPT_MODES, toPromptModeProp,
} from "../../../src/telemetry/events";

/** One representative literal per Phase 1 event. Every event name must appear here;
 * the count assertion below is what forces a new event to be added to this list. */
const SAMPLES: AnalyticsEvent[] = [
  { name: "extension_installed" },
  {
    name: "extension_activated", is_first_ever: true, has_jira_auth: false, is_configured: true,
    workspace_mode: "auto", open_in: "ask", explore_mode: "ask", worktree: "ask",
    remote_control: "off", default_filter: "mysprint", task_mode: "ask",
    seed_agent: true, filters_size: true, filters_status: true, filters_repo: true,
    filters_search: true, pr_review_auto_fix: true, pr_facts: true, review_requests: true,
    review_writes: false, stamp_label_on_write: true, track_open_windows: true,
    batch_confirm_threshold: 6, repo_blocklist_count: 0,
    prompt_modes_count: 6, prompt_modes_customized: false,
    explore_prompts_customized: false, pr_review_prompt_customized: false,
  },
  { name: "command_invoked", command: "openDeck" },
  { name: "take_started", flow_id: "f1", source: "card", task_fp: "0123456789abcdef", inferred_count: 2 },
  { name: "take_prompt_mode_picked", flow_id: "f1", prompt_mode: "tdd", is_custom_mode: false },
  { name: "take_destination_picked", flow_id: "f1", destination: "new", workspace_mode: "multiroot", used_worktree: false },
  { name: "take_repos_picked", flow_id: "f1", repo_count: 3, repo_source: "quickpick", accepted_inference: true, inferred_count: 2 },
  { name: "take_completed", flow_id: "f1", outcome: "launched", destination: "new", prompt_mode: "tdd", repo_count: 3, duration_ms: 4200, task_fp: "0123456789abcdef" },
  { name: "operation_failed", op: "git_worktree", failure_class: "conflict", retryable: false },
  { name: "unhandled_error", error_class: "TypeError", stack_digest: "at f (dist/extension.js:1:2)" },
];

describe("the event catalog", () => {
  it("covers every Phase 1 event exactly once", () => {
    const names = SAMPLES.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(10);
  });

  it("carries no free-form strings outside the allow-list", () => {
    const ENUMISH = /^[a-z0-9][a-z0-9._-]*$/; // enum members are lowercase, hyphen/underscore only
    for (const ev of SAMPLES) {
      for (const [key, value] of Object.entries(ev)) {
        if (typeof value !== "string") continue;
        if (key === "name") continue;
        if (OPEN_STRING_PROPS.includes(key)) continue;
        if (/_fp$/.test(key)) {
          expect(value, `${ev.name}.${key}`).toMatch(/^[0-9a-f]{16}$/);
          continue;
        }
        expect(value, `${ev.name}.${key} must be an enum member, not free text`).toMatch(ENUMISH);
        expect(value, `${ev.name}.${key} looks like a path`).not.toMatch(/[/\\]/);
      }
    }
  });

  it("allow-lists only the four opaque string properties", () => {
    expect([...OPEN_STRING_PROPS].sort()).toEqual(["error_class", "flow_id", "stack_digest"].sort());
  });
});

describe("toPromptModeProp", () => {
  it("passes the six shipped ids through", () => {
    for (const id of STOCK_PROMPT_MODES) expect(toPromptModeProp(id)).toBe(id);
  });

  it("collapses a user-authored id to 'custom'", () => {
    expect(toPromptModeProp("acme-billing-hotfix")).toBe("custom");
  });
});

describe("compile-time guard", () => {
  it("rejects a user string added to an event", () => {
    // @ts-expect-error `repo` is not a property of take_completed, and no event accepts a repo name.
    const bad: AnalyticsEvent = { name: "take_completed", flow_id: "f1", outcome: "launched", prompt_mode: "tdd", repo_count: 1, duration_ms: 1, task_fp: "0123456789abcdef", repo: "acme-billing" };
    expect(bad).toBeTruthy();
  });
});
```

> The `@ts-expect-error` only bites under `tsc`, not vitest's transpile-only esbuild. Step 5 runs the type-check, which is where that assertion actually earns its keep.

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run test/unit/telemetry/events.test.ts
```

Expected: FAIL — cannot resolve `src/telemetry/events`.

- [ ] **Step 3: Write the catalog**

Create `src/telemetry/events.ts`:

```ts
/** The event catalog. This file IS the privacy guarantee.
 *
 * Every string-typed property is a literal union, so a repo name, ticket key, file
 * path or prompt cannot be attached to an event without a compile error. There is
 * deliberately no `track(name: string, props: Record<string, unknown>)` anywhere in
 * this module — an escape hatch would quietly undo the whole design.
 *
 * The only opaque string properties are listed in OPEN_STRING_PROPS, and
 * test/unit/telemetry/events.test.ts fails if that list grows. */

export type FailureClass =
  | "auth" | "network" | "not_found" | "permission"
  | "conflict" | "timeout" | "parse" | "unknown";

export type Op =
  | "jira_fetch" | "jira_write" | "jira_auth" | "git_worktree" | "repo_inference"
  | "pr_lookup" | "review_fetch" | "workspace_write" | "agent_seed" | "marketplace_read";

/** The six modes shipped in DEFAULT_PROMPT_MODES. `agentFlow.promptModes` is
 * user-configurable, so a custom mode's id is a user-authored string and must never
 * be sent — toPromptModeProp() collapses anything unrecognised to "custom". */
export const STOCK_PROMPT_MODES = ["plan", "implementation", "tdd", "investigate", "orchestrator", "refine"] as const;
export type StockPromptMode = (typeof STOCK_PROMPT_MODES)[number];
export type PromptModeProp = StockPromptMode | "custom";

export function toPromptModeProp(id: string): PromptModeProp {
  return (STOCK_PROMPT_MODES as readonly string[]).includes(id) ? (id as StockPromptMode) : "custom";
}

/** `agentFlow.taskMode` holds "ask" or a prompt-mode id, so its raw value is
 * user-authored too. */
export type TaskModeProp = "ask" | "stock" | "custom";

/** Mirrors OpenTarget.kind in tasksView, not the `openIn` setting values: the
 * worktree decision is a separate branch downstream and gets its own boolean. */
export type DestinationProp = "new" | "current" | "existing" | "live-folder";
export type WorkspaceModeProp = "multiroot" | "per-window";
export type RepoSource = "preselected" | "destination" | "quickpick";
export type Outcome = "launched" | "cancelled" | "failed";
export type CommandId =
  | "refresh" | "setup" | "doctor" | "signIn" | "signOut"
  | "takeTask" | "openDeck" | "openMarketplace";

/** Property names permitted to hold a value that is not an enum member.
 * `flow_id` is a random UUID; `error_class` is an Error's constructor name;
 * `stack_digest` is our own bundled stack with paths stripped (see stackDigest()).
 * `*_fp` properties are matched by suffix and must be 16-char hex. */
export const OPEN_STRING_PROPS = ["flow_id", "error_class", "stack_digest"] as const;

/** The ~27 safe reductions of AgentFlowConfig, built by settingsSnapshot.ts. */
export interface SettingsSnapshot {
  workspace_mode: "auto" | "multiroot" | "per-window" | "ask";
  open_in: "ask" | "new-window" | "this-window" | "pick-existing";
  explore_mode: "ask" | "jiraTicket" | "knowledge" | "debug" | "general";
  worktree: "ask" | "always" | "never";
  remote_control: "off" | "on" | "ask";
  default_filter: "unassigned" | "mysprint" | "mine" | "sprint" | "backlog";
  task_mode: TaskModeProp;
  seed_agent: boolean;
  filters_size: boolean;
  filters_status: boolean;
  filters_repo: boolean;
  filters_search: boolean;
  pr_review_auto_fix: boolean;
  pr_facts: boolean;
  review_requests: boolean;
  review_writes: boolean;
  stamp_label_on_write: boolean;
  track_open_windows: boolean;
  batch_confirm_threshold: number;
  repo_blocklist_count: number;
  prompt_modes_count: number;
  prompt_modes_customized: boolean;
  explore_prompts_customized: boolean;
  pr_review_prompt_customized: boolean;
}

/** Sent via logUsage — suppressed entirely at telemetry level "error". */
export type UsageEvent =
  | { name: "extension_installed" }
  | ({ name: "extension_activated"; is_first_ever: boolean; has_jira_auth: boolean; is_configured: boolean } & SettingsSnapshot)
  | { name: "command_invoked"; command: CommandId }
  | { name: "take_started"; flow_id: string; source: "card" | "command" | "batch"; task_fp: string; inferred_count: number }
  | { name: "take_prompt_mode_picked"; flow_id: string; prompt_mode: PromptModeProp; is_custom_mode: boolean }
  | { name: "take_destination_picked"; flow_id: string; destination: DestinationProp; workspace_mode: WorkspaceModeProp; used_worktree: boolean }
  | { name: "take_repos_picked"; flow_id: string; repo_count: number; repo_source: RepoSource; accepted_inference: boolean; inferred_count: number }
  | { name: "take_completed"; flow_id: string; outcome: Outcome; destination?: DestinationProp; prompt_mode: PromptModeProp; repo_count: number; duration_ms: number; failure_class?: FailureClass; task_fp: string };

/** Sent via logError — still delivered at telemetry level "error". */
export type ErrorEvent =
  | { name: "operation_failed"; op: Op; failure_class: FailureClass; retryable: boolean }
  | { name: "unhandled_error"; error_class: string; stack_digest: string };

export type AnalyticsEvent = UsageEvent | ErrorEvent;
export type EventName = AnalyticsEvent["name"];
```

- [ ] **Step 4: Run to green**

```bash
npx vitest run test/unit/telemetry/events.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Type-check — this is where `@ts-expect-error` matters**

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: no errors. If `tsc` reports *"Unused '@ts-expect-error' directive"*, the compile-time guard is not actually guarding — a property was widened to accept anything. Fix the catalog, not the test.

- [ ] **Step 6: Commit**

```bash
git add src/telemetry/events.ts test/unit/telemetry/events.test.ts
git commit -m "feat(telemetry): typed event catalog with a compile-time privacy guard"
```

---

### Task 4: `posthog.ts` — the batching sender

**Files:**
- Create: `src/telemetry/posthog.ts`
- Test: `test/unit/telemetry/posthog.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export const POSTHOG_HOST = "https://us.i.posthog.com";
  export const POSTHOG_API_KEY = "phc_REPLACE_ME";
  export const BATCH_SIZE = 20;
  export const FLUSH_INTERVAL_MS = 10_000;
  export const QUEUE_CAP = 100;
  export const REQUEST_TIMEOUT_MS = 5_000;
  export const RETRY_DELAY_MS = 2_000;
  export interface PostHogSenderDeps {
    apiKey?: string; host?: string; distinctId: string;
    log: (m: string) => void;
    fetchImpl?: typeof fetch;
    now?: () => number;
  }
  export interface PostHogSender extends vscode.TelemetrySender {
    sendEventData(eventName: string, data?: Record<string, unknown>): void;
    sendErrorData(error: Error, data?: Record<string, unknown>): void;
    flush(): Promise<void>;
    /** Discard everything queued without sending — used when consent is withdrawn. */
    drop(): void;
    dispose(): void;
  }
  export function createPostHogSender(deps: PostHogSenderDeps): PostHogSender;
  export function stackDigest(stack: string | undefined): string;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/unit/telemetry/posthog.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BATCH_SIZE, createPostHogSender, QUEUE_CAP, stackDigest } from "../../../src/telemetry/posthog";

function makeDeps(over: Partial<Parameters<typeof createPostHogSender>[0]> = {}) {
  const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
  return {
    deps: { apiKey: "phc_test", host: "https://ph.test", distinctId: "m1", log: vi.fn(), fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_700_000_000_000, ...over },
    fetchImpl,
  };
}

async function fill(sender: ReturnType<typeof createPostHogSender>, n: number) {
  for (let i = 0; i < n; i++) sender.sendEventData("e", { i });
  await Promise.resolve();
}

describe("createPostHogSender", () => {
  beforeEach(() => vi.useRealTimers());

  it("does not send before the batch fills", async () => {
    const { deps, fetchImpl } = makeDeps();
    await fill(createPostHogSender(deps), BATCH_SIZE - 1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs the PostHog /batch/ contract once the batch fills", async () => {
    const { deps, fetchImpl } = makeDeps();
    const sender = createPostHogSender(deps);
    await fill(sender, BATCH_SIZE);
    await sender.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ph.test/batch/");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.api_key).toBe("phc_test");
    expect(body.batch).toHaveLength(BATCH_SIZE);
    expect(body.batch[0].event).toBe("e");
    expect(body.batch[0].properties.distinct_id).toBe("m1");
    expect(body.batch[0].timestamp).toBe("2023-11-14T22:13:20.000Z");
  });

  it("no-ops when the api key is still the placeholder", async () => {
    const { deps, fetchImpl } = makeDeps({ apiKey: "phc_REPLACE_ME" });
    const sender = createPostHogSender(deps);
    await fill(sender, BATCH_SIZE);
    await sender.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries once on a 500, then gives up", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const { deps } = makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const sender = createPostHogSender({ ...deps, retryDelayMs: 0 } as never);
    sender.sendEventData("e");
    await sender.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401 — a bad key must not hammer", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const { deps } = makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const sender = createPostHogSender({ ...deps, retryDelayMs: 0 } as never);
    sender.sendEventData("e");
    await sender.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("caps the queue and drops the oldest", async () => {
    const { deps, fetchImpl } = makeDeps();
    const sender = createPostHogSender(deps);
    for (let i = 0; i < QUEUE_CAP + 10; i++) sender.sendEventData("e", { i });
    await sender.flush();
    const sent = fetchImpl.mock.calls.flatMap(([, init]) => JSON.parse(String((init as RequestInit).body)).batch);
    expect(sent.length).toBeLessThanOrEqual(QUEUE_CAP);
    expect(sent.some((e: any) => e.properties.i === 0)).toBe(false);
    expect(sent.some((e: any) => e.properties.i === QUEUE_CAP + 9)).toBe(true);
  });

  it("drop() discards without sending", async () => {
    const { deps, fetchImpl } = makeDeps();
    const sender = createPostHogSender(deps);
    sender.sendEventData("e");
    sender.drop();
    await sender.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("swallows a rejected fetch and logs it", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const log = vi.fn();
    const { deps } = makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch, log });
    const sender = createPostHogSender({ ...deps, retryDelayMs: 0 } as never);
    sender.sendEventData("e");
    await expect(sender.flush()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it("passes an abort signal so a hung request cannot leak", async () => {
    const { deps, fetchImpl } = makeDeps();
    const sender = createPostHogSender(deps);
    sender.sendEventData("e");
    await sender.flush();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeDefined();
  });

  it("sends errors through sendErrorData as unhandled_error", async () => {
    const { deps, fetchImpl } = makeDeps();
    const sender = createPostHogSender(deps);
    const err = new TypeError("nope");
    err.stack = "TypeError: nope\n    at f (/Users/someone/dev/agent-flow/dist/extension.js:9:1)";
    sender.sendErrorData(err, {});
    await sender.flush();
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(body.batch[0].event).toBe("unhandled_error");
    expect(body.batch[0].properties.error_class).toBe("TypeError");
    expect(body.batch[0].properties.stack_digest).toContain("dist/extension.js:9:1");
    expect(body.batch[0].properties.stack_digest).not.toContain("/Users/someone");
    expect(JSON.stringify(body)).not.toContain("nope");
  });
});

describe("stackDigest", () => {
  it("keeps our bundled frames and strips absolute paths", () => {
    const digest = stackDigest("Error: x\n    at a (/Users/oz/dev/agent-flow/dist/extension.js:1:2)\n    at b (node:internal/foo:3:4)");
    expect(digest).toContain("dist/extension.js:1:2");
    expect(digest).not.toContain("/Users/oz");
  });

  it("returns an empty string for a missing stack", () => {
    expect(stackDigest(undefined)).toBe("");
  });

  it("truncates to 20 frames", () => {
    const stack = "Error: x\n" + Array.from({ length: 40 }, (_, i) => `    at f${i} (dist/extension.js:${i}:1)`).join("\n");
    expect(stackDigest(stack).split("\n")).toHaveLength(20);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run test/unit/telemetry/posthog.test.ts
```

Expected: FAIL — cannot resolve `src/telemetry/posthog`.

- [ ] **Step 3: Implement the sender**

Create `src/telemetry/posthog.ts`. Note `retryDelayMs` in `deps` (the tests set it to 0 to keep themselves fast) and that `flush()` must drain repeatedly so a queue larger than one batch fully empties:

```ts
import * as vscode from "vscode";

export const POSTHOG_HOST = "https://us.i.posthog.com";
/** Public, write-only PostHog project ingestion key. NOT a secret — it is
 * world-readable in this OSS repo and in every published bundle. Replace the
 * placeholder with the real key; the sender no-ops while it is unset. */
export const POSTHOG_API_KEY = "phc_REPLACE_ME";
export const PLACEHOLDER_KEY = "phc_REPLACE_ME";

export const BATCH_SIZE = 20;
export const FLUSH_INTERVAL_MS = 10_000;
export const QUEUE_CAP = 100;
export const REQUEST_TIMEOUT_MS = 5_000;
export const RETRY_DELAY_MS = 2_000;
const MAX_STACK_FRAMES = 20;
const MAX_STACK_BYTES = 2_048;

export interface PostHogSenderDeps {
  apiKey?: string;
  host?: string;
  distinctId: string;
  log: (m: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  retryDelayMs?: number;
}

export interface PostHogSender extends vscode.TelemetrySender {
  flush(): Promise<void>;
  drop(): void;
  dispose(): void;
}

interface QueuedEvent {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

/** An Error stack reduced to our own bundled frames, absolute paths stripped.
 * We ship one bundled file, so these frames are our code and contain nothing about
 * the user — unlike error.message, which routinely embeds paths and ticket keys and
 * is never sent. */
export function stackDigest(stack: string | undefined): string {
  if (!stack) return "";
  const frames = stack
    .split("\n")
    .filter((l) => l.includes("dist/extension.js"))
    .map((l) => l.replace(/\(?(?:[A-Za-z]:)?[/\\][^\s()]*?(dist[/\\]extension\.js)/g, "($1").trim())
    .slice(0, MAX_STACK_FRAMES);
  return frames.join("\n").slice(0, MAX_STACK_BYTES);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createPostHogSender(deps: PostHogSenderDeps): PostHogSender {
  const apiKey = deps.apiKey ?? POSTHOG_API_KEY;
  const host = deps.host ?? POSTHOG_HOST;
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? (() => Date.now());
  const retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;
  const enabled = apiKey !== PLACEHOLDER_KEY && !!apiKey;

  let queue: QueuedEvent[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  function ensureTimer(): void {
    if (timer || !enabled) return;
    timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
    // Never hold the extension host's event loop open for analytics.
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  function enqueue(event: string, properties: Record<string, unknown>): void {
    if (!enabled) return;
    queue.push({ event, properties: { ...properties, distinct_id: deps.distinctId }, timestamp: new Date(now()).toISOString() });
    if (queue.length > QUEUE_CAP) {
      const dropped = queue.length - QUEUE_CAP;
      queue = queue.slice(dropped);
      deps.log(`telemetry: queue full, dropped ${dropped} oldest event(s)`);
    }
    ensureTimer();
    if (queue.length >= BATCH_SIZE) void flush();
  }

  async function post(batch: QueuedEvent[]): Promise<void> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await doFetch(`${host}/batch/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, batch }),
        signal: controller.signal,
      });
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) {
        // 4xx is permanent — a bad key must never retry forever.
        deps.log(`telemetry: dropped ${batch.length} event(s), HTTP ${res.status}`);
        return;
      }
    } finally {
      clearTimeout(t);
    }
  }

  async function drain(): Promise<void> {
    while (queue.length) {
      const batch = queue.splice(0, BATCH_SIZE);
      try {
        await post(batch);
      } catch (e) {
        try {
          if (retryDelayMs > 0) await sleep(retryDelayMs);
          await post(batch);
        } catch (e2) {
          deps.log(`telemetry: dropped ${batch.length} event(s): ${e2 instanceof Error ? e2.message : String(e2)}`);
        }
      }
    }
  }

  function flush(): Promise<void> {
    // Serialise flushes so a batch-size trigger and the interval cannot interleave.
    inFlight = inFlight.then(drain, drain);
    return inFlight;
  }

  return {
    sendEventData(eventName: string, data?: Record<string, unknown>): void {
      enqueue(eventName, data ?? {});
    },
    sendErrorData(error: Error, data?: Record<string, unknown>): void {
      // Deliberately no error.message: messages embed paths and ticket keys.
      enqueue("unhandled_error", { ...data, error_class: error.name, stack_digest: stackDigest(error.stack) });
    },
    flush,
    drop(): void {
      if (queue.length) deps.log(`telemetry: consent withdrawn, discarded ${queue.length} queued event(s)`);
      queue = [];
    },
    dispose(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
```

> `sendErrorData` strips `error.message` here rather than in the facade because VS Code calls it directly for unhandled extension-host errors — the facade is not in that path.

- [ ] **Step 4: Run to green**

```bash
npx vitest run test/unit/telemetry/posthog.test.ts
```

Expected: PASS, 13 tests. If the `stackDigest` path-stripping assertion fails, fix the regex — do not relax the assertion.

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/posthog.ts test/unit/telemetry/posthog.test.ts
git commit -m "feat(telemetry): batching PostHog sender with retry, queue cap and stack scrubbing"
```

---

### Task 5: `telemetry.ts` — the facade and the second consent gate

**Files:**
- Create: `src/telemetry/telemetry.ts`
- Test: `test/unit/telemetry/telemetry.test.ts`

**Interfaces:**
- Consumes: `AnalyticsEvent`, `UsageEvent`, `ErrorEvent` (Task 3); `createIdentity` (Task 2); `createPostHogSender` (Task 4).
- Produces — every later task calls exactly these:
  ```ts
  export interface Flow { id: string; elapsedMs(): number }
  export function startFlow(): Flow;
  export function initTelemetry(context: vscode.ExtensionContext, log: (m: string) => void): void;
  export function track(event: UsageEvent): void;
  export function trackError(event: ErrorEvent): void;
  export function fingerprint(value: string): string;   // "" when uninitialised
  export function disposeTelemetry(): void;
  export function resetTelemetryForTests(): void;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/unit/telemetry/telemetry.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "../../_mocks/vscode";
import {
  disposeTelemetry, fingerprint, initTelemetry, resetTelemetryForTests, startFlow, track, trackError,
} from "../../../src/telemetry/telemetry";

function makeContext() {
  return {
    globalState: vscode.makeMemento(),
    extensionMode: vscode.ExtensionMode.Development,
    subscriptions: [] as { dispose(): void }[],
  } as never;
}

/** The sender the facade built, reached through the mocked createTelemetryLogger. */
function sentEvents(): { name: string; data: Record<string, unknown> }[] {
  const logger = vscode.env.createTelemetryLogger.mock.results[0]?.value;
  const calls = [...(logger?.logUsage.mock.calls ?? []), ...(logger?.logError.mock.calls ?? [])];
  return calls.map(([name, data]: [string, Record<string, unknown>]) => ({ name, data }));
}

beforeEach(() => resetTelemetryForTests());
afterEach(() => { disposeTelemetry(); resetTelemetryForTests(); });

describe("track", () => {
  it("no-ops before init rather than throwing", () => {
    expect(() => track({ name: "extension_installed" })).not.toThrow();
  });

  it("sends through the logger once initialised", () => {
    initTelemetry(makeContext(), vi.fn());
    track({ name: "command_invoked", command: "openDeck" });
    expect(sentEvents().map((e) => e.name)).toContain("command_invoked");
  });

  it("sends nothing when agentFlow.telemetry.enabled is false", () => {
    vscode.setConfig({ "telemetry.enabled": false });
    initTelemetry(makeContext(), vi.fn());
    track({ name: "command_invoked", command: "openDeck" });
    expect(sentEvents()).toHaveLength(0);
  });

  it("sends nothing when the host's telemetry is off", () => {
    vscode.env.isTelemetryEnabled = false;
    initTelemetry(makeContext(), vi.fn());
    track({ name: "command_invoked", command: "openDeck" });
    expect(sentEvents()).toHaveLength(0);
  });

  it("attaches the common properties", () => {
    initTelemetry(makeContext(), vi.fn());
    track({ name: "extension_installed" });
    const data = sentEvents()[0].data;
    expect(data.env_type).toBe("development");
    expect(data.app_name).toBe("Cursor");
    expect(data.session_id).toBe("test-session-id");
  });

  it("never lets a throwing logger reach the caller", () => {
    initTelemetry(makeContext(), vi.fn());
    const logger = vscode.env.createTelemetryLogger.mock.results[0].value;
    logger.logUsage.mockImplementationOnce(() => { throw new Error("boom"); });
    expect(() => track({ name: "extension_installed" })).not.toThrow();
  });

  it("routes error events through logError", () => {
    initTelemetry(makeContext(), vi.fn());
    trackError({ name: "operation_failed", op: "jira_fetch", failure_class: "network", retryable: true });
    const logger = vscode.env.createTelemetryLogger.mock.results[0].value;
    expect(logger.logError).toHaveBeenCalled();
    expect(logger.logUsage).not.toHaveBeenCalled();
  });
});

describe("consent withdrawn mid-session", () => {
  it("drops the queue instead of flushing it", () => {
    const log = vi.fn();
    initTelemetry(makeContext(), log);
    track({ name: "extension_installed" });
    vscode.fireTelemetryEnabled(false);
    expect(log.mock.calls.flat().join(" ")).toMatch(/discarded|consent withdrawn/i);
  });
});

describe("startFlow", () => {
  it("mints a distinct id per flow and measures elapsed time", () => {
    const a = startFlow();
    const b = startFlow();
    expect(a.id).not.toBe(b.id);
    expect(a.elapsedMs()).toBeGreaterThanOrEqual(0);
  });
});

describe("fingerprint", () => {
  it("returns 16 hex chars after init and an empty string before it", () => {
    expect(fingerprint("ABC-1")).toBe("");
    initTelemetry(makeContext(), vi.fn());
    expect(fingerprint("ABC-1")).toMatch(/^[0-9a-f]{16}$/);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run test/unit/telemetry/telemetry.test.ts
```

Expected: FAIL — cannot resolve `src/telemetry/telemetry`.

- [ ] **Step 3: Implement the facade**

Create `src/telemetry/telemetry.ts`:

```ts
import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { getConfig } from "../config";
import { createIdentity, Identity } from "./identity";
import { createPostHogSender, PostHogSender } from "./posthog";
import { ErrorEvent, UsageEvent } from "./events";

/** Analytics is ambient infrastructure, like the output channel: a module-level
 * singleton rather than a parameter threaded through ~30 engine signatures.
 * Tests call resetTelemetryForTests() to isolate. */
interface State {
  logger: vscode.TelemetryLogger;
  sender: PostHogSender;
  identity: Identity;
  log: (m: string) => void;
  disposables: vscode.Disposable[];
}

let state: State | undefined;

export interface Flow {
  id: string;
  elapsedMs(): number;
}

/** A correlation id for one multi-step flow, plus its own stopwatch. The id is
 * random — derived from nothing about the user — and is what makes funnel analysis
 * work when two Takes overlap. */
export function startFlow(): Flow {
  const started = Date.now();
  return { id: randomUUID(), elapsedMs: () => Date.now() - started };
}

function settingEnabled(): boolean {
  try {
    return getConfig().telemetryEnabled;
  } catch {
    return false;
  }
}

export function initTelemetry(context: vscode.ExtensionContext, log: (m: string) => void): void {
  if (state) return;
  const identity = createIdentity(context.globalState);
  const sender = createPostHogSender({ distinctId: identity.distinctId, log });
  const logger = vscode.env.createTelemetryLogger(sender, {
    additionalCommonProperties: {
      session_id: identity.sessionId,
      env_type: context.extensionMode === vscode.ExtensionMode.Production ? "production" : "development",
      app_name: vscode.env.appName,
      app_host: vscode.env.appHost,
      remote_name: vscode.env.remoteName ?? "local",
      ui_kind: vscode.env.uiKind === vscode.UIKind.Web ? "web" : "desktop",
    },
  });

  const disposables: vscode.Disposable[] = [
    // Consent withdrawn mid-session must discard what is queued, not flush it.
    vscode.env.onDidChangeTelemetryEnabled((on) => { if (!on) sender.drop(); }),
    vscode.workspace.onDidChangeConfiguration?.((e) => {
      if (e.affectsConfiguration?.("agentFlow.telemetry.enabled") && !settingEnabled()) sender.drop();
    }) ?? { dispose: () => undefined },
  ];

  state = { logger, sender, identity, log, disposables };
}

export function track(event: UsageEvent): void {
  if (!state || !settingEnabled()) return;
  try {
    const { name, ...properties } = event;
    state.logger.logUsage(name, properties);
  } catch (e) {
    state.log(`telemetry: track failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function trackError(event: ErrorEvent): void {
  if (!state || !settingEnabled()) return;
  try {
    const { name, ...properties } = event;
    state.logger.logError(name, properties);
  } catch (e) {
    state.log(`telemetry: trackError failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Salted, per-install hash. Empty string when uninitialised, so callers can build
 * an event literal unconditionally. */
export function fingerprint(value: string): string {
  return state ? state.identity.fingerprint(value) : "";
}

export function disposeTelemetry(): void {
  if (!state) return;
  for (const d of state.disposables) d.dispose();
  // Best-effort: deactivate() is synchronous and will not await this.
  state.logger.dispose();
  state.sender.dispose();
  state = undefined;
}

export function resetTelemetryForTests(): void {
  state = undefined;
}
```

> `vscode.workspace.onDidChangeConfiguration` is optional-chained because the shared test mock does not define it. If a later task needs it non-optionally, add it to the mock rather than removing the guard.

- [ ] **Step 4: Add `onDidChangeConfiguration` to the mock**

The optional chain keeps the tests passing, but the real gate deserves a test. Add to the mock's `workspace` object and reset it in `resetVscodeMocks`:

```ts
  onDidChangeConfiguration: vi.fn((_cb: (e: any) => void) => ({ dispose: vi.fn() })),
```

- [ ] **Step 5: Run to green**

```bash
npx vitest run test/unit/telemetry/telemetry.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add src/telemetry/telemetry.ts test/_mocks/vscode.ts test/unit/telemetry/telemetry.test.ts
git commit -m "feat(telemetry): singleton facade with dual consent gates and flow correlation"
```

---

### Task 6: `settingsSnapshot.ts` — config reduced to safe properties

Isolated in its own file because it is the only code that *reads* user config into an event, and therefore the one place a future leak would happen.

**Files:**
- Create: `src/telemetry/settingsSnapshot.ts`
- Test: `test/unit/telemetry/settingsSnapshot.test.ts`

**Interfaces:**
- Consumes: `SettingsSnapshot`, `STOCK_PROMPT_MODES`, `TaskModeProp` (Task 3); `AgentFlowConfig`, `DEFAULT_PROMPT_MODES`, `DEFAULT_EXPLORE_PROMPT` (`src/config.ts`).
- Produces: `export function settingsSnapshot(cfg: AgentFlowConfig): SettingsSnapshot`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/telemetry/settingsSnapshot.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getConfig } from "../../../src/config";
import { settingsSnapshot } from "../../../src/telemetry/settingsSnapshot";

describe("settingsSnapshot", () => {
  it("reports the shipped defaults", () => {
    const s = settingsSnapshot(getConfig());
    expect(s.workspace_mode).toBe("auto");
    expect(s.task_mode).toBe("ask");
    expect(s.prompt_modes_count).toBe(6);
    expect(s.prompt_modes_customized).toBe(false);
    expect(s.review_writes).toBe(false);
    expect(s.repo_blocklist_count).toBe(0);
  });

  it("collapses a user-authored taskMode id to 'custom'", () => {
    const cfg = { ...getConfig(), taskMode: "acme-billing-hotfix" };
    expect(settingsSnapshot(cfg).task_mode).toBe("custom");
  });

  it("reports a shipped taskMode id as 'stock'", () => {
    const cfg = { ...getConfig(), taskMode: "tdd" };
    expect(settingsSnapshot(cfg).task_mode).toBe("stock");
  });

  it("flags customized prompt modes without revealing them", () => {
    const cfg = { ...getConfig(), promptModes: [{ id: "mine", label: "L", detail: "D", prompt: "P" }] };
    const s = settingsSnapshot(cfg);
    expect(s.prompt_modes_customized).toBe(true);
    expect(s.prompt_modes_count).toBe(1);
    expect(JSON.stringify(s)).not.toContain("mine");
  });

  it("emits no value derived from a user string", () => {
    const cfg = {
      ...getConfig(),
      baseUrl: "https://acme.atlassian.net", project: "BILL", githubOrg: "acme-inc",
      reposRoot: "/Users/someone/dev", workspaceDir: "/Users/someone/ws",
      provenanceLabel: "acme-label", repoBlocklist: ["secret-repo"],
    };
    const serialized = JSON.stringify(settingsSnapshot(cfg));
    for (const leak of ["acme", "BILL", "someone", "secret-repo", "atlassian"]) {
      expect(serialized).not.toContain(leak);
    }
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run test/unit/telemetry/settingsSnapshot.test.ts
```

Expected: FAIL — cannot resolve `src/telemetry/settingsSnapshot`.

- [ ] **Step 3: Implement it**

Create `src/telemetry/settingsSnapshot.ts`. Open `src/config.ts` first and use the real `AgentFlowConfig` field names — the ones below match the settings inventory but must be verified against the interface:

```ts
import { AgentFlowConfig, DEFAULT_EXPLORE_PROMPT, DEFAULT_PROMPT_MODES } from "../config";
import { SettingsSnapshot, STOCK_PROMPT_MODES, TaskModeProp } from "./events";

function taskModeProp(taskMode: string): TaskModeProp {
  if (taskMode === "ask") return "ask";
  return (STOCK_PROMPT_MODES as readonly string[]).includes(taskMode) ? "stock" : "custom";
}

/** Reduce config to shape only. Every setting whose value is user-authored —
 * baseUrl, project, githubOrg, reposRoot, workspaceDir, provenanceLabel and every
 * *Prompt — contributes at most a "was it changed from the default" boolean.
 * repoBlocklist contributes its length. A test asserts none of them leak. */
export function settingsSnapshot(cfg: AgentFlowConfig): SettingsSnapshot {
  const stockIds = DEFAULT_PROMPT_MODES.map((m) => m.id).join(",");
  return {
    workspace_mode: cfg.workspaceMode as SettingsSnapshot["workspace_mode"],
    open_in: cfg.openIn as SettingsSnapshot["open_in"],
    explore_mode: cfg.exploreMode as SettingsSnapshot["explore_mode"],
    worktree: cfg.worktree as SettingsSnapshot["worktree"],
    remote_control: cfg.remoteControl as SettingsSnapshot["remote_control"],
    default_filter: cfg.defaultFilter as SettingsSnapshot["default_filter"],
    task_mode: taskModeProp(cfg.taskMode),
    seed_agent: cfg.seedAgent,
    filters_size: cfg.filters.size,
    filters_status: cfg.filters.status,
    filters_repo: cfg.filters.repo,
    filters_search: cfg.filters.search,
    pr_review_auto_fix: cfg.prReviewAutoFix,
    pr_facts: cfg.prFacts,
    review_requests: cfg.reviewRequests,
    review_writes: cfg.reviewWrites,
    stamp_label_on_write: cfg.stampLabelOnWrite,
    track_open_windows: cfg.trackOpenWindows,
    batch_confirm_threshold: cfg.batchLaunchConfirmThreshold,
    repo_blocklist_count: cfg.repoBlocklist.length,
    prompt_modes_count: cfg.promptModes.length,
    prompt_modes_customized: cfg.promptModes.map((m) => m.id).join(",") !== stockIds,
    explore_prompts_customized: cfg.explorePrompt !== DEFAULT_EXPLORE_PROMPT,
    pr_review_prompt_customized: cfg.prReviewPrompt !== undefined && cfg.prReviewPrompt.length > 0
      && cfg.prReviewPrompt !== defaultPrReviewPrompt(),
  };
}
```

If `src/config.ts` has no exported default for `prReviewPrompt`, compare against the `package.json` manifest default instead by exporting a `DEFAULT_PR_REVIEW_PROMPT` constant from `config.ts` and using it here — do **not** inline the prompt text in two places. Add the same manifest-parity test the file's header comment describes for `DEFAULT_PROMPT_MODES` if one does not already cover it.

- [ ] **Step 4: Run to green**

```bash
npx vitest run test/unit/telemetry/settingsSnapshot.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/settingsSnapshot.ts src/config.ts test/unit/telemetry/settingsSnapshot.test.ts
git commit -m "feat(telemetry): reduce config to a shape-only settings snapshot"
```

---

### Task 7: `notice.ts` — the one-time first-run disclosure

**Files:**
- Create: `src/telemetry/notice.ts`
- Test: `test/unit/telemetry/notice.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export const NOTICE_KEY = "agentFlow.telemetry.noticeShown";
  export const TELEMETRY_DOCS_URL = "https://github.com/oznasi1/agent-flow/blob/main/docs/TELEMETRY.md";
  export async function maybeShowTelemetryNotice(context: vscode.ExtensionContext, opts: { setupRunning: boolean }): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/unit/telemetry/notice.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import * as vscode from "../../_mocks/vscode";
import { maybeShowTelemetryNotice, NOTICE_KEY } from "../../../src/telemetry/notice";

function ctx() {
  return { globalState: vscode.makeMemento() } as never;
}

describe("maybeShowTelemetryNotice", () => {
  it("shows once and records that it did", async () => {
    const c = ctx();
    await maybeShowTelemetryNotice(c, { setupRunning: false });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect((c as any).globalState._store[NOTICE_KEY]).toBe(true);
  });

  it("does not show a second time", async () => {
    const c = ctx();
    await maybeShowTelemetryNotice(c, { setupRunning: false });
    await maybeShowTelemetryNotice(c, { setupRunning: false });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it("stays quiet while setup is running, and does not mark itself shown", async () => {
    const c = ctx();
    await maybeShowTelemetryNotice(c, { setupRunning: true });
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect((c as any).globalState._store[NOTICE_KEY]).toBeUndefined();
  });

  it("opens the docs on 'What's collected'", async () => {
    vscode.window.showInformationMessage.mockResolvedValueOnce("What's collected");
    await maybeShowTelemetryNotice(ctx(), { setupRunning: false });
    expect(vscode.env.openExternal).toHaveBeenCalled();
  });

  it("writes the global setting on 'Turn off'", async () => {
    const update = vi.fn(async () => undefined);
    vscode.workspace.getConfiguration.mockReturnValue({ get: vi.fn(), update, inspect: vi.fn() } as never);
    vscode.window.showInformationMessage.mockResolvedValueOnce("Turn off");
    await maybeShowTelemetryNotice(ctx(), { setupRunning: false });
    expect(update).toHaveBeenCalledWith("telemetry.enabled", false, vscode.ConfigurationTarget.Global);
  });

  it("never throws when the notification API fails", async () => {
    vscode.window.showInformationMessage.mockRejectedValueOnce(new Error("boom"));
    await expect(maybeShowTelemetryNotice(ctx(), { setupRunning: false })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run test/unit/telemetry/notice.test.ts
```

Expected: FAIL — cannot resolve `src/telemetry/notice`.

- [ ] **Step 3: Implement it**

Create `src/telemetry/notice.ts`:

```ts
import * as vscode from "vscode";

export const NOTICE_KEY = "agentFlow.telemetry.noticeShown";
export const TELEMETRY_DOCS_URL = "https://github.com/oznasi1/agent-flow/blob/main/docs/TELEMETRY.md";

const DETAILS = "What's collected";
const TURN_OFF = "Turn off";

/** Disclose telemetry once, non-modally. Deferred while first-run setup is on
 * screen so it never competes with the wizard for attention — and not marked as
 * shown in that case, so it still appears on a later activation. Never throws. */
export async function maybeShowTelemetryNotice(
  context: vscode.ExtensionContext,
  opts: { setupRunning: boolean },
): Promise<void> {
  try {
    if (opts.setupRunning) return;
    if (context.globalState.get<boolean>(NOTICE_KEY)) return;
    await context.globalState.update(NOTICE_KEY, true);

    const choice = await vscode.window.showInformationMessage(
      "Agent Flow sends anonymous usage events to help decide what to build next. No repo names, ticket keys, file paths or prompt text.",
      DETAILS,
      TURN_OFF,
    );
    if (choice === DETAILS) {
      await vscode.env.openExternal(vscode.Uri.parse(TELEMETRY_DOCS_URL));
    } else if (choice === TURN_OFF) {
      await vscode.workspace
        .getConfiguration("agentFlow")
        .update("telemetry.enabled", false, vscode.ConfigurationTarget.Global);
    }
  } catch {
    // A disclosure that fails to render must never break activation.
  }
}
```

- [ ] **Step 4: Run to green**

```bash
npx vitest run test/unit/telemetry/notice.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/notice.ts test/unit/telemetry/notice.test.ts
git commit -m "feat(telemetry): one-time first-run disclosure notice"
```

---

### Task 8: Wire `activate()` / `deactivate()` — lifecycle events

**Files:**
- Modify: `src/extension.ts`
- Test: `test/unit/extension.test.ts`

**Interfaces:**
- Consumes: `initTelemetry`, `track`, `disposeTelemetry` (Task 5); `settingsSnapshot` (Task 6); `maybeShowTelemetryNotice` (Task 7).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/extension.test.ts`, mirroring how the existing tests there build the fake `ExtensionContext` (reuse that helper rather than writing a new one — it must gain `globalState: makeMemento()` and `extensionMode` if it lacks them):

```ts
it("reports extension_installed on the very first activation only", () => {
  const ctx = makeContext();
  activate(ctx);
  expect(trackSpy.mock.calls.flat().map((e: any) => e.name)).toContain("extension_installed");

  trackSpy.mockClear();
  activate(makeContext({ globalState: ctx.globalState }));
  expect(trackSpy.mock.calls.flat().map((e: any) => e.name)).not.toContain("extension_installed");
});

it("reports extension_activated with the settings snapshot", () => {
  activate(makeContext());
  const ev = trackSpy.mock.calls.flat().find((e: any) => e.name === "extension_activated") as any;
  expect(ev).toBeDefined();
  expect(ev.is_first_ever).toBe(true);
  expect(ev.workspace_mode).toBe("auto");
  expect(ev.prompt_modes_count).toBe(6);
});

it("still activates when telemetry init throws", () => {
  initSpy.mockImplementationOnce(() => { throw new Error("boom"); });
  expect(() => activate(makeContext())).not.toThrow();
  // The commands must still be registered — a telemetry failure cannot dispose them.
  expect(vscode.commands.registerCommand).toHaveBeenCalled();
});
```

Spy on the telemetry module with `vi.mock("../../src/telemetry/telemetry", ...)`, following whatever mocking style `test/unit/extension.test.ts` already uses for its other collaborators.

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run test/unit/extension.test.ts
```

Expected: FAIL — no `extension_installed` event.

- [ ] **Step 3: Wire `activate()`**

In `src/extension.ts`, add imports and initialise telemetry **before** the command registrations so `command_invoked` (Task 9) can use it — but keep the lifecycle events inside the existing `try` block that guards the optional niceties, since that comment at lines 60-64 is load-bearing: an uncaught throw there disposes every registration.

```ts
import { disposeTelemetry, initTelemetry, track } from "./telemetry/telemetry";
import { settingsSnapshot } from "./telemetry/settingsSnapshot";
import { maybeShowTelemetryNotice } from "./telemetry/notice";

const INSTALLED_KEY = "agentFlow.telemetry.installReported";
```

Immediately after `const provider = new TasksViewProvider(...)` and the `log("Agent Flow activated")` line:

```ts
  try {
    initTelemetry(context, log);
  } catch (e) {
    log(`telemetry: init failed (extension still active): ${e instanceof Error ? e.message : String(e)}`);
  }
```

Then inside the existing best-effort `try` block, alongside `maybeRunSetup`:

```ts
    // Lifecycle analytics. `isFirstEver` is the install signal: globalState is empty
    // on a fresh install and survives updates, so this fires exactly once per machine.
    const isFirstEver = !context.globalState.get<boolean>(INSTALLED_KEY);
    if (isFirstEver) {
      void context.globalState.update(INSTALLED_KEY, true);
      track({ name: "extension_installed" });
    }
    void auth.isAuthenticated().then(
      (authed) => {
        const cfg = getConfig();
        track({
          name: "extension_activated",
          is_first_ever: isFirstEver,
          has_jira_auth: authed,
          is_configured: !!cfg.baseUrl && !!cfg.project,
          ...settingsSnapshot(cfg),
        });
      },
      () => undefined,
    );
    void maybeShowTelemetryNotice(context, { setupRunning: isFirstEver });
```

> `setupRunning: isFirstEver` is the right coupling: `maybeRunSetup` only offers the wizard when the extension has never been configured, which is exactly the first-ever activation. The notice therefore lands on the second activation for a new user, and immediately for an existing one.

- [ ] **Step 4: Flush in `deactivate()`**

```ts
export function deactivate(): void {
  // Best-effort: drop this window's presence record (removePresence never throws).
  removePresence(defaultWindowsDir(), process.pid);
  // Best-effort flush. deactivate() is synchronous and will not await the POST, so
  // tail events at window close are sometimes lost — by design, which is why
  // retention rides on extension_activated rather than a session_ended event.
  disposeTelemetry();
}
```

- [ ] **Step 5: Run to green**

```bash
npx vitest run test/unit/extension.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts test/unit/extension.test.ts
git commit -m "feat(telemetry): lifecycle events, first-run notice and flush on deactivate"
```

---

### Task 9: `command_invoked` on all eight commands

**Files:**
- Modify: `src/extension.ts`
- Test: `test/unit/extension.test.ts`

**Interfaces:**
- Consumes: `track`, `CommandId`.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```ts
it("reports command_invoked for every registered command", async () => {
  activate(makeContext());
  const registered = vscode.commands.registerCommand.mock.calls.map(([id]) => id as string);
  expect(registered).toHaveLength(8);

  for (const [id, cb] of vscode.commands.registerCommand.mock.calls) {
    trackSpy.mockClear();
    await (cb as () => unknown)();
    const names = trackSpy.mock.calls.flat().map((e: any) => e.name);
    expect(names, `${id} should report command_invoked`).toContain("command_invoked");
  }
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run test/unit/extension.test.ts -t command_invoked
```

Expected: FAIL — no `command_invoked` events.

- [ ] **Step 3: Add a wrapper**

Rather than eight copy-pasted `track` calls, add one helper in `src/extension.ts` above `activate` and route every registration through it. This keeps the registration list readable and makes it impossible to add a command that forgets its event:

```ts
/** Register a command and report its use. The id suffix after "agentFlow." is the
 * CommandId enum member, so a new command is a compile error until it is added to
 * the catalog — which is the point. */
function registerTracked<T>(
  id: `agentFlow.${CommandId}`,
  handler: (...args: any[]) => T,
): vscode.Disposable {
  const command = id.slice("agentFlow.".length) as CommandId;
  return vscode.commands.registerCommand(id, (...args: any[]) => {
    track({ name: "command_invoked", command });
    return handler(...args);
  });
}
```

Then change each `vscode.commands.registerCommand("agentFlow.X", ...)` in the `context.subscriptions.push(...)` block to `registerTracked("agentFlow.X", ...)`. Import `CommandId` from `./telemetry/events`.

- [ ] **Step 4: Run to green**

```bash
npx vitest run test/unit/extension.test.ts
```

Expected: PASS. If a command id does not match a `CommandId` member, `tsc` will say so — add it to the catalog in `events.ts` and to `docs/TELEMETRY.md` (Task 12).

- [ ] **Step 5: Type-check and commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/extension.ts src/telemetry/events.ts test/unit/extension.test.ts
git commit -m "feat(telemetry): report command_invoked for every registered command"
```

---

### Task 10: The Take funnel

**Files:**
- Modify: `src/tasksView.ts` (`takeTask` ~line 913, `resolveKickoff` ~line 693, `choosePromptMode` ~line 896)
- Test: `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `track`, `startFlow`, `fingerprint`, `Flow`; `toPromptModeProp`, `DestinationProp`, `RepoSource`.
- Produces: `resolveKickoff` gains a third parameter, `flow?: Flow`. `addressPr` passes nothing, so its behaviour is unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/tasksView.test.ts`, reusing that file's existing harness for building a provider and firing webview messages:

```ts
it("reports the full Take funnel on a successful launch", async () => {
  // Arrange the happy path exactly as the existing "take" tests in this file do.
  const panel = await takeHappyPath();
  const names = trackSpy.mock.calls.flat().map((e: any) => e.name);
  expect(names).toEqual([
    "take_started",
    "take_prompt_mode_picked",
    "take_destination_picked",
    "take_repos_picked",
    "take_completed",
  ]);
  const started = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_started") as any;
  const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_completed") as any;
  expect(started.flow_id).toBe(done.flow_id);
  expect(started.task_fp).toMatch(/^[0-9a-f]{16}$/);
  expect(done.outcome).toBe("launched");
  expect(done.duration_ms).toBeGreaterThanOrEqual(0);
});

it("never sends a ticket key or repo name", async () => {
  await takeHappyPath();  // uses key "BILL-1234" and repo "acme-billing"
  const serialized = JSON.stringify(trackSpy.mock.calls.flat());
  expect(serialized).not.toContain("BILL-1234");
  expect(serialized).not.toContain("acme-billing");
});

it("reports cancelled when the prompt-mode picker is dismissed", async () => {
  vscode.window.showQuickPick.mockResolvedValueOnce(undefined);
  await provider.takeTask("BILL-1234");
  const names = trackSpy.mock.calls.flat().map((e: any) => e.name);
  expect(names).toEqual(["take_started", "take_completed"]);
  expect((trackSpy.mock.calls.flat().at(-1) as any).outcome).toBe("cancelled");
});

it("reports failed with a failure class when the launch throws", async () => {
  // Make openWorkspace reject however this file already forces launch failures.
  await expect(takeWithFailingLaunch()).rejects.toThrow();
  const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_completed") as any;
  expect(done.outcome).toBe("failed");
  expect(done.failure_class).toBeDefined();
});

it("marks repo_source as preselected when the card supplied repos", async () => {
  await takeHappyPath({ preselected: ["acme-billing"] });
  const picked = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_repos_picked") as any;
  expect(picked.repo_source).toBe("preselected");
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run test/unit/tasksView.test.ts -t "Take funnel"
```

Expected: FAIL — no funnel events.

- [ ] **Step 3: Add a failure classifier**

Add to `src/telemetry/events.ts` (and cover it in `events.test.ts`):

```ts
/** Map a thrown value to a failure class. Reads only the error's constructor name
 * and well-known code fields — never its message, which we do not send. */
export function classifyFailure(e: unknown): FailureClass {
  const name = e instanceof Error ? e.name : "";
  const code = (e as { code?: string } | null)?.code ?? "";
  if (name === "JiraAuthError" || code === "401" || code === "403") return "auth";
  if (name === "AbortError" || code === "ETIMEDOUT") return "timeout";
  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ENETUNREACH") return "network";
  if (code === "ENOENT") return "not_found";
  if (code === "EACCES" || code === "EPERM") return "permission";
  if (name === "SyntaxError") return "parse";
  return "unknown";
}
```

- [ ] **Step 4: Instrument `takeTask`**

Replace the body of `takeTask` ([tasksView.ts:913](../../../src/tasksView.ts#L913)):

```ts
  public async takeTask(key: string, preselected?: string[]): Promise<void> {
    const cfg = getConfig();
    const flow = startFlow();
    const taskFp = fingerprint(key);
    let destination: DestinationProp | undefined;
    let repoCount = 0;
    let promptModeProp: PromptModeProp = "custom";

    track({ name: "take_started", flow_id: flow.id, source: preselected?.length ? "card" : "command", task_fp: taskFp, inferred_count: 0 });

    const promptMode = await this.choosePromptMode(cfg, `${key} — how should the agent start?`);
    if (!promptMode) {
      track({ name: "take_completed", flow_id: flow.id, outcome: "cancelled", prompt_mode: promptModeProp, repo_count: 0, duration_ms: flow.elapsedMs(), task_fp: taskFp });
      return;
    }
    promptModeProp = toPromptModeProp(promptMode.id);
    track({ name: "take_prompt_mode_picked", flow_id: flow.id, prompt_mode: promptModeProp, is_custom_mode: promptModeProp === "custom" });

    const resolved = await this.resolveKickoff(key, preselected, flow);
    if (!resolved) {
      track({ name: "take_completed", flow_id: flow.id, outcome: "cancelled", destination, prompt_mode: promptModeProp, repo_count: repoCount, duration_ms: flow.elapsedMs(), task_fp: taskFp });
      return;
    }
    const { detail, services, target } = resolved;
    destination = target.kind as DestinationProp;
    repoCount = services.length;

    try {
      await this.launch(detail, services, promptMode.prompt, false, target);
      track({ name: "take_completed", flow_id: flow.id, outcome: "launched", destination, prompt_mode: promptModeProp, repo_count: repoCount, duration_ms: flow.elapsedMs(), task_fp: taskFp });
    } catch (e) {
      track({ name: "take_completed", flow_id: flow.id, outcome: "failed", destination, prompt_mode: promptModeProp, repo_count: repoCount, duration_ms: flow.elapsedMs(), failure_class: classifyFailure(e), task_fp: taskFp });
      throw e;  // onMessage's existing catch still owns the user-facing handling.
    }
  }
```

> Re-throwing is deliberate: [tasksView.ts:255](../../../src/tasksView.ts#L255) already handles and reports these failures. Telemetry observes; it must not change behaviour.

- [ ] **Step 5: Instrument `resolveKickoff`**

Add the optional `flow` parameter and two `track` calls. `take_started`'s `inferred_count` is 0 because inference has not run yet at that point — the real count arrives on `take_repos_picked`.

Change the signature:

```ts
  private async resolveKickoff(
    key: string,
    preselected?: string[],
    flow?: Flow,
  ): Promise<{ detail: JiraDetail; services: ServiceRef[]; target: OpenTarget } | undefined> {
```

After `const target = await this.chooseOpenTarget(cfg); if (!target) return undefined;`:

```ts
    if (flow) {
      track({
        name: "take_destination_picked",
        flow_id: flow.id,
        destination: target.kind as DestinationProp,
        workspace_mode: cfg.workspaceMode === "per-window" ? "per-window" : "multiroot",
        used_worktree: cfg.worktree === "always",
      });
    }
```

Track which branch produced the repo set. Declare `let repoSource: RepoSource;` and `let inferredCount = 0;` before the `if (preselected && preselected.length)` chain, set `repoSource = "preselected"` / `"destination"` / `"quickpick"` in each branch, set `inferredCount = inferred.length` in the QuickPick branch, and after `if (services.length === 0)`:

```ts
    if (flow) {
      track({
        name: "take_repos_picked",
        flow_id: flow.id,
        repo_count: services.length,
        repo_source: repoSource,
        // Only the QuickPick branch can accept or reject inference.
        accepted_inference: repoSource === "quickpick" && services.length === inferredCount,
        inferred_count: inferredCount,
      });
    }
```

- [ ] **Step 6: Run to green**

```bash
npx vitest run test/unit/tasksView.test.ts
```

Expected: PASS, including every pre-existing test in the file — `resolveKickoff`'s new parameter is optional, so `addressPr` is untouched.

- [ ] **Step 7: Commit**

```bash
git add src/tasksView.ts src/telemetry/events.ts test/unit/tasksView.test.ts test/unit/telemetry/events.test.ts
git commit -m "feat(telemetry): instrument the Take funnel end to end"
```

---

### Task 11: `operation_failed` at the dispatcher catch

**Files:**
- Modify: `src/tasksView.ts` (the `onMessage` catch, ~line 255)
- Test: `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `trackError`, `classifyFailure`, `Op`.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```ts
it("reports operation_failed when a webview message throws", async () => {
  // Force the Jira client to reject however the existing error tests in this file do.
  await fireMessageThatThrows({ type: "fetch", filter: "mysprint", size: "any" });
  const ev = trackErrorSpy.mock.calls.flat().find((e: any) => e.name === "operation_failed") as any;
  expect(ev).toBeDefined();
  expect(ev.op).toBe("jira_fetch");
  expect(JSON.stringify(ev)).not.toContain("BILL");
});

it("classifies a JiraAuthError as auth", async () => {
  await fireMessageThatThrows({ type: "fetch", filter: "mysprint", size: "any" }, new JiraAuthError("nope"));
  const ev = trackErrorSpy.mock.calls.flat().find((e: any) => e.name === "operation_failed") as any;
  expect(ev.failure_class).toBe("auth");
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run test/unit/tasksView.test.ts -t operation_failed
```

Expected: FAIL — no `operation_failed` event.

- [ ] **Step 3: Map message types to ops, then report in the existing catch**

Add near the top of `src/tasksView.ts`:

```ts
/** Which engine operation a webview message represents, for operation_failed.
 * Messages absent from this map report as "jira_fetch" only if they read Jira;
 * anything genuinely unclassifiable is left out and reports nothing. */
const MESSAGE_OPS: Partial<Record<InboundMessage["type"], Op>> = {
  ready: "jira_fetch",
  retry: "jira_fetch",
  fetch: "jira_fetch",
  detail: "jira_fetch",
  take: "workspace_write",
  takeBatch: "workspace_write",
  addressPr: "pr_lookup",
  changeStatus: "jira_write",
  addToMySprint: "jira_write",
  removeFromSprint: "jira_write",
  setComponent: "jira_write",
  explore: "workspace_write",
  runDoctor: "jira_fetch",
};
```

Inside the existing `catch (e)` at [tasksView.ts:255](../../../src/tasksView.ts#L255), as the **first** statement so nothing can pre-empt it:

```ts
      const op = MESSAGE_OPS[m.type];
      if (op) {
        trackError({
          name: "operation_failed",
          op,
          failure_class: classifyFailure(e),
          retryable: !(e instanceof JiraAuthError),
        });
      }
```

Leave the rest of the catch exactly as it is.

- [ ] **Step 4: Run to green**

```bash
npx vitest run test/unit/tasksView.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(telemetry): report operation_failed from the webview dispatcher catch"
```

---

### Task 12: `docs/TELEMETRY.md`, the drift test, and the README

**Files:**
- Create: `docs/TELEMETRY.md`
- Create: `test/unit/telemetry/docs.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: the catalog's event names.
- Produces: the URL the notice already links to.

- [ ] **Step 1: Write the failing drift test**

Create `test/unit/telemetry/docs.test.ts`. It reads the catalog source rather than importing a name list, so a new event cannot be added without documenting it:

```ts
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");

/** Event names as declared in the catalog: `{ name: "x"` literals. */
function catalogEventNames(): string[] {
  const src = fs.readFileSync(path.join(ROOT, "src/telemetry/events.ts"), "utf8");
  return [...new Set([...src.matchAll(/\{\s*name:\s*"([a-z_]+)"/g)].map((m) => m[1]))];
}

describe("docs/TELEMETRY.md", () => {
  it("documents every event in the catalog", () => {
    const doc = fs.readFileSync(path.join(ROOT, "docs/TELEMETRY.md"), "utf8");
    const missing = catalogEventNames().filter((n) => !doc.includes(n));
    expect(missing, `undocumented events: ${missing.join(", ")}`).toEqual([]);
  });

  it("finds a non-trivial catalog to check", () => {
    expect(catalogEventNames().length).toBeGreaterThanOrEqual(10);
  });

  it("states the opt-out and names the setting", () => {
    const doc = fs.readFileSync(path.join(ROOT, "docs/TELEMETRY.md"), "utf8");
    expect(doc).toContain("agentFlow.telemetry.enabled");
    expect(doc).toContain("telemetry.telemetryLevel");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run test/unit/telemetry/docs.test.ts
```

Expected: FAIL — `docs/TELEMETRY.md` does not exist.

- [ ] **Step 3: Write `docs/TELEMETRY.md`**

It must contain: what is collected and why; the complete Phase 1 event table with every property; an explicit list of what is **never** collected (repo names, ticket keys, Jira project keys, file paths, prompt text, error messages, IP-derived identity beyond PostHog's own ingestion); how identity works (`env.machineId`, per-install salt never transmitted); both opt-out routes (`agentFlow.telemetry.enabled` and `telemetry.telemetryLevel`); and where the data goes (a personal PostHog project). Copy the property tables from the spec's Event Catalog section — they are already accurate — and add a "Last updated" line naming the extension version.

- [ ] **Step 4: Run to green**

```bash
npx vitest run test/unit/telemetry/docs.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Amend the README**

Add a **Telemetry** section near the end, before the licence: one paragraph, the two opt-out routes, and a link to `docs/TELEMETRY.md`. Then grep for claims the change makes untrue:

```bash
grep -niE "no telemetry|never sends|nothing leaves|read-only|no data" README.md
```

The README's read-only claims are about *Jira writes* and were already amended once for review writes — check each hit and correct only those that now misstate the telemetry posture.

- [ ] **Step 6: Commit**

```bash
git add docs/TELEMETRY.md README.md test/unit/telemetry/docs.test.ts
git commit -m "docs(telemetry): public disclosure, drift test and README section"
```

---

### Task 13: Full verification and real end-to-end confirmation

**Files:** none — this task only runs things and then records a result.

- [ ] **Step 1: Full suite with coverage**

```bash
npx vitest run --coverage
```

Expected: PASS, thresholds met (`statements ≥ 90, branches ≥ 85, functions ≥ 85, lines ≥ 90`). If `src/telemetry/*` drags branches down, add the missing-branch tests — do not lower the thresholds and do not add files to the coverage `exclude` list.

- [ ] **Step 2: Type-check and build**

```bash
npx tsc --noEmit -p tsconfig.json && node esbuild.js --production
```

Expected: no type errors; `dist/extension.js` written. `crypto` is a Node builtin and `platform: "node"`, so no esbuild config change should be needed — if esbuild complains about `crypto`, import from `node:crypto` rather than adding an external.

- [ ] **Step 3: Set the real PostHog API key**

Create the PostHog project (personal account), copy its **project API key**, and replace `POSTHOG_API_KEY` in `src/telemetry/posthog.ts`. Leave `PLACEHOLDER_KEY` as it is — the no-op guard compares against it.

- [ ] **Step 4: Confirm events actually land**

Run the extension in the Extension Development Host (F5), then:
1. Confirm the first-run notice appears on the **second** activation.
2. Run **Agent Flow: Open the Deck** → expect `command_invoked`.
3. Take a task and cancel at the prompt-mode picker → expect `take_started` + `take_completed{cancelled}`.
4. Take a task through to launch → expect all five funnel events sharing one `flow_id`.
5. In PostHog's Activity view, filter `env_type = "development"` and confirm each event and its properties.

- [ ] **Step 5: Verify the common-property naming, and fix if VS Code prefixed it**

This is the one contract this plan could not pin from the typings: VS Code may namespace `additionalCommonProperties`. Look at an actual event's properties in PostHog. If `session_id` / `env_type` arrived prefixed (e.g. `common.session_id`), either rename the keys in `initTelemetry` or strip a `common.` prefix in the sender's `enqueue` — and add a `posthog.test.ts` case pinning whichever you chose.

- [ ] **Step 6: Confirm both kill switches actually silence it**

Set `agentFlow.telemetry.enabled: false`, exercise a command, confirm no new PostHog events. Restore it, set `telemetry.telemetryLevel: "off"`, repeat. Then set it to `"error"` and confirm usage events stop while a forced failure still arrives.

- [ ] **Step 7: Commit the key and record the verification**

```bash
git add src/telemetry/posthog.ts
git commit -m "chore(telemetry): set the PostHog project ingestion key"
```

---

## Phase 2 — sketch (not part of this plan)

The remaining 20 events, to be planned separately once Phase 1 is verified in production. Each follows a pattern Phase 1 establishes, so no new infrastructure is expected.

- **Batch launch** (`batch_started`, `batch_completed`) — `takeBatch`, ~line 927. Reuses `startFlow`, adds `take_layout_picked` for the separate/shared window choice.
- **Explore** (`explore_started`, `explore_completed`) — the four Explore modes and the Slack-DM toggle.
- **PR address** (`pr_address_started`, `pr_address_completed`) — `addressPr`; pass a `Flow` into the `resolveKickoff` parameter Task 10 already added.
- **Review** (`review_launched`, `review_submitted`) — `deckView.ts` + `engine/review/`.
- **Deck** (`deck_opened`, `deck_action`) — one `track` at [deckView.ts:121](../../../src/deckView.ts#L121), mapping `deck:*` message types to the `action` enum.
- **Marketplace** (`marketplace_opened`, `marketplace_action`) — same at [marketplaceView.ts:40](../../../src/marketplaceView.ts#L40).
- **Tasks view** (`tasks_fetched`, `lens_used`, `card_action`) — `tasks_fetched` and the tab/size lenses come free from the `fetch` message; the repo lens and search box are webview-local and need explicit `InboundMessage` variants, with search debounced 500 ms.
- **Setup / Doctor** (`setup_started`, `setup_completed`, `jira_auth`, `doctor_opened`) — `setup.ts` and `doctorView.ts`.

Each new event needs: a catalog variant, a row in `docs/TELEMETRY.md` (the drift test enforces this), and a test asserting it fires with no user strings.

---

## Self-Review

**Spec coverage.** Every Phase 1 item in the spec maps to a task: module layout → Tasks 2–7; both consent gates → Task 5; first-run notice → Task 7; the setting → Task 1; identity/fingerprints → Task 2; the 10 Phase 1 events → Tasks 8–11; settings snapshot → Task 6; failure handling → Task 4; the six test files → Tasks 2–7 and 12; `docs/TELEMETRY.md` + drift test + README → Task 12; mock additions → Task 1; end-to-end verification → Task 13.

**Two deviations from the spec, both deliberate and both amended in the spec itself before this plan was written:**
1. `take_repos_picked.used_search` → `repo_source` + `inferred_count`. A QuickPick exposes no search signal; the three ways `resolveKickoff` reaches a repo set are observable and more informative.
2. `take_destination_picked.destination` now mirrors `OpenTarget.kind` (new · current · existing · live-folder) with a separate `used_worktree`, rather than the `openIn` setting values — the worktree decision is a separate downstream branch.

**One addition not in the spec:** `src/telemetry/settingsSnapshot.ts` as its own file (the spec listed five files). It is the only code that reads user config into an event, so isolating it puts the leak risk in one small, heavily tested place.

**One contract this plan cannot pin from the typings:** whether VS Code namespaces `additionalCommonProperties`. Task 13 Step 5 verifies it against real ingested events and specifies the fix either way, rather than guessing here.

**Placeholder scan.** No "TBD"/"add error handling"/"write tests for the above". Two steps intentionally describe content rather than dictating prose — Task 12 Step 3 (`docs/TELEMETRY.md` body) and Step 5 (README wording) — and both enumerate exactly what must be present, with a test enforcing the parts that matter.

**Type consistency.** `Flow` (Task 5) is the type `resolveKickoff` accepts (Task 10). `classifyFailure` is defined once in Task 10 Step 3 and reused in Task 11. `toPromptModeProp` / `STOCK_PROMPT_MODES` are defined in Task 3 and consumed in Tasks 6 and 10. `PromptModeProp`, `DestinationProp`, `RepoSource`, `Op`, `CommandId`, `FailureClass` are declared once in Task 3 and referenced by their exact names thereafter. `makeMemento` is defined in Task 1 and used in Tasks 2, 5, 7, 8. `POSTHOG_API_KEY` / `PLACEHOLDER_KEY` are named consistently in Tasks 4 and 13.
