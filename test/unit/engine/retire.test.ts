import { describe, it, expect } from "vitest";
import { retireVerdict, RetireInput } from "../../../src/engine/retire";
import { PrEntryMap, PrFacts, RepoGit, Run } from "../../../src/types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

const run = (over: Partial<Run> = {}): Run => ({
  key: "ASM-1", summary: "s", url: "https://jira/browse/ASM-1", createdAt: NOW - 30 * DAY,
  mode: "per-window", repos: [{ name: "api", path: "/r/api", isGit: true, branch: "ASM-1-x" }],
  briefPaths: [], ...over,
});
const repo = (over: Partial<RepoGit> = {}): RepoGit => ({
  name: "api", path: "/r/api", branch: "ASM-1-x", dirty: false, ahead: 0,
  added: 0, removed: 0, files: 0, ...over,
});
const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 1, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});
const prs = (f: PrFacts | null): PrEntryMap => ({ api: { facts: f, fetchedAt: NOW } });

const input = (over: Partial<RetireInput> = {}): RetireInput => ({
  run: run(), repos: [repo()], ticketCategory: "indeterminate", prs: {},
  hasLiveSession: false, prsAuthoritative: true,
  finishedAfterMs: 24 * HOUR, abandonedAfterMs: 7 * DAY, nowMs: NOW,
  shelf: "board", closedAfterMs: 24 * HOUR,
  exists: () => true, ...over,
});

describe("rule 2b — closed", () => {
  it("stamps closedAt the first time a run shelves as closed", () => {
    expect(retireVerdict(input({ shelf: "closed" })))
      .toEqual({ action: "stampClosed", closedAt: NOW });
  });

  it("keeps a stamped run until its window elapses", () => {
    expect(retireVerdict(input({ shelf: "closed", run: run({ closedAt: NOW - 1 * HOUR }) })))
      .toEqual({ action: "keep" });
  });

  it("retires once the window elapses", () => {
    expect(retireVerdict(input({ shelf: "closed", run: run({ closedAt: NOW - 25 * HOUR }) })))
      .toEqual({ action: "retire", reason: "closed" });
  });

  it("retires exactly on the boundary, not a tick after it", () => {
    expect(retireVerdict(input({ shelf: "closed", run: run({ closedAt: NOW - 24 * HOUR }) })))
      .toEqual({ action: "retire", reason: "closed" });
  });

  it("retires on sight when the window is zero", () => {
    expect(retireVerdict(input({ shelf: "closed", closedAfterMs: 0 })))
      .toEqual({ action: "retire", reason: "closed" });
  });

  it("unstamps a run that came back to the board", () => {
    expect(retireVerdict(input({ shelf: "board", run: run({ closedAt: NOW - 1 * HOUR }) })))
      .toEqual({ action: "unstampClosed" });
  });

  it("never fires for a run with uncommitted work, however long it has been closed", () => {
    // The veto is the safety property: a record is the only pointer to its worktree.
    expect(retireVerdict(input({
      shelf: "closed", run: run({ closedAt: NOW - 40 * HOUR }), repos: [repo({ dirty: true })],
    }))).toEqual({ action: "keep" });
  });

  it("never fires for a run with unpushed commits", () => {
    expect(retireVerdict(input({
      shelf: "closed", run: run({ closedAt: NOW - 40 * HOUR }), repos: [repo({ ahead: 2 })],
    }))).toEqual({ action: "keep" });
  });

  it("keeps a non-owner run with somebody working in its directory", () => {
    // shelf is ownership-scoped (one card per agent); the retire veto is not
    // (never delete a record out from under a live session). Both hold at once:
    // the run sits in the strip and refuses to retire.
    expect(retireVerdict(input({
      shelf: "closed", hasLiveSession: true, run: run({ closedAt: NOW - 40 * HOUR }),
    }))).toEqual({ action: "unstampClosed" });
  });

  it("lets rule 2 win for landed work, which belongs in Done not the strip", () => {
    expect(retireVerdict(input({
      shelf: "board", prs: prs(facts({ state: "MERGED" })), finishedAfterMs: 24 * HOUR,
    }))).toEqual({ action: "stamp", finishedAt: NOW });
  });
});

describe("rule 1 — unreachable", () => {
  it("retires a run whose every repo path is gone", () => {
    expect(retireVerdict(input({ exists: () => false })))
      .toEqual({ action: "retire", reason: "unreachable" });
  });

  it("keeps a run with one surviving repo", () => {
    const r = run({ repos: [
      { name: "api", path: "/r/api", isGit: true, branch: "b" },
      { name: "web", path: "/r/web", isGit: true, branch: "b" },
    ] });
    expect(retireVerdict(input({ run: r, exists: (p) => p === "/r/web" })).action).toBe("keep");
  });

  it("never fires for a run with no repos at all", () => {
    expect(retireVerdict(input({ run: run({ repos: [] }), exists: () => false })).action).toBe("keep");
  });

  it("ignores workspaceFile — several runs share one, so its survival proves nothing", () => {
    const r = run({ workspaceFile: "/r/both.code-workspace" });
    expect(retireVerdict(input({ run: r, exists: (p) => p === "/r/both.code-workspace" })))
      .toEqual({ action: "retire", reason: "unreachable" });
  });

  it("fires even with dirty work — a deleted directory has none to lose", () => {
    expect(retireVerdict(input({ repos: [repo({ dirty: true })], exists: () => false })))
      .toEqual({ action: "retire", reason: "unreachable" });
  });
});

describe("rule 2 — finished", () => {
  it("stamps rather than retires the first time it sees a merged run", () => {
    expect(retireVerdict(input({ prs: prs(facts({ state: "MERGED" })) })))
      .toEqual({ action: "stamp", finishedAt: NOW });
  });

  it("keeps a stamped run until the window elapses", () => {
    const r = run({ finishedAt: NOW - 2 * HOUR });
    expect(retireVerdict(input({ run: r, prs: prs(facts({ state: "MERGED" })) })).action).toBe("keep");
  });

  it("retires once the window has elapsed", () => {
    const r = run({ finishedAt: NOW - 25 * HOUR });
    expect(retireVerdict(input({ run: r, prs: prs(facts({ state: "MERGED" })) })))
      .toEqual({ action: "retire", reason: "finished" });
  });

  it("retires immediately, without stamping, when the window is zero", () => {
    expect(retireVerdict(input({ prs: prs(facts({ state: "MERGED" })), finishedAfterMs: 0 })))
      .toEqual({ action: "retire", reason: "finished" });
  });

  it("counts a Jira-done run with no open PR as finished", () => {
    expect(retireVerdict(input({ ticketCategory: "done", prs: {} })))
      .toEqual({ action: "stamp", finishedAt: NOW });
  });

  it("spares a Jira-done run whose PR is still open", () => {
    expect(retireVerdict(input({ ticketCategory: "done", prs: prs(facts()) })).action).toBe("keep");
  });

  it("spares a Jira-done run whose PR is still a draft — a draft is unmerged work", () => {
    expect(retireVerdict(input({ ticketCategory: "done", prs: prs(facts({ isDraft: true })) })).action).toBe("keep");
  });

  it("clears the stamp when the run stops being finished", () => {
    const r = run({ finishedAt: NOW - 2 * HOUR });
    expect(retireVerdict(input({ run: r, ticketCategory: "indeterminate", prs: prs(facts()) })))
      .toEqual({ action: "unstamp" });
  });

  it("fails closed with no Jira and no PR facts: nothing stamped, nothing retired", () => {
    expect(retireVerdict(input({ ticketCategory: null, prs: {}, prsAuthoritative: false,
      run: run({ createdAt: NOW - DAY }) })).action).toBe("keep");
  });
});

describe("the veto", () => {
  it("blocks a merged run with uncommitted work", () => {
    expect(retireVerdict(input({ repos: [repo({ dirty: true })], prs: prs(facts({ state: "MERGED" })) })).action)
      .toBe("keep");
  });

  it("blocks a merged run with unpushed commits", () => {
    expect(retireVerdict(input({ repos: [repo({ ahead: 2 })], prs: prs(facts({ state: "MERGED" })) })).action)
      .toBe("keep");
  });

  it("blocks an abandoned run with unpushed commits", () => {
    const r = run({ url: "", createdAt: NOW - 30 * DAY });
    expect(retireVerdict(input({ run: r, repos: [repo({ ahead: 1 })], ticketCategory: null })).action).toBe("keep");
  });
});

describe("rule 3 — abandoned", () => {
  const abandoned = (over: Partial<RetireInput> = {}) =>
    retireVerdict(input({ run: run({ url: "", createdAt: NOW - 30 * DAY }), ticketCategory: null, ...over }));

  it("retires a ticketless, PR-less, clean, old run", () => {
    expect(abandoned()).toEqual({ action: "retire", reason: "abandoned" });
  });

  it("keeps it inside the window", () => {
    expect(abandoned({ abandonedAfterMs: 60 * DAY }).action).toBe("keep");
  });

  it("is disabled by a zero window", () => {
    expect(abandoned({ abandonedAfterMs: 0 }).action).toBe("keep");
  });

  it("is skipped when the prs map is not authoritative", () => {
    expect(abandoned({ prsAuthoritative: false }).action).toBe("keep");
  });

  it("spares a run that still has a ticket", () => {
    expect(retireVerdict(input({ run: run({ createdAt: NOW - 30 * DAY }), ticketCategory: null })).action)
      .toBe("keep");
  });

  it("spares a run that has a PR entry", () => {
    expect(abandoned({ prs: prs(facts()) }).action).toBe("keep");
  });
});

describe("a live session", () => {
  it("blocks every rule, even an unreachable run", () => {
    expect(retireVerdict(input({ hasLiveSession: true, exists: () => false })).action).toBe("keep");
  });

  it("clears a stamp — work with somebody in it is not over", () => {
    const r = run({ finishedAt: NOW - 25 * HOUR });
    expect(retireVerdict(input({ run: r, hasLiveSession: true, prs: prs(facts({ state: "MERGED" })) })))
      .toEqual({ action: "unstamp" });
  });
});
