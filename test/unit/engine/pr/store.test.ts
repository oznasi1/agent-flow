import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { defaultPrFactsDir, readPrEntries, writePrEntry, removePrEntries, isStale, summarisePrReads } from "../../../../src/engine/pr/store";
import type { PrEntry, PrFacts } from "../../../../src/types";

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 1, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-prfacts-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("defaultPrFactsDir", () => {
  it("lives beside the other agentflow stores", () => {
    expect(defaultPrFactsDir()).toBe(path.join(os.homedir(), ".agentflow", "prfacts"));
  });
});

describe("readPrEntries / writePrEntry", () => {
  it("is empty for a key that was never written", () => {
    expect(readPrEntries(dir, "PROJ-1")).toEqual({});
  });

  it("is empty for a directory that does not exist", () => {
    expect(readPrEntries(path.join(dir, "nope"), "PROJ-1")).toEqual({});
  });

  it("round-trips an entry keyed by repo name", () => {
    const e: PrEntry = { facts: facts(), fetchedAt: 1000 };
    writePrEntry(dir, "PROJ-1", "api", e);
    expect(readPrEntries(dir, "PROJ-1")).toEqual({ api: e });
  });

  it("merges a second repo into the same run file", () => {
    writePrEntry(dir, "PROJ-1", "api", { facts: facts(), fetchedAt: 1 });
    writePrEntry(dir, "PROJ-1", "web", { facts: null, fetchedAt: 2 });
    expect(Object.keys(readPrEntries(dir, "PROJ-1")).sort()).toEqual(["api", "web"]);
  });

  it("overwrites the same repo rather than appending", () => {
    writePrEntry(dir, "PROJ-1", "api", { facts: facts({ number: 1 }), fetchedAt: 1 });
    writePrEntry(dir, "PROJ-1", "api", { facts: facts({ number: 2 }), fetchedAt: 2 });
    expect(readPrEntries(dir, "PROJ-1").api.facts!.number).toBe(2);
  });

  it("keeps runs separate", () => {
    writePrEntry(dir, "PROJ-1", "api", { facts: null, fetchedAt: 1 });
    expect(readPrEntries(dir, "PROJ-2")).toEqual({});
  });

  it("preserves a null-facts entry — 'no PR' is a real cached answer", () => {
    writePrEntry(dir, "PROJ-1", "api", { facts: null, fetchedAt: 5 });
    expect(readPrEntries(dir, "PROJ-1").api).toEqual({ facts: null, fetchedAt: 5 });
  });

  it("skips a corrupt file rather than throwing", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "PROJ-1.json"), "{ not json");
    expect(readPrEntries(dir, "PROJ-1")).toEqual({});
  });

  it("survives a write into a directory that does not exist yet", () => {
    const nested = path.join(dir, "deep", "deeper");
    writePrEntry(nested, "PROJ-1", "api", { facts: null, fetchedAt: 1 });
    expect(readPrEntries(nested, "PROJ-1").api.fetchedAt).toBe(1);
  });

  it("uses atomic write (temp + rename) so successful writes clean up temp files", () => {
    // Pre-populate with two repos
    writePrEntry(dir, "PROJ-1", "api", { facts: null, fetchedAt: 1000 });
    writePrEntry(dir, "PROJ-1", "web", { facts: null, fetchedAt: 2000 });

    // Verify both are cached
    let entries = readPrEntries(dir, "PROJ-1");
    expect(Object.keys(entries).sort()).toEqual(["api", "web"]);

    // After successful writes, no temp files should be left in the directory.
    // Temp files match the pattern `.{key}.*.tmp` — if they exist, it indicates
    // either a failed rename or that the atomic write pattern isn't used.
    const files = fs.readdirSync(dir);
    const tempFiles = files.filter((f) => f.startsWith(".PROJ-1.") && f.endsWith(".tmp"));
    expect(tempFiles).toEqual([]);

    // Update a repo and verify temp files are still cleaned up
    writePrEntry(dir, "PROJ-1", "api", { facts: null, fetchedAt: 5000 });
    const filesAfter = fs.readdirSync(dir);
    const tempFilesAfter = filesAfter.filter((f) => f.startsWith(".PROJ-1.") && f.endsWith(".tmp"));
    expect(tempFilesAfter).toEqual([]);

    // Verify the write succeeded
    entries = readPrEntries(dir, "PROJ-1");
    expect(entries.api.fetchedAt).toBe(5000);
    expect(entries.web.fetchedAt).toBe(2000);
  });
});

describe("readPrEntries — malformed shapes (F3)", () => {
  it("returns {} for a top-level null rather than admitting it as a map", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "PROJ-1.json"), "null");
    expect(readPrEntries(dir, "PROJ-1")).toEqual({});
  });

  it("returns {} for a top-level number", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "PROJ-1.json"), "5");
    expect(readPrEntries(dir, "PROJ-1")).toEqual({});
  });

  it("returns {} for a top-level array rather than treating it as a repo map", () => {
    // A bare array passes `typeof parsed === "object"`. Left unguarded, the
    // caller's `all[repo] = entry` sets a non-index property that JSON.stringify
    // silently drops for an array, so the file never becomes writable again.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "PROJ-1.json"), "[]");
    expect(readPrEntries(dir, "PROJ-1")).toEqual({});
  });

  it("filters out a value that is not a PrEntry, keeping the ones that are", () => {
    // `{"api": null}` must not reach prSignals/allMerged — both deref `.facts`
    // on the entry and would throw on a bare `null`, which propagates out of
    // buildAll and freezes the whole board (no deck:runs posted at all).
    fs.mkdirSync(dir, { recursive: true });
    const web: PrEntry = { facts: facts(), fetchedAt: 123 };
    fs.writeFileSync(path.join(dir, "PROJ-1.json"), JSON.stringify({ api: null, web }));
    expect(readPrEntries(dir, "PROJ-1")).toEqual({ web });
  });
});

describe("removePrEntries", () => {
  it("drops a run's file", () => {
    writePrEntry(dir, "PROJ-1", "api", { facts: null, fetchedAt: 1 });
    removePrEntries(dir, "PROJ-1");
    expect(readPrEntries(dir, "PROJ-1")).toEqual({});
  });

  it("is a no-op for a run that was never written", () => {
    expect(() => removePrEntries(dir, "PROJ-404")).not.toThrow();
  });
});

describe("isStale", () => {
  it("treats a missing entry as stale", () => {
    expect(isStale(undefined, 1000, 5000)).toBe(true);
  });

  it("is fresh strictly inside the ttl", () => {
    expect(isStale({ facts: null, fetchedAt: 4001 }, 1000, 5000)).toBe(false);
  });

  it("is stale exactly at the ttl", () => {
    expect(isStale({ facts: null, fetchedAt: 4000 }, 1000, 5000)).toBe(true);
  });

  it("is stale past the ttl", () => {
    expect(isStale({ facts: null, fetchedAt: 3999 }, 1000, 5000)).toBe(true);
  });

  it("ages a null-facts entry like any other, so a PR-less repo is not refetched every tick", () => {
    expect(isStale({ facts: null, fetchedAt: 4500 }, 1000, 5000)).toBe(false);
  });

  it("ages an errored entry like any other, so a broken gh is not retried every tick", () => {
    expect(isStale({ facts: null, fetchedAt: 4500, error: true }, 1000, 5000)).toBe(false);
  });
});

describe("summarisePrReads", () => {
  const write = (key: string, repo: string, entry: PrEntry) => writePrEntry(dir, key, repo, entry);

  it("reports nothing for a directory that does not exist", () => {
    // Doctor runs before the Deck has ever been opened on a fresh machine.
    expect(summarisePrReads(path.join(dir, "nope"))).toEqual({ runs: 0, repos: [] });
  });

  it("reports nothing when every entry read cleanly", () => {
    write("PROJ-1", "api", { facts: facts(), fetchedAt: 1 });
    write("PROJ-2", "web", { facts: null, fetchedAt: 1 });
    expect(summarisePrReads(dir)).toEqual({ runs: 0, repos: [] });
  });

  it("counts RUNS, not repos — the unit the footer note uses", () => {
    // One run with three broken repos is one run on the board, and the card names
    // the repos itself. Counting repos here would print a number nothing shows.
    write("PROJ-1", "api", { facts: null, fetchedAt: 1, error: true });
    write("PROJ-1", "web", { facts: null, fetchedAt: 1, error: true });
    write("PROJ-1", "ops", { facts: null, fetchedAt: 1, error: true });
    expect(summarisePrReads(dir).runs).toBe(1);
  });

  it("counts a run whose entries are a MIX of clean and failed", () => {
    // The half-broken run is still a run whose PR story cannot be trusted.
    write("PROJ-1", "api", { facts: facts(), fetchedAt: 1 });
    write("PROJ-1", "web", { facts: null, fetchedAt: 1, error: true });
    expect(summarisePrReads(dir).runs).toBe(1);
  });

  it("gathers the failing repo names across runs, deduped and sorted", () => {
    write("PROJ-1", "webapp", { facts: null, fetchedAt: 1, error: true });
    write("PROJ-2", "webapp", { facts: null, fetchedAt: 1, error: true });
    write("PROJ-2", "aws-ops", { facts: null, fetchedAt: 1, error: true });
    write("PROJ-3", "hermes", { facts: facts(), fetchedAt: 1 });
    const got = summarisePrReads(dir);
    expect(got.runs).toBe(2);
    expect(got.repos).toEqual(["aws-ops", "webapp"]);
  });

  it("counts a run carrying STALE facts forward, not just an empty one", () => {
    // The entry has facts and looks perfectly healthy to every other reader.
    write("PROJ-1", "webapp", { facts: facts({ state: "OPEN" }), fetchedAt: 1, error: true });
    expect(summarisePrReads(dir)).toEqual({ runs: 1, repos: ["webapp"] });
  });

  it("ignores files that are not run records", () => {
    // writePrEntry's own temp files start with a dot and are renamed away, but a
    // crashed write can leave one behind.
    fs.writeFileSync(path.join(dir, "notes.txt"), "hello");
    fs.writeFileSync(path.join(dir, ".PROJ-9.123.tmp"), "{}");
    write("PROJ-1", "api", { facts: null, fetchedAt: 1, error: true });
    expect(summarisePrReads(dir)).toEqual({ runs: 1, repos: ["api"] });
  });
});
