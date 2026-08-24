import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { defaultAttentionFile, readAnnounced, writeAnnounced } from "../../../src/engine/attentionStore";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "attention-"));
  file = path.join(dir, "attention.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("defaultAttentionFile", () => {
  it("sits in ~/.agentflow beside runs/ and prfacts/", () => {
    expect(defaultAttentionFile()).toBe(path.join(os.homedir(), ".agentflow", "attention.json"));
  });
});

describe("readAnnounced", () => {
  it("returns {} for a file that does not exist", () => {
    expect(readAnnounced(file)).toEqual({});
  });

  it("returns {} for corrupt JSON rather than throwing into the poll", () => {
    fs.writeFileSync(file, "{not json");
    expect(readAnnounced(file)).toEqual({});
  });

  it("returns {} for an array, which would silently drop every write", () => {
    fs.writeFileSync(file, "[]");
    expect(readAnnounced(file)).toEqual({});
  });

  it("drops non-number values rather than handing them to the latch", () => {
    fs.writeFileSync(file, JSON.stringify({ A: 1, B: "nope", C: null }));
    expect(readAnnounced(file)).toEqual({ A: 1 });
  });

  it("round-trips what writeAnnounced wrote", () => {
    writeAnnounced(file, { A: 1, B: 2 });
    expect(readAnnounced(file)).toEqual({ A: 1, B: 2 });
  });
});

describe("writeAnnounced", () => {
  it("creates ~/.agentflow when this is the first thing to touch it", () => {
    const nested = path.join(dir, "agentflow", "attention.json");
    writeAnnounced(nested, { A: 1 });
    expect(readAnnounced(nested)).toEqual({ A: 1 });
  });

  it("leaves no temp file behind", () => {
    writeAnnounced(file, { A: 1 });
    expect(fs.readdirSync(dir)).toEqual(["attention.json"]);
  });

  it("swallows an unwritable path — a failed latch write costs a duplicate toast, never a crash", () => {
    expect(() => writeAnnounced(path.join(dir, "attention.json", "nope.json"), { A: 1 })).not.toThrow();
  });
});
