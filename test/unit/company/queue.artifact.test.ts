import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { companyPaths, ensureCompanyDirs, CompanyPaths } from "../../../src/company/paths";
import { resolveArtifact, isInside } from "../../../src/company/queue";
import { QueueItem } from "../../../src/company/types";

let root: string;
let p: CompanyPaths;

function item(artifact: QueueItem["artifact"]): QueueItem {
  return {
    id: "x",
    cycle: "c",
    role: "company-growth",
    kind: "copy",
    title: "t",
    why: "w",
    artifact,
    risk: "gated",
    on_approve: "a",
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-company-artifact-"));
  p = companyPaths(root);
  ensureCompanyDirs(p);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("isInside", () => {
  it("accepts the root itself and its descendants", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/c/d.txt")).toBe(true);
  });

  it("rejects siblings and parents", () => {
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
  });
});

describe("resolveArtifact", () => {
  it("returns inline content without touching the filesystem", () => {
    const r = resolveArtifact(p, item({ type: "text", inline: "a draft tweet" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact.content).toBe("a draft tweet");
      expect(r.artifact.truncated).toBe(false);
    }
  });

  it("prefers inline over path when both are present", () => {
    fs.writeFileSync(path.join(p.drafts, "hero.md"), "from disk");
    const r = resolveArtifact(
      p,
      item({ type: "markdown", inline: "from inline", path: ".claude/company/drafts/hero.md" }),
    );
    if (r.ok) expect(r.artifact.content).toBe("from inline");
  });

  it("reads a repo-relative path", () => {
    fs.writeFileSync(path.join(p.drafts, "hero.md"), "# Hero\n");
    const r = resolveArtifact(p, item({ type: "markdown", path: ".claude/company/drafts/hero.md" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.artifact.content).toBe("# Hero\n");
  });

  it("reads an absolute path inside the repo", () => {
    const abs = path.join(p.drafts, "hero.md");
    fs.writeFileSync(abs, "absolute");
    const r = resolveArtifact(p, item({ type: "markdown", path: abs }));
    expect(r.ok).toBe(true);
  });

  it("refuses a path that climbs out of the repo", () => {
    const r = resolveArtifact(p, item({ type: "text", path: "../../../etc/passwd" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("outside");
  });

  it("refuses an absolute path outside the repo", () => {
    const r = resolveArtifact(p, item({ type: "text", path: "/etc/passwd" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("outside");
  });

  it("refuses a directory", () => {
    const r = resolveArtifact(p, item({ type: "text", path: ".claude/company/drafts" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not a file");
  });

  it("reports a missing file plainly", () => {
    const r = resolveArtifact(p, item({ type: "text", path: ".claude/company/drafts/gone.md" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("gone.md");
  });

  it("truncates content past the byte cap and says so", () => {
    fs.writeFileSync(path.join(p.drafts, "big.md"), "x".repeat(500));
    const r = resolveArtifact(p, item({ type: "text", path: ".claude/company/drafts/big.md" }), 100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact.content).toHaveLength(100);
      expect(r.artifact.truncated).toBe(true);
    }
  });

  it("refuses an artifact with neither path nor inline", () => {
    const r = resolveArtifact(p, item({ type: "text" }));
    expect(r.ok).toBe(false);
  });
});
