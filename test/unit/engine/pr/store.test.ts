import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { defaultPrFactsDir, readPrEntries, writePrEntry, removePrEntries, isStale } from "../../../../src/engine/pr/store";
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
    expect(readPrEntries(dir, "ASM-1")).toEqual({});
  });

  it("is empty for a directory that does not exist", () => {
    expect(readPrEntries(path.join(dir, "nope"), "ASM-1")).toEqual({});
  });

  it("round-trips an entry keyed by repo name", () => {
    const e: PrEntry = { facts: facts(), fetchedAt: 1000 };
    writePrEntry(dir, "ASM-1", "api", e);
    expect(readPrEntries(dir, "ASM-1")).toEqual({ api: e });
  });

  it("merges a second repo into the same run file", () => {
    writePrEntry(dir, "ASM-1", "api", { facts: facts(), fetchedAt: 1 });
    writePrEntry(dir, "ASM-1", "web", { facts: null, fetchedAt: 2 });
    expect(Object.keys(readPrEntries(dir, "ASM-1")).sort()).toEqual(["api", "web"]);
  });

  it("overwrites the same repo rather than appending", () => {
    writePrEntry(dir, "ASM-1", "api", { facts: facts({ number: 1 }), fetchedAt: 1 });
    writePrEntry(dir, "ASM-1", "api", { facts: facts({ number: 2 }), fetchedAt: 2 });
    expect(readPrEntries(dir, "ASM-1").api.facts!.number).toBe(2);
  });

  it("keeps runs separate", () => {
    writePrEntry(dir, "ASM-1", "api", { facts: null, fetchedAt: 1 });
    expect(readPrEntries(dir, "ASM-2")).toEqual({});
  });

  it("preserves a null-facts entry — 'no PR' is a real cached answer", () => {
    writePrEntry(dir, "ASM-1", "api", { facts: null, fetchedAt: 5 });
    expect(readPrEntries(dir, "ASM-1").api).toEqual({ facts: null, fetchedAt: 5 });
  });

  it("skips a corrupt file rather than throwing", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ASM-1.json"), "{ not json");
    expect(readPrEntries(dir, "ASM-1")).toEqual({});
  });

  it("survives a write into a directory that does not exist yet", () => {
    const nested = path.join(dir, "deep", "deeper");
    writePrEntry(nested, "ASM-1", "api", { facts: null, fetchedAt: 1 });
    expect(readPrEntries(nested, "ASM-1").api.fetchedAt).toBe(1);
  });
});

describe("removePrEntries", () => {
  it("drops a run's file", () => {
    writePrEntry(dir, "ASM-1", "api", { facts: null, fetchedAt: 1 });
    removePrEntries(dir, "ASM-1");
    expect(readPrEntries(dir, "ASM-1")).toEqual({});
  });

  it("is a no-op for a run that was never written", () => {
    expect(() => removePrEntries(dir, "ASM-404")).not.toThrow();
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
