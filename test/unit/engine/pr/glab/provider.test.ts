import { describe, it, expect } from "vitest";
import { GlabProvider, probeGlab, GLAB_TIMEOUT_MS } from "../../../../../src/engine/pr/glab/provider";
import type { Runner } from "../../../../../src/engine/pr/provider";

/** An absolute path, as a real lookup returns: nothing here may depend on the bare
 * name `glab` being resolvable from the test process's own PATH. */
const GLAB = "/opt/homebrew/bin/glab";
const provider = (run: Runner) => new GlabProvider(run, () => GLAB);

const MR = {
  iid: 12, web_url: "https://gitlab.com/group/sub/proj/-/merge_requests/12",
  title: "Fix export", state: "opened", draft: false, source_branch: "feat/ASM-1",
  has_conflicts: false, detailed_merge_status: "mergeable",
  blocking_discussions_resolved: true, head_pipeline: null,
};

/** A Runner that replies by matching the request path, so a test states what each
 * endpoint returns instead of depending on call order. An unmatched path throws,
 * which is what the real `glab` does for a bad route. */
function routed(routes: Record<string, string | Error>): { run: Runner; calls: { args: string[]; cwd: string }[] } {
  const calls: { args: string[]; cwd: string }[] = [];
  const run: Runner = async (file, args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    expect(file).toBe(GLAB);
    const hit = Object.entries(routes).find(([frag]) => args.some((a) => a.includes(frag)));
    if (!hit) throw new Error(`no route for ${args.join(" ")}`);
    if (hit[1] instanceof Error) throw hit[1];
    return hit[1];
  };
  return { run, calls };
}

describe("GlabProvider.fetch — argv", () => {
  it("asks for the source branch first, in the repo directory", async () => {
    const { run, calls } = routed({ source_branch: JSON.stringify([MR]), approvals: "{}" });
    await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");

    expect(calls[0].cwd).toBe("/r/api");
    expect(calls[0].args[0]).toBe("api");
    expect(calls[0].args[1]).toContain("projects/:fullpath/merge_requests");
    expect(calls[0].args[1]).toContain("source_branch=feat%2FASM-1");
    expect(calls[0].args[1]).toContain("state=all");
  });

  it("falls back to a key title search when the branch has no MR", async () => {
    const { run, calls } = routed({ source_branch: "[]", search: JSON.stringify([MR]), approvals: "{}" });
    const res = await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");

    expect(calls[1].args[1]).toContain("search=ASM-1");
    expect(calls[1].args[1]).toContain("in=title");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ number: 12 }) });
  });

  it("searches by key alone when there is no branch", async () => {
    const { run, calls } = routed({ search: JSON.stringify([MR]), approvals: "{}" });
    await provider(run).fetch("/r/api", null, "ASM-1");
    expect(calls).toHaveLength(2); // the search, then approvals — no branch call
    expect(calls[0].args[1]).toContain("search=ASM-1");
  });

  it("url-encodes a branch containing a slash and a key containing a space", async () => {
    const { run, calls } = routed({ merge_requests: "[]" });
    await provider(run).fetch("/r/api", "feat/a b", "A B");
    expect(calls[0].args[1]).toContain("source_branch=feat%2Fa%20b");
    expect(calls[1].args[1]).toContain("search=A%20B");
  });

  it("uses the shared 10s timeout", async () => {
    let seen = 0;
    const run: Runner = async (_f, _a, opts) => { seen = opts.timeoutMs; return "[]"; };
    await new GlabProvider(run, () => GLAB).fetch("/r/api", "b", "K");
    expect(seen).toBe(GLAB_TIMEOUT_MS);
  });

  it("falls back to the bare name when the binary cannot be located", async () => {
    let file = "";
    const run: Runner = async (f) => { file = f; return "[]"; };
    await new GlabProvider(run, () => null).fetch("/r/api", "b", "K");
    expect(file).toBe("glab");
  });
});

describe("GlabProvider.fetch — assembly", () => {
  it("reports no MR — not a failure — when both lookups come back empty", async () => {
    const { run } = routed({ merge_requests: "[]" });
    expect(await provider(run).fetch("/r/api", "b", "K")).toEqual({ ok: true, facts: null });
  });

  it("skips the discussions call when blocking discussions are resolved, and reports 0", async () => {
    const { run, calls } = routed({ source_branch: JSON.stringify([MR]), approvals: "{}" });
    const res = await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");

    expect(calls.some((c) => c.args[1].includes("discussions"))).toBe(false);
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ unresolved: 0 }) });
  });

  it("fetches discussions when blocking discussions are NOT resolved", async () => {
    const mr = { ...MR, blocking_discussions_resolved: false };
    const { run } = routed({
      source_branch: JSON.stringify([mr]),
      approvals: "{}",
      discussions: JSON.stringify([{ notes: [{ resolvable: true, resolved: false }] }]),
    });
    const res = await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ unresolved: 1 }) });
  });

  it("fetches the pipeline's jobs by head_pipeline id, and maps them", async () => {
    const mr = { ...MR, head_pipeline: { id: 777, status: "failed" } };
    const { run, calls } = routed({
      source_branch: JSON.stringify([mr]),
      approvals: "{}",
      jobs: JSON.stringify([
        { name: "build", status: "success" },
        { name: "lint", status: "failed", web_url: "https://gl/j/lint", allow_failure: false },
      ]),
    });
    const res = await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");

    expect(calls.some((c) => c.args[1].includes("pipelines/777/jobs"))).toBe(true);
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({
      ci: { passing: 1, pending: 0, failing: [{ name: "lint", url: "https://gl/j/lint" }] },
      ciAdvisory: false,
    }) });
  });

  it("skips the jobs call entirely when the MR has no pipeline", async () => {
    const { run, calls } = routed({ source_branch: JSON.stringify([MR]), approvals: "{}" });
    await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");
    expect(calls.some((c) => c.args[1].includes("jobs"))).toBe(false);
  });

  it("maps approvals into the review verdict", async () => {
    const { run } = routed({
      source_branch: JSON.stringify([MR]),
      approvals: JSON.stringify({ approved: true, approvals_required: 1 }),
    });
    const res = await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ review: "approved" }) });
  });
});

describe("GlabProvider.fetch — degradation", () => {
  it("fails the whole fetch when the MR lookup itself fails", async () => {
    const { run } = routed({ merge_requests: new Error("boom") });
    expect(await provider(run).fetch("/r/api", "b", "K")).toEqual({ ok: false });
  });

  it("fails the whole fetch on unparseable MR-list output", async () => {
    const { run } = routed({ merge_requests: "not json" });
    expect(await provider(run).fetch("/r/api", "b", "K")).toEqual({ ok: false });
  });

  it("fails the whole fetch when the MR list is not an array", async () => {
    const { run } = routed({ merge_requests: '{"message":"404 Not Found"}' });
    expect(await provider(run).fetch("/r/api", "b", "K")).toEqual({ ok: false });
  });

  // A sub-call is a detail, not the answer. Losing one must never discard the MR
  // we already found — and must never throw out of fetch, because an uncaught
  // throw leaves the caller's cache entry unstamped, which re-arms this repo's
  // fetch on every tick, forever.
  it("still returns facts when the approvals call fails, with review none", async () => {
    const { run } = routed({ source_branch: JSON.stringify([MR]), approvals: new Error("403") });
    const res = await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ number: 12, review: "none" }) });
  });

  it("still returns facts when the jobs call fails, with an empty ci tally", async () => {
    const mr = { ...MR, head_pipeline: { id: 777 } };
    const { run } = routed({ source_branch: JSON.stringify([mr]), approvals: "{}", jobs: new Error("500") });
    const res = await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({
      ci: { passing: 0, pending: 0, failing: [] }, ciAdvisory: false,
    }) });
  });

  it("still returns facts when the discussions call fails, with unresolved null", async () => {
    const mr = { ...MR, blocking_discussions_resolved: false };
    const { run } = routed({ source_branch: JSON.stringify([mr]), approvals: "{}", discussions: new Error("500") });
    const res = await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ unresolved: null }) });
  });
});

describe("probeGlab", () => {
  it("returns null when auth status succeeds", async () => {
    const run: Runner = async (_f, args) => { expect(args).toEqual(["auth", "status"]); return "ok"; };
    expect(await probeGlab(run, () => GLAB)).toBeNull();
  });

  // ENOENT is the only answer that means "not installed" — anything else came from
  // a glab that ran, so blaming the install would send the user hunting for a
  // binary they already have.
  it("reports missing only on ENOENT", async () => {
    const enoent = Object.assign(new Error("spawn glab ENOENT"), { code: "ENOENT" });
    expect(await probeGlab(async () => { throw enoent; }, () => GLAB)).toMatchObject({ kind: "missing" });
  });

  it("reports signed-out for any other failure", async () => {
    const gap = await probeGlab(async () => { throw new Error("no token"); }, () => GLAB);
    expect(gap).toMatchObject({ kind: "signed-out" });
    expect(gap?.detail).toContain(GLAB);
  });
});
