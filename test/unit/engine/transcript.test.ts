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

  // A stale pending tool call, with the tool_use block Claude Code actually writes.
  const asstToolNamed = (name: string): TranscriptLine => line({
    type: "assistant",
    slug: "export-streaming",
    message: {
      role: "assistant",
      stop_reason: "tool_use",
      content: [{ type: "text", text: "Running it now." }, { type: "tool_use", name, input: {} }],
    },
  });

  it("names the tool a pending call is waiting on", () => {
    expect(deriveActivity([userMsg, asstToolNamed("Bash")], NOW - 60_000, NOW).pendingTool).toBe("Bash");
  });

  it("names the tool on a fresh pending call too, so a working card can say what it is doing", () => {
    expect(deriveActivity([userMsg, asstToolNamed("Edit")], NOW - 5_000, NOW).pendingTool).toBe("Edit");
  });

  it("reads the LAST tool_use block when one turn holds several", () => {
    const multi = line({
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Read", input: {} }, { type: "tool_use", name: "Bash", input: {} }],
      },
    });
    expect(deriveActivity([userMsg, multi], NOW - 60_000, NOW).pendingTool).toBe("Bash");
  });

  // Claude Code owns this format. Every one of these used to be the shape it
  // wrote at some point, or plausibly could be next; none may throw, and all
  // must land on null so the Task 3 rule falls through to today's `stalled`.
  it.each([
    ["no content field at all", undefined],
    ["content as a bare string", "Running it now."],
    ["content with no tool_use block", [{ type: "text", text: "hi" }]],
    ["a tool_use block with no name", [{ type: "tool_use", input: {} }]],
    ["a tool_use block whose name is not a string", [{ type: "tool_use", name: 7 }]],
    ["a tool_use block whose name is empty", [{ type: "tool_use", name: "" }]],
    ["a null member", [null]],
  ])("yields a null pendingTool for %s", (_label, content) => {
    const l = line({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content } });
    expect(deriveActivity([userMsg, l], NOW - 60_000, NOW).pendingTool).toBeNull();
  });

  // AskUserQuestion used to be pinned to `stalled` here too, but that was a
  // Task-1-only invariant ("this task changes no state") — the ceiling table
  // above now deliberately reads a stale AskUserQuestion as `blocked`. Do not
  // restore that assertion.
  it("falls through to stalled for a nameless tool, and for a listed tool under its ceiling", () => {
    expect(deriveActivity([userMsg, asstTool], NOW - 60_000, NOW).state).toBe("stalled");
    expect(deriveActivity([userMsg, asstToolNamed("Bash")], NOW - 60_000, NOW).state).toBe("stalled");
  });

  // Thresholds are measured, not assumed — see the spec's calibration table.
  // Each pair below pins BOTH sides of a ceiling, because a ceiling asserted
  // from one side only passes against a rule that ignores the tool entirely.
  it.each([
    // tool,               justUnder, justOver
    ["AskUserQuestion",    null,      46_000],
    ["ExitPlanMode",       null,      46_000],
    ["Edit",               50_000,    61_000],
    ["Write",              50_000,    61_000],
    ["NotebookEdit",       50_000,    61_000],
    ["Bash",               719_000,   721_000],
  ])("%s is stalled under its ceiling and blocked over it", (tool, under, over) => {
    if (under !== null) {
      expect(deriveActivity([userMsg, asstToolNamed(tool)], NOW - under, NOW).state).toBe("stalled");
    }
    expect(deriveActivity([userMsg, asstToolNamed(tool)], NOW - over, NOW).state).toBe("blocked");
  });

  it("still reads working inside the 45s window, whatever the tool", () => {
    expect(deriveActivity([userMsg, asstToolNamed("AskUserQuestion")], NOW - 10_000, NOW).state).toBe("working");
    expect(deriveActivity([userMsg, asstToolNamed("Edit")], NOW - 44_000, NOW).state).toBe("working");
  });

  // Gated but UNBOUNDED: a backgrounded subagent legitimately pends for 46
  // minutes (measured max 2,775s). Any ceiling here would flag every one of them.
  it.each(["Agent", "Workflow", "TaskOutput", "Monitor", "mcp__github__merge_pull_request"])(
    "%s stays stalled however long it pends — no ceiling can be honest",
    (tool) => {
      expect(deriveActivity([userMsg, asstToolNamed(tool)], NOW - 3_000_000, NOW).state).toBe("stalled");
    },
  );

  // Bounded but NOT GATED: a hung read is a wedged host, not a question. Calling
  // it blocked would claim somebody is being asked something when nobody is.
  it.each(["Read", "Grep", "Glob", "TodoWrite"])("%s stays stalled — nobody is being asked anything", (tool) => {
    expect(deriveActivity([userMsg, asstToolNamed(tool)], NOW - 3_000_000, NOW).state).toBe("stalled");
  });

  it("falls through to stalled when the tool name cannot be read", () => {
    // The additive property the whole ungated ship rests on: an unreadable line
    // derives exactly what it derived before this feature existed.
    expect(deriveActivity([userMsg, asstTool], NOW - 3_000_000, NOW).state).toBe("stalled");
  });

  it("carries the tool name onto the blocked reading, so the card can say why", () => {
    const a = deriveActivity([userMsg, asstToolNamed("Bash")], NOW - 800_000, NOW);
    expect(a.state).toBe("blocked");
    expect(a.pendingTool).toBe("Bash");
  });

  it("leaves a quiet-but-alive transcript reading idle — no pending tool, nothing owed", () => {
    // The Done-when's second half. A transcript whose last line is a user line
    // has work owed but no tool outstanding, so no class can apply.
    expect(deriveActivity([asstTool, userMsg], NOW - 3_000_000, NOW).state).toBe("idle");
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
  const cwd = "/Users/dev/projects/webapp";

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

describe("parseLines hardening — raw on-disk lines (via readSessionActivity)", () => {
  const NOW = 1_800_000_000_000;
  const cwd = "/Users/dev/projects/webapp";
  let root: string;

  const writeRaw = (id: string, content: string, mtimeMs: number): void => {
    const dir = path.join(root, encodeProjectDir(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, content);
    fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-txraw-"));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("tolerates a line that is exactly `null` and derives from the real lines", () => {
    // "null" is a non-empty string, so .filter(Boolean) keeps the row, and it
    // parses to null — reading `.slug` off it used to throw into the Deck poll.
    const content =
      [
        JSON.stringify({ type: "user" }),
        "null",
        JSON.stringify({ type: "assistant", slug: "real", message: { stop_reason: "end_turn" } }),
      ].join("\n") + "\n";
    writeRaw("with-null", content, NOW - 1000);
    const a = readSessionActivity(root, cwd, "with-null", NOW);
    expect(a.state).toBe("needs-you");
    expect(a.slug).toBe("real");
  });

  it("drops a line holding a bare number or string (valid JSON, not a record)", () => {
    const content =
      ["5", '"text"', JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn" } })].join("\n") + "\n";
    writeRaw("with-scalars", content, NOW - 1000);
    expect(readSessionActivity(root, cwd, "with-scalars", NOW).state).toBe("needs-you");
  });
});
