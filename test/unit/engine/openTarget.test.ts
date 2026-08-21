import { describe, it, expect, vi } from "vitest";
import {
  chooseOpenTarget,
  targetToOpenArgs,
  liveWindowItems,
  NO_IDENTITY_TOAST,
  type OpenTarget,
} from "../../../src/engine/openTarget";
import type { CurrentWindow, PresenceRecord } from "../../../src/engine/presence";

const HERE: CurrentWindow = {
  identity: "/repos/account-service",
  kind: "folder",
  roots: [{ name: "account-service", path: "/repos/account-service" }],
};

const HERE_WS: CurrentWindow = {
  identity: "/ws/team.code-workspace",
  kind: "workspace",
  roots: [{ name: "a", path: "/repos/a" }, { name: "b", path: "/repos/b" }],
};

const rec = (over: Partial<PresenceRecord> = {}): PresenceRecord => ({
  identity: "/repos/bite-me",
  kind: "folder",
  label: "bite-me",
  folders: 1,
  pid: 42,
  updatedAt: 1,
  ...over,
});

// `pick` mirrors what the views hand in: vscode.window.showQuickPick, minus the
// `ignoreFocusOut` the adapter adds. Returning undefined is a dismissed picker.
const deps = (over: Record<string, unknown> = {}) => ({
  currentWindow: vi.fn((): CurrentWindow | undefined => HERE),
  liveWindows: vi.fn((): PresenceRecord[] => []),
  // `any` because the real dep is generic in the item type and a vi.fn() cannot be —
  // the alternative is casting at all eleven call sites below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pick: vi.fn(async (_items: any[], _opts: any): Promise<any> => undefined),
  pickExistingWorkspace: vi.fn(async (): Promise<OpenTarget | undefined> => undefined),
  toast: vi.fn((_m: string) => {}),
  ...over,
});

const COPY = { title: "Open the task where?", placeHolder: "New window, this window, a saved workspace, or a window you have open" };

describe("chooseOpenTarget", () => {
  it("answers 'new' from the setting without asking anything", async () => {
    const d = deps();
    expect(await chooseOpenTarget({ openIn: "new-window", trackOpenWindows: true, ...COPY }, d)).toEqual({ kind: "new" });
    expect(d.pick).not.toHaveBeenCalled();
  });

  it("answers 'current' from the setting when this window has an identity", async () => {
    const d = deps();
    expect(await chooseOpenTarget({ openIn: "this-window", trackOpenWindows: true, ...COPY }, d)).toEqual({ kind: "current" });
    expect(d.pick).not.toHaveBeenCalled();
  });

  // A window with no identity can't be named by a plan match, so it can't hold a
  // seeded session — the setting must not be able to force it.
  it("degrades a forced 'this-window' to a new window, and says so", async () => {
    const d = deps({ currentWindow: vi.fn(() => undefined) });
    expect(await chooseOpenTarget({ openIn: "this-window", trackOpenWindows: true, ...COPY }, d)).toEqual({ kind: "new" });
    expect(d.toast).toHaveBeenCalledWith(NO_IDENTITY_TOAST);
  });

  it("delegates 'pick-existing' straight to the workspace-file picker", async () => {
    const d = deps({ pickExistingWorkspace: vi.fn(async () => ({ kind: "existing", file: "/ws/team.code-workspace" })) });
    expect(await chooseOpenTarget({ openIn: "pick-existing", trackOpenWindows: true, ...COPY }, d)).toEqual({
      kind: "existing",
      file: "/ws/team.code-workspace",
    });
    expect(d.pick).not.toHaveBeenCalled();
  });

  describe("the ask picker", () => {
    it("offers New window, This window and Existing workspace…, in that order", async () => {
      const d = deps();
      await chooseOpenTarget({ openIn: "ask", trackOpenWindows: false, ...COPY }, d);
      const items = d.pick.mock.calls[0][0] as { label: string; detail: string }[];
      expect(items.map((i) => i.label)).toEqual([
        "$(empty-window) New window",
        "$(window) This window",
        "$(folder-library) Existing workspace…",
      ]);
      expect(items[1].detail).toBe("Start a session here — keeps this window's folders");
    });

    it("forwards the caller's title and placeholder", async () => {
      const d = deps();
      await chooseOpenTarget({ openIn: "ask", trackOpenWindows: false, title: "Review aws-ops#8491 — open where?", placeHolder: "somewhere" }, d);
      expect(d.pick.mock.calls[0][1]).toEqual({ title: "Review aws-ops#8491 — open where?", placeHolder: "somewhere" });
    });

    it("omits This window when this window has no identity", async () => {
      const d = deps({ currentWindow: vi.fn(() => undefined) });
      await chooseOpenTarget({ openIn: "ask", trackOpenWindows: false, ...COPY }, d);
      const items = d.pick.mock.calls[0][0] as { label: string }[];
      expect(items.some((i) => i.label.includes("This window"))).toBe(false);
      // Not a degradation — the user is being asked, so there is nothing to explain.
      expect(d.toast).not.toHaveBeenCalled();
    });

    it("appends the live windows after the fixed three", async () => {
      const d = deps({ liveWindows: vi.fn(() => [rec()]) });
      await chooseOpenTarget({ openIn: "ask", trackOpenWindows: true, ...COPY }, d);
      const items = d.pick.mock.calls[0][0] as { label: string }[];
      expect(items.map((i) => i.label).at(-1)).toBe("$(window) bite-me");
    });

    it("reads no live windows when presence tracking is off", async () => {
      const d = deps({ liveWindows: vi.fn(() => [rec()]) });
      await chooseOpenTarget({ openIn: "ask", trackOpenWindows: false, ...COPY }, d);
      expect(d.liveWindows).not.toHaveBeenCalled();
    });

    it("routes the Existing workspace… item to the workspace-file picker", async () => {
      const d = deps({ pickExistingWorkspace: vi.fn(async () => ({ kind: "existing", file: "/ws/x.code-workspace" })) });
      d.pick.mockResolvedValueOnce({ target: { kind: "existing-pick" } });
      expect(await chooseOpenTarget({ openIn: "ask", trackOpenWindows: false, ...COPY }, d)).toEqual({
        kind: "existing",
        file: "/ws/x.code-workspace",
      });
    });

    it("returns the picked target as-is for every other item", async () => {
      const d = deps();
      d.pick.mockResolvedValueOnce({ target: { kind: "current" } });
      expect(await chooseOpenTarget({ openIn: "ask", trackOpenWindows: false, ...COPY }, d)).toEqual({ kind: "current" });
    });

    it("answers undefined when dismissed, so the caller opens nothing", async () => {
      const d = deps();
      expect(await chooseOpenTarget({ openIn: "ask", trackOpenWindows: false, ...COPY }, d)).toBeUndefined();
      expect(d.pickExistingWorkspace).not.toHaveBeenCalled();
    });
  });
});

describe("liveWindowItems", () => {
  it("sends a workspace window down the merge+focus path and a folder window down the seed-in-place one", () => {
    const items = liveWindowItems([
      rec({ identity: "/ws/team.code-workspace", kind: "workspace", label: "team.code-workspace", folders: 4 }),
      rec({ identity: "/repos/bite-me", kind: "folder", label: "bite-me", folders: 1 }),
    ]);
    expect(items).toEqual([
      { label: "$(window) team.code-workspace", detail: "open now · 4 folders", target: { kind: "existing", file: "/ws/team.code-workspace" } },
      { label: "$(window) bite-me", detail: "open now", target: { kind: "live-folder", folder: "/repos/bite-me" } },
    ]);
  });

  it("says folder, not folders, for a one-folder workspace window", () => {
    const items = liveWindowItems([rec({ kind: "workspace", folders: 1 })]);
    expect(items[0].detail).toBe("open now · 1 folder");
  });
});

describe("targetToOpenArgs", () => {
  const argDeps = (over: Record<string, unknown> = {}) => ({
    currentWindow: vi.fn((): CurrentWindow | undefined => HERE),
    chooseWorkspaceMode: vi.fn(async (_count: number) => "per-window" as const),
    ...over,
  });

  it("maps an existing workspace to a multiroot open in a new window", async () => {
    expect(await targetToOpenArgs({ kind: "existing", file: "/ws/team.code-workspace" }, 2, argDeps())).toEqual({
      mode: "multiroot",
      openIn: "new",
      existingWorkspaceFile: "/ws/team.code-workspace",
    });
  });

  it("maps a live folder window to a per-window open of that folder", async () => {
    expect(await targetToOpenArgs({ kind: "live-folder", folder: "/repos/bite-me" }, 2, argDeps())).toEqual({
      mode: "per-window",
      openIn: "new",
      existingFolder: "/repos/bite-me",
    });
  });

  // The window's own shape is the mode — nothing is being laid out, so the repo count
  // has no say and the mode picker must stay away.
  it("takes the mode from this window's shape, not the repo count", async () => {
    const d = argDeps({ currentWindow: vi.fn(() => HERE_WS) });
    expect(await targetToOpenArgs({ kind: "current" }, 3, d)).toEqual({
      mode: "multiroot",
      openIn: "current",
      currentWindow: HERE_WS,
    });
    expect(d.chooseWorkspaceMode).not.toHaveBeenCalled();
  });

  it("cancels when this window lost its identity between the pick and here", async () => {
    expect(await targetToOpenArgs({ kind: "current" }, 1, argDeps({ currentWindow: vi.fn(() => undefined) }))).toBeUndefined();
  });

  it("asks how to lay out a new window", async () => {
    const d = argDeps({ chooseWorkspaceMode: vi.fn(async () => "multiroot" as const) });
    expect(await targetToOpenArgs({ kind: "new" }, 3, d)).toEqual({ mode: "multiroot", openIn: "new" });
    expect(d.chooseWorkspaceMode).toHaveBeenCalledWith(3);
  });

  it("cancels when the layout sub-pick is dismissed", async () => {
    expect(await targetToOpenArgs({ kind: "new" }, 3, argDeps({ chooseWorkspaceMode: vi.fn(async () => undefined) }))).toBeUndefined();
  });
});
