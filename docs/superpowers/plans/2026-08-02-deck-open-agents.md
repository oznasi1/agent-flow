# Deck Open Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Claude Code session open on this machine appears on the Deck — attached to the card it belongs to, or as a card of its own.

**Architecture:** Read Claude Code's live session registry at `~/.claude/sessions/<pid>.json`, group sessions by the git repo root containing their `cwd`, and attach each group to the tracked run whose `repos[].path` matches. A group that matches nothing becomes a *synthetic `Run`* with `kind: "local"`, so the existing pipeline — `gitState`, `deriveBucket`, `prSignals`, presence, Open, Diff — renders it with no special case.

**Tech Stack:** TypeScript, VS Code extension host + React webview, vitest (`jsdom` for webview tests), `@testing-library/react`.

**Spec:** [docs/superpowers/specs/2026-08-02-deck-open-agents-design.md](../specs/2026-08-02-deck-open-agents-design.md)

## Global Constraints

- **Every read of `~/.claude` is best-effort.** An unreadable, absent or malformed file yields an empty result and never throws. The Deck must degrade to exactly today's behaviour.
- **Never write to or delete from `~/.claude/sessions`.** It is Claude Code's directory. Unlike `presence.ts`, which prunes its own records, this code only reads.
- **Run `npx vitest run` after each task.** The repo's bar is ≥95% line coverage on changed files.
- **Webview design rules:** red is only for real failures; no persistent hint lines on cards; mono (`var(--mono)`) only for identifiers.
- **Commit after every task**, using the repo's conventional-commit style (`feat(deck):`, `refactor(engine):`, `docs:`).
- Test files mirror source paths: `src/engine/x.ts` → `test/unit/engine/x.test.ts`; webview → `test/webview/`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/engine/paths.ts` *(new)* | `canon` and `pidAlive`, currently duplicated across `presence.ts` and `status.ts` |
| `src/engine/sessions.ts` *(new)* | Read Claude Code's session registry; group sessions into places |
| `src/engine/localRuns.ts` *(new)* | Infer a ticket from a branch; build the synthetic `Run` for a place |
| `src/engine/git.ts` | Gains `repoRoot`, `currentBranch`, `defaultBranch`, `prEligible` |
| `src/engine/transcript.ts` | Gains `readSessionActivity` (one named transcript) and an exported `UNKNOWN_ACTIVITY` |
| `src/engine/status.ts` | `STATE_RANK` flip; `buildRunStatus` takes an options object and aggregates session activities |
| `src/types.ts` | `CardAgent`, `RunStatus.agents`, `"local"` run kind, two new messages |
| `src/config.ts`, `package.json` | `agentFlow.openAgents` |
| `src/deckView.ts` | `buildAll` restructure, local cards, the `deck:track` handler |
| `src/webview/DeckApp.tsx`, `src/webview/deckStyles.ts` | The agents row, the `local`/`~inferred` chips, Track it, the toggle |

---

### Task 1: Shared `canon` and `pidAlive`

`canon` exists identically in `presence.ts` and `status.ts`; `pidAlive` is in `presence.ts` and is about to be wanted in `sessions.ts` too. Pure refactor — no behaviour change.

**Files:**
- Create: `src/engine/paths.ts`
- Modify: `src/engine/presence.ts` (delete both local copies, import instead), `src/engine/status.ts` (delete its `canon`, import instead)
- Test: `test/unit/engine/paths.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `canon(p: string): string`, `pidAlive(pid: number): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/engine/paths.test.ts
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { canon, pidAlive } from "../../../src/engine/paths";

describe("canon", () => {
  it("resolves a symlink to its real path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-canon-"));
    const real = path.join(dir, "real");
    fs.mkdirSync(real);
    const link = path.join(dir, "link");
    fs.symlinkSync(real, link);
    expect(canon(link)).toBe(fs.realpathSync(real));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("hands back a path that does not exist rather than throwing", () => {
    expect(canon("/definitely/not/here")).toBe("/definitely/not/here");
  });
});

describe("pidAlive", () => {
  it("is true for this process", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  it("is false for a pid that cannot exist", () => {
    expect(pidAlive(2 ** 30)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/paths.test.ts`
Expected: FAIL — cannot resolve `../../../src/engine/paths`

- [ ] **Step 3: Write the implementation**

```ts
// src/engine/paths.ts
import * as fs from "fs";

/** Resolve symlinks so two spellings of one directory compare equal — /var vs
 * /private/var on macOS being the case that bites. Falls back to the input for a
 * path that does not exist: an identity is still wanted for a deleted worktree. */
export function canon(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** `kill(pid, 0)` sends no signal — it only probes: it throws ESRCH for a dead pid
 * and EPERM for a live process we don't own. Either "no error" or EPERM ⇒ alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
```

- [ ] **Step 4: Delete both duplicates and import instead**

In `src/engine/presence.ts`: delete the local `canon` and `pidAlive` function bodies and add `import { canon, pidAlive } from "./paths";`. In `src/engine/status.ts`: delete its local `canon` and add `import { canon } from "./paths";` (keep the `import * as fs` line only if `fs` is still used elsewhere in the file — it is not, so remove it).

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run`
Expected: PASS — `presence.test.ts` and `status.test.ts` are unchanged and must still pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine/paths.ts src/engine/presence.ts src/engine/status.ts test/unit/engine/paths.test.ts
git commit -m "refactor(engine): one canon and one pidAlive, shared"
```

---

### Task 2: `repoRoot`, `currentBranch`, `defaultBranch`, `prEligible`

Four git primitives the session work needs. `defaultRemoteRef` already exists as a private helper for `taskDiff`; `defaultBranch` is its short-name, memoized, public form.

**Files:**
- Modify: `src/engine/git.ts`
- Test: `test/unit/engine/git.test.ts` (append two `describe` blocks)

**Interfaces:**
- Consumes: the private `git()` and `defaultRemoteRef()` helpers already in `git.ts`
- Produces:
  - `repoRoot(cwd: string): string` — `""` when not in a repo
  - `currentBranch(repoPath: string): string | null`
  - `defaultBranch(repoPath: string): string` — `""` when there is no origin
  - `prEligible(repo: { path: string; isGit: boolean; branch?: string }): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/engine/git.test.ts — append at the end of the file.
// Add repoRoot, currentBranch, defaultBranch, prEligible to the existing
// `import { gitState, taskDiff } from "../../../src/engine/git";` line.

describe("repoRoot & currentBranch", () => {
  let repo: string;
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "ignore"] });

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-root-"));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo]);
    g("config", "user.email", "t@t.dev");
    g("config", "user.name", "T");
    fs.writeFileSync(path.join(repo, "a.txt"), "1\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    fs.mkdirSync(path.join(repo, "src"));
  });

  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it("resolves a subdirectory to the repo root", () => {
    expect(repoRoot(path.join(repo, "src"))).toBe(fs.realpathSync(repo));
  });

  it("is empty for a path in no repo", () => {
    const loose = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-loose-"));
    expect(repoRoot(loose)).toBe("");
    fs.rmSync(loose, { recursive: true, force: true });
  });

  it("reads the checked-out branch", () => {
    expect(currentBranch(repo)).toBe("main");
  });

  it("is null for a path in no repo", () => {
    expect(currentBranch("/definitely/not/here")).toBeNull();
  });
});

describe("defaultBranch & prEligible", () => {
  // Its own origin, because defaultBranch resolves from origin/HEAD. Each test
  // that needs a different answer builds its own repo: both helpers memoize per
  // path for the life of the process, so one directory has one answer forever.
  const clone = (name: string): string => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), `agent-flow-${name}-origin-`));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `agent-flow-${name}-`));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--bare", "-q", bare]);
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", work]);
    const g = (...a: string[]) => execFileSync("git", ["-C", work, ...a], { stdio: ["ignore", "pipe", "ignore"] });
    g("config", "user.email", "t@t.dev");
    g("config", "user.name", "T");
    fs.writeFileSync(path.join(work, "a.txt"), "1\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    g("remote", "add", "origin", bare);
    g("push", "-q", "-u", "origin", "HEAD");
    g("remote", "set-head", "origin", "-a");
    return work;
  };

  it("reads origin/HEAD as a short name", () => {
    expect(defaultBranch(clone("db"))).toBe("main");
  });

  it("is empty for a repo with no origin", () => {
    const solo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-db-solo-"));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", solo]);
    expect(defaultBranch(solo)).toBe("");
    fs.rmSync(solo, { recursive: true, force: true });
  });

  it("says a feature branch can own a PR", () => {
    const work = clone("elig");
    expect(prEligible({ path: work, isGit: true, branch: "ASM-1-x" })).toBe(true);
  });

  it("says the default branch cannot", () => {
    // `gh pr list --head main` matches every PR ever opened from main — this is
    // the check that stopped a stranger's closed PR rendering on an Explore card.
    const work = clone("elig-def");
    expect(prEligible({ path: work, isGit: true, branch: "main" })).toBe(false);
  });

  it("says a repo with no origin cannot", () => {
    const solo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-elig-solo-"));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", solo]);
    expect(prEligible({ path: solo, isGit: true, branch: "ASM-1-x" })).toBe(false);
    fs.rmSync(solo, { recursive: true, force: true });
  });

  it("says a non-git service cannot, and one with no branch cannot", () => {
    expect(prEligible({ path: "/svc", isGit: false, branch: "ASM-1-x" })).toBe(false);
    expect(prEligible({ path: "/svc", isGit: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/git.test.ts`
Expected: FAIL — `repoRoot is not a function`

- [ ] **Step 3: Write the implementation**

Add to `src/engine/git.ts`, below `defaultRemoteRef`:

```ts
// Memoized per path for the life of the extension host. A directory does not
// change repo, and origin/HEAD is written by `git clone` and effectively never
// moves — so a value good once is good until the window reloads. This is what
// keeps prEligible free to be called for every repo on every refresh.
const rootMemo = new Map<string, string>();
const defaultBranchMemo = new Map<string, string>();

/** The git repo root containing `cwd`, so a session started in `centaur/src`
 * resolves to the same place as one started in `centaur` — and so a place
 * compares equal to a run record's repo path, which is always a root. "" when
 * `cwd` is in no repo at all. */
export function repoRoot(cwd: string): string {
  const hit = rootMemo.get(cwd);
  if (hit !== undefined) return hit;
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  rootMemo.set(cwd, root);
  return root;
}

/** The checked-out branch, or null on a detached HEAD or a non-git path. Not
 * memoized: unlike a repo's root and its default branch, this is exactly the
 * thing that changes while the Deck is open. */
export function currentBranch(repoPath: string): string | null {
  const raw = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return raw && raw !== "HEAD" ? raw : null;
}

/** The repo's default branch, short — "main", "master", whatever origin/HEAD
 * names. "" when the repo has no origin, which also means it has no pull
 * requests to find. */
export function defaultBranch(repoPath: string): string {
  const hit = defaultBranchMemo.get(repoPath);
  if (hit !== undefined) return hit;
  const ref = defaultRemoteRef(repoPath); // "origin/main" | ""
  const short = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
  defaultBranchMemo.set(repoPath, short);
  return short;
}

/** Can this repo's branch own a pull request of its own? A branch that IS the
 * default branch cannot: `gh pr list --head main` matches every PR ever opened
 * from main, none of which belongs to this run — the Deck once rendered a
 * stranger's closed PR on an Explore card exactly that way. A repo with no
 * origin has no pull requests at all, and a non-git service has no branch. */
export function prEligible(repo: { path: string; isGit: boolean; branch?: string }): boolean {
  if (!repo.isGit || !repo.branch) return false;
  const def = defaultBranch(repo.path);
  return def !== "" && repo.branch !== def;
}
```

- [ ] **Step 4: Reuse `currentBranch` inside `gitState`**

In `gitState`, replace its first two lines with `const branch = currentBranch(repoPath);` — the logic is now duplicated verbatim.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/unit/engine/git.test.ts`
Expected: PASS, including the pre-existing `gitState` and `taskDiff` blocks.

- [ ] **Step 6: Commit**

```bash
git add src/engine/git.ts test/unit/engine/git.test.ts
git commit -m "feat(git): repo root, current branch, default branch and PR eligibility"
```

---

### Task 3: `readSessionActivity`

`readAgentActivity` guesses at the newest transcript in a directory that matches a branch. With a `sessionId` in hand the transcript is an exact address.

**Files:**
- Modify: `src/engine/transcript.ts`
- Test: `test/unit/engine/transcript.test.ts` (append one `describe`)

**Interfaces:**
- Consumes: the private `parseLines` and `deriveActivity` already in the file
- Produces: `readSessionActivity(projectsRoot, cwd, sessionId, nowMs): AgentActivity`, and the exported constant `UNKNOWN_ACTIVITY: AgentActivity`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/engine/transcript.test.ts — append. Add readSessionActivity and
// UNKNOWN_ACTIVITY to the existing import from "../../../src/engine/transcript".

describe("readSessionActivity", () => {
  const NOW = 1_800_000_000_000;
  let root: string;
  const cwd = "/Users/dev/projects/centaur";

  const write = (id: string, lines: object[], mtimeMs: number): void => {
    const dir = path.join(root, encodeProjectDir(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-sessact-"));
    // The named session finished its turn an hour ago; a *newer* transcript beside
    // it is mid-tool-use. Addressing by id must not drift to the newer one.
    write("named", [{ type: "user" }, { type: "assistant", message: { stop_reason: "end_turn" } }], NOW - 3_600_000);
    write("newer", [{ type: "user" }, { type: "assistant", message: { stop_reason: "tool_use" } }], NOW - 5_000);
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("reads the named transcript, not the newest one beside it", () => {
    expect(readSessionActivity(root, cwd, "named", NOW).state).toBe("needs-you");
  });

  it("reads a different session in the same directory independently", () => {
    expect(readSessionActivity(root, cwd, "newer", NOW).state).toBe("working");
  });

  it("is unknown when the session's transcript is absent", () => {
    expect(readSessionActivity(root, cwd, "gone", NOW)).toEqual(UNKNOWN_ACTIVITY);
  });

  it("is unknown when the project directory does not exist", () => {
    expect(readSessionActivity(root, "/nowhere", "x", NOW)).toEqual(UNKNOWN_ACTIVITY);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/transcript.test.ts`
Expected: FAIL — `readSessionActivity is not a function`

- [ ] **Step 3: Write the implementation**

In `src/engine/transcript.ts`, export the existing `UNKNOWN` constant under its public name and add the reader:

```ts
/** No transcript, or nothing meaningful in it. Exported because status.ts needs
 * the same value and had its own copy. */
export const UNKNOWN_ACTIVITY: AgentActivity = { state: "unknown", lastActivityMs: null, slug: null };
```

Replace the file's private `const UNKNOWN: AgentActivity = …` with that, and update its two uses inside `readAgentActivity`. Then, at the end of the file:

```ts
/**
 * Live state of one named session. Its transcript is `<sessionId>.jsonl` in the
 * project dir encoding its cwd — an exact address, unlike readAgentActivity's
 * "newest transcript for this branch", which is the best a run record can do.
 * "unknown" when the file is absent or unreadable.
 */
export function readSessionActivity(
  projectsRoot: string,
  cwd: string,
  sessionId: string,
  nowMs: number,
): AgentActivity {
  const file = path.join(projectsRoot, encodeProjectDir(cwd), `${sessionId}.jsonl`);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return UNKNOWN_ACTIVITY;
  }
  return deriveActivity(parseLines(file), mtimeMs, nowMs);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/engine/transcript.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/transcript.ts test/unit/engine/transcript.test.ts
git commit -m "feat(transcript): read the live state of one named session"
```

---

### Task 4: Read Claude Code's session registry

**Files:**
- Create: `src/engine/sessions.ts`
- Test: `test/unit/engine/sessions.test.ts`

**Interfaces:**
- Consumes: `pidAlive` from Task 1
- Produces: `defaultSessionsDir(): string`, `readOpenSessions(dir: string): OpenSession[]`
- Also modifies `src/types.ts` to add the `OpenSession` interface

> **`OpenSession` lives in `src/types.ts`, not in `sessions.ts`.** `types.ts` is the one module the extension host *and the webview* both import, and a card renders session names — so the type has to be reachable from `DeckApp.tsx`. `types.ts` importing from `engine/` would drag `fs` and `os` into the webview bundle and create a `types → sessions → git → types` cycle. The type goes in `types.ts`; `sessions.ts` imports it.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/engine/sessions.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readOpenSessions, defaultSessionsDir } from "../../../src/engine/sessions";

const DEAD = 2 ** 30;

describe("readOpenSessions", () => {
  let dir: string;
  const put = (pid: number, over: Record<string, unknown> = {}): void => {
    fs.writeFileSync(
      path.join(dir, `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: `sess-${pid}`,
        cwd: "/Users/dev/projects/centaur",
        startedAt: 1_700_000_000_000,
        kind: "interactive",
        name: `centaur-${pid}`,
        ...over,
      }),
    );
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-sessions-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns a live session with the fields a card needs", () => {
    put(process.pid);
    expect(readOpenSessions(dir)).toEqual([
      {
        pid: process.pid,
        sessionId: `sess-${process.pid}`,
        cwd: "/Users/dev/projects/centaur",
        startedAt: 1_700_000_000_000,
        name: `centaur-${process.pid}`,
      },
    ]);
  });

  it("drops a record whose process is gone", () => {
    put(DEAD);
    expect(readOpenSessions(dir)).toEqual([]);
  });

  it("leaves the dead record on disk — the directory is Claude Code's", () => {
    put(DEAD);
    readOpenSessions(dir);
    expect(fs.existsSync(path.join(dir, `${DEAD}.json`))).toBe(true);
  });

  it("skips a malformed file without losing the good ones", () => {
    fs.writeFileSync(path.join(dir, "broken.json"), "{ not json");
    put(process.pid);
    expect(readOpenSessions(dir)).toHaveLength(1);
  });

  it("drops a kind that is present and is not interactive", () => {
    put(process.pid, { kind: "headless" });
    expect(readOpenSessions(dir)).toEqual([]);
  });

  it("keeps a record with no kind at all", () => {
    // A future Claude Code that stops writing the field should degrade to showing
    // sessions, not to showing none.
    put(process.pid, { kind: undefined });
    expect(readOpenSessions(dir)).toHaveLength(1);
  });

  it("skips a record missing a sessionId or a cwd", () => {
    put(process.pid, { sessionId: "" });
    expect(readOpenSessions(dir)).toEqual([]);
  });

  it("defaults a missing name to null and a missing startedAt to 0", () => {
    put(process.pid, { name: undefined, startedAt: undefined });
    expect(readOpenSessions(dir)[0]).toMatchObject({ name: null, startedAt: 0 });
  });

  it("ignores files that are not .json", () => {
    fs.writeFileSync(path.join(dir, "notes.txt"), "hello");
    expect(readOpenSessions(dir)).toEqual([]);
  });

  it("returns [] for a directory that does not exist", () => {
    expect(readOpenSessions(path.join(dir, "nope"))).toEqual([]);
  });

  it("sorts oldest session first", () => {
    put(process.pid, { startedAt: 200 });
    fs.writeFileSync(
      path.join(dir, "other.json"),
      JSON.stringify({ pid: process.pid, sessionId: "early", cwd: "/r", startedAt: 100, kind: "interactive" }),
    );
    expect(readOpenSessions(dir).map((s) => s.sessionId)).toEqual(["early", `sess-${process.pid}`]);
  });
});

describe("defaultSessionsDir", () => {
  it("points at ~/.claude/sessions", () => {
    expect(defaultSessionsDir()).toBe(path.join(os.homedir(), ".claude", "sessions"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/sessions.test.ts`
Expected: FAIL — cannot resolve `../../../src/engine/sessions`

- [ ] **Step 3: Write the implementation**

In `src/types.ts`, beside the `Run` interface:

```ts
/** One open Claude Code session, as ~/.claude/sessions/<pid>.json records it.
 * Only the fields the Deck reads; the file carries more. Declared here rather
 * than in engine/sessions.ts because the webview renders session names and must
 * not import a module that touches `fs`. */
export interface OpenSession {
  pid: number;
  sessionId: string; // names the transcript: <sessionId>.jsonl
  cwd: string;
  startedAt: number; // epoch ms, 0 when the record omits it
  name: string | null; // Claude's derived label, e.g. "agent-flow-2e"
}
```

```ts
// src/engine/sessions.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OpenSession } from "../types";
import { pidAlive } from "./paths";

export type { OpenSession }; // re-exported so callers can take both from here

/** ~/.claude/sessions — Claude Code's live session registry, one file per running
 * session. Claude Code owns this directory: Agent Flow only ever reads it, and
 * never prunes a stale record the way presence.ts prunes its own. */
export function defaultSessionsDir(): string {
  return path.join(os.homedir(), ".claude", "sessions");
}

/** The fields we probe before trusting a record. Everything is `unknown` because
 * this file is written by another program and may change shape under us. */
interface RawSession {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  startedAt?: unknown;
  name?: unknown;
  kind?: unknown;
}

/**
 * Every session still open, oldest first. Skips a record that fails to parse or
 * lacks a field a card needs, drops one whose pid is dead (a crash leaves the
 * file behind), and drops one whose `kind` is present and is not "interactive".
 * An absent `kind` is kept on purpose: a future Claude Code that stops writing
 * the field should degrade to showing sessions, not to showing none.
 *
 * Best-effort throughout — an unreadable directory yields [] and the Deck falls
 * back to the board it renders today.
 */
export function readOpenSessions(dir: string): OpenSession[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: OpenSession[] = [];
  for (const name of names) {
    let raw: RawSession;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as RawSession;
    } catch {
      continue; // a half-written or hand-edited record must not blow up the read
    }
    if (typeof raw.kind === "string" && raw.kind !== "interactive") continue;
    if (typeof raw.pid !== "number" || raw.pid <= 0) continue;
    if (typeof raw.sessionId !== "string" || !raw.sessionId) continue;
    if (typeof raw.cwd !== "string" || !raw.cwd) continue;
    if (!pidAlive(raw.pid)) continue;
    out.push({
      pid: raw.pid,
      sessionId: raw.sessionId,
      cwd: raw.cwd,
      startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
      name: typeof raw.name === "string" && raw.name ? raw.name : null,
    });
  }
  // Oldest first: the expansion then lists a place's agents in the order they
  // were opened, and a local card's createdAt is simply the first one's start.
  return out.sort((a, b) => a.startedAt - b.startedAt);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/engine/sessions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/engine/sessions.ts test/unit/engine/sessions.test.ts
git commit -m "feat(sessions): read Claude Code's live session registry"
```

---

### Task 5: Group sessions into places

**Files:**
- Modify: `src/engine/sessions.ts`
- Test: `test/unit/engine/sessions.test.ts` (append one `describe`)

**Interfaces:**
- Consumes: `repoRoot` (Task 2), `canon` (Task 1), `OpenSession` (Task 4)
- Produces: `groupByPlace(sessions: OpenSession[]): Map<string, OpenSession[]>`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/engine/sessions.test.ts — append. Add groupByPlace to the import,
// and add `import { execFileSync } from "child_process";` at the top.

describe("groupByPlace", () => {
  let repo: string;
  let root: string; // repo, realpath-resolved — what a place key looks like

  const session = (cwd: string, id: string): OpenSession => ({
    pid: process.pid, sessionId: id, cwd, startedAt: 1, name: id,
  });

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-place-"));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo]);
    fs.mkdirSync(path.join(repo, "src"));
    root = fs.realpathSync(repo);
  });

  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it("groups a session in a subdirectory with one at the repo root", () => {
    const m = groupByPlace([session(repo, "a"), session(path.join(repo, "src"), "b")]);
    expect([...m.keys()]).toEqual([root]);
    expect(m.get(root)!.map((s) => s.sessionId)).toEqual(["a", "b"]);
  });

  it("groups a cwd in no repo under itself", () => {
    const loose = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-loose-place-"));
    const m = groupByPlace([session(loose, "a")]);
    expect([...m.keys()]).toEqual([fs.realpathSync(loose)]);
    fs.rmSync(loose, { recursive: true, force: true });
  });

  it("keeps two different repos apart", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-place2-"));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", other]);
    const m = groupByPlace([session(repo, "a"), session(other, "b")]);
    expect(m.size).toBe(2);
    fs.rmSync(other, { recursive: true, force: true });
  });

  it("returns an empty map for no sessions", () => {
    expect(groupByPlace([]).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/sessions.test.ts`
Expected: FAIL — `groupByPlace is not a function`

- [ ] **Step 3: Write the implementation**

Add to `src/engine/sessions.ts` (and `import { canon } from "./paths";`, `import { repoRoot } from "./git";`):

```ts
/**
 * Sessions grouped by the git repo root containing their cwd, so one started in
 * `centaur/src` groups with one started in `centaur` — and so a place compares
 * equal to a run record's repo path, which is always a root. A cwd in no repo
 * groups under itself. Keys are canonicalised, so /var and /private/var
 * spellings of one directory land in one group.
 */
export function groupByPlace(sessions: OpenSession[]): Map<string, OpenSession[]> {
  const out = new Map<string, OpenSession[]>();
  for (const s of sessions) {
    const place = canon(repoRoot(s.cwd) || s.cwd);
    const list = out.get(place);
    if (list) list.push(s);
    else out.set(place, [s]);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/engine/sessions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/sessions.ts test/unit/engine/sessions.test.ts
git commit -m "feat(sessions): group open sessions by the repo they run in"
```

---

### Task 6: The synthetic run

**Files:**
- Create: `src/engine/localRuns.ts`
- Modify: `src/types.ts` (`Run["kind"]` admits `"local"`)
- Test: `test/unit/engine/localRuns.test.ts`

**Interfaces:**
- Consumes: `OpenSession` (Task 4), `Run` from `src/types`
- Produces:
  - `InferredTicket { key: string; url: string; summary: string }`
  - `inferTicket(branch: string | null, project: string, baseUrl: string): InferredTicket | null`
  - `localKey(place: string): string`
  - `localRunFor(place, sessions, git: { isGit: boolean; branch: string | null }, ticket: InferredTicket | null, nowMs: number): Run`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/engine/localRuns.test.ts
import { describe, it, expect } from "vitest";
import { inferTicket, localKey, localRunFor } from "../../../src/engine/localRuns";
import type { OpenSession } from "../../../src/engine/sessions";

const BASE = "https://at-bay.atlassian.net";
const NOW = 1_800_000_000_000;
const sess = (over: Partial<OpenSession> = {}): OpenSession => ({
  pid: 1, sessionId: "s1", cwd: "/r/centaur", startedAt: 500, name: "centaur-7e", ...over,
});

describe("inferTicket", () => {
  it("reads a key and a summary out of a task branch", () => {
    expect(inferTicket("ASM-5641-team-table-new-design", "ASM", BASE)).toEqual({
      key: "ASM-5641",
      url: `${BASE}/browse/ASM-5641`,
      summary: "team table new design",
    });
  });

  it("accepts a bare key with no tail", () => {
    expect(inferTicket("ASM-5772", "ASM", BASE)).toEqual({
      key: "ASM-5772", url: `${BASE}/browse/ASM-5772`, summary: "ASM-5772",
    });
  });

  it("upper-cases a lower-cased key", () => {
    expect(inferTicket("asm-1-x", "ASM", BASE)?.key).toBe("ASM-1");
  });

  it("refuses a branch that names another project", () => {
    // The gate is the project the user actually works in, so a guess can only
    // ever name an issue that could exist for them.
    expect(inferTicket("PROJ-12-x", "ASM", BASE)).toBeNull();
  });

  it("refuses a branch with no key, a default branch, and no branch at all", () => {
    expect(inferTicket("feature/x", "ASM", BASE)).toBeNull();
    expect(inferTicket("main", "ASM", BASE)).toBeNull();
    expect(inferTicket(null, "ASM", BASE)).toBeNull();
  });

  it("refuses when no project is configured", () => {
    expect(inferTicket("ASM-1-x", "", BASE)).toBeNull();
  });

  it("does not double a trailing slash on the base url", () => {
    expect(inferTicket("ASM-1", "ASM", `${BASE}/`)?.url).toBe(`${BASE}/browse/ASM-1`);
  });
});

describe("localKey", () => {
  it("is stable for the same place", () => {
    expect(localKey("/r/centaur")).toBe(localKey("/r/centaur"));
  });

  it("differs for two places sharing a basename", () => {
    expect(localKey("/a/centaur")).not.toBe(localKey("/b/centaur"));
  });

  it("keeps the basename greppable and stays filename-safe", () => {
    const k = localKey("/r/my repo!/deep");
    expect(k).toMatch(/^local-deep-[0-9a-f]{8}$/);
  });

  it("survives a basename full of characters a filename cannot hold", () => {
    expect(localKey("/r/a b:c*d")).toMatch(/^local-a-b-c-d-[0-9a-f]{8}$/);
  });
});

describe("localRunFor", () => {
  const git = { isGit: true, branch: "ASM-1-x" };
  const ticket = { key: "ASM-1", url: `${BASE}/browse/ASM-1`, summary: "a thing" };

  it("carries the ticket's summary and url when one was inferred", () => {
    const r = localRunFor("/r/centaur", [sess()], git, ticket, NOW);
    expect(r).toMatchObject({
      key: localKey("/r/centaur"),
      summary: "a thing",
      url: `${BASE}/browse/ASM-1`,
      kind: "local",
      mode: "per-window",
      briefPaths: [],
    });
  });

  it("falls back to the directory basename with no ticket", () => {
    const r = localRunFor("/r/centaur", [sess()], { isGit: true, branch: "main" }, null, NOW);
    expect(r.summary).toBe("centaur");
    expect(r.url).toBe("");
  });

  it("describes the place as a single repo", () => {
    expect(localRunFor("/r/centaur", [sess()], git, ticket, NOW).repos).toEqual([
      { name: "centaur", path: "/r/centaur", isGit: true, branch: "ASM-1-x" },
    ]);
  });

  it("omits the branch key entirely on a detached or non-git place", () => {
    const r = localRunFor("/r/notes", [sess()], { isGit: false, branch: null }, null, NOW);
    expect(r.repos[0]).toEqual({ name: "notes", path: "/r/notes", isGit: false });
  });

  it("starts at the earliest session", () => {
    const r = localRunFor("/r/centaur", [sess({ startedAt: 900 }), sess({ startedAt: 400 })], git, ticket, NOW);
    expect(r.createdAt).toBe(400);
  });

  it("falls back to now when no session records a start", () => {
    const r = localRunFor("/r/centaur", [sess({ startedAt: 0 })], git, ticket, NOW);
    expect(r.createdAt).toBe(NOW);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/localRuns.test.ts`
Expected: FAIL — cannot resolve `../../../src/engine/localRuns`

- [ ] **Step 3: Widen `Run["kind"]`**

In `src/types.ts`, three one-line changes so `"local"` is a kind the rest of the Deck already understands:

```ts
  /** What launched this run. Absent means "task" — every record written before
   * review runs existed. …existing comment continues… "local" is the one kind
   * that is never written to the runs store: it marks a place discovered from an
   * open Claude Code session, and stops being true the moment Track it lands. */
  kind?: "task" | "explore" | "review" | "local";
```

```ts
const RUN_KINDS = new Set(["task", "explore", "review", "local"]);

export function runKind(run: Run): "task" | "explore" | "review" | "local" {
  return RUN_KINDS.has(run.kind as string) ? (run.kind as "task" | "explore" | "review" | "local") : "task";
}
```

`isTicketRun` is unchanged: it excludes review runs and requires a url, so a local run with an inferred ticket polls Jira and one without does not — exactly right.

- [ ] **Step 4: Write the implementation**

```ts
// src/engine/localRuns.ts
import { createHash } from "crypto";
import * as path from "path";
import { Run } from "../types";
import { OpenSession } from "./sessions";

/** A Jira ticket named by a branch. */
export interface InferredTicket {
  key: string;
  url: string;
  summary: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The ticket a branch names, or null. Gated on the project key the user actually
 * works in, so a guess can only ever name an issue that could exist for them —
 * `feature/x` names nothing, and `PROJ-12-x` in an ASM shop is somebody else's
 * convention. The summary is the branch's own tail, never fetched: reading the
 * real one would mean a Jira round trip before the card could be built at all,
 * to improve a line the branch already says.
 */
export function inferTicket(branch: string | null, project: string, baseUrl: string): InferredTicket | null {
  if (!branch || !project) return null;
  const m = new RegExp(`^(${escapeRe(project)}-\\d+)(?:[-_/](.*))?$`, "i").exec(branch);
  if (!m) return null;
  const key = m[1].toUpperCase();
  const summary = (m[2] ?? "").replace(/[-_/]+/g, " ").trim() || key;
  return { key, url: `${baseUrl.replace(/\/+$/, "")}/browse/${key}`, summary };
}

/**
 * A local card's identity. It has to survive a refresh (React keys, and the
 * `prfacts/<key>.json` cache), be safe as a filename, and never collide. A slug
 * of the whole path satisfies the first two and can blow past a 255-byte
 * filename on a deep worktree; a bare hash satisfies all three and is
 * unreadable in a log. The basename keeps it greppable, the hash keeps two
 * places that share one distinct.
 */
export function localKey(place: string): string {
  const slug = path.basename(place).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `local-${slug || "place"}-${createHash("sha1").update(place).digest("hex").slice(0, 8)}`;
}

/**
 * The card for a place Agent Flow never launched, shaped as a Run so the whole
 * existing pipeline — gitState, deriveBucket, prSignals, presence, Open, Diff —
 * renders it with no special case. Never written to the runs store unless the
 * user picks Track it.
 */
export function localRunFor(
  place: string,
  sessions: OpenSession[],
  git: { isGit: boolean; branch: string | null },
  ticket: InferredTicket | null,
  nowMs: number,
): Run {
  const name = path.basename(place) || place;
  const started = sessions.map((s) => s.startedAt).filter((n) => n > 0);
  return {
    key: localKey(place),
    summary: ticket?.summary ?? name,
    url: ticket?.url ?? "",
    createdAt: started.length > 0 ? Math.min(...started) : nowMs,
    kind: "local",
    mode: "per-window",
    repos: [{ name, path: place, isGit: git.isGit, ...(git.branch ? { branch: git.branch } : {}) }],
    briefPaths: [],
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/unit/engine/localRuns.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/engine/localRuns.ts test/unit/engine/localRuns.test.ts
git commit -m "feat(deck): synthesize a run for a place Agent Flow never launched"
```

---

### Task 7: `CardAgent`, the needs-you flip, and `buildRunStatus`'s options object

**Files:**
- Modify: `src/types.ts`, `src/engine/status.ts`
- Test: `test/unit/engine/status.test.ts` (rewrite the 12 `buildRunStatus` call sites; add the cases below)

**Interfaces:**
- Consumes: `UNKNOWN_ACTIVITY`, `readSessionActivity` (Task 3), `OpenSession` (Task 4)
- Produces:
  - `CardAgent { session: OpenSession; activity: AgentActivity }`
  - `RunStatus.agents: CardAgent[]`
  - `buildRunStatus(i: BuildRunStatusInput): RunStatus`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/engine/status.test.ts — replace the mostActive rank case and add
// these two. Every existing buildRunStatus(...) call becomes the object form,
// e.g. buildRunStatus({ run, jira: null, projectsRoot: projRoot, nowMs: NOW }).

const agent = (state: AgentState, lastActivityMs: number): CardAgent => ({
  session: { pid: 1, sessionId: `s-${state}-${lastActivityMs}`, cwd: "/r/svc", startedAt: 1, name: "svc-7e" },
  activity: { state, lastActivityMs, slug: null },
});

describe("mostActive", () => {
  it("prefers an agent that needs you over one still working", () => {
    // deriveBucket's ladder tests needs-you first and never used to see it: the
    // old rank discarded it in favour of any working session. Three agents busy
    // and one waiting on you is Action required, not In progress.
    const picked = mostActive([
      { state: "working", lastActivityMs: 9_000, slug: null },
      { state: "needs-you", lastActivityMs: 1_000, slug: null },
    ]);
    expect(picked.state).toBe("needs-you");
  });
});

describe("buildRunStatus with open sessions", () => {
  it("is decided by the sessions, not by the newest transcript", () => {
    const s = buildRunStatus({
      run, jira: null, projectsRoot: projRoot, nowMs: NOW,
      agents: [agent("working", NOW - 1_000), agent("needs-you", NOW - 60_000)],
    });
    expect(s.agent.state).toBe("needs-you");
    expect(s.column).toBe("needs");
    expect(s.agents).toHaveLength(2);
  });

  it("keeps a card's per-repo state when no session is open for it", () => {
    // A tracked run whose agent has since exited must not drop to parked.
    const s = buildRunStatus({ run, jira: null, projectsRoot: projRoot, nowMs: NOW, agents: [] });
    expect(s.agent.state).not.toBe("unknown");
    expect(s.agents).toEqual([]);
  });

  it("reports every session as unknown with the live signal off", () => {
    const s = buildRunStatus({
      run, jira: null, projectsRoot: projRoot, nowMs: NOW, liveSignal: false,
      agents: [agent("working", NOW - 1_000)],
    });
    expect(s.agent.state).toBe("unknown");
  });
});
```

> The existing `run` fixture in this suite already points at a transcript under `projRoot` that derives a non-unknown state — that is what the second case relies on. If it does not, add a fixture transcript for it in the same `beforeAll`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/status.test.ts`
Expected: FAIL — `buildRunStatus` does not accept an object; `CardAgent` is not exported

- [ ] **Step 3: Add `CardAgent` and `RunStatus.agents`**

In `src/types.ts`, below `AgentActivity` (`OpenSession` is already in this file from Task 4 — no import needed):

```ts
/** One open Claude Code session attached to a card, with its own live state.
 * `activity` is UNKNOWN_ACTIVITY when the Live signal is off — the registry
 * still knows the session is open, it is only the transcript that goes unread. */
export interface CardAgent {
  session: OpenSession;
  activity: AgentActivity;
}
```

and one field on `RunStatus`:

```ts
  agents: CardAgent[]; // every open session in this run's directories
```

- [ ] **Step 4: Flip the rank and convert `buildRunStatus`**

In `src/engine/status.ts`:

```ts
// needs-you outranks working: deriveBucket's ladder tests needs-you first, and
// with the old order it never saw one — any working session in the run buried
// the agent that was actually waiting on a human.
const STATE_RANK: Record<AgentState, number> = { "needs-you": 3, working: 2, idle: 1, unknown: 0 };
```

```ts
export interface BuildRunStatusInput {
  run: Run;
  jira: JiraInfo | null;
  projectsRoot: string;
  nowMs: number;
  /** Off → no transcript is read and every agent reads as unknown. */
  liveSignal?: boolean;
  openIdentities?: ReadonlySet<string>;
  prs?: PrEntryMap;
  /** Open sessions in this run's directories. */
  agents?: CardAgent[];
}

/** Reconcile a durable Run with every observable source into the status a card
 * renders. `liveSignal` off (or no transcript) leaves the git + Jira backbone. */
export function buildRunStatus(i: BuildRunStatusInput): RunStatus {
  const { run, jira, projectsRoot, nowMs } = i;
  const liveSignal = i.liveSignal ?? true;
  const agents = i.agents ?? [];
  const prs = i.prs ?? {};
  const repos = run.repos.map((r) => gitState(r.name, r.path));
  // The union of both readings. An open session is exact — addressed by its own
  // sessionId, so two in one worktree report two states — and the per-repo read
  // covers a repo with no session open, which is what stops a tracked card whose
  // agent has since exited from dropping to parked.
  const agent = liveSignal
    ? mostActive([
        ...agents.map((a) => a.activity),
        ...run.repos.map((r) => readAgentActivity(projectsRoot, r.path, r.branch ?? null, nowMs)),
      ])
    : UNKNOWN_ACTIVITY;
  const pr = prSignals(prs);
  const column = deriveBucket({
    jiraCategory: jira?.category ?? null,
    jiraStatus: jira?.status ?? null,
    agentState: agent.state,
    prOpen: pr.open,
    prBlocked: pr.blocked,
    prMerged: pr.merged,
  });
  const target = runTarget(run);
  const windowOpen = target ? (i.openIdentities ?? new Set<string>()).has(canon(target)) : false;
  return {
    run,
    column,
    jiraStatus: jira?.status ?? null,
    jiraCategory: jira?.category ?? null,
    repos,
    agent,
    windowOpen,
    prs,
    agents,
  };
}
```

Delete the file's private `UNKNOWN_AGENT` and import `UNKNOWN_ACTIVITY` from `./transcript` instead.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/unit/engine/status.test.ts`
Expected: PASS

- [ ] **Step 6: Add `agents` to the two `RunStatus` fixtures**

`RunStatus` gained a required field, so both fixtures need it or nothing type-checks:
- `statusFor` in `test/unit/deckView.test.ts` gains `agents: []`
- `mkStatus` in `test/webview/DeckApp.test.tsx` gains `agents: []`

Also change `h.buildRunStatus`'s implementation in that file's `beforeEach` to the object form: `.mockImplementation((i: { run: Run }) => statusFor(i.run))`. The throwing override further down the file takes no arguments and needs no change.

- [ ] **Step 7: Run the whole suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/engine/status.ts test/unit/engine/status.test.ts test/unit/deckView.test.ts test/webview/DeckApp.test.tsx
git commit -m "feat(deck): a card carries its open agents, and needs-you outranks working"
```

---

### Task 8: `buildAll` attaches open sessions to tracked cards

Restructures `buildAll` into the shape the local cards need in Task 11, and delivers the first visible fix: a run whose worktree holds two sessions shows both.

**Files:**
- Modify: `src/deckView.ts` — the whole body of `private async buildAll()`
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `readOpenSessions`, `defaultSessionsDir`, `groupByPlace`, `readSessionActivity`, `canon`, `UNKNOWN_ACTIVITY`, `CardAgent`
- Produces: `RunStatus.agents` populated for tracked runs; `private claimedPlaces`/`agentsByKey` locals inside `buildAll`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/deckView.test.ts
//
// 1. In the hoisted block `h`, add:
//      openSessions: [] as OpenSession[],
//      openAgents: true as boolean,
// 2. Mock the module (groupByPlace and canon stay real — only the two functions
//    that touch the real filesystem are replaced):
vi.mock("../../src/engine/sessions", async (importActual) => ({
  ...(await importActual<typeof import("../../src/engine/sessions")>()),
  readOpenSessions: () => h.openSessions,
  defaultSessionsDir: () => "/sessions",
}));
// 3. In beforeEach: h.openSessions = []; h.openAgents = true;
// 4. Import the type: import type { OpenSession } from "../../src/types";
//
// buildRunStatus is mocked in this suite, so these assert on what buildAll
// *passes* it — the same way the PR-facts cases already do.
const builtFor = (key: string) =>
  h.buildRunStatus.mock.calls.map((c) => c[0] as { run: Run; agents: CardAgent[] }).filter((i) => i.run.key === key).at(-1)!;

const sess = (over: Partial<OpenSession> = {}): OpenSession => ({
  pid: 1, sessionId: "s1", cwd: "/r/svc", startedAt: 100, name: "svc-7e", ...over,
});

it("attaches every open session in a run's repo to that run's card", async () => {
  h.runs = [mkRun({ key: "ASM-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "ASM-1-x" }] })];
  h.openSessions = [sess(), sess({ pid: 2, sessionId: "s2", startedAt: 200, name: "svc-fa" })];
  show();
  await settled();
  expect(builtFor("ASM-1").agents.map((a) => a.session.name)).toEqual(["svc-7e", "svc-fa"]);
});

it("gives a run with no session open an empty agents list", async () => {
  h.runs = [mkRun({ key: "ASM-1" })];
  h.openSessions = [];
  show();
  await settled();
  expect(builtFor("ASM-1").agents).toEqual([]);
});

it("does not attach a session running somewhere else", async () => {
  h.runs = [mkRun({ key: "ASM-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }] })];
  h.openSessions = [sess({ cwd: "/r/other", name: "other-1" })];
  show();
  await settled();
  expect(builtFor("ASM-1").agents).toEqual([]);
});
```

> `groupByPlace` calls the real `repoRoot`, which shells out to git for a path like `/r/svc` and gets `""` back — so the place is the cwd itself, which is what these fixtures expect. If the suite's `fs` mock makes that awkward, add `repoRoot: (p: string) => p` to the existing `src/engine/git` mock rather than changing the fixtures.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: FAIL — `agents` is undefined

- [ ] **Step 3: Restructure `buildAll`**

```ts
  private async buildAll(): Promise<RunStatus[]> {
    // Review runs are work in flight, but not *your ticket's* work: they surface
    // on their strip row, not as a fifth kind of card in In progress.
    const tracked = readRuns(defaultRunsDir()).filter((r) => runKind(r) !== "review");
    const projectsRoot = path.join(os.homedir(), ".claude", "projects");
    const now = Date.now();
    const authed = await this.auth.isAuthenticated();
    const ghReady = this.ghReady();
    const openIdentities = new Set(readLiveWindows(defaultWindowsDir()).map((w) => w.identity));

    // Every Claude Code session open on this machine, grouped by the directory it
    // runs in. A place is claimed by at most one tracked run; Task 11 turns what
    // is left into cards of its own.
    const places = groupByPlace(readOpenSessions(defaultSessionsDir()));
    const claimed = new Set<string>();
    const agentsByKey = new Map<string, CardAgent[]>();
    for (const run of tracked) {
      const mine: CardAgent[] = [];
      for (const repo of run.repos) {
        const place = canon(repo.path);
        const sessions = places.get(place);
        if (!sessions) continue;
        claimed.add(place);
        for (const s of sessions) {
          mine.push({
            session: s,
            // Addressed by sessionId, so two sessions in one worktree report
            // their own states rather than sharing the newest transcript's.
            activity: this.liveSignal ? readSessionActivity(projectsRoot, s.cwd, s.sessionId, now) : UNKNOWN_ACTIVITY,
          });
        }
      }
      agentsByKey.set(run.key, mine);
    }

    const all = tracked; // Task 11 appends the local runs here
    // One round trip per run, all at once — see the note this replaces.
    const jiras = await Promise.all(
      all.map((run) => (authed && isTicketRun(run) ? this.jiraStatus(run.key) : null)),
    );
    const out: RunStatus[] = [];
    for (const [i, run] of all.entries()) {
      const isTracked = isTicketRun(run);
      const stored = this.prFacts && isTracked ? readPrEntries(defaultPrFactsDir(), run.key) : {};
      const prs: PrEntryMap = Object.fromEntries(
        run.repos.filter((r) => stored[r.name]).map((r) => [r.name, stored[r.name]]),
      );
      if (ghReady && isTracked) {
        const ttlMs = getConfig().prFactsTtlSeconds * 1000;
        for (const repo of run.repos) {
          if (repo.isGit && isStale(prs[repo.name], ttlMs, now)) {
            this.enqueuePr(run.key, repo, repo.branch ?? null, prs[repo.name]);
          }
        }
      }
      out.push(buildRunStatus({
        run, jira: jiras[i], projectsRoot, nowMs: now,
        liveSignal: this.liveSignal, openIdentities, prs,
        agents: agentsByKey.get(run.key) ?? [],
      }));
    }
    return out;
  }
```

Keep the existing doc comments on the Jira `Promise.all` and the orphaned-PR-entry filter verbatim — they explain decisions this task does not revisit.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat(deck): a card shows every agent open in its directories"
```

---

### Task 9: PR facts follow the branch, not the ticket

**Files:**
- Modify: `src/deckView.ts` (`buildAll`, the two PR gates from Task 8)
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `prEligible` (Task 2)
- Produces: no new exports — a behaviour change to `buildAll`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/deckView.test.ts — add prEligible to the existing src/engine/git
// mock so a test can choose the answer without a real repo:
//   prEligible: (r: { branch?: string }) => !!r.branch && r.branch !== "master",
// These belong in the "DeckPanel PR facts" describe, which uses showAndWarm.

it("does not read stored PR facts for a repo sitting on its default branch", async () => {
  // The Explore defect: prfacts/explore-*.json was left on disk as inert, and a
  // looser gate brings a stranger's closed PR straight back onto the card.
  h.runs = [mkRun({ key: "explore-x", url: "", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "master" }] })];
  h.prEntries = { svc: { fetchedAt: Date.now(), facts: null } };
  await showAndWarm(true);
  expect(builtFor("explore-x").prs).toEqual({});
});

it("fetches a PR for an Explore run whose agent made a branch", async () => {
  h.runs = [mkRun({ key: "explore-x", url: "", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "explore-x-fix" }] })];
  h.prEntries = {};
  await showAndWarm(true);
  expect(h.prFetch).toHaveBeenCalled();
});

it("still fetches a PR for a tracked run on its task branch", async () => {
  h.runs = [mkRun({ key: "ASM-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "ASM-1-x" }] })];
  h.prEntries = {};
  await showAndWarm(true);
  expect(h.prFetch).toHaveBeenCalled();
});
```

> `builtFor` is the helper added in Task 8 — widen its cast to include `prs: PrEntryMap`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: FAIL — the first case still renders PR #241, the second never fetches

- [ ] **Step 3: Swap the gate**

In `buildAll`, replace the three uses of `isTracked` on the PR path — leaving the Jira one alone:

```ts
      // Jira still asks "is there a ticket": a synthetic key 404s forever.
      const stored = this.prFacts ? readPrEntries(defaultPrFactsDir(), run.key) : {};
      // A repo on its default branch is filtered out here as well as below, so a
      // stale entry written before this rule existed stays inert on disk rather
      // than rendering as this run's pull request.
      const prs: PrEntryMap = Object.fromEntries(
        run.repos.filter((r) => prEligible(r) && stored[r.name]).map((r) => [r.name, stored[r.name]]),
      );
      if (ghReady) {
        const ttlMs = getConfig().prFactsTtlSeconds * 1000;
        for (const repo of run.repos) {
          if (prEligible(repo) && isStale(prs[repo.name], ttlMs, now)) {
            this.enqueuePr(run.key, repo, repo.branch ?? null, prs[repo.name]);
          }
        }
      }
```

`prEligible` subsumes the old `repo.isGit` check. Import it from `./engine/git`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run`
Expected: PASS. If an existing case asserted "an untracked run enqueues nothing" using a *feature* branch, it now correctly enqueues — update it to use `master`, which is what the Explore defect actually involved.

- [ ] **Step 5: Commit**

```bash
git add src/deckView.ts test/unit/deckView.test.ts
git commit -m "fix(deck): look for a PR by branch, not by whether there is a ticket"
```

---

### Task 10: The `agentFlow.openAgents` setting and its toggle

**Files:**
- Modify: `src/config.ts`, `package.json`, `src/types.ts` (two message shapes), `src/deckView.ts`, `src/webview/DeckApp.tsx`
- Test: `test/unit/deckView.test.ts`, `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: `getConfig()`
- Produces:
  - `AgentFlowConfig.openAgents: boolean`
  - Inbound `{ type: "deck:setOpenAgents"; on: boolean }`
  - Outbound `deck:runs` gains `openAgents: boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/deckView.test.ts — the config mock already reads from `h`; add
// `openAgents: h.openAgents` to it.

it("reads no sessions at all with open agents off", async () => {
  h.openAgents = false;
  h.runs = [mkRun({ key: "ASM-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }] })];
  h.openSessions = [sess()];
  show();
  await settled();
  expect(builtFor("ASM-1").agents).toEqual([]);
});

it("re-reads when the toggle comes back on", async () => {
  h.openAgents = false;
  h.runs = [mkRun({ key: "ASM-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }] })];
  h.openSessions = [sess()];
  show();
  await settled();
  const p = lastPanel();
  await p._fire({ type: "deck:setOpenAgents", on: true });
  await settled();
  expect(builtFor("ASM-1").agents).toHaveLength(1);
});

it("tells the webview which way the toggle is set", async () => {
  h.openAgents = false;
  show();
  await settled();
  const run = posts(lastPanel()).filter((m) => m.type === "deck:runs").at(-1)!;
  expect(run.openAgents).toBe(false);
});
```

```tsx
// test/webview/DeckApp.test.tsx — runsMsg gains `openAgents: true`.
it("posts deck:setOpenAgents when the toggle is clicked", () => {
  render(<DeckApp />);
  host(runsMsg([mkStatus()]));
  fireEvent.click(screen.getByRole("button", { name: /open agents/i }));
  expect(sent).toHaveBeenCalledWith({ type: "deck:setOpenAgents", on: false });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/deckView.test.ts test/webview/DeckApp.test.tsx`
Expected: FAIL — no such message, no such button

- [ ] **Step 3: Add the setting**

`src/config.ts` — in the interface, beside `prFacts`:

```ts
  // Show every Claude Code session open on this machine on the Deck: as agents on
  // the card that owns their directory, and as a card of its own for a place
  // Agent Flow never launched. Read from ~/.claude/sessions; off = today's board.
  openAgents: boolean;
```

and in the reader: `openAgents: c.get<boolean>("openAgents") ?? true,`

`package.json`, in `contributes.configuration.properties` beside `agentFlow.prFacts`:

```json
        "agentFlow.openAgents": {
          "type": "boolean",
          "default": true,
          "markdownDescription": "Show every Claude Code session open on this machine on the Deck — as agents on the card that owns their directory, and as a card of its own for a place Agent Flow never launched. Read from `~/.claude/sessions`. Off = only the tasks Agent Flow launched."
        },
```

- [ ] **Step 4: Plumb the flag through the host**

In `DeckPanel`: `private openAgents: boolean;` seeded in the constructor from `getConfig().openAgents` beside `prFacts`. In `buildAll`, gate the read:

```ts
    const places = this.openAgents
      ? groupByPlace(readOpenSessions(defaultSessionsDir()))
      : new Map<string, OpenSession[]>();
```

In `onMessage`, beside `deck:setPrFacts`:

```ts
      case "deck:setOpenAgents":
        this.openAgents = m.on;
        await this.refreshBusy();
        break;
```

Add `openAgents: this.openAgents` to the `deck:runs` post in `refresh()`, and the two message shapes to `src/types.ts`.

- [ ] **Step 5: Add the control**

In `DeckApp`, a `const [openAgents, setOpenAgents] = React.useState(true);` set from `m.openAgents` in the `deck:runs` branch, and a third button inside the existing `.ctls` group:

```tsx
          <button
            type="button"
            className={`ctl ${openAgents ? "on" : ""}`}
            onClick={() => { const next = !openAgents; setOpenAgents(next); send({ type: "deck:setOpenAgents", on: next }); }}
            title="Show every Claude Code session open on this machine, read from ~/.claude/sessions. Off → only what Agent Flow launched."
          >
            <span className="switch" />Open agents
          </button>
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/config.ts package.json src/types.ts src/deckView.ts src/webview/DeckApp.tsx test/unit/deckView.test.ts test/webview/DeckApp.test.tsx
git commit -m "feat(deck): an Open agents toggle and its setting"
```

---

### Task 11: Local cards

**Files:**
- Modify: `src/deckView.ts` (`buildAll`, plus a `localRuns` field)
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `localRunFor`, `inferTicket` (Task 6), `currentBranch`, `repoRoot` (Task 2)
- Produces: `private readonly localRuns = new Map<string, Run>()` — the last refresh's synthetic runs, so `run(key)` can serve Open and Diff

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/deckView.test.ts
//
// 1. The hoisted block gains a branch the tests can steer:
//      branch: "ASM-5641-team-table" as string | null,
// 2. The existing src/engine/git mock gains:
//      currentBranch: (p: string) => (p === "/r/centaur" ? h.branch : "main"),
//      repoRoot: (p: string) => p,
// 3. beforeEach: h.branch = "ASM-5641-team-table";
// 4. The config mock already supplies `project`/`baseUrl` — confirm they are
//    "ASM" and a jira base url, or set them in the mock.
//
// Every local card's key is a hash, so read it off the built input rather than
// hard-coding one:
const builtLocal = () =>
  h.buildRunStatus.mock.calls.map((c) => c[0] as { run: Run; agents: CardAgent[] }).filter((i) => i.run.kind === "local").at(-1)!;

it("makes a card for a place no tracked run owns", async () => {
  h.runs = [];
  h.openSessions = [sess({ cwd: "/r/centaur", name: "centaur-7e" })];
  show();
  await settled();
  expect(h.buildRunStatus).toHaveBeenCalledTimes(1);
  expect(builtLocal().agents.map((a) => a.session.name)).toEqual(["centaur-7e"]);
});

it("infers the ticket a branch names, and polls Jira for it", async () => {
  h.runs = [];
  h.openSessions = [sess({ cwd: "/r/centaur", name: "centaur-7e" })];
  show(true);
  await settled();
  expect(builtLocal().run.url).toContain("/browse/ASM-5641");
  expect(h.getStatus).toHaveBeenCalledWith("ASM-5641");
});

it("infers nothing from a default branch, and polls no Jira", async () => {
  h.runs = [];
  h.branch = "main";
  h.openSessions = [sess({ cwd: "/r/centaur", name: "centaur-7e" })];
  show(true);
  await settled();
  expect(builtLocal().run.url).toBe("");
  expect(h.getStatus).not.toHaveBeenCalled();
});

it("does not make a second card for a place a tracked run already owns", async () => {
  h.runs = [mkRun({ key: "ASM-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "ASM-1-x" }] })];
  h.openSessions = [sess()];
  show();
  await settled();
  expect(h.buildRunStatus).toHaveBeenCalledTimes(1);
});

it("makes no local cards with the toggle off", async () => {
  h.openAgents = false;
  h.runs = [];
  h.openSessions = [sess({ cwd: "/r/centaur" })];
  show();
  await settled();
  expect(h.buildRunStatus).not.toHaveBeenCalled();
});

it("still makes local cards with the live signal off", async () => {
  // The registry knows a session is open without any transcript being read, so
  // the card appears — its agents just report unknown.
  h.runs = [];
  h.openSessions = [sess({ cwd: "/r/centaur", name: "centaur-7e" })];
  show();
  await settled();
  const p = lastPanel();
  await p._fire({ type: "deck:setLive", on: false });
  await settled();
  const built = builtLocal();
  expect(built.agents).toHaveLength(1);
  expect(built.agents[0].activity.state).toBe("unknown");
});

it("opens a local card's directory", async () => {
  h.runs = [];
  h.openSessions = [sess({ cwd: "/r/centaur" })];
  show();
  await settled();
  const p = lastPanel();
  await p._fire({ type: "deck:inspect", key: builtLocal().run.key, action: "open" });
  expect(h.openInEditor).toHaveBeenCalledWith("/r/centaur");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: FAIL — one card expected, zero built; and Open toasts "No run record"

- [ ] **Step 3: Build the local runs**

In `buildAll`, replace `const all = tracked;` with:

```ts
    // Whatever no tracked run claimed is a place you are working in that the Deck
    // has never heard of. One git call each for the branch — buildRunStatus does
    // the rest of the git work from run.repos, so this does not double it.
    const cfg = getConfig();
    this.localRuns.clear();
    const locals: Run[] = [];
    for (const [place, sessions] of places) {
      if (claimed.has(place)) continue;
      const branch = currentBranch(place);
      const run = localRunFor(
        place,
        sessions,
        { isGit: repoRoot(place) !== "", branch },
        inferTicket(branch, cfg.project, cfg.baseUrl),
        now,
      );
      this.localRuns.set(run.key, run);
      agentsByKey.set(
        run.key,
        sessions.map((s) => ({
          session: s,
          activity: this.liveSignal ? readSessionActivity(projectsRoot, s.cwd, s.sessionId, now) : UNKNOWN_ACTIVITY,
        })),
      );
      locals.push(run);
    }
    const all = [...tracked, ...locals];
```

- [ ] **Step 4: Let Open and Diff find a local run**

```ts
  /** The run a card's action acts on. A local card has no record on disk — it is
   * a place with an agent open in it — so the last refresh's synthetic runs are
   * the only place to look it up. */
  private run(key: string): Run | undefined {
    return readRuns(defaultRunsDir()).find((r) => r.key === key) ?? this.localRuns.get(key);
  }
```

with `private readonly localRuns = new Map<string, Run>();` beside the other fields.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat(deck): a card for every place an agent is open in"
```

---

### Task 12: Track it

**Files:**
- Modify: `src/types.ts` (one message), `src/deckView.ts`
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `writeRun`, `readRuns` (`engine/runs`), `removePrEntries` (`engine/pr/store`), `localKey` (Task 6)
- Produces: inbound `{ type: "deck:track"; key: string }`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/deckView.test.ts — the src/engine/runs mock gains
// `writeRun: h.writeRun`, with `writeRun: vi.fn()` in the hoisted block and
// `h.writeRun.mockClear()` in beforeEach.

/** Build one local card, track it, and hand back the record that was written. */
const trackLocal = async (): Promise<Run> => {
  h.openSessions = [sess({ cwd: "/r/centaur", name: "centaur-7e" })];
  show();
  await settled();
  const p = lastPanel();
  await p._fire({ type: "deck:track", key: builtLocal().run.key });
  await settled();
  return h.writeRun.mock.calls.at(-1)![1] as Run;
};

it("writes an inferred ticket's key as a task run", async () => {
  h.runs = [];
  const written = await trackLocal();
  expect(written).toMatchObject({ key: "ASM-5641", kind: "task" });
  expect(written.url).toContain("/browse/ASM-5641");
});

it("keeps the local key when a tracked run already owns the inferred one", async () => {
  // Writing ASM-5641.json here would silently replace a real launch record.
  h.runs = [mkRun({ key: "ASM-5641" })];
  const written = await trackLocal();
  expect(written.key).toMatch(/^local-/);
  expect(written.kind).toBe("task");
  expect(written.url).toContain("/browse/ASM-5641");
});

it("writes a place with no ticket as an explore run", async () => {
  h.runs = [];
  h.branch = "main";
  const written = await trackLocal();
  expect(written).toMatchObject({ kind: "explore", url: "" });
  expect(written.key).toMatch(/^local-/);
});

it("drops the local key's cached PR facts, which the new key refetches", async () => {
  h.runs = [];
  const written = await trackLocal();
  expect(h.removePrEntries).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^local-/));
  expect(written.key).not.toMatch(/^local-/);
});

it("ignores a track for a key that is not a local card", async () => {
  h.runs = [mkRun({ key: "ASM-1" })];
  h.openSessions = [];
  show();
  await settled();
  await lastPanel()._fire({ type: "deck:track", key: "ASM-1" });
  await settled();
  expect(h.writeRun).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: FAIL — `deck:track` is not handled

- [ ] **Step 3: Handle the message**

Add `| { type: "deck:track"; key: string }` to `InboundMessage`, and to `onMessage`:

```ts
      case "deck:track":
        await this.track(m.key);
        break;
```

```ts
  /**
   * Pin a local card: write the synthetic run we already built to the runs store,
   * so it survives its agents closing and behaves exactly like a Take'd one.
   *
   * The key it lands under is the inferred ticket's when one was inferred *and*
   * no tracked run already owns it — otherwise the local key, which cannot
   * collide with anything. Never overwrite a real launch record.
   */
  private async track(key: string): Promise<void> {
    const local = this.localRuns.get(key);
    if (!local) return; // not a local card — nothing to promote
    const inferredKey = local.url ? local.url.split("/browse/")[1] : "";
    const taken = inferredKey ? readRuns(defaultRunsDir()).some((r) => r.key === inferredKey) : true;
    const run: Run = {
      ...local,
      key: inferredKey && !taken ? inferredKey : key,
      // "task" and "explore" are the two kinds the rest of the Deck already
      // understands: a ticket to poll, or a session with none. "local" means
      // "discovered, not recorded" and stops being true the moment this lands.
      kind: local.url ? "task" : "explore",
    };
    writeRun(defaultRunsDir(), run);
    // The facts cached under the local key are orphaned — the new key refetches
    // once rather than inheriting a file nothing will ever re-stale.
    removePrEntries(defaultPrFactsDir(), key);
    this.localRuns.delete(key);
    await this.refreshBusy();
  }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat(deck): Track it pins a local card to the runs store"
```

---

### Task 13: The agents row

**Files:**
- Modify: `src/webview/DeckApp.tsx`, `src/webview/deckStyles.ts`
- Test: `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: `RunStatus.agents` (Task 7)
- Produces: an `AgentsRow` component inside `DeckApp.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// test/webview/DeckApp.test.tsx — mkStatus gains `agents: []`, and:
const mkAgent = (name: string, state: AgentActivity["state"], lastActivityMs: number): CardAgent => ({
  session: { pid: 1, sessionId: name, cwd: "/r/svc", startedAt: Date.now() - 3_600_000, name },
  activity: { state, lastActivityMs, slug: null },
});

it("names a single agent instead of counting to one", () => {
  render(<DeckApp />);
  host(runsMsg([mkStatus({ agents: [mkAgent("svc-7e", "working", Date.now())] })]));
  expect(screen.getByText("svc-7e")).toBeTruthy();
  expect(screen.queryByText(/1 agent/)).toBeNull();
});

it("counts several agents and lists them when expanded", () => {
  render(<DeckApp />);
  host(runsMsg([mkStatus({ agents: [mkAgent("svc-7e", "working", Date.now()), mkAgent("svc-fa", "idle", Date.now() - 60_000)] })]));
  const disclosure = screen.getByRole("button", { name: /2 agents/ });
  expect(screen.queryByText("svc-fa")).toBeNull();
  fireEvent.click(disclosure);
  expect(screen.getByText("svc-fa")).toBeTruthy();
  // Each row carries its OWN state — the whole point of listing them.
  expect(screen.getByText("working")).toBeTruthy();
  expect(screen.getByText("idle")).toBeTruthy();
});

it("renders no agents row for a card with none", () => {
  render(<DeckApp />);
  host(runsMsg([mkStatus({ agents: [] })]));
  expect(screen.queryByRole("button", { name: /agent/ })).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: FAIL — no such text

- [ ] **Step 3: Add the component**

In `DeckApp.tsx`, above `Card`:

```tsx
const AGENT_STATE: Record<AgentActivity["state"], { text: string; tone: Tone }> = {
  working: { text: "working", tone: "working" },
  "needs-you": { text: "ended turn", tone: "attn" },
  idle: { text: "idle", tone: "idle" },
  unknown: { text: "open", tone: "parked" },
};

/** Every agent open in this card's directories. Collapsed it is one line — the
 * name when there is one agent, a count when there are more; expanded it is a
 * row each, because two sessions in one worktree are two different states and a
 * single aggregate dot cannot say both. */
function AgentsRow({ agents }: { agents: CardAgent[] }): JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  if (agents.length === 0) return null;
  const label = agents.length === 1 ? agents[0].session.name ?? "1 agent" : `${agents.length} agents`;
  return (
    <div className="c-agents">
      <button type="button" className="ag-toggle" onClick={() => setOpen((o) => !o)}
        title="Claude Code sessions open in this directory">
        <span className="ag-caret">{open ? "▾" : "▸"}</span>
        <span className="ag-label">{label}</span>
      </button>
      {open && agents.map((a) => {
        const st = AGENT_STATE[a.activity.state];
        return (
          <div className="ag-row" key={a.session.sessionId}>
            <span className={`sdot tone-${st.tone} ${st.tone === "working" ? "pulse" : ""}`} />
            <span className="ag-name">{a.session.name ?? a.session.sessionId.slice(0, 8)}</span>
            <span className={`ag-state tone-${st.tone}`}>{st.text}</span>
            <span className="ag-age">{a.activity.lastActivityMs ? timeAgo(a.activity.lastActivityMs) : ""}</span>
            <span className="ag-open">open {timeAgo(a.session.startedAt)}</span>
          </div>
        );
      })}
    </div>
  );
}
```

Render `<AgentsRow agents={r.agents} />` in `Card`, directly above the `<div className="c-foot">`.

- [ ] **Step 4: Add the styles**

In `deckStyles.ts`, after the `.c-repos` rules:

```css
  /* Agents open in this card's directories. Names are identifiers, so mono; the
     row is a control, so it takes the same focus treatment as .act. */
  .c-agents { margin-top: 7px; }
  .ag-toggle { display: flex; align-items: center; gap: 5px; width: 100%; padding: 0;
    background: none; border: 0; color: var(--dim); font: inherit; font-size: var(--t-data);
    cursor: pointer; text-align: left; }
  .ag-toggle:hover { color: var(--vscode-foreground); }
  .ag-caret { flex: none; width: 9px; }
  .ag-label { font-family: var(--mono); }
  .ag-row { display: flex; align-items: center; gap: 6px; margin: 4px 0 0 14px;
    font-size: var(--t-data); color: var(--dim); min-width: 0; }
  .ag-name { font-family: var(--mono); color: var(--vscode-foreground);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ag-state.tone-attn { color: var(--c-attn); }
  .ag-age { margin-left: auto; flex: none; }
  .ag-open { flex: none; opacity: .7; }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/webview/DeckApp.tsx src/webview/deckStyles.ts test/webview/DeckApp.test.tsx
git commit -m "feat(deck): a card lists the agents open in it"
```

---

### Task 14: Local card chrome

**Files:**
- Modify: `src/webview/DeckApp.tsx`, `src/webview/deckStyles.ts`
- Test: `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: `runKind` from `src/types`, the `deck:track` message (Task 12)
- Produces: no new exports

- [ ] **Step 1: Write the failing test**

```tsx
// test/webview/DeckApp.test.tsx
const mkLocal = (over: Partial<RunStatus> = {}) => mkStatus({
  run: { key: "local-centaur-1a2b3c4d", summary: "team table new design",
    url: "https://jira/browse/ASM-5641", createdAt: 1, kind: "local", mode: "per-window",
    repos: [{ name: "centaur", path: "/r/centaur", isGit: true, branch: "ASM-5641-team-table" }], briefPaths: [] },
  ...over,
});

it("marks a local card and flags an inferred key", () => {
  render(<DeckApp />);
  host(runsMsg([mkLocal()]));
  expect(screen.getByText("local")).toBeTruthy();
  expect(screen.getByText("~inferred")).toBeTruthy();
  expect(screen.getByText("ASM-5641")).toBeTruthy();
});

it("shows the place's name when nothing was inferred", () => {
  render(<DeckApp />);
  host(runsMsg([mkLocal({ run: { ...mkLocal().run, url: "", summary: "centaur" } })]));
  expect(screen.queryByText("~inferred")).toBeNull();
  expect(screen.getByText("centaur")).toBeTruthy();
});

it("offers Track it and no Forget", () => {
  render(<DeckApp />);
  host(runsMsg([mkLocal()]));
  fireEvent.click(screen.getByRole("button", { name: "⋯" }));
  expect(screen.getByRole("button", { name: "Track it" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Forget" })).toBeNull();
});

it("posts deck:track", () => {
  render(<DeckApp />);
  host(runsMsg([mkLocal()]));
  fireEvent.click(screen.getByRole("button", { name: "⋯" }));
  fireEvent.click(screen.getByRole("button", { name: "Track it" }));
  expect(sent).toHaveBeenCalledWith({ type: "deck:track", key: "local-centaur-1a2b3c4d" });
});

it("still offers Forget on a tracked card", () => {
  render(<DeckApp />);
  host(runsMsg([mkStatus()]));
  fireEvent.click(screen.getByRole("button", { name: "⋯" }));
  expect(screen.getByRole("button", { name: "Forget" })).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: FAIL — no `local` chip, no Track it

- [ ] **Step 3: Update `Card`**

Add `import { runKind } from "../types";` and, beside the existing `tracked`/`explore` locals:

```tsx
  // A place with an agent open in it that Agent Flow never launched. It has no
  // record on disk, so there is nothing to Forget — closing its agents is what
  // removes it.
  const local = runKind(r.run) === "local";
  // The key came from the branch, not from a launch. Say so: the branch could
  // name a ticket somebody else owns, and the Jira status on this card would
  // then be theirs.
  const inferredKey = local && r.run.url ? r.run.url.split("/browse/")[1] : "";
```

Replace the whole key expression in the `c-top` row with:

```tsx
        {inferredKey ? (
          <span className="key-wrap">
            <span className="chip" title="Read from the branch name — Agent Flow did not launch this">~inferred</span>
            <button
              className="key"
              title={`Open ${inferredKey} in Jira`}
              onClick={() => send({ type: "openExternal", url: r.run.url })}
            >
              {inferredKey}
            </button>
          </span>
        ) : tracked ? (
          <button className="key" title={`Open ${r.run.key} in Jira`} onClick={() => send({ type: "openExternal", url: r.run.url })}>
            {r.run.key}
          </button>
        ) : (
          <span className="key untracked" title={r.run.key}>{local ? "local" : explore ? "explore" : r.run.key}</span>
        )}
```

and when `local && inferredKey`, also render the muted `local` chip beside the summary:

```tsx
      <div className="c-title" title={r.run.summary}>
        {local && inferredKey && <span className="chip">local</span>}
        {r.run.summary}
      </div>
```

In the `⋯` menu:

```tsx
                {local ? (
                  <button className="mi" onClick={() => { setMenuOpen(false); send({ type: "deck:track", key: r.run.key }); }}>Track it</button>
                ) : (
                  <button className="mi danger" onClick={() => { setMenuOpen(false); onForget(r.run.key); }}>Forget</button>
                )}
```

Keep the existing `{tracked && <Open in Jira>}` item as it is: a local card with an inferred url satisfies `isTicketRun`, so it gets the item for free.

- [ ] **Step 4: Add the chip style**

```css
  /* A muted marker on a card, never a status: "local", "~inferred". Nothing here
     is red — a discovered card is not a failure. */
  .chip { display: inline-block; margin-right: 6px; padding: 0 5px; border-radius: 3px;
    border: 1px solid var(--vscode-panel-border, var(--dim)); color: var(--dim);
    font-size: var(--t-data); opacity: .8; vertical-align: baseline; }
  .key-wrap { margin-left: auto; display: flex; align-items: baseline; gap: 4px; min-width: 0; }
  .key-wrap .key { margin-left: 0; }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/webview/DeckApp.tsx src/webview/deckStyles.ts test/webview/DeckApp.test.tsx
git commit -m "feat(deck): mark a local card, flag an inferred key, offer Track it"
```

---

### Task 15: Documentation

**Files:**
- Modify: `README.md` (the *"The Deck — your in-flight board"* section), `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above
- Produces: no code

- [ ] **Step 1: Add the README paragraph**

After the paragraph describing the Live signal, insert:

```markdown
The Deck also shows **every Claude Code session open on this machine**, not only
the ones it launched — read from `~/.claude/sessions`, the registry Claude Code
keeps of its running sessions. Sessions attach to the card that owns their
directory, so a worktree with two agents in it says so and lists both; a place
with no tracked run gets a card of its own, marked `local`. A local card reads
its branch for a ticket key (`ASM-5641-team-table` → `ASM-5641`, marked
`~inferred`) and for its pull request, so a worktree Claude Code made on its own
lands on the board as complete as a `Take`n one. It disappears when you close its
last agent — `⋯` → **Track it** pins it to the runs store first, after which it
behaves exactly like a task you took. Turn the whole thing off with the **Open
agents** toggle or `agentFlow.openAgents`.
```

Also add a row for `agentFlow.openAgents` to the settings table, if one exists in the README.

- [ ] **Step 2: Add the CHANGELOG entry**

Under a new `## Unreleased` heading (or the current one):

```markdown
### Added

- The Deck reflects every Claude Code session open on this machine, not only what
  Agent Flow launched. Sessions attach to the card that owns their directory —
  a worktree with two agents now shows both — and a place with no tracked run
  becomes a card of its own, with its ticket key and pull request inferred from
  its branch. `⋯` → **Track it** pins one to the runs store. Toggle with
  **Open agents** / `agentFlow.openAgents`.

### Changed

- An agent that has ended its turn now outranks one that is still working when a
  card has several, so a multi-agent card lands in **Action required** rather
  than hiding the one waiting on you behind the ones that are busy.
- The Deck looks for a pull request by whether a repo is on a branch of its own
  rather than by whether the run has a ticket, so an Explore session that made a
  branch now finds its PR.
```

- [ ] **Step 3: Verify the full suite and the build**

Run: `npx vitest run && npm run compile`
Expected: PASS, clean compile.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: the Deck reflects every agent open on this machine"
```

---

## Notes for the implementer

- **The deckView suite's helpers are real**, at `test/unit/deckView.test.ts:156-192`: `mkRun`, `statusFor`, `lastPanel()`, `posts(p)`, `show(authed)`, `settled()`, `showAndWarm(authed)`, and `panel._fire(msg)`. Use them; do not add parallel ones. Anything gated on `ghReady()` — every PR-fetch assertion — needs `showAndWarm`, not `show`, for the reason its doc comment gives.
- **`buildRunStatus` is mocked** in that suite (`h.buildRunStatus`), so assertions about `agents`, `prs` and `kind` are assertions about what `buildAll` *passes* it. That is what `builtFor` / `builtLocal` are for.
- **Nothing in `src/types.ts` may import from `src/engine/`.** The webview bundles `types.ts`; an `fs` import there breaks the build. This is why `OpenSession` is declared in `types.ts` (Task 4).
- **Do not reach for `fs.watch`** on the session registry. The Deck's existing refresh cadence is the whole mechanism, and the spec puts watching explicitly out of scope.
- Releasing (version bump, fresh `.vsix`) is the repo's normal merge ritual and is not a task here.
