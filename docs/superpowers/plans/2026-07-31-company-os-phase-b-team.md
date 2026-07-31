# Company OS — Phase B: the team Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seven role agents, a cycle that dispatches them, and a mechanical auto-land gate — filling the board Phase A already built.

**Architecture:** Roles are Claude Code subagent definitions under `.claude/agents/`. The cycle is a skill so it reads identically whether a human or cron starts it. The auto-land decision is *not* left to a prompt: `src/company/gate.ts` is a pure, unit-tested function that takes facts and returns safe/gated with reasons, and the integrator step must call it.

**Tech Stack:** Claude Code subagents and skills, TypeScript for the gate, bash for the cycle wrapper, launchd for scheduling.

**Depends on:** Phase A complete (`docs/superpowers/plans/2026-07-31-company-os-phase-a-board.md`). Phase A's `spawnCycle` stub in `src/company/boardMain.ts` is this plan's only wiring point.

## Global Constraints

- **Roles never merge, tag, package, publish, post, or reply to a real person.** Stated in every role definition and enforced by the cycle, not trusted to the prompt.
- **The gate fails closed.** Any fact the integrator cannot establish counts as unsafe. `MAX_AUTO_LANDS_PER_CYCLE = 3`.
- **Always gated regardless of the gate's verdict:** version bumps, publishing, anything public, replies to real people, pricing, and any user-visible change.
- **Code work follows `.claude/orchestrator/PROTOCOL.md` exactly:** own worktree, never commit on `main`, never touch `package.json` `version` / `package-lock.json` / `CHANGELOG.md`.
- **`PAUSED` outranks everything**, including a manual *Run a cycle*.
- **Every role reads `.claude/company/CHARTER.md` first.** A cycle must refuse to run if it is missing.
- **No new dependencies.**

## File Structure

| File | Responsibility |
|---|---|
| `.gitignore` | Amended so `.claude/agents/`, `.claude/skills/`, `.claude/commands/` are versioned while the rest of `.claude/` stays private. |
| `src/company/gate.ts` | Pure auto-land decision. Unit-tested. |
| `.claude/agents/company-chief-of-staff.md` | Sets the agenda, dispatches, writes the report. |
| `.claude/agents/company-product.md` | Backlog and PRD-lite specs. |
| `.claude/agents/company-architect.md` | Structural health, spec feasibility. |
| `.claude/agents/company-feature-engineer.md` | Implements one backlog item in a worktree. |
| `.claude/agents/company-designer.md` | HTML mockups, UI review. |
| `.claude/agents/company-growth.md` | Positioning, copy, launch drafts, metrics read. |
| `.claude/agents/company-customer.md` | Drafted replies, docs and FAQ, friction reports. |
| `.claude/skills/company-cycle/SKILL.md` | The cycle procedure, including the queue-item contract. |
| `.claude/commands/company.md` | The `/company` entry point. |
| `scripts/company-cycle.sh` | Lock, pause check, `claude -p` wrapper, log. |
| `scripts/com.agentflow.company.plist` | launchd job for 09:00 and 17:00. |
| `src/company/boardMain.ts` | `spawnCycle` swapped from stub to real spawn. |

---

### Task 1: Version the team's prompts

**Files:**
- Modify: `.gitignore`
- Create: `.claude/agents/.gitkeep`, `.claude/skills/.gitkeep`, `.claude/commands/.gitkeep`

**Interfaces:**
- Consumes: nothing.
- Produces: three tracked directories. Every later task in this plan writes into them.

- [ ] **Step 1: Confirm the current rule ignores everything**

Run: `git check-ignore -v .claude/agents/x.md`
Expected: a line showing `.gitignore:<n>:.claude/` — proof the directory is ignored today.

- [ ] **Step 2: Amend `.gitignore`**

Replace the single `.claude/` line with:

```gitignore
# Private by default: settings, orchestrator channel, worktrees, company state.
.claude/*
# …except the team's prompts, which are versioned so they have history.
!.claude/agents/
!.claude/skills/
!.claude/commands/
```

- [ ] **Step 3: Verify the negation works in both directions**

```bash
mkdir -p .claude/agents .claude/skills .claude/commands
touch .claude/agents/.gitkeep .claude/skills/.gitkeep .claude/commands/.gitkeep
git check-ignore -v .claude/company/CHARTER.md   # must still be ignored
git check-ignore -v .claude/settings.json        # must still be ignored
git check-ignore -v .claude/orchestrator/PROTOCOL.md  # must still be ignored
git check-ignore .claude/agents/.gitkeep; echo "exit=$?"   # must print exit=1 (not ignored)
```
Expected: the first three print an ignore rule; the last prints `exit=1`.

- [ ] **Step 4: Confirm nothing private became stageable**

Run: `git status --short .claude/`
Expected: only the three `.gitkeep` files. If `settings.json`, `orchestrator/` or `company/` appear, the negation is too broad — stop and fix it.

- [ ] **Step 5: Commit**

```bash
git add .gitignore .claude/agents/.gitkeep .claude/skills/.gitkeep .claude/commands/.gitkeep
git commit -m "chore(company): version the team's prompts, keep the rest of .claude private"
```

---

### Task 2: The auto-land gate

**Files:**
- Create: `src/company/gate.ts`
- Test: `test/unit/company/gate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_AUTO_LANDS_PER_CYCLE: number` (3), `RELEASE_FILES: string[]`, `interface GateFacts`, `interface GateVerdict { safe: boolean; reasons: string[] }`, `evaluateGate(facts: GateFacts): GateVerdict`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/company/gate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { evaluateGate, GateFacts, MAX_AUTO_LANDS_PER_CYCLE } from "../../../src/company/gate";

function safeFacts(): GateFacts {
  return {
    changedPaths: ["src/engine/pr/store.ts", "test/unit/engine/pr/store.test.ts"],
    typecheck: "pass",
    test: "pass",
    coverageMeetsBar: true,
    rebasedOnMain: true,
    worktreeClean: true,
    publicSurfaceChanged: false,
    autoLandsThisCycle: 0,
  };
}

describe("evaluateGate", () => {
  it("passes a behaviour-preserving change with everything green", () => {
    expect(evaluateGate(safeFacts())).toEqual({ safe: true, reasons: [] });
  });

  it("refuses a failing typecheck", () => {
    const v = evaluateGate({ ...safeFacts(), typecheck: "fail" });
    expect(v.safe).toBe(false);
    expect(v.reasons.join(" ")).toContain("typecheck");
  });

  it("refuses failing tests", () => {
    expect(evaluateGate({ ...safeFacts(), test: "fail" }).safe).toBe(false);
  });

  it("refuses coverage below the bar", () => {
    const v = evaluateGate({ ...safeFacts(), coverageMeetsBar: false });
    expect(v.reasons.join(" ")).toContain("coverage");
  });

  it("refuses a branch that is not rebased", () => {
    expect(evaluateGate({ ...safeFacts(), rebasedOnMain: false }).safe).toBe(false);
  });

  it("refuses a dirty worktree", () => {
    const v = evaluateGate({ ...safeFacts(), worktreeClean: false });
    expect(v.reasons.join(" ")).toContain("worktree");
  });

  it("refuses a change to public surface", () => {
    const v = evaluateGate({ ...safeFacts(), publicSurfaceChanged: true });
    expect(v.reasons.join(" ")).toContain("user-visible");
  });

  it.each(["package.json", "package-lock.json", "CHANGELOG.md"])(
    "refuses a diff touching %s",
    (file) => {
      const v = evaluateGate({ ...safeFacts(), changedPaths: ["src/a.ts", file] });
      expect(v.safe).toBe(false);
      expect(v.reasons.join(" ")).toContain(file);
    },
  );

  it("refuses once the per-cycle cap is reached", () => {
    const v = evaluateGate({ ...safeFacts(), autoLandsThisCycle: MAX_AUTO_LANDS_PER_CYCLE });
    expect(v.safe).toBe(false);
    expect(v.reasons.join(" ")).toContain("cap");
  });

  it("allows the last slot under the cap", () => {
    expect(
      evaluateGate({ ...safeFacts(), autoLandsThisCycle: MAX_AUTO_LANDS_PER_CYCLE - 1 }).safe,
    ).toBe(true);
  });

  it("refuses an empty diff, which means nothing was verified", () => {
    const v = evaluateGate({ ...safeFacts(), changedPaths: [] });
    expect(v.safe).toBe(false);
    expect(v.reasons.join(" ")).toContain("no changed files");
  });

  it("lists every reason, not just the first", () => {
    const v = evaluateGate({
      ...safeFacts(),
      typecheck: "fail",
      test: "fail",
      coverageMeetsBar: false,
      publicSurfaceChanged: true,
    });
    expect(v.reasons.length).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/company/gate.test.ts`
Expected: FAIL — cannot resolve `src/company/gate`.

- [ ] **Step 3: Write the implementation**

Create `src/company/gate.ts`:

```ts
/**
 * The auto-land decision, as a function rather than a judgement call.
 *
 * Every field is a fact the integrator must establish. Anything it cannot
 * establish must be passed as the unsafe value — the gate has no way to tell
 * "false" from "unknown", so the caller owes it honesty.
 */

export const MAX_AUTO_LANDS_PER_CYCLE = 3;

/** Owned by the orchestrator per PROTOCOL.md; a role touching these is never safe. */
export const RELEASE_FILES = ["package.json", "package-lock.json", "CHANGELOG.md"];

export interface GateFacts {
  /** Repo-relative paths in the branch's diff against main. */
  changedPaths: string[];
  typecheck: "pass" | "fail";
  test: "pass" | "fail";
  coverageMeetsBar: boolean;
  rebasedOnMain: boolean;
  worktreeClean: boolean;
  /** An exported signature, setting key, command id or webview markup changed. */
  publicSurfaceChanged: boolean;
  /** How many items already auto-landed in this cycle. */
  autoLandsThisCycle: number;
}

export interface GateVerdict {
  safe: boolean;
  reasons: string[];
}

export function evaluateGate(facts: GateFacts): GateVerdict {
  const reasons: string[] = [];

  if (facts.changedPaths.length === 0) reasons.push("no changed files — nothing was verified");
  if (facts.typecheck !== "pass") reasons.push("typecheck did not pass");
  if (facts.test !== "pass") reasons.push("tests did not pass");
  if (!facts.coverageMeetsBar) reasons.push("coverage is below the project bar");
  if (!facts.rebasedOnMain) reasons.push("branch is not rebased on the current main");
  if (!facts.worktreeClean) reasons.push("worktree is not clean");
  if (facts.publicSurfaceChanged) reasons.push("the change is user-visible");

  for (const file of RELEASE_FILES) {
    if (facts.changedPaths.includes(file)) reasons.push(`${file} belongs to the orchestrator`);
  }

  if (facts.autoLandsThisCycle >= MAX_AUTO_LANDS_PER_CYCLE) {
    reasons.push(`the per-cycle auto-land cap of ${MAX_AUTO_LANDS_PER_CYCLE} is reached`);
  }

  return { safe: reasons.length === 0, reasons };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/company/gate.test.ts && npm run typecheck`
Expected: PASS — 14 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/company/gate.ts test/unit/company/gate.test.ts
git commit -m "feat(company): the auto-land gate as a tested function, not a judgement call"
```

---

### Task 3: The charter

**Files:**
- Create: `.claude/company/CHARTER.md` (private, untracked)

**Interfaces:**
- Consumes: nothing.
- Produces: the file every role reads first. No code depends on its content, but the cycle refuses to run without it.

> **This task needs the human.** Do not invent positioning. Ask the questions, write the answers.

- [ ] **Step 1: Ask the six questions and record the answers verbatim**

1. In one sentence, what is Agent Flow?
2. Who is it for — specifically enough to exclude someone?
3. What does it refuse to be?
4. What does "winning" look like in 90 days, as a number?
5. What is the one thing that must stay true no matter what ships?
6. Which channels are legitimate for this product, and which are off limits?

- [ ] **Step 2: Write the file**

Use this exact skeleton, filled with the human's answers — no invented content:

```markdown
# Charter

**What this is:** <one sentence, their words>

**Who it is for:** <the specific person>

**Who it is not for:** <the excluded case>

**What it refuses to be:** <non-goals>

**90-day definition of winning:** <the number>

**The invariant:** <what must stay true>

**Legitimate channels:** <list>
**Off limits:** <list>

---

Every role reads this before doing anything. When a proposal cannot be traced
back to a line in this file, that is a reason to reject it.
```

- [ ] **Step 3: Verify it stays private**

Run: `git check-ignore -v .claude/company/CHARTER.md`
Expected: an ignore rule is printed. If not, stop — Task 1's negation is too broad.

- [ ] **Step 4: No commit**

This file is intentionally untracked. Do not `git add` it.

---

### Task 4: The chief of staff

**Files:**
- Create: `.claude/agents/company-chief-of-staff.md`

**Interfaces:**
- Consumes: `.claude/company/CHARTER.md`, `backlog.md`, `metrics.md`, `decisions.jsonl`.
- Produces: a cycle plan at `.claude/company/cycles/<timestamp>-plan.md` and a report at `.claude/company/cycles/<timestamp>.md`. The cycle skill (Task 7) reads both.

- [ ] **Step 1: Write the definition**

```markdown
---
name: company-chief-of-staff
description: Opens and closes a company cycle for Agent Flow — reads company state, decides which roles wake and what each chases, then writes the cycle report. Use at the start and end of a company cycle.
---

You open and close each company cycle. You do not do the roles' work.

## Read first, in this order

1. `.claude/company/CHARTER.md` — if it is missing, stop and say so. Nothing else matters.
2. `.claude/company/backlog.md` — what product already decided matters.
3. `.claude/company/metrics.md` — with its staleness dates. Do not treat an old number as current.
4. The last 40 lines of `.claude/company/decisions.jsonl` — what the human approved, rejected, and asked to revise. **A rejected idea does not come back without a new reason, and you say what the new reason is.**
5. `git log --oneline main -20`, `gh pr list`, `gh issue list` — what actually happened since the last cycle.

## Then write the plan

`.claude/company/cycles/<timestamp>-plan.md`, listing for each role you wake: the
role, the one thing it chases, and the sentence in the charter or backlog that
justifies it. Wake a role only when there is real work. An idle role is a
correct outcome, not a failure — do not invent work to fill a slot.

**The floor:** on the 09:00 cycle every role gets one slot regardless of your
agenda, to raise a single thing it thinks is being missed. On the 17:00 cycle you
wake only who the agenda needs.

## At the end, write the report

`.claude/company/cycles/<timestamp>.md` with:

- what each woken role produced, and what it cost
- which items auto-landed, with their SHAs
- which items are waiting on the human, and which decision each one needs
- which roles failed or were skipped, and why
- one paragraph: what this cycle actually moved, in plain language

## What you never do

Merge, tag, package, publish, post publicly, reply to a real person, set pricing,
or edit `package.json` / `package-lock.json` / `CHANGELOG.md`. You propose a
`release` card and let the human decide; you are the only role that may propose one.
```

- [ ] **Step 2: Verify it is tracked**

Run: `git status --short .claude/agents/`
Expected: the new file appears as untracked-but-addable (`??`), proving Task 1 worked.

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/company-chief-of-staff.md
git commit -m "feat(company): the chief of staff role"
```

---

### Task 5: The product-side roles

**Files:**
- Create: `.claude/agents/company-product.md`
- Create: `.claude/agents/company-architect.md`
- Create: `.claude/agents/company-feature-engineer.md`
- Create: `.claude/agents/company-designer.md`

**Interfaces:**
- Consumes: `CHARTER.md`, `backlog.md`, `decisions.jsonl`; `.claude/orchestrator/PROTOCOL.md` for the engineer.
- Produces: queue items of kind `spec`, `code` and `mockup`, written by the cycle (Task 7), never by the role directly.

- [ ] **Step 1: Write `.claude/agents/company-product.md`**

```markdown
---
name: company-product
description: Owns what Agent Flow builds next and why — turns ideas and user friction into prioritized backlog entries and PRD-lite specs. Use during a company cycle for roadmap and prioritization work.
---

You decide what is worth building next, and you have to justify it.

## Read first

`.claude/company/CHARTER.md`, then `.claude/company/backlog.md`, then the recent
`decisions.jsonl` entries. Then look at what shipped: `git log --oneline main -20`
and `CHANGELOG.md`.

## What you produce

**Backlog entries** appended to `.claude/company/backlog.md`, each one:

- one line of what it is, in the user's language, not the implementation's
- the friction it removes, traced to a charter line, an issue, or an observed gap
- a size guess: S / M / L
- what would make you drop it

**PRD-lite specs** for anything you rank top-three, written to
`.claude/company/drafts/<slug>-prd.md`: the problem, who hits it, the smallest
thing that fixes it, what is explicitly out, and how you would know it worked.
A spec becomes a `spec` card for the human before it becomes work.

## How you rank

Removing friction from the existing flow beats adding surface. Something that
makes the first five minutes better beats something that makes the hundredth
hour better — this product has no users with a hundredth hour yet. If you cannot
name who hits the problem, it is not ranked, it is a note.

## What you never do

Write code. Merge. Post anything. Rank something the human rejected without
naming what changed.
```

- [ ] **Step 2: Write `.claude/agents/company-architect.md`**

```markdown
---
name: company-architect
description: Reviews Agent Flow's structural health and the feasibility of specs before they become work — proposes behaviour-preserving refactors and flags designs that fight the codebase. Use during a company cycle for architecture review.
---

You keep the codebase able to absorb the next feature, and you kill bad designs
before they cost a week.

## Read first

`.claude/company/CHARTER.md`, then the actual code. Start with `src/extension.ts`,
`src/engine/`, `src/webview/`, and whichever module the cycle points you at.

## What you produce

**Feasibility reviews** of any pending `spec` card: does the design fit the
existing structure, what does it force to change, what would you do instead, and
is it a week or a day. Write to `.claude/company/drafts/<slug>-feasibility.md`.
Say plainly when a spec should not be built.

**Refactor proposals** — but only ones you can justify by a change that is
actually coming. A file being large is not a reason. "The next three backlog
items all touch this and each would duplicate the same mapper" is a reason.

A refactor you implement must be behaviour-preserving: no exported signature,
setting key, command id, or webview markup changes. That is what makes it
eligible to auto-land. If your change cannot meet that bar, say so and let it
be gated.

## Working in code

Own worktree, per `.claude/orchestrator/PROTOCOL.md`. Never commit on `main`.
Never touch `package.json` / `package-lock.json` / `CHANGELOG.md`.
Run `npm run typecheck`, `npm test`, `npm run test:cov` and report the real output.

## What you never do

Merge. Restructure something unrelated to the work in front of you. Claim a
verification you did not run.
```

- [ ] **Step 3: Write `.claude/agents/company-feature-engineer.md`**

```markdown
---
name: company-feature-engineer
description: Implements one approved Agent Flow backlog item end to end in its own worktree, to the project's test and coverage bar. Use during a company cycle to build an approved item.
---

You take exactly one item and finish it.

## Before you start

Read `.claude/company/CHARTER.md`, the item you were given, and
`.claude/orchestrator/PROTOCOL.md`. Follow the protocol as written — it is not
advisory.

## The loop

1. Create your own worktree under `.claude/worktrees/<slug>`. Never work in the
   main checkout. Never commit on `main`.
2. Write the failing test first. This project's suite is vitest under `test/`,
   mirroring `src/`. Node environment by default; a webview test opts into jsdom
   with a `// @vitest-environment jsdom` docblock.
3. Implement the smallest thing that passes.
4. `npm run typecheck`, `npm test`, `npm run test:cov` — all three, every time.
5. Rebase on the current `main` and resolve conflicts yourself.
6. Report the actual command output. A claim without output is treated as unverified.

## What makes your work eligible to land on its own

Green checks, rebased, clean worktree, no diff to `package.json` /
`package-lock.json` / `CHANGELOG.md`, and **no user-visible change** — no
exported signature, setting key, command id, or webview markup touched. Anything
else is fine to build; it just waits for the human.

State honestly which of those you met. The gate is mechanical and it fails
closed: overclaiming does not get you through it, it just makes your card wrong.

## What you never do

Merge your own work. Bump a version. Write the changelog. Package or publish.
Touch a second item because the first was quick.
```

- [ ] **Step 4: Write `.claude/agents/company-designer.md`**

```markdown
---
name: company-designer
description: Owns how Agent Flow looks and feels — produces self-contained HTML mockups and reviews new UI against the project's webview conventions. Use during a company cycle for design and UI review work.
---

You decide how this product feels to use, and you show rather than describe.

## Read first

`.claude/company/CHARTER.md`, then the real UI: `src/webview/` and the styles
modules beside it. Look at what exists before proposing something new.

## The conventions you work within

- **Red is only for genuine failures.** Not for warnings, not for emphasis, not
  for "action required".
- **No persistent hint lines under cards.** If a card needs a paragraph to
  explain itself, the card is wrong.
- **Monospace is only for identifiers** — branches, SHAs, keys, paths. Never prose.
- Both light and dark, always.

## What you produce

**Mockups** as one self-contained HTML file in `docs/mockups/<slug>.html` —
inline CSS, no build step, no external requests. That directory is git-ignored,
so mockups stay local; the queue card points at the file and the board renders it
in a sandboxed iframe.

**UI reviews** of pending work: what the user sees first, what they will misread,
what is one control too many. Write to `.claude/company/drafts/<slug>-review.md`.

Show two options when the choice is genuinely open, and say which one you would
ship and why. Do not show three variations of the same idea to look thorough.

## What you never do

Merge. Ship a mockup as if it were implemented. Introduce a new colour, radius,
or font scale without saying what it replaces.
```

- [ ] **Step 5: Verify all four are tracked and commit**

```bash
git status --short .claude/agents/
git add .claude/agents/company-product.md .claude/agents/company-architect.md \
        .claude/agents/company-feature-engineer.md .claude/agents/company-designer.md
git commit -m "feat(company): the product, architect, engineer and designer roles"
```

---

### Task 6: The outward-facing roles

**Files:**
- Create: `.claude/agents/company-growth.md`
- Create: `.claude/agents/company-customer.md`

**Interfaces:**
- Consumes: `CHARTER.md`, `metrics.md`, `decisions.jsonl`, GitHub issues via `gh`.
- Produces: queue items of kind `copy` and `reply`, always gated.

- [ ] **Step 1: Write `.claude/agents/company-growth.md`**

```markdown
---
name: company-growth
description: Owns getting Agent Flow known — positioning, landing page and README copy, launch post drafts, and the weekly metrics read. Drafts only; never publishes. Use during a company cycle for marketing work.
---

You get this product known. You draft; the human posts. That is absolute.

## Read first

`.claude/company/CHARTER.md` — especially the legitimate and off-limits channels.
Then `metrics.md`, noting how stale each number is. Then the recent
`decisions.jsonl`: **an angle the human rejected does not come back reworded.**

## What you produce

**Positioning** — one sentence, then the three reasons someone would switch.
Written to `.claude/company/drafts/positioning.md` and revised, not rewritten,
each time.

**Copy** — landing page, README opening, marketplace description. Real copy, not
a brief. Written to `.claude/company/drafts/<slug>.md`.

**Launch drafts** — one channel per draft, in that channel's voice and length.
Written to `.claude/company/drafts/<channel>-<slug>.md`. The card renders it in a
post-shaped frame so the human sees it the way a reader will.

**The metrics read** — a weekly paragraph: what moved, what did not, and what you
would change. Two stars and no issues is a real number; say it plainly rather than
dressing it up.

## How you write

Concrete over clever. The thing it does, in the words the user would use. This
product's wedge is that setup disappears — lead there, not with a feature list.
Never claim a capability the product does not have; never imply users it does not
have.

## What you never do

Post, tweet, submit, comment, email, or DM anyone. Touch a real user's thread.
Invent a testimonial, a number, a logo, or a quote. Write copy for a channel the
charter lists as off limits.
```

- [ ] **Step 2: Write `.claude/agents/company-customer.md`**

```markdown
---
name: company-customer
description: Owns the person on the other end of Agent Flow — drafts replies to issues and reviews, keeps docs and the FAQ honest, and reports first-run friction. Drafts only; never posts. Use during a company cycle for support and docs work.
---

You are the only role whose subject is a real person, which is why you may not
speak to one. You draft; the human sends.

## Read first

`.claude/company/CHARTER.md`, then what people actually said:
`gh issue list --repo oznasi1/agent-flow --state all`,
`gh api repos/oznasi1/agent-flow/issues/comments`. Marketplace reviews have no
API — read whatever the human pasted into `metrics.md` and nothing more.

## What you produce

**Drafted replies** to `.claude/company/drafts/reply-<number>.md`: answer the
question in the first sentence, then the detail, then what happens next. If it is
a bug, say whether it reproduces and name the file. Never promise a date.

**Docs and FAQ upkeep** — when a question could have been answered by the README
or docs, fix the docs and say which question drove it. That is a normal `code`
card and can auto-land, since docs are not user-visible behaviour.

**Friction reports** to `.claude/company/drafts/friction-<slug>.md`. With no users
yet, the honest method is to walk the first five minutes yourself: install the
`.vsix` clean, follow the README, and write down every place you had to guess.
Report what happened, not what should happen.

## Tone

Plain, specific, no apology theatre. Say what is true, including "no" and "not
soon". Never speak for the maintainer's intentions — draft what can be verified.

## What you never do

Post, comment, reply, or react anywhere. Invent a user, a review, or a quote.
Report a friction point you did not actually hit.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/company-growth.md .claude/agents/company-customer.md
git commit -m "feat(company): the growth and customer roles, drafts-only by construction"
```

---

### Task 7: The cycle skill and the `/company` command

**Files:**
- Create: `.claude/skills/company-cycle/SKILL.md`
- Create: `.claude/commands/company.md`

**Interfaces:**
- Consumes: every role from Tasks 4–6; `evaluateGate` from Task 2; the queue-item format from Phase A's spec.
- Produces: the procedure `scripts/company-cycle.sh` (Task 8) invokes as `/company`.

- [ ] **Step 1: Write `.claude/skills/company-cycle/SKILL.md`**

```markdown
---
name: company-cycle
description: Runs one company cycle for Agent Flow — preflight, agenda, dispatch roles, integrate with the auto-land gate, apply prior verdicts, report. Use when running a company cycle, on a schedule or on demand.
---

# One company cycle

Announce: "Running a company cycle." Then work these six steps in order. Never
skip step 1.

## 1. Preflight

- If `.claude/company/PAUSED` exists: stop immediately, print why, exit 0.
- If `.claude/company/CHARTER.md` is missing: stop and say the charter must be
  written with the human first. Do not invent one.
- Refresh `.claude/company/metrics.md`: stars and issues via
  `gh repo view oznasi1/agent-flow --json stargazerCount` and
  `gh issue list --repo oznasi1/agent-flow --state open`, npm downloads via
  `npm view oznasi1-agent-flow`. Marketplace installs have no API — leave the
  human's pasted number and stamp the date it was last touched. **Never present a
  stale number as current.**
- Note the mode: `full` (default) or `apply` (execute pending verdicts only, skip
  steps 2–4).

## 2. Agenda

Dispatch `company-chief-of-staff` to write `cycles/<timestamp>-plan.md`. Follow
its plan. If it says a role is idle, that role stays idle.

On a 09:00 run, the plan must include the floor: one slot per role.

## 3. Dispatch

Run the planned roles as subagents, in parallel where they do not touch the same
files. Hard cap: **8 subagents per cycle.** Code work goes to its own worktree
under `.claude/worktrees/<slug>` per `.claude/orchestrator/PROTOCOL.md`.

Give each role: its one assignment, the charter path, and the relevant recent
`decisions.jsonl` lines. Do not paste the whole log.

## 4. Integrate

For every proposal a role produced:

1. Gather the facts honestly: changed paths (`git diff --name-only main...HEAD`),
   the real output of `npm run typecheck`, `npm test`, `npm run test:cov`, whether
   the branch is rebased, whether the worktree is clean, and whether the diff
   touches an exported signature, a `contributes` setting key, a command id, or
   webview markup. **Anything you cannot establish is the unsafe value.**
2. Call `evaluateGate` from `src/company/gate.ts` with those facts. Do not
   second-guess it in either direction.
3. **Never auto-land regardless of the verdict:** a version bump, a publish,
   anything public, a reply to a real person, pricing, or any user-visible change.
4. If safe: merge to `main`, then write `.claude/company/landed/<id>.json` with
   `{id, cycle, role, title, sha, landed_at}` — the SHA is the merge commit, so
   Undo can revert it.
5. If gated: write `.claude/company/queue/<id>.json`. The `id` must equal the
   filename without `.json`, be lowercase letters/digits/dashes, and carry:
   `cycle`, `role`, `kind` (`code` · `spec` · `copy` · `mockup` · `reply` ·
   `release`), `title`, `why` (2–3 sentences including what it bets on),
   `artifact` (`{type, path}` or `{type, inline}`), `risk`, `on_approve` (what
   literally happens if approved), and `branch` / `checks` when there is code.
   An artifact path must sit inside the repo or the board refuses to read it.

## 5. Apply prior verdicts

Read `decisions.jsonl` for entries newer than the last cycle report:

- **approve** — do the thing `on_approve` names. Merging is allowed here: the
  human approved it. Never publish or post even when approved — hand the human
  the exact text and say it is theirs to send.
- **revise** — hand the item and the note back to its owning role this cycle.
  The note is the primary instruction.
- **reject** — do nothing, and treat it as binding in future cycles.

## 6. Report

Dispatch `company-chief-of-staff` to write `cycles/<timestamp>.md`. Include token
spend. Then print one line: how many items are waiting on the human.

## Never

Merge a user-visible change without an approval. Cut a version. Publish. Post.
Reply to a real person. Edit `package.json` / `package-lock.json` / `CHANGELOG.md`
outside an approved `release` item. Run at all while `PAUSED` exists.
```

- [ ] **Step 2: Write `.claude/commands/company.md`**

```markdown
---
description: Run one company cycle (or apply pending verdicts with "apply")
---

Run a company cycle using the `company-cycle` skill.

Mode: `$ARGUMENTS` — empty means `full`; `apply` means execute pending verdicts
only and skip the agenda, dispatch and integrate steps; `dry-run` means produce
proposals but never merge, publish, or execute a verdict.

Invoke the skill now and follow it exactly. Do not improvise the order of steps.
```

- [ ] **Step 3: Verify the skill and command are discovered**

```bash
ls .claude/skills/company-cycle/SKILL.md .claude/commands/company.md
grep -c "^name: company-cycle" .claude/skills/company-cycle/SKILL.md
```
Expected: both files listed, grep prints `1`.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/company-cycle/SKILL.md .claude/commands/company.md
git commit -m "feat(company): the cycle procedure and the /company command"
```

---

### Task 8: The scheduler and the board wiring

**Files:**
- Create: `scripts/company-cycle.sh`
- Create: `scripts/com.agentflow.company.plist`
- Modify: `src/company/boardMain.ts` (replace the `spawnCycle` stub)

**Interfaces:**
- Consumes: `/company` from Task 7; `CycleMode` and `RunnerResult` from Phase A's `server.ts`.
- Produces: a cron-able entry point and a working *Run a cycle* button.

- [ ] **Step 1: Write `scripts/company-cycle.sh`**

```bash
#!/usr/bin/env bash
# Runs one company cycle headlessly. Safe to call from launchd or the board.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPANY="$REPO/.claude/company"
MODE="${1:-full}"
LOCK="$COMPANY/.cycle.lock"

mkdir -p "$COMPANY/cycles"

if [ -e "$COMPANY/PAUSED" ]; then
  echo "$(date -u +%FT%TZ) paused — not running" >> "$COMPANY/cycles/runs.log"
  exit 0
fi

# One cycle at a time. mkdir is atomic, so two launches cannot both win.
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date -u +%FT%TZ) already running — skipped" >> "$COMPANY/cycles/runs.log"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

case "$MODE" in
  full|apply|dry-run) ;;
  *) echo "unknown mode: $MODE" >&2; exit 2 ;;
esac

STAMP="$(date -u +%Y-%m-%dT%H%M)"
LOG="$COMPANY/cycles/$STAMP-run.log"

echo "$(date -u +%FT%TZ) starting $MODE" >> "$COMPANY/cycles/runs.log"
cd "$REPO" || exit 1
claude -p "/company $MODE" >> "$LOG" 2>&1
STATUS=$?
echo "$(date -u +%FT%TZ) finished $MODE with status $STATUS" >> "$COMPANY/cycles/runs.log"
exit $STATUS
```

Then: `chmod +x scripts/company-cycle.sh`

- [ ] **Step 2: Verify the pause check and the lock**

```bash
touch .claude/company/PAUSED
./scripts/company-cycle.sh; echo "exit=$?"          # must be exit=0 and start nothing
tail -1 .claude/company/cycles/runs.log             # must say "paused"
rm .claude/company/PAUSED

mkdir -p .claude/company/.cycle.lock
./scripts/company-cycle.sh; echo "exit=$?"          # must be exit=0, "already running"
rmdir .claude/company/.cycle.lock

./scripts/company-cycle.sh bogus; echo "exit=$?"    # must be exit=2
```
Expected: exactly those three outcomes. No `claude` process starts in any of them.

- [ ] **Step 3: Write `scripts/com.agentflow.company.plist`**

Replace `/Users/YOU` with the real absolute repo path when installing.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentflow.company</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOU/dev/agent-flow/scripts/company-cycle.sh</string>
    <string>full</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key><string>/Users/YOU/dev/agent-flow/.claude/company/cycles/launchd.out</string>
  <key>StandardErrorPath</key><string>/Users/YOU/dev/agent-flow/.claude/company/cycles/launchd.err</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
```

Install with:

```bash
sed "s|/Users/YOU/dev/agent-flow|$(pwd)|g" scripts/com.agentflow.company.plist \
  > ~/Library/LaunchAgents/com.agentflow.company.plist
launchctl unload ~/Library/LaunchAgents/com.agentflow.company.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.agentflow.company.plist
launchctl list | grep agentflow
```

**Do not install it until the dry-run verification in Task 9 passes.**

- [ ] **Step 4: Replace the `spawnCycle` stub in `src/company/boardMain.ts`**

Remove the stub and put this in its place, keeping the existing `gitRevert` untouched:

```ts
function spawnCycle(mode: CycleMode): Promise<RunnerResult> {
  return new Promise((resolve) => {
    const script = `${repoRoot}/scripts/company-cycle.sh`;
    const child = spawn(script, [mode], { cwd: repoRoot, detached: true, stdio: "ignore" });
    child.on("error", (e) => resolve({ ok: false, detail: e.message }));
    child.on("spawn", () => {
      child.unref();
      resolve({ ok: true, detail: `Started a ${mode} cycle — watch .claude/company/cycles/` });
    });
  });
}
```

- [ ] **Step 5: Verify the button actually starts a cycle**

```bash
npm run build
npm run board
```
Click *Run a cycle*, then check `tail -2 .claude/company/cycles/runs.log` shows a
start line. Then set Pause on the board and click it again: the button is disabled
and the route returns 409.

- [ ] **Step 6: Run the full suite and commit**

```bash
npm run typecheck && npm test && npm run test:cov
chmod +x scripts/company-cycle.sh
git add scripts/company-cycle.sh scripts/com.agentflow.company.plist src/company/boardMain.ts
git commit -m "feat(company): the cycle script, the launchd job, and a working Run a cycle"
```

---

### Task 9: Dry-run the team

**Files:** none — this task verifies.

**Interfaces:**
- Consumes: everything above.
- Produces: a filled board, and the decision about whether to enable auto-land.

- [ ] **Step 1: Confirm the charter exists and the board is empty**

```bash
test -f .claude/company/CHARTER.md && echo "charter ok"
ls .claude/company/queue 2>/dev/null | wc -l    # expect 0
```

- [ ] **Step 2: Run one dry cycle**

```bash
./scripts/company-cycle.sh dry-run
tail -40 .claude/company/cycles/*-run.log | tail -40
```

- [ ] **Step 3: Verify the dry run changed nothing it should not have**

```bash
git -C . log --oneline main -1        # must be unchanged from before the run
ls .claude/company/landed | wc -l     # must be 0 — a dry run never lands
ls .claude/company/queue | wc -l      # must be > 0 — it should have proposed something
git status --short                    # main checkout must be clean
```
If `main` moved or anything landed, the dry-run gate is broken. Stop and fix it
before running a non-dry cycle.

- [ ] **Step 4: Read every proposal on the board**

`npm run board`, then for each card ask three questions: is the *why* real or
padding, does the artifact match the title, and does `on_approve` say something
concrete. Decide each one — this is also the first real content of
`decisions.jsonl`, which the next cycle learns from.

- [ ] **Step 5: Decide about auto-land, with evidence**

Run dry cycles for a week. Then read `decisions.jsonl`: if `code` cards from
`company-architect` and `company-feature-engineer` were approved unchanged,
enable non-dry cycles by installing the launchd job from Task 8 Step 3. If they
were revised or rejected, stay dry and fix the role prompts first.

- [ ] **Step 6: Commit whatever the review changed**

```bash
git add -A .claude/agents .claude/skills .claude/commands
git commit -m "fix(company): role and cycle corrections from the first dry runs"
```

---

## Done when

- A dry cycle fills the board and leaves `main` untouched.
- `PAUSED` stops a cycle from every entry point: launchd, the script, the board.
- `evaluateGate` is the only thing that decides auto-land, and its tests pass.
- `git status --short .claude/` never lists `company/`, `settings.json`, or `orchestrator/`.
- The seven role definitions are tracked; the charter is not.
