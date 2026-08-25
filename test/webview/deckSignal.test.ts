import { describe, it, expect } from "vitest";
import { cardSignal, cardActions, cardMerge } from "../../src/webview/deckSignal";
import type { CardAgent, PrEntryMap, PrFacts, RepoGit, RunStatus } from "../../src/types";

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 10, url: "https://gh/pr/10", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 3, pending: 0, failing: [] },
  review: "none", unresolved: null, mergeable: "clean", ciAdvisory: false, ...over,
});

const repo = (over: Partial<RepoGit> = {}): RepoGit => ({
  name: "svc", path: "/r/svc", branch: "feat/x", dirty: false, ahead: 0,
  added: 0, removed: 0, files: 0, ...over,
});

const status = (over: Partial<RunStatus> = {}): RunStatus => ({
  run: {
    key: "ASM-1", summary: "s", url: "https://jira/ASM-1", createdAt: 1, mode: "per-window",
    repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "feat/x" }], briefPaths: [],
  },
  column: "progress", ticketStatus: null, ticketCategory: null,
  repos: [repo()], agent: { state: "working", lastActivityMs: 1, slug: null },
  windowOpen: false, prs: {} as PrEntryMap, agents: [], shelf: "board", ...over,
});

const pr = (f: PrFacts): PrEntryMap => ({ svc: { facts: f, fetchedAt: 1 } } as PrEntryMap);

describe("cardSignal", () => {
  it("never returns more than three bits", () => {
    const bits = cardSignal(status({
      repos: [repo({ added: 9, removed: 1 }), repo({ name: "b", added: 2, removed: 2 })],
      prs: pr(facts({ ci: { passing: 0, pending: 0, failing: [{ name: "e2e", url: "" }] },
        review: "changes_requested", mergeable: "conflicting" })),
    }), null);
    expect(bits).toHaveLength(3);
  });

  it("leads a PR card with the number, then CI, then the worst merge blocker", () => {
    const bits = cardSignal(status({
      prs: pr(facts({ number: 42, ci: { passing: 1, pending: 0, failing: [{ name: "e2e", url: "" }] },
        mergeable: "conflicting" })),
    }), null);
    expect(bits).toEqual([
      { kind: "text", text: "#42", mono: true },
      { kind: "text", text: "✗ e2e", tone: "bad" },
      { kind: "text", text: "conflicts", tone: "warn" },
    ]);
  });

  it("prefers conflicts over requested changes as the third bit", () => {
    const bits = cardSignal(status({
      prs: pr(facts({ review: "changes_requested", mergeable: "conflicting" })),
    }), null);
    expect(bits[2]).toEqual({ kind: "text", text: "conflicts", tone: "warn" });
  });

  it("says changes when there is no conflict", () => {
    const bits = cardSignal(status({
      prs: pr(facts({ review: "changes_requested", mergeable: "clean" })),
    }), null);
    expect(bits[2]).toEqual({ kind: "text", text: "changes", tone: "warn" });
  });

  it("reports running checks rather than a pass count", () => {
    const bits = cardSignal(status({
      prs: pr(facts({ ci: { passing: 2, pending: 3, failing: [] } })),
    }), null);
    expect(bits[1]).toEqual({ kind: "text", text: "3 running" });
  });

  it("drops the merge bit on a merged PR — it has no blocker left", () => {
    const bits = cardSignal(status({
      prs: pr(facts({ state: "MERGED", review: "approved" })),
    }), null);
    expect(bits).toEqual([
      { kind: "text", text: "#10", mono: true },
      { kind: "text", text: "merged", tone: "ok" },
      { kind: "text", text: "approved", tone: "ok" },
    ]);
  });

  it("drops the review bit on a merged PR with no review decision", () => {
    const bits = cardSignal(status({
      prs: pr(facts({ state: "MERGED", review: "review_required" })),
    }), null);
    expect(bits).toEqual([
      { kind: "text", text: "#10", mono: true },
      { kind: "text", text: "merged", tone: "ok" },
    ]);
  });

  it("never puts diff totals on a card that has a PR", () => {
    const bits = cardSignal(status({
      repos: [repo({ added: 99, removed: 4 })], prs: pr(facts()),
    }), null);
    expect(bits.some((b) => b.kind === "diff")).toBe(false);
  });

  it("falls back to branch, diff totals and repo count without a PR", () => {
    const bits = cardSignal(status({
      repos: [repo({ added: 9, removed: 1 }), repo({ name: "b", added: 2, removed: 2 })],
    }), null);
    expect(bits).toEqual([
      { kind: "text", text: "⎇ feat/x", mono: true },
      { kind: "diff", added: 11, removed: 3 },
      // The count's tooltip is where the names go: the card says how many, and
      // hovering says which, one repo per line.
      { kind: "text", text: "2 repos", title: "svc\nb" },
    ]);
  });

  it("counts agents instead of repos when there is only one repo", () => {
    const agents = [
      { session: { pid: 1, sessionId: "a", cwd: "/r/svc", startedAt: 0, name: "a" },
        activity: { state: "working", lastActivityMs: 1, slug: null } },
      { session: { pid: 2, sessionId: "b", cwd: "/r/svc", startedAt: 0, name: "b" },
        activity: { state: "idle", lastActivityMs: 1, slug: null } },
    ] as CardAgent[];
    const bits = cardSignal(status({ repos: [repo({ added: 1, removed: 1 })], agents }), null);
    expect(bits[2]).toEqual({ kind: "text", text: "2 sessions" });
  });

  it("omits the diff bit when nothing changed", () => {
    const bits = cardSignal(status(), null);
    expect(bits).toEqual([{ kind: "text", text: "⎇ feat/x", mono: true }]);
  });

  it("reads the agent's own repo for the branch, not repos[0]", () => {
    const agent = {
      session: { pid: 1, sessionId: "a", cwd: "/r/b", startedAt: 0, name: "a" },
      activity: { state: "working", lastActivityMs: 1, slug: null }, repo: "b",
    } as CardAgent;
    const bits = cardSignal(status({
      run: {
        ...status().run,
        repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "feat/x" },
                { name: "b", path: "/r/b", isGit: true, branch: "feat/other" }],
      },
    }), agent);
    expect(bits[0]).toEqual({ kind: "text", text: "⎇ feat/other", mono: true });
  });

  it("picks the failing PR when several repos have one", () => {
    const prs = {
      alpha: { facts: facts({ number: 1 }), fetchedAt: 1 },
      beta: { facts: facts({ number: 2, ci: { passing: 0, pending: 0, failing: [{ name: "unit", url: "" }] } }), fetchedAt: 1 },
    } as PrEntryMap;
    const bits = cardSignal(status({ prs }), null);
    expect(bits[0]).toEqual({ kind: "text", text: "#2", mono: true });
  });

  it("picks the alphabetically-first PR by repo name when all have no failures", () => {
    const prs = {
      zeta: { facts: facts({ number: 99 }), fetchedAt: 1 },
      alpha: { facts: facts({ number: 11 }), fetchedAt: 1 },
    } as PrEntryMap;
    const bits = cardSignal(status({ prs }), null);
    // Should pick alpha (alphabetically first), not zeta (insertion order first)
    expect(bits[0]).toEqual({ kind: "text", text: "#11", mono: true });
  });
});

describe("cardActions", () => {
  it("returns nothing for a run with no PR", () => {
    expect(cardActions(status())).toEqual([]);
  });

  it("returns nothing for a healthy open PR", () => {
    expect(cardActions(status({ prs: pr(facts({ review: "approved", mergeable: "clean" })) }))).toEqual([]);
  });

  it("names the failing checks and offers Fix CI", () => {
    const acts = cardActions(status({
      prs: pr(facts({ ci: { passing: 1, pending: 0, failing: [{ name: "integration", url: "" }, { name: "lint", url: "" }] } })),
    }));
    expect(acts).toHaveLength(1);
    expect(acts[0].label).toBe("Fix CI");
    expect(acts[0].reason).toBe("ci");
    expect(acts[0].text).toContain("integration");
    expect(acts[0].text).toContain("lint");
    expect(acts[0].detail).toBe("integration, lint");
  });

  // Mirrors prSignals' `blocked` rule: an advisory failure does not block a
  // merge, so it must not put a Fix CI button on the card either.
  it("ignores an advisory CI failure", () => {
    const acts = cardActions(status({
      prs: pr(facts({ ciAdvisory: true, ci: { passing: 0, pending: 0, failing: [{ name: "flaky", url: "" }] } })),
    }));
    expect(acts).toEqual([]);
  });

  it("offers Resolve conflict for a conflicting PR", () => {
    const acts = cardActions(status({ prs: pr(facts({ mergeable: "conflicting" })) }));
    expect(acts.map((a) => a.reason)).toEqual(["conflict"]);
    expect(acts[0].label).toBe("Resolve conflict");
  });

  it("offers Address review when changes are requested", () => {
    const acts = cardActions(status({ prs: pr(facts({ review: "changes_requested" })) }));
    expect(acts.map((a) => a.reason)).toEqual(["review"]);
    expect(acts[0].label).toBe("Address review");
  });

  // The card the whole feature exists for: one "Address PR" cannot name which of
  // three problems it will work on.
  it("returns all three, worst first, when a PR has every problem at once", () => {
    const acts = cardActions(status({
      prs: pr(facts({
        ci: { passing: 0, pending: 0, failing: [{ name: "integration", url: "" }] },
        mergeable: "conflicting", review: "changes_requested",
      })),
    }));
    expect(acts.map((a) => a.reason)).toEqual(["ci", "conflict", "review"]);
  });

  // GitHub stops computing mergeability once a PR closes, so a merged PR's
  // "conflicting" is stale — and there is nothing to act on regardless.
  it("returns nothing for a merged PR, whatever its stale fields say", () => {
    expect(cardActions(status({
      prs: pr(facts({ state: "MERGED", mergeable: "conflicting", review: "changes_requested" })),
    }))).toEqual([]);
  });

  it("returns nothing for a draft PR — it is not asking for anything yet", () => {
    expect(cardActions(status({
      prs: pr(facts({ isDraft: true, ci: { passing: 0, pending: 0, failing: [{ name: "lint", url: "" }] } })),
    }))).toEqual([]);
  });

  it("reads the same lead PR as cardSignal does", () => {
    const prs = {
      zzz: { facts: facts({ number: 1, mergeable: "clean", review: "approved" }), fetchedAt: 1 },
      aaa: { facts: facts({ number: 2, ci: { passing: 0, pending: 0, failing: [{ name: "e2e", url: "" }] } }), fetchedAt: 1 },
    } as unknown as PrEntryMap;
    const acts = cardActions(status({ prs }));
    const bits = cardSignal(status({ prs }), null);
    expect(acts[0].reason).toBe("ci");
    // cardSignal leads with the same PR's number, so the two can never disagree.
    expect(bits[0]).toMatchObject({ text: "#2" });
  });
});

describe("cardMerge", () => {
  const green = () => facts({ number: 124, url: "https://gh/pr/124", review: "approved", unresolved: 0 });

  it("names the PR when everything is green and readable", () => {
    expect(cardMerge(status({ prs: pr(green()) }))).toEqual({
      repo: "svc", number: 124, url: "https://gh/pr/124",
    });
  });

  it("is null when there is no PR at all", () => {
    expect(cardMerge(status())).toBeNull();
  });

  it("is null when the thread count is unreadable", () => {
    expect(cardMerge(status({ prs: pr(facts({ review: "approved", unresolved: null })) }))).toBeNull();
  });

  // The two never appear together, and this is the assertion that pins it: a card
  // showing both "Fix CI" and "Merge" would be the board's loudest contradiction.
  it("never coexists with a problem row", () => {
    const red = facts({ review: "approved", unresolved: 0, ci: { passing: 1, pending: 0, failing: [{ name: "lint", url: "" }] } });
    const s = status({ prs: pr(red) });
    expect(cardActions(s).length).toBeGreaterThan(0);
    expect(cardMerge(s)).toBeNull();
  });
});
