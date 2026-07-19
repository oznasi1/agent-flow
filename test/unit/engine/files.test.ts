import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "child_process";
import { extractFileHints, matchFiles, mention, resolveFilesInRepo } from "../../../src/engine/files";

vi.mock("child_process");
const execSyncMock = vi.mocked(childProcess.execSync);

describe("extractFileHints", () => {
  it("pulls path + bare-filename hints (backtick span + extension regex)", () => {
    expect(
      extractFileHints("Fix the bug in `src/services/export.py` and update export_utils.ts").sort(),
    ).toEqual(["export_utils.ts", "src/services/export.py"]);
  });

  it("ignores backtick spans that are not files", () => {
    expect(extractFileHints("Set the `MAX_RETRIES` constant and touch config.yaml")).toEqual(["config.yaml"]);
  });

  it("returns nothing for empty input", () => {
    expect(extractFileHints("")).toEqual([]);
  });

  it("strips wrapping quotes/parens/brackets", () => {
    expect(extractFileHints("see (`app/main.go`)")).toEqual(["app/main.go"]);
  });

  it("dedupes repeated mentions of the same file", () => {
    expect(extractFileHints("edit index.ts, then re-check index.ts again")).toEqual(["index.ts"]);
  });

  it("rejects tokens whose extension is not file-like", () => {
    // "v1.2.3" ends in ".3" but the FILE_RE only matches known code extensions,
    // and it is not inside backticks, so it should not be extracted.
    expect(extractFileHints("bump to v1.2.3 today")).toEqual([]);
  });
});

describe("matchFiles", () => {
  const cand = ["src/services/export.py", "src/utils/export.py", "README.md", "src/index.ts"];

  it("matches a path-like hint by suffix", () => {
    expect(matchFiles(["services/export.py"], cand)).toEqual(["src/services/export.py"]);
  });

  it("matches a bare filename against every basename", () => {
    expect(matchFiles(["export.py"], cand).sort()).toEqual(["src/services/export.py", "src/utils/export.py"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(matchFiles(["nope.go"], cand)).toEqual([]);
  });

  it("respects the cap", () => {
    expect(matchFiles(["export.py"], cand, 1)).toHaveLength(1);
  });

  it("matches case-insensitively", () => {
    expect(matchFiles(["EXPORT.PY"], ["src/Export.py"])).toEqual(["src/Export.py"]);
  });

  it("dedupes a candidate matched by more than one hint", () => {
    expect(matchFiles(["index.ts", "src/index.ts"], ["src/index.ts"])).toEqual(["src/index.ts"]);
  });
});

describe("mention", () => {
  it("includes the repo name in a multi-root workspace", () => {
    expect(mention("multiroot", "centaur", "src/a.ts")).toBe("@centaur/src/a.ts");
  });

  it("is a bare relative path per-window", () => {
    expect(mention("per-window", "centaur", "src/a.ts")).toBe("@src/a.ts");
  });
});

describe("resolveFilesInRepo", () => {
  beforeEach(() => execSyncMock.mockReset());

  it("returns [] without shelling out when there are no hints", () => {
    expect(resolveFilesInRepo("/repo", [])).toEqual([]);
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("matches hints against `git ls-files` output", () => {
    execSyncMock.mockReturnValue("src/a.ts\nsrc/b.ts\nREADME.md\n");
    expect(resolveFilesInRepo("/repo", ["a.ts"])).toEqual(["src/a.ts"]);
    expect(execSyncMock).toHaveBeenCalledWith("git ls-files", expect.objectContaining({ cwd: "/repo" }));
  });

  it("returns [] when git fails", () => {
    execSyncMock.mockImplementationOnce(() => {
      throw new Error("not a git repo");
    });
    expect(resolveFilesInRepo("/repo", ["a.ts"])).toEqual([]);
  });
});
