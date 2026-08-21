import type { WorkspaceMode } from "../types";
import type { CurrentWindow, PresenceRecord } from "./presence";

/** Where to open a launch — a new window, the current one, merged into an existing
 * .code-workspace file, or focused into an already-open folder window.
 *
 * Lifted out of tasksView so the Deck's **Review with agent** asks the destination
 * question in exactly the same words as Take does. Everything here is a pure function
 * over injected readers (`vscode` is deliberately absent) so both callers can be tested
 * without a running editor — the same split `engine/review/launch.ts` uses. */
export type OpenTarget =
  | { kind: "new" }
  | { kind: "current" }
  | { kind: "existing"; file: string }
  | { kind: "live-folder"; folder: string };

/** The `agentFlow.openIn` / `agentFlow.reviewOpenIn` vocabulary. Declared here rather
 * than imported from config.ts, which reaches for `vscode`. */
export type OpenInSetting = "ask" | "new-window" | "this-window" | "pick-existing";

/** The `openWorkspace` arguments a resolved target becomes. */
export interface OpenArgs {
  mode: WorkspaceMode;
  openIn: "new" | "current";
  existingWorkspaceFile?: string;
  existingFolder?: string;
  currentWindow?: CurrentWindow;
}

/** Said only when the SETTING asked for this window and this window can't hold a
 * session. Exported so the callers and their tests name the one string. */
export const NO_IDENTITY_TOAST =
  "This window has no saved workspace file and no single folder, so it can't hold a session — opening a new window instead.";

/** What the `ask` picker offers before a target is resolved: `existing-pick` is an item,
 * not a destination — choosing it opens the workspace-file picker. */
type PickTarget = OpenTarget | { kind: "existing-pick" };
type TargetItem = { label: string; detail: string; target: PickTarget };

export interface ChooseOpenTargetDeps {
  currentWindow: () => CurrentWindow | undefined;
  /** Live Agent-Flow windows OTHER than this one. Read lazily — never called when
   *  presence tracking is off. */
  liveWindows: () => PresenceRecord[];
  /** `vscode.window.showQuickPick`, minus the `ignoreFocusOut` the adapter adds. */
  pick: <T extends { label: string }>(items: T[], opts: { title: string; placeHolder: string }) => Promise<T | undefined>;
  pickExistingWorkspace: () => Promise<OpenTarget | undefined>;
  toast: (message: string) => void;
}

/** Live Agent-Flow windows as open-target picks. A workspace window maps to the
 * existing merge+focus path; a folder window focuses and seeds in place. */
export function liveWindowItems(records: readonly PresenceRecord[]): TargetItem[] {
  return records.map((w) => ({
    label: `$(window) ${w.label}`,
    detail: w.kind === "workspace" ? `open now · ${w.folders} folder${w.folders === 1 ? "" : "s"}` : "open now",
    target: w.kind === "workspace" ? { kind: "existing", file: w.identity } : { kind: "live-folder", folder: w.identity },
  }));
}

/** Where to open this launch. Live windows appear only in the interactive `ask` flow —
 * a specific open window is inherently a per-launch choice, not a setting. */
export async function chooseOpenTarget(
  cfg: { openIn: OpenInSetting; trackOpenWindows: boolean; title: string; placeHolder: string },
  deps: ChooseOpenTargetDeps,
): Promise<OpenTarget | undefined> {
  // A window with no identity can't be named by a plan match, so it can't hold a
  // seeded session — "this window" is not offered, and the setting can't force it.
  const here = deps.currentWindow();
  if (cfg.openIn === "new-window") return { kind: "new" };
  if (cfg.openIn === "this-window") {
    if (here) return { kind: "current" };
    deps.toast(NO_IDENTITY_TOAST);
    return { kind: "new" };
  }
  if (cfg.openIn === "pick-existing") return deps.pickExistingWorkspace();

  const thisWindow: TargetItem[] = here
    ? [{ label: "$(window) This window", detail: "Start a session here — keeps this window's folders", target: { kind: "current" } }]
    : [];
  const base: TargetItem[] = [
    { label: "$(empty-window) New window", detail: "Open the task in a separate window", target: { kind: "new" } },
    ...thisWindow,
    { label: "$(folder-library) Existing workspace…", detail: "Open the task into a .code-workspace you already have", target: { kind: "existing-pick" } },
  ];
  const live = cfg.trackOpenWindows ? liveWindowItems(deps.liveWindows()) : [];
  const p = await deps.pick([...base, ...live], { title: cfg.title, placeHolder: cfg.placeHolder });
  if (!p) return undefined;
  if (p.target.kind === "existing-pick") return deps.pickExistingWorkspace();
  return p.target;
}

export interface TargetToOpenArgsDeps {
  currentWindow: () => CurrentWindow | undefined;
  /** The multiroot-vs-per-window question, already bound to the caller's setting and
   *  label. Only ever asked for a NEW window. */
  chooseWorkspaceMode: (count: number) => Promise<WorkspaceMode | undefined>;
}

/** Resolve an OpenTarget to the openWorkspace arguments, asking the multiroot-vs-
 * per-window question only for a NEW window. Returns undefined if the user cancels
 * that sub-pick. */
export async function targetToOpenArgs(
  target: OpenTarget,
  count: number,
  deps: TargetToOpenArgsDeps,
): Promise<OpenArgs | undefined> {
  if (target.kind === "existing") return { mode: "multiroot", openIn: "new", existingWorkspaceFile: target.file };
  if (target.kind === "live-folder") return { mode: "per-window", openIn: "new", existingFolder: target.folder };
  if (target.kind === "current") {
    // The window's own shape is the mode — nothing is being laid out, so the repo
    // count has no say. A window that lost its identity between the pick and here
    // has no seed destination left, so the launch cancels rather than opening
    // something the user didn't choose.
    const here = deps.currentWindow();
    if (!here) return undefined;
    return { mode: here.kind === "workspace" ? "multiroot" : "per-window", openIn: "current", currentWindow: here };
  }
  const mode = await deps.chooseWorkspaceMode(count);
  if (!mode) return undefined;
  return { mode, openIn: "new" };
}
