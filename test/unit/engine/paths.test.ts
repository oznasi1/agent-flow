import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { canon, pidAlive } from "../../../src/engine/paths";

describe("canon", () => {
  it("resolves a symlink to its real path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-canon-"));
    const real = path.join(dir, "real");
    fs.mkdirSync(real);
    const link = path.join(dir, "link");
    fs.symlinkSync(real, link);
    expect(canon(link)).toBe(fs.realpathSync(real));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("hands back a path that does not exist rather than throwing", () => {
    expect(canon("/definitely/not/here")).toBe("/definitely/not/here");
  });
});

describe("pidAlive", () => {
  it("is true for this process", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  it("is false for a pid that cannot exist", () => {
    expect(pidAlive(2 ** 30)).toBe(false);
  });
});
