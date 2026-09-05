import { describe, expect, it, vi } from "vitest";
import * as vscode from "../_mocks/vscode";
import {
  currentSpec, installedSchedule, maybeOfferScheduleRefresh, NOT_NOW, REMOVE, SCHEDULE, ScheduleHost,
  scheduleTickCommand, settingsFor, STALE_NOTICE_KEY, UPDATE,
} from "../../src/scheduleTick";
import { SCHEDULE_LABEL } from "../../src/engine/orchestrator/schedule";

const EXT = "/Users/me/.cursor/extensions/oznasi1.agent-flow-0.69.0";
const PLIST = `/Users/me/Library/LaunchAgents/${SCHEDULE_LABEL}.plist`;
const CURSOR_SETTINGS = "/Users/me/Library/Application Support/Cursor/User/settings.json";

/** A Mac with Cursor, a Homebrew node, and this build installed. `files` is the
 * disk; `ran` records every scheduler command in order. */
function fakeHost(over: Partial<ScheduleHost> & { files?: Record<string, string> } = {}) {
  const files: Record<string, string> = {
    [`${EXT}/dist/tick.js`]: "// tick",
    [CURSOR_SETTINGS]: '{ "agentFlow.orchestrator": true }',
    ...(over.files ?? {}),
  };
  const ran: string[][] = [];
  const host: ScheduleHost = {
    platform: "darwin",
    home: "/Users/me",
    env: {},
    uid: 502,
    execPath: "/Applications/Cursor.app/Contents/MacOS/Cursor",
    appName: "Cursor",
    extensionPath: EXT,
    exists: (p) => p in files,
    read: (p) => files[p] ?? null,
    write: (p, t) => { files[p] = t; },
    remove: (p) => { delete files[p]; },
    run: vi.fn(async (argv: string[]) => { ran.push(argv); }),
    resolveBin: (name) => (name === "node" ? "/opt/homebrew/bin/node" : null),
    ...over,
  };
  return { host, files, ran };
}
const ctx = () => ({ globalState: vscode.makeMemento() }) as never;
const log = () => {};

describe("settingsFor", () => {
  it("picks this editor's settings.json among the platform's candidates, only if it exists", () => {
    const { host } = fakeHost();
    expect(settingsFor(host)).toBe(CURSOR_SETTINGS);
    expect(settingsFor({ ...host, appName: "Visual Studio Code" })).toBeUndefined();
    const code = fakeHost({ appName: "Visual Studio Code", files: { "/Users/me/Library/Application Support/Code/User/settings.json": "{}" } });
    expect(settingsFor(code.host)).toBe("/Users/me/Library/Application Support/Code/User/settings.json");
    const insiders = fakeHost({ appName: "Visual Studio Code - Insiders", files: { "/Users/me/Library/Application Support/Code - Insiders/User/settings.json": "{}" } });
    expect(settingsFor(insiders.host)).toContain("Code - Insiders");
  });

  it("ignores a shell-only AGENT_FLOW_SETTINGS override — the scheduler will not inherit it", () => {
    const { host } = fakeHost({ env: { AGENT_FLOW_SETTINGS: "/x/settings.json" }, files: { "/x/settings.json": "{}" } });
    expect(settingsFor(host)).toBe(CURSOR_SETTINGS);
  });
});

describe("currentSpec", () => {
  it("prefers a real node and puts its directory first on the PATH it carries", () => {
    const s = currentSpec(fakeHost().host, 5);
    expect(s.node).toBe("/opt/homebrew/bin/node");
    expect(s.env.PATH!.split(":")[0]).toBe("/opt/homebrew/bin");
    expect(s.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(s.tickJs).toBe(`${EXT}/dist/tick.js`);
    expect(s.settings).toBe(CURSOR_SETTINGS);
    expect(s.uid).toBe(502);
  });

  it("falls back to the editor's own runtime as Node when none is found", () => {
    const s = currentSpec(fakeHost({ resolveBin: () => null }).host, 5);
    expect(s.node).toBe("/Applications/Cursor.app/Contents/MacOS/Cursor");
    expect(s.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("carries no PATH on Windows", () => {
    const s = currentSpec(fakeHost({ platform: "win32", home: "C:\\Users\\me", resolveBin: () => null }).host, 5);
    expect(s.env.PATH).toBeUndefined();
  });
});

describe("installedSchedule", () => {
  it("is undefined with nothing on disk, and reads the marker back otherwise", async () => {
    const f = fakeHost();
    expect(installedSchedule(f.host)).toBeUndefined();
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: "Every 15 minutes" });
    vscode.window.showWarningMessage.mockResolvedValueOnce(SCHEDULE);
    await scheduleTickCommand(f.host, log);
    expect(installedSchedule(f.host)).toEqual({ file: PLIST, tickJs: `${EXT}/dist/tick.js`, intervalMinutes: 15 });
  });

  it("reports a hand-written file with neither fact", () => {
    const f = fakeHost({ files: { [PLIST]: "<plist/>" } });
    expect(installedSchedule(f.host)).toEqual({ file: PLIST, tickJs: undefined, intervalMinutes: undefined });
  });
});

describe("scheduleTickCommand", () => {
  it("offers the intervals with the recommended one marked, and no Remove when nothing is installed", async () => {
    await scheduleTickCommand(fakeHost().host, log);
    const items = vscode.window.showQuickPick.mock.calls[0][0] as { label: string; description?: string }[];
    expect(items.map((i) => i.label)).toEqual(["Every 2 minutes", "Every 5 minutes", "Every 15 minutes", "Every 30 minutes"]);
    expect(items.find((i) => i.label === "Every 5 minutes")?.description).toBe("recommended");
  });

  it("does nothing when the pick is dismissed", async () => {
    const f = fakeHost();
    await scheduleTickCommand(f.host, log);
    expect(f.ran).toEqual([]);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("confirms with the recipe's own summary, then writes the plist and loads it", async () => {
    const f = fakeHost();
    const lines: string[] = [];
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: "Every 5 minutes" });
    vscode.window.showWarningMessage.mockResolvedValueOnce(SCHEDULE);
    await scheduleTickCommand(f.host, (m) => lines.push(m));
    const [msg, opts, button] = vscode.window.showWarningMessage.mock.calls[0] as [string, { modal: boolean; detail: string }, string];
    expect(msg).toContain("every 5 minutes");
    expect(opts.modal).toBe(true);
    expect(opts.detail).toContain(PLIST);
    expect(opts.detail).toContain(CURSOR_SETTINGS);
    expect(opts.detail).not.toContain("OFF");
    expect(button).toBe(SCHEDULE);
    expect(f.files[PLIST]).toContain("<integer>300</integer>");
    expect(f.ran).toEqual([
      ["launchctl", "bootout", `gui/502/${SCHEDULE_LABEL}`],
      ["launchctl", "bootstrap", "gui/502", PLIST],
    ]);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("/Users/me/.agentflow/tick.log"));
    expect(lines.some((l) => l.includes("installed launchd every 5m"))).toBe(true);
  });

  it("warns in the confirmation when agentFlow.orchestrator is off in the file the tick will read", async () => {
    const f = fakeHost({ files: { [CURSOR_SETTINGS]: "{ }" } });
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: "Every 5 minutes" });
    await scheduleTickCommand(f.host, log);
    const opts = vscode.window.showWarningMessage.mock.calls[0][1] as { detail: string };
    expect(opts.detail).toContain("agentFlow.orchestrator is OFF");
  });

  it("writes nothing when the confirmation is declined", async () => {
    const f = fakeHost();
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: "Every 5 minutes" });
    await scheduleTickCommand(f.host, log);
    expect(f.files[PLIST]).toBeUndefined();
    expect(f.ran).toEqual([]);
  });

  it("refuses to schedule a build with no tick.js", async () => {
    const f = fakeHost();
    delete f.files[`${EXT}/dist/tick.js`];
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: "Every 5 minutes" });
    await scheduleTickCommand(f.host, log);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("missing"));
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("swallows a failing optional step and reports a failing required one, leaving the files for the manual path", async () => {
    const f = fakeHost();
    (f.host.run as ReturnType<typeof vi.fn>).mockImplementation(async (argv: string[]) => {
      f.ran.push(argv);
      if (argv[1] === "bootout") throw new Error("Boot-out failed: 3: No such process");
      if (argv[1] === "bootstrap") throw new Error("Bootstrap failed: 5: Input/output error");
    });
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: "Every 5 minutes" });
    vscode.window.showWarningMessage.mockResolvedValueOnce(SCHEDULE);
    const lines: string[] = [];
    await scheduleTickCommand(f.host, (m) => lines.push(m));
    expect(f.files[PLIST]).toBeDefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Input/output error"));
    expect(lines.some((l) => l.includes("bootout") && l.includes("ignored"))).toBe(true);
  });

  it("marks the current interval, offers Remove, and removing runs bootout and deletes the file", async () => {
    const f = fakeHost();
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: "Every 15 minutes" });
    vscode.window.showWarningMessage.mockResolvedValueOnce(SCHEDULE);
    await scheduleTickCommand(f.host, log);
    f.ran.length = 0;
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: REMOVE });
    await scheduleTickCommand(f.host, log);
    const items = vscode.window.showQuickPick.mock.calls[1][0] as { label: string; detail?: string }[];
    expect(items.find((i) => i.label === "Every 15 minutes")?.detail).toBe("the current schedule");
    expect(items.at(-1)).toEqual({ label: REMOVE, detail: PLIST });
    expect(f.ran).toEqual([["launchctl", "bootout", `gui/502/${SCHEDULE_LABEL}`]]);
    expect(f.files[PLIST]).toBeUndefined();
    expect(vscode.window.showInformationMessage).toHaveBeenLastCalledWith(expect.stringContaining("removed"));
  });

  it("reports a failed removal", async () => {
    const f = fakeHost({ files: { [PLIST]: `agentflow-tick tick="${EXT}/dist/tick.js" every=5m` } });
    (f.host.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("nope"));
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: REMOVE });
    await scheduleTickCommand(f.host, log);
    // The one remove step is optional, so a failure is logged and the file still goes.
    expect(f.files[PLIST]).toBeUndefined();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("removed"));
  });

  it("writes the systemd pair on Linux and enables the timer", async () => {
    const f = fakeHost({ platform: "linux", home: "/home/me", appName: "Visual Studio Code", files: { "/home/me/.config/Code/User/settings.json": "{}" } });
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: "Every 2 minutes" });
    vscode.window.showWarningMessage.mockResolvedValueOnce(SCHEDULE);
    await scheduleTickCommand(f.host, log);
    expect(Object.keys(f.files).filter((p) => p.includes("systemd"))).toEqual([
      "/home/me/.config/systemd/user/agentflow-tick.service",
      "/home/me/.config/systemd/user/agentflow-tick.timer",
    ]);
    expect(f.ran.at(-1)).toEqual(["systemctl", "--user", "enable", "--now", "agentflow-tick.timer"]);
  });
});

describe("maybeOfferScheduleRefresh", () => {
  const OLD = "/Users/me/.cursor/extensions/oznasi1.agent-flow-0.68.0/dist/tick.js";
  const stale = () => fakeHost({ files: { [PLIST]: `agentflow-tick tick=${JSON.stringify(OLD)} every=15m` } });

  it("says nothing with no schedule, a current one, or a hand-written one", async () => {
    await maybeOfferScheduleRefresh(ctx(), fakeHost().host, log);
    await maybeOfferScheduleRefresh(ctx(), fakeHost({ files: { [PLIST]: `agentflow-tick tick=${JSON.stringify(`${EXT}/dist/tick.js`)} every=5m` } }).host, log);
    await maybeOfferScheduleRefresh(ctx(), fakeHost({ files: { [PLIST]: "<plist/>" } }).host, log);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("says nothing when this build has no tick.js to point at", async () => {
    const f = stale();
    delete f.files[`${EXT}/dist/tick.js`];
    await maybeOfferScheduleRefresh(ctx(), f.host, log);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("offers once per stale path, naming the old one and the kept interval", async () => {
    const c = ctx();
    const f = stale();
    vscode.window.showInformationMessage.mockResolvedValueOnce(NOT_NOW);
    await maybeOfferScheduleRefresh(c, f.host, log);
    await maybeOfferScheduleRefresh(c, f.host, log);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    const [msg, ...buttons] = vscode.window.showInformationMessage.mock.calls[0] as string[];
    expect(msg).toContain(OLD);
    expect(msg).toContain("every 15 minutes");
    expect(buttons).toEqual([UPDATE, NOT_NOW]);
    expect((c as { globalState: { _store: Record<string, unknown> } }).globalState._store[STALE_NOTICE_KEY]).toBe(OLD);
    expect(f.files[PLIST]).toContain(OLD);
  });

  it("re-installs at the same interval on Update", async () => {
    const f = stale();
    vscode.window.showInformationMessage.mockResolvedValueOnce(UPDATE);
    await maybeOfferScheduleRefresh(ctx(), f.host, log);
    expect(f.files[PLIST]).toContain(`${EXT}/dist/tick.js`);
    expect(f.files[PLIST]).toContain("<integer>900</integer>");
    expect(f.ran.at(-1)).toEqual(["launchctl", "bootstrap", "gui/502", PLIST]);
  });

  it("logs rather than throws when the re-install fails", async () => {
    const f = stale();
    (f.host.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("launchd is unhappy"));
    vscode.window.showInformationMessage.mockResolvedValueOnce(UPDATE);
    const lines: string[] = [];
    await expect(maybeOfferScheduleRefresh(ctx(), f.host, (m) => lines.push(m))).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes("launchd is unhappy"))).toBe(true);
  });
});
