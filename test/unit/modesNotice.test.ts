import { describe, expect, it, vi } from "vitest";
import * as vscode from "../_mocks/vscode";
import { DEFAULT_PROMPT_MODES } from "../../src/config";
import {
  affectedFromInspect,
  LAYERING_DOCS_URL,
  maybeShowModesNotice,
  MODES_NOTICE_KEY,
  pickExplicit,
} from "../../src/modesNotice";

function ctx() {
  return { globalState: vscode.makeMemento() } as never;
}

describe("pickExplicit", () => {
  it("prefers a folder value over workspace and global", () => {
    expect(pickExplicit({ key: "k", workspaceFolderValue: "f", workspaceValue: "w", globalValue: "g" })).toEqual({
      value: "f",
      target: vscode.ConfigurationTarget.WorkspaceFolder,
    });
  });

  it("prefers a workspace value over global", () => {
    expect(pickExplicit({ key: "k", workspaceValue: "w", globalValue: "g" })).toEqual({
      value: "w",
      target: vscode.ConfigurationTarget.Workspace,
    });
  });

  it("falls back to the global value", () => {
    expect(pickExplicit({ key: "k", globalValue: "g" })).toEqual({
      value: "g",
      target: vscode.ConfigurationTarget.Global,
    });
  });

  it("reports nothing when no scope holds a value", () => {
    expect(pickExplicit({ key: "k" })).toBeUndefined();
    expect(pickExplicit(undefined)).toBeUndefined();
  });
});

describe("affectedFromInspect", () => {
  const ids = DEFAULT_PROMPT_MODES.map((m) => m.id);

  it("reports the built-ins a pruned list omits", () => {
    const a = affectedFromInspect(
      { key: "promptModes", globalValue: [{ id: "plan" }, { id: "implementation" }] },
      "promptModes",
      DEFAULT_PROMPT_MODES,
    );
    expect(a?.missing).toEqual(ids.slice(2));
    expect(a?.target).toBe(vscode.ConfigurationTarget.Global);
  });

  it("treats an id the user already hid as listed, not missing", () => {
    const a = affectedFromInspect(
      { key: "promptModes", globalValue: DEFAULT_PROMPT_MODES.map((m) => ({ id: m.id, hidden: true })) },
      "promptModes",
      DEFAULT_PROMPT_MODES,
    );
    expect(a).toBeUndefined();
  });

  it("reports nothing for an untouched setting", () => {
    expect(affectedFromInspect({ key: "promptModes" }, "promptModes", DEFAULT_PROMPT_MODES)).toBeUndefined();
  });

  it("reports nothing for a non-array value", () => {
    expect(
      affectedFromInspect({ key: "promptModes", globalValue: "nope" }, "promptModes", DEFAULT_PROMPT_MODES),
    ).toBeUndefined();
  });

  it("reports nothing for an explicit empty array — it already resolved to the built-ins before this ever runs", () => {
    expect(
      affectedFromInspect({ key: "promptModes", globalValue: [] }, "promptModes", DEFAULT_PROMPT_MODES),
    ).toBeUndefined();
  });

  it("reports every built-in when the list names none of them", () => {
    const a = affectedFromInspect(
      { key: "promptModes", globalValue: [{ id: "spike", label: "S", prompt: "p" }] },
      "promptModes",
      DEFAULT_PROMPT_MODES,
    );
    expect(a?.missing).toEqual(ids);
  });

  it("ignores unusable entries when deciding what is listed", () => {
    const a = affectedFromInspect(
      { key: "promptModes", globalValue: [null, 42, {}, { id: "  plan  " }] },
      "promptModes",
      DEFAULT_PROMPT_MODES,
    );
    expect(a?.missing).toEqual(ids.slice(1));
  });
});

describe("maybeShowModesNotice", () => {
  it("says nothing while first-run setup is on screen, and does not mark itself shown", async () => {
    vscode.setConfig({ promptModes: [{ id: "plan" }] });
    const c = ctx();
    await maybeShowModesNotice(c, { setupRunning: true });
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect((c as any).globalState._store[MODES_NOTICE_KEY]).toBeUndefined();
  });

  it("says nothing to a user who never customized either setting", async () => {
    const c = ctx();
    await maybeShowModesNotice(c, { setupRunning: false });
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    // Not marked shown, so it can still fire if they customize later.
    expect((c as any).globalState._store[MODES_NOTICE_KEY]).toBeUndefined();
  });

  it("says nothing when the list already names every built-in", async () => {
    vscode.setConfig({ promptModes: DEFAULT_PROMPT_MODES.map((m) => ({ id: m.id })) });
    await maybeShowModesNotice(ctx(), { setupRunning: false });
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("says nothing for an explicit empty array — nothing changed for that user", async () => {
    // promptModes: [] already resolved to the built-ins before affectedFromInspect
    // ever runs (config.test.ts pins this), so this must not be told "6 new
    // modes are showing" for a setting that, in effect, was never customized.
    vscode.setConfig({ promptModes: [] });
    await maybeShowModesNotice(ctx(), { setupRunning: false });
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("shows once and records that it did", async () => {
    vscode.setConfig({ promptModes: [{ id: "plan" }] });
    const c = ctx();
    await maybeShowModesNotice(c, { setupRunning: false });
    await maybeShowModesNotice(c, { setupRunning: false });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect((c as any).globalState._store[MODES_NOTICE_KEY]).toBe(true);
  });

  it("counts the modes about to appear across both settings", async () => {
    vscode.setConfig({
      promptModes: [{ id: "plan" }],
      reviewRequestModes: [{ id: "backend", label: "B", prompt: "p" }],
    });
    await maybeShowModesNotice(ctx(), { setupRunning: false });
    const msg = vscode.window.showInformationMessage.mock.calls[0][0] as string;
    // 5 unlisted prompt modes plus the 1 unlisted review mode.
    expect(msg).toContain("6 new modes are showing");
    expect(msg).toMatch(/layer on top of the built-in ones/);
  });

  it("fires, and reads as singular, when only the review setting is affected", async () => {
    vscode.setConfig({ reviewRequestModes: [{ id: "backend", label: "B", prompt: "p" }] });
    await maybeShowModesNotice(ctx(), { setupRunning: false });
    expect(vscode.window.showInformationMessage.mock.calls[0][0]).toContain("1 new mode is showing");
  });

  it("opens the docs on 'What changed'", async () => {
    vscode.setConfig({ promptModes: [{ id: "plan" }] });
    vscode.window.showInformationMessage.mockResolvedValueOnce("What changed");
    await maybeShowModesNotice(ctx(), { setupRunning: false });
    // LAYERING_DOCS_URL pointed at a CHANGELOG with no matching entry for two
    // commits of this branch — asserting only that openExternal was called
    // would have missed that regression entirely.
    expect(String(vscode.env.openExternal.mock.calls[0][0])).toBe(LAYERING_DOCS_URL);
  });

  it("appends hidden entries for exactly the unlisted ids on 'Hide the new ones'", async () => {
    vscode.setConfig({ promptModes: [{ id: "plan" }] });
    vscode.window.showInformationMessage.mockResolvedValueOnce("Hide the new ones");
    await maybeShowModesNotice(ctx(), { setupRunning: false });
    expect(vscode.workspace.getConfiguration("agentFlow").get("promptModes")).toEqual([
      { id: "plan" },
      ...DEFAULT_PROMPT_MODES.slice(1).map((m) => ({ id: m.id, hidden: true })),
    ]);
  });

  it("writes each affected setting independently", async () => {
    vscode.setConfig({
      promptModes: [{ id: "plan" }],
      reviewRequestModes: [{ id: "backend", label: "B", prompt: "p" }],
    });
    vscode.window.showInformationMessage.mockResolvedValueOnce("Hide the new ones");
    await maybeShowModesNotice(ctx(), { setupRunning: false });
    expect(vscode.workspace.getConfiguration("agentFlow").get("reviewRequestModes")).toEqual([
      { id: "backend", label: "B", prompt: "p" },
      { id: "full", hidden: true },
    ]);
  });

  it("writes to the scope the user's value lives in", async () => {
    // The shared mock's `inspect` only ever reports a global value, so this pins
    // the target it passes to `update`; `pickExplicit` covers the other scopes.
    const update = vi.fn(async () => undefined);
    vscode.workspace.getConfiguration.mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn((key: string) =>
        key === "promptModes" ? { key, globalValue: [{ id: "plan" }] } : { key },
      ),
    } as never);
    vscode.window.showInformationMessage.mockResolvedValueOnce("Hide the new ones");
    await maybeShowModesNotice(ctx(), { setupRunning: false });
    expect(update).toHaveBeenCalledWith("promptModes", expect.any(Array), vscode.ConfigurationTarget.Global);
  });

  it("does nothing further when the notification is dismissed", async () => {
    vscode.setConfig({ promptModes: [{ id: "plan" }] });
    await maybeShowModesNotice(ctx(), { setupRunning: false });
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
    expect(vscode.workspace.getConfiguration("agentFlow").get("promptModes")).toEqual([{ id: "plan" }]);
  });

  it("never throws when the notification API fails", async () => {
    vscode.setConfig({ promptModes: [{ id: "plan" }] });
    vscode.window.showInformationMessage.mockRejectedValueOnce(new Error("boom"));
    await expect(maybeShowModesNotice(ctx(), { setupRunning: false })).resolves.toBeUndefined();
  });
});
