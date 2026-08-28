import { describe, it, expect } from "vitest";
import { resolveForge } from "../../../../src/engine/forge/registry";
import type { Runner } from "../../../../src/engine/pr/provider";

const REAL = JSON.stringify({
  hosts: { "github.com": [
    { state: "success", active: true, login: "oznasi1", scopes: "repo, workflow" },
    { state: "success", active: false, login: "OznasiAb", scopes: "repo" },
  ] },
});

/** A Runner that answers one argv and records every call. */
function runner(reply: (args: string[]) => string | Promise<string>) {
  const calls: string[][] = [];
  const run: Runner = async (_file, args) => { calls.push(args); return reply(args); };
  return { run, calls };
}

describe("the GitHub forge's account capability", () => {
  it("declares that it can enumerate and switch accounts", () => {
    expect(resolveForge("github", () => {}, runner(() => "").run).caps.accounts).toBe(true);
  });

  it("asks gh for structured output, not the human-readable report", async () => {
    const { run, calls } = runner(() => REAL);
    await resolveForge("github", () => {}, run).accounts();
    expect(calls[0]).toEqual(["auth", "status", "--json", "hosts"]);
  });

  it("returns the parsed accounts", async () => {
    const { run } = runner(() => REAL);
    expect(await resolveForge("github", () => {}, run).accounts()).toEqual([
      { login: "oznasi1", active: true, scopes: "repo, workflow" },
      { login: "OznasiAb", active: false, scopes: "repo" },
    ]);
  });

  // Total, not throwing: a rejection here would surface as an unhandled
  // rejection inside a refresh pass.
  it("resolves [] rather than rejecting when gh fails", async () => {
    const run: Runner = async () => { throw new Error("ENOENT"); };
    await expect(resolveForge("github", () => {}, run).accounts()).resolves.toEqual([]);
  });

  it("switches by long-form hostname and user flags", async () => {
    const { run, calls } = runner(() => "");
    expect(await resolveForge("github", () => {}, run).switchAccount("OznasiAb")).toEqual({ ok: true });
    expect(calls[0]).toEqual(["auth", "switch", "--hostname", "github.com", "--user", "OznasiAb"]);
  });

  it("reports a failed switch with gh's own complaint, and does not throw", async () => {
    const run: Runner = async () => { throw new Error("no such account"); };
    const res = await resolveForge("github", () => {}, run).switchAccount("nobody");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toContain("no such account");
  });
});

describe("the GitLab forge's account capability", () => {
  const never: Runner = async () => { throw new Error("no call expected"); };

  // glab stores one token per host and has no `auth switch`. Stated, not faked:
  // a single-entry list would read as "you have exactly one account".
  it("declares that it cannot", () => {
    expect(resolveForge("gitlab", () => {}, never).caps.accounts).toBe(false);
  });

  it("enumerates nothing, without spawning glab", async () => {
    expect(await resolveForge("gitlab", () => {}, never).accounts()).toEqual([]);
  });

  it("refuses to switch, and says why, without spawning glab", async () => {
    const res = await resolveForge("gitlab", () => {}, never).switchAccount("anyone");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toMatch(/one token per host/i);
  });
});

describe("the Bitbucket forge's account capability", () => {
  const never: Runner = async () => { throw new Error("no call expected"); };

  // atlassian-cli DOES have named profiles, unlike glab — but its AuthCommand
  // surface has no switch verb, so it cannot be told even though it can list.
  // accounts is one flag for both directions, so this asymmetry still answers
  // false.
  it("declares that it cannot", () => {
    expect(resolveForge("bitbucket", () => {}, never).caps.accounts).toBe(false);
  });

  it("enumerates nothing, without spawning atlassian-cli", async () => {
    expect(await resolveForge("bitbucket", () => {}, never).accounts()).toEqual([]);
  });

  it("refuses to switch, and names the missing verb, without spawning atlassian-cli", async () => {
    const res = await resolveForge("bitbucket", () => {}, never).switchAccount("anyone");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toMatch(/switch/i);
  });
});

describe("a failed GitHub switch names gh's complaint, never the argv", () => {
  // execRunner attaches gh's stderr separately from `.message`, which for a real
  // spawn failure is Node's reconstructed "Command failed: <file> <full argv>" —
  // carrying the account name and hostname flags a toast must never echo back
  // ahead of what gh actually said (docs/FORGES.md §4).
  const ARGV_MESSAGE = "Command failed: /usr/bin/gh auth switch --hostname github.com --user nobody";

  it("prefers gh's own stderr over Node's reconstructed message", async () => {
    const run: Runner = async () => {
      throw Object.assign(new Error(ARGV_MESSAGE), { stderr: "X no accounts matched that criteria\n" });
    };
    const res = await resolveForge("github", () => {}, run).switchAccount("nobody");
    expect(res).toEqual({ ok: false, message: "X no accounts matched that criteria" });
  });

  it("says something fixed and argv-free when gh wrote no stderr at all", async () => {
    const run: Runner = async () => {
      throw new Error(ARGV_MESSAGE);
    };
    const res = await resolveForge("github", () => {}, run).switchAccount("nobody");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).not.toContain("nobody");
    expect(res.ok === false && res.message).not.toContain("Command failed");
    expect(res.ok === false && res.message).toContain("check gh directly");
  });

  it("treats whitespace-only stderr as no stderr, falling through to the message path", async () => {
    const run: Runner = async () => {
      throw Object.assign(new Error("plain failure with no argv"), { stderr: "  \n" });
    };
    const res = await resolveForge("github", () => {}, run).switchAccount("nobody");
    expect(res).toEqual({ ok: false, message: "plain failure with no argv" });
  });
});
