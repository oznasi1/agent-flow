# Cursor Agent Provider + Ask-Per-Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Agent Flow seed a task into Cursor's composer, and add an `ask` setting value that picks the agent per launch.

**Architecture:** `agentFlow.agentProvider` widens from a 2-value to a 4-value enum (`claude-code | copilot | cursor | ask`). Cursor seeds through `workbench.action.chat.open` — the same command id the Copilot path already calls, but Cursor's handler opens a new composer tab per call, so Cursor gets per-task batch tabs Copilot cannot have. `ask` resolves once inside `openWorkspace`, before anything is opened, and the resolved agent rides to the target window in the plan file; the three fixed values keep reading the setting live at seed time.

**Tech Stack:** TypeScript, VS Code extension API, Vitest (with `vscode` mocked at `test/_mocks/vscode.ts`), esbuild.

**Spec:** [`docs/superpowers/specs/2026-08-19-cursor-agent-provider-design.md`](../specs/2026-08-19-cursor-agent-provider-design.md)

**Worktree:** `/Users/oznasi/dev/agent-flow-cursor-provider`, branch `feat/cursor-agent-provider`, based on `origin/main` @ 38e178d (0.30.1). All paths below are relative to that worktree. Use absolute paths in shell commands — other sessions share the root checkout at `/Users/oznasi/dev/agent-flow` and switch its branch.

## Global Constraints

These apply to **every** task. They are not optional and they are not summarised elsewhere.

- **Four CI gates, all required before any commit:**
  - `npm run typecheck` — must be clean.
  - `npm test` — full suite, must pass.
  - `npm run test:cov` — coverage thresholds are enforced and will fail the build.
  - `npm run build` — **this is the only gate that catches a `vscode`, `fs`, `os`, `path`, or `child_process` import leaking into a webview bundle.** `typecheck` and the full suite both pass while that bug is present. Never skip it.
- **The existing test suite must pass completely unmodified.** This extension has thousands of installs. If an existing test fails, your change is wrong — do not edit the test to match. The one exception is Task 4, which widens a type that two existing tests assert on; that task names those tests explicitly and no other task may touch an existing test.
- **Every new behaviour ships inert.** Under `agentProvider: "claude-code"`, `"copilot"`, and any value written before this change, every user-visible string and every code path must be byte-identical to 0.30.1.
- **TDD, strictly.** Write the failing test, run it, confirm it fails *for the stated reason* (not for a typo, a missing import, or a mock that was never configured). Only then implement.
- **Mutation-check every test you write.** After a test passes, break the line of production code it targets (invert a condition, return the other branch) and re-run that single test. If it still passes, the test is vacuous — rewrite it before moving on. Then restore the code. This step is mandatory; a passing vacuous test is worse than no test.
- **Commit at the end of every task, and after any step that leaves the tree green.** Do not batch a whole task into one final commit — if you are interrupted mid-task, the work must survive.
- **Never edit files under `/Users/oznasi/dev/agent-flow`.** Work only in the worktree.
- Sign commits with the trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

### Vocabulary fixed by the spec — use these exact names

```ts
type AgentProvider        = "claude-code" | "copilot" | "cursor";   // a real agent
type AgentProviderSetting = AgentProvider | "ask";                  // what the setting holds
isCursorHost(): boolean
hostProviders(): AgentProvider[]
readAgentProviderSetting(c?): AgentProviderSetting
seedProvider(plan: PlanFile): AgentProvider
providerLabel(p: AgentProvider): string
```

Setting values are the strings `"claude-code"`, `"copilot"`, `"cursor"`, `"ask"`. Display labels are `"Claude Code"`, `"Copilot"`, `"Cursor"`. Do not invent variants (`"cursor-agent"` is the **CLI binary name only**, never a setting value).

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `package.json` | The `agentFlow.agentProvider` enum, its descriptions, removal of the `when` gate | 1, 4, 7 |
| `src/config.ts` | Provider types, host detection, setting read, `providerLabel` | 1, 4 |
| `src/engine/workspace.ts` | `CLI` map, chat-panel seeding, `openWorkspace` resolution, `seedProvider`, plan-file fields | 2, 4, 5 |
| `src/extension.ts` | Removal of the dead `agentFlow.host.vscode` context key | 4 |
| `src/engine/doctor.ts` | Which check rows appear per setting | 3, 7 |
| `src/doctorView.ts` | The chat-command probe and its wiring | 3, 7 |
| `src/telemetry/settingsSnapshot.ts` | The `AGENT_PROVIDERS` enum | 1, 7 |
| `src/tasksView.ts` | Remote Control pre-flight, batch pinning, cancel guards, launch copy | 2, 4, 6 |
| `src/deckView.ts` | Deck seed edge, review toast, review provenance | 6 |
| `src/engine/review/launch.ts` | PR-review launch cancel guard | 6 |
| `src/engine/orchestrator/launch.ts` | Pins `claude-code` for unattended launches | 6 |
| `README.md`, `CHANGELOG.md` | User-facing documentation of the new values | 7 |

---

## Task 1: `cursor` as a third provider in the config layer

Adds the value to the type, the manifest, the telemetry enum, and the label function. No seeding behaviour yet — after this task, setting `cursor` behaves like `claude-code` at seed time, which is safe and inert.

**Files:**
- Modify: `src/config.ts:150` (the `AgentProvider` type), `:156-175` (host detection, `readAgentProvider`, `providerLabel`), `:261-262` (the `AgentFlowConfig` comment)
- Modify: `package.json:225-238` (the `agentFlow.agentProvider` contribution)
- Modify: `src/telemetry/settingsSnapshot.ts:45`
- Test: `test/unit/config.test.ts` (extend the existing `describe("getConfig — agentProvider")` block at :595)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `type AgentProvider = "claude-code" | "copilot" | "cursor"`; `isCursorHost(): boolean`; `providerLabel(p: AgentProvider): string` returning `"Cursor"` for `"cursor"`. Tasks 2, 3, and 4 all depend on these exact names.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/config.test.ts`, inside the existing `describe("getConfig — agentProvider")` block (it already has an `afterEach` restoring `env.uriScheme = "cursor"`, so do not add another):

```ts
it("keeps cursor in a Cursor host", () => {
  env.uriScheme = "cursor";
  setConfig({ agentProvider: "cursor" });
  expect(getConfig().agentProvider).toBe("cursor");
});

it("degrades cursor to claude-code in VS Code", () => {
  env.uriScheme = "vscode";
  setConfig({ agentProvider: "cursor" });
  expect(getConfig().agentProvider).toBe("claude-code");
});

it("degrades cursor to claude-code in an unrelated host", () => {
  env.uriScheme = "windsurf";
  setConfig({ agentProvider: "cursor" });
  expect(getConfig().agentProvider).toBe("claude-code");
});

it("still degrades copilot to claude-code in Cursor", () => {
  env.uriScheme = "cursor";
  setConfig({ agentProvider: "copilot" });
  expect(getConfig().agentProvider).toBe("claude-code");
});
```

And a new top-level block for the label and host predicate:

```ts
describe("isCursorHost / providerLabel", () => {
  afterEach(() => {
    env.uriScheme = "cursor";
  });

  it("is true only for the cursor scheme", () => {
    env.uriScheme = "cursor";
    expect(isCursorHost()).toBe(true);
    env.uriScheme = "vscode";
    expect(isCursorHost()).toBe(false);
    env.uriScheme = "windsurf";
    expect(isCursorHost()).toBe(false);
  });

  it("labels every provider", () => {
    expect(providerLabel("claude-code")).toBe("Claude Code");
    expect(providerLabel("copilot")).toBe("Copilot");
    expect(providerLabel("cursor")).toBe("Cursor");
  });
});
```

Add `isCursorHost` and `providerLabel` to the existing `import { ... } from "../../src/config"` line at the top of that file.

- [ ] **Step 2: Run the tests and verify they fail**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider && npx vitest run test/unit/config.test.ts -t "cursor"
```

Expected: failures. `isCursorHost` is not exported (a TypeScript/import error), and `getConfig().agentProvider` returns `"claude-code"` where `"cursor"` is expected. If you see a failure about `setConfig` or `env` being undefined, you have an import problem, not a real red — fix that first.

- [ ] **Step 3: Implement in `src/config.ts`**

Replace the `AgentProvider` type at :150 and the three functions below it:

```ts
/** Which agent Agent Flow starts a session with. */
export type AgentProvider = "claude-code" | "copilot" | "cursor";

/** The VS Code family, by uri scheme: `vscode`, `vscode-insiders`, and any other
 * `vscode*` build. Cursor is `cursor`, Windsurf is `windsurf`. Preferred over
 * `env.appName`, which is localized, and it is the signal the seeding path already
 * reads. */
export function isVSCodeHost(): boolean {
  return (vscode.env.uriScheme ?? "").startsWith("vscode");
}

/** Cursor, by the same signal. Exact match, not a prefix: unlike the VS Code family
 * there are no `cursor-*` sibling builds, and a prefix test would claim any future
 * scheme that merely starts with those six letters. */
export function isCursorHost(): boolean {
  return (vscode.env.uriScheme ?? "") === "cursor";
}

/** Read the agent. Anything unrecognized — including undefined — means Claude Code,
 * so a typo in settings.json degrades rather than breaking seeding. `copilot` and
 * `cursor` each additionally require their own host: settings sync carries values
 * between editors, so each value degrades in the wrong editor instead of failing at
 * seed time. This runtime guard — not the manifest — is what makes the behavior
 * correct, and it is now the reason the manifest needs no `when` clause at all.
 * Called with no argument from the seeding path, which reads at seed time rather
 * than capturing at activation. */
export function readAgentProvider(
  c: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("agentFlow"),
): AgentProvider {
  const raw = c.get<string>("agentProvider");
  if (raw === "copilot" && isVSCodeHost()) return "copilot";
  if (raw === "cursor" && isCursorHost()) return "cursor";
  return "claude-code";
}

/** The agent's name, for copy that tells the user what was just seeded. */
export function providerLabel(p: AgentProvider): string {
  return p === "copilot" ? "Copilot" : p === "cursor" ? "Cursor" : "Claude Code";
}
```

Update the `AgentFlowConfig.agentProvider` comment at :261-262 to name all three agents and both host rules.

- [ ] **Step 4: Update the manifest**

In `package.json`, in the `agentFlow.agentProvider` block, add `"cursor"` to `enum` (after `"copilot"`) and a matching third entry to `enumDescriptions`: `"Cursor's composer — Cursor only"`. Leave the `when` clause alone for now; Task 4 removes it. Update `markdownDescription` to mention Cursor:

```
"markdownDescription": "Which agent Agent Flow starts a session with. `copilot` works only in VS Code and `cursor` only in Cursor — each falls back to Claude Code in the other editor. Note that neither Copilot nor Cursor sessions appear as live agents on the Deck, which reads Claude Code's session files."
```

- [ ] **Step 5: Update the telemetry enum**

In `src/telemetry/settingsSnapshot.ts:45`:

```ts
export const AGENT_PROVIDERS = ["claude-code", "copilot", "cursor"] as const;
```

- [ ] **Step 6: Run the tests and verify they pass**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider && npx vitest run test/unit/config.test.ts
```

Expected: PASS, including every pre-existing case in that file.

- [ ] **Step 7: Mutation-check**

In `readAgentProvider`, change `isCursorHost()` to `isVSCodeHost()` in the `cursor` branch and re-run the file. The "degrades cursor to claude-code in VS Code" test must now fail. Restore the line.

- [ ] **Step 8: Run all four gates**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider && npm run typecheck && npm test && npm run test:cov && npm run build
```

Expected: all four clean.

- [ ] **Step 9: Commit**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider
git add src/config.ts src/telemetry/settingsSnapshot.ts package.json test/unit/config.test.ts
git commit -m "feat(agent): accept cursor as an agentProvider value

Host-guarded the mirror of copilot: cursor only resolves in a Cursor host
and degrades to claude-code everywhere else. No seeding behaviour yet.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Seed Cursor's composer and its CLI

Makes `agentProvider: "cursor"` actually start a session, on both surfaces, and widens the Remote Control refusal to cover it.

**Files:**
- Modify: `src/engine/workspace.ts:32-35` (the `CLI` record), `:880-936` (`seedCopilotPanel` → `seedChatPanel`), `:971` (the Remote Control refusal), `:1034` (the dispatch)
- Modify: `src/tasksView.ts:99` (`RC_NEEDS_CLAUDE`), `:1682`, `:1701`, `:1706` (the Remote Control pre-flight)
- Test: `test/unit/engine/workspace.test.ts`, `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `AgentProvider` including `"cursor"`, `providerLabel`, `isCursorHost` (Task 1).
- Produces: `seedChatPanel(provider: AgentProvider, seedText: string, key: string, log: (m: string) => void, multi?: boolean): Promise<boolean>` — replaces `seedCopilotPanel`. Task 5 does not call it directly; Task 6 does not either. Nothing outside `workspace.ts` imports it.

- [ ] **Step 1: Write the failing tests**

In `test/unit/engine/workspace.test.ts`, add a block next to the existing `describe("seedClaudeCode fallback chain (via maybeSeedAgent)")`. Reuse that file's existing `planJson`, `withWorkspaceFile`, and `fakeContext` helpers — do not redefine them. The chat command constant is `"workbench.action.chat.open"`.

```ts
describe("Cursor seeding (via maybeSeedAgent)", () => {
  const CHAT_CMD = "workbench.action.chat.open";

  beforeEach(() => {
    setConfig({ agentProvider: "cursor" });
    env.uriScheme = "cursor";
  });

  it("opens a Cursor composer with the prompt pre-filled and unsubmitted", async () => {
    withWorkspaceFile();
    readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
    readFileSync.mockReturnValue(planJson());
    commands.getCommands.mockResolvedValue([CHAT_CMD]);
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(commands.executeCommand).toHaveBeenCalledWith(CHAT_CMD, {
      query: "do it",
      isPartialQuery: true,
      mode: "agent",
    });
  });

  it("seeds every task of a batch, unlike Copilot", async () => {
    // Cursor's handler calls createComposer({ openInNewTab: true }), so N calls give
    // N tabs. Copilot's panel is single-instance and bails to the briefs instead.
    withWorkspaceFile();
    readdirSync.mockReturnValue(["ASM-1-1.json", "ASM-1-2.json"] as never);
    readFileSync
      .mockReturnValueOnce(planJson({ seq: 0, matches: [{ matchPath: "/ws/ASM-1.code-workspace", prompt: "first" }] }))
      .mockReturnValueOnce(planJson({ key: "ASM-2", seq: 1, matches: [{ matchPath: "/ws/ASM-1.code-workspace", prompt: "second" }] }));
    commands.getCommands.mockResolvedValue([CHAT_CMD]);
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    const queries = commands.executeCommand.mock.calls
      .filter((c: unknown[]) => c[0] === CHAT_CMD)
      .map((c: unknown[]) => (c[1] as { query: string }).query);
    expect(queries).toEqual(["first", "second"]);
  });

  it("runs cursor-agent on the terminal surface", async () => {
    setConfig({ agentProvider: "cursor", agentSurface: "terminal" });
    withWorkspaceFile();
    readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
    readFileSync.mockReturnValue(planJson({ matches: [{ matchPath: "/repo", prompt: "do it" }] }));
    workspace.workspaceFile = undefined;
    workspace.workspaceFolders = [{ uri: { fsPath: "/repo" } }];
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(window.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Cursor · ASM-1" }),
    );
    const terminal = window.createTerminal.mock.results[0].value;
    expect(terminal.sendText).toHaveBeenCalledWith("cursor-agent", true);
  });

  it("refuses Remote Control under cursor, as it does under copilot", async () => {
    withWorkspaceFile();
    readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
    readFileSync.mockReturnValue(planJson({ remoteControl: true }));
    commands.getCommands.mockResolvedValue([CHAT_CMD]);
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Remote Control needs Claude Code"),
    );
    expect(commands.executeCommand).not.toHaveBeenCalledWith(CHAT_CMD, expect.anything());
  });
});
```

Check the top of the test file for how `setConfig`, `env`, `window`, `commands`, and `workspace` are imported and follow it exactly. If `window.createTerminal` is not already a `vi.fn()` returning an object with a `sendText` spy in `test/_mocks/vscode.ts`, add that to the mock — that is a mock gap, not a production change.

- [ ] **Step 2: Run the tests and verify they fail**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider && npx vitest run test/unit/engine/workspace.test.ts -t "Cursor seeding"
```

Expected: all four fail. The first three because `provider === "cursor"` falls through to the Claude Code branch; the fourth because the refusal still tests `=== "copilot"`.

- [ ] **Step 3: Add the CLI row**

In `src/engine/workspace.ts`, extend the `CLI` record at :32 and its comment:

```ts
const CLI: Record<AgentProvider, { cmd: string; label: string; bootMs: number }> = {
  "claude-code": { cmd: "claude", label: "Claude", bootMs: 1500 },
  copilot: { cmd: "copilot", label: "Copilot", bootMs: 2000 }, // UNVERIFIED — measure in the dev host before release
  // UNVERIFIED — and note `cursor-agent` is NOT installed alongside Cursor itself;
  // it is a separate install, so the `command not found` fallback is reached more
  // often here than for the other two.
  cursor: { cmd: "cursor-agent", label: "Cursor", bootMs: 2000 },
};
```

- [ ] **Step 4: Generalize the chat-panel seeder**

Rename `seedCopilotPanel` to `seedChatPanel` and give it a leading `provider` parameter. The **only** behavioural fork is the `multi` guard:

```ts
/** Open a chat panel with the prompt pre-filled and unsubmitted. Serves both Copilot
 * and Cursor: they register the same command id, `workbench.action.chat.open`. Polls
 * for it because Agent Flow and the chat extension both activate on
 * `onStartupFinished`, so the same activation race applies to either host.
 *
 * There is no URI-handler rung here — neither publishes a documented
 * open-with-prompt URI we are willing to use. Cursor does register
 * `deeplink.prompt.prefill`, but it raises a "Create chat with prompt" confirmation
 * modal before doing anything, which is worse than the clipboard fallback below. So a
 * false return means the caller should fall back to the clipboard.
 *
 * `multi` forks by provider, because their handlers differ:
 *   - Copilot's chat panel is single-instance, so a batch of N tasks would each
 *     overwrite the previous prompt and the user would silently end up with only the
 *     last one seeded. It bails immediately, sending the caller down its existing
 *     `multi` fallback: the "briefs are in .pick-task/" notification.
 *   - Cursor's handler calls `createComposer({ openInNewTab: true })`, so each call
 *     gets its own composer tab and a batch seeds correctly. It proceeds. */
async function seedChatPanel(
  provider: AgentProvider,
  seedText: string,
  key: string,
  log: (m: string) => void,
  multi = false,
): Promise<boolean> {
  if (multi && provider === "copilot") {
    log(`seed ${key}: per-task Copilot chat tabs are not wired up yet — batch falls back to the briefs`);
    return false;
  }
  const label = providerLabel(provider);
  for (let attempt = 1; attempt <= 7; attempt++) {
    let cmds: string[];
    try {
      cmds = await vscode.commands.getCommands(true);
    } catch (e) {
      log(`seed ${key}: ${label} command attempt ${attempt} threw: ${e}`);
      await delay(700);
      continue;
    }
    if (!cmds.includes(CHAT_OPEN_CMD)) {
      await delay(700);
      continue;
    }
    // The command is registered, so any throw from here on is a real failure on its
    // merits rather than the activation race this loop exists to ride out. Retrying
    // would stall ~4.9s and could reopen the panel on every attempt, so try exactly
    // once and fall through to the clipboard fallback below.
    try {
      await vscode.commands.executeCommand(CHAT_OPEN_CMD, {
        query: seedText,
        isPartialQuery: true,
        mode: "agent",
      });
      log(`seed ${key}: opened ${label} via ${CHAT_OPEN_CMD} (attempt ${attempt})`);
      return true;
    } catch (e) {
      log(`seed ${key}: ${CHAT_OPEN_CMD} is registered but threw — not retrying: ${e}`);
      return false;
    }
  }
  log(`seed ${key}: no chat command registered — falling back to the clipboard`);
  return false;
}
```

Update the `CHAT_OPEN_CMD` comment at :52-57 to say both Copilot Chat and Cursor serve this command, that Cursor ignores `isPartialQuery` and `mode` because prefill-without-submit is its default, and that Cursor's handler was read from the shipped workbench bundle but not yet run.

Update the dispatch at :1034 from `} else if (await seedCopilotPanel(seedText, key, log, multi)) {` to:

```ts
} else if (await seedChatPanel(provider, seedText, key, log, multi)) {
```

- [ ] **Step 5: Widen the Remote Control refusal**

In `seedAgentSession` at :971:

```ts
  if (remoteControl && readAgentProvider() !== "claude-code") {
```

and update the message to name the setting generically rather than Copilot. Update the comment block above it (:960-970) so it says the refusal covers every non-Claude agent, not just Copilot.

In `src/tasksView.ts`, change the three Copilot equality tests to cover both non-Claude agents:

- `:1682` → `if (cfg.agentProvider === "claude-code" || cfg.remoteControl !== "on" || !cfg.seedAgent) {`
- `:1701` → `if (cfg.agentProvider !== "claude-code" && cfg.remoteControl === "ask") {`
- `:1706` → `if (on && cfg.agentProvider !== "claude-code") {`

Update the doc comments on `remoteControlBlocksLaunch` (:1668-1682) and `resolveRemoteControl` (:1698): the line *"`cfg.agentProvider` is host-guarded by readAgentProvider, so none of this can fire in Cursor"* is now **false** and must be replaced — under `cursor` this is exactly what fires in Cursor.

- [ ] **Step 6: Run the tests and verify they pass**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider && npx vitest run test/unit/engine/workspace.test.ts test/unit/tasksView.test.ts
```

Expected: PASS, including every pre-existing Copilot case.

- [ ] **Step 7: Mutation-check**

Change `if (multi && provider === "copilot")` to `if (multi)` and re-run. "seeds every task of a batch, unlike Copilot" must fail. Restore. Then change the refusal back to `=== "copilot"` and confirm "refuses Remote Control under cursor" fails. Restore.

- [ ] **Step 8: Run all four gates and commit**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider
npm run typecheck && npm test && npm run test:cov && npm run build
git add -A
git commit -m "feat(agent): seed Cursor's composer and cursor-agent CLI

Cursor registers the same workbench.action.chat.open command as Copilot, so
seedCopilotPanel generalizes to seedChatPanel. The one fork is batch: Cursor's
handler opens a new composer tab per call, so a batch seeds every task, while
Copilot's single-instance panel still bails to the briefs.

Remote Control's refusal widens from copilot to every non-Claude agent.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Doctor rows for Cursor

**Files:**
- Modify: `src/engine/doctor.ts:76-82` (`DoctorInputs`), `:248-266` (`agentChecks`, `copilotChecks`)
- Modify: `src/doctorView.ts:38` (the config slice type), `:56` (the deps type), `:97-99` (the input build), `:180-186` (`probeCopilotChat`), `:235`
- Test: `test/unit/engine/doctor.test.ts`, `test/unit/doctorView.test.ts`, `test/unit/doctorView.deps.test.ts`

**Interfaces:**
- Consumes: `AgentProvider` including `"cursor"` (Task 1).
- Produces: `DoctorInputs.chatCommand: { available: boolean }` — renamed from `copilotChat`. `probeChatCommand()` — renamed from `probeCopilotChat`. Task 7 widens `DoctorInputs.agentProvider` to `AgentProviderSetting` and adds the `ask` union row; it depends on these names.

- [ ] **Step 1: Write the failing test**

In `test/unit/engine/doctor.test.ts`, follow the existing pattern for building `DoctorInputs` in that file (there is already a helper or object literal for it — reuse it rather than writing a new one):

```ts
it("shows the chat row and Claude session rows under cursor", () => {
  const checks = buildChecks(inputs({ agentProvider: "cursor", chatCommand: { available: true } }));
  const groups = checks.map((c) => c.group);
  expect(groups).toContain("Cursor");
  expect(groups).not.toContain("Copilot");
  // Cursor composer sessions do not appear on the Deck, which reads Claude Code's
  // session files — so the session rows still have to explain themselves.
  expect(groups).toContain("Claude Code sessions");
});

it("points a failing chat row at Cursor's own agent, not the Copilot extension", () => {
  const checks = buildChecks(inputs({ agentProvider: "cursor", chatCommand: { available: false } }));
  const row = checks.find((c) => c.group === "Cursor");
  expect(row?.status).toBe("fail");
  expect(row?.action).toBeUndefined();
});
```

Replace `buildChecks`, `inputs`, and the `"Claude Code sessions"` group string with whatever that file and `claudeSessionChecks` actually use — read them first, do not assume.

- [ ] **Step 2: Run and verify it fails**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider && npx vitest run test/unit/engine/doctor.test.ts -t "cursor"
```

Expected: FAIL — `cursor` currently falls into `claudeChecks`, so there is no `"Cursor"` group at all.

- [ ] **Step 3: Rename the probe field and generalize the rows**

In `src/engine/doctor.ts`, rename `copilotChat` to `chatCommand` on `DoctorInputs` and update its comment; the probe is unchanged — it checks command registration, and **Cursor registers the same command**, which is precisely why one field serves both.

Replace `agentChecks` and `copilotChecks`:

```ts
function agentChecks(i: DoctorInputs): Check[] {
  return i.agentProvider === "claude-code"
    ? claudeChecks(i)
    : [...chatChecks(i, i.agentProvider), ...claudeSessionChecks(i)];
}

/** The chat-panel row for whichever non-Claude agent is configured. Both Copilot and
 *  Cursor serve `workbench.action.chat.open`, so availability is one probe; only the
 *  group name and the remedy differ. Copilot's remedy is an extension to install;
 *  Cursor's agent is built into the editor, so there is nothing to point at and the
 *  row carries no action. */
function chatChecks(i: DoctorInputs, provider: Exclude<AgentProvider, "claude-code">): Check[] {
  const label = providerLabel(provider);
  return [
    {
      group: label,
      label: `${label} chat available`,
      status: i.chatCommand.available ? "ok" : "fail",
      detail: i.chatCommand.available
        ? "workbench.action.chat.open is registered"
        : `no chat command is registered — ${label} isn't available in this window`,
      ...(i.chatCommand.available || provider === "cursor"
        ? {}
        : { action: { kind: "extension", id: "github.copilot-chat", label: "Show extension" } }),
    },
  ];
}
```

Import `providerLabel` and `AgentProvider` into `doctor.ts` from `../config` if they are not already imported. **Check first** whether `doctor.ts` deliberately avoids importing from `config.ts` — the file has a comment at :71 about staying structural to avoid importing `vscode`-aware code. If `config.ts` imports `vscode`, do **not** import from it here; inline a local `Record<AgentProvider, string>` label map in `doctor.ts` instead and note why.

- [ ] **Step 4: Update `doctorView.ts`**

- `:38` — widen the config slice type to the full `AgentProvider`.
- `:56` and `:235` — rename `copilotChat` to `chatCommand` and `probeCopilotChat` to `probeChatCommand`.
- `:97-99` — probe whenever the provider is not Claude Code:

```ts
    agentProvider: cfg.agentProvider,
    // Only probed when it can matter — the Claude Code path must not pay for it.
    chatCommand: cfg.agentProvider !== "claude-code" ? await d.chatCommand() : { available: false },
```

- [ ] **Step 5: Run tests, verify pass, mutation-check**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider && npx vitest run test/unit/engine/doctor.test.ts test/unit/doctorView.test.ts test/unit/doctorView.deps.test.ts
```

Expected: PASS. Then mutation-check: change `provider === "cursor"` in the action guard to `provider === "copilot"` and confirm "points a failing chat row at Cursor's own agent" fails. Restore.

- [ ] **Step 6: Run all four gates and commit**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider
npm run typecheck && npm test && npm run test:cov && npm run build
git add -A
git commit -m "feat(doctor): report Cursor's chat availability

One probe serves both non-Claude agents — Copilot and Cursor register the same
workbench.action.chat.open — so copilotChat becomes chatCommand. Cursor's row
carries no install action: its agent ships with the editor.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `ask` as a setting value — inert

Introduces `ask` into the type system and the manifest, plus the total `seedProvider` function, and makes every consumer handle it. **After this task `ask` behaves exactly like `claude-code`** — no picker exists yet. That is deliberate: it keeps the tree green and the behaviour sane at every commit.

**Files:**
- Modify: `src/config.ts` (add `AgentProviderSetting`, `hostProviders`, `readAgentProviderSetting`; widen `AgentFlowConfig.agentProvider`)
- Modify: `package.json` (add `"ask"` to the enum; **remove** the `when` clause)
- Modify: `src/extension.ts:54-70` (remove the dead context key)
- Modify: `src/engine/workspace.ts` (add `seedProvider`; use it in `seedAgentSession`)
- Modify: `src/tasksView.ts` (pre-launch copy at :2144-2145, :2231, :2368-2371)
- Modify: `src/telemetry/settingsSnapshot.ts:45`
- Test: `test/unit/config.test.ts`, `test/unit/engine/workspace.test.ts`, `test/unit/telemetry/settingsSnapshot.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces:
  - `type AgentProviderSetting = AgentProvider | "ask"`
  - `hostProviders(): AgentProvider[]` — `["claude-code"]`, plus `"copilot"` in VS Code, plus `"cursor"` in Cursor
  - `readAgentProviderSetting(c?): AgentProviderSetting` — replaces `readAgentProvider`
  - `AgentFlowConfig.agentProvider: AgentProviderSetting`
  - `seedProvider(plan: PlanFile): AgentProvider` in `workspace.ts` (not exported unless a test needs it)

  Task 5 consumes `hostProviders` and `seedProvider`. Task 6 consumes `AgentFlowConfig.agentProvider`.

- [ ] **Step 1: Write the failing tests**

`test/unit/config.test.ts`:

```ts
it("passes ask through in every host", () => {
  for (const scheme of ["cursor", "vscode", "windsurf"]) {
    env.uriScheme = scheme;
    setConfig({ agentProvider: "ask" });
    expect(getConfig().agentProvider).toBe("ask");
  }
});

describe("hostProviders", () => {
  afterEach(() => {
    env.uriScheme = "cursor";
  });

  it("offers Claude Code and Copilot in VS Code", () => {
    env.uriScheme = "vscode";
    expect(hostProviders()).toEqual(["claude-code", "copilot"]);
  });

  it("offers Claude Code and Cursor in Cursor", () => {
    env.uriScheme = "cursor";
    expect(hostProviders()).toEqual(["claude-code", "cursor"]);
  });

  it("offers only Claude Code in an unrelated host", () => {
    env.uriScheme = "windsurf";
    expect(hostProviders()).toEqual(["claude-code"]);
  });
});
```

`test/unit/engine/workspace.test.ts`, in the seeding describe:

```ts
it("a plan's own provider beats a conflicting live setting", async () => {
  setConfig({ agentProvider: "claude-code" });
  withWorkspaceFile();
  readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
  readFileSync.mockReturnValue(planJson({ provider: "cursor" }));
  commands.getCommands.mockResolvedValue(["workbench.action.chat.open", CLAUDE_OPEN_CMD]);
  const { context } = fakeContext();

  await maybeSeedAgent(context, () => {});

  expect(commands.executeCommand).toHaveBeenCalledWith(
    "workbench.action.chat.open",
    expect.objectContaining({ query: "do it" }),
  );
  expect(commands.executeCommand).not.toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
});

it("degrades a bare ask setting to Claude Code at seed time", async () => {
  // Reachable, not theoretical: a plan written under claude-code can sit on disk for
  // up to PLAN_TTL_MS while the user flips the setting to ask, and the plan is
  // re-read here. Degrading beats prompting in a window nobody expected a dialog in.
  setConfig({ agentProvider: "ask" });
  withWorkspaceFile();
  readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
  readFileSync.mockReturnValue(planJson()); // no `provider` field
  commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
  const { context } = fakeContext();

  await maybeSeedAgent(context, () => {});

  expect(commands.executeCommand).toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
  expect(window.showQuickPick).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and verify they fail**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider && npx vitest run test/unit/config.test.ts test/unit/engine/workspace.test.ts -t "ask"
```

Expected: FAIL — `hostProviders` is not exported, and `getConfig().agentProvider` returns `"claude-code"` for `"ask"`.

- [ ] **Step 3: Implement in `src/config.ts`**

```ts
/** What `agentFlow.agentProvider` holds. `ask` is not an agent — it means "pick one
 * per launch" — so it is deliberately kept out of `AgentProvider`, which keeps
 * `providerLabel` and the `CLI` record total and stops every copy site from having
 * to invent a label for it. */
export type AgentProviderSetting = AgentProvider | "ask";

/** The agents this host can actually start, in picker order. Claude Code is the one
 * universal choice, so it is always first and the list is never empty. */
export function hostProviders(): AgentProvider[] {
  return [
    "claude-code",
    ...(isVSCodeHost() ? (["copilot"] as const) : []),
    ...(isCursorHost() ? (["cursor"] as const) : []),
  ];
}

/** Read the setting. `ask` passes through; `copilot` and `cursor` each require their
 * own host and otherwise degrade; anything unrecognized — including undefined —
 * means Claude Code, so a typo in settings.json degrades rather than breaking
 * seeding. Replaces readAgentProvider. */
export function readAgentProviderSetting(
  c: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("agentFlow"),
): AgentProviderSetting {
  const raw = c.get<string>("agentProvider");
  if (raw === "ask") return "ask";
  if (raw === "copilot" && isVSCodeHost()) return "copilot";
  if (raw === "cursor" && isCursorHost()) return "cursor";
  return "claude-code";
}
```

Delete `readAgentProvider` and update its two importers (`workspace.ts`, and anything the compiler flags). Change `AgentFlowConfig.agentProvider` to `AgentProviderSetting` and `getConfig`'s `agentProvider:` to `readAgentProviderSetting(c)`.

- [ ] **Step 4: Add `seedProvider` in `src/engine/workspace.ts`**

```ts
/** The agent to seed with, resolved in the target window at seed time. A plan carries
 *  `provider` only when `ask` resolved it in the source window; otherwise the setting
 *  is read live, which is what makes flipping the preference affect plans already on
 *  disk. A bare `ask` reaching here means the plan predates its own resolution — a
 *  settings flip inside the 15-minute PLAN_TTL_MS window — so it degrades to the one
 *  agent every host can run rather than putting a dialog in a window the user was not
 *  expecting one in. */
function seedProvider(plan: PlanFile): AgentProvider {
  if (plan.provider) return plan.provider;
  const setting = readAgentProviderSetting();
  return setting === "ask" ? "claude-code" : setting;
}
```

`PlanFile.provider` does not exist yet — add the field now, typed `provider?: AgentProvider`, with the comment *"Present only when `ask` resolved it in the source window; absent means read the setting live."* Task 5 is what writes it.

`seedAgentSession` currently calls `readAgentProvider()` twice (the Remote Control refusal at :971 and the dispatch at :989). It needs the plan to compute this, so thread the resolved provider in: give `seedAgentSession`'s options object a `provider: AgentProvider` field and have `runSeedPass` (:806) pass `seedProvider(plan)`. Replace both `readAgentProvider()` calls with that parameter.

- [ ] **Step 5: Update the manifest and remove the dead context key**

`package.json`: add `"ask"` to `enum` and `"Ask every launch — pick from the agents this editor can run"` to `enumDescriptions`. **Delete the `"when": "agentFlow.host.vscode"` line.** Extend `markdownDescription` with:

```
Set to `ask` to choose per launch. Batch launches ask once for the whole batch, and Orchestrator rules — which run unattended — always use Claude Code, because there is nobody there to answer a picker.
```

`src/extension.ts`: delete the `setContext` block at :54-70 and the now-unused `isVSCodeHost` import. Check whether any other `when` clause in `package.json` still references `agentFlow.host.vscode` — `grep -n "host.vscode" package.json` — and only delete the key if nothing else uses it.

- [ ] **Step 6: Fix the pre-launch copy and the telemetry enum**

`src/telemetry/settingsSnapshot.ts:45`:

```ts
export const AGENT_PROVIDERS = ["claude-code", "copilot", "cursor", "ask"] as const;
```

In `src/tasksView.ts`, three pre-launch copy sites have no concrete provider under `ask`. Add one helper near `seededNote` and use it at all three:

```ts
/** Agent name for copy written BEFORE the launch resolves — the batch confirmation
 *  and the brief. Under `ask` there is no agent yet, so it stays neutral. Post-launch
 *  copy uses `OpenResult.provider` instead and always names the real agent. */
const plannedAgentLabel = (s: AgentProviderSetting): string =>
  s === "ask" ? "your coding agent" : providerLabel(s);
```

- `:2144-2145` — `${plannedAgentLabel(cfg.agentProvider)} sessions`
- `:2231` — `briefMarkdown(detail, plannedAgentLabel(cfg.agentProvider))`
- `:2368-2371` — the batch-layout description; the `cfg.agentProvider === "copilot"` test at :2368 becomes `cfg.agentProvider === "copilot"` still (only Copilot bails to briefs — Cursor and Claude Code both seed a batch), but the labels use `plannedAgentLabel`. **Read that ternary carefully before editing it; do not change which branch Copilot takes.**

Let the compiler find the remaining `providerLabel(cfg.agentProvider)` sites. Any that runs **after** `openWorkspace` returns is Task 6's job — leave those as a `plannedAgentLabel` call for now so the tree compiles, and Task 6 switches them to `result.provider`.

- [ ] **Step 7: Update the two existing tests this widening touches**

`test/unit/telemetry/settingsSnapshot.test.ts` and `test/unit/config.test.ts` may each have a case asserting the old provider set or that an unknown value maps to `invalid`. **These are the only existing tests any task in this plan may modify.** Update them to the new enum; do not change what they are testing. If they pass unmodified, leave them alone.

- [ ] **Step 8: Run tests, verify pass, mutation-check**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider && npm test
```

Expected: PASS. Mutation-check: change `setting === "ask" ? "claude-code" : setting` to `setting as AgentProvider` and confirm "degrades a bare ask setting to Claude Code" fails. Restore.

- [ ] **Step 9: Run all four gates and commit**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider
npm run typecheck && npm test && npm run test:cov && npm run build
git add -A
git commit -m "feat(agent): accept ask as an agentProvider value, inert for now

Adds AgentProviderSetting, hostProviders, and the total seedProvider function,
and widens the config type through every consumer. ask currently behaves as
claude-code; the picker lands next.

Drops the when: agentFlow.host.vscode gate — Cursor users need this setting —
and the now-dead context key with it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `openWorkspace` resolves `ask`

The behavioural heart of the feature.

**Files:**
- Modify: `src/engine/workspace.ts` — `OpenRequest`, `OpenResult`, `openWorkspace:316` (resolution), `:463` (Remote Control), `:468` (`writePlanFile`), `:510` (the return)
- Test: `test/unit/engine/workspace.test.ts`

**Interfaces:**
- Consumes: `hostProviders`, `readAgentProviderSetting`, `providerLabel`, `PlanFile.provider` (Task 4).
- Produces:
  - `OpenRequest.provider?: AgentProvider` — a caller pinning the agent, which suppresses the picker
  - `OpenResult.provider: AgentProvider` — what actually got seeded
  - `OpenResult.cancelled?: true` — the picker was dismissed; nothing was opened

  Task 6 consumes all three.

- [ ] **Step 1: Write the failing tests**

```ts
describe("openWorkspace — ask", () => {
  const req = (over: Partial<OpenRequest> = {}): OpenRequest => ({
    /* copy the base request literal this file already uses in
       describe("openWorkspace — multiroot") at :60 — do not invent one */
    ...baseReq,
    ...over,
  });

  it("does not prompt under a fixed provider, and writes no provider to the plan", async () => {
    setConfig({ agentProvider: "cursor" });
    env.uriScheme = "cursor";
    const result = await openWorkspace(req({ seedAgent: true }));
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(result.provider).toBe("cursor");
    const plan = JSON.parse(writeFileSync.mock.calls.find((c: string[]) => c[0].includes("/plans/"))![1]);
    expect(plan.provider).toBeUndefined();
  });

  it("prompts under ask and writes the choice into the plan", async () => {
    setConfig({ agentProvider: "ask" });
    env.uriScheme = "cursor";
    window.showQuickPick.mockResolvedValueOnce({ label: "Cursor", provider: "cursor" });
    const result = await openWorkspace(req({ seedAgent: true }));
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe("cursor");
    const plan = JSON.parse(writeFileSync.mock.calls.find((c: string[]) => c[0].includes("/plans/"))![1]);
    expect(plan.provider).toBe("cursor");
  });

  it("offers only the agents this host can run", async () => {
    setConfig({ agentProvider: "ask" });
    env.uriScheme = "cursor";
    window.showQuickPick.mockResolvedValueOnce({ label: "Cursor", provider: "cursor" });
    await openWorkspace(req({ seedAgent: true }));
    const items = window.showQuickPick.mock.calls[0][0] as { provider: string }[];
    expect(items.map((i) => i.provider)).toEqual(["claude-code", "cursor"]);
  });

  it("does not prompt when a caller pins a provider", async () => {
    setConfig({ agentProvider: "ask" });
    const result = await openWorkspace(req({ seedAgent: true, provider: "claude-code" }));
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(result.provider).toBe("claude-code");
  });

  it("does not prompt when seeding is off", async () => {
    setConfig({ agentProvider: "ask" });
    await openWorkspace(req({ seedAgent: false }));
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it("opens nothing when the picker is dismissed", async () => {
    setConfig({ agentProvider: "ask" });
    window.showQuickPick.mockResolvedValueOnce(undefined);
    const result = await openWorkspace(req({ seedAgent: true }));
    expect(result.cancelled).toBe(true);
    expect(mkdirSync).not.toHaveBeenCalled();   // no brief
    expect(writeFileSync).not.toHaveBeenCalled(); // no plan, no workspace file
    expect(commands.executeCommand).not.toHaveBeenCalledWith("vscode.openFolder", expect.anything(), expect.anything());
  });

  it("drops Remote Control when ask resolves to a non-Claude agent", async () => {
    setConfig({ agentProvider: "ask" });
    env.uriScheme = "cursor";
    window.showQuickPick.mockResolvedValueOnce({ label: "Cursor", provider: "cursor" });
    const result = await openWorkspace(req({ seedAgent: true, remoteControl: true }));
    expect(result.remoteControl).toBe(false);
    const plan = JSON.parse(writeFileSync.mock.calls.find((c: string[]) => c[0].includes("/plans/"))![1]);
    expect(plan.remoteControl).toBe(false);
  });

  it("keeps Remote Control when ask resolves to Claude Code", async () => {
    setConfig({ agentProvider: "ask" });
    window.showQuickPick.mockResolvedValueOnce({ label: "Claude Code", provider: "claude-code" });
    const result = await openWorkspace(req({ seedAgent: true, remoteControl: true }));
    expect(result.remoteControl).toBe(true);
  });
});
```

Match `writeFileSync`/`mkdirSync` to the fs mocks that file already uses, and the plan-dir path fragment to what `writePlanFile` actually produces (`~/.agentflow/plans`). Read the existing `describe("openWorkspace — multiroot")` setup at :60 first and reuse its request literal and mock scaffolding.

- [ ] **Step 2: Run and verify they fail**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider && npx vitest run test/unit/engine/workspace.test.ts -t "openWorkspace — ask"
```

Expected: FAIL — `result.provider` is `undefined` and no picker is ever shown.

- [ ] **Step 3: Add the fields**

```ts
export interface OpenRequest {
  /** Pin the agent and suppress the `ask` picker. Set by the two callers that must
   *  never prompt: a batch (which resolves once for the whole batch before its loop)
   *  and an Orchestrator rule (which runs unattended, with nobody to answer). */
  provider?: AgentProvider;
  /* … existing fields … */
}

export interface OpenResult {
  /** The agent that was actually seeded. Post-launch copy reads this rather than the
   *  setting, so it names the real agent even under `ask`. */
  provider: AgentProvider;
  /** The `ask` picker was dismissed. Nothing was opened, written, or seeded — every
   *  other field is empty and the caller must return without reporting success. */
  cancelled?: true;
  /* … existing fields … */
}
```

- [ ] **Step 4: Resolve at the top of `openWorkspace`**

Insert immediately after the destructure at :317, **before** the `here`/`suffix`/brief work — nothing may be written or opened ahead of it:

```ts
  // Resolve the agent before anything is created. Under the three fixed settings this
  // is a plain read and the plan file carries no provider, so the target window keeps
  // reading the preference live at seed time — flipping the setting still affects
  // plans already on disk. Only `ask` pins a choice into the plan, because by then
  // there is no preference left for the target window to read.
  const setting = readAgentProviderSetting();
  let pinned: AgentProvider | undefined = req.provider;
  if (seedAgent && !pinned && setting === "ask") {
    const choice = await vscode.window.showQuickPick(
      hostProviders().map((p) => ({ label: providerLabel(p), provider: p })),
      { title: "Which agent?", placeHolder: "Pick the agent to start this session with", ignoreFocusOut: true },
    );
    // Dismissed: the user cancelled the launch itself. Nothing has been created yet,
    // so returning here leaves no window, no worktree, no brief and no plan behind.
    if (!choice) {
      return { mode, briefs: [], opened: [], remoteControl: false, provider: "claude-code", cancelled: true };
    }
    pinned = choice.provider;
  }
  const provider: AgentProvider = pinned ?? (setting === "ask" ? "claude-code" : setting);
  // Written into the plan only when `ask` produced it — see the comment above.
  const planProvider = setting === "ask" ? provider : undefined;
```

`mode` in the cancelled return is the destructured request mode; if `OpenResult.mode` is typed `WorkspaceMode` this compiles as-is.

- [ ] **Step 5: Wire it into Remote Control, the plan file, and the return**

- `:463` — `const remoteControl = !!req.remoteControl && seedAgent && matches.length === 1 && provider === "claude-code";`

  Extend the comment above it: Remote Control is Claude Code only, and under `ask` this is where a non-Claude pick drops it. Dropping is right where refusing would be wrong — the user made an interactive choice moments ago, and `OpenResult.remoteControl` already feeds `seededNote`, so the toast corrects itself with no new message.

- `:468` — `writePlanFile({ key: ticket.key, createdAt: Date.now(), seedAgent: true, remoteControl, provider: planProvider, matches });`

- `:510` — add `provider` to the returned object.

- [ ] **Step 6: Run tests, verify pass, mutation-check**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider && npx vitest run test/unit/engine/workspace.test.ts
```

Expected: PASS, including every pre-existing `openWorkspace` case. Mutation-check: change `planProvider` to always be `provider` and confirm "writes no provider to the plan" fails; then drop `&& provider === "claude-code"` from the Remote Control line and confirm "drops Remote Control" fails. Restore both.

- [ ] **Step 7: Run all four gates and commit**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider
npm run typecheck && npm test && npm run test:cov && npm run build
git add -A
git commit -m "feat(agent): resolve the ask picker inside openWorkspace

Resolves before anything is created, so dismissing the picker leaves no window,
worktree, brief or plan behind. Only ask pins the choice into the plan file;
fixed settings keep reading the preference live in the target window.

A non-Claude pick drops Remote Control rather than refusing the launch — the
existing seededNote copy reports it with no new message.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Wire the call sites

Seven `openWorkspace` callers: five honour the picker and its cancellation, two pin a provider to suppress it.

**Files:**
- Modify: `src/tasksView.ts:1300` (explore), `:1398` (notepad), `:1924` (take), `:2312` (batch — pins), and the post-launch `seededNote` calls at `:1320`, `:1426`, `:1945`, `:1906`, `:2698`
- Modify: `src/deckView.ts:1288` (Deck seed edge), `:1212`, `:2010`, `:2098` (post-launch copy)
- Modify: `src/engine/review/launch.ts:79`
- Modify: `src/engine/orchestrator/launch.ts:124` (pins)
- Test: `test/unit/tasksView.test.ts`, `test/unit/deckView.test.ts`, plus the review and orchestrator launch tests

**Interfaces:**
- Consumes: `OpenRequest.provider`, `OpenResult.provider`, `OpenResult.cancelled` (Task 5).
- Produces: no new exported names.

- [ ] **Step 1: Write the failing tests**

```ts
it("a batch asks once, not once per task", async () => {
  setConfig({ agentProvider: "ask", seedAgent: true });
  env.uriScheme = "cursor";
  window.showQuickPick.mockResolvedValue({ label: "Cursor", provider: "cursor" });
  await takeBatchOfThree();  // use this file's existing batch-launch helper
  const providerPicks = window.showQuickPick.mock.calls.filter(
    (c: unknown[]) => (c[1] as { title?: string })?.title === "Which agent?",
  );
  expect(providerPicks).toHaveLength(1);
  for (const call of openWorkspace.mock.calls) {
    expect(call[0].provider).toBe("cursor");
  }
});

it("an unattended orchestrator launch pins Claude Code and never prompts", async () => {
  setConfig({ agentProvider: "ask", seedAgent: true });
  await launchOrchestratorNode();  // use the existing helper in the orchestrator launch test
  expect(deps.openWorkspace).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "claude-code" }),
  );
  expect(window.showQuickPick).not.toHaveBeenCalled();
});

it("a cancelled picker reports nothing and shows no success toast", async () => {
  setConfig({ agentProvider: "ask", seedAgent: true });
  openWorkspace.mockResolvedValue({ cancelled: true, mode: "per-window", briefs: [], opened: [], remoteControl: false, provider: "claude-code" });
  await takeOneTask();  // existing helper
  expect(toast).not.toHaveBeenCalledWith("success", expect.anything());
});

it("the seeded toast names the agent that actually started", async () => {
  setConfig({ agentProvider: "ask", seedAgent: true });
  openWorkspace.mockResolvedValue({ mode: "per-window", briefs: [], opened: ["/repo"], remoteControl: false, provider: "cursor" });
  await takeOneTask();
  expect(toast).toHaveBeenCalledWith("success", expect.stringContaining("Cursor pre-seeded"));
});
```

Replace `takeBatchOfThree`, `takeOneTask`, `launchOrchestratorNode`, and `toast` with the real helpers and spies in those test files. Read them first.

- [ ] **Step 2: Run and verify they fail**

Expected: FAIL — the batch prompts three times, the orchestrator prompts, cancellation still toasts success, and the toast says "Claude Code".

- [ ] **Step 3: Pin the two non-interactive callers**

`src/tasksView.ts`, batch: resolve **once before the loop**, next to where the batch already resolves its other launch-wide decisions:

```ts
    // The loop is non-interactive by design (see the workspaceMode note below), so a
    // batch resolves the agent once for all N tasks rather than N times. Cancelling
    // here abandons the whole batch, which is what dismissing a launch-wide question
    // has to mean.
    const batchProvider = await this.resolveBatchProvider(cfg);
    if (!batchProvider) return;
```

with:

```ts
  /** The agent for a whole batch. Under a fixed setting this is a plain read and no
   *  picker appears; under `ask` it prompts exactly once. Returns undefined when the
   *  user dismisses it, at which point the batch must not launch anything. */
  private async resolveBatchProvider(cfg: AgentFlowConfig): Promise<AgentProvider | undefined> {
    if (cfg.agentProvider !== "ask") return cfg.agentProvider;
    const choice = await vscode.window.showQuickPick(
      hostProviders().map((p) => ({ label: providerLabel(p), provider: p })),
      { title: "Which agent?", placeHolder: "Pick the agent for every task in this batch", ignoreFocusOut: true },
    );
    return choice?.provider;
  }
```

Pass `provider: batchProvider` in the `openWorkspace` call at :2312. Use the **same** `title: "Which agent?"` string as Task 5 so the two pickers read identically.

`src/engine/orchestrator/launch.ts:124`: add `provider: "claude-code"` to the request, with:

```ts
      // Unattended: a rule fires with nobody watching, so it must never reach the
      // `ask` picker. Claude Code is the one agent every host can run.
      provider: "claude-code",
```

- [ ] **Step 4: Guard the five interactive callers**

After each `openWorkspace` call, before anything reads the result:

- `src/tasksView.ts:1300` (explore), `:1398` (notepad), `:1924` (take) — `if (result.cancelled) return;`
- `src/deckView.ts:1288` — that call does not bind its result. Change to `const result = await openWorkspace({...})` and, since the enclosing function returns a refusal string, `if (result.cancelled) return undefined;` — **read the function's actual return type and match it**; if it returns `string | undefined` where a string is a refusal message, `undefined` (no message) is right for a user-initiated cancel.
- `src/engine/review/launch.ts:79` — bind the result and, on `cancelled`, return the file's own "did not launch" shape. That function returns `{ ok: false, message }` on failure; a cancel is not a failure, so check whether the shape has a quiet variant. If it does not, return `{ ok: false, message: "" }` **only if** the caller suppresses empty messages — otherwise add a `cancelled` field to that result type and have the caller return silently. Read `launch.ts`'s result type and its caller before choosing.

- [ ] **Step 5: Switch post-launch copy to `result.provider`**

Every site that runs **after** `openWorkspace` returns must name the real agent:

- `src/tasksView.ts:1320`, `:1426`, `:1945` — `this.seededNote(cfg.seedAgent, result.remoteControl, result.provider, result.seededInPlace)`. `seededNote` already takes `provider: AgentProvider`, so only the argument changes.
- `src/tasksView.ts:1906`, `:2698` — read each in context; if it runs after the launch, use `result.provider`, otherwise leave the `plannedAgentLabel` call Task 4 put there.
- `src/deckView.ts:2010` — the review toast: `providerLabel(result.provider)`.
- `src/deckView.ts:2098` — `reviewProvenance(result.provider)`.
- `src/deckView.ts:1212` — this is webview payload built at render time, not after a launch. Leave it on `plannedAgentLabel`.

**`src/deckView.ts` is on the extension-host side, but confirm nothing you add here is imported by `src/webview/`** — run `npm run build`, which is the only gate that catches it.

- [ ] **Step 6: Run tests, verify pass, mutation-check**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider && npm test
```

Expected: PASS. Mutation-check: remove `provider: "claude-code"` from the orchestrator request and confirm the unattended test fails; remove one `if (result.cancelled) return;` and confirm the cancellation test fails. Restore both.

- [ ] **Step 7: Run all four gates and commit**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider
npm run typecheck && npm test && npm run test:cov && npm run build
git add -A
git commit -m "feat(agent): wire the ask picker through every launch path

Five interactive callers honour the picker and its cancellation; a batch
resolves once for all N tasks and an unattended orchestrator rule pins
claude-code so it never prompts.

Post-launch copy now reads OpenResult.provider, so it names the agent that
actually started rather than the setting's value.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Doctor under `ask`, and user-facing docs

**Files:**
- Modify: `src/engine/doctor.ts` (`DoctorInputs.agentProvider` → `AgentProviderSetting`; the `ask` union)
- Modify: `src/doctorView.ts:38`, `:97-99`
- Modify: `README.md`, `CHANGELOG.md`
- Test: `test/unit/engine/doctor.test.ts`, `test/unit/doctorView.test.ts`

**Interfaces:**
- Consumes: `chatChecks`, `DoctorInputs.chatCommand` (Task 3); `AgentProviderSetting`, `hostProviders` (Task 4).
- Produces: no new exported names.

- [ ] **Step 1: Write the failing test**

```ts
it("under ask, shows the rows for every agent this host can run", () => {
  env.uriScheme = "cursor";
  const groups = buildChecks(inputs({ agentProvider: "ask", chatCommand: { available: true } })).map((c) => c.group);
  expect(groups).toContain("Claude Code");
  expect(groups).toContain("Cursor");
  expect(groups).not.toContain("Copilot");
});

it("under ask in VS Code, shows Copilot's rows and not Cursor's", () => {
  env.uriScheme = "vscode";
  const groups = buildChecks(inputs({ agentProvider: "ask", chatCommand: { available: true } })).map((c) => c.group);
  expect(groups).toContain("Copilot");
  expect(groups).not.toContain("Cursor");
});
```

- [ ] **Step 2: Run and verify it fails**

Expected: FAIL — `"ask"` is not `"claude-code"`, so `agentChecks` sends it to `chatChecks` with `"ask"` as the provider, producing a group named after a non-agent.

- [ ] **Step 3: Implement the union**

```ts
/** Which rows appear. Under a fixed agent, only that agent's rows. Under `ask` the
 *  answer is not known until launch time, so every agent this host can run gets its
 *  rows — a user about to be asked needs all of the answers, not one of them. */
function agentChecks(i: DoctorInputs): Check[] {
  if (i.agentProvider === "claude-code") return claudeChecks(i);
  if (i.agentProvider !== "ask") return [...chatChecks(i, i.agentProvider), ...claudeSessionChecks(i)];
  const others = i.hostProviders.filter((p): p is Exclude<AgentProvider, "claude-code"> => p !== "claude-code");
  return [...claudeChecks(i), ...others.flatMap((p) => chatChecks(i, p)), ...claudeSessionChecks(i)];
}
```

`doctor.ts` is deliberately free of `vscode` imports, so it must not call `hostProviders()` itself. Add `hostProviders: AgentProvider[]` to `DoctorInputs` and have `doctorView.ts` supply it — the same pattern the file already uses for every other probed input. Update every existing `DoctorInputs` construction in the tests to include it.

In `doctorView.ts:97-99`:

```ts
    agentProvider: cfg.agentProvider,
    hostProviders: hostProviders(),
    // Probed whenever a chat-panel agent could be the one that runs — which under
    // `ask` is any host that offers one.
    chatCommand: cfg.agentProvider !== "claude-code" ? await d.chatCommand() : { available: false },
```

Widen the `:38` config slice type to `AgentProviderSetting`.

- [ ] **Step 4: Run tests and verify they pass**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider && npx vitest run test/unit/engine/doctor.test.ts test/unit/doctorView.test.ts
```

- [ ] **Step 5: Mutation-check**

Change the `ask` branch to `return claudeChecks(i)` and confirm "under ask, shows the rows for every agent" fails. Restore.

- [ ] **Step 6: Update the docs**

`README.md` — find the section documenting `agentFlow.agentProvider` (`grep -n "agentProvider" README.md`) and extend its table with `cursor` and `ask`. State: `copilot` is VS Code only, `cursor` is Cursor only, each falls back to Claude Code in the other editor; `ask` prompts per launch; a batch asks once; Orchestrator rules always use Claude Code; and neither Copilot nor Cursor sessions appear as live agents on the Deck. Also update the extension `description` in `package.json:4`, which currently reads "…already briefed — Claude Code, or GitHub Copilot."

`CHANGELOG.md` — add an entry under a new Unreleased heading, matching the file's existing format:

```markdown
### Added
- `agentFlow.agentProvider` accepts `cursor` — seed a task straight into Cursor's
  composer, or run `cursor-agent` in a terminal. Cursor only; falls back to Claude
  Code in other editors.
- `agentFlow.agentProvider` accepts `ask` — pick the agent per launch instead of
  fixing one. A batch asks once for all its tasks; Orchestrator rules run unattended
  and always use Claude Code.
```

Match the file's existing heading style and version placement — read the top of `CHANGELOG.md` first rather than assuming an `## [Unreleased]` heading exists.

- [ ] **Step 7: Run all four gates and commit**

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider
npm run typecheck && npm test && npm run test:cov && npm run build
git add -A
git commit -m "feat(doctor): show every runnable agent's rows under ask, and document the new values

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Verify in a real Cursor dev host

**This task cannot be completed by a subagent** — it needs a human at a running editor. Its output is a findings note, and possibly a follow-up fix.

Everything in Tasks 1-7 rests on reading Cursor's shipped bundle, not on running it. The Copilot path shipped in 0.10.0 with the same gap and its `bootMs` is still marked UNVERIFIED. Do not let this feature ship with two unverified agents.

- [ ] **Step 1: Launch the dev host in Cursor**

Note: the Cursor CLI silently drops `--extensionDevelopmentPath`; only VS Code's `code` CLI honours it. To test *in Cursor*, build and install the VSIX instead:

```bash
cd /Users/oznasi/dev/agent-flow-cursor-provider && npm run package
cursor --install-extension /Users/oznasi/dev/agent-flow-cursor-provider/*.vsix --force
```

Then fully quit and reopen Cursor.

- [ ] **Step 2: Verify the extension surface**

Set `agentFlow.agentProvider: "cursor"` and `agentFlow.agentSurface: "extension"`. Take a task. Confirm: a composer tab opens; the prompt text is in the input; **it has not been submitted**; pressing Enter starts it.

- [ ] **Step 3: Verify batch tabs**

Take three tasks as a batch. Confirm three composer tabs open, each with its own task's prompt — the behaviour Copilot cannot provide and the reason `seedChatPanel` forks on `multi`.

- [ ] **Step 4: Measure `bootMs` for the terminal surface**

Set `agentSurface: "terminal"`. If `cursor-agent` is not installed, install it first (`curl https://cursor.com/install -fsS | bash`) and note in the findings that a user without it gets `command not found` with the prompt still pre-typed. Take a task and time how long the TUI needs before it accepts pasted input. If 2000ms is wrong, correct the `CLI` row and drop the UNVERIFIED tag.

- [ ] **Step 5: Verify the `ask` picker**

Set `agentProvider: "ask"`. Confirm: the picker lists exactly "Claude Code" and "Cursor" (no Copilot); picking Cursor seeds a composer; dismissing it opens no window, creates no worktree, and writes no brief; and a batch asks once.

- [ ] **Step 6: Record the findings and commit**

Append a "Verification" section to the spec at `docs/superpowers/specs/2026-08-19-cursor-agent-provider-design.md` recording what was confirmed, the measured `bootMs`, and anything that behaved differently from the bundle reading. Commit it. If something is broken, fix it with a test first, following the same TDD cycle as every other task.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: settings/types → 1, 4; host detection → 1, 4; plan-file travel → 4, 5; seeding Cursor → 2; Remote Control → 2 (fixed), 5 (ask); copy → 4 (pre-launch), 6 (post-launch); doctor → 3, 7; telemetry → 1, 4; testing → every task; the out-of-scope verification gap → 8.

**Known soft spots, called out rather than hidden.** Three steps tell the implementer to *read the existing code before editing* rather than giving exact replacement text: Task 3 Step 3 (whether `doctor.ts` may import from `config.ts`), Task 6 Step 4 (the deckView and review-launch cancel shapes), and Task 6 Step 5 (which `providerLabel` sites are pre- vs post-launch). Those depend on details I did not fully read, and a confidently wrong code block would be worse than an explicit instruction to look. Every other step contains the actual code.

**Type consistency.** `AgentProvider` / `AgentProviderSetting`, `hostProviders`, `readAgentProviderSetting`, `seedProvider`, `seedChatPanel`, `chatCommand`, `plannedAgentLabel`, `OpenRequest.provider`, `OpenResult.provider`, `OpenResult.cancelled` are each defined in exactly one task and used consistently after. `readAgentProvider` is introduced in Task 1 and deliberately deleted in Task 4 — that rename is called out in Task 4 Step 3.
