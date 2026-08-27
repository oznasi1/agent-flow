# Orchestrator: instructing an agent, and real notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a rule tell the agent it starts what to do, and make a fired rule actually reach the human. Today an acting rule's only expressive control is the prompt mode, so a seeded agent inherits the first agent's brief and cannot be told why it is there; and `notify` posts a webview toast that is invisible unless the Deck is focused.

**Architecture:** The prompt composition is one pure function in `src/engine/prompt.ts` (a module with zero imports), reusing the placeholder-or-append helper that already lives there. The note is one optional field on `FlowEdge`, rendered by one control expressed once in the shared rule module so the canvas inspector and the list view cannot drift. Delivery changes are two call sites in `deckView.ts`. No signature changes to `launchPlanned` or `openWorkspace`.

**Spec:** `docs/superpowers/specs/2026-08-09-orchestrator-agent-instructions-design.md` — read it first; it records why the note lives on the rule, why `promptModes` is the reuse mechanism rather than a new config surface, and why Explore is the wrong pattern to copy.

**Tech Stack:** TypeScript, React (webview), VS Code extension API, Vitest + Testing Library.

## Global Constraints

- Work in the existing worktree `/Users/oznasi/dev/agent-flow/.claude/worktrees/orchestrator-core` on branch `worktree-orchestrator-core`. Never the main checkout, and do not switch branches.
- `npx tsc --noEmit` clean.
- `rm -rf dist && npm run build` must exit **0** — check the **exit code**, not whether files appeared; esbuild does not clear `dist/`.
- `npx vitest run` green. Baseline **2942 tests across 97 files**; it must only grow. Run it **once, in the foreground** — a parallel run in an earlier phase left 23 stray workers and stalled the agent that started them.
- **≥95% line coverage** on every file created or modified. `flowList.tsx`, `OrchestratorDrawer.tsx` and `orchestratorRule.ts` are at 100% — do not regress them.
- **Nothing reachable from `src/webview/` may import `fs`/`os`/`path`/`child_process`**, even transitively. `npm run build` is the only gate that catches it.
- `lib` is capped at **ES2022** — ES2023 methods fail `tsc`.
- Do NOT touch the `version` field in `package.json`, `package-lock.json`, or `CHANGELOG.md`.
- **Do not change the meaning of any persisted field.** Flow files live in users' home directories. Adding an optional field is fine — `validEdge` (`store.ts:56-66`) checks only required fields and its comment states unknown fields must ride along untouched.
- House rules: monospace for **identifiers and counts only**, never prose; **red only for a real failure**; **Arm is the only filled control on this surface**; no persistent hint lines.
- Conventional commits, scoped `orchestrator`.

## File Structure

| File | Responsibility |
|---|---|
| `src/engine/prompt.ts` | *(modify)* `composeAgentPrompt` — the note into the template. Pure, zero imports. |
| `src/engine/orchestrator/model.ts` | *(modify)* `FlowEdge.note?: string`. |
| `src/webview/orchestratorRule.ts` | *(modify)* `withNote`, so both presentations mutate identically. |
| `src/webview/OrchestratorDrawer.tsx` | *(modify)* the note input in the inspector. |
| `src/webview/flowList.tsx` | *(modify)* the note input in an open row; truncated in a closed row. |
| `src/deckView.ts` | *(modify)* compose at both acting call sites; the note in the spend modal; notification delivery. |
| `package.json` | *(modify)* `{note}` in `agentFlow.promptModes`' documented placeholder list. |
| `README.md` | *(modify)* one line: reusable instruction → a mode; once-off → the note. |

---

## Task 1: Compose the note into a prompt

**Files:**
- Modify: `src/engine/prompt.ts`
- Test: `test/unit/engine/prompt.test.ts`

**Interfaces:**
- Produces: `composeAgentPrompt(template: string, note?: string): string`. Task 2 calls it at both acting sites.

**Reuse what is already there.** `src/engine/prompt.ts` has **zero imports** and already contains the placeholder-or-append pattern this needs:

```ts
insertBeforeFiles(template: string, sentence: string): string
```

Its doc comment: *"Insert `sentence` just before the first {files} placeholder so the relevant-files block stays at the very end; append it when the template has no {files}. `sentence` is inserted verbatim (caller includes any leading space) — slice-based, so `$`…"*

**That slice-based detail is load-bearing and the reason not to reach for `.replace()`.** `String.prototype.replace` interprets `$&`, `$1`, `$'` in the *replacement* string. The note is user-authored free text, so a note containing `$&` would corrupt the output. Every insertion in this task must be slice-based for the same reason.

Rules:
- `{note}` in the template → substitute the note there, slice-based, so the mode author controls placement. Substitute **every** occurrence, or state in a comment why only the first.
- No `{note}`, but a note exists → `insertBeforeFiles(template, <heading><note>)`, so the relevant-files block stays last where the template author put it.
- No note, or a note that is empty or whitespace-only → return the template **unchanged**, byte for byte. Current behaviour must be exactly preserved.
- The composed result is **not** fed back through `renderPrompt`, so brace sequences inside a note are never interpolated.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/engine/prompt.test.ts`:

```ts
import { composeAgentPrompt } from "../../../src/engine/prompt";

describe("composeAgentPrompt", () => {
  it("returns the template untouched when there is no note", () => {
    expect(composeAgentPrompt("do {key}")).toBe("do {key}");
    expect(composeAgentPrompt("do {key}", undefined)).toBe("do {key}");
  });

  it("returns the template untouched for an empty or whitespace-only note", () => {
    // A user who focused the field and typed nothing must not change the prompt.
    expect(composeAgentPrompt("do {key}", "")).toBe("do {key}");
    expect(composeAgentPrompt("do {key}", "   \n ")).toBe("do {key}");
  });

  it("substitutes at {note} when the template has one", () => {
    expect(composeAgentPrompt("a {note} b", "on staging")).toBe("a on staging b");
  });

  it("keeps the relevant-files block last when it appends", () => {
    // The template author put {files} at the end on purpose.
    const out = composeAgentPrompt("work on {key}\n\n{files}", "on staging");
    expect(out.indexOf("on staging")).toBeLessThan(out.indexOf("{files}"));
  });

  it("appends when the template has neither {note} nor {files}", () => {
    const out = composeAgentPrompt("work on {key}", "on staging");
    expect(out).toContain("work on {key}");
    expect(out).toContain("on staging");
  });

  it("does not interpret a dollar sequence in the note", () => {
    // String.replace would turn `$&` into the matched text. The note is user
    // free text, so this is reachable, and silent corruption is the worst case.
    expect(composeAgentPrompt("a {note} b", "cost $& total")).toContain("cost $& total");
    expect(composeAgentPrompt("a {note} b", "use $1 here")).toContain("use $1 here");
    expect(composeAgentPrompt("plain", "cost $& total")).toContain("cost $& total");
  });

  it("leaves brace placeholders inside a note uninterpolated", () => {
    // The composed result never goes back through renderPrompt.
    expect(composeAgentPrompt("a {note} b", "mention {brief} literally"))
      .toContain("mention {brief} literally");
  });

  it("does not leave a {note} placeholder behind when there is no note", () => {
    // A mode author who added {note} must not ship the literal token to an agent.
    expect(composeAgentPrompt("a {note} b")).not.toContain("{note}");
  });
});
```

**Note on the last case:** it defines behaviour the other rules do not cover — a template with `{note}` and no note. Removing the token is the right answer (an agent must never be handed the literal `{note}`), and it is deliberately inconsistent with "return the template unchanged", so implement it as the stated exception and say so in a comment.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/unit/engine/prompt.test.ts`
Expected: FAIL — `composeAgentPrompt` is not exported.

- [ ] **Step 3: Implement**, reusing `insertBeforeFiles`, slice-based throughout.

- [ ] **Step 4: Confirm green, then all four gates**, then commit:

```bash
git commit -m "feat(orchestrator): compose a rule's note into the agent's prompt"
```

Mutation-check the dollar-sequence case (switch the insertion to `.replace()` and confirm it fails) and the whitespace-only case. Restore from a saved copy, never `git checkout --`.

---

## Task 2: The note on the rule, and into both acting paths

**Files:**
- Modify: `src/engine/orchestrator/model.ts`, `src/deckView.ts`
- Test: `test/unit/engine/orchestrator/model.test.ts`, `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `composeAgentPrompt` (Task 1).
- Produces: `FlowEdge.note?: string`. Task 3 renders it.

Add to `FlowEdge`, with a comment saying it applies to `launch` and `seed`, that a reusable instruction belongs in `agentFlow.promptModes` instead, and that `notify` uses its node's `message`:

```ts
  /** Extra, once-off text for the agent this rule starts — appended to the prompt
   * mode's template, or substituted at `{note}` if the template has one. For
   * `launch` and `seed` only; a `notify` rule's words live on its notify node.
   * Reusable instructions belong in `agentFlow.promptModes`, which the rule
   * already picks from — this is for what is specific to THIS transition. */
  note?: string;
```

In `deckView.ts`, both acting paths already resolve a template immediately before use. Wrap each:

- `performEdge` (launch) — `promptTemplate: composeAgentPrompt(found.mode.prompt, edge.note)`
- `performSeed` — the same, at its `openWorkspace` call

`launchPlanned` and `openWorkspace` **do not change signature**; composition happens at the call site.

**Also: the spend confirmation shows the note.** `askFirstSpend` names the ticket, repos and mode. When a note exists, include it — that modal is the consent gate for spending money unattended, and what the agent will be told is material to consent. Keep it readable when the note is long; truncate rather than let the modal grow unbounded.

Tests: a launch with a note passes a composed template to `launchPlanned` (assert the argument object, not a substring of a message); a launch with **no** note passes the mode's template byte-identically; the same pair for seed; the spend modal includes the note when present and reads correctly without one. `test/unit/deckView.test.ts`'s hoisted `h` mock hardcodes some config fields, so check how a field is read before trying to override it.

Mutation-check that dropping the note from the launch path fails a test, and separately from the seed path — one test covering both would let one site silently regress.

- [ ] **Steps:** failing tests → confirm red → implement → green → all four gates → commit, scoped `orchestrator`.

---

## Task 3: The note in both presentations

**Files:**
- Modify: `src/webview/orchestratorRule.ts`, `src/webview/OrchestratorDrawer.tsx`, `src/webview/flowList.tsx`, `src/webview/orchestratorStyles.ts`
- Test: `test/webview/OrchestratorDrawer.test.tsx`, `test/webview/flowList.test.tsx`

**Interfaces:**
- Produces: `withNote(flow, edge, note): Flow` in `orchestratorRule.ts`, alongside the existing `withMode`/`withDest`/`withNotifyMessage`.

**One control, expressed once.** `orchestratorRule.ts` exists because the inspector and the list view previously drifted — a review found `ACTION_LABEL` hardcoded a second time in the inspector while the module claimed both shared it. Put the mutation in `withNote` and the copy (label, placeholder) in that module too, so neither presentation can drift.

- A single-line input under `USING`, shown only for `launch` and `seed`. Selecting `notify` clears the note the way selecting it already clears `mode`, so a persisted edge carries no stale text the engine would ignore.
- A closed list row shows the note truncated after the mode, so a rule's full intent reads at a glance.
- The placeholder text must distinguish it from the mode sitting beside it — the mode is the reusable named instruction, the note is once-off. Write copy that earns that; do not just say "note".

House rules apply: no monospace on this text (it is prose, not an identifier), no red, and it must not become a second filled control.

Tests: typing a note saves it on the edge; switching the action to `notify` clears it; the input appears for `launch` and `seed` and not for `notify`; a closed row shows it truncated; the inspector and the list write the **same** field via the same helper. RTL queries throw on multiple matches, and a list of similar rows is where that bites — query by row scope.

Mutation-check the notify-clears-the-note behaviour and the show/hide-by-action rule.

- [ ] **Steps:** failing tests → confirm red → implement → green → all four gates → commit, scoped `orchestrator`.

---

## Task 4: Make a fired rule reach the human

**Files:**
- Modify: `src/deckView.ts`
- Test: `test/unit/deckView.test.ts`

Two changes, both in the acting block:

1. **`notify` → `vscode.window.showInformationMessage`** instead of posting a webview toast. The message text is unchanged; only delivery moves. It then persists in the Notifications bell, so a rule firing while the user is in another editor stays discoverable.
2. **A failed action also notifies.** `Couldn't create a git worktree in bite-me — not launching PROJ-12` is the class of message that must not be missed, and today it dies inside an unfocused panel. **A successful action stays a Deck toast** — a successful launch already announces itself by opening a window, so a notification on top is noise.

Follow the existing idiom in this file for non-modal notifications; several already exist. Do not make these modal — a modal steals focus, and an unattended flow that blocks the editor until acknowledged would be worse than the toast it replaces.

Tests: a fired notify calls `showInformationMessage` and does **not** post a toast; a failed action notifies; a **successful** action does not notify but does toast. That third one is the one most likely to be written vacuously — assert the notification spy's call count is zero, not merely that a toast happened.

Mutation-check each of the three, and quote the output.

- [ ] **Steps:** failing tests → confirm red → implement → green → all four gates → commit, scoped `orchestrator`.

---

## Task 5: Make the docs true

**Files:**
- Modify: `package.json`, `README.md`, `docs/superpowers/specs/2026-08-05-deck-orchestrator-flows-design.md`

- **`package.json`** — add `{note}` to the documented placeholder list in `agentFlow.promptModes`' `markdownDescription`, since it is now a real placeholder a mode author can use. Do not touch `version`.
- **`README.md`** — one line in the Orchestrator paragraph's own voice, stating the rule plainly: a reusable instruction belongs in a prompt mode; the note is for what is specific to one rule. Match the surrounding tone; no feature-list padding.
- **The design spec** — record that a rule can now carry a note, and that notify and failures reach the user as VS Code notifications while successes stay toasts. Check the Known limitations section for anything this work invalidates.

Run the suite: a docs change can still break a test that asserts on copy, and `package.json`'s configuration block is covered by `test/unit/config.test.ts` and the settings-snapshot tests.

- [ ] **Steps:** make the changes → `npx vitest run` → all four gates → commit, `docs(orchestrator)`.

---

## Done when

- A `launch` or `seed` rule can carry free text, and that text reaches the agent — via `{note}` where a template has one, appended otherwise, and **never silently dropped**.
- A note containing `$&` or `{brief}` survives verbatim.
- No note means a byte-identical prompt to today.
- The spend confirmation shows what the agent will be told before the first launch is approved.
- A fired `notify` and a failed action both raise a VS Code notification; a success does not.
- The docs state where reusable text goes versus once-off text.
- All four gates: `npm run build` exit 0, `tsc --noEmit` clean, `vitest run` green and grown from 2942, every touched file ≥95% lines.
- Every guard above has a test that **fails when the guard is removed**, verified by mutation.

## Not in this plan

`tell` — injecting into an already-running session. The spec records that it is now possible via the terminal surface, along with the four constraints a design must resolve, including a shell-execution hazard: `exitStatus` reports the shell exited, not whether `claude` is still running, so typing into a live shell would execute the instruction as a command. That needs solving before any code, and it is a separate phase.
