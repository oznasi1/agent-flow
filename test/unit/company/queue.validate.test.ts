import { describe, it, expect } from "vitest";
import { validateItem, validateLanded } from "../../../src/company/queue";

function good(): Record<string, unknown> {
  return {
    id: "2026-07-31-1709-growth-landing-hero",
    cycle: "2026-07-31T17:09",
    role: "company-growth",
    kind: "copy",
    title: "Landing page hero",
    why: "Betting the setup pain is the wedge.",
    artifact: { type: "markdown", path: ".claude/company/drafts/hero.md" },
    risk: "gated",
    on_approve: "Write docs/landing/index.html next cycle",
  };
}

describe("validateItem", () => {
  it("accepts a complete item", () => {
    const r = validateItem(good());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.item.id).toBe("2026-07-31-1709-growth-landing-hero");
  });

  it("accepts an unknown kind, because unknown kinds render as text", () => {
    const r = validateItem({ ...good(), kind: "podcast" });
    expect(r.ok).toBe(true);
  });

  it("accepts an unknown artifact type for the same reason", () => {
    const r = validateItem({ ...good(), artifact: { type: "sql", inline: "select 1" } });
    expect(r.ok).toBe(true);
  });

  it("accepts optional branch and checks", () => {
    const r = validateItem({
      ...good(),
      branch: "company/growth-hero",
      checks: { typecheck: "pass", test: "142 passed", coverage: "94.1%" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.item.checks?.coverage).toBe("94.1%");
  });

  it.each([
    ["not an object", 42, "must be an object"],
    ["null", null, "must be an object"],
  ])("rejects %s", (_label, raw, needle) => {
    const r = validateItem(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(needle);
  });

  it.each(["id", "cycle", "role", "kind", "title", "why", "on_approve"])(
    "rejects a missing %s",
    (field) => {
      const raw = good();
      delete raw[field];
      const r = validateItem(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(field);
    },
  );

  it("rejects an empty title", () => {
    const r = validateItem({ ...good(), title: "   " });
    expect(r.ok).toBe(false);
  });

  it.each([
    ["a path separator", "growth/../../etc/passwd"],
    ["an absolute path", "/etc/passwd"],
    ["uppercase", "Growth-Hero"],
    ["a leading dash", "-growth"],
    ["over 120 chars", "a".repeat(121)],
  ])("rejects an id containing %s", (_label, id) => {
    const r = validateItem({ ...good(), id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("id");
  });

  it("rejects a risk outside the allowed set", () => {
    const r = validateItem({ ...good(), risk: "medium" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("risk");
  });

  it("rejects an artifact with neither path nor inline", () => {
    const r = validateItem({ ...good(), artifact: { type: "text" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("artifact");
  });

  it("rejects a non-object artifact", () => {
    const r = validateItem({ ...good(), artifact: "hello" });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-string check value", () => {
    const r = validateItem({ ...good(), checks: { test: 42 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("checks");
  });
});

describe("validateLanded", () => {
  it("accepts a complete record", () => {
    const r = validateLanded({
      id: "2026-07-31-1709-arch-dedupe",
      cycle: "2026-07-31T17:09",
      role: "company-architect",
      title: "Dedupe the review-queue mappers",
      sha: "a1b2c3d4e5f6a7b8",
      landed_at: "2026-07-31T17:41:02Z",
    });
    expect(r.ok).toBe(true);
  });

  it.each([
    ["not hex", "zzzzzzz"],
    ["too short", "a1b2c3"],
    ["too long", "a".repeat(41)],
  ])("rejects a sha that is %s", (_label, sha) => {
    const r = validateLanded({
      id: "x",
      cycle: "c",
      role: "r",
      title: "t",
      sha,
      landed_at: "now",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("sha");
  });
});
