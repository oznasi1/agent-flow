# Agile Accelerator (GUS) Task Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Salesforce Agile Accelerator / GUS task source to Agent Flow through the existing `TaskConnector` seam, without changing anything an existing or future Jira user depends on.

**Architecture:** Seven new modules under `src/tasks/agileAccelerator/`, four of them pure. All reads go through the `sf` CLI (no HTTP, no stored credential). Because the work-item schema cannot be verified against real GUS from this repo, the connector runs one cached `sf sobject describe` and builds every SOQL SELECT from the intersection of what it wants with what actually exists — which also detects the GUS-vs-package namespace prefix and resolves the unverified team field name. Connector-level caches (describe, identity, key→Id memo, a 30s batched status memo) are injected into the per-operation provider as dependencies.

**Tech Stack:** TypeScript, VS Code extension API, Vitest, esbuild. Salesforce `sf` CLI (`sf data query`, `sf sobject describe`, `sf org display user`), SOQL.

**Spec:** [`docs/superpowers/specs/2026-08-21-agile-accelerator-connector-design.md`](../specs/2026-08-21-agile-accelerator-connector-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

**Compatibility — the overriding constraint of this work:**

- `test/unit/compat.test.ts` **must not be edited** and must pass byte-unchanged. If it fails, the change is wrong.
- The manifest `agentFlow.taskSource` `default` stays `"jira"`. New installs still get Jira.
- `src/config.ts:628-629` (`baseUrl`, `project` — Jira's, despite generic names) is **not touched**. Add new fields alongside.
- **Zero SecretStorage keys** are added, read, or written by this work.
- `src/tasks/provider.ts` is **not modified**. It is contractually free of `vscode` and of dependencies.
- `src/engine/pr/provider.ts` is **not modified**. Do not widen `execRunner` — `gh` and `glab` run through it.
- No existing setting is read, written, or renamed.

**Frozen-on-release surface (never rename after this ships):**

- Connector id: `agileAccelerator`. Label: `"Agile Accelerator"`.
- Settings: `agentFlow.agileAccelerator.instanceUrl`, `agentFlow.agileAccelerator.team`, `agentFlow.agileAccelerator.targetOrg`.

**Manifest/registry rules (CI enforces each):**

- Manifest enum must be `["jira", "agileAccelerator"]` in **exactly that order** — `test/unit/telemetry/settingsSnapshot.test.ts:336` compares it to `Object.keys(CONNECTORS)` with order-sensitive `toEqual`.
- `enumDescriptions` gains exactly one entry, keeping length equal to `enum`.
- `docs/CONNECTORS.md` must contain `` `agileAccelerator` `` in backticks or `test/unit/docs.test.ts:12` fails.

**Telemetry:**

- Add **no** property to the `src/telemetry/events.ts` catalog and do not grow `OPEN_STRING_PROPS`.
- Leave the `jira_fetch` / `jira_write` wire names exactly as they are. They now mean "task-source fetch/write". Renaming is frozen by the compat test.

**Environment:**

- Worktree: `/Users/oznasi/dev/agent-flow/.claude/worktrees/gus-connector`, branch `worktree-gus-connector`.
- **Never run `npm install` here.** `node_modules` is a symlink to the main checkout. A stray install rewrites `package-lock.json` `resolved` URLs to a private registry and breaks public CI with `E401`. Verify with `grep -c codeartifact package-lock.json` → must be `0`.
- `npm test` takes ~130s+ and exceeds a 120s command timeout. Run it with a raised timeout (600000ms) and **never pipe it through `tail`**.

**Gates (all must pass before the branch is done):**

1. `npm run typecheck` — clean.
2. `npm test` — baseline is **122 files, 4523 tests, 0 failures**. Must be ≥ that, 0 failures.
3. `npm run test:cov` — thresholds: statements 90, branches 85, functions 85, lines 90.
4. `npm run build` — the **only** gate that catches a `vscode`/`fs`/`child_process` dependency leaking where it must not.

**Code conventions:**

- `child_process` may appear **only** in `src/tasks/agileAccelerator/cli.ts`.
- No hardcoded organization values. Everything instance-specific comes from settings.
- Match the surrounding comment density: these files explain *why*, not *what*.
- Every error class sets `this.name` to a string literal — esbuild minifies with no `keepNames`, and `telemetry/events.ts` classifies by `.name`.

---

### Task 1: `errors.ts` — classify an `sf` failure

**Files:**
- Create: `src/tasks/agileAccelerator/errors.ts`
- Test: `test/unit/tasks/agileAccelerator/errors.test.ts`

**Interfaces:**
- Consumes: `TaskApiError`, `TaskAuthError` from `src/tasks/provider.ts`.
- Produces:
  - `class SfApiError extends TaskApiError` (name `"SfApiError"`)
  - `interface SfErrorEnvelope { name?: unknown; message?: unknown }`
  - `function classifySfFailure(raw: string, fallback: string): Error`
  - `function statusForCode(code: string): number`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/tasks/agileAccelerator/errors.test.ts
import { describe, expect, it } from "vitest";
import { classifySfFailure, SfApiError, statusForCode } from "../../../../src/tasks/agileAccelerator/errors";
import { TaskAuthError } from "../../../../src/tasks/provider";

describe("classifySfFailure", () => {
  it("maps a session error to TaskAuthError so views show the sign-in gate", () => {
    const raw = JSON.stringify({ status: 1, name: "INVALID_SESSION_ID", message: "Session expired" });
    const e = classifySfFailure(raw, "sf failed");
    expect(e).toBeInstanceOf(TaskAuthError);
    expect(e.message).toContain("Session expired");
  });

  it("maps a missing default org to TaskAuthError, not an API error", () => {
    const raw = JSON.stringify({ status: 1, name: "NoDefaultEnvError", message: "No default environment" });
    expect(classifySfFailure(raw, "x")).toBeInstanceOf(TaskAuthError);
  });

  it("keeps the Salesforce error code reachable on an API error", () => {
    const raw = JSON.stringify({ status: 1, name: "INVALID_FIELD", message: "No such column 'Nope__c'" });
    const e = classifySfFailure(raw, "x");
    expect(e).toBeInstanceOf(SfApiError);
    expect((e as SfApiError).messages).toContain("No such column 'Nope__c'");
    expect((e as SfApiError).status).toBe(400);
  });

  it("survives output that is not JSON at all", () => {
    const e = classifySfFailure("command not found: sf", "sf exited 127");
    expect(e).toBeInstanceOf(SfApiError);
    expect(e.message).toBe("sf exited 127");
  });

  it("sets a stable name literal, because esbuild minifies class identifiers", () => {
    const e = classifySfFailure(JSON.stringify({ name: "INVALID_FIELD", message: "m" }), "x");
    expect(e.name).toBe("SfApiError");
  });
});

describe("statusForCode", () => {
  it("maps not-found, rate limits, and invalid-input families", () => {
    expect(statusForCode("NOT_FOUND")).toBe(404);
    expect(statusForCode("REQUEST_LIMIT_EXCEEDED")).toBe(429);
    expect(statusForCode("INVALID_FIELD")).toBe(400);
  });

  it("returns 0 for a code with no transport meaning, since sf has no HTTP status", () => {
    expect(statusForCode("SomethingNovel")).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/tasks/agileAccelerator/errors.test.ts`
Expected: FAIL — cannot resolve `src/tasks/agileAccelerator/errors`.

- [ ] **Step 3: Write the implementation**

```ts
// src/tasks/agileAccelerator/errors.ts
import { TaskApiError, TaskAuthError } from "../provider";

/** A failed `sf` invocation. Keeps the Salesforce error code and message intact
 *  so a caller can react structurally rather than by matching prose.
 *  status/fieldErrors/messages are NOT re-declared readonly here — the base
 *  class already declares them, and re-declaring would shadow rather than set. */
export class SfApiError extends TaskApiError {
  constructor(status: number, message: string, fieldErrors: Record<string, string>, messages: string[]) {
    super(status, message, fieldErrors, messages);
    this.name = "SfApiError";
  }
}

/** The shape `sf --json` uses for a failure: a top-level `name` carrying the
 *  Salesforce error code, and a human `message`. */
export interface SfErrorEnvelope {
  name?: unknown;
  message?: unknown;
}

/** Codes that mean "we are not usefully authenticated", as distinct from "the
 *  request was wrong". Views branch on TaskAuthError to show the sign-in gate,
 *  so misfiling one of these as an API error strands the user on an error toast
 *  with no way forward. */
const AUTH_CODES = new Set([
  "INVALID_SESSION_ID",
  "INVALID_LOGIN",
  "RefreshTokenAuthError",
  "NoAuthInfoFound",
  "NamedOrgNotFoundError",
  "NoDefaultEnvError",
]);

/** `sf` is not HTTP, so there is no real status. Synthesize one only where the
 *  meaning is unambiguous, and use 0 — not a guess — for everything else. */
export function statusForCode(code: string): number {
  if (code === "NOT_FOUND" || code === "INVALID_CROSS_REFERENCE_KEY") return 404;
  if (code === "REQUEST_LIMIT_EXCEEDED") return 429;
  if (code.startsWith("INVALID_") || code.startsWith("MALFORMED_")) return 400;
  return 0;
}

/** Turn `sf`'s stdout on a failed run into the right seam error. `fallback` is
 *  used verbatim when stdout is not the JSON envelope — an `sf` that died before
 *  it could format anything, a shell "command not found", an empty body. */
export function classifySfFailure(raw: string, fallback: string): Error {
  let code = "";
  let message = "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const env = parsed as SfErrorEnvelope;
      if (typeof env.name === "string") code = env.name.trim();
      if (typeof env.message === "string") message = env.message.trim();
    }
  } catch {
    /* not JSON — `fallback` is the whole message */
  }

  const text = message || fallback;
  if (code && AUTH_CODES.has(code)) return new TaskAuthError(text);
  return new SfApiError(statusForCode(code), text, {}, message ? [message] : []);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/tasks/agileAccelerator/errors.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tasks/agileAccelerator/errors.ts test/unit/tasks/agileAccelerator/errors.test.ts
git commit -m "feat(agileAccelerator): classify sf CLI failures into seam errors"
```

---

### Task 2: `cli.ts` — the only module that spawns

**Files:**
- Create: `src/tasks/agileAccelerator/cli.ts`
- Test: `test/unit/tasks/agileAccelerator/cli.test.ts`

**Interfaces:**
- Consumes: `classifySfFailure` (Task 1); `resolveBin` from `src/engine/pr/which.ts`; `markTaskNetworkFailure` from `src/tasks/provider.ts`.
- Produces:
  - `interface SfResult { stdout: string; stderr: string; code: number }`
  - `type SfRunner = (file: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<SfResult>`
  - `const execSfRunner: SfRunner`
  - `const SF_TIMEOUT_MS = 60_000`
  - `class SfCli` with `constructor(targetOrg: string, run?: SfRunner, locate?: () => string | null)` and methods `installed(): boolean`, `query<T>(soql: string): Promise<T[]>`, `describe(object: string): Promise<SfDescribeResult>`, `userInfo(): Promise<{ username: string; id: string }>`
  - `interface SfDescribeResult { name: string; fields: { name: string }[] }`
  - `class SfMissingError extends Error` (name `"SfMissingError"`)

**Why not the forge seam's `Runner`:** `execRunner` rejects on a non-zero exit and attaches only `stderr` — it discards stdout. `sf --json` writes its error envelope to **stdout** and still exits non-zero, so a `Runner`-based client would throw away the `name`/`message` it needs. `execSfRunner` resolves on a non-zero exit instead, and rejects only when the process could not be spawned. Do **not** widen `execRunner`; `gh` and `glab` run through it.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/tasks/agileAccelerator/cli.test.ts
import { describe, expect, it, vi } from "vitest";
import { SfCli, SfMissingError, SfRunner } from "../../../../src/tasks/agileAccelerator/cli";
import { SfApiError } from "../../../../src/tasks/agileAccelerator/errors";
import { TaskAuthError } from "../../../../src/tasks/provider";

const ok = (result: unknown): string => JSON.stringify({ status: 0, result });

/** A runner that records its argv and replays canned results. */
function fakeRunner(results: Partial<{ stdout: string; stderr: string; code: number }>[]) {
  const calls: string[][] = [];
  let i = 0;
  const run: SfRunner = async (file, args) => {
    calls.push([file, ...args]);
    const r = results[Math.min(i++, results.length - 1)];
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0 };
  };
  return { run, calls };
}

describe("SfCli.query", () => {
  it("returns the records out of a successful envelope", async () => {
    const { run } = fakeRunner([{ stdout: ok({ records: [{ Name: "W-1" }], totalSize: 1, done: true }) }]);
    const cli = new SfCli("", run, () => "/usr/local/bin/sf");
    expect(await cli.query("SELECT Name FROM x")).toEqual([{ Name: "W-1" }]);
  });

  it("passes --target-org only when one is configured", async () => {
    const withOrg = fakeRunner([{ stdout: ok({ records: [] }) }]);
    await new SfCli("gus", withOrg.run, () => "sf").query("SELECT Id FROM x");
    expect(withOrg.calls[0]).toContain("--target-org");
    expect(withOrg.calls[0]).toContain("gus");

    const noOrg = fakeRunner([{ stdout: ok({ records: [] }) }]);
    await new SfCli("", noOrg.run, () => "sf").query("SELECT Id FROM x");
    expect(noOrg.calls[0]).not.toContain("--target-org");
  });

  it("classifies a non-zero exit from the stdout envelope, not the exit code", async () => {
    const raw = JSON.stringify({ status: 1, name: "INVALID_FIELD", message: "No such column 'Nope__c'" });
    const { run } = fakeRunner([{ stdout: raw, code: 1 }]);
    const cli = new SfCli("", run, () => "sf");
    await expect(cli.query("SELECT Nope__c FROM x")).rejects.toBeInstanceOf(SfApiError);
  });

  it("surfaces an auth failure as TaskAuthError", async () => {
    const raw = JSON.stringify({ status: 1, name: "INVALID_SESSION_ID", message: "expired" });
    const { run } = fakeRunner([{ stdout: raw, code: 1 }]);
    await expect(new SfCli("", run, () => "sf").query("SELECT Id FROM x")).rejects.toBeInstanceOf(TaskAuthError);
  });

  it("throws SfMissingError when the binary cannot be located, without spawning", async () => {
    const run = vi.fn();
    const cli = new SfCli("", run as unknown as SfRunner, () => null);
    await expect(cli.query("SELECT Id FROM x")).rejects.toBeInstanceOf(SfMissingError);
    expect(run).not.toHaveBeenCalled();
  });

  it("marks a spawn-level ENOENT as a network-origin failure rather than auth", async () => {
    const run: SfRunner = async () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    };
    await expect(new SfCli("", run, () => "sf").query("SELECT Id FROM x")).rejects.toBeInstanceOf(SfMissingError);
  });
});

describe("SfCli.describe / userInfo", () => {
  it("returns the describe result", async () => {
    const { run, calls } = fakeRunner([{ stdout: ok({ name: "agf__ADM_Work__c", fields: [{ name: "Id" }] }) }]);
    const d = await new SfCli("", run, () => "sf").describe("agf__ADM_Work__c");
    expect(d.fields.map((f) => f.name)).toEqual(["Id"]);
    expect(calls[0]).toContain("--sobject");
  });

  it("returns the signed-in username and id", async () => {
    const { run } = fakeRunner([{ stdout: ok({ username: "me@example.com", id: "005000000000001" }) }]);
    expect(await new SfCli("", run, () => "sf").userInfo()).toEqual({
      username: "me@example.com",
      id: "005000000000001",
    });
  });

  it("reports installed() from the locator without spawning", () => {
    const run = vi.fn();
    expect(new SfCli("", run as unknown as SfRunner, () => null).installed()).toBe(false);
    expect(new SfCli("", run as unknown as SfRunner, () => "sf").installed()).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/tasks/agileAccelerator/cli.test.ts`
Expected: FAIL — cannot resolve `src/tasks/agileAccelerator/cli`.

- [ ] **Step 3: Write the implementation**

```ts
// src/tasks/agileAccelerator/cli.ts
// The only module in this connector that spawns a process. Everything else is
// pure or takes an SfCli. Keeping `child_process` here is what lets the rest of
// the connector be tested without a process and keeps the dependency out of any
// module the webview could reach.
import { execFile } from "child_process";
import { resolveBin } from "../../engine/pr/which";
import { markTaskNetworkFailure } from "../provider";
import { classifySfFailure } from "./errors";

export const SF_TIMEOUT_MS = 60_000;

/** What one `sf` invocation produced. Unlike the forge seam's `Runner`, a
 *  non-zero exit is a RESOLVED result, not a rejection: `sf --json` prints its
 *  error envelope to stdout and still exits non-zero, and that envelope is the
 *  only place the Salesforce error code appears. Rejection is reserved for "the
 *  process never ran". */
export interface SfResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type SfRunner = (
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<SfResult>;

export const execSfRunner: SfRunner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = { stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" };
        // A spawn failure has no exit code at all. Anything with a code ran and
        // complained, so its stdout is the envelope we want.
        const code = (err as NodeJS.ErrnoException & { code?: unknown } | null)?.code;
        if (err && (code === "ENOENT" || typeof code === "string")) {
          reject(err);
          return;
        }
        resolve({ ...out, code: err ? 1 : 0 });
      },
    );
  });

/** The `sf` CLI is not on this machine, or not where we can find it. Its own
 *  class so `probe()` can name the install step instead of showing a raw spawn
 *  error. `name` is a literal: esbuild minifies class identifiers. */
export class SfMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SfMissingError";
  }
}

/** One field, as `sf sobject describe` reports it. Only `name` is read — the
 *  connector asks "does this field exist", never "what type is it". */
export interface SfDescribeResult {
  name: string;
  fields: { name: string }[];
}

interface SfEnvelope<T> {
  status?: unknown;
  result?: T;
}

export class SfCli {
  constructor(
    private readonly targetOrg: string,
    private readonly run: SfRunner = execSfRunner,
    private readonly locate: () => string | null = () => resolveBin("sf"),
  ) {}

  /** Whether the binary is locatable. Deliberately uncached, like resolveBin
   *  itself: an `npm i -g @salesforce/cli` mid-session should start working. */
  installed(): boolean {
    return this.locate() !== null;
  }

  async query<T>(soql: string): Promise<T[]> {
    const res = await this.exec<{ records?: T[] }>(["data", "query", "--query", soql]);
    return res.records ?? [];
  }

  describe(object: string): Promise<SfDescribeResult> {
    return this.exec<SfDescribeResult>(["sobject", "describe", "--sobject", object]);
  }

  async userInfo(): Promise<{ username: string; id: string }> {
    const r = await this.exec<{ username?: unknown; id?: unknown }>(["org", "display", "user"]);
    return {
      username: typeof r.username === "string" ? r.username : "",
      id: typeof r.id === "string" ? r.id : "",
    };
  }

  /** Locate, spawn, unwrap. `--json` is appended here rather than by each caller
   *  so no call site can forget it and get human-formatted output. */
  private async exec<T>(base: string[]): Promise<T> {
    const bin = this.locate();
    if (!bin) {
      throw new SfMissingError("The Salesforce CLI (sf) was not found on your PATH.");
    }

    const args = [...base, "--json"];
    if (this.targetOrg) args.push("--target-org", this.targetOrg);

    let res: SfResult;
    try {
      res = await this.run(bin, args, { cwd: process.cwd(), timeoutMs: SF_TIMEOUT_MS });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new SfMissingError(`Could not run ${bin}. Is the Salesforce CLI installed?`);
      }
      throw markTaskNetworkFailure(
        err instanceof Error ? err : new Error(String(e)),
        err.code === "ETIMEDOUT" ? "ETIMEDOUT" : "ENOTFOUND",
      );
    }

    if (res.code !== 0) {
      throw classifySfFailure(res.stdout, res.stderr.trim() || `sf ${base[0]} failed.`);
    }

    let parsed: SfEnvelope<T>;
    try {
      parsed = JSON.parse(res.stdout) as SfEnvelope<T>;
    } catch {
      throw classifySfFailure(res.stdout, "The Salesforce CLI returned output we could not read.");
    }
    if (parsed.result === undefined) {
      throw classifySfFailure(res.stdout, "The Salesforce CLI returned no result.");
    }
    return parsed.result;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/tasks/agileAccelerator/cli.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tasks/agileAccelerator/cli.ts test/unit/tasks/agileAccelerator/cli.test.ts
git commit -m "feat(agileAccelerator): sf CLI transport with stdout-envelope error handling"
```

---

### Task 3: `describe.ts` — namespace detection and field intersection

**Files:**
- Create: `src/tasks/agileAccelerator/describe.ts`
- Test: `test/unit/tasks/agileAccelerator/describe.test.ts`

**Interfaces:**
- Consumes: `SfDescribeResult` (Task 2), type-only.
- Produces:
  - `const WORK_OBJECT_CANDIDATES: readonly string[]` — `["agf__ADM_Work__c", "ADM_Work__c"]`
  - `const WANTED_FIELDS: readonly string[]` — unprefixed logical names
  - `const TEAM_FIELD_CANDIDATES: readonly string[]`
  - `interface Schema { object: string; prefix: string; has(logical: string): boolean; field(logical: string): string; teamField: string | null; selectable(logical: readonly string[]): string[] }`
  - `function prefixOf(object: string): string`
  - `function buildSchema(object: string, d: SfDescribeResult): Schema`

This is the module that makes an unverifiable schema survivable. A SOQL query naming a field that does not exist fails **entirely** with `INVALID_FIELD`, so the field list must be derived from a describe rather than hardcoded.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/tasks/agileAccelerator/describe.test.ts
import { describe as suite, expect, it } from "vitest";
import {
  buildSchema, prefixOf, TEAM_FIELD_CANDIDATES, WANTED_FIELDS, WORK_OBJECT_CANDIDATES,
} from "../../../../src/tasks/agileAccelerator/describe";

const d = (object: string, fields: string[]) => ({ name: object, fields: fields.map((name) => ({ name })) });

suite("prefixOf", () => {
  it("reads the managed-package namespace off the object name", () => {
    expect(prefixOf("agf__ADM_Work__c")).toBe("agf__");
  });

  it("reads an empty prefix for the bare object GUS itself uses", () => {
    expect(prefixOf("ADM_Work__c")).toBe("");
  });
});

suite("buildSchema", () => {
  it("prefixes logical field names with the object's namespace", () => {
    const s = buildSchema("agf__ADM_Work__c", d("agf__ADM_Work__c", ["agf__Subject__c"]));
    expect(s.field("Subject__c")).toBe("agf__Subject__c");
    expect(s.prefix).toBe("agf__");
  });

  it("leaves field names bare when the object is bare (GUS)", () => {
    const s = buildSchema("ADM_Work__c", d("ADM_Work__c", ["Subject__c"]));
    expect(s.field("Subject__c")).toBe("Subject__c");
    expect(s.has("Subject__c")).toBe(true);
  });

  it("reports a field the org does not have as absent", () => {
    const s = buildSchema("agf__ADM_Work__c", d("agf__ADM_Work__c", ["agf__Subject__c"]));
    expect(s.has("Subject__c")).toBe(true);
    expect(s.has("Priority__c")).toBe(false);
  });

  it("selectable() drops absent fields instead of failing the query", () => {
    const s = buildSchema("agf__ADM_Work__c", d("agf__ADM_Work__c", ["agf__Subject__c", "agf__Status__c"]));
    expect(s.selectable(["Subject__c", "Priority__c", "Status__c"])).toEqual([
      "agf__Subject__c",
      "agf__Status__c",
    ]);
  });

  it("resolves the team field to the first candidate that exists", () => {
    const s = buildSchema("agf__ADM_Work__c", d("agf__ADM_Work__c", ["agf__Team__c"]));
    expect(s.teamField).toBe("agf__Team__c");
  });

  it("prefers the earlier candidate when an org has more than one", () => {
    const s = buildSchema("agf__ADM_Work__c", d("agf__ADM_Work__c", ["agf__Team__c", "agf__Scrum_Team__c"]));
    expect(s.teamField).toBe(`agf__${TEAM_FIELD_CANDIDATES[0]}`);
  });

  it("reports no team field rather than guessing one", () => {
    const s = buildSchema("agf__ADM_Work__c", d("agf__ADM_Work__c", ["agf__Subject__c"]));
    expect(s.teamField).toBeNull();
  });
});

suite("the candidate lists", () => {
  it("tries the packaged object before the bare GUS one", () => {
    expect([...WORK_OBJECT_CANDIDATES]).toEqual(["agf__ADM_Work__c", "ADM_Work__c"]);
  });

  it("wants only unprefixed logical names, so buildSchema can prefix them", () => {
    for (const f of WANTED_FIELDS) expect(f.startsWith("agf__")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/tasks/agileAccelerator/describe.test.ts`
Expected: FAIL — cannot resolve `src/tasks/agileAccelerator/describe`.

- [ ] **Step 3: Write the implementation**

```ts
// src/tasks/agileAccelerator/describe.ts
// Pure. Takes a describe result as data so every branch is testable without a
// process. This module exists because a SOQL query naming a field that does not
// exist fails ENTIRELY (INVALID_FIELD) rather than degrading — so an unverified
// field name is a total-failure risk, and the field list has to be discovered.
import type { SfDescribeResult } from "./cli";

/** Tried in order. The managed package namespaces its objects; GUS, which is the
 *  same code line without the package wrapper, does not. */
export const WORK_OBJECT_CANDIDATES = ["agf__ADM_Work__c", "ADM_Work__c"] as const;

/** Logical (unprefixed) field names this connector would like. Only `Name` and
 *  `Id` are standard and always present; every entry here is optional as far as
 *  the connector is concerned, and an absent one simply is not selected.
 *  Verified against forcedotcom/git2gus: Subject__c, Status__c, Assignee__c. The
 *  rest are plausible-but-unverified, which is exactly why they go through
 *  `selectable()`. */
export const WANTED_FIELDS = [
  "Subject__c",
  "Status__c",
  "Assignee__c",
  "Priority__c",
  "Product_Tag__c",
] as const;

/** The scope field, whose real API name we could not verify. First match wins. */
export const TEAM_FIELD_CANDIDATES = ["Scrum_Team__c", "Team__c"] as const;

export interface Schema {
  /** The object name that actually resolved, e.g. `agf__ADM_Work__c`. */
  readonly object: string;
  /** `"agf__"` or `""`. */
  readonly prefix: string;
  /** Does this org have the given logical field? */
  has(logical: string): boolean;
  /** The wire name for a logical field, whether or not it exists. */
  field(logical: string): string;
  /** The resolved team field's wire name, or null when the org has none. */
  readonly teamField: string | null;
  /** Wire names for those logical fields that exist, in the order given. */
  selectable(logical: readonly string[]): string[];
}

/** Everything before the object's own name is the namespace. */
export function prefixOf(object: string): string {
  const i = object.lastIndexOf("__");
  const head = object.slice(0, Math.max(i, 0));
  const cut = head.indexOf("__");
  return cut < 0 ? "" : object.slice(0, cut + 2);
}

export function buildSchema(object: string, d: SfDescribeResult): Schema {
  const prefix = prefixOf(object);
  const present = new Set(d.fields.map((f) => f.name));
  const field = (logical: string) => `${prefix}${logical}`;
  const has = (logical: string) => present.has(field(logical));

  return {
    object,
    prefix,
    has,
    field,
    teamField: TEAM_FIELD_CANDIDATES.map(field).find((f) => present.has(f)) ?? null,
    selectable: (logical) => logical.filter(has).map(field),
  };
}
```

**Note on `prefixOf`:** the logic above was executed and verified while writing this plan — `"agf__ADM_Work__c"` → `"agf__"`, `"ADM_Work__c"` → `""`, `"ADM_Sprint__c"` → `""`, `"agf__ADM_Epic__c"` → `"agf__"`. It works because the *last* `__` always belongs to the `__c` suffix, so the namespace is present only when the remaining head still contains a `__`. If you rewrite it, keep those four cases as assertions.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/tasks/agileAccelerator/describe.test.ts`
Expected: PASS, 11 tests. If `prefixOf("ADM_Work__c")` returns `"ADM_"`, fix `prefixOf` — do not relax the test.

- [ ] **Step 5: Commit**

```bash
git add src/tasks/agileAccelerator/describe.ts test/unit/tasks/agileAccelerator/describe.test.ts
git commit -m "feat(agileAccelerator): discover namespace and available fields from a describe"
```

---

### Task 4: `soql.ts` — the query builder

**Files:**
- Create: `src/tasks/agileAccelerator/soql.ts`
- Test: `test/unit/tasks/agileAccelerator/soql.test.ts`

**Interfaces:**
- Consumes: `Schema`, `WANTED_FIELDS` (Task 3); `Filter` from `src/types.ts`.
- Produces:
  - `function soqlEscape(v: string): string`
  - `interface QueryOpts { team: string; meId: string; meName: string; max: number }`
  - `function buildListQuery(schema: Schema, lens: Filter, opts: QueryOpts): string`
  - `function buildDetailQuery(schema: Schema, key: string): string`
  - `function buildStatusQuery(schema: Schema, keys: readonly string[]): string`

`soqlEscape` is not optional: `team` comes from user settings and flows into a `WHERE` clause.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/tasks/agileAccelerator/soql.test.ts
import { describe, expect, it } from "vitest";
import { buildSchema } from "../../../../src/tasks/agileAccelerator/describe";
import {
  buildDetailQuery, buildListQuery, buildStatusQuery, soqlEscape,
} from "../../../../src/tasks/agileAccelerator/soql";

const full = buildSchema("agf__ADM_Work__c", {
  name: "agf__ADM_Work__c",
  fields: ["agf__Subject__c", "agf__Status__c", "agf__Assignee__c", "agf__Priority__c", "agf__Scrum_Team__c"]
    .map((name) => ({ name })),
});

const sparse = buildSchema("agf__ADM_Work__c", {
  name: "agf__ADM_Work__c",
  fields: [{ name: "agf__Subject__c" }],
});

const opts = { team: "Falcons", meId: "005000000000001", meName: "Ada L", max: 50 };

describe("soqlEscape", () => {
  it("escapes the quote that would end the literal", () => {
    expect(soqlEscape("O'Hara")).toBe("O\\'Hara");
  });

  it("escapes backslashes before quotes so the escape cannot be escaped away", () => {
    expect(soqlEscape("a\\b")).toBe("a\\\\b");
  });
});

describe("buildListQuery", () => {
  it("always selects Id and Name, since url and key depend on them", () => {
    const q = buildListQuery(full, "all", opts);
    expect(q).toContain("SELECT Id, Name");
  });

  it("selects the assignee's readable name via the __r relationship path", () => {
    // A `__c`-suffixed lookup selects an opaque id; the readable name lives on
    // the `__r` path. Getting this spelling wrong makes the whole query 400.
    expect(buildListQuery(full, "all", opts)).toContain("agf__Assignee__r.Name");
    expect(buildListQuery(full, "all", opts)).not.toContain("agf__Assignee__cr.Name");
  });

  it("bounds the query by team when the org has a team field", () => {
    expect(buildListQuery(full, "all", opts)).toContain("agf__Scrum_Team__r.Name = 'Falcons'");
  });

  it("drops the team clause rather than failing when the org has no team field", () => {
    const q = buildListQuery(sparse, "all", opts);
    expect(q).not.toContain("Scrum_Team");
    expect(q).toContain("LIMIT 50");
  });

  it("filters mine by the resolved user id", () => {
    expect(buildListQuery(full, "mine", opts)).toContain("agf__Assignee__c = '005000000000001'");
  });

  it("falls back to the display name when no id was resolvable", () => {
    const q = buildListQuery(full, "mine", { ...opts, meId: "" });
    expect(q).toContain("agf__Assignee__r.Name = 'Ada L'");
  });

  it("filters unassigned by a null assignee", () => {
    expect(buildListQuery(full, "unassigned", opts)).toContain("agf__Assignee__c = null");
  });

  it("omits an assignee clause entirely for the all lens", () => {
    expect(buildListQuery(full, "all", opts)).not.toContain("Assignee");
  });

  it("escapes a team name containing a quote", () => {
    expect(buildListQuery(full, "all", { ...opts, team: "O'Hara" })).toContain("'O\\'Hara'");
  });

  it("omits an absent field from the SELECT so the query cannot 400", () => {
    const q = buildListQuery(sparse, "all", opts);
    expect(q).toContain("agf__Subject__c");
    expect(q).not.toContain("agf__Priority__c");
  });

  it("caps and orders the result", () => {
    const q = buildListQuery(full, "all", { ...opts, max: 7 });
    expect(q).toContain("ORDER BY LastModifiedDate DESC");
    expect(q).toContain("LIMIT 7");
  });
});

describe("buildDetailQuery / buildStatusQuery", () => {
  it("looks a single work item up by its W- name", () => {
    expect(buildDetailQuery(full, "W-1234567")).toContain("Name = 'W-1234567'");
  });

  it("batches many keys into one IN clause, which is the whole point", () => {
    const q = buildStatusQuery(full, ["W-1", "W-2"]);
    expect(q).toContain("Name IN ('W-1','W-2')");
  });

  it("escapes keys in the IN clause too", () => {
    expect(buildStatusQuery(full, ["W-1'"])).toContain("'W-1\\''");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/tasks/agileAccelerator/soql.test.ts`
Expected: FAIL — cannot resolve `src/tasks/agileAccelerator/soql`.

- [ ] **Step 3: Write the implementation**

```ts
// src/tasks/agileAccelerator/soql.ts
// Pure, like jira/jql.ts, so the whole query surface is unit-testable without a
// process. Every field name here comes from the Schema, never from a literal —
// see describe.ts for why.
import type { Filter } from "../../types";
import { WANTED_FIELDS, type Schema } from "./describe";

const ORDER = "ORDER BY LastModifiedDate DESC";

/** Escape a value for a single-quoted SOQL string literal. `team` comes from
 *  user settings and both keys and names flow into WHERE clauses, so this is a
 *  correctness requirement, not a nicety. Backslashes first — otherwise the
 *  backslash this function adds to a quote gets escaped by its own second pass. */
export function soqlEscape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const lit = (v: string) => `'${soqlEscape(v)}'`;

export interface QueryOpts {
  team: string;
  meId: string;
  meName: string;
  max: number;
}

/** The related-record path for a `__c` lookup field: `agf__Assignee__c` becomes
 *  `agf__Assignee__r.Name`. One helper, used by the SELECT and both WHERE
 *  builders, so the three cannot disagree about the spelling. */
function relatedName(wireField: string): string {
  return `${wireField.replace(/__c$/, "__r")}.Name`;
}

/** Id and Name are standard and always exist; everything else is filtered
 *  through the schema so an absent field is simply not asked for. */
function selectList(schema: Schema): string {
  const optional = schema.selectable(WANTED_FIELDS);
  // Assignee is a lookup: select the readable name alongside the raw id.
  const extras = schema.has("Assignee__c") ? [relatedName(schema.field("Assignee__c"))] : [];
  return ["Id", "Name", "LastModifiedDate", ...optional, ...extras].join(", ");
}

/** The team lives on a lookup, so filter on its related Name rather than its id —
 *  the setting holds a human team name. Dropped entirely when the org has no
 *  team field, which yields a broader but still LIMIT-capped board instead of a
 *  failed query. */
function teamClause(schema: Schema, team: string): string | null {
  if (!schema.teamField || !team.trim()) return null;
  return `${relatedName(schema.teamField)} = ${lit(team.trim())}`;
}

function assigneeClause(schema: Schema, lens: Filter, opts: QueryOpts): string | null {
  if (!schema.has("Assignee__c")) return null;
  const f = schema.field("Assignee__c");
  if (lens === "unassigned") return `${f} = null`;
  if (lens !== "mine") return null;
  if (opts.meId) return `${f} = ${lit(opts.meId)}`;
  // No usable id: match on the readable name instead. The provider refuses to
  // run `mine` at all when neither is available, so this is never unfiltered.
  return opts.meName ? `${relatedName(f)} = ${lit(opts.meName)}` : null;
}

export function buildListQuery(schema: Schema, lens: Filter, opts: QueryOpts): string {
  const where = [teamClause(schema, opts.team), assigneeClause(schema, lens, opts)].filter(
    (c): c is string => c !== null,
  );
  const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  return `SELECT ${selectList(schema)} FROM ${schema.object}${clause} ${ORDER} LIMIT ${opts.max}`;
}

export function buildDetailQuery(schema: Schema, key: string): string {
  return `SELECT ${selectList(schema)} FROM ${schema.object} WHERE Name = ${lit(key)} LIMIT 1`;
}

/** One query for many keys — the reason `status()` can be polled per card
 *  without one process spawn per card. */
export function buildStatusQuery(schema: Schema, keys: readonly string[]): string {
  const inList = keys.map(lit).join(",");
  const status = schema.has("Status__c") ? `, ${schema.field("Status__c")}` : "";
  return `SELECT Id, Name${status} FROM ${schema.object} WHERE Name IN (${inList}) LIMIT ${keys.length}`;
}
```

**Implementer note:** `selectList`'s `extras` line builds the `__r.Name` relationship path from the `__c` lookup name. Write it as a small explicit helper if the `.replace` chain above reads badly — the test only requires that the query contain `agf__Assignee__r.Name` when the field exists. Prefer clarity; this is the one line in the module where a clever expression is worse than four plain ones.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/tasks/agileAccelerator/soql.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tasks/agileAccelerator/soql.ts test/unit/tasks/agileAccelerator/soql.test.ts
git commit -m "feat(agileAccelerator): schema-driven SOQL builder with literal escaping"
```

---

### Task 5: `shape.ts` — records into seam types

**Files:**
- Create: `src/tasks/agileAccelerator/shape.ts`
- Test: `test/unit/tasks/agileAccelerator/shape.test.ts`

**Interfaces:**
- Consumes: `Schema` (Task 3); `Task` from `src/types.ts`; `TaskDetail` from `src/tasks/provider.ts`.
- Produces:
  - `type SfRecord = Record<string, unknown>`
  - `function statusCategoryOf(status: string): "new" | "indeterminate" | "done"`
  - `function recordUrl(instanceUrl: string, id: string): string`
  - `function toTask(rec: SfRecord, schema: Schema, instanceUrl: string): Task`
  - `function toDetail(rec: SfRecord, schema: Schema, instanceUrl: string): TaskDetail`
  - `function idOf(rec: SfRecord): string`, `function keyOf(rec: SfRecord): string`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/tasks/agileAccelerator/shape.test.ts
import { describe, expect, it } from "vitest";
import { buildSchema } from "../../../../src/tasks/agileAccelerator/describe";
import { recordUrl, statusCategoryOf, toDetail, toTask } from "../../../../src/tasks/agileAccelerator/shape";

const schema = buildSchema("agf__ADM_Work__c", {
  name: "agf__ADM_Work__c",
  fields: ["agf__Subject__c", "agf__Status__c", "agf__Assignee__c", "agf__Priority__c"].map((name) => ({ name })),
});

const rec = {
  Id: "a0700000000001AAA",
  Name: "W-1234567",
  LastModifiedDate: "2026-08-01T10:00:00.000+0000",
  agf__Subject__c: "Board does not paint",
  agf__Status__c: "In Progress",
  agf__Priority__c: "P2",
  agf__Assignee__r: { Name: "Ada L" },
};

describe("statusCategoryOf", () => {
  it("treats the closed set git2gus itself uses as done", () => {
    for (const s of ["Fixed", "Closed", "Integrate"]) expect(statusCategoryOf(s)).toBe("done");
  });

  it("treats the intake statuses as new", () => {
    expect(statusCategoryOf("New")).toBe("new");
    expect(statusCategoryOf("Triaged")).toBe("new");
  });

  it("matches case-insensitively, since picklist casing varies by org", () => {
    expect(statusCategoryOf("FIXED")).toBe("done");
    expect(statusCategoryOf("fixed")).toBe("done");
  });

  it("maps an UNKNOWN status to indeterminate, never done", () => {
    // Only "done" retires a run. A wrong "done" silently retires live work,
    // so the conservative default is the whole point of this test.
    expect(statusCategoryOf("Bikeshedding")).toBe("indeterminate");
    expect(statusCategoryOf("")).toBe("indeterminate");
  });
});

describe("recordUrl", () => {
  it("builds a Lightning record url from the 18-char id", () => {
    expect(recordUrl("https://gus.lightning.force.com", "a0700000000001AAA")).toBe(
      "https://gus.lightning.force.com/lightning/r/ADM_Work__c/a0700000000001AAA/view",
    );
  });

  it("tolerates a trailing slash on the configured instance url", () => {
    expect(recordUrl("https://x.lightning.force.com/", "a07")).toBe(
      "https://x.lightning.force.com/lightning/r/ADM_Work__c/a07/view",
    );
  });
});

describe("toTask", () => {
  it("uses the W- name as the key and the record url as the url", () => {
    const t = toTask(rec, schema, "https://gus.lightning.force.com");
    expect(t.key).toBe("W-1234567");
    expect(t.url).toContain("/lightning/r/ADM_Work__c/a0700000000001AAA/view");
  });

  it("carries summary, status, priority and assignee across", () => {
    const t = toTask(rec, schema, "https://x");
    expect(t.summary).toBe("Board does not paint");
    expect(t.status).toBe("In Progress");
    expect(t.statusCategory).toBe("indeterminate");
    expect(t.priority).toBe("P2");
    expect(t.assignee).toBe("Ada L");
  });

  it("reports an unassigned record as Unassigned rather than empty", () => {
    const t = toTask({ ...rec, agf__Assignee__r: null }, schema, "https://x");
    expect(t.assignee).toBe("Unassigned");
  });

  it("reports no estimate and no sprint, because this source declares neither", () => {
    const t = toTask(rec, schema, "https://x");
    expect(t.estimateSeconds).toBeNull();
    expect(t.sprint).toBeNull();
    expect(t.inOpenSprint).toBe(false);
  });

  it("survives a record whose optional fields were never selected", () => {
    const bare = buildSchema("agf__ADM_Work__c", { name: "agf__ADM_Work__c", fields: [] });
    const t = toTask({ Id: "a07", Name: "W-9" }, bare, "https://x");
    expect(t.summary).toBe("");
    expect(t.status).toBe("");
    expect(t.statusCategory).toBe("indeterminate");
    expect(t.priority).toBe("");
    expect(t.assignee).toBe("Unassigned");
  });

  it("normalizes the Salesforce timestamp to an ISO string", () => {
    expect(toTask(rec, schema, "https://x").updated).toBe("2026-08-01T10:00:00.000Z");
  });
});

describe("toDetail", () => {
  it("produces the detail shape with empty labels and components", () => {
    const d = toDetail(rec, schema, "https://x");
    expect(d.key).toBe("W-1234567");
    expect(d.summary).toBe("Board does not paint");
    expect(d.labels).toEqual([]);
    expect(d.components).toEqual([]);
    expect(d.statusCategory).toBe("indeterminate");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/tasks/agileAccelerator/shape.test.ts`
Expected: FAIL — cannot resolve `src/tasks/agileAccelerator/shape`.

- [ ] **Step 3: Write the implementation**

```ts
// src/tasks/agileAccelerator/shape.ts
// Pure. Salesforce records in, seam types out.
import type { Task } from "../../types";
import type { TaskDetail } from "../provider";
import type { Schema } from "./describe";

export type SfRecord = Record<string, unknown>;

/** The object name in a Lightning record url is always unprefixed, even in an
 *  org where the object itself is namespaced. */
const URL_OBJECT = "ADM_Work__c";

/** Statuses that mean the work is over. Seeded from the closed set
 *  forcedotcom/git2gus itself uses (INTEGRATE, FIXED, CLOSED) plus the other
 *  terminal picklist values, and compared case-insensitively because picklist
 *  casing varies between orgs. */
const DONE = new Set(
  ["integrate", "fixed", "closed", "duplicate", "never going to happen", "not a bug", "not reproducible"],
);

/** Statuses that mean nobody has started. */
const NEW = new Set(["new", "triaged", "acknowledged", "more info reqd", "waiting", "backlog"]);

/** Total over an open-ended picklist. An UNRECOGNIZED status is `indeterminate`,
 *  never `done`: only `done` drives run retirement, so a wrong `done` would
 *  silently retire live work. Same reasoning as `StatusTarget.toCategory`'s
 *  `""` member in ../provider.ts. */
export function statusCategoryOf(status: string): "new" | "indeterminate" | "done" {
  const s = status.trim().toLowerCase();
  if (DONE.has(s)) return "done";
  if (NEW.has(s)) return "new";
  return "indeterminate";
}

export function recordUrl(instanceUrl: string, id: string): string {
  return `${instanceUrl.replace(/\/+$/, "")}/lightning/r/${URL_OBJECT}/${id}/view`;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function idOf(rec: SfRecord): string {
  return str(rec.Id);
}

export function keyOf(rec: SfRecord): string {
  return str(rec.Name);
}

/** Read a related record's Name, e.g. `agf__Assignee__r.Name`. */
function relatedName(rec: SfRecord, lookupField: string): string {
  const rel = rec[lookupField.replace(/__c$/, "__r")];
  if (!rel || typeof rel !== "object") return "";
  return str((rel as SfRecord).Name);
}

function readStatus(rec: SfRecord, schema: Schema): string {
  return schema.has("Status__c") ? str(rec[schema.field("Status__c")]) : "";
}

/** Salesforce stamps `+0000`; Task.updated is specified as ISO. An unparseable
 *  value becomes an empty string rather than "Invalid Date". */
function isoOf(v: unknown): string {
  const raw = str(v);
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export function toTask(rec: SfRecord, schema: Schema, instanceUrl: string): Task {
  const status = readStatus(rec, schema);
  const assignee = schema.has("Assignee__c") ? relatedName(rec, schema.field("Assignee__c")) : "";
  return {
    key: keyOf(rec),
    summary: schema.has("Subject__c") ? str(rec[schema.field("Subject__c")]) : "",
    status,
    statusCategory: statusCategoryOf(status),
    priority: schema.has("Priority__c") ? str(rec[schema.field("Priority__c")]) : "",
    assignee: assignee || "Unassigned",
    labels: [],
    components: [],
    // This source declares neither caps.sprints nor caps.sizes, so these are the
    // only honest values. `inOpenSprint` is a required boolean with no "no sprint
    // concept" member; every reader gates on caps.sprints first.
    sprint: null,
    inOpenSprint: false,
    updated: isoOf(rec.LastModifiedDate),
    url: recordUrl(instanceUrl, idOf(rec)),
    estimateSeconds: null,
  };
}

export function toDetail(rec: SfRecord, schema: Schema, instanceUrl: string): TaskDetail {
  const status = readStatus(rec, schema);
  return {
    key: keyOf(rec),
    summary: schema.has("Subject__c") ? str(rec[schema.field("Subject__c")]) : "",
    descriptionText: "",
    labels: [],
    components: [],
    url: recordUrl(instanceUrl, idOf(rec)),
    status: status || null,
    statusCategory: statusCategoryOf(status),
  };
}
```

**Note:** `descriptionText` is `""` because no description field name is verified. Adding one is a v2 change gated on a real describe — do not guess a field name here.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/tasks/agileAccelerator/shape.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tasks/agileAccelerator/shape.ts test/unit/tasks/agileAccelerator/shape.test.ts
git commit -m "feat(agileAccelerator): map work item records onto seam types"
```

---

### Task 6: `provider.ts` — the read-only `TaskProvider`

**Files:**
- Create: `src/tasks/agileAccelerator/provider.ts`
- Test: `test/unit/tasks/agileAccelerator/provider.test.ts`

**Interfaces:**
- Consumes: `SfCli` (Task 2); `Schema` (Task 3); `buildListQuery`/`buildDetailQuery` (Task 4); `toTask`/`toDetail`/`idOf`/`keyOf` (Task 5); `Capabilities`, `StatusTarget`, `TaskProvider`, `TaskWriteError` from `src/tasks/provider.ts`.
- Produces:
  - `interface ProviderDeps { cli: SfCli; schema(): Promise<Schema>; identity(): Promise<{ id: string; displayName: string } | null>; statusOf(key: string): Promise<{ status: string | null; category: string | null }>; rememberIds(pairs: readonly [string, string][]): void; team: string; instanceUrl: string }`
  - `class AgileAcceleratorProvider implements TaskProvider`

Dependencies are injected rather than constructed so the connector's session-lived caches (describe, identity, key→Id memo, status memo) reach a provider that is rebuilt per operation by contract.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/tasks/agileAccelerator/provider.test.ts
import { describe, expect, it, vi } from "vitest";
import { buildSchema } from "../../../../src/tasks/agileAccelerator/describe";
import { AgileAcceleratorProvider, ProviderDeps } from "../../../../src/tasks/agileAccelerator/provider";
import { TaskWriteError } from "../../../../src/tasks/provider";

const schema = buildSchema("agf__ADM_Work__c", {
  name: "agf__ADM_Work__c",
  fields: ["agf__Subject__c", "agf__Status__c", "agf__Assignee__c"].map((name) => ({ name })),
});

const REC = {
  Id: "a0700000000001AAA",
  Name: "W-1",
  LastModifiedDate: "2026-08-01T10:00:00.000+0000",
  agf__Subject__c: "A thing",
  agf__Status__c: "New",
};

function deps(over: Partial<ProviderDeps> = {}) {
  const query = vi.fn(async () => [REC]);
  const base: ProviderDeps = {
    cli: { query } as unknown as ProviderDeps["cli"],
    schema: async () => schema,
    identity: async () => ({ id: "005", displayName: "Ada L" }),
    statusOf: async () => ({ status: "New", category: "new" }),
    rememberIds: vi.fn(),
    team: "Falcons",
    instanceUrl: "https://gus.lightning.force.com",
    ...over,
  };
  return { deps: base, query };
}

describe("caps", () => {
  it("declares three lenses and no optional capability", () => {
    const { deps: d } = deps();
    const caps = new AgileAcceleratorProvider(d).caps;
    expect([...caps.supportedFilters]).toEqual(["mine", "unassigned", "all"]);
    expect(caps.sizes).toBe(false);
    expect(caps.labels).toBeUndefined();
    expect(caps.sprints).toBeUndefined();
    expect(caps.components).toBeUndefined();
    expect(caps.children).toBeUndefined();
  });

  it("has no refreshCaps, because its capabilities are static", () => {
    const { deps: d } = deps();
    expect(new AgileAcceleratorProvider(d).refreshCaps).toBeUndefined();
  });
});

describe("list", () => {
  it("returns mapped tasks", async () => {
    const { deps: d } = deps();
    const tasks = await new AgileAcceleratorProvider(d).list("all", "any");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].key).toBe("W-1");
    expect(tasks[0].url).toContain("/lightning/r/ADM_Work__c/a0700000000001AAA/view");
  });

  it("memoizes key to id so taskUrl can answer later", async () => {
    const { deps: d } = deps();
    await new AgileAcceleratorProvider(d).list("all", "any");
    expect(d.rememberIds).toHaveBeenCalledWith([["W-1", "a0700000000001AAA"]]);
  });

  it("refuses the mine lens with no resolvable identity rather than showing everything", async () => {
    const { deps: d, query } = deps({ identity: async () => null });
    expect(await new AgileAcceleratorProvider(d).list("mine", "any")).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("honours the max argument", async () => {
    const { deps: d, query } = deps();
    await new AgileAcceleratorProvider(d).list("all", "any", 7);
    expect(query.mock.calls[0][0]).toContain("LIMIT 7");
  });
});

describe("detail", () => {
  it("returns the detail shape for a key", async () => {
    const { deps: d } = deps();
    const detail = await new AgileAcceleratorProvider(d).detail("W-1");
    expect(detail.key).toBe("W-1");
    expect(detail.summary).toBe("A thing");
  });

  it("throws for a key the source cannot resolve, since it is a foreground action", async () => {
    const { deps: d } = deps({ cli: { query: async () => [] } as unknown as ProviderDeps["cli"] });
    await expect(new AgileAcceleratorProvider(d).detail("W-404")).rejects.toThrow(/W-404/);
  });
});

describe("the read-only surface", () => {
  it("offers no status transitions, which the seam treats as fully supported", async () => {
    const { deps: d } = deps();
    expect(await new AgileAcceleratorProvider(d).statusTargets("W-1")).toEqual([]);
  });

  it("refuses moveTo with an empty retryWith, so no retry is offered", async () => {
    const { deps: d } = deps();
    await expect(new AgileAcceleratorProvider(d).moveTo("W-1", "x", {})).rejects.toBeInstanceOf(TaskWriteError);
    await new AgileAcceleratorProvider(d).moveTo("W-1", "x", {}).catch((e: TaskWriteError) => {
      expect(e.retryWith).toEqual([]);
    });
  });

  it("accepts assignToMe and does nothing, as the seam requires", async () => {
    const { deps: d, query } = deps();
    await expect(new AgileAcceleratorProvider(d).assignToMe("W-1")).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("delegates status to the connector's batched memo", async () => {
    const statusOf = vi.fn(async () => ({ status: "Fixed", category: "done" }));
    const { deps: d } = deps({ statusOf });
    expect(await new AgileAcceleratorProvider(d).status("W-1")).toEqual({ status: "Fixed", category: "done" });
    expect(statusOf).toHaveBeenCalledWith("W-1");
  });

  it("returns the resolved identity", async () => {
    const { deps: d } = deps();
    expect(await new AgileAcceleratorProvider(d).me()).toEqual({ id: "005", displayName: "Ada L" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/tasks/agileAccelerator/provider.test.ts`
Expected: FAIL — cannot resolve `src/tasks/agileAccelerator/provider`.

- [ ] **Step 3: Write the implementation**

```ts
// src/tasks/agileAccelerator/provider.ts
import type { Filter, Size, Task } from "../../types";
import {
  Capabilities, StatusTarget, TaskDetail, TaskProvider, TaskWriteError,
} from "../provider";
import type { SfCli } from "./cli";
import type { Schema } from "./describe";
import { buildDetailQuery, buildListQuery } from "./soql";
import { idOf, keyOf, toDetail, toTask, type SfRecord } from "./shape";

/** Injected rather than constructed here: the connector owns the session-lived
 *  describe cache, identity cache, key→Id memo and batched status memo, and a
 *  provider is rebuilt per operation by contract — so anything cached inside a
 *  provider would never be read twice. */
export interface ProviderDeps {
  cli: SfCli;
  schema(): Promise<Schema>;
  identity(): Promise<{ id: string; displayName: string } | null>;
  statusOf(key: string): Promise<{ status: string | null; category: string | null }>;
  rememberIds(pairs: readonly [string, string][]): void;
  team: string;
  instanceUrl: string;
}

export class AgileAcceleratorProvider implements TaskProvider {
  constructor(private readonly deps: ProviderDeps) {}

  /** Static, so `refreshCaps` is deliberately NOT implemented — CONNECTORS.md
   *  requires omitting it rather than shipping a no-op. Optional members are
   *  absent, not false: this source has no labels, sprints, components or
   *  children, and v1 has no writes. */
  readonly caps: Capabilities = {
    supportedFilters: ["mine", "unassigned", "all"],
    sizes: false,
  };

  async list(lens: Filter, _size: Size, max = 50): Promise<Task[]> {
    const me = lens === "mine" ? await this.deps.identity() : null;
    // Without an identity there is no honest "mine". Returning everything would
    // silently show the whole team's board under a tab labelled Mine.
    if (lens === "mine" && !me) return [];

    const schema = await this.deps.schema();
    const soql = buildListQuery(schema, lens, {
      team: this.deps.team,
      meId: me?.id ?? "",
      meName: me?.displayName ?? "",
      max,
    });

    const records = await this.deps.cli.query<SfRecord>(soql);
    this.deps.rememberIds(records.map((r) => [keyOf(r), idOf(r)] as [string, string]));
    return records.map((r) => toTask(r, schema, this.deps.instanceUrl));
  }

  async detail(key: string): Promise<TaskDetail> {
    const schema = await this.deps.schema();
    const [rec] = await this.deps.cli.query<SfRecord>(buildDetailQuery(schema, key));
    // Throwing is right here: the user just opened this card, and the host turns
    // a thrown seam error into a toast. `status()` is the one that must not throw.
    if (!rec) throw new Error(`Couldn't find ${key} in Agile Accelerator.`);
    this.deps.rememberIds([[keyOf(rec), idOf(rec)]]);
    return toDetail(rec, schema, this.deps.instanceUrl);
  }

  /** Delegated to the connector, which batches many keys into one query. */
  status(key: string): Promise<{ status: string | null; category: string | null }> {
    return this.deps.statusOf(key);
  }

  /** Read-only: nowhere to go. The seam treats an empty array as a fully
   *  supported answer — `changeStatus` shows an info toast, not an error. */
  async statusTargets(_key: string): Promise<StatusTarget[]> {
    return [];
  }

  async moveTo(): Promise<void> {
    throw new TaskWriteError("Agile Accelerator is read-only in this version of Agent Flow.", []);
  }

  /** Accepted and ignored, exactly as the fixture connector does. There is no
   *  capability flag to opt out of this one. */
  async assignToMe(): Promise<void> {
    /* accepted */
  }

  me(): Promise<{ id: string; displayName: string } | null> {
    return this.deps.identity();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/tasks/agileAccelerator/provider.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tasks/agileAccelerator/provider.ts test/unit/tasks/agileAccelerator/provider.test.ts
git commit -m "feat(agileAccelerator): read-only TaskProvider over the sf CLI"
```

---

### Task 7: `connector.ts` — lifecycle, caches, settings

**Files:**
- Create: `src/tasks/agileAccelerator/connector.ts`
- Test: `test/unit/tasks/agileAccelerator/connector.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6; `getConfig` from `src/config.ts` (fields added in Task 8 — see the note below); `AuthProbe`/`ProjectProbe` types from `src/engine/doctor.ts`; `vscode`.
- Produces: `function makeAgileAcceleratorConnector(ctx: vscode.ExtensionContext): TaskConnector`

**Ordering note:** this task reads `getConfig().agileAcceleratorInstanceUrl` and siblings, which Task 8 adds to `AgentFlowConfig`. Add those three config fields **at the start of this task** (the three-line `AgentFlowConfig` addition plus the three `getConfig()` lines only) so this task compiles and its tests run; Task 8 then does the manifest, registry and docs wiring. Do not touch `config.ts:628-629`.

- [ ] **Step 1: Add the three config fields**

In `src/config.ts`, add to the `AgentFlowConfig` interface, near `taskSource`:

```ts
  /** Agile Accelerator's own settings. Named in full rather than as `baseUrl`/
   * `project` because those two are Jira's — see docs/CONNECTORS.md §7. */
  agileAcceleratorInstanceUrl: string;
  agileAcceleratorTeam: string;
  agileAcceleratorTargetOrg: string;
```

and to `getConfig()`'s returned object, alongside the existing Jira lines (**do not modify them**):

```ts
    agileAcceleratorInstanceUrl: (c.get<string>("agileAccelerator.instanceUrl") || "").replace(/\/+$/, ""),
    agileAcceleratorTeam: c.get<string>("agileAccelerator.team") || "",
    agileAcceleratorTargetOrg: c.get<string>("agileAccelerator.targetOrg") || "",
```

- [ ] **Step 2: Write the failing test**

```ts
// test/unit/tasks/agileAccelerator/connector.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeAgileAcceleratorConnector } from "../../../../src/tasks/agileAccelerator/connector";
import { window } from "../../../_mocks/vscode";

let cfg = {
  agileAcceleratorInstanceUrl: "https://gus.lightning.force.com",
  agileAcceleratorTeam: "Falcons",
  agileAcceleratorTargetOrg: "",
};
vi.mock("../../../../src/config", () => ({ getConfig: () => cfg }));

const ctx = { secrets: { get: async () => undefined } } as never;

beforeEach(() => {
  cfg = {
    agileAcceleratorInstanceUrl: "https://gus.lightning.force.com",
    agileAcceleratorTeam: "Falcons",
    agileAcceleratorTargetOrg: "",
  };
});

describe("identity and info", () => {
  it("uses the frozen id", () => {
    expect(makeAgileAcceleratorConnector(ctx).id).toBe("agileAccelerator");
  });

  it("describes itself with a team scope and a W- example key", () => {
    const info = makeAgileAcceleratorConnector(ctx).info();
    expect(info.label).toBe("Agile Accelerator");
    expect(info.scopeNoun).toBe("team");
    expect(info.scopeValue).toBe("Falcons");
    expect(info.endpoint).toBe("https://gus.lightning.force.com");
    expect(info.exampleKey).toMatch(/^W-\d+$/);
    expect(info.endpointSetting).toBe("agentFlow.agileAccelerator.instanceUrl");
    expect(info.scopeSetting).toBe("agentFlow.agileAccelerator.team");
  });
});

describe("isConfigured", () => {
  it("is true when both required settings are filled in", () => {
    expect(makeAgileAcceleratorConnector(ctx).isConfigured()).toBe(true);
  });

  it("treats a whitespace-only setting as unconfigured", () => {
    cfg = { ...cfg, agileAcceleratorTeam: "   " };
    expect(makeAgileAcceleratorConnector(ctx).isConfigured()).toBe(false);
  });

  it("does not require the optional target org", () => {
    cfg = { ...cfg, agileAcceleratorTargetOrg: "" };
    expect(makeAgileAcceleratorConnector(ctx).isConfigured()).toBe(true);
  });
});

describe("urls", () => {
  it("returns the instance root for a key it has never seen", () => {
    // Deliberately dull: a guessed deep-link shape that 404s is worse than a
    // landing page, and no search-url shape is verified.
    expect(makeAgileAcceleratorConnector(ctx).taskUrl("W-1")).toBe("https://gus.lightning.force.com");
  });

  it("recovers a key from a url that carries a W- token", () => {
    const c = makeAgileAcceleratorConnector(ctx);
    expect(c.keyFromUrl("https://x/lightning/r/ADM_Work__c/W-42/view")).toBe("W-42");
  });

  it("returns null for our own id-shaped url, rather than guessing a key", () => {
    const c = makeAgileAcceleratorConnector(ctx);
    expect(c.keyFromUrl("https://x/lightning/r/ADM_Work__c/a0700000000001AAA/view")).toBeNull();
  });

  it("returns null for another source's url", () => {
    const c = makeAgileAcceleratorConnector(ctx);
    expect(c.keyFromUrl("https://x.atlassian.net/browse/ABC-1")).toBeNull();
  });
});

describe("the setup wizard", () => {
  it("collects three steps and writes nothing until the thunk runs", async () => {
    vi.mocked(window.showInputBox)
      .mockResolvedValueOnce("https://gus.lightning.force.com")
      .mockResolvedValueOnce("Falcons")
      .mockResolvedValueOnce("");
    const c = makeAgileAcceleratorConnector(ctx);
    expect(c.setupSteps).toBe(3);
    const commit = await c.configure(1, 4);
    expect(typeof commit).toBe("function");
  });

  it("returns null when the user cancels a step, so setup aborts cleanly", async () => {
    vi.mocked(window.showInputBox).mockResolvedValueOnce(undefined);
    expect(await makeAgileAcceleratorConnector(ctx).configure(1, 4)).toBeNull();
  });
});

describe("signOut", () => {
  it("does not log the user out of an org their other tooling depends on", async () => {
    // The connector owns no credential; sign-out is advisory only.
    await expect(makeAgileAcceleratorConnector(ctx).signOut()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/unit/tasks/agileAccelerator/connector.test.ts`
Expected: FAIL — cannot resolve `src/tasks/agileAccelerator/connector`.

- [ ] **Step 4: Write the implementation**

```ts
// src/tasks/agileAccelerator/connector.ts
import * as vscode from "vscode";
import { getConfig } from "../../config";
import type { AuthProbe, ProjectProbe } from "../../engine/doctor";
import { SourceInfo, TaskConnector, TaskProvider } from "../provider";
import { SfCli, SfMissingError } from "./cli";
import { buildSchema, WORK_OBJECT_CANDIDATES, type Schema } from "./describe";
import { AgileAcceleratorProvider } from "./provider";
import { buildStatusQuery } from "./soql";
import { keyOf, statusCategoryOf, type SfRecord } from "./shape";

/** Frozen on release. Renaming either strands every configured install. */
const ENDPOINT_SETTING = "agentFlow.agileAccelerator.instanceUrl";
const SCOPE_SETTING = "agentFlow.agileAccelerator.team";
const TARGET_ORG_SETTING = "agentFlow.agileAccelerator.targetOrg";

/** How long a status readback stays fresh. The Deck polls `status()` per run
 *  card; without this each card would cost its own process spawn. */
const STATUS_TTL_MS = 30_000;

const SF_INSTALL_URL = "https://developer.salesforce.com/tools/salesforcecli";

class AgileAcceleratorConnector implements TaskConnector {
  readonly id = "agileAccelerator";
  readonly setupSteps = 3;

  /** Session-lived caches. They live here, not on a provider: `provider()` is
   *  rebuilt per operation by contract. */
  private schemaCache: Promise<Schema> | null = null;
  private identityCache: Promise<{ id: string; displayName: string } | null> | null = null;
  private readonly ids = new Map<string, string>();
  private readonly statuses = new Map<string, { at: number; status: string | null; category: string | null }>();

  private cli(): SfCli {
    return new SfCli(getConfig().agileAcceleratorTargetOrg.trim());
  }

  info(): SourceInfo {
    const cfg = getConfig();
    return {
      label: "Agile Accelerator",
      scopeNoun: "team",
      scopeValue: cfg.agileAcceleratorTeam,
      endpoint: cfg.agileAcceleratorInstanceUrl,
      exampleKey: "W-1234567",
      endpointSetting: ENDPOINT_SETTING,
      scopeSetting: SCOPE_SETTING,
    };
  }

  isConfigured(): boolean {
    const cfg = getConfig();
    return !!cfg.agileAcceleratorInstanceUrl.trim() && !!cfg.agileAcceleratorTeam.trim();
  }

  /** Collect only. The returned thunk performs the writes, so an Esc at a later
   *  wizard step leaves an already-configured user's settings untouched. */
  async configure(from: number, total: number): Promise<(() => Promise<void>) | null> {
    const instanceUrl = await vscode.window.showInputBox({
      title: `Agent Flow Deck Setup (${from}/${total})`,
      prompt: "Your Salesforce Lightning URL (GUS, or the org with Agile Accelerator installed)",
      ignoreFocusOut: true,
      placeHolder: "https://your-org.lightning.force.com",
      validateInput: (v) => {
        const t = v.trim();
        if (!t) return "Enter your Lightning URL";
        try {
          return new URL(t).protocol === "https:" ? undefined : "URL must start with https://";
        } catch {
          return "Enter a valid URL (e.g. https://your-org.lightning.force.com)";
        }
      },
    });
    if (instanceUrl === undefined) return null;

    const team = await vscode.window.showInputBox({
      title: `Agent Flow Deck Setup (${from + 1}/${total})`,
      prompt: "Your scrum team's name, exactly as it appears in Agile Accelerator",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : "Enter your team name"),
    });
    if (team === undefined) return null;

    const targetOrg = await vscode.window.showInputBox({
      title: `Agent Flow Deck Setup (${from + 2}/${total})`,
      prompt: "Salesforce CLI org alias (optional — leave blank to use your default org)",
      ignoreFocusOut: true,
      placeHolder: "gus",
    });
    if (targetOrg === undefined) return null;

    return async () => {
      const c = vscode.workspace.getConfiguration();
      const g = vscode.ConfigurationTarget.Global;
      await c.update(ENDPOINT_SETTING, instanceUrl.trim().replace(/\/+$/, ""), g);
      await c.update(SCOPE_SETTING, team.trim(), g);
      await c.update(TARGET_ORG_SETTING, targetOrg.trim(), g);
    };
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.identity()) !== null;
  }

  /** The extension cannot own this flow — `sf` owns the browser round-trip and
   *  the token. Naming the command is the whole of the help we can give. */
  async signIn(): Promise<boolean> {
    void vscode.window.showInformationMessage(
      "Sign in with the Salesforce CLI: run `sf org login web` in a terminal, then refresh the Deck.",
    );
    return false;
  }

  /** Advisory only. This connector stores no credential, and `sf logout` would
   *  sign the user out of an org their other tooling may depend on. */
  async signOut(): Promise<void> {
    void vscode.window.showInformationMessage(
      "Agent Flow stores no Salesforce credentials. To sign out, run `sf org logout`.",
    );
    this.identityCache = null;
    this.schemaCache = null;
  }

  provider(): TaskProvider {
    const cfg = getConfig();
    const cli = this.cli();
    return new AgileAcceleratorProvider({
      cli,
      schema: () => this.schema(cli),
      identity: () => this.identity(),
      statusOf: (key) => this.statusOf(cli, key),
      rememberIds: (pairs) => {
        for (const [key, id] of pairs) if (key && id) this.ids.set(key, id);
      },
      team: cfg.agileAcceleratorTeam,
      instanceUrl: cfg.agileAcceleratorInstanceUrl,
    });
  }

  async probe(): Promise<{ auth?: AuthProbe; scope?: ProjectProbe }> {
    const cli = this.cli();
    if (!cli.installed()) {
      return {
        auth: { ok: false, reason: "auth", message: `The Salesforce CLI (sf) was not found. Install it: ${SF_INSTALL_URL}` },
      };
    }

    let auth: AuthProbe;
    try {
      const me = await this.identity();
      auth = me
        ? { ok: true, displayName: me.displayName }
        : { ok: false, reason: "auth", message: "Run `sf org login web` to sign in." };
    } catch (e) {
      auth = { ok: false, reason: "network", message: e instanceof Error ? e.message : String(e) };
    }
    if (!auth.ok) return { auth };

    let scope: ProjectProbe;
    try {
      const schema = await this.schema(cli);
      scope = schema.teamField
        ? { ok: true, name: getConfig().agileAcceleratorTeam }
        : { ok: false, reason: "not-found", message: `No team field found on ${schema.object}.` };
    } catch (e) {
      scope = { ok: false, reason: "error", message: e instanceof Error ? e.message : String(e) };
    }
    return { auth, scope };
  }

  /** Synchronous, so it cannot look an Id up. On a memo miss it returns the
   *  instance root — see the spec: a guessed deep-link shape that 404s is worse
   *  than an honest landing page. */
  taskUrl(key: string): string {
    const base = getConfig().agileAcceleratorInstanceUrl.replace(/\/+$/, "");
    const id = this.ids.get(key);
    return id ? `${base}/lightning/r/ADM_Work__c/${id}/view` : base;
  }

  /** Our own persisted urls carry an Id, not a key, so this returns null far more
   *  often than Jira's does. A wrong non-null answer would point a user at
   *  someone else's work item. */
  keyFromUrl(url: string): string | null {
    if (typeof url !== "string") return null;
    const m = /\bW-\d+\b/.exec(url);
    return m ? m[0] : null;
  }

  // ── caches ────────────────────────────────────────────────────────────────

  private identity(): Promise<{ id: string; displayName: string } | null> {
    this.identityCache ??= this.cli()
      .userInfo()
      .then((u) => (u.username ? { id: u.id, displayName: u.username } : null))
      .catch(() => null);
    return this.identityCache;
  }

  /** One describe per session. Tries the packaged object, then the bare one GUS
   *  uses. A failure clears the cache so a later call can retry. */
  private schema(cli: SfCli): Promise<Schema> {
    this.schemaCache ??= (async () => {
      let last: unknown;
      for (const object of WORK_OBJECT_CANDIDATES) {
        try {
          return buildSchema(object, await cli.describe(object));
        } catch (e) {
          last = e;
        }
      }
      throw last instanceof Error ? last : new Error("Could not describe the work item object.");
    })().catch((e: unknown) => {
      this.schemaCache = null;
      throw e;
    });
    return this.schemaCache;
  }

  /** Batched, TTL'd status readback. A miss fetches the missing key together
   *  with every other key already known, so a Deck full of cards costs one
   *  query rather than one per card. Never throws. */
  private async statusOf(
    cli: SfCli,
    key: string,
  ): Promise<{ status: string | null; category: string | null }> {
    const now = Date.now();
    const hit = this.statuses.get(key);
    if (hit && now - hit.at < STATUS_TTL_MS) return { status: hit.status, category: hit.category };

    const stale = [...this.statuses.entries()].filter(([, v]) => now - v.at >= STATUS_TTL_MS).map(([k]) => k);
    const keys = [...new Set([key, ...stale])];

    try {
      const schema = await this.schema(cli);
      const records = await cli.query<SfRecord>(buildStatusQuery(schema, keys));
      const seen = new Set<string>();
      for (const rec of records) {
        const k = keyOf(rec);
        if (!k) continue;
        const status = schema.has("Status__c") ? String(rec[schema.field("Status__c")] ?? "") : "";
        this.statuses.set(k, { at: now, status: status || null, category: status ? statusCategoryOf(status) : null });
        seen.add(k);
      }
      // Keys the org did not return are cached as unknown, so a deleted record
      // does not re-query on every poll.
      for (const k of keys) if (!seen.has(k)) this.statuses.set(k, { at: now, status: null, category: null });
    } catch {
      // A background poll behind an already-rendered card: unknown is a better
      // answer than a thrown error.
      return { status: null, category: null };
    }

    const out = this.statuses.get(key);
    return { status: out?.status ?? null, category: out?.category ?? null };
  }
}

export function makeAgileAcceleratorConnector(_ctx: vscode.ExtensionContext): TaskConnector {
  // `_ctx` is unused — this connector stores no secrets. The parameter exists to
  // match the registry's factory signature.
  return new AgileAcceleratorConnector();
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/unit/tasks/agileAccelerator/connector.test.ts`
Expected: PASS, 12 tests. Also run `npx tsc --noEmit` — the config fields from Step 1 must satisfy it.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/tasks/agileAccelerator/connector.ts test/unit/tasks/agileAccelerator/connector.test.ts
git commit -m "feat(agileAccelerator): connector lifecycle, caches, and setup wizard"
```

---

### Task 8: Wire it up — registry, manifest, docs

**Files:**
- Modify: `src/tasks/registry.ts`
- Modify: `package.json` (`contributes.configuration.properties`)
- Modify: `docs/CONNECTORS.md`
- Test: existing `test/unit/tasks/registry.test.ts`, `test/unit/telemetry/settingsSnapshot.test.ts`, `test/unit/docs.test.ts` (all unmodified — they must go green on their own)

**Interfaces:**
- Consumes: `makeAgileAcceleratorConnector` (Task 7).
- Produces: a registered connector id, selectable from settings.

This is the task where the additive-only invariants are proven. Three existing tests react to it and **none of them may be edited.**

- [ ] **Step 1: Register the connector**

In `src/tasks/registry.ts`, add the import and **one** map entry. `jira` must stay **first** — `CONNECTOR_IDS` is `Object.keys(CONNECTORS)` and `settingsSnapshot.test.ts:336` compares it to the manifest enum with order-sensitive `toEqual`.

```ts
import { makeAgileAcceleratorConnector } from "./agileAccelerator/connector";
```

```ts
const CONNECTORS: Record<string, (ctx: vscode.ExtensionContext) => TaskConnector> = {
  jira: makeJiraConnector,
  agileAccelerator: makeAgileAcceleratorConnector,
};
```

- [ ] **Step 2: Run the registry and telemetry tests to watch them fail**

Run: `npx vitest run test/unit/tasks/registry.test.ts test/unit/telemetry/settingsSnapshot.test.ts test/unit/docs.test.ts`
Expected: FAIL — the manifest enum no longer matches `CONNECTOR_IDS`, and `docs.test.ts` cannot find `` `agileAccelerator` `` in `docs/CONNECTORS.md`. These are the guard rails working.

- [ ] **Step 3: Update the manifest**

In `package.json`, edit `agentFlow.taskSource` — **append**, keeping `"jira"` first and `default` unchanged:

```json
{
  "type": "string",
  "enum": ["jira", "agileAccelerator"],
  "enumDescriptions": [
    "Atlassian Jira Cloud",
    "Salesforce Agile Accelerator (and GUS, which is the same code line)"
  ],
  "default": "jira",
  "description": "Where Agent Flow reads tasks from. Each source has its own settings under agentFlow.<source>.*. Requires a window reload."
}
```

Then add the three new settings alongside the existing `agentFlow.jira.*` ones (do not touch those):

```json
"agentFlow.agileAccelerator.instanceUrl": {
  "type": "string",
  "default": "",
  "markdownDescription": "Your Salesforce Lightning URL — GUS, or any org with the Agile Accelerator package installed. Example: `https://your-org.lightning.force.com`."
},
"agentFlow.agileAccelerator.team": {
  "type": "string",
  "default": "",
  "markdownDescription": "Your scrum team's name, exactly as it appears in Agile Accelerator. Bounds every query."
},
"agentFlow.agileAccelerator.targetOrg": {
  "type": "string",
  "default": "",
  "markdownDescription": "Salesforce CLI org alias or username. Leave blank to use the `sf` default org."
}
```

- [ ] **Step 4: Document the connector**

Append a section to `docs/CONNECTORS.md`. It **must** contain `` `agileAccelerator` `` in backticks (`docs.test.ts:12`). Also update §1's claim that `jira` is "the only registered connector".

```markdown
## 9. Connector #2: `agileAccelerator`

`agileAccelerator` reads from Salesforce **Agile Accelerator** — and from
**GUS**, Salesforce's internal tracker, which is the same code line without the
managed-package namespace. One connector serves both.

It is **read-only**. `statusTargets()` returns `[]`, `moveTo()` throws
`TaskWriteError`, and `assignToMe()` accepts and does nothing, so no write can
reach a work item.

What it demonstrates for a future connector author:

- **A CLI transport rather than HTTP.** Every read is an `sf` invocation, so the
  connector stores no credential and adds no SecretStorage key. Note that it
  declares its own runner type instead of reusing `Runner` from
  `src/engine/pr/provider.ts`: `execRunner` discards stdout on a non-zero exit,
  and `sf --json` puts its error envelope there.
- **A discovered schema rather than a hardcoded one.** A SOQL query naming a
  field that does not exist fails *entirely*, so the connector runs one cached
  `sf sobject describe` and builds each SELECT from the intersection with what
  the org actually has. The same describe detects the namespace prefix and
  resolves the team field's API name.
- **Caches on the connector, not the provider.** `provider()` is rebuilt per
  operation, so the describe cache, identity cache, key→Id memo and the batched
  30s `status()` memo all live on the connector and are injected as
  dependencies.
- **`keyFromUrl` that mostly returns `null`.** Its record urls carry an
  18-character Id, not a `W-` key, so it only answers when a `W-` token is
  literally present — per §4, returning `null` more often beats inventing a
  marker.

Known gaps, all deliberate: no sprint-shaped lenses (`caps.sprints` absent), no
size estimates (story points cannot honestly feed the 8-hour-workday
`estimateSeconds`), no components, labels or children, and `descriptionText` is
always empty because no description field name is verified.
```

- [ ] **Step 5: Run the three tests to verify they pass unmodified**

Run: `npx vitest run test/unit/tasks/registry.test.ts test/unit/telemetry/settingsSnapshot.test.ts test/unit/docs.test.ts`
Expected: PASS. `git diff --stat` must show **no** changes to any file under `test/`.

- [ ] **Step 6: Commit**

```bash
git add src/tasks/registry.ts package.json docs/CONNECTORS.md
git commit -m "feat(agileAccelerator): register the connector, manifest settings, and docs"
```

---

### Task 9: Full-gate verification

**Files:** none created or modified unless a gate fails.

- [ ] **Step 1: Confirm the compatibility surface is untouched**

```bash
git diff main --stat -- test/unit/compat.test.ts
```

Expected: **empty output.** Any diff here means the work is wrong.

```bash
npx vitest run test/unit/compat.test.ts
```

Expected: PASS, unmodified.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean, no output.

- [ ] **Step 3: Full suite**

Run with a 600000ms timeout, output to a file, **never** piped through `tail`:

```bash
npm test > /tmp/gus-suite.log 2>&1; echo "EXIT=$?"
grep -E "Test Files|Tests  " /tmp/gus-suite.log
```

Expected: `EXIT=0`, ≥ 4523 tests, **0 failures**. If exactly one unrelated test fails, re-run before investigating — this suite has a known flake under CPU contention.

- [ ] **Step 4: Coverage**

Run: `npm run test:cov`
Expected: thresholds met (statements 90, branches 85, functions 85, lines 90). `src/tasks/**` is not exempt. If the new directory is short, add tests — do not lower a threshold.

- [ ] **Step 5: Build — the dependency-leak gate**

Run: `npm run build`
Expected: succeeds. This is the only gate that catches `child_process` reaching a module it must not; `tsc` and the suite both pass regardless.

- [ ] **Step 6: Confirm the lockfile is still public**

```bash
grep -c codeartifact package-lock.json
git diff --stat -- package-lock.json
```

Expected: `0`, and an empty diff.

- [ ] **Step 7: Commit anything the gates required**

```bash
git add -A
git commit -m "test(agileAccelerator): close coverage gaps found by the full gate run"
```

(Skip if the working tree is clean.)

---

## Self-Review

**1. Spec coverage.** Every spec section maps to a task: §3 transport → Tasks 1–2; §4 schema discovery → Task 3; §5 files → Tasks 1–7; §6 capabilities → Task 6; §7 status mapping → Task 5; §8 identity → Task 7; §9 auth lifecycle → Task 7; §10 urls → Tasks 5 and 7; §11 settings/config/manifest → Tasks 7 and 8; §12 errors and Doctor probes → Tasks 1, 2, 7; §13 telemetry → Global Constraints (no code change needed — the guarantee is structural and the recommendation is to change nothing); §14 testing and gates → every task plus Task 9; §15 risks → mitigations implemented in Tasks 3 and 7; §16 deferrals → not implemented, by design.

**2. Placeholder scan.** No TBDs. Every code step carries real code. The two "implementer note" blocks (Task 3's `prefixOf` and Task 4's `selectList`) name a specific, verifiable outcome rather than deferring a decision.

**3. Type consistency.** `Schema` is produced by `buildSchema` (Task 3) and consumed by `soql.ts` (Task 4), `shape.ts` (Task 5), `provider.ts` (Task 6) and `connector.ts` (Task 7) with the same member names throughout: `object`, `prefix`, `has`, `field`, `teamField`, `selectable`. `SfCli.query<T>` returns `Promise<T[]>` and every caller passes `SfRecord`. `ProviderDeps` is declared in Task 6 and constructed only in Task 7's `provider()`, field-for-field. `statusCategoryOf` is used by both `shape.ts` and `connector.ts` from the one definition in Task 5. `SfDescribeResult` is declared in `cli.ts` (Task 2) and imported type-only by `describe.ts` (Task 3), which is why Task 3 depends on Task 2 despite being pure.

**One known deviation from the spec, recorded deliberately:** spec §3 originally said `cli.ts` would reuse the forge seam's `Runner`. It cannot — `execRunner` discards stdout on a non-zero exit, and `sf --json` writes its error envelope there. The spec has been corrected and Task 2 carries the reasoning.
