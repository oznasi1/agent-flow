import { describe, expect, it, vi } from "vitest";
import { SfCli, SfMissingError, SfRunner } from "../../../../src/tasks/agileAccelerator/cli";
import { SfApiError } from "../../../../src/tasks/agileAccelerator/errors";
import { isTaskNetworkError, TaskAuthError } from "../../../../src/tasks/provider";

const ok = (result: unknown): string => JSON.stringify({ status: 0, result });

/** A runner that records its argv and replays canned results. */
function fakeRunner(results: Partial<{ stdout: string; stderr: string; code: number }>[]) {
  const calls: string[][] = [];
  let i = 0;
  const run: SfRunner = async (file, args) => {
    calls.push([file, ...args]);
    const r = results[Math.min(i++, results.length - 1)];
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0 };
  };
  return { run, calls };
}

describe("SfCli.query", () => {
  it("returns the records out of a successful envelope", async () => {
    const { run } = fakeRunner([{ stdout: ok({ records: [{ Name: "W-1" }], totalSize: 1, done: true }) }]);
    const cli = new SfCli("", run, () => "/usr/local/bin/sf");
    expect(await cli.query("SELECT Name FROM x")).toEqual([{ Name: "W-1" }]);
  });

  it("passes --target-org only when one is configured", async () => {
    const withOrg = fakeRunner([{ stdout: ok({ records: [] }) }]);
    await new SfCli("gus", withOrg.run, () => "sf").query("SELECT Id FROM x");
    expect(withOrg.calls[0]).toContain("--target-org");
    expect(withOrg.calls[0]).toContain("gus");

    const noOrg = fakeRunner([{ stdout: ok({ records: [] }) }]);
    await new SfCli("", noOrg.run, () => "sf").query("SELECT Id FROM x");
    expect(noOrg.calls[0]).not.toContain("--target-org");
  });

  it("classifies a non-zero exit from the stdout envelope, not the exit code", async () => {
    const raw = JSON.stringify({ status: 1, name: "INVALID_FIELD", message: "No such column 'Nope__c'" });
    const { run } = fakeRunner([{ stdout: raw, code: 1 }]);
    const cli = new SfCli("", run, () => "sf");
    await expect(cli.query("SELECT Nope__c FROM x")).rejects.toBeInstanceOf(SfApiError);
  });

  it("surfaces an auth failure as TaskAuthError", async () => {
    const raw = JSON.stringify({ status: 1, name: "INVALID_SESSION_ID", message: "expired" });
    const { run } = fakeRunner([{ stdout: raw, code: 1 }]);
    await expect(new SfCli("", run, () => "sf").query("SELECT Id FROM x")).rejects.toBeInstanceOf(TaskAuthError);
  });

  it("throws SfMissingError when the binary cannot be located, without spawning", async () => {
    const run = vi.fn();
    const cli = new SfCli("", run as unknown as SfRunner, () => null);
    await expect(cli.query("SELECT Id FROM x")).rejects.toBeInstanceOf(SfMissingError);
    expect(run).not.toHaveBeenCalled();
  });

  it("treats a spawn-level ENOENT as a missing binary, not an auth problem", async () => {
    const run: SfRunner = async () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    };
    await expect(new SfCli("", run, () => "sf").query("SELECT Id FROM x")).rejects.toBeInstanceOf(SfMissingError);
  });

  it("marks a timeout as network-origin so views do not show a sign-in gate", async () => {
    const run: SfRunner = async () => {
      throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    };
    const err = await new SfCli("", run, () => "sf").query("SELECT Id FROM x").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TaskAuthError);
    expect(isTaskNetworkError(err)).toBe(true);
  });
});

describe("SfCli.describe / userInfo", () => {
  it("returns the describe result", async () => {
    const { run, calls } = fakeRunner([{ stdout: ok({ name: "agf__ADM_Work__c", fields: [{ name: "Id" }] }) }]);
    const d = await new SfCli("", run, () => "sf").describe("agf__ADM_Work__c");
    expect(d.fields.map((f) => f.name)).toEqual(["Id"]);
    expect(calls[0]).toContain("--sobject");
  });

  it("returns the signed-in username and id", async () => {
    const { run } = fakeRunner([{ stdout: ok({ username: "me@example.com", id: "005000000000001" }) }]);
    expect(await new SfCli("", run, () => "sf").userInfo()).toEqual({
      username: "me@example.com",
      id: "005000000000001",
    });
  });

  it("reports installed() from the locator without spawning", () => {
    const run = vi.fn();
    expect(new SfCli("", run as unknown as SfRunner, () => null).installed()).toBe(false);
    expect(new SfCli("", run as unknown as SfRunner, () => "sf").installed()).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});
