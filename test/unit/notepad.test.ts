import { describe, it, expect } from "vitest";
import { newNote, noteStatus, sanitizeNotes } from "../../src/notepad";
import type { NotepadItem, Run } from "../../src/types";

function run(over: Partial<Run> = {}): Run {
  return { key: "notepad-a", summary: "s", url: "", createdAt: 1, kind: "notepad",
    mode: "per-window", repos: [{ name: "r", path: "/repo", isGit: true }],
    briefPaths: [], ...over } as Run;
}
function note(over: Partial<NotepadItem> = {}): NotepadItem {
  return { id: "n1", title: "t", body: "b", done: false, createdAt: 1, ...over };
}

describe("noteStatus", () => {
  it("is absent for a note that was never run", () => {
    expect(noteStatus(note(), [run()], new Set())).toBeUndefined();
  });

  it("is absent when the run record is gone (the Deck already retired it)", () => {
    expect(noteStatus(note({ lastRunKey: "notepad-gone" }), [run()], new Set())).toBeUndefined();
  });

  it("is finished once the retire sweep stamped finishedAt", () => {
    const runs = [run({ finishedAt: 99 })];
    expect(noteStatus(note({ lastRunKey: "notepad-a" }), runs, new Set(["/repo"]))).toBe("finished");
  });

  it("is running when a session is live in one of the run's repos", () => {
    expect(noteStatus(note({ lastRunKey: "notepad-a" }), [run()], new Set(["/repo"]))).toBe("running");
  });

  it("is stale when the run is live-less and unfinished", () => {
    expect(noteStatus(note({ lastRunKey: "notepad-a" }), [run()], new Set(["/elsewhere"]))).toBe("stale");
  });

  it("tolerates a record whose repos field is missing entirely", () => {
    const runs = [{ key: "notepad-a", summary: "s", url: "", createdAt: 1 } as unknown as Run];
    expect(noteStatus(note({ lastRunKey: "notepad-a" }), runs, new Set(["/repo"]))).toBe("stale");
  });
});

describe("newNote", () => {
  it("trims the title and body and starts undone", () => {
    expect(newNote("  hi  ", "  there  ", "id-1", 7)).toEqual({
      id: "id-1", title: "hi", body: "there", done: false, createdAt: 7,
    });
  });
});

describe("sanitizeNotes", () => {
  it("returns an empty array for anything that is not an array", () => {
    expect(sanitizeNotes(undefined)).toEqual([]);
    expect(sanitizeNotes({ nope: true })).toEqual([]);
  });

  it("drops entries with no usable id and coerces the rest", () => {
    const out = sanitizeNotes([
      { id: "keep", title: "t", body: "b", done: true, createdAt: 5 },
      { title: "no id" },
      { id: "coerce" },
    ]);
    expect(out).toEqual([
      { id: "keep", title: "t", body: "b", done: true, createdAt: 5 },
      { id: "coerce", title: "", body: "", done: false, createdAt: 0 },
    ]);
  });

  it("preserves lastRunKey when present and omits it when not a string", () => {
    const out = sanitizeNotes([
      { id: "a", lastRunKey: "notepad-x" },
      { id: "b", lastRunKey: 42 },
    ]);
    expect(out[0].lastRunKey).toBe("notepad-x");
    expect(out[1].lastRunKey).toBeUndefined();
  });
});
