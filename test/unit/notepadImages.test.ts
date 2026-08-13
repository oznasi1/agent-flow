import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  MAX_IMAGE_BYTES,
  deleteImages,
  imagePath,
  saveImage,
  sweepOrphans,
} from "../../src/notepadImages";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "np-img-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe("saveImage", () => {
  it("writes the bytes under <id>.<ext> and returns the record", () => {
    const r = saveImage(dir, png(), "image/png", "shot.png", "img1");
    expect(r).toEqual({ ok: true, image: { id: "img1", ext: "png", name: "shot.png" } });
    expect(fs.readFileSync(path.join(dir, "img1.png"))).toEqual(Buffer.from(png()));
  });

  it("creates the directory when it does not exist yet", () => {
    const nested = path.join(dir, "notepad-images");
    expect(saveImage(nested, png(), "image/png", "a.png", "img1").ok).toBe(true);
    expect(fs.existsSync(path.join(nested, "img1.png"))).toBe(true);
  });

  it("derives the extension from the mime, not from the filename", () => {
    const r = saveImage(dir, png(), "image/jpeg", "lying.png", "img2");
    expect(r).toMatchObject({ ok: true, image: { ext: "jpg" } });
    expect(fs.existsSync(path.join(dir, "img2.jpg"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "img2.png"))).toBe(false);
  });

  it("accepts every supported mime, case-insensitively", () => {
    expect(saveImage(dir, png(), "IMAGE/PNG", "a", "a").ok).toBe(true);
    expect(saveImage(dir, png(), "image/gif", "b", "b")).toMatchObject({ image: { ext: "gif" } });
    expect(saveImage(dir, png(), "image/webp", "c", "c")).toMatchObject({ image: { ext: "webp" } });
  });

  it("refuses an unsupported type by mime, naming the file, and writes nothing", () => {
    const r = saveImage(dir, png(), "application/pdf", "paper.pdf", "img3");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("paper.pdf");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("refuses bytes over the cap and writes nothing", () => {
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    const r = saveImage(dir, big, "image/png", "huge.png", "img4");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("10 MB");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("accepts bytes exactly at the cap", () => {
    expect(saveImage(dir, new Uint8Array(MAX_IMAGE_BYTES), "image/png", "edge.png", "img5").ok).toBe(true);
  });

  it("falls back to a generated display name when the source has none", () => {
    expect(saveImage(dir, png(), "image/png", "   ", "img6")).toMatchObject({
      image: { name: "image.png" },
    });
  });
});

describe("deleteImages", () => {
  it("unlinks each file", () => {
    saveImage(dir, png(), "image/png", "a.png", "a");
    saveImage(dir, png(), "image/png", "b.png", "b");
    deleteImages(dir, [{ id: "a", ext: "png", name: "a.png" }]);
    expect(fs.readdirSync(dir)).toEqual(["b.png"]);
  });

  it("tolerates a file that is already gone", () => {
    expect(() => deleteImages(dir, [{ id: "ghost", ext: "png", name: "g.png" }])).not.toThrow();
  });
});

describe("sweepOrphans", () => {
  it("deletes only the files no note references, and reports the count", () => {
    saveImage(dir, png(), "image/png", "keep.png", "keep");
    saveImage(dir, png(), "image/png", "drop.png", "drop");
    expect(sweepOrphans(dir, new Set(["keep"]))).toBe(1);
    expect(fs.readdirSync(dir)).toEqual(["keep.png"]);
  });

  it("is a no-op — not a throw — when the directory does not exist", () => {
    expect(sweepOrphans(path.join(dir, "nope"), new Set())).toBe(0);
  });

  it("keeps a referenced file whatever its extension", () => {
    saveImage(dir, png(), "image/webp", "a.webp", "a");
    expect(sweepOrphans(dir, new Set(["a"]))).toBe(0);
    expect(fs.readdirSync(dir)).toEqual(["a.webp"]);
  });
});

describe("imagePath", () => {
  it("joins the directory with <id>.<ext>", () => {
    expect(imagePath("/store", { id: "i", ext: "gif", name: "n" })).toBe(path.join("/store", "i.gif"));
  });
});
