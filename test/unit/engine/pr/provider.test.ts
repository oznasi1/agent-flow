import { describe, it, expect, vi } from "vitest";
import { GhProvider, ghAvailable, PR_JSON_FIELDS, GH_TIMEOUT_MS } from "../../../../src/engine/pr/provider";
import type { Runner } from "../../../../src/engine/pr/provider";

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
    await new GhProvider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("gh");
    expect(calls[0].cwd).toBe("/r/api");
    expect(calls[0].args).toEqual([
      "pr", "list", "--head", "feat/ASM-1", "--state", "all", "--limit", "10", "--json", PR_JSON_FIELDS,
    ]);
  });

  it("falls back to a Jira-key title search when the branch has no PR", async () => {
    const { run, calls } = scripted("[]", JSON.stringify([pr({ number: 77 })]));
    const res = await new GhProvider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");

    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual([
      "pr", "list", "--search", "ASM-1 in:title", "--state", "all", "--limit", "10", "--json", PR_JSON_FIELDS,
    ]);
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ number: 77 }) });
  });

  it("goes straight to the key search when the repo has no branch", async () => {
    const { run, calls } = scripted(JSON.stringify([pr()]));
    await new GhProvider(run).fetch("/r/api", null, "ASM-1");

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain("--search");
  });

  it("passes the 10s timeout to the runner", async () => {
    const run = vi.fn<Runner>(async () => "[]");
    await new GhProvider(run).fetch("/r/api", "b", "ASM-1");
    expect(GH_TIMEOUT_MS).toBe(10_000);
    expect(run).toHaveBeenCalledWith("gh", expect.any(Array), { cwd: "/r/api", timeoutMs: 10_000 });
  });
});

describe("GhProvider.fetch — results", () => {
  it("reports no PR when both lookups come back empty", async () => {
    const { run } = scripted("[]", "[]");
    expect(await new GhProvider(run).fetch("/r/api", "b", "ASM-1")).toEqual({ ok: true, facts: null });
  });

  it("prefers OPEN over MERGED when a branch has both", async () => {
    const { run } = scripted(JSON.stringify([pr({ number: 1, state: "MERGED" }), pr({ number: 2, state: "OPEN" })]));
    const res = await new GhProvider(run).fetch("/r/api", "b", "ASM-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ number: 2, state: "OPEN" }) });
  });

  it("reports failure — not 'no PR' — when gh errors", async () => {
    const { run } = scripted(new Error("gh: command not found"));
    expect(await new GhProvider(run).fetch("/r/api", "b", "ASM-1")).toEqual({ ok: false });
  });

  it("reports failure on unparseable stdout", async () => {
    const { run } = scripted("not json");
    expect(await new GhProvider(run).fetch("/r/api", "b", "ASM-1")).toEqual({ ok: false });
  });

  it("reports failure when gh returns a non-array payload", async () => {
    const { run } = scripted(JSON.stringify({ message: "Not Found" }));
    expect(await new GhProvider(run).fetch("/r/api", "b", "ASM-1")).toEqual({ ok: false });
  });
});

describe("GhProvider.fetch — review threads", () => {
  const threads = (nodes: { isResolved: boolean; isOutdated: boolean }[]) =>
    JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });

  it("skips the GraphQL call when there is no review decision", async () => {
    const { run, calls } = scripted(JSON.stringify([pr({ reviewDecision: null })]));
    const res = await new GhProvider(run).fetch("/r/api", "b", "ASM-1");
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
    const res = await new GhProvider(run).fetch("/r/api", "b", "ASM-1");

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
    const res = await new GhProvider(run).fetch("/r/api", "b", "ASM-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ review: "approved", unresolved: null }) });
  });

  it("skips the GraphQL call when the PR url has no parseable owner/repo", async () => {
    const { run, calls } = scripted(JSON.stringify([pr({ reviewDecision: "APPROVED", url: "https://example.com/x" })]));
    const res = await new GhProvider(run).fetch("/r/api", "b", "ASM-1");
    expect(calls).toHaveLength(1);
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ unresolved: null }) });
  });
});

describe("ghAvailable", () => {
  it("is true when gh auth status succeeds", async () => {
    const { run, calls } = scripted("Logged in to github.com");
    expect(await ghAvailable(run)).toBe(true);
    expect(calls[0].args).toEqual(["auth", "status"]);
  });

  it("is false when gh is missing or unauthenticated", async () => {
    const { run } = scripted(new Error("not logged in"));
    expect(await ghAvailable(run)).toBe(false);
  });
});
