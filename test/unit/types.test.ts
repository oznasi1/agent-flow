import { describe, it, expect } from "vitest";
import { isTicketRun, runKind, ticketKeyFor } from "../../src/types";
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

describe("ticketKeyFor", () => {
  it("is a no-op for a normal task run — the key already equals the url tail", () => {
    expect(ticketKeyFor(mkRun({ key: "ASM-1", url: "https://jira/browse/ASM-1" }))).toBe("ASM-1");
  });

  it("derives the real ticket from the url when the record's own key is a place-hash", () => {
    // Exactly what Track it writes for case 3: a tracked run already owned the
    // inferred key, so the record is saved under its local place-hash instead —
    // the ticket survives only in the url.
    expect(ticketKeyFor(mkRun({ key: "local-centaur-1a2b3c4d", url: "https://jira/browse/ASM-5641" }))).toBe("ASM-5641");
  });

  it("falls back to the key for an Explore run, which has no url", () => {
    expect(ticketKeyFor(mkRun({ key: "explore-retry-logic", url: "" }))).toBe("explore-retry-logic");
  });

  it("falls back to the key for a review run's PR url — no /browse/ to find", () => {
    expect(ticketKeyFor(mkRun({ key: "review-aws-ops-8491", url: "https://github.com/o/r/pull/8491", kind: "review" }))).toBe(
      "review-aws-ops-8491",
    );
  });

  it("survives a record with no url field at all", () => {
    const legacy = { ...mkRun() } as Partial<Run>;
    delete legacy.url;
    expect(ticketKeyFor(legacy as Run)).toBe(legacy.key);
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
