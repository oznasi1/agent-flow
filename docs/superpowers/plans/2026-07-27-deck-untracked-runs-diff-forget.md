# Deck Fixes: Untracked Sessions, Task Diff, Responsive Forget — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three Deck defects — a ticketless session attaching to an unrelated PR, a Diff button that reports "no changes" for any run whose agent has committed, and a Forget action with no feedback.

**Architecture:** One shared predicate (`isTicketRun`) gates the two network sources for runs with no ticket. The Diff range moves from `git diff HEAD` to `merge-base(HEAD, origin/<default>) → working tree`, implemented in `engine/git.ts` beside `gitState` so it can be tested against real temp repos. Forget becomes optimistic in the webview, and the already-posted-but-ignored `deck:loading` message finally gets a handler.

**Tech Stack:** TypeScript, React (webview), VS Code extension API, Vitest, esbuild. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-07-27-deck-untracked-runs-diff-forget-design.md`](../specs/2026-07-27-deck-untracked-runs-diff-forget-design.md)

## Global Constraints

- **Worktree:** all work happens in `/Users/oznasi/dev/agent-flow/.claude/worktrees/deck-untracked-diff-forget` on branch `worktree-deck-untracked-diff-forget`. Never `cd` to the main checkout.
- **No new dependencies.** `package.json` is not modified by this plan.
- **Never run bare `git stash` / `git stash pop`** — the stash stack is shared with other worktrees.
- **Test command:** `npm test` runs everything; `npx vitest run <path> -t "<name>"` for one case. Baseline before this plan: **979 passing, 0 failures**. Every task must leave the whole suite green.
- **Comment style:** this codebase comments *why*, not *what*, in full sentences. Match it. Every comment in this plan is intended for the file, verbatim.
- **The Deck must never throw on git or a network call.** Every new git call degrades to `""`; every guard defaults to "don't fetch".

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/types.ts` | Modify (after the `Run` interface, ~line 67) | Adds `isTicketRun` — the one predicate the host and the webview both import. Types-only today; this is the first function, which is correct: it is part of the `Run` contract, and `src/engine/runs.ts` cannot be imported by the webview because it pulls in `fs`/`os`/`path`. |
| `src/deckView.ts` | Modify (`buildAll`, `onMessage`, `inspect`; delete `gitDiff`) | Host: gates Jira/PR reads on `isTicketRun`, parallelizes the Jira lookups, routes Diff through `taskDiff`, and wraps every refresh in the busy indicator. |
| `src/engine/git.ts` | Modify (add `defaultRemoteRef`, `taskDiff`; `maxBuffer` on `git()`) | The only place that shells out to git for the Deck. |
| `src/webview/DeckApp.tsx` | Modify (`Card`, `DeckApp`) | Untracked card affordances, optimistic Forget, `deck:loading` handling. |
| `src/webview/deckStyles.ts` | Modify | `.key.untracked` and the `spin` keyframe. |
| `test/unit/types.test.ts` | **Create** | `isTicketRun` unit tests. No file exists for `types.ts` yet because it had no runtime code. |
| `test/unit/engine/git.test.ts` | Modify (add a `taskDiff` describe block) | Real temp repos, including one with an `origin`. |
| `test/unit/deckView.test.ts` | Modify | Host guards, the diff range, the busy posts, parallel Jira. |
| `test/webview/DeckApp.test.tsx` | Modify | Untracked card, optimistic Forget, loading indicator. |

Task order: **1 → 2** (untracked, host then webview), **3** (diff, independent), **4 → 5** (forget/loading, webview then host). Tasks 3 and 4 do not depend on 1 or 2.

---

### Task 1: Host stops tracking ticketless sessions

**Files:**
- Modify: `src/types.ts` (insert after the `Run` interface, which ends at line 67)
- Modify: `src/deckView.ts:15` (import), `src/deckView.ts:181-202` (`buildAll`'s loop)
- Create: `test/unit/types.test.ts`
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `isTicketRun(run: Run): boolean`, exported from `src/types.ts`. Task 2 and Task 5 both import it.

**Context you need:** `explore()` in `src/tasksView.ts:419` launches a session with `key: "explore-<slug>"`, `summary: <topic>`, `url: ""`. It is the only launcher that passes an empty url. `buildAll` currently calls Jira with that synthetic key (a guaranteed 404 every 30s) and calls `gh pr list --head <default-branch>`, which matched a stranger's closed PR in production.

- [ ] **Step 1: Write the failing test for the predicate**

Create `test/unit/types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isTicketRun } from "../../src/types";
import type { Run } from "../../src/types";

const mkRun = (over: Partial<Run> = {}): Run => ({
  key: "ASM-1", summary: "do it", url: "https://jira/ASM-1", createdAt: 1, mode: "per-window",
  repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }], briefPaths: [], ...over,
});

describe("isTicketRun", () => {
  it("is true for a run launched from a Jira ticket", () => {
    expect(isTicketRun(mkRun())).toBe(true);
  });

  it("is false for an Explore session, which carries no ticket url", () => {
    expect(isTicketRun(mkRun({ key: "explore-retry-logic", url: "" }))).toBe(false);
  });

  it("treats a whitespace-only url as no url", () => {
    expect(isTicketRun(mkRun({ url: "   " }))).toBe(false);
  });

  it("survives a record with no url field at all", () => {
    // An older or hand-edited ~/.agentflow/runs entry. readRuns only validates
    // `key`, so a missing url reaches here and must not throw.
    const legacy = { ...mkRun() } as Partial<Run>;
    delete legacy.url;
    expect(isTicketRun(legacy as Run)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/unit/types.test.ts`
Expected: FAIL — `isTicketRun is not a function` (no such export).

- [ ] **Step 3: Add the predicate**

In `src/types.ts`, immediately after the closing brace of `interface Run` (line 67) and before the `/** Per-repo git state … */` comment:

```ts
/** Is this run attached to a Jira ticket? An Explore session is launched with a
 * synthetic `explore-<slug>` key, no ticket url, and no branch Agent Flow named:
 * there is no Jira issue to poll, and `gh pr list --head <default-branch>` can
 * only return a pull request belonging to somebody else. Tolerates an older or
 * hand-edited run record with no url field at all. */
export function isTicketRun(run: Run): boolean {
  return typeof run.url === "string" && run.url.trim().length > 0;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/unit/types.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing host tests**

In `test/unit/deckView.test.ts`, inside the `describe("DeckPanel", …)` block, after the `"forgets a run and re-posts the board"` test (~line 188):

```ts
  it("does not look up Jira for a run with no ticket", async () => {
    h.runs = [mkRun({ key: "explore-retry-logic", url: "" })];
    show(true);
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    // The key is synthetic — every lookup 404s, logs, and returns null anyway.
    expect(h.getStatus).not.toHaveBeenCalled();
  });

  it("still looks up Jira for a tracked run sharing the board with an untracked one", async () => {
    h.runs = [mkRun(), mkRun({ key: "explore-retry-logic", url: "" })];
    show(true);
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    // Asserted by argument, not by count: the constructor's unawaited first refresh
    // races this one, and whether the second finds a warm jiraCache depends on
    // microtask ordering. Which keys are looked up at all is the actual contract.
    expect(h.getStatus).toHaveBeenCalledWith("ASM-1");
    expect(h.getStatus).not.toHaveBeenCalledWith("explore-retry-logic");
  });

  it("hands an untracked run an empty PR map even when the store has entries for its key", async () => {
    // A stale prfacts file left by an earlier version must not render: the PR it
    // names was matched off the repo's default branch and belongs to another task.
    h.prEntries = { svc: { facts: null, fetchedAt: Date.now() } };
    h.runs = [mkRun({ key: "explore-retry-logic", url: "" })];
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    const prs = h.buildRunStatus.mock.calls.at(-1)![6];
    expect(prs).toEqual({});
  });
```

And inside `describe("DeckPanel PR facts", …)`, after `"does not fetch a repo that is not a git checkout"` (~line 377):

```ts
  it("does not fetch a PR for a run with no ticket", async () => {
    h.runs = [mkRun({ key: "explore-retry-logic", url: "" })];
    await showAndWarm();
    expect(h.prFetch).not.toHaveBeenCalled();
  });

  it("fetches the tracked run's PR and skips the untracked one on the same board", async () => {
    h.runs = [mkRun(), mkRun({ key: "explore-retry-logic", url: "", repos: [{ name: "other", path: "/r/other", isGit: true, branch: "master" }] })];
    await showAndWarm();
    expect(h.prFetch).toHaveBeenCalledTimes(1);
    expect(h.prFetch).toHaveBeenCalledWith("/r/svc", "b", "ASM-1");
  });
```

- [ ] **Step 6: Run them and watch them fail**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: the five new tests FAIL — `getStatus` is called for the explore run, `prFetch` is called for it, and `prs` is the populated store map.

- [ ] **Step 7: Gate the two sources in `buildAll`**

In `src/deckView.ts`, extend the types import on line 15:

```ts
import { InboundMessage, OutboundMessage, PrEntry, PrEntryMap, Run, RunStatus, isTicketRun } from "./types";
```

Then in `buildAll`, replace the first two lines of the `for (const run of runs)` body and the `if (ghReady)` guard:

```ts
    for (const run of runs) {
      // A session with no ticket has nothing to look up. Its key is synthetic, so
      // every Jira call 404s; and it has no branch we named, so `gh pr list
      // --head <default-branch>` matches whatever PR was last opened *from* that
      // branch — somebody else's, rendered on this card as if it were the task's.
      const tracked = isTicketRun(run);
      const jira = authed && tracked ? await this.jiraStatus(run.key) : null;
      const stored = this.prFacts && tracked ? readPrEntries(defaultPrFactsDir(), run.key) : {};
```

and:

```ts
      if (ghReady && tracked) {
```

Leave everything else in the loop — the orphan-entry filter, the `isStale` check, the `buildRunStatus` call — untouched.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS, 988 tests (979 baseline + 4 predicate + 5 host).

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/deckView.ts test/unit/types.test.ts test/unit/deckView.test.ts
git commit -m "fix(deck): stop reading Jira and GitHub for ticketless sessions

An Explore session creates no branch, so its run record stores the repo's
default branch and \`gh pr list --head master\` matched a stranger's closed PR,
rendered on the card with its conflicts and review state. Its synthetic
\`explore-<slug>\` key also 404'd against Jira on every TTL expiry.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The untracked card drops its Jira affordances

**Files:**
- Modify: `src/webview/DeckApp.tsx:3` (import), `:107-133` (`Card`'s top row), `:159-167` (the overflow menu)
- Modify: `src/webview/deckStyles.ts:98` (after the `.key:hover` rule)
- Test: `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: `isTicketRun(run: Run): boolean` from `src/types.ts` (Task 1).
- Produces: nothing later tasks depend on.

**Context you need:** the card's key button currently sends `{ type: "openExternal", url: r.run.url }`. For an untracked run that url is `""`, which the host parses and rejects on scheme — a button that silently does nothing. The card title already shows the Explore topic, so the 44-character `explore-export-asset-file-name-per-asset-type` key adds only noise; a short `explore` chip with the full key on hover carries the same information.

- [ ] **Step 1: Write the failing tests**

In `test/webview/DeckApp.test.tsx`, after the `"opens the ticket in Jira from the overflow menu"` test (~line 180):

```ts
  const untracked = (over: Partial<RunStatus> = {}): RunStatus => {
    const base = mkStatus();
    return {
      ...base,
      run: { ...base.run, key: "explore-retry-logic", summary: "how the aggregator retries", url: "" },
      jiraStatus: null,
      jiraCategory: null,
      ...over,
    };
  };

  it("labels a ticketless run 'explore' rather than showing its synthetic key", () => {
    render(<DeckApp />);
    host(runsMsg([untracked()]));
    expect(screen.getByText("explore")).toBeInTheDocument();
    expect(screen.queryByText("explore-retry-logic")).not.toBeInTheDocument();
    // The full key stays reachable on hover — it names the run in ~/.agentflow/runs.
    expect(screen.getByTitle("explore-retry-logic")).toBeInTheDocument();
  });

  it("does not offer to open a ticketless run in Jira", () => {
    render(<DeckApp />);
    host(runsMsg([untracked()]));
    fireEvent.click(screen.getByTitle(/more actions/i));
    expect(screen.queryByText(/Open in Jira/i)).not.toBeInTheDocument();
    expect(screen.getByText(/^Forget$/)).toBeInTheDocument();
  });

  it("keeps the Jira link on a tracked run", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByTitle(/Open ASM-1 in Jira/i));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://jira/ASM-1" });
  });
```

- [ ] **Step 2: Run them and watch two fail**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: `"labels a ticketless run 'explore'"` FAILS (no such text — the key renders in full), `"does not offer to open a ticketless run in Jira"` FAILS (the menu item is there). `"keeps the Jira link"` passes already — it guards against over-reach in the next step.

- [ ] **Step 3: Render the untracked card**

In `src/webview/DeckApp.tsx`, extend the import on line 3:

```ts
import { DeckColumn, OutboundMessage, PrEntryMap, PrFacts, RepoGit, RunStatus, isTicketRun } from "../types";
```

Inside `Card`, add below `const sv = stateView(r, live);`:

```ts
  // A ticketless run has no Jira issue behind it: the key is a local slug, and
  // openExternal("") is a button that does nothing.
  const tracked = isTicketRun(r.run);
```

Replace the key button in `.c-top`:

```tsx
        {tracked ? (
          <button className="key" title={`Open ${r.run.key} in Jira`} onClick={() => send({ type: "openExternal", url: r.run.url })}>
            {r.run.key}
          </button>
        ) : (
          <span className="key untracked" title={r.run.key}>explore</span>
        )}
```

And make the menu's Jira item conditional:

```tsx
              <div className="menu" onClick={(e) => e.stopPropagation()}>
                {tracked && (
                  <button className="mi" onClick={() => { setMenuOpen(false); send({ type: "openExternal", url: r.run.url }); }}>Open in Jira</button>
                )}
                <button className="mi danger" onClick={() => { setMenuOpen(false); send({ type: "deck:forget", key: r.run.key }); }}>Forget</button>
              </div>
```

- [ ] **Step 4: Style the chip**

In `src/webview/deckStyles.ts`, directly after the `.key:hover` rule (line 98):

```css
  /* Inherits .key's layout so the chip sits at the same x as every other card's
     key; drops the affordances, because there is nothing to click through to. */
  .key.untracked { cursor: default; opacity: .75; }
  .key.untracked:hover { color: var(--vscode-descriptionForeground); }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: PASS, all three new tests plus the existing 35.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, 991 tests.

- [ ] **Step 7: Commit**

```bash
git add src/webview/DeckApp.tsx src/webview/deckStyles.ts test/webview/DeckApp.test.tsx
git commit -m "fix(deck): a ticketless card stops pretending to have a ticket

The key button sent openExternal(\"\"), which the host rejects on scheme — a
dead control. An Explore card now shows a muted 'explore' chip with its run key
on hover, and the overflow menu drops 'Open in Jira'.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Diff shows everything the task changed

**Files:**
- Modify: `src/engine/git.ts:6-16` (the `git()` helper), and add two functions after it
- Modify: `src/deckView.ts:4` (drop the `execFileSync` import), `:289-301` (`inspect`'s diff branch), `:304-310` (delete `gitDiff`)
- Test: `test/unit/engine/git.test.ts`, `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `taskDiff(repoPath: string): string` exported from `src/engine/git.ts` — the unified diff of everything a task changed, or `""` when there is nothing (or the path is not a git repo). `defaultRemoteRef` stays module-private.

**Context you need — two independent causes of the same empty toast:**

1. `git diff HEAD` is working-tree-only. The moment an agent commits, it returns nothing, so every run that got as far as opening a PR shows "no changes".
2. `execFileSync` with no `maxBuffer` uses Node's 1 MB default. A larger diff throws `ENOBUFS`, the bare `catch` swallows it, and `""` comes back — indistinguishable from "no changes".

`git()` in `git.ts` returns `""` on any failure and `.trim()`s its output; that trim is fine for a diff (`inspect` already trims before testing emptiness).

- [ ] **Step 1: Write the failing `taskDiff` tests**

Append to `test/unit/engine/git.test.ts` (the file already imports `fs`, `os`, `path`, `execFileSync`; extend the `git` import to `import { gitState, taskDiff } from "../../../src/engine/git";`):

```ts
describe("taskDiff", () => {
  let work: string;
  let bare: string;
  const g = (...a: string[]) => execFileSync("git", ["-C", work, ...a], { stdio: ["ignore", "pipe", "ignore"] });
  const file = () => path.join(work, "a.txt");

  beforeAll(() => {
    // A real origin, because the base is resolved from origin/HEAD. Both repos pin
    // init.defaultBranch so `remote set-head -a` resolves the same name on any git.
    bare = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-origin-"));
    work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-task-"));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--bare", "-q", bare]);
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", work]);
    g("config", "user.email", "t@t.dev");
    g("config", "user.name", "T");
    fs.writeFileSync(file(), "1\n2\n3\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    g("remote", "add", "origin", bare);
    g("push", "-q", "-u", "origin", "HEAD");
    g("remote", "set-head", "origin", "-a");
  });

  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  });

  it("is empty on the default branch with a clean tree", () => {
    // merge-base is HEAD here, so this is the old `diff HEAD` behaviour, unchanged.
    expect(taskDiff(work)).toBe("");
  });

  it("shows an uncommitted change while still on the default branch", () => {
    fs.appendFileSync(file(), "4\n");
    expect(taskDiff(work)).toContain("+4");
    g("checkout", "-q", "--", "a.txt");
  });

  it("shows work the agent already committed on a task branch", () => {
    // The defect: `git diff HEAD` is blank here, so the Deck reported "no changes"
    // for every run whose agent had committed — i.e. every run with a PR.
    g("checkout", "-qb", "ASM-1-retry");
    fs.appendFileSync(file(), "committed\n");
    g("add", "-A");
    g("commit", "-q", "-m", "work");
    const d = taskDiff(work);
    expect(d).toContain("+committed");
    expect(d).toContain("a/a.txt");
  });

  it("shows committed and uncommitted work together", () => {
    fs.appendFileSync(file(), "uncommitted\n");
    const d = taskDiff(work);
    expect(d).toContain("+committed");
    expect(d).toContain("+uncommitted");
    g("checkout", "-q", "--", "a.txt");
  });

  it("returns a diff larger than execFileSync's 1 MB default rather than nothing", () => {
    // Without an explicit maxBuffer this throws ENOBUFS, git() swallows it, and the
    // Deck toasts "no changes" for a task that changed two megabytes.
    fs.writeFileSync(path.join(work, "big.txt"), "a line of some length\n".repeat(100_000));
    g("add", "-A");
    g("commit", "-q", "-m", "big");
    expect(taskDiff(work).length).toBeGreaterThan(1024 * 1024);
  });

  it("degrades to the uncommitted diff in a repo with no origin", () => {
    const solo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-solo-"));
    const s = (...a: string[]) => execFileSync("git", ["-C", solo, ...a], { stdio: ["ignore", "pipe", "ignore"] });
    s("init", "-q");
    s("config", "user.email", "t@t.dev");
    s("config", "user.name", "T");
    fs.writeFileSync(path.join(solo, "a.txt"), "1\n");
    s("add", "-A");
    s("commit", "-q", "-m", "init");
    fs.appendFileSync(path.join(solo, "a.txt"), "2\n");
    expect(taskDiff(solo)).toContain("+2");
    fs.rmSync(solo, { recursive: true, force: true });
  });

  it("returns empty for a path that is not a git repo", () => {
    expect(taskDiff("/definitely/not/here")).toBe("");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/unit/engine/git.test.ts`
Expected: FAIL — `taskDiff is not a function`.

- [ ] **Step 3: Implement `taskDiff`**

In `src/engine/git.ts`, add `maxBuffer` to the existing `git()` helper's options:

```ts
    return execFileSync("git", ["-C", repoPath, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      // A task diff is the one output here big enough to matter. Node's 1 MB
      // default throws ENOBUFS, which the catch below would turn into "", and a
      // caller cannot tell that apart from "this task changed nothing".
      maxBuffer: 32 * 1024 * 1024,
    })
```

Then after `gitState`, at the end of the file:

```ts
/** The remote default branch a task is measured against: whatever origin/HEAD
 * points at, else origin/main, else origin/master. "" when the repo has no origin
 * to compare with — a local-only checkout, or a fresh init. */
function defaultRemoteRef(repoPath: string): string {
  const head = git(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head;
  // origin/HEAD is only written by `git clone` and goes stale after a default-branch
  // rename, so a working clone very often has no such ref.
  for (const ref of ["origin/main", "origin/master"]) {
    if (git(repoPath, ["rev-parse", "--verify", "--quiet", ref])) return ref;
  }
  return "";
}

/** Everything a task changed in this repo: the diff from where its branch left the
 * default branch through to the current working tree, so committed work counts.
 * The moment an agent commits, a plain `diff HEAD` goes blank and reads as "no work
 * done" — which is what the Deck's Diff button used to report for every run that
 * got as far as opening a PR. Degrades to the uncommitted diff when there is no
 * base to find, and on a run still sitting on the default branch merge-base *is*
 * HEAD, so the two are the same command. */
export function taskDiff(repoPath: string): string {
  const base = defaultRemoteRef(repoPath);
  const from = base ? git(repoPath, ["merge-base", "HEAD", base]) : "";
  return git(repoPath, ["diff", from || "HEAD"]);
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run test/unit/engine/git.test.ts`
Expected: PASS, 10 tests (3 existing + 7 new).

- [ ] **Step 5: Write the failing host tests**

In `test/unit/deckView.test.ts`, add `taskDiff: vi.fn((_p: string) => ""),` to the `vi.hoisted` object `h`, and register the mock beside the other `vi.mock` calls:

```ts
vi.mock("../../src/engine/git", () => ({ taskDiff: h.taskDiff }));
```

Add `h.taskDiff.mockClear().mockReturnValue("");` to `beforeEach`. Then update the existing test at line 164 and add two:

```ts
  it("inspect diff on a repo with no changes toasts instead of opening a doc", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "diff" });
    const toast = posts(p).find((m) => m.type === "toast");
    expect(toast.message).toMatch(/No changes to show/i);
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it("inspect diff opens the task's whole diff as a read-only diff document", async () => {
    // Not `git diff HEAD`: committed work counts, or a run with a PR shows nothing.
    h.taskDiff.mockReturnValue("diff --git a/a.txt b/a.txt\n+committed\n");
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "diff" });
    expect(h.taskDiff).toHaveBeenCalledWith("/r/svc");
    expect(workspace.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("+committed"), language: "diff" }),
    );
  });

  it("labels each repo's chunk when a run spans more than one", async () => {
    h.runs = [mkRun({ repos: [
      { name: "svc", path: "/r/svc", isGit: true, branch: "b" },
      { name: "web", path: "/r/web", isGit: true, branch: "b" },
    ] })];
    h.taskDiff.mockReturnValue("diff --git a/a.txt b/a.txt\n+x\n");
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "diff" });
    const arg = workspace.openTextDocument.mock.calls.at(-1)![0] as { content: string };
    expect(arg.content).toContain("# svc");
    expect(arg.content).toContain("# web");
  });
```

Extend the vscode-mock import at the top of the file to include `workspace`:

```ts
import { window, ViewColumn, env, workspace } from "../_mocks/vscode";
```

- [ ] **Step 6: Run them and watch them fail**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: FAIL — `h.taskDiff` is never called (the panel still shells out itself), and the toast still reads "No uncommitted changes".

- [ ] **Step 7: Route the panel through `taskDiff`**

In `src/deckView.ts`: delete `import { execFileSync } from "child_process";` (line 4) and add to the engine imports:

```ts
import { taskDiff } from "./engine/git";
```

In `inspect`, replace the diff branch's comment, call and toast:

```ts
    // diff — everything this task changed, committed work included, as a read-only
    // diff document.
    const repos = repoName ? run.repos.filter((r) => r.name === repoName) : run.repos;
    const chunks: string[] = [];
    for (const r of repos) {
      const d = taskDiff(r.path);
      if (d.trim()) chunks.push(run.repos.length > 1 ? `# ${r.name}\n${d}` : d);
    }
    if (chunks.length === 0) {
      this.toast("info", `No changes to show for ${key}.`);
      return;
    }
```

Delete the private `gitDiff` method entirely (lines 304-310).

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS, 1000 tests (991 + 7 git + 2 new host tests; the reworded toast test is a rewrite, not an addition).

- [ ] **Step 9: Commit**

```bash
git add src/engine/git.ts src/deckView.ts test/unit/engine/git.test.ts test/unit/deckView.test.ts
git commit -m "fix(deck): Diff shows everything the task changed

\`git diff HEAD\` is working-tree-only, so the button reported 'no changes' for
every run whose agent had committed — every run with a PR. The range is now
merge-base(HEAD, origin/<default>) through the working tree. execFileSync also
ran with Node's 1 MB maxBuffer, turning any larger diff into ENOBUFS and the
same empty toast.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Forget is instant, and the Deck shows when it is busy

**Files:**
- Modify: `src/webview/DeckApp.tsx:107` (`Card`'s props), `:164` (the Forget menu item), `:174-235` (`DeckApp`'s state, handler, and header)
- Modify: `src/webview/deckStyles.ts` (after the `pulse` keyframe, line 105)
- Test: `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks (`isTicketRun` is already imported by Task 2; this task does not touch it).
- Produces: nothing later tasks depend on. Task 5 relies on the host already posting `deck:loading`, which it does today.

**Context you need:** `OutboundMessage` already includes `{ type: "deck:loading"; loading: boolean }`, and `deckView` already posts it on `deck:ready`/`deck:refresh`. `DeckApp`'s message handler only branches on `deck:runs` and `toast`, so the Deck has never shown a loading state. Forget currently sends and waits: the card stays until the host finishes a full refresh (a Jira round trip per run, four synchronous git subprocesses per repo).

- [ ] **Step 1: Write the failing tests**

In `test/webview/DeckApp.test.tsx`, after the forget tests (~line 171):

```ts
  it("removes a forgotten card immediately, without waiting for the host", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus(), mkStatus({ run: { ...mkStatus().run, key: "ASM-2" } })]));
    fireEvent.click(screen.getAllByTitle(/more actions/i)[0]);
    fireEvent.click(screen.getByText(/^Forget$/));
    // No deck:runs has arrived; the card is gone regardless.
    expect(screen.queryByText("ASM-1")).not.toBeInTheDocument();
    expect(screen.getByText("ASM-2")).toBeInTheDocument();
    expect(sent).toHaveBeenCalledWith({ type: "deck:forget", key: "ASM-1" });
  });

  it("restores an optimistically removed card if the host still reports it", () => {
    // The host post is authoritative — a delete that failed must not vanish the run.
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByTitle(/more actions/i));
    fireEvent.click(screen.getByText(/^Forget$/));
    expect(screen.queryByText("ASM-1")).not.toBeInTheDocument();
    host(runsMsg([mkStatus()]));
    expect(screen.getByText("ASM-1")).toBeInTheDocument();
  });

  it("shows a syncing indicator while the host is refreshing", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.getByText(/synced/i)).toBeInTheDocument();
    host({ type: "deck:loading", loading: true });
    expect(screen.getByText(/syncing/i)).toBeInTheDocument();
    host({ type: "deck:loading", loading: false });
    expect(screen.getByText(/synced/i)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: all three FAIL — the card survives the click, and `deck:loading` changes nothing on screen.

- [ ] **Step 3: Thread an `onForget` callback through `Card`**

In `src/webview/DeckApp.tsx`, change `Card`'s signature:

```tsx
function Card({ r, live, onForget }: { r: RunStatus; live: boolean; onForget: (key: string) => void }): JSX.Element {
```

and its Forget menu item:

```tsx
                <button className="mi danger" onClick={() => { setMenuOpen(false); onForget(r.run.key); }}>Forget</button>
```

- [ ] **Step 4: Add the optimistic remove and the busy state**

In `DeckApp`, add beside the other state hooks:

```tsx
  const [busy, setBusy] = React.useState(false);
```

Add the `deck:loading` branch to the message handler, after the `toast` branch:

```tsx
      } else if (m.type === "deck:loading") {
        setBusy(m.loading);
      }
```

Add the callback after the `toggleLive` definition:

```tsx
  const forget = React.useCallback((key: string) => {
    // Optimistic: the card leaves now rather than after a full refresh (a Jira
    // round trip per run, plus git per repo). The next deck:runs post is
    // authoritative, so a delete that somehow failed brings the card straight back.
    setRuns((rs) => rs.filter((r) => r.run.key !== key));
    send({ type: "deck:forget", key });
  }, []);
```

Pass it down where cards render:

```tsx
                  {list.map((r) => <Card key={r.run.key} r={r} live={live} onForget={forget} />)}
```

And make the refresh control report activity:

```tsx
        <div className={`ctl ${busy ? "busy" : ""}`} onClick={() => send({ type: "deck:refresh" })}>
          <span className={`spin ${busy ? "on" : ""}`}>⟳</span>
          <span className="synced">{busy ? "syncing…" : syncedAt ? `synced ${timeAgo(syncedAt)}` : "refresh"}</span>
        </div>
```

- [ ] **Step 5: Style the spinner**

In `src/webview/deckStyles.ts`, after the `@keyframes pulse` line (105):

```css
  .spin { display: inline-block; font-size: 12px; }
  .spin.on { animation: spin .9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: PASS. The existing `"forgets a run from the overflow menu"` test still passes — `onForget` sends the same message.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS, 1003 tests.

- [ ] **Step 8: Commit**

```bash
git add src/webview/DeckApp.tsx src/webview/deckStyles.ts test/webview/DeckApp.test.tsx
git commit -m "fix(deck): Forget lands instantly, and the Deck shows when it is busy

The host has always posted deck:loading and the webview has always ignored it,
so a refresh — and the full refresh Forget waits on — gave no feedback at all.
Forget now drops its card optimistically; the next deck:runs post is
authoritative and restores it if the delete failed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: One busy-refresh path, and Jira lookups in parallel

**Files:**
- Modify: `src/deckView.ts:208-221` (add `refreshBusy` beside `refresh`), `:223-254` (`onMessage`), `:173-206` (`buildAll`'s Jira pass)
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `isTicketRun(run: Run): boolean` from `src/types.ts` (Task 1) — already imported by `deckView.ts` after that task.
- Produces: nothing further depends on this.

**Context you need:** four inbound messages await a refresh — `deck:ready`/`deck:refresh` (which post `deck:loading` by hand), `deck:setLive`, `deck:setPrFacts` and `deck:forget` (which post nothing). `buildAll` awaits `this.jiraStatus(run.key)` inside its `for` loop, one round trip at a time; with six runs and a cold 30-second cache that serial pass is the bulk of what Forget waits on. `jiraStatus` catches every error and returns a value, so a `Promise.all` over it cannot reject.

- [ ] **Step 1: Write the failing tests**

In `test/unit/deckView.test.ts`, inside `describe("DeckPanel", …)`:

```ts
  it("brackets a forget with the busy indicator", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:forget", key: "ASM-1" });
    const loads = posts(p).filter((m) => m.type === "deck:loading").map((m) => m.loading);
    expect(loads).toContain(true);
    expect(loads.at(-1)).toBe(false);
  });

  it("brackets a prFacts toggle with the busy indicator", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:setPrFacts", on: false });
    const loads = posts(p).filter((m) => m.type === "deck:loading").map((m) => m.loading);
    expect(loads).toContain(true);
    expect(loads.at(-1)).toBe(false);
  });

  it("issues every run's Jira lookup at once rather than one at a time", async () => {
    // Serially, a cold board of six runs costs six round trips before anything
    // paints — and Forget waits on that whole pass.
    h.runs = [mkRun(), mkRun({ key: "ASM-2", url: "https://jira/ASM-2" }), mkRun({ key: "ASM-3", url: "https://jira/ASM-3" })];
    let inFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.getStatus.mockImplementation(async () => {
      inFlight++;
      await gate;
      return { status: "In Review", category: "indeterminate" };
    });
    // show() alone: the constructor starts polling with an unawaited refresh, which
    // is the pass under test. Firing a second deck:refresh on top would put six
    // lookups in flight (nothing has resolved, so nothing is cached yet) and the
    // count below would not distinguish serial from parallel.
    show(true);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(inFlight).toBe(3); // all three started before any resolved
    release();
    // Let the released pass finish here rather than leaking pending Jira work into
    // whichever test runs next.
    await new Promise<void>((r) => setTimeout(r, 0));
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: the two bracket tests FAIL (no `deck:loading` posts for forget or setPrFacts), and the parallel test FAILS with `inFlight` equal to `1` — the loop is waiting on the first lookup.

- [ ] **Step 3: Add `refreshBusy` and route every refresh through it**

In `src/deckView.ts`, directly after the `refresh` method:

```ts
  /** Refresh with the webview's busy indicator on. Every inbound message that
   * awaits a refresh goes through here: Forget in particular waits on a full
   * rebuild, and used to do it with nothing on screen to say so. `finally` so a
   * refresh that ever does throw cannot strand the spinner. */
  private async refreshBusy(): Promise<void> {
    this.post({ type: "deck:loading", loading: true });
    try {
      await this.refresh();
    } finally {
      this.post({ type: "deck:loading", loading: false });
    }
  }
```

Then in `onMessage`, replace each refresh call:

```ts
      case "deck:ready":
      case "deck:refresh":
        await this.refreshBusy();
        break;
      case "deck:setLive":
        this.liveSignal = m.on;
        await this.refreshBusy();
        break;
      case "deck:setPrFacts":
        this.prFacts = m.on;
        if (m.on) {
          // Re-probe: the user may have run `gh auth login` since the last check.
          this.ghGap = undefined;
          this.ghProbe = null;
        }
        await this.refreshBusy();
        break;
      case "deck:inspect":
        await this.inspect(m.key, m.action, m.repo);
        break;
      case "deck:forget":
        removeRun(defaultRunsDir(), m.key);
        removePrEntries(defaultPrFactsDir(), m.key);
        // Any fetch already in flight for this key belongs to the incarnation we
        // just deleted — bump the epoch so its write is a no-op if it lands late.
        this.prEpoch.set(m.key, (this.prEpoch.get(m.key) ?? 0) + 1);
        await this.refreshBusy();
        break;
```

The two hand-written `deck:loading` posts in the `deck:ready`/`deck:refresh` case are replaced by the helper, not kept alongside it.

- [ ] **Step 4: Parallelize the Jira pass in `buildAll`**

Replace the head of the `for` loop. Before:

```ts
    const out: RunStatus[] = [];
    for (const run of runs) {
      const tracked = isTicketRun(run);
      const jira = authed && tracked ? await this.jiraStatus(run.key) : null;
```

After:

```ts
    // One round trip per run, all at once. Serially this was the bulk of a cold
    // refresh, and every Forget waits on the whole pass before its card leaves the
    // board. jiraStatus owns its own errors, so this can never reject; run keys are
    // unique, so concurrent calls never duplicate a cache miss.
    const jiras = await Promise.all(
      runs.map((run) => (authed && isTicketRun(run) ? this.jiraStatus(run.key) : null)),
    );
    const out: RunStatus[] = [];
    for (const [i, run] of runs.entries()) {
      const tracked = isTicketRun(run);
      const jira = jiras[i];
```

Everything below — `stored`, the orphan filter, the `ghReady && tracked` block, `buildRunStatus` — is unchanged.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: PASS, including the existing `"fetches Jira status when authenticated and passes it to the builder"` and `"degrades to the git backbone on a Jira auth error"` tests — `jiraStatus` still returns `null` on `JiraAuthError`, only the call site moved.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, 1006 tests.

- [ ] **Step 7: Commit**

```bash
git add src/deckView.ts test/unit/deckView.test.ts
git commit -m "perf(deck): one busy-refresh path, and parallel Jira lookups

Forget, Live signal and PR facts all awaited a full refresh while posting no
loading state at all; one refreshBusy() helper covers every case. buildAll also
awaited one Jira round trip per run inside its loop, which is most of what a
cold refresh — and every Forget — spends its time on.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Verification

- [ ] **Full suite:** `npm test` → 1006 passing, 0 failures.
- [ ] **Typecheck and bundle:** `npm run compile` (or the repo's build script) → no TypeScript errors. `types.ts` now ships a function into the webview bundle; confirm `dist/deck.js` builds.
- [ ] **Coverage on changed files:** `npx vitest run --coverage` → `src/types.ts`, `src/engine/git.ts`, `src/deckView.ts`, `src/webview/DeckApp.tsx` at or above the repo's usual bar.
- [ ] **Manual check in a real window,** since the three defects were all found by using the Deck rather than by a test:
  1. Open the Deck. The `explore-export-asset-file-name-per-asset-type` card shows **no** `pr #241` block, and its key reads `explore`.
  2. `Diff` on a card whose agent has committed opens a diff document with the committed work in it.
  3. `Forget` removes its card instantly, and the header reads `syncing…` while the host catches up.
  4. A tracked card (e.g. `ASM-5809`) still shows its PR, CI, review and merge lines.
- [ ] **Stale cache note:** `~/.agentflow/prfacts/explore-*.json` stays on disk by design (spec, "Explicitly not doing"). It is no longer read.
