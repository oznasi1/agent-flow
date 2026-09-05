import { describe, expect, it } from "vitest";
import { ghGateChannel, glabGateChannel, parseGhComments, parseGlabNotes } from "../../../../src/engine/forge/gateChannels";
import { resolveForge } from "../../../../src/engine/forge/registry";
import type { Runner } from "../../../../src/engine/pr/provider";

function runner(reply: (args: string[]) => string | Promise<string>) {
  const calls: { args: string[]; cwd: string }[] = [];
  const run: Runner = async (_file, args, opts) => { calls.push({ args, cwd: opts.cwd }); return reply(args); };
  return { run, calls };
}

describe("the forges' gate capability", () => {
  it("is declared by GitHub and GitLab with a channel, and stated absent by Bitbucket", () => {
    const gh = resolveForge("github", () => {}, runner(() => "").run);
    const gl = resolveForge("gitlab", () => {}, runner(() => "").run);
    const bb = resolveForge("bitbucket", () => {}, runner(() => "").run);
    expect(gh.caps.gateRouting).toBe(true);
    expect(gh.gates).toBeDefined();
    expect(gl.caps.gateRouting).toBe(true);
    expect(gl.gates).toBeDefined();
    expect(bb.caps.gateRouting).toBeFalsy();
    expect(bb.gates).toBeUndefined();
  });
});

describe("the GitHub channel", () => {
  it("posts through gh api with the cwd's own repo placeholders and returns the comment url", async () => {
    const { run, calls } = runner(() => JSON.stringify({ html_url: "https://github.com/o/r/pull/7#issuecomment-1" }));
    const res = await ghGateChannel(run).post("/r/aws-ops", 7, "@alice — question");
    expect(res).toEqual({ ok: true, url: "https://github.com/o/r/pull/7#issuecomment-1" });
    expect(calls[0].cwd).toBe("/r/aws-ops");
    expect(calls[0].args).toEqual(["api", "repos/{owner}/{repo}/issues/7/comments", "-f", "body=@alice — question"]);
  });

  it("reports a failed post with gh's stderr, never throws", async () => {
    const { run } = runner(() => { const e = new Error("Command failed: gh api"); (e as { stderr?: string }).stderr = "HTTP 403: Forbidden"; throw e; });
    expect(await ghGateChannel(run).post("/r", 1, "q")).toEqual({ ok: false, message: "HTTP 403: Forbidden" });
    const { run: bare } = runner(() => { throw new Error("Command failed: gh api"); });
    const res = await ghGateChannel(bare).post("/r", 1, "q");
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/could not post/);
  });

  it("reads issue comments since the ask, as gate replies, and null when the read fails", async () => {
    const { run, calls } = runner(() => JSON.stringify([
      { user: { login: "alice" }, body: "approve", created_at: "2026-09-06T10:00:00Z", html_url: "https://gh/c/9" },
      { user: { login: "bot[bot]" }, body: "🤖", created_at: "2026-09-06T10:01:00Z" },
      { body: "no author" },
    ]));
    const replies = await ghGateChannel(run).replies("/r", 7, Date.UTC(2026, 8, 6, 9, 0, 0));
    expect(calls[0].args[1]).toBe("repos/{owner}/{repo}/issues/7/comments?since=2026-09-06T09:00:00.000Z&per_page=100");
    expect(replies).toEqual([
      { login: "alice", body: "approve", at: Date.UTC(2026, 8, 6, 10, 0, 0), url: "https://gh/c/9" },
      { login: "bot[bot]", body: "🤖", at: Date.UTC(2026, 8, 6, 10, 1, 0) },
    ]);
    expect(await ghGateChannel(runner(() => { throw new Error("boom"); }).run).replies("/r", 7, 0)).toBeNull();
    expect(parseGhComments({ not: "an array" })).toEqual([]);
  });
});

describe("the GitLab channel", () => {
  it("posts a note through glab api on the cwd's project", async () => {
    const { run, calls } = runner(() => JSON.stringify({ id: 1 }));
    expect(await glabGateChannel(run).post("/r/aws-ops", 12, "q")).toEqual({ ok: true });
    expect(calls[0].cwd).toBe("/r/aws-ops");
    expect(calls[0].args).toEqual(["api", "projects/:id/merge_requests/12/notes", "--method", "POST", "-f", "body=q"]);
  });

  it("reads notes oldest-first, dropping system notes, and null when the read fails", async () => {
    const { run, calls } = runner(() => JSON.stringify([
      { author: { username: "alice" }, body: "approve", created_at: "2026-09-06T10:00:00Z", system: false },
      { author: { username: "alice" }, body: "approved this merge request", created_at: "2026-09-06T10:00:01Z", system: true },
    ]));
    const replies = await glabGateChannel(run).replies("/r", 12, 0);
    expect(calls[0].args[1]).toContain("projects/:id/merge_requests/12/notes?sort=asc");
    expect(replies).toEqual([{ login: "alice", body: "approve", at: Date.UTC(2026, 8, 6, 10, 0, 0) }]);
    expect(await glabGateChannel(runner(() => { throw new Error("boom"); }).run).replies("/r", 12, 0)).toBeNull();
    expect(parseGlabNotes(null)).toEqual([]);
  });

  it("reports a failed post honestly", async () => {
    const { run } = runner(() => { throw new Error("Command failed: glab api"); });
    const res = await glabGateChannel(run).post("/r", 1, "q");
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/could not post the note/);
  });
});
