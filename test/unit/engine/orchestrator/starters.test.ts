import { describe, expect, it } from "vitest";
import { BUILTIN_PREFIX, STARTERS, isBuiltinTemplateId } from "../../../../src/engine/orchestrator/starters";
import { canBindTicket, validTemplate } from "../../../../src/engine/orchestrator/templates";
import { isPlanned } from "../../../../src/engine/orchestrator/model";

describe("built-in starters", () => {
  it("ships exactly three", () => {
    expect(STARTERS).toHaveLength(3);
  });

  it("gives every starter a builtin- id, and they are unique", () => {
    for (const t of STARTERS) expect(t.id.startsWith(BUILTIN_PREFIX)).toBe(true);
    expect(new Set(STARTERS.map((t) => t.id)).size).toBe(STARTERS.length);
  });

  it("recognises its own ids and rejects a user id", () => {
    for (const t of STARTERS) expect(isBuiltinTemplateId(t.id)).toBe(true);
    // `newFlowId` mints `<base36 time>-<4 char salt>` — never this prefix.
    expect(isBuiltinTemplateId("m7x2k1p9-4f2a")).toBe(false);
  });

  it("is a template this build can read", () => {
    for (const t of STARTERS) expect(validTemplate(t)).not.toBeNull();
  });

  it("can bind a ticket, so no starter dead-ends at attach", () => {
    for (const t of STARTERS) expect(canBindTicket(t.flow)).toBe(true);
  });

  it("leaves repos and mode for the card to fill in", () => {
    for (const t of STARTERS) {
      for (const n of t.flow.nodes.filter(isPlanned)) {
        expect(n.repos).toEqual([]);
        expect(n.mode).toBe("");
      }
    }
  });

  it("names no organization value anywhere in its payload", () => {
    // The no-hardcoded-org-values invariant, asserted on the data rather than
    // trusted: a starter is the one template a user did not write, so a repo or
    // project key baked in here would reach every install.
    const json = JSON.stringify(STARTERS);
    expect(json).not.toMatch(/atlassian\.net|github\.com/i);
  });

  it("points every edge at a node the starter actually has", () => {
    for (const t of STARTERS) {
      const ids = new Set(t.flow.nodes.map((n) => n.id));
      for (const e of t.flow.edges) {
        expect(ids.has(e.from)).toBe(true);
        expect(ids.has(e.to)).toBe(true);
      }
    }
  });
});
