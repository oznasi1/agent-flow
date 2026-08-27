# GitHub Copilot Agent Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a VS Code user have Agent Flow start a taken task in GitHub Copilot — either its chat panel or the `copilot` CLI — while Claude Code stays the default and nothing changes for a user who never opts in.

**Architecture:** The session destination becomes two axes. A new `agentFlow.agentProvider` (`claude-code` | `copilot`) joins the existing `agentFlow.agentSurface` (`extension` | `terminal`), and the 2×2 is resolved inside the single seeding chokepoint — `seedClaudeCode` in `src/engine/workspace.ts`, renamed `seedAgentSession`. No call site changes. Copilot is VS Code only, enforced at runtime by a `vscode.env.uriScheme` guard inside the config reader and cosmetically by a `when` clause that hides the setting in Cursor.

**Tech Stack:** TypeScript, VS Code extension API, React (webviews), Vitest with a mocked `vscode` module (`test/_mocks/vscode.ts`), esbuild.

**Spec:** [`docs/superpowers/specs/2026-08-09-copilot-agent-provider-design.md`](../specs/2026-08-09-copilot-agent-provider-design.md). Read it before Task 1.

## Global Constraints

- **Work in the worktree.** All work happens in `/Users/oznasi/dev/agent-flow/.claude/worktrees/copilot-agent-provider` on branch `worktree-copilot-agent-provider`. Never `cd` to `/Users/oznasi/dev/agent-flow` — parallel sessions switch that checkout's branch and commit onto it. Use absolute paths in Bash.
- **No regression is the hardest gate.** This ships to thousands of users. The existing test suite must pass **unmodified**. If a task appears to require editing an existing test, stop and surface it — that edit is a behavior change, not a chore.
- **Default stays inert.** `agentProvider` unset resolves to `claude-code` and must take byte-identical branches to today.
- **The mock host is Cursor.** `test/_mocks/vscode.ts` sets `env.uriScheme = "cursor"` and resets it to `"cursor"` between tests. Any test that wants Copilot behavior must set `env.uriScheme = "vscode"` itself and restore it.
- **Settings are read at seed time**, never captured at activation or carried in a plan file.
- **Exact setting keys:** `agentFlow.agentProvider`, values exactly `"claude-code"` and `"copilot"`. `agentFlow.agentSurface` keeps its key and its values `"extension"` / `"terminal"` — only its prose changes.
- **Gates, every task:** `npm run typecheck`, `npm test`. Before the final commit also `npm run test:cov` (thresholds enforced, ≥95% on changed files) and `npm run build` — `tsc` alone does not catch a Node-only import leaking into `src/webview/`.
- **Dev host launches with VS Code's own `code` CLI.** The Cursor CLI silently drops `--extensionDevelopmentPath`.

---

### Task 1: The `agentFlow.agentProvider` setting

Adds the setting, the host guard, the context key, and telemetry. Nothing consumes the value yet — that starts in Task 3. Deliverable: `getConfig().agentProvider` returns a host-validated value and the settings snapshot reports it.

**Files:**
- Modify: `package.json` (`contributes.configuration.properties`)
- Modify: `src/config.ts` (new `AgentProvider` type, `isVSCodeHost`, `readAgentProvider`, `AgentFlowConfig` field, `getConfig()` body)
- Modify: `src/extension.ts` (`activate` — set the context key)
- Modify: `src/telemetry/settingsSnapshot.ts` (`AGENT_PROVIDERS`, `agent_provider`)
- Modify: `src/telemetry/events.ts` (`SettingsSnapshot.agent_provider`)
- Test: `test/unit/config.test.ts`, `test/unit/telemetry/settingsSnapshot.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type AgentProvider = "claude-code" | "copilot"` from `src/config.ts`
  - `export function isVSCodeHost(): boolean` from `src/config.ts`
  - `export function readAgentProvider(c?: vscode.WorkspaceConfiguration): AgentProvider` from `src/config.ts` — Tasks 3–5 call it with no argument, at seed time.
  - `AgentFlowConfig.agentProvider: AgentProvider` — Tasks 6, 7 and 8 read it off `cfg`.
  - `export const AGENT_PROVIDERS` from `src/telemetry/settingsSnapshot.ts`

- [ ] **Step 1: Write the failing config tests**

Append to `test/unit/config.test.ts`. Note the `env` import — check the file's existing imports from `../_mocks/vscode` and extend that line rather than adding a second import statement.

```ts
describe("getConfig — agentProvider", () => {
  // The mock host is Cursor by default (see test/_mocks/vscode.ts). Every case
  // here states the host it means, and the afterEach puts the default back so a
  // stray "vscode" cannot leak into the ~hundreds of tests that follow.
  afterEach(() => {
    env.uriScheme = "cursor";
    setConfig({ agentProvider: undefined });
  });

  it("defaults to claude-code when unset", () => {
    env.uriScheme = "vscode";
    setConfig({ agentProvider: undefined });
    expect(getConfig().agentProvider).toBe("claude-code");
  });

  it("reads copilot in VS Code", () => {
    env.uriScheme = "vscode";
    setConfig({ agentProvider: "copilot" });
    expect(getConfig().agentProvider).toBe("copilot");
  });

  it("reads copilot in VS Code Insiders", () => {
    env.uriScheme = "vscode-insiders";
    setConfig({ agentProvider: "copilot" });
    expect(getConfig().agentProvider).toBe("copilot");
  });

  it("degrades copilot to claude-code in Cursor", () => {
    env.uriScheme = "cursor";
    setConfig({ agentProvider: "copilot" });
    expect(getConfig().agentProvider).toBe("claude-code");
  });

  it("degrades copilot to claude-code in Windsurf", () => {
    env.uriScheme = "windsurf";
    setConfig({ agentProvider: "copilot" });
    expect(getConfig().agentProvider).toBe("claude-code");
  });

  it("falls back to claude-code for an unrecognized value", () => {
    env.uriScheme = "vscode";
    setConfig({ agentProvider: "codex" });
    expect(getConfig().agentProvider).toBe("claude-code");
  });
});
```

**Mutation check before moving on.** These tests must be able to fail. Confirm the Cursor case is not passing for the trivial reason that `"copilot"` was never stored: temporarily change the Cursor case's expectation to `"copilot"` and verify it fails, then change it back. A test that passes against `readAgentProvider = () => "claude-code"` *and* against a correct implementation is asserting nothing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/unit/config.test.ts`
Expected: FAIL — `agentProvider` is not a property of the object `getConfig()` returns (`undefined`, plus a TS error on the property access).

- [ ] **Step 3: Add the type, the host guard, and the reader**

In `src/config.ts`, directly below the existing `readAgentSurface`:

```ts
/** Which agent Agent Flow starts a session with. */
export type AgentProvider = "claude-code" | "copilot";

/** The VS Code family, by uri scheme: `vscode`, `vscode-insiders`, and any other
 * `vscode*` build. Cursor is `cursor`, Windsurf is `windsurf`. Preferred over
 * `env.appName`, which is localized, and it is the signal the seeding path already
 * reads. */
export function isVSCodeHost(): boolean {
  return (vscode.env.uriScheme ?? "").startsWith("vscode");
}

/** Read the agent. Anything unrecognized — including undefined — means Claude Code,
 * so a typo in settings.json degrades rather than breaking seeding. `copilot`
 * additionally requires a VS Code host: settings sync carries values between
 * editors and Cursor has no Copilot, so the value degrades there instead of failing
 * at seed time. This runtime guard — not the manifest `when` clause — is what makes
 * the behavior correct. Called with no argument from the seeding path, which reads
 * at seed time rather than capturing at activation. */
export function readAgentProvider(
  c: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("agentFlow"),
): AgentProvider {
  return c.get<string>("agentProvider") === "copilot" && isVSCodeHost() ? "copilot" : "claude-code";
}
```

In the `AgentFlowConfig` interface, immediately above `agentSurface`:

```ts
  // Which agent a seeded session starts: Claude Code, or GitHub Copilot. `copilot`
  // is VS Code only and degrades to claude-code elsewhere — see readAgentProvider.
  agentProvider: AgentProvider;
```

In `getConfig()`, immediately above the `agentSurface:` line:

```ts
    agentProvider: readAgentProvider(c),
```

- [ ] **Step 4: Run the config tests to verify they pass**

Run: `npm test -- test/unit/config.test.ts`
Expected: PASS — the six new tests plus every pre-existing test in the file. A pre-existing failure here means `env.uriScheme` leaked; check the `afterEach`.

- [ ] **Step 5: Add the manifest entry**

In `package.json`, insert immediately **before** `"agentFlow.agentSurface"`:

```json
        "agentFlow.agentProvider": {
          "type": "string",
          "enum": [
            "claude-code",
            "copilot"
          ],
          "enumDescriptions": [
            "Claude Code",
            "GitHub Copilot — VS Code only"
          ],
          "default": "claude-code",
          "when": "agentFlow.host.vscode",
          "markdownDescription": "Which agent Agent Flow starts a session with. `copilot` works only in VS Code — in Cursor and other forks it falls back to Claude Code. Note that Copilot sessions do **not** appear as live agents on the Deck, which reads Claude Code's session files."
        },
```

Then reword `agentFlow.agentSurface` so it stops naming one agent. Change **only** these three fields; the key, `enum`, and `default` stay exactly as they are:

```json
          "enumDescriptions": [
            "The agent's chat panel",
            "The agent's CLI in an integrated terminal"
          ],
          "description": "Where Agent Flow starts a session: the agent's chat panel, or its CLI in an integrated terminal. Either way the prompt is pre-filled and you press Enter to start."
```

- [ ] **Step 6: Set the context key at activation**

In `src/extension.ts`, inside `activate`, after the `log("Agent Flow Deck activated")` line. Import `isVSCodeHost` from `./config`.

```ts
  // Gates the `when` clause on agentFlow.agentProvider so the Copilot choice does not
  // render in Cursor's settings UI. Cosmetic only — readAgentProvider enforces the
  // same rule at seed time. Wrapped because an uncaught throw here disposes every
  // registration that follows it.
  try {
    void vscode.commands.executeCommand("setContext", "agentFlow.host.vscode", isVSCodeHost());
  } catch (e) {
    log(`could not set the host context key: ${e instanceof Error ? e.message : String(e)}`);
  }
```

- [ ] **Step 7: Write the failing telemetry tests**

In `test/unit/telemetry/settingsSnapshot.test.ts`, beside the existing `agent_surface` assertions and the two `agentFlow.agentSurface` manifest-parity tests:

```ts
  it("reports agent_provider", () => {
    expect(settingsSnapshot({ ...getConfig(), agentProvider: "copilot" }).agent_provider).toBe("copilot");
  });

  it("collapses an unrecognized agentProvider to invalid", () => {
    expect(
      settingsSnapshot({ ...getConfig(), agentProvider: "codex" as never }).agent_provider,
    ).toBe("invalid");
  });

  it("keeps AGENT_PROVIDERS equal to agentFlow.agentProvider's manifest enum", () => {
    expect([...AGENT_PROVIDERS]).toEqual(props["agentFlow.agentProvider"].enum);
  });

  it("keeps agentFlow.agentProvider's enum and enumDescriptions the same length", () => {
    expect(props["agentFlow.agentProvider"].enumDescriptions?.length).toBe(
      props["agentFlow.agentProvider"].enum?.length,
    );
  });
```

Add `AGENT_PROVIDERS` to the file's existing import from `../../../src/telemetry/settingsSnapshot`.

- [ ] **Step 8: Run the telemetry tests to verify they fail**

Run: `npm test -- test/unit/telemetry/settingsSnapshot.test.ts`
Expected: FAIL — `AGENT_PROVIDERS` is not exported, and `agent_provider` is not on the snapshot.

- [ ] **Step 9: Add the telemetry field**

In `src/telemetry/settingsSnapshot.ts`, beside `AGENT_SURFACES`:

```ts
export const AGENT_PROVIDERS = ["claude-code", "copilot"] as const;
```

In `settingsSnapshot()`, immediately above the `agent_surface:` line:

```ts
    agent_provider: enumOrInvalid(cfg.agentProvider, AGENT_PROVIDERS),
```

In `src/telemetry/events.ts`, in `SettingsSnapshot`, immediately above `agent_surface`:

```ts
  agent_provider: "claude-code" | "copilot" | "invalid";
```

- [ ] **Step 10: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, with **no edits to any pre-existing test**. `agent_provider` is additive — nothing else in the snapshot moves.

- [ ] **Step 11: Commit**

```bash
git add package.json src/config.ts src/extension.ts src/telemetry/settingsSnapshot.ts src/telemetry/events.ts test/unit/config.test.ts test/unit/telemetry/settingsSnapshot.test.ts
git commit -m "feat(config): add agentFlow.agentProvider (claude-code | copilot)

VS Code only: readAgentProvider degrades a synced copilot value to
claude-code on any non-vscode uriScheme, and a when clause on the
agentFlow.host.vscode context key hides the row in Cursor's settings UI.
Nothing consumes the value yet.

Co-Authored-By: Claude Opus 5 (1M context) <noreply\@anthropic.com>"
```

---

### Task 2: Verify the Copilot surface in a dev host

Four facts this plan depends on are not derivable from the codebase. Establish them **before** writing the code that uses them, and commit the answers so Tasks 3–5 have concrete values instead of guesses. Deliverable: a committed note stating four verified values.

**Files:**
- Create: `docs/superpowers/notes/2026-08-09-copilot-verified-constants.md`

**Interfaces:**
- Consumes: Task 1's setting (so the dev host can be switched to Copilot).
- Produces: the four values Tasks 3, 4, 5 and 9 read from the note — the chat command's accepted argument shape, the `copilot` CLI boot delay, the chat-editor-tab command id, and whether the `when` clause hides the setting.

- [ ] **Step 1: Launch a dev host with the Copilot extension present**

```bash
cd /Users/oznasi/dev/agent-flow/.claude/worktrees/copilot-agent-provider
npm run build
code --extensionDevelopmentPath=. .
```

Use VS Code's own `code` CLI. If `code` is not on PATH, run *Shell Command: Install 'code' command in PATH* from VS Code's command palette first. GitHub Copilot Chat must be installed and signed in in that host.

- [ ] **Step 2: Enumerate the chat commands**

In the dev host, open the Debug Console for the extension host and run, from a scratch extension command or the debug console REPL:

```js
await vscode.commands.getCommands(true).then(c => c.filter(x => x.startsWith("workbench.action.chat")).sort())
```

Record the full list. The two ids that matter are the panel opener (expected `workbench.action.chat.open`) and whichever id opens chat **in an editor tab**.

- [ ] **Step 3: Confirm the panel command's argument shape**

In the same console:

```js
await vscode.commands.executeCommand("workbench.action.chat.open", { query: "hello from agent flow", isPartialQuery: true, mode: "agent" })
```

Confirm all three: the chat panel opens, the text sits in the input **unsubmitted**, and the mode selector reads *Agent*. If `mode` is rejected or ignored, record what the command actually accepts — Task 4 uses whatever this step establishes, not what the plan guessed.

- [ ] **Step 4: Confirm the editor-tab command takes a query**

Run the editor-tab id from Step 2 with the same argument object. Confirm it opens a chat **editor tab** with the query prefilled, and that running it twice yields **two** tabs rather than reusing one. If it will not take a prefilled query, record that — Task 5 then implements the brief-notification fallback only, and that is a legitimate outcome, not a failure.

- [ ] **Step 5: Measure the `copilot` CLI boot time**

In an integrated terminal:

```bash
time copilot
```

Start typing immediately and note how long it takes before keystrokes land in the TUI. Round **up** generously and record the value — too short loses the prompt to a screen that is not listening yet, and the cost of too long is only a pause. For reference, `claude` is pinned at 1500 ms.

- [ ] **Step 6: Check whether the `when` clause hides the setting**

In the dev host, open Settings and search `agentFlow.agentProvider` — it should be visible. Then set the `agentFlow.host.vscode` context key to false (temporarily hardcode `false` in the Task 1 `setContext` call, rebuild, relaunch) and confirm the row disappears. Record yes or no. **If no**, that is fine and nothing else in the plan changes: the runtime guard already makes the behavior correct, and Task 9 adds the VS Code-only note to the description instead.

- [ ] **Step 7: Write the note**

Create `docs/superpowers/notes/2026-08-09-copilot-verified-constants.md` with the observed values — VS Code version, Copilot Chat version, `copilot` CLI version, the two command ids with their accepted argument shapes, the measured boot delay, and the `when`-clause verdict. State what was observed, not what was expected.

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/notes/2026-08-09-copilot-verified-constants.md
git commit -m "docs: record the verified Copilot command and CLI constants

Co-Authored-By: Claude Opus 5 (1M context) <noreply\@anthropic.com>"
```

---

### Task 3: Provider-aware dispatch and the terminal axis

Renames the seeding chokepoint, parameterizes the terminal path by provider, and routes the four cells. Copilot + `extension` deliberately falls through to the existing clipboard fallback in this task; Task 4 fills it in. Deliverable: with `agentProvider: "copilot"` and `agentSurface: "terminal"`, a taken task opens a `Copilot · KEY` terminal running `copilot` with the prompt pre-typed and unsubmitted.

**Files:**
- Modify: `src/engine/workspace.ts:24-31` (CLI constants), `:654` (call site), `:703-726` (`seedViaTerminal`), `:735-815` (`seedClaudeCode` → `seedAgentSession`)
- Test: `test/unit/engine/workspace.test.ts`

**Interfaces:**
- Consumes: `readAgentProvider()` and `AgentProvider` from `src/config.ts` (Task 1); the boot delay from Task 2's note.
- Produces: `seedAgentSession(opts)` — same options object `seedClaudeCode` took today (`{ prompt, key, matchPath, log, remoteControl?, multi? }`), same `Promise<void>` return. Task 4 adds a branch inside it; Task 6 adds a guard at its top.

- [ ] **Step 1: Write the failing terminal tests**

In `test/unit/engine/workspace.test.ts`, add a new `describe` alongside the existing terminal-surface one. Reuse the file's existing helpers (`terminalAt`, `setConfig`, and whatever drives `maybeSeedAgent`) — copy the shape of the existing `agentSurface: "terminal"` describe rather than inventing a new harness.

```ts
describe("seedAgentSession — copilot terminal", () => {
  beforeEach(() => {
    env.uriScheme = "vscode";
    setConfig({ agentProvider: "copilot", agentSurface: "terminal" });
    window.createTerminal.mockClear();
  });

  afterEach(() => {
    env.uriScheme = "cursor";
    setConfig({ agentProvider: undefined, agentSurface: undefined });
  });

  it("names the terminal for Copilot and runs the copilot CLI", async () => {
    await seedOneTask("PROJ-1"); // the file's existing helper for driving a single seed
    expect(window.createTerminal).toHaveBeenCalledTimes(1);
    expect(window.createTerminal.mock.calls[0][0]).toMatchObject({ name: "Copilot · PROJ-1" });
    expect(terminalAt(0).sendText).toHaveBeenNthCalledWith(1, "copilot", true);
  });

  it("still pre-types the prompt without submitting it", async () => {
    await seedOneTask("PROJ-1");
    const [text, addNewLine] = terminalAt(0).sendText.mock.calls[1];
    expect(addNewLine).toBe(false);
    expect(text).toContain("[200~");
  });

  it("uses Claude's terminal name and CLI when the provider is unset", async () => {
    setConfig({ agentProvider: undefined });
    await seedOneTask("PROJ-1");
    expect(window.createTerminal.mock.calls[0][0]).toMatchObject({ name: "Claude · PROJ-1" });
    expect(terminalAt(0).sendText).toHaveBeenNthCalledWith(1, "claude", true);
  });
});
```

That third test is the regression guard: it asserts the default path still produces exactly what the pre-existing tests at `workspace.test.ts:594` and `:687-688` assert.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/unit/engine/workspace.test.ts`
Expected: FAIL on the first two — the terminal is named `Claude · PROJ-1` and runs `claude`, because nothing reads the provider yet. The third should already PASS; if it fails, the harness in Step 1 is wrong, not the implementation.

- [ ] **Step 3: Replace the CLI constants with a per-provider table**

In `src/engine/workspace.ts`, replace lines 24–31 (`CLI_CMD` and `CLI_BOOT_MS` with their comments) with:

```ts
/** The CLI each provider's terminal surface runs, and how long its TUI needs before
 * it will accept typed input. Fixed commands on purpose — see the spec's "Out of
 * scope": a missing binary shows as `command not found` in the terminal, which is
 * self-explanatory and leaves the pre-typed prompt there to reuse. Typing sooner
 * than `bootMs` loses the prompt to a screen that isn't listening yet, and there is
 * no event to await, so both delays are verified by hand in the dev host — see
 * docs/superpowers/notes/2026-08-09-copilot-verified-constants.md. */
const CLI: Record<AgentProvider, { cmd: string; label: string; bootMs: number }> = {
  "claude-code": { cmd: "claude", label: "Claude", bootMs: 1500 },
  copilot: { cmd: "copilot", label: "Copilot", bootMs: /* Task 2, Step 5 */ 2000 },
};
```

Replace the `2000` with the value Task 2 measured. Update the import on line 14:

```ts
import { readAgentProvider, readAgentSurface, type AgentProvider } from "../config";
```

- [ ] **Step 4: Parameterize `seedViaTerminal`**

Change its signature and the three lines that use the constants. **Leave the log message exactly as it is** — the terminal name is the observable that tests assert, and changing the log text risks a pre-existing assertion for no gain.

```ts
async function seedViaTerminal(
  provider: AgentProvider,
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
    const { cmd, label, bootMs } = CLI[provider];
    const terminal = vscode.window.createTerminal({ name: `${label} · ${key}`, cwd });
    terminal.show();
    terminal.sendText(cmd, true);
    await delay(bootMs);
    terminal.sendText(bracketedPaste(seedText), false);
    log(`seed ${key}: typed the prompt into a terminal${cwd ? ` in ${cwd}` : ""}`);
    return true;
  } catch (e) {
    log(`seed ${key}: terminal seeding failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
```

- [ ] **Step 5: Rename the chokepoint and route the four cells**

Rename `seedClaudeCode` to `seedAgentSession` at its declaration (`:735`) and its one call site (`:654`). Then replace the surface fork so it reads the provider too:

```ts
  // Both settings are read here, in the target window, at seed time — never carried
  // in the plan file. Flipping either therefore also affects plans already on disk,
  // which is what a preference should do.
  const provider = readAgentProvider();

  if (readAgentSurface() === "terminal") {
    if (await seedViaTerminal(provider, seedText, key, matchPath, log)) {
      announceRemoteControl();
      return;
    }
    // Terminal seeding failed — skip the panel attempts (this user does not use the
    // panel) and land on the clipboard fallback at the end.
  } else if (provider === "claude-code") {
    // ...the existing Claude Code panel block, unchanged: the 7-attempt command
    // poll, then the URI handler.
  } else {
    // Copilot + panel is filled in by the next task; until then this falls through
    // to the clipboard fallback rather than opening the wrong agent's panel.
    log(`seed ${key}: copilot panel seeding is not wired up yet — using the clipboard`);
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- test/unit/engine/workspace.test.ts`
Expected: PASS — the three new tests plus **all ~40 pre-existing seeding tests, unmodified**. If a pre-existing one fails, the likely causes are the terminal name template, the log message, or `env.uriScheme` leaking out of the new describe.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/engine/workspace.ts test/unit/engine/workspace.test.ts
git commit -m "feat(seed): resolve the agent provider at seed time

Renames seedClaudeCode to seedAgentSession and parameterizes the terminal
path by provider, so agentProvider: copilot + agentSurface: terminal runs
the copilot CLI in a Copilot-named terminal. Claude Code's terminal name,
CLI and boot delay are unchanged. Copilot + panel still falls through to
the clipboard fallback.

Co-Authored-By: Claude Opus 5 (1M context) <noreply\@anthropic.com>"
```

---

### Task 4: The Copilot chat panel

Fills in the fourth cell. Deliverable: with `agentProvider: "copilot"` and the default surface, a taken task opens Copilot Chat in agent mode with the prompt prefilled and unsubmitted.

**Files:**
- Modify: `src/engine/workspace.ts` (new `CHAT_OPEN_CMD` constant and `seedCopilotPanel`, wired into `seedAgentSession`'s `else` branch)
- Test: `test/unit/engine/workspace.test.ts`

**Interfaces:**
- Consumes: Task 2's verified command id and argument shape; Task 3's `seedAgentSession` dispatch.
- Produces: `seedCopilotPanel(seedText, key, log): Promise<boolean>` — private to `workspace.ts`; Task 5 calls it as the batch fallback.

- [ ] **Step 1: Write the failing panel tests**

```ts
describe("seedAgentSession — copilot panel", () => {
  beforeEach(() => {
    env.uriScheme = "vscode";
    setConfig({ agentProvider: "copilot", agentSurface: undefined });
    commands.getCommands.mockResolvedValue(["workbench.action.chat.open"]);
  });

  afterEach(() => {
    env.uriScheme = "cursor";
    setConfig({ agentProvider: undefined });
  });

  it("opens chat with the prompt prefilled and unsubmitted", async () => {
    await seedOneTask("PROJ-1");
    expect(commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.chat.open",
      expect.objectContaining({ isPartialQuery: true, mode: "agent" }),
    );
    const arg = commands.executeCommand.mock.calls.find(
      (c) => c[0] === "workbench.action.chat.open",
    )?.[1] as { query: string };
    expect(arg.query).toContain("PROJ-1");
  });

  it("never calls Claude Code's open command", async () => {
    await seedOneTask("PROJ-1");
    expect(commands.executeCommand).not.toHaveBeenCalledWith(
      "claude-vscode.primaryEditor.open",
      expect.anything(),
      expect.anything(),
    );
  });

  it("falls back to the clipboard when no chat command is registered", async () => {
    commands.getCommands.mockResolvedValue([]);
    await seedOneTask("PROJ-1");
    expect(env.clipboard.writeText).toHaveBeenCalled();
    expect(window.showInformationMessage).toHaveBeenCalled();
  });

  it("does not try the Claude Code URI handler", async () => {
    commands.getCommands.mockResolvedValue([]);
    await seedOneTask("PROJ-1");
    expect(env.openExternal).not.toHaveBeenCalled();
  });
});
```

The fallback tests poll seven times with a 700 ms delay between attempts. Check how the existing fallback-chain describe at `workspace.test.ts:509` handles that — reuse its fake-timer or delay strategy rather than letting the suite wait ~5 s per test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/unit/engine/workspace.test.ts`
Expected: FAIL on the first two — `executeCommand` is never called with the chat id, because Task 3 left this branch logging and falling through. The last two should already PASS (that fallthrough *is* the clipboard fallback); they exist to lock the behavior in once the branch is implemented.

- [ ] **Step 3: Add the command constant and the seeding function**

Beside `CLAUDE_NEW_TAB_CMD` in `src/engine/workspace.ts`:

```ts
// VS Code's built-in chat command, which GitHub Copilot Chat serves.
// `isPartialQuery: true` fills the input without submitting, so Copilot honors the
// same "we pre-fill, you press Enter" contract as the Claude Code panel.
// Verified in the dev host — see docs/superpowers/notes/2026-08-09-copilot-verified-constants.md.
const CHAT_OPEN_CMD = "workbench.action.chat.open";
```

Below `seedViaTerminal`:

```ts
/** Open Copilot Chat with the prompt pre-filled and unsubmitted. Polls for the
 * command the same way the Claude Code path does: Agent Flow and the chat extension
 * both activate on `onStartupFinished`, so the same activation race applies.
 *
 * There is no URI-handler rung here — Copilot publishes no documented
 * open-with-prompt URI — so a false return means the caller should fall back to the
 * clipboard. */
async function seedCopilotPanel(
  seedText: string,
  key: string,
  log: (m: string) => void,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 7; attempt++) {
    try {
      const cmds = await vscode.commands.getCommands(true);
      if (cmds.includes(CHAT_OPEN_CMD)) {
        await vscode.commands.executeCommand(CHAT_OPEN_CMD, {
          query: seedText,
          isPartialQuery: true,
          mode: "agent",
        });
        log(`seed ${key}: opened Copilot Chat via ${CHAT_OPEN_CMD} (attempt ${attempt})`);
        return true;
      }
    } catch (e) {
      log(`seed ${key}: copilot command attempt ${attempt} threw: ${e}`);
    }
    await delay(700);
  }
  log(`seed ${key}: no chat command registered — falling back to the clipboard`);
  return false;
}
```

- [ ] **Step 4: Wire it into the dispatch**

Replace Task 3's placeholder `else` branch in `seedAgentSession`:

```ts
  } else if (await seedCopilotPanel(seedText, key, log)) {
    announceRemoteControl();
    return;
  }
```

Keep it as an `else if` on the same chain, so a `false` return continues to the clipboard fallback below.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- test/unit/engine/workspace.test.ts`
Expected: PASS — the four new tests plus every pre-existing seeding test, unmodified.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/engine/workspace.ts test/unit/engine/workspace.test.ts
git commit -m "feat(seed): open Copilot Chat with the prompt prefilled

isPartialQuery keeps the pre-fill-then-Enter contract. No URI rung —
Copilot has no documented open-with-prompt URI — so an unregistered chat
command falls straight through to the clipboard.

Co-Authored-By: Claude Opus 5 (1M context) <noreply\@anthropic.com>"
```

---

### Task 5: Batch — one chat editor tab per task

Copilot's chat panel is single-instance, so a batch seeding N prompts into it would overwrite each one with the next. Deliverable: a batch under Copilot opens one chat editor tab per task, or — if Task 2 found no editor command that accepts a query — degrades to the existing brief notification without ever overwriting a panel.

**Files:**
- Modify: `src/engine/workspace.ts` (`seedCopilotPanel` gains a `multi` parameter)
- Test: `test/unit/engine/workspace.test.ts`

**Interfaces:**
- Consumes: Task 2's editor-tab command id and its verdict on whether it accepts a query; Task 4's `seedCopilotPanel`.
- Produces: `seedCopilotPanel(seedText, key, log, multi)` — the `multi` flag mirrors the one `seedAgentSession` already threads to the Claude Code path.

**If Task 2 found no editor command that takes a prefilled query:** skip Steps 3–4. Implement only the guard — under `multi`, `seedCopilotPanel` returns `false` immediately with a log line, so `seedAgentSession`'s existing `multi` fallback shows the "briefs are in `.agentflow/`" notification. Write the Step 1 tests for that behavior instead, and say so in the commit message. This is a legitimate outcome, not a shortfall.

- [ ] **Step 1: Write the failing batch tests**

```ts
describe("seedAgentSession — copilot batch", () => {
  beforeEach(() => {
    env.uriScheme = "vscode";
    setConfig({ agentProvider: "copilot", agentSurface: undefined });
    commands.getCommands.mockResolvedValue([
      "workbench.action.chat.open",
      COPILOT_EDITOR_CMD, // the id Task 2 recorded
    ]);
  });

  afterEach(() => {
    env.uriScheme = "cursor";
    setConfig({ agentProvider: undefined });
  });

  it("opens one editor tab per task", async () => {
    await seedTwoTasks("PROJ-1", "PROJ-2"); // the file's existing batch helper
    const tabCalls = commands.executeCommand.mock.calls.filter((c) => c[0] === COPILOT_EDITOR_CMD);
    expect(tabCalls).toHaveLength(2);
    expect((tabCalls[0][1] as { query: string }).query).toContain("PROJ-1");
    expect((tabCalls[1][1] as { query: string }).query).toContain("PROJ-2");
  });

  it("never reuses the single-instance panel for a batch", async () => {
    await seedTwoTasks("PROJ-1", "PROJ-2");
    expect(commands.executeCommand).not.toHaveBeenCalledWith(
      "workbench.action.chat.open",
      expect.anything(),
    );
  });

  it("points at the briefs when the editor command is absent", async () => {
    commands.getCommands.mockResolvedValue([]);
    await seedTwoTasks("PROJ-1", "PROJ-2");
    expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining(BRIEF_DIR));
    expect(env.clipboard.writeText).not.toHaveBeenCalled();
  });
});
```

That last assertion matters: the existing `multi` fallback deliberately withholds the clipboard, because one clipboard cannot carry N prompts.

`COPILOT_EDITOR_CMD` is defined in `src/engine/workspace.ts` in Step 3 and is not exported today. Either export it for the test or write the literal id in both places — do **not** export it just for tests if the file's other command constants are private; match whatever `CLAUDE_NEW_TAB_CMD` does.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/unit/engine/workspace.test.ts`
Expected: FAIL — a batch currently calls the panel command twice, so the first two fail. The third should already PASS.

- [ ] **Step 3: Give `seedCopilotPanel` a `multi` parameter**

Mirror the Claude Code path's `preferred` list, which prefers the tab command when `multi` and falls back to the panel:

```ts
// Copilot's "open chat in an editor tab" — the batch equivalent of Claude Code's
// editor.open. The chat panel is single-instance, so without this a batch of N
// tasks would overwrite one input N times.
// Verified in the dev host — see docs/superpowers/notes/2026-08-09-copilot-verified-constants.md.
const COPILOT_EDITOR_CMD = "<the id Task 2 recorded>";
```

```ts
async function seedCopilotPanel(
  seedText: string,
  key: string,
  log: (m: string) => void,
  multi = false,
): Promise<boolean> {
  const preferred = multi ? [COPILOT_EDITOR_CMD] : [CHAT_OPEN_CMD];
  for (let attempt = 1; attempt <= 7; attempt++) {
    try {
      const cmds = await vscode.commands.getCommands(true);
      const cmd = preferred.find((c) => cmds.includes(c));
      if (cmd) {
        await vscode.commands.executeCommand(cmd, {
          query: seedText,
          isPartialQuery: true,
          mode: "agent",
        });
        log(`seed ${key}: opened Copilot Chat via ${cmd} (attempt ${attempt})`);
        return true;
      }
    } catch (e) {
      log(`seed ${key}: copilot command attempt ${attempt} threw: ${e}`);
    }
    await delay(700);
  }
  log(`seed ${key}: no ${multi ? "chat editor" : "chat"} command registered — falling back`);
  return false;
}
```

`preferred` for `multi` holds **only** the editor command, deliberately: falling back to the panel here is the exact overwriting bug this task exists to prevent. A batch with no editor command must reach the brief notification instead.

- [ ] **Step 4: Pass `multi` through**

In `seedAgentSession`, change the Task 4 call to `await seedCopilotPanel(seedText, key, log, multi)`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- test/unit/engine/workspace.test.ts`
Expected: PASS — the three new tests plus every pre-existing seeding test.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/engine/workspace.ts test/unit/engine/workspace.test.ts
git commit -m "feat(seed): give each batched task its own Copilot chat tab

The chat panel is single-instance, so a batch must use the editor-tab
command or reach the brief notification — never overwrite one input N
times.

Co-Authored-By: Claude Opus 5 (1M context) <noreply\@anthropic.com>"
```

---

### Task 6: Block Remote Control × Copilot

Remote Control seeds `/remote-control <key>`, a Claude Code slash command Copilot has no equivalent for. **This is the highest-regression-risk task in the plan** — it adds a new failure path to a flow every Remote Control user runs today. Deliverable: the combination is refused before a workspace opens, and Claude Code + Remote Control is provably untouched.

**Files:**
- Modify: `src/tasksView.ts:1279` (`resolveRemoteControl`) and its three call sites at `:918`, `:1445`, `:1617`
- Modify: `src/engine/workspace.ts` (`seedAgentSession` backstop)
- Test: `test/unit/tasksView.test.ts`, `test/unit/engine/workspace.test.ts`

**Interfaces:**
- Consumes: `AgentFlowConfig.agentProvider` (Task 1); `seedAgentSession` (Task 3).
- Produces: `resolveRemoteControl(cfg): Promise<boolean | null>` — `null` means the launch must not proceed. The type change is deliberate: it makes `tsc` point at all three call sites.

- [ ] **Step 1: Write the failing tests**

In `test/unit/tasksView.test.ts`, following the file's existing take-a-task harness:

```ts
describe("Remote Control x Copilot", () => {
  afterEach(() => {
    env.uriScheme = "cursor";
    setConfig({ agentProvider: undefined, remoteControl: undefined });
  });

  it("refuses the launch and opens nothing", async () => {
    env.uriScheme = "vscode";
    setConfig({ agentProvider: "copilot", remoteControl: "on", seedAgent: true });
    await takeTask("PROJ-1");
    expect(window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Remote Control needs Claude Code"),
    );
    expect(commands.executeCommand).not.toHaveBeenCalledWith(
      "vscode.openFolder",
      expect.anything(),
      expect.anything(),
    );
  });

  it("leaves Claude Code + Remote Control alone", async () => {
    setConfig({ agentProvider: undefined, remoteControl: "on", seedAgent: true });
    await takeTask("PROJ-1");
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });

  it("does not fire when Remote Control is off", async () => {
    env.uriScheme = "vscode";
    setConfig({ agentProvider: "copilot", remoteControl: "off", seedAgent: true });
    await takeTask("PROJ-1");
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });
});
```

The second and third tests are the regression guards. Confirm the exact toast mechanism first — `this.toast("error", …)` may route to `showErrorMessage` or to a webview post; assert against whichever the file's existing error tests use.

Add the seed-time backstop test to `test/unit/engine/workspace.test.ts`:

```ts
it("refuses to seed remote control into Copilot", async () => {
  env.uriScheme = "vscode";
  setConfig({ agentProvider: "copilot" });
  await seedOneTask("PROJ-1", { remoteControl: true });
  expect(commands.executeCommand).not.toHaveBeenCalledWith(
    "workbench.action.chat.open",
    expect.anything(),
  );
  expect(window.createTerminal).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/unit/tasksView.test.ts test/unit/engine/workspace.test.ts`
Expected: FAIL on the first test and the backstop test — no error is shown and the launch proceeds. The two regression guards must **already pass**; if either fails now, the harness is wrong and fixing it is a prerequisite, not part of this task.

- [ ] **Step 3: Add the pre-flight block**

In `src/tasksView.ts`, rename the existing `resolveRemoteControl` body to `resolveRemoteControlSetting` (private, unchanged) and add:

```ts
  /** Remote Control seeds `/remote-control <key>`, a Claude Code slash command Copilot
   * has no equivalent for. Refuse the combination rather than silently dropping one of
   * the two things the user turned on — and refuse it here, before a destination is
   * chosen, so the user is not left with an opened window and nothing in it.
   * Returns null when the launch must not proceed. */
  private async resolveRemoteControl(cfg: AgentFlowConfig): Promise<boolean | null> {
    const on = await this.resolveRemoteControlSetting(cfg);
    if (on && cfg.agentProvider === "copilot") {
      this.toast(
        "error",
        "Remote Control needs Claude Code. Set agentFlow.agentProvider to claude-code, or turn agentFlow.remoteControl off.",
      );
      return null;
    }
    return on;
  }
```

`cfg.agentProvider` is already host-guarded by `readAgentProvider`, so this can never fire in Cursor.

- [ ] **Step 4: Handle `null` at all three call sites**

`tsc` will point at `:918`, `:1445` and `:1617`. At the first two:

```ts
    const wantRemoteControl = await this.resolveRemoteControl(cfg);
    if (wantRemoteControl === null) return;
```

At `:1617`, keep the batch short-circuit and add the same guard:

```ts
    const wantRemoteControl = isBatch || shared ? false : await this.resolveRemoteControl(cfg);
    if (wantRemoteControl === null) return;
```

- [ ] **Step 5: Add the seed-time backstop**

At the top of `seedAgentSession` in `src/engine/workspace.ts`, before the clipboard write:

```ts
  // A plan file can outlive a settings flip, so the pre-flight block in tasksView is
  // not sufficient on its own. Refuse rather than silently seeding a slash command
  // Copilot will treat as literal text.
  if (remoteControl && readAgentProvider() === "copilot") {
    log(`seed ${key}: refused — Remote Control needs Claude Code`);
    vscode.window.showErrorMessage(
      `Agent Flow Deck: ${key} not seeded — Remote Control needs Claude Code. Set agentFlow.agentProvider to claude-code, or turn agentFlow.remoteControl off.`,
    );
    return;
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — the whole suite, with no pre-existing test edited. Pay attention to any pre-existing Remote Control test: it must pass untouched.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/tasksView.ts src/engine/workspace.ts test/unit/tasksView.test.ts test/unit/engine/workspace.test.ts
git commit -m "feat(launch): refuse Remote Control with the Copilot provider

/remote-control is a Claude Code slash command. Blocked pre-flight so no
window opens on a launch that cannot be seeded, with a seed-time backstop
for plan files that outlive a settings flip.

Co-Authored-By: Claude Opus 5 (1M context) <noreply\@anthropic.com>"
```

---

### Task 7: Provider-aware Doctor

Deliverable: under `agentProvider: "copilot"` Doctor reports on Copilot Chat's availability instead of Claude Code's extension and version floor; under the default it reports exactly what it reports today.

**Files:**
- Modify: `src/engine/doctor.ts` (`DoctorGroup`, `DoctorInputs`, `claudeChecks` → `agentChecks` + `copilotChecks`)
- Modify: `src/doctorView.ts` (`DoctorConfig`, `DoctorDeps`, `collectInputs`, new `probeCopilotChat`, and the `DoctorDeps` literal that wires the probes)
- Test: `test/unit/engine/doctor.test.ts`, `test/unit/doctorView.test.ts`, `test/unit/doctorView.deps.test.ts`

**Interfaces:**
- Consumes: `AgentFlowConfig.agentProvider` (Task 1).
- Produces: `DoctorInputs.agentProvider` and `DoctorInputs.copilotChat: { available: boolean }`; `probeCopilotChat(): Promise<{ available: boolean }>` from `src/doctorView.ts`.

- [ ] **Step 1: Write the failing doctor tests**

`test/unit/engine/doctor.test.ts` drives `runChecks` from a plain inputs literal — extend that literal rather than building a new one.

```ts
describe("agent checks by provider", () => {
  it("reports Copilot Chat availability under the copilot provider", () => {
    const checks = runChecks(inputs({ agentProvider: "copilot", copilotChat: { available: true } }));
    expect(checks.find((c) => c.label === "Copilot Chat available")?.status).toBe("ok");
    expect(checks.find((c) => c.label === "Claude Code installed")).toBeUndefined();
    expect(checks.find((c) => c.label === "Claude Code version")).toBeUndefined();
  });

  it("offers the Copilot Chat extension when it isn't available", () => {
    const checks = runChecks(inputs({ agentProvider: "copilot", copilotChat: { available: false } }));
    const row = checks.find((c) => c.label === "Copilot Chat available");
    expect(row?.status).toBe("fail");
    expect(row?.action).toEqual({ kind: "extension", id: "github.copilot-chat", label: "Show extension" });
  });

  it("keeps the Claude Code rows under the default provider", () => {
    const checks = runChecks(inputs({ agentProvider: "claude-code" }));
    expect(checks.find((c) => c.label === "Claude Code installed")).toBeDefined();
    expect(checks.find((c) => c.label === "Copilot Chat available")).toBeUndefined();
  });

  it("keeps the Claude session-files row under either provider", () => {
    // The Deck's live signal reads ~/.claude/projects no matter which agent seeds
    // sessions, so this row is not provider-dependent.
    for (const agentProvider of ["claude-code", "copilot"] as const) {
      expect(runChecks(inputs({ agentProvider })).find((c) => c.label === "Claude session files")).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/unit/engine/doctor.test.ts`
Expected: FAIL — `agentProvider` and `copilotChat` are not on `DoctorInputs` (TS errors), and no Copilot row exists.

- [ ] **Step 3: Extend the pure module**

In `src/engine/doctor.ts`:

```ts
export type DoctorGroup = "source" | "Local" | "GitHub" | "Claude Code" | "Copilot" | "State";
```

In `DoctorInputs`, beside `claudeCode`:

```ts
  /** Which agent seeds sessions — decides whether the Claude Code rows or the
   *  Copilot row appear. Already host-guarded by readAgentProvider, so this is
   *  never "copilot" in Cursor. */
  agentProvider: "claude-code" | "copilot";
  /** Probed by command registration, not extension id: chat is built into VS Code
   *  and Copilot ships bundled in some builds, so an id check would false-negative. */
  copilotChat: { available: boolean };
```

Change the `runChecks` composition from `...claudeChecks(i)` to `...agentChecks(i)`, and add:

```ts
function agentChecks(i: DoctorInputs): Check[] {
  return i.agentProvider === "copilot"
    ? [...copilotChecks(i), ...claudeSessionChecks(i)]
    : claudeChecks(i);
}

function copilotChecks(i: DoctorInputs): Check[] {
  return [
    {
      group: "Copilot",
      label: "Copilot Chat available",
      status: i.copilotChat.available ? "ok" : "fail",
      detail: i.copilotChat.available
        ? "workbench.action.chat.open is registered"
        : "no chat command is registered — GitHub Copilot Chat isn't available in this window",
      ...(i.copilotChat.available
        ? {}
        : { action: { kind: "extension", id: "github.copilot-chat", label: "Show extension" } }),
    },
  ];
}
```

Extract the existing "Claude session files" push at the end of `claudeChecks` into `claudeSessionChecks(i): Check[]`, and have `claudeChecks` end with `...claudeSessionChecks(i)` so its output is byte-identical to today's. That row stays under either provider — the Deck's live signal reads `~/.claude/projects` regardless of which agent seeds sessions.

- [ ] **Step 4: Run the doctor tests to verify they pass**

Run: `npm test -- test/unit/engine/doctor.test.ts`
Expected: PASS, including every pre-existing check-ordering and formatting test.

- [ ] **Step 5: Wire the probe**

In `src/doctorView.ts`, add to `DoctorConfig`:

```ts
  agentProvider: "claude-code" | "copilot";
```

to `DoctorDeps`:

```ts
  copilotChat: () => Promise<{ available: boolean }>;
```

the probe itself, beside `probeClaudeExtension`:

```ts
/** Whether this window can open a chat panel at all. Command registration rather
 *  than an extension id: chat is built into VS Code and Copilot ships bundled in
 *  some builds. */
export async function probeCopilotChat(): Promise<{ available: boolean }> {
  try {
    return { available: (await vscode.commands.getCommands(true)).includes("workbench.action.chat.open") };
  } catch {
    return { available: false };
  }
}
```

and in `collectInputs`, beside `claudeCode:`:

```ts
    agentProvider: cfg.agentProvider,
    // Only probed when it can matter — the Claude Code path must not pay for it.
    copilotChat: cfg.agentProvider === "copilot" ? await d.copilotChat() : { available: false },
```

Then add `agentProvider: cfg.agentProvider` to the `DoctorConfig` literal near `src/doctorView.ts:193`, and `copilotChat: probeCopilotChat` to the `DoctorDeps` literal that supplies `claudeExtension`. `tsc` will point at both.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS. `test/unit/doctorView.deps.test.ts` may need the two new deps added to its fixture — that is a *fixture* extension, not a behavior change, and is the one sanctioned kind of edit here. If an existing doctor *assertion* changes, stop.

- [ ] **Step 7: Commit**

```bash
git add src/engine/doctor.ts src/doctorView.ts test/unit/engine/doctor.test.ts test/unit/doctorView.test.ts test/unit/doctorView.deps.test.ts
git commit -m "feat(doctor): check the configured agent, not always Claude Code

Under agentProvider: copilot, Doctor reports whether a chat command is
registered and skips the Claude Code version floor, which exists for
claude-vscode.editor.open. The Claude session-files row stays under both
providers — the Deck's live signal is provider-independent.

Co-Authored-By: Claude Opus 5 (1M context) <noreply\@anthropic.com>"
```

---

### Task 8: Name the agent in user-facing copy

Seven strings hardcode "Claude Code" at seed time, plus one that makes a factual claim in a PR review body. Deliverable: under Copilot they name Copilot; under the default they render byte-identical to today.

**Files:**
- Modify: `src/config.ts` (`providerLabel`)
- Modify: `src/tasksView.ts:1360-1373` (`seededNote`), `:1582` (batch confirm), `:194` (post `agentLabel`)
- Modify: `src/deckView.ts:44` (`REVIEW_PROVENANCE`), `:426` (review toast)
- Modify: `src/engine/workspace.ts:812` (clipboard fallback)
- Modify: `src/webview/App.tsx:32,128,218,508,675` (`agentLabel` state + the two tooltips)
- Test: `test/unit/tasksView.test.ts`, `test/unit/deckView.test.ts`, `test/unit/engine/workspace.test.ts`

**Interfaces:**
- Consumes: `AgentProvider` and `AgentFlowConfig.agentProvider` (Task 1).
- Produces: `export function providerLabel(p: AgentProvider): string` from `src/config.ts`. `REVIEW_PROVENANCE` becomes `reviewProvenance(p: AgentProvider): string` — a function, not a constant.

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/tasksView.test.ts
it("names Copilot in the pre-seeded toast", async () => {
  env.uriScheme = "vscode";
  setConfig({ agentProvider: "copilot", seedAgent: true, remoteControl: "off" });
  await takeTask("PROJ-1");
  expect(lastToast()).toContain("Copilot pre-seeded — press Enter to start.");
  env.uriScheme = "cursor";
});

it("still says Claude Code by default", async () => {
  setConfig({ agentProvider: undefined, seedAgent: true, remoteControl: "off" });
  await takeTask("PROJ-1");
  expect(lastToast()).toContain("Claude Code pre-seeded — press Enter to start.");
});
```

```ts
// test/unit/deckView.test.ts
it("stamps the drafting agent's name", () => {
  expect(reviewProvenance("claude-code")).toBe("_Drafted with Claude Code via Agent Flow Deck._");
  expect(reviewProvenance("copilot")).toBe("_Drafted with Copilot via Agent Flow Deck._");
});
```

The second `tasksView` test is the regression guard — the exact string is what ships today.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/unit/tasksView.test.ts test/unit/deckView.test.ts`
Expected: FAIL — the Copilot cases say "Claude Code", and `reviewProvenance` does not exist. The default-case guard must already PASS.

- [ ] **Step 3: Add the label helper**

In `src/config.ts`, below `readAgentProvider`:

```ts
/** The agent's name, for copy that tells the user what was just seeded. */
export function providerLabel(p: AgentProvider): string {
  return p === "copilot" ? "Copilot" : "Claude Code";
}
```

- [ ] **Step 4: Apply it in the extension host**

`src/tasksView.ts` — `seededNote` takes the provider and interpolates it. Give the parameter a default of `"claude-code"` **only if** the method has callers this task does not touch; otherwise pass it explicitly at every call site so `tsc` catches a miss:

```ts
  private seededNote(
    seedAgent: boolean,
    remoteControl: boolean,
    provider: AgentProvider,
    seededInPlace = false,
  ): string {
    if (!seedAgent) {
      return seededInPlace
        ? " This window is untouched — agentFlow.seedAgent is off, so no session was seeded."
        : "";
    }
    const agent = providerLabel(provider);
    return remoteControl
      ? ` ${agent} pre-seeded with /remote-control — Enter to connect, then paste.`
      : ` ${agent} pre-seeded — press Enter to start.`;
  }
```

Note `provider` sits **before** the defaulted `seededInPlace`; update every call site accordingly.

The batch confirm at `:1582`:

```ts
        `Launch ${keys.length} tasks in parallel? That's ${keys.length} ${providerLabel(cfg.agentProvider)} sessions.`,
```

`src/deckView.ts` — turn the constant into a function and update its callers:

```ts
/** Appended to a review body the agent drafted, when provenance stamping is on.
 * Posting an agent's words as unmarked human review is the kind of thing worth
 * being straight about with teammates — which means naming the agent that actually
 * drafted it. */
export const reviewProvenance = (p: AgentProvider): string =>
  `_Drafted with ${providerLabel(p)} via Agent Flow Deck._`;
```

and the toast at `:426`:

```ts
      `Reviewing ${req.repoName}#${req.number} in a worktree.${cfg.seedAgent ? ` ${providerLabel(cfg.agentProvider)} pre-seeded — press Enter to start.` : ""}`,
```

`src/engine/workspace.ts:812` — the clipboard fallback:

```ts
  vscode.window.showInformationMessage(
    `Agent Flow Deck: opened workspace for ${key}. ${providerLabel(readAgentProvider())} prompt copied — paste it into the panel to start.`,
  );
```

- [ ] **Step 5: Plumb the label into the webview**

The webview cannot read configuration. In `src/tasksView.ts:194`, add to the posted state:

```ts
      agentLabel: providerLabel(cfg.agentProvider),
```

In `src/webview/App.tsx`, beside `DEFAULT_SOURCE_LABEL` at line 32:

```tsx
// The webview renders before the extension's first state post, so this must be a
// real name and not "" — a tooltip that reads "undefined" is worse than one that
// briefly names the default agent. Same reasoning as DEFAULT_SOURCE_LABEL.
const DEFAULT_AGENT_LABEL = "Claude Code";
```

Add the state at line 128 and set it in the `"state"` handler at line 218, mirroring `sourceLabel` exactly:

```tsx
  const [agentLabel, setAgentLabel] = React.useState(DEFAULT_AGENT_LABEL);
```
```tsx
          setAgentLabel(m.agentLabel);
```

Then the two tooltips:

```tsx
            title={`Explore repos with a ${agentLabel} agent — pick repos, no ticket needed`}
```
```tsx
            title={`Open ${selectedVisible.length} ${selectedVisible.length === 1 ? "task" : "tasks"} across ${batchRepos.join(", ")}, each in its own worktree with its own ${agentLabel} session`}
```

Add `agentLabel: string` to the state message's type wherever `sourceLabel: string` is declared on it.

- [ ] **Step 6: Run the tests, typecheck, and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS. **`npm run build` is not optional here** — this task edits `src/webview/App.tsx`, and the build is the only gate that catches a Node-only import reaching the webview bundle.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/tasksView.ts src/deckView.ts src/engine/workspace.ts src/webview/App.tsx test/unit/tasksView.test.ts test/unit/deckView.test.ts test/unit/engine/workspace.test.ts
git commit -m "feat(copy): name the agent that was actually seeded

Seven seed-time strings plus the PR review provenance line, which makes a
factual claim about who drafted the review. Under the default provider
every string renders byte-identical to today.

Co-Authored-By: Claude Opus 5 (1M context) <noreply\@anthropic.com>"
```

---

### Task 9: Documentation and the regression sweep

Deliverable: the settings are documented, the changelog records them, and the default path is confirmed by hand across all six launch entry points.

**Files:**
- Modify: `README.md` (settings table)
- Modify: `CHANGELOG.md` (Unreleased)
- Modify: `package.json` (version bump)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Document both settings in the README**

Add to the settings table, beside the existing `agentFlow.agentSurface` row, and update that row's wording so it no longer names one agent:

```markdown
| `agentFlow.agentProvider` | `claude-code` | Which agent starts a session. `copilot` uses GitHub Copilot and works **only in VS Code** — in Cursor and other forks it falls back to Claude Code. Copilot sessions do not appear as live agents on the Deck. |
| `agentFlow.agentSurface` | `extension` | Where a session starts: the agent's chat panel, or `terminal` to run its CLI in an integrated terminal. Either way the prompt is pre-filled and you press Enter. |
```

If Task 2, Step 6 found the `when` clause does **not** hide the setting in Cursor, add one sentence to the README row saying the setting is visible everywhere but has no effect outside VS Code.

- [ ] **Step 2: Add the changelog entry**

Under `## [Unreleased]`:

```markdown
- **`agentFlow.agentProvider` — start sessions with GitHub Copilot.** Set it to
  `copilot` and a taken task opens Copilot Chat in agent mode with the prompt
  pre-filled, or runs the `copilot` CLI when `agentFlow.agentSurface` is `terminal`.
  VS Code only; Cursor falls back to Claude Code. Remote Control and Deck live-agent
  tracking remain Claude Code only.
```

- [ ] **Step 3: Run every gate**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`
Expected: PASS, with coverage thresholds met and ≥95% on every file this branch changed.

- [ ] **Step 4: Confirm no pre-existing test was edited**

```bash
git diff main --stat -- test/
git diff main -- test/ | grep '^-' | grep -v '^---' | head -50
```

Expected: deletions only where a *fixture literal* gained a field (Task 7's `DoctorDeps`) or a call site gained the `provider` argument (Task 8's `seededNote`). **Any deleted assertion is a behavior change** — stop and surface it rather than committing.

- [ ] **Step 5: Manual regression on default settings**

Clear `agentFlow.agentProvider` and `agentFlow.agentSurface` entirely, then in a dev host (`code --extensionDevelopmentPath=.`) walk all six paths through the seeding chokepoint. Each must open the Claude Code panel pre-filled, exactly as before:

1. Take a task from the task panel
2. Batch launch two selected tasks
3. Relaunch a run from the Deck
4. Explore (pick repos, no ticket)
5. Notepad
6. PR review kick-off ("Address PR")

Then set `agentFlow.remoteControl` to `on` and take a task — Remote Control must behave exactly as it does today, with no error toast.

- [ ] **Step 6: Manual confirmation of the new paths**

With `agentProvider: copilot` in a VS Code host: take a task (chat panel, prefilled, agent mode, unsubmitted); switch `agentSurface` to `terminal` and take another (a `Copilot · KEY` terminal running `copilot`, prompt pre-typed); batch-launch two tasks (two chat editor tabs, or the brief notification); turn Remote Control on and take a task (refused, no window opens); run Doctor (Copilot row, no Claude Code version row).

Then open the same worktree in **Cursor** with `agentProvider: copilot` still in settings and take a task — it must open Claude Code, and the setting must not appear in Cursor's settings UI if Task 2 confirmed the `when` clause works.

- [ ] **Step 7: Bump the version and commit**

Bump the patch version in `package.json`, then:

```bash
git add README.md CHANGELOG.md package.json
git commit -m "docs: document agentFlow.agentProvider

Co-Authored-By: Claude Opus 5 (1M context) <noreply\@anthropic.com>"
```

The `.vsix` rebuild belongs to the merge-to-main ritual, not to this branch.

---

## Notes for the implementer

- **`test/_mocks/vscode.ts` resets `env.uriScheme` to `"cursor"`.** That default is load-bearing: it is why the entire existing suite exercises the Claude Code path unchanged. Never change the mock's default to `"vscode"` to make a test easier — that would silently flip hundreds of tests onto a path they were not written for.
- **`readAgentProvider()` is called at seed time, deliberately.** Do not optimize it into a value captured at activation or threaded through `PlanFile`; that turns a live preference into a stale snapshot, which the terminal-surface work already rejected for the same reason.
- **The `when` clause is cosmetic.** If it turns out not to work, nothing else changes. Do not invent a second mechanism to hide the setting.
- **`preferred` in `seedCopilotPanel` holds only the editor command under `multi`.** Adding the panel command as a fallback there reintroduces exactly the overwriting bug Task 5 exists to prevent.
