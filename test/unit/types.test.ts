import { describe, it, expect } from "vitest";
import { isTicketRun, runKind } from "../../src/types";
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

  it("rejects a review run even though its url is a real PR", () => {
    // A review run has a url — a PR's, not a Jira issue's. Only `kind` (not the
    // url check) is what must keep it out of Jira polling.
    expect(isTicketRun(mkRun({ kind: "review", url: "https://github.com/o/r/pull/1" }))).toBe(false);
  });
});

describe("runKind", () => {
  it("treats a record with no kind as a task — every run written before this change", () => {
    // Written before `kind` existed at all: JSON.parse of an old runs/*.json file
    // never has this property.
    const legacy = { ...mkRun() } as Partial<Run>;
    delete legacy.kind;
    expect(runKind(legacy as Run)).toBe("task");
  });

  it("reads an explicit kind", () => {
    expect(runKind(mkRun({ kind: "review" }))).toBe("review");
    expect(runKind(mkRun({ kind: "explore" }))).toBe("explore");
  });

  it("falls back to task for a hand-edited nonsense kind", () => {
    expect(runKind(mkRun({ kind: "banana" as unknown as Run["kind"] }))).toBe("task");
  });
});
