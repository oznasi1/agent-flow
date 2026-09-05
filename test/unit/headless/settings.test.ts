import { describe, it, expect } from "vitest";
import { candidateSettingsPaths, loadSettings, readerFor, SettingsIo } from "../../../src/headless/settings";

const io = (files: Record<string, string>): SettingsIo => ({ exists: (p) => p in files, read: (p) => files[p] });

describe("candidateSettingsPaths", () => {
  it("tries an explicit environment override first, then each editor's user settings for the platform", () => {
    expect(candidateSettingsPaths("darwin", "/Users/me", { AGENT_FLOW_SETTINGS: "/x/settings.json" })).toEqual([
      "/x/settings.json",
      "/Users/me/Library/Application Support/Code/User/settings.json",
      "/Users/me/Library/Application Support/Code - Insiders/User/settings.json",
      "/Users/me/Library/Application Support/Cursor/User/settings.json",
    ]);
    expect(candidateSettingsPaths("linux", "/home/me", {})[0]).toBe("/home/me/.config/Code/User/settings.json");
    expect(candidateSettingsPaths("win32", "C:\\Users\\me", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" })[0])
      .toContain("Code");
  });
});

describe("loadSettings", () => {
  it("reads the first existing candidate, as JSONC, and exposes agentFlow.* keys through the reader", () => {
    const files = {
      "/home/me/.config/Cursor/User/settings.json": `{
        // a comment, as the editor writes them
        "agentFlow.orchestrator": true,
        "agentFlow.commands": [{ "id": "deploy", "run": "deploy.sh" }],
      }`,
    };
    const loaded = loadSettings(undefined, io(files), "linux", "/home/me", {});
    if ("error" in loaded) throw new Error(loaded.error);
    expect(loaded.path).toBe("/home/me/.config/Cursor/User/settings.json");
    expect(loaded.reader.get("orchestrator")).toBe(true);
    expect(loaded.reader.get("commands")).toEqual([{ id: "deploy", run: "deploy.sh" }]);
    expect(loaded.reader.get("nope")).toBeUndefined();
  });

  it("an explicit path is authoritative — missing is an error, never a fallback to another editor's file", () => {
    const files = { "/home/me/.config/Code/User/settings.json": "{}" };
    const r = loadSettings("/nowhere/settings.json", io(files), "linux", "/home/me", {});
    expect(r).toEqual({ error: "no settings file at /nowhere/settings.json" });
  });

  it("says where it looked when nothing exists", () => {
    const r = loadSettings(undefined, io({}), "linux", "/home/me", {});
    expect("error" in r && r.error).toMatch(/no editor settings\.json found — looked in: .*Code\/User\/settings\.json.*Pass --settings/);
  });

  it("refuses a file that is not a settings object", () => {
    expect(loadSettings("/s.json", io({ "/s.json": "[1,2]" }))).toEqual({ error: "/s.json is not a settings object" });
  });
});

describe("readerFor", () => {
  it("reads flat dotted keys and a nested agentFlow object alike, flat winning", () => {
    const r = readerFor({ "agentFlow.forge": "gitlab", agentFlow: { forge: "github", prFacts: false } });
    expect(r.get("forge")).toBe("gitlab");
    expect(r.get("prFacts")).toBe(false);
  });
});
