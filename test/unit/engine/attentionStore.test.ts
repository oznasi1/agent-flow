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
    // Pre-create attention.json as a FILE, so mkdirSync on a path *through* it
    // genuinely throws EEXIST/ENOTDIR. Without this the recursive mkdir simply
    // creates attention.json as a directory, the write succeeds, and the test
    // passes without ever entering the catch it claims to exercise.
    const blocker = path.join(dir, "attention.json");
    fs.writeFileSync(blocker, "not a directory");
    expect(() => writeAnnounced(path.join(blocker, "nope.json"), { A: 1 })).not.toThrow();
  });

  it("cleans up orphaned temp files when rename fails — target exists as a directory", () => {
    // The implementation uses atomic write (temp + rename + cleanup).
    // Make the target path a directory instead of a file, so renameSync will
    // fail trying to replace a directory with a file. The catch block should
    // clean up the temp file. This verifies the cleanup pattern from pr/store.ts.
    fs.mkdirSync(file);

    expect(() => writeAnnounced(file, { A: 1 })).not.toThrow();

    // After the failed rename, the directory should contain only the 'file'
    // directory — no temp files left behind if cleanup in catch block works.
    const tmpFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });
});
