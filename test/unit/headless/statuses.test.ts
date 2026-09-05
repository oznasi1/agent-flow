import { describe, it, expect, vi } from "vitest";
import { headlessStatuses, refreshWatchedPrs } from "../../../src/headless/statuses";
import { Flow, emptyFlow } from "../../../src/engine/orchestrator/model";
import { PrEntryMap, Run } from "../../../src/types";

const run = (key: string, over: Partial<Run> = {}): Run => ({
  key, summary: "s", url: `https://j/browse/${key}`, createdAt: 1, mode: "multiroot",
  repos: [{ name: "aws-ops", path: "/nonexistent/aws-ops", isGit: false }], briefPaths: [], ...over,
});

describe("headlessStatuses", () => {
  it("builds one status per tracked run with no ticket, and skips review runs", () => {
    const out = headlessStatuses({
      runs: [run("PROJ-1"), run("PR-9", { kind: "review" })],
      sessions: { sessions: [], readable: true },
      projectsRoot: "/nonexistent/projects", nowMs: 1_000,
      prEntries: () => ({}),
      sessionActivity: () => ({ state: "unknown", lastActivityMs: null, slug: null }),
    });
    expect(out.map((s) => s.run.key)).toEqual(["PROJ-1"]);
    expect(out[0].ticketStatus).toBeNull();
    expect(out[0].ticketCategory).toBeNull();
    expect(out[0].agents).toEqual([]);
  });

  it("hands the cached PR facts for the run to the status", () => {
    const prs: PrEntryMap = { "aws-ops": { facts: null, fetchedAt: 5 } };
    const out = headlessStatuses({
      runs: [run("PROJ-1")], sessions: { sessions: [], readable: true }, projectsRoot: "/n", nowMs: 1_000,
      prEntries: (key) => (key === "PROJ-1" ? prs : ({} as PrEntryMap)),
      sessionActivity: () => ({ state: "unknown", lastActivityMs: null, slug: null }),
    });
    expect(out[0].prs).toEqual(prs);
  });
});

describe("refreshWatchedPrs", () => {
  const armedWatching = (runKey: string): Flow => ({
    ...emptyFlow("f1", "f", 0), armed: true,
    nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey, repo: "aws-ops" }],
  });
  const base = () => {
    const writes: [string, string, unknown][] = [];
    const fetch = vi.fn(async () => ({ ok: true as const, facts: null }));
    return {
      writes, fetch,
      deps: {
        nowMs: 10_000, ttlMs: 1_000,
        prEligible: () => true,
        fetch,
        writePrEntry: (key: string, repo: string, entry: unknown) => { writes.push([key, repo, entry]); },
        log: () => {},
      },
    };
  };

  it("fetches only runs an ARMED flow watches, and only stale entries", async () => {
    const { deps, fetch, writes } = base();
    const n = await refreshWatchedPrs({
      ...deps,
      runs: [run("PROJ-1"), run("PROJ-2"), run("PROJ-3")],
      flows: [armedWatching("PROJ-1"), { ...armedWatching("PROJ-2"), armed: false }],
      prEntries: (key) => (key === "PROJ-1" ? ({} as PrEntryMap) : { "aws-ops": { facts: null, fetchedAt: 9_900 } }),
    });
    expect(n).toBe(1);
    expect(fetch).toHaveBeenCalledWith("/nonexistent/aws-ops", null, "PROJ-1");
    expect(writes).toEqual([["PROJ-1", "aws-ops", { facts: null, fetchedAt: 10_000 }]]);
  });

  it("skips a fresh entry and a repo that cannot own a PR", async () => {
    const { deps, fetch } = base();
    const n = await refreshWatchedPrs({
      ...deps, runs: [run("PROJ-1")], flows: [armedWatching("PROJ-1")],
      prEntries: () => ({ "aws-ops": { facts: null, fetchedAt: 9_900 } }),
    });
    expect(n).toBe(0);
    const m = await refreshWatchedPrs({
      ...deps, prEligible: () => false, runs: [run("PROJ-1")], flows: [armedWatching("PROJ-1")], prEntries: () => ({}),
    });
    expect(m).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stamps an error entry, keeping the previous facts, when the forge fails or throws", async () => {
    const { deps, writes } = base();
    const prev = { number: 1 } as unknown as NonNullable<PrEntryMap[string]["facts"]>;
    await refreshWatchedPrs({
      ...deps, fetch: async () => { throw new Error("gh down"); },
      runs: [run("PROJ-1")], flows: [armedWatching("PROJ-1")],
      prEntries: () => ({ "aws-ops": { facts: prev, fetchedAt: 1 } }),
    });
    expect(writes).toEqual([["PROJ-1", "aws-ops", { facts: prev, fetchedAt: 10_000, error: true }]]);
  });
});
