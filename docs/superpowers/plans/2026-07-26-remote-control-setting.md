# Remote Control setting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tri-state `agentFlow.remoteControl` setting (`off` / `on` / `ask`, default `off`) that starts Claude Code's Remote Control bridge for the sessions Agent Flow launches.

**Architecture:** Claude Code's VS Code panel has no per-launch flag; it reads a boolean settings key, `remoteControlAtStartup`, from the global Claude settings file. A new `src/engine/remoteControl.ts` reads and writes that key with `jsonc-parser` (preserving the user's formatting), and records in `globalState` whether Agent Flow was the one that set it — plus the value that was there before — so `off` restores the file as it was found and never stomps a hand-set value. Three launch paths in `tasksView.ts` call one resolver, once per launch action.

**Tech Stack:** TypeScript, VS Code extension API, `jsonc-parser` (already a dependency), Vitest with a hand-written `vscode` mock.

## Global Constraints

- The Claude settings key is exactly `remoteControlAtStartup` (boolean).
- The settings file is `$CLAUDE_CONFIG_DIR/settings.json`, falling back to `~/.claude/settings.json`. Never hardcode `~/.claude`.
- All file writes go through `jsonc-parser` `modify`/`applyEdits` — never `JSON.parse` + `JSON.stringify`, which would reformat the user's file.
- Every function in `src/engine/remoteControl.ts` is best-effort: it returns a failure value, never throws. Callers must never break a launch over it.
- `src/engine/remoteControl.ts` must not import `vscode` — it is unit-tested directly against temp directories.
- The `ask` picker is shown **once per launch action**, never once per task in a batch.
- Dismissing the `ask` picker means "no", not "cancel" — the launch proceeds.
- Coverage thresholds in `vitest.config.ts` (90% statements/lines, 85% branches/functions) must still pass.

---

### Task 1: The `agentFlow.remoteControl` setting

**Files:**
- Modify: `package.json` (contributes.configuration.properties, after `agentFlow.worktree`)
- Modify: `src/config.ts:79-106` (the `AgentFlowConfig` interface) and `src/config.ts:142-177` (`getConfig`)
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
            "Never enable Remote Control",
            "Every session Agent Flow launches starts with Remote Control on",
            "Ask once each time you launch"
          ],
          "default": "off",
          "markdownDescription": "Start Claude Code's **Remote Control** bridge for sessions Agent Flow launches, so you can drive them from claude.ai or the Claude mobile app. This works by setting `remoteControlAtStartup` in your **global** Claude settings — while it is on, Claude sessions you start yourself are remote-controlled too. Agent Flow restores the previous value when you set this back to `off`."
        },
```

- [ ] **Step 4: Add the field to `AgentFlowConfig`**

In `src/config.ts`, add to the interface just after the `worktree` field:

```ts
  // Start Claude Code's Remote Control bridge for launched sessions. Enabling it
  // writes remoteControlAtStartup to the GLOBAL Claude settings file, so it also
  // covers sessions the user starts themselves while it is on.
  remoteControl: "off" | "on" | "ask";
```

- [ ] **Step 5: Resolve it in `getConfig`**

In `src/config.ts`, add just after the `worktree:` line. Validate against the enum rather than using a bare `||` — a stale value like `"true"` must land on `off`:

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

- [ ] **Step 8: Verify the whole suite and the type-check still pass**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add package.json src/config.ts test/unit/config.test.ts test/unit/tasksView.test.ts
git commit -m "feat(remote-control): add the agentFlow.remoteControl setting"
```

---

### Task 2: Read and write the Claude settings key

**Files:**
- Create: `src/engine/remoteControl.ts`
- Test: `test/unit/engine/remoteControl.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (independent module)
- Produces:
  - `claudeSettingsPath(): string`
  - `readRemoteControlAtStartup(file: string): boolean | undefined`
  - `writeRemoteControlAtStartup(file: string, value: boolean | undefined): boolean`

**Context for the implementer:** `jsonc-parser` is already a dependency — `src/engine/workspace.ts:266` uses the same `modify`/`applyEdits` pattern to edit `.code-workspace` files without reformatting them. Passing `undefined` as the value to `modify` **removes** the key; that is the documented behavior and how the revert path deletes it.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/engine/remoteControl.test.ts`. Note this file uses **real temp directories** (like `test/unit/engine/runs.test.ts`), not a mocked `fs`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  claudeSettingsPath,
  readRemoteControlAtStartup,
  writeRemoteControlAtStartup,
} from "../../../src/engine/remoteControl";

describe("claudeSettingsPath", () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  });

  it("falls back to ~/.claude/settings.json", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeSettingsPath()).toBe(path.join(os.homedir(), ".claude", "settings.json"));
  });

  it("honors CLAUDE_CONFIG_DIR", () => {
    process.env.CLAUDE_CONFIG_DIR = "/custom/cfg";
    expect(claudeSettingsPath()).toBe("/custom/cfg/settings.json");
  });

  it("ignores a whitespace-only CLAUDE_CONFIG_DIR", () => {
    process.env.CLAUDE_CONFIG_DIR = "   ";
    expect(claudeSettingsPath()).toBe(path.join(os.homedir(), ".claude", "settings.json"));
  });
});

describe("remoteControlAtStartup read/write", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-rc-"));
    file = path.join(dir, "settings.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reads true, false, and an absent key", () => {
    fs.writeFileSync(file, `{"remoteControlAtStartup": true}`);
    expect(readRemoteControlAtStartup(file)).toBe(true);
    fs.writeFileSync(file, `{"remoteControlAtStartup": false}`);
    expect(readRemoteControlAtStartup(file)).toBe(false);
    fs.writeFileSync(file, `{"other": 1}`);
    expect(readRemoteControlAtStartup(file)).toBeUndefined();
  });

  it("reads undefined for a missing file", () => {
    expect(readRemoteControlAtStartup(path.join(dir, "nope.json"))).toBeUndefined();
  });

  it("reads undefined for a non-boolean value", () => {
    fs.writeFileSync(file, `{"remoteControlAtStartup": "yes"}`);
    expect(readRemoteControlAtStartup(file)).toBeUndefined();
  });

  it("preserves the other keys and the file's formatting", () => {
    const before = `{\n  // my settings\n  "permissions": {\n    "allow": ["Bash"]\n  },\n  "effortLevel": "high"\n}\n`;
    fs.writeFileSync(file, before);
    expect(writeRemoteControlAtStartup(file, true)).toBe(true);
    const after = fs.readFileSync(file, "utf8");
    expect(after).toContain("// my settings");
    expect(after).toContain(`"effortLevel": "high"`);
    expect(after).toContain(`"allow": ["Bash"]`);
    expect(readRemoteControlAtStartup(file)).toBe(true);
  });

  it("removes the key when given undefined, leaving the rest intact", () => {
    fs.writeFileSync(file, `{\n  "remoteControlAtStartup": true,\n  "effortLevel": "high"\n}\n`);
    expect(writeRemoteControlAtStartup(file, undefined)).toBe(true);
    const after = fs.readFileSync(file, "utf8");
    expect(after).not.toContain("remoteControlAtStartup");
    expect(after).toContain(`"effortLevel": "high"`);
  });

  it("writes false as an explicit value, not a removal", () => {
    fs.writeFileSync(file, `{"remoteControlAtStartup": true}`);
    expect(writeRemoteControlAtStartup(file, false)).toBe(true);
    expect(readRemoteControlAtStartup(file)).toBe(false);
  });

  it("creates the file and its parent directory when absent", () => {
    const nested = path.join(dir, "deep", "settings.json");
    expect(writeRemoteControlAtStartup(nested, true)).toBe(true);
    expect(readRemoteControlAtStartup(nested)).toBe(true);
  });

  it("treats an empty file as an empty object", () => {
    fs.writeFileSync(file, "");
    expect(writeRemoteControlAtStartup(file, true)).toBe(true);
    expect(readRemoteControlAtStartup(file)).toBe(true);
  });

  it("removing from a missing file succeeds without creating it", () => {
    const missing = path.join(dir, "gone.json");
    expect(writeRemoteControlAtStartup(missing, undefined)).toBe(true);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("refuses to write an unparseable file and leaves the bytes untouched", () => {
    const junk = `{ this is not json `;
    fs.writeFileSync(file, junk);
    expect(writeRemoteControlAtStartup(file, true)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(junk);
  });

  it("refuses to write a top-level array", () => {
    fs.writeFileSync(file, `[1, 2]`);
    expect(writeRemoteControlAtStartup(file, true)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/remoteControl.test.ts`
Expected: FAIL — cannot resolve `../../../src/engine/remoteControl`.

- [ ] **Step 3: Write the module**

Create `src/engine/remoteControl.ts`:

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyEdits, modify, parse as jsoncParse, ParseError } from "jsonc-parser";

/** The Claude Code setting that starts the Remote Control bridge each session. */
const SETTING_KEY = "remoteControlAtStartup";

/** Claude Code's global settings file. Honors CLAUDE_CONFIG_DIR — Claude resolves
 * its config directory through that variable, so a hardcoded ~/.claude would write
 * to a file nothing reads for anyone who sets it. */
export function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  return path.join(dir, "settings.json");
}

/** Parse `text` as JSONC into a plain object, or undefined if it isn't one.
 * An empty file counts as an empty object. */
function parseObject(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return {};
  const errors: ParseError[] = [];
  const doc = jsoncParse(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length || typeof doc !== "object" || doc === null || Array.isArray(doc)) return undefined;
  return doc as Record<string, unknown>;
}

/** The current value of remoteControlAtStartup. undefined when the key is absent,
 * non-boolean, or the file is missing/unreadable/unparseable. */
export function readRemoteControlAtStartup(file: string): boolean | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const doc = parseObject(text);
  const v = doc?.[SETTING_KEY];
  return typeof v === "boolean" ? v : undefined;
}

/** Set remoteControlAtStartup, or remove it entirely with `undefined`. Edits through
 * jsonc-parser so the user's formatting and comments survive — this file holds their
 * permissions, hooks and plugins, and a parse-and-rewrite would reformat all of it.
 *
 * Best-effort: returns false (without throwing) if the file can't be parsed or written,
 * mirroring mergeReposIntoWorkspace. On a parse failure nothing is written at all. */
export function writeRemoteControlAtStartup(file: string, value: boolean | undefined): boolean {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // No file yet. Removing a key from a file that doesn't exist is already done —
    // don't create one just to leave it empty.
    if (value === undefined) return true;
    text = "{}\n";
  }
  const doc = parseObject(text);
  if (!doc) return false;
  try {
    const edits = modify(text, [SETTING_KEY], value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    const updated = applyEdits(text, edits);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, updated);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/remoteControl.test.ts`
Expected: PASS — every test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/engine/remoteControl.ts test/unit/engine/remoteControl.test.ts
git commit -m "feat(remote-control): read and write remoteControlAtStartup, preserving formatting"
```

---

### Task 3: Ownership tracking and `syncRemoteControl`

**Files:**
- Modify: `src/engine/remoteControl.ts` (append)
- Test: `test/unit/engine/remoteControl.test.ts` (append)

**Interfaces:**
- Consumes: `claudeSettingsPath`, `readRemoteControlAtStartup`, `writeRemoteControlAtStartup` from Task 2
- Produces:
  - `OWNERSHIP_KEY: string`
  - `interface OwnershipRecord { owned: boolean; prior?: boolean }`
  - `interface OwnershipStore { get(): OwnershipRecord | undefined; set(rec: OwnershipRecord | undefined): Promise<void> }`
  - `globalStateOwnership(state): OwnershipStore`
  - `syncRemoteControl(store, mode, confirm?, file?): Promise<boolean>`

**Context for the implementer:** the whole point of the ownership record is that Agent Flow must be able to undo *only its own* change. If the user set `remoteControlAtStartup: true` by hand, Agent Flow must never clear it. `prior` records what was in the file before Agent Flow wrote, so reverting restores that exact state — including "the key was absent", which is `prior: undefined`.

- [ ] **Step 1: Write the failing tests**

First extend the two **existing** import statements at the top of
`test/unit/engine/remoteControl.test.ts` rather than adding duplicates — add `vi` to the
`vitest` import, and add these names to the `remoteControl` import:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  claudeSettingsPath,
  readRemoteControlAtStartup,
  writeRemoteControlAtStartup,
  syncRemoteControl,
  globalStateOwnership,
  OWNERSHIP_KEY,
  type OwnershipRecord,
  type OwnershipStore,
} from "../../../src/engine/remoteControl";
```

Then append:

```ts
/** An in-memory OwnershipStore that also records what was written. */
function fakeStore(initial?: OwnershipRecord): OwnershipStore & { value: () => OwnershipRecord | undefined } {
  let rec = initial;
  return {
    get: () => rec,
    set: async (r) => {
      rec = r;
    },
    value: () => rec,
  };
}

describe("syncRemoteControl", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-rcsync-"));
    file = path.join(dir, "settings.json");
    fs.writeFileSync(file, `{"effortLevel": "high"}\n`);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("mode on: writes true and records ownership with the prior absence", async () => {
    const store = fakeStore();
    expect(await syncRemoteControl(store, "on", undefined, file)).toBe(true);
    expect(readRemoteControlAtStartup(file)).toBe(true);
    expect(store.value()).toEqual({ owned: true, prior: undefined });
  });

  it("mode on: records an explicit prior false", async () => {
    fs.writeFileSync(file, `{"remoteControlAtStartup": false}`);
    const store = fakeStore();
    await syncRemoteControl(store, "on", undefined, file);
    expect(store.value()).toEqual({ owned: true, prior: false });
  });

  it("mode on: a value already true is left alone and never owned", async () => {
    fs.writeFileSync(file, `{"remoteControlAtStartup": true}`);
    const store = fakeStore();
    expect(await syncRemoteControl(store, "on", undefined, file)).toBe(true);
    expect(store.value()).toBeUndefined();
  });

  it("mode off: reverts an owned key back to absent", async () => {
    const store = fakeStore();
    await syncRemoteControl(store, "on", undefined, file);
    expect(await syncRemoteControl(store, "off", undefined, file)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).not.toContain("remoteControlAtStartup");
    expect(store.value()).toBeUndefined();
  });

  it("mode off: reverts an owned key back to an explicit false", async () => {
    fs.writeFileSync(file, `{"remoteControlAtStartup": false}`);
    const store = fakeStore();
    await syncRemoteControl(store, "on", undefined, file);
    await syncRemoteControl(store, "off", undefined, file);
    expect(readRemoteControlAtStartup(file)).toBe(false);
  });

  it("mode off: leaves a hand-set true alone", async () => {
    fs.writeFileSync(file, `{"remoteControlAtStartup": true}`);
    const store = fakeStore();
    expect(await syncRemoteControl(store, "off", undefined, file)).toBe(true);
    expect(readRemoteControlAtStartup(file)).toBe(true);
  });

  it("mode off with nothing owned and nothing set is a no-op", async () => {
    const store = fakeStore();
    expect(await syncRemoteControl(store, "off", undefined, file)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).not.toContain("remoteControlAtStartup");
  });

  it("mode ask: Yes behaves like on", async () => {
    const store = fakeStore();
    const confirm = vi.fn(async () => true);
    expect(await syncRemoteControl(store, "ask", confirm, file)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(readRemoteControlAtStartup(file)).toBe(true);
  });

  it("mode ask: No reverts what we owned", async () => {
    const store = fakeStore();
    await syncRemoteControl(store, "on", undefined, file);
    expect(await syncRemoteControl(store, "ask", async () => false, file)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).not.toContain("remoteControlAtStartup");
  });

  it("mode ask without a confirm callback never writes", async () => {
    fs.writeFileSync(file, `{"remoteControlAtStartup": true}`);
    const store = fakeStore();
    expect(await syncRemoteControl(store, "ask", undefined, file)).toBe(true);
    expect(readRemoteControlAtStartup(file)).toBe(true);
    expect(store.value()).toBeUndefined();
  });

  it("does not claim ownership when the write fails", async () => {
    fs.writeFileSync(file, `{ not json `);
    const store = fakeStore();
    expect(await syncRemoteControl(store, "on", undefined, file)).toBe(false);
    expect(store.value()).toBeUndefined();
  });
});

describe("globalStateOwnership", () => {
  it("round-trips a record through a Memento and clears it with undefined", async () => {
    const store = new Map<string, unknown>();
    const memento = {
      get: <T,>(k: string) => store.get(k) as T | undefined,
      update: async (k: string, v: unknown) => {
        if (v === undefined) store.delete(k);
        else store.set(k, v);
      },
    };
    const own = globalStateOwnership(memento);
    await own.set({ owned: true, prior: false });
    expect(store.get(OWNERSHIP_KEY)).toEqual({ owned: true, prior: false });
    expect(own.get()).toEqual({ owned: true, prior: false });
    await own.set(undefined);
    expect(own.get()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/remoteControl.test.ts`
Expected: FAIL — `syncRemoteControl` / `globalStateOwnership` / `OWNERSHIP_KEY` are not exported.

- [ ] **Step 3: Append the ownership layer to the module**

Append to `src/engine/remoteControl.ts`:

```ts
/** globalState key holding the ownership record. */
export const OWNERSHIP_KEY = "agentFlow.remoteControlOwned";

/** What Agent Flow did to the global setting, and what was there before it did.
 * `prior: undefined` means the key was absent — reverting removes it again. */
export interface OwnershipRecord {
  owned: boolean;
  prior?: boolean;
}

export interface OwnershipStore {
  get(): OwnershipRecord | undefined;
  set(rec: OwnershipRecord | undefined): Promise<void>;
}

/** The subset of vscode.Memento this module needs, so the module stays vscode-free. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export function globalStateOwnership(state: MementoLike): OwnershipStore {
  return {
    get: () => state.get<OwnershipRecord>(OWNERSHIP_KEY),
    set: async (rec) => {
      await state.update(OWNERSHIP_KEY, rec);
    },
  };
}

/**
 * Bring the global Claude setting in line with `mode`, and report whether Remote
 * Control is on for sessions started from here.
 *
 * `ask` consults `confirm`; with no `confirm` (the config-listener path) it leaves
 * the file alone. Turning it off only ever undoes what Agent Flow itself wrote — a
 * value the user set by hand is never overwritten or cleared.
 */
export async function syncRemoteControl(
  store: OwnershipStore,
  mode: "off" | "on" | "ask",
  confirm?: () => Promise<boolean>,
  file: string = claudeSettingsPath(),
): Promise<boolean> {
  let want: boolean;
  if (mode === "on") want = true;
  else if (mode === "off") want = false;
  else if (!confirm) return readRemoteControlAtStartup(file) === true;
  else want = await confirm();

  const current = readRemoteControlAtStartup(file);

  if (want) {
    // Already on — nothing to change, and nothing to claim ownership of.
    if (current === true) return true;
    if (!writeRemoteControlAtStartup(file, true)) return false;
    await store.set({ owned: true, prior: current });
    return true;
  }

  const rec = store.get();
  if (!rec?.owned) return current === true; // not ours to undo
  if (!writeRemoteControlAtStartup(file, rec.prior)) return current === true;
  await store.set(undefined);
  return rec.prior === true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/remoteControl.test.ts`
Expected: PASS — every test in the file, including Task 2's.

- [ ] **Step 5: Commit**

```bash
git add src/engine/remoteControl.ts test/unit/engine/remoteControl.test.ts
git commit -m "feat(remote-control): track ownership so off restores the prior value"
```

---

### Task 4: Wire it into the three launch paths

**Files:**
- Modify: `src/tasksView.ts` — imports, a new `resolveRemoteControl` method, and three call sites (`launch()` ~line 586, `explore()` ~line 411, `takeBatch()` ~line 689)
- Test: `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `syncRemoteControl`, `globalStateOwnership` from Task 3; `AgentFlowConfig.remoteControl` from Task 1
- Produces: `TasksViewProvider.resolveRemoteControl(cfg): Promise<boolean>` (private — no later task depends on it)

**Context for the implementer:** `syncRemoteControl` touches the real `~/.claude/settings.json` by default. The tasksView tests **must** mock `src/engine/remoteControl`, or running the suite would rewrite the developer's own Claude settings. Add the mock before writing any other test in this task.

- [ ] **Step 1: Write the failing tests**

In `test/unit/tasksView.test.ts`, add this mock alongside the other `vi.mock` calls near the top (after the `worktree` mock on line 14):

```ts
vi.mock("../../src/engine/remoteControl", () => ({
  syncRemoteControl: vi.fn(async () => false),
  globalStateOwnership: vi.fn(() => ({ get: () => undefined, set: async () => {} })),
}));
```

Add to the imports block (after the `createWorktrees` import):

```ts
import { syncRemoteControl } from "../../src/engine/remoteControl";
```

Then append this describe block:

```ts
describe("remote control", () => {
  it("does not prompt and syncs off when the setting is off", async () => {
    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);
    expect(syncRemoteControl).toHaveBeenCalledTimes(1);
    expect(vi.mocked(syncRemoteControl).mock.calls[0][1]).toBe("off");
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it("passes the configured mode through on take", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "on" });
    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);
    expect(vi.mocked(syncRemoteControl).mock.calls[0][1]).toBe("on");
  });

  it("resolves before the workspace opens", async () => {
    const order: string[] = [];
    vi.mocked(syncRemoteControl).mockImplementationOnce(async () => {
      order.push("sync");
      return true;
    });
    vi.mocked(openWorkspace).mockImplementationOnce(async () => {
      order.push("open");
      return { mode: "per-window" as const, workspaceFile: undefined, briefs: [], opened: [] };
    });
    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);
    expect(order).toEqual(["sync", "open"]);
  });

  it("asks exactly once for a batch of several tasks", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
    const { provider } = setup();
    await provider.takeBatch(["ASM-1", "ASM-2", "ASM-3"], "api");
    expect(openWorkspace).toHaveBeenCalledTimes(3);
    expect(syncRemoteControl).toHaveBeenCalledTimes(1);
    vi.mocked(createWorktrees).mockImplementation((s) => s);
  });

  it("resolves once on an explore launch", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "on", exploreMode: "knowledge" });
    vi.mocked(window.showInputBox).mockResolvedValueOnce("the retry path" as never);
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(syncRemoteControl).toHaveBeenCalledTimes(1);
  });

  it("the ask picker's Enable option resolves true, and dismissing resolves false", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "ask" });
    // Capture the confirm callback the provider hands to syncRemoteControl.
    let confirm: (() => Promise<boolean>) | undefined;
    vi.mocked(syncRemoteControl).mockImplementationOnce(async (_s, _m, c) => {
      confirm = c;
      return false;
    });
    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);

    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ yes: true } as never);
    expect(await confirm!()).toBe(true);

    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined);
    expect(await confirm!()).toBe(false); // dismissed → no, not a cancel
  });

  it("a launch still proceeds when the picker is dismissed", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "ask" });
    vi.mocked(syncRemoteControl).mockImplementationOnce(async (_s, _m, c) => {
      await c!(); // showQuickPick is stubbed to resolve undefined by default
      return false;
    });
    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);
    expect(openWorkspace).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts -t "remote control"`
Expected: FAIL — `syncRemoteControl` is never called (0 calls).

- [ ] **Step 3: Add the resolver to `TasksViewProvider`**

In `src/tasksView.ts`, add to the import block:

```ts
import { syncRemoteControl, globalStateOwnership } from "./engine/remoteControl";
```

Add this private method just above `private async launch(`:

```ts
  /** Resolve Claude Code's Remote Control for this launch action, and report whether
   * it is on. Called once per action — a batch of N tasks asks once, because all N
   * sessions read the one global setting, so a per-task answer could not be honored.
   *
   * Dismissing the picker means "no", not "cancel": by the time this runs, worktrees
   * and briefs may already exist, and abandoning the launch over an optional toggle
   * is the worse failure. */
  private async resolveRemoteControl(cfg: AgentFlowConfig): Promise<boolean> {
    return syncRemoteControl(
      globalStateOwnership(this.context.globalState),
      cfg.remoteControl,
      async () => {
        const p = await vscode.window.showQuickPick(
          [
            {
              label: "$(radio-tower) Enable Remote Control",
              detail: "Drive this session from claude.ai or the Claude mobile app",
              yes: true,
            },
            { label: "$(circle-slash) Local only", detail: "No remote bridge", yes: false },
          ],
          { title: "Enable Remote Control for this session?", ignoreFocusOut: true },
        );
        return p?.yes === true;
      },
    );
  }
```

- [ ] **Step 4: Add the three call sites**

In `launch()`, between `if (!args) return;` and `const planMd = this.buildBrief(detail);`:

```ts
    await this.resolveRemoteControl(cfg);
```

In `explore()`, between `if (!args) return;` and the `const slug = ...` line:

```ts
    await this.resolveRemoteControl(cfg);
```

In `takeBatch()`, between `if (!promptMode) return;` and `let launched = 0;` — once, **before** the loop:

```ts
    // Once for the whole batch: every task's session reads the same global setting.
    await this.resolveRemoteControl(cfg);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: PASS

- [ ] **Step 6: Verify the full suite and type-check**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(remote-control): resolve it once per launch across take, explore, PR and batch"
```

---

### Task 5: React to the setting changing, and document it

**Files:**
- Modify: `src/extension.ts:61-79` (the best-effort activation block)
- Modify: `test/_mocks/vscode.ts` (add `workspace.onDidChangeConfiguration`)
- Modify: `README.md` (settings table, ~line 143)
- Modify: `CHANGELOG.md` (the `## [Unreleased]` section)
- Test: `test/unit/extension.test.ts`

**Interfaces:**
- Consumes: `syncRemoteControl`, `globalStateOwnership` from Task 3; `getConfig().remoteControl` from Task 1
- Produces: nothing consumed by later tasks

**Context for the implementer:** without this listener, flipping the setting to `off` would leave `remoteControlAtStartup: true` in the global file until the next Agent Flow launch — so every Claude session started in between stays remote-controlled. The listener makes `off` mean off immediately. It goes inside the existing `try` block, which exists because an uncaught throw in `activate()` makes VS Code dispose every command and view registration.

- [ ] **Step 1: Add `onDidChangeConfiguration` to the vscode mock**

In `test/_mocks/vscode.ts`, add to the `workspace` object:

```ts
  onDidChangeConfiguration: vi.fn((_cb: (e: unknown) => void) => ({ dispose: vi.fn() })),
```

And to `resetVscodeMocks()`, alongside the other `workspace` resets:

```ts
  workspace.onDidChangeConfiguration.mockReset().mockImplementation(() => ({ dispose: vi.fn() }));
```

- [ ] **Step 2: Write the failing test**

`test/unit/extension.test.ts` already imports `vi`, `fakeContext`, and `activate`. Two edits
are needed.

First, widen the existing `_mocks/vscode` import on line 2 to pull in `workspace`:

```ts
import { commands, window, workspace, setConfig } from "../_mocks/vscode";
```

Second, add this mock alongside the other `vi.mock` calls at the top of the file — without
it the listener would write to the developer's real `~/.claude/settings.json` when the suite
runs:

```ts
vi.mock("../../src/engine/remoteControl", () => ({
  syncRemoteControl: vi.fn(async () => false),
  globalStateOwnership: vi.fn(() => ({ get: () => undefined, set: async () => {} })),
}));
```

Add it to the static import block below the other mocked modules:

```ts
import { syncRemoteControl } from "../../src/engine/remoteControl";
```

Then append the test:

```ts
describe("remote control on configuration change", () => {
  it("re-syncs only when agentFlow.remoteControl changed", () => {
    const { context } = fakeContext();
    activate(context);

    const cb = vi.mocked(workspace.onDidChangeConfiguration).mock.calls[0][0] as (e: unknown) => void;
    vi.mocked(syncRemoteControl).mockClear();

    cb({ affectsConfiguration: (k: string) => k === "agentFlow.somethingElse" });
    expect(syncRemoteControl).not.toHaveBeenCalled();

    cb({ affectsConfiguration: (k: string) => k === "agentFlow.remoteControl" });
    expect(syncRemoteControl).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/unit/extension.test.ts -t "remote control"`
Expected: FAIL — `onDidChangeConfiguration` was never called, so `mock.calls[0]` is undefined.

- [ ] **Step 4: Register the listener**

In `src/extension.ts`, add to the import block:

```ts
import { syncRemoteControl, globalStateOwnership } from "./engine/remoteControl";
```

Inside the existing `try { ... }` block, after the `watchPlansAndSeed` line:

```ts
    // Flipping agentFlow.remoteControl to `off` should take effect now, not at the
    // next launch — otherwise a session started in between stays remote-controlled.
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("agentFlow.remoteControl")) return;
        void syncRemoteControl(globalStateOwnership(context.globalState), getConfig().remoteControl).catch(
          (err: unknown) => log(`remote control sync failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }),
    );
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/unit/extension.test.ts`
Expected: PASS

- [ ] **Step 6: Document the setting in the README**

Add this row to the settings table in `README.md`, after the `agentFlow.prReviewAutoFix` row:

```markdown
| `agentFlow.remoteControl` | `off` | Start Claude Code's **Remote Control** bridge for launched sessions (`off` / `on` / `ask`), so you can drive them from claude.ai or the Claude mobile app. |
```

And add this paragraph immediately after the table's trailing "Plus `agentFlow.workspaceMode`, …" paragraph:

```markdown
**Remote Control.** `agentFlow.remoteControl` works by setting `remoteControlAtStartup`
in your global Claude settings (`$CLAUDE_CONFIG_DIR`, or `~/.claude/settings.json`), which
is the only switch Claude Code's VS Code panel exposes. While it is on, Claude sessions you
start yourself are remote-controlled too. Agent Flow remembers whether it was the one that
set the key and restores the previous value when you switch back to `off` — a value you set
by hand is never overwritten or cleared. One caveat: opening a task into a window that
already has a running Claude session does not retrofit that session; the change applies to
the next session started there.
```

- [ ] **Step 7: Add the CHANGELOG entry**

Under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
### Added

- **Remote Control for launched sessions.** A new `agentFlow.remoteControl` setting
  (`off` / `on` / `ask`, default `off`) starts Claude Code's Remote Control bridge for the
  sessions Agent Flow opens, so a task you took from the pool can be driven from claude.ai
  or the Claude mobile app. `ask` prompts once per launch — a parallel batch asks once, not
  once per task. Because Claude Code's only switch is the global `remoteControlAtStartup`
  setting, turning this on affects sessions you start yourself too; Agent Flow tracks
  whether it was the one that set the key and puts the previous value back when you switch
  to `off`, leaving a hand-set value untouched.
```

- [ ] **Step 8: Verify everything**

Run: `npx tsc --noEmit && npx vitest run && npx vitest run --coverage`
Expected: PASS, with coverage still above the configured thresholds (90% statements/lines, 85% branches/functions).

- [ ] **Step 9: Commit**

```bash
git add src/extension.ts test/_mocks/vscode.ts test/unit/extension.test.ts README.md CHANGELOG.md
git commit -m "feat(remote-control): apply setting changes immediately, and document the feature"
```

---

## Manual verification

Do this after Task 5, in a real editor window — the unit tests mock the settings file, so nothing above proves the bridge actually starts.

1. Set `agentFlow.remoteControl` to `ask`, take a task, choose **Enable Remote Control**. The new window's Claude Code session should come up with Remote Control active and appear on claude.ai.
2. Confirm `remoteControlAtStartup: true` landed in `~/.claude/settings.json` and that the file's other keys, formatting, and comments are unchanged.
3. Set the setting back to `off`. The key should disappear from the file immediately, without a relaunch.
4. Set `remoteControlAtStartup: true` by hand, then take a task with the setting at `off`. The hand-set value must survive.
5. With `ask`, narrow the repo filter to one repo, tick three tasks, and **Launch in parallel**. Exactly one prompt, three remote-controlled sessions.

## Release note

Per the repo's release convention, the version bump and a fresh `.vsix` build happen when this branch merges to `main` — not on the branch itself.
