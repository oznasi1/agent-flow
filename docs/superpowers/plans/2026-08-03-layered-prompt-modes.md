# Layered Prompt Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agentFlow.promptModes` and `agentFlow.reviewRequestModes` layer over the shipped built-in modes instead of replacing them, so built-ins added in a later release reach users who customized the setting years ago.

**Architecture:** One pure resolver, `resolveModes(c, key, builtIns)`, in `src/config.ts`, reading the *explicit* (user-authored) value via the existing `explicitConfigValue` / `inspect()` helper. Both mode settings route through it. A new `hidden: true` entry flag is the explicit opt-out for dropping a built-in. A separate `src/modesNotice.ts` shows a once-ever notification to exactly the users who will see new modes appear, with a one-click action to restore their previous list.

**Tech Stack:** TypeScript, VS Code extension API, Vitest (`vscode` module mocked at `test/_mocks/vscode.ts`), esbuild.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-08-03-layered-prompt-modes-design.md`. It is the authority; this plan implements it.
- **CI gates — all three must pass before any commit:** `npm run typecheck` (must be clean), `npm test` (currently 1755+ tests, all must pass), `npm run build` (must succeed). Run `npm run test:cov` before the final commit.
- **Coverage thresholds are enforced** by `npm run test:cov` — `statements: 90, branches: 85, functions: 85, lines: 90` (`vitest.config.ts:40`). `src/**` is included; new files are not exempt.
- **Do not edit the shared `vscode` mock** (`test/_mocks/vscode.ts`). Its `inspect` returns only `{key, globalValue}`, which is why scope selection is factored into an exported pure function testable with hand-built inspect objects. Changing the shared mock risks the whole suite.
- **`PromptMode`** (`src/types.ts:44-49`) is `{id: string; label: string; detail?: string; prompt: string}`. **Do not add `hidden` to it** — `hidden` is a settings-file-only concept, resolved away before any consumer sees a `PromptMode`.
- **Never reorder or reword** `DEFAULT_PROMPT_MODES` / `DEFAULT_REVIEW_REQUEST_MODES` or their `package.json` defaults. Tests pin them byte-identical to each other (`test/unit/config.test.ts:504`, `:575`).
- **Telemetry may never carry user-authored text.** Mode labels, details and prompts are user-authored. Only counts and booleans leave the machine (`docs/TELEMETRY.md:52-58`).
- **Comment style:** this codebase writes comments that explain *why*, in full sentences, above the construct. Match it. Do not add narration comments to obvious code.
- **Version bump and `.vsix` packaging are NOT part of this plan.** They happen when the branch merges to main.

---

### Task 1: `resolveModes` — the layering resolver

The core fix. After this task the reported bug is gone.

**Files:**
- Modify: `src/config.ts` — add `ModeEntry`, `nonBlank`, `resolveModes`; rewrite the `promptModes` and `reviewRequestModes` branches of `getConfig` (`src/config.ts:306-309` and `src/config.ts:330-345`)
- Test: `test/unit/config.test.ts` — rewrite `describe("getConfig — promptModes validation")` (`:142-175`), amend three cases inside `describe("review-request settings")` (`:380-491`)

**Interfaces:**
- Consumes: `explicitConfigValue<T>(c, key)` (already at `src/config.ts:249-252`), `DEFAULT_PROMPT_MODES` (`:11`), `DEFAULT_REVIEW_REQUEST_MODES` (`:175`), `PromptMode` from `./types`
- Produces: `resolveModes(c: vscode.WorkspaceConfiguration, key: string, builtIns: PromptMode[]): PromptMode[]` — module-private, not exported. Task 3 and Task 4 do **not** call it; they derive what they need independently. `cfg.promptModes` and `cfg.reviewRequestModes` keep their existing `PromptMode[]` type, so no downstream consumer changes.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `describe("getConfig — promptModes validation", ...)` at `test/unit/config.test.ts:142-175` with this block. Five of its cases currently assert the replace-semantics being removed and must not survive as-is.

```ts
describe("getConfig — promptModes layering", () => {
  const stockIds = DEFAULT_PROMPT_MODES.map((m) => m.id);

  it("appends built-ins the user never listed, keeping the user's entries first", () => {
    setConfig({
      promptModes: [
        { id: "plan", label: "Plan first", prompt: "my plan {key}" },
        { id: "implementation", label: "Implementation", prompt: "my impl {key}" },
      ],
    });
    const modes = getConfig().promptModes;
    expect(modes.map((m) => m.id)).toEqual(stockIds);
    expect(modes[0].prompt).toBe("my plan {key}");
    expect(modes[1].prompt).toBe("my impl {key}");
    // The regression this exists to prevent: modes added after the user
    // customized the setting must still reach them.
    expect(modes.map((m) => m.id)).toContain("orchestrator");
  });

  it("fills a field the override omits from the built-in it overrides", () => {
    setConfig({ promptModes: [{ id: "plan", prompt: "mine {key}" }] });
    const plan = getConfig().promptModes[0];
    expect(plan).toEqual({
      id: "plan",
      label: DEFAULT_PROMPT_MODES[0].label,
      detail: DEFAULT_PROMPT_MODES[0].detail,
      prompt: "mine {key}",
    });
  });

  it("keeps a user's reordering of the built-ins", () => {
    setConfig({ promptModes: [{ id: "tdd" }, { id: "plan" }] });
    const ids = getConfig().promptModes.map((m) => m.id);
    expect(ids.slice(0, 2)).toEqual(["tdd", "plan"]);
    expect(new Set(ids)).toEqual(new Set(stockIds));
  });

  it("appends a mode of the user's own after the built-ins", () => {
    const spike = { id: "spike", label: "Spike", detail: "Timebox it", prompt: "spike {key}" };
    setConfig({ promptModes: [spike] });
    const modes = getConfig().promptModes;
    expect(modes).toHaveLength(stockIds.length + 1);
    expect(modes[0]).toEqual(spike);
    expect(modes.slice(1)).toEqual(DEFAULT_PROMPT_MODES);
  });

  it("drops a built-in marked hidden", () => {
    setConfig({ promptModes: [{ id: "tdd", hidden: true }] });
    const ids = getConfig().promptModes.map((m) => m.id);
    expect(ids).not.toContain("tdd");
    expect(ids).toEqual(stockIds.filter((id) => id !== "tdd"));
  });

  it("lets hidden win over a competing override of the same id", () => {
    setConfig({
      promptModes: [
        { id: "tdd", label: "Test-driven", prompt: "mine {key}" },
        { id: "tdd", hidden: true },
      ],
    });
    expect(getConfig().promptModes.map((m) => m.id)).not.toContain("tdd");
  });

  it("drops a custom mode marked hidden", () => {
    setConfig({
      promptModes: [
        { id: "spike", label: "Spike", prompt: "spike {key}" },
        { id: "spike", hidden: true },
      ],
    });
    expect(getConfig().promptModes.map((m) => m.id)).toEqual(stockIds);
  });

  it("ignores an unknown id that carries no label or no prompt", () => {
    setConfig({
      promptModes: [
        { id: "no-prompt", label: "No prompt" },
        { id: "no-label", prompt: "x {key}" },
        { id: "usable", label: "Usable", prompt: "y {key}" },
      ],
    });
    const modes = getConfig().promptModes;
    expect(modes.map((m) => m.id)).toEqual(["usable", ...stockIds]);
  });

  it("ignores entries that are not objects or have no usable id", () => {
    setConfig({ promptModes: [null, 42, "nope", {}, { id: "   " }, { id: 7 }] });
    expect(getConfig().promptModes).toEqual(DEFAULT_PROMPT_MODES);
  });

  it("trims a padded id so it still matches its built-in", () => {
    setConfig({ promptModes: [{ id: "  plan  ", prompt: "mine {key}" }] });
    const modes = getConfig().promptModes;
    expect(modes.map((m) => m.id)).toEqual(stockIds);
    expect(modes[0].prompt).toBe("mine {key}");
  });

  it("keeps the first of two overrides of the same id", () => {
    setConfig({
      promptModes: [
        { id: "plan", prompt: "first {key}" },
        { id: "plan", prompt: "second {key}" },
      ],
    });
    const modes = getConfig().promptModes;
    expect(modes.filter((m) => m.id === "plan")).toHaveLength(1);
    expect(modes[0].prompt).toBe("first {key}");
  });

  it("drops a blank label or prompt on an override rather than blanking the built-in", () => {
    setConfig({ promptModes: [{ id: "plan", label: "   ", prompt: "" }] });
    expect(getConfig().promptModes[0]).toEqual(DEFAULT_PROMPT_MODES[0]);
  });

  it("falls back to the built-ins when every one of them is hidden", () => {
    setConfig({ promptModes: DEFAULT_PROMPT_MODES.map((m) => ({ id: m.id, hidden: true })) });
    expect(getConfig().promptModes).toEqual(DEFAULT_PROMPT_MODES);
  });

  it("falls back to defaults for an empty array", () => {
    setConfig({ promptModes: [] });
    expect(getConfig().promptModes).toEqual(DEFAULT_PROMPT_MODES);
  });

  it("falls back to defaults for a non-array value", () => {
    setConfig({ promptModes: "nonsense" });
    expect(getConfig().promptModes).toEqual(DEFAULT_PROMPT_MODES);
  });

  it("returns the built-ins untouched when the value only comes from the manifest default", () => {
    // `get` serves the manifest default; `inspect` reports nothing set. Layering
    // that default over itself would leave `hidden` nothing to hide.
    setDefaultConfig({ promptModes: DEFAULT_PROMPT_MODES });
    expect(getConfig().promptModes).toEqual(DEFAULT_PROMPT_MODES);
  });
});
```

Then amend the three review-mode cases that assert replace-semantics. At `test/unit/config.test.ts:447-450`, replace the body so the stock mode is expected to survive alongside the explicit one:

```ts
  it("layers an explicit modes list over the stock mode and ignores the legacy prompt", () => {
    setConfig({
      reviewRequestPrompt: "legacy",
      reviewRequestModes: [{ id: "backend", label: "Backend", prompt: "BE {number}" }],
    });
    const modes = getConfig().reviewRequestModes;
    expect(modes).toEqual([
      { id: "backend", label: "Backend", prompt: "BE {number}" },
      ...DEFAULT_REVIEW_REQUEST_MODES,
    ]);
    expect(modes.map((m) => m.prompt)).not.toContain("legacy");
  });
```

At `test/unit/config.test.ts:466-467`, replace the body:

```ts
  it("drops an unusable entry but keeps the usable one and the stock mode", () => {
    setConfig({ reviewRequestModes: [{ id: "ok", label: "OK", prompt: "P" }, { id: "bad", label: "Bad" }] });
    expect(getConfig().reviewRequestModes).toEqual([
      { id: "ok", label: "OK", prompt: "P" },
      ...DEFAULT_REVIEW_REQUEST_MODES,
    ]);
  });
```

And add one case to the same `describe`, for the review-side regression named in the spec:

```ts
  it("gives back the stock mode to a reviewer who replaced it with their own pair", () => {
    setConfig({
      reviewRequestModes: [
        { id: "backend", label: "Backend", prompt: "BE {number}" },
        { id: "frontend", label: "Frontend", prompt: "FE {number}" },
      ],
    });
    expect(getConfig().reviewRequestModes.map((m) => m.id)).toEqual(["backend", "frontend", "full"]);
  });
```

Check the imports at the top of `test/unit/config.test.ts` already include `DEFAULT_PROMPT_MODES`, `DEFAULT_REVIEW_REQUEST_MODES`, `setConfig` and `setDefaultConfig`. They do as of `:18` — add nothing if so.

Leave `test/unit/config.test.ts:454-455` (empty array), `:461-462` (all entries unusable) and `:475-491` (legacy migration via manifest default) untouched. All three still pass under layering; confirm that in Step 4 rather than editing them.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- test/unit/config.test.ts
```

Expected: the new `promptModes layering` cases fail — e.g. `appends built-ins the user never listed` fails because the resolved array is the two user entries only. The three amended review cases fail for the same reason.

- [ ] **Step 3: Implement the resolver**

In `src/config.ts`, insert this directly below `explicitConfigValue` (which ends at `:252`) and above `readEnvironments`:

```ts
/** One entry of a mode-list setting exactly as settings.json may hold it: every
 * field unknown, because a hand-edited file can put anything here. Only `id` is
 * meaningful on its own — the rest are optional so an entry can override one
 * field of a built-in, or hide it, without restating the whole mode. */
interface ModeEntry {
  id?: unknown;
  label?: unknown;
  detail?: unknown;
  prompt?: unknown;
  hidden?: unknown;
}

/** The value if it is a string with something other than whitespace in it. */
function nonBlank(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Resolve a mode-list setting into the list the picker shows. The setting is a
 * *layer* over `builtIns`, never a replacement for it: an entry whose `id` names
 * a built-in overrides that built-in field by field, an unknown `id` adds a mode
 * of the user's own, and `hidden: true` drops a built-in. Built-ins the user
 * never listed are appended in shipped order, which is the whole point — before
 * this, a customized list froze at the modes that existed the day it was written
 * and every later addition was invisible, silently, with nothing in the UI to
 * suggest anything was missing.
 *
 * The user's own entries stay first, in their order, so a deliberate reordering
 * survives; new built-ins land at the end, the one position that never disturbs
 * an existing arrangement. `hidden` wins over an override of the same id
 * wherever the two appear.
 *
 * Reads the *explicit* value only. `c.get` cannot tell a user's array from the
 * manifest default, and layering that default over itself would leave `hidden`
 * with nothing to hide for a user who never touched the setting. */
function resolveModes(
  c: vscode.WorkspaceConfiguration,
  key: string,
  builtIns: PromptMode[],
): PromptMode[] {
  const explicit = explicitConfigValue<unknown>(c, key);
  if (!Array.isArray(explicit)) return builtIns;

  const byId = new Map(builtIns.map((m) => [m.id, m]));
  const hidden = new Set<string>();
  const listed: PromptMode[] = [];
  const seen = new Set<string>();

  for (const raw of explicit) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as ModeEntry;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    if (entry.hidden === true) {
      hidden.add(id);
      continue;
    }
    if (seen.has(id)) continue;
    const builtIn = byId.get(id);
    const label = nonBlank(entry.label) ?? builtIn?.label;
    const prompt = nonBlank(entry.prompt) ?? builtIn?.prompt;
    // A mode of the user's own has no built-in to inherit from, so it needs both.
    if (!label || !prompt) continue;
    const detail = nonBlank(entry.detail) ?? builtIn?.detail;
    seen.add(id);
    listed.push({ id, label, prompt, ...(detail !== undefined ? { detail } : {}) });
  }

  const appended = builtIns.filter((m) => !seen.has(m.id));
  const resolved = [...listed, ...appended].filter((m) => !hidden.has(m.id));
  // An empty picker is a dead end with no in-product way out of it.
  return resolved.length ? resolved : builtIns;
}
```

Then replace the `promptModes` branch at `src/config.ts:306-309`:

```ts
    promptModes: resolveModes(c, "promptModes", DEFAULT_PROMPT_MODES),
```

And replace the `reviewRequestModes` branch at `src/config.ts:330-345`:

```ts
    reviewRequestModes: (() => {
      // An explicit modes list is a deliberate layer over the built-ins and wins
      // over the deprecated string, even when it holds nothing usable.
      if (explicitConfigValue<unknown>(c, "reviewRequestModes") !== undefined) {
        return resolveModes(c, "reviewRequestModes", DEFAULT_REVIEW_REQUEST_MODES);
      }
      // Migrate a customized legacy reviewRequestPrompt into the stock mode.
      const legacy = explicitConfigValue<string>(c, "reviewRequestPrompt");
      return legacy ? [{ ...DEFAULT_REVIEW_REQUEST_MODES[0], prompt: legacy }] : DEFAULT_REVIEW_REQUEST_MODES;
    })(),
```

- [ ] **Step 4: Run the full suite**

```bash
npm test && npm run typecheck && npm run build
```

Expected: PASS on all three. In particular `test/unit/config.test.ts:454-455`, `:461-462` and `:475-491` must still pass **without** being edited — if any of them fails, the resolver's empty/unusable/manifest-default handling is wrong; fix the resolver, not the test.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/unit/config.test.ts
git commit -m "$(cat <<'EOF'
fix(config): layer prompt modes over the built-ins instead of replacing them

A customized `agentFlow.promptModes` or `agentFlow.reviewRequestModes` used to
replace the shipped catalogue outright, so a list written in an older release
froze at the modes that existed that day — Orchestrator, Test-driven,
Investigate and Refine were invisible to those users, with nothing in the UI to
suggest a mode was missing.

Both settings now layer: an entry whose id names a built-in overrides it field
by field, an unknown id adds a mode, and `hidden: true` drops a built-in. The
user's entries stay first in their order, so a deliberate reordering survives,
and unlisted built-ins are appended.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Manifest schema — optional `label`/`prompt`, new `hidden`

Without this, a hide-entry and a field-level override both draw a validation squiggle in the settings JSON editor while working correctly — an invitation to "fix" the file back into the trap.

**Files:**
- Modify: `package.json` — `contributes.configuration.properties["agentFlow.promptModes"]` and `["agentFlow.reviewRequestModes"]`
- Test: `test/unit/config.test.ts` — add to `describe("package.json ⇄ config constants")` (`:493`)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: nothing consumed by later tasks. `items.required` becomes `["id"]` for both settings; `items.properties.hidden` exists with `"type": "boolean"`.

- [ ] **Step 1: Write the failing test**

Add inside `describe("package.json ⇄ config constants", ...)` in `test/unit/config.test.ts`:

```ts
  it.each(["agentFlow.promptModes", "agentFlow.reviewRequestModes"])(
    "requires only an id per entry of %s, so an override or a hide entry validates",
    (key) => {
      const items = (props[key] as { items: { required: string[]; properties: Record<string, unknown> } }).items;
      expect(items.required).toEqual(["id"]);
      expect(items.properties.hidden).toEqual({
        type: "boolean",
        description: "Set to true to drop this built-in mode from the picker.",
      });
    },
  );

  it.each(["agentFlow.promptModes", "agentFlow.reviewRequestModes"])(
    "documents that %s layers over the built-in modes",
    (key) => {
      const md = (props[key] as { markdownDescription: string }).markdownDescription;
      expect(md).toMatch(/layer/i);
      expect(md).toContain('"hidden": true');
    },
  );
```

`props` is already in scope in that describe block — confirm at `test/unit/config.test.ts:493-495` and reuse it rather than re-reading `package.json`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- test/unit/config.test.ts
```

Expected: FAIL — `items.required` is `["id", "label", "prompt"]` and `items.properties.hidden` is `undefined`.

- [ ] **Step 3: Edit the manifest**

For **both** `agentFlow.promptModes` and `agentFlow.reviewRequestModes` in `package.json`:

Change `items.required` from `["id", "label", "prompt"]` to `["id"]`.

Add to `items.properties`, after `prompt`:

```json
              "hidden": {
                "type": "boolean",
                "description": "Set to true to drop this built-in mode from the picker."
              }
```

Reword the two `label`/`prompt` descriptions in **both** settings so the optionality is explained. For `agentFlow.promptModes`:

```json
              "label": {
                "type": "string",
                "description": "Shown in the picker. Omit to keep a built-in mode's label; required when adding a mode of your own."
              },
```

```json
              "prompt": {
                "type": "string",
                "description": "Template with {key} {summary} {url} {brief} {files}. Omit to keep a built-in mode's prompt; required when adding a mode of your own."
              }
```

For `agentFlow.reviewRequestModes`, same wording but keep its own placeholder list:

```json
              "prompt": {
                "type": "string",
                "description": "Template with {repo} {number} {author} {key} {summary} {url} {brief} {files}. Omit to keep a built-in mode's prompt; required when adding a mode of your own."
              }
```

Append this sentence to `agentFlow.promptModes`'s existing `markdownDescription` (keep everything already there):

```
 Your entries **layer over** the built-in modes rather than replacing them: reuse a built-in `id` to override just the fields you set, use a new `id` to add a mode, and `{"id": "tdd", "hidden": true}` to drop a built-in. Modes you don't list are appended, so built-ins added in a later release still reach you.
```

Append the same sentence to `agentFlow.reviewRequestModes`'s `markdownDescription`, with `"tdd"` changed to `"full"`.

Leave both `default` arrays exactly as they are — `test/unit/config.test.ts:504` and `:575` pin them byte-identical to the config constants.

- [ ] **Step 4: Run the tests**

```bash
npm test -- test/unit/config.test.ts && npm run typecheck
```

Expected: PASS, including the two pre-existing byte-identical-default tests.

- [ ] **Step 5: Commit**

```bash
git add package.json test/unit/config.test.ts
git commit -m "$(cat <<'EOF'
fix(config): let a mode entry carry only the fields it overrides

`required: ["id", "label", "prompt"]` meant both a field-level override and a
`hidden: true` entry drew a validation squiggle in the settings editor while
working correctly — an invitation to edit the file back into the shadowing bug.
Only `id` is required now, `hidden` is declared, and both descriptions say the
list layers over the built-ins.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Telemetry — counts instead of a broken boolean

`prompt_modes_customized` compares the resolved id list against the stock id list. Under layering the resolved list almost always *contains* every stock id, so the flag reads `false` for users who customized heavily. It becomes meaningless and is replaced.

**Files:**
- Modify: `src/telemetry/events.ts:142-149` — the `SettingsSnapshot` field declarations
- Modify: `src/telemetry/settingsSnapshot.ts` — drop `STOCK_PROMPT_MODE_IDS` / `STOCK_REVIEW_MODE_IDS` (`:44-45`), add `modeCounts`, rewrite the four fields at `:85-86` and `:93-94`
- Modify: `docs/TELEMETRY.md:56` and `:179-180` — the field tables
- Test: `test/unit/telemetry/settingsSnapshot.test.ts`, `test/unit/telemetry/events.test.ts:31,34`

**Interfaces:**
- Consumes: `cfg.promptModes` / `cfg.reviewRequestModes` — the *resolved* `PromptMode[]` Task 1 produces. It does **not** call `resolveModes` and does not see `hidden`; the counts are derived by diffing the resolved list against the built-ins.
- Produces: `SettingsSnapshot` gains `prompt_modes_overridden`, `prompt_modes_custom`, `prompt_modes_hidden`, `review_modes_overridden`, `review_modes_custom`, `review_modes_hidden`, all `number`. It **loses** `prompt_modes_customized` and `review_modes_customized`. `prompt_modes_count` and `review_modes_count` are unchanged.

- [ ] **Step 1: Write the failing tests**

Four sites in `test/unit/telemetry/settingsSnapshot.test.ts` assert the fields being removed.

First, add the two missing imports at the top of that file — it currently imports `AgentFlowConfig, DEFAULT_REVIEW_REQUEST_MODES, getConfig` from `../../../src/config` and does not import the mock's `setConfig`:

```ts
import { AgentFlowConfig, DEFAULT_PROMPT_MODES, DEFAULT_REVIEW_REQUEST_MODES, getConfig } from "../../../src/config";
import { setConfig } from "../../_mocks/vscode";
```

At `:21`, replace this single line:

```ts
    expect(s.prompt_modes_customized).toBe(false);
```

with:

```ts
    expect(s.prompt_modes_overridden).toBe(0);
    expect(s.prompt_modes_custom).toBe(0);
    expect(s.prompt_modes_hidden).toBe(0);
```

At `:29`, replace this single line:

```ts
    expect(s.review_modes_customized).toBe(false);
```

with:

```ts
    expect(s.review_modes_overridden).toBe(0);
    expect(s.review_modes_custom).toBe(0);
    expect(s.review_modes_hidden).toBe(0);
```

At `:62-63`, inside the review-modes case (its `cfg` is built by hand as `{...getConfig(), reviewRequestModes: [acme-backend, acme-frontend]}`, so the resolved list is those two and the stock `full` is absent), replace:

```ts
    expect(s.review_modes_customized).toBe(true);
    expect(s.review_modes_count).toBe(2);
```

with:

```ts
    expect(s.review_modes_custom).toBe(2);
    expect(s.review_modes_overridden).toBe(0);
    expect(s.review_modes_hidden).toBe(1);
    expect(s.review_modes_count).toBe(2);
```

Rename that `it` from `"flags customized review modes without revealing them"` (or whatever its exact current title is — keep the trailing `without revealing them`) so it reads `counts` rather than `flags`.

At `:70-71`, inside the prompt-modes case (`cfg` is `{...getConfig(), promptModes: [{id: "mine", …}]}`, so all six built-ins are absent), replace:

```ts
    expect(s.prompt_modes_customized).toBe(true);
    expect(s.prompt_modes_count).toBe(1);
```

with:

```ts
    expect(s.prompt_modes_custom).toBe(1);
    expect(s.prompt_modes_overridden).toBe(0);
    expect(s.prompt_modes_hidden).toBe(DEFAULT_PROMPT_MODES.length);
    expect(s.prompt_modes_count).toBe(1);
```

and rename that `it` from `"flags customized prompt modes without revealing them"` to `"counts customized prompt modes without revealing them"`.

Then add this describe block to the same file — unlike the four cases above, these drive `setConfig` so they exercise Task 1's resolver end to end:

```ts
describe("settingsSnapshot — mode counts", () => {
  it("reports zeros for an untouched install", () => {
    const s = settingsSnapshot(getConfig());
    expect(s.prompt_modes_count).toBe(DEFAULT_PROMPT_MODES.length);
    expect(s.prompt_modes_overridden).toBe(0);
    expect(s.prompt_modes_custom).toBe(0);
    expect(s.prompt_modes_hidden).toBe(0);
    expect(s.review_modes_overridden).toBe(0);
    expect(s.review_modes_custom).toBe(0);
    expect(s.review_modes_hidden).toBe(0);
  });

  it("counts an overridden built-in, a custom mode and a hidden built-in", () => {
    setConfig({
      promptModes: [
        { id: "plan", prompt: "mine {key}" },
        { id: "spike", label: "Spike", prompt: "spike {key}" },
        { id: "tdd", hidden: true },
      ],
    });
    const s = settingsSnapshot(getConfig());
    expect(s.prompt_modes_overridden).toBe(1);
    expect(s.prompt_modes_custom).toBe(1);
    expect(s.prompt_modes_hidden).toBe(1);
    expect(s.prompt_modes_count).toBe(DEFAULT_PROMPT_MODES.length);
  });

  it("does not count a built-in restated verbatim as overridden", () => {
    setConfig({ promptModes: [{ ...DEFAULT_PROMPT_MODES[0] }] });
    const s = settingsSnapshot(getConfig());
    expect(s.prompt_modes_overridden).toBe(0);
    expect(s.prompt_modes_custom).toBe(0);
  });

  it("counts a detail-only override", () => {
    setConfig({ promptModes: [{ id: "plan", detail: "my own hint" }] });
    expect(settingsSnapshot(getConfig()).prompt_modes_overridden).toBe(1);
  });

  it("counts the review side independently", () => {
    setConfig({
      reviewRequestModes: [
        { id: "backend", label: "Backend", prompt: "BE {number}" },
        { id: "full", hidden: true },
      ],
    });
    const s = settingsSnapshot(getConfig());
    expect(s.review_modes_custom).toBe(1);
    expect(s.review_modes_hidden).toBe(1);
    expect(s.review_modes_overridden).toBe(0);
  });

  it("carries no label, detail or prompt text", () => {
    setConfig({ promptModes: [{ id: "spike", label: "SECRET", detail: "SECRET", prompt: "SECRET" }] });
    expect(JSON.stringify(settingsSnapshot(getConfig()))).not.toContain("SECRET");
  });
});
```

Add `DEFAULT_PROMPT_MODES` and `setConfig` to the file's imports if they are not already there.

In `test/unit/telemetry/events.test.ts`, the literal at `:31` and `:34` must be updated to the new field set — replace `prompt_modes_customized: false` with `prompt_modes_overridden: 0, prompt_modes_custom: 0, prompt_modes_hidden: 0`, and `review_modes_customized: false` with `review_modes_overridden: 0, review_modes_custom: 0, review_modes_hidden: 0`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- test/unit/telemetry
```

Expected: FAIL — the new count fields don't exist on `SettingsSnapshot`, and `npm run typecheck` also fails on the events.test.ts literal.

- [ ] **Step 3: Implement**

In `src/telemetry/events.ts`, replace `prompt_modes_customized: boolean;` (`:143`) with:

```ts
  // How the resolved prompt-mode list differs from the built-ins it layered
  // over. Counts only — labels, details and prompts are user-authored text.
  prompt_modes_overridden: number;
  prompt_modes_custom: number;
  prompt_modes_hidden: number;
```

and `review_modes_customized: boolean;` (`:149`) with:

```ts
  review_modes_overridden: number;
  review_modes_custom: number;
  review_modes_hidden: number;
```

In `src/telemetry/settingsSnapshot.ts`, delete the two now-unused constants at `:44-45`:

```ts
const STOCK_PROMPT_MODE_IDS = DEFAULT_PROMPT_MODES.map((m) => m.id).join(",");
const STOCK_REVIEW_MODE_IDS = DEFAULT_REVIEW_REQUEST_MODES.map((m) => m.id).join(",");
```

Add above `settingsSnapshot`:

```ts
/** How a resolved mode list differs from the built-ins it layered over: how many
 * built-ins the user overrode, how many modes are their own, how many built-ins
 * they hid. Derived by diffing ids and comparing values — the resolved list is
 * all this function gets, and no label, detail or prompt ever leaves it. */
function modeCounts(
  resolved: PromptMode[],
  builtIns: PromptMode[],
): { overridden: number; custom: number; hidden: number } {
  const byId = new Map(builtIns.map((m) => [m.id, m]));
  let overridden = 0;
  let custom = 0;
  for (const m of resolved) {
    const builtIn = byId.get(m.id);
    if (!builtIn) custom++;
    else if (builtIn.label !== m.label || builtIn.detail !== m.detail || builtIn.prompt !== m.prompt) overridden++;
  }
  const present = new Set(resolved.map((m) => m.id));
  return { overridden, custom, hidden: builtIns.filter((m) => !present.has(m.id)).length };
}
```

Add `PromptMode` to the imports from `../types` if it is not already imported there.

Inside `settingsSnapshot`, before the `return`:

```ts
  const promptCounts = modeCounts(cfg.promptModes, DEFAULT_PROMPT_MODES);
  const reviewCounts = modeCounts(cfg.reviewRequestModes, DEFAULT_REVIEW_REQUEST_MODES);
```

Replace `:86`:

```ts
    prompt_modes_overridden: promptCounts.overridden,
    prompt_modes_custom: promptCounts.custom,
    prompt_modes_hidden: promptCounts.hidden,
```

Replace `:94`:

```ts
    review_modes_overridden: reviewCounts.overridden,
    review_modes_custom: reviewCounts.custom,
    review_modes_hidden: reviewCounts.hidden,
```

Update `docs/TELEMETRY.md`. At `:56`, change the example `prompt_modes_customized: true` to `prompt_modes_overridden: 1`. At `:179`, add the six new field names to the Numbers row. At `:180`, remove `prompt_modes_customized` and `review_modes_customized` from the booleans row.

- [ ] **Step 4: Run the tests**

```bash
npm test && npm run typecheck && npm run build
```

Expected: PASS. `test/unit/extension.test.ts:246` (`prompt_modes_count` is 6) must still pass untouched — the count field is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/events.ts src/telemetry/settingsSnapshot.ts docs/TELEMETRY.md test/unit/telemetry
git commit -m "$(cat <<'EOF'
refactor(telemetry): count how a mode list differs instead of a stale boolean

`prompt_modes_customized` compared the resolved id list against the stock one.
Now that a customized list layers over the built-ins, it contains every stock
id, so the flag read false for users who had customized heavily. Replaced on
both mode settings by overridden / custom / hidden counts. Still counts only —
no label, detail or prompt text.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: One-time notice for the users who will see new modes

**Files:**
- Create: `src/modesNotice.ts`
- Modify: `src/extension.ts:152` — add the call beside `maybeShowTelemetryNotice`
- Test: create `test/unit/modesNotice.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_PROMPT_MODES`, `DEFAULT_REVIEW_REQUEST_MODES` from `./config`; `PromptMode` from `./types`. It does **not** use `resolveModes` (module-private) — it reads `inspect()` itself, because it needs the *raw* entries in order to append to them.
- Produces:
  - `MODES_NOTICE_KEY: string` — the globalState key
  - `LAYERING_DOCS_URL: string`
  - `pickExplicit<T>(i): {value: T; target: vscode.ConfigurationTarget} | undefined` — exported for tests
  - `affectedFromInspect(i, key, builtIns): Affected | undefined` — exported for tests
  - `maybeShowModesNotice(context: vscode.ExtensionContext, opts: {setupRunning: boolean}): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/modesNotice.test.ts`. This mirrors `test/unit/telemetry/notice.test.ts` — the same `ctx()` helper over the mock's `makeMemento()`, the same `_store[KEY]` assertion for the once-ever guard, and `mockResolvedValueOnce` for the button choice. **Do not add a `beforeEach` reset:** `test/_setup.ts` already calls `resetVscodeMocks()` before every test globally.

```ts
import { describe, expect, it, vi } from "vitest";
import * as vscode from "../_mocks/vscode";
import { DEFAULT_PROMPT_MODES } from "../../src/config";
import {
  affectedFromInspect,
  maybeShowModesNotice,
  MODES_NOTICE_KEY,
  pickExplicit,
} from "../../src/modesNotice";

function ctx() {
  return { globalState: vscode.makeMemento() } as never;
}

describe("pickExplicit", () => {
  it("prefers a folder value over workspace and global", () => {
    expect(pickExplicit({ key: "k", workspaceFolderValue: "f", workspaceValue: "w", globalValue: "g" })).toEqual({
      value: "f",
      target: vscode.ConfigurationTarget.WorkspaceFolder,
    });
  });

  it("prefers a workspace value over global", () => {
    expect(pickExplicit({ key: "k", workspaceValue: "w", globalValue: "g" })).toEqual({
      value: "w",
      target: vscode.ConfigurationTarget.Workspace,
    });
  });

  it("falls back to the global value", () => {
    expect(pickExplicit({ key: "k", globalValue: "g" })).toEqual({
      value: "g",
      target: vscode.ConfigurationTarget.Global,
    });
  });

  it("reports nothing when no scope holds a value", () => {
    expect(pickExplicit({ key: "k" })).toBeUndefined();
    expect(pickExplicit(undefined)).toBeUndefined();
  });
});

describe("affectedFromInspect", () => {
  const ids = DEFAULT_PROMPT_MODES.map((m) => m.id);

  it("reports the built-ins a pruned list omits", () => {
    const a = affectedFromInspect(
      { key: "promptModes", globalValue: [{ id: "plan" }, { id: "implementation" }] },
      "promptModes",
      DEFAULT_PROMPT_MODES,
    );
    expect(a?.missing).toEqual(ids.slice(2));
    expect(a?.target).toBe(vscode.ConfigurationTarget.Global);
  });

  it("treats an id the user already hid as listed, not missing", () => {
    const a = affectedFromInspect(
      { key: "promptModes", globalValue: DEFAULT_PROMPT_MODES.map((m) => ({ id: m.id, hidden: true })) },
      "promptModes",
      DEFAULT_PROMPT_MODES,
    );
    expect(a).toBeUndefined();
  });

  it("reports nothing for an untouched setting", () => {
    expect(affectedFromInspect({ key: "promptModes" }, "promptModes", DEFAULT_PROMPT_MODES)).toBeUndefined();
  });

  it("reports nothing for a non-array value", () => {
    expect(
      affectedFromInspect({ key: "promptModes", globalValue: "nope" }, "promptModes", DEFAULT_PROMPT_MODES),
    ).toBeUndefined();
  });

  it("reports every built-in when the list names none of them", () => {
    const a = affectedFromInspect(
      { key: "promptModes", globalValue: [{ id: "spike", label: "S", prompt: "p" }] },
      "promptModes",
      DEFAULT_PROMPT_MODES,
    );
    expect(a?.missing).toEqual(ids);
  });

  it("ignores unusable entries when deciding what is listed", () => {
    const a = affectedFromInspect(
      { key: "promptModes", globalValue: [null, 42, {}, { id: "  plan  " }] },
      "promptModes",
      DEFAULT_PROMPT_MODES,
    );
    expect(a?.missing).toEqual(ids.slice(1));
  });
});

describe("maybeShowModesNotice", () => {
  it("says nothing while first-run setup is on screen, and does not mark itself shown", async () => {
    vscode.setConfig({ promptModes: [{ id: "plan" }] });
    const c = ctx();
    await maybeShowModesNotice(c, { setupRunning: true });
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect((c as any).globalState._store[MODES_NOTICE_KEY]).toBeUndefined();
  });

  it("says nothing to a user who never customized either setting", async () => {
    const c = ctx();
    await maybeShowModesNotice(c, { setupRunning: false });
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    // Not marked shown, so it can still fire if they customize later.
    expect((c as any).globalState._store[MODES_NOTICE_KEY]).toBeUndefined();
  });

  it("says nothing when the list already names every built-in", async () => {
    vscode.setConfig({ promptModes: DEFAULT_PROMPT_MODES.map((m) => ({ id: m.id })) });
    await maybeShowModesNotice(ctx(), { setupRunning: false });
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("shows once and records that it did", async () => {
    vscode.setConfig({ promptModes: [{ id: "plan" }] });
    const c = ctx();
    await maybeShowModesNotice(c, { setupRunning: false });
    await maybeShowModesNotice(c, { setupRunning: false });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect((c as any).globalState._store[MODES_NOTICE_KEY]).toBe(true);
  });

  it("counts the modes about to appear across both settings", async () => {
    vscode.setConfig({
      promptModes: [{ id: "plan" }],
      reviewRequestModes: [{ id: "backend", label: "B", prompt: "p" }],
    });
    await maybeShowModesNotice(ctx(), { setupRunning: false });
    const msg = vscode.window.showInformationMessage.mock.calls[0][0] as string;
    // 5 unlisted prompt modes plus the 1 unlisted review mode.
    expect(msg).toContain("6 new modes are showing");
    expect(msg).toMatch(/layer on top of the built-in ones/);
  });

  it("fires, and reads as singular, when only the review setting is affected", async () => {
    vscode.setConfig({ reviewRequestModes: [{ id: "backend", label: "B", prompt: "p" }] });
    await maybeShowModesNotice(ctx(), { setupRunning: false });
    expect(vscode.window.showInformationMessage.mock.calls[0][0]).toContain("1 new mode is showing");
  });

  it("opens the docs on 'What changed'", async () => {
    vscode.setConfig({ promptModes: [{ id: "plan" }] });
    vscode.window.showInformationMessage.mockResolvedValueOnce("What changed");
    await maybeShowModesNotice(ctx(), { setupRunning: false });
    expect(vscode.env.openExternal).toHaveBeenCalled();
  });

  it("appends hidden entries for exactly the unlisted ids on 'Hide the new ones'", async () => {
    vscode.setConfig({ promptModes: [{ id: "plan" }] });
    vscode.window.showInformationMessage.mockResolvedValueOnce("Hide the new ones");
    await maybeShowModesNotice(ctx(), { setupRunning: false });
    expect(vscode.workspace.getConfiguration("agentFlow").get("promptModes")).toEqual([
      { id: "plan" },
      ...DEFAULT_PROMPT_MODES.slice(1).map((m) => ({ id: m.id, hidden: true })),
    ]);
  });

  it("writes each affected setting independently", async () => {
    vscode.setConfig({
      promptModes: [{ id: "plan" }],
      reviewRequestModes: [{ id: "backend", label: "B", prompt: "p" }],
    });
    vscode.window.showInformationMessage.mockResolvedValueOnce("Hide the new ones");
    await maybeShowModesNotice(ctx(), { setupRunning: false });
    expect(vscode.workspace.getConfiguration("agentFlow").get("reviewRequestModes")).toEqual([
      { id: "backend", label: "B", prompt: "p" },
      { id: "full", hidden: true },
    ]);
  });

  it("writes to the scope the user's value lives in", async () => {
    // The shared mock's `inspect` only ever reports a global value, so this pins
    // the target it passes to `update`; `pickExplicit` covers the other scopes.
    const update = vi.fn(async () => undefined);
    vscode.workspace.getConfiguration.mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn((key: string) =>
        key === "promptModes" ? { key, globalValue: [{ id: "plan" }] } : { key },
      ),
    } as never);
    vscode.window.showInformationMessage.mockResolvedValueOnce("Hide the new ones");
    await maybeShowModesNotice(ctx(), { setupRunning: false });
    expect(update).toHaveBeenCalledWith("promptModes", expect.any(Array), vscode.ConfigurationTarget.Global);
  });

  it("does nothing further when the notification is dismissed", async () => {
    vscode.setConfig({ promptModes: [{ id: "plan" }] });
    await maybeShowModesNotice(ctx(), { setupRunning: false });
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
    expect(vscode.workspace.getConfiguration("agentFlow").get("promptModes")).toEqual([{ id: "plan" }]);
  });

  it("never throws when the notification API fails", async () => {
    vscode.setConfig({ promptModes: [{ id: "plan" }] });
    vscode.window.showInformationMessage.mockRejectedValueOnce(new Error("boom"));
    await expect(maybeShowModesNotice(ctx(), { setupRunning: false })).resolves.toBeUndefined();
  });
});
```

The mock's `showInformationMessage` resolves to `undefined` by default after the global reset, which is why the dismissed case scripts nothing.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- test/unit/modesNotice.test.ts
```

Expected: FAIL — `src/modesNotice.ts` does not exist.

- [ ] **Step 3: Implement the module**

Create `src/modesNotice.ts`:

```ts
import * as vscode from "vscode";
import { DEFAULT_PROMPT_MODES, DEFAULT_REVIEW_REQUEST_MODES } from "./config";
import { PromptMode } from "./types";

export const MODES_NOTICE_KEY = "agentFlow.promptModes.layeringNoticeShown";
export const LAYERING_DOCS_URL = "https://github.com/oznasi1/agent-flow/blob/main/CHANGELOG.md";

const DETAILS = "What changed";
const HIDE = "Hide the new ones";

/** The mode-list settings that layer over built-ins, and what they layer over. */
const MODE_SETTINGS: { key: string; builtIns: PromptMode[] }[] = [
  { key: "promptModes", builtIns: DEFAULT_PROMPT_MODES },
  { key: "reviewRequestModes", builtIns: DEFAULT_REVIEW_REQUEST_MODES },
];

/** A setting whose explicit value omits built-ins, so modes are about to appear. */
interface Affected {
  key: string;
  /** The user's array exactly as authored, so a hide-write appends to it. */
  entries: unknown[];
  /** Built-in ids the user never listed. */
  missing: string[];
  /** The scope the user's value lives in, so the write stays there. */
  target: vscode.ConfigurationTarget;
}

/** Minimal shape of what `WorkspaceConfiguration.inspect` returns, narrowed to
 * the three scopes a user can author. */
interface Inspected<T> {
  workspaceFolderValue?: T;
  workspaceValue?: T;
  globalValue?: T;
}

/** The most specific user-authored value and the scope holding it, matching the
 * folder > workspace > global precedence `explicitConfigValue` uses in config.ts.
 * Returning the scope is the point: a hide-write must land where the user's value
 * already is, never silently promote a workspace override to global. */
export function pickExplicit<T>(
  i: Inspected<T> | undefined,
): { value: T; target: vscode.ConfigurationTarget } | undefined {
  if (!i) return undefined;
  if (i.workspaceFolderValue !== undefined) {
    return { value: i.workspaceFolderValue, target: vscode.ConfigurationTarget.WorkspaceFolder };
  }
  if (i.workspaceValue !== undefined) {
    return { value: i.workspaceValue, target: vscode.ConfigurationTarget.Workspace };
  }
  if (i.globalValue !== undefined) {
    return { value: i.globalValue, target: vscode.ConfigurationTarget.Global };
  }
  return undefined;
}

/** Which built-ins a user's explicit list omits — the modes that layering is
 * about to make appear for them. An id they listed only to hide counts as
 * listed: they already made that choice and nothing is about to change for it.
 * Undefined when the setting is untouched, unusable, or already names them all. */
export function affectedFromInspect(
  i: Inspected<unknown[]> | undefined,
  key: string,
  builtIns: PromptMode[],
): Affected | undefined {
  const explicit = pickExplicit(i);
  if (!explicit || !Array.isArray(explicit.value)) return undefined;
  const listed = new Set<string>();
  for (const raw of explicit.value) {
    if (!raw || typeof raw !== "object") continue;
    const id = (raw as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) listed.add(id.trim());
  }
  const missing = builtIns.filter((m) => !listed.has(m.id)).map((m) => m.id);
  return missing.length ? { key, entries: explicit.value, missing, target: explicit.target } : undefined;
}

/** Tell the users whose customized mode list used to *replace* the built-ins
 * that it now layers over them, so modes they never listed are about to appear.
 * Fires once ever, and only for them — an untouched setting, or one that already
 * names every built-in, says nothing, which is the majority of installs.
 * **Hide the new ones** restores exactly the picker they had.
 *
 * Deferred while first-run setup is on screen, without consuming the key, so it
 * still appears on a later activation. Never throws: a notice that fails to
 * render must not break activation. */
export async function maybeShowModesNotice(
  context: vscode.ExtensionContext,
  opts: { setupRunning: boolean },
): Promise<void> {
  try {
    if (opts.setupRunning) return;
    if (context.globalState.get<boolean>(MODES_NOTICE_KEY)) return;

    const c = vscode.workspace.getConfiguration("agentFlow");
    const affected: Affected[] = [];
    for (const s of MODE_SETTINGS) {
      const a = affectedFromInspect(c.inspect<unknown[]>(s.key), s.key, s.builtIns);
      if (a) affected.push(a);
    }
    if (!affected.length) return;
    await context.globalState.update(MODES_NOTICE_KEY, true);

    const n = affected.reduce((sum, a) => sum + a.missing.length, 0);
    const choice = await vscode.window.showInformationMessage(
      `Your customized prompt modes now layer on top of the built-in ones — ${n} new ` +
        `${n === 1 ? "mode is" : "modes are"} showing.`,
      DETAILS,
      HIDE,
    );
    if (choice === DETAILS) {
      await vscode.env.openExternal(vscode.Uri.parse(LAYERING_DOCS_URL));
    } else if (choice === HIDE) {
      for (const a of affected) {
        const hidden = a.missing.map((id) => ({ id, hidden: true }));
        await c.update(a.key, [...a.entries, ...hidden], a.target);
      }
    }
  } catch {
    // A notice that fails to render must never break activation.
  }
}
```

Then wire it in `src/extension.ts`. Add to the imports beside `:13`:

```ts
import { maybeShowModesNotice } from "./modesNotice";
```

And directly after `src/extension.ts:152`:

```ts
    void maybeShowModesNotice(context, { setupRunning: isFirstEver });
```

- [ ] **Step 4: Run the tests**

```bash
npm test && npm run typecheck && npm run build
```

Expected: PASS. If `test/unit/extension.test.ts` asserts on the exact set of activation side effects, it may need the new call added to an expectation — read the failure before changing anything, and change the test only if the new call is genuinely what it is asserting about.

- [ ] **Step 5: Commit**

```bash
git add src/modesNotice.ts src/extension.ts test/unit/modesNotice.test.ts
git commit -m "$(cat <<'EOF'
feat(config): tell customized users their mode list now layers

Layering means someone who pruned their picker on purpose gets the built-ins
back. This shows them one notification, once, and only if their list actually
omits built-ins — most installs never see it. "Hide the new ones" appends
`hidden: true` for exactly those ids, restoring the picker they had, written to
the scope their value already lives in rather than promoting it to global.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Docs — README and CHANGELOG

**Files:**
- Modify: `README.md:277` and `:282-288` — the settings table row and the prose paragraph
- Modify: `CHANGELOG.md` — the `## [Unreleased]` section (`:8`)

**Interfaces:**
- Consumes: the `hidden` flag and layering behavior from Tasks 1, 2 and 4.
- Produces: nothing consumed by code. No test asserts README prose; `CHANGELOG.md` is not test-asserted either.

- [ ] **Step 1: Update the CHANGELOG**

Under `## [Unreleased]` in `CHANGELOG.md`, add:

```markdown
### Fixed

- `agentFlow.promptModes` and `agentFlow.reviewRequestModes` now **layer over**
  the built-in modes instead of replacing them. A customized list used to freeze
  at the modes that shipped the day it was written, so every mode added later —
  **Test-driven**, **Investigate & root-cause**, **Orchestrator**, **Refine the
  ticket** — was invisible, with nothing in the UI to suggest one was missing.
  Reuse a built-in `id` to override only the fields you set, use a new `id` to
  add a mode of your own, and `{"id": "tdd", "hidden": true}` to drop a built-in.
  Modes you don't list are appended, so future built-ins reach you too. If your
  list omitted built-ins, a one-time notification offers to hide the newcomers
  and keep the picker you had.
```

- [ ] **Step 2: Update the README**

Replace the `agentFlow.reviewRequestModes` row at `README.md:277`:

```markdown
| `agentFlow.reviewRequestModes` | *(one built-in mode)* | Seed modes offered by **Review with agent**, layered over the built-in one. Add your own — e.g. separate backend and frontend review modes — and clicking asks which to use. |
```

In the paragraph at `README.md:282-288`, replace this sentence:

```
Edit those prompts, or add
your own mode, under `agentFlow.promptModes`; pin one with `agentFlow.taskMode` to skip
the question.
```

with:

```
Edit those prompts, or add your own mode, under
`agentFlow.promptModes`; pin one with `agentFlow.taskMode` to skip the question.
Your entries layer over the built-in modes rather than replacing them — reuse a
built-in `id` to override just the fields you set, and add `"hidden": true` to an
entry to drop that built-in — so modes added in a later release still reach you.
```

- [ ] **Step 3: Verify the full gate one last time**

```bash
npm run typecheck && npm run test:cov && npm run build
```

Expected: PASS, with coverage at or above `statements: 90, branches: 85, functions: 85, lines: 90`. If `src/modesNotice.ts` drags branch coverage below the threshold, add the missing-branch tests to `test/unit/modesNotice.test.ts` — do not lower a threshold.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: describe mode-list layering and the hidden flag

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Confirm the reported bug is actually gone**

The original report: a Cursor `settings.json` holding only `plan` and `implementation` showed two modes on a build containing six. Verify against that exact input:

```bash
npx vitest run test/unit/config.test.ts -t "appends built-ins the user never listed"
```

Expected: PASS — the resolved list is all six ids, with the user's two prompts preserved at positions 0 and 1.

---

## Notes for the integrator

- **`agentFlow.taskMode` naming a hidden id needs no code change.** `src/tasksView.ts:1159` resolves it with `modes.find((m) => m.id === cfg.taskMode)`, so an id that layering has resolved away simply isn't found and the picker opens — the existing fallback. Nothing in this plan touches that line; the spec's requirement is satisfied by construction. The same holds for `reviewRequestMode`.
- The version bump, `CHANGELOG` release heading, and `npm run package` happen when this branch merges to main — not here.
- Two notifications can queue on one activation for an affected user (telemetry disclosure on a first-ever run, plus this one). VS Code stacks them; the modes notice only fires for customized users, and a first-ever run has no customizations, so in practice they don't collide.
- A user who prunes their list *after* upgrading will also see the notice, since the trigger is a state, not an upgrade event. That is intentional: they will see modes reappear immediately, and the notice is what explains why.
