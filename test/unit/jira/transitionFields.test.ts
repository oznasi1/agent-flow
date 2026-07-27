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
