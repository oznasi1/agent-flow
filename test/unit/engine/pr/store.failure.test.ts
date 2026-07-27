import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import { readPrEntries, writePrEntry } from "../../../../src/engine/pr/store";
import type { PrEntry, PrFacts } from "../../../../src/types";

vi.mock("fs");

const readFileSync = vi.mocked(fs.readFileSync);
const writeFileSync = vi.mocked(fs.writeFileSync);
const mkdirSync = vi.mocked(fs.mkdirSync);
const renameSync = vi.mocked(fs.renameSync);
const rmSync = vi.mocked(fs.rmSync);

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 1, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});

beforeEach(() => {
  readFileSync.mockReset().mockReturnValue("");
  writeFileSync.mockReset();
  mkdirSync.mockReset();
  renameSync.mockReset();
  rmSync.mockReset();
});

describe("writePrEntry with fs failures", () => {
  it("leaves unrelated repos intact when rename fails mid-write", () => {
    // Simulate an existing cache with two repos: api and web
    const existingCache = JSON.stringify({
      api: { facts: null, fetchedAt: 1000 },
      web: { facts: null, fetchedAt: 2000 },
    });

    // First read returns the existing cache (both repos)
    readFileSync.mockReturnValueOnce(existingCache);
    // Rename fails, simulating I/O error
    renameSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    // Try to update 'api'. The write should fail silently.
    writePrEntry("/test", "RUN-1", "api", { facts: facts({ number: 99 }), fetchedAt: 5000 });

    // Verify that renameSync was called (the write attempted)
    expect(renameSync).toHaveBeenCalled();

    // Now simulate a subsequent successful read of the cache
    readFileSync.mockReturnValueOnce(existingCache);

    // Read should return the original cache, unchanged
    const entries = readPrEntries("/test", "RUN-1");
    expect(entries.api.fetchedAt).toBe(1000);
    expect(entries.web.fetchedAt).toBe(2000);
  });

  it("leaves unrelated repos intact when writeFileSync fails mid-write", () => {
    // Simulate an existing cache with two repos: api and web
    const existingCache = JSON.stringify({
      api: { facts: null, fetchedAt: 1000 },
      web: { facts: null, fetchedAt: 2000 },
    });

    // First read returns the existing cache (both repos)
    readFileSync.mockReturnValueOnce(existingCache);
    // Write fails, simulating disk full or I/O error
    writeFileSync.mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });

    // Try to update 'web'. The write should fail silently.
    writePrEntry("/test", "RUN-1", "web", { facts: facts({ number: 88 }), fetchedAt: 6000 });

    // Verify that writeFileSync was called
    expect(writeFileSync).toHaveBeenCalled();
    // Verify that cleanup was attempted (rmSync for the temp file)
    expect(rmSync).toHaveBeenCalled();

    // Now simulate a subsequent successful read of the cache
    readFileSync.mockReturnValueOnce(existingCache);

    // Read should return the original cache, unchanged
    const entries = readPrEntries("/test", "RUN-1");
    expect(entries.api.fetchedAt).toBe(1000);
    expect(entries.web.fetchedAt).toBe(2000);
  });
});
