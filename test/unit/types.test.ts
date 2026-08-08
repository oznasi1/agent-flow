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
  // ticketKeyFor's own job is only to defer to whichever connector's `keyFromUrl`
  // it is given, and fall back to run.key when that returns null — the /browse/
  // parsing itself now belongs to the Jira connector and is pinned there
  // (tasks/jira/connector.test.ts). This fixture mirrors that parsing so these
  // cases still read as "a task run whose url a connector recognises" rather
  // than exercising a stub that always says no.
  const jira = {
    keyFromUrl: (u: string): string | null => {
      const i = u.indexOf("/browse/");
      return i < 0 ? null : u.slice(i + 8) || null;
    },
  };

  it("is a no-op for a normal task run — the key already equals the url tail", () => {
    expect(ticketKeyFor(mkRun({ key: "ASM-1", url: "https://jira/browse/ASM-1" }), jira)).toBe("ASM-1");
  });

  it("derives the real ticket from the url when the record's own key is a place-hash", () => {
    // Exactly what Track it writes for case 3: a tracked run already owned the
    // inferred key, so the record is saved under its local place-hash instead —
    // the ticket survives only in the url.
    expect(ticketKeyFor(mkRun({ key: "local-centaur-1a2b3c4d", url: "https://jira/browse/ASM-5641" }), jira)).toBe("ASM-5641");
  });

  it("falls back to the key for an Explore run, which has no url", () => {
    expect(ticketKeyFor(mkRun({ key: "explore-retry-logic", url: "" }), jira)).toBe("explore-retry-logic");
  });

  it("falls back to the key for a review run's PR url — no /browse/ to find", () => {
    expect(ticketKeyFor(mkRun({ key: "review-aws-ops-8491", url: "https://github.com/o/r/pull/8491", kind: "review" }), jira)).toBe(
      "review-aws-ops-8491",
    );
  });

  it("survives a record with no url field at all", () => {
    const legacy = { ...mkRun() } as Partial<Run>;
    delete legacy.url;
    expect(ticketKeyFor(legacy as Run, jira)).toBe(legacy.key);
  });

  it("falls back to the record key for a run from a source the connector does not recognise", () => {
    // A record another source wrote (or a connector switch since): the given
    // connector's keyFromUrl finds nothing, so the record's own key — never
    // mis-parsed against a foreign url shape — is what gets polled.
    expect(ticketKeyFor(mkRun({ key: "FX-1", url: "https://fixture.test/t/FX-1" }), jira)).toBe("FX-1");
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

  it("keeps a notepad run's kind rather than clamping it to task", () => {
    const run = { key: "notepad-x", summary: "s", url: "", createdAt: 1, kind: "notepad",
      mode: "per-window", repos: [], briefPaths: [] } as unknown as Run;
    expect(runKind(run)).toBe("notepad");
  });

  it("still clamps an unknown kind to task", () => {
    const run = { key: "k", summary: "s", url: "", createdAt: 1, kind: "nonsense",
      mode: "per-window", repos: [], briefPaths: [] } as unknown as Run;
    expect(runKind(run)).toBe("task");
  });
});
