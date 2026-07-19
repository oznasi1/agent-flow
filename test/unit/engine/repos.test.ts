import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { discoverRepos } from "../../../src/engine/repos";

// Hermetic: build a real repo tree in a temp dir.
let root: string;

function mkdir(...parts: string[]) {
  fs.mkdirSync(path.join(root, ...parts), { recursive: true });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-repos-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("discoverRepos", () => {
  it("lists directories, flags git repos, and sorts by name", () => {
    mkdir("web-app"); // no .git → not a git repo
    mkdir("api-service", ".git"); // has .git → git repo
    const repos = discoverRepos(root);
    expect(repos.map((r) => r.name)).toEqual(["api-service", "web-app"]);
    expect(repos.find((r) => r.name === "api-service")!.isGit).toBe(true);
    expect(repos.find((r) => r.name === "web-app")!.isGit).toBe(false);
    expect(repos.find((r) => r.name === "api-service")!.path).toBe(path.join(root, "api-service"));
  });

  it("excludes directories named in the blocklist", () => {
    mkdir("api-service");
    mkdir("infra");
    mkdir("tooling");
    const names = discoverRepos(root, ["infra", "tooling"]).map((r) => r.name);
    expect(names).toContain("api-service");
    expect(names).not.toContain("infra");
    expect(names).not.toContain("tooling");
  });

  it("includes everything when the blocklist is empty (default)", () => {
    mkdir("api-service");
    mkdir("infra");
    expect(discoverRepos(root).map((r) => r.name)).toEqual(["api-service", "infra"]);
  });

  it("skips dotfiles/dot-directories", () => {
    mkdir("web-app");
    mkdir(".config");
    expect(discoverRepos(root).map((r) => r.name)).toEqual(["web-app"]);
  });

  it("ignores plain files (only directories are repos)", () => {
    mkdir("web-app");
    fs.writeFileSync(path.join(root, "notes.txt"), "hi");
    expect(discoverRepos(root).map((r) => r.name)).toEqual(["web-app"]);
  });

  it("returns [] for an unreadable/nonexistent root", () => {
    expect(discoverRepos(path.join(root, "does-not-exist"))).toEqual([]);
  });
});
