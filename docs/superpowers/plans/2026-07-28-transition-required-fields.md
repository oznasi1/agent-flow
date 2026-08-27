# Transition Required Fields & Readable Jira Errors — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let **Change Status** collect the fields a Jira workflow requires (Resolution and friends), and render every Jira failure as a readable sentence in a sticky toast that leaves the task list intact.

**Architecture:** Two new `vscode`-free modules carry the branchy logic — `src/jira/errors.ts` parses Jira's error envelope, `src/jira/transitionFields.ts` classifies transition-screen fields into prompts and maps answers back to Jira's wire shape. `JiraClient` throws the typed error and learns to send fields; `TasksViewProvider` orchestrates prompt → POST → one recovery retry; the webview gains a toast action button and stops auto-dismissing errors.

**Tech Stack:** TypeScript, VS Code extension API, React (webview), Vitest + @testing-library/react, esbuild.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-28-transition-required-fields-design.md` — read it before starting.
- **No `vscode` import** in `src/jira/errors.ts` or `src/jira/transitionFields.ts`. They must be unit-testable as plain modules.
- **Exactly one** recovery re-POST per `changeStatus` call. A second failure is reported, never retried.
- **Esc at any field prompt cancels the whole transition** — nothing is written, no toast.
- Required fields are prompted **even when `hasDefaultValue` is true**.
- Only **required** fields are prompted upfront; optional screen fields are never prompted.
- Unrenderable field types are **skipped and logged**, and the write is attempted anyway.
- 401/403 keep throwing `JiraAuthError` and keep re-gating to sign-in — do not route them through the new error type.
- Test commands: `npx vitest run <path>` for one file, `npm test` for all, `npm run typecheck` before each commit.
- Match surrounding style: two-space indent, double quotes, `/** … */` doc comments on exported members explaining *why*, not *what*.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/jira/errors.ts` **(new)** | `JiraApiError`, `parseJiraError`, `describeJiraError`. Envelope → sentences. |
| `src/jira/transitionFields.ts` **(new)** | Field metadata → prompts, answers → Jira JSON, rejection → field ids. |
| `src/jira/client.ts` | Throws `JiraApiError`; `getTransitions` expands fields; `transition` sends fields; `listResolutions`. |
| `src/tasksView.ts` | Prompt collection, recovery pass, write-failure reporting, gate/toast routing. |
| `src/types.ts` | `toast` message gains optional `action`. |
| `src/webview/App.tsx` | Sticky error toasts + action button. |
| `src/webview/styles.ts` | `.toast-action`, `.toast-dismiss` styling. |
| `test/unit/jira/errors.test.ts` **(new)** | Every body shape and status. |
| `test/unit/jira/transitionFields.test.ts` **(new)** | Every classification branch and value mapping. |
| `test/unit/jira/client.test.ts` | Expand param, fields payload, typed throw. |
| `test/unit/tasksView.test.ts` | Prompt sequence, recovery, gate routing. |
| `test/webview/App.test.tsx` | Sticky errors, action button. |

---

### Task 1: Jira error parsing

**Files:**
- Create: `src/jira/errors.ts`
- Test: `test/unit/jira/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class JiraApiError extends Error` with `readonly status: number`, `readonly fieldErrors: Record<string, string>`, `readonly messages: string[]`.
  - `parseJiraError(status: number, body: string): JiraApiError`
  - `describeJiraError(e: JiraApiError, fieldNames?: Record<string, string>): string`

- [ ] **Step 1: Write the failing test**

Create `test/unit/jira/errors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { JiraApiError, parseJiraError, describeJiraError } from "../../../src/jira/errors";

const envelope = (messages: string[], errors: Record<string, string> = {}) =>
  JSON.stringify({ errorMessages: messages, errors });

describe("parseJiraError", () => {
  it("reads a validator message out of errorMessages", () => {
    const e = parseJiraError(400, envelope(["Ticket cannot be closed unless Resolution will be provided"]));
    expect(e).toBeInstanceOf(JiraApiError);
    expect(e.status).toBe(400);
    expect(e.messages).toEqual(["Ticket cannot be closed unless Resolution will be provided"]);
    expect(e.fieldErrors).toEqual({});
    expect(e.message).toBe("Ticket cannot be closed unless Resolution will be provided.");
  });

  it("keeps existing punctuation instead of doubling it", () => {
    expect(parseJiraError(400, envelope(["Field is required."])).message).toBe("Field is required.");
    expect(parseJiraError(400, envelope(["Really?"])).message).toBe("Really?");
  });

  it("renders field errors keyed by field id when no name map is given", () => {
    const e = parseJiraError(400, envelope([], { resolution: "Field 'resolution' is required" }));
    expect(e.fieldErrors).toEqual({ resolution: "Field 'resolution' is required" });
    expect(e.message).toBe("resolution: Field 'resolution' is required.");
  });

  it("joins messages and field errors into one string", () => {
    const e = parseJiraError(400, envelope(["Transition failed"], { customfield_10042: "Required" }));
    expect(e.message).toBe("Transition failed. customfield_10042: Required.");
  });

  it("ignores blank and non-string entries", () => {
    const body = JSON.stringify({ errorMessages: ["", "  ", 7, "Real problem"], errors: { a: "", b: 3, c: "Nope" } });
    const e = parseJiraError(400, body);
    expect(e.messages).toEqual(["Real problem"]);
    expect(e.fieldErrors).toEqual({ c: "Nope" });
  });

  it("falls back to a status sentence for an empty envelope", () => {
    expect(parseJiraError(400, envelope([])).message).toBe("Jira rejected the request (400).");
  });

  it("falls back to a status sentence for non-JSON, HTML and empty bodies", () => {
    expect(parseJiraError(500, "server boom").message).toBe("Jira is having trouble (500) — try again shortly.");
    expect(parseJiraError(502, "<html><body>Bad Gateway</body></html>").message)
      .toBe("Jira is having trouble (502) — try again shortly.");
    expect(parseJiraError(404, "").message).toBe("Jira couldn't find that issue (404).");
    expect(parseJiraError(429, "").message).toBe("Jira is rate-limiting requests (429) — try again shortly.");
    expect(parseJiraError(302, "").message).toBe("Jira returned an error (302).");
  });

  it("never leaks the raw body into the message", () => {
    const e = parseJiraError(400, "<html>stack trace with secrets</html>");
    expect(e.message).not.toContain("secrets");
  });
});

describe("describeJiraError", () => {
  it("maps field ids to display names", () => {
    const e = parseJiraError(400, envelope([], { customfield_10042: "Field is required" }));
    expect(describeJiraError(e, { customfield_10042: "Root Cause" })).toBe("Root Cause: Field is required.");
  });

  it("keeps the id when the name map has no entry", () => {
    const e = parseJiraError(400, envelope([], { customfield_10042: "Field is required" }));
    expect(describeJiraError(e, { other: "Other" })).toBe("customfield_10042: Field is required.");
  });

  it("falls back to the status sentence when there is nothing to describe", () => {
    expect(describeJiraError(parseJiraError(503, ""))).toBe("Jira is having trouble (503) — try again shortly.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/jira/errors.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/jira/errors"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/jira/errors.ts`:

```ts
/** A non-2xx response from Jira. Keeps the error envelope intact so callers can
 *  react to the failing fields structurally instead of matching on prose — the
 *  transition flow uses `fieldErrors` to decide what to re-prompt for. */
export class JiraApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fieldErrors: Record<string, string>,
    readonly messages: string[],
  ) {
    super(message);
    this.name = "JiraApiError";
  }
}

/** Read Jira's standard error envelope. Anything else — HTML error pages, proxy
 *  text, empty bodies — becomes a status sentence rather than a raw dump, which
 *  is what used to reach the panel verbatim. */
export function parseJiraError(status: number, body: string): JiraApiError {
  const messages: string[] = [];
  const fieldErrors: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const envelope = parsed as { errorMessages?: unknown; errors?: unknown };
      if (Array.isArray(envelope.errorMessages)) {
        for (const m of envelope.errorMessages) {
          if (typeof m === "string" && m.trim()) messages.push(m.trim());
        }
      }
      if (envelope.errors && typeof envelope.errors === "object") {
        for (const [id, msg] of Object.entries(envelope.errors as Record<string, unknown>)) {
          if (typeof msg === "string" && msg.trim()) fieldErrors[id] = msg.trim();
        }
      }
    }
  } catch {
    /* not JSON — the status sentence below is the whole message */
  }
  return new JiraApiError(status, render(status, messages, fieldErrors), fieldErrors, messages);
}

/** Re-render an error with human field names (the transition flow knows them
 *  from the transition metadata; the client that threw does not). */
export function describeJiraError(e: JiraApiError, fieldNames: Record<string, string> = {}): string {
  return render(e.status, e.messages, e.fieldErrors, fieldNames);
}

function render(
  status: number,
  messages: string[],
  fieldErrors: Record<string, string>,
  fieldNames: Record<string, string> = {},
): string {
  const parts = messages.map(sentence);
  for (const [id, msg] of Object.entries(fieldErrors)) {
    parts.push(`${fieldNames[id] ?? id}: ${sentence(msg)}`);
  }
  return parts.length ? parts.join(" ") : statusSentence(status);
}

/** Fragments are joined into one line, so each needs to end like a sentence. */
function sentence(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function statusSentence(status: number): string {
  if (status === 404) return "Jira couldn't find that issue (404).";
  if (status === 429) return "Jira is rate-limiting requests (429) — try again shortly.";
  if (status >= 500) return `Jira is having trouble (${status}) — try again shortly.`;
  if (status >= 400) return `Jira rejected the request (${status}).`;
  return `Jira returned an error (${status}).`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/jira/errors.test.ts && npm run typecheck`
Expected: PASS, 11 tests. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/jira/errors.ts test/unit/jira/errors.test.ts
git commit -m "feat(jira): parse Jira error envelopes into readable sentences"
```

---

### Task 2: Transition field classification

**Files:**
- Create: `src/jira/transitionFields.ts`
- Test: `test/unit/jira/transitionFields.test.ts`

**Interfaces:**
- Consumes: nothing at runtime. Types only mirror Jira's payload.
- Produces:
  - `interface TransitionFieldMeta { required?: boolean; name?: string; hasDefaultValue?: boolean; schema?: { type?: string; system?: string; custom?: string; items?: string }; allowedValues?: { id?: string; name?: string; value?: string }[] }`
  - `type FieldPrompt` — a discriminated union on `kind`: `"pick" | "multipick"` carry `choices: { id?: string; name: string }[]`; `"text" | "number" | "date" | "datetime" | "labels"` carry only `id` and `name`.
  - `promptableFields(fields: Record<string, TransitionFieldMeta>, opts?: { only?: string[] }): { prompts: FieldPrompt[]; skipped: string[] }`
  - `toJiraValue(prompt: FieldPrompt, input: string | string[]): unknown`
  - `validateFieldInput(prompt: FieldPrompt, raw: string): string | undefined`
  - `missingFieldIds(fields: Record<string, TransitionFieldMeta>, err: { fieldErrors: Record<string, string>; messages: string[] }): string[]`
  - `mentionsResolution(err: { fieldErrors: Record<string, string>; messages: string[] }): boolean`
  - `fieldDisplayNames(fields: Record<string, TransitionFieldMeta>): Record<string, string>`

- [ ] **Step 1: Write the failing test**

Create `test/unit/jira/transitionFields.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  promptableFields,
  toJiraValue,
  validateFieldInput,
  missingFieldIds,
  mentionsResolution,
  fieldDisplayNames,
  type FieldPrompt,
  type TransitionFieldMeta,
} from "../../../src/jira/transitionFields";

const RESOLUTION: TransitionFieldMeta = {
  required: true,
  name: "Resolution",
  hasDefaultValue: false,
  schema: { type: "resolution", system: "resolution" },
  allowedValues: [
    { id: "10000", name: "Done" },
    { id: "10001", name: "Won't Do" },
  ],
};

describe("promptableFields — classification", () => {
  it("turns a single-value allowedValues field into a pick", () => {
    const { prompts, skipped } = promptableFields({ resolution: RESOLUTION });
    expect(skipped).toEqual([]);
    expect(prompts).toEqual([
      {
        kind: "pick",
        id: "resolution",
        name: "Resolution",
        choices: [{ id: "10000", name: "Done" }, { id: "10001", name: "Won't Do" }],
      },
    ]);
  });

  it("turns an array of allowedValues into a multipick", () => {
    const { prompts } = promptableFields({
      fixVersions: {
        required: true,
        name: "Fix Version/s",
        schema: { type: "array", items: "version", system: "fixVersions" },
        allowedValues: [{ id: "1", name: "0.1.36" }],
      },
    });
    expect(prompts[0]).toMatchObject({ kind: "multipick", id: "fixVersions", name: "Fix Version/s" });
  });

  it("reads allowedValues entries that use `value` instead of `name`", () => {
    const { prompts } = promptableFields({
      customfield_1: {
        required: true,
        name: "Severity",
        schema: { type: "option", custom: "…:select" },
        allowedValues: [{ id: "7", value: "High" }],
      },
    });
    expect(prompts[0]).toMatchObject({ choices: [{ id: "7", name: "High" }] });
  });

  it("classifies scalars by schema type", () => {
    const { prompts } = promptableFields({
      a: { required: true, name: "Notes", schema: { type: "string" } },
      b: { required: true, name: "Story Points", schema: { type: "number" } },
      c: { required: true, name: "Due Date", schema: { type: "date" } },
      d: { required: true, name: "Started", schema: { type: "datetime" } },
      e: { required: true, name: "Labels", schema: { type: "array", items: "string" } },
    });
    expect(prompts.map((p) => p.kind)).toEqual(["text", "number", "date", "datetime", "labels"]);
  });

  it("skips rich-text fields rather than sending a plain string API v3 rejects", () => {
    const { prompts, skipped } = promptableFields({
      description: { required: true, name: "Description", schema: { type: "string", system: "description" } },
      environment: { required: true, name: "Environment", schema: { type: "string", system: "environment" } },
      customfield_9: { required: true, name: "Analysis", schema: { type: "string", custom: "…:textarea" } },
    });
    expect(prompts).toEqual([]);
    expect(skipped).toEqual(["Description", "Environment", "Analysis"]);
  });

  it("skips field types it cannot render", () => {
    const { prompts, skipped } = promptableFields({
      assignee: { required: true, name: "Assignee", schema: { type: "user", system: "assignee" } },
      customfield_5: { required: true, name: "Root Cause", schema: { type: "option-with-child" } },
    });
    expect(prompts).toEqual([]);
    expect(skipped).toEqual(["Assignee", "Root Cause"]);
  });

  it("ignores optional fields entirely — they are not prompts and not skips", () => {
    const { prompts, skipped } = promptableFields({
      comment: { required: false, name: "Comment", schema: { type: "string" } },
      resolution: RESOLUTION,
    });
    expect(prompts).toHaveLength(1);
    expect(skipped).toEqual([]);
  });

  it("still prompts a required field that has a default", () => {
    const { prompts } = promptableFields({ resolution: { ...RESOLUTION, hasDefaultValue: true } });
    expect(prompts).toHaveLength(1);
  });

  it("falls back to the field id when Jira sends no display name", () => {
    const { prompts } = promptableFields({ customfield_3: { required: true, schema: { type: "string" } } });
    expect(prompts[0].name).toBe("customfield_3");
  });

  it("with `only`, considers exactly those ids regardless of required", () => {
    const { prompts } = promptableFields(
      { resolution: { ...RESOLUTION, required: false }, other: { required: true, name: "O", schema: { type: "string" } } },
      { only: ["resolution"] },
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0].id).toBe("resolution");
  });

  it("with `only`, ignores ids that are not in the metadata", () => {
    expect(promptableFields({ resolution: RESOLUTION }, { only: ["nope"] }).prompts).toEqual([]);
  });
});

describe("toJiraValue", () => {
  const pick = promptableFields({ resolution: RESOLUTION }).prompts[0];

  it("sends a chosen value as an id reference", () => {
    expect(toJiraValue(pick, "Won't Do")).toEqual({ id: "10001" });
  });

  it("falls back to { value } when the choice has no id", () => {
    const p: FieldPrompt = { kind: "pick", id: "f", name: "F", choices: [{ name: "Only" }] };
    expect(toJiraValue(p, "Only")).toEqual({ value: "Only" });
  });

  it("sends a multipick as an array of references", () => {
    const p: FieldPrompt = { kind: "multipick", id: "f", name: "F", choices: [{ id: "1", name: "A" }, { id: "2", name: "B" }] };
    expect(toJiraValue(p, ["A", "B"])).toEqual([{ id: "1" }, { id: "2" }]);
  });

  it("splits labels on commas and drops blanks", () => {
    const p: FieldPrompt = { kind: "labels", id: "labels", name: "Labels" };
    expect(toJiraValue(p, "a, b ,, c")).toEqual(["a", "b", "c"]);
  });

  it("coerces numbers and passes text through", () => {
    expect(toJiraValue({ kind: "number", id: "n", name: "N" }, "3")).toBe(3);
    expect(toJiraValue({ kind: "text", id: "t", name: "T" }, " hi ")).toBe("hi");
  });

  it("sends a date as typed and a datetime as midnight ISO", () => {
    expect(toJiraValue({ kind: "date", id: "d", name: "D" }, "2026-07-28")).toBe("2026-07-28");
    expect(toJiraValue({ kind: "datetime", id: "d", name: "D" }, "2026-07-28")).toBe("2026-07-28T00:00:00.000+0000");
  });
});

describe("validateFieldInput", () => {
  it("rejects blank input", () => {
    expect(validateFieldInput({ kind: "text", id: "t", name: "Notes" }, "  ")).toBe("Notes is required.");
  });

  it("rejects non-numeric input for a number field", () => {
    expect(validateFieldInput({ kind: "number", id: "n", name: "N" }, "abc")).toBe("Enter a number.");
    expect(validateFieldInput({ kind: "number", id: "n", name: "N" }, "3.5")).toBeUndefined();
  });

  it("requires YYYY-MM-DD for date fields", () => {
    expect(validateFieldInput({ kind: "date", id: "d", name: "D" }, "28/07/2026")).toBe("Use the format YYYY-MM-DD.");
    expect(validateFieldInput({ kind: "datetime", id: "d", name: "D" }, "2026-07-28")).toBeUndefined();
  });

  it("accepts any non-blank text", () => {
    expect(validateFieldInput({ kind: "text", id: "t", name: "T" }, "anything")).toBeUndefined();
  });
});

describe("missingFieldIds", () => {
  const FIELDS: Record<string, TransitionFieldMeta> = {
    resolution: RESOLUTION,
    customfield_10042: { required: false, name: "Root Cause", schema: { type: "string" } },
  };

  it("prefers explicit field-error keys", () => {
    const ids = missingFieldIds(FIELDS, { fieldErrors: { customfield_10042: "Required" }, messages: [] });
    expect(ids).toEqual(["customfield_10042"]);
  });

  it("matches display names inside free-text messages when there are no field errors", () => {
    const ids = missingFieldIds(FIELDS, {
      fieldErrors: {},
      messages: ["Ticket cannot be closed unless Resolution will be provided"],
    });
    expect(ids).toEqual(["resolution"]);
  });

  it("ignores field-error keys the transition does not know about", () => {
    expect(missingFieldIds(FIELDS, { fieldErrors: { unknown_1: "Required" }, messages: [] })).toEqual([]);
  });

  it("does not match on very short names that would fire on any prose", () => {
    const ids = missingFieldIds({ f: { required: true, name: "ID", schema: { type: "string" } } }, {
      fieldErrors: {},
      messages: ["Something did not work"],
    });
    expect(ids).toEqual([]);
  });

  it("returns nothing when the rejection points nowhere", () => {
    expect(missingFieldIds(FIELDS, { fieldErrors: {}, messages: ["Transition is not valid"] })).toEqual([]);
  });
});

describe("mentionsResolution", () => {
  it("detects resolution in prose and in field-error keys", () => {
    expect(mentionsResolution({ fieldErrors: {}, messages: ["… unless Resolution will be provided"] })).toBe(true);
    expect(mentionsResolution({ fieldErrors: { resolution: "Required" }, messages: [] })).toBe(true);
  });

  it("is false otherwise", () => {
    expect(mentionsResolution({ fieldErrors: { other: "x" }, messages: ["nope"] })).toBe(false);
  });
});

describe("fieldDisplayNames", () => {
  it("maps ids to names, skipping entries without one", () => {
    expect(fieldDisplayNames({ resolution: RESOLUTION, x: { schema: { type: "string" } } }))
      .toEqual({ resolution: "Resolution" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/jira/transitionFields.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/jira/transitionFields"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/jira/transitionFields.ts`:

```ts
/** One field on a transition screen, as Jira describes it under
 *  `GET /transitions?expand=transitions.fields`. */
export interface TransitionFieldMeta {
  required?: boolean;
  name?: string;
  hasDefaultValue?: boolean;
  schema?: { type?: string; system?: string; custom?: string; items?: string };
  allowedValues?: { id?: string; name?: string; value?: string }[];
}

/** What we can ask a user for, and how. Anything Jira declares that doesn't map
 *  to one of these is skipped — see `promptableFields`. */
export type FieldPrompt =
  | { kind: "pick" | "multipick"; id: string; name: string; choices: { id?: string; name: string }[] }
  | { kind: "text" | "number" | "date" | "datetime" | "labels"; id: string; name: string };

/** Split a transition's fields into the prompts we can run and the display names
 *  we had to skip. Without `only`, considers required fields; with it, considers
 *  exactly those ids — the recovery path re-prompts fields Jira rejected even
 *  when the screen metadata never marked them required. */
export function promptableFields(
  fields: Record<string, TransitionFieldMeta>,
  opts: { only?: string[] } = {},
): { prompts: FieldPrompt[]; skipped: string[] } {
  const ids = opts.only
    ? opts.only.filter((id) => id in fields)
    : Object.keys(fields).filter((id) => fields[id]?.required === true);
  const prompts: FieldPrompt[] = [];
  const skipped: string[] = [];
  for (const id of ids) {
    const meta = fields[id] ?? {};
    const prompt = classify(id, meta);
    if (prompt) prompts.push(prompt);
    else skipped.push(meta.name ?? id);
  }
  return { prompts, skipped };
}

function classify(id: string, meta: TransitionFieldMeta): FieldPrompt | null {
  const name = meta.name ?? id;
  const type = meta.schema?.type ?? "";
  // API v3 wants ADF for rich text; a plain string would just earn a second
  // rejection, so treat these as unfillable rather than guessing.
  if (isRichText(meta)) return null;
  if (Array.isArray(meta.allowedValues) && meta.allowedValues.length) {
    const choices = meta.allowedValues
      .map((v) => ({ id: v.id, name: v.name ?? v.value ?? v.id ?? "" }))
      .filter((c) => c.name);
    if (!choices.length) return null;
    return { kind: type === "array" ? "multipick" : "pick", id, name, choices };
  }
  if (type === "array" && meta.schema?.items === "string") return { kind: "labels", id, name };
  if (type === "string") return { kind: "text", id, name };
  if (type === "number") return { kind: "number", id, name };
  if (type === "date") return { kind: "date", id, name };
  if (type === "datetime") return { kind: "datetime", id, name };
  return null;
}

function isRichText(meta: TransitionFieldMeta): boolean {
  const system = meta.schema?.system;
  return system === "description" || system === "environment" || (meta.schema?.custom ?? "").endsWith(":textarea");
}

/** Convert a prompt answer into the JSON shape Jira's transition body expects. */
export function toJiraValue(prompt: FieldPrompt, input: string | string[]): unknown {
  switch (prompt.kind) {
    case "pick":
      return reference(prompt.choices, String(input));
    case "multipick":
      return (Array.isArray(input) ? input : [input]).map((n) => reference(prompt.choices, n));
    case "labels":
      return (Array.isArray(input) ? input : String(input).split(","))
        .map((s) => s.trim())
        .filter(Boolean);
    case "number":
      return Number(String(input).trim());
    case "datetime":
      return `${String(input).trim()}T00:00:00.000+0000`;
    case "date":
    case "text":
    default:
      return String(input).trim();
  }
}

/** Prefer the id — it's stable across renames. Fall back to the literal value
 *  for the rare allowedValues entry that ships without one. */
function reference(choices: { id?: string; name: string }[], name: string): { id: string } | { value: string } {
  const hit = choices.find((c) => c.name === name);
  return hit?.id ? { id: hit.id } : { value: name };
}

/** Message for an invalid entry, or undefined when it's acceptable. Wired to the
 *  InputBox so bad input never costs a round-trip. */
export function validateFieldInput(prompt: FieldPrompt, raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return `${prompt.name} is required.`;
  if (prompt.kind === "number" && !Number.isFinite(Number(v))) return "Enter a number.";
  if ((prompt.kind === "date" || prompt.kind === "datetime") && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return "Use the format YYYY-MM-DD.";
  }
  return undefined;
}

/** Which fields a rejection is pointing at. Explicit `errors` keys win; failing
 *  that, we match field names inside the free-text messages, which is all a
 *  custom workflow validator gives us. */
export function missingFieldIds(
  fields: Record<string, TransitionFieldMeta>,
  err: { fieldErrors: Record<string, string>; messages: string[] },
): string[] {
  const explicit = Object.keys(err.fieldErrors).filter((id) => id in fields);
  if (explicit.length) return explicit;
  const haystack = err.messages.join(" ").toLowerCase();
  if (!haystack) return [];
  return Object.entries(fields)
    .filter(([, meta]) => {
      const name = (meta.name ?? "").toLowerCase();
      // Two characters or fewer matches almost any sentence by accident.
      return name.length > 2 && haystack.includes(name);
    })
    .map(([id]) => id);
}

/** True when the rejection blames Resolution — the one field common enough to
 *  be worth fetching the site-wide list for when screen metadata has nothing. */
export function mentionsResolution(err: { fieldErrors: Record<string, string>; messages: string[] }): boolean {
  return (
    err.messages.some((m) => /resolution/i.test(m)) ||
    Object.keys(err.fieldErrors).some((k) => /resolution/i.test(k))
  );
}

/** id → display name, for rendering field errors in something a human recognises. */
export function fieldDisplayNames(fields: Record<string, TransitionFieldMeta>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, meta] of Object.entries(fields)) if (meta?.name) out[id] = meta.name;
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/jira/transitionFields.test.ts && npm run typecheck`
Expected: PASS, 29 tests. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/jira/transitionFields.ts test/unit/jira/transitionFields.test.ts
git commit -m "feat(jira): classify transition screen fields into promptable inputs"
```

---

### Task 3: Client — typed errors, expanded transitions, field payload

**Files:**
- Modify: `src/jira/client.ts:70-73` (throw), `src/jira/client.ts:175-191` (transitions), plus a new `listResolutions`
- Modify: `test/unit/jira/client.test.ts:49-52` (the existing raw-body assertion)
- Test: `test/unit/jira/client.test.ts`

**Interfaces:**
- Consumes: `JiraApiError`, `parseJiraError` (Task 1); `TransitionFieldMeta` (Task 2).
- Produces:
  - `interface TransitionOption { id: string; name: string; toName: string; toCategory: string; fields: Record<string, TransitionFieldMeta> }`
  - `getTransitions(key: string): Promise<TransitionOption[]>`
  - `transition(key: string, transitionId: string, fields?: Record<string, unknown>): Promise<void>`
  - `listResolutions(): Promise<{ id?: string; name: string }[]>`

- [ ] **Step 1: Write the failing test**

Replace the existing `it("throws a generic Error with the status + body on other non-2xx", …)` case at `test/unit/jira/client.test.ts:49-52` with the two cases below, and append the new `describe` block to the same file:

```ts
  it("throws a JiraApiError carrying the parsed envelope on other non-2xx", async () => {
    installFetch([
      textResponse(
        JSON.stringify({ errorMessages: ["Ticket cannot be closed unless Resolution will be provided"], errors: {} }),
        400,
      ),
    ]);
    const err = await client().getTransitions("PROJ-1").catch((e) => e);
    expect(err).toBeInstanceOf(mod.JiraApiError);
    expect(err.status).toBe(400);
    expect(err.messages).toEqual(["Ticket cannot be closed unless Resolution will be provided"]);
    expect(err.message).toBe("Ticket cannot be closed unless Resolution will be provided.");
  });

  it("does not leak a non-JSON error body into the message", async () => {
    installFetch([textResponse("server boom", 500)]);
    await expect(client().getTransitions("PROJ-1")).rejects.toThrow("Jira is having trouble (500) — try again shortly.");
  });
```

Add `JiraApiError` to the import surface by using `mod.JiraApiError` (the file already imports the module as `mod`), then append:

```ts
describe("transitions", () => {
  const TRANSITIONS = {
    transitions: [
      {
        id: "41",
        name: "Resolve",
        to: { name: "Done", statusCategory: { key: "done" } },
        fields: {
          resolution: {
            required: true,
            name: "Resolution",
            schema: { type: "resolution", system: "resolution" },
            allowedValues: [{ id: "10000", name: "Done" }],
          },
        },
      },
    ],
  };

  it("asks Jira to expand the transition screen fields", async () => {
    const fetchMock = installFetch([jsonResponse(TRANSITIONS)]);
    await client().getTransitions("PROJ-1");
    expect(urlOf(fetchMock, 0)).toBe(`${BASE}/rest/api/3/issue/PROJ-1/transitions?expand=transitions.fields`);
  });

  it("surfaces the field metadata alongside the status names", async () => {
    installFetch([jsonResponse(TRANSITIONS)]);
    const [t] = await client().getTransitions("PROJ-1");
    expect(t).toMatchObject({ id: "41", name: "Resolve", toName: "Done", toCategory: "done" });
    expect(t.fields.resolution.allowedValues).toEqual([{ id: "10000", name: "Done" }]);
  });

  it("defaults fields to an empty record when Jira omits them", async () => {
    installFetch([jsonResponse({ transitions: [{ id: "31", name: "Start", to: { name: "In Progress" } }] })]);
    const [t] = await client().getTransitions("PROJ-1");
    expect(t.fields).toEqual({});
  });

  it("posts only the transition id when there are no fields", async () => {
    const fetchMock = installFetch([emptyResponse(204)]);
    await client().transition("PROJ-1", "41");
    expect(bodyOf(fetchMock, 0)).toEqual({ transition: { id: "41" } });
  });

  it("omits an empty fields object rather than sending `fields: {}`", async () => {
    const fetchMock = installFetch([emptyResponse(204)]);
    await client().transition("PROJ-1", "41", {});
    expect(bodyOf(fetchMock, 0)).toEqual({ transition: { id: "41" } });
  });

  it("includes collected fields in the transition body", async () => {
    const fetchMock = installFetch([emptyResponse(204)]);
    await client().transition("PROJ-1", "41", { resolution: { id: "10000" } });
    expect(bodyOf(fetchMock, 0)).toEqual({ transition: { id: "41" }, fields: { resolution: { id: "10000" } } });
  });
});

describe("listResolutions", () => {
  it("maps the site resolution list to id + name", async () => {
    installFetch([jsonResponse([{ id: "10000", name: "Done" }, { id: "10001", name: "Won't Do" }])]);
    await expect(client().listResolutions()).resolves.toEqual([
      { id: "10000", name: "Done" },
      { id: "10001", name: "Won't Do" },
    ]);
  });

  it("drops entries without a name and tolerates a non-array body", async () => {
    installFetch([jsonResponse([{ id: "1" }, { id: "2", name: "Done" }])]);
    await expect(client().listResolutions()).resolves.toEqual([{ id: "2", name: "Done" }]);
    installFetch([jsonResponse({ nope: true })]);
    await expect(client().listResolutions()).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/jira/client.test.ts`
Expected: FAIL — `mod.JiraApiError is not a constructor`, the expand URL assertion sees the un-expanded path, and `client().listResolutions is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/jira/client.ts`:

Add to the imports at the top:

```ts
import { parseJiraError } from "./errors";
import { TransitionFieldMeta } from "./transitionFields";
```

Re-export the error type so callers have one import site for Jira failures — put it next to the existing `JiraAuthError` declaration on line 5:

```ts
export { JiraApiError } from "./errors";
```

Replace the non-OK branch (lines 70-73):

```ts
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw parseJiraError(res.status, body);
    }
```

Add the transition option type next to `JiraDetail`:

```ts
/** A workflow transition plus the fields its screen declares — the metadata that
 *  tells us what to prompt for before attempting the write. */
export interface TransitionOption {
  id: string;
  name: string;
  toName: string;
  toCategory: string;
  fields: Record<string, TransitionFieldMeta>;
}
```

Replace `getTransitions` and `transition` (lines 175-191):

```ts
  /** Valid workflow transitions for an issue (Jira only allows configured next
   *  states). Expanded with each transition's screen fields — same round-trip,
   *  and it's the only way to know what the write will demand. */
  async getTransitions(key: string): Promise<TransitionOption[]> {
    const data = await this.request(
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions?expand=transitions.fields`,
    );
    return (data?.transitions ?? []).map((t: any) => ({
      id: t.id,
      name: t.name,
      toName: t.to?.name ?? t.name,
      toCategory: t.to?.statusCategory?.key ?? "",
      fields: t.fields ?? {},
    }));
  }

  async transition(key: string, transitionId: string, fields: Record<string, unknown> = {}): Promise<void> {
    const body: Record<string, unknown> = { transition: { id: transitionId } };
    if (Object.keys(fields).length) body.fields = fields;
    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** The site's resolution list. Only used when a workflow validator demands a
   *  Resolution that never appeared on the transition screen. */
  async listResolutions(): Promise<{ id?: string; name: string }[]> {
    const data = await this.request("/rest/api/3/resolution");
    return (Array.isArray(data) ? data : [])
      .map((r: any) => ({ id: r?.id, name: r?.name ?? "" }))
      .filter((r: { name: string }) => !!r.name);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/jira/client.test.ts && npm run typecheck`
Expected: PASS. Typecheck clean.

- [ ] **Step 5: Run the full suite to catch fallout**

Run: `npm test`
Expected: `test/unit/tasksView.test.ts` may fail on `getTransitions` stubs that now need a `fields` key — that is Task 4's job. Everything else passes. Note any failures; do not fix them here.

- [ ] **Step 6: Commit**

```bash
git add src/jira/client.ts test/unit/jira/client.test.ts
git commit -m "feat(jira): expand transition fields and send them on transition"
```

---

### Task 4: Collect required fields before the write

**Files:**
- Modify: `src/tasksView.ts` — imports, `changeStatus` (lines 233-272), new `collectFields`
- Modify: `test/unit/tasksView.test.ts` — `makeClient` stub, existing `changeStatus` assertions
- Test: `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `promptableFields`, `toJiraValue`, `validateFieldInput`, `FieldPrompt` (Task 2); `TransitionOption`, `transition(key, id, fields)` (Task 3).
- Produces: `private collectFields(key: string, toName: string, prompts: FieldPrompt[]): Promise<Record<string, unknown> | undefined>` — `undefined` means the user cancelled.

- [ ] **Step 1: Write the failing test**

In `test/unit/tasksView.test.ts`, add `listResolutions: vi.fn(async () => [] as unknown[]),` to `makeClient` (after `transition`), and change the existing assertion at line 291 to include the fields argument:

```ts
    expect(clientStub.transition).toHaveBeenCalledWith("PROJ-1", "41", {});
```

Then add this block inside the existing `describe("changeStatus", …)`:

```ts
  const DONE_WITH_RESOLUTION = {
    id: "41",
    name: "Resolve",
    toName: "Done",
    toCategory: "done",
    fields: {
      resolution: {
        required: true,
        name: "Resolution",
        schema: { type: "resolution", system: "resolution" },
        allowedValues: [{ id: "10000", name: "Done" }, { id: "10001", name: "Won't Do" }],
      },
    },
  };

  /** The status QuickPick answers first, then one answer per field prompt. */
  const answerPicks = (...answers: unknown[]) => {
    const pick = vi.mocked(window.showQuickPick);
    pick.mockReset();
    for (const a of answers) pick.mockResolvedValueOnce(a as never);
    pick.mockResolvedValue(undefined as never);
  };

  it("prompts for a required resolution and sends it with the transition", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    answerPicks({ t: DONE_WITH_RESOLUTION }, { label: "Won't Do" });
    const { provider } = setup();
    await provider.changeStatus("PROJ-1");
    expect(clientStub.transition).toHaveBeenCalledWith("PROJ-1", "41", { resolution: { id: "10001" } });
  });

  it("writes nothing when the field prompt is cancelled", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    answerPicks({ t: DONE_WITH_RESOLUTION }, undefined);
    const { provider, posted } = setup();
    await provider.changeStatus("PROJ-1");
    expect(clientStub.transition).not.toHaveBeenCalled();
    expect(posted().filter((p) => p.type === "toast")).toEqual([]);
  });

  it("prompts a required text field through an input box", async () => {
    const t = {
      id: "51",
      name: "Close",
      toName: "Closed",
      toCategory: "done",
      fields: { customfield_1: { required: true, name: "Reason", schema: { type: "string" } } },
    };
    clientStub.getTransitions.mockResolvedValue([t]);
    answerPicks({ t });
    vi.mocked(window.showInputBox).mockResolvedValue("shipped in 0.1.36" as never);
    const { provider } = setup();
    await provider.changeStatus("PROJ-1");
    expect(clientStub.transition).toHaveBeenCalledWith("PROJ-1", "51", { customfield_1: "shipped in 0.1.36" });
  });

  it("skips unfillable required fields and attempts the write anyway", async () => {
    const t = {
      id: "61",
      name: "Close",
      toName: "Closed",
      toCategory: "done",
      fields: { assignee: { required: true, name: "Assignee", schema: { type: "user", system: "assignee" } } },
    };
    clientStub.getTransitions.mockResolvedValue([t]);
    answerPicks({ t });
    const { provider } = setup();
    await provider.changeStatus("PROJ-1");
    expect(clientStub.transition).toHaveBeenCalledWith("PROJ-1", "61", {});
  });

  it("does not prompt for optional screen fields", async () => {
    const t = {
      id: "71",
      name: "Start",
      toName: "In Progress",
      toCategory: "indeterminate",
      fields: { comment: { required: false, name: "Comment", schema: { type: "string" } } },
    };
    clientStub.getTransitions.mockResolvedValue([t]);
    answerPicks({ t });
    const { provider } = setup();
    await provider.changeStatus("PROJ-1");
    expect(window.showInputBox).not.toHaveBeenCalled();
    expect(clientStub.transition).toHaveBeenCalledWith("PROJ-1", "71", {});
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: FAIL — `transition` is still called with two arguments and no field prompt runs.

- [ ] **Step 3: Write minimal implementation**

In `src/tasksView.ts`, extend the client import and add the field helpers:

```ts
import { JiraClient, JiraAuthError, TransitionOption } from "./jira/client";
import {
  promptableFields,
  toJiraValue,
  validateFieldInput,
  type FieldPrompt,
} from "./jira/transitionFields";
```

(Keep whatever the existing `./jira/client` import line already brings in; add `TransitionOption` to it. `JiraApiError` arrives in Task 5, where it's first used.)

Replace the tail of `changeStatus` — everything from `if (!pick) return;` down to the end of the method — with:

```ts
    if (!pick) return;
    const target: TransitionOption = pick.t;

    const { prompts, skipped } = promptableFields(target.fields);
    if (skipped.length) {
      this.log(`changeStatus ${key}: can't fill ${skipped.join(", ")} here — letting Jira decide`);
    }
    const fields = await this.collectFields(key, target.toName, prompts);
    if (fields === undefined) {
      this.log(`changeStatus ${key}: cancelled at a field prompt`);
      return;
    }

    await client.transition(key, target.id, fields);
    this.log(`changeStatus ${key}: transition POST ok → ${target.toName}`);
    if (cfg.stampLabelOnWrite) {
      try {
        await client.addLabel(key, cfg.provenanceLabel);
      } catch (e) {
        this.log(`label stamp failed for ${key}: ${e}`);
      }
    }
    const removed = target.toCategory === "done";
    this.post({ type: "statusChanged", key, status: target.toName, category: target.toCategory, removed });
    this.toast("success", `${key} → ${target.toName}`);
  }

  /** Run one prompt per field, in order. Returns the collected `fields` payload,
   *  or undefined when the user escaped — a half-filled transition is never worth
   *  writing, so cancelling any prompt cancels the whole thing. */
  private async collectFields(
    key: string,
    toName: string,
    prompts: FieldPrompt[],
  ): Promise<Record<string, unknown> | undefined> {
    const out: Record<string, unknown> = {};
    for (const p of prompts) {
      const title = `${key} → ${toName}`;
      // The two QuickPick calls are kept separate on purpose: `canPickMany` only
      // selects the array-returning overload when it's the literal `true`.
      if (p.kind === "multipick") {
        const picked = await vscode.window.showQuickPick(
          p.choices.map((c) => ({ label: c.name })),
          { title, placeHolder: `Pick ${p.name}`, canPickMany: true, ignoreFocusOut: true },
        );
        if (!picked || picked.length === 0) return undefined;
        out[p.id] = toJiraValue(p, picked.map((i) => i.label));
      } else if (p.kind === "pick") {
        const picked = await vscode.window.showQuickPick(
          p.choices.map((c) => ({ label: c.name })),
          { title, placeHolder: `Pick ${p.name}`, ignoreFocusOut: true },
        );
        if (!picked) return undefined;
        out[p.id] = toJiraValue(p, picked.label);
      } else {
        const raw = await vscode.window.showInputBox({
          title,
          prompt: p.name,
          placeHolder: p.kind === "date" || p.kind === "datetime" ? "YYYY-MM-DD" : undefined,
          ignoreFocusOut: true,
          validateInput: (v: string) => validateFieldInput(p, v),
        });
        if (raw === undefined) return undefined;
        out[p.id] = toJiraValue(p, raw);
      }
    }
    return out;
  }
```

No other change is needed: `transitions` is typed by `getTransitions()`, which now returns `TransitionOption[]`, so `pick.t` carries `fields` without an extra annotation.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/tasksView.test.ts && npm run typecheck`
Expected: PASS. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(tasks): prompt for a transition's required fields before writing"
```

---

### Task 5: Recover from a rejected transition, and stop gating on write failures

**Files:**
- Modify: `src/tasksView.ts` — `toast` helper (line 64), `onMessage` catch (lines 218-230), `changeStatus`, new `recoverTransition` + `reportWriteFailure`
- Test: `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `JiraApiError`, `describeJiraError` (Task 1); `missingFieldIds`, `mentionsResolution`, `fieldDisplayNames`, `promptableFields` (Task 2); `listResolutions` (Task 3); `collectFields` (Task 4).
- Produces: `private toast(level, message, action?: { label: string; url: string })` — the extra parameter is what Task 6's webview renders.

- [ ] **Step 1a: Make the mocked client export the real error class**

`test/unit/tasksView.test.ts` mocks `src/jira/client` wholesale, so `JiraApiError`
would be `undefined` inside `tasksView` and every `instanceof` check would throw
`Right-hand side of 'instanceof' is not an object`. Re-export the genuine class
from the mock factory (around line 22) so the real `parseJiraError` produces
instances the production code recognises:

```ts
vi.mock("../../src/jira/client", async () => {
  const errors = await vi.importActual<typeof import("../../src/jira/errors")>("../../src/jira/errors");
  class JiraAuthError extends Error {}
  return { JiraAuthError, JiraApiError: errors.JiraApiError, JiraClient: vi.fn() };
});
```

- [ ] **Step 1b: Write the failing test**

Add to `test/unit/tasksView.test.ts` inside `describe("changeStatus", …)` — `DONE_WITH_RESOLUTION` and `answerPicks` come from Task 4:

```ts
  // `src/jira/client` is mocked in this file, but `src/jira/errors` is not — the
  // real parser gives the recovery path a faithful JiraApiError to react to.
  // Add to the imports at the top of the file:
  //   import { parseJiraError } from "../../src/jira/errors";
  const apiError = (messages: string[], fieldErrors: Record<string, string> = {}) =>
    parseJiraError(400, JSON.stringify({ errorMessages: messages, errors: fieldErrors }));

  it("re-prompts from a workflow validator that names a screen field, then retries once", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    clientStub.transition
      .mockRejectedValueOnce(apiError(["Ticket cannot be closed unless Resolution will be provided"]))
      .mockResolvedValueOnce(undefined);
    // The upfront pass already asks for Resolution, so answer it twice.
    answerPicks({ t: DONE_WITH_RESOLUTION }, { label: "Done" }, { label: "Won't Do" });
    const { provider, posted } = setup();
    await provider.changeStatus("PROJ-1");
    expect(clientStub.transition).toHaveBeenCalledTimes(2);
    expect(clientStub.transition).toHaveBeenLastCalledWith("PROJ-1", "41", { resolution: { id: "10001" } });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "statusChanged", key: "PROJ-1" }));
  });

  it("re-prompts from explicit field errors even when the field wasn't required", async () => {
    const t = {
      id: "41",
      name: "Resolve",
      toName: "Done",
      toCategory: "done",
      fields: {
        customfield_1: {
          required: false,
          name: "Root Cause",
          schema: { type: "option" },
          allowedValues: [{ id: "9", name: "Config drift" }],
        },
      },
    };
    clientStub.getTransitions.mockResolvedValue([t]);
    clientStub.transition
      .mockRejectedValueOnce(apiError([], { customfield_1: "Field is required" }))
      .mockResolvedValueOnce(undefined);
    answerPicks({ t }, { label: "Config drift" });
    const { provider } = setup();
    await provider.changeStatus("PROJ-1");
    expect(clientStub.transition).toHaveBeenLastCalledWith("PROJ-1", "41", { customfield_1: { id: "9" } });
  });

  it("falls back to the site resolution list when the screen declared no fields", async () => {
    const t = { id: "41", name: "Resolve", toName: "Done", toCategory: "done", fields: {} };
    clientStub.getTransitions.mockResolvedValue([t]);
    clientStub.listResolutions.mockResolvedValue([{ id: "10000", name: "Done" }]);
    clientStub.transition
      .mockRejectedValueOnce(apiError(["Ticket cannot be closed unless Resolution will be provided"]))
      .mockResolvedValueOnce(undefined);
    answerPicks({ t }, { label: "Done" });
    const { provider } = setup();
    await provider.changeStatus("PROJ-1");
    expect(clientStub.listResolutions).toHaveBeenCalled();
    expect(clientStub.transition).toHaveBeenLastCalledWith("PROJ-1", "41", { resolution: { id: "10000" } });
  });

  it("reports a readable toast with an Open in Jira action when nothing can be re-prompted", async () => {
    const t = { id: "41", name: "Resolve", toName: "Done", toCategory: "done", fields: {} };
    clientStub.getTransitions.mockResolvedValue([t]);
    clientStub.transition.mockRejectedValue(apiError(["Transition is not valid"]));
    answerPicks({ t });
    const { provider, posted } = setup();
    await provider.changeStatus("PROJ-1");
    expect(clientStub.transition).toHaveBeenCalledTimes(1);
    expect(posted()).toContainEqual({
      type: "toast",
      level: "error",
      message: "Couldn't update PROJ-1. Transition is not valid.",
      action: { label: "Open in Jira", url: "https://jira/browse/PROJ-1" },
    });
    expect(posted().some((p) => p.type === "statusChanged")).toBe(false);
  });

  it("names the field in the message when the rejection is field-scoped", async () => {
    const t = {
      id: "41",
      name: "Resolve",
      toName: "Done",
      toCategory: "done",
      fields: { customfield_1: { required: false, name: "Root Cause", schema: { type: "option-with-child" } } },
    };
    clientStub.getTransitions.mockResolvedValue([t]);
    clientStub.transition.mockRejectedValue(apiError([], { customfield_1: "Field is required" }));
    answerPicks({ t });
    const { provider, posted } = setup();
    await provider.changeStatus("PROJ-1");
    expect(posted()).toContainEqual(
      expect.objectContaining({ message: "Couldn't update PROJ-1. Root Cause: Field is required." }),
    );
  });

  it("does not retry a second time", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    clientStub.transition.mockRejectedValue(apiError(["Ticket cannot be closed unless Resolution will be provided"]));
    answerPicks({ t: DONE_WITH_RESOLUTION }, { label: "Done" }, { label: "Done" });
    const { provider, posted } = setup();
    await provider.changeStatus("PROJ-1");
    expect(clientStub.transition).toHaveBeenCalledTimes(2);
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
  });

  it("stays silent when the recovery prompt is cancelled", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    clientStub.transition.mockRejectedValue(apiError(["Ticket cannot be closed unless Resolution will be provided"]));
    answerPicks({ t: DONE_WITH_RESOLUTION }, { label: "Done" }, undefined);
    const { provider, posted } = setup();
    await provider.changeStatus("PROJ-1");
    expect(clientStub.transition).toHaveBeenCalledTimes(1);
    expect(posted().filter((p) => p.type === "toast")).toEqual([]);
  });
```

And a new top-level block for the gate routing:

```ts
describe("failure routing", () => {
  it("gates the panel when the task fetch fails", async () => {
    clientStub.fetchTasks.mockRejectedValue(new Error("Couldn't reach Jira"));
    const { send, posted } = setup();
    await send({ type: "fetch", filter: "mysprint", size: "any" });
    expect(posted()).toContainEqual({ type: "error", message: "Couldn't reach Jira", canRetry: true });
  });

  it("leaves the list up when a write fails — toast only", async () => {
    clientStub.getTransitions.mockRejectedValue(new Error("Couldn't reach Jira"));
    const { send, posted } = setup();
    await send({ type: "changeStatus", key: "PROJ-1" });
    expect(posted().some((p) => p.type === "error")).toBe(false);
    expect(posted()).toContainEqual({ type: "toast", level: "error", message: "Couldn't reach Jira" });
  });
});
```

`setup()` already returns a `send` that drives the real `onDidReceiveMessage`
handler (see `test/unit/tasksView.test.ts:140`), so `onMessage` stays private —
no refactor needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: FAIL — the rejected `transition` propagates instead of recovering, and write failures still post `error`.

- [ ] **Step 3: Write minimal implementation**

In `src/tasksView.ts`, extend the imports:

```ts
import { describeJiraError } from "./jira/errors";
import {
  promptableFields,
  toJiraValue,
  validateFieldInput,
  missingFieldIds,
  mentionsResolution,
  fieldDisplayNames,
  type FieldPrompt,
} from "./jira/transitionFields";
```

Widen the `toast` helper (line 64):

```ts
  private toast(
    level: "success" | "error" | "info",
    message: string,
    action?: { label: string; url: string },
  ): void {
    this.post({ type: "toast", level, message, ...(action ? { action } : {}) });
  }
```

Wrap the POST in `changeStatus` — replace the bare `await client.transition(key, target.id, fields);` from Task 4 with:

```ts
    try {
      await client.transition(key, target.id, fields);
    } catch (e) {
      if (!(e instanceof JiraApiError)) throw e;
      const recovered = await this.recoverTransition(client, key, target, e, fields);
      if (!recovered) return; // already reported, or the user backed out
    }
```

Add the two new methods after `collectFields`:

```ts
  /** One rescue attempt after Jira refuses a transition. Screen metadata can't see
   *  custom workflow validators, so the rejection itself is the only place some
   *  requirements are ever stated. Returns true when the retry succeeded. */
  private async recoverTransition(
    client: JiraClient,
    key: string,
    target: TransitionOption,
    err: JiraApiError,
    already: Record<string, unknown>,
  ): Promise<boolean> {
    const names = fieldDisplayNames(target.fields);
    const ids = missingFieldIds(target.fields, err);
    let prompts: FieldPrompt[] = ids.length ? promptableFields(target.fields, { only: ids }).prompts : [];

    if (!prompts.length && mentionsResolution(err)) {
      const resolutions = await client.listResolutions().catch(() => []);
      if (resolutions.length) {
        prompts = [{ kind: "pick", id: "resolution", name: "Resolution", choices: resolutions }];
      }
    }
    if (!prompts.length) {
      this.reportWriteFailure(key, err, names);
      return false;
    }

    this.log(`changeStatus ${key}: rejected — re-prompting ${prompts.map((p) => p.name).join(", ")}`);
    const extra = await this.collectFields(key, target.toName, prompts);
    if (extra === undefined) return false;
    try {
      await client.transition(key, target.id, { ...already, ...extra });
      return true;
    } catch (e) {
      if (!(e instanceof JiraApiError)) throw e;
      this.reportWriteFailure(key, e, names);
      return false;
    }
  }

  /** A refused write leaves the list valid, so it gets a toast — never the gate —
   *  with a way out to the ticket itself. */
  private reportWriteFailure(key: string, err: JiraApiError, names: Record<string, string>): void {
    const cfg = getConfig();
    const message = `Couldn't update ${key}. ${describeJiraError(err, names)}`;
    this.log(`changeStatus ${key}: ${err.status} — ${message}`);
    this.toast("error", message, { label: "Open in Jira", url: `${cfg.baseUrl}/browse/${key}` });
  }
```

Finally, narrow the gate in the `onMessage` catch (lines 218-230):

```ts
    } catch (e) {
      this.post({ type: "loading", loading: false });
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof JiraAuthError) {
        // Auth failures re-gate to the sign-in screen, which is itself the indication.
        this.postState(false, !!cfg.baseUrl && !!cfg.project, null);
      } else if (m.type === "ready" || m.type === "retry" || m.type === "fetch") {
        // Only the messages that populate the panel may replace it: if the list
        // never loaded there is nothing to preserve. A failed write keeps its
        // list on screen and settles for a toast.
        this.post({ type: "error", message: msg, canRetry: true });
      }
      this.toast("error", msg);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/tasksView.test.ts && npm run typecheck`
Expected: PASS. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(tasks): recover from rejected transitions and keep the list on write failures"
```

---

### Task 6: Sticky error toasts with an action button

**Files:**
- Modify: `src/types.ts:243` (toast variant)
- Modify: `src/webview/App.tsx:134` (toast state), `:232-237` (dismiss timer), `:528-548` (`ToastStack`)
- Modify: `src/webview/styles.ts:271` (after `.toast-msg`)
- Test: `test/webview/App.test.tsx`

**Interfaces:**
- Consumes: the `action` field posted by `reportWriteFailure` (Task 5).
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

Replace the existing `describe("toasts", …)` block in `test/webview/App.test.tsx` with:

```ts
describe("toasts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows a toast and auto-dismisses it", () => {
    render(<App />);
    host({ type: "toast", level: "success", message: "Saved!" });
    expect(screen.getByText("Saved!")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(4300));
    expect(screen.queryByText("Saved!")).not.toBeInTheDocument();
  });

  it("keeps an error toast up past the auto-dismiss window", () => {
    render(<App />);
    host({ type: "toast", level: "error", message: "Couldn't update PROJ-1. Resolution is required." });
    act(() => vi.advanceTimersByTime(30000));
    expect(screen.getByText("Couldn't update PROJ-1. Resolution is required.")).toBeInTheDocument();
  });

  it("dismisses an error toast on click", () => {
    render(<App />);
    host({ type: "toast", level: "error", message: "Nope." });
    fireEvent.click(screen.getByText("Nope."));
    expect(screen.queryByText("Nope.")).not.toBeInTheDocument();
  });

  it("opens the ticket from the toast action without dismissing it", () => {
    render(<App />);
    host({
      type: "toast",
      level: "error",
      message: "Couldn't update PROJ-1.",
      action: { label: "Open in Jira", url: "https://jira/browse/PROJ-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open in Jira" }));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://jira/browse/PROJ-1" });
    expect(screen.getByText("Couldn't update PROJ-1.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/webview/App.test.tsx`
Expected: FAIL — the error toast disappears after 4.2s and there is no `Open in Jira` button.

- [ ] **Step 3: Write minimal implementation**

`src/types.ts` line 243 — add the optional action:

```ts
  // `action` renders as a button on the toast; used to link out to the ticket a
  // failed write belongs to.
  | { type: "toast"; level: "success" | "error" | "info"; message: string; action?: { label: string; url: string } }
```

`src/webview/App.tsx` line 134 — widen the state:

```ts
  const [toasts, setToasts] = React.useState<
    { id: number; level: string; message: string; action?: { label: string; url: string } }[]
  >([]);
```

Lines 232-237 — keep the timer for success/info only:

```ts
        case "toast": {
          const id = ++toastSeq;
          setToasts((t) => [...t.slice(-2), { id, level: m.level, message: m.message, action: m.action }]);
          // Errors stay until dismissed — a Jira validator message is longer than
          // 4.2s of reading, and it usually needs acting on.
          if (m.level !== "error") {
            setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
          }
          break;
        }
```

Replace `ToastStack` (lines 528-548):

```tsx
function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: { id: number; level: string; message: string; action?: { label: string; url: string } }[];
  onDismiss: (id: number) => void;
}): JSX.Element | null {
  if (toasts.length === 0) return null;
  const icon = (l: string) => (l === "success" ? "✓" : l === "error" ? "⚠" : "ℹ");
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.level}`} role="status" onClick={() => onDismiss(t.id)}>
          <span className="toast-ico">{icon(t.level)}</span>
          <span className="toast-msg">{t.message}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={(e) => {
                e.stopPropagation();
                send({ type: "openExternal", url: t.action!.url });
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
```

`src/webview/styles.ts` — after `.toast-msg` (line 271):

```
  .toast-action { flex: none; align-self: flex-start; cursor: pointer; font-size: 11px;
    padding: 2px 8px; border-radius: 4px; white-space: nowrap;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-textLink-foreground));
    border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); }
  .toast-action:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/webview/App.test.tsx && npm run typecheck`
Expected: PASS. Typecheck clean.

- [ ] **Step 5: Run the whole suite and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all suites green, typecheck clean, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/webview/App.tsx src/webview/styles.ts test/webview/App.test.tsx
git commit -m "feat(webview): sticky error toasts with an Open in Jira action"
```

---

## Manual verification

After Task 6, confirm the original bug is gone against the real Jira site:

1. `npm run build`, then reload the extension host (`Developer: Reload Window`).
2. On a ticket whose workflow demands a Resolution, use **Change Status → Done**.
3. Expect a **Pick Resolution** QuickPick — from the transition screen if it's declared there, otherwise after one silent rejection.
4. Choose one; the card should move to Done with the usual success toast.
5. To see the error path, pick a transition your workflow forbids: the task list must stay on screen, with a sticky readable toast and a working **Open in Jira** button.
