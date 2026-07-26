# Remote Control setting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tri-state `agentFlow.remoteControl` setting (`off` / `on` / `ask`, default `off`) that offers Claude Code's Remote Control for the session Agent Flow just opened, by seeding the `/remote-control <KEY>` slash command and putting the task prompt on the clipboard.

**Architecture:** Seeding happens in the *newly opened* window, not the launching one — `openWorkspace` writes a plan file to `~/.agentflow/plans` and the new window reads it during activation. So the decision travels in that plan file. `openWorkspace` withholds Remote Control unless the launch produces exactly one window, because a single clipboard cannot serve several. The parallel batch path never offers it.

**Tech Stack:** TypeScript, VS Code extension API, Vitest with a hand-written `vscode` mock and a mocked `fs`.

## Global Constraints

- The seeded buffer is exactly `` `/remote-control ${key}` `` — the Jira key names the remote session.
- `/remote-control` cannot share a submission with the task prompt: it is `type: "local-jsx"`, and Claude Code only stacks `type: "prompt"` commands ahead of a prompt. The task prompt must travel on the clipboard.
- Remote Control applies only when a launch opens exactly **one** window. More than one and it is withheld, because the clipboard would hold only the last task's prompt.
- Parallel batch launches never offer Remote Control, and never show the picker.
- Dismissing the `ask` picker means "no", not "cancel" — the launch proceeds.
- Nothing global is written. No Claude settings file is touched.
- Coverage thresholds in `vitest.config.ts` (90% statements/lines, 85% branches/functions) must still pass.

---

### Task 1: The `agentFlow.remoteControl` setting

**Files:**
- Modify: `package.json` (contributes.configuration.properties, after `agentFlow.worktree`)
- Modify: `src/config.ts` — the `AgentFlowConfig` interface and `getConfig()`
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `AgentFlowConfig.remoteControl: "off" | "on" | "ask"`, resolved by `getConfig()`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/config.test.ts`:

```ts
describe("getConfig — remoteControl", () => {
  it("defaults to off", () => {
    expect(getConfig().remoteControl).toBe("off");
  });

  it("honors on and ask", () => {
    setConfig({ remoteControl: "on" });
    expect(getConfig().remoteControl).toBe("on");
    setConfig({ remoteControl: "ask" });
    expect(getConfig().remoteControl).toBe("ask");
  });

  it("falls back to off for a value outside the enum", () => {
    setConfig({ remoteControl: "true" });
    expect(getConfig().remoteControl).toBe("off");
  });

  it("falls back to off for an empty string", () => {
    setConfig({ remoteControl: "" });
    expect(getConfig().remoteControl).toBe("off");
  });
});
```

Add to the existing `describe("package.json ⇄ config constants")` block:

```ts
  it("declares remoteControl with a default of off and the three-value enum", () => {
    const p = props["agentFlow.remoteControl"] as { default?: unknown; enum?: unknown };
    expect(p.default).toBe("off");
    expect(p.enum).toEqual(["off", "on", "ask"]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — `remoteControl` is `undefined`, and `props["agentFlow.remoteControl"]` is `undefined`.

- [ ] **Step 3: Declare the setting in `package.json`**

Insert immediately after the `"agentFlow.worktree"` property block:

```json
        "agentFlow.remoteControl": {
          "type": "string",
          "enum": ["off", "on", "ask"],
          "enumDescriptions": [
            "Never offer Remote Control",
            "Offer Remote Control for every session Agent Flow launches",
            "Ask once each time you launch"
          ],
          "default": "off",
          "markdownDescription": "Offer Claude Code's **Remote Control** for the session Agent Flow opens, so you can drive it from claude.ai or the Claude mobile app. The panel is pre-filled with `/remote-control <KEY>` and your task prompt goes to the clipboard: press Enter to connect, then paste to start the task. Skipped for launches that open more than one window, because a single clipboard can't serve them."
        },
```

- [ ] **Step 4: Add the field to `AgentFlowConfig`**

In `src/config.ts`, add to the interface just after the `worktree` field:

```ts
  // Offer Claude Code's Remote Control for the session we open: the panel is seeded
  // with /remote-control <KEY> and the task prompt goes to the clipboard.
  remoteControl: "off" | "on" | "ask";
```

- [ ] **Step 5: Resolve it in `getConfig`**

Add just after the `worktree:` line. Validate against the enum — a stale value like `"true"` must land on `off`, not flow through untyped:

```ts
    remoteControl: (() => {
      const v = c.get<string>("remoteControl");
      return v === "on" || v === "ask" ? v : "off";
    })(),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/unit/config.test.ts`
Expected: PASS

- [ ] **Step 7: Fix the type error in the tasksView test fixture**

`test/unit/tasksView.test.ts` builds a full `AgentFlowConfig` literal named `CFG`; the new required field breaks type-checking. Add to `CFG`, after the `worktree` line:

```ts
  remoteControl: "off" as const,
```

- [ ] **Step 8: Verify the whole suite and the type-check**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add package.json src/config.ts test/unit/config.test.ts test/unit/tasksView.test.ts
git commit -m "feat(remote-control): add the agentFlow.remoteControl setting"
```

---

### Task 2: Carry the decision to the window that seeds

**Files:**
- Modify: `src/engine/workspace.ts` — `OpenRequest`, `OpenResult`, `PlanFile`, and `openWorkspace`
- Test: `test/unit/engine/workspace.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (this is plumbing)
- Produces:
  - `OpenRequest.remoteControl?: boolean` — what the launch asked for
  - `OpenResult.remoteControl: boolean` — what actually applied
  - `PlanFile.remoteControl?: boolean` — read by the new window in Task 3

**Context for the implementer:** the launching window does not seed. `openWorkspace` writes a plan file to `~/.agentflow/plans/<key>-<ts>.json`; the newly opened window reads it during activation (`maybeSeedAgent`) and seeds from there. So the flag has to be persisted in that file. The single-window guard lives here because this is where `matches` — one per window to be seeded — is known.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/workspace.test.ts`:

```ts
describe("openWorkspace — remote control", () => {
  const planOf = () => {
    const w = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    return JSON.parse(String(w![1]));
  };

  it("records remoteControl on the plan for a single-window launch", async () => {
    const result = await openWorkspace(baseReq({ remoteControl: true }));
    expect(result.remoteControl).toBe(true);
    expect(planOf().remoteControl).toBe(true);
  });

  it("records false when the launch did not ask", async () => {
    const result = await openWorkspace(baseReq());
    expect(result.remoteControl).toBe(false);
    expect(planOf().remoteControl).toBe(false);
  });

  it("withholds it when the launch opens more than one window", async () => {
    // per-window across two repos → two matches → two windows, one clipboard
    const result = await openWorkspace(baseReq({ mode: "per-window", remoteControl: true }));
    expect(planOf().matches).toHaveLength(2);
    expect(result.remoteControl).toBe(false);
    expect(planOf().remoteControl).toBe(false);
  });

  it("allows it for a per-window launch of a single repo", async () => {
    const result = await openWorkspace(
      baseReq({ mode: "per-window", services: mkRepos(["account-service"]), remoteControl: true }),
    );
    expect(planOf().matches).toHaveLength(1);
    expect(result.remoteControl).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "remote control"`
Expected: FAIL — `remoteControl` is not a known property of `OpenRequest`, and `result.remoteControl` is `undefined`.

- [ ] **Step 3: Extend the three types**

In `src/engine/workspace.ts`, add to `OpenRequest` (after `existingFolder`):

```ts
  remoteControl?: boolean; // offer Claude Code's Remote Control in the opened session
```

Add to `OpenResult` (after `unaddedRepos`):

```ts
  remoteControl: boolean; // whether Remote Control actually applies (see the single-window guard)
```

Add to `PlanFile` (after `seedAgent`):

```ts
  remoteControl?: boolean;
```

- [ ] **Step 4: Apply the single-window guard and persist it**

In `openWorkspace`, immediately after the `if / else if / else` chain that fills `matches` and before the `// 3 — durable writes` comment:

```ts
  // One clipboard, one window. A launch that opens several windows would leave every
  // window but the last pasting another task's brief, so withhold it entirely.
  const remoteControl = !!req.remoteControl && matches.length === 1;
```

Change the plan write to carry it:

```ts
  if (seedAgent) {
    writePlanFile({ key: ticket.key, createdAt: Date.now(), seedAgent: true, remoteControl, matches });
  }
```

And add it to the returned result:

```ts
  return { mode: effMode, workspaceFile, briefs, opened, mergedRepos, mergeFailed, unaddedRepos, remoteControl };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/workspace.test.ts`
Expected: PASS

- [ ] **Step 6: Fix the type error in the tasksView test fixture**

`test/unit/tasksView.test.ts` stubs `openWorkspace`'s resolved value in `beforeEach` and in at least one `mockImplementationOnce`; `OpenResult` now requires `remoteControl`. Add `remoteControl: false` to every `OpenResult` literal in that file — the `beforeEach` stub is:

```ts
  vi.mocked(openWorkspace).mockResolvedValue({
    mode: "per-window",
    workspaceFile: undefined,
    briefs: [],
    opened: ["/repos/account-service"],
    remoteControl: false,
  });
```

Run `npx tsc --noEmit` and fix any other literal it flags.

- [ ] **Step 7: Verify the suite and the type-check**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/engine/workspace.ts test/unit/engine/workspace.test.ts test/unit/tasksView.test.ts
git commit -m "feat(remote-control): carry the decision to the seeding window, single-window only"
```

---

### Task 3: Seed the slash command and the clipboard

**Files:**
- Modify: `src/engine/workspace.ts` — `maybeSeedAgent` and `seedClaudeCode`
- Test: `test/unit/engine/workspace.test.ts`

**Interfaces:**
- Consumes: `PlanFile.remoteControl` from Task 2
- Produces: nothing consumed by later tasks (internal to the seeding path)

**Context for the implementer:** `seedClaudeCode` has a three-tier delivery chain — the verified `claude-vscode.primaryEditor.open` command, then the URI handler, then the clipboard as a last resort. Tiers 1 and 2 seed the buffer, so they seed the slash command instead of the prompt. Tier 3 already uses the clipboard *for the prompt*, which is the same slot Remote Control needs — so if delivery falls that far, Remote Control is dropped and the existing behavior stands unchanged. That is the right trade: the task prompt matters more.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/workspace.test.ts`:

```ts
describe("seedClaudeCode — remote control", () => {
  const seedPlan = (over: Record<string, unknown> = {}) => {
    workspace.workspaceFile = { scheme: "file", fsPath: "/ws/ASM-1.code-workspace" };
    readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
    readFileSync.mockReturnValue(
      JSON.stringify({
        key: "ASM-1",
        createdAt: Date.now(),
        seedAgent: true,
        matches: [{ matchPath: "/ws/ASM-1.code-workspace", prompt: "do it" }],
        ...over,
      }),
    );
    commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
  };

  it("seeds the slash command and puts the task prompt on the clipboard", async () => {
    seedPlan({ remoteControl: true });
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(commands.executeCommand).toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "/remote-control ASM-1");
    expect(env.clipboard.writeText).toHaveBeenCalledWith("do it");
    expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("Remote Control"));
  });

  it("seeds the prompt and leaves the clipboard alone when not requested", async () => {
    seedPlan({ remoteControl: false });
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(commands.executeCommand).toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    expect(env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("treats an absent remoteControl flag as off", async () => {
    seedPlan();
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(commands.executeCommand).toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    expect(env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("sends the slash command through the URI handler too", async () => {
    vi.useFakeTimers();
    try {
      seedPlan({ remoteControl: true });
      commands.getCommands.mockResolvedValue([]); // command never registers
      env.openExternal.mockResolvedValue(true);
      const { context } = fakeContext();

      const p = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await p;

      const uri = String(vi.mocked(env.openExternal).mock.calls[0][0]);
      expect(uri).toContain(encodeURIComponent("/remote-control ASM-1"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops Remote Control and keeps the task prompt when it falls back to the clipboard", async () => {
    vi.useFakeTimers();
    try {
      seedPlan({ remoteControl: true });
      commands.getCommands.mockResolvedValue([]);
      env.openExternal.mockResolvedValue(false);
      const { context } = fakeContext();

      const p = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await p;

      // the prompt — not the slash command — is what the user is told to paste
      expect(env.clipboard.writeText).toHaveBeenLastCalledWith("do it");
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "seedClaudeCode — remote control"`
Expected: FAIL — the command is still seeded with `"do it"` and the clipboard is never written.

- [ ] **Step 3: Pass the flag through `maybeSeedAgent`**

In `src/engine/workspace.ts`, change the seeding call:

```ts
    await seedClaudeCode(match.prompt, plan.key, log, plan.remoteControl === true);
```

- [ ] **Step 4: Teach `seedClaudeCode` the Remote Control path**

Replace the signature and the head of the function:

```ts
/** Open the Claude Code panel with the prompt pre-filled. Polls for the verified
 * command (handles the activation race), then the URI handler, then clipboard.
 *
 * With `remoteControl`, the panel gets `/remote-control <key>` instead and the task
 * prompt travels on the clipboard — the slash command is `local-jsx`, so Claude Code
 * cannot stack it ahead of a prompt in one submission, and the panel takes a single
 * buffer with a single Enter. */
async function seedClaudeCode(
  prompt: string,
  key: string,
  log: (m: string) => void,
  remoteControl = false,
): Promise<void> {
  const seedText = remoteControl ? `/remote-control ${key}` : prompt;
  // Write it before the panel opens so it's already there to paste.
  if (remoteControl) await vscode.env.clipboard.writeText(prompt);

  const announceRemoteControl = () => {
    if (!remoteControl) return;
    const paste = process.platform === "darwin" ? "⌘V" : "Ctrl+V";
    vscode.window.showInformationMessage(
      `Agent Flow: ${key} — press Enter to connect Remote Control, then ${paste} + Enter to start the task (it's on your clipboard).`,
    );
  };
```

In tier 1, seed `seedText` and announce:

```ts
      if (cmds.includes(CLAUDE_OPEN_CMD)) {
        await vscode.commands.executeCommand(CLAUDE_OPEN_CMD, undefined, seedText);
        log(`seed ${key}: opened Claude Code via command (attempt ${attempt})${remoteControl ? " + Remote Control" : ""}`);
        announceRemoteControl();
        return;
      }
```

In tier 2, seed `seedText` and announce:

```ts
    const uri = `${vscode.env.uriScheme}://Anthropic.claude-code/open?prompt=${encodeURIComponent(seedText)}`;
    if (await vscode.env.openExternal(vscode.Uri.parse(uri))) {
      log(`seed ${key}: opened via URI${remoteControl ? " + Remote Control" : ""}`);
      announceRemoteControl();
      return;
    }
```

Tier 3 keeps its existing body — it already writes `prompt` to the clipboard and tells the
user to paste it. Add one line above it so the drop is visible in the log:

```ts
  if (remoteControl) log(`seed ${key}: Remote Control dropped — the clipboard is needed for the prompt`);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/workspace.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/engine/workspace.ts test/unit/engine/workspace.test.ts
git commit -m "feat(remote-control): seed /remote-control and put the task prompt on the clipboard"
```

---

### Task 4: Resolve it per launch

**Files:**
- Modify: `src/tasksView.ts` — a new `resolveRemoteControl` method, `launch()`, `explore()`, `takeBatch()`
- Test: `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `AgentFlowConfig.remoteControl` (Task 1), `OpenRequest.remoteControl` / `OpenResult.remoteControl` (Task 2)
- Produces: nothing consumed by later tasks

**Context for the implementer:** `launch()` serves both Take and Address PR, so wiring it there covers both. `takeBatch()` deliberately does *not* offer Remote Control — it opens one window per task and they would all share one clipboard.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/tasksView.test.ts`:

```ts
describe("remote control", () => {
  const lastOpen = () =>
    vi.mocked(openWorkspace).mock.calls[vi.mocked(openWorkspace).mock.calls.length - 1][0];

  it("passes false and never prompts when the setting is off", async () => {
    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);
    expect(lastOpen().remoteControl).toBe(false);
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it("passes true without prompting when the setting is on", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "on" });
    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);
    expect(lastOpen().remoteControl).toBe(true);
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it("ask: choosing Enable passes true", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ yes: true } as never);
    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);
    expect(lastOpen().remoteControl).toBe(true);
  });

  it("ask: dismissing passes false and the launch still proceeds", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined); // dismissed
    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(lastOpen().remoteControl).toBe(false);
  });

  it("asks once per launch, not once per repo", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ yes: true } as never);
    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service", "centaur"]);
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
  });

  it("says so when a multi-window launch withheld it", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "on" });
    vi.mocked(openWorkspace).mockResolvedValue({
      mode: "per-window",
      workspaceFile: undefined,
      briefs: [],
      opened: ["/a", "/b"],
      remoteControl: false, // withheld by the single-window guard
    });
    const { provider, posted } = setup();
    await provider.takeTask("ASM-1", ["account-service", "centaur"]);
    const toast = posted().find((m) => m.type === "toast") as { message: string };
    expect(toast.message).toContain("Remote Control skipped");
  });

  it("explore resolves it once", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "on", exploreMode: "knowledge" });
    vi.mocked(window.showInputBox).mockResolvedValueOnce("the retry path" as never);
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(lastOpen().remoteControl).toBe(true);
  });

  it("takeBatch never offers it, even with the setting on", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "on" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
    const { provider, posted } = setup();
    await provider.takeBatch(["ASM-1", "ASM-2"], "api");
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(vi.mocked(openWorkspace).mock.calls.every((c) => !c[0].remoteControl)).toBe(true);
    const toast = posted().find((m) => m.type === "toast") as { message: string };
    expect(toast.message).toContain("Remote Control skipped");
    vi.mocked(createWorktrees).mockImplementation((s) => s);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts -t "remote control"`
Expected: FAIL — `remoteControl` is never passed to `openWorkspace` (it is `undefined`, not `false`).

- [ ] **Step 3: Add the resolver**

In `src/tasksView.ts`, add this private method just above `private async launch(`:

```ts
  /** Whether this launch offers Claude Code's Remote Control. Resolved once per launch
   * action. Dismissing the picker means "no", not "cancel": by the time this runs,
   * worktrees and briefs already exist, and abandoning the launch over an optional
   * toggle is the worse failure. */
  private async resolveRemoteControl(cfg: AgentFlowConfig): Promise<boolean> {
    if (cfg.remoteControl === "off") return false;
    if (cfg.remoteControl === "on") return true;
    const p = await vscode.window.showQuickPick(
      [
        {
          label: "$(radio-tower) Enable Remote Control",
          detail: "Connect first, then paste the task prompt to start",
          yes: true,
        },
        { label: "$(circle-slash) Local only", detail: "Seed the task prompt as usual", yes: false },
      ],
      { title: "Enable Remote Control for this session?", ignoreFocusOut: true },
    );
    return p?.yes === true;
  }

  /** Toast fragment for a launch that asked for Remote Control and didn't get it —
   * `openWorkspace` withholds it when the launch opens more than one window. Without
   * this the user waits for a `/remote-control` prompt that never arrives. */
  private remoteControlNote(wanted: boolean, applied: boolean): string {
    return wanted && !applied ? " Remote Control skipped — it needs a single window." : "";
  }
```

- [ ] **Step 4: Wire `launch()` (covers Take and Address PR)**

After `if (!args) return;` and before `const planMd = this.buildBrief(detail);`:

```ts
    const wantRemoteControl = await this.resolveRemoteControl(cfg);
```

Add to the `openWorkspace({ ... })` call:

```ts
      remoteControl: wantRemoteControl,
```

Then, above the toast block:

```ts
    const rcNote = this.remoteControlNote(wantRemoteControl, result.remoteControl);
```

and append `${rcNote}` to both the `mergeFailed` and success toast messages.

- [ ] **Step 5: Wire `explore()`**

After its `if (!args) return;` and before the `const slug = ...` line:

```ts
    const wantRemoteControl = await this.resolveRemoteControl(cfg);
```

Add `remoteControl: wantRemoteControl,` to its `openWorkspace({ ... })` call, and append
the same note to its success toast using the shared helper:

```ts
    const rcNote = this.remoteControlNote(wantRemoteControl, result.remoteControl);
    this.toast("success", `Opened ${where} to explore. Brief seeded in each repo.${seeded}${rcNote}`);
```

- [ ] **Step 6: Make `takeBatch()` decline it explicitly**

`takeBatch` opens one window per task, all sharing one clipboard, so it never offers
Remote Control and never shows the picker. After `if (!promptMode) return;`:

```ts
    // One clipboard can't serve a window per task — don't offer Remote Control here.
    const rcSkipped = cfg.remoteControl !== "off";
    if (rcSkipped) this.log("takeBatch: Remote Control skipped — one clipboard, several windows");
```

Append to the summary toasts:

```ts
    const rcNote = rcSkipped ? " Remote Control skipped — one clipboard can't serve several windows." : "";
```

Use `${rcNote}` in both the failure and success branches of the final toast.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: PASS

- [ ] **Step 8: Verify the suite and the type-check**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(remote-control): resolve it once per launch, decline it for batches"
```

---

### Task 5: Document it

**Files:**
- Modify: `README.md` (settings table and the paragraph below it)
- Modify: `CHANGELOG.md` (the `## [Unreleased]` section)

**Interfaces:**
- Consumes: the finished feature
- Produces: nothing

- [ ] **Step 1: Add the settings-table row**

In `README.md`, after the `agentFlow.prReviewAutoFix` row:

```markdown
| `agentFlow.remoteControl` | `off` | Offer Claude Code's **Remote Control** for the session Agent Flow opens (`off` / `on` / `ask`), so you can drive it from claude.ai or the Claude mobile app. |
```

- [ ] **Step 2: Explain the two-step flow**

Add this immediately after the "Plus `agentFlow.workspaceMode`, …" paragraph:

```markdown
**Remote Control.** With `agentFlow.remoteControl` set to `on` or `ask`, the Claude Code
panel is pre-filled with `/remote-control <KEY>` instead of the task prompt, and the task
prompt goes to your clipboard: press Enter to connect the session, then paste and press
Enter to start the task. The Jira key names the remote session, so several are tellable
apart on claude.ai. It takes two steps because Claude Code can't run a slash command and a
prompt in one submission. Launches that open more than one window — a parallel batch, or a
per-window Take across several repos — keep the normal single-Enter seeding and say so,
since one clipboard can't carry a different prompt for each window.
```

- [ ] **Step 3: Add the CHANGELOG entry**

Under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
### Added

- **Remote Control for the session you just opened.** A new `agentFlow.remoteControl`
  setting (`off` / `on` / `ask`, default `off`) pre-fills the Claude Code panel with
  `/remote-control <KEY>` and puts the task prompt on your clipboard, so a task taken from
  the pool can be driven from claude.ai or the Claude mobile app: Enter to connect, paste
  and Enter to start. Nothing global is written — it applies only to the session being
  opened. Launches that open more than one window (a parallel batch, or a per-window Take
  across several repos) keep the normal seeding and say that Remote Control was skipped,
  because one clipboard can't carry a different task prompt for each window.
```

- [ ] **Step 4: Final verification**

Run: `npx tsc --noEmit && npx vitest run --coverage`
Expected: PASS, coverage still above the configured thresholds.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(remote-control): document the setting and the two-step flow"
```

---

## Manual verification

Do this in a real editor window after Task 5 — the unit tests mock the panel, so nothing
above proves the bridge actually connects.

1. Set `agentFlow.remoteControl` to `ask`, take a task, choose **Enable Remote Control**.
   The panel should show `/remote-control ASM-1234`. Press Enter — the session should
   connect and appear on claude.ai. Paste and press Enter — the task should start.
2. Set it to `off` and take a task: the task prompt is seeded exactly as before, one Enter.
3. With the setting `on`, take a task spanning two repos in per-window mode. Both windows
   seed their task prompt normally, and the toast says Remote Control was skipped.
4. With the setting `on`, launch three tasks in parallel. No picker, all three seed
   normally, and the toast notes the skip.

## Release note

Per the repo's release convention, the version bump and a fresh `.vsix` build happen when
this branch merges to `main` — not on the branch itself.
