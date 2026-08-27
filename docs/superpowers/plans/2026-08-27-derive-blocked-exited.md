# Derive `blocked`, guardrail `exited` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `blocked` out of `stalled` for the four tool calls whose pendency provably means a human is being asked something, name the pending tool on the card either way, and stop `promoteExited` calling a card dead when the sessions probe failed rather than reported.

**Architecture:** Five tasks, each ending green and independently reviewable. Task 1 adds `pendingTool` to the wire with no state change. Task 2 declares `blocked` and routes it everywhere while **nothing produces it** — a compiling, behaviour-identical change. Task 3 turns it on. Task 4 is the guardrail, which is independent of Tasks 1–3 and could land first. Task 5 is the changelog and the whole-suite gate.

**Tech Stack:** TypeScript on the VS Code extension host, React webviews, esbuild, Vitest.

**Spec:** [`docs/superpowers/specs/2026-08-27-derive-blocked-exited-design.md`](../specs/2026-08-27-derive-blocked-exited-design.md) — read it before Task 1. The UX before/after it was approved against is `docs/mockups/2026-08-27-e3-ux-deltas.html` (gitignored, local only).

## Global Constraints

These are the project's rules, not this plan's preferences. Copied here because an implementer sees this file and not `CLAUDE.md`.

- **The CI gate is exactly four commands, all four must pass:** `npm ci`, `npm run typecheck`, `npm test`, `npm run build`. `npm run build` is a real gate, not a formality.
- **`npm test` is ~4,500 tests over 122 files and takes 2+ minutes.** It exceeds the default Bash tool timeout and auto-backgrounds at 120s. **Pass `timeout: 600000`.** Never pipe vitest through `tail` or `head` — it loses the failure list. A single failure under CPU contention is usually flake: re-run that file alone before believing it.
- **Run a subset while iterating:** `npx vitest run test/unit/engine/transcript.test.ts`, or `npx vitest run test/unit/engine -t "blocked"`.
- **The existing suite must pass UNMODIFIED.** A test you had to edit to go green is the signal to stop and re-examine the change, not to edit the test. This is the whole basis on which the spec ships this ungated. The one permitted exception is *adding* cases.
- **Webviews cannot reach Node.** Any module reachable from `src/webview/*` that imports `fs`/`os`/`path`/`child_process` — even transitively, even if never executed — breaks `npm run build`. `tsc` and most of the suite pass anyway. `src/engine/activity.ts` and `src/engine/bucket.ts` are both webview-reachable and must import nothing but `../types`. The new tool-class table goes in `src/engine/transcript.ts`, which is host-only.
- **Coverage thresholds are enforced** by `npm run test:cov`: 90% lines/statements, 85% branches/functions. Every arm added below is a branch.
- **Work in a git worktree.** `main` moves fast — several sessions land on it a day, and they share the root checkout. Use `EnterWorktree` or `git worktree add`, and use absolute paths in Bash.
- **Do not run two vitest runs concurrently**, in this session or across sessions.
- **`vscode` is aliased** to the hand-written mock at `test/_mocks/vscode.ts`. Webview test files opt into jsdom with a `// @vitest-environment jsdom` docblock.
- **The vocabulary gate** (`test/unit/vocabulary.test.ts`) enforces session-vs-agent wording and fires on hyphenated words in prose. Read the CHANGELOG entry in Task 5 against it before committing.
- **Every user-facing change gets a `## [Unreleased]` CHANGELOG entry.** That is Task 5. Do not bump `package.json` or build a `.vsix` — releasing is not part of this plan.

## File map

| file | responsibility after this plan | task |
|---|---|---|
| `src/engine/transcript.ts` | parses the pending tool name; owns the tool-class table and the derivation | 1, 3 |
| `src/types.ts` | `AgentState` union; `AgentActivity.pendingTool` | 1, 2 |
| `src/engine/activity.ts` | `STATE_RANK`; `promoteExited` signature. Stays `../types`-only | 2, 4 |
| `src/engine/bucket.ts` | the `needs` rung. Stays `fs`-free | 2 |
| `src/engine/attentionFs.ts` | `NEEDS_STATES`; threads the probe's readability | 2, 4 |
| `src/engine/sessions.ts` | `readOpenSessionsProbe`; `readOpenSessions` wraps it | 4 |
| `src/engine/status.ts` | `sessionsReadable` input, threaded to `promoteExited` | 4 |
| `src/deckView.ts` | passes `sessionsReadable` into `buildRunStatus` | 4 |
| `src/webview/deckParts.tsx` | `AGENT_STATE` arm; the `onTool` copy helper | 2 |
| `src/webview/DeckApp.tsx` | `cardSignal` arms | 2 |

---

### Task 1: `pendingTool` on the wire

Parse the name of the tool call a stale transcript is waiting on, and carry it on `AgentActivity`. **No state changes in this task** — nothing reads the new field yet, so the board renders identically.

**Files:**
- Modify: `src/engine/transcript.ts` (the `TranscriptLine` interface, a new `pendingToolName` helper, three returns in `deriveActivity`)
- Modify: `src/types.ts:240-260` (`AgentActivity`)
- Test: `test/unit/engine/transcript.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentActivity.pendingTool?: string | null`, read by Tasks 2 and 3. `pendingToolName` stays module-private.

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe("deriveActivity", ...)` block in `test/unit/engine/transcript.test.ts`. Note the local helpers already defined at the top of that block (`line`, `asstTool`, `userMsg`) — reuse them rather than redefining.

```ts
  // A stale pending tool call, with the tool_use block Claude Code actually writes.
  const asstToolNamed = (name: string): TranscriptLine => line({
    type: "assistant",
    slug: "export-streaming",
    message: {
      role: "assistant",
      stop_reason: "tool_use",
      content: [{ type: "text", text: "Running it now." }, { type: "tool_use", name, input: {} }],
    },
  });

  it("names the tool a pending call is waiting on", () => {
    expect(deriveActivity([userMsg, asstToolNamed("Bash")], NOW - 60_000, NOW).pendingTool).toBe("Bash");
  });

  it("names the tool on a fresh pending call too, so a working card can say what it is doing", () => {
    expect(deriveActivity([userMsg, asstToolNamed("Edit")], NOW - 5_000, NOW).pendingTool).toBe("Edit");
  });

  it("reads the LAST tool_use block when one turn holds several", () => {
    const multi = line({
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Read", input: {} }, { type: "tool_use", name: "Bash", input: {} }],
      },
    });
    expect(deriveActivity([userMsg, multi], NOW - 60_000, NOW).pendingTool).toBe("Bash");
  });

  // Claude Code owns this format. Every one of these used to be the shape it
  // wrote at some point, or plausibly could be next; none may throw, and all
  // must land on null so the Task 3 rule falls through to today's `stalled`.
  it.each([
    ["no content field at all", undefined],
    ["content as a bare string", "Running it now."],
    ["content with no tool_use block", [{ type: "text", text: "hi" }]],
    ["a tool_use block with no name", [{ type: "tool_use", input: {} }]],
    ["a tool_use block whose name is not a string", [{ type: "tool_use", name: 7 }]],
    ["a tool_use block whose name is empty", [{ type: "tool_use", name: "" }]],
    ["a null member", [null]],
  ])("yields a null pendingTool for %s", (_label, content) => {
    const l = line({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content } as never });
    expect(deriveActivity([userMsg, l], NOW - 60_000, NOW).pendingTool).toBeNull();
  });

  it("still reads stalled for every shape above — this task changes no state", () => {
    expect(deriveActivity([userMsg, asstTool], NOW - 60_000, NOW).state).toBe("stalled");
    expect(deriveActivity([userMsg, asstToolNamed("Bash")], NOW - 60_000, NOW).state).toBe("stalled");
    expect(deriveActivity([userMsg, asstToolNamed("AskUserQuestion")], NOW - 60_000, NOW).state).toBe("stalled");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/transcript.test.ts -t "pendingTool"`

Expected: FAIL. The `content` key is not on `TranscriptLine.message`, so `tsc` inside vitest rejects the literals, and `pendingTool` is not on `AgentActivity`. The last test ("still reads stalled") passes already — that is the point of it.

- [ ] **Step 3: Widen the two types**

In `src/engine/transcript.ts`, add `content` to the message shape. Keep it `unknown` — this file is written by another program:

```ts
export interface TranscriptLine {
  type?: string; // "user" | "assistant" | "attachment" | "file-history-snapshot" | …
  timestamp?: string; // ISO
  gitBranch?: string;
  cwd?: string;
  slug?: string;
  /** True on a subagent's turn. Its `message.model` is the subagent's, not this
   * session's, so the model read skips these. */
  isSidechain?: boolean;
  /** `content` is the API content-block array — text and tool_use blocks. Typed
   * `unknown` on purpose: Claude Code owns this format, and `pendingToolName`
   * below checks every hop rather than trusting the shape. */
  message?: { role?: string; stop_reason?: string | null; model?: string; content?: unknown };
}
```

In `src/types.ts`, add the field to `AgentActivity`, directly after `midWork`:

```ts
  /** The name of the tool call a pending turn is waiting on — "Bash", "Edit",
   * "AskUserQuestion" — or null when there is no pending call or the line could
   * not be read. This is what lets a card say WHY it is stopped instead of
   * hedging: `deriveActivity`'s `stalled` is deliberately true of both a
   * permission prompt and a long command, and the tool's name is the only
   * discriminator the transcript offers. Optional so every existing
   * AgentActivity literal (the test suite is full of them) still compiles. */
  pendingTool?: string | null;
```

- [ ] **Step 4: Write the parser**

In `src/engine/transcript.ts`, add above `deriveActivity`:

```ts
/**
 * The name of the tool call this line is waiting on, or null.
 *
 * Every hop is checked — the content array, its members, their `type` and their
 * `name` — for the same reason `readOpenSessions` narrows `RawSession`: Claude
 * Code owns this format and may change it under us. Anything unexpected yields
 * null, and null is the fall-through case for the class table in
 * `deriveActivity`, so a format change degrades to the pre-`blocked` reading
 * rather than to a wrong state or a throw.
 *
 * Reads the LAST tool_use block: one assistant turn can hold several parallel
 * calls, and the transcript cannot say which of them is the one still
 * outstanding. The last is the best available guess and matches what the
 * transcript's own tail-first reads elsewhere in this file already do.
 */
function pendingToolName(line: TranscriptLine): string | null {
  const content = line.message?.content;
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (!block || typeof block !== "object") continue;
    if ((block as { type?: unknown }).type !== "tool_use") continue;
    const name = (block as { name?: unknown }).name;
    return typeof name === "string" && name ? name : null;
  }
  return null;
}
```

- [ ] **Step 5: Carry it on the three returns that can have one**

In `deriveActivity`, after the existing `pendingTool` boolean, name the string. The boolean local keeps its name — it is what the existing `midWork` line and the `stalled` branch read — so the string gets a distinct one:

```ts
  const pendingTool = last.type === "assistant" && last.message?.stop_reason === "tool_use";
  const toolName = pendingTool ? pendingToolName(last) : null;
```

Then add `pendingTool: toolName` to the `working` and `stalled` returns only:

```ts
  if (age <= WORKING_WINDOW_MS) return { state: "working", lastActivityMs: mtimeMs, slug, midWork, pendingTool: toolName, ...model };
  // Stale with a tool still outstanding: the agent is at a permission prompt, or
  // a long command is running. The transcript cannot separate the two, so the
  // label is chosen to be true under either.
  if (pendingTool) return { state: "stalled", lastActivityMs: mtimeMs, slug, midWork, pendingTool: toolName, ...model };
```

Leave the `unknown`, `needs-you` and `idle` returns alone. Each is reachable only when no tool is pending — `needs-you` requires `stop_reason === "end_turn"`, `idle` requires `!pendingTool` — so `toolName` is null by construction there, and omitting the key keeps those literals byte-identical for the two `toEqual(UNKNOWN_ACTIVITY)` assertions at `transcript.test.ts:216` and `:220`.

- [ ] **Step 6: Run the new tests, then the two suites that own these types**

```
npx vitest run test/unit/engine/transcript.test.ts
npx vitest run test/unit/engine/transcriptLazy.test.ts test/unit/engine/status.test.ts test/unit/engine/activity.test.ts
npm run typecheck
```

Expected: all PASS, no test file edited.

- [ ] **Step 7: Commit**

```bash
git add src/engine/transcript.ts src/types.ts test/unit/engine/transcript.test.ts
git commit -m "feat(deck): carry the pending tool name on AgentActivity

Parsed from the tool_use block Claude Code already writes. Nothing reads
it yet — this is the datum the blocked derivation needs, landed on its
own so the parser's defensive narrowing can be reviewed apart from the
state change that consumes it."
```

---

### Task 2: declare `blocked`, route it, produce nothing

Add the union member and every site that must answer for it. **`deriveActivity` still never returns it**, so this task changes no observable behaviour — it is a pure compile-surface change that leaves the board identical. Adding the union member breaks two exhaustive `Record<AgentState, …>` types, which is why the routing and the card copy land here rather than later: the tree does not compile without them.

**Files:**
- Modify: `src/types.ts:93` (`AgentState` and its doc comment)
- Modify: `src/engine/activity.ts:26-33` (`STATE_RANK`)
- Modify: `src/engine/bucket.ts` (the `needs` rung in `deriveBucket`)
- Modify: `src/engine/attentionFs.ts:23-26` (`NEEDS_STATES`)
- Modify: `src/webview/deckParts.tsx:108-116` (`AGENT_STATE`, plus a new `onTool` helper)
- Modify: `src/webview/DeckApp.tsx:154-161` (the `cardSignal` switch)
- Test: `test/unit/engine/activity.test.ts`, `test/unit/engine/bucket.test.ts`

**Interfaces:**
- Consumes: `AgentActivity.pendingTool` (Task 1).
- Produces: the `"blocked"` union member and `onTool(pendingTool: string | null | undefined): string` exported from `deckParts.tsx`. Task 3 produces the state; nothing else in this plan consumes `onTool`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/engine/activity.test.ts`, add a new describe block. `mostActive` is not yet imported in that file — add it to the existing import.

```ts
describe("STATE_RANK via mostActive", () => {
  // A run holds several sessions and the card shows ONE reading. `blocked` must
  // win: a session frozen at a permission prompt cannot make progress at all,
  // and letting a session that politely ended its turn bury it is the same bug
  // the needs-you-over-working rung was written to fix.
  it("prefers blocked over needs-you", () => {
    expect(mostActive([act({ state: "needs-you" }), act({ state: "blocked" })]).state).toBe("blocked");
  });

  it("prefers blocked over every other state", () => {
    for (const loser of ["stalled", "exited", "working", "idle", "unknown"] as const) {
      expect(mostActive([act({ state: loser }), act({ state: "blocked" })]).state).toBe("blocked");
    }
  });

  it("breaks a blocked-vs-blocked tie on the most recent activity", () => {
    const out = mostActive([
      act({ state: "blocked", lastActivityMs: 100 }),
      act({ state: "blocked", lastActivityMs: 900 }),
    ]);
    expect(out.lastActivityMs).toBe(900);
  });
});
```

In the same file, extend the `promoteExited` describe:

```ts
  it("promotes a blocked reading whose process is gone — a dead session is not awaiting approval", () => {
    expect(promoteExited(act({ state: "blocked", midWork: true }), 0).state).toBe("exited");
  });
```

In `test/unit/engine/bucket.test.ts`, add to the `deriveBucket` describe:

```ts
  it("routes blocked to needs — a permission prompt is a human being asked something", () => {
    expect(deriveBucket({ agentState: "blocked" })).toBe("needs");
  });

  it("lets a landed merge outrank blocked, like every other agent state", () => {
    expect(deriveBucket({ agentState: "blocked", prMerged: true })).toBe("merge");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```
npx vitest run test/unit/engine/activity.test.ts test/unit/engine/bucket.test.ts
```

Expected: FAIL — `"blocked"` is not assignable to `AgentState`.

- [ ] **Step 3: Add the union member**

`src/types.ts`, replacing the existing type and its doc comment:

```ts
/** `blocked`, `stalled` and `exited` all mean "look at this", and all three were
 * `idle` before: an agent waiting at a permission prompt and one that died
 * mid-tool used to render in the calmest tone on the board. `stalled` and
 * `blocked` are derived from the transcript alone — `blocked` where the pending
 * tool's name settles what `stalled` can only hedge about (see
 * `deriveActivity`); `exited` needs session liveness and so is assigned by
 * `buildRunStatus` (see AgentActivity.midWork). */
export type AgentState = "working" | "needs-you" | "blocked" | "stalled" | "exited" | "idle" | "unknown";
```

- [ ] **Step 4: Rank it, route it, and add it to the needs set**

`src/engine/activity.ts` — add the rung and extend the comment above `STATE_RANK`:

```ts
// blocked outranks needs-you for the same reason needs-you outranks working: a
// session stopped at a permission prompt cannot make progress at all, and a run
// holding one alongside a session that ended its turn is a run about the frozen
// one. Letting the polite session bury it is the identical bug.
const STATE_RANK: Record<AgentState, number> = {
  blocked: 6,
  "needs-you": 5,
  stalled: 4,
  exited: 3,
  working: 2,
  idle: 1,
  unknown: 0,
};
```

Leave `IDLE_LIKE` alone. `blocked` must **not** join it: a session waiting on your approval is not idle, and `agent-idle-over` firing on it would auto-nudge past a modal dialog. Add that as a sentence to `IDLE_LIKE`'s existing doc comment, beside the note about `needs-you`/`working`/`unknown` being deliberately absent.

`src/engine/bucket.ts` — extend the `needs` rung:

```ts
  // blocked joins needs-you, stalled and exited here: all four mean a human has
  // to do something. blocked is the one that says which human question, and it
  // is split out of stalled rather than added beside it — see deriveActivity.
  if (
    i.agentState === "blocked" ||
    i.agentState === "needs-you" ||
    i.agentState === "stalled" ||
    i.agentState === "exited"
  ) {
    return "needs";
  }
```

`src/engine/attentionFs.ts`:

```ts
/** `deriveBucket`'s needs rung, named once so the cost ladder and its test agree. */
export const NEEDS_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  "blocked", "needs-you", "stalled", "exited",
]);
```

- [ ] **Step 5: Add the card copy**

`src/webview/deckParts.tsx` — add the arm and the shared helper. Export the helper: `DeckApp.tsx` needs the identical phrasing, and two copies of it would drift.

```ts
/** " · waiting on Bash", or "" when the tool name could not be read. One
 * definition so the card and the per-session row cannot phrase it differently. */
export function onTool(pendingTool: string | null | undefined): string {
  return pendingTool ? ` · waiting on ${pendingTool}` : "";
}

const AGENT_STATE: Record<AgentActivity["state"], { text: string; tone: Tone }> = {
  working: { text: "working", tone: "working" },
  "needs-you": { text: "ended turn", tone: "attn" },
  blocked: { text: "blocked", tone: "attn" },
  stalled: { text: "stalled", tone: "attn" },
  exited: { text: "exited", tone: "attn" },
  idle: { text: "idle", tone: "idle" },
  unknown: { text: "open", tone: "parked" },
};
```

The per-session row at `deckParts.tsx:145` renders `{st.text}` in a fixed-width slot beside the model chip and the age, so it stays the bare word there — `onTool` is for the card's own status line, which has the row to itself. Leave line 145 as it is.

`src/webview/DeckApp.tsx` — add the `blocked` arm and put the tool on `stalled` too. Import `onTool` from `./deckParts` (the file already imports from it).

```ts
    case "working": return { text: `working · ${timeAgo(r.agent.lastActivityMs)}`, tone: "working" };
    case "needs-you": return { text: `ended turn · ${timeAgo(r.agent.lastActivityMs)}`, tone: "attn" };
    case "blocked": return { text: `blocked${onTool(r.agent.pendingTool)} · ${timeAgo(r.agent.lastActivityMs)}`, tone: "attn" };
    case "stalled": return { text: `stalled${onTool(r.agent.pendingTool)} · ${timeAgo(r.agent.lastActivityMs)}`, tone: "attn" };
    case "exited": return { text: `exited · ${timeAgo(r.agent.lastActivityMs)}`, tone: "attn" };
```

Tone stays `attn` for `blocked`. Per the project's colour rule red is spent on a real failure and nothing else, and a permission prompt is not one — so no new token, and `tokens.test.ts`'s brand allowlist is untouched.

- [ ] **Step 6: Run the tests and the build**

```
npx vitest run test/unit/engine/activity.test.ts test/unit/engine/bucket.test.ts
npx vitest run test/unit/engine/attentionFs.test.ts test/webview
npm run typecheck
npm run build
```

`npm run build` matters here specifically: `activity.ts` and `bucket.ts` are both webview-reachable, and this task edited both.

Expected: all PASS. No existing test edited.

- [ ] **Step 7: Verify nothing produces the state yet**

```
npx vitest run test/unit/engine/transcript.test.ts
grep -rn '"blocked"' src/engine/transcript.ts
```

Expected: transcript tests PASS unchanged, and the grep finds **nothing**. If `deriveActivity` can already return `blocked`, Task 3 has been done early and the two commits should be separated.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/engine/activity.ts src/engine/bucket.ts src/engine/attentionFs.ts \
        src/webview/deckParts.tsx src/webview/DeckApp.tsx \
        test/unit/engine/activity.test.ts test/unit/engine/bucket.test.ts
git commit -m "feat(deck): declare and route the blocked agent state

Union member, rank above needs-you, the needs rung, the attention set and
the card copy. Nothing produces blocked yet, so the board is unchanged —
landed on its own because adding the member breaks two exhaustive
Record<AgentState, ...> types and the routing has to arrive with it."
```

---

### Task 3: produce `blocked` — the three-class rule

The behaviour change. Past the 45s working window, a pending tool's **name** selects the state.

**Files:**
- Modify: `src/engine/transcript.ts` (a new `BLOCKED_AFTER_MS` table; the `pendingTool` branch of `deriveActivity`)
- Test: `test/unit/engine/transcript.test.ts`

**Interfaces:**
- Consumes: `pendingToolName` and `AgentActivity.pendingTool` (Task 1); the `"blocked"` member (Task 2).
- Produces: nothing new. `BLOCKED_AFTER_MS` stays module-private.

- [ ] **Step 1: Write the failing tests**

Add to `describe("deriveActivity", ...)`, reusing `asstToolNamed` from Task 1:

```ts
  // Thresholds are measured, not assumed — see the spec's calibration table.
  // Each pair below pins BOTH sides of a ceiling, because a ceiling asserted
  // from one side only passes against a rule that ignores the tool entirely.
  it.each([
    // tool,               justUnder, justOver
    ["AskUserQuestion",    null,      46_000],
    ["ExitPlanMode",       null,      46_000],
    ["Edit",               50_000,    61_000],
    ["Write",              50_000,    61_000],
    ["NotebookEdit",       50_000,    61_000],
    ["Bash",               719_000,   721_000],
  ])("%s is stalled under its ceiling and blocked over it", (tool, under, over) => {
    if (under !== null) {
      expect(deriveActivity([userMsg, asstToolNamed(tool)], NOW - under, NOW).state).toBe("stalled");
    }
    expect(deriveActivity([userMsg, asstToolNamed(tool)], NOW - over, NOW).state).toBe("blocked");
  });

  it("still reads working inside the 45s window, whatever the tool", () => {
    expect(deriveActivity([userMsg, asstToolNamed("AskUserQuestion")], NOW - 10_000, NOW).state).toBe("working");
    expect(deriveActivity([userMsg, asstToolNamed("Edit")], NOW - 44_000, NOW).state).toBe("working");
  });

  // Gated but UNBOUNDED: a backgrounded subagent legitimately pends for 46
  // minutes (measured max 2,775s). Any ceiling here would flag every one of them.
  it.each(["Agent", "Workflow", "TaskOutput", "Monitor", "mcp__github__merge_pull_request"])(
    "%s stays stalled however long it pends — no ceiling can be honest",
    (tool) => {
      expect(deriveActivity([userMsg, asstToolNamed(tool)], NOW - 3_000_000, NOW).state).toBe("stalled");
    },
  );

  // Bounded but NOT GATED: a hung read is a wedged host, not a question. Calling
  // it blocked would claim somebody is being asked something when nobody is.
  it.each(["Read", "Grep", "Glob", "TodoWrite"])("%s stays stalled — nobody is being asked anything", (tool) => {
    expect(deriveActivity([userMsg, asstToolNamed(tool)], NOW - 3_000_000, NOW).state).toBe("stalled");
  });

  it("falls through to stalled when the tool name cannot be read", () => {
    // The additive property the whole ungated ship rests on: an unreadable line
    // derives exactly what it derived before this feature existed.
    expect(deriveActivity([userMsg, asstTool], NOW - 3_000_000, NOW).state).toBe("stalled");
  });

  it("carries the tool name onto the blocked reading, so the card can say why", () => {
    const a = deriveActivity([userMsg, asstToolNamed("Bash")], NOW - 800_000, NOW);
    expect(a.state).toBe("blocked");
    expect(a.pendingTool).toBe("Bash");
  });

  it("leaves a quiet-but-alive transcript reading idle — no pending tool, nothing owed", () => {
    // The Done-when's second half. A transcript whose last line is a user line
    // has work owed but no tool outstanding, so no class can apply.
    expect(deriveActivity([asstTool, userMsg], NOW - 3_000_000, NOW).state).toBe("idle");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/transcript.test.ts -t "ceiling"`

Expected: FAIL — every `justOver` case reads `stalled`, because nothing produces `blocked` yet. The unbounded/ungated/fall-through cases pass already; that is deliberate, they are the regression fence.

- [ ] **Step 3: Add the class table**

In `src/engine/transcript.ts`, below `WORKING_WINDOW_MS`:

```ts
/**
 * How long a pending call to each tool must stand before it means a human is
 * being asked something rather than a command is running. `deriveActivity`'s
 * `stalled` is deliberately true of both; the tool's NAME is the only
 * discriminator the transcript offers, and it settles the question only for a
 * tool that is permission-gated AND bounded — which is these six names.
 *
 * Thresholds are measured, not assumed: 279 transcripts in ~/.claude/projects
 * over eight days, ~13,000 tool calls, each gap taken between a
 * `stop_reason: "tool_use"` line and the `type: "user"` line that answered it.
 *
 *  - AskUserQuestion / ExitPlanMode — pendency IS the gate, so 0: there is no
 *    timing claim to make. Measured max 88,782s (24.7 hours), every second of
 *    which read `stalled` before this.
 *  - Edit / Write / NotebookEdit — measured max 47.2s across 1,566 calls, which
 *    is barely past WORKING_WINDOW_MS. 60s gives the ceiling a real margin.
 *  - Bash — the ONE threshold here that is not a heuristic: the Bash tool's own
 *    schema caps `timeout` at 600,000ms, so a pending call past that provably is
 *    not a running command. 720s is that cap plus two minutes for clock skew and
 *    a slow transcript flush; measured max 639s across 10,172 calls.
 *
 * A tool ABSENT from this table is never `blocked`, and for two distinct
 * reasons worth keeping straight when adding one:
 *
 *  - Agent, Workflow, TaskOutput, Monitor and every mcp__* call are gated but
 *    UNBOUNDED. A backgrounded subagent legitimately pends 46 minutes (measured
 *    max 2,775s), so no ceiling can be honest and none is offered.
 *  - Read, Grep, Glob and TodoWrite are bounded but NOT GATED. A hung read is a
 *    wedged host, not a question; calling it `blocked` would claim someone is
 *    being asked something when nobody is.
 *
 * WebFetch and WebSearch are gated and bounded in practice but the sample was
 * n=8, which is not a sample. They stay out until there is data.
 */
const BLOCKED_AFTER_MS: Record<string, number> = {
  AskUserQuestion: 0,
  ExitPlanMode: 0,
  Edit: 60_000,
  Write: 60_000,
  NotebookEdit: 60_000,
  Bash: 720_000,
};
```

- [ ] **Step 4: Consult the table in the stale-pending branch**

Replace the single `stalled` return in `deriveActivity` with:

```ts
  // Stale with a tool still outstanding. The table settles this for the four
  // gated-and-bounded tools; for everything else, and for a line whose tool name
  // could not be read, `stalled` stays the honest hedge it always was — the
  // agent is at a permission prompt, or a long command is running, and the
  // transcript cannot say which.
  if (pendingTool) {
    const ceiling = toolName === null ? undefined : BLOCKED_AFTER_MS[toolName];
    if (ceiling !== undefined && age > ceiling) {
      return { state: "blocked", lastActivityMs: mtimeMs, slug, midWork, pendingTool: toolName, ...model };
    }
    return { state: "stalled", lastActivityMs: mtimeMs, slug, midWork, pendingTool: toolName, ...model };
  }
```

`BLOCKED_AFTER_MS` is a `Record<string, number>` indexed by an arbitrary transcript string, so the lookup can be `undefined` at runtime whatever the type says — hence the explicit `!== undefined` rather than a truthiness test, which would also swallow the two `0` entries.

- [ ] **Step 5: Run the tests to verify they pass**

```
npx vitest run test/unit/engine/transcript.test.ts
npx vitest run test/unit/engine/transcriptLazy.test.ts test/unit/engine/status.test.ts test/unit/engine/attentionFs.test.ts
```

Expected: PASS, with no existing test edited. If `status.test.ts` or `attentionFs.test.ts` fails, a fixture is producing a named tool it did not mean to — read the failure before touching anything, because the fix belongs in this task's rule, not in that fixture.

- [ ] **Step 6: Mutation-check the ceilings**

The thresholds are the whole feature, and a test that asserts one side of a ceiling passes against a rule that ignores the tool. Verify each ceiling is load-bearing. **Commit first** — the `git checkout` that restores the mutant would otherwise revert uncommitted work:

```bash
git add src/engine/transcript.ts test/unit/engine/transcript.test.ts
git commit -m "wip: blocked derivation, pre-mutation-check"

# Mutant 1: every tool blocked past 45s. Should fail the unbounded/ungated fences.
# Mutant 2: Bash ceiling to 60s. Should fail the "719s is stalled" case.
# Mutant 3: drop the `!== undefined` guard for `> 0`. Should fail AskUserQuestion.
```

For each mutant: edit, run `npx vitest run test/unit/engine/transcript.test.ts`, confirm it **FAILS**, then `git checkout src/engine/transcript.ts`. A mutant that passes means the corresponding test is vacuous — fix the test, not the mutant.

- [ ] **Step 7: Amend the commit**

```bash
git add src/engine/transcript.ts test/unit/engine/transcript.test.ts
git commit --amend -F - <<'MSG'
feat(deck): derive blocked from the pending tool's name

Past the 45s working window, a pending call to one of four gated-and-
bounded tools means a human is being asked something rather than a
command running, and the card can say so instead of hedging. Thresholds
are measured over ~13k tool calls, not assumed; Bash's is provable from
the tool schema's own 600s timeout cap.

Every other tool keeps reading `stalled`, and so does a line whose tool
name cannot be parsed — which is what keeps this additive and lets the
existing suite pass unmodified.
MSG
```

---

### Task 4: the guardrail — a failed probe is not a dead process

Independent of Tasks 1–3. `promoteExited` calls a card's agent dead on a zero session count, and `readOpenSessions` returns `[]` for an *unreadable* directory too — so one failed `readdirSync` on `~/.claude/sessions` marks every mid-work card `exited` and inflates the sidebar badge. Live since 0.24.0.

**Files:**
- Modify: `src/engine/sessions.ts` (new `SessionsProbe` + `readOpenSessionsProbe`; `readOpenSessions` becomes a wrapper)
- Modify: `src/engine/activity.ts` (`promoteExited` signature only)
- Modify: `src/engine/status.ts:27-45` (`BuildRunStatusInput`), `:72` (the call)
- Modify: `src/engine/attentionFs.ts` (`AttentionDeps`, `defaultAttentionDeps`, the calls at `:140` and `:275`)
- Modify: `src/deckView.ts:2844` and `:3029`
- Test: `test/unit/engine/sessions.test.ts`, `test/unit/engine/activity.test.ts`, `test/unit/engine/status.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–3.
- Produces: `readOpenSessionsProbe(dir: string): { sessions: OpenSession[]; readable: boolean }`; `promoteExited(reduced: AgentActivity, liveSessionCount: number | null)`; `BuildRunStatusInput.sessionsReadable?: boolean`; `AttentionDeps.sessionsReadable?: () => boolean`.

- [ ] **Step 1: Write the failing tests**

`test/unit/engine/sessions.test.ts` — add a describe block. `readOpenSessionsProbe` needs adding to the existing import.

```ts
describe("readOpenSessionsProbe", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-probe-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reports readable with no sessions for an empty directory", () => {
    expect(readOpenSessionsProbe(dir)).toEqual({ sessions: [], readable: true });
  });

  it("reports NOT readable for a directory that does not exist", () => {
    // The distinction the guardrail exists for: `sessions: []` alone cannot say
    // whether nothing is running or nothing could be seen.
    expect(readOpenSessionsProbe(path.join(dir, "nope"))).toEqual({ sessions: [], readable: false });
  });

  it("readOpenSessions returns a bare array for both, unchanged", () => {
    expect(readOpenSessions(dir)).toEqual([]);
    expect(readOpenSessions(path.join(dir, "nope"))).toEqual([]);
  });
});
```

`test/unit/engine/activity.test.ts` — extend the `promoteExited` describe:

```ts
  it("refuses to promote when the session count is null — a failed probe is not a dead process", () => {
    // readOpenSessions returns [] for an unreadable ~/.claude/sessions, which is
    // indistinguishable from "nothing is running". null is the probe saying it
    // could not look, and it must never promote a live card to exited.
    expect(promoteExited(act({ midWork: true }), null).state).toBe("idle");
  });

  it("still promotes on a real zero", () => {
    expect(promoteExited(act({ midWork: true }), 0).state).toBe("exited");
  });
```

`test/unit/engine/status.test.ts` — add two cases immediately after the existing test at `:345` ("promotes a stale mid-work transcript with no live session to exited"), reusing that test's own inline input shape and the `LATER` constant declared just above it at `:343`. That file has no shared input-builder helper; every case spells the object out inline.

```ts
  it("does not report exited when the sessions registry could not be read", () => {
    // Identical inputs to the exited case above, plus the one fact that changes
    // the answer: [] agents because we could not look, not because nobody is home.
    const s = buildRunStatus({ run, ticket: null, projectsRoot: projRoot, nowMs: LATER, sessionsReadable: false });
    expect(s.agent.state).not.toBe("exited");
  });

  it("defaults sessionsReadable to true, so every existing caller behaves as before", () => {
    const s = buildRunStatus({ run, ticket: null, projectsRoot: projRoot, nowMs: LATER });
    expect(s.agent.state).toBe("exited");
  });
```

The second case is a deliberate duplicate of the existing `:345` test. It is worth the duplication: it is the one assertion that pins the *default*, and if a later change makes `sessionsReadable` required or flips its default, this is the test that says so in those words.

- [ ] **Step 2: Run the tests to verify they fail**

```
npx vitest run test/unit/engine/sessions.test.ts test/unit/engine/activity.test.ts test/unit/engine/status.test.ts
```

Expected: FAIL — `readOpenSessionsProbe` is not exported, `null` is not assignable to `number`, `sessionsReadable` is not on the input.

- [ ] **Step 3: Split the probe out of `readOpenSessions`**

In `src/engine/sessions.ts`, rename the existing function body to `readOpenSessionsProbe`, return the readability alongside the list, and leave `readOpenSessions` as a wrapper carrying the original doc comment. The only body change is the early `return` in the `catch`:

```ts
/** What a sessions read saw, and whether it could see at all. */
export interface SessionsProbe {
  sessions: OpenSession[];
  /** False when the directory itself could not be read. `sessions: []` alone
   * cannot say whether nothing is running or nothing could be SEEN, and
   * `promoteExited` needs that difference: it calls a card's agent dead on a
   * zero count, so a single failed read used to mark every mid-work card on the
   * board `exited` on the next 6s poll — and inflate the sidebar badge to
   * match. A record that fails to parse, or whose pid is dead, does NOT clear
   * this flag: the directory was read fine and that record really is not a live
   * session. */
  readable: boolean;
}

/** `readOpenSessions`, plus whether the directory could be read. See
 * `SessionsProbe.readable` for why the difference is worth a return type. */
export function readOpenSessionsProbe(dir: string): SessionsProbe {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return { sessions: [], readable: false };
  }
  // The `for (const name of names)` loop and every narrowing check inside it —
  // `kind`, `pid`, `sessionId`, `cwd`, `pidAlive` — move here verbatim from the
  // old body (sessions.ts:45-64). Do not change a line of it: a record that
  // fails to parse or whose pid is dead is not a failed READ, and must not clear
  // `readable`.
  return { sessions: out.sort((a, b) => a.startedAt - b.startedAt), readable: true };
}
```

The existing `// Oldest first:` comment above that final sort moves with it.

Then, keeping the existing doc comment above it verbatim:

```ts
export function readOpenSessions(dir: string): OpenSession[] {
  return readOpenSessionsProbe(dir).sessions;
}
```

The signature and return type are unchanged, so **all six existing call sites are untouched** — `deckView.ts:2844`, `deckView.ts:3182`, `tasksView.ts:420`, `:1347`, `:2765`, and `attentionFs.ts:85` — along with the mocks in `deckView.test.ts` and `tasksView.test.ts`.

- [ ] **Step 4: Widen `promoteExited`**

`src/engine/activity.ts` — **the body needs no change.** `null === 0` is already `false`, so a null count cannot promote. Only the parameter type and the doc comment move:

```ts
 * `liveSessionCount` is `null` when the sessions registry could not be READ, as
 * opposed to read and found empty. `readOpenSessions` returns `[]` for an
 * unreadable directory, which is indistinguishable from "nothing is running", so
 * the caller passes null instead and this refuses to promote — no single failed
 * probe may call a card dead. The test for it is `=== 0`, which null already
 * fails, so the guard is the type rather than a new branch.
 */
export function promoteExited(reduced: AgentActivity, liveSessionCount: number | null): AgentActivity {
  return reduced.midWork && reduced.state !== "working" && liveSessionCount === 0
    ? { ...reduced, state: "exited" }
    : reduced;
}
```

- [ ] **Step 5: Thread it through `status.ts`**

Add to `BuildRunStatusInput`, after `agents`:

```ts
  /** False when `~/.claude/sessions` could not be read this pass, so `agents`
   * being empty proves nothing. Defaults to TRUE when absent, which keeps every
   * existing caller and every existing test byte-identical — only the Deck,
   * which holds the probe, passes it. */
  sessionsReadable?: boolean;
```

And at the call:

```ts
  // `null`, not 0, when the registry could not be read: an empty `agents` is
  // then "we could not look", and promoting on it is how a live card got called
  // dead. See promoteExited and SessionsProbe.readable.
  const agent: AgentActivity = promoteExited(reduced, i.sessionsReadable === false ? null : agents.length);
```

`=== false` rather than `!i.sessionsReadable`, so an absent field reads as readable.

- [ ] **Step 6: Thread it through `attentionFs.ts`**

Add to `AttentionDeps`, beside `sessions`:

```ts
  /** Whether `sessions()` could read the registry at all this pass. Absent means
   * "assume yes", which keeps every existing test's deps literal valid. */
  sessionsReadable?: () => boolean;
```

In `defaultAttentionDeps`, probe once and share both halves. `defaultAttentionDeps` is constructed per pass (it takes `nowMs`), so this memo is per-pass and cannot go stale:

```ts
  // One probe, both readings. `sessions()` and `sessionsReadable()` are each
  // called at most once per pass but by different code paths, and reading the
  // directory twice could return two different answers.
  let probe: SessionsProbe | null = null;
  const sessionsProbe = (): SessionsProbe => (probe ??= readOpenSessionsProbe(defaultSessionsDir()));
  return {
    runs: () => readRuns(defaultRunsDir()),
    sessions: () => sessionsProbe().sessions,
    sessionsReadable: () => sessionsProbe().readable,
    // … the rest unchanged …
```

At **both** call sites, `:140` and `:275`. The local-group site at `:275` cannot fire (its sessions exist by construction) and its comment says so — change it anyway, because that same comment demands "both paths in this file read identically":

```ts
    const readable = deps.sessionsReadable?.() ?? true;
    const agentState = promoteExited(reduced, readable ? owned.length : null).state;
```

Update the import to pull `readOpenSessionsProbe` and `SessionsProbe`; `readOpenSessions` is no longer used in this file.

- [ ] **Step 7: Hand the Deck's own probe to `buildRunStatus`**

`src/deckView.ts:2844` — take the probe instead of the bare list, keeping the existing comment above it:

```ts
    const sessionsProbe = readOpenSessionsProbe(defaultSessionsDir());
    const allPlaces = groupByPlace(sessionsProbe.sessions);
```

and at the `buildRunStatus` call on line 3029:

```ts
      const status = buildRunStatus({
        run, ticket, projectsRoot, nowMs: now,
        openIdentities, prs,
        agents: agentsByKey.get(run.key) ?? [],
        activityRoots: activeRoots,
        sessionsReadable: sessionsProbe.readable,
      });
```

Leave `deckView.ts:3182` (the retire sweep's `livePlaces`) alone: it asks "which places have a live session", and a failed read yielding an empty set there is already the safe direction — the sweep retires nothing.

- [ ] **Step 8: Run the tests, typecheck and build**

```
npx vitest run test/unit/engine/sessions.test.ts test/unit/engine/activity.test.ts test/unit/engine/status.test.ts
npx vitest run test/unit/engine/attentionFs.test.ts test/unit/deckView.test.ts
npm run typecheck
npm run build
```

`deckView.test.ts` is the OOM risk in this suite — if it reports "156/157 and 0 failures", that is a worker heap-OOM, not a pass. Re-run it with `NODE_OPTIONS=--max-old-space-size=8192`.

Expected: PASS, no existing test edited.

- [ ] **Step 9: Mutation-check the guardrail**

Commit first, then confirm the guard is load-bearing:

```bash
git add -A && git commit -m "wip: guardrail, pre-mutation-check"
```

Mutant: change `i.sessionsReadable === false ? null : agents.length` to plain `agents.length`. Run `npx vitest run test/unit/engine/status.test.ts` and confirm it **FAILS**. Then `git checkout src/engine/status.ts`.

- [ ] **Step 10: Amend the commit**

```bash
git add -A
git commit --amend -F - <<'MSG'
fix(deck): a failed sessions probe no longer marks live cards exited

readOpenSessions returns [] for an unreadable ~/.claude/sessions, which
is indistinguishable from "nothing is running" — so one failed readdirSync
promoted every mid-work card on the board to `exited` on the next 6s poll
and inflated the sidebar badge to match. Live since 0.24.0.

readOpenSessionsProbe now reports readability alongside the list;
readOpenSessions wraps it, so all six existing call sites are untouched.
promoteExited takes `number | null` and refuses to promote on null.
sessionsReadable defaults to true wherever it is threaded, so every
existing caller behaves exactly as before.
MSG
```

---

### Task 5: changelog and the whole-suite gate

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`)

- [ ] **Step 1: Write the entry**

Under `## [Unreleased]` — create the heading if the last release closed it. Two entries, because the pair are a feature and a bug fix and a reader upgrading needs the second one to not read as a regression:

```markdown
### Added

- **A card stopped at a permission prompt now says so.** `stalled` has always
  been a deliberate hedge — a tool call outstanding for over 45 seconds is a
  permission prompt *or* a long command, and the transcript says the same thing
  for both. Where the pending tool's name settles it, the card now reads
  **blocked** and names what it is waiting on: `blocked · waiting on Bash · 12m
  ago`. That covers a pending question, a plan awaiting approval, and an edit or
  command left at the prompt. Every other tool keeps reading `stalled`, which now
  names its tool too — a backgrounded session can legitimately sit for
  three quarters of an hour, and nothing pretends to know better.

### Fixed

- **A session registry that could not be read no longer marks live cards as
  exited.** `exited` was assigned whenever no live session was found, and an
  unreadable `~/.claude/sessions` looked exactly like an empty one — so a single
  failed read could move every in-flight card to Action required and raise the
  sidebar badge to match, six seconds at a time. The read now reports whether it
  succeeded, and a card is only called exited when its process is known to be
  gone. Expect one or two cards that used to read `exited` to read `working`,
  `idle` or `stalled` instead.
```

- [ ] **Step 2: Check it against the vocabulary gate**

```
npx vitest run test/unit/vocabulary.test.ts
```

The gate treats a hyphenated word as standalone, so a phrase like "agent-flow" in prose fails it. Reword rather than adding to the allowlist.

- [ ] **Step 3: Run the full CI gate, exactly as CI runs it**

```
npm run typecheck
npm test          # use timeout: 600000 — this is ~4,500 tests over 2+ minutes
npm run build
```

Expected: all three PASS, with **no existing test file modified**. Verify that last claim rather than assuming it:

```bash
git diff --stat main -- test/ | grep -v "transcript.test.ts\|activity.test.ts\|bucket.test.ts\|sessions.test.ts\|status.test.ts"
```

Expected: empty. Any other test file in that diff means a behaviour changed that this plan did not intend — stop and read it.

- [ ] **Step 4: Check coverage on the changed files**

```
npm run test:cov
```

Thresholds: 90% lines/statements, 85% branches/functions. The new branches are the class-table lookup, the `undefined` ceiling arm, the null-count arm, and the two card-copy arms.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): blocked state and the exited guardrail"
```

- [ ] **Step 6: Report, do not merge**

Summarise: the four commits, the mutation-check results, the full-suite result with its actual counts, and confirmation that no existing test was edited. **Do not open a PR or merge** — `main` is branch-protected and landing is the maintainer's call.

---

## Verification of this plan against the spec

| spec requirement | task |
|---|---|
| `TranscriptLine.message.content`; `pendingTool` parsed defensively | 1 |
| `AgentActivity.pendingTool` | 1 |
| `AgentState` gains `blocked` | 2 |
| `STATE_RANK.blocked = 6`, above `needs-you` | 2 |
| `blocked` joins the `needs` rung | 2 |
| `NEEDS_STATES` gains `blocked` | 2 |
| `IDLE_LIKE` deliberately does NOT | 2 (step 4) |
| Card copy, both label sites, `pendingTool` on `stalled` too | 2 (step 5) |
| Human-gate class: `AskUserQuestion`, `ExitPlanMode`, no ceiling | 3 |
| Gated+instant class: `Edit`/`Write`/`NotebookEdit` at 60s | 3 |
| Gated+capped class: `Bash` at 720s | 3 |
| Fall-through keeps `stalled`, incl. unreadable name | 3 |
| `readOpenSessionsProbe`; `readOpenSessions` wraps it | 4 |
| `promoteExited` takes `number \| null` | 4 |
| `sessionsReadable` on `BuildRunStatusInput`, defaulting true | 4 |
| `sessionsReadable` on `AttentionDeps`, both call sites | 4 |
| CHANGELOG entry | 5 |
| Existing suite passes unmodified | 5 (step 3) |

Out of scope per the spec, and absent from every task above: a `blocked` orchestrator condition, a settings gate, `WebFetch`/`WebSearch` in the table, reading `permissions.allow`, and `status.ts:88`'s provider inference.
