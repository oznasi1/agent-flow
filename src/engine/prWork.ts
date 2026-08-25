import type { Run } from "../types";
import type { OpenTarget } from "./openTarget";
import type { CurrentWindow } from "./presence";

/**
 * Where a card's PR work opens. `stay` is the run's own window — the destination
 * that shipped before the question existed, and the one the picker leads with.
 *
 * Kept beside `OpenTarget` rather than inside it: `stay` means "wherever this run
 * already lives", which only a run can answer, so it is meaningless to Take and to
 * Review with … and must never reach `targetToOpenArgs`.
 */
export type PrWorkTarget = OpenTarget | { kind: "stay" };

/** One window the plan file will seed, and the brief its prompt renders against. */
export interface PrWorkSeat {
  matchPath: string;
  /** Absolute. `undefined` leaves `agentPrompt` on the relative `.pick-task/TASK.md`,
   *  which resolves only when the window IS the repo. */
  briefPath?: string;
}

export interface PrWorkPlan {
  seats: PrWorkSeat[];
  /** Paths to open or focus. Empty when the destination is the window we are in. */
  toOpen: string[];
}

/**
 * The windows to seed for one PR-work click, and which of them to open.
 *
 * Pure, and deliberately not prompt-aware: the caller renders each seat through
 * `agentPrompt`, which lives in `engine/workspace.ts` and reaches for `fs`. What is
 * decided here is only *where* — one destination window, or the run's own places.
 *
 * The brief is the reason this is not a one-liner. A run's per-repo matches seed a
 * relative `.pick-task/TASK.md`, which resolves because the window is the repo; a
 * destination the user picked is some other folder, where that path is nothing. So
 * every destination but the run's own seeds the run's absolute brief instead — the
 * same trick `openWorkspace`'s `absoluteBrief` uses to seed a review into a folder
 * someone else's session is working in.
 *
 * Returns `undefined` for exactly one case: `current` in a window that has no
 * identity and so cannot hold a seeded session. `targetToOpenArgs` refuses the same
 * case the same way.
 */
export function prWorkPlan(
  run: Pick<Run, "workspaceFile" | "repos" | "briefPaths">,
  target: PrWorkTarget,
  here?: CurrentWindow,
): PrWorkPlan | undefined {
  // One window, somewhere that is not this run's repo: the absolute brief travels,
  // the relative one would not. A multi-repo run collapses onto it — a single window
  // cannot be two repos, and the prompt already names the ticket.
  const elsewhere = (path: string): PrWorkPlan => ({
    seats: [{ matchPath: path, ...(run.briefPaths[0] ? { briefPath: run.briefPaths[0] } : {}) }],
    toOpen: [path],
  });

  switch (target.kind) {
    // `new` and `stay` are the same act, not a shared fallthrough by accident:
    // `openInEditor` shells `open -a`, which focuses the window already holding a
    // folder rather than opening a second one. That is why the PR-work picker offers
    // no "New window" item at all — it would be a second name for this row.
    case "new":
    case "stay":
      // Mirror the shape the run was launched in, which is what its windows are:
      // a multiroot run is one window on the workspace file, a per-window run is one
      // window per repo. The same split `openWorkspace` makes, keyed on
      // `workspaceFile`'s presence the way `inspect()` already keys it.
      return run.workspaceFile
        ? {
            seats: [{ matchPath: run.workspaceFile, ...(run.briefPaths[0] ? { briefPath: run.briefPaths[0] } : {}) }],
            toOpen: [run.workspaceFile],
          }
        : { seats: run.repos.map((r) => ({ matchPath: r.path })), toOpen: run.repos.map((r) => r.path) };
    case "current":
      if (!here) return undefined;
      // Nothing to open: `watchPlansAndSeed` makes this window seed itself when the
      // plan lands, and opening our own identity would only steal focus back.
      return { ...elsewhere(here.identity), toOpen: [] };
    case "live-folder":
      return elsewhere(target.folder);
    case "existing":
      return elsewhere(target.file);
  }
}
