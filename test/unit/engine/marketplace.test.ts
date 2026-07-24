import { describe, it, expect } from "vitest";
import { normalizeRepo } from "../../../src/engine/marketplace";

describe("normalizeRepo", () => {
  it("accepts owner/repo", () => {
    expect(normalizeRepo("anthropics/claude-plugins")).toBe("anthropics/claude-plugins");
  });
  it("trims whitespace and a trailing slash", () => {
    expect(normalizeRepo("  owner/repo/  ")).toBe("owner/repo");
  });
  it("parses an https URL and strips .git", () => {
    expect(normalizeRepo("https://github.com/owner/repo.git")).toBe("owner/repo");
  });
  it("parses an scp-style git@ URL", () => {
    expect(normalizeRepo("git@github.com:owner/repo.git")).toBe("owner/repo");
  });
  it("rejects a bare word", () => {
    expect(normalizeRepo("justaword")).toBeNull();
  });
  it("rejects empty / whitespace", () => {
    expect(normalizeRepo("   ")).toBeNull();
  });
  it("rejects a non-github host URL", () => {
    expect(normalizeRepo("https://gitlab.com/owner/repo")).toBeNull();
  });
  it("rejects a non-github scp-style URL", () => {
    expect(normalizeRepo("git@gitlab.com:owner/repo.git")).toBeNull();
  });
  it("rejects a slug half containing stray punctuation", () => {
    expect(normalizeRepo("owner/repo:branch")).toBeNull();
  });
  it("strips a trailing slash after .git in an scp URL", () => {
    expect(normalizeRepo("git@github.com:owner/repo.git/")).toBe("owner/repo");
  });
});
