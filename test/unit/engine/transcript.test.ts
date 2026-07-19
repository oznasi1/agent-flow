import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { encodeProjectDir, deriveActivity, readAgentActivity, TranscriptLine } from "../../../src/engine/transcript";

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

  it("reads a stale tool_use as idle", () => {
    expect(deriveActivity([userMsg, asstTool], NOW - 10 * 60_000, NOW).state).toBe("idle");
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
