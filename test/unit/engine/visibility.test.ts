import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { landed, shelfFor, VisibilityInput } from "../../../src/engine/visibility";
import { PrEntryMap, PrFacts } from "../../../src/types";

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 1, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});
const prs = (...f: (PrFacts | null)[]): PrEntryMap =>
  Object.fromEntries(f.map((x, i) => [`repo${i}`, { facts: x, fetchedAt: 0 }]));

const input = (over: Partial<VisibilityInput> = {}): VisibilityInput => ({
  hasLiveSession: false, prOpen: false, merged: false, hasWorkToLose: false, justLaunched: false, ...over,
});

describe("visibility.ts is webview-safe", () => {
  it("imports nothing but ../types, so the browser bundle can include it", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../../src/engine/visibility.ts"), "utf8");
    const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers).toEqual(["../types"]);
  });
});

describe("shelfFor", () => {
  it("closes a run with no signal at all", () => {
    expect(shelfFor(input())).toBe("closed");
  });

  it("keeps a run with a live session on the board", () => {
    expect(shelfFor(input({ hasLiveSession: true }))).toBe("board");
  });

  it("keeps a run with an open PR on the board after its agent closed", () => {
    expect(shelfFor(input({ prOpen: true }))).toBe("board");
  });

  it("keeps a merged run on the board, so its wrap-up is somewhere you can see it", () => {
    expect(shelfFor(input({ merged: true }))).toBe("board");
  });

  it("closes a done ticket that never merged — nothing landed, so nothing to wrap up", () => {
    // The one case where `merged` and `landed()` disagree, and the whole reason
    // the shelf reads the narrower of the two.
    expect(landed(prs(facts({ state: "CLOSED" })), "done")).toBe(true);
    expect(shelfFor(input({ merged: false }))).toBe("closed");
  });

  it("closes a parked run whose ticket is the only thing still open", () => {
    // An open ticket is not work in flight. Nobody is in the run, there is no PR
    // and nothing to lose — the card had nothing on it to act on, and the strip
    // it lands on offers the two things left: reopen, forget.
    expect(shelfFor(input())).toBe("closed");
  });

  it("keeps a just-launched run on the board before its session exists", () => {
    // The gap between taking work and Claude Code writing a transcript for the
    // new worktree is seconds to minutes, and during it every other signal is
    // false: a fresh worktree is clean, unpushed nothing, PR-less. Without this
    // the card you just created would flash into Recently closed and back.
    expect(shelfFor(input({ justLaunched: true }))).toBe("board");
  });

  it("keeps a run with uncommitted or unpushed work on the board", () => {
    expect(shelfFor(input({ hasWorkToLose: true }))).toBe("board");
  });
});

describe("landed", () => {
  it("is false when no PR has been observed at all", () => {
    expect(landed({}, "indeterminate")).toBe(false);
  });

  it("is true when every PR-bearing repo merged", () => {
    expect(landed(prs(facts({ state: "MERGED" }), facts({ state: "MERGED" })), null)).toBe(true);
  });

  it("is false when one repo merged and another is still open", () => {
    expect(landed(prs(facts({ state: "MERGED" }), facts({ state: "OPEN" })), null)).toBe(false);
  });

  it("is true for a done ticket with no PR still open", () => {
    expect(landed(prs(facts({ state: "CLOSED" })), "done")).toBe(true);
  });

  it("is false for a done ticket whose PR is still open", () => {
    expect(landed(prs(facts({ state: "OPEN" })), "done")).toBe(false);
  });

  it("ignores null facts — a repo whose PR was never fetched", () => {
    expect(landed(prs(null), "done")).toBe(true);
  });
});
