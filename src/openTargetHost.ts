import * as vscode from "vscode";
import { listWorkspaceFiles } from "./engine/workspace";
import { currentWindow, defaultWindowsDir, readLiveWindows, windowIdentity, type PresenceRecord } from "./engine/presence";
import { pickExistingWorkspace, type ChooseOpenTargetDeps, type OpenTarget } from "./engine/openTarget";

/** The host-side bindings for engine/openTarget: the `vscode` pickers and the presence
 * reads that its pure functions take as arguments. One definition, because both callers
 * of the destination question — Take in the sidebar and **Review with agent** on the
 * Deck — must ask it with the same pickers, and a second copy of these five lines is
 * exactly how the two would drift.
 *
 * `toast` is the one dep left to the caller: each view words its own. */

/** `showQuickPick`, with the `ignoreFocusOut` every launch picker in the product uses —
 * a destination question that vanishes when you glance at another window is a launch
 * cancelled by accident. */
export function vscodePick<T extends { label: string; detail?: string }>(
  items: T[],
  opts: { title: string; placeHolder: string },
): Promise<T | undefined> {
  return Promise.resolve(vscode.window.showQuickPick(items, { ...opts, ignoreFocusOut: true }));
}

/** Live Agent-Flow windows other than this one. Also the sidebar's gauge count. */
export function liveWindowsElsewhere(): PresenceRecord[] {
  const self = windowIdentity()?.identity;
  return readLiveWindows(defaultWindowsDir()).filter((w) => w.identity !== self);
}

/** Pick a `.code-workspace` from `workspaceDir`, or browse the filesystem for one. */
export function pickWorkspaceFile(workspaceDir: string): Promise<OpenTarget | undefined> {
  return pickExistingWorkspace(workspaceDir, {
    listWorkspaceFiles,
    pick: vscodePick,
    browse: async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { "VS Code Workspace": ["code-workspace"] },
        title: "Pick a .code-workspace",
      });
      return uris?.length ? uris[0].fsPath : undefined;
    },
  });
}

/** Everything `chooseOpenTarget` asks for, bound to this editor. */
export function openTargetDeps(workspaceDir: string, toast: (message: string) => void): ChooseOpenTargetDeps {
  return {
    currentWindow,
    liveWindows: liveWindowsElsewhere,
    pick: vscodePick,
    pickExistingWorkspace: () => pickWorkspaceFile(workspaceDir),
    toast,
  };
}
