# Usage Analytics Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrument every remaining surface (Deck, review queue, PR actions, batch, Explore, orchestrator, Marketplace, tasks view, setup, Doctor) with ~23 new typed telemetry events, and fix the four Phase 1 data-fidelity bugs.

**Architecture:** All events are new variants of the closed `UsageEvent` union in `src/telemetry/events.ts` — enum/number/boolean properties only, emitted host-side via the existing `track()`/`trackError()` facade. Engine modules stay pure (no telemetry imports under `src/engine/`). Two additive webview→host messages are added (`flow:dryRun`, `tasks:lensUsed`); nothing released changes shape.

**Tech Stack:** TypeScript, VS Code extension host, Vitest (vscode mocked via `test/_mocks/vscode.ts`), esbuild.

**Spec:** `docs/superpowers/specs/2026-08-28-usage-analytics-phase-2-design.md` — read it before starting any task. The recon anchors in it are line numbers on main as of 2026-08-28; if a line has drifted, search for the named identifier instead.

## Global Constraints

- **CI gates (all four must pass at the end of every task):** `npm run typecheck`, `npm test`, `npm run build`, and the repo builds from `npm ci`. `npm run build` is a real gate: any module reachable from `src/webview/*` entry points that imports `fs`/`os`/`path`/`child_process` breaks it even if tsc and tests pass.
- **`npm test` is ~4,500 tests / 2+ minutes.** Run it through the Bash tool with `timeout: 600000`. Never pipe vitest through `tail`/`head`. While iterating, run single files: `npx vitest run test/unit/telemetry/events.test.ts`.
- **`test/unit/deckView.test.ts` needs a big heap:** `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run test/unit/deckView.test.ts` — a worker heap-OOM masquerades as "N-1 files + 0 failures". It can take ~5 minutes alone. Never let two vitest runs overlap.
- **Work in a git worktree created off `main`** (not the current checkout — parallel sessions switch its branch). Use absolute paths in every Bash call; if a command auto-backgrounds, embed `cd /abs/path/to/worktree && …` in the command itself.
- **Never break existing users:** the existing suite must pass **unmodified**, with exactly these adjudicated exceptions: (1) `test/unit/telemetry/events.test.ts` — the `SAMPLES` array and its `toHaveLength(N)` count exist to grow with the catalog; (2) the `classifyFailure` code-string test that Task 1 changes per the follow-ups doc (`docs/superpowers/plans/2026-08-01-usage-analytics-follow-ups.md`); (3) any Phase 1 funnel assertion that asserted `inferred_count` on `take_started` or `prompt_mode: "custom"` on a cancelled Take — those assert the exact bugs Task 1 fixes. Any *other* test needing an edit is the signal to stop and report.
- **`test/unit/compat.test.ts` is untouchable.** The frozen literals `"jira_fetch"`, `"jira_write"`, `"jira_auth"`, `has_jira_auth:` must keep their exact spelling in `events.ts`. No new commands (the command-id list is frozen). Setup instrumentation is `track()` calls only — the compat test pins that a cancelled wizard performs zero `getConfiguration().update` calls.
- **Event names are lower_snake_case** (`docs.test.ts`'s regex only sees that shape). Every new event needs a table row in `docs/TELEMETRY.md` (drift test) and a `SAMPLES` literal (compile-time exhaustiveness).
- **`OPEN_STRING_PROPS` must not grow** — `events.test.ts` freezes it to `["error_class", "flow_id", "stack_digest"]` and that freeze is the design. No user string (ticket key, repo, flow name, topic, env name, shell, review body, URL, path, error message) may enter any event property.
- **Vocabulary gate:** new user-visible prose says "session", never "agent" (the tool is named: "Claude Code"). Identifiers and wire values keep their released spelling (`open_agents`, `agents` grouping). `test/unit/vocabulary.test.ts` enforces this; docs count.
- **Coverage:** `npm run test:cov` thresholds are 90% lines/statements, 85% branches/functions. Every emit site gets a behavior test that fails if the emit is deleted (mutation-check committed work only — a git checkout that restores a mutant also reverts uncommitted fixes).
- **Commit at the end of every task** (incremental commits; sessions get killed mid-flight). Git identity: `oznasi1 <oznasi1@gmail.com>`.
- **Telemetry mock pattern** (used by every emit-site test; already present in `tasksView.test.ts:64-70`):

```ts
const trackSpy = vi.fn();
const trackErrorSpy = vi.fn();
vi.mock("../../src/telemetry/telemetry", () => ({
  track: (...a: unknown[]) => trackSpy(...a),
  trackError: (...a: unknown[]) => trackErrorSpy(...a),
  startFlow: () => ({ id: "flow-1", elapsedMs: () => 42 }),
  fingerprint: () => "0123456789abcdef",
}));
```

Assertion idiom: `trackSpy.mock.calls.flat().find((e: any) => e.name === "deck_opened")`, then assert exact property values. Always also assert `JSON.stringify(trackSpy.mock.calls.flat())` does not contain the user strings the fixture used (repo names, ticket keys, flow names).

---

### Task 1: Phase 1 fidelity fixes

**Files:**
- Modify: `src/telemetry/events.ts` (take_started, take_completed, classifyFailure)
- Modify: `src/telemetry/telemetry.ts` (startFlow)
- Modify: `src/tasksView.ts` (the take_started / take_completed emit literals)
- Test: `test/unit/telemetry/events.test.ts`, `test/unit/telemetry/telemetry.test.ts`, `test/unit/tasksView.test.ts`
- Modify: `docs/TELEMETRY.md` (the two changed rows)

**Interfaces:**
- Consumes: nothing.
- Produces: `classifyFailure(e)` additionally reads a numeric `.status` (`401|403 → "auth"`, `404 → "not_found"`); `startFlow()` is monotonic; `take_completed.prompt_mode` is optional. Every later task builds on these.

- [ ] **Step 1: Write the failing tests**

In `test/unit/telemetry/events.test.ts`, replace the code-string test at ~line 130 (adjudicated by the follow-ups doc — nothing in `src/` sets a string `.code`) and add the status tests:

```ts
it("classifies auth by numeric 401/403 status (JiraApiError shape)", () => {
  expect(classifyFailure({ status: 401 })).toBe("auth");
  expect(classifyFailure({ status: 403 })).toBe("auth");
});

it("classifies not_found by numeric 404 status", () => {
  expect(classifyFailure({ status: 404 })).toBe("not_found");
});

it("ignores other statuses", () => {
  expect(classifyFailure({ status: 500 })).toBe("unknown");
});
```

In the same file, update `SAMPLES`: remove `inferred_count: 2` from the `take_started` sample. (Leave `take_completed`'s sample carrying `prompt_mode` — it stays valid as the property becomes optional.)

In `test/unit/telemetry/telemetry.test.ts` add:

```ts
it("startFlow is monotonic — elapsedMs never goes negative when the wall clock jumps back", () => {
  const flow = startFlow();
  // performance.now() is monotonic by contract; assert the reader is wired to it
  // rather than Date.now() by checking a plain forward measurement is sane and
  // integer-valued (Date.now() deltas are also integers, so additionally spy):
  const spy = vi.spyOn(performance, "now");
  flow.elapsedMs();
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});
```

In `test/unit/tasksView.test.ts`, find the cancelled-Take funnel test (search `outcome).toBe("cancelled")`) and strengthen it:

```ts
// prompt_mode must be ABSENT when the Take was cancelled before a mode was chosen —
// "custom" here was Phase 1's fidelity bug (follow-ups doc, item 3).
expect("prompt_mode" in (trackSpy.mock.calls.flat().at(-1) as any)).toBe(false);
```

and in the happy-path funnel test assert `"inferred_count" in started` is `false`.

- [ ] **Step 2: Run to verify the new assertions fail**

```
npx vitest run test/unit/telemetry/events.test.ts test/unit/telemetry/telemetry.test.ts
npx vitest run test/unit/tasksView.test.ts -t "cancel"
```
Expected: the new status tests fail (`unknown`), the performance.now spy test fails, the funnel assertions fail.

- [ ] **Step 3: Implement**

`src/telemetry/events.ts` — in `classifyFailure`, replace the dead string-code branch:

```ts
export function classifyFailure(e: unknown): FailureClass {
  const name = e instanceof Error ? e.name : "";
  const code = (e as { code?: string } | null)?.code ?? "";
  // JiraApiError carries a numeric `.status` (src/tasks/jira/errors.ts) — read it the
  // same arms-length way as `.code`, never the message.
  const status = (e as { status?: number } | null)?.status;
  if (name === "TaskAuthError" || name === "JiraAuthError" || status === 401 || status === 403) return "auth";
  if (name === "AbortError" || code === "ETIMEDOUT") return "timeout";
  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ENETUNREACH") return "network";
  if (code === "ENOENT" || status === 404) return "not_found";
  if (code === "EACCES" || code === "EPERM") return "permission";
  if (name === "SyntaxError") return "parse";
  return "unknown";
}
```

In the `UsageEvent` union: delete `inferred_count: number` from `take_started`; change `take_completed`'s `prompt_mode: PromptModeProp` to `prompt_mode?: PromptModeProp` and note in its comment that it is omitted when the Take ends before a mode was chosen.

`src/telemetry/telemetry.ts`:

```ts
export function startFlow(): Flow {
  // performance.now() is monotonic; Date.now() is not — a clock adjustment
  // mid-flow yielded wrong or negative durations (follow-ups doc, item 4).
  const started = performance.now();
  return { id: randomUUID(), elapsedMs: () => Math.round(performance.now() - started) };
}
```

`src/tasksView.ts`: remove `inferred_count: 0` from the `take_started` literal (~`:1554`). For `take_completed` (~`:2163–2195`): change the tracking variable from `let promptModeProp: PromptModeProp = "custom"` to `let promptModeProp: PromptModeProp | undefined` and build the literal with a conditional spread, mirroring how `destination` is already omitted:

```ts
...(promptModeProp !== undefined ? { prompt_mode: promptModeProp } : {}),
```

- [ ] **Step 4: Run the touched suites**

```
npx vitest run test/unit/telemetry test/unit/tasksView.test.ts
```
Expected: PASS.

- [ ] **Step 5: Update `docs/TELEMETRY.md`** — the `take_started` row loses `inferred_count`; the `take_completed` row marks `prompt_mode` optional ("omitted when cancelled before a mode was chosen"). Also fix, while in the file, the stale `tasksView.ts:330-335` anchor → `tasksView.ts:879-889`.

- [ ] **Step 6: Typecheck + commit**

```
npm run typecheck
git add -A && git commit -m "fix(telemetry): monotonic durations, JiraApiError status classing, honest take funnel props"
```

---

### Task 2: Deck — error seam, `deck_opened`, `deck_action`

**Files:**
- Modify: `src/telemetry/events.ts` (two variants + `DeckAction` type)
- Modify: `src/deckView.ts` (import alias, onMessage catch, emits)
- Test: `test/unit/deckView.test.ts`, `test/unit/telemetry/events.test.ts`
- Modify: `docs/TELEMETRY.md`

**Interfaces:**
- Consumes: `track`, `trackError`, `classifyFailure`, `Op` from Task 1's corrected module.
- Produces: the import alias convention `import { track as trackEvent, trackError } from "./telemetry/telemetry"` (deckView's own private `track(key)` method at `:3910` collides — every later deckView task uses `trackEvent`). Also `DECK_MESSAGE_OPS: Record<string, Op>`.

- [ ] **Step 1: Catalog + samples first (they're compile-time)**

`src/telemetry/events.ts`, in the usage union:

```ts
export type DeckAction =
  | "refresh" | "clear_stale" | "switch_account" | "set_grouping"
  | "inspect_open" | "inspect_diff" | "forget" | "track" | "usage" | "open_external";

// in UsageEvent:
// `forge` is a registry-validated id or "invalid" — same sentinel scheme as
// SettingsSnapshot.forge; never the raw setting string.
| { name: "deck_opened"; revealed: boolean; forge: string; pr_facts: boolean; open_agents: boolean; review_queue: boolean; orchestrator: boolean; flow_count: number; has_armed_flow: boolean }
| { name: "deck_action"; action: DeckAction; grouping?: "agents" | "workspaces" }
```

`test/unit/telemetry/events.test.ts` SAMPLES additions (count 10 → 12):

```ts
{ name: "deck_opened", revealed: false, forge: "github", pr_facts: true, open_agents: true, review_queue: true, orchestrator: false, flow_count: 0, has_armed_flow: false },
{ name: "deck_action", action: "set_grouping", grouping: "workspaces" },
```
Bump `expect(names).toHaveLength(10)` → `12`.

- [ ] **Step 2: Write the failing deckView tests**

In `test/unit/deckView.test.ts`, add the telemetry mock from Global Constraints (top of file, alongside the existing mocks), then:

```ts
it("emits deck_opened once on a fresh open, with revealed:false", async () => {
  trackSpy.mockClear();
  await showDeck(); // whatever helper this file already uses to construct the panel
  const opened = trackSpy.mock.calls.flat().filter((e: any) => e.name === "deck_opened");
  expect(opened).toHaveLength(1);
  expect(opened[0].revealed).toBe(false);
  expect(typeof opened[0].flow_count).toBe("number");
});

it("emits deck_action for a grouping change, carrying the grouping enum", async () => {
  trackSpy.mockClear();
  await postMessage({ type: "deck:setGrouping", grouping: "workspaces" });
  const act = trackSpy.mock.calls.flat().find((e: any) => e.name === "deck_action");
  expect(act).toMatchObject({ action: "set_grouping", grouping: "workspaces" });
});

it("emits operation_failed from the new onMessage catch and never a user string", async () => {
  // force a handler to throw (e.g. mock refreshBusy to reject), then:
  await postMessage({ type: "deck:refresh" });
  const err = trackErrorSpy.mock.calls.flat().find((e: any) => e.name === "operation_failed");
  expect(err).toBeDefined();
  expect(JSON.stringify(trackSpy.mock.calls.flat())).not.toContain("PROJ-");
});
```

Adapt construction/postMessage to this file's existing harness (it drives `onMessage` through the captured webview mock — follow the neighbouring tests).

- [ ] **Step 3: Run to verify they fail**

```
cd /abs/worktree && NODE_OPTIONS=--max-old-space-size=8192 npx vitest run test/unit/deckView.test.ts -t "deck_"
```
Expected: FAIL (no events emitted).

- [ ] **Step 4: Implement in `src/deckView.ts`**

Import: `import { track as trackEvent, trackError } from "./telemetry/telemetry";` and `import { classifyFailure, DeckAction, Op } from "./telemetry/events";`

`deck_opened` — in `static show()` (`:484`): the reveal branch (`:485–488`) emits `revealed: true`; after `new DeckPanel(...)` (`:495`) emit `revealed: false`. Properties come from what the constructor already computes (`:507–513`): `cfg.forge` validated against the forge registry (collapse unknown → `"invalid"`), `this.prFacts`, `this.openAgents`, `this.reviewQueue`, `getConfig().orchestrator`, `readFlows(...).length`, `hasArmedFlow()`.

`deck_action` — a module-level map plus one emit at the top of `onMessage`:

```ts
const DECK_ACTIONS: Partial<Record<InboundMessage["type"], DeckAction>> = {
  "deck:refresh": "refresh", "deck:clearStale": "clear_stale",
  "deck:switchAccount": "switch_account", "deck:setGrouping": "set_grouping",
  "deck:forget": "forget", "deck:track": "track", "deck:usageFor": "usage",
  "openExternal": "open_external",
};
```
`deck:inspect` maps by payload: `m.action === "diff" ? "inspect_diff" : "inspect_open"`. For `deck:setGrouping` include `grouping: m.grouping`.

Error seam — wrap the `onMessage` switch body:

```ts
const DECK_MESSAGE_OPS: Partial<Record<string, Op>> = {
  "deck:reviewLaunch": "review_fetch", "deck:reviewBatch": "review_fetch",
  "deck:reviewSubmit": "review_fetch", "deck:mergePr": "pr_lookup",
  "deck:addressPr": "pr_lookup", "deck:seedPrWork": "workspace_write",
  "deck:track": "workspace_write", "deck:refresh": "pr_lookup",
};
// in onMessage:
try { /* existing switch */ } catch (e) {
  const op = DECK_MESSAGE_OPS[m.type] ?? "workspace_write";
  trackError({ name: "operation_failed", op, failure_class: classifyFailure(e), retryable: false });
  this.log(`deck: ${m.type} failed: ${e instanceof Error ? e.message : String(e)}`);
}
```
(Existing per-handler catches stay; this is last-resort only, mirroring `tasksView.ts:879`.)

- [ ] **Step 5: Run to verify pass, then the telemetry suite**

```
cd /abs/worktree && NODE_OPTIONS=--max-old-space-size=8192 npx vitest run test/unit/deckView.test.ts
npx vitest run test/unit/telemetry
```
Expected: PASS.

- [ ] **Step 6: Docs rows** — add `deck_opened` and `deck_action` rows to `docs/TELEMETRY.md`'s Usage events table (columns `| Event | Properties | When |`).

- [ ] **Step 7: Typecheck + commit**

```
npm run typecheck
git add -A && git commit -m "feat(telemetry): deck_opened, deck_action, and a last-resort Deck error seam"
```

---

### Task 3: Review — `review_launched`, `review_submitted`

**Files:**
- Modify: `src/telemetry/events.ts`, `src/deckView.ts`
- Test: `test/unit/deckView.test.ts`, `test/unit/telemetry/events.test.ts`
- Modify: `docs/TELEMETRY.md`

**Interfaces:**
- Consumes: `trackEvent` alias and `TaskModeProp`, `DestinationProp` from events.ts; `modeProp()` from `src/telemetry/settingsSnapshot.ts`.
- Produces: nothing later tasks use.

- [ ] **Step 1: Catalog + samples** (count 12 → 14)

```ts
| { name: "review_launched"; outcome: Outcome; mode: TaskModeProp; mode_was_pinned: boolean;
    destination?: DestinationProp; provider?: "claude-code" | "copilot" | "cursor";
    seeded_in_place?: boolean; batch: boolean; requested_count: number; launched_count: number;
    failed_count: number; skipped_count: number; layout?: "separate" | "shared"; layout_asked?: boolean }
| { name: "review_submitted"; verb: "approve" | "comment" | "request-changes"; from_draft: boolean; outcome: "ok" | "cancelled" | "failed" }
```

SAMPLES:

```ts
{ name: "review_launched", outcome: "launched", mode: "stock", mode_was_pinned: true, destination: "new", provider: "claude-code", seeded_in_place: false, batch: false, requested_count: 1, launched_count: 1, failed_count: 0, skipped_count: 0 },
{ name: "review_submitted", verb: "approve", from_draft: true, outcome: "ok" },
```

- [ ] **Step 2: Failing tests** in `test/unit/deckView.test.ts`, following that file's existing review-launch fixtures:

```ts
it("emits review_launched with outcome launched for a single review", async () => { /* drive deck:reviewLaunch happy path */ 
  const ev = trackSpy.mock.calls.flat().find((e: any) => e.name === "review_launched") as any;
  expect(ev).toMatchObject({ outcome: "launched", batch: false, requested_count: 1, launched_count: 1 });
});
it("emits review_launched with outcome cancelled when the mode picker is dismissed", async () => { /* dismiss picker */ 
  expect((trackSpy.mock.calls.flat().find((e: any) => e.name === "review_launched") as any).outcome).toBe("cancelled");
});
it("emits ONE review_launched for a batch, with counts", async () => { /* deck:reviewBatch with 3 ids, 1 skipped */ 
  const evs = trackSpy.mock.calls.flat().filter((e: any) => e.name === "review_launched");
  expect(evs).toHaveLength(1);
  expect(evs[0]).toMatchObject({ batch: true, requested_count: 3 });
});
it("emits review_submitted mirroring deck:reviewSubmitDone and never the body", async () => { /* submit with body "SECRET-BODY" */ 
  expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "review_submitted")).toMatchObject({ verb: "approve", outcome: "ok" });
  expect(JSON.stringify(trackSpy.mock.calls.flat())).not.toContain("SECRET-BODY");
});
```

- [ ] **Step 3: Verify fail, implement**

`launchReviewFor` (`deckView.ts:2287`): one emit per terminal. `mode` via `modeProp(pickedId)` (collapses non-`"full"` to `"custom"`); `mode_was_pinned = resolveReviewMode(...) !== null`; outcome from the `LaunchReviewResult` arms (`ok` → `"launched"`, `"cancelled" in res` → `"cancelled"`, else `"failed"`), plus the two picker-dismissal early returns → `"cancelled"`. Single: `requested_count: 1`, `launched_count` 1/0, `batch: false`.

`launchReviewBatch` (`:2353`): one emit at the `reviewBatchToast` terminal (`:2528`) with `batch: true`, `requested_count: requests.length`, `launched_count: launched`, `failed_count: failures.length`, `skipped_count: skipped.length`, `layout: shared ? "shared" : "separate"`, `layout_asked` (true only when the QuickPick was raised — `target.kind === "new" && items.length > 1`). Early aborts (cost confirm declined, mode/destination cancelled) emit `outcome: "cancelled"` with the counts known at that point.

`submitReview` (`:2558`): emit next to each `deck:reviewSubmitDone` post, copying its `outcome`, plus `verb: m.verb`, `from_draft: m.fromDraft`. Never `m.body`.

- [ ] **Step 4: Run + docs + commit**

```
cd /abs/worktree && NODE_OPTIONS=--max-old-space-size=8192 npx vitest run test/unit/deckView.test.ts
npx vitest run test/unit/telemetry && npm run typecheck
```
Docs rows for both events. Commit: `feat(telemetry): review_launched and review_submitted`.

---

### Task 4: PR — `pr_merged`, `pr_work_seeded`

**Files:**
- Modify: `src/telemetry/events.ts`, `src/deckView.ts`, `src/tasksView.ts`
- Test: `test/unit/deckView.test.ts`, `test/unit/tasksView.test.ts`, `test/unit/telemetry/events.test.ts`
- Modify: `docs/TELEMETRY.md`

**Interfaces:**
- Consumes: `trackEvent` alias (deckView), plain `track` (tasksView).
- Produces: nothing later tasks use.

- [ ] **Step 1: Catalog + samples** (count 14 → 16)

```ts
| { name: "pr_merged"; outcome: "ok" | "cancelled" | "failed" | "refused"; merge_method?: "squash" | "merge" | "rebase";
    refusal?: "writes-off" | "facts-off" | "no-run" | "local" | "target-mismatch" | "no-checkout" | "in-flight" }
| { name: "pr_work_seeded"; reason: "ci" | "conflict" | "review"; source: "deck" | "tasks";
    outcome: "seeded" | "seeded-in-place" | "opened-not-seeded" | "open-failed" | "cancelled" | "refused";
    window_count: number; failed_repo_count: number; agent_seeded: boolean }
```

SAMPLES:

```ts
{ name: "pr_merged", outcome: "refused", refusal: "writes-off" },
{ name: "pr_work_seeded", reason: "review", source: "deck", outcome: "seeded", window_count: 1, failed_repo_count: 0, agent_seeded: true },
```

- [ ] **Step 2: Failing tests.** deckView: drive `deck:mergePr` against (a) `mergeWrites` off → `{ outcome: "refused", refusal: "writes-off" }`, (b) the happy path → `{ outcome: "ok", merge_method: "squash" }`. Drive `deck:addressPr` → `pr_work_seeded` with `reason: "review", source: "deck"`. tasksView: drive the `addressPr` message → event with `source: "tasks"`. Assert repo names/keys absent from the serialized calls.

- [ ] **Step 3: Implement.** `mergePr` (`deckView.ts:2693`): each of the six refusal branches (`:2717–2755`) emits `outcome: "refused"` with its `refusal` member; the `deck:mergeDone` posts carry the terminal `outcome` (+ `merge_method: cfg.mergeMethod` when a merge was attempted). `seedPrWork` (`:4026`): one emit per terminal — refusals (`:4028`, `:4042`, `:4066`, plan refusal `:4078`) → `"refused"`, picker dismissal (`:4073`) → `"cancelled"`, and the four terminal shapes (`:4098–4113`) map 1:1 onto the outcome enum; `window_count: plan.toOpen.length`, `failed_repo_count: failedRepos.length`, `agent_seeded: cfg.seedAgent`. `source`: add a `source: "deck" | "tasks"` parameter to `seedPrWork` defaulted `"deck"`; `tasksView.addressPr` (`:2944`) passes nothing extra — it emits its own `pr_work_seeded` only if it does not delegate to deckView's `seedPrWork`; if the paths are genuinely separate (they are — tasksView launches via `launch()`), emit from `addressPr` with `source: "tasks"`, `reason: "review"`, outcome from `launch()`'s boolean return (start reading it — the spec calls this out) and `"cancelled"` for the `resolveKickoff` undefined return.

- [ ] **Step 4: Run + docs + commit** (same commands as Task 3). Commit: `feat(telemetry): pr_merged and pr_work_seeded`.

---

### Task 5: Batch — `batch_started`, `batch_completed`, per-key failures

**Files:**
- Modify: `src/telemetry/events.ts`, `src/tasksView.ts`
- Test: `test/unit/tasksView.test.ts`, `test/unit/telemetry/events.test.ts`
- Modify: `docs/TELEMETRY.md`

**Interfaces:**
- Consumes: `startFlow`, `track`, `trackError`, `classifyFailure` (already imported by tasksView).
- Produces: nothing later tasks use.

- [ ] **Step 1: Catalog + samples** (count 16 → 18)

```ts
| { name: "batch_started"; flow_id: string; keys_count: number; is_fanout: boolean;
    tree_mode?: "fanout" | "orchestrator" | "parent" }
| { name: "batch_completed"; flow_id: string; outcome: Outcome; attempted: number; launched: number;
    failed: number; prompt_mode?: PromptModeProp; destination?: DestinationProp;
    layout?: "separate" | "shared"; layout_asked: boolean; duration_ms: number }
```

SAMPLES:

```ts
{ name: "batch_started", flow_id: "f1", keys_count: 4, is_fanout: false, tree_mode: "fanout" },
{ name: "batch_completed", flow_id: "f1", outcome: "launched", attempted: 4, launched: 3, failed: 1, prompt_mode: "plan", destination: "new", layout: "separate", layout_asked: true, duration_ms: 900 },
```

- [ ] **Step 2: Failing tests** in `test/unit/tasksView.test.ts` (this file already has takeBatch fixtures — extend them):

```ts
it("emits the batch funnel with matching flow_ids and honest counts", async () => { /* 3 keys, 1 resolve failure */ 
  const started = trackSpy.mock.calls.flat().find((e: any) => e.name === "batch_started") as any;
  const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "batch_completed") as any;
  expect(started.flow_id).toBe(done.flow_id);
  expect(done).toMatchObject({ attempted: 3, failed: 1 });
});
it("emits operation_failed per swallowed per-key failure", async () => {
  const errs = trackErrorSpy.mock.calls.flat().filter((e: any) => e.name === "operation_failed" && e.op === "workspace_write");
  expect(errs.length).toBeGreaterThanOrEqual(1);
});
it("a cancelled confirm emits batch_completed{outcome:cancelled} with no prompt_mode", async () => {
  const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "batch_completed") as any;
  expect(done.outcome).toBe("cancelled");
  expect("prompt_mode" in done).toBe(false);
});
```

- [ ] **Step 3: Implement in `takeBatch` (`tasksView.ts:2209`)**

`const flow = startFlow()` at entry; `batch_started` immediately (`keys_count: keys.length`, `is_fanout: parent !== undefined`). `tree_mode`: `takeTask`'s fork (`chooseTreeMode`, `:2677`) returns exactly the enum — pass its result into `takeBatch` as an optional arg from the fan-out/orchestrator dispatch sites (`:2139`, `:2145`); plain batch omits it. `batch_completed` at every exit: confirm declined / mode / destination / RC / provider dismissals → `outcome: "cancelled"` (omit unpicked props, conditional spread as in Task 1); terminals (`:2371–2383`, `:2509–2519`) → `"launched"` when `launched > 0` else `"failed"`, `attempted: keys.length`, counts from the loop, `layout`/`layout_asked` per the spec (asked only when `target.kind === "new" && keys.length > 1`), `duration_ms: flow.elapsedMs()`. The mid-loop `result.cancelled` break (`:2483`) → `"cancelled"` with partial counts. In each of the three swallowing catches (`:2364`, `:2440`, `:2495`):

```ts
trackError({ name: "operation_failed", op: "workspace_write", failure_class: classifyFailure(e), retryable: false });
```

- [ ] **Step 4: Run + docs + commit.** `npx vitest run test/unit/tasksView.test.ts test/unit/telemetry && npm run typecheck`. Docs rows. Commit: `feat(telemetry): batch launch funnel and per-key failure events`.

---

### Task 6: Explore — `explore_started`, `explore_completed`

**Files:**
- Modify: `src/telemetry/events.ts`, `src/tasksView.ts`
- Test: `test/unit/tasksView.test.ts`, `test/unit/telemetry/events.test.ts`
- Modify: `docs/TELEMETRY.md`

**Interfaces:**
- Consumes: `startFlow`, `track`, `classifyFailure`.
- Produces: `ExploreModeProp` + `toExploreModeProp()` in events.ts.

- [ ] **Step 1: Catalog + samples** (count 18 → 20)

```ts
/** The six stock Explore actions (EXPLORE_ACTION_DEFS in config.ts). A user-authored
 * action id must never be sent — toExploreModeProp collapses it to "custom". */
export const STOCK_EXPLORE_MODES = ["jiraTicket", "knowledge", "debug", "general", "supervise", "verify"] as const;
export type ExploreModeProp = (typeof STOCK_EXPLORE_MODES)[number] | "custom";
export function toExploreModeProp(id: string): ExploreModeProp {
  return (STOCK_EXPLORE_MODES as readonly string[]).includes(id) ? (id as ExploreModeProp) : "custom";
}

| { name: "explore_started"; flow_id: string; mode: ExploreModeProp; source: "command" | "notepad" }
| { name: "explore_completed"; flow_id: string; outcome: Outcome; mode: ExploreModeProp;
    cancel_point?: "remote-control" | "repos" | "action" | "topic" | "env" | "kickoff" | "agent";
    env_picked?: "listed" | "custom"; destination?: DestinationProp;
    provider?: "claude-code" | "copilot" | "cursor"; seeded_in_place?: boolean;
    repo_count: number; duration_ms: number; failure_class?: FailureClass }
```

SAMPLES:

```ts
{ name: "explore_started", flow_id: "f1", mode: "debug", source: "command" },
{ name: "explore_completed", flow_id: "f1", outcome: "cancelled", mode: "debug", cancel_point: "topic", repo_count: 2, duration_ms: 30 },
```

- [ ] **Step 2: Failing tests:** happy path (`outcome: "launched"`, matching flow_ids, `provider` present); cancel at the action picker (`cancel_point: "action"`, note `explore_started` fires only after a mode exists — assert ordering: started carries the picked mode); the topic string (use fixture topic `"SECRET-TOPIC"`) absent from serialized calls.

- [ ] **Step 3: Implement in `explore()` (`tasksView.ts:1288`)** and `runNotepadItem` (`:1389`, `source: "notepad"`). `startFlow()` at entry. RC-block and no-repos exits (`:1290`, `:1292`) precede mode choice — emit only `explore_completed` with `cancel_point` and `mode: "custom"`? No: emit nothing before a mode exists **except** those two early exits, where the honest shape is `explore_completed` with `cancel_point: "remote-control" | "repos"` and the *configured* mode (`cfg.exploreMode` collapsed via `toExploreModeProp`, `"ask"` → `"custom"`). After `chooseExploreAction` succeeds emit `explore_started`. Each later cancel point (`:1298` action — reached only in "ask" flow before started; fold as above — `:1323` topic, `:1331` env, `:1336` kickoff, `:1371` agent) emits `explore_completed{outcome:"cancelled", cancel_point}`. Success (`:1381`): `outcome: "launched"`, `provider: result.provider`, `seeded_in_place: result.seededInPlace`, `repo_count: services.length`, `env_picked` when the env step ran (`"custom"` when the user typed one). Failures caught by the message dispatcher already emit `operation_failed`; add `failure_class` only where `explore()` itself catches.

- [ ] **Step 4: Run + docs + commit.** Commit: `feat(telemetry): explore funnel`.

---

### Task 7: Orchestrator — `flow_action`, `flow_armed`, `flow_edge_fired`, `flow_settled`, `flow:dryRun` wire

**Files:**
- Modify: `src/telemetry/events.ts`, `src/types.ts` (new inbound message), `src/deckView.ts`, `src/webview/OrchestratorDrawer.tsx`
- Test: `test/unit/deckView.test.ts`, `test/webview/OrchestratorDrawer.test.tsx` (or this component's existing test file), `test/unit/telemetry/events.test.ts`
- Modify: `docs/TELEMETRY.md`

**Interfaces:**
- Consumes: `trackEvent` alias; `isSettled` from `src/engine/orchestrator/model.ts`; `toPromptModeProp`.
- Produces: `{ type: "flow:dryRun"; edges: number; fired: number; blocked: number }` in `InboundMessage`.

- [ ] **Step 1: Catalog + samples** (count 20 → 24)

```ts
export type FlowActionKind =
  | "create" | "rename" | "save" | "delete" | "add_planned" | "reset_edge"
  | "resume_approve" | "resume_disarm" | "save_command" | "dry_run";

| { name: "flow_action"; action: FlowActionKind; node_count?: number; edge_count?: number; fired_count?: number; blocked_count?: number }
| { name: "flow_armed"; armed: boolean; node_count: number; edge_count: number;
    unfirable_live: number; unfirable_pr_facts: number; unfirable_forge: number;
    source: "toggle" | "resume-banner" | "auto-skip" }
| { name: "flow_edge_fired"; edge_action: "launch" | "seed" | "notify" | "run"; ok: boolean; deferred: boolean;
    dest?: "worktree" | "new-window" | "current-window"; prompt_mode?: PromptModeProp; repo_count?: number }
| { name: "flow_settled"; node_count: number; edge_count: number }
```

SAMPLES:

```ts
{ name: "flow_action", action: "dry_run", edge_count: 3, fired_count: 1, blocked_count: 0 },
{ name: "flow_armed", armed: true, node_count: 4, edge_count: 3, unfirable_live: 0, unfirable_pr_facts: 1, unfirable_forge: 0, source: "toggle" },
{ name: "flow_edge_fired", edge_action: "launch", ok: true, deferred: false, dest: "worktree", prompt_mode: "implementation", repo_count: 1 },
{ name: "flow_settled", node_count: 4, edge_count: 3 },
```

Orchestrator flow ids are minted, not random — they are **never sent**, not even fingerprinted.

- [ ] **Step 2: Wire + webview.** `src/types.ts`: add the `flow:dryRun` variant to `InboundMessage`. `src/webview/OrchestratorDrawer.tsx`: after the `previewFlow` call (`:364`), post it once per dry-run invocation:

```ts
vscode.postMessage({ type: "flow:dryRun", edges: flow.edges.length,
  fired: previews.filter((p) => p.fired).length, blocked: previews.filter((p) => !p.fired).length });
```
(Adapt the two filters to `RulePreview`'s real verdict field — read `src/engine/orchestrator/preview.ts:18` first.) Webview test (jsdom, `waitFor`, this component's existing harness): clicking the dry-run toggle posts the message with numeric fields. **The webview must not import telemetry** — it posts a message; the host emits.

- [ ] **Step 3: Failing host tests** in `test/unit/deckView.test.ts`: `flow:arm` with a 2-node flow emits `flow_armed{armed:true, source:"toggle"}` with the unfirable split; `flow:dryRun {edges:3,fired:1,blocked:0}` emits `flow_action{action:"dry_run",...}` and a non-numeric payload (`edges: "x"` cast) emits nothing; a fired edge whose `applyFired` outcome is ok emits `flow_edge_fired{ok:true}`; when the last edge settles, exactly one `flow_settled` fires. Assert flow names/node keys absent from serialized calls.

- [ ] **Step 4: Implement in `src/deckView.ts`** (all `flow:*` handling is host-side; engine stays pure):
  - `flow_action`: emit in each gated case — `flow:create` (`:3477`), `flow:rename`, `flow:save` (+ `node_count`/`edge_count` from `m.flow`), `flow:addPlanned`, `flow:delete`, `flow:resetEdge`, `flow:resumeApprove`, `flow:resumeDisarm` (also emits `flow_armed` below), `flow:saveCommand`, and the new `flow:dryRun` case — which first validates: all three payload fields `Number.isFinite` and `>= 0`, else drop.
  - `flow_armed`: `flow:arm` (`:3559`) with `m.armed` and the `dead` split by `UnfirableRule.needs` (`:3581–3583`), `source: "toggle"`; `flow:resumeDisarm` (`:3689`) `armed: false, source: "resume-banner"`; the mid-pass auto-skip (`:926–931`) `source: "auto-skip"`.
  - `flow_edge_fired`: where `applyFired` outcomes are consumed (`:1002` / `:946–956`): per outcome entry, `edge_action` from the edge's `FlowAction`, `ok: outcome.ok`, `deferred: done.kind === "defer"`; for launch edges `dest: node.dest`, `prompt_mode: toPromptModeProp(node.mode)`, `repo_count: node.repos.length`.
  - `flow_settled`: after `applyFired` produces `next`, emit once when `next.edges.length > 0 && next.edges.every(isSettled)` and the previous flow state was not already all-settled.

- [ ] **Step 5: Run + docs + commit**

```
cd /abs/worktree && NODE_OPTIONS=--max-old-space-size=8192 npx vitest run test/unit/deckView.test.ts
npx vitest run test/webview test/unit/telemetry test/unit/types.test.ts && npm run typecheck && npm run build
```
(`npm run build` here specifically: the webview changed.) Docs rows for the four events. Commit: `feat(telemetry): orchestrator lifecycle events and flow:dryRun wire`.

---

### Task 8: Marketplace — `marketplace_opened`, `marketplace_action`, scan failure, scheme guard

**Files:**
- Modify: `src/telemetry/events.ts`, `src/marketplaceView.ts`
- Test: `test/unit/marketplaceView.test.ts`, `test/unit/telemetry/events.test.ts`
- Modify: `docs/TELEMETRY.md`

**Interfaces:**
- Consumes: `track`, `trackError`, `classifyFailure` (no alias needed — no collision here).
- Produces: nothing later tasks use.

- [ ] **Step 1: Catalog + samples** (count 24 → 26)

```ts
| { name: "marketplace_opened"; revealed: boolean; asset_count: number; plugin_count: number;
    marketplace_count: number; skills: number; commands: number; agents: number; hooks: number; not_set_up: boolean }
| { name: "marketplace_action"; action: "open" | "reveal" | "read" | "copy" | "open_external"; allowed?: boolean; truncated?: boolean }
```

SAMPLES:

```ts
{ name: "marketplace_opened", revealed: false, asset_count: 7, plugin_count: 2, marketplace_count: 1, skills: 3, commands: 2, agents: 1, hooks: 1, not_set_up: false },
{ name: "marketplace_action", action: "read", truncated: true },
```

- [ ] **Step 2: Failing tests** in `test/unit/marketplaceView.test.ts`: fresh open emits `marketplace_opened{revealed:false}` with counts matching the fixture assets; `mkt:read` on an oversized file emits `{action:"read", truncated:true}`; a scan failure (mock the assets reader to throw) emits `operation_failed{op:"marketplace_read"}`; `openExternal` with a `file://` URL is **not** opened (new scheme guard) — assert `vscode.env.openExternal` not called. Assert file paths absent from serialized telemetry calls.

- [ ] **Step 3: Implement in `src/marketplaceView.ts`:** reveal branch (`:20`) emits `revealed: true` with the last-known counts (keep them on the panel instance after each render; zeros before the first). First `render()` completion (`:83`) emits `revealed: false` with the real counts (by `AssetType`, plus `view.plugins.length`, `view.marketplaces.length`, `view.notSetUp`) — guard so a re-render does not re-emit. The scan-failure catch (`:74–77`) adds `trackError({ name: "operation_failed", op: "marketplace_read", failure_class: classifyFailure(e), retryable: true })`. Each `mkt:*` case emits `marketplace_action` (`allowed` for open/reveal, `truncated` for read). `openExternal` gains deckView's scheme guard (`deckView.ts:3711` pattern: parse, allow `https:`/`http:` only) — an adjacent defect the spec adjudicates fixing here.

- [ ] **Step 4: Run + docs + commit.** `npx vitest run test/unit/marketplaceView.test.ts test/unit/telemetry && npm run typecheck`. Commit: `feat(telemetry): marketplace events, scan-failure reporting, openExternal scheme guard`.

---

### Task 9: Tasks view — `tasks_fetched`, `lens_used`, `card_action`, `notepad_action`

**Files:**
- Modify: `src/telemetry/events.ts`, `src/types.ts` (`tasks:lensUsed`), `src/tasksView.ts`, `src/webview/App.tsx`
- Test: `test/unit/tasksView.test.ts`, the App webview test file, `test/unit/telemetry/events.test.ts`
- Modify: `docs/TELEMETRY.md`

**Interfaces:**
- Consumes: `track`; `Filter`/`Size` vocabularies from `src/types.ts`.
- Produces: `{ type: "tasks:lensUsed"; lens: "repo" | "search" }` in `InboundMessage`.

- [ ] **Step 1: Catalog + samples** (count 26 → 30)

```ts
| { name: "tasks_fetched"; filter: "unassigned" | "mine" | "mysprint" | "sprint" | "backlog" | "all";
    lens: "unassigned" | "mine" | "mysprint" | "sprint" | "backlog" | "all";
    size: "any" | "s" | "m" | "l"; task_count: number; repo_count: number;
    live_window_count?: number; authed: boolean }
| { name: "lens_used"; lens: "repo" | "search" }
| { name: "card_action"; action: "detail" | "change_status" | "add_to_sprint" | "remove_from_sprint" | "set_component" | "reorder" | "reset_order" }
| { name: "notepad_action"; action: "add" | "run" | "edit" | "remove" | "reorder" | "image_add" | "image_remove" }
```

SAMPLES:

```ts
{ name: "tasks_fetched", filter: "sprint", lens: "mysprint", size: "any", task_count: 12, repo_count: 3, live_window_count: 2, authed: true },
{ name: "lens_used", lens: "search" },
{ name: "card_action", action: "change_status" },
{ name: "notepad_action", action: "run" },
```

- [ ] **Step 2: Failing tests.** tasksView: a `fetch` for a filter the connector cannot serve asserts `filter` (requested) ≠ `lens` (clamped) — reuse the existing `effectiveFilter` fixtures; the unauthenticated early return (`:678`) emits `authed: false` with zero counts; `card_action` for `changeStatus`; `notepad_action` for `notepad:run` (which must ALSO still emit the Task 6 `explore_started{source:"notepad"}` — assert both). Host `tasks:lensUsed` case validates the enum (an unknown lens emits nothing). Webview (jsdom + `waitFor`, never a bare tick — async FileReader sends leak into the next test otherwise): typing in the search box posts exactly one `tasks:lensUsed{lens:"search"}` within the 500 ms debounce window (fake timers).

- [ ] **Step 3: Implement.** `src/types.ts`: add the message variant. `src/tasksView.ts` `fetch` case (`:677`): emit after the clamp (`:688`) with `filter: m.filter`, `lens`, `size: m.size`, `task_count: tasks.length`, `repo_count: repos.length`, `live_window_count` only when `cfg.trackOpenWindows`, `authed`. New `tasks:lensUsed` case: `if (m.lens === "repo" || m.lens === "search") track({ name: "lens_used", lens: m.lens });`. `card_action` emits in the seven cases (`detail` `:706`, `changeStatus` `:766`, `addToMySprint` `:770`, `removeFromSprint` `:774`, `setComponent` `:778`, `reorder` `:865`, `resetOrder` `:873`). `notepad_action` in the notepad cases (`:786–864`), mapping the message names to the enum. `src/webview/App.tsx`: on search-input change and on repo-lens selection, post `tasks:lensUsed` debounced 500 ms (one `setTimeout` per lens kind, cleared on re-fire; no telemetry import in the webview).

- [ ] **Step 4: Run + docs + commit**

```
npx vitest run test/unit/tasksView.test.ts test/webview test/unit/telemetry test/unit/types.test.ts
npm run typecheck && npm run build
```
Commit: `feat(telemetry): tasks view lenses and card/notepad actions`.

---

### Task 10: Setup and Doctor — `setup_started`, `setup_completed`, `doctor_run`

**Files:**
- Modify: `src/telemetry/events.ts`, `src/setup.ts`, `src/doctorView.ts`, `src/extension.ts` (pass `source` at the two runSetup call sites if needed)
- Test: `test/unit/setup.test.ts`, `test/unit/doctorView.test.ts`, `test/unit/telemetry/events.test.ts`
- Modify: `docs/TELEMETRY.md`

**Interfaces:**
- Consumes: `track` only. **No globalState or config writes** — `compat.test.ts:97–133` pins the cancelled wizard's zero-write behavior.
- Produces: nothing later tasks use.

- [ ] **Step 1: Catalog + samples** (count 30 → 33)

```ts
| { name: "setup_started"; source: "offer" | "command"; connector_steps: number }
| { name: "setup_completed"; outcome: "complete" | "cancelled-source" | "cancelled-root" | "signin-skipped" | "deferred"; signed_in: boolean }
| { name: "doctor_run"; fails: number; warns: number; outcome: "dismissed" | "copied" | "action";
    action_kind?: "command" | "setting" | "extension" | "external" }
```

SAMPLES:

```ts
{ name: "setup_started", source: "offer", connector_steps: 2 },
{ name: "setup_completed", outcome: "signin-skipped", signed_in: false },
{ name: "doctor_run", fails: 1, warns: 2, outcome: "action", action_kind: "command" },
```

- [ ] **Step 2: Failing tests.** setup.test.ts (add the telemetry mock — `track()` is a real no-op there today because the singleton is uninitialised, so tests must mock to observe): full happy path emits started + `{outcome:"complete", signed_in:true}`; cancel at repos root emits `{outcome:"cancelled-root"}` **and** the existing zero-config-write assertions still pass untouched; `maybeRunSetup`'s "Later" answer emits `{outcome:"deferred"}`. doctorView.test.ts: a run with one failing check where the user picks a command action emits `{fails:1, outcome:"action", action_kind:"command"}`; dismissal emits `{outcome:"dismissed"}`. Assert no path/URL from checks in serialized calls.

- [ ] **Step 3: Implement.** `src/setup.ts`: give `runSetup` a `source: "offer" | "command"` parameter (the `maybeRunSetup` offer at `:118` passes `"offer"`; the `agentFlow.setup` command registration passes `"command"` — default `"command"` keeps other callers compiling). Emit `setup_started` after computing `total` (`:46`). Map exits: `abort` at `:51` → `"cancelled-source"`, `:61` → `"cancelled-root"`, `:84` → `"signin-skipped"` (with `signed_in: false`); success (`:87–91`) → `"complete"`, `signed_in: true`. Emit at the call sites (keep `abort()` itself telemetry-free — it is a message helper). `maybeRunSetup`'s deferred branch (`:122`) emits `{name:"setup_completed", outcome:"deferred", signed_in:false}`. `src/doctorView.ts` `showDoctor` (`:196`): after the QuickPick resolves (`:202–212`), emit once with `summarize(checks)`'s `fails`/`warns` and the interaction outcome; `action_kind` from `picked.check.action.kind`.

- [ ] **Step 4: Run + docs + commit.** `npx vitest run test/unit/setup.test.ts test/unit/doctorView.test.ts test/unit/compat.test.ts test/unit/telemetry && npm run typecheck`. Commit: `feat(telemetry): setup funnel and doctor summary events`.

---

### Task 11: Docs sweep, CHANGELOG, full verification

**Files:**
- Modify: `docs/TELEMETRY.md` (final read-through), `src/telemetry/events.ts` (stale "41" comment), `CHANGELOG.md`
- Test: full suite

**Interfaces:**
- Consumes: everything above.
- Produces: the releasable branch.

- [ ] **Step 1: Docs consistency.** `docs/TELEMETRY.md`: verify all 23 new rows exist (the drift test checks presence, not accuracy — read each row against its catalog variant). Fix `events.ts:114`'s "The 41 safe reductions" comment → 43, matching the snapshot test and the docs' own stated count. Confirm the `tasksView.ts:879-889` anchor landed in Task 1.

- [ ] **Step 2: CHANGELOG.** Under `## [Unreleased]`:

```markdown
### Added
- Usage analytics phase 2: the Deck, review queue, PR merge/address, batch launches,
  Explore, orchestrator flows, Marketplace, task lenses, setup and Doctor now report
  anonymous usage events, under the same `agentFlow.telemetry.enabled` opt-out and the
  same no-user-strings guarantee documented in docs/TELEMETRY.md.

### Fixed
- Telemetry durations are monotonic, Jira HTTP failures classify by status, and
  cancelled Takes no longer inflate the custom-prompt-mode bucket.
```

- [ ] **Step 3: Mutation-check the emit tests (committed work only).** For one representative emit per surface (deck_opened, review_launched, batch_completed, flow_armed, marketplace_opened, tasks_fetched, setup_completed, doctor_run): comment out the emit, run the owning test file, confirm it FAILS, `git checkout -- <file>`. Any test that stays green is decorative — fix the test before proceeding.

- [ ] **Step 4: The four gates**

```
cd /abs/worktree && npm run typecheck
cd /abs/worktree && npm test            # Bash timeout: 600000; a single failure under contention is usually flake — re-run that file alone
cd /abs/worktree && npm run build
cd /abs/worktree && npm run test:cov    # 90/85 thresholds on changed files
```
Read the real exit codes (no `cmd > log; echo EXIT=$?` wrappers).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs(telemetry): phase 2 event rows, changelog, stale-anchor fixes"
```

---

## Self-Review

**Spec coverage:** catalog (Tasks 2–10, one surface each, 23 events total — counts per task: 12/14/16/18/20/24/26/30/33); fidelity fixes → Task 1; Deck error seam + alias → Task 2; wire additions → Tasks 7 (`flow:dryRun`) and 9 (`tasks:lensUsed`); marketplace scheme guard + `marketplace_read` op → Task 8; setup compat constraint → Task 10; docs/changelog/rollout verification → Task 11. The spec's "dev-host PostHog ingestion pass" is a release-time step outside this plan — flag it in the PR description.

**Placeholder scan:** the test snippets that say "drive the happy path" lean on fixtures that already exist in the named test files (takeBatch, review launch, setup wizard) — implementers extend those, not invent them; each such step names the fixture to extend. No TBDs.

**Type consistency:** `trackEvent` alias is defined in Task 2 and used by Tasks 3, 4, 7. `ExploreModeProp`/`toExploreModeProp` defined in Task 6, used only there. `Outcome`, `DestinationProp`, `PromptModeProp`, `TaskModeProp`, `FailureClass`, `Op` are Phase 1 exports consumed as-is. SAMPLES counts are cumulative and ordered by task number — executing tasks out of order will trip the count assertion; execute in order.
