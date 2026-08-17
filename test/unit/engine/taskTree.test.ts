import { describe, it, expect, vi } from "vitest";
import { buildTree, MAX_TREE_DEPTH, MAX_TREE_LEAVES } from "../../../src/engine/taskTree";

/** A fetch over a literal tree: key → its children. Absent key = no children. */
function fetchFrom(tree: Record<string, { key: string; summary: string }[]>) {
  return vi.fn(async (key: string) => tree[key] ?? []);
}

describe("buildTree", () => {
  it("returns no leaves for a ticket with no children", async () => {
    const out = await buildTree("ASM-1", fetchFrom({}));
    expect(out).toEqual({ leaves: [], dropped: [] });
  });

  it("never treats the root itself as a leaf", async () => {
    const out = await buildTree("ASM-1", fetchFrom({}));
    expect(out.leaves.map((l) => l.key)).not.toContain("ASM-1");
  });

  it("returns direct children as leaves at depth 1", async () => {
    const out = await buildTree("ASM-1", fetchFrom({
      "ASM-1": [{ key: "ASM-2", summary: "a" }, { key: "ASM-3", summary: "b" }],
    }));
    expect(out.leaves).toEqual([
      { key: "ASM-2", summary: "a", depth: 1, parentKey: "ASM-1" },
      { key: "ASM-3", summary: "b", depth: 1, parentKey: "ASM-1" },
    ]);
  });

  it("keeps only the leaves of a three-level tree, not the containers", async () => {
    const out = await buildTree("EPIC-1", fetchFrom({
      "EPIC-1": [{ key: "ST-1", summary: "story one" }, { key: "ST-2", summary: "story two" }],
      "ST-1": [{ key: "SUB-1", summary: "sub one" }],
    }));
    expect(out.leaves.map((l) => l.key)).toEqual(["ST-2", "SUB-1"]);
    expect(out.leaves.find((l) => l.key === "SUB-1")).toEqual({
      key: "SUB-1", summary: "sub one", depth: 2, parentKey: "ST-1",
    });
  });

  it("stops at maxDepth and treats the boundary nodes as leaves", async () => {
    const out = await buildTree("A", fetchFrom({
      A: [{ key: "B", summary: "b" }],
      B: [{ key: "C", summary: "c" }],
      C: [{ key: "D", summary: "d" }],
      D: [{ key: "E", summary: "e" }],
    }), { maxDepth: 2 });
    expect(out.leaves.map((l) => l.key)).toEqual(["C"]);
  });

  it("does not fetch below maxDepth", async () => {
    const fetch = fetchFrom({ A: [{ key: "B", summary: "b" }], B: [{ key: "C", summary: "c" }] });
    await buildTree("A", fetch, { maxDepth: 1 });
    expect(fetch).toHaveBeenCalledWith("A");
    expect(fetch).not.toHaveBeenCalledWith("B");
  });

  it("caps the leaf count and reports every leaf it cut", async () => {
    const kids = Array.from({ length: 5 }, (_, i) => ({ key: `K-${i}`, summary: `k${i}` }));
    const out = await buildTree("A", fetchFrom({ A: kids }), { maxLeaves: 3 });
    expect(out.leaves.map((l) => l.key)).toEqual(["K-0", "K-1", "K-2"]);
    expect(out.dropped).toEqual(["K-3", "K-4"]);
  });

  it("stops fetching once the leaf budget is spent, and reports the keys it never walked", async () => {
    // Three childless stories fill a budget of 3 at level 2; S-4's children are queued
    // for level 3 and must never be fetched. Before the budget was consulted inside the
    // walk they were, and only the truncation at the end noticed.
    const fetch = fetchFrom({
      A: [
        { key: "S-1", summary: "one" },
        { key: "S-2", summary: "two" },
        { key: "S-3", summary: "three" },
        { key: "S-4", summary: "four" },
      ],
      "S-4": [{ key: "G-1", summary: "g one" }, { key: "G-2", summary: "g two" }],
    });
    const out = await buildTree("A", fetch, { maxLeaves: 3 });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["A", "S-1", "S-2", "S-3", "S-4"]);
    expect(out.leaves.map((l) => l.key)).toEqual(["S-1", "S-2", "S-3"]);
    expect(out.dropped).toEqual(["G-1", "G-2"]);
  });

  it("abandons the walk when `cancelled` turns true, reporting the unwalked remainder", async () => {
    const fetch = fetchFrom({
      A: [{ key: "B", summary: "b" }, { key: "C", summary: "c" }, { key: "D", summary: "d" }],
      B: [{ key: "B1", summary: "b1" }],
    });
    // Cancels after the root and B have been fetched: C and D are still in the frontier,
    // B1 is already queued below it.
    const out = await buildTree("A", fetch, { cancelled: () => fetch.mock.calls.length >= 2 });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["A", "B"]);
    expect(out.leaves).toEqual([]);
    expect(out.dropped).toEqual(["C", "D", "B1"]);
  });

  it("fetches nothing at all when `cancelled` is true before the first read", async () => {
    const fetch = fetchFrom({ A: [{ key: "B", summary: "b" }] });
    const out = await buildTree("A", fetch, { cancelled: () => true });
    expect(fetch).not.toHaveBeenCalled();
    expect(out.leaves).toEqual([]);
    // The root is the only thing in the frontier, and it is what went unwalked.
    expect(out.dropped).toEqual(["A"]);
  });

  it("yields no leaf for a cycling node, and reports the repeat", async () => {
    // A → B → A. B's only child is already seen, so B is not childless-and-therefore-
    // a-leaf; the walk ends with nothing to fan out, which is the safe answer — the
    // caller then behaves exactly as it does for a ticket with no children at all.
    // Unreachable through Jira parent links; asserted so the walk cannot hang or throw
    // if a source ever does emit one.
    const out = await buildTree("A", fetchFrom({
      A: [{ key: "B", summary: "b" }],
      B: [{ key: "A", summary: "a again" }],
    }));
    expect(out.leaves).toEqual([]);
    expect(out.dropped).toEqual(["A"]);
  });

  it("reports a repeated key once per sighting and never walks it twice", async () => {
    const fetch = fetchFrom({
      A: [{ key: "B", summary: "b" }, { key: "C", summary: "c" }],
      B: [{ key: "D", summary: "d" }],
      C: [{ key: "D", summary: "d" }],
    });
    const out = await buildTree("A", fetch);
    expect(out.leaves.map((l) => l.key)).toEqual(["D"]);
    expect(out.dropped).toEqual(["D"]);
    expect(fetch).toHaveBeenCalledTimes(4); // A, B, C, D — never D twice
  });

  it("keeps the rest of the tree when one node's fetch throws, and reports that node", async () => {
    const fetch = vi.fn(async (key: string) => {
      if (key === "A") return [{ key: "B", summary: "b" }, { key: "C", summary: "c" }];
      if (key === "B") throw new Error("403");
      return [];
    });
    const out = await buildTree("A", fetch);
    // B first: the walk pushes the throwing node as it processes it, and B precedes C
    // in the frontier. C follows as an ordinary childless leaf.
    expect(out.leaves.map((l) => l.key)).toEqual(["B", "C"]);
    expect(out.dropped).toEqual(["B"]);
  });

  it("degrades to no leaves when the ROOT fetch throws", async () => {
    const out = await buildTree("A", vi.fn(async () => { throw new Error("boom"); }));
    expect(out.leaves).toEqual([]);
    expect(out.dropped).toEqual(["A"]);
  });

  it("defaults the limits to the exported constants", async () => {
    expect(MAX_TREE_DEPTH).toBe(3);
    expect(MAX_TREE_LEAVES).toBe(20);
    const kids = Array.from({ length: 25 }, (_, i) => ({ key: `K-${i}`, summary: "x" }));
    const out = await buildTree("A", fetchFrom({ A: kids }));
    expect(out.leaves).toHaveLength(20);
    expect(out.dropped).toHaveLength(5);
  });

  it("walks nothing for maxDepth 0, and never returns the root as a leaf", async () => {
    const fetch = fetchFrom({ A: [{ key: "B", summary: "b" }] });
    const out = await buildTree("A", fetch, { maxDepth: 0 });
    expect(out).toEqual({ leaves: [], dropped: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats a negative maxDepth the same as zero", async () => {
    const out = await buildTree("A", fetchFrom({ A: [{ key: "B", summary: "b" }] }), { maxDepth: -1 });
    expect(out).toEqual({ leaves: [], dropped: [] });
  });
});
