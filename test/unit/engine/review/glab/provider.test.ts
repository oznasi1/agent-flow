import { describe, it, expect } from "vitest";
import { GlabReviewProvider } from "../../../../../src/engine/review/glab/provider";
import { GLAB_FIELD_FLAG } from "../../../../../src/engine/pr/glab/provider";
import type { Runner } from "../../../../../src/engine/pr/provider";

const GLAB = "/opt/homebrew/bin/glab";
const provider = (run: Runner) => new GlabReviewProvider(run, () => GLAB);
const REPO = "group/sub/proj";
const ENC = "group%2Fsub%2Fproj"; // every project-scoped path must be url-encoded

function routed(routes: Record<string, string | Error>): { run: Runner; calls: { args: string[]; cwd: string }[] } {
  const calls: { args: string[]; cwd: string }[] = [];
  const run: Runner = async (_file, args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    const hit = Object.entries(routes).find(([frag]) => args.some((a) => a.includes(frag)));
    if (!hit) throw new Error(`no route for ${args.join(" ")}`);
    if (hit[1] instanceof Error) throw hit[1];
    return hit[1];
  };
  return { run, calls };
}

const MR = {
  iid: 12, title: "T", web_url: "https://gitlab.com/group/sub/proj/-/merge_requests/12",
  draft: false, author: { username: "dana" }, references: { full: "group/sub/proj!12" },
  head_pipeline: { status: "success" }, detailed_merge_status: "mergeable",
};

describe("GlabReviewProvider.search", () => {
  it("makes one repo-independent call from the home directory", async () => {
    const { run, calls } = routed({ reviews_for_me: JSON.stringify([MR]) });
    const out = await provider(run).search();

    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe("api");
    // An MR wanting your review may live in a project you have never cloned, so
    // the cwd is only somewhere that exists for `glab` to run in.
    expect(calls[0].cwd).not.toBe("");
    expect(out?.requests[0].id).toBe("group/sub/proj#12");
  });

  it("returns null on failure — never an empty queue", async () => {
    const { run } = routed({ reviews_for_me: new Error("401") });
    expect(await provider(run).search()).toBeNull();
  });

  it("returns null on unparseable output", async () => {
    const { run } = routed({ reviews_for_me: "not json" });
    expect(await provider(run).search()).toBeNull();
  });

  it("returns an empty queue when nothing wants your review", async () => {
    const { run } = routed({ reviews_for_me: "[]" });
    expect(await provider(run).search()).toEqual({ issueCount: 0, requests: [] });
  });
});

describe("GlabReviewProvider.detail", () => {
  it("returns failing jobs, unresolved discussions, and the changed-file count", async () => {
    const { run, calls } = routed({
      [`merge_requests/12?`]: JSON.stringify({ head_pipeline: { id: 5 }, changes_count: "3" }),
      "pipelines/5/jobs": JSON.stringify([
        { name: "build", status: "success" },
        { name: "lint", status: "failed", web_url: "https://gl/j/lint" },
      ]),
      discussions: JSON.stringify([{ notes: [{ resolvable: true, resolved: false }] }]),
    });

    expect(await provider(run).detail(REPO, 12)).toEqual({
      failing: [{ name: "lint", url: "https://gl/j/lint" }],
      unresolved: 1,
      size: { additions: 0, deletions: 0, changedFiles: 3 },
    });
    expect(calls.every((c) => !c.args[1].includes("/-/"))).toBe(true);
    expect(calls[0].args[1]).toContain(`projects/${ENC}/merge_requests/12`);
  });

  it('parses a capped changes_count like "20+" as its numeric prefix', async () => {
    const { run } = routed({
      [`merge_requests/12?`]: JSON.stringify({ changes_count: "20+" }),
      discussions: "[]",
    });
    expect((await provider(run).detail(REPO, 12))?.size?.changedFiles).toBe(20);
  });

  it("returns null when the MR itself cannot be read", async () => {
    const { run } = routed({ [`merge_requests/12?`]: new Error("404") });
    expect(await provider(run).detail(REPO, 12)).toBeNull();
  });

  it("keeps the jobs it got when the discussions call fails", async () => {
    const { run } = routed({
      [`merge_requests/12?`]: JSON.stringify({ head_pipeline: { id: 5 }, changes_count: "1" }),
      "pipelines/5/jobs": JSON.stringify([{ name: "lint", status: "failed", web_url: "u" }]),
      discussions: new Error("500"),
    });
    expect(await provider(run).detail(REPO, 12)).toEqual({
      failing: [{ name: "lint", url: "u" }],
      unresolved: null,
      size: { additions: 0, deletions: 0, changedFiles: 1 },
    });
  });

  it("keeps the MR and unresolved count when the jobs call fails", async () => {
    // Symmetric with "keeps the jobs it got when the discussions call fails":
    // a failed jobs fetch must degrade `failing` to [] rather than let the
    // rejection escape `detail` and discard the discussions count too.
    const { run } = routed({
      [`merge_requests/12?`]: JSON.stringify({ head_pipeline: { id: 5 }, changes_count: "1" }),
      "pipelines/5/jobs": new Error("500"),
      discussions: "[]",
    });
    expect(await provider(run).detail(REPO, 12)).toEqual({
      failing: [],
      unresolved: 0,
      size: { additions: 0, deletions: 0, changedFiles: 1 },
    });
  });

  it("reports no failing jobs when the MR has no pipeline", async () => {
    const { run } = routed({ [`merge_requests/12?`]: JSON.stringify({ changes_count: "2" }), discussions: "[]" });
    expect((await provider(run).detail(REPO, 12))?.failing).toEqual([]);
  });

  it("reports a null size when changes_count is missing or unparsable", async () => {
    const { run } = routed({ [`merge_requests/12?`]: JSON.stringify({ changes_count: "?" }), discussions: "[]" });
    expect((await provider(run).detail(REPO, 12))?.size).toBeNull();
  });
});

describe("GlabReviewProvider.submit", () => {
  const ok = { approve: "{}", unapprove: "{}", notes: "{}" };

  it("approves with a POST to the approve endpoint", async () => {
    const { run, calls } = routed(ok);
    expect(await provider(run).submit(REPO, 12, "approve", "")).toEqual({ ok: true });
    expect(calls[0].args).toContain("--method");
    expect(calls[0].args).toContain("POST");
    expect(calls[0].args.some((a) => a.includes(`projects/${ENC}/merge_requests/12/approve`))).toBe(true);
  });

  it("posts an approval body as a note as well, so the words are not lost", async () => {
    const { run, calls } = routed(ok);
    await provider(run).submit(REPO, 12, "approve", "looks good");
    expect(calls.some((c) => c.args.some((a) => a.includes("/notes")))).toBe(true);
    expect(calls.some((c) => c.args.includes("body=looks good"))).toBe(true);
  });

  it("sends a comment as a note, through the raw-string field flag", async () => {
    const { run, calls } = routed(ok);
    expect(await provider(run).submit(REPO, 12, "comment", "a note")).toEqual({ ok: true });
    const note = calls.find((c) => c.args.some((a) => a.includes("/notes")))!;
    expect(note.args).toContain(GLAB_FIELD_FLAG);
    expect(note.args).toContain("body=a note");
  });

  // GitLab has no stable REST verb for this: the note carries the words and the
  // unapprove withdraws any standing approval.
  it("requests changes by posting a note and then unapproving", async () => {
    const { run, calls } = routed(ok);
    expect(await provider(run).submit(REPO, 12, "request-changes", "please fix")).toEqual({ ok: true });
    const paths = calls.map((c) => c.args.find((a) => a.includes("merge_requests/12")) ?? "");
    expect(paths.some((p) => p.endsWith("/notes"))).toBe(true);
    expect(paths.some((p) => p.endsWith("/unapprove"))).toBe(true);
  });

  it("still succeeds when there was no approval to withdraw", async () => {
    const { run } = routed({ notes: "{}", unapprove: new Error("404 Not Found") });
    expect(await provider(run).submit(REPO, 12, "request-changes", "please fix")).toEqual({ ok: true });
  });

  it("fails when the note itself cannot be posted", async () => {
    const { run } = routed({ notes: Object.assign(new Error("x"), { stderr: "403 Forbidden" }) });
    expect(await provider(run).submit(REPO, 12, "request-changes", "please fix"))
      .toEqual({ ok: false, message: "403 Forbidden" });
  });

  it("refuses a verb outside the union before building any argv", async () => {
    const { run, calls } = routed(ok);
    const res = await provider(run).submit(REPO, 12, "constructor" as never, "x");
    expect(res).toEqual({ ok: false, message: "Unknown review verb: constructor" });
    expect(calls).toHaveLength(0);
  });

  it.each(["comment", "request-changes"] as const)("refuses %s with an empty body", async (verb) => {
    const { run, calls } = routed(ok);
    const res = await provider(run).submit(REPO, 12, verb, "   ");
    expect(res).toEqual({ ok: false, message: "GitLab requires a message for this kind of review." });
    expect(calls).toHaveLength(0);
  });

  it("survives a body that is not a string at runtime", async () => {
    const { run } = routed(ok);
    expect(await provider(run).submit(REPO, 12, "approve", undefined as never)).toEqual({ ok: true });
  });

  it("says the write may have landed when the call is killed by the timeout", async () => {
    const killed = Object.assign(new Error("Command failed: glab api ... body=SECRET"), { killed: true });
    const { run } = routed({ notes: killed });
    const res = await provider(run).submit(REPO, 12, "comment", "SECRET");
    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).toMatch(/may already have gone through/);
    expect((res as { message: string }).message).not.toContain("SECRET");
  });

  // The last line of defense: execFile's `.message` is `Command failed: <file>
  // <argv joined>`, which embeds the whole body.
  it("never returns the review body, with or without stderr", async () => {
    for (const err of [
      new Error("Command failed: glab api ... body=SECRET"),
      Object.assign(new Error("Command failed: glab api ... body=SECRET"), { stderr: "  " }),
      Object.assign(new Error("Command failed: glab api ... body=SECRET\n409 Conflict"), {}),
    ]) {
      const { run } = routed({ notes: err });
      const res = await provider(run).submit(REPO, 12, "comment", "SECRET");
      expect((res as { message: string }).message).not.toContain("SECRET");
    }
  });
});
