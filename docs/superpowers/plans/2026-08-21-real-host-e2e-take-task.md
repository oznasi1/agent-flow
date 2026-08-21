# Real-Host E2E — Fixture Connector + Take-a-Task Journey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove, in a real VS Code Electron host with zero manual steps, that taking a task works: the pool renders, Take is clicked, a real window opens, and the brief + plan-handshake files land on disk with the right content.

**Architecture:** A JSON-backed **fixture task connector** (`src/tasks/fixture/`) replaces the fake-Jira server — it is resolved by the connector registry only when `AGENT_FLOW_FIXTURE_DIR` is set AND `agentFlow.taskSource` is `"fixture"`, so it ships inert. A Playwright `_electron` harness downloads a pinned VS Code, launches it with a sandboxed `HOME`/user-data-dir/extensions-dir and seeded settings that pre-answer every mid-take prompt except the repo-confirm QuickPick (which the test drives — it is real take UX). Journey specs live in `test-e2e/` with a `.e2e.ts` suffix so neither Vitest (`test/**/*.test.*`) nor CT (`test-ct/**/*.spec.tsx`) can claim them.

**Tech Stack:** `@playwright/test@1.49.1` (already pinned), `@vscode/test-electron` (pinned exact), Vitest for the connector's unit tests.

**Spec:** `docs/superpowers/specs/2026-08-15-automated-verify-cycle-design.html` (Layer B §5b + §6 seams as amended 2026-08-21: fixture connector, not fake Jira. Journeys 2–5, Layer C report, and the CI release gate are out of scope — see "Out of Scope").

## Global Constraints

Every task's requirements implicitly include this section. These are the repo's own gates — a task is not done until all of them pass.

- **`npm run typecheck` must stay clean** (`tsc --noEmit`). New directories must be added to `tsconfig.json`'s `include` or they are silently untypechecked.
- **`npm test` must pass unmodified** — 3,771 tests across 108 files. Do **not** edit, delete, or weaken any existing test. `npm test` takes ~2–4 min: give the Bash call `timeout: 600000`.
- **`npm run build` must succeed** (esbuild). The webview must never import `fs`/`os`/`path`/`child_process` — nothing in this plan touches `src/webview/`, so this should stay green by construction, but run it.
- **`npm run test:cov` thresholds must hold**: statements 90, branches 85, functions 85, lines 90. The fixture connector is host-side `src/` code, so it **counts toward coverage and must be unit-tested** (Task 1 does this).
- **`npm run test:ct` must pass** — 7 component tests from the Layer A increment.
- **Ship inert.** Thousands of installs. With `AGENT_FLOW_FIXTURE_DIR` unset, `resolveConnector` must behave byte-identically to today. `CONNECTOR_IDS` must NOT change (it feeds the telemetry allowlist and a manifest-parity test).
- **Lockfile hygiene**: this is public OSS. After any `npm install`, verify `grep -c codeartifact package-lock.json` is 0; if polluted, `git checkout package-lock.json` and re-run with `--registry=https://registry.npmjs.org`.
- **Pin exact versions** (no `^`) for the new dev-dependency.
- E2E specs are excluded from CI in this increment (see Task 4) — they run locally via `npm run test:e2e`. CI wiring is a follow-up once the lane is proven stable, per the spec's own quarantine discipline.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `src/tasks/fixture/connector.ts` | The fixture `TaskConnector` + `TaskProvider`: reads `<dir>/tasks.json`, records writes to `<dir>/writes.jsonl` |
| `test/unit/fixtureConnector.test.ts` | Unit tests: inertness, list/detail, write recording |
| `playwright-e2e.config.ts` | E2E runner config: `test-e2e/`, one worker, long timeouts, screenshots on |
| `test-e2e/_helpers/sandbox.ts` | Builds the throwaway world: temp HOME, fixture dir, temp git repo, seeded settings |
| `test-e2e/_helpers/host.ts` | Downloads pinned VS Code, launches it via `_electron`, finds the tasks-webview frame |
| `test-e2e/take-task.e2e.ts` | Journey 1: pool renders → Take → QuickPick → new window → files asserted |

**Modified:** `src/tasks/registry.ts` (env-gated resolution), `package.json` (dep + `test:e2e` script), `tsconfig.json` (include `test-e2e`), `.gitignore` (`.vscode-test/`), `CONTRIBUTING.md` (document the command), `.github/workflows/ci.yml` (NOT modified — deliberate, see Task 4).

---

### Task 1: The fixture connector

A `TaskConnector` whose data is a JSON file and whose writes are a JSONL file. No server, no network, no auth. Registry-resolved only under the env gate.

**Files:**
- Create: `src/tasks/fixture/connector.ts`
- Modify: `src/tasks/registry.ts`
- Test: `test/unit/fixtureConnector.test.ts`

**Interfaces:**
- Consumes: `TaskConnector`, `TaskProvider`, `SourceInfo`, `Capabilities`, `StatusTarget`, `Task`, `TaskDetail` from `src/tasks/provider.ts`.
- Produces: `makeFixtureConnector(dir: string): TaskConnector`; the registry rule *"`taskSource === "fixture"` && `AGENT_FLOW_FIXTURE_DIR` set → fixture; anything else → today's behavior"*; the fixture file contract `tasks.json` = `FixtureTaskRecord[]` where `FixtureTaskRecord = Task & { descriptionText: string }`; `writes.jsonl` = one JSON object per line, `{ op: "moveTo", key, targetId, values, at } | { op: "addLabel", key, label, at } | { op: "assignToMe", key, meId, at }`.

- [x] **Step 1: Write the failing tests**

Create `test/unit/fixtureConnector.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { makeFixtureConnector } from "../../src/tasks/fixture/connector";
import { resolveConnector, CONNECTOR_IDS } from "../../src/tasks/registry";

// resolveConnector reads getConfig().taskSource — mock it the way other unit
// tests mock config, pointing taskSource wherever each test needs.
vi.mock("../../src/config", () => ({
  getConfig: vi.fn(() => ({ taskSource: "fixture" })),
}));
import { getConfig } from "../../src/config";

const RECORD = {
  key: "E2E-1", summary: "Fix the rocket telemetry panel", status: "To Do",
  statusCategory: "new" as const, priority: "P2", assignee: "Unassigned",
  labels: ["telemetry"], components: [], sprint: null, inOpenSprint: false,
  updated: "2026-08-21T00:00:00.000Z", url: "https://fixture.invalid/browse/E2E-1",
  estimateSeconds: null, descriptionText: "The rocket panel shows stale numbers.",
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-fixture-"));
  fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([RECORD]));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.AGENT_FLOW_FIXTURE_DIR;
});

describe("the fixture provider", () => {
  it("lists the tasks from tasks.json for any lens", async () => {
    const p = makeFixtureConnector(dir).provider();
    const tasks = await p.list("all", "any");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].key).toBe("E2E-1");
    // Task fields only — descriptionText is detail's, not list's.
    expect((tasks[0] as Record<string, unknown>).descriptionText).toBeUndefined();
  });

  it("serves detail for a listed key and throws for an unknown one", async () => {
    const p = makeFixtureConnector(dir).provider();
    const d = await p.detail("E2E-1");
    expect(d.summary).toBe("Fix the rocket telemetry panel");
    expect(d.descriptionText).toBe("The rocket panel shows stale numbers.");
    await expect(p.detail("NOPE-1")).rejects.toThrow(/NOPE-1/);
  });

  it("records moveTo to writes.jsonl instead of talking to any server", async () => {
    const p = makeFixtureConnector(dir).provider();
    await p.moveTo("E2E-1", "done", { resolution: "Done" });
    const lines = fs.readFileSync(path.join(dir, "writes.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines[0])).toMatchObject({ op: "moveTo", key: "E2E-1", targetId: "done" });
  });

  it("records a label add — journey 3's provenance-label assertion reads this", async () => {
    const conn = makeFixtureConnector(dir);
    await conn.provider().caps.labels!.add("E2E-1", "claude-code");
    const lines = fs.readFileSync(path.join(dir, "writes.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines[0])).toMatchObject({ op: "addLabel", key: "E2E-1", label: "claude-code" });
  });

  it("is authenticated and configured without any interaction", async () => {
    const conn = makeFixtureConnector(dir);
    expect(conn.isConfigured()).toBe(true);
    await expect(conn.isAuthenticated()).resolves.toBe(true);
  });
});

describe("the registry gate", () => {
  it("does NOT advertise the fixture in CONNECTOR_IDS — telemetry allowlist stays as shipped", () => {
    expect(CONNECTOR_IDS).toEqual(["jira"]);
  });

  it("falls back to jira for taskSource=fixture when the env var is unset — ships inert", () => {
    delete process.env.AGENT_FLOW_FIXTURE_DIR;
    const log = vi.fn();
    const conn = resolveConnector({} as never, log);
    expect(conn.id).toBe("jira");
  });

  it("resolves the fixture only when BOTH the setting and the env var say so", () => {
    process.env.AGENT_FLOW_FIXTURE_DIR = dir;
    const conn = resolveConnector({} as never, vi.fn());
    expect(conn.id).toBe("fixture");
  });

  it("ignores the env var when taskSource is jira — an exported var cannot hijack a real user", () => {
    process.env.AGENT_FLOW_FIXTURE_DIR = dir;
    vi.mocked(getConfig).mockReturnValueOnce({ taskSource: "jira" } as ReturnType<typeof getConfig>);
    const conn = resolveConnector({} as never, vi.fn());
    expect(conn.id).toBe("jira");
  });
});
```

- [x] **Step 2: Run to verify the tests fail**

Run: `npx vitest run test/unit/fixtureConnector.test.ts` (timeout: 120000)
Expected: FAIL — `Cannot find module '../../src/tasks/fixture/connector'`.

- [x] **Step 3: Implement the connector**

Create `src/tasks/fixture/connector.ts`. Before writing, open `src/tasks/provider.ts` and `src/tasks/jira/connector.ts` and copy the **current** member lists — `TaskConnector` and `SourceInfo` are the contract; if a field listed here has drifted, the interface wins:

```ts
import * as fs from "fs";
import * as path from "path";
import type { AuthProbe, ProjectProbe } from "../../engine/doctor";
import {
  Capabilities, SourceInfo, StatusTarget, Task, TaskConnector, TaskDetail, TaskProvider,
} from "../provider";

/** One task in `tasks.json`: everything the pool renders plus the detail body. */
export type FixtureTaskRecord = Task & { descriptionText: string };

/** A JSON-backed task source for the real-host E2E lane. No server, no network,
 * no auth: `tasks.json` in the fixture dir is the truth, and every write lands as
 * a line in `writes.jsonl` for the test to assert on. Reached ONLY through the
 * registry's env gate — see resolveConnector — so a shipped install can never
 * resolve it by accident. */
export function makeFixtureConnector(dir: string): TaskConnector {
  const read = (): FixtureTaskRecord[] =>
    JSON.parse(fs.readFileSync(path.join(dir, "tasks.json"), "utf8")) as FixtureTaskRecord[];
  const record = (entry: Record<string, unknown>): void => {
    fs.appendFileSync(path.join(dir, "writes.jsonl"), JSON.stringify({ ...entry, at: Date.now() }) + "\n");
  };
  const find = (key: string): FixtureTaskRecord => {
    const t = read().find((r) => r.key === key);
    if (!t) throw new Error(`fixture: no task ${key} in ${dir}/tasks.json`);
    return t;
  };

  const caps: Capabilities = {
    supportedFilters: ["mine", "all"],
    sizes: false,
    labels: {
      add: async (key, label) => { find(key); record({ op: "addLabel", key, label }); },
    },
  };

  const provider: TaskProvider = {
    caps,
    list: async () => read().map(({ descriptionText: _d, ...task }) => task),
    detail: async (key) => {
      const { key: k, summary, descriptionText, labels, components, url, status, statusCategory } = find(key);
      return { key: k, summary, descriptionText, labels, components, url, status, statusCategory } as TaskDetail;
    },
    status: async (key) => {
      const t = find(key);
      return { status: t.status, category: t.statusCategory };
    },
    statusTargets: async (): Promise<StatusTarget[]> => [
      { id: "in-progress", toName: "In Progress", toCategory: "indeterminate" },
      { id: "done", toName: "Done", toCategory: "done" },
    ],
    moveTo: async (key, targetId, values) => { find(key); record({ op: "moveTo", key, targetId, values }); },
    assignToMe: async (key, meId) => { find(key); record({ op: "assignToMe", key, meId: meId ?? "fixture-user" }); },
    me: async () => ({ id: "fixture-user", displayName: "Fixture User" }),
  };

  return {
    id: "fixture",
    setupSteps: 0,
    info: (): SourceInfo => ({
      label: "Fixture",
      scopeNoun: "file",
      scopeValue: path.join(dir, "tasks.json"),
      endpoint: dir,
      exampleKey: "E2E-1",
      endpointSetting: "agentFlow.taskSource",
      scopeSetting: "agentFlow.taskSource",
    }),
    isConfigured: () => true,
    configure: async () => async () => {},
    isAuthenticated: async () => true,
    signIn: async () => true,
    signOut: async () => {},
    provider: () => provider,
    // Both members absent → Doctor renders "skip", never a fake pass.
    probe: async (): Promise<{ auth?: AuthProbe; scope?: ProjectProbe }> => ({}),
    taskUrl: (key) => `https://fixture.invalid/browse/${key}`,
    keyFromUrl: (url) => {
      const m = /^https:\/\/fixture\.invalid\/browse\/([A-Za-z0-9-]+)$/.exec(url);
      return m ? m[1] : null;
    },
  };
}
```

If `Capabilities` requires more members than shown (check the interface), add them with the "not supported" value the interface documents. If `TaskProvider.caps` is not a member (it is — `readonly caps: Capabilities`), adjust to where caps actually live.

- [x] **Step 4: Gate it in the registry**

In `src/tasks/registry.ts`, add the import and the guarded branch at the top of `resolveConnector`, leaving `CONNECTORS` and `CONNECTOR_IDS` untouched:

```ts
import { makeFixtureConnector } from "./fixture/connector";
```

```ts
export function resolveConnector(
  ctx: vscode.ExtensionContext,
  log: (m: string) => void,
): TaskConnector {
  const id = getConfig().taskSource;
  // Test-only: the fixture connector exists only while BOTH the setting names it
  // and the environment names its data dir. It is deliberately absent from
  // CONNECTORS/CONNECTOR_IDS — it is not a product connector, must never appear
  // in the telemetry allowlist, and an exported env var alone must not be able
  // to change what a real user's taskSource resolves to.
  const fixtureDir = process.env.AGENT_FLOW_FIXTURE_DIR;
  if (id === "fixture" && fixtureDir) {
    log(`taskSource "fixture" resolved from AGENT_FLOW_FIXTURE_DIR=${fixtureDir}`);
    return makeFixtureConnector(fixtureDir);
  }
  if (!Object.hasOwn(CONNECTORS, id)) {
    log(`taskSource "${id}" is not a known connector — falling back to jira`);
    return CONNECTORS.jira(ctx);
  }
  return CONNECTORS[id](ctx);
}
```

- [x] **Step 5: Run the new tests**

Run: `npx vitest run test/unit/fixtureConnector.test.ts` (timeout: 120000)
Expected: PASS, 9 tests.

- [x] **Step 6: Run every repo gate**

```bash
npm run typecheck    # clean
npm test             # 3771 + 9 new, all passing   (timeout: 600000)
npm run test:cov     # thresholds hold — the connector is fully covered by Task 1's tests
npm run build        # succeeds
```

- [x] **Step 7: Commit**

```bash
git add src/tasks/fixture/connector.ts src/tasks/registry.ts test/unit/fixtureConnector.test.ts
git commit -m "feat(tasks): add an env-gated fixture connector for the E2E lane"
```

---

### Task 2: The E2E harness — sandbox + host launcher + smoke spec

Everything a journey needs to exist before it can be written: a throwaway world, a pinned real VS Code driven by Playwright, and a smoke spec proving the pool renders the fixture's task.

**Files:**
- Create: `playwright-e2e.config.ts`, `test-e2e/_helpers/sandbox.ts`, `test-e2e/_helpers/host.ts`, `test-e2e/smoke.e2e.ts`
- Modify: `package.json`, `tsconfig.json`, `.gitignore`

**Interfaces:**
- Consumes: the fixture file contract from Task 1 (`tasks.json` = `FixtureTaskRecord[]`).
- Produces: `makeSandbox(): Sandbox` where `Sandbox = { root, home, userDataDir, extensionsDir, fixtureDir, reposRoot, repoPath, dispose(): void }`; `launchHost(sb: Sandbox): Promise<{ app: ElectronApplication, page: Page }>`; `tasksFrame(page: Page): FrameLocator`; `openTasksView(page: Page): Promise<void>`; the npm script `test:e2e`.

- [x] **Step 1: Install the pinned downloader**

```bash
npm install -D --save-exact --registry=https://registry.npmjs.org @vscode/test-electron@2.4.1
grep -c codeartifact package-lock.json   # expect 0
```

- [x] **Step 2: Add the E2E runner config**

Create `playwright-e2e.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

/** Real-host E2E: one worker (each test boots an Electron VS Code), long
 *  timeouts (first run downloads the host), artifacts on failure. Spec files
 *  use `.e2e.ts` so neither Vitest (`test/**\/*.test.*`) nor CT
 *  (`test-ct/**\/*.spec.tsx`) can ever claim them. */
export default defineConfig({
  testDir: "./test-e2e",
  testMatch: /.*\.e2e\.ts$/,
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-e2e-report" }]] : [["list"]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
```

(Escape note: the `**\/` in the comment is only to keep this markdown fence intact — write real `**/` in the file.)

- [x] **Step 3: Build the sandbox helper**

Create `test-e2e/_helpers/sandbox.ts`:

```ts
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface Sandbox {
  root: string;
  home: string;          // child HOME — ~/.agentflow lands here, never in the real one
  userDataDir: string;
  extensionsDir: string;
  fixtureDir: string;
  reposRoot: string;
  repoPath: string;      // the one temp git repo, named "rocket"
  dispose(): void;
}

/** The task the journey takes. The summary CONTAINS the repo name ("rocket") on
 *  purpose: `inferServices` matches repo names against the task text, so the
 *  repo-confirm QuickPick opens with this repo pre-checked and a single Enter
 *  confirms it. */
export const FIXTURE_TASK = {
  key: "E2E-1", summary: "Fix the rocket telemetry panel", status: "To Do",
  statusCategory: "new", priority: "P2", assignee: "Unassigned",
  labels: [], components: [], sprint: null, inOpenSprint: false,
  updated: "2026-08-21T00:00:00.000Z", url: "https://fixture.invalid/browse/E2E-1",
  estimateSeconds: null, descriptionText: "The rocket panel shows stale numbers.",
};

export function makeSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "af-e2e-"));
  const home = path.join(root, "home");
  const userDataDir = path.join(root, "user-data");
  const extensionsDir = path.join(root, "extensions");
  const fixtureDir = path.join(root, "fixtures");
  const reposRoot = path.join(root, "repos");
  const repoPath = path.join(reposRoot, "rocket");
  for (const d of [home, userDataDir, extensionsDir, fixtureDir, repoPath]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // A real git repo — discoverRepos and the brief's git-exclude write need one.
  execFileSync("git", ["init", "-q"], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# rocket\n");
  execFileSync("git", ["add", "."], { cwd: repoPath });
  execFileSync("git", ["-c", "user.email=e2e@fixture.invalid", "-c", "user.name=E2E", "commit", "-qm", "init"], { cwd: repoPath });

  fs.writeFileSync(path.join(fixtureDir, "tasks.json"), JSON.stringify([FIXTURE_TASK], null, 2));

  // Pre-answer every mid-take prompt except the repo-confirm QuickPick:
  //  - taskMode "implementation" is a built-in prompt-mode id → no mode pick
  //  - openIn "new-window" → no destination pick
  //  - worktree "never"    → no worktree pick (journey 4 will flip this)
  //  - remoteControl "off" → no Remote Control pick
  //  - 1 repo → chooseWorkspaceMode returns "per-window" with no pick
  const settings = {
    "agentFlow.taskSource": "fixture",
    "agentFlow.reposRoot": reposRoot,
    "agentFlow.taskMode": "implementation",
    "agentFlow.openIn": "new-window",
    "agentFlow.worktree": "never",
    "agentFlow.remoteControl": "off",
    "agentFlow.seedAgent": true,
    "security.workspace.trust.enabled": false,
    "update.mode": "none",
    "extensions.autoUpdate": false,
  };
  fs.mkdirSync(path.join(userDataDir, "User"), { recursive: true });
  fs.writeFileSync(path.join(userDataDir, "User", "settings.json"), JSON.stringify(settings, null, 2));

  // Shadow /usr/bin/open with a failing shim. openInEditor (workspace.ts) shells
  // `open -a <appName>` first, which on a developer's Mac would launch the REAL
  // installed editor — outside this Electron app, invisible to Playwright, wrong
  // extensions. The shim makes exec fail, forcing the documented fallback:
  // vscode.openFolder{forceNewWindow} inside the SAME Electron app.
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "open"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  return {
    root, home, userDataDir, extensionsDir, fixtureDir, reposRoot, repoPath,
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
```

- [x] **Step 4: Build the host launcher**

Create `test-e2e/_helpers/host.ts`:

```ts
import { _electron, type ElectronApplication, type FrameLocator, type Page } from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import * as path from "path";
import type { Sandbox } from "./sandbox";

/** Pinned host build ≥ the manifest's engines floor (^1.90.0). Cached under
 *  .vscode-test/ after the first download. Bump deliberately, never float. */
export const VSCODE_VERSION = "1.96.2";

export async function launchHost(sb: Sandbox): Promise<{ app: ElectronApplication; page: Page }> {
  const executablePath = await downloadAndUnzipVSCode(VSCODE_VERSION);
  const app = await _electron.launch({
    executablePath,
    args: [
      `--extensionDevelopmentPath=${path.resolve(__dirname, "..", "..")}`,
      `--user-data-dir=${sb.userDataDir}`,
      `--extensions-dir=${sb.extensionsDir}`,
      "--disable-telemetry",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-updates",
      "--no-sandbox",
      "--disable-gpu",
      "--new-window",
    ],
    env: {
      ...process.env,
      HOME: sb.home,                                       // ~/.agentflow → sandbox
      AGENT_FLOW_FIXTURE_DIR: sb.fixtureDir,               // the registry gate
      PATH: `${path.join(sb.root, "bin")}:${process.env.PATH ?? ""}`, // `open` shim first
    },
  });
  const page = await app.firstWindow();
  // The workbench is alive when the activity bar exists.
  await page.locator(".activitybar").waitFor({ timeout: 60_000 });
  return { app, page };
}

/** Open the extension's sidebar. The activity-bar item carries the view
 *  container's title as its aria-label. */
export async function openTasksView(page: Page): Promise<void> {
  await page.locator('.activitybar [aria-label*="Agent Flow"]').click();
}

/** The tasks webview's DOM. VS Code nests webviews two iframes deep: an outer
 *  `iframe.webview` wrapper and the inner `#active-frame` that holds our React
 *  app. If the locator matches nothing, dump `page.content()` and adjust the
 *  outer selector — this nesting is workbench-internal and can shift between
 *  pinned versions (that is why it lives in exactly one helper). */
export function tasksFrame(page: Page): FrameLocator {
  return page.frameLocator("iframe.webview").last().frameLocator("#active-frame");
}
```

- [x] **Step 5: Write the smoke spec**

Create `test-e2e/smoke.e2e.ts`:

```ts
import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";

let sb: Sandbox;
let app: ElectronApplication;

test.beforeEach(() => { sb = makeSandbox(); });
test.afterEach(async () => { await app?.close(); sb.dispose(); });

test("a real host boots the extension and the pool renders the fixture task", async () => {
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openTasksView(page);
  const frame = tasksFrame(page);

  // The card is real DOM inside the real webview: the fixture's summary can be
  // there only if extension → connector → registry gate → webview all worked.
  await expect(frame.locator(".card", { hasText: FIXTURE_TASK.key })).toBeVisible({ timeout: 30_000 });
  await expect(frame.locator(".card")).toContainText(FIXTURE_TASK.summary);
  await page.screenshot({ path: "test-results/e2e-smoke-pool.png" });
});
```

- [x] **Step 6: Wire scripts, tsconfig, gitignore**

`package.json` scripts (E2E drives the built bundle, so build first):

```json
"test:e2e": "npm run build && playwright test -c playwright-e2e.config.ts"
```

`tsconfig.json` include: add `"test-e2e"` and `"playwright-e2e.config.ts"` to the existing array.

`.gitignore` — append:

```
# E2E host downloads and reports.
.vscode-test/
playwright-e2e-report/
```

- [x] **Step 7: Run the smoke spec**

Run: `npm run test:e2e` (timeout: 600000 — first run downloads VS Code)
Expected: PASS, 1 test, and `test-results/e2e-smoke-pool.png` shows the pool with E2E-1.

Debugging ladder, in order:
1. Workbench never appears → check the Electron console: `app.process().stderr` via `launched.app.evaluate` or run headed (`npx playwright test -c playwright-e2e.config.ts --headed`).
2. Sidebar empty → the extension didn't activate: confirm `--extensionDevelopmentPath` points at the repo root (it must contain `dist/` — did `npm run build` run?).
3. Pool shows the sign-in gate instead of cards → the registry gate didn't fire: env var not delivered (check `launch({ env })`) or settings.json not read (wrong `userDataDir/User/` path).
4. `tasksFrame` matches nothing → inspect `await page.content()` for the actual iframe classes and fix the ONE selector in `tasksFrame`.

- [x] **Step 8: Repo gates, then commit**

```bash
npm run typecheck && npm test && npm run build   # timeout: 600000
git add playwright-e2e.config.ts test-e2e package.json package-lock.json tsconfig.json .gitignore
git commit -m "test(e2e): stand up the real-host harness with a sandboxed pinned VS Code"
```

---

### Task 3: Journey 1 — take a task, verify the host really did it

The point of the whole lane: click Take in the real webview, drive the real repo-confirm QuickPick, watch a real second window open, and assert the extension's on-disk footprint.

**Files:**
- Create: `test-e2e/take-task.e2e.ts`
- Read only (do not modify): `src/tasksView.ts` (`takeTask`), `src/engine/workspace.ts` (`BRIEF_DIR`, `BRIEF_FILE`, `writePlanFile`, `PLAN_DIR`)

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces: nothing consumed later; this is the deliverable.

Ground truth for the assertions (verified against source, re-verify if lines moved):
- Brief: `<repo>/.pick-task/TASK.md` (`workspace.ts:16-17`), written by `openWorkspace` step 1, content from `briefMarkdown` — contains the key and summary.
- Plan handshake: `<HOME>/.agentflow/plans/<KEY>-<createdAt>.json` (`workspace.ts:18,243-246`), written with `seedAgent: true` because settings say so.
- New window: the `open` shim forces the `vscode.openFolder{forceNewWindow:true}` fallback (`workspace.ts:261`) — a new BrowserWindow in the same Electron app, so `app.waitForEvent("window")` sees it.

- [x] **Step 1: Write the journey spec**

Create `test-e2e/take-task.e2e.ts`:

```ts
import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";

let sb: Sandbox;
let app: ElectronApplication;

test.beforeEach(() => { sb = makeSandbox(); });
test.afterEach(async () => { await app?.close(); sb.dispose(); });

test("taking a task opens a real window and lands the brief + plan handshake on disk", async () => {
  test.setTimeout(180_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openTasksView(page);
  const frame = tasksFrame(page);
  const card = frame.locator(".card", { hasText: FIXTURE_TASK.key });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "test-results/e2e-take-1-pool.png" });

  // Take. Every downstream prompt except the repo confirm is pre-answered by
  // the sandbox settings (mode, destination, worktree, remote control).
  await card.locator("button.take").click();

  // The repo-confirm QuickPick is real workbench DOM. "rocket" arrives
  // pre-checked because the task summary names it (inferServices), so Enter
  // confirms. This is deliberate coverage of real take UX, not a shortcut.
  const quickInput = page.locator(".quick-input-widget");
  await expect(quickInput).toBeVisible({ timeout: 15_000 });
  await expect(quickInput).toContainText("rocket");
  await page.screenshot({ path: "test-results/e2e-take-2-repo-pick.png" });
  const newWindow = app.waitForEvent("window", { timeout: 60_000 });
  await page.keyboard.press("Enter");

  // A REAL second window — the openFolder fallback runs in-process, so the
  // same Electron app gains a BrowserWindow. This is the "verify the host is
  // working" assertion: no mock can produce this event.
  const opened = await newWindow;
  await opened.locator(".activitybar").waitFor({ timeout: 60_000 });
  await opened.screenshot({ path: "test-results/e2e-take-3-new-window.png" });

  // The brief, with content that can only have come from tasks.json through
  // the connector → takeTask → briefMarkdown → fs pipeline.
  const brief = path.join(sb.repoPath, ".pick-task", "TASK.md");
  await expect.poll(() => fs.existsSync(brief), { timeout: 30_000 }).toBe(true);
  const briefText = fs.readFileSync(brief, "utf8");
  expect(briefText).toContain(FIXTURE_TASK.key);
  expect(briefText).toContain(FIXTURE_TASK.summary);

  // The seed handshake, in the SANDBOX home — proof both that the plan file is
  // written and that the HOME override isolates it from the developer's machine.
  const planDir = path.join(sb.home, ".agentflow", "plans");
  await expect.poll(() => fs.existsSync(planDir) && fs.readdirSync(planDir).length, { timeout: 30_000 }).toBeTruthy();
  const planFile = fs.readdirSync(planDir).find((f) => f.startsWith(`${FIXTURE_TASK.key}-`));
  expect(planFile).toBeDefined();
  const plan = JSON.parse(fs.readFileSync(path.join(planDir, planFile!), "utf8"));
  expect(plan).toMatchObject({ key: FIXTURE_TASK.key, seedAgent: true });

  // And nothing leaked into the real home.
  expect(fs.existsSync(path.join(process.env.HOME ?? "", ".agentflow", "plans", planFile!))).toBe(false);
});
```

- [x] **Step 2: Run it**

Run: `npm run test:e2e` (timeout: 600000)
Expected: PASS, 2 tests (smoke + journey), with the three labelled screenshots in `test-results/`.

Failure ladder specific to this spec:
1. QuickPick never appears → the prompt-mode pick fired first (settings `taskMode` not read, or the id drifted from the built-ins in `src/config.ts`) — screenshot `page` and read the QuickPick title.
2. "rocket" not pre-checked / not listed → `discoverRepos` found nothing: `reposRoot` setting wrong or the temp repo isn't a git repo (`git init` step failed).
3. No second window → read the toast: if it names `open -a`, the PATH shim didn't win — verify the shim file is executable and first on the child's PATH.
4. Brief missing but window opened → look for the error toast; `openWorkspace` writes briefs before opening (step 1 of that function), so this ordering means a thrown error — check the extension host log via the Output panel screenshot.

- [x] **Step 3: Prove the assertions are live — break the product, watch the journey fail**

E2E asserting pre-existing behavior has the same vacuous-test hazard the CT plan had. Temporarily sabotage the brief write in `src/engine/workspace.ts` (line ~293):

```ts
fs.writeFileSync(briefPath, "SABOTAGED");   // ← temporary, in place of the briefMarkdown call
```

Run: `npm run test:e2e` (timeout: 600000)
Expected: the journey FAILS on the `briefText` assertions (smoke still passes).

Revert exactly and confirm green:

```bash
git checkout src/engine/workspace.ts
git diff --exit-code src/engine/workspace.ts
npm run test:e2e    # timeout: 600000 — PASS, 2 tests
```

- [x] **Step 4: Commit**

```bash
git add test-e2e/take-task.e2e.ts
git commit -m "test(e2e): prove take-a-task end to end in a real VS Code host"
```

---

### Task 4: Document the lane; leave CI deliberately unwired

Per the spec's own discipline (§9: "expect some early flake, driven to near-zero with hardening"), the lane earns its CI slot by being boringly green locally first. Wiring it into `ci.yml` as a release gate is its own follow-up with xvfb, caching, and the quarantine path — not a footnote to this increment.

**Files:**
- Modify: `CONTRIBUTING.md`
- Create: nothing
- NOT modified: `.github/workflows/ci.yml` — on purpose.

**Interfaces:**
- Consumes: the `test:e2e` script from Task 2.
- Produces: developer-facing documentation.

- [x] **Step 1: Document the command and the sandbox contract**

In `CONTRIBUTING.md`, add to the "Everyday commands" table:

```markdown
| `npm run test:e2e` | Real-host E2E: downloads a pinned VS Code, launches it sandboxed (own HOME, user-data, extensions), and drives take-a-task against the fixture connector. First run downloads ~150MB. |
```

And add a short section after the commands table:

```markdown
## The E2E fixture connector

`agentFlow.taskSource: "fixture"` resolves a JSON-backed task source, but only
while `AGENT_FLOW_FIXTURE_DIR` is set in the environment — both are required, so
shipped installs can never reach it. Tasks come from `<dir>/tasks.json`; every
write the extension performs is appended to `<dir>/writes.jsonl` for tests to
assert on. See `src/tasks/fixture/connector.ts` and `test-e2e/_helpers/sandbox.ts`.
```

- [x] **Step 2: Full local gate**

```bash
npm run typecheck   # clean
npm test            # all passing, unmodified          (timeout: 600000)
npm run test:ct     # 7 passing
npm run test:e2e    # 2 passing                        (timeout: 600000)
npm run build       # succeeds
```

- [x] **Step 3: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "docs: document the real-host E2E lane and the fixture connector"
```

---

## Out of Scope (next increments)

1. **Journey 2 — seeding**: the **terminal surface is done** in `test-e2e/seed-terminal.e2e.ts` — plan file → new-window activation → identity match → terminal opened → prompt typed unsubmitted, asserted from real xterm DOM, with a `claude` shim so the developer's real CLI can never start. The **panel surface** (default) remains: it needs a pinned Claude Code build installed into the sandbox's `extensionsDir`, and its URI-handler rung must be neutralized first — `vscode://` on a developer machine routes to the REAL installed editor, the same escape class as `open -a`.
2. ~~**Journey 3 — status write-back**~~ — **done** in `test-e2e/status-writeback.e2e.ts`: transition + claude-code provenance stamp asserted from `writes.jsonl`, card removal asserted from the DOM; sabotage-checked against a no-opped `stampProvenance`.
3. ~~**Journey 4 — worktree mode**~~ — **done** in `test-e2e/worktree-take.e2e.ts`: git-registered worktree, per-task branch, brief in the worktree and not the checkout. **Journey 5** (sign-in/out; needs its own SecretStorage seam) remains.
   *Harness note:* the sandboxed HOME makes macOS throw "Keychain Not Found" at the developer — `--use-inmemory-secretstorage` (VS Code's own test seam, present in 1.96.2) is required; `--password-store=basic` alone is not enough.
4. **CI wiring** — xvfb job, VS Code download cache, report artifact, the merge-to-main gate, and the `e2e` label trigger from spec §5d. After the lane is proven locally.
5. **Layer C** — the verify-feature report generator and PR delivery.

## Self-Review

- **Spec coverage:** §5b journey 1 fully implemented; §6 seams as amended (fixture connector, settings-not-seams, HOME isolation, `open` shim); §5c/§5d/§8 deliberately deferred and named above. The spec's "no real network" DoD line holds: fixture reads a file, telemetry is disabled by `--disable-telemetry` (the logger honors the host's telemetry state), updates and extension auto-update are off.
- **Placeholders:** none — every step has runnable code or exact commands. Two contract-drift guards are flagged as explicit "check the interface" instructions with the failure mode named, not hand-waved.
- **Type consistency:** `makeFixtureConnector(dir)` in Task 1 matches Task 2's env-var contract; `Sandbox` fields consumed in Task 3 (`repoPath`, `home`) are declared in Task 2; `FIXTURE_TASK.key/summary` used in Task 3 are defined in Task 2.
- **Inertness:** the registry gate requires setting AND env var; `CONNECTOR_IDS` untouched; a dedicated unit test pins each of those three facts.
- **Vacuous-test guard:** Task 3 Step 3 sabotages the product and requires the journey to fail before the work counts.
