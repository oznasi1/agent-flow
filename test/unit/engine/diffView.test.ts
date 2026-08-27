import { describe, it, expect, vi, beforeEach } from "vitest";
import { BASE_SCHEME, baseUri, diffTitle, openTaskDiff, TaskBaseContentProvider } from "../../../src/engine/diffView";
import type { ChangedFile } from "../../../src/engine/git";
import { commands, Uri } from "../../_mocks/vscode";

const h = vi.hoisted(() => ({
  showFileAtRef: vi.fn((_r: string, _ref: string, _f: string) => ""),
  taskDiffBase: vi.fn((_r: string) => "base-sha"),
  taskChangedFiles: vi.fn((_r: string): ChangedFile[] => []),
}));
vi.mock("../../../src/engine/git", () => ({
  showFileAtRef: h.showFileAtRef,
  taskDiffBase: h.taskDiffBase,
  taskChangedFiles: h.taskChangedFiles,
}));

describe("baseUri", () => {
  it("uses the extension's own scheme so the content provider is asked", () => {
    expect(baseUri("/r/svc", "abc123", "src/a.ts").scheme).toBe(BASE_SCHEME);
  });

  it("puts the file path where a reader can see it", () => {
    expect(baseUri("/r/svc", "abc123", "src/a.ts").path).toBe("/src/a.ts");
  });

  it("round-trips the repo, ref and file through the provider", () => {
    h.showFileAtRef.mockReturnValue("body\n");
    const content = new TaskBaseContentProvider().provideTextDocumentContent(
      baseUri("/r/svc", "abc123", "src/a.ts") as never,
    );
    expect(h.showFileAtRef).toHaveBeenCalledWith("/r/svc", "abc123", "src/a.ts");
    expect(content).toBe("body\n");
  });

  it("round-trips a path containing spaces", () => {
    new TaskBaseContentProvider().provideTextDocumentContent(
      baseUri("/r/svc", "abc123", "docs/old name.md") as never,
    );
    expect(h.showFileAtRef).toHaveBeenCalledWith("/r/svc", "abc123", "docs/old name.md");
  });

  it("survives the serialize-and-reparse cycle the editor puts a URI through", () => {
    // A URI reaches the provider as a string that VS Code reparsed, not as the
    // object `baseUri` returned — so the JSON in `query` has to come back out
    // through percent-encoding intact. The punctuation here is the encoding's
    // whole point: `?` would otherwise start a second query and `#` a fragment.
    h.showFileAtRef.mockReturnValue("body\n");
    const file = "docs/why? #1 is 100% done.md";
    const reparsed = Uri.parse(baseUri("/r/svc", "abc123", file).toString());
    const content = new TaskBaseContentProvider().provideTextDocumentContent(reparsed as never);
    expect(h.showFileAtRef).toHaveBeenCalledWith("/r/svc", "abc123", file);
    expect(content).toBe("body\n");
  });

  it("serves empty for a URI it cannot decode instead of throwing", () => {
    const p = new TaskBaseContentProvider();
    expect(p.provideTextDocumentContent({ query: "not json" } as never)).toBe("");
  });
});

describe("diffTitle", () => {
  const svc = { name: "svc", path: "/r/svc" };
  const web = { name: "web", path: "/r/web" };

  it("names the one repo being diffed", () => {
    expect(diffTitle("PROJ-1", [svc])).toBe("Changes in PROJ-1 — svc");
  });

  it("names the workspace when the whole multi-root task is being diffed", () => {
    expect(diffTitle("PROJ-1", [svc, web], "/ws/pay-stack.code-workspace")).toBe("Changes in PROJ-1 — pay-stack");
  });

  it("says all repos when several are diffed without a workspace file", () => {
    expect(diffTitle("PROJ-1", [svc, web])).toBe("Changes in PROJ-1 — all repos");
  });

  it("keeps the workspace label to the file's own name, not its directory", () => {
    expect(diffTitle("PROJ-1", [svc, web], "/ws/nested/dir/pay-stack.code-workspace")).toBe(
      "Changes in PROJ-1 — pay-stack",
    );
  });

  it("says all repos when the workspace file has no name of its own", () => {
    // A bare `.code-workspace` leaves nothing after the extension is stripped;
    // "all repos" is still true, where an empty label would read as a glitch.
    expect(diffTitle("PROJ-1", [svc, web], "/ws/.code-workspace")).toBe("Changes in PROJ-1 — all repos");
  });

  it("falls back to the run key alone when there is no repo to name", () => {
    // openTaskDiff reports "empty" for this, so the title is never seen — but a
    // trailing em dash with nothing after it would be the one visible wrong thing.
    expect(diffTitle("PROJ-1", [])).toBe("Changes in PROJ-1");
  });

  it("falls back to the run key alone when the single repo has no name", () => {
    expect(diffTitle("PROJ-1", [{ name: "" }])).toBe("Changes in PROJ-1");
  });
});

describe("openTaskDiff", () => {
  const svc = [{ name: "svc", path: "/r/svc" }];
  const args = () => commands.executeCommand.mock.calls.at(-1)!;
  const list = () => args()[2] as [{ fsPath: string }, unknown, unknown][];

  beforeEach(() => {
    h.taskDiffBase.mockReturnValue("base-sha");
    h.taskChangedFiles.mockReturnValue([]);
  });

  it("reports empty and opens nothing when the task changed no files", async () => {
    expect(await openTaskDiff("Changes in PROJ-1", svc)).toBe("empty");
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it("reports binary-only when every change was a binary file", async () => {
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "pic.bin", binary: true }]);
    expect(await openTaskDiff("Changes in PROJ-1", svc)).toBe("binary-only");
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it("drops binary files but still opens the text ones", async () => {
    h.taskChangedFiles.mockReturnValue([
      { status: "M", path: "pic.bin", binary: true },
      { status: "M", path: "a.ts", binary: false },
    ]);
    expect(await openTaskDiff("Changes in PROJ-1", svc)).toBe("opened");
    expect(list()).toHaveLength(1);
    expect(list()[0][0].fsPath).toContain("a.ts");
  });

  it("runs the multi-file diff command with the run's key as the title", async () => {
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.ts", binary: false }]);
    await openTaskDiff("Changes in PROJ-1", svc);
    expect(args()[0]).toBe("vscode.changes");
    expect(args()[1]).toBe("Changes in PROJ-1");
  });

  it("gives a modified file both sides", async () => {
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.ts", binary: false }]);
    await openTaskDiff("t", svc);
    const [resource, left, right] = list()[0];
    expect(resource.fsPath).toBe("/r/svc/a.ts");
    expect((left as { scheme: string }).scheme).toBe(BASE_SCHEME);
    expect(right).toBe(resource);
  });

  it("gives an added file no left side", async () => {
    h.taskChangedFiles.mockReturnValue([{ status: "A", path: "new.ts", binary: false }]);
    await openTaskDiff("t", svc);
    const [, left, right] = list()[0];
    expect(left).toBeUndefined();
    expect(right).toBeDefined();
  });

  it("gives a deleted file no right side", async () => {
    h.taskChangedFiles.mockReturnValue([{ status: "D", path: "old.ts", binary: false }]);
    await openTaskDiff("t", svc);
    const [, left, right] = list()[0];
    expect(left).toBeDefined();
    expect(right).toBeUndefined();
  });

  it("points a rename's left side at the old path so it diffs as one change", async () => {
    h.taskChangedFiles.mockReturnValue([
      { status: "R", path: "new name.ts", oldPath: "old name.ts", binary: false },
    ]);
    await openTaskDiff("t", svc);
    const [resource, left] = list()[0];
    expect(resource.fsPath).toBe("/r/svc/new name.ts");
    expect((left as { path: string }).path).toBe("/old name.ts");
  });

  it("lists every repo's files in one editor", async () => {
    h.taskChangedFiles.mockImplementation((repo: string) =>
      [{ status: "M" as const, path: repo === "/r/svc" ? "a.ts" : "b.ts", binary: false }]);
    await openTaskDiff("t", [{ name: "svc", path: "/r/svc" }, { name: "web", path: "/r/web" }]);
    expect(list().map((e) => e[0].fsPath).sort()).toEqual(["/r/svc/a.ts", "/r/web/b.ts"]);
  });

  it("reports unsupported when the editor has no such command", async () => {
    // Cursor and other forks may not have registered vscode.changes.
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.ts", binary: false }]);
    commands.executeCommand.mockRejectedValueOnce(new Error("command 'vscode.changes' not found"));
    expect(await openTaskDiff("t", svc)).toBe("unsupported");
  });
});
