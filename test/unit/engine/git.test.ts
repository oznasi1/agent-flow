import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { gitState } from "../../../src/engine/git";

describe("gitState", () => {
  let repo: string;
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "ignore"] });

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "flowdeck-git-"));
    g("init", "-q");
    g("config", "user.email", "t@t.dev");
    g("config", "user.name", "T");
    fs.writeFileSync(path.join(repo, "a.txt"), "1\n2\n3\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
  });

  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it("reports a clean repo with no diff and a branch", () => {
    const s = gitState("svc", repo);
    expect(s.dirty).toBe(false);
    expect(s.files).toBe(0);
    expect(s.added).toBe(0);
    expect(s.branch).toBeTruthy();
  });

  it("reports an uncommitted change as dirty with a +1 line diff", () => {
    fs.appendFileSync(path.join(repo, "a.txt"), "4\n");
    const s = gitState("svc", repo);
    expect(s.dirty).toBe(true);
    expect(s.files).toBe(1);
    expect(s.added).toBe(1);
    expect(s.removed).toBe(0);
  });

  it("degrades to zeros and a null branch for a non-git path (no throw)", () => {
    const s = gitState("nope", path.join(repo, "does-not-exist"));
    expect(s.branch).toBeNull();
    expect(s.dirty).toBe(false);
    expect(s.files).toBe(0);
  });
});
