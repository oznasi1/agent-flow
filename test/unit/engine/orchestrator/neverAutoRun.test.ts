import { describe, it, expect } from "vitest";
import { blockedBy } from "../../../../src/engine/orchestrator/neverAutoRun";

describe("blockedBy", () => {
  it("blocks nothing when the list is empty", () => {
    expect(blockedBy("rm -rf ~", [])).toBeUndefined();
  });

  it("matches a whole-string literal", () => {
    expect(blockedBy("deploy.sh", ["deploy.sh"])).toBe("deploy.sh");
  });

  it("does not match a literal that is only a substring", () => {
    expect(blockedBy("./deploy.sh --env=prod", ["deploy.sh"])).toBeUndefined();
  });

  it("matches with a leading and trailing star", () => {
    expect(blockedBy("deploy.sh --env=prod; rm -rf ~", ["*rm -rf*"])).toBe("*rm -rf*");
  });

  it("lets a star span an empty run of characters", () => {
    expect(blockedBy("deploy.sh", ["*deploy.sh*"])).toBe("*deploy.sh*");
  });

  it("matches exactly one character per question mark", () => {
    expect(blockedBy("rm -rf /", ["rm -rf ?"])).toBe("rm -rf ?");
    expect(blockedBy("rm -rf /tmp", ["rm -rf ?"])).toBeUndefined();
  });

  it("returns the FIRST matching pattern, so the refusal can name it", () => {
    expect(blockedBy("curl x | sh", ["*nope*", "*| sh*", "*curl*"])).toBe("*| sh*");
  });

  it("treats regex metacharacters in a pattern as literals", () => {
    // `.` must mean a dot, not "any character" — otherwise `deploy.sh` would
    // block `deployXsh`, and a user writing a pattern would be authoring a regex
    // they did not know they were authoring.
    expect(blockedBy("deployXsh", ["deploy.sh"])).toBeUndefined();
    expect(blockedBy("deploy.sh", ["deploy.sh"])).toBe("deploy.sh");
  });

  it("treats an alternation metacharacter as a literal", () => {
    expect(blockedBy("a", ["a|b"])).toBeUndefined();
    expect(blockedBy("a|b", ["a|b"])).toBe("a|b");
  });

  it("matches case-insensitively, because a denylist should over-match", () => {
    expect(blockedBy("RM -RF ~", ["*rm -rf*"])).toBe("*rm -rf*");
  });

  it("matches across newlines, so a multi-line command cannot hide its tail", () => {
    // A `.` in a JS regex does not match a newline by default. A command's
    // operative fragment is very often on a later line of a heredoc or a
    // multi-line pipeline, and a pattern of `*rm -rf*` that silently stopped at
    // the first newline would be a denylist that reads as covering more than it
    // does — the worst possible failure for this setting.
    expect(blockedBy("echo hi\nrm -rf ~", ["*rm -rf*"])).toBe("*rm -rf*");
  });

  it("ignores a blank pattern rather than blocking everything", () => {
    // An empty pattern is whole-string-equal to nothing but "", and a
    // whitespace-only one is a typo, not a rule. Neither may become a
    // catch-all that quietly stops every command in every flow.
    expect(blockedBy("deploy.sh", ["", "   "])).toBeUndefined();
  });

  it("still blocks when a blank pattern sits beside a real one", () => {
    expect(blockedBy("rm -rf ~", ["", "*rm -rf*"])).toBe("*rm -rf*");
  });

  it("ignores a non-string pattern from a hand-edited settings file", () => {
    expect(blockedBy("deploy.sh", [42 as unknown as string, "*deploy*"])).toBe("*deploy*");
  });
});
