import { describe, it, expect } from "vitest";
import { sortBySavedOrder, applyReorder, pruneOrder } from "../../../src/engine/order";
import { mkTask } from "../../_helpers/factories";

const tasks = (...keys: string[]) => keys.map((k) => mkTask({ key: k }));
const order = (ts: { key: string }[]) => ts.map((t) => t.key);

describe("sortBySavedOrder", () => {
  it("ranks known keys first, in saved order", () => {
    expect(order(sortBySavedOrder(tasks("A", "B", "C"), ["C", "A"]))).toEqual(["C", "A", "B"]);
  });

  it("puts unranked keys at the bottom, preserving server order", () => {
    expect(order(sortBySavedOrder(tasks("A", "B", "C", "D"), ["C"]))).toEqual(["C", "A", "B", "D"]);
  });

  it("is a no-op when saved order is empty", () => {
    expect(order(sortBySavedOrder(tasks("A", "B", "C"), []))).toEqual(["A", "B", "C"]);
  });

  it("ignores saved keys not present in the task list", () => {
    expect(order(sortBySavedOrder(tasks("A", "B"), ["Z", "B", "A"]))).toEqual(["B", "A"]);
  });

  it("returns an empty list for no tasks", () => {
    expect(sortBySavedOrder([], ["A", "B"])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = tasks("A", "B", "C");
    const copy = [...input];
    sortBySavedOrder(input, ["C", "A"]);
    expect(input).toEqual(copy);
  });
});

describe("applyReorder", () => {
  it("adopts the visible order when saved order is empty", () => {
    expect(applyReorder([], ["B", "A", "C"], new Set(["B", "A", "C"]))).toEqual(["B", "A", "C"]);
  });

  it("reorders a fully visible list", () => {
    expect(applyReorder(["A", "B", "C"], ["C", "B", "A"], new Set(["A", "B", "C"]))).toEqual(["C", "B", "A"]);
  });

  it("keeps the absolute slot of a key hidden by the size lens", () => {
    // saved A,B,C,D; B hidden (visible A,C,D); user drags D to the top.
    expect(applyReorder(["A", "B", "C", "D"], ["D", "A", "C"], new Set(["D", "A", "C"]))).toEqual([
      "D", "B", "A", "C",
    ]);
  });

  it("honors a dragged-in new key's position while a hidden key keeps its slot", () => {
    // saved A,B,C; B hidden (visible A,C); NEW visible; user drops order C,NEW,A.
    expect(applyReorder(["A", "B", "C"], ["C", "NEW", "A"], new Set(["C", "NEW", "A"]))).toEqual([
      "C", "B", "NEW", "A",
    ]);
  });

  it("keeps multiple hidden keys in their original slots", () => {
    // saved A,B,C,D,E; B and D hidden (visible A,C,E); reverse the visible set.
    expect(applyReorder(["A", "B", "C", "D", "E"], ["E", "C", "A"], new Set(["E", "C", "A"]))).toEqual([
      "E", "B", "C", "D", "A",
    ]);
  });

  it("appends untouched new keys at the end", () => {
    expect(applyReorder(["A", "B"], ["B", "A", "NEW"], new Set(["B", "A", "NEW"]))).toEqual(["B", "A", "NEW"]);
  });

  it("does not duplicate a new key already placed into a visible slot", () => {
    // NEW is both in the feed and appended-loop candidate; must appear once.
    const result = applyReorder(["A", "B"], ["NEW", "A", "B"], new Set(["NEW", "A", "B"]));
    expect(result).toEqual(["NEW", "A", "B"]);
    expect(result.filter((k) => k === "NEW")).toHaveLength(1);
  });

  it("leaves trailing hidden slots untouched when the feed is exhausted", () => {
    // saved A,B,C; only A visible; user 'reorders' just [A] (no change possible).
    expect(applyReorder(["A", "B", "C"], ["A"], new Set(["A"]))).toEqual(["A", "B", "C"]);
  });
});

describe("pruneOrder", () => {
  it("drops keys no longer present in the sprint", () => {
    expect(pruneOrder(["A", "B", "C"], ["A", "C"])).toEqual(["A", "C"]);
  });

  it("keeps the order of surviving keys", () => {
    expect(pruneOrder(["C", "A", "B"], ["A", "B", "C"])).toEqual(["C", "A", "B"]);
  });

  it("returns empty when nothing survives", () => {
    expect(pruneOrder(["A", "B"], [])).toEqual([]);
  });

  it("ignores present keys not already in the saved order", () => {
    expect(pruneOrder(["A"], ["A", "B", "C"])).toEqual(["A"]);
  });
});
