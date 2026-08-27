import { describe, it, expect } from "vitest";
import { prWorkPlan } from "../../../src/engine/prWork";
import type { Run } from "../../../src/types";
import type { CurrentWindow } from "../../../src/engine/presence";

const HERE: CurrentWindow = {
  identity: "/repos/account-service",
  kind: "folder",
  roots: [{ name: "account-service", path: "/repos/account-service" }],
};

/** A per-window run: one window per repo, each rendered against its own brief. */
const perWindow = (over: Partial<Run> = {}): Run => ({
  key: "PROJ-1",
  summary: "s",
  url: "https://j/browse/PROJ-1",
  createdAt: 1,
  mode: "per-window",
  repos: [{ name: "svc", path: "/r/svc", isGit: true }],
  briefPaths: ["/r/svc/.pick-task/TASK.md"],
  ...over,
});

/** A multiroot run: one window on the workspace file, rendered against one brief. */
const multiroot = (over: Partial<Run> = {}): Run =>
  perWindow({ mode: "multiroot", workspaceFile: "/ws/PROJ-1.code-workspace", ...over });

describe("prWorkPlan", () => {
  describe("stay — the run's own window, which is what shipped before the destination question", () => {
    it("seeds one match per repo against the RELATIVE brief", () => {
      // The relative `.pick-task/TASK.md` resolves only because the window IS the
      // repo. `briefPath: undefined` is what makes agentPrompt fall back to it, so
      // this is the assertion that keeps the pre-existing behaviour byte-identical.
      const run = perWindow({
        repos: [
          { name: "svc", path: "/r/svc", isGit: true },
          { name: "web", path: "/r/web", isGit: true },
        ],
      });
      expect(prWorkPlan(run, { kind: "stay" })).toEqual({
        seats: [{ matchPath: "/r/svc" }, { matchPath: "/r/web" }],
        toOpen: ["/r/svc", "/r/web"],
      });
    });

    it("seeds the workspace file once, against the run's absolute brief", () => {
      expect(prWorkPlan(multiroot(), { kind: "stay" })).toEqual({
        seats: [{ matchPath: "/ws/PROJ-1.code-workspace", briefPath: "/r/svc/.pick-task/TASK.md" }],
        toOpen: ["/ws/PROJ-1.code-workspace"],
      });
    });

    it("treats a new window as the run's own place — `open -a` focuses the window already holding it", () => {
      // The picker never offers "New window" for PR work for exactly this reason;
      // the case exists so a target that reaches here from anywhere else cannot
      // silently seed nothing.
      expect(prWorkPlan(perWindow(), { kind: "new" })).toEqual(prWorkPlan(perWindow(), { kind: "stay" }));
    });
  });

  describe("elsewhere — a destination that is not the repo, so the brief must be absolute", () => {
    it("seeds this window in place, opening nothing", () => {
      expect(prWorkPlan(perWindow(), { kind: "current" }, HERE)).toEqual({
        seats: [{ matchPath: "/repos/account-service", briefPath: "/r/svc/.pick-task/TASK.md" }],
        toOpen: [],
      });
    });

    it("refuses `current` when this window has no identity — nothing can be seeded here", () => {
      expect(prWorkPlan(perWindow(), { kind: "current" })).toBeUndefined();
    });

    it("focuses a live folder window and seeds it", () => {
      expect(prWorkPlan(perWindow(), { kind: "live-folder", folder: "/repos/bite-me" })).toEqual({
        seats: [{ matchPath: "/repos/bite-me", briefPath: "/r/svc/.pick-task/TASK.md" }],
        toOpen: ["/repos/bite-me"],
      });
    });

    it("opens an existing .code-workspace and seeds it", () => {
      expect(prWorkPlan(perWindow(), { kind: "existing", file: "/ws/team.code-workspace" })).toEqual({
        seats: [{ matchPath: "/ws/team.code-workspace", briefPath: "/r/svc/.pick-task/TASK.md" }],
        toOpen: ["/ws/team.code-workspace"],
      });
    });

    it("collapses a multi-repo run onto the one destination window", () => {
      // Every non-stay destination IS a single window: two repos cannot each get
      // their own there, so the run seeds once and the prompt (not this module)
      // carries which repos it covers.
      const run = perWindow({
        repos: [
          { name: "svc", path: "/r/svc", isGit: true },
          { name: "web", path: "/r/web", isGit: true },
        ],
      });
      expect(prWorkPlan(run, { kind: "live-folder", folder: "/repos/bite-me" })?.seats).toHaveLength(1);
    });

    it("leaves the brief relative when the run has none, rather than inventing a path", () => {
      const run = perWindow({ briefPaths: [] });
      expect(prWorkPlan(run, { kind: "live-folder", folder: "/repos/bite-me" })).toEqual({
        seats: [{ matchPath: "/repos/bite-me" }],
        toOpen: ["/repos/bite-me"],
      });
    });
  });
});
