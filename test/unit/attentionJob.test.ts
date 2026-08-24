import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { commands, window } from "../_mocks/vscode";
import { AttentionPassDeps, runAttentionPass } from "../../src/attentionJob";
import { AttentionCandidate } from "../../src/engine/attention";

let dir: string;
let setAttention: ReturnType<typeof vi.fn>;
let logged: string[];

const cand = (key: string, over: Partial<AttentionCandidate> = {}): AttentionCandidate => ({
  key, agentState: "needs-you", prs: {}, ticketStatus: null,
  hasLiveSession: true, justLaunched: false, hasWorkToLose: false, showAll: false, ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "attentionjob-"));
  setAttention = vi.fn();
  logged = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const deps = (over: Partial<AttentionPassDeps> = {}): AttentionPassDeps => ({
  candidates: () => [],
  setAttention: setAttention as unknown as AttentionPassDeps["setAttention"],
  notify: false,
  focused: true,
  latchFile: path.join(dir, "attention.json"),
  nowMs: 1_000,
  log: (m: string) => logged.push(m),
  ...over,
});

describe("runAttentionPass: the badge", () => {
  it("badges what the reduction selected", () => {
    runAttentionPass(deps({ candidates: () => [cand("A"), cand("B", { agentState: "working" })] }));
    expect(setAttention).toHaveBeenCalledWith(["A"]);
  });

  it("badges zero when nothing is waiting", () => {
    runAttentionPass(deps({ candidates: () => [cand("A", { agentState: "working" })] }));
    expect(setAttention).toHaveBeenCalledWith([]);
  });

  it("badges even in an unfocused window — the badge is ambient, not an interrupt", () => {
    runAttentionPass(deps({ candidates: () => [cand("A")], focused: false }));
    expect(setAttention).toHaveBeenCalledWith(["A"]);
  });

  it("survives a throwing candidate source without taking the poll down", () => {
    runAttentionPass(deps({ candidates: () => { throw new Error("EACCES"); } }));
    expect(logged.join()).toContain("attention");
  });
});

describe("runAttentionPass: the notification", () => {
  it("stays silent when the setting is off, and writes no latch file", () => {
    const latchFile = path.join(dir, "attention.json");
    runAttentionPass(deps({ candidates: () => [cand("A")], notify: false, latchFile }));
    expect(window.showInformationMessage).not.toHaveBeenCalled();
    expect(fs.existsSync(latchFile)).toBe(false);
  });

  it("names the single run that parked", () => {
    runAttentionPass(deps({ candidates: () => [cand("BITE-42")], notify: true }));
    expect(window.showInformationMessage).toHaveBeenCalledWith("BITE-42 is waiting on you", "Open Deck");
  });

  it("coalesces several runs parking in one pass into one notification", () => {
    runAttentionPass(deps({ candidates: () => [cand("A"), cand("B"), cand("C")], notify: true }));
    expect(window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(window.showInformationMessage).toHaveBeenCalledWith("3 sessions are waiting on you", "Open Deck");
  });

  it("does not announce the same run again on the next pass", () => {
    const d = { candidates: () => [cand("A")], notify: true, latchFile: path.join(dir, "attention.json") };
    runAttentionPass(deps(d));
    runAttentionPass(deps({ ...d, nowMs: 2_000 }));
    expect(window.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it("announces again after the run was answered and parked a second time", () => {
    const latchFile = path.join(dir, "attention.json");
    runAttentionPass(deps({ candidates: () => [cand("A")], notify: true, latchFile }));
    runAttentionPass(deps({ candidates: () => [], notify: true, latchFile, nowMs: 2_000 }));
    runAttentionPass(deps({ candidates: () => [cand("A")], notify: true, latchFile, nowMs: 3_000 }));
    expect(window.showInformationMessage).toHaveBeenCalledTimes(2);
  });

  it("stays silent in an unfocused window and leaves the edge unclaimed", () => {
    // A toast is in-app only, so one raised in a window you are not looking at is
    // spent on nobody. Leaving the edge unclaimed lets a focused window announce
    // it on its own next pass.
    const latchFile = path.join(dir, "attention.json");
    runAttentionPass(deps({ candidates: () => [cand("A")], notify: true, focused: false, latchFile }));
    expect(window.showInformationMessage).not.toHaveBeenCalled();
    runAttentionPass(deps({ candidates: () => [cand("A")], notify: true, focused: true, latchFile, nowMs: 2_000 }));
    expect(window.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it("opens the Deck when the button is pressed", async () => {
    vi.mocked(window.showInformationMessage).mockResolvedValueOnce("Open Deck");
    runAttentionPass(deps({ candidates: () => [cand("A")], notify: true }));
    await vi.waitFor(() =>
      expect(commands.executeCommand).toHaveBeenCalledWith("agentFlow.openDeck"));
  });

  it("does nothing on the button when the notification is dismissed", async () => {
    vi.mocked(window.showInformationMessage).mockResolvedValueOnce(undefined);
    runAttentionPass(deps({ candidates: () => [cand("A")], notify: true }));
    await Promise.resolve();
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it("logs and survives a notification that rejects", async () => {
    vi.mocked(window.showInformationMessage).mockRejectedValueOnce(new Error("no UI"));
    runAttentionPass(deps({ candidates: () => [cand("A")], notify: true }));
    await vi.waitFor(() => expect(logged.join()).toContain("attention"));
  });

  it("logs and survives an openDeck command that rejects", async () => {
    vi.mocked(window.showInformationMessage).mockResolvedValueOnce("Open Deck");
    vi.mocked(commands.executeCommand).mockRejectedValueOnce(new Error("no command"));
    runAttentionPass(deps({ candidates: () => [cand("A")], notify: true }));
    await vi.waitFor(() => expect(logged.join()).toContain("attention"));
  });
});
