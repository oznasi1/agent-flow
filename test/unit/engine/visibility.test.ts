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
  hasLiveSession: false, prOpen: false, ticketActive: false, hasWorkToLose: false, ...over,
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

  it("closes a run whose every PR merged — there is no Done column left to hold it", () => {
    // The whole point of retiring the fourth column: landing is not a board
    // state. A multi-repo run that landed everywhere has no live signal at all.
    expect(shelfFor(input())).toBe("closed");
    expect(landed(prs(facts({ state: "MERGED" }), facts({ state: "MERGED" })), "indeterminate")).toBe(true);
  });

  it("still keeps a merged run on the board while its ticket is open or an agent is in it", () => {
    // Landing does not close a run by itself — these two do the deciding, and a
    // merge that nobody has moved the ticket for is still work somebody owes.
    expect(shelfFor(input({ ticketActive: true }))).toBe("board");
    expect(shelfFor(input({ hasLiveSession: true }))).toBe("board");
  });

  it("keeps an active ticket on the board with nothing else going on", () => {
    expect(shelfFor(input({ ticketActive: true }))).toBe("board");
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
