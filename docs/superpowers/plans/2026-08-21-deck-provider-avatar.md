# Deck Provider Avatar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show which agent tool is driving each Deck card, as a small brand mark on the corner of the card's existing kind tile, and show which model each session is answering with, on its row in the detail drawer.

**Architecture:** Two new optional facts flow host → webview. `Run.provider` is stamped at launch from the value `openWorkspace` already resolved; `AgentActivity.model` is read from transcript lines the activity sweep already parses. `buildRunStatus` is the single place that combines the record's stamp with an inference (a live Claude Code session means `claude-code`) into `RunStatus.provider`. The webview renders the field or renders nothing — it never infers. Every new field is optional and every new mark is absent when unknown, so the feature ships inert for existing users and no existing test changes.

**Tech Stack:** TypeScript, React (webview bundled by esbuild for a browser target), Vitest + @testing-library/react, CSS-in-TS style strings (`src/webview/deckStyles.ts`).

**Spec:** `docs/superpowers/specs/2026-08-21-deck-provider-avatar-design.md`

## Global Constraints

- **Never break existing users.** This extension has thousands of installs. Every new type field is optional (`?`), every new mark is absent when its input is absent, and **no existing test may be edited** to accommodate this work. If an existing test fails, the implementation is wrong, not the test.
- **The webview cannot reach `fs`.** `src/webview/**` must not import `fs`, `os`, `path`, `child_process`, or any module that transitively does. `tsc` and the full Vitest suite both pass anyway when this is violated — only `npm run build` catches it. `test/webview/webviewGraph.test.ts` walks the real import graph and must keep passing unedited.
- **Gates, all of which must pass before the final commit:**
  - `npm run typecheck` (`tsc --noEmit`)
  - `npm run build` (the only gate that catches a Node builtin in the webview graph)
  - `npm test` — takes ~220s, which exceeds the default Bash timeout. **Invoke it with an explicit timeout of 600000 ms** or it will appear to hang.
  - `npm run test:cov` — thresholds in `vitest.config.ts` are statements 90 / branches 85 / functions 85 / lines 90. Files changed by this plan should land at ≥95%.
- **Mutation-check every new test.** After a test passes, break the exact implementation line it claims to cover, re-run, and confirm the test fails. A test that passes against a deliberately broken implementation is not coverage — delete or rewrite it.
- **Comment style:** this codebase explains *why* in prose comments above non-obvious code, and does not comment the obvious. Match the density of the surrounding file. Do not add comments that restate the code.
- **Model label rule, used verbatim wherever a model is displayed:** strip a leading `claude-` and a trailing `-YYYYMMDD`; strip nothing else.
- **Brand hues:** `claude-code` → `#D97757` (Anthropic's own, from the `claude-logo.svg` shipped inside the Claude Code extension). `copilot` and `cursor` → theme ink, `color-mix(in srgb, var(--vscode-foreground) 72%, transparent)`; neither brand has a colour that survives a dark theme.
- **Badge geometry:** 15px plate, `border-radius: 5px`, offset `right: -5px; bottom: -5px`, 11px mark inside.

---

### Task 1: Move `AgentProvider` into `types.ts`

The webview needs this type to render a per-provider mark. It currently lives in `src/config.ts`, which imports `vscode` — unreachable from the webview's browser bundle. Move the declaration, re-export it from `config.ts` so every existing importer keeps working.

**Files:**
- Modify: `src/types.ts` (add the type near the other shared host↔webview unions)
- Modify: `src/config.ts:150` (replace the declaration with a re-export)
- Test: `test/webview/webviewGraph.test.ts` (must keep passing, unedited)

**Interfaces:**
- Consumes: nothing.
- Produces: `export type AgentProvider = "claude-code" | "copilot" | "cursor"` from `src/types.ts`, and the same name still importable from `src/config.ts`.

- [ ] **Step 1: Add the type to `src/types.ts`**

Insert immediately above the `OpenSession` interface (around `src/types.ts:181`), which is declared there for this exact reason:

```ts
/** Which agent Agent Flow starts a session with. Declared here rather than in
 * config.ts because the webview renders a per-provider mark and must not import a
 * module that touches `vscode`; config.ts re-exports it, so every existing importer
 * keeps working. */
export type AgentProvider = "claude-code" | "copilot" | "cursor";
```

- [ ] **Step 2: Replace the declaration in `src/config.ts`**

Find this at `src/config.ts:149-150`:

```ts
/** Which agent Agent Flow starts a session with. */
export type AgentProvider = "claude-code" | "copilot" | "cursor";
```

Replace it with a re-export. `config.ts` already imports from `./types` at line 4 — add `AgentProvider` to that existing `import type { ... } from "./types"` statement if it fits the file's style, or use the standalone re-export below:

```ts
/** Which agent Agent Flow starts a session with. Declared in ./types so the webview
 * can name a provider without importing this module (which imports `vscode`); re-exported
 * here because every caller in the host addresses it at this path. */
export type { AgentProvider } from "./types";
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS with no errors. If a file complains about importing `AgentProvider`, the re-export is missing or misspelled — fix the re-export, do not change the importer.

- [ ] **Step 4: Confirm the webview graph is still clean**

Run: `npx vitest run test/webview/webviewGraph.test.ts`
Expected: PASS, unedited. This is the test that proves the move did not drag `vscode` into a webview bundle.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: succeeds, `dist/` written.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts
git commit -m "refactor(types): declare AgentProvider in types.ts so the webview can name one"
```

---

### Task 2: `deriveActivity` reads the model off the transcript tail

The model is in lines `parseLines` already parses (it tails 200 lines per session per sweep), so this is pure extraction — no new I/O.

**Files:**
- Modify: `src/types.ts` (two fields on `AgentActivity`)
- Modify: `src/engine/transcript.ts:10-18` (`TranscriptLine`) and `:35` (`deriveActivity`)
- Test: `test/unit/engine/transcript.test.ts` (add cases to the existing `describe("deriveActivity")`)

**Interfaces:**
- Consumes: `AgentProvider` is not needed here.
- Produces: `AgentActivity.model?: string | null` and `AgentActivity.modelCount?: number`, populated by `deriveActivity(lines, mtimeMs, nowMs)` on every return path.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/engine/transcript.test.ts`, inside the existing `describe("deriveActivity")` block so its `NOW` and `line` helpers are in scope:

```ts
  const asstModel = (model: string, sidechain = false): TranscriptLine =>
    line({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", model }, ...(sidechain ? { isSidechain: true } : {}) });

  it("reports the model of the last main-chain assistant line", () => {
    const a = deriveActivity([asstModel("claude-opus-5")], NOW - 1000, NOW);
    expect(a.model).toBe("claude-opus-5");
    expect(a.modelCount).toBe(1);
  });

  it("counts distinct main-chain models when a session switched mid-run", () => {
    // Real case: fast mode switches the model inside one session, so a tail holds
    // both. The drawer marks that with a "+N" and needs the count to do it.
    const a = deriveActivity(
      [asstModel("claude-opus-5"), asstModel("claude-fable-5"), asstModel("claude-opus-5")],
      NOW - 1000, NOW,
    );
    expect(a.model).toBe("claude-opus-5");
    expect(a.modelCount).toBe(2);
  });

  it("ignores a subagent's model even when it is the last line", () => {
    // A main session that dispatches a subagent must not report the subagent's
    // model as its own: sidechain lines are somebody else's turn.
    const a = deriveActivity([asstModel("claude-opus-5"), asstModel("claude-haiku-4-5", true)], NOW - 1000, NOW);
    expect(a.model).toBe("claude-opus-5");
    expect(a.modelCount).toBe(1);
  });

  it("has no model when the tail carries only subagent turns", () => {
    const a = deriveActivity([asstModel("claude-haiku-4-5", true)], NOW - 1000, NOW);
    expect(a.model).toBeNull();
    expect(a.modelCount).toBe(0);
  });

  it("has no model on a transcript with nothing meaningful in it", () => {
    const a = deriveActivity([snapshot], NOW - 1000, NOW);
    expect(a.state).toBe("unknown");
    expect(a.model).toBeNull();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/engine/transcript.test.ts -t "model"`
Expected: FAIL — `expect(received).toBe(expected)` with `received: undefined`, because `deriveActivity` does not set the field yet. (`TranscriptLine` will also reject `isSidechain` and `message.model` at typecheck time; that is the same failure.)

- [ ] **Step 3: Widen `TranscriptLine`**

In `src/engine/transcript.ts`, the interface at line 10 becomes:

```ts
/** The subset of a Claude Code transcript line we read. */
export interface TranscriptLine {
  type?: string; // "user" | "assistant" | "attachment" | "file-history-snapshot" | …
  timestamp?: string; // ISO
  gitBranch?: string;
  cwd?: string;
  slug?: string;
  /** True on a subagent's turn. Its `message.model` is the subagent's, not this
   * session's, so the model read skips these. */
  isSidechain?: boolean;
  message?: { role?: string; stop_reason?: string | null; model?: string };
}
```

- [ ] **Step 4: Add the two fields to `AgentActivity`**

In `src/types.ts`, inside `interface AgentActivity` (line 229), after `slug`:

```ts
  /** The model the last main-chain assistant line answered with, e.g. "claude-opus-5".
   * Null when the tail carries no such line — a transcript whose last 200 lines are all
   * subagent work, or a session that has not answered yet. Optional so every existing
   * AgentActivity literal (the test suite is full of them) still compiles. */
  model?: string | null;
  /** How many DISTINCT main-chain models the tail holds. 1 in the ordinary case, more
   * when the session switched mid-run — which the drawer marks with a "+N". */
  modelCount?: number;
```

- [ ] **Step 5: Derive it in `deriveActivity`**

In `src/engine/transcript.ts`, add this helper above `deriveActivity`:

```ts
/** The model this session is answering with, and how many it has used, from the tail.
 * Main chain only: a sidechain line is a subagent's turn and carries the subagent's
 * model, which is not this session's answer. One session legitimately holds several —
 * fast mode switches models mid-run — so the count travels with the current one. */
function modelOf(lines: TranscriptLine[]): { model: string | null; modelCount: number } {
  const models = lines
    .filter((l) => l.type === "assistant" && !l.isSidechain && l.message?.model)
    .map((l) => l.message!.model!);
  return { model: models.length > 0 ? models[models.length - 1] : null, modelCount: new Set(models).size };
}
```

Then spread it into **every** return path of `deriveActivity`. The function currently has six returns; each gains `...modelOf(lines)`. Compute it once at the top:

```ts
export function deriveActivity(lines: TranscriptLine[], mtimeMs: number, nowMs: number): AgentActivity {
  const slug = [...lines].reverse().find((l) => l.slug)?.slug ?? null;
  const model = modelOf(lines);
  const meaningful = lines.filter((l) => l.type === "user" || l.type === "assistant");
  if (meaningful.length === 0) return { state: "unknown", lastActivityMs: mtimeMs ?? null, slug, midWork: false, ...model };

  const last = meaningful[meaningful.length - 1];
  if (last.type === "assistant" && last.message?.stop_reason === "end_turn") {
    return { state: "needs-you", lastActivityMs: mtimeMs, slug, midWork: false, ...model };
  }
  const pendingTool = last.type === "assistant" && last.message?.stop_reason === "tool_use";
  const midWork = pendingTool || last.type === "user";
  const age = nowMs - mtimeMs;
  if (age <= WORKING_WINDOW_MS) return { state: "working", lastActivityMs: mtimeMs, slug, midWork, ...model };
  if (pendingTool) return { state: "stalled", lastActivityMs: mtimeMs, slug, midWork, ...model };
  return { state: "idle", lastActivityMs: mtimeMs, slug, midWork, ...model };
}
```

Keep every existing comment inside the function exactly where it is — only the return literals change.

- [ ] **Step 6: Run the new tests**

Run: `npx vitest run test/unit/engine/transcript.test.ts`
Expected: PASS — the new cases and every pre-existing case in the file.

- [ ] **Step 7: Mutation-check**

Delete `&& !l.isSidechain` from the filter in `modelOf`, re-run `npx vitest run test/unit/engine/transcript.test.ts`, and confirm "ignores a subagent's model even when it is the last line" FAILS. Restore the code and confirm PASS.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/engine/transcript.ts test/unit/engine/transcript.test.ts
git commit -m "feat(deck): read the answering model off the transcript tail"
```

---

### Task 3: Stamp `Run.provider` at launch

**Files:**
- Modify: `src/types.ts` (one field on `Run`)
- Modify: `src/engine/workspace.ts:542` (the `Run` literal in `openWorkspace`)
- Modify: `src/engine/batchWorkspace.ts:194` (the `Run` literal in the `tasks.forEach`)
- Test: `test/unit/engine/workspace.test.ts`, `test/unit/engine/batchWorkspace.test.ts`

**Interfaces:**
- Consumes: `AgentProvider` from `../types` (Task 1).
- Produces: `Run.provider?: AgentProvider` on records written from this version forward.

- [ ] **Step 1: Add the field to `Run`**

In `src/types.ts`, inside `interface Run` (line 128), after the `kind` field's block:

```ts
  /** The agent this run was launched with — the one `openWorkspace` actually resolved
   * and seeded, not the setting, so it names the real agent even under `ask`. Absent on
   * every record written before this field existed, on a `local` run (never launched by
   * Agent Flow at all), and on a launch that seeded no agent — in which case nothing
   * here is driving the run yet and the card must not claim otherwise. */
  provider?: AgentProvider;
```

- [ ] **Step 2: Write the failing test for `openWorkspace`**

`test/unit/engine/workspace.test.ts` already builds real temp repos and calls `openWorkspace`. Find an existing test that asserts on the written run record (search the file for `readRuns`, `runsDir`, or `writeRun`) and follow its exact setup idiom; add alongside it:

```ts
  it("stamps the provider it actually seeded onto the run record", async () => {
    // The record must name the agent that was started, not the setting — under `ask`
    // those differ, and the card's tool mark reads this field.
    const res = await openWorkspace(req({ seedAgent: true }));
    const run = readRuns(runsDir).find((r) => r.key === TICKET.key)!;
    expect(run.provider).toBe(res.provider);
  });

  it("stamps no provider when the launch seeded no agent", () => {
    // Nothing is driving this run yet; a stamp here would put a tool mark on a card
    // that never started one.
    return openWorkspace(req({ seedAgent: false })).then(() => {
      const run = readRuns(runsDir).find((r) => r.key === TICKET.key)!;
      expect(run.provider).toBeUndefined();
    });
  });
```

Adapt `req(...)`, `readRuns`, `runsDir` and `TICKET` to the helper names the existing file actually uses — read the file's top before writing this. Do not introduce a second set of helpers.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "provider"`
Expected: FAIL — `expected undefined to be "claude-code"` on the first test.

- [ ] **Step 4: Stamp it in `openWorkspace`**

`openWorkspace` already holds the resolved value at line 382 (`const provider: AgentProvider = pinned ?? resolvedProvider(setting);`) and `seedAgent` is destructured at line 340, both well before the record is written. In the `Run` literal at `src/engine/workspace.ts:542`, add one line after `kind: req.kind,`:

```ts
      ...(seedAgent ? { provider } : {}),
```

Spread rather than `provider: seedAgent ? provider : undefined`, matching how `parentKey` and `children` are already written two lines below — an absent key is how "not known" is spelled in this record, and an explicit `undefined` would serialize away only by accident of `JSON.stringify`.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/unit/engine/workspace.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 6: Write the failing test for `batchWorkspace`**

In `test/unit/engine/batchWorkspace.test.ts`, following that file's existing setup idiom:

```ts
  it("stamps the pinned provider onto every run in the batch", async () => {
    await openSharedWorkspace(req({ seedAgent: true, provider: "cursor" }));
    const runs = readRuns(runsDir);
    expect(runs.length).toBeGreaterThan(1);
    for (const r of runs) expect(r.provider).toBe("cursor");
  });

  it("stamps no provider on a batch that seeded no agent", async () => {
    await openSharedWorkspace(req({ seedAgent: false }));
    for (const r of readRuns(runsDir)) expect(r.provider).toBeUndefined();
  });
```

- [ ] **Step 7: Run to verify it fails**

Run: `npx vitest run test/unit/engine/batchWorkspace.test.ts -t "provider"`
Expected: FAIL — `expected undefined to be "cursor"`.

- [ ] **Step 8: Stamp it in `batchWorkspace`**

`batchWorkspace` has only `req.provider`, which is a pin set under `ask` and absent under a fixed setting. Resolve the same way the seeding path does. Add to the existing import from `../config` (or create one — `batchWorkspace.ts` already imports from `./workspace`, which imports `../config`, so there is no new dependency edge):

```ts
import { readAgentProviderSetting, resolvedProvider } from "../config";
```

Then above the `tasks.forEach` at line 193:

```ts
  // One resolution for the whole batch: `req.provider` is the pin `ask` produced, and a
  // fixed setting is read here rather than per task, because every task in one batch is
  // seeded by the same launch and cannot disagree about its agent.
  const provider = seedAgent ? (req.provider ?? resolvedProvider(readAgentProviderSetting())) : undefined;
```

and in the `Run` literal, after `createdAt,`:

```ts
      ...(provider ? { provider } : {}),
```

- [ ] **Step 9: Run to verify it passes**

Run: `npx vitest run test/unit/engine/batchWorkspace.test.ts`
Expected: PASS, all tests.

- [ ] **Step 10: Mutation-check**

Change `seedAgent ? { provider } : {}` in `workspace.ts` to `{ provider }` and confirm "stamps no provider when the launch seeded no agent" FAILS. Restore.

- [ ] **Step 11: Commit**

```bash
git add src/types.ts src/engine/workspace.ts src/engine/batchWorkspace.ts \
  test/unit/engine/workspace.test.ts test/unit/engine/batchWorkspace.test.ts
git commit -m "feat(deck): record the agent a run was launched with"
```

---

### Task 4: Derive `RunStatus.provider`, the one place inference happens

**Files:**
- Modify: `src/types.ts` (one field on `RunStatus`)
- Modify: `src/engine/status.ts:102-116` (the `buildRunStatus` return)
- Test: `test/unit/engine/status.test.ts`

**Interfaces:**
- Consumes: `Run.provider` (Task 3), `CardAgent[]` as `buildRunStatus` already receives it.
- Produces: `RunStatus.provider?: AgentProvider` — what the webview reads in Tasks 5 and 6.

- [ ] **Step 1: Add the field to `RunStatus`**

In `src/types.ts`, inside `interface RunStatus`, after `agents`:

```ts
  /** Which tool is driving this run, for the card's provider mark. The run record's own
   * stamp when it has one; otherwise inferred — a live Claude Code session in this run's
   * directories means `claude-code`, because `~/.claude/sessions` is the only agent
   * registry the Deck can read. Absent when neither answers, and the card then shows no
   * mark rather than guessing from the current setting, which may have changed since the
   * launch or be `ask`. */
  provider?: AgentProvider;
```

- [ ] **Step 2: Write the failing tests**

In `test/unit/engine/status.test.ts`, inside the existing `describe("buildRunStatus")` block so its `run`/`agent` helpers are in scope (read the file's helpers first — `agent(state, lastActivityMs)` is defined at the top of the file):

```ts
  it("prefers the provider the run record was stamped with", () => {
    const s = buildRunStatus({ run: { ...baseRun, provider: "cursor" }, ticket: null, projectsRoot, nowMs: NOW,
      agents: [agent("working", NOW - 1000)] });
    // The record wins over the inference: a Cursor run with a stray Claude session open
    // in its directory is still a Cursor run.
    expect(s.provider).toBe("cursor");
  });

  it("infers claude-code from a live session when the record has none", () => {
    const s = buildRunStatus({ run: baseRun, ticket: null, projectsRoot, nowMs: NOW,
      agents: [agent("working", NOW - 1000)] });
    expect(s.provider).toBe("claude-code");
  });

  it("leaves the provider absent when neither the record nor a session answers", () => {
    // Every record written before this field existed, with nothing running: the card
    // shows no mark at all rather than guessing.
    const s = buildRunStatus({ run: baseRun, ticket: null, projectsRoot, nowMs: NOW, agents: [] });
    expect(s.provider).toBeUndefined();
  });
```

`baseRun` and `projectsRoot` must be the names the existing describe block already uses for its `Run` fixture and temp projects dir — read them off the file rather than inventing new ones.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/unit/engine/status.test.ts -t "provider"`
Expected: FAIL — `expected undefined to be "cursor"`.

- [ ] **Step 4: Derive it**

In `src/engine/status.ts`, above the `return {` at line 102:

```ts
  // The record's own stamp, else the one inference the Deck can honestly make: a live
  // session means Claude Code, because that is the only agent registry there is to read.
  // Deliberately NOT the current setting — it may have changed since the launch, or be
  // `ask`, which names no agent at all.
  const provider = run.provider ?? (agents.length > 0 ? ("claude-code" as const) : undefined);
```

and add to the returned object, after `agents,`:

```ts
    ...(provider ? { provider } : {}),
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/unit/engine/status.test.ts`
Expected: PASS, all tests including every pre-existing one.

- [ ] **Step 6: Mutation-check**

Swap the derivation to `agents.length > 0 ? "claude-code" : run.provider` and confirm "prefers the provider the run record was stamped with" FAILS. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/engine/status.ts test/unit/engine/status.test.ts
git commit -m "feat(deck): derive a run's provider from its record, or from a live session"
```

---

### Task 5: The provider badge on `CardKindIcon`

**Files:**
- Modify: `src/webview/icons.tsx:96-154` (the brand paths, and the component)
- Modify: `src/webview/deckStyles.ts:199-213` (badge CSS, beside the `.av` rules)
- Test: `test/webview/CardKindIcon.test.tsx`

**Interfaces:**
- Consumes: `AgentProvider` from `../types` (Task 1).
- Produces: `CardKindIcon({ kind, provider }: { kind: CardKind; provider?: AgentProvider | null })`, and the exported `PROVIDER_LABEL: Record<AgentProvider, string>`.

- [ ] **Step 1: Write the failing tests**

Add to `test/webview/CardKindIcon.test.tsx`:

```ts
const PROVIDERS = ["claude-code", "copilot", "cursor"] as const;

describe("CardKindIcon provider badge", () => {
  it("shows no badge when no provider is known", () => {
    // Every run record written before the provider was recorded, with nothing running:
    // the tile must look exactly as it did before this feature existed.
    const { container } = render(<CardKindIcon kind="task" />);
    expect(container.querySelector(".pv")).toBeNull();
    expect(container.querySelector(".av")!.className).toBe("av k-task");
  });

  it("names the tool in words on the badge", () => {
    const { container } = render(<CardKindIcon kind="task" provider="copilot" />);
    expect(container.querySelector(".pv")!.getAttribute("title")).toBe("GitHub Copilot");
  });

  it("names both facts in the tile's accessible name", () => {
    // The mark is the only thing that says which tool this is, so the accessible name
    // has to say it too — and it must not lose the kind while gaining the tool.
    const { getByRole } = render(<CardKindIcon kind="notepad" provider="cursor" />);
    expect(getByRole("img").getAttribute("aria-label")).toBe("Notepad note · Cursor");
  });

  it("draws a distinct mark per provider", () => {
    const shapes = new Set<string>();
    for (const provider of PROVIDERS) {
      const { container, unmount } = render(<CardKindIcon kind="task" provider={provider} />);
      const badge = container.querySelector(".pv")!;
      expect(badge.className).toBe(`pv p-${provider}`);
      const svg = badge.querySelector("svg")!;
      expect(svg.getAttribute("width")).toBe("11");
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      shapes.add(svg.innerHTML);
      unmount();
    }
    expect(shapes.size).toBe(PROVIDERS.length);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/webview/CardKindIcon.test.tsx`
Expected: FAIL — the pre-existing tests pass; the four new ones fail on a missing `.pv` element (and on the `provider` prop not existing).

- [ ] **Step 3: Add the marks and the labels to `icons.tsx`**

Below `CARD_KIND_GLYPHS`, add:

```tsx
export const PROVIDER_LABEL: Record<AgentProvider, string> = {
  "claude-code": "Claude Code",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
};

// The three agents' own marks, one monochrome path each in a 24-unit box, drawn in
// currentColor — the same treatment CARD_KIND_GLYPHS uses above, and for the same
// reasons: no image assets, no asWebviewUri plumbing, no widened CSP.
//
// The path data is Simple Icons' rendition of each mark (CC0). The marks themselves are
// trademarks of Anthropic, GitHub and Anysphere and appear here nominatively, to say
// which tool is driving a run — nothing more.
const PROVIDER_GLYPHS: Record<AgentProvider, JSX.Element> = {
  "claude-code": (
    <path fill="currentColor" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
  ),
  copilot: (
    <path fill="currentColor" d="M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z" />
  ),
  cursor: (
    <path fill="currentColor" d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
  ),
};
```

Those three `d` strings are the complete path data — copy them verbatim, do not redraw,
reformat, or round the coordinates. They are also on disk in the gitignored `preview/`
directory (`preview/_brand-claude.svg`, `preview/_brand-githubcopilot.svg`,
`preview/_brand-cursor.svg`), and can be re-fetched with:

```bash
for n in claude cursor githubcopilot; do
  curl -sS "https://cdn.jsdelivr.net/npm/simple-icons@15/icons/$n.svg" -o "preview/_brand-$n.svg"
done
```

Add `AgentProvider` to the file's import from `../types`.

- [ ] **Step 4: Render the badge**

Replace `CardKindIcon` (`src/webview/icons.tsx:150`) with:

```tsx
/** What this card IS, as a hued glyph in a neutral tile, with the tool driving it on the
 * tile's corner. Leads the Deck card and the detail drawer's header, so a selected card
 * and its detail open with the same mark. The kind keeps the tile: it is the card's
 * identity, and the provider is a fact about it. */
export const CardKindIcon = ({ kind, provider }: {
  kind: CardKind;
  provider?: AgentProvider | null;
}): JSX.Element => {
  const label = provider ? `${CARD_KIND_LABEL[kind]} · ${PROVIDER_LABEL[provider]}` : CARD_KIND_LABEL[kind];
  return (
    <span className={`av k-${kind}`} role="img" aria-label={label} title={label}>
      <svg width="14" height="14" viewBox="0 0 16 16">{CARD_KIND_GLYPHS[kind]}</svg>
      {provider && (
        <span className={`pv p-${provider}`} title={PROVIDER_LABEL[provider]}>
          <svg width="11" height="11" viewBox="0 0 24 24">{PROVIDER_GLYPHS[provider]}</svg>
        </span>
      )}
    </span>
  );
};
```

Note the existing test `expect(av.className).toBe("av k-task")` — the tile's own class list must stay exactly that, which is why the badge is a child with its own class rather than a modifier on `.av`.

- [ ] **Step 5: Add the CSS**

In `src/webview/deckStyles.ts`, immediately after the `.av.k-local` rule (line 213):

```
  /* The tool driving this card, on the kind tile's corner. Overflow has to open up for
     it: the badge deliberately breaks the tile's edge, which is what makes it read as a
     badge rather than as a second glyph crammed inside. */
  .av { overflow: visible; }
  .pv { position: absolute; right: -5px; bottom: -5px; width: 15px; height: 15px;
    border-radius: 5px; display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid var(--hair);
    background: color-mix(in srgb, var(--vscode-foreground) 10%, var(--vscode-editor-background));
    color: color-mix(in srgb, var(--vscode-foreground) 72%, transparent); }
  .pv svg { display: block; }
  /* Claude has a brand colour that survives both themes; Cursor and GitHub Copilot are
     black-on-white marks and take the theme's own ink instead. The hue is safe here in a
     way it would not be on the card's ground: the badge never changes with state, so it
     cannot be read as the status that colour otherwise always means on a card. */
  .pv.p-claude-code { color: #D97757;
    border-color: color-mix(in srgb, #D97757 34%, var(--hair));
    background: color-mix(in srgb, #D97757 10%, var(--vscode-editor-background)); }
```

If `.av` already declares `overflow` elsewhere in the file, edit that declaration instead of adding a second one.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/webview/CardKindIcon.test.tsx`
Expected: PASS — the four new tests and all pre-existing ones.

- [ ] **Step 7: Mutation-check**

Change the `aria-label` to `PROVIDER_LABEL[provider]` alone (dropping the kind) and confirm "names both facts in the tile's accessible name" FAILS. Restore.

- [ ] **Step 8: Commit**

```bash
git add src/webview/icons.tsx src/webview/deckStyles.ts test/webview/CardKindIcon.test.tsx
git commit -m "feat(deck): put the tool driving a card on its kind tile"
```

---

### Task 6: Pass the provider from the card and the drawer

**Files:**
- Modify: `src/webview/DeckApp.tsx:224`
- Modify: `src/webview/DeckDetail.tsx:127`
- Test: `test/webview/DeckApp.test.tsx` (the card) and `test/webview/DeckDetail.test.tsx` (the drawer) — both already exist, with the fixtures this test needs.

**Interfaces:**
- Consumes: `RunStatus.provider` (Task 4), `CardKindIcon`'s `provider` prop (Task 5).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

`test/webview/DeckApp.test.tsx` already has `mkStatus(over)`, `runsMsg(runs)` and `host(msg)`
helpers at the top of the file — use them rather than building a new harness:

```ts
  it("marks the card with the tool driving the run", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus({ provider: "cursor" })]));
    expect(container.querySelector(".pv.p-cursor")).toBeTruthy();
  });

  it("leaves the tile bare when no provider is known", () => {
    // The board as it looked before this feature: every run record written before the
    // provider was recorded, with nothing running in it.
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(container.querySelector(".pv")).toBeNull();
  });
```

And in `test/webview/DeckDetail.test.tsx`, following that file's own fixture idiom (it
takes a `RunStatus` directly rather than posting a message):

```ts
  it("opens the drawer with the same mark the card carries", () => {
    const { container } = renderDetail(mkStatus({ provider: "claude-code" }));
    expect(container.querySelector(".dd-hd .pv.p-claude-code")).toBeTruthy();
  });
```

Read `DeckDetail.test.tsx`'s top before writing that one — use its existing render helper
and status fixture names, whatever they are called, instead of introducing `renderDetail`
if it does not already exist.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/webview/DeckApp.test.tsx test/webview/DeckDetail.test.tsx`
Expected: FAIL — no `.pv.p-cursor` in the tree. ("leaves the tile bare when no provider is
known" passes trivially at this point; it is there to stay passing forever after.)

- [ ] **Step 3: Pass it from the card**

`src/webview/DeckApp.tsx:224`:

```tsx
        <CardKindIcon kind={kind} provider={r.provider} />
```

- [ ] **Step 4: Pass it from the drawer**

`src/webview/DeckDetail.tsx:127`:

```tsx
        <CardKindIcon kind={runKind(r.run)} provider={r.provider} />
```

The comment above that line already says a card and its drawer are one object — this is what keeps that true.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/webview`
Expected: PASS, the whole webview suite.

- [ ] **Step 6: Commit**

```bash
git add src/webview/DeckApp.tsx src/webview/DeckDetail.tsx \
  test/webview/DeckApp.test.tsx test/webview/DeckDetail.test.tsx
git commit -m "feat(deck): show the provider mark on the card and in the drawer"
```

---

### Task 7: The model on each agent row

**Files:**
- Create: `src/webview/modelLabel.ts`
- Modify: `src/webview/deckParts.tsx:118-160` (`AgentsRow`)
- Modify: `src/webview/deckStyles.ts:277-293` (beside the `.ag-*` rules)
- Test: `test/webview/deckParts.test.tsx`, and a new `test/webview/modelLabel.test.ts`

**Interfaces:**
- Consumes: `AgentActivity.model`, `AgentActivity.modelCount` (Task 2).
- Produces: `modelLabel(model: string): string` from `src/webview/modelLabel.ts`.

`modelLabel` gets its own module rather than living inside `deckParts.tsx`: it is a pure string rule with its own test file, and `deckParts.tsx` is already the webview's shared-parts grab bag.

- [ ] **Step 1: Write the failing test for `modelLabel`**

Create `test/webview/modelLabel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { modelLabel } from "../../src/webview/modelLabel";

describe("modelLabel", () => {
  it("drops the vendor prefix", () => {
    expect(modelLabel("claude-opus-5")).toBe("opus-5");
    expect(modelLabel("claude-fable-5")).toBe("fable-5");
  });

  it("drops a trailing build date", () => {
    expect(modelLabel("claude-3-5-haiku-20241022")).toBe("3-5-haiku");
  });

  it("leaves a model it does not recognise verbatim", () => {
    // Better an unfamiliar name in full than a mangled one that reads like a
    // different model.
    expect(modelLabel("gpt-5-codex")).toBe("gpt-5-codex");
  });

  it("does not mistake a version segment for a date", () => {
    expect(modelLabel("claude-haiku-4-5")).toBe("haiku-4-5");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/webview/modelLabel.test.ts`
Expected: FAIL — cannot resolve `src/webview/modelLabel`.

- [ ] **Step 3: Write `modelLabel`**

Create `src/webview/modelLabel.ts`:

```ts
/** A model id as a card reads it: `claude-opus-5` → `opus-5`,
 * `claude-3-5-haiku-20241022` → `3-5-haiku`. Strips the vendor prefix and a trailing
 * build date and NOTHING else — an id from a vendor we do not know renders verbatim,
 * because a half-trimmed name reads like a different model, which is worse than a long
 * one. Eight digits, not "trailing numbers": `haiku-4-5` ends in a version. */
export function modelLabel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/webview/modelLabel.test.ts`
Expected: PASS, all four.

- [ ] **Step 5: Write the failing test for `AgentsRow`**

Add to `test/webview/deckParts.test.tsx`. Note its existing `mkAgent` helper builds `activity` without a model, so extend rather than replace it:

```ts
const withModel = (a: CardAgent, model: string | null, modelCount = 1): CardAgent =>
  ({ ...a, activity: { ...a.activity, model, modelCount } });

describe("AgentsRow model", () => {
  it("shows the model the session is answering with", () => {
    render(<AgentsRow agents={[withModel(mkAgent("svc-7e", "working"), "claude-opus-5")]} defaultOpen />);
    expect(screen.getByText("opus-5")).toBeTruthy();
  });

  it("shows nothing where there is no model to show", () => {
    // A transcript that yielded no main-chain model must leave the row exactly as it
    // was — never a dash, never "unknown".
    const { container } = render(<AgentsRow agents={[withModel(mkAgent("svc-7e", "working"), null)]} defaultOpen />);
    expect(container.querySelector(".ag-model")).toBeNull();
  });

  it("marks a session that used more than one model", () => {
    const { container } = render(
      <AgentsRow agents={[withModel(mkAgent("svc-7e", "working"), "claude-opus-5", 2)]} defaultOpen />,
    );
    expect(container.querySelector(".ag-model .plus")!.textContent).toBe("+1");
  });

  it("does not mark a session that used exactly one", () => {
    const { container } = render(
      <AgentsRow agents={[withModel(mkAgent("svc-7e", "working"), "claude-opus-5", 1)]} defaultOpen />,
    );
    expect(container.querySelector(".ag-model .plus")).toBeNull();
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run test/webview/deckParts.test.tsx`
Expected: FAIL on the three positive cases (no `opus-5` text, no `.ag-model`); the pre-existing tests and "shows nothing where there is no model" pass trivially.

- [ ] **Step 7: Render it**

In `src/webview/deckParts.tsx`, import the helper:

```ts
import { modelLabel } from "./modelLabel";
```

and inside the `agents.map` in `AgentsRow`, between the `.ag-state` span and the `.ag-age` span:

```tsx
            {a.activity.model && (
              <span
                className="ag-model"
                title={(a.activity.modelCount ?? 1) > 1
                  ? `Answering with ${a.activity.model} — this session has used ${a.activity.modelCount} models`
                  : `Answering with ${a.activity.model}`}
              >
                {modelLabel(a.activity.model)}
                {(a.activity.modelCount ?? 1) > 1 && <span className="plus">+{a.activity.modelCount! - 1}</span>}
              </span>
            )}
```

The `title` carries the untrimmed id, because that is the string a user would paste into a config or a bug report.

- [ ] **Step 8: Add the CSS**

In `src/webview/deckStyles.ts`, after the `.ag-open` rule (line 293):

```
  /* An identifier, so mono — the same rule .ag-name and .key follow. Quieter than the
     name: which session this is matters more than what is driving it. */
  .ag-model { flex: none; font-family: var(--mono); font-size: var(--t-data);
    color: color-mix(in srgb, var(--vscode-foreground) 62%, transparent); }
  .ag-model .plus { margin-left: 3px; opacity: .6; }
```

- [ ] **Step 9: Run to verify it passes**

Run: `npx vitest run test/webview/deckParts.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 10: Mutation-check**

Change the `+N` guard to `>= 1` and confirm "does not mark a session that used exactly one" FAILS. Restore.

- [ ] **Step 11: Commit**

```bash
git add src/webview/modelLabel.ts src/webview/deckParts.tsx src/webview/deckStyles.ts \
  test/webview/modelLabel.test.ts test/webview/deckParts.test.tsx
git commit -m "feat(deck): name the model each session is answering with"
```

---

### Task 8: Full gates, and see it in a real editor

**Files:** none — this task changes no code unless a gate fails.

**Interfaces:**
- Consumes: every task above.
- Produces: a verified build.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: succeeds. This is the only gate that catches a Node builtin reaching the webview graph — if `AgentProvider` were still coming from `config.ts`, this is where it would surface.

- [ ] **Step 3: Full suite**

Run: `npm test` — **with an explicit 600000 ms timeout**, because the run takes ~220s and the default Bash timeout is 120s.
Expected: PASS, every test. Do not pipe the run through `tail` — the suite's failure output is what you need in full. A single failure in a suite this size can be CPU contention; re-run the named file alone before concluding it is real.

- [ ] **Step 4: Coverage**

Run: `npm run test:cov`
Expected: thresholds hold (statements 90 / branches 85 / functions 85 / lines 90). Check the per-file rows for the files this plan touched — `transcript.ts`, `status.ts`, `icons.tsx`, `deckParts.tsx`, `modelLabel.ts` — and add cases for any uncovered branch this plan introduced.

- [ ] **Step 5: See it in a real editor**

Launch the dev host with **VS Code's** `code` CLI — the Cursor CLI silently drops `--extensionDevelopmentPath`:

```bash
code --extensionDevelopmentPath=/Users/oznasi/dev/agent-flow /Users/oznasi/dev/agent-flow
```

Open the Deck and confirm, on real local runs: a card with a live Claude session shows the orange Claude mark on its tile corner; the drawer header shows the same mark; the drawer's Agents rows name a model; and a run with no session and no stamped provider shows no badge at all — the tile exactly as before.

- [ ] **Step 6: Commit anything the gates required**

```bash
git add -A
git commit -m "test(deck): cover the branches the provider mark and model line added"
```

If the gates required no changes, skip this step rather than making an empty commit.

---

## Notes for the executor

- **The mockups exist.** `preview/avatar-c.html` and `preview/avatar-drawer.html` (both gitignored) render these treatments against the real deck CSS, and `preview/_brand-*.svg` holds the three brand paths. Re-shoot with `node preview/shoot-avatar-c.js` to compare your build against what was approved.
- **`preview/` is gitignored on purpose.** Do not commit anything from it, and do not move the brand SVGs into the repo — only their `d` strings go into `icons.tsx`.
- **What this deliberately does not do:** discover Cursor or Copilot sessions (no registry exists to read — those runs keep rendering as parked); put a model on the card (spend was removed from the card in a66c543 for the same reason, and two tests pin that); or retro-stamp existing run records.
