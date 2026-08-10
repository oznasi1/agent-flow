import { describe, it, expect } from "vitest";
import { inferTicket, localKey, localRunFor } from "../../../src/engine/localRuns";
import { groupPlacesByWindow } from "../../../src/engine/localRuns";
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

const GIT = (root: string) => ({ isGit: true, branch: root === "/r/centaur" ? "ASM-1-x" : "main" });
const solo = (place: string) => ({ workspaceFile: null, roots: [place], places: [place] });

describe("localRunFor", () => {
  it("keeps one repo and a per-window mode for a lone place", () => {
    const run = localRunFor(solo("/r/centaur"), [sess()], GIT, null, NOW);
    expect(run.mode).toBe("per-window");
    expect(run.workspaceFile).toBeUndefined();
    expect(run.repos).toEqual([{ name: "centaur", path: "/r/centaur", isGit: true, branch: "ASM-1-x" }]);
    expect(run.summary).toBe("centaur");
    expect(run.kind).toBe("local");
  });

  it("carries every root of a workspace group, each with its own branch", () => {
    const run = localRunFor(
      { workspaceFile: "/ws/centaur+e2e.code-workspace", roots: ["/r/centaur", "/r/automation_e2e"], places: ["/r/automation_e2e"] },
      [sess({ cwd: "/r/automation_e2e" })], GIT, null, NOW,
    );
    expect(run.repos).toEqual([
      { name: "centaur", path: "/r/centaur", isGit: true, branch: "ASM-1-x" },
      { name: "automation_e2e", path: "/r/automation_e2e", isGit: true, branch: "main" },
    ]);
    expect(run.workspaceFile).toBe("/ws/centaur+e2e.code-workspace");
    expect(run.mode).toBe("multiroot");
  });

  it("names a ticketless workspace card after the workspace, not a folder", () => {
    const run = localRunFor(
      { workspaceFile: "/ws/centaur+e2e.code-workspace", roots: ["/r/centaur", "/r/automation_e2e"], places: ["/r/automation_e2e"] },
      [sess({ cwd: "/r/automation_e2e" })], GIT, null, NOW,
    );
    expect(run.summary).toBe("centaur+e2e");
  });

  it("prefers the inferred ticket's summary and url over the workspace name", () => {
    const run = localRunFor(
      { workspaceFile: "/ws/centaur+e2e.code-workspace", roots: ["/r/centaur"], places: ["/r/centaur"] },
      [sess()], GIT, { key: "ASM-1", url: "https://jira/browse/ASM-1", summary: "team table" }, NOW,
    );
    expect(run.summary).toBe("team table");
    expect(run.url).toBe("https://jira/browse/ASM-1");
  });

  it("keys a workspace group off the workspace file, so both its sessions land on one card", () => {
    const g = { workspaceFile: "/ws/centaur+e2e.code-workspace", roots: ["/r/centaur", "/r/automation_e2e"], places: ["/r/centaur"] };
    expect(localRunFor(g, [sess()], GIT, null, NOW).key)
      .toBe(localRunFor({ ...g, places: ["/r/automation_e2e"] }, [sess()], GIT, null, NOW).key);
  });

  it("keys a workspace group off the workspace file itself, not the first root", () => {
    // The "same card" test above holds `roots` fixed across both calls, so it
    // can't tell a key derived from the workspace file apart from one derived
    // from `roots[0]` — both would agree. Pin it directly against localKey.
    const run = localRunFor(
      { workspaceFile: "/ws/centaur+e2e.code-workspace", roots: ["/r/centaur", "/r/automation_e2e"], places: ["/r/centaur"] },
      [sess()], GIT, null, NOW,
    );
    expect(run.key).toBe(localKey("/ws/centaur+e2e.code-workspace"));
  });

  it("omits a branch a root does not have", () => {
    const run = localRunFor(solo("/r/plain"), [sess()], () => ({ isGit: false, branch: null }), null, NOW);
    expect(run.repos).toEqual([{ name: "plain", path: "/r/plain", isGit: false }]);
  });

  it("starts at the earliest session and falls back to now", () => {
    expect(localRunFor(solo("/r/centaur"), [sess({ startedAt: 900 }), sess({ startedAt: 500 })], GIT, null, NOW).createdAt).toBe(500);
    expect(localRunFor(solo("/r/centaur"), [sess({ startedAt: 0 })], GIT, null, NOW).createdAt).toBe(NOW);
  });

  it("names a ticketless, workspaceless card after the full path when its only root has no basename", () => {
    // A filesystem root like "/" has an empty basename. An empty summary would
    // render as a blank card title, so the fallback names it after the path.
    const run = localRunFor(solo("/"), [sess()], () => ({ isGit: false, branch: null }), null, NOW);
    expect(run.summary).toBe("/");
  });

  it("names a repo after its full path when its basename is empty", () => {
    // Same shape, inside the repos map: a workspace root of "/" would otherwise
    // render as a blank repo chip on the board.
    const run = localRunFor(
      { workspaceFile: "/ws/x.code-workspace", roots: ["/r/centaur", "/"], places: ["/r/centaur"] },
      [sess()], GIT, null, NOW,
    );
    expect(run.repos[1]).toEqual({ name: "/", path: "/", isGit: true, branch: "main" });
  });
});

const ws = (identity: string, roots: string[]) =>
  ({ identity, kind: "workspace" as const, roots });

describe("groupPlacesByWindow", () => {
  it("folds two places of one multi-root window into a single group", () => {
    expect(groupPlacesByWindow(
      ["/r/automation_e2e", "/r/centaur"],
      [ws("/ws/centaur+e2e.code-workspace", ["/r/centaur", "/r/automation_e2e"])],
    )).toEqual([{
      workspaceFile: "/ws/centaur+e2e.code-workspace",
      roots: ["/r/centaur", "/r/automation_e2e"],
      places: ["/r/automation_e2e", "/r/centaur"],
    }]);
  });

  it("covers a root with no session of its own", () => {
    // The whole point: the card names both repos even though Claude only runs
    // in one of them.
    expect(groupPlacesByWindow(
      ["/r/automation_e2e"],
      [ws("/ws/centaur+e2e.code-workspace", ["/r/centaur", "/r/automation_e2e"])],
    )).toEqual([{
      workspaceFile: "/ws/centaur+e2e.code-workspace",
      roots: ["/r/centaur", "/r/automation_e2e"],
      places: ["/r/automation_e2e"],
    }]);
  });

  it("leaves a place no window lists standing alone", () => {
    expect(groupPlacesByWindow(["/r/lonely"], [ws("/ws/x.code-workspace", ["/r/a", "/r/b"])]))
      .toEqual([{ workspaceFile: null, roots: ["/r/lonely"], places: ["/r/lonely"] }]);
  });

  it("leaves a place alone when the window's record predates roots", () => {
    // An older extension host wrote no roots. Claiming nothing is exactly the
    // behavior before this feature.
    expect(groupPlacesByWindow(
      ["/r/centaur"],
      [{ identity: "/ws/x.code-workspace", kind: "workspace" as const }],
    )).toEqual([{ workspaceFile: null, roots: ["/r/centaur"], places: ["/r/centaur"] }]);
  });

  it("leaves a place alone when its window has a single root", () => {
    // A one-folder window is the place. Grouping it would rename the card after
    // a workspace file that adds nothing.
    expect(groupPlacesByWindow(
      ["/r/centaur"],
      [{ identity: "/r/centaur", kind: "folder" as const, roots: ["/r/centaur"] }],
    )).toEqual([{ workspaceFile: null, roots: ["/r/centaur"], places: ["/r/centaur"] }]);
  });

  it("leaves a place alone when a workspace-kind window has a single root", () => {
    // A .code-workspace with only one folder in it is still just that one
    // folder. Grouping it would rename the card after a workspace file that
    // adds nothing — same guard as the folder-kind case above, but exercised
    // through the "workspace" branch instead of the "kind !== workspace" one.
    expect(groupPlacesByWindow(
      ["/r/centaur"],
      [ws("/ws/x.code-workspace", ["/r/centaur"])],
    )).toEqual([{ workspaceFile: null, roots: ["/r/centaur"], places: ["/r/centaur"] }]);
  });

  it("keeps two windows' places apart, in first-place order", () => {
    expect(groupPlacesByWindow(
      ["/r/b", "/r/solo", "/r/a"],
      [ws("/ws/one.code-workspace", ["/r/a", "/r/b"])],
    ).map((g) => g.places)).toEqual([["/r/b", "/r/a"], ["/r/solo"]]);
  });
});
