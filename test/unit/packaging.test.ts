import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

describe(".vscodeignore", () => {
  // CLAUDE.md tells every contributor to "work in a git worktree so a parallel
  // session cannot switch the checkout under you", and the conventional place for
  // one is .worktrees/ inside the repo. vsce walks the working directory, not git
  // — .gitignore does not reach it — so an unignored worktree is packed into the
  // .vsix: 760 files and 28MB of someone else's branch on the first attempt, and a
  // hard failure ("not a file") the moment that worktree links its node_modules.
  it("excludes the worktree directory the contributing guide tells people to use", () => {
    expect(read(".vscodeignore")).toMatch(/^\.worktrees\/\*\*$/m);
  });

  // .reach-data is the GitHub Pages dashboard's own data — index.html, traffic
  // snapshots, star counts — generated and published by .github/workflows/reach.yml.
  // Nothing under src/ reads it, so every byte of it inside the .vsix is dead
  // weight shipped to every installer.
  it("excludes the Pages dashboard data, which the extension never reads", () => {
    expect(read(".vscodeignore").split("\n")).toContain(".reach-data/**");
  });

  // Every path .vscodeignore names is a directory vsce must not walk; a stale entry
  // is harmless, but a dev directory that exists and is NOT listed ships to users.
  it("excludes each dev directory that the build actually creates", () => {
    const ignore = read(".vscodeignore");
    for (const dir of ["src", "test", "node_modules", "coverage", "docs", ".claude"]) {
      expect(ignore.split("\n")).toContain(`${dir}/**`);
    }
  });
});
