import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readJson, writeJson, appendJsonl, readLatestSnapshot } from "../../../scripts/reach/store.mjs";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("readJson", () => {
  it("returns the fallback when the file does not exist", () => {
    expect(readJson(dir, "traffic/views.json", { seed: true })).toEqual({ seed: true });
  });

  it("throws when the file exists but does not parse — never masks damage as empty", () => {
    fs.mkdirSync(path.join(dir, "traffic"), { recursive: true });
    fs.writeFileSync(path.join(dir, "traffic/views.json"), "{not json");
    expect(() => readJson(dir, "traffic/views.json", { seed: true })).toThrow();
    // The damaged file itself is left untouched for manual repair.
    expect(fs.readFileSync(path.join(dir, "traffic/views.json"), "utf8")).toBe("{not json");
  });

  it("round-trips through writeJson", () => {
    writeJson(dir, "traffic/views.json", { "2026-08-21": { count: 18, uniques: 3 } });
    expect(readJson(dir, "traffic/views.json", null)).toEqual({ "2026-08-21": { count: 18, uniques: 3 } });
  });
});

describe("writeJson", () => {
  it("creates missing parent directories", () => {
    writeJson(dir, "snapshots/referrers/2026-08-22.json", [{ referrer: "Google" }]);
    expect(fs.existsSync(path.join(dir, "snapshots/referrers/2026-08-22.json"))).toBe(true);
  });

  it("writes a trailing newline so git diffs stay clean", () => {
    writeJson(dir, "meta.json", { lastRun: "2026-08-22" });
    expect(fs.readFileSync(path.join(dir, "meta.json"), "utf8").endsWith("\n")).toBe(true);
  });

  it("writes atomically — no stray temp file survives, and an existing file is fully replaced", () => {
    writeJson(dir, "meta.json", { lastRun: "2026-08-22" });
    writeJson(dir, "meta.json", { lastRun: "2026-08-23" });
    expect(fs.readdirSync(dir)).toEqual(["meta.json"]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"))).toEqual({ lastRun: "2026-08-23" });
  });
});

describe("appendJsonl", () => {
  it("appends one line per record and never rewrites earlier lines", () => {
    appendJsonl(dir, "marketplace.jsonl", { ts: "2026-08-22", downloads: 18596 });
    appendJsonl(dir, "marketplace.jsonl", { ts: "2026-08-23", downloads: 18700 });
    const lines = fs.readFileSync(path.join(dir, "marketplace.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ ts: "2026-08-22", downloads: 18596 });
    expect(JSON.parse(lines[1])).toEqual({ ts: "2026-08-23", downloads: 18700 });
  });
});

describe("readLatestSnapshot", () => {
  it("returns null when the kind has never been collected", () => {
    expect(readLatestSnapshot(dir, "referrers")).toBeNull();
  });

  it("picks the newest date, not the newest mtime — order on disk is not chronology", () => {
    // Written newest-first on purpose: a readdir/mtime-based implementation
    // would answer 2026-08-01 here, silently serving month-old rankings.
    writeJson(dir, "snapshots/referrers/2026-09-02.json", [{ referrer: "new", count: 2, uniques: 1 }]);
    writeJson(dir, "snapshots/referrers/2026-08-01.json", [{ referrer: "old", count: 9, uniques: 4 }]);
    const snap = readLatestSnapshot(dir, "referrers");
    expect(snap).toEqual({ date: "2026-09-02", rows: [{ referrer: "new", count: 2, uniques: 1 }] });
  });

  it("ignores files that are not a dated snapshot", () => {
    writeJson(dir, "snapshots/paths/2026-08-01.json", [{ path: "/x", count: 1, uniques: 1 }]);
    fs.writeFileSync(path.join(dir, "snapshots/paths/README.md"), "notes\n");
    fs.writeFileSync(path.join(dir, "snapshots/paths/latest.json"), "[]\n");
    expect(readLatestSnapshot(dir, "paths")?.date).toBe("2026-08-01");
  });

  it("returns null when the directory holds nothing dated", () => {
    fs.mkdirSync(path.join(dir, "snapshots/paths"), { recursive: true });
    fs.writeFileSync(path.join(dir, "snapshots/paths/notes.txt"), "x");
    expect(readLatestSnapshot(dir, "paths")).toBeNull();
  });

  it("returns null when the payload is not an array — a shape change must not render as rows", () => {
    writeJson(dir, "snapshots/referrers/2026-08-01.json", { referrer: "not-a-list" });
    expect(readLatestSnapshot(dir, "referrers")).toBeNull();
  });

  it("throws on a corrupt snapshot rather than masking it as absent", () => {
    fs.mkdirSync(path.join(dir, "snapshots/referrers"), { recursive: true });
    fs.writeFileSync(path.join(dir, "snapshots/referrers/2026-08-01.json"), "{ not json");
    expect(() => readLatestSnapshot(dir, "referrers")).toThrow(/corrupt JSON/);
  });
});
