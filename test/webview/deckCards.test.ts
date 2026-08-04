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
  run: { key: "ASM-1", summary: "s", url: "https://jira/browse/ASM-1", createdAt: 1,
    mode: "per-window", repos: [{ name: "api", path: "/r/api", isGit: true, branch: "b" }], briefPaths: [] },
  column: "progress", jiraStatus: "In Progress", jiraCategory: "indeterminate",
  repos: [{ name: "api", path: "/r/api", branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 }],
  agent: { state: "unknown", lastActivityMs: null, slug: null },
  windowOpen: false, prs: {}, agents: [], ...over,
});

describe("projectCards", () => {
  it("makes one card per agent, keyed by session id", () => {
    const cards = projectCards([mkStatus({ agents: [mkAgent("s1", "working"), mkAgent("s2", "idle")] })]);
    expect(cards.map((c) => c.id)).toEqual(["a:s1", "a:s2"]);
    expect(cards.every((c) => c.agent !== null)).toBe(true);
  });

  it("splits one run across columns by each agent's own state", () => {
    const cards = projectCards([mkStatus({ agents: [mkAgent("s1", "working"), mkAgent("s2", "needs-you")] })]);
    expect(cards.map((c) => c.column)).toEqual(["progress", "needs"]);
  });

  it("still lets a blocked PR outrank a working agent, per run", () => {
    const cards = projectCards([mkStatus({
      agents: [mkAgent("s1", "working")],
      prs: prs(facts({ mergeable: "conflicting" })),
    })]);
    expect(cards[0].column).toBe("needs");
  });

  it("makes one parked card for an agentless run, keeping the host's own column", () => {
    const cards = projectCards([mkStatus({ agents: [], column: "review" })]);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("p:ASM-1");
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
