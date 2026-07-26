import { describe, it, expect } from "vitest";
import { fuzzyScore, phraseScore } from "../../../src/engine/fuzzy";

describe("fuzzyScore", () => {
  it("matches an empty needle against anything", () => {
    expect(fuzzyScore("", "whatever")).toBe(0);
  });

  it("matches a scattered subsequence", () => {
    expect(fuzzyScore("ppln", "pipeline")).not.toBeNull();
    expect(fuzzyScore("mkpl", "marketplace")).not.toBeNull();
  });

  it("rejects characters that are absent or out of order", () => {
    expect(fuzzyScore("xyz", "pipeline")).toBeNull();
    expect(fuzzyScore("enilepip", "pipeline")).toBeNull();
  });

  it("ignores case on both sides", () => {
    expect(fuzzyScore("SS", "SessionStart")).not.toBeNull();
    expect(fuzzyScore("ss", "SessionStart")).not.toBeNull();
  });

  it("ranks a whole-word substring above the same chars scattered", () => {
    const solid = fuzzyScore("deploy", "deploy")!;
    const scattered = fuzzyScore("deploy", "deep loyalty")!;
    expect(scattered).not.toBeNull();
    expect(solid).toBeGreaterThan(scattered);
  });

  it("ranks a prefix above a mid-word hit", () => {
    expect(fuzzyScore("test", "test-expert")!).toBeGreaterThan(fuzzyScore("test", "latest-run")!);
  });

  it("ranks a word start above a mid-word hit", () => {
    expect(fuzzyScore("rev", "code review")!).toBeGreaterThan(fuzzyScore("rev", "forever")!);
  });

  it("ranks initials that follow camel humps highly", () => {
    expect(fuzzyScore("ss", "SessionStart")!).toBeGreaterThan(fuzzyScore("ss", "assess")!);
  });

  it("ranks a contiguous run above a broken one", () => {
    expect(fuzzyScore("abc", "abc")!).toBeGreaterThan(fuzzyScore("abc", "axbxc")!);
  });

  it("prefers the earlier of two equally solid hits", () => {
    expect(fuzzyScore("run", "run it")!).toBeGreaterThan(fuzzyScore("run", "please run")!);
  });
});

describe("phraseScore", () => {
  it("matches an empty needle against anything", () => {
    expect(phraseScore("", "whatever")).toBe(0);
  });

  it("finds a literal occurrence regardless of case", () => {
    expect(phraseScore("deploy", "Deploys the service")).not.toBeNull();
    expect(phraseScore("DEPLOY", "deploys the service")).not.toBeNull();
  });

  it("refuses a scattered subsequence", () => {
    // The whole point: "dply" is a subsequence of most sentences, so prose that
    // never says "dply" must not match it.
    expect(phraseScore("dply", "deploys the service")).toBeNull();
  });

  it("ranks a word-aligned hit above a mid-word one", () => {
    expect(phraseScore("deploy", "deploy it")!).toBeGreaterThan(phraseScore("deploy", "redeploy it")!);
  });

  it("ranks an early hit above a late one", () => {
    expect(phraseScore("run", "run the thing")!).toBeGreaterThan(phraseScore("run", "the thing you run")!);
  });
});
