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

  it("refuses a symlink pointing outside the repo", () => {
    // Create a target file outside the repo
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-external-"));
    try {
      const externalFile = path.join(tmpDir, "secret.txt");
      fs.writeFileSync(externalFile, "secret content");

      // Create a symlink inside the repo pointing to the external file
      const symlinkPath = path.join(p.drafts, "link.txt");
      fs.symlinkSync(externalFile, symlinkPath);

      // Should refuse because the real path is outside the repo
      const r = resolveArtifact(p, item({ type: "text", path: ".claude/company/drafts/link.txt" }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("outside");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles multi-byte content correctly without truncation", () => {
    const emoji = "Hello 👋 World";
    fs.writeFileSync(path.join(p.drafts, "emoji.txt"), emoji);
    const r = resolveArtifact(p, item({ type: "text", path: ".claude/company/drafts/emoji.txt" }), 1000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact.content).toBe(emoji);
      expect(r.artifact.truncated).toBe(false);
      // Verify no replacement character or surrogate issues
      expect(r.artifact.content).not.toContain("�");
    }
  });

  it("truncates multi-byte content at byte boundary without corruption", () => {
    const emoji = "Hello 👋 World";
    fs.writeFileSync(path.join(p.drafts, "emoji.txt"), emoji);
    // The emoji "👋" is 4 bytes in UTF-8
    // "Hello " is 6 bytes, so byte limit of 8 should cut into the emoji
    const r = resolveArtifact(p, item({ type: "text", path: ".claude/company/drafts/emoji.txt" }), 8);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact.truncated).toBe(true);
      // Should not contain replacement character or incomplete sequences
      expect(r.artifact.content).not.toContain("�");
      // Content should be valid UTF-8 string
      expect(() => {
        // Just accessing it should not throw
        r.artifact.content.charCodeAt(0);
      }).not.toThrow();
    }
  });

  it("truncates multi-byte inline content at byte boundary without corruption", () => {
    const emoji = "Hello 👋 World";
    const r = resolveArtifact(p, item({ type: "text", inline: emoji }), 8);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact.truncated).toBe(true);
      expect(r.artifact.content).not.toContain("�");
      expect(() => {
        r.artifact.content.charCodeAt(0);
      }).not.toThrow();
    }
  });

  it("keeps a U+FFFD the content is entitled to, rather than eating the prefix", () => {
    // "ab�" is exactly 5 bytes, so the whole budget is spent on characters
    // that survive intact. The old decode-and-guess back-off asked whether the
    // candidate ended in U+FFFD — which this one does, legitimately — and so
    // kept stepping back, all the way to an empty string.
    const r = resolveArtifact(p, item({ type: "text", inline: "ab�xxxxxxxxxx" }), 5);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact.content).toBe("ab�");
      expect(r.artifact.truncated).toBe(true);
    }
  });

  it("truncates U+FFFD-laden content correctly and in linear time", () => {
    // Every character here is a 3-byte U+FFFD, so the old back-off never found
    // a candidate that did not end in one: it walked the offset down to zero,
    // decoding up to the whole buffer on each step. Measured on the previous
    // implementation: 7.7s at this cap, and no result inside 120s at the real
    // 262,144-byte default — with resolveArtifact running synchronously inside
    // the request handler, so the entire board stalled behind it.
    const cap = 65536;
    const started = Date.now();
    const r = resolveArtifact(p, item({ type: "text", inline: "�".repeat(cap) }), cap);
    const elapsed = Date.now() - started;

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact.truncated).toBe(true);
      // 21,845 whole characters fill 65,535 of the 65,536 bytes; the 21,846th
      // straddles the cap, so the prefix stops one byte short of it instead of
      // splitting it.
      expect(r.artifact.content).toBe("�".repeat(21845));
      expect(Buffer.byteLength(r.artifact.content, "utf8")).toBe(65535);
    }
    // A deliberately generous bound: the walk is at most three steps now, so
    // this lands in single-digit milliseconds. The old code could not.
    expect(elapsed).toBeLessThan(1000);
  });
});
