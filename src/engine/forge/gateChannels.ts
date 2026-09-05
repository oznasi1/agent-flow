// The forge half of gate routing: post a gate question on a pull request, and
// read the replies. One implementation per CLI, sharing the shape in
// `Forge.gates`. Both use the CLI's `api` verb with the repo as the working
// directory, so the CLI resolves which project the PR belongs to — the same way
// `prs.fetch` already addresses it — and no repo path is ever parsed out of a URL
// here. `execFile` with an argv, never a shell: the body is user-authored text.
import type { GateChannel } from "./types";
import type { GateComment } from "../orchestrator/gateRouting";
import { GH_TIMEOUT_MS, execRunner } from "../pr/provider";
import type { Runner } from "../pr/provider";
import { GLAB_FIELD_FLAG, GLAB_TIMEOUT_MS } from "../pr/glab/provider";
import { resolveBin } from "../pr/which";

/** The cap on one read. A gate thread with more replies than this has stopped
 * being a gate thread, and the FIRST answer wins anyway. */
export const GATE_REPLIES_PAGE = 100;

const ms = (iso: unknown): number => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** GitHub issue comments — `GET /repos/{owner}/{repo}/issues/{n}/comments` — as
 * gate replies. Exported for the test: the shape is the API's, not ours. */
export function parseGhComments(raw: unknown): GateComment[] {
  if (!Array.isArray(raw)) return [];
  const out: GateComment[] = [];
  for (const c of raw as { user?: { login?: unknown }; body?: unknown; created_at?: unknown; html_url?: unknown }[]) {
    if (!c || typeof c !== "object" || typeof c.user?.login !== "string" || typeof c.body !== "string") continue;
    out.push({ login: c.user.login, body: c.body, at: ms(c.created_at), ...(typeof c.html_url === "string" ? { url: c.html_url } : {}) });
  }
  return out;
}

/** GitLab merge-request notes — `GET /projects/:id/merge_requests/:iid/notes` —
 * as gate replies. System notes (approvals, pushes, label changes) are not
 * replies and are dropped. */
export function parseGlabNotes(raw: unknown): GateComment[] {
  if (!Array.isArray(raw)) return [];
  const out: GateComment[] = [];
  for (const n of raw as { author?: { username?: unknown }; body?: unknown; created_at?: unknown; system?: unknown }[]) {
    if (!n || typeof n !== "object" || n.system === true || typeof n.author?.username !== "string" || typeof n.body !== "string") continue;
    out.push({ login: n.author.username, body: n.body, at: ms(n.created_at) });
  }
  return out;
}

const failure = (e: unknown, fallback: string): { ok: false; message: string } => {
  const stderr = (e as { stderr?: string }).stderr?.trim();
  if (stderr) return { ok: false, message: stderr };
  const m = e instanceof Error ? e.message : String(e);
  return { ok: false, message: m.startsWith("Command failed:") ? fallback : m };
};

export function ghGateChannel(run: Runner = execRunner): GateChannel {
  const gh = () => resolveBin("gh") ?? "gh";
  const exec = (repoPath: string, args: string[]) => run(gh(), args, { cwd: repoPath, timeoutMs: GH_TIMEOUT_MS });
  return {
    async post(repoPath, number, body) {
      try {
        // `{owner}/{repo}` are gh's own placeholders, filled from the cwd's remote.
        const out = await exec(repoPath, ["api", `repos/{owner}/{repo}/issues/${number}/comments`, "-f", `body=${body}`]);
        const parsed = JSON.parse(out) as { html_url?: unknown };
        return { ok: true, ...(typeof parsed.html_url === "string" ? { url: parsed.html_url } : {}) };
      } catch (e) {
        return failure(e, "gh could not post the comment — check the PR directly.");
      }
    },
    async replies(repoPath, number, sinceMs) {
      try {
        const since = new Date(Math.max(0, sinceMs)).toISOString();
        const out = await exec(repoPath, ["api", `repos/{owner}/{repo}/issues/${number}/comments?since=${since}&per_page=${GATE_REPLIES_PAGE}`]);
        return parseGhComments(JSON.parse(out) as unknown);
      } catch {
        return null;
      }
    },
  };
}

export function glabGateChannel(run: Runner = execRunner): GateChannel {
  const glab = () => resolveBin("glab") ?? "glab";
  const exec = (repoPath: string, args: string[]) => run(glab(), args, { cwd: repoPath, timeoutMs: GLAB_TIMEOUT_MS });
  return {
    async post(repoPath, number, body) {
      try {
        // `:id` is glab's placeholder for the cwd's project.
        await exec(repoPath, ["api", `projects/:id/merge_requests/${number}/notes`, "--method", "POST", GLAB_FIELD_FLAG, `body=${body}`]);
        // GitLab gives a note no browsable URL of its own; the MR is the place.
        return { ok: true };
      } catch (e) {
        return failure(e, "glab could not post the note — check the merge request directly.");
      }
    },
    async replies(repoPath, number, _sinceMs) {
      try {
        // No `since` filter on notes; the caller filters by time. Newest last.
        const out = await exec(repoPath, ["api", `projects/:id/merge_requests/${number}/notes?sort=asc&order_by=created_at&per_page=${GATE_REPLIES_PAGE}`]);
        return parseGlabNotes(JSON.parse(out) as unknown);
      } catch {
        return null;
      }
    },
  };
}
