import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { companyPaths, ensureCompanyDirs, CompanyPaths } from "../../../src/company/paths";
import { readQueue, readLanded, isPaused, setPaused, lastCycle } from "../../../src/company/queue";

let root: string;
let p: CompanyPaths;

function writeItem(id: string, over: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(p.queue, `${id}.json`),
    JSON.stringify({
      id,
      cycle: "2026-07-31T17:09",
      role: "company-growth",
      kind: "copy",
      title: `Item ${id}`,
      why: "because",
      artifact: { type: "text", inline: "hello" },
      risk: "gated",
      on_approve: "do the thing",
      ...over,
    }),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-company-read-"));
  p = companyPaths(root);
  ensureCompanyDirs(p);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("readQueue", () => {
  it("returns nothing when the queue directory is missing", () => {
    fs.rmSync(p.queue, { recursive: true, force: true });
    expect(readQueue(p)).toEqual({ items: [], quarantined: [] });
  });

  it("reads items in filename order", () => {
    writeItem("b-second");
    writeItem("a-first");
    expect(readQueue(p).items.map((i) => i.id)).toEqual(["a-first", "b-second"]);
  });

  it("ignores files that are not .json", () => {
    writeItem("real");
    fs.writeFileSync(path.join(p.queue, "notes.txt"), "ignore me");
    const r = readQueue(p);
    expect(r.items).toHaveLength(1);
    expect(r.quarantined).toHaveLength(0);
  });

  it("quarantines unparseable JSON instead of throwing", () => {
    fs.writeFileSync(path.join(p.queue, "broken.json"), "{ not json");
    const r = readQueue(p);
    expect(r.items).toHaveLength(0);
    expect(r.quarantined[0].file).toBe("broken.json");
    expect(r.quarantined[0].error).toMatch(/json/i);
  });

  it("quarantines an item that fails validation", () => {
    fs.writeFileSync(path.join(p.queue, "bad.json"), JSON.stringify({ id: "bad" }));
    const r = readQueue(p);
    expect(r.items).toHaveLength(0);
    expect(r.quarantined[0].error).toContain("cycle");
  });

  it("quarantines an item whose id does not match its filename", () => {
    writeItem("mismatch");
    fs.renameSync(path.join(p.queue, "mismatch.json"), path.join(p.queue, "other.json"));
    const r = readQueue(p);
    expect(r.items).toHaveLength(0);
    expect(r.quarantined[0].error).toContain("filename");
  });

  it("keeps good items when a sibling is broken", () => {
    writeItem("fine");
    fs.writeFileSync(path.join(p.queue, "zbroken.json"), "nope");
    const r = readQueue(p);
    expect(r.items.map((i) => i.id)).toEqual(["fine"]);
    expect(r.quarantined).toHaveLength(1);
  });
});

describe("readLanded", () => {
  it("returns newest first and drops invalid records", () => {
    fs.writeFileSync(
      path.join(p.landed, "a.json"),
      JSON.stringify({
        id: "a", cycle: "c", role: "r", title: "older",
        sha: "aaaaaaa", landed_at: "2026-07-30T10:00:00Z",
      }),
    );
    fs.writeFileSync(
      path.join(p.landed, "b.json"),
      JSON.stringify({
        id: "b", cycle: "c", role: "r", title: "newer",
        sha: "bbbbbbb", landed_at: "2026-07-31T10:00:00Z",
      }),
    );
    fs.writeFileSync(path.join(p.landed, "c.json"), JSON.stringify({ id: "c", sha: "nope" }));
    expect(readLanded(p).map((r) => r.title)).toEqual(["newer", "older"]);
  });

  it("returns an empty list when the directory is missing", () => {
    fs.rmSync(p.landed, { recursive: true, force: true });
    expect(readLanded(p)).toEqual([]);
  });
});

describe("pause flag", () => {
  it("is off until the file exists", () => {
    expect(isPaused(p)).toBe(false);
  });

  it("round-trips through setPaused", () => {
    expect(setPaused(p, true)).toBe(true);
    expect(isPaused(p)).toBe(true);
    expect(setPaused(p, false)).toBe(false);
    expect(isPaused(p)).toBe(false);
  });

  it("is idempotent in both directions", () => {
    setPaused(p, true);
    setPaused(p, true);
    expect(isPaused(p)).toBe(true);
    setPaused(p, false);
    setPaused(p, false);
    expect(isPaused(p)).toBe(false);
  });
});

describe("lastCycle", () => {
  it("is null with no reports", () => {
    expect(lastCycle(p)).toBeNull();
  });

  it("returns the newest report name", () => {
    fs.writeFileSync(path.join(p.cycles, "2026-07-30T0900.md"), "older");
    fs.writeFileSync(path.join(p.cycles, "2026-07-31T1709.md"), "newer");
    expect(lastCycle(p)).toBe("2026-07-31T1709.md");
  });
});
