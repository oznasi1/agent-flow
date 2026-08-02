import { describe, it, expect } from "vitest";
import { inferTicket, localKey, localRunFor } from "../../../src/engine/localRuns";
import type { OpenSession } from "../../../src/engine/sessions";

const BASE = "https://at-bay.atlassian.net";
const NOW = 1_800_000_000_000;
const sess = (over: Partial<OpenSession> = {}): OpenSession => ({
  pid: 1, sessionId: "s1", cwd: "/r/centaur", startedAt: 500, name: "centaur-7e", ...over,
});

describe("inferTicket", () => {
  it("reads a key and a summary out of a task branch", () => {
    expect(inferTicket("ASM-5641-team-table-new-design", "ASM", BASE)).toEqual({
      key: "ASM-5641",
      url: `${BASE}/browse/ASM-5641`,
      summary: "team table new design",
    });
  });

  it("accepts a bare key with no tail", () => {
    expect(inferTicket("ASM-5772", "ASM", BASE)).toEqual({
      key: "ASM-5772", url: `${BASE}/browse/ASM-5772`, summary: "ASM-5772",
    });
  });

  it("upper-cases a lower-cased key", () => {
    expect(inferTicket("asm-1-x", "ASM", BASE)?.key).toBe("ASM-1");
  });

  it("refuses a branch that names another project", () => {
    // The gate is the project the user actually works in, so a guess can only
    // ever name an issue that could exist for them.
    expect(inferTicket("PROJ-12-x", "ASM", BASE)).toBeNull();
  });

  it("refuses a branch with no key, a default branch, and no branch at all", () => {
    expect(inferTicket("feature/x", "ASM", BASE)).toBeNull();
    expect(inferTicket("main", "ASM", BASE)).toBeNull();
    expect(inferTicket(null, "ASM", BASE)).toBeNull();
  });

  it("refuses when no project is configured", () => {
    expect(inferTicket("ASM-1-x", "", BASE)).toBeNull();
  });

  it("does not double a trailing slash on the base url", () => {
    expect(inferTicket("ASM-1", "ASM", `${BASE}/`)?.url).toBe(`${BASE}/browse/ASM-1`);
  });
});

describe("localKey", () => {
  it("is stable for the same place", () => {
    expect(localKey("/r/centaur")).toBe(localKey("/r/centaur"));
  });

  it("differs for two places sharing a basename", () => {
    expect(localKey("/a/centaur")).not.toBe(localKey("/b/centaur"));
  });

  it("keeps the basename greppable and stays filename-safe", () => {
    const k = localKey("/r/my repo!/deep");
    expect(k).toMatch(/^local-deep-[0-9a-f]{8}$/);
  });

  it("survives a basename full of characters a filename cannot hold", () => {
    expect(localKey("/r/a b:c*d")).toMatch(/^local-a-b-c-d-[0-9a-f]{8}$/);
  });
});

describe("localRunFor", () => {
  const git = { isGit: true, branch: "ASM-1-x" };
  const ticket = { key: "ASM-1", url: `${BASE}/browse/ASM-1`, summary: "a thing" };

  it("carries the ticket's summary and url when one was inferred", () => {
    const r = localRunFor("/r/centaur", [sess()], git, ticket, NOW);
    expect(r).toMatchObject({
      key: localKey("/r/centaur"),
      summary: "a thing",
      url: `${BASE}/browse/ASM-1`,
      kind: "local",
      mode: "per-window",
      briefPaths: [],
    });
  });

  it("falls back to the directory basename with no ticket", () => {
    const r = localRunFor("/r/centaur", [sess()], { isGit: true, branch: "main" }, null, NOW);
    expect(r.summary).toBe("centaur");
    expect(r.url).toBe("");
  });

  it("describes the place as a single repo", () => {
    expect(localRunFor("/r/centaur", [sess()], git, ticket, NOW).repos).toEqual([
      { name: "centaur", path: "/r/centaur", isGit: true, branch: "ASM-1-x" },
    ]);
  });

  it("omits the branch key entirely on a detached or non-git place", () => {
    const r = localRunFor("/r/notes", [sess()], { isGit: false, branch: null }, null, NOW);
    expect(r.repos[0]).toEqual({ name: "notes", path: "/r/notes", isGit: false });
  });

  it("starts at the earliest session", () => {
    const r = localRunFor("/r/centaur", [sess({ startedAt: 900 }), sess({ startedAt: 400 })], git, ticket, NOW);
    expect(r.createdAt).toBe(400);
  });

  it("falls back to now when no session records a start", () => {
    const r = localRunFor("/r/centaur", [sess({ startedAt: 0 })], git, ticket, NOW);
    expect(r.createdAt).toBe(NOW);
  });
});
