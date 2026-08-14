import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  lastShape, isShapeFresh, putShape, peekSprintField, putSprintField, pickBoard,
  resetShapeCaches, SHAPE_TTL_MS, FIELD_TTL_MS,
} from "../../../../src/tasks/jira/shape";

beforeEach(() => resetShapeCaches());
afterEach(() => vi.useRealTimers());

describe("pickBoard", () => {
  it("prefers a scrum board over a kanban one", () => {
    expect(pickBoard({ values: [{ id: 7, type: "kanban" }, { id: 2, type: "scrum" }] }))
      .toEqual({ boardId: 2, hasSprints: true, boardCount: 2 });
  });

  it("picks the LOWEST scrum board id, not Jira's response order", () => {
    // Two scrum boards is genuinely ambiguous — see pickBoard's comment. The only
    // promise made is that the answer does not depend on the order Jira replied in.
    const a = pickBoard({ values: [{ id: 9, type: "scrum" }, { id: 4, type: "scrum" }] });
    const b = pickBoard({ values: [{ id: 4, type: "scrum" }, { id: 9, type: "scrum" }] });
    expect(a.boardId).toBe(4);
    expect(a).toEqual(b);
  });

  it("reports a kanban-only project as having no sprints, but remembers the board", () => {
    expect(pickBoard({ values: [{ id: 5, type: "kanban" }] }))
      .toEqual({ boardId: 5, hasSprints: false, boardCount: 1 });
  });

  it("reports a project with no boards at all", () => {
    expect(pickBoard({ values: [] })).toEqual({ boardId: null, hasSprints: false, boardCount: 0 });
  });

  it("treats a malformed payload as no boards rather than throwing", () => {
    for (const bad of [null, undefined, {}, { values: null }, "nope", 42]) {
      expect(pickBoard(bad)).toEqual({ boardId: null, hasSprints: false, boardCount: 0 });
    }
  });

  it("ignores entries that are not objects or carry no numeric id", () => {
    expect(pickBoard({ values: [null, "x", { type: "scrum" }, { id: "3", type: "scrum" }, { id: 8, type: "scrum" }] }))
      .toEqual({ boardId: 8, hasSprints: true, boardCount: 5 });
  });
});

describe("shape cache keying", () => {
  it("does not answer one site with another site's shape", () => {
    putShape("https://a.test", "PLAT", { boardId: 1, hasSprints: true, boardCount: 1 });
    expect(lastShape("https://b.test", "PLAT")).toBeNull();
  });

  it("does not answer one project with another project's shape on the same site", () => {
    putShape("https://a.test", "PLAT", { boardId: 1, hasSprints: true, boardCount: 1 });
    expect(lastShape("https://a.test", "OTHER")).toBeNull();
  });

  it("returns the stored shape for the same site and project", () => {
    const shape = { boardId: 1, hasSprints: true, boardCount: 1 };
    putShape("https://a.test", "PLAT", shape);
    expect(lastShape("https://a.test", "PLAT")).toEqual(shape);
  });

  it("putShape returns the shape it stored, so a caller can cache-and-return in one line", () => {
    const shape = { boardId: 3, hasSprints: true, boardCount: 1 };
    expect(putShape("https://a.test", "PLAT", shape)).toBe(shape);
  });

  it("is not confused by a project key that looks like part of another key", () => {
    // The separator must not be forgeable from either half: ("https://a.test", "AB|C")
    // and ("https://a.test|AB", "C") must land in different buckets.
    putShape("https://a.test", "AB|C", { boardId: 1, hasSprints: true, boardCount: 1 });
    expect(lastShape("https://a.test|AB", "C")).toBeNull();
  });
});

describe("shape staleness — remembered forever, re-read on a TTL", () => {
  it("goes stale after SHAPE_TTL_MS so a project that gains a board is noticed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    putShape("https://a.test", "PLAT", { boardId: null, hasSprints: false, boardCount: 0 });
    vi.setSystemTime(SHAPE_TTL_MS - 1);
    expect(isShapeFresh("https://a.test", "PLAT")).toBe(true);
    vi.setSystemTime(SHAPE_TTL_MS + 1);
    expect(isShapeFresh("https://a.test", "PLAT")).toBe(false);
  });

  it("KEEPS answering with a stale shape rather than forgetting it", () => {
    // The whole point. `caps` is a synchronous getter over this, and it maps "nothing
    // known" to the optimistic every-lens answer. If expiry deleted the entry, a
    // Kanban project's three dead sprint tabs would reappear the moment anything
    // re-posted state after the TTL — which is the exact bug this branch removes.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const shape = { boardId: 5, hasSprints: false, boardCount: 1 };
    putShape("https://a.test", "PLAT", shape);
    vi.setSystemTime(SHAPE_TTL_MS * 100);
    expect(lastShape("https://a.test", "PLAT")).toEqual(shape);
    expect(isShapeFresh("https://a.test", "PLAT")).toBe(false);
  });

  it("reports nothing known as not fresh, so a first read always happens", () => {
    expect(isShapeFresh("https://a.test", "NEVER-SEEN")).toBe(false);
    expect(lastShape("https://a.test", "NEVER-SEEN")).toBeNull();
  });

  it("a re-read replaces the stale answer and restores freshness", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    putShape("https://a.test", "PLAT", { boardId: 5, hasSprints: false, boardCount: 1 });
    vi.setSystemTime(SHAPE_TTL_MS + 1);
    putShape("https://a.test", "PLAT", { boardId: 2, hasSprints: true, boardCount: 2 });
    expect(isShapeFresh("https://a.test", "PLAT")).toBe(true);
    expect(lastShape("https://a.test", "PLAT")).toEqual({ boardId: 2, hasSprints: true, boardCount: 2 });
  });
});

describe("sprint-field cache keying", () => {
  it("is keyed by site, not shared across sites", () => {
    putSprintField("https://a.test", "customfield_10020");
    expect(peekSprintField("https://b.test")).toBeNull();
    expect(peekSprintField("https://a.test")).toEqual({ id: "customfield_10020" });
  });

  it("remembers a resolved null — a site with no Sprint field is a real answer", () => {
    putSprintField("https://a.test", null);
    expect(peekSprintField("https://a.test")).toEqual({ id: null });
  });

  it("expires after FIELD_TTL_MS rather than remembering null forever", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    putSprintField("https://a.test", null);
    vi.setSystemTime(FIELD_TTL_MS + 1);
    expect(peekSprintField("https://a.test")).toBeNull();
  });
});
