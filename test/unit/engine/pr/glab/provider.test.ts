import { describe, it, expect } from "vitest";
import { GlabProvider, probeGlab, GLAB_TIMEOUT_MS } from "../../../../../src/engine/pr/glab/provider";
import type { Runner } from "../../../../../src/engine/pr/provider";
import type { MergeMethod } from "../../../../../src/types";

/** An absolute path, as a real lookup returns: nothing here may depend on the bare
 * name `glab` being resolvable from the test process's own PATH. */
const GLAB = "/opt/homebrew/bin/glab";
const provider = (run: Runner) => new GlabProvider(run, () => GLAB);

/** One row of a `merge_requests?…` LIST response, as gitlab.com actually sends it:
 * **no `head_pipeline`, and no pipeline field of any kind.** Verified against the
 * live API. Do not add one back "for completeness" — a list fixture that carries a
 * pipeline is what let the provider ship reading CI from a field that is never
 * there, with every GitLab card silently showing no CI. The pipeline belongs in
 * `shown()` below, which is the only response that has one. */
const MR = {
  iid: 12, web_url: "https://gitlab.com/group/sub/proj/-/merge_requests/12",
  title: "Fix export", state: "opened", draft: false, source_branch: "feat/PROJ-1",
  has_conflicts: false, detailed_merge_status: "mergeable",
  blocking_discussions_resolved: true,
};

/** The same MR as the SINGLE-MR endpoint sends it: everything the list row has,
 * plus the `head_pipeline` only this route carries. */
const shown = (over: Record<string, unknown> = {}): string => JSON.stringify({ ...MR, ...over });

/** A Runner that replies by matching the request path, so a test states what each
 * endpoint returns instead of depending on call order. An unmatched path throws,
 * which is what the real `glab` does for a bad route.
 *
 * Lookup is by insertion order, not specificity: the approvals and discussions
 * paths ("…/merge_requests/12/approvals") also contain "merge_requests/12", so a
 * test routing the single-MR read must list those more specific fragments BEFORE
 * the bare "merge_requests/12" key or they will match the wrong route. */
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
    const { run, calls } = routed({
      source_branch: JSON.stringify([MR]), approvals: "{}", "merge_requests/12": shown(),
    });
    await provider(run).fetch("/r/api", "feat/PROJ-1", "PROJ-1");

    expect(calls[0].cwd).toBe("/r/api");
    expect(calls[0].args[0]).toBe("api");
    expect(calls[0].args[1]).toContain("projects/:fullpath/merge_requests");
    expect(calls[0].args[1]).toContain("source_branch=feat%2FPROJ-1");
    expect(calls[0].args[1]).toContain("state=all");
  });

  it("falls back to a key title search when the branch has no MR", async () => {
    const { run, calls } = routed({
      source_branch: "[]", search: JSON.stringify([MR]), approvals: "{}", "merge_requests/12": shown(),
    });
    const res = await provider(run).fetch("/r/api", "feat/PROJ-1", "PROJ-1");

    expect(calls[1].args[1]).toContain("search=PROJ-1");
    expect(calls[1].args[1]).toContain("in=title");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ number: 12 }) });
  });

  it("searches by key alone when there is no branch", async () => {
    const { run, calls } = routed({ search: JSON.stringify([MR]), approvals: "{}", "merge_requests/12": shown() });
    await provider(run).fetch("/r/api", null, "PROJ-1");
    // The search, the single-MR read, then approvals — and no branch call.
    expect(calls).toHaveLength(3);
    expect(calls[0].args[1]).toContain("search=PROJ-1");
  });

  // The list row is not enough: GitLab sends `head_pipeline` on the single-MR route
  // and nowhere else, so this call is the only reason a card can show CI at all.
  it("reads the found MR individually, by iid, with no query of its own", async () => {
    const { run, calls } = routed({
      source_branch: JSON.stringify([MR]), approvals: "{}", "merge_requests/12": shown(),
    });
    await provider(run).fetch("/r/api", "feat/PROJ-1", "PROJ-1");

    expect(calls[1].cwd).toBe("/r/api");
    expect(calls[1].args).toEqual(["api", "projects/:fullpath/merge_requests/12"]);
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
    const { run, calls } = routed({
      source_branch: JSON.stringify([MR]), approvals: "{}", "merge_requests/12": shown(),
    });
    const res = await provider(run).fetch("/r/api", "feat/PROJ-1", "PROJ-1");

    expect(calls.some((c) => c.args[1].includes("discussions"))).toBe(false);
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ unresolved: 0 }) });
  });

  it("fetches discussions when blocking discussions are NOT resolved", async () => {
    const mr = { ...MR, blocking_discussions_resolved: false };
    const { run } = routed({
      source_branch: JSON.stringify([mr]),
      approvals: "{}",
      discussions: JSON.stringify([{ notes: [{ resolvable: true, resolved: false }] }]),
      "merge_requests/12": JSON.stringify(mr),
    });
    const res = await provider(run).fetch("/r/api", "feat/PROJ-1", "PROJ-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ unresolved: 1 }) });
  });

  // THE regression test for the bug this file's fixtures hid: the list row carries no
  // pipeline of any kind, so a provider that reads `head_pipeline` off it tallies
  // zeros forever and every GitLab card shows no CI. The pipeline reaches us only
  // through the single-MR read, and the proof is a real tally from a list row that
  // never mentioned a pipeline. Delete the `show` call and this goes red.
  it("still tallies CI from a list row with no head_pipeline, because the single-MR read supplies the pipeline", async () => {
    const { run, calls } = routed({
      source_branch: JSON.stringify([MR]),
      approvals: "{}",
      jobs: JSON.stringify([
        { name: "build", status: "success" },
        { name: "lint", status: "failed", web_url: "https://gl/j/lint", allow_failure: false },
      ]),
      "merge_requests/12": shown({ head_pipeline: { id: 777, status: "failed" } }),
    });
    const res = await provider(run).fetch("/r/api", "feat/PROJ-1", "PROJ-1");

    expect(MR).not.toHaveProperty("head_pipeline"); // the premise, pinned
    expect(calls.some((c) => c.args[1].includes("pipelines/777/jobs"))).toBe(true);
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({
      ci: { passing: 1, pending: 0, failing: [{ name: "lint", url: "https://gl/j/lint" }] },
      ciAdvisory: false,
    }) });
  });

  it("skips the jobs call entirely when the MR has no pipeline", async () => {
    const { run, calls } = routed({
      source_branch: JSON.stringify([MR]), approvals: "{}", "merge_requests/12": shown({ head_pipeline: null }),
    });
    await provider(run).fetch("/r/api", "feat/PROJ-1", "PROJ-1");
    expect(calls.some((c) => c.args[1].includes("jobs"))).toBe(false);
  });

  it("maps approvals into the review verdict", async () => {
    const { run } = routed({
      source_branch: JSON.stringify([MR]),
      approvals: JSON.stringify({ approved: true, approvals_required: 1 }),
      "merge_requests/12": shown(),
    });
    const res = await provider(run).fetch("/r/api", "feat/PROJ-1", "PROJ-1");
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
    const { run } = routed({
      source_branch: JSON.stringify([MR]), approvals: new Error("403"), "merge_requests/12": shown(),
    });
    const res = await provider(run).fetch("/r/api", "feat/PROJ-1", "PROJ-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ number: 12, review: "none" }) });
  });

  it("still returns facts when the jobs call fails, with an empty ci tally", async () => {
    const { run } = routed({
      source_branch: JSON.stringify([MR]),
      approvals: "{}",
      jobs: new Error("500"),
      "merge_requests/12": shown({ head_pipeline: { id: 777 } }),
    });
    const res = await provider(run).fetch("/r/api", "feat/PROJ-1", "PROJ-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({
      ci: { passing: 0, pending: 0, failing: [] }, ciAdvisory: false,
    }) });
  });

  it("still returns facts when the discussions call fails, with unresolved null", async () => {
    const mr = { ...MR, blocking_discussions_resolved: false };
    const { run } = routed({
      source_branch: JSON.stringify([mr]),
      approvals: "{}",
      discussions: new Error("500"),
      "merge_requests/12": JSON.stringify(mr),
    });
    const res = await provider(run).fetch("/r/api", "feat/PROJ-1", "PROJ-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ unresolved: null }) });
  });

  // The single-MR read is a detail like any other: it exists to add the pipeline, so
  // losing it must cost the CI tally and nothing else. Drop the `?? found` fallback
  // and this returns `{ ok: false }` instead — the MR the user has open vanishes from
  // the card because one optional round trip failed. Asserted whole, not with
  // objectContaining, so the fallback is pinned to preserve every fact the list row
  // already had right.
  it("still returns the list row's facts when the single-MR read fails, with an empty ci tally", async () => {
    const { run } = routed({
      source_branch: JSON.stringify([MR]), approvals: "{}", "merge_requests/12": new Error("500"),
    });
    expect(await provider(run).fetch("/r/api", "feat/PROJ-1", "PROJ-1")).toEqual({ ok: true, facts: {
      number: 12,
      url: "https://gitlab.com/group/sub/proj/-/merge_requests/12",
      title: "Fix export",
      state: "OPEN",
      isDraft: false,
      ci: { passing: 0, pending: 0, failing: [] },
      review: "none",
      unresolved: 0,
      mergeable: "clean",
      ciAdvisory: false,
    } });
  });

  // An error body parses fine and is not an MR. Handing one to `toMrFacts` would
  // yield `facts: null` — "there is genuinely no merge request" — for an MR the list
  // just found, so anything without an identity falls back to the list row instead.
  it.each([
    ["an error object", '{"message":"404 Not Found"}'],
    ["a null body", "null"],
    ["an array", "[]"],
    ["a record with no identity", '{"title":"Fix export"}'],
    // An empty url is no url: `toMrFacts` rejects on `!mr.web_url`, so a guard that
    // accepted any string here would hand it a record it then turns into `facts: null`.
    ["a record whose web_url is empty", '{"iid":12,"web_url":""}'],
  ])("falls back to the list row when the single-MR read answers with %s", async (_what, body) => {
    const { run } = routed({ source_branch: JSON.stringify([MR]), approvals: "{}", "merge_requests/12": body });
    expect(await provider(run).fetch("/r/api", "feat/PROJ-1", "PROJ-1")).toEqual({ ok: true, facts: expect.objectContaining({
      number: 12, title: "Fix export", ci: { passing: 0, pending: 0, failing: [] },
    }) });
  });
});

describe("GlabProvider.merge", () => {
  it("squashes through the merge endpoint, in the repo directory", async () => {
    const { run, calls } = routed({ "merge_requests/4821/merge": "{}" });
    const out = await provider(run).merge("/r/api", 4821, "squash");

    expect(out).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe("/r/api");
    // `projects/:fullpath` is glab's own placeholder, resolved from the git remote
    // of the directory the call runs in — never from Agent Flow's name for the
    // checkout. `-F` (not `-f`) so `true`/`false` reach GitLab as a JSON boolean
    // rather than the string "true"; no user-authored text goes through this flag,
    // so `-F`'s leading-`@`-is-a-filename behaviour cannot bite here.
    expect(calls[0].args).toEqual([
      "api", "projects/:fullpath/merge_requests/4821/merge", "--method", "PUT", "-F", "squash=true",
    ]);
  });

  it("sends squash=false for a plain merge, leaving the commit shape to the project setting", async () => {
    const { run, calls } = routed({ "merge_requests/4821/merge": "{}" });
    const out = await provider(run).merge("/r/api", 4821, "merge");
    expect(out).toEqual({ ok: true });
    expect(calls[0].args).toEqual([
      "api", "projects/:fullpath/merge_requests/4821/merge", "--method", "PUT", "-F", "squash=false",
    ]);
  });

  it("threads the given number, not a hardcoded one", async () => {
    const { run, calls } = routed({ "merge_requests/7/merge": "{}" });
    await provider(run).merge("/r/web", 7, "squash");
    expect(calls[0].args[1]).toBe("projects/:fullpath/merge_requests/7/merge");
    expect(calls[0].cwd).toBe("/r/web");
  });

  it("refuses rebase in words rather than substituting another strategy, before spawning", async () => {
    // GitLab's merge API has no per-request rebase: the project's Merge method
    // setting decides. Silently sending squash=false here would merge a way the
    // user did not choose — the worst possible degradation for this seam.
    const { run, calls } = routed({ "merge_requests/4821/merge": "{}" });
    const out = await provider(run).merge("/r/api", 4821, "rebase");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toContain("rebase");
      expect(out.message).toContain("agentFlow.mergeMethod");
    }
    expect(calls).toHaveLength(0);
  });

  it.each(["Squash", "constructor"] as const)("refuses an out-of-union method (%s) before spawning", async (method) => {
    const { run, calls } = routed({ "merge_requests/4821/merge": "{}" });
    const out = await provider(run).merge("/r/api", 4821, method as unknown as MergeMethod);
    expect(out).toEqual({ ok: false, message: `Unknown merge method: ${method}` });
    expect(calls).toHaveLength(0);
  });

  it("prefers stderr — GitLab's own wording — over the reconstructed command line", async () => {
    const err = Object.assign(
      new Error("Command failed: glab api projects/:fullpath/merge_requests/4821/merge --method PUT -F squash=true\nPOST https://gitlab.com/api/v4/...: 405 {message: Method Not Allowed}"),
      { stderr: "405 {message: Method Not Allowed}" },
    );
    const { run } = routed({ "merge_requests/4821/merge": err });
    const out = await provider(run).merge("/r/api", 4821, "squash");
    expect(out).toEqual({ ok: false, message: "405 {message: Method Not Allowed}" });
    if (!out.ok) expect(out.message).not.toContain("Command failed");
  });

  it("never returns the raw command line when the rejection carries no stderr", async () => {
    const { run } = routed({
      "merge_requests/4821/merge": new Error("Command failed: glab api projects/:fullpath/merge_requests/4821/merge --method PUT"),
    });
    const out = await provider(run).merge("/r/api", 4821, "squash");
    expect(out).toEqual({
      ok: false,
      message: "glab failed without further detail — check the merge request directly.",
    });
  });

  it.each([
    ["killed", { killed: true }],
    ["code ETIMEDOUT", { code: "ETIMEDOUT" }],
  ])("returns wording that does not claim GitLab refused, on a %s rejection", async (_label, shape) => {
    const err = Object.assign(new Error("Command failed: glab api projects/:fullpath/merge_requests/4821/merge --method PUT"), shape);
    const { run } = routed({ "merge_requests/4821/merge": err });
    const out = await provider(run).merge("/r/api", 4821, "squash");
    expect(out).toEqual({
      ok: false,
      message: `Timed out after ${GLAB_TIMEOUT_MS / 1000}s — the merge may already have gone through. Open the merge request to check.`,
    });
    if (!out.ok) expect(out.message).not.toMatch(/refused/i);
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
