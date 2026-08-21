import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { encodeProjectDir, deriveActivity, readAgentActivity, readSessionActivity, UNKNOWN_ACTIVITY, TranscriptLine } from "../../../src/engine/transcript";

describe("encodeProjectDir", () => {
  it("replaces slashes with dashes", () => {
    expect(encodeProjectDir("/Users/dev/projects/agent-flow")).toBe("-Users-dev-projects-agent-flow");
  });

  it("replaces dots too (worktree paths)", () => {
    expect(encodeProjectDir("/Users/dev/projects/web-app/.claude-worktrees/ABC-5315")).toBe(
      "-Users-dev-projects-web-app--claude-worktrees-ABC-5315",
    );
  });
});

describe("deriveActivity", () => {
  const NOW = 1_800_000_000_000;
  const line = (o: Partial<TranscriptLine>): TranscriptLine => o;
  const asstEnd = line({ type: "assistant", slug: "export-streaming", message: { role: "assistant", stop_reason: "end_turn" } });
  const asstTool = line({ type: "assistant", slug: "export-streaming", message: { role: "assistant", stop_reason: "tool_use" } });
  const userMsg = line({ type: "user", slug: "export-streaming", message: { role: "user" } });
  const snapshot = line({ type: "file-history-snapshot" });

  it("is unknown with no meaningful lines", () => {
    expect(deriveActivity([snapshot], NOW - 1000, NOW).state).toBe("unknown");
  });

  it("is unknown for an empty transcript", () => {
    expect(deriveActivity([], NOW, NOW).state).toBe("unknown");
  });

  it("reads a finished turn as needs-you, even when the file is old", () => {
    expect(deriveActivity([userMsg, asstEnd], NOW - 60 * 60_000, NOW).state).toBe("needs-you");
  });

  it("reads a fresh tool_use as working", () => {
    expect(deriveActivity([userMsg, asstTool], NOW - 10_000, NOW).state).toBe("working");
  });

  it("reads a fresh user reply as working", () => {
    expect(deriveActivity([asstTool, userMsg], NOW - 5_000, NOW).state).toBe("working");
  });

  it("ignores a trailing snapshot line when finding the last turn", () => {
    expect(deriveActivity([userMsg, asstEnd, snapshot], NOW - 5_000, NOW).state).toBe("needs-you");
  });

  it("carries the session slug and last-activity mtime", () => {
    const a = deriveActivity([userMsg, asstTool], NOW - 10_000, NOW);
    expect(a.slug).toBe("export-streaming");
    expect(a.lastActivityMs).toBe(NOW - 10_000);
  });

  // A tool call that has not returned in 45s: the agent is at a permission
  // prompt, or a long command is still running. The transcript cannot tell the
  // two apart, so the label is true under either reading. Before this, the one
  // genuinely stuck card on the board rendered in the calmest tone there is.
  it("reads a stale tool_use as stalled", () => {
    expect(deriveActivity([userMsg, asstTool], NOW - 10 * 60_000, NOW).state).toBe("stalled");
  });

  it("still reads a fresh tool_use as working — a tool that just started is not stalled", () => {
    expect(deriveActivity([userMsg, asstTool], NOW - 10_000, NOW).state).toBe("working");
  });

  it("reads a stale trailing user line as idle, not stalled — no tool is outstanding", () => {
    expect(deriveActivity([asstTool, userMsg], NOW - 10 * 60_000, NOW).state).toBe("idle");
  });

  it("marks an unanswered tool_use as midWork", () => {
    expect(deriveActivity([userMsg, asstTool], NOW - 10 * 60_000, NOW).midWork).toBe(true);
  });

  it("marks an unanswered user line as midWork — the agent owes a reply", () => {
    expect(deriveActivity([asstTool, userMsg], NOW - 10 * 60_000, NOW).midWork).toBe(true);
  });

  it("does not mark a finished turn as midWork", () => {
    expect(deriveActivity([userMsg, asstEnd], NOW - 10 * 60_000, NOW).midWork).toBe(false);
  });

  it("does not mark an empty transcript as midWork", () => {
    expect(deriveActivity([], NOW, NOW).midWork).toBeFalsy();
  });

  const asstModel = (model: string, sidechain = false): TranscriptLine =>
    line({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", model }, ...(sidechain ? { isSidechain: true } : {}) });

  it("reports the model of the last main-chain assistant line", () => {
    const a = deriveActivity([asstModel("claude-opus-5")], NOW - 1000, NOW);
    expect(a.model).toBe("claude-opus-5");
    expect(a.modelCount).toBe(1);
  });

  it("reports the LAST model, not the first, when a session switched mid-run", () => {
    // Real case: fast mode switches the model inside one session, so a tail holds
    // both. The session is currently answering with whichever it switched to.
    const a = deriveActivity([asstModel("claude-fable-5"), asstModel("claude-opus-5")], NOW - 1000, NOW);
    expect(a.model).toBe("claude-opus-5");
    expect(a.modelCount).toBe(2);
  });

  it("counts distinct main-chain models across more than one switch", () => {
    // The drawer marks a multi-model tail with a "+N" and needs the count to do it.
    const a = deriveActivity(
      [asstModel("claude-fable-5"), asstModel("claude-opus-5"), asstModel("claude-fable-5")],
      NOW - 1000, NOW,
    );
    expect(a.model).toBe("claude-fable-5");
    expect(a.modelCount).toBe(2);
  });

  it("ignores a subagent's model even when it is the last line", () => {
    // A main session that dispatches a subagent must not report the subagent's
    // model as its own: sidechain lines are somebody else's turn.
    const a = deriveActivity([asstModel("claude-opus-5"), asstModel("claude-haiku-4-5", true)], NOW - 1000, NOW);
    expect(a.model).toBe("claude-opus-5");
    expect(a.modelCount).toBe(1);
  });

  it("has no model when the tail carries only subagent turns", () => {
    const a = deriveActivity([asstModel("claude-haiku-4-5", true)], NOW - 1000, NOW);
    expect(a.model).toBeNull();
    expect(a.modelCount).toBe(0);
  });

  it("has no model on a transcript with nothing meaningful in it", () => {
    const a = deriveActivity([snapshot], NOW - 1000, NOW);
    expect(a.state).toBe("unknown");
    expect(a.model).toBeNull();
  });
});

describe("readAgentActivity", () => {
  const NOW = 1_800_000_000_000;
  const cwdA = "/repo/alpha";
  let root: string;
  let encDir: string;

  const writeJsonl = (name: string, rows: TranscriptLine[], mtimeMs: number) => {
    const p = path.join(encDir, name);
    fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-tx-"));
    encDir = path.join(root, encodeProjectDir(cwdA));
    fs.mkdirSync(encDir, { recursive: true });
    writeJsonl("older.jsonl",
      [{ type: "user", gitBranch: "feat-a" }, { type: "assistant", gitBranch: "feat-a", slug: "aa", message: { stop_reason: "end_turn" } }],
      NOW - 60 * 60_000);
    writeJsonl("newer.jsonl",
      [{ type: "assistant", gitBranch: "feat-b", slug: "bb", message: { stop_reason: "tool_use" } }],
      NOW - 5_000);
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("picks the newest transcript by default", () => {
    expect(readAgentActivity(root, cwdA, null, NOW).slug).toBe("bb");
  });

  it("reads the newest fresh tool_use as working", () => {
    expect(readAgentActivity(root, cwdA, null, NOW).state).toBe("working");
  });

  it("selects the branch-matching transcript over the newest", () => {
    expect(readAgentActivity(root, cwdA, "feat-a", NOW).slug).toBe("aa");
  });

  it("reads the matched finished turn as needs-you", () => {
    expect(readAgentActivity(root, cwdA, "feat-a", NOW).state).toBe("needs-you");
  });

  it("is unknown (no throw) when the project dir is missing", () => {
    expect(readAgentActivity(root, "/repo/does-not-exist", null, NOW).state).toBe("unknown");
  });
});

describe("readSessionActivity", () => {
  const NOW = 1_800_000_000_000;
  let root: string;
  const cwd = "/Users/dev/projects/centaur";

  const write = (id: string, lines: object[], mtimeMs: number): void => {
    const dir = path.join(root, encodeProjectDir(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-sessact-"));
    // The named session finished its turn an hour ago; a *newer* transcript beside
    // it is mid-tool-use. Addressing by id must not drift to the newer one.
    write("named", [{ type: "user" }, { type: "assistant", message: { stop_reason: "end_turn" } }], NOW - 3_600_000);
    write("newer", [{ type: "user" }, { type: "assistant", message: { stop_reason: "tool_use" } }], NOW - 5_000);
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("reads the named transcript, not the newest one beside it", () => {
    expect(readSessionActivity(root, cwd, "named", NOW).state).toBe("needs-you");
  });

  it("reads a different session in the same directory independently", () => {
    expect(readSessionActivity(root, cwd, "newer", NOW).state).toBe("working");
  });

  it("is unknown when the session's transcript is absent", () => {
    expect(readSessionActivity(root, cwd, "gone", NOW)).toEqual(UNKNOWN_ACTIVITY);
  });

  it("is unknown when the project directory does not exist", () => {
    expect(readSessionActivity(root, "/nowhere", "x", NOW)).toEqual(UNKNOWN_ACTIVITY);
  });
});
