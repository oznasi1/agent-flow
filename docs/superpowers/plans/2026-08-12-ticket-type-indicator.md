# Ticket Type Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every task card in the Tasks list shows a 12px hued glyph naming its ticket type (story, epic, task, sub-task, bug, or anything else the project defines).

**Architecture:** Jira's `issuetype.name` rides along on the existing `Task` object as a raw string; a pure `ticketKind()` maps that name to one of six render kinds; a `TypeIcon` component draws the glyph in a `--k-*` token hue. Nothing else in the pipeline changes — no new message type, no new provider method, no capability flag.

**Tech Stack:** TypeScript, React (webview), vitest + @testing-library/react, esbuild.

**Spec:** `docs/superpowers/specs/2026-08-12-ticket-type-indicator-design.md`

## Global Constraints

- **Work in a git worktree, not the root checkout.** Parallel sessions switch the root checkout's branch and commit onto it. Create the worktree off `main` and use absolute paths in every shell command.
- **The webview cannot reach the filesystem.** No module under `src/webview/` may import `fs`, `os`, `path`, or `child_process`, even transitively. `tsc` and the test suite both pass when this is violated — only `npm run build` catches it.
- **A surface stylesheet carries no raw hex colour** and declares no token that `tokens.ts` owns. Colours come from a `--k-*`/`--c-*` token or a `--vscode-*` variable. Enforced by `test/webview/tokens.test.ts`.
- **Every `font-size` in `styles.ts` is a `var(--t-*)` token or one of the allowlisted legacy literals.** This change adds no `font-size` at all.
- **Existing tests pass unmodified**, with exactly three sanctioned edits, each named in the task that makes it: the `OWNED` array in `test/webview/tokens.test.ts` (Task 3), and two assertions in `test/unit/tasks/jira/client.test.ts` (Task 2). Any other existing test that goes red is a defect in the change, not a test to update.
- **Conventional commit messages** (`feat:`, `test:`, `refactor:`). Commit after every task.
- **Gates, run from the worktree root before declaring any task done:** `npm run typecheck`, `npm test`, and — for Tasks 4 and 5 — `npm run build`.

---

### Task 1: `Task.type` and the kind mapping

**Files:**
- Modify: `src/types.ts:18-33` (the `Task` interface)
- Modify: `src/webview/helpers.ts` (append at end of file)
- Test: `test/webview/helpers.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Task.type?: string` — the source's own type name, raw. Absent or `""` both mean "the source said nothing".
  - `export type TicketKind = "story" | "epic" | "task" | "subtask" | "bug" | "other"` from `src/webview/helpers.ts`
  - `export function ticketKind(typeName: string): TicketKind` from `src/webview/helpers.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/webview/helpers.test.ts`, and add `ticketKind` to the existing named import from `../../src/webview/helpers` at the top of the file:

```ts
describe("ticketKind", () => {
  it("maps each of the five type names Jira ships by default", () => {
    expect(ticketKind("Story")).toBe("story");
    expect(ticketKind("Epic")).toBe("epic");
    expect(ticketKind("Task")).toBe("task");
    expect(ticketKind("Bug")).toBe("bug");
    expect(ticketKind("Sub-task")).toBe("subtask");
  });

  // Jira Server writes "Sub-task", Jira Cloud has shipped "Subtask" — both are the
  // same kind, and a site that uses the other spelling must not fall to "other".
  it("accepts both sub-task spellings", () => {
    expect(ticketKind("Subtask")).toBe("subtask");
    expect(ticketKind("sub-task")).toBe("subtask");
  });

  it("ignores casing and surrounding whitespace", () => {
    expect(ticketKind("BUG")).toBe("bug");
    expect(ticketKind("  story  ")).toBe("story");
  });

  // A project can define any type it likes. Falling to "other" is what keeps the
  // card marked rather than blank.
  it("falls to other for a type it does not know", () => {
    expect(ticketKind("Spike")).toBe("other");
    expect(ticketKind("Incident")).toBe("other");
    expect(ticketKind("Improvement")).toBe("other");
  });

  it("falls to other when the source named no type at all", () => {
    expect(ticketKind("")).toBe("other");
    expect(ticketKind("   ")).toBe("other");
  });

  // Guards the lookup against a prototype key: `{}["constructor"]` is a function,
  // and a bare `MAP[key] || "other"` would return it.
  it("does not resolve an inherited object property to a kind", () => {
    expect(ticketKind("constructor")).toBe("other");
    expect(ticketKind("toString")).toBe("other");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/webview/helpers.test.ts -t ticketKind`
Expected: FAIL — `ticketKind is not a function` (or an import error).

- [ ] **Step 3: Add the field to `Task`**

In `src/types.ts`, inside the `Task` interface, after `estimateSeconds`:

```ts
  /** The source's own type name — "Story", "Sub-task", "Spike". Raw on purpose:
   * a project that renamed its types should have the tooltip say what it renamed
   * them to. `ticketKind()` (webview) is what turns this into a render kind.
   * Optional so nothing that already builds a Task has to change. */
  type?: string;
```

- [ ] **Step 4: Write the mapping**

Append to `src/webview/helpers.ts`:

```ts
/** What a ticket IS, as far as the card renders it. A different axis from status:
 * `statusCategory` says where the ticket is in the flow, this says what kind of
 * thing it is. "other" covers every type a project defined for itself. */
export type TicketKind = "story" | "epic" | "task" | "subtask" | "bug" | "other";

// A null-prototype map, not an object literal: a plain literal would resolve
// ticketKind("constructor") to Object's own constructor rather than to "other".
const TICKET_KINDS: Record<string, TicketKind> = Object.assign(Object.create(null), {
  story: "story",
  epic: "epic",
  task: "task",
  bug: "bug",
  "sub-task": "subtask",
  subtask: "subtask",
});

/** Map a source's type name onto a render kind. Unknown names — and the empty
 * string a source with no type produces — are "other", which still draws a
 * marker; the raw name is what the tooltip shows. */
export function ticketKind(typeName: string): TicketKind {
  return TICKET_KINDS[typeName.trim().toLowerCase()] ?? "other";
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/webview/helpers.test.ts`
Expected: PASS, including the pre-existing describes in that file.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/webview/helpers.ts test/webview/helpers.test.ts
git commit -m "feat(tasks): carry a ticket's own type name on Task"
```

---

### Task 2: Fetch `issuetype` from Jira

**Files:**
- Modify: `src/tasks/jira/client.ts:39` (`LIST_FIELDS`) and `client.ts` `normalize()` (~line 349-371)
- Test: `test/unit/tasks/jira/client.test.ts`

**Interfaces:**
- Consumes: `Task.type?: string` (Task 1).
- Produces: a `Task` whose `type` is `issue.fields.issuetype.name`, or `""` when the field is absent.

**Sanctioned edits to existing tests:** the `rawIssue` fixture (~line 19) gains an `issuetype`, and the `toEqual` in `"maps a fully-populated issue"` (~line 205) gains a `type` key. `toEqual` is exact — adding a field to `normalize()` without updating it is a guaranteed red, and that is the assertion working as intended.

- [ ] **Step 1: Write the failing tests**

In `test/unit/tasks/jira/client.test.ts`, add `issuetype: { name: "Story" }` to the `rawIssue` fixture's `fields`:

```ts
const rawIssue = (over: Record<string, any> = {}) => ({
  key: "ASM-1",
  fields: {
    summary: "Do the thing",
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    priority: { name: "High" },
    assignee: { displayName: "Jane Doe" },
    labels: ["backend"],
    components: [{ name: "account-service" }],
    updated: "2026-07-01T00:00:00.000Z",
    timeoriginalestimate: 3600,
    issuetype: { name: "Story" },
    ...over,
  },
});
```

Add `type: "Story",` to the object asserted in `"maps a fully-populated issue"` (put it after `estimateSeconds: 3600,`).

Add `type: "",` to the `toMatchObject` in `"applies null-safe defaults for a sparse issue"`.

Then add two new cases inside the `describe("normalize (via fetchTasks)")` block:

```ts
  it("carries a project's own type name through verbatim", async () => {
    const t = await one(rawIssue({ issuetype: { name: "Spike" } }));
    expect(t.type).toBe("Spike");
  });

  it("carries a sub-task through as the source spells it", async () => {
    const t = await one(rawIssue({ issuetype: { name: "Sub-task" } }));
    expect(t.type).toBe("Sub-task");
  });
```

And one inside `describe("fetchTasks")`:

```ts
  it("asks Jira for the issue type alongside the other list fields", async () => {
    const fetchMock = installFetch([jsonResponse(FIELD_LIST), jsonResponse({ issues: [rawIssue()] })]);
    await client().fetchTasks("mine");
    expect(bodyOf(fetchMock, 1).fields).toContain("issuetype");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/tasks/jira/client.test.ts`
Expected: FAIL — `"asks Jira for the issue type..."` fails on the missing field, the two new normalize cases report `undefined`, and `"maps a fully-populated issue"` fails on the missing `type` key.

- [ ] **Step 3: Request the field**

In `src/tasks/jira/client.ts`, add `"issuetype"` to `LIST_FIELDS`:

```ts
const LIST_FIELDS = ["summary", "status", "priority", "assignee", "labels", "components", "updated", "timeoriginalestimate", "issuetype"];
```

Leave `DETAIL_FIELDS` alone — the detail body does not render this.

- [ ] **Step 4: Map it**

In `normalize()`, after the `estimateSeconds` line:

```ts
      type: f.issuetype?.name ?? "",
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/tasks/jira/client.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. If any other test asserts an exact `Task` shape, that is a fourth sanctioned edit — report it rather than editing quietly.

- [ ] **Step 7: Commit**

```bash
git add src/tasks/jira/client.ts test/unit/tasks/jira/client.test.ts
git commit -m "feat(jira): read a ticket's issue type in the list query"
```

---

### Task 3: Kind hue tokens

**Files:**
- Modify: `src/webview/tokens.ts` (the `--k-*` block inside `TOKENS_CSS`'s `:root`)
- Test: `test/webview/tokens.test.ts:8-15` (the `OWNED` array)

**Interfaces:**
- Consumes: nothing.
- Produces: `--k-story`, `--k-epic`, `--k-task`, `--k-subtask`, `--k-bug`, `--k-other`, usable from any surface sheet.

**Sanctioned edit to an existing test:** `OWNED` in `tokens.test.ts` gains the six names. Without it, two of that file's own checks fail — `"declares every token it owns"` stays green but `"sidebar: only uses custom properties that are declared somewhere"` (Task 4) would report the new tokens as orphans.

- [ ] **Step 1: Write the failing test**

In `test/webview/tokens.test.ts`, extend `OWNED`:

```ts
const OWNED = [
  "--t-micro", "--t-data", "--t-body", "--t-title",
  "--r-card", "--r-ctl", "--r-chip",
  "--c-progress", "--c-attn", "--c-review", "--c-done", "--c-idle", "--c-danger",
  "--k-skill", "--k-command", "--k-agent", "--k-hook", "--k-plugin",
  "--k-story", "--k-epic", "--k-task", "--k-subtask", "--k-bug", "--k-other",
  "--hair", "--edge", "--mono", "--dim",
  "--brand", "--brand-ink",
];
```

Add a describe of its own to the same file:

```ts
describe("ticket kind hues", () => {
  // Red on a card means a real failure. A bug ticket is an ordinary, healthy
  // ticket, so it gets a muted red derived from --c-danger rather than the alarm
  // colour itself — and never --c-attn, which the Highest chip owns alone.
  it("mutes the bug hue away from the alarm red and the attention amber", () => {
    const bug = TOKENS_CSS.match(/--k-bug:\s*([^;]+);/);
    expect(bug).not.toBeNull();
    expect(bug![1]).toContain("color-mix");
    expect(bug![1]).toContain("--c-danger");
    expect(bug![1]).not.toContain("--c-attn");
    expect(bug![1].trim()).not.toBe("var(--c-danger)");
  });

  // Task and sub-task share a hue, as they do in Jira; their glyphs differ. Every
  // other kind is distinct, so a scan down the list separates them by colour.
  it("gives each kind a hue, sharing exactly one between task and sub-task", () => {
    const hue = (name: string) => TOKENS_CSS.match(new RegExp(`--k-${name}:\\s*([^;]+);`))![1].trim();
    const kinds = ["story", "epic", "task", "subtask", "bug", "other"];
    for (const k of kinds) expect(hue(k), k).toBeTruthy();
    expect(hue("task")).toBe(hue("subtask"));
    const distinct = new Set(kinds.map(hue));
    expect(distinct.size).toBe(5);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/webview/tokens.test.ts`
Expected: FAIL — `"declares every token it owns"` lists the six missing names, and both new cases throw on a null match.

- [ ] **Step 3: Declare the tokens**

In `src/webview/tokens.ts`, immediately after the existing `--k-plugin` line and before `--hair`:

```
    /* Ticket taxonomy — the same "what KIND of thing is this" axis as the
       Marketplace block above, for the Tasks list's type marker. Task and
       sub-task share Jira's blue; the glyphs are what separate them.
       --k-bug is a muted red, NOT --c-danger: red on a card means a real
       failure, and a bug ticket is not one. Not --c-attn either — amber on a
       card means exactly one thing, the Highest chip. */
    --k-story:   var(--vscode-charts-green, #4ac26b);
    --k-epic:    var(--vscode-charts-purple, #b083f0);
    --k-task:    var(--vscode-charts-blue, #4aa3df);
    --k-subtask: var(--vscode-charts-blue, #4aa3df);
    --k-bug:     color-mix(in srgb, var(--c-danger) 72%, var(--vscode-foreground));
    --k-other:   var(--vscode-descriptionForeground);
```

`--c-danger` is declared a few lines above in the same `:root`, so the `color-mix` resolves. `--k-other` takes `--vscode-descriptionForeground` directly rather than `var(--dim)`, which is declared below it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/webview/tokens.test.ts`
Expected: PASS. Note the `"no raw hex colour"` scan covers surface sheets only — `tokens.ts` owns its fallback hexes and is deliberately not scanned.

- [ ] **Step 5: Commit**

```bash
git add src/webview/tokens.ts test/webview/tokens.test.ts
git commit -m "feat(webview): add ticket-kind hue tokens"
```

---

### Task 4: The `TypeIcon` glyph component

**Files:**
- Modify: `src/webview/icons.tsx`
- Modify: `src/webview/styles.ts` (add rules next to `.key`, around line 113)
- Create: `test/webview/TypeIcon.test.tsx`

**Interfaces:**
- Consumes: `TicketKind` from `src/webview/helpers.ts` (Task 1), the `--k-*` tokens (Task 3).
- Produces: `export const TypeIcon = ({ kind, label }: { kind: TicketKind; label: string }): JSX.Element` from `src/webview/icons.tsx`. Renders `<span class="ty ty-<kind>" role="img" aria-label="Type: <label>" title="Type: <label>">` wrapping a 12×12 `<svg>`.

- [ ] **Step 1: Write the failing test**

Create `test/webview/TypeIcon.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import * as React from "react";
import { render, screen } from "@testing-library/react";
import { TypeIcon } from "../../src/webview/icons";
import type { TicketKind } from "../../src/webview/helpers";

const KINDS: TicketKind[] = ["story", "epic", "task", "subtask", "bug", "other"];

describe("TypeIcon", () => {
  // The glyph is the only carrier of the type on a card, so it needs an accessible
  // name — an icon with none is invisible to a screen reader.
  it("names itself with the source's own type name", () => {
    render(<TypeIcon kind="bug" label="Bug" />);
    const icon = screen.getByRole("img", { name: "Type: Bug" });
    expect(icon).toHaveClass("ty", "ty-bug");
    expect(icon).toHaveAttribute("title", "Type: Bug");
  });

  it("shows the raw name even when the kind fell to other", () => {
    render(<TypeIcon kind="other" label="Spike" />);
    const icon = screen.getByRole("img", { name: "Type: Spike" });
    expect(icon).toHaveClass("ty-other");
  });

  it("renders a 12px glyph for every kind", () => {
    for (const kind of KINDS) {
      const { container, unmount } = render(<TypeIcon kind={kind} label={kind} />);
      const svg = container.querySelector("svg")!;
      expect(svg, kind).not.toBeNull();
      expect(svg.getAttribute("width"), kind).toBe("12");
      expect(svg.getAttribute("viewBox"), kind).toBe("0 0 12 12");
      unmount();
    }
  });

  // Six kinds with the same drawing would render as one undifferentiated dot.
  it("draws a different glyph for each kind", () => {
    const drawings = KINDS.map((kind) => {
      const { container, unmount } = render(<TypeIcon kind={kind} label={kind} />);
      const markup = container.querySelector("svg")!.innerHTML;
      unmount();
      return markup;
    });
    expect(new Set(drawings).size).toBe(KINDS.length);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/webview/TypeIcon.test.tsx`
Expected: FAIL — `TypeIcon` is not exported from `icons.tsx`.

- [ ] **Step 3: Write the component**

Append to `src/webview/icons.tsx` (and add `import type { TicketKind } from "./helpers";` at the top — `helpers.ts` imports only types from `../types`, so this creates no cycle and pulls nothing platform-bound into the webview bundle):

```tsx
// Ticket type glyphs. 12×12, currentColor, hue supplied by the .ty-<kind> rule in
// styles.ts. Shapes follow Jira's own vocabulary closely enough to be recognised
// without borrowing its icon URLs, which would be a network fetch per card and a
// widened webview CSP.
const TYPE_GLYPHS: Record<TicketKind, JSX.Element> = {
  story: <path fill="currentColor" d="M3 1.5h6a.5.5 0 0 1 .5.5v8.2a.3.3 0 0 1-.47.25L6 8.3l-3.03 2.15A.3.3 0 0 1 2.5 10.2V2a.5.5 0 0 1 .5-.5z" />,
  epic: <path fill="currentColor" d="M7.2 1 3 6.6h2.5L4.6 11 9 5.2H6.4L7.2 1z" />,
  task: (
    <>
      <rect fill="currentColor" x="1.5" y="1.5" width="9" height="9" rx="2" />
      {/* The check is cut with the editor ground rather than a second hue. The card
          sits 4% above that ground, a difference this 1.3px stroke does not show. */}
      <path
        d="M4 6.1l1.5 1.5L8.2 4.7"
        fill="none"
        stroke="var(--vscode-editor-background)"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  subtask: (
    <>
      <path d="M2.6 1.8v5.1a1.5 1.5 0 0 0 1.5 1.5h3" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect fill="currentColor" x="7.2" y="6.3" width="3.4" height="3.4" rx=".8" />
    </>
  ),
  // One path, two subpaths, evenodd: the centre is a real hole, so the glyph needs
  // no background colour to knock it out.
  bug: (
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M6 1.7a4.3 4.3 0 1 1 0 8.6 4.3 4.3 0 0 1 0-8.6zm0 2.6a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4z"
    />
  ),
  other: <rect x="1.9" y="1.9" width="8.2" height="8.2" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.2" />,
};

/** The ticket's kind, as a hued glyph. `label` is the source's raw type name — it
 * is what the accessible name and the tooltip say, so a custom type reads as
 * itself rather than as "other". */
export const TypeIcon = ({ kind, label }: { kind: TicketKind; label: string }): JSX.Element => (
  <span className={`ty ty-${kind}`} role="img" aria-label={`Type: ${label}`} title={`Type: ${label}`}>
    <svg width="12" height="12" viewBox="0 0 12 12">{TYPE_GLYPHS[kind]}</svg>
  </span>
);
```

- [ ] **Step 4: Add the styles**

In `src/webview/styles.ts`, immediately after the `.key:hover` rule:

```
  /* The ticket's kind, left of its key. A kind axis, never a status one: the hue
     says what this ticket IS, the rail already says where it is in the flow.
     flex: none because .card-top wraps — the marker must never be squeezed. */
  .ty { width: 12px; height: 12px; flex: none; display: inline-block; }
  .ty svg { display: block; }
  .ty-story   { color: var(--k-story); }
  .ty-epic    { color: var(--k-epic); }
  .ty-task    { color: var(--k-task); }
  .ty-subtask { color: var(--k-subtask); }
  .ty-bug     { color: var(--k-bug); }
  .ty-other   { color: var(--k-other); }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/webview/TypeIcon.test.tsx test/webview/tokens.test.ts`
Expected: PASS. The tokens file's orphan check is what proves the six `--k-*` uses resolve.

- [ ] **Step 6: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0. The build is the gate that would catch `icons.tsx` pulling in anything platform-bound.

- [ ] **Step 7: Commit**

```bash
git add src/webview/icons.tsx src/webview/styles.ts test/webview/TypeIcon.test.tsx
git commit -m "feat(webview): add the ticket type glyph"
```

---

### Task 5: Show the marker on the card

**Files:**
- Modify: `src/webview/App.tsx:826-832` (the `card-top` row) and its import lines
- Test: `test/webview/App.test.tsx`

**Interfaces:**
- Consumes: `ticketKind` (Task 1), `Task.type` (Tasks 1-2), `TypeIcon` (Task 4).
- Produces: the finished feature. Nothing depends on it.

- [ ] **Step 1: Write the failing tests**

In `test/webview/App.test.tsx`, add these inside the describe that defines `withTask` (the one containing `"takes a task"`, ~line 673):

```tsx
  it("marks a card with its ticket type", () => {
    withTask(mkTask({ key: "ASM-1", type: "Bug" }));
    expect(screen.getByRole("img", { name: "Type: Bug" })).toHaveClass("ty-bug");
  });

  // A project's own type still gets a marker, named for what the project calls it.
  it("marks a type it does not recognise, under the source's own name", () => {
    withTask(mkTask({ key: "ASM-1", type: "Spike" }));
    expect(screen.getByRole("img", { name: "Type: Spike" })).toHaveClass("ty-other");
  });

  it("still marks a task whose source named no type", () => {
    withTask(mkTask({ key: "ASM-1" }));
    expect(screen.getByRole("img", { name: "Type: unknown" })).toHaveClass("ty-other");
  });

  // Left of the key, and inside the top row — not floated into the action cluster.
  it("puts the marker at the head of the card's top row, before the key", () => {
    withTask(mkTask({ key: "ASM-1", type: "Story" }));
    const top = screen.getByText("ASM-1").closest(".card-top")!;
    const marker = within(top as HTMLElement).getByRole("img", { name: "Type: Story" });
    expect(marker.compareDocumentPosition(screen.getByText("ASM-1")))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/webview/App.test.tsx -t "type"`
Expected: FAIL — no element with role `img` is found on the card.

- [ ] **Step 3: Render it**

In `src/webview/App.tsx`, add `TypeIcon` to the existing import from `./icons` and `ticketKind` to the existing import from `./helpers`, then insert one line into `card-top`, between the chevron and the `.key` anchor:

```tsx
          <span className={`chev${open ? " open" : ""}`}>›</span>
          <TypeIcon kind={ticketKind(task.type ?? "")} label={task.type || "unknown"} />
          <a
            className="key"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/webview/App.test.tsx`
Expected: PASS, including every pre-existing case in the file.

- [ ] **Step 5: Full gates**

Run: `npm run typecheck && npm test && npm run build`
Expected: all three exit 0, whole suite green.

- [ ] **Step 6: Commit**

```bash
git add src/webview/App.tsx test/webview/App.test.tsx
git commit -m "feat(tasks): show a ticket's type on its card"
```

---

### Task 6: Verify it in a real editor

**Files:** none — this task changes nothing. Its deliverable is evidence.

**Interfaces:**
- Consumes: everything above.
- Produces: a coverage number and a screenshot for the reviewer.

- [ ] **Step 1: Check coverage on the changed files**

Run: `npm run test:cov`
Expected: ≥95% on `src/webview/helpers.ts`, `src/webview/icons.tsx`, `src/webview/App.tsx` and `src/tasks/jira/client.ts` for the lines this branch touched. If a new line is uncovered, add the case that covers it — do not lower the bar.

- [ ] **Step 2: Launch the dev host**

Run (VS Code's own CLI — the Cursor CLI silently drops the flag):

```bash
code --extensionDevelopmentPath=<absolute path to the worktree> --new-window
```

Open the Agent Flow sidebar, sign in to Jira, and look at the Tasks list.

- [ ] **Step 3: Confirm the four things a test cannot see**

- Each type reads as itself at 12px on a real theme.
- The bug hue is visibly quieter than a "Highest" chip's amber sitting on the same row.
- Nothing wraps that did not wrap before, at the narrowest sidebar width you can drag to.
- Switch to a light theme and check the glyphs still read — the hues are `--vscode-charts-*`, which the theme redefines.

- [ ] **Step 4: Report**

Post the coverage figures and a screenshot of the list in both themes. If the light theme reads badly, that is a token fix in `tokens.ts`, not a component change — raise it rather than patching the component.
