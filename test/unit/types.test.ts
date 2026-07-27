import { describe, it, expect } from "vitest";
import { isTicketRun } from "../../src/types";
import type { Run } from "../../src/types";

const mkRun = (over: Partial<Run> = {}): Run => ({
  key: "ASM-1", summary: "do it", url: "https://jira/ASM-1", createdAt: 1, mode: "per-window",
  repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }], briefPaths: [], ...over,
});

describe("isTicketRun", () => {
  it("is true for a run launched from a Jira ticket", () => {
    expect(isTicketRun(mkRun())).toBe(true);
  });

  it("is false for an Explore session, which carries no ticket url", () => {
    expect(isTicketRun(mkRun({ key: "explore-retry-logic", url: "" }))).toBe(false);
  });

  it("treats a whitespace-only url as no url", () => {
    expect(isTicketRun(mkRun({ url: "   " }))).toBe(false);
  });

  it("survives a record with no url field at all", () => {
    // An older or hand-edited ~/.agentflow/runs entry. readRuns only validates
    // `key`, so a missing url reaches here and must not throw.
    const legacy = { ...mkRun() } as Partial<Run>;
    delete legacy.url;
    expect(isTicketRun(legacy as Run)).toBe(false);
  });
});
