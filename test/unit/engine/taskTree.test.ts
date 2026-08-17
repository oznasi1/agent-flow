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

  it("breaks a cycle and reports the repeat", async () => {
    const out = await buildTree("A", fetchFrom({
      A: [{ key: "B", summary: "b" }],
      B: [{ key: "A", summary: "a again" }],
    }));
    expect(out.leaves.map((l) => l.key)).toEqual(["B"]);
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
});
