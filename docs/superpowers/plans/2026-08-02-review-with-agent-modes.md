# Review-with-agent Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `agentFlow.reviewRequestPrompt` string with a list of named review modes, so clicking **Review with agent** on the Deck's review strip asks which prompt to seed when more than one is configured.

**Architecture:** A new `agentFlow.reviewRequestModes` array (same `{id, label, detail?, prompt}` shape as the existing `agentFlow.promptModes`) plus an `agentFlow.reviewRequestMode` selector (`"ask"` or an id). A pure `resolveReviewMode()` in the review engine decides whether a mode is already determined; `deckView.launchReviewFor` raises a `showQuickPick` when it isn't. The legacy string setting is deprecated in the manifest and migrated into the stock mode at config-read time.

**Tech Stack:** TypeScript, VS Code extension API, Vitest (`npm test`), esbuild. The `vscode` module is aliased to the hand-written mock at `test/_mocks/vscode.ts`; a global `beforeEach` in `test/_setup.ts` resets its config store and mock state between tests.

**Spec:** [docs/superpowers/specs/2026-08-02-review-with-agent-modes-design.md](../specs/2026-08-02-review-with-agent-modes-design.md)

## Global Constraints

- **Placeholders are unchanged.** A review mode's `prompt` may use `{repo}` `{number}` `{author}` `{key}` `{summary}` `{url}` `{brief}` `{files}`. Do not add, remove, or rename any placeholder.
- **A fresh install must not gain a picker.** The shipped default is exactly one mode; one mode short-circuits the QuickPick.
- **`agentFlow.reviewRequestModes` is never empty** as seen by consumers. `getConfig()` guarantees a non-empty array.
- **No user-authored text may reach telemetry.** Mode ids, labels, details and prompts are reduced to counts and booleans only.
- **No webview changes.** `src/webview/ReviewStrip.tsx` and the deck styles are not touched by this plan.
- **Address PR is out of scope.** `agentFlow.prReviewPrompt` and `agentFlow.prReviewAutoFix` are not modified.
- **Run `npm test` and `npm run typecheck` before every commit.** Coverage thresholds are enforced by `vitest.config.ts` (90% statements/lines, 85% branches/functions).
- Copy style in user-facing strings: en-dashes and em-dashes as used in the surrounding settings descriptions; British-ish "prioritised" appears in the shipped prompt and must be preserved byte-for-byte.

---

### Task 1: Config — the modes list, the selector, and the legacy migration

**Files:**
- Modify: `src/config.ts` (add `DEFAULT_REVIEW_REQUEST_MODES` after line 145; add two fields to `AgentFlowConfig`; add two entries to `getConfig()`)
- Modify: `package.json` (three keys in `contributes.configuration.properties`)
- Test: `test/unit/config.test.ts` (extend the `review-request settings` and `package.json ⇄ config constants` describes)

**Interfaces:**
- Consumes: `PromptMode` from `src/types.ts` — `{ id: string; label: string; detail?: string; prompt: string }`. `DEFAULT_REVIEW_REQUEST_PROMPT` and `explicitConfigValue<T>(c, key)` already exist in `src/config.ts`.
- Produces: `export const DEFAULT_REVIEW_REQUEST_MODES: PromptMode[]`; `AgentFlowConfig.reviewRequestModes: PromptMode[]` (never empty); `AgentFlowConfig.reviewRequestMode: string`.

This task is deliberately **additive** — `AgentFlowConfig.reviewRequestPrompt` stays until Task 3 removes its last consumer, so the tree typechecks at every commit.

- [ ] **Step 1: Write the failing tests**

Add these to the existing `describe("review-request settings", ...)` block in `test/unit/config.test.ts` (it ends just before `describe("package.json ⇄ config constants", ...)`):

```ts
  it("defaults to the single stock review mode, asked for each time", () => {
    const c = getConfig();
    expect(c.reviewRequestModes).toEqual(DEFAULT_REVIEW_REQUEST_MODES);
    // The one-mode default is load-bearing: it is what keeps a fresh install's
    // Review-with-agent a single click instead of a click plus a picker.
    expect(c.reviewRequestModes).toHaveLength(1);
    expect(c.reviewRequestModes[0].prompt).toBe(DEFAULT_REVIEW_REQUEST_PROMPT);
    expect(c.reviewRequestMode).toBe("ask");
  });

  it("migrates a customized legacy reviewRequestPrompt into the stock mode", () => {
    setConfig({ reviewRequestPrompt: "just look at it" });
    const modes = getConfig().reviewRequestModes;
    expect(modes).toHaveLength(1);
    expect(modes[0].prompt).toBe("just look at it");
    // Only the prompt is replaced. The mode keeps its identity so that a
    // reviewRequestMode: "full" pin still resolves after the migration.
    expect(modes[0].id).toBe("full");
    expect(modes[0].label).toBe(DEFAULT_REVIEW_REQUEST_MODES[0].label);
  });

  it("lets an explicit modes list beat the deprecated prompt", () => {
    setConfig({
      reviewRequestPrompt: "legacy",
      reviewRequestModes: [{ id: "backend", label: "Backend", prompt: "BE {number}" }],
    });
    expect(getConfig().reviewRequestModes).toEqual([{ id: "backend", label: "Backend", prompt: "BE {number}" }]);
  });

  it("falls back to the stock list for an empty modes array", () => {
    setConfig({ reviewRequestModes: [] });
    expect(getConfig().reviewRequestModes).toEqual(DEFAULT_REVIEW_REQUEST_MODES);
  });

  it("falls back to the stock list when every entry is missing a required field", () => {
    // A mode without `prompt` would seed an empty session — worse than ignoring
    // the setting entirely, so an all-invalid list is treated as no list.
    setConfig({ reviewRequestModes: [{ id: "x", label: "X" }, { label: "No id", prompt: "P" }] });
    expect(getConfig().reviewRequestModes).toEqual(DEFAULT_REVIEW_REQUEST_MODES);
  });

  it("drops only the invalid entries from a mixed modes array", () => {
    setConfig({ reviewRequestModes: [{ id: "ok", label: "OK", prompt: "P" }, { id: "bad", label: "Bad" }] });
    expect(getConfig().reviewRequestModes).toEqual([{ id: "ok", label: "OK", prompt: "P" }]);
  });

  it("honours an explicit reviewRequestMode pin", () => {
    setConfig({ reviewRequestMode: "backend" });
    expect(getConfig().reviewRequestMode).toBe("backend");
  });
```

Add these two to the existing `describe("package.json ⇄ config constants", ...)` block:

```ts
  it("keeps the reviewRequestModes schema default byte-identical to DEFAULT_REVIEW_REQUEST_MODES", () => {
    // Same reasoning as the promptModes parity test above: an untouched setting
    // resolves to the manifest default, so a correct code constant alone reaches nobody.
    expect(props["agentFlow.reviewRequestModes"].default).toEqual(DEFAULT_REVIEW_REQUEST_MODES);
  });

  it("marks the legacy reviewRequestPrompt deprecated and points at its replacement", () => {
    const p = props["agentFlow.reviewRequestPrompt"] as { markdownDeprecationMessage?: string };
    expect(p.markdownDeprecationMessage).toMatch(/reviewRequestModes/);
  });
```

Extend the import at the top of `test/unit/config.test.ts` to pull in the new constant:

```ts
import {
  expandHome,
  getConfig,
  DEFAULT_PROMPT_MODES,
  DEFAULT_EXPLORE_PROMPT,
  DEFAULT_EXPLORE_JIRA_TICKET_PROMPT,
  DEFAULT_EXPLORE_DEBUG_PROMPT,
  DEFAULT_EXPLORE_GENERAL_PROMPT,
  DEFAULT_PR_REVIEW_PROMPT,
  DEFAULT_REVIEW_REQUEST_PROMPT,
  DEFAULT_REVIEW_REQUEST_MODES,
} from "../../src/config";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — `DEFAULT_REVIEW_REQUEST_MODES` is not exported from `src/config.ts` (the file fails to resolve the import).

- [ ] **Step 3: Add the constant to `src/config.ts`**

Insert immediately after the `DEFAULT_REVIEW_REQUEST_PROMPT` declaration (which ends at line 145 with `"…the human submits the review.{files}";`):

```ts
/** The stock review modes offered by **Review with agent**, in picker order.
 * One entry by default: a single mode short-circuits the picker, so a fresh
 * install keeps today's one-click launch. Keep this array identical to the
 * `agentFlow.reviewRequestModes` default in package.json; that manifest default
 * is what VS Code serves to users who never touched the setting. A test
 * enforces the two staying in step. */
export const DEFAULT_REVIEW_REQUEST_MODES: PromptMode[] = [
  {
    id: "full",
    label: "Full review",
    detail: "Correctness, edge cases, tests — findings to .pick-task/REVIEW-<n>.md",
    prompt: DEFAULT_REVIEW_REQUEST_PROMPT,
  },
];
```

- [ ] **Step 4: Add the two fields to `AgentFlowConfig`**

In the `AgentFlowConfig` interface, immediately after the existing:

```ts
  // Seeded prompt for Review-with-agent.
  reviewRequestPrompt: string;
```

add:

```ts
  // Seed modes offered by Review with agent, same shape as promptModes. Never
  // empty — an unusable configured value falls back to DEFAULT_REVIEW_REQUEST_MODES.
  reviewRequestModes: PromptMode[];
  // "ask", or a reviewRequestModes id.
  reviewRequestMode: string;
```

- [ ] **Step 5: Read the two settings in `getConfig()`**

In the returned object literal, immediately after the existing line
`reviewRequestPrompt: c.get<string>("reviewRequestPrompt") || DEFAULT_REVIEW_REQUEST_PROMPT,` add:

```ts
    reviewRequestModes: (() => {
      const m = c.get<PromptMode[]>("reviewRequestModes");
      const valid = Array.isArray(m) ? m.filter((x) => x && x.id && x.label && x.prompt) : [];
      if (valid.length) return valid;
      // Migrate a customized legacy reviewRequestPrompt into the stock mode.
      // Only reached when reviewRequestModes is unset or unusable: an explicit
      // modes list is a deliberate replacement and wins over the deprecated string.
      const legacy = explicitConfigValue<string>(c, "reviewRequestPrompt");
      return legacy ? [{ ...DEFAULT_REVIEW_REQUEST_MODES[0], prompt: legacy }] : DEFAULT_REVIEW_REQUEST_MODES;
    })(),
    reviewRequestMode: c.get<string>("reviewRequestMode") || "ask",
```

- [ ] **Step 6: Add the manifest keys to `package.json`**

In `contributes.configuration.properties`, insert these two keys **between** `agentFlow.reviewWrites` and `agentFlow.reviewRequestPrompt`, so the settings page keeps the review block together and the deprecated key sinks below its replacements:

```json
        "agentFlow.reviewRequestModes": {
          "type": "array",
          "markdownDescription": "Seed modes offered by **Review with agent** on the Deck's review strip. Each has an `id`, `label`, `prompt` template, and an optional `detail` line shown under the label in the picker. Placeholders: `{repo}` `{number}` `{author}` `{key}` `{summary}` `{url}` `{brief}` `{files}`. Add your own — e.g. separate backend and frontend review modes — and with two or more configured, clicking **Review with agent** asks which to use. Pin one with `#agentFlow.reviewRequestMode#` to skip the question.",
          "items": {
            "type": "object",
            "required": [
              "id",
              "label",
              "prompt"
            ],
            "properties": {
              "id": {
                "type": "string",
                "description": "Stable id (used by reviewRequestMode)."
              },
              "label": {
                "type": "string",
                "description": "Shown in the picker."
              },
              "detail": {
                "type": "string",
                "description": "Optional line shown under the label in the picker. Omit it and the mode shows its label only."
              },
              "prompt": {
                "type": "string",
                "description": "Template with {repo} {number} {author} {key} {summary} {url} {brief} {files}."
              }
            }
          },
          "default": [
            {
              "id": "full",
              "label": "Full review",
              "detail": "Correctness, edge cases, tests — findings to .pick-task/REVIEW-<n>.md",
              "prompt": "Review pull request {url} — {repo}#{number}, \"{summary}\", by {author}. Check it out with `gh pr checkout {number} --repo {repo}`, then read the full diff against its base branch. Assess correctness, edge cases, tests, and anything that would break in production. Write your findings to `.pick-task/REVIEW-{number}.md` as a short prioritised list — most serious first, each with the file and line it refers to. Do not post anything to GitHub; the human submits the review.{files}"
            }
          ]
        },
        "agentFlow.reviewRequestMode": {
          "type": "string",
          "default": "ask",
          "markdownDescription": "Which review mode to seed when you click **Review with agent**: `ask` to choose each time, or the `id` of one of `#agentFlow.reviewRequestModes#`. With only one mode configured no picker is shown either way."
        },
```

Then add a deprecation notice to the existing `agentFlow.reviewRequestPrompt` object — keep its `type`, `editPresentation`, `default` and `markdownDescription` exactly as they are and add one property:

```json
          "markdownDeprecationMessage": "Deprecated — use `agentFlow.reviewRequestModes`. If you customized this, its value is migrated into the **Full review** mode automatically.",
```

The `prompt` string in the `default` above must be byte-identical to `DEFAULT_REVIEW_REQUEST_PROMPT`; the parity test from Step 1 fails on any drift, including a changed dash or a straight quote.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/unit/config.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS. Nothing else reads the new fields yet, so no other suite should move.

- [ ] **Step 9: Commit**

```bash
git add src/config.ts package.json test/unit/config.test.ts
git commit -m "feat(config): add reviewRequestModes and reviewRequestMode

Deprecates agentFlow.reviewRequestPrompt and migrates a customized value
into the stock Full review mode, the way explorePrompt was handled."
```

---

### Task 2: `resolveReviewMode` — the pure resolve-or-ask decision

**Files:**
- Modify: `src/engine/review/launch.ts` (add one exported function; extend the `../../types` import)
- Test: `test/unit/engine/review/launch.test.ts` (add one `describe` block)

**Interfaces:**
- Consumes: `PromptMode` from `src/types.ts`; `AgentFlowConfig.reviewRequestModes` / `.reviewRequestMode` from Task 1.
- Produces: `export function resolveReviewMode(modes: PromptMode[], configured: string): PromptMode | null` — the mode to seed without asking, or `null` when the caller must show a picker.

`launchReview` itself is **not** changed: it already takes `template` as a plain string and neither knows nor cares where that string came from.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/engine/review/launch.test.ts`:

```ts
describe("resolveReviewMode", () => {
  const backend: PromptMode = { id: "backend", label: "Backend services", prompt: "BE" };
  const frontend: PromptMode = { id: "frontend", label: "Frontend", prompt: "FE" };

  it("uses the mode the setting names, without asking", () => {
    expect(resolveReviewMode([backend, frontend], "frontend")).toBe(frontend);
  });

  it("asks when the setting is 'ask' and there is a real choice", () => {
    expect(resolveReviewMode([backend, frontend], "ask")).toBeNull();
  });

  it("asks when the setting names a mode that does not exist", () => {
    // A typo shows the picker rather than silently seeding a mode the user
    // didn't name — the same reason an unknown id isn't treated as the first one.
    expect(resolveReviewMode([backend, frontend], "backnd")).toBeNull();
  });

  it("never asks when there is only one mode, whatever the setting says", () => {
    // The one-mode short-circuit is what keeps a default install a single click.
    expect(resolveReviewMode([backend], "ask")).toBe(backend);
    expect(resolveReviewMode([backend], "nonsense")).toBe(backend);
    expect(resolveReviewMode([backend], "backend")).toBe(backend);
  });
});
```

Extend the type import at the top of that file:

```ts
import type { PromptMode, ReviewRequest } from "../../../../src/types";
```

and the value import:

```ts
import { reviewRunKey, renderReviewTemplate, launchReview, resolveReviewMode } from "../../../../src/engine/review/launch";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/review/launch.test.ts`
Expected: FAIL — `resolveReviewMode is not a function`.

- [ ] **Step 3: Implement it**

In `src/engine/review/launch.ts`, widen the existing types import:

```ts
import { PromptMode, ReviewRequest, ServiceRef } from "../../types";
```

and add, immediately after `renderReviewTemplate` (before `export interface LaunchReviewRequest`):

```ts
/** The review mode to seed without asking, or null when the user must pick.
 * Two ways to skip the picker: `configured` names a real mode, or there is only
 * one mode to offer — a QuickPick with a single item is friction, not a choice.
 * An id that matches nothing falls through to the picker rather than to the
 * first mode: a typo should ask, not quietly seed a prompt nobody named.
 * `modes` is never empty; getConfig guarantees that. */
export function resolveReviewMode(modes: PromptMode[], configured: string): PromptMode | null {
  const pinned = modes.find((m) => m.id === configured);
  if (pinned) return pinned;
  return modes.length === 1 ? modes[0] : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/review/launch.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/engine/review/launch.ts test/unit/engine/review/launch.test.ts
git commit -m "feat(review): add resolveReviewMode, the resolve-or-ask decision"
```

---

### Task 3: The picker on **Review with agent**, and retiring the legacy field

**Files:**
- Modify: `src/deckView.ts` (extend the `./engine/review/launch` import; rewrite `launchReviewFor` at lines 352-369)
- Modify: `src/config.ts` (remove `reviewRequestPrompt` from `AgentFlowConfig` and from `getConfig()`'s return)
- Test: `test/unit/deckView.test.ts` (extend the `DeckPanel review launch` describe; extend the mock import)
- Test: `test/unit/config.test.ts` (drop the three assertions that read the removed field)
- Test: `test/unit/tasksView.test.ts:124` (delete the now-stale `reviewRequestPrompt` fixture line)

**Interfaces:**
- Consumes: `resolveReviewMode(modes, configured)` from Task 2; `cfg.reviewRequestModes` / `cfg.reviewRequestMode` from Task 1; the existing `launchReview({ req, template, workspaceDir, seedAgent }, deps)`.
- Produces: nothing new for later tasks — this is the wiring task. After it, `AgentFlowConfig.reviewRequestPrompt` no longer exists; `DEFAULT_REVIEW_REQUEST_PROMPT` stays exported as the `full` mode's `prompt`.

`test/unit/deckView.test.ts` mocks the launch module with `{ ...actual, launchReview: … }`, so `resolveReviewMode` resolves to the real implementation and the mock needs no change.

- [ ] **Step 1: Write the failing tests**

Extend the mock import at line 2 of `test/unit/deckView.test.ts` with `setConfig`:

```ts
import { window, ViewColumn, env, workspace, setConfig } from "../_mocks/vscode";
```

Add these to `describe("DeckPanel review launch", ...)`:

```ts
  const TWO_MODES = [
    { id: "backend", label: "Backend services", detail: "Backend review skill", prompt: "BE {number}" },
    { id: "frontend", label: "Frontend", detail: "Frontend review skill", prompt: "FE {number}" },
  ];

  it("does not ask which mode to use when only the stock one is configured", async () => {
    // The no-regression guard: an install that never touched the setting must
    // still launch a review in one click.
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(h.launchReview).toHaveBeenCalled();
  });

  it("asks which mode to use and seeds the one picked", async () => {
    setConfig({ reviewRequestModes: TWO_MODES });
    window.showQuickPick.mockResolvedValueOnce({ label: "Frontend", mode: TWO_MODES[1] });
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
    // The picked mode's own template, not merely some template: an
    // implementation that always seeded modes[0] would pass a looser check.
    expect(h.launchReview).toHaveBeenCalledWith(
      expect.objectContaining({ template: "FE {number}" }),
      expect.anything(),
    );
  });

  it("offers every configured mode, label and detail", async () => {
    setConfig({ reviewRequestModes: TWO_MODES });
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(window.showQuickPick).toHaveBeenCalledWith(
      [
        expect.objectContaining({ label: "Backend services", detail: "Backend review skill" }),
        expect.objectContaining({ label: "Frontend", detail: "Frontend review skill" }),
      ],
      expect.objectContaining({ title: "Review aws-ops#8491" }),
    );
  });

  it("creates nothing when the mode picker is cancelled", async () => {
    setConfig({ reviewRequestModes: TWO_MODES });
    window.showQuickPick.mockResolvedValueOnce(undefined);
    const p = await showAndWarm();
    const before = posts(p).length;
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    // launchReview is what creates the worktree and opens the window, so
    // asserting it was never reached is asserting no side effect happened —
    // stronger than checking for the absence of a toast.
    expect(h.launchReview).not.toHaveBeenCalled();
    expect(posts(p).slice(before).some((m) => m.type === "toast")).toBe(false);
  });

  it("skips the picker when a mode is pinned, and seeds that one", async () => {
    setConfig({ reviewRequestModes: TWO_MODES, reviewRequestMode: "backend" });
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(h.launchReview).toHaveBeenCalledWith(
      expect.objectContaining({ template: "BE {number}" }),
      expect.anything(),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/deckView.test.ts -t "review launch"`
Expected: FAIL — the picker is never shown, so "asks which mode to use and seeds the one picked" reports `showQuickPick` called 0 times, and the template is the built-in prompt rather than `"FE {number}"`.

- [ ] **Step 3: Wire the picker in `src/deckView.ts`**

Extend the existing import:

```ts
import { launchReview, resolveReviewMode, reviewRunKey } from "./engine/review/launch";
```

Replace the body of `launchReviewFor` (lines 352-369) with:

```ts
  private async launchReviewFor(id: string): Promise<void> {
    const req = this.reviewById(id);
    if (!req) return; // the queue moved on before the click landed
    const cfg = getConfig();
    // Resolve — or ask — before launchReview runs, because launchReview's first
    // act is createWorktrees. A picker raised any later would leave a worktree
    // and a branch behind every time someone pressed Escape.
    const mode =
      resolveReviewMode(cfg.reviewRequestModes, cfg.reviewRequestMode) ??
      (await vscode.window.showQuickPick(
        cfg.reviewRequestModes.map((m) => ({ label: m.label, detail: m.detail, mode: m })),
        { title: `Review ${req.repoName}#${req.number}`, ignoreFocusOut: true },
      ))?.mode;
    if (!mode) return; // picker cancelled — no worktree, no window, no toast
    const res = await launchReview(
      { req, template: mode.prompt, workspaceDir: cfg.workspaceDir, seedAgent: cfg.seedAgent },
      { createWorktrees, openWorkspace, log: this.log },
    );
    if (!res.ok) {
      this.toast("error", res.message);
      return;
    }
    this.toast(
      "success",
      `Reviewing ${req.repoName}#${req.number} in a worktree.${cfg.seedAgent ? " Claude Code pre-seeded — press Enter to start." : ""}`,
    );
    await this.refreshBusy(); // picks up the new run so the row shows "reviewing"
  }
```

- [ ] **Step 4: Run the deck tests to verify they pass**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: PASS.

- [ ] **Step 5: Remove the now-dead `reviewRequestPrompt` from the config surface**

In `src/config.ts`, delete from the `AgentFlowConfig` interface:

```ts
  // Seeded prompt for Review-with-agent.
  reviewRequestPrompt: string;
```

and delete from `getConfig()`'s returned object:

```ts
    reviewRequestPrompt: c.get<string>("reviewRequestPrompt") || DEFAULT_REVIEW_REQUEST_PROMPT,
```

Keep `export const DEFAULT_REVIEW_REQUEST_PROMPT` — it is the `full` mode's `prompt` and the parity test's comparison value. Keep the `agentFlow.reviewRequestPrompt` key in `package.json`: it is deprecated, still read by the Task 1 migration, and removing it would silently discard existing users' customizations.

- [ ] **Step 6: Drop the stale assertions and fixture**

In `test/unit/config.test.ts`, inside `describe("review-request settings", ...)`:

- from `it("defaults to the strip on, a 5-minute TTL, and writes off", ...)`, delete the three `c.reviewRequestPrompt` assertions. The two safety properties they guarded — where findings go, and that nothing is posted to GitHub — move onto the stock mode, so replace them with:

```ts
    // Both safety properties of the stock mode's prompt, not just a loose
    // substring: where findings go, and that nothing gets posted automatically.
    expect(c.reviewRequestModes[0].prompt).toContain(".pick-task/REVIEW-{number}.md");
    expect(c.reviewRequestModes[0].prompt).toMatch(/do not post/i);
```

- delete `it("honours an explicit prompt override", ...)` and `it("falls back to the default prompt for an empty override", ...)` outright — the migration tests added in Task 1 cover both paths through the legacy setting.

In `test/unit/tasksView.test.ts`, delete line 124:

```ts
  reviewRequestPrompt: "Review {url}{files}",
```

`CFG` there is an untyped literal and `tasksView` never read the field, so nothing replaces it.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors. If `npm run typecheck` reports `reviewRequestPrompt` on any other file, that file is an unlisted consumer — read it and migrate it to `reviewRequestModes` rather than restoring the field.

- [ ] **Step 8: Commit**

```bash
git add src/deckView.ts src/config.ts test/unit/deckView.test.ts test/unit/config.test.ts test/unit/tasksView.test.ts
git commit -m "feat(deck): ask which review mode to seed on Review with agent

The picker is raised before launchReview so a cancelled pick leaves no
worktree behind. Retires the now-unread AgentFlowConfig.reviewRequestPrompt;
the deprecated setting itself stays, still migrated at read time."
```

---

### Task 4: Telemetry — three shape-only properties

**Files:**
- Modify: `src/telemetry/events.ts` (add `STOCK_REVIEW_MODES`; three fields on `SettingsSnapshot`; update the field-count in its doc comment)
- Modify: `src/telemetry/settingsSnapshot.ts` (generalize `taskModeProp` to `modeProp`; add three properties; update the module doc comment)
- Modify: `docs/TELEMETRY.md` (lines 45-58 and the property table at lines 170-180)
- Test: `test/unit/telemetry/settingsSnapshot.test.ts`

**Interfaces:**
- Consumes: `cfg.reviewRequestModes` / `cfg.reviewRequestMode` from Task 1; `DEFAULT_REVIEW_REQUEST_MODES` from Task 1; the existing `TaskModeProp = "ask" | "stock" | "custom"`.
- Produces: `SettingsSnapshot.review_mode: TaskModeProp`, `.review_modes_count: number`, `.review_modes_customized: boolean`.

`TaskModeProp` is reused rather than duplicated — its three values describe any "ask or a mode id" setting, and a second identical type alias would be noise.

- [ ] **Step 1: Write the failing tests**

In `test/unit/telemetry/settingsSnapshot.test.ts`, add to `it("reports the shipped defaults", ...)`:

```ts
    expect(s.review_mode).toBe("ask");
    expect(s.review_modes_count).toBe(1);
    expect(s.review_modes_customized).toBe(false);
```

and add three new tests after `it("reports a shipped taskMode id as 'stock'", ...)`:

```ts
  it("collapses a user-authored reviewRequestMode id to 'custom'", () => {
    const cfg = { ...getConfig(), reviewRequestMode: "acme-backend" };
    const s = settingsSnapshot(cfg);
    expect(s.review_mode).toBe("custom");
    expect(JSON.stringify(s)).not.toContain("acme-backend");
  });

  it("reports the shipped reviewRequestMode id as 'stock'", () => {
    expect(settingsSnapshot({ ...getConfig(), reviewRequestMode: "full" }).review_mode).toBe("stock");
  });

  it("flags customized review modes without revealing them", () => {
    const cfg = {
      ...getConfig(),
      reviewRequestModes: [
        { id: "acme-backend", label: "Backend services", detail: "D", prompt: "P" },
        { id: "acme-frontend", label: "Frontend", detail: "D", prompt: "P" },
      ],
    };
    const s = settingsSnapshot(cfg);
    expect(s.review_modes_customized).toBe(true);
    expect(s.review_modes_count).toBe(2);
    expect(JSON.stringify(s)).not.toContain("acme-");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/telemetry/settingsSnapshot.test.ts`
Expected: FAIL — `s.review_mode` is `undefined`, and TypeScript reports `review_mode` does not exist on `SettingsSnapshot`.

- [ ] **Step 3: Extend the event catalog**

In `src/telemetry/events.ts`, add immediately after the existing `STOCK_PROMPT_MODES` / `StockPromptMode` / `PromptModeProp` / `toPromptModeProp` block:

```ts
/** The single review mode shipped in DEFAULT_REVIEW_REQUEST_MODES.
 * `agentFlow.reviewRequestModes` is user-configurable, so a custom mode's id is
 * a user-authored string and must never be sent — modeProp() in
 * settingsSnapshot.ts collapses anything unrecognised to "custom". */
export const STOCK_REVIEW_MODES = ["full"] as const;
```

In the `SettingsSnapshot` interface, add after `pr_review_prompt_customized: boolean;`:

```ts
  review_mode: TaskModeProp;
  review_modes_count: number;
  review_modes_customized: boolean;
```

In that interface's doc comment, change `The 24 safe reductions of AgentFlowConfig` to `The 27 safe reductions of AgentFlowConfig`.

- [ ] **Step 4: Build the properties in `settingsSnapshot.ts`**

Widen both imports at the top of `src/telemetry/settingsSnapshot.ts`:

```ts
import {
  AgentFlowConfig, DEFAULT_EXPLORE_ACTIONS, DEFAULT_PR_REVIEW_PROMPT, DEFAULT_PROMPT_MODES,
  DEFAULT_REVIEW_REQUEST_MODES,
} from "../config";
import { SettingsSnapshot, STOCK_PROMPT_MODES, STOCK_REVIEW_MODES, TaskModeProp } from "./events";
```

Replace the `taskModeProp` function (lines 4-7) with a general one:

```ts
/** Collapse an "ask, or a mode id" setting to a shape-only value. A custom id is
 * user-authored text and must never be transmitted; it becomes "custom". */
function modeProp(value: string, stock: readonly string[]): TaskModeProp {
  if (value === "ask") return "ask";
  return stock.includes(value) ? "stock" : "custom";
}
```

Add beside the existing `STOCK_PROMPT_MODE_IDS`:

```ts
const STOCK_REVIEW_MODE_IDS = DEFAULT_REVIEW_REQUEST_MODES.map((m) => m.id).join(",");
```

In the returned object, change `task_mode: taskModeProp(cfg.taskMode),` to:

```ts
    task_mode: modeProp(cfg.taskMode, STOCK_PROMPT_MODES),
```

and add after `pr_review_prompt_customized: …`:

```ts
    review_mode: modeProp(cfg.reviewRequestMode, STOCK_REVIEW_MODES),
    review_modes_count: cfg.reviewRequestModes.length,
    review_modes_customized: cfg.reviewRequestModes.map((m) => m.id).join(",") !== STOCK_REVIEW_MODE_IDS,
```

In the module doc comment above `settingsSnapshot`, change the phrase `prReviewStatus, reviewRequestPrompt and every *Prompt` to `prReviewStatus, reviewRequestModes and every *Prompt`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/telemetry/ && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Update `docs/TELEMETRY.md`**

In the "What is never collected" list (around line 52), change:

```
  `reviewRequestPrompt`, or any of the `*Prompt` / `promptModes` /
```

to:

```
  `reviewRequestModes`, or any of the `*Prompt` / `promptModes` /
```

At line 170, change `includes a 24-field reduction of your configuration` to `includes a 27-field reduction of your configuration`.

In the property table, add `review_mode` to the `task_mode` row, `review_modes_count` to the numbers row, and `review_modes_customized` to the booleans-about-customization row, so those three rows read:

```
| `task_mode`, `review_mode` | `"ask"`, `"stock"` (pinned to a shipped mode), or `"custom"` |
| `batch_confirm_threshold`, `repo_blocklist_count`, `prompt_modes_count`, `review_modes_count` | Numbers |
| `prompt_modes_customized`, `explore_prompts_customized`, `pr_review_prompt_customized`, `review_modes_customized` | `true` / `false` — *whether* the corresponding user-authored text was changed from the shipped default, never the text itself |
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS — including `test/unit/telemetry/docs.test.ts`, which checks that `docs/TELEMETRY.md` documents every catalogued event.

- [ ] **Step 8: Commit**

```bash
git add src/telemetry/events.ts src/telemetry/settingsSnapshot.ts test/unit/telemetry/settingsSnapshot.test.ts docs/TELEMETRY.md
git commit -m "feat(telemetry): report review-mode shape without the text

review_mode, review_modes_count and review_modes_customized. A custom mode
id collapses to \"custom\", the way task_mode has always handled promptModes."
```

---

### Task 5: User-facing documentation

**Files:**
- Modify: `README.md` (the settings table around line 256, and the prose paragraph that follows at lines 259-266)
- Modify: `CHANGELOG.md` (the `## [Unreleased]` section)

**Interfaces:**
- Consumes: the settings and behaviour built in Tasks 1-4. Produces nothing consumed by code.

- [ ] **Step 1: Update the README settings table**

Replace this row:

```
| `agentFlow.reviewRequestPrompt` | *(built-in)* | Prompt seeded by **Review with agent**. |
```

with these two:

```
| `agentFlow.reviewRequestModes` | *(one built-in mode)* | Seed modes offered by **Review with agent**. Add your own — e.g. separate backend and frontend review modes — and clicking asks which to use. |
| `agentFlow.reviewRequestMode` | `ask` | Pin one review mode by `id` to skip the question. |
```

- [ ] **Step 2: Update the README prose**

The paragraph beginning `Plus \`agentFlow.workspaceMode\`, …` currently ends with the **Address PR** sentence. Add one sentence about review modes immediately before that sentence, so the passage reads:

```
Plus `agentFlow.workspaceMode`, `agentFlow.taskMode`, `agentFlow.promptModes`,
`agentFlow.exploreMode`, `agentFlow.explorePrompts.*`, `agentFlow.prReviewPrompt`, and
`agentFlow.worktree` — see the Settings UI. Taking a task asks how the agent should
start: **Plan first**, **Implementation**, **Test-driven**, **Investigate &
root-cause**, **Orchestrator**, or **Refine the ticket**. Edit those prompts, or add
your own mode, under `agentFlow.promptModes`; pin one with `agentFlow.taskMode` to skip
the question. **Review with agent** works the same way on its own list: one **Full
review** mode ships, and once you add a second — a backend-services reviewer and a
frontend one, say — clicking asks which to seed. Pin one with
`agentFlow.reviewRequestMode`. The **Address PR** kick-off always runs in a worktree.
Per-task worktrees are created inside each repo at `.claude/worktrees/<KEY>` (and
git-excluded automatically).
```

- [ ] **Step 3: Add the changelog entry**

Under `## [Unreleased]`, add:

```markdown
### Added

- **Review with agent can offer more than one seed prompt.** The new
  `agentFlow.reviewRequestModes` holds a list of named review modes — same shape as
  `agentFlow.promptModes` — and with two or more configured, clicking **Review with
  agent** asks which to seed. Written for reviewers who keep separate review skills per
  area, e.g. one for backend services and one for frontend. Pin one with
  `agentFlow.reviewRequestMode` to skip the question. One **Full review** mode ships, so
  an install that changes nothing still launches a review in a single click.

### Deprecated

- `agentFlow.reviewRequestPrompt` — superseded by `agentFlow.reviewRequestModes`. A value
  you customized is migrated into the **Full review** mode automatically; nothing to do.
```

- [ ] **Step 4: Verify nothing regressed**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document review modes for Review with agent"
```

---

## Manual verification

Not automated; run once after Task 5 with `npm run build` and the extension loaded in a development host.

1. With no settings changed, open the Deck and click **▶ Review with agent** on a PR whose repo is checked out. It must launch immediately — **no picker**.
2. Add two modes to `agentFlow.reviewRequestModes` (ids `backend` and `frontend`, distinguishable prompts). Click again: a QuickPick titled `Review <repo>#<number>` lists both with their `detail` lines.
3. Pick one, and confirm the seeded Claude Code prompt in the opened window is that mode's template with `{repo}`/`{number}`/`{author}` filled in.
4. Click again and press Escape. Confirm no window opens, no toast appears, and `ls <repo>/.claude/worktrees/` has gained nothing.
5. Set `agentFlow.reviewRequestMode` to `backend`. Click: no picker, and the backend prompt is seeded.
6. In a profile that has a customized `agentFlow.reviewRequestPrompt` and no `reviewRequestModes`, confirm the settings page shows the old key struck through with the deprecation notice, and that clicking still seeds the customized text.
