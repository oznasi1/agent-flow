import { describe, it, expect } from "vitest";
import { GlabReviewProvider } from "../../../../../src/engine/review/glab/provider";
import { GLAB_FIELD_FLAG } from "../../../../../src/engine/pr/glab/provider";
import type { Runner } from "../../../../../src/engine/pr/provider";

const GLAB = "/opt/homebrew/bin/glab";
const provider = (run: Runner) => new GlabReviewProvider(run, () => GLAB);
const REPO = "group/sub/proj";
const ENC = "group%2Fsub%2Fproj"; // every project-scoped path must be url-encoded

// Route lookup is by insertion order, not by specificity: the discussions path
// ("…/merge_requests/12/discussions?…") also contains "merge_requests/12", so any
// test routing both must list the more specific fragment ("discussions",
// "pipelines/5/jobs") BEFORE the bare "merge_requests/12" key or it will match the
// wrong route.
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
      "pipelines/5/jobs": JSON.stringify([
        { name: "build", status: "success" },
        { name: "lint", status: "failed", web_url: "https://gl/j/lint" },
      ]),
      discussions: JSON.stringify([{ notes: [{ resolvable: true, resolved: false }] }]),
      "merge_requests/12": JSON.stringify({ head_pipeline: { id: 5 }, changes_count: "3" }),
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
      discussions: "[]",
      "merge_requests/12": JSON.stringify({ changes_count: "20+" }),
    });
    expect((await provider(run).detail(REPO, 12))?.size?.changedFiles).toBe(20);
  });

  it("returns null when the MR itself cannot be read", async () => {
    const { run } = routed({ "merge_requests/12": new Error("404") });
    expect(await provider(run).detail(REPO, 12)).toBeNull();
  });

  it("keeps the jobs it got when the discussions call fails", async () => {
    const { run } = routed({
      "pipelines/5/jobs": JSON.stringify([{ name: "lint", status: "failed", web_url: "u" }]),
      discussions: new Error("500"),
      "merge_requests/12": JSON.stringify({ head_pipeline: { id: 5 }, changes_count: "1" }),
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
      "pipelines/5/jobs": new Error("500"),
      discussions: "[]",
      "merge_requests/12": JSON.stringify({ head_pipeline: { id: 5 }, changes_count: "1" }),
    });
    expect(await provider(run).detail(REPO, 12)).toEqual({
      failing: [],
      unresolved: 0,
      size: { additions: 0, deletions: 0, changedFiles: 1 },
    });
  });

  it("reports no failing jobs when the MR has no pipeline", async () => {
    const { run } = routed({ discussions: "[]", "merge_requests/12": JSON.stringify({ changes_count: "2" }) });
    expect((await provider(run).detail(REPO, 12))?.failing).toEqual([]);
  });

  it("reports a null size when changes_count is missing or unparsable", async () => {
    const { run } = routed({ discussions: "[]", "merge_requests/12": JSON.stringify({ changes_count: "?" }) });
    expect((await provider(run).detail(REPO, 12))?.size).toBeNull();
  });
});

describe("GlabReviewProvider.submit", () => {
  const ok = { approve: "{}", unapprove: "{}", notes: "{}" };

  // Not just "submit passes whatever GLAB_FIELD_FLAG is" (that's tautological —
  // importing the same constant on both sides proves only that the code moved
  // together with the assertion). `-f` is `--raw-field` on `glab`; `-F` coerces
  // types and reads a leading `@` as a filename or `-` as stdin, so a review
  // body starting with `@` would become a local-file read posted to someone
  // else's MR. Pinning the literal is the only thing that would catch that flip.
  it("pins the field flag to the literal -f (--raw-field), not -F", () => {
    expect(GLAB_FIELD_FLAG).toBe("-f");
  });

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
    // Also pin the literal here, at the call site, independent of the constant.
    expect(note.args).toContain("-f");
    expect(note.args).not.toContain("-F");
  });

  // GitLab has no stable REST verb for this: the note carries the words and the
  // unapprove withdraws any standing approval.
  it("requests changes by posting a note, BEFORE unapproving", async () => {
    const { run, calls } = routed(ok);
    expect(await provider(run).submit(REPO, 12, "request-changes", "please fix")).toEqual({ ok: true });
    const paths = calls.map((c) => c.args.find((a) => a.includes("merge_requests/12")) ?? "");
    const noteAt = paths.findIndex((p) => p.endsWith("/notes"));
    const unapproveAt = paths.findIndex((p) => p.endsWith("/unapprove"));
    expect(noteAt).toBeGreaterThanOrEqual(0);
    expect(unapproveAt).toBeGreaterThanOrEqual(0);
    // A pure reordering (note moved after the state change, everything else
    // unchanged) would still make both calls and still return { ok: true } —
    // only an index comparison catches it.
    expect(noteAt).toBeLessThan(unapproveAt);
  });

  it("still succeeds when there was no approval to withdraw", async () => {
    const { run } = routed({ notes: "{}", unapprove: new Error("404 Not Found") });
    expect(await provider(run).submit(REPO, 12, "request-changes", "please fix")).toEqual({ ok: true });
  });

  it("surfaces a timeout from the unapprove step instead of swallowing it as \"nothing to withdraw\"", async () => {
    // The empty-catch around unapprove exists for the ordinary "no approval to
    // withdraw" error, not for a killed process — a killed `glab` may have
    // reached GitLab anyway, and reporting success here would tell the user
    // "changes requested" while a standing approval silently remains.
    const killed = Object.assign(new Error("Command failed: glab api ..."), { killed: true });
    const { run } = routed({ notes: "{}", unapprove: killed });
    const res = await provider(run).submit(REPO, 12, "request-changes", "please fix");
    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).toMatch(/may already have gone through/);
  });

  it("fails when the note itself cannot be posted", async () => {
    const { run } = routed({ notes: Object.assign(new Error("x"), { stderr: "403 Forbidden" }) });
    expect(await provider(run).submit(REPO, 12, "request-changes", "please fix"))
      .toEqual({ ok: false, message: "403 Forbidden" });
  });

  it("discloses that the note already landed when a later step fails", async () => {
    // The note is posted first (so the words survive a failed state change),
    // but that means a plain "403 Forbidden" reads as "nothing happened" to
    // a user whose comment is already public — and invites a retry that
    // posts it twice.
    const forbidden = Object.assign(new Error("Command failed: glab api ..."), { stderr: "403 Forbidden" });
    const { run } = routed({ notes: "{}", approve: forbidden });
    const res = await provider(run).submit(REPO, 12, "approve", "looks good");
    expect(res).toEqual({
      ok: false,
      message: "Your note was posted, but the review update failed: 403 Forbidden",
    });
  });

  it("does not prefix a disclosure when the note itself never landed", async () => {
    const { run } = routed({ notes: Object.assign(new Error("x"), { stderr: "500" }) });
    const res = await provider(run).submit(REPO, 12, "comment", "a note");
    expect(res).toEqual({ ok: false, message: "500" });
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

  it("does not stringify a non-string body into a postable value", async () => {
    // `String(body ?? "")` turns `{}` into the literal, truthy string
    // "[object Object]" — which would sail past the empty-body guard and be
    // posted verbatim. A `typeof` guard refuses it as empty instead.
    const { run, calls } = routed(ok);
    const res = await provider(run).submit(REPO, 12, "comment", {} as never);
    expect(res).toEqual({ ok: false, message: "GitLab requires a message for this kind of review." });
    expect(calls).toHaveLength(0);
  });

  it("says the write may have landed when the call is killed by the timeout", async () => {
    const killed = Object.assign(new Error("Command failed: glab api ... body=SECRET"), { killed: true });
    const { run } = routed({ notes: killed });
    const res = await provider(run).submit(REPO, 12, "comment", "SECRET");
    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).toMatch(/may already have gone through/);
    expect((res as { message: string }).message).not.toContain("SECRET");
  });

  // The last line of defense, and the one that actually matters: real review
  // bodies are multi-paragraph (the Deck feeds them from `.pick-task/REVIEW-<n>.md`
  // drafts), and execFile's `.message` is `Command failed: <file> <full argv
  // joined>` — the argv contains `-f body=<the whole multi-line body>`. Node then
  // appends `\n` + stderr's own text AFTER that. A fix that only strips
  // `.message`'s first line (rather than refusing `.message` outright) would
  // still leak every line of the body after the first — which a single-line
  // fixture like "body=SECRET" can never expose, since it has no second line to
  // leak. This fixture does.
  it("never returns any line of a multi-line review body, with or without stderr", async () => {
    const body = "But the SECRET_TOKEN handling on line 40 is wrong.\nPlease fix before merge.";
    for (const err of [
      new Error(`Command failed: glab api -f body=${body}`),
      Object.assign(new Error(`Command failed: glab api -f body=${body}`), { stderr: "  " }),
      Object.assign(new Error(`Command failed: glab api -f body=${body}\n409 Conflict`), {}),
    ]) {
      const { run } = routed({ notes: err });
      const res = await provider(run).submit(REPO, 12, "comment", body);
      const message = (res as { message: string }).message;
      for (const line of body.split("\n")) expect(message).not.toContain(line);
    }
  });
});
