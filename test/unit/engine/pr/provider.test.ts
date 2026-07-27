import { describe, it, expect, vi } from "vitest";
import { GhProvider, probeGh, PR_JSON_FIELDS, GH_TIMEOUT_MS } from "../../../../src/engine/pr/provider";
import type { Runner } from "../../../../src/engine/pr/provider";

/** An absolute path, as a real lookup returns: nothing here may depend on the
 * bare name `gh` being resolvable from the test process's own PATH. */
const GH = "/opt/homebrew/bin/gh";
const provider = (run: Runner) => new GhProvider(run, () => GH);

const pr = (over: Record<string, unknown> = {}) => ({
  number: 4821, url: "https://github.com/acme/api/pull/4821", title: "Fix export",
  state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  reviewDecision: null, statusCheckRollup: [], ...over,
});

/** A Runner that replies from a queue of canned stdout strings. */
function scripted(...replies: (string | Error)[]): { run: Runner; calls: { file: string; args: string[]; cwd: string }[] } {
  const calls: { file: string; args: string[]; cwd: string }[] = [];
  let i = 0;
  const run: Runner = async (file, args, opts) => {
    calls.push({ file, args, cwd: opts.cwd });
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  return { run, calls };
}

describe("GhProvider.fetch — argv", () => {
  it("asks gh for the head branch first, in the repo directory, with every field", async () => {
    const { run, calls } = scripted(JSON.stringify([pr()]));
    await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe(GH);
    expect(calls[0].cwd).toBe("/r/api");
    expect(calls[0].args).toEqual([
      "pr", "list", "--head", "feat/ASM-1", "--state", "all", "--limit", "10", "--json", PR_JSON_FIELDS,
    ]);
  });

  it("falls back to a Jira-key title search when the branch has no PR", async () => {
    const { run, calls } = scripted("[]", JSON.stringify([pr({ number: 77 })]));
    const res = await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");

    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual([
      "pr", "list", "--search", "ASM-1 in:title", "--state", "all", "--limit", "10", "--json", PR_JSON_FIELDS,
    ]);
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ number: 77 }) });
  });

  it("goes straight to the key search when the repo has no branch", async () => {
    const { run, calls } = scripted(JSON.stringify([pr()]));
    await provider(run).fetch("/r/api", null, "ASM-1");

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain("--search");
  });

  it("passes the 10s timeout to the runner", async () => {
    const run = vi.fn<Runner>(async () => "[]");
    await provider(run).fetch("/r/api", "b", "ASM-1");
    expect(GH_TIMEOUT_MS).toBe(10_000);
    expect(run).toHaveBeenCalledWith(GH, expect.any(Array), { cwd: "/r/api", timeoutMs: 10_000 });
  });

  it("spawns the located binary for every call, not the bare name", async () => {
    // The extension host's PATH may hold nothing but /usr/bin:/bin:/usr/sbin:/sbin,
    // so a bare "gh" that the probe already resolved once must not come back as a
    // PATH lookup here — that would ENOENT on the list and the GraphQL call alike.
    const { run, calls } = scripted(
      JSON.stringify([pr({ reviewDecision: "APPROVED" })]),
      JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
    );
    await provider(run).fetch("/r/api", "b", "ASM-1");
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.file)).toEqual([GH, GH]);
  });

  it("falls back to the bare name when the lookup comes up empty", async () => {
    // Nothing is lost by still asking: on a platform whose install dirs we do not
    // list, the OS's own PATH resolution is the only chance left.
    const { run, calls } = scripted("[]", "[]");
    await new GhProvider(run, () => null).fetch("/r/api", "b", "ASM-1");
    expect(calls[0].file).toBe("gh");
  });
});

describe("GhProvider.fetch — results", () => {
  it("reports no PR when both lookups come back empty", async () => {
    const { run } = scripted("[]", "[]");
    expect(await provider(run).fetch("/r/api", "b", "ASM-1")).toEqual({ ok: true, facts: null });
  });

  it("prefers OPEN over MERGED when a branch has both", async () => {
    const { run } = scripted(JSON.stringify([pr({ number: 1, state: "MERGED" }), pr({ number: 2, state: "OPEN" })]));
    const res = await provider(run).fetch("/r/api", "b", "ASM-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ number: 2, state: "OPEN" }) });
  });

  it("reports failure — not 'no PR' — when gh errors", async () => {
    const { run } = scripted(new Error("gh: command not found"));
    expect(await provider(run).fetch("/r/api", "b", "ASM-1")).toEqual({ ok: false });
  });

  it("reports failure on unparseable stdout", async () => {
    const { run } = scripted("not json");
    expect(await provider(run).fetch("/r/api", "b", "ASM-1")).toEqual({ ok: false });
  });

  it("reports failure when gh returns a non-array payload", async () => {
    const { run } = scripted(JSON.stringify({ message: "Not Found" }));
    expect(await provider(run).fetch("/r/api", "b", "ASM-1")).toEqual({ ok: false });
  });

  it("reports failure rather than throwing when statusCheckRollup contains a malformed entry", async () => {
    // A null element inside statusCheckRollup makes mapRollup's `c.name` throw a
    // TypeError. toPrFacts must stay inside fetch's own try/catch so that surfaces
    // as `{ ok: false }` — an uncaught throw here would leave enqueuePr's write
    // unreached and re-arm this repo's fetch on every tick, forever (F1).
    const { run } = scripted(JSON.stringify([pr({ statusCheckRollup: [null] })]));
    expect(await provider(run).fetch("/r/api", "b", "ASM-1")).toEqual({ ok: false });
  });
});

describe("GhProvider.fetch — review threads", () => {
  const threads = (nodes: { isResolved: boolean; isOutdated: boolean }[]) =>
    JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });

  it("skips the GraphQL call when there is no review decision", async () => {
    const { run, calls } = scripted(JSON.stringify([pr({ reviewDecision: null })]));
    const res = await provider(run).fetch("/r/api", "b", "ASM-1");
    expect(calls).toHaveLength(1);
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ unresolved: null }) });
  });

  it("counts unresolved, non-outdated threads when a decision exists", async () => {
    const { run, calls } = scripted(
      JSON.stringify([pr({ reviewDecision: "CHANGES_REQUESTED" })]),
      threads([
        { isResolved: false, isOutdated: false },
        { isResolved: false, isOutdated: false },
        { isResolved: true, isOutdated: false },
        { isResolved: false, isOutdated: true },
      ]),
    );
    const res = await provider(run).fetch("/r/api", "b", "ASM-1");

    expect(calls).toHaveLength(2);
    expect(calls[1].args[0]).toBe("api");
    expect(calls[1].args).toContain("graphql");
    expect(calls[1].args).toContain("o=acme");
    expect(calls[1].args).toContain("r=api");
    expect(calls[1].args).toContain("n=4821");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ unresolved: 2, review: "changes_requested" }) });
  });

  it("keeps the PR facts with a null count when the GraphQL call fails", async () => {
    const { run } = scripted(JSON.stringify([pr({ reviewDecision: "APPROVED" })]), new Error("rate limited"));
    const res = await provider(run).fetch("/r/api", "b", "ASM-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ review: "approved", unresolved: null }) });
  });

  it("skips the GraphQL call when the PR url has no parseable owner/repo", async () => {
    const { run, calls } = scripted(JSON.stringify([pr({ reviewDecision: "APPROVED", url: "https://example.com/x" })]));
    const res = await provider(run).fetch("/r/api", "b", "ASM-1");
    expect(calls).toHaveLength(1);
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ unresolved: null }) });
  });
});

describe("probeGh", () => {
  /** execFile's two failure shapes: `code` is the exit status for a process that
   * ran, and the string "ENOENT" when there was no binary to run. */
  const failed = (message: string, code: string | number) => Object.assign(new Error(message), { code });

  it("reports no gap when gh auth status succeeds, asking the located binary", async () => {
    const { run, calls } = scripted("Logged in to github.com");
    expect(await probeGh(run, () => GH)).toBeNull();
    expect(calls[0].file).toBe(GH);
    expect(calls[0].args).toEqual(["auth", "status"]);
  });

  it("reports `missing` only when there was no binary to spawn", async () => {
    const { run } = scripted(failed("spawn gh ENOENT", "ENOENT"));
    expect(await probeGh(run, () => null)).toMatchObject({ kind: "missing" });
  });

  it("reports `signed-out`, not `missing`, when a gh we found refuses auth status", async () => {
    // The two used to collapse into one note reading "gh not found or not signed
    // in", which left a signed-in user with an unresolved PATH nothing to act on.
    const { run } = scripted(failed("Command failed: gh auth status", 1));
    expect(await probeGh(run, () => GH)).toMatchObject({ kind: "signed-out" });
  });

  it("carries the binary and the underlying error as detail, for the log", async () => {
    const { run } = scripted(failed("You are not logged into any GitHub hosts", 1));
    const gap = await probeGh(run, () => GH);
    expect(gap?.detail).toContain(GH);
    expect(gap?.detail).toContain("not logged into any GitHub hosts");
  });

  it("still asks the OS when the lookup finds nothing", async () => {
    const { run, calls } = scripted("Logged in to github.com");
    expect(await probeGh(run, () => null)).toBeNull();
    expect(calls[0].file).toBe("gh");
  });
});
