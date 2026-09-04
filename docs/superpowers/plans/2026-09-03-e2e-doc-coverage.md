# E2E Doc Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every behaviour the docs claim is proven by a real-host E2E journey, or cited to a lower-layer test, or marked untestable with a reason — and a Vitest test keeps that matrix true.

**Architecture:** A tested matrix file (`test-e2e/COVERAGE.md`) maps ~230 documented claims to proofs. The fixture connector gains an optional `config.json` for capability/failure toggles; forge shims gain verbs and a Bitbucket CLI; Claude Code state (sessions, transcripts) is seeded on disk. ~27 new `*.e2e.ts` files land in phases, each with a sabotage pair. CI shards the lane four ways and merges the evidence.

**Tech Stack:** Playwright `_electron` against pinned VS Code 1.96.2, Vitest, `/bin/sh` shims, GitHub Actions matrix + `playwright merge-reports`.

**Spec:** `docs/superpowers/specs/2026-09-03-e2e-doc-coverage-design.md`

## Global Constraints

- **Gates per task, all five:** `npm run typecheck`, `npm test` (timeout 600000, never piped through `tail`/`head`), `npm run test:ct`, `npm run build`, and the affected E2E file(s) via `npx playwright test -c playwright-e2e.config.ts test-e2e/<file>.e2e.ts`. Phase merges additionally run the FULL `npm run test:e2e`.
- **Existing 44 journeys pass unmodified.** Page-object (`test-e2e/_helpers/po/*.ts`) repairs are the only allowed edits to existing test infrastructure; never edit an existing `test("…")` body to go green.
- **Never break existing users:** `src/` changes here are confined to `src/tasks/fixture/connector.ts` (test-only connector, env-gated). Any other `src/` change is a product defect found by a test — pin the test with `test.fail()` and report it; do not fix product code in this plan.
- **One E2E run per machine at a time.** Before any `playwright test -c playwright-e2e.config.ts`, take the lock: `mkdir /private/tmp/claude-501/af-e2e.lock || (echo "another E2E run holds the lock"; exit 1)`; release with `rmdir` in a `trap` or immediately after. Vitest runs likewise must not overlap another vitest run.
- **Worktrees:** work in your assigned worktree with absolute paths; `.vscode-test` and `node_modules` are symlinks to `/Users/oznasi/dev/agent-flow/`. Never `cd` into the root checkout.
- **Sabotage pair per new spec file** in the same commit: `test-e2e/sabotage/<file>.patch` (a `git diff` of a hand-made `src/` break, then `git checkout src/`) and `<file>.expect` (one line: a distinctive substring of the target test's title). Verify by hand once: apply patch → `npm run build` → run the file → the named test FAILS → `git apply -R` → rebuild.
- **Mutation-check every new test** before commit (break the product path by hand, watch it fail, restore). Record the mutation you used in a one-line comment above the test: `// Mutation-checked: <what you broke>`.
- **Selectors are read from the component on the day**, cited in a comment (`DeckApp.tsx:214 on 2026-09-03`), and live in the page objects when reused by more than one file.
- **Vocabulary:** titles say "session" for a run of the tool; the tool is named ("Claude Code"). `test/unit/vocabulary.test.ts` scans `test-e2e/` too — check its allowlist before using the word "agent".
- **Git identity:** `-c user.name=oznasi1 -c user.email=oznasi1@gmail.com` on every commit. Commit message trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Copy rules:** no employer names, no `ASM-` keys; fixtures use `E2E-` / `PROJ-` keys and `fixture.invalid` hosts.
- **Screenshots:** every new test calls `shot(page, testInfo, "<n> · <label>")` at least once so the verify report carries a strip.

---

## Phase 1 — Infrastructure

### Task 1: Coverage matrix file and its Vitest guard

**Files:**
- Create: `test-e2e/COVERAGE.md`
- Create: `test/unit/e2eCoverage.test.ts`
- Modify: `CONTRIBUTING.md` (one paragraph under "## The E2E fixture connector")

**Interfaces:**
- Produces: the matrix grammar every later task appends rows to:
  `| \`<id>\` | <DOC § heading> | <claim> | <proof> |` where proof ∈ `e2e: <title substring>` · `ct: test-ct/<file>` · `unit: test/<path>` · `untestable: <reason>` · `todo` (allowed only while the file contains the heading `## Backfill in progress`).

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/e2eCoverage.test.ts
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

interface Row { id: string; doc: string; claim: string; proof: string; line: number }

/** Parse every 4-column table row whose first cell is a backticked id. Header and
 *  separator rows never match because their first cell is not backticked. */
export function parseMatrix(md: string): Row[] {
  const rows: Row[] = [];
  md.split("\n").forEach((line, i) => {
    const m = /^\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (m) rows.push({ id: m[1], doc: m[2], claim: m[3], proof: m[4], line: i + 1 });
  });
  return rows;
}

/** Every `test("…")` / `test.fail("…")` title in test-e2e/*.e2e.ts, with its file. */
export function e2eTitles(): { file: string; title: string }[] {
  const dir = path.join(ROOT, "test-e2e");
  const out: { file: string; title: string }[] = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".e2e.ts"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    // Titles are always string literals in this suite — a template literal would
    // defeat the substring contract sabotage/*.expect already relies on.
    for (const m of src.matchAll(/\btest(?:\.fail|\.skip|\.fixme)?\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) {
      out.push({ file: f, title: m[2] });
    }
  }
  return out;
}

const matrix = read("test-e2e/COVERAGE.md");
const rows = parseMatrix(matrix);
const backfilling = matrix.includes("## Backfill in progress");
const titles = e2eTitles();

describe("the E2E coverage matrix", () => {
  it("has rows", () => {
    expect(rows.length).toBeGreaterThan(100);
  });

  it("uses unique ids", () => {
    const seen = new Map<string, number>();
    for (const r of rows) {
      expect(seen.has(r.id), `duplicate id ${r.id} at lines ${seen.get(r.id)} and ${r.line}`).toBe(false);
      seen.set(r.id, r.line);
    }
  });

  it("uses only the proof grammar", () => {
    for (const r of rows) {
      const ok = /^(e2e|ct|unit|untestable): .+/.test(r.proof) || r.proof === "todo";
      expect(ok, `line ${r.line} (${r.id}): unrecognised proof "${r.proof}"`).toBe(true);
      if (r.proof === "todo") {
        expect(backfilling, `line ${r.line} (${r.id}): "todo" is only allowed under "## Backfill in progress"`).toBe(true);
      }
    }
  });

  it("points every e2e proof at exactly one real test title", () => {
    for (const r of rows.filter((r) => r.proof.startsWith("e2e: "))) {
      const needle = r.proof.slice("e2e: ".length);
      const hits = titles.filter((t) => t.title.includes(needle));
      expect(hits.length, `line ${r.line} (${r.id}): "${needle}" matched ${hits.length} titles: ${hits.map((h) => `${h.file}: ${h.title}`).join(" | ")}`).toBe(1);
    }
  });

  it("cites every E2E test from at least one row", () => {
    const needles = rows.filter((r) => r.proof.startsWith("e2e: ")).map((r) => r.proof.slice(5));
    for (const t of titles) {
      const cited = needles.some((n) => t.title.includes(n));
      expect(cited, `${t.file}: "${t.title}" is not cited by any COVERAGE.md row`).toBe(true);
    }
  });

  it("points ct:/unit: proofs at files that exist", () => {
    for (const r of rows.filter((r) => /^(ct|unit): /.test(r.proof))) {
      const p = r.proof.replace(/^(ct|unit): /, "");
      expect(fs.existsSync(path.join(ROOT, p)), `line ${r.line} (${r.id}): ${p} does not exist`).toBe(true);
    }
  });

  it("mentions every agentFlow.* setting in the manifest", () => {
    const pkg = JSON.parse(read("package.json")) as { contributes: { configuration: { properties: Record<string, unknown> } | { properties: Record<string, unknown> }[] } };
    const cfg = pkg.contributes.configuration;
    const props = Array.isArray(cfg) ? cfg.flatMap((c) => Object.keys(c.properties)) : Object.keys(cfg.properties);
    const text = rows.map((r) => `${r.id} ${r.claim}`).join("\n");
    for (const id of props.filter((p) => p.startsWith("agentFlow."))) {
      expect(text.includes(id), `setting ${id} has no COVERAGE.md row naming it`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/e2eCoverage.test.ts`
Expected: FAIL — `ENOENT … test-e2e/COVERAGE.md`.

- [ ] **Step 3: Write `test-e2e/COVERAGE.md`**

Head of the file, verbatim:

```markdown
# E2E coverage matrix

Every behaviour the docs claim, and what proves it. `test/unit/e2eCoverage.test.ts`
checks this file both ways: every `e2e:` proof names exactly one `test("…")` title in
`test-e2e/*.e2e.ts` (substring match, the same contract `sabotage/*.expect` uses), and
every E2E title is cited here. `ct:`/`unit:` proofs must exist on disk. `untestable:`
states why the real-host harness cannot honestly prove the claim. Every `agentFlow.*`
setting in the manifest must be named by some row.

Proof grammar: `e2e: <title substring>` · `ct: <path>` · `unit: <path>` · `untestable: <reason>`.

## Backfill in progress

Rows marked `todo` are being written under docs/superpowers/plans/2026-09-03-e2e-doc-coverage.md.
This heading — and every `todo` — is removed in that plan's last task.
```

Then one `## <Area>` section per inventory area (Sidebar/Tasks · Notepad · Deck · Review strip · Marketplace · Doctor & Setup · Orchestrator · Connectors · Forges · Providers × Surfaces · Settings · Telemetry & Privacy · Meta), each a table:

```markdown
| id | doc | claim | proof |
|----|-----|-------|-------|
```

Populate rows from the inventory in the spec's source session. The complete id list is in Appendix A of this plan — copy every id, its doc anchor and one-line claim. For proof, cite today's 44 journeys where they apply (Appendix B maps them), cite `unit:`/`ct:` where a documented claim is already proven there (e.g. `unit: test/unit/telemetry.test.ts` for the catalog rows — check the path exists), write `untestable: …` for the spec's Non-goals, and `todo` for everything else.

- [ ] **Step 4: Run the test until green**

Run: `npx vitest run test/unit/e2eCoverage.test.ts`
Expected: PASS (7 tests). Fix any row whose `e2e:` needle matches 0 or 2 titles by lengthening the needle.

- [ ] **Step 5: CONTRIBUTING pointer**

Append under `## The E2E fixture connector`:

```markdown
## The E2E coverage matrix

`test-e2e/COVERAGE.md` maps every documented behaviour to the test that proves it.
Adding a journey means adding (or updating) a row; `test/unit/e2eCoverage.test.ts`
fails when a title is uncited, a proof points nowhere, or a manifest setting has no row.
```

- [ ] **Step 6: Commit**

```bash
git add test-e2e/COVERAGE.md test/unit/e2eCoverage.test.ts CONTRIBUTING.md
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "test(e2e): coverage matrix of documented behaviour, checked both ways

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Fixture connector `config.json`

**Files:**
- Modify: `src/tasks/fixture/connector.ts`
- Test: `test/unit/tasks/fixture/connector.test.ts` (append a `describe`)
- Modify: `test-e2e/_helpers/sandbox.ts` (add `writeFixtureConfig`)

**Interfaces:**
- Produces:
  ```ts
  export interface FixtureConfig {
    supportedFilters?: Filter[];            // default ["mine","all","mysprint"]
    sizes?: boolean;                        // default false
    caps?: { sprints?: boolean; labels?: boolean; components?: boolean; children?: boolean }; // default all true
    me?: { id: string; displayName: string } | null;  // default {id:"fixture-user", displayName:"Fixture User"}
    statusTargets?: StatusTarget[];         // default the two shipped targets
    reject?: { moveTo?: { message: string; retryWith?: FieldPrompt[] } };
    failDetail?: string[];                  // keys whose detail() throws
  }
  ```
  and in `sandbox.ts`: `export function writeFixtureConfig(sb: Sandbox, cfg: FixtureConfig): void` (writes `<fixtureDir>/config.json`; call BEFORE `launchHost`).

- [ ] **Step 1: Write the failing tests** (append to `test/unit/tasks/fixture/connector.test.ts`)

```ts
describe("the fixture connector's config.json", () => {
  const cfg = (c: Record<string, unknown>) => fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(c));

  it("is byte-identical to the shipped defaults when absent", async () => {
    const c = makeFixtureConnector(dir);
    const p = c.provider();
    expect(p.caps.supportedFilters).toEqual(["mine", "all", "mysprint"]);
    expect(p.caps.sizes).toBe(false);
    expect(p.caps.sprints && p.caps.labels && p.caps.components && p.caps.children).toBeTruthy();
    expect(await p.me()).toEqual({ id: "fixture-user", displayName: "Fixture User" });
    expect((await p.statusTargets()).map((t) => t.id)).toEqual(["in-progress", "done"]);
  });

  it("drops capabilities the config turns off", () => {
    cfg({ supportedFilters: ["mine", "all"], sizes: true, caps: { sprints: false, labels: false, components: false, children: false } });
    const p = makeFixtureConnector(dir).provider();
    expect(p.caps.supportedFilters).toEqual(["mine", "all"]);
    expect(p.caps.sizes).toBe(true);
    expect(p.caps.sprints).toBeUndefined();   // absent, not false — the seam's contract
    expect(p.caps.labels).toBeUndefined();
    expect(p.caps.components).toBeUndefined();
    expect(p.caps.children).toBeUndefined();
  });

  it("answers me() from the config, including a name-only identity", async () => {
    cfg({ me: { id: "", displayName: "Nameless" } });
    expect(await makeFixtureConnector(dir).provider().me()).toEqual({ id: "", displayName: "Nameless" });
    cfg({ me: null });
    expect(await makeFixtureConnector(dir).provider().me()).toBeNull();
  });

  it("serves configured status targets and rejects moveTo with retryWith", async () => {
    const field = { kind: "pick" as const, id: "resolution", name: "Resolution", choices: [{ name: "Fixed" }] };
    cfg({ statusTargets: [{ id: "done", toName: "Done", toCategory: "done", fields: [field] }],
          reject: { moveTo: { message: "Resolution is required", retryWith: [field] } } });
    const p = makeFixtureConnector(dir).provider();
    expect(await p.statusTargets()).toEqual([{ id: "done", toName: "Done", toCategory: "done", fields: [field] }]);
    await expect(p.moveTo("E2E-1", "done", {})).rejects.toMatchObject({ name: "TaskWriteError", message: "Resolution is required", retryWith: [field] });
    // A rejection is still recorded, so a journey can prove the attempt was made.
    const lines = fs.readFileSync(path.join(dir, "writes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ op: "moveTo", key: "E2E-1", targetId: "done", rejected: true });
  });

  it("throws from detail() for keys listed in failDetail", async () => {
    cfg({ failDetail: ["E2E-1"] });
    await expect(makeFixtureConnector(dir).provider().detail("E2E-1")).rejects.toThrow(/E2E-1/);
  });

  it("re-reads the file on every call, so a journey can flip it mid-session", async () => {
    const p = makeFixtureConnector(dir).provider();
    expect((await p.statusTargets()).length).toBe(2);
    cfg({ statusTargets: [] });
    expect(await p.statusTargets()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/tasks/fixture/connector.test.ts`
Expected: the new `describe` fails (caps are constant today; `me()` ignores config).

- [ ] **Step 3: Implement**

In `src/tasks/fixture/connector.ts`:

```ts
import type { Filter } from "../../types";
import type { FieldPrompt } from "../fields";
import { TaskWriteError } from "../provider";

/** Optional `<dir>/config.json`. Every knob maps to one documented edge the E2E
 *  lane proves; an absent file is the shipped behaviour, byte-for-byte, so the
 *  journeys written before this existed are untouched. Re-read per call, like
 *  tasks.json, so a journey can flip a knob between two clicks. */
export interface FixtureConfig {
  supportedFilters?: Filter[];
  sizes?: boolean;
  caps?: { sprints?: boolean; labels?: boolean; components?: boolean; children?: boolean };
  me?: { id: string; displayName: string } | null;
  statusTargets?: StatusTarget[];
  reject?: { moveTo?: { message: string; retryWith?: FieldPrompt[] } };
  failDetail?: string[];
}

const DEFAULT_TARGETS: StatusTarget[] = [
  { id: "in-progress", toName: "In Progress", toCategory: "indeterminate", fields: [] },
  { id: "done", toName: "Done", toCategory: "done", fields: [] },
];
```

Inside `makeFixtureConnector`:

```ts
  const config = (): FixtureConfig => {
    const f = path.join(dir, "config.json");
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as FixtureConfig) : {};
  };
  const on = (k: keyof NonNullable<FixtureConfig["caps"]>) => config().caps?.[k] !== false;
```

Turn `caps` into a getter-backed object built per access — the seam allows a getter (`provider.ts` doc on `refreshCaps`), and the webview's `caps` message is derived from it once at init:

```ts
  const buildCaps = (): Capabilities => {
    const c = config();
    const caps: Capabilities = {
      supportedFilters: c.supportedFilters ?? ["mine", "all", "mysprint"],
      sizes: c.sizes ?? false,
    };
    if (on("labels")) caps.labels = { add: async (key, label) => { find(key); record({ op: "addLabel", key, label }); } };
    if (on("sprints")) caps.sprints = { /* unchanged bodies */ };
    if (on("components")) caps.components = { /* unchanged bodies */ };
    if (on("children")) caps.children = { /* unchanged body */ };
    return caps;
  };
  const provider: TaskProvider = {
    get caps() { return buildCaps(); },
    // list/status unchanged
    detail: async (key) => {
      if (config().failDetail?.includes(key)) throw new Error(`fixture: detail for ${key} is configured to fail`);
      /* unchanged */
    },
    statusTargets: async () => config().statusTargets ?? DEFAULT_TARGETS,
    moveTo: async (key, targetId, values) => {
      find(key);
      const rej = config().reject?.moveTo;
      if (rej) {
        record({ op: "moveTo", key, targetId, values, rejected: true });
        throw new TaskWriteError(rej.message, rej.retryWith ?? []);
      }
      record({ op: "moveTo", key, targetId, values });
    },
    me: async () => {
      const c = config();
      return c.me === undefined ? { id: "fixture-user", displayName: "Fixture User" } : c.me;
    },
  };
```

If `TaskProvider.caps` is typed as a plain property, a getter on an object literal still satisfies it. If `tsc` complains about `get caps()` on the literal, build the object with `Object.defineProperty`.

In `test-e2e/_helpers/sandbox.ts`:

```ts
import type { FixtureConfig } from "../../src/tasks/fixture/connector";
export type { FixtureConfig };

/** Configure the fixture connector's capabilities and failures. Call before
 *  `launchHost` for knobs the webview reads at init (caps, filters); knobs read
 *  per call (statusTargets, reject, failDetail, me) may be flipped mid-test. */
export function writeFixtureConfig(sb: Sandbox, cfg: FixtureConfig): void {
  fs.writeFileSync(path.join(sb.fixtureDir, "config.json"), JSON.stringify(cfg, null, 2));
}
```

`test-e2e/` importing a type from `src/` is fine — `import type` only.

- [ ] **Step 4: Run gates**

`npx vitest run test/unit/tasks/fixture/connector.test.ts` → PASS. Then `npm run typecheck`, `npm run build`, and (with the lock) `npx playwright test -c playwright-e2e.config.ts test-e2e/smoke.e2e.ts test-e2e/sidebar-actions.e2e.ts test-e2e/status-writeback.e2e.ts` → all pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/tasks/fixture/connector.ts test/unit/tasks/fixture/connector.test.ts test-e2e/_helpers/sandbox.ts
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "test(fixture): config.json toggles caps, identity, status targets and failures

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Forge shim verbs and the `atlassian-cli` shim

**Files:**
- Modify: `test-e2e/_helpers/forgeShim.ts`

**Interfaces:**
- Consumes: existing `installForgeShims(sb, { gh?, glab? })`, `ghPrListAnswer`, `ghReviewRequestsAnswer`, `expectNoUnknownForgeCalls`.
- Produces:
  ```ts
  export interface ShimAnswer { body?: unknown; exit?: number; stderr?: string }   // body → stdout JSON; default exit 0
  installForgeShims(sb, { gh?, glab?, "atlassian-cli"?: Record<string, ShimAnswer | unknown> })
  export function ghPrViewAnswer(o: { number: number; failing?: string[]; passing?: number; decision?: "APPROVED"|"CHANGES_REQUESTED"|"REVIEW_REQUIRED"; unresolved?: number; mergeable?: "MERGEABLE"|"CONFLICTING" }): unknown
  export function ghAuthStatusAnswer(logins: string[], active?: string): ShimAnswer   // gh prints auth status on STDERR
  export function ghReviewRequestsAnswer(reqs: Array<{ repo: string; number: number; title: string; author: string; createdAt: string; additions: number; deletions: number; changedFiles: number; isArchived?: boolean }>): unknown
  export function glabMrListAnswer(branch: string, o?: { changesCount?: string }): unknown
  export function glabMrGetAnswer(iid: number, o?: { pipelineStatus?: "success"|"failed"|"skipped"|null; changesCount?: string }): unknown
  export function bbHelpAnswer(mode: "passthrough" | "projected"): ShimAnswer
  export function forgeCalls(sb): { cli: string; argv: string[] }[]                  // parses calls.jsonl
  ```
- Signature rule unchanged: the first two argv words, non-alphanumerics → `_`. `bb api --help` therefore keys on `bb_api`; `bb pr list` on `bb_pr`. **Trap:** every `bb pr <verb>` shares the `bb_pr` signature — the shim script must fall through to a THIRD word for `atlassian-cli` (`sig=$(printf '%s_%s_%s' "$1" "$2" "$3" …)`), and `installForgeShims` must mangle likewise for that CLI only.

- [ ] **Step 1: Extend the shim script generator** so an answer file may be `{ "__exit": 1, "__stderr": "…", "__body": … }`. In the `/bin/sh` shim, after `cat`ing the file, use `node -e` to split it: simplest is to write THREE files per answer — `<cli>.<sig>.json` (stdout), `<cli>.<sig>.exit` (optional), `<cli>.<sig>.stderr` (optional) — and have the shim do:

```sh
f="$ANS/$cli.$sig"
if [ -f "$f.json" ]; then
  cat "$f.json"
  [ -f "$f.stderr" ] && cat "$f.stderr" >&2
  [ -f "$f.exit" ] && exit "$(cat "$f.exit")"
  exit 0
fi
```

- [ ] **Step 2: Write the answer builders** per the Interfaces block. `ghPrViewAnswer` must match the fields `src/engine/forge/github.ts` (or `src/engine/pr/*`) reads — grep `statusCheckRollup`, `reviewDecision`, `mergeable`, `reviewThreads` there and mirror the exact shape; cite the file and line in a comment. `glabMrGetAnswer` carries `head_pipeline` only on the GET, never on the list (see `deck-gitlab.e2e.ts`'s note). `bbHelpAnswer("projected")` returns `{ exit: 2, stderr: "error: unrecognized subcommand 'api'\n\nUsage: atlassian-cli bb <COMMAND>" }` (clap's wording — mirror what `src/engine/forge/bitbucket*.ts` matches on; grep `unrecognized`).

- [ ] **Step 3: Verify existing forge journeys still pass** (lock, then): `npx playwright test -c playwright-e2e.config.ts test-e2e/deck-github.e2e.ts test-e2e/deck-gitlab.e2e.ts test-e2e/review-launch.e2e.ts`. `npm run typecheck`.

- [ ] **Step 4: Commit**

```bash
git add test-e2e/_helpers/forgeShim.ts
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "test(e2e): forge shims answer merge, review, auth and Bitbucket verbs with exit codes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Claude Code state on disk

**Files:**
- Create: `test-e2e/_helpers/claudeState.ts`

**Interfaces:**
- Produces:
  ```ts
  export function seedSession(sb: Sandbox, o: { pid: number; cwd: string; id?: string }): string  // path written
  export type TranscriptShape = "working" | "ended-turn" | "idle" | "pending-tool" | "empty";
  export function seedTranscript(sb: Sandbox, o: { cwd: string; sessionId: string; shape: TranscriptShape; ageMs?: number }): string
  export function encodeProjectDir(cwd: string): string   // re-export from src/engine/transcript.ts (import type-free function is fine: transcript.ts is Node-side)
  ```
- Consumes: `src/engine/sessions.ts` (`pid`, `cwd`, `pidAlive`), `src/engine/transcript.ts` (`type`, `timestamp`, `message.stop_reason`, `message.model`, `isSidechain`, the 200-line tail, the thresholds it documents — read them and set `ageMs` defaults so `working` reads as working and `idle` as idle).

- [ ] **Step 1: Read the two readers** and copy the exact record shapes into the helper's doc comment with line citations. The pid for a live session is `launched.app.process().pid` — Electron's main process, alive for the test's life.

- [ ] **Step 2: Write the helper.** Transcript lines (minimal, as `transcript.ts` reads them):

```ts
const line = (type: "user" | "assistant", at: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, timestamp: new Date(at).toISOString(), isSidechain: false, ...extra });
const assistant = (at: number, stop: "end_turn" | "tool_use") =>
  line("assistant", at, { message: { model: "claude-fixture", stop_reason: stop, content: stop === "tool_use" ? [{ type: "tool_use", name: "Bash" }] : [] } });
const shapes: Record<TranscriptShape, (now: number, age: number) => string[]> = {
  "working":      (now, age) => [line("user", now - age - 2000), assistant(now - age - 1000, "tool_use"), line("user", now - age)],
  "pending-tool": (now, age) => [line("user", now - age - 1000), assistant(now - age, "tool_use")],
  "ended-turn":   (now, age) => [line("user", now - age - 1000), assistant(now - age, "end_turn")],
  "idle":         (now, age) => [line("user", now - age - 1000), assistant(now - age, "tool_use"), line("user", now - age)],  // age must exceed the idle threshold in transcript.ts
  "empty":        () => [],
};
```

Write to `path.join(sb.home, ".claude", "projects", encodeProjectDir(cwd), `${sessionId}.jsonl`)`. Sessions to `path.join(sb.home, ".claude", "sessions", `${id}.json`)` with `{ pid, cwd, sessionId: id }` plus whatever other fields `RawSession` reads.

- [ ] **Step 3: Unit-check the shapes against the real reader** — add `test/unit/engine/claudeStateFixture.test.ts` that imports `seedTranscript` (it only needs a `{home}`-shaped sandbox; pass a temp dir cast) and the real `readActivity`/equivalent from `transcript.ts`, and asserts `working` → working, `ended-turn` → ended/needs-you, `idle` → idle. This is what stops the E2E journeys from encoding a wrong shape.

- [ ] **Step 4: Gates** — `npx vitest run test/unit/engine/claudeStateFixture.test.ts`, `npm run typecheck`, `npm run build` (the helper is not in a browser bundle, but the build is a gate anyway).

- [ ] **Step 5: Commit**

```bash
git add test-e2e/_helpers/claudeState.ts test/unit/engine/claudeStateFixture.test.ts
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "test(e2e): seed Claude Code sessions and transcripts on disk, shapes checked against the reader

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Shard the E2E lane in CI and merge the evidence

**Files:**
- Modify: `.github/workflows/e2e.yml`
- Modify: `playwright-e2e.config.ts` (reporter switch on `PW_BLOB`)
- Modify: `package.json` scripts (`e2e:merge`)

- [ ] **Step 1: Reporter switch.** In `playwright-e2e.config.ts`, when `process.env.PW_BLOB` is set use `[["blob", { outputDir: "blob-report" }], ["list"]]`; otherwise today's reporters. Local behaviour unchanged.

- [ ] **Step 2: Workflow.** Replace the single `e2e` job with:

```yaml
jobs:
  shard:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix: { shard: [1, 2, 3, 4] }
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - uses: actions/cache@v6
        with:
          path: .vscode-test
          key: vscode-test-${{ runner.os }}-${{ hashFiles('test-e2e/_helpers/host.ts', 'test-e2e/_helpers/claudeCode.ts', 'test-e2e/_helpers/copilotChat.ts') }}
      - run: npm run build
      - run: xvfb-run -a npx playwright test -c playwright-e2e.config.ts --shard=${{ matrix.shard }}/4
        env: { PW_BLOB: "1" }
      - uses: actions/upload-artifact@v7
        if: always()
        with: { name: blob-${{ matrix.shard }}, path: blob-report/, retention-days: 1 }
      - uses: actions/upload-artifact@v7
        if: failure()
        with: { name: playwright-e2e-traces-${{ matrix.shard }}, path: test-results/, retention-days: 7 }

  e2e:   # the REQUIRED check keeps its name
    needs: shard
    if: always()
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: write }
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - uses: actions/download-artifact@v7
        with: { pattern: blob-*, path: all-blobs, merge-multiple: true }
      - run: npx playwright merge-reports --reporter json,html all-blobs
        env: { PLAYWRIGHT_JSON_OUTPUT_NAME: test-results/e2e-results.json, PLAYWRIGHT_HTML_OUTPUT_DIR: playwright-e2e-report }
      # …then the existing verify-report, sticky-comment and upload steps unchanged…
      - name: Gate on the shards
        if: needs.shard.result != 'success'
        run: exit 1
```

Keep the existing comments in the file where they still apply (the cache-key comment, the sticky-comment comment). Confirm the branch-protection required check is named `e2e` (`gh api repos/oznasi1/agent-flow/branches/main/protection --jq '.required_status_checks.contexts'`) — if it is `E2E (real host) / e2e`, the job id above already matches.

- [ ] **Step 3: Verify locally what can be verified.** `PW_BLOB=1 npx playwright test -c playwright-e2e.config.ts --shard=1/4 test-e2e/smoke.e2e.ts` writes `blob-report/*.zip`; `npx playwright merge-reports --reporter json blob-report > /dev/null` succeeds. `npm run typecheck`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/e2e.yml playwright-e2e.config.ts package.json
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "ci(e2e): four shards, merged evidence, one required check

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phases 2–6 — Journeys

Every task below has the same shape, so the shape is stated once:

1. Read the cited components and the existing journey nearest in shape (named per task). Copy its sandbox/settings pattern; never a seam.
2. For each row in the task's table, write the test **title exactly as given** (the matrix already cites it), add the `// Mutation-checked:` line, drive the real UI, assert the **assertion of record** (a file, a `writes.jsonl` line, a `calls.jsonl` line, or a DOM fact — in that order of preference), and `shot()` at least once.
3. If the harness cannot honestly prove a row, change its matrix proof to `untestable: <reason>` and delete the title from this plan's table in the same commit; never weaken the test.
4. If the product contradicts the doc, pin with `test.fail(...)` and add `// Pinned: <what the product does instead>`; the matrix row still cites the title.
5. Sabotage pair aimed at the row marked **★**.
6. Update the row(s) in `test-e2e/COVERAGE.md` from `todo` to `e2e: <title>`; `npx vitest run test/unit/e2eCoverage.test.ts` must pass.
7. Gates, then one commit per spec file.

Shared-host files use `describeWithHost(title, settings, ctx => …)` and must leave the UI where the next test expects it (see `notepad.e2e.ts`'s `backToTasks`). Per-test files use the `makeSandbox`/`launchHost`/`afterEach close` pattern of `take-task.e2e.ts`.

### Phase 2 — Sidebar and launch

### Task 6: `pool-lenses.e2e.ts` (shared host ×3 configs)

Nearest: `sidebar-actions.e2e.ts`. Components: `src/webview/App.tsx` (the `Task filter` group, size/status/repo lenses, search input).

Three `describeWithHost` blocks, each with its own `writeFixtureConfig` in a `beforeAll` registered **before** `describeWithHost`'s launch — not possible (its `beforeAll` launches first). Instead add an optional 4th argument to `describeWithHost`: `prepare?: (sb: Sandbox) => void`, run between `makeSandbox` and `launchHost`. That is a one-line, backward-compatible helper change.

| title | config / settings | action | assertion of record | mutation |
|---|---|---|---|---|
| ★ `only the lenses the connector declares render` | default fixture | open pool | `Task filter` group has buttons `Mine`, `My sprint`; `Unassigned`, `Sprint`, `Backlog` count 0 (never disabled — `toHaveCount(0)`) | make App render every Filter regardless of caps |
| `dropping mysprint from supportedFilters removes that lens` | `{supportedFilters:["mine","all"]}` | open pool | `My sprint` count 0, `Mine` visible | — |
| `the "all" filter never renders as a sixth tab` | `{supportedFilters:["mine","all","mysprint","unassigned","sprint","backlog"]}` | open pool | exactly 5 buttons in the group; none named `All` | — |
| `defaultFilter picks the lens the panel opens on` | settings `agentFlow.defaultFilter:"mysprint"` | open pool | `My sprint` has `aria-pressed="true"` | — |
| `the size lens renders only when the connector has estimates` | block A `sizes:false` → absent; block B `{sizes:true}` + tasks with `estimateSeconds` 3600/28800/86400 | click `L` | S/M/L control present iff sizes; `L` shows 1 card (8h day: 86400s = 3d) | — |
| `filters.status false hides the status lens` | `agentFlow.filters.status:false` | open pool | status lens locator count 0 | — |
| `filters.repo false hides the repo lens` | `agentFlow.filters.repo:false` | open pool | `.repo-select-trigger` count 0 | — |
| `title search narrows the pool fuzzily` | default | type `landng gear` | 1 card, `E2E-2` | — |
| `the repo lens narrows the pool to tasks inferred onto that repo` | default + a second repo `telemetry` (copy the `beforeAll` from sidebar-actions) | select `telemetry` | only `E2E-1` (summary contains "telemetry") | — |

### Task 7: `pool-writes-edges.e2e.ts` (shared host ×3 configs)

Nearest: `sidebar-actions.e2e.ts`, `status-writeback.e2e.ts`. Components: `App.tsx` card actions, `tasksView.ts` `stampProvenance`, `changeStatus`, `src/tasks/fields.ts` prompts.

| title | config / settings | action | assertion of record | mutation |
|---|---|---|---|---|
| `without sprints there is no add, remove or reorder affordance` | `{caps:{sprints:false}}` | open pool, `My sprint` lens | no `add to my sprint` button, no remove button, `.grip` count 0 | — |
| ★ `a labels-less connector accepts a status change with no provenance stamp` | `{caps:{labels:false}}` | change status → Done | `writes.jsonl` has `moveTo`, has NO `addLabel`; no error toast | make stampProvenance throw when caps.labels absent |
| `stampLabelOnWrite off skips the provenance label` | `agentFlow.stampLabelOnWrite:false` | add to sprint | `addToSprint` line, no `addLabel` | — |
| `provenanceLabel names the label that is stamped` | `agentFlow.provenanceLabel:"e2e-bot"` | add to sprint | `addLabel` line with `label:"e2e-bot"` | — |
| `a name-only identity refuses the sprint write and says so` | `{me:{id:"",displayName:"Fixture User"}}` | add to sprint | toast contains `Couldn't resolve your Fixture account`; no `addToSprint` line | — |
| `zero status targets is an info toast, not an error` | `{statusTargets:[]}` (write mid-test, then click) | click status | notification text `No status transitions available for E2E-1`; not an error-severity notification | — |
| `a status target with a field prompts for it and sends the value` | `{statusTargets:[done with pick field resolution]}` | click status → Done → pick `Fixed` | `moveTo.values.resolution` equals the choice (`Fixed` or its id — read `changeStatus` to see which) | — |
| `a rejected write re-prompts only the field it names` | `{statusTargets:[done, fields:[]], reject:{moveTo:{message, retryWith:[resolution pick]}}}` | click status → Done → (re-prompt appears) → pick → (write `config.json` without `reject` before second attempt) | first `moveTo` line `rejected:true` with `values:{}`, second line has `values.resolution` | — |
| `a task whose detail cannot be fetched shows a toast, not a blank panel` | `{failDetail:["E2E-2"]}` | click `E2E-2` card | error notification visible; card still in pool | — |
| `Add to my sprint is absent on a task assigned to someone else` | tasks.json: `E2E-2.assignee:"Someone Else"` | open pool | `E2E-1` has the button, `E2E-2` does not | — |
| `Remove from sprint offers Undo, and Undo puts the card back` | default, `My sprint` lens | remove `E2E-2` → click `Undo` | card count back to 2; `writes.jsonl` has `removeFromSprint` then `addToSprint` for `E2E-2` (read the undo handler to confirm which op it records) | — |

### Task 8: `take-prompts.e2e.ts` (per test)

Nearest: `take-task.e2e.ts`, `worktree-take.e2e.ts`. Components: `tasksView.ts` (`choosePromptMode`, `chooseWorktree`), `src/engine/openTarget.ts`, `src/engine/workspace.ts`, `src/engine/worktree.ts`.

Settings per test: start from the sandbox contract and **remove** the pre-answer for the one prompt under test by overriding it (e.g. `"agentFlow.taskMode": ""` — check `config.ts` for the "unset" value; if the empty string is not recognised as unset, use `undefined`-equivalent by deleting the key: add `makeSandbox` support for `settingsOverride` values of `null` meaning "delete").

| title | settings | action | assertion of record | mutation |
|---|---|---|---|---|
| ★ `taking a task asks how the session should start, listing the six built-in modes` | taskMode unset | Take → picker | QuickPick rows contain `Plan first`, `Implementation`, `Test-driven`, `Investigate`, `Orchestrator`, `Refine the ticket` | drop one built-in from the list |
| `a promptModes entry overrides a built-in's label without replacing the rest` | `promptModes:[{id:"implementation",label:"Just build it"}]` | picker | `Just build it` present; other five still present | — |
| `a hidden prompt mode is dropped from the picker` | `promptModes:[{id:"tdd",hidden:true}]` | picker | `Test-driven` count 0; five rows | — |
| `a custom prompt mode lands its prompt in the brief` | `promptModes:[{id:"e2e",label:"E2E mode",prompt:"E2E-MODE-MARKER"}]`, taskMode `e2e` | Take | `.pick-task/TASK.md` contains `E2E-MODE-MARKER` | — |
| `worktree "ask" offers the choice and "always" lands under .claude/worktrees, git-excluded` | `worktree:"ask"` | Take → pick worktree | worktree path `<repo>/.claude/worktrees/E2E-1*`; `<repo>/.git/info/exclude` contains `.claude/worktrees` (or whatever `worktree.ts` writes) | — |
| `the brief directory is git-excluded so it can never be committed` | default | Take | `git -C <repo> check-ignore .pick-task/TASK.md` exits 0 | — |
| `openIn "ask" lists a new window, this window and a saved workspace` | `openIn:"ask"` | Take → destination picker | rows include `New window`, `This window`, `.code-workspace`-ish (read `openTarget.ts` labels) | — |
| `this-window in a window it cannot name opens a new window instead` | `openIn:"this-window"` (host opened with no folder) | Take | a second `BrowserWindow` appears (`app.windows().length` 2); plan file written | — |
| `pick-existing adds only approved repos and skips same-name folders` | `openIn:"pick-existing"`, a pre-made `<workspaceDir>/team.code-workspace` with a folder named `rocket`, plus a second repo `telemetry` inferred | Take → pick `team` → approve `telemetry` | file gains `telemetry`, keeps one `rocket`; toast names the skipped one; declining leaves the file byte-identical (second test run with Cancel) | — |
| `multiroot mode writes <KEY>.code-workspace into workspaceDir` | `workspaceMode:"multiroot"`, two repos | Take | `<workspaceDir>/E2E-1.code-workspace` exists with two folders | — |

### Task 9: `explore-modes.e2e.ts` (shared host)

Nearest: `sidebar-actions.e2e.ts` Explore test. Components: `tasksView.ts` `chooseExploreAction`, `src/config.ts` `explorePrompts`, `environments`.

| title | settings | action | assertion of record | mutation |
|---|---|---|---|---|
| ★ `Explore offers the six documented session kinds` | exploreMode unset | Explore | picker rows `Open a Jira ticket`, `Enhance knowledge`, `Debug`, `General`, `Supervise running tasks`, `Verify on an environment` | drop one |
| `Verify on an environment asks which, from the environments setting plus Custom` | `environments:["dev","qa"]` | pick Verify | env picker rows `dev`, `qa`, `Custom…` | — |
| `a verify session is seeded read-only against the chosen environment` | as above | pick `qa` → topic → repo | plan prompt contains `qa` and the read-only wording from `explorePrompts.verify` default (quote the exact substring from `config.ts`) | — |
| `an explorePrompts override lands in the plan` | `explorePrompts.general:"E2E-EXPLORE-MARKER {topic}"`, exploreMode `general` | Explore → topic | plan prompt contains `E2E-EXPLORE-MARKER` | — |

### Task 10: `remote-control.e2e.ts` (per test)

Nearest: `copilot-fallback.e2e.ts`, `seed-terminal.e2e.ts`. Components: `workspace.ts` remote-control branch, `tasksView.ts` remote-control pick.

| title | settings | action | assertion of record | mutation |
|---|---|---|---|---|
| ★ `Copilot with Remote Control on refuses the launch before any worktree exists` | `agentProvider:"copilot"`, `remoteControl:"on"`, `worktree:"always"` | Take | error notification visible; `git worktree list` unchanged; no plan file; no second window | remove the refusal |
| `Remote Control is skipped for a multi-repo per-window take and the toast says so` | `remoteControl:"on"`, `agentSurface:"terminal"`, two repos inferred | Take | notification contains `skipped`; terminal shows the prompt, not `/remote-control` | — |
| `Remote Control pre-fills the slash command and puts the prompt on the clipboard` | `remoteControl:"on"`, terminal surface, one repo, macOS only (`test.skip(process.platform !== "darwin")`) | Take | terminal text contains `/remote-control E2E-1`; `pbpaste` contains `Jira E2E-1` | — |

### Task 11: `surface-edges.e2e.ts` (per test)

Nearest: `seed-terminal.e2e.ts`, `batch-take.e2e.ts`, `copilot-panel.e2e.ts`.

| title | settings | action | assertion of record | mutation |
|---|---|---|---|---|
| ★ `a terminal surface with no CLI on PATH says command not found and keeps the prompt` | `agentSurface:"terminal"`; delete `bin/claude` before launch | Take | terminal text contains `command not found` AND `Jira E2E-1` | seed only after the CLI check passes |
| `agentProvider "ask" asks which tool per launch` | `agentProvider:"ask"` | Take | QuickPick with `Claude Code`, `Copilot` (and `Cursor` only on the cursor host) rows; pick Claude → `CLAUDE-SHIM-READY` in terminal | — |
| `a batch under "ask" asks once and uses the answer for every task` | `agentProvider:"ask"`, terminal | batch 2 tasks | exactly one provider QuickPick; both windows' terminals show `CLAUDE-SHIM-READY` | — |
| `a Copilot extension-surface batch writes every brief, seeds no panel, and says why` | `agentProvider:"copilot"`, `agentSurface:"extension"` (+ `installCopilotChat`) | batch 2 | both `TASK.md` exist; notification about briefs; no Copilot chat welcome in either window | — |
| `a batch larger than the threshold asks first` | `batchLaunchConfirmThreshold:1`, 2 tasks | batch | modal (`window.dialogStyle:"custom"`) visible naming 2; Cancel → no windows | — |
| `a task touching none of the filtered repos launches in all of them` | tasks.json third task `E2E-3` with no repo words | filter `rocket`, tick E2E-3 + E2E-1, launch | `E2E-3` gets a brief in `rocket` | — |
| `a shared-window batch stacks every task in one window` | default | batch 2 → layout `one shared window` | windows +1 only; both worktrees; both briefs; 2 plan files | — |

### Task 12: `address-pr-edges.e2e.ts` (per test)

Nearest: `address-pr.e2e.ts`.

| title | settings | action | assertion of record | mutation |
|---|---|---|---|---|
| ★ `Address PR appears only when the status matches prReviewStatus, case-insensitively` | `prReviewStatus:"to do"` (task status `To Do`) vs `prReviewStatus:"Done"` | open pool | `button.address-pr` count 1 vs 0 | compare case-sensitively |
| `prReviewAutoFix off seeds an assess-only prompt` | `prReviewAutoFix:false` + status match | Address PR | plan prompt lacks the implement instruction, has the assess wording (quote from `config.ts`) | — |
| `a custom prReviewPrompt is what gets seeded` | `prReviewPrompt:"E2E-PR-MARKER {key}"` | Address PR | plan prompt contains `E2E-PR-MARKER E2E-1` | — |

### Phase 3 — Deck

### Task 13: `deck-signal.e2e.ts` (per test)

Nearest: `deck-lifecycle.e2e.ts` (`seedRun`/`baseRun` — copy them, as `workflows.e2e.ts` did). Helpers: `claudeState.ts`. Components: `src/engine/visibility.ts`, `src/engine/activity.ts`, `DeckApp.tsx` columns, `deckView.ts` notify.

A run's session is matched by `cwd` = the run's repo path. Seed a session with `pid: app.process().pid` and a transcript for that cwd.

| title | setup | assertion of record | mutation |
|---|---|---|---|
| ★ `a session mid-work reads working on its card and sits in In progress` | run + session + `working` transcript | card text matches `/working/`; card inside the `In progress` column | swap working/idle classification |
| `a session that ended its turn lands the card in Action required` | `ended-turn` | card in `Action required` column; `ended turn` text | — |
| `a run with no transcript reads parked` | run + session, no transcript | card text `parked` | — |
| `notifyOnActionRequired raises one notification per park, coalescing several` | setting on; two runs `ended-turn` | exactly one `.notification-list-item` mentioning both keys (or a count of 2); flip one transcript to `working` then back to `ended-turn` → a second notification | — |
| `the activity-bar badge counts waiting runs whether or not notifications are on` | setting off; one `ended-turn` | `.activitybar [aria-label*="Agent Flow"] .badge-content` text `1` | — |
| `a Copilot run gets the backbone but no session` | run with `provider:"copilot"` (read the run shape) + a transcript for its cwd | card has branch text, no live-signal text | — |

### Task 14: `deck-open-agents.e2e.ts` (per test)

| title | setup | assertion of record | mutation |
|---|---|---|---|
| ★ `a live session in an untracked directory is a local card` | no run; session cwd = a fresh git repo `scratch` on branch `main` | a `.card` containing `local` | ignore sessions with no run |
| `a local card on a ticket-shaped branch shows an inferred key only when a Jira project is set` | branch `PROJ-5641-team-table`; A: `jira.project:"PROJ"` → `PROJ-5641` + `~inferred`; B: `jira.project:""` → no key | — | — |
| `Track it pins a local card to the runs store` | local card → ⋯ → Track it | `~/.agentflow/runs/*.json` gains a file whose `repos[0].path` is `scratch` | — |
| `openAgents off removes local cards without reopening the panel` | local card visible → write `openAgents:false` into settings.json | card count 0 within 15s | — |
| `a local card disappears when its last session dies` | session with pid of a spawned `sleep 600` child; kill it | card gone within 15s | — |

### Task 15: `deck-board.e2e.ts` (per test)

| title | setup | assertion of record | mutation |
|---|---|---|---|
| `a closed run collapses into the Recently closed strip` | `baseRun` 72h old + `closedAt` 1h ago, `retireClosedAfterHours:24` | `.card` count 0; strip contains the key; expanding lists it | — |
| `inflightShowAll renders every record as a card` | same + setting true | `.card` count 1 | — |
| ★ `the Sessions / Workspaces grouping sticks across a reopen` | two sessions in one worktree (two transcripts, two session files) | `agents`: 2 cards; switch to Workspaces: 1 card; close panel, `Deck.open` again: still 1 | don't persist the grouping |
| `Open focuses an already-open window instead of duplicating it` | run whose repo is open in a second window (take a task first) | click Open twice → `app.windows().length` unchanged | — |
| `Diff opens the working diff` | run with an uncommitted change | click Diff → an editor tab titled with the file name / `Working Tree` | — |
| `the overflow menu offers Open in Jira and Forget` | run | ⋯ → menu rows | — |
| `header tiles count what the columns hold` | 1 working + 1 ended-turn | `In progress` tile 1, `Action required` tile 1 | — |
| `the refresh control reports when it last synced` | any | `.stats` text matches `/synced \d+s ago/` | — |

### Task 16: `deck-merge.e2e.ts` (per test + gh shim)

Nearest: `deck-github.e2e.ts` (origin remote + `refs/remotes/origin/HEAD` fabrication). Shim: `pr list` ready PR, `pr view`, `pr merge` (records argv), `auth status`.

| title | settings / shim | assertion of record | mutation |
|---|---|---|---|
| `mergeWrites off shows no Merge button on a ready PR` | default | no `Merge` button | — |
| ★ `Merge confirms with the repo, number and strategy, then runs gh pr merge` | `mergeWrites:true`, `window.dialogStyle:"custom"` | dialog text contains `rocket`, `#41`, `squash`; confirm → `calls.jsonl` has `gh pr merge 41 --squash …`; Output channel line (open `Agent Flow Deck` output via palette and read the editor text) | skip the dialog |
| `cancelling the merge dialog runs nothing` | same | Cancel → no `pr merge` call | — |
| `mergeMethod is named in the dialog and passed to gh` | `mergeMethod:"rebase"` | dialog says `rebase`; argv has `--rebase` | — |
| `two ready PRs across repos show no Merge button` | two repos, both `pr list` answers ready | no button | — |
| `a sibling repo still holding an open PR blocks Merge` | repo B `pr list` open but not approved | no button | — |
| `GitLab refuses a rebase merge naming the setting` | `forge:"gitlab"`, glab shims, `mergeMethod:"rebase"`, `mergeWrites:true` | error notification contains `agentFlow.mergeMethod`; no `merge` PUT in `calls.jsonl` | — |
| `a merge failure reaches the user and the output channel` | `pr merge` answer `exit:1, stderr:"Pull request is not mergeable"` | notification contains that text; output channel contains it | — |

### Task 17: `deck-pr-work.e2e.ts` (per test + gh shim)

| title | settings / shim | assertion of record | mutation |
|---|---|---|---|
| ★ `failing required checks pull a working session into fixes needed` | `pr view` with `failing:["build"]`; `working` transcript | card in `In review` column, lane label `fixes needed` | ignore check state while working |
| `Fix CI seeds a session pointed at the brief by absolute path` | `prWorkOpenIn:"this-window"` | plan prompt contains `/…/.pick-task/` absolute path and `build` | — |
| `Resolve conflict and Address review seed their own prompts` | `mergeable:"CONFLICTING"`; `decision:"CHANGES_REQUESTED"` | plan prompts differ and name the situation | — |
| `prWorkOpenIn its-window asks nothing` | `its-window` | no QuickPick appears before the plan file lands | — |
| `the Deck's Address PR re-seeds the run's workspace in place` | run in-place (worktree never) | no new worktree; plan cwd = repo path | — |
| `a failing PR read shows PR unread and counts it in the footer` | `pr list` `exit:1` | card contains `⚠ PR unread`; footer contains `1` | — |
| `turning prFacts off drops PR facts and darkens the review strip live` | start on; write `prFacts:false` | `.rv-row` count 0 and PR block gone within 15s | — |

### Phase 4 — Review strip and forges

### Task 18: `review-strip.e2e.ts` (per test + gh shim)

Nearest: `review-launch.e2e.ts`. Shim `api graphql` with 3 requests: #41 (old, small), #42 (new, big), #43 in an `isArchived` repo, #44 in a repo not checked out.

| title | assertion of record | mutation |
|---|---|---|
| ★ `the strip omits requests from archived repositories` | rows for 41, 42, 44; none for 43 | drop the archived filter |
| `sort by oldest puts what you owe longest first` | first `.rv-row` is #41 | — |
| `sort by smallest puts the quickest review first` | first row is #41 (fewer lines) | — |
| `a row whose repo is not checked out is greyed but live, and says why` | #44 row has the disabled/greyed class and a `title` attribute naming the repo | — |
| `a row already being reviewed cannot be launched twice` | launch #41; row shows the loading mark; `.rv-go` disabled or absent; only one worktree | — |
| `every row stays visible in a scrollable list` | 9 requests → `.rv-row` count 9; the list's `scrollHeight > clientHeight` | — |
| `expanding a row fetches failed checks and open threads` | `pr view` shim `failing:["lint"]`, `unresolved:2` → expanded row text has `lint` and `2` | — |
| `a custom review mode makes the launch ask which to seed` | `reviewRequestModes:[{id:"quick",label:"Quick look",prompt:"…"}]`, `reviewRequestMode:"ask"` → QuickPick with `Full review`, `Quick look` | — |
| `reviewRequests off hides the strip` | setting false → `.rv-row` count 0 and no strip header | — |

### Task 19: `review-writes.e2e.ts` (per test + gh shim)

| title | settings / shim | assertion of record | mutation |
|---|---|---|---|
| `reviewWrites off shows no submit buttons` | default | no Approve/Comment/Request changes | — |
| ★ `Approve confirms with the verb, repo and number before gh pr review runs` | `reviewWrites:true`, dialog custom | dialog text has `Approve`, `rocket`, `#41`; confirm → `calls.jsonl` `gh pr review 41 --approve` | skip the dialog |
| `cancelling the confirmation sends nothing` | same | Cancel → no `pr review` call | — |
| `a session's draft loads into the review box and is marked session-drafted` | write `.pick-task/REVIEW-41.md` in the review worktree (launch first) | box text = draft; Comment → argv body ends with the session-drafted line (quote from source) | — |
| `stampLabelOnWrite off sends the body unmarked` | `stampLabelOnWrite:false` | body lacks the marker | — |
| `Request changes on GitLab warns that approval is withdrawn` | `forge:"gitlab"` | dialog text mentions approval | — |
| `a rejected submit shows the CLI's stderr, never the body` | `pr review` `exit:1, stderr:"Validation Failed"` | notification contains `Validation Failed`, not the body text | — |

### Task 20: `review-batch-edges.e2e.ts` (per test + gh shim)

| title | assertion of record | mutation |
|---|---|---|
| ★ `a read-only batch review checks nothing out` | select 2 → batch → mode `Read-only` → no `review-rocket-*` worktree; 2 run records; plan says read-only | create a worktree anyway |
| `shift-click selects a range of rows` | select mode; click row 1, shift-click row 3 → batch bar reads 3 | — |
| `a batch over the threshold names its cost in sessions` | `batchLaunchConfirmThreshold:1` → dialog text contains `2` and `session` | — |
| `PRs in a repo you have not checked out are named once and skipped` | #44 selected with #41 → notification names #44's repo once; one worktree | — |
| `a shared-window batch review opens one window` | layout one window → windows +1 | — |

### Task 21: `forge-bitbucket.e2e.ts` (per test + atlassian-cli shim)

Read `src/engine/forge/bitbucket*.ts` first for the exact `--help` probe and every `bb` verb; answers must mirror the Rust CLI shapes the source parses.

| title | shim | assertion of record | mutation |
|---|---|---|---|
| ★ `Doctor names passthrough mode when bb api answers --help` | `bbHelpAnswer("passthrough")` | Doctor row text `passthrough (full)` | invert the exit-code check |
| `Doctor names projected mode on a clap error` | `bbHelpAnswer("projected")` | row text `projected (limited` | — |
| `the review strip is hidden on Bitbucket in both modes` | either | no strip header, `.rv-row` 0 | — |
| `projected mode refuses a rebase merge before any CLI call` | projected, `mergeWrites`, `mergeMethod:"rebase"`, ready PR | notification names `agentFlow.mergeMethod`; `calls.jsonl` has no `pr merge` | — |
| `a projected card shows branch CI and little else` | projected `pr list` | card has CI chip; no mergeability, `draft` absent | — |

### Task 22: `forge-gitlab-queue.e2e.ts` (per test + glab shim)

| title | assertion of record | mutation |
|---|---|---|
| ★ `a GitLab queue row reads 20+ changes as 20 files` | `changes_count:"20+"` → row size text `20 files` | — |
| `a GitLab row's CI reads none until expanded` | collapsed chip `none`; expand → `passed` from `head_pipeline` | — |
| `GitLab rows carry no line counts` | `+0 −0` absent or zero | — |
| `arming a changes-requested rule on GitLab names it unfirable` | `orchestrator:true`, hand-written flow JSON with `changes-requested` → Arm → dialog/notice text contains `changes-requested` | drop the caps check |

### Phase 5 — Orchestrator

All with `agentFlow.orchestrator: true`. Nearest: `workflows.e2e.ts` (`seedRun`, `seedTemplate`, drawer selectors). Read `docs/ORCHESTRATOR_COMMANDS.md` fully first; the code wins where they disagree, and a disagreement is a pinned test plus a note in the PR.

### Task 23: `orchestrator-drawer.e2e.ts` (shared host)

| title | assertion of record | mutation |
|---|---|---|
| ★ `the Workflows button counts cards and switches to needs-you when one is waiting` | 2 attached flows, one `waiting-on-you` → badge text `1 needs you`; none waiting → `2` | count every flow as needs-you |
| `the Templates button counts starters too` | badge ≥ 3 with no user templates | — |
| `clicking Workflows while Templates shows switches to Active` | Templates open → Workflows → `.orch-tab[aria-selected]` is Active, drawer still open | — |
| `the Canvas explains itself when nothing is open` | Canvas tab with no flow → explanatory text present, no `.node` | — |
| `an Active row closes the drawer and opens that card` | click row → `.dd` visible for that key; `.orch` gone | — |
| `List view builds and arms a rule without a pointer` | Tab to List, keyboard-only: add rule, pick condition, Arm → flow JSON `armed:true` | — |
| `closing the Deck with an armed flow says so` | arm → close panel → notification mentions armed/stopped | — |

### Task 24: `orchestrator-nodes.e2e.ts` (per test)

Flows may be written directly to `~/.agentflow/flows/<id>.json` (`flowIo.ts` shape) — that is the store, not a seam. Conditions that are cheap to satisfy on disk: `tree-clean` (a clean repo) and `agent-ended-turn` (a transcript).

| title | setup | assertion of record | mutation |
|---|---|---|---|
| ★ `a notify rule fires once, pops a VS Code notification and stamps a receipt` | place(run) —tree-clean→ notify; arm | one `.notification-list-item` with the rule's text; flow JSON rule gains `firedAt`; wait 15s → still one notification | fire on every pass |
| `a gate asks once and Approve fires the downstream rule` | place —tree-clean→ gate —approved→ notify | gate shows Approve/Reject; click Approve → notify fires; gate stays latched | — |
| `Reset on the asking rule poses the gate's question again` | after approve → Reset → buttons back | — | — |
| `a command node asks consent and act runs it through /bin/sh` | command `run: "echo E2E-CMD-OK > $HOME/cmd.txt"` | consent dialog names the command; Act → `<home>/cmd.txt` exists; journal `fired` with `output` | run without consent |
| `disarm in the consent dialog disarms the flow` | same → Disarm | flow JSON `armed:false`; no file | — |
| `neverAutoRun outranks approval` | `neverAutoRun:["*rm*"]`, command `rm -f x` | rule marked blocked; Act absent or refused; file untouched | — |
| `command succeeded chains a second command` | cmd1 —command-succeeded→ cmd2 | both outputs on disk in order | — |
| `a rule's output opens in an editor tab` | after cmd fired → "output" action → editor tab text contains `E2E-CMD-OK` | — |
| `with nothing journaled the output action is a toast, never a blank tab` | fresh rule → output → notification, no new tab | — |
| `Save to settings writes agentFlow.commands into the real settings.json` | drawer: new command → Save to settings → `user-data/User/settings.json` gains `agentFlow.commands[]` entry with the label | — |

### Task 25: `orchestrator-journal.e2e.ts` (per test)

| title | assertion of record | mutation |
|---|---|---|
| ★ `the journal records armed, consent and fired events in order` | `<id>.log.jsonl` kinds sequence `armed`, `consent-asked`, `consented`, `fired`; each line has `id`, `at`, `flow`, `sum` | stop appending `fired` |
| `deleting a flow leaves its journal on disk` | delete via drawer → `<id>.json` gone, `<id>.log.jsonl` present | — |
| `a line with a bad checksum is skipped, not fatal` | corrupt one line's `sum` → arm again → new lines appended; drawer still renders | — |

### Task 26: `orchestrator-templates.e2e.ts` (shared host)

| title | assertion of record | mutation |
|---|---|---|
| ★ `saving a flow as a template lists it by name with its rule count` | `~/.agentflow/templates/<id>.json` (or wherever `templates.ts` writes) exists; row text name + `1 rule` | write nothing |
| `editing a saved template renames it` | rename → file `name` changes | — |
| `deleting a template confirms first` | Delete → Cancel keeps file; Delete → Confirm removes it | — |
| `built-in starters are marked and cannot be deleted` | starter row has the built-in mark; no delete control | — |
| `a dry run reports a waiting gate in words` | flow with unanswered gate → Dry run → text contains `waiting on your answer` | — |

### Phase 6 — Marketplace, Setup/Doctor, Notepad, providers

### Task 27: `marketplace-filters.e2e.ts` (shared host, richer seed)

Extend `seedClaudeAssets` with an opt-in `rich: true` that also writes: `~/.claude/plugins/marketplaces/<mkt>/…` catalog with one not-downloaded plugin, one installed plugin with `plugin.json` (`category: "Monitoring"`), one installed plugin with no category, a disabled plugin (read `claudeAssets.ts` for where `enabled` comes from), a skill (`SKILL.md`), a hook (`hooks.json`). Read `src/engine/claudeAssets.ts` for the exact paths first.

| title | assertion of record | mutation |
|---|---|---|
| ★ `type pills carry live counts and filter the list` | `Agents` pill text has `1`; click → only `telemetry-auditor` | miscount |
| `scope pills narrow to installed and enabled` | `Installed only` drops the not-downloaded row; `Enabled only` drops the disabled one | — |
| `the Plugins picker filters by several plugins at once and clears with one click` | pick two → rows from both; `Clear 2` → all rows | — |
| `clicking a marketplace tag filters by marketplace` | — | — |
| `filters AND together` | type + query → intersection | — |
| `the chip row disappears when nothing is selected` | chips visible → Clear → `.chips` count 0 | — |
| `categories group Yours first and Uncategorized last` | section headers order | — |
| `disabled assets are struck through` | disabled row has the strike class / `text-decoration: line-through` computed | — |
| `not-downloaded plugins carry their install command` | row text contains `/plugin install` | — |

### Task 28: `marketplace-detail.e2e.ts` (shared host)

| title | assertion of record | mutation |
|---|---|---|
| ★ `arrow keys move the selection and Enter opens the file` | focus search, ↓ ↓, Enter → an editor tab titled `refit.md` | Enter does nothing |
| `Open file opens the asset in an editor tab` | `.btn.pri` → tab | — |
| `a hook renders its hooks.json as a fenced JSON block` | detail contains `<pre>`/`<code>` with the JSON | — |
| `a file over 262,144 characters is truncated with Open file covering the rest` | seed a 300,000-char command → detail text mentions truncation; Open file present | — |
| `only http and https links are clickable` | seed body with `[a](https://x.invalid)` and `[b](javascript:alert(1))` → first is `<a href>`, second is not an anchor | — |
| `Rescan picks up a file added after the first scan` | write new agent → Rescan → row appears | — |
| `Add a marketplace copies the command` | click → toast `Copied`; `pbpaste` (macOS) contains `/plugin marketplace add` | — |
| `without a plugins directory the panel explains Claude Code is not set up` | separate block: seed without `plugins/` → `.notSetUp` text | — |

### Task 29: `setup-wizard.e2e.ts` (per test)

Sandbox: `taskSource:"jira"`, `setupComplete` absent, `jira.baseUrl`/`project` empty. Nearest: `sign-in.e2e.ts` (real Jira connector, InputBoxes).

| title | assertion of record | mutation |
|---|---|---|
| ★ `the welcome offer leads into a numbered wizard` | notification with `Set up` → click → InputBox title `Agent Flow Deck Setup (1/5)` | number wrongly |
| `Escape during a connector step writes nothing and the offer returns next launch` | Esc at 1/5 → settings.json unchanged (byte compare); relaunch → offer again | — |
| `Escape at the repos-root step writes nothing` | complete 1–2, Esc at reposRoot → byte-identical | — |
| `completing the wizard writes the settings and marks setup complete` | fill all → settings.json has `jira.baseUrl`, `jira.project`, `reposRoot`, `setupComplete:true` | — |
| `Later leaves everything unset` | click Later → no writes | — |
| `Run Setup… on a configured install leaves config untouched when cancelled` | configured sandbox → palette `Run Setup…` → Esc → byte-identical | — |

### Task 30: `doctor.e2e.ts` (per test)

| title | assertion of record | mutation |
|---|---|---|
| ★ `the fixture connector's probe rows read skip, never pass` | Doctor QuickPick rows for auth/scope show `skip` | render pass |
| `Doctor labels rows from the connector's SourceInfo` | row text contains `file` and the tasks.json path | — |
| `under agentProvider ask Doctor reports every tool` | rows for Claude Code and Copilot | — |
| `picking a setting row opens Settings on that id` | pick → Settings editor tab with the id in its filter | — |
| `Copy report fills the clipboard and writes nothing else` | macOS: `pbpaste` contains `Agent Flow`; sandbox file tree unchanged (snapshot before/after) | — |
| `PR reads is its own row beside the CLI row` | gh shim `auth status` ok, `pr list` exit 1 → rows `gh` pass and `PR reads` fail | — |

### Task 31: `notepad-edges.e2e.ts` (shared host)

Nearest: `notepad.e2e.ts` (`addNote`, `settle`, drag helper — copy, don't import across files unless you move them into `po/pool.ts`).

| title | assertion of record | mutation |
|---|---|---|
| ★ `the list opens on Active and the filter shows done notes only under Done and All` | add 2, check 1 → Active: 1, Done: 1, All: 2 | filter ignores state |
| `Reset order appears only after a drag` | absent → drag → present → click → order newest-first | — |
| `Clear completed appears only when a note is done` | absent → check → present | — |
| `editing a note saves the new title` | pencil → change → save → `.np-item` text | — |
| `deleting a note removes it` | delete → count −1 | — |
| `re-running a note replaces its earlier run record` | Start twice → `~/.agentflow/runs` has ONE record for that note | — |
| `a dropped image renders a thumbnail and an oversize one is refused` | dispatch a `drop` event with a `DataTransfer` holding a 1 KB PNG `File` via `frame.locator(...).evaluate` → thumbnail `<img>`; 11 MB blob → error text mentions `10 MB` | — |

### Task 32: `providers-labels.e2e.ts` (per test)

| title | assertion of record | mutation |
|---|---|---|
| ★ `the review button names the configured tool` | gh review shim; `agentProvider` claude/copilot on VS Code host; cursor on the cursor host → `.rv-actions .act.primary` text `Review with Claude Code` / `Copilot` / `Cursor` | hardcode the label |
| `a single take under ask names Claude Code in the brief even when Copilot was picked` | `agentProvider:"ask"`, pick Copilot → `TASK.md` names Claude Code (the documented gap; if the product has since fixed it, flip the row to a positive assertion and note the doc is stale) | — |

### Phase 7 — Close-out

### Task 33: Remove the backfill allowance, changelog, docs

- [ ] Delete `## Backfill in progress` and its paragraph from `test-e2e/COVERAGE.md`; `npx vitest run test/unit/e2eCoverage.test.ts` must pass with zero `todo` rows.
- [ ] `CHANGELOG.md` under `## [Unreleased]` → `### Changed`: "The real-host E2E lane now proves every documented behaviour or states why it cannot (`test-e2e/COVERAGE.md`, checked by `test/unit/e2eCoverage.test.ts`); CI runs it in four shards." Also list any pinned defects found, one line each, under `### Known issues`.
- [ ] Run all five gates plus the FULL `npm run test:e2e` (lock held) and `npm run e2e:report`; record total lane time in the PR body.
- [ ] Commit, push `test/e2e-doc-coverage`, open the PR as oznasi1 with the verify-report summary and the pinned-defect list.

---

## Appendix A — Claim ids by area

Copy each into `COVERAGE.md` with its doc anchor and one-line claim (the inventory these came from is in the spec session; the id names are self-describing).

**Sidebar/Tasks:** sidebar-two-tabs, sidebar-window-gauge, sidebar-explore-button, task-pool-filter-lenses, task-default-filter, task-size-lens, task-status-lens, task-repo-search, task-title-search, task-card-detail, task-repo-chips-inference, task-component-push, task-take, task-change-status, task-provenance-label, task-assign-to-me, task-add-to-my-sprint, task-remove-from-sprint, task-my-sprint-reorder, task-reset-order, task-address-pr-sidebar, task-address-pr-behaviour, task-launch-in-parallel, task-explore, explore-verify-environment, prompt-modes, per-task-worktrees, remote-control.
**Notepad:** notepad-list, notepad-global-storage, notepad-add-note, notepad-start, notepad-run-badges, notepad-images, notepad-drag-order, notepad-reset-order, notepad-filter, notepad-clear-completed, notepad-done-checkbox, notepad-edit-delete, notepad-os-dictation, notepad-sections, notepad-retire-in-place.
**Deck:** deck-open, deck-four-columns, deck-header-count-tiles, deck-column-hues, deck-merge-lanes, deck-recently-closed, deck-live-signal, deck-action-required-semantics, deck-fixes-needed-lane, deck-open-action, deck-diff-action, deck-card-overflow-menu, deck-grouping-lens, deck-refresh, deck-card-facts, deck-notepad-marker, deck-run-retirement, deck-clear-stale, deck-open-agents, deck-local-card-inference, deck-track-it, deck-pr-facts, deck-merge-button, deck-pr-work-buttons, deck-notify-action-required, deck-account-footer, deck-usage-action, deck-open-external.
**Review strip:** review-queue-strip, review-queue-rows, review-queue-sort, review-row-expand, review-with-tool, review-row-play-glyph, review-row-in-flight, review-row-no-checkout, review-open-in, review-modes, review-batch-select, review-batch-read-only-mode, review-batch-layout, review-writes.
**Marketplace:** marketplace-open, marketplace-scope, marketplace-fuzzy-search, marketplace-keyboard-nav, marketplace-type-pills, marketplace-scope-pills, marketplace-plugins-picker, marketplace-marketplace-tags, marketplace-filter-and, marketplace-filter-chips, marketplace-category-grouping, marketplace-disabled-rows, marketplace-not-downloaded, marketplace-detail-render, marketplace-detail-actions, marketplace-read-only-offline, marketplace-rescan, marketplace-add-marketplace.
**Doctor & Setup:** setup-first-run-wizard, setup-rerun, setup-step-numbering, setup-commit-thunk, setup-outcomes, setup-welcome-offer, standalone-sign-in, sign-out, doctor-command, doctor-rows-from-connector, doctor-probe-skip, doctor-provider-rows, doctor-forge-mode-row, doctor-pr-reads-row, doctor-actions, command-refresh, command-take-task.
**Orchestrator:** orch-feature-gate, orch-graph-model, orch-no-action-picker, orch-condition-key-spelling, orch-drawer-drag-in, orch-drawer-resize, orch-list-view-keyboard, orch-header-workflows-button, orch-header-templates-button, orch-three-views, orch-active-view, orch-canvas-view, orch-node-planned-launch, orch-node-place-seed, orch-node-command-run, orch-node-notify, orch-node-gate, orch-rule-note, orch-cond-merged-pr, orch-cond-failing-ci, orch-cond-ended-turn, orch-cond-clean-tree, orch-cond-jira-status, orch-cond-command-succeeded, orch-cond-branch-ci-passed, orch-cond-agent-idle-over, orch-cond-no-agent-left, orch-cond-changes-requested, orch-cond-gate-approved-rejected, orch-condition-live-status, orch-arm, orch-fire-once, orch-poll-interval, orch-runs-while-hidden, orch-hold-on-reopen, orch-consent, orch-never-auto-run, orch-command-output, orch-save-to-settings, orch-dry-run, orch-templates, orch-attach-from-card, journal-files, journal-rationale, journal-always-on, journal-jq-readable, journal-fields, journal-checksum, journal-event-kinds, journal-output-truncation, journal-outlives-flow, journal-cap, journal-trim-race, journal-failure-nonfatal, orch-unproven-shell, orch-unproven-settings-write, orch-unproven-chain, orch-command-path-never-run-in-editor.
**Connectors:** connector-selection, connector-registry, connector-jira, connector-agile-accelerator, connector-fixture, cap-supported-filters, cap-sizes, cap-sprints, cap-components, cap-labels, cap-refresh-caps, connector-field-prompts, connector-me-identity, connector-namespacing-rules.
**Forges:** forge-selection, forge-cli-requirement, forge-cli-resolution, forge-probe, forge-fetch-contract, forge-accounts, forge-gitlab-gaps, forge-gitlab-extra-read, forge-gitlab-rebase-refused, forge-gitlab-merge-unverified, forge-bitbucket-two-modes, forge-bitbucket-no-review-queue, forge-bitbucket-merge-unverified, forge-passthrough-vs-gitlab, forge-caps-resolve, forge-webview-import-constraint.
**Providers × Surfaces:** provider-claude-code, provider-copilot, provider-cursor, provider-ask, provider-codex, surface-extension, surface-terminal, surface-press-enter, provider-x-live-cards, provider-x-remote-control, provider-x-marketplace, provider-x-review-button-label, provider-none-fallback.
**Settings:** one row per `agentFlow.*` id in `package.json` (`set-<kebab>`), plus open-in-pick-existing, open-in-this-window, open-in-live-windows, three-questions-model.
**Telemetry & Privacy:** tel-two-switches, tel-own-setting, tel-vscode-level, tel-destination, tel-never-collected, tel-stack-digest, tel-distinct-id, tel-session-id, tel-task-fingerprint, tel-auto-properties, tel-usage-events, tel-error-events, tel-failure-class, tel-retryable, tel-double-report, tel-unhandled-error-source, tel-settings-snapshot, tel-invalid-sentinel, tel-customized-flags, tel-command-telemetry-limit, tel-drift-test, priv-your-services-only, priv-no-forge-credentials, priv-secretstorage, priv-read-only-default, priv-open-agents-reads, priv-review-strip-shared-gate, priv-doctor-probes, priv-pick-task-excluded, priv-output-channel-log.
**Meta:** req-editor-version, install-paths, no-org-defaults, status-v1-deferred, feedback-templates, reach-dashboard (and the reach-* rows as `untestable: maintainer tooling, not shipped`), gap-* rows (`untestable: documented absence` or `e2e:` where a test asserts the absence, e.g. gap-no-sixth-tab → the "all" lens test).

## Appendix B — Existing journeys → claims

smoke → task-pool-filter-lenses (partial), connector-fixture · take-task → task-take, per-task briefs · worktree-take → per-task-worktrees · child-tree-take → cap-children/ set-child-worktrees · batch-take → task-launch-in-parallel · seed-terminal → surface-terminal · seed-panel → surface-extension, provider-claude-code · copilot-panel → provider-copilot · copilot-fallback → provider-none-fallback (Copilot flavour) · codex-provider ×2 → provider-codex · cursor-provider → provider-cursor (degradation) · cursor-host → provider-cursor · sign-in → connector-jira, priv-secretstorage, standalone-sign-in, sign-out · status-writeback → task-change-status, task-provenance-label · address-pr → task-address-pr-sidebar, task-address-pr-behaviour · deck-github → deck-pr-facts, forge-selection · deck-gitlab → forge-gitlab-extra-read · deck-lifecycle ×3 → deck-run-retirement, deck-clear-stale, deck-card-overflow-menu (Forget) · workflows ×2 → orch-attach-from-card, orch-arm, orch-templates (built-ins) · review-launch ×2 → review-with-tool, review-batch-select, review-batch-layout · agile-accelerator ×3 → connector-agile-accelerator · marketplace ×4 → marketplace-open, marketplace-scope, marketplace-fuzzy-search, marketplace-detail-render, marketplace-detail-actions (Copy) · notepad ×6 → notepad-global-storage, notepad-done-checkbox, notepad-clear-completed, notepad-drag-order, notepad-start, notepad-sections · sidebar-actions ×6 → task-card-detail, task-add-to-my-sprint, task-component-push, task-explore, task-my-sprint-reorder, task-reset-order, task-remove-from-sprint.
