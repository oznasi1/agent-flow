# Deck Diff Multi-File Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Deck card's **Diff** button open VS Code's native multi-file diff editor instead of a flat unified-patch text document.

**Architecture:** Three layers. `src/engine/git.ts` gains the two git reads the editor needs — the merge-base sha and the changed-file list. A new `src/engine/diffView.ts` owns everything VS Code-facing: the `agent-flow-base:` URI scheme, the `TextDocumentContentProvider` that serves a file's content at the merge-base, and the function that assembles the resource list and runs the `vscode.changes` command. `src/deckView.ts` keeps only the decision of what to do with the outcome, including falling back to today's flat-patch document when the command is unavailable.

**Tech Stack:** TypeScript, VS Code extension API (`^1.90.0`), vitest with a hand-written `vscode` mock at `test/_mocks/vscode.ts`, `execFileSync` for git.

**Design spec:** [docs/superpowers/specs/2026-08-04-deck-diff-multi-file-editor-design.md](../specs/2026-08-04-deck-diff-multi-file-editor-design.md)

## Global Constraints

- **Every task must leave these green:** `npm run typecheck`, `npm test`. Run both before every commit.
- **Coverage thresholds** (`vitest.config.ts:40`, enforced by `npm run test:cov`): statements 90, branches 85, functions 85, lines 90. Do not lower them.
- **VS Code engine floor is `^1.90.0`** (`package.json:27`). `vscode.changes` requires 1.86+, so it is within the floor.
- **The `vscode` module is never installed.** Source type-checks against `@types/vscode`; at test runtime vitest aliases `import ... from "vscode"` to `test/_mocks/vscode.ts`. Any VS Code API a new code path touches must exist in that mock, or the test throws `undefined is not a function`.
- **`git()` in `src/engine/git.ts` trims its output and swallows every error into `""`.** That is correct for statuses and diffs and *wrong* for file contents — trimming strips the trailing newline and produces a phantom last-line change. File content must go through the untrimmed helper added in Task 1.
- **No new npm dependencies.**
- **Comment style:** this codebase's comments explain *why*, often at length, and never restate what the code says. Match it. Do not add narrating comments like `// loop over files`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/engine/git.ts` (modify) | All git shelling. Gains `taskDiffBase`, `taskChangedFiles`, `showFileAtRef`, and an untrimmed `gitRaw`. |
| `src/engine/diffView.ts` (create) | Everything VS Code-facing about the diff: the URI scheme, the content provider, and `openTaskDiff`. Kept out of `deckView.ts`, which is already 961 lines. |
| `src/extension.ts` (modify) | Registers the content provider as a disposable. |
| `src/deckView.ts` (modify) | `inspect()` calls `openTaskDiff` and maps its outcome to a toast or the fallback document. |
| `test/_mocks/vscode.ts` (modify) | Gains `Uri.from` and `workspace.registerTextDocumentContentProvider`. |
| `test/unit/engine/git.test.ts` (modify) | Covers the three new git functions against real temp repos. |
| `test/unit/engine/diffView.test.ts` (create) | Covers URI round-tripping, the content provider, and the resource list `openTaskDiff` builds. |
| `test/unit/deckView.test.ts` (modify) | Covers the outcome mapping and the fallback. |
| `test/unit/extension.test.ts` (modify) | Covers the provider registration. |

---

### Task 1: The git reads

**Files:**
- Modify: `src/engine/git.ts` (add after `taskDiff`, currently lines 67-78)
- Test: `test/unit/engine/git.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  ```ts
  export type ChangedFile = {
    status: "A" | "M" | "D" | "R";
    path: string;      // repo-relative; the NEW path for a rename
    oldPath?: string;  // repo-relative; set only when status is "R"
    binary: boolean;
  };
  export function taskDiffBase(repoPath: string): string;      // a sha, or "HEAD"
  export function taskChangedFiles(repoPath: string): ChangedFile[];
  export function showFileAtRef(repoPath: string, ref: string, file: string): string;
  ```

**Background the implementer needs:**

`taskDiff` currently computes the merge-base inline and throws it away. Task 2 and Task 3 both need that sha, so it gets extracted and `taskDiff` is rewritten to call it — that way the two cannot drift apart, which matters because the long comment on `taskDiff` documents a real defect that came from getting the base wrong.

`taskDiffBase` returns `"HEAD"` rather than `""` when there is no resolvable base. That keeps `taskDiff` byte-identical in behavior (it already did `from || "HEAD"`) while giving callers a ref they can always pass to `git show`.

**Parsing `--name-status -z`.** `-z` is required because a path may contain a space, and the non-`-z` form makes a rename's two paths ambiguous. Records are NUL-separated: a normal change is `STATUS\0path\0`; a rename or copy is `R100\0oldpath\0newpath\0` (the digits are a similarity score). `git()` calls `.trim()`, which does not strip `\0` in JavaScript, so the final record leaves a trailing empty string — the `if (!status) break` handles it.

**Detecting binary without parsing paths twice.** `git diff --numstat` emits one line per file *in the same order* as `--name-status`, and marks a binary file with `-` in both count columns. So binary-ness is read by line index and the numstat paths are never parsed at all — which sidesteps the awkward `{old => new}` rename form entirely. The non-`-z` numstat is safe here because a path containing a newline gets quoted by git and stays on one line.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/git.test.ts`. This uses the same real-temp-repo-with-a-real-origin setup as the existing `taskDiff` suite, because the base is resolved from `origin/HEAD`.

```ts
describe("taskDiffBase / taskChangedFiles / showFileAtRef", () => {
  let work: string;
  let bare: string;
  const g = (...a: string[]) => execFileSync("git", ["-C", work, ...a], { stdio: ["ignore", "pipe", "ignore"] });

  beforeAll(() => {
    bare = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-origin-cf-"));
    work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-changed-"));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--bare", "-q", bare]);
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", work]);
    g("config", "user.email", "t@t.dev");
    g("config", "user.name", "T");
    fs.writeFileSync(path.join(work, "keep.txt"), "1\n2\n3\n");
    fs.writeFileSync(path.join(work, "gone.txt"), "bye\n");
    fs.writeFileSync(path.join(work, "old name.txt"), "renamed body\nline two\nline three\n");
    fs.writeFileSync(path.join(work, "pic.bin"), Buffer.from([0, 1, 2, 0, 3]));
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    g("remote", "add", "origin", bare);
    g("push", "-q", "-u", "origin", "HEAD");
    g("remote", "set-head", "origin", "-a");

    // Branch off and make one of every change, committed — the case a plain
    // `git diff HEAD` reports as nothing.
    g("checkout", "-q", "-b", "work");
    fs.appendFileSync(path.join(work, "keep.txt"), "4\n");
    fs.rmSync(path.join(work, "gone.txt"));
    fs.renameSync(path.join(work, "old name.txt"), path.join(work, "new name.txt"));
    fs.writeFileSync(path.join(work, "added.txt"), "fresh\n");
    fs.writeFileSync(path.join(work, "pic.bin"), Buffer.from([9, 9, 9, 9, 9]));
    g("add", "-A");
    g("commit", "-q", "-m", "work");
  });

  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  });

  it("resolves a real sha as the base, not HEAD", () => {
    const base = taskDiffBase(work);
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    expect(base).not.toBe(execFileSync("git", ["-C", work, "rev-parse", "HEAD"]).toString().trim());
  });

  it("degrades to HEAD when the repo has no origin to compare with", () => {
    const solo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-solo-"));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", solo]);
    expect(taskDiffBase(solo)).toBe("HEAD");
    fs.rmSync(solo, { recursive: true, force: true });
  });

  it("reports committed adds, modifies and deletes against the base", () => {
    const files = taskChangedFiles(work);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath["added.txt"].status).toBe("A");
    expect(byPath["keep.txt"].status).toBe("M");
    expect(byPath["gone.txt"].status).toBe("D");
  });

  it("reports a rename as one entry carrying both paths, not an add plus a delete", () => {
    const r = taskChangedFiles(work).find((f) => f.status === "R");
    expect(r).toBeTruthy();
    expect(r!.path).toBe("new name.txt");
    expect(r!.oldPath).toBe("old name.txt");
    expect(taskChangedFiles(work).some((f) => f.path === "old name.txt" && f.status === "D")).toBe(false);
  });

  it("flags a binary file and leaves text files unflagged", () => {
    const files = taskChangedFiles(work);
    expect(files.find((f) => f.path === "pic.bin")!.binary).toBe(true);
    expect(files.find((f) => f.path === "keep.txt")!.binary).toBe(false);
  });

  it("returns nothing for a non-git path instead of throwing", () => {
    expect(taskChangedFiles(path.join(work, "nope"))).toEqual([]);
  });

  it("reads a file's content at a ref with its trailing newline intact", () => {
    // Trimming here would strip the final newline and show a phantom
    // last-line change in every diff.
    expect(showFileAtRef(work, taskDiffBase(work), "keep.txt")).toBe("1\n2\n3\n");
  });

  it("returns empty for a file absent at that ref", () => {
    expect(showFileAtRef(work, taskDiffBase(work), "added.txt")).toBe("");
  });
});
```

Add the new names to the existing import at the top of the file:

```ts
import { gitState, taskDiff, taskDiffBase, taskChangedFiles, showFileAtRef, repoRoot, currentBranch, defaultBranch, prEligible } from "../../../src/engine/git";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/git.test.ts`
Expected: FAIL — `taskDiffBase is not a function` (and the same for the other two).

- [ ] **Step 3: Implement**

In `src/engine/git.ts`, add `gitRaw` immediately below the existing `git` helper (which ends at line 20):

```ts
/** Like `git`, but untrimmed — for file *contents*, where the trailing newline is
 * part of the data and stripping it shows a phantom change on the last line. */
function gitRaw(repoPath: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repoPath, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    }).toString();
  } catch {
    return "";
  }
}
```

Replace the body of `taskDiff` (lines 74-78) and add the rest after it:

```ts
export function taskDiff(repoPath: string): string {
  return git(repoPath, ["diff", taskDiffBase(repoPath)]);
}

/** The commit a task's work is measured from: where its branch left the default
 * branch. "HEAD" when there is no resolvable base — a local-only checkout, or a
 * run still sitting on the default branch, where merge-base *is* HEAD anyway. A
 * ref rather than "" so every caller has something it can hand to `git show`. */
export function taskDiffBase(repoPath: string): string {
  const base = defaultRemoteRef(repoPath);
  return (base && git(repoPath, ["merge-base", "HEAD", base])) || "HEAD";
}

/** One entry per file a task touched, with renames kept whole. */
export type ChangedFile = {
  status: "A" | "M" | "D" | "R";
  path: string;
  oldPath?: string;
  binary: boolean;
};

/** Every file this task changed since its base, for driving the multi-file diff
 * editor. `-z` is not optional: a path may contain a space, and without it a
 * rename's two paths cannot be told apart.
 *
 * Binary-ness comes from a second pass, read positionally. `--numstat` emits its
 * rows in the same order as `--name-status` and marks a binary with "-" in both
 * count columns, so matching by line index means never parsing numstat's paths —
 * which is what makes the awkward `{old => new}` rename form a non-problem. */
export function taskChangedFiles(repoPath: string): ChangedFile[] {
  const base = taskDiffBase(repoPath);
  const binary = git(repoPath, ["diff", "--numstat", "-M", base])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.startsWith("-\t-\t"));

  const records = git(repoPath, ["diff", "--name-status", "-M", "-z", base]).split("\0");
  const out: ChangedFile[] = [];
  for (let i = 0; i < records.length; ) {
    const raw = records[i];
    if (!raw) break;
    const code = raw[0];
    const isMove = code === "R" || code === "C";
    const oldPath = isMove ? records[i + 1] : undefined;
    const filePath = isMove ? records[i + 2] : records[i + 1];
    i += isMove ? 3 : 2;
    if (!filePath) break;
    // C (copy) is only ever emitted with --find-copies, which this does not pass,
    // but it shares the three-record shape so it is parsed and then treated as the
    // add it effectively is.
    const status: ChangedFile["status"] =
      code === "A" || code === "C" ? "A" : code === "D" ? "D" : code === "R" ? "R" : "M";
    out.push({
      status,
      path: filePath,
      ...(status === "R" ? { oldPath } : {}),
      binary: binary[out.length] ?? false,
    });
  }
  return out;
}

/** A file's content at a ref, for the left-hand side of a diff. "" when the file
 * did not exist there, which the caller reads as "nothing to compare against". */
export function showFileAtRef(repoPath: string, ref: string, file: string): string {
  return gitRaw(repoPath, ["show", `${ref}:${file}`]);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/git.test.ts`
Expected: PASS, including the pre-existing `taskDiff` and `gitState` suites.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/engine/git.ts test/unit/engine/git.test.ts
git commit -m "feat(git): expose the task diff base and its changed-file list"
```

---

### Task 2: The base-content provider and its registration

**Files:**
- Create: `src/engine/diffView.ts`
- Modify: `src/extension.ts` (the `context.subscriptions.push(` block starting at line 59)
- Modify: `test/_mocks/vscode.ts`
- Test: `test/unit/engine/diffView.test.ts` (create), `test/unit/extension.test.ts`

**Interfaces:**
- Consumes: `showFileAtRef(repoPath, ref, file)` from Task 1.
- Produces:
  ```ts
  export const BASE_SCHEME = "agent-flow-base";
  export function baseUri(repoPath: string, ref: string, file: string): vscode.Uri;
  export class TaskBaseContentProvider implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(uri: vscode.Uri): string;
  }
  ```

**Background the implementer needs:**

The left-hand side of each diff is a file as it was at the merge-base. Nothing on disk holds that, so it is served by a `TextDocumentContentProvider` on a custom scheme. A content provider is read-only by construction, which is exactly what is wanted for the base side — only the right-hand side should be editable.

The URI has to carry three things the provider needs: which repo, which ref, which file. They go in `query` as JSON; the file path *also* goes in `path` so anything that surfaces the URI shows something human-readable rather than an opaque blob.

`vscode.Uri.from` and `workspace.registerTextDocumentContentProvider` are both absent from the hand-written mock and must be added, or every test touching this throws.

- [ ] **Step 1: Extend the vscode mock**

In `test/_mocks/vscode.ts`, add to the `Uri` object (currently lines 216-223), after `joinPath`:

```ts
  from: vi.fn((c: { scheme: string; path?: string; query?: string }) => ({
    scheme: c.scheme,
    path: c.path ?? "",
    query: c.query ?? "",
    fsPath: c.path ?? "",
    toString: () => `${c.scheme}:${c.path ?? ""}${c.query ? `?${c.query}` : ""}`,
  })),
```

Add to the `workspace` object (currently lines 203-214), after `openTextDocument`:

```ts
  registerTextDocumentContentProvider: vi.fn((_scheme: string, _provider: unknown) => ({ dispose: vi.fn() })),
```

And in `resetVscodeMocks`, alongside the other `workspace.*` resets:

```ts
  workspace.registerTextDocumentContentProvider.mockReset().mockImplementation(() => ({ dispose: vi.fn() }));
```

- [ ] **Step 2: Write the failing tests**

Create `test/unit/engine/diffView.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { BASE_SCHEME, baseUri, TaskBaseContentProvider } from "../../../src/engine/diffView";

const h = vi.hoisted(() => ({ showFileAtRef: vi.fn((_r: string, _ref: string, _f: string) => "") }));
vi.mock("../../../src/engine/git", () => ({
  showFileAtRef: h.showFileAtRef,
  taskDiffBase: vi.fn(() => "HEAD"),
  taskChangedFiles: vi.fn(() => []),
}));

describe("baseUri", () => {
  it("uses the extension's own scheme so the content provider is asked", () => {
    expect(baseUri("/r/svc", "abc123", "src/a.ts").scheme).toBe(BASE_SCHEME);
  });

  it("puts the file path where a reader can see it", () => {
    expect(baseUri("/r/svc", "abc123", "src/a.ts").path).toBe("/src/a.ts");
  });

  it("round-trips the repo, ref and file through the provider", () => {
    h.showFileAtRef.mockReturnValue("body\n");
    const content = new TaskBaseContentProvider().provideTextDocumentContent(
      baseUri("/r/svc", "abc123", "src/a.ts") as never,
    );
    expect(h.showFileAtRef).toHaveBeenCalledWith("/r/svc", "abc123", "src/a.ts");
    expect(content).toBe("body\n");
  });

  it("round-trips a path containing spaces", () => {
    new TaskBaseContentProvider().provideTextDocumentContent(
      baseUri("/r/svc", "abc123", "docs/old name.md") as never,
    );
    expect(h.showFileAtRef).toHaveBeenCalledWith("/r/svc", "abc123", "docs/old name.md");
  });

  it("serves empty for a URI it cannot decode instead of throwing", () => {
    const p = new TaskBaseContentProvider();
    expect(p.provideTextDocumentContent({ query: "not json" } as never)).toBe("");
  });
});
```

Add to `test/unit/extension.test.ts`, inside the existing `describe("activate", ...)` block that starts at line 66. Add `workspace` to the `../_mocks/vscode` import on line 2, and add `import { BASE_SCHEME } from "../../src/engine/diffView";` alongside the other source imports around line 51:

```ts
  it("registers the diff base content provider so the Diff editor's left side resolves", () => {
    const { context } = fakeContext();
    activate(context);

    expect(workspace.registerTextDocumentContentProvider).toHaveBeenCalledWith(
      BASE_SCHEME,
      expect.anything(),
    );
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/diffView.test.ts test/unit/extension.test.ts`
Expected: FAIL — cannot resolve `src/engine/diffView`.

- [ ] **Step 4: Implement the provider**

Create `src/engine/diffView.ts`:

```ts
import * as vscode from "vscode";
import { showFileAtRef } from "./git";

/** The scheme the left-hand side of every task diff is served on. A file's content
 * at the merge-base exists in no working tree, so it cannot be a `file:` URI — and
 * a TextDocumentContentProvider is read-only by construction, which is exactly
 * right for the "before" side. */
export const BASE_SCHEME = "agent-flow-base";

type BaseRef = { repo: string; ref: string; file: string };

/** A URI naming one file as it stood at a task's base. The three facts the provider
 * needs ride in `query`; the file path is repeated in `path` so anything that
 * surfaces the URI shows a readable name rather than an opaque blob. */
export function baseUri(repoPath: string, ref: string, file: string): vscode.Uri {
  const payload: BaseRef = { repo: repoPath, ref, file };
  return vscode.Uri.from({ scheme: BASE_SCHEME, path: `/${file}`, query: JSON.stringify(payload) });
}

export class TaskBaseContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    let ref: BaseRef;
    try {
      ref = JSON.parse(uri.query) as BaseRef;
    } catch {
      // A malformed URI is not worth a popup: an empty left side reads as "this
      // file is new", which is wrong but harmless, and a throw here would leave
      // the whole multi-file editor blank.
      return "";
    }
    return showFileAtRef(ref.repo, ref.ref, ref.file);
  }
}
```

- [ ] **Step 5: Register it**

In `src/extension.ts`, add the import alongside the other engine imports:

```ts
import { BASE_SCHEME, TaskBaseContentProvider } from "./engine/diffView";
```

and add this as the first entry inside `context.subscriptions.push(` (line 59), just above `output`:

```ts
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, new TaskBaseContentProvider()),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/diffView.test.ts test/unit/extension.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/engine/diffView.ts src/extension.ts test/_mocks/vscode.ts test/unit/engine/diffView.test.ts test/unit/extension.test.ts
git commit -m "feat(deck): serve a task's base file contents on its own URI scheme"
```

---

### Task 3: Opening the multi-file diff editor

**Files:**
- Modify: `src/engine/diffView.ts`
- Test: `test/unit/engine/diffView.test.ts`

**Interfaces:**
- Consumes: `baseUri` and `BASE_SCHEME` from Task 2; `taskDiffBase` and `taskChangedFiles` (with the `ChangedFile` type) from Task 1.
- Produces:
  ```ts
  export type DiffOutcome = "opened" | "empty" | "binary-only" | "unsupported";
  export function openTaskDiff(
    title: string,
    repos: { name: string; path: string }[],
  ): Promise<DiffOutcome>;
  ```

**Background the implementer needs:**

`vscode.changes` is a built-in command with the signature `(title: string, resourceList: [Uri, Uri | undefined, Uri | undefined][])`. Each tuple is `[resource, left, right]`: `resource` is the identity the editor labels and groups by, `left` is `undefined` for an added file, and `right` is `undefined` for a deleted one. This is the same way the official GitHub Pull Requests extension drives it.

The right-hand side is a plain `file:` URI into the run's worktree. That is deliberate and was decided in the spec: it makes the diff editable, so a typo spotted while reading can be fixed and saved in place.

`openTaskDiff` returns an outcome rather than raising toasts itself, so the panel keeps ownership of user-facing messaging and this module stays testable without a webview.

The `unsupported` outcome exists because `vscode.changes` is a *command*, not a typed API — nothing in `@types/vscode` guarantees a VS Code fork registered it. Cursor is the concern. Rejecting is how the absence shows up, so the rejection is caught and reported rather than swallowed.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/diffView.test.ts`. Extend the top-of-file mock block first so the two new git functions are controllable:

```ts
const h = vi.hoisted(() => ({
  showFileAtRef: vi.fn((_r: string, _ref: string, _f: string) => ""),
  taskDiffBase: vi.fn((_r: string) => "base-sha"),
  taskChangedFiles: vi.fn((_r: string): ChangedFile[] => []),
}));
vi.mock("../../../src/engine/git", () => ({
  showFileAtRef: h.showFileAtRef,
  taskDiffBase: h.taskDiffBase,
  taskChangedFiles: h.taskChangedFiles,
}));
```

and update the imports — add `beforeEach` to the existing `vitest` import, add `openTaskDiff` to the existing `diffView` import, and add two new lines:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { commands } from "../../_mocks/vscode";
import { BASE_SCHEME, baseUri, openTaskDiff, TaskBaseContentProvider } from "../../../src/engine/diffView";
import type { ChangedFile } from "../../../src/engine/git";
```

Then the suite:

```ts
describe("openTaskDiff", () => {
  const svc = [{ name: "svc", path: "/r/svc" }];
  const args = () => commands.executeCommand.mock.calls.at(-1)!;
  const list = () => args()[2] as [{ fsPath: string }, unknown, unknown][];

  beforeEach(() => {
    h.taskDiffBase.mockReturnValue("base-sha");
    h.taskChangedFiles.mockReturnValue([]);
  });

  it("reports empty and opens nothing when the task changed no files", async () => {
    expect(await openTaskDiff("Changes in ASM-1", svc)).toBe("empty");
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it("reports binary-only when every change was a binary file", async () => {
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "pic.bin", binary: true }]);
    expect(await openTaskDiff("Changes in ASM-1", svc)).toBe("binary-only");
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it("drops binary files but still opens the text ones", async () => {
    h.taskChangedFiles.mockReturnValue([
      { status: "M", path: "pic.bin", binary: true },
      { status: "M", path: "a.ts", binary: false },
    ]);
    expect(await openTaskDiff("Changes in ASM-1", svc)).toBe("opened");
    expect(list()).toHaveLength(1);
    expect(list()[0][0].fsPath).toContain("a.ts");
  });

  it("runs the multi-file diff command with the run's key as the title", async () => {
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.ts", binary: false }]);
    await openTaskDiff("Changes in ASM-1", svc);
    expect(args()[0]).toBe("vscode.changes");
    expect(args()[1]).toBe("Changes in ASM-1");
  });

  it("gives a modified file both sides", async () => {
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.ts", binary: false }]);
    await openTaskDiff("t", svc);
    const [resource, left, right] = list()[0];
    expect(resource.fsPath).toBe("/r/svc/a.ts");
    expect((left as { scheme: string }).scheme).toBe(BASE_SCHEME);
    expect(right).toBe(resource);
  });

  it("gives an added file no left side", async () => {
    h.taskChangedFiles.mockReturnValue([{ status: "A", path: "new.ts", binary: false }]);
    await openTaskDiff("t", svc);
    const [, left, right] = list()[0];
    expect(left).toBeUndefined();
    expect(right).toBeDefined();
  });

  it("gives a deleted file no right side", async () => {
    h.taskChangedFiles.mockReturnValue([{ status: "D", path: "old.ts", binary: false }]);
    await openTaskDiff("t", svc);
    const [, left, right] = list()[0];
    expect(left).toBeDefined();
    expect(right).toBeUndefined();
  });

  it("points a rename's left side at the old path so it diffs as one change", async () => {
    h.taskChangedFiles.mockReturnValue([
      { status: "R", path: "new name.ts", oldPath: "old name.ts", binary: false },
    ]);
    await openTaskDiff("t", svc);
    const [resource, left] = list()[0];
    expect(resource.fsPath).toBe("/r/svc/new name.ts");
    expect((left as { path: string }).path).toBe("/old name.ts");
  });

  it("lists every repo's files in one editor", async () => {
    h.taskChangedFiles.mockImplementation((repo: string) =>
      [{ status: "M" as const, path: repo === "/r/svc" ? "a.ts" : "b.ts", binary: false }]);
    await openTaskDiff("t", [{ name: "svc", path: "/r/svc" }, { name: "web", path: "/r/web" }]);
    expect(list().map((e) => e[0].fsPath).sort()).toEqual(["/r/svc/a.ts", "/r/web/b.ts"]);
  });

  it("reports unsupported when the editor has no such command", async () => {
    // Cursor and other forks may not have registered vscode.changes.
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.ts", binary: false }]);
    commands.executeCommand.mockRejectedValueOnce(new Error("command 'vscode.changes' not found"));
    expect(await openTaskDiff("t", svc)).toBe("unsupported");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/diffView.test.ts`
Expected: FAIL — `openTaskDiff is not a function`.

- [ ] **Step 3: Implement**

Add to `src/engine/diffView.ts`. Extend the existing imports:

```ts
import * as path from "path";
import { ChangedFile, showFileAtRef, taskChangedFiles, taskDiffBase } from "./git";
```

and append:

```ts
/** What came of trying to show a task's diff. The caller owns the messaging, so
 * this reports rather than toasts. */
export type DiffOutcome = "opened" | "empty" | "binary-only" | "unsupported";

/** A `[resource, left, right]` triple as `vscode.changes` wants it: `left` absent
 * means the file was added, `right` absent means it was deleted. */
type Resource = [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined];

function resourceFor(repoPath: string, base: string, f: ChangedFile): Resource {
  // The right side is the real file in the worktree, not a snapshot — so the diff
  // shows uncommitted work, and a typo spotted while reading can be fixed in place.
  const right = vscode.Uri.file(path.join(repoPath, f.path));
  if (f.status === "A") return [right, undefined, right];
  const left = baseUri(repoPath, base, f.oldPath ?? f.path);
  if (f.status === "D") return [right, left, undefined];
  return [right, left, right];
}

/**
 * Show everything a task changed in VS Code's native multi-file diff editor.
 *
 * Repos are listed flat rather than grouped: the editor builds its own tree from
 * the absolute paths, so each repo root becomes a group for free.
 *
 * Binary files are dropped. Their left side would come through a *text* content
 * provider, which renders them as mojibake — worse than not showing them.
 */
export async function openTaskDiff(
  title: string,
  repos: { name: string; path: string }[],
): Promise<DiffOutcome> {
  const resources: Resource[] = [];
  let sawBinary = false;
  for (const repo of repos) {
    const base = taskDiffBase(repo.path);
    for (const f of taskChangedFiles(repo.path)) {
      if (f.binary) {
        sawBinary = true;
        continue;
      }
      resources.push(resourceFor(repo.path, base, f));
    }
  }
  if (resources.length === 0) return sawBinary ? "binary-only" : "empty";

  try {
    await vscode.commands.executeCommand("vscode.changes", title, resources);
    return "opened";
  } catch {
    // `vscode.changes` is a built-in command, not a typed API, so a VS Code fork
    // may simply not have it. Rejecting is how that shows up, and the caller has
    // a flat-patch fallback for exactly this.
    return "unsupported";
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/diffView.test.ts`
Expected: PASS, all suites in the file.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/engine/diffView.ts test/unit/engine/diffView.test.ts
git commit -m "feat(deck): assemble a task's changes for the multi-file diff editor"
```

---

### Task 4: Wire the Deck's Diff button to it

**Files:**
- Modify: `src/deckView.ts` — the `inspect` method at lines 802-832, and the import at line 13
- Modify: `src/webview/DeckApp.tsx:293` — the button tooltip
- Test: `test/unit/deckView.test.ts` — the three existing diff tests at lines 409-442, plus new ones

**Interfaces:**
- Consumes: `openTaskDiff` and `DiffOutcome` from Task 3; the existing `taskDiff` from `./engine/git`.
- Produces: no new exports. This is the last task.

**Background the implementer needs:**

`inspect()` handles both the `open` and `diff` actions. Only the `diff` half changes — everything from the `// diff —` comment at line 818 to the end of the method.

The flat-patch document is *kept*, but only as the `unsupported` fallback. It is not exposed in the UI: one button, one behavior, with the old rendering appearing only where the new one cannot run.

Three existing tests in `test/unit/deckView.test.ts` assert the old behavior and must be reworked rather than deleted — the fallback path still needs coverage:

- `"inspect diff on a repo with no changes toasts instead of opening a doc"` (line 409) still holds, but the reason it passes changes: `openTaskDiff` returns `"empty"` because the mocked `taskChangedFiles` returns nothing.
- `"inspect diff opens the task's whole diff as a read-only diff document"` (line 418) becomes the fallback test — force `commands.executeCommand` to reject, then assert the document still opens.
- `"labels each repo's chunk when a run spans more than one"` (line 429) is about the flat document's `# reponame` headers, which now only exist in the fallback. Force the rejection there too.

The suite's hoisted mock block (`const h = vi.hoisted(...)` near the top) already stubs `taskDiff`; add `taskChangedFiles` and `taskDiffBase` beside it and include them in whichever `vi.mock("../../src/engine/git", ...)` factory the file already declares.

- [ ] **Step 1: Write the failing tests**

Add `taskChangedFiles` and `taskDiffBase` to the hoisted block in `test/unit/deckView.test.ts`:

```ts
  taskDiffBase: vi.fn((_p: string) => "base-sha"),
  taskChangedFiles: vi.fn((_p: string): ChangedFile[] => []),
```

with `import type { ChangedFile } from "../../src/engine/git";` added to the imports, `commands` added to the `../_mocks/vscode` import, and both names added to the existing `vi.mock` factory for `../../src/engine/git`.

Replace the two tests at lines 418-442 and add the rest:

```ts
  it("inspect diff opens the native multi-file editor titled with the run key", async () => {
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.txt", binary: false }]);
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "diff" });
    const call = commands.executeCommand.mock.calls.at(-1)!;
    expect(call[0]).toBe("vscode.changes");
    expect(call[1]).toBe("Changes in ASM-1");
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it("falls back to the flat patch document when the editor has no such command", async () => {
    // Cursor and other forks may not have registered vscode.changes. Losing the
    // Diff button entirely there would be worse than the old rendering.
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.txt", binary: false }]);
    h.taskDiff.mockReturnValue("diff --git a/a.txt b/a.txt\n+committed\n");
    commands.executeCommand.mockRejectedValueOnce(new Error("no such command"));
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "diff" });
    expect(workspace.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("+committed"), language: "diff" }),
    );
  });

  it("labels each repo's chunk in the fallback document when a run spans more than one", async () => {
    h.runs = [mkRun({ repos: [
      { name: "svc", path: "/r/svc", isGit: true, branch: "b" },
      { name: "web", path: "/r/web", isGit: true, branch: "b" },
    ] })];
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.txt", binary: false }]);
    h.taskDiff.mockReturnValue("diff --git a/a.txt b/a.txt\n+x\n");
    commands.executeCommand.mockRejectedValueOnce(new Error("no such command"));
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "diff" });
    const arg = workspace.openTextDocument.mock.calls.at(-1)![0] as { content: string };
    expect(arg.content).toContain("# svc");
    expect(arg.content).toContain("# web");
  });

  it("toasts rather than opening an empty editor when only binaries changed", async () => {
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "pic.bin", binary: true }]);
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "diff" });
    const toast = posts(p).find((m) => m.type === "toast");
    expect(toast.message).toMatch(/binary/i);
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it("diffs only the named repo when a card acts on one", async () => {
    h.runs = [mkRun({ repos: [
      { name: "svc", path: "/r/svc", isGit: true, branch: "b" },
      { name: "web", path: "/r/web", isGit: true, branch: "b" },
    ] })];
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.txt", binary: false }]);
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "diff", repo: "web" });
    expect(h.taskChangedFiles).toHaveBeenCalledWith("/r/web");
    expect(h.taskChangedFiles).not.toHaveBeenCalledWith("/r/svc");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: FAIL — `vscode.changes` is never executed, because `inspect` still builds a text document.

- [ ] **Step 3: Implement**

In `src/deckView.ts`, extend the import at line 13:

```ts
import { currentBranch, prEligible, repoRoot, taskDiff } from "./engine/git";
import { openTaskDiff } from "./engine/diffView";
```

Replace everything from line 818 (`// diff — ...`) to line 832 (the closing `}` of `inspect`) with:

```ts
    // diff — everything this task changed, committed work included, in the editor's
    // own multi-file diff view.
    const repos = repoName ? run.repos.filter((r) => r.name === repoName) : run.repos;
    const outcome = await openTaskDiff(`Changes in ${run.key}`, repos);
    if (outcome === "opened") return;
    if (outcome === "empty") {
      this.toast("info", `No changes to show for ${key}.`);
      return;
    }
    if (outcome === "binary-only") {
      this.toast("info", `Only binary files changed for ${key}.`);
      return;
    }
    // unsupported — `vscode.changes` is a built-in command rather than a typed API,
    // so an editor that forked VS Code may not have it. The flat patch this used to
    // always produce is a worse read, but it is far better than a dead button.
    const chunks: string[] = [];
    for (const r of repos) {
      const d = taskDiff(r.path);
      if (d.trim()) chunks.push(run.repos.length > 1 ? `# ${r.name}\n${d}` : d);
    }
    if (chunks.length === 0) {
      this.toast("info", `No changes to show for ${key}.`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ content: chunks.join("\n\n"), language: "diff" });
    await vscode.window.showTextDocument(doc, { preview: true });
  }
```

In `src/webview/DeckApp.tsx:293`, update the tooltip to describe what now happens:

```tsx
          <button className="act" title="Show everything this task changed, file by file" onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "diff" })}>Diff</button>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: PASS, including the untouched `open`-action tests.

- [ ] **Step 5: Check coverage**

Run: `npm run test:cov`
Expected: PASS with statements ≥90, branches ≥85, functions ≥85, lines ≥90. If `src/engine/diffView.ts` drags branches down, the gap is most likely an unexercised `status` arm in `resourceFor` — add the missing case to `test/unit/engine/diffView.test.ts`.

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/deckView.ts src/webview/DeckApp.tsx test/unit/deckView.test.ts
git commit -m "feat(deck): open Diff in the native multi-file diff editor"
```

---

## Manual verification before merge

Automated tests cannot answer the one question that decides whether this feature works where it ships. Do this by hand:

- [ ] Build and install the VSIX, then open a Deck card with a multi-file run **in Cursor** and click **Diff**. Confirm the multi-file editor opens. If it does not, confirm the flat-patch fallback appears instead of nothing happening, and report which behavior you saw — that result determines whether the fallback stays permanent or gets removed.
- [ ] In VS Code, confirm on a run with an add, a modify, a delete and a rename that all four render correctly and the file tree groups by repo on a multi-repo run.
- [ ] Edit a line on the right-hand side and save. Confirm it writes into the run's worktree.
