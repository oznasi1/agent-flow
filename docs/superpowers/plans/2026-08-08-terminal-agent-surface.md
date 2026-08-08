# Terminal Agent Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `agentFlow.agentSurface` so a user can have Agent Flow start sessions in the `claude` CLI in an integrated terminal instead of the Claude Code extension panel, with the panel remaining the default.

**Architecture:** Every launch path (take, batch, Deck relaunch, Explore, Notepad, PR review) funnels through `writePlanFile` → `runSeedPass` → `seedClaudeCode` in `src/engine/workspace.ts`. The surface choice forks inside that one function: the current body becomes the `extension` branch, a new `seedViaTerminal` becomes the `terminal` branch. No call sites change. The setting is read at seed time in the target window, never carried in the plan file.

**Tech Stack:** TypeScript, VS Code extension API (`window.createTerminal`, `Terminal.sendText`), vitest with a hand-written `vscode` module mock (`test/_mocks/vscode.ts`), esbuild.

**Spec:** [`docs/superpowers/specs/2026-08-08-terminal-agent-surface-design.md`](../specs/2026-08-08-terminal-agent-surface-design.md)

## Global Constraints

- **Default must be `extension`.** Any unrecognized or absent value resolves to `"extension"`. A user who never touches the setting sees byte-identical behavior to today.
- **The prompt is never auto-submitted.** The final `sendText` for the prompt must pass `addNewLine === false` in both branches' spirit — the user presses Enter.
- **Setting key is exactly `agentFlow.agentSurface`**, values exactly `"extension"` and `"terminal"`.
- **Terminal name format is exactly** `` `Claude · ${key}` `` (U+00B7 MIDDLE DOT, spaces either side).
- **CLI command is the fixed string `"claude"`.** No configurable command, no flags, no Doctor preflight.
- **`npm run build` must pass, not just `npx tsc --noEmit`.** Config is imported by webview-adjacent code; only the real build catches a Node-only import leaking into `src/webview/`.
- **Coverage ≥95% on every changed file.**
- **Manifest parity is enforced by tests.** A new enum in `package.json` must be mirrored in `src/telemetry/settingsSnapshot.ts` or `test/unit/telemetry/settingsSnapshot.test.ts` fails.
- **Run the full suite with `npx vitest run`** before each commit.

---

### Task 1: The `agentFlow.agentSurface` setting

Adds the setting and makes it readable and reportable. Nothing consumes it yet — that's Task 2. Deliverable: `getConfig().agentSurface` returns a validated value and telemetry reports it.

**Files:**
- Modify: `package.json` (`contributes.configuration.properties`, after `agentFlow.seedAgent`)
- Modify: `src/config.ts` (new `AgentSurface` type + `readAgentSurface`, `AgentFlowConfig` field, `getConfig()` body)
- Modify: `src/telemetry/settingsSnapshot.ts` (new `AGENT_SURFACES` const, new `agent_surface` field)
- Modify: `README.md:285` area (settings table row)
- Modify: `docs/TELEMETRY.md:176` and `:182` (the enum-field list and its hardcoded count)
- Test: `test/unit/config.test.ts`
- Test: `test/unit/telemetry/settingsSnapshot.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type AgentSurface = "extension" | "terminal"` from `src/config.ts`
  - `export function readAgentSurface(c?: vscode.WorkspaceConfiguration): AgentSurface` from `src/config.ts` — Task 2 calls this with no argument.
  - `AgentFlowConfig.agentSurface: AgentSurface`
  - `export const AGENT_SURFACES = ["extension", "terminal"] as const` from `src/telemetry/settingsSnapshot.ts`
  - `settingsSnapshot(...).agent_surface: "extension" | "terminal" | "invalid"`

- [ ] **Step 1: Write the failing config tests**

In `test/unit/config.test.ts`. That file already imports what you need at line 19 — `import { setConfig, setDefaultConfig } from "../_mocks/vscode";` — so no import change is required.

**The config store persists across tests in this file** (it has no resetting `beforeEach`, and `setConfig` merges rather than replaces). So the default-case test must clear the key explicitly rather than assuming it was never set. `"agentSurface" in configStore` is true even when the stored value is `undefined`, and the mock's `get` returns that `undefined` — which is exactly the "unset" condition `readAgentSurface` must handle.

```ts
describe("agentSurface", () => {
  it("defaults to the extension panel when unset", () => {
    setConfig({ agentSurface: undefined });
    expect(getConfig().agentSurface).toBe("extension");
  });

  it("reads terminal when set", () => {
    setConfig({ agentSurface: "terminal" });
    expect(getConfig().agentSurface).toBe("terminal");
  });

  it("falls back to extension for an unrecognized value", () => {
    // A typo in settings.json must not silently disable seeding — it degrades
    // to the default surface, the same way remoteControl degrades to "off".
    setConfig({ agentSurface: "tmux" });
    expect(getConfig().agentSurface).toBe("extension");
  });
});
```

Check how `config.test.ts` resets the config store between tests (a `beforeEach` calling `setConfig({...})` with explicit values, or a reset helper). If the store persists across tests, set `agentSurface: undefined` in the default-case test so a prior test's value can't leak in.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — `agentSurface` is not a property of the object `getConfig()` returns (undefined, and a TS error on the property access).

- [ ] **Step 3: Add the type, the reader, and the interface field**

In `src/config.ts`, near the other exported types:

```ts
/** Where Agent Flow starts a session. */
export type AgentSurface = "extension" | "terminal";

/** Read the session surface. Anything unrecognized — including undefined — means
 * the extension panel, so a typo in settings.json degrades to the default rather
 * than breaking seeding. Takes the configuration so getConfig() can share its
 * handle; called with no argument from the seeding path, which reads at seed time
 * rather than capturing at activation. */
export function readAgentSurface(
  c: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("agentFlow"),
): AgentSurface {
  return c.get<string>("agentSurface") === "terminal" ? "terminal" : "extension";
}
```

In the `AgentFlowConfig` interface, next to `seedAgent` (around `src/config.ts:201`):

```ts
  // Where a seeded session opens: the Claude Code extension panel, or the `claude`
  // CLI in an integrated terminal.
  agentSurface: AgentSurface;
```

In `getConfig()`, next to the `seedAgent` line (around `src/config.ts:399`):

```ts
    agentSurface: readAgentSurface(c),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/config.test.ts`
Expected: PASS (3 new tests).

- [ ] **Step 5: Add the manifest entry**

In `package.json`, in `contributes.configuration.properties` immediately after `agentFlow.seedAgent`:

```json
"agentFlow.agentSurface": {
  "type": "string",
  "enum": ["extension", "terminal"],
  "enumDescriptions": [
    "The Claude Code extension panel",
    "The `claude` CLI in an integrated terminal"
  ],
  "default": "extension",
  "description": "Where Agent Flow starts a session: the Claude Code extension panel, or the `claude` CLI in an integrated terminal. Either way the prompt is pre-filled and you press Enter to start."
},
```

- [ ] **Step 6: Write the failing telemetry tests**

In `test/unit/telemetry/settingsSnapshot.test.ts`. Add to the existing `describe("package.json ⇄ settingsSnapshot enum whitelists")` block, matching its neighbors exactly:

```ts
  it("keeps AGENT_SURFACES equal to agentFlow.agentSurface's manifest enum", () => {
    expect([...AGENT_SURFACES]).toEqual(props["agentFlow.agentSurface"].enum);
  });

  it("keeps agentFlow.agentSurface's enum and enumDescriptions the same length", () => {
    expect(props["agentFlow.agentSurface"].enumDescriptions?.length).toBe(
      props["agentFlow.agentSurface"].enum?.length,
    );
  });
```

And a reporting test alongside the other `enumOrInvalid` cases (mirroring the `task_source` test at line ~195):

```ts
  it("reports the agent surface, collapsing an unknown value to invalid", () => {
    expect(settingsSnapshot({ ...getConfig(), agentSurface: "terminal" }).agent_surface).toBe("terminal");
    expect(
      settingsSnapshot({ ...getConfig(), agentSurface: "tmux" as never }).agent_surface,
    ).toBe("invalid");
  });
```

Add `AGENT_SURFACES` to that file's existing import from `../../../src/telemetry/settingsSnapshot`.

- [ ] **Step 7: Run the telemetry tests to verify they fail**

Run: `npx vitest run test/unit/telemetry/settingsSnapshot.test.ts`
Expected: FAIL — `AGENT_SURFACES` is not exported; `agent_surface` is undefined.

- [ ] **Step 8: Add the telemetry constant and field**

In `src/telemetry/settingsSnapshot.ts`, with the other enum whitelists (after `REMOTE_CONTROL_MODES`, around line 43):

```ts
export const AGENT_SURFACES = ["extension", "terminal"] as const;
```

In the returned snapshot object, next to `open_in` (around line 89):

```ts
    agent_surface: enumOrInvalid(cfg.agentSurface, AGENT_SURFACES),
```

- [ ] **Step 9: Run the telemetry tests to verify they pass**

Run: `npx vitest run test/unit/telemetry/settingsSnapshot.test.ts`
Expected: PASS.

- [ ] **Step 10: Document the setting in the README table**

In `README.md`, immediately after the `agentFlow.seedAgent` row (line 285):

```markdown
| `agentFlow.agentSurface` | `extension` | Where a session starts: the Claude Code extension panel, or `terminal` to run the `claude` CLI in an integrated terminal. Either way the prompt is pre-filled and you press Enter. |
```

- [ ] **Step 11: Update `docs/TELEMETRY.md`**

This file documents every reported field and it is **not** optional — it currently hardcodes the *count* of enum fields, so adding one makes the prose wrong.

At line ~176, add `agent_surface` to the row listing the enum-or-invalid fields:

```markdown
| `workspace_mode`, `open_in`, `agent_surface`, `explore_mode`, `worktree`, `remote_control`, `default_filter` | One of that setting's shipped choices, or the literal string `"invalid"` |
```

At line ~182, the sentence begins **"Six of the fields above (`workspace_mode`, `open_in`, `explore_mode`, `worktree`, `remote_control`, `default_filter`) can…"**. Change `Six` to `Seven` and add `agent_surface` to that parenthetical, in the same position as in the table row. Read the full sentence before editing — match its existing wording exactly rather than rewriting it.

- [ ] **Step 12: Run the full suite and the build**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all pass.

- [ ] **Step 13: Commit**

```bash
git add package.json src/config.ts src/telemetry/settingsSnapshot.ts README.md docs/TELEMETRY.md test/unit/config.test.ts test/unit/telemetry/settingsSnapshot.test.ts
git commit -m "feat(config): add agentFlow.agentSurface (extension | terminal)

The setting, its validated reader, and telemetry reporting. Nothing
consumes it yet — the seeding fork lands next. Default is extension, so
behavior is unchanged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Seed into a terminal

The core of the feature. Adds `window.createTerminal` to the vscode mock, the bracketed-paste helper, `seedViaTerminal`, and the fork in `seedClaudeCode`. Deliverable: with `agentSurface: "terminal"`, a taken task opens a named terminal running `claude` with the prompt pre-typed and unsubmitted.

**Files:**
- Modify: `test/_mocks/vscode.ts` (add `createTerminal` to the `window` namespace)
- Modify: `src/engine/workspace.ts` (constants, `bracketedPaste`, `seedViaTerminal`, `seedClaudeCode` signature + fork, its call site in `runSeedPass`)
- Test: `test/unit/engine/workspace.test.ts` (the existing `describe("maybeSeedAgent")` block)

**Interfaces:**
- Consumes: `readAgentSurface()` from `src/config.ts` (Task 1).
- Produces:
  - `seedClaudeCode(opts: { prompt: string; key: string; matchPath: string; log: (m: string) => void; remoteControl?: boolean; multi?: boolean }): Promise<void>` — module-private, reshaped from positional params to an options object. Task 3 depends on this exact shape.
  - `seedViaTerminal(seedText: string, key: string, matchPath: string, log: (m: string) => void): Promise<boolean>` — module-private; `true` = seeded, `false` = caller should fall back.
  - `const CLI_BOOT_MS = 1500` — module-private; Task 4 tunes this value.

- [ ] **Step 1: Add `createTerminal` to the vscode mock**

In `test/_mocks/vscode.ts`, inside the `window` object (line 88-100). It does not exist yet.

```ts
  createTerminal: vi.fn((_opts?: unknown) => makeTerminal()),
```

And above `export const window`, next to `makeWebviewPanel`:

```ts
/** A fake Terminal. `sendText` records `(text, addNewLine)` pairs so a test can
 * assert both what was typed and whether it was submitted — the distinction the
 * "you press Enter" contract turns on. */
export function makeTerminal() {
  return {
    sendText: vi.fn((_text: string, _addNewLine?: boolean) => {}),
    show: vi.fn((_preserveFocus?: boolean) => {}),
    dispose: vi.fn(),
  };
}
```

Note: `createTerminal` returns a **fresh** terminal per call, so a test asserting on `sendText` must reach it through `window.createTerminal.mock.results[i].value`.

- [ ] **Step 2: Write the failing terminal tests**

In `test/unit/engine/workspace.test.ts`, inside the existing `describe("maybeSeedAgent")` block. Import the mock's `window` handle — it is already imported at line 5. Add `setConfig` to the imports from `../../_mocks/vscode`.

The boot delay means every terminal test needs the file's established fake-timer pattern (see the test at line 338):

```ts
  /** Drive one seed pass to completion with the CLI boot delay faked away. */
  const seedWithTimers = async (context: Parameters<typeof maybeSeedAgent>[0]) => {
    vi.useFakeTimers();
    try {
      const pending = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await pending;
    } finally {
      vi.useRealTimers();
    }
  };

  /** The terminal object handed back by the i-th createTerminal call. */
  const terminalAt = (i = 0) => window.createTerminal.mock.results[i].value;

  const BRACKET_ON = "\u001b[200~";
  const BRACKET_OFF = "\u001b[201~";

  describe("terminal surface", () => {
    beforeEach(() => {
      window.createTerminal.mockClear();
      setConfig({ agentSurface: "terminal" });
    });

    it("runs claude in a terminal named for the ticket and types the prompt unsubmitted", async () => {
      withWorkspaceFile();
      readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
      readFileSync.mockReturnValue(planJson());
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(window.createTerminal).toHaveBeenCalledTimes(1);
      expect(window.createTerminal.mock.calls[0][0]).toMatchObject({ name: "Claude · ASM-1" });
      const t = terminalAt();
      expect(t.show).toHaveBeenCalled();
      // First send runs the CLI (submitted); second types the prompt (NOT submitted).
      expect(t.sendText.mock.calls[0]).toEqual(["claude", true]);
      expect(t.sendText.mock.calls[1][1]).toBe(false);
      expect(t.sendText.mock.calls[1][0]).toContain("do it");
      // Never touches the extension panel.
      expect(commands.executeCommand).not.toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    });

    it("wraps the prompt in bracketed paste so a multi-line prompt is not submitted early", async () => {
      // renderPrompt appends "\n\nRelevant files: …" whenever a task has file
      // mentions, so this is the common case, not an edge case. Without the
      // markers the TUI would submit at the blank line and drop the file list.
      withWorkspaceFile();
      const prompt = "Start ASM-1\n\nRelevant files: @a.ts";
      readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
      readFileSync.mockReturnValue(
        planJson({ matches: [{ matchPath: "/ws/ASM-1.code-workspace", prompt }] }),
      );
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(terminalAt().sendText.mock.calls[1][0]).toBe(`${BRACKET_ON}${prompt}${BRACKET_OFF}`);
    });

    it("uses a folder matchPath as the terminal cwd", async () => {
      workspace.workspaceFile = undefined;
      workspace.workspaceFolders = [{ uri: { scheme: "file", fsPath: "/repos/api" } }];
      readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
      readFileSync.mockReturnValue(
        planJson({ matches: [{ matchPath: "/repos/api", prompt: "do it" }] }),
      );
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(window.createTerminal.mock.calls[0][0]).toMatchObject({ cwd: "/repos/api" });
    });

    it("omits cwd when the match is a .code-workspace file", async () => {
      // A workspace file is not a directory. Omitting cwd lets VS Code default to
      // the window's first root, which is the right answer for a multiroot window.
      withWorkspaceFile();
      readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
      readFileSync.mockReturnValue(planJson());
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(window.createTerminal.mock.calls[0][0].cwd).toBeUndefined();
    });

    it("falls back to the clipboard when creating the terminal throws", async () => {
      withWorkspaceFile();
      readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
      readFileSync.mockReturnValue(planJson());
      window.createTerminal.mockImplementationOnce(() => {
        throw new Error("no terminal for you");
      });
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(env.clipboard.writeText).toHaveBeenCalledWith("do it");
      expect(window.showInformationMessage).toHaveBeenCalled();
    });
  });
```

Then a test proving the default surface is untouched — put it **outside** the `terminal surface` describe so its `beforeEach` doesn't apply:

```ts
  it("uses the extension panel and no terminal when agentSurface is unset", async () => {
    setConfig({ agentSurface: undefined });
    window.createTerminal.mockClear();
    withWorkspaceFile();
    readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
    readFileSync.mockReturnValue(planJson());
    commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(commands.executeCommand).toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    expect(window.createTerminal).not.toHaveBeenCalled();
  });
```

Two things to confirm while writing these, and adjust to what the file actually does:
1. Whether `env.clipboard.writeText` is the mock's shape for the clipboard (check the existing clipboard-fallback test in this file).
2. Whether `workspace.workspaceFolders` entries use `{ uri: { fsPath } }` — copy the shape from the existing folder-identity test rather than guessing.
3. Add a `setConfig({ agentSurface: undefined })` to the file's top-level `beforeEach` so the terminal describe's value cannot leak into the ~40 existing seeding tests. Without this, tests that run after it will break.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/workspace.test.ts`
Expected: FAIL — `window.createTerminal is not a function` if Step 1 was skipped, otherwise "expected createTerminal to have been called 1 time, but got 0" because the fork doesn't exist.

- [ ] **Step 4: Add the constants and the bracketed-paste helper**

In `src/engine/workspace.ts`, near `SEED_STAGGER_MS` (line 21):

```ts
/** The CLI that terminal-surface seeding runs. Fixed on purpose — see the spec's
 * "Out of scope": a missing binary shows as `command not found` in the terminal,
 * which is self-explanatory and leaves the pre-typed prompt there to reuse. */
const CLI_CMD = "claude";
/** How long the CLI's TUI needs before it will accept typed input. Typing sooner
 * loses the prompt to a screen that isn't listening yet. Verified by hand in the
 * dev host — there is no event to await. */
const CLI_BOOT_MS = 1500;

/** Wrap text so the terminal delivers it as a *paste*. renderPrompt appends the
 * relevant-files block after a blank line, so most task prompts are multi-line,
 * and a bare newline sent to the CLI's TUI submits — the agent would start on a
 * truncated prompt. Pasted text keeps its newlines inline. Applied to every
 * prompt: harmless when single-line, and the only thing that saves a
 * user-customized multi-line template. */
const bracketedPaste = (text: string) => `\u001b[200~${text}\u001b[201~`;
```

Add the import at the top of the file:

```ts
import { readAgentSurface } from "../config";
```

(`src/config.ts` imports only `vscode`, `os`, `path` and `./types`, so this introduces no cycle.)

- [ ] **Step 5: Add `seedViaTerminal`**

In `src/engine/workspace.ts`, immediately above `seedClaudeCode`:

```ts
/** Start the session in an integrated terminal: run the CLI, wait for its TUI,
 * then type the prompt without submitting it. Returns false if the terminal
 * could not be driven, so the caller can fall back to the clipboard. */
async function seedViaTerminal(
  seedText: string,
  key: string,
  matchPath: string,
  log: (m: string) => void,
): Promise<boolean> {
  try {
    // matchPath is whatever windowIdentity() produced: a repo directory in
    // per-window mode, but the .code-workspace FILE in multiroot mode. A file is
    // not a valid cwd, and no single directory is "the" repo for a multiroot
    // window — omitting cwd lets VS Code default to the window's first root.
    const cwd = matchPath.endsWith(".code-workspace") ? undefined : matchPath;
    const terminal = vscode.window.createTerminal({ name: `Claude · ${key}`, cwd });
    terminal.show();
    terminal.sendText(CLI_CMD, true);
    await delay(CLI_BOOT_MS);
    terminal.sendText(bracketedPaste(seedText), false);
    log(`seed ${key}: typed the prompt into a terminal${cwd ? ` in ${cwd}` : ""}`);
    return true;
  } catch (e) {
    log(`seed ${key}: terminal seeding failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
```

- [ ] **Step 6: Reshape `seedClaudeCode`'s signature and add the fork**

Replace the signature at `src/engine/workspace.ts:643` (positional params become an options object — the terminal branch needs `matchPath`, which would be a sixth positional):

```ts
async function seedClaudeCode(opts: {
  prompt: string;
  key: string;
  matchPath: string;
  log: (m: string) => void;
  remoteControl?: boolean;
  multi?: boolean;
}): Promise<void> {
  const { prompt, key, matchPath, log, remoteControl = false, multi = false } = opts;
```

Keep the next three lines (`seedText`, the clipboard write, `announceRemoteControl`) exactly as they are. Then, immediately before the `// 1 — verified command` block, add the fork:

```ts
  // The surface is read here, in the target window, at seed time — never carried
  // in the plan file. Flipping the setting therefore also affects plans already
  // on disk, which is what a preference should do.
  if (readAgentSurface() === "terminal") {
    if (await seedViaTerminal(seedText, key, matchPath, log)) {
      announceRemoteControl();
      return;
    }
    // Terminal seeding failed — skip the extension attempts (this user does not
    // use the panel) and land on the clipboard fallback at the end.
  } else {
```

Wrap the existing step-1 (command polling) and step-2 (URI handler) blocks in that `else`, indenting them one level. Leave step 3 (the clipboard fallback) **outside** the branch so both surfaces reach it. Close the `else` before it.

Update the sole call site at `src/engine/workspace.ts:597`:

```ts
    await seedClaudeCode({
      prompt: match.prompt,
      key: plan.key,
      matchPath: match.matchPath,
      log,
      remoteControl: plan.remoteControl === true,
      multi,
    });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/workspace.test.ts`
Expected: PASS — the 6 new tests plus all pre-existing seeding tests. If pre-existing tests now fail, the likely cause is the `agentSurface` value leaking out of the terminal describe (Step 2, note 3).

- [ ] **Step 8: Run the full suite and the build**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/engine/workspace.ts test/_mocks/vscode.ts test/unit/engine/workspace.test.ts
git commit -m "feat(seed): open the session in a terminal when agentSurface is terminal

Forks inside seedClaudeCode, the one chokepoint every launch path funnels
through, so no call site changes. The prompt is wrapped in bracketed paste:
renderPrompt appends the relevant-files block after a blank line, and a bare
newline sent to the CLI's TUI would submit a truncated prompt.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Remote Control and batches in terminal mode

Proves the two behaviors that compose with the new surface rather than being part of it. Deliverable: Remote Control works identically in a terminal, and a batch of N tasks produces N named terminals.

**Files:**
- Test: `test/unit/engine/workspace.test.ts` (the `terminal surface` describe from Task 2)
- Modify: `src/engine/workspace.ts` — only if a test proves a defect.

**Interfaces:**
- Consumes: `seedClaudeCode` and `seedViaTerminal` as defined in Task 2; the `seedWithTimers`, `terminalAt`, `BRACKET_ON`/`BRACKET_OFF` helpers and `planJson` from that file.
- Produces: nothing new.

If Task 2 was implemented as written, these tests should pass without production changes — `announceRemoteControl` is already shared and `runSeedPass` already loops. Write them anyway: they are the regression fence for the two behaviors most likely to break later.

- [ ] **Step 1: Write the Remote Control test**

Inside the `terminal surface` describe:

```ts
    it("types /remote-control and leaves the prompt on the clipboard", async () => {
      // Same contract as the panel: the slash command cannot be stacked ahead of
      // a prompt in one submission, so the prompt travels by clipboard.
      withWorkspaceFile();
      readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
      readFileSync.mockReturnValue(planJson({ remoteControl: true }));
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(env.clipboard.writeText).toHaveBeenCalledWith("do it");
      expect(terminalAt().sendText.mock.calls[1][0]).toBe(
        `${BRACKET_ON}/remote-control ASM-1${BRACKET_OFF}`,
      );
      expect(terminalAt().sendText.mock.calls[1][1]).toBe(false);
      // The user is told what to press.
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("Remote Control"),
      );
    });
```

- [ ] **Step 2: Write the batch test**

```ts
    it("gives each task in a batch its own named terminal", async () => {
      withWorkspaceFile();
      readdirSync.mockReturnValue(["ASM-1-1.json", "ASM-2-1.json"] as never);
      readFileSync.mockImplementation((p) =>
        String(p).includes("ASM-1")
          ? planJson({ key: "ASM-1", seq: 0 })
          : planJson({ key: "ASM-2", seq: 1 }),
      );
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(window.createTerminal.mock.calls.map((c) => c[0].name)).toEqual([
        "Claude · ASM-1",
        "Claude · ASM-2",
      ]);
    });
```

`planJson`'s default `matches` pins `matchPath` to `/ws/ASM-1.code-workspace`, which is this window's identity — so both plans match, exactly as the existing multi-plan tests at lines 338 and 362 rely on.

- [ ] **Step 3: Run the tests**

Run: `npx vitest run test/unit/engine/workspace.test.ts`
Expected: PASS. If the Remote Control notification assertion fails, check the exact wording produced by `announceRemoteControl` and match against a substring that actually appears.

- [ ] **Step 4: If either test fails, fix the production code**

Do not weaken the assertion to make it pass. The two failures worth anticipating:
- Remote Control not announced → the `announceRemoteControl()` call is missing from the terminal branch in Task 2 Step 6.
- One terminal instead of two → the `readAgentSurface()` check landed outside the `runSeedPass` loop, or `seedViaTerminal` is reusing a terminal.

- [ ] **Step 5: Check coverage on the changed files**

Run: `npx vitest run --coverage`
Expected: ≥95% on `src/engine/workspace.ts`, `src/config.ts`, `src/telemetry/settingsSnapshot.ts`. If `seedViaTerminal`'s catch branch is uncovered, the Task 2 throw test isn't reaching it.

- [ ] **Step 6: Commit**

```bash
git add test/unit/engine/workspace.test.ts src/engine/workspace.ts
git commit -m "test(seed): cover Remote Control and batches on the terminal surface

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Verify in the dev host, tune the boot delay, document

The one value no test can settle. Deliverable: a hand-verified `CLI_BOOT_MS`, README prose, and a CHANGELOG entry.

**Files:**
- Modify: `src/engine/workspace.ts` (`CLI_BOOT_MS`, only if verification says so)
- Modify: `README.md` (prose near the `agentFlow.openIn` discussion, line ~340)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Launch the dev host**

Use VS Code's `code` CLI, **not** Cursor's — the Cursor CLI silently drops `--extensionDevelopmentPath`, so the extension never loads and you'd be testing the installed build instead.

```bash
code --extensionDevelopmentPath="$PWD" --new-window
```

- [ ] **Step 2: Set the surface and take a task**

In the dev host: set `agentFlow.agentSurface` to `terminal` in settings, open the Deck, and take a task that has file mentions (so the prompt is multi-line — that is the case bracketed paste exists for).

- [ ] **Step 3: Verify the four things that matter**

1. A terminal appears named `Claude · <KEY>`.
2. `claude` runs in it.
3. The full prompt is visible on the input line, **including** the `Relevant files:` block — if that block is missing, bracketed paste isn't working.
4. Nothing has been submitted. The agent is idle until you press Enter.

- [ ] **Step 4: Tune `CLI_BOOT_MS` if needed**

If the prompt is missing or truncated, the delay is too short: raise `CLI_BOOT_MS` in increments of 500ms and repeat Steps 2-3 until it lands reliably three times running. If 1500ms works first try, leave it and note that in the commit.

Record the value that worked and why in the constant's comment. Do not lower it below a value you verified — a fast machine is not evidence for a slow one.

- [ ] **Step 5: Verify the default surface still behaves**

Set `agentFlow.agentSurface` back to `extension` (or clear it), take another task, and confirm the Claude Code panel opens pre-filled exactly as before. This is the regression that matters most: every existing user is on this path.

- [ ] **Step 6: Add the README prose**

In `README.md`, near the `agentFlow.openIn` discussion (line ~340), add a short subsection. Keep the distinction between the two settings explicit — they are easy to confuse.

```markdown
### Where the session opens

Two settings, two different questions. `agentFlow.openIn` decides **which window** a
task lands in. `agentFlow.agentSurface` decides **what starts the session** once it's
there:

- `extension` (default) — the Claude Code extension panel, prompt pre-filled.
- `terminal` — an integrated terminal named `Claude · <KEY>` running the `claude`
  CLI, prompt pre-typed.

Either way you press Enter to start, and both work for every launch path: taking a
task, batch launches, Explore, Notepad, and **Address PR**. Terminal mode needs
`claude` on your `PATH`; if it isn't, the terminal says `command not found` and the
prompt is still sitting there to reuse.
```

- [ ] **Step 7: Add the CHANGELOG entry**

In `CHANGELOG.md`, under a new `## [Unreleased]` heading above `## [0.6.0]` (or into the existing Unreleased section if one is present by then):

```markdown
## [Unreleased]

### Added

- **`agentFlow.agentSurface` — open a session in the terminal.** Set it to
  `terminal` and a taken task starts the `claude` CLI in an integrated terminal
  named for the ticket, with the prompt pre-typed and waiting on your Enter,
  instead of the Claude Code extension panel. Applies to every launch path —
  take, batch, Explore, Notepad and **Address PR**. Defaults to `extension`, so
  nothing changes unless you ask for it.
```

- [ ] **Step 8: Run the full gate**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/engine/workspace.ts README.md CHANGELOG.md
git commit -m "docs: document agentFlow.agentSurface; pin the verified CLI boot delay

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 10: Release chores — only when merging to main**

Per this repo's convention, a merge to main bumps the version, builds a fresh `.vsix`, and removes the superseded one. This is a **minor** bump (a new backward-compatible setting): `0.6.0` → `0.7.0`. Do this as a separate `chore: release 0.7.0` commit at merge time, not as part of the feature work, and re-check `origin/main` first — this repo ships several releases a day from parallel sessions, so the base may have moved.

---

## Notes for the implementer

- **The whole feature is one fork in one function.** If you find yourself editing `deckView.ts`, `tasksView.ts`, `batchWorkspace.ts` or `review/launch.ts`, stop — every launch path already funnels through `seedClaudeCode`, and touching a call site means the fork landed in the wrong place.
- **`readAgentSurface()` is called at seed time, deliberately.** Don't optimize it into a value captured at activation or threaded through `PlanFile`; that turns a live preference into a stale snapshot.
- **Don't add an "ask each time" third value**, a configurable command, or a Doctor preflight. All three were considered and cut — see the spec's "Out of scope".
