import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readJson, writeJson, appendJsonl } from "../../../scripts/reach/store.mjs";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("readJson", () => {
  it("returns the fallback when the file does not exist", () => {
    expect(readJson(dir, "traffic/views.json", { seed: true })).toEqual({ seed: true });
  });

  it("returns the fallback when the file is corrupt rather than throwing", () => {
    fs.mkdirSync(path.join(dir, "traffic"), { recursive: true });
    fs.writeFileSync(path.join(dir, "traffic/views.json"), "{not json");
    expect(readJson(dir, "traffic/views.json", { seed: true })).toEqual({ seed: true });
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
