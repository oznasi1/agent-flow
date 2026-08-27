import { describe, it, expect } from "vitest";
import { projectCards } from "../../src/webview/deckCards";
import type { AgentActivity, CardAgent, PrEntryMap, PrFacts, RunStatus } from "../../src/types";

const mkAgent = (sessionId: string, state: AgentActivity["state"], repo = "api"): CardAgent => ({
  session: { pid: 1, sessionId, cwd: `/r/${repo}`, startedAt: 1, name: sessionId },
  activity: { state, lastActivityMs: 100, slug: null },
  repo,
});

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "u", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 1, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});
const prs = (f: PrFacts): PrEntryMap => ({ api: { facts: f, fetchedAt: 0 } });

const mkStatus = (over: Partial<RunStatus> = {}): RunStatus => ({
  run: { key: "PROJ-1", summary: "s", url: "https://jira/browse/PROJ-1", createdAt: 1,
    mode: "per-window", repos: [{ name: "api", path: "/r/api", isGit: true, branch: "b" }], briefPaths: [] },
  column: "progress", ticketStatus: "In Progress", ticketCategory: "indeterminate",
  repos: [{ name: "api", path: "/r/api", branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 }],
  agent: { state: "unknown", lastActivityMs: null, slug: null },
  windowOpen: false, prs: {}, agents: [], shelf: "board", ...over,
});

describe("projectCards", () => {
  it("makes one card per agent when each lands in a different column", () => {
    const cards = projectCards([mkStatus({ agents: [mkAgent("s1", "working"), mkAgent("s2", "needs-you")] })]);
    expect(cards.map((c) => c.id)).toEqual(["a:s1", "a:s2"]);
    expect(cards.every((c) => c.agent !== null)).toBe(true);
    expect(cards.map((c) => c.agents)).toEqual([[cards[0].agent], [cards[1].agent]]);
  });

  it("merges agents that land in the same column into one card", () => {
    const s1 = mkAgent("s1", "working");
    const s2 = mkAgent("s2", "idle");
    const cards = projectCards([mkStatus({ agents: [s1, s2] })]);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("g:PROJ-1:progress");
    expect(cards[0].agent).toBeNull();
    expect(cards[0].agents).toEqual([s1, s2]);
  });

  it("splits one run across columns by each agent's own state", () => {
    const cards = projectCards([mkStatus({ agents: [mkAgent("s1", "working"), mkAgent("s2", "needs-you")] })]);
    expect(cards.map((c) => c.column)).toEqual(["progress", "needs"]);
  });

  it("still lets a blocked PR outrank a working agent, per run — into In review now", () => {
    const cards = projectCards([mkStatus({
      agents: [mkAgent("s1", "working")],
      prs: prs(facts({ mergeable: "conflicting" })),
    })]);
    expect(cards[0].column).toBe("review");
  });

  it("makes one parked card for an agentless run, keeping the host's own column", () => {
    const cards = projectCards([mkStatus({ agents: [], column: "review" })]);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("p:PROJ-1");
    expect(cards[0].agent).toBeNull();
    expect(cards[0].column).toBe("review");
  });

  it("never collides an agent card with a parked card", () => {
    const parked = mkStatus({ run: { ...mkStatus().run, key: "s1" }, agents: [] });
    const live = mkStatus({ agents: [mkAgent("s1", "working")] });
    const ids = projectCards([parked, live]).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries the owning status onto every card so the ticket and PR still render", () => {
    const s = mkStatus({ agents: [mkAgent("s1", "working"), mkAgent("s2", "idle")] });
    expect(projectCards([s]).every((c) => c.status === s)).toBe(true);
  });

  it("returns nothing for no runs", () => {
    expect(projectCards([])).toEqual([]);
  });
});

describe("projectCards and the merge column", () => {
  it("lands an idle agent on an approved, green PR in the merge column's ready lane", () => {
    const cards = projectCards([mkStatus({
      agents: [mkAgent("s1", "idle")],
      prs: prs(facts({ review: "approved" })),
    })]);
    expect(cards.map((c) => [c.column, c.lane])).toEqual([["merge", "ready"]]);
  });

  it("keeps a PR nobody has approved in In review, waiting on them", () => {
    const cards = projectCards([mkStatus({ agents: [mkAgent("s1", "idle")], prs: prs(facts()) })]);
    expect(cards.map((c) => [c.column, c.lane])).toEqual([["review", "waiting"]]);
  });

  it("takes an agent still working on an approved PR to the merge too", () => {
    // The one bucketing this migration deliberately changed: the merge outranks
    // the live agent signal now that it has a column to be seen in.
    const cards = projectCards([mkStatus({
      agents: [mkAgent("s1", "working"), mkAgent("s2", "needs-you")],
      prs: prs(facts({ review: "approved" })),
    })]);
    expect(cards.map((c) => c.column).sort()).toEqual(["merge", "needs"]);
  });

  it("puts a merged run in the merged lane, wrap-up agent and all", () => {
    const cards = projectCards([mkStatus({
      agents: [mkAgent("s1", "working")], prs: prs(facts({ state: "MERGED" })),
    })]);
    expect(cards.map((c) => [c.column, c.lane])).toEqual([["merge", "merged"]]);
  });

  it("gives a done ticket that never merged no merge column at all", () => {
    // Nothing landed, so there is no wrap-up: this run is on the board only while
    // an agent is open in it, and `shelfFor` closes it the moment that stops.
    const cards = projectCards([mkStatus({ agents: [mkAgent("s2", "idle")], ticketCategory: "done" })]);
    expect(cards.map((c) => [c.column, c.lane])).toEqual([["progress", "parked"]]);
  });

  it("lanes a working agent into the working lane and a quiet one into parked", () => {
    const live = projectCards([mkStatus({ agents: [mkAgent("s1", "working")] })]);
    expect(live.map((c) => [c.column, c.lane])).toEqual([["progress", "working"]]);
    const quiet = projectCards([mkStatus({ agents: [mkAgent("s1", "idle")] })]);
    expect(quiet.map((c) => [c.column, c.lane])).toEqual([["progress", "parked"]]);
  });

  it("lanes a mixed progress card as working — one live agent makes the card live", () => {
    // A working and an idle agent share the progress column, so they share one
    // card. Reading the lane off `agents[0]` would file that card under whichever
    // agent the host happened to list first.
    const cards = projectCards([mkStatus({ agents: [mkAgent("s1", "idle"), mkAgent("s2", "working")] })]);
    expect(cards.map((c) => [c.id, c.lane])).toEqual([["g:PROJ-1:progress", "working"]]);
  });

  it("parks an agentless run rather than leaving it out of every lane", () => {
    const cards = projectCards([mkStatus({ agents: [], column: "progress" })]);
    expect(cards.map((c) => [c.id, c.column, c.lane])).toEqual([["p:PROJ-1", "progress", "parked"]]);
  });

  it("lanes a red PR under a working agent as fixes needed", () => {
    const cards = projectCards([mkStatus({
      agents: [mkAgent("s1", "working")],
      prs: prs(facts({ ci: { passing: 0, pending: 0, failing: [{ name: "build", url: "" }] } })),
    })]);
    expect(cards.map((c) => [c.column, c.lane])).toEqual([["review", "fixes"]]);
  });

  it("lanes a parked card from the host's column and the run's own PRs", () => {
    const cards = projectCards([mkStatus({ agents: [], column: "merge", prs: prs(facts({ state: "MERGED" })) })]);
    expect(cards.map((c) => [c.id, c.column, c.lane])).toEqual([["p:PROJ-1", "merge", "merged"]]);
  });
});
