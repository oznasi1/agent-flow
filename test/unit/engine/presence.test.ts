import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import { windowIdentity, writePresence, removePresence, readLiveWindows, type PresenceRecord } from "../../../src/engine/presence";
import { workspace } from "../../_mocks/vscode";

vi.mock("fs");

const readdirSync = vi.mocked(fs.readdirSync);
const readFileSync = vi.mocked(fs.readFileSync);
const writeFileSync = vi.mocked(fs.writeFileSync);
const mkdirSync = vi.mocked(fs.mkdirSync);
const rmSync = vi.mocked(fs.rmSync);
const realpathSync = vi.mocked(fs.realpathSync);

const rec = (over: Partial<PresenceRecord> = {}): PresenceRecord => ({
  pid: 111, identity: "/repos/foo", kind: "folder", label: "foo", folders: 1, updatedAt: 10, ...over,
});

beforeEach(() => {
  readdirSync.mockReset().mockReturnValue([] as never);
  readFileSync.mockReset().mockReturnValue("");
  writeFileSync.mockReset();
  mkdirSync.mockReset();
  rmSync.mockReset();
  realpathSync.mockReset().mockImplementation((p) => String(p)); // identity canon
  workspace.workspaceFile = undefined;
  workspace.workspaceFolders = undefined;
});

describe("windowIdentity", () => {
  it("is a workspace identity when a .code-workspace file is open", () => {
    workspace.workspaceFile = { scheme: "file", fsPath: "/ws/team.code-workspace" };
    workspace.workspaceFolders = [{ uri: { fsPath: "/repos/a" } }, { uri: { fsPath: "/repos/b" } }];
    expect(windowIdentity()).toEqual({ identity: "/ws/team.code-workspace", kind: "workspace", label: "team.code-workspace", folders: 2 });
  });

  it("is a folder identity for a single-folder window", () => {
    workspace.workspaceFolders = [{ uri: { fsPath: "/repos/foo" } }];
    expect(windowIdentity()).toEqual({ identity: "/repos/foo", kind: "folder", label: "foo", folders: 1 });
  });

  it("is undefined for an empty window", () => {
    expect(windowIdentity()).toBeUndefined();
  });

  it("is undefined for an untitled (non-file) workspace", () => {
    workspace.workspaceFile = { scheme: "untitled", fsPath: "/x" };
    workspace.workspaceFolders = [{ uri: { fsPath: "/repos/a" } }, { uri: { fsPath: "/repos/b" } }];
    expect(windowIdentity()).toBeUndefined();
  });
});

describe("writePresence / removePresence", () => {
  it("writes <pid>.json under the dir", () => {
    writePresence("/win", rec({ pid: 222 }));
    expect(mkdirSync).toHaveBeenCalledWith("/win", { recursive: true });
    const call = writeFileSync.mock.calls.find((c) => String(c[0]) === "/win/222.json");
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1])).identity).toBe("/repos/foo");
  });

  it("never throws when the write fails", () => {
    writeFileSync.mockImplementation(() => { throw new Error("EACCES"); });
    expect(() => writePresence("/win", rec())).not.toThrow();
  });

  it("removes <pid>.json", () => {
    removePresence("/win", 222);
    expect(rmSync).toHaveBeenCalledWith("/win/222.json", { force: true });
  });
});

describe("readLiveWindows", () => {
  it("returns [] when the dir can't be read", () => {
    readdirSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(readLiveWindows("/win")).toEqual([]);
  });

  it("keeps live pids, prunes dead ones, dedupes identity, newest first", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid: number) => {
      if (pid === 999) { const e: NodeJS.ErrnoException = new Error("dead"); e.code = "ESRCH"; throw e; }
      return true as never;
    });
    readdirSync.mockReturnValue(["111.json", "222.json", "999.json", "notes.txt"] as never);
    readFileSync.mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith("111.json")) return JSON.stringify(rec({ pid: 111, identity: "/repos/a", updatedAt: 5 }));
      if (s.endsWith("222.json")) return JSON.stringify(rec({ pid: 222, identity: "/repos/b", updatedAt: 9 }));
      if (s.endsWith("999.json")) return JSON.stringify(rec({ pid: 999, identity: "/repos/c", updatedAt: 9 }));
      return "";
    });

    const live = readLiveWindows("/win");

    expect(live.map((w) => w.identity)).toEqual(["/repos/b", "/repos/a"]); // dead 999 pruned, newest first
    expect(rmSync).toHaveBeenCalledWith("/win/999.json", { force: true });
    killSpy.mockRestore();
  });

  it("prunes an unparseable record file", () => {
    vi.spyOn(process, "kill").mockReturnValue(true as never);
    readdirSync.mockReturnValue(["bad.json"] as never);
    readFileSync.mockReturnValue("{ not json");
    expect(readLiveWindows("/win")).toEqual([]);
    expect(rmSync).toHaveBeenCalledWith("/win/bad.json", { force: true });
  });

  it("keeps the NEWEST record when two live records share an identity", () => {
    vi.spyOn(process, "kill").mockReturnValue(true as never);
    // readdir lists the OLDER one first — a first-seen dedupe would wrongly keep it.
    readdirSync.mockReturnValue(["111.json", "222.json"] as never);
    readFileSync.mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith("111.json")) return JSON.stringify(rec({ pid: 111, identity: "/repos/a", updatedAt: 5 }));
      if (s.endsWith("222.json")) return JSON.stringify(rec({ pid: 222, identity: "/repos/a", updatedAt: 20 }));
      return "";
    });

    const live = readLiveWindows("/win");

    expect(live).toHaveLength(1);
    expect(live[0].pid).toBe(222);
    expect(live[0].updatedAt).toBe(20);
  });

  it("prunes a record with a non-positive or non-numeric pid", () => {
    vi.spyOn(process, "kill").mockReturnValue(true as never);
    readdirSync.mockReturnValue(["bad-pid.json"] as never);
    readFileSync.mockReturnValue(JSON.stringify(rec({ pid: 0, identity: "/repos/a" })));
    expect(readLiveWindows("/win")).toEqual([]);
    expect(rmSync).toHaveBeenCalledWith("/win/bad-pid.json", { force: true });
  });

  it("never throws when pruning a dead-pid file fails", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid: number) => {
      if (pid === 999) { const e: NodeJS.ErrnoException = new Error("dead"); e.code = "ESRCH"; throw e; }
      return true as never;
    });
    readdirSync.mockReturnValue(["111.json", "999.json"] as never);
    readFileSync.mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith("111.json")) return JSON.stringify(rec({ pid: 111, identity: "/repos/a", updatedAt: 5 }));
      if (s.endsWith("999.json")) return JSON.stringify(rec({ pid: 999, identity: "/repos/c", updatedAt: 9 }));
      return "";
    });
    rmSync.mockImplementation((p) => {
      if (String(p).endsWith("999.json")) throw new Error("EBUSY");
    });

    let live: PresenceRecord[] = [];
    expect(() => { live = readLiveWindows("/win"); }).not.toThrow();
    expect(live.map((w) => w.identity)).toEqual(["/repos/a"]);
    killSpy.mockRestore();
  });
});
