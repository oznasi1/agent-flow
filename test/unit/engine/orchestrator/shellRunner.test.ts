import { describe, expect, it } from "vitest";
import { shellCommandRunner } from "../../../../src/engine/orchestrator/shellRunner";

// Real processes, deliberately: `exec`'s `env` option REPLACES the child's
// environment rather than extending it, so the one thing worth proving here is
// that a command's own variables arrive AND the host's are still there. A mock of
// `exec` could only restate the call.
describe("shellCommandRunner env", () => {
  const sh = "sh -c 'printf \"%s|%s\" \"$AGENT_FLOW_TEST_VAR\" \"${PATH:+path}\"'";

  it("lays the command's env over the host's rather than replacing it", async () => {
    const r = await shellCommandRunner(sh, { cwd: process.cwd(), timeoutMs: 10_000, env: { AGENT_FLOW_TEST_VAR: "set-by-command" } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("set-by-command|path");
  });

  it("inherits the host's environment untouched when the command sets nothing", async () => {
    const r = await shellCommandRunner(sh, { cwd: process.cwd(), timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("|path");
  });
});
