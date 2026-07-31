# Company OS — Phase A: the approval board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working local approval board — file-based queue, HTTP server, split master–detail UI — that a human can drive end to end before any agent exists to fill it.

**Architecture:** Pure TypeScript under `src/company/`, tested by vitest against real temp directories (the pattern `src/engine/claudeAssetsFs.ts` already established). A `route()` function holds every HTTP behaviour and is tested without binding a port; a thin `createBoardServer()` adapts it to `node:http` on loopback. All side effects that leave the process — spawning a cycle, running `git revert` — are injected into a context object, so tests are hermetic and Phase B swaps the real implementations in by changing one file.

**Tech Stack:** TypeScript 5.4 (strict), vitest 2.1, esbuild 0.20, Node 18+ built-ins only. Zero new dependencies.

## Global Constraints

- **No new runtime or dev dependencies.** Node built-ins only (`node:fs`, `node:path`, `node:http`, `node:crypto`, `node:child_process`).
- **Company data is private.** Everything the board reads and writes lives under `.claude/company/`, which the existing `.claude/*` rule in `.gitignore` and `.claude/**` in `.vscodeignore` already exclude. Do not add company data files to git.
- **`dist/company-board.js` must never ship.** `.vscodeignore` gets an explicit entry; verify with `npm run package`.
- **Loopback only.** The server binds `127.0.0.1`, never `0.0.0.0`.
- **Every request carries the session token.** No token, no response — including `GET /`.
- **Fail closed on paths.** Any artifact path that resolves outside the repository root is refused, never read.
- **Strict TypeScript.** `npm run typecheck` must stay clean; no `any` in exported signatures.
- **Follow the repo's test idiom:** `fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-…"))` in `beforeEach`, `fs.rmSync(..., { recursive: true, force: true })` in `afterEach`.
- **Do not touch** `package.json`'s `version`, `package-lock.json`, or `CHANGELOG.md` — those belong to the orchestrator per `.claude/orchestrator/PROTOCOL.md`.

## File Structure

| File | Responsibility |
|---|---|
| `src/company/types.ts` | Every shared type. No runtime code. Coverage-excluded, like `src/types.ts`. |
| `src/company/paths.ts` | Turns a repo root into the set of company paths; creates the directories. |
| `src/company/queue.ts` | The only module that touches company data: validate, read, record verdicts, resolve artifacts, pause. |
| `src/company/server.ts` | `route()` — all HTTP behaviour — plus `createBoardServer()`. |
| `src/company/boardHtml.ts` | The single-page UI as a string. Coverage-excluded, like `src/webview/deckStyles.ts`. |
| `src/company/boardMain.ts` | Entry point: token, real side-effect runners, listen, print URL. Coverage-excluded, like `src/webview/index.tsx`. |
| `test/unit/company/*.test.ts` | One test file per source module. |
| `esbuild.js` | One new bundle config. |
| `vitest.config.ts` | Three coverage exclusions. |
| `.vscodeignore` | Exclude the new bundle. |
| `package.json` | One new script: `board`. (`scripts` only — never `version`.) |

---

### Task 1: Company paths and state scaffolding

**Files:**
- Create: `src/company/types.ts`
- Create: `src/company/paths.ts`
- Test: `test/unit/company/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CompanyPaths` (interface with `repoRoot`, `root`, `queue`, `archive`, `landed`, `cycles`, `drafts`, `decisions`, `paused`, `charter`, `backlog`, `metrics` — all absolute strings), `companyPaths(repoRoot: string): CompanyPaths`, `ensureCompanyDirs(p: CompanyPaths): void`. Every later task takes a `CompanyPaths`, never a raw string.

- [ ] **Step 1: Write the types module**

Create `src/company/types.ts`:

```ts
// Shapes shared by the queue store, the HTTP routes and the board page.
// `kind` and `artifact.type` are plain strings on purpose: the spec requires an
// unknown kind to render as text rather than fail validation, so new kinds can
// appear without a code change.

export const KNOWN_KINDS = ["code", "spec", "copy", "mockup", "reply", "release"] as const;
export type KnownKind = (typeof KNOWN_KINDS)[number];

export const ARTIFACT_TYPES = ["diff", "markdown", "html", "text"] as const;
export type KnownArtifactType = (typeof ARTIFACT_TYPES)[number];

export const RISKS = ["safe", "gated"] as const;
export type Risk = (typeof RISKS)[number];

export const VERDICTS = ["approve", "reject", "revise"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface Artifact {
  /** One of ARTIFACT_TYPES when known; anything else renders as text. */
  type: string;
  /** Repo-relative or absolute path to the artifact's content. */
  path?: string;
  /** Content carried in the item itself, when there is no file. */
  inline?: string;
}

export interface Checks {
  typecheck?: string;
  test?: string;
  coverage?: string;
}

export interface QueueItem {
  id: string;
  cycle: string;
  role: string;
  kind: string;
  title: string;
  why: string;
  artifact: Artifact;
  risk: Risk;
  on_approve: string;
  branch?: string;
  checks?: Checks;
}

export interface LandedRecord {
  id: string;
  cycle: string;
  role: string;
  title: string;
  sha: string;
  landed_at: string;
}

export interface Decision {
  id: string;
  verdict: Verdict;
  note: string;
  at: string;
}

/** A queue file that could not be understood. Surfaced, never silently dropped. */
export interface Quarantined {
  file: string;
  error: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `test/unit/company/paths.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { companyPaths, ensureCompanyDirs } from "../../../src/company/paths";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-company-paths-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("companyPaths", () => {
  it("puts company state under .claude/company", () => {
    const p = companyPaths(root);
    expect(p.root).toBe(path.join(root, ".claude", "company"));
    expect(p.repoRoot).toBe(root);
  });

  it("names every directory and file the board needs", () => {
    const p = companyPaths(root);
    expect(p.queue).toBe(path.join(p.root, "queue"));
    expect(p.archive).toBe(path.join(p.root, "archive"));
    expect(p.landed).toBe(path.join(p.root, "landed"));
    expect(p.cycles).toBe(path.join(p.root, "cycles"));
    expect(p.drafts).toBe(path.join(p.root, "drafts"));
    expect(p.decisions).toBe(path.join(p.root, "decisions.jsonl"));
    expect(p.paused).toBe(path.join(p.root, "PAUSED"));
    expect(p.charter).toBe(path.join(p.root, "CHARTER.md"));
    expect(p.backlog).toBe(path.join(p.root, "backlog.md"));
    expect(p.metrics).toBe(path.join(p.root, "metrics.md"));
  });
});

describe("ensureCompanyDirs", () => {
  it("creates every directory, and is safe to call twice", () => {
    const p = companyPaths(root);
    ensureCompanyDirs(p);
    ensureCompanyDirs(p);
    for (const d of [p.root, p.queue, p.archive, p.landed, p.cycles, p.drafts]) {
      expect(fs.statSync(d).isDirectory()).toBe(true);
    }
  });

  it("does not create the files it names", () => {
    const p = companyPaths(root);
    ensureCompanyDirs(p);
    expect(fs.existsSync(p.decisions)).toBe(false);
    expect(fs.existsSync(p.paused)).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/unit/company/paths.test.ts`
Expected: FAIL — "Failed to resolve import ... src/company/paths".

- [ ] **Step 4: Write the implementation**

Create `src/company/paths.ts`:

```ts
import * as fs from "fs";
import * as path from "path";

/** Absolute locations of every piece of private company state. */
export interface CompanyPaths {
  repoRoot: string;
  root: string;
  queue: string;
  archive: string;
  landed: string;
  cycles: string;
  drafts: string;
  decisions: string;
  paused: string;
  charter: string;
  backlog: string;
  metrics: string;
}

export function companyPaths(repoRoot: string): CompanyPaths {
  const root = path.join(repoRoot, ".claude", "company");
  return {
    repoRoot,
    root,
    queue: path.join(root, "queue"),
    archive: path.join(root, "archive"),
    landed: path.join(root, "landed"),
    cycles: path.join(root, "cycles"),
    drafts: path.join(root, "drafts"),
    decisions: path.join(root, "decisions.jsonl"),
    paused: path.join(root, "PAUSED"),
    charter: path.join(root, "CHARTER.md"),
    backlog: path.join(root, "backlog.md"),
    metrics: path.join(root, "metrics.md"),
  };
}

/** Creates the directories. Files are created lazily by whoever writes them. */
export function ensureCompanyDirs(p: CompanyPaths): void {
  for (const dir of [p.root, p.queue, p.archive, p.landed, p.cycles, p.drafts]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/unit/company/paths.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/company/types.ts src/company/paths.ts test/unit/company/paths.test.ts
git commit -m "feat(company): company state paths and their types"
```

---

### Task 2: Queue item validation

**Files:**
- Create: `src/company/queue.ts`
- Test: `test/unit/company/queue.validate.test.ts`

**Interfaces:**
- Consumes: `QueueItem`, `Risk`, `RISKS` from `src/company/types.ts`.
- Produces: `ID_RE: RegExp`, `type ValidationResult = { ok: true; item: QueueItem } | { ok: false; error: string }`, `validateItem(raw: unknown): ValidationResult`, `validateLanded(raw: unknown): { ok: true; record: LandedRecord } | { ok: false; error: string }`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/company/queue.validate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateItem, validateLanded } from "../../../src/company/queue";

function good(): Record<string, unknown> {
  return {
    id: "2026-07-31-1709-growth-landing-hero",
    cycle: "2026-07-31T17:09",
    role: "company-growth",
    kind: "copy",
    title: "Landing page hero",
    why: "Betting the setup pain is the wedge.",
    artifact: { type: "markdown", path: ".claude/company/drafts/hero.md" },
    risk: "gated",
    on_approve: "Write docs/landing/index.html next cycle",
  };
}

describe("validateItem", () => {
  it("accepts a complete item", () => {
    const r = validateItem(good());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.item.id).toBe("2026-07-31-1709-growth-landing-hero");
  });

  it("accepts an unknown kind, because unknown kinds render as text", () => {
    const r = validateItem({ ...good(), kind: "podcast" });
    expect(r.ok).toBe(true);
  });

  it("accepts an unknown artifact type for the same reason", () => {
    const r = validateItem({ ...good(), artifact: { type: "sql", inline: "select 1" } });
    expect(r.ok).toBe(true);
  });

  it("accepts optional branch and checks", () => {
    const r = validateItem({
      ...good(),
      branch: "company/growth-hero",
      checks: { typecheck: "pass", test: "142 passed", coverage: "94.1%" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.item.checks?.coverage).toBe("94.1%");
  });

  it.each([
    ["not an object", 42, "must be an object"],
    ["null", null, "must be an object"],
  ])("rejects %s", (_label, raw, needle) => {
    const r = validateItem(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(needle);
  });

  it.each(["id", "cycle", "role", "kind", "title", "why", "on_approve"])(
    "rejects a missing %s",
    (field) => {
      const raw = good();
      delete raw[field];
      const r = validateItem(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(field);
    },
  );

  it("rejects an empty title", () => {
    const r = validateItem({ ...good(), title: "   " });
    expect(r.ok).toBe(false);
  });

  it.each([
    ["a path separator", "growth/../../etc/passwd"],
    ["an absolute path", "/etc/passwd"],
    ["uppercase", "Growth-Hero"],
    ["a leading dash", "-growth"],
    ["over 120 chars", "a".repeat(121)],
  ])("rejects an id containing %s", (_label, id) => {
    const r = validateItem({ ...good(), id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("id");
  });

  it("rejects a risk outside the allowed set", () => {
    const r = validateItem({ ...good(), risk: "medium" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("risk");
  });

  it("rejects an artifact with neither path nor inline", () => {
    const r = validateItem({ ...good(), artifact: { type: "text" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("artifact");
  });

  it("rejects a non-object artifact", () => {
    const r = validateItem({ ...good(), artifact: "hello" });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-string check value", () => {
    const r = validateItem({ ...good(), checks: { test: 42 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("checks");
  });
});

describe("validateLanded", () => {
  it("accepts a complete record", () => {
    const r = validateLanded({
      id: "2026-07-31-1709-arch-dedupe",
      cycle: "2026-07-31T17:09",
      role: "company-architect",
      title: "Dedupe the review-queue mappers",
      sha: "a1b2c3d4e5f6a7b8",
      landed_at: "2026-07-31T17:41:02Z",
    });
    expect(r.ok).toBe(true);
  });

  it.each([
    ["not hex", "zzzzzzz"],
    ["too short", "a1b2c3"],
    ["too long", "a".repeat(41)],
  ])("rejects a sha that is %s", (_label, sha) => {
    const r = validateLanded({
      id: "x",
      cycle: "c",
      role: "r",
      title: "t",
      sha,
      landed_at: "now",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("sha");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/company/queue.validate.test.ts`
Expected: FAIL — cannot resolve `src/company/queue`.

- [ ] **Step 3: Write the implementation**

Create `src/company/queue.ts`:

```ts
import { LandedRecord, QueueItem, RISKS, Risk } from "./types";

/**
 * An id is also a filename, so it is restricted to characters that cannot
 * escape the queue directory or collide across case-insensitive filesystems.
 */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

export type ValidationResult = { ok: true; item: QueueItem } | { ok: false; error: string };

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateItem(raw: unknown): ValidationResult {
  if (!isRecord(raw)) return { ok: false, error: "item must be an object" };

  for (const field of ["cycle", "role", "kind", "title", "why", "on_approve"]) {
    if (!nonEmptyString(raw[field])) return { ok: false, error: `${field} must be a non-empty string` };
  }

  if (!nonEmptyString(raw.id) || !ID_RE.test(raw.id)) {
    return { ok: false, error: "id must be lowercase letters, digits and dashes, 1–120 chars" };
  }

  if (!RISKS.includes(raw.risk as Risk)) {
    return { ok: false, error: `risk must be one of ${RISKS.join(", ")}` };
  }

  const artifact = raw.artifact;
  if (!isRecord(artifact)) return { ok: false, error: "artifact must be an object" };
  if (!nonEmptyString(artifact.type)) return { ok: false, error: "artifact.type must be a non-empty string" };
  if (!nonEmptyString(artifact.path) && !nonEmptyString(artifact.inline)) {
    return { ok: false, error: "artifact needs a path or inline content" };
  }

  if (raw.branch !== undefined && !nonEmptyString(raw.branch)) {
    return { ok: false, error: "branch must be a non-empty string when present" };
  }

  if (raw.checks !== undefined) {
    if (!isRecord(raw.checks)) return { ok: false, error: "checks must be an object" };
    for (const [key, value] of Object.entries(raw.checks)) {
      if (typeof value !== "string") return { ok: false, error: `checks.${key} must be a string` };
    }
  }

  return { ok: true, item: raw as unknown as QueueItem };
}

export type LandedValidation =
  | { ok: true; record: LandedRecord }
  | { ok: false; error: string };

export function validateLanded(raw: unknown): LandedValidation {
  if (!isRecord(raw)) return { ok: false, error: "record must be an object" };
  for (const field of ["id", "cycle", "role", "title", "landed_at"]) {
    if (!nonEmptyString(raw[field])) return { ok: false, error: `${field} must be a non-empty string` };
  }
  if (!nonEmptyString(raw.sha) || !SHA_RE.test(raw.sha)) {
    return { ok: false, error: "sha must be 7–40 hex characters" };
  }
  return { ok: true, record: raw as unknown as LandedRecord };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/company/queue.validate.test.ts`
Expected: PASS — every case, including all seven missing-field rows and all five bad-id rows.

- [ ] **Step 5: Commit**

```bash
git add src/company/queue.ts test/unit/company/queue.validate.test.ts
git commit -m "feat(company): validate queue items, accepting unknown kinds"
```

---

### Task 3: Reading the queue, the landed strip, and the pause flag

**Files:**
- Modify: `src/company/queue.ts` (append)
- Test: `test/unit/company/queue.read.test.ts`

**Interfaces:**
- Consumes: `CompanyPaths` from Task 1; `validateItem`, `validateLanded` from Task 2.
- Produces: `readQueue(p: CompanyPaths): { items: QueueItem[]; quarantined: Quarantined[] }`, `readLanded(p: CompanyPaths): LandedRecord[]`, `isPaused(p: CompanyPaths): boolean`, `setPaused(p: CompanyPaths, paused: boolean): boolean`, `lastCycle(p: CompanyPaths): string | null`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/company/queue.read.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { companyPaths, ensureCompanyDirs, CompanyPaths } from "../../../src/company/paths";
import { readQueue, readLanded, isPaused, setPaused, lastCycle } from "../../../src/company/queue";

let root: string;
let p: CompanyPaths;

function writeItem(id: string, over: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(p.queue, `${id}.json`),
    JSON.stringify({
      id,
      cycle: "2026-07-31T17:09",
      role: "company-growth",
      kind: "copy",
      title: `Item ${id}`,
      why: "because",
      artifact: { type: "text", inline: "hello" },
      risk: "gated",
      on_approve: "do the thing",
      ...over,
    }),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-company-read-"));
  p = companyPaths(root);
  ensureCompanyDirs(p);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("readQueue", () => {
  it("returns nothing when the queue directory is missing", () => {
    fs.rmSync(p.queue, { recursive: true, force: true });
    expect(readQueue(p)).toEqual({ items: [], quarantined: [] });
  });

  it("reads items in filename order", () => {
    writeItem("b-second");
    writeItem("a-first");
    expect(readQueue(p).items.map((i) => i.id)).toEqual(["a-first", "b-second"]);
  });

  it("ignores files that are not .json", () => {
    writeItem("real");
    fs.writeFileSync(path.join(p.queue, "notes.txt"), "ignore me");
    const r = readQueue(p);
    expect(r.items).toHaveLength(1);
    expect(r.quarantined).toHaveLength(0);
  });

  it("quarantines unparseable JSON instead of throwing", () => {
    fs.writeFileSync(path.join(p.queue, "broken.json"), "{ not json");
    const r = readQueue(p);
    expect(r.items).toHaveLength(0);
    expect(r.quarantined[0].file).toBe("broken.json");
    expect(r.quarantined[0].error).toMatch(/json/i);
  });

  it("quarantines an item that fails validation", () => {
    fs.writeFileSync(path.join(p.queue, "bad.json"), JSON.stringify({ id: "bad" }));
    const r = readQueue(p);
    expect(r.items).toHaveLength(0);
    expect(r.quarantined[0].error).toContain("cycle");
  });

  it("quarantines an item whose id does not match its filename", () => {
    writeItem("mismatch");
    fs.renameSync(path.join(p.queue, "mismatch.json"), path.join(p.queue, "other.json"));
    const r = readQueue(p);
    expect(r.items).toHaveLength(0);
    expect(r.quarantined[0].error).toContain("filename");
  });

  it("keeps good items when a sibling is broken", () => {
    writeItem("fine");
    fs.writeFileSync(path.join(p.queue, "zbroken.json"), "nope");
    const r = readQueue(p);
    expect(r.items.map((i) => i.id)).toEqual(["fine"]);
    expect(r.quarantined).toHaveLength(1);
  });
});

describe("readLanded", () => {
  it("returns newest first and drops invalid records", () => {
    fs.writeFileSync(
      path.join(p.landed, "a.json"),
      JSON.stringify({
        id: "a", cycle: "c", role: "r", title: "older",
        sha: "aaaaaaa", landed_at: "2026-07-30T10:00:00Z",
      }),
    );
    fs.writeFileSync(
      path.join(p.landed, "b.json"),
      JSON.stringify({
        id: "b", cycle: "c", role: "r", title: "newer",
        sha: "bbbbbbb", landed_at: "2026-07-31T10:00:00Z",
      }),
    );
    fs.writeFileSync(path.join(p.landed, "c.json"), JSON.stringify({ id: "c", sha: "nope" }));
    expect(readLanded(p).map((r) => r.title)).toEqual(["newer", "older"]);
  });

  it("returns an empty list when the directory is missing", () => {
    fs.rmSync(p.landed, { recursive: true, force: true });
    expect(readLanded(p)).toEqual([]);
  });
});

describe("pause flag", () => {
  it("is off until the file exists", () => {
    expect(isPaused(p)).toBe(false);
  });

  it("round-trips through setPaused", () => {
    expect(setPaused(p, true)).toBe(true);
    expect(isPaused(p)).toBe(true);
    expect(setPaused(p, false)).toBe(false);
    expect(isPaused(p)).toBe(false);
  });

  it("is idempotent in both directions", () => {
    setPaused(p, true);
    setPaused(p, true);
    expect(isPaused(p)).toBe(true);
    setPaused(p, false);
    setPaused(p, false);
    expect(isPaused(p)).toBe(false);
  });
});

describe("lastCycle", () => {
  it("is null with no reports", () => {
    expect(lastCycle(p)).toBeNull();
  });

  it("returns the newest report name", () => {
    fs.writeFileSync(path.join(p.cycles, "2026-07-30T0900.md"), "older");
    fs.writeFileSync(path.join(p.cycles, "2026-07-31T1709.md"), "newer");
    expect(lastCycle(p)).toBe("2026-07-31T1709.md");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/company/queue.read.test.ts`
Expected: FAIL — `readQueue` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/company/queue.ts` (and extend the import at the top of the file to
`import { LandedRecord, QueueItem, Quarantined, RISKS, Risk } from "./types";`, plus
add `import * as fs from "fs";` and `import * as path from "path";`):

```ts
export interface QueueRead {
  items: QueueItem[];
  quarantined: Quarantined[];
}

function listJson(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".json")).sort();
}

export function readQueue(p: CompanyPaths): QueueRead {
  const items: QueueItem[] = [];
  const quarantined: Quarantined[] = [];

  for (const file of listJson(p.queue)) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(p.queue, file), "utf8"));
    } catch (e) {
      quarantined.push({ file, error: `unreadable json: ${(e as Error).message}` });
      continue;
    }
    const result = validateItem(raw);
    if (!result.ok) {
      quarantined.push({ file, error: result.error });
      continue;
    }
    if (`${result.item.id}.json` !== file) {
      quarantined.push({ file, error: `id "${result.item.id}" does not match its filename` });
      continue;
    }
    items.push(result.item);
  }

  return { items, quarantined };
}

export function readLanded(p: CompanyPaths): LandedRecord[] {
  const records: LandedRecord[] = [];
  for (const file of listJson(p.landed)) {
    try {
      const result = validateLanded(JSON.parse(fs.readFileSync(path.join(p.landed, file), "utf8")));
      if (result.ok) records.push(result.record);
    } catch {
      // A malformed landed record is informational only — skip it silently.
    }
  }
  return records.sort((a, b) => b.landed_at.localeCompare(a.landed_at));
}

export function isPaused(p: CompanyPaths): boolean {
  return fs.existsSync(p.paused);
}

export function setPaused(p: CompanyPaths, paused: boolean): boolean {
  if (paused) {
    fs.mkdirSync(p.root, { recursive: true });
    fs.writeFileSync(p.paused, "Paused from the board.\n");
  } else {
    fs.rmSync(p.paused, { force: true });
  }
  return isPaused(p);
}

export function lastCycle(p: CompanyPaths): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(p.cycles).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return null;
  }
  return names.length > 0 ? names[names.length - 1] : null;
}
```

Also add `import { CompanyPaths } from "./paths";` to the top of the file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/company/queue.read.test.ts`
Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/company/queue.ts test/unit/company/queue.read.test.ts
git commit -m "feat(company): read the queue, the landed strip and the pause flag"
```

---

### Task 4: Recording a verdict

**Files:**
- Modify: `src/company/queue.ts` (append)
- Test: `test/unit/company/queue.verdict.test.ts`

**Interfaces:**
- Consumes: `CompanyPaths`, `readQueue`, `ID_RE`, `VERDICTS`.
- Produces: `type WriteResult = { ok: true } | { ok: false; error: string }`, `recordVerdict(p: CompanyPaths, id: string, verdict: string, note: string, now?: () => string): WriteResult`, `readDecisions(p: CompanyPaths): Decision[]`, `acknowledgeLanded(p: CompanyPaths, id: string): WriteResult`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/company/queue.verdict.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { companyPaths, ensureCompanyDirs, CompanyPaths } from "../../../src/company/paths";
import {
  recordVerdict,
  readDecisions,
  acknowledgeLanded,
  readQueue,
} from "../../../src/company/queue";

let root: string;
let p: CompanyPaths;
const FIXED = () => "2026-07-31T18:02:11Z";

function writeItem(id: string): void {
  fs.writeFileSync(
    path.join(p.queue, `${id}.json`),
    JSON.stringify({
      id,
      cycle: "2026-07-31T17:09",
      role: "company-growth",
      kind: "copy",
      title: "Landing page hero",
      why: "because",
      artifact: { type: "text", inline: "hello" },
      risk: "gated",
      on_approve: "do the thing",
    }),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-company-verdict-"));
  p = companyPaths(root);
  ensureCompanyDirs(p);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("recordVerdict", () => {
  it("appends a decision and archives the item", () => {
    writeItem("hero");
    expect(recordVerdict(p, "hero", "approve", "", FIXED)).toEqual({ ok: true });

    expect(fs.existsSync(path.join(p.queue, "hero.json"))).toBe(false);
    expect(fs.existsSync(path.join(p.archive, "hero.json"))).toBe(true);
    expect(readDecisions(p)).toEqual([
      { id: "hero", verdict: "approve", note: "", at: "2026-07-31T18:02:11Z" },
    ]);
    expect(readQueue(p).items).toHaveLength(0);
  });

  it("keeps every decision, appending rather than overwriting", () => {
    writeItem("one");
    writeItem("two");
    recordVerdict(p, "one", "approve", "", FIXED);
    recordVerdict(p, "two", "reject", "wrong angle", FIXED);
    expect(readDecisions(p).map((d) => d.id)).toEqual(["one", "two"]);
  });

  it("stores the note on a revise", () => {
    writeItem("hero");
    recordVerdict(p, "hero", "revise", "Lead with the worktree, not the Jira fetch", FIXED);
    expect(readDecisions(p)[0].note).toBe("Lead with the worktree, not the Jira fetch");
  });

  it("refuses a revise with no note, because it teaches the role nothing", () => {
    writeItem("hero");
    const r = recordVerdict(p, "hero", "revise", "   ", FIXED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("note");
    expect(fs.existsSync(path.join(p.queue, "hero.json"))).toBe(true);
  });

  it("refuses an unknown verdict", () => {
    writeItem("hero");
    const r = recordVerdict(p, "hero", "maybe", "", FIXED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("verdict");
  });

  it("refuses an id that could escape the queue directory", () => {
    const r = recordVerdict(p, "../../escape", "approve", "", FIXED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("id");
  });

  it("refuses an unknown item without writing a decision", () => {
    const r = recordVerdict(p, "ghost", "approve", "", FIXED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ghost");
    expect(readDecisions(p)).toEqual([]);
  });

  it("refuses to decide the same item twice", () => {
    writeItem("hero");
    recordVerdict(p, "hero", "approve", "", FIXED);
    const second = recordVerdict(p, "hero", "reject", "", FIXED);
    expect(second.ok).toBe(false);
    expect(readDecisions(p)).toHaveLength(1);
  });
});

describe("readDecisions", () => {
  it("is empty before anything is decided", () => {
    expect(readDecisions(p)).toEqual([]);
  });

  it("skips malformed lines rather than throwing", () => {
    fs.writeFileSync(
      p.decisions,
      '{"id":"a","verdict":"approve","note":"","at":"t"}\nnot json\n\n',
    );
    expect(readDecisions(p).map((d) => d.id)).toEqual(["a"]);
  });
});

describe("acknowledgeLanded", () => {
  it("removes the landed record", () => {
    fs.writeFileSync(
      path.join(p.landed, "dedupe.json"),
      JSON.stringify({
        id: "dedupe", cycle: "c", role: "r", title: "t",
        sha: "a1b2c3d", landed_at: "2026-07-31T10:00:00Z",
      }),
    );
    expect(acknowledgeLanded(p, "dedupe")).toEqual({ ok: true });
    expect(fs.existsSync(path.join(p.landed, "dedupe.json"))).toBe(false);
  });

  it("refuses an unknown record", () => {
    expect(acknowledgeLanded(p, "ghost").ok).toBe(false);
  });

  it("refuses a traversing id", () => {
    expect(acknowledgeLanded(p, "../../etc/passwd").ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/company/queue.verdict.test.ts`
Expected: FAIL — `recordVerdict` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/company/queue.ts` (extend the types import with `Decision`, `VERDICTS`, `Verdict`):

```ts
export type WriteResult = { ok: true } | { ok: false; error: string };

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Appends the decision, then archives the item. Order matters: if the archive
 * move fails, the item stays pending and can be decided again — a duplicate
 * line in an append-only log is recoverable, a lost decision is not.
 */
export function recordVerdict(
  p: CompanyPaths,
  id: string,
  verdict: string,
  note: string,
  now: () => string = nowIso,
): WriteResult {
  if (!ID_RE.test(id)) return { ok: false, error: "id must be lowercase letters, digits and dashes" };
  if (!VERDICTS.includes(verdict as Verdict)) {
    return { ok: false, error: `verdict must be one of ${VERDICTS.join(", ")}` };
  }
  if (verdict === "revise" && note.trim().length === 0) {
    return { ok: false, error: "a revise needs a note — without one the role learns nothing" };
  }

  const pending = path.join(p.queue, `${id}.json`);
  if (!fs.existsSync(pending)) return { ok: false, error: `no pending item "${id}"` };

  const decision: Decision = { id, verdict: verdict as Verdict, note, at: now() };
  fs.mkdirSync(p.root, { recursive: true });
  fs.appendFileSync(p.decisions, `${JSON.stringify(decision)}\n`);

  fs.mkdirSync(p.archive, { recursive: true });
  fs.renameSync(pending, path.join(p.archive, `${id}.json`));
  return { ok: true };
}

export function readDecisions(p: CompanyPaths): Decision[] {
  let text: string;
  try {
    text = fs.readFileSync(p.decisions, "utf8");
  } catch {
    return [];
  }
  const decisions: Decision[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      decisions.push(JSON.parse(line) as Decision);
    } catch {
      // A hand-edited or truncated line must not break the board.
    }
  }
  return decisions;
}

export function acknowledgeLanded(p: CompanyPaths, id: string): WriteResult {
  if (!ID_RE.test(id)) return { ok: false, error: "id must be lowercase letters, digits and dashes" };
  const file = path.join(p.landed, `${id}.json`);
  if (!fs.existsSync(file)) return { ok: false, error: `no landed record "${id}"` };
  fs.rmSync(file, { force: true });
  return { ok: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/company/queue.verdict.test.ts`
Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/company/queue.ts test/unit/company/queue.verdict.test.ts
git commit -m "feat(company): record verdicts to an append-only log and archive the item"
```

---

### Task 5: Resolving an artifact, refusing anything outside the repo

**Files:**
- Modify: `src/company/queue.ts` (append)
- Test: `test/unit/company/queue.artifact.test.ts`

**Interfaces:**
- Consumes: `CompanyPaths`, `QueueItem`.
- Produces: `isInside(root: string, candidate: string): boolean`, `interface ResolvedArtifact { type: string; content: string; truncated: boolean }`, `resolveArtifact(p: CompanyPaths, item: QueueItem, maxBytes?: number): { ok: true; artifact: ResolvedArtifact } | { ok: false; error: string }`. Default `maxBytes` is `262144`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/company/queue.artifact.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { companyPaths, ensureCompanyDirs, CompanyPaths } from "../../../src/company/paths";
import { resolveArtifact, isInside } from "../../../src/company/queue";
import { QueueItem } from "../../../src/company/types";

let root: string;
let p: CompanyPaths;

function item(artifact: QueueItem["artifact"]): QueueItem {
  return {
    id: "x",
    cycle: "c",
    role: "company-growth",
    kind: "copy",
    title: "t",
    why: "w",
    artifact,
    risk: "gated",
    on_approve: "a",
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-company-artifact-"));
  p = companyPaths(root);
  ensureCompanyDirs(p);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("isInside", () => {
  it("accepts the root itself and its descendants", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/c/d.txt")).toBe(true);
  });

  it("rejects siblings and parents", () => {
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
  });
});

describe("resolveArtifact", () => {
  it("returns inline content without touching the filesystem", () => {
    const r = resolveArtifact(p, item({ type: "text", inline: "a draft tweet" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact.content).toBe("a draft tweet");
      expect(r.artifact.truncated).toBe(false);
    }
  });

  it("prefers inline over path when both are present", () => {
    fs.writeFileSync(path.join(p.drafts, "hero.md"), "from disk");
    const r = resolveArtifact(
      p,
      item({ type: "markdown", inline: "from inline", path: ".claude/company/drafts/hero.md" }),
    );
    if (r.ok) expect(r.artifact.content).toBe("from inline");
  });

  it("reads a repo-relative path", () => {
    fs.writeFileSync(path.join(p.drafts, "hero.md"), "# Hero\n");
    const r = resolveArtifact(p, item({ type: "markdown", path: ".claude/company/drafts/hero.md" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.artifact.content).toBe("# Hero\n");
  });

  it("reads an absolute path inside the repo", () => {
    const abs = path.join(p.drafts, "hero.md");
    fs.writeFileSync(abs, "absolute");
    const r = resolveArtifact(p, item({ type: "markdown", path: abs }));
    expect(r.ok).toBe(true);
  });

  it("refuses a path that climbs out of the repo", () => {
    const r = resolveArtifact(p, item({ type: "text", path: "../../../etc/passwd" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("outside");
  });

  it("refuses an absolute path outside the repo", () => {
    const r = resolveArtifact(p, item({ type: "text", path: "/etc/passwd" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("outside");
  });

  it("refuses a directory", () => {
    const r = resolveArtifact(p, item({ type: "text", path: ".claude/company/drafts" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not a file");
  });

  it("reports a missing file plainly", () => {
    const r = resolveArtifact(p, item({ type: "text", path: ".claude/company/drafts/gone.md" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("gone.md");
  });

  it("truncates content past the byte cap and says so", () => {
    fs.writeFileSync(path.join(p.drafts, "big.md"), "x".repeat(500));
    const r = resolveArtifact(p, item({ type: "text", path: ".claude/company/drafts/big.md" }), 100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact.content).toHaveLength(100);
      expect(r.artifact.truncated).toBe(true);
    }
  });

  it("refuses an artifact with neither path nor inline", () => {
    const r = resolveArtifact(p, item({ type: "text" }));
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/company/queue.artifact.test.ts`
Expected: FAIL — `resolveArtifact` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/company/queue.ts`:

```ts
/** True when `candidate` is `root` itself or sits beneath it. */
export function isInside(root: string, candidate: string): boolean {
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  return c === r || c.startsWith(r + path.sep);
}

export interface ResolvedArtifact {
  type: string;
  content: string;
  truncated: boolean;
}

const DEFAULT_MAX_BYTES = 262144;

export function resolveArtifact(
  p: CompanyPaths,
  item: QueueItem,
  maxBytes: number = DEFAULT_MAX_BYTES,
): { ok: true; artifact: ResolvedArtifact } | { ok: false; error: string } {
  const { type, path: rel, inline } = item.artifact;

  if (typeof inline === "string" && inline.length > 0) {
    return {
      ok: true,
      artifact: { type, content: inline.slice(0, maxBytes), truncated: inline.length > maxBytes },
    };
  }

  if (typeof rel !== "string" || rel.length === 0) {
    return { ok: false, error: "artifact has neither a path nor inline content" };
  }

  const resolved = path.resolve(p.repoRoot, rel);
  if (!isInside(p.repoRoot, resolved)) {
    return { ok: false, error: `artifact path resolves outside the repository: ${rel}` };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, error: `artifact file not found: ${rel}` };
  }
  if (!stat.isFile()) return { ok: false, error: `artifact path is not a file: ${rel}` };

  const text = fs.readFileSync(resolved, "utf8");
  return {
    ok: true,
    artifact: { type, content: text.slice(0, maxBytes), truncated: text.length > maxBytes },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/company/queue.artifact.test.ts`
Expected: PASS — 12 tests.

- [ ] **Step 5: Run the whole queue suite and typecheck**

Run: `npx vitest run test/unit/company/ && npm run typecheck`
Expected: all company tests pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/company/queue.ts test/unit/company/queue.artifact.test.ts
git commit -m "feat(company): resolve artifacts, refusing paths outside the repo"
```

---

### Task 6: The read and decide routes

**Files:**
- Create: `src/company/server.ts`
- Test: `test/unit/company/server.routes.test.ts`

**Interfaces:**
- Consumes: everything exported from `queue.ts` and `paths.ts`.
- Produces:
  - `interface BoardContext { paths: CompanyPaths; token: string; spawnCycle: (mode: CycleMode) => Promise<RunnerResult>; gitRevert: (sha: string) => Promise<RunnerResult>; }`
  - `type CycleMode = "full" | "apply"`
  - `interface RunnerResult { ok: boolean; detail: string }`
  - `interface RouteResult { status: number; json?: unknown; html?: string }`
  - `route(method: string, urlPath: string, query: URLSearchParams, body: string | null, ctx: BoardContext): Promise<RouteResult>`

- [ ] **Step 1: Write the failing test**

Create `test/unit/company/server.routes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { companyPaths, ensureCompanyDirs } from "../../../src/company/paths";
import { route, BoardContext } from "../../../src/company/server";
import { readDecisions, isPaused } from "../../../src/company/queue";

let root: string;
let ctx: BoardContext;
const KEY = "s3cret";

function q(key: string | null = KEY): URLSearchParams {
  return new URLSearchParams(key === null ? "" : `key=${key}`);
}

function writeItem(id: string, over: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(ctx.paths.queue, `${id}.json`),
    JSON.stringify({
      id,
      cycle: "2026-07-31T17:09",
      role: "company-growth",
      kind: "copy",
      title: `Item ${id}`,
      why: "because",
      artifact: { type: "text", inline: "a draft" },
      risk: "gated",
      on_approve: "do the thing",
      ...over,
    }),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-company-routes-"));
  const paths = companyPaths(root);
  ensureCompanyDirs(paths);
  ctx = {
    paths,
    token: KEY,
    spawnCycle: vi.fn(async () => ({ ok: true, detail: "started" })),
    gitRevert: vi.fn(async () => ({ ok: true, detail: "reverted" })),
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("token gate", () => {
  it("refuses every request without the key", async () => {
    for (const [method, url] of [
      ["GET", "/"],
      ["GET", "/api/queue"],
      ["POST", "/api/decision"],
    ] as const) {
      const r = await route(method, url, q(null), "{}", ctx);
      expect(r.status).toBe(401);
    }
  });

  it("refuses a wrong key", async () => {
    expect((await route("GET", "/api/queue", q("wrong"), null, ctx)).status).toBe(401);
  });
});

describe("GET /", () => {
  it("serves the board page", async () => {
    const r = await route("GET", "/", q(), null, ctx);
    expect(r.status).toBe(200);
    expect(r.html).toContain("<!doctype html>");
  });
});

describe("GET /api/queue", () => {
  it("returns pending items, landed records, pause state and last cycle", async () => {
    writeItem("hero");
    const r = await route("GET", "/api/queue", q(), null, ctx);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      pending: [{ id: "hero" }],
      landed: [],
      quarantined: [],
      paused: false,
      lastCycle: null,
    });
  });

  it("reports quarantined files", async () => {
    fs.writeFileSync(path.join(ctx.paths.queue, "broken.json"), "nope");
    const r = await route("GET", "/api/queue", q(), null, ctx);
    expect((r.json as { quarantined: unknown[] }).quarantined).toHaveLength(1);
  });
});

describe("GET /api/artifact", () => {
  it("returns the resolved artifact for a pending item", async () => {
    writeItem("hero");
    const r = await route("GET", "/api/artifact", new URLSearchParams(`key=${KEY}&id=hero`), null, ctx);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ type: "text", content: "a draft", truncated: false });
  });

  it("404s an unknown id", async () => {
    const r = await route("GET", "/api/artifact", new URLSearchParams(`key=${KEY}&id=ghost`), null, ctx);
    expect(r.status).toBe(404);
  });

  it("400s a missing id", async () => {
    const r = await route("GET", "/api/artifact", q(), null, ctx);
    expect(r.status).toBe(400);
  });

  it("400s an artifact that cannot be read", async () => {
    writeItem("bad", { artifact: { type: "text", path: "../../../etc/passwd" } });
    const r = await route("GET", "/api/artifact", new URLSearchParams(`key=${KEY}&id=bad`), null, ctx);
    expect(r.status).toBe(400);
  });
});

describe("POST /api/decision", () => {
  it("records the verdict", async () => {
    writeItem("hero");
    const r = await route(
      "POST",
      "/api/decision",
      q(),
      JSON.stringify({ id: "hero", verdict: "approve", note: "" }),
      ctx,
    );
    expect(r.status).toBe(200);
    expect(readDecisions(ctx.paths)[0].verdict).toBe("approve");
  });

  it("400s a revise with no note", async () => {
    writeItem("hero");
    const r = await route(
      "POST",
      "/api/decision",
      q(),
      JSON.stringify({ id: "hero", verdict: "revise", note: "" }),
      ctx,
    );
    expect(r.status).toBe(400);
    expect(readDecisions(ctx.paths)).toEqual([]);
  });

  it("400s malformed JSON", async () => {
    const r = await route("POST", "/api/decision", q(), "{ nope", ctx);
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: expect.stringContaining("json") });
  });

  it("400s a body that is not an object", async () => {
    const r = await route("POST", "/api/decision", q(), "[]", ctx);
    expect(r.status).toBe(400);
  });

  it("405s a GET", async () => {
    expect((await route("GET", "/api/decision", q(), null, ctx)).status).toBe(405);
  });
});

describe("POST /api/pause", () => {
  it("turns the kill switch on and off", async () => {
    const on = await route("POST", "/api/pause", q(), JSON.stringify({ paused: true }), ctx);
    expect(on.json).toEqual({ paused: true });
    expect(isPaused(ctx.paths)).toBe(true);

    const off = await route("POST", "/api/pause", q(), JSON.stringify({ paused: false }), ctx);
    expect(off.json).toEqual({ paused: false });
    expect(isPaused(ctx.paths)).toBe(false);
  });

  it("400s a non-boolean", async () => {
    const r = await route("POST", "/api/pause", q(), JSON.stringify({ paused: "yes" }), ctx);
    expect(r.status).toBe(400);
  });
});

describe("unknown routes", () => {
  it("404s", async () => {
    expect((await route("GET", "/api/nope", q(), null, ctx)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/company/server.routes.test.ts`
Expected: FAIL — cannot resolve `src/company/server`.

- [ ] **Step 3: Write the implementation**

Create `src/company/server.ts`:

```ts
import { CompanyPaths } from "./paths";
import { boardHtml } from "./boardHtml";
import {
  isPaused,
  lastCycle,
  readLanded,
  readQueue,
  recordVerdict,
  resolveArtifact,
  setPaused,
} from "./queue";

export type CycleMode = "full" | "apply";

export interface RunnerResult {
  ok: boolean;
  detail: string;
}

/**
 * Everything the routes need. The two runners are injected so tests never spawn
 * a process, and so phase B can supply the real cycle script by changing only
 * `boardMain.ts`.
 */
export interface BoardContext {
  paths: CompanyPaths;
  token: string;
  spawnCycle: (mode: CycleMode) => Promise<RunnerResult>;
  gitRevert: (sha: string) => Promise<RunnerResult>;
}

export interface RouteResult {
  status: number;
  json?: unknown;
  html?: string;
}

function parseBody(body: string | null): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body === null || body.trim().length === 0) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

export async function route(
  method: string,
  urlPath: string,
  query: URLSearchParams,
  body: string | null,
  ctx: BoardContext,
): Promise<RouteResult> {
  if (query.get("key") !== ctx.token) return { status: 401, json: { error: "bad or missing key" } };

  if (urlPath === "/") {
    if (method !== "GET") return { status: 405, json: { error: "use GET" } };
    return { status: 200, html: boardHtml() };
  }

  if (urlPath === "/api/queue") {
    if (method !== "GET") return { status: 405, json: { error: "use GET" } };
    const { items, quarantined } = readQueue(ctx.paths);
    return {
      status: 200,
      json: {
        pending: items,
        landed: readLanded(ctx.paths),
        quarantined,
        paused: isPaused(ctx.paths),
        lastCycle: lastCycle(ctx.paths),
      },
    };
  }

  if (urlPath === "/api/artifact") {
    if (method !== "GET") return { status: 405, json: { error: "use GET" } };
    const id = query.get("id");
    if (id === null || id.length === 0) return { status: 400, json: { error: "id is required" } };
    const item = readQueue(ctx.paths).items.find((i) => i.id === id);
    if (item === undefined) return { status: 404, json: { error: `no pending item "${id}"` } };
    const resolved = resolveArtifact(ctx.paths, item);
    if (!resolved.ok) return { status: 400, json: { error: resolved.error } };
    return { status: 200, json: resolved.artifact };
  }

  if (urlPath === "/api/decision") {
    if (method !== "POST") return { status: 405, json: { error: "use POST" } };
    const parsed = parseBody(body);
    if (!parsed.ok) return { status: 400, json: { error: "body must be a json object" } };
    const { id, verdict, note } = parsed.value;
    if (typeof id !== "string" || typeof verdict !== "string") {
      return { status: 400, json: { error: "id and verdict are required" } };
    }
    const result = recordVerdict(
      ctx.paths,
      id,
      verdict,
      typeof note === "string" ? note : "",
    );
    if (!result.ok) return { status: 400, json: { error: result.error } };
    return { status: 200, json: { ok: true } };
  }

  if (urlPath === "/api/pause") {
    if (method !== "POST") return { status: 405, json: { error: "use POST" } };
    const parsed = parseBody(body);
    if (!parsed.ok) return { status: 400, json: { error: "body must be a json object" } };
    if (typeof parsed.value.paused !== "boolean") {
      return { status: 400, json: { error: "paused must be a boolean" } };
    }
    return { status: 200, json: { paused: setPaused(ctx.paths, parsed.value.paused) } };
  }

  return { status: 404, json: { error: "not found" } };
}
```

- [ ] **Step 4: Add a temporary boardHtml stub so the module resolves**

Create `src/company/boardHtml.ts` — Task 9 replaces the body with the real page:

```ts
/** The board page. Replaced with the real UI in task 9. */
export function boardHtml(): string {
  return "<!doctype html><title>Company</title><p>The board UI arrives in task 9.</p>";
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/unit/company/server.routes.test.ts`
Expected: PASS — 17 tests.

- [ ] **Step 6: Commit**

```bash
git add src/company/server.ts src/company/boardHtml.ts test/unit/company/server.routes.test.ts
git commit -m "feat(company): board routes for reading the queue and deciding an item"
```

---

### Task 7: The cycle and undo routes

**Files:**
- Modify: `src/company/server.ts` (add two route branches before the final 404)
- Test: `test/unit/company/server.actions.test.ts`

**Interfaces:**
- Consumes: `BoardContext`, `route` from Task 6; `readLanded`, `acknowledgeLanded` from Tasks 3–4.
- Produces: no new exports — two new route behaviours on `route()`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/company/server.actions.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { companyPaths, ensureCompanyDirs } from "../../../src/company/paths";
import { route, BoardContext } from "../../../src/company/server";

let root: string;
let ctx: BoardContext;
const KEY = "s3cret";
const q = () => new URLSearchParams(`key=${KEY}`);

function writeLanded(id: string, sha: string): void {
  fs.writeFileSync(
    path.join(ctx.paths.landed, `${id}.json`),
    JSON.stringify({
      id,
      cycle: "2026-07-31T17:09",
      role: "company-architect",
      title: "Dedupe the review-queue mappers",
      sha,
      landed_at: "2026-07-31T17:41:02Z",
    }),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-company-actions-"));
  const paths = companyPaths(root);
  ensureCompanyDirs(paths);
  ctx = {
    paths,
    token: KEY,
    spawnCycle: vi.fn(async () => ({ ok: true, detail: "started" })),
    gitRevert: vi.fn(async () => ({ ok: true, detail: "reverted 1 commit" })),
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("POST /api/cycle", () => {
  it("runs a full cycle by default", async () => {
    const r = await route("POST", "/api/cycle", q(), "{}", ctx);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, detail: "started" });
    expect(ctx.spawnCycle).toHaveBeenCalledWith("full");
  });

  it("runs apply mode when asked", async () => {
    await route("POST", "/api/cycle", q(), JSON.stringify({ mode: "apply" }), ctx);
    expect(ctx.spawnCycle).toHaveBeenCalledWith("apply");
  });

  it("400s an unknown mode without spawning anything", async () => {
    const r = await route("POST", "/api/cycle", q(), JSON.stringify({ mode: "yolo" }), ctx);
    expect(r.status).toBe(400);
    expect(ctx.spawnCycle).not.toHaveBeenCalled();
  });

  it("refuses to start a cycle while paused", async () => {
    await route("POST", "/api/pause", q(), JSON.stringify({ paused: true }), ctx);
    const r = await route("POST", "/api/cycle", q(), "{}", ctx);
    expect(r.status).toBe(409);
    expect(ctx.spawnCycle).not.toHaveBeenCalled();
  });

  it("passes a runner failure through as a 200 with ok:false", async () => {
    ctx.spawnCycle = vi.fn(async () => ({ ok: false, detail: "the cycle script is not installed yet" }));
    const r = await route("POST", "/api/cycle", q(), "{}", ctx);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: false, detail: "the cycle script is not installed yet" });
  });

  it("405s a GET", async () => {
    expect((await route("GET", "/api/cycle", q(), null, ctx)).status).toBe(405);
  });
});

describe("POST /api/undo", () => {
  it("reverts the recorded sha and clears the landed record", async () => {
    writeLanded("dedupe", "a1b2c3d4e5");
    const r = await route("POST", "/api/undo", q(), JSON.stringify({ id: "dedupe" }), ctx);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, detail: "reverted 1 commit" });
    expect(ctx.gitRevert).toHaveBeenCalledWith("a1b2c3d4e5");
    expect(fs.existsSync(path.join(ctx.paths.landed, "dedupe.json"))).toBe(false);
  });

  it("404s an unknown record without reverting", async () => {
    const r = await route("POST", "/api/undo", q(), JSON.stringify({ id: "ghost" }), ctx);
    expect(r.status).toBe(404);
    expect(ctx.gitRevert).not.toHaveBeenCalled();
  });

  it("keeps the record when the revert fails, so it can be retried", async () => {
    writeLanded("dedupe", "a1b2c3d4e5");
    ctx.gitRevert = vi.fn(async () => ({ ok: false, detail: "conflict" }));
    const r = await route("POST", "/api/undo", q(), JSON.stringify({ id: "dedupe" }), ctx);
    expect(r.json).toEqual({ ok: false, detail: "conflict" });
    expect(fs.existsSync(path.join(ctx.paths.landed, "dedupe.json"))).toBe(true);
  });

  it("400s a missing id", async () => {
    const r = await route("POST", "/api/undo", q(), "{}", ctx);
    expect(r.status).toBe(400);
    expect(ctx.gitRevert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/company/server.actions.test.ts`
Expected: FAIL — `/api/cycle` currently falls through to the 404 branch.

- [ ] **Step 3: Write the implementation**

In `src/company/server.ts`, extend the `queue.ts` import with `acknowledgeLanded`, and insert
these two branches immediately before the final `return { status: 404, ... }`:

```ts
  if (urlPath === "/api/cycle") {
    if (method !== "POST") return { status: 405, json: { error: "use POST" } };
    const parsed = parseBody(body);
    if (!parsed.ok) return { status: 400, json: { error: "body must be a json object" } };
    const mode = parsed.value.mode === undefined ? "full" : parsed.value.mode;
    if (mode !== "full" && mode !== "apply") {
      return { status: 400, json: { error: 'mode must be "full" or "apply"' } };
    }
    // The kill switch outranks the button.
    if (isPaused(ctx.paths)) {
      return { status: 409, json: { error: "the company is paused — unpause to run a cycle" } };
    }
    const result = await ctx.spawnCycle(mode);
    return { status: 200, json: { ok: result.ok, detail: result.detail } };
  }

  if (urlPath === "/api/undo") {
    if (method !== "POST") return { status: 405, json: { error: "use POST" } };
    const parsed = parseBody(body);
    if (!parsed.ok) return { status: 400, json: { error: "body must be a json object" } };
    const id = parsed.value.id;
    if (typeof id !== "string" || id.length === 0) {
      return { status: 400, json: { error: "id is required" } };
    }
    const record = readLanded(ctx.paths).find((r) => r.id === id);
    if (record === undefined) return { status: 404, json: { error: `no landed record "${id}"` } };
    const result = await ctx.gitRevert(record.sha);
    // Only clear the record once the revert actually succeeded, so a conflict
    // leaves the Undo button available rather than losing the sha.
    if (result.ok) acknowledgeLanded(ctx.paths, id);
    return { status: 200, json: { ok: result.ok, detail: result.detail } };
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/company/server.actions.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/company/server.ts test/unit/company/server.actions.test.ts
git commit -m "feat(company): run-a-cycle and undo-a-landed-commit routes"
```

---

### Task 8: The HTTP server

**Files:**
- Modify: `src/company/server.ts` (append `createBoardServer`)
- Test: `test/unit/company/server.http.test.ts`

**Interfaces:**
- Consumes: `route`, `BoardContext`.
- Produces: `createBoardServer(ctx: BoardContext): http.Server`. Callers bind it themselves with `server.listen(0, "127.0.0.1")`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/company/server.http.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { companyPaths, ensureCompanyDirs } from "../../../src/company/paths";
import { createBoardServer, BoardContext } from "../../../src/company/server";

let root: string;
let ctx: BoardContext;
let base: string;
let server: ReturnType<typeof createBoardServer>;
const KEY = "s3cret";

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-company-http-"));
  const paths = companyPaths(root);
  ensureCompanyDirs(paths);
  ctx = {
    paths,
    token: KEY,
    spawnCycle: vi.fn(async () => ({ ok: true, detail: "started" })),
    gitRevert: vi.fn(async () => ({ ok: true, detail: "reverted" })),
  };
  server = createBoardServer(ctx);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe("createBoardServer", () => {
  it("serves the page with the key", async () => {
    const res = await fetch(`${base}/?key=${KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<!doctype html>");
  });

  it("401s without the key", async () => {
    const res = await fetch(`${base}/api/queue`);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("returns the queue as json", async () => {
    const res = await fetch(`${base}/api/queue?key=${KEY}`);
    expect(await res.json()).toMatchObject({ pending: [], paused: false });
  });

  it("reads a posted body", async () => {
    const res = await fetch(`${base}/api/pause?key=${KEY}`, {
      method: "POST",
      body: JSON.stringify({ paused: true }),
    });
    expect(await res.json()).toEqual({ paused: true });
  });

  it("413s a body over the cap without processing it", async () => {
    const res = await fetch(`${base}/api/pause?key=${KEY}`, {
      method: "POST",
      body: "x".repeat(1024 * 1024 + 10),
    });
    expect(res.status).toBe(413);
  });

  it("sends no-store so a stale queue never renders", async () => {
    const res = await fetch(`${base}/api/queue?key=${KEY}`);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/company/server.http.test.ts`
Expected: FAIL — `createBoardServer` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/company/server.ts` (add `import * as http from "http";` at the top):

```ts
const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Drop what we have and keep draining. Destroying the request here would
        // race the 413 response and surface to the client as a socket error.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(new Error("body too large"));
        return;
      }
      resolve(chunks.length === 0 ? null : Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/**
 * Adapts `route()` to node:http. Bind it yourself — always to 127.0.0.1, never
 * to a public interface: this server can merge and revert commits.
 */
export function createBoardServer(ctx: BoardContext): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let body: string | null = null;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "body too large" }));
      return;
    }

    const result = await route(req.method ?? "GET", url.pathname, url.searchParams, body, ctx);
    const headers: Record<string, string> = { "cache-control": "no-store" };
    if (result.html !== undefined) {
      headers["content-type"] = "text/html; charset=utf-8";
      res.writeHead(result.status, headers);
      res.end(result.html);
      return;
    }
    headers["content-type"] = "application/json";
    res.writeHead(result.status, headers);
    res.end(JSON.stringify(result.json ?? {}));
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/company/server.http.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/company/server.ts test/unit/company/server.http.test.ts
git commit -m "feat(company): loopback http server with a body cap and a token gate"
```

---

### Task 9: The board page, the bundle, and end-to-end verification

**Files:**
- Modify: `src/company/boardHtml.ts` (replace the stub)
- Create: `src/company/boardMain.ts`
- Modify: `esbuild.js`, `vitest.config.ts`, `.vscodeignore`, `package.json` (`scripts` only)
- Test: `test/unit/company/boardHtml.test.ts`

**Interfaces:**
- Consumes: `createBoardServer`, `BoardContext`, `companyPaths`, `ensureCompanyDirs`.
- Produces: `boardHtml(): string`; the `dist/company-board.js` bundle; `npm run board`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/company/boardHtml.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { boardHtml } from "../../../src/company/boardHtml";

const html = boardHtml();

describe("boardHtml", () => {
  it("is a complete document", () => {
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("</html>");
  });

  it("embeds no token — the page reads the key from its own URL", () => {
    expect(html).toContain("location.search");
    expect(html).not.toContain("__TOKEN__");
  });

  it("escapes artifact content rather than trusting it", () => {
    expect(html).toContain("function esc(");
  });

  it("renders html artifacts in a sandboxed iframe with scripts off", () => {
    expect(html).toMatch(/sandbox\s*=\s*["']["']/);
  });

  it("wires all four verdict actions and the keyboard", () => {
    for (const needle of ["approve", "reject", "revise", "/api/decision", "keydown"]) {
      expect(html).toContain(needle);
    }
  });

  it("supports light and dark", () => {
    expect(html).toContain("prefers-color-scheme: dark");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/company/boardHtml.test.ts`
Expected: FAIL — the stub contains none of these.

- [ ] **Step 3: Replace `src/company/boardHtml.ts` with the real page**

The whole file is one exported template literal. Backticks and `${` inside the page
must be escaped as `\`` and `\${`.

```ts
/**
 * The board: a split master–detail page, served as one self-contained document.
 * Coverage-excluded like the other markup modules — its behaviour is verified by
 * the route tests and by manual review, not by asserting on strings.
 */
export function boardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Flow · Company</title>
<style>
  :root {
    --bg: #ffffff; --panel: #f6f7f9; --line: #d8dce3; --text: #14171c;
    --dim: #5d6572; --accent: #2f6feb; --fail: #c0392b; --ok: #1e7f4f;
    --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14171c; --panel: #1b1f26; --line: #2b313b; --text: #e6e9ef;
      --dim: #98a1b0; --accent: #6a9bff; --fail: #e56a5c; --ok: #56c48d;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: var(--bg); color: var(--text); }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 14px;
           border-bottom: 1px solid var(--line); background: var(--panel); }
  header h1 { font-size: 14px; font-weight: 600; margin: 0; }
  .spacer { flex: 1; }
  .pill { font-size: 12px; color: var(--dim); border: 1px solid var(--line);
          border-radius: 99px; padding: 2px 9px; }
  button { font: inherit; padding: 5px 12px; border: 1px solid var(--line);
           border-radius: 6px; background: var(--bg); color: var(--text); cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  main { display: flex; height: calc(100vh - 49px); }
  #list { width: 300px; border-right: 1px solid var(--line); overflow-y: auto; }
  #list .row { padding: 9px 12px; border-bottom: 1px solid var(--line); cursor: pointer; }
  #list .row:hover { background: var(--panel); }
  #list .row[aria-selected="true"] { background: var(--panel); box-shadow: inset 2px 0 0 var(--accent); }
  #list .role { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); }
  #list .t { display: block; margin-top: 2px; }
  #detail { flex: 1; overflow-y: auto; padding: 18px 22px; }
  #detail h2 { font-size: 17px; margin: 0 0 6px; }
  .why { color: var(--dim); margin: 0 0 14px; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
  .art { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-bottom: 16px; }
  .art .head { padding: 6px 10px; background: var(--panel); border-bottom: 1px solid var(--line);
               font-size: 12px; color: var(--dim); }
  .art pre { margin: 0; padding: 11px; overflow-x: auto; font-family: var(--mono); font-size: 12.5px; }
  .art iframe { width: 100%; height: 460px; border: 0; background: #fff; }
  .post { padding: 14px 16px; max-width: 34em; white-space: pre-wrap; }
  .d-add { color: var(--ok); } .d-del { color: var(--fail); } .d-hunk { color: var(--dim); }
  .checks { font-family: var(--mono); font-size: 12px; color: var(--dim); margin-bottom: 14px; }
  .acts { display: flex; gap: 8px; align-items: center; }
  .kbd { font-family: var(--mono); font-size: 11px; color: var(--dim); }
  textarea { width: 100%; min-height: 74px; margin: 10px 0; padding: 8px; font: inherit;
             background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px; }
  .hidden { display: none; }
  .strip { border-top: 1px solid var(--line); padding: 10px 12px; }
  .strip h3 { font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
              color: var(--dim); margin: 0 0 6px; }
  .strip .l { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; font-size: 13px; }
  .quar { color: var(--fail); }
  .empty { color: var(--dim); padding: 26px 0; }
</style>
</head>
<body>
<header>
  <h1>Agent Flow · Company</h1>
  <span class="pill" id="count">…</span>
  <span class="pill" id="cycle"></span>
  <span class="spacer"></span>
  <button id="runBtn">Run a cycle</button>
  <button id="pauseBtn">…</button>
</header>
<main>
  <div id="list"></div>
  <div id="detail"><p class="empty">Loading…</p></div>
</main>
<script>
const KEY = new URLSearchParams(location.search).get("key") || "";
let state = { pending: [], landed: [], quarantined: [], paused: false, lastCycle: null };
let sel = 0;

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function api(path, opts) {
  const glue = path.includes("?") ? "&" : "?";
  const res = await fetch(path + glue + "key=" + encodeURIComponent(KEY), opts);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function load() {
  const { body } = await api("/api/queue");
  state = body;
  if (sel >= state.pending.length) sel = Math.max(0, state.pending.length - 1);
  render();
}

function renderDiff(text) {
  return text.split("\\n").map(l => {
    const c = l.startsWith("+++") || l.startsWith("---") ? "d-hunk"
      : l.startsWith("@@") ? "d-hunk"
      : l.startsWith("+") ? "d-add"
      : l.startsWith("-") ? "d-del" : "";
    return '<span class="' + c + '">' + esc(l) + "</span>";
  }).join("\\n");
}

function renderMarkdown(text) {
  return esc(text)
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h2>$1</h2>")
    .replace(/^- (.*)$/gm, "• $1")
    .replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>")
    .replace(/\`(.+?)\`/g, '<code>$1</code>');
}

function renderList() {
  const list = document.getElementById("list");
  if (state.pending.length === 0 && state.quarantined.length === 0) {
    list.innerHTML = '<p class="empty" style="padding:14px">Nothing waiting on you.</p>';
  } else {
    list.innerHTML = state.pending.map((it, i) =>
      '<div class="row" data-i="' + i + '" aria-selected="' + (i === sel) + '">' +
      '<span class="role">' + esc(it.role.replace(/^company-/, "")) + "</span>" +
      '<span class="t">' + esc(it.title) + "</span></div>").join("");
  }
  if (state.quarantined.length > 0) {
    list.innerHTML += '<div class="strip"><h3>Could not be read</h3>' +
      state.quarantined.map(q =>
        '<div class="l quar">' + esc(q.file) + " — " + esc(q.error) + "</div>").join("") + "</div>";
  }
  if (state.landed.length > 0) {
    list.innerHTML += '<div class="strip"><h3>Landed on its own</h3>' +
      state.landed.map(r =>
        '<div class="l"><span>' + esc(r.title) + "</span>" +
        '<span class="spacer"></span><span class="kbd">' + esc(r.sha.slice(0, 7)) + "</span>" +
        '<button data-undo="' + esc(r.id) + '">Undo</button></div>').join("") + "</div>";
  }
  list.querySelectorAll("[data-i]").forEach(el =>
    el.onclick = () => { sel = Number(el.dataset.i); render(); });
  list.querySelectorAll("[data-undo]").forEach(el =>
    el.onclick = async () => {
      if (!confirm("Revert this commit?")) return;
      const { body } = await api("/api/undo", { method: "POST", body: JSON.stringify({ id: el.dataset.undo }) });
      if (!body.ok) alert(body.detail || body.error || "revert failed");
      load();
    });
}

async function renderDetail() {
  const d = document.getElementById("detail");
  const it = state.pending[sel];
  if (!it) { d.innerHTML = '<p class="empty">Nothing selected.</p>'; return; }

  const checks = it.checks
    ? '<div class="checks">' + Object.entries(it.checks)
        .map(([k, v]) => esc(k) + ": " + esc(v)).join(" · ") + "</div>"
    : "";

  d.innerHTML =
    "<h2>" + esc(it.title) + "</h2>" +
    '<p class="why">' + esc(it.why) + "</p>" +
    '<div class="meta"><span class="pill">' + esc(it.kind) + "</span>" +
      '<span class="pill">' + esc(it.role.replace(/^company-/, "")) + "</span>" +
      (it.branch ? '<span class="pill kbd">' + esc(it.branch) + "</span>" : "") +
      '<span class="pill">on approve: ' + esc(it.on_approve) + "</span></div>" +
    checks +
    '<div class="art" id="art"><div class="head">loading artifact…</div></div>' +
    '<textarea id="note" class="hidden" placeholder="What should change, and why"></textarea>' +
    '<div class="acts">' +
      '<button class="primary" id="ap">Approve</button>' +
      '<button id="rv">Revise…</button>' +
      '<button id="rj">Reject</button>' +
      '<span class="spacer"></span><span class="kbd">j k · a · v · r</span>' +
    "</div>";

  document.getElementById("ap").onclick = () => decide("approve");
  document.getElementById("rj").onclick = () => decide("reject");
  document.getElementById("rv").onclick = () => {
    const note = document.getElementById("note");
    if (note.classList.contains("hidden")) { note.classList.remove("hidden"); note.focus(); }
    else decide("revise");
  };

  const { status, body } = await api("/api/artifact?id=" + encodeURIComponent(it.id));
  const art = document.getElementById("art");
  if (status !== 200) {
    art.innerHTML = '<div class="head quar">' + esc(body.error || "could not read the artifact") + "</div>";
    return;
  }
  const head = '<div class="head">' + esc(body.type) +
    (body.truncated ? " · truncated" : "") + "</div>";
  if (body.type === "html") {
    art.innerHTML = head + '<iframe sandbox="" srcdoc="' + esc(body.content) + '"></iframe>';
  } else if (body.type === "diff") {
    art.innerHTML = head + "<pre>" + renderDiff(body.content) + "</pre>";
  } else if (body.type === "markdown") {
    art.innerHTML = head + '<div class="post">' + renderMarkdown(body.content) + "</div>";
  } else {
    art.innerHTML = head + '<div class="post">' + esc(body.content) + "</div>";
  }
}

async function decide(verdict) {
  const it = state.pending[sel];
  if (!it) return;
  const noteEl = document.getElementById("note");
  const note = noteEl ? noteEl.value : "";
  if (verdict === "revise" && note.trim() === "") { noteEl.focus(); return; }
  const { status, body } = await api("/api/decision", {
    method: "POST",
    body: JSON.stringify({ id: it.id, verdict, note }),
  });
  if (status !== 200) { alert(body.error || "could not record that"); return; }
  load();
}

function render() {
  document.getElementById("count").textContent = state.pending.length + " pending";
  document.getElementById("cycle").textContent = state.lastCycle || "no cycle yet";
  const pb = document.getElementById("pauseBtn");
  pb.textContent = state.paused ? "Paused — resume" : "Pause";
  pb.className = state.paused ? "primary" : "";
  document.getElementById("runBtn").disabled = state.paused;
  renderList();
  renderDetail();
}

document.getElementById("pauseBtn").onclick = async () => {
  await api("/api/pause", { method: "POST", body: JSON.stringify({ paused: !state.paused }) });
  load();
};
document.getElementById("runBtn").onclick = async () => {
  const { body } = await api("/api/cycle", { method: "POST", body: JSON.stringify({ mode: "full" }) });
  alert(body.detail || body.error || "started");
  load();
};

document.addEventListener("keydown", e => {
  if (e.target.tagName === "TEXTAREA") {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) decide("revise");
    return;
  }
  if (e.key === "j" && sel < state.pending.length - 1) { sel++; render(); }
  else if (e.key === "k" && sel > 0) { sel--; render(); }
  else if (e.key === "a") decide("approve");
  else if (e.key === "r") decide("reject");
  else if (e.key === "v") document.getElementById("rv").click();
});

load();
setInterval(load, 30000);
</script>
</body>
</html>`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/company/boardHtml.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Write the entry point**

Create `src/company/boardMain.ts`:

```ts
import * as crypto from "crypto";
import { spawn } from "child_process";
import type { AddressInfo } from "net";
import { companyPaths, ensureCompanyDirs } from "./paths";
import { createBoardServer, CycleMode, RunnerResult } from "./server";

const repoRoot = process.argv[2] ?? process.cwd();
const paths = companyPaths(repoRoot);
ensureCompanyDirs(paths);

/**
 * Phase B replaces this with a spawn of scripts/company-cycle.sh. Until then the
 * button tells the truth instead of failing silently.
 */
async function spawnCycle(_mode: CycleMode): Promise<RunnerResult> {
  return { ok: false, detail: "The cycle script arrives in phase B — nothing was started." };
}

function gitRevert(sha: string): Promise<RunnerResult> {
  return new Promise((resolve) => {
    const child = spawn("git", ["revert", "--no-edit", sha], { cwd: repoRoot });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", (e) => resolve({ ok: false, detail: e.message }));
    child.on("close", (code) =>
      resolve({ ok: code === 0, detail: out.trim() || `git revert exited ${code}` }),
    );
  });
}

const token = crypto.randomBytes(24).toString("hex");
const server = createBoardServer({ paths, token, spawnCycle, gitRevert });
const port = Number(process.env.BOARD_PORT ?? 0);

server.listen(port, "127.0.0.1", () => {
  const bound = server.address() as AddressInfo;
  process.stdout.write(`Company board: http://127.0.0.1:${bound.port}/?key=${token}\n`);
});
```

- [ ] **Step 6: Wire the bundle, the coverage exclusions, the ignore rule and the script**

In `esbuild.js`, add after `marketplaceConfig`:

```js
// The company board is private tooling: a Node bundle that never ships in the .vsix.
const boardConfig = {
  ...shared,
  entryPoints: ["src/company/boardMain.ts"],
  outfile: "dist/company-board.js",
  platform: "node",
  format: "cjs",
  target: "node18",
};
```

and add `boardConfig` to both arrays in `main()`:

```js
    const ctxs = await Promise.all([extensionConfig, webviewConfig, deckConfig, marketplaceConfig, boardConfig].map((c) => esbuild.context(c)));
```
```js
    await Promise.all([extensionConfig, webviewConfig, deckConfig, marketplaceConfig, boardConfig].map((c) => esbuild.build(c)));
```

In `vitest.config.ts`, add three entries to `coverage.exclude`:

```ts
        "src/company/types.ts",
        "src/company/boardHtml.ts",
        "src/company/boardMain.ts",
```

In `.vscodeignore`, add:

```
dist/company-board.js
dist/company-board.js.map
```

In `package.json`, add one line to `scripts` (touch nothing else in this file):

```json
    "board": "node dist/company-board.js",
```

- [ ] **Step 7: Verify the bundle does not ship**

```bash
npm run build
npx @vscode/vsce ls --no-dependencies | grep -c company-board
```
Expected: `0` (grep exits 1 when it matches nothing — that is the pass). If it
prints anything else, the `.vscodeignore` entry is wrong — fix it before continuing.

- [ ] **Step 8: End-to-end verification with fixture items**

Create one fixture per artifact type in the real repo, then drive the board by hand.

```bash
mkdir -p .claude/company/queue .claude/company/drafts .claude/company/landed
git diff HEAD~1 > .claude/company/drafts/sample.diff

cat > .claude/company/queue/sample-copy.json <<'JSON'
{"id":"sample-copy","cycle":"2026-07-31T17:09","role":"company-growth","kind":"copy",
 "title":"Landing page hero","why":"Betting the setup pain is the wedge.",
 "artifact":{"type":"markdown","inline":"# Stop setting up\n\nPick a task. **Agent Flow** opens the repos."},
 "risk":"gated","on_approve":"Write docs/landing/index.html next cycle"}
JSON

cat > .claude/company/queue/sample-code.json <<'JSON'
{"id":"sample-code","cycle":"2026-07-31T17:09","role":"company-feature-engineer","kind":"code",
 "title":"Persist the review-queue sort","why":"It resets every reload.",
 "artifact":{"type":"diff","path":".claude/company/drafts/sample.diff"},
 "risk":"gated","on_approve":"Merge company/persist-sort",
 "branch":"company/persist-sort",
 "checks":{"typecheck":"pass","test":"142 passed","coverage":"94.1%"}}
JSON

cat > .claude/company/queue/sample-mockup.json <<'JSON'
{"id":"sample-mockup","cycle":"2026-07-31T17:09","role":"company-designer","kind":"mockup",
 "title":"Deck empty state","why":"Today it is a blank box.",
 "artifact":{"type":"html","inline":"<h1 style='font:600 20px sans-serif'>Nothing in flight</h1><p>Take a task to start.</p>"},
 "risk":"gated","on_approve":"Open a PR against the Deck"}
JSON

cat > .claude/company/queue/sample-unknown.json <<'JSON'
{"id":"sample-unknown","cycle":"2026-07-31T17:09","role":"company-customer","kind":"podcast",
 "title":"An unknown kind must still render","why":"Forward compatibility check.",
 "artifact":{"type":"whatever","inline":"plain text fallback"},
 "risk":"gated","on_approve":"nothing"}
JSON

echo '{ broken' > .claude/company/queue/sample-broken.json

cat > .claude/company/landed/sample-landed.json <<JSON
{"id":"sample-landed","cycle":"2026-07-31T17:09","role":"company-architect",
 "title":"Dedupe the review-queue mappers","sha":"$(git rev-parse --short=10 HEAD)",
 "landed_at":"2026-07-31T17:41:02Z"}
JSON

npm run build && npm run board
```

Open the printed URL and confirm every one of these:

1. Four items in the list; `sample-broken.json` appears under **Could not be read**, not as a crash.
2. The markdown item renders headings and bold; the diff item is colored; the mockup renders in an iframe; the unknown kind renders as plain text.
3. `j`/`k` move the selection, `a` approves, `r` rejects, `v` opens the note box and `⌘↵` submits it.
4. Approving removes the card and appends a line to `.claude/company/decisions.jsonl`.
5. A revise with an empty note refuses to submit.
6. **Pause** disables *Run a cycle*; *Run a cycle* while unpaused reports the phase-B message.
7. The landed strip shows the commit; **Undo** asks first. Decline it — do not revert real history.
8. The page is readable in both light and dark (toggle your OS appearance).

- [ ] **Step 9: Clean up the fixtures and run the full suite**

```bash
rm -rf .claude/company/queue .claude/company/landed .claude/company/drafts .claude/company/decisions.jsonl
npm run typecheck && npm test && npm run test:cov
```
Expected: typecheck clean, all tests pass, coverage at or above the configured thresholds.

- [ ] **Step 10: Commit**

```bash
git add src/company/boardHtml.ts src/company/boardMain.ts test/unit/company/boardHtml.test.ts \
        esbuild.js vitest.config.ts .vscodeignore package.json
git commit -m "feat(company): the board page, its bundle, and the npm run board script"
```

---

## Done when

- `npm run typecheck`, `npm test` and `npm run test:cov` are all clean.
- `npm run board` serves a board that renders every artifact type and records verdicts.
- `npx vsce ls --no-dependencies` does not list `dist/company-board.js`.
- No company data files are tracked by git (`git status --short .claude/` shows nothing).
- Phase B's only integration point is `spawnCycle` in `src/company/boardMain.ts`.
