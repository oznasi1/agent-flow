import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readPrEntries, writePrEntry } from "../../../../src/engine/pr/store";
import type { PrEntry, PrFacts } from "../../../../src/types";

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 1, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-prfacts-failure-")); });
afterEach(() => {
  // Restore permissions in case a test left the dir read-only
  try {
    fs.chmodSync(dir, 0o755);
  } catch {
    /* ignore */
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("writePrEntry with real file failures", () => {
  it.skipIf(process.getuid?.() === 0)("leaves unrelated repos intact when write fails due to read-only directory", () => {
    // Step 1: Pre-populate cache with two repos through real code
    writePrEntry(dir, "RUN-1", "api", { facts: null, fetchedAt: 1000 });
    writePrEntry(dir, "RUN-1", "web", { facts: null, fetchedAt: 2000 });

    // Verify both are really there
    let entries = readPrEntries(dir, "RUN-1");
    expect(Object.keys(entries).sort()).toEqual(["api", "web"]);
    expect(entries.api.fetchedAt).toBe(1000);
    expect(entries.web.fetchedAt).toBe(2000);

    // Step 2: Make directory read-only (readable and traversable, not writable)
    fs.chmodSync(dir, 0o555);

    try {
      // Step 3: Try to update a third repo. Creating the temp file will fail with EACCES.
      // The call must not throw (best-effort).
      writePrEntry(dir, "RUN-1", "thirdrepo", { facts: facts({ number: 99 }), fetchedAt: 3000 });

      // Step 4: Make directory writable again so we can read
      fs.chmodSync(dir, 0o755);

      // Step 5: Verify the original two repos are still there with their exact original values,
      // and the third repo was not added. This is the core guarantee: unrelated entries survive.
      entries = readPrEntries(dir, "RUN-1");
      expect(Object.keys(entries).sort()).toEqual(["api", "web"]);
      expect(entries.api.fetchedAt).toBe(1000);
      expect(entries.web.fetchedAt).toBe(2000);
      expect(entries.thirdrepo).toBeUndefined();
    } finally {
      // Restore permissions so cleanup can remove the dir
      fs.chmodSync(dir, 0o755);
    }
  });
});
